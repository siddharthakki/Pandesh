/**
 * Model residency for KKD-managed Ollama requests.
 *
 * Ollama unloads an idle model after its keep-alive (server default 5 minutes) and every cold start costs a full
 * model load. KKD sends an explicit `keep_alive` instead of relying on the machine-wide OLLAMA_KEEP_ALIVE.
 * The OpenAI-compatible /v1 endpoint used by Pi/OpenCode cannot be relied on to carry it, so those engines call
 * `ensureModelResident` (native /api/generate, no prompt = load only) before a run.
 *
 * Never sends `keep_alive: 0`; Image Studio's deliberate unload lives in imageStudioCapability.ts.
 * Eviction is left to Ollama's scheduler: when another model needs the VRAM it unloads an idle resident one.
 */

export const DEFAULT_KKD_KEEP_ALIVE = '30m';
const KEEP_ALIVE_ENV = 'KARKEDIKHA_OLLAMA_KEEP_ALIVE';

/** Duration strings Ollama accepts ("30m", "2h", "90s") or a positive number of seconds; zero/negative are rejected (0 = unload now). */
export function resolveKeepAlive(raw: string | undefined = process.env[KEEP_ALIVE_ENV]): string {
  const value = (raw ?? '').trim();
  if (/^\d+(\.\d+)?(ms|s|m|h)$/.test(value) && parseFloat(value) > 0) return value;
  if (/^\d+$/.test(value) && Number(value) > 0) return `${value}s`;
  return DEFAULT_KKD_KEEP_ALIVE;
}

function ollamaBase(baseUrl?: string): string {
  return (baseUrl ?? process.env.KARKEDIKHA_OLLAMA_URL ?? 'http://127.0.0.1:11434').replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

export interface ResidencyResult {
  ok: boolean;
  model: string;
  durationMs: number;
  error?: string;
}

/**
 * Loads `model` (if not already loaded) and pins it for the KKD keep-alive. Best-effort and bounded: a failure
 * never blocks the run, the engine's own request would simply pay the cold start.
 */
export async function ensureModelResident(model: string, options: { baseUrl?: string; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ResidencyResult> {
  const startedAt = Date.now();
  if (!model) return { ok: false, model, durationMs: 0, error: 'no model' };
  if (options.signal?.aborted) return { ok: false, model, durationMs: 0, error: 'aborted' };
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  try {
    const res = await fetch(`${ollamaBase(options.baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: resolveKeepAlive() }),
      signal,
    });
    if (!res.ok) return { ok: false, model, durationMs: Date.now() - startedAt, error: `HTTP ${res.status}` };
    await res.arrayBuffer();
    return { ok: true, model, durationMs: Date.now() - startedAt };
  } catch (err) {
    return { ok: false, model, durationMs: Date.now() - startedAt, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Context window (num_ctx) the model is currently loaded with, or undefined when it is not loaded / Ollama cannot say.
 * Ollama reloads the runner (~15-18 s for a 27B model, measured) whenever a request's num_ctx differs from the loaded
 * one, so a request that already fits should reuse the loaded value instead of picking its own bucket.
 */
export async function loadedContextLength(model: string, options: { baseUrl?: string; signal?: AbortSignal } = {}): Promise<number | undefined> {
  try {
    const timeout = AbortSignal.timeout(1_500);
    const res = await fetch(`${ollamaBase(options.baseUrl)}/api/ps`, { signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout });
    if (!res.ok) return undefined;
    const body = await res.json() as { models?: Array<{ name?: string; model?: string; context_length?: number }> };
    const loaded = body.models?.find((m) => m.name === model || m.model === model);
    return typeof loaded?.context_length === 'number' && loaded.context_length > 0 ? loaded.context_length : undefined;
  } catch {
    return undefined;
  }
}

/** Reuse the loaded window when it already covers the request; otherwise keep the request's own sizing (a genuine grow). */
export function adoptLoadedContext(requested: number | undefined, assumedDefault: number, loaded: number | undefined, maxContextTokens?: number): number | undefined {
  if (loaded == null) return requested;
  if (maxContextTokens != null && loaded > maxContextTokens) return requested;
  return loaded >= (requested ?? assumedDefault) ? loaded : requested;
}
