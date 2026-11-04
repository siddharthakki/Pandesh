import { describe, expect, it } from 'vitest';
import { detectJugaadIntent, jugaadReadsFor } from '../src/host/desktopInteractionRouting';
import { composeJugaadAnswer } from '../src/host/jugaadAnswer';

describe('JUGAAD household intent routing', () => {
  it('routes questions about the user\'s own household data', () => {
    for (const q of [
      'How is my household doing? Give me my live Household Pulse, how much I have spent this month, and how many recovered receipts are in my vault.',
      'what is my household pulse', 'how much have I spent this month', 'show my expenses', 'how many receipts are in my vault',
    ]) expect(detectJugaadIntent(q), q).toBe(true);
  });

  it('never hijacks build/code requests or unrelated chat', () => {
    for (const q of ['build an expense tracker app', 'write a function that sums my expenses', 'what is the weather in Ulm', 'explain what a pulse oximeter is', 'summarise this file', ''])
      expect(detectJugaadIntent(q), q).toBe(false);
  });

  it('picks only the reads that were asked for, or all three for a general question', () => {
    expect(jugaadReadsFor('what is my household pulse')).toEqual({ pulse: true, expenses: false, vault: false });
    expect(jugaadReadsFor('how much have I spent')).toEqual({ pulse: false, expenses: true, vault: false });
    expect(jugaadReadsFor('recovered receipts in my vault')).toEqual({ pulse: false, expenses: false, vault: true });
    expect(jugaadReadsFor('what have we spent in my vault')).toMatchObject({ expenses: true, vault: true });
  });
});

describe('composeJugaadAnswer', () => {
  const pulse = JSON.stringify({ ok: true, status: 'WATCH', headline: 'On track', projectedAmount: 1234.5, projectedLabel: 'Projected spend', daysLeft: 9, topRisk: 'Rent due' });
  const expenses = JSON.stringify({ summary: { transactionsCounted: 2, excludedTransactions: 1, sumOfAmountsByCurrency: { EUR: 49.75 }, complete: true, note: 'x' }, ok: true });
  const vault = JSON.stringify({ recoveredReceipts: 3, ok: true, total: 5, byCategory: { RECEIPT: 4, OTHER: 1 } });

  it('states only tool-returned figures, with completeness', () => {
    const text = composeJugaadAnswer({ pulse, expenses, vault, period: { from: '2026-10-01', to: '2026-10-31' } });
    expect(text).toContain('status WATCH');
    expect(text).toContain('49.75 EUR');
    expect(text).toContain('Covers every transaction');
    expect(text).toContain('recovered receipts: 3');
  });

  it('reports a partial expense page and per-read failures honestly', () => {
    const partial = JSON.stringify({ summary: { transactionsCounted: 1, excludedTransactions: 0, sumOfAmountsByCurrency: { EUR: 5 }, complete: false, note: 'PARTIAL: 1 of 500' } });
    expect(composeJugaadAnswer({ expenses: partial })).toContain('PARTIAL: 1 of 500');
    const failed = composeJugaadAnswer({ errors: { pulse: 'pulse_unavailable: open the Wallet screen once' } });
    expect(failed).toContain('Household Pulse: unavailable — pulse_unavailable');
  });
});
