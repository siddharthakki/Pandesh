/**
 * Fencing primitive (M32 correction, audit findings F1/F3/F4).
 *
 * The audit's required architecture points 6 and 7: "Fenced executor lease with
 * generation token" and "Every state mutation and side effect requires the
 * current fence." A fenced attempt carries a `fenceToken` (opaque, unguessable)
 * and a monotonic `fenceGeneration`. An executor takes ownership by calling
 * `acquireFence`, which bumps the generation and issues a fresh token; any
 * previously-issued token is now stale. `assertFence` rejects a mutation carried
 * by a stale token with `fence_stale`, so a crashed/superseded executor whose
 * lease was taken over can no longer mutate Core state or record side effects.
 *
 * This is deliberately separate from the M31 optimistic `revision` check
 * (which guards lost updates within one owner) — the fence guards *ownership*
 * across process boundaries and restarts.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

export interface FenceHandle {
  attemptId: string;
  token: string;
  generation: number;
  owner: string;
}

/**
 * Takes (or steals a stale) fenced lease on an attempt, bumping the generation
 * and issuing a fresh token. Returns the handle the caller must present on every
 * subsequent mutation. Idempotent per owner+generation only in that re-acquiring
 * always advances the generation — callers hold exactly one live handle at a time.
 */
export function acquireFence(
  db: CoreDatabase,
  attemptId: string,
  input: {
    owner: string;
    actor: string;
    clientId?: string | null;
    leaseMs?: number;
    /** A waiting approval binds the attempt revision in its envelope. Fence
     * takeover may change ownership without invalidating that same envelope. */
    preserveLifecycleRevision?: boolean;
  },
): FenceHandle {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT id, fenceGeneration, revision FROM attempts WHERE id = ?', [attemptId]);
    if (!existing) throw new CoreError('not_found', `attempt '${attemptId}' not found`);
    const generation = Number(existing.fenceGeneration ?? 0) + 1;
    const token = crypto.randomBytes(16).toString('hex');
    const currentRevision = Number(existing.revision);
    const newRevision = input.preserveLifecycleRevision ? currentRevision : currentRevision + 1;
    const leaseExpiresAt = input.leaseMs === undefined
      ? null
      : new Date(Date.now() + input.leaseMs).toISOString();
    db.run('UPDATE attempts SET fenceToken = ?, fenceGeneration = ?, claimOwner = ?, claimExpiresAt = ?, updatedAt = ?, revision = ? WHERE id = ?', [
      token,
      generation,
      input.owner,
      leaseExpiresAt,
      nowIso(),
      newRevision,
      attemptId,
    ]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: attemptId,
      eventType: 'attempt_fence_acquired',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { owner: input.owner, generation },
      resultingRevision: newRevision,
    });
    return { attemptId, token, generation, owner: input.owner };
  });
}

/** Renews only the ownership lease. Lifecycle revision deliberately remains
 * unchanged so heartbeats cannot stale an approval envelope. */
export function renewFenceLease(
  db: CoreDatabase,
  handle: FenceHandle,
  leaseMs: number,
): string {
  return db.transaction(() => {
    assertFence(db, handle.attemptId, handle.token);
    const row = db.get<{ claimOwner: string | null }>('SELECT claimOwner FROM attempts WHERE id = ?', [handle.attemptId]);
    if (row?.claimOwner !== handle.owner) {
      throw new CoreError('fence_stale', `attempt '${handle.attemptId}' is owned by another worker`);
    }
    const expiresAt = new Date(Date.now() + leaseMs).toISOString();
    db.run('UPDATE attempts SET claimExpiresAt = ?, updatedAt = ? WHERE id = ?', [expiresAt, nowIso(), handle.attemptId]);
    return expiresAt;
  });
}

/**
 * Throws `fence_stale` if the attempt is fenced and `token` is not its current
 * token. A `null`/absent token is accepted only when the attempt itself is
 * unfenced (fenceToken IS NULL) — this preserves back-compat for unfenced
 * legacy/admin routes while making a fenced attempt strictly require its token.
 * Must be called inside the caller's transaction (reads the row for update).
 */
export function assertFence(db: CoreDatabase, attemptId: string, token: string | null | undefined): void {
  const row = db.get<{ fenceToken: string | null }>('SELECT fenceToken FROM attempts WHERE id = ?', [attemptId]);
  if (!row) throw new CoreError('not_found', `attempt '${attemptId}' not found`);
  const current = row.fenceToken ?? null;
  if (current === null) return; // unfenced attempt — no fence required
  if (token !== current) {
    throw new CoreError('fence_stale', `attempt '${attemptId}' fence token is stale; a newer executor owns this attempt`, {
      attemptId,
    });
  }
}
