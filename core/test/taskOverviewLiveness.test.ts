/**
 * The Tasks screen must tell the truth about what is actually running.
 *
 * A persisted `running` status is not proof of work: an attempt whose worker
 * died stays `running` in the database forever. Liveness is proven by the
 * owning executor's lease (renewed by its heartbeat), and elapsed time must
 * only move while the task actually moves.
 *
 * Internal capability-dispatch anchors are bookkeeping, not user tasks, and
 * must never appear in the list.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, claimAttempt, transitionAttempt } from '../domain/attempts';
import { listTaskOverview } from '../domain/taskOverview';

let dir: string;
let db: CoreDatabase;
let n = 0;

function submit(message: string) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  return submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${++n}`,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'zeta:1b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: false, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
}

/** A worker that holds the attempt right now. */
function claimLive(attemptId: string, leaseMs = 60_000): void {
  claimAttempt(db, attemptId, { claimOwner: 'core:executor:4242', leaseMs, actor: 'test' });
}

/** A worker that is gone: the lease it held has expired. */
function claimExpired(attemptId: string): void {
  claimAttempt(db, attemptId, { claimOwner: 'core:executor:4242', leaseMs: 1, actor: 'test' });
  db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', [
    new Date(Date.now() - 60_000).toISOString(), attemptId,
  ]);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskov-live-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('task overview liveness', () => {
  it('reports an attempt a worker still holds as live', () => {
    const sub = submit('Build the invoice page');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    claimLive(sub.attempt.id);

    const row = listTaskOverview(db).find((r) => r.attemptId === sub.attempt.id)!;
    expect(row).toBeDefined();
    expect(row.live).toBe(true);
    expect(row.interrupted).toBe(false);
    expect(row.leaseExpiresAt).toBeTruthy();
  });

  it('does not report a stale persisted attempt as running, and freezes its elapsed time', () => {
    const sub = submit('Refactor everything');
    transitionAttempt(db, sub.attempt.id, { toStatus: 'running', actor: 'test' });
    claimExpired(sub.attempt.id);

    const row = listTaskOverview(db).find((r) => r.attemptId === sub.attempt.id)!;
    expect(row.status).toBe('running');
    expect(row.live).toBe(false);
    expect(row.interrupted).toBe(true);
    expect(row.activity).toMatch(/Interrupted/);
    // Elapsed time must be the runtime the task really had, not hours of
    // imaginary runtime that keeps counting after the worker is gone.
    expect(row.elapsedMs).toBeLessThan(60_000);
  });

  it('never lists an internal capability-dispatch anchor as a user task', () => {
    const request = createRequest(db, {
      clientId: 'test-client',
      currentMessage: 'M38 governed capability dispatch anchor for conv_demo',
      requestedMode: 'saath_kar',
      resolvedMode: 'saath_kar',
      routeReason: 'm38_capability_dispatch',
      contextPolicy: {
        includeConversationHistory: false,
        includeProjectContext: false,
        includeRepositoryContext: false,
        includeGlobalStoryContext: false,
      },
      correlationId: 'anchor-1',
    });
    const anchor = createAttempt(db, { requestId: request.id, kind: 'saath_kar', actor: 'test', clientId: 'test-client' });
    transitionAttempt(db, anchor.id, { toStatus: 'running', actor: 'test' });

    const rows = listTaskOverview(db);
    expect(rows.find((r) => r.attemptId === anchor.id)).toBeUndefined();
  });
});
