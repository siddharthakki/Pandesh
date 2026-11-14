/**
 * Answers questions about Pandesh itself — its notifications, its Gmail organization, its tasks, the user's
 * reminders — from the recorded state, without a model and without a workspace.
 *
 * These are the questions where a model's prose used to invent progress ("Batch 2 completed", "I will notify you").
 * Here every sentence comes from a database row, and anything that is not running is said not to be running.
 */
import type { CoreDatabase } from '../db/connection';
import { describeNotifications, notificationReport } from '../domain/notificationOutbox';
import { progressOf, taskState, type GmailOrganizeTask } from './connectors/gmailTask';

export type StatusTopic = 'notifications' | 'gmail' | 'tasks' | 'reminders';

const GMAIL_WORDS = /\b(?:gmail|inbox|e-?mails?|mail|organi[sz]\w*|labell?\w*|finance)\b/i;
// "how many/much" is a progress question only when it asks about work being done ("how many have been organized");
// "how many emails are in my inbox" is a count of mailbox contents and needs a Gmail tool, never the recorded status.
const PROGRESS_WORDS = /\b(?:status|progress|update|how far|done yet|finished|complete[d]?|still|remaining|left)\b|\bhow (?:many|much)\b[^.?!]{0,60}\b(?:organi[sz]ed|labell?ed|processed|done|finished|completed|left|remaining|moved|archived|applied|handled)\b/i;

/**
 * The classification boundary of every pre-model shortcut: these answer questions about Pandesh's own recorded state.
 * A question about files, folders, paths or code is never one of them, whatever other words it contains. Build 170
 * (installed-binary finding R02): "How many files are in the rw/inbox folder?" was answered with the Gmail status
 * because "inbox" is a Gmail word and "how many" a progress word.
 *
 * A router may only decline here, never grant: declining sends the request to the model with the ordinary tools, whose
 * approvals, privacy checks and cloud-egress rules apply unchanged. This is not a security decision.
 */
const FS_PATH_TOKEN = /(?:^|[\s"'`(])(?:[A-Za-z]:[\\/]|\\\\|~[\\/]|\.{1,2}[\\/])|(?:^|[\s"'`(])[\w.~-]*[A-Za-z][\w.~-]*[\\/][\w.\\/~-]*[A-Za-z]/;
const FS_NOT_A_PATH = /\b(?:and\/or|w\/o|n\/a|he\/she|his\/her|yes\/no|either\/or|read\/write|input\/output)\b/gi;
const FS_FILE_NAME = /\b[\w-]+\.(?:txt|csv|tsv|json|md|pdf|docx?|xlsx?|pptx?|log|ts|tsx|js|mjs|py|html?|zip|eml|msg|png|jpe?g|yaml|yml|xml|ini|bat|ps1)\b/i;
const FS_NOUNS = /\b(?:files?|folders?|director(?:y|ies)|sub-?folders?|paths?|drives?|workspace|repo(?:sitory)?|disk|datei(?:en)?|ordner|verzeichnis\w*|pfad|laufwerk)\b/i;

/** Text inside quotation marks or code spans is mentioned, not asked about. */
function withoutQuoted(text: string): string {
  return text.replace(/`[^`]*`|"[^"]*"|\u201c[^\u201d]*\u201d|\u2018[^\u2019]*\u2019/g, ' ');
}

/** True when the request is about files, folders, paths or code rather than about Pandesh's state. */
export function isAboutFilesystem(text: string): boolean {
  const t = String(text || '').replace(FS_NOT_A_PATH, ' ');
  return FS_PATH_TOKEN.test(t) || FS_FILE_NAME.test(t) || FS_NOUNS.test(withoutQuoted(t));
}

/**
 * A question whose answer exists only on the disk ("how many files are in rw/inbox", "what is in C:\\Temp"). Core
 * requires a real, successful read before such an answer may be reported as done.
 */
export function asksForDiskObservation(text: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 300 || !isAboutFilesystem(t)) return false;
  if (/\b(?:create|write|save|move|copy|delete|remove|rename|organi[sz]e|sort|clean|install|run|build|fix|edit|change|add|make|zip|upload)\b/i.test(withoutQuoted(t))) return false;
  return /\b(?:how\s+(?:many|big|large|much)|count|list|show|what(?:'s|\s+is|\s+are)|which|is\s+there|are\s+there|exists?|contains?|size|newest|oldest|largest|biggest|names?|wie\s+viele|welche|zeig\w*)\b|\?\s*$/i.test(withoutQuoted(t));
}
/** A command to do Gmail work is a task, never a status question, even when it mentions progress. */
const IMPERATIVE = /^\s*(?:please\s+)?(?:move|archive|label|organi[sz]e|delete|apply|start|create|run|continue|proceed|go|do|make|send|process)\b/i;
const BARE_FOLLOW_UP = /^\s*(?:status|update(?: me)?|progress|and\s*\??|so\s*\??|any (?:news|update|progress)\s*\??|(?:is it |are you )?(?:still )?(?:not )?(?:done|finished|ready)(?: yet)?\s*\??|a?still not d\w+\s*\??)\s*[?!.]*\s*$/i;

/**
 * A request to change a reminder goes to the assistant and its reminder tools, never to the list. Micro-test D-REM-1:
 * "Change my stretch reminder to 6 PM" and "Pause my recurring recycling reminder" were answered with the list and
 * nothing changed.
 */
const REMINDER_CHANGE = /\b(?:create|add|set|delete|cancel|remove|change|move|reschedul\w*|pause|resume|stop|edit|update|rename|snooze|postpone|delay|disable|enable|turn\s+(?:off|on)|complete|finish|mark|done)\b/i;
/** A question about one reminder's details is answered by the assistant ("What time zone is this reminder in?", REM-021). */
const REMINDER_DETAIL = /\b(?:time\s*zone|timezone|why|how\s+(?:do|does|can|often)|(?:this|that|the\s+\w+)\s+reminder\b(?!s))/i;

/** Which status topics a short request is asking about; null when it is not one of these questions. */
export function classifyStatusRequest(text: string, hasRecentGmailWork = false): StatusTopic[] | null {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  // Not about Pandesh's own state: files, folders, paths and code go to the model with its tools.
  if (isAboutFilesystem(t)) return null;
  // Quoted text is mentioned, not asked about; a negated request ("don't give me the status") asks for nothing.
  const asked = withoutQuoted(t);
  if (/\b(?:don'?t|do\s+not|without|no\s+need\s+(?:to|for)|never)\b[^.?!]{0,40}\b(?:status|progress|update|report|notif\w*)\b/i.test(asked)) return null;
  return classifyStatusWords(asked, hasRecentGmailWork);
}

function classifyStatusWords(t: string, hasRecentGmailWork: boolean): StatusTopic[] | null {
  const topics: StatusTopic[] = [];
  const asksQuestion = /\?|\b(?:how|why|what|which|show|list|tell|explain|configur\w*|status|enabled|working|didn.?t|did not|never)\b/i.test(t);
  if (/\bnotif\w*\b/i.test(t) && asksQuestion && !/\b(?:send|create|write|draft)\b/i.test(t)) topics.push('notifications');
  if (/\b(?:reminders?)\b/i.test(t) && /\b(?:show|list|what|which|any|my|open|upcoming|pending)\b/i.test(t) && !/\bremind me\b/i.test(t) && !REMINDER_CHANGE.test(t) && !REMINDER_DETAIL.test(t)) topics.push('reminders');
  // "What tasks do I have / my pending tasks / due this week" are the user's own to-dos (Projects, list_tasks), not
  // Pandesh's background work; only questions about what Pandesh is running go to the recorded background state.
  const usersOwnTasks = /\b(?:my|i have|do i have|i've got|due|overdue|deadline|project)\b/i.test(t) && !/\b(?:you|pandesh)\b[^.?!]{0,30}\b(?:running|doing|working)\b/i.test(t);
  if (!usersOwnTasks && /\b(?:what|which)\b[^.?!]{0,40}\b(?:tasks?|jobs?|work)\b[^.?!]{0,30}\b(?:running|active|pending|doing|have)\b|\b(?:running|active|background|pending) (?:tasks?|jobs?)\b|\bwhat are you (?:doing|working on|running)\b/i.test(t)) topics.push('tasks');
  if (GMAIL_WORDS.test(t) && PROGRESS_WORDS.test(t) && asksQuestion && !IMPERATIVE.test(t)) topics.push('gmail');
  if (topics.length === 0 && hasRecentGmailWork && BARE_FOLLOW_UP.test(t)) topics.push('gmail');
  return topics.length ? topics : null;
}

function parseTask(row: { taskJson: string }): GmailOrganizeTask | null {
  try { return JSON.parse(row.taskJson) as GmailOrganizeTask; } catch { return null; }
}

/** True when a Gmail plan or task was touched in the last day, so a bare "status" can fairly mean Gmail. */
export function hasRecentGmailWork(db: CoreDatabase, nowMs: number): boolean {
  const since = new Date(nowMs - 24 * 3600_000).toISOString();
  const plans = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gmail_change_plans WHERE updatedAt >= ?', [since]);
  const tasks = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM gmail_organize_tasks WHERE updatedAt >= ?', [since]);
  return Number(plans?.n ?? 0) + Number(tasks?.n ?? 0) > 0;
}

interface PlanRow { planId: string; status: string; updatedAt: string; planJson: string }

function describeGmail(db: CoreDatabase, nowMs: number): string {
  const lines: string[] = ['**Gmail organization — from the recorded state, not from memory:**', ''];
  const tasks = db.all<{ taskJson: string }>(`SELECT taskJson FROM gmail_organize_tasks ORDER BY updatedAt DESC LIMIT 3`).map(parseTask).filter((t): t is GmailOrganizeTask => Boolean(t));
  if (tasks.length === 0) lines.push('- No persistent Gmail organization task exists. Nothing is queued, paused or running for Gmail.');
  for (const task of tasks) {
    const { state, reason } = taskState(task, nowMs);
    lines.push(`- Task ${task.taskId} (${task.accountEmail}): **${state.replace('_', ' ')}** — ${progressOf(task).text}. ${reason}`);
  }
  const since = new Date(nowMs - 48 * 3600_000).toISOString();
  const plans = db.all<PlanRow>(`SELECT planId, status, updatedAt, planJson FROM gmail_change_plans WHERE updatedAt >= ? ORDER BY updatedAt DESC LIMIT 6`, [since]);
  if (plans.length) lines.push('', 'Change plans in the last 48 hours:');
  for (const plan of plans) {
    let count = 0; let verified = ''; let account = '';
    try {
      const parsed = JSON.parse(plan.planJson) as { messages?: unknown[]; verification?: { matched: number; checked: number }; accountEmail?: string };
      count = parsed.messages?.length ?? 0;
      account = parsed.accountEmail ?? '';
      if (parsed.verification) verified = `, ${parsed.verification.matched} of ${parsed.verification.checked} re-read from Gmail and matching`;
    } catch { /* plan JSON is advisory here */ }
    const meaning: Record<string, string> = {
      planned: 'prepared, NOT applied — nothing in Gmail changed',
      applied: `applied${verified}`,
      applied_unverified: `an apply was recorded but could not be fully verified${verified} — do not treat these messages as done`,
      undone: 'applied, then undone',
      undo_unverified: 'undo attempted but not verified',
    };
    lines.push(`- ${plan.updatedAt} ${count} messages${account ? ` (${account})` : ''}: ${meaning[plan.status] ?? plan.status}`);
  }
  lines.push('', '**Nothing is running in the background for Gmail.** Each batch needs your approval and a new request from you; Pandesh does not retry or continue by itself, and it does not notify you about Gmail work unless the notification status below says so.');
  return lines.join('\n');
}

function describeTasks(db: CoreDatabase, nowMs: number): string {
  const lines = ['**What Pandesh is actually running (from the recorded state):**', ''];
  const bg = db.all<{ id: string; taskType: string; status: string; objective: string; updatedAt: string }>(
    `SELECT id, taskType, status, objective, updatedAt FROM background_tasks WHERE status NOT IN ('completed','failed','cancelled') ORDER BY updatedAt DESC LIMIT 5`,
  );
  for (const t of bg) lines.push(`- Background worker task ${t.id} (${t.taskType}): ${t.status} — ${t.objective.slice(0, 100)}`);
  const gmail = db.all<{ taskJson: string }>(`SELECT taskJson FROM gmail_organize_tasks WHERE status = 'active' ORDER BY updatedAt DESC LIMIT 3`).map(parseTask).filter((t): t is GmailOrganizeTask => Boolean(t));
  for (const t of gmail) lines.push(`- Gmail organization ${t.taskId}: ${taskState(t, nowMs).state.replace('_', ' ')} (waiting for you, not running)`);
  const routines = db.all<{ title: string; dailyTime: string; nextRunAt: string | null }>(`SELECT title, dailyTime, nextRunAt FROM scheduled_tasks WHERE enabled = 1 ORDER BY nextRunAt LIMIT 5`);
  for (const r of routines) lines.push(`- Scheduled routine "${r.title}" at ${r.dailyTime}${r.nextRunAt ? `, next run ${r.nextRunAt}` : ''} (runs only while Pandesh is open)`);
  if (bg.length + gmail.length + routines.length === 0) lines.push('- Nothing. No background task, Gmail task or routine is queued or running.');
  lines.push('', 'Anything not listed above is not running, even if an earlier message in this chat said it was.');
  return lines.join('\n');
}

/** The PC's own time zone (Core runs on the person's PC), e.g. Europe/Berlin. */
function localTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

/** The local calendar day of an instant in `timeZone`, as YYYY-MM-DD. */
function localDay(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/**
 * The upcoming reminders, in local time with the zone named (micro-test REM-021 saw raw UTC). "due today" or "due
 * tomorrow" keeps only that day (REM-009 got every open reminder for "Show reminders due today").
 */
function describeReminders(db: CoreDatabase, nowMs: number, request: string, timeZone = localTimeZone()): string {
  const rows = db.all<{ title: string; dueAt: string; status: string; timezone: string | null }>(
    `SELECT title, dueAt, status, timezone FROM everyday_reminders WHERE status = 'scheduled' ORDER BY dueAt LIMIT 50`,
  );
  const zoneOf = (r: { timezone: string | null }) => (r.timezone && isTimeZone(r.timezone) ? r.timezone : timeZone);
  const day = /\btomorrow\b/i.test(request) ? localDay(nowMs + 24 * 3600_000, timeZone) : /\btoday\b/i.test(request) ? localDay(nowMs, timeZone) : null;
  const shown = (day ? rows.filter((r) => Number.isFinite(Date.parse(r.dueAt)) && localDay(Date.parse(r.dueAt), timeZone) === day) : rows).slice(0, 10);
  const when = day === null ? '' : /\btomorrow\b/i.test(request) ? ' due tomorrow' : ' due today';
  if (shown.length === 0) return `**Reminders:** you have no upcoming reminders${when}.`;
  const zones = [...new Set(shown.map(zoneOf))];
  const local = (iso: string, zone: string) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    return new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
  };
  const header = `**Your upcoming reminders${when}**${zones.length === 1 ? ` (times in ${zones[0]})` : ''}:`;
  return [header, '', ...shown.map((r) => `- ${local(r.dueAt, zoneOf(r))}${zones.length === 1 ? '' : ` (${zoneOf(r)})`}: ${r.title}`)].join('\n');
}

function isTimeZone(zone: string): boolean {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: zone }); return true; } catch { return false; }
}

/** The full, factual answer for the requested topics. */
export function composeStatusAnswer(db: CoreDatabase, topics: StatusTopic[], nowMs: number = Date.now(), request = ''): string {
  const parts: string[] = [];
  if (topics.includes('gmail')) parts.push(describeGmail(db, nowMs));
  if (topics.includes('tasks')) parts.push(describeTasks(db, nowMs));
  if (topics.includes('reminders')) parts.push(describeReminders(db, nowMs, request));
  if (topics.includes('notifications') || topics.includes('gmail')) parts.push(describeNotifications(notificationReport(db, nowMs)));
  return parts.join('\n\n');
}

const FUTURE_WORK = /\b(?:i(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)|i(?:'m|\s+am)\s+(?:currently\s+|now\s+)?(?:processing|retrying|working\s+on)|stand(?:ing)?\s+by)\b[^.\n]{0,80}\b(?:retry|try\s+again|continue|process|complete|finish|work|monitor|proceed|batch|wait)\w*|\bin\s+the\s+background\b|\bin\s+a\s+few\s+minutes\b/i;
// D13: only a first-person promise counts ("I'll let you know…"); "this lets you know", "I can't notify you" and
// "would you like me to let you know" no longer trigger a stray correction.
const NOTIFY_PROMISE = /\b(?:i(?:'ll|\s+will)|i(?:'m|\s+am)\s+going\s+to)\s+(?:\w+\s+){0,3}?(?:notify\s+you|let\s+you\s+know|update\s+you|message\s+you|send\s+you\s+(?:a\s+)?(?:notification|update)|tell\s+you\s+when|ping\s+you|alert\s+you)\b/i;

/**
 * "I'm starting the Proof of Concept now", "I am beginning the construction of the script now", "I will start by
 * creating the project structure": the reply says the work is under way. Owner report 2026-11-12 (widget chat): gemma
 * wrote this twice after web searches only, no file was written, and the "do the step you announced" check never fired
 * because it read only the last paragraph and knew no "starting/beginning" wording.
 */
const START_NOW = /\bi(?:'m|\s+am)\s+(?:now\s+|currently\s+|already\s+)?(?:starting|beginning|kicking\s+off|getting\s+started|proceeding\s+(?:with|to))\b|\bi(?:'m|\s+am)\s+going\s+to\s+(?:start|begin)\b|\bi(?:'ll|\s+will)\s+(?:now\s+|immediately\s+)?(?:start|begin|get\s+started|kick\s+off)\b|\b(?:starting|beginning)\s+(?:the\s+|with\s+(?:the\s+)?)?[^.\n?]{0,60}?\bnow\b/i;

/** True when the reply says, in the first person, that the work is starting now or is about to start. */
export function announcesWorkStarting(reply: string): boolean {
  return START_NOW.test(String(reply || ''));
}

/**
 * A reply may promise future work or a notification only if something real will do it. Returns the correction to
 * append when it promises more than the system can deliver, otherwise null. `nothingMade` is true when the user asked
 * for something to be built and no tool built, wrote or ran anything this turn: then the correction says so first.
 */
export function auditPromises(reply: string, facts: { activeWorker: boolean; canNotify: boolean; notifyStatement: string; nothingMade?: boolean }): string | null {
  if (facts.activeWorker) return null;
  const parts: string[] = [];
  const startsWork = START_NOW.test(reply);
  if (facts.nothingMade && (startsWork || FUTURE_WORK.test(reply))) {
    parts.push('nothing was built in this turn — no file was written or changed, so the work described above has not started');
  }
  if (FUTURE_WORK.test(reply) || startsWork) {
    parts.push('nothing is running in the background and Pandesh does not retry or continue on its own; work only moves when you ask for it and approve it');
  }
  if (NOTIFY_PROMISE.test(reply)) {
    parts.push(facts.canNotify
      ? 'no running task will report back later, so no notification is scheduled; ask for the status and I will read it from the recorded state'
      : 'no notification is scheduled. ' + facts.notifyStatement);
  }
  return parts.length ? 'Correction: ' + parts.join('. Also, ') + '.' : null;
}

// ---------------------------------------------------------------------------------------------------------------
// This chat's own task. Owner report 2026-11-12: after "Build me a windows widget…" and "Go ahead and build it", a bare
// "Status ?" was answered with the Gmail organization status, because Gmail plans made that morning in another chat
// count as "recent Gmail work" everywhere. The widget task recorded in this very chat was never consulted.
// ---------------------------------------------------------------------------------------------------------------

const MAKE_REQUEST = /\b(?:build|create|make|write|generate|draft|develop|implement|code|program|set\s*up|install|fix|design)\b/i;
/** Tools whose success means something was produced or changed (a search, a page switch or a task note is not). */
const PRODUCING_TOOL = /^(?:write_file|edit_file|apply_patch|run_checks|open_local_file|create_project|delegate_to_\w+)$|^propose_|file_change/;
const BOOKKEEPING_TOOL = /^(?:update_task_outcome|request_tools)$/;
/** A message that starts by asking for work is a request, never a status question ("build it now", "update the widget…"). */
const WORK_COMMAND = /^\s*(?:ok(?:ay)?[,.!]?\s+|yes[,.!]?\s+|please\s+)?(?:build|create|make|write|generate|draft|develop|implement|fix|add|change|update|go|do|start|continue|proceed|run|open|install|finish|try)\b/i;
const OWN_TASK_STATUS_WORDS = /\b(?:status|progress|update|how\s+far|done\s+yet|finished|ready|where\s+are\s+we|any\s+news)\b/i;
const STOP_WORDS = new Set(['that', 'this', 'with', 'from', 'what', 'have', 'your', 'status', 'please', 'will', 'show', 'showing', 'there', 'about', 'which', 'where', 'when', 'requested', 'request', 'asked', 'data', 'into', 'some', 'them', 'they', 'also', 'just', 'want']);

function contentWords(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)));
}

export interface ConversationTask {
  attemptId: string;
  objective: string;
  status: string;
  blocker: string | null;
  createdAt: string;
  /** Tools that completed in this chat since the task was recorded, task bookkeeping left out: name → count. */
  toolsRun: Map<string, number>;
  /** How many of those produced or changed something (a file written, a check run, a hand-off). */
  producingRuns: number;
}

/**
 * The most recent task the user asked this chat to carry out (a request to build or make something, or one the model
 * recorded with success criteria), with what really ran for it since. Null when the chat has none.
 */
export function latestConversationTask(db: CoreDatabase, conversationId: string, excludeAttemptId = ''): ConversationTask | null {
  if (!conversationId) return null;
  let rows: Array<{ attemptId: string; objective: string; successCriteria: string; status: string; blocker: string | null; createdAt: string }>;
  try {
    rows = db.all(
      `SELECT attemptId, objective, successCriteria, status, blocker, createdAt FROM task_outcomes
        WHERE conversationId = ? AND attemptId <> ? ORDER BY createdAt DESC LIMIT 20`,
      [conversationId, excludeAttemptId],
    );
  } catch { return null; }
  const task = rows.find((r) => (r.successCriteria && r.successCriteria.trim() !== '[]') || MAKE_REQUEST.test(r.objective));
  if (!task) return null;
  const toolsRun = new Map<string, number>();
  let producingRuns = 0;
  try {
    const since = db.get<{ createdAt: string }>('SELECT createdAt FROM attempts WHERE id = ?', [task.attemptId])?.createdAt ?? task.createdAt;
    const calls = db.all<{ toolName: string }>(
      `SELECT t.toolName AS toolName FROM tool_invocations t JOIN attempts a ON a.id = t.attemptId JOIN requests q ON q.id = a.requestId
        WHERE q.conversationId = ? AND a.createdAt >= ? AND t.status IN ('succeeded','completed')`,
      [conversationId, since],
    );
    for (const { toolName } of calls) {
      if (BOOKKEEPING_TOOL.test(toolName)) continue;
      toolsRun.set(toolName, (toolsRun.get(toolName) ?? 0) + 1);
      if (PRODUCING_TOOL.test(toolName)) producingRuns += 1;
    }
  } catch { /* tool ledger absent in some test databases: report the task without it */ }
  return { attemptId: task.attemptId, objective: task.objective, status: task.status, blocker: task.blocker, createdAt: task.createdAt, toolsRun, producingRuns };
}

/** True when a short message asks how this chat's own task is going ("Status ?", "No status of the widget I requested"). */
export function asksAboutConversationTask(text: string, objective: string): boolean {
  const t = String(text || '').trim();
  if (!t || t.length > 200 || WORK_COMMAND.test(t)) return false;
  if (BARE_FOLLOW_UP.test(t)) return true;
  // A question that names one of Pandesh's own status topics ("status of my Gmail organization") keeps its answer.
  if (!OWN_TASK_STATUS_WORDS.test(t) || classifyStatusRequest(t, false)) return false;
  const wanted = contentWords(objective);
  for (const word of contentWords(t)) if (wanted.has(word)) return true;
  return false;
}

/** The record-based answer about this chat's task: what was asked, what really ran, and that nothing runs unattended. */
export function describeConversationTask(task: ConversationTask, activeWorker: boolean): string {
  const objective = task.objective.replace(/\s+/g, ' ').trim();
  const shown = objective.length > 160 ? `${objective.slice(0, 160)}…` : objective;
  const state = task.status === 'satisfied' ? 'recorded as done'
    : task.status === 'partial' ? 'recorded as partly done'
      : task.status === 'blocked' ? `blocked${task.blocker ? `: ${task.blocker}` : ''}`
        : 'started but not finished';
  const ran = [...task.toolsRun.entries()].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name));
  const lines = [`**Your request in this chat — "${shown}" — from the recorded state, not from memory:**`, ''];
  lines.push(`- Recorded at ${task.createdAt}: ${state}.`);
  if (task.producingRuns === 0) {
    lines.push('- **Nothing has been built for it yet:** no file was written or changed and no check was run in this chat since then.');
    lines.push(ran.length ? `- What did run: ${ran.join(', ')} — looking things up, not building.` : '- No tool ran for it.');
  } else {
    lines.push(`- Work recorded since then: ${ran.join(', ')}.`);
  }
  lines.push(activeWorker
    ? '- Work for this chat is still running right now.'
    : '- Nothing is running in the background: work only moves during a turn with me. Say "build it now" and I will do it in this turn.');
  return lines.join('\n');
}

/** True while a persisted background worker task owns work for this conversation. */
export function hasActiveWorker(db: CoreDatabase, conversationId: string, excludeAttemptId?: string): boolean {
  if (!conversationId) return false;
  const row = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM background_tasks WHERE conversationId = ? AND status IN ('queued','in_progress')", [conversationId]);
  if (Number(row?.n ?? 0) > 0) return true;
  // Challenge F14: while a Coding hand-off from this chat was still running, a quick question's reply got "nothing is
  // running in the background" appended. Another unfinished attempt in the same conversation is active work.
  if (!excludeAttemptId) return false;
  const other = db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM attempts a JOIN requests q ON q.id = a.requestId
      WHERE q.conversationId = ? AND a.id <> ? AND a.status IN ('created','queued','running','waiting_for_approval','validating','paused','blocked','cancelling')`,
    [conversationId, excludeAttemptId],
  );
  return Number(other?.n ?? 0) > 0;
}
