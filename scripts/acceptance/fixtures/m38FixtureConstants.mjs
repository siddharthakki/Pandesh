/**
 * M38 — shared constants for the Core-only governed-capability-fabric
 * acceptance fixtures (scripted Ollama-compatible model, deterministic
 * research transport, fake `gh`). Kept in one place so the scripted Ollama
 * fixture's validation markers, the research/GitHub fixtures' fixed content,
 * and the Core-only smoke script's assertions can never silently drift out
 * of sync with each other.
 */

// --- Scripted model fixture ------------------------------------------------

export const M38_FIXTURE_MODEL = 'karkedikha-m38-fixture-model';

// --- Repository-inspection step (real, unmodified `read_file` workspace
// tool — dispatched directly by CoreToolRunner, never approval-gated) -------

export const M38_REPO_FIXTURE_FILE_NAME = 'm38-fixture-notes.md';
export const M38_REPO_FIXTURE_FILE_CONTENT =
  'M38 fixture repository note: the deployment window opens Thursday at noon.\n';

// --- Governed research step (core/runtime/researchCapability.ts) ----------

export const M38_RESEARCH_QUERY = 'm38 fixture governed research query';
export const M38_RESEARCH_SOURCE_TITLE = 'M38 Fixture Research Source';
// A distinctive, greppable marker embedded in the fixture source page's
// extracted text — this is what proves the research capability's evidence
// (not a hallucination) reached the model, and later the final answer.
export const M38_RESEARCH_EVIDENCE_MARKER = 'm38-fixture-research-evidence-widgets-ship-friday';

// --- Governed GitHub step (core/runtime/githubCapability.ts + fake `gh`) --

export const M38_GITHUB_REPOSITORY = 'acme/m38-fixture-repo';
export const M38_GITHUB_ISSUE_NUMBER = 42;
export const M38_GITHUB_COMMENT_BODY = 'm38 fixture governed capability comment body';
// Printed by the fake `gh issue comment` subcommand on a real (mutating)
// post — this is the fixed marker the scripted model fixture and the
// Core-only smoke script both look for as proof the mutation actually ran.
export const M38_GITHUB_COMMENT_MARKER = 'FIXTURE_GH_COMMENT_POSTED';

/** The final, grounded assistant answer the scripted model fixture returns
 * once it has seen tool-result evidence from all three capabilities, in
 * order. Deliberately echoes a marker unique to each of the three steps so
 * "grounded in all three tool results" is a mechanical string check, not a
 * judgment call. */
export function m38FinalAnswer() {
  return (
    `Repository note: ${M38_REPO_FIXTURE_FILE_CONTENT.trim()} ` +
    `Research finding: ${M38_RESEARCH_EVIDENCE_MARKER}. ` +
    `Posted comment on ${M38_GITHUB_REPOSITORY}#${M38_GITHUB_ISSUE_NUMBER} (${M38_GITHUB_COMMENT_MARKER}).`
  );
}

/** Distinctive marker the scripted model fixture's final answer carries when
 * the github_comment_on_issue capability was DENIED (Core's honest
 * `[github_comment_on_issue] Action denied by the user; no mutation was
 * performed.` tool result — see core/runtime/executor.ts's rejection
 * branch) rather than approved. Used by the packaged deny-after-restart
 * acceptance scenario (D) to prove the attempt reaches a real, grounded
 * terminal answer that honestly reports the denial rather than fabricating
 * success or failing the whole attempt outright. */
export const M38_DENIAL_ANSWER_MARKER = 'm38-fixture-comment-denied-no-mutation';

export function m38DeniedFinalAnswer() {
  return (
    `Repository note: ${M38_REPO_FIXTURE_FILE_CONTENT.trim()} ` +
    `Research finding: ${M38_RESEARCH_EVIDENCE_MARKER}. ` +
    `Comment was not posted: the user denied the github_comment_on_issue action (${M38_DENIAL_ANSWER_MARKER}).`
  );
}
