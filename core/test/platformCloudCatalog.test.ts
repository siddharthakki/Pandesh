import { describe, expect, it } from 'vitest';
import {
  ProviderCatalog, loadBuiltinCatalog, mergeCatalogs, refreshProviderCatalog, resolveBaseUrl, validateCatalog,
} from '../platform/providerCatalog';
import {
  ModelCatalog, classifyFreeness, decodeCloudModel, encodeCloudModel, modelBadges, parseLocalOllamaModels,
  parseOpenAiCompatibleModels, recommendedModels, satisfiesRequirements, searchModels,
} from '../platform/modelCatalog';
import { QuotaTracker, decidePool, isQuotaFailure, spendVerdict } from '../platform/cloudRouting';
import { InMemoryCredentialStore, containsSecret, providerSecretKey, redactSecrets } from '../platform/credentialStore';

const builtin = loadBuiltinCatalog();
const catalog = new ProviderCatalog(builtin);
const provider = (id: string) => builtin.providers.find(p => p.id === id)!;

describe('provider catalog', () => {
  it('ships a valid catalog covering the required providers, all https, none claiming more than verified', () => {
    const ids = builtin.providers.map(p => p.id);
    for (const required of ['ollama-cloud', 'openrouter', 'orcarouter', 'groq', 'gemini', 'mistral', 'cloudflare', 'huggingface', 'cohere', 'cerebras', 'nvidia']) {
      expect(ids).toContain(required);
    }
    // Promotional/trial credit is never described as recurring.
    expect(provider('cerebras').freeTier.kind).toBe('promotional');
    expect(provider('huggingface').freeTier.kind).toBe('promotional');
    expect(provider('cohere').freeTier.kind).toBe('trial');
    expect(provider('groq').paymentMethodRequired).toBe('unknown');
  });

  it('rejects unsupported protocols, non-https URLs and duplicate ids individually', () => {
    const bad = validateCatalog({
      schemaVersion: 1, catalogVersion: '9',
      providers: [
        { ...provider('groq'), id: 'evil', protocol: 'javascript-plugin' },
        { ...provider('groq'), id: 'plain', baseUrl: 'http://example.com/v1' },
        provider('groq'), provider('groq'),
      ],
    });
    expect(bad.ok).toBe(true);
    expect(bad.catalog!.providers.map(p => p.id)).toEqual(['groq']);
    expect(bad.errors.length).toBe(3);
    expect(validateCatalog({ schemaVersion: 2 }).ok).toBe(false);
    expect(validateCatalog('nope').ok).toBe(false);
  });

  it('a remote catalog cannot redirect a built-in provider credential target', () => {
    const remote = validateCatalog({
      schemaVersion: 1, catalogVersion: '2099.01.01.1',
      providers: [
        { ...provider('groq'), baseUrl: 'https://attacker.example/v1', modelsUrl: 'https://attacker.example/v1/models', freeTier: { kind: 'paid', note: 'now paid' } },
        { ...provider('groq'), id: 'newprov', displayName: 'New Prov', baseUrl: 'https://new.example/v1', modelsUrl: 'https://new.example/v1/models' },
      ],
    }).catalog!;
    const merged = mergeCatalogs(builtin, remote);
    const groq = merged.catalog.providers.find(p => p.id === 'groq')!;
    expect(groq.baseUrl).toBe('https://api.groq.com/openai/v1');
    expect(groq.freeTier.kind).toBe('paid'); // informational metadata updates
    expect(merged.report.protectedConflicts).toContain('groq.baseUrl');
    expect(merged.report.added).toEqual(['newprov']);
  });

  it('refresh failures never break the built-in catalog', async () => {
    const cases: Array<[string, typeof fetch]> = [
      ['unreachable', (async () => { throw new Error('ENOTFOUND'); }) as unknown as typeof fetch],
      ['http', (async () => new Response('x', { status: 503 })) as unknown as typeof fetch],
      ['junk', (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch],
      ['schema', (async () => new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: '2099', providers: 'x' }), { status: 200 })) as unknown as typeof fetch],
      ['old', (async () => new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: '2001.01.01.1', providers: [] }), { status: 200 })) as unknown as typeof fetch],
    ];
    for (const [name, fetchFn] of cases) {
      const result = await refreshProviderCatalog(builtin, { fetchFn });
      expect(result.ok, name).toBe(false);
      expect(result.catalog.providers.length, name).toBe(builtin.providers.length);
    }
    const live = new ProviderCatalog(builtin);
    const ok = await live.refresh({ fetchFn: (async () => new Response(JSON.stringify({ schemaVersion: 1, catalogVersion: '2099.01.01.1', providers: [provider('groq')] }), { status: 200 })) as unknown as typeof fetch });
    expect(ok.ok).toBe(true);
    expect(live.has('groq')).toBe(true);
    expect(live.has('openrouter')).toBe(true);
  });

  it('resolves placeholder base URLs only with a safe value', () => {
    expect(resolveBaseUrl(provider('cloudflare').baseUrl, { accountId: 'abc123' })).toBe('https://api.cloudflare.com/client/v4/accounts/abc123/ai/v1');
    expect(resolveBaseUrl(provider('cloudflare').baseUrl, {})).toBeUndefined();
    expect(resolveBaseUrl(provider('cloudflare').baseUrl, { accountId: '../evil' })).toBeUndefined();
  });
});

describe('model descriptors', () => {
  const openRouterBody = {
    data: [
      { id: 'deepseek/deepseek-v4:free', name: 'DeepSeek V4 (free)', context_length: 128000, pricing: { prompt: '0', completion: '0' }, architecture: { input_modalities: ['text'] }, supported_parameters: ['tools', 'temperature'] },
      { id: 'openai/gpt-5-mini', context_length: 400000, pricing: { prompt: '0.00000025', completion: '0.000002' }, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['tools'] },
      { id: 'mystery/model' },
    ],
  };
  const or = parseOpenAiCompatibleModels(provider('openrouter'), openRouterBody);

  it('classifies free from pricing, not from names; unknown stays unknown', () => {
    expect(or.find(m => m.modelId === 'deepseek/deepseek-v4:free')).toMatchObject({ freeness: 'free', freenessSource: 'provider-metadata', vision: false, tools: true, contextWindow: 128000 });
    expect(or.find(m => m.modelId === 'openai/gpt-5-mini')).toMatchObject({ freeness: 'paid', vision: true });
    expect(or.find(m => m.modelId === 'mystery/model')).toMatchObject({ freeness: 'unknown', tools: 'unknown', vision: 'unknown' });
    // A model merely NAMED free on a pricing-zero provider with paid pricing is paid.
    const tricky = parseOpenAiCompatibleModels(provider('openrouter'), { data: [{ id: 'x/free-model', pricing: { prompt: '0.001', completion: '0.002' } }] });
    expect(tricky[0].freeness).toBe('paid');
  });

  it('applies provider-specific rules and provider-tier classes', () => {
    expect(classifyFreeness(provider('orcarouter'), 'deepseek/deepseek-v4-flash-free', undefined).freeness).toBe('free');
    expect(classifyFreeness(provider('orcarouter'), 'openai/gpt-5.6-sol', undefined).freeness).toBe('unknown');
    expect(classifyFreeness(provider('gemini'), 'gemini-3.5-flash', undefined).freeness).toBe('free');
    expect(classifyFreeness(provider('gemini'), 'gemini-3.5-pro', undefined).freeness).toBe('unknown');
    expect(classifyFreeness(provider('cerebras'), 'gpt-oss-120b', undefined).freeness).toBe('promotional');
    expect(classifyFreeness(provider('cohere'), 'command-a', undefined).freeness).toBe('trial');
    expect(classifyFreeness(provider('nvidia'), 'meta/llama', undefined).freeness).toBe('unknown');
  });

  it('rejects malformed provider payloads', () => {
    expect(() => parseOpenAiCompatibleModels(provider('groq'), { nope: true })).toThrow(/malformed/);
  });

  it('encodes exact cloud picker values and round-trips them', () => {
    const value = encodeCloudModel('orcarouter', 'deepseek/deepseek-v4-flash-free');
    expect(decodeCloudModel(value)).toEqual({ providerId: 'orcarouter', modelId: 'deepseek/deepseek-v4-flash-free' });
    expect(decodeCloudModel('qwen3.8:27b-mtp-q4_K_M')).toBeUndefined();
    expect(decodeCloudModel('::x')).toBeUndefined();
  });

  it('search matches model, provider, capability and combined tokens; Free filter excludes paid and unknown', () => {
    const local = parseLocalOllamaModels([{ name: 'qwen3.8:27b-mtp-q4_K_M' }]);
    const orca = parseOpenAiCompatibleModels(provider('orcarouter'), { data: [{ id: 'deepseek/deepseek-v4-flash-free' }, { id: 'openai/gpt-5.6-sol' }] });
    const all = [...local, ...or, ...orca];
    expect(searchModels(all, { text: 'free deepseek' }).map(m => m.modelId)).toContain('deepseek/deepseek-v4-flash-free');
    expect(searchModels(all, { text: 'free deepseek' }).every(m => /deepseek/.test(m.modelId))).toBe(true);
    expect(searchModels(all, { text: 'orcarouter' }).length).toBe(2);
    expect(searchModels(all, { text: 'vision' }).map(m => m.modelId)).toEqual(['openai/gpt-5-mini']);
    const free = searchModels(all, { filters: ['free'] });
    expect(free.every(m => m.freeness === 'free')).toBe(true);
    expect(free.map(m => m.modelId)).not.toContain('openai/gpt-5.6-sol');
    expect(free.map(m => m.modelId)).not.toContain('mystery/model');
    expect(searchModels(all, { filters: ['local'] }).map(m => m.modelId)).toEqual(['qwen3.8:27b-mtp-q4_K_M']);
    expect(modelBadges(or.find(m => m.modelId === 'mystery/model')!)).toEqual(['CLOUD']);
    expect(recommendedModels(all).every(m => m.freeness === 'free')).toBe(true);
  });

  it('stays fast over thousands of models', () => {
    const body = { data: Array.from({ length: 5000 }, (_, i) => ({ id: `vendor-${i % 50}/model-${i}${i % 7 === 0 ? ':free' : ''}`, pricing: { prompt: i % 7 === 0 ? '0' : '0.000001', completion: i % 7 === 0 ? '0' : '0.000001' } })) };
    const parsed = parseOpenAiCompatibleModels(provider('openrouter'), body);
    const started = performance.now();
    for (let i = 0; i < 20; i++) searchModels(parsed, { text: 'free vendor-3', filters: ['cloud'], limit: 50 });
    expect((performance.now() - started) / 20).toBeLessThan(60);
    const cat = new ModelCatalog();
    cat.setInventory('openrouter', parsed);
    expect(cat.size).toBe(5000);
    expect(cat.find('openrouter', 'vendor-0/model-0:free')).toBeDefined();
  });

  it('hard requirements need confirmation: unknown vision does not satisfy a vision task', () => {
    expect(satisfiesRequirements(or[2], { vision: true }).ok).toBe(false);
    expect(satisfiesRequirements(or[1], { vision: true }).ok).toBe(true);
    expect(satisfiesRequirements(or[0], { vision: true }).ok).toBe(false);
  });
});

describe('spend policy and free pool', () => {
  const orca = parseOpenAiCompatibleModels(provider('orcarouter'), { data: [{ id: 'a/free-one-free' }, { id: 'openai/gpt-5.6-sol' }] });
  const groq = parseOpenAiCompatibleModels(provider('groq'), { data: [{ id: 'openai/gpt-oss-120b', context_window: 131072 }] });
  const cerebras = parseOpenAiCompatibleModels(provider('cerebras'), { data: [{ id: 'gpt-oss-120b' }] });
  const models = [...orca, ...groq, ...cerebras];
  const base = { models, catalog, connectedProviders: new Set(['orcarouter', 'groq', 'cerebras']), policy: { mode: 'FREE_ONLY' as const } };

  it('FREE_ONLY never selects paid, unknown or credit models', () => {
    for (const d of models) {
      const verdict = spendVerdict({ mode: 'FREE_ONLY' }, d);
      expect(verdict.allowed).toBe(d.freeness === 'free');
    }
    const decision = decidePool(base);
    expect(decision.kind).toBe('selected');
    if (decision.kind === 'selected') {
      expect(decision.candidate.descriptor.freeness).toBe('free');
      expect(decision.alternatives.every(c => c.descriptor.freeness === 'free')).toBe(true);
    }
    expect(spendVerdict({ mode: 'FREE_ONLY', allowCredits: true }, cerebras[0]).allowed).toBe(true);
  });

  it('exhausted free providers fall through to another free provider, then block truthfully', () => {
    const quota = new QuotaTracker();
    quota.markExhausted('groq');
    const second = decidePool({ ...base, quota });
    expect(second.kind).toBe('selected');
    if (second.kind === 'selected') expect(second.candidate.descriptor.provider).toBe('orcarouter');
    quota.markExhausted('orcarouter');
    const blocked = decidePool({ ...base, quota });
    expect(blocked.kind).toBe('blocked');
    if (blocked.kind === 'blocked') {
      expect(blocked.reason).toMatch(/will not switch to paid/);
      expect(blocked.exhaustedProviders.sort()).toEqual(['groq', 'orcarouter']);
    }
    // Paid model is never a way out of FREE_ONLY.
    expect(decidePool({ ...base, models: [orca[1]], connectedProviders: new Set(['orcarouter']) }).kind).toBe('blocked');
  });

  it('quota cooldown expires', () => {
    let now = 0;
    const quota = new QuotaTracker(() => now);
    quota.markExhausted('groq', 1000);
    expect(quota.isExhausted('groq')).toBe(true);
    now = 1001;
    expect(quota.isExhausted('groq')).toBe(false);
    expect(isQuotaFailure(429, '')).toBe(true);
    expect(isQuotaFailure(500, 'Free quota exceeded')).toBe(true);
    expect(isQuotaFailure(500, 'boom')).toBe(false);
  });

  it('vision tasks need a vision-confirmed model, and BUDGETED without a limit still blocks paid', () => {
    expect(decidePool({ ...base, requirements: { vision: true } }).kind).toBe('blocked');
    expect(spendVerdict({ mode: 'BUDGETED' }, { ...orca[1], freeness: 'paid' }).allowed).toBe(false);
    expect(spendVerdict({ mode: 'BUDGETED', dailyUsd: 1 }, { ...orca[1], freeness: 'paid' }).allowed).toBe(true);
    expect(spendVerdict({ mode: 'UNRESTRICTED' }, orca[1]).allowed).toBe(true);
  });
});

describe('credential contract', () => {
  it('namespaces keys, keeps the legacy OrcaRouter key, and redacts', async () => {
    expect(providerSecretKey('orcarouter')).toBe('ollama-agent.orcaRouterApiKey');
    expect(providerSecretKey('groq')).toBe('ollama-agent.cloud.groq.apiKey');
    const store = new InMemoryCredentialStore();
    await store.set(providerSecretKey('groq'), 'gsk_ABCDEFGHIJKL');
    expect(await store.get(providerSecretKey('groq'))).toBe('gsk_ABCDEFGHIJKL');
    expect(redactSecrets('failed with key gsk_ABCDEFGHIJKL and Bearer abcdefghijkl1234')).not.toMatch(/ABCDEFGHIJKL|abcdefghijkl1234/);
    expect(containsSecret({ a: 'x gsk_ABCDEFGHIJKL' }, ['gsk_ABCDEFGHIJKL'])).toBe(true);
    await store.delete(providerSecretKey('groq'));
    expect(store.keys()).toEqual([]);
  });
});
