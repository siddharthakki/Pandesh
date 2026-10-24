/**
 * Everyday Tools — Core-owned Notes and Reminders.
 *
 * Desktop schedules local notifications while Jarvis is running. Persistence
 * and CRUD authority stay in Core SQLite so state survives Desktop restarts.
 * Alerts while Jarvis is closed are not claimed here.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export const EVERYDAY_NOTE_MAX_TITLE = 200;
export const EVERYDAY_NOTE_MAX_BODY = 8_000;
export const EVERYDAY_REMINDER_MAX_TITLE = 200;
export const EVERYDAY_REMINDER_MAX_BODY = 2_000;

export type EverydayReminderStatus = 'scheduled' | 'completed' | 'cancelled' | 'notified';

export interface EverydayNoteRecord {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface EverydayReminderRecord {
  id: string;
  title: string;
  body: string;
  /** Absolute due instant as ISO-8601 UTC. */
  dueAt: string;
  /** IANA timezone used when the reminder was created (display / overdue copy). */
  timezone: string;
  status: EverydayReminderStatus;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  cancelledAt: string | null;
}

export interface EverydayReminderView extends EverydayReminderRecord {
  /** True when dueAt <= now and status is still actionable (scheduled/notified). */
  overdue: boolean;
  /** Human-readable overdue explanation after reopen. */
  overdueExplanation: string | null;
}

function requireNonEmpty(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed) throw new CoreError('invalid_request', `${field} is required`);
  if (trimmed.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return trimmed;
}

function optionalBody(value: string | undefined | null, max: number): string {
  const trimmed = String(value ?? '').trim();
  if (trimmed.length > max) throw new CoreError('invalid_request', `body exceeds ${max} characters`);
  return trimmed;
}

function parseIsoInstant(value: string, field: string): string {
  const trimmed = value.trim();
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) throw new CoreError('invalid_request', `${field} must be an ISO-8601 instant`);
  return new Date(ms).toISOString();
}

function requireTimezone(value: string | undefined | null): string {
  const tz = String(value ?? '').trim() || 'UTC';
  try {
    // Throws RangeError for unknown IANA zones in modern Node.
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
  } catch {
    throw new CoreError('invalid_request', `timezone '${tz}' is not a valid IANA time zone`);
  }
  return tz;
}

function mapNote(row: Record<string, unknown>): EverydayNoteRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    deletedAt: row.deletedAt == null ? null : String(row.deletedAt),
  };
}

function mapReminder(row: Record<string, unknown>): EverydayReminderRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    body: String(row.body),
    dueAt: String(row.dueAt),
    timezone: String(row.timezone),
    status: String(row.status) as EverydayReminderStatus,
    notifiedAt: row.notifiedAt == null ? null : String(row.notifiedAt),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    completedAt: row.completedAt == null ? null : String(row.completedAt),
    cancelledAt: row.cancelledAt == null ? null : String(row.cancelledAt),
  };
}

function formatInZone(isoUtc: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(isoUtc));
  } catch {
    return isoUtc;
  }
}

export function toReminderView(reminder: EverydayReminderRecord, nowMs: number = Date.now()): EverydayReminderView {
  const dueMs = Date.parse(reminder.dueAt);
  const actionable = reminder.status === 'scheduled' || reminder.status === 'notified';
  const overdue = actionable && Number.isFinite(dueMs) && dueMs <= nowMs;
  let overdueExplanation: string | null = null;
  if (overdue) {
    const localDue = formatInZone(reminder.dueAt, reminder.timezone);
    overdueExplanation = reminder.notifiedAt
      ? `Overdue since ${localDue} (${reminder.timezone}). Desktop alert already fired while Jarvis was running.`
      : `Overdue since ${localDue} (${reminder.timezone}). Jarvis was not running at the due time (quit, asleep, or off), so no desktop alert fired then; it is due now in Today.`;
  }
  return { ...reminder, overdue, overdueExplanation };
}

export function createNote(
  db: CoreDatabase,
  input: { title?: string; body: string },
): EverydayNoteRecord {
  const body = requireNonEmpty(input.body, 'body', EVERYDAY_NOTE_MAX_BODY);
  const title = String(input.title ?? '').trim() || body.slice(0, 80);
  const safeTitle = requireNonEmpty(title, 'title', EVERYDAY_NOTE_MAX_TITLE);
  const id = newId('note');
  const at = nowIso();
  db.run(
    `INSERT INTO everyday_notes (id, title, body, createdAt, updatedAt, deletedAt)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, safeTitle, body, at, at],
  );
  return getNote(db, id);
}

export function getNote(db: CoreDatabase, id: string): EverydayNoteRecord {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM everyday_notes WHERE id = ? AND deletedAt IS NULL',
    [id],
  );
  if (!row) throw new CoreError('not_found', `note ${id} not found`);
  return mapNote(row);
}

export function listNotes(
  db: CoreDatabase,
  options: { query?: string; limit?: number } = {},
): EverydayNoteRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const query = String(options.query ?? '').trim();
  if (!query) {
    const rows = db.all<Record<string, unknown>>(
      `SELECT * FROM everyday_notes WHERE deletedAt IS NULL
       ORDER BY updatedAt DESC, id DESC LIMIT ?`,
      [limit],
    );
    return rows.map(mapNote);
  }
  const like = `%${query.replace(/[%_]/g, '')}%`;
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM everyday_notes
     WHERE deletedAt IS NULL AND (title LIKE ? COLLATE NOCASE OR body LIKE ? COLLATE NOCASE)
     ORDER BY updatedAt DESC, id DESC LIMIT ?`,
    [like, like, limit],
  );
  return rows.map(mapNote);
}

export function updateNote(
  db: CoreDatabase,
  id: string,
  input: { title?: string; body?: string },
): EverydayNoteRecord {
  const existing = getNote(db, id);
  const title = input.title !== undefined
    ? requireNonEmpty(input.title, 'title', EVERYDAY_NOTE_MAX_TITLE)
    : existing.title;
  const body = input.body !== undefined
    ? requireNonEmpty(input.body, 'body', EVERYDAY_NOTE_MAX_BODY)
    : existing.body;
  const at = nowIso();
  db.run(
    `UPDATE everyday_notes SET title = ?, body = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`,
    [title, body, at, id],
  );
  return getNote(db, id);
}

export function deleteNote(db: CoreDatabase, id: string): EverydayNoteRecord {
  const existing = getNote(db, id);
  const at = nowIso();
  db.run(
    `UPDATE everyday_notes SET deletedAt = ?, updatedAt = ? WHERE id = ? AND deletedAt IS NULL`,
    [at, at, id],
  );
  return { ...existing, deletedAt: at, updatedAt: at };
}

export function createReminder(
  db: CoreDatabase,
  input: { title: string; body?: string; dueAt: string; timezone?: string },
): EverydayReminderRecord {
  const title = requireNonEmpty(input.title, 'title', EVERYDAY_REMINDER_MAX_TITLE);
  const body = optionalBody(input.body, EVERYDAY_REMINDER_MAX_BODY);
  const dueAt = parseIsoInstant(input.dueAt, 'dueAt');
  const timezone = requireTimezone(input.timezone);
  const id = newId('reminder');
  const at = nowIso();
  db.run(
    `INSERT INTO everyday_reminders
      (id, title, body, dueAt, timezone, status, notifiedAt, createdAt, updatedAt, completedAt, cancelledAt)
     VALUES (?, ?, ?, ?, ?, 'scheduled', NULL, ?, ?, NULL, NULL)`,
    [id, title, body, dueAt, timezone, at, at],
  );
  return getReminder(db, id);
}

export function getReminder(db: CoreDatabase, id: string): EverydayReminderRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM everyday_reminders WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `reminder ${id} not found`);
  return mapReminder(row);
}

export function listReminders(
  db: CoreDatabase,
  options: { status?: EverydayReminderStatus | 'open' | 'all'; limit?: number } = {},
): EverydayReminderView[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const status = options.status ?? 'open';
  let rows: Record<string, unknown>[];
  if (status === 'all') {
    rows = db.all<Record<string, unknown>>(
      `SELECT * FROM everyday_reminders ORDER BY dueAt ASC, id ASC LIMIT ?`,
      [limit],
    );
  } else if (status === 'open') {
    rows = db.all<Record<string, unknown>>(
      `SELECT * FROM everyday_reminders
       WHERE status IN ('scheduled', 'notified')
       ORDER BY dueAt ASC, id ASC LIMIT ?`,
      [limit],
    );
  } else {
    rows = db.all<Record<string, unknown>>(
      `SELECT * FROM everyday_reminders WHERE status = ? ORDER BY dueAt ASC, id ASC LIMIT ?`,
      [status, limit],
    );
  }
  const nowMs = Date.now();
  return rows.map((row) => toReminderView(mapReminder(row), nowMs));
}

export function completeReminder(db: CoreDatabase, id: string): EverydayReminderRecord {
  const existing = getReminder(db, id);
  if (existing.status === 'cancelled') {
    throw new CoreError('invalid_transition', `reminder ${id} is cancelled`);
  }
  if (existing.status === 'completed') return existing;
  const at = nowIso();
  db.run(
    `UPDATE everyday_reminders SET status = 'completed', completedAt = ?, updatedAt = ? WHERE id = ?`,
    [at, at, id],
  );
  return getReminder(db, id);
}

export function cancelReminder(db: CoreDatabase, id: string): EverydayReminderRecord {
  const existing = getReminder(db, id);
  if (existing.status === 'completed') {
    throw new CoreError('invalid_transition', `reminder ${id} is already completed`);
  }
  if (existing.status === 'cancelled') return existing;
  const at = nowIso();
  db.run(
    `UPDATE everyday_reminders SET status = 'cancelled', cancelledAt = ?, updatedAt = ? WHERE id = ?`,
    [at, at, id],
  );
  return getReminder(db, id);
}

export function markReminderNotified(db: CoreDatabase, id: string): EverydayReminderRecord {
  const existing = getReminder(db, id);
  if (existing.status !== 'scheduled' && existing.status !== 'notified') {
    throw new CoreError('invalid_transition', `reminder ${id} cannot be notified from status ${existing.status}`);
  }
  if (existing.status === 'notified' && existing.notifiedAt) return existing;
  const at = nowIso();
  db.run(
    `UPDATE everyday_reminders SET status = 'notified', notifiedAt = ?, updatedAt = ? WHERE id = ?`,
    [at, at, id],
  );
  return getReminder(db, id);
}

/** Due or overdue open reminders for Today / alert scheduling. */
export function listDueReminders(db: CoreDatabase, nowIsoInstant: string = nowIso()): EverydayReminderView[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM everyday_reminders
     WHERE status IN ('scheduled', 'notified') AND dueAt <= ?
     ORDER BY dueAt ASC, id ASC`,
    [nowIsoInstant],
  );
  const nowMs = Date.parse(nowIsoInstant);
  return rows.map((row) => toReminderView(mapReminder(row), nowMs));
}

/** Upcoming scheduled reminders that still need a Desktop timer. */
export function listPendingAlertReminders(db: CoreDatabase): EverydayReminderRecord[] {
  return db.all<Record<string, unknown>>(
    `SELECT * FROM everyday_reminders
     WHERE status = 'scheduled' AND notifiedAt IS NULL
     ORDER BY dueAt ASC, id ASC`,
  ).map(mapReminder);
}
