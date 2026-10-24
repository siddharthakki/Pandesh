import { AgentMode } from '../config/ConfigSchema';
import { PersistedApproval, PersistedTask, PersistedCheckpointRef } from './TaskTypes';
import type { GovernedModelFailureCode, ModelExecutionEvidence } from './GovernedModelExecutionTypes';

export type AgentPhase =
  | 'created'
  | 'understanding'
  | 'planning'
  | 'ready'
  | 'executing'
  | 'waiting_for_approval'
  | 'validating'
  | 'repairing'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovering';

export type ForgeInvocationStatusPhase =
  | 'accepted'
  | 'approval_required'
  | 'running'
  | 'blocked'
  | 'failed'
  | 'verified'
  | 'delivered'
  | 'cancelled';

export interface ForgeInvocationAuditMetadata {
  callerId?: string;
  correlationId?: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface ForgeInvocationStatus {
  invocationId: string;
  taskId: string;
  phase: ForgeInvocationStatusPhase;
  createdAt: string;
  updatedAt: string;
  cancellationReason?: string;
  errorSummary?: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationPreparationRequest {
  invocationId: string;
  taskId: string;
  goal: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationPreparation {
  invocationId: string;
  taskId: string;
  ready: boolean;
  phase: 'prepared';
  contractVersion: 1;
  nonExecuting: true;
  sideEffects: 'none';
  validation: {
    accepted: boolean;
    errors: string[];
  };
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartEligibilityRequest {
  invocationId: string;
  taskId: string;
  goal: string;
  prepared: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartEligibility {
  invocationId: string;
  taskId: string;
  eligible: boolean;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  missingPrerequisites: string[];
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationRequest {
  invocationId: string;
  taskId: string;
  goal: string;
  prepared: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservation {
  accepted: boolean;
  reservationId?: string;
  invocationId: string;
  taskId: string;
  eligibilityBasis: ForgeInvocationStartEligibility;
  contractVersion: 1;
  sideEffects: 'metadata-only';
  nonExecuting: true;
  createdAt: string;
  expiresAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationLookupRequest {
  reservationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationLookup {
  found: boolean;
  reservationId: string;
  reservation?: ForgeInvocationStartReservation;
  active: boolean;
  expired: boolean;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationExpirationRequest {
  reservationId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationExpiration {
  expired: boolean;
  found: boolean;
  reservationId: string;
  reservation?: ForgeInvocationStartReservation;
  contractVersion: 1;
  sideEffects: 'metadata-only';
  nonExecuting: true;
  expiredAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}
export interface ForgeInvocationStartReservationListRequest {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartReservationList {
  reservations: ForgeInvocationStartReservation[];
  total: number;
  active: number;
  expired: number;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationAcquireRequest {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationLease {
  reservationId: string;
  ownerId: string;
  leaseId: string;
  acquiredAt: string;
  expiresAt: string;
}

export interface ForgeInvocationReservationAcquire {
  acquired: boolean;
  alreadyOwned: boolean;
  reservationId: string;
  lease?: ForgeInvocationReservationLease;
  contractVersion: 1;
  sideEffects: 'metadata-only';
  nonExecuting: true;
  checkedAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationReleaseRequest {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationRelease {
  released: boolean;
  alreadyReleased: boolean;
  reservationId: string;
  contractVersion: 1;
  sideEffects: 'metadata-only';
  nonExecuting: true;
  checkedAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationMetricsRequest {
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationMetrics {
  total: number;
  active: number;
  expired: number;
  leased: number;
  available: number;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationQueueEntry {
  reservationId: string;
  position: number;
  invocationId: string;
  taskId: string;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  leased: boolean;
  ownerId?: string;
}

export interface ForgeInvocationQueueInspectionRequest {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationQueueInspection {
  entries: ForgeInvocationQueueEntry[];
  total: number;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerSnapshotRequest {
  includeExpired?: boolean;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerSnapshot {
  metrics: ForgeInvocationReservationMetrics;
  queue: ForgeInvocationQueueEntry[];
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerValidationRequest {
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeSchedulerValidationIssue {
  code: string;
  message: string;
  reservationId?: string;
}

export interface ForgeSchedulerValidation {
  valid: boolean;
  issues: ForgeSchedulerValidationIssue[];
  checkedReservations: number;
  checkedLeases: number;
  contractVersion: 1;
  sideEffects: 'none';
  nonExecuting: true;
  checkedAt: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationLeaseRenewalRequest {
  reservationId: string;
  ownerId: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationReservationLeaseRenewal {
  renewed: boolean;
  reservationId: string;
  lease?: ForgeInvocationReservationLease;
  contractVersion: 1;
  sideEffects: 'metadata-only';
  nonExecuting: true;
  checkedAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStartRequest {
  invocationId: string;
  taskId: string;
  goal: string;
  reservationId: string;
  mode?: AgentMode;
  model?: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationStart {
  invocationId: string;
  taskId: string;
  reservationId: string;
  started: boolean;
  status?: ForgeInvocationStatus;
  contractVersion: 1;
  sideEffects: 'metadata-only' | 'task-lifecycle';
  nonExecuting: boolean;
  executionBoundary?: ForgeExecutionBoundary;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
  evidence: ForgeInvocationStartEvidence;
}

export interface ForgeInvocationStartEvidence {
  invocationId: string;
  taskId: string;
  reservationId: string;
  decision: 'started' | 'rejected';
  lifecycleAction: 'startTask' | 'none';
  sideEffects: 'metadata-only' | 'task-lifecycle';
  nonExecuting: boolean;
  status?: ForgeInvocationStatus;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeExecutionBoundary {
  taskId: string;
  goal: string;
  mode: AgentMode;
  model?: string;
  audit?: ForgeInvocationAuditMetadata;
}

export type ForgeInvocationLifecycleControlAction = 'pause' | 'resume' | 'cancel';

export interface ForgeInvocationLifecycleControlRequest {
  invocationId: string;
  action: ForgeInvocationLifecycleControlAction;
  reason?: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationLifecycleControl {
  invocationId: string;
  taskId: string;
  action: ForgeInvocationLifecycleControlAction;
  applied: boolean;
  status?: ForgeInvocationStatus;
  contractVersion: 1;
  sideEffects: 'task-lifecycle';
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

/**
 * M4.3 contract: one governed model call gated by an existing accepted,
 * non-expired start reservation. Deliberately does not call
 * `LocalAgentEngine.startTask` — that method activates the existing
 * autonomous `AgentLoop` (tools, planning, multiple model calls), which is
 * incompatible with the "exactly one model call, zero tools, zero planning"
 * invariant this contract must uphold.
 *
 * The reservation is the sole authority for both prompt and
 * invocation/task identity: the accepted reservation already owns the
 * governed goal, so the caller cannot resupply or substitute it here, and
 * `invocationId`/`taskId` are derived from the validated reservation rather
 * than accepted from the caller. This is also the smallest transport-safe,
 * JSON-serializable request shape — no `AbortSignal` or other non-
 * serializable field is present; cancellation is resolved internally by the
 * adapter.
 */
export interface ForgeInvocationModelCallRequest {
  reservationId: string;
  model: string;
  audit?: ForgeInvocationAuditMetadata;
}

export interface ForgeInvocationModelCall {
  invocationId: string;
  taskId: string;
  reservationId: string;
  invoked: boolean;
  completion?: string;
  contractVersion: 1;
  sideEffects: 'model-call' | 'metadata-only';
  nonExecuting: boolean;
  failureCode?: GovernedModelFailureCode;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
  evidence: ModelExecutionEvidence;
}

/**
 * M4.5-M4.6 contract: read-only outcome of looking up a governed model
 * execution result/evidence by the reservation it was invoked under, scoped
 * to the invocation/task identity that owns that reservation.
 *
 * - `pending`: a reservation or in-flight call exists but has not reached a
 *   terminal outcome yet — never fabricated as `failed`/`completed`.
 * - `ownership_mismatch`: the reservation exists but is not owned by the
 *   requested invocation/task identity; no evidence is returned.
 * - `not_found`: no reservation, in-flight call or completed call is known
 *   for the requested reservationId.
 * - `invalid_request`: the request shape itself failed validation.
 * - `completed` / `failed` / `cancelled`: the reservation's governed model
 *   call reached that terminal `ModelExecutionEvidence.status`.
 */
export type ForgeInvocationModelResultOutcome =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'pending'
  | 'not_found'
  | 'ownership_mismatch'
  | 'invalid_request';

export interface ForgeInvocationModelResultLookupRequest {
  reservationId: string;
  invocationId: string;
  taskId: string;
  audit?: ForgeInvocationAuditMetadata;
}

/**
 * Deliberately has no `completion` field: `ReadOnlyForgeInvocationAdapter`
 * only retains a redacted (completion-stripped) copy of a completed model
 * call for later lookups (see M4.3's `completedModelCalls` correction), so a
 * terminal completion is retrievable exactly once, by whoever received the
 * original `forge.invocation.invokeModel` result — never again afterward.
 * This retrieval surface honors that existing constraint rather than adding
 * a new store to work around it.
 */
export interface ForgeInvocationModelResultLookup {
  found: boolean;
  ready: boolean;
  outcome: ForgeInvocationModelResultOutcome;
  reservationId: string;
  invocationId: string;
  taskId: string;
  model?: string;
  invoked?: boolean;
  failureCode?: GovernedModelFailureCode;
  evidence?: ModelExecutionEvidence;
  contractVersion: 1;
  nonExecuting: true;
  sideEffects: 'none';
  checkedAt: string;
  reasons: Array<{
    code: string;
    message: string;
  }>;
  audit?: ForgeInvocationAuditMetadata;
}

export type TransitionReason =
  | 'user_request'
  | 'model_result'
  | 'tool_request'
  | 'approval_required'
  | 'approval_granted'
  | 'approval_rejected'
  | 'validation_passed'
  | 'validation_failed'
  | 'repair_requested'
  | 'reviewer_rejected'
  | 'validator_rejected'
  | 'budget_exhausted'
  | 'no_progress'
  | 'user_pause'
  | 'user_resume'
  | 'user_cancel'
  | 'provider_failure'
  | 'policy_denial'
  | 'recovery_decision'
  | 'internal_error'
  | 'stale_permission_context';

export interface TaskBudgets {
  maxWallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxRepairAttempts: number;
  maxIterations: number;
  maxCommandDurationMs: number;
  maxOutputBytes: number;
  maxNoProgressSteps: number;
}

export interface TaskUsage {
  startedAt?: string;
  activeSince?: string;
  pausedAt?: string;
  elapsedActiveMs: number;
  waitingApprovalMs: number;
  modelCalls: number;
  toolCalls: number;
  repairAttempts: number;
  iterations: number;
  outputBytes: number;
  noProgressSteps: number;
  lastProgressAt?: string;
  lastProgressFingerprint?: string;
  lastValidationFingerprint?: string;
  repeatedValidationFailures: number;
}

export interface SteeringMessage {
  steeringId: string;
  taskId: string;
  content: string;
  createdAt: string;
  appliedAt?: string;
}

export interface StartTaskRequest {
  taskId?: string;
  goal: string;
  mode: AgentMode;
  model?: string;
  images?: string[];
  budgets?: Partial<TaskBudgets>;
  validationCommands?: ValidationCommandRequest[];
}

export interface ContinueTaskInput {
  text: string;
  images?: string[];
  model?: string;
}

export interface ValidationCommandRequest {
  id?: string;
  category:
    | 'compile'
    | 'typecheck'
    | 'unit_test'
    | 'integration_test'
    | 'lint'
    | 'format'
    | 'diagnostics'
    | 'security'
    | 'acceptance'
    | 'git_diff_scope';
  command: string;
  required: boolean;
  timeoutMs?: number;
}

export type ApprovalDecision = 'approved' | 'rejected';

export type RollbackTarget =
  | { kind: 'checkpoint'; checkpointId: string }
  | { kind: 'iteration'; iterationId: string }
  | { kind: 'last_action' }
  | { kind: 'task_start'; confirm: boolean };

export interface TaskFilter {
  phases?: AgentPhase[];
  includeTerminal?: boolean;
}

export interface AgentTaskSnapshot {
  task: PersistedTask;
  phase: AgentPhase;
  budgets: TaskBudgets;
  usage: TaskUsage;
  pendingApproval?: PersistedApproval;
  checkpoints: PersistedCheckpointRef[];
  blockedReason?: string;
  validationPassed?: boolean;
}

export type AgentEngineEventType =
  | 'snapshot'
  | 'phase_transition'
  | 'planning_progress'
  | 'model_started'
  | 'token_delta'
  | 'model_completed'
  | 'tool_requested'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'approval_requested'
  | 'approval_resolved'
  | 'checkpoint_created'
  | 'validation_started'
  | 'validation_result'
  | 'repair_started'
  | 'budget_warning'
  | 'budget_exhausted'
  | 'loop_detected'
  | 'paused'
  | 'resumed'
  | 'steering_accepted'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovery_warning';

export interface AgentEngineEvent {
  eventId: string;
  taskId: string;
  type: AgentEngineEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface EngineSubscription {
  dispose(): void;
}

export interface AgentEngine {
  startTask(request: StartTaskRequest): Promise<AgentTaskSnapshot>;
  continueTask(taskId: string, input: ContinueTaskInput): Promise<AgentTaskSnapshot>;
  subscribe(taskId: string, listener: (event: AgentEngineEvent) => void): EngineSubscription;
  respondToApproval(taskId: string, approvalId: string, decision: ApprovalDecision): Promise<AgentTaskSnapshot>;
  sendSteering(taskId: string, message: string): Promise<AgentTaskSnapshot>;
  pauseTask(taskId: string): Promise<AgentTaskSnapshot>;
  resumeTask(taskId: string): Promise<AgentTaskSnapshot>;
  cancelTask(taskId: string): Promise<AgentTaskSnapshot>;
  getTask(taskId: string): Promise<AgentTaskSnapshot>;
  listTasks(filter?: TaskFilter): Promise<AgentTaskSnapshot[]>;
  rollbackTask(taskId: string, target: RollbackTarget): Promise<AgentTaskSnapshot>;
}

export const DEFAULT_TASK_BUDGETS: TaskBudgets = {
  maxWallClockMs: 60 * 60 * 1000,
  maxModelCalls: 30,
  maxToolCalls: 100,
  maxRepairAttempts: 3,
  maxIterations: 20,
  maxCommandDurationMs: 120_000,
  maxOutputBytes: 5 * 1024 * 1024,
  maxNoProgressSteps: 4,
};

export function createInitialUsage(now = new Date().toISOString()): TaskUsage {
  return {
    startedAt: now,
    activeSince: now,
    elapsedActiveMs: 0,
    waitingApprovalMs: 0,
    modelCalls: 0,
    toolCalls: 0,
    repairAttempts: 0,
    iterations: 0,
    outputBytes: 0,
    noProgressSteps: 0,
    lastProgressAt: now,
    repeatedValidationFailures: 0,
  };
}




