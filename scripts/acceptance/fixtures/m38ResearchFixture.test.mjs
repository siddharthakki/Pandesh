import assert from 'node:assert/strict';
import test from 'node:test';
import { startResearchFixture } from './m38ResearchFixture.mjs';
import { M38_RESEARCH_SOURCE_TITLE, M38_RESEARCH_EVIDENCE_MARKER } from './m38FixtureConstants.mjs';

test('research fixture: readiness, fixed search-result metadata + provenance, bounded source content, clean shutdown', async () => {
  const fixture = await startResearchFixture();
  try {
    const health = await fetch(`${fixture.baseUrl}/health`).then((r) => r.json());
    assert.equal(health.ready, true);

    const search = await fetch(`${fixture.providerUrl}?q=widgets&format=json`).then((r) => r.json());
    assert.equal(search.results.length, 1);
    assert.equal(search.results[0].title, M38_RESEARCH_SOURCE_TITLE);
    // Deterministic provenance: same-origin loopback source (see the nip.io
    // convention documented in the fixture module), never a real external host.
    assert.match(search.results[0].url, /^http:\/\/source\.127\.0\.0\.1\.nip\.io:\d+\/article$/);

    const articleUrl = new URL(search.results[0].url);
    const articleResponse = await fetch(`http://127.0.0.1:${articleUrl.port}${articleUrl.pathname}`);
    assert.equal(articleResponse.status, 200);
    const html = await articleResponse.text();
    assert.match(html, new RegExp(M38_RESEARCH_EVIDENCE_MARKER));
    assert.match(html, new RegExp(M38_RESEARCH_SOURCE_TITLE));

    assert.equal(fixture.snapshot().requests, 3); // health, search, article
  } finally {
    await fixture.close();
  }
  assert.ok(fixture.snapshot().closedAt);
  await assert.rejects(() => fetch(`${fixture.baseUrl}/health`));
});
