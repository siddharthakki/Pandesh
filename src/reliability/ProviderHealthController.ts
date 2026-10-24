import {
  ProviderApiError,
  ProviderAuthError,
  ProviderCancelledError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from '../providers/ProviderTypes';
import type { ChatResponse } from '../tools/ToolTypes';

/**
 * ProviderHealthController: recovery for problems that are the runtime's, not the model's.
 *
 * It is deliberately separate from the semantic RecoveryController. Nothing here can increment a failed-hypothesis
 * count, because none of these events say anything about whether the model's idea was right. It wraps exactly one
 * dispatch and applies a short, bounded ladder:
 *
 *   detect -> (cancel: the transport aborts a timed-out request) -> safe retry once
 *          -> alter the reasoning mode if the evidence supports it -> stop with an explicit reason
 *
 * A configured reroute (M42 local-first routing) sits above this: when the ladder is exhausted the original
 * failure is rethrown unchanged, so the router still sees the same failure code and may fall back exactly as before.
 * No unbounded loops: at most `maxRetries` (default 1) extra requests per dispatch, regardless of failure kind.
 */

export type ProviderProblem =
  | 'timeout'
  | 'response_stall'
  | 'server_error'
  | 'provider_unavailable'
  | 'empty_completion'
  | 'context_envelope_rejected'
  | 'model_unavailable'
  | 'auth_rejected'
  | 'client_rejected'
  | 'cancelled'
  | 'unknown';

export type ProviderHealthStep =
  | 'retry_same'
  | 'retry_reasoning_off'
  | 'retry_backoff'
  | 'stop';

export interface ProviderHealthEvent {
  problem: ProviderProblem;
  step: ProviderHealthStep;
  attempt: number;
  ms: number;
  /** Set on the final event: the dispatch was rescued by this step. */
  recovered?: boolean;
}

export interface ProviderHealthPolicy {
  maxRetries: number;
  backoffMs: number;
  /** A retry after a timeout is pointless once this much of the caller's own deadline has been spent. */
  minRemainingMs: number;
}

export const DEFAULT_PROVIDER_HEALTH_POLICY: ProviderHealthPolicy = { maxRetries: 1, backoffMs: 400, minRemainingMs: 0 };

const CONTEXT_REJECTION = /context (?:length|window|size)|exceeds? the (?:available )?context|too many tokens|maximum context|n_ctx|prompt is too long/i;

/** Maps a thrown provider error onto a problem. Pure. */
export function classifyProviderProblem(error: unknown): ProviderProblem {
  if (error instanceof ProviderCancelledError) return 'cancelled';
  if (error instanceof ProviderTimeoutError) {
    return error.evidenceTag === 'transport:undici-body' ? 'response_stall' : 'timeout';
  }
  if (error instanceof ProviderModelNotFoundError) return 'model_unavailable';
  if (error instanceof ProviderAuthError) return 'auth_rejected';
  if (error instanceof ProviderConnectionError) return 'provider_unavailable';
  if (error instanceof ProviderApiError) {
    if (error.statusCode >= 500) return 'server_error';
    if (error.statusCode === 400 || error.statusCode === 413) {
      return CONTEXT_REJECTION.test(error.message) ? 'context_envelope_rejected' : 'client_rejected';
    }
    return 'client_rejected';
  }
  return 'unknown';
}

/**
 * Problems for which trying the identical request once more is a reasonable, safe thing to do. An unreachable runtime
 * (`provider_unavailable`) is deliberately absent: there the configured reroute (M42 local-first routing) is the
 * recovery, and retrying the same dead endpoint first would only delay it and change M46 routing behaviour.
 */
const RETRY_SAME: ReadonlySet<ProviderProblem> = new Set(['timeout', 'response_stall', 'server_error']);

export function isEmptyCompletion(response: ChatResponse): boolean {
  return response.done === true
    && !(response.message.tool_calls?.length)
    && (typeof response.message.content !== 'string' || response.message.content.length === 0);
}

export interface ProviderCallContext {
  /** Reasoning setting used for this attempt; `default` means the caller's own setting. */
  reasoning: 'default' | 'disabled';
}

export interface ProviderHealthResult {
  response: ChatResponse;
  events: ProviderHealthEvent[];
  /** Reasoning mode the accepted response was produced under. */
  reasoning: 'default' | 'disabled';
}

export class ProviderHealthError extends Error {
  constructor(
    readonly cause_: unknown,
    readonly problem: ProviderProblem,
    readonly events: ProviderHealthEvent[],
  ) {
    super(`provider ${problem} after ${events.length} recovery step(s)`);
    this.name = 'ProviderHealthError';
  }
}

export class ProviderHealthController {
  constructor(
    private readonly policy: ProviderHealthPolicy = DEFAULT_PROVIDER_HEALTH_POLICY,
    private readonly sleep: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Runs `call` and applies the ladder. `canDisableReasoning` says whether an empty completion may be answered by
   * turning native reasoning off (profile evidence, provider support, and the kill switch all agree). On success the
   * accepted response is returned with the events that led to it; on failure a ProviderHealthError wraps the
   * original error so the caller can rethrow it (with its existing failure code) after attaching the events.
   */
  async run(
    call: (context: ProviderCallContext) => Promise<ChatResponse>,
    options: { canDisableReasoning: boolean; signal?: AbortSignal; reasoningAlreadyOff?: boolean },
  ): Promise<ProviderHealthResult> {
    const events: ProviderHealthEvent[] = [];
    let retriesLeft = this.policy.maxRetries;
    let reasoning: 'default' | 'disabled' = options.reasoningAlreadyOff ? 'disabled' : 'default';
    let attempt = 0;
    for (;;) {
      // Cancellation is terminal: never start another attempt once the caller has cancelled. The first attempt is
      // still handed to the provider with the (possibly already aborted) signal, as before M47: the provider owns
      // abort handling and reports the cancellation, so a cancel that lands just before dispatch settles as cancelled.
      if (attempt > 0 && options.signal?.aborted) {
        events.push({ problem: 'cancelled', step: 'stop', attempt: attempt + 1, ms: 0 });
        throw new ProviderHealthError(new ProviderCancelledError('Cancelled before dispatch.', 'ollama'), 'cancelled', events);
      }
      attempt++;
      const started = this.now();
      let response: ChatResponse | undefined;
      let problem: ProviderProblem | undefined;
      let error: unknown;
      try {
        response = await call({ reasoning });
        if (isEmptyCompletion(response)) problem = 'empty_completion';
      } catch (thrown) {
        error = thrown;
        problem = classifyProviderProblem(thrown);
      }
      const ms = this.now() - started;
      if (!problem && response) {
        if (events.length > 0) events[events.length - 1].recovered = true;
        return { response, events, reasoning };
      }
      const outcome = problem ?? 'unknown';

      if (options.signal?.aborted || outcome === 'cancelled') {
        events.push({ problem: outcome, step: 'stop', attempt, ms });
        throw new ProviderHealthError(error, outcome, events);
      }
      if (retriesLeft > 0 && outcome === 'empty_completion' && options.canDisableReasoning && reasoning === 'default') {
        retriesLeft--;
        reasoning = 'disabled';
        events.push({ problem: outcome, step: 'retry_reasoning_off', attempt, ms });
        continue;
      }
      if (retriesLeft > 0 && RETRY_SAME.has(outcome)) {
        retriesLeft--;
        const step: ProviderHealthStep = outcome === 'server_error' ? 'retry_backoff' : 'retry_same';
        events.push({ problem: outcome, step, attempt, ms });
        if (step === 'retry_backoff') await this.sleep(this.policy.backoffMs);
        continue;
      }
      events.push({ problem: outcome, step: 'stop', attempt, ms });
      // An empty completion that survived the ladder is returned to the caller's existing invalid-response handling.
      if (outcome === 'empty_completion' && response) return { response, events, reasoning };
      throw new ProviderHealthError(error, outcome, events);
    }
  }
}

/** One-line evidence string, e.g. `provider_health:timeout>retry_same>recovered`. Content-free. */
export function describeProviderHealth(events: readonly ProviderHealthEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const parts = events.map(event => `${event.problem}>${event.step}`);
  const last = events[events.length - 1];
  return `provider_health:${parts.join(',')}${last.recovered ? ',recovered' : ''}`;
}
