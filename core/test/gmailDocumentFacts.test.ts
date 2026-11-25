import { describe, expect, it } from 'vitest';
import { documentFacts, documentsTable, keyLines } from '../runtime/connectors/gmailDocumentFacts';

describe('what a billing document itself prints', () => {
  it('reads number, date and total from a German invoice and keeps the lines it read them from', () => {
    const text = ['Musterfirma GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-0147', 'Rechnungsdatum: 28.01.2026', 'Position 1  Beschreibung   100,00', 'Netto 100,00 €', 'MwSt 19% 19,00 €', 'Gesamtbetrag 119,00 €'].join('\n');
    const f = documentFacts(text);
    expect(f.number).toBe('RE-2026-0147');
    expect(f.date).toBe('28.01.2026');
    expect(f.total).toBe('119,00 €');
    expect(f.evidence).toEqual(['Rechnungsnummer: RE-2026-0147', 'Rechnungsdatum: 28.01.2026', 'Gesamtbetrag 119,00 €']);
  });
  it('reads an English invoice, and the last total wins', () => {
    const f = documentFacts('Invoice No. INV-884\nInvoice date: 2026-02-10\nSubtotal 40.00\nTotal 10.00 EUR\nTotal amount due 50.00 EUR');
    expect(f.number).toBe('INV-884');
    expect(f.date).toBe('2026-02-10');
    expect(f.total).toBe('50.00 €');
  });
  it('says nothing was found instead of guessing', () => {
    const f = documentFacts('Thank you for your order.\nSee you soon.');
    expect(f).toEqual({ number: null, date: null, total: null, evidence: [] });
    expect(documentsTable([{ receivedLocal: 'Wed, 28 Jan 2026', subject: 's', filename: 'a.pdf', facts: f, status: 'read', messageId: 'm1' }])).toContain('| Wed, 28 Jan 2026 | not found | not found | not found | a.pdf | m1 |');
  });
  it('keyLines keeps only labelled lines, once each, bounded', () => {
    const lines = keyLines(['Hello', 'Rechnungsnummer: 1', 'Rechnungsnummer: 1', 'Summe 5,00 €', ...Array.from({ length: 50 }, (_, i) => `Betrag ${i},00`)].join('\n'), 5);
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe('Rechnungsnummer: 1');
  });
});
