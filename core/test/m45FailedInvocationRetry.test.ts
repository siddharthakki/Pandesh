import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval } from '../domain/capabilityDispatch';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import { listApprovalsForAttempt } from '../domain/approvals';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm45-failed-retry-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const decide = (approval: ApprovalRecord) => ({
  approvalId: approval.id,
  resolution: 'approved' as const,
  attemptId: approval.attemptId,
  expectedAttemptRevision: approval.expectedAttemptRevision,
  expectedAttemptStatus: approval.expectedAttemptStatus,
  requestedActionDigest: approval.requestedActionDigest,
  frozenContextHash: approval.frozenContextHash,
  actor: 'client-1',
  clientId: 'client-1',
  idempotencyKey: `approve:${approval.id}`,
});

function harness(outcomes: Array<'succeeded' | 'failed'>) {
  const calls: number[] = [];
  const registry = new GovernedCapabilityRegistry().register({
    id: 'retry-test',
    definitions: () => [{ name: 'retry_write', description: 'test', parameters: { type: 'object', properties: { v: { type: 'string' } }, required: ['v'] } }],
    classify: () => 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call) => {
      calls.push(calls.length + 1);
      const status = outcomes[calls.length - 1] ?? 'succeeded';
      return { status, exitCode: status === 'succeeded' ? 0 : 1, output: status, resultCategory: `t_${status}`, normalizedArguments: call.arguments };
    },
  });
  const input = { correlationId: 'retry-corr', toolName: 'retry_write', arguments: { v: 'same' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1' };
  return { registry, input, calls };
}

describe('M45 failed invocation retry semantics', () => {
  it('an identical retry after a terminal failure gets a fresh approval and a fresh invocation', async () => {
    const { registry, input, calls } = harness(['failed', 'succeeded']);
    const first = await dispatchCapability(db, registry, input);
    if (first.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decide(first.approval));
    const failed = await dispatchCapability(db, registry, input);
    if (failed.outcome !== 'executed') throw new Error('expected executed');
    expect(failed.toolInvocation.status).toBe('failed');

    // The retry must NOT replay the failure and must NOT re-run on the old approval.
    const retry = await dispatchCapability(db, registry, input);
    expect(retry.outcome).toBe('approval_required');
    expect(calls).toHaveLength(1);
    if (retry.outcome !== 'approval_required') throw new Error('unreachable');
    expect(retry.approval.id).not.toBe(first.approval.id);

    // Asking again while that approval is pending does not stack a third one.
    const again = await dispatchCapability(db, registry, input);
    expect(again.outcome === 'approval_required' && again.approval.id).toBe(retry.approval.id);

    resolveCapabilityApproval(db, decide(retry.approval));
    const second = await dispatchCapability(db, registry, input);
    if (second.outcome !== 'executed') throw new Error('expected executed');
    expect(second.toolInvocation.status).toBe('succeeded');
    expect(second.toolInvocation.id).not.toBe(failed.toolInvocation.id);
    expect(second.toolInvocation.approvalId).toBe(retry.approval.id);
    expect(calls).toHaveLength(2);

    // And now that it succeeded, exactly-once replay resumes.
    const replay = await dispatchCapability(db, registry, input);
    expect(replay.outcome === 'executed' && replay.toolInvocation.id).toBe(second.toolInvocation.id);
    expect(calls).toHaveLength(2);
    expect(listToolInvocationsForAttempt(db, first.attemptId)).toHaveLength(2);
  });

  it('a succeeded invocation still replays exactly once', async () => {
    const { registry, input, calls } = harness(['succeeded']);
    const first = await dispatchCapability(db, registry, input);
    if (first.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decide(first.approval));
    const a = await dispatchCapability(db, registry, input);
    const b = await dispatchCapability(db, registry, input);
    expect(a.outcome === 'executed' && b.outcome === 'executed' && a.toolInvocation.id === b.toolInvocation.id).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('picks the newest matching approval deterministically when requestedAt ties', async () => {
    const { registry, input } = harness(['failed', 'succeeded']);
    const first = await dispatchCapability(db, registry, input);
    if (first.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decide(first.approval));
    await dispatchCapability(db, registry, input);
    const retry = await dispatchCapability(db, registry, input);
    if (retry.outcome !== 'approval_required') throw new Error('expected approval_required');
    // Force every approval onto the same millisecond.
    db.run('UPDATE approvals SET requestedAt = ? WHERE attemptId = ?', ['2026-01-01T00:00:00.000Z', first.attemptId]);
    const ids = listApprovalsForAttempt(db, first.attemptId).map((a) => a.id);
    expect(ids).toEqual([first.approval.id, retry.approval.id]);
    const again = await dispatchCapability(db, registry, input);
    expect(again.outcome === 'approval_required' && again.approval.id).toBe(retry.approval.id);
  });
});
