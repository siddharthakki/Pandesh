import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_SCHEDULER_VALIDATE_DESCRIPTOR,
  FORGE_SCHEDULER_VALIDATE_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeSchedulerValidateCallable,
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
  userGoal: 'Validate Forge scheduler state',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge scheduler validation callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-scheduler-validate-'));
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
    registerGovernedForgeSchedulerValidateCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers scheduler validation as local read-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeSchedulerValidateCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_SCHEDULER_VALIDATE_DESCRIPTOR]);
    expect(FORGE_SCHEDULER_VALIDATE_DESCRIPTOR).toEqual({
      id: FORGE_SCHEDULER_VALIDATE_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('reports valid with no reservations and no lifecycle mutation', async () => {
    const local = transport();

    const response = await local.invoke(FORGE_SCHEDULER_VALIDATE_METHOD, {
      audit: { callerId: 'forge' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.schedulerValidation).toEqual({
      valid: true,
      issues: [],
      checkedReservations: 0,
      checkedLeases: 0,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      audit: { callerId: 'forge' },
    });
  });

  it('validates reservations and leases produced through the governed path without mutation', async () => {
    await createTask('task_validate_a');
    const local = transport();
    const beforeTask = await engine.taskStore.getTask('task_validate_a');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_validate_a',
      taskId: 'task_validate_a',
      goal: 'Reserve then validate',
      prepared: true,
    });

    adapter.acquireReservation({
      reservationId: 'forge-start-reservation:inv_validate_a:task_validate_a',
      ownerId: 'owner-a',
    });

    const response = await local.invoke(FORGE_SCHEDULER_VALIDATE_METHOD, {});

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.schedulerValidation).toMatchObject({
      valid: true,
      issues: [],
      checkedReservations: 1,
      checkedLeases: 1,
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_validate_a')).toEqual(beforeTask);
  });

  it('flags an orphaned lease that references a removed reservation', async () => {
    await createTask('task_validate_orphan');
    const local = transport();

    await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_validate_orphan',
      taskId: 'task_validate_orphan',
      goal: 'Reserve then expire while leased',
      prepared: true,
    });

    const reservationId = 'forge-start-reservation:inv_validate_orphan:task_validate_orphan';
    adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });
    adapter.expireReservation({ reservationId });

    const response = await local.invoke(FORGE_SCHEDULER_VALIDATE_METHOD, {});

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.schedulerValidation).toMatchObject({
      valid: false,
      checkedReservations: 0,
      checkedLeases: 1,
      issues: [{
        code: 'orphaned_lease',
        message: 'Lease references a reservation that no longer exists.',
        reservationId,
      }],
    });
  });

  it('rejects invalid validation params with the standard envelope', async () => {
    const response = await transport().invoke(FORGE_SCHEDULER_VALIDATE_METHOD, 'not-an-object');

    expect(response).toEqual({
      ok: false,
      method: FORGE_SCHEDULER_VALIDATE_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_SCHEDULER_VALIDATE_METHOD}`,
        details: [
          'params must be an object when provided',
        ],
      },
    });
  });
});
