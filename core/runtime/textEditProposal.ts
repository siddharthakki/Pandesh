/**
 * Anchored text-edit proposal — Core computes the resulting file content
 * itself from an exact find/replace anchor. The model supplies only the
 * anchor (`path`, `find`, `replace`); it never supplies full file content,
 * so there is nothing for it to truncate or silently corrupt.
 *
 * `find` must occur exactly once in the current file — zero or multiple
 * occurrences is ambiguous and refused rather than guessed at. This mirrors
 * (and reuses) the diff/baseline machinery in `writeProposal.ts` so an
 * anchored edit gets the same proposal-time diff, baseline SHA-256 capture,
 * and stale-baseline write-time refusal as a full `propose_file_change`.
 *
 * Core-safe: node `fs`/`crypto` only, no `vscode`.
 */
import * as fs from 'node:fs';
import { recoverRepositoryPath } from './repositoryPathRecovery';
import {
  buildUnifiedDiff,
  readBaselineIdentity,
  type WriteBaselineIdentity,
  type WriteProposalPresentation,
} from './writeProposal';

export type AnchorResolution =
  | { ok: true; content: string }
  | { ok: false; reason: string };

/**
 * Applies one anchored find/replace against baseline text. `find` must occur
 * exactly once — zero occurrences (missing anchor) or more than one
 * (ambiguous anchor) are both refused without producing any content.
 */
export function resolveAnchoredEdit(baselineText: string, find: string, replace: string): AnchorResolution {
  if (find === '') return { ok: false, reason: 'find must not be empty' };
  const occurrences = baselineText.split(find).length - 1;
  if (occurrences === 0) return { ok: false, reason: 'find text was not found in the file' };
  if (occurrences > 1) return { ok: false, reason: `find text occurs ${occurrences} times; it must occur exactly once` };
  return { ok: true, content: baselineText.split(find).join(replace) };
}

export interface TextEditProposal {
  /** Absolute path the proposal resolved to at proposal time. */
  resolvedPath: string;
  /** Workspace-relative path the proposal resolved to. */
  selectedPath: string;
  expectedBaseline: WriteBaselineIdentity;
  /** The complete resulting content, computed by Core from the current file. */
  content: string;
  presentation: WriteProposalPresentation;
}

/** Never read more than this from disk to build a baseline preview — matches
 * the equivalent bound in `writeProposal.ts`. */
const MAX_BASELINE_BYTES = 2 * 1024 * 1024;

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Captures everything needed to approve, render, and later safely execute
 * one `propose_text_edit` call — BEFORE any approval exists. Core reads the
 * file, resolves the anchor, and computes the resulting content itself.
 * Returns an `error` when the path cannot be resolved inside the workspace,
 * no file exists yet at that path (an anchored edit requires an existing
 * baseline to anchor against), the baseline is binary/oversized/unreadable,
 * or the anchor does not resolve unambiguously.
 */
export function buildTextEditProposal(input: {
  workspaceRoot: string;
  requestedPath: string;
  find: string;
  replace: string;
}): TextEditProposal | { error: string } | undefined {
  const recovery = recoverRepositoryPath({
    workspaceRoot: input.workspaceRoot,
    requestedPath: input.requestedPath,
    target: 'write',
  });
  if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) return undefined;

  const identity = readBaselineIdentity(recovery.resolvedPath);
  if ('error' in identity) return { error: identity.error };
  if (identity.baseline.kind === 'absent') {
    return { error: 'no file exists at this path to anchor the edit against' };
  }

  const selectedPath = recovery.selected ?? recovery.normalized;
  let baselineText: string;
  try {
    const buffer = fs.readFileSync(recovery.resolvedPath);
    if (buffer.includes(0) || buffer.byteLength > MAX_BASELINE_BYTES) {
      return { error: 'binary or oversized file cannot be anchor-edited' };
    }
    baselineText = buffer.toString('utf8');
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  const resolved = resolveAnchoredEdit(baselineText, input.find, input.replace);
  if (!resolved.ok) return { error: resolved.reason };

  const baselineLines = splitLines(baselineText);
  const proposedLines = splitLines(resolved.content);
  const rendered = buildUnifiedDiff(baselineLines, proposedLines, selectedPath);

  return {
    resolvedPath: recovery.resolvedPath,
    selectedPath,
    expectedBaseline: identity.baseline,
    content: resolved.content,
    presentation: {
      kind: 'write_file_diff',
      path: selectedPath,
      baseline: identity.baseline.kind,
      diff: rendered.diff,
      truncated: rendered.truncated,
      baselineLines: baselineLines.length,
      proposedLines: proposedLines.length,
    },
  };
}
