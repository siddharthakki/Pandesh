/**
 * Deterministic receipt/invoice field parser (German and English). Plain rules, no model: every field it returns was matched
 * by a named rule in the text, and anything it could not find is simply absent (never guessed). Amounts are integer cents.
 */
export interface ReceiptFields {
  kind: 'receipt' | 'invoice' | 'other';
  merchant?: string;
  date?: string;
  totalCents?: number;
  currency?: 'EUR' | 'USD' | 'GBP' | 'CHF';
  vatCents?: number;
  invoiceNumber?: string;
  /** Names of the rules that produced a field, so a reader (or a test) can see why a value is there. */
  matchedBy: string[];
}

/** "1.234,56", "1,234.56", "12,50", "12.5", "1234" -> cents, or null when it is not a plain amount. */
export function parseAmountCents(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, '').replace(/^[-+]/, '');
  // Whole part: digits with optional 3-digit groups ("1.234" and "1,234" are thousands), then an optional 1-2 digit decimal part.
  const m = /^(\d{1,3}(?:[.,]\d{3})+|\d+)(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]!.replace(/[.,]/g, '')) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
  return Number.isSafeInteger(cents) ? cents : null;
}

const AMOUNT = '(\\d{1,3}(?:[.,\\s]\\d{3})*[.,]\\d{1,2}|\\d+[.,]\\d{1,2}|\\d+)';
const CUR = '(?:€|EUR|eur|Euro|\\$|USD|£|GBP|CHF)?';

function currencyOf(text: string): ReceiptFields['currency'] | undefined {
  if (/€|\bEUR\b|\bEuro\b/i.test(text)) return 'EUR';
  if (/\bCHF\b/.test(text)) return 'CHF';
  if (/£|\bGBP\b/.test(text)) return 'GBP';
  if (/\$|\bUSD\b/.test(text)) return 'USD';
  return undefined;
}

function isoDate(d: number, m: number, y: number): string | null {
  if (y < 100) y += 2000;
  if (y < 1990 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
}

const MONTHS: Record<string, number> = { januar: 1, jan: 1, january: 1, februar: 2, feb: 2, february: 2, märz: 3, maerz: 3, mar: 3, march: 3, april: 4, apr: 4, mai: 5, may: 5, juni: 6, jun: 6, june: 6, juli: 7, jul: 7, july: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9, oktober: 10, okt: 10, oct: 10, october: 10, november: 11, nov: 11, dezember: 12, dez: 12, dec: 12, december: 12 };

function findDate(text: string): { value: string; rule: string } | null {
  // Prefer a date labelled as the document date.
  const labelled = /(?:rechnungsdatum|belegdatum|datum|date|invoice date|kaufdatum)\s*[:.]?\s*([^\n]{0,30})/i.exec(text);
  const scan = (s: string): string | null => {
    let m = /(\d{1,2})\.(\d{1,2})\.(\d{2,4})/.exec(s); if (m) { const v = isoDate(+m[1]!, +m[2]!, +m[3]!); if (v) return v; }
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s); if (m) { const v = isoDate(+m[3]!, +m[2]!, +m[1]!); if (v) return v; }
    m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); if (m) { const v = isoDate(+m[1]!, +m[2]!, +m[3]!); if (v) return v; }
    m = /(\d{1,2})\.?\s+([A-Za-zäöüÄÖÜ]{3,9})\.?\s+(\d{4})/.exec(s); if (m && MONTHS[m[2]!.toLowerCase()]) { const v = isoDate(+m[1]!, MONTHS[m[2]!.toLowerCase()]!, +m[3]!); if (v) return v; }
    return null;
  };
  if (labelled) { const v = scan(labelled[1]!); if (v) return { value: v, rule: 'date:labelled' }; }
  const any = scan(text);
  return any ? { value: any, rule: 'date:first' } : null;
}

const TOTAL_LABELS = ['gesamtbetrag', 'gesamtsumme', 'rechnungsbetrag', 'endbetrag', 'zu zahlen', 'zahlbetrag', 'summe', 'total', 'amount due', 'grand total', 'betrag', 'brutto'];

function findTotal(text: string): { cents: number; rule: string } | null {
  const lines = text.split(/\r?\n/);
  // The last labelled amount wins ("Zwischensumme ... Summe"); a stronger label beats a weaker one.
  for (const label of TOTAL_LABELS) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      const idx = line.toLowerCase().indexOf(label);
      if (idx < 0) continue;
      if (/zwischensumme|subtotal|netto|net\b/i.test(line.slice(Math.max(0, idx - 12), idx + label.length))) continue;
      const m = new RegExp(`${CUR}\\s*${AMOUNT}\\s*${CUR}`).exec(line.slice(idx + label.length));
      const cents = m ? parseAmountCents(m[1]!) : null;
      if (cents !== null && cents > 0) return { cents, rule: `total:${label}` };
    }
  }
  return null;
}

function findVat(text: string): number | null {
  const m = new RegExp(`\\b(?:mwst\\.?|ust\\.?|mehrwertsteuer|umsatzsteuer|vat)[^\\n\\d]{0,24}(?:\\d{1,2}(?:[.,]\\d+)?\\s*%[^\\n\\d]{0,12})?${CUR}\\s*${AMOUNT}`, 'i').exec(text);
  const cents = m ? parseAmountCents(m[1]!) : null;
  return cents !== null && cents > 0 ? cents : null;
}

function findMerchant(text: string): string | null {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(0, 12);
  const labelled = /(?:absender|händler|haendler|verkäufer|verkaeufer|von|from|seller)\s*[:]\s*(.{2,60})/i.exec(text);
  if (labelled) return labelled[1]!.trim();
  for (const l of lines) {
    if (l.length < 3 || l.length > 60) continue;
    if (/^(rechnung|invoice|beleg|quittung|receipt|kassenbon|datum|date|seite|page|www\.|http|tel|fax|\d)/i.test(l)) continue;
    if (/[A-Za-zÄÖÜäöü]{3}/.test(l) && !/^\W+$/.test(l)) return l.replace(/\s{2,}/g, ' ');
  }
  return null;
}

export function parseReceiptText(text: string): ReceiptFields {
  const t = text.replace(/ /g, ' ');
  const out: ReceiptFields = { kind: 'other', matchedBy: [] };
  if (/\b(rechnung|invoice)\b/i.test(t)) { out.kind = 'invoice'; out.matchedBy.push('kind:invoice-word'); }
  else if (/\b(kassenbon|quittung|beleg|receipt|bon\b)/i.test(t)) { out.kind = 'receipt'; out.matchedBy.push('kind:receipt-word'); }
  const merchant = findMerchant(t); if (merchant) { out.merchant = merchant; out.matchedBy.push('merchant'); }
  const date = findDate(t); if (date) { out.date = date.value; out.matchedBy.push(date.rule); }
  const total = findTotal(t); if (total) { out.totalCents = total.cents; out.matchedBy.push(total.rule); }
  const cur = currencyOf(t); if (cur && (out.totalCents !== undefined)) { out.currency = cur; out.matchedBy.push('currency'); }
  const vat = findVat(t); if (vat !== null && (out.totalCents === undefined || vat < out.totalCents)) { out.vatCents = vat; out.matchedBy.push('vat'); }
  const inv = /(?:rechnungs(?:nummer|nr\.?)|rechnung\s*nr\.?|invoice\s*(?:no\.?|number|#)|re-?nr\.?)\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/]{2,30})/i.exec(t);
  if (inv) { out.invoiceNumber = inv[1]!; out.matchedBy.push('invoice-number'); }
  return out;
}
