/**
 * VS Code adapter for the host-neutral cloud provider platform (core/platform).
 *
 * Responsibilities here are only host concerns: SecretStorage as the CredentialStore, non-secret
 * provider config in settings, change events for pickers/Setup, and pushing credentials to Core in
 * memory. Catalog, classification, spend policy and pool ranking live in core/platform.
 *
 * Nothing here contacts a provider unless the user connects, refreshes, or picks a model.
 */
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import {
  ORCAROUTER_LEGACY_SECRET_KEY,
  providerSecretKey,
  redactSecrets,
  type CredentialStore,
} from '../../core/platform/credentialStore';
import { ProviderCatalog, resolveBaseUrl, type ProviderDescriptor } from '../../core/platform/providerCatalog';
import { ModelCatalog, parseOpenAiCompatibleModels, type ModelDescriptor } from '../../core/platform/modelCatalog';
import { QuotaTracker } from '../../core/platform/cloudRouting';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import { ProviderAuthError } from './ProviderTypes';

/** SecretStorage-backed CredentialStore. The only place secrets cross into VS Code storage. */
export class SecretStorageCredentialStore implements CredentialStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}
  async get(key: string): Promise<string | undefined> {
    const value = await this.secrets.get(key);
    return value?.trim() ? value : undefined;
  }
  async set(key: string, value: string): Promise<void> { await this.secrets.store(key, value); }
  async delete(key: string): Promise<void> { await this.secrets.delete(key); }
}

/** The slice of CoreClient the service needs, so tests can supply a recording fake. */
export interface CloudCoreSink {
  setProviderCredential(provider: string, baseUrl: string, apiKey: string): Promise<unknown>;
  clearProviderCredential(provider: string): Promise<unknown>;
  clearAllProviderCredentials?(): Promise<unknown>;
}

export type CloudFailureKind = 'not_configured' | 'auth' | 'unreachable' | 'empty' | 'needs_base_url';

export type CloudInventory =
  | { ok: true; models: ModelDescriptor[]; fetchedAt: number }
  | { ok: false; kind: CloudFailureKind; reason: string };

export type CloudConnectResult =
  | { ok: true; models: ModelDescriptor[]; baseUrl: string; freeCount: number }
  | { ok: false; reason: string };

export interface ProviderStatus {
  descriptor: ProviderDescriptor;
  connected: boolean;
  /** Connected providers that the user switched off for the pool. */
  enabled: boolean;
  baseUrl?: string;
  /** Known only after this session listed the provider's models; never guessed. */
  modelCount?: number;
  freeCount?: number;
  lastError?: { kind: CloudFailureKind; reason: string };
  quotaExhausted: boolean;
}

/** Transport seam: tests substitute a recording fake. Default is the shared OpenAI-compatible provider. */
export type CloudProviderFactory = (baseUrl: string, apiKey: string) => Pick<OpenAICompatibleProvider, 'listModelsRaw'>;

const INVENTORY_TTL_MS = 60_000;
const changeEmitter = new vscode.EventEmitter<void>();
/** Fires after any provider is connected, removed or re-enabled so Setup and pickers refresh without a restart. */
export const onDidChangeCloudProviders = changeEmitter.event;

const sharedCatalog = new ProviderCatalog();
export function sharedProviderCatalog(): ProviderCatalog { return sharedCatalog; }

const REMOTE_CATALOG_KEY = 'ollama-agent.providerCatalog.remote.v1';

/** Re-applies the last good remote catalog on startup so an offline start still sees refreshed metadata. */
export function hydrateProviderCatalog(memento: vscode.Memento, catalog: ProviderCatalog = sharedCatalog): boolean {
  try {
    const stored = memento.get<unknown>(REMOTE_CATALOG_KEY);
    return stored ? catalog.applyStoredRemote(stored) : false;
  } catch {
    return false;
  }
}

export interface CatalogRefreshSummary { ok: boolean; message: string; catalogVersion: string; added: string[]; updated: string[] }

/**
 * "Refresh free providers": fetches the versioned, schema-validated remote catalog (data only), merges it and stores the last
 * good copy. Any failure leaves the built-in/previous catalog untouched and says so; it never throws.
 */
export async function refreshProviderCatalogFromRemote(
  memento: vscode.Memento,
  options: Parameters<ProviderCatalog['refresh']>[0] = {},
  catalog: ProviderCatalog = sharedCatalog,
): Promise<CatalogRefreshSummary> {
  const result = await catalog.refresh(options);
  if (!result.ok) {
    return { ok: false, message: `${result.reason} Built-in providers are unaffected.`, catalogVersion: catalog.version, added: [], updated: [] };
  }
  try { await memento.update(REMOTE_CATALOG_KEY, result.remote); } catch { /* the in-memory catalog is still refreshed */ }
  changeEmitter.fire();
  const { added, updated, protectedConflicts } = result.report;
  const note = protectedConflicts.length ? ` ${protectedConflicts.length} credential-related field change(s) from the catalog were ignored.` : '';
  return { ok: true, message: `Provider catalog ${result.catalog.catalogVersion}: ${updated.length} updated, ${added.length} added.${note}`, catalogVersion: result.catalog.catalogVersion, added, updated };
}

const services = new WeakMap<vscode.SecretStorage, CloudProviderService>();

export function cloudProviderServiceFor(secrets: vscode.SecretStorage): CloudProviderService {
  let service = services.get(secrets);
  if (!service) {
    service = new CloudProviderService(secrets);
    services.set(secrets, service);
  }
  return service;
}

export class CloudProviderService {
  readonly credentials: CredentialStore;
  readonly models = new ModelCatalog();
  readonly quota = new QuotaTracker();
  private readonly fetchedAt = new Map<string, number>();
  private readonly lastError = new Map<string, { kind: CloudFailureKind; reason: string }>();

  constructor(
    secrets: vscode.SecretStorage,
    readonly catalog: ProviderCatalog = sharedCatalog,
    private readonly makeProvider: CloudProviderFactory = (baseUrl, apiKey) => new OpenAICompatibleProvider(baseUrl, apiKey),
    private readonly now: () => number = () => Date.now(),
    credentials?: CredentialStore,
  ) {
    this.credentials = credentials ?? new SecretStorageCredentialStore(secrets);
    this.secrets = secrets;
  }
  private readonly secrets: vscode.SecretStorage;

  /** Stored base URL + key for a provider, or undefined when it is not connected. Never touches the network. */
  async resolveConfig(providerId: string): Promise<{ baseUrl: string; apiKey: string } | undefined> {
    const descriptor = this.catalog.get(providerId);
    if (!descriptor) return undefined;
    const config = Config.getCloudProviderConfigs()[providerId];
    let apiKey = (await this.credentials.get(providerSecretKey(providerId)))?.trim();
    let baseUrl: string | undefined;
    if (providerId === 'orcarouter') {
      baseUrl = Config.getOrcaRouterApiBase() || descriptor.baseUrl;
      if (!apiKey) {
        // Legacy Setup wrote the fallback pair; honour it when it points at OrcaRouter (read-only, never rewritten).
        const legacyBase = Config.getCloudFallbackApiBase();
        const legacyKey = ((await this.secrets.get('ollama-agent.cloudFallbackApiKey')) ?? '').trim();
        if (legacyKey && legacyBase && /(^|\.)orcarouter\.ai$/i.test(safeHost(legacyBase))) { apiKey = legacyKey; baseUrl = legacyBase; }
      }
    } else {
      baseUrl = config?.baseUrl || resolveBaseUrl(descriptor.baseUrl, { accountId: config?.accountId ?? '' });
    }
    if (!apiKey || !baseUrl) return undefined;
    return { baseUrl, apiKey };
  }

  async isConnected(providerId: string): Promise<boolean> {
    return (await this.resolveConfig(providerId)) !== undefined;
  }

  /** Connected AND enabled for the pool. */
  async connectedProviderIds(): Promise<string[]> {
    const configs = Config.getCloudProviderConfigs();
    const out: string[] = [];
    for (const descriptor of this.catalog.list()) {
      if (configs[descriptor.id]?.enabled === false) continue;
      if (await this.isConnected(descriptor.id)) out.push(descriptor.id);
    }
    return out;
  }

  async statuses(): Promise<ProviderStatus[]> {
    const configs = Config.getCloudProviderConfigs();
    const result: ProviderStatus[] = [];
    for (const descriptor of this.catalog.list()) {
      const resolved = await this.resolveConfig(descriptor.id);
      const known = this.models.providerModels(descriptor.id);
      const hasInventory = this.fetchedAt.has(descriptor.id);
      result.push({
        descriptor,
        connected: resolved !== undefined,
        enabled: configs[descriptor.id]?.enabled !== false,
        baseUrl: resolved?.baseUrl,
        ...(hasInventory ? { modelCount: known.length, freeCount: known.filter(m => m.freeness === 'free').length } : {}),
        ...(this.lastError.has(descriptor.id) ? { lastError: this.lastError.get(descriptor.id) } : {}),
        quotaExhausted: this.quota.isExhausted(descriptor.id),
      });
    }
    return result;
  }

  private async fetchInventory(descriptor: ProviderDescriptor, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ModelDescriptor[]> {
    let body: unknown;
    try {
      body = await this.makeProvider(baseUrl.replace(/\/$/, ''), apiKey).listModelsRaw(signal);
    } catch (error) {
      if (error instanceof ProviderAuthError) {
        throw new CloudListError('auth', `${descriptor.displayName} rejected the API key. It may be wrong, expired or revoked.`);
      }
      throw new CloudListError('unreachable', `${descriptor.displayName}: ${redactSecrets(error instanceof Error ? error.message : String(error), [apiKey])}`);
    }
    try {
      return parseOpenAiCompatibleModels(descriptor, body);
    } catch (error) {
      throw new CloudListError('unreachable', `${descriptor.displayName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Live inventory for one connected provider, briefly cached. Failures are recorded, never thrown. */
  async listModels(providerId: string, options: { force?: boolean; signal?: AbortSignal } = {}): Promise<CloudInventory> {
    const descriptor = this.catalog.get(providerId);
    if (!descriptor) return { ok: false, kind: 'not_configured', reason: `Unknown provider "${providerId}".` };
    const resolved = await this.resolveConfig(providerId);
    if (!resolved) {
      const needsBase = descriptor.requiresBaseUrlInput && !Config.getCloudProviderConfigs()[providerId]?.accountId
        && !!(await this.credentials.get(providerSecretKey(providerId)));
      return needsBase
        ? { ok: false, kind: 'needs_base_url', reason: `${descriptor.displayName} needs its account id.` }
        : { ok: false, kind: 'not_configured', reason: `${descriptor.displayName} is not connected.` };
    }
    const at = this.fetchedAt.get(providerId);
    if (!options.force && at !== undefined && this.now() - at < INVENTORY_TTL_MS) {
      return { ok: true, models: [...this.models.providerModels(providerId)], fetchedAt: at };
    }
    try {
      const models = await this.fetchInventory(descriptor, resolved.baseUrl, resolved.apiKey, options.signal);
      if (models.length === 0) throw new CloudListError('empty', `${descriptor.displayName} accepted the credentials but returned no models.`);
      this.models.setInventory(providerId, models);
      this.fetchedAt.set(providerId, this.now());
      this.lastError.delete(providerId);
      return { ok: true, models, fetchedAt: this.now() };
    } catch (error) {
      this.fetchedAt.delete(providerId);
      this.models.removeProvider(providerId);
      const failure = error instanceof CloudListError ? error : new CloudListError('unreachable', `${descriptor.displayName}: ${redactSecrets(error instanceof Error ? error.message : String(error), [resolved.apiKey])}`);
      this.lastError.set(providerId, { kind: failure.kind, reason: failure.message });
      return { ok: false, kind: failure.kind, reason: failure.message };
    }
  }

  /** Inventory of every connected provider in parallel. A failing provider never hides the others. */
  async poolModels(options: { force?: boolean } = {}): Promise<{ models: ModelDescriptor[]; failures: Array<{ provider: string; kind: CloudFailureKind; reason: string }> }> {
    const ids = await this.connectedProviderIds();
    const results = await Promise.all(ids.map(async id => ({ id, inventory: await this.listModels(id, options) })));
    const models: ModelDescriptor[] = [];
    const failures: Array<{ provider: string; kind: CloudFailureKind; reason: string }> = [];
    for (const { id, inventory } of results) {
      if (inventory.ok) models.push(...inventory.models);
      else failures.push({ provider: id, kind: inventory.kind, reason: inventory.reason });
    }
    return { models, failures };
  }

  /**
   * Validates the key against the live model list first; credentials are stored only after that
   * succeeds, so a wrong key never leaves a provider looking connected.
   */
  async connect(
    providerId: string,
    input: { apiKey: string; baseUrl?: string; accountId?: string },
    core?: CloudCoreSink,
  ): Promise<CloudConnectResult> {
    const descriptor = this.catalog.get(providerId);
    if (!descriptor) return { ok: false, reason: `Unknown provider "${providerId}".` };
    const apiKey = input.apiKey.trim();
    if (!apiKey) return { ok: false, reason: `A ${descriptor.displayName} API key is required.` };
    if (/\s/.test(apiKey) || apiKey.length > 4096) return { ok: false, reason: 'That does not look like an API key (it contains whitespace). Paste only the key.' };
    let baseUrl: string | undefined;
    if (providerId === 'orcarouter' || input.baseUrl) {
      baseUrl = (input.baseUrl || Config.getOrcaRouterApiBase() || descriptor.baseUrl).trim().replace(/\/$/, '');
      if (!/^https?:\/\//i.test(baseUrl)) return { ok: false, reason: `The ${descriptor.displayName} base URL must start with http:// or https://.` };
    } else {
      baseUrl = resolveBaseUrl(descriptor.baseUrl, { accountId: input.accountId ?? '' });
      if (!baseUrl) return { ok: false, reason: `${descriptor.displayName} needs a valid account id before it can connect.` };
    }
    let models: ModelDescriptor[];
    try {
      models = await this.fetchInventory(descriptor, baseUrl, apiKey);
    } catch (error) {
      return { ok: false, reason: `${error instanceof Error ? redactSecrets(error.message, [apiKey]) : 'Connection failed.'} Nothing was saved.` };
    }
    if (models.length === 0) return { ok: false, reason: `${descriptor.displayName} accepted the credentials but returned no models. Nothing was saved.` };

    await this.credentials.set(providerSecretKey(providerId), apiKey);
    if (providerId === 'orcarouter') await Config.setOrcaRouterApiBase(baseUrl);
    await Config.setCloudProviderConfig(providerId, {
      enabled: true,
      accountId: input.accountId?.trim() || undefined,
      baseUrl: providerId === 'orcarouter' ? undefined : (input.baseUrl?.trim().replace(/\/$/, '') || undefined),
      selectedModel: Config.getCloudProviderConfigs()[providerId]?.selectedModel,
    });
    this.models.setInventory(providerId, models);
    this.fetchedAt.set(providerId, this.now());
    this.lastError.delete(providerId);
    this.quota.clear(providerId);
    if (core) await this.pushToCore(core, providerId);
    changeEmitter.fire();
    return { ok: true, models, baseUrl, freeCount: models.filter(m => m.freeness === 'free').length };
  }

  private forget(providerId: string): void {
    this.models.removeProvider(providerId);
    this.fetchedAt.delete(providerId);
    this.lastError.delete(providerId);
    this.quota.clear(providerId);
  }

  /** Removes the credential only. Non-secret preferences stay, the provider simply becomes disconnected. */
  async removeCredentials(providerId: string, core?: CloudCoreSink): Promise<void> {
    await this.credentials.delete(providerSecretKey(providerId));
    if (providerId === 'orcarouter') await this.secrets.delete(ORCAROUTER_LEGACY_SECRET_KEY);
    this.forget(providerId);
    if (core) await core.clearProviderCredential(providerId).catch(() => undefined);
    changeEmitter.fire();
  }

  /** Removes both the persisted config and the credential. */
  async removeProvider(providerId: string, core?: CloudCoreSink): Promise<void> {
    await this.removeCredentials(providerId, core);
    await Config.setCloudProviderConfig(providerId, undefined);
    changeEmitter.fire();
  }

  async removeAllCredentials(core?: CloudCoreSink): Promise<void> {
    for (const descriptor of this.catalog.list()) {
      await this.credentials.delete(providerSecretKey(descriptor.id));
      this.forget(descriptor.id);
    }
    await this.secrets.delete(ORCAROUTER_LEGACY_SECRET_KEY);
    await this.secrets.delete('ollama-agent.cloudFallbackApiKey');
    if (core) {
      if (core.clearAllProviderCredentials) await core.clearAllProviderCredentials().catch(() => undefined);
      else for (const descriptor of this.catalog.list()) await core.clearProviderCredential(descriptor.id).catch(() => undefined);
    }
    changeEmitter.fire();
  }

  async setEnabled(providerId: string, enabled: boolean, core?: CloudCoreSink): Promise<void> {
    const current = Config.getCloudProviderConfigs()[providerId] ?? {};
    await Config.setCloudProviderConfig(providerId, { ...current, enabled });
    if (core) {
      if (enabled) await this.pushToCore(core, providerId);
      else await core.clearProviderCredential(providerId).catch(() => undefined);
    }
    changeEmitter.fire();
  }

  /** Hydrates Core's in-memory store from SecretStorage for one provider. Never throws. */
  async pushToCore(core: CloudCoreSink, providerId: string): Promise<boolean> {
    try {
      const enabled = Config.getCloudProviderConfigs()[providerId]?.enabled !== false;
      const resolved = enabled ? await this.resolveConfig(providerId) : undefined;
      if (!resolved) {
        await core.clearProviderCredential(providerId);
        return false;
      }
      await core.setProviderCredential(providerId, resolved.baseUrl, resolved.apiKey);
      return true;
    } catch {
      return false;
    }
  }

  /** Startup/reconnect rehydration: every connected provider is ready without re-entering anything. */
  async pushAllToCore(core: CloudCoreSink): Promise<string[]> {
    const pushed: string[] = [];
    for (const descriptor of this.catalog.list()) {
      if (await this.pushToCore(core, descriptor.id)) pushed.push(descriptor.id);
    }
    return pushed;
  }
}

/** Maps Core's "<Provider label> quota or rate limit reached" failure back to the catalog provider id. */
export function providerIdFromQuotaFailure(catalog: ProviderCatalog, failureReason: string): string | undefined {
  const match = /^(.*) quota or rate limit reached/.exec(failureReason.trim());
  if (!match) return undefined;
  const label = match[1].trim();
  return catalog.list().find(provider => provider.displayName === label || provider.id === label)?.id;
}

class CloudListError extends Error {
  constructor(readonly kind: CloudFailureKind, message: string) { super(message); }
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}
