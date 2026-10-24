import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import { Config } from '../../config/Config';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { runCloudFallbackSetup } from '../../onboarding/OnboardingCloudFallbackSetup';
import { renderSetupHtml } from '../../onboarding/OnboardingView';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ProviderConnectionError, type InferenceProvider, type ModelInfo } from '../../providers/ProviderTypes';
import { encodeOrcaRouterModel, orcaRouterServiceFor } from '../../providers/OrcaRouter';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

/**
 * Production path for the cloud-fallback enabled state:
 * Setup action -> settings persistence -> reload hydration -> policy -> Auto selection -> Core credential/dispatch inputs.
 *
 * The user's workspace pins `ollama-agent.modelRoutingPolicy: "local-only"` in .vscode/settings.json. VS Code resolves
 * workspace over user, so a Setup write to Global alone saved the policy but every reader kept seeing local-only.
 * Core's own dispatch of the resulting selection is proven in core/test/cloudFallbackAutoDispatch.test.ts.
 */
const ORCA_BASE = 'https://api.orcarouter.ai/v1';
const FALLBACK_MODEL = 'openai/gpt-5.6-sol';
const API_KEY = 'sk-orca-fallback-SECRET-4242';
const POLICY = 'ollama-agent.modelRoutingPolicy';

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly unreachable: boolean, private readonly models: ModelInfo[] = []) {}
  async healthCheck(): Promise<void> {
    if (this.unreachable) throw new ProviderConnectionError('Cannot connect to Ollama.', 'ollama');
  }
  async listModels(): Promise<ModelInfo[]> {
    if (this.unreachable) throw new ProviderConnectionError('Cannot connect to Ollama.', 'ollama');
    return this.models;
  }
  async getModelContextMetadata(): Promise<ModelInfo | undefined> { return undefined; }
  async chat(_m: ChatMessage[], _t: ToolDefinition[]): Promise<ChatResponse> { throw new Error('not used'); }
  async *chatStream(): AsyncIterable<never> { throw new Error('not used'); }
}

type Selection = { selectedProvider: string; selectedModel: string; userOverrode: boolean; routingPolicy?: string };

describe('cloud fallback enabled state survives reload and drives Auto', () => {
  let root: string;
  let context: ReturnType<typeof createMockExtensionContext>;
  let credentialPushes: Array<{ baseUrl: string; apiKey: string }>;

  const sink = () => ({
    setOrcaRouterCredential: async (baseUrl: string, apiKey: string) => { credentialPushes.push({ baseUrl, apiKey }); },
    clearOrcaRouterCredential: async () => undefined,
    setProviderCredential: async (_provider: string, baseUrl: string, apiKey: string) => { credentialPushes.push({ baseUrl, apiKey }); },
    clearProviderCredential: async () => undefined,
  });

  /** A fresh panel over the SAME persisted settings and SecretStorage: what a window reload reconstructs. */
  function freshPanel(): AgentPanel {
    return new AgentPanel(context as unknown as vscode.ExtensionContext, root, true);
  }

  async function runSetupEnablingFallback(): Promise<void> {
    vi.spyOn(OpenAICompatibleProvider.prototype, 'healthCheck').mockResolvedValue(undefined);
    const answers = [ORCA_BASE, FALLBACK_MODEL, API_KEY];
    vi.spyOn(vscode.window, 'showInputBox').mockImplementation(async () => answers.shift());
    vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue('Enable cloud fallback' as never);
    await runCloudFallbackSetup(context as unknown as vscode.ExtensionContext);
  }

  beforeEach(async () => {
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    // These scenarios predate the free-only spend policy and use unclassified models, so they opt in to paid cloud.
    vscodeMock._setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-fallback-persist-'));
    context = createMockExtensionContext();
    credentialPushes = [];
    // The exact conflict seen in the UAT: a workspace-level pin that Global writes cannot override.
    vscodeMock._setWorkspaceConfig(POLICY, 'local-only');
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => sink() } as never);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  it('Setup enable persists where Setup and dispatch read it, and Setup shows On after reload', async () => {
    await runSetupEnablingFallback();

    expect(Config.getModelRoutingPolicy()).toBe('local-first-cloud-fallback');

    // Reload: nothing in memory survives except settings and SecretStorage.
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(false, [{ name: 'gemma4:12b' }]));
    const readiness = await new OnboardingService(context.secrets as never, () => ({ state: 'connected' } as never)).assess();
    expect(readiness.cloudFallback).toMatchObject({ policy: 'local-first-cloud-fallback', configured: true });
    expect(readiness.cloudFallback.summary).toMatch(/^On/);

    const html = renderSetupHtml({ loading: false, readiness, openSections: new Set() }, 'vscode-test', 'n');
    // Setup now shows the enabled state as the "Use free cloud when needed" policy plus the legacy fallback summary.
    expect(html).toMatch(/Use free cloud when needed<\/span><span class="tstate on">ON/);
    expect(html).toContain('On — ');
    expect(html).not.toContain('Saved but not enabled');
    expect(JSON.stringify(readiness)).not.toContain(API_KEY);
  });

  it('turning it off from Setup also takes effect through the workspace pin', async () => {
    await runSetupEnablingFallback();
    await Config.setModelRoutingPolicy('local-only');
    expect(Config.getModelRoutingPolicy()).toBe('local-only');
  });

  it('Auto with Ollama unavailable selects the configured OrcaRouter fallback and hands Core its credential', async () => {
    await runSetupEnablingFallback();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(true));
    vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockResolvedValue({ data: [{ id: FALLBACK_MODEL }] });

    const selection = await (freshPanel() as unknown as { selectModelForTask(goal: string, mode: string): Promise<Selection> })
      .selectModelForTask('Explain this repository', 'baat_kar');

    expect(selection).toMatchObject({
      selectedProvider: 'orcarouter',
      selectedModel: FALLBACK_MODEL,
      userOverrode: false,
      routingPolicy: 'local-first-cloud-fallback',
    });
    // The legacy fallback pair is what Setup wrote; Core must be given exactly that endpoint and key to execute with.
    expect(credentialPushes).toEqual([{ baseUrl: ORCA_BASE, apiKey: API_KEY }]);
  });

  it('with the policy off, Auto and Ollama unavailable still fails closed and never contacts the cloud', async () => {
    await runSetupEnablingFallback();
    await Config.setModelRoutingPolicy('local-only');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(true));
    const cloud = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockResolvedValue({ data: [{ id: FALLBACK_MODEL }] });

    await expect((freshPanel() as unknown as { selectModelForTask(goal: string, mode: string): Promise<Selection> })
      .selectModelForTask('Explain this repository', 'baat_kar')).rejects.toThrow(/Cannot connect to Ollama/);
    expect(cloud).not.toHaveBeenCalled();
    expect(credentialPushes).toEqual([]);
  });

  it('an explicit local model pick is never replaced by the cloud fallback', async () => {
    await runSetupEnablingFallback();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(true));
    const cloud = vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockResolvedValue({ data: [{ id: FALLBACK_MODEL }] });

    await expect((freshPanel() as unknown as { selectModelForTask(goal: string, mode: string, override?: string): Promise<Selection> })
      .selectModelForTask('Explain this repository', 'baat_kar', 'gemma4:12b')).rejects.toThrow(/Cannot connect to Ollama/);
    expect(cloud).not.toHaveBeenCalled();
  });

  it('manual OrcaRouter stays independent: still an explicit user choice, still its own policy', async () => {
    await runSetupEnablingFallback();
    // Manual selection must not depend on the ollama provider at all.
    const createSpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(true));
    vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockResolvedValue({ data: [{ id: 'acme/model-y' }] });
    expect(await orcaRouterServiceFor(context.secrets as never).resolveConfig()).toMatchObject({ source: 'legacy-cloud-fallback' });

    const selection = await (freshPanel() as unknown as { selectModelForTask(goal: string, mode: string, override?: string): Promise<Selection> })
      .selectModelForTask('Say hello', 'baat_kar', encodeOrcaRouterModel('acme/model-y'));

    expect(selection).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'acme/model-y', userOverrode: true, routingPolicy: 'explicit-orcarouter' });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
