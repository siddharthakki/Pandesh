/**
 * Owner, 2026-11-13: "i want all enabled". Every provider the free-model registry discovers with an OpenAI-compatible
 * https API gets the generic adapter: it shows as set up-able, takes the owner's key and can be health-checked. Only
 * models the registry lists, at a recurring free tier, count as free. NVIDIA's API Catalog counts as free.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { deriveCatalogEntry, genericAdapterBlocker, parsePrimaryRegistry, parseSecondaryRegistry, reconcileRegistry, type RegistryProvider } from '../platform/freeModelRegistry';
import { ProviderCatalog, setDerivedProviders } from '../platform/providerCatalog';
import { classifyFreeness } from '../platform/modelCatalog';
import { FreeModelRegistryService } from '../runtime/freeModelRegistryService';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import { fixtureFetch, primaryFixture, secondaryFixture } from './fixtures/freeModelRegistryFixtures';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-allproviders-')); setDerivedProviders([]); });
afterEach(() => { setDerivedProviders([]); fs.rmSync(dir, { recursive: true, force: true }); });

function discovered(over: Partial<RegistryProvider> = {}): RegistryProvider {
  return {
    id: 'reg-freeco', displayName: 'FreeCo', baseUrl: 'https://api.freeco.example/v1/', host: 'api.freeco.example',
    sources: [{ source: 'primary', key: 'freeco', verifiedBySource: true }], openaiCompatible: true, auth: 'api-key', requiresKey: true,
    keyUrl: 'https://freeco.example/keys', docsUrl: 'https://freeco.example/docs', cardRequired: false, phoneRequired: 'unknown', commercialUse: true,
    freeKind: 'recurring', training: 'no', quotas: [],
    models: [{ key: 'reg-freeco::free/model-1.5', modelId: 'free/model-1.5', sources: ['primary'], limits: {}, status: 'unverified', statusReasons: [] }],
    status: 'unverified', statusReasons: [], conflicts: [], suspicious: [], lastVerified: '2026-11-01',
    ...over,
  };
}

describe('generic adapter for a discovered provider', () => {
  it('builds an OpenAI-compatible entry where only the listed models of a recurring free tier are free', () => {
    const entry = deriveCatalogEntry(discovered())!;
    expect(entry).toMatchObject({ id: 'reg-freeco', protocol: 'openai-compatible', baseUrl: 'https://api.freeco.example/v1', modelsUrl: 'https://api.freeco.example/v1/models', authType: 'api-key', apiKeysUrl: 'https://freeco.example/keys', paymentMethodRequired: 'doesNotRequirePaymentMethod' });
    expect(classifyFreeness(entry, 'free/model-1.5', undefined).freeness).toBe('free');
    expect(classifyFreeness(entry, 'free/model-1x5', undefined).freeness).toBe('unknown'); // the dot is literal
    expect(classifyFreeness(entry, 'paid/big-model', undefined).freeness).toBe('unknown');
  });

  it('keeps trial and credit tiers out of the free pool, and marks unknown training use', () => {
    const trial = deriveCatalogEntry(discovered({ freeKind: 'credit', cardRequired: true, training: 'unknown' }))!;
    expect(trial.freeTier.kind).toBe('trial');
    expect(classifyFreeness(trial, 'free/model-1.5', undefined).freeness).toBe('trial');
    expect(trial.paymentMethodRequired).toBe('requiresPaymentMethod');
    expect(trial.privacyWarning).toMatch(/does not say whether/);
    const none = deriveCatalogEntry(discovered({ models: [] }))!;
    expect(none.modelRules?.freeness).toEqual({ kind: 'never' });
  });

  it('refuses providers it cannot call safely with the generic adapter', () => {
    expect(genericAdapterBlocker(discovered({ openaiCompatible: false }))).toMatch(/not OpenAI-compatible/);
    expect(genericAdapterBlocker(discovered({ openaiCompatible: 'unknown' }))).toMatch(/not OpenAI-compatible/);
    expect(genericAdapterBlocker(discovered({ baseUrl: 'http://api.freeco.example/v1' }))).toMatch(/https/);
    expect(genericAdapterBlocker(discovered({ baseUrl: 'https://{account}.freeco.example/v1' }))).toMatch(/account-specific/);
    expect(genericAdapterBlocker(discovered({ baseUrl: 'https://127.0.0.1/v1' }))).toMatch(/private or local/);
    expect(genericAdapterBlocker(discovered({ catalogProviderId: 'groq' }))).toMatch(/shipped catalog/);
  });
});

describe('the registry service enables discovered providers', () => {
  it('gives them adapters after a refresh and again after a restart; a shipped entry still wins', async () => {
    const catalog = new ProviderCatalog();
    const svc = new FreeModelRegistryService(dir, catalog, new CloudCredentialStore());
    await svc.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture(), secondary: secondaryFixture() }) });
    const trialco = svc.providers().find((p) => p.displayName === 'TrialCo')!;
    expect(trialco.catalogProviderId).toBe(trialco.id);
    expect(new ProviderCatalog().get(trialco.id)).toMatchObject({ protocol: 'openai-compatible', baseUrl: 'https://api.trialco.example/v1' });
    expect(new ProviderCatalog().list().some((p) => p.id === trialco.id)).toBe(true);
    expect(new ProviderCatalog().get('groq')?.displayName).toBe('Groq');

    setDerivedProviders([]);
    const restarted = new FreeModelRegistryService(dir, new ProviderCatalog(), new CloudCredentialStore());
    expect(restarted.providers().find((p) => p.displayName === 'TrialCo')?.catalogProviderId).toBe(trialco.id);
    expect(new ProviderCatalog().has(trialco.id)).toBe(true);
  });

  it('plain reconciliation without the service still marks registry-only providers as discovered', () => {
    const merged = reconcileRegistry({ primary: parsePrimaryRegistry(primaryFixture()).providers, secondary: parseSecondaryRegistry(secondaryFixture()).providers }, new ProviderCatalog());
    expect(merged.find((p) => p.displayName === 'TrialCo')?.catalogProviderId).toBeUndefined();
  });
});

describe('NVIDIA API Catalog', () => {
  it('counts NVIDIA-hosted models as free (owner, 2026-11-13)', () => {
    const nvidia = new ProviderCatalog().get('nvidia')!;
    expect(nvidia.freeTier.kind).toBe('recurring');
    expect(classifyFreeness(nvidia, 'meta/llama-3.3-70b-instruct', undefined).freeness).toBe('free');
  });
});
