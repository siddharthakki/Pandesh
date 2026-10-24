import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR,
  FORGE_RENEW_RESERVATION_LEASE_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationReservationLeaseRenewalCallable,
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
  userGoal: 'Inspect Forge reservation lease renewal',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('Forge reservation lease renewal callable', () => {
  let root: string;
  let engine: LocalAgentEngine;
  let adapter: ReadOnlyForgeInvocationAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-reservation-renewal-'));
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
    invocationId = 'inv_renew',
    taskId = 'task_renew',
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
    registerGovernedForgeInvocationReservationLeaseRenewalCallable(registry, surface);

    return new LocalForgeCallableTransport(registry);
  }

  it('discovers reservation lease renewal as local metadata-only non-executing callable', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    const surface = new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, []));
    registerGovernedForgeInvocationReservationLeaseRenewalCallable(registry, surface);

    expect(registry.discover()).toEqual([FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR]);
    expect(FORGE_INVOCATION_RESERVATION_LEASE_RENEWAL_DESCRIPTOR).toEqual({
      id: FORGE_RENEW_RESERVATION_LEASE_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
  });

  it('renews an owned reservation lease without task lifecycle mutation', async () => {
    await createTask('task_renew');
    const local = transport();
    const beforeTask = await engine.taskStore.getTask('task_renew');
    const beforeEvents = await engine.taskStore.getEvents('task_renew');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');

    const reservation = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_renew',
      taskId: 'task_renew',
      goal: 'Reserve then renew',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_renew' },
    });

    expect(reservation.ok).toBe(true);
    if (!reservation.ok) { throw new Error(reservation.error.message); }

    const reservationId = 'forge-start-reservation:inv_renew:task_renew';
    const acquisition = adapter.acquireReservation({
      reservationId,
      ownerId: 'owner-a',
    });
    expect(acquisition.acquired).toBe(true);

    const renewal = await local.invoke(FORGE_RENEW_RESERVATION_LEASE_METHOD, {
      reservationId,
      ownerId: 'owner-a',
      audit: { callerId: 'forge', correlationId: 'corr_renew' },
    });

    expect(renewal.ok).toBe(true);
    if (!renewal.ok) { throw new Error(renewal.error.message); }
    expect(renewal.reservationLeaseRenewal).toMatchObject({
      renewed: true,
      reservationId,
      lease: {
        reservationId,
        ownerId: 'owner-a',
        leaseId: `forge-lease:${reservationId}`,
      },
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'renewed',
        message: 'Reservation lease renewal recorded in memory.',
      }],
      audit: { callerId: 'forge', correlationId: 'corr_renew' },
    });

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_renew')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_renew')).toEqual(beforeEvents);
  });

  it('extends the lease expiry beyond the prior value', async () => {
    let current = '2026-01-01T00:00:00.000Z';
    const local = transport('inv_extend', 'task_extend', () => current);
    const reserved = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_extend',
      taskId: 'task_extend',
      goal: 'Reserve then renew after time passes',
      prepared: true,
    });
    expect(reserved.ok).toBe(true);
    const reservationId = 'forge-start-reservation:inv_extend:task_extend';
    const acquisition = adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });
    expect(acquisition.acquired).toBe(true);
    const originalExpiresAt = acquisition.lease?.expiresAt;

    current = '2026-01-01T00:01:00.000Z';
    const renewal = await local.invoke(FORGE_RENEW_RESERVATION_LEASE_METHOD, {
      reservationId,
      ownerId: 'owner-a',
    });

    expect(renewal.ok).toBe(true);
    if (!renewal.ok) { throw new Error(renewal.error.message); }
    expect(renewal.reservationLeaseRenewal.renewed).toBe(true);
    const renewedExpiresAt = renewal.reservationLeaseRenewal.lease?.expiresAt;
    expect(renewedExpiresAt).toBeDefined();
    expect(Date.parse(renewedExpiresAt as string)).toBeGreaterThan(Date.parse(originalExpiresAt as string));
  });

  it('rejects renewal attempts from a different owner and preserves the lease', async () => {
    const local = transport('inv_mismatch', 'task_mismatch');
    const reserved = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_mismatch',
      taskId: 'task_mismatch',
      goal: 'Reserve then renew from another owner',
      prepared: true,
    });
    expect(reserved.ok).toBe(true);
    const reservationId = 'forge-start-reservation:inv_mismatch:task_mismatch';
    adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });

    const renewal = await local.invoke(FORGE_RENEW_RESERVATION_LEASE_METHOD, {
      reservationId,
      ownerId: 'owner-b',
    });

    expect(renewal.ok).toBe(true);
    if (!renewal.ok) { throw new Error(renewal.error.message); }
    expect(renewal.reservationLeaseRenewal).toMatchObject({
      renewed: false,
      reasons: [{
        code: 'owner_mismatch',
        message: 'Reservation lease is owned by another caller.',
      }],
    });

    const reacquireByOwner = adapter.acquireReservation({ reservationId, ownerId: 'owner-a' });
    expect(reacquireByOwner).toMatchObject({ acquired: true, alreadyOwned: true });
  });

  it('rejects renewal for a reservationId that was never acquired', async () => {
    const response = await transport().invoke(FORGE_RENEW_RESERVATION_LEASE_METHOD, {
      reservationId: 'forge-lease:missing',
      ownerId: 'owner-a',
      audit: { callerId: 'forge' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationLeaseRenewal).toEqual({
      renewed: false,
      reservationId: 'forge-lease:missing',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'not_acquired',
        message: 'No active reservation lease exists to renew.',
      }],
      audit: { callerId: 'forge' },
    });
  });

  it('rejects malformed renewal requests', async () => {
    const response = await transport().invoke(FORGE_RENEW_RESERVATION_LEASE_METHOD, {
      reservationId: '',
      ownerId: 'owner-a',
    });

    expect(response.ok).toBe(false);
    if (response.ok) { throw new Error('expected invalid_request error'); }
    expect(response.error.code).toBe('invalid_request');
  });
});
