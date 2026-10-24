import { describe, expect, it } from 'vitest';
import {
  AgentPhase,
  AgentTaskSnapshot,
  DEFAULT_TASK_BUDGETS,
  createInitialUsage,
} from '../../agent/AgentEngineTypes';
import { projectAgentSnapshotToForgeStatus } from '../../agent/ForgeStatusProjection';
import { PersistedTask } from '../../agent/TaskTypes';

function snapshot(
  phase: AgentPhase,
  overrides: Partial<AgentTaskSnapshot> = {},
  taskOverrides: Partial<PersistedTask> = {},
): AgentTaskSnapshot {
  const task: PersistedTask = {
    schemaVersion: 1,
    taskId: 'task_forge_projection',
    workspaceId: '/workspace',
    workspaceRoot: '/workspace',
    userGoal: 'Project status',
    mode: 'agent',
    status: phase === 'completed' ? 'completed' : phase === 'failed' ? 'failed' : 'running',
    providerType: 'ollama',
    model: 'test-model',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    phase,
    ...taskOverrides,
  };

  return {
    task,
    phase,
    budgets: DEFAULT_TASK_BUDGETS,
    usage: createInitialUsage(task.createdAt),
    checkpoints: [],
    ...overrides,
  };
}

describe('Forge status projection', () => {
  it('projects active local phases into running Forge status', () => {
    const status = projectAgentSnapshotToForgeStatus(snapshot('executing'), {
      invocationId: 'inv_123',
    });

    expect(status).toMatchObject({
      invocationId: 'inv_123',
      taskId: 'task_forge_projection',
      phase: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
  });

  it('preserves approval, blocked, failed, delivered, verified, and cancelled meanings', () => {
    expect(projectAgentSnapshotToForgeStatus(snapshot('waiting_for_approval'), {
      invocationId: 'inv_approval',
    }).phase).toBe('approval_required');

    expect(projectAgentSnapshotToForgeStatus(snapshot('blocked', {
      blockedReason: 'Needs inspection.',
    }), {
      invocationId: 'inv_blocked',
    })).toMatchObject({
      phase: 'blocked',
      errorSummary: 'Needs inspection.',
    });

    expect(projectAgentSnapshotToForgeStatus(snapshot('failed', {}, {
      failure: {
        message: 'Validation failed.',
        timestamp: '2026-01-01T00:01:00.000Z',
      },
    }), {
      invocationId: 'inv_failed',
    })).toMatchObject({
      phase: 'failed',
      errorSummary: 'Validation failed.',
    });

    expect(projectAgentSnapshotToForgeStatus(snapshot('validating', {
      validationPassed: true,
    }), {
      invocationId: 'inv_verified',
    }).phase).toBe('verified');

    expect(projectAgentSnapshotToForgeStatus(snapshot('completed'), {
      invocationId: 'inv_delivered',
    }).phase).toBe('delivered');

    expect(projectAgentSnapshotToForgeStatus(snapshot('cancelled', {
      blockedReason: 'user_cancel',
    }), {
      invocationId: 'inv_cancelled',
    })).toMatchObject({
      phase: 'cancelled',
      cancellationReason: 'user_cancel',
    });
  });

  it('passes optional audit metadata through without interpreting it', () => {
    const status = projectAgentSnapshotToForgeStatus(snapshot('planning'), {
      invocationId: 'inv_audit',
      audit: {
        callerId: 'hermes',
        correlationId: 'corr_123',
        source: 'local-rpc',
        metadata: { attempt: 1 },
      },
    });

    expect(status.phase).toBe('accepted');
    expect(status.audit).toEqual({
      callerId: 'hermes',
      correlationId: 'corr_123',
      source: 'local-rpc',
      metadata: { attempt: 1 },
    });
  });
});
