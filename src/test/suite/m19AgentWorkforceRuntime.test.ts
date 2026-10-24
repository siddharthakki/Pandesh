import { describe, expect, it } from 'vitest';
import {
  AgentRegistry,
  HermesWorkforceCoordinator,
} from '../../workforce/M19AgentWorkforceRuntime';
import type {
  AgentAdapter,
  AgentExecutionHandle,
  AgentExecutionStatus,
  AgentModelRoute,
  AgentTaskRequest,
  AgentWorkerDefinition,
} from '../../workforce/M19AgentWorkforceRuntime';

class FakeAdapter implements AgentAdapter {
  readonly kind = 'karkedikha' as const;
  readonly executions = new Map<string, AgentExecutionStatus>();
  readonly cancellations: Array<{ executionId: string; reason: string }> = [];
  sequence = 0;

  async start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle> {
    const executionId = `execution-${++this.sequence}`;
    const startedAt = '2026-07-13T00:00:00.000Z';
    const handle: AgentExecutionStatus = {
      executionId,
      workerId: worker.id,
      requestId: request.requestId,
      adapter: this.kind,
      model: route.model,
      provider: route.provider,
      estimatedCostUsd: 0,
      state: 'running',
      startedAt,
      deadlineAt: new Date(Date.parse(startedAt) + request.timeoutMs).toISOString(),
    };
    this.executions.set(executionId, handle);
    return { ...handle };
  }

  async status(executionId: string): Promise<AgentExecutionStatus | undefined> {
    const value = this.executions.get(executionId);
    return value ? { ...value } : undefined;
  }

  async cancel(executionId: string, reason: string): Promise<boolean> {
    const current = this.executions.get(executionId);
    if (!current) return false;
    this.cancellations.push({ executionId, reason });
    this.executions.set(executionId, {
      ...current,
      state: 'cancelled',
      finishedAt: '2026-07-13T00:00:01.000Z',
      errorSummary: reason,
    });
    return true;
  }
}

function worker(id: string, models: AgentModelRoute[], overrides: Partial<AgentWorkerDefinition> = {}): AgentWorkerDefinition {
  return {
    id,
    name: id,
    adapter: 'karkedikha',
    roles: ['implementer', 'repairer'],
    capabilities: ['coding', 'ci-repair'],
    permissions: ['repository:read', 'worktree:write', 'validation:run', 'github:draft-pr'],
    models,
    maxConcurrent: 1,
    heartbeatTimeoutMs: 5_000,
    enabled: true,
    ...overrides,
  };
}

function request(overrides: Partial<AgentTaskRequest> = {}): AgentTaskRequest {
  return {
    requestId: 'request-1',
    role: 'implementer',
    goal: 'Implement one bounded change.',
    repositoryRoot: '/workspace/repo',
    requiredCapabilities: ['coding'],
    requiredPermissions: ['repository:read', 'worktree:write'],
    estimatedInputTokens: 10_000,
    estimatedOutputTokens: 2_000,
    timeoutMs: 10_000,
    ...overrides,
  };
}

describe('M19 agent workforce runtime', () => {
  it('routes by role, capability, permission, preferred model, and bounded cost', () => {
    const now = () => new Date('2026-07-13T00:00:00.000Z');
    const registry = new AgentRegistry(now);
    registry.registerAdapter(new FakeAdapter());
    registry.registerWorker(worker('expensive', [{
      model: 'premium', provider: 'remote', inputCostPerMillion: 10, outputCostPerMillion: 20, maxContextTokens: 100_000,
    }]));
    registry.registerWorker(worker('local', [{
      model: 'qwen-local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000,
    }]));
    registry.heartbeat({ workerId: 'expensive', at: now().toISOString(), availableSlots: 1 });
    registry.heartbeat({ workerId: 'local', at: now().toISOString(), availableSlots: 1 });

    expect(registry.route(request())).toMatchObject({
      worker: { id: 'local' },
      route: { model: 'qwen-local' },
      estimatedCostUsd: 0,
      reason: 'lowest-cost-compatible',
    });
    expect(registry.route(request({ preferredModel: 'premium', maxCostUsd: 1 }))).toMatchObject({
      worker: { id: 'expensive' },
      route: { model: 'premium' },
      reason: 'preferred-model',
    });
    expect(() => registry.route(request({ maxCostUsd: 0, preferredModel: 'premium', requiredCapabilities: ['missing'] })))
      .toThrow('No available worker');
  });

  it('excludes stale heartbeats and disabled workers', () => {
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const registry = new AgentRegistry(() => new Date(clock));
    registry.registerAdapter(new FakeAdapter());
    registry.registerWorker(worker('worker', [{
      model: 'local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000,
    }]));
    registry.heartbeat({ workerId: 'worker', at: new Date(clock).toISOString(), availableSlots: 1 });
    expect(registry.listWorkers()[0].available).toBe(true);
    clock += 5_001;
    expect(registry.listWorkers()[0].available).toBe(false);
    expect(() => registry.route(request())).toThrow('No available worker');
  });

  it('enforces worker/global concurrency, supports cancellation, and releases capacity', async () => {
    const adapter = new FakeAdapter();
    const registry = new AgentRegistry(() => new Date('2026-07-13T00:00:00.000Z'));
    registry.registerAdapter(adapter);
    registry.registerWorker(worker('worker', [{
      model: 'local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000,
    }]));
    registry.heartbeat({ workerId: 'worker', at: '2026-07-13T00:00:00.000Z', availableSlots: 1 });
    const coordinator = new HermesWorkforceCoordinator(registry, { maxGlobalConcurrent: 1, now: () => new Date('2026-07-13T00:00:00.000Z') });

    const first = await coordinator.dispatch(request());
    await expect(coordinator.dispatch(request({ requestId: 'request-2' }))).rejects.toThrow('Global workforce concurrency limit reached');
    expect(await coordinator.cancel(first.executionId, 'operator-cancelled')).toBe(true);
    registry.heartbeat({ workerId: 'worker', at: '2026-07-13T00:00:00.000Z', availableSlots: 1 });
    await expect(coordinator.dispatch(request({ requestId: 'request-2' }))).resolves.toMatchObject({ requestId: 'request-2' });
  });

  it('times out an execution through its adapter and releases the worker slot', async () => {
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const adapter = new FakeAdapter();
    const registry = new AgentRegistry(() => new Date(clock));
    registry.registerAdapter(adapter);
    registry.registerWorker(worker('worker', [{
      model: 'local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000,
    }], { heartbeatTimeoutMs: 60_000 }));
    registry.heartbeat({ workerId: 'worker', at: new Date(clock).toISOString(), availableSlots: 1 });
    const coordinator = new HermesWorkforceCoordinator(registry, { maxGlobalConcurrent: 1, now: () => new Date(clock) });
    const handle = await coordinator.dispatch(request({ timeoutMs: 500 }));

    clock += 501;
    const changed = await coordinator.reconcile();
    expect(changed).toEqual([expect.objectContaining({ executionId: handle.executionId, state: 'timed-out' })]);
    expect(adapter.cancellations).toEqual([{ executionId: handle.executionId, reason: 'timeout' }]);
    expect(registry.listWorkers()[0].active).toBe(0);
  });
});
