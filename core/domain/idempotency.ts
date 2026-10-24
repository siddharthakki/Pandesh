import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';

export interface IdempotencyScope {
  key: string;
  clientId: string;
  routeId: string;
}

function hashRequest(requestBody: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(requestBody ?? null)).digest('hex');
}

/**
 * Read-only lookup of a completed idempotency-key result. Never creates a
 * row — if no completed row exists for this (key, clientId, routeId) tuple,
 * returns `undefined`. Used by restoration paths that must discover an
 * existing anchor (e.g. a Core "saath_kar" attempt keyed by a capability
 * dispatch correlationId) WITHOUT creating one if none exists yet.
 */
export function lookupIdempotencyResult<T>(db: CoreDatabase, scope: IdempotencyScope): T | undefined {
  const existing = db.get<{ responseStatus: number | null; responseBody: string | null }>(
    'SELECT responseStatus, responseBody FROM idempotency_keys WHERE key = ? AND clientId = ? AND routeId = ?',
    [scope.key, scope.clientId, scope.routeId],
  );
  if (!existing || existing.responseStatus === null || existing.responseBody === null) return undefined;
  return JSON.parse(existing.responseBody) as T;
}

/**
 * Runs `fn` at most once for a given (key, clientId, routeId) tuple. The
 * initial INSERT is the atomicity primitive: SQLite's unique index on
 * (key, clientId, routeId) means exactly one of any number of "concurrent"
 * callers can win the claim, regardless of how the surrounding async code is
 * interleaved — no additional locking is needed. A later call with the same
 * key but a different request body is rejected outright.
 */
export function withIdempotency<T>(db: CoreDatabase, scope: IdempotencyScope, requestBody: unknown, fn: () => T): T {
  const requestHash = hashRequest(requestBody);
  const now = nowIso();

  let wonClaim = false;
  try {
    db.run(
      `INSERT INTO idempotency_keys (key, clientId, routeId, requestHash, responseStatus, responseBody, createdAt)
       VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      [scope.key, scope.clientId, scope.routeId, requestHash, now],
    );
    wonClaim = true;
  } catch {
    wonClaim = false;
  }

  if (!wonClaim) {
    const existing = db.get<{ requestHash: string; responseStatus: number | null; responseBody: string | null }>(
      'SELECT requestHash, responseStatus, responseBody FROM idempotency_keys WHERE key = ? AND clientId = ? AND routeId = ?',
      [scope.key, scope.clientId, scope.routeId],
    );
    if (!existing) {
      // Extremely unlikely race: the winning row was deleted between our failed insert and this
      // read. Treat as a fresh claim attempt rather than surfacing an internal inconsistency.
      return withIdempotency(db, scope, requestBody, fn);
    }
    if (existing.requestHash !== requestHash) {
      throw new CoreError('idempotency_key_conflict', 'idempotency key reused with a different request body', {
        key: scope.key,
        routeId: scope.routeId,
      });
    }
    if (existing.responseStatus !== null && existing.responseBody !== null) {
      return JSON.parse(existing.responseBody) as T;
    }
    // Claimed but not yet completed by whoever holds it (should not happen with fully synchronous
    // handlers on a single-threaded runtime, but fail safe rather than silently duplicating work).
    throw new CoreError('conflict', 'a request with this idempotency key is already in progress');
  }

  try {
    const result = fn();
    db.run('UPDATE idempotency_keys SET responseStatus = 200, responseBody = ? WHERE key = ? AND clientId = ? AND routeId = ?', [
      JSON.stringify(result),
      scope.key,
      scope.clientId,
      scope.routeId,
    ]);
    return result;
  } catch (err) {
    // Release the claim so a genuine retry after a failure can proceed instead of being stuck
    // behind an in-progress row forever.
    db.run('DELETE FROM idempotency_keys WHERE key = ? AND clientId = ? AND routeId = ?', [
      scope.key,
      scope.clientId,
      scope.routeId,
    ]);
    throw err;
  }
}
