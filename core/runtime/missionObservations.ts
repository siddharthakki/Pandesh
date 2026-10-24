import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isHostOwnedSearchPath } from './missionHostPaths';
import { recoverRepositoryPath } from './repositoryPathRecovery';

export const MAX_OBSERVATION_CHARS = 4_000;
export const MAX_SEARCH_RESULTS = 40;

/**
 * What a typed mission check was and what it concluded, as data.
 *
 * `run_check` covers focused validation, diff review, repository status, and
 * delivery, and its human-readable output is the only place that distinction
 * used to exist — so every consumer had to pattern-match prose to tell a diff
 * review from a commit, and to recover the reviewed paths or the delivery SHA.
 * This is that same information in structured form. It is derived from the
 * check Core actually ran; it never asserts anything the check did not
 * establish.
 */
export interface MissionCheckEvidence {
  kind: 'validation' | 'diff_review' | 'status' | 'commit';
  /**
   * `refused` means Core declined to run the check because a precondition was
   * missing; `blocked` means it ran and stopped at a safety gate.
   */
  status: 'passed' | 'failed' | 'rejected' | 'refused' | 'blocked';
  /** The reviewed manifest: exactly what delivery is allowed to stage. */
  reviewedPaths?: string[];
  /** Binds a review to the paths and contents the reviewer saw. */
  reviewDigest?: string;
  /** Set only by a delivery that actually produced a commit. */
  commitSha?: string;
  command?: string;
  exitCode?: number | null;
}

export interface MissionObservation {
  action: string;
  path?: string;
  range?: string;
  query?: string;
  resultCount: number;
  truncated: boolean;
  fingerprint?: string;
  output: string;
  ok: boolean;
  cached?: boolean;
  rejectedCalls?: Array<{ name: string; summary: Record<string, unknown> }>;
  /** Present on every `run_check` observation Core produces. */
  check?: MissionCheckEvidence;
}

export interface MissionEvidence {
  approvedMutation: boolean;
  approvedPath?: string;
  /** Every path Core approved this mission: the authorized delivery manifest. */
  approvedPaths?: string[];
  validationPassed: boolean;
  validationCommand?: string;
  validationExitCode?: number | null;
  lastValidationSummary?: string;
  repairCount?: number;
  verificationRequired?: boolean;
  verificationPassed?: boolean;
  verificationFingerprint?: string;
  lastVerificationSummary?: string;
  diffReview: 'pass' | 'reject' | 'pending';
  /** Binds the commit to the manifest paths and contents diff review saw. */
  reviewDigest?: string;
  commitSha?: string;
  deliveryStatus?: 'local_commit' | 'blocked' | 'needs_clarification';
}

export function missionValidationStatus(evidence: MissionEvidence): 'pass' | 'fail' | 'missing' {
  if (evidence.validationPassed) return 'pass';
  if (evidence.lastValidationSummary || evidence.validationExitCode != null) return 'fail';
  return 'missing';
}

export function applyValidationSummary(evidence: MissionEvidence, validationText: string | undefined): MissionEvidence {
  if (!validationText) return evidence;
  const passed = validationText.includes('Validation: passed');
  const commandLine = validationText.split('\n').find((line) => line.trim().startsWith('- '));
  const validationCommand = commandLine?.replace(/^- /, '').split('(')[0]?.trim() ?? 'workspace validation';
  const exitMatch = /exit (\d+|n\/a)/.exec(validationText);
  const validationExitCode = passed ? 0 : (exitMatch && exitMatch[1] !== 'n/a' ? Number(exitMatch[1]) : 1);
  return {
    ...evidence,
    validationPassed: passed,
    validationCommand,
    validationExitCode,
    lastValidationSummary: validationText,
  };
}

export function missionVerificationStatus(evidence: MissionEvidence): 'pass' | 'fail' | 'missing' | 'not_required' {
  if (evidence.verificationRequired === false) return 'not_required';
  if (evidence.verificationPassed) return 'pass';
  if (evidence.lastVerificationSummary) return 'fail';
  if (evidence.verificationRequired) return 'missing';
  return 'not_required';
}

export function completionRefusal(evidence: MissionEvidence): string | null {
  const missing: string[] = [];
  if (!evidence.approvedMutation) missing.push('approved mutation');
  if (!evidence.validationPassed) missing.push('successful focused validation');
  if (evidence.verificationRequired && !evidence.verificationPassed) missing.push('successful behavioral verification');
  if (evidence.diffReview !== 'pass') missing.push('passing diff review');
  if (!evidence.commitSha) missing.push('commit SHA');
  if (evidence.deliveryStatus !== 'local_commit') missing.push('explicit local-commit delivery status');
  return missing.length > 0 ? `completion refused: missing ${missing.join(', ')}` : null;
}

export function fingerprintText(content: string): string {
  return `sha256:${crypto.createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

export function boundText(text: string, max = MAX_OBSERVATION_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated]`, truncated: true };
}

export function formatObservation(observation: MissionObservation): string {
  return JSON.stringify({
    action: observation.action,
    path: observation.path ?? null,
    range: observation.range ?? null,
    query: observation.query ?? null,
    resultCount: observation.resultCount,
    truncated: observation.truncated,
    fingerprint: observation.fingerprint ?? null,
    ok: observation.ok,
    cached: observation.cached ?? false,
    rejectedCalls: observation.rejectedCalls ?? null,
    check: observation.check ?? null,
    output: observation.output,
  });
}

export function readWorkspaceRange(input: {
  workspaceRoot: string;
  requestedPath: string;
  startLine?: number;
  endLine?: number;
}): MissionObservation {
  if (isHostOwnedSearchPath(input.requestedPath)) {
    return {
      action: 'read_file',
      path: input.requestedPath.replace(/\\/g, '/').replace(/^\.\//, ''),
      resultCount: 0,
      truncated: false,
      ok: false,
      output: 'host-owned path is not available for model investigation; Core runs verification after your approved mutation',
    };
  }
  const recovery = recoverRepositoryPath({
    workspaceRoot: input.workspaceRoot,
    requestedPath: input.requestedPath,
    target: 'read',
  });
  const selected = recovery.selected ?? recovery.normalized;
  if (selected && isHostOwnedSearchPath(selected)) {
    return {
      action: 'read_file',
      path: selected,
      resultCount: 0,
      truncated: false,
      ok: false,
      output: 'host-owned path is not available for model investigation; Core runs verification after your approved mutation',
    };
  }
  if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected')) {
    return {
      action: 'read_file',
      path: selected,
      resultCount: 0,
      truncated: false,
      ok: false,
      output: `Repository path blocked: ${recovery.reason}`,
    };
  }
  const raw = fs.readFileSync(recovery.resolvedPath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = input.startLine && input.startLine > 0 ? input.startLine : 1;
  const end = input.endLine && input.endLine > 0 ? Math.min(input.endLine, lines.length) : lines.length;
  const slice = lines.slice(start - 1, end);
  const excerpt = slice.map((line, index) => `${String(start + index).padStart(4, ' ')}|${line}`).join('\n');
  const bounded = boundText(excerpt);
  return {
    action: 'read_file',
    path: selected,
    range: `${start}-${end}`,
    resultCount: slice.length,
    truncated: bounded.truncated,
    fingerprint: fingerprintText(raw),
    ok: true,
    output: bounded.text,
  };
}

export function isInsideWorkspace(workspaceRoot: string, target: string): boolean {
  const root = path.resolve(workspaceRoot);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
