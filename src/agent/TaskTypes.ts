/**
 * Durable task, engine-state, validation, and recovery types.
 *
 * The Phase 6 additions are optional so Phase 5 task records remain readable.
 * Existing schema-version 1 task files therefore migrate structurally without a
 * destructive rewrite; new writes populate the optional engine fields.
 */

export const TASK_SCHEMA_VERSION = 1;
export const EVENT_SCHEMA_VERSION = 1;
export const MESSAGE_SCHEMA_VERSION = 1;
export const APPROVAL_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;

export type PersistedAgentPhase =
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

export type PersistedTaskStatus =
  | 'created'
  | 'running'
  | 'waiting_for_approval'
  | 'paused'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovering';

export interface PersistedFailure {
  message: string;
  code?: string;
  timestamp: string;
}

/** Legacy Phase 5 budget shape retained for compatibility. */
export interface PersistedBudgets {
  maxIterations: number;
  usedIterations: number;
}

export interface PersistedEngineBudgets {
  maxWallClockMs: number;
  maxModelCalls: number;
  maxToolCalls: number;
  maxRepairAttempts: number;
  maxIterations: number;
  maxCommandDurationMs: number;
  maxOutputBytes: number;
  maxNoProgressSteps: number;
}

export interface PersistedEngineUsage {
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

export interface PersistedSteeringMessage {
  steeringId: string;
  taskId: string;
  content: string;
  createdAt: string;
  appliedAt?: string;
}

export interface PersistedValidationCommand {
  id?: string;
  category: string;
  command: string;
  required: boolean;
  timeoutMs?: number;
}

export interface PersistedTask {
  schemaVersion: number;
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  title?: string;
  userGoal: string;
  mode: string;
  status: PersistedTaskStatus;
  providerType: string;
  providerEndpoint?: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  failure?: PersistedFailure;
  budgets?: PersistedBudgets;
  currentIteration?: number;
  pendingApprovalId?: string;
  latestCheckpointId?: string;

  /** Phase 6 engine state. Optional for Phase 5 task compatibility. */
  phase?: PersistedAgentPhase;
  resumePhase?: PersistedAgentPhase;
  engineBudgets?: PersistedEngineBudgets;
  engineUsage?: PersistedEngineUsage;
  pendingSteering?: PersistedSteeringMessage[];
  blockedReason?: string;
  validationPassed?: boolean;
  validationAttempt?: number;
  validationCommands?: PersistedValidationCommand[];
  allowedPaths?: string[];
}

export type PersistedEventType =
  | 'task_created'
  | 'task_started'
  | 'user_message'
  | 'assistant_message'
  | 'stream_summary'
  | 'model_selected'
  | 'iteration_started'
  | 'tool_requested'
  | 'policy_decision'
  | 'approval_requested'
  | 'approval_resolved'
  | 'checkpoint_created'
  | 'tool_started'
  | 'tool_completed'
  | 'tool_failed'
  | 'task_paused'
  | 'task_resumed'
  | 'task_cancelled'
  | 'task_blocked'
  | 'task_completed'
  | 'task_failed'
  | 'recovery_started'
  | 'recovery_completed'
  | 'recovery_failed'
  | 'phase_transition'
  | 'steering_received'
  | 'steering_applied'
  | 'budget_warning'
  | 'budget_exhausted'
  | 'loop_detected'
  | 'validation_started'
  | 'validation_result'
  | 'repair_started'
  | 'task_result_written';

export interface PersistedEvent {
  schemaVersion: number;
  eventId: string;
  taskId: string;
  seq: number;
  timestamp: string;
  type: PersistedEventType;
  parentEventId?: string;
  correlationId?: string;
  payload: Record<string, unknown>;
}

export interface PersistedToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface PersistedMessage {
  schemaVersion: number;
  messageId: string;
  taskId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** Full neutral calls for protocol-correct resume. */
  toolCalls?: PersistedToolCall[];
  /** Legacy Phase 5 field retained for older task logs. */
  toolCallIds?: string[];
  toolCallId?: string;
  toolName?: string;
  imageRefs?: string[];
  timestamp: string;
  iterationId?: string;
  model?: string;
  providerType?: string;
}

export type PersistedApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'interrupted';

export interface PersistedApproval {
  schemaVersion: number;
  approvalId: string;
  taskId: string;
  toolCallId?: string;
  toolName: string;
  argsSummary: Record<string, unknown>;
  policyDecision: string;
  riskLevel: string;
  requestedAt: string;
  expiresAt?: string;
  status: PersistedApprovalStatus;
  resolvedAt?: string;
  resolution?: 'approved' | 'rejected';
}

export interface PersistedCheckpointRef {
  checkpointId: string;
  taskId: string;
  toolCallId?: string;
  toolName: string;
  iterationId?: string;
  timestamp: string;
  affectedPaths: string[];
  restorationStatus: 'none' | 'restored' | 'failed';
  retained: boolean;
}

export interface TaskSnapshot {
  schemaVersion: number;
  taskId: string;
  snapshotSeq: number;
  timestamp: string;
  task: PersistedTask;
  pendingApproval?: PersistedApproval;
  checkpointRefs: PersistedCheckpointRef[];
}

export interface TaskLock {
  taskId: string;
  pid: number;
  hostname: string;
  lockedAt: string;
  heartbeatAt: string;
  extensionSessionId: string;
}

export type InterruptionKind =
  | 'inference_interrupted'
  | 'approval_interrupted'
  | 'tool_execution_unknown'
  | 'mutation_completed_missing_event'
  | 'checkpoint_exists_result_missing'
  | 'completed_snapshot_not_updated';

export interface RecoveryCandidate {
  taskId: string;
  task: PersistedTask;
  interruptionKind?: InterruptionKind;
  mutationOutcomeUncertain: boolean;
  pendingApproval?: PersistedApproval;
  lastCheckpointRef?: PersistedCheckpointRef;
  snapshotEventSeq: number;
  totalEventSeq: number;
  issues: string[];
}

export interface CreateTaskParams {
  taskId: string;
  workspaceId: string;
  workspaceRoot: string;
  userGoal: string;
  mode: string;
  model: string;
  providerType: string;
  providerEndpoint?: string;
  title?: string;
  phase?: PersistedAgentPhase;
  engineBudgets?: PersistedEngineBudgets;
  engineUsage?: PersistedEngineUsage;
  validationCommands?: PersistedValidationCommand[];
  allowedPaths?: string[];
}
