import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentLoop } from '../../agent/AgentLoop';
import { ContextManager } from '../../agent/ContextManager';
import { TaskStore } from '../../agent/TaskStore';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { MockProvider } from '../mocks/MockProvider';
import { FakeToolExecutor } from '../mocks/FakeToolExecutor';
import { MockAuditService } from '../mocks/MockAuditService';
import { MockCheckpointManager } from '../mocks/MockCheckpointManager';
import { toolCallResponse, TOOL_CONTEXT } from '../fixtures/responses';

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Persist tool lifecycle',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('AgentLoop durable tool lifecycle', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_tool_lifecycle';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-tool-lifecycle-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  function makeLoop() {
    const provider = new MockProvider();
    const executor = new FakeToolExecutor();
    const context = new ContextManager('You are a helpful assistant.');
    context.addUserMessage('read the file');
    const loop = new AgentLoop(context, {
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new MockCheckpointManager() as never,
      auditService: new MockAuditService() as never,
      provider,
      mode: 'agent',
      modelOverride: 'qwen3-coder:30b',
      executor,
      taskStore: store,
      taskId,
    });
    return { loop, provider, executor };
  }

  it('persists tool_started before tool_completed', async () => {
    const { loop, provider } = makeLoop();
    provider.enqueue(toolCallResponse('read_file', { path: '/workspace/a.ts' }, 'call_lifecycle_1'));
    provider.enqueueText('done');

    await loop.run({ ...TOOL_CONTEXT, taskId }, {});

    const events = await store.getEvents(taskId);
    const lifecycle = events.events.filter(event =>
      event.type === 'tool_started' || event.type === 'tool_completed' || event.type === 'tool_failed',
    );
    expect(lifecycle.map(event => event.type)).toEqual(['tool_started', 'tool_completed']);
    expect(lifecycle[0].correlationId).toBe('call_lifecycle_1');
    expect(lifecycle[0].payload['mayMutate']).toBe(false);
    expect(lifecycle[1].payload['ok']).toBe(true);
  });

  it('persists failed tool outcomes', async () => {
    const { loop, provider, executor } = makeLoop();
    provider.enqueue(toolCallResponse('read_file', { path: '/workspace/missing.ts' }, 'call_lifecycle_2'));
    provider.enqueueText('done');
    executor.setResult('read_file', { ok: false, error: 'not found' });

    await loop.run({ ...TOOL_CONTEXT, taskId }, {});

    const events = await store.getEvents(taskId);
    const failed = events.events.find(event => event.type === 'tool_failed');
    expect(failed?.correlationId).toBe('call_lifecycle_2');
    expect(failed?.payload['error']).toBe('not found');
    expect(failed?.payload['ok']).toBe(false);
  });

  it('marks command attempts as potentially mutating for conservative recovery', async () => {
    const { loop, provider } = makeLoop();
    provider.enqueue(toolCallResponse('run_command', { command: 'npm test' }, 'call_lifecycle_3'));
    provider.enqueueText('done');

    await loop.run({ ...TOOL_CONTEXT, taskId }, {});

    const events = await store.getEvents(taskId);
    const started = events.events.find(event => event.type === 'tool_started');
    expect(started?.payload['mayMutate']).toBe(true);
  });
});
