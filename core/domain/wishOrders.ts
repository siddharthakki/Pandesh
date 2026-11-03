/**
 * Wish-to-Reality, real customers: the business authorization, customer orders and what they really produced.
 *
 * What this module owns:
 *   - the business authorization a PERSON records (never Core or the model): the registration they made, their tax
 *     status, the income-tax reserve to hold back, and which outward actions are allowed (publish, contact, contract,
 *     payments). Without it, only demonstration orders exist.
 *   - customer orders, from lead to paid, each with a trail of who did each step (Pandesh or a person) so the human
 *     intervention per order is measured, not estimated.
 *   - invoice numbers: one gapless sequence per year for real invoices, a separate DEMO sequence that can never be
 *     mistaken for one.
 *   - the commerce figures: leads by channel, orders, delivered, invoiced, paid, real revenue, costs, acquisition cost.
 *
 * What it deliberately does not own: sending anything to anyone, publishing, or collecting money. A person does those
 * and tells Pandesh; money arrives in the ledger (wishes.ts) only as a claim a person reconciles.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { type WishMoneyMode, formatMoney, getWishGoal, isAssistantActor, listWishLedger, wishFunds } from './wishes';

export const WISH_BUSINESS_SCOPES = ['publish', 'contact', 'contract', 'payments'] as const;
export type WishBusinessScope = (typeof WISH_BUSINESS_SCOPES)[number];
/** Channels that reach customers lawfully. Unsolicited bulk e-mail, calls or messages are not among them (UWG §7). */
export const WISH_ACQUISITION_CHANNELS = ['personal_network', 'referral', 'inbound_listing', 'association_with_permission', 'walk_in', 'demo'] as const;
export type WishOrderStatus = 'lead' | 'intake_received' | 'built' | 'qc_failed' | 'delivered' | 'invoiced' | 'paid' | 'cancelled';

export interface WishBusinessProfile {
  legalName: string;
  address: string;
  email: string;
  phone: string | null;
  taxNumber: string | null;
  /** Only the German small-business rule (§19 UStG, no VAT shown) is invoiced by Pandesh today. */
  vatMode: 'kleinunternehmer' | 'regular';
  /** What the person registered, in their words, e.g. "Gewerbeanmeldung Stadt X, 2026-11-10; Fragebogen ELSTER". */
  registration: string;
  taxReserveBps: number;
  /** Where customers pay, as printed on invoices (IBAN and account holder, or PayPal). */
  paymentDetails: string | null;
  scopes: Record<WishBusinessScope, boolean>;
  authorizedBy: string;
  authorizedAt: string;
}

export interface WishOrderEvent { at: string; by: 'pandesh' | 'human'; step: string; minutes?: number }

export interface WishOrder {
  id: string;
  goalId: string;
  mode: WishMoneyMode;
  status: WishOrderStatus;
  channel: string;
  customerName: string;
  customerEmail: string | null;
  customerAddress: string | null;
  brief: Record<string, unknown> | null;
  priceCents: number;
  currency: string;
  folder: string | null;
  qc: { passed: boolean; checks: Array<{ name: string; ok: boolean; detail: string }> } | null;
  invoiceNumber: string | null;
  invoiceFile: string | null;
  events: WishOrderEvent[];
  createdAt: string;
  updatedAt: string;
}

function asOrder(row: Record<string, unknown>): WishOrder {
  return {
    id: String(row.id), goalId: String(row.goalId), mode: row.mode as WishMoneyMode, status: row.status as WishOrderStatus, channel: String(row.channel),
    customerName: String(row.customerName), customerEmail: (row.customerEmail as string) ?? null, customerAddress: (row.customerAddress as string) ?? null,
    brief: row.briefJson ? JSON.parse(String(row.briefJson)) : null, priceCents: Number(row.priceCents), currency: String(row.currency),
    folder: (row.folder as string) ?? null, qc: row.qcJson ? JSON.parse(String(row.qcJson)) : null,
    invoiceNumber: (row.invoiceNumber as string) ?? null, invoiceFile: (row.invoiceFile as string) ?? null,
    events: JSON.parse(String(row.eventsJson || '[]')), createdAt: String(row.createdAt), updatedAt: String(row.updatedAt),
  };
}

// ---------------------------------------------------------------- business authorization

export function getWishBusiness(db: CoreDatabase): WishBusinessProfile | null {
  const row = db.get<Record<string, unknown>>("SELECT * FROM wish_business WHERE id = 'default'");
  if (!row) return null;
  return {
    legalName: String(row.legalName), address: String(row.address), email: String(row.email), phone: (row.phone as string) ?? null,
    taxNumber: (row.taxNumber as string) ?? null, vatMode: row.vatMode as WishBusinessProfile['vatMode'], registration: String(row.registration),
    taxReserveBps: Number(row.taxReserveBps), paymentDetails: (row.paymentDetails as string) ?? null, scopes: JSON.parse(String(row.scopesJson)), authorizedBy: String(row.authorizedBy), authorizedAt: String(row.authorizedAt),
  };
}

/**
 * A person records (or changes, or withdraws by clearing every scope) the business authorization. Every field is the
 * person's own statement; Pandesh does not check it with any authority.
 */
export function authorizeWishBusiness(db: CoreDatabase, input: Record<string, unknown>, actor: string): WishBusinessProfile {
  if (isAssistantActor(actor)) throw new CoreError('forbidden', 'only a person can authorize business activity');
  const text = (k: string, max = 300) => String(input[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const legalName = text('legalName');
  const address = text('address');
  const email = text('email');
  const registration = text('registration', 500);
  if (!legalName || !address) throw new CoreError('invalid_request', 'name and postal address of the business owner are required (they go on every invoice and Impressum)');
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) throw new CoreError('invalid_request', 'a contact e-mail address is required');
  if (!registration) throw new CoreError('invalid_request', 'say what you registered (Gewerbeanmeldung and/or Fragebogen zur steuerlichen Erfassung) and when');
  const vatMode = input.vatMode === 'regular' ? 'regular' : input.vatMode === 'kleinunternehmer' ? 'kleinunternehmer' : null;
  if (!vatMode) throw new CoreError('invalid_request', "vatMode must be 'kleinunternehmer' (§19 UStG) or 'regular'");
  const reservePercent = Number(input.taxReservePercent);
  if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 60) throw new CoreError('invalid_request', 'taxReservePercent (0–60) is required: the share of profit to hold back for income tax');
  const given = (input.scopes ?? {}) as Record<string, unknown>;
  const scopes = Object.fromEntries(WISH_BUSINESS_SCOPES.map((s) => [s, given[s] === true])) as Record<WishBusinessScope, boolean>;
  const paymentDetails = text('paymentDetails', 200) || null;
  if (scopes.payments && !paymentDetails) throw new CoreError('invalid_request', "allowing 'payments' needs paymentDetails (IBAN and account holder, or PayPal) for the invoices");
  const now = nowIso();
  db.run(
    `INSERT INTO wish_business (id, legalName, address, email, phone, taxNumber, vatMode, registration, taxReserveBps, paymentDetails, scopesJson, authorizedBy, authorizedAt, updatedAt)
     VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET legalName = excluded.legalName, address = excluded.address, email = excluded.email, phone = excluded.phone,
       taxNumber = excluded.taxNumber, vatMode = excluded.vatMode, registration = excluded.registration, taxReserveBps = excluded.taxReserveBps,
       paymentDetails = excluded.paymentDetails, scopesJson = excluded.scopesJson, authorizedBy = excluded.authorizedBy, authorizedAt = excluded.authorizedAt, updatedAt = excluded.updatedAt`,
    [legalName, address, email, text('phone', 60) || null, text('taxNumber', 40) || null, vatMode, registration, Math.round(reservePercent * 100), paymentDetails, JSON.stringify(scopes), actor, now, now],
  );
  return getWishBusiness(db)!;
}

/** Real orders need the matching scope; demonstration orders never touch the outside world and need none. */
export function requireWishScope(db: CoreDatabase, mode: WishMoneyMode, scope: WishBusinessScope): WishBusinessProfile | null {
  if (mode === 'demo') return getWishBusiness(db);
  const business = getWishBusiness(db);
  if (!business) throw new CoreError('forbidden', `NOT AUTHORIZED: no business authorization is recorded, so real customer work (${scope}) is not allowed. Run it as a demo order, or have the owner record the authorization in Pandesh first.`);
  if (!business.scopes[scope]) throw new CoreError('forbidden', `NOT AUTHORIZED: the business authorization does not allow '${scope}'.`);
  return business;
}

// ---------------------------------------------------------------- orders

export function getWishOrder(db: CoreDatabase, id: string): WishOrder {
  const row = db.get<Record<string, unknown>>('SELECT * FROM wish_orders WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `order '${id}' not found`);
  return asOrder(row);
}
export function listWishOrders(db: CoreDatabase, goalId: string): WishOrder[] {
  return db.all<Record<string, unknown>>('SELECT * FROM wish_orders WHERE goalId = ? ORDER BY createdAt', [goalId]).map(asOrder);
}

export function addWishOrderEvent(db: CoreDatabase, orderId: string, event: Omit<WishOrderEvent, 'at'>, patch: { status?: WishOrderStatus; sql?: string; params?: unknown[] } = {}): WishOrder {
  const order = getWishOrder(db, orderId);
  const events = [...order.events, { at: nowIso(), ...event }];
  db.run(`UPDATE wish_orders SET eventsJson = ?, status = ?, updatedAt = ?${patch.sql ? `, ${patch.sql}` : ''} WHERE id = ?`, [JSON.stringify(events), patch.status ?? order.status, nowIso(), ...(patch.params ?? []), orderId]);
  return getWishOrder(db, orderId);
}

/** A prospect who asked about the service through a lawful channel. A real one needs the 'contact' authorization. */
export function createWishOrder(db: CoreDatabase, input: { goalId: string; mode: WishMoneyMode; channel: string; customerName: string; customerEmail?: string | null; customerAddress?: string | null; priceCents: number }): WishOrder {
  const goal = getWishGoal(db, input.goalId);
  requireWishScope(db, input.mode, 'contact');
  if (!(WISH_ACQUISITION_CHANNELS as readonly string[]).includes(input.channel)) {
    throw new CoreError('invalid_request', `channel must be one of ${WISH_ACQUISITION_CHANNELS.join(', ')} (cold bulk e-mail, calls or messages are not permitted channels)`);
  }
  if ((input.channel === 'demo') !== (input.mode === 'demo')) throw new CoreError('invalid_request', "only demo orders use the 'demo' channel, and they must");
  const customerName = String(input.customerName ?? '').trim().slice(0, 200);
  if (!customerName) throw new CoreError('invalid_request', 'the customer needs a name');
  if (!Number.isInteger(input.priceCents) || input.priceCents <= 0) throw new CoreError('invalid_request', 'the agreed price must be a positive amount');
  const id = newId('word');
  const now = nowIso();
  const events: WishOrderEvent[] = [{ at: now, by: 'human', step: `lead recorded (${input.channel})` }];
  db.run(
    'INSERT INTO wish_orders (id, goalId, mode, status, channel, customerName, customerEmail, customerAddress, priceCents, currency, eventsJson, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [id, goal.id, input.mode, 'lead', input.channel, customerName, input.customerEmail?.trim() || null, input.customerAddress?.trim() || null, input.priceCents, goal.currency, JSON.stringify(events), now, now],
  );
  return getWishOrder(db, id);
}

/**
 * The customer accepted the offer and sent the intake answers. A real one needs the 'contract' authorization. Corrected
 * answers (after a failed check, or the included change round) replace the brief until the site is delivered.
 */
export function acceptWishOrder(db: CoreDatabase, orderId: string, brief: Record<string, unknown>): WishOrder {
  const order = getWishOrder(db, orderId);
  requireWishScope(db, order.mode, 'contract');
  if (!['lead', 'intake_received', 'qc_failed', 'built'].includes(order.status)) throw new CoreError('invalid_transition', `order is ${order.status}; the brief can only change before delivery`);
  const step = order.status === 'lead' ? 'offer accepted, intake answers received' : 'intake answers corrected';
  return addWishOrderEvent(db, orderId, { by: 'human', step }, { status: 'intake_received', sql: 'briefJson = ?', params: [JSON.stringify(brief)] });
}

/** Next invoice number: RE-<year>-001… for real invoices (gapless, per year), DEMO-<year>-001… for demonstrations. */
export function nextInvoiceNumber(db: CoreDatabase, mode: WishMoneyMode, year = new Date().getFullYear()): string {
  const prefix = `${mode === 'demo' ? 'DEMO' : 'RE'}-${year}-`;
  const last = db.get<{ n: string | null }>('SELECT max(invoiceNumber) AS n FROM wish_orders WHERE invoiceNumber LIKE ?', [`${prefix}%`])?.n;
  const next = last ? Number(last.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(3, '0')}`;
}

// ---------------------------------------------------------------- what it really produced

export interface WishCommerceFigures {
  leads: number;
  leadsByChannel: Record<string, number>;
  ordersAccepted: number;
  delivered: number;
  invoicedCents: number;
  paidOrders: number;
  revenueCents: number;
  costsCents: number;
  /** Real costs divided by paying customers; null until someone has paid. */
  acquisitionCostPerCustomerCents: number | null;
  pandeshSteps: number;
  humanSteps: number;
  humanMinutes: number;
}

export function wishCommerceFigures(db: CoreDatabase, goalId: string, mode: WishMoneyMode): WishCommerceFigures {
  const orders = listWishOrders(db, goalId).filter((o) => o.mode === mode);
  const ledger = listWishLedger(db, goalId).filter((e) => e.mode === mode);
  const leadsByChannel: Record<string, number> = {};
  for (const o of orders) leadsByChannel[o.channel] = (leadsByChannel[o.channel] ?? 0) + 1;
  const reached = (o: WishOrder, step: string) => o.events.some((e) => e.step.startsWith(step));
  const paidOrders = orders.filter((o) => o.status === 'paid').length;
  const revenueCents = ledger.filter((e) => e.kind === 'revenue' && e.status === 'verified' && e.paymentReference && e.orderId).reduce((a, e) => a + e.amountCents, 0);
  const costsCents = ledger.filter((e) => e.kind === 'expense' && e.status !== 'rejected').reduce((a, e) => a + e.amountCents, 0);
  const events = orders.flatMap((o) => o.events);
  return {
    leads: orders.length,
    leadsByChannel,
    ordersAccepted: orders.filter((o) => reached(o, 'offer accepted')).length,
    delivered: orders.filter((o) => reached(o, 'delivered')).length,
    invoicedCents: orders.filter((o) => o.invoiceNumber).reduce((a, o) => a + o.priceCents, 0),
    paidOrders,
    revenueCents,
    costsCents,
    acquisitionCostPerCustomerCents: paidOrders ? Math.round(costsCents / paidOrders) : null,
    pandeshSteps: events.filter((e) => e.by === 'pandesh').length,
    humanSteps: events.filter((e) => e.by === 'human').length,
    humanMinutes: events.reduce((a, e) => a + (e.by === 'human' ? e.minutes ?? 0 : 0), 0),
  };
}

/** The commerce part of a goal's status, every figure from the records. Demo and real are never added together. */
export function renderWishCommerce(db: CoreDatabase, goalId: string): string[] {
  const goal = getWishGoal(db, goalId);
  const m = (c: number) => formatMoney(c, goal.currency);
  const business = getWishBusiness(db);
  const lines: string[] = [];
  lines.push(business
    ? `Business authorization: ${business.legalName} (${business.vatMode === 'kleinunternehmer' ? '§19 UStG small business' : 'regular VAT'}; ${business.registration}); allowed: ${WISH_BUSINESS_SCOPES.filter((s) => business.scopes[s]).join(', ') || 'nothing'}; income-tax reserve ${business.taxReserveBps / 100}%. Recorded by ${business.authorizedBy} ${business.authorizedAt.slice(0, 10)}.`
    : 'Business authorization: NONE recorded. No offer may be published, no prospect contacted, no contract accepted and no payment collected; only demonstration orders run.');
  for (const mode of ['real', 'demo'] as const) {
    const f = wishCommerceFigures(db, goalId, mode);
    if (!f.leads && mode === 'demo') continue;
    lines.push(`${mode === 'real' ? 'REAL customers' : 'DEMONSTRATION (simulated customer, never counted)'}: ${f.leads} lead(s)${f.leads ? ` [${Object.entries(f.leadsByChannel).map(([c, n]) => `${c} ${n}`).join(', ')}]` : ''}, ${f.ordersAccepted} accepted, ${f.delivered} delivered, ${m(f.invoicedCents)} invoiced, ${f.paidOrders} paid; revenue ${m(f.revenueCents)}, costs ${m(f.costsCents)}${f.acquisitionCostPerCustomerCents !== null ? `, cost per paying customer ${m(f.acquisitionCostPerCustomerCents)}` : ''}; steps done by Pandesh ${f.pandeshSteps}, by a person ${f.humanSteps} (${f.humanMinutes} min logged).`);
  }
  for (const o of listWishOrders(db, goalId).slice(-5)) {
    lines.push(`- ${o.mode === 'demo' ? 'DEMO ' : ''}order ${o.id} "${o.customerName}" ${m(o.priceCents)}: ${o.status}${o.invoiceNumber ? `, invoice ${o.invoiceNumber}` : ''}${o.folder ? `, files ${o.folder}` : ''}${o.qc && !o.qc.passed ? `, QC FAILED: ${o.qc.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}` : ''}`);
  }
  const funds = wishFunds(db, goalId);
  if (funds.demoRevenueCents && !funds.verifiedRevenueCents) lines.push(`Purchasing power from customers so far: ${m(funds.verifiedRevenueCents)} (the ${m(funds.demoRevenueCents)} of demonstration money does not count).`);
  return lines;
}
