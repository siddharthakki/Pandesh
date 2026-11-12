import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  applyLocalEvidence,
  parsePrimaryRegistry,
  parseSecondaryRegistry,
  reconcileRegistry,
} from '../platform/freeModelRegistry';
import { cloudModelEligibility, routeFreeCloud } from '../platform/freeModelEligibility';
import { rankPool, DEFAULT_SPEND_POLICY } from '../platform/cloudRouting';
import { ProviderCatalog } from '../platform/providerCatalog';
import { parseLocalOllamaModels } from '../platform/modelCatalog';
import { FreeModelRegistryService } from '../runtime/freeModelRegistryService';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import type { CloudModelListing } from '../runtime/cloudProviderProbe';
import { MALICIOUS_ENTRIES, fixtureFetch, primaryFixture, secondaryFixture } from './fixtures/freeModelRegistryFixtures';

const catalog = new ProviderCatalog();
const DUMMY_KEY = 'gsk_PANDESHDUMMYkey000000000000000000001';

function listing(ids: { free: string[]; paid?: string[] }, ok = true, errorClass?: CloudModelListing['errorClass']): CloudModelListing {
  return {
    ok, checkedAt: '2026-11-12T08:00:00.000Z', latencyMs: 120, httpStatus: ok ? 200 : 429, errorClass,
    pool: ids.free.map((id) => ({ id, displayName: id, contextWindow: 131072, vision: 'unknown' as const, tools: true })),
    excluded: { paid: ids.paid?.length ?? 0, unknown: 0, promotional: 0, trial: 0, nonGenerative: 0 },
    others: (ids.paid ?? []).map((id) => ({ id, displayName: id, reason: 'paid' as const })),
  };
}

/** Answers the qualification suite: `toolsOk` decides whether the model returns a valid tool call. */
function qualificationFetch(opts: { toolsOk: boolean }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    const reply = (message: Record<string, unknown>) => new Response(JSON.stringify({ model: `${body.model}-2026-11`, choices: [{ message }] }), { status: 200, headers: { 'x-ratelimit-remaining-requests': '29' } });
    if (body.model === 'pandesh-qualification-nonexistent-model') return new Response('{"error":"model not found"}', { status: 404 });
    const prompt = String(body.messages?.[0]?.content ?? '');
    if (body.tools) return reply(opts.toolsOk ? { content: null, tool_calls: [{ function: { name: 'get_city_time', arguments: '{"city":"Paris"}' } }] } : { content: 'It is noon in Paris.' });
    if (body.response_format) return reply({ content: '{"name":"Pandesh","count":3}' });
    if (prompt.includes('code word')) return reply({ content: 'BLUE-HERON-4721' });
    if (prompt.includes('function named add')) return reply({ content: '```js\nfunction add(a, b) {\n  return a + b;\n}\n```' });
    return reply({ content: 'OK' });
  }) as unknown as typeof fetch;
}

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-freemodels-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('upstream parsing and reconciliation', () => {
  it('A1/A2: imports API providers from both sources with provenance; non-API rows are skipped', () => {
    const p = parsePrimaryRegistry(primaryFixture());
    const s = parseSecondaryRegistry(secondaryFixture());
    expect(p.providers.map((x) => x.key)).toEqual(['groq-free', 'openrouter-free', 'trialco']);
    expect(s.providers.map((x) => x.key)).toEqual(['groq', 'openrouter']); // GPU-only offer skipped
    const groq = reconcileRegistry({ primary: p.providers, secondary: s.providers }, catalog).find((x) => x.id === 'groq')!;
    expect(groq.sources.map((x) => `${x.source}:${x.key}`)).toEqual(['primary:groq-free', 'secondary:groq']);
    expect(groq.phoneRequired).toBe(true); // only the secondary knows this
    expect(groq.quotas[0]).toMatchObject({ amount: 30, unit: 'requests', period: 'minute' });
  });

  it('A3: the same provider and model across both registries become one canonical record', () => {
    const merged = reconcileRegistry({ primary: parsePrimaryRegistry(primaryFixture()).providers, secondary: parseSecondaryRegistry(secondaryFixture()).providers }, catalog);
    expect(merged.filter((x) => x.id === 'groq')).toHaveLength(1);
    const groq = merged.find((x) => x.id === 'groq')!;
    const gptOss = groq.models.filter((m) => m.modelId === 'openai/gpt-oss-20b');
    expect(gptOss).toHaveLength(1);
    expect(gptOss[0].sources.sort()).toEqual(['primary', 'secondary']);
    expect(gptOss[0].key).toBe('groq::openai/gpt-oss-20b');
  });

  it('A4: an upstream "free" claim alone is only unverified and never eligible', () => {
    const merged = reconcileRegistry({ primary: parsePrimaryRegistry(primaryFixture()).providers, secondary: [] }, catalog);
    const groq = merged.find((x) => x.id === 'groq')!;
    expect(groq.status).toBe('unverified');
    const verdict = cloudModelEligibility({ provider: 'groq', modelId: 'openai/gpt-oss-20b', locality: 'cloud' }, {
      privacy: 'public', task: 'chat', preferences: { autoProviders: ['groq'], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true },
      credentialedProviders: new Set(['groq']), registry: new Map([['groq', groq]]), qualifications: new Map(),
    });
    expect(verdict).toEqual({ ok: false, reason: expect.stringMatching(/registry status is unverified/) });
    const trial = merged.find((x) => x.displayName === 'TrialCo')!;
    expect(trial.status).toBe('restricted');
    expect(trial.statusReasons.join(' ')).toMatch(/trial credit/);
  });

  it('A11: a model the provider now prices above zero becomes restricted; provider evidence beats the registry', () => {
    const base = reconcileRegistry({ primary: parsePrimaryRegistry(primaryFixture()).providers, secondary: [] }, catalog);
    const verified = applyLocalEvidence(base, { groq: { checkedAt: 't1', ok: true, freeModelIds: ['openai/gpt-oss-20b', 'qwen/qwen3.8-27b'], paidModelIds: [] } });
    expect(verified.find((x) => x.id === 'groq')!.models.every((m) => m.status === 'verified_free')).toBe(true);
    const flipped = applyLocalEvidence(base, { groq: { checkedAt: 't2', ok: true, freeModelIds: ['qwen/qwen3.8-27b'], paidModelIds: ['openai/gpt-oss-20b'] } });
    const m = flipped.find((x) => x.id === 'groq')!.models.find((x) => x.modelId === 'openai/gpt-oss-20b')!;
    expect(m.status).toBe('restricted');
    expect(m.statusReasons[0]).toMatch(/prices it above zero/);
  });

  it('A13: malicious upstream text and URLs stay untrusted data', () => {
    const p = parsePrimaryRegistry(primaryFixture({ extraEntries: MALICIOUS_ENTRIES }));
    const merged = reconcileRegistry({ primary: p.providers, secondary: [] }, catalog);
    // (a) a look-alike host never joins or redirects the shipped Groq provider
    const groq = merged.find((x) => x.id === 'groq')!;
    expect(groq.baseUrl).toBe('https://api.groq.com/openai/v1');
    const mirror = merged.find((x) => x.sources.some((s) => s.key === 'evil-groq-mirror'))!;
    expect(mirror.id).not.toBe('groq');
    expect(mirror.catalogProviderId).toBeUndefined();
    // (b) instruction-like text is flagged and blocks automatic use
    expect(mirror.suspicious.length).toBeGreaterThan(0);
    expect(mirror.status).toBe('restricted');
    // (c) javascript:/http: URLs and path-traversal / control-character model ids are dropped
    expect(mirror.keyUrl).toBeUndefined();
    const helpful = merged.find((x) => x.sources.some((s) => s.key === 'helpful-free'))!;
    expect(helpful.baseUrl).toBeUndefined();
    expect(helpful.status).toBe('unknown');
    expect(helpful.models.map((m) => m.modelId)).toEqual(['good-model']);
    expect(p.rejected.join(' ')).toMatch(/not a safe https URL/);
    // Nothing from a registry is ever callable: discovered-only providers have no adapter.
    expect(merged.filter((x) => !x.catalogProviderId).every((x) => x.status !== 'verified_free')).toBe(true);
  });
});

describe('registry service: refresh, last known-good, restart', () => {
  it('A1/A2 refresh produces a change report; A10 outage and truncation keep the last known-good data', async () => {
    const svc = new FreeModelRegistryService(dir, catalog, new CloudCredentialStore());
    const first = await svc.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture(), secondary: secondaryFixture() }) });
    expect(first.ok).toBe(true);
    expect(first.report.summary).toMatch(/first import/);
    const before = fs.readFileSync(path.join(dir, 'free-models', 'registry.json'), 'utf8');

    const outage = await svc.refresh({ fetchFn: fixtureFetch({ primary: new Error('ECONNRESET'), secondary: 'not json' }) });
    expect(outage.ok).toBe(false);
    expect(outage.keptLastKnownGood).toBe(true);
    expect(outage.errors.join(' ')).toMatch(/could not be fetched.*last known-good/);
    expect(fs.readFileSync(path.join(dir, 'free-models', 'registry.json'), 'utf8')).toBe(before);
    expect(svc.providers().find((p) => p.id === 'groq')).toBeTruthy();

    // A schema-broken primary while the secondary is fine: the primary's last good data is reused.
    const partial = await svc.refresh({ fetchFn: fixtureFetch({ primary: { entries: 'nope' }, secondary: secondaryFixture() }) });
    expect(partial.ok).toBe(true);
    expect(partial.sources.find((s) => s.id === 'primary')!.carriedOver).toBe(true);
    expect(svc.providers().find((p) => p.id === 'groq')!.sources.map((s) => s.source)).toContain('primary');

    // A10: model removal is reported as a change, not silently absorbed.
    const removed = await svc.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture({ groqModels: ['openai/gpt-oss-20b'] }), secondary: secondaryFixture() }) });
    expect(removed.report.modelsRemoved).toContain('groq::qwen/qwen3.8-27b');
  });

  it('A12: a restarted service reads the same registry, evidence, qualifications and approvals', async () => {
    const creds = new CloudCredentialStore();
    creds.set('groq', { baseUrl: 'https://api.groq.com/openai/v1', apiKey: DUMMY_KEY });
    const svc = new FreeModelRegistryService(dir, catalog, creds);
    await svc.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture(), secondary: secondaryFixture() }) });
    svc.recordListing('groq', listing({ free: ['openai/gpt-oss-20b'] }));
    await svc.qualify('groq', 'openai/gpt-oss-20b', { fetchFn: qualificationFetch({ toolsOk: true }), pauseMs: 0 });
    svc.setPreferences({ autoProviders: ['groq'] });
    const decision = svc.route('chat', 'public');

    const restarted = new FreeModelRegistryService(dir, catalog, creds);
    expect(restarted.getPreferences().autoProviders).toEqual(['groq']);
    expect(restarted.state().counts).toEqual(svc.state().counts);
    expect(restarted.state().qualifications).toHaveLength(1);
    expect(restarted.route('chat', 'public')).toEqual(decision);
    // Nothing secret was persisted.
    for (const file of fs.readdirSync(path.join(dir, 'free-models'))) {
      expect(fs.readFileSync(path.join(dir, 'free-models', file), 'utf8')).not.toContain(DUMMY_KEY);
    }
  });
});

describe('routing through the existing pool router', () => {
  async function ready(opts: { toolsOk?: boolean; keyFor?: string[]; approve?: string[] } = {}) {
    const creds = new CloudCredentialStore();
    for (const id of opts.keyFor ?? ['groq', 'openrouter']) creds.set(id, { baseUrl: catalog.get(id)!.baseUrl, apiKey: DUMMY_KEY });
    const svc = new FreeModelRegistryService(dir, catalog, creds);
    await svc.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture(), secondary: secondaryFixture() }) });
    if (creds.get('groq')) svc.recordListing('groq', listing({ free: ['openai/gpt-oss-20b'] }));
    if (creds.get('openrouter')) svc.recordListing('openrouter', listing({ free: ['google/gemma-4-31b-it:free'] }));
    for (const [p, m] of [['groq', 'openai/gpt-oss-20b'], ['openrouter', 'google/gemma-4-31b-it:free']] as const) {
      if (creds.get(p)) await svc.qualify(p, m, { fetchFn: qualificationFetch({ toolsOk: opts.toolsOk ?? true }), pauseMs: 0 });
    }
    svc.setPreferences({ autoProviders: opts.approve ?? ['groq', 'openrouter'] });
    return svc;
  }

  it('A5: a provider without a key is pending setup and never selected', async () => {
    const svc = await ready({ keyFor: ['openrouter'] });
    const decision = svc.route('chat', 'public');
    expect(decision.kind).toBe('selected');
    if (decision.kind === 'selected') expect(decision.candidate.descriptor.provider).toBe('openrouter');
    expect(svc.state().providers.find((p) => p.id === 'groq')!.setup).toBe('pending_setup');
    const eligibility = svc.stillEligible('groq', 'openai/gpt-oss-20b', 'chat');
    expect(eligibility.ok).toBe(false);
  });

  it('A6: private content is local only, whatever is approved', async () => {
    const svc = await ready();
    const decision = svc.route('chat', 'private');
    expect(decision).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/stays on this PC/) });
  });

  it('A7: a public task may use an approved, verified, qualified free provider', async () => {
    const svc = await ready();
    const decision = svc.route('research', 'public');
    expect(decision.kind).toBe('selected');
    if (decision.kind === 'selected') {
      expect(['groq', 'openrouter']).toContain(decision.candidate.descriptor.provider);
      expect(decision.alternatives).toHaveLength(1);
    }
    // Not approved for automatic routing => not selected.
    const none = await ready({ approve: [] });
    expect(none.route('chat', 'public')).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/No provider is approved/) });
  });

  it('A8: a rate-limited provider is skipped; when none remains the decision is a clear blocker', async () => {
    const svc = await ready();
    const first = svc.route('chat', 'public');
    expect(first.kind).toBe('selected');
    const chosen = first.kind === 'selected' ? first.candidate.descriptor.provider : '';
    expect(svc.noteFailure(chosen, 429, 'quota or rate limit reached (HTTP 429)')).toBe(true);
    const second = svc.route('chat', 'public');
    expect(second.kind === 'selected' && second.candidate.descriptor.provider).not.toBe(chosen);
    const other = chosen === 'groq' ? 'openrouter' : 'groq';
    svc.noteFailure(other, 429, 'Too Many Requests');
    expect(svc.route('chat', 'public')).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/quota is exhausted|will not switch to paid/) });
    expect(svc.noteFailure('groq', 500, 'internal error')).toBe(false); // not a quota failure: no switch
  });

  it('A9: a model that fails tool-call qualification is excluded from tool tasks but still serves chat', async () => {
    const svc = await ready({ toolsOk: false });
    const q = svc.state().qualifications[0];
    expect(q.capabilities).toMatchObject({ chat: true, coding: true, tools: false, structuredOutput: true, longContext: true });
    expect(q.results.find((r) => r.id === 'tool_call')!.outcome).toBe('fail');
    expect(q.results.find((r) => r.id === 'error_recovery')!.outcome).toBe('pass');
    expect(q.modelVersion).toMatch(/-2026-11$/);
    expect(svc.route('tools', 'public')).toMatchObject({ kind: 'blocked' });
    expect(svc.route('chat', 'public').kind).toBe('selected');
  });

  it('A14: local models are untouched; rankPool without the new hooks behaves as before', () => {
    const local = parseLocalOllamaModels([{ name: 'gemma4:12b' }]);
    expect(cloudModelEligibility(local[0], {
      privacy: 'private', task: 'tools', preferences: { autoProviders: [], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true },
      credentialedProviders: new Set(), registry: new Map(), qualifications: new Map(),
    })).toEqual({ ok: true });
    const cloud = { ...local[0], provider: 'groq', providerName: 'Groq', modelId: 'm', locality: 'cloud' as const, freeness: 'free' as const };
    const plain = rankPool({ models: [...local, cloud], connectedProviders: new Set(['groq']), catalog, policy: DEFAULT_SPEND_POLICY });
    expect(plain.candidates.map((c) => c.key)).toEqual(['groq::m']); // rankPool ranks cloud only, exactly as before
    const routed = routeFreeCloud({ models: [...local], catalog, facts: { privacy: 'public', task: 'chat', preferences: { autoProviders: [], disabledProviders: [], preferredOrder: [], fallbackOnRateLimit: true }, credentialedProviders: new Set(), registry: new Map(), qualifications: new Map() } });
    expect(routed.kind).toBe('blocked');
  });
});
