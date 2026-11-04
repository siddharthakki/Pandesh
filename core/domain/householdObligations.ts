/**
 * Household obligations: bills, subscriptions, contracts, warranties and other dated responsibilities, each one record
 * however many emails or documents mention it.
 *
 * - Deduplication: a record is keyed by counterparty + kind group (+ the customer/contract number when one is known).
 *   Every source that mentions it becomes an evidence row, unique per (record, source), so scanning the same mailbox
 *   twice changes nothing and five Telekom invoices are one Telekom record with five pieces of evidence.
 * - Payment status is derived from all the evidence, never from one email: an invoice proves a payment was requested,
 *   not that it is unpaid. Only a payment confirmation (or the person) can make it `confirmed`.
 * - A record found by a scan is `proposed`. Only a person confirms it; only a confirmed record becomes an Important Date
 *   on the phone (core/domain/companionSync.ts), and a resolution made on the phone flows back here.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { counterpartyKey, type Cadence, type ExtractedObligation, type ObligationKind, type SourceText } from './obligationExtraction';
import { removeCompanionRecord, upsertCompanionRecord } from './companionSync';

export type PaymentStatus = 'requested' | 'due_soon' | 'potentially_overdue' | 'confirmed' | 'unknown' | 'not_applicable';
export type ObligationStatus = 'proposed' | 'confirmed' | 'resolved' | 'dismissed';

export interface Obligation {
  id: string;
  obligationKey: string;
  kind: ObligationKind;
  counterparty: string;
  title: string;
  amountCents: number | null;
  currency: string | null;
  cadence: Cadence;
  nextDate: string | null;
  dateKind: string | null;
  paymentStatus: PaymentStatus;
  status: ObligationStatus;
  confidence: number;
  sourceCount: number;
  lastCheckedAt: string;
  confirmedBy: string | null;
  confirmedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ObligationEvidence {
  id: string;
  obligationId: string;
  sourceType: SourceText['sourceType'];
  sourceRef: string;
  sourceLabel: string;
  observedAt: string;
  signal: ExtractedObligation['signal'];
  excerpt: string;
  facts: Partial<ExtractedObligation>;
}

const BILLING_KINDS: ReadonlySet<ObligationKind> = new Set(['bill', 'subscription', 'contract']);
const PAYABLE_KINDS: ReadonlySet<ObligationKind> = new Set(['bill', 'subscription', 'contract', 'insurance']);

function kindGroup(kind: ObligationKind): string {
  return BILLING_KINDS.has(kind) ? 'billing' : kind;
}

function map(r: Record<string, unknown>): Obligation {
  return {
    id: String(r.id), obligationKey: String(r.obligationKey), kind: r.kind as ObligationKind, counterparty: String(r.counterparty), title: String(r.title),
    amountCents: r.amountCents === null || r.amountCents === undefined ? null : Number(r.amountCents), currency: (r.currency as string) ?? null,
    cadence: r.cadence as Cadence, nextDate: (r.nextDate as string) ?? null, dateKind: (r.dateKind as string) ?? null, paymentStatus: r.paymentStatus as PaymentStatus,
    status: r.status as ObligationStatus, confidence: Number(r.confidence), sourceCount: Number(r.sourceCount), lastCheckedAt: String(r.lastCheckedAt),
    confirmedBy: (r.confirmedBy as string) ?? null, confirmedAt: (r.confirmedAt as string) ?? null, resolvedBy: (r.resolvedBy as string) ?? null,
    resolvedAt: (r.resolvedAt as string) ?? null, resolution: (r.resolution as string) ?? null, createdAt: String(r.createdAt), updatedAt: String(r.updatedAt),
  };
}

function mapEvidence(r: Record<string, unknown>): ObligationEvidence {
  return {
    id: String(r.id), obligationId: String(r.obligationId), sourceType: r.sourceType as ObligationEvidence['sourceType'], sourceRef: String(r.sourceRef),
    sourceLabel: String(r.sourceLabel), observedAt: String(r.observedAt), signal: r.signal as ObligationEvidence['signal'], excerpt: String(r.excerpt), facts: JSON.parse(String(r.factsJson)),
  };
}

export function getObligation(db: CoreDatabase, id: string): Obligation {
  const row = db.get<Record<string, unknown>>('SELECT * FROM household_obligations WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `obligation ${id} not found`);
  return map(row);
}

export function listObligationEvidence(db: CoreDatabase, obligationId: string): ObligationEvidence[] {
  return db.all<Record<string, unknown>>('SELECT * FROM obligation_evidence WHERE obligationId = ? ORDER BY observedAt ASC', [obligationId]).map(mapEvidence);
}

export function listObligations(db: CoreDatabase, filter: { status?: ObligationStatus[]; withinDays?: number; nowMs?: number } = {}): Obligation[] {
  const statuses = filter.status ?? ['proposed', 'confirmed'];
  let rows = db.all<Record<string, unknown>>(
    `SELECT * FROM household_obligations WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY CASE WHEN nextDate IS NULL THEN 1 ELSE 0 END, nextDate ASC, updatedAt DESC`,
    statuses,
  ).map(map);
  if (filter.withinDays !== undefined) {
    const limit = ymdOffset(filter.nowMs ?? Date.now(), filter.withinDays);
    rows = rows.filter((o) => o.nextDate !== null && o.nextDate <= limit);
  }
  return rows;
}

function ymdOffset(nowMs: number, days: number): string {
  return new Date(nowMs + days * 86_400_000).toISOString().slice(0, 10);
}

/** Moves a recurring date forward past `today` by its cadence. Non-recurring dates are left as they are. */
export function rollForward(date: string, cadence: Cadence, today: string): string {
  if (cadence === 'unknown' || cadence === 'once' || date >= today) return date;
  const months = cadence === 'monthly' ? 1 : cadence === 'quarterly' ? 3 : 12;
  let [y, m, d] = date.split('-').map(Number);
  for (let i = 0; i < 600; i++) {
    m += months;
    while (m > 12) { m -= 12; y += 1; }
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const next = `${y}-${String(m).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    if (next >= today) return next;
  }
  return date;
}

/**
 * The payment status that all the evidence supports. Pure.
 * - a payment confirmation at or after the latest bill (or the person's own resolution) → confirmed
 * - a reminder/dunning letter after the latest bill → potentially overdue
 * - a bill with a due date: past → potentially overdue, within 7 days → due soon, later → requested
 * - a bill with no date → requested; nothing payable → unknown / not applicable
 */
export function derivePaymentStatus(input: { kind: ObligationKind; evidence: Array<Pick<ObligationEvidence, 'signal' | 'observedAt' | 'facts'>>; nextDate: string | null; dateKind: string | null; resolution: string | null; today: string }): PaymentStatus {
  if (!PAYABLE_KINDS.has(input.kind)) return 'not_applicable';
  if (input.resolution === 'paid') return 'confirmed';
  const sorted = [...input.evidence].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const bills = sorted.filter((e) => e.signal === 'invoice' || e.signal === 'payment_due' || e.signal === 'direct_debit' || e.signal === 'payment_reminder');
  const lastBill = bills[bills.length - 1];
  const confirmations = sorted.filter((e) => e.signal === 'payment_confirmed');
  const lastConfirm = confirmations[confirmations.length - 1];
  if (lastConfirm && (!lastBill || lastConfirm.observedAt >= lastBill.observedAt)) return 'confirmed';
  if (!lastBill) return 'unknown';
  if (lastBill.signal === 'payment_reminder') return 'potentially_overdue';
  const due = input.dateKind === 'due' || input.dateKind === 'debit' ? input.nextDate : (lastBill.facts.date ?? null);
  if (!due) return 'requested';
  if (due < input.today) return 'potentially_overdue';
  if (due <= ymdOffset(Date.parse(`${input.today}T12:00:00Z`), 7)) return 'due_soon';
  return 'requested';
}

function titleFor(kind: ObligationKind, counterparty: string, cadence: Cadence): string {
  const what: Record<ObligationKind, string> = {
    subscription: cadence === 'yearly' ? 'yearly subscription' : cadence === 'monthly' ? 'monthly subscription' : 'subscription', bill: 'bill', contract: 'contract',
    insurance: 'insurance', warranty: 'warranty', document_expiry: 'document expiry', delivery: 'delivery', appointment: 'appointment',
    service_notice: 'service notice', account_notice: 'account notice',
  };
  return `${counterparty} ${what[kind]}`;
}

export interface UpsertResult { obligation: Obligation; created: boolean; newEvidence: boolean; changed: string[] }

/**
 * Adds one extracted source to the right record, creating the record when it is new.
 * Idempotent per source: the same message or file a second time adds nothing.
 */
export function recordObligationSource(db: CoreDatabase, src: SourceText, facts: ExtractedObligation, nowMs = Date.now()): UpsertResult {
  const cp = counterpartyKey(facts.counterparty);
  const group = kindGroup(facts.kind);
  const keyBase = `${cp}:${group}`;
  return db.transaction(() => {
    const candidates = db.all<Record<string, unknown>>('SELECT * FROM household_obligations WHERE obligationKey = ? OR obligationKey LIKE ?', [keyBase, `${keyBase}:%`]).map(map);
    let target: Obligation | undefined;
    if (facts.accountNumber) target = candidates.find((c) => c.obligationKey === `${keyBase}:${facts.accountNumber!.toLowerCase()}`) ?? candidates.find((c) => c.obligationKey === keyBase);
    else target = candidates.length === 1 ? candidates[0] : candidates.find((c) => c.obligationKey === keyBase);
    if (group === 'document_expiry') target = candidates.find((c) => c.obligationKey === `${keyBase}:${src.sourceRef.toLowerCase()}`);
    const at = nowIso();
    const today = new Date(nowMs).toISOString().slice(0, 10);
    let created = false;
    if (!target) {
      const id = newId('oblig');
      const key = group === 'document_expiry' ? `${keyBase}:${src.sourceRef.toLowerCase()}` : facts.accountNumber ? `${keyBase}:${facts.accountNumber.toLowerCase()}` : keyBase;
      db.run(
        `INSERT INTO household_obligations (id, obligationKey, kind, counterparty, title, amountCents, currency, cadence, nextDate, dateKind, paymentStatus, status, confidence, sourceCount, lastCheckedAt, createdAt, updatedAt)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, 'unknown', NULL, NULL, 'unknown', 'proposed', ?, 0, ?, ?, ?)`,
        [id, key, facts.kind, facts.counterparty, titleFor(facts.kind, facts.counterparty, facts.cadence), facts.confidence, at, at, at],
      );
      target = getObligation(db, id);
      created = true;
    } else if (facts.accountNumber && target.obligationKey === keyBase) {
      db.run('UPDATE household_obligations SET obligationKey = ? WHERE id = ?', [`${keyBase}:${facts.accountNumber.toLowerCase()}`, target.id]);
    }
    const inserted = db.run(
      `INSERT OR IGNORE INTO obligation_evidence (id, obligationId, sourceType, sourceRef, sourceLabel, observedAt, signal, excerpt, factsJson, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('oevid'), target.id, src.sourceType, src.sourceRef, src.label.slice(0, 200), src.observedAt, facts.signal, facts.excerpt, JSON.stringify(facts), at],
    );
    const newEvidence = Number(inserted.changes) > 0;
    const changed = refreshObligation(db, target.id, today);
    if (!newEvidence) db.run('UPDATE household_obligations SET lastCheckedAt = ? WHERE id = ?', [at, target.id]);
    return { obligation: getObligation(db, target.id), created, newEvidence, changed };
  });
}

/**
 * Recomputes a record from its evidence: kind and cadence (strongest evidence wins), the latest amount, the next date
 * (rolled forward by cadence), payment status and confidence. Returns the fields that changed. A confirmed record that
 * changed is republished to the phone under the same id.
 */
export function refreshObligation(db: CoreDatabase, id: string, today = new Date().toISOString().slice(0, 10)): string[] {
  const before = getObligation(db, id);
  const evidence = listObligationEvidence(db, id);
  const latest = [...evidence].sort((a, b) => b.observedAt.localeCompare(a.observedAt));
  const cadence = latest.map((e) => e.facts.cadence).find((c) => c && c !== 'unknown') ?? before.cadence;
  const kinds = new Set(evidence.map((e) => e.facts.kind));
  // A person's confirmation fixes the kind; until then the strongest evidence decides it.
  const kind: ObligationKind = before.status !== 'proposed' ? before.kind
    : kinds.has('insurance') ? 'insurance'
      : kinds.has('subscription') || (cadence !== 'unknown' && kinds.has('bill')) ? 'subscription'
        : kinds.has('contract') ? 'contract' : (latest[0]?.facts.kind ?? before.kind);
  const amountSource = latest.find((e) => e.facts.amountCents);
  const dated = latest.find((e) => e.facts.date && e.signal !== 'payment_confirmed');
  const resolvedThrough = before.resolution === 'paid' && before.resolvedAt ? before.resolvedAt : null;
  // A bill issued after the person marked it paid opens a new period: the record goes back to confirmed.
  const reopened = resolvedThrough !== null && latest.some((e) => (e.signal === 'invoice' || e.signal === 'payment_due' || e.signal === 'direct_debit') && e.observedAt > resolvedThrough);
  let nextDate = dated?.facts.date ?? before.nextDate;
  const dateKind = dated?.facts.dateKind ?? before.dateKind;
  // A past renewal of a recurring subscription rolls forward by its cadence; a past due date stays (it may be overdue).
  if (nextDate && dateKind === 'renewal' && cadence !== 'unknown') nextDate = rollForward(nextDate, cadence, today);
  const status: ObligationStatus = reopened ? 'confirmed' : before.status;
  const resolution = reopened ? null : before.resolution;
  const paymentStatus = derivePaymentStatus({ kind, evidence, nextDate, dateKind, resolution, today });
  const confidence = Math.min(0.99, Math.max(...evidence.map((e) => Number(e.facts.confidence ?? 0)), before.confidence) + Math.min(0.15, (evidence.length - 1) * 0.05));
  const next = {
    kind, cadence, amountCents: amountSource?.facts.amountCents ?? before.amountCents, currency: amountSource?.facts.currency ?? before.currency,
    nextDate, dateKind, paymentStatus, status, resolution, confidence: Math.round(confidence * 100) / 100, sourceCount: evidence.length,
    title: before.status === 'proposed' ? titleFor(kind, before.counterparty, cadence) : before.title,
  };
  const changed = (Object.keys(next) as Array<keyof typeof next>).filter((k) => next[k] !== (before as unknown as Record<string, unknown>)[k]);
  if (changed.length || evidence.length) {
    db.run(
      `UPDATE household_obligations SET kind = ?, cadence = ?, amountCents = ?, currency = ?, nextDate = ?, dateKind = ?, paymentStatus = ?, status = ?, resolution = ?,
         resolvedAt = CASE WHEN ? THEN NULL ELSE resolvedAt END, confidence = ?, sourceCount = ?, title = ?, lastCheckedAt = ?, updatedAt = ? WHERE id = ?`,
      [next.kind, next.cadence, next.amountCents, next.currency, next.nextDate, next.dateKind, next.paymentStatus, next.status, next.resolution,
        reopened ? 1 : 0, next.confidence, next.sourceCount, next.title, nowIso(), nowIso(), id],
    );
  }
  if (changed.length && (status === 'confirmed' || status === 'resolved')) publishObligation(db, getObligation(db, id));
  return changed;
}

export type ObligationAction = 'confirm' | 'resolve' | 'dismiss' | 'reopen';

/** A person's decision on a record. Confirmation and every later change are published to the phone. */
export function decideObligation(db: CoreDatabase, id: string, input: {
  action: ObligationAction; actor: string; resolution?: 'paid' | 'done' | 'cancelled';
  corrections?: { title?: string; nextDate?: string; amountCents?: number | null; cadence?: Cadence; kind?: ObligationKind };
}): Obligation {
  const ob = getObligation(db, id);
  const at = nowIso();
  const c = input.corrections ?? {};
  if (c.nextDate !== undefined && c.nextDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(c.nextDate)) throw new CoreError('invalid_request', 'nextDate must be YYYY-MM-DD');
  db.transaction(() => {
    if (c.title || c.nextDate || c.amountCents !== undefined || c.cadence || c.kind) {
      db.run('UPDATE household_obligations SET title = COALESCE(?, title), nextDate = COALESCE(?, nextDate), amountCents = CASE WHEN ? THEN ? ELSE amountCents END, cadence = COALESCE(?, cadence), kind = COALESCE(?, kind), updatedAt = ? WHERE id = ?',
        [c.title ?? null, c.nextDate ?? null, c.amountCents !== undefined ? 1 : 0, c.amountCents ?? null, c.cadence ?? null, c.kind ?? null, at, id]);
    }
    switch (input.action) {
      case 'confirm':
        if (ob.status === 'dismissed' || ob.status === 'proposed' || ob.status === 'confirmed') db.run("UPDATE household_obligations SET status = 'confirmed', confirmedBy = ?, confirmedAt = COALESCE(confirmedAt, ?), updatedAt = ? WHERE id = ?", [input.actor, at, at, id]);
        break;
      case 'resolve':
        db.run("UPDATE household_obligations SET status = 'resolved', resolution = ?, resolvedBy = ?, resolvedAt = ?, updatedAt = ? WHERE id = ?", [input.resolution ?? 'done', input.actor, at, at, id]);
        break;
      case 'dismiss':
        db.run("UPDATE household_obligations SET status = 'dismissed', updatedAt = ? WHERE id = ?", [at, id]);
        break;
      case 'reopen':
        db.run("UPDATE household_obligations SET status = 'confirmed', resolution = NULL, resolvedBy = NULL, resolvedAt = NULL, updatedAt = ? WHERE id = ?", [at, id]);
        break;
    }
  });
  refreshObligation(db, id);
  const next = getObligation(db, id);
  if (next.status === 'confirmed' || next.status === 'resolved') publishObligation(db, next);
  else if (next.status === 'dismissed') removeCompanionRecord(db, `obligation:${id}`);
  return next;
}

/** The JUGAAD Important Date type that matches a record. */
export function importantDateType(ob: Pick<Obligation, 'kind' | 'dateKind'>): string {
  if (ob.dateKind === 'contract_end' || ob.dateKind === 'notice_deadline') return 'CONTRACT_END';
  switch (ob.kind) {
    case 'subscription': return 'SUBSCRIPTION';
    case 'bill': case 'insurance': return 'PAYMENT_DUE';
    case 'contract': return ob.dateKind === 'renewal' ? 'RENEWAL' : 'PAYMENT_DUE';
    case 'warranty': return 'WARRANTY';
    case 'appointment': return 'APPOINTMENT';
    case 'document_expiry': return 'DEADLINE';
    default: return 'CUSTOM';
  }
}

const money = (cents: number | null, currency: string | null) => cents === null ? null : `${(cents / 100).toFixed(2).replace('.', ',')} ${currency === 'EUR' || !currency ? '€' : currency}`;

/**
 * Writes the record into the companion log as an Important Date. Only the facts a reminder needs travel: title, date,
 * amount, status and where the evidence came from (subjects and dates) — never a message body or a document.
 */
export function publishObligation(db: CoreDatabase, ob: Obligation): void {
  if (!ob.nextDate && ob.status !== 'resolved') return;
  const evidence = listObligationEvidence(db, ob.id);
  const statusWords: Record<PaymentStatus, string> = {
    requested: 'payment requested (not proven unpaid)', due_soon: 'payment due soon', potentially_overdue: 'possibly overdue — check', confirmed: 'payment confirmed',
    unknown: 'payment status unknown', not_applicable: '',
  };
  const note = [money(ob.amountCents, ob.currency), ob.cadence !== 'unknown' ? ob.cadence : null, statusWords[ob.paymentStatus] || null].filter(Boolean).join(' · ');
  upsertCompanionRecord(db, {
    recordId: `obligation:${ob.id}`,
    kind: 'important_date',
    sourceOfTruth: 'pandesh',
    payload: {
      title: ob.title,
      type: importantDateType(ob),
      date: ob.nextDate,
      reminderLeadDays: ob.kind === 'subscription' || ob.dateKind === 'contract_end' || ob.dateKind === 'notice_deadline' ? 7 : 3,
      note: note || null,
      status: ob.status,
      resolution: ob.resolution,
      paymentStatus: ob.paymentStatus,
      counterparty: ob.counterparty,
      amountCents: ob.amountCents,
      currency: ob.currency,
      confidence: ob.confidence,
      confirmedAt: ob.confirmedAt,
      lastCheckedAt: ob.lastCheckedAt,
      provenance: evidence.slice(-5).map((e) => ({ source: e.sourceType, label: e.sourceLabel, observedAt: e.observedAt, signal: e.signal })),
    },
  });
}

export function renderObligation(db: CoreDatabase, ob: Obligation, withEvidence = true): string {
  const parts = [`${ob.title} [${ob.status}${ob.status === 'proposed' ? ', needs your confirmation' : ''}] id=${ob.id}`];
  const facts = [
    ob.nextDate ? `${ob.dateKind ?? 'date'} ${ob.nextDate}` : 'no date found',
    money(ob.amountCents, ob.currency),
    ob.cadence !== 'unknown' ? ob.cadence : null,
    ob.paymentStatus !== 'not_applicable' ? `payment: ${ob.paymentStatus.replace('_', ' ')}` : null,
    `confidence ${Math.round(ob.confidence * 100)}%`,
    `${ob.sourceCount} source(s)`,
  ].filter(Boolean);
  parts.push(`  ${facts.join(' · ')}`);
  if (withEvidence) for (const e of listObligationEvidence(db, ob.id).slice(-3)) parts.push(`  evidence: ${e.sourceType} "${e.sourceLabel}" (${e.observedAt.slice(0, 10)}, ${e.signal}): "${e.excerpt.slice(0, 140)}"`);
  return parts.join('\n');
}
