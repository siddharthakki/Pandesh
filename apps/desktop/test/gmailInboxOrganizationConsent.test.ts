import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GmailTokenManager, type GmailCoreTokenSink } from '../src/host/gmailTokenManager';
import { GMAIL_MODIFY_SCOPE, GMAIL_OAUTH_SCOPES, buildAuthorizationUrl, type FetchJsonResponse, type FetchLike } from '../src/host/gmailOAuth';
import type { SecretBox } from '../src/host/openRouterCredential';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-organize-consent-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const box = (): SecretBox => ({ isEncryptionAvailable: () => true, encryptString: (p: string) => Buffer.from(p, 'utf8'), decryptString: (c: Buffer) => c.toString('utf8') });
const res = (body: Record<string, unknown>, status = 200): FetchJsonResponse => ({ ok: status < 300, status, json: async () => body });

function sink(): GmailCoreTokenSink & { pushes: Array<{ scopes?: string[] }> } {
  const status = { id: 'gmail' as const, label: 'Gmail', state: 'connected' as const, reason: null, checkedAt: new Date().toISOString(), permissions: { read: true, draft: true, execute: true } };
  const pushes: Array<{ scopes?: string[] }> = [];
  return {
    pushes,
    async pushGmailAccessToken(input) { pushes.push(input); return { connector: status }; },
    async clearGmailAccessToken() { return { connector: status }; },
    async retryConnectorProbe() { return { connector: status }; },
  };
}

/** Plays Google: records every authorization URL and answers the token exchange with a configurable scope grant. */
function google(opts: { grantScope: string; email?: string }) {
  const authUrls: URL[] = [];
  const fetchFn: FetchLike = async (url) => {
    const s = String(url);
    if (s.includes('/token')) return res({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600, scope: opts.grantScope });
    if (s.includes('userinfo')) return res({ email: opts.email ?? 'me@example.com' });
    return res({});
  };
  const openExternal = async (url: string) => {
    const parsed = new URL(url);
    authUrls.push(parsed);
    await fetch(`${parsed.searchParams.get('redirect_uri')}?code=c&state=${parsed.searchParams.get('state')}`);
  };
  return { authUrls, fetchFn, openExternal };
}

async function connectedManager(first: ReturnType<typeof google>, second: ReturnType<typeof google>, core: ReturnType<typeof sink>) {
  let phase = 0;
  const manager = new GmailTokenManager({
    dataDir: dir,
    getSecretBox: box,
    getClient: () => core,
    resolveClientConfig: () => ({ clientId: 'client-1' }),
    openExternal: (url) => (phase === 0 ? first : second).openExternal(url),
    fetchFn: (url, init) => (phase === 0 ? first : second).fetchFn(url, init),
  });
  await manager.connect();
  phase = 1;
  return manager;
}

describe('inbox organization is an incremental, opt-in permission', () => {
  it('the first sign-in never asks for gmail.modify', () => {
    expect(GMAIL_OAUTH_SCOPES).not.toContain(GMAIL_MODIFY_SCOPE);
  });

  it('asks only for gmail.modify, keeps earlier grants, hints the account, and ends with the union of scopes', async () => {
    const baseScopes = GMAIL_OAUTH_SCOPES.join(' ');
    const first = google({ grantScope: baseScopes });
    const second = google({ grantScope: `${baseScopes} ${GMAIL_MODIFY_SCOPE}` });
    const core = sink();
    const manager = await connectedManager(first, second, core);
    expect(manager.getStatus().scopes).not.toContain(GMAIL_MODIFY_SCOPE);

    const status = await manager.grantInboxOrganization();
    const requested = second.authUrls[0].searchParams;
    expect(requested.get('scope')?.split(' ')).toEqual(['openid', 'https://www.googleapis.com/auth/userinfo.email', GMAIL_MODIFY_SCOPE]);
    expect(requested.get('include_granted_scopes')).toBe('true');
    expect(requested.get('login_hint')).toBe('me@example.com');
    expect(status.scopes).toContain(GMAIL_MODIFY_SCOPE);
    expect(status.scopes).toContain('https://www.googleapis.com/auth/calendar.events');
    expect(core.pushes.at(-1)?.scopes).toContain(GMAIL_MODIFY_SCOPE);
  });

  it('fails honestly when Google did not actually grant it, and leaves the sign-in untouched', async () => {
    const baseScopes = GMAIL_OAUTH_SCOPES.join(' ');
    const manager = await connectedManager(google({ grantScope: baseScopes }), google({ grantScope: 'openid https://www.googleapis.com/auth/userinfo.email' }), sink());
    await expect(manager.grantInboxOrganization()).rejects.toThrow(/did not grant the inbox organization permission/);
    expect(manager.getStatus().connected).toBe(true);
    expect(manager.getStatus().scopes).not.toContain(GMAIL_MODIFY_SCOPE);
  });

  it('refuses a sign-in for a different Google account', async () => {
    const baseScopes = GMAIL_OAUTH_SCOPES.join(' ');
    const manager = await connectedManager(google({ grantScope: baseScopes }), google({ grantScope: `${baseScopes} ${GMAIL_MODIFY_SCOPE}`, email: 'someone.else@example.com' }), sink());
    await expect(manager.grantInboxOrganization()).rejects.toThrow(/not me@example.com/);
    expect(manager.getStatus().accountEmail).toBe('me@example.com');
    expect(manager.getStatus().scopes).not.toContain(GMAIL_MODIFY_SCOPE);
  });

  it('needs an existing connection first', async () => {
    const manager = new GmailTokenManager({ dataDir: dir, getSecretBox: box, getClient: () => null, resolveClientConfig: () => ({ clientId: 'c' }) });
    await expect(manager.grantInboxOrganization()).rejects.toThrow(/Connect Google first/);
  });

  it('builds a scoped authorization URL only when asked to', () => {
    const base = { clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', state: 's', codeChallenge: 'x' };
    expect(new URL(buildAuthorizationUrl(base)).searchParams.get('include_granted_scopes')).toBeNull();
    const scoped = new URL(buildAuthorizationUrl({ ...base, scopes: [GMAIL_MODIFY_SCOPE], includeGrantedScopes: true }));
    expect(scoped.searchParams.get('scope')).toBe(GMAIL_MODIFY_SCOPE);
    expect(scoped.searchParams.get('include_granted_scopes')).toBe('true');
  });
});
