/**
 * Phase 6 — explicit stage routing.
 *
 * Records, for each pipeline stage (planner/implementer/reviewer/validator/
 * deterministic-host), which provider+model actually executed it, why it was
 * routed there, and — when a preferred model candidate was unavailable and
 * the stage fell back to a deterministic host — why that fallback happened.
 *
 * This module is deliberately host-side and makes no model calls itself.
 * Callers supply an optional model candidate (constructor/param injection at
 * the call site, e.g. `AutonomousTaskRuntime`'s `stageReviewer` param); when
 * absent or unavailable, routing falls back to the deterministic host and
 * records a `fallbackReason`. This generalizes the existing deterministic-
 * host provenance pattern already used by `DiffReviewStage.runDiffReviewStage`
 * (host provider `'host'`, model `'deterministic'`).
 */

export type StageName = 'planner' | 'implementer' | 'reviewer' | 'validator' | 'deterministic-host';

export interface StageRoutingCandidate {
  provider: string;
  model: string;
  available: boolean;
}

export interface StageRoutingDecision {
  stage: StageName;
  provider: string;
  model: string;
  routingReason: string;
  fallbackReason?: string;
  decidedAt: string;
}

export interface StageRoutingInput {
  stage: StageName;
  /** Preferred provider/model candidate for this stage, if one is configured
   * and injected at the call site. Absent entirely when no model integration
   * exists for the stage yet. */
  preferred?: StageRoutingCandidate;
  /** Deterministic host identity used when no usable model candidate exists.
   * Defaults to `{ provider: 'host', model: 'deterministic' }`, matching the
   * existing `DiffReviewStage` convention. */
  deterministicHost?: { provider: string; model: string };
}

const DEFAULT_HOST = { provider: 'host', model: 'deterministic' } as const;

/**
 * Pure routing decision: prefers a configured, available model candidate;
 * otherwise falls back to the deterministic host with an explicit,
 * machine-readable reason. Never throws — an unavailable or missing
 * preferred candidate is itself a valid, recorded routing outcome, not an
 * error condition.
 */
export function routeStage(input: StageRoutingInput): StageRoutingDecision {
  const decidedAt = new Date().toISOString();
  const host = input.deterministicHost ?? DEFAULT_HOST;

  if (!input.preferred) {
    return {
      stage: input.stage,
      provider: host.provider,
      model: host.model,
      routingReason: 'no_model_candidate_configured',
      fallbackReason: 'no_model_candidate_configured',
      decidedAt,
    };
  }

  if (!input.preferred.available) {
    return {
      stage: input.stage,
      provider: host.provider,
      model: host.model,
      routingReason: 'preferred_candidate_unavailable',
      fallbackReason: `preferred_candidate_unavailable:${input.preferred.provider}/${input.preferred.model}`,
      decidedAt,
    };
  }

  return {
    stage: input.stage,
    provider: input.preferred.provider,
    model: input.preferred.model,
    routingReason: 'preferred_candidate_available',
    decidedAt,
  };
}
