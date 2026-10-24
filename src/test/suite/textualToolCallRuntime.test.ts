import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { MockProvider } from '../mocks/MockProvider';
import { FakeToolExecutor } from '../mocks/FakeToolExecutor';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { TOOL_CONTEXT } from '../fixtures/responses';

describe('AgentLoop textual tool-call compatibility', () => {
  it('routes a complete Qwen write block through the governed executor', async () => {
    const provider = new MockProvider();
    const executor = new FakeToolExecutor();
    executor.defaultResult = { ok: true, data: { written: true } };

    const context = new ContextManager('You are a local coding agent.');
    context.addUserMessage(
      'Create native-agent-smoke-test.txt containing exactly Native agent write test passed.',
    );

    provider.enqueueText([
      "I'll create the requested file with the exact content specified.",
      '<function=write_file>',
      '<parameter=path>',
      'native-agent-smoke-test.txt',
      '</parameter>',
      '<parameter=content>',
      'Native agent write test passed.',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n'));
    provider.enqueueText('Created `native-agent-smoke-test.txt`.');

    const loop = new AgentLoop(context, {
      workspaceRoot: '/fake/workspace',
      approvalFlow: new ApprovalFlow() as never,
      checkpointManager: new MockCheckpointManager() as never,
      auditService: new MockAuditService() as never,
      provider,
      mode: 'agent',
      modelOverride: 'qwen3-coder:30b',
      executor,
    });

    const result = await loop.run(TOOL_CONTEXT, {});

    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].toolCall.function).toEqual({
      name: 'write_file',
      arguments: {
        path: 'native-agent-smoke-test.txt',
        content: 'Native agent write test passed.',
      },
    });
    expect(result.finalContent).toContain('native-agent-smoke-test.txt');
  });
});
