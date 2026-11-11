import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import {
  QUERY_PRIVACY_DEFAULTS, queryPrivacySummary, queryPrivacyWarning, readQueryPrivacySettings, recordQueryPrivacyReview,
  resetQueryPrivacyWarmth, reviewQueryPrivacy, updateQueryPrivacySettings, warmQueryPrivacy, type QueryPrivacyOpinion, type QueryPrivacySettings,
} from '../runtime/queryPrivacySecondOpinion';

/**
 * The optional Ollaya privacy second opinion on search queries: two models in parallel, off by default, loopback only,
 * no answer means no opinion, and the record never holds the query.
 */

let dir: string;
let db: CoreDatabase;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-query-privacy-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  resetQueryPrivacyWarmth();
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const on: QueryPrivacySettings = { enabled: true, endpoint: 'http://127.0.0.1:11435', kindModel: 'decider:2b', kindThreshold: 0.7, detailModel: 'decider:0.8b', detailThreshold: 0.6, timeoutMs: 3_000, source: 'setting' };
/** A fake Ollaya: each request gets the answer for the question it asked, as the real server does. */
const server = (publicP: number, personDetail: number, status: { kind?: number; detail?: number } = {}) =>
  vi.fn(async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.questions.kind) {
      return new Response(JSON.stringify({ model: body.model, answers: { kind: { type: 'choice', probabilities: { public: publicP, personal: 1 - publicP, confidential: 0 } } } }), { status: status.kind ?? 200 });
    }
    return new Response(JSON.stringify({ model: body.model, answers: { person_detail: { type: 'noul', noul: personDetail } } }), { status: status.detail ?? 200 });
  });
// The miss that made the first pick fail (docs/evals/ollaya-decisions.md): a name next to a diagnosis.
const NAME_AND_DIAGNOSIS = 'Jonas Weber diabetes diagnosis treatment options';

describe('settings', () => {
  it('is off by default, with the measured models and thresholds', () => {
    expect(readQueryPrivacySettings(db, {})).toMatchObject({
      enabled: false, source: 'default', kindModel: 'decider:2b', kindThreshold: 0.7, detailModel: 'decider:0.8b', detailThreshold: 0.6, endpoint: QUERY_PRIVACY_DEFAULTS.endpoint,
    });
  });

  it('stores and validates the owner\'s choice; the environment overrides it', () => {
    expect(updateQueryPrivacySettings(db, { enabled: true, kindThreshold: 0.6, detailModel: 'decision' }, {})).toMatchObject({ enabled: true, kindThreshold: 0.6, detailModel: 'decision', source: 'setting' });
    expect(() => updateQueryPrivacySettings(db, { detailThreshold: 2 }, {})).toThrow(/0.05 to 0.95/);
    expect(() => updateQueryPrivacySettings(db, { kindModel: 'a b' }, {})).toThrow(/model name/);
    expect(() => updateQueryPrivacySettings(db, { enabled: 1 }, {})).toThrow(/true or false/);
    expect(readQueryPrivacySettings(db, { KARKEDIKHA_OLLAYA: '0' })).toMatchObject({ enabled: false, source: 'environment' });
  });
});

describe('reviewQueryPrivacy', () => {
  it('asks nothing when it is off, and never sends to a non-loopback address', async () => {
    const fetchImpl = server(0.1, 0.9);
    expect(await reviewQueryPrivacy({ ...on, enabled: false }, { query: NAME_AND_DIAGNOSIS }, { fetchImpl })).toBeNull();
    expect(await reviewQueryPrivacy({ ...on, endpoint: 'http://192.0.2.10:11435' }, { query: NAME_AND_DIAGNOSIS }, { fetchImpl })).toMatchObject({ available: false, reason: 'not_loopback' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('asks each model its own question about the query alone, and flags when either reaches its threshold', async () => {
    const fetchImpl = server(0.7, 0.8);
    expect(await reviewQueryPrivacy(on, { query: NAME_AND_DIAGNOSIS }, { fetchImpl })).toMatchObject({
      available: true, opinion: { kindFlag: false, detailFlag: true, flagged: true, personDetail: 0.8, models: ['decider:2b', 'decider:0.8b'], missing: [] },
    });
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(String((c as unknown as [URL, RequestInit])[1].body)));
    expect(bodies.map((b) => [b.model, Object.keys(b.questions)])).toEqual([['decider:2b', ['kind']], ['decider:0.8b', ['person_detail']]]);
    for (const b of bodies) expect(b.state).toEqual({ query: NAME_AND_DIAGNOSIS });
    // "Not public" at exactly its threshold counts; the detail model alone just under its threshold does not.
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: server(0.3, 0.1) })).toMatchObject({ opinion: { kindFlag: true, flagged: true } });
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: server(0.31, 0.59) })).toMatchObject({ opinion: { flagged: false } });
    const long = server(0.9, 0.1);
    await reviewQueryPrivacy(on, { query: 'a'.repeat(2_000) }, { fetchImpl: long });
    expect(JSON.parse(String((long.mock.calls[0] as unknown as [URL, RequestInit])[1].body)).state.query).toHaveLength(600);
  });

  it('uses the half that answered when one model fails, and gives no opinion when both fail', async () => {
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: server(0.1, 0.1, { detail: 500 }) })).toMatchObject({ available: true, opinion: { kindFlag: true, flagged: true, missing: ['detail'], models: ['decider:2b'] } });
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: server(0.1, 0.9, { kind: 500, detail: 500 }) })).toMatchObject({ available: false, reason: 'http_error' });
    const unreadable = vi.fn(async () => new Response(JSON.stringify({ answers: {} })));
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: unreadable })).toMatchObject({ available: false, reason: 'unreadable' });
    const refused = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await reviewQueryPrivacy(on, { query: 'q' }, { fetchImpl: refused })).toMatchObject({ available: false, reason: 'unreachable' });
    const hangs = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
    }));
    const started = Date.now();
    expect(await reviewQueryPrivacy({ ...on, timeoutMs: 100 }, { query: 'q' }, { fetchImpl: hangs as unknown as typeof fetch })).toMatchObject({ available: false, reason: 'timeout' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

describe('what the card and the record say', () => {
  const opinion: QueryPrivacyOpinion = { notPublic: 0.3, personDetail: 0.85, kindFlag: false, detailFlag: true, flagged: true, models: ['decider:2b', 'decider:0.8b'], kindThreshold: 0.7, detailThreshold: 0.6, missing: [], latencyMs: 1300 };

  it('warns with a short reason and says that nothing is sent without approval', () => {
    expect(queryPrivacyWarning(opinion)).toBe('⚠ This search may contain private information: a second opinion on this PC (decider:2b, decider:0.8b) thinks it may name a private person or share personal or confidential details. Nothing is sent unless you approve.');
    expect(queryPrivacySummary(opinion)).toEqual({ models: ['decider:2b', 'decider:0.8b'], notPublic: 0.3, personDetail: 0.85, kindFlag: false, detailFlag: true, kindThreshold: 0.7, detailThreshold: 0.6 });
  });

  it('records redacted evidence: no query text, only a digest, its length, numbers and timing', () => {
    recordQueryPrivacyReview(db, { attemptId: 'att_x', toolName: 'web_research', query: NAME_AND_DIAGNOSIS, review: { available: true, opinion }, outcome: 'asked' });
    recordQueryPrivacyReview(db, { attemptId: 'att_x', toolName: 'governed_research', query: NAME_AND_DIAGNOSIS, review: { available: false, reason: 'timeout', latencyMs: 3000 }, outcome: 'unavailable' });
    const rows = db.all<{ domain: string; metadata: string }>("SELECT domain, metadata FROM runtime_events WHERE eventType = 'query_privacy_second_opinion' ORDER BY sequence");
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.domain).toBe('research');
      expect(row.metadata).not.toMatch(/Jonas|Weber|diabetes|diagnosis/);
    }
    expect(JSON.parse(rows[0].metadata)).toMatchObject({ outcome: 'asked', flagged: true, detailFlag: true, personDetail: 0.85, notPublic: 0.3, queryChars: NAME_AND_DIAGNOSIS.length, latencyMs: 1300 });
    expect(JSON.parse(rows[0].metadata).queryDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.parse(rows[1].metadata)).toMatchObject({ outcome: 'unavailable', unavailable: 'timeout', toolName: 'governed_research' });
  });
});

describe('warming the models', () => {
  it('does nothing when off; when on, loads both models with placeholder text only, at most every four minutes', () => {
    const fetchImpl = server(0.9, 0.1);
    warmQueryPrivacy({ ...on, enabled: false }, fetchImpl, 1_000_000);
    expect(fetchImpl).not.toHaveBeenCalled();
    warmQueryPrivacy(on, fetchImpl, 1_000_000);
    warmQueryPrivacy(on, fetchImpl, 1_000_000 + 60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((c) => JSON.parse(String((c as unknown as [URL, RequestInit])[1].body)));
    expect(bodies.map((b) => b.model)).toEqual(['decider:2b', 'decider:0.8b']);
    for (const b of bodies) expect(b.state).toEqual({ query: 'latest stable release of a programming language' });
  });
});
