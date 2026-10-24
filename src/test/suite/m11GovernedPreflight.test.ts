import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { GovernedModelExecutionDispatcher } from '../../agent/GovernedModelExecutionDispatcher';
import { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { ProviderGatewayGovernedModelExecutionDependency } from '../../agent/ProviderGatewayGovernedModelExecutionDependency';
import { MockProvider } from '../mocks/MockProvider';

class OpenAICompatibleMockProvider extends MockProvider {
  override readonly providerType = 'openai-compatible' as const;
}

function baseRequest(overrides: Partial<GovernedModelRequest> = {}): GovernedModelRequest {
  return {
    contractVersion: 1,
    requestId: 'req_m11',
    invocationId: 'inv_m11',
    taskId: 'task_m11',
    model: 'qwen2.5-coder:7b',
    prompt: 'Summarize the current diff.',
    ...overrides,
  };
}

beforeEach(() => {
  vscodeMock._resetConfig();
});

afterEach(() => {
  vscodeMock._resetConfig();
  vi.restoreAllMocks();
});

describe('M11 governed execution shared preflight (Blocker 2)', () => {
  it('dispatches a safe governed request exactly once and attaches context evidence', async () => {
    const provider = new MockProvider();
    provider.enqueueText('Here is the summary.');
    const chatSpy = vi.spyOn(provider, 'chat');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);

    const result = await dispatcher.dispatch(baseRequest());

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.evidence.context).toBeDefined();
    expect(result.evidence.context?.profileId).toBe('qwen-coder-local');
    expect(result.evidence.context?.effectiveContextLimit).toBe(32768);
    expect(result.evidence.context?.projectedTotalTokens).toBeGreaterThan(0);
    expect(result.evidence.context?.status).toBe('safe');
  });

  it('blocks an oversized governed request with zero provider calls and non-raw evidence', async () => {
    vscodeMock._setConfig('ollama-agent.contextWindow', 600);
    const secretPrompt = `SECRET-GOVERNED-PROMPT ${'x'.repeat(8000)}`;
    const provider = new MockProvider();
    const chatSpy = vi.spyOn(provider, 'chat');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);

    const result = await dispatcher.dispatch(baseRequest({ prompt: secretPrompt }));

    expect(chatSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('execution_rejected');
    expect(result.evidence.context?.status).toBe('blocked');
    expect(result.evidence.context?.effectiveContextLimit).toBe(600);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('SECRET-GOVERNED-PROMPT');
    expect(serialized).not.toContain('xxxx');
  });

  it('sends the exact shared-preflight provider options (reserve equals request)', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest());

    expect(provider.capturedRequests).toHaveLength(1);
    const options = provider.capturedRequests[0].options;
    expect(options.contextWindow).toBe(32768);
    expect(options.maxOutputTokens).toBeGreaterThan(0);
    expect(outcome.contextEvidence?.outputReserveTokens).toBe(options.maxOutputTokens);
  });

  it('keeps cancellation authoritative: a pre-aborted request never reaches the provider', async () => {
    const provider = new MockProvider();
    const chatSpy = vi.spyOn(provider, 'chat');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const controller = new AbortController();
    controller.abort();

    const result = await dispatcher.dispatch(baseRequest({ signal: controller.signal }));

    expect(chatSpy).not.toHaveBeenCalled();
    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
  });

  it('keeps in-flight cancellation intact through the shared preflight path', async () => {
    const provider = new MockProvider();
    const controller = new AbortController();
    vi.spyOn(provider, 'chat').mockImplementation(async () => {
      controller.abort();
      throw new Error('aborted mid-flight');
    });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);

    const result = await dispatcher.dispatch(baseRequest({ signal: controller.signal }));

    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
  });
});

describe('M11 governed structured output through the shared decision (Blocker 7)', () => {
  const format = { type: 'json_schema' as const, name: 'coding_plan', schema: { type: 'object' } };

  it('attaches the format for an Ollama provider with a capable profile', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest({ responseFormat: format }));

    expect(provider.capturedRequests[0].options.responseFormat).toEqual(format);
    expect(outcome.contextEvidence?.structuredOutput).toMatchObject({ requested: true, active: true });
  });

  it('withholds the format from an OpenAI-compatible endpoint whose profile lacks json_schema', async () => {
    const provider = new OpenAICompatibleMockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest({ responseFormat: format }));

    expect(provider.capturedRequests[0].options.responseFormat).toBeUndefined();
    expect(outcome.contextEvidence?.structuredOutput).toMatchObject({
      requested: true,
      active: false,
      deferredReason: 'provider_restriction',
    });
  });
});
