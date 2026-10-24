import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig, createMockExtensionContext } from '../mocks/vscode';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import {
  InferenceProvider,
  ModelInfo,
  ProviderConnectionError,
} from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import { ProviderChatOptions } from '../../providers/ProviderTypes';
import type { CoreConnectionStatus } from '../../core-client/ConnectionState';

const CORE_CONNECTED: CoreConnectionStatus = { state: 'connected' };
const CORE_STARTING: CoreConnectionStatus = { state: 'starting' };
const CORE_AUTH_FAILED: CoreConnectionStatus = { state: 'authentication_failed', detail: 'a running Core rejected our credentials' };

/**
 * Points every role setting at `model` — mirroring what a real user does
 * after reading onboarding's own recommendation (and the same pattern
 * `devstral-context-single-control.mjs`'s `realModelSettings()` uses for
 * live acceptance). Candidate-building now reads these real settings (see
 * ProductionModelCandidates.ts), so a test that wants "this installed model
 * is actually usable" must configure it exactly like production requires —
 * an installed-but-unconfigured model is correctly NOT a usable candidate.
 */
function configureRoleModel(name: string): void {
  _setConfig('ollama-agent.model', name);
  _setConfig('ollama-agent.chatModel', name);
  _setConfig('ollama-agent.agentModel', name);
  _setConfig('ollama-agent.codingModel', name);
  _setConfig('ollama-agent.editModel', name);
  _setConfig('ollama-agent.reviewerModel', name);
  _setConfig('ollama-agent.codingFallbackModel', name);
}

/**
 * OnboardingService is the I/O boundary: it goes through the real
 * `ProviderReadinessProbe` (Ollama reachability + installed-model discovery)
 * and the real `ProviderGateway.resolveCloudFallback` (settings +
 * SecretStorage). Only the wire-level provider construction is faked here,
 * exactly like `localFirstModelRouting.test.ts` fakes it — via
 * `vi.spyOn(ProviderGateway, 'create')` — never live Ollama/cloud.
 */

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(
    private readonly models: ModelInfo[],
    private readonly unreachable = false,
  ) {}
  async healthCheck(): Promise<void> {
    if (this.unreachable) {
      throw new ProviderConnectionError('Cannot connect to Ollama at http://localhost:11434.', 'ollama');
    }
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.unreachable) throw new ProviderConnectionError('unreachable', 'ollama');
    return this.models;
  }
  async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> {
    return this.models.find(m => m.name === model);
  }
  async chat(_m: ChatMessage[], _t: ToolDefinition[], _o: ProviderChatOptions): Promise<ChatResponse> {
    throw new Error('not used by onboarding');
  }
  async *chatStream(): AsyncIterable<never> {
    throw new Error('not used by onboarding');
  }
}

describe('OnboardingService.assess', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('B. reports Ollama unreachable with actionable recovery text and no fake recommendation', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([], true));
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_CONNECTED);

    const result = await service.assess();

    expect(result.overall).toBe('not_ready');
    expect(result.provider.reachable).toBe(false);
    expect(result.provider.nextAction).toMatch(/Start Ollama/i);
    expect(result.recommendedKarkeModel).toBeUndefined();
  });

  it('E. default is local-only with no cloud fallback configured', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_CONNECTED);

    const result = await service.assess();

    expect(result.cloudFallback.policy).toBe('local-only');
    expect(result.cloudFallback.configured).toBe(false);
  });

  it('F. cloud fallback requested but incomplete fails closed and identifies the missing piece', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    _setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
    _setConfig('ollama-agent.cloudFallbackApiBase', 'https://cloud.example.invalid/v1');
    // No cloudFallbackModel, no stored key.
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_CONNECTED);

    const result = await service.assess();

    expect(result.cloudFallback.configured).toBe(false);
    expect(result.cloudFallback.reason).toBe('model_not_configured');
  });

  it('G. cloud fallback fully configured through real settings/SecretStorage is reported configured, secret never exposed', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    _setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
    _setConfig('ollama-agent.cloudFallbackApiBase', 'https://cloud.example.invalid/v1');
    _setConfig('ollama-agent.cloudFallbackModel', 'gpt-4o-mini');
    // This endpoint is not in the provider catalog, so its model is UNKNOWN-cost: the suite opts in to paid cloud.
    _setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
    const context = createMockExtensionContext();
    await ProviderGateway.storeCloudFallbackApiKey(context.secrets as never, 'sk-super-secret-value');
    const service = new OnboardingService(context.secrets as never, () => CORE_CONNECTED);

    const result = await service.assess();

    expect(result.cloudFallback.configured).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-super-secret-value');
  });

  it('H. re-check reflects current state rather than a stale snapshot', async () => {
    configureRoleModel('qwen3.8:27b-mtp-q4_k_m');
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_CONNECTED);

    const createSpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValueOnce(new ScriptedProvider([], true));
    const first = await service.assess();
    expect(first.overall).toBe('not_ready');
    expect(first.provider.reachable).toBe(false);

    createSpy.mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const second = await service.assess();
    expect(second.overall).toBe('ready');
    expect(second.recommendedKarkeModel).toBe('qwen3.8:27b-mtp-q4_k_m');
  });

  it('I. Ollama/model ready but Core not connected never reports overall READY', async () => {
    configureRoleModel('qwen3.8:27b-mtp-q4_k_m');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_AUTH_FAILED);

    const result = await service.assess();

    expect(result.overall).not.toBe('ready');
    expect(result.coreRuntime.connected).toBe(false);
    expect(result.modes.every(m => !m.ready)).toBe(true);
  });

  it('J. Core "starting" is reported as transient, distinct from a dead-end failure', async () => {
    configureRoleModel('qwen3.8:27b-mtp-q4_k_m');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never, () => CORE_STARTING);

    const result = await service.assess();

    expect(result.coreRuntime.state).toBe('starting');
    expect(result.coreRuntime.summary).toMatch(/starting/i);
    expect(result.coreRuntime.summary).not.toMatch(/failed|rejected|incompatible/i);
  });

  it('K. reconnect updates readiness on the next re-check without reopening VS Code', async () => {
    configureRoleModel('qwen3.8:27b-mtp-q4_k_m');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const context = createMockExtensionContext();
    let coreStatus: CoreConnectionStatus = CORE_STARTING;
    // Mirrors how extension.ts wires the real accessor: `() => coreManager?.getStatus()` —
    // a live callback whose return value can change between calls, not a snapshot.
    const service = new OnboardingService(context.secrets as never, () => coreStatus);

    const beforeConnect = await service.assess();
    expect(beforeConnect.overall).not.toBe('ready');

    coreStatus = CORE_CONNECTED;
    const afterConnect = await service.assess();
    expect(afterConnect.overall).toBe('ready');
  });

  it('L. absent getCoreStatus (not injected) fails closed rather than assuming Core is healthy', async () => {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider([{ name: 'qwen3.8:27b-mtp-q4_k_m' }]));
    const context = createMockExtensionContext();
    const service = new OnboardingService(context.secrets as never);

    const result = await service.assess();

    expect(result.coreRuntime.connected).toBe(false);
    expect(result.overall).not.toBe('ready');
  });
});
