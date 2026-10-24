/**
 * M38 — deterministic local research transport fixture.
 *
 * Stands in for a real SearXNG provider behind
 * `core/runtime/researchCapability.ts`'s `KARKEDIKHA_SEARXNG_URL` seam (the
 * same env-var-injectable transport `createResearchCapabilityAdapter()`
 * already uses in production — see `core/index.ts`'s `buildCapabilityRegistries`).
 * No production SSRF/timeout/size/redaction policy is touched: the fixture
 * is a swap-in *provider*, not a policy bypass. The adapter's own
 * `assertSafeSource` guard (`core/runtime/researchRunner.ts`) still runs
 * against every search-result URL exactly as in production, which is why
 * the fixture's search results use the `<label>.127.0.0.1.nip.io` public
 * wildcard-DNS convention already established by
 * `scripts/acceptance/m36AcceptanceHarness.mjs`'s
 * `startDeterministicM36ResearchFixture` — a real DNS lookup resolves to
 * loopback (so the safety check's private-IP/hostname blocklist, which is a
 * literal string check, does not fire on it) while all fetched content stays
 * on this local server, i.e. no real external content is ever retrieved.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';
import { M38_RESEARCH_SOURCE_TITLE, M38_RESEARCH_EVIDENCE_MARKER } from './m38FixtureConstants.mjs';

const SOURCE_HTML = `<html><head><title>${M38_RESEARCH_SOURCE_TITLE}</title></head><body>` +
  '<script>window.readLocalSecrets && window.readLocalSecrets()</script>' +
  `<article><h1>${M38_RESEARCH_SOURCE_TITLE}</h1><p>${M38_RESEARCH_EVIDENCE_MARKER}</p>` +
  '<p>This fixed, bounded excerpt is the only content the deterministic research fixture ever serves.</p>' +
  '</article></body></html>';

export async function startResearchFixture({ logFilePath } = {}) {
  const requestLog = [];
  let closedAt = null;
  let port = null;
  // Acceptance-only controllable timing (Scenario E — cancellation while a
  // governed capability adapter is genuinely in flight): when held, /search
  // accepts the connection but withholds its HTTP response until released,
  // so Core's real fetch() call is genuinely blocked waiting on this fixture
  // — not merely queued behind an approval — at the moment cancellation is
  // requested. Never touches production SSRF/timeout/redaction policy.
  let held = false;
  let releaseWaiters = [];
  function holdSearchResponses(shouldHold) {
    held = shouldHold;
    if (!shouldHold) {
      const waiters = releaseWaiters;
      releaseWaiters = [];
      waiters.forEach((resolve) => resolve());
    }
  }
  async function waitIfHeld() {
    if (!held) return;
    await new Promise((resolve) => releaseWaiters.push(resolve));
  }

  function appendLog(entry) {
    requestLog.push(entry);
    if (logFilePath) {
      try {
        fs.appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`, 'utf8');
      } catch {
        // Evidence logging is best-effort.
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    appendLog({ capturedAt: new Date().toISOString(), method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ready: true }));
      return;
    }

    if (url.pathname === '/search') {
      await waitIfHeld();
      // See module docstring — a real DNS lookup, no real external content.
      const sourceHost = `source.127.0.0.1.nip.io:${port}`;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        results: [{ url: `http://${sourceHost}/article`, title: M38_RESEARCH_SOURCE_TITLE }],
      }));
      return;
    }

    if (url.pathname === '/article') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(SOURCE_HTML);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('research fixture did not bind a TCP port');
  port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    providerUrl: `http://127.0.0.1:${port}/search`,
    requestLog,
    holdSearchResponses,
    snapshot: () => ({ requests: requestLog.length, closedAt }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          closedAt = new Date().toISOString();
          resolve();
        });
      }),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fixture = await startResearchFixture({ logFilePath: process.env.M38_RESEARCH_FIXTURE_LOG_PATH });
  // eslint-disable-next-line no-console
  console.log(`[m38-research-fixture] listening on ${fixture.baseUrl}, providerUrl=${fixture.providerUrl}`);
  const shutdown = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
