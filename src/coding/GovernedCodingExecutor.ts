import type * as vscode from 'vscode';
import { Config } from '../config/Config';
import { GovernedModelExecutionDispatcher } from '../agent/GovernedModelExecutionDispatcher';
import { ProviderGatewayGovernedModelExecutionDependency } from '../agent/ProviderGatewayGovernedModelExecutionDependency';
import { LocalFirstModelDispatchRouter, type CloudFallbackRoute } from '../agent/LocalFirstModelDispatchRouter';
import { ProviderGateway } from '../providers/ProviderGateway';
import type { GovernedRunAccounting } from '../autonomous/TaskControl';
import {
  FORGE_INVOKE_MODEL_DESCRIPTOR,
  ReadOnlyForgeCallableRegistry,
} from '../agent/ForgeCallableSurface';
import { HostBoundCodingProposal, WorkspaceMutationEngine, MutationResult, WorkspaceSnapshotBinder, ProposalConflictEvidence, ProposalConflictError } from './WorkspaceMutation';
import { spawn } from 'child_process';
import { hardenedGitArgs, hardenedGitEnv } from '../../core/security/hardenedGit';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import { CodingValidationRunner, ValidationRunResult } from './ValidationRunner';
import { deriveValidationEnvelope, type ValidationConfidence } from './ValidationFloor';
import { CODING_PROPOSAL_VERSION, CodingProposal, CodingValidationCommand } from './CodingProposal';
import { renderProposalForModel } from './AnchoredEdit';
import { cleanupGeneratedArtifacts, captureGeneratedArtifactBaseline } from './GeneratedArtifactPolicy';
import { CodingPlanner, readWorkspacePackageScripts } from './CodingPlanner';
import { formatInvestigationProgress } from './InvestigationLoop';
import { WorkspaceInspectionTools } from './WorkspaceInspection';
import {
  FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
  FixedMultiAgentGraph,
  FixedMultiAgentGraphRequest,
  FixedMultiAgentGraphResult,
  FixedMultiAgentStageProgressEvent,
} from '../orchestration/FixedMultiAgentGraph';
import {
  ApprovalEnvelope,
  ApprovalEnvelopeService,
  ForgeExecutionReadinessResult,
  ValidationSideEffectDetector,
  WorkspaceMutationLease,
} from './ExecutionIntegrity';
import {
  createPermissionContext,
  denialFromAuthorization,
  formatPermissionDenial,
  grantsFromPermissionContext,
} from '../tools/PermissionContext';
import { ToolRegistry } from '../tools/ToolRegistry';
import type { ExecutionQualityEvidenceInput } from '../../core/shared/wireTypes';
import { classifyExecutionProfile, executionProfileAllowsFullGraph, type ExecutionProfile } from '../orchestration/ExecutionProfile';
import type { ExecutionRecoverySession } from '../autonomous/recovery/ExecutionRecoverySession';
import { MAX_VALIDATION_REPAIR_CYCLES, type GroundingMissing } from '../autonomous/recovery/RecoveryTypes';
import { gitPrerequisiteMessage, isGitPrerequisiteCode } from './GitPrerequisites';

/**
 * Status values produced by the governed coding executor. These are the same
 * status vocabulary previously emitted inline by ForgeCodingTaskController.
 */
export type GovernedCodingExecutionStatus =
  | 'completed'
  | 'validation_failed'
  | 'proposal_unavailable'
  | 'invalid_proposal'
  | 'proposal_rejected'
  | 'execution_rejected'
  | 'cancelled'
  | 'graph_incomplete'
  | 'readiness_blocked'
  /** A Git environment prerequisite is missing (errorCode names which). Never a provider/model failure. */
  | 'git_prerequisite_unavailable'
  | 'file_missing_at_binding'
  | 'create_target_exists'
  | 'workspace_changed_after_review'
  | 'dirty_document_blocked'
  | 'workspace_lease_held'
  | 'validation_side_effect_detected'
  | 'git_state_changed'
  | 'approval_replay_rejected'
  | 'snapshot_read_failed'
  | 'path_rejected'
  | 'duplicate_proposal_target'
  | 'mutation_evidence_missing'
  | 'mutation_failed'
  | 'execution_profile_missing'
  | 'execution_profile_invalid'
  /** M42: a proposal replaces/deletes an existing file with no admissible current-version evidence
   * (never read, or read before the file/base changed). Enforced by the runtime, not the prompt. */
  | 'grounding_failed'
  /** Investigated (0+ bounded read/search turns) and honestly reported that a
   * specific, named piece of evidence is still missing — never silently
   * treated as completed or forced into a fabricated proposal. */
  | 'insufficient_context_reported'
  /** Investigated and claimed no code change is required. The claim alone
   * never completes the task — this status always routes to the same
   * blocked-for-review path a rejected proposal would, pending separate
   * (human or governed) verification. */
  | 'no_change_claim_reported';

export interface VerifiedMutationEvidence {
  instructionRevision: number;
  expectedPaths: string[];
  changedPaths: string[];
  contentVerified: boolean;
  gitDiffPresent: boolean;
  alreadySatisfied: boolean;
  verifiedAt: string;
}

export interface GovernedCodingExecutorCallbacks {
  /** Optional non-sensitive progress notifications (phase transitions only). */
  onProgress?: (phase: string) => void;
  /** Durable Core-owned execution-quality evidence. Awaited so lifecycle
   * ordering cannot overtake repair evidence. */
  onEvidence?: (evidence: ExecutionQualityEvidenceInput) => Promise<void>;
  /**
   * Present the proposal for bounded human review. Resolve true to continue toward
   * execution approval, false to reject with no mutation.
   */
  reviewProposal: (proposal: HostBoundCodingProposal) => Promise<boolean>;
  /**
   * Explicit modal-style approval before any mutation is attempted.
   */
  approveExecution: (proposal: HostBoundCodingProposal) => Promise<boolean>;
  /**
   * Elevated confirmation for sensitive operations. Only invoked when the approval
   * envelope marks elevatedConfirmationRequired.
   */
  confirmElevated: (envelope: ApprovalEnvelope) => Promise<boolean>;
  /** Readiness check bound to the executor's workspace root and host UI/editor state. */
  checkReadiness: (targetPaths?: readonly string[]) => Promise<ForgeExecutionReadinessResult>;
}

export interface GovernedCodingExecutionRequest {
  runId: string;
  goal: string;
  workspaceRoot: string;
  configWorkspaceRoot?: string;
  signal: AbortSignal;
  secrets: vscode.SecretStorage;
  auditSource: string;
  auditMetadata?: Record<string, unknown>;
  extensionBuild: string;
  /** Frozen by Core at attempt creation. Live configuration is never reread
   * for an autonomous attempt when these values are supplied. */
  providerType?: ReturnType<typeof Config.getProviderType>;
  model?: string;
  /**
   * True when this attempt's model came from automatic local-first selection
   * rather than an explicit user model override. Fails closed: when omitted,
   * the attempt is treated as an explicit override and never routes to a
   * cloud fallback.
   */
  automaticModelSelection?: boolean;
  /**
   * True only when cloud escalation/fallback is explicitly permitted by the
   * governing authority / routing policy for this execution. Fails closed:
   * when false or omitted, the router never invokes a cloud provider.
   */
  cloudFallbackPermitted?: boolean;
  /** Explicit workflow-depth authorization. Omission fails closed before dispatch. */
  executionProfile?: ExecutionProfile;
  /** Reason read from durable task escalation evidence, if escalation occurred. */
  durableEscalationReason?: string;
  maxValidationRepairCycles?: number;
  /**
   * M42 observe-only task-level accounting. Absent for interactive Forge runs.
   * Never alters, blocks or delays execution; stage-local limits stay authoritative.
   */
  accounting?: GovernedRunAccounting;
  /** Durable instruction revision this execution is implementing. */
  instructionRevision?: number;
  /** Exact proposal checkpoint restored after its human-review gate was
   * approved in a replacement Extension Host. Skips model/graph generation
   * and the already-resolved proposal gate, but preserves every downstream
   * readiness, mutation-approval, mutation, and validation control. */
  resumeAfterProposalApproval?: HostBoundCodingProposal;
  /**
   * A single-file, exact-content mutation resolved deterministically (no
   * model call) by the caller's execution-profile classification. When
   * present, the fixed multi-agent graph and its model invocation are
   * skipped entirely; every downstream readiness, review, approval,
   * mutation-lease, mutation, and validation control still runs unchanged.
   * A binding conflict here (e.g. the target already exists) has no
   * deterministic repair and is surfaced as escalation evidence to the
   * caller rather than retried.
   */
  deterministicProposal?: { path: string; content: string; reason: string };
  /**
   * Forwarded verbatim to {@link FixedMultiAgentGraphRequest.pendingSteering}.
   * Ignored on the deterministic-proposal and resume-after-approval paths,
   * since neither invokes the five-stage graph.
   */
  pendingSteering?: () => string[] | Promise<string[]>;
  /**
   * M42 recovery control plane. Records evidence/mutation/validation checkpoints to the
   * durable AttemptJournal, enforces the grounding precondition, carries the controller's
   * directives (seed evidence, guidance, resume-at-validation). Absent for interactive Forge runs.
   */
  recovery?: ExecutionRecoverySession;
  callbacks: GovernedCodingExecutorCallbacks;
}

export interface GovernedCodingExecutionResult {
  runId: string;
  status: GovernedCodingExecutionStatus;
  graph?: FixedMultiAgentGraphResult;
  proposal?: CodingProposal;
  executableProposal?: HostBoundCodingProposal;
  mutation?: MutationResult;
  mutationEvidence?: VerifiedMutationEvidence;
  validations: ValidationRunResult[];
  validationHistory: Array<{ cycle: number; results: ValidationRunResult[] }>;
  repairAttempts: number;
  validationPhase:
    | { status: 'not_started' }
    | { status: 'completed'; applicableCommandCount: number; failedCommandCount: number; confidence?: ValidationConfidence };
  failureReason?: string;
  /** Bounded, non-sensitive diagnostic for a host snapshot binding conflict. */
  proposalConflictEvidence?: ProposalConflictEvidence;
  /** M42: target paths named by a rejected (invalid/ungrounded) proposal, so recovery can supply them. */
  attemptedPaths?: string[];
  /** M42: paths read (by the model or the runtime) during this run. */
  filesRead?: string[];
  /** M42: evidence the grounding gate found missing or stale. */
  groundingMissing?: GroundingMissing[];
  /** M42: bounded code of the underlying thrown error (diagnostic subcode for the catch-all statuses). */
  errorCode?: string;
  /** M42: why the in-run validation repair loop stopped while validation still failed. */
  repairStopReason?: 'none' | 'unavailable' | 'no_progress' | 'exhausted' | 'cycle_rejected';
  /** M42: sanitized codes describing why the repair turn was unusable (status, host-validation errors, response reason). */
  repairStopDetail?: string[];
}

/** Facts the inner run reports beyond the positional `finish()` result. */
interface ExecutionExtras {
  attemptedPaths?: string[];
  groundingMissing?: GroundingMissing[];
  errorCode?: string;
  repairStopReason?: GovernedCodingExecutionResult['repairStopReason'];
  repairStopDetail?: string[];
}

/** Runs `fn` inside a named accounting stage when accounting is present; otherwise just runs it. */
function inAccountingStage<T>(request: GovernedCodingExecutionRequest | undefined, stage: string, fn: () => Promise<T>): Promise<T> {
  return request?.accounting ? request.accounting.withStage(stage, fn) : fn();
}

/**
 * Reusable governed coding execution seam: readiness -> FixedMultiAgentGraph ->
 * proposal consumption -> host snapshot binding -> bounded review -> explicit
 * approval -> (elevated confirmation if sensitive) -> approval envelope ->
 * mutation lease -> mutation -> side-effect detection -> validation.
 *
 * Extracted from ForgeCodingTaskController so both the interactive Forge command
 * and the M15 autonomous runtime drive identical governed logic through injected
 * VS Code UI callbacks.
 */
export class GovernedCodingExecutor {
  async execute(request: GovernedCodingExecutionRequest): Promise<GovernedCodingExecutionResult> {
    const extras: ExecutionExtras = {};
    const result = await this.executeInner(request, extras);
    return {
      ...result,
      attemptedPaths: extras.attemptedPaths,
      groundingMissing: extras.groundingMissing,
      errorCode: extras.errorCode,
      repairStopReason: extras.repairStopReason,
      repairStopDetail: extras.repairStopDetail,
      filesRead: request.recovery?.readPaths,
    };
  }

  private async executeInner(request: GovernedCodingExecutionRequest, extras: ExecutionExtras): Promise<GovernedCodingExecutionResult> {
    const { runId, workspaceRoot, signal, callbacks } = request;
    let graph: FixedMultiAgentGraphResult | undefined;
    let proposal: CodingProposal | undefined;
    let executableProposal: HostBoundCodingProposal | undefined;
    let mutation: MutationResult | undefined;
    let mutationEvidence: VerifiedMutationEvidence | undefined;
    let validations: ValidationRunResult[] = [];
    const validationHistory: Array<{ cycle: number; results: ValidationRunResult[] }> = [];
    let repairAttempts = 0;
    let validationPhase: GovernedCodingExecutionResult['validationPhase'] = { status: 'not_started' };
    let validationConfidence: ValidationConfidence | undefined;
    let lease: WorkspaceMutationLease | undefined;
    let approvalEnvelope: ApprovalEnvelope | undefined;
    // Exactly one M42 routing seam per governed run. Sharing it across the
    // planning path, the five-stage graph and every validation-repair turn is
    // what bounds this task to a single cloud fallback attempt in total.
    const router = this.createRoutingSeam(request);
    try {
      if (!request.resumeAfterProposalApproval && !request.executionProfile) {
        callbacks.onProgress?.('execution_profile_rejected reason=missing');
        return this.finish(runId, 'execution_profile_missing', graph, proposal, executableProposal, mutation, validations, 'Execution profile is required before governed dispatch.');
      }
      if (!request.resumeAfterProposalApproval && request.executionProfile && !request.executionProfile.escalation.reason) {
        const authoritativeProfile = classifyExecutionProfile(request.goal);
        if (
          authoritativeProfile.tier !== request.executionProfile.tier
          || authoritativeProfile.maxStages !== request.executionProfile.maxStages
          || authoritativeProfile.useDeterministicProposal !== request.executionProfile.useDeterministicProposal
        ) {
          callbacks.onProgress?.('execution_profile_rejected reason=classifier_mismatch');
          return this.finish(runId, 'execution_profile_invalid', graph, proposal, executableProposal, mutation, validations, 'Execution profile did not match the authoritative classifier.');
        }
      }
      if (!request.resumeAfterProposalApproval && request.executionProfile?.useDeterministicProposal && !request.deterministicProposal) {
        callbacks.onProgress?.('execution_profile_rejected reason=deterministic_proposal_missing');
        return this.finish(runId, 'execution_profile_invalid', graph, proposal, executableProposal, mutation, validations, 'The trivial execution profile had no deterministic proposal.');
      }
      if (request.recovery?.resumeAtValidation) {
        proposal = request.recovery.resumeAtValidation;
        executableProposal = request.recovery.resumeAtValidation;
        callbacks.onProgress?.('validation_resumed_without_reapplying_mutation');
      } else if (request.resumeAfterProposalApproval) {
        proposal = request.resumeAfterProposalApproval;
        executableProposal = request.resumeAfterProposalApproval;
        callbacks.onProgress?.('proposal_restored_after_approval');
      } else if (request.deterministicProposal) {
        // Trivial exact-content mutation: no model, no multi-agent graph.
        // Readiness, review, approval, mutation, and validation gates below
        // are unchanged from the generative path.
        callbacks.onProgress?.('readiness_check');
        const initialReadiness = await callbacks.checkReadiness();
        if (initialReadiness.blockingFailures.length > 0) {
          throw new Error(initialReadiness.blockingFailures[0].code);
        }
        callbacks.onProgress?.('deterministic_proposal_generated');
        proposal = buildDeterministicCodingProposal(request.deterministicProposal);
        const baseCommitSha = await resolveHeadCommitSha(workspaceRoot);
        try {
          executableProposal = await new WorkspaceSnapshotBinder(workspaceRoot).bind(proposal, signal, baseCommitSha);
        } catch (error) {
          if (error instanceof ProposalConflictError) {
            // No model is available to repair a deterministic proposal — this
            // is exactly the evidence an escalation to the generative path needs.
            throw Object.assign(new Error(error.proposalConflictEvidence.classification), {
              proposalConflictEvidence: { ...error.proposalConflictEvidence, repairAttempts: 0, regeneratedProposalValidationResult: 'unavailable' as const },
            });
          }
          throw error;
        }
        callbacks.onProgress?.('proposal_ready');
      } else if (request.executionProfile && !executionProfileAllowsFullGraph(request.executionProfile, request.durableEscalationReason)) {
        callbacks.onProgress?.('readiness_check');
        const initialReadiness = await callbacks.checkReadiness();
        if (initialReadiness.blockingFailures.length > 0) {
          throw new Error(initialReadiness.blockingFailures[0].code);
        }
        this.requireGovernedAuthorization('forge.forge.invocation.invokeModel', 'model-provider-access', runId, true);
        // Small tasks use the configured coding fallback model when the user
        // has not explicitly selected a model. Explicit overrides always win.
        // This keeps model choice task-sensitive without changing governance.
        const planningModel = request.model
          ?? (request.executionProfile.tier === 'small' ? Config.getCodingFallbackModel() : Config.getCodingModel());
        callbacks.onProgress?.(`lightweight_proposal_execution tier=${request.executionProfile.tier} model=${planningModel}`);
        const planner = new CodingPlanner(
          workspaceRoot,
          ProviderGatewayGovernedModelExecutionDependency.forSecrets(request.secrets),
          {
            model: planningModel,
            providerType: request.providerType,
            invocationId: runId,
            taskId: runId,
            audit: { source: request.auditSource, metadata: request.auditMetadata ?? {} },
            configWorkspaceRoot: request.configWorkspaceRoot,
            dispatcher: router,
          },
        );
        // Bounded pre-proposal investigation (read_file/search/submit_proposal/
        // insufficient_context/no_change_claim) replaces the old single-shot
        // dispatch here. `submit_proposal` still runs through the exact same
        // CodingProposal validation `plan()` always used; everything from
        // `proposal_generated` onward below is completely unchanged.
        // Same predicate as the per-call routing seam: an explicit `false` from the
        // caller's authority (e.g. a frozen local-only Core selection) is never
        // overridden by live configuration. Cloud stays default-deny.
        const cloudPermitted = request.cloudFallbackPermitted === true
          || (request.cloudFallbackPermitted !== false && Config.getModelRoutingPolicy() === 'local-first-cloud-fallback');
        const recovery = request.recovery;
        const recoveryContext = recovery ? await recovery.renderRecoveryContext() : '';
        const pendingRecords: Array<Promise<void>> = [];
        const investigation = await inAccountingStage(request, 'investigation', () => planner.planWithInvestigation(request.goal, signal, {
          onTurn: evidence => {
            callbacks.onProgress?.(formatInvestigationProgress(evidence));
            if (evidence.completedAction === 'read_file' || evidence.completedAction === 'search') {
              request.accounting?.recordToolCall(evidence.completedAction, `${runId}:investigation:${evidence.turn}:${evidence.completedAction}`);
            }
            if (recovery && evidence.completedAction === 'search' && evidence.ok) {
              pendingRecords.push(recovery.recordSearch(evidence.query ?? evidence.detail ?? '', evidence.scope, evidence.resultCount ?? 0));
            }
          },
          onRead: recovery
            ? read => {
              const range = /^(\d+)-(\d+)$/.exec(read.range);
              pendingRecords.push(recovery.recordRead({
                path: read.path,
                contentHash: read.contentFingerprint,
                ranges: range ? [[Number(range[1]), Number(range[2])]] : [],
                totalLines: read.totalLines,
                source: 'model_read',
              }));
            }
            : undefined,
          onContextFile: recovery
            ? file => {
              // Only a file the planner showed whole counts as read; an excerpt does not.
              if (!file.complete) return;
              pendingRecords.push(recovery.recordRead({
                path: file.path,
                contentHash: file.contentFingerprint,
                ranges: [[1, Math.max(1, file.totalLines)]],
                totalLines: Math.max(1, file.totalLines),
                source: 'initial_context',
              }));
            }
            : undefined,
          extraContext: recoveryContext || undefined,
          carry: recovery?.evidenceCarry,
          onProgress: phase => callbacks.onProgress?.(phase),
          escalateToCloud: cloudPermitted
            ? (cloudRequest, reason, local) => router.dispatchLoopLevelCloud(cloudRequest, reason, local)
            : undefined,
        }));
        await Promise.all(pendingRecords);
        if (investigation.outcome.kind === 'insufficient_context') {
          return this.finish(runId, 'insufficient_context_reported', graph, proposal, executableProposal, mutation, validations, investigation.outcome.reason);
        }
        if (investigation.outcome.kind === 'no_change_claim') {
          return this.finish(runId, 'no_change_claim_reported', graph, proposal, executableProposal, mutation, validations, investigation.outcome.reason);
        }
        if (investigation.outcome.kind !== 'proposal') {
          const status: GovernedCodingExecutionStatus =
            investigation.outcome.kind === 'invalid_proposal' ? 'invalid_proposal' : 'proposal_unavailable';
          const outcomeErrors = 'errors' in investigation.outcome ? investigation.outcome.errors : [];
          if (investigation.outcome.kind === 'invalid_proposal') {
            extras.attemptedPaths = investigation.outcome.proposalPaths ?? [];
            await recovery?.recordProposal({ paths: extras.attemptedPaths, valid: false, errors: outcomeErrors });
          }
          return this.finish(runId, status, graph, proposal, executableProposal, mutation, validations, outcomeErrors.join(', ') || 'Investigation did not produce a usable proposal.');
        }
        proposal = investigation.outcome.proposal;
        callbacks.onProgress?.('proposal_generated');
        callbacks.onProgress?.(`proposal_operation_count operations=${proposal.operations.length}`);
        if (recovery) {
          await recovery.recordProposal({ proposal, paths: proposal.operations.map(operation => operation.path), valid: true });
          // Architectural grounding precondition: a proposal that replaces or deletes an
          // existing file must be backed by fresh evidence of that file's CURRENT content.
          const grounding = await recovery.checkGrounding(proposal.operations);
          if (!grounding.ok) {
            extras.groundingMissing = grounding.missing;
            extras.attemptedPaths = proposal.operations.map(operation => operation.path);
            callbacks.onProgress?.(`proposal_ungrounded paths=${grounding.missing.map(item => `${item.path}:${item.reason}`).join(',').slice(0, 300)}`);
            return this.finish(runId, 'grounding_failed', graph, proposal, executableProposal, mutation, validations, `proposal_ungrounded: ${grounding.missing.map(item => `${item.path} (${item.reason})`).join(', ').slice(0, 300)}`);
          }
        }
        const baseCommitSha = await resolveHeadCommitSha(workspaceRoot);
        executableProposal = await new WorkspaceSnapshotBinder(workspaceRoot).bind(proposal, signal, baseCommitSha);
        callbacks.onProgress?.('proposal_ready');
      } else {
        if (!request.executionProfile || !executionProfileAllowsFullGraph(request.executionProfile, request.durableEscalationReason)) {
          callbacks.onProgress?.('execution_profile_rejected reason=full_graph_not_authorized');
          return this.finish(runId, 'execution_profile_invalid', graph, proposal, executableProposal, mutation, validations, 'Full graph requires complex classification or durable escalation evidence.');
        }
        callbacks.onProgress?.('readiness_check');
      const initialReadiness = await callbacks.checkReadiness();
      if (initialReadiness.blockingFailures.length > 0) {
        throw new Error(initialReadiness.blockingFailures[0].code);
      }
      this.requireGovernedAuthorization('forge.forge.invocation.invokeModel', 'model-provider-access', runId, true);
      callbacks.onProgress?.('graph_execution');
      const fixedGraph = FixedMultiAgentGraph.forWorkspace(router, workspaceRoot);
      const graphRequest: FixedMultiAgentGraphRequest = {
        contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
        invocationId: runId,
        taskId: runId,
        // Guidance lines plus runtime-read seed files; the reads are journaled as
        // fresh evidence, which is what lets a grounding retry pass the gate below.
        goal: withRecoveryNotes(request.goal, request.recovery)
          + (request.recovery ? await request.recovery.renderRecoveryContext({ includeGuidance: false }) : ''),
        model: request.model ?? Config.getCodingModel(),
        providerType: request.providerType ?? Config.getProviderType(),
        workspaceRoot,
        signal,
        audit: { source: request.auditSource, metadata: request.auditMetadata ?? {} },
        configWorkspaceRoot: request.configWorkspaceRoot,
        onStageEvent: event => callbacks.onProgress?.(formatStageProgressEvent(event)),
        pendingSteering: request.pendingSteering,
      };
      graph = await inAccountingStage(request, 'graph', () => fixedGraph.execute(graphRequest));
      if (graph.status !== 'completed') {
        return this.finish(runId, 'graph_incomplete', graph, proposal, executableProposal, mutation, validations, safeGraphReason(graph));
      }
      let proposalConsumption = graph.proposalConsumption;
      let validatorProposalContent = graph.finalValidatorOutput;
      if (
        proposalConsumption?.status === 'invalid' &&
        isContractRepairEligible(proposalConsumption.errors) &&
        graph.finalValidatorOutput
      ) {
        // Same single-shot bounded repair the binder already uses for snapshot
        // conflicts: one machine-grounded correction back to the validator
        // stage, then full host validation again. Never loops; ineligible
        // (security/size) rejections fail closed immediately.
        callbacks.onProgress?.(`proposal_contract_invalid errors=${boundedErrorCodes(proposalConsumption.errors)}`);
        if (proposalConsumption.shape) callbacks.onProgress?.(`graph_proposal_shape ${proposalConsumption.shape}`);
        callbacks.onProgress?.('proposal_regeneration_started attempt=1/1');
        const workspaceScripts = await readWorkspacePackageScripts(workspaceRoot);
        request.accounting?.recordRecoveryAttempt('proposal_contract_invalid', `${runId}:contract_repair`);
        const regenerated = await inAccountingStage(request, 'proposal_contract_repair', () => fixedGraph.regenerateValidatorProposal(
          graphRequest,
          graph!.finalValidatorOutput!,
          buildContractViolationCorrection(proposalConsumption!.errors, workspaceScripts, proposalConsumption!.repairHints),
        ));
        if (regenerated.status === 'ready' && regenerated.proposal) {
          callbacks.onProgress?.(`proposal_regenerated operations=${regenerated.proposal.operations.length}`);
          proposalConsumption = regenerated;
          validatorProposalContent = renderProposalForModel(regenerated.proposal);
        } else {
          callbacks.onProgress?.('proposal_regeneration_failed attempt=1/1');
        }
      }
      if (proposalConsumption?.status !== 'ready' || !proposalConsumption.proposal) {
        if (proposalConsumption?.shape) callbacks.onProgress?.(`graph_proposal_shape ${proposalConsumption.shape}`);
        const status: GovernedCodingExecutionStatus = proposalConsumption?.status === 'unavailable' ? 'proposal_unavailable' : 'invalid_proposal';
        return this.finish(runId, status, graph, proposal, executableProposal, mutation, validations, safeProposalConsumptionReason(proposalConsumption));
      }
      proposal = proposalConsumption.proposal;
      // Proposal has been generated and passed structural validation, but is not yet
      // bound to the live host snapshot: do not report proposal_ready until binding
      // actually succeeds below, otherwise a binding conflict leaves latestProgress
      // stuck at a value that implies success.
      callbacks.onProgress?.('proposal_generated');
      callbacks.onProgress?.(`proposal_operation_count operations=${proposal.operations.length}`);
      const baseCommitSha = await resolveHeadCommitSha(workspaceRoot);
      const repaired = await this.bindWithBoundedRepair(
        fixedGraph,
        graphRequest,
        validatorProposalContent ?? renderProposalForModel(proposal),
        proposal,
        workspaceRoot,
        baseCommitSha,
        signal,
        callbacks,
        request,
      );
      proposal = repaired.proposal;
      executableProposal = repaired.executableProposal;
      if (request.recovery) {
        // Same architectural grounding precondition as the lightweight path. Checked on the
        // FINAL proposal (after contract and conflict repair) and before any approval gate,
        // so an ungrounded replace/delete can never reach review, approval or mutation.
        const grounding = await request.recovery.checkGrounding(proposal.operations);
        if (!grounding.ok) {
          extras.groundingMissing = grounding.missing;
          extras.attemptedPaths = proposal.operations.map(operation => operation.path);
          callbacks.onProgress?.(`proposal_ungrounded paths=${grounding.missing.map(item => `${item.path}:${item.reason}`).join(',').slice(0, 300)}`);
          return this.finish(runId, 'grounding_failed', graph, proposal, undefined, mutation, validations, `proposal_ungrounded: ${grounding.missing.map(item => `${item.path} (${item.reason})`).join(', ').slice(0, 300)}`);
        }
      }
        callbacks.onProgress?.('proposal_ready');
      }
      const approvedExecutableProposal = executableProposal;
      const mutator = new WorkspaceMutationEngine(workspaceRoot);
      if (request.recovery?.resumeAtValidation) {
        // The mutation is already applied (restart recovery or a controller-driven validation
        // repair). It is never applied again: readiness is re-checked, the lease re-taken and
        // the on-disk result re-verified, then validation runs against the existing worktree.
        const resumeReadiness = await callbacks.checkReadiness(executableProposal.operations.map(operation => operation.path));
        if (resumeReadiness.blockingFailures.length > 0) {
          throw new Error(resumeReadiness.blockingFailures[0].code);
        }
        lease = await WorkspaceMutationLease.acquire(workspaceRoot, runId, request.extensionBuild);
        mutation = {
          filesCreated: executableProposal.operations.filter(operation => operation.type === 'create').map(operation => operation.path),
          filesModified: executableProposal.operations.filter(operation => operation.type === 'replace').map(operation => operation.path),
          filesDeleted: executableProposal.operations.filter(operation => operation.type === 'delete').map(operation => operation.path),
          filesRestored: [],
          rollbackAttempted: false,
          rollbackSucceeded: false,
        };
        mutationEvidence = await verifyMutationEvidence(workspaceRoot, executableProposal, request.instructionRevision ?? 0, mutation);
        callbacks.onProgress?.(
          `mutation_evidence_verified revision=${mutationEvidence.instructionRevision}`
          + ` changed=${mutationEvidence.changedPaths.length}`
          + ` alreadySatisfied=${mutationEvidence.alreadySatisfied}`,
        );
      } else {
        const targetPaths = executableProposal.operations.map(operation => operation.path);
        const reviewReadiness = await callbacks.checkReadiness(targetPaths);
        if (reviewReadiness.blockingFailures.length > 0) {
          throw new Error(reviewReadiness.blockingFailures[0].code);
        }
        if (signal.aborted) throw new Error('cancelled');
        if (!request.resumeAfterProposalApproval) {
          callbacks.onProgress?.('approval_requested gate=proposal actor=user');
          callbacks.onProgress?.('approval_waiting gate=proposal actor=user');
          const reviewed = await callbacks.reviewProposal(executableProposal);
          if (!reviewed) {
            callbacks.onProgress?.('approval_rejected gate=proposal actor=user');
            return this.finish(runId, 'proposal_rejected', graph, proposal, executableProposal, mutation, validations, 'Proposal review was cancelled.');
          }
          callbacks.onProgress?.('approval_approved gate=proposal actor=user');
        }
        callbacks.onProgress?.('approval_requested gate=execution actor=user');
        callbacks.onProgress?.('approval_waiting gate=execution actor=user');
        const approved = await callbacks.approveExecution(executableProposal);
        if (!approved) {
          callbacks.onProgress?.('approval_rejected gate=execution actor=user');
          return this.finish(runId, 'execution_rejected', graph, proposal, executableProposal, mutation, validations, 'Execution approval was not granted.');
        }
        callbacks.onProgress?.('approval_approved gate=execution actor=user');
        const envelopeService = new ApprovalEnvelopeService();
        approvalEnvelope = envelopeService.create(executableProposal, reviewReadiness, runId);
        if (approvalEnvelope.elevatedConfirmationRequired) {
          const elevated = await callbacks.confirmElevated(approvalEnvelope);
          if (!elevated) {
            return this.finish(runId, 'execution_rejected', graph, proposal, executableProposal, mutation, validations, 'Elevated execution approval was not granted.');
          }
        }
        const mutationReadiness = await callbacks.checkReadiness(targetPaths);
        if (mutationReadiness.blockingFailures.length > 0) {
          throw new Error(mutationReadiness.blockingFailures[0].code);
        }
        envelopeService.consume(approvalEnvelope, mutationReadiness);
        this.requireGovernedAuthorization('agent.write_file', 'workspace-mutate', runId, true, approvalEnvelope.elevatedConfirmationRequired);
        callbacks.onProgress?.('mutating');
        lease = await WorkspaceMutationLease.acquire(workspaceRoot, runId, request.extensionBuild);
        await request.recovery?.mutationStarted(executableProposal);
        mutation = await mutator.apply(executableProposal, signal);
        await request.recovery?.mutationApplied(executableProposal);
        callbacks.onProgress?.(`mutation_completed created=${mutation.filesCreated.length} modified=${mutation.filesModified.length} deleted=${mutation.filesDeleted.length}`);
        mutationEvidence = await verifyMutationEvidence(
          workspaceRoot,
          executableProposal,
          request.instructionRevision ?? 0,
          mutation,
        );
        callbacks.onProgress?.(
          `mutation_evidence_verified revision=${mutationEvidence.instructionRevision}`
          + ` changed=${mutationEvidence.changedPaths.length}`
          + ` alreadySatisfied=${mutationEvidence.alreadySatisfied}`,
        );
      }
      const generatedArtifactBaseline = await captureGeneratedArtifactBaseline(workspaceRoot);
      const sideEffects = new ValidationSideEffectDetector(workspaceRoot, executableProposal.operations.map(operation => operation.path));
      await sideEffects.capture();
      this.requireGovernedAuthorization('agent.run_command', 'process-validation', runId, true);
      callbacks.onProgress?.('validating');
      // Governed minimum validation envelope: the model's validators are additive to a KKD-owned floor.
      const validationEnvelope = await deriveValidationEnvelope({
        workspaceRoot,
        changedPaths: executableProposal.operations.filter(operation => operation.type !== 'delete').map(operation => operation.path),
        modelCommands: executableProposal.validationCommands,
        signal,
      });
      const authoritativeValidationCommands = [...validationEnvelope.commands];
      validationConfidence = validationEnvelope.confidence;
      callbacks.onProgress?.(
        `validation_envelope confidence=${validationEnvelope.confidence} floorAdded=${validationEnvelope.floorAdded.length}`
        + ` total=${authoritativeValidationCommands.length}`
        + (validationEnvelope.inapplicableDropped.length > 0 ? ` inapplicableDropped=${validationEnvelope.inapplicableDropped.length}` : ''),
      );
      const validationRunner = new CodingValidationRunner(workspaceRoot, Config.getCommandTimeoutMs(), {
        onCommandStarted: (command, index, total) => {
          const boundedCommand = command.replace(/\s+/g, ' ').trim().slice(0, 200);
          callbacks.onProgress?.(`validation_command_started index=${index}/${total} command=${boundedCommand}`);
          request.accounting?.recordToolCall('validation_command', `${runId}:validation:${repairAttempts}:${index}`, { reason: 'validation_command' });
        },
      });
      await request.recovery?.validationPhase('started');
      validations = await validationRunner.runAll(authoritativeValidationCommands, signal);
      validationHistory.push({ cycle: 0, results: validations });
      await request.recovery?.recordValidation(0, validations);
      const unexpected = await sideEffects.detect();
      if (unexpected.length > 0) {
        throw new Error(`validation_side_effect_detected:${unexpected.slice(0, 5).join(',')}`);
      }
      let failedValidations = validations.filter(result => result.exitCode !== 0 || result.timedOut).length;
      if (failedValidations > 0) {
        await callbacks.onEvidence?.({
          eventType: 'validation_failed',
          metadata: validationFailureMetadata(validations, 0),
        });
      }
      const repairLimit = Math.min(MAX_VALIDATION_REPAIR_CYCLES, Math.max(0, request.maxValidationRepairCycles ?? 0));
      // Repair cycles are numbered per TASK ATTEMPT, not per pass: earlier passes already consumed
      // `repairCycleBase` of them (durably, in the journal), and Core rejects a `validation_repair_started`
      // whose cycle is not exactly its running count + 1. A resumed pass therefore continues the count
      // instead of restarting at cycle 1, and can never exceed the attempt-wide bound.
      const repairCycleBase = request.recovery?.priorRepairCycles ?? 0;
      const repairsRemaining = Math.max(0, repairLimit - repairCycleBase);
      const approvedPaths = new Set(executableProposal.operations.map(operation => normalizeGovernedPath(operation.path)));
      const approvedValidationCommands = new Set(authoritativeValidationCommands.map(validationCommandIdentity));
      let finalOperations = [...approvedExecutableProposal.operations];
      let priorRepairFingerprint: string | undefined;
      while (failedValidations > 0 && repairAttempts < repairsRemaining) {
        repairAttempts += 1;
        const cycle = repairCycleBase + repairAttempts;
        this.requireGovernedAuthorization('forge.forge.invocation.invokeModel', 'model-provider-access', runId, true);
        try {
          // Consumed durably BEFORE dispatch: a repair turn that then fails structurally still counts.
          await request.recovery?.recordRepairCycle(cycle);
          request.accounting?.recordValidationRepair(cycle);
          callbacks.onProgress?.(`validation_repair_started cycle=${cycle}/${repairLimit}`);
          await callbacks.onEvidence?.({
            eventType: 'validation_repair_started',
            metadata: validationFailureMetadata(validations, cycle),
          });
        } catch (error) {
          // A repair-cycle bookkeeping rejection is a validation-recovery fault, NOT a failed mutation
          // (the approved mutation is already applied and checkpointed). Report it as such.
          if (signal.aborted) throw error;
          extras.repairStopReason = 'cycle_rejected';
          extras.repairStopDetail = ['validation_repair_cycle_rejected', boundedErrorCode(error)];
          callbacks.onProgress?.(`validation_repair_cycle_rejected cycle=${cycle}/${repairLimit}`);
          break;
        }
        const repairGraphRequest: FixedMultiAgentGraphRequest = {
          contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
          invocationId: `${runId}-validation-repair-${cycle}`,
          taskId: runId,
          goal: request.goal,
          model: request.model ?? Config.getCodingModel(),
          providerType: request.providerType ?? Config.getProviderType(),
          workspaceRoot,
          signal,
          audit: { source: request.auditSource, metadata: request.auditMetadata ?? {} },
          configWorkspaceRoot: request.configWorkspaceRoot,
          onStageEvent: event => callbacks.onProgress?.(formatStageProgressEvent(event)),
        };
        const repairGraph = FixedMultiAgentGraph.forWorkspace(router, workspaceRoot);
        const repairRecoveryContext = request.recovery
          ? await request.recovery.renderRecoveryContext() + await request.recovery.widenedRepairContext(validations, cycle, proposal.operations.map(operation => operation.path))
          : '';
        const regenerated = await inAccountingStage(request, 'validation_repair', () => repairGraph.regenerateValidatorProposal(
          repairGraphRequest,
          renderProposalForModel(proposal),
          buildValidationRepairCorrection(validations, cycle, repairLimit, Boolean(proposal?.operations.some(operation => operation.anchoredEdits))) + repairRecoveryContext,
        ));
        if (regenerated.status !== 'ready' || !regenerated.proposal) {
          // Persist WHY the repair turn was unusable — previously only an
          // ephemeral onProgress string, with no durable record of the
          // regeneration status/errors once the task settled at `blocked`.
          await callbacks.onEvidence?.({
            eventType: 'validation_repair_unavailable',
            metadata: {
              cycle,
              repairLimit,
              regenerationStatus: regenerated.status,
              errors: regenerated.errors ?? [],
              // Sanitized enum only (never raw response/prompt/completion text)
              // — distinguishes done!==true / unexpected tool_calls / empty
              // content when regenerationStatus is 'unavailable'.
              invalidResponseReason: regenerated.invalidResponseReason,
            },
          });
          callbacks.onProgress?.(`validation_repair_unavailable cycle=${cycle}/${repairLimit}`);
          extras.repairStopReason = 'unavailable';
          extras.repairStopDetail = [regenerated.status, ...(regenerated.errors ?? []), ...(regenerated.invalidResponseReason ? [regenerated.invalidResponseReason] : [])].map(code => String(code)).slice(0, 8);
          break;
        }
        assertRepairWithinApproval(regenerated.proposal, approvedPaths, approvedValidationCommands);
        const normalizedRepairProposal = await normalizeValidationRepairProposal(
          regenerated.proposal,
          approvedExecutableProposal,
          mutation.filesCreated,
          workspaceRoot,
        );
        const repairFingerprint = JSON.stringify(normalizedRepairProposal.operations);
        if (repairFingerprint === priorRepairFingerprint) {
          callbacks.onProgress?.(`validation_repair_no_progress cycle=${cycle}/${repairLimit}`);
          request.accounting?.recordNoProgress('validation_repair', `validation_repair:${cycle}`);
          extras.repairStopReason = 'no_progress';
          break;
        }
        priorRepairFingerprint = repairFingerprint;
        const repairProposal = await new WorkspaceSnapshotBinder(workspaceRoot).bind(
          normalizedRepairProposal,
          signal,
          await resolveHeadCommitSha(workspaceRoot),
        );
        await request.recovery?.mutationStarted(repairProposal);
        const repairMutation = await mutator.apply(repairProposal, signal);
        await request.recovery?.mutationApplied(repairProposal);
        mutation = mergeMutations(mutation, repairMutation);
        const repairedByPath = new Map(repairProposal.operations.map(operation => [normalizeGovernedPath(operation.path), operation]));
        finalOperations = finalOperations.map(operation => repairedByPath.get(normalizeGovernedPath(operation.path)) ?? operation);
        executableProposal = {
          ...approvedExecutableProposal,
          operations: finalOperations,
          validationCommands: authoritativeValidationCommands,
        };
        proposal = executableProposal;
        // The repair mutation and its transaction journal are authorized
        // executor activity. Reset the baseline after that mutation so the
        // detector attributes only subsequent validation-command writes as
        // validation side effects.
        await sideEffects.capture();
        validations = await validationRunner.runAll(authoritativeValidationCommands, signal);
        validationHistory.push({ cycle, results: validations });
        await request.recovery?.recordValidation(cycle, validations);
        const unexpectedDuringRepairValidation = await sideEffects.detect();
        if (unexpectedDuringRepairValidation.length > 0) {
          throw new Error(`validation_side_effect_detected:${unexpectedDuringRepairValidation.slice(0, 5).join(',')}`);
        }
        failedValidations = validations.filter(result => result.exitCode !== 0 || result.timedOut).length;
        await callbacks.onEvidence?.({
          eventType: 'validation_repair_completed',
          metadata: {
            cycle,
            passed: failedValidations === 0,
            changedPaths: normalizedRepairProposal.operations.map(operation => operation.path),
            validation: validationFailureMetadata(validations, cycle),
          },
        });
        callbacks.onProgress?.(`validation_repair_completed cycle=${cycle}/${repairLimit} failed=${failedValidations}`);
        if (failedValidations > 0) {
          await callbacks.onEvidence?.({
            eventType: 'validation_failed',
            metadata: validationFailureMetadata(validations, cycle),
          });
        }
      }
      if (failedValidations > 0) extras.repairStopReason ??= repairLimit > 0 ? 'exhausted' : 'none';
      if (failedValidations > 0 && repairLimit > 0) {
        await callbacks.onEvidence?.({
          eventType: 'validation_repair_exhausted',
          metadata: { repairAttempts: repairCycleBase + repairAttempts, ...validationFailureMetadata(validations, repairCycleBase + repairAttempts) },
        });
      }
      const unexpectedAfterRepair = await sideEffects.detect();
      if (unexpectedAfterRepair.length > 0) {
        throw new Error(`validation_side_effect_detected:${unexpectedAfterRepair.slice(0, 5).join(',')}`);
      }
      await cleanupGeneratedArtifacts(workspaceRoot, { baselineArtifacts: generatedArtifactBaseline });
      await request.recovery?.validationPhase('completed', failedValidations === 0);
      validationPhase = {
        status: 'completed',
        applicableCommandCount: authoritativeValidationCommands.length,
        failedCommandCount: failedValidations,
        confidence: validationConfidence,
      };
      callbacks.onProgress?.(`validation_completed commands=${validations.length} failed=${failedValidations}`);
      const status: GovernedCodingExecutionStatus = failedValidations > 0 ? 'validation_failed' : 'completed';
      return this.finish(runId, status, graph, proposal, executableProposal, mutation, validations, undefined, undefined, validationPhase, validationHistory, repairAttempts, mutationEvidence);
    } catch (error) {
      const failure = signal.aborted ? 'cancelled' : classifyError(error);
      extras.errorCode = boundedErrorCode(error);
      mutation = mutationFromError(error) ?? mutation;
      const proposalConflictEvidence = proposalConflictEvidenceFromError(error);
      const reason = failure === 'git_prerequisite_unavailable' ? gitPrerequisiteMessage(extras.errorCode) : safeReason(failure);
      return this.finish(runId, failure, graph, proposal, executableProposal, mutation, validations, reason, proposalConflictEvidence, validationPhase, validationHistory, repairAttempts, mutationEvidence);
    } finally {
      await lease?.release().catch(() => undefined);
    }
  }

  /**
   * Validates the proposal against the isolated bound worktree. On a bounded
   * proposal-conflict (e.g. create_target_exists), sends exactly one machine-grounded
   * correction back to the validator stage and re-validates the regenerated proposal.
   * A second conflict blocks; this never loops beyond one repair attempt.
   */
  private async bindWithBoundedRepair(
    fixedGraph: FixedMultiAgentGraph,
    graphRequest: FixedMultiAgentGraphRequest,
    priorProposalContent: string,
    proposal: CodingProposal,
    workspaceRoot: string,
    baseCommitSha: string | undefined,
    signal: AbortSignal,
    callbacks: GovernedCodingExecutorCallbacks,
    accountingRequest?: GovernedCodingExecutionRequest,
  ): Promise<{ proposal: CodingProposal; executableProposal: HostBoundCodingProposal }> {
    try {
      const executableProposal = await new WorkspaceSnapshotBinder(workspaceRoot).bind(proposal, signal, baseCommitSha);
      return { proposal, executableProposal };
    } catch (error) {
      if (!(error instanceof ProposalConflictError)) {
        throw error;
      }
      const evidence = error.proposalConflictEvidence;
      callbacks.onProgress?.(proposalValidationFailedMessage(evidence));
      callbacks.onProgress?.('proposal_regeneration_started attempt=1/1');
      accountingRequest?.accounting?.recordRecoveryAttempt(`proposal_conflict:${evidence.classification}`, `${accountingRequest.runId}:conflict_repair`);
      const regenerated = await inAccountingStage(accountingRequest, 'proposal_conflict_repair', () => fixedGraph.regenerateValidatorProposal(
        graphRequest,
        priorProposalContent,
        buildProposalConflictCorrection(evidence),
      ));
      if (regenerated.status !== 'ready' || !regenerated.proposal) {
        callbacks.onProgress?.('proposal_regeneration_failed attempt=1/1');
        throw Object.assign(new Error(evidence.classification), {
          proposalConflictEvidence: { ...evidence, repairAttempts: 1, regeneratedProposalValidationResult: 'unavailable' as const },
        });
      }
      callbacks.onProgress?.(`proposal_regenerated operations=${regenerated.proposal.operations.length}`);
      try {
        const executableProposal = await new WorkspaceSnapshotBinder(workspaceRoot).bind(regenerated.proposal, signal, baseCommitSha);
        callbacks.onProgress?.('proposal_validation_passed');
        return { proposal: regenerated.proposal, executableProposal };
      } catch (secondError) {
        if (!(secondError instanceof ProposalConflictError)) {
          throw secondError;
        }
        callbacks.onProgress?.('proposal_regeneration_failed attempt=1/1');
        throw Object.assign(new Error(secondError.proposalConflictEvidence.classification), {
          proposalConflictEvidence: {
            ...secondError.proposalConflictEvidence,
            repairAttempts: 1,
            regeneratedProposalOperationCount: regenerated.proposal.operations.length,
            regeneratedProposalValidationResult: 'invalid' as const,
          },
        });
      }
    }
  }

  private finish(
    runId: string,
    status: GovernedCodingExecutionStatus,
    graph: FixedMultiAgentGraphResult | undefined,
    proposal: CodingProposal | undefined,
    executableProposal: HostBoundCodingProposal | undefined,
    mutation: MutationResult | undefined,
    validations: ValidationRunResult[],
    failureReason?: string,
    proposalConflictEvidence?: ProposalConflictEvidence,
    validationPhase: GovernedCodingExecutionResult['validationPhase'] = { status: 'not_started' },
    validationHistory: Array<{ cycle: number; results: ValidationRunResult[] }> = [],
    repairAttempts = 0,
    mutationEvidence?: VerifiedMutationEvidence,
  ): GovernedCodingExecutionResult {
    return {
      runId,
      status,
      graph,
      proposal: executableProposal ?? proposal,
      executableProposal,
      mutation,
      mutationEvidence,
      validations,
      validationHistory,
      repairAttempts,
      validationPhase,
      failureReason,
      proposalConflictEvidence,
    };
  }

  /**
   * Builds this run's single M42 local-first routing seam.
   *
   * The primary (local) dispatcher is exactly the production
   * `ProviderGateway`-backed dependency used before this milestone, so the
   * local path is unchanged. The cloud route is resolved lazily and only
   * after the routing policy has already decided a fallback is allowed —
   * `ProviderGateway.resolveCloudFallback` fails closed on policy, endpoint,
   * model or credential, so no cloud provider is even constructed (let alone
   * sent repository/task context) in a local-only workspace.
   *
   * The fallback dispatcher is a plain `GovernedModelExecutionDispatcher`,
   * never another router, so a fallback can never itself fall back.
   */
  private createRoutingSeam(request: GovernedCodingExecutionRequest): LocalFirstModelDispatchRouter {
    const cloudPermitted = request.cloudFallbackPermitted === true
      || (request.cloudFallbackPermitted !== false && Config.getModelRoutingPolicy() === 'local-first-cloud-fallback');
    // Accounting wraps the two REAL provider dispatchers (never the router), so
    // each provider call — including stage-local retries and a cloud fallback —
    // is counted exactly once with the model/provider that actually ran.
    const observe = (inner: GovernedModelExecutionDispatcher, route: 'primary' | 'cloud') =>
      request.accounting ? request.accounting.observeDispatcher(inner, route) : inner;
    return new LocalFirstModelDispatchRouter(
      observe(new GovernedModelExecutionDispatcher(
        ProviderGatewayGovernedModelExecutionDependency.forSecrets(request.secrets),
      ), 'primary'),
      {
        // Fails closed: an attempt that never declared automatic selection is
        // treated as an explicit user model override and never routes to cloud.
        automaticSelection: request.automaticModelSelection === true,
        cloudFallbackPermittedAndConfigured: cloudPermitted,
        resolveCloudFallback: async (): Promise<CloudFallbackRoute | undefined> => {
          if (!cloudPermitted) return undefined;
          const resolution = await ProviderGateway.resolveCloudFallback(request.secrets);
          if (!resolution.available || !resolution.provider || !resolution.model || !resolution.providerType) {
            return undefined;
          }
          const provider = resolution.provider;
          return {
            model: resolution.model,
            providerType: resolution.providerType,
            dispatcher: observe(new GovernedModelExecutionDispatcher(
              new ProviderGatewayGovernedModelExecutionDependency(async () => provider),
            ), 'cloud'),
          };
        },
        onRoutingEvent: routing => {
          if (!routing.fallbackUsed) return;
          void request.recovery?.recordRouting({
            attemptedModel: routing.attemptedModel,
            executedModel: routing.executedModel,
            fallbackUsed: true,
            decision: routing.fallbackDecision,
            reason: routing.localFailureCode,
          });
          request.callbacks.onProgress?.(
            `model_routing_fallback from=${routing.attemptedModel} to=${routing.executedModel}`
            + ` provider=${routing.executedProviderType ?? 'unknown'} reason=${routing.localFailureCode ?? 'unknown'}`,
          );
          void request.callbacks.onEvidence?.({
            eventType: 'model_routing_fallback',
            metadata: {
              selection: routing.selection,
              attemptedModel: routing.attemptedModel,
              attemptedProviderType: routing.attemptedProviderType,
              executedModel: routing.executedModel,
              executedProviderType: routing.executedProviderType,
              fallbackDecision: routing.fallbackDecision,
              localFailureCode: routing.localFailureCode,
              localFailureReason: routing.localFailureReason,
            },
          });
        },
      },
    );
  }

  private requireGovernedAuthorization(
    toolId: string,
    profileId: 'model-provider-access' | 'workspace-mutate' | 'process-validation',
    runId: string,
    approvalGranted: boolean,
    elevationGranted = false,
  ): void {
    const context = createPermissionContext(profileId, 'command-selection', {
      runId,
      approvalGranted,
      elevationGranted,
    });
    const decision = toolId.startsWith('forge.')
      ? authorizeForgeTool(toolId, context)
      : ToolRegistry.authorizeGoverned(toolId, grantsFromPermissionContext(context));
    const denial = denialFromAuthorization(decision, context.profileId);
    if (denial) {
      throw new Error(formatPermissionDenial(denial));
    }
  }
}

/**
 * Validation repair is planned against the post-mutation workspace, while the
 * model also receives the prior (pre-mutation) proposal as context. A model may
 * therefore repeat `create` for a path that this same governed execution just
 * created. Rebind only that narrow case to `replace`: the approved operation
 * proves the path was absent at the approval snapshot, this execution's
 * recorded mutation proves it created the path, and the current path proves
 * it still exists. Existing-at-base files, new repair paths, and every other
 * operation remain untouched and continue to fail closed through
 * WorkspaceSnapshotBinder.
 */
async function normalizeValidationRepairProposal(
  repair: CodingProposal,
  approved: HostBoundCodingProposal,
  createdByThisExecution: readonly string[],
  workspaceRoot: string,
): Promise<CodingProposal> {
  const approvedByPath = new Map(
    approved.operations.map(operation => [normalizeGovernedPath(operation.path), operation]),
  );
  const created = new Set(createdByThisExecution.map(normalizeGovernedPath));
  const operations = await Promise.all(repair.operations.map(async operation => {
    if (operation.type !== 'create') return operation;
    const governedPath = normalizeGovernedPath(operation.path);
    const approvedOperation = approvedByPath.get(governedPath);
    if (approvedOperation?.type !== 'create' || approvedOperation.snapshot.state !== 'absent' || !created.has(governedPath)) {
      return operation;
    }
    const inspection = new WorkspaceInspectionTools(workspaceRoot);
    const canonicalPath = await inspection.resolveInsideWorkspace(operation.path);
    const existsNow = await fs.stat(canonicalPath).then(() => true, error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    });
    return existsNow ? { ...operation, type: 'replace' as const } : operation;
  }));
  return { ...repair, operations };
}

function authorizeForgeTool(toolId: string, context: ReturnType<typeof createPermissionContext>) {
  const registry = new ReadOnlyForgeCallableRegistry();
  registry.register(FORGE_INVOKE_MODEL_DESCRIPTOR, async request => ({
    ok: false,
    method: request.method,
    error: { code: 'not_found', message: 'authorization-only' },
  }));
  return registry.authorizeGovernedTool(toolId, grantsFromPermissionContext(context));
}

/** Bounded, path-free rendering of a thrown error for diagnostics (the catch-all statuses hide it). */
function boundedErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Appends runtime-authored recovery guidance to the graph goal (never touches the profile-classified goal). */
function withRecoveryNotes(goal: string, recovery: ExecutionRecoverySession | undefined): string {
  if (!recovery || recovery.guidance.length === 0) return goal;
  return `${goal}\n\nRuntime recovery notes:\n${recovery.guidance.map(line => `- ${line}`).join('\n')}`;
}

function classifyError(error: unknown): GovernedCodingExecutionStatus {
  const message = error instanceof Error ? error.message : '';
  if (isGitPrerequisiteCode(message)) return 'git_prerequisite_unavailable';
  if (message === 'file_missing_at_binding') return 'file_missing_at_binding';
  if (message === 'create_target_exists') return 'create_target_exists';
  if (message === 'duplicate_proposal_target') return 'duplicate_proposal_target';
  if (message === 'mutation_evidence_missing') return 'mutation_evidence_missing';
  if (message === 'workspace_changed_after_review') return 'workspace_changed_after_review';
  if (message === 'dirty_document_blocked') return 'dirty_document_blocked';
  if (message === 'workspace_lease_held') return 'workspace_lease_held';
  if (message.startsWith('validation_side_effect_detected')) return 'validation_side_effect_detected';
  if (message === 'git_state_changed' || message === 'approval_replay_rejected') return message;
  if (message === 'snapshot_read_failed') return 'snapshot_read_failed';
  if (message.includes('path')) return 'path_rejected';
  return 'mutation_failed';
}

export async function verifyMutationEvidence(
  workspaceRoot: string,
  proposal: HostBoundCodingProposal,
  instructionRevision: number,
  mutation: MutationResult,
): Promise<VerifiedMutationEvidence> {
  const modifiedSet = new Set(mutation.filesModified.map(normalizeGovernedPath));
  const createdSet = new Set(mutation.filesCreated.map(normalizeGovernedPath));
  const deletedSet = new Set(mutation.filesDeleted.map(normalizeGovernedPath));

  for (const operation of proposal.operations) {
    const target = normalizeGovernedPath(operation.path);
    if (operation.type === 'replace') {
      if (deletedSet.has(target)) {
        throw Object.assign(new Error('mutation_semantics_mismatch: replace operation was executed as delete'), { mutationResult: mutation });
      }
      if (createdSet.has(target)) {
        throw Object.assign(new Error('mutation_semantics_mismatch: replace operation was executed as create'), { mutationResult: mutation });
      }
    } else if (operation.type === 'create') {
      if (deletedSet.has(target)) {
        throw Object.assign(new Error('mutation_semantics_mismatch: create operation was executed as delete'), { mutationResult: mutation });
      }
      if (modifiedSet.has(target)) {
        throw Object.assign(new Error('mutation_semantics_mismatch: create operation was executed as modify'), { mutationResult: mutation });
      }
    } else if (operation.type === 'delete') {
      if (modifiedSet.has(target) || createdSet.has(target)) {
        throw Object.assign(new Error('mutation_semantics_mismatch: delete operation was executed as write'), { mutationResult: mutation });
      }
    }
  }

  const changedPaths = await gitChangedPaths(workspaceRoot);
  const changed = new Set(changedPaths.map(normalizeGovernedPath));
  const expectedPaths = proposal.operations.map(operation => normalizeGovernedPath(operation.path));
  let contentVerified = true;
  const missingUnchanged: string[] = [];

  for (const operation of proposal.operations) {
    const target = normalizeGovernedPath(operation.path);
    let destinationMatches = false;
    if (operation.type === 'delete') {
      destinationMatches = !(await pathExists(operation.canonicalPath));
    } else {
      const actual = await fs.readFile(operation.canonicalPath, 'utf8').catch(() => undefined);
      destinationMatches = actual !== undefined && actual === operation.content;
    }
    contentVerified = contentVerified && destinationMatches;
    if (!destinationMatches) {
      throw Object.assign(new Error('mutation_evidence_missing'), { mutationResult: mutation });
    }

    if (!changed.has(target)) {
      const intendedHash = operation.content === undefined
        ? undefined
        : crypto.createHash('sha256').update(operation.content, 'utf8').digest('hex');
      const alreadySatisfiedAtBinding =
        operation.type === 'replace'
        && operation.snapshot.state === 'exists'
        && operation.snapshot.sha256 === intendedHash;
      if (!alreadySatisfiedAtBinding) missingUnchanged.push(target);
    }
  }

  if (missingUnchanged.length > 0) {
    throw Object.assign(new Error('mutation_evidence_missing'), { mutationResult: mutation });
  }
  const approvedChangedPaths = expectedPaths.filter(expected => changed.has(expected));
  return {
    instructionRevision,
    expectedPaths: [...new Set(expectedPaths)].sort(),
    changedPaths: [...new Set(approvedChangedPaths)].sort(),
    contentVerified,
    gitDiffPresent: approvedChangedPaths.length > 0,
    alreadySatisfied: approvedChangedPaths.length === 0,
    verifiedAt: new Date().toISOString(),
  };
}

async function gitChangedPaths(workspaceRoot: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    try {
      const child = spawn('git', hardenedGitArgs(['status', '--porcelain', '--untracked-files=all']), {
        cwd: workspaceRoot,
        shell: false,
        windowsHide: true,
        env: hardenedGitEnv(),
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('mutation_evidence_missing'));
      }, 15_000);
      child.stdout.on('data', data => { stdout += String(data); });
      child.stderr.on('data', data => { stderr += String(data); });
      child.on('error', () => {
        clearTimeout(timer);
        reject(new Error('mutation_evidence_missing'));
      });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) {
          void stderr;
          reject(new Error('mutation_evidence_missing'));
          return;
        }
        resolve(stdout
          .split(/\r?\n/)
          .filter(line => line.length > 3)
          .map(line => {
            const rest = line.slice(3);
            const arrow = rest.indexOf(' -> ');
            return normalizeGovernedPath(arrow === -1 ? rest : rest.slice(arrow + 4));
          })
          .filter(path => path && path !== '.ollama-agent' && !path.startsWith('.ollama-agent/')));
      });
    } catch {
      reject(new Error('mutation_evidence_missing'));
    }
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function mutationFromError(error: unknown): MutationResult | undefined {
  return typeof error === 'object' && error !== null && 'mutationResult' in error
    ? (error as { mutationResult?: MutationResult }).mutationResult
    : undefined;
}

function proposalConflictEvidenceFromError(error: unknown): ProposalConflictEvidence | undefined {
  return typeof error === 'object' && error !== null && 'proposalConflictEvidence' in error
    ? (error as { proposalConflictEvidence?: ProposalConflictEvidence }).proposalConflictEvidence
    : undefined;
}

/**
 * Best-effort HEAD commit SHA for the execution workspace, used purely as bounded
 * diagnostic context (targetExistedAtBase comparisons). Never throws: an
 * unavailable or non-Git workspace simply omits base-commit evidence.
 */
async function resolveHeadCommitSha(workspaceRoot: string): Promise<string | undefined> {
  return new Promise(resolve => {
    try {
      const child = spawn('git', hardenedGitArgs(['rev-parse', 'HEAD']), { cwd: workspaceRoot, shell: false, windowsHide: true, env: hardenedGitEnv() });
      let output = '';
      const timer = setTimeout(() => {
        child.kill();
        resolve(undefined);
      }, 5_000);
      child.stdout.on('data', data => { output += String(data); });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
      child.on('close', code => {
        clearTimeout(timer);
        resolve(code === 0 ? output.trim() || undefined : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Builds a single-operation CodingProposal directly from a deterministically-extracted write — no model involved. */
function buildDeterministicCodingProposal(write: { path: string; content: string; reason: string }): CodingProposal {
  const totalBytes = Buffer.byteLength(write.content, 'utf8');
  return {
    version: CODING_PROPOSAL_VERSION,
    taskSummary: write.reason,
    operations: [{ type: 'create', path: write.path, reason: write.reason, content: write.content }],
    validationCommands: [{ kind: 'git-status-short' }],
    limits: { maxFiles: 1, maxBytesPerFile: totalBytes, totalBytes },
    warnings: [],
    status: 'proposed',
  };
}

function formatStageProgressEvent(event: FixedMultiAgentStageProgressEvent): string {
  const base = `graph_stage_${event.type.replace('stage_', '')} stage=${event.stage} index=${event.index}/${event.total}`;
  if (event.type === 'stage_started') {
    return `${base} model=${event.model ?? 'unknown'} provider=${event.providerType ?? 'unknown'}`;
  }
  return `${base} durationMs=${event.durationMs ?? 0}`;
}

function proposalValidationFailedMessage(evidence: ProposalConflictEvidence): string {
  const reason = evidence.classification === 'create_target_exists'
    ? 'target_exists'
    : evidence.classification === 'file_missing_at_binding'
      ? 'target_missing'
      : 'duplicate_target';
  return `proposal_validation_failed operation=${evidence.operationIndex + 1}/${evidence.proposalOperationCount} action=${evidence.operationKind} path=${evidence.targetPath} reason=${reason} mutation_started=false`;
}

function normalizeGovernedPath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Identity of a validation command for repair-scope comparison. Excludes the
 * host-assigned proposal authorization: a repair re-parsed against the mutated
 * workspace sees the approved script as a workspace script. Only the approved
 * (authorized) commands ever run, and their runner re-checks package.json. */
function validationCommandIdentity(command: CodingValidationCommand): string {
  return JSON.stringify({ kind: command.kind, args: command.args ?? [], script: command.script });
}

function assertRepairWithinApproval(
  proposal: CodingProposal,
  approvedPaths: ReadonlySet<string>,
  approvedValidationCommands: ReadonlySet<string>,
): void {
  for (const operation of proposal.operations) {
    if (!approvedPaths.has(normalizeGovernedPath(operation.path))) {
      throw new Error('validation_repair_scope_broadened');
    }
    if (operation.type === 'delete') {
      throw new Error('validation_repair_delete_rejected');
    }
  }
  for (const command of proposal.validationCommands) {
    if (!approvedValidationCommands.has(validationCommandIdentity(command))) {
      throw new Error('validation_repair_command_broadened');
    }
  }
}

function buildValidationRepairCorrection(
  validations: readonly ValidationRunResult[],
  cycle: number,
  limit: number,
  anchoredEditsApplied = false,
): string {
  const failures = validations.filter(result => result.exitCode !== 0 || result.timedOut);
  return [
    `Validation repair cycle ${cycle} of ${limit}.`,
    'The previously approved implementation failed real validation.',
    ...(anchoredEditsApplied
      ? ['Its "edit" operations below are ALREADY APPLIED to the files. A repair edit must anchor on the CURRENT text (for example the newText that was written, or the current excerpts shown below), never on an oldText that was already replaced.']
      : []),
    'Use only the already-approved file paths. Do not delete files, weaken or remove tests,',
    'or add/change validation commands. Return a complete proposal containing only the',
    'minimal approved-scope edits needed to fix this exact evidence:',
    ...failures.map((failure, index) => [
      `Failure ${index + 1}: command=${failure.command}`,
      `exitCode=${failure.exitCode ?? 'null'} timedOut=${failure.timedOut}`,
      failure.output.slice(-4_000),
    ].join('\n')),
  ].join('\n\n');
}

function validationFailureMetadata(validations: readonly ValidationRunResult[], cycle: number): Record<string, unknown> {
  return {
    cycle,
    commandsRun: validations.length,
    failures: validations
      .filter(result => result.exitCode !== 0 || result.timedOut)
      .map(result => ({
        command: result.command,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
        output: result.output,
      })),
  };
}

function mergeMutations(left: MutationResult | undefined, right: MutationResult): MutationResult {
  if (!left) return right;
  const merge = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])];
  return {
    filesCreated: merge(left.filesCreated, right.filesCreated),
    filesModified: merge(left.filesModified, right.filesModified),
    filesDeleted: merge(left.filesDeleted, right.filesDeleted),
    filesRestored: merge(left.filesRestored, right.filesRestored),
    rollbackAttempted: left.rollbackAttempted || right.rollbackAttempted,
    rollbackSucceeded: left.rollbackSucceeded && right.rollbackSucceeded,
  };
}

/**
 * Bounded, machine-grounded correction sent back to the validator stage. Deliberately
 * excludes file contents, prompts and unrelated repository data.
 */
function buildProposalConflictCorrection(evidence: ProposalConflictEvidence): string {
  if (evidence.classification === 'create_target_exists') {
    return [
      'The proposal is invalid.',
      '',
      `Operation ${evidence.operationIndex + 1} of ${evidence.proposalOperationCount} proposes:`,
      'action: create',
      `path: ${evidence.targetPath}`,
      '',
      'The path existed at the bound base commit and still exists in the isolated worktree.',
      'Regenerate the complete proposal using a replace (edit) operation for that path.',
      'Recheck every other operation against the worktree. Create operations are permitted',
      'only for paths confirmed absent.',
      '',
      'Return a complete replacement proposal, not a partial patch.',
    ].join('\n');
  }
  if (evidence.classification === 'file_missing_at_binding') {
    return [
      'The proposal is invalid.',
      '',
      `Operation ${evidence.operationIndex + 1} of ${evidence.proposalOperationCount} proposes:`,
      `action: ${evidence.operationKind}`,
      `path: ${evidence.targetPath}`,
      '',
      'The path did not exist in the isolated worktree at binding time.',
      'Regenerate the complete proposal using a create operation for that path if it is',
      'still needed, or remove the operation if it is not.',
      '',
      'Return a complete replacement proposal, not a partial patch.',
    ].join('\n');
  }
  return [
    'The proposal is invalid.',
    '',
    `Operation ${evidence.operationIndex + 1} of ${evidence.proposalOperationCount} duplicates the target of operation ${(evidence.duplicateTargetIndex ?? 0) + 1}:`,
    `path: ${evidence.targetPath}`,
    '',
    'Regenerate the complete proposal so every operation targets a distinct path.',
    '',
    'Return a complete replacement proposal, not a partial patch.',
  ].join('\n');
}

function safeGraphReason(graph: FixedMultiAgentGraphResult): string {
  if (graph.status === 'cancelled') {
    return 'The fixed coding graph was cancelled before a proposal became executable.';
  }
  return graph.failedStage
    ? `The fixed coding graph stopped at ${graph.failedStage}.`
    : 'The fixed coding graph did not complete.';
}

function safeProposalConsumptionReason(
  proposalConsumption: FixedMultiAgentGraphResult['proposalConsumption'],
): string {
  if (proposalConsumption?.status === 'unavailable') {
    return 'The fixed coding graph completed without an executable proposal.';
  }
  const codes = boundedErrorCodes(proposalConsumption?.errors ?? []);
  // The shape is content-free (types, paths, counts) so a failed run is diagnosable without rerunning it.
  const shape = proposalConsumption?.shape ? ` Proposal shape: ${proposalConsumption.shape.slice(0, 400)}` : '';
  return codes
    ? `The fixed coding graph proposal did not pass host validation (${codes}).${shape}`
    : `The fixed coding graph proposal did not pass host validation.${shape}`;
}

/** Bounded, non-sensitive rendering of host-validation error codes for evidence. */
function boundedErrorCodes(errors: readonly string[]): string {
  return errors.slice(0, 6).join(', ');
}

/**
 * Host-validation rejections that must never be retried against the model:
 * security-boundary and resource-limit classes fail closed immediately.
 * Everything else (e.g. an invented npm script name, wrong path separators)
 * is a contract-shape mistake worth exactly one bounded regeneration —
 * whose output is then re-validated by the identical host contract.
 */
const CONTRACT_REPAIR_INELIGIBLE = new Set([
  'path_uri_scheme_rejected',
  'absolute_path_rejected',
  'path_traversal_rejected',
  'excluded_path_rejected',
  'credential_path_rejected',
  'model_response_too_large',
  'model_response_too_deep',
  'prototype_pollution_rejected',
  'binary_content_rejected',
  'file_count_limit_exceeded',
  'file_byte_limit_exceeded',
  'total_byte_limit_exceeded',
]);

export function isContractRepairEligible(errors: readonly string[]): boolean {
  return errors.length > 0 && errors.every(error => !CONTRACT_REPAIR_INELIGIBLE.has(error));
}

/**
 * Machine-grounded correction for a host-contract rejection, mirroring
 * buildProposalConflictCorrection: exact error codes plus the contract rules
 * the schema cannot express. Excludes prompts, file contents and repository data.
 */
function buildContractViolationCorrection(errors: readonly string[], packageScripts: readonly string[], repairHints: readonly string[] = []): string {
  const scripts = packageScripts.filter(script => script !== 'package' && !script.startsWith('test:live'));
  return [
    'The proposal is invalid.',
    '',
    `Host contract validation rejected it with: ${boundedErrorCodes(errors)}.`,
    '',
    'Correct the proposal so that:',
    '- every operation path is relative to the repository root and uses forward slashes only;',
    '- no two operations target the same path;',
    '- every operation has type create, replace, edit or delete and a non-empty reason; create/replace carry the complete file content; edit carries {"oldText","newText"} anchors whose oldText is copied exactly from the current file and occurs exactly once;',
    `- validationCommands entries are only {"kind":"git-diff-check"}, {"kind":"git-status-short"}, {"kind":"tsc-no-emit"}, {"kind":"npm-test"}, {"kind":"vitest","args":["--run","<path>.test.ts"]}, or {"kind":"npm-script","script":"<name>"} where <name> is exactly one of: ${scripts.length > 0 ? scripts.join(', ') : '(no npm scripts are available — do not use npm-script)'}.`,
    ...(repairHints.length > 0
      ? ['', 'Evidence for the rejected edit anchors (copy corrected oldText exactly from this current file text):', ...repairHints.slice(0, 3)]
      : []),
    '',
    'Return a complete replacement proposal, not a partial patch.',
  ].join('\n');
}

function safeReason(code: string): string {
  switch (code) {
    case 'cancelled': return 'The coding task was cancelled safely.';
    case 'file_missing_at_binding': return 'A proposed replace or delete target was missing during host snapshot binding.';
    case 'create_target_exists': return 'A proposed create target already existed during host snapshot binding.';
    case 'workspace_changed_after_review': return 'The workspace changed after proposal review, so mutation stopped and rollback was attempted.';
    case 'dirty_document_blocked': return 'A target editor document has unsaved changes. Save or close it before running Forge.';
    case 'workspace_lease_held': return 'Another Forge execution holds the workspace mutation lease.';
    case 'validation_side_effect_detected': return 'Validation produced an unexpected workspace side effect.';
    case 'git_state_changed': return 'The branch or HEAD changed after approval.';
    case 'approval_replay_rejected': return 'The approval envelope was already used or is stale.';
    case 'snapshot_read_failed': return 'The host could not safely read a proposed file snapshot.';
    case 'path_rejected': return 'A proposed path was rejected by the workspace boundary.';
    case 'duplicate_proposal_target': return 'Two proposal operations targeted the same normalized path during host snapshot binding.';
    case 'readiness_blocked': return 'Readiness checks blocked execution.';
    default: return 'The coding task failed before a complete successful result was available.';
  }
}
