/**
 * Pandesh's one proactive routine: a user-configured daily brief.
 *
 * The routine is not a new scheduler. It is a row in Core's durable
 * `scheduled_tasks` table marked with `routine = 'daily_brief'`, so it
 * inherits the existing scheduler's guarantees:
 *
 * - it survives restarts (the schedule lives in SQLite),
 * - it fires at most once per occurrence (the scheduler advances `nextRunAt`
 *   before the routine runs), and
 * - it can be switched off (the `enabled` flag).
 *
 * On top of that, `routine_deliveries` is the delivery ledger: the pair
 * (routine, occurrence) is the primary key, so the database itself refuses a
 * second delivery of the same occurrence. That is what keeps the notification
 * from arriving twice.
 *
 * The routine never sends email and never performs a sensitive action. It only
 * reads, and it writes one message into its own conversation.
 */
import type { CoreDatabase } from '../db/connection';
import type { DailyBriefRoutine } from '../shared/wireTypes';
import { CoreError } from './errors';
import { nowIso } from './ids';
import {
  createScheduledTask,
  listRoutineTasks,
  rescheduleDailyTask,
  setScheduledTaskEnabled,
  type ScheduledTaskRecord,
} from './scheduledTasks';

export const DAILY_BRIEF_ROUTINE = 'daily_brief';
export const DAILY_BRIEF_TITLE = 'Daily brief';
export const DAILY_BRIEF_INSTRUCTION =
  'Deliver today\'s brief: calendar commitments, unread email, pending work and approvals, and follow-ups. '
  + 'Read only — never send mail and never take a consequential action.';

const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function requireDailyTime(value: string): string {
  const trimmed = String(value ?? '').trim();
  if (!DAILY_TIME_PATTERN.test(trimmed)) {
    throw new CoreError('invalid_request', 'dailyTime must be HH:MM in 24-hour time');
  }
  return trimmed;
}

function requireTimezone(value: string | undefined): string {
  const zone = String(value ?? '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
  } catch {
    throw new CoreError('invalid_request', `unknown timezone '${zone}'`);
  }
  return zone;
}

function toRoutine(task: ScheduledTaskRecord): DailyBriefRoutine {
  return {
    id: task.id,
    enabled: task.enabled,
    dailyTime: task.dailyTime,
    timezone: task.timezone,
    nextRunAt: task.enabled ? task.nextRunAt : null,
    lastRunAt: task.lastRunAt,
    conversationId: task.conversationId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

/** The configured daily brief, or null when it was never set up. */
export function getDailyBriefRoutine(db: CoreDatabase): DailyBriefRoutine | null {
  const tasks = listRoutineTasks(db, DAILY_BRIEF_ROUTINE);
  const task = tasks[tasks.length - 1];
  return task ? toRoutine(task) : null;
}

/**
 * Creates or updates the daily brief routine.
 *
 * `enabled: false` switches an existing routine off without deleting it, so
 * the operator can turn it back on later without losing its place.
 */
export function configureDailyBriefRoutine(
  db: CoreDatabase,
  input: { dailyTime: string; timezone?: string; enabled?: boolean; now?: Date },
): DailyBriefRoutine {
  const dailyTime = requireDailyTime(input.dailyTime);
  const timezone = requireTimezone(input.timezone);
  const now = input.now ?? new Date();
  const enabled = input.enabled ?? true;
  const existing = listRoutineTasks(db, DAILY_BRIEF_ROUTINE)[0];
  if (!existing) {
    const task = createScheduledTask(db, {
      title: DAILY_BRIEF_TITLE,
      instruction: DAILY_BRIEF_INSTRUCTION,
      dailyTime,
      timezone,
      routine: DAILY_BRIEF_ROUTINE,
      now,
    });
    if (!enabled) setScheduledTaskEnabled(db, task.id, false, now);
    return toRoutine(getRoutineTask(db, task.id));
  }
  const moved = rescheduleDailyTask(db, existing.id, { dailyTime, timezone, now });
  const settled = setScheduledTaskEnabled(db, moved.id, enabled, now);
  return toRoutine(settled);
}

/** Switches the routine off. Returns the routine as it now stands. */
export function disableDailyBriefRoutine(db: CoreDatabase, now: Date = new Date()): DailyBriefRoutine | null {
  const existing = listRoutineTasks(db, DAILY_BRIEF_ROUTINE)[0];
  if (!existing) return null;
  setScheduledTaskEnabled(db, existing.id, false, now);
  return toRoutine(getRoutineTask(db, existing.id));
}

function getRoutineTask(db: CoreDatabase, id: string): ScheduledTaskRecord {
  const task = listRoutineTasks(db, DAILY_BRIEF_ROUTINE).find((candidate) => candidate.id === id);
  if (!task) throw new CoreError('not_found', 'the daily brief routine no longer exists');
  return task;
}

/**
 * Claims one occurrence for delivery.
 *
 * The insert is the atomicity primitive: the (routineId, occurrenceKey) primary
 * key means exactly one caller can win the claim. A caller that loses the race
 * gets `false` and must not deliver — that is what stops a duplicate
 * notification.
 */
export function claimRoutineDelivery(
  db: CoreDatabase,
  routineId: string,
  occurrenceKey: string,
): boolean {
  try {
    db.run(
      `INSERT INTO routine_deliveries (routineId, occurrenceKey, claimedAt, deliveredAt, conversationId, messageId)
       VALUES (?, ?, ?, NULL, NULL, NULL)`,
      [routineId, occurrenceKey, nowIso()],
    );
    return true;
  } catch {
    return false;
  }
}

/** Records that the claimed occurrence was actually delivered. */
export function completeRoutineDelivery(
  db: CoreDatabase,
  routineId: string,
  occurrenceKey: string,
  input: { conversationId: string; messageId: string },
): void {
  db.run(
    'UPDATE routine_deliveries SET deliveredAt = ?, conversationId = ?, messageId = ? WHERE routineId = ? AND occurrenceKey = ?',
    [nowIso(), input.conversationId, input.messageId, routineId, occurrenceKey],
  );
}

/**
 * Gives a claimed occurrence back.
 *
 * A claim is released only when the delivery never happened — a source that
 * could not be read, a write that failed. The ledger then says the truth
 * ("not delivered") instead of holding a reservation for work that was never
 * done, so a later, legitimate delivery of the same occurrence is still
 * possible. A delivered occurrence is never released.
 */
export function releaseRoutineDelivery(
  db: CoreDatabase,
  routineId: string,
  occurrenceKey: string,
): void {
  db.run(
    'DELETE FROM routine_deliveries WHERE routineId = ? AND occurrenceKey = ? AND deliveredAt IS NULL',
    [routineId, occurrenceKey],
  );
}

/** The occurrence this routine last delivered, or null when it never has. */
export function lastRoutineDelivery(
  db: CoreDatabase,
  routineId: string,
): { occurrenceKey: string; deliveredAt: string } | null {
  const row = db.get<{ occurrenceKey: string; deliveredAt: string }>(
    `SELECT occurrenceKey, deliveredAt FROM routine_deliveries
      WHERE routineId = ? AND deliveredAt IS NOT NULL
      ORDER BY deliveredAt DESC LIMIT 1`,
    [routineId],
  );
  return row ? { occurrenceKey: String(row.occurrenceKey), deliveredAt: String(row.deliveredAt) } : null;
}

/** The occurrence key for one scheduled fire: the instant it was due. */
export function dailyBriefOccurrenceKey(routineId: string, dueAt: string): string {
  return `${routineId}@${dueAt}`;
}
