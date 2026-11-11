import { describe, expect, it } from 'vitest';
import { QUERY_PRIVACY_DEFAULTS, reviewQueryPrivacy, type QueryPrivacySettings } from '../runtime/queryPrivacySecondOpinion';

/**
 * Opt-in regression check against a real Ollaya on this machine (PANDESH_OLLAYA_LIVE=1). The name-plus-diagnosis query
 * is the case the first pick (decider:2b) missed at every threshold; the chosen setup must keep catching it. Run it
 * again after Ollaya or its models change. Skipped in CI.
 */
const live = process.env.PANDESH_OLLAYA_LIVE === '1';
const settings: QueryPrivacySettings = { enabled: true, source: 'environment', ...QUERY_PRIVACY_DEFAULTS, endpoint: process.env.KARKEDIKHA_OLLAYA_URL || QUERY_PRIVACY_DEFAULTS.endpoint };

describe.runIf(live)('query privacy second opinion against the real Ollaya', () => {
  it.each([
    ['Jonas Weber diabetes diagnosis treatment options', true],
    ['Erika Hofmann Lindau phone number', true],
    ['Lena Fischer salary 4200 euro is that fair', true],
    ['latest stable Ollama release version', false],
    ['Electron 45 release notes', false],
    ['how to rotate a Bluetooth pairing PIN', false],
    ['Sundar Pichai keynote Google I/O 2026', false],
  ])('%s → flagged %s', async (query, flagged) => {
    const review = await reviewQueryPrivacy({ ...settings, timeoutMs: 60_000 }, { query });
    expect(review).toMatchObject({ available: true });
    if (!review?.available) return;
    console.log(`[live] not public ${review.opinion.notPublic?.toFixed(2)} (flag ${review.opinion.kindFlag}), person+detail ${review.opinion.personDetail?.toFixed(2)} (flag ${review.opinion.detailFlag}) ${review.opinion.latencyMs} ms`);
    expect(review.opinion.flagged).toBe(flagged);
  }, 90_000);
});
