/**
 * Persistent provider credentials for Pandesh (host side only).
 *
 * Active store: Windows Credential Manager, generic credentials named `pandesh/<provider>/api-key`, persisted for this
 * Windows user on this machine. They live outside the Git checkout, the install folder, the app's data folder,
 * database exports and the renderer, so rebuilding, reinstalling, updating or recloning Pandesh never touches them.
 * Credential Manager has no Node binding here, so a short Windows PowerShell child calls advapi32 Cred* through
 * P/Invoke; secrets cross only its stdin/stdout, never its command line, and no output is logged.
 *
 * Legacy store: the earlier Electron `safeStorage` files (`cloud-provider-<id>.credential.bin`) are still READ, so
 * existing installs keep working. Copying them into Credential Manager is an explicit user action (`migrateLegacy`),
 * and the legacy files are left in place unless the user removes the key.
 *
 * Recovery: `exportBackup` writes a portable vault encrypted with a key derived from a passphrase the user types
 * (scrypt N=2^17, r=8, p=1 → AES-256-GCM). It is not bound to Windows or to this profile, so it restores on a clean
 * Windows install or another PC. Pandesh never stores the passphrase, never writes a plaintext export, and restores
 * only the providers the user ticks.
 */
import { execFile } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SecretBox } from './openRouterCredential';
import { CLOUD_PROVIDER_ID_PATTERN, cloudProviderKeyPath, maskedKeyHint } from './cloudProviderSettings';

/** Stable namespace; tests override it so they never touch a real `pandesh/` credential. */
export function credentialNamespace(): string {
  const ns = process.env.PANDESH_CREDENTIAL_NAMESPACE?.trim();
  return ns && /^[a-z0-9][a-z0-9-]{1,30}$/.test(ns) ? ns : 'pandesh';
}

export function credentialTarget(providerId: string, ns = credentialNamespace()): string {
  if (!CLOUD_PROVIDER_ID_PATTERN.test(providerId)) throw new Error('Invalid provider id');
  return `${ns}/${providerId}/api-key`;
}

export function providerFromTarget(target: string, ns = credentialNamespace()): string | undefined {
  const match = new RegExp(`^${ns}/([a-z0-9][a-z0-9-]{1,40})/api-key$`).exec(target);
  return match?.[1];
}

// ── Windows Credential Manager ───────────────────────────────────────────────────────────────

const WINCRED_CS = `
using System; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class PandeshCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public uint Flags; public uint Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public uint CredentialBlobSize; public IntPtr CredentialBlob;
    public uint Persist; public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredWriteW(ref CREDENTIAL c, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredReadW(string target, uint type, uint flags, out IntPtr c);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredDeleteW(string target, uint type, uint flags);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CredEnumerateW(string filter, uint flags, out uint count, out IntPtr creds);
  [DllImport("advapi32.dll")] static extern void CredFree(IntPtr p);
  public static void Write(string target, byte[] secret) {
    var c = new CREDENTIAL(); c.Type = 1; c.TargetName = target; c.Persist = 2; c.UserName = "Pandesh"; c.Comment = "Pandesh provider API key";
    c.CredentialBlobSize = (uint)secret.Length; c.CredentialBlob = Marshal.AllocHGlobal(secret.Length);
    try { Marshal.Copy(secret, 0, c.CredentialBlob, secret.Length); if (!CredWriteW(ref c, 0)) throw new Exception("CredWrite failed: " + Marshal.GetLastWin32Error()); }
    finally { for (int i = 0; i < secret.Length; i++) Marshal.WriteByte(c.CredentialBlob, i, 0); Marshal.FreeHGlobal(c.CredentialBlob); }
  }
  public static byte[] Read(string target) {
    IntPtr p; if (!CredReadW(target, 1, 0, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return null; throw new Exception("CredRead failed: " + e); }
    try { var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL)); var b = new byte[c.CredentialBlobSize]; Marshal.Copy(c.CredentialBlob, b, 0, b.Length); return b; } finally { CredFree(p); }
  }
  public static bool Delete(string target) { if (CredDeleteW(target, 1, 0)) return true; int e = Marshal.GetLastWin32Error(); if (e == 1168) return false; throw new Exception("CredDelete failed: " + e); }
  public static string[] List(string filter) {
    uint n; IntPtr p; var r = new List<string>();
    if (!CredEnumerateW(filter, 0, out n, out p)) { int e = Marshal.GetLastWin32Error(); if (e == 1168) return r.ToArray(); throw new Exception("CredEnumerate failed: " + e); }
    try { for (int i = 0; i < n; i++) { var cp = Marshal.ReadIntPtr(p, i * IntPtr.Size); var c = (CREDENTIAL)Marshal.PtrToStructure(cp, typeof(CREDENTIAL)); if (c.Type == 1) r.Add(c.TargetName); } } finally { CredFree(p); }
    return r.ToArray();
  }
}`;

/** The request travels on stdin as base64 JSON; the reply is one JSON line. Nothing secret is on the command line. */
const WINCRED_PS = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition @'\n${WINCRED_CS}\n'@`,
  '$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())) | ConvertFrom-Json',
  '$out = @{ ok = $true }',
  'try {',
  "  switch ($req.op) {",
  "    'write' { [PandeshCred]::Write($req.target, [Convert]::FromBase64String($req.secret)) }",
  "    'delete' { $out.deleted = [PandeshCred]::Delete($req.target) }",
  "    'readAll' { $items = @(); foreach ($t in [PandeshCred]::List($req.filter)) { $b = [PandeshCred]::Read($t); if ($b -ne $null) { $items += @{ target = $t; secret = [Convert]::ToBase64String($b) } } }; $out.items = $items }",
  "    'list' { $out.targets = @([PandeshCred]::List($req.filter)) }",
  '  }',
  '} catch { $out = @{ ok = $false; error = $_.Exception.Message } }',
  '[Console]::Out.Write(($out | ConvertTo-Json -Compress -Depth 4))',
].join('\n');

interface WinCredReply { ok: boolean; error?: string; deleted?: boolean; targets?: string[]; items?: Array<{ target: string; secret: string }> }

function runWinCred(request: Record<string, string>): Promise<WinCredReply> {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(WINCRED_PS, 'utf16le').toString('base64');
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout: 45_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(new Error(`Windows Credential Manager call failed: ${err.message.split('\n')[0].slice(0, 160)}`)); return; }
      try {
        const reply = JSON.parse(String(stdout).trim()) as WinCredReply;
        if (!reply.ok) reject(new Error(`Windows Credential Manager: ${String(reply.error ?? 'unknown error').slice(0, 160)}`));
        else resolve(reply);
      } catch {
        reject(new Error('Windows Credential Manager returned an unreadable reply'));
      }
    });
    child.stdin?.end(Buffer.from(JSON.stringify(request), 'utf8').toString('base64'));
  });
}

export interface CredentialBackend {
  readonly kind: 'windows-credential-manager' | 'memory';
  readAll(): Promise<Map<string, string>>;
  write(providerId: string, secret: string): Promise<void>;
  remove(providerId: string): Promise<boolean>;
}

export class WindowsCredentialBackend implements CredentialBackend {
  readonly kind = 'windows-credential-manager' as const;
  constructor(private readonly ns = credentialNamespace()) {}
  async readAll(): Promise<Map<string, string>> {
    const reply = await runWinCred({ op: 'readAll', filter: `${this.ns}/*` });
    const out = new Map<string, string>();
    for (const item of Array.isArray(reply.items) ? reply.items : reply.items ? [reply.items as never] : []) {
      const provider = providerFromTarget(item.target, this.ns);
      if (provider) out.set(provider, Buffer.from(item.secret, 'base64').toString('utf8'));
    }
    return out;
  }
  async write(providerId: string, secret: string): Promise<void> {
    await runWinCred({ op: 'write', target: credentialTarget(providerId, this.ns), secret: Buffer.from(secret, 'utf8').toString('base64') });
  }
  async remove(providerId: string): Promise<boolean> {
    return Boolean((await runWinCred({ op: 'delete', target: credentialTarget(providerId, this.ns) })).deleted);
  }
}

/** For tests and non-Windows development only. */
export class MemoryCredentialBackend implements CredentialBackend {
  readonly kind = 'memory' as const;
  readonly values = new Map<string, string>();
  async readAll(): Promise<Map<string, string>> { return new Map(this.values); }
  async write(providerId: string, secret: string): Promise<void> { this.values.set(providerId, secret); }
  async remove(providerId: string): Promise<boolean> { return this.values.delete(providerId); }
}

export function defaultCredentialBackend(): CredentialBackend | null {
  return process.platform === 'win32' ? new WindowsCredentialBackend() : null;
}

// ── vault ────────────────────────────────────────────────────────────────────────────────────

export interface CredentialStatus { configured: boolean; source: 'credential-manager' | 'legacy-encrypted-file' | null; hint: string | null }

export class CredentialVault {
  private cache: Map<string, string> | undefined;
  private loading: Promise<Map<string, string>> | undefined;

  constructor(private readonly dataDir: string, private readonly backend: CredentialBackend | null, private readonly legacyBox: () => SecretBox | null) {}

  get backendKind(): string { return this.backend?.kind ?? 'legacy-only'; }

  private async active(): Promise<Map<string, string>> {
    if (this.cache) return this.cache;
    if (!this.backend) return (this.cache = new Map());
    this.loading ??= this.backend.readAll().then((values) => { this.cache = values; return values; }).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  /** Forget the in-memory copy so the next read comes from Credential Manager again. */
  invalidate(): void { this.cache = undefined; }

  private legacy(providerId: string): string | null {
    const box = this.legacyBox();
    if (!box?.isEncryptionAvailable()) return null;
    try {
      const plain = box.decryptString(fs.readFileSync(cloudProviderKeyPath(this.dataDir, providerId))).trim();
      return plain || null;
    } catch {
      return null;
    }
  }

  async get(providerId: string): Promise<string | null> {
    return (await this.active()).get(providerId) ?? this.legacy(providerId);
  }

  async status(providerIds: readonly string[]): Promise<Record<string, CredentialStatus>> {
    let active: Map<string, string>;
    try { active = await this.active(); } catch { active = new Map(); }
    const out: Record<string, CredentialStatus> = {};
    for (const id of providerIds) {
      const fromManager = active.get(id);
      const value = fromManager ?? this.legacy(id);
      out[id] = { configured: Boolean(value), source: fromManager ? 'credential-manager' : value ? 'legacy-encrypted-file' : null, hint: value ? maskedKeyHint(value) : null };
    }
    return out;
  }

  /** Stores in Credential Manager (legacy encrypted file only where Credential Manager is unavailable). */
  async set(providerId: string, apiKey: string): Promise<void> {
    const trimmed = apiKey.trim();
    if (!trimmed) throw new Error('API key is empty');
    if (trimmed.length > 4096) throw new Error('API key is too long');
    if (!CLOUD_PROVIDER_ID_PATTERN.test(providerId)) throw new Error('Invalid provider id');
    if (this.backend) {
      await this.backend.write(providerId, trimmed);
      (await this.active()).set(providerId, trimmed);
      return;
    }
    const box = this.legacyBox();
    if (!box?.isEncryptionAvailable()) throw new Error('no secure credential store is available');
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(cloudProviderKeyPath(this.dataDir, providerId), box.encryptString(trimmed), { mode: 0o600 });
  }

  /** Removes the key everywhere Pandesh keeps one. This is the user's explicit "remove key". */
  async delete(providerId: string): Promise<void> {
    if (this.backend) {
      await this.backend.remove(providerId);
      (await this.active()).delete(providerId);
    }
    try { fs.unlinkSync(cloudProviderKeyPath(this.dataDir, providerId)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /** Providers with a legacy encrypted file that Credential Manager does not hold yet. */
  async legacyOnly(providerIds: readonly string[]): Promise<string[]> {
    const active = await this.active();
    return providerIds.filter((id) => !active.has(id) && this.legacy(id) !== null);
  }

  /**
   * Copies legacy keys into Credential Manager and verifies each by reading it back (compared by hash; the value is
   * never printed). The legacy file is kept. Explicit user action only.
   */
  async migrateLegacy(providerIds: readonly string[]): Promise<Array<{ provider: string; migrated: boolean; reason?: string }>> {
    if (!this.backend) throw new Error('Windows Credential Manager is not available here');
    const results: Array<{ provider: string; migrated: boolean; reason?: string }> = [];
    for (const id of providerIds) {
      const value = this.legacy(id);
      if (!value) { results.push({ provider: id, migrated: false, reason: 'no legacy key' }); continue; }
      await this.backend.write(id, value);
      this.invalidate();
      const back = (await this.active()).get(id);
      const same = back !== undefined && timingSafeEqual(createHash('sha256').update(back).digest(), createHash('sha256').update(value).digest());
      results.push(same ? { provider: id, migrated: true } : { provider: id, migrated: false, reason: 'read-back did not match' });
    }
    return results;
  }

  // ── portable encrypted backup ──────────────────────────────────────────────────────────────

  async exportBackup(file: string, passphrase: string, providerIds: readonly string[]): Promise<{ file: string; providers: string[] }> {
    const entries: BackupEntry[] = [];
    for (const id of providerIds) {
      const value = await this.get(id);
      if (value) entries.push({ provider: id, target: credentialTarget(id, 'pandesh'), secret: value, savedAt: new Date().toISOString() });
    }
    if (entries.length === 0) throw new Error('none of the chosen providers has a stored key');
    await writeEncryptedBackup(file, passphrase, entries);
    return { file, providers: entries.map((e) => e.provider) };
  }

  /** Restores only the approved providers into the active store. Returns provider ids, never values. */
  async restoreBackup(file: string, passphrase: string, approved: readonly string[]): Promise<{ restored: string[]; skipped: string[] }> {
    const entries = await readEncryptedBackup(file, passphrase);
    const allowed = new Set(approved);
    const restored: string[] = [];
    const skipped: string[] = [];
    for (const entry of entries) {
      if (!allowed.has(entry.provider)) { skipped.push(entry.provider); continue; }
      await this.set(entry.provider, entry.secret);
      restored.push(entry.provider);
    }
    return { restored, skipped };
  }
}

// ── backup file format ───────────────────────────────────────────────────────────────────────

export interface BackupEntry { provider: string; target: string; secret: string; savedAt: string }

export const BACKUP_FORMAT = 'pandesh-credential-backup';
export const BACKUP_EXTENSION = '.pandesh-keys';
export const MIN_PASSPHRASE_LENGTH = 12;
const SCRYPT = { N: 1 << 17, r: 8, p: 1, keyLen: 32, maxmem: 256 * 1024 * 1024 };

function deriveKey(passphrase: string, salt: Buffer, params = SCRYPT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(passphrase.normalize('NFKC'), salt, params.keyLen, { N: params.N, r: params.r, p: params.p, maxmem: params.maxmem }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function writeEncryptedBackup(file: string, passphrase: string, entries: readonly BackupEntry[]): Promise<void> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters`);
  for (const e of entries) if (!CLOUD_PROVIDER_ID_PATTERN.test(e.provider)) throw new Error('Invalid provider id in backup');
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(passphrase, salt);
  const header = { format: BACKUP_FORMAT, version: 1, createdAt: new Date().toISOString(), kdf: { name: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt: salt.toString('base64') }, cipher: { name: 'aes-256-gcm', iv: iv.toString('base64') } };
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  // The header is authenticated too, so the KDF parameters cannot be swapped.
  cipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
  const plain = Buffer.from(JSON.stringify({ entries }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  plain.fill(0);
  key.fill(0);
  const doc = { ...header, tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export async function readEncryptedBackup(file: string, passphrase: string): Promise<BackupEntry[]> {
  let doc: Record<string, any>;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('That file is not a Pandesh credential backup'); }
  if (doc?.format !== BACKUP_FORMAT || doc.version !== 1 || doc.kdf?.name !== 'scrypt' || doc.cipher?.name !== 'aes-256-gcm') throw new Error('That file is not a Pandesh credential backup');
  const N = Number(doc.kdf.N); const r = Number(doc.kdf.r); const p = Number(doc.kdf.p);
  if (!(N >= 1 << 15 && N <= 1 << 20 && r >= 8 && r <= 16 && p >= 1 && p <= 4)) throw new Error('Backup key-derivation parameters are outside the accepted range');
  const header = { format: doc.format, version: doc.version, createdAt: doc.createdAt, kdf: doc.kdf, cipher: doc.cipher };
  const key = await deriveKey(passphrase, Buffer.from(String(doc.kdf.salt), 'base64'), { ...SCRYPT, N, r, p });
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(String(doc.cipher.iv), 'base64'));
    decipher.setAAD(Buffer.from(JSON.stringify(header), 'utf8'));
    decipher.setAuthTag(Buffer.from(String(doc.tag), 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(String(doc.ciphertext), 'base64')), decipher.final()]);
    const parsed = JSON.parse(plain.toString('utf8')) as { entries?: BackupEntry[] };
    plain.fill(0);
    return (parsed.entries ?? []).filter((e) => typeof e?.provider === 'string' && CLOUD_PROVIDER_ID_PATTERN.test(e.provider) && typeof e.secret === 'string' && e.secret.length > 0);
  } catch {
    throw new Error('Wrong passphrase, or the backup file was changed');
  } finally {
    key.fill(0);
  }
}

/** Provider ids in a backup (after unlocking), so the user can choose what to restore. Never the values. */
export async function listBackupProviders(file: string, passphrase: string): Promise<string[]> {
  return (await readEncryptedBackup(file, passphrase)).map((e) => e.provider);
}
