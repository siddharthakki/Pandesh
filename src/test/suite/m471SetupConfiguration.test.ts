import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetConfig, _setConfig, createMockExtensionContext } from '../mocks/vscode';
import {
  OnboardingReadiness,
  evaluateOnboardingReadiness,
} from '../../onboarding/OnboardingReadiness';
import { renderSetupHtml, summarizeProfile, formatContext } from '../../onboarding/OnboardingView';
import { buildDiagnosticsText, redactSecrets, sanitizeEndpoint } from '../../onboarding/OnboardingDiagnostics';
import { OnboardingService } from '../../onboarding/OnboardingService';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { Config } from '../../config/Config';
import { effectiveModelOverride } from '../../models/ModeModelOverride';
import { ModelCapabilityRegistry, type ModelCapability } from '../../models/ModelCapabilityRegistry';
import type { TaskModelCandidate } from '../../models/TaskModelSelection';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateStaticHtml } from '../../../core/runtime/staticHtmlValidation';
import { RuntimeIntelligence, REPROBE_COOLDOWN_MS } from '../../runtimeProfile/RuntimeIntelligence';
import { conservativeProfile, makeIdentity, type RuntimeCapabilityProfile } from '../../runtimeProfile/RuntimeCapabilityProfile';
import type { InferenceProvider, ModelInfo } from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const CORE_CONNECTED = { connected: true, state: 'connected' as const, summary: 'KarkeDikha Core is connected.' };
const ROLES = ['agent', 'chat', 'edit', 'reviewer'] as const;
const BUILD = { version: '0.1.1', milestone: 'M47.1', sha: 'abc1234', dirty: false };

function candidate(model: string, overrides: Partial<TaskModelCandidate> = {}, capability: Partial<ModelCapability> = {}): TaskModelCandidate {
  const registry = ModelCapabilityRegistry.getInstance();
  return {
    provider: 'ollama',
    model,
    available: true,
    capabilities: { ...registry.getCapabilities(model, 'ollama'), ...capability },
    configuredRoles: [...ROLES],
    reliability: registry.getObservedReliability(model),
    ...overrides,
  };
}

function profileFor(model: string, patch: Partial<RuntimeCapabilityProfile> = {}): RuntimeCapabilityProfile {
  return {
    ...conservativeProfile(makeIdentity({ model, providerType: 'ollama', endpoint: 'http://127.0.0.1:11434' })),
    source: 'probe',
    probedAt: new Date().toISOString(),
    contextWindow: { tokens: 32_768, provenance: 'provider_runtime' },
    structuredSchema: 'yes',
    nativeTools: 'yes',
    postToolContinuation: 'healthy',
    reasoning: { supported: 'yes', canDisable: 'yes' },
    ...patch,
  };
}

function readiness(over: Partial<Parameters<typeof evaluateOnboardingReadiness>[0]> = {}): OnboardingReadiness {
  return evaluateOnboardingReadiness({
    providerType: 'ollama',
    provider: { providerType: 'ollama', label: 'Ollama', apiBase: 'http://127.0.0.1:11434', reachable: true, detail: 'Ollama is running.' },
    coreRuntime: CORE_CONNECTED,
    candidates: [candidate('qwen3.8:27b-mtp-q4_k_m'), candidate('gemma4:12b')],
    cloudFallback: { policy: 'local-only', configured: false, summary: 'Off. Repository and task content stays on this machine.' },
    build: BUILD,
    advanced: {
      context: { kind: 'auto' },
      outputReservation: { kind: 'auto' },
      wireOutputCap: 'not_sent',
      reasoning: 'auto',
      recoveryCeiling: { tokens: 32_768, source: 'default' },
    },
    ...over,
  });
}

const render = (r: OnboardingReadiness | undefined, extra: { open?: string[]; notice?: { kind: 'ok' | 'bad' | 'info'; text: string } } = {}) =>
  renderSetupHtml({ loading: false, readiness: r, openSections: new Set(extra.open ?? []), notice: extra.notice, now: new Date() }, 'vscode-resource:', 'nonce123');

describe('Setup screen: local provider', () => {
  it('shows provider, endpoint, status and the four controls when connected', () => {
    const html = render(readiness());
    expect(html).toContain('Ollama Connected');
    expect(html).toContain('http://127.0.0.1:11434');
    for (const label of ['Edit Endpoint', 'Test', 'Refresh Models']) expect(html).toContain(`>${label}<`);
  });

  it('offers actionable recovery, not just a red status, when the provider is unreachable', () => {
    const html = render(readiness({
      provider: { providerType: 'ollama', label: 'Ollama', apiBase: 'http://127.0.0.1:11434', reachable: false, detail: 'Ollama could not be reached.', nextAction: 'Start Ollama.' },
      candidates: [],
    }));
    // Readiness is "can KarkeDikha do useful work?": with no local model and no cloud it needs attention (never "NOT READY").
    expect(html).toContain('NEEDS ATTENTION');
    for (const label of ['Edit endpoint', 'Retry', 'Setup help', 'Test connection', 'Start Ollama', 'Connect free cloud']) expect(html).toContain(`>${label}<`);
    expect(html).toContain('Start Ollama.');
    // Nothing that needs a reachable provider is offered.
    expect(html).not.toContain('Re-probe');
  });
});

describe('Setup screen: per-mode model configuration', () => {
  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('defaults every mode to Auto using the existing selector, with the reason', () => {
    const r = readiness();
    expect(r.modes.map(m => m.selection)).toEqual(['auto', 'auto', 'auto']);
    const html = render(r);
    expect((html.match(/<span class="pill">Auto<\/span>/g) ?? []).length).toBe(3);
    expect((html.match(/data-act="changeMode"/g) ?? []).length).toBe(3);
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('a manual choice that satisfies the mode is used and labelled Manual', () => {
    const r = readiness({ manualModels: { baat_kar: 'gemma4:12b' } });
    const baat = r.modes.find(m => m.mode === 'baat_kar')!;
    expect(baat).toMatchObject({ selection: 'manual', manualModel: 'gemma4:12b', ready: true, model: 'gemma4:12b' });
    expect(r.modes.find(m => m.mode === 'saath_kar')!.selection).toBe('auto');
    expect(render(r)).toContain('<span class="pill">Manual</span>');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('a manual choice cannot bypass the hard capability gate: it is reported, never silently replaced by Auto', () => {
    const toolless = candidate('tiny-chat:1b', {}, { tools: false, chat: true });
    const r = readiness({
      candidates: [candidate('qwen3.8:27b-mtp-q4_k_m'), toolless],
      manualModels: { karke_dikha: 'tiny-chat:1b' },
    });
    const karke = r.modes.find(m => m.mode === 'karke_dikha')!;
    expect(karke.ready).toBe(false);
    expect(karke.selection).toBe('manual');
    expect(karke.model).toBeUndefined();
    expect(karke.reason).toContain('tiny-chat:1b');
    expect(karke.reason).toContain('back to Auto');
    expect(r.overall).toBe('partially_ready');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('a manual model the provider does not list is reported as unavailable for that mode', () => {
    const r = readiness({ manualModels: { saath_kar: 'ghost:7b' } });
    const saath = r.modes.find(m => m.mode === 'saath_kar')!;
    expect(saath.ready).toBe(false);
    expect(saath.reason).toContain('ghost:7b');
  });

  it('shows a readable fallback order ending in the cloud state', () => {
    const r = readiness();
    const html = render(r, { open: ['diagnostics', 'fallback'] });
    expect(html).toContain('Mode readiness');
    expect(html).toContain('<b>Karke Dikha</b>');
    const karke = r.modes.find(m => m.mode === 'karke_dikha')!;
    expect(karke.fallbackOrder[0]).toBe(karke.model);
  });
});

describe('Setup screen: discovered models and runtime profile', () => {
  it('lists only discovered facts and keeps details collapsed by default', () => {
    const profiles = new Map([['qwen3.8:27b-mtp-q4_k_m', profileFor('qwen3.8:27b-mtp-q4_k_m')]]);
    const r = readiness({ profiles });
    const collapsed = render(r);
    expect(collapsed).toContain('Discovered local models (2)');
    expect(collapsed).not.toMatch(/data-section="models" open>/);
    expect(collapsed).not.toMatch(/data-section="profile" open>/);
    const open = render(r, { open: ['diagnostics', 'models', 'profile'] });
    expect(open).toMatch(/data-section="models" open>/);
    expect(open).toContain('Served context');
    expect(open).toContain('Tool continuation');
  });

  it('an unknown model is usable and shown as not probed, never as unhealthy', () => {
    const r = readiness({ candidates: [candidate('brand-new-model:9b')] });
    const model = r.models[0];
    expect(model.profileStatus).toBe('none');
    expect(r.modes.some(m => m.ready)).toBe(true);
    expect(summarizeProfile(model).health).toBe('not_probed');
    expect(summarizeProfile(model).label).toBe('Not probed yet');
  });

  it('profile summary distinguishes healthy, learning and degraded', () => {
    const healthy = readiness({ candidates: [candidate('gemma4:12b', {}, { contextWindow: 32_768 })], profiles: new Map([['gemma4:12b', profileFor('gemma4:12b')]]) }).models.find(m => m.name === 'gemma4:12b')!;
    expect(summarizeProfile(healthy)).toMatchObject({ health: 'healthy', label: 'Healthy', context: '32K', tools: 'Supported' });
    const degraded = readiness({
      profiles: new Map([['gemma4:12b', profileFor('gemma4:12b', { providerHealth: { timeouts: 2, stalls: 1, emptyCompletions: 0, recovered: 0 } })]]),
    }).models.find(m => m.name === 'gemma4:12b')!;
    expect(summarizeProfile(degraded).health).toBe('degraded');
    const learning = readiness({ profiles: new Map([['gemma4:12b', { ...profileFor('gemma4:12b'), source: 'conservative' as const }]]) }).models.find(m => m.name === 'gemma4:12b')!;
    expect(summarizeProfile(learning).health).toBe('learning');
  });

  it('formats contexts compactly', () => {
    expect(formatContext(32_768)).toBe('32K');
    expect(formatContext(131_072)).toBe('128K');
    expect(formatContext(undefined)).toBe('unknown');
  });
});

describe('Setup screen: advanced settings do not misrepresent the wire', () => {
  it('distinguishes the internal output reservation from the (unset) wire cap, and shows the recovery ceiling', () => {
    const html = render(readiness({
      advanced: { context: { kind: 'manual', tokens: 16_384 }, outputReservation: { kind: 'manual', tokens: 8192 }, wireOutputCap: 'not_sent', reasoning: 'auto', recoveryCeiling: { tokens: 32_768, source: 'default' } },
    }), { open: ['advanced'] });
    expect(html).toContain('Output cap sent to the runtime');
    expect(html).toContain('does not set <code>num_predict</code>');
    expect(html).toContain('8192 tokens (manual)');
    expect(html).toContain('used for planning only, not a wire setting');
    expect(html).toContain('Manual — 16K');
    expect(html).toContain('32K (default)');
    expect(html).toContain('Use Auto context');
    expect(html).toContain('Leave Context on Auto');
  });
});

describe('Setup screen: privacy', () => {
  it('is local-only by default and never contacts the cloud merely by rendering', () => {
    const html = render(readiness());
    expect(html).toContain('Repository and task content stays on this machine.');
    expect(html).toContain('Opening Setup never contacts a cloud service.');
    expect(html).toContain('>Configure cloud fallback<');
    // Rendering is pure: no URL is ever fetched or embedded for a cloud endpoint.
    expect(html).not.toMatch(/<(img|script|link)[^>]+src=|fetch\(/);
  });

  it('shows an enabled policy honestly, with a way back to local only', () => {
    const html = render(readiness({
      cloudFallback: { policy: 'local-first-cloud-fallback', configured: true, summary: 'On — gpt-x via https://api.example.com/v1. Used only after a recoverable local failure.', model: 'gpt-x' },
    }));
    expect(html).toContain('On — gpt-x via https://api.example.com/v1.');
    expect(html).toContain('Turn off (local only)');
  });
});

describe('Setup screen: build identity and diagnostics', () => {
  it('shows version, milestone and SHA and offers Copy diagnostics', () => {
    const html = render(readiness());
    expect(html).toContain('0.1.1 · M47.1 · abc1234');
    expect(html).toContain('>Copy diagnostics<');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('diagnostics carry the required facts and no secrets', () => {
    const r = readiness({
      provider: {
        providerType: 'ollama', label: 'Ollama', reachable: true,
        apiBase: 'http://user:hunter2@127.0.0.1:11434/?api_key=sk-LEAKLEAKLEAK1234',
        detail: 'Authorization: Bearer abcdefghijklmnop',
      },
      cloudFallback: { policy: 'local-first-cloud-fallback', configured: true, summary: 'On', model: 'gpt-x' },
      manualModels: { baat_kar: 'gemma4:12b' },
      profiles: new Map([['qwen3.8:27b-mtp-q4_k_m', profileFor('qwen3.8:27b-mtp-q4_k_m')]]),
    });
    const text = buildDiagnosticsText(r);
    expect(text).toContain('Build: 0.1.1 · M47.1 · abc1234');
    expect(text).toContain('Provider: Ollama (ollama) at http://127.0.0.1:11434');
    expect(text).toContain('Baat Kar: manual gemma4:12b');
    expect(text).toContain('profile probe');
    expect(text).toContain('Data policy: local-first-cloud-fallback');
    expect(text).toContain('output cap on the wire (num_predict): not sent');
    for (const secret of ['hunter2', 'sk-LEAK', 'abcdefghijklmnop', 'api_key']) expect(text).not.toContain(secret);
  });

  it('redacts common secret shapes and sanitises endpoints', () => {
    expect(redactSecrets('Bearer abcdefgh1234 and token=xyz123 and ghp_abcdefghijklmnop1234')).not.toMatch(/abcdefgh1234|xyz123|ghp_/);
    expect(sanitizeEndpoint('https://u:p@host:1/v1/?k=v#f')).toBe('https://host:1/v1');
  });
});

describe('Setup page is well-formed HTML', () => {
  it('every state renders a structurally sound page whose inline script compiles', () => {
    const states: Array<OnboardingReadiness | undefined> = [
      readiness(),
      readiness({ provider: { providerType: 'ollama', label: 'Ollama', reachable: false, detail: 'down', nextAction: 'Start it.' }, candidates: [] }),
      readiness({ manualModels: { karke_dikha: 'ghost:7b' } }),
      readiness({ cloudFallback: { policy: 'local-first-cloud-fallback', configured: true, summary: 'On', model: 'm' } }),
      undefined,
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-setup-html-'));
    try {
      states.forEach((state, index) => {
        fs.writeFileSync(path.join(dir, `setup-${index}.html`), render(state));
        const result = validateStaticHtml(dir, `setup-${index}.html`);
        expect(result.findings, `state ${index}`).toEqual([]);
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Setup screen: robustness', () => {
  it('escapes provider-supplied text', () => {
    const html = render(readiness({
      provider: { providerType: 'ollama', label: 'Ollama', reachable: false, detail: '<img src=x onerror=alert(1)>' },
      candidates: [],
    }));
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });

  it('renders a snapshot that predates the configuration fields', () => {
    const legacy = {
      overall: 'ready',
      provider: { providerType: 'ollama', label: 'Ollama', reachable: true, detail: 'ok' },
      coreRuntime: CORE_CONNECTED,
      modes: [{ mode: 'baat_kar', label: 'Baat Kar', ready: true, reason: 'fine', rejectedInstalledModels: [] }],
      installedModelCount: 1,
      cloudFallback: { policy: 'local-only', configured: false, summary: 'Off.' },
    } as unknown as OnboardingReadiness;
    expect(() => render(legacy)).not.toThrow();
  });

  it('shows an action notice', () => {
    expect(render(readiness(), { notice: { kind: 'bad', text: 'Could not reach http://x' } })).toContain('class="notice bad"');
  });
});

describe('OnboardingService configuration actions', () => {
  beforeEach(() => {
    _resetConfig();
    ModelCapabilityRegistry.resetInstance();
  });
  const service = () => new OnboardingService(createMockExtensionContext().secrets as never, () => undefined, '0.1.1');

  it('validates and saves the endpoint, refusing non-http URLs and embedded credentials', async () => {
    const s = service();
    expect(await s.setEndpoint('not a url')).toMatchObject({ ok: false });
    expect(await s.setEndpoint('ftp://host')).toMatchObject({ ok: false });
    expect(await s.setEndpoint('http://u:p@host:11434')).toMatchObject({ ok: false });
    expect(await s.setEndpoint('http://127.0.0.1:12345/')).toEqual({ ok: true, endpoint: 'http://127.0.0.1:12345' });
    expect(Config.getApiBase()).toBe('http://127.0.0.1:12345');
  });

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('per-mode model settings default to Auto and round-trip', async () => {
    expect(Config.getModeModel('baat_kar')).toBe('');
    _setConfig('ollama-agent.modeModel.baatKar', ' gemma4:12b ');
    expect(Config.getModeModel('baat_kar')).toBe('gemma4:12b');
    expect(Config.getModeModel('karke_dikha')).toBe('');
  });
});

describe('OnboardingService with a manual model the provider does not list', () => {
  beforeEach(() => { _resetConfig(); ModelCapabilityRegistry.resetInstance(); });
  afterEach(() => vi.restoreAllMocks());

  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('keeps the choice visible and reports exactly why that mode cannot run, while other modes stay Auto and ready', async () => {
    const models: ModelInfo[] = [{ name: 'qwen3.8:27b-mtp-q4_K_M', contextWindow: 32_768 }, { name: 'gemma4:12b', contextWindow: 32_768 }];
    const provider = {
      providerType: 'ollama' as const,
      endpoint: 'http://127.0.0.1:11434',
      healthCheck: async () => undefined,
      listModels: async () => models,
      getModelContextMetadata: async (model: string) => models.find(item => item.name === model),
      chat: async () => { throw new Error('not used'); },
    };
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider as never);
    _setConfig('ollama-agent.modeModel.saathKar', 'ghost:7b');
    const service = new OnboardingService(createMockExtensionContext().secrets as never, () => ({ state: 'connected' }), '0.1.1');
    const readiness = await service.assess();
    const saath = readiness.modes.find(mode => mode.mode === 'saath_kar')!;
    expect(saath).toMatchObject({ selection: 'manual', manualModel: 'ghost:7b', ready: false });
    expect(saath.reason).toContain('ghost:7b');
    expect(readiness.modes.filter(mode => mode.mode !== 'saath_kar').every(mode => mode.selection === 'auto' && mode.ready)).toBe(true);
    expect(readiness.overall).toBe('partially_ready');
  });
});

describe('mode model override precedence', () => {
  beforeEach(() => _resetConfig());
  // STALE (M51): the per-mode manual model setting and its Setup control were removed from the product. Skipped, not resurrected.
  it.skip('per-turn wins, then the mode setting, else Auto', () => {
    _setConfig('ollama-agent.modeModel.karkeDikha', 'qwen:27b');
    expect(effectiveModelOverride('turn:1b', 'karke_dikha')).toBe('turn:1b');
    expect(effectiveModelOverride(undefined, 'karke_dikha')).toBe('qwen:27b');
    expect(effectiveModelOverride(undefined, 'baat_kar')).toBeUndefined();
  });
});

describe('RuntimeIntelligence.reprobe is bounded', () => {
  class CountingProvider implements InferenceProvider {
    readonly providerType = 'ollama' as const;
    readonly endpoint = 'http://127.0.0.1:11434';
    chatCalls = 0;
    async healthCheck(): Promise<void> {}
    async listModels(): Promise<ModelInfo[]> { return []; }
    async getModelContextMetadata(model: string): Promise<ModelInfo | undefined> { return { name: model, contextWindow: 32_768 }; }
    async chat(_m: ChatMessage[], tools: ToolDefinition[]): Promise<ChatResponse> {
      this.chatCalls += 1;
      if (tools.length > 0) return { message: { role: 'assistant', content: 'done' }, done: true };
      return { message: { role: 'assistant', content: '{"ok": true, "word": "ready"}' }, done: true };
    }
  }

  it('runs once, then reports a cooldown instead of repeating the probe', async () => {
    let now = 1_000_000;
    const runtime = new RuntimeIntelligence({ enabled: true });
    runtime.setClock(() => now);
    const provider = new CountingProvider();
    const first = await runtime.reprobe(provider, 'm:12b');
    expect(first.status).toBe('probed');
    const callsAfterFirst = provider.chatCalls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await runtime.reprobe(provider, 'm:12b');
    expect(second.status).toBe('cooldown');
    expect(second.retryAfterMs).toBeGreaterThan(0);
    expect(provider.chatCalls).toBe(callsAfterFirst);

    now += REPROBE_COOLDOWN_MS + 1;
    expect((await runtime.reprobe(provider, 'm:12b')).status).toBe('probed');
    expect(provider.chatCalls).toBeGreaterThan(callsAfterFirst);
  });

  it('is inert when probing is disabled and findForModel returns the newest profile', async () => {
    const off = new RuntimeIntelligence({ enabled: false });
    expect((await off.reprobe(new CountingProvider(), 'm:12b')).status).toBe('disabled');

    const on = new RuntimeIntelligence({ enabled: true });
    const provider = new CountingProvider();
    expect(await on.findForModel('ollama', 'm:12b')).toBeUndefined();
    await on.reprobe(provider, 'm:12b');
    expect((await on.findForModel('ollama', 'm:12b'))?.identity.model).toBe('m:12b');
  });
});
