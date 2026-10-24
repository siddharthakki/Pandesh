import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolExecutor, CORE_BACKED_CAPABILITY_TOOLS } from '../../tools/ToolExecutor';
import { CoreDeniedActionsGuard } from '../../tools/CoreDeniedActionsGuard';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { PolicyEngine } from '../../policy/PolicyEngine';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { AuditService } from '../../services/AuditService';
import type { CoreClient } from '../../core-client/CoreClient';
import type { CapabilityDispatchResult } from '../../../core/shared/wireTypes';
import type { ToolCall } from '../../tools/ToolTypes';

class CapturingAuditService extends AuditService {
  readonly events: Array<Record<string, unknown>> = [];
  constructor() { super('/dev/null'); }
  override async log(event: Record<string, unknown>): Promise<void> { this.events.push(event); }
}

const BASE_CONTEXT = {
  workspaceRoot: '/repo',
  sessionId: 'sess_m38',
  turnId: 'turn_1',
  model: 'test-model',
  mode: 'agent' as const,
  taskId: 'forge-task-m38',
};

function fakeApproval(overrides: Partial<CapabilityDispatchResult & { outcome: 'approval_required' }> = {}) {
  return {
    outcome: 'approval_required' as const,
    attemptId: 'att_1',
    approval: {
      id: 'appr_1',
      attemptId: 'att_1',
      kind: 'mutation' as const,
      status: 'pending' as const,
      requestedAt: '2026-01-01T00:00:00Z',
      resolvedAt: null,
      resolution: null,
      summary: {},
      claimOwner: null,
      claimExpiresAt: null,
      envelopeVersion: 1,
      expectedAttemptRevision: 3,
      expectedAttemptStatus: 'running' as const,
      requestedActionDigest: 'digest-abc',
      frozenContextHash: 'context-abc',
      revision: 1,
    },
    ...overrides,
  };
}

/** Records every call so tests can assert the bridge never decided/executed locally. */
class FakeCoreClient {
  dispatchCalls: Array<{ correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }> = [];
  resolveCalls: Array<{ approvalId: string; input: Record<string, unknown> }> = [];
  cancelCalls: string[] = [];
  private queuedResults: CapabilityDispatchResult[] = [];

  async cancelCapabilityAction(attemptId: string): Promise<unknown> {
    this.cancelCalls.push(attemptId);
    return { id: attemptId, status: 'cancelling' };
  }

  queue(...results: CapabilityDispatchResult[]): void { this.queuedResults.push(...results); }

  async dispatchCapability(input: { correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }): Promise<CapabilityDispatchResult> {
    this.dispatchCalls.push(input);
    const next = this.queuedResults.shift();
    if (!next) throw new Error('FakeCoreClient: no queued dispatch result');
    return next;
  }

  async resolveCapabilityApproval(approvalId: string, input: Record<string, unknown>): Promise<unknown> {
    this.resolveCalls.push({ approvalId, input });
    return { id: approvalId, status: input.resolution };
  }
}

function makeExecutor(coreClient: FakeCoreClient, extra: { approvalFlow?: ApprovalFlow; policyEngine?: PolicyEngine; deniedActionsGuard?: CoreDeniedActionsGuard } = {}) {
  return new ToolExecutor({
    workspaceRoot: '/repo',
    approvalFlow: extra.approvalFlow ?? new ApprovalFlow(),
    checkpointManager: new CheckpointManager('/nonexistent'),
    auditService: new CapturingAuditService() as unknown as AuditService,
    policyEngine: extra.policyEngine,
    coreClient: coreClient as unknown as CoreClient,
    deniedActionsGuard: extra.deniedActionsGuard,
  });
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { function: { name, arguments: args } };
}

describe('M38 ToolExecutor Core-backed capability bridge', () => {
  it('dispatches github_read_issue through Core rather than executing anything locally', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue({ outcome: 'executed', attemptId: 'att_1', toolInvocation: { id: 't1', attemptId: 'att_1', toolName: 'github_read_issue', argsSummary: {}, status: 'succeeded', startedAt: 'x', endedAt: 'y', exitCode: 0, evidence: { output: 'issue body' } } });
    const executor = makeExecutor(coreClient);
    const result = await executor.execute(call('github_read_issue', { number: 1 }), BASE_CONTEXT);
    expect(result.ok).toBe(true);
    expect(coreClient.dispatchCalls).toHaveLength(1);
    expect(coreClient.dispatchCalls[0]).toMatchObject({ correlationId: 'forge-task-m38', toolName: 'github_read_issue' });
  });

  it('local PolicyEngine.evaluate is never called for a Core-backed tool', async () => {
    const policyEngine = new PolicyEngine();
    const evaluateSpy = vi.spyOn(policyEngine, 'evaluate');
    const coreClient = new FakeCoreClient();
    coreClient.queue({ outcome: 'executed', attemptId: 'att_1', toolInvocation: { id: 't1', attemptId: 'att_1', toolName: 'github_read_issue', argsSummary: {}, status: 'succeeded', startedAt: 'x', endedAt: 'y', exitCode: 0, evidence: {} } });
    const executor = makeExecutor(coreClient, { policyEngine });
    await executor.execute(call('github_read_issue', { number: 1 }), BASE_CONTEXT);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('does not execute anything until Core-required approval is resolved, and resolves the exact envelope Core returned', async () => {
    const coreClient = new FakeCoreClient();
    const approvalRequired = fakeApproval();
    coreClient.queue(
      approvalRequired,
      { outcome: 'executed', attemptId: 'att_1', toolInvocation: { id: 't2', attemptId: 'att_1', toolName: 'github_comment_on_issue', argsSummary: {}, status: 'succeeded', startedAt: 'x', endedAt: 'y', exitCode: 0, evidence: { output: 'posted' } } },
    );
    class AutoApprove extends ApprovalFlow {
      override async requestApproval(): Promise<'approved'> { return 'approved'; }
    }
    const executor = makeExecutor(coreClient, { approvalFlow: new AutoApprove() });
    const result = await executor.execute(call('github_comment_on_issue', { number: 5, body: 'fix' }), BASE_CONTEXT);

    expect(result.ok).toBe(true);
    expect(coreClient.dispatchCalls).toHaveLength(2); // ask, then execute after resolution — never executes on the first call
    expect(coreClient.resolveCalls).toHaveLength(1);
    expect(coreClient.resolveCalls[0]).toEqual({
      approvalId: 'appr_1',
      input: {
        resolution: 'approved',
        attemptId: 'att_1',
        expectedAttemptRevision: 3,
        expectedAttemptStatus: 'running',
        requestedActionDigest: 'digest-abc',
        frozenContextHash: 'context-abc',
      },
    });
  });

  it('a Core denial blocks the tool result and also blocks an equivalent run_command bypass attempt', async () => {
    const coreClient = new FakeCoreClient();
    const approvalRequired = fakeApproval();
    coreClient.queue(approvalRequired, { outcome: 'denied', attemptId: 'att_1', reason: 'user rejected' });
    class AutoReject extends ApprovalFlow {
      override async requestApproval(): Promise<'rejected'> { return 'rejected'; }
    }
    const guard = new CoreDeniedActionsGuard();
    const executor = makeExecutor(coreClient, { approvalFlow: new AutoReject(), deniedActionsGuard: guard });

    const denied = await executor.execute(call('github_comment_on_issue', { number: 5, body: 'fix' }), BASE_CONTEXT);
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.blocked).toBe(true);

    // No adapter ever executed (only the two dispatch calls Core itself made, both non-executing).
    expect(coreClient.dispatchCalls).toHaveLength(2);

    // The same denial must block a run_command replay of the identical gh CLI mutation.
    const bypassAttempt = await executor.execute(call('run_command', { command: 'gh issue comment 5 --body "fix"' }), BASE_CONTEXT);
    expect(bypassAttempt.ok).toBe(false);
    if (!bypassAttempt.ok) {
      expect(bypassAttempt.blocked).toBe(true);
      expect(bypassAttempt.error).toContain('already denied');
    }
  });

  it('does not block an unrelated run_command invocation after a different action was denied', async () => {
    const guard = new CoreDeniedActionsGuard();
    guard.recordGithubCommentDenied('*', 5);
    const coreClient = new FakeCoreClient();
    const executor = makeExecutor(coreClient, { deniedActionsGuard: guard });
    const reason = guard.blockedRunCommandReason('gh issue comment 6 --body "unrelated"');
    expect(reason).toBeUndefined();
  });

  it('fails closed without a Core connection rather than falling back to local execution', async () => {
    const executor = new ToolExecutor({
      workspaceRoot: '/repo',
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager('/nonexistent'),
      auditService: new CapturingAuditService() as unknown as AuditService,
    });
    const result = await executor.execute(call('github_read_issue', { number: 1 }), BASE_CONTEXT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.blocked).toBe(true);
  });

  it('cancels the real Core-side execution when the caller aborts mid-approval-wait, not just the local promise', async () => {
    const coreClient = new FakeCoreClient();
    const approvalRequired = fakeApproval();
    coreClient.queue(approvalRequired, { outcome: 'executed', attemptId: 'att_1', toolInvocation: { id: 't3', attemptId: 'att_1', toolName: 'github_comment_on_issue', argsSummary: {}, status: 'cancelled', startedAt: 'x', endedAt: 'y', exitCode: null, evidence: { cancelled: true } } });
    const controller = new AbortController();
    class NeverResolvingUntilAbort extends ApprovalFlow {
      override async requestApproval(_toolName: string, _args: Record<string, unknown>, _reason: string, _risk: string, signal?: AbortSignal): Promise<'approved' | 'rejected'> {
        return new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
    }
    const executor = makeExecutor(coreClient, { approvalFlow: new NeverResolvingUntilAbort() });
    const promise = executor.execute(call('github_comment_on_issue', { number: 5, body: 'fix' }), BASE_CONTEXT, undefined, controller.signal);
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const result = await promise;
    expect(result.ok).toBe(false);
    expect(coreClient.cancelCalls).toEqual(['att_1']);
  });

  it('exposes exactly the three M38 Core-backed tool names, plus the M39 memory capability and nothing else', () => {
    // M39 added the governed memory capability to this same bridge (ADR-7 —
    // one Core-owned authority, not a second one). The M38 set is asserted
    // exactly, and the total set is asserted exactly, so an accidental
    // addition to this bridge still fails.
    const all = [...CORE_BACKED_CAPABILITY_TOOLS].sort();
    expect(all.filter(name => !name.startsWith('memory_'))).toEqual(['github_comment_on_issue', 'github_read_issue', 'governed_research']);
    expect(all).toEqual([
      'github_comment_on_issue', 'github_read_issue', 'governed_research',
      'memory_export', 'memory_forget', 'memory_impact',
      'memory_recall', 'memory_remember', 'memory_resolve_contradiction',
    ]);
  });
});
