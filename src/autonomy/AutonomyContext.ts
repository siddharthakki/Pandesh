import type { JournalState } from '../autonomous/recovery/AttemptJournal';
import type { StageOutcome } from '../autonomous/recovery/RecoveryTypes';
import type { RepositoryIndexSnapshot } from '../context/RepositoryTypes';
import {
  compileContextPack,
  type ContextPack,
  type PackEvidence,
  type PackTaskType,
} from './ContextCompiler';
import type { ExecutionEconomyProfile } from './ExecutionEconomyProfile';
import { assessProgress, type FailureFingerprint } from './FailureFingerprint';
import { RepositoryIntel, loadRepositoryIntel } from './RepositoryIntel';
import { activeSubgoal, advancePlan, planDrift, shapeSubgoals, type SubgoalPlan } from './SubgoalPlan';

/**
 * The seam that turns durable task state into the next call's Context Pack.
 *
 * It owns no state of its own that matters: everything it needs is the journal state
 * (`outcomes`, `evidence`, `mutation`, `decisions`, `subgoalPlan`), the goal, the economy
 * profile and the workspace. Calling it twice over the same durable state produces the
 * same pack, which is what makes a restart safe.
 */

export interface AutonomyContextOptions {
  worktreeRoot: string;
  /** Rich index snapshot when one is available; the filesystem fallback covers its absence. */
  snapshotProvider?: () => Promise<RepositoryIndexSnapshot | undefined>;
  /** Governed reader: workspace boundary, path policy, credential files, size and binary limits. */
  readFile: (relativePath: string) => Promise<string | undefined>;
  log?: (message: string) => void;
}

export interface PrepareInput {
  taskId: string;
  goal: string;
  journalState: Readonly<JournalState>;
  economy: ExecutionEconomyProfile;
  validationCommand?: string;
  /** Recovery directives that apply to the coming dispatch (guidance is rendered separately). */
  seedEvidencePaths?: readonly string[];
}

export interface PreparedContext {
  pack: ContextPack;
  plan: SubgoalPlan;
  /** True when the plan differs from the one in the journal and must be appended. */
  planChanged: boolean;
  intelSource: RepositoryIntel['source'];
  /** Files delivered whole by the pack, with the raw bytes the reader returned (for evidence recording). */
  completeFiles: Array<{ path: string; raw: string }>;
}

const MAX_FAILURE_TEXT = 700;

function failedWindow(state: Readonly<JournalState>): StageOutcome[] {
  const inWindow = Math.max(0, Math.min(state.outcomes.length, state.outcomesSeen - state.progressFloor));
  return state.outcomes.slice(state.outcomes.length - inWindow).filter(outcome => !outcome.ok);
}

function describeFailure(outcome: StageOutcome, verdict?: string): string {
  const fp = outcome.failureFingerprint;
  const parts = [`pass ${outcome.pass}: ${outcome.cause ?? 'failure'}${outcome.subcode ? `/${outcome.subcode}` : ''}`];
  if (fp?.tests.length) parts.push(`failing: ${fp.tests.slice(0, 6).join('; ')}${fp.tests.length > 6 ? ` (+${fp.tests.length - 6})` : ''}`);
  if (fp?.errorClasses.length) parts.push(`errors: ${fp.errorClasses.slice(0, 4).join(', ')}`);
  if (fp?.files.length) parts.push(`files: ${fp.files.slice(0, 4).join(', ')}`);
  if (fp?.patch) {
    const family = fp.patch.family === 'rework' || fp.patch.family === 'identical'
      ? 'this change reworked what the previous change already touched'
      : fp.patch.family === 'different' ? 'this change was in a different area than the previous one' : 'first change';
    parts.push(`change: ${fp.patch.paths.join(', ')} (${family})`);
  }
  if (verdict) parts.push(`progress: ${verdict.replace(/_/g, ' ')}`);
  if (outcome.details.length) parts.push(outcome.details.slice(0, 2).join('; '));
  return parts.join(' | ').slice(0, MAX_FAILURE_TEXT);
}

export class AutonomyContext {
  private intel: RepositoryIntel | undefined;
  private intelEpoch = -1;

  constructor(private readonly options: AutonomyContextOptions) {}

  /** Synchronous view for the RecoveryController's evidence expander: uses the last loaded intelligence. */
  expandEvidence(input: { outcome: StageOutcome; alreadySeen: readonly string[] }): string[] {
    return this.expandForPaths([...(input.outcome.failureFingerprint?.files ?? []), ...input.outcome.facts.proposalPaths], input.alreadySeen);
  }

  /** The same expansion for paths named directly (used inside a pass, between validation-repair cycles). */
  expandForPaths(items: readonly string[], alreadySeen: readonly string[]): string[] {
    const intel = this.intel;
    if (!intel || intel.fileCount === 0) return [];
    const seen = new Set(alreadySeen);
    const implicated = new Set<string>();
    for (const item of items) {
      const resolved = intel.resolvePath(item);
      if (resolved) implicated.add(resolved);
    }
    const tests: string[] = [];
    const callers: string[] = [];
    const dependencies: string[] = [];
    for (const path of [...implicated].sort()) {
      tests.push(...intel.testsFor(path));
      callers.push(...intel.referencesTo(path).filter(candidate => !intel.get(candidate)?.isTest).slice(0, 3));
      dependencies.push(...intel.dependenciesOf(path));
    }
    // Tests first (they define the expectation), then callers, then dependencies: a fixed, explainable order.
    return [...new Set([...tests, ...callers, ...dependencies])]
      .filter(path => !seen.has(path) && !implicated.has(path))
      .slice(0, 4);
  }

  async prepare(input: PrepareInput): Promise<PreparedContext> {
    const state = input.journalState;
    const intel = await this.loadIntel(state.mutationEpoch);
    const window = failedWindow(state);
    const history: FailureFingerprint[] = window.map(outcome => outcome.failureFingerprint).filter((fp): fp is FailureFingerprint => fp !== undefined);

    // Subgoal plan: keep the persisted plan while it still describes the task, else reshape.
    const lastOutcomeErrorText = this.errorTextFor(window[window.length - 1]);
    const facts = {
      filesRead: new Set(state.evidence.keys()),
      mutationApplied: state.mutation?.entries.some(entry => entry.phase === 'applied') === true,
      validationPassed: state.outcomes.length > 0 ? state.outcomes[state.outcomes.length - 1].ok && state.outcomes[state.outcomes.length - 1].stage === 'validation' : undefined,
    };
    let plan = state.subgoalPlan && planDrift(state.subgoalPlan, input.goal).length === 0 ? state.subgoalPlan : undefined;
    let shapedFresh = false;
    if (!plan) {
      const seeds = intel.candidates({ objective: input.goal, errorText: lastOutcomeErrorText, taskType: 'general', explicitFiles: input.seedEvidencePaths, limit: 12 });
      plan = shapeSubgoals({ objective: input.goal, profile: input.economy, candidates: seeds, validationCommand: input.validationCommand });
      shapedFresh = true;
    }
    const advanced = advancePlan(plan, facts);
    const planChanged = shapedFresh || JSON.stringify(advanced) !== JSON.stringify(state.subgoalPlan);
    const subgoal = activeSubgoal(advanced) ?? advanced.subgoals[advanced.subgoals.length - 1];
    const taskType: PackTaskType = advanced.taskType;

    const candidates = intel.candidates({
      objective: subgoal ? `${subgoal.objective}\n${input.goal}` : input.goal,
      errorText: lastOutcomeErrorText,
      taskType,
      explicitFiles: [...(subgoal?.files ?? []), ...(input.seedEvidencePaths ?? [])],
      changedFiles: this.changedFiles(state),
      alreadySeen: [...state.evidence.keys()],
      limit: Math.max(input.economy.pack.maxFiles * 2, 8),
    });

    const evidence: PackEvidence[] = [];
    window.slice(-input.economy.pack.maxFailures).forEach((outcome, index, list) => {
      const verdict = assessProgress(history.slice(0, history.indexOf(outcome.failureFingerprint as FailureFingerprint) + 1))?.verdict;
      evidence.push({
        id: `failure:pass-${outcome.pass}`,
        kind: 'failure',
        text: describeFailure(outcome, verdict),
        weight: 60 + Math.round((index / Math.max(1, list.length)) * 30) + (verdict === 'regression' ? 10 : 0),
        order: outcome.pass,
      });
    });
    const lastDecision = state.decisions[state.decisions.length - 1];
    if (lastDecision) {
      evidence.push({ id: `decision:${lastDecision.decisionSeq}`, kind: 'observation', text: `Last recovery decision: ${lastDecision.action}${lastDecision.cause ? ` for ${lastDecision.cause}` : ''} — ${lastDecision.reason}`, weight: 70, order: lastDecision.decisionSeq });
    }
    state.negativeSearches.slice(-3).forEach((search, index) => evidence.push({ id: `nosearch:${index}:${search.query}`, kind: 'observation', text: `Search for "${search.query}" found nothing${search.scope ? ` in ${search.scope}` : ''}.`, weight: 45, order: index }));

    const completeFiles: PreparedContext['completeFiles'] = [];
    const raw = new Map<string, string>();
    const pack = await compileContextPack({
      taskId: input.taskId,
      subgoalId: subgoal?.id,
      taskType,
      objective: input.goal,
      subgoal: subgoal ? { id: subgoal.id, objective: subgoal.objective, successCondition: subgoal.successCondition, expectedValidation: subgoal.expectedValidation, scope: subgoal.maxScope } : undefined,
      constraints: [
        subgoal?.capability === 'read_only' ? 'Do not modify any file in this step.' : 'Only change files you have been shown in full; never guess file contents.',
        'The validation commands are fixed by the approved plan; do not change them.',
        `Keep to at most ${input.economy.subgoal.maxFiles} file(s) at a time.`,
      ],
      missionState: this.missionState(state, advanced),
      architectureSummary: intel.architectureSummary(),
      candidates,
      readFile: async path => {
        const content = await this.options.readFile(path);
        if (content !== undefined) raw.set(path, content);
        return content;
      },
      evidence,
      validation: this.validationView(window[window.length - 1], state),
      unresolvedQuestions: (window[window.length - 1]?.facts.groundingMissing ?? []).slice(0, 4).map(item => `${item.path} was not read in full (${item.reason.replace(/_/g, ' ')}); its current content is needed before it can be changed.`),
      capabilities: subgoal?.capability === 'read_only'
        ? ['Read files and search the workspace.', 'No file may be modified.']
        : ['Propose a bounded file change for approval.', 'Read files and search the workspace.'],
      policy: input.economy.pack,
      tier: input.economy.tier,
    });
    for (const selected of pack.telemetry.selected) {
      if (selected.section === 'files' && selected.form === 'full') {
        const content = raw.get(selected.id);
        if (content !== undefined && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(content)) completeFiles.push({ path: selected.id, raw: content });
      }
    }
    return { pack, plan: advanced, planChanged, intelSource: intel.source, completeFiles };
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async loadIntel(epoch: number): Promise<RepositoryIntel> {
    // The filesystem fallback is a snapshot: refresh it after each applied mutation so callers/tests reflect the change.
    if (this.intel && (this.intel.source === 'index' || this.intelEpoch === epoch)) return this.intel;
    this.intel = await loadRepositoryIntel({ workspaceRoot: this.options.worktreeRoot, snapshotProvider: this.options.snapshotProvider });
    this.intelEpoch = epoch;
    this.options.log?.(`autonomy_intel source=${this.intel.source} files=${this.intel.fileCount}`);
    return this.intel;
  }

  private errorTextFor(outcome: StageOutcome | undefined): string | undefined {
    if (!outcome) return undefined;
    const fp = outcome.failureFingerprint;
    const lines = [
      ...outcome.facts.validationFailures.flatMap(failure => failure.namedPaths),
      ...(fp?.files ?? []),
      ...(fp?.symbols ?? []),
      ...outcome.facts.groundingMissing.map(item => item.path),
    ];
    return lines.length > 0 ? lines.join('\n') : undefined;
  }

  private changedFiles(state: Readonly<JournalState>): string[] {
    const paths = new Set<string>();
    for (const entry of state.mutation?.entries ?? []) for (const delta of entry.deltas ?? []) paths.add(delta.path);
    return [...paths].sort();
  }

  private missionState(state: Readonly<JournalState>, plan: SubgoalPlan): string[] {
    const lines = [`pass ${state.passes + 1}; ${state.modelsAttempted.length} model(s) tried so far`];
    const active = activeSubgoal(plan);
    if (plan.fragmented && active) lines.push(`subgoal ${active.index + 1} of ${plan.subgoals.length}: ${active.kind}`);
    const applied = state.mutation?.entries.filter(entry => entry.phase === 'applied').length ?? 0;
    lines.push(applied > 0 ? `${applied} change(s) already applied to the isolated worktree; do not re-apply them` : 'no change has been applied yet');
    if (state.validationRepairCycles > 0) lines.push(`${state.validationRepairCycles} validation repair cycle(s) used`);
    return lines;
  }

  private validationView(latest: StageOutcome | undefined, state: Readonly<JournalState>): { status: 'unknown' | 'passing' | 'failing'; lines: string[] } {
    if (latest && latest.facts.validationFailures.length > 0) {
      return {
        status: 'failing',
        lines: latest.facts.validationFailures.slice(0, 4).map(failure => {
          const tests = failure.semantic?.tests.length ? ` — failing: ${failure.semantic.tests.slice(0, 5).join('; ')}` : '';
          return `${failure.command} (${failure.kind}${failure.exitCode !== null ? `, exit ${failure.exitCode}` : ''})${tests}`;
        }),
      };
    }
    const last = state.outcomes[state.outcomes.length - 1];
    if (last?.ok && last.stage === 'validation') return { status: 'passing', lines: [] };
    return { status: 'unknown', lines: [] };
  }
}
