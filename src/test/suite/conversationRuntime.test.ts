import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULTS } from '../../config/Defaults';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

// chatModel/agentModel default to '' ("Auto" — see Defaults.ts); in real
// usage AgentPanel.loadModels() always runs discovery before a chat request
// can be sent (webview hydration precedes user input) and populates
// ResolvedModelDefaults with the model Auto actually selected. These tests
// simulate that same ordering rather than asserting against the now-empty
// literal, which would otherwise pass tautologically without exercising real
// dispatch behavior. Real ModelCapabilityRegistry-known names are used (not
// arbitrary placeholders) so context-window/capability-dependent logic sees
// the same values a genuine discovered model would have.
const AUTO_CHAT_MODEL = 'qwen2.5-coder:14b';
const AUTO_AGENT_MODEL = 'qwen3-coder:30b';

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('conversation-aware agent runtime', () => {
  let root: string;
  let provider: MockProvider;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-conversation-runtime-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    runtime = new AgentRuntime(root, secretStorage());
    ResolvedModelDefaults.clear();
    ResolvedModelDefaults.set('chat', AUTO_CHAT_MODEL);
    ResolvedModelDefaults.set('agent', AUTO_AGENT_MODEL);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the chat model by default for chat mode', async () => {
    provider.enqueueText('hello');

    await runtime.run('Hello there', 'chat', {}, undefined, undefined, 'conversation_chat_model');

    expect(provider.capturedRequests).toHaveLength(1);
    expect(provider.capturedRequests[0].options.model).toBe(AUTO_CHAT_MODEL);
  });

  it('uses the agent model by default for agent mode', async () => {
    provider.enqueueText('done');

    await runtime.run(
      'Inspect the repository',
      'agent',
      {},
      undefined,
      undefined,
      'conversation_agent_model',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
      },
    );

    expect(provider.capturedRequests[0].options.model).toBe(AUTO_AGENT_MODEL);
  });

  it('rejects a vision-only override for a text agent task', async () => {
    provider.enqueueText('done');

    await runtime.run(
      'Fix the code',
      'agent',
      {},
      undefined,
      'qwen2.5vl:7b',
      'conversation_agent_vision_override',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
      },
    );

    expect(provider.capturedRequests[0].options.model).toBe(AUTO_AGENT_MODEL);
    expect(provider.capturedRequests[0].tools.length).toBeGreaterThan(0);
  });

  it('rejects an embedding-only override for chat mode', async () => {
    provider.enqueueText('hello');

    await runtime.run(
      'Explain this project',
      'chat',
      {},
      undefined,
      'nomic-embed-text',
      'conversation_chat_embedding_override',
    );

    expect(provider.capturedRequests[0].options.model).toBe(AUTO_CHAT_MODEL);
  });

  it('uses the configured vision model when images are attached', async () => {
    provider.enqueueText('image understood');

    await runtime.run(
      'Describe this screenshot',
      'chat',
      {},
      ['base64-image'],
      undefined,
      'conversation_vision',
    );

    expect(provider.capturedRequests[0].options.model).toBe(DEFAULTS.visionModel);
    expect(provider.capturedRequests[0].tools).toHaveLength(0);
  });

  it('forks a clean durable task for a follow-up after the previous turn completed', async () => {
    provider.enqueueText('first response');
    provider.enqueueText('second response');
    const conversationId = 'conversation_multi_turn';

    await runtime.run('First question', 'chat', {}, undefined, undefined, conversationId);
    const firstTaskId = runtime.getTaskId();
    expect(firstTaskId).toBe(conversationId);
    expect((await runtime.getTask(conversationId)).phase).toBe('completed');

    await expect(
      runtime.run('Follow-up question', 'chat', {}, undefined, undefined, conversationId),
    ).resolves.toBeUndefined();

    const secondTaskId = runtime.getTaskId();
    expect(secondTaskId).toBeDefined();
    expect(secondTaskId).not.toBe(firstTaskId);
    expect(secondTaskId).toMatch(/^conversation_multi_turn_turn_/);
    expect((await runtime.getTask(conversationId)).task.taskId).toBe(secondTaskId);
    expect((await runtime.getTask(conversationId)).phase).toBe('completed');

    const secondRequest = provider.capturedRequests[1];
    const userContent = secondRequest.messages
      .filter(message => message.role === 'user')
      .map(message => message.content)
      .join('\n');
    expect(userContent).toContain('Follow-up question');
    expect(userContent).not.toContain('Conversation history from the previous completed turn');
    expect(userContent).not.toContain('First question');
  });

  it.each(['blocked', 'paused'] as const)(
    'forks a clean task instead of silently continuing a %s task',
    async phase => {
      const conversationId = `conversation_${phase}`;
      await runtime.taskStore.createTask({
        taskId: conversationId,
        workspaceId: root,
        workspaceRoot: root,
        userGoal: 'Fix the Jest configuration and rewrite tests',
        mode: 'agent',
        model: DEFAULTS.agentModel,
        providerType: 'ollama',
      });
      await runtime.taskStore.updateTask(conversationId, {
        phase,
        status: phase,
        resumePhase: 'executing',
      });
      await runtime.taskStore.appendMessage(conversationId, {
        role: 'user',
        content: 'Fix the Jest configuration and rewrite tests',
        timestamp: new Date().toISOString(),
      });
      await runtime.taskStore.appendMessage(conversationId, {
        role: 'assistant',
        content: 'I will inspect all test files and modify the Jest setup.',
        timestamp: new Date().toISOString(),
      });
      provider.enqueueText('fresh response');

      await runtime.run(
        'Create only docs/agent-smoke-test.md',
        'chat',
        {},
        undefined,
        undefined,
        conversationId,
      );

      const newTaskId = runtime.getTaskId();
      expect(newTaskId).toBeDefined();
      expect(newTaskId).not.toBe(conversationId);
      expect(newTaskId).toMatch(new RegExp(`^${conversationId}_turn_`));

      const sent = provider.capturedRequests[0].messages
        .filter(message => message.role === 'user')
        .map(message => message.content)
        .join('\n');
      expect(sent).toContain('Create only docs/agent-smoke-test.md');
      expect(sent).not.toContain('Fix the Jest configuration');
      expect(sent).not.toContain('Conversation history from the previous completed turn');
    },
  );

  it('flattens incomplete legacy tool protocol before provider resume', async () => {
    const taskId = 'conversation_legacy_tool_history';
    await runtime.taskStore.createTask({
      taskId,
      workspaceId: root,
      workspaceRoot: root,
      userGoal: 'resume safely',
      mode: 'chat',
      model: DEFAULTS.chatModel,
      providerType: 'openai-compatible',
    });
    await runtime.taskStore.updateTask(taskId, {
      phase: 'paused',
      status: 'paused',
      resumePhase: 'executing',
    });
    await runtime.taskStore.appendMessage(taskId, {
      role: 'assistant',
      content: '',
      toolCallIds: ['call_legacy'],
      timestamp: new Date().toISOString(),
    });
    await runtime.taskStore.appendMessage(taskId, {
      role: 'tool',
      content: '{"ok":true}',
      timestamp: new Date().toISOString(),
    });
    provider.enqueueText('resumed safely');

    await runtime.resumeTask(taskId);

    const sent = provider.capturedRequests[0].messages;
    expect(sent.some(message => message.role === 'assistant' && message.tool_calls?.length)).toBe(false);
    expect(sent.some(message => message.role === 'tool')).toBe(false);
    expect(sent.some(message => message.role === 'user' && message.content.includes('Recovered prior tool result'))).toBe(true);
  });
});
