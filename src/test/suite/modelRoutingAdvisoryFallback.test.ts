import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { ModelCapabilityRegistry, type ModelCapability } from '../../models/ModelCapabilityRegistry';
import {
  TaskModelSelectionError,
  classifyTaskRequirements,
  selectTaskModel,
  type TaskModelCandidate,
} from '../../models/TaskModelSelection';
import { buildProductionTaskModelCandidates } from '../../models/ProductionModelCandidates';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import type { ModelRole } from '../../providers/InferenceTypes';

/**
 * Regression coverage for the HARD/ADVISORY conflation fix in
 * `selectTaskModel` (TaskModelSelection.ts): a candidate with no
 * `hardReasons` but non-empty `advisoryReasons` (e.g. reliability below the
 * task's *preferred* floor, or no size evidence) is technically VIABLE.
 * UNKNOWN != INCOMPATIBLE — automatic selection must use it as the best
 * available fallback when no higher-confidence candidate exists, rather than
 * failing closed with `no_capable_model`. Genuine hard incompatibilities
 * (unavailable, missing required capability, insufficient context, ...)
 * still block automatic selection AND an explicit override, unchanged.
 *
 * See also:
 * - m34TaskModelSelection.test.ts — unit-level candidate evaluation.
 * - openAICompatibleLocalReadiness.test.ts group D — the original
 *   unmeasured-model advisory/override contract this bug pattern mirrors.
 * - investigationLoopReliability.test.ts — bounded recovery (empty_content /
 *   invalid_action / repair / cloud-escalation) this change does not touch.
 */

function candidate(
  model: string,
  roles: readonly ModelRole[],
  options: Partial<Omit<TaskModelCandidate, 'provider' | 'model' | 'available' | 'capabilities' | 'configuredRoles'>> & {
    provider?: string;
    available?: boolean;
    capabilities?: Partial<ModelCapability>;
  } = {},
): TaskModelCandidate {
  const provider = options.provider ?? 'ollama';
  const registry = ModelCapabilityRegistry.getInstance();
  // 32768 keeps context out of the way for the karkeRequirements() (16384)
  // fixture below unless a test deliberately overrides it — these tests are
  // about the HARD/ADVISORY reliability distinction, not context sizing
  // (already covered by m41RuntimeContextMetadataSelection.test.ts).
  const base = { ...registry.getCapabilities(model, provider), contextWindow: 32_768 };
  return {
    provider,
    model,
    available: options.available ?? true,
    capabilities: { ...base, ...options.capabilities },
    configuredRoles: roles,
    cost: options.cost,
    // Mirrors ProductionModelCandidates.ts: real candidates get their
    // observed-reliability evidence from the registry unless a test
    // overrides it, so a curated/proven model here behaves exactly like it
    // would in production, not like an unmeasured one.
    reliability: options.reliability ?? registry.getObservedReliability(model),
    parameterBillions: options.parameterBillions,
    automaticSelectionExcluded: options.automaticSelectionExcluded,
  };
}

// A Karke-Dikha-shaped requirement set (medium complexity + validation/repair)
// is the exact shape that produces the 0.82 preferred-reliability floor —
// the floor the original gpt-oss:20b failure sat just below (0.79).
function karkeRequirements() {
  return classifyTaskRequirements('', {
    repositoryExploration: true,
    toolCalling: true,
    fileMutation: true,
    validationRepair: true,
    codingComplexity: 'medium',
  });
}

describe('Model routing: HARD vs ADVISORY semantics for automatic selection', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });

  it('A. unknown model, advisory-only: automatic selection chooses it when no higher-confidence candidate exists', () => {
    const result = selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [candidate('mystery-model:20b', ['agent', 'edit', 'reviewer'], { reliability: 0.79 })],
    });

    expect(result.selectedModel).toBe('mystery-model:20b');
    expect(result.overridden).toBe(false);
    expect(result.belowPreferredConfidence).toBe(true);
    expect(result.rejectedCandidates).toEqual([]);
    expect(result.diagnostics.join(' ')).toMatch(/Reliability 0\.79 is below required 0\.82/);
  });

  it('B. a higher-confidence viable candidate is preferred over an advisory-only one', () => {
    const strong = candidate('proven-model:30b', ['agent', 'edit', 'reviewer'], { reliability: 0.9 });
    const risky = candidate('unproven-model:20b', ['agent', 'edit', 'reviewer'], { reliability: 0.6 });

    const result = selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [risky, strong],
    });

    expect(result.selectedModel).toBe('proven-model:30b');
    expect(result.belowPreferredConfidence).toBe(false);
    // The advisory-only candidate is still surfaced, but as a rejection —
    // it was not selected, unlike the other tests here.
    expect(result.rejectedCandidates.map(r => r.model)).toContain('unproven-model:20b');
  });

  it('C. a hard incompatibility is never automatically selected, however high its reliability score', () => {
    const highScoreButIncompatible = candidate('fast-but-incompatible:70b', ['agent', 'edit', 'reviewer'], {
      reliability: 0.99,
      capabilities: { tools: false }, // required by karkeRequirements() (toolCalling: true)
    });

    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [highScoreButIncompatible],
    })).toThrowError(expect.objectContaining({ code: 'no_capable_model' }));

    try {
      selectTaskModel({ provider: 'ollama', requirements: karkeRequirements(), candidates: [highScoreButIncompatible] });
    } catch (error) {
      const rejected = (error as TaskModelSelectionError).rejectedCandidates;
      expect(rejected[0]?.hardReasons).toContain('Tool calling is required.');
    }
  });

  it('D. every candidate hard-incompatible: no_capable_model, and none is silently promoted', () => {
    const candidates = [
      candidate('no-tools:7b', ['agent', 'edit'], { capabilities: { tools: false } }),
      candidate('unavailable:30b', ['agent', 'edit'], { available: false }),
    ];

    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates,
    })).toThrowError(expect.objectContaining({ code: 'no_capable_model' }));
  });

  it('E. an explicit user override on a technically-viable advisory model retains existing override semantics', () => {
    const risky = candidate('unproven-model:20b', ['agent', 'edit', 'reviewer'], { reliability: 0.6 });
    const result = selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [risky],
      userOverride: { provider: 'ollama', model: 'unproven-model:20b' },
    });

    expect(result.selectedModel).toBe('unproven-model:20b');
    expect(result.overridden).toBe(true);
    expect(result.belowPreferredConfidence).toBe(true);
    expect(result.diagnostics.join(' ')).toMatch(/advisory assessment/i);

    // A hard incompatibility still blocks even an explicit override.
    const hardBlocked = candidate('unproven-model:20b', ['agent', 'edit'], { capabilities: { tools: false } });
    expect(() => selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [hardBlocked],
      userOverride: { provider: 'ollama', model: 'unproven-model:20b' },
    })).toThrowError(expect.objectContaining({ code: 'override_incompatible' }));
  });

  it('F. a genuinely novel model family name (no known-family substring) is selectable when technically viable', () => {
    const syntheticName = 'aurora-flux:24b';
    // Sanity check: this name really does not hit any known-family shortcut
    // the heuristic or static registry recognizes.
    for (const fragment of ['coder', 'code', 'codestral', 'qwen', 'gpt', 'gemma']) {
      expect(syntheticName.toLowerCase()).not.toContain(fragment);
    }
    const result = selectTaskModel({
      provider: 'ollama',
      requirements: karkeRequirements(),
      candidates: [candidate(syntheticName, ['agent', 'edit', 'reviewer'])], // reliability inferred from name/capabilities heuristic
    });

    expect(result.selectedModel).toBe(syntheticName);
    expect(result.overridden).toBe(false);
    // Confirms the fix is generic: nothing here depends on any specific model name.
    expect(result.belowPreferredConfidence).toBe(true);
  });

  it('G. gpt-oss:20b-like regression: Ollama-style OpenAI-compatible metadata (no n_params) still routes into governed execution instead of no_capable_model', async () => {
    const MODEL = 'gpt-oss:20b';
    const API_BASE = 'http://127.0.0.1:11434/v1';
    // Ollama's /v1/models publishes only `id` — unlike llama.cpp, it never
    // reports `meta.n_params`, so no measured parameter evidence is ever
    // available through this endpoint for any model.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(String(url)).toBe(`${API_BASE}/models`);
      return new Response(JSON.stringify({ object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'ollama' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));
    try {
      _setConfig('ollama-agent.providerType', 'openai-compatible');
      _setConfig('ollama-agent.apiBase', API_BASE);
      _setConfig('ollama-agent.contextWindow', 32768);
      for (const key of ['model', 'chatModel', 'agentModel', 'editModel', 'reviewerModel', 'codingModel', 'codingFallbackModel']) {
        _setConfig(`ollama-agent.${key}`, MODEL);
      }
      const provider = new OpenAICompatibleProvider(API_BASE, '');
      const models = await provider.listModels();
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'openai-compatible',
        availableModelNames: models.map(m => m.name),
        availableModels: models,
        userOverrideContextWindow: 32768,
      });

      const result = selectTaskModel({ provider: 'openai-compatible', candidates, requirements: karkeRequirements() });
      expect(result.selectedModel).toBe(MODEL);
      expect(result.overridden).toBe(false);
      expect(result.belowPreferredConfidence).toBe(true);
      // Every OTHER role-default (embedding/vision/autocomplete models from
      // package.json defaults, unavailable on this provider) is still
      // genuinely hard-rejected — only the target model itself must never
      // appear as rejected, since it was selected.
      expect(result.rejectedCandidates.some(r => r.model === MODEL)).toBe(false);
      expect(result.diagnostics.join(' ')).toMatch(/Reliability 0\.79 is below required 0\.82/);
      // Never a gpt-oss-specific hack: this candidate went through the exact
      // same generic heuristic as test F's synthetic name.
      expect(ModelCapabilityRegistry.getInstance().getObservedReliability(MODEL)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('H. existing known-model routing is unaffected: a proven/curated model still wins over an advisory-only alternative', () => {
    const known = candidate('qwen3.8:27b-mtp-q4_k_m', ['agent', 'edit', 'reviewer']); // OBSERVED_RELIABILITY 0.88
    const risky = candidate('unproven-model:20b', ['agent', 'edit', 'reviewer'], { reliability: 0.6 });

    const result = selectTaskModel({ provider: 'ollama', requirements: karkeRequirements(), candidates: [risky, known] });
    expect(result.selectedModel).toBe('qwen3.8:27b-mtp-q4_k_m');
    expect(result.belowPreferredConfidence).toBe(false);
  });

  it('I.1 fallback: a hard-incompatible primary yields to a different, genuinely viable configured model', () => {
    const primary = candidate('primary-broken:14b', ['agent', 'edit'], { capabilities: { tools: false } });
    const fallback = candidate('fallback-good:14b', ['agent', 'edit', 'reviewer'], { reliability: 0.85 });

    const result = selectTaskModel({ provider: 'ollama', requirements: karkeRequirements(), candidates: [primary, fallback] });
    expect(result.selectedModel).toBe('fallback-good:14b');
    expect(result.rejectedCandidates.map(r => r.model)).toEqual(['primary-broken:14b']);
  });

  it('I.2 fallback: primary === fallback (identical configured model name) never creates a fake/duplicate escalation candidate', async () => {
    _setConfig('ollama-agent.providerType', 'ollama');
    _setConfig('ollama-agent.contextWindow', 32768);
    for (const key of ['model', 'chatModel', 'agentModel', 'editModel', 'reviewerModel', 'codingModel', 'codingFallbackModel']) {
      _setConfig(`ollama-agent.${key}`, 'solo-model:14b');
    }
    const provider = {
      providerType: 'ollama' as const,
      async healthCheck() {},
      async listModels() { return [{ name: 'solo-model:14b' }]; },
      async getModelContextMetadata() { return undefined; },
      async chat(): Promise<never> { throw new Error('not used'); },
      async *chatStream(): AsyncIterable<never> { throw new Error('not used'); },
    };
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['solo-model:14b'],
      availableModels: [{ name: 'solo-model:14b' }],
      userOverrideContextWindow: 32768,
    });
    // agentModel and codingFallbackModel (and every other role) all name the
    // same model: it must appear exactly once as a candidate, not once per
    // role setting that names it. (Other role-default models from
    // package.json defaults — embedding/vision/autocomplete — legitimately
    // appear too, unavailable on this provider; they are irrelevant here.)
    expect(candidates.filter(c => c.model === 'solo-model:14b')).toHaveLength(1);

    const result = selectTaskModel({ provider: 'ollama', requirements: karkeRequirements(), candidates });
    expect(result.selectedModel).toBe('solo-model:14b');
    // No other candidate exists to escalate to — a "stronger model" retry
    // must see an empty list, never the same model presented as its own
    // stronger alternative.
    expect(result.escalationCandidates).toEqual([]);
  });
});
