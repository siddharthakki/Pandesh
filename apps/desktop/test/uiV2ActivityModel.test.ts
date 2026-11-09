import { describe, it, expect } from 'vitest';
import { groupActivities } from '../renderer-v2/src/boardModel';
import { parseTestSummary, sanitizeToolActivity } from '../../../core/shared/toolActivity';

const step = (id: string, capability: string, state = 'completed') => ({ id, capability, state });

describe('UI v2 activity grouping', () => {
  it('folds 3+ consecutive steps of the same kind and keeps short runs as rows', () => {
    const g = groupActivities([step('1', 'read_file'), step('2', 'read_file'), step('3', 'read_file'), step('4', 'run_checks'), step('5', 'read_file'), step('6', 'read_file')]);
    expect(g.map((x) => [x.key, x.items.length])).toEqual([['read_file', 3], ['run_checks', 1], ['read_file', 1], ['read_file', 1]]);
  });
});

describe('command facts', () => {
  it('reads the counts the runner printed and nothing else', () => {
    expect(parseTestSummary(' Test Files  82 passed (82)\n      Tests  605 passed (605)\n')).toMatchObject({ passed: 605, total: 605 });
    expect(parseTestSummary('Tests:       1 failed, 2 passed, 3 total')).toMatchObject({ passed: 2, failed: 1, total: 3 });
    expect(parseTestSummary('===== 3 passed, 1 failed, 2 skipped in 0.12s =====')).toMatchObject({ passed: 3, failed: 1, skipped: 2 });
    expect(parseTestSummary('Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12')).toMatchObject({ passed: 12, failed: 0, total: 12 });
    expect(parseTestSummary('ok 1 - add\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# skipped 0\n# duration_ms 41.2')).toMatchObject({ passed: 1, failed: 0, skipped: 0, total: 1 });
    expect(parseTestSummary('PASS\n✔ calc.test.js (50.6ms)\nℹ tests 1\nℹ suites 0\nℹ pass 1\nℹ fail 0\nℹ skipped 0\nℹ duration_ms 56.6')).toMatchObject({ passed: 1, failed: 0, total: 1 });
    expect(parseTestSummary('build ok, no tests here')).toBeUndefined();
  });

  it('keeps exit code, duration and tests through the sanitizer and drops junk', () => {
    const a = sanitizeToolActivity({ kind: 'code', command: 'npm test', exitCode: 1, timedOut: false, durationMs: 4210.6, tests: { passed: 2, failed: 1, line: 'Tests: 1 failed, 2 passed' } });
    expect(a).toMatchObject({ command: 'npm test', exitCode: 1, timedOut: false, durationMs: 4211, tests: { passed: 2, failed: 1 } });
    const b = sanitizeToolActivity({ kind: 'code', exitCode: 'zero', durationMs: -5, tests: { passed: -1, line: 'x' } });
    expect(b?.exitCode).toBeUndefined();
    expect(b?.durationMs).toBeUndefined();
    expect(b?.tests?.passed).toBeUndefined();
  });
});
