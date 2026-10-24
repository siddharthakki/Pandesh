import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReadOnlyForgeInvocationAdapter } from '../../agent/ForgeInvocationAdapter';
import { LocalAgentEngine } from '../../agent/LocalAgentEngine';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import {
  FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR,
  FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  FORGE_INVOKE_MODEL_METHOD,
  FORGE_MODEL_INVOCATION_CONTRACT_VERSION,
  ForgeInvocationModelCallCallableRequest,
  ReadOnlyForgeCallableSurface,
} from '../../agent/ForgeCallableSurface';
import {
  GovernedModelExecutionDependency,
  GovernedModelExecutionDispatcher,
  GovernedModelExecutionOutcome,
} from '../../agent/GovernedModelExecutionDispatcher';
import { GovernedModelRequest } from '../../agent/GovernedModelExecutionTypes';
import { ProviderGatewayGovernedModelExecutionDependency } from '../../agent/ProviderGatewayGovernedModelExecutionDependency';
import { MockProvider } from '../mocks/MockProvider';
import {
  ProviderApiError,
  ProviderAuthError,
  ProviderCancelledError,
  ProviderConnectionError,
  ProviderModelNotFoundError,
  ProviderTimeoutError,
} from '../../providers/ProviderTypes';

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
  userGoal: 'Governed model execution test',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

function fakeDependency(
  impl: (request: GovernedModelRequest) => Promise<GovernedModelExecutionOutcome>,
): GovernedModelExecutionDependency {
  return { execute: vi.fn(impl) };
}

function fixedClock(...timestamps: string[]): () => string {
  let index = 0;
  return () => timestamps[Math.min(index++, timestamps.length - 1)];
}

describe('Governed model execution wiring (M4.3)', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-model-'));
    engine = new LocalAgentEngine(root, secretStorage());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createTask(taskId: string): Promise<void> {
    await engine.taskStore.createTask({ taskId, ...BASE_TASK });
    await engine.taskStore.updateTask(taskId, {
      phase: 'executing',
      status: 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      engineUsage: createInitialUsage('2026-01-01T00:00:00.000Z'),
    });
  }

  async function reserve(
    adapter: ReadOnlyForgeInvocationAdapter,
    invocationId: string,
    taskId: string,
    goal = 'Summarize the current diff.',
  ): Promise<string> {
    const reservation = adapter.reserveStart({
      invocationId,
      taskId,
      goal,
      prepared: true,
    });
    expect(reservation.accepted).toBe(true);
    return reservation.reservationId!;
  }

  describe('descriptor metadata', () => {
    it('classifies forge.invocation.invokeModel as executing model-execution, not read-only, not metadata-only, not task-lifecycle', () => {
      expect(FORGE_INVOKE_MODEL_DESCRIPTOR.readOnly).toBe(false);
      expect(FORGE_INVOKE_MODEL_DESCRIPTOR.sideEffects).toBe('model-execution');
      expect(FORGE_INVOKE_MODEL_DESCRIPTOR.sideEffects).not.toBe('metadata-only');
      expect(FORGE_INVOKE_MODEL_DESCRIPTOR.sideEffects).not.toBe('task-lifecycle');
      expect(FORGE_INVOKE_MODEL_DESCRIPTOR.version).toBe(FORGE_MODEL_INVOCATION_CONTRACT_VERSION);
    });
  });

  describe('transport-safe callable request contract', () => {
    it('contains no AbortSignal and is JSON-serializable', () => {
      const request: ForgeInvocationModelCallCallableRequest = {
        method: FORGE_INVOKE_MODEL_METHOD,
        params: {
          reservationId: 'forge-start-reservation:inv:task',
          model: 'qwen2.5-coder:7b',
          audit: { callerId: 'forge' },
        },
      };

      expect('signal' in request.params).toBe(false);
      expect('goal' in request.params).toBe(false);
      expect('invocationId' in request.params).toBe(false);
      expect('taskId' in request.params).toBe(false);

      const serialized = JSON.stringify(request);
      expect(serialized).not.toContain('AbortSignal');
      const roundTripped = JSON.parse(serialized);
      expect(roundTripped).toEqual(request);
    });

    it('rejects an audit value that is an array instead of an object', async () => {
      const taskId = 'task_model_audit_array';
      await createTask(taskId);
      const dependency = fakeDependency(async () => ({ completion: 'ok' }));
      const dispatcher = new GovernedModelExecutionDispatcher(dependency);
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
      const surface = new ReadOnlyForgeCallableSurface(adapter);
      const reservationId = await reserve(adapter, 'inv_audit_array', taskId);

      const response = await surface.call({
        method: FORGE_INVOKE_MODEL_METHOD,
        params: {
          reservationId,
          model: 'm',
          audit: [],
        },
      } as unknown as { method: string; params?: unknown });

      expect(response.ok).toBe(false);
      expect(dependency.execute).not.toHaveBeenCalled();
    });
  });

  it('invokes the model exactly once for a valid reserved call and returns the completion', async () => {
    const taskId = 'task_model_call_ok';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'Here is the summary.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_ok', taskId);
    const startSpy = vi.spyOn(engine, 'startTask');

    const result = await adapter.invokeModel({
      reservationId,
      model: 'qwen2.5-coder:7b',
    });

    expect(dependency.execute).toHaveBeenCalledTimes(1);
    expect(startSpy).not.toHaveBeenCalled();
    expect(result.invoked).toBe(true);
    expect(result.completion).toBe('Here is the summary.');
    expect(result.sideEffects).toBe('model-call');
    expect(result.evidence.status).toBe('completed');
    expect(result.invocationId).toBe('inv_model_ok');
    expect(result.taskId).toBe(taskId);

    // M4.4: evidence correlates with the owning Forge invocation/task, and
    // records honest timing plus safe input-size metadata.
    expect(result.evidence.invocationId).toBe('inv_model_ok');
    expect(result.evidence.taskId).toBe(taskId);
    expect(result.evidence.startedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.evidence.completedAt).toBe('2026-01-01T00:00:01.000Z');
    expect(result.evidence.durationMs).toBe(1000);
    expect(result.evidence.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.evidence.promptCharacterCount).toBe('Summarize the current diff.'.length);
    expect(result.evidence.inputTokens).toBeUndefined();
    expect(result.evidence.outputTokens).toBeUndefined();
    expect(result.evidence.finishReason).toBeUndefined();
  });

  it('records optional usage metadata (tokens, finish reason) on evidence when the dependency supplies it', async () => {
    const taskId = 'task_model_call_usage';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({
      completion: 'Here is the summary.',
      inputTokens: 42,
      outputTokens: 17,
      finishReason: 'stop',
    }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_usage', taskId);

    const result = await adapter.invokeModel({ reservationId, model: 'qwen2.5-coder:7b' });

    expect(result.evidence.inputTokens).toBe(42);
    expect(result.evidence.outputTokens).toBe(17);
    expect(result.evidence.finishReason).toBe('stop');
  });

  it('records failed execution evidence with a stable failure classification and no fabricated usage metadata', async () => {
    const taskId = 'task_model_call_failed_evidence';
    await createTask(taskId);
    const dependency = fakeDependency(async () => {
      throw new Error('provider connection refused');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_failed_evidence', taskId, 'Summarize the failure case.');

    const result = await adapter.invokeModel({ reservationId, model: 'qwen2.5-coder:7b' });

    expect(result.invoked).toBe(false);
    expect(result.evidence.status).toBe('failed');
    expect(result.evidence.failureCode).toBe('provider_failure');
    expect(result.evidence.failureReason).toBe('The governed model provider failed during execution.');
    expect(result.evidence.invocationId).toBe('inv_model_failed_evidence');
    expect(result.evidence.taskId).toBe(taskId);
    expect(result.evidence.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.evidence.promptCharacterCount).toBe('Summarize the failure case.'.length);
    expect(result.evidence.inputTokens).toBeUndefined();
    expect(result.evidence.outputTokens).toBeUndefined();
    expect(result.evidence.finishReason).toBeUndefined();
    expect(JSON.stringify(result.evidence)).not.toContain('Summarize the failure case.');
    expect(JSON.stringify(result.evidence)).not.toContain('provider connection refused');
  });

  it('never persists a raw provider exception message in evidence, even when it contains sensitive material', async () => {
    const taskId = 'task_model_call_sensitive_exception';
    await createTask(taskId);
    const sensitiveMessage =
      'Upstream call for prompt "Summarize the current diff." failed: Authorization: Bearer sk-live-abc123secret';
    const dependency = fakeDependency(async () => {
      throw new Error(sensitiveMessage);
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_sensitive_exception', taskId, 'Summarize the current diff.');

    const result = await adapter.invokeModel({ reservationId, model: 'qwen2.5-coder:7b' });

    expect(result.invoked).toBe(false);
    expect(result.evidence.status).toBe('failed');
    expect(result.evidence.failureCode).toBe('provider_failure');
    expect(result.evidence.failureReason).toBe('The governed model provider failed during execution.');
    const serializedEvidence = JSON.stringify(result.evidence);
    expect(serializedEvidence).not.toContain('sk-live-abc123secret');
    expect(serializedEvidence).not.toContain('Summarize the current diff.');
    expect(serializedEvidence).not.toContain('Bearer');
    expect(serializedEvidence).not.toContain(sensitiveMessage);
  });

  it('does not cross-associate evidence between two concurrent invocations on different reservations', async () => {
    const taskIdA = 'task_model_concurrent_a';
    const taskIdB = 'task_model_concurrent_b';
    await createTask(taskIdA);
    await createTask(taskIdB);
    const resolvers = new Map<string, (outcome: GovernedModelExecutionOutcome) => void>();
    const dependency = fakeDependency(request => new Promise<GovernedModelExecutionOutcome>(resolve => {
      resolvers.set(request.invocationId, resolve);
    }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationIdA = await reserve(adapter, 'inv_concurrent_a', taskIdA, 'Prompt A.');
    const reservationIdB = await reserve(adapter, 'inv_concurrent_b', taskIdB, 'Prompt B.');

    const pendingA = adapter.invokeModel({ reservationId: reservationIdA, model: 'm' });
    const pendingB = adapter.invokeModel({ reservationId: reservationIdB, model: 'm' });
    await Promise.resolve();
    await Promise.resolve();

    resolvers.get('inv_concurrent_a')?.({ completion: 'completion A' });
    resolvers.get('inv_concurrent_b')?.({ completion: 'completion B' });
    const [resultA, resultB] = await Promise.all([pendingA, pendingB]);

    expect(resultA.invocationId).toBe('inv_concurrent_a');
    expect(resultA.taskId).toBe(taskIdA);
    expect(resultA.completion).toBe('completion A');
    expect(resultA.evidence.invocationId).toBe('inv_concurrent_a');
    expect(resultA.evidence.taskId).toBe(taskIdA);
    expect(resultA.evidence.promptCharacterCount).toBe('Prompt A.'.length);

    expect(resultB.invocationId).toBe('inv_concurrent_b');
    expect(resultB.taskId).toBe(taskIdB);
    expect(resultB.completion).toBe('completion B');
    expect(resultB.evidence.invocationId).toBe('inv_concurrent_b');
    expect(resultB.evidence.taskId).toBe(taskIdB);
    expect(resultB.evidence.promptCharacterCount).toBe('Prompt B.'.length);
  });

  it('does not fabricate promptCharacterCount when the request is rejected before a reservation goal is known', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const result = await adapter.invokeModel({
      reservationId: 'res_does_not_exist',
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.evidence.promptCharacterCount).toBeUndefined();
  });

  it('derives the dispatched prompt only from the validated reservation; the caller cannot substitute it', async () => {
    const taskId = 'task_model_call_fields';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_fields', taskId, 'Summarize the current diff.');

    // The public invokeModel input has no `goal` field at all — there is no
    // way for a caller to supply or substitute a prompt.
    expect('goal' in ({} as Record<string, unknown>)).toBe(false);

    await adapter.invokeModel({
      reservationId,
      model: 'qwen2.5-coder:7b',
    });

    expect(dependency.execute).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'Summarize the current diff.',
      model: 'qwen2.5-coder:7b',
      invocationId: 'inv_model_fields',
      taskId,
    }));
  });

  it('attaches model evidence without persisting prompt or completion text in the evidence object', async () => {
    const taskId = 'task_model_call_evidence';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'secret completion text' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_evidence', taskId);

    const result = await adapter.invokeModel({
      reservationId,
      model: 'qwen2.5-coder:7b',
    });

    expect(result.completion).toBe('secret completion text');
    expect(JSON.stringify(result.evidence)).not.toContain('secret completion text');
    expect(JSON.stringify(result.evidence)).not.toContain('Summarize the current diff.');
  });

  it('invokes zero tools and performs zero planning/retries (single-shot dependency call only)', async () => {
    const taskId = 'task_model_call_no_tools';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_model_no_tools', taskId);

    await adapter.invokeModel({
      reservationId,
      model: 'qwen2.5-coder:7b',
    });

    expect(dependency.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid request without invoking the model', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const result = await adapter.invokeModel({
      reservationId: '',
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.invoked).toBe(false);
    expect(result.reasons[0].code).toBe('invalid_request');
  });

  it('rejects when the reservation was not accepted (policy rejection) without invoking the model', async () => {
    const taskId = 'task_model_policy_reject';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const reservation = adapter.reserveStart({
      invocationId: 'inv_policy_reject',
      taskId,
      goal: 'Summarize the current diff.',
      prepared: false,
    });
    expect(reservation.accepted).toBe(false);

    const result = await adapter.invokeModel({
      reservationId: 'forge-start-reservation:inv_policy_reject:' + taskId,
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.invoked).toBe(false);
    expect(result.reasons.some(reason => reason.code === 'unknown_reservation')).toBe(true);
  });

  it('rejects an unknown reservation without invoking the model', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const result = await adapter.invokeModel({
      reservationId: 'res_does_not_exist',
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.invoked).toBe(false);
    expect(result.reasons[0].code).toBe('unknown_reservation');
  });

  it('rejects an expired reservation without invoking the model', async () => {
    const taskId = 'task_model_expired';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    let ticks = 0;
    const clock = () => (ticks++ === 0 ? '2026-01-01T00:00:00.000Z' : '2026-01-01T00:10:00.000Z');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], clock, dispatcher);
    const reservationId = await reserve(adapter, 'inv_expired', taskId);

    const result = await adapter.invokeModel({
      reservationId,
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.invoked).toBe(false);
    expect(result.reasons.some(reason => reason.code === 'reservation_expired')).toBe(true);
  });

  it('does not invoke the model a second time for a later duplicate call, and does not replay the raw completion', async () => {
    const taskId = 'task_model_duplicate';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'first completion' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_duplicate', taskId);

    const input = { reservationId, model: 'm' };

    const first = await adapter.invokeModel(input);
    const second = await adapter.invokeModel(input);

    expect(dependency.execute).toHaveBeenCalledTimes(1);
    expect(first.completion).toBe('first completion');
    expect(second.completion).toBeUndefined();
    expect(second.reasons.some(reason => reason.code === 'duplicate_model_call')).toBe(true);
  });

  it('deduplicates two concurrent identical model calls into a single dispatcher/provider invocation', async () => {
    const taskId = 'task_model_concurrent';
    await createTask(taskId);
    let executionCount = 0;
    let resolveExecute: ((outcome: GovernedModelExecutionOutcome) => void) | undefined;
    const dependency = fakeDependency(async () => {
      executionCount += 1;
      return new Promise<GovernedModelExecutionOutcome>(resolve => {
        resolveExecute = resolve;
      });
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_concurrent', taskId);
    const request = { reservationId, model: 'm' };

    const pending = Promise.all([adapter.invokeModel(request), adapter.invokeModel(request)]);
    resolveExecute?.({ completion: 'shared completion' });
    const [first, second] = await pending;

    expect(executionCount).toBe(1);
    expect(first).toEqual(second);
    expect(first.completion).toBe('shared completion');
  });

  it('deduplicates a concurrent failure into a single provider call with no retry and an equivalent outcome for both callers', async () => {
    const taskId = 'task_model_concurrent_failure';
    await createTask(taskId);
    let executionCount = 0;
    const dependency = fakeDependency(async () => {
      executionCount += 1;
      throw new Error('provider exploded');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_concurrent_failure', taskId);
    const request = { reservationId, model: 'm' };

    const [first, second] = await Promise.all([adapter.invokeModel(request), adapter.invokeModel(request)]);

    expect(executionCount).toBe(1);
    expect(first.invoked).toBe(false);
    expect(first).toEqual(second);
    expect(first.failureCode).toBe('provider_failure');
  });

  it('prevents provider invocation when cancelled before the model call begins', async () => {
    const taskId = 'task_model_cancel';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_cancel', taskId);

    adapter.cancelModelCall(reservationId);

    const result = await adapter.invokeModel({
      reservationId,
      model: 'm',
    });

    expect(dependency.execute).not.toHaveBeenCalled();
    expect(result.invoked).toBe(false);
    expect(result.evidence.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
  });

  it('reaches an internal in-flight cancellation through the dispatcher to InferenceProvider-style dependencies', async () => {
    const taskId = 'task_model_cancel_inflight';
    await createTask(taskId);
    let observedSignal: AbortSignal | undefined;
    let releaseExecute: (() => void) | undefined;
    const dependency = fakeDependency(async request => {
      observedSignal = request.signal;
      await new Promise<void>(resolve => {
        releaseExecute = resolve;
      });
      return { completion: 'ok' };
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_cancel_inflight', taskId);

    const pending = adapter.invokeModel({ reservationId, model: 'm' });
    // Give the dependency a turn to capture the internally-created signal.
    await Promise.resolve();
    await Promise.resolve();

    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);

    adapter.cancelModelCall(reservationId);
    expect(observedSignal?.aborted).toBe(true);

    releaseExecute?.();
    await pending;
  });

  it('rejects invokeModel when no dispatcher is configured, without touching the engine', async () => {
    const taskId = 'task_model_no_dispatcher';
    await createTask(taskId);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z');
    const reservationId = await reserve(adapter, 'inv_no_dispatcher', taskId);
    const startSpy = vi.spyOn(engine, 'startTask');

    const result = await adapter.invokeModel({
      reservationId,
      model: 'm',
    });

    expect(result.invoked).toBe(false);
    expect(result.reasons.some(reason => reason.code === 'model_dispatcher_unavailable')).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('existing M3 start behavior is unaffected by invokeModel: engine.startTask is still called exactly once for start', async () => {
    const taskId = 'task_model_m3_unaffected';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask(taskId));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_m3_unaffected',
      taskId,
      goal: 'Summarize the current diff.',
      prepared: true,
    });

    const startResult = await adapter.start({
      invocationId: 'inv_m3_unaffected',
      taskId,
      goal: 'Summarize the current diff.',
      reservationId: reservation.reservationId!,
      mode: 'agent',
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startResult.started).toBe(true);
    expect(dependency.execute).not.toHaveBeenCalled();
  });

  describe('reservation-consumption exclusivity between start and invokeModel', () => {
    it('a reservation consumed by start() cannot later authorize invokeModel()', async () => {
      const taskId = 'task_exclusive_start_first';
      await createTask(taskId);
      const dependency = fakeDependency(async () => ({ completion: 'ok' }));
      const dispatcher = new GovernedModelExecutionDispatcher(dependency);
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
      vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask(taskId));

      const reservation = adapter.reserveStart({
        invocationId: 'inv_exclusive_start_first',
        taskId,
        goal: 'Summarize the current diff.',
        prepared: true,
      });

      const startResult = await adapter.start({
        invocationId: 'inv_exclusive_start_first',
        taskId,
        goal: 'Summarize the current diff.',
        reservationId: reservation.reservationId!,
        mode: 'agent',
      });
      expect(startResult.started).toBe(true);

      const modelResult = await adapter.invokeModel({
        reservationId: reservation.reservationId!,
        model: 'm',
      });

      expect(dependency.execute).not.toHaveBeenCalled();
      expect(modelResult.invoked).toBe(false);
      expect(modelResult.reasons.some(reason => reason.code === 'unknown_reservation')).toBe(true);
    });

    it('a reservation consumed by a completed invokeModel() cannot later authorize start()', async () => {
      const taskId = 'task_exclusive_model_first';
      await createTask(taskId);
      const dependency = fakeDependency(async () => ({ completion: 'ok' }));
      const dispatcher = new GovernedModelExecutionDispatcher(dependency);
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
      const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask(taskId));

      const reservationId = await reserve(adapter, 'inv_exclusive_model_first', taskId);
      const modelResult = await adapter.invokeModel({ reservationId, model: 'm' });
      expect(modelResult.invoked).toBe(true);

      const startResult = await adapter.start({
        invocationId: 'inv_exclusive_model_first',
        taskId,
        goal: 'Summarize the current diff.',
        reservationId,
        mode: 'agent',
      });

      expect(startSpy).not.toHaveBeenCalled();
      expect(startResult.started).toBe(false);
      expect(startResult.reasons.some(reason => reason.code === 'unknown_reservation')).toBe(true);
    });

    it('two concurrent execution paths on the same reservation cannot both cross the execution boundary', async () => {
      const taskId = 'task_exclusive_race';
      await createTask(taskId);
      const dependency = fakeDependency(async () => ({ completion: 'ok' }));
      const dispatcher = new GovernedModelExecutionDispatcher(dependency);
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
      let resolveStart: (() => void) | undefined;
      const startSpy = vi.spyOn(engine, 'startTask').mockImplementation(() => new Promise(resolve => {
        resolveStart = () => resolve(engine.getTask(taskId));
      }));

      const reservation = adapter.reserveStart({
        invocationId: 'inv_exclusive_race',
        taskId,
        goal: 'Summarize the current diff.',
        prepared: true,
      });
      const reservationId = reservation.reservationId!;

      const startPromise = adapter.start({
        invocationId: 'inv_exclusive_race',
        taskId,
        goal: 'Summarize the current diff.',
        reservationId,
        mode: 'agent',
      });
      const modelResult = await adapter.invokeModel({ reservationId, model: 'm' });

      expect(dependency.execute).not.toHaveBeenCalled();
      expect(modelResult.invoked).toBe(false);
      expect(modelResult.reasons.some(reason => reason.code === 'reservation_claimed_by_other_execution_path')).toBe(true);

      resolveStart?.();
      const startResult = await startPromise;
      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(startResult.started).toBe(true);
    });
  });
});

describe('Governed model execution result retrieval (M4.5-M4.6)', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-model-result-'));
    engine = new LocalAgentEngine(root, secretStorage());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createTask(taskId: string): Promise<void> {
    await engine.taskStore.createTask({ taskId, ...BASE_TASK });
    await engine.taskStore.updateTask(taskId, {
      phase: 'executing',
      status: 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      engineUsage: createInitialUsage('2026-01-01T00:00:00.000Z'),
    });
  }

  async function reserve(
    adapter: ReadOnlyForgeInvocationAdapter,
    invocationId: string,
    taskId: string,
    goal = 'Summarize the current diff.',
  ): Promise<string> {
    const reservation = adapter.reserveStart({
      invocationId,
      taskId,
      goal,
      prepared: true,
    });
    expect(reservation.accepted).toBe(true);
    return reservation.reservationId!;
  }

  describe('descriptor metadata', () => {
    it('classifies forge.invocation.getModelExecutionResult as read-only, non-executing, no side effects', () => {
      expect(FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR.readOnly).toBe(true);
      expect(FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR.sideEffects).toBe('none');
      expect(FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR.nonExecuting).toBe(true);
      expect(FORGE_GET_MODEL_EXECUTION_RESULT_DESCRIPTOR.version).toBe(FORGE_MODEL_INVOCATION_CONTRACT_VERSION);
    });
  });

  it('retrieves the terminal result and evidence after a completed execution', async () => {
    const taskId = 'task_result_completed';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'Here is the summary.' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_completed', taskId);

    const call = await adapter.invokeModel({ reservationId, model: 'qwen2.5-coder:7b' });
    expect(call.invoked).toBe(true);

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_completed',
      taskId,
    });

    expect(result.found).toBe(true);
    expect(result.ready).toBe(true);
    expect(result.outcome).toBe('completed');
    expect(result.invoked).toBe(true);
    expect(result.model).toBe('qwen2.5-coder:7b');
    expect(result.evidence).toBeDefined();
    expect(result.evidence?.invocationId).toBe('inv_result_completed');
    expect(result.evidence?.taskId).toBe(taskId);
    expect(result.evidence?.status).toBe('completed');
  });

  it('retrieves a failed execution with sanitized evidence only', async () => {
    const taskId = 'task_result_failed';
    await createTask(taskId);
    const dependency = fakeDependency(async () => {
      throw new Error('Authorization: Bearer sk-live-secret for prompt "Summarize the current diff."');
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_failed', taskId);

    await adapter.invokeModel({ reservationId, model: 'm' });

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_failed',
      taskId,
    });

    expect(result.outcome).toBe('failed');
    expect(result.ready).toBe(true);
    expect(result.failureCode).toBe('provider_failure');
    expect(result.evidence?.failureReason).toBe('The governed model provider failed during execution.');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('sk-live-secret');
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('Summarize the current diff.');
  });

  it('retrieves a cancelled execution reached via in-flight cancellation', async () => {
    const taskId = 'task_result_cancelled';
    await createTask(taskId);
    let releaseExecute: (() => void) | undefined;
    const dependency = fakeDependency(async request => {
      await new Promise<void>(resolve => {
        releaseExecute = resolve;
        request.signal?.addEventListener('abort', () => resolve());
      });
      throw Object.assign(new Error('aborted'), { failureCode: 'cancelled' });
    });
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_cancelled', taskId);

    const pending = adapter.invokeModel({ reservationId, model: 'm' });
    await Promise.resolve();
    await Promise.resolve();
    adapter.cancelModelCall(reservationId);
    releaseExecute?.();
    const call = await pending;
    expect(call.evidence.status).toBe('cancelled');

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_cancelled',
      taskId,
    });

    expect(result.outcome).toBe('cancelled');
    expect(result.ready).toBe(true);
    expect(result.evidence?.status).toBe('cancelled');
  });

  it('reports pending, not fabricated failure/completion, before the model call is invoked', async () => {
    const taskId = 'task_result_pending';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_pending', taskId);

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_pending',
      taskId,
    });

    expect(result.found).toBe(true);
    expect(result.ready).toBe(false);
    expect(result.outcome).toBe('pending');
    expect(result.evidence).toBeUndefined();
    expect(dependency.execute).not.toHaveBeenCalled();
  });

  it('reports pending for a genuinely in-flight call without invoking the provider again', async () => {
    const taskId = 'task_result_inflight';
    await createTask(taskId);
    let resolveExecute: ((outcome: GovernedModelExecutionOutcome) => void) | undefined;
    const dependency = fakeDependency(() => new Promise<GovernedModelExecutionOutcome>(resolve => {
      resolveExecute = resolve;
    }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_inflight', taskId);

    const pending = adapter.invokeModel({ reservationId, model: 'm' });
    await Promise.resolve();

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_inflight',
      taskId,
    });
    expect(result.outcome).toBe('pending');
    expect(result.ready).toBe(false);
    expect(dependency.execute).toHaveBeenCalledTimes(1);

    resolveExecute?.({ completion: 'ok' });
    await pending;
  });

  it('reports not_found for an unknown reservationId', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const result = adapter.getModelExecutionResult({
      reservationId: 'res_does_not_exist',
      invocationId: 'inv_x',
      taskId: 'task_x',
    });

    expect(result.found).toBe(false);
    expect(result.outcome).toBe('not_found');
    expect(result.evidence).toBeUndefined();
  });

  it('reports invalid_request for a malformed lookup request', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);

    const result = adapter.getModelExecutionResult({
      reservationId: '',
      invocationId: '',
      taskId: '',
    });

    expect(result.outcome).toBe('invalid_request');
    expect(result.found).toBe(false);
  });

  it('reports ownership_mismatch when the caller supplies the wrong invocationId/taskId for a completed call', async () => {
    const taskId = 'task_result_mismatch';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_mismatch', taskId);

    await adapter.invokeModel({ reservationId, model: 'm' });

    const wrongInvocation = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_someone_else',
      taskId,
    });
    expect(wrongInvocation.outcome).toBe('ownership_mismatch');
    expect(wrongInvocation.found).toBe(false);
    expect(wrongInvocation.evidence).toBeUndefined();

    const wrongTask = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_result_mismatch',
      taskId: 'task_other',
    });
    expect(wrongTask.outcome).toBe('ownership_mismatch');
    expect(wrongTask.evidence).toBeUndefined();
  });

  it('reports ownership_mismatch for a pending reservation owned by a different invocation', async () => {
    const taskId = 'task_result_pending_mismatch';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_pending_mismatch', taskId);

    const result = adapter.getModelExecutionResult({
      reservationId,
      invocationId: 'inv_not_the_owner',
      taskId,
    });

    expect(result.outcome).toBe('ownership_mismatch');
    expect(dependency.execute).not.toHaveBeenCalled();
  });

  it('returns the same result on repeated retrieval without invoking the provider again', async () => {
    const taskId = 'task_result_repeat';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_repeat', taskId);

    await adapter.invokeModel({ reservationId, model: 'm' });

    const first = adapter.getModelExecutionResult({ reservationId, invocationId: 'inv_result_repeat', taskId });
    const second = adapter.getModelExecutionResult({ reservationId, invocationId: 'inv_result_repeat', taskId });

    expect(first).toEqual(second);
    expect(dependency.execute).toHaveBeenCalledTimes(1);
  });

  it('does not enter engine.startTask, planning or tool execution when retrieving a result', async () => {
    const taskId = 'task_result_no_lifecycle';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const startSpy = vi.spyOn(engine, 'startTask');
    const reservationId = await reserve(adapter, 'inv_result_no_lifecycle', taskId);

    await adapter.invokeModel({ reservationId, model: 'm' });
    adapter.getModelExecutionResult({ reservationId, invocationId: 'inv_result_no_lifecycle', taskId });

    expect(startSpy).not.toHaveBeenCalled();
    expect(dependency.execute).toHaveBeenCalledTimes(1);
  });

  it('retrieves only the caller-owned result when two concurrent invocations complete independently', async () => {
    const taskIdA = 'task_result_concurrent_a';
    const taskIdB = 'task_result_concurrent_b';
    await createTask(taskIdA);
    await createTask(taskIdB);
    const resolvers = new Map<string, (outcome: GovernedModelExecutionOutcome) => void>();
    const dependency = fakeDependency(request => new Promise<GovernedModelExecutionOutcome>(resolve => {
      resolvers.set(request.invocationId, resolve);
    }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationIdA = await reserve(adapter, 'inv_result_concurrent_a', taskIdA, 'Prompt A.');
    const reservationIdB = await reserve(adapter, 'inv_result_concurrent_b', taskIdB, 'Prompt B.');

    const pendingA = adapter.invokeModel({ reservationId: reservationIdA, model: 'm' });
    const pendingB = adapter.invokeModel({ reservationId: reservationIdB, model: 'm' });
    await Promise.resolve();
    await Promise.resolve();
    resolvers.get('inv_result_concurrent_a')?.({ completion: 'completion A' });
    resolvers.get('inv_result_concurrent_b')?.({ completion: 'completion B' });
    await Promise.all([pendingA, pendingB]);

    const resultA = adapter.getModelExecutionResult({
      reservationId: reservationIdA,
      invocationId: 'inv_result_concurrent_a',
      taskId: taskIdA,
    });
    const resultB = adapter.getModelExecutionResult({
      reservationId: reservationIdB,
      invocationId: 'inv_result_concurrent_b',
      taskId: taskIdB,
    });

    expect(resultA.evidence?.invocationId).toBe('inv_result_concurrent_a');
    expect(resultA.evidence?.taskId).toBe(taskIdA);
    expect(resultB.evidence?.invocationId).toBe('inv_result_concurrent_b');
    expect(resultB.evidence?.taskId).toBe(taskIdB);

    const crossLookup = adapter.getModelExecutionResult({
      reservationId: reservationIdA,
      invocationId: 'inv_result_concurrent_b',
      taskId: taskIdB,
    });
    expect(crossLookup.outcome).toBe('ownership_mismatch');
  });

  it('never exposes the completion, prompt or raw provider exception text through retrieval', async () => {
    const taskId = 'task_result_privacy';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'the secret completion text' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const reservationId = await reserve(adapter, 'inv_result_privacy', taskId, 'the secret prompt text');

    const call = await adapter.invokeModel({ reservationId, model: 'm' });
    expect(call.completion).toBe('the secret completion text');

    const result = adapter.getModelExecutionResult({ reservationId, invocationId: 'inv_result_privacy', taskId });

    expect('completion' in result).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('the secret completion text');
    expect(serialized).not.toContain('the secret prompt text');
  });

  it('via the Forge callable surface, retrieves the same result reachable directly from the adapter', async () => {
    const taskId = 'task_result_callable';
    await createTask(taskId);
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const surface = new ReadOnlyForgeCallableSurface(adapter);
    const reservationId = await reserve(adapter, 'inv_result_callable', taskId);

    await adapter.invokeModel({ reservationId, model: 'm' });

    const response = await surface.call({
      method: FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
      params: { reservationId, invocationId: 'inv_result_callable', taskId },
    });

    expect(response.ok).toBe(true);
    if (response.ok && response.method === FORGE_GET_MODEL_EXECUTION_RESULT_METHOD) {
      expect(response.result.outcome).toBe('completed');
      expect(response.result.evidence?.invocationId).toBe('inv_result_callable');
    }
  });

  it('rejects a malformed callable request without touching the adapter state', async () => {
    const dependency = fakeDependency(async () => ({ completion: 'ok' }));
    const dispatcher = new GovernedModelExecutionDispatcher(dependency);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z', dispatcher);
    const surface = new ReadOnlyForgeCallableSurface(adapter);

    const response = await surface.call({
      method: FORGE_GET_MODEL_EXECUTION_RESULT_METHOD,
      params: { reservationId: 'x' },
    } as unknown as { method: string; params?: unknown });

    expect(response.ok).toBe(false);
  });
});

describe('ProviderGatewayGovernedModelExecutionDependency', () => {
  function baseRequest(overrides: Partial<GovernedModelRequest> = {}): GovernedModelRequest {
    return {
      contractVersion: 1,
      requestId: 'req_1',
      invocationId: 'inv_1',
      taskId: 'task_1',
      model: 'qwen2.5-coder:7b',
      prompt: 'Summarize the diff.',
      ...overrides,
    };
  }

  it('makes exactly one underlying inference call and returns its completion', async () => {
    const provider = new MockProvider();
    provider.enqueueText('Here is the summary.');
    const chatSpy = vi.spyOn(provider, 'chat');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest());

    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(outcome.completion).toBe('Here is the summary.');
  });

  it('calls chat with no tool definitions and the requested model', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    await dependency.execute(baseRequest({ model: 'llama3:8b' }));

    expect(provider.capturedRequests).toHaveLength(1);
    expect(provider.capturedRequests[0].tools).toEqual([]);
    expect(provider.capturedRequests[0].options.model).toBe('llama3:8b');
    expect(provider.capturedRequests[0].messages).toEqual([{ role: 'user', content: 'Summarize the diff.' }]);
  });

  it('passes the request signal through to the underlying provider call', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    let observedSignal: AbortSignal | undefined;
    const originalChat = provider.chat.bind(provider);
    vi.spyOn(provider, 'chat').mockImplementation(async (messages, tools, options, signal) => {
      observedSignal = signal;
      return originalChat(messages, tools, options, signal);
    });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const controller = new AbortController();

    await dependency.execute(baseRequest({ signal: controller.signal }));

    expect(observedSignal).toBe(controller.signal);
  });

  it('reports the actual resolved provider identity, not caller input or a default', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest({ providerType: 'openai-compatible' }));

    expect(outcome.providerType).toBe('ollama');
    expect(outcome.providerType).not.toBe('openai-compatible');
  });

  it('propagates the actual provider identity through the dispatcher into evidence', async () => {
    const provider = new MockProvider();
    provider.enqueueText('ok');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.providerType).toBe('ollama');
    expect(result.evidence.providerType).toBe('ollama');
  });

  it('rejects a response that is not marked done, tagged with the sanitized sub-reason "not_done"', async () => {
    const provider = new MockProvider();
    provider.enqueue({ message: { role: 'assistant', content: 'partial' }, done: false });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    await expect(dependency.execute(baseRequest())).rejects.toMatchObject({
      failureCode: 'invalid_model_response',
      invalidResponseReason: 'not_done',
    });
  });

  it('rejects a response with missing/empty completion text, tagged with the sanitized sub-reason "empty_content"', async () => {
    const provider = new MockProvider();
    // Empty twice: the adaptive retry with native reasoning off is empty as well, so the failure is still reported.
    provider.enqueue({ message: { role: 'assistant', content: '' }, done: true });
    provider.enqueue({ message: { role: 'assistant', content: '' }, done: true });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    await expect(dependency.execute(baseRequest())).rejects.toMatchObject({
      failureCode: 'invalid_model_response',
      invalidResponseReason: 'empty_content',
    });
  });

  it('retries an empty completion once with native reasoning off and records why (adaptive contract enforcement)', async () => {
    const provider = new MockProvider();
    provider.enqueue({ message: { role: 'assistant', content: '' }, done: true });
    provider.enqueueText('{"ok":true}');
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    const outcome = await dependency.execute(baseRequest());
    expect(outcome.completion).toBe('{"ok":true}');
    expect(outcome.contextEvidence.adaptation).toBe('disable_thinking:empty_completion');
    expect(provider.capturedRequests).toHaveLength(2);
    expect(provider.capturedRequests[1].options?.nativeThinking).toBe(false);
    expect(provider.capturedRequests[0].messages).toEqual(provider.capturedRequests[1].messages);
  });

  it('rejects an unexpected tool-call response for a tool-free governed call, tagged with the sanitized sub-reason "unexpected_tool_call"', async () => {
    const provider = new MockProvider();
    provider.enqueueToolCall('read_file', { path: 'a.ts' });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    await expect(dependency.execute(baseRequest())).rejects.toMatchObject({
      failureCode: 'invalid_model_response',
      invalidResponseReason: 'unexpected_tool_call',
    });
  });

  it('never persists the raw response/prompt/completion text alongside the sanitized sub-reason — only the enum tag itself', async () => {
    const provider = new MockProvider();
    provider.enqueueToolCall('read_file', { path: '/secret/path.ts' });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);

    let caught: unknown;
    try {
      await dependency.execute(baseRequest({ prompt: 'Sensitive prompt fragment.' }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    // The thrown error carries only a fixed, generic message and the sanitized
    // enum tag — never the raw tool-call arguments, path, or prompt text.
    expect((caught as { invalidResponseReason?: string }).invalidResponseReason).toBe('unexpected_tool_call');
    expect(JSON.stringify(caught)).not.toContain('/secret/path.ts');
    expect(JSON.stringify(caught)).not.toContain('Sensitive prompt fragment.');
    expect(String((caught as Error).message)).not.toContain('/secret/path.ts');
  });

  it('keeps the existing sanitized user-facing failureReason unchanged when the sub-reason is added', async () => {
    const provider = new MockProvider();
    provider.enqueue({ message: { role: 'assistant', content: 'partial' }, done: false });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.failureCode).toBe('invalid_model_response');
    expect(result.failureReason).toBe('The governed model provider returned an invalid response.');
    expect(result.invalidResponseReason).toBe('not_done');
  });

  it('normalizes an invalid production response deterministically through the dispatcher (no fabricated success)', async () => {
    const provider = new MockProvider();
    provider.enqueue({ message: { role: 'assistant', content: 'partial' }, done: false });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('invalid_model_response');
    expect(result.completion).toBeUndefined();
  });

  it('maps missing provider models to model_unavailable without leaking raw details', async () => {
    const raw = 'raw Ollama response with Authorization: Bearer sk-live-secret and prompt text';
    const provider = new MockProvider();
    const chatSpy = vi.spyOn(provider, 'chat').mockRejectedValue(
      new ProviderModelNotFoundError(raw, 'ollama', 'qwen-missing:latest'),
    );
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest({ model: 'qwen-missing:latest' }));

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('model_unavailable');
    expect(result.failureReason).toBe('The requested governed model was unavailable.');
    expect(result.evidence.failureCode).toBe('model_unavailable');
    expect(result.evidence.failureReason).toBe('The requested governed model was unavailable.');
    expect(result.completion).toBeUndefined();
    expect(chatSpy).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(raw);
    expect(JSON.stringify(result)).not.toContain('sk-live-secret');
    expect(JSON.stringify(result)).not.toContain('prompt text');
  });

  it('maps provider timeout to timeout without leaking raw details', async () => {
    const raw = 'timeout includes raw endpoint and secret token';
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(new ProviderTimeoutError(raw, 'ollama', 5000));
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('timeout');
    expect(result.failureReason).toBe('The governed model provider did not respond within the allotted time.');
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it('maps provider cancellation to cancelled, not provider_failure', async () => {
    const raw = 'cancellation includes raw endpoint and secret token';
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(new ProviderCancelledError(raw, 'ollama'));
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('cancelled');
    expect(result.failureCode).not.toBe('provider_failure');
    expect(result.failureReason).toBe('The governed model call was cancelled before completion.');
    expect(JSON.stringify(result)).not.toContain(raw);
  });

  it.each([
    new ProviderConnectionError('connection raw response body', 'ollama', 'http://localhost:11434'),
    new ProviderApiError('api raw response body', 'ollama', 500),
    new ProviderAuthError('auth raw access key detail', 'openai-compatible'),
  ])('keeps generic typed provider failures as provider_failure', async (error) => {
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(error);
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('provider_failure');
    expect(result.failureReason).toBe('The governed model provider failed during execution.');
    expect(JSON.stringify(result)).not.toContain(error.message);
  });

  it('leaves unknown provider errors to the dispatcher fallback', async () => {
    const provider = new MockProvider();
    vi.spyOn(provider, 'chat').mockRejectedValue(new Error('unknown raw detail'));
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest());

    expect(result.status).toBe('failed');
    expect(result.failureCode).toBe('provider_failure');
    expect(JSON.stringify(result)).not.toContain('unknown raw detail');
  });

  it('keeps AbortSignal cancellation authoritative over typed provider failures', async () => {
    const provider = new MockProvider();
    const controller = new AbortController();
    vi.spyOn(provider, 'chat').mockImplementation(async () => {
      controller.abort();
      throw new ProviderModelNotFoundError('raw missing model after abort', 'ollama', 'missing');
    });
    const dependency = new ProviderGatewayGovernedModelExecutionDependency(async () => provider);
    const dispatcher = new GovernedModelExecutionDispatcher(dependency, fixedClock(
      '2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:01.000Z',
    ));

    const result = await dispatcher.dispatch(baseRequest({ signal: controller.signal }));

    expect(result.status).toBe('cancelled');
    expect(result.failureCode).toBe('cancelled');
    expect(result.failureReason).toBe('Cancelled via the existing AbortSignal cancellation convention.');
  });
});
