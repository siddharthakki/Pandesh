/**
 * OrcaRouter as a manually selectable cloud provider.
 *
 * OrcaRouter speaks the OpenAI-compatible protocol, so discovery here reuses
 * OpenAICompatibleProvider and execution reuses Core's OpenAICompatibleModelBackend.
 * The extension host owns the credential (SecretStorage) and the non-secret
 * base URL (settings); Core receives the key over its authenticated local API and
 * keeps it in memory only (see core/runtime/cloudCredentials.ts).
 *
 * Nothing here participates in Auto routing: an OrcaRouter model is reachable
 * only when the user picks that exact model.
 */
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { OpenAICompatibleProvider } from './OpenAICompatibleProvider';
import type { ModelInfo } from './ProviderTypes';

export const ORCAROUTER_PROVIDER_ID = 'orcarouter';
/** SecretStorage key. Distinct from the primary-provider and cloud-fallback keys. */
export const ORCAROUTER_SECRET_KEY = 'ollama-agent.orcaRouterApiKey';
/** Picker/override value prefix: `orcarouter::<exact model id>`. Cannot collide with an Ollama tag. */
export const ORCAROUTER_MODEL_PREFIX = 'orcarouter::';
export const ORCAROUTER_LABEL = 'OrcaRouter';
/** Legacy Setup wrote the cloud fallback pair; it is read (never rewritten) when it points at OrcaRouter. */
const LEGACY_FALLBACK_SECRET_KEY = 'ollama-agent.cloudFallbackApiKey';
const INVENTORY_TTL_MS = 60_000;

export function encodeOrcaRouterModel(modelId: string): string {
  return `${ORCAROUTER_MODEL_PREFIX}${modelId}`;
}

/** The exact OrcaRouter model id when `value` is an OrcaRouter picker value; otherwise undefined. */
export function decodeOrcaRouterModel(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith(ORCAROUTER_MODEL_PREFIX)) return undefined;
  const id = trimmed.slice(ORCAROUTER_MODEL_PREFIX.length).trim();
  return id || undefined;
}

export interface OrcaRouterConfig {
  apiBase: string;
  apiKey: string;
  source: 'orcarouter' | 'legacy-cloud-fallback';
}

export type OrcaRouterInventory =
  | { ok: true; models: ModelInfo[] }
  | { ok: false; reason: string; kind: 'not_configured' | 'auth' | 'unreachable' | 'empty' };

export type OrcaRouterConnectResult =
  | { ok: true; models: ModelInfo[]; apiBase: string }
  | { ok: false; reason: string };

/** The slice of CoreClient the service needs; lets tests supply a recording fake. */
export interface OrcaRouterCoreSink {
  setOrcaRouterCredential(baseUrl: string, apiKey: string): Promise<unknown>;
  clearOrcaRouterCredential(): Promise<unknown>;
}

export type OrcaRouterProviderFactory = (apiBase: string, apiKey: string) => Pick<OpenAICompatibleProvider, 'listModels'>;

const changeEmitter = new vscode.EventEmitter<void>();
/** Fires after credentials are saved or removed so pickers and Setup refresh without a restart. */
export const onDidChangeOrcaRouter = changeEmitter.event;

function isOrcaRouterHost(apiBase: string): boolean {
  try {
    const host = new URL(apiBase).hostname.toLowerCase();
    return host === 'orcarouter.ai' || host.endsWith('.orcarouter.ai');
  } catch {
    return false;
  }
}

/** Short, key-free description of a failure suitable for UI and logs. */
function describeFailure(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  return apiKey ? raw.split(apiKey).join('[redacted]') : raw;
}

const sharedServices = new WeakMap<vscode.SecretStorage, OrcaRouterService>();

/** One service (and one inventory cache) per SecretStorage, shared by Setup, the picker and dispatch. */
export function orcaRouterServiceFor(secrets: vscode.SecretStorage): OrcaRouterService {
  let service = sharedServices.get(secrets);
  if (!service) {
    service = new OrcaRouterService(secrets);
    sharedServices.set(secrets, service);
  }
  return service;
}

export class OrcaRouterService {
  private inventory?: { at: number; apiBase: string; models: ModelInfo[] };

  constructor(
    private readonly secrets: vscode.SecretStorage,
    private readonly makeProvider: OrcaRouterProviderFactory = (apiBase, apiKey) => new OpenAICompatibleProvider(apiBase, apiKey),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Stored configuration, or undefined when OrcaRouter is not set up. Never contacts the network. */
  async resolveConfig(): Promise<OrcaRouterConfig | undefined> {
    const own = ((await this.secrets.get(ORCAROUTER_SECRET_KEY)) ?? '').trim();
    if (own) {
      const apiBase = Config.getOrcaRouterApiBase();
      if (apiBase) return { apiBase, apiKey: own, source: 'orcarouter' };
    }
    const legacyBase = Config.getCloudFallbackApiBase();
    if (legacyBase && isOrcaRouterHost(legacyBase)) {
      const legacyKey = ((await this.secrets.get(LEGACY_FALLBACK_SECRET_KEY)) ?? '').trim();
      if (legacyKey) return { apiBase: legacyBase, apiKey: legacyKey, source: 'legacy-cloud-fallback' };
    }
    return undefined;
  }

  /**
   * Live model inventory for the configured account, cached briefly so the picker and the
   * per-turn exact-model check do not each hit the network.
   */
  async listModels(options: { force?: boolean; signal?: AbortSignal } = {}): Promise<OrcaRouterInventory> {
    const config = await this.resolveConfig();
    if (!config) return { ok: false, kind: 'not_configured', reason: 'OrcaRouter is not set up. Run "KarkeDikha: Set Up OrcaRouter (Cloud Models)".' };
    const cached = this.inventory;
    if (!options.force && cached && cached.apiBase === config.apiBase && this.now() - cached.at < INVENTORY_TTL_MS) {
      return { ok: true, models: cached.models };
    }
    try {
      const models = await this.makeProvider(config.apiBase, config.apiKey).listModels(options.signal);
      if (models.length === 0) {
        return { ok: false, kind: 'empty', reason: 'OrcaRouter accepted the credentials but returned no models.' };
      }
      this.inventory = { at: this.now(), apiBase: config.apiBase, models };
      return { ok: true, models };
    } catch (error) {
      this.inventory = undefined;
      const message = describeFailure(error, config.apiKey);
      const kind = /authentication failed|HTTP 40[13]/i.test(message) ? 'auth' : 'unreachable';
      return { ok: false, kind, reason: `OrcaRouter at ${config.apiBase}: ${message}` };
    }
  }

  /**
   * Validates a base URL and key against the live model list. Credentials are stored only after
   * that succeeds, so a wrong key or URL never leaves OrcaRouter looking ready.
   */
  async connect(input: { apiBase: string; apiKey: string }, core?: OrcaRouterCoreSink): Promise<OrcaRouterConnectResult> {
    const apiBase = input.apiBase.trim().replace(/\/$/, '');
    const apiKey = input.apiKey.trim();
    if (!/^https?:\/\//i.test(apiBase)) return { ok: false, reason: 'The OrcaRouter base URL must start with http:// or https://.' };
    if (!apiKey) return { ok: false, reason: 'An OrcaRouter API key is required.' };
    let models: ModelInfo[];
    try {
      models = await this.makeProvider(apiBase, apiKey).listModels();
    } catch (error) {
      return { ok: false, reason: `OrcaRouter rejected the setup: ${describeFailure(error, apiKey)}` };
    }
    if (models.length === 0) return { ok: false, reason: 'OrcaRouter accepted the credentials but returned no models.' };

    await this.secrets.store(ORCAROUTER_SECRET_KEY, apiKey);
    await Config.setOrcaRouterApiBase(apiBase);
    this.inventory = { at: this.now(), apiBase, models };
    if (core) await this.pushToCore(core);
    changeEmitter.fire();
    return { ok: true, models, apiBase };
  }

  async disconnect(core?: OrcaRouterCoreSink): Promise<void> {
    await this.secrets.delete(ORCAROUTER_SECRET_KEY);
    this.inventory = undefined;
    if (core) await core.clearOrcaRouterCredential().catch(() => undefined);
    changeEmitter.fire();
  }

  /** Delivers the stored credential to Core (or clears Core's copy when none is stored). Never throws. */
  async pushToCore(core: OrcaRouterCoreSink): Promise<boolean> {
    try {
      const config = await this.resolveConfig();
      if (!config) {
        await core.clearOrcaRouterCredential();
        return false;
      }
      await core.setOrcaRouterCredential(config.apiBase, config.apiKey);
      return true;
    } catch {
      return false;
    }
  }
}
