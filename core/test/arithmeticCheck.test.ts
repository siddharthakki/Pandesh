import { describe, expect, it } from 'vitest';
import { checkStatedTotals, evaluateExpression, parseAmountNumber } from '../runtime/arithmeticCheck';

// Verbatim M2 reply (Build 159 independent audit, evidence/M2/p1.json): the five amounts add up to 3,770.45 EUR.
const M2 = `I have examined the files in the \`m2_documents\` folder. I found 5 documents that qualify as invoices or receipts.

**Summary of Amounts:**
*   **invoice_2026-0412_brightline.txt:** 1,250.00 EUR
*   **invoice_oct_spicewholesale.csv:** 2,040.00 EUR
*   **receipt_metro_2026-10-28.txt:** 23.45 EUR
*   **receipt_taxi.txt:** 67.10 EUR
*   **Rechnung_Kuehltechnik_Schmid.md:** 389.90 €

**Total Summary:**
I found **5** items in total. The sum of these documents is **3,763.45 EUR**.`;

describe('evaluateExpression (the calculate tool)', () => {
  it('is exact for money', () => {
    expect(evaluateExpression('1250 + 2040 + 23.45 + 67.10 + 389.90')).toBe('3770.45');
    expect(evaluateExpression('0.1 + 0.2')).toBe('0.3');
    expect(evaluateExpression('34 * 2 + 6')).toBe('74');
    expect(evaluateExpression('17.50 × 4')).toBe('70');
    expect(evaluateExpression('310 / 730 * 100')).toBe('42.4657534247');
    expect(evaluateExpression('-(3 - 5) * 2')).toBe('4');
  });

  it('refuses anything that is not arithmetic', () => {
    expect(() => evaluateExpression('process.exit(1)')).toThrow();
    expect(() => evaluateExpression('1 / 0')).toThrow(/division by zero/);
    expect(() => evaluateExpression('2 +')).toThrow();
  });
});

describe('parseAmountNumber', () => {
  it('reads English and German number styles', () => {
    expect(evaluateExpression('1')).toBe('1');
    for (const [text, value] of [['1,250.00', 1250], ['1.250,00', 1250], ['389,90', 389.9], ['23.45', 23.45], ['2 040', 2040], ['1.250', 1250]] as const) {
      const r = parseAmountNumber(text);
      expect(Number(r.n) / Number(r.d)).toBeCloseTo(value, 6);
    }
  });
});

describe('checkStatedTotals (audit D11)', () => {
  it('corrects the M2 total and says so', () => {
    const result = checkStatedTotals(M2);
    expect(result.corrections).toHaveLength(1);
    expect(result.text).toContain('**3,770.45 EUR**');
    expect(result.text).not.toContain('3,763.45 EUR**.');
    expect(result.text).toContain('Corrected by Pandesh');
    expect(result.text).toContain('3,763.45 EUR');
  });

  it('leaves a correct total, German formatting and non-sum lines alone', () => {
    const ok = '- Ingredients: €340\n- Packaging: €45\n- Delivery: €35\n\n**Total Expenses:** €420';
    expect(checkStatedTotals(ok)).toEqual({ text: ok, corrections: [] });
    const de = '- Miete: 1.200,00 €\n- Strom: 89,50 €\n\nGesamtsumme: 1.289,50 €';
    expect(checkStatedTotals(de).corrections).toEqual([]);
    const profit = '- Revenue: €730\n- Costs: €420\n\n**Net profit total:** €310';
    expect(checkStatedTotals(profit).corrections).toEqual([]);
    const mixed = '- Hotel: €200\n- Flight: $300\n\nTotal: €500';
    expect(checkStatedTotals(mixed).corrections).toEqual([]);
    const code = '```\n- a: €1\n- b: €2\nTotal: €4\n```';
    expect(checkStatedTotals(code).corrections).toEqual([]);
  });

  it('corrects a German-format total in the same style', () => {
    const result = checkStatedTotals('- Miete: 1.200,00 €\n- Strom: 89,50 €\n\nGesamtsumme: 1.280,50 €');
    expect(result.text).toContain('Gesamtsumme: 1.289,50 €');
  });
});
