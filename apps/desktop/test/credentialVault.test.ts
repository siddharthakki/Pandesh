import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CredentialVault,
  MemoryCredentialBackend,
  WindowsCredentialBackend,
  credentialTarget,
  listBackupProviders,
  readEncryptedBackup,
} from '../src/host/credentialVault';
import type { SecretBox } from '../src/host/openRouterCredential';

// Dummy values only. They are shaped like real keys so the redaction shapes would catch them if they ever leaked.
const DUMMY_GROQ = 'gsk_PANDESHDUMMYtestvalue0000000000001';
const DUMMY_OPENROUTER = 'sk-or-v1-PANDESHDUMMYtestvalue000000000002';
const PASS = 'correct horse battery staple 42';

/** A reversible fake of Electron safeStorage for the legacy-file path. */
const fakeBox: SecretBox = {
  isEncryptionAvailable: () => true,
  encryptString: (plain: string) => Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
  decryptString: (blob: Buffer) => Buffer.from(blob.toString().slice(4), 'base64').toString(),
};

function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `pandesh-vault-${tag}-`));
}

describe('credential vault (memory backend)', () => {
  it('saves, reads, masks and deletes a key; status never carries the value', async () => {
    const vault = new CredentialVault(tmpDir('mem'), new MemoryCredentialBackend(), () => fakeBox);
    await vault.set('groq', DUMMY_GROQ);
    expect(await vault.get('groq')).toBe(DUMMY_GROQ);
    const status = await vault.status(['groq', 'gemini']);
    expect(status.groq).toEqual({ configured: true, source: 'credential-manager', hint: 'gsk_…0001' });
    expect(status.gemini.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain(DUMMY_GROQ);
    await vault.delete('groq');
    expect(await vault.get('groq')).toBeNull();
  });

  it('reads legacy safeStorage files and migrates them only when asked, verifying by hash', async () => {
    const dir = tmpDir('legacy');
    fs.writeFileSync(path.join(dir, 'cloud-provider-openrouter.credential.bin'), fakeBox.encryptString(DUMMY_OPENROUTER));
    const backend = new MemoryCredentialBackend();
    const vault = new CredentialVault(dir, backend, () => fakeBox);
    expect((await vault.status(['openrouter'])).openrouter.source).toBe('legacy-encrypted-file');
    expect(backend.values.size).toBe(0); // nothing migrated implicitly
    expect(await vault.legacyOnly(['openrouter', 'groq'])).toEqual(['openrouter']);
    const result = await vault.migrateLegacy(['openrouter']);
    expect(result).toEqual([{ provider: 'openrouter', migrated: true }]);
    expect(backend.values.get('openrouter')).toBe(DUMMY_OPENROUTER);
    expect(fs.existsSync(path.join(dir, 'cloud-provider-openrouter.credential.bin'))).toBe(true); // legacy kept
    expect(JSON.stringify(result)).not.toContain(DUMMY_OPENROUTER);
  });

  it('encrypted backup round-trips, restores only approved providers, and has no plaintext', async () => {
    const source = new CredentialVault(tmpDir('src'), new MemoryCredentialBackend(), () => null);
    await source.set('groq', DUMMY_GROQ);
    await source.set('openrouter', DUMMY_OPENROUTER);
    const file = path.join(tmpDir('bak'), 'keys.pandesh-keys');
    await source.exportBackup(file, PASS, ['groq', 'openrouter']);
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain(DUMMY_GROQ);
    expect(raw).not.toContain(DUMMY_OPENROUTER);
    expect(raw).not.toContain('groq'); // even provider names are inside the ciphertext
    await expect(readEncryptedBackup(file, 'wrong passphrase!!')).rejects.toThrow(/Wrong passphrase/);
    expect(await listBackupProviders(file, PASS)).toEqual(['groq', 'openrouter']);

    const target = new MemoryCredentialBackend();
    const fresh = new CredentialVault(tmpDir('dst'), target, () => null);
    const restored = await fresh.restoreBackup(file, PASS, ['groq']);
    expect(restored).toEqual({ restored: ['groq'], skipped: ['openrouter'] });
    expect(target.values.get('groq')).toBe(DUMMY_GROQ);
    expect(target.values.has('openrouter')).toBe(false);
  });

  it('a tampered backup is refused', async () => {
    const source = new CredentialVault(tmpDir('tamper'), new MemoryCredentialBackend(), () => null);
    await source.set('groq', DUMMY_GROQ);
    const file = path.join(tmpDir('tamperbak'), 'k.pandesh-keys');
    await source.exportBackup(file, PASS, ['groq']);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.kdf.N = 1 << 16; // try to weaken the KDF
    fs.writeFileSync(file, JSON.stringify(doc));
    await expect(readEncryptedBackup(file, PASS)).rejects.toThrow();
  });

  it('refuses a short passphrase', async () => {
    const vault = new CredentialVault(tmpDir('short'), new MemoryCredentialBackend(), () => null);
    await vault.set('groq', DUMMY_GROQ);
    await expect(vault.exportBackup(path.join(tmpDir('s'), 'k.pandesh-keys'), 'short', ['groq'])).rejects.toThrow(/at least 12/);
  });
});

// Live Windows Credential Manager, isolated namespace so a real `pandesh/` credential is never touched.
const live = process.platform === 'win32' ? describe : describe.skip;
live('credential vault (live Windows Credential Manager)', () => {
  const ns = `pandesh-test-${process.pid}`;
  const backend = new WindowsCredentialBackend(ns);
  afterAll(async () => { await backend.remove('groq').catch(() => false); await backend.remove('openrouter').catch(() => false); });

  it('persists across vault instances and separate processes (restart / reinstall / reclone)', async () => {
    const first = new CredentialVault(tmpDir('live1'), backend, () => null);
    await first.set('groq', DUMMY_GROQ);
    // A different data dir = a reinstalled or recloned Pandesh: the key is still there.
    const second = new CredentialVault(tmpDir('live2'), new WindowsCredentialBackend(ns), () => null);
    expect(await second.get('groq')).toBe(DUMMY_GROQ);
    // Windows itself lists it (outside Pandesh's process), without ever showing the secret.
    const ps = `cmdkey /list:${credentialTarget('groq', ns)}`;
    const listed = execFileSync('cmd.exe', ['/c', ps], { encoding: 'utf8' });
    expect(listed).toContain(credentialTarget('groq', ns));
    expect(listed).not.toContain(DUMMY_GROQ); // cmdkey never shows the secret
    await second.delete('groq');
    expect(await new CredentialVault(tmpDir('live3'), new WindowsCredentialBackend(ns), () => null).get('groq')).toBeNull();
  }, 120_000);
});
