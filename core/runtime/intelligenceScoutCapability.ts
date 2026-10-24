import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { createIntelligenceScout, type IntelligenceScout } from './intelligenceScout';
import type { CoreDatabase } from '../db/connection';
import {
  findScoutSchedule,
  scheduleScoutWatch,
  setScoutWatchScheduled,
  unscheduleScoutWatch,
} from '../domain/scoutRoutine';

export interface IntelligenceScoutCapabilityOptions {
  scout?: IntelligenceScout;
  dataDir?: string;
  /** Core's database — the durable schedule that makes a watch fire on its own. */
  db?: CoreDatabase;
  /** The wall-clock time a watch is checked by default (HH:MM, 24-hour). */
  dailyTime?: string;
  timezone?: string;
}

const READ_ONLY_TOOLS = new Set([
  'scout_list_watches',
  'scout_run_watch',
  'scout_run_all',
  'scout_research_repo',
]);

export function createIntelligenceScoutCapabilityAdapter(options: IntelligenceScoutCapabilityOptions = {}): GovernedCapabilityAdapter {
  const scout = options.scout ?? createIntelligenceScout({ dataDir: options.dataDir ?? process.cwd() });

  function failure(output: string, category: string): ToolExecutionResult {
    return { status: 'failed', exitCode: null, output, resultCategory: category };
  }

  function nonEmptyString(value: unknown, maxChars = 200): string | null {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    return trimmed && trimmed.length <= maxChars ? trimmed : null;
  }

  async function listWatches(): Promise<ToolExecutionResult> {
    const rows = scout.listWatches();
    if (rows.length === 0) return { status: 'succeeded', exitCode: 0, output: '(no watches)', resultCategory: 'scout_watches_listed' };
    const lines = rows.map((w) => `${w.id} — ${w.name} [${w.kind}] target=${w.target} paused=${w.paused} last=${w.lastSeenVersion ?? 'none'} report=${w.lastReport ?? 'n/a'}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'scout_watches_listed' };
  }

  async function addWatch(call: ModelToolCall): Promise<ToolExecutionResult> {
    const kind = call.arguments.kind === 'url' ? 'url' : 'github_repo';
    const target = nonEmptyString(call.arguments.target);
    if (!target) return failure('target is required', 'invalid_arguments');
    const name = typeof call.arguments.name === 'string' ? call.arguments.name : undefined;
    const w = scout.addWatch({ name, kind, target });
    let schedule = 'not scheduled (Core has no database in this build)';
    if (options.db) {
      const dailyTime = typeof call.arguments.dailyTime === 'string' ? call.arguments.dailyTime : options.dailyTime;
      const task = scheduleScoutWatch(options.db, {
        watchId: w.id,
        name: w.name,
        ...(dailyTime ? { dailyTime } : {}),
        ...(options.timezone ? { timezone: options.timezone } : {}),
      });
      schedule = `scheduled daily at ${task.dailyTime} (${task.timezone}), next run ${task.nextRunAt}`;
    }
    return {
      status: 'succeeded',
      exitCode: 0,
      output: `Added watch ${w.id}: ${w.name} — ${schedule}.`,
      resultCategory: 'scout_watch_added',
      normalizedArguments: { id: w.id, kind, target },
    };
  }

  async function removeWatch(call: ModelToolCall): Promise<ToolExecutionResult> {
    const id = nonEmptyString(call.arguments.id ?? call.arguments.watchId);
    if (!id) return failure('id is required', 'invalid_arguments');
    const ok = scout.removeWatch(id);
    if (!ok) return failure(`watch '${id}' not found`, 'scout_watch_not_found');
    if (options.db) unscheduleScoutWatch(options.db, id);
    return { status: 'succeeded', exitCode: 0, output: `Removed watch ${id} and its schedule`, resultCategory: 'scout_watch_removed', normalizedArguments: { id } };
  }

  async function pauseWatch(call: ModelToolCall): Promise<ToolExecutionResult> {
    const id = nonEmptyString(call.arguments.id ?? call.arguments.watchId);
    if (!id) return failure('id is required', 'invalid_arguments');
    const paused = call.arguments.paused !== false;
    const ok = scout.pauseWatch(id, paused);
    if (!ok) return failure(`watch '${id}' not found`, 'scout_watch_not_found');
    if (options.db) setScoutWatchScheduled(options.db, id, !paused);
    const schedule = options.db ? findScoutSchedule(options.db, id) : null;
    return {
      status: 'succeeded',
      exitCode: 0,
      output: `${paused ? 'Paused' : 'Resumed'} watch ${id}${schedule ? '' : ' (no schedule in this build)'}`,
      resultCategory: 'scout_watch_toggled',
      normalizedArguments: { id, paused },
    };
  }

  async function runWatch(call: ModelToolCall): Promise<ToolExecutionResult> {
    const id = nonEmptyString(call.arguments.id ?? call.arguments.watchId);
    if (!id) return failure('id is required', 'invalid_arguments');
    const r = await scout.runWatch(id);
    return {
      status: r.changed ? 'succeeded' : 'succeeded',
      exitCode: 0,
      output: r.message + (r.finding ? `\nSource: ${r.finding.url}\n${r.finding.summary}` : ''),
      resultCategory: r.changed ? 'scout_change_detected' : 'scout_no_change',
      normalizedArguments: { id },
    };
  }

  async function runAll(): Promise<ToolExecutionResult> {
    const r = await scout.runAll();
    const lines = r.results.map((x) => `${x.id}: ${x.changed ? 'CHANGED' : 'no change'} — ${x.message}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n') || '(no watches)', resultCategory: 'scout_run_all' };
  }

  async function researchRepo(call: ModelToolCall): Promise<ToolExecutionResult> {
    const repo = nonEmptyString(call.arguments.repo ?? call.arguments.repository ?? call.arguments.target);
    if (!repo) return failure('repo is required', 'invalid_arguments');
    const r = await scout.researchGithubRepo(repo);
    return {
      status: r.finding ? 'succeeded' : 'failed',
      exitCode: r.finding ? 0 : 1,
      output: r.message + (r.finding ? `\nURL: ${r.finding.url}` : ''),
      resultCategory: r.finding ? 'scout_research_done' : 'scout_research_failed',
      normalizedArguments: { repo },
    };
  }

  return {
    id: 'intelligence-scout',
    definitions: () => [
      { name: 'scout_list_watches', description: 'List durable technology watches (GitHub repos, URLs) with last-seen versions and reports. Read-only.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'scout_add_watch', description: 'Add a durable watch for a GitHub repository or URL and schedule it to run on its own (daily by default). The user must request monitoring; never auto-enable.', parameters: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string', enum: ['github_repo', 'url'] }, target: { type: 'string' }, dailyTime: { type: 'string', description: 'When to check it, HH:MM 24-hour (default 09:00).' } }, required: ['kind', 'target'] } },
      { name: 'scout_remove_watch', description: 'Remove a watch by id.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'scout_pause_watch', description: 'Pause or resume a watch.', parameters: { type: 'object', properties: { id: { type: 'string' }, paused: { type: 'boolean' } }, required: ['id'] } },
      { name: 'scout_run_watch', description: 'Run one watch now: fetch primary source, detect meaningful changes, deduplicate. Read-only.', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
      { name: 'scout_run_all', description: 'Run all non-paused watches now.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'scout_research_repo', description: 'Research a GitHub repository: metadata, description, stars, license. Source-backed, no fabricated benchmarks.', parameters: { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'] } },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call) => {
      switch (call.name) {
        case 'scout_list_watches': return listWatches();
        case 'scout_add_watch': return addWatch(call);
        case 'scout_remove_watch': return removeWatch(call);
        case 'scout_pause_watch': return pauseWatch(call);
        case 'scout_run_watch': return runWatch(call);
        case 'scout_run_all': return runAll();
        case 'scout_research_repo': return researchRepo(call);
        default: return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
      }
    },
  };
}
