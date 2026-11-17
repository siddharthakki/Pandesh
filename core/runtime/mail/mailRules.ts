/**
 * Deterministic reading of a message: category, amounts and dates. No model is involved, so what it finds is
 * "extracted from the message text" and always points at the message it came from. Local AI only interprets
 * and summarizes on top of this (mailAi.ts).
 */
export type MailCategory = 'finance' | 'career' | 'event' | 'orders' | 'security' | 'other';
export interface MailAmount { text: string; value: number; currency: string }
export interface MailDate { text: string; iso: string | null; yearInferred: boolean }
export interface MailFacts {
  amounts: MailAmount[]; dates: MailDate[]; needsReply: boolean; confidence: 'high' | 'medium' | 'low';
  /** Automated or bulk mail (newsletter, no-reply, alert): never "needs a reply", and a category must be named in the subject. */
  bulk?: boolean;
}
export interface MailReading { category: MailCategory; facts: MailFacts }

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const monthIndex = (s: string) => MONTHS.findIndex((m) => m.startsWith(s.toLowerCase().slice(0, 3)));

const FINANCE = /\b(invoice|rechnung|bill|statement|amount due|payment due|due date|receipt|beleg|quittung|iban|direct debit|lastschrift)\b/i;
const CAREER = /\b(recruit\w*|interview|application|applied|job|position|vacancy|candidate|cv|resume|hiring|talent|career|offer letter|bewerbung)\b/i;
const EVENT = /\b(appointment|termin|meeting|rsvp|reservation|booking|confirmed for|your registration|registration (is )?confirmed)\b/i;
const ORDERS = /\b(order|dispatched|shipped|delivery|parcel|tracking|sendung|paket|package)\b/i;
const SECURITY = /\b(security alert|sign-in|sign in|verification code|password|new login|suspicious)\b/i;
const REPLY = /(\bplease (reply|respond|confirm|let us know|share|send)\b|\bcould you\b|\bcan you\b|\bwould you\b|\bavailability\b|\bget back to (me|us)\b|\blet me know\b|\bantworten sie\b)/i;
const BULK_SENDER = /(no[-_.]?reply|do[-_.]?not[-_.]?reply|newsletter|notifications?@|mailer|marketing|news@|updates?@|digest|alerts?@|offers?@|deals?@|promo|bounce)/i;
const BULK_TEXT = /\b(unsubscribe|view (this email )?in (your )?browser|manage (your )?(email )?preferences|abbestellen|abmelden|you are receiving this|you received this (email|message) because)\b/i;

export function extractAmounts(text: string): MailAmount[] {
  const out: MailAmount[] = [];
  const re = /(?:(€|\$|£|EUR|USD|GBP)\s?(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?))|(?:(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(€|EUR|USD|GBP|\$))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < 6) {
    const cur = (m[1] ?? m[4]) as string; const raw = (m[2] ?? m[3]) as string;
    const norm = /[.,]\d{1,2}$/.test(raw) ? raw.replace(/[.,](?=\d{3}\b)/g, '').replace(',', '.') : raw.replace(/[.,]/g, '');
    const value = Number(norm);
    if (!Number.isFinite(value) || value <= 0) continue;
    const currency = cur === '€' ? 'EUR' : cur === '$' ? 'USD' : cur === '£' ? 'GBP' : cur;
    if (!out.some((a) => a.value === value && a.currency === currency)) out.push({ text: m[0].trim(), value, currency });
  }
  return out;
}

export function extractDates(text: string, receivedIso: string): MailDate[] {
  const out: MailDate[] = [];
  const year = new Date(receivedIso).getUTCFullYear();
  const push = (text0: string, y: number | null, mo: number, d: number) => {
    if (mo < 0 || mo > 11 || d < 1 || d > 31) return;
    const useYear = y ?? year;
    const iso = `${useYear}-${String(mo + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (!out.some((x) => x.iso === iso)) out.push({ text: text0.trim(), iso, yearInferred: y === null });
  };
  let m: RegExpExecArray | null;
  const dmy = /\b(\d{1,2})(?:st|nd|rd|th)?\.?\s+(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)(?:,?\s+(20\d{2}))?/gi;
  while ((m = dmy.exec(text)) && out.length < 6) push(m[0], m[3] ? Number(m[3]) : null, monthIndex(m[2]), Number(m[1]));
  const mdy = /\b(jan\w*|feb\w*|mar\w*|apr\w*|may|jun\w*|jul\w*|aug\w*|sep\w*|oct\w*|nov\w*|dec\w*)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/gi;
  while ((m = mdy.exec(text)) && out.length < 6) push(m[0], m[3] ? Number(m[3]) : null, monthIndex(m[1]), Number(m[2]));
  const iso = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
  while ((m = iso.exec(text)) && out.length < 6) push(m[0], Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const dot = /\b(\d{1,2})\.(\d{1,2})\.(20\d{2})\b/g;
  while ((m = dot.exec(text)) && out.length < 6) push(m[0], Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  return out;
}

export function readMessage(input: { subject: string; fromName: string; fromAddress: string; body: string; received: string; bulkHint?: boolean }): MailReading {
  const head = `${input.subject}\n${input.fromName} ${input.fromAddress}`;
  const text = `${head}\n${input.body}`;
  const bulk = input.bulkHint === true || BULK_SENDER.test(input.fromAddress) || BULK_TEXT.test(input.body);
  let category: MailCategory = 'other';
  let hits = 0;
  const tests: Array<[MailCategory, RegExp]> = [['security', SECURITY], ['finance', FINANCE], ['career', CAREER], ['orders', ORDERS], ['event', EVENT]];
  for (const [c, re] of tests) {
    const inHead = re.test(head);
    // Bulk mail must say it in the subject: its body mentions everything.
    const inBody = !bulk && re.test(input.body);
    if (inHead || inBody) { if (category === 'other') { category = c; hits = inHead ? 2 : 1; } }
  }
  const amounts = category === 'finance' || category === 'orders' ? extractAmounts(text) : [];
  const dates = category === 'finance' || category === 'event' || category === 'orders' || category === 'career' ? extractDates(text, input.received) : [];
  return { category, facts: { amounts, dates, needsReply: !bulk && category !== 'security' && REPLY.test(`${input.subject}\n${input.body.slice(0, 1500)}`), confidence: category === 'other' ? 'low' : hits >= 2 ? 'high' : 'medium', bulk } };
}
