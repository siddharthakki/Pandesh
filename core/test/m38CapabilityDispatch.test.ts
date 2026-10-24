import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { dispatchCapability, resolveCapabilityApproval, ensureCapabilityAttempt } from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';
import type { ApprovalRecord } from '../shared/wireTypes';
import { listApprovalsForAttempt } from '../domain/approvals';
import { listToolInvocationsForAttempt } from '../domain/toolInvocations';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'm38-capability-dispatch-'));
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

describe('M38 dispatchCapability lifecycle', () => {
  it('executes a read-only call immediately without any approval', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({
      'issue view 1': { stdout: JSON.stringify({ number: 1, title: 't', body: 'b', state: 'open', url: 'x', comments: [] }), code: 0 },
    }));
    const result = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-1', toolName: 'github_read_issue', arguments: { number: 1 }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('executed');
    if (result.outcome === 'executed') expect(result.toolInvocation.status).toBe('succeeded');
    expect(listApprovalsForAttempt(db, result.attemptId)).toHaveLength(0);
  });

  it('reuses the same anchor attempt for repeated calls with the same correlationId', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const first = ensureCapabilityAttempt(db, { correlationId: 'forge-task-2', actor: 'core', clientId: 'client-1' });
    const second = ensureCapabilityAttempt(db, { correlationId: 'forge-task-2', actor: 'core', clientId: 'client-1' });
    expect(first).toBe(second);
  });

  it('requires approval for a consequential call and does not execute until approved', async () => {
    const executor = scriptedGithubExecutor({
      'issue view 5 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }), code: 0 },
      'issue comment 5': { stdout: 'posted', code: 0 },
    });
    const registry = registryWithGithub(executor);
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-3', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(requested.outcome).toBe('approval_required');
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls.length).toBe(0);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');

    // Retrying identical action before resolution returns the SAME pending approval, not a new one.
    const retried = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-3', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(retried.outcome).toBe('approval_required');
    if (retried.outcome === 'approval_required') expect(retried.approval.id).toBe(requested.approval.id);
    expect(listApprovalsForAttempt(db, requested.attemptId)).toHaveLength(1);

    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'approved'));
    const executed = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-3', toolName: 'github_comment_on_issue', arguments: { number: 5, body: 'Proposed fix.' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(executed.outcome).toBe('executed');
    if (executed.outcome === 'executed') expect(executed.toolInvocation.status).toBe('succeeded');
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls.filter((c) => c[0] === 'issue' && c[1] === 'comment')).toHaveLength(1);
  });

  it('a denied action stays denied on retry — no re-prompt, no execution, no bypass', async () => {
    const executor = scriptedGithubExecutor({});
    const registry = registryWithGithub(executor);
    const requested = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-4', toolName: 'github_comment_on_issue', arguments: { number: 9, body: 'Spam?' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'rejected'));

    const retried = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-4', toolName: 'github_comment_on_issue', arguments: { number: 9, body: 'Spam?' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(retried.outcome).toBe('denied');
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls.length).toBe(0);
    expect(listApprovalsForAttempt(db, requested.attemptId)).toHaveLength(1);
    expect(listToolInvocationsForAttempt(db, requested.attemptId)).toHaveLength(0);
  });

  it('keeps a denial sticky within one Saath attempt but permits a later explicit attempt to request the same action', async () => {
    const executor = scriptedGithubExecutor({});
    const registry = registryWithGithub(executor);
    const action = {
      correlationId: 'saath-conversation-1',
      scopeIdentity: 'att_saath_first',
      toolName: 'github_comment_on_issue',
      arguments: { number: 9, body: 'Explicit retry' },
      cwd: process.cwd(),
      actor: 'core',
      clientId: 'client-1',
    };
    const requested = await dispatchCapability(db, registry, action);
    if (requested.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(requested.approval, 'rejected'));

    const sameAttempt = await dispatchCapability(db, registry, action);
    expect(sameAttempt.outcome).toBe('denied');

    const laterAttempt = await dispatchCapability(db, registry, {
      ...action,
      scopeIdentity: 'att_saath_second',
    });
    expect(laterAttempt.outcome).toBe('approval_required');
    if (laterAttempt.outcome === 'approval_required') {
      expect(laterAttempt.approval.id).not.toBe(requested.approval.id);
    }
    expect(listApprovalsForAttempt(db, requested.attemptId)).toHaveLength(2);
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls).toHaveLength(0);
  });

  it('a different action on the same attempt still requires its own approval (denial does not block unrelated actions)', async () => {
    const executor = scriptedGithubExecutor({
      'issue view 2 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }), code: 0 },
      'issue comment 2': { stdout: 'posted', code: 0 },
    });
    const registry = registryWithGithub(executor);
    const first = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-5', toolName: 'github_comment_on_issue', arguments: { number: 1, body: 'A' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    if (first.outcome !== 'approval_required') throw new Error('expected approval_required');
    resolveCapabilityApproval(db, decisionFrom(first.approval, 'rejected'));

    const second = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-5', toolName: 'github_comment_on_issue', arguments: { number: 2, body: 'B' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(second.outcome).toBe('approval_required');
  });

  it('never dispatches or offers approval when the capability is already unavailable', async () => {
    const executor = scriptedGithubExecutor({});
    const registry = registryWithGithub(executor);
    // Force unavailable health by replacing the adapter's health() after registration
    // is not possible post-construction on a real adapter, so build one directly here.
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    const unhealthy = { ...adapter, health: () => ({ state: 'unavailable' as const, reason: 'auth expired', checkedAt: new Date().toISOString() }) };
    const gatedRegistry = new GovernedCapabilityRegistry().register(unhealthy);
    const result = await dispatchCapability(db, gatedRegistry, {
      correlationId: 'forge-task-6', toolName: 'github_comment_on_issue', arguments: { number: 1, body: 'x' }, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('unavailable');
    expect(listApprovalsForAttempt(db, result.attemptId)).toHaveLength(0);
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls.length).toBe(0);
  });

  it('reports unknown_tool for a tool no registered capability owns', async () => {
    const registry = registryWithGithub(scriptedGithubExecutor({}));
    const result = await dispatchCapability(db, registry, {
      correlationId: 'forge-task-7', toolName: 'nonexistent_capability_tool', arguments: {}, cwd: process.cwd(), actor: 'core', clientId: 'client-1',
    });
    expect(result.outcome).toBe('unknown_tool');
  });
});
