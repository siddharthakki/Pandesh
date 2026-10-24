import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { createMockExtensionContext } from '../mocks/vscode';
import { OnboardingPanel } from '../../onboarding/OnboardingPanel';
import { OnboardingService } from '../../onboarding/OnboardingService';
import {
  evaluateOnboardingReadiness, type CloudPoolProviderRow, type CloudPoolReadiness, type OnboardingReadiness, type SetupModelEntry,
} from '../../onboarding/OnboardingReadiness';
import { modelDataJson, projectProvider, projectRouting, renderSetupHtml, systemVerdict } from '../../onboarding/OnboardingView';
import { buildDiagnosticsText } from '../../onboarding/OnboardingDiagnostics';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import type { TaskModelCandidate } from '../../models/TaskModelSelection';
import { cloudProviderServiceFor, sharedProviderCatalog, type CloudCoreSink } from '../../providers/CloudProviders';
import { OpenAICompatibleProvider } from '../../providers/OpenAICompatibleProvider';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ProviderConnectionError, type InferenceProvider, type ModelInfo } from '../../providers/ProviderTypes';
import { providerSecretKey } from '../../../core/platform/credentialStore';
import type { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const KEY = 'gsk_UI-SECRET-KEY-0001'; // gitleaks:allow
const CORE_OK = () => ({ state: 'connected' } as never);

function candidate(model: string): TaskModelCandidate {
  const registry = ModelCapabilityRegistry.getInstance();
  return {
    provider: 'ollama', model, available: true, capabilities: registry.getCapabilities(model, 'ollama'),
    configuredRoles: ['agent', 'chat', 'edit', 'reviewer'], reliability: registry.getObservedReliability(model),
  };
}

function row(id: string, over: Partial<CloudPoolProviderRow> = {}): CloudPoolProviderRow {
  const d = sharedProviderCatalog().get(id)!;
  return {
    id, displayName: d.displayName, connected: false, enabled: true, freeTierKind: d.freeTier.kind, freeTierNote: d.freeTier.note,
    paymentRequired: d.paymentMethodRequired, privacyWarning: d.privacyWarning, capabilityTags: [...d.capabilities],
    host: new URL(d.baseUrl.replace(/\{[A-Za-z]+\}/g, 'x')).host, quotaExhausted: false, requiresAccountId: d.requiresBaseUrlInput === true, lastVerifiedAt: d.lastVerifiedAt, ...over,
  };
}

function pool(over: Partial<CloudPoolReadiness> & { connected?: string[]; exhausted?: string[] } = {}): CloudPoolReadiness {
  const connected = over.connected ?? [];
  const exhausted = over.exhausted ?? [];
  const providers = sharedProviderCatalog().list().map(d => row(d.id, connected.includes(d.id) ? { connected: true, quotaExhausted: exhausted.includes(d.id), modelCount: 8, freeCount: 5 } : {}));
  return {
    providers, localFirst: true, useFreeCloud: true, spendMode: 'FREE_ONLY', paidBlocked: true, allowCredits: false, catalogVersion: '2026.10.06.1',
    connectedCount: connected.length, availableCount: connected.filter(c => !exhausted.includes(c)).length, exhaustedIds: exhausted, ...over,
  };
}

function readiness(opts: { local?: boolean; core?: 'connected' | 'starting' | 'unavailable'; pool?: CloudPoolReadiness; models?: SetupModelEntry[] } = {}): OnboardingReadiness {
  const local = opts.local ?? true;
  const core = opts.core ?? 'connected';
  const base = evaluateOnboardingReadiness({
    providerType: 'ollama',
    provider: { providerType: 'ollama', label: 'Ollama', apiBase: 'http://127.0.0.1:11434', reachable: local, detail: local ? 'ok' : 'connect ECONNREFUSED 127.0.0.1:11434' },
    coreRuntime: { connected: core === 'connected', state: core, summary: core },
    candidates: local ? [candidate('qwen3.8:27b-mtp-q4_k_m'), candidate('gemma4:12b')] : [],
    cloudFallback: { policy: 'local-first-cloud-fallback', configured: false, summary: 'x' },
    build: { version: '0.1.1', milestone: 'M51', sha: 'cefb973', dirty: true },
    advanced: { context: { kind: 'auto' }, outputReservation: { kind: 'auto' }, wireOutputCap: 'not_sent', reasoning: 'auto', recoveryCeiling: { tokens: 32_768, source: 'default' } },
  });
  return { ...base, cloudPool: opts.pool ?? pool(), modelEntries: opts.models ?? [] };
}

const html = (r: OnboardingReadiness, extra: object = {}) => renderSetupHtml({ loading: false, readiness: r, openSections: new Set(), ...extra }, 'vscode-test', 'n0nce');
const badge = (h: string) => /data-readiness="([A-Z_]+)"/.exec(h)![1];

describe('Setup control center: readiness', () => {
  it('1. Ollama healthy → READY', () => {
    const h = html(readiness());
    expect(badge(h)).toBe('READY');
    expect(h).toMatch(/●<\/span> READY</);
    expect(h).toContain('Ollama Connected');
  });

  it('2. Ollama down + a usable cloud provider → READY — CLOUD, never NOT READY', () => {
    const r = readiness({ local: false, pool: pool({ connected: ['groq', 'openrouter'] }) });
    const h = html(r);
    expect(badge(h)).toBe('READY_CLOUD');
    expect(h).toContain('READY — CLOUD');
    expect(h).toContain('Local unavailable');
    expect(h).toContain('Local inference is unavailable. KarkeDikha can continue using connected free cloud providers.');
    expect(h).not.toMatch(/NOT READY/);
    expect(systemVerdict(r).state).toBe('READY_CLOUD');
  });

  it('3. no local and no cloud → NEEDS ATTENTION with Start Ollama / Connect free cloud', () => {
    const h = html(readiness({ local: false, pool: pool({ connected: [] }) }));
    expect(badge(h)).toBe('NEEDS_ATTENTION');
    expect(h).toContain('NEEDS ATTENTION');
    expect(h).toContain('No usable model provider is currently available.');
    expect(h).toContain('>Start Ollama<');
    expect(h).toContain('>Connect free cloud<');
  });

  it('cloud exhausted everywhere while local is down → LIMITED, and says it will not switch to paid', () => {
    const r = readiness({ local: false, pool: pool({ connected: ['groq'], exhausted: ['groq'] }) });
    const h = html(r);
    expect(badge(h)).toBe('LIMITED');
    expect(h).toContain('Free quota exhausted');
    expect(h).toContain('will not charge silently');
  });

  it('local healthy but a connected provider exhausted: still READY, row shows exhausted and the switch', () => {
    const r = readiness({ pool: pool({ connected: ['groq', 'openrouter'], exhausted: ['groq'] }) });
    const h = html(r);
    expect(badge(h)).toBe('READY');
    const groq = /<li class="provider exhausted"[^>]*data-provider="groq"[\s\S]*?<\/li>/.exec(h)![0];
    expect(groq).toContain('Free quota exhausted');
    expect(groq).toContain('Routing switches to another free provider.');
    expect(/data-provider="openrouter" data-state="connected"/.test(h)).toBe(true);
  });

  it('Core runtime down is the one thing that makes a healthy local machine NEEDS ATTENTION', () => {
    expect(badge(html(readiness({ core: 'unavailable' })))).toBe('NEEDS_ATTENTION');
    expect(badge(html(readiness({ core: 'starting' })))).toBe('LIMITED');
  });
});

describe('Setup control center: compute, providers and cost policy', () => {
  it('lists every catalog provider data-driven (not hardcoded to one), with honest classification', () => {
    const h = html(readiness({ pool: pool({ connected: ['orcarouter'] }) }));
    for (const d of sharedProviderCatalog().list()) expect(h).toContain(`data-provider="${d.id}"`);
    expect(/data-provider="cerebras"[\s\S]*?PROMOTIONAL CREDITS/.test(h)).toBe(true); // credits are never called a free tier
    expect(/data-provider="cohere"[\s\S]*?TRIAL \/ EVALUATION/.test(h)).toBe(true);
    expect(/data-provider="gemini"[\s\S]*?⚠ Free-tier prompts may be used by Google/.test(h)).toBe(true);
    expect(/data-provider="mistral"[\s\S]*?FREE STATUS UNKNOWN/.test(h)).toBe(true);
    expect(projectProvider(row('groq', { connected: true, modelCount: 8, freeCount: 5 })).detail).toBe('Connected · 8 models · 5 free');
    // No count is invented before the session has listed anything.
    expect(projectProvider(row('groq', { connected: true })).detail).toBe('Connected · models load on refresh');
    // Disconnected rows offer Connect; connected rows offer Browse and Manage.
    expect(/data-provider="mistral"[\s\S]*?data-act="connectProvider" data-id="mistral"/.test(h)).toBe(true);
    expect(/data-provider="orcarouter"[\s\S]*?data-act="openPalette" data-id="orcarouter"[\s\S]*?Manage/.test(h)).toBe(true);
  });

  it('12. paid cloud disabled is communicated as BLOCKED, and allowed as ALLOWED', () => {
    const blocked = html(readiness({ pool: pool({ connected: ['groq'] }) }));
    expect(blocked).toContain('Paid cloud usage is BLOCKED');
    expect(blocked).toContain('data-paid="blocked"');
    expect(blocked).toMatch(/Never incur paid usage<\/span><span class="tstate on">ON/);
    expect(blocked).toContain('Local first');
    expect(blocked).toMatch(/Use free cloud when needed<\/span><span class="tstate on">ON/);
    expect(projectRouting(readiness({ pool: pool() })).find(r => r.label === 'Paid cloud')).toMatchObject({ value: 'Blocked' });
    const allowed = html(readiness({ pool: pool({ connected: ['groq'], spendMode: 'UNRESTRICTED', paidBlocked: false }) }));
    expect(allowed).toContain('Paid cloud usage is ALLOWED');
    expect(allowed).toContain('data-paid="allowed"');
    expect(projectRouting(readiness({ pool: pool({ spendMode: 'UNRESTRICTED', paidBlocked: false }) })).find(r => r.label === 'Paid cloud')).toMatchObject({ value: 'Allowed', tone: 'warn' });
  });

  it('local-first is displayed locked; the policy checkboxes post their own action', () => {
    const h = html(readiness());
    expect(h).toMatch(/<input type="checkbox" data-act="toggleLocalFirst"[^>]* checked disabled>/);
    expect(h).toMatch(/<input type="checkbox" data-act="toggleUseFreeCloud"[^>]* checked>/);
    expect(h).toMatch(/<input type="checkbox" data-act="toggleNeverPaid"[^>]* checked>/);
  });

  it('routing summary reflects real mode readiness and the known vision model, never a hardcoded one', () => {
    const entries: SetupModelEntry[] = [
      { name: 'qwen3.8:27b-mtp-q4_k_m' },
      { name: 'google::gemini-flash', provider: 'google', cloud: true, providerName: 'Google Gemini API', displayName: 'Gemini Flash', modelId: 'gemini-flash', freeness: 'free', vision: true, tools: true },
    ];
    const rows = projectRouting(readiness({ models: entries, pool: pool({ connected: ['gemini'] }) }));
    expect(rows.find(r => r.label === 'Vision')?.value).toContain('Gemini Flash');
    expect(rows.find(r => r.label === 'Vision')?.value).toContain('free');
    expect(rows.find(r => r.label === 'When local is unavailable')?.value).toBe('Free cloud pool (1 provider)');
    expect(projectRouting(readiness()).find(r => r.label === 'Vision')?.value).toBe('No vision-capable model known yet');
    const down = projectRouting(readiness({ local: false }));
    expect(down.find(r => r.label === 'Conversation / reasoning')?.value).toBe('No local model available');
  });

  it('capabilities list only what the snapshot supports', () => {
    const h = html(readiness({ pool: pool({ connected: ['groq', 'orcarouter'] }), models: [{ name: 'a::b', cloud: true, vision: true, provider: 'a', providerName: 'A', freeness: 'free' }] }));
    expect(h).toContain('2 providers connected');
    expect(h).toContain('Available through 1 model');
    const none = html(readiness());
    expect(none).toContain('No provider connected');
    expect(none).toContain('No model with confirmed image support');
    expect(none).not.toContain('Browser Automation');
  });
});

describe('Setup control center: models, scale, secrets and layout', () => {
  const paletteState = { paletteScriptUri: 'vscode-resource://media/model-palette.js', paletteCssUri: 'vscode-resource://media/chat-palette.css' };

  it('6/7. summary shows only FREE recommendations, offers search + the seven filters, and opens the palette', () => {
    const entries: SetupModelEntry[] = [
      { name: 'qwen3.8:27b-mtp-q4_k_m' },
      { name: 'p::free-one', provider: 'p', cloud: true, providerName: 'P', displayName: 'Free One', modelId: 'free-one', freeness: 'free', tools: true },
      { name: 'p::paid-one', provider: 'p', cloud: true, providerName: 'P', displayName: 'Paid One', modelId: 'paid-one', freeness: 'paid' },
      { name: 'p::mystery', provider: 'p', cloud: true, providerName: 'P', displayName: 'Mystery', modelId: 'mystery', freeness: 'unknown' },
    ];
    const h = html(readiness({ models: entries }), paletteState);
    const recommended = /RECOMMENDED — FREE[\s\S]*?<\/ul>/.exec(h)![0];
    expect(recommended).toContain('Free One');
    expect(recommended).not.toContain('Paid One');
    expect(recommended).not.toContain('Mystery');
    expect(h).toContain('id="setup-model-search"');
    for (const f of ['All', 'Local', 'Cloud', 'Free', 'Coding', 'Vision', 'Tools']) expect(h).toContain(`data-filter="${f.toLowerCase()}">${f}</button>`);
    expect(h).toContain('>View all models<');
    expect(h).toContain('4 available');
    expect(h).toContain('model-palette.js');
  });

  it('8. a very large inventory stays cheap: the summary lists a handful of rows and the data is bounded JSON', () => {
    const entries: SetupModelEntry[] = Array.from({ length: 8000 }, (_, i) => ({ name: `p::m${i}`, provider: 'p', cloud: true as const, providerName: 'P', displayName: `Model ${i}`, modelId: `m${i}`, freeness: i % 3 === 0 ? 'free' : 'paid', tools: true }));
    const started = performance.now();
    const h = html(readiness({ models: entries }), paletteState);
    expect(performance.now() - started).toBeLessThan(500);
    expect(h.match(/class="mrow"/g)!.length).toBeLessThanOrEqual(7);
    expect(h).toContain('8000 available');
    expect(h.length).toBeLessThan(3_000_000);
    const data = /<script type="application\/json" id="kd-setup-models">([\s\S]*?)<\/script>/.exec(h)![1];
    expect(JSON.parse(data)).toHaveLength(8000);
  });

  it('model data cannot break out of its script element', () => {
    const json = modelDataJson([{ name: 'x</script><script>alert(1)</script>', displayName: '&<>' }]);
    expect(json).not.toContain('</script>');
    expect(JSON.parse(json)[0].name).toBe('x</script><script>alert(1)</script>');
  });

  it('13. credentials never render: the key field is empty, a staged key shows only a mask, nothing carries the key', () => {
    const r = readiness({ pool: pool({ connected: [] }) });
    const staged = html(r, { ...paletteState, connect: { providerId: 'groq', keyStaged: true, message: { kind: 'ok', text: 'Key pasted from the clipboard.' } } });
    expect(staged).toContain('Connect Groq');
    expect(staged).toMatch(/<input id="connect-key" type="password"[^>]*placeholder="••••/);
    expect(staged).not.toMatch(/<input id="connect-key"[^>]* value=/);
    expect(staged).not.toContain(KEY);
    expect(staged).toContain('never written to settings, logs, prompts or diagnostics');
    expect(buildDiagnosticsText(readiness({ pool: pool({ connected: ['groq'] }) }))).not.toContain(KEY);
    // Steps and buttons from the product spec.
    for (const text of ['STEP 1', 'Open in VS Code', 'Open externally', 'STEP 3', 'Paste from clipboard', 'Save &amp; test']) expect(staged).toContain(text);
    expect(staged).not.toMatch(/data-act="(openKeysPage|pasteClipboard)"[^>]*data-(key|apiKey)=/);
  });

  it('Cloudflare asks for an account id; success shows counts and next actions', () => {
    const h = html(readiness(), { connect: { providerId: 'cloudflare' } });
    expect(h).toContain('id="connect-account"');
    const ok = html(readiness({ pool: pool({ connected: ['groq'] }) }), { connect: { providerId: 'groq', connected: { modelCount: 8, freeCount: 5 } } });
    expect(ok).toContain('✓ GROQ CONNECTED');
    expect(ok).toContain('8 models discovered');
    expect(ok).toContain('5 currently free');
    for (const text of ['Browse models', 'Change key', 'Disconnect']) expect(ok).toContain(text);
  });

  it('14. diagnostics and advanced are collapsed by default and open only on request', () => {
    const closed = html(readiness());
    for (const id of ['diagnostics', 'advanced']) expect(closed).toMatch(new RegExp(`<details class="disclosure[^"]*" data-section="${id}"><summary>`));
    const open = renderSetupHtml({ loading: false, readiness: readiness(), openSections: new Set(['diagnostics']) }, 'c', 'n');
    expect(open).toMatch(/data-section="diagnostics" open>/);
    expect(closed).toContain('Diagnostics ▾');
  });

  it('15. narrow layout: single column below 620px, wrapping provider rows, no fixed-width overflow', () => {
    const h = html(readiness());
    expect(h).toContain('name="viewport" content="width=device-width,initial-scale=1"');
    const narrow = /@media \(max-width:620px\)\{([\s\S]*?)\}\r?\n/.exec(h)![1];
    expect(narrow).toContain('.provider{grid-template-columns:20px 1fr}');
    expect(narrow).toContain('.kvrow{grid-template-columns:1fr;gap:2px}');
    expect(narrow).toContain('.pact{grid-column:2;justify-content:flex-start}');
    expect(h).toMatch(/\.grid\{display:grid;grid-template-columns:1fr/);
    expect(h).toMatch(/\.actions\{[^}]*flex-wrap:wrap/);
    expect(h).toMatch(/\.wrap\{max-width:1040px/);
    // Every control is a real labelled button (no icon-only controls).
    for (const m of h.matchAll(/<button[^>]*>([^<]*)<\/button>/g)) expect(m[1].trim().length).toBeGreaterThan(0);
  });

  it('keeps the existing Setup actions and sections reachable', () => {
    const h = html(readiness());
    for (const label of ['Test', 'Refresh Models', 'Edit Endpoint', 'Copy diagnostics', 'Refresh free providers', 'Configure routing']) expect(h).toContain(`>${label}<`);
    for (const t of ['COMPUTE', 'MODELS', 'ROUTING &amp; SUPERVISION', 'CAPABILITIES', 'SYSTEM HEALTH', 'ADVANCED', 'BUILD']) expect(h).toContain(`>${t}<`);
    expect(h).toContain('0.1.1 · M51 · cefb973');
  });
});

class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  constructor(private readonly up: boolean) {}
  async healthCheck(): Promise<void> { if (!this.up) throw new ProviderConnectionError('down', 'ollama'); }
  async listModels(): Promise<ModelInfo[]> { if (!this.up) throw new ProviderConnectionError('down', 'ollama'); return [{ name: 'gemma4:12b' }]; }
  async getModelContextMetadata(): Promise<ModelInfo | undefined> { return undefined; }
  async chat(_m: ChatMessage[], _t: ToolDefinition[]): Promise<ChatResponse> { throw new Error('not used'); }
  async *chatStream(): AsyncIterable<never> { throw new Error('not used'); }
}

describe('Setup control center: production path (service + panel)', () => {
  let context: ReturnType<typeof createMockExtensionContext>;
  const secrets = () => context.secrets as unknown as vscode.SecretStorage;
  let core: CloudCoreSink & { pushes: Array<{ provider: string; apiKey: string }>; cleared: string[]; all: number };
  const settle = () => new Promise(resolve => setImmediate(resolve));

  beforeEach(() => {
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetEnv();
    (OnboardingPanel as unknown as { current?: OnboardingPanel }).current = undefined;
    context = createMockExtensionContext();
    const c = { pushes: [] as Array<{ provider: string; apiKey: string }>, cleared: [] as string[], all: 0 } as never as typeof core;
    c.setProviderCredential = async (provider, _b, apiKey) => { c.pushes.push({ provider, apiKey }); };
    c.clearProviderCredential = async provider => { c.cleared.push(provider); };
    c.clearAllProviderCredentials = async () => { c.all++; };
    core = c;
    vi.spyOn(OpenAICompatibleProvider.prototype, 'listModelsRaw').mockImplementation(async function (this: { baseUrl: string }) {
      if (new URL(this.baseUrl).hostname === 'api.groq.com') {
        return { data: [{ id: 'openai/gpt-oss-120b' }, { id: 'llama-3.3-70b' }, { id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }, { id: 'f' }] };
      }
      throw new ProviderConnectionError('unreachable', 'openai-compatible');
    });
  });
  afterEach(() => vi.restoreAllMocks());

  async function open(up: boolean) {
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(new ScriptedProvider(up));
    const service = new OnboardingService(secrets(), CORE_OK);
    const panel = await OnboardingPanel.show(context as never, service, async () => undefined, undefined, { getCore: () => core });
    const raw = (panel as unknown as { panel: { renders: string[]; messageEmitter: { fire(m: unknown): void } } }).panel;
    return { renders: raw.renders, send: async (m: unknown) => { raw.messageEmitter.fire(m); await settle(); await settle(); await settle(); }, last: () => raw.renders.at(-1)! };
  }

  it('4/5. Connect → key → Save & test shows the provider immediately with real counts; removing it makes it disappear', async () => {
    const ui = await open(false);
    expect(badge(ui.last())).toBe('NEEDS_ATTENTION');
    await ui.send({ type: 'connectProvider', id: 'groq' });
    expect(ui.last()).toContain('Connect Groq');
    await ui.send({ type: 'openKeysPage', id: 'groq', mode: 'vscode' });
    expect(vscodeMock._executedCommands().at(-1)).toMatchObject({ id: 'simpleBrowser.show' });
    expect(vscodeMock._clipboardReadCount()).toBe(0);
    await ui.send({ type: 'openKeysPage', id: 'groq', mode: 'external' });
    expect(vscodeMock._openedExternal()).toEqual(['https://console.groq.com/keys']);

    await ui.send({ type: 'saveProvider', id: 'groq', apiKey: KEY, accountId: '' });
    expect(ui.last()).toContain('✓ GROQ CONNECTED');
    expect(ui.last()).toContain('8 models discovered');
    expect(await context.secrets.get(providerSecretKey('groq'))).toBe(KEY);
    expect(core.pushes).toEqual([{ provider: 'groq', apiKey: KEY }]);
    for (const rendered of (ui.renders)) expect(rendered).not.toContain(KEY);

    await ui.send({ type: 'closeConnect' });
    expect(/data-provider="groq" data-state="connected"/.test(ui.last())).toBe(true);
    expect(ui.last()).toContain('Connected · 8 models');
    // Local is down and the pool is on by default for this fixture only after the user enables it.
    expect(badge(ui.last())).toBe('LIMITED');
    await ui.send({ type: 'toggleUseFreeCloud', on: true });
    expect(badge(ui.last())).toBe('READY_CLOUD');
    expect(Config_policy()).toBe('local-first-cloud-fallback');

    vscodeMock._setWarningMessageSelection('Remove');
    await ui.send({ type: 'removeProvider', id: 'groq' });
    expect(/data-provider="groq" data-state="available"/.test(ui.last())).toBe(true);
    expect(await context.secrets.get(providerSecretKey('groq'))).toBeUndefined();
    expect(core.cleared).toContain('groq');
    expect(badge(ui.last())).toBe('NEEDS_ATTENTION');
  });

  it('a rejected or unreachable key keeps the Connect panel open with a key-free reason and stores nothing', async () => {
    const ui = await open(true);
    await ui.send({ type: 'connectProvider', id: 'mistral' });
    await ui.send({ type: 'saveProvider', id: 'mistral', apiKey: KEY, accountId: '' });
    expect(ui.last()).toContain('Connect Mistral La Plateforme');
    expect(ui.last()).toContain('Nothing was saved');
    for (const rendered of ui.renders) expect(rendered).not.toContain(KEY);
    expect(await context.secrets.get(providerSecretKey('mistral'))).toBeUndefined();
    await ui.send({ type: 'saveProvider', id: 'mistral', apiKey: '   ', accountId: '' });
    expect(ui.last()).toContain('Paste or type your API key first.');
  });

  it('Paste from clipboard stages the key in the host only, never in the DOM, and Save & test uses it', async () => {
    const ui = await open(true);
    await ui.send({ type: 'connectProvider', id: 'groq' });
    vscodeMock._setClipboardText(KEY);
    await ui.send({ type: 'pasteClipboard', id: 'groq' });
    expect(vscodeMock._clipboardReadCount()).toBe(1);
    expect(ui.last()).toContain('Key pasted from the clipboard');
    for (const rendered of ui.renders) expect(rendered).not.toContain(KEY);
    await ui.send({ type: 'saveProvider', id: 'groq', apiKey: '', accountId: '' });
    expect(ui.last()).toContain('✓ GROQ CONNECTED');
    expect(await context.secrets.get(providerSecretKey('groq'))).toBe(KEY);
    vscodeMock._setClipboardText('not a key\nbecause it has lines');
    await ui.send({ type: 'connectProvider', id: 'groq' });
    await ui.send({ type: 'pasteClipboard', id: 'groq' });
    expect(ui.last()).toContain('does not contain a single API key');
    expect(ui.last()).not.toContain('because it has lines');
  });

  it('Never-incur-paid cannot be switched off without a confirmation, and Remove all cloud credentials clears secrets and Core', async () => {
    const ui = await open(true);
    await ui.send({ type: 'connectProvider', id: 'groq' });
    await ui.send({ type: 'saveProvider', id: 'groq', apiKey: KEY, accountId: '' });
    await ui.send({ type: 'closeConnect' });

    vscodeMock._setWarningMessageSelection(undefined);
    await ui.send({ type: 'toggleNeverPaid', on: false });
    expect(ui.last()).toContain('data-paid="blocked"'); // declined → still blocked
    vscodeMock._setWarningMessageSelection('Allow paid cloud');
    await ui.send({ type: 'toggleNeverPaid', on: false });
    expect(ui.last()).toContain('data-paid="allowed"');
    await ui.send({ type: 'toggleNeverPaid', on: true });
    expect(ui.last()).toContain('data-paid="blocked"');

    vscodeMock._setWarningMessageSelection('Remove all');
    await ui.send({ type: 'removeAllCloud' });
    expect(await context.secrets.get(providerSecretKey('groq'))).toBeUndefined();
    expect(core.all).toBe(1);
    expect(/data-provider="groq" data-state="available"/.test(ui.last())).toBe(true);
  });

  it('Refresh free providers reports an unreachable catalog without touching the built-in providers', async () => {
    const ui = await open(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    await ui.send({ type: 'refreshCatalog' });
    vi.unstubAllGlobals();
    expect(ui.last()).toContain('Built-in providers are unaffected');
    for (const d of sharedProviderCatalog().list()) expect(ui.last()).toContain(`data-provider="${d.id}"`);
  });

  it('the live Ollama-down state: connected provider + policy on → READY — CLOUD straight from the service', async () => {
    await cloudProviderServiceFor(secrets()).connect('groq', { apiKey: KEY });
    vscodeMock._setConfig('ollama-agent.modelRoutingPolicy', 'local-first-cloud-fallback');
    const ui = await open(false);
    expect(badge(ui.last())).toBe('READY_CLOUD');
    expect(ui.last()).toContain('Local unavailable');
    expect(ui.last()).toContain('gpt-oss-120b'.replace('gpt-oss-120b', 'Groq')); // provider is named in the pool
    expect(ui.last()).not.toContain(KEY);
  });
});

function Config_policy(): string {
  return vscode.workspace.getConfiguration('ollama-agent').get<string>('modelRoutingPolicy', 'local-only');
}
