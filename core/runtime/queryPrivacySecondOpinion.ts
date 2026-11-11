/**
 * An optional second opinion on a web search query before it leaves the PC, from local Ollaya decision models
 * (docs/evals/ollaya-decisions.md). It runs next to the existing guard (`checkPublicQuery`), never instead of it:
 *
 *  - a query the guard lets through but a model thinks may carry private information goes to the person as a card
 *    ("This search may contain private information"); nothing is sent unless they approve it;
 *  - it never sends, approves or unblocks anything, and never relaxes the guard;
 *  - off unless the owner turns it on, loopback only, and any failure gives no opinion (behaviour unchanged);
 *  - what it records is redacted: models, numbers, verdict and timing, never the query.
 *
 * The measured setup asks two models in parallel: `decider:2b` what kind of information the query holds (flag when
 * 1 − P(public) ≥ 0.70) and `decider:0.8b` whether it names a person together with a private matter (flag at ≥ 0.60).
 * Each alone either missed the name-plus-diagnosis case or flagged a quarter of the owner's real, public queries.
 */
import { createHash } from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { getMetadata, setMetadata } from '../db/metadata';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { CoreError } from '../domain/errors';
import { isLoopbackEndpoint } from './commandSecondOpinion';

export interface QueryPrivacySettings {
  enabled: boolean;
  endpoint: string;
  kindModel: string;
  /** Flag when 1 − P(the query holds only public information) reaches this. */
  kindThreshold: number;
  detailModel: string;
  /** Flag when P(it names a person together with a private matter) reaches this. */
  detailThreshold: number;
  timeoutMs: number;
  source: 'default' | 'setting' | 'environment';
}

export const QUERY_PRIVACY_DEFAULTS = {
  endpoint: 'http://127.0.0.1:11435',
  kindModel: 'decider:2b',
  kindThreshold: 0.7,
  detailModel: 'decider:0.8b',
  detailThreshold: 0.6,
  timeoutMs: 3_000,
} as const;
const SETTINGS_KEY = 'integrations.ollaya.queryPrivacy';
const MAX_QUERY_CHARS = 600;

/** The measured wording (docs/evals/ollaya-decisions.md, v3 and v8). Changing it means measuring again. */
const KIND_QUESTION = {
  kind: {
    type: 'choice',
    instructions: 'What kind of information does `query` contain?',
    criteria: {
      public: 'only general knowledge, public products, public companies or public figures',
      personal: 'the name, contact details, address, health, money or private life of a private person',
      confidential: 'internal business details, customers, suppliers, prices, file paths, passwords or keys',
    },
  },
} as const;
const DETAIL_QUESTION = {
  person_detail: { type: 'noul', instructions: 'Does `query` mention a named person together with their health, money, family, address or other private matters?' },
} as const;

interface StoredSettings { enabled?: boolean; kindModel?: string; kindThreshold?: number; detailModel?: string; detailThreshold?: number }
const validThreshold = (x: unknown): x is number => typeof x === 'number' && x >= 0.05 && x <= 0.95;
const validModel = (x: unknown): x is string => typeof x === 'string' && /^[\w.:-]{1,64}$/.test(x);

export function readQueryPrivacySettings(db: CoreDatabase, env: NodeJS.ProcessEnv = process.env): QueryPrivacySettings {
  let stored: StoredSettings = {};
  try { stored = getMetadata<StoredSettings>(db, SETTINGS_KEY) ?? {}; } catch { /* unreadable: defaults */ }
  const flag = env.KARKEDIKHA_OLLAYA?.trim().toLowerCase();
  const fromEnv = flag === '1' || flag === 'true' ? true : flag === '0' || flag === 'false' ? false : undefined;
  return {
    enabled: fromEnv ?? stored.enabled === true,
    endpoint: env.KARKEDIKHA_OLLAYA_URL?.trim() || QUERY_PRIVACY_DEFAULTS.endpoint,
    kindModel: validModel(stored.kindModel) ? stored.kindModel : QUERY_PRIVACY_DEFAULTS.kindModel,
    kindThreshold: validThreshold(stored.kindThreshold) ? stored.kindThreshold : QUERY_PRIVACY_DEFAULTS.kindThreshold,
    detailModel: validModel(stored.detailModel) ? stored.detailModel : QUERY_PRIVACY_DEFAULTS.detailModel,
    detailThreshold: validThreshold(stored.detailThreshold) ? stored.detailThreshold : QUERY_PRIVACY_DEFAULTS.detailThreshold,
    timeoutMs: QUERY_PRIVACY_DEFAULTS.timeoutMs,
    source: fromEnv !== undefined ? 'environment' : stored.enabled !== undefined ? 'setting' : 'default',
  };
}

export function updateQueryPrivacySettings(db: CoreDatabase, patch: Record<string, unknown>, env: NodeJS.ProcessEnv = process.env): QueryPrivacySettings {
  const next: StoredSettings = { ...(getMetadata<StoredSettings>(db, SETTINGS_KEY) ?? {}) };
  if ('enabled' in patch) {
    if (typeof patch.enabled !== 'boolean') throw new CoreError('invalid_request', "'enabled' must be true or false");
    next.enabled = patch.enabled;
  }
  for (const key of ['kindModel', 'detailModel'] as const) {
    if (key in patch) {
      if (!validModel(patch[key])) throw new CoreError('invalid_request', `'${key}' must be an Ollaya model name`);
      next[key] = patch[key] as string;
    }
  }
  for (const key of ['kindThreshold', 'detailThreshold'] as const) {
    if (key in patch) {
      if (!validThreshold(patch[key])) throw new CoreError('invalid_request', `'${key}' must be a number from 0.05 to 0.95`);
      next[key] = patch[key] as number;
    }
  }
  setMetadata(db, SETTINGS_KEY, next);
  return readQueryPrivacySettings(db, env);
}

export interface QueryPrivacyOpinion {
  /** 1 − P(public) from the kind model, when it answered. */
  notPublic: number | null;
  /** P(a named person with a private matter) from the detail model, when it answered. */
  personDetail: number | null;
  kindFlag: boolean;
  detailFlag: boolean;
  flagged: boolean;
  models: string[];
  kindThreshold: number;
  detailThreshold: number;
  /** A model that gave no answer; its half of the opinion is missing, the other half still counts. */
  missing: Array<'kind' | 'detail'>;
  latencyMs: number;
}

type Unavailable = 'not_loopback' | 'timeout' | 'http_error' | 'unreadable' | 'unreachable';
export type QueryPrivacyReview =
  | { available: true; opinion: QueryPrivacyOpinion }
  | { available: false; reason: Unavailable; latencyMs: number };

const clamp01 = (p: unknown): number | null => (typeof p === 'number' && Number.isFinite(p) && p >= 0 && p <= 1 ? p : null);

async function ask(settings: QueryPrivacySettings, model: string, query: string, questions: object, fetchImpl: typeof fetch, signal: AbortSignal, timeout: AbortSignal):
  Promise<{ ok: true; model: string; answers: Record<string, { probabilities?: Record<string, unknown>; noul?: unknown }> } | { ok: false; reason: Unavailable }> {
  try {
    const res = await fetchImpl(new URL('/v1/systemone', settings.endpoint), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, state: { query }, questions }), signal,
    });
    if (!res.ok) return { ok: false, reason: 'http_error' };
    const json = (await res.json()) as { model?: unknown; answers?: Record<string, { probabilities?: Record<string, unknown>; noul?: unknown }> };
    return { ok: true, model: typeof json.model === 'string' && json.model ? json.model : model, answers: json.answers ?? {} };
  } catch (err) {
    return { ok: false, reason: timeout.aborted || (err as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
}

/** Asks both models about one query, in parallel. Never throws; null when the check is off. */
export async function reviewQueryPrivacy(
  settings: QueryPrivacySettings,
  input: { query: string },
  options: { fetchImpl?: typeof fetch; signal?: AbortSignal } = {},
): Promise<QueryPrivacyReview | null> {
  if (!settings.enabled) return null;
  const started = Date.now();
  if (!isLoopbackEndpoint(settings.endpoint)) return { available: false, reason: 'not_loopback', latencyMs: 0 };
  const timeout = AbortSignal.timeout(settings.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = input.query.slice(0, MAX_QUERY_CHARS);
  const [kind, detail] = await Promise.all([
    ask(settings, settings.kindModel, query, KIND_QUESTION, fetchImpl, signal, timeout),
    ask(settings, settings.detailModel, query, DETAIL_QUESTION, fetchImpl, signal, timeout),
  ]);
  const publicP = kind.ok ? clamp01(kind.answers.kind?.probabilities?.public) : null;
  const personDetail = detail.ok ? clamp01(detail.answers.person_detail?.noul) : null;
  if (publicP === null && personDetail === null) {
    const reason: Unavailable = !kind.ok ? kind.reason : !detail.ok ? detail.reason : 'unreadable';
    return { available: false, reason, latencyMs: Date.now() - started };
  }
  const notPublic = publicP === null ? null : 1 - publicP;
  const kindFlag = notPublic !== null && notPublic >= settings.kindThreshold;
  const detailFlag = personDetail !== null && personDetail >= settings.detailThreshold;
  return {
    available: true,
    opinion: {
      notPublic, personDetail, kindFlag, detailFlag, flagged: kindFlag || detailFlag,
      models: [kind.ok ? kind.model : null, detail.ok ? detail.model : null].filter((m): m is string => Boolean(m)),
      kindThreshold: settings.kindThreshold, detailThreshold: settings.detailThreshold,
      missing: [...(publicP === null ? ['kind' as const] : []), ...(personDetail === null ? ['detail' as const] : [])],
      latencyMs: Date.now() - started,
    },
  };
}

/** The card's first line for a flagged query: a short warning and a brief reason. */
export function queryPrivacyWarning(opinion: QueryPrivacyOpinion): string {
  return `⚠ This search may contain private information: a second opinion on this PC (${opinion.models.join(', ')}) thinks it may name a private person or share personal or confidential details. Nothing is sent unless you approve.`;
}

/** What the card carries for the record and the interface: numbers only. */
export function queryPrivacySummary(opinion: QueryPrivacyOpinion): Record<string, unknown> {
  return {
    models: opinion.models, notPublic: opinion.notPublic, personDetail: opinion.personDetail, kindFlag: opinion.kindFlag, detailFlag: opinion.detailFlag,
    kindThreshold: opinion.kindThreshold, detailThreshold: opinion.detailThreshold,
  };
}

export type QueryPrivacyOutcome = 'clear' | 'asked' | 'unavailable';

const round4 = (x: number | null) => (x === null ? null : Number(x.toFixed(4)));

/** Records one review as redacted evidence: no query text, only a digest, its length, numbers and timing. */
export function recordQueryPrivacyReview(db: CoreDatabase, input: { attemptId: string; toolName: string; query: string; review: QueryPrivacyReview; outcome: QueryPrivacyOutcome }): void {
  const base = { toolName: input.toolName, outcome: input.outcome, queryDigest: createHash('sha256').update(input.query).digest('hex').slice(0, 16), queryChars: input.query.length };
  const metadata = input.review.available
    ? {
      ...base,
      models: input.review.opinion.models,
      notPublic: round4(input.review.opinion.notPublic),
      personDetail: round4(input.review.opinion.personDetail),
      kindFlag: input.review.opinion.kindFlag,
      detailFlag: input.review.opinion.detailFlag,
      kindThreshold: input.review.opinion.kindThreshold,
      detailThreshold: input.review.opinion.detailThreshold,
      missing: input.review.opinion.missing,
      flagged: input.review.opinion.flagged,
      latencyMs: input.review.opinion.latencyMs,
    }
    : { ...base, unavailable: input.review.reason, latencyMs: input.review.latencyMs };
  try {
    recordRuntimeEvent(db, { domain: 'research', entityId: input.attemptId, eventType: 'query_privacy_second_opinion', actor: 'core:second_opinion', metadata });
  } catch { /* recording must never change what happens to the query */ }
}

let lastWarmAt = 0;
/** Loads both models ahead of the first search of a turn (placeholder text only; fire and forget; at most every four minutes). */
export function warmQueryPrivacy(settings: QueryPrivacySettings, fetchImpl: typeof fetch = fetch, now: number = Date.now()): void {
  if (!settings.enabled || !isLoopbackEndpoint(settings.endpoint) || now - lastWarmAt < 4 * 60_000) return;
  lastWarmAt = now;
  for (const [model, questions] of [[settings.kindModel, KIND_QUESTION], [settings.detailModel, DETAIL_QUESTION]] as const) {
    void fetchImpl(new URL('/v1/systemone', settings.endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, state: { query: 'latest stable release of a programming language' }, questions }),
      signal: AbortSignal.timeout(60_000),
    }).then((r) => r.body?.cancel()).catch(() => { /* best effort */ });
  }
}

/** For tests: forget the last warm-up time. */
export function resetQueryPrivacyWarmth(): void {
  lastWarmAt = 0;
}
