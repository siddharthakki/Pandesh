import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { MockProvider } from '../mocks/MockProvider';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { toolCallResponse, textResponse } from '../fixtures/responses';
import type { CoreClient } from '../../core-client/CoreClient';
import type { CapabilityDispatchResult } from '../../../core/shared/wireTypes';
import type { AgentLoopEvents } from '../../tools/ToolTypes';

/**
 * Deterministic packaged three-capability scenario, driven through the real
 * product code path: AgentLoop -> (real) ToolExecutor -> CoreClient bridge.
 * Only the model provider and the Core HTTP transport are test doubles — the
 * ToolExecutor/ApprovalFlow/AgentLoop wiring under test is exactly what ships.
 *
 * 1. Governed read-only repository inspection: real `read_file` against a
 *    real temp workspace file.
 * 2. Governed research: Core-backed `governed_research`, gated by approval.
 * 3. Proposed GitHub issue comment: Core-backed `github_comment_on_issue`,
 *    gated by approval, idempotent.
 */

class FakeCoreClient {
  dispatchCalls: Array<{ correlationId: string; toolName: string; arguments: Record<string, unknown> }> = [];
  resolveCalls: Array<{ approvalId: string; resolution: string }> = [];
  cancelCalls: string[] = [];
  private queue: CapabilityDispatchResult[] = [];

  queue_(...results: CapabilityDispatchResult[]): void { this.queue.push(...results); }

  async dispatchCapability(input: { correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }): Promise<CapabilityDispatchResult> {
    this.dispatchCalls.push(input);
    const next = this.queue.shift();
    if (!next) throw new Error(`FakeCoreClient: no queued result for ${input.toolName} (call #${this.dispatchCalls.length})`);
    return next;
  }

  async resolveCapabilityApproval(approvalId: string, input: { resolution: string }): Promise<unknown> {
    this.resolveCalls.push({ approvalId, resolution: input.resolution });
    return { id: approvalId, status: input.resolution };
  }

  async cancelCapabilityAction(attemptId: string): Promise<unknown> {
    this.cancelCalls.push(attemptId);
    return { id: attemptId, status: 'cancelling' };
  }
}

function approvalRequired(id: string, summary: Record<string, unknown> = {}): Extract<CapabilityDispatchResult, { outcome: 'approval_required' }> {
  return {
    outcome: 'approval_required',
    attemptId: 'att_packaged_1',
    approval: {
      id,
      attemptId: 'att_packaged_1',
      kind: 'mutation',
      status: 'pending',
      requestedAt: '2026-01-01T00:00:00Z',
      resolvedAt: null,
      resolution: null,
      summary,
      claimOwner: null,
      claimExpiresAt: null,
      envelopeVersion: 1,
      expectedAttemptRevision: 4,
      expectedAttemptStatus: 'waiting_for_approval',
      requestedActionDigest: `digest-${id}`,
      frozenContextHash: 'context-packaged',
      revision: 1,
    },
  };
}

function executed(toolName: string, output: string): Extract<CapabilityDispatchResult, { outcome: 'executed' }> {
  return {
    outcome: 'executed',
    attemptId: 'att_packaged_1',
    toolInvocation: {
      id: `tinv_${toolName}`,
      attemptId: 'att_packaged_1',
      toolName,
      argsSummary: {},
      status: 'succeeded',
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:01Z',
      exitCode: 0,
      evidence: { output },
    },
  };
}

describe('M38 packaged three-capability workflow (deterministic)', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'm38-packaged-'));
    await fs.writeFile(path.join(workspaceRoot, 'README.md'), 'This repository has a known widget-rendering bug.', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('combines local inspection, governed research, and a governed GitHub write into one final answer, with exactly one approved mutation each', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue_(
      approvalRequired('appr_research', { toolName: 'governed_research', arguments: { query: 'widget rendering bug' } }),
      executed('governed_research', '[S1]\nTitle: Widget rendering fix\nURL: https://example.com/widgets\nEvidence: Clear the cache after resizing.'),
      approvalRequired('appr_github', { toolName: 'github_comment_on_issue', arguments: { number: 42, body: 'Root cause: widget cache not cleared on resize. Fix: clear cache after resize (see https://example.com/widgets).' } }),
      executed('github_comment_on_issue', 'posted'),
    );

    class AutoApprove extends ApprovalFlow {
      override async requestApproval(): Promise<'approved'> { return 'approved'; }
    }

    const provider = new MockProvider();
    provider.enqueue(toolCallResponse('read_file', { path: 'README.md' }));
    provider.enqueue(toolCallResponse('governed_research', { query: 'widget rendering bug' }));
    provider.enqueue(toolCallResponse('github_comment_on_issue', { number: 42, body: 'Root cause: widget cache not cleared on resize. Fix: clear cache after resize (see https://example.com/widgets).' }));
    provider.enqueue(textResponse('Inspected the repository, found the widget-rendering bug in README.md, researched the fix, and posted it as a comment on issue #42.'));

    const context = new ContextManager('You are a helpful coding agent.');
    context.addUserMessage('Inspect this repository problem, research the relevant external documentation, and prepare the governed GitHub action.');

    const loop = new AgentLoop(context, {
      workspaceRoot,
      approvalFlow: new AutoApprove(),
      checkpointManager: new MockCheckpointManager() as never,
      auditService: new MockAuditService() as never,
      provider,
      mode: 'agent',
      taskId: 'forge-task-packaged-1',
      coreClient: coreClient as unknown as CoreClient,
    });

    const events: AgentLoopEvents = {};
    const result = await loop.run({ workspaceRoot, sessionId: 'sess_packaged', turnId: 'turn_packaged', model: 'test-model' }, events);

    expect(result.finalContent).toContain('posted it as a comment on issue #42');

    // Capability #1: local inspection — never touched Core at all.
    expect(coreClient.dispatchCalls.some((c) => c.toolName === 'read_file')).toBe(false);

    // Capability #2 + #3: exactly one ask + one execute each, in order, no execution before approval.
    expect(coreClient.dispatchCalls.map((c) => c.toolName)).toEqual([
      'governed_research', 'governed_research', 'github_comment_on_issue', 'github_comment_on_issue',
    ]);
    expect(coreClient.resolveCalls).toHaveLength(2);
    expect(coreClient.resolveCalls.every((c) => c.resolution === 'approved')).toBe(true);
  });

  it('a denied GitHub write produces zero external mutations and the final answer never claims the action happened', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue_(
      approvalRequired('appr_github_denied', { toolName: 'github_comment_on_issue', arguments: { number: 7, body: 'Spam-looking comment' } }),
      { outcome: 'denied', attemptId: 'att_packaged_2', reason: 'user rejected the requested comment' },
    );
    class AutoReject extends ApprovalFlow {
      override async requestApproval(): Promise<'rejected'> { return 'rejected'; }
    }
    const provider = new MockProvider();
    provider.enqueue(toolCallResponse('github_comment_on_issue', { number: 7, body: 'Spam-looking comment' }));
    provider.enqueue(textResponse('The comment was not posted because the user denied the request.'));

    const context = new ContextManager('You are a helpful coding agent.');
    context.addUserMessage('Post a comment on issue 7.');
    const loop = new AgentLoop(context, {
      workspaceRoot,
      approvalFlow: new AutoReject(),
      checkpointManager: new MockCheckpointManager() as never,
      auditService: new MockAuditService() as never,
      provider,
      mode: 'agent',
      taskId: 'forge-task-packaged-2',
      coreClient: coreClient as unknown as CoreClient,
    });

    const result = await loop.run({ workspaceRoot, sessionId: 'sess_packaged_2', turnId: 'turn_packaged_2', model: 'test-model' }, {});
    // AgentLoop halts the turn immediately on a policy violation rather than letting the
    // model narrate around a denied action — the loop never reaches the "final answer" turn at all.
    expect(result.finalContent).toContain('user rejected the requested comment');
    expect(coreClient.resolveCalls).toEqual([{ approvalId: 'appr_github_denied', resolution: 'rejected' }]);
    // Only the ask + the denial-check dispatch happened — the adapter itself never ran (FakeCoreClient
    // never invokes a real adapter, but the outcome contract guarantees Core didn't execute either).
    expect(coreClient.dispatchCalls).toHaveLength(2);
  });
});
