/**
 * Phone pairing for Pandesh Mobile: the pairing code shown on the PC and the phones paired with it.
 *
 * - The code is 8 characters from a 32-symbol alphabet without look-alikes (40 bits), shown as ABCD-EFGH.
 *   It works once and expires after 10 minutes; a successful pairing replaces it at once.
 * - A paired phone holds a random session token in an HttpOnly cookie. Only the token's SHA-256 is stored here,
 *   so the pairing file alone cannot be replayed as a login.
 * - A phone not seen for 90 days is forgotten.
 *
 * Earlier builds kept a 4-character code that never changed and the raw session tokens. Loading such a file keeps
 * none of it: phones paired with an older build pair again with a new one-time code, and the new file replaces the
 * old one, so no copy of its values stays on disk.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** No 0/O or 1/I. 32 symbols, so one random byte modulo 32 is unbiased (256 = 8 × 32). */
export const PAIR_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
export const PAIR_CODE_LENGTH = 8;
export const PAIR_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_IDLE_TTL_MS = 90 * 24 * 60 * 60_000;
export const MAX_PAIRED_DEVICES = 20;
/** lastSeenAt is kept in memory on every request but written to disk at most this often per phone. */
const LAST_SEEN_PERSIST_MS = 10 * 60_000;

export interface PairedDevice {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
}

interface StoredDevice extends PairedDevice {
  tokenHash: string;
}

interface PairFileV2 {
  version: 2;
  code: string;
  codeIssuedAt: string;
  devices: StoredDevice[];
  updatedAt: string;
}

export type PairResult =
  | { ok: true; token: string; device: PairedDevice }
  | { ok: false; reason: 'invalid' | 'expired' };

export function generatePairingCode(randomBytes: (n: number) => Buffer = crypto.randomBytes): string {
  const bytes = randomBytes(PAIR_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i += 1) code += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return code;
}

/** "abcd efgh" or "ABCD-EFGH" → "ABCDEFGH". Anything that cannot be a code (wrong length, other symbols) → null. */
export function normalizePairingCode(input: unknown): string | null {
  const s = String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
  if (s.length !== PAIR_CODE_LENGTH) return null;
  for (const ch of s) if (!PAIR_ALPHABET.includes(ch)) return null;
  return s;
}

export function formatPairingCode(code: string): string {
  return code.length === PAIR_CODE_LENGTH ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** A short, human name for the phone list on the PC ("Android · Chrome"). Never the full user agent. */
export function describeDevice(userAgent: string | undefined): string {
  const ua = String(userAgent ?? '');
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
      : /Android/.test(ua) ? 'Android'
        : /Windows/.test(ua) ? 'Windows'
          : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
            : /Linux/.test(ua) ? 'Linux'
              : '';
  const browser = /EdgA?\//.test(ua) ? 'Edge'
    : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
      : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
        : /OPR\//.test(ua) ? 'Opera'
          : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari'
              : '';
  const name = [os, browser].filter(Boolean).join(' · ');
  return name || 'Unknown device';
}

function publicDevice(d: StoredDevice): PairedDevice {
  const { tokenHash: _omit, ...rest } = d;
  return rest;
}

export class PairingStore {
  private code = '';
  private codeIssuedAt = 0;
  private devices: StoredDevice[] = [];
  private readonly persistedSeen = new Map<string, number>();
  private oldLoginsDropped = 0;

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
    private readonly randomBytes: (n: number) => Buffer = crypto.randomBytes,
  ) {
    this.load();
  }

  static fileIn(dataDir: string): string {
    return path.join(dataDir, 'mobile-pair.json');
  }

  /** How many phone logins from an older build's file were dropped when this store loaded it (a count, nothing else). */
  get droppedOldLogins(): number {
    return this.oldLoginsDropped;
  }

  /** The current code, replaced first when it has expired. */
  currentCode(): { code: string; issuedAt: number; expiresAt: number } {
    if (!this.code || this.now() >= this.codeIssuedAt + PAIR_CODE_TTL_MS) this.rotateCode();
    return { code: this.code, issuedAt: this.codeIssuedAt, expiresAt: this.codeIssuedAt + PAIR_CODE_TTL_MS };
  }

  rotateCode(): void {
    this.code = generatePairingCode(this.randomBytes);
    this.codeIssuedAt = this.now();
    this.save();
  }

  tryPair(input: unknown, userAgent: string | undefined): PairResult {
    const candidate = normalizePairingCode(input);
    if (!candidate || !this.code) return { ok: false, reason: 'invalid' };
    if (!sameText(candidate, this.code)) return { ok: false, reason: 'invalid' };
    if (this.now() >= this.codeIssuedAt + PAIR_CODE_TTL_MS) return { ok: false, reason: 'expired' };

    const token = crypto.randomBytes(32).toString('base64url');
    const at = new Date(this.now()).toISOString();
    const device: StoredDevice = {
      id: crypto.randomBytes(6).toString('hex'),
      name: describeDevice(userAgent),
      pairedAt: at,
      lastSeenAt: at,
      tokenHash: hashSessionToken(token),
    };
    this.devices.push(device);
    this.persistedSeen.set(device.id, this.now());
    this.trimDevices();
    // Single use: the code that paired this phone never pairs another.
    this.code = generatePairingCode(this.randomBytes);
    this.codeIssuedAt = this.now();
    this.save();
    return { ok: true, token, device: publicDevice(device) };
  }

  /** The paired phone a session token belongs to, or null. Seeing it refreshes its last-seen time. */
  verify(token: string | null | undefined): PairedDevice | null {
    if (!token) return null;
    const hash = hashSessionToken(token);
    const device = this.devices.find((d) => sameText(d.tokenHash, hash));
    if (!device) return null;
    const lastSeen = Date.parse(device.lastSeenAt ?? device.pairedAt);
    if (Number.isFinite(lastSeen) && this.now() - lastSeen > DEVICE_IDLE_TTL_MS) {
      this.devices = this.devices.filter((d) => d !== device);
      this.save();
      return null;
    }
    device.lastSeenAt = new Date(this.now()).toISOString();
    const persisted = this.persistedSeen.get(device.id) ?? 0;
    if (this.now() - persisted >= LAST_SEEN_PERSIST_MS) {
      this.persistedSeen.set(device.id, this.now());
      this.save();
    }
    return publicDevice(device);
  }

  /** Signs one phone out (its own logout). */
  revokeToken(token: string | null | undefined): boolean {
    if (!token) return false;
    const hash = hashSessionToken(token);
    const before = this.devices.length;
    this.devices = this.devices.filter((d) => !sameText(d.tokenHash, hash));
    if (this.devices.length === before) return false;
    this.save();
    return true;
  }

  /** Forgets one phone by id, or every phone with 'all'. Returns the ids removed. */
  forget(id: string): string[] {
    const removed = this.devices.filter((d) => id === 'all' || d.id === id).map((d) => d.id);
    if (removed.length === 0) return [];
    this.devices = this.devices.filter((d) => !removed.includes(d.id));
    this.save();
    return removed;
  }

  list(): PairedDevice[] {
    return this.devices.map(publicDevice);
  }

  /** Writes the in-memory last-seen times (on stop). */
  flush(): void {
    this.save();
  }

  private trimDevices(): void {
    if (this.devices.length <= MAX_PAIRED_DEVICES) return;
    const seen = (d: StoredDevice) => Date.parse(d.lastSeenAt ?? d.pairedAt) || 0;
    this.devices.sort((a, b) => seen(b) - seen(a));
    this.devices = this.devices.slice(0, MAX_PAIRED_DEVICES);
  }

  private load(): void {
    let raw: any = null;
    try {
      if (fs.existsSync(this.file)) raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      raw = null;
    }
    if (raw && raw.version === 2 && Array.isArray(raw.devices)) {
      const file = raw as PairFileV2;
      this.devices = file.devices
        .filter((d) => d && typeof d.tokenHash === 'string' && /^[0-9a-f]{64}$/.test(d.tokenHash) && typeof d.id === 'string')
        .map((d) => ({
          id: d.id,
          name: typeof d.name === 'string' && d.name ? d.name.slice(0, 80) : 'Unknown device',
          pairedAt: typeof d.pairedAt === 'string' ? d.pairedAt : new Date(this.now()).toISOString(),
          lastSeenAt: typeof d.lastSeenAt === 'string' ? d.lastSeenAt : null,
          tokenHash: d.tokenHash,
        }));
      const issued = Date.parse(file.codeIssuedAt);
      if (normalizePairingCode(file.code) === file.code && Number.isFinite(issued)) {
        this.code = file.code;
        this.codeIssuedAt = issued;
      }
      for (const d of this.devices) this.persistedSeen.set(d.id, this.now());
      if (!this.code) this.rotateCode();
      return;
    }

    // Before this format: { code, token, sessions[], pairedTokens[] }, with raw session tokens and a code that never
    // changed. None of it is carried over (the owner's decision): phones paired with an older build pair again. The
    // old `token` was a host-side secret that was also accepted as a login; it is dropped too, but not counted as a
    // phone, since no phone ever held it.
    if (raw && typeof raw === 'object') {
      const hostToken = typeof raw.token === 'string' ? raw.token : null;
      const logins = new Set<string>();
      for (const list of [raw.sessions, raw.pairedTokens]) {
        if (Array.isArray(list)) for (const t of list) if (typeof t === 'string' && t && t !== hostToken) logins.add(t);
      }
      this.oldLoginsDropped = logins.size;
    }
    // Starts with no phones and a fresh one-time code. The save replaces the old file in place (temp file, then
    // rename), so none of the old values stay on disk.
    this.rotateCode();
  }

  private save(): void {
    const data: PairFileV2 = {
      version: 2,
      code: this.code,
      codeIssuedAt: new Date(this.codeIssuedAt || this.now()).toISOString(),
      devices: this.devices,
      updatedAt: new Date(this.now()).toISOString(),
    };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // A read-only profile keeps working from memory; pairing just does not survive a restart.
    }
  }
}
