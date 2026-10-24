import { describe, expect, it } from 'vitest';
import { AgentRegistry, HermesWorkforceCoordinator } from '../../workforce/M19AgentWorkforceRuntime';
import type { AgentAdapter, AgentExecutionHandle, AgentExecutionStatus, AgentModelRoute, AgentTaskRequest, AgentWorkerDefinition } from '../../workforce/M19AgentWorkforceRuntime';
import { AutonomousSprintEngine, InMemorySprintStore } from '../../sprint/M20AutonomousSprint';
import type { SprintStory } from '../../sprint/M20AutonomousSprint';

class NoopAdapter implements AgentAdapter {
  readonly kind = 'karkedikha' as const;
  async start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle> {
    return {
      executionId: `execution-${request.requestId}`,
      workerId: worker.id,
      requestId: request.requestId,
      adapter: this.kind,
      model: route.model,
      provider: route.provider,
      estimatedCostUsd: 0,
      state: 'running',
      startedAt: '2026-07-13T00:00:00.000Z',
      deadlineAt: '2026-07-13T01:00:00.000Z',
    };
  }
  async status(): Promise<AgentExecutionStatus | undefined> { return undefined; }
  async cancel(): Promise<boolean> { return true; }
}

function story(id: string, estimate: number, priority: SprintStory['priority'], dependencies: string[] = []): SprintStory {
  return {
    id,
    title: id,
    goal: id,
    kind: 'story',
    acceptanceCriteria: [`${id} passes`],
    dependencies,
    estimate,
    priority,
    requiredCapabilities: ['coding'],
    role: 'implementer',
    state: dependencies.length ? 'backlog' : 'ready',
    progress: 0,
  };
}

function coordinator(): HermesWorkforceCoordinator {
  const registry = new AgentRegistry(() => new Date('2026-07-13T00:00:00.000Z'));
  registry.registerAdapter(new NoopAdapter());
  registry.registerWorker({
    id: 'worker', name: 'worker', adapter: 'karkedikha', roles: ['implementer'], capabilities: ['coding'],
    permissions: ['repository:read', 'worktree:write', 'validation:run'],
    models: [{ model: 'local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32000 }],
    maxConcurrent: 1, heartbeatTimeoutMs: 60000, enabled: true,
  });
  registry.heartbeat({ workerId: 'worker', at: '2026-07-13T00:00:00.000Z', availableSlots: 1 });
  return new HermesWorkforceCoordinator(registry, { maxGlobalConcurrent: 1, now: () => new Date('2026-07-13T00:00:00.000Z') });
}

describe('M20 dependency-safe capacity planning', () => {
  it('never selects a dependent story when its dependency does not fit', async () => {
    const engine = new AutonomousSprintEngine(
      new InMemorySprintStore(),
      coordinator(),
      undefined,
      undefined,
      { repositoryRoot: '/workspace/repo', blockedEscalationMs: 1000 },
    );
    const planned = await engine.planSprint({
      name: 'Capacity',
      goal: 'No orphaned work',
      endsAt: '2026-07-27T00:00:00.000Z',
      capacityPoints: 3,
      wipLimit: 1,
      backlog: [
        story('large-foundation', 5, 'low'),
        story('urgent-dependent', 2, 'urgent', ['large-foundation']),
        story('independent', 3, 'normal'),
      ],
    });

    expect(planned.storyIds).toEqual(['independent']);
    expect((await engine.state()).stories.map(value => value.id)).toEqual(['independent']);
  });

  it('keeps dependency order even when the dependent has higher priority', async () => {
    const engine = new AutonomousSprintEngine(
      new InMemorySprintStore(),
      coordinator(),
      undefined,
      undefined,
      { repositoryRoot: '/workspace/repo', blockedEscalationMs: 1000 },
    );
    const planned = await engine.planSprint({
      name: 'Order',
      goal: 'Dependencies first',
      endsAt: '2026-07-27T00:00:00.000Z',
      capacityPoints: 4,
      wipLimit: 1,
      backlog: [
        story('foundation', 2, 'low'),
        story('dependent', 2, 'urgent', ['foundation']),
      ],
    });

    expect(planned.storyIds).toEqual(['foundation', 'dependent']);
  });
});
