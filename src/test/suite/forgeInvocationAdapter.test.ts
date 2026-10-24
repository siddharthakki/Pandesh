import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ReadOnlyForgeInvocationAdapter } from '../../agent/ForgeInvocationAdapter';
import { LocalAgentEngine } from '../../agent/LocalAgentEngine';
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
  userGoal: 'Expose read-only Forge status',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('ReadOnlyForgeInvocationAdapter', () => {
  let root: string;
  let engine: LocalAgentEngine;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-forge-adapter-'));
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

  it('looks up a known invocation and delegates status projection to LocalAgentEngine', async () => {
    await createTask('task_known_invocation');
    const spy = vi.spyOn(engine, 'getForgeInvocationStatus');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_known',
      taskId: 'task_known_invocation',
      audit: { callerId: 'hermes' },
    }]);

    const status = await adapter.getStatus({ invocationId: 'inv_known' });

    expect(spy).toHaveBeenCalledWith('task_known_invocation', 'inv_known', { callerId: 'hermes' });
    expect(status).toMatchObject({
      invocationId: 'inv_known',
      taskId: 'task_known_invocation',
      phase: 'running',
      audit: { callerId: 'hermes' },
    });
  });

  it('rejects an unknown invocation before reading the engine', async () => {
    await createTask('task_known_invocation');
    const spy = vi.spyOn(engine, 'getForgeInvocationStatus');
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_known',
      taskId: 'task_known_invocation',
    }]);

    await expect(adapter.getStatus({ invocationId: 'inv_missing' })).rejects.toThrow(
      /Forge invocation not found: inv_missing/,
    );
    expect(spy).not.toHaveBeenCalled();
  });

  it('surfaces unknown task lookup errors from the engine', async () => {
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_orphaned',
      taskId: 'task_missing',
    }]);

    await expect(adapter.getStatus({ invocationId: 'inv_orphaned' })).rejects.toThrow(
      /Task not found: task_missing/,
    );
  });

  it('does not mutate task records or append task events during status lookup', async () => {
    const taskId = 'task_no_mutation';
    await createTask(taskId);
    const adapter = new ReadOnlyForgeInvocationAdapter(engine, [{
      invocationId: 'inv_no_mutation',
      taskId,
    }]);
    const beforeTask = await engine.taskStore.getTask(taskId);
    const beforeEvents = await engine.taskStore.getEvents(taskId);

    await adapter.getStatus({ invocationId: 'inv_no_mutation' });

    expect(await engine.taskStore.getTask(taskId)).toEqual(beforeTask);
    expect(await engine.taskStore.getEvents(taskId)).toEqual(beforeEvents);
  });
});
