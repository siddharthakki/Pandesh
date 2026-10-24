import type { CoreDatabase } from '../db/connection';
import type {
  ApprovalKind,
  ApprovalRecord,
  AttemptContextRecord,
  AttemptRecord,
  AttemptStatus,
  KarkeDikhaValidationEvidence,
  KarkeDikhaValidationResult,
  ExecutionQualityEvidenceInput,
  RuntimeEventRecord,
} from '../shared/wireTypes';
export type { KarkeDikhaValidationEvidence, KarkeDikhaValidationResult } from '../shared/wireTypes';
import { createApproval, resolveApproval, type ResolveApprovalInput } from './approvals';
import {
  confirmAttemptCancelled,
  failAttempt,
  getAttempt,
  requestCancelAttempt,
  transitionAttempt,
} from './attempts';
import { getAttemptContext } from './attemptContext';
import { isTerminalAttemptStatus } from './attemptTransitions';
import { createCheckpoint } from './checkpoints';
import { CoreError } from './errors';
import { acquireFence, assertFence, type FenceHandle } from './fence';
import { recordExecutionQuality } from './executionQuality';

const DEFAULT_LEASE_MS = 120_000;
const MAX_LEASE_MS = 10 * 60_000;

export interface KarkeDikhaWorkerCredentials {
  fenceToken: string;
  owner: string;
  frozenContextHash: string;
}

export interface KarkeDikhaClaimResult {
  attempt: AttemptRecord;
  context: AttemptContextRecord;
  fence: FenceHandle & { expiresAt: string };
}

export interface KarkeDikhaGateResult {
  attempt: AttemptRecord;
  approval: ApprovalRecord;
}

function requireKarkeDikhaAttempt(db: CoreDatabase, attemptId: string): AttemptRecord {
  const attempt = getAttempt(db, attemptId);
  if (attempt.kind !== 'karke_dikha') {
    throw new CoreError('invalid_request', `attempt '${attemptId}' is not a Karke Dikha attempt`);
  }
  return attempt;
}

function boundedLeaseMs(value: number | undefined): number {
  const leaseMs = value ?? DEFAULT_LEASE_MS;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0 || leaseMs > MAX_LEASE_MS) {
    throw new CoreError('invalid_request', `leaseMs must be between 1 and ${MAX_LEASE_MS}`);
  }
  return leaseMs;
}

function assertWorker(
  db: CoreDatabase,
  attemptId: string,
  credentials: KarkeDikhaWorkerCredentials,
  options: { allowTerminal?: AttemptStatus } = {},
): AttemptRecord {
  const attempt = requireKarkeDikhaAttempt(db, attemptId);
  if (isTerminalAttemptStatus(attempt.status)) {
    if (options.allowTerminal === attempt.status) return attempt;
    throw new CoreError('invalid_transition', `attempt '${attemptId}' is terminal (${attempt.status})`);
  }
  assertFence(db, attemptId, credentials.fenceToken);
  if (attempt.claimOwner !== credentials.owner) {
    throw new CoreError('fence_stale', `attempt '${attemptId}' is owned by another worker`);
  }
  if (!attempt.claimExpiresAt || Date.parse(attempt.claimExpiresAt) <= Date.now()) {
    throw new CoreError('fence_stale', `attempt '${attemptId}' worker lease has expired`);
  }
  const context = getAttemptContext(db, attemptId);
  if (context.contextHash !== credentials.frozenContextHash) {
    throw new CoreError('context_mismatch', `attempt '${attemptId}' worker context does not match the frozen context`);
  }
  return attempt;
}

export function claimKarkeDikhaAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: { owner: string; leaseMs?: number; actor: string; clientId?: string | null },
): KarkeDikhaClaimResult {
  return db.transaction(() => {
    const attempt = requireKarkeDikhaAttempt(db, attemptId);
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new CoreError('invalid_transition', `attempt '${attemptId}' is terminal (${attempt.status})`);
    }
    if (attempt.fenceToken && attempt.claimExpiresAt && Date.parse(attempt.claimExpiresAt) > Date.now()) {
      throw new CoreError('conflict', `attempt '${attemptId}' already has an active worker lease`);
    }
    const pendingApproval = attempt.status === 'waiting_for_approval'
      ? db.get<{ id: string }>(`SELECT id FROM approvals WHERE attemptId = ? AND status = 'pending' LIMIT 1`, [attemptId])
      : undefined;
    if (
      attempt.status !== 'created' &&
      attempt.status !== 'queued' &&
      attempt.status !== 'recovery_required' &&
      attempt.status !== 'blocked' &&
      !(attempt.status === 'waiting_for_approval' && pendingApproval)
    ) {
      throw new CoreError('invalid_transition', `attempt '${attemptId}' cannot be claimed from '${attempt.status}'`);
    }
    const context = getAttemptContext(db, attemptId);
    if (context.resolvedMode !== 'karke_dikha' || !context.workspaceRoot || !context.permittedCapabilities.gitCapable) {
      throw new CoreError('context_mismatch', `attempt '${attemptId}' has no executable Karke Dikha frozen context`);
    }
    const leaseMs = boundedLeaseMs(input.leaseMs);
    const fence = acquireFence(db, attemptId, {
      ...input,
      leaseMs,
      preserveLifecycleRevision: attempt.status === 'waiting_for_approval',
    });
    const claimed = attempt.status === 'waiting_for_approval'
      ? getAttempt(db, attemptId)
      : transitionAttempt(db, attemptId, {
          toStatus: 'running',
          fenceToken: fence.token,
          actor: input.actor,
          clientId: input.clientId,
          reason: 'karke_dikha_worker_claimed',
        });
    return {
      attempt: claimed,
      context,
      fence: { ...fence, expiresAt: getAttempt(db, attemptId).claimExpiresAt! },
    };
  });
}

export function renewKarkeDikhaLease(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & { leaseMs?: number },
): AttemptRecord {
  return db.transaction(() => {
    assertWorker(db, attemptId, input);
    const expiresAt = new Date(Date.now() + boundedLeaseMs(input.leaseMs)).toISOString();
    db.run('UPDATE attempts SET claimExpiresAt = ?, updatedAt = ? WHERE id = ?', [expiresAt, new Date().toISOString(), attemptId]);
    return getAttempt(db, attemptId);
  });
}

export function recordKarkeDikhaExecutionQuality(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & ExecutionQualityEvidenceInput & {
    actor: string;
    clientId?: string | null;
    idempotencyKey?: string | null;
  },
): RuntimeEventRecord {
  return db.transaction(() => {
    assertWorker(db, attemptId, input);
    return recordExecutionQuality(db, attemptId, {
      eventType: input.eventType,
      metadata: input.metadata,
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
    });
  });
}

function requireStatus(attempt: AttemptRecord, expected: AttemptStatus, operation: string): void {
  if (attempt.status !== expected) {
    throw new CoreError('invalid_transition', `${operation} requires '${expected}', got '${attempt.status}'`);
  }
}

export function requestKarkeDikhaApproval(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & {
    kind: Exclude<ApprovalKind, 'delivery'>;
    summary: Record<string, unknown>;
    actor: string;
    clientId?: string | null;
  },
): KarkeDikhaGateResult {
  return db.transaction(() => {
    const attempt = assertWorker(db, attemptId, input);
    requireStatus(attempt, 'running', `${input.kind} approval request`);
    if (input.kind === 'mutation') {
      const approvedProposal = db.get(
        `SELECT id FROM approvals WHERE attemptId = ? AND kind = 'proposal' AND status = 'approved' LIMIT 1`,
        [attemptId],
      );
      if (!approvedProposal) throw new CoreError('invalid_transition', 'mutation approval requires an approved proposal');
    }
    const waiting = transitionAttempt(db, attemptId, {
      toStatus: 'waiting_for_approval',
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
      reason: `${input.kind}_approval_requested`,
    });
    const approval = createApproval(db, {
      attemptId,
      kind: input.kind,
      summary: input.summary,
      actor: input.actor,
      clientId: input.clientId,
    });
    return { attempt: waiting, approval };
  });
}

export function resolveKarkeDikhaApproval(
  db: CoreDatabase,
  approvalId: string,
  input: KarkeDikhaWorkerCredentials & ResolveApprovalInput & { disposition?: 'cancel' | 'revise' },
): KarkeDikhaGateResult {
  return db.transaction(() => {
    const attempt = assertWorker(db, input.attemptId, input);
    requireStatus(attempt, 'waiting_for_approval', `${input.gate} approval resolution`);
    const approval = resolveApproval(db, approvalId, input);
    let next: AttemptRecord;
    // Scope-changing steering invalidates any stale gate without cancelling
    // the same durable task. The rejected approval remains auditable, while
    // the attempt returns to running so a revised proposal/validation result
    // must earn fresh approval.
    if (input.resolution === 'approved' || input.disposition === 'revise') {
      next = transitionAttempt(db, input.attemptId, {
        toStatus: 'running',
        fenceToken: input.fenceToken,
        actor: input.actor,
        clientId: input.clientId,
        reason: input.disposition === 'revise' ? 'proposal_revision_requested' : `${input.gate}_approved`,
      });
    } else {
      const cancelling = transitionAttempt(db, input.attemptId, {
        toStatus: 'cancelling',
        fenceToken: input.fenceToken,
        actor: input.actor,
        clientId: input.clientId,
        reason: `${input.gate}_rejected`,
      });
      next = confirmAttemptCancelled(db, cancelling.id, {
        fenceToken: input.fenceToken,
        actor: input.actor,
        clientId: input.clientId,
      });
    }
    return { attempt: next, approval };
  });
}

export function beginKarkeDikhaValidation(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & { actor: string; clientId?: string | null },
): AttemptRecord {
  return db.transaction(() => {
    const attempt = assertWorker(db, attemptId, input);
    requireStatus(attempt, 'running', 'validation');
    return transitionAttempt(db, attemptId, {
      toStatus: 'validating',
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
      reason: 'validation_started',
    });
  });
}

function validationPassed(evidence: KarkeDikhaValidationEvidence): boolean {
  return evidence.commands.every((command) => command.exitCode === 0 && !command.timedOut)
    && evidence.qualityGateStatus === 'passed'
    && (evidence.diffReviewVerdict === 'pass' || evidence.diffReviewVerdict === 'skipped');
}

export function reportKarkeDikhaValidation(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & {
    evidence: KarkeDikhaValidationEvidence;
    actor: string;
    clientId?: string | null;
  },
): KarkeDikhaValidationResult {
  return db.transaction(() => {
    const attempt = assertWorker(db, attemptId, input);
    requireStatus(attempt, 'validating', 'validation result');
    createCheckpoint(db, {
      attemptId,
      kind: 'karke_dikha_validation',
      metadata: { ...input.evidence },
      actor: input.actor,
      clientId: input.clientId,
    });
    if (!validationPassed(input.evidence)) {
      return {
        outcome: 'failed',
        attempt: failAttempt(db, attemptId, {
          failureReason: 'validation_or_quality_gate_failed',
          fenceToken: input.fenceToken,
          actor: input.actor,
          clientId: input.clientId,
        }),
      };
    }
    const waiting = transitionAttempt(db, attemptId, {
      toStatus: 'waiting_for_approval',
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
      reason: 'delivery_approval_requested',
    });
    const approval = createApproval(db, {
      attemptId,
      kind: 'delivery',
      summary: {
        validationCommandCount: input.evidence.commands.length,
        qualityGateStatus: input.evidence.qualityGateStatus,
        diffReviewVerdict: input.evidence.diffReviewVerdict,
      },
      actor: input.actor,
      clientId: input.clientId,
    });
    return { outcome: 'waiting_for_delivery_approval', attempt: waiting, approval };
  });
}

export function completeKarkeDikhaAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & { actor: string; clientId?: string | null; summary?: Record<string, unknown> },
): AttemptRecord {
  return db.transaction(() => {
    const existing = requireKarkeDikhaAttempt(db, attemptId);
    if (existing.status === 'completed') return existing;
    const attempt = assertWorker(db, attemptId, input);
    requireStatus(attempt, 'running', 'completion');
    if (input.summary) {
      createCheckpoint(db, { attemptId, kind: 'karke_dikha_delivery', metadata: input.summary, actor: input.actor, clientId: input.clientId });
    }
    return transitionAttempt(db, attemptId, {
      toStatus: 'completed',
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
      reason: 'delivery_completed',
    });
  });
}

export function failKarkeDikhaAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & { actor: string; clientId?: string | null; failureReason: string },
): AttemptRecord {
  return db.transaction(() => {
    const existing = requireKarkeDikhaAttempt(db, attemptId);
    if (existing.status === 'failed') return existing;
    assertWorker(db, attemptId, input);
    return failAttempt(db, attemptId, {
      failureReason: input.failureReason,
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
    });
  });
}

export function cancelKarkeDikhaAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: KarkeDikhaWorkerCredentials & { actor: string; clientId?: string | null },
): AttemptRecord {
  return db.transaction(() => {
    const existing = requireKarkeDikhaAttempt(db, attemptId);
    if (existing.status === 'cancelled') return existing;
    assertWorker(db, attemptId, input);
    requestCancelAttempt(db, attemptId, { actor: input.actor, clientId: input.clientId });
    return confirmAttemptCancelled(db, attemptId, {
      fenceToken: input.fenceToken,
      actor: input.actor,
      clientId: input.clientId,
    });
  });
}
