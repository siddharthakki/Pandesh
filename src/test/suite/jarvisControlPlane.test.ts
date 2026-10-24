import { describe, expect, it } from 'vitest';
import { JarvisControlAdapter, JarvisControlPlane } from '../../control/JarvisControlPlane';

function adapter(counter: { pauses: number }): JarvisControlAdapter {
  return {
    health: async () => ({ ok: true }),
    operationsSnapshot: async () => ({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      totals: { tasks: 0, running: 0, blocked: 0, completed: 0, retainedWorktrees: 0 },
      activity: { readOnlyBatchActive: false, writeBatchActive: false, integrationsActive: 0, sandboxesActive: 0, rpcServicesActive: 0, mcpRegistriesActive: 0 },
      tasks: [], worktrees: [],
      observations: { schemaVersion: 1, generatedAt: new Date(0).toISOString(), eventCount: 0, counters: {}, recentEvents: [] },
    }),
    listTasks: async () => [],
    pauseTask: async taskId => { counter.pauses += 1; return { taskId, paused: true }; },
    resumeTask: async taskId => ({ taskId, resumed: true }),
    cancelTask: async taskId => ({ taskId, cancelled: true }),
    listWorktrees: async () => [],
    discardWorktree: async () => undefined,
    runDiagnostics: async () => ({ schemaVersion: 1, generatedAt: new Date(0).toISOString(), healthy: true, findings: [] }),
    repairDiagnostic: async repairId => ({ repairId, status: 'completed', summary: 'done', changedPaths: [] }),
  };
}

describe('Phase 25 Jarvis control plane', () => {
  it('publishes a narrow capability manifest', () => {
    const control = new JarvisControlPlane(adapter({ pauses: 0 }));
    const capabilities = control.capabilities();
    expect(capabilities.arbitraryCommands).toBe(false);
    expect(capabilities.arbitraryTools).toBe(false);
    expect(capabilities.mutationApprovalRequired).toBe(true);
    expect(capabilities.readActions).toContain('operations.snapshot');
  });

  it('ignores caller approval claims and denies mutations without a host verifier', async () => {
    const counter = { pauses: 0 };
    const control = new JarvisControlPlane(adapter(counter));

    const denied = await control.execute({
      requestId: 'one',
      action: 'tasks.pause',
      params: { taskId: 'task-one' },
      idempotencyKey: 'pause:task-one:1',
    });
    expect(denied.status).toBe('denied');
    expect(denied.error).toMatch(/host/i);
    expect(counter.pauses).toBe(0);
  });

  it('requires an idempotency key before consulting the host verifier', async () => {
    const counter = { pauses: 0 };
    let approvals = 0;
    const control = new JarvisControlPlane(adapter(counter), {
      approveMutation: async () => { approvals += 1; return true; },
    });

    const denied = await control.execute({
      requestId: 'two',
      action: 'tasks.pause',
      params: { taskId: 'task-one' },
    });
    expect(denied.status).toBe('denied');
    expect(denied.error).toMatch(/idempotency/i);
    expect(approvals).toBe(0);
    expect(counter.pauses).toBe(0);
  });

  it('executes only after host approval and replays the same mutation once', async () => {
    const counter = { pauses: 0 };
    let approvals = 0;
    const control = new JarvisControlPlane(adapter(counter), {
      approveMutation: async request => {
        approvals += 1;
        return request.action === 'tasks.pause' && request.params?.['taskId'] === 'task-one';
      },
    });
    const request = {
      requestId: 'pause-one',
      action: 'tasks.pause' as const,
      params: { taskId: 'task-one' },
      idempotencyKey: 'pause:task-one:1',
    };

    const first = await control.execute(request);
    const replay = await control.execute({ ...request, requestId: 'pause-two' });
    expect(first.status).toBe('completed');
    expect(replay.status).toBe('completed');
    expect(replay.requestId).toBe('pause-two');
    expect(replay.replayed).toBe(true);
    expect(approvals).toBe(1);
    expect(counter.pauses).toBe(1);

    const collision = await control.execute({
      ...request,
      requestId: 'pause-three',
      params: { taskId: 'task-two' },
    });
    expect(collision.status).toBe('denied');
    expect(collision.error).toMatch(/different mutation/i);
    expect(approvals).toBe(1);
    expect(counter.pauses).toBe(1);
  });

  it('denies when the host verifier rejects the mutation', async () => {
    const counter = { pauses: 0 };
    const control = new JarvisControlPlane(adapter(counter), {
      approveMutation: async () => false,
    });
    const response = await control.execute({
      requestId: 'rejected',
      action: 'tasks.pause',
      params: { taskId: 'task-one' },
      idempotencyKey: 'pause:task-one:2',
    });

    expect(response.status).toBe('denied');
    expect(response.error).toMatch(/host/i);
    expect(counter.pauses).toBe(0);
  });
});
