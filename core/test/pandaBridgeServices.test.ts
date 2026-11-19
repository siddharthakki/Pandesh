import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createPairingCode, getBridgeTask, redeemPairingCode, submitBridgeTask } from '../domain/pandaBridge';
import { cancelBridgeTask, discoverExecutors, dispatchBridgeTask, type BridgeRuntime } from '../runtime/kandev/pandaBridge';
import { defaultServiceRegistry, ServiceRegistry } from '../runtime/kandev/bridgeServices';
import type { KandevClient } from '../runtime/kandev/kandevClient';

let dir: string; let data: string; let db: CoreDatabase; let rt: BridgeRuntime;
const kandev = { healthy: async () => false, tool: async () => ({ agents: [] }) } as unknown as KandevClient;
const wait = async (id: string, pred: (s: string) => boolean) => {
  for (let i = 0; i < 100; i++) { if (pred(getBridgeTask(db, id).status)) return; await new Promise(r => setTimeout(r, 20)); }
  throw new Error('timeout, status ' + getBridgeTask(db, id).status);
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-svc-'));
  data = path.join(dir, 'data'); fs.mkdirSync(data);
  fs.mkdirSync(path.join(dir, 'allowed')); fs.writeFileSync(path.join(dir, 'allowed', 'a.txt'), 'hello');
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'nope');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  rt = { db, kandev, dataDir: data, services: defaultServiceRegistry([path.join(dir, 'allowed')]) };
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function submit(instruction: string, n = 1) {
  const { code } = createPairingCode(db);
  const { pairing } = redeemPairingCode(db, { code, label: 'Chrome' });
  return submitBridgeTask(db, pairing, { clientRequestId: `req-000000${n}`, instruction }).task;
}
const req = (executor: string) => ({ executor, decidedBy: 'test', authority: 'host' as const });

describe('bridge service executors', () => {
  it('lists registered services next to agents', async () => {
    const l = await discoverExecutors(kandev, { services: rt.services! });
    expect(l.executors.filter(e => e.kind === 'service').map(e => e.id)).toEqual(['service:fs.inspect', 'service:workflow.verify-hash']);
  });

  it('runs a read-only filesystem service with a verifiable receipt and no model', async () => {
    const t = submit(JSON.stringify({ path: path.join(dir, 'allowed', 'a.txt') }));
    const r = await dispatchBridgeTask(rt, t.id, req('service:fs.inspect'));
    expect(r.started).toBe(true);
    await wait(t.id, s => s === 'completed');
    const done = getBridgeTask(db, t.id);
    expect(done.executor).toBe('service:fs.inspect');
    expect(done.result?.verification).toBe('independent');
    expect(done.result?.evidence).toContain(crypto.createHash('sha256').update('hello').digest('hex'));
  });

  it('runs a deterministic workflow: match completes, mismatch fails with evidence', async () => {
    const p = path.join(dir, 'allowed', 'a.txt');
    const good = submit(JSON.stringify({ path: p, sha256: crypto.createHash('sha256').update('hello').digest('hex') }), 2);
    await dispatchBridgeTask(rt, good.id, req('service:workflow.verify-hash'));
    await wait(good.id, s => s === 'completed');
    const bad = submit(JSON.stringify({ path: p, sha256: 'a'.repeat(64) }), 3);
    await dispatchBridgeTask(rt, bad.id, req('service:workflow.verify-hash'));
    await wait(bad.id, s => s === 'failed');
    expect(getBridgeTask(db, bad.id).statusDetail).toContain('hash mismatch');
  });

  it('refuses paths outside the registered roots', async () => {
    const t = submit(JSON.stringify({ path: path.join(dir, 'secret.txt') }));
    await dispatchBridgeTask(rt, t.id, req('service:fs.inspect'));
    await wait(t.id, s => s === 'failed');
    expect(getBridgeTask(db, t.id).statusDetail).toContain('outside the roots');
  });

  it('duplicate dispatch starts once; unknown service is rejected', async () => {
    const t = submit(JSON.stringify({ path: path.join(dir, 'allowed') }));
    const both = await Promise.allSettled([dispatchBridgeTask(rt, t.id, req('service:fs.inspect')), dispatchBridgeTask(rt, t.id, req('service:fs.inspect'))]);
    const started = both.filter(r => r.status === 'fulfilled' && r.value.started).length;
    expect(started).toBe(1);
    const u = submit('x', 4);
    await expect(dispatchBridgeTask(rt, u.id, req('service:nope'))).rejects.toThrow(/unknown executor/);
  });

  it('cancels a running service through the bridge cancel path', async () => {
    const slow = new ServiceRegistry().register({
      id: 'slow', label: 'Slow', readOnly: true, roots: [],
      run: ({ signal }) => new Promise((_, rej) => { signal.addEventListener('abort', () => rej(new Error('cancelled'))); }),
    });
    const t = submit('x', 5);
    await dispatchBridgeTask({ ...rt, services: slow }, t.id, req('service:slow'));
    expect(getBridgeTask(db, t.id).status).toBe('running');
    await cancelBridgeTask({ ...rt, services: slow }, t.id, 'test');
    await new Promise(r => setTimeout(r, 50));
    expect(getBridgeTask(db, t.id).status).toBe('cancelled');
  });
});

describe('stale failed capability probe', () => {
  it('re-probes a failed agent and trusts the fresh result', async () => {
    let probed = 0;
    const k = {
      healthy: async () => true,
      tool: async () => ({ agents: [{ id: 'a', name: 'opencode-acp', capability_status: 'failed', capability_error: 'peer disconnected', profiles: [] }] }),
      reprobeAgent: async () => { probed++; return { status: 'ok' }; },
    } as unknown as KandevClient;
    const l = await discoverExecutors(k, {});
    const oc = l.executors.find(e => e.id === 'opencode')!;
    expect(probed).toBe(1);
    expect(oc.reason === null || !/failed/.test(oc.reason)).toBe(true);
  });
});
