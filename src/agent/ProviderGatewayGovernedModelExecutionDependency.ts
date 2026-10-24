import type * as vscode from 'vscode';
import { ProviderGateway } from '../providers/ProviderGateway';
import {
  InferenceProvider,
  ProviderApiError,
  ProviderAuthError,
  ProviderCancelledError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from '../providers/ProviderTypes';
import { ChatMessage } from '../tools/ToolTypes';
import { ContextPreflightResult } from '../reliability/ContextBudget';
import { ModelDispatchPlanner } from '../reliability/ModelDispatchPlanner';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDependencyError,
  GovernedModelExecutionOutcome,
} from './GovernedModelExecutionDispatcher';
import { adaptiveSchemaEnabled } from '../reliability/ContractEnforcement';
import { describeAdmission, recompileForAdmission } from '../reliability/AdmissionRecovery';
import {
  ProviderHealthController,
  ProviderHealthError,
  ProviderHealthEvent,
  describeProviderHealth,
} from '../reliability/ProviderHealthController';
import { RuntimeIntelligence } from '../runtimeProfile/RuntimeIntelligence';
import { GovernedContextEvidence, GovernedModelInvalidResponseReason, GovernedModelRequest } from './GovernedModelExecutionTypes';
import {
  M19AgentWorkforceRouter,
  createConfiguredM19AgentWorkforceRouter,
} from '../workforce/M19AgentWorkforce';

/**
 * Production `GovernedModelExecutionDependency`: adapts the repository's
 * existing provider-independent `InferenceProvider.chat` abstraction
 * (resolved through `ProviderGateway`, exactly like `AgentLoop` does) into
 * exactly one text completion. Holds no tool definitions, no message
 * history, no retries and no concrete provider import — provider selection
 * remains entirely inside `ProviderGateway`.
 *
 * `InferenceProvider.chat` returns only `{ message, done }`; no token usage
 * or finish-reason data is available from the canonical abstraction, so
 * `inputTokens`, `outputTokens` and `finishReason` are always omitted here.
 */
export class ProviderGatewayGovernedModelExecutionDependency implements GovernedModelExecutionDependency {
  static forSecrets(secrets: vscode.SecretStorage): ProviderGatewayGovernedModelExecutionDependency {
    return new ProviderGatewayGovernedModelExecutionDependency(
      () => ProviderGateway.create(secrets),
      createConfiguredM19AgentWorkforceRouter(),
    );
  }

  constructor(
    private readonly resolveProvider: () => Promise<InferenceProvider>,
    private readonly workforce?: M19AgentWorkforceRouter,
  ) {}

  async execute(request: GovernedModelRequest): Promise<GovernedModelExecutionOutcomeWithContext> {
    // M19 routes only fixed-graph stage request IDs. Non-workforce governed calls
    // pass through unchanged. The routed model and content-free handoff metadata
    // remain on the same request object so the existing dispatcher records the
    // authoritative assignment in ModelExecutionEvidence.
    const assignment = this.workforce?.prepare(request);
    const provider = await this.resolveProvider();

    // M47: what is known about this model on this runtime (bounded probe, cached) decides the starting contract
    // and reasoning mode. Absent or failed, the M46 defaults and reactive recovery apply unchanged.
    if (RuntimeIntelligence.shared.enabled) {
      await RuntimeIntelligence.shared.prepare(provider, request.model, { signal: request.signal }).catch(() => undefined);
      // Cancellation during advisory probing is terminal: settle as cancelled, never proceed to dispatch or reroute.
      if (request.signal?.aborted) throw dependencyError('cancelled');
    }

    let messages: ChatMessage[] = [{ role: 'user', content: request.prompt }];
    // The same shared M11 preflight used by AgentLoop: model profile,
    // context-limit resolution, exact provider options and the typed
    // structured-output decision (Blocker 2).
    const session = await ModelDispatchPlanner.createSession({
      model: request.model,
      provider,
      toolsActive: false,
      hasImages: false,
      requestedResponseFormat: request.responseFormat,
      requestedNativeThinking: request.nativeThinking,
      signal: request.signal,
      configWorkspaceRoot: request.configWorkspaceRoot,
    });
    let preflight = session.preflight(messages, []);
    const adaptations: string[] = [];
    // M47 admission recovery: an oversized request is recompiled (lowest-value material first, measured by the same
    // preflight) before it is refused. It is refused only when the minimal request still cannot fit.
    if (!preflight.ok && admissionRecoveryEnabled()) {
      const admission = recompileForAdmission(request.prompt, candidate => session.preflight([{ role: 'user', content: candidate }], []));
      const note = describeAdmission(admission);
      if (note) adaptations.push(note);
      if (admission.ok) {
        messages = [{ role: 'user', content: admission.prompt }];
        preflight = admission.finalPreflight;
      }
    }
    const contextEvidence = toGovernedContextEvidence(preflight, session.options.timeoutMs, provider.providerType);
    if (!preflight.ok) {
      // Blocked before dispatch: the provider is never invoked, and the
      // evidence carries only numeric context metadata — never the prompt.
      throw contextBudgetRejection(adaptations.length > 0 ? { ...contextEvidence, adaptation: adaptations.join(';') } : contextEvidence);
    }

    // M47 provider health: timeouts, stalls, 5xx, unreachable and empty completions get one bounded recovery here,
    // apart from the semantic recovery controller. Adaptive contract enforcement (M46): a reasoning model can spend
    // the whole output budget thinking and return a completed reply with no text; that is answered by one retry
    // with native reasoning off. The prompt, the requested response format and the objective are unchanged.
    const canDisableReasoning = provider.providerType === 'ollama'
      && session.options.nativeThinking !== false
      && request.nativeThinking !== false
      && adaptiveSchemaEnabled();
    let response;
    let healthEvents: ProviderHealthEvent[] = [];
    try {
      const result = await new ProviderHealthController().run(async ({ reasoning }) => {
        if (reasoning === 'default') return provider.chat(messages, [], session.options, request.signal);
        const retry = await ModelDispatchPlanner.createSession({
          model: request.model,
          provider,
          toolsActive: false,
          hasImages: false,
          requestedResponseFormat: request.responseFormat,
          requestedNativeThinking: false,
          signal: request.signal,
          configWorkspaceRoot: request.configWorkspaceRoot,
        });
        return provider.chat(messages, [], retry.options, request.signal);
      }, { canDisableReasoning, signal: request.signal, reasoningAlreadyOff: session.options.nativeThinking === false });
      response = result.response;
      healthEvents = result.events;
    } catch (error) {
      const events = error instanceof ProviderHealthError ? error.events : [];
      const health = describeProviderHealth(events);
      const evidence = { ...contextEvidence, adaptation: [...adaptations, ...(health ? [health] : [])].join(';') || undefined };
      const raw = error instanceof ProviderHealthError ? error.cause_ : error;
      for (const event of events) void noteProviderEvent(provider, request.model, event);
      if (error instanceof ProviderHealthError && error.problem === 'context_envelope_rejected') {
        throw contextBudgetRejection(evidence);
      }
      throw attachContextEvidence(classifyProviderError(raw), evidence);
    }
    for (const event of healthEvents) void noteProviderEvent(provider, request.model, event);
    const recoveredByReasoningOff = healthEvents.some(event => event.step === 'retry_reasoning_off' && event.recovered);
    if (recoveredByReasoningOff) adaptations.push('disable_thinking:empty_completion');
    const otherHealth = describeProviderHealth(healthEvents.filter(event => event.step !== 'retry_reasoning_off'));
    if (otherHealth) adaptations.push(otherHealth);
    const adaptation = adaptations.length > 0 ? adaptations.join(';') : undefined;

    // Reject deterministically instead of fabricating a successful
    // completion when the canonical response is not a valid final text
    // completion (not done, no usable text, or an unexpected tool call —
    // `tools: []` was passed above, so any tool_calls here is malformed).
    if (response.done !== true) {
      throw invalidModelResponse('Provider response was not marked done.', 'not_done', contextEvidence);
    }
    if (response.message.tool_calls && response.message.tool_calls.length > 0) {
      throw invalidModelResponse('Provider returned an unexpected tool-call response for a tool-free governed model call.', 'unexpected_tool_call', contextEvidence);
    }
    if (typeof response.message.content !== 'string' || response.message.content.length === 0) {
      throw invalidModelResponse('Provider response did not contain usable completion text.', 'empty_content', contextEvidence);
    }

    this.workforce?.complete(assignment, response.message.content);
    return {
      completion: response.message.content,
      // Actual resolved provider identity — never derived from caller
      // input, model configuration or an assumed default.
      providerType: provider.providerType,
      contextEvidence: adaptation ? { ...contextEvidence, adaptation } : contextEvidence,
    };
  }
}

/** Outcome shape including the shared-preflight context evidence. */
type GovernedModelExecutionOutcomeWithContext = GovernedModelExecutionOutcome & {
  contextEvidence: GovernedContextEvidence;
};

function toGovernedContextEvidence(
  preflight: ContextPreflightResult,
  providerRequestTimeoutMs: number,
  providerType: string,
): GovernedContextEvidence {
  return {
    profileId: preflight.limit.profileId,
    effectiveContextLimit: preflight.limit.effectiveLimit,
    provenance: preflight.limit.provenance,
    estimated: preflight.limit.estimated,
    fallback: preflight.limit.fallback,
    contentTokens: preflight.contentTokens,
    projectedTotalTokens: preflight.projectedTotal,
    outputReserveTokens: preflight.outputReserve,
    percentUsed: preflight.percentUsed,
    status: preflight.status,
    structuredOutput: {
      requested: preflight.structuredOutput?.requested ?? false,
      supported: preflight.structuredOutput?.supported ?? false,
      active: preflight.structuredOutput?.active ?? false,
      deferredReason: preflight.structuredOutput?.deferredReason,
    },
    providerRequestTimeoutMs,
    timeoutOwner: `provider:${providerType}`,
    providerType: providerType as GovernedContextEvidence['providerType'],
  };
}

function admissionRecoveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.OLLAMA_AGENT_ADMISSION_RECOVERY !== '0';
}

/** Folds one provider-health event into the runtime's capability profile (a no-op unless runtime intelligence is on). */
async function noteProviderEvent(provider: InferenceProvider, model: string, event: ProviderHealthEvent): Promise<void> {
  try {
    const runtime = RuntimeIntelligence.shared;
    if (event.problem === 'empty_completion') await runtime.record(provider, model, 'empty_completion');
    else if (event.problem === 'timeout') await runtime.record(provider, model, 'timeout');
    else if (event.problem === 'response_stall') await runtime.record(provider, model, 'stall');
    if (event.recovered) await runtime.record(provider, model, 'recovered');
  } catch {
    // Observations are best-effort; they must never fail a dispatch.
  }
}

function contextBudgetRejection(contextEvidence: GovernedContextEvidence): GovernedModelExecutionDependencyError {
  const error: GovernedModelExecutionDependencyError = new Error(
    'Governed model request blocked by context preflight before dispatch.',
  );
  error.failureCode = 'execution_rejected';
  error.contextEvidence = contextEvidence;
  return error;
}

function invalidModelResponse(
  message: string,
  reason: GovernedModelInvalidResponseReason,
  contextEvidence?: GovernedContextEvidence,
): GovernedModelExecutionDependencyError {
  const error: GovernedModelExecutionDependencyError = new Error(message);
  error.failureCode = 'invalid_model_response';
  error.invalidResponseReason = reason;
  if (contextEvidence) {
    error.contextEvidence = contextEvidence;
  }
  return error;
}

/**
 * Maps a typed provider error onto the governed failure taxonomy.
 *
 * M42 cold-start note: `OllamaProvider` already distinguishes *why* a request
 * timed out via `ProviderTimeoutError.evidenceTag` —
 * `transport:undici-connect` (never connected), `transport:undici-headers`
 * (connected, but no first token: the cold model-load case, e.g. a cold
 * qwen3.8 MTP load exceeding the 300s request budget) and
 * `transport:undici-body` (generation stalled mid-stream). The governed
 * contract intentionally collapses all three to `timeout`, because all three
 * are provider-runtime failures that produced no usable response, and all
 * three are therefore equally safe to treat as a recoverable local-routing
 * failure (bounded to one fallback attempt, and only with explicit cloud
 * consent — see LocalFirstModelRouting).
 *
 * Preserving the tag as a distinct sanitized sub-reason, and any cold-start
 * warmup/prefetch that would avoid the timeout entirely, are deliberately
 * deferred: neither is required to route safely, and the request timeout is
 * not raised globally by this milestone.
 */
function classifyProviderError(error: unknown): unknown {
  if (error instanceof ProviderModelNotFoundError) {
    return dependencyError('model_unavailable');
  }
  if (error instanceof ProviderTimeoutError) {
    return dependencyError('timeout');
  }
  if (error instanceof ProviderCancelledError) {
    return dependencyError('cancelled');
  }
  if (
    error instanceof ProviderConnectionError ||
    error instanceof ProviderAuthError ||
    error instanceof ProviderApiError
  ) {
    return dependencyError('provider_failure');
  }
  return error;
}

function attachContextEvidence(error: unknown, contextEvidence: GovernedContextEvidence): unknown {
  if (typeof error === 'object' && error !== null) {
    (error as GovernedModelExecutionDependencyError).contextEvidence = contextEvidence;
  }
  return error;
}

function dependencyError(
  failureCode: NonNullable<GovernedModelExecutionDependencyError['failureCode']>,
): GovernedModelExecutionDependencyError {
  const error: GovernedModelExecutionDependencyError = new Error('Governed provider failure.');
  error.failureCode = failureCode;
  return error;
}
