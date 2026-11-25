/**
 * Facts read straight out of the text of a billing document (invoice, bill, receipt), in German or English, without a model.
 * Everything returned is a quotation of the document: the exact line it came from is kept beside the value, and a value that
 * cannot be found is reported as not found. Nothing is guessed, summed or converted.
 */

export interface DocumentFacts {
  /** The number as printed (Rechnungsnummer / Invoice No.), or null. */
  number: string | null;
  /** The document date as printed, or null. */
  date: string | null;
  /** The amount the document asks to be paid, as printed (with its currency when printed), or null. */
  total: string | null;
  /** The printed lines that these came from, for the reader to check. */
  evidence: string[];
}

const NUMBER_LABEL = /(?:rechnungs?\s*-?\s*(?:nr\.?|nummer|no\.?)|invoice\s*(?:no\.?|number|nr\.?|#)|beleg\s*-?\s*nr\.?|bill\s*(?:no\.?|number))\s*[:#]?\s*([A-Z0-9][A-Z0-9\-/_.]{2,})/i;
const DATE_LABEL = /(?:rechnungs\s*datum|rechnungsdatum|invoice\s*date|datum|date)\s*[:]?\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/i;
const TOTAL_LABEL = /(?:gesamt\s*betrag|gesamtbetrag|gesamtsumme|endbetrag|rechnungsbetrag|zu\s+zahlen(?:der\s+betrag)?|zahlbetrag|summe\s+brutto|brutto\s*summe|total\s+amount|amount\s+due|grand\s+total|total|summe|gesamt)\b[^\d\n]{0,40}(?:€|eur)?\s*(-?\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2})\s*(€|eur)?/i;
const KEY_LINE = /(?:rechnungs?\s*-?\s*(?:nr|nummer|datum)|invoice\s*(?:no|number|date|#)|\bdatum\b|\bdate\b|f[äa]llig|due\b|gesamt|summe|total|betrag|brutto|netto|mwst|ust\b|vat\b|amount|zu\s+zahlen|€|\beur\b)/i;
const LINE_BREAK = /\r?\n/;

const clean = (line: string) => line.replace(/\s+/g, ' ').trim();

/** The printed lines worth showing for a billing document: labels, dates, amounts. At most `limit`, each at most 160 characters. */
export function keyLines(text: string, limit = 30): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(LINE_BREAK)) {
    const line = clean(raw);
    if (line.length < 4 || !KEY_LINE.test(line)) continue;
    const kept = line.slice(0, 160);
    if (seen.has(kept)) continue;
    seen.add(kept);
    out.push(kept);
    if (out.length >= limit) break;
  }
  return out;
}

/** Number, date and total from the document's own text. The total is the LAST total-labelled amount: totals come at the end. */
export function documentFacts(text: string): DocumentFacts {
  const lines = text.split(LINE_BREAK).map(clean).filter(Boolean);
  let number: string | null = null; let numberLine: string | null = null;
  let date: string | null = null; let dateLine: string | null = null;
  let total: string | null = null; let totalLine: string | null = null;
  for (const line of lines) {
    if (!number) { const m = NUMBER_LABEL.exec(line); if (m) { number = m[1].replace(/[.,;]+$/, ''); numberLine = line.slice(0, 160); } }
    if (!date) { const m = DATE_LABEL.exec(line); if (m) { date = m[1]; dateLine = line.slice(0, 160); } }
  }
  for (const line of lines) {
    const m = TOTAL_LABEL.exec(line);
    if (m) { total = `${m[1].replace(/\s/g, '')}${/€|eur/i.test(line) ? ' €' : ''}`; totalLine = line.slice(0, 160); }
  }
  return { number, date, total, evidence: [...new Set([numberLine, dateLine, totalLine].filter((x): x is string => Boolean(x)))] };
}

/** One row per document, only what was found; "not found" is said, never filled in. */
export function documentsTable(rows: Array<{ receivedLocal: string | null; subject: string; filename: string; facts: DocumentFacts | null; status: string; messageId: string }>): string {
  const cell = (value: string | null | undefined) => (value && value.trim() ? value.replace(/\|/g, '/') : 'not found');
  const head = '| Received | Document number | Document date | Total | File | Gmail message id |\n|---|---|---|---|---|---|';
  const body = rows.map((r) => `| ${cell(r.receivedLocal)} | ${r.facts ? cell(r.facts.number) : r.status} | ${r.facts ? cell(r.facts.date) : r.status} | ${r.facts ? cell(r.facts.total) : r.status} | ${cell(r.filename)} | ${r.messageId} |`);
  return [head, ...body].join('\n');
}

/** One printed amount as cents: "1.234,56 €", "50.00 EUR" and "19,00" are all read; anything else is null. */
function cents(total: string): number | null {
  const m = /(-?\d{1,3}(?:[.,\s]\d{3})*[.,]\d{2}|-?\d+[.,]\d{2})/.exec(total);
  if (!m) return null;
  const raw = m[1].replace(/\s/g, '');
  const dec = Math.max(raw.lastIndexOf(','), raw.lastIndexOf('.'));
  const whole = raw.slice(0, dec).replace(/[.,]/g, '');
  return Math.round(Number(whole + '.' + raw.slice(dec + 1)) * 100);
}

/** The sum of the totals that were found, computed here so that nobody has to add them up by hand. Null when none was found. */
export function sumTotals(totals: Array<string | null | undefined>): { found: number; of: number; sum: string | null } {
  const values = totals.map((t) => (t ? cents(t) : null));
  const found = values.filter((v): v is number => v !== null);
  if (!found.length) return { found: 0, of: totals.length, sum: null };
  const total = found.reduce((a, b) => a + b, 0);
  const euro = totals.some((t) => t && /€|eur/i.test(t));
  const text = (Math.abs(total) / 100).toFixed(2).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return { found: found.length, of: totals.length, sum: `${total < 0 ? '-' : ''}${text}${euro ? ' €' : ''}` };
}
