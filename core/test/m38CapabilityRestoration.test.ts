import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval, listCapabilityActions } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-capability-restoration-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function scriptedGithubExecutor(script: Record<string, { stdout?: string; stderr?: string; code?: number }>): GithubCommandExecutor {
  const calls: string[][] = [];
  const executor: GithubCommandExecutor = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const match = Object.keys(script).find((prefix) => key.startsWith(prefix));
    const scripted = match ? script[match] : undefined;
    return { stdout: scripted?.stdout ?? '', stderr: scripted?.stderr ?? '', code: scripted?.code ?? 0 };
  };
  (executor as GithubCommandExecutor & { calls: string[][] }).calls = calls;
  return executor;
}

function registryWithGithub(executor: GithubCommandExecutor): GovernedCapabilityRegistry {
  return new GovernedCapabilityRegistry().register(createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor }));
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

const CLIENT = 'client-1';

describe('M38 listCapabilityActions (webview/restart restoration)', () => {
  it('returns no attempt/actions for a correlationId that has never dispatched anything, and creates nothing', () => {
    const snapshot = listCapabilityActions(db, { correlationId: 'restore-task-never-seen', clientId: CLIENT });
    expect(snapshot).toEqual({ attemptId: null, actions: [] });
  });

  it('restores a pending approval as actionable with the exact original identifiers', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-1', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    const snapshot = listCapabilityActions(db, { correlationId: 'restore-task-1', clientId: CLIENT });
    expect(snapshot.attemptId).toBe(requested.attemptId);
    expect(snapshot.actions).toHaveLength(1);
    const [action] = snapshot.actions;
    expect(action.actionable).toBe(true);
    expect(action.approvalId).toBe(requested.approval.id);
    expect(action.attemptId).toBe(requested.attemptId);
    expect(action.requestedActionDigest).toBe(requested.approval.requestedActionDigest);
    expect(action.expectedAttemptRevision).toBe(requested.approval.expectedAttemptRevision);
    expect(action.toolName).toBe('github_comment_on_issue');
    expect(action.arguments).toEqual({ number: 5, body: 'Proposed fix.' });
    expect(action.outcome).toBe('pending');
  });

  it('restores an approved-then-executed approval as resolved/non-actionable with the succeeded outcome', async () => {
    const executor = scriptedGithubExecutor({
      'issue view 5 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }), code: 0 },
      'issue comment 5': { stdout: 'posted', code: 0 },
    });
    const registry = registryWithGithub(executor);
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-2', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-2', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    expect(executed.outcome).toBe('executed');

    const snapshot = listCapabilityActions(db, { correlationId: 'restore-task-2', clientId: CLIENT });
    expect(snapshot.actions).toHaveLength(1);
    const [action] = snapshot.actions;
    expect(action.actionable).toBe(false);
    expect(action.outcome).toBe('succeeded');
    expect(action.invocation?.status).toBe('succeeded');
  });

  it('restores a rejected approval as resolved/non-actionable, and stays resolved on a second restore query', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-3', toolName: 'github_comment_on_issue', arguments: { number: 9, body: 'Spam?' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'rejected'));

    const first = listCapabilityActions(db, { correlationId: 'restore-task-3', clientId: CLIENT });
    expect(first.actions).toHaveLength(1);
    expect(first.actions[0].actionable).toBe(false);
    expect(first.actions[0].outcome).toBe('rejected');

    const second = listCapabilityActions(db, { correlationId: 'restore-task-3', clientId: CLIENT });
    expect(second.actions).toHaveLength(1);
    expect(second.actions[0].actionable).toBe(false);
    expect(second.actions[0].outcome).toBe('rejected');
  });

  it('restores a cancelled/failed tool invocation as resolved/non-actionable with the correct outcome', async () => {
    const failingExecutor = scriptedGithubExecutor({
      'issue view 5 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }), code: 0 },
      'issue comment 5': { stdout: '', stderr: 'boom', code: 1 },
    });
    const registry = registryWithGithub(failingExecutor);
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-4', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'x' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-4', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'x' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    expect(executed.outcome).toBe('executed');
    if (executed.outcome === 'executed') expect(executed.toolInvocation.status).toBe('failed');

    const snapshot = listCapabilityActions(db, { correlationId: 'restore-task-4', clientId: CLIENT });
    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions[0].actionable).toBe(false);
    expect(snapshot.actions[0].outcome).toBe('failed');
    expect(snapshot.actions[0].invocation?.status).toBe('failed');
  });

  it('calling listCapabilityActions twice never creates a second attempt/approval row', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-5', toolName: 'github_comment_on_issue', arguments: { number: 1, body: 'A' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    const first = listCapabilityActions(db, { correlationId: 'restore-task-5', clientId: CLIENT });
    const second = listCapabilityActions(db, { correlationId: 'restore-task-5', clientId: CLIENT });
    expect(second.attemptId).toBe(first.attemptId);
    expect(second.actions[0].approvalId).toBe(first.actions[0].approvalId);

    const row = db.get<{ count: number }>('SELECT COUNT(*) as count FROM idempotency_keys WHERE key = ?', ['restore-task-5']);
    expect(row?.count).toBe(1);
  });

  it('resolving a restored approval with a stale digest/revision throws, exactly like a live resolveCapabilityApproval call', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'restore-task-6', toolName: 'github_comment_on_issue', arguments: { number: 1, body: 'A' }, cwd: process.cwd(), actor: 'core', clientId: CLIENT,
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    // Resolve it once for real — now it is no longer pending.
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));

    const snapshot = listCapabilityActions(db, { correlationId: 'restore-task-6', clientId: CLIENT });
    const [action] = snapshot.actions;
    // Simulate a restored card that captured the ORIGINAL (now-stale) envelope
    // fields attempting to resolve again with the same (now stale) values.
    expect(() =>
      resolveCapabilityApproval(db, {
        approvalId: action.approvalId,
        resolution: 'rejected',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
        actor: 'core',
        clientId: CLIENT,
      }),
    ).toThrow();
  });
});
