/**
 * The operator's own Google OAuth "Desktop app" client (client id + optional
 * secret), entered once in Connections → Google Services and kept encrypted
 * with the same host `safeStorage` seam as every other credential — so a
 * normally launched Panda works without anyone editing environment variables.
 *
 * The environment variables (`KARKEDIKHA_GMAIL_OAUTH_CLIENT_ID` /
 * `KARKEDIKHA_GMAIL_OAUTH_CLIENT_SECRET`) still win when set, so existing
 * setups and tests are unaffected. Plaintext never leaves this module except
 * as the returned `GmailOAuthClientConfig` handed to the OAuth flow; the
 * renderer only ever sees a masked hint.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GmailOAuthConfigError, resolveGmailOAuthClientConfig, type GmailOAuthClientConfig } from './gmailOAuth';
import type { SecretBox } from './openRouterCredential';

/** Google issues Desktop/Web client ids as `<project number>-<random>.apps.googleusercontent.com`. */
export const GOOGLE_CLIENT_ID_PATTERN = /^\d{6,}-[a-z0-9]{8,}\.apps\.googleusercontent\.com$/i;

export class GoogleOAuthClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleOAuthClientError';
  }
}

export type GoogleOAuthClientSource = 'environment' | 'saved' | 'bundled' | null;

export function googleOAuthClientPath(dataDir: string): string {
  return path.join(dataDir, 'google.oauth-client.credential.bin');
}

/** Validates operator input before anything is stored. Messages are shown verbatim in the UI. */
export function validateGoogleOAuthClientInput(clientIdRaw: string, clientSecretRaw: string): { clientId: string; clientSecret: string | undefined } {
  const clientId = String(clientIdRaw ?? '').trim();
  const clientSecret = String(clientSecretRaw ?? '').trim();
  if (!clientId) {
    throw new GoogleOAuthClientError('Paste the Client ID from your Google Cloud OAuth client.');
  }
  if (/\s/.test(clientId) || !GOOGLE_CLIENT_ID_PATTERN.test(clientId)) {
    throw new GoogleOAuthClientError(
      'That does not look like a Google Client ID. It should end in ".apps.googleusercontent.com" '
      + '(for example 1234567890-abcdefg.apps.googleusercontent.com). Make sure you copied the Client ID, not the project ID or the secret.',
    );
  }
  if (clientSecret && (/\s/.test(clientSecret) || clientSecret.length < 8 || clientSecret.length > 256)) {
    throw new GoogleOAuthClientError('The Client secret looks malformed. Copy it again from the OAuth client page, or leave it empty if Google did not issue one.');
  }
  return { clientId, clientSecret: clientSecret || undefined };
}

/**
 * Reads the file Google Cloud offers as "Download JSON" for an OAuth client
 * (`client_secret_….json`). A Desktop client is stored under "installed";
 * a Web client under "web" and cannot be used for this loopback sign-in.
 * Nothing from the file is ever echoed back in an error message.
 */
export function parseGoogleClientSecretJson(text: string): { clientId: string; clientSecret: string | undefined } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new GoogleOAuthClientError('That file is not valid JSON. Use the file Google Cloud gives you with "Download JSON" on the OAuth client page.');
  }
  const root = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
  if (root.web && !root.installed) {
    throw new GoogleOAuthClientError('That is a Web application client. Panda needs a "Desktop app" OAuth client — create a new one in Google Cloud and download its JSON.');
  }
  const installed = root.installed;
  if (!installed || typeof installed !== 'object') {
    throw new GoogleOAuthClientError('That file is not a Google OAuth client file (no "installed" section). Use "Download JSON" on a Desktop app OAuth client.');
  }
  const record = installed as Record<string, unknown>;
  return validateGoogleOAuthClientInput(String(record.client_id ?? ''), String(record.client_secret ?? ''));
}

export function storeGoogleOAuthClient(dataDir: string, input: { clientId: string; clientSecret?: string }, box: SecretBox | null): void {
  if (!box?.isEncryptionAvailable()) {
    throw new GoogleOAuthClientError('Windows encrypted storage is not available, so Panda will not save your Google credentials.');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const cipher = box.encryptString(JSON.stringify({ clientId: input.clientId, clientSecret: input.clientSecret ?? null }));
  fs.writeFileSync(googleOAuthClientPath(dataDir), cipher, { mode: 0o600 });
}

export function loadStoredGoogleOAuthClient(dataDir: string, box: SecretBox | null): GmailOAuthClientConfig | null {
  if (!box?.isEncryptionAvailable()) return null;
  try {
    const cipher = fs.readFileSync(googleOAuthClientPath(dataDir));
    if (!cipher.length) return null;
    const parsed: unknown = JSON.parse(box.decryptString(cipher));
    if (!parsed || typeof parsed !== 'object') return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.clientId !== 'string' || !record.clientId.trim()) return null;
    return {
      clientId: record.clientId.trim(),
      clientSecret: typeof record.clientSecret === 'string' && record.clientSecret.trim() ? record.clientSecret.trim() : undefined,
    };
  } catch {
    return null;
  }
}

export function clearStoredGoogleOAuthClient(dataDir: string): void {
  try {
    fs.unlinkSync(googleOAuthClientPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function storedGoogleOAuthClientPresent(dataDir: string): boolean {
  try {
    return fs.statSync(googleOAuthClientPath(dataDir)).isFile();
  } catch {
    return false;
  }
}

/** File name of the app-owned Desktop OAuth client shipped with Panda (Google's "Download JSON" format). */
export const BUNDLED_GOOGLE_CLIENT_FILE = 'google-oauth-client.json';

/**
 * The app-owned client: shipped next to the app (resources/), so an ordinary user only clicks Connect Google.
 * `KARKEDIKHA_GOOGLE_CLIENT_FILE` can point at a specific file; otherwise each directory in `dirs` is tried.
 * Unreadable or malformed files are ignored (the user then sees the normal setup path).
 */
export function loadBundledGoogleOAuthClient(dirs: readonly string[], env: NodeJS.ProcessEnv = process.env): GmailOAuthClientConfig | null {
  const candidates = [env.KARKEDIKHA_GOOGLE_CLIENT_FILE, ...dirs.map((dir) => (dir ? path.join(dir, BUNDLED_GOOGLE_CLIENT_FILE) : undefined))];
  for (const file of candidates) {
    if (!file) continue;
    try {
      return parseGoogleClientSecretJson(fs.readFileSync(file, 'utf8'));
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function defaultBundledDirs(): string[] {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  return [resourcesPath ?? '', path.resolve(__dirname, '..', '..', '..', 'resources'), path.resolve(process.cwd(), 'resources')];
}

/** Environment first (existing setups), then a client saved in the UI (developer override), then the app-owned client. */
export function resolveGoogleOAuthClient(
  dataDir: string,
  box: SecretBox | null,
  env: NodeJS.ProcessEnv = process.env,
  bundledDirs: readonly string[] = defaultBundledDirs(),
): { config: GmailOAuthClientConfig; source: Exclude<GoogleOAuthClientSource, null> } {
  try {
    return { config: resolveGmailOAuthClientConfig(env), source: 'environment' };
  } catch (err) {
    if (!(err instanceof GmailOAuthConfigError)) throw err;
  }
  const stored = loadStoredGoogleOAuthClient(dataDir, box);
  if (stored) return { config: stored, source: 'saved' };
  const bundled = loadBundledGoogleOAuthClient(bundledDirs, env);
  if (bundled) return { config: bundled, source: 'bundled' };
  throw new GmailOAuthConfigError(
    'Google is not set up yet: add your OAuth Client ID in Connections → Google Services (one-time setup, steps are shown there).',
  );
}

/** Non-secret display hint such as `1234…gz.apps.googleusercontent.com`. */
export function maskGoogleClientId(clientId: string): string {
  const match = /^(\d+)-([a-z0-9]+)(\.apps\.googleusercontent\.com)$/i.exec(clientId);
  if (!match) return `${clientId.slice(0, 6)}…`;
  return `${match[1].slice(0, 4)}…${match[2].slice(-3)}${match[3]}`;
}
