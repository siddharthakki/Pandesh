import type { InvestigationRecord } from './InvestigationTranscript';

/**
 * Host-owned evidence-reuse state for the investigation loop (local-model context efficiency).
 *
 * The loop already stores structured reads/searches and compacts them deterministically. This adds the missing three
 * guarantees on top of that same store, without a second context system:
 *
 *   1. A range already delivered for the SAME file content is not delivered again while its body is still in the prompt.
 *   2. If compaction dropped that body, one bounded re-read is allowed and pinned so the next compaction drops other
 *      bodies first. A range can be delivered at most MAX_DELIVERIES_PER_RANGE times: no discard -> reread -> discard loop.
 *   3. The same store is carried across retry/repair loops of one task, so a retry starts from retained evidence and
 *      only re-reads what changed on disk.
 */

export const MAX_DELIVERIES_PER_RANGE = 2;

export interface ReadHistoryEntryShape {
  path: string;
  totalLines: number;
  characterCount: number;
  minLineRead: number;
  maxLineRead: number;
  eofReached: boolean;
  fullyRead: boolean;
  /** Whole-file content fingerprint the history describes; a different fingerprint means the file changed. */
  fingerprint?: string;
  /** Disjoint-or-overlapping line ranges delivered so far for that fingerprint. */
  ranges?: Array<[number, number]>;
}

export class InvestigationEvidenceCarry {
  readonly records: InvestigationRecord[] = [];
  readonly history = new Map<string, ReadHistoryEntryShape>();
  /** `${path}\n${a}-${b}` -> how many times that exact range body was delivered. */
  readonly deliveries = new Map<string, number>();
  /** Read keys that must survive the next compaction (a re-read granted after a body was dropped). */
  readonly pinned = new Set<string>();
  /** Counters for tests and progress evidence. */
  stats = { suppressedRepeats: 0, grantedRereads: 0, refusedRereads: 0, invalidatedPaths: 0 };

  /** Drops everything known about one path (the file changed on disk). */
  invalidatePath(path: string): void {
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index];
      if (record.kind === 'read' && record.path === path) this.records.splice(index, 1);
    }
    this.history.delete(path);
    for (const key of [...this.deliveries.keys()]) if (key.startsWith(`${path}\n`)) this.deliveries.delete(key);
    for (const key of [...this.pinned]) if (key.startsWith(`${path}\n`)) this.pinned.delete(key);
    this.stats.invalidatedPaths += 1;
  }

  /** Distinct paths that carried successful reads. */
  readPaths(): string[] {
    return [...new Set(this.records.flatMap(record => (record.kind === 'read' && record.ok && !record.noUnreadContent ? [record.path] : [])))];
  }
}

export function readKey(path: string, range: string): string {
  return `${path}\n${range}`;
}

export function parseRange(range: string): [number, number] | undefined {
  const match = /^(?:lines\s+)?(\d+)-(\d+)$/.exec(range.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? [start, end] : undefined;
}

export function rangeCovers(outer: readonly [number, number], inner: readonly [number, number]): boolean {
  return outer[0] <= inner[0] && outer[1] >= inner[1];
}

/** Merges a delivered range into the history's covered ranges (kept sorted and coalesced). */
export function addCoveredRange(ranges: Array<[number, number]> | undefined, added: readonly [number, number]): Array<[number, number]> {
  const all = [...(ranges ?? []), [added[0], added[1]] as [number, number]].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const range of all) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export function isCovered(ranges: ReadonlyArray<readonly [number, number]> | undefined, wanted: readonly [number, number]): boolean {
  return (ranges ?? []).some(range => rangeCovers(range, wanted));
}

/** The record (if any) whose delivered body covers the wanted range for this exact content fingerprint. */
export function findCoveringRead(
  records: readonly InvestigationRecord[],
  path: string,
  wanted: readonly [number, number],
  fingerprint: string,
): { key: string } | undefined {
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index];
    if (record.kind !== 'read' || !record.ok || record.noUnreadContent || record.path !== path || record.fingerprint !== fingerprint) continue;
    const range = parseRange(record.range);
    if (range && rangeCovers(range, wanted)) return { key: readKey(record.path, record.range) };
  }
  return undefined;
}
