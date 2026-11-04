/**
 * Wish-to-Reality — a durable goal to buy something, and the honest path to paying for it.
 *
 * What this module owns:
 *   - the goal (what the user wants, the price they set, the product facts found so far),
 *   - the market snapshot (offers taken from retrieved pages, each with its URL, excerpt and hash),
 *   - the earning opportunities assessed for the goal and the one selected,
 *   - the funds ledger, where a claim and the truth are different things,
 *   - purchase readiness: a plan is prepared only when a fresh offer meets the price AND verified funds cover it.
 *
 * What it deliberately does not own:
 *   - any external action. Nothing here publishes an offer, contacts a customer, takes a payment or buys anything.
 *   - verification of money. An assistant can record a 'claimed' entry; only a person (an API client, never Core or
 *     the model) can mark it verified. Unverified revenue never counts as available funds. Claimed expenses do count
 *     against funds, because over-counting money is the failure that matters.
 *   - demonstration money. An entry recorded in 'demo' mode is shown on its own line and never counts, verified or not.
 *     Real revenue counts only when it is reconciled: verified by a person with the payment's bank/PayPal reference
 *     against an order whose invoice was issued for exactly that amount (see wishOrders.ts).
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export const WISH_STAGES = ['research_offers', 'assess_opportunities', 'develop_offering', 'earn', 'purchase_ready', 'cancelled'] as const;
export type WishStage = (typeof WISH_STAGES)[number];
export const WISH_LEDGER_KINDS = ['revenue', 'expense', 'funds'] as const;
export type WishLedgerKind = (typeof WISH_LEDGER_KINDS)[number];
export type WishMoneyMode = 'real' | 'demo';
/** An offer older than this is not good enough to buy on. */
export const WISH_OFFER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_WISH_CHARS = 1_000;

export interface WishGoal {
  id: string;
  wish: string;
  productName: string;
  productModel: string | null;
  targetPriceCents: number;
  currency: string;
  specs: Record<string, Array<{ value: string; source: string }>>;
  status: 'active' | 'purchase_prepared' | 'cancelled';
  stage: WishStage;
  selectedOpportunityId: string | null;
  purchasePlan: WishPurchasePlan | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WishOffer {
  id: string;
  goalId: string;
  sourceUrl: string;
  sourceTitle: string | null;
  priceCents: number;
  currency: string;
  /** 'exact' = the page is about the exact model; 'related' = a sibling variant or family page. Only exact offers can be bought. */
  matchLevel: 'exact' | 'related';
  /** How the price was read: the page's own "from" price (title or body) or a listed price. */
  basis: 'title_from_price' | 'body_from_price' | 'listed_price';
  excerpt: string;
  evidenceHash: string;
  retrievedAt: string;
}

export interface WishOpportunity {
  id: string;
  goalId: string;
  key: string;
  title: string;
  status: 'candidate' | 'selected' | 'excluded';
  score: number;
  assessment: Record<string, unknown>;
  offering: Record<string, unknown> | null;
}

export interface WishLedgerEntry {
  id: string;
  goalId: string;
  kind: WishLedgerKind;
  amountCents: number;
  currency: string;
  description: string;
  evidenceKind: string | null;
  evidenceRef: string | null;
  status: 'claimed' | 'verified' | 'rejected';
  mode: WishMoneyMode;
  orderId: string | null;
  /** The bank/PayPal reference a person reconciled the payment with. */
  paymentReference: string | null;
  recordedBy: string;
  verifiedBy: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

export interface WishFunds {
  /** Real money only: reconciled revenue + verified own funds − real expenses (claimed or verified) − the tax reserve. */
  availableCents: number;
  /** Real revenue verified by a person against an invoiced order with a payment reference. */
  verifiedRevenueCents: number;
  verifiedOwnFundsCents: number;
  expensesCents: number;
  /** Set aside for income tax on the profit, at the rate the person recorded in the business authorization. */
  taxReserveCents: number;
  /** Real revenue or funds recorded but not yet verified by a person. Never counted. */
  unverifiedInCents: number;
  /** Real revenue a person marked verified that is not reconciled to an invoiced order. Never counted. */
  unreconciledRevenueCents: number;
  /** Demonstration money (any status). Never counted. */
  demoRevenueCents: number;
}

export interface WishPurchasePlan {
  preparedAt: string;
  offerId: string;
  sourceUrl: string;
  priceCents: number;
  currency: string;
  availableCents: number;
  /** The plan is never executed by Pandesh. */
  executed: false;
  steps: string[];
}

export interface WishPurchaseReadiness {
  ready: boolean;
  blockers: string[];
  bestExactOffer: WishOffer | null;
  bestRelatedOffer: WishOffer | null;
  /** What still has to be earned to buy the best exact offer (or the target, when there is none). */
  shortfallCents: number;
  funds: WishFunds;
}

export function formatMoney(cents: number, currency = 'EUR'): string {
  const symbol = currency === 'EUR' ? '€' : currency === 'USD' ? '$' : currency === 'GBP' ? '£' : `${currency} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

/** "1.234,56" / "1,234.56" / "220,78" / "200" → cents. */
export function parseAmountToCents(raw: string): number | null {
  let s = raw.trim().replace(/\s/g, '');
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const lastSep = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'));
  if (lastSep >= 0 && s.length - lastSep - 1 === 2) {
    s = `${s.slice(0, lastSep).replace(/[.,]/g, '')}.${s.slice(lastSep + 1)}`;
  } else {
    s = s.replace(/[.,]/g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

/**
 * Reads a wish in plain words: the product, a model number if one is named, and the price the user set.
 * "I want the AOC CU34G4ZCA monitor for €200" → { productName: 'AOC CU34G4ZCA monitor', productModel: 'CU34G4ZCA', 20000, 'EUR' }.
 */
export function parseWish(text: string): { productName: string | null; productModel: string | null; targetPriceCents: number | null; currency: string } {
  const t = text.replace(/\s+/g, ' ').trim();
  const priceMatch = /(€|EUR|eur|\$|USD|£|GBP)\s?(\d[\d.,]*)|(\d[\d.,]*)\s?(€|EUR|euros?|Euro|\$|USD|dollars?|£|GBP|pounds?)\b/.exec(t);
  let targetPriceCents: number | null = null;
  let currency = 'EUR';
  if (priceMatch) {
    const unit = (priceMatch[1] ?? priceMatch[4] ?? '').toLowerCase();
    targetPriceCents = parseAmountToCents(priceMatch[2] ?? priceMatch[3] ?? '');
    currency = /\$|usd|dollar/.test(unit) ? 'USD' : /£|gbp|pound/.test(unit) ? 'GBP' : 'EUR';
  }
  const productModel = /\b(?=[A-Z0-9-]*\d)(?=[A-Z0-9-]*[A-Z])[A-Z0-9][A-Z0-9-]{4,}\b/.exec(t)?.[0] ?? null;
  const productMatch = /\b(?:want|need|buy|get|wish for|like)\s+(?:to buy\s+|to get\s+|to have\s+)?(?:the|a|an|my|this)?\s*(.+?)(?:\s+(?:for|at|under|below|costing|priced at)\s+(?:€|EUR|\$|£|\d)|[.,;!?]|$)/i.exec(t);
  const productName = productMatch?.[1]?.trim() || null;
  return { productName, productModel, targetPriceCents, currency };
}

function asGoal(row: Record<string, unknown>): WishGoal {
  return {
    id: String(row.id),
    wish: String(row.wish),
    productName: String(row.productName),
    productModel: (row.productModel as string) ?? null,
    targetPriceCents: Number(row.targetPriceCents),
    currency: String(row.currency),
    specs: JSON.parse(String(row.specsJson || '{}')),
    status: row.status as WishGoal['status'],
    stage: row.stage as WishStage,
    selectedOpportunityId: (row.selectedOpportunityId as string) ?? null,
    purchasePlan: row.purchasePlanJson ? JSON.parse(String(row.purchasePlanJson)) : null,
    conversationId: (row.conversationId as string) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}
function asOffer(row: Record<string, unknown>): WishOffer {
  return {
    id: String(row.id), goalId: String(row.goalId), sourceUrl: String(row.sourceUrl), sourceTitle: (row.sourceTitle as string) ?? null,
    priceCents: Number(row.priceCents), currency: String(row.currency), matchLevel: row.matchLevel as WishOffer['matchLevel'],
    basis: row.basis as WishOffer['basis'], excerpt: String(row.excerpt), evidenceHash: String(row.evidenceHash), retrievedAt: String(row.retrievedAt),
  };
}
function asOpportunity(row: Record<string, unknown>): WishOpportunity {
  return {
    id: String(row.id), goalId: String(row.goalId), key: String(row.key), title: String(row.title), status: row.status as WishOpportunity['status'],
    score: Number(row.score), assessment: JSON.parse(String(row.assessmentJson)), offering: row.offeringJson ? JSON.parse(String(row.offeringJson)) : null,
  };
}
function asLedger(row: Record<string, unknown>): WishLedgerEntry {
  return {
    id: String(row.id), goalId: String(row.goalId), kind: row.kind as WishLedgerKind, amountCents: Number(row.amountCents), currency: String(row.currency),
    description: String(row.description), evidenceKind: (row.evidenceKind as string) ?? null, evidenceRef: (row.evidenceRef as string) ?? null,
    status: row.status as WishLedgerEntry['status'], mode: (row.mode as WishMoneyMode) ?? 'real', orderId: (row.orderId as string) ?? null,
    paymentReference: (row.paymentReference as string) ?? null, recordedBy: String(row.recordedBy), verifiedBy: (row.verifiedBy as string) ?? null,
    createdAt: String(row.createdAt), verifiedAt: (row.verifiedAt as string) ?? null,
  };
}

export function getWishGoal(db: CoreDatabase, id: string): WishGoal {
  const row = db.get<Record<string, unknown>>('SELECT * FROM wish_goals WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `wish goal '${id}' not found`);
  return asGoal(row);
}
export function listWishGoals(db: CoreDatabase, opts: { activeOnly?: boolean } = {}): WishGoal[] {
  const sql = opts.activeOnly ? "SELECT * FROM wish_goals WHERE status != 'cancelled' ORDER BY createdAt DESC" : 'SELECT * FROM wish_goals ORDER BY createdAt DESC';
  return db.all<Record<string, unknown>>(sql).map(asGoal);
}
/**
 * The goal a tool call means when it names none (or passes something that is not a goal id, such as a model's
 * placeholder): the most recent one that is not cancelled. A well-formed id that does not exist is still an error.
 */
export function resolveWishGoal(db: CoreDatabase, id?: string | null): WishGoal {
  if (id && /^wish_[\w-]+$/.test(id)) return getWishGoal(db, id);
  const latest = listWishGoals(db, { activeOnly: true })[0];
  if (!latest) throw new CoreError('not_found', 'no wish goal exists yet');
  return latest;
}

export interface CreateWishGoalInput {
  wish: string;
  productName?: string | null;
  productModel?: string | null;
  targetPriceCents?: number | null;
  currency?: string | null;
  conversationId?: string | null;
  attemptId?: string | null;
}

/** Creates the goal, or returns the open goal for the same product and price (asking twice makes one goal). */
export function createWishGoal(db: CoreDatabase, input: CreateWishGoalInput): { goal: WishGoal; created: boolean } {
  const wish = String(input.wish ?? '').replace(/\s+/g, ' ').trim();
  if (!wish || wish.length > MAX_WISH_CHARS) throw new CoreError('invalid_request', `the wish must be between 1 and ${MAX_WISH_CHARS} characters`);
  const parsed = parseWish(wish);
  const productModel = (input.productModel?.trim() || parsed.productModel) ?? null;
  const productName = input.productName?.trim() || parsed.productName || productModel;
  const targetPriceCents = input.targetPriceCents ?? parsed.targetPriceCents;
  const currency = (input.currency?.trim().toUpperCase() || parsed.currency || 'EUR').slice(0, 3);
  if (!productName) throw new CoreError('invalid_request', 'the wish does not say what to buy');
  if (!targetPriceCents || targetPriceCents <= 0) throw new CoreError('invalid_request', 'the wish does not say the price to aim for (e.g. "for €200")');
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>(
      "SELECT * FROM wish_goals WHERE status != 'cancelled' AND lower(productName) = lower(?) AND targetPriceCents = ? AND currency = ?",
      [productName, targetPriceCents, currency],
    );
    if (existing) return { goal: asGoal(existing), created: false };
    const id = newId('wish');
    const now = nowIso();
    db.run(
      'INSERT INTO wish_goals (id, wish, productName, productModel, targetPriceCents, currency, specsJson, status, stage, conversationId, attemptId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id, wish, productName, productModel, targetPriceCents, currency, '{}', 'active', 'research_offers', input.conversationId ?? null, input.attemptId ?? null, now, now],
    );
    return { goal: getWishGoal(db, id), created: true };
  });
}

/** The user changes the price they aim for (e.g. after seeing the market). The purchase check is re-run by the caller. */
export function updateWishTarget(db: CoreDatabase, goalId: string, targetPriceCents: number): WishGoal {
  if (!Number.isInteger(targetPriceCents) || targetPriceCents <= 0) throw new CoreError('invalid_request', 'the target price must be a positive amount');
  getWishGoal(db, goalId);
  db.run('UPDATE wish_goals SET targetPriceCents = ?, updatedAt = ? WHERE id = ?', [targetPriceCents, nowIso(), goalId]);
  return getWishGoal(db, goalId);
}

export function setWishStage(db: CoreDatabase, goalId: string, stage: WishStage): void {
  db.run('UPDATE wish_goals SET stage = ?, updatedAt = ? WHERE id = ?', [stage, nowIso(), goalId]);
}
export function setWishSpecs(db: CoreDatabase, goalId: string, specs: WishGoal['specs']): void {
  db.run('UPDATE wish_goals SET specsJson = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(specs), nowIso(), goalId]);
}

/** Replaces the market snapshot with the offers read from this retrieval. */
export function replaceWishOffers(db: CoreDatabase, goalId: string, offers: Array<Omit<WishOffer, 'id' | 'goalId'>>): WishOffer[] {
  return db.transaction(() => {
    db.run('DELETE FROM wish_offers WHERE goalId = ?', [goalId]);
    for (const o of offers) {
      db.run(
        'INSERT INTO wish_offers (id, goalId, sourceUrl, sourceTitle, priceCents, currency, matchLevel, basis, excerpt, evidenceHash, retrievedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [newId('woffer'), goalId, o.sourceUrl, o.sourceTitle, o.priceCents, o.currency, o.matchLevel, o.basis, o.excerpt.slice(0, 400), o.evidenceHash, o.retrievedAt],
      );
    }
    return listWishOffers(db, goalId);
  });
}
export function listWishOffers(db: CoreDatabase, goalId: string): WishOffer[] {
  return db.all<Record<string, unknown>>('SELECT * FROM wish_offers WHERE goalId = ? ORDER BY priceCents', [goalId]).map(asOffer);
}

export function replaceWishOpportunities(db: CoreDatabase, goalId: string, items: Array<{ key: string; title: string; status: 'candidate' | 'excluded'; score: number; assessment: Record<string, unknown> }>): WishOpportunity[] {
  return db.transaction(() => {
    const now = nowIso();
    for (const item of items) {
      db.run(
        `INSERT INTO wish_opportunities (id, goalId, key, title, status, score, assessmentJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(goalId, key) DO UPDATE SET title = excluded.title, score = excluded.score, assessmentJson = excluded.assessmentJson, updatedAt = excluded.updatedAt,
           status = CASE WHEN wish_opportunities.status = 'selected' THEN 'selected' ELSE excluded.status END`,
        [newId('wopp'), goalId, item.key, item.title, item.status, item.score, JSON.stringify(item.assessment), now, now],
      );
    }
    return listWishOpportunities(db, goalId);
  });
}
export function listWishOpportunities(db: CoreDatabase, goalId: string): WishOpportunity[] {
  return db.all<Record<string, unknown>>('SELECT * FROM wish_opportunities WHERE goalId = ? ORDER BY score DESC', [goalId]).map(asOpportunity);
}
export function selectWishOpportunity(db: CoreDatabase, goalId: string, key: string): WishOpportunity {
  return db.transaction(() => {
    const row = db.get<Record<string, unknown>>('SELECT * FROM wish_opportunities WHERE goalId = ? AND key = ?', [goalId, key]);
    if (!row) throw new CoreError('not_found', `opportunity '${key}' was not assessed for this goal`);
    if (row.status === 'excluded') throw new CoreError('invalid_request', `opportunity '${key}' was excluded: ${String(JSON.parse(String(row.assessmentJson)).exclusionReason ?? '')}`);
    const now = nowIso();
    db.run("UPDATE wish_opportunities SET status = 'candidate', updatedAt = ? WHERE goalId = ? AND status = 'selected'", [now, goalId]);
    db.run("UPDATE wish_opportunities SET status = 'selected', updatedAt = ? WHERE id = ?", [now, row.id]);
    db.run('UPDATE wish_goals SET selectedOpportunityId = ?, updatedAt = ? WHERE id = ?', [row.id, now, goalId]);
    return asOpportunity(db.get<Record<string, unknown>>('SELECT * FROM wish_opportunities WHERE id = ?', [row.id])!);
  });
}
export function setWishOffering(db: CoreDatabase, opportunityId: string, offering: Record<string, unknown>): void {
  db.run('UPDATE wish_opportunities SET offeringJson = ?, updatedAt = ? WHERE id = ?', [JSON.stringify(offering), nowIso(), opportunityId]);
}

/** Records money as a claim. Nothing recorded here counts as income until a person verifies it. */
export function recordWishLedgerClaim(db: CoreDatabase, input: { goalId: string; kind: string; amountCents: number; currency?: string | null; description: string; evidenceKind?: string | null; evidenceRef?: string | null; recordedBy: string; mode?: WishMoneyMode; orderId?: string | null }): WishLedgerEntry {
  const goal = getWishGoal(db, input.goalId);
  if (!(WISH_LEDGER_KINDS as readonly string[]).includes(input.kind)) throw new CoreError('invalid_request', `kind must be one of ${WISH_LEDGER_KINDS.join(', ')}`);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) throw new CoreError('invalid_request', 'amount must be a positive amount of money');
  const currency = (input.currency || goal.currency).toUpperCase();
  if (currency !== goal.currency) throw new CoreError('invalid_request', `the goal is in ${goal.currency}; record amounts in ${goal.currency}`);
  const description = String(input.description ?? '').trim().slice(0, 500);
  if (!description) throw new CoreError('invalid_request', 'say what the money is');
  // Money for an order takes the order's mode: a payment on a demonstration order is demonstration money.
  const order = input.orderId ? db.get<{ goalId: string; mode: WishMoneyMode }>('SELECT goalId, mode FROM wish_orders WHERE id = ?', [input.orderId]) : undefined;
  if (input.orderId && (!order || order.goalId !== goal.id)) throw new CoreError('not_found', `order '${input.orderId}' does not belong to this goal`);
  const mode: WishMoneyMode = order?.mode ?? (input.mode === 'demo' ? 'demo' : 'real');
  if (input.mode && input.mode !== mode) throw new CoreError('invalid_request', `order '${input.orderId}' is a ${mode} order; its money is ${mode} money`);
  // One payment reference is one payment: reporting it again returns the claim already recorded.
  const evidenceRef = input.evidenceRef?.trim() || null;
  if (evidenceRef) {
    const again = db.get<Record<string, unknown>>("SELECT * FROM wish_ledger WHERE goalId = ? AND kind = ? AND amountCents = ? AND evidenceRef = ? AND status != 'rejected'", [goal.id, input.kind, input.amountCents, evidenceRef]);
    if (again) return asLedger(again);
    // A demonstration payment's reference stays demonstration money, whatever kind, amount or order it is reported as.
    if (mode === 'real' && db.get("SELECT 1 FROM wish_ledger WHERE goalId = ? AND mode = 'demo' AND status != 'rejected' AND (evidenceRef = ? OR paymentReference = ?)", [goal.id, evidenceRef, evidenceRef])) {
      throw new CoreError('invalid_request', `reference '${evidenceRef}' belongs to a DEMO payment; demonstration money never becomes real money`);
    }
  }
  const id = newId('wledger');
  db.run(
    'INSERT INTO wish_ledger (id, goalId, kind, amountCents, currency, description, evidenceKind, evidenceRef, status, recordedBy, createdAt, mode, orderId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, goal.id, input.kind, input.amountCents, currency, description, input.evidenceKind ?? null, input.evidenceRef ?? null, 'claimed', input.recordedBy, nowIso(), mode, input.orderId ?? null],
  );
  return asLedger(db.get<Record<string, unknown>>('SELECT * FROM wish_ledger WHERE id = ?', [id])!);
}

/** Actors that may never verify money: Core itself and anything the model drives. */
export function isAssistantActor(actor: string): boolean {
  return /^(core|karkedikha|pi|model|assistant|agent)(:|$)/i.test(actor.trim()) || actor.trim() === '';
}

/**
 * A person resolves a claim. Verifying revenue is a reconciliation: the person gives the payment's reference from their
 * bank/PayPal statement, and the entry must belong to an order whose invoice was issued for exactly this amount. The
 * order is then marked paid.
 */
export function verifyWishLedgerEntry(db: CoreDatabase, entryId: string, resolution: 'verified' | 'rejected', actor: string, opts: { paymentReference?: string | null } = {}): WishLedgerEntry {
  if (isAssistantActor(actor)) throw new CoreError('forbidden', 'only a person can verify money; an assistant can only record a claim');
  return db.transaction(() => {
    const row = db.get<Record<string, unknown>>('SELECT * FROM wish_ledger WHERE id = ?', [entryId]);
    if (!row) throw new CoreError('not_found', `ledger entry '${entryId}' not found`);
    if (row.status !== 'claimed') throw new CoreError('invalid_transition', `ledger entry is already ${String(row.status)}`);
    const reference = String(opts.paymentReference ?? '').trim().slice(0, 200) || null;
    const now = nowIso();
    if (resolution === 'verified' && row.kind === 'revenue') {
      if (!reference) throw new CoreError('invalid_request', 'give the payment reference from your bank or PayPal statement to reconcile this revenue');
      // One statement line reconciles one payment; a real payment never borrows a demonstration's reference.
      const used = db.get<{ id: string; mode: string }>("SELECT id, mode FROM wish_ledger WHERE id != ? AND status = 'verified' AND paymentReference = ?", [entryId, reference])
        ?? (row.mode === 'real' ? db.get<{ id: string; mode: string }>("SELECT id, mode FROM wish_ledger WHERE id != ? AND mode = 'demo' AND status != 'rejected' AND evidenceRef = ?", [entryId, reference]) : undefined);
      if (used) throw new CoreError('invalid_request', `reference '${reference}' already belongs to ${used.mode === 'demo' ? 'a DEMO payment' : 'another payment'} (${used.id}); one statement line reconciles one payment`);
      const order = row.orderId ? db.get<{ id: string; invoiceNumber: string | null; priceCents: number; eventsJson: string }>('SELECT id, invoiceNumber, priceCents, eventsJson FROM wish_orders WHERE id = ?', [String(row.orderId)]) : undefined;
      if (!order) throw new CoreError('invalid_request', 'revenue can only be reconciled against a customer order; this entry has none');
      if (!order.invoiceNumber) throw new CoreError('invalid_request', `order ${order.id} has no issued invoice yet`);
      if (order.priceCents !== Number(row.amountCents)) throw new CoreError('invalid_request', `the payment (${formatMoney(Number(row.amountCents), String(row.currency))}) does not match invoice ${order.invoiceNumber} (${formatMoney(order.priceCents, String(row.currency))})`);
      const events = [...JSON.parse(order.eventsJson || '[]'), { at: now, by: 'human', step: `payment reconciled (${reference})` }];
      db.run("UPDATE wish_orders SET status = 'paid', eventsJson = ?, updatedAt = ? WHERE id = ?", [JSON.stringify(events), now, order.id]);
    }
    db.run('UPDATE wish_ledger SET status = ?, verifiedBy = ?, verifiedAt = ?, paymentReference = ? WHERE id = ?', [resolution, actor, now, reference, entryId]);
    return asLedger(db.get<Record<string, unknown>>('SELECT * FROM wish_ledger WHERE id = ?', [entryId])!);
  });
}
export function listWishLedger(db: CoreDatabase, goalId: string): WishLedgerEntry[] {
  return db.all<Record<string, unknown>>('SELECT * FROM wish_ledger WHERE goalId = ? ORDER BY createdAt', [goalId]).map(asLedger);
}

const isReconciled = (e: WishLedgerEntry) => e.kind === 'revenue' && e.status === 'verified' && Boolean(e.paymentReference && e.orderId);

export function wishFunds(db: CoreDatabase, goalId: string): WishFunds {
  const entries = listWishLedger(db, goalId);
  const real = entries.filter((e) => e.mode === 'real');
  const sum = (list: WishLedgerEntry[], pred: (e: WishLedgerEntry) => boolean) => list.filter(pred).reduce((acc, e) => acc + e.amountCents, 0);
  const verifiedRevenueCents = sum(real, isReconciled);
  const verifiedOwnFundsCents = sum(real, (e) => e.kind === 'funds' && e.status === 'verified');
  const expensesCents = sum(real, (e) => e.kind === 'expense' && e.status !== 'rejected');
  const unverifiedInCents = sum(real, (e) => e.kind !== 'expense' && e.status === 'claimed');
  const unreconciledRevenueCents = sum(real, (e) => e.kind === 'revenue' && e.status === 'verified' && !isReconciled(e));
  const demoRevenueCents = sum(entries.filter((e) => e.mode === 'demo'), (e) => e.kind === 'revenue' && e.status !== 'rejected');
  const reserveBps = db.get<{ taxReserveBps: number }>("SELECT taxReserveBps FROM wish_business WHERE id = 'default'")?.taxReserveBps ?? 0;
  const taxReserveCents = Math.ceil((Math.max(0, verifiedRevenueCents - expensesCents) * reserveBps) / 10_000);
  return {
    availableCents: verifiedRevenueCents + verifiedOwnFundsCents - expensesCents - taxReserveCents,
    verifiedRevenueCents, verifiedOwnFundsCents, expensesCents, taxReserveCents, unverifiedInCents, unreconciledRevenueCents, demoRevenueCents,
  };
}

/**
 * Whether the goal can be bought now, and if so the prepared (never executed) plan. Ready only when an exact-model
 * offer retrieved within the last week costs no more than the target price and verified funds cover it.
 */
export function evaluateWishPurchase(db: CoreDatabase, goalId: string, nowMs = Date.now()): WishPurchaseReadiness {
  const goal = getWishGoal(db, goalId);
  const offers = listWishOffers(db, goalId);
  const fresh = offers.filter((o) => nowMs - Date.parse(o.retrievedAt) <= WISH_OFFER_MAX_AGE_MS);
  const bestExactOffer = fresh.filter((o) => o.matchLevel === 'exact').sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
  const bestRelatedOffer = fresh.filter((o) => o.matchLevel === 'related').sort((a, b) => a.priceCents - b.priceCents)[0] ?? null;
  const funds = wishFunds(db, goalId);
  const blockers: string[] = [];
  if (!offers.length) blockers.push('No offer has been researched yet.');
  else if (!fresh.length) blockers.push('The researched offers are more than a week old; research again before buying.');
  else if (!bestExactOffer) blockers.push(`No retrieved page offers the exact model${goal.productModel ? ` ${goal.productModel}` : ''}.`);
  if (bestExactOffer && bestExactOffer.priceCents > goal.targetPriceCents) {
    blockers.push(`The lowest exact offer is ${formatMoney(bestExactOffer.priceCents, goal.currency)}, above the target of ${formatMoney(goal.targetPriceCents, goal.currency)}.`);
  }
  // The target is the spending limit: nothing above it is bought, so more than the target never has to be earned.
  const priceToPay = Math.min(bestExactOffer?.priceCents ?? goal.targetPriceCents, goal.targetPriceCents);
  if (funds.availableCents < priceToPay) {
    blockers.push(`Verified funds are ${formatMoney(Math.max(0, funds.availableCents), goal.currency)}; ${formatMoney(priceToPay, goal.currency)} is needed.`);
  }
  const ready = blockers.length === 0 && bestExactOffer !== null;
  return { ready, blockers, bestExactOffer, bestRelatedOffer, shortfallCents: Math.max(0, priceToPay - funds.availableCents), funds };
}

/** Stores the purchase plan when the goal is ready; clears a stale one when it no longer is. Never buys. */
export function prepareWishPurchase(db: CoreDatabase, goalId: string, nowMs = Date.now()): WishPurchaseReadiness & { plan: WishPurchasePlan | null } {
  const readiness = evaluateWishPurchase(db, goalId, nowMs);
  const goal = getWishGoal(db, goalId);
  if (!readiness.ready || !readiness.bestExactOffer) {
    if (goal.status === 'purchase_prepared') db.run("UPDATE wish_goals SET status = 'active', purchasePlanJson = NULL, updatedAt = ? WHERE id = ?", [nowIso(), goalId]);
    return { ...readiness, plan: null };
  }
  const offer = readiness.bestExactOffer;
  const plan: WishPurchasePlan = {
    preparedAt: new Date(nowMs).toISOString(),
    offerId: offer.id,
    sourceUrl: offer.sourceUrl,
    priceCents: offer.priceCents,
    currency: offer.currency,
    availableCents: readiness.funds.availableCents,
    executed: false,
    steps: [
      `Open ${offer.sourceUrl} and confirm the listing is the ${goal.productModel ?? goal.productName}, new, at ${formatMoney(offer.priceCents, offer.currency)} including shipping.`,
      'Check the seller, delivery time and return policy.',
      'Pay with your own payment method. Pandesh does not place orders or pay.',
      'Tell Pandesh the order total so it can be recorded as an expense against this goal.',
    ],
  };
  db.run("UPDATE wish_goals SET status = 'purchase_prepared', stage = 'purchase_ready', purchasePlanJson = ?, updatedAt = ? WHERE id = ?", [JSON.stringify(plan), nowIso(), goalId]);
  return { ...readiness, plan };
}

export function wishView(db: CoreDatabase, goalId: string, nowMs = Date.now()) {
  const goal = getWishGoal(db, goalId);
  return {
    goal,
    offers: listWishOffers(db, goalId),
    opportunities: listWishOpportunities(db, goalId),
    ledger: listWishLedger(db, goalId),
    readiness: evaluateWishPurchase(db, goalId, nowMs),
  };
}

/** The goal's state in plain words, every figure from the records. */
export function renderWishStatus(db: CoreDatabase, goalId: string, nowMs = Date.now()): string {
  const { goal, offers, opportunities, ledger, readiness } = wishView(db, goalId, nowMs);
  const m = (c: number) => formatMoney(c, goal.currency);
  const lines: string[] = [];
  lines.push(`WISH GOAL ${goal.id} — ${goal.productName} for ${m(goal.targetPriceCents)} (stage: ${goal.stage}${goal.status === 'purchase_prepared' ? ', purchase prepared' : ''})`);
  const best = readiness.bestExactOffer;
  lines.push(`BOTTOM LINE (quote these figures, do not recompute): ${best ? `cheapest exact offer ${m(best.priceCents)} (target ${m(goal.targetPriceCents)}${best.priceCents > goal.targetPriceCents ? `, ${m(best.priceCents - goal.targetPriceCents)} over target` : ''})` : 'no exact offer found'}; verified funds ${m(Math.max(0, readiness.funds.availableCents))}; still to earn ${m(readiness.shortfallCents)}; purchase ${goal.purchasePlan ? 'prepared, not executed' : 'not ready'}.`);
  const specs = Object.entries(goal.specs);
  if (specs.length) lines.push(`Product facts found: ${specs.map(([k, v]) => `${k} ${[...new Set(v.map((x) => x.value))].join(' / ')}`).join('; ')}`);
  if (offers.length) {
    lines.push(`Offers (retrieved ${offers[0].retrievedAt.slice(0, 16).replace('T', ' ')}Z):`);
    for (const o of offers.slice(0, 6)) lines.push(`- ${m(o.priceCents)} ${o.matchLevel === 'exact' ? 'exact model' : 'related variant/family page (not buyable for this goal)'} — ${o.sourceTitle ?? ''} ${o.sourceUrl} ["${o.excerpt.slice(0, 120)}"]`);
  } else lines.push('Offers: none researched yet.');
  const selected = opportunities.find((o) => o.status === 'selected');
  if (opportunities.length) {
    lines.push('Earning opportunities assessed:');
    for (const o of opportunities) {
      const a = o.assessment as { unitPriceCents?: number; unitsNeeded?: number; exclusionReason?: string; pandeshDoes?: string };
      lines.push(o.status === 'excluded'
        ? `- EXCLUDED ${o.title}: ${a.exclusionReason}`
        : `- ${o.status === 'selected' ? 'SELECTED ' : ''}${o.title} (score ${o.score.toFixed(2)}${a.unitPriceCents ? `, ${m(a.unitPriceCents)} per unit, ${a.unitsNeeded} unit(s) to close the gap` : ''})`);
    }
  }
  if (selected?.offering) {
    const off = selected.offering as { folder?: string; files?: string[]; validation?: string; published?: boolean };
    lines.push(`Offering for "${selected.title}": ${off.folder} — ${off.files?.join(', ')}. ${off.validation ?? ''} Published: ${off.published ? 'yes' : 'NO (draft; needs your authorization)'}.`);
  }
  const f = readiness.funds;
  lines.push(`Funds (real money only): available ${m(f.availableCents)} (reconciled revenue ${m(f.verifiedRevenueCents)}, verified own funds ${m(f.verifiedOwnFundsCents)}, expenses ${m(f.expensesCents)}, income-tax reserve ${m(f.taxReserveCents)}); not counted: unverified ${m(f.unverifiedInCents)}, verified but not reconciled to an invoice ${m(f.unreconciledRevenueCents)}.`);
  if (f.demoRevenueCents) lines.push(`Demonstration money (simulated, NEVER counted): ${m(f.demoRevenueCents)}.`);
  const claims = ledger.filter((e) => e.status === 'claimed');
  if (claims.length) lines.push(`Waiting for your verification: ${claims.map((e) => `${e.id} ${e.mode === 'demo' ? 'DEMO ' : ''}${e.kind} ${m(e.amountCents)} "${e.description}"`).join('; ')}`);
  if (goal.purchasePlan) {
    lines.push(`PURCHASE PREPARED (not executed): ${m(goal.purchasePlan.priceCents)} at ${goal.purchasePlan.sourceUrl}. Steps: ${goal.purchasePlan.steps.join(' ')}`);
  } else {
    lines.push(`Purchase: not ready. ${readiness.blockers.join(' ')} Still to earn: ${m(readiness.shortfallCents)}.`);
  }
  return lines.join('\n');
}
