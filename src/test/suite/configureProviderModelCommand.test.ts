import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import packageJson from '../../../package.json';
import {
  CONFIGURE_PROVIDER_MODEL_COMMAND,
  ConfigureProviderModelController,
} from '../../activation/ConfigureProviderModelController';
import { ProviderReadinessProbe } from '../../diagnostics/ProviderReadiness';
import { ModelInfo, ProviderChatOptions, InferenceProvider } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

class SelectionProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  healthCalls = 0;
  listCalls = 0;
  chatCalls = 0;
  models: ModelInfo[] = [];
  healthError?: unknown;
  listError?: unknown;

  async healthCheck(): Promise<void> {
    this.healthCalls += 1;
    if (this.healthError) {
      throw this.healthError;
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    this.listCalls += 1;
    if (this.listError) {
      throw this.listError;
    }
    return this.models;
  }

  async chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ProviderChatOptions,
  ): Promise<ChatResponse> {
    this.chatCalls += 1;
    return { message: { role: 'assistant', content: 'must not run' }, done: true };
  }
}

function controller(provider: SelectionProvider): ConfigureProviderModelController {
  return new ConfigureProviderModelController(new ProviderReadinessProbe(async () => provider));
}

describe('M8.5 configure provider model command', () => {
  beforeEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.apiBase', 'http://localhost:11434/');
    vscodeMock._setConfig('ollama-agent.chatModel', 'current-model');
  });

  afterEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
  });

  it('is contributed with the expected command title', () => {
    expect(packageJson.contributes.commands).toContainEqual({
      command: CONFIGURE_PROVIDER_MODEL_COMMAND,
      title: 'Configure Provider Model',
      category: 'KarkeDikha',
    });
  });

  it('runs readiness, lists sorted unique models, confirms and persists the verified choice', async () => {
    const provider = new SelectionProvider();
    provider.models = [{ name: 'zeta' }, { name: 'current-model' }, { name: 'alpha' }, { name: 'alpha' }];
    const command = controller(provider);

    vscodeMock._setQuickPickSelection({ label: 'zeta', modelName: 'zeta' });
    vscodeMock._setWarningMessageSelection('Update Model');
    await command.run();

    expect(provider.healthCalls).toBe(1);
    expect(provider.listCalls).toBe(1);
    expect(provider.chatCalls).toBe(0);
    const items = vscodeMock._lastQuickPickItems() as Array<{ label: string; description?: string }>;
    expect(items.map(item => item.label)).toEqual(['alpha', 'current-model', 'zeta']);
    expect(items.find(item => item.label === 'current-model')?.description).toBe('current chat model');
    expect(vscodeMock._lastWarningMessage()).toBe('Change KarkeDikha chat model from "current-model" to "zeta"?');
    expect(vscodeMock._configUpdates()).toEqual([
      { key: 'ollama-agent.chatModel', value: 'zeta', target: vscodeMock.ConfigurationTarget.Workspace },
    ]);
    expect(vscodeMock._lastInformationMessage()).toBe('KarkeDikha: chat model updated to "zeta".');
  });

  it('does not mutate settings for same-model selection', async () => {
    const provider = new SelectionProvider();
    provider.models = [{ name: 'current-model' }];
    vscodeMock._setQuickPickSelection({ label: 'current-model', modelName: 'current-model' });

    await controller(provider).run();

    expect(vscodeMock._configUpdates()).toHaveLength(0);
    expect(vscodeMock._lastInformationMessage()).toBe('KarkeDikha: chat model is already "current-model".');
  });

  it('does not mutate settings when quick pick is cancelled', async () => {
    const provider = new SelectionProvider();
    provider.models = [{ name: 'current-model' }, { name: 'next-model' }];

    await controller(provider).run();

    expect(vscodeMock._configUpdates()).toHaveLength(0);
    expect(vscodeMock._lastInformationMessage()).toBeUndefined();
  });

  it('does not mutate settings when confirmation is rejected', async () => {
    const provider = new SelectionProvider();
    provider.models = [{ name: 'current-model' }, { name: 'next-model' }];
    vscodeMock._setQuickPickSelection({ label: 'next-model', modelName: 'next-model' });

    await controller(provider).run();

    expect(vscodeMock._configUpdates()).toHaveLength(0);
    expect(vscodeMock._lastInformationMessage()).toBeUndefined();
  });

  it('handles empty model lists safely', async () => {
    const provider = new SelectionProvider();

    await controller(provider).run();

    expect(vscodeMock._lastQuickPickItems()).toBeUndefined();
    expect(vscodeMock._configUpdates()).toHaveLength(0);
    expect(vscodeMock._lastWarningMessage()).toBe('KarkeDikha: the provider returned no selectable models.');
  });

  it('prevents concurrent workflows', async () => {
    const provider = new SelectionProvider();
    let releaseHealth: () => void = () => undefined;
    provider.healthCheck = async () => {
      provider.healthCalls += 1;
      await new Promise<void>(resolve => {
        releaseHealth = resolve;
      });
    };
    provider.models = [{ name: 'current-model' }];
    const command = controller(provider);

    const first = command.run();
    await Promise.resolve();
    await command.run();
    releaseHealth();
    await first;

    expect(provider.healthCalls).toBe(1);
    expect(vscodeMock._lastWarningMessage()).toBe('KarkeDikha: provider model configuration is already running.');
  });

  it('does not show success or mutate settings after disposal', async () => {
    const provider = new SelectionProvider();
    let releaseHealth: () => void = () => undefined;
    provider.healthCheck = async () => {
      provider.healthCalls += 1;
      await new Promise<void>(resolve => {
        releaseHealth = resolve;
      });
    };
    provider.models = [{ name: 'current-model' }, { name: 'next-model' }];
    vscodeMock._setQuickPickSelection({ label: 'next-model', modelName: 'next-model' });
    vscodeMock._setWarningMessageSelection('Update Model');
    const command = controller(provider);

    const pending = command.run();
    await Promise.resolve();
    command.dispose();
    releaseHealth();
    await pending;

    expect(vscodeMock._configUpdates()).toHaveLength(0);
    expect(vscodeMock._lastInformationMessage()).toBeUndefined();
  });
});
