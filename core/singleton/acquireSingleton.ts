import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { tryCreateLockFile, readLockFile, writeLockFileAtomic, removeLockFile, type LockRecord } from './lockFile';
import { checkStaleness, HEARTBEAT_INTERVAL_MS } from './staleness';
import { claimDatabaseOwnership, heartbeatOwnership, releaseOwnership } from './ownerClaim';
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

  const existingLock = readLockFile(input.lockFilePath);
  if (existingLock) {
    const staleness = checkStaleness({
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
  };

  if (!tryCreateLockFile(input.lockFilePath, record)) {
    return { acquired: false, reason: 'lost the lock-file creation race to another process' };
  }

  const dbClaim = claimDatabaseOwnership(input.db, { instanceId, pid, processStartedAtIso });
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
