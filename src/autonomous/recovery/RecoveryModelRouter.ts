import type { FailureCause } from './RecoveryTypes';

/**
 * Capability-aware, model-name-agnostic model choice for recovery.
 *
 * This is deliberately NOT learned routing and contains no model names. It
 * answers one question deterministically: "given this failure, is there a
 * different, permitted, capable model worth trying?" The RecoveryController is
 * the only caller, so model changes are decided in one place.
 *
 * Rules, in order:
 *  1. A failure that is not model-shaped (missing grounding) never changes the model.
 *  2. A user-pinned model with fallback disabled is never replaced.
 *  3. Local candidates come first; cloud is DEFAULT DENY and only ever
 *     available when explicitly authorised, and never for a pinned model.
 *  4. A capability-shaped failure only moves to a model not known to be weaker.
 *  5. No permitted capable model means a truthful NO_CAPABLE_MODEL, not a retry.
 */

export interface RecoveryCandidate {
  provider: string;
  model: string;
  /** True for a locally hosted model. Anything else is treated as cloud. */
  local: boolean;
  /** Provider-reported availability. Unavailable candidates are never chosen. */
  available: boolean;
  capability: {
    chat: boolean;
    structuredOutput: boolean;
    embeddingOnly: boolean;
    /** Roles the model may serve; empty means any non-embedding role. */
    allowedRoles: readonly string[];
    contextWindow: number;
  };
  /** Relative size/strength evidence (e.g. billions of parameters). Optional. */
  strength?: number;
}

export interface RecoveryModelPolicy {
  /** The user pinned this model for the task. */
  pinned: boolean;
  /** When pinned, whether the user allowed fallback anyway. Default false. */
  fallbackAllowedWhenPinned: boolean;
  /** Cloud use explicitly authorised for this task by governing configuration. */
  cloudAuthorized: boolean;
}

export type ModelChoice =
  | { kind: 'model'; provider: string; model: string; local: boolean; reason: string }
  | {
    kind: 'none';
    reason:
      | 'not_model_shaped'
      | 'pinned_no_fallback'
      | 'no_candidate_pool'
      | 'no_capable_untried_model';
    detail: string;
  };

const MODEL_SHAPED: ReadonlySet<FailureCause> = new Set(['format_failure', 'semantic_failure', 'validation_failure', 'provider_failure']);
/** Failures where a weaker model cannot be expected to do better. */
const NEEDS_STRONGER: ReadonlySet<FailureCause> = new Set(['format_failure', 'semantic_failure', 'validation_failure']);

export function isCapableForRecovery(candidate: RecoveryCandidate, minContext = 0): boolean {
  const cap = candidate.capability;
  if (!candidate.available || !cap.chat || cap.embeddingOnly || !cap.structuredOutput) return false;
  if (cap.allowedRoles.length > 0 && !cap.allowedRoles.some(role => role === 'agent' || role === 'edit')) return false;
  if (minContext > 0 && cap.contextWindow > 0 && cap.contextWindow < minContext) return false;
  return true;
}

export function selectRecoveryModel(input: {
  cause: FailureCause;
  current: { provider?: string; model?: string };
  /** `provider/model` keys already attempted on this task. */
  attempted: readonly string[];
  candidates: readonly RecoveryCandidate[];
  policy: RecoveryModelPolicy;
  minContext?: number;
}): ModelChoice {
  if (!MODEL_SHAPED.has(input.cause)) {
    return { kind: 'none', reason: 'not_model_shaped', detail: `${input.cause} is not solved by changing the model` };
  }
  if (input.policy.pinned && !input.policy.fallbackAllowedWhenPinned) {
    return { kind: 'none', reason: 'pinned_no_fallback', detail: 'the user pinned this model and did not permit fallback' };
  }
  if (input.candidates.length === 0) {
    return { kind: 'none', reason: 'no_candidate_pool', detail: 'no alternative model candidates are known' };
  }
  const attempted = new Set(input.attempted);
  const currentKey = `${input.current.provider ?? 'unknown'}/${input.current.model ?? 'unknown'}`;
  const currentStrength = input.candidates.find(candidate => `${candidate.provider}/${candidate.model}` === currentKey)?.strength;
  const eligible = input.candidates.filter(candidate => {
    const key = `${candidate.provider}/${candidate.model}`;
    if (key === currentKey || attempted.has(key)) return false;
    if (!isCapableForRecovery(candidate, input.minContext)) return false;
    if (!candidate.local && !input.policy.cloudAuthorized) return false; // default deny
    if (!candidate.local && input.policy.pinned) return false;
    if (
      NEEDS_STRONGER.has(input.cause)
      && currentStrength !== undefined
      && candidate.strength !== undefined
      && candidate.strength < currentStrength
    ) return false;
    return true;
  });
  // Local first; within a tier keep the caller's (Core-ordered) preference order.
  const chosen = eligible.find(candidate => candidate.local) ?? eligible[0];
  if (!chosen) {
    return { kind: 'none', reason: 'no_capable_untried_model', detail: 'every permitted capable model has already been attempted' };
  }
  return {
    kind: 'model',
    provider: chosen.provider,
    model: chosen.model,
    local: chosen.local,
    reason: chosen.local ? 'next permitted local model' : 'explicitly authorised cloud route',
  };
}

/** Best-effort strength hint from a parameter-count token; the name is never used for capability. */
export function strengthFromParameterCount(billions: number | undefined): number | undefined {
  return typeof billions === 'number' && Number.isFinite(billions) && billions > 0 ? billions : undefined;
}
