import { describe, expect, it } from 'vitest';
import { routeStage, StageRoutingDecision } from '../../coding/StageRouting';

describe('StageRouting — Phase 6 explicit stage routing', () => {
  it('routes to the deterministic host when no preferred candidate is configured', () => {
    const decision = routeStage({ stage: 'reviewer' });
    expect(decision.stage).toBe('reviewer');
    expect(decision.provider).toBe('host');
    expect(decision.model).toBe('deterministic');
    expect(decision.routingReason).toBe('no_model_candidate_configured');
    expect(decision.fallbackReason).toBe('no_model_candidate_configured');
    expect(typeof decision.decidedAt).toBe('string');
    expect(Number.isNaN(Date.parse(decision.decidedAt))).toBe(false);
  });

  it('routes to the deterministic host when the preferred candidate is marked unavailable, recording which candidate was skipped', () => {
    const decision = routeStage({
      stage: 'reviewer',
      preferred: { provider: 'ollama', model: 'qwen2.5-coder', available: false },
    });
    expect(decision.provider).toBe('host');
    expect(decision.model).toBe('deterministic');
    expect(decision.routingReason).toBe('preferred_candidate_unavailable');
    expect(decision.fallbackReason).toBe('preferred_candidate_unavailable:ollama/qwen2.5-coder');
  });

  it('routes to the preferred model candidate when available, with no fallback reason', () => {
    const decision = routeStage({
      stage: 'reviewer',
      preferred: { provider: 'ollama', model: 'qwen2.5-coder', available: true },
    });
    expect(decision.provider).toBe('ollama');
    expect(decision.model).toBe('qwen2.5-coder');
    expect(decision.routingReason).toBe('preferred_candidate_available');
    expect(decision.fallbackReason).toBeUndefined();
  });

  it('honors a custom deterministic host identity for stages other than the default host', () => {
    const decision = routeStage({
      stage: 'validator',
      deterministicHost: { provider: 'host', model: 'deterministic-validator' },
    });
    expect(decision.provider).toBe('host');
    expect(decision.model).toBe('deterministic-validator');
  });

  it('produces a decision shape stable enough to persist verbatim on the task record', () => {
    const decision: StageRoutingDecision = routeStage({ stage: 'planner' });
    const roundTripped = JSON.parse(JSON.stringify(decision)) as StageRoutingDecision;
    expect(roundTripped).toEqual(decision);
  });
});
