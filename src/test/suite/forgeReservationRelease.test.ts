import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR,
  FORGE_RELEASE_RESERVATION_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationReservationReleaseCallable,
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
  userGoal: 'Inspect Forge reservation release',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge reservation release callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-reservation-release-'));
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

  function transport(
    invocationId = 'inv_release',
    taskId = 'task_release',
    now: () => string = () => '2026-01-01T00:00:00.000Z',
  ): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId,
      taskId,
      audit: { callerId: 'forge' },
    }], now);
    const surface = new ReadOnlyForgeCallableSurface(adapter);

    registerGovernedForgeInvocationStartReservationCallable(registry, surface);
    registerGovernedForgeInvocationReservationReleaseCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers reservation release as local metadata-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationReservationReleaseCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR]);
    expect(FORGE_INVOCATION_RESERVATION_RELEASE_DESCRIPTOR).toEqual({
      id: FORGE_RELEASE_RESERVATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
  });

  it('releases an owned reservation lease without task lifecycle mutation', async () => {
    await createTask('task_release');
    const local = transport();
    const beforeTask = await engine.taskStore.getTask('task_release');
    const beforeEvents = await engine.taskStore.getEvents('task_release');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    const reservation = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_release',
      taskId: 'task_release',
      goal: 'Reserve then release',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_release' },
    });

    expect(reservation.ok).toBe(true);
    if (!reservation.ok) { throw new Error(reservation.error.message); }

    const reservationId = 'forge-start-reservation:inv_release:task_release';
    const acquisition = adapter.acquireReservation({
      reservationId,
      ownerId: 'owner-a',
    });
    expect(acquisition.acquired).toBe(true);

    const release = await local.invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId,
      ownerId: 'owner-a',
      audit: { callerId: 'forge', correlationId: 'corr_release' },
    });

    expect(release.ok).toBe(true);
    if (!release.ok) { throw new Error(release.error.message); }
    expect(release.reservationRelease).toMatchObject({
      released: true,
      alreadyReleased: false,
      reservationId,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'released',
        message: 'Reservation lease released.',
      }],
      audit: { callerId: 'forge', correlationId: 'corr_release' },
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_release')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_release')).toEqual(beforeEvents);
  });

  it('is idempotent when the same owner releases twice', async () => {
    const local = transport('inv_idempotent', 'task_idempotent');
    const reserved = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_idempotent',
      taskId: 'task_idempotent',
      goal: 'Reserve then release twice',
      prepared: true,
    });
    expect(reserved.ok).toBe(true);
    const reservationId = 'forge-start-reservation:inv_idempotent:task_idempotent';
    adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });

    const first = await local.invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId,
      ownerId: 'owner-a',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) { throw new Error(first.error.message); }
    expect(first.reservationRelease).toMatchObject({ released: true, alreadyReleased: false });

    const second = await local.invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId,
      ownerId: 'owner-a',
    });
    expect(second.ok).toBe(true);
    if (!second.ok) { throw new Error(second.error.message); }
    expect(second.reservationRelease).toMatchObject({
      released: true,
      alreadyReleased: true,
      reasons: [{
        code: 'not_acquired',
        message: 'No active reservation lease exists; release is a no-op.',
      }],
    });
  });

  it('rejects release attempts from a different owner and preserves the lease', async () => {
    const local = transport('inv_mismatch', 'task_mismatch');
    const reserved = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_mismatch',
      taskId: 'task_mismatch',
      goal: 'Reserve then release from another owner',
      prepared: true,
    });
    expect(reserved.ok).toBe(true);
    const reservationId = 'forge-start-reservation:inv_mismatch:task_mismatch';
    adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });

    const release = await local.invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId,
      ownerId: 'owner-b',
    });

    expect(release.ok).toBe(true);
    if (!release.ok) { throw new Error(release.error.message); }
    expect(release.reservationRelease).toMatchObject({
      released: false,
      alreadyReleased: false,
      reasons: [{
        code: 'owner_mismatch',
        message: 'Reservation lease is owned by another caller.',
      }],
    });

    const reacquireByOwner = adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });
    expect(reacquireByOwner).toMatchObject({ acquired: true, alreadyOwned: true });
  });

  it('is a no-op for a reservationId that was never acquired', async () => {
    const response = await transport().invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId: 'forge-lease:missing',
      ownerId: 'owner-a',
      audit: { callerId: 'forge' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationRelease).toEqual({
      released: true,
      alreadyReleased: true,
      reservationId: 'forge-lease:missing',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'not_acquired',
        message: 'No active reservation lease exists; release is a no-op.',
      }],
      audit: { callerId: 'forge' },
    });
  });

  it('rejects malformed release requests', async () => {
    const response = await transport().invoke(FORGE_RELEASE_RESERVATION_METHOD, {
      reservationId: '',
      ownerId: 'owner-a',
    });

    expect(response.ok).toBe(false);
    if (response.ok) { throw new Error('expected invalid_request error'); }
    expect(response.error.code).toBe('invalid_request');
  });
});
