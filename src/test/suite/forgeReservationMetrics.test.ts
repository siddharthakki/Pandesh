import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR,
  FORGE_RESERVATION_METRICS_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationReservationMetricsCallable,
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
  userGoal: 'Inspect Forge reservation metrics',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge reservation metrics callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-reservation-metrics-'));
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
    registerGovernedForgeInvocationReservationMetricsCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers reservation metrics as local read-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationReservationMetricsCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR]);
    expect(FORGE_INVOCATION_RESERVATION_METRICS_DESCRIPTOR).toEqual({
      id: FORGE_RESERVATION_METRICS_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('reports zeroed metrics with no reservations', async () => {
    const response = await transport().invoke(FORGE_RESERVATION_METRICS_METHOD, {
      audit: { callerId: 'forge' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationMetrics).toEqual({
      total: 0,
      active: 0,
      expired: 0,
      leased: 0,
      available: 0,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      audit: { callerId: 'forge' },
    });
  });

  it('counts active, leased and available reservations without lifecycle mutation', async () => {
    await createTask('task_metrics_a');
    await createTask('task_metrics_b');

    const local = transport();
    const beforeA = await engine.taskStore.getTask('task_metrics_a');
    const beforeB = await engine.taskStore.getTask('task_metrics_b');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_metrics_a',
      taskId: 'task_metrics_a',
      goal: 'Reserve A',
      prepared: true,
    });
    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_metrics_b',
      taskId: 'task_metrics_b',
      goal: 'Reserve B',
      prepared: true,
    });

    adapter.acquireReservation({
      reservationId: 'forge-start-reservation:inv_metrics_a:task_metrics_a',
      ownerId: 'owner-a',
    });

    const response = await local.invoke(FORGE_RESERVATION_METRICS_METHOD, {});

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationMetrics).toMatchObject({
      total: 2,
      active: 2,
      expired: 0,
      leased: 1,
      available: 1,
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_metrics_a')).toEqual(beforeA);
    expect(await engine.taskStore.getTask('task_metrics_b')).toEqual(beforeB);
  });

  it('counts expired reservations separately from active ones', async () => {
    await createTask('task_metrics_expired');
    const mutableNow = { value: '2026-01-01T00:00:00.000Z' };
    const local = transport(() => mutableNow.value);

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_metrics_expired',
      taskId: 'task_metrics_expired',
      goal: 'Reserve then age out',
      prepared: true,
    });

    mutableNow.value = '2026-01-01T00:06:00.000Z';

    const response = await local.invoke(FORGE_RESERVATION_METRICS_METHOD, {});
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationMetrics).toMatchObject({
      total: 1,
      active: 0,
      expired: 1,
      leased: 0,
      available: 0,
      checkedAt: '2026-01-01T00:06:00.000Z',
    });
  });

  it('rejects invalid metrics params with the standard envelope', async () => {
    const response = await transport().invoke(FORGE_RESERVATION_METRICS_METHOD, 'not-an-object');

    expect(response).toEqual({
      ok: false,
      method: FORGE_RESERVATION_METRICS_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_RESERVATION_METRICS_METHOD}`,
        details: [
          'params must be an object when provided',
        ],
      },
    });
  });
});
