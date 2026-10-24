/**
 * The daily briefing — what matters today, why, and what to do about it.
 *
 * One builder serves both surfaces: the chat tool `get_briefing_data` and the
 * scheduled `daily_brief` routine. It is deterministic and read-only: no model
 * call, no write to Gmail, Calendar, reminders, commitments or schedules. Run it
 * twice and nothing is created twice, because it creates nothing.
 *
 * Mail is ranked by importance (see `core/domain/briefingTriage.ts`), not by
 * recency. Calendar and mail are read concurrently through a small, bounded
 * number of calls, and whatever could not be read or was only partly covered is
 * said so in the output instead of being presented as "nothing".
 */
import type { CoreDatabase } from '../db/connection';
import { listPendingApprovals } from '../domain/approvals';
import { approvalContext, briefTitle, describeApprovalCardText, describeApprovalIntent } from '../domain/assistantBrief';
import { describeCommitment, listCommitments, toCommitmentView } from '../domain/commitments';
import { listReminders } from '../domain/everydayTools';
import { listScheduledTasks } from '../domain/scheduledTasks';
import { attemptRetryEligibility } from '../domain/retryPolicy';
import { listTaskOverview } from '../domain/taskOverview';
import { addDaysYmd, zonedWallToMs } from '../domain/timeResolution';
import {
  STALE_AFTER_MS,
  compactAge,
  describeCompletionDay,
  describeDay,
  findDuplicateBriefingSchedules,
  formatStamp,
  summarizeCalendar,
  triageEmail,
  ymdInZone,
  type CalendarReadResult,
  type CalendarSummary,
  type DuplicateScheduleGroup,
  type EmailCategory,
  type MailInput,
  type TriagedEmail,
} from '../domain/briefingTriage';

export type BriefingReadResult = { ok: true; data: any } | { ok: false; reason: string };
/** A read-only connector call. Implementations decide how permission and health are checked. */
export type BriefingReader = (toolName: 'gmail_search' | 'calendar_list_events', args: Record<string, unknown>) => Promise<BriefingReadResult>;

/** Mail look-back: long enough to carry yesterday's unresolved items forward, short enough to stay bounded. */
const MAIL_LOOKBACK_DAYS = 7;
const CALENDAR_WINDOW_DAYS = 7;
const CALENDAR_MAX_RESULTS = 25;
/** At most this many mail searches run at once; each already fans out a few metadata reads. */
const MAIL_SEARCH_CONCURRENCY = 2;

const SIGNAL_TERMS = 'expires OR expiring OR expiry OR deadline OR "last day" OR "ends today" OR "ends tomorrow" OR payment OR invoice OR receipt OR balance OR statement OR "failed login" OR "sign-in" OR "security alert" OR booking OR reservation OR appointment OR reminder OR confirm OR begins OR starts';

interface MailQuery { id: 'primary' | 'signals' | 'flagged' | 'sent'; query: string; maxResults: number }

function mailQueries(): MailQuery[] {
  const win = `newer_than:${MAIL_LOOKBACK_DAYS}d`;
  return [
    { id: 'primary', query: `in:inbox ${win} -category:promotions -category:social -category:forums`, maxResults: 30 },
    // Promotions are searched too, but only for messages that state a deadline, money or security term.
    { id: 'signals', query: `in:inbox ${win} (${SIGNAL_TERMS})`, maxResults: 30 },
    { id: 'flagged', query: `in:inbox newer_than:14d (is:starred OR is:important)`, maxResults: 20 },
    // What the owner already answered, so a replied-to thread is not carried forward as unresolved.
    { id: 'sent', query: `in:sent ${win}`, maxResults: 20 },
  ];
}

export interface DailyBriefingOptions {
  nowMs: number;
  timeZone: string;
  read: BriefingReader;
  /** The attempt producing this briefing, so it never lists itself as open work. */
  excludeAttemptId?: string;
  /** Plain lines describing which services are connected (shown only when something is unavailable). */
  serviceLines?: string[];
}

/* ── Model ───────────────────────────────────────────────────────────── */

export interface BriefingItem {
  /** Higher is more urgent; used to rank the top three. */
  score: number;
  title: string;
  /** A fact, as the source recorded it. */
  fact: string;
  /** Pandesh's own advice — always rendered as a suggestion. */
  suggestion: string;
  /** Where the fact came from, with the id a tool can act on. */
  source: string;
}

export interface EmailBlock {
  status: 'ok' | 'partial' | 'unavailable';
  reason: string | null;
  surfaced: TriagedEmail[];
  canWait: TriagedEmail[];
  suppressed: { promotion: number; lowSignal: number; replied: number };
  coverage: string;
}

export interface DailyBriefing {
  generatedAtMs: number;
  timeZone: string;
  priorities: BriefingItem[];
  calendar: CalendarSummary;
  email: EmailBlock;
  decisions: BriefingItem[];
  canWait: string[];
  housekeeping: string[];
  duplicateSchedules: DuplicateScheduleGroup[];
  nextAction: { text: string; basis: string };
}

/* ── Mail ────────────────────────────────────────────────────────────── */

function toMailInput(raw: any): MailInput {
  return {
    id: String(raw?.id ?? ''),
    threadId: String(raw?.threadId ?? raw?.id ?? ''),
    subject: String(raw?.subject ?? '(no subject)'),
    from: String(raw?.from ?? ''),
    snippet: String(raw?.snippet ?? ''),
    receivedAt: typeof raw?.receivedAt === 'string' ? raw.receivedAt : null,
    labels: Array.isArray(raw?.labels) ? raw.labels.map(String) : [],
  };
}

/** Run `tasks` with at most `limit` in flight, keeping order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

const CATEGORY_RANK: Record<EmailCategory, number> = { deadline: 0, security: 1, finance: 2, reply: 3, commitment: 4, fyi: 5 };

export function triageMailReads(
  reads: Array<{ query: MailQuery; result: BriefingReadResult }>,
  nowMs: number,
  timeZone: string,
): EmailBlock {
  const failed = reads.filter((r) => !r.result.ok);
  if (failed.length === reads.length) {
    const reason = (failed[0].result as { reason: string }).reason;
    return { status: 'unavailable', reason, surfaced: [], canWait: [], suppressed: { promotion: 0, lowSignal: 0, replied: 0 }, coverage: `Email could not be read (${reason}). That does not mean there is nothing important.` };
  }

  const sentByThread = new Map<string, number>();
  const candidates = new Map<string, MailInput>();
  let read = 0;
  const notes: string[] = [];
  for (const { query, result } of reads) {
    if (!result.ok) { notes.push(`the "${query.id}" search failed (${result.reason})`); continue; }
    const rows: any[] = Array.isArray(result.data?.results) ? result.data.results : [];
    const counts = result.data?.counts ?? {};
    read += rows.length;
    if (query.id === 'sent') {
      for (const row of rows) {
        const ms = typeof row.receivedAt === 'string' ? Date.parse(row.receivedAt) : Number.NaN;
        const thread = String(row.threadId ?? '');
        if (thread && Number.isFinite(ms)) sentByThread.set(thread, Math.max(sentByThread.get(thread) ?? 0, ms));
      }
      continue;
    }
    for (const row of rows) { const mail = toMailInput(row); if (mail.id && !candidates.has(mail.id)) candidates.set(mail.id, mail); }
    const matched = typeof counts.matched === 'number' ? counts.matched : rows.length;
    if (result.data?.truncated || matched > rows.length || counts.failedLookups) {
      notes.push(`"${query.id}" matched ${counts.matchedIsExact === false ? 'about ' : ''}${matched} but ${rows.length} were read${counts.failedLookups ? ` (${counts.failedLookups} failed to load)` : ''}`);
    }
  }

  const best = new Map<string, TriagedEmail>();
  const canWait = new Map<string, TriagedEmail>();
  const suppressed = { promotion: 0, lowSignal: 0, replied: 0 };
  for (const mail of candidates.values()) {
    const verdict = triageEmail(mail, { nowMs, timeZone, sentByThread });
    if (verdict.kind === 'suppressed') {
      if (verdict.reason === 'promotion') suppressed.promotion++;
      else if (verdict.reason === 'replied') suppressed.replied++;
      else if (verdict.reason === 'low_signal') suppressed.lowSignal++;
      continue;
    }
    const bucket = verdict.kind === 'surface' ? best : canWait;
    const existing = bucket.get(verdict.email.threadId);
    if (!existing || verdict.email.score > existing.score) bucket.set(verdict.email.threadId, verdict.email);
  }
  // A thread that surfaces must not also appear under "can wait".
  for (const thread of best.keys()) canWait.delete(thread);
  const byUrgency = (a: TriagedEmail, b: TriagedEmail) => b.score - a.score || CATEGORY_RANK[a.category] - CATEGORY_RANK[b.category] || Date.parse(b.receivedAt ?? '') - Date.parse(a.receivedAt ?? '');

  const status = notes.length ? 'partial' : 'ok';
  const coverage = `Read ${read} messages across ${reads.length} searches (inbox, last ${MAIL_LOOKBACK_DAYS} days, plus starred/important and recently sent)`
    + `${notes.length ? `; coverage is partial: ${notes.join('; ')}` : '; each search was read in full'}.`;
  return {
    status,
    reason: notes.length ? notes.join('; ') : null,
    surfaced: [...best.values()].sort(byUrgency),
    canWait: [...canWait.values()].sort(byUrgency),
    suppressed,
    coverage,
  };
}

/* ── Core state ──────────────────────────────────────────────────────── */

interface CoreState {
  priorities: BriefingItem[];
  decisions: BriefingItem[];
  canWait: string[];
  housekeeping: string[];
}

function collectCoreState(db: CoreDatabase, opts: DailyBriefingOptions): CoreState {
  const { nowMs, timeZone } = opts;
  const state: CoreState = { priorities: [], decisions: [], canWait: [], housekeeping: [] };
  const todayYmd = ymdInZone(nowMs, timeZone);
  const endOfTomorrow = zonedWallToMs(addDaysYmd(todayYmd, 2), '00:00', timeZone);
  const endOfToday = zonedWallToMs(addDaysYmd(todayYmd, 1), '00:00', timeZone);

  /* Reminders. A reminder that already fired is housekeeping; one that never alerted is due now. */
  const firedStale: string[] = [];
  for (const reminder of listReminders(db, { status: 'open', limit: 100 })) {
    const dueMs = Date.parse(reminder.dueAt);
    if (dueMs >= endOfTomorrow) continue;
    const source = `reminder ${reminder.id}`;
    if (reminder.overdue && reminder.notifiedAt) {
      firedStale.push(`"${reminder.title}" (was due ${formatStamp(reminder.dueAt, timeZone)}) [${source}]`);
    } else if (reminder.overdue) {
      state.priorities.push({ score: 90, title: `Reminder due now: ${reminder.title}`, fact: `Due ${formatStamp(reminder.dueAt, timeZone)}; no alert fired because the app was not running.`, suggestion: 'Do it now, or reschedule it', source });
    } else if (dueMs < endOfToday) {
      state.priorities.push({ score: 60, title: `Reminder today: ${reminder.title}`, fact: `Due ${formatStamp(reminder.dueAt, timeZone)}.`, suggestion: 'Plan time for it', source });
    } else {
      state.canWait.push(`Reminder tomorrow: ${reminder.title} (${formatStamp(reminder.dueAt, timeZone)}) [${source}]`);
    }
  }
  if (firedStale.length) {
    state.housekeeping.push(`${firedStale.length} reminder${firedStale.length === 1 ? '' : 's'} already fired and still open: ${firedStale.slice(0, 3).join('; ')}${firedStale.length > 3 ? '; …' : ''}. Suggested: say "dismiss" (marks it done) or "reschedule to <time>" for each — nothing has been changed.`);
  }

  /* Commitments: promises the owner made. Never created or closed here. */
  for (const commitment of listCommitments(db, { status: 'open', limit: 50 })) {
    const view = toCommitmentView(commitment, nowMs);
    const dueMs = commitment.dueAt ? Date.parse(commitment.dueAt) : Number.NaN;
    const source = `commitment ${commitment.id}`;
    const base = { title: `Promise: ${describeCommitment(commitment)}`, source };
    const condition = commitment.condition === 'no_reply' ? 'waiting for a reply' : 'only you can close this';
    if (view.overdue) {
      state.priorities.push({ ...base, score: 88, fact: `Overdue since ${formatStamp(commitment.dueAt!, timeZone)}; ${condition}.`, suggestion: 'Follow up now, or tell me it is handled and I will close it' });
    } else if (Number.isFinite(dueMs) && dueMs < endOfTomorrow) {
      state.priorities.push({ ...base, score: dueMs < endOfToday ? 72 : 58, fact: `Due ${formatStamp(commitment.dueAt!, timeZone)}; ${condition}.`, suggestion: 'Make time for it before then' });
    } else {
      state.decisions.push({ ...base, score: 30, fact: `${commitment.dueAt ? `Due ${formatStamp(commitment.dueAt, timeZone)}; ` : 'No due date; '}${condition}.`, suggestion: 'Tell me if it is done and I will close it' });
    }
  }

  /* Approvals: current ones are blockers; old ones are a compact housekeeping line. */
  const staleApprovals: Array<{ ageMs: number; search: boolean; ended: boolean; label: string }> = [];
  for (const approval of listPendingApprovals(db)) {
    const ctx = approvalContext(db, approval);
    if (opts.excludeAttemptId && approval.attemptId === opts.excludeAttemptId) continue;
    const ageMs = nowMs - Date.parse(approval.requestedAt);
    const toolName = String((approval.summary as any)?.toolName ?? (approval.presentation as any)?.toolName ?? '');
    const ended = ['completed', 'failed', 'cancelled'].includes(String(ctx.attemptStatus));
    const label = `${describeApprovalIntent(approval)}${ctx.conversationTitle ? ` in "${briefTitle(ctx.conversationTitle, 40)}"` : ''}`;
    if (ageMs >= STALE_AFTER_MS || ended) {
      staleApprovals.push({ ageMs, search: toolName === 'request_search_permission', ended, label });
      continue;
    }
    const text = describeApprovalCardText(approval) || label;
    state.decisions.push({ score: 62, title: `Approval needed: ${describeApprovalIntent(approval)}`, fact: `${briefTitle(text, 140)} Asked ${compactAge(Date.parse(approval.requestedAt), nowMs)} ago${ctx.conversationTitle ? ` in "${briefTitle(ctx.conversationTitle, 40)}"` : ''}.`, suggestion: 'Review the card and approve or reject it', source: `approval ${approval.id}` });
  }
  if (staleApprovals.length) {
    const oldest = Math.max(...staleApprovals.map((a) => a.ageMs));
    const searches = staleApprovals.filter((a) => a.search).length;
    const ended = staleApprovals.filter((a) => a.ended).length;
    state.housekeeping.push(`${staleApprovals.length} older approval${staleApprovals.length === 1 ? '' : 's'} still pending (oldest ${compactAge(nowMs - oldest, nowMs)}${searches ? `; ${searches} ${searches === 1 ? 'is a read-only folder search permission' : 'are read-only folder search permissions'}` : ''}${ended ? `; ${ended} belong${ended === 1 ? 's' : ''} to a task that already ended` : ''}). Suggested: Review them in the Approvals list when convenient — I have not approved, rejected or expired any.`);
  }

  /* Tasks. */
  const staleTasks: string[] = [];
  const recentDone: string[] = [];
  for (const task of listTaskOverview(db, 50, nowMs)) {
    if (task.attemptId === opts.excludeAttemptId || /^M38 governed capability dispatch anchor/.test(task.title)) continue;
    const at = Date.parse(task.lastEventAt ?? task.completedAt ?? task.createdAt);
    const age = nowMs - at;
    const source = `task ${task.attemptId}`;
    if (task.status === 'completed') {
      if (age <= 36 * 3_600_000 && recentDone.length < 2) recentDone.push(`${describeCompletionDay(task.completedAt ?? task.createdAt, nowMs, timeZone)}: ${briefTitle(task.title, 60)} [${source}]`);
      continue;
    }
    if (task.status === 'cancelled' || task.status === 'waiting_for_approval' || task.live) continue;
    const resume = task.status !== 'failed' ? false : (() => { try { return attemptRetryEligibility(db, task.attemptId).eligible; } catch { return false; } })();
    const verb = task.status === 'failed' ? 'Failed' : 'Interrupted';
    if (age < STALE_AFTER_MS) {
      state.decisions.push({ score: task.status === 'failed' ? 55 : 50, title: `${verb} task: ${briefTitle(task.title, 70)}`, fact: `${verb} ${compactAge(at, nowMs)} ago${task.failureReason ? ` — ${task.failureReason.slice(0, 100)}` : ''}.`, suggestion: resume ? 'Resume it, or dismiss it' : 'Open it to see how far it got, or dismiss it', source });
    } else if (task.status !== 'failed') {
      staleTasks.push(`"${briefTitle(task.title, 50)}" from ${describeDay(ymdInZone(at, timeZone), nowMs, timeZone)} [${source}]`);
    }
  }
  if (staleTasks.length) {
    state.housekeeping.push(`${staleTasks.length} interrupted task${staleTasks.length === 1 ? '' : 's'} from earlier: ${staleTasks.slice(0, 3).join('; ')}${staleTasks.length > 3 ? '; …' : ''}. Suggested: Resume or Dismiss from the Tasks screen — I have not touched them.`);
  }
  state.canWait.push(...recentDone);
  return state;
}

/* ── Assembly ────────────────────────────────────────────────────────── */

function emailItem(email: TriagedEmail, timeZone: string): BriefingItem {
  const when = email.receivedAt ? formatStamp(email.receivedAt, timeZone) : 'unknown time';
  const from = email.from.replace(/\s*<.*>\s*$/, '').replace(/^"|"$/g, '').slice(0, 40) || 'unknown sender';
  return {
    score: email.score,
    title: email.subject.slice(0, 100),
    fact: `${email.why} From ${from}, received ${when}${email.carriedOver ? ' (carried over from an earlier day, still in your inbox with no reply from you)' : ''}.`,
    suggestion: email.action,
    source: `Gmail ${email.id}`,
  };
}

export async function buildDailyBriefing(db: CoreDatabase, opts: DailyBriefingOptions): Promise<DailyBriefing> {
  const { nowMs, timeZone } = opts;
  const todayYmd = ymdInZone(nowMs, timeZone);

  // Calendar and mail are independent read-only reads: start them together; mail searches are pooled.
  const [calendarRead, mailReads] = await Promise.all([
    opts.read('calendar_list_events', { from: `${todayYmd}T00:00`, to: `${addDaysYmd(todayYmd, CALENDAR_WINDOW_DAYS)}T00:00`, maxResults: CALENDAR_MAX_RESULTS }),
    pool(mailQueries(), MAIL_SEARCH_CONCURRENCY, async (query) => ({ query, result: await opts.read('gmail_search', { query: query.query, maxResults: query.maxResults }) })),
  ]);

  const calendar = summarizeCalendar(calendarRead as CalendarReadResult, nowMs, timeZone, { maxResults: CALENDAR_MAX_RESULTS });
  const email = triageMailReads(mailReads, nowMs, timeZone);
  const core = collectCoreState(db, opts);
  const duplicateSchedules = findDuplicateBriefingSchedules(listScheduledTasks(db));

  const priorities: BriefingItem[] = [...core.priorities];
  for (const item of email.surfaced) priorities.push(emailItem(item, timeZone));
  for (const [a, b] of calendar.conflicts) {
    priorities.push({ score: 76, title: `Calendar overlap today: ${a.title} / ${b.title}`, fact: `${a.label} and ${b.label} overlap.`, suggestion: 'Move or decline one of them', source: `Calendar ${a.id ?? ''} + ${b.id ?? ''}`.trim() });
  }
  const nextToday = calendar.today.find((e) => !e.allDay && e.endMs > nowMs);
  if (nextToday) {
    const started = nextToday.startMs <= nowMs;
    priorities.push({ score: started ? 66 : 64, title: `${started ? 'In progress' : 'Next today'}: ${nextToday.title}`, fact: `${nextToday.label} (${calendar.timeZone})${nextToday.location ? ` at ${nextToday.location}` : ''}.`, suggestion: 'Be ready for it', source: `Calendar ${nextToday.id ?? ''}`.trim() });
  }
  priorities.sort((a, b) => b.score - a.score);
  const top = priorities.slice(0, 3);
  const shown = new Set(top.map((i) => i.source));

  const decisions = [...core.decisions, ...priorities.slice(3).filter((i) => !i.source.startsWith('Gmail') && !i.source.startsWith('Calendar'))]
    .filter((i) => !shown.has(i.source)).sort((a, b) => b.score - a.score);

  const canWait = [
    ...email.canWait.slice(0, 4).map((m) => `${m.subject.slice(0, 70)} — ${m.why} [Gmail ${m.id}]`),
    ...core.canWait,
  ];
  if (email.suppressed.promotion) canWait.push(`${email.suppressed.promotion} promotional email${email.suppressed.promotion === 1 ? '' : 's'} hidden — none states a deadline close enough to matter.`);

  const housekeeping = [...core.housekeeping];
  for (const group of duplicateSchedules) {
    housekeeping.push(`${group.redundant.length + 1} daily briefings are scheduled for ${group.dailyTime} (${group.timezone}). Keep "${group.canonical.title}" [schedule ${group.canonical.id}] — ${group.reason}. Redundant: ${group.redundant.map((t) => `"${t.title}" [schedule ${t.id}]`).join(', ')}. Suggested: say "consolidate" and I will switch off the redundant one (it is only disabled, never deleted). Nothing has been changed.`);
  }

  const lead = top[0];
  const nextAction = lead
    ? { text: `${lead.suggestion}: ${lead.title}.`, basis: `${lead.fact} [${lead.source}]` }
    : email.status === 'unavailable' && calendar.status === 'unavailable'
      ? { text: 'Reconnect Gmail and Google Calendar so I can check what needs you.', basis: 'Neither service could be read.' }
      : { text: 'Nothing urgent found. Use the time for your own priorities.', basis: 'No deadline, security, money, reply, reminder or approval needs you today in the sources I could read.' };

  return { generatedAtMs: nowMs, timeZone, priorities: top, calendar, email, decisions, canWait, housekeeping, duplicateSchedules, nextAction };
}

/* ── Rendering ───────────────────────────────────────────────────────── */

const GROUPS: Array<{ heading: string; categories: EmailCategory[] }> = [
  { heading: 'Decide before a deadline', categories: ['deadline'] },
  { heading: 'Verify', categories: ['security', 'finance'] },
  { heading: 'Awaiting your reply', categories: ['reply'] },
  { heading: 'Check the details', categories: ['commitment'] },
];

export function renderDailyBriefing(b: DailyBriefing, options: { detail?: boolean } = {}): string {
  const detail = options.detail === true;
  const cap = (compact: number) => (detail ? 25 : compact);
  const tz = b.timeZone;
  const lines: string[] = [];
  lines.push(`**Daily briefing — ${formatStamp(b.generatedAtMs, tz)} (${tz})**`);
  lines.push('_Facts carry a [source]. Lines starting "Suggested:" are my advice, not facts._', '');

  lines.push('**Top 3 priorities**');
  if (!b.priorities.length) lines.push('- Nothing urgent found in the sources I could read.');
  b.priorities.forEach((item, i) => {
    lines.push(`${i + 1}. **${item.title}** — ${item.fact} [${item.source}]`, `   Suggested: ${item.suggestion}.`);
  });

  lines.push('', '**Calendar**');
  if (b.calendar.status === 'unavailable') {
    lines.push(`- Not checked: ${b.calendar.reason}. I cannot say whether you have events.`);
  } else {
    lines.push(`- ${b.calendar.headline}`);
    for (const e of b.calendar.today.slice(0, cap(6))) lines.push(`  - ${e.label} ${e.title}${e.location ? ` @ ${e.location}` : ''}${e.id ? ` [Calendar ${e.id}]` : ''}`);
    for (const [x, y] of b.calendar.conflicts) lines.push(`  - Conflict: "${x.title}" overlaps "${y.title}"`);
    if (b.calendar.status === 'partial') lines.push(`- Coverage is partial: ${b.calendar.reason}.`);
    if (detail && b.calendar.tomorrow.length) {
      lines.push('- Tomorrow:');
      for (const e of b.calendar.tomorrow.slice(0, 10)) lines.push(`  - ${e.label} ${e.title}`);
    }
  }

  lines.push('', '**Important email**');
  if (b.email.status === 'unavailable') {
    lines.push(`- Not checked: ${b.email.reason}. I cannot say whether anything important is waiting.`);
  } else {
    const shownInTop = new Set(b.priorities.map((p) => p.source));
    let any = false;
    for (const group of GROUPS) {
      const items = b.email.surfaced.filter((m) => group.categories.includes(m.category) && !shownInTop.has(`Gmail ${m.id}`));
      if (!items.length) continue;
      any = true;
      lines.push(`- ${group.heading}:`);
      for (const m of items.slice(0, cap(3))) lines.push(`  - ${m.subject.slice(0, 80)} — ${m.why} (${formatStamp(m.receivedAt ?? b.generatedAtMs, tz)}) [Gmail ${m.id}]`);
      if (items.length > cap(3)) lines.push(`  - …and ${items.length - cap(3)} more (ask for details)`);
    }
    if (!any) lines.push(b.email.surfaced.length ? '- Everything important is in the top priorities above.' : '- Nothing in your inbox needs you today.');
  }

  lines.push('', '**Pending decisions**');
  if (!b.decisions.length) lines.push('- None. No current approval, promise or blocked task is waiting on you.');
  for (const d of b.decisions.slice(0, cap(5))) lines.push(`- ${d.title} — ${d.fact} [${d.source}]${detail ? `\n  Suggested: ${d.suggestion}.` : ''}`);
  if (b.decisions.length > cap(5)) lines.push(`- …and ${b.decisions.length - cap(5)} more (ask for details)`);

  lines.push('', '**Can wait**');
  if (!b.canWait.length) lines.push('- Nothing.');
  for (const c of b.canWait.slice(0, cap(5))) lines.push(`- ${c}`);
  if (b.canWait.length > cap(5)) lines.push(`- …and ${b.canWait.length - cap(5)} more (ask for details)`);

  if (b.housekeeping.length) {
    lines.push('', '**Housekeeping** _(old items grouped here; nothing was changed)_');
    for (const h of b.housekeeping) lines.push(`- ${h}`);
  }

  lines.push('', '**Suggested next action**', `- Suggested: ${b.nextAction.text} _Based on: ${b.nextAction.basis}_`);
  lines.push('', `_Coverage — Email: ${b.email.coverage} Calendar: ${b.calendar.status === 'unavailable' ? 'not read.' : b.calendar.status === 'partial' ? `partial (${b.calendar.reason}).` : `read in full for the next ${CALENDAR_WINDOW_DAYS} days.`}${detail ? '' : ' Ask for "details" for the full lists.'}_`);
  return lines.join('\n');
}
