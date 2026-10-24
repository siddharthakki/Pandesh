import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { AttemptRehydrationRecord, WorkspaceAttemptRehydration } from '../shared/wireTypes';
import { getApproval, listApprovalsForAttempt } from './approvals';
import { getAttemptContext } from './attemptContext';
import { loadLoopContinuation } from './attemptLoopContinuation';
import { listAttempts } from './attempts';
import { classifyAttemptRecovery } from './recovery';
import { getRequest } from './requests';
import { listRuntimeEventsForAttempt } from './runtimeEvents';

export function workspaceIdentity(value: string): string {
  const resolved = path.resolve(value).replace(/\\/g, '/').replace(/\/$/, '');
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Builds the single activation read model from authoritative Core rows. It is
 * intentionally read-only: activation may reconnect to an identity, but this
 * read can never create or retry one. Terminal and other-workspace attempts
 * are excluded before their event tails are read.
 */
export function listWorkspaceAttemptRehydration(
  db: CoreDatabase,
  workspaceRoot: string,
  now = new Date(),
): WorkspaceAttemptRehydration {
  const expectedWorkspace = workspaceIdentity(workspaceRoot);
  const records: AttemptRehydrationRecord[] = [];
  for (let offset = 0; ; offset += 200) {
    const page = listAttempts(db, { activeOnly: true, limit: 200, offset });
    for (const attempt of page) {
      const context = getAttemptContext(db, attempt.id);
      if (!context.workspaceRoot || workspaceIdentity(context.workspaceRoot) !== expectedWorkspace) continue;
      const attemptApprovals = listApprovalsForAttempt(db, attempt.id);
      // M38: a Saath Kar attempt suspended on a governed-capability approval
      // owns no approval row of its own — the pending approval's `attemptId`
      // is the capability-dispatch *anchor* attempt's id (see
      // core/domain/capabilityDispatch.ts), never the real attempt's, by the
      // same anchor/real split RuntimeExecutor's resume path already relies
      // on (core/runtime/executor.ts ~line 424-430). `listApprovalsForAttempt`
      // alone therefore always misses it, which made `classifyAttemptRecovery`
      // treat every such attempt as `requires_reconciliation` instead of
      // `awaiting_human_approval` — a real attempt would never rehydrate.
      // The attempt's own loop-continuation row records exactly which
      // approval it is actually waiting on; fold that approval in for
      // classification only (the wire record's own `approvals` field keeps
      // its existing meaning: approvals owned directly by this attempt).
      const continuation = loadLoopContinuation(db, attempt.id);
      const recoveryApprovals = continuation?.pendingApprovalId
        ? [...attemptApprovals, getApproval(db, continuation.pendingApprovalId)]
        : attemptApprovals;
      records.push({
        attempt,
        request: getRequest(db, attempt.requestId),
        context,
        approvals: attemptApprovals,
        events: listRuntimeEventsForAttempt(db, attempt.id),
        recovery: classifyAttemptRecovery(attempt, recoveryApprovals, now.toISOString()),
      });
    }
    if (page.length < 200) break;
  }
  records.sort((left, right) => right.attempt.updatedAt.localeCompare(left.attempt.updatedAt));
  return { workspaceRoot, attempts: records };
}
