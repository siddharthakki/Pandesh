/**
 * The JUGAAD companion: an opt-in, local-network sync between Pandesh and the JUGAAD Android app.
 *
 * Source of truth per record type:
 *   - `important_date` records Pandesh derived (confirmed obligations): Pandesh owns the facts; the phone owns how it
 *     reminds and may resolve them, which flows back as an operation.
 *   - `briefing` and `task_status`: Pandesh owns them; the phone only displays them.
 *   - Everything else in JUGAAD stays on the phone and is never read by this channel.
 *
 * Transport security without a bearer token: pairing derives a key from the one-time code shown on the PC (PBKDF2,
 * the code itself never crosses the network), the PC then hands the phone a random device key encrypted under it, and
 * every later request and response is AES-256-GCM encrypted and authenticated with that device key, bound to the
 * device id, timestamped and nonce-checked against replay. A phone without a key — or with a revoked one — can decrypt
 * nothing and its requests fail authentication, so it gains no access to the PC.
 *
 * Sync is a revision log: every change to a record bumps a global revision; the phone pulls "everything after the
 * revision I have", and pushes its own operations with unique opIds that the PC applies exactly once.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';

export type CompanionRecordKind = 'important_date' | 'briefing' | 'task_status' | 'document_ref';

export interface CompanionRecord {
  recordId: string;
  kind: CompanionRecordKind;
  revision: number;
  payload: Record<string, unknown>;
  deleted: boolean;
  sourceOfTruth: 'pandesh' | 'jugaad';
  updatedAt: string;
}

export interface CompanionDevice {
  id: string;
  label: string;
  createdAt: string;
  lastSeenAt: string | null;
  lastPulledRevision: number;
  revokedAt: string | null;
}

const MAX_PAYLOAD_CHARS = 8_000;

function mapRecord(r: Record<string, unknown>): CompanionRecord {
  return {
    recordId: String(r.recordId), kind: r.kind as CompanionRecordKind, revision: Number(r.revision), payload: JSON.parse(String(r.payloadJson)),
    deleted: Number(r.deleted) === 1, sourceOfTruth: r.sourceOfTruth as CompanionRecord['sourceOfTruth'], updatedAt: String(r.updatedAt),
  };
}

export function latestCompanionRevision(db: CoreDatabase): number {
  return Number(db.get<{ r: number | null }>('SELECT MAX(revision) AS r FROM companion_records')?.r ?? 0);
}

/**
 * Writes a record into the log. Idempotent: an unchanged payload keeps its revision, so republishing the same facts
 * never makes the phone re-download (or re-notify) anything.
 */
export function upsertCompanionRecord(db: CoreDatabase, input: { recordId: string; kind: CompanionRecordKind; payload: Record<string, unknown>; sourceOfTruth?: CompanionRecord['sourceOfTruth'] }): CompanionRecord {
  const payloadJson = JSON.stringify(input.payload);
  if (payloadJson.length > MAX_PAYLOAD_CHARS) throw new CoreError('invalid_request', 'a companion record is limited to 8000 characters; send a reference, not the document');
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM companion_records WHERE recordId = ?', [input.recordId]);
    if (existing && String(existing.payloadJson) === payloadJson && Number(existing.deleted) === 0) return mapRecord(existing);
    const revision = latestCompanionRevision(db) + 1;
    const at = nowIso();
    if (existing) {
      db.run('UPDATE companion_records SET kind = ?, revision = ?, payloadJson = ?, deleted = 0, sourceOfTruth = ?, updatedAt = ? WHERE recordId = ?', [input.kind, revision, payloadJson, input.sourceOfTruth ?? 'pandesh', at, input.recordId]);
    } else {
      db.run('INSERT INTO companion_records (recordId, kind, revision, payloadJson, deleted, sourceOfTruth, updatedAt) VALUES (?, ?, ?, ?, 0, ?, ?)', [input.recordId, input.kind, revision, payloadJson, input.sourceOfTruth ?? 'pandesh', at]);
    }
    return mapRecord(db.get<Record<string, unknown>>('SELECT * FROM companion_records WHERE recordId = ?', [input.recordId])!);
  });
}

/** Tombstones a record so the phone removes its copy on the next pull. */
export function removeCompanionRecord(db: CoreDatabase, recordId: string): void {
  db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT deleted FROM companion_records WHERE recordId = ?', [recordId]);
    if (!existing || Number(existing.deleted) === 1) return;
    db.run('UPDATE companion_records SET deleted = 1, revision = ?, updatedAt = ? WHERE recordId = ?', [latestCompanionRevision(db) + 1, nowIso(), recordId]);
  });
}

export function getCompanionRecord(db: CoreDatabase, recordId: string): CompanionRecord | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM companion_records WHERE recordId = ?', [recordId]);
  return row ? mapRecord(row) : null;
}

export function listCompanionChanges(db: CoreDatabase, since: number, limit = 200): CompanionRecord[] {
  return db.all<Record<string, unknown>>('SELECT * FROM companion_records WHERE revision > ? ORDER BY revision ASC LIMIT ?', [since, Math.min(500, Math.max(1, limit))]).map(mapRecord);
}

export function listCompanionRecords(db: CoreDatabase, kind?: CompanionRecordKind): CompanionRecord[] {
  return (kind
    ? db.all<Record<string, unknown>>('SELECT * FROM companion_records WHERE kind = ? AND deleted = 0 ORDER BY revision DESC', [kind])
    : db.all<Record<string, unknown>>('SELECT * FROM companion_records WHERE deleted = 0 ORDER BY revision DESC')).map(mapRecord);
}

// ------------------------------------------------------------------ devices and pairing

function mapDevice(r: Record<string, unknown>): CompanionDevice {
  return { id: String(r.id), label: String(r.label), createdAt: String(r.createdAt), lastSeenAt: (r.lastSeenAt as string) ?? null, lastPulledRevision: Number(r.lastPulledRevision), revokedAt: (r.revokedAt as string) ?? null };
}

export function listCompanionDevices(db: CoreDatabase): CompanionDevice[] {
  return db.all<Record<string, unknown>>('SELECT * FROM companion_devices ORDER BY createdAt DESC').map(mapDevice);
}

export function activeCompanionDeviceCount(db: CoreDatabase): number {
  return Number(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM companion_devices WHERE revokedAt IS NULL')?.n ?? 0);
}

export function revokeCompanionDevice(db: CoreDatabase, id: string): CompanionDevice {
  const row = db.get<Record<string, unknown>>('SELECT * FROM companion_devices WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `companion device ${id} not found`);
  if (!row.revokedAt) db.run('UPDATE companion_devices SET revokedAt = ? WHERE id = ?', [nowIso(), id]);
  return mapDevice(db.get<Record<string, unknown>>('SELECT * FROM companion_devices WHERE id = ?', [id])!);
}

/** The device key, only for a paired, unrevoked device. */
export function companionDeviceKey(db: CoreDatabase, id: string): Buffer | null {
  const row = db.get<{ keyMaterial: string; revokedAt: string | null }>('SELECT keyMaterial, revokedAt FROM companion_devices WHERE id = ?', [id]);
  if (!row || row.revokedAt) return null;
  return Buffer.from(row.keyMaterial, 'base64');
}

export function touchCompanionDevice(db: CoreDatabase, id: string, pulledRevision?: number): void {
  db.run(`UPDATE companion_devices SET lastSeenAt = ?${pulledRevision !== undefined ? ', lastPulledRevision = MAX(lastPulledRevision, ?)' : ''} WHERE id = ?`, pulledRevision !== undefined ? [nowIso(), pulledRevision, id] : [nowIso(), id]);
}

const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CODE_TTL_MS = 10 * 60_000;
const MAX_FAILED_PAIRINGS = 5;
export const PAIRING_KDF_ITERATIONS = 120_000;

/** Pairing codes live in Core's memory only, for ten minutes: a code is useless once Core restarts. */
const liveCodes = new Map<string, number>();
let failedPairings = 0;

export function createCompanionPairingCode(now = Date.now()): { code: string; expiresAt: string } {
  for (const [code, exp] of liveCodes) if (exp < now) liveCodes.delete(code);
  const code = Array.from(crypto.randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  liveCodes.set(code, now + CODE_TTL_MS);
  return { code, expiresAt: new Date(now + CODE_TTL_MS).toISOString() };
}

export function pairingKey(code: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(Buffer.from(code.trim().toUpperCase(), 'utf8'), salt, PAIRING_KDF_ITERATIONS, 32, 'sha256');
}

export function pairingProof(key: Buffer, deviceId: string): Buffer {
  return crypto.createHmac('sha256', key).update(`pandesh-pair:${deviceId}`).digest();
}

/**
 * Pairs a phone that proved it knows a live code. Returns the new device key encrypted under the code-derived key, so
 * someone watching the network learns neither the code nor the device key. A code works once; five wrong proofs burn
 * every open code.
 */
export function redeemCompanionPairing(db: CoreDatabase, input: { deviceId: string; label: string; salt: string; proof: string }, now = Date.now()): { device: CompanionDevice; sealedKey: { iv: string; ct: string } } {
  const deviceId = String(input.deviceId ?? '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) throw new CoreError('invalid_request', 'deviceId must be 8–64 letters, digits or dashes');
  const salt = Buffer.from(String(input.salt ?? ''), 'base64');
  const proof = Buffer.from(String(input.proof ?? ''), 'base64');
  if (salt.length < 16 || proof.length !== 32) throw new CoreError('invalid_request', 'malformed pairing request');
  let matched: { code: string; key: Buffer } | null = null;
  for (const [code, exp] of liveCodes) {
    if (exp < now) { liveCodes.delete(code); continue; }
    const key = pairingKey(code, salt);
    if (crypto.timingSafeEqual(pairingProof(key, deviceId), proof)) { matched = { code, key }; break; }
  }
  if (!matched) {
    failedPairings += 1;
    if (failedPairings >= MAX_FAILED_PAIRINGS) { liveCodes.clear(); failedPairings = 0; }
    throw new CoreError('unauthenticated', 'the pairing code is wrong, expired or already used');
  }
  failedPairings = 0;
  liveCodes.delete(matched.code);
  const deviceKey = crypto.randomBytes(32);
  const at = nowIso();
  const label = String(input.label ?? 'JUGAAD phone').replace(/[\u0000-\u001f]/g, '').slice(0, 80) || 'JUGAAD phone';
  db.run(
    `INSERT INTO companion_devices (id, label, keyMaterial, createdAt, lastSeenAt, lastPulledRevision, revokedAt) VALUES (?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, keyMaterial = excluded.keyMaterial, createdAt = excluded.createdAt, lastSeenAt = excluded.lastSeenAt, lastPulledRevision = 0, revokedAt = NULL`,
    [deviceId, label, deviceKey.toString('base64'), at, at],
  );
  const sealed = sealCompanionMessage(matched.key, `${deviceId}:pair`, JSON.stringify({ deviceKey: deviceKey.toString('base64'), pc: process.env.COMPUTERNAME ?? 'Pandesh PC' }));
  return { device: mapDevice(db.get<Record<string, unknown>>('SELECT * FROM companion_devices WHERE id = ?', [deviceId])!), sealedKey: sealed };
}

// ------------------------------------------------------------------ envelope

/** AES-256-GCM; the ciphertext carries the 16-byte tag at its end (the javax.crypto convention), so Android reads it directly. */
export function sealCompanionMessage(key: Buffer, aad: string, plaintext: string): { iv: string; ct: string } {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

export function openCompanionMessage(key: Buffer, aad: string, envelope: { iv: string; ct: string }): string {
  const iv = Buffer.from(String(envelope.iv ?? ''), 'base64');
  const raw = Buffer.from(String(envelope.ct ?? ''), 'base64');
  if (iv.length !== 12 || raw.length < 17) throw new CoreError('unauthenticated', 'malformed message');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  try {
    return Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
  } catch {
    throw new CoreError('unauthenticated', 'the message did not authenticate');
  }
}

const REPLAY_WINDOW_MS = 10 * 60_000;
const seenNonces = new Map<string, Map<string, number>>();

/** Refuses a request older than ten minutes or one whose nonce was already used. */
export function checkFreshness(deviceId: string, ts: number, nonce: string, now = Date.now()): void {
  if (!Number.isFinite(ts) || Math.abs(now - ts) > REPLAY_WINDOW_MS) throw new CoreError('unauthenticated', 'the request is too old or the phone clock is wrong');
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw new CoreError('unauthenticated', 'malformed nonce');
  const seen = seenNonces.get(deviceId) ?? new Map<string, number>();
  for (const [n, at] of seen) if (now - at > REPLAY_WINDOW_MS) seen.delete(n);
  if (seen.has(nonce)) throw new CoreError('unauthenticated', 'replayed request');
  seen.set(nonce, now);
  seenNonces.set(deviceId, seen);
}

// ------------------------------------------------------------------ operations from the phone

export interface CompanionOp {
  opId: string;
  recordId: string;
  op: 'resolve' | 'reopen' | 'ack';
  baseRevision?: number;
  resolution?: 'paid' | 'done';
  at?: string;
}

export interface CompanionOpResult { opId: string; result: 'applied' | 'duplicate' | 'rejected'; detail?: string; revision?: number }

/**
 * Applies the phone's operations exactly once each. The handler decides what an operation means for the record's
 * owner; the ledger guarantees that a retried push (after a dropped connection) never applies it twice.
 */
export function applyCompanionOps(db: CoreDatabase, deviceId: string, ops: CompanionOp[], handler: (op: CompanionOp, record: CompanionRecord | null) => { result: 'applied' | 'rejected'; detail?: string }): CompanionOpResult[] {
  const out: CompanionOpResult[] = [];
  for (const op of ops.slice(0, 100)) {
    const opId = String(op.opId ?? '');
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(opId)) { out.push({ opId, result: 'rejected', detail: 'malformed opId' }); continue; }
    const prior = db.get<{ result: string; detail: string | null }>('SELECT result, detail FROM companion_ops WHERE opId = ?', [opId]);
    if (prior) { out.push({ opId, result: 'duplicate', detail: prior.detail ?? prior.result }); continue; }
    const record = getCompanionRecord(db, String(op.recordId ?? ''));
    let outcome: { result: 'applied' | 'rejected'; detail?: string };
    if (!['resolve', 'reopen', 'ack'].includes(op.op)) outcome = { result: 'rejected', detail: `unsupported operation ${op.op}` };
    else if (!record || record.deleted) outcome = { result: 'rejected', detail: 'unknown or removed record' };
    else {
      try { outcome = handler(op, record); } catch (err) { outcome = { result: 'rejected', detail: err instanceof Error ? err.message : String(err) }; }
    }
    db.run('INSERT INTO companion_ops (opId, deviceId, recordId, op, baseRevision, result, detail, appliedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [opId, deviceId, String(op.recordId ?? ''), String(op.op ?? ''), op.baseRevision ?? null, outcome.result, outcome.detail ?? null, nowIso()]);
    out.push({ opId, result: outcome.result, detail: outcome.detail, revision: getCompanionRecord(db, String(op.recordId ?? ''))?.revision });
  }
  return out;
}

export function recentCompanionOps(db: CoreDatabase, limit = 20): Array<{ opId: string; deviceId: string; recordId: string; op: string; result: string; detail: string | null; appliedAt: string }> {
  return db.all('SELECT opId, deviceId, recordId, op, result, detail, appliedAt FROM companion_ops ORDER BY appliedAt DESC LIMIT ?', [limit]);
}
