import {
  ForgeInvocationAuditMetadata,
  ForgeInvocationModelCall,
  ForgeInvocationModelResultLookup,
  ForgeInvocationPreparation,
  ForgeInvocationStart,
  ForgeInvocationLifecycleControl,
  ForgeInvocationStartEligibility,
  ForgeInvocationStartReservation,
  ForgeInvocationStartReservationExpiration,
  ForgeInvocationStartReservationList,
  ForgeInvocationStartReservationLookup,
  ForgeInvocationReservationRelease,
  ForgeInvocationReservationLeaseRenewal,
  ForgeInvocationReservationMetrics,
  ForgeInvocationQueueInspection,
  ForgeInvocationStatus,
  ForgeSchedulerSnapshot,
  ForgeSchedulerValidation,
} from './AgentEngineTypes';
import {
  ForgeInvocationEvents,
  ForgeInvocationProgress,
  ReadOnlyForgeInvocationAdapter,
} from './ForgeInvocationAdapter';
import {
  GovernedToolRegistry,
  governedDefinitionFromForgeDescriptor,
} from '../tools/GovernedToolRegistry';
import { GrantedPermissionSet } from '../tools/PermissionProfiles';
import {
  PermissionDenial,
  SerializablePermissionContext,
  denialFromAuthorization,
  formatPermissionDenial,
  grantsFromPermissionContext,
  validateBoundPermissionContext,
} from '../tools/PermissionContext';
import {
  FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
  FixedMultiAgentGraph,
  FixedMultiAgentGraphResult,
} from '../orchestration/FixedMultiAgentGraph';

export const FORGE_GET_INVOCATION_STATUS_METHOD = 'forge.invocation.getStatus' as const;
export const FORGE_GET_INVOCATION_EVENTS_METHOD = 'forge.invocation.getEvents' as const;
export const FORGE_GET_INVOCATION_PROGRESS_METHOD = 'forge.invocation.getProgress' as const;
export const FORGE_PREPARE_INVOCATION_METHOD = 'forge.invocation.prepare' as const;
export const FORGE_CAN_START_INVOCATION_METHOD = 'forge.invocation.canStart' as const;
export const FORGE_RESERVE_START_INVOCATION_METHOD = 'forge.invocation.reserveStart' as const;
export const FORGE_GET_START_RESERVATION_METHOD = 'forge.invocation.getReservation' as const;
export const FORGE_EXPIRE_START_RESERVATION_METHOD = 'forge.invocation.expireReservation' as const;
export const FORGE_LIST_START_RESERVATIONS_METHOD = 'forge.invocation.listReservations' as const;
export const FORGE_RELEASE_RESERVATION_METHOD = 'forge.invocation.releaseReservation' as const;
export const FORGE_RENEW_RESERVATION_LEASE_METHOD = 'forge.invocation.renewReservationLease' as const;
export const FORGE_RESERVATION_METRICS_METHOD = 'forge.invocation.reservationMetrics' as const;
export const FORGE_INSPECT_QUEUE_METHOD = 'forge.invocation.inspectQueue' as const;
export const FORGE_SCHEDULER_SNAPSHOT_METHOD = 'forge.scheduler.snapshot' as const;
export const FORGE_SCHEDULER_VALIDATE_METHOD = 'forge.scheduler.validate' as const;
export const FORGE_START_INVOCATION_METHOD = 'forge.invocation.start' as const;
export const FORGE_INVOKE_MODEL_METHOD = 'forge.invocation.invokeModel' as const;
export const FORGE_GET_MODEL_EXECUTION_RESULT_METHOD = 'forge.invocation.getModelExecutionResult' as const;
export const FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD = 'forge.invocation.runFixedMultiAgentGraph' as const;
export const FORGE_PAUSE_INVOCATION_METHOD = 'forge.invocation.pause' as const;
export const FORGE_RESUME_INVOCATION_METHOD = 'forge.invocation.resume' as const;
export const FORGE_CANCEL_INVOCATION_METHOD = 'forge.invocation.cancel' as const;
export const FORGE_STATUS_CONTRACT_VERSION = 1 as const;
/**
 * Dedicated contract version for the model-execution callable
 * (`forge.invocation.invokeModel`). Kept separate from
 * `FORGE_STATUS_CONTRACT_VERSION` because that constant versions the
 * non-executing status/reservation/lifecycle callables, not model
 * execution; the two happen to share the same numeric value today but are
 * not the same contract.
 */
export const FORGE_MODEL_INVOCATION_CONTRACT_VERSION = 1 as const;
export const FORGE_LOCAL_TRANSPORT = 'local' as const;

export type ForgeCallableMethod =
  | typeof FORGE_GET_INVOCATION_STATUS_METHOD
  | typeof FORGE_GET_INVOCATION_EVENTS_METHOD
  | typeof FORGE_GET_INVOCATION_PROGRESS_METHOD
  | typeof FORGE_PREPARE_INVOCATION_METHOD
  | typeof FORGE_CAN_START_INVOCATION_METHOD
  | typeof FORGE_RESERVE_START_INVOCATION_METHOD
  | typeof FORGE_GET_START_RESERVATION_METHOD
  | typeof FORGE_EXPIRE_START_RESERVATION_METHOD
  | typeof FORGE_LIST_START_RESERVATIONS_METHOD
  | typeof FORGE_RELEASE_RESERVATION_METHOD
  | typeof FORGE_RENEW_RESERVATION_LEASE_METHOD
  | typeof FORGE_RESERVATION_METRICS_METHOD
  | typeof FORGE_INSPECT_QUEUE_METHOD
  | typeof FORGE_SCHEDULER_SNAPSHOT_METHOD
  | typeof FORGE_SCHEDULER_VALIDATE_METHOD
  | typeof FORGE_START_INVOCATION_METHOD
  | typeof FORGE_INVOKE_MODEL_METHOD
  | typeof FORGE_GET_MODEL_EXECUTION_RESULT_METHOD
  | typeof FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD
  | typeof FORGE_PAUSE_INVOCATION_METHOD
  | typeof FORGE_RESUME_INVOCATION_METHOD
  | typeof FORGE_CANCEL_INVOCATION_METHOD;
export type ForgeCallableTransport = typeof FORGE_LOCAL_TRANSPORT;

export interface ForgeCallableDescriptor {
  id: ForgeCallableMethod;
  version: typeof FORGE_STATUS_CONTRACT_VERSION;
  transport: ForgeCallableTransport;
  readOnly: boolean;
  sideEffects?: 'none' | 'metadata-only' | 'task-lifecycle' | 'model-execution';
  nonExecuting?: true;
}

export interface ForgeInvocationStatusCallableRequest {
  method: typeof FORGE_GET_INVOCATION_STATUS_METHOD;
  params: {
    invocationId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationEventsCallableRequest {
  method: typeof FORGE_GET_INVOCATION_EVENTS_METHOD;
  params: {
    invocationId: string;
    afterSeq?: number;
  };
}

export interface ForgeInvocationProgressCallableRequest {
  method: typeof FORGE_GET_INVOCATION_PROGRESS_METHOD;
  params: {
    invocationId: string;
  };
}

export interface ForgeInvocationPreparationCallableRequest {
  method: typeof FORGE_PREPARE_INVOCATION_METHOD;
  params: {
    invocationId: string;
    taskId: string;
    goal: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationStartEligibilityCallableRequest {
  method: typeof FORGE_CAN_START_INVOCATION_METHOD;
  params: {
    invocationId: string;
    taskId: string;
    goal: string;
    prepared: boolean;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationStartReservationCallableRequest {
  method: typeof FORGE_RESERVE_START_INVOCATION_METHOD;
  params: {
    invocationId: string;
    taskId: string;
    goal: string;
    prepared: boolean;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationStartReservationLookupCallableRequest {
  method: typeof FORGE_GET_START_RESERVATION_METHOD;
  params: {
    reservationId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationStartReservationExpirationCallableRequest {
  method: typeof FORGE_EXPIRE_START_RESERVATION_METHOD;
  params: {
    reservationId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}
export interface ForgeInvocationStartReservationListCallableRequest {
  method: typeof FORGE_LIST_START_RESERVATIONS_METHOD;
  params?: {
    includeExpired?: boolean;
    audit?: ForgeInvocationAuditMetadata;
  };
}
export interface ForgeInvocationReservationReleaseCallableRequest {
  method: typeof FORGE_RELEASE_RESERVATION_METHOD;
  params: {
    reservationId: string;
    ownerId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationReservationLeaseRenewalCallableRequest {
  method: typeof FORGE_RENEW_RESERVATION_LEASE_METHOD;
  params: {
    reservationId: string;
    ownerId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationReservationMetricsCallableRequest {
  method: typeof FORGE_RESERVATION_METRICS_METHOD;
  params?: {
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationQueueInspectionCallableRequest {
  method: typeof FORGE_INSPECT_QUEUE_METHOD;
  params?: {
    includeExpired?: boolean;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeSchedulerSnapshotCallableRequest {
  method: typeof FORGE_SCHEDULER_SNAPSHOT_METHOD;
  params?: {
    includeExpired?: boolean;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeSchedulerValidationCallableRequest {
  method: typeof FORGE_SCHEDULER_VALIDATE_METHOD;
  params?: {
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationStartCallableRequest {
  method: typeof FORGE_START_INVOCATION_METHOD;
  params: {
    invocationId: string;
    taskId: string;
    goal: string;
    reservationId: string;
    mode?: 'agent' | 'ask';
    model?: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

/**
 * Transport-safe, JSON-serializable request for the model-execution
 * callable. Deliberately omits `AbortSignal` (an in-process JS object, not
 * valid over a transport contract — cancellation is resolved internally by
 * the adapter) and `goal`/`invocationId`/`taskId` (the accepted reservation
 * already owns the governed goal and identity; re-accepting them here would
 * let a caller substitute a different prompt than the one the reservation
 * was granted for).
 */
export interface ForgeInvocationModelCallCallableRequest {
  method: typeof FORGE_INVOKE_MODEL_METHOD;
  params: {
    reservationId: string;
    model: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

/**
 * Read-only lookup for a governed model execution's terminal result and
 * evidence, scoped to the invocation/task identity that owns the
 * reservation the call was invoked under. Requires `invocationId`/`taskId`
 * from the caller (unlike `invokeModel`) precisely because supplying them is
 * itself the ownership check this callable performs.
 */
export interface ForgeInvocationModelResultLookupCallableRequest {
  method: typeof FORGE_GET_MODEL_EXECUTION_RESULT_METHOD;
  params: {
    reservationId: string;
    invocationId: string;
    taskId: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeFixedMultiAgentGraphCallableRequest {
  method: typeof FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD;
  params: {
    invocationId: string;
    taskId: string;
    goal: string;
    model: string;
    workspaceRoot?: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export interface ForgeInvocationLifecycleControlCallableRequest {
  method:
    | typeof FORGE_PAUSE_INVOCATION_METHOD
    | typeof FORGE_RESUME_INVOCATION_METHOD
    | typeof FORGE_CANCEL_INVOCATION_METHOD;
  params: {
    invocationId: string;
    reason?: string;
    audit?: ForgeInvocationAuditMetadata;
  };
}

export type ForgeCallableRequest =
  | ForgeInvocationStatusCallableRequest
  | ForgeInvocationEventsCallableRequest
  | ForgeInvocationProgressCallableRequest
  | ForgeInvocationPreparationCallableRequest
  | ForgeInvocationStartEligibilityCallableRequest
  | ForgeInvocationStartReservationCallableRequest
  | ForgeInvocationStartReservationLookupCallableRequest
  | ForgeInvocationStartReservationExpirationCallableRequest
  | ForgeInvocationStartReservationListCallableRequest
  | ForgeInvocationReservationReleaseCallableRequest
  | ForgeInvocationReservationLeaseRenewalCallableRequest
  | ForgeInvocationReservationMetricsCallableRequest
  | ForgeInvocationQueueInspectionCallableRequest
  | ForgeSchedulerSnapshotCallableRequest
  | ForgeSchedulerValidationCallableRequest
  | ForgeInvocationStartCallableRequest
  | ForgeInvocationModelCallCallableRequest
  | ForgeInvocationModelResultLookupCallableRequest
  | ForgeFixedMultiAgentGraphCallableRequest
  | ForgeInvocationLifecycleControlCallableRequest;

type ForgeCallableErrorResponse = {
  ok: false;
  method: ForgeCallableMethod | string;
  error: {
    code:
      | 'unknown_method'
      | 'not_found'
      | 'invalid_request'
      | 'unknown_tool'
      | 'missing_permission'
      | 'approval_required'
      | 'elevation_required'
      | 'invalid_permission_context'
      | 'stale_permission_context';
    message: string;
    details?: string[];
    toolId?: string;
    missingCapabilities?: readonly string[];
  };
};

export type ForgeInvocationStatusCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_GET_INVOCATION_STATUS_METHOD;
      status: ForgeInvocationStatus;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationEventsCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_GET_INVOCATION_EVENTS_METHOD;
      events: ForgeInvocationEvents;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationProgressCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_GET_INVOCATION_PROGRESS_METHOD;
      progress: ForgeInvocationProgress;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationPreparationCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_PREPARE_INVOCATION_METHOD;
      preparation: ForgeInvocationPreparation;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationStartEligibilityCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_CAN_START_INVOCATION_METHOD;
      eligibility: ForgeInvocationStartEligibility;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationStartReservationCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_RESERVE_START_INVOCATION_METHOD;
      reservation: ForgeInvocationStartReservation;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationStartReservationLookupCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_GET_START_RESERVATION_METHOD;
      reservationLookup: ForgeInvocationStartReservationLookup;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationStartReservationExpirationCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_EXPIRE_START_RESERVATION_METHOD;
      reservationExpiration: ForgeInvocationStartReservationExpiration;
    }
  | ForgeCallableErrorResponse;
export type ForgeInvocationStartReservationListCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_LIST_START_RESERVATIONS_METHOD;
      reservationList: ForgeInvocationStartReservationList;
    }
  | ForgeCallableErrorResponse;
export type ForgeInvocationReservationReleaseCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_RELEASE_RESERVATION_METHOD;
      reservationRelease: ForgeInvocationReservationRelease;
    }
  | ForgeCallableErrorResponse;
export type ForgeInvocationReservationLeaseRenewalCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_RENEW_RESERVATION_LEASE_METHOD;
      reservationLeaseRenewal: ForgeInvocationReservationLeaseRenewal;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationReservationMetricsCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_RESERVATION_METRICS_METHOD;
      reservationMetrics: ForgeInvocationReservationMetrics;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationQueueInspectionCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_INSPECT_QUEUE_METHOD;
      queueInspection: ForgeInvocationQueueInspection;
    }
  | ForgeCallableErrorResponse;

export type ForgeSchedulerSnapshotCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_SCHEDULER_SNAPSHOT_METHOD;
      schedulerSnapshot: ForgeSchedulerSnapshot;
    }
  | ForgeCallableErrorResponse;

export type ForgeSchedulerValidationCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_SCHEDULER_VALIDATE_METHOD;
      schedulerValidation: ForgeSchedulerValidation;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationStartCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_START_INVOCATION_METHOD;
      start: ForgeInvocationStart;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationModelCallCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_INVOKE_MODEL_METHOD;
      modelCall: ForgeInvocationModelCall;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationModelResultLookupCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_GET_MODEL_EXECUTION_RESULT_METHOD;
      result: ForgeInvocationModelResultLookup;
    }
  | ForgeCallableErrorResponse;

export type ForgeFixedMultiAgentGraphCallableResponse =
  | {
      ok: true;
      method: typeof FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD;
      graph: FixedMultiAgentGraphResult;
    }
  | ForgeCallableErrorResponse;

export type ForgeInvocationLifecycleControlCallableResponse =
  | {
      ok: true;
      method:
        | typeof FORGE_PAUSE_INVOCATION_METHOD
        | typeof FORGE_RESUME_INVOCATION_METHOD
        | typeof FORGE_CANCEL_INVOCATION_METHOD;
      control: ForgeInvocationLifecycleControl;
    }
  | ForgeCallableErrorResponse;

export type ForgeCallableResponse =
  | ForgeInvocationStatusCallableResponse
  | ForgeInvocationEventsCallableResponse
  | ForgeInvocationProgressCallableResponse
  | ForgeInvocationPreparationCallableResponse
  | ForgeInvocationStartEligibilityCallableResponse
  | ForgeInvocationStartReservationCallableResponse
  | ForgeInvocationStartReservationLookupCallableResponse
  | ForgeInvocationStartReservationExpirationCallableResponse
  | ForgeInvocationStartReservationListCallableResponse
  | ForgeInvocationReservationReleaseCallableResponse
  | ForgeInvocationReservationLeaseRenewalCallableResponse
  | ForgeInvocationReservationMetricsCallableResponse
  | ForgeInvocationQueueInspectionCallableResponse
  | ForgeSchedulerSnapshotCallableResponse
  | ForgeSchedulerValidationCallableResponse
  | ForgeInvocationStartCallableResponse
  | ForgeInvocationModelCallCallableResponse
  | ForgeInvocationModelResultLookupCallableResponse
  | ForgeFixedMultiAgentGraphCallableResponse
  | ForgeInvocationLifecycleControlCallableResponse;

type ForgeCallableContext = {
  signal?: AbortSignal;
  permissionContext?: SerializablePermissionContext;
  permissionRunId?: string;
  requirePermissionContext?: boolean;
};

type ForgeCallableHandler = (request: ForgeCallableRequest, context?: ForgeCallableContext) => Promise<ForgeCallableResponse>;

export const FORGE_INVOCATION_STATUS_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_GET_INVOCATION_STATUS_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
};

export const FORGE_INVOCATION_EVENTS_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_GET_INVOCATION_EVENTS_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
};

export const FORGE_INVOCATION_PROGRESS_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_GET_INVOCATION_PROGRESS_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
};

export const FORGE_INVOCATION_PREPARATION_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_PREPARE_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};

export const FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_CAN_START_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};

export const FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RESERVE_START_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'metadata-only',
  nonExecuting: true,
};

export const FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_GET_START_RESERVATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};

export const FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_EXPIRE_START_RESERVATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'metadata-only',
  nonExecuting: true,
};
export const FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_LIST_START_RESERVATIONS_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};
export const FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RELEASE_RESERVATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'metadata-only',
  nonExecuting: true,
};
export const FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RENEW_RESERVATION_LEASE_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'metadata-only',
  nonExecuting: true,
};
export const FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RESERVATION_METRICS_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};
export const FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_INSPECT_QUEUE_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};
export const FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_SCHEDULER_SNAPSHOT_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};
export const FORGE_SCHEDULER_VALIDATE_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_SCHEDULER_VALIDATE_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};
export const FORGE_INVOCATION_START_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_START_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  sideEffects: 'task-lifecycle',
};
export const FORGE_INVOKE_MODEL_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_INVOKE_MODEL_METHOD,
  version: FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  // Model execution is not a task-lifecycle operation (it never calls
  // engine.startTask) and is not metadata-only (it performs exactly one
  // real model invocation), so it gets its own accurate classification.
  sideEffects: 'model-execution',
};

/**
 * M4.5-M4.6: read-only retrieval of a governed model execution's terminal
 * result/evidence. Versioned with `FORGE_MODEL_INVOCATION_CONTRACT_VERSION`
 * (the model-execution contract family), not
 * `FORGE_STATUS_CONTRACT_VERSION`, because it reads model-execution state,
 * not invocation status/reservation/lifecycle state.
 */
export const FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  version: FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: true,
  sideEffects: 'none',
  nonExecuting: true,
};

export const FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  sideEffects: 'model-execution',
};

export const FORGE_INVOCATION_PAUSE_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_PAUSE_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  sideEffects: 'task-lifecycle',
};

export const FORGE_INVOCATION_RESUME_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_RESUME_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  sideEffects: 'task-lifecycle',
};

export const FORGE_INVOCATION_CANCEL_DESCRIPTOR: ForgeCallableDescriptor = {
  id: FORGE_CANCEL_INVOCATION_METHOD,
  version: FORGE_STATUS_CONTRACT_VERSION,
  transport: FORGE_LOCAL_TRANSPORT,
  readOnly: false,
  sideEffects: 'task-lifecycle',
};

export class ReadOnlyForgeCallableSurface {
  constructor(
    private readonly adapter: ReadOnlyForgeInvocationAdapter,
    private readonly fixedMultiAgentGraph?: FixedMultiAgentGraph,
  ) {}

  async call(
    request: ForgeCallableRequest | { method: string; params?: unknown },
    context?: ForgeCallableContext,
  ): Promise<ForgeCallableResponse> {
    try {
      switch (request.method) {
        case FORGE_GET_INVOCATION_STATUS_METHOD: {
          const params = request.params as ForgeInvocationStatusCallableRequest['params'];
          const status = await this.adapter.getStatus({
            invocationId: params.invocationId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_GET_INVOCATION_STATUS_METHOD,
            status,
          };
        }
        case FORGE_GET_INVOCATION_EVENTS_METHOD: {
          const params = request.params as ForgeInvocationEventsCallableRequest['params'];
          const events = await this.adapter.getEvents({
            invocationId: params.invocationId,
            afterSeq: params.afterSeq,
          });

          return {
            ok: true,
            method: FORGE_GET_INVOCATION_EVENTS_METHOD,
            events,
          };
        }
        case FORGE_GET_INVOCATION_PROGRESS_METHOD: {
          const params = request.params as ForgeInvocationProgressCallableRequest['params'];
          const progress = await this.adapter.getProgress({
            invocationId: params.invocationId,
          });

          return {
            ok: true,
            method: FORGE_GET_INVOCATION_PROGRESS_METHOD,
            progress,
          };
        }
        case FORGE_PREPARE_INVOCATION_METHOD: {
          const params = request.params;
          if (!isPreparationParams(params)) {
            return invalidRequest(FORGE_PREPARE_INVOCATION_METHOD, [
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.goal must be a non-empty string',
            ]);
          }

          const preparation = this.adapter.prepare({
            invocationId: params.invocationId,
            taskId: params.taskId,
            goal: params.goal,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_PREPARE_INVOCATION_METHOD,
            preparation,
          };
        }
        case FORGE_CAN_START_INVOCATION_METHOD: {
          const params = request.params;
          if (!isStartEligibilityParams(params)) {
            return invalidRequest(FORGE_CAN_START_INVOCATION_METHOD, [
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.goal must be a non-empty string',
              'params.prepared must be a boolean',
            ]);
          }

          const eligibility = this.adapter.canStart({
            invocationId: params.invocationId,
            taskId: params.taskId,
            goal: params.goal,
            prepared: params.prepared,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_CAN_START_INVOCATION_METHOD,
            eligibility,
          };
        }
        case FORGE_RESERVE_START_INVOCATION_METHOD: {
          const params = request.params;
          if (!isStartEligibilityParams(params)) {
            return invalidRequest(FORGE_RESERVE_START_INVOCATION_METHOD, [
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.goal must be a non-empty string',
              'params.prepared must be a boolean',
            ]);
          }

          const reservation = this.adapter.reserveStart({
            invocationId: params.invocationId,
            taskId: params.taskId,
            goal: params.goal,
            prepared: params.prepared,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_RESERVE_START_INVOCATION_METHOD,
            reservation,
          };
        }
        case FORGE_GET_START_RESERVATION_METHOD: {
          const params = request.params;
          if (!isReservationLookupParams(params)) {
            return invalidRequest(FORGE_GET_START_RESERVATION_METHOD, [
              'params.reservationId must be a non-empty string',
            ]);
          }

          const reservationLookup = this.adapter.getReservation({
            reservationId: params.reservationId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_GET_START_RESERVATION_METHOD,
            reservationLookup,
          };
        }
        case FORGE_EXPIRE_START_RESERVATION_METHOD: {
          const params = request.params;
          if (!isReservationLookupParams(params)) {
            return invalidRequest(FORGE_EXPIRE_START_RESERVATION_METHOD, [
              'params.reservationId must be a non-empty string',
            ]);
          }

          const reservationExpiration = this.adapter.expireReservation({
            reservationId: params.reservationId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_EXPIRE_START_RESERVATION_METHOD,
            reservationExpiration,
          };
        }        case FORGE_LIST_START_RESERVATIONS_METHOD: {
          const params = request.params;
          if (params !== undefined && (!params || typeof params !== 'object')) {
            return invalidRequest(FORGE_LIST_START_RESERVATIONS_METHOD, [
              'params must be an object when provided',
            ]);
          }
          const candidate = params as { includeExpired?: unknown; audit?: ForgeInvocationAuditMetadata } | undefined;
          if (candidate?.includeExpired !== undefined && typeof candidate.includeExpired !== 'boolean') {
            return invalidRequest(FORGE_LIST_START_RESERVATIONS_METHOD, [
              'params.includeExpired must be a boolean when provided',
            ]);
          }

          const reservationList = this.adapter.listReservations({
            includeExpired: candidate?.includeExpired,
            audit: candidate?.audit,
          });

          return {
            ok: true,
            method: FORGE_LIST_START_RESERVATIONS_METHOD,
            reservationList,
          };
        }
        case FORGE_RELEASE_RESERVATION_METHOD: {
          const params = request.params;
          if (!isReservationReleaseParams(params)) {
            return invalidRequest(FORGE_RELEASE_RESERVATION_METHOD, [
              'params.reservationId must be a non-empty string',
              'params.ownerId must be a non-empty string',
            ]);
          }

          const reservationRelease = this.adapter.releaseReservation({
            reservationId: params.reservationId,
            ownerId: params.ownerId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_RELEASE_RESERVATION_METHOD,
            reservationRelease,
          };
        }
        case FORGE_RENEW_RESERVATION_LEASE_METHOD: {
          const params = request.params;
          if (!isReservationReleaseParams(params)) {
            return invalidRequest(FORGE_RENEW_RESERVATION_LEASE_METHOD, [
              'params.reservationId must be a non-empty string',
              'params.ownerId must be a non-empty string',
            ]);
          }

          const reservationLeaseRenewal = this.adapter.renewReservationLease({
            reservationId: params.reservationId,
            ownerId: params.ownerId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_RENEW_RESERVATION_LEASE_METHOD,
            reservationLeaseRenewal,
          };
        }
        case FORGE_RESERVATION_METRICS_METHOD: {
          const params = request.params;
          if (params !== undefined && (!params || typeof params !== 'object')) {
            return invalidRequest(FORGE_RESERVATION_METRICS_METHOD, [
              'params must be an object when provided',
            ]);
          }
          const candidate = params as { audit?: ForgeInvocationAuditMetadata } | undefined;

          const reservationMetrics = this.adapter.reservationMetrics({
            audit: candidate?.audit,
          });

          return {
            ok: true,
            method: FORGE_RESERVATION_METRICS_METHOD,
            reservationMetrics,
          };
        }
        case FORGE_INSPECT_QUEUE_METHOD: {
          const params = request.params;
          if (params !== undefined && (!params || typeof params !== 'object')) {
            return invalidRequest(FORGE_INSPECT_QUEUE_METHOD, [
              'params must be an object when provided',
            ]);
          }
          const candidate = params as { includeExpired?: unknown; audit?: ForgeInvocationAuditMetadata } | undefined;
          if (candidate?.includeExpired !== undefined && typeof candidate.includeExpired !== 'boolean') {
            return invalidRequest(FORGE_INSPECT_QUEUE_METHOD, [
              'params.includeExpired must be a boolean when provided',
            ]);
          }

          const queueInspection = this.adapter.inspectQueue({
            includeExpired: candidate?.includeExpired,
            audit: candidate?.audit,
          });

          return {
            ok: true,
            method: FORGE_INSPECT_QUEUE_METHOD,
            queueInspection,
          };
        }
        case FORGE_SCHEDULER_SNAPSHOT_METHOD: {
          const params = request.params;
          if (params !== undefined && (!params || typeof params !== 'object')) {
            return invalidRequest(FORGE_SCHEDULER_SNAPSHOT_METHOD, [
              'params must be an object when provided',
            ]);
          }
          const candidate = params as { includeExpired?: unknown; audit?: ForgeInvocationAuditMetadata } | undefined;
          if (candidate?.includeExpired !== undefined && typeof candidate.includeExpired !== 'boolean') {
            return invalidRequest(FORGE_SCHEDULER_SNAPSHOT_METHOD, [
              'params.includeExpired must be a boolean when provided',
            ]);
          }

          const schedulerSnapshot = this.adapter.schedulerSnapshot({
            includeExpired: candidate?.includeExpired,
            audit: candidate?.audit,
          });

          return {
            ok: true,
            method: FORGE_SCHEDULER_SNAPSHOT_METHOD,
            schedulerSnapshot,
          };
        }
        case FORGE_SCHEDULER_VALIDATE_METHOD: {
          const params = request.params;
          if (params !== undefined && (!params || typeof params !== 'object')) {
            return invalidRequest(FORGE_SCHEDULER_VALIDATE_METHOD, [
              'params must be an object when provided',
            ]);
          }
          const candidate = params as { audit?: ForgeInvocationAuditMetadata } | undefined;

          const schedulerValidation = this.adapter.schedulerValidate({
            audit: candidate?.audit,
          });

          return {
            ok: true,
            method: FORGE_SCHEDULER_VALIDATE_METHOD,
            schedulerValidation,
          };
        }
        case FORGE_START_INVOCATION_METHOD: {
          const params = request.params;
          if (!isStartParams(params)) {
            return invalidRequest(FORGE_START_INVOCATION_METHOD, [
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.goal must be a non-empty string',
              'params.reservationId must be a non-empty string',
            ]);
          }

          const start = await this.adapter.start({
            invocationId: params.invocationId,
            taskId: params.taskId,
            goal: params.goal,
            reservationId: params.reservationId,
            mode: params.mode,
            model: params.model,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_START_INVOCATION_METHOD,
            start,
          };
        }
        case FORGE_INVOKE_MODEL_METHOD: {
          const params = request.params;
          if (!isModelCallParams(params)) {
            return invalidRequest(FORGE_INVOKE_MODEL_METHOD, [
              'params.reservationId must be a non-empty string',
              'params.model must be a non-empty string',
              'params.audit must be an object, not an array, when provided',
            ]);
          }

          const modelCall = await this.adapter.invokeModel({
            reservationId: params.reservationId,
            model: params.model,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_INVOKE_MODEL_METHOD,
            modelCall,
          };
        }
        case FORGE_GET_MODEL_EXECUTION_RESULT_METHOD: {
          const params = request.params;
          if (!isModelResultLookupParams(params)) {
            return invalidRequest(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, [
              'params.reservationId must be a non-empty string',
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.audit must be an object, not an array, when provided',
            ]);
          }

          const result = this.adapter.getModelExecutionResult({
            reservationId: params.reservationId,
            invocationId: params.invocationId,
            taskId: params.taskId,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
            result,
          };
        }
        case FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD: {
          const params = request.params;
          if (!isFixedMultiAgentGraphParams(params)) {
            return invalidRequest(FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD, [
              'params.invocationId must be a non-empty string',
              'params.taskId must be a non-empty string',
              'params.goal must be a non-empty string',
              'params.model must be a non-empty string',
              'params.workspaceRoot must be a string when provided',
              'params.audit must be an object, not an array, when provided',
            ]);
          }
          if (!this.fixedMultiAgentGraph) {
            return invalidRequest(FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD, [
              'fixed multi-agent graph is not configured',
            ]);
          }

          const graph = await this.fixedMultiAgentGraph.execute({
            contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
            invocationId: params.invocationId,
            taskId: params.taskId,
            goal: params.goal,
            model: params.model,
            workspaceRoot: params.workspaceRoot,
            signal: context?.signal,
            audit: params.audit,
          });

          return {
            ok: true,
            method: FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
            graph,
          };
        }
        case FORGE_PAUSE_INVOCATION_METHOD:
        case FORGE_RESUME_INVOCATION_METHOD:
        case FORGE_CANCEL_INVOCATION_METHOD: {
          const params = request.params;
          if (!isLifecycleControlParams(params)) {
            return invalidRequest(request.method, [
              'params.invocationId must be a non-empty string',
              'params.reason must be a string when provided',
            ]);
          }

          const action = request.method === FORGE_PAUSE_INVOCATION_METHOD
            ? 'pause'
            : request.method === FORGE_RESUME_INVOCATION_METHOD
              ? 'resume'
              : 'cancel';

          const control = await this.adapter.controlLifecycle({
            invocationId: params.invocationId,
            action,
            reason: params.reason,
            audit: params.audit,
          });

          return {
            ok: true,
            method: request.method,
            control,
          };
        }
        default:
          return unknownMethod(request.method);
      }
    } catch (error) {
      return {
        ok: false,
        method: request.method,
        error: {
          code: 'not_found',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }
}

export class ReadOnlyForgeCallableRegistry {
  private readonly callables = new Map<ForgeCallableMethod, {
    descriptor: ForgeCallableDescriptor;
    handler: ForgeCallableHandler;
  }>();
  private readonly governedRegistry = new GovernedToolRegistry();

  register(descriptor: ForgeCallableDescriptor, handler: ForgeCallableHandler): void {
    if (
      !descriptor.readOnly &&
      descriptor.sideEffects !== 'task-lifecycle' &&
      descriptor.sideEffects !== 'model-execution'
    ) {
      throw new Error(`Forge callable mutation must declare task-lifecycle or model-execution side effects: ${descriptor.id}`);
    }
    if (descriptor.transport !== FORGE_LOCAL_TRANSPORT) {
      throw new Error(`Unsupported Forge callable transport: ${descriptor.transport}`);
    }
    if (descriptor.version !== FORGE_STATUS_CONTRACT_VERSION) {
      throw new Error(`Unsupported Forge callable contract version: ${descriptor.version}`);
    }
    if (this.callables.has(descriptor.id)) {
      throw new Error(`Forge callable already registered: ${descriptor.id}`);
    }

    this.callables.set(descriptor.id, {
      descriptor: { ...descriptor },
      handler,
    });
    this.governedRegistry.register(governedDefinitionFromForgeDescriptor(descriptor));
  }

  discover(): ForgeCallableDescriptor[] {
    return [...this.callables.values()]
      .map(entry => ({ ...entry.descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async call(
    request: ForgeCallableRequest | { method: string; params?: unknown },
    context?: {
      permissionContext?: SerializablePermissionContext;
      permissionRunId?: string;
      requirePermissionContext?: boolean;
    },
  ): Promise<ForgeCallableResponse> {
    const entry = this.callables.get(request.method as ForgeCallableMethod);
    if (!entry) {
      return unknownMethod(request.method);
    }
    const denial = this.authorizeCall(entry.descriptor, context);
    if (denial) {
      return permissionDenied(request.method, denial);
    }

    return entry.handler(request as ForgeCallableRequest, context);
  }

  discoverGovernedTools() {
    return this.governedRegistry.list();
  }

  authorizeGovernedTool(id: string, grants: GrantedPermissionSet) {
    return this.governedRegistry.authorize(id, grants);
  }

  private authorizeCall(
    descriptor: ForgeCallableDescriptor,
    context?: {
      permissionContext?: SerializablePermissionContext;
      permissionRunId?: string;
      requirePermissionContext?: boolean;
    },
  ): PermissionDenial | undefined {
    if (!context?.permissionContext) {
      return context?.requirePermissionContext
        ? {
          code: 'invalid_permission_context',
          toolId: `forge.${descriptor.id}`,
          message: 'No permission context was bound to this Forge invocation.',
        }
        : undefined;
    }
    const runId = context.permissionRunId;
    if (!runId) {
      return {
        code: 'invalid_permission_context',
        toolId: `forge.${descriptor.id}`,
        profileId: context.permissionContext.profileId,
        message: 'No run id was available for Forge permission binding.',
      };
    }
    const toolId = `forge.${descriptor.id}`;
    const validation = validateBoundPermissionContext(context.permissionContext, runId, toolId);
    if (!validation.ok) {
      return {
        code: validation.code,
        toolId,
        profileId: context.permissionContext.profileId,
        message: validation.message,
      };
    }
    const decision = this.governedRegistry.authorize(toolId, grantsFromPermissionContext(validation.context));
    return denialFromAuthorization(decision, validation.context.profileId);
  }
}

export class LocalForgeCallableTransport {
  constructor(private readonly registry: ReadOnlyForgeCallableRegistry) {}

  discover(): ForgeCallableDescriptor[] {
    return this.registry.discover();
  }

  discoverGovernedTools() {
    return this.registry.discoverGovernedTools();
  }

  authorizeGovernedTool(id: string, grants: GrantedPermissionSet) {
    return this.registry.authorizeGovernedTool(id, grants);
  }

  async invoke(
    method: string,
    params?: unknown,
    context?: {
      permissionContext?: SerializablePermissionContext;
      permissionRunId?: string;
      requirePermissionContext?: boolean;
    },
  ): Promise<ForgeCallableResponse> {
    return this.registry.call({ method, params }, context);
  }
}

export function registerReadOnlyForgeStatusCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_STATUS_DESCRIPTOR, request => surface.call(request));
}

export function registerReadOnlyForgeObservabilityCallables(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_STATUS_DESCRIPTOR, request => surface.call(request));
  registry.register(FORGE_INVOCATION_EVENTS_DESCRIPTOR, request => surface.call(request));
  registry.register(FORGE_INVOCATION_PROGRESS_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvocationPreparationCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_PREPARATION_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvocationStartEligibilityCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvocationStartReservationCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvocationStartReservationLookupCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvocationStartReservationExpirationCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationStartReservationListCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationReservationReleaseCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationReservationLeaseRenewalCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationReservationMetricsCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationQueueInspectionCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeSchedulerSnapshotCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeSchedulerValidateCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_SCHEDULER_VALIDATE_DESCRIPTOR, request => surface.call(request));
}
export function registerGovernedForgeInvocationStartCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_START_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeInvokeModelCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeModelExecutionResultCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR, request => surface.call(request));
}

export function registerGovernedForgeFixedMultiAgentGraphCallable(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_DESCRIPTOR, (request, context) => surface.call(request, context));
}

export function registerForgeLifecycleControlCallables(
  registry: ReadOnlyForgeCallableRegistry,
  surface: ReadOnlyForgeCallableSurface,
): void {
  registry.register(FORGE_INVOCATION_PAUSE_DESCRIPTOR, request => surface.call(request));
  registry.register(FORGE_INVOCATION_RESUME_DESCRIPTOR, request => surface.call(request));
  registry.register(FORGE_INVOCATION_CANCEL_DESCRIPTOR, request => surface.call(request));
}
function unknownMethod(method: string): ForgeCallableErrorResponse {
  return {
    ok: false,
    method,
    error: {
      code: 'unknown_method',
      message: `Unsupported Forge callable method: ${method}`,
    },
  };
}

function invalidRequest(method: ForgeCallableMethod, details: string[]): ForgeCallableErrorResponse {
  return {
    ok: false,
    method,
    error: {
      code: 'invalid_request',
      message: `Invalid Forge callable request for ${method}`,
      details,
    },
  };
}

function permissionDenied(method: ForgeCallableMethod | string, denial: PermissionDenial): ForgeCallableErrorResponse {
  return {
    ok: false,
    method,
    error: {
      code: denial.code,
      message: formatPermissionDenial(denial),
      toolId: denial.toolId,
      missingCapabilities: denial.missingCapabilities,
    },
  };
}

function isPreparationParams(params: unknown): params is ForgeInvocationPreparationCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.invocationId)
    && isNonEmptyString(candidate.taskId)
    && isNonEmptyString(candidate.goal)
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}

function isStartEligibilityParams(params: unknown): params is ForgeInvocationStartEligibilityCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.invocationId)
    && isNonEmptyString(candidate.taskId)
    && isNonEmptyString(candidate.goal)
    && typeof candidate.prepared === 'boolean'
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}

function isReservationLookupParams(params: unknown): params is ForgeInvocationStartReservationLookupCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.reservationId)
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}

function isReservationReleaseParams(params: unknown): params is ForgeInvocationReservationReleaseCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.reservationId)
    && isNonEmptyString(candidate.ownerId)
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}

function isLifecycleControlParams(params: unknown): params is ForgeInvocationLifecycleControlCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.invocationId)
    && (candidate.reason === undefined || typeof candidate.reason === 'string')
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}
function isStartParams(params: unknown): params is ForgeInvocationStartCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.invocationId)
    && isNonEmptyString(candidate.taskId)
    && isNonEmptyString(candidate.goal)
    && isNonEmptyString(candidate.reservationId)
    && (candidate.mode === undefined || candidate.mode === 'agent' || candidate.mode === 'ask')
    && (candidate.model === undefined || typeof candidate.model === 'string')
    && (candidate.audit === undefined || (typeof candidate.audit === 'object' && candidate.audit !== null));
}

function isModelCallParams(params: unknown): params is ForgeInvocationModelCallCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.reservationId)
    && isNonEmptyString(candidate.model)
    && (candidate.audit === undefined || isAuditMetadataShape(candidate.audit));
}

function isModelResultLookupParams(params: unknown): params is ForgeInvocationModelResultLookupCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.reservationId)
    && isNonEmptyString(candidate.invocationId)
    && isNonEmptyString(candidate.taskId)
    && (candidate.audit === undefined || isAuditMetadataShape(candidate.audit));
}

function isFixedMultiAgentGraphParams(params: unknown): params is ForgeFixedMultiAgentGraphCallableRequest['params'] {
  if (!params || typeof params !== 'object') {
    return false;
  }
  const candidate = params as Record<string, unknown>;
  return isNonEmptyString(candidate.invocationId)
    && isNonEmptyString(candidate.taskId)
    && isNonEmptyString(candidate.goal)
    && isNonEmptyString(candidate.model)
    && (candidate.workspaceRoot === undefined || typeof candidate.workspaceRoot === 'string')
    && (candidate.audit === undefined || isAuditMetadataShape(candidate.audit));
}

function isAuditMetadataShape(value: unknown): value is ForgeInvocationAuditMetadata {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}





