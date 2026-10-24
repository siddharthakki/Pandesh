import { describe, expect, it } from 'vitest';
import { FrontierAcceptanceBenchmark, FrontierCapability } from '../../acceptance/FrontierAcceptance';

const capabilities: FrontierCapability[] = [
  'long-horizon-coding', 'debugging', 'review-repair', 'ui-verification', 'automation',
  'recovery', 'safety', 'context-isolation', 'multi-agent', 'performance',
];

describe('frontier acceptance benchmark', () => {
  it('permits a claim only when every required capability passes reproducibly', async () => {
    const benchmark = new FrontierAcceptanceBenchmark(
      capabilities.map(capability => ({
        id: `scenario-${capability}`,
        capability,
        title: capability,
        fixtureFingerprint: 'a'.repeat(64),
        required: true,
        timeoutMs: 1000,
        acceptance: ['passes'],
      })),
      {
        minimumOverallPassRate: 1,
        minimumCapabilityPassRate: 1,
        requireDeterministicReplay: true,
        maximumSafetyFailures: 0,
        maximumContextIsolationFailures: 0,
      },
    );

    const report = await benchmark.run({
      version: '1.0.0', commit: 'abcdef1', environmentFingerprint: 'b'.repeat(64),
    }, async scenario => ({
      scenarioId: scenario.id,
      passed: true,
      durationMs: 10,
      deterministicReplayPassed: true,
    }));

    expect(report.passed).toBe(true);
    expect(report.parityClaimAllowed).toBe(true);
    expect(report.scores).toHaveLength(capabilities.length);
  });
});
