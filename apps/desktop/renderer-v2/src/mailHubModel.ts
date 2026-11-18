/**
 * What Mail Hub shows. Pure functions over what Core returns (core/api/mailRoutes.ts), so the screens and the tests
 * share one reading. Every value here is either read from a message (confirmed text), counted from the index, or
 * derived by a fixed rule from those; nothing is invented. AI-written text is shown only when the owner asks for it
 * and is always labelled as such.
 */
export type MailCategory = 'finance' | 'career' | 'event' | 'orders' | 'security' | 'other';
export interface MailAmount { text: string; value: number; currency: string }
export interface MailDate { text: string; iso: string | null; yearInferred: boolean }
export interface MailFacts { amounts: MailAmount[]; dates: MailDate[]; needsReply: boolean; confidence: 'high' | 'medium' | 'low'; bulk?: boolean }
export interface MailRow {
  id: string; storeId: string; account: string; folder: string; subject: string; fromName: string; fromAddress: string; toText: string; received: string;
  unread: boolean; attachments: number; category: MailCategory; facts: MailFacts; snippet: string; duplicates: number;
}
export interface MailCoverage { from: string | null; floor: string; complete: boolean; capped: boolean }
export interface MailAccount { storeId: string; name: string; enabled: boolean; authorizedAt: string | null; lastSyncAt: string | null; lastError: string | null; inboxItems?: number | null; inboxUnread?: number | null; indexed?: number; coverage?: MailCoverage }

/** How far back the index has been checked against Outlook, in words. */
export function coverageWords(c: MailCoverage | undefined): string {
  if (!c) return 'not read yet';
  if (c.complete) return `the whole window is covered (back to ${c.floor.slice(0, 10)})`;
  if (!c.from) return 'nothing indexed yet';
  return `indexed back to ${c.from.slice(0, 10)} of ${c.floor.slice(0, 10)}${c.capped ? ' (stopped by the size limit)' : ', continues on the next sync'}`;
}
export interface MailSettings { windowDays: number; maxPerAccount: number; maxPerSync: number; bodyChars: number; retentionDays: number }
export interface MailCounts { indexed: number; unread: number; needsReply: number; byCategory: Record<string, number> }
export interface MailStatus {
  platform: string; connector: { state: 'unknown' | 'ok' | 'down'; lastOkAt: string | null; lastError: string | null; restarts: number; queued: number };
  settings: MailSettings; accounts: MailAccount[]; overview: MailCounts; storage: { messages: number; approxBytes: number };
  inboxAssistant: { exists: boolean; botId: string | null; usesOutlookMail: boolean };
}
export interface MailOverview { accounts: MailAccount[]; counts: MailCounts; priority: MailRow[]; dateRange: { from: string; to: string } | null }
export interface MailAskRun { id: string; status: string; reason: string; question: string | null; report: string | null; proposals: string[]; finishedAt: string | null }

export const SCREENS = [
  ['overview', '◫', 'Overview'], ['inbox', '▤', 'Unified Inbox'], ['reader', '▧', 'Email Reader'], ['assistant', '✧', 'Ask Pandesh'], ['finance', '◈', 'Finance'],
  ['career', '▣', 'Career'], ['calendar', '▦', 'Calendar'], ['tasks', '☑', 'Tasks'], ['rules', '⚑', 'Smart Rules'], ['activity', '↻', 'Activity Log'], ['settings', '⚙', 'Settings'],
] as const;
export type ScreenId = typeof SCREENS[number][0];
export const isScreen = (s: string): s is ScreenId => SCREENS.some(([id]) => id === s);

export const CATEGORY_LABEL: Record<MailCategory, string> = { finance: 'Finance', career: 'Career', event: 'Event', orders: 'Orders', security: 'Security', other: 'Other' };

/** "Today", "Yesterday" or a short date, from the message's own timestamp. */
export function whenWords(iso: string, now = new Date()): string {
  const d = new Date(iso); if (Number.isNaN(d.getTime())) return '';
  const day = (x: Date) => Math.floor(new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime() / 86_400_000);
  const diff = day(now) - day(d);
  if (diff === 0) return 'Today'; if (diff === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(diff > 300 ? { year: 'numeric' } : {}) });
}

export function sender(r: Pick<MailRow, 'fromName' | 'fromAddress'>): string { return r.fromName?.trim() || r.fromAddress || 'Unknown sender'; }

/** Sums per currency. Different currencies are never added together. */
export function sumByCurrency(amounts: MailAmount[]): string {
  const t = new Map<string, number>();
  for (const a of amounts) t.set(a.currency, (t.get(a.currency) ?? 0) + a.value);
  return [...t.entries()].map(([c, v]) => `${c === 'EUR' ? '€' : c === 'USD' ? '$' : c === 'GBP' ? '£' : `${c} `}${v.toFixed(2)}`).join(' + ') || '—';
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export interface FinanceView { due: Array<{ row: MailRow; amount: MailAmount | null; date: MailDate }>; records: MailRow[]; dueTotal: string; withAmount: number; withAttachment: number }
/** Bills: finance mail whose text names a date that is today or later is "due or upcoming"; the rest are records. */
export function financeView(rows: MailRow[], now = new Date()): FinanceView {
  const today = ymd(now);
  const due: FinanceView['due'] = [];
  for (const row of rows) {
    const date = row.facts.dates.find((d) => d.iso && d.iso >= today);
    if (date && row.unread) due.push({ row, amount: row.facts.amounts[0] ?? null, date });
  }
  due.sort((a, b) => (a.date.iso ?? '').localeCompare(b.date.iso ?? ''));
  return { due, records: rows, dueTotal: sumByCurrency(due.flatMap((d) => (d.amount ? [d.amount] : []))), withAmount: rows.filter((r) => r.facts.amounts.length).length, withAttachment: rows.filter((r) => r.attachments > 0).length };
}

export type CareerStage = 'reply' | 'interview' | 'applied' | 'other';
export interface CareerView { stages: Record<CareerStage, MailRow[]>; needsReply: number; unread: number; total: number }
const APPLIED = /\b(application (received|submitted)|applied|thank you for (your )?appl\w*|received your application|bewerbung)\b/i;
const INTERVIEW = /\b(interview|call|screening|availability|schedule|zoom|teams)\b/i;
export function careerView(rows: MailRow[]): CareerView {
  const stages: Record<CareerStage, MailRow[]> = { reply: [], interview: [], applied: [], other: [] };
  for (const r of rows) {
    const text = `${r.subject} ${r.snippet}`;
    const stage: CareerStage = r.facts.needsReply && r.unread ? 'reply' : INTERVIEW.test(text) ? 'interview' : APPLIED.test(text) ? 'applied' : 'other';
    stages[stage].push(r);
  }
  return { stages, needsReply: stages.reply.length, unread: rows.filter((r) => r.unread).length, total: rows.length };
}

export interface DetectedDate { iso: string; text: string; yearInferred: boolean; row: MailRow }
export function detectedDates(rows: MailRow[], now = new Date(), horizonDays = 45): DetectedDate[] {
  const from = ymd(now); const to = ymd(new Date(now.getTime() + horizonDays * 86_400_000));
  const out: DetectedDate[] = [];
  for (const row of rows) for (const d of row.facts.dates) if (d.iso && d.iso >= from && d.iso <= to) out.push({ iso: d.iso, text: d.text, yearInferred: d.yearInferred, row });
  return out.sort((a, b) => a.iso.localeCompare(b.iso)).filter((d, i, all) => all.findIndex((x) => x.iso === d.iso && x.row.id === d.row.id) === i);
}
/** The seven days of the week containing `now` (Monday first), with the dates found in mail for each. */
export function weekStrip(now: Date, dates: DetectedDate[]): Array<{ ymd: string; day: number; weekday: string; today: boolean; count: number }> {
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => { const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i); const key = ymd(d);
    return { ymd: key, day: d.getDate(), weekday: d.toLocaleDateString(undefined, { weekday: 'short' }), today: key === ymd(now), count: dates.filter((x) => x.iso === key).length }; });
}

export interface SuggestedTask { id: string; title: string; why: string; kind: 'reply' | 'bill' | 'event'; row: MailRow; due: string | null }
/** Suggestions only: each one points at the message it came from. Nothing is created, sent or paid. */
export function suggestedTasks(rows: MailRow[], now = new Date()): SuggestedTask[] {
  const today = ymd(now);
  const out: SuggestedTask[] = [];
  for (const r of rows) {
    if (r.unread && r.facts.needsReply && r.category !== 'security') out.push({ id: `reply:${r.id}`, title: `Reply to ${sender(r)}`, why: `"${r.subject}" looks like it asks for an answer (found in the message text).`, kind: 'reply', row: r, due: null });
    const date = r.facts.dates.find((d) => d.iso && d.iso >= today);
    if (r.category === 'finance' && r.unread && date) out.push({ id: `bill:${r.id}`, title: `Check ${r.facts.amounts[0]?.text ? `${r.facts.amounts[0].text} ` : ''}bill from ${sender(r)}`, why: `The message names ${date.text}. Verify it against the sender before paying.`, kind: 'bill', row: r, due: date.iso });
    if (r.category === 'event' && date) out.push({ id: `event:${r.id}`, title: `Review date: ${r.subject}`, why: `The message names ${date.text}${date.yearInferred ? ' (year assumed)' : ''}.`, kind: 'event', row: r, due: date.iso });
  }
  return out.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999')).slice(0, 40);
}

export function connectorWords(s: MailStatus['connector']): { text: string; tone: 'good' | 'alert' | 'plain' } {
  if (s.state === 'ok') return { text: 'Outlook connected', tone: 'good' };
  if (s.state === 'down') return { text: `Outlook unavailable${s.lastError ? `: ${s.lastError}` : ''}`, tone: 'alert' };
  return { text: 'Outlook not contacted yet', tone: 'plain' };
}

export function bytesWords(n: number): string { return n < 1_000_000 ? `${Math.max(1, Math.round(n / 1000))} KB` : `${(n / 1_000_000).toFixed(1)} MB`; }

/** Prompts sent to the existing Inbox Assistant. The message id is how Core finds the text to give the local model. */
export const askAbout = {
  summarize: (r: MailRow) => `Summarize the message [Mail ${r.id}] in three sentences. Say what it asks of me, with any deadline or amount the text states. Cite [Mail ${r.id}].`,
  draftReply: (r: MailRow) => `Write a short draft reply to the message [Mail ${r.id}] for me to review. Do not send anything. Cite [Mail ${r.id}].`,
};
