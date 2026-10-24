/**
 * Intelligence Scout watches as durable schedules.
 *
 * A watch is only a watch if something runs it. The watch itself lives in
 * `core/runtime/intelligenceScout.ts` (a JSON file in Core's data dir); the
 * *schedule* lives here, as a row in Core's durable `scheduled_tasks` table
 * marked with `routine = 'intelligence_scout'`.
 *
 * That means a watch inherits the existing scheduler's guarantees:
 *   - it survives restarts (the schedule lives in SQLite),
 *   - it fires at most once per occurrence (the scheduler advances
 *     `nextRunAt` before the routine runs), and
 *   - it can be switched off (the `enabled` flag).
 *
 * The routine is created when the operator asks for a watch — never
 * silently, and never for a watch nobody asked for.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import {
  createScheduledTask,
  getScheduledTask,
  listRoutineTasks,
  setScheduledTaskEnabled,
  type ScheduledTaskRecord,
} from './scheduledTasks';

export const SCOUT_ROUTINE = 'intelligence_scout';
/** The scheduled-task instruction carries the watch id it belongs to. */
export const SCOUT_WATCH_INSTRUCTION_PREFIX = 'scout-watch:';
export const SCOUT_DEFAULT_DAILY_TIME = '09:00';

export function scoutWatchInstruction(watchId: string): string {
  return `${SCOUT_WATCH_INSTRUCTION_PREFIX}${watchId}`;
}

/** The watch id a scheduled task belongs to, or null for any other task. */
export function parseScoutWatchId(instruction: string): string | null {
  const trimmed = String(instruction ?? '').trim();
  if (!trimmed.startsWith(SCOUT_WATCH_INSTRUCTION_PREFIX)) return null;
  const watchId = trimmed.slice(SCOUT_WATCH_INSTRUCTION_PREFIX.length).trim();
  return watchId.length > 0 ? watchId : null;
}

/** Every scout schedule, with the watch each one belongs to. */
export function listScoutSchedules(db: CoreDatabase): Array<{ task: ScheduledTaskRecord; watchId: string }> {
  return listRoutineTasks(db, SCOUT_ROUTINE)
    .map((task) => ({ task, watchId: parseScoutWatchId(task.instruction) }))
    .filter((entry): entry is { task: ScheduledTaskRecord; watchId: string } => entry.watchId !== null);
}

/** The schedule for one watch, or null when it has none. */
export function findScoutSchedule(db: CoreDatabase, watchId: string): ScheduledTaskRecord | null {
  return listScoutSchedules(db).find((entry) => entry.watchId === watchId)?.task ?? null;
}

/**
 * Schedules a watch. Idempotent: a watch that is already scheduled keeps its
 * existing schedule (and its place in the day) rather than being reset.
 */
export function scheduleScoutWatch(
  db: CoreDatabase,
  input: { watchId: string; name: string; dailyTime?: string; timezone?: string; now?: Date },
): ScheduledTaskRecord {
  const existing = findScoutSchedule(db, input.watchId);
  if (existing) return existing;
  const dailyTime = String(input.dailyTime ?? SCOUT_DEFAULT_DAILY_TIME).trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyTime)) {
    throw new CoreError('invalid_request', 'dailyTime must be HH:MM in 24-hour time');
  }
  return createScheduledTask(db, {
    title: `Scout: ${input.name}`.slice(0, 200),
    instruction: scoutWatchInstruction(input.watchId),
    dailyTime,
    timezone: input.timezone,
    routine: SCOUT_ROUTINE,
    now: input.now,
  });
}

/** Removes a watch's schedule. Returns true when a schedule was removed. */
export function unscheduleScoutWatch(db: CoreDatabase, watchId: string): boolean {
  const existing = findScoutSchedule(db, watchId);
  if (!existing) return false;
  setScheduledTaskEnabled(db, existing.id, false, new Date());
  return true;
}

/** Switches a watch's schedule on or off without losing it. */
export function setScoutWatchScheduled(
  db: CoreDatabase,
  watchId: string,
  enabled: boolean,
  now: Date = new Date(),
): boolean {
  const existing = findScoutSchedule(db, watchId);
  if (!existing) return false;
  setScheduledTaskEnabled(db, existing.id, enabled, now);
  return true;
}

/** Reads a scheduled task by id, or throws when it is gone. */
export function requireScheduledTask(db: CoreDatabase, id: string): ScheduledTaskRecord {
  return getScheduledTask(db, id);
}
