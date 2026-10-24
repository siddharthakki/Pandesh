import { LocalRpcDispatcher } from '../runtime/LocalRpcServer';
import { ForgeRpcCallableTransport } from './ForgeRpcCancellationTransport';
import {
  FORGE_CANCEL_INVOCATION_METHOD,
  FORGE_CAN_START_INVOCATION_METHOD,
  FORGE_EXPIRE_START_RESERVATION_METHOD,
  ForgeCallableMethod,
  FORGE_GET_INVOCATION_EVENTS_METHOD,
  FORGE_GET_INVOCATION_PROGRESS_METHOD,
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_GET_START_RESERVATION_METHOD,
  FORGE_INSPECT_QUEUE_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_LIST_START_RESERVATIONS_METHOD,
  FORGE_PAUSE_INVOCATION_METHOD,
  FORGE_PREPARE_INVOCATION_METHOD,
  FORGE_RELEASE_RESERVATION_METHOD,
  FORGE_RENEW_RESERVATION_LEASE_METHOD,
  FORGE_RESERVATION_METRICS_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_RESUME_INVOCATION_METHOD,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
  FORGE_SCHEDULER_SNAPSHOT_METHOD,
  FORGE_SCHEDULER_VALIDATE_METHOD,
  FORGE_START_INVOCATION_METHOD,
} from './ForgeCallableSurface';
import { PermissionProfileId } from '../tools/PermissionProfiles';
import { createPermissionContext } from '../tools/PermissionContext';

export const FORGE_DISCOVER_RPC_METHOD = 'forge.discover' as const;

export interface ForgeRpcPermissionHostDecisions {
  approvalGranted(method: ForgeCallableMethod, runId: string): boolean;
  elevationGranted(method: ForgeCallableMethod, runId: string): boolean;
}

/**
 * RPC exposure of the governed Forge callable surface. Every registered
 * handler retains the one transport composed for the service lifetime.
 *
 * The RPC request context is carried beside serialized params and is used
 * only by the cancellation-aware local transport for invokeModel. No
 * AbortSignal enters ForgeCallableRequest, descriptors, JSON payloads or
 * public callable contracts.
 */
export function registerForgeCallableRpc(
  dispatcher: LocalRpcDispatcher,
  transport: ForgeRpcCallableTransport,
  hostDecisions?: ForgeRpcPermissionHostDecisions,
): void {
  dispatcher.register(FORGE_DISCOVER_RPC_METHOD, async () => transport.discover());
  for (const { id } of transport.discover()) {
    dispatcher.register(id, async (params, context) => {
      const binding = forgePermissionBinding(id, params, context.clientId);
      return transport.invoke(id, params, {
        signal: context.signal,
        requirePermissionContext: true,
        permissionRunId: binding.runId,
        permissionContext: binding.runId
          ? createPermissionContext(binding.profileId, 'run-bound', {
            runId: binding.runId,
            toolId: `forge.${id}`,
            approvalGranted: hostDecisions?.approvalGranted(id, binding.runId) === true,
            elevationGranted: hostDecisions?.elevationGranted(id, binding.runId) === true,
          })
          : undefined,
      });
    });
  }
}

export function forgePermissionBinding(
  method: ForgeCallableMethod,
  params: unknown,
  requestOwnerId = 'local-dispatcher',
): { profileId: PermissionProfileId; runId?: string } {
  switch (method) {
    case FORGE_GET_INVOCATION_STATUS_METHOD:
    case FORGE_GET_INVOCATION_EVENTS_METHOD:
    case FORGE_GET_INVOCATION_PROGRESS_METHOD:
      return { profileId: 'workspace-read', runId: invocationBinding(params) };
    case FORGE_PREPARE_INVOCATION_METHOD:
    case FORGE_CAN_START_INVOCATION_METHOD:
      return { profileId: 'workspace-read', runId: taskInvocationBinding(params) };
    case FORGE_RESERVE_START_INVOCATION_METHOD:
      return { profileId: 'metadata-state', runId: taskInvocationBinding(params) };
    case FORGE_GET_START_RESERVATION_METHOD:
      return { profileId: 'workspace-read', runId: reservationBinding(params) };
    case FORGE_GET_MODEL_EXECUTION_RESULT_METHOD:
      return { profileId: 'workspace-read', runId: taskInvocationReservationBinding(params) };
    case FORGE_LIST_START_RESERVATIONS_METHOD:
    case FORGE_INSPECT_QUEUE_METHOD:
    case FORGE_SCHEDULER_SNAPSHOT_METHOD:
    case FORGE_SCHEDULER_VALIDATE_METHOD:
      return { profileId: 'workspace-read', runId: requestBinding(method, requestOwnerId) };
    case FORGE_EXPIRE_START_RESERVATION_METHOD:
      return { profileId: 'metadata-state', runId: reservationBinding(params) };
    case FORGE_RELEASE_RESERVATION_METHOD:
    case FORGE_RENEW_RESERVATION_LEASE_METHOD:
      return { profileId: 'metadata-state', runId: reservationOwnerBinding(params) };
    case FORGE_RESERVATION_METRICS_METHOD:
      return { profileId: 'metadata-state', runId: requestBinding(method, requestOwnerId) };
    case FORGE_START_INVOCATION_METHOD:
      return { profileId: 'task-lifecycle-control', runId: taskInvocationReservationBinding(params) };
    case FORGE_PAUSE_INVOCATION_METHOD:
    case FORGE_RESUME_INVOCATION_METHOD:
    case FORGE_CANCEL_INVOCATION_METHOD:
      return { profileId: 'task-lifecycle-control', runId: invocationBinding(params) };
    case FORGE_INVOKE_MODEL_METHOD:
      return { profileId: 'model-provider-access', runId: reservationBinding(params) };
    case FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD:
      return { profileId: 'model-provider-access', runId: taskInvocationBinding(params) };
  }
  return assertNever(method);
}

function invocationBinding(params: unknown): string | undefined {
  const invocationId = stringValue(paramsRecord(params)?.invocationId);
  return invocationId ? `invocation:${invocationId}` : undefined;
}

function taskInvocationBinding(params: unknown): string | undefined {
  const record = paramsRecord(params);
  const taskId = stringValue(record?.taskId);
  const invocationId = stringValue(record?.invocationId);
  return taskId && invocationId ? `task:${taskId}:invocation:${invocationId}` : undefined;
}

function taskInvocationReservationBinding(params: unknown): string | undefined {
  const record = paramsRecord(params);
  const taskId = stringValue(record?.taskId);
  const invocationId = stringValue(record?.invocationId);
  const reservationId = stringValue(record?.reservationId);
  return taskId && invocationId && reservationId
    ? `task:${taskId}:invocation:${invocationId}:reservation:${reservationId}`
    : undefined;
}

function reservationBinding(params: unknown): string | undefined {
  const reservationId = stringValue(paramsRecord(params)?.reservationId);
  return reservationId ? `reservation:${reservationId}` : undefined;
}

function reservationOwnerBinding(params: unknown): string | undefined {
  const record = paramsRecord(params);
  const reservationId = stringValue(record?.reservationId);
  const ownerId = stringValue(record?.ownerId);
  return reservationId && ownerId ? `reservation:${reservationId}:owner:${ownerId}` : undefined;
}

function requestBinding(method: ForgeCallableMethod, requestOwnerId: string): string {
  return `request:${requestOwnerId}:${method}`;
}

function paramsRecord(params: unknown): Record<string, unknown> | undefined {
  const record = params && typeof params === 'object' && !Array.isArray(params)
    ? params as Record<string, unknown>
    : undefined;
  return record;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Forge callable method: ${value}`);
}
