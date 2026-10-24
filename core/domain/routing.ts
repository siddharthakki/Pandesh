import type { ResolvedMode } from '../shared/wireTypes';
import { hasAffirmativeMutationIntent as hasMutationIntent, hasDiagnosticRequest } from './actionIntent';

/**
 * Deterministic Auto-mode router. Ported (not reinvented — the heuristics are sound,
 * only their location was wrong) from media/chat-runtime-fixes.js's classifyAutoMode()
 * per docs/m32-decisions.md D4. Runs Core-side so routing is auditable, testable
 * without a DOM, and immune to stale-webview-transcript contamination — it receives
 * only the current request text plus explicit capability metadata, never prior chat.
 */

export interface RepositoryCapabilityHint {
  hasWorkspace: boolean;
  gitCapable: boolean;
}

export interface RouteDecision {
  resolvedMode: ResolvedMode;
  routeReason: string;
  /** True when the request describes a broad/mutating goal but there is no
   * repository to execute against yet — Karke Dikha should create/link planning
   * work rather than attempt a doomed git-worktree execution. */
  planningOnly: boolean;
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
  const readAction = /\b(?:read|inspect|check|review|analy[sz]e|find|search|list|show|explain|compare|count|diagnose|look)\b/i.test(text);
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
 * Classifies exactly one request's current text. Never receives or reads prior
 * conversation history — that is the M32 contamination-prevention contract.
 */
export function classifyRequest(currentMessage: string, capability?: RepositoryCapabilityHint): RouteDecision {
  const text = String(currentMessage ?? '');
  // Karke Dikha needs a real git worktree to execute against (branch, commit,
  // push/PR delivery) — a workspace with no git capability can only receive a
  // planning-only Karke Dikha attempt, same as no workspace at all. This was
  // audit finding F5: `hasRepo` previously read only `hasWorkspace` and never
  // consulted `gitCapable`, so a non-git workspace was routed as if it could
  // execute, not just plan.
  const hasRepo = capability?.hasWorkspace !== false && capability?.gitCapable !== false;

  if (hasPlanIntent(text)) {
    return { resolvedMode: 'saath_kar', routeReason: 'planning/design request routed to Saath Kar', planningOnly: false };
  }
  if (isLargeRequest(text)) {
    return {
      resolvedMode: 'karke_dikha',
      routeReason: 'broad multi-scope goal routed to Karke Dikha' + (hasRepo ? '' : ' (no repository — planning only)'),
      planningOnly: !hasRepo,
    };
  }
  if (hasMutationIntent(text)) {
    return {
      resolvedMode: 'karke_dikha',
      routeReason: 'workspace-mutating request routed to Karke Dikha for governed execution' + (hasRepo ? '' : ' (no repository — planning only)'),
      planningOnly: !hasRepo,
    };
  }
  if (hasRepositoryReadIntent(text)) {
    return { resolvedMode: 'saath_kar', routeReason: 'bounded repository-inspection request routed to Saath Kar', planningOnly: false };
  }
  return { resolvedMode: 'baat_kar', routeReason: 'ordinary question routed to Baat Kar', planningOnly: false };
}
