import { ProviderType } from '../providers/ProviderTypes';
import { ProviderResponseFormat } from '../providers/ProviderTypes';
import { ForgeInvocationAuditMetadata } from './AgentEngineTypes';

/**
 * M4.1 contract: the smallest provider-independent boundary for exactly one
 * governed model request and one governed model result. No model is invoked
 * by this contract — it only defines the shape a future execution seam must
 * produce and consume.
 */
export const GOVERNED_MODEL_CONTRACT_VERSION = 1 as const;

export const GOVERNED_MODEL_FAILURE_CODES = [
  'model_unavailable',
  'timeout',
  'provider_failure',
  'cancelled',
  'invalid_model_response',
  'execution_rejected',
] as const;

export type GovernedModelFailureCode = typeof GOVERNED_MODEL_FAILURE_CODES[number];

/**
 * Sanitized, enum-only sub-reason for `failureCode: 'invalid_model_response'`
 * — never raw response/prompt/completion text. Distinguishes the three
 * distinct rejection branches in `ProviderGatewayGovernedModelExecutionDependency`
 * (response not marked done, an unexpected tool call for a tool-free governed
 * call, or empty/non-string completion text) so durable evidence (e.g. a
 * `validation_repair_unavailable` execution-quality event) can record *which*
 * one occurred without ever persisting the response itself.
 */
export const GOVERNED_MODEL_INVALID_RESPONSE_REASONS = [
  'not_done',
  'unexpected_tool_call',
  'empty_content',
] as const;

export type GovernedModelInvalidResponseReason = typeof GOVERNED_MODEL_INVALID_RESPONSE_REASONS[number];

export type GovernedModelExecutionStatus = 'completed' | 'failed' | 'cancelled';

/**
 * M42 routing evidence: which model/provider was *attempted* first and which
 * one actually executed the stage, plus the enum-only reason a cloud fallback
 * was or was not taken. Attached by `LocalFirstModelDispatchRouter`, never by
 * the dispatcher itself, and never containing prompt/completion text.
 *
 * This is additive and optional: `verifyGovernedModelResultCompliance` does
 * not read it, so governance semantics are unchanged. Its purpose is that a
 * cloud-completed stage can never be reported as a local success.
 */
export interface ModelRoutingEvidence {
  /** Whether the routed model came from automatic selection or a user override. */
  selection: 'automatic' | 'explicit_override';
  /** Model/provider the router tried first (always the local route). */
  attemptedModel: string;
  attemptedProviderType?: ProviderType;
  /** Model/provider that produced the result being reported. */
  executedModel: string;
  executedProviderType?: ProviderType;
  /** True only when a cloud fallback actually executed this request. */
  fallbackUsed: boolean;
  /** Enum-only routing decision (see LocalFirstModelRouting). */
  fallbackDecision: string;
  /** Sanitized failure code/reason of the local attempt, when it failed. */
  localFailureCode?: GovernedModelFailureCode;
  localFailureReason?: string;
}

/**
 * Exactly one text prompt for exactly one model call. Deliberately excludes
 * tools, planning state, provider-specific payloads and any retry/lifecycle
 * fields — those remain out of scope until later M4 phases.
 */
export interface GovernedModelRequest {
  contractVersion: typeof GOVERNED_MODEL_CONTRACT_VERSION;
  requestId: string;
  invocationId: string;
  taskId: string;
  model: string;
  providerType?: ProviderType;
  prompt: string;
  /** Optional provider-neutral structured output constraint. Never persisted in evidence. */
  responseFormat?: ProviderResponseFormat;
  /** Cancellation via the repository's existing AbortSignal convention (see InferenceProvider). */
  signal?: AbortSignal;
  audit?: ForgeInvocationAuditMetadata;
  /** Original repository root used for resource-scoped configuration when execution occurs in a temp worktree. */
  configWorkspaceRoot?: string;
  /** Explicit request to disable a model's native thinking/reasoning for this governed request. */
  nativeThinking?: false;
}

/** Exactly one text completion, or deterministic failure information when none was produced. */
export interface GovernedModelResult {
  contractVersion: typeof GOVERNED_MODEL_CONTRACT_VERSION;
  requestId: string;
  invocationId: string;
  taskId: string;
  model: string;
  providerType?: ProviderType;
  status: GovernedModelExecutionStatus;
  completion?: string;
  failureCode?: GovernedModelFailureCode;
  failureReason?: string;
  /** Sanitized sub-reason, set only when failureCode is 'invalid_model_response'. */
  invalidResponseReason?: GovernedModelInvalidResponseReason;
  /** M42 local-first routing evidence, present only when a router wrapped this dispatch. */
  routing?: ModelRoutingEvidence;
  evidence: ModelExecutionEvidence;
  audit?: ForgeInvocationAuditMetadata;
}

/**
 * Non-raw context evidence for one governed model dispatch: the shared M11
 * preflight's limit resolution, projected usage and structured-output
 * decision. Numbers and enums only — never prompt or completion text.
 */
export interface GovernedContextEvidence {
  profileId: string;
  effectiveContextLimit: number;
  provenance: string;
  estimated: boolean;
  fallback: boolean;
  contentTokens: number;
  projectedTotalTokens: number;
  outputReserveTokens: number;
  percentUsed: number;
  status: string;
  structuredOutput: {
    requested: boolean;
    supported: boolean;
    active: boolean;
    deferredReason?: string;
  };
  /** Effective timeout sent to the provider request, in milliseconds. */
  providerRequestTimeoutMs?: number;
  /** Component that owns the effective request timer. */
  timeoutOwner?: string;
  /** Provider resolved for the request when available, including failed calls. */
  providerType?: ProviderType;
  /**
   * Adaptive contract enforcement: set when the dispatch changed its own decoding for one retry and why, e.g.
   * `disable_thinking:empty_completion` (a reasoning model spent the whole output budget thinking and returned no text).
   */
  adaptation?: string;
}

/**
 * Non-raw evidence of a single model execution attempt. Intentionally never
 * carries the prompt or completion text — only identity, timing, usage and
 * outcome metadata suitable for internal evidence/audit trails.
 */
export interface ModelExecutionEvidence {
  contractVersion: typeof GOVERNED_MODEL_CONTRACT_VERSION;
  requestId: string;
  invocationId: string;
  taskId: string;
  model: string;
  providerType?: ProviderType;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  /** Safe input-size metadata (character count of the dispatched prompt), never the prompt text itself. */
  promptCharacterCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  status: GovernedModelExecutionStatus;
  failureCode?: GovernedModelFailureCode;
  failureReason?: string;
  /** Shared M11 preflight evidence (never raw prompt text). */
  context?: GovernedContextEvidence;
  /** M42 local-first routing evidence, present only when a router wrapped this dispatch. */
  routing?: ModelRoutingEvidence;
  audit?: ForgeInvocationAuditMetadata;
}

export function isGovernedModelFailureCode(value: unknown): value is GovernedModelFailureCode {
  return typeof value === 'string' && (GOVERNED_MODEL_FAILURE_CODES as readonly string[]).includes(value);
}

/**
 * M4.7 contract-compliance verification: the deterministic set of ways a
 * `GovernedModelResult` (and the `ModelExecutionEvidence` it carries) can
 * disagree with the request that produced it, or with itself. Used to reject
 * a malformed or self-contradictory result before it becomes terminal or
 * retrievable, instead of trusting an execution dependency's raw output.
 */
export const GOVERNED_MODEL_RESULT_COMPLIANCE_VIOLATIONS = [
  'contract_version_mismatch',
  'request_id_mismatch',
  'invocation_id_mismatch',
  'task_id_mismatch',
  'model_mismatch',
  'provider_mismatch',
  'invalid_status',
  'missing_completion_for_completed_status',
  'unexpected_completion_for_non_completed_status',
  'missing_failure_code_for_non_completed_status',
  'unexpected_failure_code_for_completed_status',
  'evidence_identity_mismatch',
  'evidence_status_mismatch',
  'evidence_provider_mismatch',
  'evidence_failure_code_mismatch',
  'evidence_failure_reason_mismatch',
  'completed_evidence_with_failure_metadata',
  'failed_evidence_missing_failure_code',
  'invalid_timestamps',
  'invalid_duration',
  'invalid_token_count',
] as const;

export type GovernedModelResultComplianceViolation = typeof GOVERNED_MODEL_RESULT_COMPLIANCE_VIOLATIONS[number];

export interface GovernedModelResultComplianceReport {
  compliant: boolean;
  violations: GovernedModelResultComplianceViolation[];
}

/**
 * Pure, dependency-free verification of a `GovernedModelResult` against the
 * `GovernedModelRequest` that produced it. Never inspects prompt/completion
 * text content and never mutates either argument. Intended to run once, at
 * the seam where a result becomes terminal, before it is returned or
 * persisted for later retrieval.
 */
export function verifyGovernedModelResultCompliance(
  request: GovernedModelRequest,
  result: GovernedModelResult,
): GovernedModelResultComplianceReport {
  const violations: GovernedModelResultComplianceViolation[] = [];
  const evidence = result.evidence;

  if (result.contractVersion !== GOVERNED_MODEL_CONTRACT_VERSION || evidence.contractVersion !== GOVERNED_MODEL_CONTRACT_VERSION) {
    violations.push('contract_version_mismatch');
  }
  if (result.requestId !== request.requestId) {
    violations.push('request_id_mismatch');
  }
  if (result.invocationId !== request.invocationId) {
    violations.push('invocation_id_mismatch');
  }
  if (result.taskId !== request.taskId) {
    violations.push('task_id_mismatch');
  }
  if (result.model !== request.model) {
    violations.push('model_mismatch');
  }
  if (request.providerType !== undefined && result.providerType !== undefined && request.providerType !== result.providerType) {
    violations.push('provider_mismatch');
  }

  const validStatus: readonly GovernedModelExecutionStatus[] = ['completed', 'failed', 'cancelled'];
  if (!validStatus.includes(result.status)) {
    violations.push('invalid_status');
  } else if (result.status === 'completed') {
    if (typeof result.completion !== 'string') {
      violations.push('missing_completion_for_completed_status');
    }
    if (result.failureCode !== undefined) {
      violations.push('unexpected_failure_code_for_completed_status');
    }
  } else {
    if (result.completion !== undefined) {
      violations.push('unexpected_completion_for_non_completed_status');
    }
    if (result.failureCode === undefined) {
      violations.push('missing_failure_code_for_non_completed_status');
    }
  }

  if (
    evidence.requestId !== result.requestId ||
    evidence.invocationId !== result.invocationId ||
    evidence.taskId !== result.taskId ||
    evidence.model !== result.model
  ) {
    violations.push('evidence_identity_mismatch');
  }
  if (evidence.status !== result.status) {
    violations.push('evidence_status_mismatch');
  }
  if (evidence.providerType !== undefined && result.providerType !== undefined && evidence.providerType !== result.providerType) {
    violations.push('evidence_provider_mismatch');
  }
  if (evidence.failureCode !== result.failureCode) {
    violations.push('evidence_failure_code_mismatch');
  }
  if (evidence.failureReason !== result.failureReason) {
    violations.push('evidence_failure_reason_mismatch');
  }
  if (evidence.status === 'completed' && (evidence.failureCode !== undefined || evidence.failureReason !== undefined)) {
    violations.push('completed_evidence_with_failure_metadata');
  }
  if (evidence.status !== 'completed' && evidence.failureCode === undefined) {
    violations.push('failed_evidence_missing_failure_code');
  }

  const startedAtMs = Date.parse(evidence.startedAt);
  const completedAtMs = evidence.completedAt !== undefined ? Date.parse(evidence.completedAt) : undefined;
  if (!Number.isFinite(startedAtMs) || (completedAtMs !== undefined && (!Number.isFinite(completedAtMs) || completedAtMs < startedAtMs))) {
    violations.push('invalid_timestamps');
  }
  if (evidence.durationMs !== undefined && (!Number.isFinite(evidence.durationMs) || evidence.durationMs < 0)) {
    violations.push('invalid_duration');
  }
  if (!isValidOptionalTokenCount(evidence.inputTokens) || !isValidOptionalTokenCount(evidence.outputTokens)) {
    violations.push('invalid_token_count');
  }

  return { compliant: violations.length === 0, violations };
}

function isValidOptionalTokenCount(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 0);
}

export function validateGovernedModelRequest(
  request: GovernedModelRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];

  if (request.contractVersion !== GOVERNED_MODEL_CONTRACT_VERSION) {
    errors.push('contractVersion must be 1');
  }
  if (!isNonEmptyString(request.requestId)) {
    errors.push('requestId must be a non-empty string');
  }
  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(request.model)) {
    errors.push('model must be a non-empty string');
  }
  if (typeof request.prompt !== 'string') {
    errors.push('prompt must be a string');
  }

  return { accepted: errors.length === 0, errors };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
