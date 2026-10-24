/**
 * An approval whose worker is gone (Core restarted) must stop being actionable: Approve would only pretend to resume a
 * task nobody is running. It is retired as `expired` (not rejected), the task stays interrupted, and a live worker's
 * approval is never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createAttempt, getAttempt, transitionAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { createRequest } from '../domain/requests';
import { createApproval, getApproval, listPendingApprovals } from '../domain/approvals';
import { newId } from '../domain/ids';
import { retireOrphanedApprovals } from '../runtime/cancellationRecovery';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-orphan-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

function waitingAttempt(leaseMs: number) {
  const request = createRequest(db, {
    clientId: 'test',
    currentMessage: 'Delete a file',
    requestedMode: 'baat_kar',
    resolvedMode: 'baat_kar',
    routeReason: 'test',
    correlationId: `corr-${newId('x')}`,
    contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
  });
  const attempt = createAttempt(db, { requestId: request.id, kind: 'baat_kar', actor: 'test' });
  const fence = acquireFence(db, attempt.id, { owner: 'core:executor:1', actor: 'test', leaseMs });
  transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
  transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', fenceToken: fence.token, actor: 'test' });
  const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', summary: { toolName: 'run_checks' }, presentation: { cardText: 'del x' }, actor: 'test' });
  return { attemptId: attempt.id, approvalId: approval.id };
}

describe('approvals whose worker is gone', () => {
  it('are retired as expired, never rejected, and the task is left interrupted for a real resume', () => {
    const { attemptId, approvalId } = waitingAttempt(1);
    const later = new Date(Date.now() + 60_000);
    const result = retireOrphanedApprovals(db, { now: later });
    expect(result.retired).toEqual([{ approvalId, attemptId }]);
    const approval = getApproval(db, approvalId);
    expect(approval.status).toBe('expired');
    expect(listPendingApprovals(db)).toHaveLength(0);
    expect(getAttempt(db, attemptId).status).toBe('waiting_for_approval');
    const event = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'approval_expired' AND entityId = ?", [approvalId]);
    expect(event?.metadata).toMatch(/Core restarted/);
  });

  it('are left alone while the worker is alive or still executing here', () => {
    const live = waitingAttempt(120_000);
    expect(retireOrphanedApprovals(db).retired).toHaveLength(0);
    expect(getApproval(db, live.approvalId).status).toBe('pending');
    const gone = waitingAttempt(1);
    const later = new Date(Date.now() + 60_000);
    expect(retireOrphanedApprovals(db, { now: later, isExecuting: (id) => id === gone.attemptId }).retired).toHaveLength(0);
    expect(getApproval(db, gone.approvalId).status).toBe('pending');
  });

  it('is idempotent', () => {
    waitingAttempt(1);
    const later = new Date(Date.now() + 60_000);
    expect(retireOrphanedApprovals(db, { now: later }).retired).toHaveLength(1);
    expect(retireOrphanedApprovals(db, { now: later }).retired).toHaveLength(0);
  });
});
