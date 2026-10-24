import { describe, expect, it } from 'vitest';
import { ObservabilityHub } from '../../observability/ObservabilityHub';
import { OperationsService, OperationsTaskSource } from '../../observability/OperationsService';

function activity() {
  return {
    readOnlyBatchActive: false,
    writeBatchActive: false,
    integrationsActive: 0,
    sandboxesActive: 0,
    rpcServicesActive: 0,
    mcpRegistriesActive: 0,
  };
}

describe('OperationsService resilience', () => {
  it('returns task telemetry when worktree discovery is unavailable', async () => {
    const source: OperationsTaskSource = {
      async listTasks() {
        return [{
          task: {
            taskId: 'task-1',
            title: 'Non-git workspace task',
            userGoal: 'Run a local task',
            status: 'running',
            model: 'local-model',
            createdAt: '2026-06-27T08:00:00.000Z',
            updatedAt: '2026-06-27T08:01:00.000Z',
          },
          phase: 'executing',
          usage: { modelCalls: 1, toolCalls: 2, repairAttempts: 0, outputBytes: 20 },
          budgets: {
            maxModelCalls: 10,
            maxToolCalls: 20,
            maxRepairAttempts: 2,
            maxOutputBytes: 1000,
            maxWallClockMs: 60_000,
            maxNoProgressSteps: 3,
          },
        }];
      },
      async listWorktreeLeases() {
        throw new Error('fatal: not a git repository');
      },
      activity,
    };

    const snapshot = await new OperationsService(source, new ObservabilityHub()).snapshot();

    expect(snapshot.totals.tasks).toBe(1);
    expect(snapshot.totals.running).toBe(1);
    expect(snapshot.totals.retainedWorktrees).toBe(0);
    expect(snapshot.tasks[0].taskId).toBe('task-1');
  });
});
