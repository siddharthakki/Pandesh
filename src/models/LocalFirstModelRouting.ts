import type { GovernedModelExecutionStatus, GovernedModelFailureCode } from '../agent/GovernedModelExecutionTypes';

/**
 * M42 local-first model routing policy — pure, dependency-free decision
 * logic for whether one already-failed local governed model execution may be
 * retried once against an explicitly permitted cloud endpoint.
 *
 * This module never performs I/O, never reads configuration and never sees
 * prompt/completion text. It only maps the deterministic failure taxonomy
 * already produced by `GovernedModelExecutionDispatcher` onto a single
 * bounded routing decision.
 */

/**
 * Local failure codes that describe a provider/runtime problem rather than
 * anything the model actually produced, a user decision, or a governance
 * decision. Only these may route to a cloud fallback.
 *
 * - `provider_failure`        — connection/auth/HTTP failure at the provider.
 * - `timeout`                 — the local provider produced no usable response
 *                               within the configured request deadline. This
 *                               deliberately includes a cold-model load that
 *                               never reached first token; see the cold-start
 *                               note in `ProviderGatewayGovernedModelExecutionDependency`.
 * - `model_unavailable`       — the requested local model is not present/loaded.
 * - `invalid_model_response`  — the provider returned a structurally unusable
 *                               response (not done / unexpected tool call /
 *                               empty content), or a non-compliant result. This
 *                               is a runtime malformation, never a rejection of
 *                               generated code.
 */
export const RECOVERABLE_LOCAL_FAILURE_CODES: readonly GovernedModelFailureCode[] = [
  'provider_failure',
  'timeout',
  'model_unavailable',
  'invalid_model_response',
];

/**
 * Failure codes that must never route to cloud.
 *
 * - `cancelled`          — the user (or an upstream orchestrator) cancelled.
 * - `execution_rejected` — a governance/policy/context-budget/malformed-request
 *                          rejection made before the provider was ever invoked.
 *
 * Every other non-fallback case named by the milestone (validation failure
 * from generated code, rejected proposal, stale workspace baseline, approval
 * rejection, deterministic proposal/contract errors) is structurally
 * unreachable here: those all occur *downstream* of a `completed` governed
 * model result, and this router only ever considers a non-completed one.
 */
export const NON_RECOVERABLE_LOCAL_FAILURE_CODES: readonly GovernedModelFailureCode[] = [
  'cancelled',
  'execution_rejected',
];

export function isRecoverableLocalFailure(failureCode: GovernedModelFailureCode | undefined): boolean {
  return failureCode !== undefined && RECOVERABLE_LOCAL_FAILURE_CODES.includes(failureCode);
}

/** Why a cloud fallback was or was not taken. Enum only — never free text. */
export type CloudFallbackDecision =
  | 'used'
  | 'loop_level_used'
  | 'local_succeeded'
  | 'explicit_model_override'
  | 'failure_not_recoverable'
  | 'already_attempted'
  | 'cloud_fallback_not_permitted';

/** Why the investigation loop may spend its single cloud escalation. */
export type LoopLevelCloudEscalationReason =
  | 'investigation_exhausted'
  | 'persistent_unusable_output';

export interface CloudFallbackPolicyInput {
  /** Status of the local governed model result. */
  localStatus: GovernedModelExecutionStatus;
  /** Failure code of the local governed model result, when it did not complete. */
  localFailureCode?: GovernedModelFailureCode;
  /**
   * False when the user explicitly chose this model. An explicit override is
   * authoritative and is never silently replaced by another model/provider.
   */
  automaticSelection: boolean;
  /** True once this task has already spent its single fallback attempt. */
  fallbackAlreadyAttempted: boolean;
  /**
   * True only when the user's routing policy permits cloud fallback AND a
   * complete cloud route (endpoint + model + credential) is configured.
   * Resolving this must never send repository/task context anywhere.
   */
  cloudFallbackPermittedAndConfigured: boolean;
}

/**
 * Decides whether exactly one cloud fallback attempt is allowed. Ordering is
 * deliberate: local success short-circuits first (cloud is never called when
 * local succeeded), then user authority, then the failure taxonomy, then the
 * loop bound, and only last the permission/configuration check.
 */
export function decideCloudFallback(input: CloudFallbackPolicyInput): CloudFallbackDecision {
  if (input.localStatus === 'completed') return 'local_succeeded';
  if (!input.automaticSelection) return 'explicit_model_override';
  if (!isRecoverableLocalFailure(input.localFailureCode)) return 'failure_not_recoverable';
  if (input.fallbackAlreadyAttempted) return 'already_attempted';
  if (!input.cloudFallbackPermittedAndConfigured) return 'cloud_fallback_not_permitted';
  return 'used';
}

export interface LoopLevelCloudPolicyInput {
  reason: LoopLevelCloudEscalationReason;
  /** True once this task has already spent its single cloud attempt (per-call or loop-level). */
  fallbackAlreadyAttempted: boolean;
  cloudFallbackPermittedAndConfigured: boolean;
  /**
   * Local failure code of the dispatch that triggered escalation, when one exists.
   * Cancellation and governance rejection never escalate.
   */
  localFailureCode?: GovernedModelFailureCode;
}

/**
 * Loop-level cloud recovery for the pre-proposal investigation loop.
 *
 * Distinct from per-call `decideCloudFallback`: an explicit local primary is
 * the starting model, not a prohibition, when the authorized routing policy
 * is local-first-cloud-fallback and the loop exhausted investigation or
 * received persistent unusable output. Still fails closed for cancellation,
 * governance rejection, a spent one-shot, or a local-only/unconfigured route.
 */
export function decideLoopLevelCloudEscalation(input: LoopLevelCloudPolicyInput): CloudFallbackDecision {
  if (input.localFailureCode === 'cancelled' || input.localFailureCode === 'execution_rejected') {
    return 'failure_not_recoverable';
  }
  if (input.fallbackAlreadyAttempted) return 'already_attempted';
  if (!input.cloudFallbackPermittedAndConfigured) return 'cloud_fallback_not_permitted';
  if (input.reason !== 'investigation_exhausted' && input.reason !== 'persistent_unusable_output') {
    return 'failure_not_recoverable';
  }
  return 'loop_level_used';
}
