import { describe, expect, it } from 'vitest';
import { AgentTeamCoordinator } from '../../teams/AgentTeamCoordinator';
import { AdaptivePlanner } from '../../planning/AdaptivePlanner';

function agent(id: string, contextId: string, writablePaths: string[]) {
  return {
    id,
    role: 'specialist',
    model: 'local-model',
    contextId,
    capabilities: ['analysis', 'write'],
    budget: { maxModelCalls: 10, maxToolCalls: 20, maxWallClockMs: 10_000, maxOutputBytes: 10_000 },
    permissions: { readablePaths: ['src'], writablePaths, allowedTools: ['read_file', 'write_file'], networkAllowed: false },
  };
}

describe('Phase 27 isolated teams and adaptive planning', () => {
  it('runs disjoint tasks with distinct agent contexts', async () => {
    const team = new AgentTeamCoordinator();
    team.registerAgent(agent('alpha', 'context-alpha', ['src/a']));
    team.registerAgent(agent('beta', 'context-beta', ['src/b']));
    team.proposeTasks([
      { id: 'task-a', goal: 'change a', requiredCapabilities: ['write'], writePaths: ['src/a'], preferredAgentId: 'alpha' },
      { id: 'task-b', goal: 'change b', requiredCapabilities: ['write'], writePaths: ['src/b'], preferredAgentId: 'beta' },
    ]);
    const contexts: string[] = [];
    const result = await team.run(async context => {
      contexts.push(context.agent.contextId);
      return { task: context.task.id };
    });

    expect(result.tasks.every(task => task.status === 'completed')).toBe(true);
    expect(new Set(contexts)).toEqual(new Set(['context-alpha', 'context-beta']));
    expect(result.deadlockDetected).toBe(false);
  });

  it('rejects parallel tasks with overlapping write ownership', () => {
    const team = new AgentTeamCoordinator();
    team.registerAgent(agent('alpha', 'context-alpha', ['src']));
    team.registerAgent(agent('beta', 'context-beta', ['src']));

    expect(() => team.proposeTasks([
      { id: 'first', goal: 'first', writePaths: ['src/shared'] },
      { id: 'second', goal: 'second', writePaths: ['src/shared/file.ts'] },
    ])).toThrow(/overlap/i);
  });

  it('blocks an invalidated plan and requires approval for a revision', () => {
    const planner = new AdaptivePlanner();
    planner.create({
      planId: 'plan-one',
      taskId: 'task-one',
      goal: 'repair feature',
      assumptions: [{ id: 'assumption-one', statement: 'parser owns behavior', confidence: 0.8, status: 'unverified', evidenceIds: [] }],
      hypotheses: [],
      steps: [{
        id: 'inspect', goal: 'inspect parser', dependencies: [], status: 'pending', confidence: 0.8,
        evidenceRequired: [], stopConditions: [], allowedPaths: ['src/parser'], scope: 'investigation',
      }],
    });
    planner.approve();
    planner.start();
    planner.recordEvidence({
      id: 'evidence-one', kind: 'test', summary: 'behavior is elsewhere', invalidates: ['assumption-one'],
    });

    expect(planner.needsReplan()).toBe(true);
    const revision = planner.proposeRevision({
      reason: 'Evidence changed the ownership hypothesis.',
      steps: [{
        id: 'inspect-service', goal: 'inspect service', dependencies: [], status: 'pending', confidence: 0.7,
        evidenceRequired: [], stopConditions: [], allowedPaths: ['src/service'], scope: 'implementation',
      }],
    });
    expect(revision.approvalRequired).toBe(true);
    expect(revision.materialScopeExpansion).toBe(true);
    expect(revision.plan.revision).toBe(2);
  });
});
