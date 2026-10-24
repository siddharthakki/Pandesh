import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AttemptJournal, progressHistory } from '../../autonomous/recovery/AttemptJournal';
import { RecoveryController, type RecoveryBudgetView } from '../../autonomous/recovery/RecoveryController';
import type { RecoveryCandidate } from '../../autonomous/recovery/RecoveryModelRouter';
import { emptyFacts, type RecoveryDecision, type StageOutcome } from '../../autonomous/recovery/RecoveryTypes';
import {
  analyzeFailureOutput,
  buildFailureFingerprint,
  computePatchDelta,
  derivePatchFootprint,
  type PatchFootprint,
} from '../../autonomy/FailureFingerprint';

const LIMITS: RecoveryBudgetView['limits'] = {
  wallClockMs: 4 * 60 * 60 * 1000, modelCalls: 200, toolCalls: 500, recoveryAttemptsPerFailureClass: 8,
  validationRepairs: 8, modelEscalations: 3, noProgress: 4,
};

const candidate = (model: string): RecoveryCandidate => ({
  provider: 'ollama', model, local: true, available: true,
  capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: ['agent'], contextWindow: 32768 },
});

const BASE = ['export function calculateTotal(items: number[]): number {', '  return items.length;', '}'].join('\n');
const A = ['export function calculateTotal(items: number[]): number {', '  return items.reduce((a, b) => a + b, 0);', '}'].join('\n');
const B = ['export function calculateTotal(items: number[]): number {', '  let sum = 0;', '  for (const n of items) sum += n;', '  return sum;', '}'].join('\n');
const C = ['export function calculateTotal(items: number[]): number {', '  return items.reduce((s, n) => s + n, 0);', '}'].join('\n');

const OUTPUT = ' FAIL  src/total.test.ts > sums the items\nAssertionError: expected 5 to be 6';
const OUTPUT_TWO = ' FAIL  src/total.test.ts > sums the items\n FAIL  src/total.test.ts > handles empty\nAssertionError: expected 5 to be 6';

describe('M46 progress-aware recovery (RecoveryController)', () => {
  let root: string;
  let journal: AttemptJournal;
  let decisionSeq: number;
  let evidence = 0;

  const expander = (paths: string[]) => () => paths;

  function controller(options: { candidates?: RecoveryCandidate[]; expand?: readonly string[]; progressAware?: boolean } = {}): RecoveryController {
    return new RecoveryController({
      journal,
      candidates: options.candidates ?? [],
      modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
      budget: async () => ({ totals: {}, limits: LIMITS }),
      allocateDecisionSequence: async () => (decisionSeq += 1),
      evidenceExpander: options.expand ? expander([...options.expand]) : undefined,
      progressAware: options.progressAware,
    });
  }

  function validationOutcome(output: string, patch?: PatchFootprint, over: Partial<StageOutcome> = {}): StageOutcome {
    evidence += 1;
    const fingerprint = buildFailureFingerprint({
      semantics: [analyzeFailureOutput(output, ['src/total.ts'])],
      files: ['src/total.ts'],
      patch,
      evidence: `ev-${evidence}`,
    });
    return {
      attemptId: 'att_1', pass: evidence, stage: 'validation', ok: false, status: 'validation_failed',
      cause: 'validation_failure', subcode: 'code_defect', details: [], facts: emptyFacts(),
      // Different textual patches hash differently, so the M42 identical-outcome guard does not fire by itself.
      fingerprints: { failure: fingerprint.key, evidence: `ev-${evidence}`, patch: patch?.hash, proposal: patch?.hash },
      failureFingerprint: fingerprint,
      model: { provider: 'ollama', model: 'weak:7b' },
      observedAt: new Date().toISOString(),
      ...over,
    };
  }

  async function step(c: RecoveryController, o: StageOutcome): Promise<RecoveryDecision> {
    const decision = await c.decide(o);
    await c.markDispatched(decision);
    return decision;
  }

  const first = () => derivePatchFootprint([computePatchDelta({ path: 'src/total.ts', op: 'replace', before: BASE, content: A })]);
  const reworkB = () => derivePatchFootprint([computePatchDelta({ path: 'src/total.ts', op: 'replace', before: A, content: B })], [computePatchDelta({ path: 'src/total.ts', op: 'replace', before: BASE, content: A })]);
  const reworkC = () => derivePatchFootprint([computePatchDelta({ path: 'src/total.ts', op: 'replace', before: B, content: C })], [computePatchDelta({ path: 'src/total.ts', op: 'replace', before: A, content: B })]);
  let elsewhereCount = 0;
  /** A change to a different file each time: a genuinely different approach. */
  const elsewhere = () => {
    elsewhereCount += 1;
    return derivePatchFootprint([computePatchDelta({ path: `src/other${elsewhereCount}.ts`, op: 'replace', before: 'x', content: `y${elsewhereCount}` })], [computePatchDelta({ path: 'src/total.ts', op: 'replace', before: BASE, content: A })]);
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm46-recovery-'));
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_m46' });
    decisionSeq = 0;
    evidence = 0;
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  it('does not shift strategy on a first failure or on a different patch', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    const d1 = await step(c, validationOutcome(OUTPUT, first()));
    expect(d1.action).toBe('VALIDATION_REPAIR');
    expect(d1.directives.strategy).toBeUndefined();
    expect(d1.progress?.verdict).toBe('new_failure');
    const d2 = await step(c, validationOutcome(OUTPUT, elsewhere()));
    expect(d2.progress?.verdict).toBe('same_failure_different_patch');
    expect(d2.directives.strategy).toBeUndefined();
    expect(d2.action).toBe('VALIDATION_REPAIR');
  });

  it('the same hypothesis reworded: widens the evidence first, with runtime-chosen files, then changes model, then stops', async () => {
    const c = controller({ expand: ['src/cart.ts', 'src/total.test.ts'], candidates: [candidate('weak:7b'), candidate('stronger:32b')] });
    await step(c, validationOutcome(OUTPUT, first()));
    const widened = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(widened.progress).toMatchObject({ verdict: 'same_failure_same_patch_family', sameHypothesisStreak: 1 });
    expect(widened.action).toBe('VALIDATION_REPAIR');
    expect(widened.directives.strategy).toBe('widen_evidence');
    expect(widened.directives.seedEvidencePaths).toEqual(expect.arrayContaining(['src/cart.ts', 'src/total.test.ts']));
    expect(widened.expectedChange).toEqual(expect.arrayContaining(['new_evidence', 'changed_approach']));
    expect(widened.directives.guidance.join(' ')).toMatch(/Do not repeat that approach/);

    const changed = await step(c, validationOutcome(OUTPUT, reworkC()));
    expect(changed.action).toBe('CHANGE_MODEL');
    expect(changed.directives.model).toMatchObject({ model: 'stronger:32b', local: true });
    expect(changed.progress?.sameHypothesisStreak).toBe(2);
  });

  it('with nothing left to change it stops as NO_PROGRESS and says what was tried, leaving the decision to a person', async () => {
    const c = controller({ expand: ['src/cart.ts'], candidates: [candidate('weak:7b')] });
    await step(c, validationOutcome(OUTPUT, first()));
    const widened = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(widened.directives.strategy).toBe('widen_evidence');
    const stop = await step(c, validationOutcome(OUTPUT, reworkC()));
    expect(stop.action).toBe('BLOCK');
    expect(stop.terminalState).toBe('NO_PROGRESS');
    expect(stop.reason).toMatch(/already widened/);
    expect(stop.reason).toMatch(/person/);
  });

  it('without an expander the ladder skips straight to another model', async () => {
    const c = controller({ candidates: [candidate('weak:7b'), candidate('stronger:32b')] });
    await step(c, validationOutcome(OUTPUT, first()));
    const d = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(d.action).toBe('CHANGE_MODEL');
    expect(d.reason).toMatch(/not possible/);
  });

  it('three different patches that all leave the same failure also change the evidence', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    await step(c, validationOutcome(OUTPUT, first()));
    await step(c, validationOutcome(OUTPUT, elsewhere()));
    const third = await step(c, validationOutcome(OUTPUT, elsewhere()));
    expect(third.progress?.streak).toBe(2);
    expect(third.directives.strategy).toBeUndefined();
    const fourth = await step(c, validationOutcome(OUTPUT, elsewhere()));
    expect(fourth.progress?.streak).toBe(3);
    expect(fourth.directives.strategy).toBe('widen_evidence');
  });

  it('improved validation is not treated as repetition and keeps repairing', async () => {
    const c = controller({ expand: ['src/cart.ts'], candidates: [candidate('weak:7b'), candidate('stronger:32b')] });
    await step(c, validationOutcome(OUTPUT_TWO, first()));
    const improved = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(improved.progress?.verdict).toBe('validation_improved');
    expect(improved.action).toBe('VALIDATION_REPAIR');
    expect(improved.directives.strategy).toBeUndefined();
    expect(improved.directives.model).toBeUndefined();
  });

  it('a regression adds guidance to keep the change small and does not widen or reroute', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    await step(c, validationOutcome(OUTPUT, first()));
    const regressed = await step(c, validationOutcome(OUTPUT_TWO, reworkB()));
    expect(regressed.progress?.verdict).toBe('regression');
    expect(regressed.directives.guidance.join(' ')).toMatch(/smallest change/);
    expect(regressed.directives.strategy).toBeUndefined();
  });

  it('a new error after progress starts a fresh window', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    await step(c, validationOutcome(OUTPUT, first()));
    const other = await step(c, validationOutcome("src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.", elsewhere()));
    expect(other.progress?.verdict).toBe('new_failure');
    expect(other.progress?.streak).toBe(0);
    expect(other.directives.strategy).toBeUndefined();
  });

  it('reproduces the same decision after a restart: the streak lives in the journal, not in memory', async () => {
    const before = controller({ expand: ['src/cart.ts', 'src/total.test.ts'] });
    await step(before, validationOutcome(OUTPUT, first()));
    const beforeState = progressHistory(journal.state).length;

    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_m46' });
    expect(progressHistory(journal.state)).toHaveLength(beforeState);
    const after = controller({ expand: ['src/cart.ts', 'src/total.test.ts'] });
    const widened = await step(after, validationOutcome(OUTPUT, reworkB()));
    expect(widened.directives.strategy).toBe('widen_evidence');
    expect(widened.progress?.sameHypothesisStreak).toBe(1);
  });

  it('a human resume opens a fresh progress window', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    await step(c, validationOutcome(OUTPUT, first()));
    await journal.append({ t: 'resumed', priorTerminal: 'NO_PROGRESS' });
    expect(progressHistory(journal.state)).toHaveLength(0);
    const d = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(d.progress?.verdict).toBe('new_failure');
    expect(d.directives.strategy).toBeUndefined();
  });

  it('leaves non-validation causes to the existing ladders', async () => {
    const c = controller({ expand: ['src/cart.ts'] });
    const format = (): StageOutcome => ({ ...validationOutcome(OUTPUT, first()), cause: 'format_failure', subcode: 'operation_malformed', stage: 'proposal' });
    await step(c, format());
    const second = await step(c, format());
    expect(second.directives.strategy).toBeUndefined();
    expect(second.action).not.toBe('VALIDATION_REPAIR');
  });

  it('progressAware=false is exactly the M42 ladder: a reworded repeat is not widened or rerouted', async () => {
    const c = controller({ expand: ['src/cart.ts'], candidates: [candidate('weak:7b'), candidate('stronger:32b')], progressAware: false });
    await step(c, validationOutcome(OUTPUT, first()));
    const d = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(d.directives.strategy).toBeUndefined();
    expect(d.action).toBe('VALIDATION_REPAIR');
    expect(d.directives.model).toBeUndefined();
  });

  it('never grants approval or widens cloud authorization while shifting strategy', async () => {
    const c = controller({ expand: ['src/cart.ts'], candidates: [candidate('weak:7b'), candidate('stronger:32b')] });
    await step(c, validationOutcome(OUTPUT, first()));
    const widened = await step(c, validationOutcome(OUTPUT, reworkB()));
    expect(widened.directives.cloudAuthorized).toBe(false);
    expect(widened.action).not.toBe('WAIT_APPROVAL');
  });
});
