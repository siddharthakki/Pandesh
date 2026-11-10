import type { CoreDatabase } from '../db/connection';
import { readDiscoveryRecord } from '../discovery/record';
import { sameDataDir } from '../env/dataDir';
import { readLockFile } from './lockFile';
import { getCurrentOwner } from './ownerClaim';
import { isProcessAlive } from './processLiveness';

const PROBE_TIMEOUT_MS = 1_500;

/**
 * Finds live owners that only LOOK like the owner of this data directory.
 *
 * A profile copied while its Core was running carries that Core's lock file,
 * discovery record and database claim. Records written by Build 161 and later
 * name their data directory, so the copy recognises them directly. Records
 * written by Build 160 and earlier do not. For those, this asks the live
 * process itself — over its authenticated info route, with this Core's own
 * token — which directory it serves.
 *
 * Only a Core that ANSWERS and names a different directory is foreign. An
 * owner that is unreachable, rejects the token or does not answer stays an
 * owner: a copy that cannot prove anything stays blocked, it never takes over.
 */
export async function findForeignLiveOwners(input: {
  lockFilePath: string;
  discoveryRecordPath: string;
  db: CoreDatabase;
  token: string;
  dataDir: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Set<string>> {
  const foreign = new Set<string>();
  const candidates = new Map<string, number>();
  const lock = readLockFile(input.lockFilePath);
  if (lock && !lock.dataDir && isProcessAlive(lock.pid) && Number.isInteger(lock.port) && lock.port > 0) {
    candidates.set(lock.instanceId, lock.port);
  }
  let owner: { instanceId: string; pid: number; dataDir?: string } | undefined;
  try {
    owner = getCurrentOwner(input.db);
  } catch {
    owner = undefined;
  }
  if (owner && !owner.dataDir && isProcessAlive(owner.pid) && !candidates.has(owner.instanceId)) {
    const record = readDiscoveryRecord(input.discoveryRecordPath);
    if (record && record.instanceId === owner.instanceId && Number.isInteger(record.port) && record.port > 0) {
      candidates.set(owner.instanceId, record.port);
    }
  }

  const fetchImpl = input.fetchImpl ?? fetch;
  for (const [instanceId, port] of candidates) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/v1/core/info`, {
        headers: { Authorization: `Bearer ${input.token}` },
        signal: AbortSignal.timeout(input.timeoutMs ?? PROBE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const info = (await res.json()) as { instanceId?: string; dataDir?: string };
      if (info.instanceId === instanceId && info.dataDir && !sameDataDir(info.dataDir, input.dataDir)) {
        foreign.add(instanceId);
      }
    } catch {
      // Unreachable or silent: not proven foreign.
    }
  }
  return foreign;
}
