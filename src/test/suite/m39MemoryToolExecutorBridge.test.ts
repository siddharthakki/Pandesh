import { describe, it, expect, vi } from 'vitest';
import { ToolExecutor, CORE_BACKED_CAPABILITY_TOOLS, MEMORY_APPROVAL_PROMPTS } from '../../tools/ToolExecutor';
import { ToolRegistry } from '../../tools/ToolRegistry';
import { TOOL_SCHEMAS } from '../../tools/ToolSchemas';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { PolicyEngine } from '../../policy/PolicyEngine';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { AuditService } from '../../services/AuditService';
import type { CoreClient } from '../../core-client/CoreClient';
import type { CapabilityDispatchResult } from '../../../core/shared/wireTypes';
import type { ToolCall } from '../../tools/ToolTypes';

/**
 * M39: the memory tools must travel the exact M38 Core-backed capability
 * bridge — never a local decision, never a local store, never a second
 * approval authority (ADR-7). Mirrors `m38ToolExecutorCapabilityBridge.test.ts`.
 */

class CapturingAuditService extends AuditService {
  readonly events: Array<Record<string, unknown>> = [];
  constructor() { super('/dev/null'); }
  override async log(event: Record<string, unknown>): Promise<void> { this.events.push(event); }
}

const BASE_CONTEXT = {
  workspaceRoot: '/repo',
  sessionId: 'sess_m39',
  turnId: 'turn_1',
  model: 'test-model',
  mode: 'agent' as const,
  taskId: 'conv-m39',
};

const MEMORY_TOOLS = [
  'memory_remember', 'memory_recall', 'memory_resolve_contradiction',
  'memory_impact', 'memory_export', 'memory_forget',
];

function fakeApproval() {
  return {
    outcome: 'approval_required' as const,
    attemptId: 'att_m39',
    approval: {
      id: 'appr_m39', attemptId: 'att_m39', kind: 'mutation' as const, status: 'pending' as const,
      requestedAt: '2026-07-27T00:00:00Z', resolvedAt: null, resolution: null,
      summary: { toolName: 'memory_remember', arguments: {} }, claimOwner: null, claimExpiresAt: null,
      envelopeVersion: 1, expectedAttemptRevision: 3, expectedAttemptStatus: 'running' as const,
      requestedActionDigest: 'digest-m39', frozenContextHash: 'context-m39', revision: 1,
    },
  };
}

function executed(toolName: string, output: string): CapabilityDispatchResult {
  return {
    outcome: 'executed',
    attemptId: 'att_m39',
    toolInvocation: {
      id: `tinv_${toolName}`, attemptId: 'att_m39', toolName, argsSummary: {}, status: 'succeeded',
      startedAt: 'x', endedAt: 'y', exitCode: 0, evidence: { output },
    },
  };
}

class FakeCoreClient {
  dispatchCalls: Array<{ correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }> = [];
  resolveCalls: Array<{ approvalId: string; input: Record<string, unknown> }> = [];
  private queued: CapabilityDispatchResult[] = [];
  async cancelCapabilityAction(attemptId: string): Promise<unknown> { return { id: attemptId, status: 'cancelling' }; }
  queue(...results: CapabilityDispatchResult[]): void { this.queued.push(...results); }
  async dispatchCapability(input: { correlationId: string; toolName: string; arguments: Record<string, unknown>; cwd: string }): Promise<CapabilityDispatchResult> {
    this.dispatchCalls.push(input);
    const next = this.queued.shift();
    if (!next) throw new Error('FakeCoreClient: no queued dispatch result');
    return next;
  }
  async resolveCapabilityApproval(approvalId: string, input: Record<string, unknown>): Promise<unknown> {
    this.resolveCalls.push({ approvalId, input });
    return { id: approvalId, status: input.resolution };
  }
}

function makeExecutor(coreClient: FakeCoreClient, extra: { approvalFlow?: ApprovalFlow; policyEngine?: PolicyEngine } = {}) {
  return new ToolExecutor({
    workspaceRoot: '/repo',
    approvalFlow: extra.approvalFlow ?? new ApprovalFlow(),
    checkpointManager: new CheckpointManager('/nonexistent'),
    auditService: new CapturingAuditService() as unknown as AuditService,
    policyEngine: extra.policyEngine,
    coreClient: coreClient as unknown as CoreClient,
  });
}

function call(name: string, args: Record<string, unknown>): ToolCall {
  return { function: { name, arguments: args } };
}

describe('M39 memory tools on the Core-backed capability bridge', () => {
  it('every memory tool is Core-backed, schema-bounded, and has no local governed authorization entry', () => {
    for (const tool of MEMORY_TOOLS) {
      expect(CORE_BACKED_CAPABILITY_TOOLS.has(tool), tool).toBe(true);
      expect(TOOL_SCHEMAS.some(schema => schema.function.name === tool), tool).toBe(true);
      expect(ToolRegistry.has(tool), tool).toBe(true);
    }
    // The stub in ToolRegistry must never actually execute a memory action.
    const stub = ToolRegistry.get('memory_remember')!;
    expect(stub.mutatesWorkspace).toBe(false);
  });

  it('dispatches a read-only memory_recall through Core without any approval', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue(executed('memory_recall', '{"entries":[]}'));
    const result = await makeExecutor(coreClient).execute(call('memory_recall', { scopeType: 'project', scopeId: 'Atlas' }), BASE_CONTEXT);
    expect(result.ok).toBe(true);
    expect(coreClient.dispatchCalls).toHaveLength(1);
    expect(coreClient.dispatchCalls[0]).toMatchObject({ correlationId: 'conv-m39', toolName: 'memory_recall' });
    expect(coreClient.resolveCalls).toHaveLength(0);
  });

  it('never evaluates the local PolicyEngine for a memory tool', async () => {
    const policyEngine = new PolicyEngine();
    const evaluateSpy = vi.spyOn(policyEngine, 'evaluate');
    const coreClient = new FakeCoreClient();
    coreClient.queue(executed('memory_export', '{"schemaVersion":1,"memories":[]}'));
    await makeExecutor(coreClient, { policyEngine }).execute(call('memory_export', {}), BASE_CONTEXT);
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it('memory_remember executes nothing until the exact Core approval envelope is relayed back', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue(fakeApproval(), executed('memory_remember', '{"memoryId":"mem_1"}'));
    const prompts: string[] = [];
    class AutoApprove extends ApprovalFlow {
      override async requestApproval(_tool: string, _args: Record<string, unknown>, reason: string): Promise<'approved'> {
        prompts.push(reason);
        return 'approved';
      }
    }
    const result = await makeExecutor(coreClient, { approvalFlow: new AutoApprove() })
      .execute(call('memory_remember', { scopeType: 'project', scopeId: 'Atlas', value: 'SQLite' }), BASE_CONTEXT);

    expect(result.ok).toBe(true);
    expect(coreClient.dispatchCalls).toHaveLength(2); // ask, then execute — never executes on the first call
    expect(prompts).toEqual([MEMORY_APPROVAL_PROMPTS.memory_remember]);
    expect(coreClient.resolveCalls[0]).toEqual({
      approvalId: 'appr_m39',
      input: {
        resolution: 'approved',
        attemptId: 'att_m39',
        expectedAttemptRevision: 3,
        expectedAttemptStatus: 'running',
        requestedActionDigest: 'digest-m39',
        frozenContextHash: 'context-m39',
      },
    });
  });

  it('uses the memory-specific human-readable prompt for every consequential memory action', async () => {
    for (const [tool, prompt] of Object.entries(MEMORY_APPROVAL_PROMPTS)) {
      const coreClient = new FakeCoreClient();
      coreClient.queue(fakeApproval(), executed(tool, '{}'));
      const prompts: string[] = [];
      class Capture extends ApprovalFlow {
        override async requestApproval(_t: string, _a: Record<string, unknown>, reason: string): Promise<'approved'> { prompts.push(reason); return 'approved'; }
      }
      await makeExecutor(coreClient, { approvalFlow: new Capture() }).execute(call(tool, {}), BASE_CONTEXT);
      expect(prompts, tool).toEqual([prompt]);
    }
  });

  it('a Core denial of memory_remember is returned as blocked and never executed locally', async () => {
    const coreClient = new FakeCoreClient();
    coreClient.queue(fakeApproval(), { outcome: 'denied', attemptId: 'att_m39', reason: 'this exact action was already denied and will not be retried' });
    class AutoReject extends ApprovalFlow {
      override async requestApproval(): Promise<'rejected'> { return 'rejected'; }
    }
    const denied = await makeExecutor(coreClient, { approvalFlow: new AutoReject() })
      .execute(call('memory_remember', { value: 'SQLite' }), BASE_CONTEXT);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.blocked).toBe(true);
      expect(denied.error).toContain('already denied');
    }
    expect(coreClient.dispatchCalls).toHaveLength(2);
  });

  it('fails closed when no Core client is available rather than storing memory locally', async () => {
    const executor = new ToolExecutor({
      workspaceRoot: '/repo',
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager('/nonexistent'),
      auditService: new CapturingAuditService() as unknown as AuditService,
    });
    const result = await executor.execute(call('memory_remember', { value: 'SQLite' }), BASE_CONTEXT);
    expect(result.ok).toBe(false);
  });
});
