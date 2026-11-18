/**
 * Reads a question about mail ("Have recruiters replied to my applications?") into index conditions, locally and
 * deterministically: a category, a time range, "unread", "needs a reply", and the few content words that are left.
 * The index is then searched with those, not with every word AND-ed together (which finds nothing for a sentence).
 * No model is involved, so the same question always becomes the same query, and it can be shown to the owner.
 */
import type { MailCategory } from './mailRules';

export interface MailIntent {
  categories: MailCategory[];
  needsReply: boolean;
  unread: boolean;
  /** "Important": leave out newsletters and automated mail. */
  excludeBulk: boolean;
  sinceIso?: string;
  /** Content words that are not part of the intent (names, topics). */
  words: string[];
  /** A one- or two-word search: the words and the category are alternatives, not requirements. */
  short: boolean;
  /** The reading in words, for the screen and for the report: "career mail, since Mon 16 Nov". */
  text: string;
}

const STOP = new Set(('the and for are was were been being have has had did does doing any all not but with from into onto about over under than then them they their there these those this that what which who whom whose when where why how '
  + 'you your yours mine our ours its his her she him can could would should will shall may might must please find show tell list give get got let see look check '
  + 'mail mails email emails message messages inbox important importance soon recent recently latest newest new week weeks month months today yesterday day days last past this next '
  + 'mentioned mention mentions replied reply replies respond responded response responses answer answers need needs needed require requires required arrived arrive arrives received receive '
  + 'something anything everything someone anyone people stuff things thing one two more most some many much very just also still ever never again '
  + 'und der die das ein eine einer ich mein meine meinen habe haben hat gibt ist sind war wurde zu für von mit über wann was wer wie welche welcher nicht auch noch schon '
  + 'nachricht nachrichten bitte zeige finde').split(' '));

const CATEGORY_WORDS: Array<[MailCategory, RegExp]> = [
  ['career', /\b(recruit\w*|applications?|applied|interviews?|jobs?|vacanc\w+|candidates?|hiring|bewerbung\w*|stellenangebot\w*)\b/g],
  ['finance', /\b(invoices?|bills?|payments?|receipts?|statements?|due|overdue|owe|owed|rechnung\w*|zahlung\w*|beleg\w*|quittung\w*)\b/g],
  ['event', /\b(appointments?|meetings?|events?|bookings?|reservations?|termin\w*|calendar|schedule\w*)\b/g],
  ['orders', /\b(orders?|parcels?|packages?|deliver\w*|shipping|shipments?|tracking|bestellung\w*|paket\w*|sendung\w*)\b/g],
  ['security', /\b(security|sign-?in|passwords?|verification)\b/g],
];
const NEEDS_REPLY = /\b(?:require|requires|required|need|needs|needed|awaiting|waiting for|expect\w*) (?:a |an |my )?(?:response|reply|answer|action)\b|\b(?:to )?(?:respond|reply)(?: to)?\b(?= to|\?|$)|\bunanswered\b|\bantwort\w*/g;

const localMidnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayText = (d: Date) => d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export function interpretQuestion(question: string, now: Date = new Date()): MailIntent {
  const q = String(question ?? '').toLowerCase().slice(0, 600);
  let rest = q;
  const categories: MailCategory[] = [];
  const consumed = new Set<string>();
  for (const [cat, re] of CATEGORY_WORDS) {
    const hits = q.match(re);
    if (hits) { categories.push(cat); for (const h of hits) for (const t of h.split(/[^\p{L}\p{N}]+/u)) consumed.add(t); }
  }
  const needsReply = NEEDS_REPLY.test(q); NEEDS_REPLY.lastIndex = 0;
  const unread = /\bunread\b|\bungelesen\b/.test(q);
  const excludeBulk = /\bimportant\b|\bwichtig\w*/.test(q);

  let sinceIso: string | undefined; let when = '';
  const mid = localMidnight(now);
  const n = /\b(?:last|past|previous) (\d{1,3}) days?\b/.exec(q);
  if (/\bthis week\b|\bdiese woche\b/.test(q)) { const d = new Date(mid.getFullYear(), mid.getMonth(), mid.getDate() - ((mid.getDay() + 6) % 7)); sinceIso = d.toISOString(); when = `since ${dayText(d)}`; }
  else if (/\btoday\b|\bheute\b/.test(q)) { sinceIso = mid.toISOString(); when = 'today'; }
  else if (/\byesterday\b|\bgestern\b/.test(q)) { const d = new Date(mid.getTime() - 86_400_000); sinceIso = d.toISOString(); when = `since ${dayText(d)}`; }
  else if (n) { const d = new Date(mid.getTime() - Number(n[1]) * 86_400_000); sinceIso = d.toISOString(); when = `in the last ${n[1]} days`; }
  else if (/\blast week\b|\bpast week\b|\bthis past week\b/.test(q)) { const d = new Date(mid.getTime() - 7 * 86_400_000); sinceIso = d.toISOString(); when = 'in the last 7 days'; }
  else if (/\bthis month\b|\bdiesen monat\b/.test(q)) { const d = new Date(mid.getFullYear(), mid.getMonth(), 1); sinceIso = d.toISOString(); when = `since ${dayText(d)}`; }

  rest = rest.replace(/[^\p{L}\p{N}\s-]/gu, ' ');
  const tokens = (rest.match(/[\p{L}\p{N}][\p{L}\p{N}-]{2,}/gu) ?? []).filter((t) => !STOP.has(t));
  const unique = [...new Set(tokens)];
  // A typed keyword search is short (at most three words, at most two of them content words); a sentence is not.
  const rawWords = (q.match(/[\p{L}\p{N}]+/gu) ?? []).length;
  const short = rawWords < 4 && unique.length <= 2;
  // A longer question: the words that named the category are the category, not search terms. A short one: they are also words to find.
  const words = (short ? unique : unique.filter((t) => !consumed.has(t))).slice(0, 6);

  const parts: string[] = [];
  if (categories.length) parts.push(`${categories.join(' or ')} mail`);
  else if (words.length) parts.push(`mail mentioning ${words.map((w) => `“${w}”`).join(', ')}`);
  else parts.push('mail');
  if (categories.length && words.length && !short) parts.push(`mentioning ${words.map((w) => `“${w}”`).join(', ')}`);
  if (unread) parts.push('unread');
  if (needsReply) parts.push('that may need a reply');
  if (excludeBulk) parts.push('not newsletters or automated mail');
  if (when) parts.push(when);
  return { categories, needsReply, unread, excludeBulk, sinceIso, words, short, text: parts.join(', ') };
}

/** Prefix terms joined with OR (plain words only, so nothing typed or received can be query syntax). */
export function ftsOrQuery(words: string[]): string | null {
  const safe = words.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '')).filter((w) => w.length >= 2);
  return safe.length ? safe.map((w) => `"${w}"*`).join(' OR ') : null;
}

export const hasAnyIntent = (i: MailIntent) => i.categories.length > 0 || i.words.length > 0 || i.needsReply || i.unread || i.excludeBulk || Boolean(i.sinceIso);
