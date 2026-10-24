import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import {
  ForgeCallableMethod,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
} from '../../agent/ForgeCallableSurface';
import { registerForgeCallableRpc } from '../../agent/ForgeRpcRegistration';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDispatcher,
} from '../../agent/GovernedModelExecutionDispatcher';
import { GOVERNED_MODEL_CONTRACT_VERSION } from '../../agent/GovernedModelExecutionTypes';
import { ProviderGateway } from '../../providers/ProviderGateway';
import {
  InferenceProvider,
  ModelInfo,
  ProviderChatOptions,
} from '../../providers/ProviderTypes';
import { LocalRpcDispatcher, LocalRpcResponse } from '../../runtime/LocalRpcServer';
import { RpcServiceLifecycle } from '../../runtime/RpcServiceLifecycle';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

const ACCESS_KEY = 'forge-m6-cancellation-key-0001'; // gitleaks:allow
const GOAL = 'Verify governed RPC cancellation without leaking completion text.';

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

class ControlledProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  calls = 0;
  signal?: AbortSignal;
  resolveChat?: (content: string) => void;

  constructor(private readonly honorAbort: boolean) {}

  async healthCheck(): Promise<void> {}

  async listModels(): Promise<ModelInfo[]> {
    return [{ name: 'test-model' }];
  }

  chat(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ProviderChatOptions,
    signal?: AbortSignal,
  ): Promise<ChatResponse> {
    this.calls += 1;
    this.signal = signal;

    return new Promise<ChatResponse>((resolve, reject) => {
      let settled = false;
      const removeAbortListener = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!this.honorAbort || settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        reject(new Error('controlled provider observed cancellation'));
      };

      if (this.honorAbort) {
        signal?.addEventListener('abort', onAbort, { once: true });
      }

      this.resolveChat = (content: string): void => {
        if (settled) {
          return;
        }
        settled = true;
        removeAbortListener();
        resolve({ message: { role: 'assistant', content }, done: true });
      };

      if (signal?.aborted) {
        onAbort();
      }
    });
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)}`);
  }
  return value as Record<string, unknown>;
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

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('M6 governed RPC cancellation and deadline semantics', () => {
  let root: string;
  let runtime: AgentRuntime;
  let requestId = 0;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-m6-cancel-'));
    runtime = new AgentRuntime(root, secretStorage());
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function createTask(taskId: string): Promise<void> {
    await runtime.taskStore.createTask({
      taskId,
      workspaceId: '/workspace',
      workspaceRoot: '/workspace',
      userGoal: GOAL,
      mode: 'agent',
      model: 'test-model',
      providerType: 'ollama',
    });
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
  ): Promise<LocalRpcResponse | null> {
    const id = `m6_cancel_${++requestId}`;
    return service.dispatcher.dispatch(
      JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      ACCESS_KEY,
    );
  }

  async function reserve(
    service: RpcServiceLifecycle,
    invocationId: string,
    taskId: string,
  ): Promise<string> {
    const result = forgeResult(await rpc(service, FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal: GOAL,
      prepared: true,
    }));
    const reservation = nested(result, 'reservation');
    const reservationId = reservation['reservationId'];
    if (typeof reservationId !== 'string') {
      throw new Error(`Expected reservationId: ${JSON.stringify(reservation)}`);
    }
    return reservationId;
  }

  function approvedService(approved: ReadonlySet<string>, requestTimeoutMs?: number): RpcServiceLifecycle {
    const dispatcher = new LocalRpcDispatcher(ACCESS_KEY, { requestTimeoutMs });
    registerForgeCallableRpc(dispatcher, runtime.composeGovernedForgeExecution().transport, {
      approvalGranted: (method, runId) => approved.has(approvalKey(method, runId)),
      elevationGranted: () => false,
    });
    return new RpcServiceLifecycle(dispatcher);
  }

  function invokeApproval(reservationId: string): ReadonlySet<string> {
    return new Set([approvalKey(FORGE_INVOKE_MODEL_METHOD, `reservation:${reservationId}`)]);
  }

  it('propagates the RPC deadline to a cooperative provider and returns governed cancelled evidence', async () => {
    const taskId = 'task_m6_timeout';
    const invocationId = 'inv_m6_timeout';
    await createTask(taskId);

    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(invokeApproval(expectedReservationId), 1000);
    const reservationId = await reserve(service, invocationId, taskId);

    vi.useFakeTimers();
    const pending = rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    });
    await flushMicrotasks();

    expect(provider.calls).toBe(1);
    expect(provider.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1000);
    const response = await pending;

    expect(response?.error).toBeUndefined();
    const modelCall = nested(forgeResult(response), 'modelCall');
    expect(modelCall).toMatchObject({
      invoked: false,
      failureCode: 'cancelled',
    });
    expect(modelCall['completion']).toBeUndefined();
    expect(nested(modelCall, 'evidence')).toMatchObject({
      status: 'cancelled',
      failureCode: 'cancelled',
      promptCharacterCount: GOAL.length,
    });
    expect(provider.signal?.aborted).toBe(true);
    expect(provider.calls).toBe(1);
  });

  it('cancelAll cancels one shared concurrent execution and preserves redacted retrieval and duplicate behavior', async () => {
    const taskId = 'task_m6_cancel_all';
    const invocationId = 'inv_m6_cancel_all';
    await createTask(taskId);

    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(invokeApproval(expectedReservationId));
    const reservationId = await reserve(service, invocationId, taskId);

    const first = rpc(service, FORGE_INVOKE_MODEL_METHOD, { reservationId, model: 'test-model' });
    const second = rpc(service, FORGE_INVOKE_MODEL_METHOD, { reservationId, model: 'test-model' });
    await flushMicrotasks();

    expect(provider.calls).toBe(1);
    service.dispatcher.cancelAll();

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const firstCall = nested(forgeResult(firstResponse), 'modelCall');
    const secondCall = nested(forgeResult(secondResponse), 'modelCall');
    expect(firstCall['failureCode']).toBe('cancelled');
    expect(secondCall['failureCode']).toBe('cancelled');
    expect(provider.calls).toBe(1);

    const retrieval = nested(forgeResult(await rpc(service, FORGE_GET_MODEL_EXECUTION_RESULT_METHOD, {
      reservationId,
      invocationId,
      taskId,
    })), 'result');
    expect(retrieval).toMatchObject({
      found: true,
      ready: true,
      outcome: 'cancelled',
      failureCode: 'cancelled',
    });
    expect('completion' in retrieval).toBe(false);

    const duplicate = nested(forgeResult(await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    })), 'modelCall');
    expect(duplicate['failureCode']).toBe('cancelled');
    expect(duplicate['completion']).toBeUndefined();
    expect(JSON.stringify(duplicate)).toContain('duplicate_model_call');
    expect(provider.calls).toBe(1);
  });

  it('service stop propagates cancellation without requiring a public model-call cancellation method', async () => {
    const taskId = 'task_m6_stop';
    const invocationId = 'inv_m6_stop';
    await createTask(taskId);

    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(invokeApproval(expectedReservationId));
    const reservationId = await reserve(service, invocationId, taskId);

    const pending = rpc(service, FORGE_INVOKE_MODEL_METHOD, { reservationId, model: 'test-model' });
    await flushMicrotasks();
    expect(provider.signal?.aborted).toBe(false);

    await service.stop();
    expect(provider.signal?.aborted).toBe(true);
    expect(service.dispatcher.listMethods()).not.toContain('forge.invocation.cancelModelCall');

    const response = await pending;
    expect(nested(forgeResult(response), 'modelCall')['failureCode']).toBe('cancelled');
  });

  it('discards a late completion when a non-cooperative provider resolves after the RPC deadline', async () => {
    const taskId = 'task_m6_late_completion';
    const invocationId = 'inv_m6_late_completion';
    await createTask(taskId);

    const provider = new ControlledProvider(false);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const expectedReservationId = `forge-start-reservation:${invocationId}:${taskId}`;
    const service = approvedService(invokeApproval(expectedReservationId), 1000);
    const reservationId = await reserve(service, invocationId, taskId);

    vi.useFakeTimers();
    let settled = false;
    const pending = rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    }).finally(() => {
      settled = true;
    });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();
    expect(provider.signal?.aborted).toBe(true);
    expect(settled).toBe(false);

    provider.resolveChat?.('late completion must be discarded');
    const response = await pending;
    const modelCall = nested(forgeResult(response), 'modelCall');
    expect(modelCall['failureCode']).toBe('cancelled');
    expect(modelCall['completion']).toBeUndefined();
    expect(JSON.stringify(modelCall)).not.toContain('late completion must be discarded');
    expect(provider.calls).toBe(1);
  });

  it('removes the external abort listener after a normal local invocation settles', async () => {
    const taskId = 'task_m6_listener_cleanup';
    const invocationId = 'inv_m6_listener_cleanup';
    await createTask(taskId);

    const provider = new ControlledProvider(false);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const { transport } = runtime.composeGovernedForgeExecution();
    const reservationResponse = await transport.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId,
      taskId,
      goal: GOAL,
      prepared: true,
    });
    if (!reservationResponse.ok || reservationResponse.method !== FORGE_RESERVE_START_INVOCATION_METHOD) {
      throw new Error(`Unexpected reservation response: ${JSON.stringify(reservationResponse)}`);
    }
    const reservationId = reservationResponse.reservation.reservationId!;

    const external = new AbortController();
    const addSpy = vi.spyOn(external.signal, 'addEventListener');
    const removeSpy = vi.spyOn(external.signal, 'removeEventListener');
    const pending = transport.invoke(
      FORGE_INVOKE_MODEL_METHOD,
      { reservationId, model: 'test-model' },
      { signal: external.signal },
    );
    await flushMicrotasks();
    provider.resolveChat?.('normal completion');
    const response = await pending;

    expect(response.ok).toBe(true);
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy.mock.calls[0][0]).toBe('abort');
    expect(removeSpy.mock.calls[0][1]).toBe(addSpy.mock.calls[0][1]);
  });

  it('denies production RPC model invocation without approval before provider dispatch', async () => {
    const taskId = 'task_m6_missing_approval';
    const invocationId = 'inv_m6_missing_approval';
    await createTask(taskId);

    const provider = new ControlledProvider(true);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const service = runtime.createRpcService(ACCESS_KEY);
    const reservationId = await reserve(service, invocationId, taskId);

    const response = forgeResult(await rpc(service, FORGE_INVOKE_MODEL_METHOD, {
      reservationId,
      model: 'test-model',
    }));

    expect(response).toMatchObject({ ok: false, error: { code: 'approval_required' } });
    expect(provider.calls).toBe(0);
    expect(provider.signal).toBeUndefined();
  });

  it('normalizes a successful dependency result as cancelled when abort wins immediately before settlement', async () => {
    const controller = new AbortController();
    let resolveDependency: ((value: { completion: string; providerType: 'ollama' }) => void) | undefined;
    const dependency: GovernedModelExecutionDependency = {
      execute: () => new Promise(resolve => {
        resolveDependency = resolve;
      }),
    };
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, () => '2026-01-01T00:00:00.000Z');

    const pending = dispatcher.dispatch({
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: 'request_m6_dispatch_race',
      invocationId: 'inv_m6_dispatch_race',
      taskId: 'task_m6_dispatch_race',
      model: 'test-model',
      prompt: GOAL,
      signal: controller.signal,
    });
    await flushMicrotasks();

    controller.abort();
    resolveDependency?.({ completion: 'discard me', providerType: 'ollama' });
    const result = await pending;

    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
    expect(result.completion).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('discard me');
  });
});
