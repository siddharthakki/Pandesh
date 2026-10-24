import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import {
  GmailOAuthConfigError,
  GmailOAuthError,
  buildAuthorizationUrl,
  computeCodeChallenge,
  exchangeCodeForTokens,
  fetchAccountEmail,
  generateCodeVerifier,
  generateState,
  refreshAccessToken,
  resolveGmailOAuthClientConfig,
  revokeGoogleToken,
  runGmailOAuthConnectFlow,
  startLoopbackCallbackServer,
  type FetchJsonResponse,
  type FetchLike,
} from '../src/host/gmailOAuth';

function fakeJsonResponse(status: number, body: Record<string, unknown>): FetchJsonResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('gmailOAuth: PKCE and state', () => {
  it('generates a URL-safe code verifier with no padding', () => {
    const verifier = generateCodeVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier.length).toBeGreaterThan(32);
  });

  it('the code challenge is a deterministic S256 hash of the verifier', () => {
    const verifier = 'fixed-test-verifier-value';
    const challenge1 = computeCodeChallenge(verifier);
    const challenge2 = computeCodeChallenge(verifier);
    expect(challenge1).toBe(challenge2);
    expect(challenge1).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('two calls to generateState produce different values', () => {
    expect(generateState()).not.toBe(generateState());
  });

  it('buildAuthorizationUrl includes PKCE, state, minimal scopes, and offline+consent', () => {
    const url = new URL(buildAuthorizationUrl({
      clientId: 'client-1', redirectUri: 'http://127.0.0.1:12345/callback', state: 'state-1', codeChallenge: 'challenge-1',
    }));
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:12345/callback');
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('code_challenge')).toBe('challenge-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope).toContain('gmail.readonly');
    expect(scope).toContain('gmail.compose');
    // Minimal scopes only — never delete/trash/labels/settings/full modify.
    expect(scope).not.toContain('gmail.modify');
    expect(scope).not.toContain('gmail.settings');
    expect(scope).not.toContain('gmail.labels');
  });
});

describe('gmailOAuth: resolveGmailOAuthClientConfig — exact setup blocker', () => {
  it('throws GmailOAuthConfigError naming the exact env var when unset', () => {
    expect(() => resolveGmailOAuthClientConfig({})).toThrow(GmailOAuthConfigError);
    try {
      resolveGmailOAuthClientConfig({});
    } catch (err) {
      expect(err).toBeInstanceOf(GmailOAuthConfigError);
      expect((err as Error).message).toContain('KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID');
      expect((err as Error).message).toMatch(/Desktop app/);
    }
  });

  it('returns the client id and optional secret when set', () => {
    const config = resolveGmailOAuthClientConfig({ KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID: 'abc', KARKEDIKHA_GMAIL_OAUTH_CLIENT_SECRET: 'shh' });
    expect(config).toEqual({ clientId: 'abc', clientSecret: 'shh' });
  });

  it('omits the secret field when not set (many Desktop clients have none)', () => {
    const config = resolveGmailOAuthClientConfig({ KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID: 'abc' });
    expect(config.clientSecret).toBeUndefined();
  });
});

describe('gmailOAuth: loopback callback server', () => {
  it('accepts a callback whose state matches and resolves with the code', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    try {
      const res = await fetch(`${server.redirectUri}?code=auth-code-1&state=expected-state`);
      expect(res.status).toBe(200);
      const outcome = await server.result;
      expect(outcome).toEqual({ ok: true, code: 'auth-code-1' });
    } finally {
      server.close();
    }
  });

  it('refuses a callback whose state does not match (state/PKCE validation)', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    try {
      await fetch(`${server.redirectUri}?code=auth-code-1&state=wrong-state`);
      const outcome = await server.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/state mismatch/i);
    } finally {
      server.close();
    }
  });

  it('reports Google-side errors distinctly (e.g. user denied consent)', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    try {
      await fetch(`${server.redirectUri}?error=access_denied&state=expected-state`);
      const outcome = await server.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/access_denied/);
    } finally {
      server.close();
    }
  });

  it('refuses a callback with a matching state but no code', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    try {
      await fetch(`${server.redirectUri.replace('/callback', '/callback')}?state=expected-state`);
      const outcome = await server.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/missing authorization code/);
    } finally {
      server.close();
    }
  });

  it('404s any path other than /callback, without settling the result', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/other`);
      expect(res.status).toBe(404);
      const raced = await Promise.race([server.result, new Promise((r) => setTimeout(() => r('still-pending'), 50))]);
      expect(raced).toBe('still-pending');
    } finally {
      server.close();
    }
  });

  it('times out and resolves not-ok if the browser never completes sign-in', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state', timeoutMs: 20 });
    try {
      const outcome = await server.result;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toMatch(/timed out/i);
    } finally {
      server.close();
    }
  });

  it('closing the server before any callback resolves as cancelled (user/process cancellation)', async () => {
    const server = await startLoopbackCallbackServer({ expectedState: 'expected-state' });
    server.close();
    const outcome = await server.result;
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toMatch(/cancelled/i);
  });

  it('binds to an OS-assigned ephemeral loopback port, never a fixed one', async () => {
    const a = await startLoopbackCallbackServer({ expectedState: 's1' });
    const b = await startLoopbackCallbackServer({ expectedState: 's2' });
    try {
      expect(a.port).not.toBe(b.port);
      expect(a.port).toBeGreaterThan(0);
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('gmailOAuth: token exchange, refresh, userinfo, revoke', () => {
  it('exchangeCodeForTokens sends PKCE verifier and parses a successful response', async () => {
    let capturedBody = '';
    const fetchFn: FetchLike = async (_url, init) => {
      capturedBody = init?.body ?? '';
      return fakeJsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
    };
    const tokens = await exchangeCodeForTokens({
      clientId: 'client-1', code: 'code-1', codeVerifier: 'verifier-1', redirectUri: 'http://127.0.0.1:1/callback', fetchFn,
    });
    expect(tokens).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresInSeconds: 3600, scopes: [] });
    expect(capturedBody).toContain('code_verifier=verifier-1');
    expect(capturedBody).toContain('grant_type=authorization_code');
  });

  it('exchangeCodeForTokens throws GmailOAuthError on a non-ok response, without leaking secrets in the message shape', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(400, { error: 'invalid_grant', error_description: 'Bad code' });
    await expect(exchangeCodeForTokens({
      clientId: 'client-1', code: 'bad', codeVerifier: 'v', redirectUri: 'http://127.0.0.1:1/callback', fetchFn,
    })).rejects.toThrow(GmailOAuthError);
  });

  it('refreshAccessToken returns a new access token without requiring or returning a refresh token', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(200, { access_token: 'at-2', expires_in: 1800 });
    const refreshed = await refreshAccessToken({ clientId: 'client-1', refreshToken: 'rt-1', fetchFn });
    expect(refreshed).toEqual({ accessToken: 'at-2', expiresInSeconds: 1800, scopes: null });
  });

  it('refreshAccessToken throws on a revoked/invalid refresh token', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(400, { error: 'invalid_grant' });
    await expect(refreshAccessToken({ clientId: 'client-1', refreshToken: 'revoked', fetchFn })).rejects.toThrow(GmailOAuthError);
  });

  it('fetchAccountEmail resolves the connected account identity', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(200, { email: 'me@example.com', email_verified: true });
    const email = await fetchAccountEmail({ accessToken: 'at-1', fetchFn });
    expect(email).toBe('me@example.com');
  });

  it('fetchAccountEmail throws if no email is returned', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(200, {});
    await expect(fetchAccountEmail({ accessToken: 'at-1', fetchFn })).rejects.toThrow(GmailOAuthError);
  });

  it('revokeGoogleToken never throws — a failed revoke is reported, not raised, so disconnect can still proceed locally', async () => {
    const fetchFn: FetchLike = async () => { throw new Error('network down'); };
    const result = await revokeGoogleToken({ token: 'rt-1', fetchFn });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/network down/);
  });

  it('revokeGoogleToken reports success on a 200', async () => {
    const fetchFn: FetchLike = async () => fakeJsonResponse(200, {});
    const result = await revokeGoogleToken({ token: 'rt-1', fetchFn });
    expect(result.ok).toBe(true);
  });
});

describe('gmailOAuth: full connect round-trip', () => {
  it('runs the whole flow end to end against a fake browser and fake Google endpoints', async () => {
    let openedUrl: string | undefined;
    const openExternal = async (url: string) => {
      openedUrl = url;
      const parsed = new URL(url);
      const redirectUri = parsed.searchParams.get('redirect_uri')!;
      const state = parsed.searchParams.get('state')!;
      await fetch(`${redirectUri}?code=fake-code&state=${state}`);
    };
    const fetchFn: FetchLike = async (url) => {
      if (String(url).includes('/token')) return fakeJsonResponse(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600 });
      if (String(url).includes('userinfo')) return fakeJsonResponse(200, { email: 'me@example.com' });
      throw new Error(`unexpected fetch to ${url}`);
    };
    const result = await runGmailOAuthConnectFlow({
      client: { clientId: 'client-1' },
      openExternal,
      fetchFn,
    });
    expect(result).toEqual({ accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: expect.any(String), accountEmail: 'me@example.com', scopes: [] });
    expect(openedUrl).toContain('code_challenge=');
  });

  it('throws if Google omits a refresh token (must re-consent, never silently proceed without one)', async () => {
    const openExternal = async (url: string) => {
      const parsed = new URL(url);
      await fetch(`${parsed.searchParams.get('redirect_uri')}?code=fake-code&state=${parsed.searchParams.get('state')}`);
    };
    const fetchFn: FetchLike = async (url) => {
      if (String(url).includes('/token')) return fakeJsonResponse(200, { access_token: 'at-1', expires_in: 3600 }); // no refresh_token
      return fakeJsonResponse(200, { email: 'me@example.com' });
    };
    await expect(runGmailOAuthConnectFlow({ client: { clientId: 'client-1' }, openExternal, fetchFn })).rejects.toThrow(GmailOAuthError);
  });

  it('throws when the user denies consent in the browser', async () => {
    const openExternal = async (url: string) => {
      const parsed = new URL(url);
      await fetch(`http://127.0.0.1:${parsed.searchParams.get('redirect_uri')!.match(/:(\d+)/)![1]}/callback?error=access_denied&state=${parsed.searchParams.get('state')}`);
    };
    await expect(runGmailOAuthConnectFlow({ client: { clientId: 'client-1' }, openExternal, timeoutMs: 2000 })).rejects.toThrow(GmailOAuthError);
  });
});
