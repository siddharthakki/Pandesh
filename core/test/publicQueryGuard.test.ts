import { describe, expect, it } from 'vitest';
import { checkPublicQuery, derivePublicQuery, explicitlyRequestsWebSearch, referencesLocalContent } from '../runtime/publicQueryGuard';
import { deriveResearchQueries, isPublicResearchTask } from '../runtime/piAgentEngine';

// Verbatim prompts from the Build 159 independent audit (acceptance/claude-independent-audit/frozen_missions.md).
const M9 = 'Read my CV from the selected folder and help me find suitable English-speaking product or project manager jobs in Germany. Search the public web for opportunities, but keep my CV and personal details private.';
const C1 = "I've put my suppliers' price lists in this folder. Which one is cheapest for basmati rice if I need 20 kg? Write me a short note called rice_order.txt saying who to order from and what it will cost in total.";

describe('public query guard (audit D2)', () => {
  it('recognises both audit prompts as being about local content', () => {
    expect(referencesLocalContent(M9)).toBe(true);
    expect(referencesLocalContent(C1)).toBe(true);
    expect(referencesLocalContent('What is the latest Ollama release?')).toBe(false);
  });

  it('M9 explicitly asks for the web; C1 does not', () => {
    expect(explicitlyRequestsWebSearch(M9)).toBe(true);
    expect(explicitlyRequestsWebSearch(C1)).toBe(false);
  });

  it('refuses to send the user prompt verbatim (the leaked M9 query)', () => {
    const check = checkPublicQuery(M9, { userMessage: M9 });
    expect(check.ok).toBe(false);
  });

  it('refuses the C1 prompt and any first-person or instruction wording', () => {
    expect(checkPublicQuery(C1, { userMessage: C1 }).ok).toBe(false);
    expect(checkPublicQuery('jobs matching my CV in Germany').ok).toBe(false);
    expect(checkPublicQuery('keep this private product manager jobs').ok).toBe(false);
  });

  it('refuses personal identifiers, local paths and canaries', () => {
    for (const q of [
      'product manager jobs anna.schmidt@example.com',
      'project manager +49 151 2345 6789',
      'jobs near Hauptstrasse 12 Ulm',
      'D:\\Users\\anna\\cv.pdf product manager',
      'PRIVATE_CANARY_7F3A product manager',
      'DE89 3704 0044 0532 0130 00 salary',
    ]) expect(checkPublicQuery(q).ok, q).toBe(false);
  });

  it('refuses a query that repeats text read from a private file this turn', () => {
    const cv = 'Anna Schmidt. Senior Product Manager at Brightline Logistics GmbH 2019-2024, led the Atlas routing platform.';
    expect(checkPublicQuery('Brightline Logistics GmbH 2019-2024 product manager', { privateTexts: [cv] }).ok).toBe(false);
    expect(checkPublicQuery('English-speaking product manager jobs Germany', { privateTexts: [cv] }).ok).toBe(true);
  });

  it('allows a short public query', () => {
    expect(checkPublicQuery('English-speaking product manager jobs Germany')).toEqual({ ok: true, query: 'English-speaking product manager jobs Germany' });
  });

  it('derives a public query from M9 without the CV, folder or privacy clauses', () => {
    const query = derivePublicQuery(M9);
    expect(query).toBeTruthy();
    expect(query!).toMatch(/project manager jobs in Germany/i);
    expect(query!).not.toMatch(/\b(?:cv|my|me|folder|private|read)\b/i);
    expect(query!.length).toBeLessThanOrEqual(120);
    expect(checkPublicQuery(query!, { userMessage: M9 }).ok).toBe(true);
  });

  it('research tool scoping no longer strips local tools for a local-content prompt', () => {
    // isPublicResearchTask alone may still say "research"; piAgentEngine combines it with referencesLocalContent.
    expect(isPublicResearchTask(M9) && !referencesLocalContent(M9)).toBe(false);
    expect(isPublicResearchTask(C1) && !referencesLocalContent(C1)).toBe(false);
  });

  it('auto research queries are never the raw request', () => {
    const request = 'Please search the web for the latest news about the Ollama 0.13 release and its benchmarks';
    const queries = deriveResearchQueries(request);
    for (const q of queries) {
      expect(q).not.toBe(request);
      expect(checkPublicQuery(q, { userMessage: request }).ok).toBe(true);
    }
  });
});
