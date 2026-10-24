/**
 * `PATCH`/`DELETE /v1/connectors/gmail/access-token` — the loopback push path
 * that lets Desktop refresh Core's in-memory Gmail access token without
 * restarting Core (see `core/runtime/connectors/gmailAccessTokenStore.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { clearGmailAccessToken, getGmailAccessToken, getGmailAccountEmail } from '../runtime/connectors/gmailAccessTokenStore';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;

function authedFetch(pathAndQuery: string, init: RequestInit = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-desktop',
    ...(init.headers as Record<string, string> | undefined),
  };
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-gmail-token-route-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  clearGmailAccessToken();
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
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
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  clearGmailAccessToken();
});

describe('PATCH /v1/connectors/gmail/access-token', () => {
  it('pushes a fresh access token into the in-memory store, readable immediately, no Core restart involved', async () => {
    const expiresAt = new Date(Date.now() + 60_000).toISOString();
    const res = await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'live-access-token', expiresAt, accountEmail: 'me@example.com' }),
    });
    expect(res.status).toBe(200);
    expect(getGmailAccessToken()).toBe('live-access-token');
    expect(getGmailAccountEmail()).toBe('me@example.com');
  });

  it('a second push (refresh) replaces the token in place', async () => {
    const soon = new Date(Date.now() + 1_000).toISOString();
    const later = new Date(Date.now() + 120_000).toISOString();
    await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'old-token', expiresAt: soon, accountEmail: 'me@example.com' }),
    });
    await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'new-token', expiresAt: later, accountEmail: 'me@example.com' }),
    });
    expect(getGmailAccessToken()).toBe('new-token');
  });

  it('rejects a request missing a required field', async () => {
    const res = await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(getGmailAccessToken()).toBeNull();
  });

  it('rejects an unauthenticated request', async () => {
    const res = await fetch(`${baseUrl}/v1/connectors/gmail/access-token`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(res.status).toBe(401);
    expect(getGmailAccessToken()).toBeNull();
  });

  it('never echoes the access token back in the response body', async () => {
    const res = await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'super-secret-token', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    const text = await res.text();
    expect(text).not.toContain('super-secret-token');
  });
});

describe('DELETE /v1/connectors/gmail/access-token', () => {
  it('clears the in-memory token (used on disconnect/revocation)', async () => {
    await authedFetch('/v1/connectors/gmail/access-token', {
      method: 'PATCH',
      body: JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString(), accountEmail: 'me@example.com' }),
    });
    expect(getGmailAccessToken()).toBe('tok');
    const res = await authedFetch('/v1/connectors/gmail/access-token', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(getGmailAccessToken()).toBeNull();
  });

  it('rejects an unauthenticated clear request', async () => {
    const res = await fetch(`${baseUrl}/v1/connectors/gmail/access-token`, { method: 'DELETE' });
    expect(res.status).toBe(401);
  });
});
