/**
 * Standing write permission for an unattended routine (owner decision 2026-11-13), through the real Pi engine and the
 * real Core API. The permission is per routine, frozen (folder, instruction, model, operations, limits), enforced in the
 * tool layer, revocable and audited; everything not granted keeps asking.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { createScheduledTask, cancelScheduledTask } from '../domain/scheduledTasks';
import { createGrant, revokeGrant, verifyGrantRun } from '../domain/routineWriteGrants';
import { startApiServer, type RunningApiServer } from '../api/server';
import { generateToken } from '../auth/token';

interface ModelCall { messages: Array<{ role: string; content: unknown }>; tools: string[] }
type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };

let server: http.Server; let previousUrl: string | undefined; let PiAgentEngineCtor: any;
let script: (toolResults: number) => Reply;
const frame = (res: http.ServerResponse, message: Record<string, unknown>, done: boolean) =>
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body); const messages = payload.messages as ModelCall['messages'];
        const toolResults = messages.filter((m) => m.role === 'tool').length;
        let reply: Reply; try { reply = script(toolResults); } catch (err) { reply = { text: `script error ${String(err)}` }; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (reply.tool) frame(res, { tool_calls: [{ function: { name: reply.tool.name, arguments: reply.tool.args } }] }, false); else frame(res, { content: reply.text ?? '' }, false);
        frame(res, {}, true); res.end(); return;
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});
afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('standing write permission for a scheduled routine', () => {
  let tempDir: string; let ws: string; let db: CoreDatabase; let decider: NodeJS.Timeout; let approvalsAsked = 0; let taskId: string;
  const INSTRUCTION = 'Write the text "daily ok" to reports/daily.txt.';
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-rgrant-')); ws = path.join(tempDir, 'ws'); fs.mkdirSync(ws, { recursive: true });
    db = openDatabase(path.join(tempDir, 'core.db')); runMigrations(db); approvalsAsked = 0;
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        approvalsAsked += 1;
        try { resolveApproval(db, a.id, { resolution: 'rejected', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch { /* decided */ }
      }
    }, 50);
    taskId = createScheduledTask(db, { title: 'Daily report', instruction: INSTRUCTION, dailyTime: '09:00', timezone: 'UTC', model: 'fake-model', scope: { workspaceRoot: ws, workspaceAccess: 'read_write' } }).id;
  });
  afterEach(() => { clearInterval(decider); try { db.close(); } catch { /* closed */ } try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  /** One scheduler-origin run, as the scheduler submits it; `writes` are the files the scripted model tries to write, in order. */
  async function routineRun(writes: Array<{ file: string; content: string }>, origin = 'core:scheduler') {
    let i = 0;
    script = (toolResults) => (toolResults < writes.length ? { tool: { name: 'write_file', args: { filePath: writes[toolResults].file, content: writes[toolResults].content } } } : { text: `done ${i++}` });
    const text = `[Scheduled task "Daily report"] ${INSTRUCTION}`;
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'routine' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: origin, conversationId: conv.id, currentMessage: text, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt',
      toolPermissionPolicy: { profile: 'local-core-question', worker: 'local-core', workspaceAccess: 'read_write' },
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `sched:${taskId}:${Date.now()}${Math.floor(Math.random() * 1000)}` } as any);
    const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: `client:${origin}` });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: ws } as any);
    return att;
  }
  const events = (attemptId: string) => db.all<{ eventType: string; metadata: string }>('SELECT eventType, metadata FROM runtime_events WHERE entityId = ?', [attemptId]);
  const daily = () => path.join(ws, 'reports', 'daily.txt');

  it('without a grant the write waits for the owner (and is not written when declined)', async () => {
    await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }]);
    expect(approvalsAsked).toBeGreaterThan(0);
    expect(fs.existsSync(daily())).toBe(false);
  }, 60_000);

  it('with a grant the write needs no card, is read back, audited, and verified at the end of the run', async () => {
    const grant = createGrant(db, { taskId, grantedBy: 'host:test' });
    const att = await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }]);
    expect(approvalsAsked).toBe(0);
    expect(fs.readFileSync(daily(), 'utf8')).toBe('daily ok');
    const mission = db.get<{ authorizedBy: string }>('SELECT authorizedBy FROM mission_authorizations WHERE attemptId = ?', [att.id]);
    expect(mission?.authorizedBy).toBe(`standing_grant:${grant.id}`);
    const authorized = events(att.id).find((e) => e.eventType === 'file_write_authorized');
    expect(JSON.parse(authorized!.metadata).standingGrantId).toBe(grant.id);
    const use = db.get<{ readbackMatched: number; path: string }>('SELECT readbackMatched, path FROM routine_write_grant_uses WHERE attemptId = ?', [att.id]);
    expect(use?.readbackMatched).toBe(1);
    expect(verifyGrantRun(db, att.id)).toMatchObject({ uses: 1, matched: 1, problems: [] });
    // tampering after the write is caught by the independent check, not by the model's report
    fs.writeFileSync(daily(), 'changed by someone else');
    expect(verifyGrantRun(db, att.id).problems.length).toBe(1);
  }, 60_000);

  it('a grant does not apply to a request that did not come from the scheduler', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test' });
    await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }], 'desktop');
    expect(approvalsAsked).toBeGreaterThan(0);
    expect(fs.existsSync(daily())).toBe(false);
  }, 60_000);

  it('a material change to the routine (its instruction) ends the grant until it is approved again', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test' });
    db.run('UPDATE scheduled_tasks SET instruction = ? WHERE id = ?', [`${INSTRUCTION} Also delete everything else.`, taskId]);
    const att = await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }]);
    expect(approvalsAsked).toBeGreaterThan(0);
    expect(fs.existsSync(daily())).toBe(false);
    expect(events(att.id).some((e) => e.eventType === 'standing_grant_not_applied')).toBe(true);
  }, 60_000);

  it('a different folder or model invalidates the grant too', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test' });
    const other = path.join(tempDir, 'other'); fs.mkdirSync(other);
    db.run('UPDATE scheduled_tasks SET scopeJson = ? WHERE id = ?', [JSON.stringify({ workspaceRoot: other, workspaceAccess: 'read_write' }), taskId]);
    await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }]);
    expect(approvalsAsked).toBeGreaterThan(0);
    expect(fs.existsSync(daily())).toBe(false);
  }, 60_000);

  it('a revoked or cancelled routine asks again', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test' });
    expect(revokeGrant(db, taskId, 'host:test', 'owner revoked')).toBe(1);
    await routineRun([{ file: 'reports/daily.txt', content: 'daily ok' }]);
    expect(approvalsAsked).toBeGreaterThan(0);
    expect(fs.existsSync(daily())).toBe(false);
    createGrant(db, { taskId, grantedBy: 'host:test' });
    cancelScheduledTask(db, taskId);
    expect(db.get<{ status: string }>("SELECT status FROM routine_write_grants WHERE taskId = ? ORDER BY grantedAt DESC LIMIT 1", [taskId])?.status).toBe('revoked');
  }, 60_000);

  it('the grant never covers secrets, protected folders, paths outside the folder or a link out of it', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test' });
    const outside = path.join(tempDir, 'outside'); fs.mkdirSync(outside);
    let linked = true;
    try { fs.symlinkSync(outside, path.join(ws, 'link'), 'junction'); } catch { linked = false; }
    await routineRun([
      { file: '.env', content: 'KEY=1' },
      { file: '.git/config', content: 'x' },
      { file: '../escaped.txt', content: 'x' },
      ...(linked ? [{ file: 'link/pwned.txt', content: 'x' }] : []),
      { file: 'notes.bin.png', content: 'x' },
    ]);
    expect(fs.existsSync(path.join(ws, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(ws, '.git', 'config'))).toBe(false);
    expect(fs.existsSync(path.join(tempDir, 'escaped.txt'))).toBe(false);
    expect(fs.existsSync(path.join(outside, 'pwned.txt'))).toBe(false);
    expect(fs.existsSync(path.join(ws, 'notes.bin.png'))).toBe(false);
    expect(db.get<{ n: number }>('SELECT COUNT(*) n FROM routine_write_grant_uses')?.n).toBe(0);
  }, 90_000);

  it('limits are frozen: a write past the file-count limit goes back to the owner', async () => {
    createGrant(db, { taskId, grantedBy: 'host:test', limits: { maxFiles: 1 } });
    await routineRun([{ file: 'reports/a.txt', content: 'a' }, { file: 'reports/b.txt', content: 'b' }]);
    expect(fs.readFileSync(path.join(ws, 'reports', 'a.txt'), 'utf8')).toBe('a');
    expect(fs.existsSync(path.join(ws, 'reports', 'b.txt'))).toBe(false);
    expect(approvalsAsked).toBeGreaterThan(0);
  }, 60_000);

  it('only write_file can be granted, and only for a routine with a writable folder', () => {
    expect(() => createGrant(db, { taskId, operations: ['write_file', 'run_command'], grantedBy: 'host:test' })).toThrow(/only these operations/);
    expect(() => createGrant(db, { taskId, operations: ['delete_file'], grantedBy: 'host:test' })).toThrow();
    expect(() => createGrant(db, { taskId, limits: { maxFiles: 9999 }, grantedBy: 'host:test' })).toThrow(/maxFiles/);
    const ro = createScheduledTask(db, { title: 'ro', instruction: 'x', dailyTime: '09:00', timezone: 'UTC', model: 'm', scope: { workspaceRoot: ws, workspaceAccess: 'read' } }).id;
    expect(() => createGrant(db, { taskId: ro, grantedBy: 'host:test' })).toThrow(/write access/);
    const none = createScheduledTask(db, { title: 'nofolder', instruction: 'x', dailyTime: '09:00', timezone: 'UTC', model: 'm' }).id;
    expect(() => createGrant(db, { taskId: none, grantedBy: 'host:test' })).toThrow(/no folder/);
  });
});

describe('standing write permission API', () => {
  const TOKEN = generateToken(); const HOST = generateToken();
  let dir: string; let db: CoreDatabase; let api: RunningApiServer; let taskId: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-rgrant-api-')); fs.mkdirSync(path.join(dir, 'f'));
    const { openCoreDatabase } = await import('../db/openCore');
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    api = await startApiServer({ db, token: TOKEN, hostToken: HOST, broadcaster: new EventBroadcaster(), dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }), onShutdown: () => {} });
    taskId = createScheduledTask(db, { title: 'r', instruction: 'x', dailyTime: '09:00', timezone: 'UTC', model: 'm', scope: { workspaceRoot: path.join(dir, 'f'), workspaceAccess: 'read_write' } }).id;
  });
  afterEach(async () => { await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = (method: string, body: unknown, who: 'host' | 'client', extra: Record<string, string> = {}) => fetch(`http://127.0.0.1:${api.port}/v1/scheduled-tasks/${taskId}/write-grant`, {
    method, body: body === undefined ? undefined : JSON.stringify(body),
    headers: { Authorization: `Bearer ${TOKEN}`, ...(who === 'host' ? { 'X-Host-Token': HOST } : {}), 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', 'Idempotency-Key': `k-${Math.random()}`, ...extra },
  });

  it('only the Pandesh app can grant or revoke; a model or an ordinary client cannot, and the owner must confirm', async () => {
    expect((await call('POST', { confirm: true }, 'client')).status).toBe(403);
    expect((await call('POST', { confirm: true }, 'client', { 'X-Caller-Type': 'model' })).status).toBe(403);
    expect((await call('DELETE', undefined, 'client')).status).toBe(403);
    expect((await call('POST', {}, 'host')).status).toBe(400);
    const made = await call('POST', { confirm: true, limits: { maxFiles: 3 } }, 'host');
    expect(made.status).toBe(200);
    const state = await (await call('GET', undefined, 'host')).json() as any;
    expect(state.active.frozen.limits.maxFiles).toBe(3);
    expect(state.applies).toBe(true);
    expect((await call('GET', undefined, 'client')).status).toBe(403);
    expect(((await (await call('DELETE', undefined, 'host')).json()) as any).revoked).toBe(1);
    expect(((await (await call('GET', undefined, 'host')).json()) as any).active).toBeNull();
  });
});
