import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ModelCapabilityRegistry, type ModelCapability } from '../../models/ModelCapabilityRegistry';
import { BENCHMARK_FORCED_MODEL_ENV, benchmarkForcedModel } from '../../models/BenchmarkModel';
import { effectiveModelOverride } from '../../models/ModeModelOverride';
import { BENCHMARK_FORCED_CONTEXT_CAP, resolveModelContextLimit } from '../../reliability/ModelDispatchPlanner';
import {
  TaskModelSelectionError,
  classifyTaskRequirements,
  selectTaskModel,
  type TaskModelCandidate,
} from '../../models/TaskModelSelection';

function gptOssLike(overrides: Partial<TaskModelCandidate> & { capabilities?: Partial<ModelCapability> } = {}): TaskModelCandidate {
  const base = ModelCapabilityRegistry.getInstance().getCapabilities('gpt-oss:20b', 'ollama');
  const { capabilities, ...rest } = overrides;
  return {
    provider: 'ollama',
    model: 'gpt-oss:20b',
    available: true,
    capabilities: { ...base, contextWindow: 131_072, ...capabilities },
    configuredRoles: ['chat', 'agent', 'edit', 'reviewer'],
    reliability: 0.6, // well below every coding floor
    ...rest,
  };
}

// Same requirements AgentPanel derives for a Karke Dikha coding turn.
const codingTask = classifyTaskRequirements('Fix the negative amount bug.', {
  repositoryExploration: true, toolCalling: true, fileMutation: true, validationRepair: true, codingComplexity: 'low',
});

describe('model:test benchmark qualification', () => {
  beforeEach(() => ModelCapabilityRegistry.resetInstance());

  it('a GPT-OSS-like model below the reliability floor is benchmarkable when explicitly selected, and records why', () => {
    const result = selectTaskModel({
      provider: 'ollama',
      requirements: codingTask,
      candidates: [gptOssLike()],
      userOverride: { provider: 'ollama', model: 'gpt-oss:20b' },
    });
    expect(result.selectedModel).toBe('gpt-oss:20b');
    expect(result.overridden).toBe(true);
    expect(result.normalEligibility).toBe('below_preference_floor');
    expect(result.eligibilityReason).toMatch(/Reliability/);
  });

  it('a 1.5B-like generative model below the soft reliability floor is benchmarkable when explicitly selected', () => {
    const tiny = gptOssLike({
      model: 'qwen2.5-coder:1.5b',
      reliability: undefined,
      parameterBillions: 1.5,
      capabilities: { contextWindow: 32_768, tools: true, chat: true },
    });
    // Normal Auto selection refuses it: below the floor, with no stronger candidate this is only a fallback tier.
    const strong = gptOssLike({ model: 'strong:30b', reliability: 0.95 });
    const auto = selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [tiny, strong] });
    expect(auto.selectedModel).toBe('strong:30b');

    const forced = selectTaskModel({
      provider: 'ollama', requirements: codingTask, candidates: [tiny, strong],
      userOverride: { provider: 'ollama', model: 'qwen2.5-coder:1.5b' },
    });
    expect(forced.selectedModel).toBe('qwen2.5-coder:1.5b');
    expect(forced.overridden).toBe(true);
    expect(forced.normalEligibility).toBe('below_preference_floor');
    expect(forced.eligibilityReason).toMatch(/Reliability .* below required/);
  });

  it('the registry record: autocomplete-only / tools:false record for qwen2.5-coder:1.5b blocks normal override but not a benchmark-forced run the provider corroborates', () => {
    const registryTiny = () => {
      const base = ModelCapabilityRegistry.getInstance().getCapabilities('qwen2.5-coder:1.5b', 'ollama');
      return {
        provider: 'ollama', model: 'qwen2.5-coder:1.5b', available: true,
        capabilities: { ...base, contextWindow: 32_768 },
        configuredRoles: ['chat', 'agent', 'edit', 'reviewer'] as const,
        providerCapabilities: ['completion', 'tools', 'insert'],
      } satisfies TaskModelCandidate;
    };
    // Sanity: this is the real registry record that produced the live dead end.
    expect(registryTiny().capabilities.tools).toBe(false);
    expect(registryTiny().capabilities.allowedRoles).toEqual(['autocomplete']);

    // Production: an explicit (non-benchmark) override of that model is still refused.
    expect(() => selectTaskModel({
      provider: 'ollama', requirements: codingTask, candidates: [registryTiny()],
      userOverride: { provider: 'ollama', model: 'qwen2.5-coder:1.5b' },
    })).toThrowError(/incompatible/i);

    const forced = selectTaskModel({
      provider: 'ollama', requirements: codingTask, candidates: [registryTiny()],
      userOverride: { provider: 'ollama', model: 'qwen2.5-coder:1.5b' }, benchmarkForced: true,
    });
    expect(forced.selectedModel).toBe('qwen2.5-coder:1.5b');
    expect(forced.normalEligibility).toBe('hard_incompatible');
    expect(forced.eligibilityReason).toMatch(/Configured roles are not permitted/);
    // M49.2: the provider accepts the tool payload, so the model uses the prompted protocol and is NOT refused for
    // lacking native function calling; only the registry role policy remains.
    expect(forced.eligibilityReason).not.toMatch(/Tool calling is required/);
  });

  it('benchmark forcing never overrides provider-declared missing tools or structural incompatibility', () => {
    const noTools = gptOssLike({ capabilities: { tools: false }, providerCapabilities: ['completion'] });
    expect(() => selectTaskModel({
      provider: 'ollama', requirements: codingTask, candidates: [noTools],
      userOverride: { provider: 'ollama', model: 'gpt-oss:20b' }, benchmarkForced: true,
    })).toThrowError(/Tool calling is required/);
    for (const broken of [
      gptOssLike({ available: false }),
      gptOssLike({ capabilities: { contextWindow: 1_024 } }),
      gptOssLike({ model: 'nomic-embed-text:latest', configuredRoles: ['embedding'] }),
    ]) {
      expect(() => selectTaskModel({
        provider: 'ollama', requirements: codingTask, candidates: [broken],
        userOverride: { provider: 'ollama', model: broken.model }, benchmarkForced: true,
      })).toThrowError(TaskModelSelectionError);
    }
  });

  it('a hard refusal reports hard_incompatible with its actual reasons', () => {
    try {
      selectTaskModel({
        provider: 'ollama', requirements: codingTask,
        candidates: [gptOssLike({ capabilities: { tools: false } })],
        userOverride: { provider: 'ollama', model: 'gpt-oss:20b' },
      });
      expect.unreachable('tool-less model must be refused for a tool-calling task');
    } catch (error) {
      expect(error).toBeInstanceOf(TaskModelSelectionError);
      const refusal = error as TaskModelSelectionError;
      expect(refusal.code).toBe('override_incompatible');
      expect(refusal.normalEligibility).toBe('hard_incompatible');
      expect(refusal.hardReasons.join(' ')).toMatch(/Tool calling is required/);
    }
  });

  describe('forced benchmark model env', () => {
    const saved = process.env[BENCHMARK_FORCED_MODEL_ENV];
    afterEach(() => {
      if (saved === undefined) delete process.env[BENCHMARK_FORCED_MODEL_ENV];
      else process.env[BENCHMARK_FORCED_MODEL_ENV] = saved;
    });

    it('an unprofiled forced model uses its provider-declared context (capped); production and explicit overrides keep the 8K fallback', () => {
      const limit = (model: string, extra: { userOverride?: number; contextWindow?: number } = {}) => resolveModelContextLimit({
        model, providerType: 'ollama', userOverride: extra.userOverride,
        providerMetadata: { declaredContextWindow: 131_072, ...(extra.contextWindow ? { contextWindow: extra.contextWindow } : {}) },
      }).effectiveLimit;

      delete process.env[BENCHMARK_FORCED_MODEL_ENV];
      expect(limit('gpt-oss:20b')).toBe(8_192); // the production result that blocked the benchmark
      process.env[BENCHMARK_FORCED_MODEL_ENV] = 'gpt-oss:20b';
      expect(limit('gpt-oss:20b')).toBe(BENCHMARK_FORCED_CONTEXT_CAP);
      expect(limit('some-other:7b')).toBe(8_192); // only the forced model is affected
      expect(limit('gpt-oss:20b', { userOverride: 4_096 })).toBe(4_096);
      expect(limit('gpt-oss:20b', { contextWindow: 6_144 })).toBe(6_144); // measured runtime window still wins
    });

    it('forces the model for every mode only when set, and an explicit per-turn choice still wins', () => {
      delete process.env[BENCHMARK_FORCED_MODEL_ENV];
      expect(effectiveModelOverride(undefined, 'karke_dikha')).toBeUndefined();
      process.env[BENCHMARK_FORCED_MODEL_ENV] = 'qwen2.5-coder:1.5b';
      expect(effectiveModelOverride(undefined, 'karke_dikha')).toBe('qwen2.5-coder:1.5b');
      expect(effectiveModelOverride(undefined, 'baat_kar')).toBe('qwen2.5-coder:1.5b');
      expect(effectiveModelOverride('turn:1b', 'karke_dikha')).toBe('turn:1b');
    });
  });

  it('records normalEligibility "eligible" for a model that clears the floor and "unknown" when nothing is measured', () => {
    const eligible = selectTaskModel({
      provider: 'ollama', requirements: codingTask, candidates: [gptOssLike({ reliability: 0.95 })],
      userOverride: { provider: 'ollama', model: 'gpt-oss:20b' },
    });
    expect(eligible.normalEligibility).toBe('eligible');

    const editTask = classifyTaskRequirements('Edit x.', {
      repositoryExploration: false, toolCalling: false, fileMutation: true, validationRepair: false, codingComplexity: 'low',
    });
    const unmeasured = selectTaskModel({
      provider: 'ollama',
      requirements: editTask,
      candidates: [gptOssLike({ model: 'mystery', reliability: undefined, capabilities: { tools: false, structuredOutput: false, streaming: false } })],
      userOverride: { provider: 'ollama', model: 'mystery' },
    });
    expect(unmeasured.normalEligibility).toBe('unknown');
  });

  it('an embedding/reranker model stays hard-incompatible even when explicitly selected', () => {
    const embedding = gptOssLike({
      model: 'nomic-embed-text:latest',
      reliability: undefined,
      configuredRoles: ['embedding'],
    });
    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: classifyTaskRequirements('Explain this.'),
      candidates: [embedding],
      userOverride: { provider: 'ollama', model: 'nomic-embed-text:latest' },
    })).toThrowError(TaskModelSelectionError);
  });

  it('an unavailable model is still rejected (the runner reports PROVIDER_FAIL)', () => {
    const attempt = () => selectTaskModel({
      provider: 'ollama',
      requirements: codingTask,
      candidates: [gptOssLike({ available: false })],
      userOverride: { provider: 'ollama', model: 'gpt-oss:20b' },
    });
    expect(attempt).toThrowError(/not available/i);
  });

  it('a context window below the hard task minimum is still incompatible', () => {
    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: codingTask,
      candidates: [gptOssLike({ capabilities: { contextWindow: 1_024 } })],
      userOverride: { provider: 'ollama', model: 'gpt-oss:20b' },
    })).toThrowError(/context window/i);
  });

  it('normal (non-benchmark) selection semantics are unchanged: no override means Auto ranking, and no env means no forced model', () => {
    expect(benchmarkForcedModel({})).toBeUndefined();
    expect(benchmarkForcedModel({ [BENCHMARK_FORCED_MODEL_ENV]: '  ' })).toBeUndefined();
    expect(benchmarkForcedModel({ [BENCHMARK_FORCED_MODEL_ENV]: ' gpt-oss:20b ' })).toBe('gpt-oss:20b');

    const strong = gptOssLike({ model: 'strong:30b', reliability: 0.95 });
    const weak = gptOssLike({ reliability: 0.6 });
    const auto = selectTaskModel({ provider: 'ollama', requirements: codingTask, candidates: [weak, strong] });
    expect(auto.selectedModel).toBe('strong:30b');
    expect(auto.overridden).toBe(false);
    expect(auto.normalEligibility).toBe('eligible');
    // The floor still orders Auto: the weak model is never preferred over a model that clears it.
    expect(auto.rejectedCandidates.map(item => item.model)).toContain('gpt-oss:20b');
  });
});
