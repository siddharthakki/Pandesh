import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_LIST_START_RESERVATIONS_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationStartReservationCallable,
  registerGovernedForgeInvocationStartReservationListCallable,
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
  userGoal: 'List Forge start reservations',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge reservation list callable', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-reservation-list-'));
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
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, [], now));

    registerGovernedForgeInvocationStartReservationCallable(registry, surface);
    registerGovernedForgeInvocationStartReservationListCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers reservation list as local read-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationStartReservationListCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR]);
    expect(FORGE_INVOCATION_START_RESERVATION_LIST_DESCRIPTOR).toEqual({
      id: FORGE_LIST_START_RESERVATIONS_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('lists active reservations without lifecycle mutation', async () => {
    await createTask('task_list_a');
    await createTask('task_list_b');

    const local = transport();
    const beforeA = await engine.taskStore.getTask('task_list_a');
    const beforeB = await engine.taskStore.getTask('task_list_b');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_list_a',
      taskId: 'task_list_a',
      goal: 'Reserve A',
      prepared: true,
    });
    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_list_b',
      taskId: 'task_list_b',
      goal: 'Reserve B',
      prepared: true,
    });

    const response = await local.invoke(FORGE_LIST_START_RESERVATIONS_METHOD, {
      audit: { callerId: 'forge', correlationId: 'corr_list' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationList).toMatchObject({
      total: 2,
      active: 2,
      expired: 0,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      audit: { callerId: 'forge', correlationId: 'corr_list' },
    });
    expect(response.reservationList.reservations.map(item => item.reservationId).sort()).toEqual([
      'forge-start-reservation:inv_list_a:task_list_a',
      'forge-start-reservation:inv_list_b:task_list_b',
    ]);

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_list_a')).toEqual(beforeA);
    expect(await engine.taskStore.getTask('task_list_b')).toEqual(beforeB);
  });

  it('excludes expired reservations by default and includes them when requested', async () => {
    await createTask('task_expired');
    const mutableNow = { value: '2026-01-01T00:00:00.000Z' };
    const local = transport(() => mutableNow.value);

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_expired',
      taskId: 'task_expired',
      goal: 'Reserve then age out',
      prepared: true,
    });

    mutableNow.value = '2026-01-01T00:06:00.000Z';

    const defaultList = await local.invoke(FORGE_LIST_START_RESERVATIONS_METHOD, {});
    expect(defaultList.ok).toBe(true);
    if (!defaultList.ok) { throw new Error(defaultList.error.message); }
    expect(defaultList.reservationList).toMatchObject({
      total: 0,
      active: 0,
      expired: 1,
      checkedAt: '2026-01-01T00:06:00.000Z',
    });
    expect(defaultList.reservationList.reservations).toEqual([]);

    const includeExpired = await local.invoke(FORGE_LIST_START_RESERVATIONS_METHOD, {
      includeExpired: true,
    });
    expect(includeExpired.ok).toBe(true);
    if (!includeExpired.ok) { throw new Error(includeExpired.error.message); }
    expect(includeExpired.reservationList).toMatchObject({
      total: 1,
      active: 0,
      expired: 1,
      checkedAt: '2026-01-01T00:06:00.000Z',
    });
    expect(includeExpired.reservationList.reservations[0]).toMatchObject({
      reservationId: 'forge-start-reservation:inv_expired:task_expired',
      invocationId: 'inv_expired',
      taskId: 'task_expired',
    });
  });

  it('rejects invalid list params with the standard envelope', async () => {
    const response = await transport().invoke(FORGE_LIST_START_RESERVATIONS_METHOD, {
      includeExpired: 'yes',
    });

    expect(response).toEqual({
      ok: false,
      method: FORGE_LIST_START_RESERVATIONS_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_LIST_START_RESERVATIONS_METHOD}`,
        details: [
          'params.includeExpired must be a boolean when provided',
        ],
      },
    });
  });
});
