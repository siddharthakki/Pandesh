/**
 * Free-model registry runtime: fetches the pinned upstream data, keeps the last known-good copy, overlays Pandesh's
 * own provider checks and qualification results, and answers routing questions for the existing pool router.
 *
 * Storage (all non-secret, under Core's data dir `free-models/`): registry.json (snapshot + per-source data),
 * evidence.json (Pandesh's own model-list checks), qualifications.json, preferences.json, last-report.json.
 * Every write is atomic (temp file + rename, previous copy kept as .bak). A failed or suspicious upstream fetch never
 * replaces good data. No API key is ever written here; keys stay in the in-memory CloudCredentialStore.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  REGISTRY_SOURCES,
  UNIMPORTED_SOURCES,
  applyLocalEvidence,
  deriveCatalogEntries,
  diffRegistries,
  parsePrimaryRegistry,
  parseSecondaryRegistry,
  reconcileRegistry,
  registryCounts,
  sha256,
  sourceUpdateLooksIncomplete,
  type LocalProviderEvidence,
  type RegistryChangeReport,
  type RegistryProvider,
  type RegistrySnapshot,
  type RegistrySourceId,
  type SourceFetchRecord,
  type SourceProvider,
} from '../platform/freeModelRegistry';
import {
  DEFAULT_ROUTING_PREFERENCES,
  cloudModelEligibility,
  normalizeRoutingPreferences,
  qualificationKey,
  routeFreeCloud,
  type PrivacyClass,
  type QualificationSummary,
  type RoutingPreferences,
  type TaskClass,
} from '../platform/freeModelEligibility';
import { QuotaTracker, isQuotaFailure, type PoolDecision } from '../platform/cloudRouting';
import { humanizeModelName, type ModelDescriptor } from '../platform/modelCatalog';
import { ProviderCatalog, setDerivedProviders } from '../platform/providerCatalog';
import { listCloudModels, type CloudModelListing } from './cloudProviderProbe';
import { qualifyModel, type QualificationRecord, type QualificationOptions } from './modelQualification';
import { sharedCloudCredentials, type CloudCredentialStore } from './cloudCredentials';

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;
/** A health check (one GET /models) per provider at most this often, so free quotas are respected. */
export const HEALTH_TTL_MS = 30 * 60_000;

type FetchFn = typeof fetch;

export interface EvidenceEntry extends LocalProviderEvidence {
  latencyMs: number;
  httpStatus: number | null;
  /** Free generative models from the provider's own list, as routing descriptors. */
  models: Array<{ id: string; displayName: string; contextWindow?: number; vision: boolean | 'unknown'; tools: boolean | 'unknown' }>;
}

export interface RefreshOutcome {
  ok: boolean;
  /** True when at least one source failed and its last good data was kept. */
  keptLastKnownGood: boolean;
  sources: SourceFetchRecord[];
  report: RegistryChangeReport;
  errors: string[];
}

export interface ProviderSwitchNote { from: string; to: string; reason: string }

function atomicWriteJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  if (fs.existsSync(file)) {
    try { fs.copyFileSync(file, `${file}.bak`); } catch { /* best effort */ }
  }
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | undefined {
  for (const candidate of [file, `${file}.bak`]) {
    try { return JSON.parse(fs.readFileSync(candidate, 'utf8')) as T; } catch { /* try the backup */ }
  }
  return undefined;
}

async function fetchSourceText(url: string, fetchFn: FetchFn): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json', 'user-agent': 'Pandesh-free-model-registry' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const length = Number(response.headers.get('content-length') ?? '0');
    if (length > MAX_SOURCE_BYTES) throw new Error('response is too large');
    const text = await response.text();
    if (text.length > MAX_SOURCE_BYTES) throw new Error('response is too large');
    return text;
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    throw new Error(name === 'AbortError' ? 'timed out' : (error as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

export class FreeModelRegistryService {
  readonly dir: string;
  private snapshot: RegistrySnapshot | undefined;
  private evidence: Record<string, EvidenceEntry>;
  private qualifications: Record<string, QualificationRecord>;
  private preferences: RoutingPreferences;
  private lastReport: (RegistryChangeReport & { at: string; keptLastKnownGood: boolean; errors: string[] }) | undefined;
  private refreshing: Promise<RefreshOutcome> | undefined;
  readonly quota: QuotaTracker;

  constructor(
    dataDir: string,
    private readonly catalog: ProviderCatalog = new ProviderCatalog(),
    private readonly credentials: CloudCredentialStore = sharedCloudCredentials,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.dir = path.join(dataDir, 'free-models');
    this.quota = new QuotaTracker(() => this.now().getTime());
    this.snapshot = readJson<RegistrySnapshot>(this.file('registry.json'));
    if (this.snapshot && this.snapshot.schemaVersion !== 1) this.snapshot = undefined;
    this.evidence = readJson<Record<string, EvidenceEntry>>(this.file('evidence.json')) ?? {};
    this.qualifications = readJson<Record<string, QualificationRecord>>(this.file('qualifications.json')) ?? {};
    this.preferences = normalizeRoutingPreferences(readJson(this.file('preferences.json')) ?? DEFAULT_ROUTING_PREFERENCES);
    this.lastReport = readJson(this.file('last-report.json'));
    // Discovered providers get their generic adapters as soon as Core starts, from the stored registry.
    if (this.snapshot) this.snapshot = { ...this.snapshot, providers: applyLocalEvidence(this.reconcile(this.snapshot.sourceData), this.evidence) };
  }

  /**
   * Reconciles both sources and gives every discovered OpenAI-compatible https provider the generic adapter
   * (owner, 2026-11-13: "i want all enabled"). The first pass runs without derived entries, so the set is rebuilt from
   * the registry each time; the second pass runs with them, so those providers show as having an adapter.
   */
  private reconcile(sourceData: Record<RegistrySourceId, readonly SourceProvider[]>): RegistryProvider[] {
    setDerivedProviders([]);
    setDerivedProviders(deriveCatalogEntries(reconcileRegistry(sourceData, this.catalog)));
    return reconcileRegistry(sourceData, this.catalog);
  }

  private file(name: string): string { return path.join(this.dir, name); }

  // ── refresh ───────────────────────────────────────────────────────────────────────────────

  /** One refresh at a time; concurrent callers share it. */
  refresh(options: { fetchFn?: FetchFn; urls?: Partial<Record<RegistrySourceId, string>> } = {}): Promise<RefreshOutcome> {
    this.refreshing ??= this.doRefresh(options).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async doRefresh(options: { fetchFn?: FetchFn; urls?: Partial<Record<RegistrySourceId, string>> }): Promise<RefreshOutcome> {
    const fetchFn = options.fetchFn ?? fetch;
    const previous = this.snapshot;
    const sourceData: Record<RegistrySourceId, SourceProvider[]> = { primary: previous?.sourceData.primary ?? [], secondary: previous?.sourceData.secondary ?? [] };
    const records: SourceFetchRecord[] = [];
    const errors: string[] = [];
    let anyNew = false;
    for (const source of REGISTRY_SOURCES) {
      // Acceptance runs may point a source at another https URL (to simulate an outage); never plain http.
      const envUrl = process.env[`PANDESH_FREE_REGISTRY_URL_${source.id.toUpperCase()}`];
      const url = options.urls?.[source.id] ?? (envUrl && envUrl.startsWith('https://') ? envUrl : source.url);
      const fetchedAt = this.now().toISOString();
      const prevRecord = previous?.sources.find(r => r.id === source.id);
      const carry = (error: string): void => {
        errors.push(`${source.name}: ${error}`);
        records.push(prevRecord
          ? { ...prevRecord, carriedOver: true, error }
          : { id: source.id, url, fetchedAt, sha256: '', entryCount: 0, accepted: 0, rejected: 0, carriedOver: true, error });
      };
      let text: string;
      try { text = await fetchSourceText(url, fetchFn); } catch (error) { carry(`could not be fetched (${(error as Error).message}); last known-good data kept`); continue; }
      let parsedJson: unknown;
      try { parsedJson = JSON.parse(text); } catch { carry('was not valid JSON; last known-good data kept'); continue; }
      let parsed: ReturnType<typeof parsePrimaryRegistry>;
      try {
        parsed = source.id === 'primary' ? parsePrimaryRegistry(parsedJson) : parseSecondaryRegistry(parsedJson);
      } catch (error) { carry(`failed schema validation (${(error as Error).message}); last known-good data kept`); continue; }
      const incomplete = sourceUpdateLooksIncomplete(previous?.sourceData[source.id], parsed.providers);
      if (incomplete) { carry(`looks incomplete (${incomplete}); last known-good data kept`); continue; }
      sourceData[source.id] = parsed.providers;
      anyNew = true;
      records.push({ id: source.id, url, fetchedAt, upstreamGenerated: parsed.generated, sha256: sha256(text), entryCount: parsed.entryCount, accepted: parsed.providers.length, rejected: parsed.rejected.length, carriedOver: false });
    }
    const providers = applyLocalEvidence(this.reconcile(sourceData), this.evidence);
    const report = diffRegistries(previous?.providers, providers);
    const keptLastKnownGood = records.some(r => r.carriedOver);
    if (anyNew) {
      this.snapshot = { schemaVersion: 1, generatedAt: this.now().toISOString(), sources: records, sourceData, providers };
      atomicWriteJson(this.file('registry.json'), this.snapshot);
    } else if (previous) {
      // Nothing new arrived: the stored snapshot stays exactly as it was (only the fetch records are reported).
      report.summary = 'no source could be refreshed; the last known-good registry is unchanged';
    }
    this.lastReport = { ...report, at: this.now().toISOString(), keptLastKnownGood, errors };
    atomicWriteJson(this.file('last-report.json'), this.lastReport);
    return { ok: anyNew, keptLastKnownGood, sources: records, report, errors };
  }

  /** Re-applies evidence to the stored registry (after a health check or key change) without fetching upstream. */
  private reapplyEvidence(): void {
    if (!this.snapshot) return;
    this.snapshot = { ...this.snapshot, providers: applyLocalEvidence(this.reconcile(this.snapshot.sourceData), this.evidence) };
    atomicWriteJson(this.file('registry.json'), this.snapshot);
  }

  // ── Pandesh's own checks ──────────────────────────────────────────────────────────────────

  /** Records a provider model listing (from discovery or a health check) as local evidence. */
  recordListing(providerId: string, listing: CloudModelListing): void {
    this.evidence[providerId] = {
      checkedAt: listing.checkedAt,
      ok: listing.ok,
      errorClass: listing.errorClass,
      latencyMs: listing.latencyMs,
      httpStatus: listing.httpStatus,
      freeModelIds: listing.pool.map(m => m.id),
      paidModelIds: (listing.others ?? []).filter(o => o.reason === 'paid').map(o => o.id),
      models: listing.pool.map(m => ({ id: m.id, displayName: m.displayName, contextWindow: m.contextWindow, vision: m.vision, tools: m.tools })),
    };
    if (listing.ok) this.quota.clear(providerId);
    else if (listing.errorClass === 'rate_limited') this.quota.markExhausted(providerId, 10 * 60_000);
    atomicWriteJson(this.file('evidence.json'), this.evidence);
    this.reapplyEvidence();
  }

  /** One cheap GET /models for a provider holding a key, at most once per HEALTH_TTL unless forced. */
  async healthCheck(providerId: string, options: { force?: boolean; fetchFn?: FetchFn } = {}): Promise<EvidenceEntry | { skipped: string }> {
    const descriptor = this.catalog.get(providerId);
    if (!descriptor) return { skipped: 'not a provider Pandesh has an adapter for' };
    const credential = this.credentials.get(providerId);
    if (!credential) return { skipped: 'pending setup: no API key' };
    const last = this.evidence[providerId];
    if (!options.force && last && this.now().getTime() - Date.parse(last.checkedAt) < HEALTH_TTL_MS) return last;
    this.recordListing(providerId, await listCloudModels(descriptor, credential, { fetchFn: options.fetchFn }));
    return this.evidence[providerId];
  }

  /** Health-checks every provider that has a key and is approved for automatic routing. */
  async healthCheckApproved(options: { fetchFn?: FetchFn } = {}): Promise<string[]> {
    const checked: string[] = [];
    for (const id of this.preferences.autoProviders) {
      const result = await this.healthCheck(id, options);
      if (!('skipped' in result)) checked.push(id);
    }
    return checked;
  }

  /** Runs the qualification suite for one model that Pandesh already verified free. Explicit user action only. */
  async qualify(providerId: string, modelId: string, options: QualificationOptions = {}): Promise<QualificationRecord> {
    const credential = this.credentials.get(providerId);
    if (!credential) throw new Error('pending setup: add an API key for this provider first');
    const ev = this.evidence[providerId];
    if (!ev?.ok || !ev.freeModelIds.includes(modelId)) throw new Error('only a model Pandesh verified free at the provider can be qualified; run a health check first');
    const record = await qualifyModel(providerId, credential, modelId, options);
    this.qualifications[qualificationKey(providerId, modelId)] = record;
    atomicWriteJson(this.file('qualifications.json'), this.qualifications);
    if (record.results.some(r => r.outcome === 'rate_limited')) this.quota.markExhausted(providerId, 10 * 60_000);
    return record;
  }

  // ── preferences ───────────────────────────────────────────────────────────────────────────

  getPreferences(): RoutingPreferences { return { ...this.preferences }; }

  setPreferences(next: Partial<RoutingPreferences>): RoutingPreferences {
    this.preferences = normalizeRoutingPreferences({ ...this.preferences, ...next });
    atomicWriteJson(this.file('preferences.json'), this.preferences);
    return this.getPreferences();
  }

  // ── routing ───────────────────────────────────────────────────────────────────────────────

  private routingDescriptors(): ModelDescriptor[] {
    const out: ModelDescriptor[] = [];
    for (const [providerId, ev] of Object.entries(this.evidence)) {
      const provider = this.catalog.get(providerId);
      if (!provider || !ev.ok) continue;
      for (const m of ev.models) {
        out.push({
          provider: providerId, providerName: provider.displayName, modelId: m.id, displayName: m.displayName || humanizeModelName(m.id),
          locality: 'cloud', freeness: 'free', freenessSource: 'provider-metadata', contextWindow: m.contextWindow,
          tools: m.tools, vision: m.vision, structuredOutput: 'unknown', reasoning: 'unknown', streaming: true,
          kind: 'generative', coding: 'unknown', codingSource: 'none', privacy: 'cloud-unknown-retention', aliases: [],
        });
      }
    }
    return out;
  }

  private facts(task: TaskClass, privacy: PrivacyClass) {
    const qualifications = new Map<string, QualificationSummary>(Object.entries(this.qualifications));
    return {
      privacy,
      task,
      preferences: this.preferences,
      credentialedProviders: new Set(this.credentials.providers()),
      registry: new Map((this.snapshot?.providers ?? []).map(p => [p.id, p] as const)),
      qualifications,
    };
  }

  /** The existing pool router, with registry status, approval and qualification as admission rules. */
  route(task: TaskClass, privacy: PrivacyClass, exclude?: ReadonlySet<string>): PoolDecision {
    return routeFreeCloud({ models: this.routingDescriptors(), catalog: this.catalog, facts: this.facts(task, privacy), quota: this.quota, exclude });
  }

  /** Re-checks one frozen fallback candidate at the moment it would be used. */
  stillEligible(providerId: string, modelId: string, task: TaskClass): { ok: boolean; reason?: string } {
    if (this.quota.isExhausted(providerId)) return { ok: false, reason: 'free quota exhausted' };
    const verdict = cloudModelEligibility({ provider: providerId, modelId, locality: 'cloud' }, this.facts(task, 'public'));
    return verdict.ok ? { ok: true } : { ok: false, reason: verdict.reason };
  }

  /** Called by the executor when a provider answered with a quota/rate-limit failure. */
  noteFailure(providerId: string, status: number | undefined, message: string): boolean {
    if (!isQuotaFailure(status, message)) return false;
    this.quota.markExhausted(providerId, 15 * 60_000);
    return true;
  }

  // ── read model for the UI ─────────────────────────────────────────────────────────────────

  providers(): RegistryProvider[] { return this.snapshot?.providers ?? []; }

  state() {
    const providers = this.providers();
    const credentialed = new Set(this.credentials.providers());
    return {
      generatedAt: this.snapshot?.generatedAt ?? null,
      sources: REGISTRY_SOURCES.map(source => ({ ...source, fetch: this.snapshot?.sources.find(r => r.id === source.id) ?? null })),
      unimportedSources: UNIMPORTED_SOURCES,
      counts: registryCounts(providers),
      lastReport: this.lastReport ?? null,
      preferences: this.getPreferences(),
      exhaustedProviders: this.quota.exhausted(),
      providers: providers.map(p => ({
        ...p,
        hasAdapter: Boolean(p.catalogProviderId),
        keyConfigured: credentialed.has(p.id),
        setup: !p.catalogProviderId ? 'discovered_only' : credentialed.has(p.id) ? 'configured' : p.requiresKey ? 'pending_setup' : 'no_key_needed',
        health: this.evidence[p.id] ? { checkedAt: this.evidence[p.id].checkedAt, ok: this.evidence[p.id].ok, errorClass: this.evidence[p.id].errorClass ?? null, latencyMs: this.evidence[p.id].latencyMs, freeModels: this.evidence[p.id].freeModelIds.length } : null,
      })),
      qualifications: Object.values(this.qualifications),
    };
  }
}

let active: FreeModelRegistryService | undefined;

/** The registry Core serves (set when the host-backed routes register). Undefined in tests unless set. */
export function activeFreeModelRegistry(): FreeModelRegistryService | undefined { return active; }
export function setActiveFreeModelRegistry(service: FreeModelRegistryService | undefined): void { active = service; }
