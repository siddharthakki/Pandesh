import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createRequest } from '../domain/requests';
import { createAttempt, failAttempt, getAttempt, requestCancelAttempt, confirmAttemptCancelled, transitionAttempt } from '../domain/attempts';
import { createConversation } from '../domain/conversations';
import { ensureCapabilityAttempt, listCapabilityActions, settleCapabilityAttempt } from '../domain/capabilityDispatch';
import { CoreError } from '../domain/errors';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { executeMissionAction } from '../runtime/missionLoop';
import { formatObservation } from '../runtime/missionObservations';
import type { MissionEvidence } from '../runtime/missionObservations';
import type { MissionEnvelope } from '../runtime/scopedCommand';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-capability-bookkeeping-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A running attempt standing in for a mission that owns an anchor. */
function ownerAttempt(): string {
  const request = createRequest(db, {
    clientId: 'client-1',
    currentMessage: 'fix the failing focused check',
    requestedMode: 'saath_kar',
    resolvedMode: 'saath_kar',
    routeReason: 'mission',
    contextPolicy: {
      includeConversationHistory: false,
      includeProjectContext: false,
      includeRepositoryContext: false,
      includeGlobalStoryContext: false,
    },
    correlationId: `corr-${Math.random().toString(36).slice(2)}`,
  });
  const attempt = createAttempt(db, { requestId: request.id, kind: 'saath_kar', actor: 'core', clientId: 'client-1' });
  transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'core' });
  return attempt.id;
}

function anchorFor(ownerAttemptId: string): string {
  return ensureCapabilityAttempt(db, {
    correlationId: `mission:${ownerAttemptId}`,
    ownerAttemptId,
    actor: 'core',
    clientId: 'client-1',
  });
}

function attemptCount(): number {
  return db.all<{ id: string }>('SELECT id FROM attempts').length;
}

describe('a mission-owned capability attempt has durable parent linkage', () => {
  it('records the owning attempt and is reused idempotently across a restart', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    expect(getAttempt(db, anchor).parentAttemptId).toBe(owner);
    expect(getAttempt(db, anchor).status).toBe('running');

    // A resumed mission asks again with the same correlationId: same anchor,
    // no second attempt, no second idempotency row.
    const before = attemptCount();
    expect(anchorFor(owner)).toBe(anchor);
    expect(attemptCount()).toBe(before);
  });

  it('leaves a shared anchor with no owner unlinked and unsettled', () => {
    const shared = ensureCapabilityAttempt(db, {
      correlationId: 'forge-task-77',
      actor: 'core',
      clientId: 'client-1',
    });
    expect(getAttempt(db, shared).parentAttemptId).toBeNull();

    const owner = ownerAttempt();
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });
    expect(settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'completed', actor: 'core' })).toEqual([]);
    expect(getAttempt(db, shared).status).toBe('running');
  });

  it('still discovers an owned anchor by the conversation the caller knows', () => {
    const conversation = createConversation(db, { title: 'mission', mode: 'saath_kar', actor: 'client-1', clientId: 'client-1' });
    const request = createRequest(db, {
      clientId: 'client-1',
      currentMessage: 'fix the failing focused check',
      requestedMode: 'saath_kar',
      resolvedMode: 'saath_kar',
      routeReason: 'mission',
      contextPolicy: {
        includeConversationHistory: false,
        includeProjectContext: false,
        includeRepositoryContext: false,
        includeGlobalStoryContext: false,
      },
      correlationId: 'corr-conversation',
      conversationId: conversation.id,
    });
    const owner = createAttempt(db, { requestId: request.id, kind: 'saath_kar', actor: 'core', clientId: 'client-1' });
    transitionAttempt(db, owner.id, { toStatus: 'running', actor: 'core' });
    const anchor = anchorFor(owner.id);

    // The caller asks by conversation id, not by the mission-scoped key the
    // anchor is actually registered under.
    const snapshot = listCapabilityActions(db, { correlationId: conversation.id, clientId: 'client-1' });
    expect(snapshot.attemptId).toBe(anchor);
  });

  it('refuses to reject a parent that does not exist', () => {
    const request = createRequest(db, {
      clientId: 'client-1',
      currentMessage: 'orphan',
      requestedMode: 'saath_kar',
      resolvedMode: 'saath_kar',
      routeReason: 'mission',
      contextPolicy: {
        includeConversationHistory: false,
        includeProjectContext: false,
        includeRepositoryContext: false,
        includeGlobalStoryContext: false,
      },
      correlationId: 'corr-orphan',
    });
    expect(() => createAttempt(db, {
      requestId: request.id,
      kind: 'saath_kar',
      actor: 'core',
      parentAttemptId: 'att_missing',
    })).toThrow(CoreError);
  });
});

describe('a finished mission never leaves its capability attempt running', () => {
  it('completes the anchor when the mission completed', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });

    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'completed', actor: 'core' });
    const settled = getAttempt(db, anchor);
    expect(settled.status).toBe('completed');
    expect(settled.completedAt).not.toBeNull();
  });

  it('fails the anchor with the mission failure reason', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    failAttempt(db, owner, { failureReason: 'exceeded 20 minute mission wall clock', actor: 'core' });

    settleCapabilityAttempt(db, {
      ownerAttemptId: owner,
      outcome: 'failed',
      reason: 'exceeded 20 minute mission wall clock',
      actor: 'core',
    });
    const settled = getAttempt(db, anchor);
    expect(settled.status).toBe('failed');
    expect(settled.failureReason).toBe('exceeded 20 minute mission wall clock');
  });

  it('cancels the anchor when the mission was cancelled', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    requestCancelAttempt(db, owner, { actor: 'client-1' });

    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'cancelled', actor: 'core' });
    const settled = getAttempt(db, anchor);
    expect(settled.status).toBe('cancelled');
    expect(settled.cancelRequestedAt).not.toBeNull();
  });

  it('finishes an anchor already cancelling as cancelled, whatever the mission outcome was', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    requestCancelAttempt(db, anchor, { actor: 'client-1' });
    expect(getAttempt(db, anchor).status).toBe('cancelling');

    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'completed', actor: 'core' });
    expect(getAttempt(db, anchor).status).toBe('cancelled');
  });

  it('is idempotent, so a retried or restart-resumed settle changes nothing', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });

    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'completed', actor: 'core' });
    const first = getAttempt(db, anchor);
    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'failed', reason: 'late', actor: 'core' });
    const second = getAttempt(db, anchor);
    expect(second.status).toBe('completed');
    expect(second.revision).toBe(first.revision);
    expect(second.failureReason).toBeNull();
  });

  it('refuses to reopen a settled anchor, so a replayed dispatch cannot mutate twice', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });
    settleCapabilityAttempt(db, { ownerAttemptId: owner, outcome: 'completed', actor: 'core' });

    const before = attemptCount();
    expect(() => anchorFor(owner)).toThrow(/is completed; a settled anchor is never reopened/);
    // The refusal must not have minted a replacement anchor.
    expect(attemptCount()).toBe(before);
    expect(getAttempt(db, anchor).status).toBe('completed');
  });

  it('completing the owner settles its anchor without a separate settle call', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });
    expect(getAttempt(db, anchor).status).toBe('completed');
    expect(getAttempt(db, anchor).completedAt).not.toBeNull();
  });

  it('failing the owner settles its anchor with the same reason', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    failAttempt(db, owner, { failureReason: 'exceeded 20 minute mission wall clock', actor: 'core' });
    const settled = getAttempt(db, anchor);
    expect(settled.status).toBe('failed');
    expect(settled.failureReason).toBe('exceeded 20 minute mission wall clock');
  });

  it('requesting cancel on the owner marks the anchor cancelling, and confirming it settles the anchor', () => {
    const owner = ownerAttempt();
    const anchor = anchorFor(owner);
    requestCancelAttempt(db, owner, { actor: 'client-1' });
    expect(getAttempt(db, anchor).status).toBe('cancelling');
    expect(getAttempt(db, anchor).cancelRequestedAt).not.toBeNull();

    confirmAttemptCancelled(db, owner, { actor: 'client-1' });
    expect(getAttempt(db, owner).status).toBe('cancelled');
    expect(getAttempt(db, anchor).status).toBe('cancelled');
  });

  it('does not complete a shared anchor when an unrelated attempt finishes', () => {
    const shared = ensureCapabilityAttempt(db, {
      correlationId: 'forge-task-shared',
      actor: 'core',
      clientId: 'client-1',
    });
    const owner = ownerAttempt();
    transitionAttempt(db, owner, { toStatus: 'completed', actor: 'core' });
    failAttempt(db, ownerAttempt(), { failureReason: 'unrelated', actor: 'core' });
    expect(getAttempt(db, shared).status).toBe('running');
    expect(getAttempt(db, shared).parentAttemptId).toBeNull();
  });
});

function git(cwd: string, ...argv: string[]) {
  return spawnSync('git', argv, { cwd, encoding: 'utf8', windowsHide: true });
}

function makeRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-check-evidence-'));
  git(root, 'init', '--quiet', '--initial-branch=main');
  git(root, 'config', 'user.email', 'test@karkedikha.local');
  git(root, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 1;\n');
  git(root, 'add', '--', 'app.js');
  git(root, 'commit', '--quiet', '-m', 'base');
  fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 2;\n');
  return root;
}

function envelopeFor(root: string): MissionEnvelope {
  return {
    workspaceRoot: root,
    pushAuthorized: false,
    networkAuthorized: false,
    installAuthorized: false,
  } as MissionEnvelope;
}

function approvedEvidence(paths: string[]): MissionEvidence {
  return {
    approvedMutation: true,
    approvedPath: paths[paths.length - 1],
    approvedPaths: paths,
    validationPassed: true,
    validationCommand: 'npm run test',
    validationExitCode: 0,
    verificationRequired: false,
    diffReview: 'pending',
  };
}

function runCheck(check: 'test' | 'diff' | 'status' | 'commit', root: string, evidence: MissionEvidence) {
  return executeMissionAction({ action: { action: 'run_check', check }, envelope: envelopeFor(root), evidence });
}

describe('run_check records structured identity and results', () => {
  it('names diff review and the manifest it established, without reading any output', () => {
    const root = makeRepo();
    try {
      const reviewed = runCheck('diff', root, approvedEvidence(['app.js']));
      expect(reviewed.observation.check).toMatchObject({
        kind: 'diff_review',
        status: 'passed',
        reviewedPaths: ['app.js'],
      });
      expect(reviewed.observation.check?.reviewDigest).toMatch(/^sha256:/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names delivery and its commit SHA, matching the repository HEAD', () => {
    const root = makeRepo();
    try {
      const reviewed = runCheck('diff', root, approvedEvidence(['app.js']));
      const delivered = runCheck('commit', root, reviewed.evidence);
      const head = (git(root, 'rev-parse', 'HEAD').stdout || '').trim();
      expect(delivered.observation.check).toMatchObject({
        kind: 'commit',
        status: 'passed',
        commitSha: head,
        reviewedPaths: ['app.js'],
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a rejected review as rejected and establishes no deliverable manifest', () => {
    const root = makeRepo();
    try {
      const rejected = runCheck('diff', root, { ...approvedEvidence([]), approvedPath: undefined });
      expect(rejected.observation.check).toMatchObject({ kind: 'diff_review', status: 'rejected' });
      expect(rejected.observation.check?.reviewedPaths).toBeUndefined();
      expect(rejected.observation.check?.reviewDigest).toBeUndefined();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a commit refused for a missing gate as refused, not failed', () => {
    const root = makeRepo();
    try {
      const refused = runCheck('commit', root, { ...approvedEvidence(['app.js']), validationPassed: false });
      expect(refused.observation.check).toEqual({ kind: 'commit', status: 'refused' });
      expect(refused.observation.check?.commitSha).toBeUndefined();
      expect((git(root, 'rev-list', '--count', 'HEAD').stdout || '').trim()).toBe('1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a commit blocked by the staging gate as blocked, with no commit', () => {
    const root = makeRepo();
    try {
      // Reviewed, then edited again: the review digest no longer matches, so
      // staging must refuse. The delivery-manifest safety fix is unchanged.
      const reviewed = runCheck('diff', root, approvedEvidence(['app.js']));
      fs.writeFileSync(path.join(root, 'app.js'), 'export const value = 3;\n');
      const blocked = runCheck('commit', root, reviewed.evidence);
      expect(blocked.observation.check).toEqual({ kind: 'commit', status: 'blocked' });
      expect((git(root, 'rev-list', '--count', 'HEAD').stdout || '').trim()).toBe('1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('names focused validation with the command Core ran and its exit code', () => {
    const root = makeRepo();
    try {
      const validated = runCheck('test', root, approvedEvidence(['app.js']));
      expect(validated.observation.check?.kind).toBe('validation');
      expect(validated.observation.check?.command).toBeTruthy();
      expect(validated.observation.check?.status)
        .toBe(validated.observation.ok ? 'passed' : 'failed');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes check identity as data, so a stored observation is not prose', () => {
    const root = makeRepo();
    try {
      const reviewed = runCheck('diff', root, approvedEvidence(['app.js']));
      const stored = JSON.parse(formatObservation(reviewed.observation));
      expect(stored.check.kind).toBe('diff_review');
      expect(stored.check.status).toBe('passed');
      expect(stored.check.reviewedPaths).toEqual(['app.js']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps structured check identity on a truncated runtime-event notification', () => {
    const attemptId = ownerAttempt();
    const started = startToolInvocation(db, {
      attemptId,
      toolName: 'run_check',
      argsSummary: { check: { kind: 'commit', status: 'passed', commitSha: 'abc1234', reviewedPaths: ['app.js'] } },
      actor: 'core',
    });
    completeToolInvocation(db, started.id, {
      status: 'succeeded',
      exitCode: 0,
      evidence: {
        output: 'x'.repeat(5000),
        resultCategory: 'run_check',
        check: { kind: 'commit', status: 'passed', commitSha: 'abc1234', reviewedPaths: ['app.js'] },
      },
      actor: 'core',
    });
    const stored = db.get<{ evidence: string }>('SELECT evidence FROM tool_invocations WHERE id = ?', [started.id]);
    expect(JSON.parse(stored!.evidence).check).toEqual({
      kind: 'commit', status: 'passed', commitSha: 'abc1234', reviewedPaths: ['app.js'],
    });
    const event = db.get<{ metadata: string }>(
      "SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'tool_invocation_completed'",
      [started.id],
    );
    const metadata = JSON.parse(event!.metadata) as { evidence: { truncated?: boolean; check?: unknown } };
    expect(metadata.evidence.truncated).toBe(true);
    expect(metadata.evidence.check).toEqual({
      kind: 'commit', status: 'passed', commitSha: 'abc1234', reviewedPaths: ['app.js'],
    });
  });
});
