import * as fs from 'fs/promises';
import * as path from 'path';
import type { GovernedCodingExecutionResult } from '../../coding/GovernedCodingExecutor';
import { fingerprintText } from '../../coding/CodingProposal';
import { DEFAULT_INSPECTION_LIMITS, WorkspaceInspectionTools } from '../../coding/WorkspaceInspection';
import type { RepositoryIndexSnapshot } from '../../context/RepositoryTypes';
import { AutonomyContext } from '../../autonomy/AutonomyContext';
import { ModelProfileRegistry } from '../../reliability/ModelProfiles';
import { adaptiveSchemaEnabled, assessProtocolOutcome, classifyContractFailure, isProtocolFailure, type ContractModeRecord, type ProtocolAssessment } from '../../reliability/ContractEnforcement';
import type { EconomyReliability, ExecutionEconomyProfile } from '../../autonomy/ExecutionEconomyProfile';
import type { HostBoundCodingProposal } from '../../coding/WorkspaceMutation';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import type { TaskAccountingSession } from '../TaskControl';
import { AttemptJournal, EvidenceManifest } from './AttemptJournal';
import { InvestigationEvidenceCarry } from '../../coding/InvestigationEvidence';
import { ExecutionRecoverySession } from './ExecutionRecoverySession';
import { classifyExecutionResult } from './FailureClassifier';
import { withFailureFingerprint } from './OutcomeFingerprint';
import { composeMutationHistory, planResumeAfterRestart, type ResumePlan } from './MutationReconciler';
import { RecoveryController, type RecoveryBudgetView } from './RecoveryController';
import { RuntimeIntelligence } from '../../runtimeProfile/RuntimeIntelligence';
import type { RecoveryCandidate, RecoveryModelPolicy } from './RecoveryModelRouter';
import { modelKey, type ModelIdentity, type RecoveryDecision, type RecoveryDirectives, type RecoveryTerminalState, type StageOutcome } from './RecoveryTypes';

/**
 * Glue between the autonomous runtime and the deterministic RecoveryController.
 * It owns no policy: it opens the durable journal, hands the executor a
 * per-dispatch {@link ExecutionRecoverySession}, classifies results, asks the
 * controller to decide, and mirrors recoveries into the Slice-1 budget ledger.
 */

export interface RecoverySupervisorOptions {
  /** Where the task's durable directory lives (the primary workspace root). */
  repositoryRoot: string;
  taskId: string;
  /** The isolated worktree the executor operates in. */
  worktreeRoot: string;
  accounting?: TaskAccountingSession;
  candidates: readonly RecoveryCandidate[];
  modelPolicy: RecoveryModelPolicy;
  resolveBaseRevision: () => Promise<string | undefined>;
  log?: (message: string) => void;
  /**
   * Adaptive contract enforcement: after a protocol (envelope) failure from a model whose backend can enforce the
   * response schema, retry with the provider-enforced schema. Independent of the M46 context layer. Defaults to on
   * when `autonomy` is present; OLLAMA_AGENT_ADAPTIVE_SCHEMA=0 turns it off for the whole task.
   */
  adaptiveSchema?: boolean;
  /**
   * M46 local-autonomy layer. Absent means the M42 behaviour exactly: no Context Pack, no subgoal plan
   * and no evidence expansion. Every failure inside it is logged and skipped, never allowed to fail a pass.
   */
  autonomy?: {
    snapshotProvider?: () => Promise<RepositoryIndexSnapshot | undefined>;
    economyFor: (model: ModelIdentity | undefined, evidence: { parameterBillions?: number; reliability?: EconomyReliability; resourcePressure: boolean }) => ExecutionEconomyProfile;
    validationCommand?: string;
    resourcePressure?: () => boolean;
  };
}

export interface PassHandle {
  pass: number;
  attemptId: string;
  session: ExecutionRecoverySession;
  model?: ModelIdentity;
  /** Mutation entries the journal held when this pass began (M46: scopes the pass's patch footprint). */
  entriesAtStart: number;
}

export class RecoverySupervisor {
  /** One evidence store for every retry/repair loop of this task: a retry starts from what was already read, revalidated against disk. */
  private readonly evidenceCarry = new InvestigationEvidenceCarry();

  private constructor(
    readonly journal: AttemptJournal,
    readonly controller: RecoveryController,
    private readonly options: RecoverySupervisorOptions,
    private readonly autonomy?: AutonomyContext,
  ) {}

  static async open(options: RecoverySupervisorOptions): Promise<RecoverySupervisor> {
    const journal = await AttemptJournal.open({ repositoryRoot: options.repositoryRoot, taskId: options.taskId });
    const { accounting } = options;
    const autonomy = options.autonomy
      ? new AutonomyContext({
        worktreeRoot: options.worktreeRoot,
        snapshotProvider: options.autonomy.snapshotProvider,
        readFile: governedReader(options.worktreeRoot),
        log: options.log,
      })
      : undefined;
    const adaptive = options.adaptiveSchema ?? Boolean(options.autonomy);
    const holder: { supervisor?: RecoverySupervisor } = {};
    const controller = new RecoveryController({
      journal,
      evidenceExpander: autonomy ? input => autonomy.expandEvidence(input) : undefined,
      progressAware: Boolean(autonomy),
      contractModeInEffect: model => (holder.supervisor?.activeConstrained(model) ? 'provider_schema' : 'prompt_only'),
      constrainedOutputAvailable: model => adaptive && adaptiveSchemaEnabled() && Boolean(model?.model && ModelProfileRegistry.canTryConstrainedOutput(model.model, model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama')),
      candidates: options.candidates,
      modelPolicy: options.modelPolicy,
      budget: async (): Promise<RecoveryBudgetView | undefined> => {
        if (!accounting) return undefined;
        const view = await accounting.budgetView();
        return {
          totals: view.totals,
          limits: {
            wallClockMs: view.limits.wallClockMs,
            modelCalls: view.limits.modelCalls,
            toolCalls: view.limits.toolCalls,
            recoveryAttemptsPerFailureClass: view.limits.recoveryAttemptsPerFailureClass,
            validationRepairs: view.limits.validationRepairs,
            modelEscalations: view.limits.modelEscalations,
            noProgress: view.limits.noProgress,
          },
        };
      },
      allocateDecisionSequence: async () => accounting
        ? accounting.allocateDecisionSequence()
        : journal.state.lastDecisionSeq + 1,
    });
    holder.supervisor = new RecoverySupervisor(journal, controller, options, autonomy);
    return holder.supervisor;
  }

  private constrainedModel: ModelIdentity | undefined;

  /** Ends any per-task strategy override this supervisor installed. Safe to call repeatedly. */
  release(): void {
    this.clearConstrainedOutput();
  }

  private constrainedJudged = false;

  activeConstrained(model: ModelIdentity | undefined): boolean {
    return Boolean(this.constrainedModel && model && modelKey(model) === modelKey(this.constrainedModel));
  }
  private constrainedTrigger: ContractModeRecord['trigger'] | undefined;

  /** Verdict on the whole task's failures: was it the envelope or the model's answer? */
  protocolAssessment(): ProtocolAssessment {
    return assessProtocolOutcome(this.journal.state.outcomes);
  }

  private lastProtocolTrigger(): ContractModeRecord['trigger'] {
    const last = [...this.journal.state.outcomes].reverse().find(isProtocolFailure);
    return { kind: classifyContractFailure(last?.subcode, last?.details), subcode: last?.subcode, codes: (last?.details ?? []).slice(0, 6) };
  }

  private async recordContractMode(record: ContractModeRecord): Promise<void> {
    try {
      await this.journal.append({ t: 'contract_mode', ...record });
      this.options.log?.(`contract_mode ${record.change} ${record.from}->${record.to} kind=${record.trigger.kind} model=${record.model ?? 'unknown'}`);
    } catch (error) {
      this.options.log?.(`contract_mode_record_failed ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** First outcome after enforcement decides: still a protocol failure -> released; anything else -> kept for the task. */
  private async judgeConstrainedOutput(classified: StageOutcome, handle: PassHandle): Promise<void> {
    const model = this.constrainedModel;
    if (!model || this.constrainedJudged) return;
    this.constrainedJudged = true;
    const stillProtocol = isProtocolFailure(classified);
    await this.recordContractMode({
      attemptId: handle.attemptId,
      pass: handle.pass,
      change: stillProtocol ? 'released' : 'kept',
      from: 'provider_schema',
      to: stillProtocol ? 'prompt_only' : 'provider_schema',
      model: model.model,
      // The trigger stays the failure that caused the mode change; the outcome that judged it is in the reason.
      trigger: stillProtocol || !this.constrainedTrigger
        ? { kind: classifyContractFailure(classified.subcode, classified.details), subcode: classified.subcode, codes: classified.details.slice(0, 6) }
        : this.constrainedTrigger,
      reason: stillProtocol
        ? 'the reply still failed the contract with the schema enforced; enforcement did not help and is switched off again'
        : `the reply satisfied the contract under enforcement (outcome: ${classified.ok ? 'completed' : `${classified.cause ?? 'failure'} � a reasoning-level result`}); enforcement stays on for this task`,
    });
    // M47: what enforcement did is remembered for this runtime, so the next task starts where the evidence points.
    void RuntimeIntelligence.shared.recordByModel(model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama', model.model ?? '', stillProtocol ? 'schema_harmful' : 'schema_helped');
    if (stillProtocol) this.clearConstrainedOutput();
  }

  private clearConstrainedOutput(): void {
    const model = this.constrainedModel;
    this.constrainedModel = undefined;
    if (model?.model) ModelProfileRegistry.clearObservedStructuredOutput(model.model, model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama');
  }

  get terminal(): { terminalState: RecoveryTerminalState; reason: string } | undefined {
    return this.journal.state.terminal;
  }

  /**
   * Aligns the durable history with the task's CURRENT contract before a run: a changed
   * instruction revision supersedes the recorded mutation/delivery state, and a human resume
   * of a stopped task opens a fresh (still budget-bounded) recovery window.
   */
  async prepareRun(instructionRevision: number): Promise<void> {
    const state = this.journal.state;
    if (state.instructionRevision !== undefined && state.instructionRevision !== instructionRevision) {
      await this.journal.append({ t: 'superseded', reason: 'instruction_revision_changed', instructionRevision });
    }
    const terminal = this.journal.state.terminal;
    if (terminal && terminal.terminalState !== 'COMPLETE') {
      await this.journal.append({ t: 'resumed', priorTerminal: terminal.terminalState });
    }
  }

  /** Decides, from disk, whether a restart must resume at validation instead of mutating again. */
  startupPlan(): Promise<ResumePlan> {
    return planResumeAfterRestart(this.options.worktreeRoot, this.journal.state.mutation);
  }

  /** Records that the flow is parked at a human gate (the controller never approves). */
  async noteWaitingForApproval(gate: string, attemptId: string): Promise<void> {
    await this.controller.recordWaitApproval({ attemptId, gate }).catch(error => this.options.log?.(`recovery_wait_record_failed ${error instanceof Error ? error.message : String(error)}`));
  }

  /** The worktree state the journal says is on disk: the approved proposal plus every applied repair. */
  appliedProposal(): HostBoundCodingProposal | undefined {
    const entries = this.journal.state.mutation?.entries.filter(entry => entry.phase === 'applied') ?? [];
    return composeMutationHistory(entries);
  }

  /** Records the start of one executor dispatch and builds its recovery session. */
  async beginPass(input: {
    attemptId: string;
    model?: ModelIdentity;
    directives?: RecoveryDirectives;
    resumeProposal?: HostBoundCodingProposal;
    instructionRevision?: number;
    /** The task goal; enables the M46 Context Pack for this dispatch. */
    goal?: string;
  }): Promise<PassHandle> {
    if (input.instructionRevision !== undefined) await this.prepareRun(input.instructionRevision);
    const pass = this.journal.state.passes + 1;
    const entriesAtStart = this.journal.state.mutation?.entries.length ?? 0;
    const baseRevision = await this.options.resolveBaseRevision().catch(() => undefined);
    await this.journal.append({
      t: 'attempt_started',
      attemptId: input.attemptId,
      pass,
      model: input.model,
      baseRevision,
      resumeAtValidation: Boolean(input.resumeProposal),
      instructionRevision: input.instructionRevision,
    });
    // M46: a controller-chosen strategy for this dispatch only; cleared as soon as the pass is observed.
    if (input.directives?.strategy === 'constrained_output' && input.model?.model) {
      ModelProfileRegistry.observeStructuredOutput(input.model.model, input.model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama', 'ollama_format');
      this.constrainedModel = input.model;
      this.constrainedJudged = false;
      const trigger = this.lastProtocolTrigger();
      this.constrainedTrigger = trigger;
      await this.recordContractMode({
        attemptId: input.attemptId,
        pass,
        change: 'enforced',
        from: 'prompt_only',
        to: 'provider_schema',
        model: input.model.model,
        trigger,
        reason: `${trigger.kind} failure (${trigger.subcode ?? 'unspecified'}) is a protocol failure, not a reasoning failure; the response schema is now enforced by the provider. Objective and proposal semantics unchanged; the failed reply is not counted as a failed hypothesis.`,
      });
    }
    if (input.directives?.strategy === 'prompt_only_contract' && this.constrainedModel) {
      const model = this.constrainedModel;
      const trigger = this.lastProtocolTrigger();
      this.clearConstrainedOutput();
      this.constrainedJudged = true;
      await this.recordContractMode({
        attemptId: input.attemptId,
        pass,
        change: 'released',
        from: 'provider_schema',
        to: 'prompt_only',
        model: model.model,
        trigger,
        reason: `the provider-enforced schema still produced an unusable reply (${trigger.kind}: ${trigger.subcode ?? 'unspecified'}); reverting to the prompt-only contract for one attempt. Objective and proposal semantics unchanged.`,
      });
    }
    const prepared = await this.prepareAutonomy(input, pass);
    const session = new ExecutionRecoverySession({
      contextPack: prepared?.attach ? prepared.text : undefined,
      expandEvidence: this.autonomy ? (implicated, seen) => this.autonomy!.expandForPaths(implicated, seen) : undefined,
      journal: this.journal,
      workspaceRoot: this.options.worktreeRoot,
      attemptId: input.attemptId,
      pass,
      resolveBaseRevision: this.options.resolveBaseRevision,
      seedEvidencePaths: input.directives?.seedEvidencePaths,
      guidance: input.directives?.guidance,
      resumeAtValidation: input.resumeProposal,
      model: input.model,
      log: this.options.log,
      evidenceCarry: this.evidenceCarry,
    });
    // The pack shows these files whole, so they count as read: without this a proposal that rewrites one
    // would be rejected as ungrounded even though the model was given its complete current content.
    for (const file of prepared?.attach ? prepared.completeFiles : []) {
      const lines = file.raw.length === 0 ? 0 : file.raw.split(/\r?\n/).length;
      await session.recordRead({ path: file.path, contentHash: fingerprintText(file.raw), ranges: lines === 0 ? [[1, 1]] : [[1, lines]], totalLines: lines || 1, source: 'runtime_seed' });
    }
    return { pass, attemptId: input.attemptId, session, model: input.model, entriesAtStart };
  }

  /**
   * M46: compiles this dispatch's Context Pack and persists the subgoal plan and the pack's telemetry.
   * The pack is attached on recovery passes and for constrained models; on a first pass with a capable
   * model the planner's own repository context is already sufficient and adding more only costs tokens.
   */
  private async prepareAutonomy(
    input: { attemptId: string; model?: ModelIdentity; directives?: RecoveryDirectives; goal?: string },
    pass: number,
  ): Promise<{ text: string; attach: boolean; completeFiles: Array<{ path: string; raw: string }> } | undefined> {
    const config = this.options.autonomy;
    if (!this.autonomy || !config || !input.goal) return undefined;
    try {
      const state = this.journal.state;
      const modelKeyText = modelKey(input.model);
      const formatFailures = state.outcomes.filter(outcome => !outcome.ok && outcome.cause === 'format_failure' && modelKey(outcome.model) === modelKeyText).length;
      const strength = this.options.candidates.find(candidate => `${candidate.provider}/${candidate.model}` === modelKeyText)?.strength;
      const economy = config.economyFor(input.model, {
        parameterBillions: strength,
        reliability: formatFailures >= 2 ? 'low' : undefined,
        resourcePressure: config.resourcePressure?.() === true,
      });
      const prepared = await this.autonomy.prepare({
        taskId: this.options.taskId,
        goal: input.goal,
        journalState: state,
        economy,
        validationCommand: config.validationCommand,
        seedEvidencePaths: input.directives?.seedEvidencePaths,
      });
      if (prepared.planChanged) await this.journal.append({ t: 'subgoal_plan', plan: prepared.plan });
      const telemetry = prepared.pack.telemetry;
      await this.journal.append({
        t: 'context_pack',
        attemptId: input.attemptId,
        pass,
        pack: {
          packHash: telemetry.packHash,
          taskType: telemetry.taskType,
          tier: telemetry.tier,
          subgoalId: telemetry.subgoalId,
          budgetChars: telemetry.budgetChars,
          packChars: telemetry.packChars,
          estimatedTokens: telemetry.estimatedTokens,
          candidates: telemetry.candidates.length,
          selected: telemetry.selected.slice(0, 40).map(item => ({ id: item.id, section: item.section, form: item.form, chars: item.chars })),
          rejected: telemetry.rejected.slice(0, 40).map(item => ({ id: item.id, section: item.section, reason: item.reason })),
          intelSource: prepared.intelSource,
        },
      });
      this.options.log?.(`context_pack pass=${pass} tier=${telemetry.tier} chars=${telemetry.packChars}/${telemetry.budgetChars} selected=${telemetry.selected.length} rejected=${telemetry.rejected.length} source=${prepared.intelSource}`);
      return { text: prepared.pack.text, attach: pass > 1 || economy.tier === 'constrained', completeFiles: prepared.completeFiles };
    } catch (error) {
      this.options.log?.(`context_pack_unavailable ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** Classifies the executor result and returns the controller's (already persisted) decision. */
  async observe(result: GovernedCodingExecutionResult, handle: PassHandle, goal: string): Promise<RecoveryDecision> {
    const classified = classifyExecutionResult(result, {
      attemptId: handle.attemptId,
      pass: handle.pass,
      model: handle.model,
      evidenceFingerprint: new EvidenceManifest(this.journal.state).fingerprint(),
      priorPassedCommands: this.journal.state.passedCommands,
      fallbackPaths: await this.namedExistingPaths(goal),
    });
    // Constrained decoding stays on for the rest of the task when it got the model past the format failure;
    // if the model still failed the format with it, it did not help and is switched off again.
    await this.judgeConstrainedOutput(classified, handle);
    // M47: a runtime whose negotiated start was already schema-enforced and still failed the contract is one where
    // enforcement is not helping; remember that so the next dispatch starts prompt-only. Journaled like any mode change.
    if (isProtocolFailure(classified) && handle.model?.model && ModelProfileRegistry.hasNegotiatedSchema(handle.model.model, handle.model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama')) {
      const providerKind = handle.model.provider === 'openai-compatible' ? 'openai-compatible' : 'ollama';
      await this.recordContractMode({
        attemptId: handle.attemptId,
        pass: handle.pass,
        change: 'released',
        from: 'provider_schema',
        to: 'prompt_only',
        model: handle.model.model,
        trigger: { kind: classifyContractFailure(classified.subcode, classified.details), subcode: classified.subcode, codes: classified.details.slice(0, 6) },
        reason: 'the runtime started with the provider schema enforced (from its capability profile) and the reply still failed the contract; enforcement is not helping on this runtime and is switched off',
      });
      await RuntimeIntelligence.shared.recordByModel(providerKind, handle.model.model, 'schema_harmful');
    }
    const outcome = withFailureFingerprint(classified, {
      journalState: this.journal.state,
      entriesAtPassStart: handle.entriesAtStart,
    });
    return this.controller.decide(outcome);
  }

  /**
   * Persists dispatch (or the terminal state) — called after the decision is
   * durable and immediately before its action takes effect.
   */
  async commit(decision: RecoveryDecision): Promise<void> {
    await this.controller.markDispatched(decision);
    const { accounting } = this.options;
    if (!accounting) return;
    const key = `controller:${decision.decisionSeq}`;
    if (decision.terminalState === 'NO_PROGRESS') accounting.recordNoProgress('controller', key);
    else if (!decision.terminalState && decision.action !== 'CONTINUE' && decision.cause) {
      accounting.recordRecoveryAttempt(decision.cause, key);
    }
  }

  /** Files the task text names that exist in the worktree — the fallback grounding targets. */
  private async namedExistingPaths(goal: string): Promise<string[]> {
    const found = new Set<string>();
    for (const match of goal.matchAll(/(?:^|[\s"'`(])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]{1,8})(?=$|[\s"'`),.:;])/g)) {
      const candidate = match[1].replace(/^\.\//, '');
      if (candidate.includes('..') || path.isAbsolute(candidate)) continue;
      try {
        const stat = await fs.stat(path.resolve(this.options.worktreeRoot, candidate));
        if (stat.isFile()) found.add(candidate);
      } catch { /* not a file in this worktree */ }
      if (found.size >= 4) break;
    }
    return [...found];
  }
}

/** Builds the recovery candidate pool from the frozen Core selection (local-only unless the policy says otherwise). */
export function buildRecoveryCandidates(
  selection: {
    selectedProvider: string;
    selectedModel: string;
    candidates?: ReadonlyArray<{ provider: string; model: string; available: boolean; capable: boolean }>;
    escalationCandidates?: ReadonlyArray<{ provider: string; model: string }>;
  } | undefined,
  registry: Pick<ModelCapabilityRegistry, 'getCapabilities'> = ModelCapabilityRegistry.getInstance(),
): RecoveryCandidate[] {
  if (!selection) return [];
  const seen = new Set<string>();
  const out: RecoveryCandidate[] = [];
  const add = (provider: string, model: string, available: boolean): void => {
    const key = `${provider}/${model}`;
    if (seen.has(key)) return;
    seen.add(key);
    const capability = registry.getCapabilities(model, provider);
    out.push({
      provider,
      model,
      local: provider === 'ollama',
      available,
      capability: {
        chat: capability.chat,
        structuredOutput: capability.structuredOutput,
        embeddingOnly: capability.embeddingOnly,
        allowedRoles: capability.allowedRoles,
        contextWindow: capability.contextWindow,
      },
      strength: parameterBillionsFromCapabilityName(model),
    });
  };
  add(selection.selectedProvider, selection.selectedModel, true);
  for (const candidate of selection.escalationCandidates ?? []) add(candidate.provider, candidate.model, true);
  for (const candidate of selection.candidates ?? []) {
    if (candidate.available && candidate.capable) add(candidate.provider, candidate.model, true);
  }
  return out;
}

/**
 * Size evidence only (used to avoid "changing" to a known-weaker model on a
 * capability failure). It never decides capability and matches no model family.
 */
function parameterBillionsFromCapabilityName(model: string): number | undefined {
  const match = /(?:^|[^0-9.])(\d+(?:\.\d+)?)b(?![a-z])/i.exec(model);
  return match ? Number(match[1]) : undefined;
}

/** The same governed reader the runtime seeds use: workspace boundary, path policy, credentials, size and binary limits. */
function governedReader(worktreeRoot: string): (relativePath: string) => Promise<string | undefined> {
  const inspection = new WorkspaceInspectionTools(worktreeRoot, { ...DEFAULT_INSPECTION_LIMITS, maxReadBytes: 300_000 });
  return async relativePath => {
    try {
      return (await inspection.readTextFile(relativePath)).content;
    } catch {
      return undefined;
    }
  };
}
