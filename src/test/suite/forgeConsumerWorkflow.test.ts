import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import {
  FORGE_CANCEL_INVOCATION_METHOD,
  ForgeCallableMethod,
  FORGE_GET_INVOCATION_EVENTS_METHOD,
  FORGE_GET_INVOCATION_PROGRESS_METHOD,
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
  FORGE_PAUSE_INVOCATION_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_RESUME_INVOCATION_METHOD,
  FORGE_START_INVOCATION_METHOD,
  ForgeCallableDescriptor,
} from '../../agent/ForgeCallableSurface';
import { FORGE_DISCOVER_RPC_METHOD, registerForgeCallableRpc } from '../../agent/ForgeRpcRegistration';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { LocalRpcDispatcher, LocalRpcResponse } from '../../runtime/LocalRpcServer';
import { RpcServiceLifecycle } from '../../runtime/RpcServiceLifecycle';
import { MockProvider } from '../mocks/MockProvider';

const ACCESS_KEY = 'forge-consumer-workflow-key-0001';
const WRONG_ACCESS_KEY = 'forge-consumer-workflow-wrong-key';
const GOAL = 'Summarize the current diff without exposing secrets.';

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
  userGoal: 'Forge consumer workflow verification',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an array: ${JSON.stringify(value)}`);
  }
  return value;
}

function forgeResult(response: LocalRpcResponse | null): Record<string, unknown> {
  if (!response || response.error || response.result === undefined) {
    throw new Error(`Expected successful JSON-RPC result: ${JSON.stringify(response)}`);
  }
  return record(response.result, 'JSON-RPC result');
}

function nested(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  return record(parent[key], key);
}

function approvalKey(method: ForgeCallableMethod, runId: string): string {
  return `${method}\n${runId}`;
}

describe('Governed Forge end-to-end consumer workflow (M5.3)', () => {
  let root: string;
  let secrets: vscode.SecretStorage;
  let runtime: AgentRuntime;
  let requestId = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-consumer-'));
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

  async function rpc(
    service: RpcServiceLifecycle,
    method: string,
    params?: unknown,
    accessKey = ACCESS_KEY,
  ): Promise<LocalRpcResponse | null> {
    const id = `consumer_${++requestId}`;
    const response = await service.dispatcher.dispatch(
      JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      accessKey,
    );
    if (response) {
      expect(response.id).toBe(accessKey === ACCESS_KEY ? id : null);
    }
    return response === null ? null : JSON.parse(JSON.stringify(response));
  }

  async function reserve(
    service: RpcServiceLifecycle,
    invocationId: string,
    taskId: string,
    goal = GOAL,
  ): Promise<string> {
    const response = await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal,
      prepared: true,
    });
    const result = forgeResult(response);
    expect(result['ok']).toBe(true);
    const reservation = nested(result, 'reservation');
    expect(reservation['accepted']).toBe(true);
    const reservationId = reservation['reservationId'];
    if (typeof reservationId !== 'string') {
      throw new Error(`Expected reservationId: ${JSON.stringify(reservation)}`);
    }
    return reservationId;
  }

  function approvedService(approved: ReadonlySet<string>, requestTimeoutMs?: number): RpcServiceLifecycle {
    const dispatcher = new LocalRpcDispatcher(ACCESS_KEY, { requestTimeoutMs });
    dispatcher.register('runtime.ping', async () => ({ ok: true }));
    registerForgeCallableRpc(dispatcher, runtime.composeGovernedForgeExecution().transport, {
      approvalGranted: (method, runId) => approved.has(approvalKey(method, runId)),
      elevationGranted: () => false,
    });
    return new RpcServiceLifecycle(dispatcher);
  }

  it('runs discover -> reserve -> invoke -> retrieve through serialized RPC with idempotency, ownership and redaction intact', async () => {
    const taskId = 'task_consumer_happy';
    const invocationId = 'inv_consumer_happy';
    const completion = 'consumer-only completion text';
    await createTask(taskId);

    const provider = new MockProvider().enqueueText(completion);
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const composeSpy = vi.spyOn(runtime, 'composeGovernedForgeExecution');
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(new Set([
      approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${expectedReservationId}`),
    ]));

    const discovery = await rpc(service, FORGE_DISCOVER_RPC_METHOD);
    expect(discovery?.error).toBeUndefined();
    const descriptors = array(discovery?.result, 'forge.discover result') as ForgeCallableDescriptor[];
    expect(descriptors).toHaveLength(22);
    expect(descriptors).toEqual(JSON.parse(JSON.stringify(descriptors)));
    const invokeDescriptor = descriptors.find(descriptor => descriptor.id === FORGE_INVOKE_MODEL_METHOD);
    expect(invokeDescriptor).toMatchObject({
      id: FORGE_INVOKE_MODEL_METHOD,
      version: FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
      readOnly: false,
      sideEffects: 'model-execution',
    });

    const reservationId = await reserve(service, invocationId, taskId);

    const firstResponse = await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });
    const first = nested(forgeResult(firstResponse), 'modelCall');
    expect(first['invoked']).toBe(true);
    expect(first['completion']).toBe(completion);
    expect(first['invocationId']).toBe(invocationId);
    expect(first['taskId']).toBe(taskId);
    const firstEvidence = nested(first, 'evidence');
    expect(firstEvidence['status']).toBe('completed');
    expect(firstEvidence['promptCharacterCount']).toBe(GOAL.length);
    expect(firstEvidence['providerType']).toBe('ollama');
    expect(JSON.stringify(firstEvidence)).not.toContain(GOAL);
    expect(JSON.stringify(firstEvidence)).not.toContain(completion);

    const duplicateResponse = await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });
    const duplicate = nested(forgeResult(duplicateResponse), 'modelCall');
    expect(duplicate['invoked']).toBe(true);
    expect(duplicate['completion']).toBeUndefined();
    expect(array(duplicate['reasons'], 'duplicate reasons')).toContainEqual(expect.objectContaining({
      code: 'duplicate_model_call',
    }));

    const retrievalResponse = await rpc(service, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId,
      taskId,
    });
    const retrieval = nested(forgeResult(retrievalResponse), 'result');
    expect(retrieval).toMatchObject({
      found: true,
      ready: true,
      outcome: 'completed',
      reservationId,
      invocationId,
      taskId,
      invoked: true,
    });
    expect('completion' in retrieval).toBe(false);
    expect(nested(retrieval, 'evidence')['promptCharacterCount']).toBe(GOAL.length);
    expect(JSON.stringify(retrieval)).not.toContain(GOAL);
    expect(JSON.stringify(retrieval)).not.toContain(completion);

    const mismatchResponse = await rpc(service, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId: 'inv_not_owner',
      taskId,
    });
    const mismatch = nested(forgeResult(mismatchResponse), 'result');
    expect(mismatch).toMatchObject({
      found: false,
      ready: false,
      outcome: 'ownership_mismatch',
    });
    expect(mismatch['evidence']).toBeUndefined();

    expect(composeSpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
    expect(gatewaySpy.mock.calls[0][0]).toBe(secrets);
    expect(provider.capturedRequests).toHaveLength(1);
    expect(provider.capturedRequests[0].messages[0].content).toBe(GOAL);
    expect(provider.capturedRequests[0].tools).toEqual([]);
  });

  it('keeps governed provider failures inside JSON-RPC result with sanitized evidence', async () => {
    const taskId = 'task_consumer_failure';
    const invocationId = 'inv_consumer_failure';
    await createTask(taskId);

    const sensitiveFailure = `private-provider-detail while processing ${GOAL}`;
    vi.spyOn(ProviderGateway, 'create').mockRejectedValue(new Error(sensitiveFailure));
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(new Set([
      approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${expectedReservationId}`),
    ]));
    const reservationId = await reserve(service, invocationId, taskId);

    const response = await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });

    expect(response?.error).toBeUndefined();
    const modelCall = nested(forgeResult(response), 'modelCall');
    expect(modelCall).toMatchObject({
      invoked: false,
      failureCode: 'provider_failure',
    });
    const evidence = nested(modelCall, 'evidence');
    expect(evidence).toMatchObject({
      status: 'failed',
      failureCode: 'provider_failure',
      failureReason: 'The governed model provider failed during execution.',
      promptCharacterCount: GOAL.length,
    });
    expect(JSON.stringify(modelCall)).not.toContain('private-provider-detail');
    expect(JSON.stringify(modelCall)).not.toContain(GOAL);

    const retrieval = nested(forgeResult(await rpc(service, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId,
      taskId,
    })), 'result');
    expect(retrieval['outcome']).toBe('failed');
    expect(retrieval['failureCode']).toBe('provider_failure');
    expect('completion' in retrieval).toBe(false);
  });

  it('distinguishes JSON-RPC protocol errors from Forge validation and rejected-execution envelopes', async () => {
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create');
    const service = approvedService(new Set([
      approvalKey(FORGE_INVOKE_MODEL_METHOD, 'reservation:forge-start-reservation:inv_rejected:task_rejected'),
    ]));

    const malformed = forgeResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_malformed',
    }));
    expect(malformed).toMatchObject({
      ok: false,
      method: FORGE_RESERVE_START_INVOCATION_METHOD,
      error: { code: 'invalid_permission_context' },
    });

    const rejectedReservation = nested(forgeResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_rejected',
      taskId: 'task_rejected',
      goal: GOAL,
      prepared: false,
    })), 'reservation');
    expect(rejectedReservation['accepted']).toBe(false);
    expect(rejectedReservation['reservationId']).toBeUndefined();

    const rejectedCall = nested(forgeResult(await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId: 'forge-start-reservation:inv_rejected:task_rejected',
      model: 'test-model',
    })), 'modelCall');
    expect(rejectedCall).toMatchObject({
      invoked: false,
      failureCode: 'execution_rejected',
    });
    expect(array(rejectedCall['reasons'], 'rejection reasons')).toContainEqual(expect.objectContaining({
      code: 'unknown_reservation',
    }));

    const unknown = await rpc(service, 'forge.invocation.notRegistered');
    expect(unknown?.error).toEqual({ code: -32601, message: 'Method not found.' });

    const denied = await rpc(service, FORGE_DISCOVER_RPC_METHOD, undefined, WRONG_ACCESS_KEY);
    expect(denied?.error).toEqual({ code: -32001, message: 'Access denied.' });

    expect(gatewaySpy).not.toHaveBeenCalled();
  });

  it('keeps reservation and execution state isolated between RPC service instances', async () => {
    const taskId = 'task_consumer_isolation';
    const invocationId = 'inv_consumer_isolation';
    await createTask(taskId);

    const provider = new MockProvider().enqueueText('service A completion');
    const gatewaySpy = vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const approval = approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${expectedReservationId}`);
    const serviceA = approvedService(new Set([approval]));
    const serviceB = approvedService(new Set([approval]));
    const reservationId = await reserve(serviceA, invocationId, taskId);

    const crossService = nested(forgeResult(await rpc(serviceB, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    })), 'modelCall');
    expect(crossService).toMatchObject({
      invoked: false,
      failureCode: 'execution_rejected',
    });
    expect(array(crossService['reasons'], 'cross-service reasons')).toContainEqual(expect.objectContaining({
      code: 'unknown_reservation',
    }));
    expect(gatewaySpy).not.toHaveBeenCalled();

    const ownService = nested(forgeResult(await rpc(serviceA, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    })), 'modelCall');
    expect(ownService['invoked']).toBe(true);
    expect(gatewaySpy).toHaveBeenCalledTimes(1);
  });

  it('registers invocation references only after start, then exposes status, events, progress and lifecycle controls', async () => {
    const taskId = 'task_consumer_lifecycle';
    const invocationId = 'inv_consumer_lifecycle';
    await createTask(taskId);

    const startSpy = vi.spyOn(runtime, 'startTask').mockImplementation(async request => {
      return runtime.getTask(request.taskId ?? taskId);
    });
    const pauseSpy = vi.spyOn(runtime, 'pauseTask').mockImplementation(async requestedTaskId => {
      await runtime.taskStore.updateTask(requestedTaskId, { phase: 'paused' });
      return runtime.getTask(requestedTaskId);
    });
    const resumeSpy = vi.spyOn(runtime, 'resumeTask').mockImplementation(async requestedTaskId => {
      await runtime.taskStore.updateTask(requestedTaskId, { phase: 'executing' });
      return runtime.getTask(requestedTaskId);
    });
    const cancelSpy = vi.spyOn(runtime, 'cancelTask').mockImplementation(async requestedTaskId => {
      await runtime.taskStore.updateTask(requestedTaskId, { phase: 'cancelled' });
      return runtime.getTask(requestedTaskId);
    });
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(new Set([
      approvalKey(FORGE_START_INVOCATION_METHOD, `task:${taskId}:invocation:${invocationId}:reservation:${expectedReservationId}`),
      approvalKey(FORGE_PAUSE_INVOCATION_METHOD, `invocation:${invocationId}`),
      approvalKey(FORGE_RESUME_INVOCATION_METHOD, `invocation:${invocationId}`),
      approvalKey(FORGE_CANCEL_INVOCATION_METHOD, `invocation:${invocationId}`),
    ]));

    const beforeStartStatus = forgeResult(await rpc(service, FORGE_GET_INVOCATION_STATUS_METHOD, { invocationId }));
    expect(beforeStartStatus).toMatchObject({ ok: false, error: { code: 'not_found' } });

    const beforeStartCancel = forgeResult(await rpc(service, FORGE_CANCEL_INVOCATION_METHOD, { invocationId }));
    expect(beforeStartCancel).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(service.dispatcher.listMethods()).not.toContain('forge.invocation.cancelModelCall');

    const reservationId = await reserve(service, invocationId, taskId);
    const start = nested(forgeResult(await rpc(service, FORGE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal: GOAL,
      reservationId,
      mode: 'agent',
      model: 'test-model',
    })), 'start');
    expect(start['started']).toBe(true);
    expect(startSpy).toHaveBeenCalledTimes(1);

    const status = nested(forgeResult(await rpc(service, FORGE_GET_INVOCATION_STATUS_METHOD, {
      invocationId,
    })), 'status');
    expect(status).toMatchObject({ invocationId, taskId, phase: 'running' });

    const events = forgeResult(await rpc(service, FORGE_GET_INVOCATION_EVENTS_METHOD, { invocationId }));
    expect(events['ok']).toBe(true);
    expect(nested(events, 'events')['invocationId']).toBe(invocationId);

    const progress = forgeResult(await rpc(service, FORGE_GET_INVOCATION_PROGRESS_METHOD, { invocationId }));
    expect(progress['ok']).toBe(true);
    expect(nested(progress, 'progress')['taskId']).toBe(taskId);

    const pause = nested(forgeResult(await rpc(service, FORGE_PAUSE_INVOCATION_METHOD, {
      invocationId,
      reason: 'consumer pause',
    })), 'control');
    expect(pause).toMatchObject({ action: 'pause', applied: true, taskId });

    const resume = nested(forgeResult(await rpc(service, FORGE_RESUME_INVOCATION_METHOD, {
      invocationId,
      reason: 'consumer resume',
    })), 'control');
    expect(resume).toMatchObject({ action: 'resume', applied: true, taskId });

    const cancel = nested(forgeResult(await rpc(service, FORGE_CANCEL_INVOCATION_METHOD, {
      invocationId,
      reason: 'consumer cancel',
    })), 'control');
    expect(cancel).toMatchObject({ action: 'cancel', applied: true, taskId });
    expect(nested(cancel, 'status')['phase']).toBe('cancelled');

    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(resumeSpy).toHaveBeenCalledTimes(1);
    expect(cancelSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps a non-cooperative provider pending at the deadline but discards its eventual late completion', async () => {
    const taskId = 'task_consumer_timeout';
    const invocationId = 'inv_consumer_timeout';
    await createTask(taskId);

    const provider = new MockProvider();
    let releaseProvider: (() => void) | undefined;
    const chatSpy = vi.spyOn(provider, 'chat').mockImplementation(() => new Promise(resolve => {
      releaseProvider = () => resolve({
        message: { role: 'assistant', content: 'late completion after RPC deadline' },
        done: true,
      });
    }));
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(new Set([
      approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${expectedReservationId}`),
    ]), 1000);
    const reservationId = await reserve(service, invocationId, taskId);

    vi.useFakeTimers();
    let settled = false;
    const pending = rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    }).finally(() => {
      settled = true;
    });

    // The shared M11 preflight adds await points (metadata probe, budget
    // planning) before the provider call; flush microtasks until dispatch.
    for (let flush = 0; flush < 32 && chatSpy.mock.calls.length === 0; flush++) {
      await Promise.resolve();
    }
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(releaseProvider).toBeDefined();

    await vi.advanceTimersByTimeAsync(1000);
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseProvider?.();
    const response = await pending;
    expect(response?.error).toBeUndefined();
    const modelCall = nested(forgeResult(response), 'modelCall');
    expect(modelCall['completion']).toBeUndefined();
    expect(modelCall['failureCode']).toBe('cancelled');
    expect(nested(modelCall, 'evidence')['status']).toBe('cancelled');
    expect(JSON.stringify(modelCall)).not.toContain('late completion after RPC deadline');
  });
});
