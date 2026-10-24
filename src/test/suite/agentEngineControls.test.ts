import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { DEFAULT_TASK_BUDGETS, createInitialUsage } from '../../agent/AgentEngineTypes';

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
  userGoal: 'Exercise engine controls',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('AgentEngine controls', () => {
  let root: string;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-engine-control-'));
    runtime = new AgentRuntime(root, secretStorage());
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createTask(taskId: string, phase: 'executing' | 'paused' | 'blocked' = 'executing') {
    await runtime.taskStore.createTask({ taskId, ...BASE_TASK });
    await runtime.taskStore.updateTask(taskId, {
      phase,
      status: phase === 'paused' ? 'paused' : phase === 'blocked' ? 'blocked' : 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      engineUsage: createInitialUsage('2026-01-01T00:00:00.000Z'),
    });
  }

  it('pauses, steers, and cancels through the engine while persisting state', async () => {
    const taskId = 'task_engine_controls';
    await createTask(taskId);
    const eventTypes: string[] = [];
    const subscription = runtime.subscribe(taskId, event => eventTypes.push(event.type));

    const paused = await runtime.pauseTask(taskId);
    expect(paused.phase).toBe('paused');
    expect(paused.task.status).toBe('paused');
    expect(paused.usage.activeSince).toBeUndefined();
    expect(paused.usage.pausedAt).toBeDefined();

    const steered = await runtime.sendSteering(taskId, 'Prefer the minimal compatible fix.');
    expect(steered.task.pendingSteering?.[0]?.content).toContain('minimal compatible fix');

    const cancelled = await runtime.cancelTask(taskId);
    expect(cancelled.phase).toBe('cancelled');
    expect(cancelled.task.cancelledAt).toBeDefined();
    expect(eventTypes).toEqual(expect.arrayContaining([
      'phase_transition',
      'paused',
      'steering_accepted',
      'cancelled',
    ]));

    subscription.dispose();
  });

  it('filters task listings by phase', async () => {
    await createTask('task_list_paused', 'paused');
    await createTask('task_list_blocked', 'blocked');

    const paused = await runtime.listTasks({ phases: ['paused'] });
    expect(paused.map(item => item.task.taskId)).toEqual(['task_list_paused']);
  });

  it('refuses to resume an uncertain recovered mutation', async () => {
    const taskId = 'task_uncertain_resume';
    await createTask(taskId, 'blocked');
    await runtime.taskStore.updateTask(taskId, {
      blockedReason: 'mutation_outcome_uncertain',
      resumePhase: undefined,
    });

    await expect(runtime.resumeTask(taskId)).rejects.toThrow(/uncertain mutation/i);
    const snapshot = await runtime.getTask(taskId);
    expect(snapshot.phase).toBe('blocked');
  });

  it('rejects steering and resume for terminal tasks', async () => {
    const taskId = 'task_terminal_controls';
    await createTask(taskId, 'paused');
    await runtime.cancelTask(taskId);

    await expect(runtime.sendSteering(taskId, 'continue')).rejects.toThrow(/terminal/i);
    await expect(runtime.resumeTask(taskId)).rejects.toThrow(/terminal/i);
  });

  it('does not claim a missing checkpoint was restored', async () => {
    const taskId = 'task_missing_rollback';
    await createTask(taskId, 'paused');

    await expect(runtime.rollbackTask(taskId, {
      kind: 'checkpoint',
      checkpointId: 'missing-checkpoint',
    })).rejects.toThrow(/missing|unreadable/i);
  });
});
