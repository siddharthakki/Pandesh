/**
 * Data-driven provider catalog (host-neutral, JARVIS-reusable).
 *
 * The catalog is DATA ONLY. It describes providers and configures shipped, trusted
 * protocol adapters; it never carries or fetches executable code. A remote catalog
 * can refresh informational metadata and add new providers, but it can never change
 * a built-in provider's credential-bearing fields (base URL, protocol, auth type),
 * so a poisoned catalog cannot redirect a stored API key to another host.
 */
import builtinCatalogJson from './data/providerCatalog.json';

export type ProviderProtocol = 'openai-compatible' | 'ollama' | 'gemini' | 'cloudflare' | 'cohere';
/** Protocols with a shipped adapter. A remote entry naming anything else is rejected. */
export const SHIPPED_PROTOCOLS: readonly ProviderProtocol[] = ['openai-compatible', 'ollama', 'gemini', 'cloudflare', 'cohere'];

export type FreeTierKind = 'recurring' | 'promotional' | 'trial' | 'paid' | 'unknown';
export type PaymentRequirement = 'requiresPaymentMethod' | 'doesNotRequirePaymentMethod' | 'unknown';
export type ProviderAuthType = 'api-key' | 'oauth-device' | 'none';
export type ProviderCapabilityTag = 'tools' | 'vision' | 'streaming' | 'structured-output' | 'reasoning';

export type FreenessRule =
  /** Free iff the model list reports a zero prompt AND completion price; paid if either is positive. */
  | { kind: 'pricing-zero' }
  /** Free iff the model id ends with one of the documented suffixes. */
  | { kind: 'id-suffix'; suffixes: string[] }
  /** Class follows the provider's documented free tier, optionally only for ids matching the patterns. */
  | { kind: 'provider-tier'; idPatterns?: string[] }
  /** The provider's model list cannot establish free status. Models stay UNKNOWN. */
  | { kind: 'never' }
  /** Your own server (llama.cpp, vLLM, LM Studio...): every model is free of charge, but ONLY on a private endpoint. */
  | { kind: 'self-hosted' };

export interface ProviderModelRules {
  freeness?: FreenessRule;
  /** `all`: every model accepts images (documented by the provider). Absent: take it from model metadata only. */
  vision?: { kind: 'all' };
}

export interface ProviderDescriptor {
  id: string;
  displayName: string;
  protocol: ProviderProtocol;
  baseUrl: string;
  signupUrl: string;
  apiKeysUrl: string;
  docsUrl: string;
  modelsUrl: string;
  authType: ProviderAuthType;
  privacyUrl?: string;
  capabilities: ProviderCapabilityTag[];
  freeTier: { kind: FreeTierKind; note?: string };
  paymentMethodRequired: PaymentRequirement;
  providerResidency?: string;
  lastVerifiedAt: string;
  sourceUrl: string;
  /** Lower number = tried earlier in the free pool. */
  fallbackPriority?: number;
  /** True when baseUrl contains a `{placeholder}` the user must fill (for example a Cloudflare account id). */
  requiresBaseUrlInput?: boolean;
  privacyWarning?: string;
  modelRules?: ProviderModelRules;
  /** Set by merge: which catalog this entry's metadata came from. */
  catalogVersion?: string;
}

export interface ProviderCatalogDocument {
  schemaVersion: 1;
  catalogVersion: string;
  providers: ProviderDescriptor[];
}

export interface CatalogValidationResult {
  ok: boolean;
  catalog?: ProviderCatalogDocument;
  errors: string[];
}

const FREE_TIER_KINDS: readonly string[] = ['recurring', 'promotional', 'trial', 'paid', 'unknown'];
const PAYMENT_KINDS: readonly string[] = ['requiresPaymentMethod', 'doesNotRequirePaymentMethod', 'unknown'];
const AUTH_TYPES: readonly string[] = ['api-key', 'oauth-device', 'none'];
const CAPABILITY_TAGS: readonly string[] = ['tools', 'vision', 'streaming', 'structured-output', 'reasoning'];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAX_PROVIDERS = 200;
const MAX_FIELD_CHARS = 2000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when the URL points at this PC or the user's own network (loopback, RFC 1918, link-local, *.local).
 * A self-hosted provider is only free of charge there: Pandesh cannot verify what a public endpoint costs.
 */
export function isPrivateEndpoint(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (host === 'localhost' || host === '::1' || host.endsWith('.local') || host.endsWith('.localhost')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return /^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host);
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

function isHttpsUrl(value: unknown, allowPlaceholder = false): value is string {
  if (typeof value !== 'string' || value.length > MAX_FIELD_CHARS) return false;
  const candidate = allowPlaceholder ? value.replace(/\{[A-Za-z]+\}/g, 'x') : value;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

function validateProvider(raw: unknown, index: number, errors: string[]): ProviderDescriptor | undefined {
  const where = `providers[${index}]`;
  if (!isRecord(raw)) { errors.push(`${where}: not an object`); return undefined; }
  const fail = (message: string): undefined => { errors.push(`${where}${typeof raw.id === 'string' ? ` (${raw.id})` : ''}: ${message}`); return undefined; };

  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return fail('invalid id');
  if (typeof raw.displayName !== 'string' || !raw.displayName.trim() || raw.displayName.length > 120) return fail('invalid displayName');
  if (typeof raw.protocol !== 'string' || !(SHIPPED_PROTOCOLS as readonly string[]).includes(raw.protocol)) return fail(`unsupported protocol '${String(raw.protocol)}' (only shipped adapters are allowed)`);
  const placeholderOk = raw.requiresBaseUrlInput === true;
  if (!isHttpsUrl(raw.baseUrl, placeholderOk)) return fail('baseUrl must be an https URL');
  for (const field of ['signupUrl', 'apiKeysUrl', 'docsUrl', 'sourceUrl'] as const) {
    if (!isHttpsUrl(raw[field])) return fail(`${field} must be an https URL`);
  }
  if (!isHttpsUrl(raw.modelsUrl, placeholderOk)) return fail('modelsUrl must be an https URL');
  if (raw.privacyUrl !== undefined && !isHttpsUrl(raw.privacyUrl)) return fail('privacyUrl must be an https URL');
  if (typeof raw.authType !== 'string' || !AUTH_TYPES.includes(raw.authType)) return fail('invalid authType');
  if (!Array.isArray(raw.capabilities) || raw.capabilities.some(tag => typeof tag !== 'string' || !CAPABILITY_TAGS.includes(tag))) return fail('invalid capabilities');
  if (!isRecord(raw.freeTier) || typeof raw.freeTier.kind !== 'string' || !FREE_TIER_KINDS.includes(raw.freeTier.kind)) return fail('invalid freeTier.kind');
  if (typeof raw.paymentMethodRequired !== 'string' || !PAYMENT_KINDS.includes(raw.paymentMethodRequired)) return fail('invalid paymentMethodRequired');
  if (typeof raw.lastVerifiedAt !== 'string' || !raw.lastVerifiedAt) return fail('lastVerifiedAt required');
  for (const field of ['providerResidency', 'privacyWarning'] as const) {
    if (raw[field] !== undefined && (typeof raw[field] !== 'string' || (raw[field] as string).length > MAX_FIELD_CHARS)) return fail(`invalid ${field}`);
  }
  if (isRecord(raw.freeTier) && raw.freeTier.note !== undefined && (typeof raw.freeTier.note !== 'string' || raw.freeTier.note.length > MAX_FIELD_CHARS)) return fail('invalid freeTier.note');
  if (raw.fallbackPriority !== undefined && (typeof raw.fallbackPriority !== 'number' || !Number.isFinite(raw.fallbackPriority))) return fail('invalid fallbackPriority');

  const rules = raw.modelRules;
  if (rules !== undefined) {
    if (!isRecord(rules)) return fail('invalid modelRules');
    const freeness = rules.freeness;
    if (freeness !== undefined) {
      if (!isRecord(freeness) || !['pricing-zero', 'id-suffix', 'provider-tier', 'never', 'self-hosted'].includes(String(freeness.kind))) return fail('invalid freeness rule');
      if (freeness.kind === 'id-suffix' && (!Array.isArray(freeness.suffixes) || freeness.suffixes.some(s => typeof s !== 'string' || !s))) return fail('invalid id-suffix rule');
      if (freeness.kind === 'provider-tier' && freeness.idPatterns !== undefined) {
        if (!Array.isArray(freeness.idPatterns) || freeness.idPatterns.some(p => typeof p !== 'string' || p.length > 80)) return fail('invalid idPatterns');
        for (const pattern of freeness.idPatterns as string[]) {
          try { new RegExp(pattern, 'i'); } catch { return fail('idPattern is not a valid regular expression'); }
        }
      }
    }
    if (rules.vision !== undefined && !(isRecord(rules.vision) && rules.vision.kind === 'all')) return fail('invalid vision rule');
  }
  return raw as unknown as ProviderDescriptor;
}

/** Schema validation. Invalid providers are dropped individually; an invalid envelope rejects the whole document. */
export function validateCatalog(raw: unknown): CatalogValidationResult {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ['catalog is not an object'] };
  if (raw.schemaVersion !== 1) return { ok: false, errors: [`unsupported schemaVersion ${String(raw.schemaVersion)}`] };
  if (typeof raw.catalogVersion !== 'string' || !raw.catalogVersion) return { ok: false, errors: ['catalogVersion required'] };
  if (!Array.isArray(raw.providers)) return { ok: false, errors: ['providers must be an array'] };
  if (raw.providers.length > MAX_PROVIDERS) return { ok: false, errors: [`too many providers (${raw.providers.length})`] };
  const seen = new Set<string>();
  const providers: ProviderDescriptor[] = [];
  raw.providers.forEach((entry, index) => {
    const provider = validateProvider(entry, index, errors);
    if (!provider) return;
    if (seen.has(provider.id)) { errors.push(`providers[${index}] (${provider.id}): duplicate id`); return; }
    seen.add(provider.id);
    providers.push({ ...provider, catalogVersion: raw.catalogVersion as string });
  });
  return { ok: true, catalog: { schemaVersion: 1, catalogVersion: raw.catalogVersion, providers }, errors };
}

/** The catalog shipped with the extension. Validated at load; a broken build fails loudly in tests. */
export function loadBuiltinCatalog(): ProviderCatalogDocument {
  const result = validateCatalog(builtinCatalogJson);
  if (!result.ok || !result.catalog) throw new Error(`Built-in provider catalog is invalid: ${result.errors.join('; ')}`);
  return result.catalog;
}

/** Fields only the shipped catalog may set for an existing provider: they decide where a credential is sent. */
const PROTECTED_FIELDS = ['baseUrl', 'protocol', 'authType', 'modelsUrl', 'requiresBaseUrlInput', 'modelRules'] as const;

export interface MergeReport {
  catalogVersion: string;
  updated: string[];
  added: string[];
  /** Existing providers whose protected fields the remote tried to change (ignored). */
  protectedConflicts: string[];
}

/** Merges validated remote data over the built-in catalog without ever changing credential-bearing fields. */
export function mergeCatalogs(builtin: ProviderCatalogDocument, remote: ProviderCatalogDocument): { catalog: ProviderCatalogDocument; report: MergeReport } {
  const byId = new Map(builtin.providers.map(provider => [provider.id, provider]));
  const report: MergeReport = { catalogVersion: remote.catalogVersion, updated: [], added: [], protectedConflicts: [] };
  for (const incoming of remote.providers) {
    const existing = byId.get(incoming.id);
    if (!existing) {
      byId.set(incoming.id, incoming);
      report.added.push(incoming.id);
      continue;
    }
    const merged: ProviderDescriptor = { ...existing, ...incoming };
    for (const field of PROTECTED_FIELDS) {
      if (JSON.stringify(incoming[field]) !== JSON.stringify(existing[field]) && incoming[field] !== undefined) {
        report.protectedConflicts.push(`${incoming.id}.${field}`);
      }
      (merged as unknown as Record<string, unknown>)[field] = existing[field];
    }
    byId.set(incoming.id, merged);
    report.updated.push(incoming.id);
  }
  return {
    catalog: { schemaVersion: 1, catalogVersion: `${builtin.catalogVersion}+${remote.catalogVersion}`, providers: [...byId.values()] },
    report,
  };
}

export const DEFAULT_REMOTE_CATALOG_URL = 'https://raw.githubusercontent.com/siddharthakki/ollama-agent/master/core/platform/data/providerCatalog.json';

export type CatalogRefreshResult =
  | { ok: true; catalog: ProviderCatalogDocument; report: MergeReport; skipped: string[]; remote: ProviderCatalogDocument }
  | { ok: false; reason: string; catalog: ProviderCatalogDocument };

/**
 * Fetches a remote versioned catalog and merges it. Any failure — network, HTTP,
 * oversize, JSON, schema — returns the built-in catalog untouched with a reason.
 */
export async function refreshProviderCatalog(
  builtin: ProviderCatalogDocument,
  options: { url?: string; fetchFn?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<CatalogRefreshResult> {
  const url = options.url ?? DEFAULT_REMOTE_CATALOG_URL;
  const fetchFn = options.fetchFn ?? fetch;
  const maxBytes = options.maxBytes ?? 512 * 1024;
  if (!isHttpsUrl(url)) return { ok: false, reason: 'The catalog URL must be https.', catalog: builtin };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) return { ok: false, reason: `Catalog server returned HTTP ${response.status}.`, catalog: builtin };
    const text = await response.text();
    if (text.length > maxBytes) return { ok: false, reason: 'Remote catalog is too large; ignored.', catalog: builtin };
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return { ok: false, reason: 'Remote catalog is not valid JSON.', catalog: builtin }; }
    const validated = validateCatalog(parsed);
    if (!validated.ok || !validated.catalog) return { ok: false, reason: `Remote catalog failed validation: ${validated.errors[0] ?? 'unknown'}`, catalog: builtin };
    if (compareCatalogVersions(validated.catalog.catalogVersion, builtin.catalogVersion.split('+')[0]) < 0) {
      return { ok: false, reason: 'Remote catalog is older than the built-in catalog; ignored.', catalog: builtin };
    }
    const merged = mergeCatalogs(builtin, validated.catalog);
    return { ok: true, catalog: merged.catalog, report: merged.report, skipped: validated.errors, remote: validated.catalog };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `Could not reach the catalog (${message}). Built-in providers are unaffected.`, catalog: builtin };
  } finally {
    clearTimeout(timer);
  }
}

/** Dotted-numeric comparison for `YYYY.MM.DD.n` style versions. */
export function compareCatalogVersions(a: string, b: string): number {
  const left = a.split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = b.split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export class ProviderCatalog {
  private doc: ProviderCatalogDocument;
  constructor(doc: ProviderCatalogDocument = loadBuiltinCatalog()) { this.doc = doc; }
  get version(): string { return this.doc.catalogVersion; }
  list(): readonly ProviderDescriptor[] { return this.doc.providers; }
  get(id: string): ProviderDescriptor | undefined { return this.doc.providers.find(provider => provider.id === id); }
  has(id: string): boolean { return this.get(id) !== undefined; }
  replace(doc: ProviderCatalogDocument): void { this.doc = doc; }
  async refresh(options?: Parameters<typeof refreshProviderCatalog>[1]): Promise<CatalogRefreshResult> {
    const result = await refreshProviderCatalog(loadBuiltinCatalog(), options);
    if (result.ok) this.doc = result.catalog;
    return result;
  }

  /** Re-applies a previously validated remote document (for example one persisted by the host) over the built-in data. */
  applyStoredRemote(raw: unknown): boolean {
    const validated = validateCatalog(raw);
    if (!validated.ok || !validated.catalog) return false;
    this.doc = mergeCatalogs(loadBuiltinCatalog(), validated.catalog).catalog;
    return true;
  }
}

/** Resolves `{accountId}`-style placeholders; returns undefined while any remain unfilled. */
export function resolveBaseUrl(template: string, values: Record<string, string> = {}): string | undefined {
  let unresolved = false;
  const out = template.replace(/\{([A-Za-z]+)\}/g, (_match, name: string) => {
    const value = values[name]?.trim();
    if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) { unresolved = true; return ''; }
    return value;
  });
  return unresolved ? undefined : out.replace(/\/$/, '');
}
