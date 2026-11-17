/**
 * What My Bots and Automations show. Pure functions over what Core returns (core/api/botRoutes.ts), so the pages
 * and the tests share one reading. A Bot is a Hermes profile plus Pandesh's record of what it may read; Core runs
 * it read-only and its scheduler owns every routine.
 */
export type BotSourceId = 'gmail_inbox' | 'pc_software' | 'ai_radar' | 'engineering';
export interface BotSourceInfo { id: BotSourceId; label: string; reads: string; privateData: boolean; needsApproval: string }
export interface Routine { id: string; title: string; purpose: string | null; enabled: boolean; dailyTime: string; timezone: string; nextRunAt: string | null; lastRunAt: string | null; recurrence: { kind: 'weekly'; weekdays: number[] } | { kind: 'interval_days'; every: number; anchor: string } | null }
export interface BotRun {
  id: string; trigger: 'schedule' | 'catch_up' | 'manual' | 'chat'; question: string | null; startedAt: string; finishedAt: string | null;
  status: 'running' | 'completed' | 'failed' | 'skipped' | 'interrupted'; reason: string; report: string | null; proposals: string[]; notified: boolean;
  evidence: Array<{ source: BotSourceId; ok: boolean; reason: string | null; items: number; newItems: number; refs: string[] }>;
  hermes: { profile: string; model: string | null; durationMs: number } | null;
}
export interface Bot {
  id: string; profile: string; name: string; responsibility: string; kind: 'inbox' | 'pc' | 'scout' | 'engineer' | 'custom'; sources: BotSourceId[]; model: string;
  status: 'active' | 'paused'; settings: { repoPath?: string | null }; conversationId: string | null;
  sourcesDetail: BotSourceInfo[]; routines: Routine[]; lastRun: BotRun | null; running: boolean; profileOk: boolean; profileProblem: string | null;
}
export interface HermesInfo { available: boolean; version: string | null; reason: string | null }
export interface BotsResponse {
  hermes: HermesInfo; bots: Bot[]; sources: BotSourceInfo[]; scheduler: string;
  otherProfiles: Array<{ name: string; description: string | null; model: string | null; localOnly: boolean }>;
  standard: Array<{ kind: string; name: string; responsibility: string; exists: boolean }>;
}
export interface BotDetail { bot: Bot; instructions: string; memory: { text: string; updatedAt: string | null }; runs: BotRun[] }
export interface Automation {
  id: string; title: string; purpose: string | null; enabled: boolean; dailyTime: string; timezone: string; nextRunAt: string | null; lastRunAt: string | null; routine: string | null;
  recurrence: Routine['recurrence']; owner: string; kind: 'bot' | 'built_in' | 'instruction'; conversationId: string | null;
  bot: { id: string; name: string; status: 'active' | 'paused' } | null; lastResult: { status: BotRun['status']; reason: string; at: string } | null;
}

export type Tone = 'ok' | 'busy' | 'warn' | 'bad' | 'neutral';
export const TONE_COLOR: Record<Tone, string> = { ok: 'var(--verified)', busy: 'var(--pulse)', warn: 'var(--attention)', bad: 'var(--danger)', neutral: 'var(--muted)' };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function scheduleWords(r: Pick<Routine, 'dailyTime' | 'recurrence' | 'enabled'>): string {
  const every = r.recurrence?.kind === 'interval_days' ? `every ${r.recurrence.every} days` : r.recurrence?.kind === 'weekly' ? r.recurrence.weekdays.map((d) => DAYS[d] ?? '?').join(', ') : 'every day';
  return `${r.enabled ? '' : 'Off · '}${every} at ${r.dailyTime}`;
}

export function whenWords(iso: string | null | undefined, now: number = Date.now()): string {
  const at = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(at)) return 'never';
  const d = new Date(at);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `today ${time}`;
  const days = Math.round((new Date(d.toDateString()).getTime() - new Date(new Date(now).toDateString()).getTime()) / 86_400_000);
  if (days === 1) return `tomorrow ${time}`;
  if (days === -1) return `yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

/** The one line under a Bot's name: what state it is really in. */
export function botStatus(bot: Bot, hermes: HermesInfo): { text: string; tone: Tone } {
  if (!hermes.available) return { text: `Cannot run: ${hermes.reason ?? 'Hermes is not available'}`, tone: 'bad' };
  if (!bot.profileOk) return { text: `Cannot run: ${bot.profileProblem ?? 'its Hermes profile has a problem'}`, tone: 'bad' };
  if (bot.running) return { text: 'Working now…', tone: 'busy' };
  if (bot.status === 'paused') return { text: 'Paused', tone: 'warn' };
  const on = bot.routines.filter((r) => r.enabled);
  if (on.length === 0) return { text: 'Ready · no routine switched on', tone: 'neutral' };
  const next = on.map((r) => r.nextRunAt).filter(Boolean).sort()[0];
  return { text: `Active · next run ${whenWords(next)}`, tone: 'ok' };
}

export function runWords(run: BotRun | null | undefined): { text: string; tone: Tone } {
  if (!run) return { text: 'Never run', tone: 'neutral' };
  const at = whenWords(run.finishedAt ?? run.startedAt);
  if (run.status === 'running') return { text: `Running since ${whenWords(run.startedAt)}`, tone: 'busy' };
  if (run.status === 'completed') return { text: `${at}: ${run.reason}`, tone: 'ok' };
  if (run.status === 'skipped') return { text: `${at}, skipped: ${run.reason}`, tone: 'neutral' };
  if (run.status === 'interrupted') return { text: `${at}, interrupted: ${run.reason}`, tone: 'warn' };
  return { text: `${at}, failed: ${run.reason}`, tone: 'bad' };
}

export function triggerWords(t: BotRun['trigger']): string {
  return t === 'schedule' ? 'Routine' : t === 'catch_up' ? 'Routine (late)' : t === 'chat' ? 'Asked in chat' : 'Run now';
}

/** What a Bot may do, in the words shown before it is created or scheduled. */
export function permissionSummary(sources: BotSourceInfo[]): { reads: string[]; asks: string[] } {
  return { reads: sources.map((s) => `${s.label}: ${s.reads}`), asks: sources.map((s) => s.needsApproval) };
}

/** Returns why a new Bot cannot be created yet, or null. */
export function createProblem(input: { name: string; responsibility: string; sources: string[] }, existing: Array<{ name: string }>): string | null {
  const name = input.name.trim();
  if (!name) return 'Give the Bot a name.';
  if (existing.some((b) => b.name.toLowerCase() === name.toLowerCase())) return `A Bot named "${name}" already exists.`;
  if (input.responsibility.trim().length < 10) return 'Say in a sentence what it is responsible for.';
  if (input.sources.length === 0) return 'Tick at least one thing it may read.';
  return null;
}

export function validDailyTime(value: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value.trim());
}

/** The message that hands one of a Bot's proposals to Pandesh as an ordinary, approval-governed request. */
export function proposalRequest(botName: string, proposal: string): string {
  return `${botName} proposed this. Please do it, and ask me for approval where it changes anything: ${proposal}`;
}

/** Automations sorted the way a person scans them: failures first, then what runs next, then what is off. */
export function sortAutomations(list: Automation[]): Automation[] {
  const rank = (a: Automation) => (a.lastResult && (a.lastResult.status === 'failed' || a.lastResult.status === 'interrupted') ? 0 : a.enabled ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? '9').localeCompare(b.nextRunAt ?? '9') || a.title.localeCompare(b.title));
}

export function automationKind(a: Automation): string {
  return a.kind === 'bot' ? `Bot · ${a.bot?.name ?? 'removed'}` : a.kind === 'built_in' ? 'Built into Pandesh' : 'Your instruction';
}
