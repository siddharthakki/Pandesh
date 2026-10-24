import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { registerCommands } from '../../activation/registerCommands';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

class CommandReadinessProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;

  async healthCheck(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'command-model:latest' }];
  }

  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ProviderChatOptions,
  ): Promise<ChatResponse> {
    throw new Error('chat must not be called by diagnostics');
  }
}

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

function extensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: secretStorage(),
  } as vscode.ExtensionContext;
}

describe('M8.4 diagnostics command readiness UI', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diagnostics-command-'));
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.apiBase', 'http://localhost:11434');
    vscodeMock._setConfig('ollama-agent.chatModel', 'command-model:latest');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('exposes provider readiness through the existing diagnostics command', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new CommandReadinessProvider());
    const context = extensionContext();
    registerCommands(
      context,
      { stop: () => undefined, clearSession: () => undefined } as never,
      { dispose: () => undefined } as never,
      root,
    );

    const command = vscodeMock._registeredCommand('ollama-agent.runDiagnostics');
    expect(command).toBeTypeOf('function');
    await command?.();

    const items = vscodeMock._lastQuickPickItems() as Array<{ label: string; detail?: string }> | undefined;
    const readiness = items?.find(item => item.detail?.includes('Provider: ollama'));
    expect(readiness?.label).toContain('Configured provider and chat model are ready.');
    expect(readiness?.detail).toContain('Endpoint: http://localhost:11434');
    expect(readiness?.detail).toContain('Configured model: command-model:latest');
    expect(readiness?.detail).toContain('Model availability: available');
    expect(readiness?.detail).toContain('Discovered models: 1');
    expect(readiness?.detail).toContain('Status: passed');
  });
});
