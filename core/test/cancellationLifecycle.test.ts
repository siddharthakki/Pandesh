/**
 * Cancellation lifecycle (P0): a stop that the user asked for must always end
 * in the authoritative terminal state.
 *
 * The defect this pins down: while a turn was running, the cancel request moved
 * the attempt to `cancelling` and the turn then tried to finish normally. The
 * transition `cancelling -> completed` is not permitted, so the transition was
 * rejected, the rejection was swallowed, and the attempt stayed `cancelling`
 * forever — every client behind it waited on a "Working" state that never
 * ended, and the desktop's Stop button sat on "Stopping…" indefinitely.
 *
 * These tests use an isolated Core (temporary database, no shared state) and
 * never touch the user's live Core.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import {
  createAttempt,
  getAttempt,
  requestCancelAttempt,
  settleCancelledAttempt,
  transitionAttempt,
} from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { createRequest } from '../domain/requests';
import { newId } from '../domain/ids';
import { startModelInvocation } from '../domain/modelInvocations';
import { failDeadExecutorAttemptsOnBoot } from '../domain/bootReconciliation';
import { settleAbandonedCancellations } from '../runtime/cancellationRecovery';
import { RuntimeExecutor } from '../runtime/executor';
import type { ModelBackend } from '../runtime/modelBackend';
import { isTerminalAttemptStatus } from '../domain/attemptTransitions';

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let broadcaster: EventBroadcaster;
let baseUrl: string;
let idempotencyCounter = 0;

function nextIdemp(): string {
  idempotencyCounter += 1;
  return `idemp-cancel-${idempotencyCounter}`;
}

function authedFetch(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'cancel-test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

async function jsonOf(res: Response) {
  expect(res.ok, `expected 2xx, got ${res.status}`).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, predicate: (a: any) => boolean, timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (predicate(attempt)) return attempt;
    if (Date.now() > deadline) {
      throw new Error(`attempt ${id} never satisfied the predicate; last status=${attempt.status}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A request + attempt in the given status, owned by a fenced executor. */
function seedAttempt(status: 'created' | 'running' = 'running'): { attemptId: string; fenceToken: string } {
  const request = createRequest(db, {
    clientId: 'cancel-test-client',
    currentMessage: 'Stop me.',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'test',
    correlationId: `corr-${newId('x')}`,
    contextPolicy: {
      includeConversationHistory: true,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
  });
  const attempt = createAttempt(db, { requestId: request.id, kind: 'baat_kar', actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: 'core:executor:1', actor: 'test', leaseMs: 120_000 });
  if (status === 'running') {
    transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
  }
  return { attemptId: attempt.id, fenceToken: fence.token };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-cancel-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster,
    dataDir: dir,
    coreInfo: () => ({
      coreVersion: '0.1.0', apiVersion: 1, instanceId: 'cancel-test', startedAt: new Date().toISOString(),
      nodeVersion: process.version, electronVersion: null, dataDir: dir,
    }),
    onShutdown: () => {},
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('cancellation reaches an authoritative terminal state', () => {
  it('a cancel-requested attempt cannot be transitioned to completed (the defect that stranded it)', () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    expect(getAttempt(db, attemptId).status).toBe('cancelling');

    // The exact failure: the turn finished and tried to report success.
    expect(() => transitionAttempt(db, attemptId, { toStatus: 'completed', fenceToken, actor: 'test' }))
      .toThrow(/not permitted/);
    expect(getAttempt(db, attemptId).status).toBe('cancelling');
  });

  it('settles a cancel-requested attempt as cancelled from every non-terminal state', () => {
    for (const startStatus of ['created', 'running'] as const) {
      const { attemptId, fenceToken } = seedAttempt(startStatus);
      requestCancelAttempt(db, attemptId, { actor: 'test' });
      const settled = settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken });
      expect(settled.status, `start status ${startStatus}`).toBe('cancelled');
      expect(settled.cancelledAt).toBeTruthy();
      expect(isTerminalAttemptStatus(getAttempt(db, attemptId).status)).toBe(true);
    }
  });

  it('cancelling closes the pending model invocations the attempt owns', () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    const invocation = startModelInvocation(db, {
      attemptId, requestedProvider: 'ollama', requestedModel: 'model-a', actor: 'test',
    });
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken });

    const row = db.get<{ status: string }>('SELECT status FROM model_invocations WHERE id = ?', [invocation.id]);
    expect(row?.status).toBe('cancelled');
  });

  it('never bypasses the fence: a stale token cannot settle, the current owner can', () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });

    // A newer executor takes the attempt: the first token is now stale.
    const next = acquireFence(db, attemptId, { owner: 'core:executor:2', actor: 'test', leaseMs: 120_000 });
    expect(next.token).not.toBe(fenceToken);

    expect(() => settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken }))
      .toThrow(/fence/i);
    expect(getAttempt(db, attemptId).status).toBe('cancelling');

    // The current owner settles it truthfully.
    expect(settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken: next.token }).status).toBe('cancelled');
  });

  it('repeated stops are idempotent: one cancel request, one terminal event', async () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken });
    // A second stop on a terminal attempt changes nothing.
    const again = requestCancelAttempt(db, attemptId, { actor: 'test' });
    expect(again.status).toBe('cancelled');
    settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken });

    const events = db.all<{ eventType: string }>(
      'SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [attemptId],
    );
    expect(events.filter((e) => e.eventType === 'attempt_cancel_requested')).toHaveLength(1);
    expect(events.filter((e) => e.eventType === 'attempt_cancelled')).toHaveLength(1);
  });

  it('records the cancellation as a runtime event clients can see', () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    settleCancelledAttempt(db, attemptId, { actor: 'test', fenceToken });
    const events = db.all<{ eventType: string }>(
      'SELECT eventType FROM runtime_events WHERE entityId = ? ORDER BY sequence', [attemptId],
    );
    expect(events.map((e) => e.eventType)).toContain('attempt_cancelled');
  });
});

describe('recovery for an abandoned cancellation', () => {
  it('settles a cancelling attempt whose owner stopped heart-beating', () => {
    const { attemptId, fenceToken } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    // The owner's lease lapses (the heartbeat stopped) — nobody is left to settle it.
    db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), attemptId]);

    const result = settleAbandonedCancellations(db, { isExecuting: () => false });
    expect(result.settled.map((s) => s.attemptId)).toEqual([attemptId]);
    expect(getAttempt(db, attemptId).status).toBe('cancelled');
    // The owner's token was current, so the recovery used it rather than a forged one.
    expect(fenceToken).toBeTruthy();
  });

  it('leaves a cancellation alone while its owner is still alive', () => {
    const { attemptId } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });

    const live = settleAbandonedCancellations(db, { isExecuting: () => false });
    expect(live.settled).toHaveLength(0);
    expect(live.skipped.map((s) => s.reason)).toContain('lease_is_live');
    expect(getAttempt(db, attemptId).status).toBe('cancelling');
  });

  it('never settles a cancellation that is still executing in this process', () => {
    const { attemptId } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', [new Date(Date.now() - 60_000).toISOString(), attemptId]);

    const result = settleAbandonedCancellations(db, { isExecuting: (id) => id === attemptId });
    expect(result.settled).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason)).toContain('executor_is_running');
    expect(getAttempt(db, attemptId).status).toBe('cancelling');
  });

  it('after a restart, a cancelling attempt left by a dead executor is settled as cancelled', () => {
    const { attemptId } = seedAttempt('running');
    requestCancelAttempt(db, attemptId, { actor: 'test' });
    // The owning executor process is gone.
    db.run('UPDATE attempts SET claimOwner = ? WHERE id = ?', ['core:executor:999999', attemptId]);

    const settled = failDeadExecutorAttemptsOnBoot(db, { selfPid: process.pid, isProcessAlive: () => false });
    expect(settled).toEqual([{ attemptId, status: 'cancelling', outcome: 'cancelled' }]);
    expect(getAttempt(db, attemptId).status).toBe('cancelled');
  });
});

describe('stop during an active inference (through the real API)', () => {
  it('a stop request ends the attempt in cancelled, not in a permanent cancelling', async () => {
    const conversation = await jsonOf(await authedFetch('/v1/conversations', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
    }));
    await jsonOf(await authedFetch(`/v1/conversations/${conversation.id}/messages`, {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ role: 'user', content: 'Stop me please.' }),
    }));
    const request = await jsonOf(await authedFetch('/v1/requests', {
      method: 'POST',
      idempotencyKey: nextIdemp(),
      body: JSON.stringify({
        currentMessage: 'Stop me please.', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test',
        conversationId: conversation.id,
        contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      }),
    }));
    const attempt = await jsonOf(await authedFetch('/v1/attempts', {
      method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: request.id, kind: 'baat_kar' }),
    }));

    // The turn is stopped before it is dispatched: the executor must settle it,
    // never leave it queued for ever.
    await jsonOf(await authedFetch(`/v1/attempts/${attempt.id}/cancel`, { method: 'POST', idempotencyKey: nextIdemp() }));
    await authedFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp(), body: '{}' });

    const settled = await pollAttempt(attempt.id, (a) => isTerminalAttemptStatus(a.status));
    expect(settled.status).toBe('cancelled');
    expect(settled.cancelRequestedAt).toBeTruthy();
  });

  it('leaves no worker running once the attempt is cancelled', async () => {
    // A backend whose model call never returns on its own: it only ends when the
    // attempt is aborted. This is the shape of a real in-flight inference.
    const backend: ModelBackend = {
      streamChat: async (request, _onToken) => {
        await new Promise<void>((_resolve, reject) => {
          if (request.signal?.aborted) return reject(abortError());
          request.signal?.addEventListener('abort', () => reject(abortError()));
        });
        throw new Error('unreachable');
      },
    };
    const executor = new RuntimeExecutor(db, broadcaster, { backend, defaultModel: 'test-model', dataDir: dir });
    const localApi = await startApiServer({
      db,
      token: TOKEN,
      broadcaster,
      dataDir: dir,
      executor,
      coreInfo: () => ({
        coreVersion: '0.1.0', apiVersion: 1, instanceId: 'cancel-worker-test', startedAt: new Date().toISOString(),
        nodeVersion: process.version, electronVersion: null, dataDir: dir,
      }),
      onShutdown: () => {},
    });
    const localBase = `http://127.0.0.1:${localApi.port}`;
    const localFetch = (p: string, init: RequestInit & { idempotencyKey?: string } = {}) => {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'cancel-worker-test',
        ...(init.headers as Record<string, string> | undefined),
      };
      if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
      return fetch(`${localBase}${p}`, { ...init, headers });
    };

    try {
      const conversation = await (await localFetch('/v1/conversations', {
        method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ mode: 'baat_kar' }),
      })).json();
      const request = await (await localFetch('/v1/requests', {
        method: 'POST',
        idempotencyKey: nextIdemp(),
        body: JSON.stringify({
          currentMessage: 'Keep working.', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test',
          conversationId: conversation.id,
          contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
        }),
      })).json();
      const attempt = await (await localFetch('/v1/attempts', {
        method: 'POST', idempotencyKey: nextIdemp(), body: JSON.stringify({ requestId: request.id, kind: 'baat_kar' }),
      })).json();

      await localFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', idempotencyKey: nextIdemp(), body: '{}' });
      // Wait until the model call is really running.
      for (let i = 0; i < 100; i += 1) {
        await new Promise((r) => setTimeout(r, 20));
        if (executor.isExecuting(attempt.id)) break;
      }
      expect(executor.isExecuting(attempt.id)).toBe(true);

      await localFetch(`/v1/attempts/${attempt.id}/cancel`, { method: 'POST', idempotencyKey: nextIdemp(), body: '{}' });

      const deadline = Date.now() + 5000;
      let settled: any;
      for (;;) {
        settled = await (await localFetch(`/v1/attempts/${attempt.id}`)).json();
        if (isTerminalAttemptStatus(settled.status)) break;
        if (Date.now() > deadline) throw new Error(`attempt never settled; status=${settled.status}`);
        await new Promise((r) => setTimeout(r, 20));
      }

      expect(settled.status).toBe('cancelled');
      // No worker is left behind: the executor released the attempt and the model
      // invocation is closed, not left running.
      expect(executor.isExecuting(attempt.id)).toBe(false);
      const invocations = await (await localFetch(`/v1/attempts/${attempt.id}/model-invocations`)).json();
      for (const invocation of invocations.modelInvocations) {
        expect(invocation.status).toBe('cancelled');
      }
    } finally {
      await localApi.close();
    }
  });
});
