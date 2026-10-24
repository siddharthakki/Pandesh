/**
 * Proposal-time identity for a Saath Kar `write_file` mutation.
 *
 * Two problems are solved here, both before the approval checkpoint exists:
 *
 *  1. INSPECTABLE, DETERMINISTIC PREVIEW. The approval card must show the
 *     proposal that is actually being approved. Computing a diff later, when
 *     the card happens to render (or re-render after a restart), reads
 *     whatever bytes are on disk at that moment — a TOCTOU preview that can
 *     show `B -> C` while the frozen approval identity still means `A -> C`.
 *     So the bounded unified diff is generated ONCE, here, at proposal time,
 *     and carried through the approval record as an immutable presentation
 *     field. Restoring a card never recomputes it.
 *
 *  2. STALE PRE-IMAGE PROTECTION. The pre-image the proposal was made against
 *     is captured as a baseline identity — a SHA-256 for an existing file, or
 *     the distinct `absent` identity for a file that does not exist yet.
 *     `absent` is deliberately NOT the hash of an empty file: "create this
 *     file" and "replace this now-empty file" are different proposals, and a
 *     file that appears between proposal and approval must not be silently
 *     overwritten. The baseline travels inside the approval summary (so it is
 *     bound by the requested-action digest and survives restart), and is
 *     verified against the real filesystem immediately before the write in
 *     `core/runtime/toolRunner.ts`.
 *
 * Core-safe: node `fs`/`crypto` only, no `vscode`.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recoverRepositoryPath } from './repositoryPathRecovery';

/** The pre-image one `write_file` proposal was made against. */
export type WriteBaselineIdentity =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string };

/** The immutable, proposal-time rendering of a `write_file` proposal. Stored
 * separately from the approval summary/digest (it is presentation, not
 * authority) and never regenerated afterwards. */
export interface WriteProposalPresentation {
  kind: 'write_file_diff';
  /** Workspace-relative path the diff was generated for. */
  path: string;
  /** `absent` when the proposal creates a new file. */
  baseline: WriteBaselineIdentity['kind'];
  /** Bounded unified diff, or an honest note when one cannot be rendered. */
  diff: string;
  truncated: boolean;
  baselineLines: number;
  proposedLines: number;
  /** Workspace-relative parent directories that do not exist yet and will be
   * created — outermost first — if this proposal is approved. Absent when the
   * parent already exists. */
  createsDirectories?: string[];
}

/** How much of an existing file a whole-file replacement keeps. Computed from the
 * same baseline/proposed text the diff is rendered from; never stored. */
export interface WholeFileReplacementStats {
  baselineLines: number;
  proposedLines: number;
  baselineChars: number;
  proposedChars: number;
  /** Fraction (0..1) of baseline non-blank lines that survive in the proposal. */
  retainedLineFraction: number;
}

export interface WriteFileProposal {
  /** Absolute path the proposal resolved to at proposal time. */
  resolvedPath: string;
  /** Workspace-relative path the proposal resolved to. */
  selectedPath: string;
  expectedBaseline: WriteBaselineIdentity;
  presentation: WriteProposalPresentation;
  /** Present only when an existing, renderable file is being replaced. */
  replacement?: WholeFileReplacementStats;
}

/** An existing file smaller than this is "trivial": replacing it wholesale is normal. */
const SUSPICIOUS_MIN_BASELINE_LINES = 8;
const SUSPICIOUS_MIN_BASELINE_CHARS = 500;
/** The proposal keeps at most this share of the baseline's size AND of its lines. */
const SUSPICIOUS_MAX_KEPT_FRACTION = 0.3;

/**
 * True when a whole-file replacement of an existing, non-trivial file discards
 * a very large fraction of it — the signature of a model sending only the
 * changed fragment to a tool that replaces the whole file. Size-based, never
 * model-specific. Resubmitting identical content does not make it acceptable.
 */
export function isSuspiciousWholeFileReplacement(stats: WholeFileReplacementStats | undefined): boolean {
  if (!stats) return false;
  if (stats.baselineLines < SUSPICIOUS_MIN_BASELINE_LINES && stats.baselineChars < SUSPICIOUS_MIN_BASELINE_CHARS) return false;
  return stats.proposedChars <= stats.baselineChars * SUSPICIOUS_MAX_KEPT_FRACTION
    && stats.retainedLineFraction <= SUSPICIOUS_MAX_KEPT_FRACTION;
}

function retainedLineFraction(before: string[], after: string[]): number {
  const counts = new Map<string, number>();
  for (const line of after) if (line.trim()) counts.set(line, (counts.get(line) ?? 0) + 1);
  let baseline = 0;
  let kept = 0;
  for (const line of before) {
    if (!line.trim()) continue;
    baseline++;
    const left = counts.get(line) ?? 0;
    if (left > 0) { kept++; counts.set(line, left - 1); }
  }
  return baseline === 0 ? 1 : kept / baseline;
}

/** Bounds on the generated preview — a proposal diff is a card, not a file. */
const MAX_DIFF_CHARS = 12_000;
const MAX_DIFF_LINES = 400;
/** Above this, the exact edit script is not computed; a bounded replacement
 * hunk is emitted instead. Keeps the LCS table small and predictable. */
const MAX_DIFFABLE_LINES = 1_200;
/** Never read more than this from disk to build a baseline preview. */
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

export function sha256OfBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Reads the current on-disk identity of one path. A missing file is the
 * distinct `absent` identity — never an empty-file hash. A path that exists
 * but is not a regular file has no valid write baseline and is reported as
 * such so the caller fails closed rather than guessing.
 */
export function readBaselineIdentity(absolutePath: string): { baseline: WriteBaselineIdentity } | { error: string } {
  let stats: fs.Stats;
  try {
    stats = fs.statSync(absolutePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { baseline: { kind: 'absent' } };
    return { error: err instanceof Error ? err.message : String(err) };
  }
  if (!stats.isFile()) return { error: `'${absolutePath}' exists and is not a regular file` };
  try {
    return { baseline: { kind: 'file', sha256: sha256OfBuffer(fs.readFileSync(absolutePath)) } };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Absolute parent directories of `absoluteFile` that do not exist yet,
 * outermost first. Pure inspection: nothing is created here.
 */
export function missingParentDirectories(absoluteFile: string): string[] {
  const missing: string[] = [];
  let dir = path.dirname(absoluteFile);
  while (!fs.existsSync(dir)) {
    missing.unshift(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return missing;
}

/** Workspace-relative spelling of the directories a write would create,
 * derived from the already-resolved relative file path. */
export function describeCreatedDirectories(selectedPath: string, missingCount: number): string[] {
  if (missingCount === 0) return [];
  const segments = path.posix.dirname(selectedPath).split('/').filter((s) => s && s !== '.');
  const start = Math.max(0, segments.length - missingCount);
  return segments.slice(start).map((_, i) => segments.slice(0, start + i + 1).join('/'));
}

export function sameBaseline(left: WriteBaselineIdentity, right: WriteBaselineIdentity): boolean {
  if (left.kind === 'absent' || right.kind === 'absent') return left.kind === right.kind;
  return left.sha256 === right.sha256;
}

export function describeBaseline(baseline: WriteBaselineIdentity): string {
  return baseline.kind === 'absent' ? 'no file at this path' : `a file with sha256 ${baseline.sha256.slice(0, 12)}…`;
}

/**
 * Parses a baseline identity out of an already-frozen approval summary. Only
 * Core ever writes this field; anything shaped differently is treated as "no
 * baseline was captured" rather than being coerced into one.
 */
export function parseBaselineIdentity(value: unknown): WriteBaselineIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind === 'absent') return { kind: 'absent' };
  if (record.kind === 'file' && typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256)) {
    return { kind: 'file', sha256: record.sha256 };
  }
  return undefined;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  // A trailing newline yields a final empty element that is not a real line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

type DiffOp = { op: '=' | '-' | '+'; line: string };

/** Longest-common-subsequence edit script over two bounded line arrays. */
function editScript(before: string[], after: string[]): DiffOp[] {
  const rows = before.length;
  const cols = after.length;
  const table = new Int32Array((rows + 1) * (cols + 1));
  const at = (r: number, c: number) => r * (cols + 1) + c;
  for (let r = rows - 1; r >= 0; r--) {
    for (let c = cols - 1; c >= 0; c--) {
      table[at(r, c)] = before[r] === after[c]
        ? table[at(r + 1, c + 1)] + 1
        : Math.max(table[at(r + 1, c)], table[at(r, c + 1)]);
    }
  }
  const ops: DiffOp[] = [];
  let r = 0;
  let c = 0;
  while (r < rows && c < cols) {
    if (before[r] === after[c]) { ops.push({ op: '=', line: before[r] }); r++; c++; }
    else if (table[at(r + 1, c)] >= table[at(r, c + 1)]) { ops.push({ op: '-', line: before[r] }); r++; }
    else { ops.push({ op: '+', line: after[c] }); c++; }
  }
  while (r < rows) ops.push({ op: '-', line: before[r++] });
  while (c < cols) ops.push({ op: '+', line: after[c++] });
  return ops;
}

function commonPrefixLength(before: string[], after: string[]): number {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return i;
}

function commonSuffixLength(before: string[], after: string[], prefix: number): number {
  let i = 0;
  while (
    i < before.length - prefix
    && i < after.length - prefix
    && before[before.length - 1 - i] === after[after.length - 1 - i]
  ) i++;
  return i;
}

/**
 * A bounded unified diff with three lines of context. Deterministic for a
 * given (before, after) pair: the same inputs always render the same text.
 */
export function buildUnifiedDiff(before: string[], after: string[], label: string): { diff: string; truncated: boolean } {
  const header = `--- a/${label}\n+++ b/${label}`;
  if (before.length === 0 && after.length === 0) {
    return { diff: `${header}\n(no content)`, truncated: false };
  }
  const prefix = commonPrefixLength(before, after);
  const suffix = commonSuffixLength(before, after, prefix);
  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);

  let ops: DiffOp[];
  let truncated = false;
  if (beforeMiddle.length > MAX_DIFFABLE_LINES || afterMiddle.length > MAX_DIFFABLE_LINES) {
    // Too large for an exact edit script: emit one honest replacement hunk
    // rather than a misleading partial or an unbounded computation.
    truncated = true;
    ops = [
      ...beforeMiddle.slice(0, MAX_DIFF_LINES).map((line): DiffOp => ({ op: '-', line })),
      ...afterMiddle.slice(0, MAX_DIFF_LINES).map((line): DiffOp => ({ op: '+', line })),
    ];
  } else {
    ops = [
      ...before.slice(0, prefix).map((line): DiffOp => ({ op: '=', line })),
      ...editScript(beforeMiddle, afterMiddle),
      ...(suffix > 0 ? before.slice(before.length - suffix) : []).map((line): DiffOp => ({ op: '=', line })),
    ];
  }

  // Group the edit script into hunks with three lines of context.
  const keep = new Array<boolean>(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].op === '=') continue;
    for (let j = Math.max(0, i - 3); j <= Math.min(ops.length - 1, i + 3); j++) keep[j] = true;
  }

  const lines: string[] = [`--- a/${label}`, `+++ b/${label}`];
  let beforeLine = truncated ? prefix + 1 : 1;
  let afterLine = truncated ? prefix + 1 : 1;
  let index = 0;
  let emitted = 0;
  while (index < ops.length) {
    if (!keep[index]) {
      if (ops[index].op !== '+') beforeLine++;
      if (ops[index].op !== '-') afterLine++;
      index++;
      continue;
    }
    const hunkStartBefore = beforeLine;
    const hunkStartAfter = afterLine;
    const body: string[] = [];
    let beforeCount = 0;
    let afterCount = 0;
    while (index < ops.length && keep[index]) {
      const op = ops[index];
      if (op.op === '=') { body.push(` ${op.line}`); beforeCount++; afterCount++; beforeLine++; afterLine++; }
      else if (op.op === '-') { body.push(`-${op.line}`); beforeCount++; beforeLine++; }
      else { body.push(`+${op.line}`); afterCount++; afterLine++; }
      index++;
    }
    lines.push(`@@ -${hunkStartBefore},${beforeCount} +${hunkStartAfter},${afterCount} @@`);
    let hunkTruncated = false;
    for (const entry of body) {
      if (emitted >= MAX_DIFF_LINES) { truncated = true; hunkTruncated = true; break; }
      lines.push(entry);
      emitted++;
    }
    if (hunkTruncated) break;
  }

  let diff = lines.join('\n');
  if (diff.length > MAX_DIFF_CHARS) {
    diff = diff.slice(0, MAX_DIFF_CHARS);
    truncated = true;
  }
  if (truncated) diff += '\n…[diff truncated]';
  return { diff, truncated };
}

/**
 * Captures everything needed to approve, render, and later safely execute one
 * `write_file` call — BEFORE any approval exists. Returns `undefined` when the
 * path cannot be resolved inside the workspace (the existing path-recovery
 * rejection then reports that at execution time, unchanged) or when the
 * baseline itself cannot be read.
 */
export function buildWriteFileProposal(input: {
  workspaceRoot: string;
  requestedPath: string;
  content: string;
}): WriteFileProposal | undefined {
  const recovery = recoverRepositoryPath({
    workspaceRoot: input.workspaceRoot,
    requestedPath: input.requestedPath,
    target: 'write',
  });
  if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) return undefined;

  const identity = readBaselineIdentity(recovery.resolvedPath);
  if ('error' in identity) return undefined;

  const selectedPath = recovery.selected ?? recovery.normalized;
  let baselineText = '';
  let renderable = true;
  if (identity.baseline.kind === 'file') {
    try {
      const buffer = fs.readFileSync(recovery.resolvedPath);
      if (buffer.includes(0) || buffer.byteLength > MAX_BASELINE_BYTES) renderable = false;
      else baselineText = buffer.toString('utf8');
    } catch {
      renderable = false;
    }
  }

  const baselineLines = splitLines(baselineText);
  const proposedLines = splitLines(input.content);
  const rendered = renderable
    ? buildUnifiedDiff(baselineLines, proposedLines, selectedPath)
    : { diff: `--- a/${selectedPath}\n+++ b/${selectedPath}\n(binary or oversized baseline; diff not rendered)`, truncated: true };

  const createsDirectories = describeCreatedDirectories(selectedPath, missingParentDirectories(recovery.resolvedPath).length);
  const directoryNotice = createsDirectories.length > 0
    ? `Approving this will also create ${createsDirectories.length === 1 ? 'the parent directory' : 'the parent directories'}: ${createsDirectories.join(', ')}\n`
    : '';

  return {
    resolvedPath: recovery.resolvedPath,
    selectedPath,
    expectedBaseline: identity.baseline,
    presentation: {
      kind: 'write_file_diff',
      path: selectedPath,
      baseline: identity.baseline.kind,
      diff: `${directoryNotice}${rendered.diff}`,
      truncated: rendered.truncated,
      baselineLines: baselineLines.length,
      proposedLines: proposedLines.length,
      ...(createsDirectories.length > 0 ? { createsDirectories } : {}),
    },
    ...(identity.baseline.kind === 'file' && renderable
      ? {
          replacement: {
            baselineLines: baselineLines.length,
            proposedLines: proposedLines.length,
            baselineChars: baselineText.length,
            proposedChars: input.content.length,
            retainedLineFraction: retainedLineFraction(baselineLines, proposedLines),
          },
        }
      : {}),
  };
}
