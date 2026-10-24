import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  clearStoredGoogleOAuthClient,
  loadStoredGoogleOAuthClient,
  maskGoogleClientId,
  parseGoogleClientSecretJson,
  resolveGoogleOAuthClient,
  storeGoogleOAuthClient,
  storedGoogleOAuthClientPresent,
  validateGoogleOAuthClientInput,
  GoogleOAuthClientError,
} from '../src/host/googleOAuthClientStore';
import { classifyGoogleError } from '../src/host/googleErrorGuide';
import { GmailOAuthConfigError, runGmailOAuthConnectFlow } from '../src/host/gmailOAuth';
import type { SecretBox } from '../src/host/openRouterCredential';

const VALID_ID = '1234567890-abcdefghij.apps.googleusercontent.com';

/** Reversible stand-in for Electron safeStorage: proves plaintext is not what lands on disk. */
function fakeBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').reverse().toString('base64')}`, 'utf8'),
    decryptString: (cipher: Buffer) => {
      const text = cipher.toString('utf8');
      if (!text.startsWith('enc:')) throw new Error('not encrypted');
      return Buffer.from(Buffer.from(text.slice(4), 'base64').reverse()).toString('utf8');
    },
  } as SecretBox;
}

describe('Google OAuth client input validation', () => {
  it('accepts a real-looking client id with or without a secret', () => {
    expect(validateGoogleOAuthClientInput(`  ${VALID_ID} `, '')).toEqual({ clientId: VALID_ID, clientSecret: undefined });
    expect(validateGoogleOAuthClientInput(VALID_ID, 'GOCSPX-abcdefghijkl').clientSecret).toBe('GOCSPX-abcdefghijkl');
  });

  it('rejects empty, malformed and secret-looking values with an actionable message', () => {
    expect(() => validateGoogleOAuthClientInput('', '')).toThrow(GoogleOAuthClientError);
    expect(() => validateGoogleOAuthClientInput('my-project-123', '')).toThrow(/apps\.googleusercontent\.com/);
    expect(() => validateGoogleOAuthClientInput('GOCSPX-notAClientIdAtAll', '')).toThrow(/Client ID/);
    expect(() => validateGoogleOAuthClientInput(VALID_ID, 'short')).toThrow(/secret/i);
    expect(() => validateGoogleOAuthClientInput(VALID_ID, 'has space inside secret')).toThrow(/secret/i);
  });
});

describe('Google OAuth client store', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-google-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('stores encrypted (never plaintext) and round-trips', () => {
    storeGoogleOAuthClient(dir, { clientId: VALID_ID, clientSecret: 'GOCSPX-abcdefghijkl' }, fakeBox());
    expect(storedGoogleOAuthClientPresent(dir)).toBe(true);
    const onDisk = fs.readFileSync(path.join(dir, 'google.oauth-client.credential.bin'), 'utf8');
    expect(onDisk).not.toContain(VALID_ID);
    expect(onDisk).not.toContain('GOCSPX');
    expect(loadStoredGoogleOAuthClient(dir, fakeBox())).toEqual({ clientId: VALID_ID, clientSecret: 'GOCSPX-abcdefghijkl' });
  });

  it('refuses to store when encrypted storage is unavailable', () => {
    expect(() => storeGoogleOAuthClient(dir, { clientId: VALID_ID }, fakeBox(false))).toThrow(/encrypted storage/i);
    expect(storedGoogleOAuthClientPresent(dir)).toBe(false);
  });

  it('returns null for a missing, corrupt or undecryptable file instead of throwing', () => {
    expect(loadStoredGoogleOAuthClient(dir, fakeBox())).toBeNull();
    fs.writeFileSync(path.join(dir, 'google.oauth-client.credential.bin'), 'garbage');
    expect(loadStoredGoogleOAuthClient(dir, fakeBox())).toBeNull();
    expect(loadStoredGoogleOAuthClient(dir, null)).toBeNull();
  });

  it('prefers the environment, falls back to the saved client, and otherwise explains the setup', () => {
    expect(() => resolveGoogleOAuthClient(dir, fakeBox(), {})).toThrow(GmailOAuthConfigError);
    storeGoogleOAuthClient(dir, { clientId: VALID_ID }, fakeBox());
    expect(resolveGoogleOAuthClient(dir, fakeBox(), {})).toEqual({ config: { clientId: VALID_ID, clientSecret: undefined }, source: 'saved' });
    const fromEnv = resolveGoogleOAuthClient(dir, fakeBox(), { KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID: '999999-envclient.apps.googleusercontent.com' });
    expect(fromEnv.source).toBe('environment');
    clearStoredGoogleOAuthClient(dir);
    expect(storedGoogleOAuthClientPresent(dir)).toBe(false);
    clearStoredGoogleOAuthClient(dir); // idempotent
  });

  it('uses an app-owned bundled client when nothing else is set, and the saved/env client still wins', () => {
    const resources = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-res-'));
    fs.writeFileSync(path.join(resources, 'google-oauth-client.json'), JSON.stringify({ installed: { client_id: VALID_ID, client_secret: 'GOCSPX-abcdefgh' } }));
    expect(resolveGoogleOAuthClient(dir, fakeBox(), {}, [resources])).toEqual({ config: { clientId: VALID_ID, clientSecret: 'GOCSPX-abcdefgh' }, source: 'bundled' });
    storeGoogleOAuthClient(dir, { clientId: '999999-savedclient.apps.googleusercontent.com' }, fakeBox());
    expect(resolveGoogleOAuthClient(dir, fakeBox(), {}, [resources]).source).toBe('saved');
    clearStoredGoogleOAuthClient(dir);
    fs.writeFileSync(path.join(resources, 'google-oauth-client.json'), '{not json');
    expect(() => resolveGoogleOAuthClient(dir, fakeBox(), {}, [resources])).toThrow(GmailOAuthConfigError);
  });

  it('masks the client id for display', () => {
    expect(maskGoogleClientId(VALID_ID)).toBe('1234…hij.apps.googleusercontent.com');
    expect(maskGoogleClientId(VALID_ID)).not.toContain('abcdefg');
  });
});

describe('Google error recovery guide', () => {
  const code = (message: string) => classifyGoogleError(message)?.code;

  it('returns null when there is nothing wrong', () => {
    expect(classifyGoogleError(null)).toBeNull();
    expect(classifyGoogleError('  ')).toBeNull();
  });

  it('maps the real failure texts to specific recovery steps', () => {
    expect(code('Google is not set up yet: add your OAuth Client ID in Connections')).toBe('not_configured');
    expect(code('token exchange failed: invalid_client The OAuth client was not found.')).toBe('invalid_client');
    expect(code('google returned an error: access_denied')).toBe('access_denied');
    expect(code('timed out waiting for the browser to complete sign-in')).toBe('timed_out');
    expect(code('connection cancelled')).toBe('cancelled');
    expect(code('state mismatch — refusing to accept this callback')).toBe('state_mismatch');
    expect(code('Google did not return a refresh token for this connection.')).toBe('no_refresh_token');
    expect(code('access token refresh failed: invalid_grant Token has been expired or revoked.')).toBe('grant_revoked');
    expect(code('gws accessNotConfigured (403): Gmail API has not been used in project 123 before')).toBe('api_disabled');
    expect(code('host encrypted storage is not available; refusing to connect Gmail')).toBe('storage_unavailable');
    expect(code('Core is not reachable right now; Gmail capability will be re-checked once it reconnects')).toBe('core_unreachable');
    expect(code('something nobody anticipated')).toBe('unknown');
  });

  it('does not mistake a missing helper binary for a missing OAuth client', () => {
    expect(code('gws binary is not staged (KARKEDIKHA_GWS_BIN is not set)')).toBe('helper_missing');
    expect(code("gws binary digest mismatch at 'C:\\x\\gws.exe' (expected abc) — refusing to run an unpinned executable")).toBe('helper_tampered');
  });

  it('links to the exact Google page where one exists', () => {
    expect(classifyGoogleError('access_denied')?.link?.url).toContain('console.cloud.google.com/apis/credentials/consent');
    expect(classifyGoogleError('accessNotConfigured')?.link?.url).toContain('gmail.googleapis.com');
    expect(classifyGoogleError('timed out')?.link).toBeUndefined();
  });
});

describe('cancelling a pending Google sign-in', () => {
  it('aborting ends the browser wait as a cancellation and frees the loopback listener', async () => {
    const abort = new AbortController();
    let opened = '';
    const flow = runGmailOAuthConnectFlow({
      client: { clientId: VALID_ID },
      openExternal: (url: string) => { opened = url; },
      signal: abort.signal,
      timeoutMs: 30_000,
    });
    // The sign-in URL has been handed to the browser; the user closes the tab and presses Cancel.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(opened).toContain('accounts.google.com');
    abort.abort();
    await expect(flow).rejects.toThrow(/connection cancelled/);
  });

  it('an already-aborted signal cancels immediately', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(runGmailOAuthConnectFlow({ client: { clientId: VALID_ID }, openExternal: () => {}, signal: abort.signal, timeoutMs: 30_000 }))
      .rejects.toThrow(/connection cancelled/);
  });
});

describe('importing the OAuth client from the "Download JSON" file', () => {
  const desktopFile = (extra: Record<string, unknown> = {}) => JSON.stringify({ installed: { client_id: VALID_ID, client_secret: 'GOCSPX-abcdefghijkl', project_id: 'p', auth_uri: 'https://accounts.google.com/o/oauth2/auth', ...extra } });

  it('reads a Desktop app client file', () => {
    expect(parseGoogleClientSecretJson(desktopFile())).toEqual({ clientId: VALID_ID, clientSecret: 'GOCSPX-abcdefghijkl' });
    expect(parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: VALID_ID } }))).toEqual({ clientId: VALID_ID, clientSecret: undefined });
  });

  it('refuses Web clients, other files and malformed input with plain explanations, never echoing the file', () => {
    expect(() => parseGoogleClientSecretJson(JSON.stringify({ web: { client_id: VALID_ID, client_secret: 'GOCSPX-abcdefghijkl' } }))).toThrow(/Desktop app/);
    expect(() => parseGoogleClientSecretJson('{ not json')).toThrow(/not valid JSON/);
    expect(() => parseGoogleClientSecretJson(JSON.stringify({ hello: 'world' }))).toThrow(/not a Google OAuth client file/);
    expect(() => parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: 'nope', client_secret: 'GOCSPX-supersecretvalue' } }))).toThrow(/Client ID/);
    try { parseGoogleClientSecretJson(JSON.stringify({ installed: { client_id: 'nope', client_secret: 'GOCSPX-supersecretvalue' } })); } catch (e) { expect(String((e as Error).message)).not.toContain('supersecret'); }
  });
});
