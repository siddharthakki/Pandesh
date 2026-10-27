import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { createPairingCode } from '../domain/pandaBridge';

const HOST_JS = path.resolve(__dirname, '..', '..', 'apps', 'panda-bridge', 'native-host', 'panda-native-host.mjs');
const TOKEN = generateToken();

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-host-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startApiServer({
    db, token: TOKEN, hostToken: generateToken(), operatorToken: generateToken(), broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0', apiVersion: 1, instanceId: 't', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
  });
  fs.writeFileSync(path.join(dir, 'core.json'), JSON.stringify({ port: api.port }));
  fs.writeFileSync(path.join(dir, 'core.token'), TOKEN);
  fs.writeFileSync(path.join(dir, 'host-config.json'), JSON.stringify({ dataDir: dir }));
});
afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Speaks Chrome's native-messaging framing (4-byte little-endian length + JSON) to a real host process. */
function exchange(messages: object[], config = path.join(dir, 'host-config.json')): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOST_JS], { env: { ...process.env, PANDA_BRIDGE_CONFIG: config }, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = Buffer.alloc(0);
    const replies: any[] = [];
    child.stdout.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
        const len = buf.readUInt32LE(0);
        replies.push(JSON.parse(buf.subarray(4, 4 + len).toString('utf8')));
        buf = buf.subarray(4 + len);
      }
      if (replies.length === messages.length) child.stdin.end();
    });
    child.on('error', reject);
    child.on('close', () => resolve(replies));
    // all frames written back to back: the host must split them correctly
    child.stdin.write(Buffer.concat(messages.map((m) => {
      const body = Buffer.from(JSON.stringify(m));
      const h = Buffer.alloc(4);
      h.writeUInt32LE(body.length);
      return Buffer.concat([h, body]);
    })));
  });
}

describe('native messaging host', () => {
  it('pairs, relays a task once, and never reveals Core credentials', async () => {
    const { code } = createPairingCode(db);
    const [paired] = await exchange([{ id: 'a', op: 'pair', code, label: 'Chrome', extensionId: 'x' }]);
    expect(paired).toMatchObject({ id: 'a', ok: true, status: 201 });
    const token = paired.data.token as string;

    const body = { op: 'submit', token, clientRequestId: 'click-host-0001', instruction: 'Build a simple calculator app' };
    const replies = await exchange([{ id: '1', ...body }, { id: '2', ...body }, { id: '3', op: 'tasks', token }]);
    expect(replies.map((r) => r.id)).toEqual(['1', '2', '3']);
    expect(replies[0].data.duplicate).toBe(false);
    expect(replies[1].data.duplicate).toBe(true);
    expect(replies[1].data.taskId).toBe(replies[0].data.taskId);
    expect(replies[2].data.tasks).toHaveLength(1);
    expect(JSON.stringify(replies)).not.toContain(TOKEN);
  });

  it('refuses unknown operations, malformed ids, bad tokens, and cannot pass consent', async () => {
    const replies = await exchange([
      { id: '1', op: 'getCoreToken' },
      { id: '2', op: 'task', token: 'x', taskId: '../../v1/shutdown' },
      { id: '3', op: 'tasks', token: 'not-a-pairing' },
      { id: '4', op: 'pair', code: 'WRONGCODE' },
    ]);
    expect(replies[0]).toMatchObject({ ok: false, code: 'unknown_operation' });
    expect(replies[1]).toMatchObject({ ok: false, code: 'invalid_request' });
    expect(replies[2]).toMatchObject({ ok: false, status: 401 });
    expect(replies[3]).toMatchObject({ ok: false, status: 401 });
  });

  it('forwards only executor and model on dispatch, so a browser cannot smuggle consent', async () => {
    const { code } = createPairingCode(db);
    const [paired] = await exchange([{ id: 'p', op: 'pair', code }]);
    const token = paired.data.token as string;
    const [submitted] = await exchange([{ id: 's', op: 'submit', token, clientRequestId: 'click-host-0002', instruction: 'Build a thing' }]);
    const [res] = await exchange([{ id: 'd', op: 'dispatch', token, taskId: submitted.data.taskId, executor: 'claude', consent: { externalTransfer: true, confidentialOverride: true } }]);
    expect(res).toMatchObject({ ok: false, status: 403, reason: 'external_consent_required' });
  });

  it('answers “Pandesh is not running” instead of failing when Core is unreachable', async () => {
    fs.rmSync(path.join(dir, 'core.json'));
    const [res] = await exchange([{ id: 'x', op: 'tasks', token: 'whatever' }]);
    expect(res).toMatchObject({ ok: false, code: 'core_unavailable' });
  });

  it('reports a clear error when the host is not configured', async () => {
    const [res] = await exchange([{ id: 'x', op: 'hello' }], path.join(dir, 'missing.json'));
    expect(res).toMatchObject({ ok: false, code: 'host_misconfigured' });
  });
});
