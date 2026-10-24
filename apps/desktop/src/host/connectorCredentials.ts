import * as fs from 'node:fs';
import * as path from 'node:path';
import { tryElectronSecretBox, type SecretBox } from './openRouterCredential';
import { CONNECTOR_CREDENTIAL_ENV } from '../../../../core/runtime/connectors/connectorDefinitions';
import type { ConnectorId } from '../../../../core/shared/wireTypes';

export { tryElectronSecretBox, type SecretBox };

export class ConnectorCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorCredentialError';
  }
}

/** Host-only ciphertext in the Core data-dir, one file per connector. Never
 * render, IPC, or log the plaintext — mirrors `openRouterCredential.ts`. */
export function connectorCredentialPath(dataDir: string, connectorId: ConnectorId): string {
  return path.join(dataDir, `connector.${connectorId}.credential.bin`);
}

/** Core reads this env var's presence (never its value) to decide whether a
 * connector is configured (`ConnectorCapabilityAdapter.isConfigured`); its
 * value is the decrypted credential, injected only into Core's spawn env by
 * `desktopConfig.ts`'s `buildConnectorCredentialEnv`, never persisted by Core
 * and never sent to the renderer. */
export function connectorCredentialEnvVar(connectorId: ConnectorId): string {
  return CONNECTOR_CREDENTIAL_ENV[connectorId];
}

export function storeConnectorCredential(dataDir: string, connectorId: ConnectorId, credential: string, box: SecretBox): void {
  const trimmed = credential.trim();
  if (!trimmed) throw new ConnectorCredentialError(`${connectorId} credential is empty`);
  if (!box.isEncryptionAvailable()) {
    throw new ConnectorCredentialError('host encrypted storage is not available');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const cipher = box.encryptString(trimmed);
  fs.writeFileSync(connectorCredentialPath(dataDir, connectorId), cipher, { mode: 0o600 });
}

export function loadConnectorCredential(dataDir: string, connectorId: ConnectorId, box: SecretBox | null): string | null {
  if (!box?.isEncryptionAvailable()) return null;
  const filePath = connectorCredentialPath(dataDir, connectorId);
  try {
    const cipher = fs.readFileSync(filePath);
    if (!cipher.length) return null;
    const plain = box.decryptString(cipher).trim();
    return plain || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ConnectorCredentialError(`stored ${connectorId} credential could not be decrypted`);
  }
}

export function clearConnectorCredential(dataDir: string, connectorId: ConnectorId): void {
  try {
    fs.unlinkSync(connectorCredentialPath(dataDir, connectorId));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function connectorCredentialPresent(dataDir: string, connectorId: ConnectorId): boolean {
  try {
    return fs.statSync(connectorCredentialPath(dataDir, connectorId)).isFile();
  } catch {
    return false;
  }
}

/** Redacts every connector credential env var before any env dump/log —
 * mirrors `openRouterCredential.ts`'s `redactSensitiveEnv`. */
export function redactConnectorCredentialEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const envVar of Object.values(CONNECTOR_CREDENTIAL_ENV)) {
    if (out[envVar]) out[envVar] = '[redacted]';
  }
  return out;
}

const ALL_CONNECTOR_IDS: readonly ConnectorId[] = ['gmail', 'google_calendar', 'whatsapp', 'printer'];

/** Host-only Core spawn-env additions: one env var per connector whose
 * credential is stored and decryptable, otherwise omitted entirely (so an
 * unconfigured connector's env var is genuinely absent, not empty-string —
 * `isConfigured()` on the Core side checks for a non-empty value either way).
 * Never log the returned object. */
export function buildConnectorCredentialEnv(dataDir: string, box: SecretBox | null): Record<string, string> {
  const env: Record<string, string> = {};
  for (const connectorId of ALL_CONNECTOR_IDS) {
    const credential = loadConnectorCredential(dataDir, connectorId, box);
    if (credential) env[connectorCredentialEnvVar(connectorId)] = credential;
  }
  return env;
}
