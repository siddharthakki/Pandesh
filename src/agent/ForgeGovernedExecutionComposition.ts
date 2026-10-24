import type * as vscode from 'vscode';
import { LocalAgentEngine } from './LocalAgentEngine';
import { ForgeInvocationReference, ReadOnlyForgeInvocationAdapter } from './ForgeInvocationAdapter';
import { GovernedModelExecutionDispatcher } from './GovernedModelExecutionDispatcher';
import { ProviderGatewayGovernedModelExecutionDependency } from './ProviderGatewayGovernedModelExecutionDependency';
import {
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerForgeLifecycleControlCallables,
  registerGovernedForgeInvocationPreparationCallable,
  registerGovernedForgeInvocationQueueInspectionCallable,
  registerGovernedForgeInvocationReservationLeaseRenewalCallable,
  registerGovernedForgeInvocationReservationMetricsCallable,
  registerGovernedForgeInvocationReservationReleaseCallable,
  registerGovernedForgeInvocationStartCallable,
  registerGovernedForgeInvocationStartEligibilityCallable,
  registerGovernedForgeInvocationStartReservationCallable,
  registerGovernedForgeInvocationStartReservationExpirationCallable,
  registerGovernedForgeInvocationStartReservationListCallable,
  registerGovernedForgeInvocationStartReservationLookupCallable,
  registerGovernedForgeInvokeModelCallable,
  registerGovernedForgeFixedMultiAgentGraphCallable,
  registerGovernedForgeModelExecutionResultCallable,
  registerGovernedForgeSchedulerSnapshotCallable,
  registerGovernedForgeSchedulerValidateCallable,
  registerReadOnlyForgeObservabilityCallables,
} from './ForgeCallableSurface';
import { CancellationAwareForgeCallableTransport } from './ForgeRpcCancellationTransport';
import { FixedMultiAgentGraph } from '../orchestration/FixedMultiAgentGraph';

export interface GovernedForgeExecutionCompositionInput {
  /**
   * The production engine the composed graph reads and executes through.
   * `AgentRuntime` satisfies this directly (it extends `LocalAgentEngine`),
   * so the graph shares the runtime's task store, lifecycle and event state
   * instead of creating a disconnected duplicate engine.
   */
  engine: LocalAgentEngine;
  /**
   * Backs `ProviderGatewayGovernedModelExecutionDependency.forSecrets`. The
   * provider is resolved lazily, only when a governed model call actually
   * executes - never during composition.
   */
  secrets: vscode.SecretStorage;
  /**
   * Known invocation-to-task references for the status/events/progress read
   * path. The prepare/canStart/reserveStart/invokeModel path requires no
   * pre-registered references (a documented consumer-facing asymmetry, see
   * docs/M5_ARCHITECTURE_REVIEW.md Known risks).
   */
  invocations?: readonly ForgeInvocationReference[];
  /** Injectable clock shared by the adapter and dispatcher; production uses their default ISO clock. */
  now?: () => string;
}

/**
 * The populated registry and local cancellation-aware transport retained by
 * one RPC service. The transport remains a LocalForgeCallableTransport
 * subclass, so existing direct local callers keep the same API.
 */
export interface GovernedForgeExecutionComposition {
  registry: ReadOnlyForgeCallableRegistry;
  transport: CancellationAwareForgeCallableTransport;
}

/**
 * Production composition of the governed Forge execution graph.
 *
 * Construction is inert: it only constructs and connects objects. It never
 * invokes a provider, calls `engine.startTask`, enters the agent loop,
 * executes a tool, creates or claims a reservation, dispatches a governed
 * model execution, binds a socket, starts a listener, creates timers or
 * workers, or persists any state.
 */
export function composeGovernedForgeExecution(
  input: GovernedForgeExecutionCompositionInput,
): GovernedForgeExecutionComposition {
  const dependency = ProviderGatewayGovernedModelExecutionDependency.forSecrets(input.secrets);
  const dispatcher = new GovernedModelExecutionDispatcher(dependency, input.now);
  const workspaceRoot = (input.engine as unknown as { workspaceRoot?: string }).workspaceRoot;
  const graph = FixedMultiAgentGraph.forWorkspace(dispatcher, workspaceRoot);
  const adapter = new ReadOnlyForgeInvocationAdapter(
    input.engine,
    input.invocations ?? [],
    input.now,
    dispatcher,
  );
  const surface = new ReadOnlyForgeCallableSurface(adapter, graph);

  const registry = new ReadOnlyForgeCallableRegistry();
  registerReadOnlyForgeObservabilityCallables(registry, surface);
  registerGovernedForgeInvocationPreparationCallable(registry, surface);
  registerGovernedForgeInvocationStartEligibilityCallable(registry, surface);
  registerGovernedForgeInvocationStartReservationCallable(registry, surface);
  registerGovernedForgeInvocationStartReservationLookupCallable(registry, surface);
  registerGovernedForgeInvocationStartReservationExpirationCallable(registry, surface);
  registerGovernedForgeInvocationStartReservationListCallable(registry, surface);
  registerGovernedForgeInvocationReservationReleaseCallable(registry, surface);
  registerGovernedForgeInvocationReservationLeaseRenewalCallable(registry, surface);
  registerGovernedForgeInvocationReservationMetricsCallable(registry, surface);
  registerGovernedForgeInvocationQueueInspectionCallable(registry, surface);
  registerGovernedForgeSchedulerSnapshotCallable(registry, surface);
  registerGovernedForgeSchedulerValidateCallable(registry, surface);
  registerGovernedForgeInvocationStartCallable(registry, surface);
  registerGovernedForgeInvokeModelCallable(registry, surface);
  registerGovernedForgeModelExecutionResultCallable(registry, surface);
  registerGovernedForgeFixedMultiAgentGraphCallable(registry, surface);
  registerForgeLifecycleControlCallables(registry, surface);

  return {
    registry,
    transport: new CancellationAwareForgeCallableTransport(registry, adapter),
  };
}
