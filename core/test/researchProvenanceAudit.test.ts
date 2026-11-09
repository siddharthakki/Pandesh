/**
 * M9 provenance/privacy audit (synthetic data only, no network): the stored source is the fetched page, markers stay
 * tied to their URL and title, representative secrets are redacted before storage, figures need nearby support.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createResearchEvidenceRunner } from '../runtime/researchCapability';
import { recordResearchProvenance, researchSourcesForTurn, redactResearchText } from '../domain/researchProvenance';
import { ungroundedClaims, unsupportedFigures } from '../runtime/researchGrounding';

const SYNTHETIC = {
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8',
  aws: 'AKIA' + 'QZ7XYV3W9TESTK01',
  slack: 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.' + 'eyJzdWIiOiJ0ZXN0LXVzZXIifQ.' + 'c2lnbmF0dXJlLXN5bnRoZXRpYy10ZXN0',
  openai: 'sk-' + 'synthetic0123456789abcdefTEST',
  pem: '-----BEGIN PRIVATE KEY-----\nMIIEvSYNTHETICKEYMATERIALONLYFORTEST\n-----END PRIVATE KEY-----',
  urlToken: 'https://example.org/report?id=7&access_token=SYNTHtok3n9988776655&lang=en',
};

let dir: string; let db: CoreDatabase;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdk-m9a-')); db = openCoreDatabase(path.join(dir, 'core.db')).db; });
afterEach(() => { try { (db as any).close?.(); } catch { /* */ } try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('research provenance corresponds to the fetched pages', () => {
  it('hash, URL, title and marker of each stored source match what was fetched', async () => {
    const pages: Record<string, { title: string; html: string }> = {
      'https://jobs.example.org/a': { title: 'Jobs A', html: '<html><body><h1>Jobs A</h1><p>Delivery Hero is hiring a Senior Product Manager in Berlin. 93 roles in Berlin.</p></body></html>' },
      'https://jobs.example.org/b': { title: 'Jobs B', html: '<html><body><p>n8n is hiring a Product Manager, remote. 46 remote roles. Salary band 70,000 to 85,000 EUR.</p></body></html>' },
    };
    const fetchFn = (async (input: any) => {
      const url = String(input instanceof URL ? input.toString() : input);
      if (url.startsWith('https://search.example.org/')) {
        return new Response(JSON.stringify({ results: Object.entries(pages).map(([u, p]) => ({ url: u, title: p.title })) }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const page = pages[url];
      return page ? new Response(page.html, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('nope', { status: 404 });
    }) as typeof fetch;
    const run = createResearchEvidenceRunner({ providerUrl: 'https://search.example.org/search', fetchFn });
    const result = await run('product manager jobs');
    expect(result.status).toBe('succeeded');
    const prov = result.researchProvenance!;
    recordResearchProvenance(db, { attemptId: 'att_a', conversationId: 'conv_a', toolName: 'governed_research', provenance: prov });
    const rows = researchSourcesForTurn(db, { attemptId: 'att_a', since: '2000-01-01' });
    expect(rows.map((r) => r.marker)).toEqual(['S1', 'S2']);
    for (const [i, row] of rows.entries()) {
      const src = prov.sources[i];
      expect(row.finalUrl).toBe(src.finalUrl);
      expect(row.title).toBe(pages[src.finalUrl].title);
      expect(row.contentSha256).toBe(crypto.createHash('sha256').update(src.fullText, 'utf8').digest('hex'));
      // the model-facing output cites the same marker with the same URL
      expect(String(result.output)).toContain(`[${row.marker}]\nTitle: ${row.title}\nURL: ${row.finalUrl}`);
    }
  });

  it('a conversation never reads another conversation\'s sources', () => {
    const p = { query: 'q', retrievedAt: '2026-11-08T10:00:00.000Z', sources: [{ finalUrl: 'https://a.example/x', title: 'A', fullText: 'public text one', excerptChars: 15 }] };
    recordResearchProvenance(db, { attemptId: 'att_1', conversationId: 'conv_1', toolName: 'web_research', provenance: p });
    expect(researchSourcesForTurn(db, { attemptId: 'att_2', conversationId: 'conv_2', since: '2000-01-01' })).toHaveLength(0);
    expect(researchSourcesForTurn(db, { attemptId: 'att_2', conversationId: 'conv_1', since: '2000-01-01' })).toHaveLength(1);
  });
});

describe('representative secrets are redacted before storage', () => {
  it.each(Object.entries(SYNTHETIC))('%s', (_kind, secret) => {
    const page = `Public page text. Leaked by mistake: ${secret} end of page.`;
    const stored = redactResearchText(page);
    const secretCore = secret.includes('access_token=') ? 'SYNTHtok3n9988776655' : secret.includes('PRIVATE KEY') ? 'MIIEvSYNTHETICKEYMATERIALONLYFORTEST' : secret;
    expect(stored).not.toContain(secretCore);
    expect(stored).toContain('Public page text.');
  });

  it('applies to the stored row, its URL and title', () => {
    recordResearchProvenance(db, { attemptId: 'att_s', conversationId: null, toolName: 'web_research', provenance: { query: 'q', retrievedAt: '2026-11-08T10:00:00.000Z', sources: [
      { finalUrl: SYNTHETIC.urlToken, title: `Docs ${SYNTHETIC.github}`, fullText: `text ${SYNTHETIC.aws} ${SYNTHETIC.jwt}`, excerptChars: 10 },
    ] } });
    const [row] = researchSourcesForTurn(db, { attemptId: 'att_s', since: '2000-01-01' });
    expect(JSON.stringify(row)).not.toMatch(/SYNTHtok3n|ghp_A1b2|AKIAQZ7X|eyJzdWIi/);
  });
});

describe('a figure about a named organisation needs nearby support', () => {
  const sources = ['... Delivery Hero is hiring a Senior Product Manager in Berlin. 93 roles in Berlin ...', '... n8n is hiring a Product Manager, remote. Salary band 70,000 to 85,000 EUR ...'];
  it('flags an invented figure attached to a real name', () => {
    const reply = 'Companies like **Delivery Hero** are hiring; Delivery Hero offers a salary of €250,000.';
    expect(unsupportedFigures(reply, sources)).toEqual(['Delivery Hero: €250,000']);
    expect(ungroundedClaims(reply, sources.join('\n'), sources).claims).toEqual(['Delivery Hero: €250,000']);
  });
  it('accepts figures stated near the organisation', () => {
    expect(unsupportedFigures('Companies like n8n are hiring, with a salary band of 70,000–85,000 EUR.', sources)).toEqual([]);
  });
});

describe('the model-facing excerpt (also kept in tool evidence) is redacted', () => {
  it('a token on a fetched page never reaches the research output', async () => {
    const html = `<html><body><p>Public product manager listings for Germany. Debug: access key ${SYNTHETIC.aws} and ${SYNTHETIC.github}.</p></body></html>`;
    const fetchFn = (async (input: any) => {
      const url = String(input instanceof URL ? input.toString() : input);
      if (url.startsWith('https://search.example.org/')) return new Response(JSON.stringify({ results: [{ url: 'https://jobs.example.org/x', title: 'X' }] }), { status: 200 });
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as typeof fetch;
    const result = await createResearchEvidenceRunner({ providerUrl: 'https://search.example.org/s', fetchFn })('pm jobs');
    expect(String(result.output)).toContain('Public product manager listings');
    expect(String(result.output)).not.toMatch(/AKIAQZ7X|ghp_A1b2/);
  });
});
