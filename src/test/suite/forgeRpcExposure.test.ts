import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import {
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
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
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_RUN_FIXED_MULTI_AGENT_GRAPH_DESCRIPTOR,
  FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR,
  FORGE_SCHEDULER_VALIDATE_DESCRIPTOR,
  FORGE_START_INVOCATION_METHOD,
  ForgeCallableDescriptor,
  LocalForgeCallableTransport,
} from '../../agent/ForgeCallableSurface';
import { FORGE_DISCOVER_RPC_METHOD } from '../../agent/ForgeRpcRegistration';
import { RpcServiceLifecycle } from '../../runtime/RpcServiceLifecycle';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

const ACCESS_KEY = 'forge-rpc-exposure-test-key-0001';

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
  userGoal: 'Forge RPC exposure test',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

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

describe('Governed Forge RPC exposure (M5.2)', () => {
  let root: string;
  let secrets: vscode.SecretStorage;
  let runtime: AgentRuntime;
  let requestId = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-rpc-'));
    secrets = secretStorage();
    runtime = new AgentRuntime(root, secrets);
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    // createRpcService records an observability event asynchronously; retry
    // so cleanup does not race that pending write on Windows.
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

  /**
   * Sends one JSON-RPC request through the public dispatch surface exactly
   * as a transport host would: a serialized JSON payload plus access key.
   */
  async function rpc(service: RpcServiceLifecycle, method: string, params?: unknown, accessKey = ACCESS_KEY) {
    return service.dispatcher.dispatch(
      JSON.stringify({ jsonrpc: '2.0', id: `req_${++requestId}`, method, params }),
      accessKey,
    );
  }

  function okResult(response: { result?: unknown; error?: { code: number; message: string } } | null): Record<string, unknown> {
    if (!response || response.error || !response.result || typeof response.result !== 'object') {
      throw new Error(`Expected a successful RPC result: ${JSON.stringify(response)}`);
    }
    return response.result as Record<string, unknown>;
  }

  async function reserveViaRpc(service: RpcServiceLifecycle, invocationId: string, taskId: string): Promise<string> {
    const result = okResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    }));
    expect(result['ok']).toBe(true);
    const reservation = result['reservation'] as { accepted: boolean; reservationId?: string };
    expect(reservation.accepted).toBe(true);
    return reservation.reservationId!;
  }

  it('constructs the RPC service with the governed Forge surface registered and stays inert', async () => {
    const composeSpy = vi.spyOn(runtime, 'composeGovernedForgeExecution');
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create');
    const startSpy = vi.spyOn(runtime, 'startTask');
    const runSpy = vi.spyOn(runtime, 'run');
    const listenSpy = vi.spyOn(net.Server.prototype, 'listen');
    vi.useFakeTimers();

    const service = runtime.createRpcService(ACCESS_KEY);

    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    expect(composeSpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(runSpy).not.toHaveBeenCalled();
    expect(listenSpy).not.toHaveBeenCalled();
    expect(service.isRunning()).toBe(false);
    expect(service.address()).toBeNull();

    const methods = service.dispatcher.listMethods();
    expect(methods).toContain(FORGE_DISCOVER_RPC_METHOD);
    for (const descriptor of ALL_FORGE_CALLABLE_DESCRIPTORS) {
      expect(methods).toContain(descriptor.id);
    }

    // Construction created no reservation: the retained graph starts empty.
    const list = okResult(await rpc(service, FORGE_LIST_START_RESERVATIONS_METHOD));
    expect(list['reservationList']).toMatchObject({ total: 0, reservations: [] });
    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  it('composes the governed graph exactly once per service and never inside request handlers', async () => {
    const composeSpy = vi.spyOn(runtime, 'composeGovernedForgeExecution');
    const service = runtime.createRpcService(ACCESS_KEY);
    expect(composeSpy).toHaveBeenCalledTimes(1);

    await rpc(service, FORGE_DISCOVER_RPC_METHOD);
    await rpc(service, FORGE_LIST_START_RESERVATIONS_METHOD);
    await rpc(service, FORGE_LIST_START_RESERVATIONS_METHOD);

    expect(composeSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes all 22 governed callable descriptors through forge.discover', async () => {
    const service = runtime.createRpcService(ACCESS_KEY);

    const response = await rpc(service, FORGE_DISCOVER_RPC_METHOD);
    const expected = [...ALL_FORGE_CALLABLE_DESCRIPTORS]
      .map(descriptor => ({ ...descriptor }))
      .sort((left, right) => left.id.localeCompare(right.id));
    expect(response?.error).toBeUndefined();
    expect(response?.result).toEqual(expected);

    const descriptors = response?.result as ForgeCallableDescriptor[];
    expect(descriptors).toHaveLength(22);
    const invokeModel = descriptors.find(descriptor => descriptor.id === FORGE_INVOKE_MODEL_METHOD);
    expect(invokeModel?.version).toBe(FORGE_MODEL_INVOCATION_CONTRACT_VERSION);
    expect(invokeModel?.sideEffects).toBe('model-execution');
  });

  it('delegates a valid request to the retained transport and returns its envelope untouched', async () => {
    const taskId = 'task_rpc_delegate';
    await createTask(taskId);
    const invokeSpy = vi.spyOn(LocalForgeCallableTransport.prototype, 'invoke');
    const service = runtime.createRpcService(ACCESS_KEY);

    const params = {
      invocationId: 'inv_rpc_delegate',
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    };
    const result = okResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, params));

    expect(invokeSpy).toHaveBeenCalledTimes(1);
    expect(invokeSpy).toHaveBeenCalledWith(
      FORGE_RESERVE_START_INVOCATION_METHOD,
      params,
      expect.objectContaining({
        requirePermissionContext: true,
        permissionRunId: 'task:task_rpc_delegate:invocation:inv_rpc_delegate',
      }),
    );
    // The RPC result is the transport's own response envelope, verbatim.
    expect(result).toEqual(await invokeSpy.mock.results[0].value);
    expect(result['ok']).toBe(true);
    expect(result['method']).toBe(FORGE_RESERVE_START_INVOCATION_METHOD);
  });

  it('keeps production model invocation denied without a trusted approval decision', async () => {
    const taskId = 'task_rpc_continuity';
    await createTask(taskId);
    const provider = new MockProvider();
    provider.enqueueText('rpc governed ok');
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const service = runtime.createRpcService(ACCESS_KEY);

    // RPC request 1: reserve.
    const reservationId = await reserveViaRpc(service, 'inv_rpc_continuity', taskId);

    // RPC request 2: invoke, authorized only by the retained reservation and host decision.
    const invoke = okResult(await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    }));
    expect(invoke).toMatchObject({ ok: false, error: { code: 'approval_required' } });

    // RPC request 3: retrieve remains governed and non-executing.
    const lookup = okResult(await rpc(service, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId: 'inv_rpc_continuity',
      taskId,
    }));
    expect(lookup['ok']).toBe(true);
    const result = lookup['result'] as { found: boolean; ready: boolean; outcome: string };
    expect(result.found).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.outcome).toBe('pending');

    expect(gatewaySpy).toHaveBeenCalledTimes(0);
    expect(provider.capturedRequests).toHaveLength(0);
  });

  it('keeps production start invocation denied without a trusted approval decision', async () => {
    const taskId = 'task_rpc_engine';
    await createTask(taskId);
    const startSpy = vi.spyOn(runtime, 'startTask')
      .mockImplementation(async request => runtime.getTask(request.taskId ?? taskId));
    const service = runtime.createRpcService(ACCESS_KEY);

    const reservationId = await reserveViaRpc(service, 'inv_rpc_engine', taskId);

    const start = okResult(await rpc(service, FORGE_START_INVOCATION_METHOD, {
      invocationId: 'inv_rpc_engine',
      taskId,
      goal: 'Summarize the current diff.',
      reservationId,
    }));
    expect(start).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    expect(startSpy).toHaveBeenCalledTimes(0);

    // The retained adapter still owns the reservation graph and status path,
    // but lifecycle execution did not run without approval.
    const status = okResult(await rpc(service, FORGE_GET_INVOCATION_STATUS_METHOD, {
      invocationId: 'inv_rpc_engine',
    }));
    expect(status).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('rejects unknown Forge methods, malformed outer requests and wrong access keys with the established RPC errors', async () => {
    const service = runtime.createRpcService(ACCESS_KEY);

    const unknown = await rpc(service, 'forge.invocation.doesNotExist');
    expect(unknown?.error).toEqual({ code: -32601, message: 'Method not found.' });

    const denied = await rpc(service, FORGE_DISCOVER_RPC_METHOD, undefined, 'wrong-key-wrong-key-wrong-key');
    expect(denied?.error).toEqual({ code: -32001, message: 'Access denied.' });

    const unparseable = await service.dispatcher.dispatch('not json{', ACCESS_KEY);
    expect(unparseable?.error).toEqual({ code: -32700, message: 'Parse error.' });

    const invalidShape = await service.dispatcher.dispatch(JSON.stringify({ id: 1, params: {} }), ACCESS_KEY);
    expect(invalidShape?.error).toEqual({ code: -32600, message: 'Invalid request.' });
  });

  it('denies malformed identity-bearing callable requests before handler validation', async () => {
    const service = runtime.createRpcService(ACCESS_KEY);

    const result = okResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_rpc_malformed',
    }));

    expect(result).toEqual({
      ok: false,
      method: FORGE_RESERVE_START_INVOCATION_METHOD,
      error: {
        code: 'invalid_permission_context',
        message: 'Authorization denied (invalid_permission_context). Tool: forge.forge.invocation.reserveStart. No permission context was bound to this Forge invocation.',
        toolId: 'forge.forge.invocation.reserveStart',
        missingCapabilities: undefined,
      },
    });
  });

  it('keeps existing non-Forge RPC methods working on the same service', async () => {
    const service = runtime.createRpcService(ACCESS_KEY);

    const ping = await rpc(service, 'runtime.ping');
    expect(ping?.result).toEqual({ ok: true });

    const capabilities = okResult(await rpc(service, 'jarvis.capabilities'));
    expect(capabilities['protocol']).toBe('jarvis-control-v1');
  });

  it('gives independently constructed RPC services independent reservation state', async () => {
    const taskId = 'task_rpc_isolated';
    await createTask(taskId);
    const first = runtime.createRpcService(ACCESS_KEY);
    const second = runtime.createRpcService(ACCESS_KEY);

    await reserveViaRpc(first, 'inv_rpc_isolated', taskId);

    const firstList = okResult(await rpc(first, FORGE_LIST_START_RESERVATIONS_METHOD));
    const secondList = okResult(await rpc(second, FORGE_LIST_START_RESERVATIONS_METHOD));
    expect((firstList['reservationList'] as { total: number }).total).toBe(1);
    expect((secondList['reservationList'] as { total: number }).total).toBe(0);
  });

  it('round-trips every payload through JSON serialization at the RPC boundary', async () => {
    const taskId = 'task_rpc_json';
    await createTask(taskId);
    const service = runtime.createRpcService(ACCESS_KEY);

    const response = await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_rpc_json',
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    });

    expect(response).toEqual(JSON.parse(JSON.stringify(response)));
  });
});
