/**
 * Reading what is inside a person's documents is its own decision, separate from scanning a folder.
 *
 * A scan reads names, sizes, dates and file-type headers. Reading the text of PDFs and text files needs an active grant
 * for the folder (or a folder above it), which only the person creates: in the desktop Household panel, or by approving
 * the dedicated `household_allow_document_reading` card — never as a flag on a scan, never by a routine, never by the
 * model alone. A grant lasts until it is revoked and is checked again every time a scan or routine runs, so revoking it
 * stops content reading for everything at once.
 */
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

export interface DocumentReadGrant {
  id: string;
  folder: string;
  grantedAt: string;
  grantedBy: string;
  revokedAt: string | null;
  revokedBy: string | null;
}

const keyOf = (p: string) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

function mapGrant(r: Record<string, unknown>): DocumentReadGrant {
  return { id: String(r.id), folder: String(r.folder), grantedAt: String(r.grantedAt), grantedBy: String(r.grantedBy), revokedAt: (r.revokedAt as string) ?? null, revokedBy: (r.revokedBy as string) ?? null };
}

export function listDocumentReadGrants(db: CoreDatabase, options: { includeRevoked?: boolean } = {}): DocumentReadGrant[] {
  return db.all<Record<string, unknown>>(`SELECT * FROM document_read_grants${options.includeRevoked ? '' : ' WHERE revokedAt IS NULL'} ORDER BY grantedAt DESC`).map(mapGrant);
}

/** `folder` must already be a resolved, validated folder (the caller checks it is one the user may authorize). */
export function grantDocumentReading(db: CoreDatabase, folder: string, actor: string): DocumentReadGrant {
  if (!path.isAbsolute(folder)) throw new CoreError('invalid_request', 'a document-reading grant needs a full folder path');
  const existing = listDocumentReadGrants(db).find((g) => keyOf(g.folder) === keyOf(folder));
  if (existing) return existing;
  const grant: DocumentReadGrant = { id: newId('drg'), folder: path.resolve(folder), grantedAt: nowIso(), grantedBy: actor, revokedAt: null, revokedBy: null };
  db.run('INSERT INTO document_read_grants (id, folder, grantedAt, grantedBy, revokedAt, revokedBy) VALUES (?, ?, ?, ?, NULL, NULL)', [grant.id, grant.folder, grant.grantedAt, grant.grantedBy]);
  recordRuntimeEvent(db, { domain: 'authorization', entityId: grant.id, eventType: 'document_reading_granted', actor, metadata: { folder: grant.folder } });
  return grant;
}

/** Revokes by grant id or by folder. Returns the grants it revoked. */
export function revokeDocumentReading(db: CoreDatabase, idOrFolder: string, actor: string): DocumentReadGrant[] {
  const targets = listDocumentReadGrants(db).filter((g) => g.id === idOrFolder || keyOf(g.folder) === keyOf(idOrFolder));
  if (!targets.length) throw new CoreError('not_found', `no active document-reading permission for ${idOrFolder}`);
  const at = nowIso();
  for (const g of targets) {
    db.run('UPDATE document_read_grants SET revokedAt = ?, revokedBy = ? WHERE id = ?', [at, actor, g.id]);
    recordRuntimeEvent(db, { domain: 'authorization', entityId: g.id, eventType: 'document_reading_revoked', actor, metadata: { folder: g.folder } });
  }
  return targets.map((g) => ({ ...g, revokedAt: at, revokedBy: actor }));
}

/** The active grant covering `file` (the folder itself or anything below it), if any. */
export function documentReadGrantFor(db: CoreDatabase, file: string): DocumentReadGrant | null {
  const k = keyOf(file);
  return listDocumentReadGrants(db).find((g) => { const gk = keyOf(g.folder); return k === gk || k.startsWith(gk + path.sep); }) ?? null;
}

/** May the text of this file be read? `true` is the person's own choice for one scan, made in the desktop panel. */
export type ContentReadPolicy = (file: string) => boolean;

export function toContentReadPolicy(v: boolean | ContentReadPolicy | undefined): ContentReadPolicy | undefined {
  return typeof v === 'function' ? v : v === true ? () => true : undefined;
}

/** A predicate for scanners: may the text of this file be read right now? Snapshot of the grants at call time. */
export function documentReadPolicy(db: CoreDatabase): ContentReadPolicy {
  const keys = listDocumentReadGrants(db).map((g) => keyOf(g.folder));
  return (file) => { const k = keyOf(file); return keys.some((gk) => k === gk || k.startsWith(gk + path.sep)); };
}
