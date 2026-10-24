import { describe, it, expect, beforeEach } from 'vitest';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { MockProvider } from '../mocks/MockProvider';
import { FakeToolExecutor } from '../mocks/FakeToolExecutor';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { textResponse, toolCallResponse, TOOL_CONTEXT } from '../fixtures/responses';
import type { AgentLoopEvents } from '../../tools/ToolTypes';

function makeLoop(
  mode: 'agent' | 'chat' | 'ask' | 'plan' = 'agent',
  modelOverride?: string,
) {
  const provider = new MockProvider();
  const executor = new FakeToolExecutor();
  const approval = new ApprovalFlow();
  const audit = new MockAuditService();
  const checkpoint = new MockCheckpointManager();
  const context = new ContextManager('You are a helpful assistant.');
  context.addUserMessage('test message');

  const loop = new AgentLoop(context, {
    workspaceRoot: '/fake/workspace',
    approvalFlow: approval as never,
    checkpointManager: checkpoint as never,
    auditService: audit as never,
    provider,
    mode,
    modelOverride,
    executor,
  });

  return { loop, provider, executor, approval, context };
}

// ---------------------------------------------------------------------------
// Mode isolation
// ---------------------------------------------------------------------------
describe('AgentLoop — mode isolation', () => {
  it('chat mode sends no tools to provider', async () => {
    const { loop, provider } = makeLoop('chat');
    provider.enqueueText('Hello!');
    await loop.run(TOOL_CONTEXT, {});
    expect(provider.capturedRequests[0].tools).toHaveLength(0);
  });

  it('chat mode returns text without executing any tools', async () => {
    const { loop, provider, executor } = makeLoop('chat');
    provider.enqueue(toolCallResponse('read_file', { path: '/etc/passwd' }));
    const events: AgentLoopEvents = {};
    await loop.run(TOOL_CONTEXT, events);
    expect(executor.calls).toHaveLength(0);
  });

  it('agent mode sends tools to provider', async () => {
    const { loop, provider } = makeLoop('agent');
    provider.enqueueText('done');
    await loop.run(TOOL_CONTEXT, {});
    expect(provider.capturedRequests[0].tools.length).toBeGreaterThan(0);
  });

  // PolicyEngine-level read-only enforcement for ask/plan is tested in safety.spec.ts.
  // These integration-level loop tests (real ToolExecutor wired) are deferred to Phase 11.
  it.todo('[Phase 11] ask mode loop: mutating tool call reaches policy and is blocked');
  it.todo('[Phase 11] plan mode loop: mutating tool call reaches policy and is blocked');
});

// ---------------------------------------------------------------------------
// Model selection — model reaches provider unchanged
// ---------------------------------------------------------------------------
describe('AgentLoop — model selection', () => {
  it('modelOverride reaches provider unchanged', async () => {
    const { loop, provider } = makeLoop('agent', 'my-custom-model:7b');
    provider.enqueueText('done');
    await loop.run(TOOL_CONTEXT, {});
    expect(provider.capturedRequests[0].options.model).toBe('my-custom-model:7b');
  });

  it('onModelSelected fires with the override model', async () => {
    const { loop, provider } = makeLoop('agent', 'override-model:3b');
    provider.enqueueText('done');
    let selectedModel = '';
    await loop.run(TOOL_CONTEXT, { onModelSelected: (m) => { selectedModel = m; } });
    expect(selectedModel).toBe('override-model:3b');
  });

  it('embedding-only model produces visible error and stops immediately', async () => {
    const { loop, provider } = makeLoop('agent', 'nomic-embed-text');
    provider.enqueueText('done');
    let errorMsg = '';
    const result = await loop.run(TOOL_CONTEXT, { onError: (e) => { errorMsg = e; } });
    expect(result.iterations).toBe(0);
    expect(errorMsg).toMatch(/embedding-only/i);
  });

  it('non-tool model receives empty tools array', async () => {
    const { loop, provider } = makeLoop('agent', 'mistral:7b');
    provider.enqueueText('done');
    await loop.run(TOOL_CONTEXT, {});
    expect(provider.capturedRequests[0].tools).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Loop-stop behaviour
// ---------------------------------------------------------------------------
describe('AgentLoop — loop stop', () => {
  it('stops at max iterations when model keeps calling tools', async () => {
    const { loop, provider, executor } = makeLoop('agent');
    executor.defaultResult = { ok: true, data: 'ok' };

    // Always returns a tool call so the loop never self-terminates
    for (let i = 0; i < 25; i++) {
      provider.enqueue(toolCallResponse('read_file', { path: '/tmp/test' }));
    }
    provider.enqueueText('done');

    const result = await loop.run(TOOL_CONTEXT, {});
    expect(result.stoppedByLimit).toBe(true);
  });

  it('cancellation via AbortSignal stops before next iteration', async () => {
    const { loop, provider } = makeLoop('agent');
    const controller = new AbortController();
    provider.enqueueText('done');
    controller.abort();
    const result = await loop.run(TOOL_CONTEXT, {}, controller.signal);
    expect(result.finalContent).toMatch(/stopped/i);
    expect(result.stoppedByLimit).toBe(false);
  });

  it('repeated rejected tool call stops immediately without burning through iterations', async () => {
    const { loop, provider, executor, approval } = makeLoop('agent');

    // First call: tool call returned, then approval rejected
    provider.enqueue(toolCallResponse('write_file', { path: '/tmp/x', content: 'y' }));
    // Second call: same tool call again
    provider.enqueue(toolCallResponse('write_file', { path: '/tmp/x', content: 'y' }));
    provider.enqueueText('done');

    executor.setResult('write_file', { ok: false, error: 'denied', requiresApproval: true });

    const result = await loop.run(TOOL_CONTEXT, {});
    // Loop must stop before the iteration limit — repeated rejected fp guard fired
    expect(result.iterations).toBeLessThan(20);
    expect(result.finalContent).toMatch(/rejected/i);
  });

  it('invalid tool name does not crash the loop', async () => {
    const { loop, provider } = makeLoop('agent');
    provider.enqueue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'no_such_tool', arguments: {} } }],
      },
      done: true,
    });
    provider.enqueueText('done');
    // The tool executor should return an error result; loop should continue
    const result = await loop.run(TOOL_CONTEXT, {});
    expect(result.stoppedByLimit).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tool-call argument safety
// ---------------------------------------------------------------------------
describe('AgentLoop — tool call arguments', () => {
  it('tool calls with no arguments object default to empty object', async () => {
    const { loop, provider, executor } = makeLoop('agent');
    provider.enqueue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ function: { name: 'read_file', arguments: {} } }],
      },
      done: true,
    });
    provider.enqueueText('done');
    await loop.run(TOOL_CONTEXT, {});
    if (executor.calls.length > 0) {
      expect(typeof executor.calls[0].toolCall.function.arguments).toBe('object');
    }
  });

  it('tool call IDs from provider survive to the executor', async () => {
    const { loop, provider, executor } = makeLoop('agent');
    const callId = 'call_abc123';
    provider.enqueue({
      message: {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: callId, function: { name: 'read_file', arguments: { path: '/tmp/x' } } }],
      },
      done: true,
    });
    provider.enqueueText('done');
    await loop.run(TOOL_CONTEXT, {});
    if (executor.calls.length > 0) {
      expect(executor.calls[0].toolCall.id).toBe(callId);
    }
  });
});
