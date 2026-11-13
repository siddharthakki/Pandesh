import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

/**
 * Durable scheduled tasks: an instruction Core runs as an ordinary Pi attempt
 * at a wall-clock time (daily, or once). Rows live in SQLite, so schedules
 * survive Core/desktop restarts. Firing is at-most-once: nextRunAt advances
 * before the attempt is submitted, so a crash mid-fire never double-runs.
 */
export interface ScheduledTaskRecord {
  id: string;
  title: string;
  instruction: string;
  dailyTime: string;
  repeat: 'daily' | 'once';
  timezone: string;
  conversationId: string | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
  model: string | null;
  /**
   * Set when this row is a Core-executed routine (e.g. `daily_brief`) rather
   * than an instruction submitted to the model. A routine is executed by Core
   * itself, deterministically, and never opens an agent attempt.
   */
  routine: string | null;
  /** Null means daily (or once, per `repeat`). */
  recurrence: Recurrence | null;
  /** What the routine is for, in the words shown to the person. */
  purpose: string | null;
  /** The bounded authority the person approved for an unattended routine: its sources, operations and limits. */
  scope: Record<string, unknown> | null;
}

/** A routine that does not run every day: on given weekdays (0 = Sunday), or every N days from an anchor date. */
export type Recurrence =
  | { kind: 'weekly'; weekdays: number[] }
  | { kind: 'interval_days'; every: number; anchor: string };

/** A run missed while KarkeDikha was not running still fires on startup if
 * it is at most this late; older misses skip to the next occurrence. */
export const SCHEDULE_CATCH_UP_MS = 6 * 60 * 60 * 1000;

function map(row: Record<string, unknown>): ScheduledTaskRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    instruction: String(row.instruction),
    dailyTime: String(row.dailyTime),
    repeat: row.repeat === 'once' ? 'once' : 'daily',
    timezone: String(row.timezone),
    conversationId: (row.conversationId as string) ?? null,
    enabled: Number(row.enabled) === 1,
    nextRunAt: String(row.nextRunAt),
    lastRunAt: (row.lastRunAt as string) ?? null,
    lastAttemptId: (row.lastAttemptId as string) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    model: (row.model as string) ?? null,
    routine: (row.routine as string | null) ?? null,
    recurrence: row.recurrenceJson ? JSON.parse(String(row.recurrenceJson)) as Recurrence : null,
    purpose: (row.purpose as string | null) ?? null,
    scope: row.scopeJson ? JSON.parse(String(row.scopeJson)) as Record<string, unknown> : null,
  };
}

function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** UTC instant of wall-clock y-m-d hh:mm in `timeZone` (DST-correct). */
function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const first = new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
  return new Date(guess.getTime() - zoneOffsetMs(first, timeZone));
}

/** Next occurrence of `dailyTime` (HH:MM) strictly after `after`, in `timeZone`. */
export function nextDailyOccurrence(dailyTime: string, timeZone: string, after: Date): Date {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(dailyTime);
  if (!match) throw new CoreError('invalid_request', 'dailyTime must be HH:MM (24-hour)');
  const local = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(after).map((p) => [p.type, p.value]));
  for (let offset = 0; offset < 3; offset++) {
    const day = new Date(Date.UTC(+local.year, +local.month - 1, +local.day + offset));
    const candidate = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +match[1], +match[2], timeZone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new CoreError('internal_error', 'could not compute next occurrence');
}

function localYmd(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(at).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day };
}

export function validateRecurrence(r: Recurrence | null | undefined): Recurrence | null {
  if (!r) return null;
  if (r.kind === 'weekly') {
    const days = [...new Set((r.weekdays ?? []).map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort();
    if (!days.length) throw new CoreError('invalid_request', 'a weekly routine needs at least one weekday (0 = Sunday … 6 = Saturday)');
    return { kind: 'weekly', weekdays: days };
  }
  if (r.kind === 'interval_days') {
    const every = Math.trunc(Number(r.every));
    if (!(every >= 2 && every <= 366)) throw new CoreError('invalid_request', 'an interval routine runs every 2–366 days');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.anchor))) throw new CoreError('invalid_request', 'an interval routine needs an anchor date YYYY-MM-DD');
    return { kind: 'interval_days', every, anchor: r.anchor };
  }
  throw new CoreError('invalid_request', 'recurrence kind must be weekly or interval_days');
}

/** Next occurrence strictly after `after`: daily when there is no recurrence, else on its weekdays or interval days. */
export function nextOccurrence(task: { dailyTime: string; timezone: string; recurrence?: Recurrence | null }, after: Date): Date {
  const rec = task.recurrence ?? null;
  if (!rec) return nextDailyOccurrence(task.dailyTime, task.timezone, after);
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(task.dailyTime);
  if (!match) throw new CoreError('invalid_request', 'dailyTime must be HH:MM (24-hour)');
  const start = localYmd(after, task.timezone);
  const anchorMs = rec.kind === 'interval_days' ? Date.UTC(+rec.anchor.slice(0, 4), +rec.anchor.slice(5, 7) - 1, +rec.anchor.slice(8, 10)) : 0;
  for (let offset = 0; offset <= 370; offset++) {
    const day = new Date(Date.UTC(start.y, start.m - 1, start.d + offset));
    const sinceAnchor = Math.round((day.getTime() - anchorMs) / 86_400_000);
    const ok = rec.kind === 'weekly' ? rec.weekdays.includes(day.getUTCDay()) : sinceAnchor >= 0 && sinceAnchor % rec.every === 0;
    if (!ok) continue;
    const candidate = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), +match[1], +match[2], task.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new CoreError('internal_error', 'could not compute next occurrence');
}

/** How late a missed run may still fire: a weekly routine tolerates more delay than a daily one. */
export function catchUpWindowMs(task: { recurrence?: Recurrence | null }): number {
  const rec = task.recurrence ?? null;
  if (!rec) return SCHEDULE_CATCH_UP_MS;
  if (rec.kind === 'weekly') return 3 * 86_400_000;
  return Math.min(rec.every, 7) * 12 * 3_600_000;
}

function requireTimezone(tz: string | undefined): string {
  const zone = (tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC').trim();
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); } catch { throw new CoreError('invalid_request', `unknown timezone '${zone}'`); }
  return zone;
}

export function createScheduledTask(db: CoreDatabase, input: {
  title: string; instruction: string; dailyTime?: string; runAt?: string; timezone?: string; conversationId?: string | null; model?: string | null; routine?: string | null; now?: Date;
  recurrence?: Recurrence | null; purpose?: string | null; scope?: Record<string, unknown> | null;
}): ScheduledTaskRecord {
  const title = input.title.trim().slice(0, 200);
  const instruction = input.instruction.trim();
  if (!title || !instruction) throw new CoreError('invalid_request', 'title and instruction are required');
  if (instruction.length > 4000) throw new CoreError('invalid_request', 'instruction exceeds 4000 characters');
  const routine = input.routine ? input.routine.trim().slice(0, 64) : null;
  const timezone = requireTimezone(input.timezone);
  const now = input.now ?? new Date();
  let repeat: 'daily' | 'once';
  let dailyTime: string;
  let nextRunAt: Date;
  const recurrence = input.runAt ? null : validateRecurrence(input.recurrence);
  if (input.runAt) {
    nextRunAt = new Date(input.runAt);
    if (Number.isNaN(nextRunAt.getTime())) throw new CoreError('invalid_request', 'runAt must be an ISO date-time');
    if (nextRunAt.getTime() < now.getTime() - 60_000) throw new CoreError('invalid_request', 'runAt is in the past');
    repeat = 'once';
    dailyTime = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(nextRunAt);
  } else {
    dailyTime = String(input.dailyTime ?? '').trim();
    nextRunAt = nextOccurrence({ dailyTime, timezone, recurrence }, now);
    repeat = 'daily';
  }
  const id = newId('sched');
  const at = nowIso();
  db.run(
    `INSERT INTO scheduled_tasks (id, title, instruction, dailyTime, repeat, timezone, conversationId, enabled, nextRunAt, lastRunAt, lastAttemptId, createdAt, updatedAt, model, routine, recurrenceJson, purpose, scopeJson)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    [id, title, instruction, dailyTime, repeat, timezone, input.conversationId ?? null, nextRunAt.toISOString(), at, at, input.model ?? null, routine,
      recurrence ? JSON.stringify(recurrence) : null, input.purpose?.trim().slice(0, 300) || null, input.scope ? JSON.stringify(input.scope) : null],
  );
  return getScheduledTask(db, id);
}

export function getScheduledTask(db: CoreDatabase, id: string): ScheduledTaskRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM scheduled_tasks WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `scheduled task ${id} not found`);
  return map(row);
}

export function listScheduledTasks(db: CoreDatabase, includeDisabled = false): ScheduledTaskRecord[] {
  return db.all<Record<string, unknown>>(
    `SELECT * FROM scheduled_tasks ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY nextRunAt ASC`,
  ).map(map);
}

export function cancelScheduledTask(db: CoreDatabase, id: string): ScheduledTaskRecord {
  getScheduledTask(db, id);
  db.run('UPDATE scheduled_tasks SET enabled = 0, updatedAt = ? WHERE id = ?', [nowIso(), id]);
  // A cancelled routine keeps no standing write permission.
  db.run("UPDATE routine_write_grants SET status = 'revoked', revokedBy = 'core', revokedAt = ?, revokeReason = 'the routine was cancelled' WHERE taskId = ? AND status = 'active'", [nowIso(), id]);
  return getScheduledTask(db, id);
}

/**
 * Turns a daily task on or off. Enabling recomputes the next occurrence from
 * now, so a routine that was switched off for a week does not fire for the
 * week it was off.
 */
export function setScheduledTaskEnabled(
  db: CoreDatabase,
  id: string,
  enabled: boolean,
  now: Date = new Date(),
): ScheduledTaskRecord {
  const task = getScheduledTask(db, id);
  if (task.repeat === 'once') {
    if (enabled) throw new CoreError('invalid_transition', 'a one-time task cannot be re-enabled');
    return cancelScheduledTask(db, id);
  }
  const at = nowIso();
  if (enabled) {
    const next = nextOccurrence(task, now).toISOString();
    db.run('UPDATE scheduled_tasks SET enabled = 1, nextRunAt = ?, updatedAt = ? WHERE id = ?', [next, at, id]);
  } else {
    db.run('UPDATE scheduled_tasks SET enabled = 0, updatedAt = ? WHERE id = ?', [at, id]);
  }
  return getScheduledTask(db, id);
}

/** Moves a daily task to a new time of day (and optionally a new zone). */
export function rescheduleDailyTask(
  db: CoreDatabase,
  id: string,
  input: { dailyTime: string; timezone?: string; now?: Date; recurrence?: Recurrence | null },
): ScheduledTaskRecord {
  const task = getScheduledTask(db, id);
  if (task.repeat === 'once') throw new CoreError('invalid_transition', 'a one-time task cannot be rescheduled');
  const timezone = requireTimezone(input.timezone ?? task.timezone);
  const dailyTime = String(input.dailyTime ?? '').trim();
  const recurrence = input.recurrence === undefined ? task.recurrence : validateRecurrence(input.recurrence);
  const next = nextOccurrence({ dailyTime, timezone, recurrence }, input.now ?? new Date()).toISOString();
  db.run('UPDATE scheduled_tasks SET dailyTime = ?, timezone = ?, recurrenceJson = ?, nextRunAt = ?, updatedAt = ? WHERE id = ?', [
    dailyTime, timezone, recurrence ? JSON.stringify(recurrence) : null, next, nowIso(), id,
  ]);
  return getScheduledTask(db, id);
}

/** Replaces a routine's approved scope (and optionally its title or purpose). The caller owns the approval. */
export function updateScheduledTaskScope(db: CoreDatabase, id: string, input: { scope: Record<string, unknown>; title?: string; purpose?: string }): ScheduledTaskRecord {
  getScheduledTask(db, id);
  db.run('UPDATE scheduled_tasks SET scopeJson = ?, title = COALESCE(?, title), purpose = COALESCE(?, purpose), updatedAt = ? WHERE id = ?', [
    JSON.stringify(input.scope), input.title?.trim().slice(0, 200) || null, input.purpose?.trim().slice(0, 300) || null, nowIso(), id,
  ]);
  return getScheduledTask(db, id);
}

/** Every scheduled task of one routine kind, including the disabled ones. */
export function listRoutineTasks(db: CoreDatabase, routine: string): ScheduledTaskRecord[] {
  return db.all<Record<string, unknown>>(
    'SELECT * FROM scheduled_tasks WHERE routine = ? ORDER BY createdAt ASC',
    [routine],
  ).map(map);
}

/**
 * Claims every due task: advances (or disables) its schedule first, then
 * returns the claimed runs for the caller to submit. Runs missed by more than
 * SCHEDULE_CATCH_UP_MS are skipped to their next occurrence, not fired.
 */
export function claimDueScheduledTasks(
  db: CoreDatabase,
  now = new Date(),
  onMissed?: (task: ScheduledTaskRecord, dueAt: string) => void,
): Array<{ task: ScheduledTaskRecord; late: boolean }> {
  const due = db.all<Record<string, unknown>>(
    'SELECT * FROM scheduled_tasks WHERE enabled = 1 AND nextRunAt <= ? ORDER BY nextRunAt ASC',
    [now.toISOString()],
  ).map(map);
  const claimed: Array<{ task: ScheduledTaskRecord; late: boolean }> = [];
  for (const task of due) {
    const lateness = now.getTime() - new Date(task.nextRunAt).getTime();
    const fire = lateness <= catchUpWindowMs(task);
    const at = nowIso();
    if (task.repeat === 'once') {
      db.run('UPDATE scheduled_tasks SET enabled = 0, lastRunAt = ?, updatedAt = ? WHERE id = ? AND enabled = 1', [fire ? at : task.lastRunAt, at, task.id]);
    } else {
      const next = nextOccurrence(task, now).toISOString();
      db.run('UPDATE scheduled_tasks SET nextRunAt = ?, lastRunAt = ?, updatedAt = ? WHERE id = ?', [next, fire ? at : task.lastRunAt, at, task.id]);
    }
    if (fire) claimed.push({ task, late: lateness > 120_000 });
    else onMissed?.(task, task.nextRunAt);
  }
  return claimed;
}

export function recordScheduledRun(db: CoreDatabase, id: string, input: { attemptId: string; conversationId: string }): void {
  db.run('UPDATE scheduled_tasks SET lastAttemptId = ?, conversationId = ?, updatedAt = ? WHERE id = ?', [input.attemptId, input.conversationId, nowIso(), id]);
}
