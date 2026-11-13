import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { failDeadExecutorAttemptsOnBoot, scanOrphanedAttemptsOnBoot } from '../domain/bootReconciliation';
import { createApproval, getApproval } from '../domain/approvals';
import { acquireFence } from '../domain/fence';
import { transitionAttempt } from '../domain/attempts';
import { loadLoopContinuation, saveLoopContinuation } from '../domain/attemptLoopContinuation';
import { claimKarkeDikhaAttempt } from '../domain/karkeDikhaLifecycle';
import { submitRequest } from '../domain/submission';

let dir: string;
let db: CoreDatabase;
const workspace = path.join(os.tmpdir(), 'boot-reconciliation-workspace');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-reconciliation-core-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(mode: 'baat_kar' | 'saath_kar' | 'karke_dikha', message: string) {
  return submitRequest(db, {
    clientId: 'boot-reconciliation-test',
    currentMessage: message,
    requestedMode: mode,
    workspaceRoot: workspace,
    requestedProvider: 'ollama',
    requestedModel: 'test-model',
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `corr-${message}`,
  });
}

describe('scanOrphanedAttemptsOnBoot', () => {
  it('finds nothing when there are no attempts at all', () => {
    const summary = scanOrphanedAttemptsOnBoot(db);
    expect(summary.scanned).toBe(0);
    expect(summary.orphaned).toEqual([]);
  });

  it('never mutates attempt state — it is a pure read', () => {
    const { attempt } = submit('saath_kar', 'running with no claim');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
    const before = db.get<{ status: string }>('SELECT status FROM attempts WHERE id = ?', [attempt.id]);
    scanOrphanedAttemptsOnBoot(db);
    const after = db.get<{ status: string }>('SELECT status FROM attempts WHERE id = ?', [attempt.id]);
    expect(after).toEqual(before);
  });

  it('flags a running attempt with no claim (or an expired one) as orphaned, requiring reconciliation', () => {
    const { attempt } = submit('karke_dikha', 'crashed mid-run');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
    const summary = scanOrphanedAttemptsOnBoot(db);
    expect(summary.scanned).toBe(1);
    expect(summary.byClassification.requires_reconciliation).toBe(1);
    expect(summary.orphaned).toEqual([{ attemptId: attempt.id, status: 'running' }]);
  });

  it('does not flag a running attempt whose worker still holds a valid, unexpired claim', () => {
    const { attempt } = submit('karke_dikha', 'still live');
    claimKarkeDikhaAttempt(db, attempt.id, { owner: 'live-worker', actor: 'test', leaseMs: 120_000 });
    const summary = scanOrphanedAttemptsOnBoot(db);
    expect(summary.scanned).toBe(1);
    expect(summary.byClassification.safely_resumable).toBe(1);
    expect(summary.orphaned).toEqual([]);
  });

  it('excludes terminal attempts from the scan entirely', () => {
    const { attempt } = submit('saath_kar', 'finished cleanly');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, attempt.id, { toStatus: 'completed', actor: 'test' });
    const summary = scanOrphanedAttemptsOnBoot(db);
    expect(summary.scanned).toBe(0);
    expect(summary.orphaned).toEqual([]);
  });
});

describe('failDeadExecutorAttemptsOnBoot: a chat approval whose waiting worker died', () => {
  function waitingOnApproval(owner: string) {
    const { attempt } = submit('baat_kar', `waiting ${owner}`);
    const fence = acquireFence(db, attempt.id, { owner, actor: 'test', leaseMs: 120_000 });
    transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
    transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', fenceToken: fence.token, actor: 'test' });
    const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', summary: { toolName: 'run_checks' }, presentation: { cardText: 'del x' }, actor: 'test' });
    return { attemptId: attempt.id, approvalId: approval.id };
  }

  it('retires the approval as expired and settles the task truthfully instead of leaving a card that cannot work', () => {
    const { attemptId, approvalId } = waitingOnApproval('core:executor:4242');
    const settled = failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false });
    expect(settled).toEqual([{ attemptId, status: 'waiting_for_approval', outcome: 'failed' }]);
    expect(getApproval(db, approvalId).status).toBe('expired');
    const row = db.get<{ status: string; failureReason: string }>('SELECT status, failureReason FROM attempts WHERE id = ?', [attemptId]);
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toMatch(/Nothing was approved, rejected or run/);
  });

  // Build 161 audit: production held attempts parked in waiting_for_approval for weeks whose approvals were all
  // answered or expired while the waiting worker was gone. With no pending approval left the walk skipped them, so
  // they could never end. They are settled now, truthfully: nothing more ran.
  it('settles a dead worker\'s attempt still waiting although no approval is pending any more', () => {
    const { attemptId, approvalId } = waitingOnApproval('core:executor:4250');
    db.run("UPDATE approvals SET status = 'expired', resolvedAt = ? WHERE id = ?", [new Date().toISOString(), approvalId]);
    const settled = failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false });
    expect(settled).toEqual([{ attemptId, status: 'waiting_for_approval', outcome: 'failed' }]);
    const row = db.get<{ status: string; failureReason: string }>('SELECT status, failureReason FROM attempts WHERE id = ?', [attemptId]);
    expect(row?.status).toBe('failed');
    expect(row?.failureReason).toMatch(/no approval was pending any more/);
    expect(getApproval(db, approvalId).status).toBe('expired');
  });

  it('leaves it alone when its owner is still alive or is this process', () => {
    const alive = waitingOnApproval('core:executor:4243');
    expect(failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => true })).toEqual([]);
    expect(getApproval(db, alive.approvalId).status).toBe('pending');
    const self = waitingOnApproval('core:executor:7');
    expect(failDeadExecutorAttemptsOnBoot(db, { selfPid: 7, isProcessAlive: (pid) => pid === 4243 })).toEqual([]);
    expect(getApproval(db, self.approvalId).status).toBe('pending');
  });
});

// Build 161 audit (rehearsal on a copy of production): a Saath loop parked on a governed approval was skipped at boot
// whatever that approval's state. Its card had been superseded in September, so the attempt stayed "waiting for
// approval" with nothing to approve. Only an answer that can still come keeps it waiting now.
describe('failDeadExecutorAttemptsOnBoot: a Saath loop parked on an approval', () => {
  function parkedOn(approvalStatus: 'pending' | 'superseded' | 'missing', owner: string) {
    const { attempt } = submit('saath_kar', `parked ${owner}`);
    const fence = acquireFence(db, attempt.id, { owner, actor: 'test', leaseMs: 120_000 });
    transitionAttempt(db, attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
    transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', fenceToken: fence.token, actor: 'test' });
    // The card lives on the conversation's capability anchor, another attempt.
    const anchor = submit('saath_kar', `anchor ${owner}`).attempt;
    let cardId = 'appr_missing_' + owner.replace(/W/g, '');
    if (approvalStatus !== 'missing') {
      cardId = createApproval(db, { attemptId: anchor.id, kind: 'mutation', summary: { toolName: 'write_file' }, presentation: { cardText: 'write' }, actor: 'test' }).id;
      if (approvalStatus === 'superseded') db.run("UPDATE approvals SET status = 'superseded', resolvedAt = ? WHERE id = ?", [new Date().toISOString(), cardId]);
    }
    saveLoopContinuation(db, attempt.id, {
      state: 'awaiting_capability_approval', provider: 'ollama', model: 'test-model', turnIndex: 1, baseMessageSeq: 0,
      payload: { deltaMessages: [], priorOperations: [], pendingCall: null, remainingCalls: [] } as never,
      pendingApprovalId: cardId, requestedActionDigest: 'digest', frozenContextHash: 'ctx',
    });
    return attempt.id;
  }

  it('settles it when the awaited approval was superseded or no longer exists, and closes its continuation', () => {
    const superseded = parkedOn('superseded', 'core:executor:4270');
    const missing = parkedOn('missing', 'core:executor:4271');
    const settled = failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false });
    expect(settled.map((s) => s.attemptId).sort()).toEqual([superseded, missing].sort());
    for (const id of [superseded, missing]) {
      const row = db.get<{ status: string; failureReason: string }>('SELECT status, failureReason FROM attempts WHERE id = ?', [id]);
      expect(row?.status).toBe('failed');
      expect(row?.failureReason).toMatch(/Nothing further was run/);
      expect(loadLoopContinuation(db, id)).toBeUndefined();
    }
  });

  it('keeps it waiting while the awaited approval can still be answered', () => {
    const waiting = parkedOn('pending', 'core:executor:4272');
    expect(failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false })).toEqual([]);
    expect(db.get<{ status: string }>('SELECT status FROM attempts WHERE id = ?', [waiting])?.status).toBe('waiting_for_approval');
    expect(loadLoopContinuation(db, waiting)?.pendingApprovalId).toBeTruthy();
  });
});

describe('failDeadExecutorAttemptsOnBoot: a scheduled routine cut short by a restart', () => {
  function runningAs(clientId: string, owner: string) {
    const r = submitRequest(db, { clientId, currentMessage: `[Scheduled task "Daily report"] write it ${owner}`, requestedMode: 'saath_kar', workspaceRoot: workspace, requestedProvider: 'ollama', requestedModel: 'test-model', capability: { hasWorkspace: true, gitCapable: false }, correlationId: `corr-${owner}` });
    const fence = acquireFence(db, r.attempt.id, { owner, actor: 'test', leaseMs: 120_000 });
    transitionAttempt(db, r.attempt.id, { toStatus: 'running', fenceToken: fence.token, actor: 'test' });
    return r.attempt.id;
  }
  it('tells the owner once (the routine\'s finish-hook died with the process); an ordinary task does not notify', () => {
    const routine = runningAs('core:scheduler', 'core:executor:5001');
    const ordinary = runningAs('desktop', 'core:executor:5002');
    failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false });
    failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => false }); // idempotent
    const rows = db.all<{ sourceId: string; kind: string; body: string }>('SELECT sourceId, kind, body FROM notification_outbox');
    expect(rows.map((r) => r.sourceId)).toEqual([`sched-run:${routine}`]);
    expect(rows[0].kind).toBe('task_failed');
    expect(rows[0].body).toMatch(/Daily report/);
    expect(rows.some((r) => r.sourceId.includes(ordinary))).toBe(false);
  });
});
