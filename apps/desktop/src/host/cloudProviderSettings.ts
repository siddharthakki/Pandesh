/**
 * Free cloud provider settings for Pandesh.
 *
 * Two kinds of state, deliberately kept apart:
 *  - Secrets: each provider's API key is encrypted with Electron `safeStorage` in its own file
 *    (`cloud-provider-<id>.credential.bin`). The renderer only ever receives `configured` and a
 *    masked hint; the plaintext is handed to Core once per launch over the authenticated local API.
 *  - Non-secret configuration: enabled providers, the selected free model and the local-fallback
 *    preference live in `cloud-providers.json` — never a key.
 *
 * Cloud is OFF by default: no provider is enabled and no model is selected until the operator
 * turns one on. Nothing here sends a request; the request itself is gated in Core.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretBox } from './openRouterCredential';

export const CLOUD_SETTINGS_FILE = 'cloud-providers.json';
export const CLOUD_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;

export interface CloudSettingsState {
  schemaVersion: 1;
  enabledProviders: string[];
  selectedModel: string | null;
  localFallback: boolean;
  /** Non-secret base URL overrides for providers whose endpoint contains an account placeholder. */
  baseUrls: Record<string, string>;
}

const EMPTY: CloudSettingsState = { schemaVersion: 1, enabledProviders: [], selectedModel: null, localFallback: true, baseUrls: {} };

export function cloudSettingsPath(dataDir: string): string {
  return path.join(dataDir, CLOUD_SETTINGS_FILE);
}

export function cloudProviderKeyPath(dataDir: string, providerId: string): string {
  if (!CLOUD_PROVIDER_ID_PATTERN.test(providerId)) throw new Error('Invalid provider id');
  return path.join(dataDir, `cloud-provider-${providerId}.credential.bin`);
}

function normalize(raw: unknown): CloudSettingsState {
  if (!raw || typeof raw !== 'object') return { ...EMPTY };
  const value = raw as Record<string, unknown>;
  const enabled = Array.isArray(value.enabledProviders)
    ? [...new Set(value.enabledProviders.filter((id): id is string => typeof id === 'string' && CLOUD_PROVIDER_ID_PATTERN.test(id)))]
    : [];
  const selected = typeof value.selectedModel === 'string' && value.selectedModel.trim() ? value.selectedModel.trim() : null;
  const localFallback = value.localFallback !== false;
  const baseUrls: Record<string, string> = {};
  if (value.baseUrls && typeof value.baseUrls === 'object') {
    for (const [id, url] of Object.entries(value.baseUrls as Record<string, unknown>)) {
      if (CLOUD_PROVIDER_ID_PATTERN.test(id) && typeof url === 'string' && /^https?:\/\//i.test(url.trim())) baseUrls[id] = url.trim().replace(/\/$/, '');
    }
  }
  return { schemaVersion: 1, enabledProviders: enabled, selectedModel: selected, localFallback, baseUrls };
}

export function loadCloudSettings(dataDir: string): CloudSettingsState {
  try {
    return normalize(JSON.parse(fs.readFileSync(cloudSettingsPath(dataDir), 'utf8')));
  } catch {
    return { ...EMPTY };
  }
}

export function saveCloudSettings(dataDir: string, next: Partial<CloudSettingsState>): CloudSettingsState {
  const merged = normalize({ ...loadCloudSettings(dataDir), ...next });
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${cloudSettingsPath(dataDir)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, cloudSettingsPath(dataDir));
  return merged;
}

export function storeCloudProviderKey(dataDir: string, providerId: string, apiKey: string, box: SecretBox): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error('API key is empty');
  if (!box.isEncryptionAvailable()) throw new Error('host encrypted storage is not available');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(cloudProviderKeyPath(dataDir, providerId), box.encryptString(trimmed), { mode: 0o600 });
}

export function loadCloudProviderKey(dataDir: string, providerId: string, box: SecretBox | null): string | null {
  if (!box?.isEncryptionAvailable()) return null;
  try {
    const plain = box.decryptString(fs.readFileSync(cloudProviderKeyPath(dataDir, providerId))).trim();
    return plain || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export function clearCloudProviderKey(dataDir: string, providerId: string): void {
  try {
    fs.unlinkSync(cloudProviderKeyPath(dataDir, providerId));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** A non-reversible hint, e.g. `gsk_…A1b2`; never enough to use the key. */
export function maskedKeyHint(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

/** The masked hint for a stored key, or null when none is stored or it cannot be decrypted. */
export function cloudProviderKeyHint(dataDir: string, providerId: string, box: SecretBox | null): string | null {
  const key = loadCloudProviderKey(dataDir, providerId, box);
  return key ? maskedKeyHint(key) : null;
}

/** True when no provider is enabled and no model is selected: the default off state. */
export function isCloudOff(state: CloudSettingsState): boolean {
  return state.enabledProviders.length === 0 && state.selectedModel === null;
}
