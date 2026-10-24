import type { AttemptRecord, ApprovalRecord, AttemptRecoveryClassification } from '../shared/wireTypes';
import { isTerminalAttemptStatus } from './attemptTransitions';

/**
 * Recovery classification for an execution attempt, per docs/m32-architecture.md
 * RECOVERY. Pure function of durable state — never assumes a lost child process
 * completed successfully, never silently resumes an unsafe mutation stage.
 */
export type RecoveryClassification = AttemptRecoveryClassification;

const NOT_YET_STARTED_STATUSES = new Set(['created', 'queued']);

/** Statuses where a live process (model call, tool call, worktree mutation) may
 * have been running — losing the owning process here must never be assumed safe. */
const IN_FLIGHT_STATUSES = new Set(['running', 'validating', 'cancelling']);

function claimIsStale(attempt: AttemptRecord, nowIso: string): boolean {
  if (!attempt.claimExpiresAt) return true;
  return new Date(attempt.claimExpiresAt).getTime() < new Date(nowIso).getTime();
}

export function classifyAttemptRecovery(attempt: AttemptRecord, approvals: ApprovalRecord[], nowIso: string): RecoveryClassification {
  if (isTerminalAttemptStatus(attempt.status)) {
    return 'terminal';
  }
  if (NOT_YET_STARTED_STATUSES.has(attempt.status)) {
    return 'safely_retryable_from_scratch';
  }

  const hasPendingApproval = approvals.some((a) => a.status === 'pending');
  if (attempt.status === 'waiting_for_approval' || (attempt.status === 'blocked' && hasPendingApproval)) {
    // A pending approval survives restart by construction (it's a durable row,
    // not in-memory) — exactly one live card, per the charter's recovery contract.
    return hasPendingApproval ? 'awaiting_human_approval' : 'requires_reconciliation';
  }

  if (IN_FLIGHT_STATUSES.has(attempt.status)) {
    return claimIsStale(attempt, nowIso) ? 'requires_reconciliation' : 'safely_resumable';
  }

  if (attempt.status === 'paused') {
    return claimIsStale(attempt, nowIso) ? 'requires_reconciliation' : 'safely_resumable';
  }

  if (attempt.status === 'blocked' || attempt.status === 'recovery_required') {
    return 'requires_reconciliation';
  }

  return 'requires_reconciliation';
}
