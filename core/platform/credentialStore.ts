import * as fs from 'node:fs';

/**
 * Host-neutral credential contract (JARVIS-reusable). Secrets — API keys, access
 * tokens, refresh tokens — only ever travel through a CredentialStore. A host
 * adapter backs it (VS Code SecretStorage today; an OS keychain later). Non-secret
 * provider configuration lives elsewhere and must never hold a value from here.
 */
export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export class InMemoryCredentialStore implements CredentialStore {
  private readonly values = new Map<string, string>();
  async get(key: string): Promise<string | undefined> { return this.values.get(key); }
  async set(key: string, value: string): Promise<void> { this.values.set(key, value); }
  async delete(key: string): Promise<void> { this.values.delete(key); }
  /** Test helper: the keys currently held (never the values). */
  keys(): string[] { return [...this.values.keys()]; }
}

/** SecretStorage key of the legacy OrcaRouter credential; kept so existing installs stay connected. */
export const ORCAROUTER_LEGACY_SECRET_KEY = 'ollama-agent.orcaRouterApiKey';

export type CredentialKind = 'apiKey' | 'accessToken' | 'refreshToken';

/** Stable secret-store key for a provider credential. */
export function providerSecretKey(providerId: string, kind: CredentialKind = 'apiKey'): string {
  if (providerId === 'orcarouter' && kind === 'apiKey') return ORCAROUTER_LEGACY_SECRET_KEY;
  return `ollama-agent.cloud.${providerId}.${kind}`;
}

const SECRET_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_\-]{8,}/g,
  /\bgsk_[A-Za-z0-9]{8,}/g,
  /\bhf_[A-Za-z0-9]{8,}/g,
  /\bAIza[0-9A-Za-z_\-]{10,}/g,
  /\bnvapi-[A-Za-z0-9_\-]{8,}/g,
  /\bBearer\s+[A-Za-z0-9._\-]{8,}/gi,
  /\bGOCSPX-[A-Za-z0-9_\-]{8,}/g,
  /\b1\/\/0[A-Za-z0-9_\-]{30,}/g,
  /^[ \t]*(?:export[ \t]+)?[A-Za-z][A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z0-9_]*[ \t]*=[ \t]*\S.*$/gim,
];

/**
 * Files that hold credentials and must never be read into a model conversation,
 * whatever the model asks for: env files, Google OAuth client files, encrypted
 * credential blobs, key material and the phone-pairing record.
 */
const CREDENTIAL_FILE_NAME = /^(?:\.env(?:\.(?!example$|sample$|template$).+)?|credentials(?:\..+)?|secrets?(?:\..+)?|\.npmrc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|client_secret.*\.json|google-oauth-client\.json|mobile-pair\.json|.+\.credential\.bin|.+\.(?:pem|key|pfx|p12|keystore))$/i;

/**
 * True when `target` names a credential file. Windows aliases are normalised
 * (alternate data streams, trailing dots/spaces) and a symlink's real name is
 * checked too, so `credentials.env::$DATA` or a link called `notes.txt` that
 * points at `credentials.env` do not slip past a name check.
 */
export function isCredentialFilePath(target: string): boolean {
  const names = new Set<string>();
  const add = (candidate: string) => {
    const base = candidate.replace(/\\/g, '/').split('/').pop() ?? '';
    names.add(base.replace(/:.*$/, '').replace(/[. ]+$/, ''));
  };
  add(target);
  try {
    add(fs.realpathSync(target));
  } catch {
    /* not on disk: the lexical name still counts */
  }
  return [...names].some((name) => CREDENTIAL_FILE_NAME.test(name));
}

/**
 * Removes known secrets and common API-key shapes from text bound for UI, logs,
 * diagnostics, prompts or error messages.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let out = text;
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join('[redacted]');
  }
  for (const shape of SECRET_SHAPES) out = out.replace(shape, '[redacted]');
  return out;
}

/** True when `value` (any JSON-able structure) contains one of the secrets. Used by tests and egress guards. */
export function containsSecret(value: unknown, secrets: readonly string[]): boolean {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  return secrets.some(secret => secret.length >= 4 && serialized.includes(secret));
}
