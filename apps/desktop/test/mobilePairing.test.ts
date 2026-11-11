import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DEVICE_IDLE_TTL_MS,
  MAX_PAIRED_DEVICES,
  PAIR_ALPHABET,
  PAIR_CODE_TTL_MS,
  PairingStore,
  describeDevice,
  formatPairingCode,
  generatePairingCode,
  hashSessionToken,
  normalizePairingCode,
} from '../src/host/mobilePairing';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });
function pairFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-pair-'));
  dirs.push(dir);
  return path.join(dir, 'mobile-pair.json');
}
function clock(start = Date.UTC(2026, 10, 10, 12, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Mobile Safari/537.36';

describe('pairing codes', () => {
  it('are 8 symbols from an alphabet without look-alikes, shown as ABCD-EFGH', () => {
    expect(PAIR_ALPHABET).toHaveLength(32);
    expect(PAIR_ALPHABET).not.toMatch(/[01IO]/);
    for (let i = 0; i < 200; i += 1) expect(generatePairingCode()).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(formatPairingCode('ABCDEFGH')).toBe('ABCD-EFGH');
  });

  it('use every symbol without bias (one byte modulo 32)', () => {
    const counts = new Map<string, number>();
    let i = 0;
    const bytes = (n: number) => Buffer.from(Array.from({ length: n }, () => (i++) % 256));
    for (let k = 0; k < 64; k += 1) for (const ch of generatePairingCode(bytes)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(32);
    expect(new Set(counts.values())).toEqual(new Set([16]));
  });

  it('accept what a person types: lower case, dash or spaces; refuse anything else', () => {
    expect(normalizePairingCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizePairingCode(' ABCD EFGH ')).toBe('ABCDEFGH');
    expect(normalizePairingCode('ABCD-EFG')).toBeNull();
    expect(normalizePairingCode('ABCD-EFG1')).toBeNull(); // 1 is not in the alphabet
    expect(normalizePairingCode('H7KM')).toBeNull(); // the old 4-character codes
    expect(normalizePairingCode(undefined)).toBeNull();
    expect(normalizePairingCode({})).toBeNull();
  });
});

describe('PairingStore', () => {
  it('pairs once per code, then the code changes; the session token is never stored', () => {
    const file = pairFile();
    const c = clock();
    const store = new PairingStore(file, c.now);
    const { code } = store.currentCode();
    const first = store.tryPair(formatPairingCode(code).toLowerCase(), ANDROID_CHROME);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.device.name).toBe('Android · Chrome');
    expect(store.currentCode().code).not.toBe(code);
    expect(store.tryPair(code, ANDROID_CHROME)).toEqual({ ok: false, reason: 'invalid' });

    const saved = fs.readFileSync(file, 'utf8');
    expect(saved).not.toContain(first.token);
    expect(saved).toContain(hashSessionToken(first.token));
    expect(store.verify(first.token)?.id).toBe(first.device.id);
    expect(store.verify('not-a-token')).toBeNull();
    expect(store.verify(null)).toBeNull();
  });

  it('a code expires after 10 minutes; the PC is then shown a new one', () => {
    const c = clock();
    const store = new PairingStore(pairFile(), c.now);
    const { code, expiresAt } = store.currentCode();
    expect(expiresAt - c.now()).toBe(PAIR_CODE_TTL_MS);
    c.advance(PAIR_CODE_TTL_MS);
    expect(store.tryPair(code, ANDROID_CHROME)).toEqual({ ok: false, reason: 'expired' });
    expect(store.currentCode().code).not.toBe(code);
  });

  it('keeps the code and phones across a restart', () => {
    const file = pairFile();
    const c = clock();
    const a = new PairingStore(file, c.now);
    const paired = a.tryPair(a.currentCode().code, ANDROID_CHROME);
    if (!paired.ok) throw new Error('pairing failed');
    const code = a.currentCode().code;
    const b = new PairingStore(file, c.now);
    expect(b.droppedOldLogins).toBe(0);
    expect(b.currentCode().code).toBe(code);
    expect(b.verify(paired.token)?.id).toBe(paired.device.id);
  });

  it('forgets one phone, or all; a phone can also sign itself out', () => {
    const c = clock();
    const store = new PairingStore(pairFile(), c.now);
    const tokens: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const r = store.tryPair(store.currentCode().code, ANDROID_CHROME);
      if (r.ok) tokens.push(r.token);
    }
    const [one, two, three] = store.list();
    expect(store.forget(one.id)).toEqual([one.id]);
    expect(store.verify(tokens[0])).toBeNull();
    expect(store.revokeToken(tokens[1])).toBe(true);
    expect(store.list().map((d) => d.id)).toEqual([three.id]);
    expect(store.forget('all')).toEqual([three.id]);
    expect(store.verify(tokens[2])).toBeNull();
    expect(two).toBeTruthy();
  });

  it('forgets a phone not seen for 90 days', () => {
    const c = clock();
    const store = new PairingStore(pairFile(), c.now);
    const r = store.tryPair(store.currentCode().code, ANDROID_CHROME);
    if (!r.ok) throw new Error('pairing failed');
    c.advance(DEVICE_IDLE_TTL_MS - 1000);
    expect(store.verify(r.token)).not.toBeNull();
    c.advance(DEVICE_IDLE_TTL_MS + 1000);
    expect(store.verify(r.token)).toBeNull();
    expect(store.list()).toHaveLength(0);
  });

  it('keeps at most 20 phones, dropping the least recently seen', () => {
    const c = clock();
    const store = new PairingStore(pairFile(), c.now);
    for (let i = 0; i < MAX_PAIRED_DEVICES + 3; i += 1) {
      store.tryPair(store.currentCode().code, ANDROID_CHROME);
      c.advance(1000);
    }
    expect(store.list()).toHaveLength(MAX_PAIRED_DEVICES);
  });

  it('drops every login from an older build: none works again, a fresh code is issued, nothing old stays on disk', () => {
    const file = pairFile();
    const hostToken = 'old-host-token-value-0001';
    const phones = ['old-phone-session-aaaa', 'old-phone-session-bbbb', 'old-phone-session-cccc'];
    fs.writeFileSync(file, JSON.stringify({
      code: 'H7KM',
      token: hostToken,
      sessions: [phones[0], hostToken, phones[1]],
      pairedTokens: [phones[1], phones[2]],
      updatedAt: '2026-11-01T10:00:00.000Z',
    }));
    const c = clock();
    const store = new PairingStore(file, c.now);

    // 1. The old logins are dropped: three phones (the host token and the repeated token are not counted again).
    expect(store.droppedOldLogins).toBe(3);
    expect(store.list()).toEqual([]);
    // 2. No old session token logs in any more, and neither does the old host token.
    for (const old of [...phones, hostToken]) expect(store.verify(old)).toBeNull();
    // 3. A fresh one-time code replaces the old 4-character one.
    const { code, expiresAt } = store.currentCode();
    expect(code).toMatch(/^[23456789A-HJ-NP-Z]{8}$/);
    expect(expiresAt - c.now()).toBe(PAIR_CODE_TTL_MS);
    expect(store.tryPair('H7KM', ANDROID_CHROME)).toEqual({ ok: false, reason: 'invalid' });

    // Nothing old stays on disk: not in the new file (not even hashed), and no backup or temp file beside it.
    expect(fs.readdirSync(path.dirname(file))).toEqual(['mobile-pair.json']);
    const saved = fs.readFileSync(file, 'utf8');
    for (const old of [...phones, hostToken, 'H7KM', ...[...phones, hostToken].map(hashSessionToken)]) expect(saved).not.toContain(old);
    expect(JSON.parse(saved)).toMatchObject({ version: 2, devices: [] });

    // A phone pairs as usual with the new code, and the next start has nothing old left to drop.
    expect(store.tryPair(code, ANDROID_CHROME).ok).toBe(true);
    const restarted = new PairingStore(file, c.now);
    expect(restarted.droppedOldLogins).toBe(0);
    expect(restarted.list()).toHaveLength(1);
  });

  it('a broken or foreign file starts clean instead of failing', () => {
    const file = pairFile();
    fs.writeFileSync(file, '{ not json');
    const store = new PairingStore(file, clock().now);
    expect(store.list()).toEqual([]);
    expect(store.droppedOldLogins).toBe(0);
    expect(store.currentCode().code).toHaveLength(8);
  });
});

describe('describeDevice', () => {
  it('names the phone briefly, never with the full user agent', () => {
    expect(describeDevice(ANDROID_CHROME)).toBe('Android · Chrome');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1')).toBe('iPhone · Safari');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/27.0 Chrome/125.0.0.0 Mobile Safari/537.36')).toBe('Android · Samsung Internet');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36 Edg/146.0.0.0')).toBe('Windows · Edge');
    expect(describeDevice(undefined)).toBe('Unknown device');
  });
});
