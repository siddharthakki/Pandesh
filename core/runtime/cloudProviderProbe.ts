/**
 * Model discovery and connection tests for catalog cloud providers.
 *
 * Discovery reads a provider's public model list with the operator's key and classifies every
 * model with the catalog's freeness rules. Only `free`, generative models form the free pool;
 * everything else is counted by reason and never offered. The connection test sends one fixed
 * public prompt (never user data) to a model that is already in the free pool.
 */
import { isPrivateEndpoint, type ProviderDescriptor } from '../platform/providerCatalog';
import { parseOpenAiCompatibleModels, type ModelDescriptor } from '../platform/modelCatalog';
import { redactSecrets } from '../platform/credentialStore';
import type { CloudProviderCredential } from './cloudCredentials';

export const CLOUD_PROBE_PROMPT = 'Reply with the single word OK.';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Audio, speech, moderation and image models are listed by providers but are not chat models. */
const NON_CHAT_MODEL = /whisper|\btts\b|speech|transcri|moderat|guard|orpheus|dall-?e|image|stable-diffusion|flux/i;

export type CloudErrorClass = 'auth' | 'rate_limited' | 'model_unavailable' | 'bad_request' | 'provider_error' | 'timeout' | 'unreachable' | 'malformed_response';

export interface CloudRateLimit {
  limitRequests?: string;
  remainingRequests?: string;
  resetRequests?: string;
  retryAfter?: string;
}

export interface CloudModelListing {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  httpStatus: number | null;
  errorClass?: CloudErrorClass;
  error?: string;
  /** Free, generative models the operator may choose. */
  pool: Array<{ id: string; displayName: string; contextWindow?: number; vision: boolean | 'unknown'; tools: boolean | 'unknown' }>;
  /** Count of models that were listed but not offered, by reason. */
  excluded: Record<'paid' | 'unknown' | 'promotional' | 'trial' | 'nonGenerative', number>;
}

export interface CloudConnectionTest {
  ok: boolean;
  model: string;
  checkedAt: string;
  latencyMs: number;
  httpStatus: number | null;
  errorClass?: CloudErrorClass;
  error?: string;
  rateLimit: CloudRateLimit;
  replyPreview?: string;
}

type FetchFn = typeof fetch;

interface ProbeOptions {
  fetchFn?: FetchFn;
  timeoutMs?: number;
  now?: () => Date;
}

function classifyStatus(status: number): CloudErrorClass {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'model_unavailable';
  if (status >= 500) return 'provider_error';
  return 'bad_request';
}

function rateLimitFrom(headers: Headers): CloudRateLimit {
  const pick = (name: string) => headers.get(name) ?? undefined;
  return {
    limitRequests: pick('x-ratelimit-limit-requests'),
    remainingRequests: pick('x-ratelimit-remaining-requests'),
    resetRequests: pick('x-ratelimit-reset-requests'),
    retryAfter: pick('retry-after'),
  };
}

function failureText(status: number, body: string, credential: CloudProviderCredential): string {
  const detail = body.replace(/\s+/g, ' ').slice(0, 200);
  return redactSecrets(`HTTP ${status}${detail ? `: ${detail}` : ''}`, [credential.apiKey]);
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

function networkFailure(error: unknown, credential: CloudProviderCredential): { errorClass: CloudErrorClass; error: string } {
  const name = (error as { name?: string } | null)?.name;
  const message = redactSecrets(error instanceof Error ? error.message : String(error), [credential.apiKey]);
  return name === 'AbortError'
    ? { errorClass: 'timeout', error: 'The provider did not answer in time.' }
    : { errorClass: 'unreachable', error: `The provider could not be reached (${message}).` };
}

export const SELF_HOSTED_PUBLIC_REFUSAL =
  'A self-hosted endpoint must be on this PC or your own network (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x or *.local). '
  + 'Pandesh cannot verify what a public address costs, so it is not used.';

/** Lists the provider's models and keeps only the free, generative ones. Never throws. */
export async function listCloudModels(
  descriptor: ProviderDescriptor,
  credential: CloudProviderCredential,
  options: ProbeOptions = {},
): Promise<CloudModelListing> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const excluded: CloudModelListing['excluded'] = { paid: 0, unknown: 0, promotional: 0, trial: 0, nonGenerative: 0 };
  const base = { checkedAt: now().toISOString(), excluded };
  if (descriptor.modelRules?.freeness?.kind === 'self-hosted' && !isPrivateEndpoint(credential.baseUrl)) {
    return { ...base, ok: false, latencyMs: 0, httpStatus: null, errorClass: 'bad_request', error: SELF_HOSTED_PUBLIC_REFUSAL, pool: [] };
  }
  try {
    const response = await withTimeout(
      (signal) => fetchFn(`${credential.baseUrl}/models`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${credential.apiKey}`, Accept: 'application/json' },
        signal,
      }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: classifyStatus(response.status), error: failureText(response.status, body, credential), pool: [] };
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch {
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: 'malformed_response', error: 'The model list was not valid JSON.', pool: [] };
    }
    let models: ModelDescriptor[];
    try {
      models = parseOpenAiCompatibleModels(descriptor, parsed);
    } catch {
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: 'malformed_response', error: 'The model list did not have the expected shape.', pool: [] };
    }
    const pool: CloudModelListing['pool'] = [];
    for (const model of models) {
      if (model.kind !== 'generative' || NON_CHAT_MODEL.test(model.modelId)) { excluded.nonGenerative += 1; continue; }
      if (model.freeness === 'free') {
        pool.push({ id: model.modelId, displayName: model.displayName, contextWindow: model.contextWindow, vision: model.vision, tools: model.tools });
        continue;
      }
      excluded[model.freeness === 'paid' ? 'paid' : model.freeness === 'promotional' ? 'promotional' : model.freeness === 'trial' ? 'trial' : 'unknown'] += 1;
    }
    return { ...base, ok: true, latencyMs, httpStatus: response.status, pool };
  } catch (error) {
    return { ...base, ok: false, latencyMs: Date.now() - started, httpStatus: null, ...networkFailure(error, credential), pool: [] };
  }
}

/** One fixed public prompt to a model already in the free pool. Records latency and provider limits. */
export async function testCloudConnection(
  credential: CloudProviderCredential,
  model: string,
  options: ProbeOptions = {},
): Promise<CloudConnectionTest> {
  const fetchFn = options.fetchFn ?? fetch;
  const now = options.now ?? (() => new Date());
  const started = Date.now();
  const base = { model, checkedAt: now().toISOString() };
  try {
    const response = await withTimeout(
      (signal) => fetchFn(`${credential.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${credential.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: CLOUD_PROBE_PROMPT }],
          max_tokens: 8,
          stream: false,
        }),
        signal,
      }),
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const latencyMs = Date.now() - started;
    const rateLimit = rateLimitFrom(response.headers);
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: classifyStatus(response.status), error: failureText(response.status, body, credential), rateLimit };
    }
    let reply = '';
    try {
      const parsed = await response.json() as { choices?: Array<{ message?: { content?: unknown } }> };
      const content = parsed.choices?.[0]?.message?.content;
      reply = typeof content === 'string' ? content : '';
    } catch {
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: 'malformed_response', error: 'The reply was not valid JSON.', rateLimit };
    }
    if (!reply.trim()) {
      return { ...base, ok: false, latencyMs, httpStatus: response.status, errorClass: 'malformed_response', error: 'The provider returned an empty reply.', rateLimit };
    }
    return { ...base, ok: true, latencyMs, httpStatus: response.status, rateLimit, replyPreview: redactSecrets(reply.trim().slice(0, 60), [credential.apiKey]) };
  } catch (error) {
    return { ...base, ok: false, latencyMs: Date.now() - started, httpStatus: null, ...networkFailure(error, credential), rateLimit: {} };
  }
}
