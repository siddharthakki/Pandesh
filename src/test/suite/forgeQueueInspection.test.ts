import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR,
  FORGE_INSPECT_QUEUE_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationQueueInspectionCallable,
  registerGovernedForgeInvocationStartReservationCallable,
} from '../../agent/ForgeCallableSurface';
import { ReadOnlyForgeInvocationAdapter } from '../../agent/ForgeInvocationAdapter';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';
import { LocalAgentEngine } from '../../agent/LocalAgentEngine';

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
  userGoal: 'Inspect Forge reservation queue',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge queue inspection callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-queue-inspection-'));
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

  function transport(now: () => string = () => '2026-01-01T00:00:00.000Z'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    adapter = new ReadOnlyForgeInvocationAdapter(engine, [], now);
    const surface = new ReadOnlyForgeCallableSurface(adapter);

    registerGovernedForgeInvocationStartReservationCallable(registry, surface);
    registerGovernedForgeInvocationQueueInspectionCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers queue inspection as local read-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationQueueInspectionCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR]);
    expect(FORGE_INVOCATION_QUEUE_INSPECTION_DESCRIPTOR).toEqual({
      id: FORGE_INSPECT_QUEUE_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('orders active reservations by creation time without lifecycle mutation', async () => {
    await createTask('task_queue_a');
    await createTask('task_queue_b');

    const mutableNow = { value: '2026-01-01T00:00:00.000Z' };
    const local = transport(() => mutableNow.value);
    const beforeA = await engine.taskStore.getTask('task_queue_a');
    const beforeB = await engine.taskStore.getTask('task_queue_b');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_queue_a',
      taskId: 'task_queue_a',
      goal: 'Reserve A first',
      prepared: true,
    });

    mutableNow.value = '2026-01-01T00:00:01.000Z';
    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_queue_b',
      taskId: 'task_queue_b',
      goal: 'Reserve B second',
      prepared: true,
    });

    adapter.acquireReservation({
      reservationId: 'forge-start-reservation:inv_queue_a:task_queue_a',
      ownerId: 'owner-a',
    });

    const response = await local.invoke(FORGE_INSPECT_QUEUE_METHOD, {
      audit: { callerId: 'forge', correlationId: 'corr_queue' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.queueInspection).toMatchObject({
      total: 2,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:01.000Z',
      audit: { callerId: 'forge', correlationId: 'corr_queue' },
    });
    expect(response.queueInspection.entries).toMatchObject([
      {
        reservationId: 'forge-start-reservation:inv_queue_a:task_queue_a',
        position: 1,
        invocationId: 'inv_queue_a',
        taskId: 'task_queue_a',
        expired: false,
        leased: true,
        ownerId: 'owner-a',
      },
      {
        reservationId: 'forge-start-reservation:inv_queue_b:task_queue_b',
        position: 2,
        invocationId: 'inv_queue_b',
        taskId: 'task_queue_b',
        expired: false,
        leased: false,
      },
    ]);

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_queue_a')).toEqual(beforeA);
    expect(await engine.taskStore.getTask('task_queue_b')).toEqual(beforeB);
  });

  it('excludes expired reservations by default and includes them when requested', async () => {
    await createTask('task_queue_expired');
    const mutableNow = { value: '2026-01-01T00:00:00.000Z' };
    const local = transport(() => mutableNow.value);

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_queue_expired',
      taskId: 'task_queue_expired',
      goal: 'Reserve then age out',
      prepared: true,
    });

    mutableNow.value = '2026-01-01T00:06:00.000Z';

    const defaultInspection = await local.invoke(FORGE_INSPECT_QUEUE_METHOD, {});
    expect(defaultInspection.ok).toBe(true);
    if (!defaultInspection.ok) { throw new Error(defaultInspection.error.message); }
    expect(defaultInspection.queueInspection.entries).toEqual([]);
    expect(defaultInspection.queueInspection.total).toBe(0);

    const includeExpired = await local.invoke(FORGE_INSPECT_QUEUE_METHOD, {
      includeExpired: true,
    });
    expect(includeExpired.ok).toBe(true);
    if (!includeExpired.ok) { throw new Error(includeExpired.error.message); }
    expect(includeExpired.queueInspection.total).toBe(1);
    expect(includeExpired.queueInspection.entries[0]).toMatchObject({
      reservationId: 'forge-start-reservation:inv_queue_expired:task_queue_expired',
      expired: true,
      leased: false,
    });
  });

  it('rejects invalid queue inspection params with the standard envelope', async () => {
    const response = await transport().invoke(FORGE_INSPECT_QUEUE_METHOD, {
      includeExpired: 'yes',
    });

    expect(response).toEqual({
      ok: false,
      method: FORGE_INSPECT_QUEUE_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_INSPECT_QUEUE_METHOD}`,
        details: [
          'params.includeExpired must be a boolean when provided',
        ],
      },
    });
  });
});
