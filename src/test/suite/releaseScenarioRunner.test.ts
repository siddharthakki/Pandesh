import { describe, expect, it } from 'vitest';
import { ReleaseScenarioRunner, orderScenarios } from '../../e2e/ReleaseScenarioRunner';

describe('Phase 23 release scenario runner', () => {
  it('orders dependencies and skips dependants after failure', async () => {
    const execution: string[] = [];
    const report = await new ReleaseScenarioRunner().run([
      {
        id: 'second', description: 'second', required: true, timeoutMs: 1000, dependencies: ['first'],
        run: async () => { execution.push('second'); },
      },
      {
        id: 'first', description: 'first', required: true, timeoutMs: 1000,
        run: async () => { execution.push('first'); throw new Error('failed'); },
      },
    ]);

    expect(execution).toEqual(['first']);
    expect(report.passed).toBe(false);
    expect(report.results.map(result => result.status)).toEqual(['failed', 'skipped']);
  });

  it('enforces timeout and always runs cleanup', async () => {
    let cleaned = false;
    const report = await new ReleaseScenarioRunner().run([{
      id: 'timeout', description: 'timeout', required: true, timeoutMs: 100,
      run: async () => new Promise<void>(() => undefined),
      cleanup: async () => { cleaned = true; },
    }]);

    expect(report.results[0].status).toBe('cancelled');
    expect(report.results[0].error).toMatch(/timed out/i);
    expect(cleaned).toBe(true);
  });

  it('rejects dependency cycles before execution', () => {
    expect(() => orderScenarios([
      { id: 'a', description: 'a', required: true, timeoutMs: 1000, dependencies: ['b'], run: async () => undefined },
      { id: 'b', description: 'b', required: true, timeoutMs: 1000, dependencies: ['a'], run: async () => undefined },
    ])).toThrow(/cycle/i);
  });
});
