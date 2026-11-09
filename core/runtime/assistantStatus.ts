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
const PROGRESS_WORDS = /\b(?:status|progress|update|how (?:far|many|much)|done yet|finished|complete[d]?|still|remaining|left)\b/i;
/** A command to do Gmail work is a task, never a status question, even when it mentions progress. */
const IMPERATIVE = /^\s*(?:please\s+)?(?:move|archive|label|organi[sz]e|delete|apply|start|create|run|continue|proceed|go|do|make|send|process)\b/i;
const BARE_FOLLOW_UP = /^\s*(?:status|update(?: me)?|progress|and\s*\??|so\s*\??|any (?:news|update|progress)\s*\??|(?:is it |are you )?(?:still )?(?:not )?(?:done|finished|ready)(?: yet)?\s*\??|a?still not d\w+\s*\??)\s*[?!.]*\s*$/i;

/** Which status topics a short request is asking about; null when it is not one of these questions. */
export function classifyStatusRequest(text: string, hasRecentGmailWork = false): StatusTopic[] | null {
  const t = String(text || '').trim();
  if (!t || t.length > 300) return null;
  const topics: StatusTopic[] = [];
  const asksQuestion = /\?|\b(?:how|why|what|which|show|list|tell|explain|configur\w*|status|enabled|working|didn.?t|did not|never)\b/i.test(t);
  if (/\bnotif\w*\b/i.test(t) && asksQuestion && !/\b(?:send|create|write|draft)\b/i.test(t)) topics.push('notifications');
  if (/\b(?:reminders?)\b/i.test(t) && /\b(?:show|list|what|which|any|my|open|upcoming|pending)\b/i.test(t) && !/\bremind me\b/i.test(t) && !/\b(?:create|add|set|delete|cancel|remove)\b/i.test(t)) topics.push('reminders');
  if (/\b(?:what|which)\b[^.?!]{0,40}\b(?:tasks?|jobs?|work)\b[^.?!]{0,30}\b(?:running|active|pending|doing|have)\b|\b(?:running|active|background|pending) (?:tasks?|jobs?)\b|\bwhat are you (?:doing|working on|running)\b/i.test(t)) topics.push('tasks');
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

function describeReminders(db: CoreDatabase): string {
  const rows = db.all<{ title: string; dueAt: string; status: string }>(
    `SELECT title, dueAt, status FROM everyday_reminders WHERE status = 'scheduled' ORDER BY dueAt LIMIT 10`,
  );
  if (rows.length === 0) return '**Reminders:** you have no upcoming reminders.';
  return ['**Your upcoming reminders:**', '', ...rows.map((r) => `- ${r.dueAt}: ${r.title}`)].join('\n');
}

/** The full, factual answer for the requested topics. */
export function composeStatusAnswer(db: CoreDatabase, topics: StatusTopic[], nowMs: number = Date.now()): string {
  const parts: string[] = [];
  if (topics.includes('gmail')) parts.push(describeGmail(db, nowMs));
  if (topics.includes('tasks')) parts.push(describeTasks(db, nowMs));
  if (topics.includes('reminders')) parts.push(describeReminders(db));
  if (topics.includes('notifications') || topics.includes('gmail')) parts.push(describeNotifications(notificationReport(db, nowMs)));
  return parts.join('\n\n');
}

const FUTURE_WORK = /\b(?:i(?:'ll|\s+will|'m\s+going\s+to|\s+am\s+going\s+to)|i(?:'m|\s+am)\s+(?:currently\s+|now\s+)?(?:processing|retrying|working\s+on)|stand(?:ing)?\s+by)\b[^.\n]{0,80}\b(?:retry|try\s+again|continue|process|complete|finish|work|monitor|proceed|batch|wait)\w*|\bin\s+the\s+background\b|\bin\s+a\s+few\s+minutes\b/i;
// D13: only a first-person promise counts ("I'll let you know…"); "this lets you know", "I can't notify you" and
// "would you like me to let you know" no longer trigger a stray correction.
const NOTIFY_PROMISE = /\b(?:i(?:'ll|\s+will)|i(?:'m|\s+am)\s+going\s+to)\s+(?:\w+\s+){0,3}?(?:notify\s+you|let\s+you\s+know|update\s+you|message\s+you|send\s+you\s+(?:a\s+)?(?:notification|update)|tell\s+you\s+when|ping\s+you|alert\s+you)\b/i;

/**
 * A reply may promise future work or a notification only if something real will do it. Returns the correction to
 * append when it promises more than the system can deliver, otherwise null.
 */
export function auditPromises(reply: string, facts: { activeWorker: boolean; canNotify: boolean; notifyStatement: string }): string | null {
  if (facts.activeWorker) return null;
  const parts: string[] = [];
  if (FUTURE_WORK.test(reply)) {
    parts.push('nothing is running in the background and Pandesh does not retry or continue on its own; work only moves when you ask for it and approve it');
  }
  if (NOTIFY_PROMISE.test(reply)) {
    parts.push(facts.canNotify
      ? 'no running task will report back later, so no notification is scheduled; ask for the status and I will read it from the recorded state'
      : 'no notification is scheduled. ' + facts.notifyStatement);
  }
  return parts.length ? 'Correction: ' + parts.join('. Also, ') + '.' : null;
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
