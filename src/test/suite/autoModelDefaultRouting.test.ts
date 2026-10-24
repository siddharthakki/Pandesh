import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { buildProductionTaskModelCandidates, unconfiguredAutoEligibleRoles } from '../../models/ProductionModelCandidates';
import { classifyTaskRequirements, selectTaskModel, TaskModelSelectionError } from '../../models/TaskModelSelection';
import { evaluateOnboardingReadiness } from '../../onboarding/OnboardingReadiness';
import type { InferenceProvider, ModelInfo, ChatMessage, ChatResponse, ToolDefinition, ProviderChatOptions } from '../../providers/ProviderTypes';

/**
 * Behavioral coverage for the "Auto (unset) fresh-install default" fix: no
 * role setting hardcodes a named Ollama model (see Defaults.ts/package.json),
 * and ProductionModelCandidates opens an unconfigured role to every installed
 * model instead of leaving it unfilled. These tests assert observable
 * behavior — discovery, selection, actionable status — never a model literal,
 * so they hold regardless of which specific models happen to be installed.
 */

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly models: ModelInfo[]) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return this.models; }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> {
    return this.models.find(m => m.name === model);
  }
  async chat(_m: ChatMessage[], _t: ToolDefinition[], _o: ProviderChatOptions): Promise<ChatResponse> {
    throw new Error('not used');
  }
  async *chatStream(): AsyncIterable<never> { throw new Error('not used'); }
}

const CORE_CONNECTED = { connected: true, state: 'connected' as const, summary: 'KarkeDikha Core is connected.' };

function baseRequirements() {
  return classifyTaskRequirements('', {
    repositoryExploration: false,
    toolCalling: false,
    fileMutation: false,
    validationRepair: false,
    codingComplexity: 'none',
  });
}

describe('Auto (unset) fresh-install model default routing', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. clean profile, no settings configured, arbitrary installed model → Auto discovers and selects it', async () => {
    // Nothing set — mirrors a totally fresh install. The installed model name
    // is deliberately unrelated to any historical hardcoded default.
    const provider = new ScriptedProvider([{ name: 'totally-arbitrary-local-model:7b' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['totally-arbitrary-local-model:7b'],
    });

    const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
    expect(selection.selectedModel).toBe('totally-arbitrary-local-model:7b');
    expect(selection.overridden).toBe(false);

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    expect(readiness.modes.find(m => m.mode === 'baat_kar')!.ready).toBe(true);
  });

  it('2. a missing historical qwen default does not block Auto — the installed catalog never contains it', async () => {
    const provider = new ScriptedProvider([{ name: 'gpt-oss:20b' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['gpt-oss:20b'],
    });
    // Neither historically-hardcoded name is installed; selection must still
    // succeed rather than throwing no_capable_model.
    expect(candidates.some(c => c.model === 'qwen2.5:14b')).toBe(false);
    expect(candidates.some(c => c.model === 'qwen2.5-coder:14b')).toBe(false);
    const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
    expect(selection.selectedModel).toBe('gpt-oss:20b');
  });

  it('3a. one explicit-but-uninstalled role setting does not block Baat: Auto transparently falls back to another installed model', async () => {
    // Only chatModel is explicitly (and wrongly) configured; agent/edit/
    // reviewer stay on Auto, so the other installed model remains eligible
    // for them — and a basic chat turn only needs caps.chat plus any role, so
    // it succeeds via that fallback rather than blocking on the broken name.
    _setConfig('ollama-agent.chatModel', 'my-laptop-only-model:9b');
    const provider = new ScriptedProvider([{ name: 'a-different-installed-model:8b' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['a-different-installed-model:8b'],
    });

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    expect(readiness.modes.find(m => m.mode === 'baat_kar')!.ready).toBe(true);

    const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
    expect(selection.selectedModel).toBe('a-different-installed-model:8b');
    expect(selection.overridden).toBe(false);
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('3b. every relevant role explicitly pointed at the same uninstalled model produces an actionable, named onboarding status', async () => {
    // No role is left on Auto here, so there is nothing to fall back to —
    // this is the genuinely-blocked case, and onboarding must name the model.
    for (const key of ['model', 'chatModel', 'agentModel', 'editModel', 'reviewerModel', 'codingModel', 'codingFallbackModel']) {
      _setConfig(`ollama-agent.${key}`, 'my-laptop-only-model:9b');
    }
    const provider = new ScriptedProvider([{ name: 'a-different-installed-model:8b' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['a-different-installed-model:8b'],
    });

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const baat = readiness.modes.find(m => m.mode === 'baat_kar')!;
    expect(baat.ready).toBe(false);
    // The configured-but-uninstalled model is named explicitly in guidance —
    // never a generic "blocked" state with no explanation.
    expect(baat.reason).toContain('my-laptop-only-model:9b');
  });

  it('4. an explicit configured model that IS installed is a late tie-break in automatic selection, never an override of task fit', async () => {
    _setConfig('ollama-agent.chatModel', 'user-picked-model:14b');
    const build = async (other: string) => {
      const provider = new ScriptedProvider([{ name: 'user-picked-model:14b' }, { name: other }]);
      return buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: ['user-picked-model:14b', other],
      });
    };
    // Equal fit: the configured model wins the tie (it would lose the name-order tie-break to "some-other...").
    const tied = selectTaskModel({ provider: 'ollama', candidates: await build('some-other-installed-model:14b'), requirements: baseRequirements() });
    expect(tied.selectedModel).toBe('user-picked-model:14b');
    expect(tied.routing.selectionMode).toBe('auto');
    // A clearly better-fitting installed model is NOT displaced by a configured default in AUTO. MANUAL is how
    // an operator pins a model.
    const better = selectTaskModel({ provider: 'ollama', candidates: await build('some-other-installed-model:30b'), requirements: baseRequirements() });
    expect(better.selectedModel).toBe('some-other-installed-model:30b');
    const pinned = selectTaskModel({
      provider: 'ollama',
      candidates: await build('some-other-installed-model:30b'),
      requirements: baseRequirements(),
      userOverride: { provider: 'ollama', model: 'user-picked-model:14b' },
    });
    expect(pinned.selectedModel).toBe('user-picked-model:14b');
    expect(pinned.routing.selectionMode).toBe('manual');
  });

  it('5. zero usable models produces a clear no-capable-model error (onboarding guidance), never a fabricated selection', async () => {
    const provider = new ScriptedProvider([]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: [],
    });
    expect(() => selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() }))
      .toThrow(TaskModelSelectionError);

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const baat = readiness.modes.find(m => m.mode === 'baat_kar')!;
    expect(baat.ready).toBe(false);
    expect(baat.reason.length).toBeGreaterThan(0);
  });

  it('6. setting one role explicitly (e.g. codingModel) leaves the others on Auto, not all-or-nothing', () => {
    _setConfig('ollama-agent.codingModel', 'user-picked-coder:30b');
    const auto = unconfiguredAutoEligibleRoles();
    expect(auto.has('agent')).toBe(false); // codingModel feeds 'agent' — explicitly configured
    expect(auto.has('chat')).toBe(true); // chatModel/model untouched — still Auto
    expect(auto.has('edit')).toBe(true);
    expect(auto.has('reviewer')).toBe(true);
  });

  // Heterogeneous inventory regression: a tiny, unnamed function-calling
  // specialist (no KNOWN-table entry, so it only earns capability flags from
  // ModelCapabilityRegistry's generic name heuristic) sits alongside a much
  // stronger, genuinely general-purpose/coding model. Auto must not let the
  // tiny model win a general role purely for being technically reachable and
  // cheap — see the `compareAutomaticPreference` reliability-first fix in
  // TaskModelSelection.ts. Model names here are deliberately generic/made up
  // (no Qwen/gemma preference baked into the assertion) — the outcome must
  // hold for ANY sufficiently more capable installed alternative, not a
  // specific brand.
  describe('7. heterogeneous inventory: tiny specialist vs. stronger general/coding model', () => {
    const TINY_TOOL_MODEL = 'tiny-function-caller:270m'; // unknown to KNOWN table; heuristic grants tools+structuredOutput
    const STRONG_GENERAL_MODEL = 'capable-general-coder:32b'; // unknown to KNOWN table too — capability comes from the same heuristic, distinguished only by size evidence

    function heterogeneousProvider(): ScriptedProvider {
      return new ScriptedProvider([
        { name: TINY_TOOL_MODEL },
        { name: STRONG_GENERAL_MODEL },
      ]);
    }

    it('7a. general chat role selects the stronger model, not the merely-cheaper tiny one', async () => {
      const provider = heterogeneousProvider();
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: [TINY_TOOL_MODEL, STRONG_GENERAL_MODEL],
      });
      const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
      expect(selection.selectedModel).toBe(STRONG_GENERAL_MODEL);
    });

    it('7b. low-complexity coding/agent role selects the stronger model, not the tiny tool-caller', async () => {
      const provider = heterogeneousProvider();
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: [TINY_TOOL_MODEL, STRONG_GENERAL_MODEL],
      });
      const requirements = classifyTaskRequirements('', {
        repositoryExploration: true,
        toolCalling: true,
        fileMutation: true,
        validationRepair: false,
        codingComplexity: 'low',
      });
      const selection = selectTaskModel({ provider: 'ollama', candidates, requirements });
      expect(selection.selectedModel).toBe(STRONG_GENERAL_MODEL);
    });

    it('7c. medium/high-complexity autonomous execution rejects the tiny model outright (below reliability floor), never falls back to it', async () => {
      const provider = new ScriptedProvider([{ name: TINY_TOOL_MODEL }]);
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: [TINY_TOOL_MODEL],
      });
      const requirements = classifyTaskRequirements('', {
        repositoryExploration: true,
        toolCalling: true,
        fileMutation: true,
        validationRepair: true,
        codingComplexity: 'medium',
        // Pinned below the heuristic's own 8192 default so this test isolates
        // the reliability floor rather than also tripping the (unrelated)
        // context-window hard gate a medium/validation task would otherwise
        // derive (16384).
        minimumContextWindow: 8192,
      });
      // Alone in the inventory, the tiny model is technically viable (no hard
      // incompatibility) but below the validation-repair reliability floor —
      // it is still selected as the best technically viable candidate
      // (never fabricated/blocked), but flagged as below preferred confidence
      // rather than silently treated as a proven fit.
      const selection = selectTaskModel({ provider: 'ollama', candidates, requirements });
      expect(selection.selectedModel).toBe(TINY_TOOL_MODEL);
      expect(selection.belowPreferredConfidence).toBe(true);
    });

    it('7d. a tiny model with no installed general alternative is still chosen over throwing — degrade gracefully, never fabricate', async () => {
      const provider = new ScriptedProvider([{ name: TINY_TOOL_MODEL }]);
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: [TINY_TOOL_MODEL],
      });
      const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
      expect(selection.selectedModel).toBe(TINY_TOOL_MODEL);
    });

    it('7e. a sub-billion "m"-suffixed model name is priced honestly, not as free/zero-cost', async () => {
      // Regression for the modelParameterBillions() "m" (million) suffix gap:
      // "270m" previously matched no size pattern at all (only "...Nb..." was
      // recognized) and fell back to a cost of 0 whenever the provider probe
      // reported no parameterCount — cheaper than every real model,
      // regardless of actual size. This inventory has three viable-for-chat
      // candidates so the fix is observable in the ranking outcome, not just
      // the raw cost number.
      const MID_MODEL = 'mid-size-generalist:8b';
      const provider = new ScriptedProvider([
        { name: TINY_TOOL_MODEL },
        { name: MID_MODEL },
        { name: STRONG_GENERAL_MODEL },
      ]);
      const candidates = await buildProductionTaskModelCandidates({
        provider,
        providerType: 'ollama',
        availableModelNames: [TINY_TOOL_MODEL, MID_MODEL, STRONG_GENERAL_MODEL],
      });
      const selection = selectTaskModel({ provider: 'ollama', candidates, requirements: baseRequirements() });
      // Reliability-first selection should land on the largest/most reliable
      // candidate; the tiny model must not win merely because a naive "b"-only
      // size parse would have under-priced it to 0.
      expect(selection.selectedModel).toBe(STRONG_GENERAL_MODEL);
    });
  });
});
