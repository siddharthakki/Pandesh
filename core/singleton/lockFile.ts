import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LockRecord {
  instanceId: string;
  pid: number;
  processStartedAtIso: string | null;
  port: number;
  apiVersion: number;
  coreVersion: string;
  heartbeatAt: string;
}

/**
 * Atomic OS-level mutex: exactly one caller's `wx` create can succeed for a
 * given path. This resolves the "two clients racing to launch" case without
 * any additional locking — losers simply see EEXIST.
 */
export function tryCreateLockFile(lockFilePath: string, record: LockRecord): boolean {
  fs.mkdirSync(path.dirname(lockFilePath), { recursive: true });
  try {
    const fd = fs.openSync(lockFilePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(record));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

export function readLockFile(lockFilePath: string): LockRecord | null {
  try {
    const raw = fs.readFileSync(lockFilePath, 'utf8');
    return JSON.parse(raw) as LockRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

/** Atomic overwrite (temp + rename) used for heartbeat updates by the owning process only. */
export function writeLockFileAtomic(lockFilePath: string, record: LockRecord): void {
  const dir = path.dirname(lockFilePath);
  const tmpPath = path.join(dir, `.core.lock.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmpPath, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(tmpPath, lockFilePath);
}

export function removeLockFile(lockFilePath: string): void {
  try {
    fs.unlinkSync(lockFilePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
