/**
 * The reliability watchdog as a durable schedule.
 *
 * The watchdog itself is `scripts/watchdog/run-watchdog.mjs` in a Pandesh source checkout: it runs the Core and desktop
 * suites and a few live scenarios against an isolated Core and a disposable workspace, then compares with its last
 * run. This module only owns the *schedule*: one `scheduled_tasks` row with `routine = 'reliability_watchdog'`, so the
 * watchdog inherits the scheduler's guarantees — it survives restarts, fires at most once per occurrence, catches up
 * after the PC was asleep or off (within the interval's catch-up window), and can be switched off.
 *
 * The schedule is created only when the operator asks for it.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';
import { createScheduledTask, listRoutineTasks, setScheduledTaskEnabled, updateScheduledTaskScope, type ScheduledTaskRecord } from './scheduledTasks';

export const WATCHDOG_ROUTINE = 'reliability_watchdog';
export const WATCHDOG_DEFAULTS = { dailyTime: '04:00', timezone: 'Europe/Berlin', everyDays: 2, model: 'gemma4:12b' } as const;

export interface WatchdogScope {
  /** The Pandesh source checkout the watchdog tests (it must contain scripts/watchdog/run-watchdog.mjs). */
  repoPath: string;
  /** Where runs, reports and the comparison baseline are kept. */
  stateDir: string;
  model: string;
}

export function watchdogSchedule(db: CoreDatabase): ScheduledTaskRecord | null {
  return listRoutineTasks(db, WATCHDOG_ROUTINE)[0] ?? null;
}

export function readWatchdogScope(task: ScheduledTaskRecord): WatchdogScope | null {
  const s = task.scope ?? {};
  if (typeof s.repoPath !== 'string' || typeof s.stateDir !== 'string') return null;
  return { repoPath: s.repoPath, stateDir: s.stateDir, model: typeof s.model === 'string' && s.model ? s.model : WATCHDOG_DEFAULTS.model };
}

/** Creates the schedule, or updates the existing one's scope; never creates a second row. */
export function scheduleWatchdog(db: CoreDatabase, input: {
  repoPath: string; stateDir: string; model?: string; dailyTime?: string; timezone?: string; everyDays?: number; now?: Date;
}): ScheduledTaskRecord {
  const repoPath = String(input.repoPath ?? '').trim();
  const stateDir = String(input.stateDir ?? '').trim();
  if (!repoPath || !stateDir) throw new CoreError('invalid_request', 'repoPath and stateDir are required');
  const scope: Record<string, unknown> = { repoPath, stateDir, model: input.model?.trim() || WATCHDOG_DEFAULTS.model };
  const existing = watchdogSchedule(db);
  if (existing) {
    const updated = updateScheduledTaskScope(db, existing.id, { scope });
    return existing.enabled ? updated : setScheduledTaskEnabled(db, existing.id, true);
  }
  const now = input.now ?? new Date();
  const anchor = new Intl.DateTimeFormat('en-CA', { timeZone: input.timezone ?? WATCHDOG_DEFAULTS.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return createScheduledTask(db, {
    title: 'Reliability watchdog',
    instruction: 'Run the Pandesh regression watchdog against an isolated profile and report only what changed.',
    dailyTime: input.dailyTime ?? WATCHDOG_DEFAULTS.dailyTime,
    timezone: input.timezone ?? WATCHDOG_DEFAULTS.timezone,
    recurrence: { kind: 'interval_days', every: input.everyDays ?? WATCHDOG_DEFAULTS.everyDays, anchor },
    routine: WATCHDOG_ROUTINE,
    purpose: 'Regression watchdog: isolated profile, disposable workspace, never touches the user’s data or the installed app.',
    scope,
    now,
  });
}

/** Makes the scheduler fire the watchdog on its next tick (a real scheduler-triggered run, used to verify it). */
export function runWatchdogSoon(db: CoreDatabase): ScheduledTaskRecord {
  const task = watchdogSchedule(db);
  if (!task) throw new CoreError('not_found', 'no watchdog schedule; create one first');
  db.run('UPDATE scheduled_tasks SET nextRunAt = ?, enabled = 1, updatedAt = ? WHERE id = ?', [nowIso(), nowIso(), task.id]);
  return watchdogSchedule(db)!;
}
