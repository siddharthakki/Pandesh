import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { AgentLoop, IToolExecutor } from '../../agent/AgentLoop';
import { ContextManager, boundInjectedContextForDispatch } from '../../agent/ContextManager';
import { Config } from '../../config/Config';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { AuditService } from '../../services/AuditService';
import { CheckpointManager } from '../../agent/CheckpointManager';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  StreamEvent,
} from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolCall, ToolDefinition, ToolResult } from '../../tools/ToolTypes';

interface ProviderRequest {
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: ProviderChatOptions;
}

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly requests: ProviderRequest[] = [];
  private responseIndex = 0;

  constructor(
    private readonly responses: ChatResponse[],
    private readonly streamedText?: string,
  ) {}

  async healthCheck(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'qwen3-coder:30b', contextWindow: 16_384 }];
  }

  async getModelContextMetadata(): Promise<ModelInfo> {
    return {
      name: 'qwen3-coder:30b',
      contextWindow: 16_384,
      declaredContextWindow: 32_768,
    };
  }

  async chat(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
  ): Promise<ChatResponse> {
    this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools), options: { ...options } });
    const response = this.responses[this.responseIndex++];
    if (!response) throw new Error('No scripted provider response remains.');
    return response;
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    options: ProviderChatOptions,
  ): AsyncIterable<StreamEvent> {
    this.requests.push({ messages: structuredClone(messages), tools: structuredClone(tools), options: { ...options } });
    const content = this.streamedText ?? this.responses[this.responseIndex++]?.message.content ?? '';
    if (content) yield { type: 'token', delta: content };
    yield { type: 'done', content };
  }
}

class FileWritingExecutor implements IToolExecutor {
  readonly calls: ToolCall[] = [];

  async execute(call: ToolCall, context: { workspaceRoot: string }): Promise<ToolResult> {
    this.calls.push(call);
    if (call.function.name !== 'write_file') {
      return { ok: false, error: `Unexpected tool: ${call.function.name}` };
    }
    const relativePath = String(call.function.arguments['path'] ?? '');
    const content = String(call.function.arguments['content'] ?? '');
    await fs.writeFile(path.join(context.workspaceRoot, relativePath), content, 'utf8');
    return { ok: true, data: { path: relativePath, bytes: Buffer.byteLength(content, 'utf8') } };
  }
}

function configureDeterministicDispatch(): void {
  vi.spyOn(Config, 'getContextWindowSetting').mockReturnValue({
    value: 16_384,
    explicitlyConfigured: true,
    source: 'user',
  });
  vi.spyOn(Config, 'getMaxOutputTokensSetting').mockReturnValue({
    value: 0,
    explicitlyConfigured: false,
    source: 'default',
  });
  vi.spyOn(Config, 'getTemperatureSetting').mockReturnValue({
    value: 0.2,
    explicitlyConfigured: false,
    source: 'default',
  });
  vi.spyOn(Config, 'getRequestTimeoutMs').mockReturnValue(5_000);
  vi.spyOn(Config, 'getMaxToolOutputChars').mockReturnValue(20_000);
}

function makeLoop(
  workspaceRoot: string,
  mode: 'chat' | 'agent',
  provider: InferenceProvider,
  executor?: IToolExecutor,
): { loop: AgentLoop; context: ContextManager } {
  const context = new ContextManager(`System prompt for ${mode}`);
  const loop = new AgentLoop(context, {
    workspaceRoot,
    approvalFlow: new ApprovalFlow(),
    checkpointManager: new CheckpointManager(workspaceRoot),
    auditService: new AuditService(workspaceRoot),
    provider,
    modelOverride: 'qwen3-coder:30b',
    mode,
    executor,
    maxIterations: 4,
  });
  return { loop, context };
}

describe('Baat Kar and Saath Kar response path', () => {
  let workspaceRoot: string;

  beforeEach(async () => {
    configureDeterministicDispatch();
    workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'karkedikha-chat-response-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(workspaceRoot, { recursive: true, force: true });
  });

  it('returns and streams the correct Baat Kar answer for a basic prompt', async () => {
    const provider = new ScriptedProvider([], '4');
    const { loop, context } = makeLoop(workspaceRoot, 'chat', provider);
    context.addUserMessage('What is 2 + 2? Reply with only the number.');

    const tokens: string[] = [];
    const completed: string[] = [];
    const errors: string[] = [];
    const result = await loop.run({
      workspaceRoot,
      sessionId: 'chat-test',
      turnId: 'turn-1',
      model: 'qwen3-coder:30b',
      mode: 'chat',
    }, {
      onToken: token => tokens.push(token),
      onDone: content => completed.push(content),
      onError: message => errors.push(message),
    });

    expect(errors).toEqual([]);
    expect(tokens.join('')).toBe('4');
    expect(completed).toEqual(['4']);
    expect(result.finalContent).toBe('4');
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].tools).toEqual([]);
    expect(provider.requests[0].messages.at(-1)?.content).toContain('What is 2 + 2?');
  });

  it('executes a simple Saath Kar file request and returns a visible completion', async () => {
    const source = [
      'def is_prime(number: int) -> bool:',
      '    if number < 2:',
      '        return False',
      '    return all(number % divisor for divisor in range(2, int(number ** 0.5) + 1))',
      '',
      'print([number for number in range(2, 21) if is_prime(number)])',
      '',
    ].join('\n');
    const provider = new ScriptedProvider([
      {
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'write-primes',
            function: {
              name: 'write_file',
              arguments: { path: 'primes.py', content: source },
            },
          }],
        },
        done: false,
      },
      {
        message: {
          role: 'assistant',
          content: 'Created primes.py. It prints the prime numbers from 2 through 20.',
        },
        done: true,
      },
    ]);
    const executor = new FileWritingExecutor();
    const { loop, context } = makeLoop(workspaceRoot, 'agent', provider, executor);
    context.addUserMessage('Create a Python file named primes.py that prints prime numbers up to 20.');

    const completed: string[] = [];
    const errors: string[] = [];
    const result = await loop.run({
      workspaceRoot,
      sessionId: 'agent-test',
      turnId: 'turn-1',
      model: 'qwen3-coder:30b',
      mode: 'agent',
    }, {
      onDone: content => completed.push(content),
      onError: message => errors.push(message),
    });

    expect(errors).toEqual([]);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].function).toMatchObject({
      name: 'write_file',
      arguments: { path: 'primes.py' },
    });
    expect(await fs.readFile(path.join(workspaceRoot, 'primes.py'), 'utf8')).toBe(source);
    expect(completed).toEqual(['Created primes.py. It prints the prime numbers from 2 through 20.']);
    expect(result.finalContent).toContain('Created primes.py');
    expect(provider.requests[0].tools.some(tool => tool.function.name === 'write_file')).toBe(true);
    expect(provider.requests).toHaveLength(2);
  });

  it('truncates only oversized automatically injected context and preserves the user request', () => {
    const injected = [
      '## system: frontier-context',
      'Repository guardrails.',
      '',
      'Current user request:',
      'Create primes.py that prints prime numbers up to 20.',
      '',
      '## code: repository-context-service',
      'x'.repeat(80_000),
    ].join('\n');

    const bounded = boundInjectedContextForDispatch(injected, 16_384);
    expect(bounded.length).toBeLessThanOrEqual(Math.floor(16_384 * 1.5));
    expect(bounded).toContain('Create primes.py that prints prime numbers up to 20.');
    expect(bounded).toContain('repository context truncated');

    const ordinaryUserText = 'x'.repeat(80_000);
    expect(boundInjectedContextForDispatch(ordinaryUserText, 16_384)).toBe(ordinaryUserText);
  });
});
