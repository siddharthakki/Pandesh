import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let wsUrl: string;

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string; clientId?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': init.clientId ?? 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let idempotencyCounter = 0;
function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-runtime-${idempotencyCounter}`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-runtime-api-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({
      coreVersion: '0.1.0',
      apiVersion: 1,
      instanceId: 'test-instance',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      electronVersion: null,
      dataDir: dir,
    }),
    onShutdown: () => {},
  });
  ws = attachWsServer({
    httpServer: api.server,
    token: TOKEN,
    broadcaster,
    instanceId: 'test-instance',
    latestSequence: () => latestSequence(db),
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
  wsUrl = `ws://127.0.0.1:${api.port}/v1/ws`;
});

afterEach(async () => {
  ws.close();
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function createConversation(mode: 'baat_kar' | 'saath_kar' = 'baat_kar') {
  const res = await authedFetch('/v1/conversations', {
    method: 'POST',
    idempotencyKey: nextIdemp(),
    body: JSON.stringify({ mode }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

describe('M32 runtime API: end-to-end over real HTTP', () => {
  it('classifies a request, creates an envelope, creates an attempt, and completes it', async () => {
    const classifyRes = await authedFetch('/v1/routing/classify', {
      method: 'POST',
      body: JSON.stringify({ currentMessage: 'What is the capital of France?' }),
    });
    expect(classifyRes.status).toBe(200);
    const decision = await classifyRes.json();
    expect(decision.resolvedMode).toBe('baat_kar');
    expect(decision.contextPolicy).toBeDefined();

    const conv = await createConversation('baat_kar');

    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'What is the capital of France?',
        requestedMode: 'auto',
        resolvedMode: decision.resolvedMode,
        routeReason: decision.routeReason,
        conversationId: conv.id,
        contextPolicy: decision.contextPolicy,
      }),
    });
    expect(reqRes.status).toBe(201);
    const requestEnvelope = await reqRes.json();

    const attemptRes = await authedFetch('/v1/attempts', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ requestId: requestEnvelope.id, kind: 'baat_kar' }),
    });
    expect(attemptRes.status).toBe(201);
    const attempt = await attemptRes.json();
    expect(attempt.status).toBe('created');

    const runningRes = await authedFetch(`/v1/attempts/${attempt.id}/transition`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ toStatus: 'running' }),
    });
    expect(runningRes.status).toBe(200);

    const completedRes = await authedFetch(`/v1/attempts/${attempt.id}/transition`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ toStatus: 'completed' }),
    });
    expect(completedRes.status).toBe(200);
    const completed = await completedRes.json();
    expect(completed.status).toBe('completed');
  });

  it('POST /v1/submit atomically classifies, creates the request, and creates the attempt in one call', async () => {
    const conv = await createConversation('baat_kar');
    const submitRes = await authedFetch('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'What is the capital of France?',
        requestedMode: 'auto',
        conversationId: conv.id,
      }),
    });
    expect(submitRes.status).toBe(201);
    const result = await submitRes.json();
    expect(result.request.resolvedMode).toBe('baat_kar');
    expect(result.attempt.kind).toBe('baat_kar');
    expect(result.attempt.status).toBe('created');
    expect(result.attempt.requestId).toBe(result.request.id);

    // A second real GET confirms both rows really committed, not just an in-memory response shape.
    const requestCheck = await authedFetch(`/v1/requests/${result.request.id}`);
    expect(requestCheck.status).toBe(200);
    const attemptCheck = await authedFetch(`/v1/attempts/${result.attempt.id}`);
    expect(attemptCheck.status).toBe(200);
  });

  it('rejects an exact approval-decision replay after the matching decision resolves', async () => {
    const submitRes = await authedFetch('/v1/submit', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ currentMessage: 'Implement the change', requestedMode: 'karke_dikha', workspaceRoot: dir }),
    });
    const { attempt } = await submitRes.json();
    const approvalRes = await authedFetch(`/v1/attempts/${attempt.id}/approvals`, {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({ kind: 'mutation', summary: { path: 'src/a.ts' } }),
    });
    expect(approvalRes.status).toBe(201);
    const approval = await approvalRes.json();
    const body = JSON.stringify({
      resolution: 'approved',
      attemptId: approval.attemptId,
      gate: approval.kind,
      expectedAttemptRevision: approval.expectedAttemptRevision,
      expectedAttemptStatus: approval.expectedAttemptStatus,
      requestedActionDigest: approval.requestedActionDigest,
      frozenContextHash: approval.frozenContextHash,
      expectedRevision: approval.revision,
    });
    const replayKey = nextIdemp();
    const first = await authedFetch(`/v1/approvals/${approval.id}/resolve`, { method: 'POST', idempotencyKey: replayKey, body });
    expect(first.status).toBe(200);
    const replay = await authedFetch(`/v1/approvals/${approval.id}/resolve`, { method: 'POST', idempotencyKey: replayKey, body });
    expect(replay.status).toBe(409);
    expect((await replay.json()).error.code).toBe('conflict');
  });

  it('rejects a duplicate attempt-creation idempotency key with a different body as idempotency_key_conflict', async () => {
    const conv = await createConversation();
    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'hi',
        requestedMode: 'baat_kar',
        resolvedMode: 'baat_kar',
        routeReason: 'ordinary question',
        conversationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      }),
    });
    const req = await reqRes.json();
    const key = nextIdemp();
    const attemptRes1 = await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: key, body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) });
    expect(attemptRes1.status).toBe(201);
    const attemptRes2 = await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: key, body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) });
    expect(attemptRes2.status).toBe(409);
    const body2 = await attemptRes2.json();
    expect(body2.error.code).toBe('idempotency_key_conflict');
  });

  it('cancel is a real HTTP no-op on repeated calls (idempotent double-click)', async () => {
    const conv = await createConversation();
    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'hi',
        requestedMode: 'saath_kar',
        resolvedMode: 'saath_kar',
        routeReason: 'bounded edit',
        conversationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: true, includeRepositoryContext: true, includeGlobalStoryContext: false },
      }),
    });
    const req = await reqRes.json();
    const attemptRes = await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) });
    const attempt = await attemptRes.json();
    await authedFetch(`/v1/attempts/${attempt.id}/transition`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ toStatus: 'running' }) });

    const cancel1 = await authedFetch(`/v1/attempts/${attempt.id}/cancel`, { method: 'POST', idempotencyKey: nextIdemp(), body: '{}' });
    expect(cancel1.status).toBe(200);
    const cancel2 = await authedFetch(`/v1/attempts/${attempt.id}/cancel`, { method: 'POST', idempotencyKey: nextIdemp(), body: '{}' });
    expect(cancel2.status).toBe(200);
    const state1 = await cancel1.json();
    const state2 = await cancel2.json();
    expect(state2.cancelRequestedAt).toBe(state1.cancelRequestedAt);
  });

  it('broadcasts runtime_event over the WebSocket for a live attempt transition, distinct from story events', async () => {
    const conv = await createConversation();
    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'hi',
        requestedMode: 'baat_kar',
        resolvedMode: 'baat_kar',
        routeReason: 'ordinary question',
        conversationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      }),
    });
    const req = await reqRes.json();

    const client = new WebSocket(wsUrl, { headers: { Authorization: `Bearer ${TOKEN}` } });
    const runtimeEvents: unknown[] = [];
    await new Promise<void>((resolve, reject) => {
      client.on('open', () => resolve());
      client.on('error', reject);
    });
    client.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'runtime_event') runtimeEvents.push(msg.event);
    });

    const attemptRes = await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) });
    const attempt = await attemptRes.json();

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(runtimeEvents.some((e) => (e as { domain: string }).domain === 'attempt')).toBe(true);
    client.close();
  });

  it('GET /v1/attempts/:id/recovery reflects the attempt lifecycle over real HTTP', async () => {
    const conv = await createConversation();
    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'hi',
        requestedMode: 'baat_kar',
        resolvedMode: 'baat_kar',
        routeReason: 'ordinary question',
        conversationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      }),
    });
    const req = await reqRes.json();
    const attemptRes = await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) });
    const attempt = await attemptRes.json();

    const beforeRun = await authedFetch(`/v1/attempts/${attempt.id}/recovery`);
    expect((await beforeRun.json()).classification).toBe('safely_retryable_from_scratch');

    await authedFetch(`/v1/attempts/${attempt.id}/transition`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ toStatus: 'running' }) });
    const whileRunningNoClaim = await authedFetch(`/v1/attempts/${attempt.id}/recovery`);
    expect((await whileRunningNoClaim.json()).classification).toBe('requires_reconciliation');

    await authedFetch(`/v1/attempts/${attempt.id}/claim`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ claimOwner: 'core-A', leaseMs: 30000 }) });
    const whileRunningClaimed = await authedFetch(`/v1/attempts/${attempt.id}/recovery`);
    expect((await whileRunningClaimed.json()).classification).toBe('safely_resumable');

    await authedFetch(`/v1/attempts/${attempt.id}/transition`, { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ toStatus: 'completed' }) });
    const afterCompletion = await authedFetch(`/v1/attempts/${attempt.id}/recovery`);
    expect((await afterCompletion.json()).classification).toBe('terminal');
  });

  it('replays missed runtime events via GET /v1/runtime-events?after=', async () => {
    const conv = await createConversation();
    const reqRes = await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'hi',
        requestedMode: 'baat_kar',
        resolvedMode: 'baat_kar',
        routeReason: 'ordinary question',
        conversationId: conv.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      }),
    });
    const req = await reqRes.json();
    const before = await authedFetch('/v1/runtime-events?after=0');
    const beforeBody = await before.json();
    const beforeCount = beforeBody.events.length;

    await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) });

    const after = await authedFetch('/v1/runtime-events?after=0');
    const afterBody = await after.json();
    expect(afterBody.events.length).toBeGreaterThan(beforeCount);
  });
});
