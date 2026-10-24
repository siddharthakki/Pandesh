import { GovernedModelExecutionDispatcher } from './GovernedModelExecutionDispatcher';
import type { GovernedModelRequest, GovernedModelResult } from './GovernedModelExecutionTypes';

/**
 * The subset of CoreClient this recorder needs. Kept narrow and structural so
 * unit tests can supply a fake without spinning up a real Core process, and so
 * this module never imports `vscode` (it must be usable from Core-safe adapter
 * code per docs/m32-architecture.md's Core-safe-adapter classification).
 */
export interface ModelTruthSink {
  startModelInvocation(attemptId: string, input: {
    requestedProvider?: string | null;
    requestedModel?: string | null;
    policyProvider?: string | null;
    policyModel?: string | null;
  }): Promise<{ id: string }>;
  completeModelInvocation(id: string, input: {
    status: 'succeeded' | 'failed' | 'cancelled';
    actualProvider?: string | null;
    actualModel?: string | null;
    fallbackUsed?: boolean;
    fallbackReason?: string | null;
    usageMetadata?: Record<string, unknown>;
  }): Promise<unknown>;
}

function statusFor(result: GovernedModelResult): 'succeeded' | 'failed' | 'cancelled' {
  if (result.status === 'completed') return 'succeeded';
  if (result.status === 'cancelled') return 'cancelled';
  return 'failed';
}

/**
 * Wraps a GovernedModelExecutionDispatcher so every dispatch() call is
 * recorded in the Core as a model_invocations row — requested provider/model
 * captured before the call, actual provider/status/failure captured after.
 * This is additive instrumentation only: it never alters the dispatched
 * request or the returned GovernedModelResult, so it can be layered onto any
 * existing dispatch call site (Baat Kar, Saath Kar, Karke Dikha) without
 * changing dispatcher behavior or its compliance-verified output shape.
 *
 * Note on fallback detection: `GovernedModelExecutionDispatcher`'s own
 * compliance verification (`verifyGovernedModelResultCompliance`) already
 * refuses to let a provider mismatch surface as a *successful* result — a
 * dependency that reports a different provider than was explicitly requested
 * is converted to a compliance failure (`invalid_model_response`) before this
 * recorder ever sees a "success" (verified in
 * coreModelTruthRecorder.test.ts). Consequently `fallbackUsed` computed below
 * is structurally unreachable as `true` through this exact seam today — it is
 * kept as forward-compatible instrumentation for call sites that leave
 * `request.providerType` unset and want the resolved provider recorded
 * without it being misread as silent substitution.
 */
export class CoreModelTruthRecorder {
  constructor(
    private readonly dispatcher: GovernedModelExecutionDispatcher,
    private readonly sink: ModelTruthSink,
    private readonly attemptId: string,
  ) {}

  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    const invocation = await this.sink.startModelInvocation(this.attemptId, {
      requestedProvider: request.providerType ?? null,
      requestedModel: request.model ?? null,
    });

    const result = await this.dispatcher.dispatch(request);

    const fallbackUsed = Boolean(request.providerType && result.providerType && request.providerType !== result.providerType);

    await this.sink.completeModelInvocation(invocation.id, {
      status: statusFor(result),
      actualProvider: result.providerType ?? null,
      actualModel: result.model ?? null,
      fallbackUsed,
      fallbackReason: fallbackUsed
        ? `provider changed from requested '${request.providerType}' to actual '${result.providerType}'`
        : null,
      usageMetadata: {
        inputTokens: result.evidence.inputTokens ?? null,
        outputTokens: result.evidence.outputTokens ?? null,
        durationMs: result.evidence.durationMs ?? null,
      },
    });

    return result;
  }
}
