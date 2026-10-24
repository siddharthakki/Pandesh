import * as fs from 'node:fs';
import * as path from 'node:path';

export const OPENROUTER_API_KEY_FILE = 'openrouter.api-key.bin';
export const OPENROUTER_API_KEY_ENV = 'KARKEDIKHA_OPENROUTER_API_KEY';

export interface SecretBox {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(cipher: Buffer): string;
}

export class OpenRouterCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterCredentialError';
  }
}

/** Host-only ciphertext in the Core data-dir. Never render, IPC, or log the plaintext. */
export function openRouterApiKeyPath(dataDir: string): string {
  return path.join(dataDir, OPENROUTER_API_KEY_FILE);
}

export function tryElectronSecretBox(): SecretBox | null {
  try {
    // Electron is present in the Desktop host process, not in unit tests.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      safeStorage?: {
        isEncryptionAvailable(): boolean;
        encryptString(plain: string): Buffer;
        decryptString(cipher: Buffer): string;
      };
    };
    const box = electron.safeStorage;
    if (!box?.isEncryptionAvailable()) return null;
    return {
      isEncryptionAvailable: () => box.isEncryptionAvailable(),
      encryptString: (plain) => box.encryptString(plain),
      decryptString: (cipher) => box.decryptString(cipher),
    };
  } catch {
    return null;
  }
}

export function storeOpenRouterApiKey(dataDir: string, apiKey: string, box: SecretBox): void {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new OpenRouterCredentialError('OpenRouter API key is empty');
  if (!box.isEncryptionAvailable()) {
    throw new OpenRouterCredentialError('host encrypted storage is not available');
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const cipher = box.encryptString(trimmed);
  fs.writeFileSync(openRouterApiKeyPath(dataDir), cipher, { mode: 0o600 });
}

export function loadOpenRouterApiKey(dataDir: string, box: SecretBox | null): string | null {
  if (!box?.isEncryptionAvailable()) return null;
  const filePath = openRouterApiKeyPath(dataDir);
  try {
    const cipher = fs.readFileSync(filePath);
    if (!cipher.length) return null;
    const plain = box.decryptString(cipher).trim();
    return plain || null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new OpenRouterCredentialError('stored OpenRouter API key could not be decrypted');
  }
}

export function clearOpenRouterApiKey(dataDir: string): void {
  try {
    fs.unlinkSync(openRouterApiKeyPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function openRouterApiKeyPresent(dataDir: string): boolean {
  try {
    return fs.statSync(openRouterApiKeyPath(dataDir)).isFile();
  } catch {
    return false;
  }
}

/** Redacts bearer tokens before any env dump. Never log the raw values. */
export function redactSensitiveEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  if (out.KARKEDIKHA_CORE_TOKEN) out.KARKEDIKHA_CORE_TOKEN = '[redacted]';
  if (out[OPENROUTER_API_KEY_ENV]) out[OPENROUTER_API_KEY_ENV] = '[redacted]';
  return out;
}
