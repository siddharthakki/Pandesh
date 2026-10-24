import { describe, expect, it } from 'vitest';
import {
  compileContextPack,
  type ContextPackInput,
  type PackEvidence,
  type RepoCandidate,
} from '../../autonomy/ContextCompiler';
import { deriveExecutionEconomy } from '../../autonomy/ExecutionEconomyProfile';

const files = new Map<string, string>();
const readFile = async (p: string) => files.get(p);

function big(name: string, lines: number): string {
  const out = [`export function ${name}(x: number): number {`];
  for (let i = 0; i < lines; i += 1) out.push(`  const step${i} = x + ${i}; // filler line ${i} of ${name}`);
  out.push('  return x;', '}');
  return out.join('\n');
}

function profileFor(tokens: number) {
  return deriveExecutionEconomy({ contextWindow: { contextTokens: tokens, source: 'router_metadata' } });
}

function base(tokens: number, overrides: Partial<ContextPackInput> = {}): ContextPackInput {
  const profile = profileFor(tokens);
  return {
    taskId: 'task-1',
    taskType: 'repair',
    objective: 'Fix calculate_total so the two failing tests pass.',
    policy: profile.pack,
    tier: profile.tier,
    readFile,
    ...overrides,
  };
}

const candidate = (path: string, score: number, extra: Partial<RepoCandidate> = {}): RepoCandidate => ({
  path, score, reasons: ['test'], ...extra,
});

describe('M46 Context Compiler', () => {
  it('compiles a tiny repository into a small structured pack with the objective first', async () => {
    files.clear();
    files.set('src/total.ts', 'export const calculateTotal = (a: number[]) => a.reduce((s, n) => s + n);');
    const pack = await compileContextPack(base(32_768, {
      candidates: [candidate('src/total.ts', 90, { reasons: ['named in failing test'] })],
      validation: { status: 'failing', lines: ['total.test.ts: expected 6 received 5'] },
      constraints: ['Do not edit tests.'],
      capabilities: ['read_file', 'propose_text_edit'],
    }));
    expect(pack.text).toMatch(/^# Context Pack — task task-1/);
    expect(pack.text.indexOf('## Objective')).toBeLessThan(pack.text.indexOf('## Validation state'));
    expect(pack.text).toContain('### src/total.ts [full; named in failing test]');
    expect(pack.text).toContain('Do not edit tests.');
    expect(pack.chars).toBeLessThan(2_000);
    expect(pack.telemetry.selected.map(s => s.section)).toEqual(expect.arrayContaining(['objective', 'constraints', 'validation', 'files', 'capabilities']));
  });

  it('never exceeds the budget at 8k, 32k and 128k+ windows, and larger windows spend more', async () => {
    files.clear();
    const candidates: RepoCandidate[] = [];
    for (let i = 0; i < 40; i += 1) {
      files.set(`src/m${i}.ts`, big(`fn${i}`, 400));
      candidates.push(candidate(`src/m${i}.ts`, 100 - i, { size: files.get(`src/m${i}.ts`)!.length, summary: `module ${i}`, symbols: [`function fn${i}:1`] }));
    }
    const evidence: PackEvidence[] = Array.from({ length: 30 }, (_, i) => ({
      id: `obs-${i}`, kind: 'observation' as const, text: `observation ${i} `.repeat(60), order: i,
    }));
    const sizes: number[] = [];
    for (const tokens of [8_192, 32_768, 131_072, 524_288]) {
      const input = base(tokens, { candidates, evidence, architectureSummary: ['top dirs: src (40 files)'] });
      const pack = await compileContextPack(input);
      expect(pack.chars).toBeLessThanOrEqual(input.policy.maxChars);
      expect(pack.telemetry.budgetChars).toBe(input.policy.maxChars);
      expect(pack.telemetry.packChars).toBe(pack.chars);
      sizes.push(pack.chars);
    }
    expect(sizes[1]).toBeGreaterThan(sizes[0]);
    expect(sizes[2]).toBeGreaterThan(sizes[1]);
  });

  it('is byte-identical for equal input regardless of candidate/evidence input order', async () => {
    files.clear();
    files.set('a.ts', 'export const a = 1;');
    files.set('b.ts', 'export const b = 2;');
    const evidence: PackEvidence[] = [
      { id: 'o1', kind: 'observation', text: 'first', order: 1 },
      { id: 'o2', kind: 'observation', text: 'second', order: 2 },
    ];
    const one = await compileContextPack(base(32_768, { candidates: [candidate('a.ts', 50), candidate('b.ts', 50)], evidence }));
    const two = await compileContextPack(base(32_768, { candidates: [candidate('b.ts', 50), candidate('a.ts', 50)], evidence: [...evidence].reverse() }));
    expect(two.text).toBe(one.text);
    expect(two.packHash).toBe(one.packHash);
  });

  it('retains a file that is too large to include raw as a structural outline, and says so', async () => {
    files.clear();
    const huge = big('hugeFn', 3_000);
    files.set('src/huge.ts', huge);
    const pack = await compileContextPack(base(8_192, {
      candidates: [candidate('src/huge.ts', 95, { size: huge.length, summary: 'huge module - function hugeFn', symbols: ['function hugeFn:1'] })],
    }));
    expect(pack.text).toContain('### src/huge.ts [outline');
    expect(pack.text).toContain('function hugeFn:1');
    expect(pack.text).not.toContain('filler line 1500');
    expect(pack.telemetry.selected.find(s => s.id === 'src/huge.ts')?.form).toBe('outline');
  });

  it('uses a focused excerpt around the implicated symbol or lines when the file is large', async () => {
    files.clear();
    const lines = Array.from({ length: 800 }, (_, i) => `// filler ${i}`);
    lines[400] = 'export function calculateTotal(items: number[]): number {';
    lines[401] = '  return items.length;';
    lines[402] = '}';
    files.set('src/calc.ts', lines.join('\n'));
    const bySymbol = await compileContextPack(base(32_768, {
      candidates: [candidate('src/calc.ts', 90, { size: 20_000, focus: { symbols: ['calculateTotal'] } })],
    }));
    expect(bySymbol.text).toContain('[focused');
    expect(bySymbol.text).toContain('return items.length;');
    expect(bySymbol.text).not.toContain('// filler 10\n');
    const byLines = await compileContextPack(base(32_768, {
      candidates: [candidate('src/calc.ts', 90, { size: 20_000, focus: { lines: [[402, 402]] } })],
    }));
    expect(byLines.text).toContain('402: ');
  });

  it('reports rejected candidates with a reason instead of silently dropping them', async () => {
    files.clear();
    const candidates: RepoCandidate[] = [];
    for (let i = 0; i < 12; i += 1) {
      files.set(`src/f${i}.ts`, big(`f${i}`, 30));
      candidates.push(candidate(`src/f${i}.ts`, 80 - i));
    }
    candidates.push(candidate('src/missing.ts', 85));
    const pack = await compileContextPack(base(8_192, { candidates }));
    const reasons = new Set(pack.telemetry.rejected.map(r => r.reason));
    expect(reasons.has('file_limit') || reasons.has('budget') || reasons.has('section_cap')).toBe(true);
    expect(pack.telemetry.rejected.find(r => r.id === 'src/missing.ts')?.reason).toBe('unreadable');
    expect(pack.telemetry.candidates.length).toBeGreaterThanOrEqual(candidates.length);
    // Everything selected was a candidate or mandatory; nothing is both selected and rejected.
    const rejectedIds = new Set(pack.telemetry.rejected.map(r => r.id));
    for (const s of pack.telemetry.selected) expect(rejectedIds.has(s.id)).toBe(false);
  });

  it('prefers higher-value failures and drops duplicates', async () => {
    files.clear();
    const evidence: PackEvidence[] = [
      { id: 'f-old', kind: 'failure', text: 'TypeError: x is not a function', weight: 40, order: 1 },
      { id: 'f-dup', kind: 'failure', text: 'TypeError:  x is not a function', weight: 40, order: 2 },
      { id: 'f-new', kind: 'failure', text: 'AssertionError: expected 6 got 5', weight: 90, order: 3 },
    ];
    const pack = await compileContextPack(base(32_768, { evidence }));
    expect(pack.text.indexOf('AssertionError')).toBeLessThan(pack.text.indexOf('TypeError'));
    expect(pack.telemetry.rejected.filter(r => r.reason === 'duplicate')).toHaveLength(1);
  });

  it('always keeps the objective, even for a pathologically small budget, and stays inside it', async () => {
    files.clear();
    const pack = await compileContextPack({
      ...base(2_048),
      objective: 'Migrate the payments module. '.repeat(400),
      policy: { maxChars: 500, maxFiles: 1, maxSnippetChars: 200, maxObservations: 1, maxFailures: 1, recentInteractionChars: 50 },
      constraints: ['A'.repeat(300), 'B'.repeat(300)],
    });
    expect(pack.chars).toBeLessThanOrEqual(500);
    expect(pack.text).toContain('## Objective');
    expect(pack.text).toContain('Migrate the payments module.');
  });

  it('orders sections by task type: inspection favours architecture, diagnosis favours failures', async () => {
    files.clear();
    files.set('src/a.ts', 'export const a = 1;');
    const common = {
      architectureSummary: ['src: 1 file '.repeat(18)],
      evidence: [{ id: 'f1', kind: 'failure' as const, text: 'boom '.repeat(150), order: 1 }],
      candidates: [candidate('src/a.ts', 50)],
    };
    const tight = { maxChars: 1_700, maxFiles: 4, maxSnippetChars: 900, maxObservations: 4, maxFailures: 4, recentInteractionChars: 100 };
    const inspect = await compileContextPack({ ...base(8_192, common), taskType: 'inspect', policy: tight });
    const diagnose = await compileContextPack({ ...base(8_192, common), taskType: 'diagnose', policy: tight });
    expect(inspect.telemetry.selected.some(s => s.section === 'architecture')).toBe(true);
    expect(diagnose.telemetry.selected.some(s => s.section === 'failures')).toBe(true);
  });

  it('works with no repository at all: no candidates, no reader, an empty workspace', async () => {
    const pack = await compileContextPack({
      taskId: 't', taskType: 'inspect', objective: 'Explain this folder.',
      policy: profileFor(8_192).pack,
    });
    expect(pack.text).toContain('Explain this folder.');
    expect(pack.telemetry.selected).toHaveLength(1);
    expect(pack.telemetry.rejected).toHaveLength(0);
  });

  it('strips control characters and carries no timestamps or randomness', async () => {
    files.clear();
    files.set('x.ts', 'const a = 1;\u0000\u0007');
    const pack = await compileContextPack(base(32_768, { candidates: [candidate('x.ts', 10)] }));
    expect(pack.text).not.toMatch(/[\u0000-\u0008]/);
    expect(pack.packHash).toMatch(/^sha256:[0-9a-f]{32}$/);
  });

  it('records task and subgoal identity in the pack and its telemetry', async () => {
    files.clear();
    const pack = await compileContextPack(base(32_768, {
      subgoalId: 'sg-2',
      subgoal: { id: 'sg-2', objective: 'Read the failing test and total.ts. Do not edit yet.', successCondition: 'Cause identified', expectedValidation: 'npm test -- total' },
    }));
    expect(pack.subgoalId).toBe('sg-2');
    expect(pack.telemetry).toMatchObject({ taskId: 'task-1', subgoalId: 'sg-2', taskType: 'repair', tier: 'standard' });
    expect(pack.text).toContain('Done when: Cause identified');
  });
});
