import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PersistentOperationsReader } from '../../observability/PersistentOperationsReader';

describe('Phase 21 persistent operations reader', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-operations-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('summarizes durable tasks, worktrees, and observation evidence', async () => {
    const taskDir = path.join(root, '.ollama-agent', 'tasks', 'task-one');
    const orchestration = path.join(root, '.ollama-agent', 'tasks', '_orchestration');
    const worktrees = path.join(root, '.ollama-agent', 'tasks', '_worktrees');
    await fs.mkdir(taskDir, { recursive: true });
    await fs.mkdir(orchestration, { recursive: true });
    await fs.mkdir(worktrees, { recursive: true });
    await fs.writeFile(path.join(taskDir, 'task.json'), JSON.stringify({
      taskId: 'task-one',
      title: 'Implement feature',
      status: 'blocked',
      phase: 'blocked',
      model: 'local-model',
      updatedAt: '2026-06-26T12:00:00.000Z',
      blockedReason: 'validation failed',
      engineUsage: { modelCalls: 2, toolCalls: 3, repairAttempts: 1, outputBytes: 100 },
      engineBudgets: { maxModelCalls: 10, maxToolCalls: 10, maxRepairAttempts: 2, maxOutputBytes: 1000 },
    }), 'utf8');
    await fs.writeFile(path.join(worktrees, 'manifest.json'), JSON.stringify({
      leases: [{ taskId: 'task-one', branch: 'agent/task-one', status: 'completed', allowedPaths: ['src'], createdAt: '2026-06-26T11:00:00.000Z' }],
    }), 'utf8');
    await fs.writeFile(path.join(orchestration, 'observations.jsonl'), `${JSON.stringify({
      schemaVersion: 1, sequence: 1, timestamp: '2026-06-26T12:00:00.000Z', level: 'warning', category: 'task', name: 'run.failed',
    })}\n`, 'utf8');

    const snapshot = await new PersistentOperationsReader(root).read();
    expect(snapshot.totals).toEqual({ tasks: 1, running: 0, blocked: 1, completed: 0, retainedWorktrees: 1 });
    expect(snapshot.tasks[0].utilization.modelCalls).toBe(0.2);
    expect(snapshot.worktrees[0].branch).toBe('agent/task-one');
    expect(snapshot.observations.counters['task.run.failed']).toBe(1);
  });
});
