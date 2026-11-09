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
      if (pending.length === 0) {
        // Build 161 audit: the approvals were answered or expired while the waiting worker was gone (or none was ever
        // recorded). Nothing can resume this attempt, and with no card left nobody can act on it: it used to stay
        // waiting forever. Settle it truthfully; nothing more ran.
        failAttempt(db, attempt.id, {
          fenceToken: attempt.fenceToken,
          actor,
          failureReason: 'Interrupted: the worker waiting for an approval stopped, and no approval was pending any more when Core restarted. Nothing further was run. Ask again to retry.',
        });
        settled.push({ attemptId: attempt.id, status: attempt.status, outcome: 'failed' });
        continue;
      }
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

/**
 * D6: a conversation's shared governed-capability anchor ("M38 governed
 * capability dispatch anchor for conv_…") is opened once and was never closed,
 * so every conversation that ever used a capability left a `running` attempt
 * behind, and they piled up across restarts. After a restart no adapter can
 * still be executing on one, so an anchor with no pending approval and no saved
 * continuation is settled as completed (its tool ledger stays the record). The
 * conversation's next governed call gets a fresh anchor
 * (`ensureCapabilityAttempt`). Anchors still waiting on a human are untouched.
 */
export function settleIdleCapabilityAnchorsOnBoot(db: CoreDatabase): string[] {
  const settled: string[] = [];
  const anchors = db.all<{ id: string; status: string }>(
    `SELECT a.id AS id, a.status AS status
       FROM attempts a JOIN requests r ON r.id = a.requestId
      WHERE r.routeReason = 'm38_capability_dispatch' AND a.parentAttemptId IS NULL
        AND a.status IN ('created', 'running', 'waiting_for_approval')`,
  );
  for (const anchor of anchors) {
    // Build 161 audit: an anchor can also be left `waiting_for_approval` after every approval on it was answered or
    // expired (production held four for weeks). With nothing pending it is as idle as a running one.
    if (listApprovalsForAttempt(db, anchor.id).some((approval) => approval.status === 'pending')) continue;
    if (loadLoopContinuation(db, anchor.id)?.pendingApprovalId) continue;
    if (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_invocations WHERE attemptId = ? AND status = 'running'", [anchor.id])!.n > 0) continue;
    const actor = 'core:boot-reconciliation';
    try {
      if (anchor.status === 'created' || anchor.status === 'waiting_for_approval') transitionAttempt(db, anchor.id, { toStatus: 'running', actor });
      transitionAttempt(db, anchor.id, { toStatus: 'completed', actor, reason: 'idle capability anchor closed at Core start' });
      settled.push(anchor.id);
    } catch {
      // An anchor in a state this walk cannot settle stays as it is; the scan below still reports it.
    }
  }
  return settled;
}

/**
 * Release blocker 2026-11-09: between restarts a conversation's anchor stayed `running` after its turn was over (the
 * boot sweep above only runs at Core start), so task lists showed phantom running work. When a turn in a conversation
 * ends, that conversation's unowned anchors are settled the same way — but only when no approval is pending, no
 * continuation is saved and no tool call is still running on them, so a call in flight is never cut off. The next
 * governed call gets a fresh anchor generation (`ensureCapabilityAttempt`); nothing is re-executed.
 */
export function settleIdleCapabilityAnchorsForConversation(db: CoreDatabase, conversationId: string, actor = 'core:executor'): string[] {
  const settled: string[] = [];
  const anchors = db.all<{ id: string; status: string }>(
    `SELECT a.id AS id, a.status AS status
       FROM attempts a JOIN requests r ON r.id = a.requestId
      WHERE r.routeReason = 'm38_capability_dispatch' AND a.parentAttemptId IS NULL
        AND r.correlationId = ? AND a.status IN ('created', 'running')`,
    [conversationId],
  );
  for (const anchor of anchors) {
    if (listApprovalsForAttempt(db, anchor.id).some((approval) => approval.status === 'pending')) continue;
    if (loadLoopContinuation(db, anchor.id)?.pendingApprovalId) continue;
    if (db.get<{ n: number }>("SELECT COUNT(*) AS n FROM tool_invocations WHERE attemptId = ? AND status IN ('pending', 'running')", [anchor.id])!.n > 0) continue;
    try {
      if (anchor.status === 'created') transitionAttempt(db, anchor.id, { toStatus: 'running', actor });
      transitionAttempt(db, anchor.id, { toStatus: 'completed', actor, reason: 'idle capability anchor closed when its conversation turn ended' });
      settled.push(anchor.id);
    } catch {
      // A state this walk cannot settle is left as it is; the boot sweep tries again.
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
