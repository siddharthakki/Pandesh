import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import { composeGovernedForgeExecution } from '../../agent/ForgeGovernedExecutionComposition';
import {
  FORGE_CAN_START_INVOCATION_METHOD,
  FORGE_CANCEL_INVOCATION_METHOD,
  FORGE_EXPIRE_START_RESERVATION_METHOD,
  FORGE_GET_INVOCATION_EVENTS_METHOD,
  FORGE_GET_INVOCATION_PROGRESS_METHOD,
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_GET_START_RESERVATION_METHOD,
  FORGE_INSPECT_QUEUE_METHOD,
  FORGE_INVOCATION_CANCEL_DESCRIPTOR,
  FORGE_INVOCATION_EVENTS_DESCRIPTOR,
  FORGE_INVOCATION_PAUSE_DESCRIPTOR,
  FORGE_INVOCATION_PREPARATION_DESCRIPTOR,
  FORGE_INVOCATION_PROGRESS_DESCRIPTOR,
  FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR,
  FORGE_INVOCATION_RESUME_DESCRIPTOR,
  FORGE_INVOCATION_START_DESCRIPTOR,
  FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR,
  FORGE_INVOCATION_STATUS_DESCRIPTOR,
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_LIST_START_RESERVATIONS_METHOD,
  FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
  FORGE_PAUSE_INVOCATION_METHOD,
  FORGE_PREPARE_INVOCATION_METHOD,
  FORGE_RELEASE_RESERVATION_METHOD,
  FORGE_RENEW_RESERVATION_LEASE_METHOD,
  FORGE_RESERVATION_METRICS_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_RESUME_INVOCATION_METHOD,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_DESCRIPTOR,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
  FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR,
  FORGE_SCHEDULER_SNAPSHOT_METHOD,
  FORGE_SCHEDULER_VALIDATE_DESCRIPTOR,
  FORGE_SCHEDULER_VALIDATE_METHOD,
  FORGE_START_INVOCATION_METHOD,
  ForgeCallableDescriptor,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
} from '../../agent/ForgeCallableSurface';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Governed execution composition test',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

const ALL_FORGE_CALLABLE_METHODS: readonly string[] = [
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_GET_INVOCATION_EVENTS_METHOD,
  FORGE_GET_INVOCATION_PROGRESS_METHOD,
  FORGE_PREPARE_INVOCATION_METHOD,
  FORGE_CAN_START_INVOCATION_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_GET_START_RESERVATION_METHOD,
  FORGE_EXPIRE_START_RESERVATION_METHOD,
  FORGE_LIST_START_RESERVATIONS_METHOD,
  FORGE_RELEASE_RESERVATION_METHOD,
  FORGE_RENEW_RESERVATION_LEASE_METHOD,
  FORGE_RESERVATION_METRICS_METHOD,
  FORGE_INSPECT_QUEUE_METHOD,
  FORGE_SCHEDULER_SNAPSHOT_METHOD,
  FORGE_SCHEDULER_VALIDATE_METHOD,
  FORGE_START_INVOCATION_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_METHOD,
  FORGE_PAUSE_INVOCATION_METHOD,
  FORGE_RESUME_INVOCATION_METHOD,
  FORGE_CANCEL_INVOCATION_METHOD,
];

const ALL_FORGE_CALLABLE_DESCRIPTORS: readonly ForgeCallableDescriptor[] = [
  FORGE_INVOCATION_STATUS_DESCRIPTOR,
  FORGE_INVOCATION_EVENTS_DESCRIPTOR,
  FORGE_INVOCATION_PROGRESS_DESCRIPTOR,
  FORGE_INVOCATION_PREPARATION_DESCRIPTOR,
  FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR,
  FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR,
  FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR,
  FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR,
  FORGE_SCHEDULER_VALIDATE_DESCRIPTOR,
  FORGE_INVOCATION_START_DESCRIPTOR,
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_DESCRIPTOR,
  FORGE_INVOCATION_PAUSE_DESCRIPTOR,
  FORGE_INVOCATION_RESUME_DESCRIPTOR,
  FORGE_INVOCATION_CANCEL_DESCRIPTOR,
];

describe('Governed Forge execution production composition (M5.1)', () => {
  let root: string;
  let secrets: vscode.SecretStorage;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-compose-'));
    secrets = secretStorage();
    runtime = new AgentRuntime(root, secrets);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTask(taskId: string): Promise<void> {
    await runtime.taskStore.createTask({ taskId, ...BASE_TASK });
    await runtime.taskStore.updateTask(taskId, {
      phase: 'executing',
      status: 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      engineUsage: createInitialUsage('2026-01-01T00:00:00.000Z'),
    });
  }

  async function reserveThroughTransport(
    transport: LocalForgeCallableTransport,
    invocationId: string,
    taskId: string,
  ): Promise<string> {
    const response = await transport.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    });
    if (!response.ok || response.method !== FORGE_RESERVE_START_INVOCATION_METHOD) {
      throw new Error(`Unexpected reserveStart response: ${JSON.stringify(response)}`);
    }
    expect(response.reservation.accepted).toBe(true);
    return response.reservation.reservationId!;
  }

  it('composes the governed execution graph from the production AgentRuntime', () => {
    const composition = runtime.composeGovernedForgeExecution();

    expect(composition.registry).toBeInstanceOf(ReadOnlyForgeCallableRegistry);
    expect(composition.transport).toBeInstanceOf(LocalForgeCallableTransport);
    expect(composition.transport.discover()).toHaveLength(ALL_FORGE_CALLABLE_METHODS.length);
  });

  it('makes every existing governed Forge callable method discoverable through the composed transport', () => {
    const { transport } = runtime.composeGovernedForgeExecution();

    const discovered = transport.discover().map(descriptor => descriptor.id);
    expect(discovered).toEqual([...ALL_FORGE_CALLABLE_METHODS].sort((a, b) => a.localeCompare(b)));
  });

  it('preserves existing callable descriptors, contract versions and side-effect metadata unchanged', () => {
    const { transport } = runtime.composeGovernedForgeExecution();

    const expected = [...ALL_FORGE_CALLABLE_DESCRIPTORS]
      .map(descriptor => ({ ...descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(transport.discover()).toEqual(expected);

    const byId = new Map(transport.discover().map(descriptor => [descriptor.id, descriptor]));
    expect(byId.get(FORGE_INVOKE_MODEL_METHOD)?.version).toBe(FORGE_MODEL_INVOCATION_CONTRACT_VERSION);
    expect(byId.get(FORGE_INVOKE_MODEL_METHOD)?.sideEffects).toBe('model-execution');
    expect(byId.get(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD)?.readOnly).toBe(true);
    expect(byId.get(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD)?.nonExecuting).toBe(true);
    expect(byId.get(FORGE_START_INVOCATION_METHOD)?.sideEffects).toBe('task-lifecycle');
  });

  it('reads invocation status through the production runtime rather than a duplicate engine', async () => {
    const taskId = 'task_compose_status';
    await createTask(taskId);
    const { transport } = runtime.composeGovernedForgeExecution([
      { invocationId: 'inv_compose_status', taskId },
    ]);

    const response = await transport.invoke(FORGE_GET_INVOCATION_STATUS_METHOD, {
      invocationId: 'inv_compose_status',
    });

    if (!response.ok || response.method !== FORGE_GET_INVOCATION_STATUS_METHOD) {
      throw new Error(`Unexpected getStatus response: ${JSON.stringify(response)}`);
    }
    expect(response.status.invocationId).toBe('inv_compose_status');
    expect(response.status.taskId).toBe(taskId);
  });

  it('backs the governed dispatcher with ProviderGatewayGovernedModelExecutionDependency over the runtime secrets', async () => {
    const taskId = 'task_compose_model';
    await createTask(taskId);
    const provider = new MockProvider();
    provider.enqueueText('governed ok');
    const createSpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const { transport } = runtime.composeGovernedForgeExecution();
    const reservationId = await reserveThroughTransport(transport, 'inv_compose_model', taskId);

    const response = await transport.invoke(FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });

    if (!response.ok || response.method !== FORGE_INVOKE_MODEL_METHOD) {
      throw new Error(`Unexpected invokeModel response: ${JSON.stringify(response)}`);
    }
    expect(response.modelCall.invoked).toBe(true);
    expect(response.modelCall.completion).toBe('governed ok');
    expect(response.modelCall.evidence.status).toBe('completed');
    expect(response.modelCall.evidence.providerType).toBe('ollama');
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBe(secrets);
    expect(provider.capturedRequests).toHaveLength(1);
    expect(provider.capturedRequests[0].tools).toEqual([]);
    expect(provider.capturedRequests[0].messages[0].content).toBe('Summarize the current diff.');
  });

  it('connects adapter, surface, registry and transport into one graph sharing reservation state', async () => {
    const taskId = 'task_compose_graph';
    await createTask(taskId);
    const provider = new MockProvider();
    provider.enqueueText('graph ok');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const { transport } = runtime.composeGovernedForgeExecution();
    const reservationId = await reserveThroughTransport(transport, 'inv_compose_graph', taskId);

    const invoked = await transport.invoke(FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });
    expect(invoked.ok).toBe(true);

    const lookup = await transport.invoke(FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId: 'inv_compose_graph',
      taskId,
    });

    if (!lookup.ok || lookup.method !== FORGE_GET_MODEL_EXECUTION_RESULT_METHOD) {
      throw new Error(`Unexpected result lookup response: ${JSON.stringify(lookup)}`);
    }
    expect(lookup.result.found).toBe(true);
    expect(lookup.result.ready).toBe(true);
    expect(lookup.result.outcome).toBe('completed');
    expect(lookup.result.invocationId).toBe('inv_compose_graph');
    expect(lookup.result.taskId).toBe(taskId);
  });

  it('performs no execution side effects at construction time', async () => {
    const createSpy = vi.spyOn(ProviderGateway, 'create');
    const startSpy = vi.spyOn(runtime, 'startTask');
    const runSpy = vi.spyOn(runtime, 'run');
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    vi.useFakeTimers();

    const composition = runtime.composeGovernedForgeExecution();

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(createSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();

    const response = await composition.transport.invoke(FORGE_LIST_START_RESERVATIONS_METHOD);
    if (!response.ok || response.method !== FORGE_LIST_START_RESERVATIONS_METHOD) {
      throw new Error(`Unexpected listReservations response: ${JSON.stringify(response)}`);
    }
    expect(response.reservationList.total).toBe(0);
    expect(response.reservationList.reservations).toEqual([]);
  });

  it('composes independent graphs on repeated composition instead of sharing hidden state', async () => {
    const taskId = 'task_compose_isolated';
    await createTask(taskId);
    const first = runtime.composeGovernedForgeExecution();
    const second = runtime.composeGovernedForgeExecution();

    await reserveThroughTransport(first.transport, 'inv_compose_isolated', taskId);

    const firstList = await first.transport.invoke(FORGE_LIST_START_RESERVATIONS_METHOD);
    const secondList = await second.transport.invoke(FORGE_LIST_START_RESERVATIONS_METHOD);
    if (!firstList.ok || firstList.method !== FORGE_LIST_START_RESERVATIONS_METHOD) {
      throw new Error(`Unexpected listReservations response: ${JSON.stringify(firstList)}`);
    }
    if (!secondList.ok || secondList.method !== FORGE_LIST_START_RESERVATIONS_METHOD) {
      throw new Error(`Unexpected listReservations response: ${JSON.stringify(secondList)}`);
    }
    expect(firstList.reservationList.total).toBe(1);
    expect(secondList.reservationList.total).toBe(0);
  });

  it('accepts the runtime as its engine dependency directly through the composition module', async () => {
    const taskId = 'task_compose_module';
    await createTask(taskId);
    const { transport } = composeGovernedForgeExecution({
      engine: runtime,
      secrets,
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(transport.discover()).toHaveLength(ALL_FORGE_CALLABLE_METHODS.length);

    const response = await transport.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_compose_module',
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    });
    if (!response.ok || response.method !== FORGE_RESERVE_START_INVOCATION_METHOD) {
      throw new Error(`Unexpected reserveStart response: ${JSON.stringify(response)}`);
    }
    expect(response.reservation.accepted).toBe(true);
    expect(response.reservation.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });
});
