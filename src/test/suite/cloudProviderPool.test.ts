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
import { CloudProviderService, cloudProviderServiceFor, hydrateProviderCatalog, refreshProviderCatalogFromRemote, type CloudCoreSink } from '../../providers/CloudProviders';
import { ProviderCatalog, loadBuiltinCatalog } from '../../../core/platform/providerCatalog';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ProviderAuthError, ProviderConnectionError, type InferenceProvider, type ModelInfo } from '../../providers/ProviderTypes';
import { openProviderKeysPage, providerKeysUrl, readKeyFromClipboardOnClick } from '../../providers/ProviderConnection';
import { providerSecretKey } from '../../../core/platform/credentialStore';
import { sharedProviderCatalog } from '../../providers/CloudProviders';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const GROQ_KEY = 'gsk_GROQ-SECRET-KEY-0001'; // gitleaks:allow
const ORCA_KEY = 'sk-orca-SECRET-KEY-0002'; // gitleaks:allow

class DownOllama implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  async healthCheck(): Promise<void> { throw new ProviderConnectionError('Cannot connect to Ollama.', 'ollama'); }
  async listModels(): Promise<ModelInfo[]> { throw new ProviderConnectionError('Cannot connect to Ollama.', 'ollama'); }
  async getModelContextMetadata(): Promise<ModelInfo | undefined> { return undefined; }
  async chat(_m: ChatMessage[], _t: ToolDefinition[]): Promise<ChatResponse> { throw new Error('not used'); }
  async *chatStream(): AsyncIterable<never> { throw new Error('not used'); }
}

type Bodies = Record<string, unknown>;
/** Per-host model lists; a key listed in `badKeys` is rejected like a revoked credential. */
function fakeProviders(bodies: Bodies, badKeys: string[] = []) {
  const calls: Array<{ baseUrl: string; apiKey: string }> = [];
  const factory = (baseUrl: string, apiKey: string) => ({
    listModelsRaw: async () => {
      calls.push({ baseUrl, apiKey });
      if (badKeys.includes(apiKey)) throw new ProviderAuthError('Authentication failed (HTTP 401).', 'openai-compatible');
      const host = new URL(baseUrl).hostname;
      if (!(host in bodies)) throw new ProviderConnectionError(`Cannot connect to ${baseUrl}`, 'openai-compatible', baseUrl);
      return bodies[host];
    },
  });
  return { calls, factory };
}

const GROQ_BODY = { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }, { id: 'llama-3.3-70b' }] };
const ORCA_BODY = { data: [{ id: 'deepseek/deepseek-v4-flash-free' }, { id: 'openai/gpt-5.6-sol' }] };

function recordingCore(): CloudCoreSink & { pushes: Array<{ provider: string; baseUrl: string; apiKey: string }>; cleared: string[]; clearedAll: number } {
  const core = {
    pushes: [] as Array<{ provider: string; baseUrl: string; apiKey: string }>,
    cleared: [] as string[],
    clearedAll: 0,
    setProviderCredential: async (provider: string, baseUrl: string, apiKey: string) => { core.pushes.push({ provider, baseUrl, apiKey }); },
    clearProviderCredential: async (provider: string) => { core.cleared.push(provider); },
    clearAllProviderCredentials: async () => { core.clearedAll += 1; },
  };
  return core;
}

describe('cloud provider pool (extension adapter)', () => {
  let context: ReturnType<typeof createMockExtensionContext>;
  const secrets = () => context.secrets as unknown as vscode.SecretStorage;

  beforeEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetEnv();
    context = createMockExtensionContext();
  });
  afterEach(() => vi.restoreAllMocks());

  describe('credentials and persistence', () => {
    it('connect validates first, stores the key only in SecretStorage, persists non-secret config, and pushes to Core in memory', async () => {
      const { factory } = fakeProviders({ 'api.groq.com': GROQ_BODY });
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), factory);
      const core = recordingCore();
      const result = await service.connect('groq', { apiKey: ` ${GROQ_KEY} ` }, core);
      expect(result).toMatchObject({ ok: true, baseUrl: 'https://api.groq.com/openai/v1' });
      expect(await context.secrets.get(providerSecretKey('groq'))).toBe(GROQ_KEY);
      expect(core.pushes).toEqual([{ provider: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: GROQ_KEY }]);
      expect(Config.getCloudProviderConfigs().groq).toMatchObject({ enabled: true });
      // Secrets never reach settings.
      expect(JSON.stringify(vscodeMock._configUpdates())).not.toContain(GROQ_KEY);
      expect(JSON.stringify(Config.getCloudProviderConfigs())).not.toContain(GROQ_KEY);
    });

    it('a wrong or revoked key stores nothing, pushes nothing and says so without echoing the key', async () => {
      const { factory } = fakeProviders({ 'api.groq.com': GROQ_BODY }, [GROQ_KEY]);
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), factory);
      const core = recordingCore();
      const result = await service.connect('groq', { apiKey: GROQ_KEY }, core);
      expect(result.ok).toBe(false);
      if (!result.ok) { expect(result.reason).toMatch(/rejected the API key.*Nothing was saved/); expect(result.reason).not.toContain(GROQ_KEY); }
      expect(await context.secrets.get(providerSecretKey('groq'))).toBeUndefined();
      expect(core.pushes).toEqual([]);
      expect(Config.getCloudProviderConfigs().groq).toBeUndefined();
      expect((await service.connect('groq', { apiKey: 'two words' })).ok).toBe(false);
    });

    it('reload: a fresh service over the same SecretStorage is connected and re-delivers every credential to Core', async () => {
      const first = fakeProviders({ 'api.groq.com': GROQ_BODY, 'api.orcarouter.ai': ORCA_BODY });
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), first.factory);
      await service.connect('groq', { apiKey: GROQ_KEY });
      await service.connect('orcarouter', { apiKey: ORCA_KEY });

      const reloaded = new CloudProviderService(secrets(), sharedProviderCatalog(), first.factory);
      expect(await reloaded.connectedProviderIds()).toEqual(expect.arrayContaining(['groq', 'orcarouter']));
      const core = recordingCore();
      expect((await reloaded.pushAllToCore(core)).sort()).toEqual(['groq', 'orcarouter']);
      expect(core.pushes.map(p => p.apiKey).sort()).toEqual([GROQ_KEY, ORCA_KEY].sort());
      // OrcaRouter keeps its legacy secret key so existing installs stay connected.
      expect(await context.secrets.get('ollama-agent.orcaRouterApiKey')).toBe(ORCA_KEY);
    });

    it('Remove credentials keeps preferences; Remove provider clears config and secret; Remove all clears everything including legacy keys', async () => {
      const { factory } = fakeProviders({ 'api.groq.com': GROQ_BODY, 'api.orcarouter.ai': ORCA_BODY });
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), factory);
      const core = recordingCore();
      await service.connect('groq', { apiKey: GROQ_KEY }, core);
      await service.connect('orcarouter', { apiKey: ORCA_KEY }, core);
      await context.secrets.store('ollama-agent.cloudFallbackApiKey', 'legacy-secret-value');

      await service.removeCredentials('groq', core);
      expect(await service.isConnected('groq')).toBe(false);
      expect(Config.getCloudProviderConfigs().groq).toBeDefined();
      expect(core.cleared).toContain('groq');

      await service.connect('groq', { apiKey: GROQ_KEY }, core);
      await service.removeProvider('groq', core);
      expect(Config.getCloudProviderConfigs().groq).toBeUndefined();
      expect(await context.secrets.get(providerSecretKey('groq'))).toBeUndefined();

      await service.removeAllCredentials(core);
      expect(await context.secrets.get('ollama-agent.orcaRouterApiKey')).toBeUndefined();
      expect(await context.secrets.get('ollama-agent.cloudFallbackApiKey')).toBeUndefined();
      expect(core.clearedAll).toBe(1);
      expect(await service.connectedProviderIds()).toEqual([]);
    });

    it('disabling a provider removes it from the pool and from Core without deleting its key', async () => {
      const { factory } = fakeProviders({ 'api.groq.com': GROQ_BODY });
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), factory);
      const core = recordingCore();
      await service.connect('groq', { apiKey: GROQ_KEY }, core);
      await service.setEnabled('groq', false, core);
      expect(await service.connectedProviderIds()).toEqual([]);
      expect(core.cleared).toContain('groq');
      expect(await context.secrets.get(providerSecretKey('groq'))).toBe(GROQ_KEY);
      await service.setEnabled('groq', true, core);
      expect(await service.connectedProviderIds()).toEqual(['groq']);
    });

    it('needs an account id for Cloudflare and substitutes it safely', async () => {
      const { factory, calls } = fakeProviders({ 'api.cloudflare.com': { data: [{ id: '@cf/meta/llama' }] } });
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), factory);
      expect((await service.connect('cloudflare', { apiKey: 'cf-token-12345' })).ok).toBe(false);
      expect((await service.connect('cloudflare', { apiKey: 'cf-token-12345', accountId: '../x' })).ok).toBe(false);
      expect((await service.connect('cloudflare', { apiKey: 'cf-token-12345', accountId: 'acc123' })).ok).toBe(true);
      expect(calls.at(-1)?.baseUrl).toBe('https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1');
    });

    it('one failing provider never hides the others, and failures never contain the key', async () => {
      const bodies: Bodies = { 'api.groq.com': GROQ_BODY, 'api.orcarouter.ai': ORCA_BODY };
      const good = fakeProviders(bodies);
      const service = new CloudProviderService(secrets(), sharedProviderCatalog(), good.factory);
      await service.connect('groq', { apiKey: GROQ_KEY });
      await service.connect('orcarouter', { apiKey: ORCA_KEY });
      delete bodies['api.orcarouter.ai'];
      const pool = await service.poolModels({ force: true });
      expect(pool.models.every(m => m.provider === 'groq')).toBe(true);
      expect(pool.failures.map(f => f.provider)).toEqual(['orcarouter']);
      expect(JSON.stringify(pool.failures)).not.toContain(ORCA_KEY);
      const statuses = await service.statuses();
      expect(statuses.find(s => s.descriptor.id === 'groq')).toMatchObject({ connected: true, modelCount: 2 });
      expect(statuses.find(s => s.descriptor.id === 'mistral')).toMatchObject({ connected: false });
      expect(statuses.find(s => s.descriptor.id === 'mistral')?.modelCount).toBeUndefined(); // no fake counts
    });
  });

  describe('free provider catalog refresh', () => {
    const remote = (version: string, extra: object[] = []) => JSON.stringify({
      schemaVersion: 1, catalogVersion: version,
      providers: [{ ...sharedProviderCatalog().get('groq'), freeTier: { kind: 'recurring', note: 'refreshed note' } }, ...extra],
    });

    it('stores the last good remote catalog and re-applies it after a restart, even offline', async () => {
      const catalog = new ProviderCatalog(loadBuiltinCatalog());
      const ok = await refreshProviderCatalogFromRemote(context.globalState as never, { fetchFn: (async () => new Response(remote('2099.01.01.1'), { status: 200 })) as never }, catalog);
      expect(ok).toMatchObject({ ok: true });
      expect(catalog.get('groq')?.freeTier.note).toBe('refreshed note');

      const restarted = new ProviderCatalog(loadBuiltinCatalog());
      expect(restarted.get('groq')?.freeTier.note).not.toBe('refreshed note');
      expect(hydrateProviderCatalog(context.globalState as never, restarted)).toBe(true);
      expect(restarted.get('groq')?.freeTier.note).toBe('refreshed note');
    });

    it('an unreachable or corrupt catalog reports the failure and keeps every built-in provider', async () => {
      const catalog = new ProviderCatalog(loadBuiltinCatalog());
      const count = catalog.list().length;
      const down = await refreshProviderCatalogFromRemote(context.globalState as never, { fetchFn: (async () => { throw new Error('offline'); }) as never }, catalog);
      expect(down.ok).toBe(false);
      expect(down.message).toMatch(/Built-in providers are unaffected/);
      const junk = await refreshProviderCatalogFromRemote(context.globalState as never, { fetchFn: (async () => new Response('{"schemaVersion":9}', { status: 200 })) as never }, catalog);
      expect(junk.ok).toBe(false);
      expect(catalog.list().length).toBe(count);
      expect(hydrateProviderCatalog(context.globalState as never, new ProviderCatalog(loadBuiltinCatalog()))).toBe(false);
    });
  });

  describe('provider connection UX', () => {
    const groq = () => sharedProviderCatalog().get('groq')!;

    it('opens the provider API-keys page in VS Code Simple Browser, and falls back to the system browser', async () => {
      const first = await openProviderKeysPage(groq(), 'vscode');
      expect(first).toEqual({ opened: 'vscode-simple-browser', url: 'https://console.groq.com/keys' });
      expect(vscodeMock._executedCommands().at(-1)).toEqual({ id: 'simpleBrowser.show', args: ['https://console.groq.com/keys'] });

      vscodeMock._setCommandHandler('simpleBrowser.show', () => { throw new Error('command not found'); });
      const second = await openProviderKeysPage(groq(), 'vscode');
      expect(second.opened).toBe('external');
      expect(vscodeMock._openedExternal()).toEqual(['https://console.groq.com/keys']);

      const external = await openProviderKeysPage(groq(), 'external');
      expect(external.opened).toBe('external');
    });

    it('refuses non-https pages and reports a browser that would not open', async () => {
      expect(() => providerKeysUrl({ apiKeysUrl: 'http://evil.example/keys', signupUrl: '' })).toThrow(/https/);
      vscodeMock._setOpenExternalResult(false);
      expect((await openProviderKeysPage(groq(), 'external')).opened).toBe('failed');
    });

    it('reads the clipboard only on an explicit call, accepts a single key, and never echoes other content', async () => {
      const { factory } = fakeProviders({ 'api.groq.com': GROQ_BODY });
      await new CloudProviderService(secrets(), sharedProviderCatalog(), factory).connect('groq', { apiKey: GROQ_KEY });
      await openProviderKeysPage(groq(), 'vscode');
      expect(vscodeMock._clipboardReadCount()).toBe(0); // opening, connecting: never reads the clipboard

      vscodeMock._setClipboardText('  gsk_PASTED-KEY-1234  ');
      expect(await readKeyFromClipboardOnClick()).toEqual({ ok: true, key: 'gsk_PASTED-KEY-1234' }); // gitleaks:allow
      expect(vscodeMock._clipboardReadCount()).toBe(1);

      vscodeMock._setClipboardText('my password is hunter2\nand more');
      const rejected = await readKeyFromClipboardOnClick();
      expect(rejected.ok).toBe(false);
      expect(JSON.stringify(rejected)).not.toContain('hunter2');
      vscodeMock._setClipboardText('');
      expect((await readKeyFromClipboardOnClick()).ok).toBe(false);
    });
  });

  describe('free pool through the real AgentPanel selection path', () => {
    let root: string;
    type Selection = { selectedProvider: string; selectedModel: string; userOverrode: boolean; routingPolicy?: string };

    const panel = () => new AgentPanel(context as unknown as vscode.ExtensionContext, root, true) as unknown as {
      selectModelForTask(goal: string, mode: string, override?: string, image?: boolean): Promise<Selection>;
      recordCloudQuotaFailure(reason: string): void;
    };

    async function connectBoth(): Promise<void> {
      const bodies: Bodies = { 'api.groq.com': { data: [{ id: 'openai/gpt-oss-120b' }] }, 'api.orcarouter.ai': ORCA_BODY };
      vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockImplementation(async function (this: { baseUrl: string }) {
        const host = new URL(this.baseUrl).hostname;
        if (host === 'api.groq.com') return { data: [{ id: 'openai/gpt-oss-120b', pricing: { prompt: '0', completion: '0' } }] };
        return bodies[host];
      });
      const service = cloudProviderServiceFor(secrets());
      // Groq has a recurring free tier (catalog provider-tier rule); OrcaRouter free only by the "-free" suffix rule.
      expect((await service.connect('groq', { apiKey: GROQ_KEY })).ok).toBe(true);
      expect((await service.connect('orcarouter', { apiKey: ORCA_KEY })).ok).toBe(true);
    }

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'cloud-pool-'));
      vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => recordingCore() } as never);
    });
    afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });

    it('FREE_ONLY refuses a manual pick of a paid/unclassified model, but exact manual picks of free models work', async () => {
      await connectBoth();
      const p = panel();
      await expect(p.selectModelForTask('hi', 'baat_kar', 'orcarouter::openai/gpt-5.6-sol')).rejects.toThrow(/not known to be free.*Never incur paid usage/);
      const free = await p.selectModelForTask('hi', 'baat_kar', 'orcarouter::deepseek/deepseek-v4-flash-free');
      expect(free).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'deepseek/deepseek-v4-flash-free', userOverrode: true, routingPolicy: 'explicit-orcarouter' });
      // The spend facts are frozen into the selection so Core can refuse independently.
      expect((free as unknown as { cloudSpend: unknown }).cloudSpend).toEqual({ mode: 'FREE_ONLY', allowCredits: false, modelFreeness: 'free' });
      const other = await p.selectModelForTask('hi', 'baat_kar', 'groq::openai/gpt-oss-120b');
      expect(other).toMatchObject({ selectedProvider: 'groq', routingPolicy: 'explicit-cloud' });
      // Allowing paid cloud is the only way through.
      vscodeMock._setConfig('ollama-agent.cloudSpendMode', 'UNRESTRICTED');
      expect(await p.selectModelForTask('hi', 'baat_kar', 'orcarouter::openai/gpt-5.6-sol')).toMatchObject({ selectedModel: 'openai/gpt-5.6-sol' });
    });

    it('a model name from an unlisted provider or model is refused, never substituted', async () => {
      await connectBoth();
      await expect(panel().selectModelForTask('hi', 'baat_kar', 'groq::does-not-exist')).rejects.toThrow(/does not list/);
    });

    it('Auto with Ollama down uses the pool, moves to another free provider on quota failure, then stops without going paid', async () => {
      await connectBoth();
      vscodeMock._setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new DownOllama());
      const p = panel();

      const first = await p.selectModelForTask('Explain this repo', 'baat_kar');
      expect(first).toMatchObject({ selectedProvider: 'orcarouter', selectedModel: 'deepseek/deepseek-v4-flash-free', userOverrode: false, routingPolicy: 'local-first-cloud-fallback' });

      // The cheaper-priority provider is exhausted; Auto moves on to the other free provider.
      p.recordCloudQuotaFailure('OrcaRouter quota or rate limit reached (HTTP 429)');
      const second = await p.selectModelForTask('Explain this repo', 'baat_kar');
      expect(second.selectedProvider).toBe('groq');

      p.recordCloudQuotaFailure('Groq quota or rate limit reached (HTTP 429)');
      await expect(p.selectModelForTask('Explain this repo', 'baat_kar')).rejects.toThrow(/will not switch to paid/);
    });

    it('Auto does not use the cloud at all unless "use free cloud when needed" is on', async () => {
      await connectBoth();
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new DownOllama());
      await expect(panel().selectModelForTask('Explain this repo', 'baat_kar')).rejects.toThrow(/Cannot connect to Ollama/);
    });

    it('a vision turn is only sent to a model confirmed to support images', async () => {
      await connectBoth();
      await expect(panel().selectModelForTask('what is in this', 'baat_kar', 'groq::openai/gpt-oss-120b', true)).rejects.toThrow(/not confirmed to support images/);
    });
  });
});
