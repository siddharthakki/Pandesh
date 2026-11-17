/**
 * Creating and managing Bots, and their routines.
 *
 * A Bot is a Hermes profile (identity, instructions, memory, model preference) plus Pandesh's record of what it
 * may read. A routine is one row in Core's `scheduled_tasks` with routine `bot_routine`: Core's scheduler is the
 * only scheduler that fires it. Hermes' own cron is never used for a Bot, so a routine has exactly one owner.
 */
import type { CoreDatabase } from '../../db/connection';
import { CoreError } from '../../domain/errors';
import { newId } from '../../domain/ids';
import {
  cancelScheduledTask, createScheduledTask, getScheduledTask, listRoutineTasks, rescheduleDailyTask, setScheduledTaskEnabled,
  type Recurrence, type ScheduledTaskRecord,
} from '../../domain/scheduledTasks';
import { BOT_SOURCES, BotStore, type BotRecord, type BotRunRecord, type BotSourceId } from './botStore';
import { BOT_ROUTINE, botIsRunning } from './botRunner';
import { DEFAULT_BOT_MODEL, HermesBotRuntime, botProfileName, sharedHermesBots, type HermesStatus } from './hermesBotRuntime';

export interface StandardBot { kind: BotRecord['kind']; name: string; responsibility: string; sources: BotSourceId[]; instructions: string; routine: { title: string; dailyTime: string; everyDays?: number } }

export const STANDARD_BOTS: readonly StandardBot[] = [
  {
    kind: 'inbox', name: 'Inbox Assistant',
    responsibility: 'Watch the Gmail inbox, say which mail matters and why, point out appointments and deadlines, and suggest how to keep the inbox tidy.',
    sources: ['gmail_inbox'],
    instructions: 'You read summaries of the owner\'s inbox that Pandesh gives you. Say what needs an answer or a decision first, with the deadline if the mail states one. Group the rest briefly. Suggest cleanup rules (a label, an archive rule, an unsubscribe) as proposals only. You never send, reply, label, archive or delete: propose it and the owner approves it in Pandesh. Quote as little of a message as possible.',
    routine: { title: 'Morning inbox summary', dailyTime: '07:30' },
  },
  {
    kind: 'pc', name: 'PC Manager',
    responsibility: 'Keep an eye on this PC: installed software and available updates, disk space, services and backups. Recommend which updates are worth installing.',
    sources: ['pc_software'],
    instructions: 'You get Pandesh\'s inventory of this PC and its update check. Say which updates are worth installing and why (security fix, bug fix that matters here, or skip). Flag low disk space. You never install, update, clean up, stop a service or restart: list each as a proposed action with the exact package and version, for the owner to approve.',
    routine: { title: 'Software and disk check', dailyTime: '09:00', everyDays: 2 },
  },
  {
    kind: 'scout', name: 'AI Scout',
    responsibility: 'Follow new local-AI releases, models, GitHub projects and security advisories, compare them with what is installed here and with the RTX 3090 (24 GB), and report only what changed.',
    sources: ['ai_radar'],
    instructions: 'You get Pandesh\'s AI Radar findings, the list of installed models and the GPU. Say what is new and whether it matters on a 24 GB card: does it fit, is it better than what is installed, is there a security advisory. Do not repeat what you reported before unless it became urgent. Recommend at most three things to try. You never install or download: propose it.',
    routine: { title: 'AI release watch', dailyTime: '06:45' },
  },
  {
    kind: 'engineer', name: 'Pandesh Engineer',
    responsibility: 'Understand and maintain Pandesh itself: its source code, architecture, git history, installed build, logs and failures. Diagnose problems and propose fixes.',
    sources: ['engineering'],
    instructions: 'You are the engineer for the Pandesh application. You get the installed build, the repository state and recent commits, source search results, Core\'s record of failed work and the problem lines of its logs. Every conclusion must cite a file:line, a commit id, an attempt or mission id, or a log file from the evidence; if the evidence does not support a conclusion, say what you would need to look at. Separate what is implemented (in the code) from what is only planned (in docs). You diagnose and propose. You never edit, commit, merge, build, install or deploy: list the change as a proposed action.',
    routine: { title: 'Engineering review of failures and new commits', dailyTime: '05:30' },
  },
];

export interface BotView extends BotRecord {
  sourcesDetail: Array<{ id: BotSourceId; label: string; reads: string; privateData: boolean; needsApproval: string }>;
  routines: ScheduledTaskRecord[];
  lastRun: BotRunRecord | null;
  running: boolean;
  profileOk: boolean;
  profileProblem: string | null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function soulFor(name: string, responsibility: string, instructions: string): string {
  return [`# ${name}`, '', `You are "${name}", a Pandesh Bot working for one person on their own PC.`, '', `Responsibility: ${responsibility}`, '', instructions, '',
    'Always: use only the evidence Pandesh gives you and your memory; cite what you rely on; never claim an action you cannot take; end with proposed actions for the owner to approve.'].join('\n');
}

export class BotService {
  readonly store: BotStore;
  readonly hermes: HermesBotRuntime;

  constructor(private readonly db: CoreDatabase, private readonly dataDir: string, options: { hermes?: HermesBotRuntime; store?: BotStore } = {}) {
    this.store = options.store ?? new BotStore(dataDir);
    this.hermes = options.hermes ?? sharedHermesBots;
  }

  hermesStatus(force = false): Promise<HermesStatus> { return this.hermes.status(force); }

  routinesOf(botId: string): ScheduledTaskRecord[] {
    return listRoutineTasks(this.db, BOT_ROUTINE).filter((t) => (t.scope as { botId?: string } | null)?.botId === botId);
  }

  view(bot: BotRecord): BotView {
    const local = this.hermes.profileIsLocalOnly(bot.profile);
    return {
      ...bot,
      sourcesDetail: bot.sources.map((id) => ({ id, ...BOT_SOURCES[id] })),
      routines: this.routinesOf(bot.id),
      lastRun: this.store.runs(bot.id, 1)[0] ?? null,
      running: botIsRunning(bot.id),
      profileOk: local.ok,
      profileProblem: local.reason,
    };
  }

  list(): BotView[] { return this.store.list().map((b) => this.view(b)); }

  require(ref: string): BotRecord {
    const bot = this.store.get(ref) ?? this.store.find(ref);
    if (!bot) throw new CoreError('not_found', `No Bot named "${ref}". Bots: ${this.store.list().map((b) => b.name).join(', ') || 'none yet'}.`);
    return bot;
  }

  /** Creates the Hermes profile first; the Pandesh record is written only when that succeeded. */
  async create(input: { name: string; responsibility: string; instructions?: string; sources?: BotSourceId[]; model?: string; kind?: BotRecord['kind']; repoPath?: string | null }): Promise<BotView> {
    const name = cleanText(input.name, 60);
    const responsibility = cleanText(input.responsibility, 600);
    if (!name || !responsibility) throw new CoreError('invalid_request', 'A Bot needs a name and a responsibility.');
    const bots = this.store.list();
    if (bots.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw new CoreError('conflict', `A Bot named "${name}" already exists.`);
    const sources = [...new Set((input.sources ?? []).filter((s): s is BotSourceId => s in BOT_SOURCES))];
    const model = cleanText(input.model, 120) || DEFAULT_BOT_MODEL;
    const instructions = typeof input.instructions === 'string' ? input.instructions.trim().slice(0, 4000) : '';
    const taken = new Set([...this.hermes.listProfiles().map((p) => p.name), ...bots.map((b) => b.profile)]);
    const profile = botProfileName(name, taken);
    try {
      await this.hermes.createProfile({ name: profile, description: `Pandesh Bot "${name}": ${responsibility}`, soul: soulFor(name, responsibility, instructions), model });
    } catch (err) {
      throw new CoreError('dependency_violation', `The Bot was not created: ${err instanceof Error ? err.message : String(err)}`);
    }
    const now = new Date().toISOString();
    const bot = this.store.save({ id: newId('bot'), profile, name, responsibility, kind: input.kind ?? 'custom', sources, model, status: 'active', settings: { repoPath: input.repoPath ?? null }, seen: {}, conversationId: null, createdAt: now, updatedAt: now });
    return this.view(bot);
  }

  /** Creates whichever of the four standard Bots does not exist yet, each with its routine switched OFF until the owner turns it on. */
  async ensureStandard(options: { repoPath?: string | null; only?: BotRecord['kind'][] } = {}): Promise<{ created: BotView[]; existing: BotView[] }> {
    const created: BotView[] = []; const existing: BotView[] = [];
    for (const std of STANDARD_BOTS) {
      if (options.only && !options.only.includes(std.kind)) continue;
      const have = this.store.list().find((b) => b.kind === std.kind);
      if (have) { existing.push(this.view(have)); continue; }
      const bot = await this.create({ name: std.name, responsibility: std.responsibility, instructions: std.instructions, sources: std.sources, kind: std.kind, repoPath: std.kind === 'engineer' ? options.repoPath ?? null : null });
      this.addRoutine(bot.id, { title: std.routine.title, dailyTime: std.routine.dailyTime, everyDays: std.routine.everyDays, enabled: false });
      created.push(this.view(this.require(bot.id)));
    }
    return { created, existing };
  }

  update(id: string, patch: { name?: string; responsibility?: string; instructions?: string; model?: string; sources?: BotSourceId[]; repoPath?: string | null }): BotView {
    const bot = this.require(id);
    const next: BotRecord = { ...bot, settings: { ...bot.settings } };
    if (patch.name !== undefined) { const n = cleanText(patch.name, 60); if (!n) throw new CoreError('invalid_request', 'The name cannot be empty.'); next.name = n; }
    if (patch.responsibility !== undefined) { const r = cleanText(patch.responsibility, 600); if (!r) throw new CoreError('invalid_request', 'The responsibility cannot be empty.'); next.responsibility = r; }
    if (patch.sources !== undefined) next.sources = [...new Set(patch.sources.filter((s): s is BotSourceId => s in BOT_SOURCES))];
    if (patch.repoPath !== undefined) next.settings.repoPath = patch.repoPath ? String(patch.repoPath).trim().slice(0, 400) : null;
    if (patch.model !== undefined) next.model = cleanText(patch.model, 120) || DEFAULT_BOT_MODEL;
    try {
      const soulChanged = patch.instructions !== undefined || patch.name !== undefined || patch.responsibility !== undefined;
      if (soulChanged || patch.model !== undefined) {
        this.hermes.updateProfile(bot.profile, {
          ...(patch.instructions !== undefined ? { soul: soulFor(next.name, next.responsibility, String(patch.instructions).trim().slice(0, 4000)) } : {}),
          ...(patch.model !== undefined ? { model: next.model } : {}),
        });
      }
    } catch (err) {
      throw new CoreError('dependency_violation', `The Bot's Hermes profile could not be updated: ${err instanceof Error ? err.message : String(err)}`);
    }
    return this.view(this.store.save(next));
  }

  setStatus(id: string, status: 'active' | 'paused'): BotView {
    const bot = this.require(id);
    return this.view(this.store.save({ ...bot, status }));
  }

  /** Removes the Bot, its routines and (when Pandesh created it) its Hermes profile and memory. */
  async remove(id: string): Promise<void> {
    const bot = this.require(id);
    for (const t of this.routinesOf(bot.id)) cancelScheduledTask(this.db, t.id);
    try { await this.hermes.deleteProfile(bot.profile); } catch (err) {
      throw new CoreError('dependency_violation', `The Bot was not removed: ${err instanceof Error ? err.message : String(err)}`);
    }
    this.store.remove(bot.id);
  }

  addRoutine(botId: string, input: { title?: string; dailyTime: string; timezone?: string; everyDays?: number; weekdays?: number[]; enabled?: boolean }): ScheduledTaskRecord {
    const bot = this.require(botId);
    let recurrence: Recurrence | null = null;
    if (Array.isArray(input.weekdays) && input.weekdays.length) recurrence = { kind: 'weekly', weekdays: input.weekdays };
    else if (input.everyDays && input.everyDays > 1) recurrence = { kind: 'interval_days', every: Math.floor(input.everyDays), anchor: new Date().toISOString().slice(0, 10) };
    const reads = bot.sources.map((s) => BOT_SOURCES[s].label).join('; ') || 'nothing';
    const task = createScheduledTask(this.db, {
      title: cleanText(input.title, 120) || `${bot.name} routine`,
      instruction: `Run the Bot "${bot.name}": ${bot.responsibility}`.slice(0, 3900),
      dailyTime: input.dailyTime,
      timezone: input.timezone ?? (Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin'),
      routine: BOT_ROUTINE,
      recurrence,
      purpose: `Read-only. Reads: ${reads}. Runs on a local model. Changes nothing; anything it proposes needs your approval.`.slice(0, 300),
      // The bounded authority of the unattended run: which Bot, which read-only sources, no operations.
      scope: { botId: bot.id, sources: bot.sources, operations: [], cloud: false },
    });
    return input.enabled === false ? setScheduledTaskEnabled(this.db, task.id, false) : task;
  }

  private requireRoutine(taskId: string): ScheduledTaskRecord {
    const task = getScheduledTask(this.db, taskId);
    if (task.routine !== BOT_ROUTINE) throw new CoreError('invalid_request', 'That schedule is not a Bot routine.');
    return task;
  }

  updateRoutine(taskId: string, patch: { enabled?: boolean; dailyTime?: string; everyDays?: number; weekdays?: number[] }): ScheduledTaskRecord {
    let task = this.requireRoutine(taskId);
    if (patch.dailyTime !== undefined || patch.everyDays !== undefined || patch.weekdays !== undefined) {
      let recurrence: Recurrence | null | undefined;
      if (Array.isArray(patch.weekdays) && patch.weekdays.length) recurrence = { kind: 'weekly', weekdays: patch.weekdays };
      else if (patch.everyDays !== undefined) recurrence = patch.everyDays > 1 ? { kind: 'interval_days', every: Math.floor(patch.everyDays), anchor: new Date().toISOString().slice(0, 10) } : null;
      task = rescheduleDailyTask(this.db, taskId, { dailyTime: patch.dailyTime ?? task.dailyTime, ...(recurrence !== undefined ? { recurrence } : {}) });
    }
    if (patch.enabled !== undefined) task = setScheduledTaskEnabled(this.db, taskId, patch.enabled);
    return task;
  }

  removeRoutine(taskId: string): ScheduledTaskRecord {
    this.requireRoutine(taskId);
    return cancelScheduledTask(this.db, taskId);
  }
}
