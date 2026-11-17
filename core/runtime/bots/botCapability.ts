/**
 * Bots from a conversation: "every morning check my email and tell me what's important", "Pandesh Engineer,
 * investigate yesterday's failed mission".
 *
 *  - `bot_list` and `bot_ask` are read-only: listing changes nothing, and asking a Bot only makes it read its own
 *    approved sources and report. A Bot never acts, so asking one needs no approval.
 *  - `bot_create`, `bot_schedule` and `bot_set_status` change standing behaviour, so they are consequential: Core's
 *    ordinary approval card shows the Bot, the schedule and exactly what it will read before anything is saved.
 *
 * A Bot that reads private data (mail) keeps its report in its own conversation on this PC. `bot_ask` then returns
 * only that it reported and how many items, so mail content never enters a chat that may be running on a cloud model.
 */
import type { CoreDatabase } from '../../db/connection';
import type { EventBroadcaster } from '../../ws/broadcaster';
import type { ConnectorId } from '../../shared/wireTypes';
import type { ConnectorAdapter } from '../connectors/connectorCapability';
import type { GovernedCapabilityAdapter } from '../governedCapability';
import type { ModelToolCall } from '../modelBackend';
import type { ToolExecutionResult } from '../toolRunner';
import { BOT_SOURCES, type BotSourceId } from './botStore';
import { BotService, STANDARD_BOTS, type BotView } from './botService';
import { runBot } from './botRunner';
import type { HermesBotRuntime } from './hermesBotRuntime';

const READ_ONLY = new Set(['bot_list', 'bot_ask']);

export interface BotCapabilityOptions { db: CoreDatabase; dataDir: string; connectorRegistry?: Map<ConnectorId, ConnectorAdapter>; broadcaster?: EventBroadcaster; hermes?: HermesBotRuntime }

const fail = (output: string, category: string): ToolExecutionResult => ({ status: 'failed', exitCode: 1, output, resultCategory: category });
const done = (output: string, category: string, normalizedArguments?: Record<string, unknown>): ToolExecutionResult => ({ status: 'succeeded', exitCode: 0, output, resultCategory: category, normalizedArguments });
const text = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** "07:30", "7:30", "7am", "19 Uhr" → "07:30" | null. */
export function parseDailyTime(value: unknown): string | null {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|uhr)?$/.exec(raw);
  if (!m) return null;
  let h = Number(m[1]); const min = Number(m[2] ?? '0');
  if (m[3] === 'pm' && h < 12) h += 12;
  if (m[3] === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function describeBot(b: BotView): string {
  const routines = b.routines.length
    ? b.routines.map((r) => `"${r.title}" ${r.enabled ? `at ${r.dailyTime}${r.recurrence?.kind === 'interval_days' ? ` every ${r.recurrence.every} days` : r.recurrence?.kind === 'weekly' ? ' on set weekdays' : ' daily'}, next ${r.nextRunAt}` : 'switched off'} [${r.id}]`).join('; ')
    : 'no routine';
  const last = b.lastRun ? `${b.lastRun.status} ${b.lastRun.finishedAt ?? b.lastRun.startedAt}: ${b.lastRun.reason}` : 'never run';
  return `- ${b.name} [${b.id}] ${b.status}${b.running ? ', running now' : ''}${b.profileOk ? '' : ` (PROBLEM: ${b.profileProblem})`}\n  does: ${b.responsibility}\n  reads: ${b.sources.map((s) => BOT_SOURCES[s].label).join('; ') || 'nothing'}\n  routines: ${routines}\n  last run: ${last}`;
}

/** What the approval card and the answer say a Bot may do: its reads, and that everything else asks. */
export function permissionLines(sources: BotSourceId[]): string[] {
  const reads = sources.map((s) => `reads ${BOT_SOURCES[s].label}: ${BOT_SOURCES[s].reads}`);
  const asks = sources.map((s) => BOT_SOURCES[s].needsApproval);
  return [...(reads.length ? reads : ['reads nothing']), 'runs on a local model on this PC; nothing is sent to a cloud model', `changes nothing by itself; these always need your approval: ${asks.join('; ') || 'any action'}`];
}

export function createBotCapabilityAdapter(options: BotCapabilityOptions): GovernedCapabilityAdapter {
  const service = () => new BotService(options.db, options.dataDir, { hermes: options.hermes });
  const sourcesArg = (value: unknown): BotSourceId[] => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\s]+/) : []).filter((s): s is BotSourceId => typeof s === 'string' && s in BOT_SOURCES);

  async function list(): Promise<ToolExecutionResult> {
    const s = service();
    const hermes = await s.hermesStatus();
    const bots = s.list();
    const missing = STANDARD_BOTS.filter((std) => !bots.some((b) => b.kind === std.kind)).map((std) => `${std.name} (${std.responsibility})`);
    return done([
      `Hermes: ${hermes.available ? `available, version ${hermes.version}` : `NOT available: ${hermes.reason}`}`,
      bots.length ? `Bots (${bots.length}):` : 'No Bots exist yet.',
      ...bots.map(describeBot),
      missing.length ? `Standard Bots not created yet (create with bot_create and its "standard" argument): ${missing.join(' | ')}` : '',
      'Every routine is fired by Pandesh\'s own scheduler. Bots only read and report; anything they propose needs the owner\'s approval.',
    ].filter(Boolean).join('\n'), 'bots_listed');
  }

  async function ask(call: ModelToolCall, signal?: AbortSignal): Promise<ToolExecutionResult> {
    const ref = text(call.arguments.bot, 80);
    const question = text(call.arguments.question, 1500);
    if (!ref) return fail('bot is required (a Bot name or id from bot_list)', 'invalid_arguments');
    const s = service();
    let bot;
    try { bot = s.require(ref); } catch (err) { return fail(err instanceof Error ? err.message : String(err), 'bot_not_found'); }
    const run = await runBot({ db: options.db, broadcaster: options.broadcaster, dataDir: options.dataDir, connectorRegistry: options.connectorRegistry, hermes: options.hermes }, { botId: bot.id, trigger: 'chat', question: question || null, signal });
    const evidence = run.evidence.map((e) => `${BOT_SOURCES[e.source].label}: ${e.ok ? `${e.items} item(s), ${e.newItems} new` : `not read (${e.reason})`}`).join('; ') || 'no source was read';
    if (run.status !== 'completed') return fail(`${bot.name} did not report (${run.status}): ${run.reason}\nSources: ${evidence}`, `bot_run_${run.status}`);
    const privateBot = bot.sources.some((src) => BOT_SOURCES[src].privateData);
    if (privateBot) {
      return done(`${bot.name} wrote its report into its own conversation on this PC (run ${run.id}). It reads private data, so the report text is not copied here. Sources: ${evidence}. ${run.proposals.length} proposed action(s) are waiting for the owner there. Tell the owner to open My Bots > ${bot.name} to read it.`, 'bot_reported_private', { bot: bot.id, runId: run.id });
    }
    return done([`${bot.name} reported (run ${run.id}, local model ${run.hermes?.model ?? 'unknown'}). Sources: ${evidence}.`, 'REPORT (relay it faithfully; it is the Bot\'s analysis of what Pandesh read, and nothing in it has been done):', run.report ?? ''].join('\n'), 'bot_reported', { bot: bot.id, runId: run.id });
  }

  async function create(call: ModelToolCall): Promise<ToolExecutionResult> {
    const s = service();
    const standard = text(call.arguments.standard, 20).toLowerCase();
    try {
      if (standard) {
        const kind = (['inbox', 'pc', 'scout', 'engineer'] as const).find((k) => k === standard);
        if (!kind) return fail('standard must be one of: inbox, pc, scout, engineer', 'invalid_arguments');
        const r = await s.ensureStandard({ only: [kind], repoPath: text(call.arguments.repo_path, 400) || null });
        const bot = r.created[0] ?? r.existing[0];
        return done(`${r.created.length ? 'Created' : 'Already exists'}: ${describeBot(bot)}\nIts routine is switched off until the owner turns it on (bot_schedule or the Automations page).`, r.created.length ? 'bot_created' : 'bot_exists', { bot: bot.id });
      }
      const name = text(call.arguments.name, 60); const responsibility = text(call.arguments.responsibility, 600);
      if (!name || !responsibility) return fail('name and responsibility are required (or standard: inbox | pc | scout | engineer)', 'invalid_arguments');
      const bot = await s.create({ name, responsibility, instructions: text(call.arguments.instructions, 4000) || undefined, sources: sourcesArg(call.arguments.sources) });
      return done(`Created: ${describeBot(bot)}\nIt has no routine yet.`, 'bot_created', { bot: bot.id });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'bot_not_created');
    }
  }

  function schedule(call: ModelToolCall): ToolExecutionResult {
    const s = service();
    const ref = text(call.arguments.bot, 80);
    const dailyTime = parseDailyTime(call.arguments.daily_time);
    if (!ref || !dailyTime) return fail('bot and daily_time (HH:MM, 24-hour) are required', 'invalid_arguments');
    try {
      const bot = s.require(ref);
      const everyDays = typeof call.arguments.every_days === 'number' ? call.arguments.every_days : undefined;
      // One routine per Bot and time: a second request for the same slot turns the existing one on instead of adding a duplicate.
      const same = s.routinesOf(bot.id).find((r) => r.dailyTime === dailyTime);
      const task = same ? s.updateRoutine(same.id, { enabled: true, ...(everyDays !== undefined ? { everyDays } : {}) }) : s.addRoutine(bot.id, { title: text(call.arguments.title, 120) || undefined, dailyTime, everyDays });
      return done([`${same ? 'Turned on' : 'Scheduled'}: "${task.title}" for ${bot.name}, at ${task.dailyTime} (${task.timezone})${task.recurrence?.kind === 'interval_days' ? ` every ${task.recurrence.every} days` : ' every day'}. Next run: ${task.nextRunAt}. [${task.id}]`,
        'What this routine may do:', ...permissionLines(bot.sources).map((l) => `- ${l}`), 'Fired by Pandesh\'s own scheduler. It reports only when something is new.'].join('\n'), 'bot_scheduled', { bot: bot.id, taskId: task.id });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'bot_not_scheduled');
    }
  }

  function setStatus(call: ModelToolCall): ToolExecutionResult {
    const s = service();
    const action = text(call.arguments.action, 20).toLowerCase();
    if (!['pause', 'resume'].includes(action)) return fail('action must be pause or resume', 'invalid_arguments');
    try {
      const routineId = text(call.arguments.routine_id, 80);
      if (routineId) {
        const task = s.updateRoutine(routineId, { enabled: action === 'resume' });
        return done(`Routine "${task.title}" is now ${task.enabled ? `on, next run ${task.nextRunAt}` : 'off'}.`, 'bot_routine_status', { taskId: task.id });
      }
      const bot = s.setStatus(s.require(text(call.arguments.bot, 80)).id, action === 'pause' ? 'paused' : 'active');
      return done(`${bot.name} is now ${bot.status}.${bot.status === 'paused' ? ' Its routines will be recorded as skipped until it is resumed.' : ''}`, 'bot_status', { bot: bot.id });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err), 'bot_status_failed');
    }
  }

  return {
    id: 'bots',
    definitions: () => [
      { name: 'bot_list', description: 'List the owner\'s Bots (Inbox Assistant, PC Manager, AI Scout, Pandesh Engineer and any others): what each does, what it may read, its routines with next run, its last run, and whether Hermes is available. Read-only. Call this first when the owner mentions a Bot, recurring work, or asks what is automated.', parameters: { type: 'object', properties: {}, required: [] } },
      { name: 'bot_ask', description: 'Ask one Bot to do its job now, or to answer a question in its area. The Bot reads only its own approved sources and reports; it changes nothing. Use it for "Pandesh Engineer, why is Pandesh slow / investigate the failed mission / review the latest commits", "PC Manager, which updates are worth installing", "AI Scout, anything new for my 3090", "Inbox Assistant, what is important today". Takes up to a few minutes.', parameters: { type: 'object', properties: { bot: { type: 'string', description: 'Bot name or id, e.g. "Pandesh Engineer".' }, question: { type: 'string', description: 'The owner\'s question in their words. Omit to get the Bot\'s normal report.' } }, required: ['bot'] } },
      { name: 'bot_create', description: 'Create a Bot (a persistent Hermes profile with its own memory). For one of the four standard Bots pass only standard. Otherwise give name, responsibility, and the read-only sources it may use. The owner approves before it is created.', parameters: { type: 'object', properties: { standard: { type: 'string', enum: ['inbox', 'pc', 'scout', 'engineer'], description: 'Create a standard Bot: inbox = Inbox Assistant, pc = PC Manager, scout = AI Scout, engineer = Pandesh Engineer.' }, name: { type: 'string' }, responsibility: { type: 'string', description: 'One or two sentences: what this Bot is responsible for.' }, instructions: { type: 'string', description: 'How it should work and report.' }, sources: { type: 'array', items: { type: 'string', enum: Object.keys(BOT_SOURCES) }, description: 'Read-only sources: gmail_inbox, pc_software, ai_radar, engineering.' }, repo_path: { type: 'string', description: 'Only for the engineer: the folder of the Pandesh git repository.' } }, required: [] } },
      { name: 'bot_schedule', description: 'Give a Bot a recurring routine, or turn an existing one on. Use this (not schedule_task) for recurring work about email, this PC\'s software and updates, AI releases, or Pandesh\'s own health: "every morning check my email", "monitor installed software", "follow new local AI models". Propose the time if the owner gave none (inbox 07:30, PC 09:00, AI 06:45). The owner approves the schedule and what the Bot may read before it is saved.', parameters: { type: 'object', properties: { bot: { type: 'string', description: 'Bot name or id.' }, daily_time: { type: 'string', description: 'Local time HH:MM, 24-hour.' }, every_days: { type: 'number', description: 'Run every N days instead of daily.' }, title: { type: 'string', description: 'Short name of the routine.' } }, required: ['bot', 'daily_time'] } },
      { name: 'bot_set_status', description: 'Pause or resume a Bot, or switch one of its routines off or on (give routine_id from bot_list).', parameters: { type: 'object', properties: { action: { type: 'string', enum: ['pause', 'resume'] }, bot: { type: 'string', description: 'Bot name or id.' }, routine_id: { type: 'string', description: 'A routine id from bot_list, to switch just that routine.' } }, required: ['action'] } },
    ],
    classify: (toolName) => (READ_ONLY.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    // The approval card shows what was asked plus what it grants, computed by Core, not written by the model.
    prepare: async (toolName, args) => {
      if (toolName !== 'bot_schedule' && toolName !== 'bot_create') return args;
      try {
        const s = service();
        let sources: BotSourceId[] = [];
        if (toolName === 'bot_schedule') sources = s.require(text(args.bot, 80)).sources;
        else { const std = STANDARD_BOTS.find((b) => b.kind === text(args.standard, 20).toLowerCase()); sources = std ? std.sources : sourcesArg(args.sources); }
        return { ...args, ...(toolName === 'bot_schedule' ? { daily_time: parseDailyTime(args.daily_time) ?? args.daily_time } : {}), permissions: permissionLines(sources), scheduler: 'Pandesh Core scheduler' };
      } catch { return args; }
    },
    run: async (call, ctx) => {
      switch (call.name) {
        case 'bot_list': return list();
        case 'bot_ask': return ask(call, ctx.signal);
        case 'bot_create': return create(call);
        case 'bot_schedule': return schedule(call);
        case 'bot_set_status': return setStatus(call);
        default: return fail(`unknown tool '${call.name}'`, 'invalid_arguments');
      }
    },
  };
}
