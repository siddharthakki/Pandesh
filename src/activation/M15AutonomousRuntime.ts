import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  AutonomousTask,
  DurableTaskQueue,
  GhCliGitHubDeliveryTransport,
  GitDeliveryService,
  IsolatedWorktreeManager,
  KarkeAutonomyMode,
  PendingMutationSummary,
  PendingProposalSummary,
  TaskResourceScheduler,
  TaskRuntimeCoordinator,
  verifyInputIntegrity,
} from '../autonomous/M15AutonomousWork';
import { TaskAccountingSession, TaskBudgetLedger, formatBudgetSummary } from '../autonomous/TaskControl';
import { AttemptJournal } from '../autonomous/recovery/AttemptJournal';
import { economyForModel } from '../autonomy/economyAdapter';
import { RecoverySupervisor, buildRecoveryCandidates } from '../autonomous/recovery/RecoverySupervisor';
import type { RecoveryDecision, RecoveryDirectives } from '../autonomous/recovery/RecoveryTypes';
import { MissionRuntimeSupervisor, type MissionRuntimeSupervisorOptions } from '../mission/MissionRuntimeSupervisor';
import { providerReachabilityForCause } from '../mission/ProviderCircuitBreaker';
import {
  GIT_AUTHOR_IDENTITY_UNAVAILABLE,
  GitAuthorIdentityUnavailableError,
  isGitAuthorIdentityFailure,
  isGitAuthorIdentityUnavailableError,
} from '../coding/GitPrerequisites';
import { contractDigest, verifyRestoredContract } from '../autonomous/recovery/TaskContractEnvelope';
import { mutationProposalFingerprint } from '../autonomous/recovery/MutationReconciler';
import { parseAutonomousProgressPhase, renderAutonomousProgressEventPlain } from '../autonomous/AutonomousProgressEvents';
import { GovernedCodingExecutor, GovernedCodingExecutionResult } from '../coding/GovernedCodingExecutor';
import { CodingValidationRunner } from '../coding/ValidationRunner';
import { ApprovalEnvelope, ForgeExecutionReadiness, ForgeExecutionReadinessResult } from '../coding/ExecutionIntegrity';
import { HostBoundCodingProposal } from '../coding/WorkspaceMutation';
import { CommandService } from '../services/CommandService';
import { EolDifference, describeEolDifferences, detectEol, isEolOnlyDifference } from '../coding/EolPolicy';
import { runDiffReviewStage, parseGitStatusPorcelain, parseUntrackedPathsPorcelain, DiffReviewStageInput } from '../coding/DiffReviewStage';
import { DiffReviewVerdict } from '../coding/DiffReview';
import { reconcileChangeScope, changeScopeIsCommittable, computeReviewedContentFingerprint, excludeRuntimeInternalPaths, RUNTIME_INTERNAL_GIT_EXCLUDE_PATHSPEC, RUNTIME_INTERNAL_STATE_DIR } from '../coding/ChangeScopeReconciliation';
import { cleanupGeneratedArtifacts, excludeGeneratedArtifactPaths, captureGeneratedArtifactBaseline } from '../coding/GeneratedArtifactPolicy';
import { routeStage, StageRoutingDecision } from '../coding/StageRouting';
import { deliverLocally, buildManualApplyCommand } from '../orchestration/LocalDeliveryService';
import { classifyExecutionProfile, parseDeterministicFileWrite, ExecutionProfile } from '../orchestration/ExecutionProfile';
import { Config } from '../config/Config';
import { ProviderGateway } from '../providers/ProviderGateway';
import { checkFrozenModelRunnable } from '../models/TaskModelSelection';
import type {
  ApprovalKind,
  ApprovalRecord,
  AttemptContextRecord,
  KarkeDikhaValidationEvidence,
  KarkeDikhaValidationResult,
  ExecutionQualityEvidenceInput,
} from '../../core/shared/wireTypes';
import type { ProviderType } from '../config/ConfigSchema';

/** Phase 6 — optional injected model reviewer for the post-implementation
 * diff-review stage. Matches `DiffReviewStageInput['reviewerVerdict']`
 * exactly so it can be passed straight through to `runDiffReviewStage`.
 * Constructor-injected so tests can supply a deterministic fake without any
 * real model call, and so production code can wire a real provider/model
 * later without touching the routing logic itself. */
export type StageReviewerModel = NonNullable<DiffReviewStageInput['reviewerVerdict']>;

/** Narrow Core authority used by the existing M15 implementation worker. M15
 * still performs VS Code/worktree work, but it cannot cross a gate, validate,
 * or terminalize without the live Core fence represented by this binding. */
export interface KarkeDikhaLifecycleAuthority {
  readonly context: AttemptContextRecord;
  heartbeat(): Promise<void>;
  requestApproval(kind: 'proposal' | 'mutation', summary: Record<string, unknown>): Promise<ApprovalRecord>;
  resolveApproval(
    approval: ApprovalRecord,
    resolution: 'approved' | 'rejected',
    disposition?: 'cancel' | 'revise',
  ): Promise<void>;
  beginValidation(): Promise<void>;
  reportValidation(evidence: KarkeDikhaValidationEvidence): Promise<KarkeDikhaValidationResult>;
  recordExecutionQuality(evidence: ExecutionQualityEvidenceInput): Promise<void>;
  complete(summary?: Record<string, unknown>): Promise<void>;
  fail(reason: string): Promise<void>;
  cancel(): Promise<void>;
}

type ProposalGateDecision =
  | { kind: 'approved' }
  | { kind: 'rejected' }
  | { kind: 'revise'; instructions: string; durableFollowUp?: boolean };
type MutationGateDecision = 'approved' | 'denied' | 'revise';
/** Serializes a read-modify-write against a task's persisted record, matching
 * the closure defined once per {@link AutonomousTaskRuntime.runTask} call. */
type SerializeFn = <T>(fn: () => Promise<T>) => Promise<T>;

function computeProposalFingerprint(taskId: string, version: number, instructionRevision: number, proposal: HostBoundCodingProposal): string {
  const hash = crypto.createHash('sha256');
  hash.update(taskId);
  hash.update(String(version));
  hash.update(String(instructionRevision));
  hash.update(proposal.taskSummary);
  for (const op of proposal.operations) {
    hash.update(op.type);
    hash.update(op.path);
    hash.update(op.reason);
  }
  return `sha256:${hash.digest('hex')}`;
}
import {
  M16EvaluationInput,
  M16EvaluationRunner,
  M16EvaluationStore,
  M16EvaluationSubject,
  M16QualityGateService,
  defaultM16AutonomousDeliveryGate,
} from '../evals/M16QualityEvaluation';

const OUTPUT_CHANNEL_NAME = 'KarkeDikha - Autonomous Tasks';
const CLAIM_LEASE_MS = 120_000;
const CLAIM_HEARTBEAT_MS = 30_000;
/** M44: how long a mission pauses dispatch under sustained resource pressure before resuming regardless. */
const RESOURCE_PRESSURE_MAX_PAUSE_MS = 10 * 60_000;
const RESOURCE_PRESSURE_POLL_MS = 15_000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Outcome of {@link AutonomousTaskRuntime.start}. `ready` means repository
 * readiness succeeded and recovery ran; every other status is a bounded,
 * non-throwing diagnostic for an expected startup obstacle.
 */
export interface AutonomousRuntimeStartupResult {
  status: 'ready' | 'not_a_git_repository' | 'git_unavailable' | 'recovery_failed' | 'disposed';
  reason?: string;
}

type ValidationAttestation = NonNullable<M16EvaluationInput['evidenceRecords']>[number];

/**
 * Conservative host-side scope classifier used only to decide whether an
 * already-issued approval may remain valid. Ambiguous guidance fails closed:
 * verbs that replace/add/remove/rename files, commands, tests, or requested
 * outcomes invalidate the approval; presentation/process preferences do not.
 */
export function steeringChangesApprovedScope(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  // Changing the deliverable's format/language ("Actually, make it Excel") replaces
  // the requested outcome, so the approved plan no longer applies. Purely
  // presentational asks ("make it shorter") do not match a named format.
  if (/\b(?:make|turn|convert|switch|change|export|output)\b[^.\n]{0,40}\b(?:excel|xlsx?|csv|json|xml|pdf|html|yaml|markdown|typescript|python)\b/i.test(text)) return true;
  return /\b(?:instead|replace|rename|move|delete|remove|add|create|write|edit|change|use)\b/i.test(text)
    && (
      /(?:^|[\s"'`])[\w./\\-]+\.[a-z0-9]{1,12}(?:$|[\s"'`,;:])/i.test(text)
      || /\b(?:file|folder|directory|command|test|validation|requirement|scope|output|result)\b/i.test(text)
      || /\binstead\b/i.test(text)
    );
}

/**
 * Produces evidence only for the executor's explicit, successfully completed
 * zero-command validation phase. An empty result array by itself is not
 * evidence: pre-validation, skipped, cancelled, and failed phases remain
 * unattested and therefore fail M16 validation-evidence completeness.
 */
export function completedZeroCommandValidationAttestation(
  attemptId: string,
  result: Pick<GovernedCodingExecutionResult, 'status' | 'validations' | 'validationPhase'>,
): ValidationAttestation | undefined {
  if (
    result.status !== 'completed'
    || result.validationPhase.status !== 'completed'
    || result.validationPhase.applicableCommandCount !== 0
    || result.validationPhase.failedCommandCount !== 0
    || result.validations.length !== 0
  ) {
    return undefined;
  }
  return {
    id: `validation-phase-${attemptId}`,
    kind: 'validation',
    content: 'command=(none-applicable) exit=0 timedOut=false validation_phase=completed failures=0',
  };
}

export async function refreshSourceControlBestEffort(
  execute: () => Thenable<unknown> | Promise<unknown> = () => vscode.commands.executeCommand('git.refresh'),
  timeoutMs = 2_000,
): Promise<void> {
  try {
    await Promise.race([
      Promise.resolve(execute()).then(() => undefined),
      new Promise<void>(resolve => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // SCM refresh cannot own task completion.
  }
}

function classifyStartupError(error: unknown): 'not_a_git_repository' | 'git_unavailable' | 'recovery_failed' {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return 'git_unavailable';
  const message = error instanceof Error ? error.message : String(error);
  if (/not a git repository/i.test(message)) return 'not_a_git_repository';
  return 'recovery_failed';
}

/**
 * Wake-driven drain runtime for M15 autonomous tasks. Claims eligible queued work
 * and executes it through the shared GovernedCodingExecutor, targeting the task's
 * isolated worktree as the execution workspace root. Only one drain loop runs at
 * a time (in-flight guard); wake() calls that arrive mid-drain schedule another pass.
 */
export class AutonomousTaskRuntime implements vscode.Disposable {
  private readonly owner = `m15-runtime-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  private draining = false;
  private wakePending = false;
  private disposed = false;
  private output?: vscode.OutputChannel;
  private readonly abortControllers = new Map<string, AbortController>();
  private recoveryTimer?: NodeJS.Timeout;
  private startupPromise?: Promise<AutonomousRuntimeStartupResult>;
  private currentDrain: Promise<void> = Promise.resolve();
  private deliveryApprovalListener?: (task: AutonomousTask) => void | Promise<void>;
  private proposalApprovalListener?: (task: AutonomousTask) => void | Promise<void>;
  private mutationApprovalListener?: (task: AutonomousTask) => void | Promise<void>;
  // `resolve` is the in-flight Promise resolve for a gate awaited by a live
  // reviewProposal/awaitMutationDecision call, or (after a restart) the
  // re-armed continuation from rearmPendingGates(), which returns a promise
  // so resolvers can await its persisted writes.
  private readonly pendingProposalGates = new Map<string, { proposalId: string; resolve: (decision: ProposalGateDecision) => void | Promise<void> }>();
  private readonly pendingMutationGates = new Map<string, { requestId: string; resolve: (decision: MutationGateDecision) => void | Promise<void> }>();
  private readonly pendingRevisions = new Map<string, string>();
  private readonly coreAuthorities = new Map<string, KarkeDikhaLifecycleAuthority>();
  private readonly coreApprovals = new Map<string, ApprovalRecord>();
  /** Live per-task recovery supervisors (M42); present only while runTask is executing the task. */
  private readonly recoveries = new Map<string, RecoverySupervisor>();
  /** Live per-task mission supervisors (M44); present only while runTask is executing the task. */
  private readonly missions = new Map<string, MissionRuntimeSupervisor>();
  private coreAuthorityRequired = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly queue: DurableTaskQueue,
    private readonly resources: TaskResourceScheduler,
    private readonly worktrees: IsolatedWorktreeManager,
    private readonly executor: GovernedCodingExecutor = new GovernedCodingExecutor(),
    /** Phase 6 — optional injected reviewer-stage model candidate. When
     * absent, the reviewer stage always routes to the deterministic host
     * (identical to pre-Phase-6 behavior), and the routing decision records
     * `fallbackReason: 'no_model_candidate_configured'`. */
    private readonly stageReviewer?: StageReviewerModel,
    /** M44: overrides the mission supervisor's default checkpoint/stall/compaction/provider-cooldown
     * thresholds, resource probe/cadence, and the runtime's own resource-pressure pause/poll
     * intervals. Production always uses the real defaults; tests inject tight thresholds and a
     * scripted resource probe so a run can exercise checkpointing, stall detection, breaker
     * cooldown and resource pressure deterministically, without waiting out the real
     * minutes-scale defaults or real OS load. */
    private readonly missionOverrides?: Partial<Pick<MissionRuntimeSupervisorOptions, 'config' | 'sampleResources' | 'resourceSampleIntervalMs' | 'pressureGates'>> & {
      resourcePressureMaxPauseMs?: number;
      resourcePressurePollMs?: number;
    },
  ) {}

  /** Exposes the exact durable task queue this runtime drains — callers (e.g.
   * Agent Chat's Autonomous mode) must reuse this instance rather than
   * constructing a second queue. */
  getQueue(): DurableTaskQueue {
    return this.queue;
  }

  /** Binds the local M15 projection to its one Core-owned attempt before wake. */
  bindCoreAuthority(taskId: string, authority: KarkeDikhaLifecycleAuthority): void {
    if (taskId !== authority.context.attemptId) {
      throw new Error('core_attempt_identity_mismatch');
    }
    this.coreAuthorities.set(taskId, authority);
  }

  /** Restores the already-existing Core fence/approval bindings after an
   * Extension Host restart. No request, attempt, local worker, or approval is
   * created here; the exact pending Core envelopes remain authoritative. */
  restoreCoreAuthority(
    taskId: string,
    authority: KarkeDikhaLifecycleAuthority,
    pendingApprovals: readonly ApprovalRecord[],
  ): void {
    this.bindCoreAuthority(taskId, authority);
    for (const approval of pendingApprovals) {
      if (approval.attemptId === taskId && approval.status === 'pending') {
        this.coreApprovals.set(this.approvalKey(taskId, approval.kind), approval);
      }
    }
  }

  hasCoreAuthority(taskId: string): boolean {
    return this.coreAuthorities.has(taskId);
  }

  isCoreAuthorityRequired(): boolean {
    return this.coreAuthorityRequired;
  }

  /**
   * Cancels the one Core-owned Karke Dikha attempt and fences its M15
   * projection.  This is deliberately owned here, beside the live abort
   * controller, rather than by the legacy AgentRuntime task controls.
   */
  async cancelTask(taskId: string): Promise<void> {
    const task = await this.queue.get(taskId);
    if (!task || task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') return;

    const authority = this.requireCoreAuthority(taskId);
    if (this.coreAuthorityRequired && !authority) {
      throw new Error('core_authority_missing_for_cancellation');
    }

    // Persist the intent before aborting so a late completion cannot win the
    // race and so reload/recovery sees a fenced lifecycle immediately.
    if (task.state !== 'cancelling') await this.queue.requestCancellation(taskId);
    await this.queue.recordProgress(taskId, 'cancellation_requested actor=user core_authoritative=true');
    this.abortControllers.get(taskId)?.abort();

    // Core cancellation is the authoritative fence.  Do not claim a local
    // terminal outcome if the Core rejects this worker's credentials.
    await authority?.cancel();

    const current = await this.queue.get(taskId);
    if (!current || current.state === 'cancelled') return;
    if (current.state !== 'cancelling') return;
    await this.queue.update(
      { ...current, terminalResult: { status: 'cancelled', summary: 'Cancelled by user; Core attempt fenced.' } },
      'task_cancelled_pending',
      { actor: 'user', coreFenced: Boolean(authority) },
    );
    await this.queue.transition(taskId, 'cancelled', { actor: 'user', coreFenced: Boolean(authority) });
    this.log(taskId, 'cancelled:user_core_fenced');
  }

  /**
   * Queues free-text guidance against a running autonomous task. Applied at
   * the next stage boundary of the fixed five-stage graph (see
   * {@link drainSteering}); has no effect once the task has reached a
   * terminal state, and no effect on a deterministic (model-free) attempt,
   * which never enters the graph.
   */
  async sendSteering(taskId: string, message: string, messageId?: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) throw new Error('steering_message_empty');

    const task = await this.queue.get(taskId);
    if (!task) throw new Error('task_not_found');
    if (task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled') {
      throw new Error('task_not_active');
    }

    const authority = this.requireCoreAuthority(taskId);
    if (this.coreAuthorityRequired && !authority) {
      throw new Error('core_authority_missing_for_steering');
    }

    const scopeChanging = steeringChangesApprovedScope(trimmed);
    // This durable receipt is the acknowledgement boundary. No taskSteered
    // message is posted by AgentPanel until this atomic write has completed.
    const receipt = await this.queue.addFollowUp(taskId, trimmed, { messageId, scopeChanging });
    await this.queue.recordProgress(
      taskId,
      `steering_queued actor=user followUpId=${receipt.id} sequence=${receipt.sequence ?? 0} scopeChanging=${scopeChanging}`,
    );
    this.log(taskId, `steering_queued:user sequence=${receipt.sequence ?? 0} scopeChanging=${scopeChanging}`);

    if (!scopeChanging) return;

    const current = await this.queue.get(taskId);
    if (!current) throw new Error('task_not_found');
    if (current.state === 'waiting_for_proposal_approval' && current.pendingProposal) {
      await this.queue.applyPendingFollowUps(taskId, 'proposal_approval_update', [receipt.id]);
      await this.resolveCoreGate(taskId, 'proposal', 'rejected', 'revise');
      await this.resolveProposalGate(taskId, current.pendingProposal.proposalId, {
        kind: 'revise',
        instructions: trimmed,
        durableFollowUp: true,
      }, true);
      return;
    }
    if (current.state === 'waiting_for_mutation_approval' && current.pendingMutationApproval) {
      await this.queue.applyPendingFollowUps(taskId, 'mutation_approval_update', [receipt.id]);
      await this.resolveCoreGate(taskId, 'mutation', 'rejected', 'revise');
      await this.resolveMutationGate(taskId, current.pendingMutationApproval.requestId, 'revise', true);
      return;
    }
    if (current.state === 'waiting_for_delivery_approval') {
      await this.queue.applyPendingFollowUps(taskId, 'delivery_approval_update', [receipt.id]);
      await this.resolveCoreGate(taskId, 'delivery', 'rejected', 'revise');
      await this.requeueForScopeChangingSteering(taskId, 'delivery_approval_invalidated', [receipt.id]);
    }
  }

  /** Atomically applies durable steering at a safe execution boundary. */
  private async drainSteering(taskId: string, boundary: string): Promise<string[]> {
    const batch = await this.queue.applyPendingFollowUps(taskId, boundary);
    return batch.instructions.map(item => item.content);
  }

  /** Production cutover guard: an unbound legacy/local record may remain
   * visible as a projection, but it may not execute as an independent owner. */
  requireCoreAuthorityForNewWork(): void {
    this.coreAuthorityRequired = true;
  }

  private approvalKey(taskId: string, kind: ApprovalKind): string {
    return `${taskId}:${kind}`;
  }

  private requireCoreAuthority(taskId: string): KarkeDikhaLifecycleAuthority | undefined {
    return this.coreAuthorities.get(taskId);
  }

  private async resolveCoreGate(
    taskId: string,
    kind: ApprovalKind,
    resolution: 'approved' | 'rejected',
    disposition?: 'cancel' | 'revise',
  ): Promise<void> {
    const authority = this.requireCoreAuthority(taskId);
    if (!authority) return;
    const key = this.approvalKey(taskId, kind);
    const approval = this.coreApprovals.get(key);
    if (!approval) throw new Error(`core_${kind}_approval_missing`);
    await authority.resolveApproval(approval, resolution, disposition);
    this.coreApprovals.delete(key);
  }

  /**
   * Task-Scoped Autonomy V1. Resolves the exact same governed proposal,
   * mutation, or delivery gate a user click would resolve — `approveProposal`
   * / `approveMutation` / `approveDelivery`, unchanged — but triggered by the
   * task's own frozen `autonomyMode: 'hands_off'` instead of a webview click.
   * This goes through the identical resolution machinery (Core's real
   * `resolveApproval` call, and, for delivery, every existing safety
   * re-verification inside `approveDelivery`: worktree binding, commit-scope
   * reconciliation, reviewed-diff fingerprint, and every
   * `LocalDeliveryService` precondition) — hands-off safety is therefore
   * identical to supervised safety; only who calls the resolver differs.
   * Nothing here can resolve a gate that is not currently
   * `waiting_for_*_approval` for this exact task, so it can never resurrect
   * an already-rejected or otherwise terminal gate.
   *
   * Records a durable, human-readable audit line via the same
   * `recordProgress` channel `AgentPanel.rehydrateResolvedApprovalCards`
   * already replays to reconstruct gate history, using the same
   * `gate=<kind> policy=<name>` shape already established by the
   * pre-existing workflow-dispatch auto-approval line
   * (`approval_auto_approved gate=graph_dispatch policy=autonomous_runtime`,
   * in `runTask`).
   *
   * Errors are intentionally NOT swallowed here. Callers on the live
   * execution path (`reviewProposal`, `awaitMutationDecision`, the delivery
   * branch of `settleResult`) let them propagate into their own existing
   * exception-to-truthful-failure handling — `GovernedCodingExecutor`'s
   * callback error classification for proposal/mutation, and `runTask`'s own
   * catch block (via `settleResult`) for delivery — exactly as any other
   * unexpected mid-workflow error already does: a truthful `blocked`/`failed`
   * task, never a hang, never a silently fabricated approval. The one
   * fire-and-forget caller, `rearmPendingGates` (a restart-recovery path with
   * no enclosing execution context to catch into), attaches its own
   * `.catch()` at the call site instead.
   */
  private async autoAuthorizeGate(taskId: string, gate: ApprovalKind, identifier?: string): Promise<void> {
    await this.queue.recordProgress(
      taskId,
      `approval_auto_authorized gate=${gate} policy=hands_off_task_authorization${identifier ? ` id=${identifier}` : ''}`,
    );
    if (gate === 'proposal' && identifier) {
      await this.approveProposal(taskId, identifier);
    } else if (gate === 'mutation' && identifier) {
      await this.approveMutation(taskId, identifier);
    } else if (gate === 'delivery') {
      await this.approveDelivery(taskId);
    }
  }

  private async requeueForScopeChangingSteering(
    taskId: string,
    eventType: string,
    followUpIds: readonly string[],
  ): Promise<void> {
    const current = await this.queue.get(taskId);
    if (!current || current.state === 'completed' || current.state === 'failed' || current.state === 'cancelled') return;
    if (
      current.worktreeLocation
      && current.mutationEvidence
      && current.mutationEvidence.instructionRevision < (current.instructionRevision ?? 0)
    ) {
      await this.discardSupersededPaths(current.worktreeLocation, current.mutationEvidence.expectedPaths);
    }
    await this.queue.update({
      ...current,
      state: 'queued',
      pendingProposal: undefined,
      proposalRestartCheckpoint: undefined,
      pendingMutationApproval: undefined,
      diffReview: undefined,
      qualityGate: undefined,
      mutationEvidence: undefined,
      claim: undefined,
    }, eventType, { followUpIds });
    if (!this.disposed) this.wake();
  }

  private async discardSupersededPaths(workspaceRoot: string, paths: readonly string[]): Promise<void> {
    for (const relativePath of [...new Set(paths)]) {
      const tracked = await CommandService.runGit(['ls-files', '--error-unmatch', '--', relativePath], workspaceRoot);
      if (tracked.exitCode === 0) {
        const restored = await CommandService.runGit(['restore', '--source=HEAD', '--worktree', '--', relativePath], workspaceRoot);
        if (restored.exitCode !== 0) throw new Error('stale_mutation_reconciliation_failed');
      } else {
        const absolute = path.resolve(workspaceRoot, relativePath);
        const relative = path.relative(workspaceRoot, absolute);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
          throw new Error('stale_mutation_reconciliation_failed');
        }
        await fs.rm(absolute, { recursive: true, force: true });
      }
    }
    const status = await CommandService.runGit(['status', '--porcelain', '--untracked-files=all', '--', ...paths], workspaceRoot);
    if (status.exitCode !== 0 || status.stdout.trim()) throw new Error('stale_mutation_reconciliation_failed');
  }

  onDeliveryApprovalRequired(listener: (task: AutonomousTask) => void | Promise<void>): void {
    this.deliveryApprovalListener = listener;
  }

  /** Governed entry point for the persisted delivery gate. */
  async approveDelivery(taskId: string): Promise<void> {
    const task = await this.queue.get(taskId);
    if (!task || task.state !== 'waiting_for_delivery_approval') {
      throw new Error('Task is not waiting for delivery approval.');
    }
    if (!task.worktreeLocation) {
      throw new Error('Task has no isolated worktree location.');
    }
    const approvedInstructionRevision = task.instructionRevision ?? 0;
    if (
      !task.mutationEvidence
      || task.mutationEvidence.instructionRevision !== approvedInstructionRevision
      || !task.mutationEvidence.contentVerified
      || task.diffReview?.instructionRevision !== approvedInstructionRevision
    ) {
      throw new Error('delivery_evidence_revision_mismatch');
    }

    // Git author identity is needed only to create the delivery commit, so it
    // is checked here: after investigation, approval, mutation and validation,
    // but before the Core delivery gate is consumed or anything is staged.
    // When it is missing the task stays waiting for delivery approval with its
    // validated worktree intact, and approving again once the user has
    // configured Git resumes delivery without re-running any coding.
    if (!task.mutationEvidence.alreadySatisfied) {
      await this.assertCommitIdentityAvailable(taskId, task.worktreeLocation);
    }

    // Core consumes the exact delivery envelope and moves the authoritative
    // attempt back to running before M15 is allowed to commit or publish.
    await this.resolveCoreGate(taskId, 'delivery', 'approved');

    await this.worktrees.assertBinding(task);
    await this.assertDeliveryInstructionFence(taskId, approvedInstructionRevision, 'after_delivery_approval');

    // Phase 7 — commit-time scope reconciliation. The diff-review verdict
    // above was computed once, before delivery approval; nothing prevents
    // the bound worktree from changing between that review and the user
    // clicking approve (a concurrent process, a stray edit, etc.). Re-check
    // real `git status` in the worktree against the same approved scope
    // right before staging, and refuse to `git add`/commit if it now
    // contains anything outside that approved scope.
    const approvedScopePaths = task.diffReview?.approvedScopePaths ?? [];
    const deliveryBaseline = await captureGeneratedArtifactBaseline(task.worktreeLocation);
    await cleanupGeneratedArtifacts(task.worktreeLocation, { baselineArtifacts: deliveryBaseline });
    const statusResult = await CommandService.runGit(
      ['status', '--porcelain', '--untracked-files=all'],
      task.worktreeLocation,
    );
    if (statusResult.exitCode !== 0) {
      throw new Error(`git status failed during commit-time reconciliation: ${statusResult.stderr || statusResult.stdout}`);
    }
    // `.ollama-agent` runtime-state writes are excluded from reconciliation
    // exactly as they were at diff-review time, and are equally excluded from
    // the staging pathspec below so they can never be committed either.
    const actualChangedFiles = excludeGeneratedArtifactPaths(excludeRuntimeInternalPaths(parseGitStatusPorcelain(statusResult.stdout)));
    const reconciliation = reconcileChangeScope(approvedScopePaths, actualChangedFiles);
    if (
      !changeScopeIsCommittable(reconciliation)
      || (reconciliation.missingExpected.length > 0 && !task.mutationEvidence.alreadySatisfied)
    ) {
      const blocked = await this.queue.update(
        {
          ...task,
          failure: {
            classification: 'commit_scope_reconciliation_failed',
            message: reconciliation.missingExpected.length > 0
              ? `Commit-time reconciliation found no delivery candidate for approved paths: ${reconciliation.missingExpected.join(', ')}`
              : `Commit-time scope reconciliation found unexpected changes outside the approved scope: ${reconciliation.unexpected.join(', ')}`,
            at: new Date().toISOString(),
          },
        },
        'commit_scope_reconciliation_failed',
        { unexpected: reconciliation.unexpected, missingExpected: reconciliation.missingExpected },
      );
      if (blocked.state !== 'blocked') await this.queue.transition(taskId, 'blocked');
      await this.finalizeLease(blocked, 'failed', false);
      throw new Error(
        reconciliation.missingExpected.length > 0
          ? `Delivery blocked: approved mutation is missing from the Git delivery candidate: ${reconciliation.missingExpected.join(', ')}`
          : `Delivery blocked: commit-time scope reconciliation detected unexpected changes: ${reconciliation.unexpected.join(', ')}`,
      );
    }

    // Phase 7 — reviewed-diff integrity check. Scope reconciliation alone
    // cannot detect an already-approved path being modified *again* after
    // diff review (the path was in scope both times, so it never appears in
    // `reconciliation.unexpected`). Regenerate the actual diff right before
    // staging and compare its fingerprint against the one recorded when the
    // diff-review verdict was decided; any mismatch means the reviewed
    // content is stale and must block delivery rather than commit content
    // nobody reviewed. Tasks persisted before this field existed have no
    // fingerprint to compare against and fall through to path-scope
    // reconciliation only, preserving prior behavior for older tasks.
    const reviewedDiffFingerprint = task.diffReview?.reviewedDiffFingerprint;
    if (reviewedDiffFingerprint) {
      // Greenfield (unborn HEAD) worktrees have no revision for `git diff HEAD`
      // to compare against: the entire reviewed content is untracked files,
      // which the fingerprint hashes directly. The diff text is therefore
      // empty for an unborn worktree, exactly as it was when the diff review
      // computed the fingerprint before delivery approval.
      const headProbe = await CommandService.runGit(['rev-parse', '--verify', '-q', 'HEAD'], task.worktreeLocation);
      const unbornWorktree = headProbe.exitCode !== 0 || !headProbe.stdout.trim();
      let reviewedDiffText = '';
      if (!unbornWorktree) {
        const diffResult = await CommandService.runGit(
          ['diff', 'HEAD', '--', '.', RUNTIME_INTERNAL_GIT_EXCLUDE_PATHSPEC],
          task.worktreeLocation,
        );
        if (diffResult.exitCode !== 0) {
          throw new Error(`git diff failed during commit-time reconciliation: ${diffResult.stderr || diffResult.stdout}`);
        }
        reviewedDiffText = diffResult.stdout;
      }
      const untrackedFiles = excludeGeneratedArtifactPaths(excludeRuntimeInternalPaths(parseUntrackedPathsPorcelain(statusResult.stdout)));
      const actualFingerprint = await computeReviewedContentFingerprint(task.worktreeLocation, reviewedDiffText, untrackedFiles);
      if (actualFingerprint !== reviewedDiffFingerprint) {
        const blocked = await this.queue.update(
          {
            ...task,
            failure: {
              classification: 'delivery_diff_changed',
              message: 'The reviewed diff no longer matches the current worktree content; delivery blocked pending renewed diff review.',
              at: new Date().toISOString(),
            },
          },
          'delivery_diff_changed',
          { reviewedDiffFingerprint, actualFingerprint },
        );
        if (blocked.state !== 'blocked') await this.queue.transition(taskId, 'blocked');
        await this.finalizeLease(blocked, 'failed', false);
        throw new Error('Delivery blocked: reviewed diff no longer matches the current worktree content (delivery_diff_changed).');
      }
    }

    const deliveryActor = task.autonomyMode === 'hands_off' ? 'hands_off_policy' : 'user';
    await this.queue.recordProgress(taskId, `approval_approved gate=delivery actor=${deliveryActor}`);
    await this.queue.transition(taskId, 'committing', { gate: 'delivery', actor: deliveryActor });
    // Exactly-once fence: durable BEFORE any commit/apply. A crash after this point leaves
    // `started` without `completed`/`aborted`, which a later run treats as uncertain and never
    // re-delivers automatically.
    const deliveryJournal = await this.journalFor(taskId);
    await deliveryJournal.append({ t: 'delivery', phase: 'started', attemptId: task.attemptId });
    // Delivery-time validation happens outside the governed executor; account for it in the
    // same durable ledger (and keep its duration out of any human-wait time).
    const deliveryAccounting = await this.openAccounting(task);

    if (task.mutationEvidence.alreadySatisfied) {
      const committing = await this.queue.get(taskId);
      if (!committing) throw new Error('Task disappeared while recording an already-satisfied delivery.');
      const deliveredCommands = committing.deliveryValidation?.commands ?? [];
      const deliveredResults = await this.inDeliveryValidationStage(deliveryAccounting, () => new CodingValidationRunner(
        this.workspaceRoot,
        Config.getCommandTimeoutMs(),
        this.deliveryValidationRuntime(deliveryAccounting, task, 'already_satisfied'),
      ).runAll(deliveredCommands));
      const deliveredFailures = deliveredResults.filter(result => result.exitCode !== 0 || result.timedOut);
      const verifiedTask = await this.queue.update({
        ...committing,
        deliveryValidation: {
          commands: deliveredCommands,
          status: deliveredFailures.length === 0 ? 'passed' : 'failed',
          root: this.workspaceRoot,
          results: deliveredResults.map(result => ({
            command: result.command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            outputTail: result.output.slice(-4_000),
          })),
          verifiedAt: new Date().toISOString(),
        },
      }, 'post_delivery_validation_completed', {
        commands: deliveredResults.length,
        failed: deliveredFailures.length,
        root: this.workspaceRoot,
      });
      if (deliveredFailures.length > 0) {
        const firstFailure = deliveredFailures[0];
        const blocked = await this.queue.update({
          ...verifiedTask,
          failure: {
            classification: 'post_delivery_validation_failed',
            message: `Delivered-state validation failed: ${firstFailure.command}`,
            at: new Date().toISOString(),
          },
        }, 'post_delivery_validation_failed', {
          command: firstFailure.command,
          exitCode: firstFailure.exitCode,
          timedOut: firstFailure.timedOut,
        });
        if (blocked.state !== 'blocked') await this.queue.transition(taskId, 'blocked');
        await this.finalizeLease(blocked, 'failed', false);
        await this.requireCoreAuthority(taskId)?.fail('post_delivery_validation_failed').catch(() => undefined);
        await deliveryJournal.append({ t: 'delivery', phase: 'aborted', attemptId: task.attemptId, detail: 'post_delivery_validation_failed' });
        await this.finishAccounting(taskId, task.attemptId, deliveryAccounting);
        throw new Error(`Delivered-state validation failed: ${firstFailure.command}`);
      }
      await this.queue.update(
        {
          ...verifiedTask,
          terminalResult: {
            status: 'completed',
            summary: 'Already satisfied: the approved destination state was verified and no repository commit was required.',
          },
        },
        'delivery_already_satisfied',
        { instructionRevision: approvedInstructionRevision, paths: task.mutationEvidence.expectedPaths },
      );
      await this.requireCoreAuthority(taskId)?.recordExecutionQuality({
        eventType: 'final_verification_recorded',
        metadata: { kind: 'already_satisfied', commitSha: null },
      });
      await this.requireCoreAuthority(taskId)?.complete({ alreadySatisfied: true, commitSha: null });
      const completed = await this.queue.transition(taskId, 'completed', {
        gate: 'delivery',
        actor: 'user',
        authority: 'core',
        alreadySatisfied: true,
      });
      await this.finalizeLease({ ...committing, ...completed }, 'completed');
      await deliveryJournal.append({ t: 'delivery', phase: 'completed', attemptId: task.attemptId, detail: 'already_satisfied' });
      await this.recordCompleteDecision(deliveryJournal, deliveryAccounting, task, 'Already satisfied: verified without a commit.');
      await this.finishAccounting(taskId, task.attemptId, deliveryAccounting);
      return;
    }

    // Set by an inner block below (workspace_delivery_conflict) that already
    // persisted a specific failure classification before throwing to reach
    // the catch below — that catch must not overwrite it with the generic
    // classifyRuntimeError(error)/'runtime_error' bucket. See the catch's
    // own comment for the confirmed defect this guards against.
    let deliveryFailureAlreadyClassified = false;
    try {
      const commitMessage = `M15 delivery ${task.taskId}`.slice(0, 120);
      // The unstage step is the enforcement half of the runtime-state
      // exclusion above: reconciliation ignores `.ollama-agent`, so staging
      // must never deliver it either. An `:(exclude)` pathspec cannot be used
      // here — naming a gitignored `.ollama-agent` in any pathspec makes
      // `git add` fail with the ignored-paths advice error in repos that DO
      // ignore it, while plain `--all` skips ignored paths on its own.
      // Resetting just this root path back to HEAD then covers repos that do
      // NOT ignore it without staging deletions of any pre-existing tracked
      // runtime files.
      for (const args of [
        ['add', '--all'],
        ['reset', '-q', 'HEAD', '--', RUNTIME_INTERNAL_STATE_DIR],
        ['commit', '-m', commitMessage],
      ]) {
        await this.assertDeliveryInstructionFence(taskId, approvedInstructionRevision, `before_git_${args[0]}`);
        let result = await CommandService.runGit(args, task.worktreeLocation);
        // Another process briefly holding the worktree's index.lock (an editor's git integration, a status poll) is
        // transient: wait and retry the same command a bounded number of times instead of failing the delivery.
        for (let retry = 1; retry <= 5 && result.exitCode !== 0 && isTransientIndexLockFailure(`${result.stderr}${result.stdout}`); retry += 1) {
          await new Promise(resolve => setTimeout(resolve, 250 * retry));
          result = await CommandService.runGit(args, task.worktreeLocation);
        }
        if (result.exitCode !== 0) {
          throw new Error(`git ${args[0]} failed: ${result.stderr || result.stdout}`);
        }
      }
      const head = await CommandService.runGit(['rev-parse', 'HEAD'], task.worktreeLocation);
      if (head.exitCode !== 0) {
        throw new Error(`git rev-parse failed: ${head.stderr || head.stdout}`);
      }
      const commitSha = head.stdout.trim();
      if (!commitSha) throw new Error('git rev-parse returned an empty commit SHA.');

      const committing = await this.queue.get(taskId);
      if (!committing) throw new Error('Task disappeared while committing delivery.');
      const delivered = await this.queue.update(
        { ...committing, githubDelivery: { ...committing.githubDelivery, commitSha } },
        'delivery_committed',
        { commitSha },
      );
      let finalTask = delivered;
      finalTask = await this.validateCandidateDelivery(taskId, finalTask, commitSha, deliveryAccounting);
      if (finalTask.githubDelivery.transport === 'gh-cli' && finalTask.deliveryPolicy.createDraftPullRequest) {
        const remote = finalTask.githubDelivery.remote ?? 'origin';
        const baseBranch = finalTask.githubDelivery.baseBranch;
        if (!baseBranch) throw new Error('GitHub delivery requires a persisted base branch.');
        if (!finalTask.branchName) throw new Error('GitHub delivery requires a governed branch.');
        if (!finalTask.branchName.startsWith('forge/') || /^(main|master|dev\/current|develop|trunk)$/i.test(finalTask.branchName)) {
          throw new Error('Refusing to push a non-task or protected trunk branch.');
        }
        const push = await CommandService.runGit(
          ['push', '--set-upstream', remote, `${finalTask.branchName}:${finalTask.branchName}`],
          finalTask.worktreeLocation!,
        );
        if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr || push.stdout}`);
        finalTask = await this.queue.update(
          { ...finalTask, githubDelivery: { ...finalTask.githubDelivery, branchPushed: true } },
          'delivery_branch_pushed',
          { branch: finalTask.branchName, remote },
        );
        const creatingPullRequest = await this.queue.transition(
          taskId,
          'creating_pull_request',
          { gate: 'delivery', actor: 'user' },
        );
        finalTask = await new GitDeliveryService(
          new GhCliGitHubDeliveryTransport(delivered.worktreeLocation!),
        ).createDraftPullRequest({ ...finalTask, ...creatingPullRequest }, baseBranch);
        finalTask = await this.queue.update(finalTask, 'delivery_pull_request_created', {
          pullRequestNumber: finalTask.githubDelivery.pullRequestNumber,
          pullRequestUrl: finalTask.githubDelivery.pullRequestUrl,
        });
      }

      // M40 — for local (non-GitHub-issue) tasks, the task's delivery commit
      // otherwise lands only on an isolated worktree branch and is never
      // applied to the workspace the user actually has open. Attempt a
      // strictly-guarded fast-forward of the currently-open workspace before
      // allowing the task to reach `completed`. GitHub-issue-driven delivery
      // (draft PR above) is completely unaffected by this block.
      if (finalTask.origin !== 'github-issue' && finalTask.worktreeLocation && commitSha) {
        await this.assertDeliveryInstructionFence(taskId, approvedInstructionRevision, 'before_workspace_application');
        // The isolated worktree's dedicated branch (finalTask.branchName,
        // e.g. `forge/task-1-...`) is never checked out in the main
        // workspace — that is the whole point of the isolation. The branch
        // being delivered to is whatever the workspace was already on when
        // the task started; read it fresh here (the workspace-dirty and
        // HEAD-equals-worktreeBaseCommit checks below are what actually
        // guard against it having moved, not the branch name itself).
        const workspaceBranchResult = await CommandService.runGit(['branch', '--show-current'], this.workspaceRoot);
        const workspaceBranch = workspaceBranchResult.exitCode === 0 ? workspaceBranchResult.stdout.trim() : '';
        if (workspaceBranch && finalTask.destinationBranch !== workspaceBranch) {
          finalTask = { ...finalTask, destinationBranch: workspaceBranch };
          finalTask = await this.queue.update(finalTask, 'destination_branch_resolved', { destinationBranch: workspaceBranch });
        }
        const deliveryOutcome = await deliverLocally({
          workspaceRoot: this.workspaceRoot,
          taskRepositoryRoot: finalTask.repositoryRoot,
          taskBranch: workspaceBranch,
          worktreeBaseCommit: task.worktreeBaseCommit ?? '',
          taskCommitSha: commitSha,
          approvedCommitSha: commitSha,
          approvedChangedPaths: task.diffReview?.approvedScopePaths ?? [],
          trustedDirtyBaseline: task.trustedDirtyBaseline?.map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
        });
        if (!deliveryOutcome.delivered) {
          const manualCommand = buildManualApplyCommand({
            taskWorktreeLocation: finalTask.worktreeLocation!,
            taskBranch: finalTask.branchName ?? '',
            taskCommitSha: commitSha,
          });
          const blocked = await this.queue.update(
            {
              ...finalTask,
              failure: {
                classification: 'workspace_delivery_conflict',
                message: deliveryOutcome.detail
                  ? `Delivery to the open workspace was blocked (${deliveryOutcome.blockedReason}): ${deliveryOutcome.detail} Apply manually with: ${manualCommand}`
                  : `Delivery to the open workspace was blocked (${deliveryOutcome.blockedReason}). Apply manually with: ${manualCommand}`,
                at: new Date().toISOString(),
              },
            },
            'workspace_delivery_conflict',
            { blockedReason: deliveryOutcome.blockedReason, manualCommand },
          );
          if (blocked.state !== 'blocked') await this.queue.transition(taskId, 'blocked');
          // Preserve the task branch/worktree so the user can recover
          // manually — never dispose on this path.
          await this.finalizeLease(blocked, 'failed', false);
          await this.requireCoreAuthority(taskId)?.fail(
            `workspace_delivery_conflict: ${deliveryOutcome.blockedReason ?? 'unknown'}`,
          ).catch(() => undefined);
          // The specific classification is already persisted above; the
          // throw below only propagates control to the outer catch (e.g. to
          // reject the caller's promise) and must not let that catch
          // re-classify it as a generic runtime_error.
          deliveryFailureAlreadyClassified = true;
          throw new Error(`Delivery blocked: could not safely apply the result to the open workspace (${deliveryOutcome.blockedReason}).`);
        }
        // Best-effort SCM/explorer refresh; must never block completion.
        try {
          await refreshSourceControlBestEffort();
        } catch {
          // no-op — not every environment registers the built-in Git extension's command.
        }
      }

      await this.requireCoreAuthority(taskId)?.recordExecutionQuality({
        eventType: 'final_verification_recorded',
        metadata: {
          kind: 'verified_delivery',
          commitSha: finalTask.githubDelivery.commitSha ?? null,
          pullRequestUrl: finalTask.githubDelivery.pullRequestUrl ?? null,
        },
      });
      await this.requireCoreAuthority(taskId)?.complete({
        commitSha: finalTask.githubDelivery.commitSha ?? null,
        pullRequestUrl: finalTask.githubDelivery.pullRequestUrl ?? null,
      });
      const completed = await this.queue.transition(taskId, 'completed', { gate: 'delivery', actor: 'user', authority: 'core' });
      await this.finalizeLease({ ...finalTask, ...completed }, 'completed');
      await deliveryJournal.append({ t: 'delivery', phase: 'completed', attemptId: task.attemptId, detail: commitSha });
      await this.recordCompleteDecision(deliveryJournal, deliveryAccounting, task, `Delivered ${commitSha.slice(0, 12)} with validation evidence.`);
      await this.finishAccounting(taskId, task.attemptId, deliveryAccounting);
    } catch (error) {
      await deliveryJournal.append({ t: 'delivery', phase: 'aborted', attemptId: task.attemptId, detail: sanitizeMessage(error).slice(0, 160) }).catch(() => undefined);
      await this.finishAccounting(taskId, task.attemptId, deliveryAccounting);
      if (error instanceof Error && error.message === 'delivery_superseded_by_steering') {
        throw error;
      }
      if (!deliveryFailureAlreadyClassified) {
        await this.requireCoreAuthority(taskId)?.fail(sanitizeMessage(error)).catch(() => undefined);
      }
      const current = await this.queue.get(taskId);
      if (current && current.state !== 'completed' && current.state !== 'cancelled' && current.state !== 'failed') {
        // Confirmed defect (see INVESTIGATION_NOTE.md / M15AutonomousRuntime
        // regression test): this catch used to unconditionally overwrite
        // `failure` with the generic classifyRuntimeError(error)/'runtime_error'
        // bucket, silently discarding a more specific classification (e.g.
        // workspace_delivery_conflict) that inner logic above had already
        // persisted before throwing to reach here. The task still correctly
        // ended up blocked either way — this only affected the recorded
        // reason, never delivery safety.
        const failed = deliveryFailureAlreadyClassified
          ? current
          : await this.queue.update(
              { ...current, failure: { classification: classifyRuntimeError(error), message: sanitizeMessage(error), at: new Date().toISOString() } },
              'delivery_commit_failed',
              {},
            );
        if (failed.state !== 'blocked') await this.queue.transition(taskId, 'blocked');
        await this.finalizeLease(failed, 'failed', false);
      }
      throw error;
    }
  }

  /** Never invents an identity: it only asks Git whether one is configured, exactly as `git commit` would. */
  private async assertCommitIdentityAvailable(taskId: string, worktreeLocation: string): Promise<void> {
    for (const variable of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
      const probe = await CommandService.runGit(['var', variable], worktreeLocation);
      if (probe.exitCode !== 0 && isGitAuthorIdentityFailure(`${probe.stderr}${probe.stdout}`)) {
        await this.queue.recordProgress(taskId, `delivery_waiting_for_git_identity code=${GIT_AUTHOR_IDENTITY_UNAVAILABLE}`);
        this.log(taskId, `delivery_waiting_for_git_identity ${variable}`);
        throw new GitAuthorIdentityUnavailableError();
      }
    }
  }

  /**
   * Materializes the candidate commit through a fresh Git checkout before it
   * can be pushed or fast-forwarded. This uses the repository's actual Git
   * configuration and the candidate's .gitattributes, so validation observes
   * the same EOL/checkout representation the destination will receive.
   */
  private async validateCandidateDelivery(
    taskId: string,
    task: AutonomousTask,
    commitSha: string,
    accounting?: TaskAccountingSession,
  ): Promise<AutonomousTask> {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-delivery-verify-'));
    const checkoutRoot = path.join(temporaryRoot, 'checkout');
    let checkoutRegistered = false;
    try {
      const materialized = await CommandService.runGit(
        ['worktree', 'add', '--detach', checkoutRoot, commitSha],
        this.workspaceRoot,
      );
      if (materialized.exitCode !== 0) {
        throw new Error(`delivery_candidate_materialization_failed: ${materialized.stderr || materialized.stdout}`);
      }
      checkoutRegistered = true;
      const head = await CommandService.runGit(['rev-parse', 'HEAD'], checkoutRoot);
      if (head.exitCode !== 0 || head.stdout.trim() !== commitSha) {
        throw new Error('delivery_candidate_materialization_failed: candidate HEAD mismatch');
      }

      const commands = task.deliveryValidation?.commands ?? [];
      await this.queue.recordProgress(taskId, `pre_delivery_validation_started commands=${commands.length}`);
      const results = await this.inDeliveryValidationStage(accounting, () => new CodingValidationRunner(
        checkoutRoot,
        Config.getCommandTimeoutMs(),
        this.deliveryValidationRuntime(accounting, task, 'candidate_commit'),
      ).runAll(commands));
      const failures = results.filter(result => result.exitCode !== 0 || result.timedOut);
      // A failure in the delivered checkout that the validated worktree did not show is, on Windows, very often a
      // line-ending rendering difference rather than a content difference. Say so precisely when it is.
      const eolNote = failures.length > 0
        ? await this.describeDeliveryEolDifferences(commitSha, checkoutRoot, task.worktreeLocation)
        : '';
      const persisted = await this.queue.update({
        ...task,
        deliveryValidation: {
          commands,
          status: failures.length === 0 ? 'passed' : 'failed',
          root: `candidate-commit:${commitSha}`,
          results: results.map(result => ({
            command: result.command,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: result.durationMs,
            outputTail: redactValidationTail(result.output),
          })),
          verifiedAt: new Date().toISOString(),
        },
        ...(failures.length > 0 ? {
          failure: {
            classification: 'pre_delivery_validation_failed',
            message: `Candidate delivered-state validation failed: ${failures[0].command}${eolNote ? `. ${eolNote}` : ''}`,
            at: new Date().toISOString(),
          },
          validationFailure: {
            commandLabel: failures[0].command,
            exitCode: failures[0].exitCode,
            durationMs: failures[0].durationMs,
            stdoutStderrTail: redactValidationTail(failures[0].output) + (eolNote ? `\n${eolNote}` : ''),
            failingStage: 'validation' as const,
            worktree: task.worktreeLocation ?? checkoutRoot,
            retryAvailable: true,
            timedOut: failures[0].timedOut,
          },
        } : {}),
      }, 'pre_delivery_validation_completed', {
        commitSha,
        commands: results.length,
        failed: failures.length,
      });
      await this.queue.recordProgress(
        taskId,
        `pre_delivery_validation_completed commands=${results.length} failed=${failures.length}`,
      );
      if (failures.length > 0) {
        throw new Error('pre_delivery_validation_failed');
      }
      return persisted;
    } finally {
      if (checkoutRegistered) {
        await CommandService.runGit(['worktree', 'remove', '--force', checkoutRoot], this.workspaceRoot).catch(() => undefined);
      }
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /**
   * Files the candidate commit changed whose delivered bytes differ from the validated worktree bytes only by line
   * endings. Read-only: it compares and reports, it never rewrites either side. Best effort: any git/file error
   * yields no note rather than masking the validation failure it annotates.
   */
  private async describeDeliveryEolDifferences(commitSha: string, checkoutRoot: string, validatedRoot: string | undefined): Promise<string> {
    if (!validatedRoot) return '';
    try {
      const listed = await CommandService.runGit(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', commitSha], checkoutRoot);
      if (listed.exitCode !== 0) return '';
      const differences: EolDifference[] = [];
      for (const relative of listed.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
        const [validated, delivered] = await Promise.all([
          fs.readFile(path.join(validatedRoot, relative)).catch(() => undefined),
          fs.readFile(path.join(checkoutRoot, relative)).catch(() => undefined),
        ]);
        if (validated && delivered && isEolOnlyDifference(validated, delivered)) {
          differences.push({ path: relative, validated: detectEol(validated), delivered: detectEol(delivered) });
        }
      }
      if (differences.length === 0) return '';
      const autocrlf = await CommandService.runGit(['config', '--get', 'core.autocrlf'], checkoutRoot).catch(() => undefined);
      const setting = autocrlf?.exitCode === 0 && autocrlf.stdout.trim() ? `core.autocrlf=${autocrlf.stdout.trim()}` : 'core.autocrlf or .gitattributes';
      return describeEolDifferences(differences, setting);
    } catch {
      return '';
    }
  }

  private inDeliveryValidationStage<T>(accounting: TaskAccountingSession | undefined, fn: () => Promise<T>): Promise<T> {
    return accounting ? accounting.withStage('delivery_validation', fn) : fn();
  }

  /** Validation-runner hooks that charge delivery-time validation commands to the durable ledger. */
  private deliveryValidationRuntime(
    accounting: TaskAccountingSession | undefined,
    task: AutonomousTask,
    kind: string,
  ): { onCommandStarted?: (command: string, index: number, total: number) => void } {
    if (!accounting) return {};
    return {
      onCommandStarted: (_command, index) => accounting.recordToolCall(
        'delivery_validation_command',
        `${task.taskId}:delivery:${kind}:${index}`,
        { reason: 'delivery_validation_command' },
      ),
    };
  }

  private async assertDeliveryInstructionFence(
    taskId: string,
    approvedInstructionRevision: number,
    boundary: string,
  ): Promise<void> {
    const current = await this.queue.get(taskId);
    const superseding = current?.followUps.filter(item =>
      (item.sequence ?? 0) > approvedInstructionRevision
      && item.scopeChanging,
    ) ?? [];
    if (superseding.length === 0) return;
    await this.queue.applyPendingFollowUps(taskId, boundary, superseding.map(item => item.id));
    const refreshed = await this.queue.get(taskId);
    if (refreshed?.githubDelivery.commitSha) {
      await this.requireCoreAuthority(taskId)?.fail('delivery_superseded_after_commit').catch(() => undefined);
      await this.queue.update({
        ...refreshed,
        state: 'blocked',
        failure: {
          classification: 'delivery_superseded_after_commit',
          message: 'Scope-changing guidance arrived after the isolated commit but before workspace application; stale delivery was stopped and the preserved task branch requires reconciliation.',
          at: new Date().toISOString(),
        },
      }, 'delivery_superseded_after_commit', { boundary, followUpIds: superseding.map(item => item.id) });
    } else {
      await this.requeueForScopeChangingSteering(
        taskId,
        'delivery_superseded_by_steering',
        superseding.map(item => item.id),
      );
    }
    throw new Error('delivery_superseded_by_steering');
  }

  /** Governed rejection entry point; records the gate decision before cancellation. */
  async rejectDelivery(taskId: string): Promise<void> {
    const task = await this.queue.get(taskId);
    if (!task || task.state !== 'waiting_for_delivery_approval') {
      throw new Error('Task is not waiting for delivery approval.');
    }
    await this.resolveCoreGate(taskId, 'delivery', 'rejected', 'cancel');
    await this.queue.recordProgress(taskId, 'approval_rejected gate=delivery actor=user');
    const updated = {
      ...task,
      terminalResult: { status: 'cancelled' as const, summary: 'Delivery rejected by user.' },
    };
    await this.queue.update(updated, 'delivery_rejected', { gate: 'delivery', actor: 'user' });
    await this.queue.transition(taskId, 'cancelled', { gate: 'delivery', actor: 'user' });
    // The lease was left at status 'completed' (awaiting delivery) when the task first
    // reached the approval gate; now that delivery is genuinely done, finalize again so
    // a clean worktree is disposed and its slot released.
    await this.finalizeLease(updated, 'cancelled');
  }

  /**
   * Owned startup lifecycle: performs repository readiness and recovery. Never
   * rejects — expected obstacles (non-Git workspace, missing `git` executable,
   * or a recovery failure) become a bounded {@link AutonomousRuntimeStartupResult}
   * instead of a thrown/floating rejection. The low-frequency recovery timer only
   * starts once recovery has actually succeeded. Idempotent: repeated calls return
   * the same in-flight/completed startup.
   */
  start(coordinator: TaskRuntimeCoordinator): Promise<AutonomousRuntimeStartupResult> {
    if (!this.startupPromise) {
      this.startupPromise = this.runStartup(coordinator);
    }
    return this.startupPromise;
  }

  /** Defensive backstop for the composition root; start() itself never rejects. */
  reportUnexpectedStartupFailure(error: unknown): void {
    this.log('system', `autonomous_startup_unexpected_error ${sanitizeMessage(error)}`);
  }

  private async runStartup(coordinator: TaskRuntimeCoordinator): Promise<AutonomousRuntimeStartupResult> {
    if (this.disposed) return { status: 'disposed' };
    try {
      await coordinator.activateRecovery();
    } catch (error) {
      const status = classifyStartupError(error);
      const reason = sanitizeMessage(error);
      this.log('system', `autonomous_recovery_unavailable:${status} ${reason}`);
      return { status, reason };
    }
    if (this.disposed) return { status: 'disposed' };
    await this.rearmPendingGates();
    if (this.disposed) return { status: 'disposed' };
    this.recoveryTimer = setInterval(() => this.wake(), 45_000);
    this.recoveryTimer.unref?.();
    this.wake();
    return { status: 'ready' };
  }

  wake(): void {
    if (this.disposed) return;
    if (this.draining) {
      this.wakePending = true;
      return;
    }
    this.draining = true;
    this.currentDrain = this.drainLoop()
      .catch(error => this.log('drain_loop_error', error instanceof Error ? error.message : String(error)))
      .finally(() => {
        this.draining = false;
      });
  }

  /** Test/observability hook: resolves once the currently in-flight drain pass settles. */
  async waitForIdle(): Promise<void> {
    await this.currentDrain;
  }

  dispose(): void {
    this.disposed = true;
    if (this.recoveryTimer) clearInterval(this.recoveryTimer);
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    this.abortControllers.clear();
    // Runtime teardown (extension host shutdown, webview disposal, reload) must
    // NEVER fabricate a user approval/rejection/denial. Pending gates are simply
    // abandoned here (left unresolved — the process is going away) and the
    // interruption is recorded as actor=system so the task remains recoverable
    // and is NOT cancelled. A genuinely pending proposal/mutation stays persisted
    // in the task record (pendingProposal / pendingMutationApproval) and is
    // re-armed by rearmPendingGates() on the next startup.
    for (const [taskId, gate] of this.pendingProposalGates.entries()) {
      void this.queue
        .recordProgress(taskId, `approval_interrupted gate=proposal actor=system reason=runtime_disposed proposalId=${gate.proposalId}`)
        .catch(() => undefined);
    }
    this.pendingProposalGates.clear();
    for (const [taskId, gate] of this.pendingMutationGates.entries()) {
      void this.queue
        .recordProgress(taskId, `approval_interrupted gate=mutation actor=system reason=runtime_disposed requestId=${gate.requestId}`)
        .catch(() => undefined);
    }
    this.pendingMutationGates.clear();
    this.output?.dispose();
  }

  /**
   * Restores real, actionable gates for tasks that were left waiting for
   * proposal/mutation approval when the runtime was last disposed. Without
   * this, a restored UI card would point at an empty gate map and clicking
   * Approve would hang forever. The resolve callback performs the exact same
   * continuation the original in-flight reviewProposal/awaitMutationDecision
   * call would have performed, keyed to the persisted proposalId/requestId so
   * a stale approval (proposal changed since persistence) is rejected.
   */
  private async rearmPendingGates(): Promise<void> {
    const tasks = await this.queue.list();
    for (const task of tasks) {
      // Task-Scoped Autonomy V1 — a hands-off task interrupted mid-gate by a
      // restart must resume auto-authorizing, never surface a routine
      // approval card that nothing will ever click. Fire-and-forget: no
      // enclosing execution context exists here to propagate into, so this
      // is the one caller of autoAuthorizeGate that attaches its own catch
      // (a failure still leaves the task in a truthful blocked/failed state,
      // recorded by approveProposal/approveMutation/approveDelivery
      // themselves before they throw — see autoAuthorizeGate's own comment).
      const autonomyMode: KarkeAutonomyMode = task.autonomyMode ?? 'supervised';
      if (task.state === 'waiting_for_proposal_approval' && task.pendingProposal && !this.pendingProposalGates.has(task.taskId)) {
        const proposalId = task.pendingProposal.proposalId;
        this.pendingProposalGates.set(task.taskId, {
          proposalId,
          resolve: decision => this.completeProposalGate(task.taskId, proposalId, decision),
        });
        if (autonomyMode === 'hands_off') {
          void this.autoAuthorizeGate(task.taskId, 'proposal', proposalId).catch(error =>
            this.log(task.taskId, `hands_off_auto_authorize_error gate=proposal ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      if (task.state === 'waiting_for_mutation_approval' && task.pendingMutationApproval && !this.pendingMutationGates.has(task.taskId)) {
        const requestId = task.pendingMutationApproval.requestId;
        this.pendingMutationGates.set(task.taskId, {
          requestId,
          resolve: decision => this.completeMutationGate(task.taskId, requestId, decision),
        });
        if (autonomyMode === 'hands_off') {
          void this.autoAuthorizeGate(task.taskId, 'mutation', requestId).catch(error =>
            this.log(task.taskId, `hands_off_auto_authorize_error gate=mutation ${error instanceof Error ? error.message : String(error)}`));
        }
      }
      // Unlike proposal/mutation, delivery has no in-memory pending-gate
      // promise to rearm — approveDelivery is an ordinary async call that can
      // be invoked at any later time, independent of whatever routine
      // originally opened the gate. A restart simply needs to notice the
      // task is still `waiting_for_delivery_approval` and hands-off.
      if (task.state === 'waiting_for_delivery_approval' && autonomyMode === 'hands_off') {
        void this.autoAuthorizeGate(task.taskId, 'delivery').catch(error =>
          this.log(task.taskId, `hands_off_auto_authorize_error gate=delivery ${error instanceof Error ? error.message : String(error)}`));
      }
    }
  }

  /**
   * Continuation for a re-armed proposal gate resolved after a restart. The
   * governed run that produced the proposal died with the previous process,
   * so simply transitioning back to `running` would strand the task forever:
   * claimNext() only claims queued/scheduled/waiting_for_resources tasks, and
   * the next activation recovery would then block the orphaned `running`
   * record as recovery_required. Instead:
   *   - approved: requeue the task (clearing the dead process's claim) with
   *     the exact durable host-bound proposal checkpoint, so the replacement
   *     worker resumes after proposal review without generating or approving
   *     a second proposal.
   *   - revise: requeue for a fresh governed proposal because the user asked
   *     for a different artifact.
   *   - rejected: mirror the exact terminal outcome the in-flight path
   *     produces (reviewProposal -> false with no revision settles the
   *     attempt as cancelled in settleResult).
   */
  private async completeProposalGate(taskId: string, proposalId: string, decision: ProposalGateDecision): Promise<void> {
    await this.queue.recordProgress(
      taskId,
      `approval_${decision.kind === 'approved' ? 'approved' : decision.kind === 'rejected' ? 'rejected' : 'revision_requested'} gate=proposal actor=user proposalId=${proposalId}`,
    );
    const current = await this.queue.get(taskId);
    if (!current) return;
    if (decision.kind === 'rejected') {
      const cancelled: AutonomousTask = {
        ...current,
        pendingProposal: undefined,
        proposalRestartCheckpoint: undefined,
        claim: undefined,
        terminalResult: { status: 'cancelled', summary: 'Proposal rejected by user.' },
      };
      await this.queue.update(cancelled, 'proposal_rejected', { proposalId });
      await this.queue.transition(taskId, 'cancelled', { gate: 'proposal', actor: 'user' });
      await this.finalizeLease(cancelled, 'cancelled');
      return;
    }
    if (decision.kind === 'revise' && !decision.durableFollowUp) {
      // Consumed by runTask at the start of the re-run (restoredRevision), the
      // same way the in-flight revision loop consumes it after proposal_rejected.
      this.pendingRevisions.set(taskId, decision.instructions);
    }
    const requeued: AutonomousTask = {
      ...current,
      state: 'queued',
      pendingProposal: undefined,
      proposalRestartCheckpoint: decision.kind === 'approved' ? current.proposalRestartCheckpoint : undefined,
      claim: undefined,
    };
    await this.queue.update(requeued, `proposal_${decision.kind}`, { proposalId, requeuedAfterRestoredGate: true });
    if (!this.disposed) this.wake();
  }

  /**
   * Continuation for a re-armed mutation gate resolved after a restart. The
   * approved mutation's actual operations only ever existed in the dead
   * process's memory (the persisted PendingMutationSummary is a bounded
   * summary, not the diff), so nothing is ever applied from here — approval
   * requeues the task for a fresh governed run whose own gates all require
   * new decisions; denial mirrors the in-flight terminal outcome
   * (approveExecution -> false settles the attempt as cancelled).
   */
  private async completeMutationGate(taskId: string, requestId: string, decision: MutationGateDecision): Promise<void> {
    const approved = decision === 'approved';
    await this.queue.recordProgress(
      taskId,
      `approval_${approved ? 'approved' : decision === 'revise' ? 'invalidated' : 'denied'} gate=mutation actor=user requestId=${requestId}`,
    );
    const current = await this.queue.get(taskId);
    if (!current) return;
    if (decision === 'denied') {
      const cancelled: AutonomousTask = {
        ...current,
        pendingMutationApproval: undefined,
        claim: undefined,
        terminalResult: { status: 'cancelled', summary: 'Mutation denied by user.' },
      };
      await this.queue.update(cancelled, 'mutation_denied', { requestId });
      await this.queue.transition(taskId, 'cancelled', { gate: 'mutation', actor: 'user' });
      await this.finalizeLease(cancelled, 'cancelled');
      return;
    }
    const requeued: AutonomousTask = {
      ...current,
      state: 'queued',
      pendingMutationApproval: undefined,
      proposalRestartCheckpoint: decision === 'revise' ? undefined : current.proposalRestartCheckpoint,
      claim: undefined,
    };
    await this.queue.update(
      requeued,
      decision === 'revise' ? 'mutation_invalidated' : 'mutation_approved',
      { requestId, requeuedAfterRestoredGate: true },
    );
    if (!this.disposed) this.wake();
  }

  private async drainLoop(): Promise<void> {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.wakePending = false;
      if (this.disposed) return;
      const processed = await this.claimAndRunOne();
      if (!processed && !this.wakePending) return;
      if (this.disposed) return;
    }
  }

  private async claimAndRunOne(): Promise<boolean> {
    const task = await this.queue.claimNext(this.owner, CLAIM_LEASE_MS);
    if (!task) return false;
    if (this.coreAuthorityRequired && !this.coreAuthorities.has(task.taskId)) {
      await this.queue.update({
        ...task,
        state: 'blocked',
        claim: undefined,
        failure: {
          classification: 'core_authority_missing',
          message: 'Karke Dikha work cannot start without a claimed Core attempt.',
          at: new Date().toISOString(),
        },
      }, 'core_authority_missing', {});
      return true;
    }
    const decision = this.resources.canStart(task);
    if (!decision.ok) {
      await this.queue.transition(task.taskId, 'waiting_for_resources', { reason: decision.reason });
      await this.queue.releaseClaim(task.taskId, this.owner);
      return false;
    }
    this.resources.reserve(task);
    const abort = new AbortController();
    this.abortControllers.set(task.taskId, abort);
    try {
      await this.runTask(task, abort);
    } finally {
      this.resources.release(task.taskId);
      await this.queue.releaseClaim(task.taskId, this.owner);
      this.abortControllers.delete(task.taskId);
    }
    return true;
  }

  private async runTask(task: AutonomousTask, abort: AbortController): Promise<void> {
    const signal = abort.signal;
    let current = task;
    const coreAuthority = this.requireCoreAuthority(task.taskId);
    // Serializes every persisted write for this task so overlapping fire-and-forget
    // progress writes never race a state transition write to the same task.json file.
    let writeChain: Promise<unknown> = Promise.resolve();
    const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = writeChain.then(fn, fn);
      writeChain = next.catch(() => undefined);
      return next;
    };
    // Single explicit lease-lifecycle outcome for this attempt. Set once the task
    // stops actively mutating (settled or thrown); finalized in `finally` below so
    // every exit path releases the worktree write-scope lock exactly once, before
    // the drain loop is free to claim the next task.
    let leaseOutcome: 'completed' | 'failed' | 'cancelled' | undefined;
    // True only when the queue state is genuinely terminal for this attempt (not the
    // retryable 'blocked' state), i.e. it is safe to physically dispose a clean worktree.
    let leaseDisposalEligible = true;
    let heartbeat: NodeJS.Timeout | undefined;
    let generatedArtifactBaseline: ReadonlySet<string> | undefined;
    let accounting: TaskAccountingSession | undefined;
    try {
      if (coreAuthority) {
        const context = coreAuthority.context;
        if (
          task.taskId !== context.attemptId ||
          task.attemptId !== context.attemptId ||
          task.repositoryRoot !== context.workspaceRoot ||
          task.goal !== context.taskInput
        ) {
          throw new Error('core_frozen_context_mismatch');
        }
        await coreAuthority.heartbeat();
      }
      // claimNext() also returns tasks left in 'waiting_for_resources' by a prior
      // canStart() rejection (see claimAndRunOne above); those must route through
      // 'preparing' exactly like 'queued'/'scheduled', or the next transition below
      // (-> 'waiting_for_approval') is not a valid outgoing edge from
      // 'waiting_for_resources' in VALID_TRANSITIONS and throws.
      if (current.state === 'queued' || current.state === 'scheduled' || current.state === 'waiting_for_resources') {
        current = await serialize(() => this.queue.transition(current.taskId, 'preparing'));
      }
      await serialize(() => this.queue.recordProgress(current.taskId, 'preparing'));
      this.log(current.taskId, 'preparing');

      // Verify the persisted task text has not been altered since it was queued
      // (disk corruption, manual edit, partial write) before any graph dispatch.
      if (!verifyInputIntegrity(current)) {
        throw new Error('task_input_integrity_mismatch');
      }
      accounting = await this.openAccounting(current);

      if (current.taskKind === 'mutating' && !current.worktreeLocation) {
        const bound = await this.worktrees.bind(current);
        current = await serialize(() => this.queue.update(bound.task, 'worktree_bound', { branchName: bound.task.branchName }));
      }
      const workspaceRoot = current.worktreeLocation ?? current.repositoryRoot;
      if (current.taskKind === 'mutating') {
        // M42: a resumed block keeps its worktree; re-activate its lease, then re-verify identity.
        if (await this.worktrees.reactivateRetryableLease(current)) {
          this.log(current.taskId, 'worktree_lease_reactivated_for_resume');
        }
        await this.worktrees.assertBinding(current);
      }

      current = await serialize(() => this.queue.transition(current.taskId, 'waiting_for_approval'));
      await serialize(() => this.queue.recordProgress(current.taskId, 'approval_auto_approved gate=graph_dispatch policy=autonomous_runtime'));
      this.log(current.taskId, `approval_auto_approved gate=graph_dispatch policy=autonomous_runtime`);

      current = await serialize(() => this.queue.transition(current.taskId, 'running', { reason: 'graph_dispatch' }));
      await serialize(() => this.queue.recordProgress(current.taskId, 'running'));
      this.log(current.taskId, 'running');

      heartbeat = setInterval(() => {
        void serialize(async () => {
          const live = await this.queue.get(current.taskId);
          // A terminal/cancelling projection is already Core-fenced. Never
          // renew its lease and make a cancelled task look active again.
          if (!live || live.state === 'cancelling' || live.state === 'cancelled' || live.state === 'completed' || live.state === 'failed') return;
          await this.queue.heartbeat(current.taskId, this.owner, CLAIM_LEASE_MS);
        })
          .catch(error => this.log(current.taskId, `heartbeat_failed ${sanitizeMessage(error)}`));
        if (coreAuthority && !abort.signal.aborted) {
          void coreAuthority.heartbeat().catch(error => {
            this.log(current.taskId, `core_fence_lost ${sanitizeMessage(error)}`);
            abort.abort();
          });
        }
      }, CLAIM_HEARTBEAT_MS);
      heartbeat.unref?.();

      let reachedRunning = true;
      const taskId = current.taskId;

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          // Progress & Completion UX V1 (Step 3 closure pass): this native OS
          // notification used to show the raw internal task id as its title
          // for the whole run — exactly the implementation-level identifier
          // this milestone keeps off the normal surface. The webview already
          // shows the real progress; this toast only needs to say the task
          // is running.
          title: 'KarkeDikha: Working on your task',
          cancellable: true,
        },
        async (_progress, token) => {
          const listener = token.onCancellationRequested(() => abort.abort());
          let result: GovernedCodingExecutionResult;
          let recoveryTerminal: RecoveryDecision | undefined;
          try {
            // M42 task-level recovery control plane. Absent only if the durable
            // journal cannot be opened, in which case the run degrades to the
            // pre-M42 linear workflow rather than executing without checkpoints.
            const recovery = await this.openRecovery(current, workspaceRoot, accounting, coreAuthority?.context.modelSelection);
            let pendingDirectives: RecoveryDirectives | undefined;
            let resumeProposal: HostBoundCodingProposal | undefined;
            let recoveryHalt: string | undefined;
            if (recovery) {
              this.recoveries.set(taskId, recovery);
              await recovery.prepareRun(current.instructionRevision ?? 0);
              if (current.proposalRestartCheckpoint) {
                // An approval restored after a restart authorizes only the contract it was
                // granted for. A steering revision or a different proposal invalidates it.
                const restored = verifyRestoredContract(
                  recovery.journal.state.contracts,
                  current.proposalRestartCheckpoint,
                  current.instructionRevision ?? 0,
                );
                if (!restored.ok) {
                  this.log(taskId, `recovery_stale_approval_rejected reason=${restored.reason}`);
                  await serialize(() => this.queue.recordProgress(taskId, `recovery_stale_approval_rejected reason=${restored.reason}`));
                  current = await serialize(() => this.queue.update({ ...current, proposalRestartCheckpoint: undefined, pendingProposal: undefined }, 'stale_approval_rejected', { reason: restored.reason }));
                }
              }
              const terminalOnDisk = recovery.terminal;
              const journalDelivery = recovery.journal.state.delivery;
              if (journalDelivery?.phase === 'started') {
                recoveryHalt = 'delivery_state_uncertain: delivery had started but was never confirmed or aborted; verify the destination before retrying so it cannot be delivered twice';
              } else if (terminalOnDisk?.terminalState === 'COMPLETE') {
                recoveryHalt = 'task_already_completed: the recovery journal records this task as delivered; it is never executed again';
              } else {
                const plan = await recovery.startupPlan();
                if (plan.kind === 'resume_validation') {
                  resumeProposal = plan.proposal;
                  await serialize(() => this.queue.recordProgress(taskId, 'recovery_resume_validation mutation_already_applied=true'));
                  this.log(taskId, `recovery_resume_validation ${plan.detail.join(',').slice(0, 200)}`);
                } else if (plan.kind === 'uncertain') {
                  recoveryHalt = `mutation_state_uncertain: on-disk state matches neither the pre nor the post mutation state (${plan.detail.join(',').slice(0, 200)})`;
                }
              }
            }
            // M44: mission-level supervision above this single attempt. Absent only if the
            // durable checkpoint store cannot be opened, in which case the run degrades to
            // the pre-M44 behavior (recovery-only, no checkpoint/stall/pressure supervision).
            const mission = await this.openMission(current);
            if (mission) this.missions.set(taskId, mission);
            let goal = current.effectiveGoal ?? current.goal;
            if (coreAuthority?.context.retryGuidance) {
              goal = `${goal}\n\nRetry guidance from the user:\n${coreAuthority.context.retryGuidance}`;
            }
            let proposalVersion = 1;
            // A revision requested against a re-armed (restart-recovered)
            // proposal gate is stashed by completeProposalGate() before the
            // task is requeued; apply it to this fresh run exactly like the
            // in-flight revision loop below applies one mid-run.
            const restoredRevision = this.consumePendingRevision(taskId);
            if (restoredRevision) {
              proposalVersion += 1;
              goal = `${current.goal}\n\nRevision instructions (v${proposalVersion}):\n${restoredRevision}`;
              await serialize(() => this.queue.recordProgress(taskId, `proposal_revision_started version=${proposalVersion}`));
              this.log(taskId, `proposal_revision_started version=${proposalVersion}`);
            }
            // One authoritative execution profile for this attempt: it decides
            // both whether the fixed five-stage graph runs at all and (via
            // requirements) what model capability would be needed if it does.
            // Never used once resuming a proposal already approved before a
            // restart, since that proposal already reflects whichever path
            // originally produced it.
            let executionProfile: ExecutionProfile = classifyExecutionProfile(goal);
            for (;;) {
              const beforeProposal = await this.queue.applyPendingFollowUps(taskId, 'before_proposal');
              if (beforeProposal.instructions.length > 0) {
                goal = beforeProposal.effectiveGoal;
                executionProfile = classifyExecutionProfile(goal);
                current = (await this.queue.get(taskId)) ?? current;
              }
              current = await serialize(() => this.queue.resolveExecutionRouting(taskId, goal));
              executionProfile = current.executionProfile ?? classifyExecutionProfile(goal);
              const deterministicWrite = executionProfile.useDeterministicProposal && !current.proposalRestartCheckpoint
                ? current.deterministicProposal ?? parseDeterministicFileWrite(goal)
                : undefined;
              const frozenSelection = coreAuthority?.context.modelSelection;
              const escalationRoute = frozenSelection?.selectedProvider === 'host'
                && frozenSelection.selectedModel === 'deterministic'
                ? frozenSelection.escalationCandidates[0]
                : undefined;
              let routedProvider = executionProfile.useDeterministicProposal
                ? undefined
                : (pendingDirectives?.model?.provider as ProviderType | undefined)
                  ?? escalationRoute?.provider
                  ?? coreAuthority?.context.selectedProvider
                  ?? frozenRoutingValue(current.providerModelRoutingSnapshot['provider']) as ProviderType | undefined;
              let routedModel = executionProfile.useDeterministicProposal
                ? undefined
                : pendingDirectives?.model?.model
                  ?? escalationRoute?.model
                  ?? coreAuthority?.context.selectedModel
                  ?? frozenRoutingValue(current.providerModelRoutingSnapshot['model']);
              // M44: a provider whose circuit breaker just tripped (recent real
              // failure, still cooling down) is never redispatched on this pass
              // to "retry the same thing and hope" — the same synthetic-outcome
              // seam the stall detector uses feeds this into the EXISTING
              // RecoveryController as one more `provider_failure` occurrence,
              // so its own (already-tested) CHANGE_MODEL candidate selection
              // decides the reroute; this never becomes a second router. Never
              // re-vetoes a route the controller just explicitly picked via
              // CHANGE_MODEL directives (`pendingDirectives.model`) — that
              // decision already IS this provider's escalation response;
              // re-synthesizing another provider_failure against it would
              // fight the ladder it just walked instead of trusting it.
              if (mission && recovery && routedProvider && !pendingDirectives?.model && !executionProfile.useDeterministicProposal && mission.isProviderOpen(routedProvider)) {
                this.log(taskId, `mission_provider_breaker_open provider=${routedProvider}`);
                const breakerOutcome = mission.synthesizeProviderOutcome({
                  attemptId: current.attemptId,
                  pass: recovery.journal.state.passes + 1,
                  provider: routedProvider,
                  model: routedModel,
                });
                const breakerDecision = await recovery.controller.decide(breakerOutcome);
                await recovery.commit(breakerDecision);
                await serialize(() => this.queue.recordProgress(taskId, `mission_provider_breaker_open ${formatRecoveryProgress(breakerDecision)}`));
                if (breakerDecision.terminalState) {
                  recoveryTerminal = breakerDecision;
                  result = haltedExecutionResult(`${current.attemptId}-v${proposalVersion}`, breakerDecision.reason);
                  break;
                }
                pendingDirectives = breakerDecision.directives;
                if (breakerDecision.directives.resumeAtValidation) {
                  resumeProposal = recovery.appliedProposal();
                } else {
                  proposalVersion += 1;
                }
                current = {
                  ...((await this.queue.get(taskId)) ?? current),
                  pendingProposal: undefined,
                  proposalRestartCheckpoint: undefined,
                  pendingMutationApproval: undefined,
                };
                continue;
              }
              // M50: a persisted frozen routing decision is reused exactly. Only structural availability is
              // re-checked; an unrunnable model stops the attempt, it is never silently replaced.
              if (!recoveryHalt && frozenSelection && frozenSelection.selectedProvider !== 'host' && !executionProfile.useDeterministicProposal
                && !pendingDirectives?.model && !escalationRoute && routedModel === frozenSelection.selectedModel) {
                const installed = await (async () => {
                  try {
                    return await (await ProviderGateway.create(this.context.secrets)).listModels(signal);
                  } catch {
                    return undefined;
                  }
                })();
                const frozenCheck = checkFrozenModelRunnable({
                  frozenProvider: frozenSelection.selectedProvider,
                  frozenModel: frozenSelection.selectedModel,
                  activeProvider: Config.getProviderType(),
                  installedModels: installed,
                });
                if (!frozenCheck.runnable) recoveryHalt = frozenCheck.diagnostic;
              }
              if (recoveryHalt) {
                await recovery?.journal.append({ t: 'terminal', terminalState: 'BLOCKED_RESUMABLE', reason: recoveryHalt });
                recoveryTerminal = haltDecision(current.attemptId, recoveryHalt);
                result = haltedExecutionResult(`${current.attemptId}-v${proposalVersion}`, recoveryHalt);
                break;
              }
              // M44: sustained resource pressure checkpoints the mission and pauses
              // dispatch (bounded — never an indefinite hang) until it clears.
              if (mission?.isUnderResourcePressure()) {
                await mission.checkpointNow();
                await serialize(() => this.queue.recordProgress(taskId, 'mission_resource_pressure_checkpoint'));
                this.log(taskId, 'mission_resource_pressure_pause');
                const pressureDeadline = Date.now() + (this.missionOverrides?.resourcePressureMaxPauseMs ?? RESOURCE_PRESSURE_MAX_PAUSE_MS);
                const pollMs = this.missionOverrides?.resourcePressurePollMs ?? RESOURCE_PRESSURE_POLL_MS;
                while (mission.isUnderResourcePressure() && Date.now() < pressureDeadline && !signal.aborted) {
                  await sleep(pollMs);
                }
                this.log(taskId, mission.isUnderResourcePressure() ? 'mission_resource_pressure_timeout_resuming' : 'mission_resource_pressure_cleared');
              }
              const resumeForPass = resumeProposal;
              resumeProposal = undefined;
              const passHandle = recovery
                ? await recovery.beginPass({
                  attemptId: current.attemptId,
                  // Without a frozen Core selection the executor falls back to the configured coding model;
                  // recovery must know which model that is (M46 uses it for its economy tier and strategies).
                  model: executionProfile.useDeterministicProposal
                    ? { provider: routedProvider, model: routedModel }
                    : { provider: routedProvider ?? Config.getProviderType(), model: routedModel ?? Config.getCodingModel() },
                  directives: pendingDirectives,
                  goal: executionProfile.useDeterministicProposal ? undefined : goal,
                  resumeProposal: resumeForPass,
                  instructionRevision: (await this.queue.get(taskId))?.instructionRevision ?? current.instructionRevision ?? 0,
                })
                : undefined;
              generatedArtifactBaseline = await captureGeneratedArtifactBaseline(workspaceRoot);
              const missionContext = mission?.contextInjection(recovery?.journal.state.passes ?? 0);
              result = await this.executor.execute({
                runId: `${current.attemptId}-v${proposalVersion}${passHandle && passHandle.pass > 1 ? `-r${passHandle.pass}` : ''}`,
                goal: missionContext ? `${goal}\n\n${missionContext}` : goal,
                workspaceRoot,
                configWorkspaceRoot: current.repositoryRoot,
                signal,
                secrets: this.context.secrets,
                auditSource: 'autonomous-task',
                auditMetadata: { taskId: current.taskId },
                extensionBuild: this.extensionBuild(),
                providerType: routedProvider as ProviderType | undefined,
                model: routedModel,
                // M42: cloud fallback is permitted only when explicitly permitted
                // by the applicable governance configuration (e.g. Core authority
                // modelSelection.routingPolicy === 'local-first-cloud-fallback').
                // An explicit user model override stays authoritative and never routes to
                // another model/provider.
                automaticModelSelection: frozenSelection !== undefined && frozenSelection.userOverrode !== true,
                // The RecoveryController is the single owner of cloud authorization after the
                // first dispatch: its directive can only narrow, never widen, this policy.
                cloudFallbackPermitted: (coreAuthority
                  ? (coreAuthority.context.modelSelection?.routingPolicy as string) === 'local-first-cloud-fallback'
                  : Config.getModelRoutingPolicy() === 'local-first-cloud-fallback')
                  && (pendingDirectives?.cloudAuthorized ?? true),
                executionProfile,
                maxValidationRepairCycles: coreAuthority || resumeForPass ? 2 : 0,
                recovery: passHandle?.session,
                accounting,
                instructionRevision: current.instructionRevision ?? 0,
                resumeAfterProposalApproval: current.proposalRestartCheckpoint,
                deterministicProposal: deterministicWrite
                  ? { path: deterministicWrite.path, content: deterministicWrite.content, reason: 'Deterministic exact-content file write (trivial execution profile — no model invoked).' }
                  : undefined,
                pendingSteering: () => this.drainSteering(taskId, 'graph_stage_boundary'),
                callbacks: {
                  onProgress: phase => {
                    // M15AutonomousRuntime is the authoritative lifecycle authority
                    // for proposal, mutation, and delivery gates. It records its own truthful
                    // approval_requested, approval_waiting, and approval_approved events with
                    // the exact gateActor (hands_off_policy or user). GovernedCodingExecutor's
                    // internal callbacks hardcode actor=user, which would duplicate events
                    // and falsely attribute hands-off approvals to the user.
                    if (phase.startsWith('approval_')) return;
                    void serialize(() => this.queue.recordProgress(taskId, phase));
                    this.log(taskId, phase);
                  },
                  onEvidence: async evidence => {
                    await coreAuthority?.recordExecutionQuality(evidence);
                  },
                  checkReadiness: async targetPaths =>
                    new ForgeExecutionReadiness(workspaceRoot, {
                      trusted: true,
                      extensionBuild: this.extensionBuild(),
                    }).check(targetPaths ?? []),
                  reviewProposal: proposal => this.awaitingHuman(accounting, () => this.reviewProposal(current, proposal, proposalVersion, serialize)),
                  approveExecution: proposal => this.awaitingHuman(accounting, () => this.approveExecution(current, proposal, proposalVersion, serialize)),
                  confirmElevated: envelope => this.awaitingHuman(accounting, () => this.confirmElevated(current, envelope, serialize)),
                },
              });
              const beforeValidation = await this.queue.applyPendingFollowUps(taskId, 'before_validation');
              const afterExecution = await this.queue.get(taskId);
              if (
                beforeValidation.instructions.some(item => item.scopeChanging)
                && beforeValidation.effectiveGoal !== goal
              ) {
                if (result.executableProposal?.operations.length) {
                  await this.discardSupersededPaths(
                    workspaceRoot,
                    result.executableProposal.operations.map(operation => operation.path),
                  );
                }
                proposalVersion += 1;
                goal = beforeValidation.effectiveGoal;
                current = {
                  ...(afterExecution ?? current),
                  pendingProposal: undefined,
                  proposalRestartCheckpoint: undefined,
                  pendingMutationApproval: undefined,
                };
                executionProfile = classifyExecutionProfile(goal);
                await serialize(() => this.queue.recordProgress(taskId, `steering_replan_started version=${proposalVersion} boundary=before_validation`));
                continue;
              }
              if (
                (result.status === 'proposal_rejected' || result.status === 'execution_rejected')
                && afterExecution?.effectiveGoal
                && afterExecution.effectiveGoal !== goal
              ) {
                proposalVersion += 1;
                goal = afterExecution.effectiveGoal;
                current = {
                  ...afterExecution,
                  pendingProposal: undefined,
                  proposalRestartCheckpoint: undefined,
                  pendingMutationApproval: undefined,
                };
                executionProfile = classifyExecutionProfile(goal);
                await serialize(() => this.queue.recordProgress(taskId, `steering_replan_started version=${proposalVersion}`));
                continue;
              }
              if (
                recovery && passHandle
                && result.status !== 'cancelled'
                && result.status !== 'proposal_rejected'
                && result.status !== 'execution_rejected'
              ) {
                // observe -> classify -> decide -> PERSIST -> (dispatch | stop). The decision and
                // its dispatch/terminal record are durable before the next dispatch or settle.
                let decision = await recovery.observe(result, passHandle, goal);
                await recovery.commit(decision);
                if (mission) {
                  await mission.recordPass({ result, journalState: recovery.journal.state, goal });
                  mission.recordProviderOutcome(passHandle.model?.provider, providerReachabilityForCause(decision.cause));
                  // M44: a mission-level stall/repeated-failure signal, detected next to the same
                  // journal bookkeeping RecoveryController already folds, is fed into that SAME
                  // controller as a synthetic outcome rather than acted on directly here — this
                  // never becomes a second, competing decision mechanism. Only checked on an
                  // otherwise-clean CONTINUE: a pass that already produced its own decision keeps it.
                  if (decision.action === 'CONTINUE') {
                    const verdict = mission.evaluateProgress(recovery.journal.state);
                    if (verdict.kind !== 'progressing') {
                      const stallOutcome = mission.synthesizeStallOutcome({ attemptId: current.attemptId, pass: passHandle.pass, verdict });
                      const stallDecision = await recovery.controller.decide(stallOutcome);
                      await recovery.commit(stallDecision);
                      this.log(taskId, `mission_${verdict.kind}_detected`);
                      decision = stallDecision;
                    }
                  }
                }
                const decisionProgress = formatRecoveryProgress(decision);
                // A stage that simply succeeded (CONTINUE) is journaled and logged but is not a
                // timeline event: nothing needed recovering.
                if (decision.action !== 'CONTINUE') await serialize(() => this.queue.recordProgress(taskId, decisionProgress));
                this.log(taskId, decisionProgress);
                if (decision.terminalState === undefined && decision.action !== 'CONTINUE') {
                  pendingDirectives = decision.directives;
                  if (decision.directives.resumeAtValidation) {
                    resumeProposal = recovery.appliedProposal();
                  } else {
                    proposalVersion += 1;
                  }
                  current = {
                    ...((await this.queue.get(taskId)) ?? current),
                    pendingProposal: undefined,
                    proposalRestartCheckpoint: undefined,
                    pendingMutationApproval: undefined,
                  };
                  continue;
                }
                pendingDirectives = undefined;
                recoveryTerminal = decision.terminalState ? decision : undefined;
              }
              if (result.status !== 'proposal_rejected') break;
              const revision = this.consumePendingRevision(taskId);
              if (!revision) break;
              proposalVersion += 1;
              goal = `${current.goal}\n\nRevision instructions (v${proposalVersion}):\n${revision}`;
              await serialize(() => this.queue.recordProgress(taskId, `proposal_revision_started version=${proposalVersion}`));
              this.log(taskId, `proposal_revision_started version=${proposalVersion}`);
            }
          } finally {
            listener.dispose();
          }
          await writeChain;
          leaseOutcome = await this.settleResult(current, result, reachedRunning, generatedArtifactBaseline, recoveryTerminal);
          // settleResult can itself land the task in the retryable 'blocked' state
          // while still reporting 'failed' for write-scope release purposes; only
          // dispose the worktree when the queue state is genuinely terminal.
          const settledState = (await this.queue.get(current.taskId))?.state;
          leaseDisposalEligible = settledState === 'failed' || settledState === 'cancelled' || settledState === 'completed';
        },
      );
    } catch (error) {
      await writeChain.catch(() => undefined);
      const persisted = await this.queue.get(current.taskId);
      // Cancellation is committed by cancelTask() before the in-flight
      // executor necessarily observes its fence. A late executor rejection
      // must not write the stale pre-cancellation `current` snapshot back over
      // that terminal state or report the already-cancelled Core attempt as a
      // failure.
      if (persisted?.state === 'cancelled') {
        leaseOutcome = 'cancelled';
        leaseDisposalEligible = true;
        this.log(current.taskId, `late_runtime_error_after_cancellation ${sanitizeMessage(error)}`);
        return;
      }
      const interruptedAtPersistedUserGate = this.disposed && (
        (persisted?.state === 'waiting_for_proposal_approval' && Boolean(persisted.pendingProposal)) ||
        (persisted?.state === 'waiting_for_mutation_approval' && Boolean(persisted.pendingMutationApproval))
      );
      if (interruptedAtPersistedUserGate) {
        this.log(current.taskId, `runtime_disposed_at_user_gate state=${persisted.state}`);
        return;
      }
      await coreAuthority?.fail(sanitizeMessage(error)).catch(coreError =>
        this.log(current.taskId, `core_failure_rejected ${sanitizeMessage(coreError)}`));
      await this.queue.update(
        { ...current, failure: { classification: classifyRuntimeError(error), message: sanitizeMessage(error), at: new Date().toISOString() } },
        'task_runtime_error',
        {},
      );
      const refreshed = await this.queue.get(current.taskId);
      if (refreshed && refreshed.state !== 'cancelled' && refreshed.state !== 'blocked' && refreshed.state !== 'completed' && refreshed.state !== 'failed') {
        await this.queue.transition(current.taskId, 'blocked');
      }
      leaseOutcome = 'failed';
      this.log(current.taskId, `runtime_error ${sanitizeMessage(error)}`);
      // 'blocked' is retryable (blocked -> queued is a valid transition), so its
      // worktree/evidence must survive even though the lease is marked 'failed' to
      // release the write-scope lock for other tasks.
      const settledState = (await this.queue.get(current.taskId))?.state;
      leaseDisposalEligible = settledState === 'failed' || settledState === 'cancelled';
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      this.recoveries.get(current.taskId)?.release();
      this.recoveries.delete(current.taskId);
      const mission = this.missions.get(current.taskId);
      if (mission) {
        // A genuinely terminal completion has no further use for durable mission
        // memory; a retryable/blocked/cancelled attempt keeps it for the next resume.
        if (leaseOutcome === 'completed') await mission.retireOnCompletion();
        else await mission.checkpointNow();
        mission.dispose();
        this.missions.delete(current.taskId);
      }
      await this.finishAccounting(current.taskId, current.attemptId, accounting);
      await this.finalizeLease(current, leaseOutcome, leaseDisposalEligible);
    }
  }

  /**
   * M42 observe-only accounting. Failure here is logged and swallowed: the
   * ledger must never block, delay or fail autonomous execution.
   */
  /** The live journal for a running task, or a freshly opened one (e.g. delivery after the run ended). */
  private async journalFor(taskId: string): Promise<AttemptJournal> {
    return this.recoveries.get(taskId)?.journal ?? AttemptJournal.open({ repositoryRoot: this.workspaceRoot, taskId });
  }

  /** COMPLETE is recorded only here, after verified delivery — never inferred from a green stage. */
  private async recordCompleteDecision(
    journal: AttemptJournal,
    accounting: TaskAccountingSession | undefined,
    task: AutonomousTask,
    reason: string,
  ): Promise<void> {
    const decisionSeq = accounting ? await accounting.allocateDecisionSequence() : journal.state.lastDecisionSeq + 1;
    await journal.append({
      t: 'decision',
      decision: {
        schemaVersion: 1,
        decisionSeq,
        attemptId: task.attemptId,
        pass: journal.state.passes,
        action: 'COMPLETE',
        terminalState: 'COMPLETE',
        reason,
        expectedChange: [],
        directives: { seedEvidencePaths: [], guidance: [], cloudAuthorized: false, resumeAtValidation: false },
        budget: { exhausted: false },
        decidedAt: new Date().toISOString(),
      },
    });
    await journal.append({ t: 'terminal', terminalState: 'COMPLETE', reason });
  }

  /** Records the exact contract an approval gate opens against (best effort; never blocks the gate). */
  private async recordContractGate(taskId: string, gate: string, proposal: HostBoundCodingProposal, instructionRevision: number): Promise<void> {
    try {
      const journal = await this.journalFor(taskId);
      await journal.append({
        t: 'contract',
        gate,
        digest: contractDigest({ instructionRevision, proposal }),
        instructionRevision,
        proposalFingerprint: mutationProposalFingerprint(proposal),
      });
      await this.recoveries.get(taskId)?.noteWaitingForApproval(gate, `${taskId}`);
    } catch (error) {
      this.log(taskId, `recovery_contract_record_failed ${sanitizeMessage(error)}`);
    }
  }

  /**
   * M42: opens the durable AttemptJournal + deterministic RecoveryController for this task.
   * Model policy is derived from the frozen Core selection: a user-pinned model is never
   * replaced, cloud is authorised only by the explicit routing policy, and the candidate
   * pool is the Core-observed local escalation list. Failure to open degrades to no-recovery.
   */
  private async openRecovery(
    task: AutonomousTask,
    worktreeRoot: string,
    accounting: TaskAccountingSession | undefined,
    selection: (NonNullable<Parameters<typeof buildRecoveryCandidates>[0]> & { userOverrode?: boolean; routingPolicy?: string }) | undefined,
  ): Promise<RecoverySupervisor | undefined> {
    try {
      const pinned = selection?.userOverrode === true;
      const cloudPolicy = selection
        ? selection.routingPolicy === 'local-first-cloud-fallback'
        : Config.getModelRoutingPolicy() === 'local-first-cloud-fallback';
      return await RecoverySupervisor.open({
        repositoryRoot: this.workspaceRoot,
        taskId: task.taskId,
        worktreeRoot,
        accounting,
        candidates: buildRecoveryCandidates(selection),
        modelPolicy: { pinned, fallbackAllowedWhenPinned: false, cloudAuthorized: cloudPolicy && !pinned },
        // M46: bounded Context Packs, subgoal shaping and evidence widening. The isolated task worktree is
        // read through the filesystem fallback (fresh, no index to build); every failure inside degrades to
        // the plain M42 behaviour.
        // OLLAMA_AGENT_M46_AUTONOMY=0 is a kill switch (and the A/B baseline): exactly the M42 behaviour.
        adaptiveSchema: process.env.OLLAMA_AGENT_M46_AUTONOMY !== '0',
        autonomy: process.env.OLLAMA_AGENT_M46_AUTONOMY === '0' ? undefined : {
          economyFor: economyForModel,
          resourcePressure: () => this.missions.get(task.taskId)?.isUnderResourcePressure() === true,
        },
        resolveBaseRevision: async () => {
          const head = await CommandService.runGit(['rev-parse', 'HEAD'], worktreeRoot);
          return head.exitCode === 0 ? head.stdout.trim() || undefined : undefined;
        },
        log: message => this.log(task.taskId, message),
      });
    } catch (error) {
      this.log(task.taskId, `recovery_journal_unavailable ${sanitizeMessage(error)}`);
      return undefined;
    }
  }

  /**
   * M44: opens (or restores, on restart) the durable mission checkpoint and
   * the mission-level stall/checkpoint/compaction/provider/resource
   * scheduler. Failure to open degrades to no mission supervision — the M42
   * recovery loop still runs unchanged, exactly like `openRecovery` degrades.
   */
  private async openMission(task: AutonomousTask): Promise<MissionRuntimeSupervisor | undefined> {
    try {
      const { resourcePressureMaxPauseMs: _pauseMs, resourcePressurePollMs: _pollMs, ...missionOnly } = this.missionOverrides ?? {};
      return await MissionRuntimeSupervisor.open({
        managedStorageRoot: this.context.globalStorageUri.fsPath,
        taskId: task.taskId,
        objective: task.goal,
        log: message => this.log(task.taskId, message),
        ...missionOnly,
      });
    } catch (error) {
      this.log(task.taskId, `mission_supervisor_unavailable ${sanitizeMessage(error)}`);
      return undefined;
    }
  }

  private async openAccounting(task: AutonomousTask): Promise<TaskAccountingSession | undefined> {
    try {
      const ledger = await TaskBudgetLedger.open({
        repositoryRoot: this.workspaceRoot,
        taskId: task.taskId,
        contract: {
          taskSchemaVersion: task.schemaVersion,
          inputDigest: task.inputIntegrity?.inputDigest,
          instructionRevision: task.instructionRevision ?? 0,
        },
        onWouldBlock: observation => this.log(
          task.taskId,
          `budget_would_block resource=${observation.resource} limit=${observation.limit} projected=${observation.projected} limitValue=${observation.limitValue} stage=${observation.stage}`,
        ),
      });
      await ledger.beginAttempt(task.attemptId, { instructionRevision: task.instructionRevision ?? 0 });
      return new TaskAccountingSession(ledger, {
        attemptId: task.attemptId,
        log: message => this.log(task.taskId, message),
      });
    } catch (error) {
      this.log(task.taskId, `budget_ledger_unavailable ${sanitizeMessage(error)}`);
      return undefined;
    }
  }

  /** Human-wait time is measured separately from active execution (M42 observe-only accounting). */
  private awaitingHuman<T>(accounting: TaskAccountingSession | undefined, fn: () => Promise<T>): Promise<T> {
    return accounting ? accounting.withApprovalWait(fn) : fn();
  }

  private async finishAccounting(taskId: string, attemptId: string, accounting: TaskAccountingSession | undefined): Promise<void> {
    if (!accounting) return;
    try {
      const summary = await accounting.finish();
      await this.queue.recordEvent(taskId, 'budget_observed', {
        attemptId,
        mode: summary.mode,
        totals: summary.totals,
        taskAgeMs: summary.taskAgeMs,
        byStage: summary.byStage,
        recoveryByFailureClass: summary.recoveryByFailureClass,
        unresolvedCharged: summary.unresolvedCharged,
        wouldBlockCount: summary.wouldBlockCount,
        wouldBlock: summary.wouldBlock.slice(0, 10),
      });
      this.log(taskId, formatBudgetSummary(summary));
    } catch (error) {
      this.log(taskId, `budget_summary_failed ${sanitizeMessage(error)}`);
    }
  }

  private async finalizeLease(
    task: AutonomousTask,
    outcome?: 'completed' | 'failed' | 'cancelled',
    dispose = true,
  ): Promise<void> {
    if (!outcome || !task.worktreeLocation) return;
    try {
      const result = await this.worktrees.finalize(task, outcome, { dispose });
      if (!result.disposed && result.reason && result.reason !== 'awaiting_delivery' && result.reason !== 'retryable_not_terminal') {
        await this.queue.recordProgress(task.taskId, `worktree_cleanup_skipped reason=${result.reason}`).catch(() => undefined);
        this.log(task.taskId, `worktree_cleanup_skipped reason=${result.reason}`);
      }
    } catch (error) {
      // Finalization failure must be persisted, not swallowed, but must not throw
      // back into the drain loop (the task itself has already settled).
      await this.queue.update(task, 'lease_finalization_failed', { message: sanitizeMessage(error) }).catch(() => undefined);
      this.log(task.taskId, `lease_finalization_failed ${sanitizeMessage(error)}`);
    }
  }

  private async settleResult(
    task: AutonomousTask,
    result: GovernedCodingExecutionResult,
    reachedRunning: boolean,
    generatedArtifactBaseline?: ReadonlySet<string>,
    recoveryTerminal?: RecoveryDecision,
  ): Promise<'completed' | 'failed' | 'cancelled' | undefined> {
    const taskId = task.taskId;
    const coreAuthority = this.requireCoreAuthority(taskId);
    const persistedAtSettlement = await this.queue.get(taskId);
    // User cancellation is committed by cancelTask() before the model/tool
    // promise necessarily observes AbortSignal. A late completion/failure is
    // therefore only cleanup, never a second terminal transition.
    if (persistedAtSettlement?.state === 'cancelled') return 'cancelled';
    if (persistedAtSettlement?.state === 'cancelling') {
      await coreAuthority?.cancel();
      const cancelling = await this.queue.get(taskId);
      if (cancelling?.state === 'cancelling') {
        await this.queue.update(
          { ...cancelling, terminalResult: { status: 'cancelled', summary: 'Cancelled by user; Core attempt fenced.' } },
          'task_cancelled_pending',
          { actor: 'user', coreFenced: Boolean(coreAuthority) },
        );
        await this.queue.transition(taskId, 'cancelled', { actor: 'user', coreFenced: Boolean(coreAuthority) });
      }
      return 'cancelled';
    }
    if (result.status === 'completed' || result.status === 'validation_failed') {
      const latestBeforeValidation = await this.queue.get(taskId);
      const currentRevision = latestBeforeValidation?.instructionRevision ?? 0;
      if (
        task.taskKind === 'mutating'
        && (
          !result.mutationEvidence
          || result.mutationEvidence.instructionRevision !== currentRevision
          || !result.mutationEvidence.contentVerified
          || (!result.mutationEvidence.gitDiffPresent && !result.mutationEvidence.alreadySatisfied)
        )
      ) {
        const current = latestBeforeValidation ?? task;
        await this.queue.update(
          {
            ...current,
            failure: {
              classification: 'mutation_evidence_missing',
              message: 'KarkeDikha could not verify a repository-visible mutation for the latest approved instruction.',
              at: new Date().toISOString(),
            },
          },
          'mutation_evidence_rejected',
          { expectedRevision: currentRevision, evidenceRevision: result.mutationEvidence?.instructionRevision },
        );
        await coreAuthority?.fail('mutation_evidence_missing');
        await this.queue.transition(taskId, 'blocked');
        return 'failed';
      }
      if (latestBeforeValidation && result.mutationEvidence) {
        await this.queue.update(
          {
            ...latestBeforeValidation,
            mutationEvidence: result.mutationEvidence,
            deliveryValidation: {
              commands: [...(result.executableProposal?.validationCommands ?? result.proposal?.validationCommands ?? [])],
              status: 'pending',
            },
          },
          'mutation_evidence_verified',
          {
            instructionRevision: result.mutationEvidence.instructionRevision,
            changedPaths: result.mutationEvidence.changedPaths,
            alreadySatisfied: result.mutationEvidence.alreadySatisfied,
          },
        );
      }
      if (result.repairAttempts > 0) {
        const repairCurrent = await this.queue.get(taskId);
        if (repairCurrent) {
          await this.queue.update(
            { ...repairCurrent, validationRepairAttempts: result.repairAttempts },
            'validation_repair_recorded',
            { repairAttempts: result.repairAttempts },
          );
        }
      }
      await coreAuthority?.beginValidation();
      await this.queue.transition(taskId, 'validating');
      await this.queue.recordProgress(taskId, 'validating');
      const gateDecision = await this.evaluateQualityGate(task, result);
      this.log(taskId, `m16_gate_result status=${gateDecision.status} findings=${gateDecision.findings.length}`);
      const withGate = await this.queue.get(taskId);
      if (withGate) {
        await this.queue.update(
          {
            ...withGate,
            qualityGate: {
              gateId: 'm15-autonomous-delivery-quality-gate',
              runId: gateDecision.runId,
              status: gateDecision.status,
              findingsCount: gateDecision.findings.length,
              decidedAt: gateDecision.decidedAt,
            },
          },
          'quality_gate_evaluated',
          { status: gateDecision.status },
        );
      }
      // Diff review (objective-relevance/scope/security) runs whenever the
      // M16 safety gate itself passed, regardless of whether coding
      // validation (tsc/tests) also succeeded — confirmed defect: it used to
      // run only when `result.status === 'completed'`, so a validation
      // failure (however unrelated to the change, e.g. a pre-existing
      // environment-dependent test gap) silently skipped the one stage that
      // checks whether the actual diff addresses the task goal at all,
      // leaving an irrelevant change reported as plain `validation_failed`
      // with no indication it was never relevant in the first place.
      let diffVerdict: DiffReviewVerdict | undefined;
      if (gateDecision.status === 'passed') {
        // Phase 5 — independent post-implementation actual-diff review, run
        // after deterministic validation and the M16 gate, before delivery
        // approval. Distinct from the pre-mutation FixedMultiAgentGraph
        // proposal reviewer; never presented as that stage.
        const workspaceRoot = task.worktreeLocation ?? task.repositoryRoot;
        const baseline = generatedArtifactBaseline ?? await captureGeneratedArtifactBaseline(workspaceRoot);
        const approvedScopePaths = (result.executableProposal?.operations ?? result.proposal?.operations ?? []).map(op => op.path);

        // Phase 6 — explicit stage routing for the reviewer stage. A
        // preferred candidate exists only when a model reviewer was
        // constructor-injected (`stageReviewer`); otherwise routing always
        // falls back to the deterministic host, which reproduces the exact
        // pre-Phase-6 behavior while making the decision and its reason
        // persisted and inspectable.
        const reviewerRouting = routeStage({
          stage: 'reviewer',
          preferred: this.stageReviewer
            ? {
                provider: task.providerModelRoutingSnapshot['reviewerProvider'] ?? task.providerModelRoutingSnapshot['provider'] ?? 'configured',
                model: task.providerModelRoutingSnapshot['reviewerModel'] ?? task.providerModelRoutingSnapshot['model'] ?? 'configured',
                available: true,
              }
            : undefined,
        });
        this.log(taskId, `stage_routing stage=reviewer provider=${reviewerRouting.provider} model=${reviewerRouting.model} reason=${reviewerRouting.routingReason}`);
        const withRouting = await this.queue.get(taskId);
        if (withRouting) {
          await this.queue.update(
            { ...withRouting, stageRouting: { ...(withRouting.stageRouting ?? {}), reviewer: reviewerRouting } },
            'stage_routed',
            { stage: 'reviewer', provider: reviewerRouting.provider, model: reviewerRouting.model, routingReason: reviewerRouting.routingReason, fallbackReason: reviewerRouting.fallbackReason },
          );
        }

        diffVerdict = result.proposal
          ? result.mutationEvidence?.alreadySatisfied
            ? {
                verdict: 'pass' as const,
                requirementFindings: [],
                changedFileFindings: [],
                validationFindings: [],
                securityFindings: [],
                objectiveRelevanceFindings: [],
                explanation: 'The approved destination state was explicitly verified as already satisfied; no diff is required.',
                reviewerProvider: 'host',
                reviewerModel: 'deterministic',
                reviewedDiffFingerprint: await computeReviewedContentFingerprint(workspaceRoot, '', []),
              }
            : await runDiffReviewStage({
              workspaceRoot,
              verifiedProposal: result.proposal,
              approvedScopePaths,
              validationResults: result.validations.map(v => ({ command: v.command, exitCode: v.exitCode, timedOut: v.timedOut })),
              qualityGateStatus: gateDecision.status === 'passed' ? 'passed' : 'failed',
              originalTaskGoal: task.goal,
              reviewerVerdict: reviewerRouting.fallbackReason ? undefined : this.stageReviewer,
              baselineArtifacts: baseline,
            })
          : undefined;
        this.log(taskId, `diff_review_result verdict=${diffVerdict?.verdict ?? 'skipped'}`);
        if (diffVerdict) {
          await this.recoveries.get(taskId)?.journal.append({
            t: 'reviewer',
            attemptId: task.attemptId,
            verdict: diffVerdict.verdict,
            findings: [
              ...diffVerdict.requirementFindings,
              ...diffVerdict.changedFileFindings,
              ...diffVerdict.securityFindings,
              ...diffVerdict.objectiveRelevanceFindings,
            ].slice(0, 12),
          }).catch(() => undefined);
        }
        const withDiffReview = await this.queue.get(taskId);
        if (withDiffReview && diffVerdict) {
          await this.queue.update(
            {
              ...withDiffReview,
              diffReview: {
                verdict: diffVerdict.verdict,
                requirementFindings: diffVerdict.requirementFindings,
                changedFileFindings: diffVerdict.changedFileFindings,
                validationFindings: diffVerdict.validationFindings,
                securityFindings: diffVerdict.securityFindings,
                objectiveRelevanceFindings: diffVerdict.objectiveRelevanceFindings,
                explanation: diffVerdict.explanation,
                reviewerProvider: diffVerdict.reviewerProvider,
                reviewerModel: diffVerdict.reviewerModel,
                decidedAt: new Date().toISOString(),
                approvedScopePaths,
                reviewedDiffFingerprint: diffVerdict.reviewedDiffFingerprint,
                instructionRevision: result.mutationEvidence?.instructionRevision ?? 0,
              },
            },
            'diff_review_evaluated',
            { verdict: diffVerdict.verdict },
          );
        }
        // A rejection whose ONLY evidence is `validationFindings` is not new
        // information — it just restates the same command failure the outer
        // `validation_failed` classification (below) already reports more
        // specifically. Only let diff review's OWN classification
        // (`diff_review_rejected`) take priority when it found something
        // validation_failed does not already say: an out-of-scope/missing
        // file, a detected secret, or an objective-relevance mismatch (or a
        // configured model reviewer's own requirement findings).
        const diffReviewHasIndependentRejection = Boolean(
          diffVerdict && diffVerdict.verdict !== 'pass' && (
            diffVerdict.changedFileFindings.length > 0
            || diffVerdict.securityFindings.length > 0
            || diffVerdict.objectiveRelevanceFindings.length > 0
            || diffVerdict.requirementFindings.length > 0
          ),
        );
        if (diffReviewHasIndependentRejection && diffVerdict) {
          await coreAuthority?.reportValidation({
            commands: result.validations.map(validation => ({
              command: validation.command,
              exitCode: validation.exitCode,
              timedOut: validation.timedOut,
              durationMs: validation.durationMs,
            })),
            qualityGateStatus: gateDecision.status,
            diffReviewVerdict: 'reject',
          });
          const current = await this.queue.get(taskId);
          if (current) {
            await this.queue.update(
              {
                ...current,
                failure: {
                  classification: 'diff_review_rejected',
                  message: diffVerdict.explanation || 'Independent diff review rejected the actual changes.',
                  at: new Date().toISOString(),
                },
              },
              'task_blocked_pending',
              {},
            );
          }
          await this.queue.transition(taskId, 'blocked');
          this.log(taskId, 'blocked:diff_review_rejected');
          // Progress & Completion UX V1 (Step 3 closure pass): no raw task id
          // in a native OS toast — the humanized reason and full evidence
          // already render in the KarkeDikha panel (see
          // media/chat-everyday.js#humanizeClassification).
          void vscode.window.showWarningMessage('KarkeDikha: Task blocked — the implementation did not pass final review. See the KarkeDikha panel for details.').then(undefined, () => undefined);
          return 'failed';
        }
      }
      if (result.status === 'completed' && gateDecision.status === 'passed') {
        const coreValidation = await coreAuthority?.reportValidation({
          commands: result.validations.map(validation => ({
            command: validation.command,
            exitCode: validation.exitCode,
            timedOut: validation.timedOut,
            durationMs: validation.durationMs,
          })),
          qualityGateStatus: gateDecision.status,
          diffReviewVerdict: diffVerdict?.verdict ?? 'skipped',
        });
        if (coreValidation) {
          if (coreValidation.outcome !== 'waiting_for_delivery_approval') {
            throw new Error('core_rejected_delivery_progression');
          }
          this.coreApprovals.set(this.approvalKey(taskId, 'delivery'), coreValidation.approval);
        }
        // Guidance can arrive while deterministic validation, the quality
        // gate, or diff review is running. Consume it before exposing delivery
        // eligibility. Scope-changing guidance rejects the just-created Core
        // delivery envelope as stale and requeues this same durable task with
        // its existing isolated-worktree evidence intact.
        const validationSteering = await this.queue.applyPendingFollowUps(taskId, 'validation_complete');
        if (validationSteering.instructions.some(item => item.scopeChanging)) {
          if (coreValidation) {
            await this.resolveCoreGate(taskId, 'delivery', 'rejected', 'revise');
          }
          await this.requeueForScopeChangingSteering(
            taskId,
            'validation_superseded_by_steering',
            validationSteering.instructions.map(item => item.id),
          );
          return undefined;
        }
        await this.queue.transition(taskId, 'waiting_for_delivery_approval');
        await this.queue.recordProgress(taskId, 'waiting_for_delivery_approval');
        this.log(taskId, 'waiting_for_delivery_approval');
        const pending = await this.queue.get(taskId);
        const deliveryBoundarySteering = await this.queue.applyPendingFollowUps(taskId, 'before_delivery_eligibility');
        if (deliveryBoundarySteering.instructions.some(item => item.scopeChanging)) {
          if (coreValidation) {
            await this.resolveCoreGate(taskId, 'delivery', 'rejected', 'revise');
          }
          await this.requeueForScopeChangingSteering(
            taskId,
            'delivery_eligibility_superseded_by_steering',
            deliveryBoundarySteering.instructions.map(item => item.id),
          );
          return undefined;
        }
        if (pending) {
          // Task-Scoped Autonomy V1 — frozen at task creation; see
          // KarkeAutonomyMode. approveDelivery re-runs every existing safety
          // precondition itself (worktree binding, commit-scope
          // reconciliation, reviewed-diff fingerprint,
          // LocalDeliveryService's dirty-workspace/stale-baseline/worktree
          // checks) regardless of caller, so calling it here is exactly as
          // safe as a user click; an uncaught throw here propagates into
          // settleResult's caller (runTask's own catch block), which already
          // turns any such error into a truthful blocked/failed task.
          const autonomyMode: KarkeAutonomyMode = pending.autonomyMode ?? 'supervised';
          if (autonomyMode === 'hands_off') {
            try {
              await this.autoAuthorizeGate(taskId, 'delivery');
            } catch (error) {
              if (!isGitAuthorIdentityUnavailableError(error)) throw error;
              // Delivery is paused on a Git prerequisite, not failed: surface the
              // delivery gate so the user can approve again once Git is configured.
              void Promise.resolve(this.deliveryApprovalListener?.(pending)).catch(() => undefined);
            }
          } else {
            void Promise.resolve(this.deliveryApprovalListener?.(pending)).catch(() => undefined);
          }
        }
        // Delivery approval still needs this active lease to validate and commit the
        // isolated worktree. It is finalized only after approval succeeds or is rejected.
        return undefined;
      } else {
        // Either the M16 gate itself failed (diff review never ran above),
        // or the gate passed and diff review found the change relevant,
        // scoped and clean but coding validation (tsc/tests) genuinely
        // failed — `validation_failed` still takes priority whenever it
        // applies, matching this branch's pre-existing classification
        // choice. `diffReviewVerdict` now reflects whatever actually ran
        // instead of always reporting 'skipped'.
        const classification = result.status === 'validation_failed' ? 'validation_failed' : `quality_gate_${gateDecision.status}`;
        await coreAuthority?.reportValidation({
          commands: result.validations.map(validation => ({
            command: validation.command,
            exitCode: validation.exitCode,
            timedOut: validation.timedOut,
            durationMs: validation.durationMs,
          })),
          qualityGateStatus: gateDecision.status,
          diffReviewVerdict: diffVerdict?.verdict ?? 'skipped',
        });
        const current = await this.queue.get(taskId);
        if (current) {
          const failedValidation = result.validations.find(validation => validation.exitCode !== 0 || validation.timedOut);
          await this.queue.update(
            {
              ...current,
              failure: withRecoveryFailure(
                { classification, message: 'Validation or quality gate blocked delivery progression.', at: new Date().toISOString() },
                recoveryTerminal,
              ),
              validationFailure: classification === 'validation_failed' && failedValidation ? {
                commandLabel: failedValidation.command,
                exitCode: failedValidation.exitCode,
                durationMs: failedValidation.durationMs,
                stdoutStderrTail: redactValidationTail(failedValidation.output),
                failingStage: 'validation',
                worktree: task.worktreeLocation ?? task.repositoryRoot,
                retryAvailable: task.attempt <= task.maxRetries,
                timedOut: failedValidation.timedOut,
              } : undefined,
            },
            'task_blocked_pending',
            {},
          );
        }
        await this.queue.transition(taskId, 'blocked');
        this.log(taskId, `blocked:${classification}`);
        // Progress & Completion UX V1 (Step 3 closure pass): no raw task id
        // or internal classification code in a native OS toast — the
        // humanized reason and full evidence already render in the
        // KarkeDikha panel (see media/chat-everyday.js#humanizeClassification).
        void vscode.window.showWarningMessage('KarkeDikha: Task blocked. See the KarkeDikha panel for details.').then(undefined, () => undefined);
      }
      return 'failed';
    }

    if (result.status === 'proposal_rejected' || result.status === 'execution_rejected' || result.status === 'cancelled') {
      await coreAuthority?.cancel();
      const current = await this.queue.get(taskId);
      if (current) {
        await this.queue.update(
          { ...current, terminalResult: { status: 'cancelled', summary: result.failureReason ?? result.status } },
          'task_cancelled_pending',
          {},
        );
      }
      await this.queue.transition(taskId, 'cancelled');
      this.log(taskId, `cancelled:${result.status}`);
      return 'cancelled';
    }

    const current = await this.queue.get(taskId);
    await coreAuthority?.fail(result.failureReason ?? result.status);
    if (current) {
      const graphFailureEvidence = buildGraphFailureEvidence(result);
      await this.queue.update(
        {
          ...current,
          failure: withRecoveryFailure(
            { classification: result.status, message: result.failureReason ?? result.status, at: new Date().toISOString() },
            recoveryTerminal,
          ),
          graphFailureEvidence,
          evidence: appendEvidence(current.evidence, result),
        },
        'task_blocked_pending',
        { classification: result.status, graphFailureEvidence },
      );
    }
    await this.queue.transition(taskId, 'blocked');
    this.log(taskId, blockedLogMessage(result));
    // Progress & Completion UX V1 (Step 3 closure pass): no raw task id or
    // internal status code in a native OS toast — the humanized reason and
    // full evidence already render in the KarkeDikha panel (see
    // media/chat-everyday.js#humanizeClassification).
    void vscode.window.showWarningMessage('KarkeDikha: Task blocked. See the KarkeDikha panel for details.').then(undefined, () => undefined);
    return 'failed';
  }

  private async evaluateQualityGate(task: AutonomousTask, result: GovernedCodingExecutionResult) {
    const store = new M16EvaluationStore(this.workspaceRoot);
    const runner = new M16EvaluationRunner(store);
    const service = new M16QualityGateService(runner);
    const subject: M16EvaluationSubject = { kind: 'autonomous-task', id: task.taskId, repositoryId: task.repositoryId, trusted: false };
    const zeroCommandAttestation = completedZeroCommandValidationAttestation(task.attemptId, result);
    const input: M16EvaluationInput = {
      task,
      evidenceRecords: [
        { id: `approval-${task.attemptId}`, kind: 'policy', content: `policy_decision=approved run=${task.attemptId} task=${task.taskId}` },
        ...result.validations.map(validation => ({
          id: validation.command,
          kind: 'validation' as const,
          content: `command=${validation.command} exit=${validation.exitCode} timedOut=${validation.timedOut}`,
        })),
        // A proposal with zero applicable validation commands (legitimate for
        // trivial/docs-only changes in repos with no test harness) still runs
        // the governed validation phase to completion. Without a record of
        // that phase, validation-evidence-completeness fails closed and every
        // such task dies at "validation_or_quality_gate_failed" right after
        // mutation approval — the runtime, as the authority that executed the
        // phase, must attest it.
        ...(zeroCommandAttestation ? [zeroCommandAttestation] : []),
      ],
      untrustedInputs: task.origin === 'github-issue' ? [task.instructions] : [],
      mutationAttemptAfterFailure: false,
      packageRuntime: this.packageRuntimeEvidence(),
    };
    return service.evaluate(defaultM16AutonomousDeliveryGate(), subject, input);
  }

  private packageRuntimeEvidence(): { commands: string[]; scripts: string[]; loadedFromPackage: boolean } {
    const pkg = (this.context as vscode.ExtensionContext & { extension?: { packageJSON?: Record<string, unknown> } }).extension?.packageJSON;
    const contributes = pkg?.contributes as { commands?: Array<{ command?: unknown }> } | undefined;
    const commands = Array.isArray(contributes?.commands)
      ? contributes!.commands!.map(entry => entry.command).filter((command): command is string => typeof command === 'string')
      : [];
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts as Record<string, unknown>) : [];
    return { commands, scripts, loadedFromPackage: Boolean(pkg) };
  }

  /**
   * In-chat proposal approval gate. Persists a bounded, non-sensitive proposal
   * summary, transitions the task to `waiting_for_proposal_approval`, and
   * suspends until the webview resolves the exact pending proposal via
   * {@link approveProposal}, {@link rejectProposal} or
   * {@link requestProposalRevision}. A revision resolves this promise `false`
   * (so the executor reports `proposal_rejected`) and stashes the revision
   * instructions for the drain loop in {@link runTask} to consume and re-run.
   */
  private async reviewProposal(
    task: AutonomousTask,
    proposal: HostBoundCodingProposal,
    version: number,
    serialize: SerializeFn,
  ): Promise<boolean> {
    if (this.disposed) return false;
    const current = await serialize(() => this.queue.get(task.taskId)) ?? task;
    const instructionRevision = current.instructionRevision ?? 0;
    await this.recordContractGate(task.taskId, 'proposal', proposal, instructionRevision);
    const proposalId = computeProposalFingerprint(task.taskId, version, instructionRevision, proposal);
    const summary: PendingProposalSummary = {
      proposalId,
      version,
      instructionRevision,
      taskSummary: proposal.taskSummary,
      operations: proposal.operations.map(op => ({ type: op.type, path: op.path, reason: op.reason })),
      validationCommands: proposal.validationCommands.map(command => ({ kind: command.kind, script: command.script })),
      warnings: proposal.warnings,
    };
    // Every read-modify-write against the persisted task record for this gate
    // must go through the same `serialize` chain the drain loop uses for
    // progress writes; otherwise a concurrent fire-and-forget progress write
    // can read a stale task (missing pendingProposal) and clobber it back out.
    const withProposal = await serialize(() => this.queue.update(
      { ...current, proposalVersion: version, pendingProposal: summary, proposalRestartCheckpoint: proposal },
      'proposal_pending',
      // Persist the full summary (not just taskSummary) so a resolved card
      // can be rehydrated verbatim into a fresh webview session from this
      // durable event alone — see AgentPanel.rehydrateResolvedApprovalCards.
      { ...summary },
    ));
    const decisionPromise = new Promise<ProposalGateDecision>(resolve => {
      this.pendingProposalGates.set(task.taskId, { proposalId, resolve });
    });
    const coreAuthority = this.requireCoreAuthority(task.taskId);
    if (coreAuthority) {
      const approval = await coreAuthority.requestApproval('proposal', { ...summary });
      this.coreApprovals.set(this.approvalKey(task.taskId, 'proposal'), approval);
    }
    // Task-Scoped Autonomy V1 — frozen at task creation, never re-read from a
    // live UI selector; see KarkeAutonomyMode.
    const autonomyMode: KarkeAutonomyMode = current.autonomyMode ?? 'supervised';
    const gateActor = autonomyMode === 'hands_off' ? 'hands_off_policy' : 'user';
    await serialize(() => this.queue.transition(task.taskId, 'waiting_for_proposal_approval'));
    await serialize(() => this.queue.recordProgress(task.taskId, `approval_requested gate=proposal actor=${gateActor} proposalId=${proposalId} version=${version}`));
    const pending = await serialize(() => this.queue.get(task.taskId)) ?? withProposal;
    if (autonomyMode === 'hands_off') {
      await this.autoAuthorizeGate(task.taskId, 'proposal', proposalId);
    } else {
      void Promise.resolve(this.proposalApprovalListener?.(pending)).catch(() => undefined);
    }
    const decision = await decisionPromise;
    await serialize(() => this.queue.recordProgress(task.taskId, `approval_${decision.kind === 'approved' ? 'approved' : decision.kind === 'rejected' ? 'rejected' : 'revision_requested'} gate=proposal actor=${gateActor} proposalId=${proposalId}`));
    const refreshed = await serialize(() => this.queue.get(task.taskId));
    if (refreshed) {
      await serialize(() => this.queue.update(
        { ...refreshed, pendingProposal: undefined, proposalRestartCheckpoint: undefined },
        `proposal_${decision.kind}`,
        { proposalId },
      ));
    }
    if (!this.disposed) await serialize(() => this.queue.transition(task.taskId, 'running'));
    if (decision.kind === 'revise' && !decision.durableFollowUp) {
      this.pendingRevisions.set(task.taskId, decision.instructions);
    }
    return decision.kind === 'approved';
  }

  private async approveExecution(task: AutonomousTask, proposal: HostBoundCodingProposal, version: number, serialize: SerializeFn): Promise<boolean> {
    if (this.disposed) return false;
    const current = await serialize(() => this.queue.get(task.taskId)) ?? task;
    const instructionRevision = current.instructionRevision ?? 0;
    const proposalId = computeProposalFingerprint(task.taskId, version, instructionRevision, proposal);
    await this.recordContractGate(task.taskId, 'execution', proposal, instructionRevision);
    const requestId = `${task.attemptId}:mutation:r${instructionRevision}:v${version}`;
    return this.awaitMutationDecision(task, requestId, {
      requestId,
      proposalId,
      instructionRevision,
      operationCount: proposal.operations.length,
      targets: proposal.operations.map(op => op.path),
      elevatedConfirmationRequired: false,
      repairPolicy: {
        maxCycles: 2,
        allowedPaths: proposal.operations.map(op => op.path),
        validationCommands: proposal.validationCommands.map(command => ({ kind: command.kind, script: command.script, args: command.args })),
      },
    }, serialize);
  }

  private async confirmElevated(task: AutonomousTask, envelope: ApprovalEnvelope, serialize: SerializeFn): Promise<boolean> {
    if (this.disposed) return false;
    const requestId = `${task.attemptId}:elevated:${envelope.nonce}`;
    return this.awaitMutationDecision(task, requestId, {
      requestId,
      proposalId: envelope.proposalHash,
      instructionRevision: (await serialize(() => this.queue.get(task.taskId)))?.instructionRevision ?? task.instructionRevision ?? 0,
      operationCount: envelope.operations.length,
      targets: envelope.operations.map(op => op.path),
      elevatedConfirmationRequired: true,
    }, serialize);
  }

  private async awaitMutationDecision(task: AutonomousTask, requestId: string, summary: PendingMutationSummary, serialize: SerializeFn): Promise<boolean> {
    const current = await serialize(() => this.queue.get(task.taskId)) ?? task;
    // Persist the full summary (not just requestId) so a resolved card can be
    // rehydrated verbatim into a fresh webview session from this durable
    // event alone — see AgentPanel.rehydrateResolvedApprovalCards.
    const withMutation = await serialize(() => this.queue.update({ ...current, pendingMutationApproval: summary }, 'mutation_pending', { ...summary }));
    const approvalPromise = new Promise<MutationGateDecision>(resolve => {
      this.pendingMutationGates.set(task.taskId, { requestId, resolve });
    });
    const coreAuthority = this.requireCoreAuthority(task.taskId);
    if (coreAuthority) {
      const approval = await coreAuthority.requestApproval('mutation', { ...summary });
      this.coreApprovals.set(this.approvalKey(task.taskId, 'mutation'), approval);
    }
    // Task-Scoped Autonomy V1 — frozen at task creation, never re-read from a
    // live UI selector; see KarkeAutonomyMode.
    const autonomyMode: KarkeAutonomyMode = current.autonomyMode ?? 'supervised';
    const gateActor = autonomyMode === 'hands_off' ? 'hands_off_policy' : 'user';
    await serialize(() => this.queue.transition(task.taskId, 'waiting_for_mutation_approval'));
    await serialize(() => this.queue.recordProgress(task.taskId, `approval_requested gate=mutation actor=${gateActor} requestId=${requestId} elevated=${summary.elevatedConfirmationRequired}`));
    const pending = await serialize(() => this.queue.get(task.taskId)) ?? withMutation;
    if (autonomyMode === 'hands_off') {
      await this.autoAuthorizeGate(task.taskId, 'mutation', requestId);
    } else {
      void Promise.resolve(this.mutationApprovalListener?.(pending)).catch(() => undefined);
    }
    const decision = await approvalPromise;
    const approved = decision === 'approved';
    await serialize(() => this.queue.recordProgress(task.taskId, `approval_${approved ? 'approved' : decision === 'revise' ? 'invalidated' : 'denied'} gate=mutation actor=${gateActor} requestId=${requestId}`));
    const refreshed = await serialize(() => this.queue.get(task.taskId));
    if (refreshed) {
      await serialize(() => this.queue.update(
        { ...refreshed, pendingMutationApproval: undefined },
        approved ? 'mutation_approved' : decision === 'revise' ? 'mutation_invalidated' : 'mutation_denied',
        { requestId },
      ));
    }
    // Must go through the same serialize chain as the pendingMutationApproval clear
    // above (and matching the proposal gate's equivalent transition) — otherwise this
    // unserialized read-modify-write can race a concurrent fire-and-forget progress
    // write, which can read a stale task snapshot (still carrying pendingMutationApproval)
    // and clobber the just-cleared field back onto disk.
    if (!this.disposed) await serialize(() => this.queue.transition(task.taskId, 'running'));
    return !this.disposed && approved;
  }

  private consumePendingRevision(taskId: string): string | undefined {
    const revision = this.pendingRevisions.get(taskId);
    this.pendingRevisions.delete(taskId);
    return revision;
  }

  onProposalApprovalRequired(listener: (task: AutonomousTask) => void | Promise<void>): void {
    this.proposalApprovalListener = listener;
  }

  onMutationApprovalRequired(listener: (task: AutonomousTask) => void | Promise<void>): void {
    this.mutationApprovalListener = listener;
  }

  /** Approves the exact pending proposal. Rejects (throws) a stale, mismatched,
   * or already-resolved proposal id rather than authorizing a different
   * version or task. */
  async approveProposal(taskId: string, proposalId: string): Promise<void> {
    await this.resolveCoreGate(taskId, 'proposal', 'approved');
    await this.resolveProposalGate(taskId, proposalId, { kind: 'approved' });
  }

  async rejectProposal(taskId: string, proposalId: string): Promise<void> {
    await this.resolveCoreGate(taskId, 'proposal', 'rejected', 'cancel');
    await this.resolveProposalGate(taskId, proposalId, { kind: 'rejected' });
  }

  /** Requires non-empty (post-trim) revision instructions; performs no
   * mutation, marks the current proposal superseded via the drain loop, and
   * requires a fresh approval on the newly generated proposal. */
  async requestProposalRevision(taskId: string, proposalId: string, instructions: string): Promise<void> {
    const trimmed = instructions.trim();
    if (!trimmed) {
      throw new Error('revision_instructions_required');
    }
    await this.resolveCoreGate(taskId, 'proposal', 'rejected', 'revise');
    await this.resolveProposalGate(taskId, proposalId, { kind: 'revise', instructions: trimmed });
  }

  private async resolveProposalGate(
    taskId: string,
    proposalId: string,
    decision: ProposalGateDecision,
    allowSupersededRevision = false,
  ): Promise<void> {
    const gate = this.pendingProposalGates.get(taskId);
    const task = await this.queue.get(taskId);
    if (
      !gate
      || !task
      || task.state !== 'waiting_for_proposal_approval'
      || task.pendingProposal?.proposalId !== proposalId
      || (!allowSupersededRevision && (task.pendingProposal.instructionRevision ?? 0) !== (task.instructionRevision ?? 0))
      || gate.proposalId !== proposalId
    ) {
      throw new Error('stale_or_unknown_proposal_approval');
    }
    this.pendingProposalGates.delete(taskId);
    await gate.resolve(decision);
  }

  async approveMutation(taskId: string, requestId: string): Promise<void> {
    await this.resolveCoreGate(taskId, 'mutation', 'approved');
    await this.resolveMutationGate(taskId, requestId, 'approved');
  }

  async denyMutation(taskId: string, requestId: string): Promise<void> {
    await this.resolveCoreGate(taskId, 'mutation', 'rejected', 'cancel');
    await this.resolveMutationGate(taskId, requestId, 'denied');
  }

  private async resolveMutationGate(
    taskId: string,
    requestId: string,
    decision: MutationGateDecision,
    allowSupersededRevision = false,
  ): Promise<void> {
    const gate = this.pendingMutationGates.get(taskId);
    const task = await this.queue.get(taskId);
    if (
      !gate
      || !task
      || task.state !== 'waiting_for_mutation_approval'
      || task.pendingMutationApproval?.requestId !== requestId
      || (!allowSupersededRevision && (task.pendingMutationApproval.instructionRevision ?? 0) !== (task.instructionRevision ?? 0))
      || gate.requestId !== requestId
    ) {
      throw new Error('stale_or_unknown_mutation_approval');
    }
    this.pendingMutationGates.delete(taskId);
    await gate.resolve(decision);
  }

  private extensionBuild(): string {
    const maybeContext = this.context as vscode.ExtensionContext & { extension?: { packageJSON?: { version?: string } } };
    return maybeContext.extension?.packageJSON?.version ?? 'dev';
  }

  private log(taskId: string, message: string): void {
    const output = this.output ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.output = output;
    const now = new Date();
    // The raw machine-readable line is kept for grep/log-tooling and backward
    // compatibility with existing diagnostics; the rendered block underneath is
    // the actionable, human-readable progress timeline.
    output.appendLine(`[${now.toISOString()}] ${taskId}: ${message}`);
    const event = parseAutonomousProgressPhase(message);
    if (event.kind !== 'unknown') {
      for (const line of renderAutonomousProgressEventPlain(event, now).split('\n')) {
        output.appendLine(`  ${line}`);
      }
    }
  }
}

function redactValidationTail(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/authorization:\s*\S+/gi, 'authorization: [redacted]')
    .replace(/(token|secret|password|api[_-]?key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/(?:^|\s)[A-Za-z_][A-Za-z0-9_]{2,}=\S+/g, ' [environment value redacted]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(-4000);
}

/** `configured`/`default` are enqueue placeholders meaning "use the configured
 * provider/model", never a concrete selection to dispatch. */
function frozenRoutingValue(value: string | undefined): string | undefined {
  return value && value !== 'configured' && value !== 'default' ? value : undefined;
}

function classifyRuntimeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'task_input_integrity_mismatch') return 'task_input_integrity_mismatch';
  if (message === 'pre_delivery_validation_failed') return 'pre_delivery_validation_failed';
  if (message.startsWith('delivery_candidate_materialization_failed:')) return 'delivery_candidate_materialization_failed';
  if (isGitAuthorIdentityFailure(message)) return GIT_AUTHOR_IDENTITY_UNAVAILABLE;
  return message.startsWith('worktree_identity_mismatch:')
    ? 'worktree_identity_mismatch'
    : 'runtime_error';
}

function sanitizeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 300);
}

/** Bounded progress line for a persisted recovery decision. Never carries file content. */
function formatRecoveryProgress(decision: RecoveryDecision): string {
  const change = decision.expectedChange.length > 0 ? ` change=${decision.expectedChange.join('+')}` : '';
  const terminal = decision.terminalState ? ` terminal=${decision.terminalState}` : '';
  const model = decision.directives.model ? ` model=${decision.directives.model.provider}/${decision.directives.model.model}` : '';
  return `recovery_decision seq=${decision.decisionSeq} action=${decision.action} cause=${decision.cause ?? 'none'} subcode=${decision.subcode ?? 'none'}${change}${model}${terminal}`;
}

/** The controller-shaped terminal record for a run the journal proves must not execute. */
function haltDecision(attemptId: string, reason: string): RecoveryDecision {
  return {
    schemaVersion: 1,
    decisionSeq: 0,
    attemptId,
    pass: 0,
    action: 'BLOCK',
    cause: 'environment_failure',
    subcode: reason.split(':')[0],
    terminalState: 'BLOCKED_RESUMABLE',
    reason,
    expectedChange: [],
    directives: { seedEvidencePaths: [], guidance: [], cloudAuthorized: false, resumeAtValidation: false },
    budget: { exhausted: false },
    decidedAt: new Date().toISOString(),
  };
}

/** Synthetic result for a run the journal proves must not execute (uncertain mutation/delivery state). */
function haltedExecutionResult(runId: string, reason: string): GovernedCodingExecutionResult {
  return {
    runId,
    status: 'mutation_failed',
    validations: [],
    validationHistory: [],
    repairAttempts: 0,
    validationPhase: { status: 'not_started' },
    failureReason: reason,
    errorCode: reason.split(':')[0],
  };
}

/** Adds the M42 terminal state (BLOCKED_RESUMABLE, NO_PROGRESS, BUDGET_EXHAUSTED, NO_CAPABLE_MODEL, ...) to a persisted failure. */
function withRecoveryFailure(
  failure: { classification: string; message: string; at: string },
  terminal: RecoveryDecision | undefined,
): { classification: string; message: string; at: string; recovery?: { terminalState: string; cause?: string; subcode?: string; decisionSeq: number } } {
  if (!terminal?.terminalState) return failure;
  // `classification` stays the underlying stage failure (stable UX humanization and consumers);
  // the precise terminal state travels in `recovery` and the message.
  return {
    ...failure,
    message: `${terminal.reason} (${failure.message})`.slice(0, 1200),
    recovery: { terminalState: terminal.terminalState, cause: terminal.cause, subcode: terminal.subcode, decisionSeq: terminal.decisionSeq },
  };
}

function blockedLogMessage(result: GovernedCodingExecutionResult): string {
  const evidence = result.proposalConflictEvidence;
  if (!evidence) {
    return `blocked:${result.status}`;
  }
  const mutationStarted = Boolean(result.mutation);
  return `blocked:${result.status} operation=${evidence.operationIndex + 1}/${evidence.proposalOperationCount} path=${evidence.targetPath} mutation_started=${mutationStarted}`;
}

/** Flat, spec-named aliases of `proposalConflictEvidence` kept alongside the
 * original nested object for backward compatibility with existing consumers. */
function proposalConflictAliasFields(result: GovernedCodingExecutionResult): Record<string, unknown> {
  const evidence = result.proposalConflictEvidence;
  if (!evidence) return {};
  return {
    proposalValidationAttempt: 1,
    proposalRepairAttempt: evidence.repairAttempts,
    proposalConflictClassification: evidence.classification,
    proposalConflictOperationIndex: evidence.operationIndex,
    proposalConflictOperationCount: evidence.proposalOperationCount,
    proposalConflictOperationKind: evidence.operationKind,
    proposalConflictTargetPath: evidence.targetPath,
    targetExistedAtBase: evidence.targetExistedAtBase,
    targetExistedAtBindingTime: evidence.targetExistedAtBindingTime,
    mutationStarted: Boolean(result.mutation),
    regeneratedProposalOperationCount: evidence.regeneratedProposalOperationCount,
    regeneratedProposalValidationResult: evidence.regeneratedProposalValidationResult,
  };
}

function buildGraphFailureEvidence(result: GovernedCodingExecutionResult): Record<string, unknown> | undefined {
  const graph = result.graph;
  if (!graph) {
    // A host snapshot binding conflict happens after the graph itself completed
    // successfully, so there is no graph-stage failure to report. Still persist the
    // bounded proposal-conflict evidence so the binding failure is diagnosable.
    return result.proposalConflictEvidence
      ? { proposalConflictEvidence: result.proposalConflictEvidence, ...proposalConflictAliasFields(result) }
      : undefined;
  }
  return {
    graphStatus: graph.status,
    proposalConflictEvidence: result.proposalConflictEvidence,
    ...proposalConflictAliasFields(result),
    completedStages: graph.completedStages,
    activeStage: graph.activeStage,
    failedStage: graph.failedStage,
    failureCode: graph.failureCode,
    failureReason: graph.failureReason ? sanitizeMessage(graph.failureReason) : undefined,
    stageDurations: graph.stages.map(stage => ({ stage: stage.stage, durationMs: stage.durationMs })),
    providerModels: graph.stages.map(stage => ({
      stage: stage.stage,
      providerType: stage.providerType,
      model: stage.model,
    })),
    governedRequests: graph.evidence.map(evidence => ({
      stage: evidence.stage,
      requestId: evidence.modelEvidence.requestId,
      status: evidence.modelEvidence.status,
      failureCode: evidence.modelEvidence.failureCode,
      failureReason: evidence.modelEvidence.failureReason,
      providerType: evidence.modelEvidence.providerType ?? evidence.modelEvidence.context?.providerType,
      model: evidence.modelEvidence.model,
      // M42 routing identity: which model was attempted vs which one executed.
      routing: evidence.modelEvidence.routing,
      durationMs: evidence.modelEvidence.durationMs,
      providerRequestTimeoutMs: evidence.modelEvidence.context?.providerRequestTimeoutMs,
      timeoutOwner: evidence.modelEvidence.context?.timeoutOwner,
      promptCharacterCount: evidence.modelEvidence.promptCharacterCount,
      audit: evidence.modelEvidence.audit,
    })),
  };
}

function appendEvidence(existing: string[], result: GovernedCodingExecutionResult): string[] {
  const graph = result.graph;
  if (!graph) return existing;
  const failed = graph.failedStage ? ` failedStage=${graph.failedStage}` : '';
  const code = graph.failureCode ? ` failureCode=${graph.failureCode}` : '';
  return [...existing, `m13:graph status=${graph.status}${failed}${code}`].slice(-50);
}

/** A git command refused only because another process holds the repository's index.lock (transient). */
export function isTransientIndexLockFailure(output: string): boolean {
  return /index\.lock'?:? File exists/i.test(String(output ?? ''));
}
