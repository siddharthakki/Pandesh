/**
 * Household routines: durable, recurring jobs Pandesh runs on its own — and the exact authority each one has.
 *
 * A routine is a `scheduled_tasks` row (so it inherits the scheduler's restart-safety and at-most-once firing) whose
 * `scopeJson` is the bounded authorization the person approved when it was created: which sources it may read, which
 * operations it may perform, which folders, and how much per run. A routine never gains authority by running
 * unattended: anything outside its scope — or anything consequential its scope does not name — is recorded as a
 * proposal for the person, never executed. `routine_runs` is the truthful history: every run, failure and missed run.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import {
  cancelScheduledTask, createScheduledTask, getScheduledTask, listScheduledTasks, rescheduleDailyTask, setScheduledTaskEnabled, updateScheduledTaskScope,
  type Recurrence, type ScheduledTaskRecord,
} from './scheduledTasks';

export type HouseholdRoutineKind = 'folder_cleanup' | 'obligations_check' | 'expiry_watch';
export const HOUSEHOLD_ROUTINES: ReadonlySet<string> = new Set<HouseholdRoutineKind>(['folder_cleanup', 'obligations_check', 'expiry_watch']);

/** Everything a routine may do. Operations not listed here do not exist for an unattended run. */
export const ROUTINE_OPERATIONS = {
  folder_cleanup: ['scan_metadata', 'classify', 'apply_approved_rules', 'flag_duplicates', 'flag_temporary', 'archive_duplicates', 'report'],
  obligations_check: ['read_gmail', 'read_folders', 'extract', 'propose_obligations', 'update_confirmed', 'briefing', 'notify_phone'],
  expiry_watch: ['read_folders', 'read_contents', 'extract', 'propose_obligations', 'briefing', 'notify_phone'],
} as const satisfies Record<HouseholdRoutineKind, readonly string[]>;

export interface RoutineScope {
  /** Folders the routine may read (and, for folder_cleanup with apply_approved_rules, move inside). */
  folders: string[];
  /** Connected accounts the routine may read. */
  sources: Array<'gmail'>;
  operations: string[];
  /** Upper bound on files moved in one run. */
  maxMovesPerRun?: number;
  /** How far back a mail check looks on each run (days). */
  lookbackDays?: number;
  /** Whether document text may be read locally. */
  inspectContents?: boolean;
}

const DEFAULTS: Record<HouseholdRoutineKind, { title: string; purpose: string; dailyTime: string; recurrence: Recurrence | null; scope: RoutineScope }> = {
  folder_cleanup: {
    title: 'Weekly Downloads cleanup', purpose: 'Keep the folder organized using the destinations you already approved; propose anything new.',
    dailyTime: '10:00', recurrence: { kind: 'weekly', weekdays: [0] },
    scope: { folders: ['Downloads'], sources: [], operations: ['scan_metadata', 'classify', 'apply_approved_rules', 'flag_duplicates', 'flag_temporary', 'report'], maxMovesPerRun: 100 },
  },
  obligations_check: {
    title: 'Morning bills and subscriptions check', purpose: 'Find new bills, renewals, payment confirmations and notices; brief what changed since the last run.',
    dailyTime: '07:30', recurrence: null,
    scope: { folders: [], sources: ['gmail'], operations: ['read_gmail', 'extract', 'propose_obligations', 'update_confirmed', 'briefing', 'notify_phone'], lookbackDays: 3 },
  },
  expiry_watch: {
    title: 'Document expiry watch', purpose: 'Watch documents for expiry, contract-end and warranty dates and propose reminders.',
    dailyTime: '08:00', recurrence: { kind: 'weekly', weekdays: [1] },
    scope: { folders: ['Documents'], sources: [], operations: ['read_folders', 'read_contents', 'extract', 'propose_obligations', 'briefing'], inspectContents: true },
  },
};

export function defaultRoutineScope(kind: HouseholdRoutineKind): RoutineScope {
  return structuredClone(DEFAULTS[kind].scope);
}

/** Rejects any operation the routine kind does not have, and bounds the numbers. */
export function validateRoutineScope(kind: HouseholdRoutineKind, raw: Partial<RoutineScope> | undefined): RoutineScope {
  const base = defaultRoutineScope(kind);
  const scope: RoutineScope = {
    folders: (raw?.folders ?? base.folders).map((f) => String(f).trim()).filter(Boolean).slice(0, 10),
    sources: (raw?.sources ?? base.sources).filter((s): s is 'gmail' => s === 'gmail'),
    operations: [...new Set((raw?.operations ?? base.operations).map(String))],
    ...(kind === 'folder_cleanup' ? { maxMovesPerRun: Math.min(500, Math.max(1, Math.trunc(Number(raw?.maxMovesPerRun ?? base.maxMovesPerRun ?? 100)))) } : {}),
    ...(kind === 'obligations_check' ? { lookbackDays: Math.min(60, Math.max(1, Math.trunc(Number(raw?.lookbackDays ?? base.lookbackDays ?? 3)))) } : {}),
    ...(raw?.inspectContents ?? base.inspectContents ? { inspectContents: true } : {}),
  };
  const allowed = new Set<string>(ROUTINE_OPERATIONS[kind]);
  const unknown = scope.operations.filter((o) => !allowed.has(o));
  if (unknown.length) throw new CoreError('invalid_request', `a ${kind} routine cannot ${unknown.join(', ')}; allowed: ${[...allowed].join(', ')}`);
  if (kind !== 'obligations_check' && scope.sources.length) throw new CoreError('invalid_request', `a ${kind} routine reads folders only`);
  if ((kind === 'folder_cleanup' || kind === 'expiry_watch') && scope.folders.length === 0) throw new CoreError('invalid_request', 'name at least one folder');
  if (scope.operations.includes('read_gmail') && !scope.sources.includes('gmail')) scope.sources.push('gmail');
  if (scope.operations.includes('read_contents') && !scope.inspectContents) scope.inspectContents = true;
  return scope;
}

export interface RoutineRun {
  id: string;
  taskId: string;
  routine: string;
  occurrenceKey: string;
  trigger: 'schedule' | 'catch_up' | 'manual' | 'missed';
  status: 'running' | 'succeeded' | 'failed' | 'missed' | 'skipped';
  startedAt: string;
  finishedAt: string | null;
  summary: string | null;
  detail: Record<string, unknown> | null;
  error: string | null;
}

function mapRun(r: Record<string, unknown>): RoutineRun {
  return {
    id: String(r.id), taskId: String(r.taskId), routine: String(r.routine), occurrenceKey: String(r.occurrenceKey), trigger: r.trigger as RoutineRun['trigger'],
    status: r.status as RoutineRun['status'], startedAt: String(r.startedAt), finishedAt: (r.finishedAt as string) ?? null, summary: (r.summary as string) ?? null,
    detail: r.detailJson ? JSON.parse(String(r.detailJson)) : null, error: (r.error as string) ?? null,
  };
}

/** Claims one occurrence. Null when it was already run (or recorded as missed) — the duplicate guard. */
export function startRoutineRun(db: CoreDatabase, input: { taskId: string; routine: string; occurrenceKey: string; trigger: RoutineRun['trigger'] }): RoutineRun | null {
  const id = newId('rrun');
  try {
    db.run(`INSERT INTO routine_runs (id, taskId, routine, occurrenceKey, trigger, status, startedAt) VALUES (?, ?, ?, ?, ?, 'running', ?)`,
      [id, input.taskId, input.routine, input.occurrenceKey, input.trigger, nowIso()]);
  } catch {
    return null;
  }
  return mapRun(db.get<Record<string, unknown>>('SELECT * FROM routine_runs WHERE id = ?', [id])!);
}

export function finishRoutineRun(db: CoreDatabase, id: string, input: { status: 'succeeded' | 'failed' | 'skipped'; summary: string; detail?: Record<string, unknown>; error?: string | null }): RoutineRun {
  db.run('UPDATE routine_runs SET status = ?, finishedAt = ?, summary = ?, detailJson = ?, error = ? WHERE id = ?',
    [input.status, nowIso(), input.summary.slice(0, 2000), input.detail ? JSON.stringify(input.detail).slice(0, 60_000) : null, input.error?.slice(0, 1000) ?? null, id]);
  return mapRun(db.get<Record<string, unknown>>('SELECT * FROM routine_runs WHERE id = ?', [id])!);
}

/** A run that could not happen (Pandesh was off past the catch-up window) is recorded as missed, not silently skipped. */
export function recordMissedRun(db: CoreDatabase, task: ScheduledTaskRecord, dueAt: string): void {
  if (!task.routine || !HOUSEHOLD_ROUTINES.has(task.routine)) return;
  try {
    db.run(`INSERT INTO routine_runs (id, taskId, routine, occurrenceKey, trigger, status, startedAt, finishedAt, summary) VALUES (?, ?, ?, ?, 'missed', 'missed', ?, ?, ?)`,
      [newId('rrun'), task.id, task.routine, `${task.id}@${dueAt}`, dueAt, nowIso(), `Missed: Pandesh was not running at ${dueAt}; the next run is scheduled normally.`]);
  } catch { /* already recorded */ }
}

/** Runs left `running` by a Core that died mid-run: they did not finish, and the history says so. */
export function settleInterruptedRuns(db: CoreDatabase): number {
  const r = db.run(`UPDATE routine_runs SET status = 'failed', finishedAt = ?, error = 'interrupted: Core stopped while this run was in progress' WHERE status = 'running'`, [nowIso()]);
  return Number(r.changes);
}

export function listRoutineRuns(db: CoreDatabase, taskId: string, limit = 10): RoutineRun[] {
  return db.all<Record<string, unknown>>('SELECT * FROM routine_runs WHERE taskId = ? ORDER BY startedAt DESC LIMIT ?', [taskId, limit]).map(mapRun);
}

export function lastSuccessfulRun(db: CoreDatabase, taskId: string): RoutineRun | null {
  const row = db.get<Record<string, unknown>>("SELECT * FROM routine_runs WHERE taskId = ? AND status = 'succeeded' ORDER BY startedAt DESC LIMIT 1", [taskId]);
  return row ? mapRun(row) : null;
}

export function createHouseholdRoutine(db: CoreDatabase, input: {
  kind: HouseholdRoutineKind; title?: string; purpose?: string; dailyTime?: string; timezone?: string; recurrence?: Recurrence | null; scope?: Partial<RoutineScope>; now?: Date;
}): ScheduledTaskRecord {
  if (!HOUSEHOLD_ROUTINES.has(input.kind)) throw new CoreError('invalid_request', `unknown routine kind ${input.kind}`);
  const d = DEFAULTS[input.kind];
  const scope = validateRoutineScope(input.kind, input.scope);
  return createScheduledTask(db, {
    title: input.title?.trim() || d.title,
    instruction: `${input.purpose?.trim() || d.purpose} Bounded scope: ${JSON.stringify(scope)}. Core runs this routine itself; it never sends, pays, deletes or moves outside its approved rules.`,
    dailyTime: input.dailyTime ?? d.dailyTime,
    timezone: input.timezone,
    recurrence: input.recurrence === undefined ? d.recurrence : input.recurrence,
    routine: input.kind,
    purpose: input.purpose?.trim() || d.purpose,
    scope: scope as unknown as Record<string, unknown>,
    now: input.now,
  });
}

export type RoutineControl = 'pause' | 'resume' | 'cancel';

function isCancelled(db: CoreDatabase, id: string): boolean {
  return Boolean(db.get<{ cancelledAt: string | null }>('SELECT cancelledAt FROM scheduled_tasks WHERE id = ?', [id])?.cancelledAt);
}

export function controlHouseholdRoutine(db: CoreDatabase, id: string, action: RoutineControl, now = new Date()): ScheduledTaskRecord {
  const task = getScheduledTask(db, id);
  if (action === 'cancel') {
    db.run('UPDATE scheduled_tasks SET cancelledAt = COALESCE(cancelledAt, ?) WHERE id = ?', [nowIso(), id]);
    return cancelScheduledTask(db, id);
  }
  if (isCancelled(db, id)) throw new CoreError('invalid_transition', 'a cancelled routine cannot be resumed; create a new one');
  if (task.repeat === 'once' && action === 'resume') throw new CoreError('invalid_transition', 'a one-time task cannot be resumed');
  return setScheduledTaskEnabled(db, id, action === 'resume', now);
}

/** Edits a routine. A scope change is re-validated against the routine kind; the caller holds the person's approval. */
export function editHouseholdRoutine(db: CoreDatabase, id: string, input: { dailyTime?: string; timezone?: string; recurrence?: Recurrence | null; scope?: Partial<RoutineScope>; title?: string; purpose?: string; now?: Date }): ScheduledTaskRecord {
  const task = getScheduledTask(db, id);
  if (!task.routine || !HOUSEHOLD_ROUTINES.has(task.routine)) throw new CoreError('invalid_request', 'only household routines are edited here');
  if (input.dailyTime || input.timezone || input.recurrence !== undefined) {
    rescheduleDailyTask(db, id, { dailyTime: input.dailyTime ?? task.dailyTime, timezone: input.timezone, recurrence: input.recurrence, now: input.now });
  }
  if (input.scope || input.title || input.purpose) {
    const scope = input.scope ? validateRoutineScope(task.routine as HouseholdRoutineKind, { ...(task.scope as Partial<RoutineScope>), ...input.scope }) : task.scope ?? {};
    updateScheduledTaskScope(db, id, { scope: scope as Record<string, unknown>, title: input.title, purpose: input.purpose });
  }
  return getScheduledTask(db, id);
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function describeSchedule(task: Pick<ScheduledTaskRecord, 'dailyTime' | 'timezone' | 'recurrence' | 'repeat'>): string {
  if (task.repeat === 'once') return `once at ${task.dailyTime} (${task.timezone})`;
  const r = task.recurrence;
  if (!r) return `every day at ${task.dailyTime} (${task.timezone})`;
  if (r.kind === 'weekly') return `every ${r.weekdays.map((d) => WEEKDAYS[d]).join(', ')} at ${task.dailyTime} (${task.timezone})`;
  return `every ${r.every} days from ${r.anchor} at ${task.dailyTime} (${task.timezone})`;
}

export interface RoutineView {
  id: string; kind: string; title: string; purpose: string | null; schedule: string; timezone: string; enabled: boolean; state: 'active' | 'paused' | 'cancelled';
  scope: Record<string, unknown> | null; nextRunAt: string | null; lastRunAt: string | null; history: RoutineRun[];
}

export function listHouseholdRoutines(db: CoreDatabase, historyLimit = 5): RoutineView[] {
  return listScheduledTasks(db, true).filter((t) => t.routine && HOUSEHOLD_ROUTINES.has(t.routine)).map((t) => {
    const history = listRoutineRuns(db, t.id, historyLimit);
    const state = isCancelled(db, t.id) ? 'cancelled' : t.enabled ? 'active' : 'paused';
    return {
      id: t.id, kind: t.routine!, title: t.title, purpose: t.purpose, schedule: describeSchedule(t), timezone: t.timezone, enabled: state === 'active', state,
      scope: t.scope, nextRunAt: t.enabled ? t.nextRunAt : null, lastRunAt: history.find((h) => h.finishedAt)?.finishedAt ?? t.lastRunAt, history,
    };
  });
}

export function renderRoutine(v: RoutineView): string {
  const scope = v.scope as Partial<RoutineScope> | null;
  const lines = [
    `${v.title} (${v.kind}) id=${v.id} — ${v.state}`,
    `  purpose: ${v.purpose ?? '—'}`,
    `  schedule: ${v.schedule}; next ${v.nextRunAt ?? '—'}; last ${v.lastRunAt ?? 'never'}`,
    `  authority: reads ${[...(scope?.folders ?? []), ...(scope?.sources ?? [])].join(', ') || 'nothing'}; may ${(scope?.operations ?? []).join(', ')}${scope?.maxMovesPerRun ? `; at most ${scope.maxMovesPerRun} moves per run` : ''}`,
  ];
  for (const h of v.history.slice(0, 5)) lines.push(`  ${h.startedAt.slice(0, 16).replace('T', ' ')} ${h.trigger} → ${h.status}: ${h.summary ?? h.error ?? ''}`.slice(0, 300));
  return lines.join('\n');
}
