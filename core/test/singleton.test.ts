import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { acquireSingleton } from '../singleton/acquireSingleton';
import { readLockFile, tryCreateLockFile, type LockRecord } from '../singleton/lockFile';
import { checkStaleness } from '../singleton/staleness';
import { getCurrentOwner } from '../singleton/ownerClaim';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-singleton-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('checkStaleness (unit, injected deps)', () => {
  it('flags a dead pid as stale regardless of heartbeat freshness', () => {
    const result = checkStaleness(
      { pid: 12345, processStartedAtIso: null, heartbeatAt: new Date().toISOString() },
      { isProcessAlive: () => false, getProcessStartTimeIso: () => null, now: () => new Date() },
    );
    expect(result.stale).toBe(true);
  });

  it('flags a start-time mismatch as stale (PID reuse)', () => {
    const result = checkStaleness(
      { pid: 1, processStartedAtIso: '2020-01-01T00:00:00.000Z', heartbeatAt: new Date().toISOString() },
      { isProcessAlive: () => true, getProcessStartTimeIso: () => '2026-01-01T00:00:00.000Z', now: () => new Date() },
    );
    expect(result.stale).toBe(true);
  });

  it('flags an aged heartbeat as stale even when pid is alive and start time matches', () => {
    const oldHeartbeat = new Date(Date.now() - 6 * 60_000).toISOString();
    const result = checkStaleness(
      { pid: 1, processStartedAtIso: 'x', heartbeatAt: oldHeartbeat },
      { isProcessAlive: () => true, getProcessStartTimeIso: () => 'x', now: () => new Date() },
    );
    expect(result.stale).toBe(true);
  });

  it('does not presume a live core hung while its event loop is blocked by a synchronous check (<5 min)', () => {
    const result = checkStaleness(
      { pid: 1, processStartedAtIso: 'x', heartbeatAt: new Date(Date.now() - 90_000).toISOString() },
      { isProcessAlive: () => true, getProcessStartTimeIso: () => 'x', now: () => new Date() },
    );
    expect(result.stale).toBe(false);
  });

  it('is not stale when alive, start time matches (or undeterminable), and heartbeat is fresh', () => {
    const result = checkStaleness(
      { pid: 1, processStartedAtIso: null, heartbeatAt: new Date().toISOString() },
      { isProcessAlive: () => true, getProcessStartTimeIso: () => null, now: () => new Date() },
    );
    expect(result.stale).toBe(false);
  });
});

describe('acquireSingleton (real files + real sqlite)', () => {
  it('the first acquirer wins both the lock file and the DB claim', () => {
    const dir = makeTempDir();
    const lockFilePath = path.join(dir, 'core.lock');
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      const result = acquireSingleton({ lockFilePath, db, port: 4000, apiVersion: 1, coreVersion: '0.1.0' });
      expect(result.acquired).toBe(true);
      const owner = getCurrentOwner(db);
      expect(owner?.pid).toBe(process.pid);
      const lockRecord = readLockFile(lockFilePath);
      expect(lockRecord?.port).toBe(4000);
    } finally {
      db.close();
    }
  });

  it('a second attempt against the same live lock file loses', () => {
    const dir = makeTempDir();
    const lockFilePath = path.join(dir, 'core.lock');
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      const first = acquireSingleton({ lockFilePath, db, port: 4000, apiVersion: 1, coreVersion: '0.1.0' });
      expect(first.acquired).toBe(true);

      const second = acquireSingleton({ lockFilePath, db, port: 4001, apiVersion: 1, coreVersion: '0.1.0' });
      expect(second.acquired).toBe(false);

      // The original owner's lock file and DB claim must be untouched by the loser.
      const lockRecord = readLockFile(lockFilePath);
      expect(lockRecord?.port).toBe(4000);
    } finally {
      db.close();
    }
  });

  it('recovers a stale lock file (dead-looking heartbeat) and lets a new owner claim it', () => {
    const dir = makeTempDir();
    const lockFilePath = path.join(dir, 'core.lock');
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      // Craft a stale-looking lock file directly (simulating a crashed prior Core) without going
      // through the DB claim, so the DB has no owner row yet either.
      const staleRecord: LockRecord = {
        instanceId: 'dead-instance',
        pid: process.pid, // alive, but...
        processStartedAtIso: 'not-the-real-start-time', // ...mismatched, so it's still flagged stale
        port: 9999,
        apiVersion: 1,
        coreVersion: '0.0.1',
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      };
      expect(tryCreateLockFile(lockFilePath, staleRecord)).toBe(true);

      const result = acquireSingleton({ lockFilePath, db, port: 4000, apiVersion: 1, coreVersion: '0.1.0' });
      expect(result.acquired).toBe(true);
      const lockRecord = readLockFile(lockFilePath);
      expect(lockRecord?.port).toBe(4000);
    } finally {
      db.close();
    }
  });

  it('release() clears both the lock file and the DB owner row so a later acquire can succeed', () => {
    const dir = makeTempDir();
    const lockFilePath = path.join(dir, 'core.lock');
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      const first = acquireSingleton({ lockFilePath, db, port: 4000, apiVersion: 1, coreVersion: '0.1.0' });
      expect(first.acquired).toBe(true);
      if (first.acquired) first.handle.release();

      expect(readLockFile(lockFilePath)).toBeNull();
      expect(getCurrentOwner(db)).toBeUndefined();

      const second = acquireSingleton({ lockFilePath, db, port: 4001, apiVersion: 1, coreVersion: '0.1.0' });
      expect(second.acquired).toBe(true);
    } finally {
      db.close();
    }
  });
});
