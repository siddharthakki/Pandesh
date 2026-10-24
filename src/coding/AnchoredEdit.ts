import * as fs from 'fs/promises';
import * as crypto from 'crypto';
import {
  CodingProposalConformanceMetadata,
  ProposalLimits,
  DEFAULT_PROPOSAL_LIMITS,
  ProposalValidationResult,
  extractCodingProposalJson,
  mergeConformance,
  normalizeCodingProposalConformance,
  normalizeRelativePath,
  validateCodingProposal,
  validateRelativeWorkspacePath,
} from './CodingProposal';
import { detectEol } from './EolPolicy';
import { WorkspaceInspectionTools, throwIfAborted } from './WorkspaceInspection';

/**
 * Governed anchored edits (v1).
 *
 * The model proposes small exact `oldText -> newText` anchors for an EXISTING file instead of re-emitting the whole
 * file. The host reads the authoritative file from disk, requires every anchor to match exactly once, applies the
 * edits in memory and hands the resulting full content to the unchanged validation / approval / mutation pipeline as
 * an ordinary `replace`. Nothing downstream ever sees an `edit` operation.
 *
 * Deliberately small: no diff parser, no AST rewrite, no fuzzy matching. Only exact text, once, fail closed.
 */
export const ANCHORED_EDIT_MAX_EDITS = 20;
export const ANCHORED_EDIT_MAX_OLD_TEXT_CHARS = 20_000;
export const ANCHORED_EDIT_MAX_NEW_TEXT_CHARS = 50_000;
export const ANCHORED_EDIT_MAX_TOTAL_CHARS = 120_000;
export const ANCHORED_EDIT_MAX_FILE_BYTES = 2_000_000;

export interface AnchoredEdit {
  oldText: string;
  newText: string;
}

export const ANCHORED_EDIT_ERRORS = [
  'edit_malformed',
  'edit_target_missing',
  'edit_count_exceeded',
  'edit_old_text_required',
  'edit_too_large',
  'edit_anchor_not_found',
  'edit_anchor_ambiguous',
  'edit_overlap',
  'edit_no_change',
  'edit_mixed_eol',
  'edit_read_failed',
] as const;

export type AnchoredEditApplyResult =
  | { ok: true; content: string }
  | { ok: false; error: typeof ANCHORED_EDIT_ERRORS[number]; editIndex?: number };

/** Pure and deterministic: every anchor is matched against the ORIGINAL text, never against another edit's output. */
export function applyAnchoredEdits(original: string, edits: readonly AnchoredEdit[]): AnchoredEditApplyResult {
  if (edits.length < 1) return { ok: false, error: 'edit_malformed' };
  if (edits.length > ANCHORED_EDIT_MAX_EDITS) return { ok: false, error: 'edit_count_exceeded' };
  let total = 0;
  for (const edit of edits) {
    if (typeof edit.oldText !== 'string' || typeof edit.newText !== 'string') return { ok: false, error: 'edit_malformed' };
    if (edit.oldText.length === 0) return { ok: false, error: 'edit_old_text_required' };
    if (edit.oldText.length > ANCHORED_EDIT_MAX_OLD_TEXT_CHARS || edit.newText.length > ANCHORED_EDIT_MAX_NEW_TEXT_CHARS) {
      return { ok: false, error: 'edit_too_large' };
    }
    total += edit.oldText.length + edit.newText.length;
  }
  if (total > ANCHORED_EDIT_MAX_TOTAL_CHARS) return { ok: false, error: 'edit_too_large' };

  // Models see files with LF only. A consistently-CRLF file is matched in LF space and restored to CRLF, so an edit
  // never flips line endings. A mixed file cannot be matched safely: fail closed rather than guess.
  const eol = detectEol(original);
  if (eol === 'mixed') {
    const anyBreakInAnchor = edits.some(edit => /[\r\n]/.test(edit.oldText));
    if (anyBreakInAnchor) return { ok: false, error: 'edit_mixed_eol' };
  }
  const crlf = eol === 'crlf';
  const source = crlf ? original.replace(/\r\n/g, '\n') : original;
  // The same rule in the other direction: a model writing CRLF into an LF-only file would leave invisible `\r`s
  // (seen live: `git diff --check` "trailing whitespace" that no text repair could see). A consistently-LF file
  // gets LF anchors and replacement text; an LF file contains no "\r\n", so this can never change what matches.
  const lfOnly = eol === 'lf';
  const lf = (text: string): string => (crlf || lfOnly ? text.replace(/\r\n/g, '\n') : text);

  const ranges: Array<{ start: number; end: number; newText: string }> = [];
  for (const [editIndex, edit] of edits.entries()) {
    const oldText = lf(edit.oldText);
    const first = source.indexOf(oldText);
    if (first < 0) return { ok: false, error: 'edit_anchor_not_found', editIndex };
    // Step by one so overlapping occurrences of the same anchor also count as ambiguous.
    if (source.indexOf(oldText, first + 1) >= 0) return { ok: false, error: 'edit_anchor_ambiguous', editIndex };
    ranges.push({ start: first, end: first + oldText.length, newText: lf(edit.newText) });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index].start < ranges[index - 1].end) return { ok: false, error: 'edit_overlap' };
  }

  let cursor = 0;
  let out = '';
  for (const range of ranges) {
    out += source.slice(cursor, range.start) + range.newText;
    cursor = range.end;
  }
  out += source.slice(cursor);
  if (out === source) return { ok: false, error: 'edit_no_change' };
  return { ok: true, content: crlf ? out.replace(/\n/g, '\r\n') : out };
}

export const ANCHOR_HINT_MAX_CHARS = 1_800;
export const ANCHOR_HINTS_MAX = 3;

/**
 * Model feedback ONLY for a failed anchor: where the current file most likely holds the text the model was aiming
 * at, quoted verbatim so the next proposal can copy an exact anchor. Never used to apply, correct or approximate an
 * edit: the write contract stays "oldText matches exactly once" and a repaired proposal is matched from scratch.
 */
export function describeAnchorMiss(
  relativePath: string,
  original: string,
  oldText: string,
  error: 'edit_anchor_not_found' | 'edit_anchor_ambiguous',
): string {
  const source = original.replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const anchor = String(oldText ?? '').replace(/\r\n/g, '\n');
  const anchorPreview = JSON.stringify(anchor.length > 120 ? `${anchor.slice(0, 120)}…` : anchor);
  const quote = (lineIndex: number, span: number): string => {
    const start = Math.max(0, lineIndex - 2);
    const end = Math.min(lines.length - 1, lineIndex + Math.max(span, 1) + 2);
    let body = lines.slice(start, end + 1).join('\n');
    if (body.length > ANCHOR_HINT_MAX_CHARS - 300) body = body.slice(0, ANCHOR_HINT_MAX_CHARS - 300);
    return `current text of ${relativePath} lines ${start + 1}-${end + 1} (verbatim; line numbers are not part of the file):\n\`\`\`\n${body}\n\`\`\``;
  };
  if (error === 'edit_anchor_ambiguous') {
    const hits: number[] = [];
    let at = source.indexOf(anchor);
    while (at >= 0 && hits.length < 4) {
      hits.push(source.slice(0, at).split('\n').length);
      at = source.indexOf(anchor, at + 1);
    }
    return `edit_anchor_ambiguous in ${relativePath}: oldText ${anchorPreview} occurs more than once (lines ${hits.join(', ')}). Extend oldText with exact neighbouring text so it occurs exactly once.`;
  }
  const anchorLines = anchor.split('\n').map(line => line.trim()).filter(line => line.length >= 8);
  // 1) A whole anchor line that does exist: the model found the location but quoted the block inexactly.
  for (const anchorLine of [...anchorLines].sort((a, b) => b.length - a.length).slice(0, 4)) {
    const index = lines.findIndex(line => line.includes(anchorLine));
    if (index >= 0) {
      return `edit_anchor_not_found in ${relativePath}: oldText ${anchorPreview} is not an exact substring of the file. Part of it occurs at line ${index + 1}; copy oldText exactly from the ${quote(index, anchor.split('\n').length)}`;
    }
  }
  // 2) Otherwise the rarest identifier it mentions, if any occurs at all.
  const identifiers = [...new Set(anchor.match(/[A-Za-z_$][\w$]{4,}/g) ?? [])];
  let best: { index: number; count: number } | undefined;
  for (const identifier of identifiers.slice(0, 30)) {
    let count = 0;
    let first = -1;
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index].includes(identifier)) {
        count += 1;
        if (first < 0) first = index;
      }
    }
    if (count > 0 && (!best || count < best.count)) best = { index: first, count };
  }
  if (best) {
    return `edit_anchor_not_found in ${relativePath}: oldText ${anchorPreview} does not occur in the file. The nearest related ${quote(best.index, 6)}`;
  }
  return `edit_anchor_not_found in ${relativePath}: oldText ${anchorPreview} does not occur in the file and nothing similar was found. Read the relevant region first and copy oldText from it.`;
}

/**
 * A validated proposal as a model should see it again (repair turns): an operation the host expanded from anchored
 * edits is shown as that compact `edit`, never as the whole expanded file, which for a large file would not even fit
 * the model's context window. Host-only fields are dropped.
 */
export function renderProposalForModel(proposal: unknown): string {
  if (!isRecord(proposal) || !Array.isArray(proposal.operations)) return JSON.stringify(proposal);
  const operations = proposal.operations.map(operation => {
    if (!isRecord(operation)) return operation;
    const { editBaseSha256, anchoredEdits, expectedFingerprint, ...rest } = operation;
    void expectedFingerprint;
    if (typeof editBaseSha256 === 'string' && Array.isArray(anchoredEdits) && anchoredEdits.length > 0) {
      return { type: 'edit', path: rest.path, reason: rest.reason, edits: anchoredEdits };
    }
    return rest;
  });
  return JSON.stringify({ ...proposal, operations });
}

/** Bounded, content-free description of what a (possibly invalid) proposal actually contained. Diagnostic only. */
export function describeProposalShape(rawOrValue: unknown): string {
  let value: unknown = rawOrValue;
  if (typeof rawOrValue === 'string') {
    const extracted = extractCodingProposalJson(rawOrValue);
    if (!extracted.ok) return `unparseable(${extracted.error}; chars=${rawOrValue.length})`;
    value = extracted.value;
  }
  if (!isRecord(value)) return 'not_an_object';
  const record = value;
  const container = ['operations', 'changes', 'files', 'edits'].find(key => Array.isArray(record[key]));
  if (!container) return `operations=none keys=${Object.keys(record).slice(0, 10).join('|')}`;
  const ops = record[container] as unknown[];
  const parts = ops.slice(0, 8).map(op => {
    const entry = isRecord(op) ? op : {};
    const type = String(entry.type ?? entry.action ?? entry.operation ?? '?').slice(0, 20);
    const pathText = String(entry.path ?? entry.file ?? '').slice(0, 80);
    const edits = Array.isArray(entry.edits) ? entry.edits.length : (typeof entry.oldText === 'string' ? 'flat' : 0);
    const content = typeof entry.content === 'string' ? `${entry.content.length}ch` : 'no';
    return `[${type} ${pathText} edits=${edits} content=${content}]`;
  });
  const more = ops.length > 8 ? ` +${ops.length - 8} more` : '';
  return `${container === 'operations' ? '' : `container=${container} `}ops=${ops.length} ${parts.join(' ')}${more}`.slice(0, 700);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AnchoredEditExpansion {
  ok: boolean;
  value: unknown;
  errors: string[];
  /** Host-observed digest of the on-disk bytes each expansion was computed from, by normalized path. */
  baseDigests: Map<string, string>;
  expanded: boolean;
  /** Bounded model feedback for failed anchors (see describeAnchorMiss). */
  hints: string[];
  /** The exact anchors each expanded path was built from, by normalized path. */
  sourceEdits?: Map<string, AnchoredEdit[]>;
}

/**
 * Rewrites every `edit` operation of a normalized proposal value into a `replace` carrying the full resulting
 * content. Operations of any other type are untouched. Any failure leaves the proposal unusable (fail closed).
 */
export async function expandAnchoredEditOperations(
  value: unknown,
  workspaceRoot: string,
  signal?: AbortSignal,
): Promise<AnchoredEditExpansion> {
  const baseDigests = new Map<string, string>();
  if (!isRecord(value) || !Array.isArray(value.operations)) {
    return { ok: true, value, errors: [], baseDigests, expanded: false, hints: [] };
  }
  const operations = value.operations as unknown[];
  if (!operations.some(operation => isRecord(operation) && operation.type === 'edit')) {
    return { ok: true, value, errors: [], baseDigests, expanded: false, hints: [] };
  }
  const inspection = new WorkspaceInspectionTools(workspaceRoot);
  const errors: string[] = [];
  const hints: string[] = [];
  const sourceEdits = new Map<string, AnchoredEdit[]>();
  const nextOperations: unknown[] = [];
  const seenPaths = new Set<string>();
  for (const operation of operations) {
    if (isRecord(operation) && typeof operation.path === 'string') {
      const key = normalizeRelativePath(operation.path).toLowerCase();
      if (operation.type === 'edit' && seenPaths.has(key)) {
        errors.push('duplicate_operation_path');
      }
      seenPaths.add(key);
    }
    if (!isRecord(operation) || operation.type !== 'edit') {
      nextOperations.push(operation);
      continue;
    }
    throwIfAborted(signal);
    const relativePath = typeof operation.path === 'string' ? operation.path.trim() : undefined;
    const pathError = validateRelativeWorkspacePath(relativePath);
    if (pathError || !relativePath) {
      errors.push(pathError ?? 'path_required');
      continue;
    }
    const edits = operation.edits;
    if (!Array.isArray(edits) || edits.length === 0 || !edits.every(isRecord)) {
      errors.push('edit_malformed');
      continue;
    }
    let bytes: Buffer;
    try {
      const absolute = await inspection.resolveInsideWorkspace(relativePath);
      const stat = await fs.stat(absolute);
      if (!stat.isFile()) {
        errors.push('edit_target_missing');
        continue;
      }
      if (stat.size > ANCHORED_EDIT_MAX_FILE_BYTES) {
        errors.push('edit_too_large');
        continue;
      }
      bytes = await fs.readFile(absolute);
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      errors.push(code === 'ENOENT' ? 'edit_target_missing' : 'edit_read_failed');
      continue;
    }
    if (bytes.includes(0)) {
      errors.push('binary_content_rejected');
      continue;
    }
    const applied = applyAnchoredEdits(
      bytes.toString('utf8'),
      (edits as Array<Record<string, unknown>>).map(edit => ({
        oldText: typeof edit.oldText === 'string' ? edit.oldText : (undefined as unknown as string),
        newText: typeof edit.newText === 'string' ? edit.newText : (undefined as unknown as string),
      })),
    );
    if (!applied.ok) {
      errors.push(applied.error);
      const missed = applied.editIndex !== undefined ? (edits as Array<Record<string, unknown>>)[applied.editIndex] : undefined;
      if (
        missed && typeof missed.oldText === 'string' && hints.length < ANCHOR_HINTS_MAX
        && (applied.error === 'edit_anchor_not_found' || applied.error === 'edit_anchor_ambiguous')
      ) {
        hints.push(describeAnchorMiss(relativePath, bytes.toString('utf8'), missed.oldText, applied.error).slice(0, ANCHOR_HINT_MAX_CHARS));
      }
      continue;
    }
    baseDigests.set(normalizeRelativePath(relativePath), `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    sourceEdits.set(normalizeRelativePath(relativePath), (edits as Array<Record<string, unknown>>).map(edit => ({ oldText: String(edit.oldText), newText: String(edit.newText) })));
    nextOperations.push({
      type: 'replace',
      path: relativePath,
      reason: typeof operation.reason === 'string' ? operation.reason : '',
      content: applied.content,
    });
  }
  if (errors.length > 0) {
    return { ok: false, value, errors: [...new Set(errors)], baseDigests, expanded: false, hints };
  }
  return { ok: true, value: { ...value, operations: nextOperations }, errors: [], baseDigests, expanded: true, hints: [], sourceEdits };
}

/**
 * Drop-in replacement for `parseAndValidateCodingProposal` that additionally accepts `edit` operations when a
 * workspace root is known. Without one, an `edit` fails closed as `operation_unsupported` in the unchanged validator.
 */
export async function parseValidateAndExpandCodingProposal(
  raw: string,
  packageScripts: readonly string[],
  workspaceRoot: string | undefined,
  limits: ProposalLimits = DEFAULT_PROPOSAL_LIMITS,
  signal?: AbortSignal,
): Promise<ProposalValidationResult> {
  const extracted = extractCodingProposalJson(raw);
  if (!extracted.ok) {
    return { ok: false, errors: [extracted.error] };
  }
  const normalized = normalizeCodingProposalConformance(extracted.value);
  let conformance: CodingProposalConformanceMetadata | undefined = mergeConformance(extracted.conformance, normalized.conformance);
  if (!normalized.ok) {
    return { ok: false, errors: normalized.errors, conformance };
  }
  let value = normalized.value;
  let baseDigests = new Map<string, string>();
  let sourceEdits = new Map<string, AnchoredEdit[]>();
  if (workspaceRoot) {
    const expansion = await expandAnchoredEditOperations(value, workspaceRoot, signal);
    if (!expansion.ok) {
      return { ok: false, errors: expansion.errors, conformance, ...(expansion.hints.length > 0 ? { repairHints: expansion.hints } : {}) };
    }
    if (expansion.expanded) {
      value = expansion.value;
      baseDigests = expansion.baseDigests;
      sourceEdits = expansion.sourceEdits ?? sourceEdits;
      conformance = { ...(conformance ?? {}), anchoredEditsExpanded: true };
    }
  }
  const validation = validateCodingProposal(value, packageScripts, limits);
  if (validation.ok && validation.proposal && baseDigests.size > 0) {
    // Host-assigned only. A model-supplied editBaseSha256 is never copied by the validator.
    validation.proposal.operations = validation.proposal.operations.map(operation => {
      const digest = baseDigests.get(operation.path);
      const anchors = sourceEdits.get(operation.path);
      return digest ? { ...operation, editBaseSha256: digest, ...(anchors ? { anchoredEdits: anchors } : {}) } : operation;
    });
  }
  return { ...validation, conformance };
}
