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
import {
  AutonomousSprintEngine,
  InMemorySprintStore,
  NoopSprintBoardReporter,
} from '../../sprint/M20AutonomousSprint';
import type { SprintStory, StoryDecomposer } from '../../sprint/M20AutonomousSprint';

class SprintAdapter implements AgentAdapter {
  readonly kind = 'karkedikha' as const;
  readonly values = new Map<string, AgentExecutionStatus>();
  sequence = 0;

  async start(worker: AgentWorkerDefinition, request: AgentTaskRequest, route: AgentModelRoute): Promise<AgentExecutionHandle> {
    const executionId = `sprint-execution-${++this.sequence}`;
    const value: AgentExecutionStatus = {
      executionId,
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
    this.values.set(executionId, value);
    return { ...value };
  }

  async status(executionId: string): Promise<AgentExecutionStatus | undefined> {
    const value = this.values.get(executionId);
    return value ? { ...value } : undefined;
  }

  async cancel(executionId: string): Promise<boolean> {
    const value = this.values.get(executionId);
    if (!value) return false;
    this.values.set(executionId, { ...value, state: 'cancelled', finishedAt: '2026-07-13T00:01:00.000Z' });
    return true;
  }

  complete(executionId: string): void {
    const value = this.values.get(executionId);
    if (!value) throw new Error(`Unknown execution ${executionId}`);
    this.values.set(executionId, { ...value, state: 'completed', finishedAt: '2026-07-13T00:02:00.000Z' });
  }
}

function story(id: string, dependencies: string[] = []): SprintStory {
  return {
    id,
    externalRef: `siddharthakki/ollama-agent#${id === 'foundation' ? 1 : 2}`,
    title: id,
    goal: `Deliver ${id}`,
    kind: 'story',
    acceptanceCriteria: [`${id} works`],
    dependencies,
    estimate: 2,
    priority: id === 'foundation' ? 'high' : 'normal',
    requiredCapabilities: ['coding'],
    role: 'implementer',
    state: dependencies.length ? 'backlog' : 'ready',
    progress: 0,
  };
}

function workforce(adapter: SprintAdapter, now: () => Date): { coordinator: HermesWorkforceCoordinator; registry: AgentRegistry } {
  const registry = new AgentRegistry(now);
  registry.registerAdapter(adapter);
  registry.registerWorker({
    id: 'worker',
    name: 'worker',
    adapter: 'karkedikha',
    roles: ['implementer'],
    capabilities: ['coding'],
    permissions: ['repository:read', 'worktree:write', 'validation:run'],
    models: [{ model: 'local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000 }],
    maxConcurrent: 1,
    heartbeatTimeoutMs: 60_000,
    enabled: true,
  });
  registry.heartbeat({ workerId: 'worker', at: now().toISOString(), availableSlots: 1 });
  return { coordinator: new HermesWorkforceCoordinator(registry, { maxGlobalConcurrent: 1, now }), registry };
}

describe('M20 autonomous sprint execution', () => {
  it('decomposes epics, schedules dependencies, enforces WIP, updates progress, and generates review/retro', async () => {
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const now = () => new Date(clock);
    const adapter = new SprintAdapter();
    const { coordinator, registry } = workforce(adapter, now);
    const decomposer: StoryDecomposer = {
      async decompose() {
        return [story('foundation'), story('dependent', ['foundation'])];
      },
    };
    const epic: SprintStory = {
      id: 'epic', title: 'Epic', goal: 'Epic goal', kind: 'epic', acceptanceCriteria: [], dependencies: [],
      estimate: 4, priority: 'high', requiredCapabilities: ['coding'], role: 'planner', state: 'ready', progress: 0,
    };
    const engine = new AutonomousSprintEngine(
      new InMemorySprintStore(),
      coordinator,
      new NoopSprintBoardReporter(),
      decomposer,
      { repositoryRoot: '/workspace/repo', blockedEscalationMs: 1_000, now },
    );

    const planned = await engine.planSprint({
      name: 'Sprint 1', goal: 'Deliver dependency chain', endsAt: '2026-07-27T00:00:00.000Z',
      capacityPoints: 4, wipLimit: 1, backlog: [epic],
    });
    await engine.startSprint(planned.id);
    let state = await engine.state();
    const foundation = state.stories.find(value => value.id === 'foundation')!;
    const dependent = state.stories.find(value => value.id === 'dependent')!;
    expect(foundation.state).toBe('assigned');
    expect(dependent.state).toBe('backlog');
    expect(state.stories.filter(value => value.state === 'assigned')).toHaveLength(1);

    adapter.complete(foundation.executionId!);
    registry.heartbeat({ workerId: 'worker', at: now().toISOString(), availableSlots: 1 });
    await engine.tick(planned.id);
    state = await engine.state();
    expect(state.stories.find(value => value.id === 'foundation')?.state).toBe('done');
    const assignedDependent = state.stories.find(value => value.id === 'dependent')!;
    expect(assignedDependent.state).toBe('assigned');

    await engine.updateProgress('dependent', 55, 'Implementation is halfway complete.');
    expect((await engine.dailyScrum(planned.id)).inProgress).toContain('dependent (55%)');
    adapter.complete(assignedDependent.executionId!);
    registry.heartbeat({ workerId: 'worker', at: now().toISOString(), availableSlots: 1 });
    await engine.tick(planned.id);

    const closed = await engine.closeSprint(planned.id);
    expect(closed.review).toMatchObject({ deliveredPoints: 4, plannedPoints: 4, incompleteStories: [] });
    expect(closed.retrospective.wentWell.join(' ')).toContain('full planned capacity');
  });

  it('rejects dependency cycles and escalates a persistent blocker once', async () => {
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const now = () => new Date(clock);
    const adapter = new SprintAdapter();
    const { coordinator } = workforce(adapter, now);
    const escalations: string[] = [];
    const engine = new AutonomousSprintEngine(
      new InMemorySprintStore(),
      coordinator,
      {
        async update() {},
        async escalate(value, message) { escalations.push(`${value.id}:${message}`); },
      },
      undefined,
      { repositoryRoot: '/workspace/repo', blockedEscalationMs: 1_000, now },
    );

    await expect(engine.planSprint({
      name: 'Cycle', goal: 'invalid', endsAt: '2026-07-27T00:00:00.000Z', capacityPoints: 10, wipLimit: 1,
      backlog: [story('a', ['b']), story('b', ['a'])],
    })).rejects.toThrow('Dependency cycle');

    const planned = await engine.planSprint({
      name: 'Blocker', goal: 'escalate', endsAt: '2026-07-27T00:00:00.000Z', capacityPoints: 2, wipLimit: 1,
      backlog: [story('foundation')],
    });
    await engine.startSprint(planned.id);
    await engine.blockStory('foundation', 'External API unavailable');
    clock += 1_001;
    await engine.tick(planned.id);
    await engine.tick(planned.id);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toContain('External API unavailable');
  });
});
