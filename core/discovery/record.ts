import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * The public discovery record other VS Code windows read to find the
 * running Core. Deliberately contains no secret: per M31 §5, the auth token
 * is passed only through the child process's environment and is never
 * written to disk here.
 */
export interface DiscoveryRecord {
  pid: number;
  port: number;
  apiVersion: number;
  coreVersion: string;
  instanceId: string;
  startedAtIso: string;
}

export function writeDiscoveryRecord(discoveryRecordPath: string, record: DiscoveryRecord): void {
  fs.mkdirSync(path.dirname(discoveryRecordPath), { recursive: true });
  const tmpPath = path.join(path.dirname(discoveryRecordPath), `.core.json.${process.pid}.${Date.now()}.tmp`);
  // Owner-only permissions where the platform supports POSIX mode bits (Windows ignores this and
  // relies on the per-OS-user %LOCALAPPDATA% ACL instead; see docs/m31 security notes).
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  fs.renameSync(tmpPath, discoveryRecordPath);
}

export function readDiscoveryRecord(discoveryRecordPath: string): DiscoveryRecord | null {
  try {
    const raw = fs.readFileSync(discoveryRecordPath, 'utf8');
    return JSON.parse(raw) as DiscoveryRecord;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

export function removeDiscoveryRecord(discoveryRecordPath: string): void {
  try {
    fs.unlinkSync(discoveryRecordPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
