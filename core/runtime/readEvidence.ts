/**
 * M53 — range-aware read evidence for the Saath Kar / Core loop.
 *
 * The loop's duplicate guard (`loopProgress.ts`) is keyed by the exact call arguments, so a model that re-reads the same
 * file through a different slice (`startLine=1,endLine=200`, then `60-120`, then past the end of the file) is never
 * recognised, and every slice spends context again. This module keeps one small evidence entry per file, bound to the
 * file's content fingerprint, and answers: "is what this read would return already in the model's context?"
 *
 *  - delivered ranges are what a read ACTUALLY returned (a whole-file read cut at the tool limit delivers a prefix, not
 *    the file);
 *  - a changed fingerprint drops everything known about the file;
 *  - a range whose body was cleared by compaction may be fetched again, but only a bounded number of times, so
 *    clear -> reread -> clear can never loop;
 *  - a host-supplied pack that contains a whole file seeds the entry (the pack lives in the fixed base context and is never
 *    cleared);
 *  - reads past the end of the file are refused outright.
 *
 * Pure: no I/O, no clock. The executor hashes files and owns every side effect. The state is JSON and travels inside
 * `loopProgress`, so it survives a restart with the rest of the loop continuation.
 */

export const MAX_DELIVERIES_PER_RANGE = 2;
/** Same bound the read tool applies to one result (toolRunner MAX_OUTPUT_CHARS). */
export const READ_RESULT_MAX_CHARS = 8000;
/** After the context was last-resort compacted, reads are limited to this many lines at a time. */
export const NARROW_READ_LINES = 80;
const MAX_OPERATION_KEYS_PER_PATH = 16;
const MAX_TRACKED_PATHS = 48;

export type LineRange = [number, number];

export interface ReadEvidenceEntry {
  /** SHA-256 of the whole file the ranges describe. A different fingerprint means the file changed. */
  fingerprint: string;
  totalLines: number;
  /** Delivered line ranges, sorted and coalesced. */
  ranges: LineRange[];
  /** `${a}-${b}` -> how many times that exact slice was delivered. */
  deliveries: Record<string, number>;
  /** Operation keys of the read calls that delivered bodies (to ask whether a body is still in context). */
  opKeys: string[];
  /** The whole file is in the fixed pack of this attempt; that body is never cleared. */
  inPack?: boolean;
}

export type ReadEvidenceState = Record<string, ReadEvidenceEntry>;

export function normalizeReadPath(raw: string): string {
  return String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** The lines a `read_file` call with these arguments returns for `text`, mirroring the tool's own bound. */
export function effectiveReadRange(text: string, requested: { startLine?: number; endLine?: number }): { range: LineRange | undefined; totalLines: number; truncated: boolean } {
  const lines = splitLines(text);
  const totalLines = lines.length;
  const ranged = requested.startLine !== undefined || requested.endLine !== undefined;
  const from = requested.startLine ?? 1;
  const requestedTo = Math.min(requested.endLine ?? totalLines, totalLines);
  if (from > requestedTo) return { range: undefined, totalLines, truncated: false };
  if (!ranged && text.length <= READ_RESULT_MAX_CHARS) return { range: totalLines === 0 ? undefined : [1, totalLines], totalLines, truncated: false };
  let chars = 0;
  let count = 0;
  for (let n = from; n <= requestedTo; n += 1) {
    if (count > 0 && chars + lines[n - 1].length + 1 > READ_RESULT_MAX_CHARS) break;
    count += 1;
    chars += lines[n - 1].length + 1;
  }
  const to = from + count - 1;
  return { range: [from, to], totalLines, truncated: to < requestedTo };
}

export function coalesce(ranges: readonly LineRange[], added: LineRange): LineRange[] {
  const all = [...ranges.map((range) => [range[0], range[1]] as LineRange), [added[0], added[1]] as LineRange].sort((a, b) => a[0] - b[0]);
  const merged: LineRange[] = [];
  for (const range of all) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

export function isCovered(ranges: readonly LineRange[], wanted: LineRange): boolean {
  return ranges.some((range) => range[0] <= wanted[0] && range[1] >= wanted[1]);
}

const rangeKey = (range: LineRange): string => `${range[0]}-${range[1]}`;

export type ReadDecision =
  | { action: 'execute' }
  | { action: 'refuse'; kind: 'eof' | 'covered' | 'rereads_exhausted' | 'narrow'; reason: string };

export interface ReadCheckInput {
  path: string;
  /** Fingerprint of the file as it is on disk now. */
  fingerprint: string;
  text: string;
  requested: { startLine?: number; endLine?: number };
  /** Whether the body delivered under this operation key is still in the active prompt. */
  bodyPresent: (operationKey: string) => boolean;
  /** Set once context was last-resort compacted: reads must be narrow. */
  narrowReadLines?: number;
}

/** Judges one `read_file` call against what the loop already delivered for the same file content. */
export function decideRead(state: ReadEvidenceState | undefined, input: ReadCheckInput): { decision: ReadDecision; effective: ReturnType<typeof effectiveReadRange> } {
  const key = normalizeReadPath(input.path);
  const effective = effectiveReadRange(input.text, input.requested);
  const display = input.path;

  if (input.requested.startLine !== undefined && input.requested.startLine > effective.totalLines) {
    return {
      effective,
      decision: { action: 'refuse', kind: 'eof', reason: `'${display}' has only ${effective.totalLines} lines; nothing exists past line ${effective.totalLines}. Do not read beyond the end of the file` },
    };
  }
  if (!effective.range) return { effective, decision: { action: 'execute' } };

  if (input.narrowReadLines !== undefined) {
    const span = effective.range[1] - effective.range[0] + 1;
    if (span > input.narrowReadLines) {
      return {
        effective,
        decision: { action: 'refuse', kind: 'narrow', reason: `the context window is nearly full; read at most ${input.narrowReadLines} lines at a time with startLine/endLine (this call would return ${span})` },
      };
    }
  }

  const entry = state?.[key];
  if (!entry || entry.fingerprint !== input.fingerprint) return { effective, decision: { action: 'execute' } };
  if (!isCovered(entry.ranges, effective.range)) return { effective, decision: { action: 'execute' } };

  const present = entry.inPack === true || entry.opKeys.some((opKey) => input.bodyPresent(opKey));
  const label = `lines ${effective.range[0]}-${effective.range[1]} of '${display}'`;
  if (present) {
    const next = effective.truncated ? ` The read limit cut this at line ${effective.range[1]}; continue with startLine=${effective.range[1] + 1}.` : '';
    return {
      effective,
      decision: { action: 'refuse', kind: 'covered', reason: `${label} ${entry.inPack ? 'is already in the context supplied for this task' : 'were already delivered and are still in context'}, and the file has not changed${next}` },
    };
  }
  const deliveries = entry.deliveries[rangeKey(effective.range)] ?? 0;
  if (deliveries >= MAX_DELIVERIES_PER_RANGE) {
    return {
      effective,
      decision: { action: 'refuse', kind: 'rereads_exhausted', reason: `${label} was delivered ${deliveries} times and cleared from context to save space; do not read it again. Work from the evidence you have, or read a different range` },
    };
  }
  return { effective, decision: { action: 'execute' } };
}

export interface ReadGuardResult {
  decision: ReadDecision;
  effective: ReturnType<typeof effectiveReadRange>;
  fingerprint: string;
}

/** Records a successful read. A different fingerprint replaces the entry. Returns the new state (the input is not mutated). */
export function recordRead(
  state: ReadEvidenceState | undefined,
  input: { path: string; fingerprint: string; totalLines: number; delivered: LineRange; operationKey: string },
): ReadEvidenceState {
  const key = normalizeReadPath(input.path);
  const next: ReadEvidenceState = { ...(state ?? {}) };
  const previous = next[key];
  const base: ReadEvidenceEntry = previous && previous.fingerprint === input.fingerprint
    ? previous
    : { fingerprint: input.fingerprint, totalLines: input.totalLines, ranges: [], deliveries: {}, opKeys: [] };
  const deliveries = { ...base.deliveries, [rangeKey(input.delivered)]: (base.deliveries[rangeKey(input.delivered)] ?? 0) + 1 };
  const opKeys = base.opKeys.includes(input.operationKey) ? base.opKeys : [...base.opKeys, input.operationKey].slice(-MAX_OPERATION_KEYS_PER_PATH);
  next[key] = { ...base, totalLines: input.totalLines, ranges: coalesce(base.ranges, input.delivered), deliveries, opKeys };
  const keys = Object.keys(next);
  if (keys.length > MAX_TRACKED_PATHS) for (const stale of keys.slice(0, keys.length - MAX_TRACKED_PATHS)) delete next[stale];
  return next;
}

/** Seeds the state with files a host pack delivered in full. */
export function seedFromPack(state: ReadEvidenceState | undefined, files: ReadonlyArray<{ path: string; fingerprint: string; totalLines: number }>): ReadEvidenceState {
  const next: ReadEvidenceState = { ...(state ?? {}) };
  for (const file of files) {
    if (file.totalLines <= 0) continue;
    next[normalizeReadPath(file.path)] = {
      fingerprint: file.fingerprint,
      totalLines: file.totalLines,
      ranges: [[1, file.totalLines]],
      deliveries: { [`1-${file.totalLines}`]: 1 },
      opKeys: [],
      inPack: true,
    };
  }
  return next;
}

/** Drops the evidence of a file (it was mutated). */
export function invalidatePath(state: ReadEvidenceState | undefined, path: string): ReadEvidenceState | undefined {
  if (!state) return state;
  const key = normalizeReadPath(path);
  if (!(key in state)) return state;
  const next = { ...state };
  delete next[key];
  return next;
}

export function refusedReadMessage(reason: string): string {
  return `[read_file] REFUSED as redundant: ${reason}. Nothing was read. Reuse the evidence already in context, or read a different range or file.`;
}

/** Whether an operation key is a read_file call on one of the pinned paths. */
export function isPinnedReadKey(operationKey: string, pinnedPaths: ReadonlySet<string>): boolean {
  if (!operationKey.startsWith('read_file:') || pinnedPaths.size === 0) return false;
  const match = /"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(operationKey);
  if (!match) return false;
  try {
    return pinnedPaths.has(normalizeReadPath(JSON.parse(`"${match[1]}"`) as string));
  } catch {
    return false;
  }
}
