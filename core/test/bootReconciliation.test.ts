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

  it('leaves it alone when its owner is still alive or is this process', () => {
    const alive = waitingOnApproval('core:executor:4243');
    expect(failDeadExecutorAttemptsOnBoot(db, { selfPid: 1, isProcessAlive: () => true })).toEqual([]);
    expect(getApproval(db, alive.approvalId).status).toBe('pending');
    const self = waitingOnApproval('core:executor:7');
    expect(failDeadExecutorAttemptsOnBoot(db, { selfPid: 7, isProcessAlive: (pid) => pid === 4243 })).toEqual([]);
    expect(getApproval(db, self.approvalId).status).toBe('pending');
  });
});
