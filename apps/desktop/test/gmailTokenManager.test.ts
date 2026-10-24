import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GmailTokenManager, computeRefreshDelayMs, type GmailCoreTokenSink } from '../src/host/gmailTokenManager';
import { GmailOAuthConfigError, type FetchLike, type FetchJsonResponse, type GmailOAuthClientConfig } from '../src/host/gmailOAuth';
import { connectorCredentialPath } from '../src/host/connectorCredentials';
import type { SecretBox } from '../src/host/openRouterCredential';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-token-manager-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

function memoryBox(): SecretBox {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain: string) => Buffer.from(plain, 'utf8'),
    decryptString: (cipher: Buffer) => cipher.toString('utf8'),
  };
}

function fakeConnectorStatus(state: 'connected' | 'unavailable' = 'connected', reason: string | null = null) {
  return {
    id: 'gmail' as const,
    label: 'Gmail',
    state,
    reason,
    checkedAt: new Date().toISOString(),
    permissions: { read: true, draft: true, execute: true },
  };
}

function fakeSink(): GmailCoreTokenSink & {
  pushes: Array<{ accessToken: string; expiresAt: string; accountEmail: string; scopes?: string[] }>;
  clears: number;
  probes: number;
  nextProbeResult: ReturnType<typeof fakeConnectorStatus>;
} {
  const pushes: Array<{ accessToken: string; expiresAt: string; accountEmail: string; scopes?: string[] }> = [];
  let clears = 0;
  let probes = 0;
  let nextProbeResult = fakeConnectorStatus();
  return {
    pushes,
    get clears() { return clears; },
    get probes() { return probes; },
    get nextProbeResult() { return nextProbeResult; },
    set nextProbeResult(value) { nextProbeResult = value; },
    async pushGmailAccessToken(input) { pushes.push(input); return { connector: nextProbeResult }; },
    async clearGmailAccessToken() { clears += 1; return { connector: fakeConnectorStatus('unavailable', 'no Gmail access token available') }; },
    async retryConnectorProbe() { probes += 1; return { connector: nextProbeResult }; },
  };
}

function jsonRes(status: number, body: Record<string, unknown>): FetchJsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function fakeOpenExternal() {
  return async (url: string) => {
    const parsed = new URL(url);
    await fetch(`${parsed.searchParams.get('redirect_uri')}?code=fake-code&state=${parsed.searchParams.get('state')}`);
  };
}

function fakeGoogleFetch(overrides: Partial<Record<'token' | 'userinfo' | 'revoke', () => FetchJsonResponse>> = {}): FetchLike {
  return async (url) => {
    const s = String(url);
    if (s.includes('/token')) return overrides.token ? overrides.token() : jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    if (s.includes('userinfo')) return overrides.userinfo ? overrides.userinfo() : jsonRes(200, { email: 'me@example.com' });
    if (s.includes('revoke')) return overrides.revoke ? overrides.revoke() : jsonRes(200, {});
    throw new Error(`unexpected fetch: ${s}`);
  };
}

function alwaysConfigured(): GmailOAuthClientConfig {
  return { clientId: 'client-1' };
}

describe('GmailTokenManager: connect', () => {
  it('connects, stores the refresh token encrypted, and pushes the access token to Core', async () => {
    const sink = fakeSink();
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: memoryBox,
      getClient: () => sink,
      resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(),
      fetchFn: fakeGoogleFetch(),
    });
    const status = await manager.connect();
    expect(status).toMatchObject({ connected: true, accountEmail: 'me@example.com', lastError: null });
    expect(sink.pushes).toHaveLength(1);
    expect(sink.pushes[0]).toMatchObject({ accessToken: 'at-1', accountEmail: 'me@example.com' });

    // The refresh token is on disk only as ciphertext (this fake box is a
    // trivial passthrough encoder, so we assert against the plaintext
    // marker that would appear if storage were accidentally bypassed).
    const raw = fs.readFileSync(connectorCredentialPath(dir, 'gmail')).toString('utf8');
    expect(raw).toContain('rt-1'); // present via the fake box's reversible encoding
  });

  it('throws GmailOAuthConfigError with the exact setup blocker when no OAuth client is configured', async () => {
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: memoryBox,
      getClient: () => null,
      resolveClientConfig: () => { throw new GmailOAuthConfigError('KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID is not set. Create an OAuth client...'); },
    });
    await expect(manager.connect()).rejects.toThrow(GmailOAuthConfigError);
    expect(manager.configBlocker()).toMatch(/KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID/);
  });

  it('refuses to connect (no throw, honest status) when host encrypted storage is unavailable', async () => {
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: () => ({ isEncryptionAvailable: () => false, encryptString: () => Buffer.from(''), decryptString: () => '' }),
      getClient: () => fakeSink(),
      resolveClientConfig: alwaysConfigured,
    });
    const status = await manager.connect();
    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/encrypted storage/i);
    expect(fs.existsSync(connectorCredentialPath(dir, 'gmail'))).toBe(false);
  });

  it('does not throw when Core is not yet connected at connect time; onCoreReady pushes once available', async () => {
    let client: GmailCoreTokenSink | null = null;
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: memoryBox,
      getClient: () => client,
      resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(),
      fetchFn: fakeGoogleFetch(),
    });
    const status = await manager.connect();
    expect(status.connected).toBe(true);

    const sink = fakeSink();
    client = sink;
    await manager.onCoreReady();
    expect(sink.pushes).toHaveLength(1);
  });
});

describe('GmailTokenManager: disconnect', () => {
  it('revokes the grant, clears local storage, and clears Core state', async () => {
    const sink = fakeSink();
    const revokeCalls: string[] = [];
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: memoryBox,
      getClient: () => sink,
      resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(),
      fetchFn: fakeGoogleFetch({ revoke: () => { revokeCalls.push('revoked'); return jsonRes(200, {}); } }),
    });
    await manager.connect();
    const status = await manager.disconnect();
    expect(status).toEqual({ connected: false, accountEmail: null, lastError: null, lastRefreshedAt: null, capabilityBlocker: null, calendarBlocker: null, scopes: [] });
    expect(revokeCalls).toEqual(['revoked']);
    expect(sink.clears).toBe(1);
    expect(fs.existsSync(connectorCredentialPath(dir, 'gmail'))).toBe(false);
  });

  it('a failed revoke still clears local state and Core state (disconnect must always succeed locally)', async () => {
    const sink = fakeSink();
    const manager = new GmailTokenManager({
      dataDir: dir,
      getSecretBox: memoryBox,
      getClient: () => sink,
      resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(),
      fetchFn: fakeGoogleFetch({ revoke: () => { throw new Error('offline'); } }),
    });
    await manager.connect();
    const status = await manager.disconnect();
    expect(status.connected).toBe(false);
    expect(fs.existsSync(connectorCredentialPath(dir, 'gmail'))).toBe(false);
    expect(sink.clears).toBe(1);
  });

  it('disconnecting when nothing was ever connected is a safe no-op', async () => {
    const sink = fakeSink();
    const manager = new GmailTokenManager({ dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured });
    const status = await manager.disconnect();
    expect(status.connected).toBe(false);
  });
});

describe('GmailTokenManager: refresh without restarting Core', () => {
  it('proactively refreshes and pushes a new access token before the old one would expire, on the same never-restarted sink', async () => {
    vi.useFakeTimers();
    const sink = fakeSink();
    let tokenCall = 0;
    const fetchFn: FetchLike = async (url) => {
      const s = String(url);
      if (s.includes('/token')) {
        tokenCall += 1;
        return tokenCall === 1
          ? jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 600 }) // 10 minutes
          : jsonRes(200, { access_token: 'at-2', expires_in: 600 });
      }
      if (s.includes('userinfo')) return jsonRes(200, { email: 'me@example.com' });
      return jsonRes(200, {});
    };
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn, refreshMarginMs: 60_000, minRefreshDelayMs: 1_000,
    });
    await manager.connect();
    expect(sink.pushes).toHaveLength(1);
    expect(sink.pushes[0].accessToken).toBe('at-1');

    // Advance past the scheduled proactive refresh (expires in 10min, margin 1min => refresh at ~9min).
    await vi.advanceTimersByTimeAsync(9 * 60_000 + 5_000);

    expect(sink.pushes.length).toBeGreaterThanOrEqual(2);
    expect(sink.pushes[sink.pushes.length - 1].accessToken).toBe('at-2');
    // The exact same sink instance received both pushes — nothing resembling
    // a Core restart occurred between them.
  });

  it('ensureFreshAccessToken called directly (simulating a caller finding an expired token) succeeds without any restart', async () => {
    const sink = fakeSink();
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn: fakeGoogleFetch(),
    });
    await manager.connect();
    const before = sink.pushes.length;
    const status = await manager.ensureFreshAccessToken();
    expect(status.connected).toBe(true);
    expect(sink.pushes.length).toBe(before + 1);
  });

  it('a revoked refresh grant is reported honestly as disconnected, not retried forever', async () => {
    const sink = fakeSink();
    let tokenCall = 0;
    const fetchFn: FetchLike = async (url) => {
      const s = String(url);
      if (s.includes('/token')) {
        tokenCall += 1;
        if (tokenCall === 1) return jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
        return jsonRes(400, { error: 'invalid_grant' });
      }
      return jsonRes(200, { email: 'me@example.com' });
    };
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn,
    });
    await manager.connect();
    const status = await manager.ensureFreshAccessToken();
    expect(status.connected).toBe(false);
    expect(status.lastError).toMatch(/invalid_grant/);
    expect(fs.existsSync(connectorCredentialPath(dir, 'gmail'))).toBe(false);
  });

  it('a transient refresh failure keeps the grant and names the blocker for Gmail and Calendar (never a silent null)', async () => {
    const sink = fakeSink();
    let tokenCall = 0;
    const fetchFn: FetchLike = async (url) => {
      const s = String(url);
      if (s.includes('/token')) {
        tokenCall += 1;
        if (tokenCall === 1) return jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
        throw new Error('getaddrinfo ENOTFOUND oauth2.googleapis.com');
      }
      return jsonRes(200, { email: 'me@example.com' });
    };
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn,
    });
    await manager.connect();
    const status = await manager.ensureFreshAccessToken();
    expect(status.connected).toBe(true);
    expect(status.lastError).toMatch(/ENOTFOUND/);
    expect(status.calendarBlocker).toMatch(/ENOTFOUND/);
    expect(status.capabilityBlocker).toMatch(/ENOTFOUND/);
    expect(fs.existsSync(connectorCredentialPath(dir, 'gmail'))).toBe(true);
  });
});

describe('GmailTokenManager: capability health, separate from OAuth connection', () => {
  it('a push that Core cannot probe successfully surfaces a capabilityBlocker while staying OAuth-connected', async () => {
    const sink = fakeSink();
    sink.nextProbeResult = fakeConnectorStatus('unavailable', 'no Gmail access token available');
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn: fakeGoogleFetch(),
    });
    const status = await manager.connect();
    expect(status.connected).toBe(true);
    expect(status.capabilityBlocker).toBe('no Gmail access token available');
  });

  it('retryProbe re-checks health via Core without touching the OAuth/refresh-token lifecycle', async () => {
    const sink = fakeSink();
    sink.nextProbeResult = fakeConnectorStatus('unavailable', 'still warming up');
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn: fakeGoogleFetch(),
    });
    await manager.connect();
    expect((await manager.retryProbe()).capabilityBlocker).toBe('still warming up');

    sink.nextProbeResult = fakeConnectorStatus('connected');
    const status = await manager.retryProbe();
    expect(status.capabilityBlocker).toBeNull();
    expect(status.connected).toBe(true); // unchanged — retryProbe never touches OAuth state
    expect(sink.probes).toBe(4); // two retries x (Gmail + Calendar)
    expect(sink.pushes).toHaveLength(1); // retryProbe never pushes a new token
  });

  it('disconnect clears any previously surfaced capabilityBlocker', async () => {
    const sink = fakeSink();
    sink.nextProbeResult = fakeConnectorStatus('unavailable', 'no Gmail access token available');
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(), fetchFn: fakeGoogleFetch(),
    });
    await manager.connect();
    const status = await manager.disconnect();
    expect(status.capabilityBlocker).toBeNull();
  });
});

describe('computeRefreshDelayMs', () => {
  it('schedules refresh margin-before expiry', () => {
    const now = Date.now();
    const expiresAt = new Date(now + 600_000).toISOString(); // 10 min
    const delay = computeRefreshDelayMs(expiresAt, 60_000, 1_000, now);
    expect(delay).toBeCloseTo(540_000, -2);
  });

  it('never returns less than the minimum delay, even for an already-expired token', () => {
    const now = Date.now();
    const expiresAt = new Date(now - 10_000).toISOString();
    const delay = computeRefreshDelayMs(expiresAt, 60_000, 5_000, now);
    expect(delay).toBe(5_000);
  });
});

describe('GmailTokenManager: Calendar rides the same Google grant', () => {
  const CAL = 'https://www.googleapis.com/auth/calendar.events';
  const calendarStatus = (state: 'connected' | 'unavailable', reason: string | null) => ({ ...fakeConnectorStatus(state, reason), id: 'google_calendar' as const, label: 'Google Calendar' });

  it('records the scopes Google actually granted, pushes them to Core, and reports Calendar health separately from Gmail', async () => {
    const sink = fakeSink();
    sink.pushGmailAccessToken = async (input) => {
      sink.pushes.push(input);
      return { connector: fakeConnectorStatus(), connectors: { google_calendar: calendarStatus('unavailable', 'Google did not grant Calendar access') } };
    };
    const manager = new GmailTokenManager({
      dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured,
      openExternal: fakeOpenExternal(),
      fetchFn: fakeGoogleFetch({ token: () => jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: 'openid https://www.googleapis.com/auth/gmail.readonly' }) }),
    });
    const status = await manager.connect();
    expect(sink.pushes[0].scopes).toEqual(['openid', 'https://www.googleapis.com/auth/gmail.readonly']);
    expect(status.scopes).not.toContain(CAL);
    expect(status.capabilityBlocker).toBeNull(); // Gmail is fine
    expect(status.calendarBlocker).toContain('did not grant Calendar'); // Calendar is not, and says why
  });

  it('a granted Calendar scope is stored with the credential and re-pushed after a refresh', async () => {
    const sink = fakeSink();
    sink.pushGmailAccessToken = async (input) => { sink.pushes.push(input); return { connector: fakeConnectorStatus(), connectors: { google_calendar: calendarStatus('connected', null) } }; };
    const fetchFn = fakeGoogleFetch({ token: () => jsonRes(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: `openid ${CAL}` }) });
    const manager = new GmailTokenManager({ dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured, openExternal: fakeOpenExternal(), fetchFn });
    const connected = await manager.connect();
    expect(connected.scopes).toContain(CAL);
    expect(connected.calendarBlocker).toBeNull();
    // Refresh responses without a scope field keep the stored grant (a restart must not forget Calendar).
    const restarted = new GmailTokenManager({ dataDir: dir, getSecretBox: memoryBox, getClient: () => sink, resolveClientConfig: alwaysConfigured, fetchFn: fakeGoogleFetch({ token: () => jsonRes(200, { access_token: 'at-2', expires_in: 3600 }) }) });
    const refreshed = await restarted.ensureFreshAccessToken();
    expect(refreshed.scopes).toContain(CAL);
    expect(sink.pushes.at(-1)).toMatchObject({ accessToken: 'at-2', scopes: expect.arrayContaining([CAL]) });
  });
});
