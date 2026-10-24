import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { RecoveryController, type RecoveryBudgetView } from '../../autonomous/recovery/RecoveryController';
import type { RecoveryCandidate, RecoveryModelPolicy } from '../../autonomous/recovery/RecoveryModelRouter';
import {
  RECOVERY_ACTIONS,
  emptyFacts,
  type FailureCause,
  type RecoveryDecision,
  type StageFacts,
  type StageOutcome,
} from '../../autonomous/recovery/RecoveryTypes';

const LIMITS: RecoveryBudgetView['limits'] = {
  wallClockMs: 4 * 60 * 60 * 1000,
  modelCalls: 200,
  toolCalls: 500,
  recoveryAttemptsPerFailureClass: 3,
  validationRepairs: 6,
  modelEscalations: 3,
  noProgress: 4,
};

function candidate(model: string, over: Partial<RecoveryCandidate> = {}): RecoveryCandidate {
  return {
    provider: 'ollama',
    model,
    local: true,
    available: true,
    capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: ['agent'], contextWindow: 32768 },
    ...over,
  };
}

let seq = 0;
function outcome(over: Partial<StageOutcome> & { facts?: Partial<StageFacts> } = {}): StageOutcome {
  seq += 1;
  const { facts, ...rest } = over;
  return {
    attemptId: 'att_1',
    pass: 1,
    stage: 'proposal',
    ok: false,
    status: 'invalid_proposal',
    cause: 'format_failure',
    subcode: 'operation_malformed',
    details: [],
    facts: { ...emptyFacts(), ...facts },
    fingerprints: { failure: `failure-${seq}`, evidence: 'ev-1' },
    model: { provider: 'ollama', model: 'weak:7b' },
    observedAt: new Date().toISOString(),
    ...rest,
  };
}

describe('M42 RecoveryController (deterministic policy)', () => {
  let root: string;
  let journal: AttemptJournal;
  let totals: Record<string, number>;
  let decisionSeq: number;

  function controller(options: { candidates?: RecoveryCandidate[]; policy?: Partial<RecoveryModelPolicy>; limits?: Partial<RecoveryBudgetView['limits']> } = {}): RecoveryController {
    return new RecoveryController({
      journal,
      candidates: options.candidates ?? [],
      modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false, ...options.policy },
      budget: async () => ({ totals, limits: { ...LIMITS, ...options.limits } }),
      allocateDecisionSequence: async () => (decisionSeq += 1),
    });
  }

  /** Decide, then record the dispatch the runtime would perform, exactly like the runtime does. */
  async function step(c: RecoveryController, o: StageOutcome): Promise<RecoveryDecision> {
    const decision = await c.decide(o);
    await c.markDispatched(decision);
    return decision;
  }

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'm42-controller-'));
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_1' });
    totals = {};
    decisionSeq = 0;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('first-pass success needs no recovery: CONTINUE, nothing dispatched, nothing charged', async () => {
    const decision = await step(controller(), outcome({ ok: true, cause: undefined, subcode: undefined, status: 'completed' }));
    expect(decision.action).toBe('CONTINUE');
    expect(decision.terminalState).toBeUndefined();
    expect(decision.expectedChange).toEqual([]);
    expect(journal.state.recoveryByCause.size).toBe(0);
    expect(journal.state.dispatchCounts.size).toBe(0);
  });

  describe('action selection by cause', () => {
    const table: Array<{
      name: string;
      outcomes: Array<Partial<StageOutcome> & { facts?: Partial<StageFacts> }>;
      candidates?: RecoveryCandidate[];
      policy?: Partial<RecoveryModelPolicy>;
      expect: Array<{ action: string; terminalState?: string; change?: string[] }>;
    }> = [
      {
        name: 'format failure: strict-format repair first, then a stronger permitted local model',
        outcomes: [{ cause: 'format_failure' }, { cause: 'format_failure', subcode: 'operations_empty' }],
        candidates: [candidate('weak:7b', { strength: 7 }), candidate('strong:32b', { strength: 32 })],
        expect: [
          { action: 'FORMAT_REPAIR', change: ['changed_approach'] },
          { action: 'CHANGE_MODEL', change: ['changed_model'] },
        ],
      },
      {
        name: 'format failure with no other capable model stops as NO_CAPABLE_MODEL, never a blind retry',
        outcomes: [{ cause: 'format_failure' }, { cause: 'format_failure', subcode: 'operations_empty' }],
        candidates: [candidate('weak:7b')],
        expect: [{ action: 'FORMAT_REPAIR' }, { action: 'BLOCK', terminalState: 'NO_CAPABLE_MODEL' }],
      },
      {
        name: 'a pinned model with fallback disabled is respected',
        outcomes: [{ cause: 'format_failure' }, { cause: 'format_failure', subcode: 'operations_empty' }],
        candidates: [candidate('weak:7b'), candidate('strong:32b')],
        policy: { pinned: true },
        expect: [{ action: 'FORMAT_REPAIR' }, { action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
      {
        name: 'grounding failure re-investigates and NEVER changes the model, even when a stronger model exists',
        outcomes: [{ cause: 'grounding_failure', subcode: 'never_read', facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' }] } }],
        candidates: [candidate('weak:7b'), candidate('strong:32b', { strength: 32 })],
        expect: [{ action: 'REINVESTIGATE', change: ['new_evidence'] }],
      },
      {
        name: 'stale-snapshot grounding failure re-investigates against a refreshed snapshot',
        outcomes: [{ cause: 'grounding_failure', subcode: 'stale_snapshot', status: 'workspace_changed_after_review', facts: { proposalPaths: ['src/a.ts'] } }],
        expect: [{ action: 'REINVESTIGATE', change: ['refreshed_snapshot', 'new_evidence'] }],
      },
      {
        name: 'semantic failure naming a file: reinvestigate, then replan, then change model',
        outcomes: [
          { cause: 'semantic_failure', subcode: 'create_target_exists', facts: { proposalPaths: ['src/a.ts'] } },
          { cause: 'semantic_failure', subcode: 'create_target_exists', facts: { proposalPaths: ['src/a.ts'] }, fingerprints: { failure: 'sem-2', evidence: 'ev-2' } },
          { cause: 'semantic_failure', subcode: 'create_target_exists', facts: { proposalPaths: ['src/a.ts'] }, fingerprints: { failure: 'sem-3', evidence: 'ev-3' } },
        ],
        candidates: [candidate('weak:7b', { strength: 7 }), candidate('strong:32b', { strength: 32 })],
        expect: [
          { action: 'REINVESTIGATE' },
          { action: 'REPLAN', change: ['changed_approach'] },
          { action: 'CHANGE_MODEL' },
        ],
      },
      {
        name: 'a no-change claim never completes the task: it blocks for review',
        outcomes: [{ cause: 'semantic_failure', subcode: 'no_change_claim', status: 'no_change_claim_reported' }],
        expect: [{ action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
      {
        name: 'validation code defect repairs; regression uses the same repair path',
        outcomes: [{ cause: 'validation_failure', subcode: 'code_defect', stage: 'validation' }, { cause: 'validation_failure', subcode: 'regression', stage: 'validation' }],
        expect: [{ action: 'VALIDATION_REPAIR', change: ['new_validation_evidence'] }, { action: 'VALIDATION_REPAIR' }],
      },
      {
        name: 'invalid validation assumptions cannot be repaired by editing code: truthful block',
        outcomes: [{ cause: 'validation_failure', subcode: 'invalid_assumption', stage: 'validation' }],
        expect: [{ action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
      {
        name: 'validation environment failure: one bounded retry against re-checked state, then a truthful block',
        outcomes: [
          { cause: 'environment_failure', subcode: 'validation_environment', stage: 'validation' },
          { cause: 'environment_failure', subcode: 'validation_environment', stage: 'validation', fingerprints: { failure: 'env-2', evidence: 'ev-1' } },
        ],
        expect: [{ action: 'RETRY_OPERATION', change: ['refreshed_environment'] }, { action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
      {
        name: 'an uncertain mutation failure is never retried automatically',
        outcomes: [{ cause: 'environment_failure', subcode: 'mutation_failed', stage: 'mutation' }],
        expect: [{ action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
      {
        name: 'provider failure: transient retry, then a different permitted local model',
        outcomes: [{ cause: 'provider_failure', subcode: 'provider_unavailable' }, { cause: 'provider_failure', subcode: 'provider_unavailable', fingerprints: { failure: 'p-2', evidence: 'ev-1' } }],
        candidates: [candidate('weak:7b'), candidate('other:14b')],
        expect: [{ action: 'RETRY_OPERATION', change: ['transient_retry'] }, { action: 'CHANGE_MODEL' }],
      },
      {
        name: 'provider failure with no permitted alternative: NO_CAPABLE_MODEL, zero cloud',
        outcomes: [{ cause: 'provider_failure', subcode: 'provider_unavailable' }, { cause: 'provider_failure', subcode: 'provider_unavailable', fingerprints: { failure: 'p-2', evidence: 'ev-1' } }],
        candidates: [candidate('weak:7b'), candidate('cloud-model', { provider: 'openai-compatible', local: false })],
        expect: [{ action: 'RETRY_OPERATION' }, { action: 'BLOCK', terminalState: 'NO_CAPABLE_MODEL' }],
      },
      {
        name: 'policy boundaries fail closed and are never recovered around',
        outcomes: [{ cause: 'policy_boundary', subcode: 'path_uri_scheme_rejected' }],
        expect: [{ action: 'BLOCK', terminalState: 'BLOCKED_RESUMABLE' }],
      },
    ];

    for (const row of table) {
      it(row.name, async () => {
        const c = controller({ candidates: row.candidates, policy: row.policy });
        row.outcomes.forEach(() => undefined);
        for (const [index, over] of row.outcomes.entries()) {
          const decision = await step(c, outcome(over));
          const wanted = row.expect[index];
          expect(decision.action, `step ${index}`).toBe(wanted.action);
          if (wanted.terminalState) expect(decision.terminalState).toBe(wanted.terminalState);
          if (wanted.change) expect(decision.expectedChange).toEqual(wanted.change);
        }
      });
    }
  });

  it('cloud is default deny: an authorised policy is required, and a pinned model never reaches cloud', async () => {
    const cloud = candidate('cloud-model', { provider: 'openai-compatible', local: false });
    const denied = controller({ candidates: [candidate('weak:7b'), cloud], policy: { cloudAuthorized: false } });
    await step(denied, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    const noCloud = await step(denied, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    expect(noCloud.directives.model).toBeUndefined();
    expect(noCloud.terminalState).toBe('NO_CAPABLE_MODEL');

    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_cloud_ok' });
    const allowed = controller({ candidates: [candidate('weak:7b'), cloud], policy: { cloudAuthorized: true } });
    await step(allowed, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    const withCloud = await step(allowed, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    expect(withCloud.action).toBe('CHANGE_MODEL');
    expect(withCloud.directives.model).toMatchObject({ provider: 'openai-compatible', local: false });
    expect(withCloud.directives.cloudAuthorized).toBe(true);

    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_pinned' });
    const pinned = controller({ candidates: [candidate('weak:7b'), cloud], policy: { cloudAuthorized: true, pinned: true } });
    await step(pinned, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    const stillPinned = await step(pinned, outcome({ cause: 'provider_failure', subcode: 'provider_unavailable' }));
    expect(stillPinned.terminalState).toBe('BLOCKED_RESUMABLE');
    expect(stillPinned.directives.model).toBeUndefined();
  });

  it('prefers a local model over an authorised cloud model and never picks a known-weaker model for a capability failure', async () => {
    const c = controller({
      candidates: [
        candidate('current:14b', { strength: 14 }),
        candidate('cloud-model', { provider: 'openai-compatible', local: false }),
        candidate('tiny:3b', { strength: 3 }),
        candidate('bigger:32b', { strength: 32 }),
      ],
      policy: { cloudAuthorized: true },
    });
    await step(c, outcome({ cause: 'format_failure', model: { provider: 'ollama', model: 'current:14b' } }));
    const decision = await step(c, outcome({ cause: 'format_failure', subcode: 'operations_empty', model: { provider: 'ollama', model: 'current:14b' } }));
    expect(decision.directives.model).toMatchObject({ model: 'bigger:32b', local: true });
  });

  it('persists the decision BEFORE the dispatch record, and dispatch before any later outcome', async () => {
    const c = controller();
    const d = await c.decide(outcome({ cause: 'grounding_failure', subcode: 'never_read', facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' }] } }));
    // Decision is durable already; nothing has been dispatched yet.
    let records = await journal.readAll();
    expect(records.map(record => record.t)).toEqual(['outcome', 'decision']);
    expect(journal.state.dispatchCounts.size).toBe(0);
    await c.markDispatched(d);
    records = await journal.readAll();
    expect(records.map(record => record.t)).toEqual(['outcome', 'decision', 'dispatch']);
  });

  it('every non-terminal recovery names what changes next; RECOVERY_ACTIONS stays the closed vocabulary', async () => {
    expect([...RECOVERY_ACTIONS]).toEqual([
      'CONTINUE', 'FORMAT_REPAIR', 'REINVESTIGATE', 'REPLAN', 'RETRY_OPERATION', 'VALIDATION_REPAIR', 'CHANGE_MODEL', 'WAIT_APPROVAL', 'BLOCK', 'FAIL', 'COMPLETE',
    ]);
    const causes: FailureCause[] = ['format_failure', 'grounding_failure', 'semantic_failure', 'validation_failure', 'environment_failure', 'provider_failure', 'policy_boundary'];
    for (const cause of causes) {
      journal = await AttemptJournal.open({ repositoryRoot: root, taskId: `task_${cause}` });
      const decision = await controller({ candidates: [candidate('a:7b'), candidate('b:32b')] }).decide(outcome({
        cause,
        subcode: cause === 'environment_failure' ? 'validation_environment' : cause === 'grounding_failure' ? 'never_read' : undefined,
        facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' }] },
      }));
      if (decision.terminalState || decision.action === 'CONTINUE') {
        expect(decision.expectedChange).toEqual([]);
      } else {
        expect(decision.expectedChange.length, `${cause} -> ${decision.action}`).toBeGreaterThan(0);
      }
    }
  });

  describe('no-progress detection', () => {
    it('repeated equivalent proposal/patch/failure is detected and blocked safely (NO_PROGRESS)', async () => {
      const c = controller();
      const same = { cause: 'grounding_failure' as const, subcode: 'never_read', fingerprints: { failure: 'F', proposal: 'P', patch: 'X', evidence: 'ev-1' }, facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' as const }] } };
      const first = await step(c, outcome(same));
      expect(first.action).toBe('REINVESTIGATE');
      const second = await step(c, outcome(same));
      expect(second.action).toBe('BLOCK');
      expect(second.terminalState).toBe('NO_PROGRESS');
      expect(second.cause).toBe('no_progress');
      expect(second.reason).toContain('recurred');
    });

    it('a materially different failure after recovery is progress, not a loop', async () => {
      const c = controller();
      await step(c, outcome({ cause: 'grounding_failure', subcode: 'never_read', fingerprints: { failure: 'F1', evidence: 'ev-1' }, facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' }] } }));
      const next = await step(c, outcome({ cause: 'grounding_failure', subcode: 'never_read', fingerprints: { failure: 'F2', evidence: 'ev-2' }, facts: { groundingMissing: [{ path: 'src/b.ts', reason: 'never_read' }] } }));
      expect(next.action).toBe('REINVESTIGATE');
    });

    it('the same effective recovery is never dispatched twice: it changes strategy once, else stops', async () => {
      const c = controller({ candidates: [candidate('weak:7b', { strength: 7 }), candidate('strong:32b', { strength: 32 })], limits: { recoveryAttemptsPerFailureClass: 10 } });
      // Two DIFFERENT failures that would produce an identical dispatch (same evidence, guidance and model).
      const shape = { cause: 'validation_failure' as const, subcode: 'code_defect', stage: 'validation' as const, facts: { proposalPaths: ['src/a.ts'] } };
      await step(c, outcome({ ...shape, fingerprints: { failure: 'V', evidence: 'ev-1' } }));
      const repeated = await step(c, outcome({ ...shape, fingerprints: { failure: 'V', evidence: 'ev-1', proposal: 'P2' } }));
      expect(repeated.action).toBe('CHANGE_MODEL');
      // The runtime records each dispatch's model when it starts the pass.
      await journal.append({ t: 'attempt_started', attemptId: 'att_1', pass: 2, model: { provider: 'ollama', model: 'weak:7b' } });
      await journal.append({ t: 'attempt_started', attemptId: 'att_1', pass: 3, model: { provider: 'ollama', model: 'strong:32b' } });
      const again = await step(c, outcome({ ...shape, model: { provider: 'ollama', model: 'strong:32b' }, fingerprints: { failure: 'V', evidence: 'ev-1', proposal: 'P3' } }));
      // With the changed model the repair IS a different attempt, so it is allowed once ...
      expect(again.action).toBe('VALIDATION_REPAIR');
      expect(again.dispatchFingerprint).not.toBe(repeated.dispatchFingerprint);
      // ... but repeating it verbatim (same failure, evidence, guidance AND model) with no other
      // strategy left is a safe stop, not another identical dispatch.
      const last = await step(c, outcome({ ...shape, model: { provider: 'ollama', model: 'strong:32b' }, fingerprints: { failure: 'V', evidence: 'ev-1', proposal: 'P4' } }));
      expect(last.action).toBe('BLOCK');
      expect(last.terminalState).toBe('NO_PROGRESS');
    });

    it('a human resume opens a fresh recovery window (a stop is not permanent), but keeps evidence and mutation history', async () => {
      const c = controller();
      const same = { cause: 'grounding_failure' as const, subcode: 'never_read', fingerprints: { failure: 'F', evidence: 'ev-1' }, facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' as const }] } };
      await step(c, outcome(same));
      const stop = await step(c, outcome(same));
      expect(stop.terminalState).toBe('NO_PROGRESS');
      expect(journal.state.terminal?.terminalState).toBe('NO_PROGRESS');
      await journal.append({ t: 'resumed', priorTerminal: 'NO_PROGRESS' });
      expect(journal.state.terminal).toBeUndefined();
      const afterResume = await step(c, outcome(same));
      expect(afterResume.action).toBe('REINVESTIGATE');
    });
  });

  describe('budget consultation', () => {
    const rows: Array<{ resource: string; totals: Record<string, number>; over?: Partial<RecoveryBudgetView['limits']>; outcome: Partial<StageOutcome> }> = [
      { resource: 'model_call', totals: { model_call: 200 }, outcome: { cause: 'format_failure' } },
      { resource: 'tool_call', totals: { tool_call: 500 }, outcome: { cause: 'format_failure' } },
      { resource: 'model_escalation', totals: { model_escalation: 3 }, outcome: { cause: 'format_failure' } },
      { resource: 'active_execution_ms', totals: { active_execution_ms: 4 * 60 * 60 * 1000 }, outcome: { cause: 'format_failure' } },
      { resource: 'validation_repair', totals: { validation_repair: 6 }, outcome: { cause: 'validation_failure', subcode: 'code_defect', stage: 'validation' } },
    ];
    for (const row of rows) {
      it(`stops deterministically as BUDGET_EXHAUSTED naming ${row.resource}`, async () => {
        totals = row.totals;
        const decision = await step(controller(), outcome(row.outcome));
        expect(decision.action).toBe('BLOCK');
        expect(decision.terminalState).toBe('BUDGET_EXHAUSTED');
        expect(decision.budget).toMatchObject({ exhausted: true, resource: row.resource });
        expect(decision.reason).toContain(row.resource);
      });
    }

    it('bounds recovery per failure class from the durable ledger limit', async () => {
      const c = controller({ limits: { recoveryAttemptsPerFailureClass: 2 } });
      const decisions: RecoveryDecision[] = [];
      for (let index = 0; index < 4; index += 1) {
        decisions.push(await step(c, outcome({
          cause: 'grounding_failure',
          subcode: 'never_read',
          fingerprints: { failure: `G${index}`, evidence: `ev-${index}` },
          facts: { groundingMissing: [{ path: `src/f${index}.ts`, reason: 'never_read' }] },
        })));
      }
      expect(decisions.map(decision => decision.action)).toEqual(['REINVESTIGATE', 'REINVESTIGATE', 'BLOCK', 'BLOCK']);
      expect(decisions[2].terminalState).toBe('BUDGET_EXHAUSTED');
      expect(decisions[2].budget.resource).toBe('recovery_attempt');
    });

    it('a healthy budget is not exhausted and unavailable ledger falls back to journal bounds only', async () => {
      const healthy = await step(controller(), outcome({ cause: 'format_failure' }));
      expect(healthy.budget.exhausted).toBe(false);
      const c = new RecoveryController({
        journal,
        candidates: [],
        modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
        budget: async () => undefined,
        allocateDecisionSequence: async () => (decisionSeq += 1),
      });
      const decision = await step(c, outcome({ cause: 'grounding_failure', subcode: 'never_read', facts: { groundingMissing: [{ path: 'src/a.ts', reason: 'never_read' }] } }));
      expect(decision.action).toBe('REINVESTIGATE');
    });
  });

  it('once a mutation is applied, EVERY recovery resumes at validation (a format failure in the repair turn never regenerates the approved proposal)', async () => {
    const proposal = { operations: [{ type: 'create', path: 'src/a.ts', reason: 'r', content: 'x', canonicalPath: '/x', snapshot: { state: 'absent', capturedAt: 'now' } }], validationCommands: [] } as never;
    await journal.append({ t: 'mutation', phase: 'started', attemptId: 'att_1', proposalFingerprint: 'fp', proposal });
    await journal.append({ t: 'mutation', phase: 'applied', attemptId: 'att_1', proposalFingerprint: 'fp' });
    const c = controller({ candidates: [candidate('weak:7b', { strength: 7 }), candidate('strong:32b', { strength: 32 })] });
    const failure = { cause: 'format_failure' as const, subcode: 'validation_repair_unavailable', stage: 'validation' as const, facts: { proposalPaths: ['src/a.ts'] } };
    const first = await step(c, outcome(failure));
    expect(first.action).toBe('FORMAT_REPAIR');
    expect(first.directives.resumeAtValidation).toBe(true);
    expect(first.directives.seedEvidencePaths).toEqual(['src/a.ts']);
    const second = await step(c, outcome({ ...failure, fingerprints: { failure: 'again', evidence: 'ev-2' } }));
    expect(second.action).toBe('CHANGE_MODEL');
    expect(second.directives.resumeAtValidation).toBe(true);
    const provider = await step(controller(), outcome({ cause: 'provider_failure', subcode: 'provider_unavailable', stage: 'validation', fingerprints: { failure: 'pf', evidence: 'ev-9' } }));
    expect(provider.action).toBe('RETRY_OPERATION');
    expect(provider.directives.resumeAtValidation).toBe(true);
  });

  it('validation recovery resumes at validation only after a mutation is journaled as applied', async () => {
    const c = controller();
    const before = await step(c, outcome({ cause: 'validation_failure', subcode: 'code_defect', stage: 'validation', facts: { proposalPaths: ['src/a.ts'], validationFailures: [{ command: 'npm run verify', exitCode: 1, timedOut: false, signature: 's', namedPaths: ['src/a.ts'], kind: 'code_defect' }] } }));
    expect(before.directives.resumeAtValidation).toBe(false);
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_applied' });
    const proposal = { operations: [{ type: 'create', path: 'src/a.ts', reason: 'r', content: 'x', canonicalPath: '/x', snapshot: { state: 'absent', capturedAt: 'now' } }], validationCommands: [] } as never;
    await journal.append({ t: 'mutation', phase: 'started', attemptId: 'att_1', proposalFingerprint: 'fp', proposal });
    await journal.append({ t: 'mutation', phase: 'applied', attemptId: 'att_1', proposalFingerprint: 'fp' });
    const after = await step(controller(), outcome({ cause: 'validation_failure', subcode: 'code_defect', stage: 'validation', facts: { proposalPaths: ['src/a.ts'] } }));
    expect(after.action).toBe('VALIDATION_REPAIR');
    expect(after.directives.resumeAtValidation).toBe(true);
    expect(after.directives.seedEvidencePaths).toEqual(['src/a.ts']);
  });

  describe('validation repair budget is durable across controller re-entry', () => {
    async function applyMutation(): Promise<void> {
      const proposal = { operations: [{ type: 'replace', path: 'src/a.ts', reason: 'r', content: 'x', canonicalPath: '/x', snapshot: { state: 'exists', capturedAt: 'now' } }], validationCommands: [] } as never;
      await journal.append({ t: 'mutation', phase: 'started', attemptId: 'att_1', proposalFingerprint: 'fp', proposal });
      await journal.append({ t: 'mutation', phase: 'applied', attemptId: 'att_1', proposalFingerprint: 'fp' });
    }
    const unavailable = (): StageOutcome => outcome({
      cause: 'format_failure',
      subcode: 'validation_repair_unavailable',
      stage: 'validation',
      status: 'validation_failed',
      details: ['repair_stop=unavailable', 'invalid'],
      facts: { proposalPaths: ['src/a.ts'] },
    });

    it('a repair cycle consumed by one pass is still consumed after the journal is re-opened (a resumed pass cannot restart at cycle 1)', async () => {
      await journal.append({ t: 'repair_cycle', attemptId: 'att_1', pass: 1, cycle: 1 });
      const reopened = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_1' });
      expect(reopened.state.validationRepairCycles).toBe(1);
      // Never lowered by a later, smaller cycle number.
      await reopened.append({ t: 'repair_cycle', attemptId: 'att_1', pass: 2, cycle: 1 });
      expect(reopened.state.validationRepairCycles).toBe(1);
    });

    it('after a successful mutation, an unavailable repair with budget left is a FORMAT_REPAIR that resumes at validation', async () => {
      await applyMutation();
      await journal.append({ t: 'repair_cycle', attemptId: 'att_1', pass: 1, cycle: 1 });
      const decision = await step(controller(), unavailable());
      expect(decision.action).toBe('FORMAT_REPAIR');
      expect(decision.cause).toBe('format_failure');
      expect(decision.subcode).toBe('validation_repair_unavailable');
      expect(decision.directives.resumeAtValidation).toBe(true);
      expect(decision.expectedChange).toEqual(['changed_approach']);
    });

    it('once the attempt-wide repair budget is spent, every re-dispatch is refused: truthful BLOCKED_RESUMABLE keeping the validation/repair reason', async () => {
      await applyMutation();
      await journal.append({ t: 'repair_cycle', attemptId: 'att_1', pass: 1, cycle: 1 });
      await journal.append({ t: 'repair_cycle', attemptId: 'att_1', pass: 2, cycle: 2 });
      // Even with a stronger local model available, another dispatch could not generate a repair.
      const decision = await step(controller({ candidates: [candidate('weak:7b', { strength: 7 }), candidate('strong:32b', { strength: 32 })] }), unavailable());
      expect(decision.action).toBe('BLOCK');
      expect(decision.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(decision.subcode).toBe('validation_repair_unavailable');
      expect(decision.cause).not.toBe('environment_failure');
      expect(decision.reason).toContain('exhausted (2 of 2)');
      expect(decision.reason).toContain('isolated worktree');
      expect(decision.directives.resumeAtValidation).toBe(false);

      const stillFailing = await step(controller(), outcome({ cause: 'validation_failure', subcode: 'code_defect', stage: 'validation', status: 'validation_failed', facts: { proposalPaths: ['src/a.ts'] } }));
      expect(stillFailing.action).toBe('BLOCK');
      expect(stillFailing.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(stillFailing.cause).toBe('validation_failure');
    });

    it('a rejected repair-cycle record is never retried and never becomes an environment/mutation failure', async () => {
      await applyMutation();
      const decision = await step(controller(), outcome({
        cause: 'validation_failure',
        subcode: 'validation_repair_cycle_rejected',
        stage: 'validation',
        status: 'validation_failed',
        facts: { proposalPaths: ['src/a.ts'] },
      }));
      expect(decision.action).toBe('BLOCK');
      expect(decision.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(decision.cause).toBe('validation_failure');
      expect(decision.subcode).toBe('validation_repair_cycle_rejected');
    });
  });
});
