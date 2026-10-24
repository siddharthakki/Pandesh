import { describe, expect, it } from 'vitest';
import {
  M19AgentRoster,
  M19AgentWorkforceRouter,
  M19WorkforceAuditEvidence,
  M19_WORKFORCE_STAGES,
  stageFromRequestId,
} from '../../workforce/M19AgentWorkforce';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GovernedModelRequest,
} from '../../agent/GovernedModelExecutionTypes';

function roster(overrides: Partial<Record<keyof M19AgentRoster, Partial<M19AgentRoster[keyof M19AgentRoster]>>> = {}): M19AgentRoster {
  const base: M19AgentRoster = {
    'repository-analyst': {
      agentId: 'm19.repository-analyst',
      role: 'repository-analyst',
      primaryModel: 'analysis-model',
      fallbackModel: 'fallback-model',
      providerType: 'ollama',
    },
    planner: {
      agentId: 'm19.planner',
      role: 'planner',
      primaryModel: 'planning-model',
      fallbackModel: 'fallback-model',
      providerType: 'ollama',
    },
    implementer: {
      agentId: 'm19.implementer',
      role: 'implementer',
      primaryModel: 'coding-model',
      fallbackModel: 'fallback-model',
      providerType: 'ollama',
    },
    reviewer: {
      agentId: 'm19.reviewer',
      role: 'reviewer',
      primaryModel: 'review-model',
      fallbackModel: 'fallback-model',
      providerType: 'ollama',
    },
    validator: {
      agentId: 'm19.validator',
      role: 'validator',
      primaryModel: 'validation-model',
      fallbackModel: 'fallback-model',
      providerType: 'ollama',
    },
  };
  for (const stage of M19_WORKFORCE_STAGES) {
    base[stage] = { ...base[stage], ...(overrides[stage] ?? {}) } as M19AgentRoster[typeof stage];
  }
  return base;
}

function request(stage: string): GovernedModelRequest {
  return {
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId: `fixed-multi-agent:invocation:${stage}`,
    invocationId: 'invocation',
    taskId: 'task',
    model: 'request-default-model',
    providerType: 'openai-compatible',
    prompt: `prompt for ${stage}`,
    audit: { source: 'test', metadata: { retained: true } },
  };
}

function workforceEvidence(value: GovernedModelRequest): M19WorkforceAuditEvidence {
  return value.audit?.metadata?.m19Workforce as M19WorkforceAuditEvidence;
}

describe('M19AgentWorkforceRouter', () => {
  it('routes every fixed graph stage to its named role-specific model', () => {
    const router = new M19AgentWorkforceRouter(roster());
    const expectedModels = [
      'analysis-model',
      'planning-model',
      'coding-model',
      'review-model',
      'validation-model',
    ];

    for (const [index, stage] of M19_WORKFORCE_STAGES.entries()) {
      const governedRequest = request(stage);
      const assignment = router.prepare(governedRequest);

      expect(assignment).toMatchObject({
        stage,
        role: stage,
        agentId: `m19.${stage}`,
        model: expectedModels[index],
        providerType: 'ollama',
        routingReason: 'role_primary',
      });
      expect(governedRequest.model).toBe(expectedModels[index]);
      expect(governedRequest.providerType).toBe('ollama');
      expect(governedRequest.audit?.metadata?.retained).toBe(true);
      expect(workforceEvidence(governedRequest).assignment).toEqual(assignment);

      router.complete(assignment, `private output from ${stage}`);
    }
  });

  it('records content-free, sequential handoff evidence', () => {
    const router = new M19AgentWorkforceRouter(roster());
    const analystRequest = request('repository-analyst');
    const analyst = router.prepare(analystRequest);
    const privateOutput = 'PRIVATE_REPOSITORY_ANALYSIS_CONTENT';
    router.complete(analyst, privateOutput);

    const plannerRequest = request('planner');
    const planner = router.prepare(plannerRequest);
    const evidence = workforceEvidence(plannerRequest);

    expect(evidence.handoff).toMatchObject({
      fromStage: 'repository-analyst',
      fromAgentId: 'm19.repository-analyst',
      toStage: 'planner',
      toAgentId: 'm19.planner',
      payloadBytes: Buffer.byteLength(privateOutput, 'utf8'),
    });
    expect(evidence.handoff?.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain(privateOutput);
    router.complete(planner, 'planner output');
  });

  it('uses the configured fallback when a role primary is blank', () => {
    const router = new M19AgentWorkforceRouter(roster({
      reviewer: { primaryModel: '   ', fallbackModel: 'review-fallback' },
    }));
    const governedRequest = request('reviewer');

    const assignment = router.prepare(governedRequest);

    expect(assignment).toMatchObject({
      stage: 'reviewer',
      model: 'review-fallback',
      routingReason: 'configured_fallback',
      fallbackFrom: '   ',
    });
    expect(governedRequest.model).toBe('review-fallback');
  });

  it('routes validator repair calls back to the validator worker', () => {
    expect(stageFromRequestId('fixed-multi-agent:invocation:validator-repair')).toBe('validator');
    const router = new M19AgentWorkforceRouter(roster());
    const governedRequest = request('validator-repair');

    expect(router.prepare(governedRequest)).toMatchObject({
      stage: 'validator',
      agentId: 'm19.validator',
      model: 'validation-model',
    });
  });

  it('ignores governed model calls outside the fixed workforce graph', () => {
    const router = new M19AgentWorkforceRouter(roster());
    const governedRequest = request('unrelated-call');

    expect(router.prepare(governedRequest)).toBeUndefined();
    expect(governedRequest.model).toBe('request-default-model');
    expect(governedRequest.audit?.metadata?.m19Workforce).toBeUndefined();
  });
});
