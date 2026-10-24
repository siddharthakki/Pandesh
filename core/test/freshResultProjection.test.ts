/**
 * M45 corrective — fresh-tool-result admission. Pure projection behaviour:
 * fairness, representation, safety classification and honesty of the notice.
 */
import { describe, it, expect } from 'vitest';
import type { ModelChatMessage } from '../runtime/modelBackend';
import { canonicalArgumentJson } from '../runtime/repositoryPathRecovery';
import { deltaChars } from '../runtime/loopDeltaCompaction';
import { COMPACTED_RESULT_MARKER, projectFreshResults } from '../runtime/freshResultProjection';

const key = (name: string, args: Record<string, unknown>) => `${name}:${canonicalArgumentJson(args)}`;
const fileBody = (label: string, lines: number, width = 60) =>
  Array.from({ length: lines }, (_, i) => `${label} line ${i + 1} ${'x'.repeat(Math.max(0, width - 12))}`).join('\n');
const readResult = (label: string, lines: number, width?: number): ModelChatMessage =>
  ({ role: 'tool', content: `[read_file] exit=0\n${fileBody(label, lines, width)}` });

interface Batch { delta: ModelChatMessage[]; keys: Map<number, string> }

/** An older assistant turn, then one assistant turn whose results are the fresh batch. */
function batch(results: Array<{ message: ModelChatMessage; key?: string }>): Batch {
  const delta: ModelChatMessage[] = [{ role: 'assistant', content: 'Working.' }];
  const keys = new Map<number, string>();
  for (const { message, key: k } of results) {
    delta.push(message);
    if (k !== undefined) keys.set(delta.length - 1, k);
  }
  return { delta, keys };
}
const reads = (n: number, lines: number) => batch(Array.from({ length: n }, (_, i) => ({
  message: readResult(`f${i}`, lines), key: key('read_file', { path: `src/f${i}.ts` }),
})));

describe('projectFreshResults — the D3 shape', () => {
  it('eight fresh read-only calls (~37 KB) fit a ~29 KB budget with every call still represented', () => {
    // run_command output (kept whole) + seven 5 KB file reads ≈ 37 KB.
    const command: ModelChatMessage = { role: 'tool', content: `[run_command] exit=0\n${'c'.repeat(2_000)}` };
    const b = batch([
      { message: command },
      ...Array.from({ length: 7 }, (_, i) => ({ message: readResult(`f${i}`, 70, 75), key: key('read_file', { path: `src/f${i}.ts` }) })),
    ]);
    const before = deltaChars(b.delta);
    expect(before).toBeGreaterThan(36_000);

    const out = projectFreshResults({ delta: b.delta, budgetChars: 29_344, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.afterChars).toBeLessThanOrEqual(29_344);
    expect(out.freshChars).toBeGreaterThan(36_000);
    // The command result is untouched; the assistant text is untouched.
    expect(out.delta[1].content).toBe(command.content);
    expect(out.delta[0].content).toBe('Working.');
    // Every read is still present and identified, whether or not it needed trimming.
    for (let i = 0; i < 7; i += 1) {
      const text = out.delta[i + 2].content;
      expect(text.startsWith('[read_file] exit=0')).toBe(true);
      expect(text).toContain(`f${i} line 1 `);
    }
    expect(out.items.length).toBeGreaterThan(0);
  });
});

describe('projectFreshResults — admission', () => {
  it('leaves a batch within budget completely untouched', () => {
    const b = reads(3, 20);
    const out = projectFreshResults({ delta: b.delta, budgetChars: deltaChars(b.delta), toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.items).toHaveLength(0);
    expect(out.delta).toEqual(b.delta);
  });

  it('a batch only slightly over budget loses only what it must: small results stay verbatim', () => {
    const b = batch([
      { message: readResult('big', 200), key: key('read_file', { path: 'src/big.ts' }) },
      { message: readResult('tiny', 3), key: key('read_file', { path: 'src/tiny.ts' }) },
    ]);
    const budget = deltaChars(b.delta) - 300;
    const out = projectFreshResults({ delta: b.delta, budgetChars: budget, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].toolName).toBe('read_file');
    expect(out.delta[2].content).toBe(b.delta[2].content);
  });

  it('a batch genuinely over budget is compacted much harder and still fits', () => {
    const b = reads(8, 120);
    const before = deltaChars(b.delta);
    const budget = Math.floor(before * 0.25);
    const out = projectFreshResults({ delta: b.delta, budgetChars: budget, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.afterChars).toBeLessThanOrEqual(budget);
    expect(out.items).toHaveLength(8);
    for (const item of out.items) expect(item.projectedChars).toBeLessThan(item.originalChars);
  });

  it('one huge file does not erase seven small reads: the small ones stay whole, the huge one takes the cut', () => {
    const b = batch([
      { message: readResult('huge', 900, 80), key: key('read_file', { path: 'src/huge.ts' }) },
      ...Array.from({ length: 7 }, (_, i) => ({ message: readResult(`s${i}`, 12), key: key('read_file', { path: `src/s${i}.ts` }) })),
    ]);
    const smallTotal = b.delta.slice(2).reduce((sum, m) => sum + m.content.length, 0);
    const budget = smallTotal + 3_000;
    const out = projectFreshResults({ delta: b.delta, budgetChars: budget, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.items).toHaveLength(1);
    expect(out.items[0].index).toBe(1);
    expect(out.items[0].projectedChars).toBeGreaterThan(1_500);
    for (let i = 2; i <= 8; i += 1) expect(out.delta[i].content).toBe(b.delta[i].content);
  });

  it('when several results are big the allowance is shared fairly, not given to the first', () => {
    const b = reads(4, 300);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 8_000, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    const sizes = out.items.map((item) => item.projectedChars);
    expect(sizes).toHaveLength(4);
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(80);
  });

  it('fails closed, rewriting nothing, when even the minimum representations cannot fit', () => {
    const b = reads(8, 200);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 500, toolMessageKeys: b.keys });
    expect(out.fits).toBe(false);
    expect(out.reason).toBe('minimum_representation_does_not_fit');
    expect(out.delta).toEqual(b.delta);
    expect(out.items).toHaveLength(0);
  });

  it('falls back to header-only representations before giving up, and every call is still named', () => {
    const b = reads(8, 200);
    // Too small for 240 chars of text each, large enough for the notices alone.
    const out = projectFreshResults({ delta: b.delta, budgetChars: 8 * 420 + 20, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    for (let i = 0; i < 8; i += 1) expect(out.delta[i + 1].content).toContain(`src/f${i}.ts`);
  });
});

describe('projectFreshResults — what a projection says', () => {
  const one = () => {
    const b = batch([{ message: readResult('doc', 400, 80), key: key('read_file', { path: 'docs/big.md' }) }]);
    const out = projectFreshResults({
      delta: b.delta, budgetChars: 4_000, toolMessageKeys: b.keys, digestFor: () => 'ev-abc123',
    });
    return { b, out, text: out.delta[1].content };
  };

  it('keeps status, tool, path, original size, digest, retained text and an explicit omission', () => {
    const { b, out, text } = one();
    expect(out.fits).toBe(true);
    expect(text.startsWith('[read_file] exit=0\n')).toBe(true);
    expect(text).toContain(COMPACTED_RESULT_MARKER);
    expect(text).toContain('path="docs/big.md"');
    expect(text).toContain(`${b.delta[1].content.length.toLocaleString('en-US')} chars`);
    expect(text).toContain('digest ev-abc123');
    expect(text).toContain('doc line 1 ');
    expect(text).toContain('doc line 400 ');
    expect(text).toContain('NOT the complete result');
    expect(text).toContain('chars omitted');
    expect(out.items[0]).toMatchObject({ toolName: 'read_file', originalChars: b.delta[1].content.length });
  });

  it('tells the model how to recover: a targeted read_file range covering exactly the omitted lines', () => {
    const { text } = one();
    const gap = /… \[lines (\d+)-(\d+) omitted\] …/.exec(text)!;
    expect(gap).not.toBeNull();
    expect(text).toContain(`read_file path="docs/big.md" startLine=${gap[1]} endLine=${gap[2]}`);
    expect(text).toMatch(/shown lines 1-\d+ and \d+-400 of 400/);
    // The lines named as shown are the lines actually present.
    expect(text).toContain(`doc line ${Number(gap[1]) - 1} `);
    expect(text).not.toContain(`doc line ${gap[1]} `);
    expect(text).toContain(`doc line ${Number(gap[2]) + 1} `);
  });

  it('a range read keeps absolute line numbers and the file total', () => {
    const body = Array.from({ length: 300 }, (_, i) => `r line ${i + 101} ${'x'.repeat(60)}`).join('\n');
    const b = batch([{ message: { role: 'tool', content: `[read_file] exit=0\nLINES 101-400 of 900\n${body}` }, key: key('read_file', { path: 'a.ts', startLine: 101, endLine: 400 }) }]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 4_000, toolMessageKeys: b.keys });
    const text = out.delta[1].content;
    expect(text).toContain('LINES 101-400 of 900');
    expect(text).toMatch(/shown lines 101-\d+ and \d+-400 of 900/);
  });

  it('says so when the tool output was itself cut at its read limit', () => {
    const body = `${fileBody('c', 300, 80)}\n…[truncated]`;
    const b = batch([{ message: { role: 'tool', content: `[read_file] exit=0\n${body}` }, key: key('read_file', { path: 'c.ts' }) }]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 3_000, toolMessageKeys: b.keys });
    expect(out.delta[1].content).toContain('cut at its read limit');
  });

  it('a single very long line is kept by characters, never presented as whole', () => {
    const b = batch([{ message: { role: 'tool', content: `[read_file] exit=0\n${'m'.repeat(20_000)}` }, key: key('read_file', { path: 'min.js' }) }]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 2_000, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    const text = out.delta[1].content;
    expect(text).toContain('NOT the complete result');
    expect(text).toContain('chars');
    expect(text.length).toBeLessThanOrEqual(2_000);
  });

  it('preserves a path-correction line', () => {
    const correction = 'PATH_CORRECTION {"original":"a.ts","selected":"src/a.ts","automatic":true}';
    const b = batch([{ message: { role: 'tool', content: `[read_file] exit=0\n${correction}\n${fileBody('p', 300, 80)}` }, key: key('read_file', { path: 'src/a.ts' }) }]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 3_000, toolMessageKeys: b.keys });
    expect(out.delta[1].content).toContain(correction);
  });

  it('computes a digest of its own when Core has none', () => {
    const b = batch([{ message: readResult('d', 300, 80), key: key('read_file', { path: 'd.ts' }) }]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 3_000, toolMessageKeys: b.keys });
    expect(out.delta[1].content).toMatch(/digest sha256:[0-9a-f]{12}\]/);
  });
});

describe('projectFreshResults — what it must not touch', () => {
  const padding = () => readResult('pad', 300, 80);

  it('preserves an error result and a failed read verbatim, even when keyed and oversized', () => {
    const failure: ModelChatMessage = { role: 'tool', content: `[read_file] exit=n/a\nRepository path blocked: outside the workspace. ${'e'.repeat(3_000)}` };
    const b = batch([
      { message: failure, key: key('read_file', { path: '../secret' }) },
      { message: padding(), key: key('read_file', { path: 'src/pad.ts' }) },
    ]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 5_000, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.delta[1].content).toBe(failure.content);
    expect(out.items.map((item) => item.index)).toEqual([2]);
  });

  it('does not truncate a mutation / non-repeatable result: with no read-only key it is never compacted', () => {
    const mutation: ModelChatMessage = { role: 'tool', content: `[propose_file_change] exit=0\n${'m'.repeat(4_000)}` };
    const command: ModelChatMessage = { role: 'tool', content: `[run_command] exit=0\n${'o'.repeat(4_000)}` };
    const b = batch([
      { message: mutation }, { message: command },
      { message: padding(), key: key('read_file', { path: 'src/pad.ts' }) },
    ]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 11_000, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    expect(out.delta[1].content).toBe(mutation.content);
    expect(out.delta[2].content).toBe(command.content);
    // If the untouchable results alone overflow, it fails closed instead of trimming them.
    const tight = projectFreshResults({ delta: b.delta, budgetChars: 7_000, toolMessageKeys: b.keys });
    expect(tight.fits).toBe(false);
    expect(tight.delta[1].content).toBe(mutation.content);
  });

  it('never touches validation results, strategy/decision notes, denials, or an already cleared body', () => {
    const protectedNotes: ModelChatMessage[] = [
      { role: 'tool', content: `[validation] ${'v'.repeat(2_000)}` },
      { role: 'tool', content: `STRATEGY_CHANGE ${'s'.repeat(2_000)}` },
      { role: 'tool', content: `[read_file] DENIED by the read-only mutation policy ${'d'.repeat(2_000)}` },
      { role: 'tool', content: `[read_file] (result body cleared from active context — 9000 chars; evidence retained by Core.)` },
    ];
    const b = batch([
      ...protectedNotes.map((message, i) => ({ message, key: key('read_file', { path: `n${i}` }) })),
      { message: padding(), key: key('read_file', { path: 'src/pad.ts' }) },
    ]);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 8_500, toolMessageKeys: b.keys });
    expect(out.fits).toBe(true);
    protectedNotes.forEach((message, i) => expect(out.delta[i + 1].content).toBe(message.content));
  });

  it('never re-projects a projection', () => {
    const b = reads(4, 300);
    const first = projectFreshResults({ delta: b.delta, budgetChars: 8_000, toolMessageKeys: b.keys });
    const again = projectFreshResults({ delta: first.delta, budgetChars: 3_000, toolMessageKeys: b.keys });
    expect(again.items).toHaveLength(0);
    expect(again.reason).toBe('nothing_compactable');
  });

  it('only ever touches the newest batch: results before the last assistant message are left to old-result pruning', () => {
    const older = readResult('old', 300, 80);
    const delta: ModelChatMessage[] = [
      { role: 'assistant', content: 'earlier' }, older,
      { role: 'assistant', content: 'now' }, readResult('new', 300, 80),
    ];
    const keys = new Map([[1, key('read_file', { path: 'old.ts' })], [3, key('read_file', { path: 'new.ts' })]]);
    const out = projectFreshResults({ delta, budgetChars: deltaChars(delta) - 5_000, toolMessageKeys: keys });
    expect(out.delta[1].content).toBe(older.content);
    expect(out.items.map((item) => item.index)).toEqual([3]);
  });

  it('does not mutate its input, and keeps message count and order', () => {
    const b = reads(5, 200);
    const snapshot = JSON.stringify(b.delta);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 6_000, toolMessageKeys: b.keys });
    expect(JSON.stringify(b.delta)).toBe(snapshot);
    expect(out.delta).toHaveLength(b.delta.length);
    expect(out.delta.map((m) => m.role)).toEqual(b.delta.map((m) => m.role));
  });

  it('does nothing for a legacy checkpoint with no operation keys', () => {
    const b = reads(4, 300);
    const out = projectFreshResults({ delta: b.delta, budgetChars: 2_000, toolMessageKeys: new Map() });
    expect(out.fits).toBe(false);
    expect(out.reason).toBe('nothing_compactable');
  });
});
