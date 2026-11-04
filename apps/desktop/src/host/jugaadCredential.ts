import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretBox } from './openRouterCredential';

/**
 * Host-only storage for the JUGAAD pairing (device serial + token).
 *
 * The blob is encrypted with the OS secret box (Electron `safeStorage`, which is Windows DPAPI bound
 * to this user). Plaintext is never written to disk. The `.credential.bin` suffix is also what
 * `isCredentialFilePath` (core/platform/credentialStore.ts) treats as unreadable by any model tool.
 * Never render, IPC-return or log the token.
 */
export class JugaadCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JugaadCredentialError';
  }
}

export interface StoredJugaadPairing {
  serial: string;
  token: string;
}

export function jugaadCredentialPath(dataDir: string): string {
  return path.join(dataDir, 'jugaad.pairing.credential.bin');
}

export function storeJugaadPairing(dataDir: string, pairing: StoredJugaadPairing, box: SecretBox): void {
  const serial = pairing.serial.trim();
  const token = pairing.token.trim();
  if (!serial || !token) throw new JugaadCredentialError('JUGAAD pairing needs a device and a token');
  if (!box.isEncryptionAvailable()) throw new JugaadCredentialError('host encrypted storage is not available');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(jugaadCredentialPath(dataDir), box.encryptString(JSON.stringify({ serial, token })), { mode: 0o600 });
}

export function loadJugaadPairing(dataDir: string, box: SecretBox | null): StoredJugaadPairing | null {
  if (!box?.isEncryptionAvailable()) return null;
  try {
    const cipher = fs.readFileSync(jugaadCredentialPath(dataDir));
    if (!cipher.length) return null;
    const parsed = JSON.parse(box.decryptString(cipher)) as Partial<StoredJugaadPairing>;
    return typeof parsed.serial === 'string' && typeof parsed.token === 'string' && parsed.serial && parsed.token
      ? { serial: parsed.serial, token: parsed.token }
      : null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new JugaadCredentialError('stored JUGAAD pairing could not be decrypted');
  }
}

/** Erases Pandesh's copy. This does NOT revoke the token inside JUGAAD. */
export function clearJugaadPairing(dataDir: string): void {
  try {
    fs.unlinkSync(jugaadCredentialPath(dataDir));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

export function jugaadPairingPresent(dataDir: string): boolean {
  try {
    return fs.statSync(jugaadCredentialPath(dataDir)).isFile();
  } catch {
    return false;
  }
}
