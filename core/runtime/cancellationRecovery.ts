/**
 * Recovery for attempts whose cancellation was requested but whose executor
 * stopped without settling them.
 *
 * A cancel request is durable: `cancelRequestedAt` is set and the attempt moves
 * to `cancelling`. The terminal edge belongs to the executor that owns the
 * attempt (fenced). If that executor finishes the turn without settling the
 * cancel — or dies, or its in-memory execution is lost — the attempt can sit
 * in `cancelling` forever, and every client behind it waits on a "Working"
 * state that never ends. The desktop's Stop button then shows "Stopping…"
 * indefinitely.
 *
 * This sweep is the safe, existing-lifecycle answer to that:
 *
 * - It only touches attempts whose owner's lease has **expired**
 *   (`claimExpiresAt` is renewed by the executor's heartbeat, so an expired
 *   lease is proof that the owner stopped heart-beating) and that are **not**
 *   executing in this process right now.
 * - It settles them as `cancelled` — the user asked to stop, that decision is
 *   durable, and the outcome of the abandoned work is irrelevant because the
 *   work is discarded. It never replays anything.
 * - It presents the attempt's *current* fence token, exactly like boot
 *   reconciliation does for an attempt left by a dead executor. A stale token
 *   is rejected by `assertFence`; the fence is never bypassed and a
 *   cancellation is never fabricated.
 */
import type { CoreDatabase } from '../db/connection';
import { listAttempts, settleCancelledAttempt, getAttempt } from '../domain/attempts';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { expireApproval, listApprovalsForAttempt } from '../domain/approvals';
import { loadLoopContinuation } from '../domain/attemptLoopContinuation';
import { latestRuntimeSequence, listRuntimeEventsAfter } from '../domain/runtimeEvents';
import type { EventBroadcaster } from '../ws/broadcaster';
import type { RuntimeExecutor } from './executor';

const ACTOR = 'core:cancellation-recovery';

export interface AbandonedCancellationSweepResult {
  settled: Array<{ attemptId: string; outcome: 'cancelled' }>;
  /** Attempts left alone, with the reason — never a silent skip. */
  skipped: Array<{ attemptId: string; reason: 'executor_is_running' | 'lease_is_live' | 'settlement_refused' }>;
}

export interface AbandonedCancellationSweepOptions {
  now?: Date;
  /** True while this process is still executing the attempt. */
  isExecuting?: (attemptId: string) => boolean;
  limit?: number;
}

/**
 * Settles every cancellation-requested attempt whose owner is gone.
 * Idempotent: an attempt that is already terminal is left alone.
 */
export function settleAbandonedCancellations(
  db: CoreDatabase,
  options: AbandonedCancellationSweepOptions = {},
): AbandonedCancellationSweepResult {
  const now = options.now ?? new Date();
  const isExecuting = options.isExecuting ?? (() => false);
  const limit = options.limit ?? 200;
  const result: AbandonedCancellationSweepResult = { settled: [], skipped: [] };

  for (const attempt of listAttempts(db, { activeOnly: true, limit, offset: 0 })) {
    if (attempt.status !== 'cancelling') continue;
    if (isExecuting(attempt.id)) {
      result.skipped.push({ attemptId: attempt.id, reason: 'executor_is_running' });
      continue;
    }
    // The owner's lease is renewed by its heartbeat. An expired lease means the
    // owner stopped heart-beating: nobody is left to settle this attempt.
    const leaseLive = Boolean(attempt.claimExpiresAt)
      && new Date(attempt.claimExpiresAt as string).getTime() > now.getTime();
    if (leaseLive) {
      result.skipped.push({ attemptId: attempt.id, reason: 'lease_is_live' });
      continue;
    }
    try {
      const settled = settleCancelledAttempt(db, attempt.id, {
        actor: ACTOR,
        fenceToken: attempt.fenceToken,
      });
      if (settled.status === 'cancelled') {
        recordRuntimeEvent(db, {
          domain: 'attempt',
          entityId: attempt.id,
          eventType: 'attempt_cancellation_recovered',
          actor: ACTOR,
          metadata: { previousStatus: attempt.status, reason: 'owner_lease_expired' },
        });
        result.settled.push({ attemptId: attempt.id, outcome: 'cancelled' });
      }
    } catch (err) {
      // A refused settlement (a newer executor took the fence) is reported, never
      // forced: that owner settles the attempt.
      result.skipped.push({ attemptId: attempt.id, reason: 'settlement_refused' });
      console.warn(
        `[karkedikha-core] abandoned cancellation not settled for ${attempt.id}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return result;
}

export interface OrphanedApprovalSweepResult {
  retired: Array<{ approvalId: string; attemptId: string }>;
}

/**
 * Retires approvals that nobody can act on any more.
 *
 * A pending approval belongs to a worker that is blocked waiting for the answer. When that worker is gone (Core
 * restarted, the process died) its lease expires and nothing is left to continue the task, so an Approve button would
 * only pretend to do something. The approval is retired as `expired` (not rejected: nobody decided anything) with the
 * reason, the card stops being actionable, and the task is shown as interrupted with the real way forward (resume it,
 * which asks again). It never approves, rejects or replays anything.
 */
export function retireOrphanedApprovals(
  db: CoreDatabase,
  options: { now?: Date; isExecuting?: (attemptId: string) => boolean; limit?: number } = {},
): OrphanedApprovalSweepResult {
  const now = options.now ?? new Date();
  const isExecuting = options.isExecuting ?? (() => false);
  const result: OrphanedApprovalSweepResult = { retired: [] };
  for (const attempt of listAttempts(db, { activeOnly: true, limit: options.limit ?? 200, offset: 0 })) {
    if (attempt.status !== 'waiting_for_approval') continue;
    if (isExecuting(attempt.id)) continue;
    const leaseLive = Boolean(attempt.claimExpiresAt) && new Date(attempt.claimExpiresAt as string).getTime() > now.getTime();
    if (leaseLive) continue;
    // A Saath loop suspended on a governed approval keeps a durable continuation and resumes after the answer: its
    // approval is still actionable and is never retired here.
    const continuation = loadLoopContinuation(db, attempt.id);
    for (const approval of listApprovalsForAttempt(db, attempt.id)) {
      if (approval.status !== 'pending') continue;
      if (continuation?.pendingApprovalId === approval.id) continue;
      try {
        expireApproval(db, approval.id, {
          actor: ACTOR,
          reason: 'the worker that was waiting for this answer is gone (Core restarted); the task is interrupted, resume it to be asked again',
        });
        recordRuntimeEvent(db, {
          domain: 'attempt',
          entityId: attempt.id,
          eventType: 'attempt_approval_orphaned',
          actor: ACTOR,
          metadata: { approvalId: approval.id, reason: 'owner_lease_expired' },
        });
        result.retired.push({ approvalId: approval.id, attemptId: attempt.id });
      } catch (err) {
        console.warn(`[karkedikha-core] orphaned approval ${approval.id} not retired: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/** True when the attempt's cancellation is still waiting for an owner to settle it. */
export function isPendingCancellation(db: CoreDatabase, attemptId: string): boolean {
  const attempt = getAttempt(db, attemptId);
  return attempt.status === 'cancelling' && Boolean(attempt.cancelRequestedAt);
}

/**
 * Runs the abandoned-cancellation sweep on a timer, inside Core, so the
 * recovery does not depend on a client being open. Settled attempts publish
 * their runtime events, so a watching desktop/phone sees the real terminal
 * state instead of a permanent "Working".
 */
export function startCancellationRecoveryLoop(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  executor: RuntimeExecutor,
  intervalMs = 30_000,
): () => void {
  const tick = () => {
    try {
      const before = latestRuntimeSequence(db);
      const result = settleAbandonedCancellations(db, { isExecuting: (id) => executor.isExecuting(id) });
      const orphaned = retireOrphanedApprovals(db, { isExecuting: (id) => executor.isExecuting(id) });
      if (orphaned.retired.length > 0) {
        for (const event of listRuntimeEventsAfter(db, before, 200)) broadcaster.publishRuntime(event);
        console.log(`[karkedikha-core ${new Date().toISOString()}] retired ${orphaned.retired.length} approval(s) whose worker is gone`);
      }
      if (result.settled.length > 0) {
        for (const event of listRuntimeEventsAfter(db, before, 200)) broadcaster.publishRuntime(event);
        console.log(
          `[karkedikha-core ${new Date().toISOString()}] cancellation recovery settled `
          + `${result.settled.length} abandoned attempt(s) as cancelled `
          + `(${result.settled.map((s) => s.attemptId).join(', ')})`,
        );
      }
    } catch (err) {
      console.error(
        `[karkedikha-core ${new Date().toISOString()}] cancellation recovery sweep failed: `,
        err instanceof Error ? err.message : err,
      );
    }
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 5_000).unref?.();
  return () => clearInterval(timer);
}
