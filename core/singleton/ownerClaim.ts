import type { CoreDatabase } from '../db/connection';
import { getMetadata, setMetadata } from '../db/metadata';
import { sameDataDir } from '../env/dataDir';
import { checkStaleness } from './staleness';

const OWNER_KEY = 'singleton_owner';

export interface SingletonOwner {
  instanceId: string;
  pid: number;
  processStartedAtIso: string | null;
  claimedAt: string;
  heartbeatAt: string;
  /**
   * The data directory the owner serves. A claim that names another directory
   * was copied with the database (a backup or a cloned profile) and does not
   * describe who owns THIS file. Absent on claims written by Build 160 and earlier.
   */
  dataDir?: string;
}

export type ClaimResult = { claimed: true } | { claimed: false; existingOwner: SingletonOwner };

export interface ForeignOwnerOptions {
  /**
   * Live owners the caller has proven to be a Core serving a different data
   * directory (their claim or lock was copied along with this profile).
   */
  foreignInstanceIds?: ReadonlySet<string>;
}

/** True when a recorded lock or claim provably belongs to another profile's Core, not to this data directory. */
export function isForeignOwner(
  owner: { instanceId: string; dataDir?: string },
  dataDir: string | undefined,
  options?: ForeignOwnerOptions,
): boolean {
  if (options?.foreignInstanceIds?.has(owner.instanceId)) return true;
  return Boolean(owner.dataDir && dataDir && !sameDataDir(owner.dataDir, dataDir));
}

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
  candidate: { instanceId: string; pid: number; processStartedAtIso: string | null; dataDir?: string },
  options?: ForeignOwnerOptions,
): ClaimResult {
  return db.transaction(() => {
    const now = new Date().toISOString();
    const existing = getMetadata<SingletonOwner>(db, OWNER_KEY);

    // A claim copied with the database belongs to the Core of another profile:
    // that Core is alive, but it does not hold THIS file.
    if (existing && !isForeignOwner(existing, candidate.dataDir, options)) {
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
      ...(candidate.dataDir ? { dataDir: candidate.dataDir } : {}),
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
