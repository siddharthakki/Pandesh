import type { CoreDatabase } from '../db/connection';
import type { StoryRecord, StoryStatus, StoryType, StoryCommentRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { validateTransition, isArchivable } from './transitions';
import { recordStoryEvent } from './events';

export interface CreateStoryInput {
  projectId: string;
  repositoryId?: string | null;
  title: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: string | null;
  status?: StoryStatus;
  storyType: StoryType;
  parentId?: string | null;
  assignee?: Record<string, unknown> | null;
  source?: Record<string, unknown> | null;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
  /** Reuses an existing ID (e.g. a legacy Board story's original ID) instead of minting a new one. Migration-only escape hatch. */
  presetId?: string;
  /** Overrides createdAt/updatedAt to preserve legacy timestamps during migration; defaults to now. */
  createdAtOverride?: string;
  updatedAtOverride?: string;
}

export interface UpdateStoryInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: string[];
  priority?: string | null;
  assignee?: Record<string, unknown> | null;
  expectedRevision?: number;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
}

function rowToStory(row: Record<string, unknown>): StoryRecord {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    repositoryId: (row.repositoryId as string) ?? null,
    title: String(row.title),
    description: String(row.description ?? ''),
    acceptanceCriteria: JSON.parse(String(row.acceptanceCriteria ?? '[]')),
    priority: (row.priority as string) ?? null,
    status: row.status as StoryStatus,
    storyType: row.storyType as StoryType,
    parentId: (row.parentId as string) ?? null,
    assignee: row.assignee ? JSON.parse(String(row.assignee)) : null,
    source: row.source ? JSON.parse(String(row.source)) : null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string) ?? null,
    revision: Number(row.revision),
  };
}

export function getStory(db: CoreDatabase, id: string): StoryRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM stories WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `story '${id}' not found`);
  return rowToStory(row);
}

function assertProjectExists(db: CoreDatabase, projectId: string): void {
  const row = db.get('SELECT id FROM projects WHERE id = ?', [projectId]);
  if (!row) throw new CoreError('invalid_request', `project '${projectId}' does not exist`);
}

const MAX_ACCEPTANCE_CRITERIA = 50;

export function createStory(db: CoreDatabase, input: CreateStoryInput): StoryRecord {
  const title = input.title?.trim();
  if (!title) throw new CoreError('invalid_request', 'story title is required');
  if ((input.acceptanceCriteria ?? []).length > MAX_ACCEPTANCE_CRITERIA) {
    throw new CoreError('invalid_request', `acceptanceCriteria exceeds max of ${MAX_ACCEPTANCE_CRITERIA} entries`);
  }

  return db.transaction(() => {
    assertProjectExists(db, input.projectId);
    if (input.parentId) {
      const parent = db.get('SELECT id FROM stories WHERE id = ?', [input.parentId]);
      if (!parent) throw new CoreError('invalid_request', `parent story '${input.parentId}' does not exist`);
    }

    if (input.presetId) {
      const conflict = db.get('SELECT id FROM stories WHERE id = ?', [input.presetId]);
      if (conflict) throw new CoreError('conflict', `story '${input.presetId}' already exists`);
    }
    const id = input.presetId ?? newId('story');
    const now = nowIso();
    const createdAt = input.createdAtOverride ?? now;
    const updatedAt = input.updatedAtOverride ?? now;
    const status: StoryStatus = input.status ?? 'inbox';
    db.run(
      `INSERT INTO stories (id, projectId, repositoryId, title, description, acceptanceCriteria, priority, status, storyType, parentId, assignee, source, createdAt, updatedAt, archivedAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      [
        id,
        input.projectId,
        input.repositoryId ?? null,
        title,
        input.description ?? '',
        JSON.stringify(input.acceptanceCriteria ?? []),
        input.priority ?? null,
        status,
        input.storyType,
        input.parentId ?? null,
        input.assignee ? JSON.stringify(input.assignee) : null,
        input.source ? JSON.stringify(input.source) : null,
        createdAt,
        updatedAt,
      ],
    );
    recordStoryEvent(db, {
      storyId: id,
      eventType: 'story_created',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { title, status, storyType: input.storyType },
      resultingRevision: 1,
    });
    return getStory(db, id);
  });
}

export interface ListStoriesFilter {
  projectId?: string;
  status?: StoryStatus;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

const MAX_PAGE_SIZE = 200;

export function listStories(db: CoreDatabase, filter: ListStoriesFilter = {}): StoryRecord[] {
  const limit = Math.min(filter.limit ?? 50, MAX_PAGE_SIZE);
  const offset = filter.offset ?? 0;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.projectId) {
    clauses.push('projectId = ?');
    params.push(filter.projectId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (!filter.includeArchived) {
    clauses.push("status != 'archived'");
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM stories ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map(rowToStory);
}

export function updateStory(db: CoreDatabase, id: string, input: UpdateStoryInput): StoryRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM stories WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `story '${id}' not found`);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `story '${id}' revision mismatch`, {
        expected: input.expectedRevision,
        actual: Number(existing.revision),
      });
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run(
      `UPDATE stories SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         acceptanceCriteria = COALESCE(?, acceptanceCriteria),
         priority = ?,
         assignee = ?,
         updatedAt = ?,
         revision = ?
       WHERE id = ?`,
      [
        input.title?.trim() || null,
        input.description !== undefined ? input.description : null,
        input.acceptanceCriteria !== undefined ? JSON.stringify(input.acceptanceCriteria) : null,
        input.priority !== undefined ? input.priority : existing.priority,
        input.assignee !== undefined ? (input.assignee ? JSON.stringify(input.assignee) : null) : existing.assignee,
        now,
        newRevision,
        id,
      ],
    );
    recordStoryEvent(db, {
      storyId: id,
      eventType: 'story_updated',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { fields: Object.keys(input).filter((k) => !['actor', 'clientId', 'idempotencyKey', 'expectedRevision'].includes(k)) },
      resultingRevision: newRevision,
    });
    return getStory(db, id);
  });
}

export interface TransitionStoryInput {
  toStatus: StoryStatus;
  expectedRevision?: number;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
  reason?: string;
}

export function transitionStory(db: CoreDatabase, id: string, input: TransitionStoryInput): StoryRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM stories WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `story '${id}' not found`);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `story '${id}' revision mismatch`);
    }
    const fromStatus = existing.status as StoryStatus;
    const result = validateTransition(fromStatus, input.toStatus);
    if (!result.ok) {
      throw new CoreError('invalid_transition', result.reason, { from: fromStatus, to: input.toStatus });
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE stories SET status = ?, updatedAt = ?, revision = ? WHERE id = ?', [
      input.toStatus,
      now,
      newRevision,
      id,
    ]);
    recordStoryEvent(db, {
      storyId: id,
      eventType: 'story_transitioned',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { from: fromStatus, to: input.toStatus, reason: input.reason ?? null },
      resultingRevision: newRevision,
    });
    return getStory(db, id);
  });
}

export function archiveStory(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null; idempotencyKey?: string | null },
): StoryRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM stories WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `story '${id}' not found`);
    if (!isArchivable(existing.status as StoryStatus)) {
      throw new CoreError('invalid_transition', `story '${id}' is already archived`);
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run("UPDATE stories SET status = 'archived', archivedAt = ?, updatedAt = ?, revision = ? WHERE id = ?", [
      now,
      now,
      newRevision,
      id,
    ]);
    recordStoryEvent(db, {
      storyId: id,
      eventType: 'story_archived',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { previousStatus: existing.status },
      resultingRevision: newRevision,
    });
    return getStory(db, id);
  });
}

const MAX_COMMENT_BODY = 20000;

export function addComment(
  db: CoreDatabase,
  storyId: string,
  input: { author: string; body: string; clientId?: string | null; idempotencyKey?: string | null },
): StoryCommentRecord {
  const body = input.body?.trim();
  if (!body) throw new CoreError('invalid_request', 'comment body is required');
  if (body.length > MAX_COMMENT_BODY) {
    throw new CoreError('invalid_request', `comment body exceeds ${MAX_COMMENT_BODY} characters`);
  }
  return db.transaction(() => {
    const story = db.get('SELECT id, revision FROM stories WHERE id = ?', [storyId]) as { id: string; revision: number } | undefined;
    if (!story) throw new CoreError('not_found', `story '${storyId}' not found`);
    const id = newId('comment');
    const now = nowIso();
    db.run('INSERT INTO story_comments (id, storyId, author, body, createdAt) VALUES (?, ?, ?, ?, ?)', [
      id,
      storyId,
      input.author,
      body,
      now,
    ]);
    recordStoryEvent(db, {
      storyId,
      eventType: 'comment_added',
      actor: input.author,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: { commentId: id },
      resultingRevision: story.revision,
    });
    return { id, storyId, author: input.author, body, createdAt: now };
  });
}

export function listComments(db: CoreDatabase, storyId: string): StoryCommentRecord[] {
  return db.all<StoryCommentRecord>('SELECT id, storyId, author, body, createdAt FROM story_comments WHERE storyId = ? ORDER BY createdAt ASC', [
    storyId,
  ]);
}
