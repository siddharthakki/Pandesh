import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { Config } from '../../config/Config';
import { ProviderGateway } from '../../providers/ProviderGateway';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
  ProviderType,
} from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

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

class BlockingProvider implements InferenceProvider {
  readonly providerType: ProviderType = 'ollama';
  calls = 0;
  aborted = false;
  started!: () => void;
  readonly startedPromise = new Promise<void>(resolve => { this.started = resolve; });

  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: 'qwen3-coder:30b' }]; }

  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls += 1;
    this.started();
    return new Promise<ChatResponse>((_resolve, reject) => {
      if (signal?.aborted) {
        this.aborted = true;
        reject(new Error('cancelled'));
        return;
      }
      signal?.addEventListener('abort', () => {
        this.aborted = true;
        reject(new Error('cancelled'));
      }, { once: true });
    });
  }
}

describe('specialist workflow cancellation', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-role-cancel-'));
    vi.spyOn(Config, 'getSequentialRolesEnabled').mockReturnValue(true);
    vi.spyOn(Config, 'getTrustedAutonomyEnabled').mockReturnValue(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('stops immediately during Supervisor inference and does not fall back to implementation', async () => {
    const provider = new BlockingProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const runtime = new AgentRuntime(root, secretStorage());
    const stopped: boolean[] = [];

    const running = runtime.run(
      'Prepare a plan that should be cancelled.',
      'agent',
      { onStopped: () => stopped.push(true) },
      undefined,
      undefined,
      'cancel-specialist-task',
    );
    await provider.startedPromise;
    runtime.stop();
    await running;

    expect(provider.aborted).toBe(true);
    expect(provider.calls).toBe(1);
    expect(stopped).toHaveLength(1);

    const heartbeat = JSON.parse(await fs.readFile(
      path.join(runtime.taskStore.getTaskDir('cancel-specialist-task'), 'heartbeat.json'),
      'utf8',
    ));
    expect(heartbeat.stopped).toBe(true);
    expect(heartbeat.stage).toBe('stopped');
  });
});
