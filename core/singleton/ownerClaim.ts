import type { CoreDatabase } from '../db/connection';
import { getMetadata, setMetadata } from '../db/metadata';
import { checkStaleness } from './staleness';

const OWNER_KEY = 'singleton_owner';

export interface SingletonOwner {
  instanceId: string;
  pid: number;
  processStartedAtIso: string | null;
  claimedAt: string;
  heartbeatAt: string;
}

export type ClaimResult = { claimed: true } | { claimed: false; existingOwner: SingletonOwner };

/**
 * The authoritative singleton claim. Must run inside a `BEGIN IMMEDIATE`
 * transaction (db.transaction) so two processes that both opened the same
 * database file cannot both believe they won. Even a process that won the
 * OS-level lock file race must still lose here if a fresher owner already
 * holds the DB-level claim (e.g. a crash left a stale lock file behind
 * while the real owner is listening on a different, still-healthy port).
 */
export function claimDatabaseOwnership(
  db: CoreDatabase,
  candidate: { instanceId: string; pid: number; processStartedAtIso: string | null },
): ClaimResult {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const existing = getMetadata<SingletonOwner>(db, OWNER_KEY);

    if (existing) {
      const staleness = checkStaleness({
        pid: existing.pid,
        processStartedAtIso: existing.processStartedAtIso,
        heartbeatAt: existing.heartbeatAt,
      });
      if (!staleness.stale) {
        return { claimed: false, existingOwner: existing };
      }
    }

    const owner: SingletonOwner = {
      instanceId: candidate.instanceId,
      pid: candidate.pid,
      processStartedAtIso: candidate.processStartedAtIso,
      claimedAt: now,
      heartbeatAt: now,
    };
    setMetadata(db, OWNER_KEY, owner);
    return { claimed: true };
  });
}

export function getCurrentOwner(db: CoreDatabase): SingletonOwner | undefined {
  return getMetadata<SingletonOwner>(db, OWNER_KEY);
}

export function heartbeatOwnership(db: CoreDatabase, instanceId: string): void {
  db.transaction(() => {
    const existing = getMetadata<SingletonOwner>(db, OWNER_KEY);
    if (!existing || existing.instanceId !== instanceId) {
      throw new Error(`cannot heartbeat: instance ${instanceId} does not hold the singleton_owner claim`);
    }
    setMetadata(db, OWNER_KEY, { ...existing, heartbeatAt: new Date().toISOString() });
  });
}

export function releaseOwnership(db: CoreDatabase, instanceId: string): void {
  db.transaction(() => {
    const existing = getMetadata<SingletonOwner>(db, OWNER_KEY);
    if (existing && existing.instanceId === instanceId) {
      db.run("DELETE FROM core_metadata WHERE key = ?", [OWNER_KEY]);
    }
  });
}
