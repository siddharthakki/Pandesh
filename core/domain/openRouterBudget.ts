import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';

export interface OpenRouterBudgetLedger {
  attemptId: string;
  spendCapUsd: number;
  spentUsd: number;
  reservedUsd: number;
  hasUnresolved: boolean;
  updatedAt: string;
}

function rowToLedger(row: Record<string, unknown>): OpenRouterBudgetLedger {
  return {
    attemptId: String(row.attemptId),
    spendCapUsd: Number(row.spendCapUsd),
    spentUsd: Number(row.spentUsd),
    reservedUsd: Number(row.reservedUsd),
    hasUnresolved: Boolean(row.hasUnresolved),
    updatedAt: String(row.updatedAt),
  };
}

export function getOpenRouterBudget(db: CoreDatabase, attemptId: string): OpenRouterBudgetLedger | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM openrouter_attempt_budget WHERE attemptId = ?', [attemptId]);
  return row ? rowToLedger(row) : null;
}

export function ensureOpenRouterBudget(db: CoreDatabase, attemptId: string, spendCapUsd: number): OpenRouterBudgetLedger {
  const existing = getOpenRouterBudget(db, attemptId);
  if (existing) {
    if (Math.abs(existing.spendCapUsd - spendCapUsd) > 1e-9) {
      throw new CoreError('invalid_request', 'OpenRouter spend cap is frozen for this attempt');
    }
    return existing;
  }
  const now = nowIso();
  db.run(
    `INSERT INTO openrouter_attempt_budget (attemptId, spendCapUsd, spentUsd, reservedUsd, hasUnresolved, updatedAt)
     VALUES (?, ?, 0, 0, 0, ?)`,
    [attemptId, spendCapUsd, now],
  );
  return getOpenRouterBudget(db, attemptId)!;
}

/**
 * Atomically reserves budget before a cloud fetch. Fails closed when the cap
 * would be exceeded or an unresolved reservation already blocks the attempt.
 */
export function reserveOpenRouterBudget(
  db: CoreDatabase,
  attemptId: string,
  spendCapUsd: number,
  reserveUsd: number,
): OpenRouterBudgetLedger {
  return db.transaction(() => {
    const ledger = ensureOpenRouterBudget(db, attemptId, spendCapUsd);
    if (ledger.hasUnresolved) {
      throw new CoreError('invalid_request', 'OpenRouter billing is unresolved for this attempt; refusing further cloud calls');
    }
    if (reserveUsd <= 0 || !Number.isFinite(reserveUsd)) {
      throw new CoreError('invalid_request', 'OpenRouter reservation must be a positive finite USD amount');
    }
    const projected = ledger.spentUsd + ledger.reservedUsd + reserveUsd;
    if (projected > ledger.spendCapUsd + 1e-9) {
      throw new CoreError('invalid_request', `OpenRouter spend cap of $${ledger.spendCapUsd} would be exceeded`);
    }
    const now = nowIso();
    db.run(
      `UPDATE openrouter_attempt_budget SET reservedUsd = reservedUsd + ?, updatedAt = ? WHERE attemptId = ?`,
      [reserveUsd, now, attemptId],
    );
    return getOpenRouterBudget(db, attemptId)!;
  });
}

/** Reconcile a successful call with provider-reported actual cost. */
export function reconcileOpenRouterBudget(
  db: CoreDatabase,
  attemptId: string,
  invocationId: string,
  reserveUsd: number,
  actualCostUsd: number | null,
): void {
  db.transaction(() => {
    const ledger = getOpenRouterBudget(db, attemptId);
    if (!ledger) throw new CoreError('invalid_request', 'OpenRouter budget ledger missing for attempt');
    if (actualCostUsd === null || !Number.isFinite(actualCostUsd)) {
      markOpenRouterBudgetUnresolved(db, attemptId, invocationId, reserveUsd);
      return;
    }
    const now = nowIso();
    db.run(
      `UPDATE openrouter_attempt_budget
       SET reservedUsd = MAX(0, reservedUsd - ?), spentUsd = spentUsd + ?, updatedAt = ?
       WHERE attemptId = ?`,
      [reserveUsd, actualCostUsd, now, attemptId],
    );
    const updated = getOpenRouterBudget(db, attemptId)!;
    if (updated.spentUsd > updated.spendCapUsd + 1e-9) {
      db.run(
        `UPDATE openrouter_attempt_budget SET hasUnresolved = 1, updatedAt = ? WHERE attemptId = ?`,
        [now, attemptId],
      );
      throw new CoreError('invalid_request', 'OpenRouter actual spend exceeded the frozen cap');
    }
    void invocationId;
  });
}

/** Interrupted streams or missing cost retain the reservation and block further calls. */
export function markOpenRouterBudgetUnresolved(
  db: CoreDatabase,
  attemptId: string,
  invocationId: string,
  reserveUsd: number,
): void {
  db.transaction(() => {
    const now = nowIso();
    db.run(
      `UPDATE openrouter_attempt_budget SET hasUnresolved = 1, updatedAt = ? WHERE attemptId = ?`,
      [now, attemptId],
    );
    void invocationId;
    void reserveUsd;
  });
}
