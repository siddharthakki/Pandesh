import type { CoreDatabase } from '../db/connection';
import type { ProjectRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export interface CreateProjectInput {
  name: string;
  aliases?: string[];
  description?: string | null;
  defaultRepositoryId?: string | null;
  productContext?: Record<string, unknown> | null;
  policyMetadata?: Record<string, unknown> | null;
}

export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  defaultRepositoryId?: string | null;
  productContext?: Record<string, unknown> | null;
  policyMetadata?: Record<string, unknown> | null;
  expectedRevision?: number;
}

function rowToProject(row: Record<string, unknown>, aliases: string[]): ProjectRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    aliases,
    description: (row.description as string) ?? null,
    status: row.status as ProjectRecord['status'],
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string) ?? null,
    defaultRepositoryId: (row.defaultRepositoryId as string) ?? null,
    productContext: row.productContext ? JSON.parse(String(row.productContext)) : null,
    policyMetadata: row.policyMetadata ? JSON.parse(String(row.policyMetadata)) : null,
    revision: Number(row.revision),
  };
}

function getAliases(db: CoreDatabase, projectId: string): string[] {
  return db
    .all<{ alias: string }>('SELECT alias FROM project_aliases WHERE projectId = ? ORDER BY alias', [projectId])
    .map((r) => r.alias);
}

export function createProject(db: CoreDatabase, input: CreateProjectInput): ProjectRecord {
  const name = input.name?.trim();
  if (!name) throw new CoreError('invalid_request', 'project name is required');

  return db.transaction(() => {
    const id = newId('proj');
    const now = nowIso();
    db.run(
      `INSERT INTO projects (id, name, description, status, createdAt, updatedAt, archivedAt, defaultRepositoryId, productContext, policyMetadata, revision)
       VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?, ?, 1)`,
      [
        id,
        name,
        input.description ?? null,
        now,
        now,
        input.defaultRepositoryId ?? null,
        input.productContext ? JSON.stringify(input.productContext) : null,
        input.policyMetadata ? JSON.stringify(input.policyMetadata) : null,
      ],
    );
    for (const alias of input.aliases ?? []) {
      const trimmed = alias.trim();
      if (!trimmed) continue;
      try {
        db.run('INSERT INTO project_aliases (id, projectId, alias, createdAt) VALUES (?, ?, ?, ?)', [
          newId('alias'),
          id,
          trimmed,
          now,
        ]);
      } catch (err) {
        throw new CoreError('conflict', `alias '${trimmed}' is already in use`, { alias: trimmed });
      }
    }
    const row = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id])!;
    return rowToProject(row, getAliases(db, id));
  });
}

export function getProject(db: CoreDatabase, id: string): ProjectRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `project '${id}' not found`);
  return rowToProject(row, getAliases(db, id));
}

/** Resolves a user-facing reference (id, exact name, or alias) to a project, or undefined. */
export function resolveProjectReference(db: CoreDatabase, reference: string): ProjectRecord | undefined {
  const byId = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [reference]);
  if (byId) return rowToProject(byId, getAliases(db, reference));
  const byName = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE name = ? COLLATE NOCASE', [reference]);
  if (byName) return rowToProject(byName, getAliases(db, String(byName.id)));
  const aliasRow = db.get<{ projectId: string }>('SELECT projectId FROM project_aliases WHERE alias = ? COLLATE NOCASE', [
    reference,
  ]);
  if (aliasRow) return getProject(db, aliasRow.projectId);
  return undefined;
}

export interface ListProjectsFilter {
  status?: 'active' | 'archived';
  limit?: number;
  offset?: number;
}

const MAX_PAGE_SIZE = 200;

export function listProjects(db: CoreDatabase, filter: ListProjectsFilter = {}): ProjectRecord[] {
  const limit = Math.min(filter.limit ?? 50, MAX_PAGE_SIZE);
  const offset = filter.offset ?? 0;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM projects ${where} ORDER BY createdAt DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map((row) => rowToProject(row, getAliases(db, String(row.id))));
}

export function updateProject(db: CoreDatabase, id: string, input: UpdateProjectInput): ProjectRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `project '${id}' not found`);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `project '${id}' revision mismatch`, {
        expected: input.expectedRevision,
        actual: Number(existing.revision),
      });
    }
    const now = nowIso();
    db.run(
      `UPDATE projects SET
         name = COALESCE(?, name),
         description = ?,
         defaultRepositoryId = ?,
         productContext = ?,
         policyMetadata = ?,
         updatedAt = ?,
         revision = revision + 1
       WHERE id = ?`,
      [
        input.name?.trim() || null,
        input.description !== undefined ? input.description : existing.description,
        input.defaultRepositoryId !== undefined ? input.defaultRepositoryId : existing.defaultRepositoryId,
        input.productContext !== undefined ? (input.productContext ? JSON.stringify(input.productContext) : null) : existing.productContext,
        input.policyMetadata !== undefined ? (input.policyMetadata ? JSON.stringify(input.policyMetadata) : null) : existing.policyMetadata,
        now,
        id,
      ],
    );
    return getProject(db, id);
  });
}

export function archiveProject(db: CoreDatabase, id: string): ProjectRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM projects WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `project '${id}' not found`);
    const now = nowIso();
    db.run(`UPDATE projects SET status = 'archived', archivedAt = ?, updatedAt = ?, revision = revision + 1 WHERE id = ?`, [
      now,
      now,
      id,
    ]);
    return getProject(db, id);
  });
}

/** Gets-or-creates the single well-known "Imported" project used by legacy migration when project identity can't be resolved. */
export function getOrCreateImportedDefaultProject(db: CoreDatabase): ProjectRecord {
  return db.transaction(() => {
    const aliasRow = db.get<{ projectId: string }>(
      "SELECT projectId FROM project_aliases WHERE alias = '__imported_default__'",
    );
    if (aliasRow) return getProject(db, aliasRow.projectId);

    const id = newId('proj');
    const now = nowIso();
    db.run(
      `INSERT INTO projects (id, name, description, status, createdAt, updatedAt, archivedAt, defaultRepositoryId, productContext, policyMetadata, revision)
       VALUES (?, 'Imported', 'Auto-created during M31 legacy Board migration for stories whose project identity could not be resolved.', 'active', ?, ?, NULL, NULL, NULL, NULL, 1)`,
      [id, now, now],
    );
    db.run('INSERT INTO project_aliases (id, projectId, alias, createdAt) VALUES (?, ?, ?, ?)', [
      newId('alias'),
      id,
      '__imported_default__',
      now,
    ]);
    return getProject(db, id);
  });
}
