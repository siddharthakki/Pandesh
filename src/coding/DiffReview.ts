/**
 * Phase 5 — independent post-implementation actual-diff review.
 *
 * This is the stage AFTER mutation, deterministic validation, and the M16
 * gate, and BEFORE delivery approval. It is distinct from the pre-mutation
 * fixed-graph proposal reviewer (`GovernedCodingExecutor` / fixed graph) —
 * that stage reviews a proposed plan; this stage reviews what the worktree
 * actually contains, using real Git evidence, and must never be presented
 * as the same gate.
 *
 * This module builds the deterministic, host-verifiable portion of the
 * review bundle/findings (changed-file scope via `ChangeScopeReconciliation`,
 * validation-evidence passthrough, secret/security findings via the
 * existing `SecretScanner`) and defines the structured verdict contract.
 * The actual reviewer invocation (a distinct model call, per Phase 6 stage
 * routing) is intentionally left to the caller — fabricating an
 * always-pass/always-fail verdict here would defeat reviewer independence.
 */

import { SecretScanner } from '../services/SecretScanner';
import { ChangeScopeReconciliationResult, fingerprintReviewedDiff, reconcileChangeScope } from './ChangeScopeReconciliation';
import { CodingProposal } from './CodingProposal';

/**
 * Where each goal-referenced identifier/symbol (see `extractReferencedSymbols`)
 * actually lives in the repository, gathered by the caller (which has git
 * access) BEFORE this pure function runs — a real, deterministic `git grep`
 * result, never a semantic/model judgment. Optional and defaults to no
 * evidence, so every existing caller/test that doesn't supply it is
 * unaffected (the relevance check below is then simply a no-op).
 */
export interface ObjectiveRelevanceEvidence {
  term: string;
  /** Repository-relative paths where `term` was found, post-mutation. Empty means the term was not located anywhere in the repository (nothing to check it against). */
  matchingFiles: readonly string[];
}

export interface DiffReviewInput {
  originalTaskGoal: string;
  verifiedProposal: CodingProposal;
  approvedScopePaths: string[];
  actualDiff: string;
  actualChangedFiles: string[];
  validationResults: ReadonlyArray<{ command: string; exitCode: number | null; timedOut: boolean }>;
  qualityGateStatus: 'passed' | 'failed' | 'unknown';
  objectiveRelevanceEvidence?: readonly ObjectiveRelevanceEvidence[];
}

export interface DiffReviewFindings {
  changedFileScope: ChangeScopeReconciliationResult;
  validationFindings: string[];
  securityFindings: string[];
  objectiveRelevanceFindings: string[];
}

export type DiffReviewVerdictStatus = 'pass' | 'reject';

export interface DiffReviewVerdict {
  verdict: DiffReviewVerdictStatus;
  requirementFindings: string[];
  changedFileFindings: string[];
  validationFindings: string[];
  securityFindings: string[];
  objectiveRelevanceFindings: string[];
  explanation: string;
  reviewerProvider: string;
  reviewerModel: string;
  /** Phase 7 — sha256 fingerprint of the exact diff text this verdict was
   * decided against; persisted so commit-time reconciliation can detect a
   * modification to an already-approved path made after this review. */
  reviewedDiffFingerprint: string;
}

/**
 * Builds the deterministic evidence a reviewer (human or model) is bound
 * to — nothing here is reviewer-authored; it is derived from real Git/
 * validation/quality-gate facts already produced upstream in the pipeline.
 *
 * Objective-relevance check (`originalTaskGoal` was previously accepted here
 * and never read — a confirmed missing check, not a malfunctioning one): the
 * caller locates, via a real `git grep` over the post-mutation worktree,
 * which files contain each goal-referenced identifier
 * (`extractReferencedSymbols`). When the goal locates at least one such
 * identifier somewhere in the repository, but the actual change touches NONE
 * of the files it was found in, that is real, non-hardcoded, task-agnostic
 * evidence the change did not engage with anywhere the goal's own words
 * point to.
 *
 * This is a text-location signal, not a correctness or completion check, in
 * either direction:
 *  - A PASS here (the change touches a file containing a referenced
 *    identifier) is not proof the fix is correct, or that it solves the
 *    goal — it only means the diff landed somewhere textually connected to
 *    it. A wrong or incomplete change to the right file still passes this
 *    check; nothing downstream re-verifies semantic correctness either.
 *  - A REJECT here is not proof the change is wrong either — a genuinely
 *    correct fix can legitimately live in a file that never mentions the
 *    identifier verbatim (a caller, a type definition, a config). This
 *    conservative false-positive risk is why the threshold below requires
 *    EVERY locatable identifier to be off-target, not just one.
 * A goal with no locatable identifiers (e.g. a doc-only or purely
 * descriptive task) produces no evidence either way and is never blocked by
 * this check. Never report a pass from this specific check as "the task was
 * completed" — it is one deterministic host finding among several (scope,
 * validation, security, below), no more authoritative than those.
 */
export function buildDiffReviewFindings(input: DiffReviewInput): DiffReviewFindings {
  const changedFileScope = reconcileChangeScope(input.approvedScopePaths, input.actualChangedFiles);

  const validationFindings: string[] = [];
  for (const result of input.validationResults) {
    if (result.timedOut) validationFindings.push(`${result.command} timed out`);
    else if (result.exitCode !== 0) validationFindings.push(`${result.command} exited ${result.exitCode ?? 'null'}`);
  }
  if (input.qualityGateStatus !== 'passed') {
    validationFindings.push(`M16 quality gate status: ${input.qualityGateStatus}`);
  }

  const { found } = SecretScanner.redact(input.actualDiff);
  const securityFindings = found.map(name => `possible secret detected in diff: ${name}`);

  const objectiveRelevanceFindings: string[] = [];
  const evidence = input.objectiveRelevanceEvidence ?? [];
  const locatedTerms = evidence.filter(item => item.matchingFiles.length > 0);
  if (locatedTerms.length > 0) {
    const offTarget = locatedTerms.filter(item => !item.matchingFiles.some(file => input.actualChangedFiles.includes(file)));
    // Require every locatable term to be off-target before flagging — a
    // conservative threshold that tolerates a change hitting only some of
    // several referenced identifiers (a common, legitimate partial fix)
    // while still catching a change that engages with none of them at all.
    if (offTarget.length === locatedTerms.length) {
      objectiveRelevanceFindings.push(
        `The task goal references ${offTarget.map(item => item.term).join(', ')}, found elsewhere in the repository, but none of the actual changes touch those files.`,
      );
    }
  }

  return { changedFileScope, validationFindings, securityFindings, objectiveRelevanceFindings };
}

/**
 * Deterministic host-side findings never grant a pass by themselves — an
 * unexpected file, a failed validation/quality-gate/security finding, or an
 * objective-relevance mismatch always forces `reject` regardless of what a
 * model-authored verdict says. A model verdict can only downgrade a `pass`
 * to `reject`, never the reverse — this keeps rejection enforcement from
 * being bypassable by a cooperative or compromised reviewer call.
 */
export function combineDiffReviewVerdict(
  findings: DiffReviewFindings,
  modelVerdict: { verdict: DiffReviewVerdictStatus; requirementFindings: string[]; explanation: string },
  reviewerProvider: string,
  reviewerModel: string,
  reviewedDiffFingerprint: string,
): DiffReviewVerdict {
  const hostForcesReject =
    findings.changedFileScope.unexpected.length > 0 ||
    findings.changedFileScope.missingExpected.length > 0 ||
    findings.validationFindings.length > 0 ||
    findings.securityFindings.length > 0 ||
    findings.objectiveRelevanceFindings.length > 0;

  return {
    verdict: hostForcesReject ? 'reject' : modelVerdict.verdict,
    requirementFindings: modelVerdict.requirementFindings,
    changedFileFindings: [
      ...findings.changedFileScope.unexpected.map(path => `unexpected change: ${path}`),
      ...findings.changedFileScope.missingExpected.map(path => `expected change missing: ${path}`),
    ],
    validationFindings: findings.validationFindings,
    securityFindings: findings.securityFindings,
    objectiveRelevanceFindings: findings.objectiveRelevanceFindings,
    explanation: modelVerdict.explanation,
    reviewerProvider,
    reviewerModel,
    reviewedDiffFingerprint,
  };
}

/** Only a `pass` verdict may allow the `waiting_for_delivery_approval` transition. */
export function diffReviewAllowsDelivery(verdict: DiffReviewVerdict): boolean {
  return verdict.verdict === 'pass';
}
