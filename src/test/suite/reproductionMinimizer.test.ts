import { describe, expect, it } from 'vitest';
import { ReproductionMinimizer } from '../../reliability/ReproductionMinimizer';

describe('failure reproduction minimizer', () => {
  it('reduces inputs while preserving the observed failure', async () => {
    const result = await new ReproductionMinimizer().minimize(
      [1, 2, 3, 4],
      { reproduces: async values => values.includes(3) },
    );

    expect(result.reproduced).toBe(true);
    expect(result.minimized).toEqual([3]);
    expect(result.probes).toBeGreaterThan(1);
  });
});
