/**
 * Wish to Reality: a wish's journey from Core's records only (GET /v1/wishes/:id = goal, offers, opportunities, ledger,
 * readiness, orders). Money is never invented or recomputed into something bigger: "available" is Core's verified,
 * reconciled figure; unverified claims and demo money are shown beside it and never counted. Pandesh never buys:
 * a prepared purchase is a plan the owner carries out. Pure, so tested without a window.
 */
export const STAGES = [
  ['research_offers', 'Find the real price'],
  ['assess_opportunities', 'Pick a way to earn'],
  ['develop_offering', 'Build the offering'],
  ['earn', 'Earn, verified by you'],
  ['purchase_ready', 'Ready to buy'],
] as const;
export type StageId = (typeof STAGES)[number][0] | 'cancelled';

export interface WishOfferRec { id: string; sourceUrl: string; sourceTitle: string | null; priceCents: number; currency: string; matchLevel: 'exact' | 'related'; excerpt: string; retrievedAt: string }
export interface WishOpportunityRec { id: string; key: string; title: string; status: 'candidate' | 'selected' | 'excluded'; score: number; assessment: Record<string, unknown>; offering: Record<string, unknown> | null }
export interface WishLedgerRec { id: string; kind: 'revenue' | 'expense' | 'funds'; amountCents: number; currency: string; description: string; status: 'claimed' | 'verified' | 'rejected'; mode: 'real' | 'demo'; orderId: string | null; paymentReference: string | null; createdAt: string }
export interface WishFundsRec { availableCents: number; verifiedRevenueCents: number; verifiedOwnFundsCents: number; expensesCents: number; taxReserveCents: number; unverifiedInCents: number; unreconciledRevenueCents: number; demoRevenueCents: number }
export interface WishDetailRec {
  goal: { id: string; wish: string; productName: string; productModel: string | null; targetPriceCents: number; currency: string; status: 'active' | 'purchase_prepared' | 'cancelled'; stage: StageId; purchasePlan: { sourceUrl: string; priceCents: number; steps: string[]; preparedAt: string } | null; conversationId: string | null; createdAt: string; updatedAt: string };
  offers: WishOfferRec[]; opportunities: WishOpportunityRec[]; ledger: WishLedgerRec[];
  readiness: { ready: boolean; blockers: string[]; bestExactOffer: WishOfferRec | null; bestRelatedOffer: WishOfferRec | null; shortfallCents: number; funds: WishFundsRec };
  orders?: Array<{ id: string; mode: 'real' | 'demo'; status: string; channel: string; priceCents: number }>;
}

export function money(cents: number, currency = 'EUR'): string {
  const sym = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'GBP' ? '£' : `${currency} `;
  const v = cents / 100;
  return `${cents < 0 ? '−' : ''}${sym}${Math.abs(v).toFixed(Number.isInteger(v) ? 0 : 2)}`;
}

export interface WishView {
  id: string; title: string; wish: string; currency: string; cancelled: boolean;
  stages: Array<{ id: StageId; label: string; state: 'done' | 'now' | 'todo' }>;
  /** Price the purchase would be made at: the cheapest fresh exact offer, capped at the target. */
  priceCents: number; targetCents: number; bestExact: WishOfferRec | null; bestRelated: WishOfferRec | null;
  /** Verified, reconciled money only (Core's figure); never below 0 for the meter. */
  availableCents: number; unverifiedCents: number; demoCents: number; shortfallCents: number;
  /** 0..1 of the price covered by verified money. */
  progress: number;
  next: string; blockers: string[]; plan: WishDetailRec['goal']['purchasePlan'];
  toVerify: WishLedgerRec[]; ledger: WishLedgerRec[];
  ways: Array<{ title: string; status: WishOpportunityRec['status']; note: string }>;
  offers: WishOfferRec[]; hasDemo: boolean; updatedAt: string;
}

export function buildWish(d: WishDetailRec): WishView {
  const g = d.goal;
  const m = (c: number) => money(c, g.currency);
  const cancelled = g.status === 'cancelled' || g.stage === 'cancelled';
  const idx = STAGES.findIndex(([id]) => id === g.stage);
  const stages = STAGES.map(([id, label], i) => ({ id, label, state: (cancelled ? 'todo' : i < idx ? 'done' : i === idx ? 'now' : 'todo') as 'done' | 'now' | 'todo' }));
  const r = d.readiness;
  const priceCents = Math.min(r.bestExactOffer?.priceCents ?? g.targetPriceCents, g.targetPriceCents);
  const available = Math.max(0, r.funds.availableCents);
  const toVerify = d.ledger.filter((e) => e.status === 'claimed');
  const ways = d.opportunities
    .slice().sort((a, b) => (a.status === 'selected' ? -1 : b.status === 'selected' ? 1 : a.status === 'excluded' ? 1 : b.status === 'excluded' ? -1 : b.score - a.score))
    .map((o) => {
      const a = o.assessment as { unitPriceCents?: number; unitsNeeded?: number; exclusionReason?: string; pandeshDoes?: string };
      const note = o.status === 'excluded' ? `Excluded: ${a.exclusionReason ?? 'not suitable'}`
        : [a.unitPriceCents ? `${m(a.unitPriceCents)} each, ${a.unitsNeeded ?? '?'} to close the gap` : '', a.pandeshDoes ? `Pandesh does: ${a.pandeshDoes}` : ''].filter(Boolean).join(' · ') || `score ${o.score.toFixed(2)}`;
      return { title: o.title, status: o.status, note };
    });

  let next: string;
  if (cancelled) next = 'Cancelled. Nothing more happens on this wish.';
  else if (g.purchasePlan) next = `Ready: buy it yourself at ${m(g.purchasePlan.priceCents)}. Pandesh prepared the steps and never places orders or pays.`;
  else if (toVerify.length) next = `Check your statement: ${toVerify.length} payment${toVerify.length === 1 ? '' : 's'} (${m(toVerify.reduce((s, e) => s + e.amountCents, 0))}) wait for you to verify. Until then they do not count.`;
  else if (!d.offers.length) next = 'Pandesh has not researched the real price yet.';
  else if (!r.bestExactOffer) next = r.blockers[0] ?? 'No page offers the exact model yet.';
  else if (!d.opportunities.some((o) => o.status === 'selected')) next = 'Choose one way to earn the money.';
  else next = `Still to earn: ${m(r.shortfallCents)}, counted only once you verify each payment.`;

  return {
    id: g.id, title: g.productModel ? `${g.productName} (${g.productModel})` : g.productName, wish: g.wish, currency: g.currency, cancelled,
    stages, priceCents, targetCents: g.targetPriceCents, bestExact: r.bestExactOffer, bestRelated: r.bestRelatedOffer,
    availableCents: available, unverifiedCents: r.funds.unverifiedInCents, demoCents: r.funds.demoRevenueCents, shortfallCents: r.shortfallCents,
    progress: priceCents > 0 ? Math.min(1, available / priceCents) : 0,
    next, blockers: r.blockers, plan: g.purchasePlan, toVerify, ledger: d.ledger.slice().reverse(), ways,
    offers: d.offers.slice().sort((a, b) => (a.matchLevel === b.matchLevel ? a.priceCents - b.priceCents : a.matchLevel === 'exact' ? -1 : 1)),
    hasDemo: d.ledger.some((e) => e.mode === 'demo') || (d.orders ?? []).some((o) => o.mode === 'demo'), updatedAt: g.updatedAt,
  };
}
