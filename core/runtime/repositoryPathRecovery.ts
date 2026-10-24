/**
 * Repository-grounded path recovery for Core tool calls.
 *
 * This module deliberately depends only on Node primitives. It never probes an
 * out-of-root requested path: absolute paths outside the governed root may
 * contribute only their basename to a bounded in-repository search.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export type RepositoryPathTarget = 'read' | 'write';
export type RepositoryPathRecoveryStatus = 'resolved' | 'corrected' | 'ambiguous' | 'not_found' | 'rejected';
export type RepositoryPathRecoveryConfidence = 'exact' | 'high' | 'none';
export type RepositoryPathRecoveryReason =
  | 'exact_in_root'
  | 'safe_write_target'
  | 'case_insensitive_relative_match'
  | 'unique_suffix_match'
  | 'unique_basename_match'
  | 'outside_absolute_unique_basename'
  | 'ambiguous_match'
  | 'outside_workspace'
  | 'traversal_rejected'
  | 'symlink_escape'
  | 'not_found'
  | 'scan_truncated'
  | 'empty_path'
  | 'workspace_unavailable';

export interface RepositoryPathRecoveryInput {
  workspaceRoot: string;
  requestedPath: string;
  target: RepositoryPathTarget;
  /** Maximum directory entries inspected during recovery. Default: 5,000. */
  maxScanEntries?: number;
  /** Maximum directory depth inspected during recovery. Default: 24. */
  maxScanDepth?: number;
}

export interface RepositoryPathRecoveryResult {
  original: string;
  /** Slash-normalized requested path, relative to the root when possible. */
  normalized: string;
  /** Canonical repository-relative path selected for the caller. */
  selected: string | null;
  confidence: RepositoryPathRecoveryConfidence;
  reason: RepositoryPathRecoveryReason;
  /** True only when recovery selected a different in-repository target. */
  automatic: boolean;
  /** Canonical absolute path. Never points outside the canonical workspace. */
  resolvedPath: string | null;
  status: RepositoryPathRecoveryStatus;
  exists: boolean;
  /** Sorted repository-relative candidates; populated when user choice is required. */
  candidates: string[];
  scanTruncated: boolean;
}

export interface LoopSignatureInput {
  operation: string;
  normalizedArguments: unknown;
  resultCategory: string;
  relevantEvidence?: unknown;
}

const DEFAULT_MAX_SCAN_ENTRIES = 5_000;
const DEFAULT_MAX_SCAN_DEPTH = 24;
const HARD_MAX_SCAN_ENTRIES = 20_000;
const HARD_MAX_SCAN_DEPTH = 64;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', 'out', 'dist', 'build', '.ollama-agent']);

function canonicalizeJson(value: unknown, ancestors: Set<object>, inArray: boolean): string | undefined {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'bigint') throw new TypeError('canonical JSON does not support bigint');
  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol') {
    return inArray ? 'null' : undefined;
  }
  if (typeof value !== 'object') return JSON.stringify(value);

  if (ancestors.has(value)) throw new TypeError('canonical JSON does not support cyclic values');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonicalizeJson(item, ancestors, true) ?? 'null').join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const fields: string[] = [];
    for (const key of Object.keys(record).sort()) {
      const encoded = canonicalizeJson(record[key], ancestors, false);
      if (encoded !== undefined) fields.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${fields.join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Stable JSON for model/tool arguments: object keys are recursively sorted. */
export function canonicalArgumentJson(value: unknown): string {
  return canonicalizeJson(value, new Set<object>(), false) ?? 'null';
}

/** Stable SHA-256 evidence identity. */
export function createEvidenceHash(evidence: unknown): string {
  return crypto.createHash('sha256').update(canonicalArgumentJson(evidence), 'utf8').digest('hex');
}

/** Stable loop identity over operation, normalized arguments, result, and evidence. */
export function createLoopSignature(input: LoopSignatureInput): string {
  return createEvidenceHash({
    operation: input.operation,
    normalizedArguments: input.normalizedArguments,
    resultCategory: input.resultCategory,
    evidenceHash: createEvidenceHash(input.relevantEvidence ?? null),
  });
}

function portable(value: string): string {
  return value.split(path.sep).join('/');
}

function anyAbsolute(value: string): boolean {
  return path.isAbsolute(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value);
}

function requestedBasename(value: string): string {
  const parts = value.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-1) ?? '';
}

function containsTraversal(value: string): boolean {
  return value.replace(/\\/g, '/').split('/').some((part) => part === '..');
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function normalizeRequest(root: string, requested: string, absolute: boolean): string {
  // Replace separator direction one character at a time so Windows UNC/device
  // prefixes retain their absolute-path semantics; path.normalize handles
  // redundant separators after that.
  const slashNormalized = requested.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/[\\/]/g, path.sep);
  let normalized = path.normalize(slashNormalized);
  if (!absolute) {
    normalized = normalized.replace(new RegExp(`^\\.${path.sep === '\\' ? '\\\\' : path.sep}+`), '');
    const rootName = path.basename(root);
    const parts = normalized.split(path.sep);
    if (parts.length > 1 && parts[0].toLocaleLowerCase('en-US') === rootName.toLocaleLowerCase('en-US')) {
      normalized = parts.slice(1).join(path.sep);
    }
  }
  return portable(normalized);
}

type BoundaryResult =
  | { safe: true; exists: boolean; canonicalPath: string }
  | { safe: false; reason: 'symlink_escape' };

/** Resolve through the nearest existing ancestor so nonexistent leaves cannot hide behind an escaping symlink. */
function verifyCanonicalBoundary(canonicalRoot: string, lexicalCandidate: string): BoundaryResult {
  let ancestor = lexicalCandidate;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) return { safe: false, reason: 'symlink_escape' };
    ancestor = parent;
  }

  try {
    const canonicalAncestor = fs.realpathSync.native(ancestor);
    if (!isWithin(canonicalRoot, canonicalAncestor)) return { safe: false, reason: 'symlink_escape' };
    const exists = ancestor === lexicalCandidate;
    const canonicalPath = exists
      ? canonicalAncestor
      : path.resolve(canonicalAncestor, path.relative(ancestor, lexicalCandidate));
    if (!isWithin(canonicalRoot, canonicalPath)) return { safe: false, reason: 'symlink_escape' };
    return { safe: true, exists, canonicalPath };
  } catch {
    return { safe: false, reason: 'symlink_escape' };
  }
}

interface ScannedFile {
  relative: string;
  absolute: string;
}

function scanFiles(canonicalRoot: string, maxEntries: number, maxDepth: number): { files: ScannedFile[]; truncated: boolean } {
  const files: ScannedFile[] = [];
  const pending: Array<{ directory: string; depth: number }> = [{ directory: canonicalRoot, depth: 0 }];
  let inspected = 0;
  let truncated = false;

  while (pending.length > 0) {
    const current = pending.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true })
        .sort((left, right) => left.name.localeCompare(right.name, 'en-US'));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (inspected >= maxEntries) {
        truncated = true;
        return { files, truncated };
      }
      inspected += 1;
      const absolute = path.join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (current.depth < maxDepth && !IGNORED_DIRECTORIES.has(entry.name.toLocaleLowerCase('en-US'))) {
          pending.push({ directory: absolute, depth: current.depth + 1 });
        }
        continue;
      }
      if (entry.isSymbolicLink()) {
        // Directory symlinks are never followed. Safe in-root file symlinks are usable.
        try {
          const canonical = fs.realpathSync.native(absolute);
          if (isWithin(canonicalRoot, canonical) && fs.statSync(canonical).isFile()) {
            files.push({ relative: portable(path.relative(canonicalRoot, absolute)), absolute: canonical });
          }
        } catch { /* stale or escaping link */ }
        continue;
      }
      if (entry.isFile()) files.push({ relative: portable(path.relative(canonicalRoot, absolute)), absolute });
    }
  }
  return { files, truncated };
}

function baseResult(original: string, normalized: string): Omit<RepositoryPathRecoveryResult, 'status' | 'reason' | 'confidence' | 'automatic'> {
  return {
    original,
    normalized,
    selected: null,
    resolvedPath: null,
    exists: false,
    candidates: [],
    scanTruncated: false,
  };
}

function correctionResult(
  original: string,
  normalized: string,
  candidate: ScannedFile,
  reason: RepositoryPathRecoveryReason,
  scanTruncated: boolean,
): RepositoryPathRecoveryResult {
  return {
    ...baseResult(original, normalized),
    status: 'corrected',
    selected: candidate.relative,
    resolvedPath: candidate.absolute,
    exists: true,
    confidence: reason === 'case_insensitive_relative_match' ? 'exact' : 'high',
    reason,
    automatic: true,
    scanTruncated,
  };
}

/**
 * Resolve or recover a model-requested repository path without weakening the
 * governed root. Read recovery scans only active in-root files and never
 * chooses among multiple equally plausible candidates.
 */
export function recoverRepositoryPath(input: RepositoryPathRecoveryInput): RepositoryPathRecoveryResult {
  const original = input.requestedPath;
  let canonicalRoot: string;
  try {
    canonicalRoot = fs.realpathSync.native(input.workspaceRoot);
    if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error('workspace is not a directory');
  } catch {
    return {
      ...baseResult(original, original.trim()), status: 'rejected', confidence: 'none', reason: 'workspace_unavailable', automatic: false,
    };
  }

  const trimmed = original.trim().replace(/^(["'])(.*)\1$/, '$2');
  const absolute = anyAbsolute(trimmed);
  const normalized = normalizeRequest(canonicalRoot, original, absolute);
  if (!trimmed || normalized === '.') {
    return { ...baseResult(original, normalized), status: 'rejected', confidence: 'none', reason: 'empty_path', automatic: false };
  }
  if (containsTraversal(trimmed)) {
    return { ...baseResult(original, normalized), status: 'rejected', confidence: 'none', reason: 'traversal_rejected', automatic: false };
  }

  let lexicalCandidate: string | null = null;
  let outsideAbsolute = false;
  if (absolute) {
    // Foreign-style absolute paths cannot be safely resolved by the host path implementation.
    if (!path.isAbsolute(normalized)) {
      outsideAbsolute = true;
    } else {
      const resolved = path.resolve(normalized);
      if (isWithin(canonicalRoot, resolved)) lexicalCandidate = resolved;
      else outsideAbsolute = true;
    }
  } else {
    const resolved = path.resolve(canonicalRoot, normalized.split('/').join(path.sep));
    if (!isWithin(canonicalRoot, resolved)) {
      return { ...baseResult(original, normalized), status: 'rejected', confidence: 'none', reason: 'outside_workspace', automatic: false };
    }
    lexicalCandidate = resolved;
  }

  if (lexicalCandidate) {
    const boundary = verifyCanonicalBoundary(canonicalRoot, lexicalCandidate);
    if (!boundary.safe) {
      return { ...baseResult(original, normalized), status: 'rejected', confidence: 'none', reason: boundary.reason, automatic: false };
    }
    if (boundary.exists) {
      let isFile = false;
      try { isFile = fs.statSync(boundary.canonicalPath).isFile(); } catch { /* raced with removal */ }
      if (input.target === 'write' || isFile) {
        const selected = portable(path.relative(canonicalRoot, boundary.canonicalPath));
        const caseCorrected = !absolute
          && selected !== normalized
          && selected.toLocaleLowerCase('en-US') === normalized.toLocaleLowerCase('en-US');
        return {
          ...baseResult(original, normalized), status: caseCorrected ? 'corrected' : 'resolved', selected, resolvedPath: boundary.canonicalPath,
          exists: true, confidence: 'exact', reason: caseCorrected ? 'case_insensitive_relative_match' : 'exact_in_root', automatic: caseCorrected,
        };
      }
    } else if (input.target === 'write') {
      return {
        ...baseResult(original, normalized), status: 'resolved', selected: portable(path.relative(canonicalRoot, boundary.canonicalPath)),
        resolvedPath: boundary.canonicalPath, exists: false, confidence: 'exact', reason: 'safe_write_target', automatic: false,
      };
    }
  }

  if (input.target !== 'read') {
    return {
      ...baseResult(original, normalized), status: outsideAbsolute ? 'rejected' : 'not_found', confidence: 'none',
      reason: outsideAbsolute ? 'outside_workspace' : 'not_found', automatic: false,
    };
  }

  const requestedMaxEntries = input.maxScanEntries ?? DEFAULT_MAX_SCAN_ENTRIES;
  const requestedMaxDepth = input.maxScanDepth ?? DEFAULT_MAX_SCAN_DEPTH;
  const maxEntries = Math.min(
    HARD_MAX_SCAN_ENTRIES,
    Math.max(1, Number.isFinite(requestedMaxEntries) ? Math.floor(requestedMaxEntries) : DEFAULT_MAX_SCAN_ENTRIES),
  );
  const maxDepth = Math.min(
    HARD_MAX_SCAN_DEPTH,
    Math.max(0, Number.isFinite(requestedMaxDepth) ? Math.floor(requestedMaxDepth) : DEFAULT_MAX_SCAN_DEPTH),
  );
  const scan = scanFiles(canonicalRoot, maxEntries, maxDepth);
  const lower = (value: string) => value.toLocaleLowerCase('en-US');
  const normalizedRelative = lower(normalized.replace(/^\/+/, ''));
  const basename = lower(requestedBasename(trimmed));

  const tiers: Array<{ reason: RepositoryPathRecoveryReason; matches: ScannedFile[] }> = outsideAbsolute
    ? [{ reason: 'outside_absolute_unique_basename', matches: scan.files.filter((file) => lower(path.posix.basename(file.relative)) === basename) }]
    : [
        { reason: 'case_insensitive_relative_match', matches: scan.files.filter((file) => lower(file.relative) === normalizedRelative) },
        {
          reason: 'unique_suffix_match',
          matches: scan.files.filter((file) => {
            const candidate = lower(file.relative);
            return candidate.endsWith(`/${normalizedRelative}`) || normalizedRelative.endsWith(`/${candidate}`);
          }),
        },
        { reason: 'unique_basename_match', matches: scan.files.filter((file) => lower(path.posix.basename(file.relative)) === basename) },
      ];

  for (const tier of tiers) {
    if (tier.matches.length === 1 && !scan.truncated) return correctionResult(original, normalized, tier.matches[0], tier.reason, false);
    if (tier.matches.length > 1) {
      return {
        ...baseResult(original, normalized), status: 'ambiguous', confidence: 'none', reason: 'ambiguous_match', automatic: false,
        candidates: tier.matches.map((match) => match.relative).sort((a, b) => a.localeCompare(b, 'en-US')),
        scanTruncated: scan.truncated,
      };
    }
    if (tier.matches.length === 1 && scan.truncated) {
      return {
        ...baseResult(original, normalized), status: 'ambiguous', confidence: 'none', reason: 'scan_truncated', automatic: false,
        candidates: [tier.matches[0].relative], scanTruncated: true,
      };
    }
  }

  return {
    ...baseResult(original, normalized), status: outsideAbsolute ? 'rejected' : 'not_found', confidence: 'none',
    reason: outsideAbsolute ? 'outside_workspace' : (scan.truncated ? 'scan_truncated' : 'not_found'),
    automatic: false, scanTruncated: scan.truncated,
  };
}
