import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  JugaadCredentialError,
  clearJugaadPairing,
  jugaadCredentialPath,
  jugaadPairingPresent,
  loadJugaadPairing,
  storeJugaadPairing,
} from '../src/host/jugaadCredential';
import type { SecretBox } from '../src/host/openRouterCredential';
import { isCredentialFilePath } from '../../../core/platform/credentialStore';

/** Reversible stand-in for Electron safeStorage: proves plaintext is not what lands on disk. */
function memoryBox(available = true): SecretBox {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => Buffer.from(JSON.stringify({ p: Buffer.from(plain, 'utf8').toString('base64').split('').reverse().join('') }), 'utf8'),
    decryptString: (cipher) => {
      const parsed = JSON.parse(cipher.toString('utf8')) as { p?: string };
      if (typeof parsed.p !== 'string') throw new Error('undecryptable');
      return Buffer.from(parsed.p.split('').reverse().join(''), 'base64').toString('utf8');
    },
  };
}

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('JUGAAD host pairing store', () => {
  it('keeps the token off disk in plaintext and round-trips through the secret box', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-jugaad-'));
    storeJugaadPairing(dir, { serial: 'R3CXB0K5SEF', token: TOKEN }, memoryBox());
    const raw = fs.readFileSync(jugaadCredentialPath(dir));
    expect(raw.toString('utf8')).not.toContain(TOKEN);
    expect(raw.toString('latin1')).not.toContain(TOKEN);
    expect(fs.readdirSync(dir)).toEqual(['jugaad.pairing.credential.bin']);
    expect(loadJugaadPairing(dir, memoryBox())).toEqual({ serial: 'R3CXB0K5SEF', token: TOKEN });
    expect(jugaadPairingPresent(dir)).toBe(true);
  });

  it('refuses to store when encrypted storage is unavailable, leaving nothing on disk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-jugaad-'));
    expect(() => storeJugaadPairing(dir, { serial: 'S', token: TOKEN }, memoryBox(false))).toThrow(JugaadCredentialError);
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(loadJugaadPairing(dir, memoryBox(false))).toBeNull();
  });

  it('Disconnect erases the stored token, is idempotent, and leaves other files alone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-jugaad-'));
    fs.writeFileSync(path.join(dir, 'other.credential.bin'), 'keep');
    storeJugaadPairing(dir, { serial: 'S', token: TOKEN }, memoryBox());
    clearJugaadPairing(dir);
    clearJugaadPairing(dir);
    expect(jugaadPairingPresent(dir)).toBe(false);
    expect(loadJugaadPairing(dir, memoryBox())).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(['other.credential.bin']);
  });

  it('fails closed on an undecryptable blob and never echoes its content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-jugaad-'));
    fs.writeFileSync(jugaadCredentialPath(dir), 'garbage');
    expect(() => loadJugaadPairing(dir, memoryBox())).toThrow('could not be decrypted');
  });

  it('is a credential file that model file tools must refuse to read', () => {
    expect(isCredentialFilePath(jugaadCredentialPath('C:\\Users\\x\\AppData\\Roaming\\Pandesh'))).toBe(true);
  });
});
