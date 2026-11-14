/**
 * The result of an attempt in the words the owner needs (M1, reliability program): completed, partial, blocked, failed,
 * cancelled, interrupted (and running while it has not ended).
 *
 * The attempt's lifecycle status says whether the turn ran to its end; it was never a statement about the work (audit:
 * `completed` on undone work in 3 of 16 live scenarios). This function derives the work's result from what Core
 * recorded: the terminal status, the failure reason's well-known prefixes, the task outcome and the escalation
 * records. Consumers that show or act on "did it work" (UI, phone, routines, the evaluation harness) read this, not
 * `attempt.status`. `completed` is returned only when nothing recorded says the work is unfinished.
 */
import type { CoreDatabase } from '../db/connection';
import { getAttempt } from './attempts';
import { getTaskOutcome } from './taskOutcomes';

export type ResultStatus = 'running' | 'completed' | 'partial' | 'blocked' | 'failed' | 'cancelled' | 'interrupted';
export const PARTIAL_PREFIX = 'Partly done:';
export const INTERRUPTED_PREFIX = 'Interrupted:';

export interface AttemptResult { status: ResultStatus; reason: string | null }

export function deriveResultStatus(db: CoreDatabase, attemptId: string): AttemptResult {
  const attempt = getAttempt(db, attemptId);
  switch (attempt.status) {
    case 'cancelled': return { status: 'cancelled', reason: attempt.failureReason ?? null };
    case 'recovery_required': return { status: 'interrupted', reason: attempt.failureReason ?? 'the task was interrupted and needs a decision' };
    case 'waiting_for_approval': return { status: 'blocked', reason: 'waiting for your approval' };
    case 'paused': case 'blocked': return { status: 'blocked', reason: attempt.failureReason ?? null };
    case 'failed': {
      const reason = attempt.failureReason ?? null;
      if (reason?.startsWith(INTERRUPTED_PREFIX)) return { status: 'interrupted', reason };
      if (reason?.startsWith(PARTIAL_PREFIX)) return { status: 'partial', reason };
      return { status: 'failed', reason };
    }
    case 'completed': break;
    default: return { status: 'running', reason: null };
  }

  // A turn that ended is not necessarily work that was done.
  const outcome = getTaskOutcome(db, attemptId);
  if (outcome?.status === 'blocked') return { status: 'blocked', reason: outcome.blocker ?? null };
  if (outcome?.status === 'partial') return { status: 'partial', reason: outcome.blocker ?? outcome.summary ?? null };
  const unfinished = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'turn_unfinished' ORDER BY sequence DESC LIMIT 1", [attemptId]);
  if (unfinished && !db.get('SELECT 1 FROM attempts WHERE predecessorAttemptId = ? LIMIT 1', [attemptId])) {
    let reason = 'the turn ended with the work unfinished';
    try { const meta = JSON.parse(unfinished.metadata) as { reason?: string }; reason = meta.reason === 'no_reply' ? 'the model produced no reply' : 'nothing was built — no file was written or changed'; } catch { /* generic reason */ }
    return { status: 'failed', reason };
  }
  // The work was blocked by a tool that failed and the reply asked the user how to go on (M0 E01).
  const blocked = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'turn_blocked' ORDER BY sequence DESC LIMIT 1", [attemptId]);
  if (blocked) {
    let reason = 'a tool this task needs failed';
    try { const meta = JSON.parse(blocked.metadata) as { tool?: string; reason?: string }; reason = `${meta.tool ?? 'a tool'} failed: ${meta.reason ?? ''}`.trim(); } catch { /* generic reason */ }
    return { status: 'blocked', reason };
  }
  return { status: 'completed', reason: null };
}
