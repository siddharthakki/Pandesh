/**
 * "What did you do for me in the last hour?" answered from Core's own records.
 *
 * Everyday tasks, 2026-11-24: after eleven tasks in other chats, a new chat answered "I have not performed any
 * actions", with no tool call. A model in a fresh conversation has no memory of other conversations; Core does. The
 * report is built from requests, their attempts, the recorded tool calls and task outcomes, across all conversations,
 * and it keeps three things apart that a single "done" would blur:
 *   - completed:  the task finished and its record says so;
 *   - attempted:  work started and did not finish (stopped, interrupted, still running, waiting, or only partly done);
 *   - failed:     the task ended in failure, with the recorded reason.
 * Within a task, every recorded action is listed as done or as not done. Nothing here comes from the model.
 */
import type { CoreDatabase } from '../db/connection';
import { devStoriesNeedingAttention } from './kandev/devStories';

export interface ActivityWindow { sinceMs: number; label: string }

const CORE_QUESTION = /\bwhat\s+(?:did|have)\s+you\s+(?:actually\s+|really\s+)?(?:do|done|get\s+done|gotten\s+done|accomplish(?:ed)?|work(?:ed)?\s+on|finish(?:ed)?|complete(?:d)?)\b|\bwhat\s+were\s+you\s+(?:doing|working\s+on)\b|\b(?:summar(?:y|i[sz]e)|report|list|show(?:\s+me)?|tell\s+me)\b[^?.]{0,40}\b(?:what\s+you\s+(?:did|have\s+done|got\s+done)|everything\s+you\s+did|your\s+(?:recent\s+)?(?:activity|actions|work))\b|\bactivity\s+report\b/i;
const WINDOW = /\b(?:in|over|during|for|within)?\s*(?:the\s+)?(?:last|past|previous)\s+(\d+(?:\.\d+)?|an?|one|two|three|four|five|six|twelve|couple\s+of|few)?\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)\b|\b(today|this\s+morning|this\s+afternoon|this\s+evening|tonight|yesterday|so\s+far|recently|just\s+now|since\s+(?:i\s+)?(?:left|started))\b/i;
const WORD_NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, twelve: 12, 'couple of': 2, few: 3 };

/**
 * The period an activity question asks about, or null when the message is not such a question. A question about one
 * thing ("what did you do to my report?") is not a report request: it must name a period or be short.
 */
export function activityWindow(text: string, nowMs: number = Date.now()): ActivityWindow | null {
  const t = String(text ?? '').trim();
  if (!CORE_QUESTION.test(t)) return null;
  // About one thing, whatever period it names: "what have you done with the file I gave you this morning".
  if (/\b(?:do|done|did)\s+(?:to|with|about)\s+(?:my|the|this|that|it|them)\b/i.test(t)) return null;
  const m = WINDOW.exec(t);
  if (!m) {
    if (t.length > 70 || /\b(?:to|with|about|on)\s+(?:my|the|this|that)\b/i.test(t)) return null;
    return { sinceMs: nowMs - 24 * 3_600_000, label: 'in the last 24 hours' };
  }
  if (m[2]) {
    const raw = (m[1] ?? '1').toLowerCase().replace(/\s+/g, ' ');
    const n = Number.isFinite(Number(raw)) ? Number(raw) : WORD_NUMBERS[raw] ?? 1;
    const unit = m[2].toLowerCase();
    const ms = /^(?:min)/.test(unit) ? 60_000 : /^(?:hour|hr)/.test(unit) ? 3_600_000 : /^day/.test(unit) ? 86_400_000 : 7 * 86_400_000;
    const amount = Math.min(n * ms, 31 * 86_400_000);
    const plain = /^(?:min)/.test(unit) ? 'minute' : /^(?:hour|hr)/.test(unit) ? 'hour' : /^day/.test(unit) ? 'day' : 'week';
    return { sinceMs: nowMs - amount, label: n === 1 ? `in the last ${plain}` : `in the last ${n} ${plain}s` };
  }
  const word = m[3].toLowerCase().replace(/\s+/g, ' ');
  const midnight = new Date(nowMs); midnight.setHours(0, 0, 0, 0);
  if (word === 'yesterday') return { sinceMs: midnight.getTime() - 86_400_000, label: 'since yesterday morning' };
  if (word === 'recently' || word === 'just now') return { sinceMs: nowMs - 3_600_000, label: 'in the last hour' };
  if (word === 'this afternoon') { const noon = new Date(midnight); noon.setHours(12); return { sinceMs: Math.min(noon.getTime(), nowMs), label: 'this afternoon' }; }
  if (word === 'this evening' || word === 'tonight') { const six = new Date(midnight); six.setHours(18); return { sinceMs: Math.min(six.getTime(), nowMs), label: 'this evening' }; }
  return { sinceMs: midnight.getTime(), label: 'today' };
}

export type ActivityState = 'completed' | 'attempted' | 'failed';
export interface ActivityAction { tool: string; what: string; ok: boolean; at: string }
export interface ActivityTask {
  requestId: string; conversationId: string | null; message: string; startedAt: string; endedAt: string | null;
  state: ActivityState; why: string | null; done: ActivityAction[]; notDone: ActivityAction[];
}
export interface ActivityReport {
  /** The newest requests, with their recorded actions. */
  tasks: ActivityTask[];
  /** Older requests in the period that are counted in `totals` but not listed. */
  truncated: number;
  /** Every request in the period, listed or not. */
  totals: Record<ActivityState, number>;
  waitingForYou: Array<{ title: string; reason: string }>;
}

const BOOKKEEPING = /^(?:update_task_outcome|request_tools)$/;
const MAX_TASKS = 25;

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function actionText(tool: string, evidence: string | null, args: string | null): string {
  let title = '';
  let output = '';
  try { const e = JSON.parse(evidence ?? '{}') as { output?: unknown; activity?: { title?: unknown } }; title = typeof e.activity?.title === 'string' ? e.activity.title : ''; output = typeof e.output === 'string' ? e.output : ''; } catch { /* plain text evidence */ }
  const name = tool.replace(/_/g, ' ');
  if (title && title.toLowerCase() !== name) return `${clip(title, 90)} (${name})`;
  let target = '';
  try { const a = JSON.parse(args ?? '{}') as Record<string, unknown>; const v = a.filePath ?? a.path ?? a.name ?? a.query ?? a.command ?? a.from; if (typeof v === 'string') target = clip(v, 70); } catch { /* no arguments */ }
  return `${name}${target ? `: ${target}` : ''}${!title && output && /^(?:NOT|Not|Error|ERROR)\b/.test(output) ? ` — ${clip(output, 110)}` : ''}`;
}

/** What Core recorded in the period, newest first. `excludeRequestId` is the question itself. */
export function collectActivity(db: CoreDatabase, options: { sinceMs: number; nowMs?: number; excludeRequestId?: string }): ActivityReport {
  const nowMs = options.nowMs ?? Date.now();
  const since = new Date(options.sinceMs).toISOString();
  const rows = db.all<{ requestId: string; conversationId: string | null; message: string; createdAt: string; attemptId: string; status: string; failureReason: string | null; completedAt: string | null; cancelledAt: string | null; claimExpiresAt: string | null }>(
    `SELECT r.id AS requestId, r.conversationId AS conversationId, r.currentMessage AS message, r.createdAt AS createdAt,
            a.id AS attemptId, a.status AS status, a.failureReason AS failureReason, a.completedAt AS completedAt, a.cancelledAt AS cancelledAt, a.claimExpiresAt AS claimExpiresAt
       FROM requests r
       JOIN attempts a ON a.requestId = r.id
      WHERE r.createdAt >= ? AND r.id != ? AND a.parentAttemptId IS NULL
        AND r.currentMessage NOT LIKE 'M38 governed capability dispatch anchor for %' -- Core's own bookkeeping row, not a request
        AND a.rowid = (SELECT a2.rowid FROM attempts a2 WHERE a2.requestId = r.id AND a2.parentAttemptId IS NULL ORDER BY a2.createdAt DESC, a2.rowid DESC LIMIT 1)
      ORDER BY r.createdAt DESC, r.rowid DESC`,
    [since, options.excludeRequestId ?? ''],
  );
  const tasks: ActivityTask[] = [];
  for (const [index, row] of rows.entries()) {
    // Every request in the period is classified and counted; the recorded actions are read for the ones listed.
    // Every attempt of the request counts (a retried or escalated task did its work across several).
    const calls = index >= MAX_TASKS ? [] : db.all<{ toolName: string; status: string; startedAt: string; evidence: string | null; argsSummary: string | null }>(
      `SELECT t.toolName AS toolName, t.status AS status, t.startedAt AS startedAt, t.evidence AS evidence, t.argsSummary AS argsSummary
         FROM tool_invocations t JOIN attempts a ON a.id = t.attemptId
        WHERE a.requestId = ? ORDER BY t.startedAt ASC, t.rowid ASC`, [row.requestId]).filter((c) => !BOOKKEEPING.test(c.toolName));
    const toAction = (c: (typeof calls)[number]): ActivityAction => ({ tool: c.toolName, what: actionText(c.toolName, c.evidence, c.argsSummary), ok: c.status === 'succeeded', at: c.startedAt });
    const done = calls.filter((c) => c.status === 'succeeded').map(toAction);
    const notDone = calls.filter((c) => c.status !== 'succeeded').map(toAction);
    const outcome = db.get<{ status: string; blocker: string | null; summary: string | null }>('SELECT status, blocker, summary FROM task_outcomes WHERE attemptId = ?', [row.attemptId]);
    let state: ActivityState; let why: string | null = null;
    if (row.status === 'failed') { state = 'failed'; why = row.failureReason ? clip(row.failureReason, 200) : 'no reason was recorded'; }
    else if (row.status === 'completed') {
      if (outcome?.status === 'partial' || outcome?.status === 'blocked') { state = 'attempted'; why = clip(outcome.blocker || outcome.summary || 'recorded as only partly done', 200); }
      else state = 'completed';
    } else {
      state = 'attempted';
      const lapsed = row.claimExpiresAt ? Date.parse(row.claimExpiresAt) < nowMs : false;
      why = row.status === 'cancelled' || row.status === 'cancelling' ? 'stopped before it finished'
        : row.status === 'waiting_for_approval' ? 'waiting for your approval'
          : row.status === 'paused' || row.status === 'blocked' ? 'paused; waiting for you'
            : row.status === 'recovery_required' || lapsed ? 'interrupted: the app stopped while it was running, and it was not resumed'
              : 'still running';
    }
    tasks.push({ requestId: row.requestId, conversationId: row.conversationId, message: row.message, startedAt: row.createdAt, endedAt: row.completedAt ?? row.cancelledAt, state, why, done, notDone });
  }
  let waitingForYou: ActivityReport['waitingForYou'] = [];
  try { waitingForYou = devStoriesNeedingAttention(db).map((w) => ({ title: w.title, reason: w.reason })); } catch { /* worker records unavailable: say nothing about them */ }
  const all = { completed: 0, attempted: 0, failed: 0 };
  for (const t of tasks) all[t.state] += 1;
  return { tasks: tasks.slice(0, MAX_TASKS), truncated: Math.max(0, tasks.length - MAX_TASKS), totals: all, waitingForYou };
}

function clock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function taskLines(t: ActivityTask): string[] {
  const head = `- ${clock(t.startedAt)} — "${clip(t.message, 110)}"${t.why ? ` — ${t.why}` : ''}`;
  const lines = [head];
  const fold = (actions: ActivityAction[]) => {
    const seen = new Map<string, number>();
    for (const a of actions) seen.set(a.what, (seen.get(a.what) ?? 0) + 1);
    return [...seen].slice(0, 6).map(([what, n]) => (n > 1 ? `${what} ×${n}` : what)).join('; ') + (seen.size > 6 ? `; and ${seen.size - 6} more` : '');
  };
  if (t.done.length) lines.push(`  - Done: ${fold(t.done)}`);
  if (t.notDone.length) lines.push(`  - Tried, did not work: ${fold(t.notDone)}`);
  if (!t.done.length && !t.notDone.length) lines.push(t.state === 'completed' ? '  - Answered in the chat; no action on the PC was recorded.' : '  - No action was recorded for it.');
  return lines;
}

/** The report as the person reads it. Every line is a record; a period with no records says so. */
export function renderActivityReport(report: ActivityReport, window: ActivityWindow, nowMs: number = Date.now()): string {
  const span = `${window.label} (${clock(new Date(window.sinceMs).toISOString())}–${clock(new Date(nowMs).toISOString())})`;
  const waiting = report.waitingForYou.length
    ? `\n\n**Waiting for you (${report.waitingForYou.length}):**\n${report.waitingForYou.slice(0, 5).map((w) => `- Worker task "${clip(w.title, 80)}": ${clip(w.reason, 160)}`).join('\n')}\nThey are on the Board under "Needs you".`
    : '';
  if (report.tasks.length === 0) {
    return `Core has no record of any request ${span}, so I did nothing for you in that time.${waiting}\n\nFrom Core's task and tool records, not from my memory of this chat.`;
  }
  const by = (s: ActivityState) => report.tasks.filter((t) => t.state === s);
  const completed = by('completed'); const attempted = by('attempted'); const failed = by('failed');
  const actionsDone = report.tasks.reduce((n, t) => n + t.done.length, 0);
  const actionsFailed = report.tasks.reduce((n, t) => n + t.notDone.length, 0);
  const total = report.tasks.length + report.truncated;
  const scope = report.truncated ? `In the newest ${report.tasks.length}, listed below,` : 'Across them';
  const parts = [
    `${span[0].toUpperCase()}${span.slice(1)} you gave me ${total} request${total === 1 ? '' : 's'}: ${report.totals.completed} completed, ${report.totals.attempted} attempted but not finished, ${report.totals.failed} failed. ${scope} ${actionsDone} recorded action${actionsDone === 1 ? '' : 's'} succeeded and ${actionsFailed} did not.`,
  ];
  const section = (title: string, list: ActivityTask[]) => { if (list.length) parts.push(`**${title} (${list.length}${report.truncated ? ' listed' : ''}):**\n${list.flatMap(taskLines).join('\n')}`); };
  section('Completed', completed);
  section('Attempted, not finished', attempted);
  section('Failed', failed);
  if (report.truncated) parts.push(`${report.truncated} older request${report.truncated === 1 ? ' is' : 's are'} not listed here; the Board has all of them.`);
  return `${parts.join('\n\n')}${waiting}\n\nFrom Core's task and tool records (all chats), not from my memory of this chat.`;
}

/** The whole answer for a message, or null when it is not an activity question. */
export function answerActivityQuestion(db: CoreDatabase, text: string, options: { nowMs?: number; excludeRequestId?: string } = {}): string | null {
  const nowMs = options.nowMs ?? Date.now();
  const window = activityWindow(text, nowMs);
  if (!window) return null;
  return renderActivityReport(collectActivity(db, { sinceMs: window.sinceMs, nowMs, excludeRequestId: options.excludeRequestId }), window, nowMs);
}
