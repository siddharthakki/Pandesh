import { effectiveOutcomeFingerprint, progressHistory, sha, type AttemptJournal } from './AttemptJournal';
import { assessProgress, type ProgressAssessment } from '../../autonomy/FailureFingerprint';
import { classifyContractFailure, type ContractMode } from '../../reliability/ContractEnforcement';
import { isGitPrerequisiteCode } from '../../coding/GitPrerequisites';
import {
  selectRecoveryModel,
  type RecoveryCandidate,
  type RecoveryModelPolicy,
} from './RecoveryModelRouter';
import {
  MAX_VALIDATION_REPAIR_CYCLES,
  RECOVERY_SCHEMA_VERSION,
  TERMINAL_ACTIONS,
  emptyDirectives,
  modelKey,
  type BudgetVerdict,
  type ExpectedChange,
  type FailureCause,
  type ModelIdentity,
  type RecoveryAction,
  type RecoveryDecision,
  type RecoveryDirectives,
  type RecoveryTerminalState,
  type StageOutcome,
} from './RecoveryTypes';

/**
 * The single, deterministic, task-level recovery supervisor.
 *
 *   observe → classify → decide → PERSIST decision → dispatch → observe
 *
 * The controller decides; it never performs stage work, never approves,
 * never widens the contract and never invents success. Every non-terminal
 * decision states what will be different on the next dispatch, and an
 * effectively identical attempt (same failure, evidence, model, strategy) is
 * never dispatched twice.
 */

/** Consumption the controller consults at every decision boundary (from the durable Slice-1 ledger). */
export interface RecoveryBudgetView {
  totals: Partial<Record<string, number>>;
  limits: {
    wallClockMs: number;
    modelCalls: number;
    toolCalls: number;
    recoveryAttemptsPerFailureClass: number;
    validationRepairs: number;
    modelEscalations: number;
    noProgress: number;
  };
}

export interface RecoveryControllerDeps {
  journal: AttemptJournal;
  /** Returns the current ledger view, or undefined when the ledger is unavailable (then only journal-based bounds apply). */
  budget: () => Promise<RecoveryBudgetView | undefined>;
  allocateDecisionSequence: () => Promise<number>;
  candidates: readonly RecoveryCandidate[];
  modelPolicy: RecoveryModelPolicy;
  minContext?: number;
  now?: () => Date;
  /**
   * M46: names files worth reading that the model has not seen (callers, dependencies, tests of the
   * implicated files). Used only when the same hypothesis keeps failing, to change the evidence rather
   * than repeat the attempt. Pure and synchronous: the controller stays deterministic and never does I/O.
   */
  evidenceExpander?: (input: { outcome: StageOutcome; alreadySeen: readonly string[] }) => readonly string[];
  /** M46: consult the failure-fingerprint progress window. Default true; false is exactly the M42 ladder. */
  progressAware?: boolean;
  /**
   * M46: true when schema-constrained decoding is available for this model but not yet in use (an unknown model
   * on a backend that enforces the schema). Lets a format failure change the decoding strategy instead of only
   * repeating the request.
   */
  constrainedOutputAvailable?: (model: ModelIdentity | undefined) => boolean;
  /** Adaptive contract enforcement: the contract mode currently in force for this model on this task. */
  contractModeInEffect?: (model: ModelIdentity | undefined) => ContractMode;
}

const MAX_GUIDANCE_LINES = 6;
const MAX_GUIDANCE_CHARS = 320;
const MAX_SEED_PATHS = 4;
/** A widened seed set may exceed the normal cap by this many runtime-chosen files. */
const MAX_WIDENED_SEED_PATHS = 6;

/** Failures that legitimately look identical on a transient retry; identical-outcome tolerance is one higher. */
const TRANSIENT_CAUSES: ReadonlySet<FailureCause> = new Set(['provider_failure', 'environment_failure']);

export class RecoveryController {
  constructor(private readonly deps: RecoveryControllerDeps) {}

  /**
   * Observe one outcome and decide. The outcome and the decision are durably
   * appended to the journal before this returns, i.e. strictly before the
   * caller can dispatch whatever the decision says.
   */
  async decide(outcome: StageOutcome): Promise<RecoveryDecision> {
    const { journal } = this.deps;
    await journal.append({ t: 'outcome', outcome });
    const base = await this.compute(outcome);
    // A protocol failure (unusable envelope) is not a hypothesis about the task, so it never enters the progress window.
    const assessment = outcome.ok || (outcome.cause !== 'validation_failure' && outcome.cause !== 'semantic_failure' && outcome.cause !== 'grounding_failure') ? undefined : assessProgress(progressHistory(journal.state));
    const decisionSeq = await this.deps.allocateDecisionSequence();
    const decision: RecoveryDecision = this.finalize({
      ...base,
      ...(assessment ? { progress: { verdict: assessment.verdict, streak: assessment.streak, sameHypothesisStreak: assessment.sameHypothesisStreak } } : {}),
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      decisionSeq,
      attemptId: outcome.attemptId,
      pass: outcome.pass,
      decidedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    });
    await journal.append({ t: 'decision', decision });
    return decision;
  }

  /**
   * The controller never self-approves. When the governed flow parks at a human gate it records
   * a WAIT_APPROVAL decision so the journal shows the task is waiting on a person (not stuck),
   * against the contract that gate was opened for. Not a stop: no terminal record is written.
   */
  async recordWaitApproval(input: { attemptId: string; gate: string }): Promise<RecoveryDecision> {
    const decisionSeq = await this.deps.allocateDecisionSequence();
    const decision: RecoveryDecision = {
      schemaVersion: RECOVERY_SCHEMA_VERSION,
      decisionSeq,
      attemptId: input.attemptId,
      pass: this.deps.journal.state.passes,
      action: 'WAIT_APPROVAL',
      terminalState: 'WAITING_FOR_APPROVAL',
      reason: `Waiting for a human ${input.gate} approval; the recovery controller never grants or bypasses approvals.`,
      expectedChange: [],
      directives: emptyDirectives(),
      budget: { exhausted: false },
      decidedAt: (this.deps.now ?? (() => new Date()))().toISOString(),
    };
    await this.deps.journal.append({ t: 'decision', decision });
    return decision;
  }

  /**
   * Called immediately before the decision's action is dispatched. Records the
   * dispatch (which is what the no-progress fingerprints count) or, for a
   * terminal decision, the terminal state.
   */
  async markDispatched(decision: RecoveryDecision): Promise<void> {
    const { journal } = this.deps;
    if (decision.terminalState === 'WAITING_FOR_APPROVAL') return; // a pause, not an end state
    if (decision.terminalState) {
      await journal.append({ t: 'terminal', terminalState: decision.terminalState, reason: decision.reason, cause: decision.cause });
      return;
    }
    if (decision.action === 'CONTINUE') return;
    await journal.append({
      t: 'dispatch',
      decisionSeq: decision.decisionSeq,
      pass: decision.pass,
      dispatchFingerprint: decision.dispatchFingerprint,
      action: decision.action,
    });
  }

  // ── decision procedure ────────────────────────────────────────────────────

  private async compute(outcome: StageOutcome): Promise<Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'>> {
    if (outcome.ok) {
      return this.decision('CONTINUE', outcome, 'Stage succeeded; proceed to the next governed gate.', [], emptyDirectives());
    }
    const cause = outcome.cause ?? 'environment_failure';
    const state = this.deps.journal.state;

    if (cause === 'policy_boundary') {
      return this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Policy/safety boundary (${outcome.subcode ?? 'unspecified'}); failing closed rather than recovering around it.`);
    }

    const budget = await this.checkBudget(cause, outcome);
    if (budget.exhausted) {
      return { ...this.stop('BLOCK', 'BUDGET_EXHAUSTED', outcome, `Recovery budget exhausted: ${budget.detail}.`), budget };
    }

    const plan = this.plan(outcome, cause);
    if ('stop' in plan) return { ...plan.stop, budget };

    // M46: the same hypothesis failing again (even reworded) must change the evidence or the model, not repeat.
    const shifted = this.deps.progressAware === false ? undefined : this.shiftStrategy(outcome, cause, plan, assessProgress(progressHistory(state)));
    if (shifted && 'stop' in shifted) return { ...shifted.stop, budget };
    if (shifted) return this.withNoProgressGuard(outcome, cause, shifted, budget);

    // Repeated effective outcome: the last recovery changed nothing observable. Only a genuinely
    // different strategy (a different model) is allowed past this point; anything else would
    // just repeat what already failed.
    const seen = state.outcomeCounts.get(effectiveOutcomeFingerprint(outcome)) ?? 0;
    const tolerance = TRANSIENT_CAUSES.has(cause) ? 2 : 1;
    if (seen > tolerance && plan.action !== 'CHANGE_MODEL') {
      return { ...this.stop('BLOCK', 'NO_PROGRESS', outcome, `The same failure (${cause}/${outcome.subcode ?? 'n/a'}) recurred ${seen} times with identical proposal, patch and failure signature; further identical recovery would not add information.`), budget };
    }
    return this.withNoProgressGuard(outcome, cause, plan, budget);
  }

  private plan(outcome: StageOutcome, cause: FailureCause): { action: RecoveryAction; expectedChange: ExpectedChange[]; directives: RecoveryDirectives; reason: string } | { stop: Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> } {
    const state = this.deps.journal.state;
    const n = state.recoveryByCause.get(cause) ?? 0;
    const directives = emptyDirectives();
    directives.cloudAuthorized = this.deps.modelPolicy.cloudAuthorized && !this.deps.modelPolicy.pinned;
    const mutationApplied = state.mutation?.entries.some(entry => entry.phase === 'applied') === true;
    // Once a mutation is on disk, EVERY re-dispatch resumes at validation against it: the approved
    // proposal is never regenerated or re-applied, whatever kind of failure comes next.
    directives.resumeAtValidation = mutationApplied;
    if (mutationApplied) directives.seedEvidencePaths = this.validationSeeds(outcome);

    const changeModel = (why: string): { action: RecoveryAction; expectedChange: ExpectedChange[]; directives: RecoveryDirectives; reason: string } | { stop: Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> } => {
      const choice = selectRecoveryModel({
        cause,
        current: outcome.model ?? {},
        attempted: state.modelsAttempted,
        candidates: this.deps.candidates,
        policy: this.deps.modelPolicy,
        minContext: this.deps.minContext,
      });
      if (choice.kind === 'model') {
        const next = { ...directives, model: { provider: choice.provider, model: choice.model, local: choice.local }, cloudAuthorized: !choice.local };
        next.guidance = this.guidanceFor(outcome, cause);
        return {
          action: 'CHANGE_MODEL',
          expectedChange: ['changed_model'],
          directives: next,
          reason: `${why} Changing model to ${choice.provider}/${choice.model} (${choice.reason}).`,
        };
      }
      const terminal: RecoveryTerminalState = choice.reason === 'pinned_no_fallback' ? 'BLOCKED_RESUMABLE' : 'NO_CAPABLE_MODEL';
      return { stop: this.stop('BLOCK', terminal, outcome, `${why} No permitted capable model to change to: ${choice.detail}.`) };
    };

    // Validation recovery after an applied mutation has one attempt-wide repair budget (mirroring Core). Re-dispatching
    // once it is spent cannot generate a repair, so it would only re-run the identical validation: stop truthfully with
    // the real validation/repair reason instead (never as a mutation failure, which this is not).
    const validationRecovery = mutationApplied && (cause === 'validation_failure' || outcome.subcode === 'validation_repair_unavailable');
    if (validationRecovery && outcome.subcode === 'validation_repair_cycle_rejected') {
      return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, 'The validation repair cycle could not be recorded (validation_repair_cycle_rejected). The approved change is applied in the isolated worktree and validation still fails; repair was not attempted.') };
    }
    if (validationRecovery && state.validationRepairCycles >= MAX_VALIDATION_REPAIR_CYCLES) {
      const why = outcome.subcode === 'validation_repair_unavailable'
        ? `validation repair could not produce a usable correction (${outcome.subcode})`
        : `validation still fails (${outcome.subcode ?? 'code_defect'})`;
      // The budget ran out while the same failure kept recurring: that is the absence of progress, not merely a spent
      // budget, and it should say what was tried so a person can supply what is missing.
      const repeats = this.deps.progressAware === false || outcome.cause !== 'validation_failure' ? undefined : assessProgress(progressHistory(state));
      if (repeats && (repeats.sameHypothesisStreak >= 1 || repeats.streak >= 1)) {
        const widened = state.evidenceWidenings.length > 0 || state.decisions.some(decision => decision.directives.strategy === 'widen_evidence');
        return { stop: this.stop('BLOCK', 'NO_PROGRESS', outcome, `${repeats.reasons[0] ?? 'The same failure recurred'}; repair cycles are exhausted (${state.validationRepairCycles} of ${MAX_VALIDATION_REPAIR_CYCLES}). Tried: ${widened ? 'repair with the evidence widened to callers, dependencies and tests' : 'repair with the failing output'}${state.modelsAttempted.length > 1 ? `; models ${state.modelsAttempted.join(', ')}` : ''}. The approved change is applied in the isolated worktree; nothing was delivered. Progress needs a different approach or information only a person can supply.`) };
      }
      return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Validation repair cycles exhausted (${state.validationRepairCycles} of ${MAX_VALIDATION_REPAIR_CYCLES}) and ${why}. The approved change is applied in the isolated worktree; nothing was delivered.`) };
    }

    switch (cause) {
      case 'format_failure': {
        if (n === 0) {
          directives.guidance = this.guidanceFor(outcome, cause);
          if (this.deps.constrainedOutputAvailable?.(outcome.model) === true) {
            directives.strategy = 'constrained_output';
            return { action: 'FORMAT_REPAIR', expectedChange: ['changed_approach'], directives, reason: `Protocol failure (${classifyContractFailure(outcome.subcode, outcome.details)}: ${outcome.subcode ?? 'unspecified'}), not a reasoning failure; retrying once with the response schema enforced by the backend (adaptive contract enforcement). The objective and proposal semantics are unchanged.` };
          }
          return { action: 'FORMAT_REPAIR', expectedChange: ['changed_approach'], directives, reason: `Format failure (${outcome.subcode ?? 'unspecified'}); retrying once with strict format guidance naming the failing codes.` };
        }
        // Enforcement is a strategy, not a belief: if the provider-enforced schema itself produced an unusable reply
        // (e.g. an empty completion), try the prompt-only contract once before concluding the model cannot do it.
        if (this.deps.contractModeInEffect?.(outcome.model) === 'provider_schema' && !this.deps.journal.state.contractModes.some(mode => mode.change === 'released')) {
          directives.guidance = this.guidanceFor(outcome, cause);
          directives.strategy = 'prompt_only_contract';
          return { action: 'FORMAT_REPAIR', expectedChange: ['changed_approach'], directives, reason: `Protocol failure (${classifyContractFailure(outcome.subcode, outcome.details)}: ${outcome.subcode ?? 'unspecified'}) persisted with the provider-enforced schema; reverting the contract to prompt-only for one attempt before treating it as a model failure.` };
        }
        return changeModel(`Format failure persisted after a format repair (${outcome.subcode ?? 'unspecified'}).`);
      }
      case 'grounding_failure': {
        const seeds = this.groundingSeeds(outcome);
        if (seeds.length === 0 && outcome.subcode !== 'insufficient_context' && outcome.subcode !== 'stale_snapshot') {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Grounding failure (${outcome.subcode ?? 'unspecified'}) names no file the runtime can supply; stopping instead of guessing.`) };
        }
        directives.seedEvidencePaths = seeds;
        directives.guidance = this.guidanceFor(outcome, cause);
        return {
          action: 'REINVESTIGATE',
          expectedChange: outcome.subcode === 'stale_snapshot' ? ['refreshed_snapshot', 'new_evidence'] : ['new_evidence'],
          directives,
          reason: `Grounding failure (${outcome.subcode ?? 'ungrounded'}); the runtime will read ${seeds.length} file(s) itself and re-investigate. The model is not changed because missing grounding is not a model-capability failure.`,
        };
      }
      case 'semantic_failure': {
        if (outcome.subcode === 'no_change_claim') {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, 'The model claimed no change is required; a claim never completes a task, so this stops for separate review.') };
        }
        const seeds = this.groundingSeeds(outcome);
        if (n === 0 && seeds.length > 0) {
          directives.seedEvidencePaths = seeds;
          directives.guidance = this.guidanceFor(outcome, cause);
          return { action: 'REINVESTIGATE', expectedChange: ['new_evidence', 'refreshed_snapshot'], directives, reason: `Proposal contradicted the repository (${outcome.subcode ?? 'semantic'}); re-reading the current state of the named files.` };
        }
        if (n <= 1) {
          directives.guidance = this.guidanceFor(outcome, cause);
          directives.seedEvidencePaths = seeds;
          return { action: 'REPLAN', expectedChange: ['changed_approach'], directives, reason: `Semantic failure (${outcome.subcode ?? 'unspecified'}); re-planning with the rejection reason as evidence.` };
        }
        return changeModel(`Semantic failure persisted after ${n} recovery attempt(s).`);
      }
      case 'validation_failure': {
        if (outcome.subcode === 'invalid_assumption') {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, 'The approved validation plan rests on an invalid assumption (for example a missing script or no matching tests). The approved validation commands cannot be widened autonomously.') };
        }
        if (n >= 2 && (n % 2 === 0)) {
          const changed = changeModel(`Validation repair has not converged after ${n} attempt(s).`);
          if ('directives' in changed) return changed;
          // No other model is available: keep repairing within budget rather than stopping early.
        }
        directives.seedEvidencePaths = this.validationSeeds(outcome);
        directives.guidance = this.guidanceFor(outcome, cause);
        return {
          action: 'VALIDATION_REPAIR',
          expectedChange: directives.seedEvidencePaths.length > 0 ? ['new_validation_evidence', 'new_evidence'] : ['new_validation_evidence'],
          directives,
          reason: `Validation failed (${outcome.subcode ?? 'code_defect'}); targeted repair with the failing files re-read from the current worktree.`,
        };
      }
      case 'environment_failure': {
        if (isGitPrerequisiteCode(outcome.subcode)) {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Git prerequisite missing (${outcome.subcode}). This is an environment prerequisite the user must fix; retrying or changing model cannot fix it.`) };
        }
        const validationEnv = outcome.subcode === 'validation_environment' || outcome.subcode === 'validation_tool_failure';
        const transient = validationEnv || outcome.subcode === 'readiness_blocked' || outcome.subcode === 'workspace_lease_held' || outcome.subcode === 'snapshot_read_failed';
        if (!transient) {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Environment failure (${outcome.subcode ?? 'unspecified'}) leaves worktree state uncertain; never retried automatically.`) };
        }
        if (n >= 1) {
          return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Environment failure (${outcome.subcode}) persisted after a retry; it is not something code changes or model changes can fix.`) };
        }
        return { action: 'RETRY_OPERATION', expectedChange: ['refreshed_environment'], directives, reason: `Environment failure (${outcome.subcode}); one bounded retry against re-checked state.` };
      }
      case 'provider_failure': {
        if (n === 0) {
          return { action: 'RETRY_OPERATION', expectedChange: ['transient_retry'], directives, reason: `Provider failure (${outcome.subcode ?? 'unspecified'}); one bounded transient retry.` };
        }
        return changeModel(`Provider failure persisted (${outcome.subcode ?? 'unspecified'}).`);
      }
      default:
        return { stop: this.stop('BLOCK', 'BLOCKED_RESUMABLE', outcome, `Unclassified failure (${cause}); stopping.`) };
    }
  }

  /**
   * M46 progress-aware strategy shift. Only for causes where a model retry can plausibly repeat itself
   * (validation and semantic failures). Ladder, using the same closed action vocabulary:
   *   1st repeat of a hypothesis -> keep the action, widen the evidence (callers, dependencies, tests)
   *   next                        -> CHANGE_MODEL when policy permits
   *   then                        -> NO_PROGRESS, stating what was tried (a person decides what is missing)
   * Improvement and a genuinely new failure never trigger it; a regression only adds guidance.
   */
  private shiftStrategy(
    outcome: StageOutcome,
    cause: FailureCause,
    plan: { action: RecoveryAction; expectedChange: ExpectedChange[]; directives: RecoveryDirectives; reason: string },
    assessment: ProgressAssessment | undefined,
  ): typeof plan | { stop: Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> } | undefined {
    if (!assessment || (cause !== 'validation_failure' && cause !== 'semantic_failure')) return undefined;
    if (plan.action === 'CHANGE_MODEL') return undefined; // the ladder already changes strategy
    const state = this.deps.journal.state;
    if (assessment.verdict === 'regression') {
      plan.directives.guidance = [...plan.directives.guidance, 'Recovery: the last change made additional tests fail. Keep the smallest change and do not touch code that was passing.'].slice(0, MAX_GUIDANCE_LINES);
      return undefined;
    }
    const repeatedHypothesis = assessment.sameHypothesisStreak >= 1 || assessment.streak >= 3;
    if (!repeatedHypothesis) return undefined;

    const widenedInThisStreak = state.decisions.slice(-Math.max(2, assessment.streak + 1)).some(decision => decision.directives.strategy === 'widen_evidence');
    if (!widenedInThisStreak) {
      const seen = [...state.evidence.keys(), ...plan.directives.seedEvidencePaths];
      const extra = (this.deps.evidenceExpander?.({ outcome, alreadySeen: seen }) ?? []).filter(item => !seen.includes(item));
      if (extra.length > 0) {
        const directives: RecoveryDirectives = {
          ...plan.directives,
          seedEvidencePaths: [...new Set([...plan.directives.seedEvidencePaths, ...extra])].slice(0, MAX_WIDENED_SEED_PATHS),
          strategy: 'widen_evidence',
          guidance: [
            ...plan.directives.guidance,
            `Recovery: the same failure recurred ${assessment.streak} time(s) after changes to the same area. Do not repeat that approach; the runtime added the callers, dependencies and tests of the implicated files as evidence.`,
          ].slice(0, MAX_GUIDANCE_LINES),
        };
        return {
          action: plan.action,
          expectedChange: [...new Set<ExpectedChange>([...plan.expectedChange, 'new_evidence', 'changed_approach'])],
          directives,
          reason: `${assessment.reasons[0] ?? 'The same failure recurred'}; widening the evidence (${extra.length} file(s) not yet seen) instead of repeating the attempt.`,
        };
      }
    }
    const choice = selectRecoveryModel({
      cause,
      current: outcome.model ?? {},
      attempted: state.modelsAttempted,
      candidates: this.deps.candidates,
      policy: this.deps.modelPolicy,
      minContext: this.deps.minContext,
    });
    if (choice.kind === 'model') {
      return {
        action: 'CHANGE_MODEL',
        expectedChange: ['changed_model'],
        directives: {
          ...plan.directives,
          model: { provider: choice.provider, model: choice.model, local: choice.local },
          cloudAuthorized: !choice.local,
          guidance: this.guidanceFor(outcome, cause),
        },
        reason: `${assessment.reasons[0] ?? 'The same failure recurred'} and widening the evidence ${widenedInThisStreak ? 'did not help' : 'is not possible'}; changing model to ${choice.provider}/${choice.model} (${choice.reason}).`,
      };
    }
    return {
      stop: this.stop('BLOCK', 'NO_PROGRESS', outcome, `${assessment.reasons[0] ?? 'The same failure recurred'} ${assessment.streak} time(s); the evidence was ${widenedInThisStreak ? 'already widened' : 'not expandable'} and no other permitted model is available (${choice.detail}). Progress needs a different approach or information only a person can supply.`),
    };
  }

  /** Never dispatch an effectively identical attempt twice: change strategy once, else stop as NO_PROGRESS. */
  private withNoProgressGuard(
    outcome: StageOutcome,
    cause: FailureCause,
    plan: { action: RecoveryAction; expectedChange: ExpectedChange[]; directives: RecoveryDirectives; reason: string },
    budget: BudgetVerdict,
  ): Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> {
    const state = this.deps.journal.state;
    const fingerprint = this.dispatchFingerprint(outcome, plan);
    const repeated = (state.dispatchCounts.get(fingerprint) ?? 0) > 0;
    if (!repeated) {
      return { ...this.decision(plan.action, outcome, plan.reason, plan.expectedChange, plan.directives), dispatchFingerprint: fingerprint, budget };
    }
    if (plan.action !== 'CHANGE_MODEL') {
      const choice = selectRecoveryModel({
        cause,
        current: outcome.model ?? {},
        attempted: state.modelsAttempted,
        candidates: this.deps.candidates,
        policy: this.deps.modelPolicy,
        minContext: this.deps.minContext,
      });
      if (choice.kind === 'model') {
        const directives = { ...plan.directives, model: { provider: choice.provider, model: choice.model, local: choice.local }, cloudAuthorized: !choice.local };
        const changedPlan = { action: 'CHANGE_MODEL' as const, expectedChange: ['changed_model' as const], directives, reason: `An identical ${plan.action} attempt was already dispatched; changing model to ${choice.provider}/${choice.model} instead of repeating it.` };
        return { ...this.decision(changedPlan.action, outcome, changedPlan.reason, changedPlan.expectedChange, changedPlan.directives), dispatchFingerprint: this.dispatchFingerprint(outcome, changedPlan), budget };
      }
    }
    return { ...this.stop('BLOCK', 'NO_PROGRESS', outcome, `An identical ${plan.action} attempt (same failure, evidence, model and guidance) was already dispatched and nothing new is available to change.`), budget };
  }

  private dispatchFingerprint(
    outcome: StageOutcome,
    plan: { action: RecoveryAction; directives: RecoveryDirectives },
  ): string {
    const state = this.deps.journal.state;
    const transientOrdinal = plan.action === 'RETRY_OPERATION' ? `#${state.recoveryByCause.get(outcome.cause ?? '') ?? 0}` : '';
    const model = plan.directives.model ? `${plan.directives.model.provider}/${plan.directives.model.model}` : modelKey(outcome.model);
    return sha([
      plan.action,
      outcome.fingerprints.failure ?? '',
      outcome.fingerprints.evidence ?? '',
      model,
      plan.directives.seedEvidencePaths.slice().sort().join(','),
      plan.directives.guidance.join('\n'),
      plan.directives.strategy ?? '',
      transientOrdinal,
    ].join('|'));
  }

  private async checkBudget(cause: FailureCause, outcome: StageOutcome): Promise<BudgetVerdict> {
    const state = this.deps.journal.state;
    const view = await this.deps.budget().catch(() => undefined);
    const limits = view?.limits;
    const perClass = limits?.recoveryAttemptsPerFailureClass;
    const journalCount = state.recoveryByCause.get(cause) ?? 0;
    if (perClass !== undefined && journalCount >= perClass) {
      return { exhausted: true, resource: 'recovery_attempt', limit: perClass, observed: journalCount, detail: `${journalCount} of ${perClass} recovery attempts already used for ${cause}` };
    }
    if (!view || !limits) return { exhausted: false };
    const totals = view.totals;
    const checks: Array<[string, number, number]> = [
      ['model_call', totals['model_call'] ?? 0, limits.modelCalls],
      ['tool_call', totals['tool_call'] ?? 0, limits.toolCalls],
      ['model_escalation', totals['model_escalation'] ?? 0, limits.modelEscalations],
      ['active_execution_ms', totals['active_execution_ms'] ?? 0, limits.wallClockMs],
    ];
    if (cause === 'validation_failure') checks.push(['validation_repair', totals['validation_repair'] ?? 0, limits.validationRepairs]);
    for (const [resource, observed, limit] of checks) {
      if (limit > 0 && observed >= limit) {
        return { exhausted: true, resource, limit, observed, detail: `${resource} ${observed} reached its limit of ${limit}` };
      }
    }
    void outcome;
    return { exhausted: false };
  }

  // ── evidence / guidance helpers ───────────────────────────────────────────

  private groundingSeeds(outcome: StageOutcome): string[] {
    const missing = outcome.facts.groundingMissing.map(item => item.path);
    const paths = missing.length > 0 ? missing : outcome.facts.proposalPaths;
    return [...new Set(paths)].slice(0, MAX_SEED_PATHS);
  }

  private validationSeeds(outcome: StageOutcome): string[] {
    const named = outcome.facts.validationFailures.flatMap(failure => failure.namedPaths);
    return [...new Set([...outcome.facts.proposalPaths, ...named])].slice(0, MAX_SEED_PATHS);
  }

  private guidanceFor(outcome: StageOutcome, cause: FailureCause): string[] {
    const lines: string[] = [];
    switch (cause) {
      case 'format_failure':
        lines.push(`Recovery: your previous response failed host validation (${outcome.details.slice(0, 4).join(', ') || outcome.subcode || 'format'}).`);
        lines.push('Respond with exactly one JSON action in the required envelope. A replace operation must carry the complete new file content.');
        break;
      case 'grounding_failure': {
        const missing = outcome.facts.groundingMissing.slice(0, MAX_SEED_PATHS).map(item => `${item.path} (${item.reason})`);
        lines.push(`Recovery: your previous proposal was rejected as ungrounded${missing.length ? `: ${missing.join(', ')}` : ''}.`);
        lines.push('The runtime has read the current content of those files and supplied it as evidence. Base your proposal only on content you have been shown; do not modify a file you have not seen.');
        break;
      }
      case 'semantic_failure':
        lines.push(`Recovery: your previous proposal contradicted the repository (${outcome.subcode ?? 'semantic'}${outcome.facts.proposalPaths[0] ? ` at ${outcome.facts.proposalPaths[0]}` : ''}).`);
        lines.push('Re-check the current state of the target and choose an approach consistent with it.');
        break;
      case 'validation_failure': {
        const failing = outcome.facts.validationFailures.slice(0, 2).map(failure => `${failure.command} (${failure.kind})`);
        lines.push(`Recovery: validation failed after the approved change: ${failing.join('; ') || 'see failure output'}.`);
        lines.push('Repair the defect using only the already approved file paths; the approved validation commands are fixed.');
        break;
      }
      default:
        break;
    }
    return lines.slice(0, MAX_GUIDANCE_LINES).map(line => line.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, MAX_GUIDANCE_CHARS));
  }

  // ── construction helpers ──────────────────────────────────────────────────

  private decision(
    action: RecoveryAction,
    outcome: StageOutcome,
    reason: string,
    expectedChange: ExpectedChange[],
    directives: RecoveryDirectives,
  ): Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> {
    return {
      action,
      cause: outcome.cause,
      subcode: outcome.subcode,
      reason,
      expectedChange,
      directives,
      budget: { exhausted: false },
    };
  }

  private stop(
    action: 'BLOCK' | 'FAIL',
    terminalState: RecoveryTerminalState,
    outcome: StageOutcome,
    reason: string,
  ): Omit<RecoveryDecision, 'schemaVersion' | 'decisionSeq' | 'attemptId' | 'pass' | 'decidedAt'> {
    const cause: FailureCause | undefined = terminalState === 'NO_PROGRESS' ? 'no_progress' : outcome.cause;
    return {
      action,
      cause,
      subcode: outcome.subcode,
      terminalState,
      reason,
      expectedChange: [],
      directives: emptyDirectives(),
      budget: { exhausted: terminalState === 'BUDGET_EXHAUSTED' },
    };
  }

  /** Invariant: a non-terminal recovery must state what changes next. */
  private finalize(decision: RecoveryDecision): RecoveryDecision {
    const nonTerminalRecovery = !TERMINAL_ACTIONS.has(decision.action) && decision.action !== 'CONTINUE';
    if (nonTerminalRecovery && decision.expectedChange.length === 0) {
      return {
        ...decision,
        action: 'BLOCK',
        terminalState: 'NO_PROGRESS',
        cause: 'no_progress',
        reason: `Refusing to dispatch ${decision.action}: it does not state what will change, so it would repeat an identical attempt.`,
        directives: emptyDirectives(),
        dispatchFingerprint: undefined,
      };
    }
    return decision;
  }
}

export function describeModel(model: ModelIdentity | undefined): string {
  return modelKey(model);
}
