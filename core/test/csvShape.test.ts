/** Re-run M3: a CSV the user asked for must open as one table. */
import { describe, expect, it } from 'vitest';
import { csvShapeProblem, parseCsvRows } from '../runtime/csvShape';

describe('csvShapeProblem', () => {
  it('rejects the re-run M3 file (separator lines)', () => {
    const m3 = 'Item,Quantity,Unit Price,Total Amount\nChicken Biryani,40,12,480\nVegetable Biryani,25,10,250\nTotal Revenue,0,0,730\n---\nExpense: Delivery,1,35,35\n';
    expect(csvShapeProblem(m3)).toMatch(/row 5 \("---"\) has 1 field but the header has 4/);
  });

  it('accepts a regular table with a trailing newline, CRLF and quoted commas', () => {
    expect(csvShapeProblem('Item,Amount (EUR)\r\nChicken biryani,480\r\n"Delivery, paid by me",35\r\nProfit,310\r\n')).toBeNull();
    expect(csvShapeProblem('a,b\n"line\nbreak",2')).toBeNull();
  });

  it('rejects blank lines inside and a one-column file', () => {
    expect(csvShapeProblem('a,b\n1,2\n\n3,4\n')).toMatch(/row 3/);
    expect(csvShapeProblem('just text\nmore\n')).toMatch(/one column/);
  });

  it('parses escaped quotes', () => {
    expect(parseCsvRows('"say ""hi""",x')).toEqual([['say "hi"', 'x']]);
  });
});
