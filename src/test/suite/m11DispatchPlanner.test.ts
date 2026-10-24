import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { Config } from '../../config/Config';
import { ProviderApiError } from '../../providers/ProviderTypes';
import { classifyProviderError, isProviderContextOverflow } from '../../agent/AgentLoop';
import {
  computeEffectiveMaxOutputTokens,
  ModelDispatchPlanner,
  OLLAMA_VISION_MINIMUM_CONTEXT,
  resolveTemperature,
} from '../../reliability/ModelDispatchPlanner';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { MockProvider } from '../mocks/MockProvider';

const qwenProfile = ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama');

class OpenAICompatibleMockProvider extends MockProvider {
  override readonly providerType = 'openai-compatible' as const;
}

beforeEach(() => {
  vscodeMock._resetConfig();
});

afterEach(() => {
  vscodeMock._resetConfig();
});

describe('M11 typed configuration resolution (Blocker 3)', () => {
  it('treats the built-in default as not explicitly configured', () => {
    const setting = Config.getContextWindowSetting();
    expect(setting.value).toBe(8192);
    expect(setting.explicitlyConfigured).toBe(false);
    expect(setting.source).toBe('default');
  });

  it('treats a user-set value as an explicit override', () => {
    vscodeMock._setConfig('ollama-agent.contextWindow', 12000);
    const setting = Config.getContextWindowSetting();
    expect(setting.value).toBe(12000);
    expect(setting.explicitlyConfigured).toBe(true);
    expect(setting.source).toBe('user');
  });

  it('does not let the default configuration mask provider runtime metadata', async () => {
    const provider = new MockProvider();
    provider.modelContextMetadata = { name: 'qwen3-coder:30b', contextWindow: 24576 };
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
    });
    expect(session.limit.provenance).toBe('provider_runtime');
    expect(session.limit.effectiveLimit).toBe(24576);
    expect(session.limit.userOverride).toBeUndefined();
  });

  it('uses profile detection when no override and no provider runtime metadata exist', async () => {
    const provider = new MockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
    });
    expect(session.limit.provenance).toBe('profile_operational');
    expect(session.limit.effectiveLimit).toBe(32768);
  });

  it('lets an explicit user override defeat provider runtime metadata', async () => {
    vscodeMock._setConfig('ollama-agent.contextWindow', 4096);
    const provider = new MockProvider();
    provider.modelContextMetadata = { name: 'qwen3-coder:30b', contextWindow: 24576 };
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
    });
    expect(session.limit.provenance).toBe('user_override');
    expect(session.limit.effectiveLimit).toBe(4096);
  });
});

describe('M11 authoritative output allowance (Blocker 4)', () => {
  const explicit = (value: number) => ({ value, explicitlyConfigured: true, source: 'user' as const });
  const byDefault = (value: number) => ({ value, explicitlyConfigured: false, source: 'default' as const });

  it('caps a requested output larger than 15% of the context', () => {
    expect(computeEffectiveMaxOutputTokens(explicit(10_000), qwenProfile, 32768)).toBe(4915);
  });

  it('honors an explicit request below the cap exactly', () => {
    expect(computeEffectiveMaxOutputTokens(explicit(1024), qwenProfile, 32768)).toBe(1024);
  });

  it('falls back to the profile reserve for zero/invalid/default configuration', () => {
    expect(computeEffectiveMaxOutputTokens(explicit(0), qwenProfile, 32768)).toBe(qwenProfile.safeOutputReserve);
    expect(computeEffectiveMaxOutputTokens(explicit(-5), qwenProfile, 32768)).toBe(qwenProfile.safeOutputReserve);
    expect(computeEffectiveMaxOutputTokens(explicit(Number.NaN), qwenProfile, 32768)).toBe(qwenProfile.safeOutputReserve);
    expect(computeEffectiveMaxOutputTokens(byDefault(0), qwenProfile, 32768)).toBe(qwenProfile.safeOutputReserve);
  });

  it('keeps a usable floor on small contexts', () => {
    expect(computeEffectiveMaxOutputTokens(explicit(2048), qwenProfile, 1000)).toBe(512);
  });

  it('sends exactly the reserved amount to the provider', async () => {
    vscodeMock._setConfig('ollama-agent.maxOutputTokens', 777);
    const provider = new MockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
    });
    const preflight = session.preflight([{ role: 'user', content: 'hello' }], []);
    expect(session.options.maxOutputTokens).toBe(777);
    expect(preflight.outputReserve).toBe(777);
  });

  it('preserves an intentional temperature of 0', () => {
    expect(resolveTemperature({ value: 0, explicitlyConfigured: true, source: 'user' }, qwenProfile)).toBe(0);
    expect(resolveTemperature({ value: 0.7, explicitlyConfigured: false, source: 'default' }, qwenProfile))
      .toBe(qwenProfile.preferredTemperature);
  });
});

describe('M11 vision minimum resolved before preflight (Blocker 6)', () => {
  it('raises the Ollama context to the vision minimum and reflects it in options and limit', async () => {
    const provider = new MockProvider();
    provider.modelContextMetadata = { name: 'qwen2.5vl:7b', contextWindow: 8192 };
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen2.5vl:7b',
      provider,
      toolsActive: false,
      hasImages: true,
    });
    expect(session.limit.effectiveLimit).toBe(OLLAMA_VISION_MINIMUM_CONTEXT);
    expect(session.limit.visionMinimumApplied).toBe(true);
    expect(session.options.contextWindow).toBe(OLLAMA_VISION_MINIMUM_CONTEXT);
    const preflight = session.preflight([{ role: 'user', content: 'describe', images: ['aGk='] }], []);
    expect(preflight.limit.effectiveLimit).toBe(session.options.contextWindow);
  });

  it('does not apply the Ollama vision minimum to OpenAI-compatible providers', async () => {
    const provider = new OpenAICompatibleMockProvider();
    provider.modelContextMetadata = { name: 'some-vl-model', contextWindow: 8192 };
    const session = await ModelDispatchPlanner.createSession({
      model: 'some-vl-model',
      provider,
      toolsActive: false,
      hasImages: true,
    });
    expect(session.limit.visionMinimumApplied).toBe(false);
    expect(session.options.contextWindow).toBe(8192);
  });
});

describe('M11 structured-output decision (Blocker 7)', () => {
  const format = { type: 'json_schema' as const, name: 'plan', schema: { type: 'object' } };

  it('activates the format for an Ollama profile with structured-output support', async () => {
    const provider = new MockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput).toMatchObject({ requested: true, supported: true, active: true });
    expect(session.options.responseFormat).toEqual(format);
  });

  it('defers deterministically to native tools when tool definitions are active', async () => {
    const provider = new MockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput.active).toBe(false);
    expect(session.structuredOutput.deferredReason).toBe('native_tools_active');
    expect(session.options.responseFormat).toBeUndefined();
  });

  it('does not blindly send a JSON schema to OpenAI-compatible endpoints without json_schema capability', async () => {
    const provider = new OpenAICompatibleMockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b', // profile declares ollama_format, not json_schema
      provider,
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput.active).toBe(false);
    expect(session.structuredOutput.deferredReason).toBe('provider_restriction');
    expect(session.options.responseFormat).toBeUndefined();
  });

  it('activates response_format for OpenAI-compatible profiles declaring json_schema', async () => {
    const provider = new OpenAICompatibleMockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'glm-4:9b',
      provider,
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput.active).toBe(true);
    expect(session.options.responseFormat).toEqual(format);
  });

  it('marks unsupported profiles as unsupported and withholds the format', async () => {
    const provider = new OpenAICompatibleMockProvider();
    const session = await ModelDispatchPlanner.createSession({
      model: 'local-mystery:latest', // generic fallback profile: unsupported
      provider,
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: format,
    });
    expect(session.structuredOutput.supported).toBe(false);
    expect(session.structuredOutput.active).toBe(false);
    expect(session.structuredOutput.deferredReason).toBe('profile_unsupported');
    expect(session.options.responseFormat).toBeUndefined();
  });

  it('records the decision without a request as not_requested / native_tools_active', async () => {
    const provider = new MockProvider();
    const withTools = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: true,
      hasImages: false,
    });
    expect(withTools.structuredOutput.requested).toBe(false);
    expect(withTools.structuredOutput.deferredReason).toBe('native_tools_active');
    const withoutTools = await ModelDispatchPlanner.createSession({
      model: 'qwen3-coder:30b',
      provider,
      toolsActive: false,
      hasImages: false,
    });
    expect(withoutTools.structuredOutput.deferredReason).toBe('not_requested');
  });
});

describe('M11 fallback profile scoping (Blocker 14)', () => {
  it('matches known profiles by model on both local provider kinds', () => {
    expect(ModelProfileRegistry.resolve('glm-4:9b', 'openai-compatible').id).toBe('glm-coder-local');
    expect(ModelProfileRegistry.resolve('devstral:24b', 'openai-compatible').id).toBe('mistral-devstral-local');
    expect(ModelProfileRegistry.resolve('qwen3-coder:30b', 'ollama').id).toBe('qwen-coder-local');
  });

  it('keeps unknown local models conservative but lets provider runtime metadata override the 8K fallback', async () => {
    const conservative = new OpenAICompatibleMockProvider();
    const fallbackSession = await ModelDispatchPlanner.createSession({
      model: 'local-mystery:latest',
      provider: conservative,
      toolsActive: false,
      hasImages: false,
    });
    expect(fallbackSession.profile.fallback).toBe(true);
    expect(fallbackSession.limit.effectiveLimit).toBe(8192);
    expect(fallbackSession.limit.estimated).toBe(true);

    const informed = new OpenAICompatibleMockProvider();
    informed.modelContextMetadata = { name: 'local-mystery:latest', contextWindow: 65536 };
    const runtimeSession = await ModelDispatchPlanner.createSession({
      model: 'local-mystery:latest',
      provider: informed,
      toolsActive: false,
      hasImages: false,
    });
    expect(runtimeSession.limit.provenance).toBe('provider_runtime');
    expect(runtimeSession.limit.effectiveLimit).toBe(65536);
  });
});

describe('M11 provider overflow classification (Blocker 13)', () => {
  it.each([
    'This model\'s maximum context length is 32768 tokens.',
    'context window exceeded for request',
    'the prompt is too long for this model',
    'num_ctx exceeded',
  ])('classifies genuine context overflow: %s', message => {
    const error = new ProviderApiError(message, 'ollama', 400);
    expect(isProviderContextOverflow(error)).toBe(true);
    expect(classifyProviderError(error)).toContain('provider_context_overflow');
  });

  it.each([
    'Invalid authentication token provided.',
    'API token is missing or expired.',
    'token quota exhausted for this account',
    'unexpected token in JSON at position 3',
  ])('keeps unrelated token errors in their original classification: %s', message => {
    const error = new ProviderApiError(message, 'ollama', 400);
    expect(isProviderContextOverflow(error)).toBe(false);
    expect(classifyProviderError(error)).not.toContain('provider_context_overflow');
  });

  it('never classifies non-API errors as overflow', () => {
    expect(isProviderContextOverflow(new Error('maximum context length'))).toBe(false);
  });
});
