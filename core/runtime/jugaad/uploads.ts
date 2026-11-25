/**
 * Resumable, idempotent document upload from a phone. Built for a flaky link: every chunk names its offset; the server keeps the
 * bytes it has and always answers with how many it holds, so a dropped response, a retry or a reconnect after being offline just
 * continues from the server's offset. A finished upload is verified against the SHA-256 the phone announced before it is accepted,
 * and the same content sent twice is recognised by hash and never stored twice.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoreError } from '../../domain/errors';
import type { CoreDatabase } from '../../db/connection';
import { findBySha, openHouseholdIndex } from './documentIndex';
import { householdDirs } from './households';
import { MAX_DOCUMENT_BYTES } from './documentIntake';

export const MAX_CHUNK_BYTES = 64 * 1024;
const MAX_OPEN_UPLOADS = 20;
const STALE_MS = 24 * 3600_000;

export interface UploadParams { uploadId: string; name: string; size: number; sha256: string; offset: number; data?: string }

export type UploadReply =
  | { status: 'continue'; received: number }
  | { status: 'resume'; received: number }
  | { status: 'duplicate'; documentId: string | null; processing?: true }
  | { status: 'complete'; received: number; inboxName: string };

interface Meta { name: string; size: number; sha256: string; received: number; createdAt: number }

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const safeName = (n: string) => path.basename(String(n)).replace(/[^\w.\- äöüÄÖÜß()]/g, '_').slice(0, 100) || 'document';

function sweep(uploadsDir: string, now: number): void {
  for (const f of fs.readdirSync(uploadsDir)) {
    const p = path.join(uploadsDir, f);
    try { if (now - fs.statSync(p).mtimeMs > STALE_MS) fs.rmSync(p, { force: true }); } catch { /* raced */ }
  }
}

function discardPartial(uploadsDir: string, uploadId: string): void {
  if (!ID.test(String(uploadId))) return;
  fs.rmSync(path.join(uploadsDir, `${uploadId}.part`), { force: true });
  fs.rmSync(path.join(uploadsDir, `${uploadId}.json`), { force: true });
}

/** True when the inbox already holds a file with exactly this content (names start with the first 8 hex digits of the hash; the hash is then checked in full). */
function inboxHolds(inbox: string, sha256: string): boolean {
  for (const f of fs.readdirSync(inbox)) {
    if (!f.startsWith(`${sha256.slice(0, 8)}-`)) continue;
    try { if (crypto.createHash('sha256').update(fs.readFileSync(path.join(inbox, f))).digest('hex') === sha256) return true; } catch { /* being moved */ }
  }
  return false;
}

export function putChunk(db: CoreDatabase, dataDir: string, householdId: string, p: UploadParams, now = Date.now()): UploadReply {
  const dirs = householdDirs(dataDir, householdId);
  if (!ID.test(String(p.uploadId))) throw new CoreError('invalid_request', 'uploadId must be 8-64 letters, digits, - or _');
  if (!/^[0-9a-f]{64}$/.test(String(p.sha256))) throw new CoreError('invalid_request', 'sha256 must be the 64-character hex digest of the whole file');
  const size = Number(p.size);
  if (!Number.isInteger(size) || size < 1 || size > MAX_DOCUMENT_BYTES) throw new CoreError('invalid_request', `size must be 1..${MAX_DOCUMENT_BYTES} bytes`);
  const offset = Number(p.offset);
  if (!Number.isInteger(offset) || offset < 0 || offset > size) throw new CoreError('invalid_request', 'offset is out of range');
  sweep(dirs.uploads, now);

  // The same content is never stored twice, and the phone learns that before sending any bytes.
  const known = findBySha(openHouseholdIndex(dataDir, householdId), p.sha256);
  if (known) { discardPartial(dirs.uploads, p.uploadId); return { status: 'duplicate', documentId: known.id }; }
  // The same bytes may already be accepted and still being processed (in the inbox, not yet indexed): also a duplicate, found by content.
  if (inboxHolds(dirs.inbox, p.sha256)) { discardPartial(dirs.uploads, p.uploadId); return { status: 'duplicate', documentId: null, processing: true }; }

  const metaFile = path.join(dirs.uploads, `${p.uploadId}.json`);
  const partFile = path.join(dirs.uploads, `${p.uploadId}.part`);
  let meta: Meta;
  if (fs.existsSync(metaFile)) {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) as Meta;
    if (meta.size !== size || meta.sha256 !== p.sha256) throw new CoreError('invalid_request', 'this uploadId already belongs to a different file');
  } else {
    if (fs.readdirSync(dirs.uploads).filter(f => f.endsWith('.json')).length >= MAX_OPEN_UPLOADS) throw new CoreError('conflict', 'too many unfinished uploads; finish or wait for the old ones to expire');
    meta = { name: safeName(p.name), size, sha256: p.sha256, received: 0, createdAt: now };
    fs.writeFileSync(partFile, Buffer.alloc(0));
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  }
  const held = fs.existsSync(partFile) ? fs.statSync(partFile).size : 0;
  if (held !== meta.received) { meta.received = held; fs.writeFileSync(metaFile, JSON.stringify(meta)); } // the file is the truth after a crash mid-write

  const data = p.data ? Buffer.from(String(p.data), 'base64') : Buffer.alloc(0);
  if (data.length > MAX_CHUNK_BYTES) throw new CoreError('invalid_request', `a chunk is at most ${MAX_CHUNK_BYTES} bytes`);
  if (offset !== meta.received) return { status: 'resume', received: meta.received };
  if (data.length) {
    if (meta.received + data.length > size) throw new CoreError('invalid_request', 'the chunk runs past the announced size');
    fs.appendFileSync(partFile, data);
    meta.received += data.length;
    fs.writeFileSync(metaFile, JSON.stringify(meta));
  }
  if (meta.received < size) return { status: 'continue', received: meta.received };

  const digest = crypto.createHash('sha256').update(fs.readFileSync(partFile)).digest('hex');
  if (digest !== meta.sha256) {
    fs.rmSync(partFile, { force: true }); fs.rmSync(metaFile, { force: true });
    throw new CoreError('invalid_request', 'the received file does not match its SHA-256; nothing was kept, upload it again from the start');
  }
  const inboxName = `${meta.sha256.slice(0, 8)}-${meta.name}`;
  fs.renameSync(partFile, path.join(dirs.inbox, inboxName));
  fs.rmSync(metaFile, { force: true });
  void db; // the database is not needed to accept bytes; processing is a separate, tracked task
  return { status: 'complete', received: size, inboxName };
}
