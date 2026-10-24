/**
 * Phase 5 wiring — runs the independent actual-diff review against the real
 * bound worktree, using actual `git diff`/`git status` output (not model
 * prose), and produces the enforceable verdict `AutonomousTaskRuntime`
 * gates delivery approval on.
 *
 * The deterministic host-side findings (`buildDiffReviewFindings`) are
 * always authoritative and can force `reject` on their own. A distinct
 * model-authored verdict is an optional seam (`reviewerVerdict` callback) —
 * Phase 6 stage routing can supply a separately configured reviewer model
 * here later. Without one configured, the host findings alone determine the
 * verdict, which keeps this a real, always-on enforcement gate today rather
 * than a no-op waiting on a future model integration.
 */

import { spawn } from 'child_process';
import { CodingProposal } from './CodingProposal';
import {
  computeReviewedContentFingerprint,
  excludeRuntimeInternalPaths,
  RUNTIME_INTERNAL_GIT_EXCLUDE_PATHSPEC,
} from './ChangeScopeReconciliation';
import { cleanupGeneratedArtifacts, excludeGeneratedArtifactPaths } from './GeneratedArtifactPolicy';
import { buildDiffReviewFindings, combineDiffReviewVerdict, DiffReviewVerdict, ObjectiveRelevanceEvidence } from './DiffReview';
import { extractReferencedSymbols } from '../orchestration/ConversationContinuity';

export interface DiffReviewStageInput {
  workspaceRoot: string;
  verifiedProposal: CodingProposal;
  approvedScopePaths: string[];
  validationResults: ReadonlyArray<{ command: string; exitCode: number | null; timedOut: boolean }>;
  qualityGateStatus: 'passed' | 'failed' | 'unknown';
  originalTaskGoal: string;
  baselineArtifacts?: ReadonlySet<string>;
  reviewerVerdict?: (input: {
    goal: string;
    proposal: CodingProposal;
    diff: string;
    changedFiles: string[];
  }) => Promise<{ verdict: 'pass' | 'reject'; requirementFindings: string[]; explanation: string; provider: string; model: string }>;
}

function runGit(args: string[], cwd: string): Promise<{ code: number | null; stdout: string }> {
  return new Promise(resolve => {
    try {
      const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
      let stdout = '';
      const timer = setTimeout(() => { child.kill(); resolve({ code: null, stdout }); }, 15_000);
      child.stdout.on('data', data => { stdout += String(data); });
      child.on('error', () => { clearTimeout(timer); resolve({ code: null, stdout }); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout }); });
    } catch {
      resolve({ code: null, stdout: '' });
    }
  });
}

/**
 * `git status --porcelain` lines are exactly `XY path` — two fixed status
 * columns (which may be spaces) followed by one space and the path; a rename
 * is `XY old -> new` where only `new` is the current path. Trimming/regex on
 * the whole line is unsafe (leading spaces in the status columns are
 * significant, not padding), so this parses columns positionally.
 */
/**
 * Shared with `approveDelivery()`'s Phase 7 commit-time reconciliation so
 * both call sites parse `git status --porcelain --untracked-files=all`
 * identically instead of maintaining two positional parsers that could
 * silently drift apart.
 */
export function parseGitStatusPorcelain(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => {
      const rest = line.slice(3);
      const arrow = rest.indexOf(' -> ');
      return (arrow === -1 ? rest : rest.slice(arrow + 4)).trim();
    })
    .filter(Boolean);
}

/**
 * Extracts just the untracked (`??`) paths from `git status --porcelain`
 * output. `git diff HEAD` never reflects untracked files at all, so callers
 * building a reviewed-content fingerprint (`computeReviewedContentFingerprint`)
 * need this list to hash their bytes directly instead of relying on the diff.
 */
export function parseUntrackedPathsPorcelain(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).trim())
    .filter(Boolean);
}

async function gitStatusStdout(workspaceRoot: string): Promise<string> {
  // `--untracked-files=all` is required — by default git collapses a wholly
  // new directory to a single `dirname/` entry instead of listing each new
  // file, which would make every file inside a newly created directory
  // register as one unrecognizable "path" that can never match an approved
  // per-file scope entry.
  const { stdout } = await runGit(['status', '--porcelain', '--untracked-files=all'], workspaceRoot);
  return stdout;
}

async function actualDiff(workspaceRoot: string): Promise<string> {
  const { stdout } = await runGit(['diff', 'HEAD', '--', '.', RUNTIME_INTERNAL_GIT_EXCLUDE_PATHSPEC], workspaceRoot);
  return stdout;
}

/**
 * Locates, via a real `git grep` over the post-mutation worktree, which
 * tracked files contain each identifier `extractReferencedSymbols` pulls out
 * of the task goal. Runs against the CURRENT tree — a file the mutation just
 * deleted can never spuriously "contain" a term anymore, and a file the
 * mutation just created is found exactly like any other. `git grep` exits 1
 * (not an error) when a term has no matches anywhere; that term is reported
 * with an empty `matchingFiles` list, which `buildDiffReviewFindings` treats
 * as "nothing to verify" rather than a finding. Task-agnostic and untied to
 * any specific goal text or filename — works the same for any task whose
 * goal names a real, locatable identifier.
 */
async function computeObjectiveRelevanceEvidence(
  workspaceRoot: string,
  originalTaskGoal: string,
): Promise<ObjectiveRelevanceEvidence[]> {
  const terms = extractReferencedSymbols(originalTaskGoal);
  const evidence: ObjectiveRelevanceEvidence[] = [];
  for (const term of terms) {
    // --untracked: files the mutation just created are not yet in the index;
    // plain `git grep` would skip them. .gitignore is still honored.
    const { code, stdout } = await runGit(['grep', '--untracked', '-l', '-F', '--', term], workspaceRoot);
    const matchingFiles = code === 0
      ? excludeGeneratedArtifactPaths(excludeRuntimeInternalPaths(stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean))).slice(0, 50)
      : [];
    evidence.push({ term, matchingFiles });
  }
  return evidence;
}

/**
 * Fails closed: if Git evidence cannot be gathered (interrupted worktree,
 * process failure), the review rejects rather than assuming a clean diff.
 */
export async function runDiffReviewStage(input: DiffReviewStageInput): Promise<DiffReviewVerdict> {
  // Clean up recognized generated runtime artifacts (e.g. __pycache__, .pytest_cache) before gathering git diff/status evidence
  await cleanupGeneratedArtifacts(input.workspaceRoot, { baselineArtifacts: input.baselineArtifacts });

  const [statusStdout, diff, objectiveRelevanceEvidence] = await Promise.all([
    gitStatusStdout(input.workspaceRoot),
    actualDiff(input.workspaceRoot),
    computeObjectiveRelevanceEvidence(input.workspaceRoot, input.originalTaskGoal),
  ]);
  // The runtime's own `.ollama-agent` state writes and recognized generated artifacts
  // must not count as reviewed repository changes or poison the reviewed-content fingerprint.
  const changedFiles = excludeGeneratedArtifactPaths(excludeRuntimeInternalPaths(parseGitStatusPorcelain(statusStdout)));
  const untrackedFiles = excludeGeneratedArtifactPaths(excludeRuntimeInternalPaths(parseUntrackedPathsPorcelain(statusStdout)));

  const findings = buildDiffReviewFindings({
    originalTaskGoal: input.originalTaskGoal,
    verifiedProposal: input.verifiedProposal,
    approvedScopePaths: input.approvedScopePaths,
    actualDiff: diff,
    actualChangedFiles: changedFiles,
    objectiveRelevanceEvidence,
    validationResults: input.validationResults,
    qualityGateStatus: input.qualityGateStatus,
  });
  const reviewedDiffFingerprint = await computeReviewedContentFingerprint(input.workspaceRoot, diff, untrackedFiles);

  if (input.reviewerVerdict) {
    try {
      const modelVerdict = await input.reviewerVerdict({
        goal: input.originalTaskGoal,
        proposal: input.verifiedProposal,
        diff,
        changedFiles,
      });
      return combineDiffReviewVerdict(
        findings,
        { verdict: modelVerdict.verdict, requirementFindings: modelVerdict.requirementFindings, explanation: modelVerdict.explanation },
        modelVerdict.provider,
        modelVerdict.model,
        reviewedDiffFingerprint,
      );
    } catch {
      // A distinct reviewer invocation that itself fails must not silently
      // pass delivery — fail closed exactly like an interrupted claim check.
      return combineDiffReviewVerdict(
        findings,
        { verdict: 'reject', requirementFindings: [], explanation: 'reviewer invocation failed' },
        'unknown',
        'unknown',
        reviewedDiffFingerprint,
      );
    }
  }

  const hostOnlyClean =
    findings.changedFileScope.unexpected.length === 0 &&
    findings.changedFileScope.missingExpected.length === 0 &&
    findings.validationFindings.length === 0 &&
    findings.securityFindings.length === 0 &&
    findings.objectiveRelevanceFindings.length === 0;
  return combineDiffReviewVerdict(
    findings,
    {
      verdict: hostOnlyClean ? 'pass' : 'reject',
      requirementFindings: [],
      explanation: hostOnlyClean
        ? 'Deterministic host evidence (scope, validation, secret scan) found no issues; no stage reviewer model configured.'
        : 'Deterministic host evidence found issues; no stage reviewer model configured to override them.',
    },
    'host',
    'deterministic',
    reviewedDiffFingerprint,
  );
}
