import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { steerPiAttempt } from '../runtime/piAgentEngine';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let base: string;
let n = 0;

const call = (route: string, body?: unknown) => fetch(`${base}${route}`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test', 'Idempotency-Key': `steer-${++n}` },
  body: JSON.stringify(body ?? {}),
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-steer-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  api = await startApiServer({
    db, token: TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 't', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
  });
  base = `http://127.0.0.1:${api.port}`;
});
afterEach(async () => { await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('steering a task that is working', () => {
  it('is refused honestly when no live run holds the attempt, and nothing is added to the conversation', async () => {
    const conversation = await (await call('/v1/conversations', { mode: 'baat_kar' })).json() as { id: string };
    const submission = await (await call('/v1/submit', { currentMessage: 'Do a long thing', requestedMode: 'baat_kar', conversationId: conversation.id, requestedProvider: 'ollama', requestedModel: 'qwen2.5-coder:1.5b' })).json() as { attempt: { id: string } };
    const res = await call(`/v1/attempts/${submission.attempt.id}/steer`, { text: 'Also add a title' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: false, reason: expect.stringMatching(/not running on the live agent/) });
    const messages = db.all<{ role: string }>('SELECT role FROM conversation_messages WHERE conversationId = ?', [conversation.id]);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(1); // only the original request
  });

  it('requires text', async () => {
    const res = await call('/v1/attempts/att_missing/steer', { text: '   ' });
    expect(res.status).toBe(400);
  });

  it('the registry never accepts an empty instruction or an unknown attempt', () => {
    expect(steerPiAttempt('att_none', 'hello').accepted).toBe(false);
    expect(steerPiAttempt('att_none', '   ').reason).toMatch(/nothing to add/);
  });
});
