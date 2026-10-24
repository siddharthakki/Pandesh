/**
 * Ollama cold-start vocabulary and budgeting.
 *
 * A large local model that is not resident has to be read from disk into memory before the first token can be
 * produced. That can take minutes, during which the server is healthy and *no bytes flow*. A single flat request
 * timeout cannot tell that apart from a genuine hang: set it long enough for a cold 27B load and every real stall
 * waits just as long; leave it short and a perfectly healthy cold start is reported as a failure.
 *
 * The distinction is evidence, not guesswork: Ollama's `/api/ps` lists the models currently resident. So the
 * budget is
 *
 *     resident (or unknown)  ->  the normal request timeout, unchanged
 *     known NOT resident     ->  normal request timeout + one bounded startup allowance
 *
 * The allowance is added once, only with that evidence, and only for Ollama (other providers have no residency
 * signal and keep their timeouts). After the load, the normal generation timeout governs and stall detection is
 * untouched. Nothing here raises any timeout globally.
 */

/** Where a request is in its life. Only `model_loading` and `first_token_wait` are knowable before bytes arrive. */
export type OllamaRequestPhase = 'model_loading' | 'first_token_wait' | 'active_generation' | 'stall';

export const COLD_START_ALLOWANCE_DEFAULT_MS = 300_000;
/** The allowance can be tuned or disabled (0), but never made unbounded. */
export const COLD_START_ALLOWANCE_MAX_MS = 1_800_000;
/** How long the residency lookup may take. It must never become the thing that delays a request. */
export const RESIDENCY_LOOKUP_TIMEOUT_MS = 1_500;

/** `KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS`: 0 disables, a positive integer overrides, anything else is the default. */
export function coldStartAllowanceMs(env: Record<string, string | undefined> = process.env): number {
  const raw = (env.KARKEDIKHA_OLLAMA_COLD_START_ALLOWANCE_MS ?? '').trim();
  if (!/^\d+$/.test(raw)) return COLD_START_ALLOWANCE_DEFAULT_MS;
  return Math.min(Number(raw), COLD_START_ALLOWANCE_MAX_MS);
}

function sameModel(listed: string, wanted: string): boolean {
  if (listed === wanted) return true;
  // Ollama resolves an untagged reference to `:latest`.
  return listed === `${wanted}:latest` || `${listed}` === wanted.replace(/:latest$/, '');
}

/**
 * Whether `model` appears in an Ollama `/api/ps` body. `undefined` means the body was not understood: unknown is
 * never treated as cold, because granting an allowance on a guess would just be a longer timeout in disguise.
 */
export function modelIsResident(psBody: unknown, model: string): boolean | undefined {
  if (!psBody || typeof psBody !== 'object') return undefined;
  const models = (psBody as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  return models.some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as { name?: unknown; model?: unknown };
    return [record.name, record.model].some(value => typeof value === 'string' && sameModel(value, model));
  });
}

/**
 * A model that just answered a request is resident, and Ollama keeps it loaded for its keep-alive (5 minutes by
 * default). So after a successful request the residency lookup is skipped for a window shorter than that: the common
 * warm path makes no extra request at all, and only a first request after an idle period asks.
 */
export const RESIDENCY_CACHE_TTL_MS = 4 * 60 * 1000;

const residentUntil = new Map<string, number>();

export function noteModelResident(endpoint: string, model: string, now: number = Date.now()): void {
  residentUntil.set(`${endpoint}|${model}`, now + RESIDENCY_CACHE_TTL_MS);
}

export function knownResident(endpoint: string, model: string, now: number = Date.now()): boolean {
  const until = residentUntil.get(`${endpoint}|${model}`);
  return until !== undefined && until > now;
}

/** Test seam: forget remembered residency. */
export function clearResidencyCache(): void {
  residentUntil.clear();
}

export interface RequestBudget {
  /** The overall deadline for this request. */
  timeoutMs: number;
  /** True when a startup allowance was added because the model was known not to be resident. */
  coldStart: boolean;
  allowanceMs: number;
  /** One clause for a timeout message, or '' when nothing special applied. */
  note: string;
}

export function budgetForRequest(baseTimeoutMs: number, resident: boolean | undefined, allowanceMs: number = coldStartAllowanceMs()): RequestBudget {
  if (resident !== false || allowanceMs <= 0) {
    return { timeoutMs: baseTimeoutMs, coldStart: false, allowanceMs: 0, note: '' };
  }
  return {
    timeoutMs: baseTimeoutMs + allowanceMs,
    coldStart: true,
    allowanceMs,
    note: `the model was not loaded when the request started, so a ${Math.round(allowanceMs / 1000)}s startup allowance was added to the ${Math.round(baseTimeoutMs / 1000)}s request timeout`,
  };
}

/**
 * Names the phase a request is in from what has been observed. A streaming caller that sees bytes can distinguish
 * active generation from a stall; a non-streaming call only ever knows loading vs waiting.
 */
export function classifyOllamaPhase(input: {
  resident: boolean | undefined;
  bytesReceived: boolean;
  /** Milliseconds since the last byte (or since the request started when none has arrived). */
  idleMs: number;
  /** Silence longer than this, once generation has started, is a stall. */
  stallAfterMs: number;
}): OllamaRequestPhase {
  if (input.bytesReceived) return input.idleMs > input.stallAfterMs ? 'stall' : 'active_generation';
  return input.resident === false ? 'model_loading' : 'first_token_wait';
}

/** Names of the models in an Ollama `/api/ps` body; `undefined` when the body was not understood. */
export function residentModelNames(psBody: unknown): string[] | undefined {
  if (!psBody || typeof psBody !== 'object') return undefined;
  const models = (psBody as { models?: unknown }).models;
  if (!Array.isArray(models)) return undefined;
  return models.flatMap(entry => {
    if (!entry || typeof entry !== 'object') return [];
    const { name, model } = entry as { name?: unknown; model?: unknown };
    return [name, model].filter((value): value is string => typeof value === 'string' && value.length > 0);
  });
}
