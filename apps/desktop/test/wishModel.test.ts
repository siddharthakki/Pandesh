import { describe, expect, it } from 'vitest';
import { buildWish, money, type WishDetailRec } from '../renderer-v2/src/wishModel';

// Synthetic record in the exact shape GET /v1/wishes/:id returns (test-only; never shipped as demo data).
const funds = { availableCents: 3000, verifiedRevenueCents: 3000, verifiedOwnFundsCents: 0, expensesCents: 0, taxReserveCents: 0, unverifiedInCents: 2500, unreconciledRevenueCents: 0, demoRevenueCents: 0 };
const offer = (p: number, level: 'exact' | 'related') => ({ id: `o${p}`, sourceUrl: `https://shop.example/${p}`, sourceTitle: 'Shop', priceCents: p, currency: 'EUR', matchLevel: level, excerpt: '', retrievedAt: '2026-11-22T10:00:00Z' });
const base = (): WishDetailRec => ({
  goal: { id: 'w1', wish: 'I want a Pi 5 for €90', productName: 'Raspberry Pi 5', productModel: '8GB', targetPriceCents: 9000, currency: 'EUR', status: 'active', stage: 'earn', purchasePlan: null, conversationId: null, createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-22T10:00:00Z' },
  offers: [offer(9500, 'related'), offer(8500, 'exact')],
  opportunities: [
    { id: 'p1', key: 'a', title: 'Logo design', status: 'excluded', score: 0.9, assessment: { exclusionReason: 'needs publishing' }, offering: null },
    { id: 'p2', key: 'b', title: 'CV formatting', status: 'selected', score: 0.7, assessment: { unitPriceCents: 2500, unitsNeeded: 3, pandeshDoes: 'drafts the template' }, offering: null },
  ],
  ledger: [
    { id: 'l1', kind: 'revenue', amountCents: 3000, currency: 'EUR', description: 'CV for A', status: 'verified', mode: 'real', orderId: 'ord1', paymentReference: 'ref', createdAt: '2026-11-21T10:00:00Z' },
    { id: 'l2', kind: 'revenue', amountCents: 2500, currency: 'EUR', description: 'CV for B', status: 'claimed', mode: 'real', orderId: 'ord2', paymentReference: null, createdAt: '2026-11-22T10:00:00Z' },
  ],
  readiness: { ready: false, blockers: ['Verified funds are €30; €85 is needed.'], bestExactOffer: offer(8500, 'exact'), bestRelatedOffer: offer(9500, 'related'), shortfallCents: 5500, funds },
});

describe('Wish to Reality model', () => {
  it('counts only verified money; claims wait for the owner and are named as the next step', () => {
    const v = buildWish(base());
    expect(v.priceCents).toBe(8500);
    expect(v.availableCents).toBe(3000);
    expect(v.progress).toBeCloseTo(3000 / 8500);
    expect(v.unverifiedCents).toBe(2500);
    expect(v.toVerify.map((e) => e.id)).toEqual(['l2']);
    expect(v.next).toMatch(/verify/);
    expect(v.stages.map((s) => s.state)).toEqual(['done', 'done', 'done', 'now', 'todo']);
  });

  it('the purchase price never exceeds the target; exact offers come first, the selected way to earn first', () => {
    const d = base();
    d.readiness.bestExactOffer = offer(9900, 'exact');
    const v = buildWish(d);
    expect(v.priceCents).toBe(9000);
    expect(v.offers[0].matchLevel).toBe('exact');
    expect(v.ways[0]).toMatchObject({ title: 'CV formatting', status: 'selected' });
    expect(v.ways[1].note).toMatch(/^Excluded/);
  });

  it('a prepared purchase is the owner\'s to carry out; demo money is flagged and never counted', () => {
    const d = base();
    d.goal.purchasePlan = { sourceUrl: 'https://shop.example/8500', priceCents: 8500, steps: ['Open it'], preparedAt: '2026-11-22T11:00:00Z' };
    d.ledger.push({ id: 'l3', kind: 'revenue', amountCents: 99900, currency: 'EUR', description: 'demo', status: 'verified', mode: 'demo', orderId: null, paymentReference: null, createdAt: '2026-11-22T12:00:00Z' });
    const v = buildWish(d);
    expect(v.next).toMatch(/buy it yourself/);
    expect(v.hasDemo).toBe(true);
    expect(v.availableCents).toBe(3000);
  });

  it('formats money without inventing precision', () => {
    expect(money(9000)).toBe('€90');
    expect(money(8550)).toBe('€85.50');
  });
});
