import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { ProviderReadinessProbe, providerReadinessDetail } from '../../diagnostics/ProviderReadiness';
import {
  InferenceProvider,
  ModelInfo,
  ProviderApiError,
  ProviderAuthError,
  ProviderChatOptions,
  ProviderConnectionError,
  ProviderTimeoutError,
} from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

class ReadinessProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  healthCalls = 0;
  listCalls = 0;
  chatCalls = 0;
  healthError?: unknown;
  listError?: unknown;
  models: ModelInfo[] = [{ name: 'ready-model:latest' }];

  async healthCheck(signal?: AbortSignal): Promise<void> {
    this.healthCalls += 1;
    if (signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
    if (this.healthError) {
      throw this.healthError;
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    this.listCalls += 1;
    if (signal?.aborted) {
      const error = new Error('aborted');
      error.name = 'AbortError';
      throw error;
    }
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
    return { message: { role: 'assistant', content: 'must not be used' }, done: true };
  }
}

describe('M8.4 provider readiness probe', () => {
  beforeEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.apiBase', 'http://localhost:11434/');
    vscodeMock._setConfig('ollama-agent.chatModel', 'ready-model:latest');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
  });

  it('reports a healthy configured model with provider metadata', async () => {
    const provider = new ReadinessProvider();
    provider.models = [{ name: 'other' }, { name: 'ready-model:latest' }];
    const result = await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal);

    expect(provider.healthCalls).toBe(1);
    expect(provider.listCalls).toBe(1);
    expect(provider.chatCalls).toBe(0);
    expect(result).toMatchObject({
      providerType: 'ollama',
      apiBase: 'http://localhost:11434',
      chatModel: 'ready-model:latest',
      reachability: 'ready',
      modelAvailability: 'available',
      discoveredModelCount: 2,
    });
    expect(result.failureCode).toBeUndefined();
    expect(providerReadinessDetail(result)).toContain('Status: passed');
  });

  it('reports a missing configured model with safe remediation and no chat call', async () => {
    const provider = new ReadinessProvider();
    provider.models = [{ name: 'different-model:latest' }];
    vscodeMock._setConfig('ollama-agent.chatModel', 'missing-model:latest');

    const result = await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal);
    const detail = providerReadinessDetail(result);

    expect(provider.healthCalls).toBe(1);
    expect(provider.listCalls).toBe(1);
    expect(provider.chatCalls).toBe(0);
    expect(result.failureCode).toBe('model_unavailable');
    expect(result.modelAvailability).toBe('unavailable');
    expect(detail).toContain('Next action: Install "missing-model:latest" with Ollama or select an installed model in ollama-agent.chatModel.');
  });

  it('does not list models when the provider is unreachable', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new ProviderConnectionError('raw ECONNREFUSED secret body', 'ollama', 'http://localhost:11434');

    const result = await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal);
    const detail = providerReadinessDetail(result);

    expect(provider.healthCalls).toBe(1);
    expect(provider.listCalls).toBe(0);
    expect(provider.chatCalls).toBe(0);
    expect(result.failureCode).toBe('provider_unreachable');
    expect(result.modelAvailability).toBe('not_checked');
    expect(detail).toContain('Next action: Start Ollama and verify ollama-agent.apiBase.');
    expect(detail).not.toContain('raw ECONNREFUSED');
  });

  it('sanitizes authentication failures', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new ProviderAuthError('raw sk-live-secret rejected', 'ollama');

    const detail = providerReadinessDetail(await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal));

    expect(detail).toContain('Failure code: authentication_failed');
    expect(detail).not.toContain('sk-live-secret');
    expect(detail).not.toContain('raw');
  });

  it('sanitizes timeouts', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new ProviderTimeoutError('raw timeout stack', 'ollama', 1);

    const detail = providerReadinessDetail(await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal));

    expect(detail).toContain('Failure code: timeout');
    expect(detail).toContain('Failure reason: The provider readiness check timed out.');
    expect(detail).not.toContain('raw timeout stack');
  });

  it('sanitizes provider API failures', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new ProviderApiError('raw HTTP body with stack trace', 'ollama', 500);

    const detail = providerReadinessDetail(await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal));

    expect(detail).toContain('Failure code: provider_failure');
    expect(detail).not.toContain('raw HTTP body');
    expect(detail).not.toContain('stack trace');
  });

  it('treats cancellation as cancelled and skips listing', async () => {
    const provider = new ReadinessProvider();
    const controller = new AbortController();
    controller.abort();

    const result = await new ProviderReadinessProbe(async () => provider).run(controller.signal);

    expect(provider.healthCalls).toBe(0);
    expect(provider.listCalls).toBe(0);
    expect(result.failureCode).toBe('cancelled');
    expect(providerReadinessDetail(result)).toContain('Failure reason: The diagnostics run was cancelled.');
  });

  it('maps unknown errors to provider_failure without raw message leakage', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new Error('raw unknown failure with prompt SHOULD_NOT_LEAK');

    const detail = providerReadinessDetail(await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal));

    expect(detail).toContain('Failure code: provider_failure');
    expect(detail).not.toContain('raw unknown failure');
    expect(detail).not.toContain('SHOULD_NOT_LEAK');
  });

  it('does not expose API keys, raw provider exceptions, HTTP bodies, stack traces, prompts or completions', async () => {
    const provider = new ReadinessProvider();
    provider.healthError = new ProviderApiError(
      'raw body sk-live-secret stack trace prompt-text completion-text',
      'ollama',
      500,
    );

    const detail = providerReadinessDetail(await new ProviderReadinessProbe(async () => provider).run(new AbortController().signal));

    expect(detail).not.toContain('sk-live-secret');
    expect(detail).not.toContain('raw body');
    expect(detail).not.toContain('stack trace');
    expect(detail).not.toContain('prompt-text');
    expect(detail).not.toContain('completion-text');
  });
});
