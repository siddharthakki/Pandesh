import type { CoreDatabase } from '../db/connection';
import { expireApproval, getApproval, listApprovalsForAttempt } from './approvals';
import { loadLoopContinuation } from './attemptLoopContinuation';
import { failAttempt, listAttempts, transitionAttempt } from './attempts';
import { classifyAttemptRecovery, type RecoveryClassification } from './recovery';
import { isBackgroundTaskAttempt } from './backgroundTasks';

const EXECUTOR_OWNER = /^core:executor:(\d+)$/;

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Fail closed on attempts whose owning Core executor process is gone. Core is
 * single-instance, so a running/validating attempt claimed by a dead executor
 * can never finish; leaving it non-terminal blocks every client behind a
 * permanent "Working" state. The outcome of the lost step is unknown, so it is
 * never replayed — the attempt is failed with a truthful reason and its tool
 * ledger stays as the record of what did happen. Cancelling attempts settle as
 * cancelled (the user already asked to stop). A pending approval whose waiting
 * worker is gone and that has no durable continuation is retired as expired.
 * Paused and not-yet-started attempts are left untouched.
 */
export function failDeadExecutorAttemptsOnBoot(
  db: CoreDatabase,
  options: { selfPid?: number; isProcessAlive?: (pid: number) => boolean } = {},
): Array<{ attemptId: string; status: string; outcome: 'failed' | 'cancelled' }> {
  const selfPid = options.selfPid ?? process.pid;
  const isAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const settled: Array<{ attemptId: string; status: string; outcome: 'failed' | 'cancelled' }> = [];
  for (const attempt of listAttempts(db, { activeOnly: true, limit: 500, offset: 0 })) {
    if (!['running', 'validating', 'cancelling', 'waiting_for_approval'].includes(attempt.status)) continue;
    if (isBackgroundTaskAttempt(db, attempt.id)) continue;
    const owner = EXECUTOR_OWNER.exec(attempt.claimOwner ?? '');
    if (!owner) continue;
    const pid = Number(owner[1]);
    if (pid === selfPid || isAlive(pid)) continue;
    const actor = 'core:boot-reconciliation';
    if (attempt.status === 'waiting_for_approval') {
      // A Saath loop suspended on a governed approval keeps a durable continuation and resumes after the answer.
      // Any other worker (the live chat agent) waited for the answer in memory; that wait died with the process, so
      // Approve could only pretend to continue. Retire the approval (nobody decided) and settle the task truthfully.
      if (loadLoopContinuation(db, attempt.id)?.pendingApprovalId) continue;
      const pending = listApprovalsForAttempt(db, attempt.id).filter((approval) => approval.status === 'pending');
      if (pending.length === 0) continue;
      for (const approval of pending) {
        expireApproval(db, approval.id, { actor, reason: 'the worker that was waiting for this answer stopped when Core restarted; ask again to retry' });
      }
      failAttempt(db, attempt.id, {
        fenceToken: attempt.fenceToken,
        actor,
        failureReason: 'Interrupted: KarkeDikha restarted while this task was waiting for your approval. Nothing was approved, rejected or run. Ask again to retry.',
      });
      settled.push({ attemptId: attempt.id, status: attempt.status, outcome: 'failed' });
      continue;
    }
    if (attempt.status === 'cancelling') {
      transitionAttempt(db, attempt.id, { toStatus: 'cancelled', fenceToken: attempt.fenceToken, actor, reason: 'Core restarted while cancelling' });
      settled.push({ attemptId: attempt.id, status: attempt.status, outcome: 'cancelled' });
    } else {
      failAttempt(db, attempt.id, {
        fenceToken: attempt.fenceToken,
        actor,
        failureReason: 'Interrupted: KarkeDikha restarted while this task was running. It was not replayed automatically; any actions already recorded remain as they are. Ask again to retry.',
      });
      settled.push({ attemptId: attempt.id, status: attempt.status, outcome: 'failed' });
    }
  }
  return settled;
}

export interface BootReconciliationSummary {
  scanned: number;
  byClassification: Record<RecoveryClassification, number>;
  /** Attempts no client rehydration will treat as safely resumable/awaiting
   * approval — the ones a crashed process could otherwise leave silently
   * stuck as non-terminal forever if no client ever reconnects. */
  orphaned: Array<{ attemptId: string; status: string }>;
}

/**
 * Read-only defense-in-depth scan run once at Core boot (recovery audit
 * finding #2). `classifyAttemptRecovery` already correctly classifies every
 * non-terminal attempt whenever a *client* calls
 * `listWorkspaceAttemptRehydration` — but nothing previously ran that check
 * from Core's own side, so an attempt orphaned by a crashed process (Core
 * respawned without the Desktop/VS Code client also restarting) could sit
 * silently non-terminal with nothing surfacing it. This never mutates
 * attempt state — Core does not unilaterally decide a lost process's
 * outcome, matching the project's existing "no worker-asserted success"
 * principle — it only makes an otherwise-silent orphan visible in Core's own
 * boot log, for the next client rehydration (or an operator) to act on.
 */
export function scanOrphanedAttemptsOnBoot(db: CoreDatabase, now = new Date()): BootReconciliationSummary {
  const byClassification: Record<RecoveryClassification, number> = {
    terminal: 0,
    safely_resumable: 0,
    safely_retryable_from_scratch: 0,
    awaiting_human_approval: 0,
    requires_reconciliation: 0,
  };
  const orphaned: BootReconciliationSummary['orphaned'] = [];
  let scanned = 0;
  for (let offset = 0; ; offset += 200) {
    const page = listAttempts(db, { activeOnly: true, limit: 200, offset });
    for (const attempt of page) {
      scanned += 1;
      const attemptApprovals = listApprovalsForAttempt(db, attempt.id);
      // Mirrors listWorkspaceAttemptRehydration's own fold-in: a Saath Kar
      // attempt suspended on a governed-capability approval owns no approval
      // row of its own (see that function's comment for the full reasoning).
      const continuation = loadLoopContinuation(db, attempt.id);
      const recoveryApprovals = continuation?.pendingApprovalId
        ? [...attemptApprovals, getApproval(db, continuation.pendingApprovalId)]
        : attemptApprovals;
      const classification = classifyAttemptRecovery(attempt, recoveryApprovals, now.toISOString());
      byClassification[classification] += 1;
      if (classification === 'requires_reconciliation') {
        orphaned.push({ attemptId: attempt.id, status: attempt.status });
      }
    }
    if (page.length < 200) break;
  }
  return { scanned, byClassification, orphaned };
}
