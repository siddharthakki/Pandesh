import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_CONTENT_KEEP_CHARS,
  ASSISTANT_TRUNCATION_MARKER,
  CLEARED_BODY_MARKER,
  LOOP_DELTA_MIN_GAIN_RATIO,
  LOOP_DELTA_PROTECT_RATIO,
  LOOP_DELTA_TARGET_RATIO,
  clearedBodyStub,
  compactLoopDelta,
  compactionPayload,
  deltaChars,
  worthPruning,
  type LoopCompactionState,
} from '../runtime/loopDeltaCompaction';
import type { ModelChatMessage } from '../runtime/modelBackend';

const tool = (name: string, size: number): ModelChatMessage => ({ role: 'tool', content: `[${name}] exit=0\n${'x'.repeat(size)}` });
const assistant = (text: string): ModelChatMessage => ({ role: 'assistant', content: text });

/** Turns of [assistant, tool(read)], keyed by delta index → operation key. */
function turns(count: number, size: number) {
  const delta: ModelChatMessage[] = [];
  const keys = new Map<number, string>();
  for (let i = 0; i < count; i += 1) {
    delta.push(assistant(`Reading file ${i}.`));
    delta.push(tool('read_file', size));
    keys.set(delta.length - 1, `read_file:${i}`);
  }
  return { delta, keys };
}

describe('compactLoopDelta', () => {
  it('does nothing within budget unless forced', () => {
    const { delta, keys } = turns(3, 1000);
    const result = compactLoopDelta({ delta, budgetChars: 100_000, toolMessageKeys: keys });
    expect(result).toMatchObject({ clearedBodies: 0, truncatedAssistant: 0, fits: true });
    expect(result.delta).toEqual(delta);
    expect(result.beforeChars).toBe(result.afterChars);
  });

  it('clears oldest bodies first down to the 75% target and leaves the protected tail intact', () => {
    const { delta, keys } = turns(6, 4000);
    const budget = 20_000; // delta is ~24k
    const result = compactLoopDelta({ delta, budgetChars: budget, toolMessageKeys: keys });
    expect(result.fits).toBe(true);
    expect(result.afterChars).toBeLessThanOrEqual(budget * LOOP_DELTA_TARGET_RATIO);
    // Oldest first: cleared bodies are a prefix of the read results.
    const clearedIndexes = result.delta.flatMap((m, i) => (m.content.includes(CLEARED_BODY_MARKER) ? [i] : []));
    const readIndexes = [...keys.keys()];
    expect(clearedIndexes).toEqual(readIndexes.slice(0, clearedIndexes.length));
    expect(result.clearedKeys).toEqual(readIndexes.slice(0, clearedIndexes.length).map((i) => keys.get(i)));
    // Hysteresis: it stopped as soon as the target was met, not after clearing everything clearable.
    expect(clearedIndexes.length).toBeLessThan(readIndexes.length - 1);
    // The latest turn's result (after the last assistant message) is untouched.
    expect(result.delta.at(-1)).toEqual(delta.at(-1));
    // Message count and order never change.
    expect(result.delta.map((m) => m.role)).toEqual(delta.map((m) => m.role));
  });

  it('never clears the newest messages up to 40% of the budget', () => {
    const { delta, keys } = turns(6, 4000);
    const budget = 20_000;
    const result = compactLoopDelta({ delta, budgetChars: budget, toolMessageKeys: keys });
    let protectedChars = 0;
    for (let i = delta.length - 1; i >= 0 && protectedChars < budget * LOOP_DELTA_PROTECT_RATIO; i -= 1) {
      expect(result.delta[i]).toEqual(delta[i]);
      protectedChars += delta[i].content.length;
    }
  });

  it('the stub keeps call identity and states what was dropped', () => {
    const body = tool('read_file', 5000).content;
    const stub = clearedBodyStub(body);
    expect(stub.startsWith('[read_file] ')).toBe(true);
    expect(stub).toContain(CLEARED_BODY_MARKER);
    expect(stub).toContain(`${body.length} chars`);
    expect(stub).toContain('Repeat the identical call if you need it again');
    expect(stub.length).toBeLessThan(body.length);
  });

  it('never clears validation results, strategy/decision notes or policy denials, even when keyed and old', () => {
    const notes: ModelChatMessage[] = [
      { role: 'tool', content: `[validation] ${'v'.repeat(3000)}` },
      { role: 'tool', content: `STRATEGY_CHANGE ${'s'.repeat(3000)}` },
      { role: 'tool', content: `DECISION_REQUIRED ${'d'.repeat(3000)}` },
      { role: 'tool', content: `[propose_file_change] DENIED by the read-only mutation policy ${'p'.repeat(3000)}` },
    ];
    const delta: ModelChatMessage[] = [...notes, assistant('next'), tool('read_file', 100)];
    const keys = new Map<number, string>(notes.map((_, i) => [i, `k${i}`] as [number, string]));
    const result = compactLoopDelta({ delta, budgetChars: 2000, toolMessageKeys: keys });
    expect(result.clearedBodies).toBe(0);
    expect(result.delta.slice(0, 4)).toEqual(notes);
  });

  it('only clears messages it has a recorded operation key for (a legacy checkpoint has none)', () => {
    const { delta } = turns(6, 4000);
    const result = compactLoopDelta({ delta, budgetChars: 8000, toolMessageKeys: new Map() });
    expect(result.clearedBodies).toBe(0);
    expect(result.fits).toBe(false);
  });

  it('shortens older unprotected assistant text when clearing is not enough, and never twice', () => {
    const long = 'A'.repeat(4000);
    const delta: ModelChatMessage[] = [assistant(long), tool('read_file', 6000), assistant('recent'), tool('read_file', 6000)];
    const keys = new Map<number, string>([[1, 'k1'], [3, 'k3']]);
    const first = compactLoopDelta({ delta, budgetChars: 7000, toolMessageKeys: keys });
    expect(first.truncatedAssistant).toBe(1);
    expect(first.delta[0].content).toBe(`${'A'.repeat(ASSISTANT_CONTENT_KEEP_CHARS)}${ASSISTANT_TRUNCATION_MARKER}`);
    const second = compactLoopDelta({ delta: first.delta, budgetChars: 7000, toolMessageKeys: keys });
    expect(second.truncatedAssistant).toBe(0);
    expect(second.delta[0].content).toBe(first.delta[0].content);
  });

  it('reports fits:false when the protected tail alone exceeds the budget (the caller fails closed)', () => {
    const delta: ModelChatMessage[] = [assistant('read it'), tool('read_file', 9000)];
    const result = compactLoopDelta({ delta, budgetChars: 3000, toolMessageKeys: new Map([[1, 'k']]) });
    expect(result.clearedBodies).toBe(0);
    expect(result.fits).toBe(false);
    expect(result.afterChars).toBe(deltaChars(delta));
  });

  it('a forced pass prunes even within budget (the calibration just rose)', () => {
    const { delta, keys } = turns(6, 1000);
    const budget = deltaChars(delta) + 1000;
    expect(compactLoopDelta({ delta, budgetChars: budget, toolMessageKeys: keys }).clearedBodies).toBe(0);
    const forced = compactLoopDelta({ delta, budgetChars: budget, toolMessageKeys: keys, force: true });
    expect(forced.clearedBodies).toBeGreaterThan(0);
    expect(forced.afterChars).toBeLessThanOrEqual(budget * LOOP_DELTA_TARGET_RATIO);
  });

  it('does not touch the input array or its messages', () => {
    const { delta, keys } = turns(6, 4000);
    const snapshot = JSON.parse(JSON.stringify(delta));
    compactLoopDelta({ delta, budgetChars: 8000, toolMessageKeys: keys });
    expect(delta).toEqual(snapshot);
  });
});

describe('worthPruning', () => {
  it('always prunes when over budget or forced; otherwise requires the minimum gain', () => {
    const budget = 10_000;
    expect(worthPruning({ gainChars: 0, budgetChars: budget, overBudget: true, force: false })).toBe(true);
    expect(worthPruning({ gainChars: 0, budgetChars: budget, overBudget: false, force: true })).toBe(true);
    expect(worthPruning({ gainChars: budget * LOOP_DELTA_MIN_GAIN_RATIO - 1, budgetChars: budget, overBudget: false, force: false })).toBe(false);
    expect(worthPruning({ gainChars: budget * LOOP_DELTA_MIN_GAIN_RATIO, budgetChars: budget, overBudget: false, force: false })).toBe(true);
  });
});

describe('compactionPayload', () => {
  it('serializes the cursor for the continuation and round-trips through JSON', () => {
    const state: LoopCompactionState = { promptCalibration: 1.5, toolMessageKeys: new Map([[3, 'read_file:a'], [7, 'read_file:b']]), forcePrune: true };
    const payload = JSON.parse(JSON.stringify(compactionPayload(state)));
    expect(payload).toEqual({ toolMessageKeys: [[3, 'read_file:a'], [7, 'read_file:b']], promptCalibration: 1.5 });
    expect([...new Map(payload.toolMessageKeys as Array<[number, string]>)]).toEqual([...state.toolMessageKeys]);
  });
});
