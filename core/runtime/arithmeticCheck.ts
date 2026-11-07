/**
 * Deterministic arithmetic (audit D11).
 *
 * A local model adds numbers "in its head" and gets totals wrong (M2: five extracted amounts summing to 3,770.45 EUR
 * were reported as 3,763.45 EUR). Two parts, both computed by Core, never by the model:
 *
 *   - `evaluateExpression` backs the `calculate` tool: + − × ÷ and parentheses over exact rationals (BigInt), so
 *     0.1 + 0.2 is 0.3 and money adds to the cent;
 *   - `checkStatedTotals` re-adds a reply's list of amounts that is followed by a "total" line, and corrects the stated
 *     total when it is wrong, saying so. It deliberately skips anything that is not a plain sum (profit, net, margin,
 *     balance, average, per-unit lines, tables).
 */

// ── Exact rationals ─────────────────────────────────────────────────────────
interface Rational { n: bigint; d: bigint }
const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; };
const norm = (n: bigint, d: bigint): Rational => { if (d === 0n) throw new Error('division by zero'); if (d < 0n) { n = -n; d = -d; } const g = gcd(n, d); return { n: n / g, d: d / g }; };
const add = (a: Rational, b: Rational) => norm(a.n * b.d + b.n * a.d, a.d * b.d);
const sub = (a: Rational, b: Rational) => norm(a.n * b.d - b.n * a.d, a.d * b.d);
const mul = (a: Rational, b: Rational) => norm(a.n * b.n, a.d * b.d);
const div = (a: Rational, b: Rational) => norm(a.n * b.d, a.d * b.n);
function fromDecimal(text: string): Rational {
  const [int, frac = ''] = text.split('.');
  return norm(BigInt((int || '0') + frac), 10n ** BigInt(frac.length));
}
function toDecimal(r: Rational, places = 10): string {
  const neg = r.n < 0n; const n = neg ? -r.n : r.n;
  const scale = 10n ** BigInt(places);
  const scaled = (n * scale * 2n + r.d) / (2n * r.d); // round half up
  const int = scaled / scale; let frac = (scaled % scale).toString().padStart(places, '0').replace(/0+$/, '');
  return `${neg && scaled !== 0n ? '-' : ''}${int}${frac ? `.${frac}` : ''}`;
}

/** Evaluates + - * / ( ) over decimal numbers exactly. Throws on anything else. */
export function evaluateExpression(expression: string): string {
  const src = expression.replace(/[×x]/g, '*').replace(/÷/g, '/').replace(/−/g, '-').replace(/\s+/g, '');
  if (!src || /[^0-9.+\-*/()]/.test(src)) throw new Error('only numbers, + - * / and parentheses are allowed');
  let i = 0;
  const peek = () => src[i];
  function number(): Rational {
    const m = /^\d+(?:\.\d+)?|^\.\d+/.exec(src.slice(i));
    if (!m) throw new Error(`expected a number at position ${i + 1}`);
    i += m[0].length;
    return fromDecimal(m[0].startsWith('.') ? `0${m[0]}` : m[0]);
  }
  function factor(): Rational {
    if (peek() === '-') { i += 1; const f = factor(); return norm(-f.n, f.d); }
    if (peek() === '+') { i += 1; return factor(); }
    if (peek() === '(') { i += 1; const v = expr(); if (peek() !== ')') throw new Error('missing )'); i += 1; return v; }
    return number();
  }
  function term(): Rational {
    let v = factor();
    while (peek() === '*' || peek() === '/') { const op = src[i++]; const r = factor(); v = op === '*' ? mul(v, r) : div(v, r); }
    return v;
  }
  function expr(): Rational {
    let v = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++]; const r = term(); v = op === '+' ? add(v, r) : sub(v, r); }
    return v;
  }
  const value = expr();
  if (i !== src.length) throw new Error(`unexpected "${src[i]}" at position ${i + 1}`);
  return toDecimal(value);
}

// ── Amounts in prose ────────────────────────────────────────────────────────
const CURRENCY = String.raw`(?:€|EUR|eur|\$|USD|£|GBP|CHF|₹|INR)`;
const NUMBER = String.raw`\d{1,3}(?:[.,\s]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const AMOUNT = new RegExp(String.raw`(${CURRENCY})\s?(${NUMBER})|(${NUMBER})\s?(${CURRENCY})`, 'g');

export interface ParsedAmount { raw: string; numberText: string; value: Rational; currency: string; index: number }

function currencyKey(c: string): string {
  return ({ '€': 'EUR', eur: 'EUR', '$': 'USD', '£': 'GBP', '₹': 'INR' } as Record<string, string>)[c] ?? c.toUpperCase();
}

/** "1,250.00", "1.250,00", "389,90", "23.45", "2 040" → exact value. */
export function parseAmountNumber(text: string): Rational {
  const t = text.replace(/\s/g, '');
  const lastComma = t.lastIndexOf(','); const lastDot = t.lastIndexOf('.');
  let normalized: string;
  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastComma >= 0) {
    normalized = /,\d{1,2}$/.test(t) ? t.replace(/,(?=\d{3}(?:\D|$))/g, '').replace(',', '.') : t.replace(/,/g, '');
  } else if (lastDot >= 0) {
    normalized = /\.\d{3}$/.test(t) && !/\.\d{1,2}$/.test(t) ? t.replace(/\./g, '') : t;
  } else normalized = t;
  return fromDecimal(normalized);
}

export function amountsIn(line: string): ParsedAmount[] {
  const out: ParsedAmount[] = [];
  for (const m of line.matchAll(AMOUNT)) {
    const numberText = m[2] ?? m[3];
    out.push({ raw: m[0], numberText, value: parseAmountNumber(numberText), currency: currencyKey(m[1] ?? m[4]), index: m.index ?? 0 });
  }
  return out;
}

/** Writes `value` in the same style as `like` (decimal separator, thousands separator, decimals). */
function formatLike(value: Rational, like: string): string {
  const usesCommaDecimal = /,\d{1,2}$/.test(like.replace(/\s/g, '')) && !/\.\d{1,2}$/.test(like);
  const decimals = (/[.,](\d{1,2})$/.exec(like.replace(/\s/g, ''))?.[1].length) ?? 0;
  const fixed = toDecimal(value, Math.max(decimals, 2));
  let [int, frac = ''] = fixed.split('.');
  frac = frac.padEnd(decimals, '0').slice(0, Math.max(decimals, frac.length > 2 ? 2 : frac.length));
  if (decimals === 0 && frac && /^0+$/.test(frac)) frac = '';
  const thousandsSep = usesCommaDecimal ? (/\./.test(like) ? '.' : '') : (/,/.test(like) ? ',' : '');
  if (thousandsSep) int = int.replace(/\B(?=(\d{3})+(?!\d))/g, thousandsSep);
  const fracOut = decimals ? frac.padEnd(decimals, '0').slice(0, decimals) : frac;
  return fracOut ? `${int}${usesCommaDecimal ? ',' : '.'}${fracOut}` : int;
}

const LIST_ITEM = /^\s*(?:[-*•]|\d+[.)])\s+/;
const TOTAL_LINE = /\b(?:total|sum|altogether|in\s+total|overall|grand\s+total|insgesamt|gesamt(?:summe|betrag)?|summe)\b/i;
const NOT_A_SUM = /\b(?:profit|net|margin|balance|difference|remaining|left|average|mean|per\b|each|unit|rate|vat|tax|discount|saving|change|minus|less)\b/i;

export interface TotalCorrection { stated: string; computed: string; items: string[] }

/**
 * Re-adds every list of single-amount items that is directly followed (within two lines) by a "total" line holding one
 * amount in the same currency, and corrects the stated total when it differs.
 */
export function checkStatedTotals(reply: string): { text: string; corrections: TotalCorrection[] } {
  const lines = reply.split('\n');
  const corrections: TotalCorrection[] = [];
  let inFence = false;
  let run: Array<{ amount: ParsedAmount }> = [];
  let sinceRun = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*```/.test(line)) { inFence = !inFence; run = []; continue; }
    if (inFence || /^\s*\|/.test(line)) { run = []; continue; }
    const amounts = amountsIn(line);
    const isTotal = TOTAL_LINE.test(line) && !NOT_A_SUM.test(line);
    if (isTotal && amounts.length >= 1 && run.length >= 2 && sinceRun <= 2) {
      const stated = amounts[amounts.length - 1];
      const currency = run[0].amount.currency;
      if (run.every((r) => r.amount.currency === currency) && stated.currency === currency) {
        const sum = run.reduce((acc, r) => add(acc, r.amount.value), { n: 0n, d: 1n } as Rational);
        const diff = sub(sum, stated.value);
        if (diff.n !== 0n) {
          const fixedNumber = formatLike(sum, stated.numberText);
          const fixedRaw = stated.raw.replace(stated.numberText, fixedNumber);
          lines[i] = line.slice(0, stated.index) + fixedRaw + line.slice(stated.index + stated.raw.length);
          corrections.push({ stated: stated.raw, computed: fixedRaw, items: run.map((r) => r.amount.raw) });
        }
      }
      run = [];
      continue;
    }
    if (LIST_ITEM.test(line) && amounts.length === 1 && !TOTAL_LINE.test(line)) {
      run.push({ amount: amounts[0] }); sinceRun = 0; continue;
    }
    if (run.length && line.trim()) {
      sinceRun += 1;
      if (sinceRun > 2) run = [];
    }
  }
  if (!corrections.length) return { text: reply, corrections };
  const note = corrections.map((c) => `the reply stated ${c.stated}, but ${c.items.join(' + ')} = ${c.computed}`).join('; ');
  return { text: `${lines.join('\n').trimEnd()}\n\n**Corrected by Pandesh:** ${note} (added up exactly by Pandesh, not by the model).`, corrections };
}
