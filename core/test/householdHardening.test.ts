/**
 * Household OS hardening: device keys sealed at rest (OS-protected vault), the companion listener over pinned TLS,
 * replay rejection that survives a restart, and document reading as its own, revocable decision.
 * Real database, real files, a real HTTPS listener; Windows DPAPI itself where the platform has it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as https from 'node:https';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as net from 'node:net';

/** A port nothing is listening on right now (a random port could already be taken by another process). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
}
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import {
  checkFreshness, companionDeviceKey, createCompanionPairingCode, openCompanionMessage, pairingKey, pairingProof, redeemCompanionPairing, sealCompanionMessage,
} from '../domain/companionSync';
import { CompanionVault, migrateCompanionDeviceKeys } from '../runtime/companionVault';
import { CompanionServerController, writeCompanionSettings } from '../api/companionServer';
import { windowsDpapiProtector, type SecretProtector } from '../platform/osSecretProtector';
import { createPcOrganizerAdapter, proposeOrganization, resolveTargetBase } from '../runtime/pcOrganizer';
import { createHouseholdCapabilityAdapter } from '../runtime/householdCapability';
import { documentReadPolicy, grantDocumentReading, listDocumentReadGrants, revokeDocumentReading } from '../domain/documentReadGrants';
import { scanObligationSources } from '../runtime/householdService';

let dir: string;
let dbPath: string;
let db: CoreDatabase;

/** A stand-in OS store: reversible, but bound to a per-"account" secret so a second account cannot open the blob. */
function fakeProtector(account = 'alice'): SecretProtector & { calls: number } {
  const k = crypto.createHash('sha256').update(`account:${account}`).digest();
  const p = {
    kind: `test store (${account})`, calls: 0,
    async protect(plain: Buffer) { p.calls += 1; const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', k, iv); return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]); },
    async unprotect(blob: Buffer) { p.calls += 1; const d = crypto.createDecipheriv('aes-256-gcm', k, blob.subarray(0, 12)); d.setAuthTag(blob.subarray(blob.length - 16)); return Buffer.concat([d.update(blob.subarray(12, blob.length - 16)), d.final()]); },
  };
  return p;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'household-hardening-'));
  dbPath = path.join(dir, 'core.db');
  ({ db } = openCoreDatabase(dbPath));
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function pair(vault: CompanionVault, deviceId = 'jugaad-test-device', tlsFingerprint?: string) {
  const { code } = createCompanionPairingCode();
  const salt = crypto.randomBytes(16);
  const key = pairingKey(code, salt);
  const r = redeemCompanionPairing(db, vault, { deviceId, label: 'Pixel', salt: salt.toString('base64'), proof: pairingProof(key, deviceId).toString('base64'), tlsFingerprint });
  return { r, opened: JSON.parse(openCompanionMessage(key, `${deviceId}:pair`, r.sealedKey)) as { deviceKey: string; tlsFingerprint?: string } };
}

describe('device keys at rest', () => {
  it('stores a new pairing sealed by the vault, never the key itself', async () => {
    const vault = new CompanionVault(dir, fakeProtector());
    await vault.open();
    const { opened } = pair(vault, 'jugaad-test-device', 'ab'.repeat(32));
    const row = db.get<{ keyMaterial: string }>('SELECT keyMaterial FROM companion_devices WHERE id = ?', ['jugaad-test-device'])!;
    expect(row.keyMaterial.startsWith('vault1:')).toBe(true);
    expect(row.keyMaterial).not.toContain(opened.deviceKey);
    expect(companionDeviceKey(db, 'jugaad-test-device', vault)!.toString('base64')).toBe(opened.deviceKey);
    expect(opened.tlsFingerprint).toBe('ab'.repeat(32));
    // The vault file holds only the OS-protected blob.
    const vaultFile = fs.readFileSync(path.join(dir, 'companion-vault.json'), 'utf8');
    expect(JSON.parse(vaultFile)).toMatchObject({ v: 1, protector: 'test store (alice)' });
  });

  it('migrates keys stored in the clear, refuses them until then, and is idempotent', async () => {
    const legacy = crypto.randomBytes(32);
    db.run("INSERT INTO companion_devices (id, label, keyMaterial, createdAt, lastSeenAt, lastPulledRevision, revokedAt) VALUES ('jugaad-legacy-01', 'Old phone', ?, '2026-11-04T00:00:00Z', NULL, 3, NULL)", [legacy.toString('base64')]);
    const vault = new CompanionVault(dir, fakeProtector());
    await vault.open();
    expect(companionDeviceKey(db, 'jugaad-legacy-01', vault)).toBeNull();
    expect(migrateCompanionDeviceKeys(db, vault)).toBe(1);
    expect(migrateCompanionDeviceKeys(db, vault)).toBe(0);
    const stored = db.get<{ keyMaterial: string; lastPulledRevision: number }>('SELECT keyMaterial, lastPulledRevision FROM companion_devices WHERE id = ?', ['jugaad-legacy-01'])!;
    expect(stored.keyMaterial).not.toContain(legacy.toString('base64'));
    expect(stored.lastPulledRevision).toBe(3);
    expect(companionDeviceKey(db, 'jugaad-legacy-01', vault)!.equals(legacy)).toBe(true);
  });

  it('a copied data folder opened by another account yields no keys and no listener', async () => {
    const vault = new CompanionVault(dir, fakeProtector('alice'));
    await vault.open();
    pair(vault);
    const stolen = new CompanionVault(dir, fakeProtector('mallory'));
    await expect(stolen.open()).rejects.toThrow(/could not open the companion vault/);
    expect(companionDeviceKey(db, 'jugaad-test-device', stolen)).toBeNull();
    const noStore = new CompanionVault(dir, null);
    await expect(noStore.open()).rejects.toThrow(/no OS secret store/);
  });

  it.runIf(process.platform === 'win32')('Windows DPAPI protects and opens the vault key for this account', async () => {
    const secret = crypto.randomBytes(32);
    const blob = await windowsDpapiProtector.protect(secret);
    expect(blob.includes(secret)).toBe(false);
    expect((await windowsDpapiProtector.unprotect(blob)).equals(secret)).toBe(true);
    const vault = new CompanionVault(dir, windowsDpapiProtector);
    await vault.open();
    const reopened = new CompanionVault(dir, windowsDpapiProtector);
    await reopened.open();
    const sealed = vault.seal(secret, 'p');
    expect(reopened.unseal(sealed, 'p')!.equals(secret)).toBe(true);
  }, 60_000);
});

describe('replay rejection', () => {
  it('a nonce seen before a Core restart is still refused after it', () => {
    const now = Date.now();
    checkFreshness(db, 'jugaad-test-device', now, 'nonce-aaaaaaaa', now);
    expect(() => checkFreshness(db, 'jugaad-test-device', now, 'nonce-aaaaaaaa', now)).toThrow(/replayed/);
    db.close();
    ({ db } = openCoreDatabase(dbPath));
    expect(() => checkFreshness(db, 'jugaad-test-device', now, 'nonce-aaaaaaaa', now + 1000)).toThrow(/replayed/);
    expect(() => checkFreshness(db, 'jugaad-test-device', now - 3_600_000, 'nonce-bbbbbbbb', now)).toThrow(/too old/);
    checkFreshness(db, 'other-device-01', now, 'nonce-aaaaaaaa', now);
  });
});

function request(mod: typeof https | typeof http, port: number, urlPath: string, body: unknown, extra: https.RequestOptions = {}): Promise<{ status: number; json: any; peerFingerprint: string | null }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = mod.request({ host: '127.0.0.1', port, path: urlPath, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 5000, ...extra }, (res) => {
      const sock = res.socket as import('node:tls').TLSSocket;
      const peer = typeof sock.getPeerCertificate === 'function' ? sock.getPeerCertificate() : null;
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null, peerFingerprint: peer?.fingerprint256 ? peer.fingerprint256.replace(/:/g, '').toLowerCase() : null }));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end(data);
  });
}

describe('companion listener over TLS', () => {
  it('pairs over HTTPS, hands the phone the certificate it saw, serves pinned calls and refuses plain HTTP', async () => {
    const port = await freePort();
    writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port });
    const controller = new CompanionServerController(db, dir, () => undefined, fakeProtector());
    await controller.apply();
    try {
      const status = controller.status();
      expect(status).toMatchObject({ listening: true, transport: 'https', vaultOpen: true, keyProtection: 'test store (alice)' });

      const { code } = createCompanionPairingCode();
      const deviceId = 'jugaad-tls-device';
      const salt = crypto.randomBytes(16);
      const pk = pairingKey(code, salt);
      // Pairing: the phone cannot know the certificate yet, so it accepts it provisionally and checks it against the sealed reply.
      const paired = await request(https, port, '/companion/v1/pair', { deviceId, label: 'Emu', salt: salt.toString('base64'), proof: pairingProof(pk, deviceId).toString('base64') }, { rejectUnauthorized: false });
      expect(paired.status).toBe(200);
      const opened = JSON.parse(openCompanionMessage(pk, `${deviceId}:pair`, paired.json.sealedKey)) as { deviceKey: string; tlsFingerprint: string };
      expect(opened.tlsFingerprint).toBe(paired.peerFingerprint);
      expect(status.certificateFingerprint!.replace(/ /g, '').toLowerCase()).toBe(opened.tlsFingerprint);

      // Later calls trust only the pinned certificate.
      const cert = JSON.parse(fs.readFileSync(path.join(dir, 'companion-tls.json'), 'utf8')).certPem as string;
      const key = Buffer.from(opened.deviceKey, 'base64');
      const call = (nonce: string) => sealCompanionMessage(key, deviceId, JSON.stringify({ method: 'hello', params: {}, ts: Date.now(), nonce }));
      const hello = await request(https, port, '/companion/v1/rpc', { d: deviceId, ...call('nonce-hello-0001') }, { ca: cert, checkServerIdentity: (_h, c) => (c.fingerprint256.replace(/:/g, '').toLowerCase() === opened.tlsFingerprint ? undefined : new Error('pin mismatch')) });
      expect(hello.status).toBe(200);
      const reply = JSON.parse(openCompanionMessage(key, `${deviceId}:resp`, hello.json.sealed));
      expect(reply).toMatchObject({ ok: true, nonce: 'nonce-hello-0001' });

      // The same sealed request again is a replay.
      const sealed = call('nonce-hello-0002');
      expect((await request(https, port, '/companion/v1/rpc', { d: deviceId, ...sealed }, { rejectUnauthorized: false })).status).toBe(200);
      const replay = await request(https, port, '/companion/v1/rpc', { d: deviceId, ...sealed }, { rejectUnauthorized: false });
      expect(replay.status).toBe(401);
      expect(replay.json.error).toMatch(/replayed/);

      // A client that trusts only public CAs refuses the PC's certificate; plain HTTP gets no answer.
      await expect(request(https, port, '/companion/v1/rpc', { d: deviceId, ...call('nonce-hello-0003') })).rejects.toThrow();
      await expect(request(http, port, '/companion/v1/rpc', { d: deviceId, ...call('nonce-hello-0004') })).rejects.toThrow();
    } finally {
      await controller.close();
    }
  }, 30_000);

  it('settings applied while the vault is still opening wait for it instead of starting a second listener', async () => {
    const port = await freePort();
    writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port });
    const slow = fakeProtector();
    const unprotect = slow.unprotect; const protect = slow.protect;
    slow.protect = async (b) => { await new Promise((r) => setTimeout(r, 300)); return protect(b); };
    slow.unprotect = async (b) => { await new Promise((r) => setTimeout(r, 300)); return unprotect(b); };
    const logs: string[] = [];
    const controller = new CompanionServerController(db, dir, (l) => logs.push(l), slow);
    try {
      const startup = controller.apply();
      expect(controller.status()).toMatchObject({ listening: false, starting: true });
      await Promise.all([startup, controller.apply({ enabled: true, bind: 'loopback', port })]);
      expect(controller.status()).toMatchObject({ listening: true, starting: false, error: null });
      expect(logs.filter((l) => /could not listen/.test(l))).toEqual([]);
    } finally {
      await controller.close();
    }
  });

  it('does not listen when the vault cannot be opened', async () => {
    writeCompanionSettings(dir, { enabled: true, bind: 'loopback', port: await freePort() });
    const controller = new CompanionServerController(db, dir, () => undefined, null);
    await controller.apply();
    expect(controller.status()).toMatchObject({ listening: false, vaultOpen: false });
    expect(controller.status().error).toMatch(/no OS secret store/);
  });
});

describe('document reading is a separate decision', () => {
  function folder(): string {
    const root = path.join(dir, 'Inbox');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'scan_0001.txt'), 'Rechnung Nr. 4711\nStromversorgung\nFällig am 30.11.2026\nBetrag: 84,20 EUR');
    return root;
  }

  it('a model-supplied inspectContents flag reads nothing; a grant reads; revoking stops it', async () => {
    const root = folder();
    const adapter = createPcOrganizerAdapter({ db });
    const prepared = await adapter.prepare!('pc_organize_scan', { roots: [root], inspectContents: true });
    expect(prepared).not.toHaveProperty('inspectContents');
    expect(String(prepared.reads)).toMatch(/document text is not read/);
    const scan = async () => {
      const r = await adapter.run({ id: 'c1', name: 'pc_organize_scan', arguments: { roots: [root], inspectContents: true } } as never, {} as never);
      expect(r.status).toBe('succeeded');
      return r.output;
    };
    expect(await scan()).toMatch(/file contents were not read/);

    grantDocumentReading(db, root, 'host:test');
    expect(String((await adapter.prepare!('pc_organize_scan', { roots: [root] })).reads)).toMatch(/document text \(locally, not stored\) only in/);
    expect(await scan()).toMatch(/read the text of 1 documents/);

    revokeDocumentReading(db, root, 'host:test');
    expect(await scan()).toMatch(/file contents were not read/);
  });

  it('the model schema no longer offers a content switch, and the grant tool has its own card', async () => {
    const household = createHouseholdCapabilityAdapter({ db });
    const pc = createPcOrganizerAdapter({ db });
    const defs = [...household.definitions(), ...pc.definitions()];
    for (const d of defs) expect(JSON.stringify(d.parameters)).not.toContain('inspectContents');
    expect(household.classify!('household_allow_document_reading')).toBe('consequential');
    const root = folder();
    const card = await household.prepare!('household_allow_document_reading', { action: 'allow', folders: [root] });
    expect(card).toMatchObject({ action: 'allow', folders: [path.resolve(root)] });
    expect(String(card.decision)).toMatch(/read the text of PDFs and text files/);
    expect(listDocumentReadGrants(db)).toHaveLength(0);
  });

  it('obligation scans read file text only inside a grant and say what they skipped', async () => {
    const root = folder();
    const without = await scanObligationSources(db, { folders: [root], inspectContents: documentReadPolicy(db) });
    expect(without.unavailable.join(' ')).toMatch(/text of 1 document\(s\) was not read/);
    grantDocumentReading(db, root, 'host:test');
    const withGrant = await scanObligationSources(db, { folders: [root], inspectContents: documentReadPolicy(db) });
    expect(withGrant.unavailable).toHaveLength(0);
  });

  it('a host-side plan for one scan still works when the person ticks it in the panel', async () => {
    const root = folder();
    const plan = await proposeOrganization(db, { roots: [root], inspectContents: true, origin: 'host' });
    expect((plan.summary as Record<string, unknown>).contentReads).toBe(1);
  });
});

describe('a plan names the folder it will really use', () => {
  it('a target that is only a word never points at the folder the program runs from', async () => {
    const root = path.join(dir, 'Inbox');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    // "Documents" is not a path: it must not become <working directory>\Documents.
    expect(resolveTargetBase('Documents', [root])).toBe(path.join(root, 'Documents'));
    expect(resolveTargetBase('Documents', [root])).not.toMatch(new RegExp(`^${path.resolve('.').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    // An absolute path is taken as it is; a scanned folder of that name is that folder.
    expect(resolveTargetBase(root, [root])).toBe(path.resolve(root));
    expect(resolveTargetBase('Inbox', [root])).toBe(path.resolve(root));
  });

  it('the approval card shows the resolved folder, and the plan puts the files there', async () => {
    const root = path.join(dir, 'Inbox');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'note.txt'), 'hello');
    const adapter = createPcOrganizerAdapter({ db });
    const prepared = await adapter.prepare!('pc_organize_scan', { roots: [root], targetBase: 'Documents' });
    expect(prepared.targetBase).toBe(path.join(root, 'Documents'));
    const plan = await proposeOrganization(db, { roots: [root], targetBase: prepared.targetBase as string });
    expect(plan.targetBase).toBe(path.join(root, 'Documents'));
  });
});
