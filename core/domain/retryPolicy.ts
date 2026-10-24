import type { CoreDatabase } from '../db/connection';
import type { AttemptRetryEligibility } from '../shared/wireTypes';
import { getAttemptContext } from './attemptContext';
import { CoreError } from './errors';

const SAFE_RETRY_STATUSES = new Set(['failed', 'blocked', 'recovery_required']);
const SAFETY_BLOCK = /(?:permission|approval).*(?:denied|rejected)|(?:denied|rejected).*(?:permission|approval)|destructive|unsafe|cancel/i;

export function attemptRetryEligibility(db: CoreDatabase, attemptId: string): AttemptRetryEligibility {
  const attempt = db.get<{ status: string; failureReason: string | null }>(
    'SELECT status, failureReason FROM attempts WHERE id = ?',
    [attemptId],
  );
  if (!attempt) throw new CoreError('not_found', `attempt '${attemptId}' not found`);
  const context = getAttemptContext(db, attemptId);
  const rejectedApproval = Boolean(db.get(
    `SELECT id FROM approvals WHERE attemptId = ? AND status = 'rejected' LIMIT 1`,
    [attemptId],
  ));
  const prohibitedBySafety = attempt.status === 'cancelled'
    || rejectedApproval
    || SAFETY_BLOCK.test(attempt.failureReason ?? '');
  if (prohibitedBySafety) {
    return {
      eligible: false,
      reason: 'Retry is disabled after cancellation, a denied permission, or a destructive safety decision.',
      strongerModelAvailable: false,
      prohibitedBySafety: true,
    };
  }
  if (!SAFE_RETRY_STATUSES.has(attempt.status)) {
    return {
      eligible: false,
      reason: `Attempt status '${attempt.status}' is not a deliberate blocker outcome.`,
      strongerModelAvailable: false,
      prohibitedBySafety: false,
    };
  }
  return {
    eligible: true,
    reason: 'The blocked attempt can be retried safely as a new linked attempt.',
    strongerModelAvailable: Boolean(context.modelSelection?.escalationCandidates.some(candidate => candidate.provider === context.selectedProvider)),
    prohibitedBySafety: false,
  };
}
