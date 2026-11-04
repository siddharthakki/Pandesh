/**
 * Household obligation extraction: what one email or document says about a bill, subscription, contract, warranty or
 * other dated responsibility. Pure and deterministic (German and English wording), so it runs locally on private text
 * without a model, and the same message always yields the same facts.
 *
 * It extracts signals, not conclusions: "an invoice was issued", "a payment was confirmed", "this renews on". Whether a
 * bill is still unpaid is decided later from all the evidence together (core/domain/householdObligations.ts), because
 * an invoice email alone never proves a bill is unpaid.
 */
import { cleanCounterparty } from './contractInventory';

export type ObligationKind =
  | 'subscription' | 'bill' | 'contract' | 'insurance' | 'warranty' | 'document_expiry' | 'delivery' | 'appointment' | 'service_notice' | 'account_notice';

export type ObligationSignal =
  | 'invoice' | 'payment_due' | 'direct_debit' | 'payment_reminder' | 'payment_confirmed' | 'renewal' | 'price_change'
  | 'cancellation_confirmed' | 'contract_term' | 'service_interruption' | 'delivery_tracking' | 'appointment_confirmed' | 'expiry' | 'account_notice';

export type Cadence = 'monthly' | 'quarterly' | 'yearly' | 'once' | 'unknown';

export interface SourceText {
  sourceType: 'gmail' | 'file';
  /** Stable reference: the Gmail message id, or the file path. */
  sourceRef: string;
  /** Subject or file name. */
  label: string;
  from?: string;
  /** When the source was received or last modified (ISO). */
  observedAt: string;
  text: string;
}

export interface ExtractedObligation {
  kind: ObligationKind;
  signal: ObligationSignal;
  counterparty: string;
  amountCents: number | null;
  currency: string | null;
  /** The date the signal is about: due, renewal, contract end, expiry, delivery or appointment (YYYY-MM-DD). */
  date: string | null;
  dateKind: 'due' | 'debit' | 'renewal' | 'contract_end' | 'expiry' | 'appointment' | 'delivery' | 'notice_deadline' | null;
  cadence: Cadence;
  invoiceNumber: string | null;
  accountNumber: string | null;
  confidence: number;
  /** The sentence the facts came from, so a person can check them. */
  excerpt: string;
  followUp: string | null;
}

const SIGNALS: ReadonlyArray<readonly [ObligationSignal, RegExp]> = [
  ['cancellation_confirmed', /(k[üu]ndigungsbest[äa]tigung|best[äa]tigen (ihre|die) k[üu]ndigung|cancellation (is )?confirm|(subscription|membership|contract) (has been|was|is) cancel+ed)/i],
  ['payment_confirmed', /(payment (received|confirmed|successful)|zahlung(seingang)? (erhalten|best[äa]tigt|eingegangen)|zahlungsbest[äa]tigung|vielen dank f[üu]r ihre zahlung|thank you for your payment|(wurde|ist) (erfolgreich )?(abgebucht|bezahlt|beglichen)|paid in full|receipt for your payment|your payment of)/i],
  ['payment_reminder', /(zahlungserinnerung|\bmahnung\b|payment reminder|overdue|[üu]berf[äa]llig|past due|noch nicht (bezahlt|beglichen)|offener betrag)/i],
  ['direct_debit', /(lastschrift|sepa[- ]?(basis)?lastschrift|direct debit|wird (am .{1,30} )?(von ihrem konto )?abgebucht|ziehen (den betrag|wir) .{0,30}ein)/i],
  ['payment_due', /(f[äa]llig (am|bis|zum)|zahlbar (bis|innerhalb)|zahlungsziel|due (date|on|by)|payment due|amount due|bitte (überweisen|zahlen|begleichen) sie)/i],
  ['price_change', /(preis[äa]nderung|preisanpassung|price (change|increase)|neuer preis|new price)/i],
  ['renewal', /(verl[äa]ngert sich|verl[äa]ngerung|renew(s|al|ed)?\b|auto-?renew|n[äa]chste abbuchung|next (billing|payment) date|abo(nnement)? .{0,20}(l[äa]uft|aktiv)|subscription (renews|will renew|is active))/i],
  ['contract_term', /(mindestvertragslaufzeit|vertragslaufzeit|k[üu]ndigungsfrist|notice period|vertragsende|contract end|laufzeit bis|end of (the )?term)/i],
  ['service_interruption', /(st[öo]rung|service (interruption|outage)|wartungsarbeiten|maintenance (window|work)|ausfall|outage)/i],
  ['delivery_tracking', /(sendungsverfolgung|sendungsnummer|tracking (number|link)|ihr paket|your (package|parcel|order) (has )?(shipped|is on its way)|voraussichtliche zustellung|estimated delivery)/i],
  ['appointment_confirmed', /(terminbest[äa]tigung|appointment (confirmed|confirmation|reminder)|ihr termin (am|beginnt)|your appointment (on|is))/i],
  ['expiry', /(g[üu]ltig bis|valid (until|through)|expir(es|y|ation)( date| on)?|ablaufdatum|l[äa]uft am .{1,20} ab)/i],
  ['invoice', /(\brechnung\b|ihre rechnung|rechnungsnummer|invoice|your bill|bill is ready|abrechnung|beitragsrechnung|order receipt|kaufbeleg)/i],
  ['account_notice', /(wichtige information zu ihrem konto|account notice|agb[- ]?[äa]nderung|terms (of service )?update|security notice)/i],
];

const KIND_HINTS: ReadonlyArray<readonly [ObligationKind, RegExp]> = [
  ['insurance', /(versicherung|insurance|police|haftpflicht|hausrat|krankenkasse)/i],
  ['warranty', /(garantie|warranty|gew[äa]hrleistung)/i],
  ['subscription', /(abo(nnement)?\b|subscription|membership|mitgliedschaft|streaming|netflix|spotify|disney|prime|icloud|google one|youtube premium|adobe|microsoft 365|chatgpt|patreon|zeitung|magazin)/i],
  ['contract', /(vertrag|contract|tarif|mobilfunk|dsl|glasfaser|strom|gas|energie|telekom|vodafone|o2|1&1|stadtwerke|miete)/i],
];

const MONTHS: Record<string, number> = {
  jan: 1, januar: 1, january: 1, feb: 2, februar: 2, february: 2, mär: 3, märz: 3, maerz: 3, mar: 3, march: 3, apr: 4, april: 4, mai: 5, may: 5,
  jun: 6, juni: 6, june: 6, jul: 7, juli: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9, okt: 10, oktober: 10, oct: 10, october: 10,
  nov: 11, november: 11, dez: 12, dezember: 12, dec: 12, december: 12,
};

const pad = (n: number) => String(n).padStart(2, '0');
function ymd(y: number, m: number, d: number): string | null {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

/** Every date in the text with its position. German and English formats. */
export function findDates(text: string): Array<{ date: string; index: number }> {
  const out: Array<{ date: string; index: number }> = [];
  for (const m of text.matchAll(/\b(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{2,4})\b/g)) { const d = ymd(+m[3], +m[2], +m[1]); if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) { const d = ymd(+m[1], +m[2], +m[3]); if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of text.matchAll(/\b(\d{1,2})\.?\s+([A-Za-zÄÖÜäöü]{3,9})\.?\s+(20\d{2})\b/g)) { const mon = MONTHS[m[2].toLowerCase()]; const d = mon ? ymd(+m[3], mon, +m[1]) : null; if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of text.matchAll(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})\b/g)) { const mon = MONTHS[m[1].toLowerCase()]; const d = mon ? ymd(+m[3], mon, +m[2]) : null; if (d) out.push({ date: d, index: m.index ?? 0 }); }
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/g)) { const d = ymd(+m[3], +m[2], +m[1]); if (d) out.push({ date: d, index: m.index ?? 0 }); }
  return out.sort((a, b) => a.index - b.index);
}

const DATE_CONTEXT: ReadonlyArray<readonly [NonNullable<ExtractedObligation['dateKind']>, RegExp]> = [
  ['debit', /(abgebucht|abbuchung|lastschrift|eingezogen|debited|direct debit)/i],
  ['due', /(f[äa]llig|zahlbar|zahlungsziel|due|bis zum|payable)/i],
  ['renewal', /(verl[äa]ngert|verl[äa]ngerung|renew|n[äa]chste (abbuchung|zahlung|abrechnung)|next (billing|payment))/i],
  ['notice_deadline', /(k[üu]ndig(en|ung) (bis|sp[äa]testens)|cancel (by|before)|notice (by|before))/i],
  ['contract_end', /(vertragsende|laufzeit (bis|endet)|endet am|contract (ends|end)|end of term)/i],
  ['expiry', /(g[üu]ltig bis|valid (until|through)|expir|ablauf|l[äa]uft .* ab)/i],
  ['appointment', /(termin|appointment)/i],
  ['delivery', /(zustellung|lieferung|delivery|arrive)/i],
];

/**
 * The date closest to a word saying what it means: after it within 60 characters ("fällig am 10.03."), or before it
 * within 45 characters in the same line, as German puts it ("wird am 10.03.2026 … abgebucht"). After wins a tie.
 */
export function contextualDate(text: string): { date: string; kind: NonNullable<ExtractedObligation['dateKind']> } | null {
  const dates = findDates(text);
  let best: { date: string; kind: NonNullable<ExtractedObligation['dateKind']>; distance: number } | null = null;
  for (const [kind, re] of DATE_CONTEXT) {
    const global = new RegExp(re.source, 'gi');
    for (const m of text.matchAll(global)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      for (const d of dates) {
        let distance: number;
        if (d.index >= start) distance = d.index - end;
        else {
          const between = text.slice(d.index, start);
          if (between.includes('\n') || start - d.index > 45) continue;
          distance = start - d.index + 1;
        }
        if (distance > 60 || distance < -1) continue;
        if (!best || distance < best.distance) best = { date: d.date, kind, distance };
      }
    }
  }
  return best ? { date: best.date, kind: best.kind } : null;
}

/** Parses "1.234,56", "12,99", "1,234.56", "12.99" into cents. */
export function parseAmount(raw: string): number | null {
  let s = raw.replace(/\s/g, '');
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) && n > 0 && n < 1_000_000 ? Math.round(n * 100) : null;
}

const CURRENCY = { '€': 'EUR', EUR: 'EUR', '$': 'USD', USD: 'USD', '£': 'GBP', GBP: 'GBP', CHF: 'CHF' } as Record<string, string>;
const NUM = '\\d{1,3}(?:[.\\s]\\d{3})*,\\d{1,2}|\\d{1,3}(?:,\\d{3})*\\.\\d{1,2}|\\d+(?:[.,]\\d{1,2})?';
const CUR = '€|EUR|\\$|USD|£|GBP|CHF';
const LABELLED_AMOUNT = new RegExp(`(?:gesamtbetrag|rechnungsbetrag|endbetrag|zu zahlen(?:der betrag)?|betrag|summe|total(?: due)?|amount(?: due| charged| paid)?|monatlich|monthly|j[äa]hrlich|annually|preis|price)[^\\d€$£\\n]{0,25}(?<pre>${CUR})?\\s?(?<num>${NUM})\\s?(?<post>${CUR})?`, 'i');
const ANY_AMOUNT = new RegExp(`(?<pre>${CUR})\\s?(?<num>${NUM})|(?<num2>${NUM})\\s?(?<post>${CUR})`, 'i');

/** The amount the message is about: a labelled total with a currency first, then any currency amount. */
export function extractAmount(text: string): { cents: number; currency: string } | null {
  const labelled = LABELLED_AMOUNT.exec(text)?.groups;
  if (labelled && (labelled.pre || labelled.post)) {
    const cents = parseAmount(labelled.num);
    if (cents) return { cents, currency: CURRENCY[(labelled.pre ?? labelled.post).toUpperCase()] ?? 'EUR' };
  }
  const any = ANY_AMOUNT.exec(text)?.groups;
  if (any) {
    const cents = parseAmount(any.num ?? any.num2);
    if (cents) return { cents, currency: CURRENCY[(any.pre ?? any.post).toUpperCase()] ?? 'EUR' };
  }
  return null;
}

export function extractCadence(text: string): Cadence {
  if (/(monatlich|pro monat|\/\s?monat|je monat|monthly|per month|\/\s?mo\b|a month)/i.test(text)) return 'monthly';
  if (/(viertelj[äa]hrlich|quartal|quarterly|per quarter)/i.test(text)) return 'quarterly';
  if (/(j[äa]hrlich|pro jahr|\/\s?jahr|jahresbeitrag|jahresabo|annual(ly)?|yearly|per year|a year)/i.test(text)) return 'yearly';
  return 'unknown';
}

const REF = '([A-Z0-9][A-Z0-9\\-/]{3,24})';
function reference(text: string, labels: string): string | null {
  return new RegExp(`(?:${labels})\\s*[:#.]?\\s*${REF}`, 'i').exec(text)?.[1]?.replace(/[.,;]$/, '') ?? null;
}

/** "Telekom Deutschland GmbH <rechnung@telekom.de>" → "Telekom Deutschland". */
export function counterpartyName(from: string | undefined, label: string): string {
  let name = from ? cleanCounterparty(from) : '';
  if (!name || name === 'Unknown') name = label.replace(/\.(pdf|txt|eml|docx?)$/i, '').replace(/[_-]+/g, ' ').replace(/\b(rechnung|invoice|receipt|quittung|beleg|vertrag|contract|\d[\d.\- ]*)\b/gi, ' ').replace(/\s+/g, ' ').trim();
  name = name.replace(/\s*(\(|-|\|).*(service|kundenservice|no.?reply|rechnung|billing).*$/i, '').replace(/\b(gmbh|ag|se|kg|ug|ohg|inc\.?|ltd\.?|llc|co\.?|& co\.?)\b\.?/gi, '').replace(/[,\s]+$/g, '').trim();
  return name.slice(0, 60) || 'Unknown';
}

/** The normalized counterparty used to group several sources about the same responsibility. */
export function counterpartyKey(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\b(deutschland|germany|online|service|kundenservice|team)\b/g, '').replace(/[^a-z0-9]/g, '') || 'unknown';
}

function sentenceAround(text: string, index: number): string {
  const start = Math.max(0, text.lastIndexOf('\n', index) + 1, index - 160);
  const endNl = text.indexOf('\n', index);
  const end = Math.min(text.length, endNl === -1 ? index + 200 : Math.max(endNl, index + 60), index + 220);
  return text.slice(start, end).replace(/\s+/g, ' ').trim();
}

/** Reads one source. Returns null when it says nothing about an obligation. */
export function extractObligation(src: SourceText): ExtractedObligation | null {
  const text = `${src.label}\n${src.text}`.slice(0, 20_000);
  let signal: ObligationSignal | null = null;
  let at = 0;
  for (const [s, re] of SIGNALS) { const m = re.exec(text); if (m) { signal = s; at = m.index ?? 0; break; } }
  if (!signal) return null;
  // Marketing mail mentions "subscription" constantly; without an amount, a date or a reference it is not an obligation.
  const amount = extractAmount(text);
  const dated = contextualDate(text);
  const invoiceNumber = reference(text, 'rechnungs?(?:nummer|nr\\.?)|invoice\\s*(?:no\\.?|number|#)|beleg(?:nummer|nr\\.?)');
  const accountNumber = reference(text, 'kunden(?:nummer|nr\\.?)|vertrags(?:nummer|nr\\.?)|versicherungs(?:nummer|schein(?:nummer|nr\\.?))|customer\\s*(?:no\\.?|number|id)|contract\\s*(?:no\\.?|number)|account\\s*(?:no\\.?|number)|policy\\s*(?:no\\.?|number)|mitglieds(?:nummer|nr\\.?)');
  if (!amount && !dated && !invoiceNumber && !accountNumber && !['delivery_tracking', 'appointment_confirmed', 'service_interruption', 'cancellation_confirmed'].includes(signal)) return null;
  if (/(newsletter|unsubscribe|abmelden|angebot der woche|sale|rabatt|% off|deal)/i.test(text) && !invoiceNumber && !accountNumber && signal !== 'payment_confirmed') return null;

  let kind: ObligationKind;
  switch (signal) {
    case 'delivery_tracking': kind = 'delivery'; break;
    case 'appointment_confirmed': kind = 'appointment'; break;
    case 'service_interruption': kind = 'service_notice'; break;
    case 'account_notice': kind = 'account_notice'; break;
    case 'expiry': kind = /(garantie|warranty)/i.test(text) ? 'warranty' : KIND_HINTS.find(([, re]) => re.test(text))?.[0] ?? 'document_expiry'; break;
    default: kind = KIND_HINTS.find(([, re]) => re.test(text))?.[0] ?? 'bill';
  }
  const cadence = extractCadence(text);
  if (kind === 'bill' && cadence !== 'unknown' && signal !== 'payment_reminder') kind = 'subscription';
  const confidence = Math.min(0.95, 0.45 + (amount ? 0.15 : 0) + (dated ? 0.15 : 0) + (invoiceNumber || accountNumber ? 0.15 : 0) + (src.from ? 0.05 : 0));
  const followUp = signal === 'payment_reminder' ? 'A reminder was sent: check whether this was paid.'
    : signal === 'contract_term' && dated?.kind === 'notice_deadline' ? `Decide before ${dated.date} whether to cancel.`
      : signal === 'price_change' ? 'The price changes: decide whether to keep it.'
        : null;
  return {
    kind, signal, counterparty: counterpartyName(src.from, src.label), amountCents: amount?.cents ?? null, currency: amount?.currency ?? null,
    date: dated?.date ?? null, dateKind: dated?.kind ?? null, cadence, invoiceNumber, accountNumber, confidence: Math.round(confidence * 100) / 100,
    excerpt: sentenceAround(text, at).slice(0, 280), followUp,
  };
}
