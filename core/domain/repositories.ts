import type { CoreDatabase } from '../db/connection';
import type { RepositoryRecord, RepositoryKind, RepositoryLocationRecord, RepositoryLocationCapability } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

function rowToRepository(row: Record<string, unknown>): RepositoryRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    name: String(row.name),
    remoteUrl: (row.remoteUrl as string) ?? null,
    defaultBranch: (row.defaultBranch as string) ?? null,
    kind: row.kind as RepositoryKind,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string) ?? null,
    revision: Number(row.revision),
  };
}

export interface CreateRepositoryInput {
  projectId: string;
  name: string;
  remoteUrl?: string | null;
  defaultBranch?: string | null;
  kind: RepositoryKind;
}

export function createRepository(db: CoreDatabase, input: CreateRepositoryInput): RepositoryRecord {
  const name = input.name?.trim();
  if (!name) throw new CoreError('invalid_request', 'repository name is required');
  return db.transaction(() => {
    const project = db.get('SELECT id FROM projects WHERE id = ?', [input.projectId]);
    if (!project) throw new CoreError('invalid_request', `project '${input.projectId}' does not exist`);
    const id = newId('repo');
    const now = nowIso();
    db.run(
      `INSERT INTO repositories (id, projectId, name, remoteUrl, defaultBranch, kind, createdAt, updatedAt, archivedAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      [id, input.projectId, name, input.remoteUrl ?? null, input.defaultBranch ?? null, input.kind, now, now],
    );
    return getRepository(db, id);
  });
}

export function getRepository(db: CoreDatabase, id: string): RepositoryRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM repositories WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `repository '${id}' not found`);
  return rowToRepository(row);
}

const MAX_PAGE_SIZE = 200;

export function listRepositories(db: CoreDatabase, filter: { projectId?: string; limit?: number; offset?: number } = {}): RepositoryRecord[] {
  const limit = Math.min(filter.limit ?? 50, MAX_PAGE_SIZE);
  const offset = filter.offset ?? 0;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    clauses.push('projectId = ?');
    params.push(filter.projectId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .all<Record<string, unknown>>(`SELECT * FROM repositories ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`, [
      ...params,
      limit,
      offset,
    ])
    .map(rowToRepository);
}

export function updateRepository(
  db: CoreDatabase,
  id: string,
  input: { name?: string; remoteUrl?: string | null; defaultBranch?: string | null; expectedRevision?: number },
): RepositoryRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM repositories WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `repository '${id}' not found`);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `repository '${id}' revision mismatch`);
    }
    const now = nowIso();
    db.run(
      `UPDATE repositories SET name = COALESCE(?, name), remoteUrl = ?, defaultBranch = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`,
      [
        input.name?.trim() || null,
        input.remoteUrl !== undefined ? input.remoteUrl : existing.remoteUrl,
        input.defaultBranch !== undefined ? input.defaultBranch : existing.defaultBranch,
        now,
        id,
      ],
    );
    return getRepository(db, id);
  });
}

export function archiveRepository(db: CoreDatabase, id: string): RepositoryRecord {
  return db.transaction(() => {
    const existing = db.get('SELECT id FROM repositories WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `repository '${id}' not found`);
    const now = nowIso();
    db.run(`UPDATE repositories SET archivedAt = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`, [now, now, id]);
    return getRepository(db, id);
  });
}

export interface RegisterLocationInput {
  repositoryId: string;
  nodeIdentity: string;
  localPath: string;
  availability: 'available' | 'unavailable';
  gitCapable: boolean;
  remoteCapable: boolean;
  repositoryRootIdentity?: string | null;
  currentBranch?: string | null;
  isClean?: boolean | null;
  capability: RepositoryLocationCapability;
}

export function registerRepositoryLocation(db: CoreDatabase, input: RegisterLocationInput): RepositoryLocationRecord {
  return db.transaction(() => {
    const repo = db.get('SELECT id FROM repositories WHERE id = ?', [input.repositoryId]);
    if (!repo) throw new CoreError('invalid_request', `repository '${input.repositoryId}' does not exist`);
    const id = newId('loc');
    const now = nowIso();
    db.run(
      `INSERT INTO repository_locations (id, repositoryId, nodeIdentity, localPath, availability, gitCapable, remoteCapable, lastObservedAt, repositoryRootIdentity, currentBranch, isClean, capability)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.repositoryId,
        input.nodeIdentity,
        input.localPath,
        input.availability,
        input.gitCapable ? 1 : 0,
        input.remoteCapable ? 1 : 0,
        now,
        input.repositoryRootIdentity ?? null,
        input.currentBranch ?? null,
        input.isClean === null || input.isClean === undefined ? null : input.isClean ? 1 : 0,
        input.capability,
      ],
    );
    const row = db.get<Record<string, unknown>>('SELECT * FROM repository_locations WHERE id = ?', [id])!;
    return {
      id: String(row.id),
      repositoryId: String(row.repositoryId),
      nodeIdentity: String(row.nodeIdentity),
      localPath: String(row.localPath),
      availability: row.availability as 'available' | 'unavailable',
      gitCapable: Boolean(row.gitCapable),
      remoteCapable: Boolean(row.remoteCapable),
      lastObservedAt: String(row.lastObservedAt),
      repositoryRootIdentity: (row.repositoryRootIdentity as string) ?? null,
      currentBranch: (row.currentBranch as string) ?? null,
      isClean: row.isClean === null ? null : Boolean(row.isClean),
      capability: row.capability as RepositoryLocationCapability,
    };
  });
}
