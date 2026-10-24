import * as crypto from 'crypto';

/**
 * M46 Failure Fingerprints: semantic repetition, not just identical hashes.
 *
 * The M42 controller already refuses to dispatch the same *effective* attempt
 * twice, where "same" means an equal hash over cause, subcode, failure signature
 * and proposal/patch content. That misses the case that wastes the most turns on
 * a small model:
 *
 *   hypothesis A → edit → same failure → hypothesis A written a little differently
 *
 * A different byte string, the same idea, the same failure. This module supplies
 * the evidence to see it: a normalized failure identity (failing tests, error
 * classes, normalized message, implicated files) and a patch footprint that says
 * whether a change reworked the region the previous change already touched.
 *
 * Pure and deterministic. It decides nothing: `RecoveryController` stays the only
 * authority and merely receives a stronger `ProgressAssessment`.
 */

export const FINGERPRINT_VERSION = 1 as const;

export type ProgressVerdict =
  | 'same_failure_same_patch_family'
  | 'same_failure_different_patch'
  | 'no_new_evidence'
  | 'new_failure'
  | 'validation_improved'
  | 'regression';

export function digest(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24);
}

// ── failure output analysis ─────────────────────────────────────────────────

export interface FailureSemantics {
  /** Normalized, sorted names of failing tests. */
  tests: string[];
  /** Error classes: TypeError, AssertionError, TS2322, ENOENT, … */
  errorClasses: string[];
  /** Hash of the normalized error lines (order-independent, volatile parts removed). */
  messageKey: string;
  /** Repository-relative paths the output names. */
  files: string[];
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const STACK_FRAME = /^\s*(?:at\s|❯|›|›|from\s+node:|node:internal)/;
const SUMMARY_LINE = /^\s*(?:duration|start at|tests?\s|test files|time:|ran all|snapshots?:|test suites?:|real\s|user\s|sys\s|\d+ (?:passed|failed|passing|failing)|run\s+v?\d|=+ .* in [\d.]+s =+)/i;
const ERRORISH = /error|fail|expected|received|assert|cannot|undefined|not defined|is not|not assignable|✗|×|✖|exception|panic|traceback/i;

function stripNoise(line: string): string {
  return line.replace(ANSI, '').replace(/\r/g, '');
}

/** Removes everything that varies between two runs of the same failure. */
export function normalizeLine(line: string): string {
  return stripNoise(line)
    .toLowerCase()
    // absolute paths keep only their last two segments
    .replace(/(?:[a-z]:)?[\\/](?:[^\s\\/:"'`()<>]+[\\/])+([^\s\\/:"'`()<>]+[\\/][^\s\\/:"'`()<>]+)/g, '$1')
    .replace(/(\.[a-z0-9]{1,8}):\d+(?::\d+)?/g, '$1')
    .replace(/\(\d+:\d+\)|:\d+:\d+/g, '')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|µs|us|ns)\b/g, '<t>')
    .replace(/\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?/g, '<ts>')
    .replace(/\b0x[0-9a-f]+\b|\b[0-9a-f]{7,40}\b/g, '<h>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>')
    .replace(/[`'"“”‘’]/g, '')
    .replace(/[^\w<>@./$#%+\-=:!,|*&^~[\]{}()?\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Headings a reporter prints around failures (node:test "failing tests:", vitest "Failed Tests 1"), not test names. */
const SUMMARY_NAME = /^(?:tests?|test files|suites?|(?:failing|failed|passing|passed|skipped|pending) tests?|summary|failures?)\b/;

const CLASS_PATTERN = /\b([A-Z][A-Za-z]*(?:Error|Exception))\b|\b(TS\d{4})\b|\b(E(?:NOENT|ACCES|PERM|EXIST|ISDIR|NOTDIR|CONNREFUSED|NOTFOUND|TIMEDOUT|INVAL))\b/g;

const TEST_PATTERNS: RegExp[] = [
  /^\s*(?:FAIL|FAILED)\s+(?:\S+\.[A-Za-z0-9]+\s*(?:>|›|::)\s*)?(.+?)\s*$/,
  /^\s*(?:✗|×|✖|✕)\s+(.+?)\s*$/,
  /^\s*●\s+(.+?)\s*$/,
  /^\s*not ok\s+\d+\s*-?\s*(.+?)\s*$/,
  /^\s*---\s*FAIL:\s*(\S+)/,
  /^\s*\d+\)\s+(.+?)\s*$/,
];

export function analyzeFailureOutput(output: string, knownPaths: readonly string[] = []): FailureSemantics {
  const lines = output.split('\n').map(stripNoise);
  const tests = new Set<string>();
  const classes = new Set<string>();
  const messageLines = new Set<string>();
  const files = new Set<string>(knownPaths.map(item => item.replace(/\\/g, '/')));

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    for (const pattern of TEST_PATTERNS) {
      const match = pattern.exec(line);
      if (match) {
        const name = normalizeLine(match[1]).replace(/\s*\(?<t>\)?$/, '');
        if (name.length > 0 && name.length <= 200 && !SUMMARY_NAME.test(name) && !name.endsWith(':')) tests.add(name);
        break;
      }
    }
    for (const match of trimmed.matchAll(CLASS_PATTERN)) classes.add(match[1] ?? match[2] ?? match[3]);
    if (/\bassert/i.test(trimmed)) classes.add('assertion');
    if (STACK_FRAME.test(line) || SUMMARY_LINE.test(line)) continue;
    if (ERRORISH.test(trimmed)) {
      const normalized = normalizeLine(trimmed);
      if (normalized.length > 0) messageLines.add(normalized.slice(0, 300));
    }
  }
  const messageKey = digest([...messageLines].sort().slice(0, 16).join('\n') || normalizeLine(output).slice(-300));
  return {
    tests: [...tests].sort().slice(0, 40),
    errorClasses: [...classes].sort().slice(0, 8),
    messageKey,
    files: [...files].sort().slice(0, 8),
  };
}

// ── patch footprint ─────────────────────────────────────────────────────────

/** What one mutation changed in one file, relative to the file as it was just before. */
export interface PatchDelta {
  path: string;
  op: string;
  /** Digest of the resulting content. */
  hash: string;
  /** Changed region in the NEW content (1-based, inclusive). */
  newRange?: [number, number];
  /** The region of the OLD content it replaced (1-based, inclusive). */
  oldRange?: [number, number];
  changedLines: number;
  totalLines: number;
  /** Region too large to be meaningful (an edit at both ends of a long file). */
  broad: boolean;
  /** Bottom-k hashes of the tokens on the changed lines. */
  sketch: string[];
}

const SKETCH_SIZE = 32;
const SIMILARITY_THRESHOLD = 0.6;

function lineList(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

function tokenSketch(text: string): string[] {
  const tokens = new Set(text.toLowerCase().match(/[a-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? []);
  return [...tokens]
    .map(token => digest(token).slice(0, 8))
    .sort()
    .slice(0, SKETCH_SIZE);
}

export function sketchSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setB = new Set(b);
  const union = [...new Set([...a, ...b])].sort().slice(0, SKETCH_SIZE);
  const setA = new Set(a);
  const both = union.filter(item => setA.has(item) && setB.has(item)).length;
  return both / union.length;
}

export function computePatchDelta(input: { path: string; op: string; content?: string; before?: string }): PatchDelta {
  const path = input.path.replace(/\\/g, '/');
  if (input.op === 'delete' || input.content === undefined) {
    const oldLines = input.before === undefined ? 0 : lineList(input.before).length;
    return { path, op: input.op, hash: 'deleted', oldRange: oldLines ? [1, oldLines] : undefined, changedLines: oldLines, totalLines: 0, broad: false, sketch: [] };
  }
  const next = lineList(input.content);
  const hash = digest(input.content.replace(/\r\n?/g, '\n'));
  if (input.before === undefined) {
    return { path, op: input.op, hash, newRange: [1, next.length], changedLines: next.length, totalLines: next.length, broad: next.length > 50, sketch: tokenSketch(input.content) };
  }
  const prev = lineList(input.before);
  let prefix = 0;
  while (prefix < prev.length && prefix < next.length && prev[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < prev.length - prefix && suffix < next.length - prefix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix += 1;
  const newSpan = next.length - prefix - suffix;
  const oldSpan = prev.length - prefix - suffix;
  const changed = next.slice(prefix, next.length - suffix).join('\n');
  return {
    path,
    op: input.op,
    hash,
    ...(newSpan > 0 ? { newRange: [prefix + 1, prefix + newSpan] as [number, number] } : {}),
    ...(oldSpan > 0 ? { oldRange: [prefix + 1, prefix + oldSpan] as [number, number] } : {}),
    changedLines: Math.max(newSpan, oldSpan),
    totalLines: next.length,
    broad: next.length > 50 && Math.max(newSpan, oldSpan) > next.length * 0.6,
    sketch: tokenSketch(changed),
  };
}

function overlaps(a: [number, number] | undefined, b: [number, number] | undefined): boolean {
  return Boolean(a && b && a[0] <= b[1] && b[0] <= a[1]);
}

/**
 * Does `current` rework what `previous` did to the same file? True when it is the
 * identical result, edits the region the previous change wrote, or rewrites the same
 * tokens. `current.oldRange` and `previous.newRange` are in the same coordinates:
 * the file as it stood after the previous change.
 */
export function reworksPrevious(previous: PatchDelta, current: PatchDelta): boolean {
  if (previous.hash === current.hash) return true;
  if (!previous.broad && !current.broad && overlaps(previous.newRange, current.oldRange)) return true;
  return sketchSimilarity(previous.sketch, current.sketch) >= SIMILARITY_THRESHOLD;
}

export type PatchFamily = 'first' | 'identical' | 'rework' | 'different';

export interface PatchFootprint {
  paths: string[];
  hash: string;
  changedLines: number;
  family: PatchFamily;
}

/** `current`: deltas of the change made since the last observation; `previous`: the change before it, if any. */
export function derivePatchFootprint(current: readonly PatchDelta[], previous?: readonly PatchDelta[]): PatchFootprint | undefined {
  if (current.length === 0) return undefined;
  const paths = [...new Set(current.map(delta => delta.path))].sort();
  const hash = digest(current.map(delta => `${delta.path}:${delta.hash}`).sort().join('|'));
  const changedLines = current.reduce((sum, delta) => sum + delta.changedLines, 0);
  if (!previous || previous.length === 0) return { paths, hash, changedLines, family: 'first' };
  const previousHash = digest(previous.map(delta => `${delta.path}:${delta.hash}`).sort().join('|'));
  if (previousHash === hash) return { paths, hash, changedLines, family: 'identical' };
  const previousPaths = [...new Set(previous.map(delta => delta.path))].sort();
  const samePaths = previousPaths.length === paths.length && previousPaths.every((item, index) => item === paths[index]);
  const reworked = samePaths && current.every(delta => {
    const before = previous.find(item => item.path === delta.path);
    return before !== undefined && reworksPrevious(before, delta);
  });
  return { paths, hash, changedLines, family: reworked ? 'rework' : 'different' };
}

// ── fingerprint and progress ────────────────────────────────────────────────

export interface FailureFingerprint {
  v: typeof FINGERPRINT_VERSION;
  /** Identity of the failure: error classes + failing tests + normalized message + implicated files. */
  key: string;
  tests: string[];
  errorClasses: string[];
  messageKey: string;
  files: string[];
  symbols: string[];
  failingCount: number;
  patch?: PatchFootprint;
  /** What the pass did (reads, mutations, repairs) so a pass that did nothing new is visible. */
  actions?: string;
  /** Digest of the evidence manifest when the outcome was observed. */
  evidence?: string;
}

export function buildFailureFingerprint(input: {
  semantics: readonly FailureSemantics[];
  /** Fallbacks for non-validation failures. */
  subcode?: string;
  failureHash?: string;
  files?: readonly string[];
  symbols?: readonly string[];
  patch?: PatchFootprint;
  actions?: string;
  evidence?: string;
}): FailureFingerprint {
  const tests = [...new Set(input.semantics.flatMap(item => item.tests))].sort();
  const classes = [...new Set(input.semantics.flatMap(item => item.errorClasses))].sort();
  const files = [...new Set([...input.semantics.flatMap(item => item.files), ...(input.files ?? [])].map(item => item.replace(/\\/g, '/')))].sort().slice(0, 12);
  if (input.semantics.length === 0 && input.subcode) classes.push(input.subcode);
  const messageKey = input.semantics.length > 0
    ? digest(input.semantics.map(item => item.messageKey).sort().join('|'))
    : input.failureHash ?? '';
  return {
    v: FINGERPRINT_VERSION,
    key: digest([classes.join(','), tests.join(','), messageKey, files.join(',')].join('|')),
    tests,
    errorClasses: classes,
    messageKey,
    files,
    symbols: [...new Set(input.symbols ?? [])].sort().slice(0, 8),
    failingCount: tests.length > 0 ? tests.length : input.semantics.length > 0 ? input.semantics.length : 1,
    ...(input.patch ? { patch: input.patch } : {}),
    ...(input.actions ? { actions: input.actions } : {}),
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
}

const SAME_FAILURE: ReadonlySet<ProgressVerdict> = new Set(['same_failure_same_patch_family', 'same_failure_different_patch', 'no_new_evidence']);

function isSubset<T>(small: readonly T[], big: readonly T[]): boolean {
  const set = new Set(big);
  return small.every(item => set.has(item));
}

/** How `current` relates to the failure observed before it. */
export function compareFailures(previous: FailureFingerprint | undefined, current: FailureFingerprint): ProgressVerdict {
  if (!previous) return 'new_failure';
  const hasTests = previous.tests.length > 0 || current.tests.length > 0;
  // A failure that names no test (a compile error) after test failures is a different kind of failure, not "fewer failing tests".
  if (hasTests && (previous.tests.length === 0 || current.tests.length === 0) && previous.key !== current.key) return 'new_failure';
  if (hasTests) {
    const previousSet = new Set(previous.tests);
    const carried = current.tests.filter(test => previousSet.has(test));
    const added = current.tests.filter(test => !previousSet.has(test));
    if (added.length > 0 && carried.length > 0) return 'regression';
    if (added.length > 0) return 'new_failure';
    if (carried.length < previous.tests.length && isSubset(current.tests, previous.tests)) return 'validation_improved';
  } else if (previous.key !== current.key && previous.errorClasses.join() !== current.errorClasses.join()) {
    return 'new_failure';
  }
  // The same failing set (or same non-test failure): was anything different about the attempt?
  const family = current.patch?.family;
  if (family === 'identical' || family === 'rework') return 'same_failure_same_patch_family';
  const evidenceUnchanged = previous.evidence !== undefined && previous.evidence === current.evidence;
  if (!current.patch && evidenceUnchanged) return 'no_new_evidence';
  if (current.patch && previous.patch && current.patch.hash === previous.patch.hash) return 'same_failure_same_patch_family';
  return 'same_failure_different_patch';
}

export interface ProgressAssessment {
  verdict: ProgressVerdict;
  /** Consecutive same-failure observations ending at the current one (0 when the failure moved). */
  streak: number;
  /** Consecutive observations that repeated the same hypothesis (same family, or nothing new). */
  sameHypothesisStreak: number;
  /** Fewer failing tests than the best earlier observation in this window. */
  bestFailingCount: number;
  reasons: string[];
}

/**
 * Assesses the newest fingerprint against the ordered history (oldest first,
 * the newest last). Pure; the history is `StageOutcome.failureFingerprint` from
 * the journal, so it survives a restart unchanged.
 */
export function assessProgress(history: readonly FailureFingerprint[]): ProgressAssessment | undefined {
  if (history.length === 0) return undefined;
  const verdicts: ProgressVerdict[] = history.map((item, index) => compareFailures(history[index - 1], item));
  const verdict = verdicts[verdicts.length - 1];
  let streak = 0;
  let sameHypothesisStreak = 0;
  for (let i = verdicts.length - 1; i >= 1 && SAME_FAILURE.has(verdicts[i]); i -= 1) streak += 1;
  for (let i = verdicts.length - 1; i >= 1 && (verdicts[i] === 'same_failure_same_patch_family' || verdicts[i] === 'no_new_evidence'); i -= 1) sameHypothesisStreak += 1;
  const current = history[history.length - 1];
  const bestFailingCount = Math.min(...history.map(item => item.failingCount));
  const reasons: string[] = [];
  switch (verdict) {
    case 'same_failure_same_patch_family':
      reasons.push('the same failure recurred after a change that reworked what the previous change already touched');
      break;
    case 'same_failure_different_patch':
      reasons.push('the same failure recurred after a different change');
      break;
    case 'no_new_evidence':
      reasons.push('the same failure recurred and nothing new was changed or learned');
      break;
    case 'validation_improved':
      reasons.push(`fewer tests fail (${current.failingCount}, best so far ${bestFailingCount})`);
      break;
    case 'regression':
      reasons.push('new failures appeared alongside the earlier ones');
      break;
    case 'new_failure':
      reasons.push('a different failure than before');
      break;
  }
  return { verdict, streak, sameHypothesisStreak, bestFailingCount, reasons };
}
