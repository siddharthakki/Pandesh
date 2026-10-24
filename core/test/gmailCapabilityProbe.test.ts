/**
 * Proves the fix for the "Gmail remains not probed" lifecycle defect: a
 * fresh/restarted Core process never had anything call `probeHealth()`
 * after Desktop pushed a Gmail access token, so `capability 'gmail' is
 * unavailable: Gmail has not been probed yet` blocked dispatch forever even
 * once Desktop reported Gmail connected. `createConnectorCapabilityAdapter`
 * caches probe health by design (`health()` never itself performs I/O); only
 * `core/api/routes.ts`'s `PATCH`/`DELETE /v1/connectors/gmail/access-token`
 * and the new `POST /v1/connectors/:id/probe` retry route actually call
 * `probeHealth()` in production.
 *
 * Unlike `connectorFoundation.test.ts` (which calls `adapter.probeHealth()`
 * directly as a stand-in for the missing production wiring — see its
 * `buildTestRegistry` comment), every test here only ever drives the real
 * HTTP routes Desktop and Core actually use, so it fails if that production
 * wiring regresses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { clearGmailAccessToken, getGmailAccessToken } from '../runtime/connectors/gmailAccessTokenStore';
import { buildConnectorAdapters, CONNECTOR_CREDENTIAL_ENV } from '../runtime/connectors/connectorDefinitions';
import type { ConnectorProbe } from '../runtime/connectors/connectorCapability';

const TOKEN = generateToken();

interface Harness {
  dir: string;
  db: CoreDatabase;
  api: RunningApiServer;
  baseUrl: string;
}

async function startHarness(probe: ConnectorProbe): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-gmail-capability-probe-'));
  const db = openCoreDatabase(path.join(dir, 'core.db')).db;
  clearGmailAccessToken();
  // Marks Gmail `isConfigured()` true, exactly as Desktop's injected
  // `KARKEDIKHA_CONNECTOR_GMAIL_CREDENTIAL` does at Core spawn once a
  // refresh token is stored — this suite is about the separate live-probe
  // gate, not this one.
  process.env[CONNECTOR_CREDENTIAL_ENV.gmail] = 'test-refresh-token-marker';
  const connectorRegistry = buildConnectorAdapters({
    gmail: {
      probe,
      executor: async (toolName) => ({
        status: 'succeeded', exitCode: 0, output: JSON.stringify({ results: [] }), resultCategory: `${toolName}_succeeded`,
      }),
    },
  });
  const api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
    connectorRegistry,
    coreInfo: () => ({
      coreVersion: '0.1.0',
      apiVersion: 1,
      instanceId: 'test-instance',
      startedAt: new Date().toISOString(),
      nodeVersion: process.version,
      electronVersion: null,
      dataDir: dir,
    }),
    onShutdown: () => {},
  });
  return { dir, db, api, baseUrl: `http://127.0.0.1:${api.port}` };
}

async function stopHarness(h: Harness): Promise<void> {
  await h.api.close();
  h.db.close();
  fs.rmSync(h.dir, { recursive: true, force: true });
  clearGmailAccessToken();
  delete process.env[CONNECTOR_CREDENTIAL_ENV.gmail];
}

function authedFetch(h: Harness, pathAndQuery: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-desktop',
    'Idempotency-Key': crypto.randomUUID(),
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(`${h.baseUrl}${pathAndQuery}`, { ...init, headers });
}

async function gmailStateFromList(h: Harness): Promise<string> {
  const res = await authedFetch(h, '/v1/connectors');
  const body = await res.json() as { connectors: Array<{ id: string; state: string }> };
  return body.connectors.find((c) => c.id === 'gmail')?.state ?? 'missing';
}

let harness: Harness | null = null;
afterEach(async () => {
  if (harness) {
    await stopHarness(harness);
    harness = null;
  }
});

describe('Gmail capability health follows the access-token route (production path)', () => {
  it('the first token push triggers a probe and makes Gmail available', async () => {
    harness = await startHarness(async () => ({ ok: true }));
    const res = await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { connector: { state: string } };
    expect(body.connector.state).toBe('connected');
    // Independent confirmation via the separate catalog read, not just the
    // PATCH response — the health must actually be cached, not one-off.
    expect(await gmailStateFromList(harness)).toBe('connected');
  });

  it('a failed probe returns the truthful blocker, not a generic error', async () => {
    harness = await startHarness(async () => ({ ok: false, reason: 'gmail API quota exceeded' }));
    const res = await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(res.status).toBe(200); // the token push itself still succeeded
    const body = await res.json() as { connector: { state: string; reason: string | null } };
    expect(body.connector.state).toBe('unavailable');
    expect(body.connector.reason).toBe('gmail API quota exceeded');
  });

  it('a refresh (second) token push re-probes without restarting Core', async () => {
    let underlyingOk = false;
    harness = await startHarness(async () => (underlyingOk ? { ok: true } : { ok: false, reason: 'not ready yet' }));
    await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'old', expiresAt: new Date(Date.now() + 1_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(await gmailStateFromList(harness)).toBe('unavailable');

    underlyingOk = true;
    const res = await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'refreshed', expiresAt: new Date(Date.now() + 120_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    const body = await res.json() as { connector: { state: string } };
    expect(body.connector.state).toBe('connected');
    expect(await gmailStateFromList(harness)).toBe('connected');
  });

  it('disconnect clears a previously successful cached probe', async () => {
    harness = await startHarness(async () => (getGmailAccessToken()
      ? { ok: true }
      : { ok: false, reason: 'no Gmail access token available' }));
    await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(await gmailStateFromList(harness)).toBe('connected');

    const delRes = await authedFetch(harness, '/v1/connectors/gmail/access-token', { method: 'DELETE' });
    const delBody = await delRes.json() as { connector: { state: string } };
    expect(delBody.connector.state).not.toBe('connected');
    expect(await gmailStateFromList(harness)).not.toBe('connected');
  });

  it('dispatch after disconnect fails closed', async () => {
    harness = await startHarness(async () => (getGmailAccessToken()
      ? { ok: true }
      : { ok: false, reason: 'no Gmail access token available' }));
    await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    await authedFetch(harness, '/v1/connectors/gmail/permissions', {
      method: 'POST',
      body: JSON.stringify({ tier: 'read', granted: true }),
    });

    const before = await authedFetch(harness, '/v1/capabilities/dispatch', {
      method: 'POST',
      body: JSON.stringify({ correlationId: 'before', toolName: 'gmail_search', arguments: {}, cwd: process.cwd() }),
    });
    const beforeBody = await before.json() as { outcome: string };
    expect(beforeBody.outcome).toBe('executed');

    await authedFetch(harness, '/v1/connectors/gmail/access-token', { method: 'DELETE' });

    const after = await authedFetch(harness, '/v1/capabilities/dispatch', {
      method: 'POST',
      body: JSON.stringify({ correlationId: 'after', toolName: 'gmail_search', arguments: {}, cwd: process.cwd() }),
    });
    const afterBody = await after.json() as { outcome: string; reason?: string };
    expect(afterBody.outcome).toBe('unavailable');
    expect(afterBody.reason).toMatch(/no Gmail access token available/);
  });

  it('never leaks the access token value in any response body, including the retry-probe route', async () => {
    harness = await startHarness(async () => ({ ok: true }));
    const secret = 'super-secret-probe-token-do-not-leak';
    const patchRes = await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: secret, expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(await patchRes.text()).not.toContain(secret);

    const probeRes = await authedFetch(harness, '/v1/connectors/gmail/probe', { method: 'POST' });
    expect(await probeRes.text()).not.toContain(secret);

    const listRes = await authedFetch(harness, '/v1/connectors');
    expect(await listRes.text()).not.toContain(secret);
  });

  it('the explicit retry-probe route re-checks health without a new token push (Gmail diagnostics "Retry")', async () => {
    let underlyingOk = false;
    harness = await startHarness(async () => (underlyingOk ? { ok: true } : { ok: false, reason: 'still failing' }));
    await authedFetch(harness, '/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(await gmailStateFromList(harness)).toBe('unavailable');

    underlyingOk = true;
    const res = await authedFetch(harness, '/v1/connectors/gmail/probe', { method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json() as { connector: { state: string } };
    expect(body.connector.state).toBe('connected');
    expect(getGmailAccessToken()).toBe('tok'); // retry-probe never mutates the token itself
  });

  it('rejects a retry-probe for an unregistered connector id', async () => {
    harness = await startHarness(async () => ({ ok: true }));
    const res = await authedFetch(harness, '/v1/connectors/not_a_real_connector/probe', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});
