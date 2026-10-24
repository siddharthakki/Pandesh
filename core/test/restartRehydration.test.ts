import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { listWorkspaceAttemptRehydration } from '../domain/attemptRehydration';
import { getAttempt, transitionAttempt } from '../domain/attempts';
import {
  claimKarkeDikhaAttempt,
  requestKarkeDikhaApproval,
  resolveKarkeDikhaApproval,
  type KarkeDikhaWorkerCredentials,
} from '../domain/karkeDikhaLifecycle';
import { submitRequest } from '../domain/submission';

let dir: string;
let db: CoreDatabase;
const workspace = path.join(os.tmpdir(), 'm32-rehydrate-workspace');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm32-rehydrate-core-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(mode: 'baat_kar' | 'saath_kar' | 'karke_dikha', message: string, workspaceRoot = workspace) {
  return submitRequest(db, {
    clientId: 'restart-test',
    currentMessage: message,
    requestedMode: mode,
    workspaceRoot,
    requestedProvider: 'ollama',
    requestedModel: 'test-model',
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `corr-${message}`,
  });
}

function credentials(claim: ReturnType<typeof claimKarkeDikhaAttempt>): KarkeDikhaWorkerCredentials {
  return { owner: claim.fence.owner, fenceToken: claim.fence.token, frozenContextHash: claim.context.contextHash };
}

describe('Core restart rehydration snapshot', () => {
  it('returns the same active attempt identity with frozen context and only its durable event tail', () => {
    const relevant = submit('saath_kar', 'current active work');
    for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
      const historical = submit('saath_kar', `${terminal} history`);
      transitionAttempt(db, historical.attempt.id, { toStatus: 'running', actor: 'test' });
      if (terminal === 'completed') transitionAttempt(db, historical.attempt.id, { toStatus: 'completed', actor: 'test' });
      else if (terminal === 'failed') transitionAttempt(db, historical.attempt.id, { toStatus: 'failed', actor: 'test' });
      else {
        transitionAttempt(db, historical.attempt.id, { toStatus: 'cancelling', actor: 'test' });
        transitionAttempt(db, historical.attempt.id, { toStatus: 'cancelled', actor: 'test' });
      }
    }
    const unrelated = submit('karke_dikha', 'other workspace', path.join(os.tmpdir(), 'somewhere-else'));

    const beforeRequests = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM requests')!.count;
    const beforeAttempts = db.get<{ count: number }>('SELECT COUNT(*) AS count FROM attempts')!.count;
    const snapshot = listWorkspaceAttemptRehydration(db, workspace);

    expect(snapshot.attempts.map(item => item.attempt.id)).toEqual([relevant.attempt.id]);
    expect(snapshot.attempts[0].request.id).toBe(relevant.request.id);
    expect(snapshot.attempts[0].context.attemptId).toBe(relevant.attempt.id);
    expect(snapshot.attempts[0].events.every(event => event.entityId === relevant.attempt.id)).toBe(true);
    expect(snapshot.attempts[0].events.some(event => event.entityId === unrelated.attempt.id)).toBe(false);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM requests')!.count).toBe(beforeRequests);
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM attempts')!.count).toBe(beforeAttempts);
  });

  it('classifies an active valid lease as resumable without allowing a second worker claim', () => {
    const { attempt } = submit('karke_dikha', 'live worker');
    claimKarkeDikhaAttempt(db, attempt.id, { owner: 'live-worker', actor: 'test', leaseMs: 120_000 });

    const snapshot = listWorkspaceAttemptRehydration(db, workspace);
    expect(snapshot.attempts[0].recovery).toBe('safely_resumable');
    expect(() => claimKarkeDikhaAttempt(db, attempt.id, { owner: 'duplicate-worker', actor: 'test' }))
      .toThrowError(expect.objectContaining({ code: 'conflict' }));
    expect(getAttempt(db, attempt.id).fenceGeneration).toBe(1);
  });

  it('reclaims an expired approval lease only through a new Core fence while preserving the exact approval envelope', () => {
    const { attempt } = submit('karke_dikha', 'approval survives restart');
    const firstClaim = claimKarkeDikhaAttempt(db, attempt.id, { owner: 'old-worker', actor: 'test', leaseMs: 120_000 });
    const firstCredentials = credentials(firstClaim);
    const gate = requestKarkeDikhaApproval(db, attempt.id, {
      ...firstCredentials,
      kind: 'proposal',
      summary: { proposalId: 'proposal-original' },
      actor: 'test',
    });
    db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', attempt.id]);

    const reclaimed = claimKarkeDikhaAttempt(db, attempt.id, { owner: 'replacement-worker', actor: 'test', leaseMs: 120_000 });
    expect(reclaimed.attempt.status).toBe('waiting_for_approval');
    expect(reclaimed.fence.generation).toBe(2);
    const persisted = listWorkspaceAttemptRehydration(db, workspace).attempts[0].approvals[0];
    expect(persisted).toEqual(gate.approval);

    expect(() => resolveKarkeDikhaApproval(db, gate.approval.id, {
      ...firstCredentials,
      resolution: 'approved',
      attemptId: attempt.id,
      gate: 'proposal',
      expectedAttemptRevision: gate.approval.expectedAttemptRevision,
      expectedAttemptStatus: gate.approval.expectedAttemptStatus,
      requestedActionDigest: gate.approval.requestedActionDigest,
      expectedRevision: gate.approval.revision,
      actor: 'test',
    })).toThrowError(expect.objectContaining({ code: 'fence_stale' }));

    const replacementCredentials = credentials(reclaimed);
    const resolved = resolveKarkeDikhaApproval(db, gate.approval.id, {
      ...replacementCredentials,
      resolution: 'approved',
      attemptId: attempt.id,
      gate: 'proposal',
      expectedAttemptRevision: gate.approval.expectedAttemptRevision,
      expectedAttemptStatus: gate.approval.expectedAttemptStatus,
      requestedActionDigest: gate.approval.requestedActionDigest,
      expectedRevision: gate.approval.revision,
      actor: 'test',
    });
    expect(resolved.approval.id).toBe(gate.approval.id);
    expect(resolved.attempt.id).toBe(attempt.id);
  });

  it('classifies an expired in-flight lease explicitly as recovery-required instead of guessing', () => {
    const { attempt } = submit('karke_dikha', 'unsafe interrupted mutation');
    claimKarkeDikhaAttempt(db, attempt.id, { owner: 'dead-worker', actor: 'test', leaseMs: 120_000 });
    db.run('UPDATE attempts SET claimExpiresAt = ? WHERE id = ?', ['2000-01-01T00:00:00.000Z', attempt.id]);

    const record = listWorkspaceAttemptRehydration(db, workspace).attempts[0];
    expect(record.attempt.id).toBe(attempt.id);
    expect(record.recovery).toBe('requires_reconciliation');
    expect(record.attempt.status).toBe('running');
  });
});
