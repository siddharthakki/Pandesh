import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR,
  FORGE_SCHEDULER_SNAPSHOT_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeSchedulerSnapshotCallable,
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
  userGoal: 'Inspect Forge scheduler snapshot',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge scheduler snapshot callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-scheduler-snapshot-'));
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
    registerGovernedForgeSchedulerSnapshotCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers scheduler snapshot as local read-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeSchedulerSnapshotCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR]);
    expect(FORGE_SCHEDULER_SNAPSHOT_DESCRIPTOR).toEqual({
      id: FORGE_SCHEDULER_SNAPSHOT_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('reports combined metrics and queue state without lifecycle mutation', async () => {
    await createTask('task_snapshot_a');
    await createTask('task_snapshot_b');

    const local = transport();
    const beforeA = await engine.taskStore.getTask('task_snapshot_a');
    const beforeB = await engine.taskStore.getTask('task_snapshot_b');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_snapshot_a',
      taskId: 'task_snapshot_a',
      goal: 'Reserve A',
      prepared: true,
    });
    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_snapshot_b',
      taskId: 'task_snapshot_b',
      goal: 'Reserve B',
      prepared: true,
    });

    adapter.acquireReservation({
      reservationId: 'forge-start-reservation:inv_snapshot_a:task_snapshot_a',
      ownerId: 'owner-a',
    });

    const response = await local.invoke(FORGE_SCHEDULER_SNAPSHOT_METHOD, {
      audit: { callerId: 'forge', correlationId: 'corr_snapshot' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.schedulerSnapshot).toMatchObject({
      metrics: {
        total: 2,
        active: 2,
        expired: 0,
        leased: 1,
        available: 1,
      },
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      audit: { callerId: 'forge', correlationId: 'corr_snapshot' },
    });
    expect(response.schedulerSnapshot.queue.map(entry => entry.reservationId).sort()).toEqual([
      'forge-start-reservation:inv_snapshot_a:task_snapshot_a',
      'forge-start-reservation:inv_snapshot_b:task_snapshot_b',
    ]);

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_snapshot_a')).toEqual(beforeA);
    expect(await engine.taskStore.getTask('task_snapshot_b')).toEqual(beforeB);
  });

  it('excludes expired reservations from the queue by default while metrics still count them', async () => {
    await createTask('task_snapshot_expired');
    const mutableNow = { value: '2026-01-01T00:00:00.000Z' };
    const local = transport(() => mutableNow.value);

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_snapshot_expired',
      taskId: 'task_snapshot_expired',
      goal: 'Reserve then age out',
      prepared: true,
    });

    mutableNow.value = '2026-01-01T00:06:00.000Z';

    const response = await local.invoke(FORGE_SCHEDULER_SNAPSHOT_METHOD, {});
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.schedulerSnapshot.queue).toEqual([]);
    expect(response.schedulerSnapshot.metrics).toMatchObject({
      total: 1,
      active: 0,
      expired: 1,
    });

    const includeExpired = await local.invoke(FORGE_SCHEDULER_SNAPSHOT_METHOD, {
      includeExpired: true,
    });
    expect(includeExpired.ok).toBe(true);
    if (!includeExpired.ok) { throw new Error(includeExpired.error.message); }
    expect(includeExpired.schedulerSnapshot.queue).toHaveLength(1);
    expect(includeExpired.schedulerSnapshot.queue[0]).toMatchObject({
      reservationId: 'forge-start-reservation:inv_snapshot_expired:task_snapshot_expired',
      expired: true,
    });
  });

  it('rejects invalid snapshot params with the standard envelope', async () => {
    const response = await transport().invoke(FORGE_SCHEDULER_SNAPSHOT_METHOD, {
      includeExpired: 'yes',
    });

    expect(response).toEqual({
      ok: false,
      method: FORGE_SCHEDULER_SNAPSHOT_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_SCHEDULER_SNAPSHOT_METHOD}`,
        details: [
          'params.includeExpired must be a boolean when provided',
        ],
      },
    });
  });
});
