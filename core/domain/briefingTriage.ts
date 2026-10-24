/**
 * Briefing triage — deciding what matters today, as pure functions.
 *
 * The daily briefing used to list the newest unread mail. Recency is not
 * importance: a week-old payment confirmation or a "failed login" warning
 * matters more than six fresh promotions. This module ranks by *why something
 * needs the owner*, using only what a message actually says and which labels
 * Gmail itself put on it. Nothing here performs I/O, calls a model, or writes
 * state, so a briefing run twice gives the same answer and creates nothing.
 *
 * Rules it keeps:
 *  - Routine marketing is suppressed unless it carries a real deadline that is
 *    close; being unread or recent never makes a message important.
 *  - A message is "resolved" only when the evidence says so (the owner sent a
 *    later message in the thread, or it left the inbox). Unknown stays unknown.
 *  - Every date is read and written in the owner's time zone, so "today" rolls
 *    over at local midnight, not at UTC midnight.
 */
import { addDaysYmd, zonedParts } from './timeResolution';
import type { ScheduledTaskRecord } from './scheduledTasks';

/* ── Dates in the owner's zone ───────────────────────────────────────── */

/** `YYYY-MM-DD` of an instant in `timeZone`. */
export function ymdInZone(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Whole days from `fromYmd` to `toYmd` (negative when `toYmd` is earlier). */
export function daysBetweenYmd(fromYmd: string, toYmd: string): number {
  return Math.round((Date.parse(`${toYmd}T00:00:00Z`) - Date.parse(`${fromYmd}T00:00:00Z`)) / 86_400_000);
}

/** "today", "yesterday", "Mon 12 Oct" — a day relative to now, in the owner's zone. */
export function describeDay(ymd: string, nowMs: number, timeZone: string): string {
  const diff = daysBetweenYmd(ymdInZone(nowMs, timeZone), ymd);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(`${ymd}T00:00:00Z`));
}

/** "Thu 22 Oct, 18:04" in `timeZone`. */
export function formatStamp(iso: string | number, timeZone: string): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return String(iso);
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(ms));
}

/** "2d", "5h" — compact age. */
export function compactAge(fromMs: number, nowMs: number): string {
  const hours = Math.max(0, Math.round((nowMs - fromMs) / 3_600_000));
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/* ── Email ───────────────────────────────────────────────────────────── */

export type EmailCategory = 'deadline' | 'security' | 'finance' | 'commitment' | 'reply' | 'fyi';

export interface MailInput {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  snippet: string;
  /** When Gmail received it, ISO-8601 UTC. */
  receivedAt: string | null;
  /** Gmail label ids (INBOX, UNREAD, STARRED, IMPORTANT, CATEGORY_PROMOTIONS…). Empty when unknown. */
  labels: string[];
}

export interface TriagedEmail extends MailInput {
  category: EmailCategory;
  /** 0–100. Higher is more urgent. */
  score: number;
  /** One plain sentence: why this needs the owner. */
  why: string;
  /** What to do about it, as a plain verb phrase. */
  action: string;
  /** The date the message is about (`YYYY-MM-DD`), when it states one. */
  dateYmd: string | null;
  /** Days from today to `dateYmd` (negative = already passed), when there is one. */
  daysUntil: number | null;
  promotional: boolean;
  unread: boolean;
  /** True when the message arrived before today (local) and is still unresolved. */
  carriedOver: boolean;
}

export type MailVerdict =
  | { kind: 'surface'; email: TriagedEmail }
  | { kind: 'can_wait'; email: TriagedEmail }
  | { kind: 'suppressed'; reason: 'promotion' | 'low_signal' | 'replied' | 'archived' };

export const SURFACE_THRESHOLD = 50;
const CAN_WAIT_THRESHOLD = 30;

const MONTHS = 'jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?';
const MONTH_INDEX: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS})\\b\\.?(?:,?\\s+(\\d{4}))?`, 'gi');
const MONTH_DAY = new RegExp(`\\b(${MONTHS})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi');
const DATE_CUE = /\b(expir\w*|deadline|ends?|ending|closes?|closing|due|last day|final|before|until|by|begins?|beginning|starts?|starting|launch\w*|register|rsvp|sprint|valid)\b/i;
const RELATIVE_CUE = /\b(expir\w*|ends?|ending|closes?|closing|due|last (?:day|chance)|final)\b[^.!?\n]{0,40}\b(today|tonight|tomorrow)\b|\b(today|tonight|tomorrow)\b[^.!?\n]{0,40}\b(expir\w*|ends?|ending|closes?|closing|due|deadline)\b/i;

function pushYmd(out: string[], year: number, month: number, day: number): void {
  if (month < 1 || month > 12 || day < 1 || day > 31) return;
  const ymd = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Reject impossible dates (31 Feb) instead of letting them roll into March.
  if (new Date(`${ymd}T00:00:00Z`).toISOString().slice(0, 10) === ymd) out.push(ymd);
}

/**
 * Dates a message states ("expires October 23", "23 Oct"), as `YYYY-MM-DD`.
 * A year-less date belongs to the year it was sent in, rolling forward only if
 * that would put it well before the send date. Relative words ("ends today")
 * are anchored to the day the message arrived, never to the day it is read.
 */
export function extractDates(text: string, receivedYmd: string): string[] {
  const out: string[] = [];
  const baseYear = Number(receivedYmd.slice(0, 4));
  const place = (month: number, day: number, explicitYear: string | undefined) => {
    if (explicitYear) { pushYmd(out, Number(explicitYear), month, day); return; }
    const candidate: string[] = [];
    pushYmd(candidate, baseYear, month, day);
    if (candidate[0] && daysBetweenYmd(receivedYmd, candidate[0]) < -30) { candidate.length = 0; pushYmd(candidate, baseYear + 1, month, day); }
    if (candidate[0]) out.push(candidate[0]);
  };
  for (const m of text.matchAll(DAY_MONTH)) place(MONTH_INDEX[m[2].slice(0, 3).toLowerCase()], Number(m[1]), m[3]);
  for (const m of text.matchAll(MONTH_DAY)) place(MONTH_INDEX[m[1].slice(0, 3).toLowerCase()], Number(m[2]), m[3]);
  const rel = RELATIVE_CUE.exec(text);
  if (rel) {
    const word = (rel[2] ?? rel[3] ?? '').toLowerCase();
    out.push(word === 'tomorrow' ? addDaysYmd(receivedYmd, 1) : receivedYmd);
  }
  return [...new Set(out)];
}

const SECURITY = /\b(failed[\s-](?:log-?in|sign-?in|attempts?)|(?:log-?in|sign-?in)[\s-](?:attempts?|failed|blocked)|unusual (?:sign-?in|activity|log-?in)|suspicious (?:sign-?in|activity|log-?in)|security (?:alert|warning|notice)|new (?:sign-?in|device)|password (?:was )?(?:changed|reset)|account (?:locked|compromised|suspended)|blocked (?:sign-?in|log-?in))\b/i;
const FINANCE = /\b(payment (?:confirmation|confirmed|received|failed|due|declined|reminder)|invoice|receipt|statement|account balance|balance (?:notice|alert|update)|low balance|transaction|debited|credited|direct debit|refund|overdue|amount due|order confirmation|your order|charged)\b/i;
const COMMITMENT = /\b(booking|reservation|appointment|table for|itinerary|check-?in|flight|your (?:visit|stay|ticket)|reminder for your|confirmed for)\b/i;
const ASKS = /\b(please (?:reply|respond|confirm|review|let me know|advise)|let me know|could you|can you|would you|waiting (?:for|on) (?:your|you)|your (?:response|reply|decision|approval)|rsvp|action required|need(?:s)? your)\b|\?\s*$/i;
const BULK_SENDER = /(no-?reply|do-?not-?reply|newsletter|notifications?@|mailer|marketing|promo|offers?@|deals?@|news@|updates?@|info@|hello@|team@|support@|billing@|alerts?@)/i;
const PROMO_SUBJECT = /(\d+\s?%\s?off|\bsale\b|\bdeals?\b|discount|free shipping|limited time|webinar|newsletter|\boffer\b|coupon|exclusive|save \d|black friday|don'?t miss|last chance|bundle|new arrivals|% off)/i;
const PROMO_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_FORUMS']);

function senderName(from: string): string {
  const name = from.replace(/\s*<.*>\s*$/, '').replace(/^"|"$/g, '').trim();
  return (name || from).slice(0, 40);
}

export interface TriageContext {
  nowMs: number;
  timeZone: string;
  /** Thread id → ISO instant of the owner's latest sent message in that thread. */
  sentByThread?: Map<string, number>;
}

/** Decide what one message is worth. Pure. */
export function triageEmail(mail: MailInput, ctx: TriageContext): MailVerdict {
  const todayYmd = ymdInZone(ctx.nowMs, ctx.timeZone);
  const receivedMs = mail.receivedAt ? Date.parse(mail.receivedAt) : Number.NaN;
  const receivedYmd = Number.isFinite(receivedMs) ? ymdInZone(receivedMs, ctx.timeZone) : todayYmd;

  const labels = new Set(mail.labels);
  if (labels.size > 0 && !labels.has('INBOX')) return { kind: 'suppressed', reason: 'archived' };
  const repliedAt = ctx.sentByThread?.get(mail.threadId);
  if (repliedAt !== undefined && (!Number.isFinite(receivedMs) || repliedAt >= receivedMs)) return { kind: 'suppressed', reason: 'replied' };

  const text = `${mail.subject}\n${mail.snippet}`;
  const sender = senderName(mail.from);
  const unread = labels.has('UNREAD');
  const promotional = [...labels].some((l) => PROMO_LABELS.has(l)) || (PROMO_SUBJECT.test(mail.subject) && BULK_SENDER.test(mail.from));
  const bonus = (labels.has('STARRED') ? 15 : 0) + (labels.has('IMPORTANT') ? 5 : 0) + (unread ? 3 : 0);
  const carriedOver = daysBetweenYmd(receivedYmd, todayYmd) > 0;

  // A date the message is *about*, only when worded as something that ends, starts or is due.
  const dates = DATE_CUE.test(text) || RELATIVE_CUE.test(text) ? extractDates(text, receivedYmd) : [];
  const upcoming = dates.map((d) => ({ d, n: daysBetweenYmd(todayYmd, d) })).filter((x) => x.n >= 0).sort((a, b) => a.n - b.n)[0];
  const dateYmd = upcoming?.d ?? null;
  const daysUntil = upcoming?.n ?? null;

  const make = (category: EmailCategory, score: number, why: string, action: string): TriagedEmail => ({
    ...mail, category, score: Math.min(100, Math.max(0, score + bonus)), why, action, dateYmd, daysUntil, promotional, unread, carriedOver,
  });
  const sort = (email: TriagedEmail): MailVerdict =>
    email.score >= SURFACE_THRESHOLD ? { kind: 'surface', email }
      : email.score >= CAN_WAIT_THRESHOLD ? { kind: 'can_wait', email }
        : { kind: 'suppressed', reason: 'low_signal' };

  // 1. A real, near deadline — even from a promotional sender.
  if (upcoming && upcoming.n <= 1) {
    const when = describeDay(upcoming.d, ctx.nowMs, ctx.timeZone);
    const verb = /\b(begins?|beginning|starts?|starting|launch\w*)\b/i.test(text) && !/\b(expir\w*|deadline|ends?|closes?)\b/i.test(text) ? 'starts' : 'ends';
    return sort(make('deadline', (upcoming.n === 0 ? 95 : 85) - (promotional ? 20 : 0),
      `${verb === 'starts' ? 'Starts' : 'Ends or is due'} ${when}${promotional ? ' (promotional sender)' : ''}.`,
      verb === 'starts' ? `Decide whether you are taking part before it starts ${when}` : `Decide before it lapses ${when}`));
  }

  // 2. Marketing with no near deadline is noise, whatever its date or read state.
  if (promotional) {
    if (upcoming && upcoming.n <= 3) return sort(make('deadline', 45, `Promotional offer that ends ${describeDay(upcoming.d, ctx.nowMs, ctx.timeZone)}.`, 'Only act if you actually want it'));
    return { kind: 'suppressed', reason: 'promotion' };
  }

  if (SECURITY.test(text)) {
    return sort(make('security', 80, `Security notice from ${sender}.`, 'Confirm the activity was yours; if not, change the password and review sign-ins'));
  }
  if (FINANCE.test(text)) {
    return sort(make('finance', 65, `Money-related message from ${sender}.`, 'Verify it matches what you expect, using the provider\'s own site or app rather than links in the email'));
  }
  if (upcoming) {
    // A dated item beyond tomorrow: real, but not today's problem unless soon.
    const score = upcoming.n <= 3 ? 55 : upcoming.n <= 7 ? 40 : 20;
    return sort(make('deadline', score, `Mentions ${describeDay(upcoming.d, ctx.nowMs, ctx.timeZone)}.`, `Plan for ${describeDay(upcoming.d, ctx.nowMs, ctx.timeZone)}`));
  }
  if (COMMITMENT.test(text)) {
    return sort(make('commitment', 55, `Booking or appointment from ${sender}.`, 'Check the details and add it to your calendar if it is not there'));
  }
  if (!BULK_SENDER.test(mail.from) && ASKS.test(text)) {
    return sort(make('reply', 55, `${sender} appears to be waiting for an answer.`, 'Reply or decide'));
  }
  return sort(make('fyi', 25, `From ${sender}.`, 'Read when convenient'));
}

/* ── Calendar ────────────────────────────────────────────────────────── */

export interface CalendarEvent {
  id?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
}

export type CalendarReadResult =
  | { ok: true; data: { events?: CalendarEvent[]; timeZone?: string } }
  | { ok: false; reason: string };

export interface CalendarEntry extends CalendarEvent {
  startMs: number;
  endMs: number;
  /** "09:30–10:00" or "all day". */
  label: string;
}

export interface CalendarSummary {
  /**
   * `ok`: the read succeeded and covers the whole window. `partial`: it
   * succeeded but hit its result cap, so later events may be missing.
   * `unavailable`: the read failed or the service is not connected — this says
   * nothing about whether there are events.
   */
  status: 'ok' | 'partial' | 'unavailable';
  reason: string | null;
  timeZone: string;
  today: CalendarEntry[];
  tomorrow: CalendarEntry[];
  /** The first event that has not started yet (today or later in the window). */
  next: CalendarEntry | null;
  conflicts: Array<[CalendarEntry, CalendarEntry]>;
  /** One honest sentence about today. */
  headline: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function eventBounds(event: CalendarEvent, timeZone: string): { startMs: number; endMs: number; startYmd: string; endYmd: string } | null {
  if (!event.start) return null;
  if (event.allDay || DATE_ONLY.test(event.start)) {
    const startYmd = event.start.slice(0, 10);
    const endExclusive = event.end && DATE_ONLY.test(event.end) ? event.end : addDaysYmd(startYmd, 1);
    return { startMs: Date.parse(`${startYmd}T00:00:00Z`), endMs: Date.parse(`${endExclusive}T00:00:00Z`), startYmd, endYmd: addDaysYmd(endExclusive, -1) };
  }
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(event.start);
  const toMs = (iso: string) => hasOffset ? Date.parse(iso) : Date.parse(`${iso}Z`) - zoneOffset(Date.parse(`${iso}Z`), timeZone);
  const startMs = toMs(event.start);
  const endMs = event.end ? toMs(event.end) : startMs;
  if (!Number.isFinite(startMs)) return null;
  // A timed event ending exactly at midnight belongs to the day it started on.
  return { startMs, endMs, startYmd: ymdInZone(startMs, timeZone), endYmd: ymdInZone(Math.max(startMs, endMs - 1), timeZone) };
}

function zoneOffset(utcMs: number, timeZone: string): number {
  const p = zonedParts(utcMs, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

function hhmm(ms: number, timeZone: string): string {
  const p = zonedParts(ms, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * Turn one calendar read into an honest summary. "No events today" is only
 * ever said after a successful read; a failed read says it failed.
 */
export function summarizeCalendar(read: CalendarReadResult, nowMs: number, timeZone: string, options: { maxResults: number }): CalendarSummary {
  const empty = { today: [], tomorrow: [], next: null, conflicts: [] as Array<[CalendarEntry, CalendarEntry]> };
  if (!read.ok) {
    return { status: 'unavailable', reason: read.reason, timeZone, ...empty, headline: `Calendar could not be read (${read.reason}). That does not mean the day is empty.` };
  }
  const zone = read.data.timeZone || timeZone;
  const todayYmd = ymdInZone(nowMs, zone);
  const tomorrowYmd = addDaysYmd(todayYmd, 1);
  const raw = read.data.events ?? [];

  const entries: CalendarEntry[] = [];
  const spans = new Map<CalendarEntry, { startYmd: string; endYmd: string }>();
  for (const event of raw) {
    const b = eventBounds(event, zone);
    if (!b) continue;
    const entry: CalendarEntry = {
      ...event, startMs: b.startMs, endMs: b.endMs,
      label: event.allDay || DATE_ONLY.test(event.start) ? 'all day' : `${hhmm(b.startMs, zone)}–${hhmm(b.endMs, zone)}`,
    };
    entries.push(entry);
    spans.set(entry, b);
  }
  entries.sort((a, b) => a.startMs - b.startMs);
  const onDay = (ymd: string) => entries.filter((e) => { const s = spans.get(e)!; return s.startYmd <= ymd && s.endYmd >= ymd; });
  const today = onDay(todayYmd);
  const tomorrow = onDay(tomorrowYmd);
  // Not-yet-started (timed) or still-running/future all-day items; all-day items started earlier today are "today", not "next".
  const next = entries.find((e) => {
    const s = spans.get(e)!;
    return e.allDay || DATE_ONLY.test(e.start) ? s.startYmd > todayYmd : e.startMs > nowMs;
  }) ?? null;

  const timed = today.filter((e) => !(e.allDay || DATE_ONLY.test(e.start)));
  const conflicts: Array<[CalendarEntry, CalendarEntry]> = [];
  for (let i = 0; i < timed.length; i++) for (let j = i + 1; j < timed.length; j++) {
    if (timed[i].startMs < timed[j].endMs && timed[j].startMs < timed[i].endMs) conflicts.push([timed[i], timed[j]]);
  }

  const partial = raw.length >= options.maxResults;
  const nextText = next ? `Next: ${next.title} — ${describeDay(spans.get(next)!.startYmd, nowMs, zone)}${next.allDay ? ' (all day)' : ` ${hhmm(next.startMs, zone)}`}.` : 'No further events found in the window searched.';
  const headline = today.length === 0
    ? `No events scheduled today. ${nextText}`
    : `${today.length} event${today.length === 1 ? '' : 's'} today${conflicts.length ? `, ${conflicts.length} overlap${conflicts.length === 1 ? '' : 's'}` : ''}. ${nextText}`;
  return {
    status: partial ? 'partial' : 'ok',
    reason: partial ? `the calendar returned ${raw.length} events, which is the most it was asked for; later events may be missing` : null,
    timeZone: zone, today, tomorrow, next, conflicts, headline,
  };
}

/* ── Stale items ─────────────────────────────────────────────────────── */

/** Older than this, an unanswered approval or an unfinished task is history, not today's news. */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/** "Completed earlier today" is only true for the same local day. */
export function describeCompletionDay(completedAtIso: string, nowMs: number, timeZone: string): string {
  const ms = Date.parse(completedAtIso);
  if (!Number.isFinite(ms)) return 'Completed at an unknown time';
  const day = describeDay(ymdInZone(ms, timeZone), nowMs, timeZone);
  return day === 'today' ? 'Completed earlier today' : day === 'yesterday' ? 'Completed yesterday' : `Completed ${day}`;
}

/* ── Duplicate briefing schedules ────────────────────────────────────── */

export interface DuplicateScheduleGroup {
  /** Local wall time all of these fire at. */
  dailyTime: string;
  timezone: string;
  canonical: ScheduledTaskRecord;
  redundant: ScheduledTaskRecord[];
  /** Why this one is canonical, in one sentence. */
  reason: string;
}

const BRIEFING_WORDS = /\b(brief(?:ing)?|morning (?:summary|digest)|daily (?:summary|digest|agenda))\b/i;

export function isBriefingSchedule(task: ScheduledTaskRecord): boolean {
  return task.routine === 'daily_brief' || BRIEFING_WORDS.test(task.title) || BRIEFING_WORDS.test(task.instruction);
}

/**
 * Enabled daily briefing schedules that fire at the same local time.
 *
 * Only reports; it never changes a schedule. The canonical one is the
 * Core-executed `daily_brief` routine when present — it makes no model call and
 * is guarded by the delivery ledger, so it cannot notify twice — otherwise the
 * oldest schedule.
 */
export function findDuplicateBriefingSchedules(tasks: ScheduledTaskRecord[]): DuplicateScheduleGroup[] {
  const groups = new Map<string, ScheduledTaskRecord[]>();
  for (const task of tasks) {
    if (!task.enabled || task.repeat !== 'daily' || !isBriefingSchedule(task)) continue;
    const key = `${task.dailyTime}|${task.timezone}`;
    groups.set(key, [...(groups.get(key) ?? []), task]);
  }
  const out: DuplicateScheduleGroup[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const ordered = [...members].sort((a, b) => Number(b.routine === 'daily_brief') - Number(a.routine === 'daily_brief') || Date.parse(a.createdAt) - Date.parse(b.createdAt));
    const [canonical, ...redundant] = ordered;
    out.push({
      dailyTime: canonical.dailyTime,
      timezone: canonical.timezone,
      canonical,
      redundant,
      reason: canonical.routine === 'daily_brief'
        ? 'it is the built-in daily brief routine: Core runs it without a model call and records each delivery once'
        : 'it is the oldest of the matching schedules',
    });
  }
  return out;
}
