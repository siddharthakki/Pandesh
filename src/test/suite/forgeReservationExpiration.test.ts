import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_EXPIRE_START_RESERVATION_METHOD,
  FORGE_GET_START_RESERVATION_METHOD,
  FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationStartReservationCallable,
  registerGovernedForgeInvocationStartReservationExpirationCallable,
  registerGovernedForgeInvocationStartReservationLookupCallable,
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
  userGoal: 'Inspect Forge reservation expiration',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge reservation expiration callable', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-reservation-expire-'));
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
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_expire',
      taskId: 'task_expire',
      audit: { callerId: 'forge' },
    }], now));

    registerGovernedForgeInvocationStartReservationCallable(registry, surface);
    registerGovernedForgeInvocationStartReservationLookupCallable(registry, surface);
    registerGovernedForgeInvocationStartReservationExpirationCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers reservation expiration as local metadata-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationStartReservationExpirationCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR]);
    expect(FORGE_INVOCATION_START_RESERVATION_EXPIRATION_DESCRIPTOR).toEqual({
      id: FORGE_EXPIRE_START_RESERVATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
  });

  it('expires and removes an active start reservation without task lifecycle mutation', async () => {
    await createTask('task_expire');
    const local = transport();
    const beforeTask = await engine.taskStore.getTask('task_expire');
    const beforeEvents = await engine.taskStore.getEvents('task_expire');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    const reservation = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_expire',
      taskId: 'task_expire',
      goal: 'Reserve then expire',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_expire' },
    });

    expect(reservation.ok).toBe(true);
    if (!reservation.ok) { throw new Error(reservation.error.message); }

    const expiration = await local.invoke(FORGE_EXPIRE_START_RESERVATION_METHOD, {
      reservationId: 'forge-start-reservation:inv_expire:task_expire',
    });

    expect(expiration.ok).toBe(true);
    if (!expiration.ok) { throw new Error(expiration.error.message); }
    expect(expiration.reservationExpiration).toMatchObject({
      expired: true,
      found: true,
      reservationId: 'forge-start-reservation:inv_expire:task_expire',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      expiredAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'reservation_expired',
        message: 'Start reservation metadata was expired and removed.',
      }],
      audit: { callerId: 'forge', correlationId: 'corr_expire' },
    });

    const lookup = await local.invoke(FORGE_GET_START_RESERVATION_METHOD, {
      reservationId: 'forge-start-reservation:inv_expire:task_expire',
    });

    expect(lookup.ok).toBe(true);
    if (!lookup.ok) { throw new Error(lookup.error.message); }
    expect(lookup.reservationLookup).toMatchObject({
      found: false,
      active: false,
      expired: false,
      reasons: [{
        code: 'unknown_reservation',
        message: 'No start reservation exists for the requested reservationId.',
      }],
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_expire')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_expire')).toEqual(beforeEvents);
  });

  it('returns a metadata-only miss for unknown reservation expiration', async () => {
    const response = await transport().invoke(FORGE_EXPIRE_START_RESERVATION_METHOD, {
      reservationId: 'forge-start-reservation:missing',
      audit: { callerId: 'forge' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationExpiration).toEqual({
      expired: false,
      found: false,
      reservationId: 'forge-start-reservation:missing',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      expiredAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'unknown_reservation',
        message: 'No start reservation exists for the requested reservationId.',
      }],
      audit: { callerId: 'forge' },
    });
  });
});
