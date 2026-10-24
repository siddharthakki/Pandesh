import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AgentStateMachine,
  InvalidPhaseTransitionError,
  canTransition,
  phaseToTaskStatus,
} from '../../agent/AgentStateMachine';
import { AgentPhase } from '../../agent/AgentEngineTypes';
import { BudgetTracker, normalizeBudgets } from '../../agent/BudgetTracker';
import { TaskStore } from '../../agent/TaskStore';

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Implement a bounded state machine',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('AgentStateMachine', () => {
  let root: string;
  let store: TaskStore;
  let machine: AgentStateMachine;
  const taskId = 'task_state_machine';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-state-machine-'));
    store = new TaskStore(root);
    machine = new AgentStateMachine(store);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists valid transitions and a phase_transition event', async () => {
    await machine.transition(taskId, 'understanding', { reason: 'user_request' });
    await machine.transition(taskId, 'planning', { reason: 'model_result' });

    const task = await store.getTask(taskId);
    expect(task?.phase).toBe('planning');
    expect(task?.status).toBe('running');

    const events = await store.getEvents(taskId);
    const transitions = events.events.filter(event => event.type === 'phase_transition');
    expect(transitions).toHaveLength(2);
    expect(transitions[1].payload['from']).toBe('understanding');
    expect(transitions[1].payload['to']).toBe('planning');
  });

  it('rejects prohibited transitions without changing state', async () => {
    await expect(
      machine.transition(taskId, 'completed', { reason: 'validation_passed' }),
    ).rejects.toBeInstanceOf(InvalidPhaseTransitionError);

    const task = await store.getTask(taskId);
    expect(task?.status).toBe('created');
    expect(task?.phase).toBeUndefined();
    expect((await store.getEvents(taskId)).events).toHaveLength(0);
  });

  it('restores the previous authoritative state if transition event persistence fails', async () => {
    vi.spyOn(store, 'appendEvent').mockRejectedValueOnce(new Error('disk full'));

    await expect(
      machine.transition(taskId, 'understanding', { reason: 'user_request' }),
    ).rejects.toThrow(/disk full/i);

    const task = await store.getTask(taskId);
    expect(task?.status).toBe('created');
    expect(task?.phase).toBeUndefined();
  });

  it('maps pause and resume through the persisted resume phase', async () => {
    await machine.transition(taskId, 'understanding', { reason: 'user_request' });
    await machine.transition(taskId, 'planning', { reason: 'model_result' });
    await machine.transition(taskId, 'paused', {
      reason: 'user_pause',
      resumePhase: 'planning',
    });

    let task = await store.getTask(taskId);
    expect(task?.status).toBe('paused');
    expect(task?.resumePhase).toBe('planning');

    await machine.transition(taskId, 'planning', { reason: 'user_resume' });
    task = await store.getTask(taskId);
    expect(task?.phase).toBe('planning');
    expect(task?.status).toBe('running');
  });

  it('allows cancellation from every non-terminal phase', async () => {
    const phases: AgentPhase[] = [
      'created',
      'understanding',
      'planning',
      'ready',
      'executing',
      'waiting_for_approval',
      'validating',
      'repairing',
      'paused',
      'blocked',
      'recovering',
    ];

    for (const phase of phases) {
      const id = `cancel_${phase}`;
      await store.createTask({ taskId: id, ...BASE_TASK });
      await store.updateTask(id, { phase, status: phaseToTaskStatus(phase) });
      await machine.transition(id, 'cancelled', { reason: 'user_cancel' });
      const task = await store.getTask(id);
      expect(task?.phase).toBe('cancelled');
      expect(task?.status).toBe('cancelled');
      expect(task?.cancelledAt).toBeDefined();
    }
  });

  it('persists terminal completion only from validation', async () => {
    await machine.transition(taskId, 'understanding', { reason: 'user_request' });
    await machine.transition(taskId, 'planning', { reason: 'model_result' });
    await machine.transition(taskId, 'ready', { reason: 'model_result' });
    await machine.transition(taskId, 'executing', { reason: 'user_request' });
    await machine.transition(taskId, 'validating', { reason: 'model_result' });
    await machine.transition(taskId, 'completed', { reason: 'validation_passed' });

    const task = await store.getTask(taskId);
    expect(task?.phase).toBe('completed');
    expect(task?.status).toBe('completed');
    expect(task?.completedAt).toBeDefined();
    expect(canTransition('completed', 'executing')).toBe(false);
  });
});

describe('BudgetTracker', () => {
  it('rejects invalid budgets', () => {
    expect(() => normalizeBudgets({ maxToolCalls: 0 })).toThrow(/maxToolCalls/i);
    expect(() => normalizeBudgets({ maxWallClockMs: Number.NaN })).toThrow(/maxWallClockMs/i);
  });

  it('enforces model and tool call limits', () => {
    const tracker = new BudgetTracker({ maxModelCalls: 1, maxToolCalls: 1 });
    expect(tracker.consumeModelCall().ok).toBe(true);
    expect(tracker.consumeModelCall()).toMatchObject({ ok: false, kind: 'model_calls' });

    const toolTracker = new BudgetTracker({ maxToolCalls: 1 });
    expect(toolTracker.consumeToolCall().ok).toBe(true);
    expect(toolTracker.consumeToolCall()).toMatchObject({ ok: false, kind: 'tool_calls' });
  });

  it('does not count paused time as active wall clock', () => {
    const tracker = new BudgetTracker(
      { maxWallClockMs: 10_000 },
      {
        startedAt: '2026-01-01T00:00:00.000Z',
        activeSince: '2026-01-01T00:00:00.000Z',
        elapsedActiveMs: 100,
      },
    );

    tracker.pause('2026-01-01T00:00:01.000Z');
    const paused = tracker.snapshot(new Date('2026-01-01T01:00:00.000Z').getTime());
    expect(paused.elapsedActiveMs).toBe(1100);
  });

  it('tracks approval wait separately from active execution', () => {
    const tracker = new BudgetTracker(
      { maxWallClockMs: 10_000 },
      {
        startedAt: '2026-01-01T00:00:00.000Z',
        activeSince: '2026-01-01T00:00:00.000Z',
        elapsedActiveMs: 0,
      },
    );
    tracker.enterApprovalWait('2026-01-01T00:00:01.000Z');
    tracker.leaveApprovalWait(
      '2026-01-01T00:00:01.000Z',
      '2026-01-01T00:00:06.000Z',
    );
    const usage = tracker.snapshot(new Date('2026-01-01T00:00:07.000Z').getTime());
    expect(usage.waitingApprovalMs).toBe(5000);
    expect(usage.elapsedActiveMs).toBe(2000);
  });

  it('detects repeated no-progress fingerprints before the generic iteration limit', () => {
    const tracker = new BudgetTracker({ maxNoProgressSteps: 2, maxIterations: 20 });
    expect(tracker.recordProgress('same').ok).toBe(true);
    expect(tracker.recordProgress('same').ok).toBe(true);
    expect(tracker.recordProgress('same')).toMatchObject({ ok: false, kind: 'no_progress' });
    expect(tracker.snapshot().iterations).toBe(0);
  });

  it('persists and continues existing counters', () => {
    const tracker = new BudgetTracker(
      { maxRepairAttempts: 3 },
      { repairAttempts: 2, modelCalls: 4, toolCalls: 7 },
    );
    expect(tracker.consumeRepairAttempt().ok).toBe(true);
    expect(tracker.snapshot()).toMatchObject({
      repairAttempts: 3,
      modelCalls: 4,
      toolCalls: 7,
    });
  });
});
