import { describe, expect, it } from 'vitest';
import { ImprovementRegistry } from '../../evals/ImprovementRegistry';

describe('reviewed improvement registry', () => {
  it('requires approval before implementation', () => {
    const registry = new ImprovementRegistry();
    const proposal = registry.propose({
      title: 'Improve routing',
      target: 'routing',
      description: 'Use benchmark evidence for model selection.',
      evidenceRunIds: ['run-one'],
      expectedMetricChanges: { taskSuccessRate: 0.05 },
    });

    expect(() => registry.markImplemented(proposal.id)).toThrow(/approved/i);
    registry.review(proposal.id, 'approved', 'reviewer');
    expect(registry.markImplemented(proposal.id).status).toBe('implemented');
  });
});
