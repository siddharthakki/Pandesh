import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DEFAULTS } from '../../../../src/config/Defaults';
import { OPENROUTER_API_KEY_ENV } from './openRouterCredential';
import { AUTO_CHAT_MODEL } from '../../../../core/domain/modelRouting';

/** Gate 1 code is preserved; cloud submission stays disabled until budget/product gate is ready. */
export const OPENROUTER_SUBMISSION_READY = false;
export const OPENROUTER_NOT_READY_MESSAGE =
  'OpenRouter cloud submission is not ready; use Ollama (local-only).';

export interface DesktopProviderConfig {
  providerType: 'ollama';
  apiBase: string;
  model: string;
  routingPolicy: 'local-only';
  source: string;
}

/** Fixed official OpenRouter API root for this slice. Not overridden by settings. */
export const OPENROUTER_OFFICIAL_API_BASE = 'https://openrouter.ai/api/v1';

export interface DesktopOpenRouterConfig {
  apiBase: typeof OPENROUTER_OFFICIAL_API_BASE;
  model: string | null;
  maxUsd: number | null;
  source: string;
}

export class DesktopConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesktopConfigError';
  }
}

interface SettingsLayer {
  source: string;
  values: Record<string, unknown>;
}

export function parseJsoncObject(raw: string): Record<string, unknown> {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  const parsed = JSON.parse(stripped) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DesktopConfigError('settings file must contain a JSON object');
  }
  return parsed as Record<string, unknown>;
}

export function readSettingsFile(filePath: string): SettingsLayer | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return { source: filePath, values: parseJsoncObject(raw) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof DesktopConfigError) throw err;
    throw new DesktopConfigError(`failed to read ${filePath}: ${(err as Error).message}`);
  }
}

function stringSetting(layers: SettingsLayer[], key: string): { value: string; source: string } | undefined {
  for (const layer of layers) {
    const value = layer.values[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return { value: value.trim(), source: layer.source };
    }
  }
  return undefined;
}

function numberSetting(layers: SettingsLayer[], key: string): { value: number; source: string } | undefined {
  for (const layer of layers) {
    const value = layer.values[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { value, source: layer.source };
    }
    if (typeof value === 'string' && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return { value: parsed, source: layer.source };
    }
  }
  return undefined;
}

function collectSettingsLayers(input: {
  selectedWorkspaceRoot?: string | null;
  productRoot: string;
  homedir: string;
  appdata?: string;
}): SettingsLayer[] {
  const layers: SettingsLayer[] = [];
  if (input.selectedWorkspaceRoot) {
    const workspace = readSettingsFile(path.join(input.selectedWorkspaceRoot, '.vscode', 'settings.json'));
    if (workspace) layers.push(workspace);
  }
  const product = readSettingsFile(path.join(input.productRoot, '.vscode', 'settings.json'));
  if (product && product.source !== layers[0]?.source) layers.push(product);
  for (const candidate of userSettingsCandidates(input.homedir, input.appdata)) {
    const layer = readSettingsFile(candidate);
    if (layer) layers.push(layer);
  }
  return layers;
}

function userSettingsCandidates(homedir: string, appdata: string | undefined): string[] {
  const roaming = appdata ?? path.join(homedir, 'AppData', 'Roaming');
  return [
    path.join(roaming, 'Cursor', 'User', 'settings.json'),
    path.join(roaming, 'Code', 'User', 'settings.json'),
  ];
}

/**
 * Resolves the local Ollama chat model to use. Jarvis Desktop's own model
 * picker (`selectedModelOverride`, backed by `selected-model.json` — see
 * `desktopModelSelection.ts`) is authoritative; `.vscode`/Cursor/VS Code
 * `ollama-agent.*` settings are consulted only once, by
 * `resolveLegacyModelForMigration` below, at first run. They are never read
 * here as an ongoing fallback — a workspace or editor settings change made
 * after that first run must never silently change Jarvis's model. Desktop
 * never enables cloud and never substitutes a different local model than the
 * one actually selected (explicit or Auto).
 */
export function resolveDesktopProviderConfig(input: {
  selectedWorkspaceRoot?: string | null;
  productRoot: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  appdata?: string;
  /** Operator pick from installed Ollama models, or `null`/omitted for Auto.
   * Always wins over everything else when set — this is Jarvis's own
   * persisted selection, never re-derived from editor settings. */
  selectedModelOverride?: string | null;
}): DesktopProviderConfig {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const explicit = env.KARKEDIKHA_DESKTOP_MODEL?.trim();
  const layers = collectSettingsLayers({
    selectedWorkspaceRoot: input.selectedWorkspaceRoot,
    productRoot: input.productRoot,
    homedir,
    appdata: input.appdata,
  });

  const providerType = stringSetting(layers, 'ollama-agent.providerType')?.value ?? DEFAULTS.providerType;
  if (providerType !== 'ollama') {
    throw new DesktopConfigError(`desktop slice requires local Ollama; configured provider is '${providerType}'`);
  }

  const apiBaseRaw = stringSetting(layers, 'ollama-agent.apiBase')?.value ?? DEFAULTS.apiBase;
  const apiBase = apiBaseRaw.replace(/\/$/, '');

  let model: string;
  let source: string;
  const override = input.selectedModelOverride?.trim();
  if (override) {
    model = override;
    source = 'operator-selection';
  } else if (explicit) {
    model = explicit;
    source = 'KARKEDIKHA_DESKTOP_MODEL';
  } else {
    // Auto (or, transiently, before the one-time migration in
    // desktopSession.ts has run): the same first preference Core's own Auto
    // chat routing uses (core/domain/modelRouting.ts `chainFor('chat')[0]`),
    // never a stale externally-configured value. Callers that need the
    // *actually installed* model for a real local call (Gmail summarization,
    // submission) resolve against the live Ollama catalog themselves rather
    // than trusting this synchronous best-effort label.
    model = AUTO_CHAT_MODEL;
    source = 'auto-default';
  }

  return {
    providerType: 'ollama',
    apiBase,
    model,
    routingPolicy: 'local-only',
    source,
  };
}

/**
 * One-time legacy-settings migration only — never called on the ongoing
 * resolution path. Looks at the same `.vscode`/Cursor/VS Code
 * `ollama-agent.chatModel`/`ollama-agent.model` settings the old fallback
 * used to read on every resolution, so a prior single-workspace setup isn't
 * silently discarded on first Jarvis Desktop run. The caller
 * (`desktopSession.ts`) is responsible for checking the returned model is
 * currently installed before adopting it, and for persisting the outcome
 * (migrated or not) to `selected-model.json` so this is consulted at most
 * once per Desktop profile.
 */
export function resolveLegacyModelForMigration(input: {
  selectedWorkspaceRoot?: string | null;
  productRoot: string;
  homedir?: string;
  appdata?: string;
}): { model: string; source: string } | null {
  const homedir = input.homedir ?? os.homedir();
  const layers = collectSettingsLayers({
    selectedWorkspaceRoot: input.selectedWorkspaceRoot,
    productRoot: input.productRoot,
    homedir,
    appdata: input.appdata,
  });
  const chat = stringSetting(layers, 'ollama-agent.chatModel');
  const generic = stringSetting(layers, 'ollama-agent.model');
  const chosen = chat ?? generic;
  if (!chosen) return null;
  return { model: chosen.value, source: `${chosen.source}:${chat ? 'chatModel' : 'model'}` };
}

/** Lists chat models installed in the local Ollama instance. */
export async function listInstalledOllamaModels(
  apiBase: string,
  fetchFn: typeof fetch = fetch,
): Promise<string[]> {
  let response: Response;
  try {
    response = await fetchFn(`${apiBase.replace(/\/$/, '')}/api/tags`);
  } catch (err) {
    throw new DesktopConfigError(`Ollama is unreachable at ${apiBase}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new DesktopConfigError(`Ollama /api/tags returned ${response.status}`);
  }
  const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
  const names = new Set<string>();
  for (const entry of body.models ?? []) {
    const name = (entry.name ?? entry.model ?? '').trim();
    if (name) names.add(name);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

export async function assertLocalModelInstalled(apiBase: string, model: string, fetchFn: typeof fetch = fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchFn(`${apiBase.replace(/\/$/, '')}/api/tags`);
  } catch (err) {
    throw new DesktopConfigError(`Ollama is unreachable at ${apiBase}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new DesktopConfigError(`Ollama /api/tags returned ${response.status}`);
  }
  const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
  const names = new Set(
    (body.models ?? []).flatMap((entry) => [entry.name, entry.model].filter((value): value is string => Boolean(value))),
  );
  const aliases = new Set([model, model.replace(/:latest$/, ''), `${model}:latest`]);
  for (const candidate of aliases) {
    if (names.has(candidate)) return;
    for (const installed of names) {
      if (installed === candidate || installed.startsWith(`${candidate}:`)) return;
    }
  }
  throw new DesktopConfigError(`configured local model '${model}' is not installed in Ollama; refusing to substitute`);
}

/** /v1 URL join for OpenRouter health probes. Gate 0 never calls this automatically. */
export function openRouterModelsUrl(apiBase: string = OPENROUTER_OFFICIAL_API_BASE): string {
  const base = apiBase.replace(/\/$/, '');
  return /\/v1$/i.test(base) ? `${base}/models` : `${base}/v1/models`;
}

/**
 * Resolves non-secret OpenRouter settings. Independent of cloud-fallback
 * keys/models. API base is the fixed official root for this slice.
 */
export function resolveOpenRouterConfig(input: {
  selectedWorkspaceRoot?: string | null;
  productRoot: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  appdata?: string;
}): DesktopOpenRouterConfig {
  const env = input.env ?? process.env;
  const homedir = input.homedir ?? os.homedir();
  const layers = collectSettingsLayers({
    selectedWorkspaceRoot: input.selectedWorkspaceRoot,
    productRoot: input.productRoot,
    homedir,
    appdata: input.appdata,
  });
  const model = env.KARKEDIKHA_OPENROUTER_MODEL?.trim()
    || stringSetting(layers, 'ollama-agent.openRouterModel')?.value
    || null;
  const maxUsdEnv = env.KARKEDIKHA_OPENROUTER_MAX_USD?.trim();
  const maxUsd = maxUsdEnv && Number.isFinite(Number(maxUsdEnv))
    ? Number(maxUsdEnv)
    : numberSetting(layers, 'ollama-agent.openRouterMaxUsd')?.value ?? null;
  return {
    apiBase: OPENROUTER_OFFICIAL_API_BASE,
    model,
    maxUsd,
    source: model ? 'openRouterModel' : 'unset',
  };
}

/** Fail-closed check used when OpenRouter is later selected (Gate 1). */
export function requireOpenRouterSelection(config: DesktopOpenRouterConfig, hasApiKey: boolean): {
  apiBase: typeof OPENROUTER_OFFICIAL_API_BASE;
  model: string;
  maxUsd: number;
} {
  if (!config.model) {
    throw new DesktopConfigError('OpenRouter model is required when selected; refusing to substitute');
  }
  if (config.maxUsd === null || !Number.isFinite(config.maxUsd) || config.maxUsd <= 0) {
    throw new DesktopConfigError('OpenRouter USD spend cap must be a positive finite number; refusing the call');
  }
  if (!hasApiKey) {
    throw new DesktopConfigError('OpenRouter API key is not stored on the host; refusing the call');
  }
  return { apiBase: OPENROUTER_OFFICIAL_API_BASE, model: config.model, maxUsd: config.maxUsd };
}

/**
 * Health-check only: GET /models. Gate 0 never runs this automatically and never
 * generates. Tests inject a fake fetch.
 */
export async function probeOpenRouterModels(
  apiKey: string | null,
  fetchFn: typeof fetch = fetch,
  apiBase: string = OPENROUTER_OFFICIAL_API_BASE,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetchFn(openRouterModelsUrl(apiBase), { headers });
  } catch (err) {
    throw new DesktopConfigError(`OpenRouter is unreachable at ${apiBase}: ${(err as Error).message}`);
  }
  if (!response.ok) {
    throw new DesktopConfigError(`OpenRouter /models returned ${response.status}`);
  }
}

/** Host-only Core env. Never log returned object. */
export function buildDesktopCoreExtraEnv(input: {
  ollamaModel: string;
  ollamaApiBase: string;
  hostBrowserBin?: string;
  openRouterModel: string | null;
  openRouterMaxUsd: number | null;
  openRouterApiKey: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    KARKEDIKHA_DEFAULT_MODEL: input.ollamaModel,
    KARKEDIKHA_OLLAMA_URL: input.ollamaApiBase,
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    KARKEDIKHA_OPENROUTER_MODEL: input.openRouterModel ?? '',
  };
  if (input.hostBrowserBin) env.KARKEDIKHA_BROWSER_BIN = input.hostBrowserBin;
  if (input.openRouterMaxUsd !== null) env.KARKEDIKHA_OPENROUTER_MAX_USD = String(input.openRouterMaxUsd);
  if (input.openRouterApiKey) env[OPENROUTER_API_KEY_ENV] = input.openRouterApiKey;
  return env;
}
