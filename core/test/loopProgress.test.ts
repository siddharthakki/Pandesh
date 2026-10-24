import { describe, expect, it } from 'vitest';
import {
  INITIAL_LOOP_PROGRESS,
  NON_PROGRESS_DECISION_TURN,
  NON_PROGRESS_STOP_TURN,
  NON_PROGRESS_STRATEGY_TURN,
  cachedCallMessage,
  classifyCall,
  closeTurn,
  decisionRequiredMessage,
  noteRevisionBump,
  nonProgressStopReason,
  strategyChangeMessage,
  type PriorOperation,
} from '../runtime/loopProgress';

const prior = (extra: Partial<PriorOperation> = {}): PriorOperation => ({
  signature: 's', resultCategory: 'read_file_succeeded', evidenceHash: 'h', repeats: 0, ...extra,
});

describe('classifyCall — every row of the M45 §4.3 table', () => {
  it('no prior entry → execute, progress', () => {
    expect(classifyCall({ prior: undefined, mutating: false, revision: 0 })).toEqual({ verdict: 'execute', observation: 'progress' });
    expect(classifyCall({ prior: undefined, mutating: true, revision: 3 })).toEqual({ verdict: 'execute', observation: 'progress' });
  });

  it('read-only, prior at a different revision → execute, progress (the workspace changed)', () => {
    expect(classifyCall({ prior: prior({ revision: 0 }), mutating: false, revision: 1 })).toEqual({ verdict: 'execute', observation: 'progress' });
  });

  it('read-only, same revision, body cleared and not yet re-fetched → rehydrate, neutral', () => {
    expect(classifyCall({ prior: prior({ revision: 2, bodyCleared: true }), mutating: false, revision: 2 }))
      .toEqual({ verdict: 'rehydrate', observation: 'neutral' });
    expect(classifyCall({ prior: prior({ revision: 2, bodyCleared: true, rehydrations: 0 }), mutating: false, revision: 2 }).verdict).toBe('rehydrate');
  });

  it('read-only, same revision, otherwise → cached, non-progress', () => {
    expect(classifyCall({ prior: prior({ revision: 2 }), mutating: false, revision: 2 })).toEqual({ verdict: 'cached', observation: 'non_progress' });
    // A body already re-fetched once is not re-fetched again.
    expect(classifyCall({ prior: prior({ revision: 2, bodyCleared: true, rehydrations: 1 }), mutating: false, revision: 2 }))
      .toEqual({ verdict: 'cached', observation: 'non_progress' });
  });

  it('mutating, prior at the current revision → cached, non-progress', () => {
    expect(classifyCall({ prior: prior({ revision: 1, mutating: true }), mutating: true, revision: 1 }))
      .toEqual({ verdict: 'cached', observation: 'non_progress' });
  });

  it('mutating, prior at a different revision → execute, progress', () => {
    expect(classifyCall({ prior: prior({ revision: 1, mutating: true }), mutating: true, revision: 2 }))
      .toEqual({ verdict: 'execute', observation: 'progress' });
  });

  it('a prior written before M45 (no revision) reads as revision 0', () => {
    expect(classifyCall({ prior: prior(), mutating: false, revision: 0 }).verdict).toBe('cached');
    expect(classifyCall({ prior: prior(), mutating: false, revision: 1 }).verdict).toBe('execute');
  });
});

describe('workspace revision', () => {
  it('a bump increments the revision and resets the non-progress count', () => {
    expect(noteRevisionBump({ revision: 2, nonProgressTurns: 2 })).toEqual({ revision: 3, nonProgressTurns: 0 });
  });

  it('the shared initial state is frozen so it cannot be mutated by accident', () => {
    expect(Object.isFrozen(INITIAL_LOOP_PROGRESS)).toBe(true);
    expect({ ...INITIAL_LOOP_PROGRESS }).toEqual({ revision: 0, nonProgressTurns: 0 });
  });
});

describe('closeTurn', () => {
  const at = (nonProgressTurns: number) => ({ revision: 0, nonProgressTurns });

  it('any progress in the turn resets the count, even beside cached calls', () => {
    expect(closeTurn(at(2), { progress: 1, neutral: 0, nonProgress: 3 })).toEqual({ state: at(0), action: 'none' });
  });

  it('a neutral-only turn leaves the count unchanged', () => {
    expect(closeTurn(at(1), { progress: 0, neutral: 2, nonProgress: 0 })).toEqual({ state: at(1), action: 'none' });
  });

  it('escalates 1 → strategy change, 2 → decision required, 3 → stop', () => {
    const turn = { progress: 0, neutral: 0, nonProgress: 1 };
    expect(NON_PROGRESS_STRATEGY_TURN).toBe(1);
    expect(NON_PROGRESS_DECISION_TURN).toBe(2);
    expect(NON_PROGRESS_STOP_TURN).toBe(3);
    const first = closeTurn(at(0), turn);
    expect(first).toEqual({ state: at(1), action: 'strategy_change' });
    const second = closeTurn(first.state, turn);
    expect(second).toEqual({ state: at(2), action: 'decision_required' });
    expect(closeTurn(second.state, turn)).toEqual({ state: at(3), action: 'stop' });
  });

  it('counts a mixed neutral + cached turn (no progress) as non-progress', () => {
    expect(closeTurn(at(0), { progress: 0, neutral: 1, nonProgress: 1 }).action).toBe('strategy_change');
  });
});

describe('messages', () => {
  it('keeps the existing STRATEGY_CHANGE JSON shape', () => {
    const text = strategyChangeMessage({ failedOperation: 'read_file', signature: 'sig', resultCategory: 'read_file_succeeded', modelEscalated: true });
    expect(text.startsWith('STRATEGY_CHANGE ')).toBe(true);
    expect(JSON.parse(text.slice('STRATEGY_CHANGE '.length))).toEqual({
      message: 'The current approach was not making progress. Try a different strategy.',
      failedOperation: 'read_file', signature: 'sig', resultCategory: 'read_file_succeeded', modelEscalated: true,
    });
  });

  it('DECISION_REQUIRED carries the exact instruction', () => {
    expect(JSON.parse(decisionRequiredMessage().slice('DECISION_REQUIRED '.length)).message).toBe(
      'Repeated calls returned nothing new. Do not repeat them. Answer with the evidence you have, propose a change, or explain what information is missing.',
    );
  });

  it('a cached read reads as unchanged; a cached mutation as not repeated; the stop reason is the existing text', () => {
    expect(cachedCallMessage({ toolName: 'read_file', mutating: false, resultCategory: 'ok' })).toContain('UNCHANGED');
    expect(cachedCallMessage({ toolName: 'propose_file_change', mutating: true, resultCategory: 'ok' })).toContain('NOT REPEATED');
    expect(nonProgressStopReason('read_file')).toBe('blocked after repeated non-progress for read_file; choose a different target or add guidance');
  });
});
