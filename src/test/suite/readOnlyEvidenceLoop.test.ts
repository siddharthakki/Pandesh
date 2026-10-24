import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { MockProvider } from '../mocks/MockProvider';
import { FakeToolExecutor } from '../mocks/FakeToolExecutor';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { TOOL_CONTEXT } from '../fixtures/responses';

const PROMPT = [
  'Perform read-only repository inspection only.',
  'Read package.json, list files directly under src,',
  'and count files matching src/test/suite/*.test.ts.',
  'Make no workspace changes.',
].join(' ');

describe('read-only repository evidence loop', () => {
  it('does not accept an answer until every requested evidence category is covered', async () => {
    const provider = new MockProvider();
    provider
      .enqueueText('I will inspect the repository.')
      .enqueueToolCall('read_file', { path: 'package.json' })
      .enqueueText('Package name: fixture')
      .enqueueToolCall('list_directory', { path: 'src', depth: 5 })
      .enqueueText('Package name: fixture; test file count: 2');

    const executor = new FakeToolExecutor();
    const context = new ContextManager('Read-only test agent.');
    context.addUserMessage(PROMPT);
    const loop = new AgentLoop(context, {
      workspaceRoot: '/workspace',
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new MockCheckpointManager() as never,
      auditService: new MockAuditService() as never,
      provider,
      executor,
      mode: 'ask',
      modelOverride: 'qwen3-coder:30b',
      maxIterations: 10,
    });

    let finalContent = '';
    const errors: string[] = [];
    const result = await loop.run(TOOL_CONTEXT, {
      onDone: content => { finalContent = content; },
      onError: error => errors.push(error),
    });

    expect(result.stoppedByLimit).toBe(false);
    expect(errors).toEqual([]);
    expect(executor.calls.map(call => call.toolCall.function.name)).toEqual([
      'read_file',
      'list_directory',
    ]);
    expect(provider.capturedRequests).toHaveLength(5);
    expect(provider.capturedRequests[2].messages.some(message =>
      message.role === 'user' && message.content.includes('directory entries via list_directory'),
    )).toBe(true);
    expect(finalContent).toContain('test file count: 2');
  });
});
