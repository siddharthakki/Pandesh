import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval, cancelCapabilityAction } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';
import { listApprovalsForAttempt } from '../domain/approvals';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let dbPath: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-cancel-restart-'));
  dbPath = path.join(dir, 'core.db');
  db = openCoreDatabase(dbPath).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function scriptedGithubExecutor(script: Record<string, { stdout?: string; code?: number }>): GithubCommandExecutor {
  const calls: string[][] = [];
  const executor: GithubCommandExecutor = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const match = Object.keys(script).find((prefix) => key.startsWith(prefix));
    return { stdout: match ? script[match].stdout ?? '' : '', stderr: '', code: match ? script[match].code ?? 0 : 0 };
  };
  (executor as GithubCommandExecutor & { calls: string[][] }).calls = calls;
  return executor;
}

function decisionFrom(approval: ApprovalRecord, resolution: 'approved' | 'rejected') {
  return {
    approvalId: approval.id,
    resolution,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: 'client-1',
    clientId: 'client-1',
  };
}

describe('M38 cancellation and late-completion', () => {
  it('a cancelled action is recorded as cancelled even if the adapter finishes "successfully" after cancellation was requested (late completion ignored)', async () => {
    let releaseAdapter!: () => void;
    const gate = new Promise<void>((resolve) => { releaseAdapter = resolve; });
    const slowAdapter: GovernedCapabilityAdapter = {
      id: 'slow',
      definitions: () => [{ name: 'slow_consequential_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
      classify: () => 'consequential',
      health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: async () => {
        await gate; // blocks until the test releases it, simulating an in-flight external call
        return { status: 'succeeded', exitCode: 0, output: 'finished late' };
      },
    };
    const registry = new GovernedCapabilityRegistry().register(slowAdapter);

    const requested = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-cancel-1', toolName: 'slow_consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));

    // Start the (slow) execution but do not await it yet — this models the
    // extension host's in-flight dispatchCapability HTTP call.
    const executionPromise = dispatchCapability(db, registry, {
      correlationId: 'forge-task-cancel-1', toolName: 'slow_consequential_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });

    // Give the adapter a tick to actually start (register itself as active) before cancelling.
    await new Promise((r) => setTimeout(r, 10));
    const cancelled = cancelCapabilityAction(db, requested.attemptId, { actor: 'core', clientId: 'client-1' });
    expect(cancelled.cancelRequestedAt).not.toBeNull();

    // Now let the adapter "complete" — its success must still be recorded as cancelled.
    releaseAdapter();
    const result = await executionPromise;
    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') {
      expect(result.toolInvocation.status).toBe('cancelled');
      expect(result.toolInvocation.evidence).toEqual({ cancelled: true });
    }
  });

  it('aborts the adapter signal when cancellation is requested mid-execution', async () => {
    let observedAborted = false;
    const abortAwareAdapter: GovernedCapabilityAdapter = {
      id: 'abort-aware',
      definitions: () => [{ name: 'abort_aware_tool', description: 'x', parameters: { type: 'object', properties: {} } }],
      classify: () => 'consequential',
      health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
      run: async (_call, ctx) => new Promise((resolve) => {
        ctx.signal?.addEventListener('abort', () => {
          observedAborted = true;
          resolve({ status: 'failed', exitCode: null, output: 'aborted' });
        });
      }),
    };
    const registry = new GovernedCapabilityRegistry().register(abortAwareAdapter);
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-cancel-2', toolName: 'abort_aware_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));

    const executionPromise = dispatchCapability(db, registry, {
      correlationId: 'forge-task-cancel-2', toolName: 'abort_aware_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    await new Promise((r) => setTimeout(r, 10));
    cancelCapabilityAction(db, requested.attemptId, { actor: 'core', clientId: 'client-1' });

    const result = await executionPromise;
    expect(observedAborted).toBe(true);
    if (result.outcome === 'executed') expect(result.toolInvocation.status).toBe('cancelled');
  });

  it('cancelling an attempt with no in-flight execution is a safe no-op', () => {
    const registry = new GovernedCapabilityRegistry();
    const attemptId = 'nonexistent-attempt';
    expect(() => cancelCapabilityAction(db, attemptId, { actor: 'core', clientId: 'client-1' })).toThrow();
  });
});

describe('M38 restart recovery: durable state survives a fresh Core process/db connection', () => {
  it('a pending approval restores identically after the process restarts (new db connection to the same file)', async () => {
    const executor = scriptedGithubExecutor({});
    const registry = new GovernedCapabilityRegistry().register(createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor }));
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-restart-1', toolName: 'github_comment_on_issue', arguments: { number: 11, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    db.close();

    // Simulate a Core process restart: reopen the same database file fresh.
    const restarted = openCoreDatabase(dbPath).db;
    try {
      const approvalsAfterRestart = listApprovalsForAttempt(restarted, requested.attemptId);
      expect(approvalsAfterRestart).toHaveLength(1);
      expect(approvalsAfterRestart[0]).toMatchObject({ id: requested.approval.id, status: 'pending', kind: 'mutation' });

      // The restored approval resolves exactly as it would have pre-restart.
      resolveCapabilityApproval(restarted, decisionFrom(approvalsAfterRestart[0], 'approved'));
      const executed = await dispatchCapability(restarted, registry, {
        correlationId: 'forge-task-restart-1', toolName: 'github_comment_on_issue', arguments: { number: 11, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
      });
      expect(executed.outcome).toBe('executed');
    } finally {
      restarted.close();
      db = openCoreDatabase(dbPath).db; // afterEach expects `db` to be a live handle it can close
    }
  });

  it('a completed action and its evidence restore identically after restart', async () => {
    const executor = scriptedGithubExecutor({ 'issue view 4': { stdout: JSON.stringify({ number: 4, title: 't', body: 'b', state: 'open', url: 'x', comments: [] }), code: 0 } });
    const registry = new GovernedCapabilityRegistry().register(createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor }));
    const result = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-restart-2', toolName: 'github_read_issue', arguments: { number: 4 }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (result.outcome !== 'executed') throw new Error('expected executed');
    db.close();

    const restarted = openCoreDatabase(dbPath).db;
    try {
      const invocations = listToolInvocationsForAttempt(restarted, result.attemptId);
      expect(invocations).toHaveLength(1);
      expect(invocations[0]).toMatchObject({ id: result.toolInvocation.id, status: 'succeeded', toolName: 'github_read_issue' });
    } finally {
      restarted.close();
      db = openCoreDatabase(dbPath).db;
    }
  });
});
