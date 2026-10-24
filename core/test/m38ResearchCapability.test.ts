import { describe, it, expect } from 'vitest';
import { createResearchCapabilityAdapter } from '../runtime/researchCapability';

function fakeFetch(script: Record<string, { status?: number; headers?: Record<string, string>; body: string }>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = Object.keys(script).find((prefix) => url.startsWith(prefix));
    const scripted = match ? script[match] : undefined;
    if (!scripted) return new Response('not found', { status: 404 });
    return new Response(scripted.body, { status: scripted.status ?? 200, headers: scripted.headers });
  }) as typeof fetch;
}

describe('M38 governed research capability', () => {
  it('falls back to keyless DuckDuckGo when no SearXNG provider is configured', async () => {
    const adapter = createResearchCapabilityAdapter({ providerUrl: undefined, fetchFn: fakeFetch({}) });
    expect(adapter.health().state).toBe('available');
    const result = await adapter.run({ name: 'governed_research', arguments: { query: 'x' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('research_failed');
  });

  it('classifies governed_research as consequential (network egress is gated, per ADR-7)', () => {
    const adapter = createResearchCapabilityAdapter({ providerUrl: 'https://searx.local', fetchFn: fakeFetch({}) });
    expect(adapter.classify('governed_research')).toBe('consequential');
  });

  it('returns bounded, cited evidence for a real (scripted) search and fetch', async () => {
    const fetchFn = fakeFetch({
      'https://searx.local/?q=widgets&format=json': { body: JSON.stringify({ results: [{ url: 'https://example.com/widgets', title: 'Widgets Guide' }] }) },
      'https://example.com/widgets': { body: '<html><body><p>Widgets are useful mechanical devices used widely in manufacturing.</p></body></html>' },
    });
    const adapter = createResearchCapabilityAdapter({ providerUrl: 'https://searx.local', fetchFn });
    const result = await adapter.run({ name: 'governed_research', arguments: { query: 'widgets' } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('[S1]');
    expect(result.output).toContain('example.com/widgets');
    expect(result.output).toContain('mechanical devices');
  });

  it('rejects an empty query without making any network call', async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return new Response('', { status: 200 }); }) as typeof fetch;
    const adapter = createResearchCapabilityAdapter({ providerUrl: 'https://searx.local', fetchFn });
    const result = await adapter.run({ name: 'governed_research', arguments: { query: '  ' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('research_invalid_arguments');
    expect(calls).toBe(0);
  });

  it('never fetches a source on an unsafe/private network target', async () => {
    const fetchFn = fakeFetch({
      'https://searx.local/?q=x&format=json': { body: JSON.stringify({ results: [{ url: 'http://169.254.169.254/latest/meta-data', title: 'metadata' }] }) },
    });
    const adapter = createResearchCapabilityAdapter({ providerUrl: 'https://searx.local', fetchFn });
    const result = await adapter.run({ name: 'governed_research', arguments: { query: 'x' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('research_all_sources_failed');
  });
});
