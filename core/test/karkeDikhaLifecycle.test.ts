import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ApprovalRecord } from '../shared/wireTypes';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { submitRequest } from '../domain/submission';
import { getAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import {
  beginKarkeDikhaValidation,
  cancelKarkeDikhaAttempt,
  claimKarkeDikhaAttempt,
  completeKarkeDikhaAttempt,
  failKarkeDikhaAttempt,
  reportKarkeDikhaValidation,
  requestKarkeDikhaApproval,
  resolveKarkeDikhaApproval,
  type KarkeDikhaWorkerCredentials,
} from '../domain/karkeDikhaLifecycle';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-core-owner-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(message = 'Implement the Core-owned lifecycle') {
  return submitRequest(db, {
    clientId: 'test-client',
    currentMessage: message,
    requestedMode: 'karke_dikha',
    workspaceRoot: 'C:\\work\\repo',
    requestedProvider: 'ollama',
    requestedModel: 'frozen-coder',
    toolPermissionPolicy: { profile: 'confirm-mutations' },
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `corr-${message}`,
  });
}

function claim(attemptId: string, owner = 'm15-worker-1') {
  const result = claimKarkeDikhaAttempt(db, attemptId, { owner, actor: 'core', leaseMs: 120_000 });
  const credentials: KarkeDikhaWorkerCredentials = {
    owner,
    fenceToken: result.fence.token,
    frozenContextHash: result.context.contextHash,
  };
  return { ...result, credentials };
}

function decision(approval: ApprovalRecord, credentials: KarkeDikhaWorkerCredentials, resolution: 'approved' | 'rejected' = 'approved') {
  return {
    ...credentials,
    resolution,
    attemptId: approval.attemptId,
    gate: approval.kind,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    expectedRevision: approval.revision,
    actor: 'core',
  } as const;
}

function requestGate(attemptId: string, credentials: KarkeDikhaWorkerCredentials, kind: 'proposal' | 'mutation') {
  return requestKarkeDikhaApproval(db, attemptId, {
    ...credentials,
    kind,
    summary: kind === 'proposal' ? { proposalId: 'proposal-v1' } : { requestId: 'mutation-v1' },
    actor: 'core',
  });
}

describe('Core-owned Karke Dikha lifecycle', () => {
  it('claims the one submitted attempt before work and binds execution to its frozen context and fence', () => {
    const { request, attempt } = submit();
    expect(attempt.status).toBe('created');

    const claimed = claim(attempt.id);
    expect(claimed.attempt.id).toBe(attempt.id);
    expect(claimed.attempt.requestId).toBe(request.id);
    expect(claimed.attempt.status).toBe('running');
    expect(claimed.context.attemptId).toBe(attempt.id);
    expect(claimed.context.taskInput).toBe('Implement the Core-owned lifecycle');
    expect(claimed.context.selectedModel).toBe('frozen-coder');
    expect(claimed.attempt.claimOwner).toBe('m15-worker-1');
    expect(claimed.attempt.fenceGeneration).toBe(1);
    expect(() => claim(attempt.id, 'm15-worker-2')).toThrowError(expect.objectContaining({ code: 'conflict' }));

    expect(() => requestGate(attempt.id, { ...claimed.credentials, fenceToken: 'stale' }, 'proposal'))
      .toThrowError(expect.objectContaining({ code: 'fence_stale' }));
    expect(() => requestGate(attempt.id, { ...claimed.credentials, frozenContextHash: '0'.repeat(64) }, 'proposal'))
      .toThrowError(expect.objectContaining({ code: 'context_mismatch' }));
  });

  it('makes proposal, mutation, validation, delivery and completion one Core-authoritative sequence', () => {
    const { attempt } = submit();
    const { credentials } = claim(attempt.id);

    const proposal = requestGate(attempt.id, credentials, 'proposal');
    expect(proposal.attempt.status).toBe('waiting_for_approval');
    expect(resolveKarkeDikhaApproval(db, proposal.approval.id, decision(proposal.approval, credentials)).attempt.status).toBe('running');

    const mutation = requestGate(attempt.id, credentials, 'mutation');
    expect(mutation.approval.kind).toBe('mutation');
    expect(resolveKarkeDikhaApproval(db, mutation.approval.id, decision(mutation.approval, credentials)).attempt.status).toBe('running');

    expect(beginKarkeDikhaValidation(db, attempt.id, { ...credentials, actor: 'core' }).status).toBe('validating');
    const validation = reportKarkeDikhaValidation(db, attempt.id, {
      ...credentials,
      actor: 'core',
      evidence: {
        commands: [{ command: 'npm test -- targeted', exitCode: 0, timedOut: false, durationMs: 25 }],
        qualityGateStatus: 'passed',
        diffReviewVerdict: 'pass',
      },
    });
    expect(validation.outcome).toBe('waiting_for_delivery_approval');
    if (validation.outcome !== 'waiting_for_delivery_approval') throw new Error('unexpected validation outcome');
    expect(validation.approval.kind).toBe('delivery');
    expect(resolveKarkeDikhaApproval(db, validation.approval.id, decision(validation.approval, credentials)).attempt.status).toBe('running');

    const completed = completeKarkeDikhaAttempt(db, attempt.id, { ...credentials, actor: 'core', summary: { commitSha: 'abc123' } });
    expect(completed.status).toBe('completed');
    const revision = completed.revision;
    expect(completeKarkeDikhaAttempt(db, attempt.id, { ...credentials, actor: 'core' }).revision).toBe(revision);
    expect(() => requestGate(attempt.id, credentials, 'proposal')).toThrowError(expect.objectContaining({ code: 'invalid_transition' }));
    expect(getAttempt(db, attempt.id).status).toBe('completed');
  });

  it('rejects stale, duplicate, wrong-gate, wrong-attempt and mismatched envelope decisions', () => {
    const first = submit('first').attempt;
    const second = submit('second').attempt;
    const firstClaim = claim(first.id, 'worker-first');
    const secondClaim = claim(second.id, 'worker-second');
    const gate = requestGate(first.id, firstClaim.credentials, 'proposal');

    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, { ...decision(gate.approval, firstClaim.credentials), gate: 'mutation' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, { ...decision(gate.approval, secondClaim.credentials), attemptId: second.id }))
      .toThrowError();
    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, { ...decision(gate.approval, firstClaim.credentials), requestedActionDigest: 'f'.repeat(64) }))
      .toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, { ...decision(gate.approval, firstClaim.credentials), expectedAttemptRevision: gate.approval.expectedAttemptRevision + 1 }))
      .toThrowError(expect.objectContaining({ code: 'revision_mismatch' }));

    resolveKarkeDikhaApproval(db, gate.approval.id, decision(gate.approval, firstClaim.credentials));
    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, decision(gate.approval, firstClaim.credentials)))
      .toThrowError();
  });

  it('invalidates stale mutation and delivery approvals for same-task steering without cancelling', () => {
    const { attempt } = submit();
    const { credentials } = claim(attempt.id);
    const proposal = requestGate(attempt.id, credentials, 'proposal');
    resolveKarkeDikhaApproval(db, proposal.approval.id, decision(proposal.approval, credentials));

    const mutation = requestGate(attempt.id, credentials, 'mutation');
    const revisedMutation = resolveKarkeDikhaApproval(db, mutation.approval.id, {
      ...decision(mutation.approval, credentials, 'rejected'),
      disposition: 'revise' as const,
    });
    expect(revisedMutation.attempt.status).toBe('running');
    expect(revisedMutation.approval.status).toBe('rejected');

    const replacementMutation = requestGate(attempt.id, credentials, 'mutation');
    resolveKarkeDikhaApproval(db, replacementMutation.approval.id, decision(replacementMutation.approval, credentials));
    beginKarkeDikhaValidation(db, attempt.id, { ...credentials, actor: 'core' });
    const validation = reportKarkeDikhaValidation(db, attempt.id, {
      ...credentials,
      actor: 'core',
      evidence: {
        commands: [],
        qualityGateStatus: 'passed',
        diffReviewVerdict: 'pass',
      },
    });
    if (validation.outcome !== 'waiting_for_delivery_approval') throw new Error('unexpected validation outcome');

    const revisedDelivery = resolveKarkeDikhaApproval(db, validation.approval.id, {
      ...decision(validation.approval, credentials, 'rejected'),
      disposition: 'revise' as const,
    });
    expect(revisedDelivery.attempt.status).toBe('running');
    expect(revisedDelivery.approval.status).toBe('rejected');
    expect(getAttempt(db, attempt.id).status).toBe('running');
  });

  it('lets Core fail validation exactly once and rejects delayed or superseded worker callbacks', () => {
    const { attempt } = submit();
    const current = claim(attempt.id);
    const proposal = requestGate(attempt.id, current.credentials, 'proposal');
    resolveKarkeDikhaApproval(db, proposal.approval.id, decision(proposal.approval, current.credentials));
    const mutation = requestGate(attempt.id, current.credentials, 'mutation');
    resolveKarkeDikhaApproval(db, mutation.approval.id, decision(mutation.approval, current.credentials));
    beginKarkeDikhaValidation(db, attempt.id, { ...current.credentials, actor: 'core' });

    const failed = reportKarkeDikhaValidation(db, attempt.id, {
      ...current.credentials,
      actor: 'core',
      evidence: {
        commands: [{ command: 'npm test', exitCode: 1, timedOut: false, durationMs: 10 }],
        qualityGateStatus: 'failed',
        diffReviewVerdict: 'skipped',
      },
    });
    expect(failed.outcome).toBe('failed');
    expect(getAttempt(db, attempt.id).status).toBe('failed');
    const terminalRevision = getAttempt(db, attempt.id).revision;
    expect(failKarkeDikhaAttempt(db, attempt.id, { ...current.credentials, actor: 'core', failureReason: 'duplicate' }).revision)
      .toBe(terminalRevision);
    expect(() => completeKarkeDikhaAttempt(db, attempt.id, { ...current.credentials, actor: 'core' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_transition' }));

    const other = submit('fence replacement').attempt;
    const original = claim(other.id, 'old-worker');
    acquireFence(db, other.id, { owner: 'replacement-worker', actor: 'core', leaseMs: 120_000 });
    expect(() => requestGate(other.id, original.credentials, 'proposal'))
      .toThrowError(expect.objectContaining({ code: 'fence_stale' }));
  });

  it('makes cancellation Core-authoritative and terminal once', () => {
    const { attempt } = submit();
    const { credentials } = claim(attempt.id);
    const cancelled = cancelKarkeDikhaAttempt(db, attempt.id, { ...credentials, actor: 'core' });
    expect(cancelled.status).toBe('cancelled');
    const revision = cancelled.revision;
    expect(cancelKarkeDikhaAttempt(db, attempt.id, { ...credentials, actor: 'core' }).revision).toBe(revision);
    expect(() => failKarkeDikhaAttempt(db, attempt.id, { ...credentials, actor: 'core', failureReason: 'late' }))
      .toThrowError(expect.objectContaining({ code: 'invalid_transition' }));
  });
});
