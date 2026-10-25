/**
 * Durable background delegated tasks.
 *
 * Long-running user requests (e.g. Gmail contract extraction) run on an independent
 * background worker so interactive chat remains free and responsive. Tasks persist
 * their objective, completion criteria, checkpoints, status, and payload in SQLite,
 * ensuring progress survives Core restarts, prevents duplicate execution, and delivers
 * truthful results.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export type BackgroundTaskStatus = 'queued' | 'in_progress' | 'completed' | 'cancelled' | 'failed';

export interface BackgroundTaskCheckpoint {
  id?: string;
  kind: string;
  summary: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface BackgroundTaskRecord {
  id: string;
  attemptId: string;
  conversationId: string;
  taskType: string;
  objective: string;
  status: BackgroundTaskStatus;
  completionCriteria: string[];
  checkpoints: BackgroundTaskCheckpoint[];
  payload: Record<string, unknown>;
  resultSummary: string | null;
  resultData: string | null;
  error: string | null;
  notificationSent: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface CreateBackgroundTaskInput {
  id?: string;
  attemptId: string;
  conversationId: string;
  taskType: string;
  objective: string;
  status?: BackgroundTaskStatus;
  completionCriteria?: string[];
  payload?: Record<string, unknown>;
}

export interface UpdateBackgroundTaskInput {
  attemptId?: string;
  status?: BackgroundTaskStatus;
  completionCriteria?: string[];
  payload?: Record<string, unknown>;
  resultSummary?: string | null;
  resultData?: string | null;
  error?: string | null;
  notificationSent?: boolean;
  completedAt?: string | null;
}

function parseJsonArray<T>(val: unknown): T[] {
  try {
    const parsed = JSON.parse(String(val ?? '[]'));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseJsonObject<T extends Record<string, unknown>>(val: unknown): T {
  try {
    const parsed = JSON.parse(String(val ?? '{}'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : ({} as T);
  } catch {
    return {} as T;
  }
}

function mapRow(row: Record<string, unknown>): BackgroundTaskRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    conversationId: String(row.conversationId),
    taskType: String(row.taskType),
    objective: String(row.objective),
    status: String(row.status) as BackgroundTaskStatus,
    completionCriteria: parseJsonArray<string>(row.completionCriteria),
    checkpoints: parseJsonArray<BackgroundTaskCheckpoint>(row.checkpoints),
    payload: parseJsonObject(row.payload),
    resultSummary: row.resultSummary != null ? String(row.resultSummary) : null,
    resultData: row.resultData != null ? String(row.resultData) : null,
    error: row.error != null ? String(row.error) : null,
    notificationSent: Number(row.notificationSent) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: row.completedAt != null ? String(row.completedAt) : null,
  };
}

export function createBackgroundTask(db: CoreDatabase, input: CreateBackgroundTaskInput): BackgroundTaskRecord {
  const id = input.id ?? newId('bgtask');
  const at = nowIso();
  const status = input.status ?? 'in_progress';
  const completionCriteria = JSON.stringify(input.completionCriteria ?? []);
  const payload = JSON.stringify(input.payload ?? {});

  db.run(
    `INSERT INTO background_tasks (
       id, attemptId, conversationId, taskType, objective, status,
       completionCriteria, checkpoints, payload, resultSummary, resultData,
       error, notificationSent, createdAt, updatedAt, completedAt
     ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, NULL, NULL, NULL, 0, ?, ?, NULL)`,
    [id, input.attemptId, input.conversationId, input.taskType, input.objective, status, completionCriteria, payload, at, at],
  );

  const created = getBackgroundTask(db, id);
  if (!created) throw new CoreError('internal_error', 'failed to create background task');
  return created;
}

export function getBackgroundTask(db: CoreDatabase, id: string): BackgroundTaskRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM background_tasks WHERE id = ?', [id]);
  return row ? mapRow(row) : undefined;
}

export function getBackgroundTaskByAttempt(db: CoreDatabase, attemptId: string): BackgroundTaskRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM background_tasks WHERE attemptId = ?', [attemptId]);
  return row ? mapRow(row) : undefined;
}

export function listBackgroundTasks(
  db: CoreDatabase,
  filter: { conversationId?: string; status?: string; taskType?: string; limit?: number } = {},
): BackgroundTaskRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.conversationId) {
    clauses.push('conversationId = ?');
    params.push(filter.conversationId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.taskType) {
    clauses.push('taskType = ?');
    params.push(filter.taskType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, Number(filter.limit ?? 50)));
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM background_tasks ${where} ORDER BY createdAt DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map(mapRow);
}

export function getActiveBackgroundTask(
  db: CoreDatabase,
  filter: { conversationId?: string; taskType?: string } = {},
): BackgroundTaskRecord | undefined {
  const clauses: string[] = ["status IN ('queued', 'in_progress')"];
  const params: unknown[] = [];
  if (filter.conversationId) {
    clauses.push('conversationId = ?');
    params.push(filter.conversationId);
  }
  if (filter.taskType) {
    clauses.push('taskType = ?');
    params.push(filter.taskType);
  }
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM background_tasks WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC LIMIT 1`,
    params,
  );
  return row ? mapRow(row) : undefined;
}

export function getLatestBackgroundTask(
  db: CoreDatabase,
  filter: { conversationId?: string; taskType?: string } = {},
): BackgroundTaskRecord | undefined {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.conversationId) {
    clauses.push('conversationId = ?');
    params.push(filter.conversationId);
  }
  if (filter.taskType) {
    clauses.push('taskType = ?');
    params.push(filter.taskType);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = db.get<Record<string, unknown>>(
    `SELECT * FROM background_tasks ${where} ORDER BY createdAt DESC LIMIT 1`,
    params,
  );
  return row ? mapRow(row) : undefined;
}

export function updateBackgroundTask(db: CoreDatabase, id: string, updates: UpdateBackgroundTaskInput): BackgroundTaskRecord {
  const current = getBackgroundTask(db, id);
  if (!current) throw new CoreError('not_found', `background task ${id} not found`);

  const setClauses: string[] = ['updatedAt = ?'];
  const params: unknown[] = [nowIso()];

  if (updates.attemptId !== undefined) {
    setClauses.push('attemptId = ?');
    params.push(updates.attemptId);
  }
  if (updates.status !== undefined) {
    setClauses.push('status = ?');
    params.push(updates.status);
  }
  if (updates.completionCriteria !== undefined) {
    setClauses.push('completionCriteria = ?');
    params.push(JSON.stringify(updates.completionCriteria));
  }
  if (updates.payload !== undefined) {
    setClauses.push('payload = ?');
    params.push(JSON.stringify(updates.payload));
  }
  if (updates.resultSummary !== undefined) {
    setClauses.push('resultSummary = ?');
    params.push(updates.resultSummary);
  }
  if (updates.resultData !== undefined) {
    setClauses.push('resultData = ?');
    params.push(updates.resultData);
  }
  if (updates.error !== undefined) {
    setClauses.push('error = ?');
    params.push(updates.error);
  }
  if (updates.notificationSent !== undefined) {
    setClauses.push('notificationSent = ?');
    params.push(updates.notificationSent ? 1 : 0);
  }
  if (updates.completedAt !== undefined) {
    setClauses.push('completedAt = ?');
    params.push(updates.completedAt);
  }

  params.push(id);
  db.run(`UPDATE background_tasks SET ${setClauses.join(', ')} WHERE id = ?`, params);

  const updated = getBackgroundTask(db, id);
  if (!updated) throw new CoreError('internal_error', 'failed to update background task');
  return updated;
}

export function recordBackgroundTaskCheckpoint(
  db: CoreDatabase,
  id: string,
  checkpoint: BackgroundTaskCheckpoint,
): BackgroundTaskRecord {
  const current = getBackgroundTask(db, id);
  if (!current) throw new CoreError('not_found', `background task ${id} not found`);

  const checkpoints = [...current.checkpoints, { ...checkpoint, id: checkpoint.id ?? newId('ckpt'), timestamp: checkpoint.timestamp || nowIso() }];
  db.run('UPDATE background_tasks SET checkpoints = ?, updatedAt = ? WHERE id = ?', [
    JSON.stringify(checkpoints),
    nowIso(),
    id,
  ]);

  return getBackgroundTask(db, id)!;
}

export function cancelBackgroundTask(db: CoreDatabase, id: string, reason = 'Cancelled by user'): BackgroundTaskRecord {
  const current = getBackgroundTask(db, id);
  if (!current) throw new CoreError('not_found', `background task ${id} not found`);

  if (current.status === 'completed' || current.status === 'cancelled') {
    return current;
  }

  const at = nowIso();
  db.run(
    "UPDATE background_tasks SET status = 'cancelled', error = ?, completedAt = ?, updatedAt = ? WHERE id = ?",
    [reason, at, at, id],
  );

  return getBackgroundTask(db, id)!;
}

export function isBackgroundTaskAttempt(db: CoreDatabase, attemptId: string): boolean {
  const row = db.get<{ count: number }>(
    "SELECT COUNT(*) AS count FROM background_tasks WHERE attemptId = ? AND status IN ('queued', 'in_progress')",
    [attemptId],
  );
  return (row?.count ?? 0) > 0;
}
