/**
 * Price questions after the Build 183 report: the search listing's own summaries are evidence, and the browser reads
 * one found page only when there is nothing else (core/runtime/priceLookup.ts, researchCapability.ts).
 */
import { describe, it, expect } from 'vitest';
import { isBlockedPage, linksFromToolError, pickPricePage } from '../runtime/priceLookup';
import { createResearchEvidenceRunner } from '../runtime/researchCapability';
import { parseDuckDuckGoResults } from '../runtime/researchRunner';

// Shape of the real listing for "AOC CU34G4ZCA Preisvergleich" (2026-11-17), shortened.
const LISTING = `<html><body>
<div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.idealo.de%2Fpreisvergleich%2FOffersOfProduct%2F213321799_-cu34g4zca-aoc.html">AOC CU34G4ZCA ab 341,64 € (Oktober 2026) - idealo</a></h2>
<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">Bereits ab <b>341,64 €</b> Große Shopvielfalt Testberichte &amp; Meinungen | Jetzt AOC CU34G4ZCA günstig kaufen bei idealo.de</a></div>
<div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fshop.example%2Faoc">AOC CU34G4ZCA</a></h2></div>
</body></html>`;

describe('search listing summaries as evidence', () => {
  it('parses each result with its own summary, and none where the listing gives none', () => {
    const results = parseDuckDuckGoResults(LISTING);
    expect(results).toHaveLength(2);
    expect(results[0].url).toBe('https://www.idealo.de/preisvergleich/OffersOfProduct/213321799_-cu34g4zca-aoc.html');
    expect(results[0].snippet).toMatch(/^Bereits ab 341,64 € Große Shopvielfalt/);
    expect(results[1].snippet).toBeUndefined();
  });

  it('answers from the listing when no page can be fetched, labelled as a listing with its real URL', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => String(input).startsWith('https://html.duckduckgo.com/')
      ? new Response(LISTING, { status: 200 })
      : new Response('denied', { status: 403 })) as typeof fetch;
    const result = await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn })('AOC CU34G4ZCA Preisvergleich');
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('research_listing_only');
    const out = String(result.output);
    expect(out).toContain('[S1]');
    expect(out).toContain('341,64 €');
    expect(out).toContain('https://www.idealo.de/preisvergleich/OffersOfProduct/213321799_-cu34g4zca-aoc.html');
    expect(out).toMatch(/the page itself was not read/);
    // Stored as a source, so the grounding check knows where the price came from. The result without a summary is not.
    expect(result.researchProvenance?.sources).toHaveLength(1);
    expect(result.researchProvenance?.sources[0].fullText).toContain('341,64 €');
  });

  it('keeps a page that was read as the evidence for that URL and adds listings only for the others', async () => {
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://html.duckduckgo.com/')) return new Response(LISTING, { status: 200 });
      if (url.startsWith('https://www.idealo.de/')) return new Response('<html><body><p>AOC CU34G4ZCA: 23 Angebote, günstigster Preis 341,64 € inklusive Versand bei Shop A.</p></body></html>', { status: 200 });
      return new Response('denied', { status: 403 });
    }) as typeof fetch;
    const result = await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn })('AOC CU34G4ZCA Preisvergleich');
    expect(result.resultCategory).toBe('research_succeeded');
    expect(result.researchProvenance?.sources).toHaveLength(1);
    expect(String(result.output)).toContain('23 Angebote');
    expect(String(result.output)).not.toMatch(/Search listing summary/);
  });
});

describe('search region', () => {
  it('comes from a single-country time zone and is absent otherwise', async () => {
    const { searchRegion } = await import('../runtime/researchRunner');
    expect(searchRegion('Europe/Berlin')).toBe('de-de');
    expect(searchRegion('America/Chicago')).toBeNull();
    const asked: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => { asked.push(String(input)); return new Response(LISTING, { status: 200 }); }) as typeof fetch;
    await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn, region: 'de-de' })('AOC CU34G4ZCA price');
    await createResearchEvidenceRunner({ providerUrl: undefined, fetchFn, region: null })('AOC CU34G4ZCA price');
    const searches = asked.filter((u) => u.startsWith('https://html.duckduckgo.com/'));
    expect(new URL(searches[0]).searchParams.get('kl')).toBe('de-de');
    expect(new URL(searches[1]).searchParams.has('kl')).toBe(false);
  });
});

describe('the page the browser reads when nothing else answered', () => {
  it('reads the links web_research returned and nothing else', () => {
    const text = 'Web research failed (research_all_sources_failed): Search results were found but none could be safely retrieved. Pages found (not read):\n- Shop: https://shop.example/p/1\n- AOC CU34G4ZCA Preisvergleich: https://geizhals.de/aoc-cu34g4zca-a123.html\nsee https://not-a-result.example';
    expect(linksFromToolError(text)).toEqual([
      { title: 'Shop', url: 'https://shop.example/p/1' },
      { title: 'AOC CU34G4ZCA Preisvergleich', url: 'https://geizhals.de/aoc-cu34g4zca-a123.html' },
    ]);
    // A price-comparison page the search found comes first; a site is never made up.
    expect(pickPricePage(linksFromToolError(text))).toEqual({ url: 'https://geizhals.de/aoc-cu34g4zca-a123.html', site: 'geizhals.de' });
    expect(pickPricePage([{ title: 'Shop', url: 'https://shop.example/p/1' }])).toEqual({ url: 'https://shop.example/p/1', site: 'shop.example' });
    expect(pickPricePage([])).toBeNull();
    expect(pickPricePage([{ title: 'broken', url: 'not a url' }])).toBeNull();
  });

  it('recognises a bot check or refusal page, and leaves a normal offer page alone', () => {
    // What geizhals.de showed Core's browser on 2026-11-17.
    expect(isBlockedPage('Page: Just a moment...\nURL: https://geizhals.de/?fs=x\nSichere Verbindung wird überprüft')).toBe(true);
    expect(isBlockedPage('Page: Access Denied\nYou do not have permission.')).toBe(true);
    expect(isBlockedPage('Page: AOC CU34G4ZCA Preisvergleich\n12 Angebote ab € 389,00 bei Shop A, € 395,90 bei Shop B')).toBe(false);
  });
});
