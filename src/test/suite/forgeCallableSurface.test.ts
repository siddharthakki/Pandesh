import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  FORGE_CAN_START_INVOCATION_METHOD,
  FORGE_RESERVE_START_INVOCATION_METHOD,
  FORGE_START_INVOCATION_METHOD,
  FORGE_PAUSE_INVOCATION_METHOD,
  FORGE_RESUME_INVOCATION_METHOD,
  FORGE_CANCEL_INVOCATION_METHOD,
  FORGE_GET_INVOCATION_EVENTS_METHOD,
  FORGE_GET_INVOCATION_PROGRESS_METHOD,
  FORGE_PREPARE_INVOCATION_METHOD,
  FORGE_INVOCATION_STATUS_DESCRIPTOR,
  FORGE_INVOCATION_EVENTS_DESCRIPTOR,
  FORGE_INVOCATION_PROGRESS_DESCRIPTOR,
  FORGE_INVOCATION_PREPARATION_DESCRIPTOR,
  FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR,
  FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR,
  FORGE_INVOCATION_START_DESCRIPTOR,
  FORGE_INVOCATION_PAUSE_DESCRIPTOR,
  FORGE_INVOCATION_RESUME_DESCRIPTOR,
  FORGE_INVOCATION_CANCEL_DESCRIPTOR,
  FORGE_GET_INVOCATION_STATUS_METHOD,
  FORGE_STATUS_CONTRACT_VERSION,
  LocalForgeCallableTransport,
  ReadOnlyForgeCallableRegistry,
  ReadOnlyForgeCallableSurface,
  registerGovernedForgeInvocationStartEligibilityCallable,
  registerGovernedForgeInvocationStartReservationCallable,
  registerGovernedForgeInvocationStartReservationLookupCallable,
  registerGovernedForgeInvocationPreparationCallable,
  registerGovernedForgeInvocationStartCallable,
  registerForgeLifecycleControlCallables,
  registerReadOnlyForgeObservabilityCallables,
  registerReadOnlyForgeStatusCallable,
  FORGE_GET_START_RESERVATION_METHOD,
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
  userGoal: 'Expose read-only Forge status callable',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('ReadOnlyForgeCallableSurface', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-callable-'));
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
      engineUsage: {
        ...createInitialUsage('2026-01-01T00:00:00.000Z'),
        elapsedActiveMs: 1200,
        modelCalls: 2,
        toolCalls: 3,
        iterations: 4,
        outputBytes: 512,
      },
      currentIteration: 4,
      validationPassed: false,
    });
    await engine.taskStore.appendEvent(taskId, 'task_created', { goal: BASE_TASK.userGoal });
    await engine.taskStore.appendEvent(taskId, 'phase_transition', {
      to: 'executing',
      reason: 'user_request',
    });
  }

  function surface(taskId = 'task_callable', now: () => string = () => '2026-01-01T00:00:00.000Z'): ReadOnlyForgeCallableSurface {
    return new ReadOnlyForgeCallableSurface(new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_callable',
      taskId,
      audit: { callerId: 'hermes' },
    }], now));
  }

  function transport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerReadOnlyForgeObservabilityCallables(registry, surface(taskId));
    return new LocalForgeCallableTransport(registry);
  }

  function preparationTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationPreparationCallable(registry, surface(taskId));
    return new LocalForgeCallableTransport(registry);
  }

  function startEligibilityTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartEligibilityCallable(registry, surface(taskId));
    return new LocalForgeCallableTransport(registry);
  }

  function startReservationTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartReservationCallable(registry, surface(taskId));
    return new LocalForgeCallableTransport(registry);
  }

  function reservationLookupTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    const callableSurface = surface(taskId);
    registerGovernedForgeInvocationStartReservationCallable(registry, callableSurface);
    registerGovernedForgeInvocationStartReservationLookupCallable(registry, callableSurface);
    return new LocalForgeCallableTransport(registry);
  }

  function startTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    const callableSurface = surface(taskId);
    registerGovernedForgeInvocationStartReservationCallable(registry, callableSurface);
    registerGovernedForgeInvocationStartCallable(registry, callableSurface);
    return new LocalForgeCallableTransport(registry);
  }

  function lifecycleTransport(taskId = 'task_callable'): LocalForgeCallableTransport {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerForgeLifecycleControlCallables(registry, surface(taskId));
    return new LocalForgeCallableTransport(registry);
  }

  it('registers the read-only Forge status callable once', () => {
    const registry = new ReadOnlyForgeCallableRegistry();

    registerReadOnlyForgeStatusCallable(registry, surface());

    expect(registry.discover()).toEqual([FORGE_INVOCATION_STATUS_DESCRIPTOR]);
    expect(() => registerReadOnlyForgeStatusCallable(registry, surface())).toThrow(
      /Forge callable already registered: forge\.invocation\.getStatus/,
    );
  });

  it('discovers the local read-only callable with contract version metadata', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerReadOnlyForgeObservabilityCallables(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    expect(local.discover()).toEqual([
      {
        id: 'forge.invocation.getEvents',
        version: 1,
        transport: 'local',
        readOnly: true,
      },
      {
        id: 'forge.invocation.getProgress',
        version: 1,
        transport: 'local',
        readOnly: true,
      },
      {
        id: 'forge.invocation.getStatus',
        version: 1,
        transport: 'local',
        readOnly: true,
      },
    ]);
  });

  it('discovers governed invocation preparation as local read-only non-executing metadata', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationPreparationCallable(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    expect(local.discover()).toEqual([{
      id: FORGE_PREPARE_INVOCATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    }]);
  });

  it('discovers governed start eligibility as local read-only dry-run metadata', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartEligibilityCallable(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    expect(local.discover()).toEqual([{
      id: FORGE_CAN_START_INVOCATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    }]);
  });

  it('discovers governed start reservation as local read-only metadata-only intent', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartReservationCallable(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    expect(local.discover()).toEqual([{
      id: FORGE_RESERVE_START_INVOCATION_METHOD,

version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    }]);
  });

  it('returns status for a known invocation through the callable surface', async () => {
    await createTask('task_callable');

    const response = await transport().invoke(FORGE_GET_INVOCATION_STATUS_METHOD, {
      invocationId: 'inv_callable',
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.status).toMatchObject({
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      phase: 'running',
      audit: { callerId: 'hermes' },
    });
  });

  it('returns persisted task events for a known invocation', async () => {
    await createTask('task_callable');

    const response = await transport().invoke(FORGE_GET_INVOCATION_EVENTS_METHOD, {
      invocationId: 'inv_callable',
    });

    expect(Object.keys(response).sort()).toEqual(['events', 'method', 'ok']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.method).toBe(FORGE_GET_INVOCATION_EVENTS_METHOD);
    expect(response.events).toMatchObject({
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      warnings: [],
      integrityFailed: false,
    });
    expect(response.events.events.map(event => event.type)).toEqual([
      'task_created',
      'phase_transition',
    ]);
  });

  it('returns progress from existing task usage and budget data', async () => {
    await createTask('task_callable');

    const response = await transport().invoke(FORGE_GET_INVOCATION_PROGRESS_METHOD, {
      invocationId: 'inv_callable',
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'progress']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.method).toBe(FORGE_GET_INVOCATION_PROGRESS_METHOD);
    expect(response.progress).toMatchObject({
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      phase: 'executing',
      currentIteration: 4,
      validationPassed: false,
      pendingApproval: false,
      usage: {
        elapsedActiveMs: 1200,
        modelCalls: 2,
        toolCalls: 3,
        iterations: 4,
        outputBytes: 512,
      },
      budgets: {
        maxModelCalls: 30,
        maxToolCalls: 100,
        maxIterations: 20,
      },
    });
  });

  it('prepares a valid governed invocation request without executing it', async () => {
    const response = await preparationTransport().invoke(FORGE_PREPARE_INVOCATION_METHOD, {
      invocationId: 'inv_prepare',
      taskId: 'task_prepare',
      goal: 'Validate the request before lifecycle execution',
      audit: { callerId: 'forge', correlationId: 'corr_prepare' },
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'preparation']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.method).toBe(FORGE_PREPARE_INVOCATION_METHOD);
    expect(response.preparation).toEqual({
      invocationId: 'inv_prepare',
      taskId: 'task_prepare',
      ready: true,
      phase: 'prepared',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      nonExecuting: true,
      sideEffects: 'none',
      validation: {
        accepted: true,
        errors: [],
      },
      audit: { callerId: 'forge', correlationId: 'corr_prepare' },
    });
  });

  it('exposes deterministic evidence metadata for valid preparation responses', async () => {
    const response = await preparationTransport().invoke(FORGE_PREPARE_INVOCATION_METHOD, {
      invocationId: 'inv_evidence_prepare',
      taskId: 'task_prepare',
      goal: 'Evidence metadata for preparation',
      audit: { callerId: 'forge', correlationId: 'corr_evidence_prepare' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.preparation.validation).toEqual({
      accepted: true,
      errors: [],
    });
    expect(response.preparation.sideEffects).toBe('none');
    expect(response.preparation.nonExecuting).toBe(true);
    expect(response.preparation.audit).toEqual({ callerId: 'forge', correlationId: 'corr_evidence_prepare' });
  });

  it('rejects invalid preparation request shape with the standard envelope', async () => {
    const response = await preparationTransport().invoke(FORGE_PREPARE_INVOCATION_METHOD, {
      invocationId: '',
      taskId: 'task_prepare',
    });

    expect(Object.keys(response).sort()).toEqual(['error', 'method', 'ok']);
    expect(response).toEqual({
      ok: false,
      method: FORGE_PREPARE_INVOCATION_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_PREPARE_INVOCATION_METHOD}`,
        details: [
          'params.invocationId must be a non-empty string',
          'params.taskId must be a non-empty string',
          'params.goal must be a non-empty string',
        ],
      },
    });
  });

  it('rejects malformed preparation request envelope without throwing', async () => {
    await expect(preparationTransport().invoke(FORGE_PREPARE_INVOCATION_METHOD, undefined)).resolves.toEqual({
      ok: false,
      method: FORGE_PREPARE_INVOCATION_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_PREPARE_INVOCATION_METHOD}`,
        details: [
          'params.invocationId must be a non-empty string',
          'params.taskId must be a non-empty string',
          'params.goal must be a non-empty string',
        ],
      },
    });
  });

  it('returns eligible dry-run start readiness for a prepared invocation', async () => {
    const response = await startEligibilityTransport().invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_can_start',
      taskId: 'task_can_start',
      goal: 'Check start eligibility only',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_can_start' },
    });

    expect(Object.keys(response).sort()).toEqual(['eligibility', 'method', 'ok']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.method).toBe(FORGE_CAN_START_INVOCATION_METHOD);
    expect(response.eligibility).toEqual({
      invocationId: 'inv_can_start',
      taskId: 'task_can_start',
      eligible: true,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      reasons: [{
        code: 'eligible',
        message: 'Invocation has the required dry-run prerequisites to start.',
      }],
      missingPrerequisites: [],
      audit: { callerId: 'forge', correlationId: 'corr_can_start' },
    });
  });

  it('returns ineligible dry-run start readiness when preparation is missing', async () => {
    const response = await startEligibilityTransport().invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_can_start',
      taskId: 'task_can_start',
      goal: 'Check start eligibility only',
      prepared: false,
    });

    expect(Object.keys(response).sort()).toEqual(['eligibility', 'method', 'ok']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.eligibility).toMatchObject({
      eligible: false,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      reasons: [{
        code: 'missing_preparation',
        message: 'Invocation must be prepared before start eligibility can pass.',
      }],
      missingPrerequisites: ['prepared invocation'],
    });
  });

  it('rejects invalid start eligibility request shape with the standard envelope', async () => {
    const response = await startEligibilityTransport().invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_can_start',
      taskId: '',
      goal: 'Check start eligibility only',
    });

    expect(Object.keys(response).sort()).toEqual(['error', 'method', 'ok']);
    expect(response).toEqual({
      ok: false,
      method: FORGE_CAN_START_INVOCATION_METHOD,
      error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_CAN_START_INVOCATION_METHOD}`,
        details: [
          'params.invocationId must be a non-empty string',
          'params.taskId must be a non-empty string',
          'params.goal must be a non-empty string',
          'params.prepared must be a boolean',
        ],
      },
    });
  });

  it('returns a start intent reservation receipt for an eligible prepared invocation', async () => {
    const response = await startReservationTransport().invoke(FORGE_RESERVE_START_INVOCATION_METHOD,

{
      invocationId: 'inv_reserve',
      taskId: 'task_reserve',
      goal: 'Reserve start intent only',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_reserve' },
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'reservation']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.method).toBe(FORGE_RESERVE_START_INVOCATION_METHOD);
    expect(response.reservation).toEqual({
      accepted: true,
      reservationId: 'forge-start-reservation:inv_reserve:task_reserve',
      invocationId: 'inv_reserve',
      taskId: 'task_reserve',
      eligibilityBasis: {
        invocationId: 'inv_reserve',
        taskId: 'task_reserve',
        eligible: true,
        contractVersion: FORGE_STATUS_CONTRACT_VERSION,
        sideEffects: 'none',
        nonExecuting: true,
        reasons: [{
          code: 'eligible',
          message: 'Invocation has the required dry-run prerequisites to start.',
        }],
        missingPrerequisites: [],
        audit: { callerId: 'forge', correlationId: 'corr_reserve' },
      },
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T00:05:00.000Z',
      reasons: [{
        code: 'reserved',
        message: 'Start intent reservation recorded in memory.',
      }],
      audit: { callerId: 'forge', correlationId: 'corr_reserve' },
    });
  });

  it('exposes deterministic evidence metadata for valid reservation responses', async () => {
    const response = await startReservationTransport().invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_evidence_reserve',
      taskId: 'task_reserve',
      goal: 'Evidence metadata for reservation',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_evidence_reserve' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservation.accepted).toBe(true);
    expect(response.reservation.sideEffects).toBe('metadata-only');
    expect(response.reservation.nonExecuting).toBe(true);
    expect(response.reservation.eligibilityBasis.reasons).toEqual([{
      code: 'eligible',
      message: 'Invocation has the required dry-run prerequisites to start.',
    }]);
    expect(response.reservation.reasons).toEqual([{
      code: 'reserved',
      message: 'Start intent reservation recorded in memory.',
    }]);
    expect(response.reservation.audit).toEqual({ callerId: 'forge', correlationId: 'corr_evidence_reserve' });
  });

  it('returns approval metadata for eligible start readiness requests', async () => {
    const response = await startEligibilityTransport().invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_approval_metadata',
      taskId: 'task_approval_metadata',
      goal: 'Approve start readiness metadata',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_approval_metadata' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.eligibility).toEqual({
      invocationId: 'inv_approval_metadata',
      taskId: 'task_approval_metadata',
      eligible: true,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      reasons: [{
        code: 'eligible',
        message: 'Invocation has the required dry-run prerequisites to start.',
      }],
      missingPrerequisites: [],
      audit: { callerId: 'forge', correlationId: 'corr_approval_metadata' },
    });
  });

  it('does not mutate lifecycle, run tools or call models when eligibility rejects reservation', async () => {
    await createTask('task_callable');
    const local = startReservationTransport();
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const approvalSpy = vi.spyOn(engine, 'respondToApproval');
    const rollbackSpy = vi.spyOn(engine, 'rollbackTask');

    const response = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_reject_guard',
      taskId: 'task_callable',
      goal: 'Reserve denied by eligibility guard',
      prepared: false,
      audit: { callerId: 'forge', correlationId: 'corr_reject_guard' },
    });

    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservation.accepted).toBe(false);
    expect(response.reservation.eligibilityBasis).toEqual({
      invocationId: 'inv_reject_guard',
      taskId: 'task_callable',
      eligible: false,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      reasons: [{
        code: 'missing_preparation',
        message: 'Invocation must be prepared before start eligibility can pass.',
      }],
      missingPrerequisites: ['prepared invocation'],
      audit: { callerId: 'forge', correlationId: 'corr_reject_guard' },
    });
    expect(response.reservation.reasons).toEqual([{
      code: 'missing_preparation',
      message: 'Invocation must be prepared before start eligibility can pass.',
    }]);
    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('returns deterministic metadata-only reservation for repeated equivalent dry-run requests without mutating lifecycle', async () => {
    await createTask('task_callable');
    const local = startReservationTransport('task_callable');
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const request = {
      invocationId: 'inv_reserve',
      taskId: 'task_callable',
      goal: 'Reserve start intent only',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_reserve' },
    };

    const firstResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, request);
    const secondResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, request);

    expect(firstResponse).toEqual(secondResponse);
    expect(firstResponse.ok).toBe(true);
    if (!firstResponse.ok) { throw new Error(firstResponse.error.message); }
    expect(firstResponse.reservation.sideEffects).toBe('metadata-only');
    expect(firstResponse.reservation.reservationId).toBe('forge-start-reservation:inv_reserve:task_callable');
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('executes a realistic Forge dry-run flow through preparation, eligibility, and reservation without mutating lifecycle', async () => {
    await createTask('task_callable');
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const approvalSpy = vi.spyOn(engine, 'respondToApproval');
    const rollbackSpy = vi.spyOn(engine, 'rollbackTask');

    const prepareResponse = await preparationTransport('task_callable').invoke(FORGE_PREPARE_INVOCATION_METHOD, {
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      goal: 'Dry-run start path',
      audit: { callerId: 'forge', correlationId: 'corr_dry_run_prepare' },
    });

    expect(prepareResponse.ok).toBe(true);
    if (!prepareResponse.ok) { throw new Error(prepareResponse.error.message); }
    expect(prepareResponse.preparation.ready).toBe(true);
    expect(prepareResponse.preparation.phase).toBe('prepared');

    const eligibilityResponse = await startEligibilityTransport('task_callable').invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      goal: 'Dry-run start path',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_dry_run_eligibility' },
    });

    expect(eligibilityResponse.ok).toBe(true);
    if (!eligibilityResponse.ok) { throw new Error(eligibilityResponse.error.message); }
    expect(eligibilityResponse.eligibility.eligible).toBe(true);
    expect(eligibilityResponse.eligibility.missingPrerequisites).toEqual([]);

    const reservationResponse = await startReservationTransport('task_callable').invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
      invocationId: 'inv_callable',
      taskId: 'task_callable',
      goal: 'Dry-run start path',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_dry_run_reservation' },
    });

    expect(reservationResponse.ok).toBe(true);
    if (!reservationResponse.ok) { throw new Error(reservationResponse.error.message); }
    expect(reservationResponse.reservation.accepted).toBe(true);
    expect(reservationResponse.reservation.sideEffects).toBe('metadata-only');
    expect(reservationResponse.reservation.nonExecuting).toBe(true);

    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('rejects start intent reservation when start eligibility would be false', async () => {
    const response = await startReservationTransport().invoke(FORGE_RESERVE_START_INVOCATION_METHOD,

{
      invocationId: 'inv_reserve',
      taskId: 'task_reserve',
      goal: 'Reserve start intent only',
      prepared: false,
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'reservation']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservation).toMatchObject({
      accepted: false,
      reservationId: undefined,
      invocationId: 'inv_reserve',
      taskId: 'task_reserve',
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'metadata-only',
      nonExecuting: true,
      reasons: [{
        code: 'missing_preparation',
        message: 'Invocation must be prepared before start eligibility can pass.',
      }],
      eligibilityBasis: {
        eligible: false,
        missingPrerequisites: ['prepared invocation'],
      },
    });
  });

  it('rejects invalid start reservation request shape with the standard envelope', async () => {
    const response = await startReservationTransport().invoke(FORGE_RESERVE_START_INVOCATION_METHOD,

{
      invocationId: 'inv_reserve',
      taskId: 'task_reserve',
      goal: '',
    });

    expect(Object.keys(response).sort()).toEqual(['error', 'method', 'ok']);
    expect(response).toEqual({
      ok: false,
      method: FORGE_RESERVE_START_INVOCATION_METHOD,

error: {
        code: 'invalid_request',
        message: `Invalid Forge callable request for ${FORGE_RESERVE_START_INVOCATION_METHOD}`,
        details: [
          'params.invocationId must be a non-empty string',
          'params.taskId must be a non-empty string',
          'params.goal must be a non-empty string',
          'params.prepared must be a boolean',
        ],
      },
    });
  });


  it('discovers governed reservation lookup as local read-only non-executing metadata', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartReservationLookupCallable(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    expect(local.discover()).toEqual([{
      id: FORGE_GET_START_RESERVATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    }]);
  });

  it('returns deterministic discovery metadata for repeated discovery calls', () => {
    const registry = new ReadOnlyForgeCallableRegistry();
    registerGovernedForgeInvocationStartReservationCallable(registry, surface());
    const local = new LocalForgeCallableTransport(registry);

    const firstDiscovery = local.discover();
    const secondDiscovery = local.discover();

    expect(firstDiscovery).toEqual(secondDiscovery);
    expect(firstDiscovery).toEqual([{
      id: FORGE_RESERVE_START_INVOCATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    }]);
  });

  it('returns reservation lookup for an active start reservation', async () => {
    const local = reservationLookupTransport();

    const reservationResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD,

{
      invocationId: 'inv_reserve_lookup',
      taskId: 'task_reserve_lookup',
      goal: 'Reserve then inspect',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_lookup' },
    });

    expect(reservationResponse.ok).toBe(true);
    if (!reservationResponse.ok) { throw new Error(reservationResponse.error.message); }

    const lookupResponse = await local.invoke(FORGE_GET_START_RESERVATION_METHOD, {
      reservationId: 'forge-start-reservation:inv_reserve_lookup:task_reserve_lookup',
    });

    expect(Object.keys(lookupResponse).sort()).toEqual(['method', 'ok', 'reservationLookup']);
    expect(lookupResponse.ok).toBe(true);
    if (!lookupResponse.ok) { throw new Error(lookupResponse.error.message); }
    expect(lookupResponse.reservationLookup).toMatchObject({
      found: true,
      reservationId: 'forge-start-reservation:inv_reserve_lookup:task_reserve_lookup',
      active: true,
      expired: false,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'reservation_active',
        message: 'Start reservation exists and is active.',
      }],
      audit: { callerId: 'forge', correlationId: 'corr_lookup' },
    });
    expect(lookupResponse.reservationLookup.reservation).toMatchObject({
      accepted: true,
      reservationId: 'forge-start-reservation:inv_reserve_lookup:task_reserve_lookup',
      invocationId: 'inv_reserve_lookup',
      taskId: 'task_reserve_lookup',
    });
  });

  it('returns reservation lookup miss for an unknown reservation id', async () => {
    const response = await reservationLookupTransport().invoke(FORGE_GET_START_RESERVATION_METHOD, {
      reservationId: 'forge-start-reservation:missing',
      audit: { callerId: 'forge' },
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'reservationLookup']);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(response.reservationLookup).toEqual({
      found: false,
      reservationId: 'forge-start-reservation:missing',
      active: false,
      expired: false,
      contractVersion: FORGE_STATUS_CONTRACT_VERSION,
      sideEffects: 'none',
      nonExecuting: true,
      checkedAt: '2026-01-01T00:00:00.000Z',
      reasons: [{
        code: 'unknown_reservation',
        message: 'No start reservation exists for the requested reservationId.',
      }],
      audit: { callerId: 'forge' },
    });
  });
  it('returns a stable not_found response for an unknown invocation', async () => {
    await createTask('task_callable');

    for (const method of [
      FORGE_GET_INVOCATION_STATUS_METHOD,
      FORGE_GET_INVOCATION_EVENTS_METHOD,
      FORGE_GET_INVOCATION_PROGRESS_METHOD,
    ]) {
      await expect(transport().invoke(method, { invocationId: 'inv_missing' })).resolves.toEqual({
        ok: false,
        method,
        error: {
          code: 'not_found',
          message: 'Forge invocation not found: inv_missing',
        },
      });
    }
  });

  it('returns a stable not_found response for orphaned task references', async () => {
    const local = transport('task_missing');

    for (const method of [
      FORGE_GET_INVOCATION_STATUS_METHOD,
      FORGE_GET_INVOCATION_EVENTS_METHOD,
      FORGE_GET_INVOCATION_PROGRESS_METHOD,
    ]) {
      const response = await local.invoke(method, { invocationId: 'inv_callable' });
      expect(response).toMatchObject({
        ok: false,
        method,
        error: {
          code: 'not_found',
          message: 'Task not found: task_missing',
        },
      });
    }
  });

  it('keeps the response shape explicit for successful status lookups', async () => {
    await createTask('task_callable');

    const response = await transport().invoke(FORGE_GET_INVOCATION_STATUS_METHOD, {
      invocationId: 'inv_callable',
      audit: { correlationId: 'corr_123' },
    });

    expect(Object.keys(response).sort()).toEqual(['method', 'ok', 'status']);
    expect(response.method).toBe(FORGE_GET_INVOCATION_STATUS_METHOD);
    expect(response.ok).toBe(true);
    if (!response.ok) { throw new Error(response.error.message); }
    expect(Object.keys(response.status).sort()).toEqual([
      'audit',
      'cancellationReason',
      'createdAt',
      'errorSummary',
      'invocationId',
      'phase',
      'taskId',
      'updatedAt',
    ]);
    expect(response.status.audit).toEqual({ correlationId: 'corr_123' });
  });

  it('preserves the error envelope for unknown callables', async () => {
    await createTask('task_callable');

    const response = await transport().invoke('forge.invocation.describe', {
      invocationId: 'inv_callable',
    });

    expect(Object.keys(response).sort()).toEqual(['error', 'method', 'ok']);
    expect(response).toEqual({
      ok: false,
      method: 'forge.invocation.describe',
      error: {
        code: 'unknown_method',
        message: 'Unsupported Forge callable method: forge.invocation.describe',
      },
    });
  });

  it('exposes contract version only through discovery metadata', () => {
    expect(FORGE_STATUS_CONTRACT_VERSION).toBe(1);
    expect(FORGE_INVOCATION_STATUS_DESCRIPTOR).toEqual({
      id: FORGE_GET_INVOCATION_STATUS_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
    });
    expect(FORGE_INVOCATION_EVENTS_DESCRIPTOR).toEqual({
      id: FORGE_GET_INVOCATION_EVENTS_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
    });
    expect(FORGE_INVOCATION_PROGRESS_DESCRIPTOR).toEqual({
      id: FORGE_GET_INVOCATION_PROGRESS_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
    });
    expect(FORGE_INVOCATION_PREPARATION_DESCRIPTOR).toEqual({
      id: FORGE_PREPARE_INVOCATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
    expect(FORGE_INVOCATION_START_ELIGIBILITY_DESCRIPTOR).toEqual({
      id: FORGE_CAN_START_INVOCATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
    expect(FORGE_INVOCATION_START_RESERVATION_DESCRIPTOR).toEqual({
      id: FORGE_RESERVE_START_INVOCATION_METHOD,

version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
    expect(FORGE_INVOCATION_START_RESERVATION_LOOKUP_DESCRIPTOR).toEqual({
      id: FORGE_GET_START_RESERVATION_METHOD,
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: true,
      sideEffects: 'none',
      nonExecuting: true,
    });
  });

  it('does not mutate lifecycle, run tools or call models during preparation', async () => {
    await createTask('task_callable');
    const local = preparationTransport();
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const approvalSpy = vi.spyOn(engine, 'respondToApproval');
    const rollbackSpy = vi.spyOn(engine, 'rollbackTask');

    const response = await local.invoke(FORGE_PREPARE_INVOCATION_METHOD, {
      invocationId: 'inv_prepare',
      taskId: 'task_callable',
      goal: 'Validate only',
    });

    expect(response.ok).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('does not mutate lifecycle, run tools or call models during start eligibility', async () => {
    await createTask('task_callable');
    const local = startEligibilityTransport();
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const approvalSpy = vi.spyOn(engine, 'respondToApproval');
    const rollbackSpy = vi.spyOn(engine, 'rollbackTask');

    const response = await local.invoke(FORGE_CAN_START_INVOCATION_METHOD, {
      invocationId: 'inv_can_start',
      taskId: 'task_callable',
      goal: 'Dry run only',
      prepared: true,
    });

    expect(response.ok).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('does not execute lifecycle, tools or models during start reservation', async () => {
    await createTask('task_callable');
    const local = startReservationTransport();
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const startSpy = vi.spyOn(engine, 'startTask');
    const pauseSpy = vi.spyOn(engine, 'pauseTask');
    const resumeSpy = vi.spyOn(engine, 'resumeTask');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const approvalSpy = vi.spyOn(engine, 'respondToApproval');
    const rollbackSpy = vi.spyOn(engine, 'rollbackTask');

    const response = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD,

{
      invocationId: 'inv_reserve',
      taskId: 'task_callable',
      goal: 'Reserve only',
      prepared: true,
    });

    expect(response.ok).toBe(true);
    expect(startSpy).not.toHaveBeenCalled();
    expect(pauseSpy).not.toHaveBeenCalled();
    expect(resumeSpy).not.toHaveBeenCalled();
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(approvalSpy).not.toHaveBeenCalled();
    expect(rollbackSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('does not expose or dispatch lifecycle mutation methods', async () => {
    await createTask('task_callable');
    const local = transport();
    const beforeTask = await engine.taskStore.getTask('task_callable');
    const beforeEvents = await engine.taskStore.getEvents('task_callable');
    const cancelSpy = vi.spyOn(engine, 'cancelTask');
    const startSpy = vi.spyOn(engine, 'startTask');

    const response = await local.invoke('forge.invocation.cancel', {
      invocationId: 'inv_callable',
    });

    expect(response).toMatchObject({
      ok: false,
      method: 'forge.invocation.cancel',
      error: { code: 'unknown_method' },
    });
    expect(cancelSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);

    await local.invoke(FORGE_GET_INVOCATION_EVENTS_METHOD, { invocationId: 'inv_callable' });
    await local.invoke(FORGE_GET_INVOCATION_PROGRESS_METHOD, { invocationId: 'inv_callable' });

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(startSpy).not.toHaveBeenCalled();
    expect(await engine.taskStore.getTask('task_callable')).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents('task_callable')).toEqual(beforeEvents);
  });

  it('discovers governed invocation start as local lifecycle-mutating metadata', () => {
    expect(FORGE_INVOCATION_START_DESCRIPTOR).toEqual({
      id: 'forge.invocation.start',
      version: FORGE_STATUS_CONTRACT_VERSION,
      transport: 'local',
      readOnly: false,
      sideEffects: 'task-lifecycle',
    });
  });

  it('calls engine.startTask exactly once and exposes execution boundary and status for a valid reserved start', async () => {
    await createTask('task_start_boundary');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_start_boundary',
      taskId: 'task_start_boundary',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_start_boundary'));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_start_boundary',
      taskId: 'task_start_boundary',
      goal: 'Test execution boundary exposure',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_start_boundary' },
    });

    expect(reservation.reservationId).toBeDefined();

    const startResult = await adapter.start({
      invocationId: 'inv_start_boundary',
      taskId: 'task_start_boundary',
      goal: 'Test execution boundary exposure',
      reservationId: reservation.reservationId!,
      mode: 'agent',
      audit: { callerId: 'forge', correlationId: 'corr_start_boundary' },
    });

    expect(startSpy).toHaveBeenCalledTimes(1);
    expect(startSpy).toHaveBeenCalledWith({
      taskId: 'task_start_boundary',
      goal: 'Test execution boundary exposure',
      mode: 'agent',
      model: undefined,
    });
    expect(startResult.started).toBe(true);
    expect(startResult.reservationId).toBe(reservation.reservationId);
    expect(startResult.executionBoundary).toBeDefined();
    expect(startResult.executionBoundary?.taskId).toBe('task_start_boundary');
    expect(startResult.nonExecuting).toBe(false);
    expect(startResult.sideEffects).toBe('task-lifecycle');
    expect(startResult.status).toMatchObject({
      invocationId: 'inv_start_boundary',
      taskId: 'task_start_boundary',
    });
  });

  it('does not call engine.startTask for a missing or unknown reservation', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_missing_res',
      taskId: 'task_missing_res',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask');

    const rejectedResponse = await adapter.start({
      invocationId: 'inv_missing_res',
      taskId: 'task_missing_res',
      goal: 'Should reject - no reservation',
      reservationId: 'unknown-reservation',
      mode: 'agent',
    });

    expect(rejectedResponse.started).toBe(false);
    expect(rejectedResponse.reservationId).toBe('unknown-reservation');
    expect(rejectedResponse.nonExecuting).toBe(true);
    expect(rejectedResponse.sideEffects).toBe('metadata-only');
    expect(rejectedResponse.reasons).toContainEqual({
      code: 'unknown_reservation',
      message: 'Start requires a reservation returned by forge.invocation.reserveStart.',
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not call engine.startTask for an ineligible (unprepared) start request', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_ineligible',
      taskId: 'task_ineligible',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask');

    const reservation = adapter.reserveStart({
      invocationId: 'inv_ineligible',
      taskId: 'task_ineligible',
      goal: 'Should stay ineligible',
      prepared: false,
    });

    expect(reservation.accepted).toBe(false);
    expect(reservation.reservationId).toBeUndefined();

    const startResult = await adapter.start({
      invocationId: 'inv_ineligible',
      taskId: 'task_ineligible',
      goal: 'Should stay ineligible',
      reservationId: 'forge-start-reservation:inv_ineligible:task_ineligible',
      mode: 'agent',
    });

    expect(startResult.started).toBe(false);
    expect(startResult.reservationId).toBe('forge-start-reservation:inv_ineligible:task_ineligible');
    expect(startResult.nonExecuting).toBe(true);
    expect(startResult.sideEffects).toBe('metadata-only');
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('calls engine.startTask exactly once through the full prepare, eligibility, reservation and start flow', async () => {
    await createTask('task_boundary_point');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_boundary_point',
      taskId: 'task_boundary_point',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_boundary_point'));

    const eligibility = adapter.canStart({
      invocationId: 'inv_boundary_point',
      taskId: 'task_boundary_point',
      goal: 'Boundary point test',
      prepared: true,
    });

    expect(eligibility.eligible).toBe(true);

    const reservation = adapter.reserveStart({
      invocationId: 'inv_boundary_point',
      taskId: 'task_boundary_point',
      goal: 'Boundary point test',
      prepared: true,
    });

    expect(reservation.accepted).toBe(true);

    const startResult = await adapter.start({
      invocationId: 'inv_boundary_point',
      taskId: 'task_boundary_point',
      goal: 'Boundary point test',
      reservationId: reservation.reservationId!,
      mode: 'agent',
    });

    expect(startResult.started).toBe(true);
    expect(startResult.executionBoundary).toBeDefined();
    expect(startResult.executionBoundary?.taskId).toBe('task_boundary_point');
    expect(startResult.nonExecuting).toBe(false);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes full governed start evidence (invocationId, taskId, reservationId, decision, sideEffects, nonExecuting, audit, status) without invoking model or tool execution', async () => {
    await createTask('task_evidence');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_evidence',
      taskId: 'task_evidence',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_evidence'));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_evidence',
      taskId: 'task_evidence',
      goal: 'Evidence coverage for governed start',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_evidence_start' },
    });

    const startResult = await adapter.start({
      invocationId: 'inv_evidence',
      taskId: 'task_evidence',
      goal: 'Evidence coverage for governed start',
      reservationId: reservation.reservationId!,
      mode: 'agent',
      audit: { callerId: 'forge', correlationId: 'corr_evidence_start' },
    });

    expect(startResult).toMatchObject({
      invocationId: 'inv_evidence',
      taskId: 'task_evidence',
      reservationId: reservation.reservationId,
      started: true,
      sideEffects: 'task-lifecycle',
      nonExecuting: false,
      audit: { callerId: 'forge', correlationId: 'corr_evidence_start' },
    });
    expect(startResult.status).toMatchObject({
      invocationId: 'inv_evidence',
      taskId: 'task_evidence',
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes execution evidence with lifecycleAction startTask for a successful governed start', async () => {
    await createTask('task_evidence_success');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_evidence_success',
      taskId: 'task_evidence_success',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_evidence_success'));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_evidence_success',
      taskId: 'task_evidence_success',
      goal: 'Evidence success coverage',
      prepared: true,
      audit: { callerId: 'forge', correlationId: 'corr_evidence_success' },
    });

    const startResult = await adapter.start({
      invocationId: 'inv_evidence_success',
      taskId: 'task_evidence_success',
      goal: 'Evidence success coverage',
      reservationId: reservation.reservationId!,
      mode: 'agent',
      audit: { callerId: 'forge', correlationId: 'corr_evidence_success' },
    });

    expect(startResult.evidence).toMatchObject({
      invocationId: 'inv_evidence_success',
      taskId: 'task_evidence_success',
      reservationId: reservation.reservationId,
      decision: 'started',
      lifecycleAction: 'startTask',
      sideEffects: 'task-lifecycle',
      nonExecuting: false,
      audit: { callerId: 'forge', correlationId: 'corr_evidence_success' },
    });
    expect(startResult.evidence.status).toMatchObject({
      invocationId: 'inv_evidence_success',
      taskId: 'task_evidence_success',
    });
    expect(startResult.evidence.reasons).toEqual([{
      code: 'started',
      message: 'Start request accepted and task lifecycle execution began at the execution boundary.',
    }]);
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('exposes rejection evidence with lifecycleAction none for a missing/unknown reservation', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_evidence_missing_res',
      taskId: 'task_evidence_missing_res',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask');

    const startResult = await adapter.start({
      invocationId: 'inv_evidence_missing_res',
      taskId: 'task_evidence_missing_res',
      goal: 'Should reject - no reservation',
      reservationId: 'unknown-reservation',
      mode: 'agent',
    });

    expect(startResult.evidence).toMatchObject({
      invocationId: 'inv_evidence_missing_res',
      taskId: 'task_evidence_missing_res',
      reservationId: 'unknown-reservation',
      decision: 'rejected',
      lifecycleAction: 'none',
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
    expect(startResult.evidence.status).toBeUndefined();
    expect(startResult.evidence.reasons).toContainEqual({
      code: 'unknown_reservation',
      message: 'Start requires a reservation returned by forge.invocation.reserveStart.',
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('exposes rejection evidence with lifecycleAction none for an ineligible (unprepared) start request', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_evidence_ineligible',
      taskId: 'task_evidence_ineligible',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask');

    const reservation = adapter.reserveStart({
      invocationId: 'inv_evidence_ineligible',
      taskId: 'task_evidence_ineligible',
      goal: 'Should stay ineligible',
      prepared: false,
    });

    const startResult = await adapter.start({
      invocationId: 'inv_evidence_ineligible',
      taskId: 'task_evidence_ineligible',
      goal: 'Should stay ineligible',
      reservationId: 'forge-start-reservation:inv_evidence_ineligible:task_evidence_ineligible',
      mode: 'agent',
    });

    expect(reservation.accepted).toBe(false);
    expect(startResult.evidence).toMatchObject({
      invocationId: 'inv_evidence_ineligible',
      taskId: 'task_evidence_ineligible',
      reservationId: 'forge-start-reservation:inv_evidence_ineligible:task_evidence_ineligible',
      decision: 'rejected',
      lifecycleAction: 'none',
      sideEffects: 'metadata-only',
      nonExecuting: true,
    });
    expect(startResult.evidence.reasons.length).toBeGreaterThan(0);
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('execution boundary and engine.startTask call accept mode and model configuration', async () => {
    await createTask('task_config');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_config',
      taskId: 'task_config',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_config'));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_config',
      taskId: 'task_config',
      goal: 'Config test',
      prepared: true,
    });

    const startResult = await adapter.start({
      invocationId: 'inv_config',
      taskId: 'task_config',
      goal: 'Config test',
      reservationId: reservation.reservationId!,
      mode: 'ask',
      model: 'custom-model',
    });

    expect(startResult.executionBoundary).toBeDefined();
    expect(startResult.executionBoundary?.mode).toBe('ask');
    expect(startResult.executionBoundary?.model).toBe('custom-model');
    expect(startResult.started).toBe(true);
    expect(startSpy).toHaveBeenCalledWith({
      taskId: 'task_config',
      goal: 'Config test',
      mode: 'ask',
      model: 'custom-model',
    });
  });

  it('does not call engine.startTask for an expired reservation', async () => {
    let now = '2026-01-01T00:00:00.000Z';
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_expired',
      taskId: 'task_expired',
    }], () => now);
    const startSpy = vi.spyOn(engine, 'startTask');

    const reservation = adapter.reserveStart({
      invocationId: 'inv_expired',
      taskId: 'task_expired',
      goal: 'Should expire before start',
      prepared: true,
    });

    expect(reservation.accepted).toBe(true);

    now = '2026-01-01T00:10:00.000Z';

    const startResult = await adapter.start({
      invocationId: 'inv_expired',
      taskId: 'task_expired',
      goal: 'Should expire before start',
      reservationId: reservation.reservationId!,
      mode: 'agent',
    });

    expect(startResult.started).toBe(false);
    expect(startResult.nonExecuting).toBe(true);
    expect(startResult.sideEffects).toBe('metadata-only');
    expect(startResult.reasons).toContainEqual({
      code: 'reservation_expired',
      message: 'Start reservation has expired.',
    });
    expect(startResult.evidence).toMatchObject({
      decision: 'rejected',
      lifecycleAction: 'none',
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('does not call engine.startTask for a reservation/task/invocation mismatch', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_mismatch',
      taskId: 'task_mismatch',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask');

    const reservation = adapter.reserveStart({
      invocationId: 'inv_mismatch',
      taskId: 'task_mismatch',
      goal: 'Reservation belongs to a different invocation/task',
      prepared: true,
    });

    expect(reservation.accepted).toBe(true);

    const startResult = await adapter.start({
      invocationId: 'inv_mismatch',
      taskId: 'task_other',
      goal: 'Reservation belongs to a different invocation/task',
      reservationId: reservation.reservationId!,
      mode: 'agent',
    });

    expect(startResult.started).toBe(false);
    expect(startResult.nonExecuting).toBe(true);
    expect(startResult.sideEffects).toBe('metadata-only');
    expect(startResult.reasons).toContainEqual({
      code: 'reservation_mismatch',
      message: 'Start reservation does not match the requested invocation and task.',
    });
    expect(startResult.evidence).toMatchObject({
      decision: 'rejected',
      lifecycleAction: 'none',
    });
    expect(startSpy).not.toHaveBeenCalled();
  });

  it('returns a controlled rejection with evidence instead of leaking an exception when engine.startTask throws', async () => {
    await createTask('task_throws');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_throws',
      taskId: 'task_throws',
    }]);
    const startSpy = vi.spyOn(engine, 'startTask').mockRejectedValue(new Error('engine unavailable'));

    const reservation = adapter.reserveStart({
      invocationId: 'inv_throws',
      taskId: 'task_throws',
      goal: 'engine.startTask throws',
      prepared: true,
    });

    expect(reservation.accepted).toBe(true);

    const startResult = await adapter.start({
      invocationId: 'inv_throws',
      taskId: 'task_throws',
      goal: 'engine.startTask throws',
      reservationId: reservation.reservationId!,
      mode: 'agent',
    });

    expect(startResult.started).toBe(false);
    expect(startResult.reasons).toContainEqual({
      code: 'engine_start_failed',
      message: 'engine.startTask failed: engine unavailable',
    });
    expect(startResult.evidence).toMatchObject({
      decision: 'rejected',
      lifecycleAction: 'startTask',
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  });

  it('callable contract is stable for future execution attachment at boundary', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_contract_stable',
      taskId: 'task_contract_stable',
    }]);

    const prep = adapter.prepare({
      invocationId: 'inv_contract_stable',
      taskId: 'task_contract_stable',
      goal: 'Contract stability',
    });

    expect(prep.nonExecuting).toBe(true);
    expect(prep.contractVersion).toBe(1);

    const eligibility = adapter.canStart({
      invocationId: 'inv_contract_stable',
      taskId: 'task_contract_stable',
      goal: 'Contract stability',
      prepared: true,
    });

    expect(eligibility.nonExecuting).toBe(true);
    expect(eligibility.contractVersion).toBe(1);

    const reservation = adapter.reserveStart({
      invocationId: 'inv_contract_stable',
      taskId: 'task_contract_stable',
      goal: 'Contract stability',
      prepared: true,
    });

    expect(reservation.nonExecuting).toBe(true);
    expect(reservation.contractVersion).toBe(1);
  });

  describe('idempotency guard for governed start', () => {
    it('does not call engine.startTask again for a repeated equivalent start request', async () => {
      await createTask('task_idempotent');
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
        invocationId: 'inv_idempotent',
        taskId: 'task_idempotent',
      }]);
      const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_idempotent'));

      const reservation = adapter.reserveStart({
        invocationId: 'inv_idempotent',
        taskId: 'task_idempotent',
        goal: 'Idempotent start guard',
        prepared: true,
      });

      const request = {
        invocationId: 'inv_idempotent',
        taskId: 'task_idempotent',
        goal: 'Idempotent start guard',
        reservationId: reservation.reservationId!,
        mode: 'agent' as const,
      };

      const firstResult = await adapter.start(request);
      const secondResult = await adapter.start(request);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(firstResult.started).toBe(true);
      expect(secondResult.started).toBe(true);
      expect(secondResult.reasons).toContainEqual({
        code: 'duplicate_start',
        message: 'Start already completed for this reservation; engine.startTask was not called again.',
      });
      expect(secondResult.evidence.reasons).toContainEqual({
        code: 'duplicate_start',
        message: 'Start already completed for this reservation; engine.startTask was not called again.',
      });
    });

    it('does not call engine.startTask more than once for concurrent starts on the same reservation', async () => {
      await createTask('task_concurrent');
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
        invocationId: 'inv_concurrent',
        taskId: 'task_concurrent',
      }]);
      let resolveStart: (() => void) | undefined;
      const startSpy = vi.spyOn(engine, 'startTask').mockImplementation(() => new Promise(resolve => {
        resolveStart = () => resolve(engine.getTask('task_concurrent'));
      }));

      const reservation = adapter.reserveStart({
        invocationId: 'inv_concurrent',
        taskId: 'task_concurrent',
        goal: 'Concurrent start guard',
        prepared: true,
      });

      const request = {
        invocationId: 'inv_concurrent',
        taskId: 'task_concurrent',
        goal: 'Concurrent start guard',
        reservationId: reservation.reservationId!,
        mode: 'agent' as const,
      };

      const firstPromise = adapter.start(request);
      const secondResult = await adapter.start(request);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(secondResult.started).toBe(false);
      expect(secondResult.reasons).toContainEqual({
        code: 'duplicate_start_in_progress',
        message: 'A start request for this reservation is already in progress; engine.startTask was not called again.',
      });

      resolveStart?.();
      const firstResult = await firstPromise;
      expect(firstResult.started).toBe(true);
    });

    it('does not mark the start as completed when validation fails before engine.startTask', async () => {
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
        invocationId: 'inv_precheck_fail',
        taskId: 'task_precheck_fail',
      }]);
      const startSpy = vi.spyOn(engine, 'startTask');

      const firstResult = await adapter.start({
        invocationId: 'inv_precheck_fail',
        taskId: 'task_precheck_fail',
        goal: 'No reservation exists yet',
        reservationId: 'unknown-reservation',
        mode: 'agent',
      });

      expect(firstResult.started).toBe(false);
      expect(startSpy).not.toHaveBeenCalled();

      await createTask('task_precheck_fail');
      const reservation = adapter.reserveStart({
        invocationId: 'inv_precheck_fail',
        taskId: 'task_precheck_fail',
        goal: 'Now eligible after a valid reservation',
        prepared: true,
      });
      startSpy.mockResolvedValue(await engine.getTask('task_precheck_fail'));

      const secondResult = await adapter.start({
        invocationId: 'inv_precheck_fail',
        taskId: 'task_precheck_fail',
        goal: 'Now eligible after a valid reservation',
        reservationId: reservation.reservationId!,
        mode: 'agent',
      });

      expect(secondResult.started).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('does not mark the start as successful and allows a retry when engine.startTask throws', async () => {
      await createTask('task_throws_retry');
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
        invocationId: 'inv_throws_retry',
        taskId: 'task_throws_retry',
      }]);
      const startSpy = vi.spyOn(engine, 'startTask').mockRejectedValueOnce(new Error('transient failure'));

      const reservation = adapter.reserveStart({
        invocationId: 'inv_throws_retry',
        taskId: 'task_throws_retry',
        goal: 'Retry after engine failure',
        prepared: true,
      });

      const request = {
        invocationId: 'inv_throws_retry',
        taskId: 'task_throws_retry',
        goal: 'Retry after engine failure',
        reservationId: reservation.reservationId!,
        mode: 'agent' as const,
      };

      const firstResult = await adapter.start(request);
      expect(firstResult.started).toBe(false);
      expect(firstResult.reasons).toContainEqual({
        code: 'engine_start_failed',
        message: 'engine.startTask failed: transient failure',
      });

      startSpy.mockResolvedValueOnce(await engine.getTask('task_throws_retry'));
      const secondResult = await adapter.start(request);

      expect(secondResult.started).toBe(true);
      expect(startSpy).toHaveBeenCalledTimes(2);
    });

    it('exposes duplicate start behavior through the governed start callable without a second engine.startTask call', async () => {
      await createTask('task_idempotent_callable');
      const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(await engine.getTask('task_idempotent_callable'));
      const local = startTransport('task_idempotent_callable');

      const reservationResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
        invocationId: 'inv_callable',
        taskId: 'task_idempotent_callable',
        goal: 'Duplicate start via callable surface',
        prepared: true,
      });
      expect(reservationResponse.ok).toBe(true);
      if (!reservationResponse.ok) { throw new Error(reservationResponse.error.message); }

      const startParams = {
        invocationId: 'inv_callable',
        taskId: 'task_idempotent_callable',
        goal: 'Duplicate start via callable surface',
        reservationId: reservationResponse.reservation.reservationId!,
        mode: 'agent' as const,
      };

      const firstResponse = await local.invoke(FORGE_START_INVOCATION_METHOD, startParams);
      const secondResponse = await local.invoke(FORGE_START_INVOCATION_METHOD, startParams);

      expect(firstResponse.ok).toBe(true);
      expect(secondResponse.ok).toBe(true);
      if (!firstResponse.ok || !secondResponse.ok) { throw new Error('expected ok responses'); }
      expect(firstResponse.start.started).toBe(true);
      expect(secondResponse.start.started).toBe(true);
      expect(secondResponse.start.reasons).toContainEqual({
        code: 'duplicate_start',
        message: 'Start already completed for this reservation; engine.startTask was not called again.',
      });
      expect(startSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('governed lifecycle control path', () => {
    it('discovers pause, resume and cancel as local lifecycle-mutating metadata', () => {
      const registry = new ReadOnlyForgeCallableRegistry();
      registerForgeLifecycleControlCallables(registry, surface());
      const local = new LocalForgeCallableTransport(registry);

      expect(local.discover()).toEqual([
        FORGE_INVOCATION_CANCEL_DESCRIPTOR,
        FORGE_INVOCATION_PAUSE_DESCRIPTOR,
        FORGE_INVOCATION_RESUME_DESCRIPTOR,
      ]);
    });

    it('calls engine.cancelTask exactly once for a valid cancel request and preserves envelope consistency', async () => {
      await createTask('task_cancel');
      const cancelSpy = vi.spyOn(engine, 'cancelTask');
      const startSpy = vi.spyOn(engine, 'startTask');
      const pauseSpy = vi.spyOn(engine, 'pauseTask');
      const resumeSpy = vi.spyOn(engine, 'resumeTask');

      const response = await lifecycleTransport('task_cancel').invoke(FORGE_CANCEL_INVOCATION_METHOD, {
        invocationId: 'inv_callable',
        reason: 'user requested cancellation',
        audit: { callerId: 'forge', correlationId: 'corr_cancel' },
      });

      expect(response.ok).toBe(true);
      if (!response.ok) { throw new Error(response.error.message); }
      expect(response.method).toBe(FORGE_CANCEL_INVOCATION_METHOD);
      expect(response.control).toMatchObject({
        invocationId: 'inv_callable',
        taskId: 'task_cancel',
        action: 'cancel',
        applied: true,
        contractVersion: FORGE_STATUS_CONTRACT_VERSION,
        sideEffects: 'task-lifecycle',
        audit: { callerId: 'forge', correlationId: 'corr_cancel' },
      });
      expect(response.control.status).toMatchObject({ invocationId: 'inv_callable', taskId: 'task_cancel' });
      expect(cancelSpy).toHaveBeenCalledTimes(1);
      expect(cancelSpy).toHaveBeenCalledWith('task_cancel');
      expect(startSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('does not call engine.cancelTask for an invalid cancel request shape', async () => {
      const cancelSpy = vi.spyOn(engine, 'cancelTask');

      const response = await lifecycleTransport().invoke(FORGE_CANCEL_INVOCATION_METHOD, {
        invocationId: '',
      });

      expect(response.ok).toBe(false);
      if (response.ok) { throw new Error('expected rejection'); }
      expect(response.error.code).toBe('invalid_request');
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('fails deterministically without calling engine.cancelTask for an unknown invocation reference', async () => {
      const cancelSpy = vi.spyOn(engine, 'cancelTask');

      const response = await lifecycleTransport().invoke(FORGE_CANCEL_INVOCATION_METHOD, {
        invocationId: 'inv_unknown_cancel',
      });

      expect(response).toMatchObject({
        ok: false,
        method: FORGE_CANCEL_INVOCATION_METHOD,
        error: {
          code: 'not_found',
          message: 'Forge invocation not found: inv_unknown_cancel',
        },
      });
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('calls engine.pauseTask exactly once for a valid pause request', async () => {
      await createTask('task_pause');
      const pauseSpy = vi.spyOn(engine, 'pauseTask');
      const cancelSpy = vi.spyOn(engine, 'cancelTask');
      const resumeSpy = vi.spyOn(engine, 'resumeTask');

      const response = await lifecycleTransport('task_pause').invoke(FORGE_PAUSE_INVOCATION_METHOD, {
        invocationId: 'inv_callable',
      });

      expect(response.ok).toBe(true);
      if (!response.ok) { throw new Error(response.error.message); }
      expect(response.control).toMatchObject({
        invocationId: 'inv_callable',
        taskId: 'task_pause',
        action: 'pause',
        applied: true,
        sideEffects: 'task-lifecycle',
      });
      expect(pauseSpy).toHaveBeenCalledTimes(1);
      expect(pauseSpy).toHaveBeenCalledWith('task_pause');
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('does not call engine.pauseTask for an invalid pause request shape', async () => {
      const pauseSpy = vi.spyOn(engine, 'pauseTask');

      const response = await lifecycleTransport().invoke(FORGE_PAUSE_INVOCATION_METHOD, {
        invocationId: 'inv_callable',
        reason: 42 as unknown as string,
      });

      expect(response.ok).toBe(false);
      if (response.ok) { throw new Error('expected rejection'); }
      expect(response.error.code).toBe('invalid_request');
      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('calls engine.resumeTask exactly once for a valid resume request', async () => {
      await createTask('task_resume');
      await engine.pauseTask('task_resume');
      const resumeSpy = vi.spyOn(engine, 'resumeTask');
      const cancelSpy = vi.spyOn(engine, 'cancelTask');
      const pauseSpy = vi.spyOn(engine, 'pauseTask');

      const response = await lifecycleTransport('task_resume').invoke(FORGE_RESUME_INVOCATION_METHOD, {
        invocationId: 'inv_callable',
      });

      expect(response.ok).toBe(true);
      if (!response.ok) { throw new Error(response.error.message); }
      expect(response.control).toMatchObject({
        invocationId: 'inv_callable',
        taskId: 'task_resume',
        action: 'resume',
        applied: true,
        sideEffects: 'task-lifecycle',
      });
      expect(resumeSpy).toHaveBeenCalledTimes(1);
      expect(resumeSpy).toHaveBeenCalledWith('task_resume');
      expect(cancelSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
    });

    it('does not call engine.resumeTask for an unknown invocation reference', async () => {
      const resumeSpy = vi.spyOn(engine, 'resumeTask');

      const response = await lifecycleTransport().invoke(FORGE_RESUME_INVOCATION_METHOD, {
        invocationId: 'inv_unknown_resume',
      });

      expect(response).toMatchObject({
        ok: false,
        method: FORGE_RESUME_INVOCATION_METHOD,
        error: { code: 'not_found' },
      });
      expect(resumeSpy).not.toHaveBeenCalled();
    });

    it('never invokes model or tool execution paths during lifecycle control', async () => {
      await createTask('task_lifecycle_no_exec');
      const approvalSpy = vi.spyOn(engine, 'respondToApproval');
      const rollbackSpy = vi.spyOn(engine, 'rollbackTask');
      const local = lifecycleTransport('task_lifecycle_no_exec');

      await local.invoke(FORGE_CANCEL_INVOCATION_METHOD, { invocationId: 'inv_callable' });

      expect(approvalSpy).not.toHaveBeenCalled();
      expect(rollbackSpy).not.toHaveBeenCalled();
    });
  });

  describe('execution observability for governed start (M3.6)', () => {
    function fullGovernedTransport(): LocalForgeCallableTransport {
      const adapter = new ReadOnlyForgeInvocationAdapter(engine, [], () => '2026-01-01T00:00:00.000Z');
      const callableSurface = new ReadOnlyForgeCallableSurface(adapter);
      const registry = new ReadOnlyForgeCallableRegistry();
      registerReadOnlyForgeObservabilityCallables(registry, callableSurface);
      registerGovernedForgeInvocationPreparationCallable(registry, callableSurface);
      registerGovernedForgeInvocationStartEligibilityCallable(registry, callableSurface);
      registerGovernedForgeInvocationStartReservationCallable(registry, callableSurface);
      registerGovernedForgeInvocationStartCallable(registry, callableSurface);
      return new LocalForgeCallableTransport(registry);
    }

    it('exposes status, events, progress and evidence consistently after a governed start without model or tool execution', async () => {
      const taskId = 'task_observability';
      const invocationId = 'inv_observability';
      await createTask(taskId);
      const local = fullGovernedTransport();
      const startedSnapshot = await engine.getTask(taskId);
      const startSpy = vi.spyOn(engine, 'startTask').mockResolvedValue(startedSnapshot);
      const respondSpy = vi.spyOn(engine, 'respondToApproval');
      const rollbackSpy = vi.spyOn(engine, 'rollbackTask');
      const pauseSpy = vi.spyOn(engine, 'pauseTask');
      const resumeSpy = vi.spyOn(engine, 'resumeTask');
      const cancelSpy = vi.spyOn(engine, 'cancelTask');
      const audit = { callerId: 'forge', correlationId: 'corr_observability' };

      const prepareResponse = await local.invoke(FORGE_PREPARE_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe governed start', audit,
      });
      expect(prepareResponse.ok).toBe(true);

      const eligibilityResponse = await local.invoke(FORGE_CAN_START_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe governed start', prepared: true, audit,
      });
      expect(eligibilityResponse.ok).toBe(true);
      if (!eligibilityResponse.ok) { throw new Error(eligibilityResponse.error.message); }
      expect(eligibilityResponse.eligibility.eligible).toBe(true);

      const reservationResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe governed start', prepared: true, audit,
      });
      expect(reservationResponse.ok).toBe(true);
      if (!reservationResponse.ok) { throw new Error(reservationResponse.error.message); }
      const reservationId = reservationResponse.reservation.reservationId!;

      const startResponse = await local.invoke(FORGE_START_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe governed start', reservationId, mode: 'agent', audit,
      });
      expect(startResponse.ok).toBe(true);
      if (!startResponse.ok) { throw new Error(startResponse.error.message); }
      expect(startResponse.start.started).toBe(true);
      expect(startResponse.start.reservationId).toBe(reservationId);
      expect(startResponse.start.evidence.reservationId).toBe(reservationId);

      const statusResponse = await local.invoke(FORGE_GET_INVOCATION_STATUS_METHOD, { invocationId, audit });
      const eventsResponse = await local.invoke(FORGE_GET_INVOCATION_EVENTS_METHOD, { invocationId });
      const progressResponse = await local.invoke(FORGE_GET_INVOCATION_PROGRESS_METHOD, { invocationId });

      expect(statusResponse.ok).toBe(true);
      expect(eventsResponse.ok).toBe(true);
      expect(progressResponse.ok).toBe(true);
      if (!statusResponse.ok || !eventsResponse.ok || !progressResponse.ok) {
        throw new Error('expected ok observability responses');
      }

      expect(statusResponse.status).toEqual(startResponse.start.status);
      expect(startResponse.start.evidence.status).toEqual(statusResponse.status);
      expect(statusResponse.status).toMatchObject({ invocationId, taskId, audit });
      expect(eventsResponse.events).toMatchObject({ invocationId, taskId });
      expect(progressResponse.progress).toMatchObject({ invocationId, taskId });

      const progressResponseAgain = await local.invoke(FORGE_GET_INVOCATION_PROGRESS_METHOD, { invocationId });
      expect(progressResponseAgain).toEqual(progressResponse);

      expect(startSpy).toHaveBeenCalledTimes(1);
      expect(respondSpy).not.toHaveBeenCalled();
      expect(rollbackSpy).not.toHaveBeenCalled();
      expect(pauseSpy).not.toHaveBeenCalled();
      expect(resumeSpy).not.toHaveBeenCalled();
      expect(cancelSpy).not.toHaveBeenCalled();
    });

    it('reflects persisted task events accumulated up to and through a governed start', async () => {
      const taskId = 'task_observability_events';
      const invocationId = 'inv_observability_events';
      await createTask(taskId);
      const local = fullGovernedTransport();
      const startSpy = vi.spyOn(engine, 'startTask').mockImplementation(async () => {
        await engine.taskStore.appendEvent(taskId, 'task_started', { via: 'forge.invocation.start' });
        return engine.getTask(taskId);
      });

      const reservationResponse = await local.invoke(FORGE_RESERVE_START_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe events across governed start', prepared: true,
      });
      expect(reservationResponse.ok).toBe(true);
      if (!reservationResponse.ok) { throw new Error(reservationResponse.error.message); }

      const beforeEvents = await local.invoke(FORGE_GET_INVOCATION_EVENTS_METHOD, { invocationId: 'inv_missing_before_start' });
      expect(beforeEvents).toMatchObject({ ok: false, error: { code: 'not_found' } });

      const startResponse = await local.invoke(FORGE_START_INVOCATION_METHOD, {
        invocationId, taskId, goal: 'Observe events across governed start',
        reservationId: reservationResponse.reservation.reservationId!, mode: 'agent',
      });
      expect(startResponse.ok).toBe(true);
      if (!startResponse.ok) { throw new Error(startResponse.error.message); }
      expect(startResponse.start.started).toBe(true);

      const eventsResponse = await local.invoke(FORGE_GET_INVOCATION_EVENTS_METHOD, { invocationId });
      expect(eventsResponse.ok).toBe(true);
      if (!eventsResponse.ok) { throw new Error(eventsResponse.error.message); }
      expect(eventsResponse.events.events.map(event => event.type)).toEqual([
        'task_created',
        'phase_transition',
        'task_started',
      ]);
      expect(eventsResponse.events.integrityFailed).toBe(false);
      expect(startSpy).toHaveBeenCalledTimes(1);
    });
  });
});





