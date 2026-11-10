import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { tryCreateLockFile, readLockFile, writeLockFileAtomic, removeLockFile, type LockRecord } from './lockFile';
import { checkStaleness, HEARTBEAT_INTERVAL_MS } from './staleness';
import { claimDatabaseOwnership, heartbeatOwnership, isForeignOwner, releaseOwnership } from './ownerClaim';
import { getProcessStartTimeIso } from './processStartTime';

export interface SingletonHandle {
  instanceId: string;
  startHeartbeat(): void;
  stopHeartbeat(): void;
  release(): void;
}

export interface AcquireSingletonInput {
  lockFilePath: string;
  db: CoreDatabase;
  port: number;
  apiVersion: number;
  coreVersion: string;
  /** Pre-generated instance ID, so callers can reference it before knowing whether the claim succeeds. */
  instanceId?: string;
  /**
   * The data directory this Core serves. Recorded in the lock and the database
   * claim, so a copy of this profile can tell that they are not its own.
   */
  dataDir?: string;
  /**
   * Live owners already proven to be a Core of ANOTHER data directory (a lock
   * or claim copied from a profile that did not record its directory).
   */
  foreignInstanceIds?: ReadonlySet<string>;
}

export type AcquireSingletonResult = { acquired: true; handle: SingletonHandle } | { acquired: false; reason: string };

/**
 * Two-layer singleton acquisition (M31 plan §2): OS-level lock file first
 * (resolves launch races atomically via exclusive file create), then the
 * authoritative DB-level `singleton_owner` claim. A process must win both to
 * proceed; losing either means another Core already owns (or is about to
 * own) this database, and this process must not serve traffic.
 */
export function acquireSingleton(input: AcquireSingletonInput): AcquireSingletonResult {
  const instanceId = input.instanceId ?? crypto.randomUUID();
  const pid = process.pid;
  const processStartedAtIso = getProcessStartTimeIso(pid);

  const foreign = { foreignInstanceIds: input.foreignInstanceIds };
  const existingLock = readLockFile(input.lockFilePath);
  if (existingLock) {
    // A lock copied from another profile names a live Core that does not serve
    // this directory; it is as stale as a lock whose process is gone.
    const copiedFromAnotherProfile = isForeignOwner(existingLock, input.dataDir, foreign);
    const staleness = copiedFromAnotherProfile
      ? { stale: true }
      : checkStaleness({
        pid: existingLock.pid,
        processStartedAtIso: existingLock.processStartedAtIso,
        heartbeatAt: existingLock.heartbeatAt,
      });
    if (!staleness.stale) {
      return { acquired: false, reason: `lock file held by a live owner (pid ${existingLock.pid})` };
    }
    removeLockFile(input.lockFilePath);
  }

  const record: LockRecord = {
    instanceId,
    pid,
    processStartedAtIso,
    port: input.port,
    apiVersion: input.apiVersion,
    coreVersion: input.coreVersion,
    heartbeatAt: new Date().toISOString(),
    ...(input.dataDir ? { dataDir: input.dataDir } : {}),
  };

  if (!tryCreateLockFile(input.lockFilePath, record)) {
    return { acquired: false, reason: 'lost the lock-file creation race to another process' };
  }

  const dbClaim = claimDatabaseOwnership(input.db, { instanceId, pid, processStartedAtIso, dataDir: input.dataDir }, foreign);
  if (!dbClaim.claimed) {
    // Won the OS-level race (possibly against a stale lock file) but the DB says a fresher owner
    // already exists — DB ownership is authoritative, so back out of the lock file we just wrote.
    removeLockFile(input.lockFilePath);
    return { acquired: false, reason: `database is already owned by instance ${dbClaim.existingOwner.instanceId}` };
  }

  let heartbeatTimer: NodeJS.Timeout | null = null;
  const handle: SingletonHandle = {
    instanceId,
    startHeartbeat() {
      if (heartbeatTimer) return;
      heartbeatTimer = setInterval(() => {
        const now = new Date().toISOString();
        writeLockFileAtomic(input.lockFilePath, { ...record, heartbeatAt: now });
        heartbeatOwnership(input.db, instanceId);
      }, HEARTBEAT_INTERVAL_MS);
      heartbeatTimer.unref();
    },
    stopHeartbeat() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    },
    release() {
      handle.stopHeartbeat();
      releaseOwnership(input.db, instanceId);
      removeLockFile(input.lockFilePath);
    },
  };
  return { acquired: true, handle };
}
