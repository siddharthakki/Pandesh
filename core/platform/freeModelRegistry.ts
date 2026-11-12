/**
 * Free-model registry: upstream discovery data, reconciled and kept honest (host-neutral, pure, no I/O).
 *
 * Upstream registries are DISCOVERY INPUTS, never authorities. Every value read from them is untrusted data:
 *  - strings are stripped of control characters and length-capped, and are never placed in a prompt;
 *  - URLs must be https and are only ever shown or, for a provider the user explicitly approves, pinned;
 *  - for a provider Pandesh already ships, the shipped catalog's base URL always wins (an upstream that names
 *    another host is recorded as a conflict, never followed), so a poisoned registry cannot redirect a key;
 *  - an upstream "free" claim can make a model at most `unverified`. Only Pandesh's own check against the
 *    provider (its model list priced at zero, or the catalog's documented free-tier rule, with the user's key)
 *    makes a model `verified_free`.
 * Missing information stays unknown. Nothing here invents a limit, a capability or a privacy guarantee.
 */
import { createHash } from 'node:crypto';
import { isPrivateEndpoint, type FreeTierKind, type PaymentRequirement, type ProviderCatalog, type ProviderDescriptor } from './providerCatalog';

export type RegistrySourceId = 'primary' | 'secondary';
export type Tri = boolean | 'unknown';
export type RegistryStatus = 'unknown' | 'unverified' | 'verified_free' | 'restricted' | 'unavailable';
export type FreeKind = 'recurring' | 'trial' | 'credit' | 'paid' | 'unknown';
export type TrainingUse = 'no' | 'opt-out' | 'yes' | 'unknown';

export interface RegistrySourceInfo {
  id: RegistrySourceId;
  name: string;
  repository: string;
  url: string;
  license: string;
  role: string;
}

/** Pinned upstream data files. Only these URLs are fetched; nothing else from those repositories is read or run. */
export const REGISTRY_SOURCES: readonly RegistrySourceInfo[] = [
  {
    id: 'primary',
    name: 'awesome-free-ai-coding',
    repository: 'https://github.com/mvalentsev/awesome-free-ai-coding',
    url: 'https://raw.githubusercontent.com/mvalentsev/awesome-free-ai-coding/main/index.json',
    license: 'MIT',
    role: 'Primary discovery registry (generated index.json)',
  },
  {
    id: 'secondary',
    name: 'free-llm-api-hub',
    repository: 'https://github.com/pacocartones/free-llm-api-hub',
    url: 'https://raw.githubusercontent.com/pacocartones/free-llm-api-hub/main/data/providers.json',
    license: 'MIT',
    role: 'Secondary verification registry (canonical data/providers.json)',
  },
];

/** Recorded, not imported: it publishes README tables only, and README scraping is not done. */
export const UNIMPORTED_SOURCES = [
  { name: 'awesome-free-llm-apis', repository: 'https://github.com/golapkamal/awesome-free-llm-apis', license: 'MIT', reason: 'No machine-readable data file; README-only lists are not scraped.' },
] as const;

export interface RegistryQuota {
  amount: number;
  unit: string;
  period: string;
  scope?: string;
  modelIds?: string[];
  condition?: string;
}

export interface RegistryModelLimits { contextTokens?: number; outputTokens?: number }

/** One provider as ONE source describes it, after validation and sanitising. */
export interface SourceProvider {
  source: RegistrySourceId;
  key: string;
  name: string;
  baseUrl?: string;
  host?: string;
  openaiCompatible: Tri;
  auth: 'api-key' | 'none' | 'unknown';
  keyUrl?: string;
  docsUrl?: string;
  cardRequired: Tri;
  phoneRequired: Tri;
  commercialUse: Tri;
  freeKind: FreeKind;
  archived: boolean;
  provisional: boolean;
  verifiedBySource: Tri;
  lastVerified?: string;
  probeFailures?: number;
  training: TrainingUse;
  retention?: string;
  textModel: Tri;
  quotas: RegistryQuota[];
  models: Array<{ id: string } & RegistryModelLimits>;
  notes?: string;
  /** Text in this entry that reads like an instruction to an AI. Kept as data and flagged, never obeyed. */
  suspicious: string[];
}

export interface RegistryModel {
  /** `<canonical provider id>::<model id>` */
  key: string;
  modelId: string;
  sources: RegistrySourceId[];
  limits: RegistryModelLimits;
  status: RegistryStatus;
  statusReasons: string[];
}

export interface RegistryProvider {
  /** The shipped catalog id when the host matches one; otherwise `reg-<slug>`. */
  id: string;
  catalogProviderId?: string;
  displayName: string;
  /** The base URL Pandesh would use: always the catalog's for a catalog provider. */
  baseUrl?: string;
  host?: string;
  sources: Array<{ source: RegistrySourceId; key: string; lastVerified?: string; verifiedBySource: Tri }>;
  openaiCompatible: Tri;
  auth: 'api-key' | 'none' | 'unknown';
  requiresKey: boolean;
  keyUrl?: string;
  docsUrl?: string;
  cardRequired: Tri;
  phoneRequired: Tri;
  commercialUse: Tri;
  freeKind: FreeKind;
  training: TrainingUse;
  retention?: string;
  quotas: RegistryQuota[];
  models: RegistryModel[];
  status: RegistryStatus;
  statusReasons: string[];
  /** Disagreements between sources, or between a source and the shipped catalog. */
  conflicts: string[];
  suspicious: string[];
  lastVerified?: string;
}

export interface SourceFetchRecord {
  id: RegistrySourceId;
  url: string;
  fetchedAt: string;
  upstreamGenerated?: string;
  sha256: string;
  entryCount: number;
  accepted: number;
  rejected: number;
  /** True when this source's data in the snapshot is carried over from an earlier refresh. */
  carriedOver: boolean;
  error?: string;
}

export interface RegistrySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  sources: SourceFetchRecord[];
  /** Normalised per-source data, so a later refresh can keep one source's last good data if that source fails. */
  sourceData: Record<RegistrySourceId, SourceProvider[]>;
  providers: RegistryProvider[];
}

export interface ParseResult { providers: SourceProvider[]; rejected: string[]; generated?: string; entryCount: number }

// ── sanitising ────────────────────────────────────────────────────────────────────────────────

const MAX_TEXT = 600;
const MAX_NAME = 120;
const MAX_ENTRIES = 1000;
const MAX_MODELS = 400;
const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Cloudflare ids start with `@cf/`; nothing else may lead with a symbol. */
const MODEL_ID_PATTERN = /^@?[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/** Phrases that address an AI agent rather than describe a service. Flagged; the text is still only data. */
const INSTRUCTION_LIKE = /\b(ignore (all |any )?(previous|prior|above) (instructions|prompts?)|disregard (the )?(system|previous)|you are (now )?(an?|the) (ai|assistant|agent)|system prompt|exfiltrat|send (your|the) (api )?keys?|run (this|the following) (command|script)|curl\s+https?:|powershell\s+-|rm\s+-rf|<\s*script)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cleanText(value: unknown, max = MAX_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

/** Only https URLs survive; anything else (javascript:, data:, file:, http:, credentials in the URL) is dropped. */
export function safeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2000) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) return undefined;
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url.replace(/\{[A-Za-z]+\}/g, 'x')).hostname.toLowerCase(); } catch { return undefined; }
}

function tri(value: unknown): Tri {
  return typeof value === 'boolean' ? value : 'unknown';
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1e12 ? Math.floor(value) : undefined;
}

function isoDate(value: unknown): string | undefined {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined;
}

function suspiciousIn(...texts: Array<string | undefined>): string[] {
  const hits: string[] = [];
  for (const text of texts) {
    if (!text) continue;
    const match = INSTRUCTION_LIKE.exec(text);
    if (match) hits.push(match[0].slice(0, 60));
  }
  return hits;
}

function normalizeModelId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const id = value.trim().replace(/^models\//, '');
  return MODEL_ID_PATTERN.test(id) ? id : undefined;
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/-(free|api|ai)$/g, '').slice(0, 40) || 'provider';
}

// ── primary: awesome-free-ai-coding index.json ────────────────────────────────────────────────

function primaryTraining(value: unknown): TrainingUse {
  return value === 'no' || value === 'yes' || value === 'opt-out' ? value : 'unknown';
}

function primaryQuotas(raw: unknown): RegistryQuota[] {
  if (!Array.isArray(raw)) return [];
  const out: RegistryQuota[] = [];
  for (const q of raw.slice(0, 40)) {
    if (!isRecord(q)) continue;
    const amount = typeof q.amount === 'number' && Number.isFinite(q.amount) && q.amount > 0 ? q.amount : undefined;
    const unit = cleanText(q.unit, 30);
    const period = cleanText(q.period, 30);
    if (amount === undefined || !unit || !period) continue; // "see your account" quotas stay unknown
    const modelIds = Array.isArray(q.model_ids) ? q.model_ids.map(normalizeModelId).filter((id): id is string => Boolean(id)).slice(0, 50) : undefined;
    out.push({ amount, unit, period, scope: cleanText(q.scope, 40), condition: cleanText(q.condition, 160), ...(modelIds?.length ? { modelIds } : {}) });
  }
  return out;
}

export function parsePrimaryRegistry(raw: unknown): ParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.entries)) throw new Error('primary registry: expected an object with an entries array');
  if (raw.entries.length > MAX_ENTRIES) throw new Error(`primary registry: too many entries (${raw.entries.length})`);
  const rejected: string[] = [];
  const providers: SourceProvider[] = [];
  raw.entries.forEach((entry, index) => {
    if (!isRecord(entry)) { rejected.push(`entries[${index}]: not an object`); return; }
    const key = typeof entry.id === 'string' && KEY_PATTERN.test(entry.id) ? entry.id : undefined;
    const name = cleanText(entry.name, MAX_NAME);
    if (!key || !name) { rejected.push(`entries[${index}]: missing id or name`); return; }
    const api = isRecord(entry.api) ? entry.api : undefined;
    // Only API providers are model sources; agent CLIs and IDE plans are out of scope for routing.
    if (!api) return;
    const rawBase = api.base_url;
    const baseUrl = safeHttpsUrl(rawBase);
    if (rawBase !== undefined && !baseUrl) rejected.push(`${key}: base_url is not a safe https URL (dropped)`);
    const limits = isRecord(api.model_limits) ? api.model_limits : {};
    const modelIds = Array.isArray(api.model_ids) ? api.model_ids : [];
    const models: SourceProvider['models'] = [];
    for (const rawId of modelIds.slice(0, MAX_MODELS)) {
      const id = normalizeModelId(rawId);
      if (!id) { rejected.push(`${key}: model id rejected`); continue; }
      const lim = isRecord(limits[id]) ? limits[id] as Record<string, unknown> : {};
      models.push({ id, contextTokens: positiveInt(lim.context_tokens), outputTokens: positiveInt(lim.output_tokens) });
    }
    const category = typeof entry.category === 'string' ? entry.category : '';
    const dataUse = isRecord(entry.data_use) ? entry.data_use : {};
    const notes = cleanText(api.note) ?? cleanText(entry.offering);
    const limitsText = cleanText(entry.limits);
    providers.push({
      source: 'primary',
      key,
      name,
      baseUrl,
      host: hostOf(baseUrl),
      openaiCompatible: tri(api.openai_compatible),
      auth: api.auth === 'api-key' ? 'api-key' : api.auth === 'none' ? 'none' : 'unknown',
      keyUrl: safeHttpsUrl(api.key_url),
      docsUrl: Array.isArray(entry.source_urls) ? safeHttpsUrl(entry.source_urls[0]) : undefined,
      cardRequired: tri(entry.card_required),
      phoneRequired: 'unknown',
      commercialUse: 'unknown',
      freeKind: category === 'trial' ? 'trial' : category === 'api-free-tier' || category === 'aggregator' ? 'recurring' : 'unknown',
      archived: entry.archived === true,
      provisional: entry.provisional === true,
      verifiedBySource: entry.provisional === true ? false : typeof entry.last_verified === 'string' ? true : 'unknown',
      lastVerified: isoDate(entry.last_verified),
      probeFailures: typeof entry.probe_failures === 'number' ? entry.probe_failures : undefined,
      training: primaryTraining(dataUse.trains),
      textModel: models.length > 0 ? true : 'unknown',
      quotas: primaryQuotas(entry.quotas),
      models,
      notes,
      suspicious: suspiciousIn(name, notes, limitsText, cleanText(entry.offering), cleanText(dataUse.quote)),
    });
  });
  return { providers, rejected, generated: isoDate(raw.generated), entryCount: raw.entries.length };
}

// ── secondary: free-llm-api-hub data/providers.json ──────────────────────────────────────────

function secondaryFreeKind(freeType: unknown, category: unknown): FreeKind {
  if (freeType === 'renewing-quota' || freeType === 'perpetual') return 'recurring';
  if (freeType === 'trial-credit') return 'trial';
  if (freeType === 'recurring-credit') return 'credit';
  if (category === 'trial') return 'trial';
  return 'unknown';
}

function secondaryTraining(value: unknown): TrainingUse {
  if (value === false) return 'no';
  if (value === true) return 'yes';
  return 'unknown';
}

export function parseSecondaryRegistry(raw: unknown): ParseResult {
  if (!isRecord(raw) || !Array.isArray(raw.providers)) throw new Error('secondary registry: expected an object with a providers array');
  if (raw.providers.length > MAX_ENTRIES) throw new Error(`secondary registry: too many providers (${raw.providers.length})`);
  const rejected: string[] = [];
  const providers: SourceProvider[] = [];
  raw.providers.forEach((entry, index) => {
    if (!isRecord(entry)) { rejected.push(`providers[${index}]: not an object`); return; }
    const key = typeof entry.slug === 'string' && KEY_PATTERN.test(entry.slug) ? entry.slug : undefined;
    const name = cleanText(entry.name, MAX_NAME);
    if (!key || !name) { rejected.push(`providers[${index}]: missing slug or name`); return; }
    if (entry.is_text_llm === false) return; // GPU/compute/audio-only offers are not chat model sources
    const rawBase = entry.openai_base_url;
    const baseUrl = safeHttpsUrl(rawBase);
    if (typeof rawBase === 'string' && rawBase && !baseUrl) rejected.push(`${key}: openai_base_url is not a safe https URL (dropped)`);
    const models: SourceProvider['models'] = [];
    for (const rawId of (Array.isArray(entry.models_free) ? entry.models_free : []).slice(0, MAX_MODELS)) {
      const id = normalizeModelId(rawId);
      if (id) models.push({ id }); else rejected.push(`${key}: model id rejected`);
    }
    const quotas: RegistryQuota[] = [];
    const fl = isRecord(entry.free_limits) ? entry.free_limits : undefined;
    if (fl) {
      const scope = cleanText(fl.scope, 160);
      const add = (field: string, unit: string, period: string) => {
        const amount = positiveInt(fl[field]);
        if (amount) quotas.push({ amount, unit, period, scope });
      };
      add('requests_per_minute', 'requests', 'minute');
      add('requests_per_day', 'requests', 'day');
      add('tokens_per_minute', 'tokens', 'minute');
      add('tokens_per_day', 'tokens', 'day');
    }
    const policy = isRecord(entry.data_policy) ? entry.data_policy : {};
    const notes = cleanText(entry.notes);
    providers.push({
      source: 'secondary',
      key,
      name,
      baseUrl,
      host: hostOf(baseUrl),
      openaiCompatible: tri(entry.openai_compatible),
      auth: 'unknown',
      docsUrl: safeHttpsUrl(entry.docs_url),
      cardRequired: tri(entry.card_required),
      phoneRequired: tri(entry.phone_required),
      commercialUse: tri(entry.commercial_ok),
      freeKind: secondaryFreeKind(entry.free_type, entry.category),
      archived: false,
      provisional: false,
      verifiedBySource: tri(entry.verified),
      lastVerified: isoDate(entry.last_verified),
      training: secondaryTraining(policy.trains_on_prompts),
      retention: cleanText(policy.retention, 240),
      textModel: tri(entry.is_text_llm),
      quotas,
      models,
      notes,
      suspicious: suspiciousIn(name, notes, cleanText(entry.free_tier), cleanText(entry.rate_limits), cleanText(policy.note)),
    });
  });
  return { providers, rejected, generated: isoDate(raw.generated), entryCount: raw.providers.length };
}

// ── reconciliation ───────────────────────────────────────────────────────────────────────────

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Stricter value of two free kinds: the less generous claim wins when sources disagree. */
function stricterFreeKind(a: FreeKind, b: FreeKind): FreeKind {
  const order: FreeKind[] = ['paid', 'trial', 'credit', 'unknown', 'recurring'];
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

/** The less private training answer wins: one source saying "yes" outweighs another saying "no". */
function stricterTraining(a: TrainingUse, b: TrainingUse): TrainingUse {
  const order: TrainingUse[] = ['yes', 'opt-out', 'unknown', 'no'];
  if (a === 'unknown') return b;
  if (b === 'unknown') return a;
  return order.indexOf(a) <= order.indexOf(b) ? a : b;
}

function mergeTriStrict(a: Tri, b: Tri, restrictiveValue: boolean): Tri {
  if (a === restrictiveValue || b === restrictiveValue) return restrictiveValue;
  if (a === 'unknown') return b;
  return a;
}

function nameKey(name: string): string {
  return slugify(name).replace(/-/g, '');
}

/** Groups source entries that describe the same provider: same API host, else same normalised name. */
function groupSources(entries: readonly SourceProvider[], catalog: ProviderCatalog | undefined): Map<string, SourceProvider[]> {
  const catalogByHost = new Map<string, ProviderDescriptor>();
  for (const provider of catalog?.list() ?? []) {
    const host = hostOf(provider.baseUrl);
    if (host && host !== 'localhost' && provider.modelRules?.freeness?.kind !== 'self-hosted') catalogByHost.set(host, provider);
  }
  const groups = new Map<string, SourceProvider[]>();
  const hostToGroup = new Map<string, string>();
  const nameToGroup = new Map<string, string>();
  // Hosts first so a name-only entry can join a host group with the same name.
  const ordered = [...entries].sort((a, b) => Number(Boolean(b.host)) - Number(Boolean(a.host)));
  for (const entry of ordered) {
    let groupId: string | undefined;
    if (entry.host) {
      const cat = catalogByHost.get(entry.host);
      groupId = hostToGroup.get(entry.host) ?? (cat ? cat.id : undefined);
    }
    // Names join only entries that publish no API host: a different host is never the same provider, whatever it
    // calls itself (a look-alike "Groq" on another domain must not inherit Groq's identity, models or key).
    if (!entry.host) groupId ??= nameToGroup.get(nameKey(entry.name));
    if (!groupId) {
      const cat = entry.host ? catalogByHost.get(entry.host) : undefined;
      groupId = cat ? cat.id : `reg-${slugify(entry.name)}`;
      const sameProvider = (e: SourceProvider) => (entry.host ? e.host === entry.host : !e.host && nameKey(e.name) === nameKey(entry.name));
      while (groups.has(groupId) && !groups.get(groupId)!.some(sameProvider)) groupId = `${groupId}-x`;
    }
    if (entry.host) hostToGroup.set(entry.host, groupId);
    if (!nameToGroup.has(nameKey(entry.name))) nameToGroup.set(nameKey(entry.name), groupId);
    const list = groups.get(groupId) ?? [];
    list.push(entry);
    groups.set(groupId, list);
  }
  return groups;
}

function providerStatus(p: Omit<RegistryProvider, 'status' | 'statusReasons'>, entries: readonly SourceProvider[]): { status: RegistryStatus; reasons: string[] } {
  const reasons: string[] = [];
  if (entries.every(e => e.archived)) return { status: 'unavailable', reasons: ['archived by every source that lists it'] };
  if (p.openaiCompatible === false) return { status: 'unavailable', reasons: ['not OpenAI-compatible; Pandesh has no adapter for it'] };
  if (!p.baseUrl) return { status: 'unknown', reasons: ['no safe https API endpoint is published'] };
  if (p.freeKind === 'paid') reasons.push('a source lists it as paid only');
  if (p.freeKind === 'trial' || p.freeKind === 'credit') reasons.push(`free access is ${p.freeKind === 'trial' ? 'trial credit' : 'credit-limited'}, not a recurring free tier`);
  if (p.cardRequired === true) reasons.push('a payment card is required');
  if (p.training === 'yes') reasons.push('a source says prompts may be used for training');
  if (p.commercialUse === false) reasons.push('a source says commercial use is not allowed');
  if (p.suspicious.length) reasons.push('its registry text contains instruction-like content (treated as data)');
  if (reasons.length) return { status: 'restricted', reasons };
  if (p.freeKind === 'unknown') return { status: 'unknown', reasons: ['free-tier terms are not established'] };
  return { status: 'unverified', reasons: ['listed as free upstream; not yet verified by Pandesh against the provider'] };
}

/** Reconciles both sources into one canonical record per provider and per model, with provenance and conflicts. */
export function reconcileRegistry(sourceData: Record<RegistrySourceId, readonly SourceProvider[]>, catalog?: ProviderCatalog): RegistryProvider[] {
  const groups = groupSources([...(sourceData.primary ?? []), ...(sourceData.secondary ?? [])], catalog);
  const out: RegistryProvider[] = [];
  for (const [id, entries] of groups) {
    const cat = catalog?.get(id);
    const conflicts: string[] = [];
    const hosts = [...new Set(entries.map(e => e.host).filter((h): h is string => Boolean(h)))];
    if (hosts.length > 1) conflicts.push(`sources name different API hosts: ${hosts.join(', ')}`);
    let baseUrl = entries.find(e => e.source === 'primary' && e.baseUrl)?.baseUrl ?? entries.find(e => e.baseUrl)?.baseUrl;
    if (cat) {
      if (baseUrl && hostOf(baseUrl) !== hostOf(cat.baseUrl)) conflicts.push(`upstream base URL host ${hostOf(baseUrl)} differs from the shipped catalog; the catalog is used`);
      baseUrl = cat.baseUrl;
    }
    const fk = entries.map(e => e.freeKind);
    if (new Set(fk.filter(k => k !== 'unknown')).size > 1) conflicts.push(`sources disagree on the free tier (${entries.map(e => `${e.source}: ${e.freeKind}`).join(', ')}); the stricter claim is used`);
    const tr = entries.map(e => e.training).filter(t => t !== 'unknown');
    if (new Set(tr).size > 1) conflicts.push(`sources disagree on training use (${entries.map(e => `${e.source}: ${e.training}`).join(', ')}); the less private answer is used`);

    const models = new Map<string, RegistryModel>();
    for (const entry of entries) {
      for (const m of entry.models) {
        const modelKey = `${id}::${m.id}`;
        const existing = models.get(modelKey.toLowerCase());
        if (existing) {
          if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
          existing.limits.contextTokens ??= m.contextTokens;
          existing.limits.outputTokens ??= m.outputTokens;
        } else {
          models.set(modelKey.toLowerCase(), { key: modelKey, modelId: m.id, sources: [entry.source], limits: { contextTokens: m.contextTokens, outputTokens: m.outputTokens }, status: 'unverified', statusReasons: [] });
        }
      }
    }
    const quotas = entries.find(e => e.source === 'primary' && e.quotas.length)?.quotas ?? entries.find(e => e.quotas.length)?.quotas ?? [];
    const base: Omit<RegistryProvider, 'status' | 'statusReasons'> = {
      id,
      catalogProviderId: cat?.id,
      displayName: cat?.displayName ?? entries.find(e => e.source === 'primary')?.name ?? entries[0].name,
      baseUrl,
      host: hostOf(baseUrl),
      sources: entries.map(e => ({ source: e.source, key: e.key, lastVerified: e.lastVerified, verifiedBySource: e.verifiedBySource })),
      openaiCompatible: entries.reduce<Tri>((acc, e) => mergeTriStrict(acc, e.openaiCompatible, false), 'unknown'),
      auth: entries.find(e => e.auth !== 'unknown')?.auth ?? 'unknown',
      requiresKey: cat ? cat.authType === 'api-key' : entries.some(e => e.auth === 'api-key') || !entries.some(e => e.auth === 'none'),
      keyUrl: cat?.apiKeysUrl ?? entries.find(e => e.keyUrl)?.keyUrl,
      docsUrl: cat?.docsUrl ?? entries.find(e => e.docsUrl)?.docsUrl,
      cardRequired: entries.reduce<Tri>((acc, e) => mergeTriStrict(acc, e.cardRequired, true), 'unknown'),
      phoneRequired: entries.reduce<Tri>((acc, e) => mergeTriStrict(acc, e.phoneRequired, true), 'unknown'),
      commercialUse: entries.reduce<Tri>((acc, e) => mergeTriStrict(acc, e.commercialUse, false), 'unknown'),
      freeKind: fk.reduce(stricterFreeKind),
      training: entries.map(e => e.training).reduce(stricterTraining),
      retention: entries.find(e => e.retention)?.retention,
      quotas,
      models: [...models.values()].sort((a, b) => a.modelId.localeCompare(b.modelId)),
      conflicts,
      suspicious: [...new Set(entries.flatMap(e => e.suspicious))],
      lastVerified: entries.map(e => e.lastVerified).filter((d): d is string => Boolean(d)).sort().pop(),
    };
    const { status, reasons } = providerStatus(base, entries);
    for (const model of base.models) {
      model.status = status === 'unverified' ? 'unverified' : status;
      model.statusReasons = status === 'unverified' ? ['not yet verified by Pandesh'] : reasons;
    }
    out.push({ ...base, status, statusReasons: reasons });
  }
  return out.sort((a, b) => Number(Boolean(b.catalogProviderId)) - Number(Boolean(a.catalogProviderId)) || a.displayName.localeCompare(b.displayName));
}

// ── local verification (Pandesh's own evidence) ──────────────────────────────────────────────

/** What Pandesh itself observed for one provider: its own model list, classified by the catalog's freeness rules. */
export interface LocalProviderEvidence {
  checkedAt: string;
  ok: boolean;
  errorClass?: string;
  /** Models the provider's own metadata or documented free-tier rule marks free. */
  freeModelIds: string[];
  /** Models the provider lists as paid. */
  paidModelIds: string[];
}

// ── generic adapters for discovered providers (owner, 2026-11-13: "i want all enabled") ──────────

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why a discovered provider cannot get the generic OpenAI-compatible adapter, or null when it can. */
export function genericAdapterBlocker(provider: RegistryProvider): string | null {
  if (provider.catalogProviderId) return 'already in the shipped catalog';
  if (provider.openaiCompatible !== true) return 'its API is not OpenAI-compatible, so it needs its own adapter';
  if (!provider.baseUrl || !provider.baseUrl.startsWith('https://')) return 'no https API address is listed';
  if (/[{}]/.test(provider.baseUrl)) return 'its API address needs account-specific parts';
  if (isPrivateEndpoint(provider.baseUrl)) return 'its API address is a private or local address';
  return null;
}

/**
 * A catalog entry for a discovered provider, using the generic OpenAI-compatible adapter. Only the models the registry
 * lists count as free, and only when the registry's free tier is recurring. Trial or credit tiers stay "trial", so
 * Pandesh's free-only spend policy still keeps them out of free routing. The provider still needs the owner's key, and
 * Pandesh's own health check, before anything is sent to it.
 */
export function deriveCatalogEntry(provider: RegistryProvider): ProviderDescriptor | null {
  if (genericAdapterBlocker(provider)) return null;
  const baseUrl = provider.baseUrl!.replace(/\/+$/, '');
  const freeTierKind: FreeTierKind = provider.freeKind === 'recurring' ? 'recurring' : provider.freeKind === 'trial' || provider.freeKind === 'credit' ? 'trial' : provider.freeKind === 'paid' ? 'paid' : 'unknown';
  const payment: PaymentRequirement = provider.cardRequired === true ? 'requiresPaymentMethod' : provider.cardRequired === false ? 'doesNotRequirePaymentMethod' : 'unknown';
  const patterns = provider.models.map(m => `^${escapeRegExp(m.modelId)}$`);
  const privacyWarning = provider.training === 'yes'
    ? 'The registry says this provider may use prompts to train models.'
    : provider.training === 'unknown' ? 'The registry does not say whether this provider uses prompts for training.' : undefined;
  return {
    id: provider.id,
    displayName: provider.displayName,
    protocol: 'openai-compatible',
    baseUrl,
    signupUrl: provider.keyUrl ?? provider.docsUrl ?? baseUrl,
    apiKeysUrl: provider.keyUrl ?? provider.docsUrl ?? baseUrl,
    docsUrl: provider.docsUrl ?? provider.keyUrl ?? baseUrl,
    modelsUrl: `${baseUrl}/models`,
    authType: provider.requiresKey ? 'api-key' : 'none',
    capabilities: ['streaming'],
    freeTier: { kind: freeTierKind, note: 'Added from the free-model registry with the generic OpenAI-compatible adapter; terms come from the registry and are not yet verified by Pandesh.' },
    paymentMethodRequired: payment,
    providerResidency: 'Unknown; listed by the free-model registry.',
    lastVerifiedAt: provider.lastVerified ?? '1970-01-01',
    sourceUrl: provider.docsUrl ?? provider.keyUrl ?? baseUrl,
    fallbackPriority: 500,
    ...(privacyWarning ? { privacyWarning } : {}),
    modelRules: { freeness: patterns.length > 0 ? { kind: 'provider-tier', idPatterns: patterns } : { kind: 'never' } },
  };
}

export function deriveCatalogEntries(providers: readonly RegistryProvider[]): ProviderDescriptor[] {
  return providers.map(deriveCatalogEntry).filter((entry): entry is ProviderDescriptor => entry !== null);
}

/**
 * Overlays Pandesh's own observations. Only this step can produce `verified_free`. A model the provider now prices
 * above zero becomes `restricted` even if a registry still calls it free; an upstream-listed model the provider no
 * longer lists becomes `unavailable`.
 */
export function applyLocalEvidence(providers: readonly RegistryProvider[], evidence: Readonly<Record<string, LocalProviderEvidence>>): RegistryProvider[] {
  return providers.map(provider => {
    const ev = evidence[provider.id];
    if (!ev) return provider;
    if (!ev.ok) {
      if (ev.errorClass === 'auth') return { ...provider, statusReasons: [...provider.statusReasons, 'the stored key was rejected; set it up again'] };
      if (ev.errorClass === 'unreachable' || ev.errorClass === 'timeout' || ev.errorClass === 'provider_error') {
        return { ...provider, status: provider.status === 'restricted' ? 'restricted' : 'unavailable', statusReasons: [...provider.statusReasons, `health check failed (${ev.errorClass}) at ${ev.checkedAt}`] };
      }
      return provider;
    }
    const free = new Set(ev.freeModelIds.map(id => id.toLowerCase()));
    const paid = new Set(ev.paidModelIds.map(id => id.toLowerCase()));
    const listed = new Map(provider.models.map(m => [m.modelId.toLowerCase(), m]));
    const models: RegistryModel[] = provider.models.map(model => {
      const id = model.modelId.toLowerCase();
      if (free.has(id)) {
        return provider.status === 'restricted'
          ? { ...model, status: 'restricted', statusReasons: [...provider.statusReasons, 'priced free by the provider, but the provider is restricted'] }
          : { ...model, status: 'verified_free', statusReasons: [`the provider's own model list shows it free (${ev.checkedAt})`] };
      }
      if (paid.has(id)) return { ...model, status: 'restricted', statusReasons: [`the provider now prices it above zero (${ev.checkedAt}); excluded from free routing`] };
      return { ...model, status: 'unavailable', statusReasons: [`the provider did not list it free at ${ev.checkedAt}`] };
    });
    // Models the provider itself reports free but no registry knows about yet are real discoveries too.
    for (const id of ev.freeModelIds) {
      if (listed.has(id.toLowerCase())) continue;
      models.push({ key: `${provider.id}::${id}`, modelId: id, sources: [], limits: {}, status: provider.status === 'restricted' ? 'restricted' : 'verified_free', statusReasons: [`found in the provider's own free model list (${ev.checkedAt})`] });
    }
    const anyVerified = models.some(m => m.status === 'verified_free');
    return {
      ...provider,
      models,
      status: provider.status === 'restricted' ? 'restricted' : anyVerified ? 'verified_free' : 'unavailable',
      statusReasons: provider.status === 'restricted' ? provider.statusReasons : anyVerified ? [`verified against the provider at ${ev.checkedAt}`] : ['no model is free at the provider right now'],
    };
  });
}

// ── change report ────────────────────────────────────────────────────────────────────────────

export interface RegistryChangeReport {
  providersAdded: string[];
  providersRemoved: string[];
  modelsAdded: string[];
  modelsRemoved: string[];
  freeTierChanged: string[];
  statusChanged: string[];
  quotaChanged: string[];
  endpointChanged: string[];
  summary: string;
}

const LIST_CAP = 200;

export function diffRegistries(previous: readonly RegistryProvider[] | undefined, next: readonly RegistryProvider[]): RegistryChangeReport {
  const before = new Map((previous ?? []).map(p => [p.id, p]));
  const after = new Map(next.map(p => [p.id, p]));
  const r: RegistryChangeReport = { providersAdded: [], providersRemoved: [], modelsAdded: [], modelsRemoved: [], freeTierChanged: [], statusChanged: [], quotaChanged: [], endpointChanged: [], summary: '' };
  for (const [id, p] of after) {
    const old = before.get(id);
    if (!old) { r.providersAdded.push(id); r.modelsAdded.push(...p.models.map(m => m.key)); continue; }
    if (old.freeKind !== p.freeKind) r.freeTierChanged.push(`${id}: ${old.freeKind} → ${p.freeKind}`);
    if (old.status !== p.status) r.statusChanged.push(`${id}: ${old.status} → ${p.status}`);
    if (JSON.stringify(old.quotas) !== JSON.stringify(p.quotas)) r.quotaChanged.push(id);
    if (old.baseUrl !== p.baseUrl) r.endpointChanged.push(`${id}: ${old.baseUrl ?? '(none)'} → ${p.baseUrl ?? '(none)'}`);
    const oldModels = new Set(old.models.map(m => m.key));
    const newModels = new Set(p.models.map(m => m.key));
    for (const key of newModels) if (!oldModels.has(key)) r.modelsAdded.push(key);
    for (const key of oldModels) if (!newModels.has(key)) r.modelsRemoved.push(key);
  }
  for (const [id, p] of before) if (!after.has(id)) { r.providersRemoved.push(id); r.modelsRemoved.push(...p.models.map(m => m.key)); }
  for (const key of Object.keys(r) as Array<keyof RegistryChangeReport>) {
    const value = r[key];
    if (Array.isArray(value) && value.length > LIST_CAP) value.splice(LIST_CAP);
  }
  const parts = [
    `${r.providersAdded.length} provider(s) added`,
    `${r.providersRemoved.length} removed`,
    `${r.modelsAdded.length} model(s) added`,
    `${r.modelsRemoved.length} removed`,
    `${r.freeTierChanged.length} free-tier change(s)`,
    `${r.statusChanged.length} status change(s)`,
    `${r.endpointChanged.length} endpoint change(s)`,
  ];
  r.summary = previous ? parts.join(', ') : `first import: ${next.length} providers, ${next.reduce((n, p) => n + p.models.length, 0)} models`;
  return r;
}

/**
 * Refuses a source update that looks truncated or broken: an empty list, or one that lost more than half of the
 * providers the last good copy had. The caller keeps the last good data for that source.
 */
export function sourceUpdateLooksIncomplete(previous: readonly SourceProvider[] | undefined, next: readonly SourceProvider[]): string | undefined {
  if (next.length === 0) return 'the source returned no usable providers';
  if (previous && previous.length >= 10 && next.length < previous.length * 0.5) return `the source shrank from ${previous.length} to ${next.length} providers`;
  return undefined;
}

export interface RegistryCounts {
  providers: number;
  models: number;
  byStatus: Record<RegistryStatus, number>;
  modelsByStatus: Record<RegistryStatus, number>;
  inBothSources: number;
  requiresKey: number;
  conflicts: number;
}

export function registryCounts(providers: readonly RegistryProvider[]): RegistryCounts {
  const zero = (): Record<RegistryStatus, number> => ({ unknown: 0, unverified: 0, verified_free: 0, restricted: 0, unavailable: 0 });
  const c: RegistryCounts = { providers: providers.length, models: 0, byStatus: zero(), modelsByStatus: zero(), inBothSources: 0, requiresKey: 0, conflicts: 0 };
  for (const p of providers) {
    c.byStatus[p.status] += 1;
    c.models += p.models.length;
    for (const m of p.models) c.modelsByStatus[m.status] += 1;
    if (new Set(p.sources.map(s => s.source)).size > 1) c.inBothSources += 1;
    if (p.requiresKey) c.requiresKey += 1;
    if (p.conflicts.length) c.conflicts += 1;
  }
  return c;
}
