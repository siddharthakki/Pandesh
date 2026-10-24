import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { ArtifactAvailability, ArtifactKind, ArtifactRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

const KINDS: readonly ArtifactKind[] = ['image', 'video', 'document', 'file'];
const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024;
const MAX_METADATA_BYTES = 16 * 1024;

function digestFile(absolutePath: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(absolutePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function availabilityFor(row: Record<string, unknown>): ArtifactAvailability {
  try {
    const stat = fs.statSync(String(row.absolutePath));
    if (!stat.isFile()) return 'missing';
    fs.accessSync(String(row.absolutePath), fs.constants.R_OK);
    if (stat.size !== Number(row.byteSize)) return 'changed';
    return digestFile(String(row.absolutePath)) === String(row.sha256) ? 'ready' : 'changed';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function rowToArtifact(row: Record<string, unknown>): ArtifactRecord {
  let metadata: Record<string, unknown> = {};
  try { metadata = JSON.parse(String(row.metadataJson ?? '{}')) as Record<string, unknown>; } catch { metadata = {}; }
  return {
    id: String(row.id), conversationId: (row.conversationId as string) ?? null,
    requestId: (row.requestId as string) ?? null, attemptId: (row.attemptId as string) ?? null,
    kind: row.kind as ArtifactKind, title: String(row.title), mimeType: String(row.mimeType),
    absolutePath: String(row.absolutePath), byteSize: Number(row.byteSize), sha256: String(row.sha256),
    source: String(row.source), metadata, createdAt: String(row.createdAt), availability: availabilityFor(row),
  };
}

export interface RegisterArtifactInput {
  conversationId?: string | null;
  requestId?: string | null;
  attemptId?: string | null;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  absolutePath: string;
  source: string;
  metadata?: Record<string, unknown>;
  actor: string;
  clientId?: string | null;
}

export function registerArtifact(db: CoreDatabase, input: RegisterArtifactInput): ArtifactRecord {
  if (!KINDS.includes(input.kind)) throw new CoreError('invalid_request', `unsupported artifact kind '${input.kind}'`);
  const title = input.title.trim();
  const mimeType = input.mimeType.trim().toLowerCase();
  const source = input.source.trim();
  if (!title || title.length > 255) throw new CoreError('invalid_request', 'artifact title must be 1-255 characters');
  if (!mimeType || mimeType.length > 127) throw new CoreError('invalid_request', 'artifact mimeType is required');
  if (!source || source.length > 100) throw new CoreError('invalid_request', 'artifact source is required');
  const absolutePath = path.resolve(input.absolutePath);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolutePath);
    fs.accessSync(absolutePath, fs.constants.R_OK);
  } catch {
    throw new CoreError('invalid_request', 'artifact file does not exist or is not readable');
  }
  if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_ARTIFACT_BYTES) {
    throw new CoreError('invalid_request', `artifact must be a non-empty file no larger than ${MAX_ARTIFACT_BYTES} bytes`);
  }
  if (input.conversationId && !db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId])) {
    throw new CoreError('not_found', `conversation '${input.conversationId}' not found`);
  }
  const metadataJson = JSON.stringify(input.metadata ?? {});
  if (Buffer.byteLength(metadataJson, 'utf8') > MAX_METADATA_BYTES) throw new CoreError('invalid_request', 'artifact metadata is too large');
  const id = newId('artifact');
  const createdAt = nowIso();
  const sha256 = digestFile(absolutePath);
  db.run(
    `INSERT INTO artifacts (id, conversationId, requestId, attemptId, kind, title, mimeType, absolutePath, byteSize, sha256, source, metadataJson, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.conversationId ?? null, input.requestId ?? null, input.attemptId ?? null, input.kind, title, mimeType, absolutePath, stat.size, sha256, source, metadataJson, createdAt],
  );
  recordRuntimeEvent(db, { domain: 'conversation', entityId: input.conversationId ?? id, eventType: 'artifact_registered', actor: input.actor, clientId: input.clientId, metadata: { artifactId: id, kind: input.kind, byteSize: stat.size, source }, resultingRevision: null });
  return getArtifact(db, id);
}

export function getArtifact(db: CoreDatabase, id: string): ArtifactRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM artifacts WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `artifact '${id}' not found`);
  return rowToArtifact(row);
}

export function listArtifacts(db: CoreDatabase, conversationId?: string): ArtifactRecord[] {
  const rows = conversationId
    ? db.all<Record<string, unknown>>('SELECT * FROM artifacts WHERE conversationId = ? ORDER BY createdAt DESC LIMIT 200', [conversationId])
    : db.all<Record<string, unknown>>('SELECT * FROM artifacts ORDER BY createdAt DESC LIMIT 200');
  return rows.map(rowToArtifact);
}
