import { hasAffirmativeMutationIntent as hasMutationIntent, hasDiagnosticRequest, stripLeadingFiller } from '../../core/domain/actionIntent';
/**
 * Unified Conversation V1 — the "Auto" execution-policy router.
 *
 * This is intentionally NOT a fourth execution engine. It decides which of
 * the three EXISTING engines (Baat Kar / Saath Kar / Karke Dikha) should
 * handle a turn, and the caller (AgentPanel) then submits through the exact
 * same production paths those engines already use when a user picks them
 * manually. This module never mutates anything and never talks to Core
 * itself — it is a pure text classifier plus a small amount of bounded
 * prior-turn continuity.
 *
 * Deliberately mirrors (does not import) the read/plan/mutation heuristics
 * in `core/domain/routing.ts`'s `classifyRequest()` — the extension host
 * (`src/`) and Core (`core/`) are separate TypeScript programs/processes
 * (see tsconfig.json's `include`), so cross-importing is not possible; this
 * follows the same mirroring precedent already used by
 * `media/everyday-presentation.js`'s `recommendMode()`.
 *
 * `classifyRequest()` intentionally is NOT reused as-is: it collapses every
 * mutation request (bounded or broad) straight to `karke_dikha`, which is
 * correct for that router's existing callers but is exactly the behavior
 * this milestone must change for the default "Auto" experience — a bounded
 * edit must default to a governed Saath Kar proposal, not unattended
 * autonomous execution. `AUTONOMOUS_EXECUTION` here requires either an
 * explicit end-to-end delegation signal or a genuinely broad multi-scope
 * goal, matching this milestone's product spec (Step 2 of the task).
 */

export type ExecutionPolicy = 'READ_ONLY' | 'COLLABORATIVE_EDIT' | 'AUTONOMOUS_EXECUTION';

export interface PolicyDecision {
  policy: ExecutionPolicy;
  /** Short internal reason for diagnostics/evidence only — never shown to the user verbatim (Step 6). */
  reason: string;
}

/**
 * Bounded prior-turn state a follow-up may use (Step 3). Deliberately small:
 * no full transcript dump, no invented repository facts. Sourced from
 * AgentPanel's existing turn/approval bookkeeping, not a new memory store.
 */
export interface PolicyContinuity {
  /** The execution policy actually used for the previous turn in this conversation, if any. */
  previousPolicy?: ExecutionPolicy;
  /** True when the previous turn left a Saath Kar proposal or Karke Dikha approval gate open (not yet resolved). */
  hasPendingProposal?: boolean;
  /**
   * Durable Conversational Continuity V1: true when `previousPolicy` was
   * restored from Core's persisted working state rather than observed live in
   * this session.
   *
   * This is what stops a restart from silently re-granting autonomy. Inside a
   * live session, "continue" after an autonomous turn continues a task that is
   * still running in front of the user. After a restart there is no such
   * turn — only a remembered label — and the milestone's Step 3 rule applies:
   * automatic continuity must never grant more autonomy than the new wording
   * permits. A restored autonomous policy therefore caps the follow-up at
   * COLLABORATIVE_EDIT; the user can still say "run it end to end" to get
   * autonomy back from the new wording itself.
   */
  previousPolicyIsRestored?: boolean;
}

function hasPlanIntent(text: string): boolean {
  return (
    /\b(?:make|create|give|draft|produce|write)\b[^.\n!?]{0,60}\b(?:plan|roadmap|design|architecture|proposal)\b/i.test(text) ||
    /\b(?:plan|roadmap|architecture)\s+(?:for|to)\b/i.test(text)
  );
}

function hasRepositoryReadIntent(text: string): boolean {
  const repositorySubject =
    /\b(?:repo|repository|workspace|codebase|files?|folders?|director(?:y|ies)|branch(?:es)?|commits?|tests?|package\.json|readme|source code)\b/i.test(text) ||
    /\b(?:git|code|file|commit|branch|patch)\s+diff\b/i.test(text) ||
    /\bdiff\s+(?:of|for|between)\s+(?:(?:the|these|those|two)\s+)?(?:files?|commits?|branches?|code)\b/i.test(text);
  const readAction = /\b(?:read|inspect|check|review|analy[sz]e|find|search|list|show|explain|compare|count|diagnose|look|where|why)\b/i.test(text);
  return (repositorySubject && readAction) || hasDiagnosticRequest(text);
}

function largeRequestScore(text: string): number {
  const scopeTerms =
    text.match(
      /\b(?:api|backend|frontend|database|migration|authentication|authorization|integration|workflow|pipeline|mobile|android|ios|web|ui|ux|tests?|ci|deployment|monitoring|memory|browser|multimodal|audio|video|security|documentation)\b/gi,
    ) || [];
  const actionTerms = text.match(/\b(?:build|implement|integrate|create|add|replace|migrate|redesign|automate|support)\b/gi) || [];
  const listSeparators = (text.match(/[,;]|\band\b/gi) || []).length;
  let score = 0;
  if (text.length >= 450) score += 2;
  else if (text.length >= 260) score += 1;
  if (scopeTerms.length >= 5) score += 3;
  else if (scopeTerms.length >= 3) score += 2;
  if (actionTerms.length >= 3) score += 1;
  if (listSeparators >= 4) score += 1;
  if (/\b(?:end[- ]to[- ]end|entire|full system|platform|ecosystem|epic|multiple stories|production[- ]ready)\b/i.test(text)) score += 2;
  return score;
}

function isLargeRequest(text: string): boolean {
  return hasMutationIntent(text) && largeRequestScore(text) >= 3;
}

/**
 * Explicit end-to-end delegation. This is the ONLY signal that can push a
 * turn all the way to AUTONOMOUS_EXECUTION on its own (independent of
 * whether `hasMutationIntent` also fires) — "take care of this" has no
 * mutation verb of its own but is unambiguous delegation.
 */
function hasAutonomousDelegationIntent(text: string): boolean {
  return (
    /\b(?:run|execute)\b[^.\n!?]{0,60}\b(?:tests?|validation|suite|the relevant tests?|the relevant validation)\b/i.test(text) ||
    // Verification verbs alone are inspection ("Verify your previous run instructions"); they only signal
    // autonomous delegation when the same turn also affirmatively asks to change the workspace.
    (/\b(?:verify|validate)\b/i.test(text) && hasMutationIntent(text)) ||
    /\bend[- ]to[- ]end\b/i.test(text) ||
    /\btake care of\b/i.test(text) ||
    /\brepair\b/i.test(text) ||
    /\bmake sure it works\b/i.test(text) ||
    /\bhandle (?:everything|this end.to.end)\b/i.test(text)
  );
}

/**
 * A bare referential follow-up ("fix it", "do that", "continue") carries no
 * intent signal of its own — its policy comes entirely from continuity.
 * Deliberately conservative: only matches short, clearly pronoun-referring
 * imperatives, never anything containing its own repository/file noun
 * (those already resolved via the checks above, which run first).
 */
function isBareReferentialFollowUp(text: string): boolean {
  const trimmed = stripLeadingFiller(text.trim());
  return /^(?:fix|do|try|implement|continue|go ahead|proceed)(?:\s+(?:it|that|this|with (?:it|that|the other approach)))?[.!]?$/i.test(trimmed)
    || /^continue\.?$/i.test(trimmed);
}

/**
 * Decide the execution policy for one turn's current text. Mirrors Core's
 * `classifyRequest` contamination-prevention contract: it never receives or
 * reads full prior transcript text, only the small bounded `continuity`
 * summary the caller assembles from its own turn/approval bookkeeping.
 */
export function decideExecutionPolicy(currentMessage: string, continuity?: PolicyContinuity): PolicyDecision {
  const text = String(currentMessage ?? '');

  if (hasPlanIntent(text)) {
    return { policy: 'COLLABORATIVE_EDIT', reason: 'planning/design request' };
  }
  if (hasAutonomousDelegationIntent(text)) {
    return { policy: 'AUTONOMOUS_EXECUTION', reason: 'explicit end-to-end delegation signal' };
  }
  if (isLargeRequest(text)) {
    return { policy: 'AUTONOMOUS_EXECUTION', reason: 'broad multi-scope mutating goal' };
  }
  if (hasMutationIntent(text)) {
    return { policy: 'COLLABORATIVE_EDIT', reason: 'bounded modification request, no end-to-end delegation' };
  }
  if (hasRepositoryReadIntent(text)) {
    return { policy: 'READ_ONLY', reason: 'bounded repository-inspection/explanation request' };
  }
  if (isBareReferentialFollowUp(text)) {
    // Never escalate on ambiguity/continuity alone (Step 2 + governance
    // invariant 10): a follow-up caps at COLLABORATIVE_EDIT unless it
    // continues an already-autonomous turn.
    if (continuity?.previousPolicy === 'AUTONOMOUS_EXECUTION' && !continuity.previousPolicyIsRestored) {
      return { policy: 'AUTONOMOUS_EXECUTION', reason: 'continuation of an active autonomous turn' };
    }
    return { policy: 'COLLABORATIVE_EDIT', reason: 'bare follow-up referencing the prior turn' };
  }
  return { policy: 'READ_ONLY', reason: 'ordinary question' };
}
