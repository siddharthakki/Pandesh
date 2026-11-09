import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { claimDueScheduledTasks, nextOccurrence } from '../domain/scheduledTasks';
import { runWatchdogSoon, scheduleWatchdog, watchdogSchedule, WATCHDOG_ROUTINE } from '../domain/watchdogRoutine';
import { runReliabilityWatchdogRoutine, watchdogNews, type WatchdogSummary } from '../runtime/watchdogRoutine';
// @ts-expect-error — plain ESM module without type declarations
import { compare, renderReport } from '../../scripts/watchdog/report.mjs';

let dir: string;
let db: CoreDatabase;
const broadcaster = new EventBroadcaster();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => { db.close?.(); fs.rmSync(dir, { recursive: true, force: true }); });

describe('watchdog schedule', () => {
  it('runs every two days at 04:00 Europe/Berlin and is created only once', () => {
    const now = new Date('2026-11-09T12:00:00Z');
    const task = scheduleWatchdog(db, { repoPath: 'D:/repo', stateDir: 'D:/state', now });
    expect(task.routine).toBe(WATCHDOG_ROUTINE);
    expect(task.dailyTime).toBe('04:00');
    expect(task.timezone).toBe('Europe/Berlin');
    expect(task.nextRunAt).toBe('2026-11-11T03:00:00.000Z'); // 04:00 CET, two days after the anchor day
    expect(new Date(nextOccurrence(task, new Date(task.nextRunAt))).toISOString()).toBe('2026-11-13T03:00:00.000Z');
    scheduleWatchdog(db, { repoPath: 'D:/repo2', stateDir: 'D:/state', now });
    expect(db.all('SELECT id FROM scheduled_tasks WHERE routine = ?', [WATCHDOG_ROUTINE])).toHaveLength(1);
    expect(watchdogSchedule(db)!.scope).toMatchObject({ repoPath: 'D:/repo2' });
  });

  it('a run missed while the PC was off still fires within the catch-up window', () => {
    scheduleWatchdog(db, { repoPath: 'D:/repo', stateDir: 'D:/state', now: new Date('2026-11-09T12:00:00Z') });
    const claimed = claimDueScheduledTasks(db, new Date('2026-11-11T10:00:00Z'), () => undefined); // 7 h late
    expect(claimed.map((c) => c.task.routine)).toEqual([WATCHDOG_ROUTINE]);
    expect(claimed[0].late).toBe(true);
  });

  it('run-soon makes the scheduler itself pick it up on the next tick', () => {
    scheduleWatchdog(db, { repoPath: 'D:/repo', stateDir: 'D:/state' });
    runWatchdogSoon(db);
    expect(claimDueScheduledTasks(db, new Date(Date.now() + 1000), () => undefined)).toHaveLength(1);
  });
});

describe('watchdog routine delivers only news', () => {
  const summary = (s: Partial<WatchdogSummary>): WatchdogSummary => ({ status: 'completed', runId: 'r1', commit: 'abc', regressions: [], fixed: [], environment: [], knownCount: 0, summary: 'report', ...s });

  it('an unchanged run is silent and gives the occurrence back', async () => {
    const task = scheduleWatchdog(db, { repoPath: dir, stateDir: dir });
    const result = await runReliabilityWatchdogRoutine(db, broadcaster, { task, runner: async () => summary({ knownCount: 2 }) });
    expect(result.delivered).toBe(false);
    expect(db.all('SELECT * FROM notification_outbox')).toHaveLength(0);
    expect(db.all('SELECT * FROM routine_deliveries')).toHaveLength(0);
  });

  it('a regression becomes one message and one notification, exactly once per occurrence', async () => {
    const task = scheduleWatchdog(db, { repoPath: dir, stateDir: dir });
    const runner = async () => summary({ regressions: ['live:delegation-read'] });
    const first = await runReliabilityWatchdogRoutine(db, broadcaster, { task, runner });
    const again = await runReliabilityWatchdogRoutine(db, broadcaster, { task, runner });
    expect(first).toMatchObject({ delivered: true, reason: 'Watchdog: 1 new regression' });
    expect(again.delivered).toBe(false);
    expect(db.all<{ title: string }>('SELECT title FROM notification_outbox').map((n) => n.title)).toEqual(['Watchdog: 1 new regression']);
  });

  it('environment failures, deferrals and crashes are reported apart from regressions', () => {
    expect(watchdogNews(summary({ environment: ['live:x'] })).headline).toMatch(/environment failure/);
    expect(watchdogNews(summary({ deferred: 'GPU busy' })).headline).toMatch(/deferred/);
    expect(watchdogNews({ status: 'crashed', error: 'boom' }).news).toBe(true);
    expect(watchdogNews({ status: 'skipped_overlap' }).news).toBe(false);
  });
});

describe('watchdog comparison', () => {
  const run = (tests: Record<string, string>) => ({ suites: { core: { tests: Object.fromEntries(Object.entries(tests).map(([k, status]) => [k, { status, ms: 10 }])) } } });

  it('separates new failures, fixes and known failures', () => {
    const diff = compare(run({ a: 'passed', b: 'failed', c: 'failed' }), run({ a: 'failed', b: 'failed', c: 'passed' }));
    expect(diff).toMatchObject({ baseline: false, fixed: ['suite:a'], known: ['suite:b'], regressions: ['suite:c'] });
  });

  it('does not count an environment failure as a regression', () => {
    const current = { suites: { core: { tests: { t: { status: 'failed', ms: 1, environment: true } } } } };
    const diff = compare(current, run({ t: 'passed' }));
    expect(diff.regressions).toEqual([]);
    expect(diff.environment).toEqual(['suite:t']);
    expect(renderReport({ runId: 'r', commit: 'c', ms: 60_000, suites: {}, live: null }, diff, 'm')).toContain('Environment failures');
  });
});
