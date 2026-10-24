import { describe, expect, it } from 'vitest';
import {
  analyzeFailureOutput,
  assessProgress,
  buildFailureFingerprint,
  compareFailures,
  computePatchDelta,
  derivePatchFootprint,
  type FailureFingerprint,
  type PatchDelta,
} from '../../autonomy/FailureFingerprint';

const VITEST_OUTPUT = [
  ' FAIL  src/total.test.ts > sums the items',
  'AssertionError: expected 5 to be 6 // Object.is equality',
  ' ❯ src/total.test.ts:12:34',
  ' Test Files  1 failed (1)',
  '      Tests  1 failed | 3 passed (4)',
  '   Duration  1.32s',
].join('\n');

/** Same failure as above, printed differently: colours, another machine's paths, other timings, more frames. */
const VITEST_REFORMATTED = [
  '\x1b[31m FAIL \x1b[0m  src/total.test.ts > sums the items',
  '\x1b[31mAssertionError\x1b[0m:   expected 5 to be 6   // Object.is equality',
  ` ❯ C:/Users/other/work/shop/src/total.test.ts:44:9`,
  '   at Object.<anonymous> (node_modules/vitest/dist/runner.js:99:1)',
  '   Test Files  1 failed (1)',
  '        Tests  1 failed | 3 passed (4)',
  '     Duration  9.87s',
].join('\n');

function fp(output: string, extra: Partial<Parameters<typeof buildFailureFingerprint>[0]> = {}): FailureFingerprint {
  return buildFailureFingerprint({ semantics: [analyzeFailureOutput(output, ['src/total.ts'])], evidence: 'ev-1', ...extra });
}

function delta(path: string, before: string, after: string): PatchDelta {
  return computePatchDelta({ path, op: 'replace', before, content: after });
}

const BASE = ['export function calculateTotal(items: number[]): number {', '  return items.length;', '}'].join('\n');
const PATCH_A = ['export function calculateTotal(items: number[]): number {', '  return items.reduce((a, b) => a + b, 0);', '}'].join('\n');
const PATCH_A_REWRITTEN = ['export function calculateTotal(items: number[]): number {', '  let sum = 0;', '  for (const n of items) sum += n;', '  return sum;', '}'].join('\n');

describe('M46 failure output analysis', () => {
  it('extracts failing tests, error classes and files', () => {
    const s = analyzeFailureOutput(VITEST_OUTPUT, ['src/total.ts']);
    expect(s.tests).toEqual(['sums the items']);
    expect(s.errorClasses).toEqual(expect.arrayContaining(['AssertionError', 'assertion']));
    expect(s.files).toEqual(['src/total.ts']);
  });

  it('gives a semantically identical failure the same identity despite different formatting', () => {
    const a = fp(VITEST_OUTPUT);
    const b = fp(VITEST_REFORMATTED);
    expect(b.messageKey).toBe(a.messageKey);
    expect(b.key).toBe(a.key);
    expect(b.tests).toEqual(a.tests);
  });

  it('is independent of the order failing tests are printed in', () => {
    const one = analyzeFailureOutput(' FAIL  a.test.ts > alpha\n FAIL  a.test.ts > beta\nError: boom');
    const two = analyzeFailureOutput(' FAIL  a.test.ts > beta\n FAIL  a.test.ts > alpha\nError: boom');
    expect(two).toEqual(one);
    expect(one.tests).toEqual(['alpha', 'beta']);
  });

  it('reads node:test output and does not mistake its headings for test names', () => {
    const output = [
      '✖ failing tests:',
      '',
      '✖ a 10% discount is applied before tax (1.2ms)',
      '  ReferenceError: roundToCcents is not defined',
      '      at applyDiscount (src/pricing.js:12:10)',
      'ℹ tests 3',
      'ℹ fail 1',
    ].join('\n');
    const s = analyzeFailureOutput(output);
    expect(s.tests).toEqual(['a 10% discount is applied before tax']);
    expect(s.errorClasses).toEqual(['ReferenceError']);
  });

  it('gives a different message a different identity even for the same test', () => {
    const a = fp(VITEST_OUTPUT);
    const b = fp(VITEST_OUTPUT.replace('expected 5 to be 6', 'expected 4 to be 6'));
    expect(b.tests).toEqual(a.tests);
    expect(b.messageKey).not.toBe(a.messageKey);
    expect(b.key).not.toBe(a.key);
  });

  it('understands compiler and runtime failures that have no test names', () => {
    const s = analyzeFailureOutput("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\nENOENT: no such file", []);
    expect(s.tests).toEqual([]);
    expect(s.errorClasses).toEqual(expect.arrayContaining(['TS2322', 'ENOENT']));
  });
});

describe('M46 patch footprints', () => {
  it('records only the changed region relative to the previous content', () => {
    const d = delta('src/total.ts', BASE, PATCH_A);
    expect(d.newRange).toEqual([2, 2]);
    expect(d.oldRange).toEqual([2, 2]);
    expect(d.changedLines).toBe(1);
    expect(d.broad).toBe(false);
  });

  it('calls a change that edits the region the previous change wrote a rework of it', () => {
    const first = [delta('src/total.ts', BASE, PATCH_A)];
    const second = [delta('src/total.ts', PATCH_A, PATCH_A_REWRITTEN)];
    expect(derivePatchFootprint(second, first)?.family).toBe('rework');
  });

  it('calls an identical result identical, and an edit somewhere else different', () => {
    const big = Array.from({ length: 120 }, (_, i) => `const v${i} = ${i};`);
    const first = [delta('src/big.ts', big.join('\n'), [...big.slice(0, 10), 'const v10 = 999;', ...big.slice(11)].join('\n'))];
    const afterFirst = [...big.slice(0, 10), 'const v10 = 999;', ...big.slice(11)];
    const elsewhere = [delta('src/big.ts', afterFirst.join('\n'), [...afterFirst.slice(0, 100), 'const v100 = "zzz-different-tokens";', ...afterFirst.slice(101)].join('\n'))];
    expect(derivePatchFootprint(elsewhere, first)?.family).toBe('different');
    expect(derivePatchFootprint(first, first)?.family).toBe('identical');
    expect(derivePatchFootprint(first)?.family).toBe('first');
    expect(derivePatchFootprint([])).toBeUndefined();
  });

  it('treats a different set of files as a different approach', () => {
    const first = [delta('src/total.ts', BASE, PATCH_A)];
    const second = [delta('src/other.ts', 'x', 'y')];
    expect(derivePatchFootprint(second, first)?.family).toBe('different');
  });
});

describe('M46 progress assessment', () => {
  const failing = (extra: Partial<Parameters<typeof buildFailureFingerprint>[0]> = {}) => fp(VITEST_OUTPUT, extra);
  const twoTests = (extra: Partial<Parameters<typeof buildFailureFingerprint>[0]> = {}) =>
    buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > alpha\n FAIL  t.test.ts > beta\nError: boom')], evidence: 'ev-1', ...extra });

  it('identical failure with nothing new is no_new_evidence', () => {
    const a = assessProgress([failing(), failing()])!;
    expect(a.verdict).toBe('no_new_evidence');
    expect(a.streak).toBe(1);
    expect(a.sameHypothesisStreak).toBe(1);
  });

  it('a first failure is a new failure', () => {
    expect(assessProgress([failing()])!.verdict).toBe('new_failure');
    expect(assessProgress([])).toBeUndefined();
  });

  it('the same failure after a reworked patch is the same hypothesis and the streak grows', () => {
    const p1 = derivePatchFootprint([delta('src/total.ts', BASE, PATCH_A)]);
    const p2 = derivePatchFootprint([delta('src/total.ts', PATCH_A, PATCH_A_REWRITTEN)], [delta('src/total.ts', BASE, PATCH_A)]);
    const p3 = derivePatchFootprint([delta('src/total.ts', PATCH_A_REWRITTEN, PATCH_A)], [delta('src/total.ts', PATCH_A, PATCH_A_REWRITTEN)]);
    const history = [failing({ patch: p1 }), failing({ patch: p2, evidence: 'ev-2' }), failing({ patch: p3, evidence: 'ev-3' })];
    const a = assessProgress(history)!;
    expect(a.verdict).toBe('same_failure_same_patch_family');
    expect(a.sameHypothesisStreak).toBe(2);
    expect(a.streak).toBe(2);
  });

  it('the same failure after a genuinely different patch is not counted as the same hypothesis', () => {
    const p1 = derivePatchFootprint([delta('src/total.ts', BASE, PATCH_A)]);
    const p2 = derivePatchFootprint([delta('src/other.ts', 'a', 'b')], [delta('src/total.ts', BASE, PATCH_A)]);
    const a = assessProgress([failing({ patch: p1 }), failing({ patch: p2, evidence: 'ev-2' })])!;
    expect(a.verdict).toBe('same_failure_different_patch');
    expect(a.sameHypothesisStreak).toBe(0);
    expect(a.streak).toBe(1);
  });

  it('fewer failing tests is improvement, and resets the streak', () => {
    const one = buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > alpha\nError: boom')], evidence: 'ev-1' });
    const a = assessProgress([twoTests(), one])!;
    expect(a.verdict).toBe('validation_improved');
    expect(a.streak).toBe(0);
    expect(a.bestFailingCount).toBe(1);
  });

  it('new failures alongside the old ones are a regression; only new ones are a new failure', () => {
    const before = buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > alpha\nError: boom')] });
    const alongside = buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > alpha\n FAIL  t.test.ts > gamma\nError: boom')] });
    const different = buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > gamma\nError: boom')] });
    expect(compareFailures(before, alongside)).toBe('regression');
    expect(compareFailures(before, different)).toBe('new_failure');
  });

  it('a new error after progress starts a fresh streak', () => {
    const improved = buildFailureFingerprint({ semantics: [analyzeFailureOutput(' FAIL  t.test.ts > alpha\nError: boom')], evidence: 'e1' });
    const other = buildFailureFingerprint({ semantics: [analyzeFailureOutput("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.")], evidence: 'e2' });
    const a = assessProgress([twoTests(), improved, other])!;
    expect(a.verdict).toBe('new_failure');
    expect(a.streak).toBe(0);
  });

  it('survives a restart: a JSON round trip of the history gives the same assessment', () => {
    const p1 = derivePatchFootprint([delta('src/total.ts', BASE, PATCH_A)]);
    const p2 = derivePatchFootprint([delta('src/total.ts', PATCH_A, PATCH_A_REWRITTEN)], [delta('src/total.ts', BASE, PATCH_A)]);
    const history = [failing({ patch: p1 }), failing({ patch: p2, evidence: 'ev-2' })];
    const restored = JSON.parse(JSON.stringify(history)) as FailureFingerprint[];
    expect(assessProgress(restored)).toEqual(assessProgress(history));
  });

  it('non-test failures compare by error class, message and files', () => {
    const a = buildFailureFingerprint({ semantics: [], subcode: 'validation_repair_unavailable', failureHash: 'abc', evidence: 'e' });
    const b = buildFailureFingerprint({ semantics: [], subcode: 'validation_repair_unavailable', failureHash: 'abc', evidence: 'e' });
    const c = buildFailureFingerprint({ semantics: [], subcode: 'stale_snapshot', failureHash: 'zzz', evidence: 'e' });
    expect(compareFailures(a, b)).toBe('no_new_evidence');
    expect(compareFailures(a, c)).toBe('new_failure');
  });
});
