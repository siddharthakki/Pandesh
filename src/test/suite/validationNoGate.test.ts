import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskStore } from '../../agent/TaskStore';
import { ValidationRunner } from '../../validation/ValidationRunner';
import { ValidationCommandExecutor } from '../../validation/ValidationTypes';

class NeverCalledExecutor implements ValidationCommandExecutor {
  async execute(): Promise<never> {
    throw new Error('executor must not run when no validation gate exists');
  }
}

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Require mechanical validation',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('ValidationRunner strict no-gate policy', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_no_validation_gate';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-no-gate-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('fails instead of claiming success when no mechanical gate is discoverable', async () => {
    const runner = new ValidationRunner(root, store, new NeverCalledExecutor());
    const summary = await runner.run({ taskId, attempt: 1 });

    expect(summary.passed).toBe(false);
    expect(summary.requiredPassed).toBe(false);
    expect(summary.results).toHaveLength(1);
    expect(summary.results[0].gate.id).toBe('builtin-no-mechanical-validation');
    expect(summary.results[0].status).toBe('failed');
    expect(summary.results[0].stderr).toMatch(/no mechanical validation command/i);

    const persisted = await runner.readLatest(taskId);
    expect(persisted?.passed).toBe(false);
    expect(persisted?.failureFingerprint).toBe(summary.failureFingerprint);

    const events = await store.getEvents(taskId);
    expect(events.events.some(event => event.type === 'validation_started')).toBe(true);
    expect(events.events.some(event => event.type === 'validation_result')).toBe(true);
  });
});
