import * as path from 'node:path';
import { readDiscoveryRecord, removeDiscoveryRecord, type DiscoveryRecord } from '../../core/discovery/record';
import { sameDataDir } from '../../core/env/dataDir';
import type { CoreInfo } from '../../core/shared/wireTypes';

/**
 * Instance-ownership invariant (Build 161 audit, P0):
 *
 *   A host may connect to, pause or stop a Core ONLY after that Core has
 *   proven — on its authenticated info route — that it serves the host's own
 *   data directory.
 *
 * The discovery record (core.json) and the token (core.token) are plain files.
 * A copied or restored profile carries both, so "the record points here and
 * the token works" proves only that the Core belongs to SOME copy of this
 * profile. The data directory the Core reports is what tells them apart.
 */
export type CoreOwnershipProbe =
  /** No discovery record: no Core of this profile is known. */
  | { state: 'absent' }
  /** The recorded Core answered and serves this profile. */
  | { state: 'owned'; record: DiscoveryRecord; info: CoreInfo; baseUrl: string }
  /** The recorded Core answered but serves ANOTHER profile: the record was copied. */
  | { state: 'foreign'; record: DiscoveryRecord; info: CoreInfo }
  /** Something answered on the recorded port but rejected this profile's token. */
  | { state: 'unauthenticated'; record: DiscoveryRecord }
  /** Nothing usable answered on the recorded port. */
  | { state: 'unreachable'; record: DiscoveryRecord };

export type CoreInfoProbe =
  | { ok: true; info: CoreInfo }
  | { ok: false; reason: 'unreachable' | 'unauthenticated' | 'error' };

export async function probeCoreInfo(port: number, token: string, timeoutMs: number): Promise<CoreInfoProbe> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/core/info`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) return { ok: false, reason: 'unauthenticated' };
    if (!res.ok) return { ok: false, reason: 'error' };
    return { ok: true, info: (await res.json()) as CoreInfo };
  } catch {
    return { ok: false, reason: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** True when a Core's reported info proves it serves `dataDir`. */
export function coreServesDataDir(info: Pick<CoreInfo, 'dataDir'>, dataDir: string): boolean {
  return sameDataDir(info.dataDir, dataDir);
}

/** Reads this profile's discovery record and asks the Core it names which profile it serves. */
export async function probeOwnedCore(input: { dataDir: string; token: string; timeoutMs?: number }): Promise<CoreOwnershipProbe> {
  const record = readDiscoveryRecord(path.join(input.dataDir, 'core.json'));
  if (!record || !Number.isInteger(record.port) || record.port <= 0) return { state: 'absent' };
  const probe = await probeCoreInfo(record.port, input.token, input.timeoutMs ?? 2_000);
  if (!probe.ok) {
    return probe.reason === 'unauthenticated' ? { state: 'unauthenticated', record } : { state: 'unreachable', record };
  }
  if (!coreServesDataDir(probe.info, input.dataDir)) return { state: 'foreign', record, info: probe.info };
  return { state: 'owned', record, info: probe.info, baseUrl: `http://127.0.0.1:${record.port}` };
}

/**
 * Removes this profile's discovery record when it is the copied record that
 * was just proven foreign — never a record a starting Core has since replaced.
 */
export function discardForeignDiscoveryRecord(dataDir: string, foreign: DiscoveryRecord): boolean {
  const recordPath = path.join(dataDir, 'core.json');
  const current = readDiscoveryRecord(recordPath);
  if (!current || current.instanceId !== foreign.instanceId || current.port !== foreign.port) return false;
  try {
    removeDiscoveryRecord(recordPath);
    return true;
  } catch {
    return false;
  }
}

/** The body every lifecycle call carries, so the Core itself refuses a call meant for another Core. */
export function lifecycleAddress(info: Pick<CoreInfo, 'instanceId'>, dataDir: string): { expectedInstanceId: string; expectedDataDir: string } {
  return { expectedInstanceId: info.instanceId, expectedDataDir: dataDir };
}
