import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig } from '../mocks/vscode';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { buildProductionTaskModelCandidates } from '../../models/ProductionModelCandidates';
import { classifyTaskRequirements, selectTaskModel, TaskModelSelectionError } from '../../models/TaskModelSelection';
import { evaluateOnboardingReadiness } from '../../onboarding/OnboardingReadiness';
import type { InferenceProvider, ModelInfo, ChatMessage, ChatResponse, ToolDefinition, ProviderChatOptions } from '../../providers/ProviderTypes';

/**
 * Defect 2: onboarding READY must never disagree with what the real
 * execution path (AgentPanel.selectModelForTask) can actually select. Both
 * now build candidates through the exact same
 * `buildProductionTaskModelCandidates` (ProductionModelCandidates.ts), so
 * these tests exercise that ONE shared function directly, then feed its
 * output into both the pure onboarding evaluator and the real
 * `selectTaskModel` execution path — proving they see the same world,
 * rather than asserting each in isolation against separately fabricated
 * candidate lists (which is how the original defect went unnoticed).
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

function baatRequirements() {
  return classifyTaskRequirements('', {
    repositoryExploration: false,
    toolCalling: false,
    fileMutation: false,
    validationRepair: false,
    codingComplexity: 'none',
  });
}

describe('onboarding readiness agrees with real execution model selection', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. installed model configured for the chat role: onboarding reports Baat READY and selectTaskModel (the real execution call) can select it', async () => {
    _setConfig('ollama-agent.chatModel', 'qwen3.8:27b-mtp-q4_k_m');
    const provider = new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['qwen3.8:27b-mtp-q4_k_m'],
    });

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const baat = readiness.modes.find(m => m.mode === 'baat_kar')!;

    const executionResult = selectTaskModel({ provider: 'ollama', candidates, requirements: baatRequirements() });

    expect(baat.ready).toBe(true);
    expect(executionResult.selectedModel).toBe('qwen3.8:27b-mtp-q4_k_m');
    expect(baat.model).toBe(executionResult.selectedModel);
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('2. configured role model is not installed: onboarding and execution AGREE it is not ready, and onboarding names the missing model', async () => {
    // Every role setting points at the same missing name — mirrors a fresh
    // profile that never touched settings, still holding package.json's
    // illustrative example model names, none of which happen to be
    // installed on this particular machine.
    for (const key of ['model', 'chatModel', 'agentModel', 'codingModel', 'editModel', 'reviewerModel', 'codingFallbackModel']) {
      _setConfig(`ollama-agent.${key}`, 'qwen2.5:14b');
    }
    const provider = new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]); // installed, but not configured for any role
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['qwen3.8:27b-mtp-q4_k_m'],
    });

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const baat = readiness.modes.find(m => m.mode === 'baat_kar')!;

    let executionThrew = false;
    try {
      selectTaskModel({ provider: 'ollama', candidates, requirements: baatRequirements() });
    } catch (error) {
      executionThrew = error instanceof TaskModelSelectionError && error.code === 'no_capable_model';
    }

    expect(baat.ready).toBe(false);
    expect(executionThrew).toBe(true);
    expect(baat.reason).toMatch(/qwen2\.5:14b/);
  });

  it('3. two configured candidates, one below the reliability bar: onboarding\'s recommendation and execution\'s selection are the identical model', async () => {
    // qwen3.8:27b-mtp-q4_k_m has real observed reliability (0.88, live-proven);
    // a small autocomplete-only model configured for chat as well would be
    // rejected outright by the role/capability checks — using a generic
    // low-parameter chat model instead so this exercises the reliability/cost
    // ranking path, not just a hard role rejection.
    _setConfig('ollama-agent.chatModel', 'llama3.1:8b');
    _setConfig('ollama-agent.agentModel', 'qwen3.8:27b-mtp-q4_k_m');
    const provider = new ScriptedProvider([{ name: 'llama3.1:8b' }, { name: 'qwen3.8:27b-mtp-q4_k_m' }]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['llama3.1:8b', 'qwen3.8:27b-mtp-q4_k_m'],
    });

    const karkeRequirements = classifyTaskRequirements('', {
      repositoryExploration: true,
      toolCalling: true,
      fileMutation: true,
      validationRepair: true,
      codingComplexity: 'medium',
    });
    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const executionResult = selectTaskModel({ provider: 'ollama', candidates, requirements: karkeRequirements });

    expect(readiness.recommendedKarkeModel).toBe(executionResult.selectedModel);
    expect(executionResult.selectedModel).toBe('qwen3.8:27b-mtp-q4_k_m');
  });

  it('4. an explicit per-turn override stays authoritative in execution regardless of onboarding\'s own (override-free) recommendation', async () => {
    _setConfig('ollama-agent.chatModel', 'qwen3.8:27b-mtp-q4_k_m');
    _setConfig('ollama-agent.agentModel', 'devstral-small-2:latest');
    const provider = new ScriptedProvider([
      { name: 'qwen3.8:27b-mtp-q4_k_m' },
      { name: 'devstral-small-2:latest' },
    ]);
    const candidates = await buildProductionTaskModelCandidates({
      provider,
      providerType: 'ollama',
      availableModelNames: ['qwen3.8:27b-mtp-q4_k_m', 'devstral-small-2:latest'],
      modelOverride: 'devstral-small-2:latest',
    });

    const readiness = evaluateOnboardingReadiness({
      providerType: 'ollama',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'reachable' },
      coreRuntime: CORE_CONNECTED,
      candidates,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    });
    const baatAutomaticRecommendation = readiness.modes.find(m => m.mode === 'baat_kar')!.model;

    const overridden = selectTaskModel({
      provider: 'ollama',
      candidates,
      requirements: baatRequirements(),
      userOverride: { provider: 'ollama', model: 'devstral-small-2:latest' },
    });

    expect(overridden.overridden).toBe(true);
    expect(overridden.selectedModel).toBe('devstral-small-2:latest');
    // The override is honored even though onboarding's own (override-free)
    // automatic recommendation for Baat is the other, cheaper/equally valid
    // configured model — proving the override isn't silently ignored just
    // because onboarding would have picked something else.
    expect(baatAutomaticRecommendation).toBeDefined();
  });
});
