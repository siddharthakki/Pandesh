import { ProviderType } from '../providers/ProviderTypes';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GovernedContextEvidence,
  GovernedModelExecutionStatus,
  GovernedModelFailureCode,
  GovernedModelInvalidResponseReason,
  GovernedModelRequest,
  GovernedModelResult,
  ModelExecutionEvidence,
  isGovernedModelFailureCode,
  validateGovernedModelRequest,
  verifyGovernedModelResultCompliance,
} from './GovernedModelExecutionTypes';

/**
 * The result of exactly one future model invocation. Deliberately excludes
 * tools, planning, retries, message histories, streaming and provider wire
 * types — only the minimal shape the dispatcher needs to normalize.
 * `providerType` is the identity of the provider actually resolved and
 * invoked by the dependency; it is never taken from caller/request input.
 */
export interface GovernedModelExecutionOutcome {
  completion: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  providerType?: ProviderType;
  /** Shared M11 preflight evidence produced by the dependency (never raw prompt text). */
  contextEvidence?: GovernedContextEvidence;
}

/**
 * The injected dependency representing exactly one provider-independent
 * model invocation. Implementations own provider selection, wire formats and
 * cancellation handling for the AbortSignal carried on the request.
 */
export interface GovernedModelExecutionDependency {
  execute(request: GovernedModelRequest): Promise<GovernedModelExecutionOutcome>;
}

/**
 * Optional tag a dependency may throw to request deterministic failure
 * normalization instead of the default `provider_failure` fallback.
 */
export interface GovernedModelExecutionDependencyError extends Error {
  failureCode?: GovernedModelFailureCode;
  /** Optional shared-preflight evidence attached to a deterministic rejection (e.g. context block). */
  contextEvidence?: GovernedContextEvidence;
  /** Sanitized sub-reason, set only alongside failureCode 'invalid_model_response'. */
  invalidResponseReason?: GovernedModelInvalidResponseReason;
}

function hasFailureCode(error: unknown): error is GovernedModelExecutionDependencyError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'failureCode' in error &&
    isGovernedModelFailureCode((error as { failureCode?: unknown }).failureCode)
  );
}

/**
 * Deterministic, sanitized evidence text keyed by failure code — never the
 * thrown exception's own message. Provider exception text may embed prompt
 * fragments, completion fragments, credentials, endpoint details, response
 * bodies or filesystem paths, none of which are safe to persist or return in
 * `ModelExecutionEvidence`.
 */
const SANITIZED_FAILURE_REASONS: Record<GovernedModelFailureCode, string> = {
  model_unavailable: 'The requested governed model was unavailable.',
  timeout: 'The governed model provider did not respond within the allotted time.',
  provider_failure: 'The governed model provider failed during execution.',
  cancelled: 'The governed model call was cancelled before completion.',
  invalid_model_response: 'The governed model provider returned an invalid response.',
  execution_rejected: 'The governed model request was rejected before execution.',
};

/**
 * Provider-independent dispatcher boundary for exactly one governed model
 * execution. Validates the request, delegates to the injected
 * `GovernedModelExecutionDependency` at most once, and normalizes the
 * outcome into a `GovernedModelResult`. Holds no tools, planning, retries,
 * message histories or provider-specific request bodies, and never persists
 * raw prompt or completion text in evidence. Failure evidence also never
 * carries a thrown exception's own message — see `SANITIZED_FAILURE_REASONS`.
 */
export class GovernedModelExecutionDispatcher {
  constructor(
    private readonly dependency: GovernedModelExecutionDependency,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    const startedAt = this.now();
    const validation = validateGovernedModelRequest(request);

    if (!validation.accepted) {
      return this.buildResult(request, {
        startedAt,
        completedAt: this.now(),
        status: 'failed',
        failureCode: 'execution_rejected',
        failureReason: `Request rejected before delegation: ${validation.errors.join('; ')}`,
      });
    }

    if (request.signal?.aborted) {
      return this.buildResult(request, {
        startedAt,
        completedAt: this.now(),
        status: 'cancelled',
        failureCode: 'cancelled',
        failureReason: 'Request was already cancelled before delegation.',
      });
    }

    let outcome: GovernedModelExecutionOutcome;
    try {
      outcome = await this.dependency.execute(request);
    } catch (error) {
      const completedAt = this.now();

      if (request.signal?.aborted) {
        return this.buildResult(request, {
          startedAt,
          completedAt,
          status: 'cancelled',
          failureCode: 'cancelled',
          failureReason: 'Cancelled via the existing AbortSignal cancellation convention.',
        });
      }

      // The thrown error's own message is deliberately never read here — see
      // SANITIZED_FAILURE_REASONS above.
      const failureCode = hasFailureCode(error) ? error.failureCode! : 'provider_failure';
      const context = hasFailureCode(error) ? error.contextEvidence : undefined;
      const providerType = (context?.providerType as ProviderType | undefined) ?? request.providerType;
      return this.buildResult(request, {
        startedAt,
        completedAt,
        status: 'failed',
        failureCode,
        failureReason: SANITIZED_FAILURE_REASONS[failureCode],
        context,
        invalidResponseReason: hasFailureCode(error) ? error.invalidResponseReason : undefined,
        providerType,
      });
    }

    const completedAt = this.now();

    // Cancellation is cooperative at the provider boundary. A provider may
    // ignore AbortSignal and still resolve successfully after cancellation;
    // that late completion must never win the race or escape to the caller.
    if (request.signal?.aborted) {
      return this.buildResult(request, {
        startedAt,
        completedAt,
        status: 'cancelled',
        failureCode: 'cancelled',
        failureReason: 'Cancelled via the existing AbortSignal cancellation convention.',
      });
    }

    if (typeof outcome.completion !== 'string') {
      return this.buildResult(request, {
        startedAt,
        completedAt,
        status: 'failed',
        failureCode: 'invalid_model_response',
        failureReason: 'Execution dependency returned a non-string completion.',
        providerType: outcome.providerType ?? request.providerType,
        context: outcome.contextEvidence,
      });
    }

    return this.buildResult(request, {
      startedAt,
      completedAt,
      status: 'completed',
      completion: outcome.completion,
      finishReason: outcome.finishReason,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      providerType: outcome.providerType,
      context: outcome.contextEvidence,
    });
  }

  private buildResult(
    request: GovernedModelRequest,
    outcome: {
      startedAt: string;
      completedAt: string;
      status: GovernedModelExecutionStatus;
      completion?: string;
      finishReason?: string;
      inputTokens?: number;
      outputTokens?: number;
      providerType?: ProviderType;
      failureCode?: GovernedModelFailureCode;
      failureReason?: string;
      invalidResponseReason?: GovernedModelInvalidResponseReason;
      context?: GovernedContextEvidence;
    },
  ): GovernedModelResult {
    const durationMs = Date.parse(outcome.completedAt) - Date.parse(outcome.startedAt);

    const resolvedProviderType = outcome.providerType ?? request.providerType;

    // providerType reflects the provider actually resolved/invoked (reported
    // by the dependency via the outcome), falling back to request.providerType
    // when execution failed before completion.
    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: request.requestId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      providerType: resolvedProviderType,
      startedAt: outcome.startedAt,
      completedAt: outcome.completedAt,
      durationMs,
      promptCharacterCount: typeof request.prompt === 'string' ? request.prompt.length : undefined,
      inputTokens: outcome.inputTokens,
      outputTokens: outcome.outputTokens,
      finishReason: outcome.finishReason,
      status: outcome.status,
      failureCode: outcome.failureCode,
      failureReason: outcome.failureReason,
      context: outcome.context,
      audit: request.audit,
    };

    const result: GovernedModelResult = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: request.requestId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      providerType: resolvedProviderType,
      status: outcome.status,
      completion: outcome.completion,
      failureCode: outcome.failureCode,
      failureReason: outcome.failureReason,
      invalidResponseReason: outcome.invalidResponseReason,
      evidence,
      audit: request.audit,
    };

    // M4.8: this is the single seam every dispatched result passes through -
    // including the dispatcher's own deterministic rejection/cancellation
    // results - so verifying here guarantees no result becomes terminal or
    // retrievable without passing contract-compliance verification. A
    // non-compliant result (e.g. a malformed execution dependency returning
    // invalid token counts or a mismatched provider) is discarded in favor of
    // a safe, normalized failure rather than propagated. The fallback does
    // not reuse outcome.startedAt/outcome.completedAt - a malformed result
    // may be malformed precisely because those timestamps are invalid, so
    // the fallback sources its own timing fresh from the dispatcher's clock.
    const compliance = verifyGovernedModelResultCompliance(request, result);
    if (!compliance.compliant) {
      return this.buildComplianceFailureResult(request);
    }

    return result;
  }

  /**
   * A minimal, self-evidently compliant fallback result: every identity
   * field is taken directly from the request, timing is sourced fresh from
   * the dispatcher's own clock (never from the outcome/result under
   * rejection, which may itself carry the invalid timestamps that caused
   * rejection), there is no completion, and the failure code/reason are the
   * fixed, sanitized `invalid_model_response` pair. Never re-verified (and
   * never recurses, never calls the dependency again) because its shape is
   * compliant by construction: a single trusted timestamp used for both
   * `startedAt` and `completedAt` yields a valid, non-decreasing pair and a
   * `durationMs` of exactly 0.
   */
  private buildComplianceFailureResult(request: GovernedModelRequest): GovernedModelResult {
    const timestamp = this.now();
    const failureReason = SANITIZED_FAILURE_REASONS.invalid_model_response;

    const evidence: ModelExecutionEvidence = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: request.requestId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      startedAt: timestamp,
      completedAt: timestamp,
      durationMs: 0,
      promptCharacterCount: typeof request.prompt === 'string' ? request.prompt.length : undefined,
      status: 'failed',
      failureCode: 'invalid_model_response',
      failureReason,
      audit: request.audit,
    };

    return {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: request.requestId,
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      status: 'failed',
      failureCode: 'invalid_model_response',
      failureReason,
      evidence,
      audit: request.audit,
    };
  }
}
