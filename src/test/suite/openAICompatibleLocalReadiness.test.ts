import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig, createMockExtensionContext } from '../mocks/vscode';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { buildProductionTaskModelCandidates, resolveProviderModelId } from '../../models/ProductionModelCandidates';
import {
  classifyTaskRequirements,
  selectTaskModel,
  TaskModelCandidate,
  TaskModelSelectionError,
} from '../../models/TaskModelSelection';
import { ModelDispatchPlanner } from '../../reliability/ModelDispatchPlanner';
import type { InferenceProvider, ModelInfo } from '../../providers/ProviderTypes';
import type { CoreConnectionStatus } from '../../core-client/ConnectionState';

/**
 * Local OpenAI-compatible server (llama.cpp `llama-server`) readiness.
 *
 * The provider is the REAL `OpenAICompatibleProvider`; only `fetch` is
 * stubbed, with the `/v1/models` `data` entry recorded verbatim from a live
 * `llama-server --alias qwen3.8-flash-next` on 2026-09-23. llama.cpp
 * publishes its runtime context (`meta.n_ctx`), trained context
 * (`meta.n_ctx_train`) and exact parameter count (`meta.n_params`) on every
 * entry, plus the `aliases` it accepts.
 */
const MODEL = 'qwen3.8-flash-next';
const API_BASE = 'http://127.0.0.1:8080';
const CORE_CONNECTED: CoreConnectionStatus = { state: 'connected' };

function llamaCppEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MODEL,
    aliases: [MODEL],
    tags: [],
    object: 'model',
    created: 1790195949,
    owned_by: 'llamacpp',
    meta: {
      vocab_type: 2,
      n_vocab: 248320,
      n_ctx: 32768,
      n_ctx_train: 262144,
      n_embd: 2560,
      n_params: 176943899520,
      size: 81950799360,
      ftype: 'IQ3_XXS - 3.0625 bpw',
    },
    ...overrides,
  };
}

const LLAMA_CPP_MODELS = { object: 'list', data: [llamaCppEntry()] };
/** A strict OpenAI-schema `/v1/models` body: ids only, no metadata. */
const BARE_OPENAI_MODELS = { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'local' }] };

function stubModelsEndpoint(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!String(url).endsWith('/v1/models')) throw new Error(`unexpected request ${url}`);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }));
}

function configureRoles(model: string): void {
  for (const key of ['model', 'chatModel', 'agentModel', 'codingModel', 'editModel', 'reviewerModel', 'codingFallbackModel']) {
    _setConfig(`ollama-agent.${key}`, model);
  }
}

function configureLocalOpenAICompatible(model: string): void {
  _setConfig('ollama-agent.providerType', 'openai-compatible');
  _setConfig('ollama-agent.apiBase', API_BASE);
  configureRoles(model);
}

const karkeRequirements = () => classifyTaskRequirements('', {
  repositoryExploration: true,
  toolCalling: true,
  fileMutation: true,
  validationRepair: true,
  codingComplexity: 'medium',
});

async function productionCandidates(provider: InferenceProvider, providerType: 'ollama' | 'openai-compatible', userOverrideContextWindow?: number) {
  const models = await provider.listModels();
  return buildProductionTaskModelCandidates({
    provider,
    providerType,
    availableModelNames: models.map(m => m.name),
    availableModels: models,
    userOverrideContextWindow,
  });
}

function candidateFor(candidates: readonly TaskModelCandidate[], model: string): TaskModelCandidate {
  const found = candidates.find(c => c.model === model);
  if (!found) throw new Error(`no candidate ${model}`);
  return found;
}

function rejectionFor(candidates: readonly TaskModelCandidate[], model: string, requirements = karkeRequirements()) {
  try {
    selectTaskModel({ provider: candidates[0].provider, candidates, requirements });
    return undefined;
  } catch (error) {
    if (!(error instanceof TaskModelSelectionError)) throw error;
    return error.rejectedCandidates.find(r => r.model === model);
  }
}

const OLLAMA_AS_PROVIDER = /Ollama (could not|is running|detected)|needs Ollama|with Ollama|ollama pull/i;

describe('local OpenAI-compatible provider (llama.cpp) readiness', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('diagnostic: prints the exact production candidate and Karke selection outcome', async () => {
    configureLocalOpenAICompatible(MODEL);
    stubModelsEndpoint(LLAMA_CPP_MODELS);
    const candidates = await productionCandidates(new OpenAICompatibleProvider(API_BASE, ''), 'openai-compatible');
    const candidate = candidateFor(candidates, MODEL);
    const result = selectTaskModel({ provider: 'openai-compatible', candidates, requirements: karkeRequirements() });
    // eslint-disable-next-line no-console
    console.log('[diagnostic] candidate:', JSON.stringify(candidate, null, 2), '\n[diagnostic] selected:', result.selectedModel);
    expect(result.selectedModel).toBe(MODEL);
  });

  it('parses llama.cpp /v1/models metadata truthfully and leaves a strict OpenAI body without invented facts', async () => {
    stubModelsEndpoint(LLAMA_CPP_MODELS);
    const [llama] = await new OpenAICompatibleProvider(API_BASE, '').listModels();
    expect(llama).toEqual({ name: MODEL, contextWindow: 32768, declaredContextWindow: 262144, parameterCount: 176943899520 });

    stubModelsEndpoint(BARE_OPENAI_MODELS);
    expect(await new OpenAICompatibleProvider(API_BASE, '').listModels()).toEqual([{ name: MODEL }]);
  });

  it('A. onboarding tests the configured OpenAI-compatible provider and never describes it as Ollama', async () => {
    configureLocalOpenAICompatible(MODEL);
    stubModelsEndpoint(LLAMA_CPP_MODELS);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new OpenAICompatibleProvider(API_BASE, ''));
    const result = await new OnboardingService(createMockExtensionContext().secrets as never, () => CORE_CONNECTED).assess();

    expect(JSON.stringify(result)).not.toMatch(OLLAMA_AS_PROVIDER);
    expect(result.provider).toMatchObject({ providerType: 'openai-compatible', label: 'OpenAI-compatible server', apiBase: API_BASE, reachable: true });
    expect(result.pullCommandSuggestion).toBeUndefined();
    expect(result.overall).toBe('ready');
    expect(result.recommendedKarkeModel).toBe(MODEL);
  });

  it('A. an unreachable OpenAI-compatible server is reported as that server, with its own recovery action', async () => {
    configureLocalOpenAICompatible(MODEL);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new OpenAICompatibleProvider(API_BASE, ''));
    const result = await new OnboardingService(createMockExtensionContext().secrets as never, () => CORE_CONNECTED).assess();

    expect(result.provider.reachable).toBe(false);
    expect(result.provider.nextAction).toMatch(/OpenAI-compatible service/);
    expect(JSON.stringify(result)).not.toMatch(OLLAMA_AS_PROVIDER);
  });

  it('B. the provider-listed llama.cpp model receives every configured Karke role', async () => {
    configureLocalOpenAICompatible(MODEL);
    stubModelsEndpoint(LLAMA_CPP_MODELS);
    const candidate = candidateFor(await productionCandidates(new OpenAICompatibleProvider(API_BASE, ''), 'openai-compatible'), MODEL);
    expect(candidate.available).toBe(true);
    expect([...candidate.configuredRoles].sort()).toEqual(['agent', 'chat', 'edit', 'reviewer']);
    expect(candidate.parameterBillions).toBeCloseTo(176.94, 2);
  });

  describe('C. one resolved context window for the gate and the dispatch', () => {
    async function gateAndDispatchWindow(body: unknown, explicitContextWindow?: number) {
      if (explicitContextWindow !== undefined) _setConfig('ollama-agent.contextWindow', explicitContextWindow);
      stubModelsEndpoint(body);
      const provider = new OpenAICompatibleProvider(API_BASE, '');
      const override = explicitContextWindow;
      const gate = candidateFor(await productionCandidates(provider, 'openai-compatible', override), MODEL).capabilities.contextWindow;
      const dispatch = (await ModelDispatchPlanner.createSession({ provider, model: MODEL, toolsActive: true, hasImages: false })).limit;
      return { gate, dispatch: dispatch.effectiveLimit, provenance: dispatch.provenance };
    }

    it('provider-reported runtime context (llama.cpp n_ctx) with no explicit setting', async () => {
      expect(await gateAndDispatchWindow(LLAMA_CPP_MODELS)).toEqual({ gate: 32768, dispatch: 32768, provenance: 'provider_runtime' });
    });

    it('an explicit setting outranks provider metadata in both directions, identically', async () => {
      ModelCapabilityRegistry.resetInstance();
      expect(await gateAndDispatchWindow(LLAMA_CPP_MODELS, 16384)).toEqual({ gate: 16384, dispatch: 16384, provenance: 'user_override' });
      ModelCapabilityRegistry.resetInstance();
      expect(await gateAndDispatchWindow(BARE_OPENAI_MODELS, 65536)).toEqual({ gate: 65536, dispatch: 65536, provenance: 'user_override' });
    });

    it('no metadata and no setting: both fall through to the same profile limit', async () => {
      const result = await gateAndDispatchWindow(BARE_OPENAI_MODELS);
      expect(result.gate).toBe(result.dispatch);
      expect(result.provenance).toBe('profile_operational');
    });

    it('onboarding and live selection honor the explicit setting identically (both build via the same path)', async () => {
      configureLocalOpenAICompatible(MODEL);
      _setConfig('ollama-agent.contextWindow', 4096);
      stubModelsEndpoint(LLAMA_CPP_MODELS);
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new OpenAICompatibleProvider(API_BASE, ''));
      const onboarding = await new OnboardingService(createMockExtensionContext().secrets as never, () => CORE_CONNECTED).assess();
      const karke = onboarding.modes.find(m => m.mode === 'karke_dikha')!;
      // 4096 is what dispatch would really use, so Karke (16384 floor) is truthfully not ready.
      expect(karke.ready).toBe(false);
      expect(karke.rejectedInstalledModels[0].hardReasons).toContain('Context window 4096 is below required 16384.');
    });
  });

  describe('D. reliability evidence and advisory semantics', () => {
    it('without size evidence an otherwise-capable model is AUTOMATICALLY selected as the best viable fallback, and labelled unmeasured (UNKNOWN != INCOMPATIBLE)', async () => {
      configureLocalOpenAICompatible(MODEL);
      _setConfig('ollama-agent.contextWindow', 32768);
      stubModelsEndpoint(BARE_OPENAI_MODELS);
      const candidates = await productionCandidates(new OpenAICompatibleProvider(API_BASE, ''), 'openai-compatible', 32768);

      // Automatic selection: no hard incompatibility exists, so the model is
      // technically viable and must be chosen rather than rejected outright —
      // but the shortfall stays observable via belowPreferredConfidence.
      const automatic = selectTaskModel({ provider: 'openai-compatible', candidates, requirements: karkeRequirements() });
      expect(automatic.selectedModel).toBe(MODEL);
      expect(automatic.overridden).toBe(false);
      expect(automatic.belowPreferredConfidence).toBe(true);
      // The target model itself was selected, so it must never also appear
      // rejected (other role-default models unrelated to this scenario may
      // legitimately still be hard-rejected as unavailable).
      expect(automatic.rejectedCandidates.some(r => r.model === MODEL)).toBe(false);
      expect(automatic.diagnostics.join(' ')).toMatch(
        /Reliability 0\.66 is below required 0\.82\. No observed reliability or parameter-size evidence exists for this model\./,
      );

      // Advisory, not hard: an explicit per-task choice still runs it too.
      const explicit = selectTaskModel({
        provider: 'openai-compatible',
        candidates,
        requirements: karkeRequirements(),
        userOverride: { provider: 'openai-compatible', model: MODEL },
      });
      expect(explicit.selectedModel).toBe(MODEL);
      expect(explicit.overridden).toBe(true);
    });

    it('onboarding presents that model as capable-but-unproven and READY, never as technically incapable', async () => {
      configureLocalOpenAICompatible(MODEL);
      _setConfig('ollama-agent.contextWindow', 32768);
      stubModelsEndpoint(BARE_OPENAI_MODELS);
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new OpenAICompatibleProvider(API_BASE, ''));
      const result = await new OnboardingService(createMockExtensionContext().secrets as never, () => CORE_CONNECTED).assess();
      const karke = result.modes.find(m => m.mode === 'karke_dikha')!;
      // Technically viable, so automatic selection already picked it — ready
      // is truthfully true, but the reduced-confidence caveat stays visible.
      expect(karke.ready).toBe(true);
      expect(karke.model).toBe(MODEL);
      expect(karke.belowPreferredConfidence).toBe(true);
      expect(karke.reason).toContain(`"${MODEL}" meets Karke Dikha's technical requirements`);
      expect(karke.reason).toMatch(/below the preferred threshold/);
      expect(karke.reason).not.toMatch(/none of the models it lists support/);
    });

    it('provider-reported parameter count feeds the same heuristic the name would (176.9B -> 0.88), with the floor unchanged', async () => {
      configureLocalOpenAICompatible(MODEL);
      stubModelsEndpoint(LLAMA_CPP_MODELS);
      const candidates = await productionCandidates(new OpenAICompatibleProvider(API_BASE, ''), 'openai-compatible');
      // Medium Karke passes (0.88 >= 0.82); high complexity (floor 0.88, context 32768) is the edge.
      expect(selectTaskModel({ provider: 'openai-compatible', candidates, requirements: karkeRequirements() }).selectedModel).toBe(MODEL);
      const sameSizeByName: TaskModelCandidate = { ...candidateFor(candidates, MODEL), model: 'unknown-model:177b', parameterBillions: undefined };
      const byName = selectTaskModel({ provider: 'openai-compatible', candidates: [sameSizeByName], requirements: karkeRequirements() });
      expect(byName.selectedModel).toBe('unknown-model:177b');
    });

    it('a genuine hard incompatibility still blocks even an explicit override', () => {
      const candidate: TaskModelCandidate = {
        provider: 'openai-compatible', model: MODEL, available: true, configuredRoles: ['chat'],
        capabilities: { ...ModelCapabilityRegistry.getInstance().getCapabilities(MODEL), contextWindow: 32768 },
      };
      expect(() => selectTaskModel({
        provider: 'openai-compatible',
        candidates: [candidate],
        requirements: karkeRequirements(),
        userOverride: { provider: 'openai-compatible', model: MODEL },
      })).toThrow(/incompatible.*File mutation requires an agent or edit role/);
    });
  });

  describe('E. provider-published aliases', () => {
    const FILE_ID = 'Qwen3.8-Flash-Next-UD-IQ3_XXS-00001-of-00003.gguf';
    const aliased = { object: 'list', data: [llamaCppEntry({ id: FILE_ID, aliases: [MODEL] })] };

    it('a setting naming a llama.cpp alias attaches its roles to the listed id that is dispatched', async () => {
      configureLocalOpenAICompatible(MODEL);
      stubModelsEndpoint(aliased);
      const candidates = await productionCandidates(new OpenAICompatibleProvider(API_BASE, ''), 'openai-compatible');
      expect(candidates.some(c => c.model === MODEL)).toBe(false);
      const candidate = candidateFor(candidates, FILE_ID);
      expect([...candidate.configuredRoles].sort()).toEqual(['agent', 'chat', 'edit', 'reviewer']);
      expect(selectTaskModel({ provider: 'openai-compatible', candidates, requirements: karkeRequirements() }).selectedModel).toBe(FILE_ID);
    });

    it('never matches a name the provider did not publish (no case folding or fuzzy match)', () => {
      const models: ModelInfo[] = [{ name: FILE_ID, aliases: [MODEL] }];
      expect(resolveProviderModelId(MODEL, models)).toBe(FILE_ID);
      expect(resolveProviderModelId('QWEN3.8-FLASH-NEXT', models)).toBe('QWEN3.8-FLASH-NEXT');
      expect(resolveProviderModelId('qwen3.8-flash', models)).toBe('qwen3.8-flash');
    });

    it('the readiness probe accepts a configured chat model that is a published alias', async () => {
      configureLocalOpenAICompatible(MODEL);
      stubModelsEndpoint(aliased);
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new OpenAICompatibleProvider(API_BASE, ''));
      const result = await new OnboardingService(createMockExtensionContext().secrets as never, () => CORE_CONNECTED).assess();
      expect(result.recommendedKarkeModel).toBe(FILE_ID);
    });
  });
});
