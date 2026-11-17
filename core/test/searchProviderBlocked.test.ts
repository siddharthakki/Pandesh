/**
 * Owner report 2026-11-17 (Build 183): "find me the cheapest deal for AOC cu34g4zca Monitor" ended with US shops
 * listed from memory and "The web search did not return verified results". Both web_research calls had failed with
 * research_no_results: the keyless search endpoint answered Core's header-less request with its bot-check page
 * (HTTP 202, zero result links), for every query. These tests pin the three parts of the fix.
 */
import { describe, it, expect } from 'vitest';
import { createResearchEvidenceRunner } from '../runtime/researchCapability';
import { RESEARCH_REQUEST_HEADERS, isSearchChallenge, parseDuckDuckGoResults } from '../runtime/researchRunner';
import { failedProductSearchReply } from '../runtime/piAgentEngine';

const CHALLENGE = '<html><head><title>DuckDuckGo</title></head><body><div class="anomaly-modal__title">Unfortunately, bots use DuckDuckGo too.</div><form id="challenge-form"></form></body></html>';
const RESULTS = '<html><body><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Faoc-cu34g4zca">AOC CU34G4ZCA offer</a></body></html>';
const PAGE = '<html><body><p>AOC CU34G4ZCA 34 inch curved monitor, price 389,00 EUR including VAT, in stock at this shop today.</p></body></html>';

describe('web search when the provider answers with a bot check', () => {
  it('recognises the bot-check page and status, and does not mistake a result page for one', () => {
    expect(isSearchChallenge(202, CHALLENGE)).toBe(true);
    expect(isSearchChallenge(200, CHALLENGE)).toBe(true);
    expect(isSearchChallenge(429, '')).toBe(true);
    expect(isSearchChallenge(200, RESULTS)).toBe(false);
    expect(parseDuckDuckGoResults(CHALLENGE)).toHaveLength(0);
  });

  it('reports a blocked provider as blocked, not as "no results"', async () => {
    const run = createResearchEvidenceRunner({ providerUrl: undefined, fetchFn: (async () => new Response(CHALLENGE, { status: 202 })) as typeof fetch });
    const result = await run('cheapest price for AOC cu34g4zca monitor');
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('research_provider_blocked');
    expect(String(result.output)).toMatch(/refused this request/);
    expect(String(result.output)).not.toMatch(/No accessible research results/);
  });

  it('still says "no results" when the provider really answered with none', async () => {
    const run = createResearchEvidenceRunner({ providerUrl: undefined, fetchFn: (async () => new Response('<html><body>No results.</body></html>', { status: 200 })) as typeof fetch });
    expect((await run('zzzz qqqq')).resultCategory).toBe('research_no_results');
  });

  it('identifies itself on the search request and on every page it fetches', async () => {
    const seen: Array<{ url: string; ua: string | null; lang: string | null }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, ua: headers.get('user-agent'), lang: headers.get('accept-language') });
      return new Response(url.startsWith('https://html.duckduckgo.com/') ? RESULTS : PAGE, { status: 200 });
    }) as typeof fetch;
    const result = await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn })('AOC cu34g4zca price');
    expect(result.status).toBe('succeeded');
    expect(String(result.output)).toContain('389,00 EUR');
    expect(seen).toHaveLength(2);
    for (const request of seen) {
      expect(request.ua).toBe(RESEARCH_REQUEST_HEADERS['user-agent']);
      expect(request.lang).toBeTruthy();
    }
    // The name is Pandesh's own; it never claims to be a browser.
    expect(RESEARCH_REQUEST_HEADERS['user-agent']).toMatch(/^Pandesh\//);
    expect(RESEARCH_REQUEST_HEADERS['user-agent']).not.toMatch(/Mozilla|Chrome|Safari/);
  });
});

describe('the reply after a price search that could not run', () => {
  it('gives the real reason and no shop or price from memory', () => {
    const blocked = failedProductSearchReply('Web research failed (research_provider_blocked): The search provider refused this request');
    expect(blocked).toMatch(/refused the request/);
    expect(blocked).toMatch(/not naming shops or prices from memory/);
    expect(blocked).not.toMatch(/Amazon|Newegg|Best Buy|B&H/);
    expect(failedProductSearchReply('Web research failed (research_no_results): No accessible research results')).toMatch(/no results for that wording/);
    expect(failedProductSearchReply('Web research failed (research_all_sources_failed): none could be safely retrieved')).toMatch(/none of them could be read/);
    expect(failedProductSearchReply('research_timeout')).toMatch(/did not answer in time/);
  });

  it('hands on the pages the search found when none could be read, without a price', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => String(input).startsWith('https://html.duckduckgo.com/')
      ? new Response(RESULTS, { status: 200 })
      : new Response('denied', { status: 403 })) as typeof fetch;
    const result = await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn })('AOC CU34G4ZCA Preisvergleich');
    expect(result.resultCategory).toBe('research_all_sources_failed');
    expect(String(result.output)).toContain('- AOC CU34G4ZCA offer: https://shop.example/aoc-cu34g4zca');
    const reply = failedProductSearchReply(`Web research failed (research_all_sources_failed): ${String(result.output)}`);
    expect(reply).toContain('[AOC CU34G4ZCA offer](https://shop.example/aoc-cu34g4zca)');
    expect(reply).toMatch(/not read them/);
    expect(reply).not.toMatch(/\d+[.,]\d{2}\s?(?:€|EUR)/);
  });
});
