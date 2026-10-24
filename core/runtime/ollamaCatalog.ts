import { DEFAULT_OLLAMA_URL } from './modelBackend';

export interface InstalledModelsCatalog {
  models: string[];
  reachable: boolean;
  /** Provider-introspected context windows (tokens) for models that reported one. */
  contextWindows?: Record<string, number>;
}

export interface FetchOllamaCatalogOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Best-effort discovery only. Routing owns the meaning of an unavailable
 * catalog; transport details never escape this boundary.
 */
export async function fetchOllamaCatalog(
  options: FetchOllamaCatalogOptions = {},
): Promise<InstalledModelsCatalog> {
  const baseUrl = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    const response = await fetchFn(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) return { models: [], reachable: false };
    const body = await response.json() as { models?: unknown };
    if (!Array.isArray(body.models)) return { models: [], reachable: false };
    const models = body.models
      .map((entry) => (entry && typeof entry === 'object' ? (entry as { name?: unknown }).name : undefined))
      .filter((name): name is string => typeof name === 'string' && Boolean(name.trim()))
      .map((name) => name.trim());
    return { models: [...new Set(models)], reachable: true };
  } catch {
    return { models: [], reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

const contextLengthCache = new Map<string, number>();

/** Test seam: the per-process cache is otherwise for the process lifetime. */
export function clearOllamaContextLengthCache(): void {
  contextLengthCache.clear();
}

/**
 * The model's own context length from `POST /api/show`
 * (`model_info.<architecture>.context_length`). Best-effort: any failure, or a
 * model reporting nothing usable, yields `undefined` and is never cached, so a
 * transient outage does not pin a model to an assumed window.
 */
export async function getOllamaContextLength(
  model: string,
  options: FetchOllamaCatalogOptions = {},
): Promise<number | undefined> {
  const cached = contextLengthCache.get(model);
  if (cached !== undefined) return cached;
  const baseUrl = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetchFn(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { model_info?: unknown };
    const info = body.model_info;
    if (!info || typeof info !== 'object') return undefined;
    for (const [key, value] of Object.entries(info as Record<string, unknown>)) {
      if (key.endsWith('.context_length') && typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const length = Math.floor(value);
        contextLengthCache.set(model, length);
        return length;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

const capabilitiesCache = new Map<string, readonly string[]>();

/**
 * The provider-declared capability list from `POST /api/show` (e.g. ["completion","tools"]). Best-effort: any
 * failure yields `undefined` (= unknown, never a refusal) and is not cached.
 */
export async function getOllamaCapabilities(
  model: string,
  options: FetchOllamaCatalogOptions = {},
): Promise<readonly string[] | undefined> {
  const cached = capabilitiesCache.get(model);
  if (cached) return cached;
  const baseUrl = (options.baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? DEFAULT_OLLAMA_URL).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 3_000);
  try {
    const response = await fetchFn(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    const body = await response.json() as { capabilities?: unknown };
    const list = body.capabilities;
    if (!Array.isArray(list) || list.length === 0 || !list.every((item) => typeof item === 'string')) return undefined;
    capabilitiesCache.set(model, list as string[]);
    return list as string[];
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: the per-process cache is otherwise for the process lifetime. */
export function clearOllamaCapabilitiesCache(): void {
  capabilitiesCache.clear();
}

/** Adds introspected windows for the installed models among `models`. */
export async function withContextWindows(
  catalog: InstalledModelsCatalog,
  models: readonly string[],
  options: FetchOllamaCatalogOptions = {},
): Promise<InstalledModelsCatalog> {
  if (!catalog.reachable) return catalog;
  const installed = new Set(catalog.models);
  const wanted = models.filter((model) => installed.has(model));
  const lengths = await Promise.all(wanted.map(async (model) => [model, await getOllamaContextLength(model, options)] as const));
  const contextWindows: Record<string, number> = {};
  for (const [model, length] of lengths) if (length !== undefined) contextWindows[model] = length;
  return Object.keys(contextWindows).length > 0 ? { ...catalog, contextWindows } : catalog;
}
