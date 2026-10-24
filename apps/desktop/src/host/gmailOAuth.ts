/**
 * Google installed-app OAuth (RFC 8252): system browser + a short-lived
 * loopback HTTP server for the redirect, state validation, and PKCE (S256).
 * Desktop is the only place this flow runs — Core never participates in
 * authentication and never sees a refresh token (see
 * `apps/desktop/src/host/gmailTokenManager.ts`, which owns storage and
 * refresh, and AI_OS_ARCHITECTURE.md "Gmail OAuth (Desktop-owned)").
 *
 * Node-only (no Electron import at module scope) so the PKCE/state/loopback
 * mechanics are unit-testable without Electron; only `defaultOpenExternal`
 * touches `electron.shell`, and only when actually invoked.
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';

export const GMAIL_OAUTH_SCOPES = [
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  // Calendar events only (read/create/update/delete events) — never calendar
  // settings or sharing. Granted in the same sign-in as Gmail.
  'https://www.googleapis.com/auth/calendar.events',
] as const;

export const GOOGLE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

/** Organizing mail (labels, categories, archive) is a separate, opt-in permission requested incrementally, never at first sign-in. */
export const GMAIL_MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const INCREMENTAL_ORGANIZE_SCOPES = ['openid', 'https://www.googleapis.com/auth/userinfo.email', GMAIL_MODIFY_SCOPE] as const;

/** Splits Google's space-separated `scope` token-response field. */
export function parseGrantedScopes(raw: unknown): string[] {
  return typeof raw === 'string' ? raw.split(/\s+/).map((s) => s.trim()).filter(Boolean) : [];
}

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo';

export class GmailOAuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailOAuthConfigError';
  }
}

export class GmailOAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GmailOAuthError';
  }
}

export interface GmailOAuthClientConfig {
  clientId: string;
  /** Google still issues one for a "Desktop app" client type, but PKCE (not
   * this value) is what actually protects the flow — never required. */
  clientSecret?: string;
}

const CLIENT_ID_ENV = 'KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID';
const CLIENT_SECRET_ENV = 'KARKEDIKHA_GMAIL_OAUTH_CLIENT_SECRET';

/** The exact, actionable setup blocker when no OAuth client is configured —
 * never a generic "not configured" — per the requirement that a missing
 * client show precisely what an operator must do. Reads env only; the actual
 * value is never committed to the repository. */
export function resolveGmailOAuthClientConfig(env: NodeJS.ProcessEnv = process.env): GmailOAuthClientConfig {
  const clientId = env[CLIENT_ID_ENV]?.trim();
  if (!clientId) {
    throw new GmailOAuthConfigError(
      `Gmail is not set up: ${CLIENT_ID_ENV} is not set. Create an OAuth client of type "Desktop app" in Google Cloud Console `
      + `(APIs & Services -> Credentials), then set ${CLIENT_ID_ENV} (and, if issued, ${CLIENT_SECRET_ENV}) in this machine's `
      + `credentials configuration before connecting Gmail. Never commit these values to source control.`,
    );
  }
  const clientSecret = env[CLIENT_SECRET_ENV]?.trim();
  return { clientId, clientSecret: clientSecret || undefined };
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateCodeVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

export function computeCodeChallenge(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

export function generateState(): string {
  return base64url(crypto.randomBytes(24));
}

export function buildAuthorizationUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  loginHint?: string;
  /** Overrides the default scope set (used for an incremental, single-permission request). */
  scopes?: readonly string[];
  /** Keep what the user already granted and add only the new scope. */
  includeGrantedScopes?: boolean;
}): string {
  const url = new URL(GOOGLE_AUTH_ENDPOINT);
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', (input.scopes ?? GMAIL_OAUTH_SCOPES).join(' '));
  if (input.includeGrantedScopes) url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', input.state);
  url.searchParams.set('code_challenge', input.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // offline + consent: a refresh token is required every connect (Desktop
  // owns refresh entirely; without this Google omits it on a repeat consent).
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  if (input.loginHint) url.searchParams.set('login_hint', input.loginHint);
  return url.toString();
}

export type LoopbackCallbackOutcome = { ok: true; code: string } | { ok: false; reason: string };

export interface LoopbackServerHandle {
  port: number;
  redirectUri: string;
  result: Promise<LoopbackCallbackOutcome>;
  close(): void;
}

const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60_000;

function callbackPage(input: { ok: boolean; message: string }): string {
  const title = input.ok ? 'Jarvis: Gmail connected' : 'Jarvis: Gmail connection failed';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>`
    + `<body style="font-family:system-ui,sans-serif;padding:2rem;max-width:32rem;margin:0 auto;">`
    + `<h2>${title}</h2><p>${input.message}</p><p>You can close this tab and return to Jarvis.</p></body></html>`;
}

/**
 * Binds an ephemeral loopback port, waits for exactly one `/callback` hit
 * matching `expectedState`, then closes. Never accepts a second callback and
 * never trusts a `state` it did not itself mint moments earlier — the
 * redirect URI is not registered in advance (RFC 8252 loopback exemption),
 * so `state` is the only thing binding this browser round-trip to this one
 * connect attempt.
 */
export function startLoopbackCallbackServer(input: { expectedState: string; timeoutMs?: number }): Promise<LoopbackServerHandle> {
  return new Promise((resolveHandle) => {
    let settled = false;
    let resolveResult!: (outcome: LoopbackCallbackOutcome) => void;
    const result = new Promise<LoopbackCallbackOutcome>((resolve) => { resolveResult = resolve; });

    const finish = (outcome: LoopbackCallbackOutcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult(outcome);
    };

    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage({ ok: false, message: `Google reported: ${error}` }));
        finish({ ok: false, reason: `google returned an error: ${error}` });
        return;
      }
      const state = url.searchParams.get('state');
      if (state !== input.expectedState) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage({ ok: false, message: 'This request could not be verified (state mismatch). Nothing was connected.' }));
        finish({ ok: false, reason: 'state mismatch — refusing to accept this callback' });
        return;
      }
      const code = url.searchParams.get('code');
      if (!code) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage({ ok: false, message: 'No authorization code was returned.' }));
        finish({ ok: false, reason: 'missing authorization code' });
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(callbackPage({ ok: true, message: 'Gmail was connected successfully.' }));
      finish({ ok: true, code });
    });

    const timer = setTimeout(() => {
      finish({ ok: false, reason: 'timed out waiting for the browser to complete sign-in' });
      server.close();
    }, input.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS);
    timer.unref?.();

    server.on('close', () => finish({ ok: false, reason: 'connection cancelled' }));
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      resolveHandle({
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        result,
        close: () => server.close(),
      });
    });
  });
}

export type OpenExternal = (url: string) => Promise<void> | void;

/** Only touches `electron` when actually called — keeps this module
 * importable from plain Node test contexts. */
export function defaultOpenExternal(): OpenExternal {
  return async (url: string) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { shell } = require('electron') as { shell: { openExternal(url: string): Promise<void> } };
    await shell.openExternal(url);
  };
}

export interface FetchJsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<Record<string, unknown>>;
}
export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<FetchJsonResponse>;

function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.set(key, value);
  }
  return params.toString();
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresInSeconds: number;
  /** Scopes Google actually granted (the user can untick some on the consent screen). */
  scopes: string[];
}

export async function exchangeCodeForTokens(input: {
  clientId: string;
  clientSecret?: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  fetchFn?: FetchLike;
}): Promise<ExchangedTokens> {
  const fetchFn = input.fetchFn ?? (fetch as unknown as FetchLike);
  const res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    }),
  });
  const data = await res.json();
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new GmailOAuthError(`token exchange failed: ${String(data.error ?? res.status)} ${String(data.error_description ?? '')}`.trim());
  }
  return {
    accessToken: data.access_token,
    refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    scopes: parseGrantedScopes(data.scope),
  };
}

export interface RefreshedAccessToken {
  accessToken: string;
  expiresInSeconds: number;
  /** Present when Google echoes the grant on refresh; otherwise the caller keeps the stored scopes. */
  scopes: string[] | null;
}

export async function refreshAccessToken(input: {
  clientId: string;
  clientSecret?: string;
  refreshToken: string;
  fetchFn?: FetchLike;
}): Promise<RefreshedAccessToken> {
  const fetchFn = input.fetchFn ?? (fetch as unknown as FetchLike);
  const res = await fetchFn(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      refresh_token: input.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  if (!res.ok || typeof data.access_token !== 'string') {
    throw new GmailOAuthError(`access token refresh failed: ${String(data.error ?? res.status)} ${String(data.error_description ?? '')}`.trim());
  }
  return {
    accessToken: data.access_token,
    expiresInSeconds: typeof data.expires_in === 'number' ? data.expires_in : 3600,
    scopes: typeof data.scope === 'string' ? parseGrantedScopes(data.scope) : null,
  };
}

export async function fetchAccountEmail(input: { accessToken: string; fetchFn?: FetchLike }): Promise<string> {
  const fetchFn = input.fetchFn ?? (fetch as unknown as FetchLike);
  const res = await fetchFn(GOOGLE_USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${input.accessToken}` } });
  const data = await res.json();
  if (!res.ok || typeof data.email !== 'string' || !data.email) {
    throw new GmailOAuthError('could not resolve the connected Google account email');
  }
  return data.email;
}

/** Best-effort: revocation failing (e.g. already revoked, network down) must
 * never block local disconnect — the caller always clears local state
 * regardless of this result. */
export async function revokeGoogleToken(input: { token: string; fetchFn?: FetchLike }): Promise<{ ok: boolean; reason?: string }> {
  const fetchFn = input.fetchFn ?? (fetch as unknown as FetchLike);
  try {
    const res = await fetchFn(`${GOOGLE_REVOKE_ENDPOINT}?token=${encodeURIComponent(input.token)}`, { method: 'POST' });
    if (res.ok) return { ok: true };
    const data = await res.json().catch(() => ({}) as Record<string, unknown>);
    return { ok: false, reason: String(data.error ?? res.status) };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

export interface GmailOAuthConnectResult {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  accountEmail: string;
  scopes: string[];
}

/** The full connect round-trip: PKCE + state, loopback server, system
 * browser, code exchange, and account-identity resolution. Throws
 * `GmailOAuthConfigError` (exact setup blocker) or `GmailOAuthError`
 * (anything else) — never returns a partial/best-effort result. */
export async function runGmailOAuthConnectFlow(input: {
  client: GmailOAuthClientConfig;
  openExternal?: OpenExternal;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  /** Aborting closes the loopback listener, so the pending sign-in ends as "connection cancelled". */
  signal?: AbortSignal;
  /** Incremental consent: request only these scopes, keeping earlier grants. */
  scopes?: readonly string[];
  includeGrantedScopes?: boolean;
  loginHint?: string;
  /** Refuse the result when the browser signed into a different Google account. */
  expectedAccountEmail?: string;
}): Promise<GmailOAuthConnectResult> {
  const verifier = generateCodeVerifier();
  const challenge = computeCodeChallenge(verifier);
  const state = generateState();
  const server = await startLoopbackCallbackServer({ expectedState: state, timeoutMs: input.timeoutMs });
  const onAbort = () => server.close();
  if (input.signal?.aborted) server.close();
  else input.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const authorizationUrl = buildAuthorizationUrl({
      clientId: input.client.clientId,
      redirectUri: server.redirectUri,
      state,
      codeChallenge: challenge,
      ...(input.scopes ? { scopes: input.scopes } : {}),
      ...(input.includeGrantedScopes ? { includeGrantedScopes: true } : {}),
      ...(input.loginHint ? { loginHint: input.loginHint } : {}),
    });
    await (input.openExternal ?? defaultOpenExternal())(authorizationUrl);
    const outcome = await server.result;
    if (!outcome.ok) throw new GmailOAuthError(outcome.reason);
    const tokens = await exchangeCodeForTokens({
      clientId: input.client.clientId,
      clientSecret: input.client.clientSecret,
      code: outcome.code,
      codeVerifier: verifier,
      redirectUri: server.redirectUri,
      fetchFn: input.fetchFn,
    });
    if (!tokens.refreshToken) {
      throw new GmailOAuthError(
        'Google did not return a refresh token for this connection. If Gmail was connected before, revoke the prior grant at '
        + 'https://myaccount.google.com/permissions and try connecting again.',
      );
    }
    const accountEmail = await fetchAccountEmail({ accessToken: tokens.accessToken, fetchFn: input.fetchFn });
    if (input.expectedAccountEmail && accountEmail.toLowerCase() !== input.expectedAccountEmail.toLowerCase()) {
      throw new GmailOAuthError(`That sign-in was for ${accountEmail}, not ${input.expectedAccountEmail}. Nothing was changed; sign in with the connected account.`);
    }
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString(),
      accountEmail,
      scopes: tokens.scopes,
    };
  } finally {
    input.signal?.removeEventListener('abort', onAbort);
    server.close();
  }
}

/** The scope set for the incremental inbox-organization request. */
export function inboxOrganizationScopes(): readonly string[] {
  return INCREMENTAL_ORGANIZE_SCOPES;
}
