import type { FailureCause } from '../autonomous/recovery/RecoveryTypes';

/**
 * The five failure classes KKD reports. They answer one question: whose fault was it, and therefore what may
 * recovery do? They are never collapsed into a generic "model failed".
 *
 *   model_reasoning_failure     a usable reply that was wrong (validation, semantics, grounding, no progress).
 *                               The only class that counts toward the failed-hypothesis window.
 *   contract_protocol_failure   the reply could not be used as the contract requires (not JSON, wrong keys, empty).
 *   provider_failure            the runtime did not deliver: timeout, stall, 5xx, unreachable, model unloaded.
 *   context_admission_failure   the request did not fit the runtime's real envelope and could not be made to.
 *   policy_environment_failure  a governance boundary or the workspace/environment stopped the work.
 */
export const FAILURE_CLASSES = [
  'model_reasoning_failure',
  'contract_protocol_failure',
  'provider_failure',
  'context_admission_failure',
  'policy_environment_failure',
] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];

const BY_CAUSE: Record<FailureCause, FailureClass> = {
  format_failure: 'contract_protocol_failure',
  grounding_failure: 'model_reasoning_failure',
  semantic_failure: 'model_reasoning_failure',
  validation_failure: 'model_reasoning_failure',
  no_progress: 'model_reasoning_failure',
  provider_failure: 'provider_failure',
  environment_failure: 'policy_environment_failure',
  policy_boundary: 'policy_environment_failure',
};

export function classifyFailureCause(cause: FailureCause): FailureClass {
  return BY_CAUSE[cause];
}

/** Only this class may count toward a failed-hypothesis window; every other class says nothing about the idea. */
export function countsAsReasoningFailure(failureClass: FailureClass): boolean {
  return failureClass === 'model_reasoning_failure';
}

/** Governed dispatch failure codes (`GovernedModelFailureCode`) mapped to the same five classes. */
export function classifyGovernedFailure(code: string, invalidResponseReason?: string): FailureClass {
  switch (code) {
    case 'execution_rejected':
      return 'context_admission_failure';
    case 'invalid_model_response':
      // An empty or non-final completion is the runtime returning nothing usable; the reply itself is the contract failure.
      return invalidResponseReason === 'not_done' ? 'provider_failure' : 'contract_protocol_failure';
    case 'cancelled':
      return 'policy_environment_failure';
    case 'timeout':
    case 'provider_failure':
    case 'model_unavailable':
    default:
      return 'provider_failure';
  }
}
