/**
 * Runs one occurrence of the reliability watchdog (see core/domain/watchdogRoutine.ts for the schedule).
 *
 * Core does not test itself in-process: it starts `scripts/watchdog/run-watchdog.mjs` from the configured source
 * checkout as a child process and reads the summary it prints. The occurrence is claimed first (exactly-once); a run
 * that changed nothing delivers nothing and gives the claim back, so the user is not told the same thing every two days.
 * News — the first baseline, a regression, a fix, an environment failure, a deferred or crashed run — becomes one
 * message in the "Reliability watchdog" conversation and one desktop notification.
 *
 * The watchdog never merges, deploys or changes the installed app; it only reports.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation } from '../domain/conversations';
import { claimRoutineDelivery, completeRoutineDelivery, releaseRoutineDelivery } from '../domain/assistantRoutine';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { nowIso } from '../domain/ids';
import type { ScheduledTaskRecord } from '../domain/scheduledTasks';
import { readWatchdogScope } from '../domain/watchdogRoutine';
import { enqueueNotification } from '../domain/notificationOutbox';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { terminateProcessTree } from './processTree';

const ACTOR = 'kkd:watchdog_routine';
/** A whole run (suites + live scenarios + waiting for an idle GPU) must end within this. */
export const WATCHDOG_RUN_LIMIT_MS = 5 * 3_600_000;

export interface WatchdogSummary {
  status: 'completed' | 'skipped_overlap' | 'crashed';
  runId?: string;
  commit?: string;
  reportPath?: string;
  complete?: boolean;
  baseline?: boolean;
  regressions?: string[];
  fixed?: string[];
  knownCount?: number;
  environment?: string[];
  deferred?: string | null;
  liveError?: string | null;
  summary?: string;
  error?: string;
}

export type WatchdogRunner = (input: { repoPath: string; stateDir: string; model: string }) => Promise<WatchdogSummary>;

/** Starts the runner script and returns the summary line it prints with --json. */
export const spawnWatchdogRunner: WatchdogRunner = ({ repoPath, stateDir, model }) => new Promise((resolve) => {
  const script = path.join(repoPath, 'scripts', 'watchdog', 'run-watchdog.mjs');
  if (!fs.existsSync(script)) { resolve({ status: 'crashed', error: `no watchdog script at ${script}` }); return; }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(process.execPath, [script, '--state-dir', stateDir, '--model', model, '--json'], { cwd: repoPath, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let last: WatchdogSummary | null = null;
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.startsWith('{"watchdog":"summary"')) continue;
      try { last = JSON.parse(line) as WatchdogSummary; } catch { /* partial line */ }
    }
  });
  // Past the limit the whole tree goes (the runner starts vitest and an isolated Core), verified by processTree.
  const timer = setTimeout(() => { if (child.pid) void terminateProcessTree(child.pid).catch(() => undefined); }, WATCHDOG_RUN_LIMIT_MS);
  child.on('close', (code) => {
    clearTimeout(timer);
    if (buffer.startsWith('{"watchdog":"summary"')) { try { last = JSON.parse(buffer) as WatchdogSummary; } catch { /* ignore */ } }
    resolve(last ?? { status: 'crashed', error: `watchdog exited with code ${code} without a summary` });
  });
  child.on('error', (err) => { clearTimeout(timer); resolve({ status: 'crashed', error: err.message }); });
});

/** Whether a run is worth telling the user about. Unchanged known failures are not news. */
export function watchdogNews(s: WatchdogSummary): { news: boolean; headline: string } {
  if (s.status === 'skipped_overlap') return { news: false, headline: 'skipped: a previous run is still active' };
  if (s.status === 'crashed') return { news: true, headline: `Watchdog could not run: ${s.error ?? 'unknown error'}` };
  const reg = s.regressions?.length ?? 0;
  const fixed = s.fixed?.length ?? 0;
  const env = s.environment?.length ?? 0;
  if (s.baseline) return { news: true, headline: `Watchdog baseline recorded (${s.commit ?? 'unknown commit'})` };
  if (reg) return { news: true, headline: `Watchdog: ${reg} new regression${reg === 1 ? '' : 's'}` };
  if (s.liveError) return { news: true, headline: `Watchdog: live scenarios could not run (${s.liveError})` };
  if (env) return { news: true, headline: `Watchdog: ${env} environment failure${env === 1 ? '' : 's'}, no product regressions` };
  if (fixed) return { news: true, headline: `Watchdog: ${fixed} fixed, no new regressions` };
  if (s.deferred) return { news: true, headline: 'Watchdog: live scenarios deferred (GPU busy)' };
  return { news: false, headline: `no change since the last run${s.knownCount ? ` (${s.knownCount} known failure(s) unchanged)` : ''}` };
}

export async function runReliabilityWatchdogRoutine(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  input: { task: ScheduledTaskRecord; runner?: WatchdogRunner },
): Promise<{ delivered: boolean; reason: string; summary: WatchdogSummary | null }> {
  const task = input.task;
  const occurrenceKey = `${task.id}@${task.nextRunAt}`;
  const scope = readWatchdogScope(task);
  if (!scope) return { delivered: false, reason: 'the watchdog schedule has no repoPath/stateDir', summary: null };
  if (!claimRoutineDelivery(db, task.id, occurrenceKey)) return { delivered: false, reason: 'this occurrence was already handled', summary: null };
  const publish = (eventType: string, metadata: Record<string, unknown>) => {
    const event = recordRuntimeEvent(db, { domain: 'watchdog_routine', entityId: task.id, eventType, actor: ACTOR, clientId: SCHEDULER_CLIENT_ID, idempotencyKey: `watchdog:${eventType}:${occurrenceKey}`, metadata: { occurrenceKey, ...metadata } });
    broadcaster.publishRuntime(event);
  };
  publish('watchdog_started', { repoPath: scope.repoPath, model: scope.model });
  let summary: WatchdogSummary;
  try {
    summary = await (input.runner ?? spawnWatchdogRunner)(scope);
  } catch (err) {
    summary = { status: 'crashed', error: err instanceof Error ? err.message : String(err) };
  }
  const { news, headline } = watchdogNews(summary);
  db.run('UPDATE scheduled_tasks SET lastRunAt = ?, updatedAt = ? WHERE id = ?', [nowIso(), nowIso(), task.id]);
  if (!news) {
    releaseRoutineDelivery(db, task.id, occurrenceKey);
    publish('watchdog_unchanged', { headline, runId: summary.runId ?? null, reportPath: summary.reportPath ?? null });
    return { delivered: false, reason: headline, summary };
  }
  const body = [
    `**${headline}**`, '',
    summary.summary ?? summary.error ?? '',
    ...(summary.reportPath ? ['', `Full report: \`${summary.reportPath}\``] : []),
    '', '_The watchdog only reports. It never merges, deploys or changes the installed app._',
  ].join('\n');
  const conversationId = task.conversationId ?? createConversation(db, { mode: 'saath_kar', title: 'Reliability watchdog', actor: ACTOR }).id;
  const message = appendMessage(db, conversationId, { role: 'assistant', content: body, actor: ACTOR, clientId: SCHEDULER_CLIENT_ID });
  completeRoutineDelivery(db, task.id, occurrenceKey, { conversationId, messageId: message.id });
  db.run('UPDATE scheduled_tasks SET conversationId = ? WHERE id = ?', [conversationId, task.id]);
  enqueueNotification(db, { kind: 'routine_report', sourceId: `watchdog:${occurrenceKey}`, title: headline.slice(0, 120), body: 'Open the "Reliability watchdog" chat in Pandesh for the details.' });
  publish('watchdog_reported', { headline, conversationId, messageId: message.id, runId: summary.runId ?? null, reportPath: summary.reportPath ?? null });
  return { delivered: true, reason: headline, summary };
}
