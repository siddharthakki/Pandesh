import { describe, it, expect } from 'vitest';
import { classifyAttemptRecovery } from '../domain/recovery';
import type { AttemptRecord, ApprovalRecord } from '../shared/wireTypes';

const NOW = '2026-01-01T00:10:00.000Z';

function attempt(overrides: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    id: 'att_1',
    requestId: 'req_1',
    predecessorAttemptId: null,
    kind: 'karke_dikha',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    cancelledAt: null,
    cancelRequestedAt: null,
    failureReason: null,
    claimOwner: null,
    claimExpiresAt: null,
    revision: 1,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'appr_1',
    attemptId: 'att_1',
    kind: 'proposal',
    status: 'pending',
    requestedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: null,
    resolution: null,
    summary: {},
    claimOwner: null,
    claimExpiresAt: null,
    revision: 1,
    ...overrides,
  };
}

describe('classifyAttemptRecovery', () => {
  it('classifies never-started attempts as safely retryable from scratch', () => {
    expect(classifyAttemptRecovery(attempt({ status: 'created' }), [], NOW)).toBe('safely_retryable_from_scratch');
    expect(classifyAttemptRecovery(attempt({ status: 'queued' }), [], NOW)).toBe('safely_retryable_from_scratch');
  });

  it('classifies terminal statuses as terminal regardless of claim state', () => {
    expect(classifyAttemptRecovery(attempt({ status: 'completed' }), [], NOW)).toBe('terminal');
    expect(classifyAttemptRecovery(attempt({ status: 'failed' }), [], NOW)).toBe('terminal');
    expect(classifyAttemptRecovery(attempt({ status: 'cancelled' }), [], NOW)).toBe('terminal');
  });

  it('classifies waiting_for_approval with a live pending approval as awaiting_human_approval', () => {
    const result = classifyAttemptRecovery(attempt({ status: 'waiting_for_approval' }), [approval({ status: 'pending' })], NOW);
    expect(result).toBe('awaiting_human_approval');
  });

  it('classifies waiting_for_approval with no pending approval as requires_reconciliation — never assume it self-resolved', () => {
    const result = classifyAttemptRecovery(attempt({ status: 'waiting_for_approval' }), [approval({ status: 'approved' })], NOW);
    expect(result).toBe('requires_reconciliation');
  });

  it('classifies running with a fresh claim as safely_resumable', () => {
    const result = classifyAttemptRecovery(
      attempt({ status: 'running', claimOwner: 'core-A', claimExpiresAt: '2026-01-01T00:20:00.000Z' }),
      [],
      NOW,
    );
    expect(result).toBe('safely_resumable');
  });

  it('classifies running with a stale/expired claim as requires_reconciliation — never assume a lost process completed', () => {
    const result = classifyAttemptRecovery(
      attempt({ status: 'running', claimOwner: 'core-A', claimExpiresAt: '2026-01-01T00:05:00.000Z' }),
      [],
      NOW,
    );
    expect(result).toBe('requires_reconciliation');
  });

  it('classifies running with no claim at all as requires_reconciliation', () => {
    const result = classifyAttemptRecovery(attempt({ status: 'running', claimOwner: null, claimExpiresAt: null }), [], NOW);
    expect(result).toBe('requires_reconciliation');
  });

  it('classifies validating and cancelling the same as running (in-flight, claim-gated)', () => {
    const fresh = { claimOwner: 'core-A', claimExpiresAt: '2026-01-01T00:20:00.000Z' };
    expect(classifyAttemptRecovery(attempt({ status: 'validating', ...fresh }), [], NOW)).toBe('safely_resumable');
    expect(classifyAttemptRecovery(attempt({ status: 'cancelling', ...fresh }), [], NOW)).toBe('safely_resumable');
    expect(classifyAttemptRecovery(attempt({ status: 'validating' }), [], NOW)).toBe('requires_reconciliation');
  });

  it('classifies blocked with a pending approval as awaiting_human_approval, otherwise requires_reconciliation', () => {
    expect(classifyAttemptRecovery(attempt({ status: 'blocked' }), [approval({ status: 'pending' })], NOW)).toBe('awaiting_human_approval');
    expect(classifyAttemptRecovery(attempt({ status: 'blocked' }), [], NOW)).toBe('requires_reconciliation');
  });

  it('classifies recovery_required as requires_reconciliation', () => {
    expect(classifyAttemptRecovery(attempt({ status: 'recovery_required' }), [], NOW)).toBe('requires_reconciliation');
  });

  it('classifies paused with a fresh claim as safely_resumable, stale as requires_reconciliation', () => {
    expect(
      classifyAttemptRecovery(attempt({ status: 'paused', claimOwner: 'a', claimExpiresAt: '2026-01-01T00:20:00.000Z' }), [], NOW),
    ).toBe('safely_resumable');
    expect(classifyAttemptRecovery(attempt({ status: 'paused' }), [], NOW)).toBe('requires_reconciliation');
  });
});
