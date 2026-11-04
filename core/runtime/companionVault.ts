/**
 * Where the JUGAAD companion keeps its secrets on the PC.
 *
 * One random 32-byte vault key is protected by the OS secret store (Windows DPAPI, current user) in
 * `companion-vault.json`. Everything else is sealed under it with AES-256-GCM:
 *   - each paired phone's device key, in `companion_devices.keyMaterial` as `vault1:<iv|ct|tag>`;
 *   - the listener's TLS private key, in `companion-tls.json` next to its (public) certificate.
 * So the database and the data folder alone — a backup, a copied profile — let nobody talk to the PC as a phone or
 * impersonate the PC to a phone. The vault key is unwrapped once per Core run and held in memory only.
 *
 * Without an OS secret store, or when DPAPI refuses the existing vault, the vault is not ready and the listener does
 * not start: phone sync fails closed rather than falling back to keys in the clear.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { deviceKeyPurpose, type CompanionKeySealer } from '../domain/companionSync';
import type { SecretProtector } from '../platform/osSecretProtector';
import { certificateFingerprint, createSelfSignedIdentity } from '../platform/selfSignedCert';

const VAULT_FILE = 'companion-vault.json';
const TLS_FILE = 'companion-tls.json';
const SEALED_PREFIX = 'vault1:';

export interface CompanionTlsIdentity { keyPem: string; certPem: string; fingerprint: string }

export class CompanionVault implements CompanionKeySealer {
  private key: Buffer | null = null;
  private tls: CompanionTlsIdentity | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly dataDir: string, private readonly protector: SecretProtector | null) {}

  get ready(): boolean { return this.key !== null; }
  get protection(): string { return this.protector?.kind ?? 'none'; }

  /** Unwraps (or, the first time, creates) the vault key. Throws when the OS store is missing or refuses. */
  open(): Promise<void> {
    if (this.key) return Promise.resolve();
    this.loading ??= this.load().finally(() => { this.loading = null; });
    return this.loading;
  }

  private async load(): Promise<void> {
    if (!this.protector) throw new Error('this computer has no OS secret store Pandesh can use, so phone sync stays off');
    const file = path.join(this.dataDir, VAULT_FILE);
    let stored: { v?: number; blob?: string } | null = null;
    try { stored = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`the companion vault file is unreadable (${(err as Error).message}); phone sync stays off`);
    }
    if (stored) {
      let key: Buffer;
      try { key = await this.protector.unprotect(Buffer.from(String(stored.blob ?? ''), 'base64')); } catch (err) {
        throw new Error(`${this.protector.kind} could not open the companion vault (${(err as Error).message}). It was made by another Windows account or computer; phone sync stays off until it is reset and phones pair again`);
      }
      if (key.length !== 32) throw new Error('the companion vault holds a malformed key; phone sync stays off');
      this.key = key;
      return;
    }
    const key = crypto.randomBytes(32);
    const blob = await this.protector.protect(key);
    fs.mkdirSync(this.dataDir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, protector: this.protector.kind, blob: blob.toString('base64'), createdAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    this.key = key;
  }

  private requireKey(): Buffer {
    if (!this.key) throw new Error('the companion vault is not open');
    return this.key;
  }

  seal(plain: Buffer, purpose: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.requireKey(), iv);
    cipher.setAAD(Buffer.from(purpose, 'utf8'));
    return SEALED_PREFIX + Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }

  /** The plaintext, or null when the value is not sealed by this vault (plaintext, tampered, or another vault's). */
  unseal(stored: string, purpose: string): Buffer | null {
    if (!isVaultSealed(stored)) return null;
    const raw = Buffer.from(stored.slice(SEALED_PREFIX.length), 'base64');
    if (raw.length < 12 + 16 + 1) return null;
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.requireKey(), raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(purpose, 'utf8'));
      decipher.setAuthTag(raw.subarray(raw.length - 16));
      return Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
    } catch {
      return null;
    }
  }

  /** The listener's certificate and key, created on first use. The private key is stored sealed. */
  tlsIdentity(commonName: string): CompanionTlsIdentity {
    if (this.tls) return this.tls;
    const file = path.join(this.dataDir, TLS_FILE);
    try {
      const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as { certPem: string; keySealed: string };
      const key = this.unseal(stored.keySealed, 'companion-tls-key');
      if (key && new crypto.X509Certificate(stored.certPem).checkPrivateKey(crypto.createPrivateKey(key.toString('utf8')))) {
        this.tls = { keyPem: key.toString('utf8'), certPem: stored.certPem, fingerprint: certificateFingerprint(stored.certPem) };
        return this.tls;
      }
    } catch { /* absent or unusable: issue a new one (paired phones then refuse it until they pair again) */ }
    const id = createSelfSignedIdentity(commonName);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ v: 1, certPem: id.certPem, keySealed: this.seal(Buffer.from(id.keyPem, 'utf8'), 'companion-tls-key'), fingerprint: id.fingerprint, createdAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    this.tls = id;
    return id;
  }

  /** The fingerprint phones pin, without creating an identity. */
  currentFingerprint(): string | null {
    if (this.tls) return this.tls.fingerprint;
    try { return certificateFingerprint((JSON.parse(fs.readFileSync(path.join(this.dataDir, TLS_FILE), 'utf8')) as { certPem: string }).certPem); } catch { return null; }
  }
}

export function isVaultSealed(stored: string): boolean {
  return stored.startsWith(SEALED_PREFIX);
}

/**
 * Seals every device key still stored in the clear (pairings made before the vault existed). Idempotent; returns how
 * many rows it converted.
 */
export function migrateCompanionDeviceKeys(db: CoreDatabase, vault: CompanionVault): number {
  if (!db.get<{ n: number }>("SELECT COUNT(*) AS n FROM companion_devices WHERE keyMaterial NOT LIKE 'vault1:%'")?.n) return 0;
  // Overwrite the freed pages that held the clear keys instead of leaving them in the file.
  const previous = Number(db.get<{ secure_delete: number }>('PRAGMA secure_delete')?.secure_delete ?? 0);
  db.exec('PRAGMA secure_delete = ON');
  try { return migrateNow(db, vault); } finally { db.exec(`PRAGMA secure_delete = ${previous ? 'ON' : 'OFF'}`); }
}

function migrateNow(db: CoreDatabase, vault: CompanionVault): number {
  return db.transaction(() => {
    const rows = db.all<{ id: string; keyMaterial: string }>('SELECT id, keyMaterial FROM companion_devices');
    let converted = 0;
    for (const row of rows) {
      if (isVaultSealed(row.keyMaterial)) continue;
      const raw = Buffer.from(row.keyMaterial, 'base64');
      // A malformed legacy key cannot authenticate anything; seal random bytes so the row holds no usable secret.
      db.run('UPDATE companion_devices SET keyMaterial = ? WHERE id = ?', [vault.seal(raw.length === 32 ? raw : crypto.randomBytes(32), deviceKeyPurpose(row.id)), row.id]);
      raw.fill(0);
      converted += 1;
    }
    return converted;
  });
}
