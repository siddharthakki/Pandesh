import type { ProviderType } from '../providers/ProviderTypes';
import {
  GovernedModelRequest,
  GovernedModelResult,
  ModelRoutingEvidence,
} from './GovernedModelExecutionTypes';
import {
  CloudFallbackDecision,
  decideCloudFallback,
  decideLoopLevelCloudEscalation,
  type LoopLevelCloudEscalationReason,
} from '../models/LocalFirstModelRouting';

/**
 * The minimal dispatch surface every governed model consumer already uses.
 * Extracted so a router can sit in front of `GovernedModelExecutionDispatcher`
 * without changing the dispatcher, the governed contract, or any consumer.
 */
export interface GovernedModelDispatchSeam {
  dispatch(request: GovernedModelRequest): Promise<GovernedModelResult>;
}

/** A resolved, executable cloud fallback route. */
export interface CloudFallbackRoute {
  model: string;
  providerType: ProviderType;
  dispatcher: GovernedModelDispatchSeam;
}

export interface LocalFirstModelDispatchRouterOptions {
  /**
   * False when the user explicitly chose the model for this task. An explicit
   * override is authoritative: the router never substitutes another model or
   * provider for it, and simply returns the local result unchanged.
   */
  automaticSelection: boolean;
  /**
   * False when the workspace routing policy is local-only. Defaults true so
   * existing cloud-fallback wiring is unchanged; the executor passes the
   * actual policy so local-only never constructs or calls a cloud route.
   */
  cloudFallbackPermittedAndConfigured?: boolean;
  /**
   * Resolves the cloud fallback route, or undefined when cloud fallback is not
   * permitted/configured. Called at most once, and only *after* the policy has
   * already decided a fallback would be allowed — so a local-only workspace
   * never even constructs a cloud provider.
   */
  resolveCloudFallback: () => Promise<CloudFallbackRoute | undefined>;
  /** Optional bounded, enum-only routing notification (never prompt text). */
  onRoutingEvent?: (event: ModelRoutingEvidence) => void;
}

/**
 * M42 local-first routing seam.
 *
 * Wraps the primary (local) governed dispatcher and, for a *recoverable local
 * runtime failure only*, retries the same governed request exactly once
 * against an explicitly permitted cloud endpoint.
 *
 * Guarantees, in order of the checks in `decideCloudFallback`:
 *  - the cloud route is never touched when the local dispatch completed;
 *  - an explicit user model override is never silently replaced;
 *  - user cancellation and governance/policy rejections (`cancelled`,
 *    `execution_rejected`) never route to cloud;
 *  - at most one fallback attempt exists per router instance, and the router
 *    is constructed once per governed coding run, so a task can never
 *    cascade through a third model;
 *  - the fallback dispatcher is *not* itself wrapped, so no fallback of a
 *    fallback is structurally possible.
 *
 * Every returned result carries `routing` evidence naming the model/provider
 * actually attempted and actually executed, so a cloud-completed stage can
 * never be reported as a local success.
 */
export class LocalFirstModelDispatchRouter implements GovernedModelDispatchSeam {
  private fallbackAttempted = false;
  private loopCloudRoute: CloudFallbackRoute | undefined;

  constructor(
    private readonly primary: GovernedModelDispatchSeam,
    private readonly options: LocalFirstModelDispatchRouterOptions,
  ) {}

  /** True once this router has spent its single cloud fallback attempt. */
  get hasAttemptedFallback(): boolean {
    return this.fallbackAttempted;
  }

  async dispatch(request: GovernedModelRequest): Promise<GovernedModelResult> {
    const local = await this.primary.dispatch(request);

    const cloudPermitted = this.options.cloudFallbackPermittedAndConfigured === true;
    const decision = decideCloudFallback({
      localStatus: local.status,
      localFailureCode: local.failureCode,
      automaticSelection: this.options.automaticSelection,
      fallbackAlreadyAttempted: this.fallbackAttempted,
      cloudFallbackPermittedAndConfigured: cloudPermitted,
    });

    if (decision !== 'used') {
      return this.annotate(local, request, local, decision);
    }

    const route = await this.options.resolveCloudFallback();
    if (!route) {
      return this.annotate(local, request, local, 'cloud_fallback_not_permitted');
    }

    // Marked before the call so a throw or a second concurrent stage can
    // never produce a second fallback attempt.
    this.fallbackAttempted = true;

    const fallbackRequest: GovernedModelRequest = {
      ...request,
      requestId: `${request.requestId}::cloud-fallback`,
      model: route.model,
      providerType: route.providerType,
    };
    const cloud = await route.dispatcher.dispatch(fallbackRequest);
    return this.annotate(cloud, request, local, 'used');
  }

  /**
   * One investigation-loop cloud dispatch. Explicit local-model selection is
   * not a prohibition here: Qwen (or any explicit primary) remains the
   * starting model; this is the authorized recovery after exhausted
   * investigation or persistent unusable output. Shares the task's single
   * cloud one-shot with per-call fallback. Never used for cancellation or
   * governance rejection.
   */
  async dispatchLoopLevelCloud(
    request: GovernedModelRequest,
    reason: LoopLevelCloudEscalationReason,
    local?: GovernedModelResult,
  ): Promise<GovernedModelResult | undefined> {
    if (this.loopCloudRoute) {
      const cloudRequest: GovernedModelRequest = {
        ...request,
        requestId: `${request.requestId}::loop-cloud-${reason}`,
        model: this.loopCloudRoute.model,
        providerType: this.loopCloudRoute.providerType,
      };
      const cloud = await this.loopCloudRoute.dispatcher.dispatch(cloudRequest);
      const baseline = local ?? cloud;
      return this.annotate(cloud, request, baseline, 'loop_level_used');
    }

    const decision = decideLoopLevelCloudEscalation({
      reason,
      fallbackAlreadyAttempted: this.fallbackAttempted,
      cloudFallbackPermittedAndConfigured: this.options.cloudFallbackPermittedAndConfigured === true,
      localFailureCode: local?.failureCode,
    });
    if (decision !== 'loop_level_used') {
      if (local) this.annotate(local, request, local, decision);
      return undefined;
    }

    const route = await this.options.resolveCloudFallback();
    if (!route) {
      if (local) this.annotate(local, request, local, 'cloud_fallback_not_permitted');
      return undefined;
    }

    this.fallbackAttempted = true;
    this.loopCloudRoute = route;
    const cloudRequest: GovernedModelRequest = {
      ...request,
      requestId: `${request.requestId}::loop-cloud-${reason}`,
      model: route.model,
      providerType: route.providerType,
    };
    const cloud = await route.dispatcher.dispatch(cloudRequest);
    const baseline = local ?? cloud;
    return this.annotate(cloud, request, baseline, 'loop_level_used');
  }

  /**
   * Attaches routing evidence to both the result and its
   * `ModelExecutionEvidence`. Purely additive — no contract field is
   * rewritten, so `verifyGovernedModelResultCompliance` (already run by the
   * dispatcher that produced `result`) stays satisfied.
   */
  private annotate(
    result: GovernedModelResult,
    localRequest: GovernedModelRequest,
    local: GovernedModelResult,
    decision: CloudFallbackDecision,
  ): GovernedModelResult {
    const routing: ModelRoutingEvidence = {
      selection: this.options.automaticSelection ? 'automatic' : 'explicit_override',
      attemptedModel: localRequest.model,
      attemptedProviderType: local.providerType ?? localRequest.providerType,
      executedModel: result.model,
      executedProviderType: result.providerType
        ?? (decision === 'used' || decision === 'loop_level_used'
          ? (this.loopCloudRoute?.providerType ?? 'openai-compatible')
          : (local.providerType ?? localRequest.providerType)),
      fallbackUsed: decision === 'used' || decision === 'loop_level_used',
      fallbackDecision: decision,
      localFailureCode: local.failureCode,
      // Already one of the dispatcher's fixed sanitized strings.
      localFailureReason: local.failureReason,
    };
    this.options.onRoutingEvent?.(routing);
    return {
      ...result,
      routing,
      evidence: { ...result.evidence, routing },
    };
  }
}
