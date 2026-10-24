/**
 * Wire types shared between the KarkeDikha Core process and the VS Code
 * extension's CoreClient. Both `core/` and `src/core-client/` import this
 * module directly (no shared npm package needed at this scale).
 */

import type { ContextWindowSource } from './contextBudget';
import type { RoutingDecisionEvidence } from '../domain/empiricalRouting';

export const CORE_API_VERSION = 1;

export type ProjectStatus = 'active' | 'archived';

export interface ProjectRecord {
  id: string;
  name: string;
  aliases: string[];
  description: string | null;
  status: ProjectStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  defaultRepositoryId: string | null;
  productContext: Record<string, unknown> | null;
  policyMetadata: Record<string, unknown> | null;
  revision: number;
}

export type RepositoryKind = 'git' | 'non-git';

export interface RepositoryRecord {
  id: string;
  projectId: string;
  name: string;
  remoteUrl: string | null;
  defaultBranch: string | null;
  kind: RepositoryKind;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  revision: number;
}

export type RepositoryLocationCapability =
  | 'registered_non_git'
  | 'git_no_origin'
  | 'git_with_origin'
  | 'unavailable_path'
  | 'inaccessible_path'
  | 'offline_node';

export interface RepositoryLocationRecord {
  id: string;
  repositoryId: string;
  nodeIdentity: string;
  localPath: string;
  availability: 'available' | 'unavailable';
  gitCapable: boolean;
  remoteCapable: boolean;
  lastObservedAt: string;
  repositoryRootIdentity: string | null;
  currentBranch: string | null;
  isClean: boolean | null;
  capability: RepositoryLocationCapability;
}

export const STORY_STATUSES = [
  'inbox',
  'discovery',
  'ready',
  'assigned',
  'planning',
  'proposal_approval',
  'implementing',
  'review',
  'validation',
  'delivery_approval',
  'merge_queue',
  'done',
  'blocked',
  'failed',
  'cancelled',
  'deferred',
  'archived',
] as const;
export type StoryStatus = (typeof STORY_STATUSES)[number];

export const STORY_TYPES = ['initiative', 'epic', 'story', 'bug', 'research', 'task'] as const;
export type StoryType = (typeof STORY_TYPES)[number];

export interface StoryRecord {
  id: string;
  projectId: string;
  repositoryId: string | null;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: string | null;
  status: StoryStatus;
  storyType: StoryType;
  parentId: string | null;
  assignee: Record<string, unknown> | null;
  source: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  revision: number;
}

export const DEPENDENCY_TYPES = ['blocks', 'blocked_by', 'parent_child', 'related'] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export interface StoryDependencyRecord {
  id: string;
  storyId: string;
  dependsOnStoryId: string;
  dependencyType: DependencyType;
  createdAt: string;
}

export const STORY_EVENT_TYPES = [
  'story_created',
  'story_updated',
  'story_transitioned',
  'story_archived',
  'comment_added',
  'dependency_added',
  'dependency_removed',
  'migration_imported',
] as const;
export type StoryEventType = (typeof STORY_EVENT_TYPES)[number];

export interface StoryEventRecord {
  sequence: number;
  id: string;
  storyId: string;
  eventType: StoryEventType;
  actor: string;
  clientId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
  resultingRevision: number | null;
}

export interface StoryCommentRecord {
  id: string;
  storyId: string;
  author: string;
  body: string;
  createdAt: string;
}

export type ClientType = 'vscode' | 'desktop' | 'ios' | 'headless';

export interface ClientDeviceRecord {
  id: string;
  clientType: ClientType;
  clientVersion: string;
  firstSeenAt: string;
  lastSeenAt: string;
  deviceLabel: string | null;
  compatibilityStatus: 'compatible' | 'incompatible';
}

export interface BoardSnapshot {
  latestSequence: number;
  projects: ProjectRecord[];
  stories: StoryRecord[];
  serverTimeIso: string;
}

export interface CoreInfo {
  coreVersion: string;
  apiVersion: number;
  instanceId: string;
  startedAt: string;
  nodeVersion: string;
  electronVersion: string | null;
  dataDir: string;
  /** SHA-256 of the running Core bundle. Absent on older builds. */
  bundleHash?: string;
  /** True while this process has in-flight model or capability work. */
  busy?: boolean;
}

export interface StructuredErrorBody {
  error: {
    code: string;
    message: string;
    correlationId: string;
    details?: Record<string, unknown>;
  };
}

export type CoreErrorCode =
  | 'unauthenticated'
  | 'invalid_request'
  | 'not_found'
  | 'conflict'
  | 'revision_mismatch'
  | 'idempotency_key_conflict'
  | 'invalid_transition'
  | 'dependency_violation'
  | 'fence_stale'
  | 'context_missing'
  | 'context_mismatch'
  | 'database_failed'
  | 'internal_error';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
export const AUTH_HEADER = 'authorization';

// ---------------------------------------------------------------------------
// M32 — durable agent-runtime types (conversations, request envelopes,
// execution attempts, model/tool invocations, approvals, checkpoints).
// See docs/m32-architecture.md and docs/m32-decisions.md.
// ---------------------------------------------------------------------------

/** Baat Kar / Saath Kar — the two modes that hold a conversation. Karke Dikha
 * attempts are goal-driven and do not require a conversation container. */
export type ConversationMode = 'baat_kar' | 'saath_kar';

export interface ConversationRecord {
  id: string;
  mode: ConversationMode;
  projectId: string | null;
  repositoryId: string | null;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
  revision: number;
}

/** Jarvis Conversations rail Checkpoint 1 — derived per-conversation state.
 * Never stored; computed fresh from the latest attempt for the conversation
 * so it can never drift from Core's authoritative execution records. */
export type ConversationRailState = 'active' | 'needs_approval' | 'completed' | 'failed' | 'stopped';

export interface ConversationRailEntry extends ConversationRecord {
  preview: string | null;
  state: ConversationRailState;
  repositoryName: string | null;
}

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface RequestDiagnosticsRecord {
  conversationId: string;
  requestId: string;
  attemptId: string;
  model: string;
  provider: string;
  currentUserMessage: string;
  selectedWorkspace: string | null;
  messageHistoryCount: number;
  contextTruncation: {
    truncated: boolean;
    omittedCount: number;
    budgetChars?: number;
    beforeChars?: number;
    afterChars?: number;
  };
  toolInvocationIds: string[];
  outputAssociation: {
    assistantMessageId?: string;
    modelInvocationId?: string | null;
    finalOutcome?: string;
  };
}

export interface ConversationMessageRecord {
  seq: number;
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  modelInvocationId: string | null;
  createdAt: string;
  model?: string | null;
  provider?: string | null;
  diagnostics?: RequestDiagnosticsRecord | null;
}

export interface WorkspaceConversationIndexEntry {
  workspaceIdentity: string;
  localConversationId: string;
  conversationId: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  schemaVersion: number;
  migrationMetadata: Record<string, unknown>;
}

export interface ConversationLedgerTurn {
  seq: number;
  id: string;
  conversationId: string;
  requestId: string;
  attemptId: string;
  userMessageId: string | null;
  assistantMessageIds: string[];
  mode: ResolvedMode;
  taskId: string | null;
  approvalIds: string[];
  outcome: 'active' | 'rejected' | 'cancelled' | 'blocked' | 'completed' | 'failed';
  projectionId: string;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
  schemaVersion: number;
  migrationMetadata: Record<string, unknown>;
}

export interface WorkspaceConversationLedgerSnapshot {
  schemaVersion: number;
  workspaceIdentity: string;
  currentConversationId: string | null;
  currentCoreConversationId: string | null;
  conversations: WorkspaceConversationIndexEntry[];
  turns: ConversationLedgerTurn[];
  migrationMetadata: Record<string, unknown>;
}

/**
 * Durable Conversational Continuity V1 — the bounded, derived working state
 * for ONE conversation. This is deliberately NOT a second transcript and NOT
 * a general memory store: `conversation_messages` remains the only durable
 * record of what was said, and the repository remains the only authority on
 * what the code currently is. Everything here is a small, explicitly-derived
 * summary that lets a referential follow-up ("continue", "fix it") resolve
 * its referent after a restart without the user restating the task.
 */
export type ConversationExecutionPolicy = 'READ_ONLY' | 'COLLABORATIVE_EDIT' | 'AUTONOMOUS_EXECUTION';

/** One explicit user constraint, scoped to the active objective — never a
 * global, cross-project preference (milestone Step 4). */
export interface ConversationConstraint {
  id: string;
  text: string;
  createdAt: string;
}

/**
 * A file the objective referred to, plus the SHA-256 of its bytes when it was
 * last observed. The hash exists ONLY so a resumed conversation can detect
 * that the repository moved underneath the persisted narrative; it is never
 * treated as evidence that the file still looks that way (milestone
 * PRINCIPLE + Step 6).
 */
export interface ConversationRelevantFile {
  path: string;
  contentHash: string | null;
  observedAt: string;
}

/** The single unfinished next action, if the objective left one. */
export interface ConversationPendingAction {
  kind: 'awaiting_approval' | 'awaiting_validation' | 'awaiting_user_decision' | 'resume_work';
  description: string;
}

export interface ConversationWorkingStateRecord {
  conversationId: string;
  workspaceIdentity: string;
  /** Changes exactly when a new objective starts — the boundary identity a
   * follow-up is resolved against. */
  objectiveId: string;
  currentObjective: string;
  latestUserIntent: string;
  latestExecutionPolicy: ConversationExecutionPolicy | null;
  relevantFiles: ConversationRelevantFile[];
  relevantSymbols: string[];
  userConstraints: ConversationConstraint[];
  latestFindingsSummary: string | null;
  pendingAction: ConversationPendingAction | null;
  latestTaskId: string | null;
  latestProposalId: string | null;
  latestValidationSummary: string | null;
  /**
   * Set when the user just confirmed "New Task" (in reply to an objective
   * boundary ambiguity prompt, or an explicit New Task action) but has not
   * yet typed the new objective. While true, the NEXT substantive message
   * bypasses continuation-vs-new classification and becomes the objective
   * directly — this durable flag is what makes that bypass survive a
   * restart between the confirmation and the new objective text.
   */
  pendingNewObjective: boolean;
  /**
   * Set when KKD just asked the user a control question that expects one of
   * the closed-vocabulary replies `classifyControlAcknowledgement` matches
   * ("Continue?", "Should I treat it as a new task?"). A bare "yes",
   * "continue", or "retry" may ONLY be read as a control acknowledgement
   * (and force `same_objective` routing) while this is true — otherwise the
   * same words typed as ordinary chat content would silently and incorrectly
   * alter objective state. Cleared on every ordinary turn write, exactly like
   * `pendingNewObjective`.
   */
  awaitingObjectiveClarification: boolean;
  createdAt: string;
  updatedAt: string;
  /** Monotonic per-conversation revision of this derived record. */
  version: number;
}

/** The four user-facing modes. 'auto' is only ever a `requestedMode` — a
 * request's `resolvedMode` is always one of the other three. */
export type RequestedMode = 'baat_kar' | 'saath_kar' | 'auto' | 'karke_dikha';
export type ResolvedMode = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export interface ToolPermissionPolicy {
  profile?: string;
  allowedTools?: string[];
  [key: string]: unknown;
}

export interface ContextPolicy {
  /** Explicit, bounded context layers included for this request — never "entire transcript". */
  includeConversationHistory: boolean;
  includeProjectContext: boolean;
  includeRepositoryContext: boolean;
  includeGlobalStoryContext: boolean;
  [key: string]: unknown;
}

/** Immutable once created — no update route exists for this record. */
export interface RequestEnvelopeRecord {
  id: string;
  createdAt: string;
  clientId: string;
  currentMessage: string;
  requestedMode: RequestedMode;
  resolvedMode: ResolvedMode;
  routeReason: string;
  conversationId: string | null;
  storyId: string | null;
  projectId: string | null;
  repositoryId: string | null;
  repositoryLocationId: string | null;
  requestedProvider: string | null;
  requestedModel: string | null;
  toolPermissionPolicy: ToolPermissionPolicy;
  contextPolicy: ContextPolicy;
  correlationId: string;
  idempotencyKey: string | null;
}

export const ATTEMPT_STATUSES = [
  'created',
  'queued',
  'running',
  'waiting_for_approval',
  'validating',
  'paused',
  'blocked',
  'cancelling',
  'completed',
  'failed',
  'cancelled',
  'recovery_required',
] as const;
export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export type AttemptKind = 'baat_kar' | 'saath_kar' | 'karke_dikha';

export interface AttemptRecord {
  id: string;
  requestId: string;
  predecessorAttemptId: string | null;
  /**
   * The attempt that owns this one. Set only for a capability anchor attempt
   * created for a single owning attempt, which is what allows Core to settle
   * it when the owner terminates. Null for a top-level attempt and for a
   * shared anchor reused across callers.
   */
  parentAttemptId: string | null;
  kind: AttemptKind;
  status: AttemptStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  cancelRequestedAt: string | null;
  failureReason: string | null;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  /** Current fencing token. Non-null once an executor has taken a fenced lease.
   * Every state mutation on a fenced attempt must present this exact token; a
   * superseded (stale) executor is rejected with `fence_stale`. */
  fenceToken: string | null;
  /** Monotonic generation, bumped on every fence acquisition. */
  fenceGeneration: number;
  revision: number;
}

export const ATTEMPT_CONTEXT_SCHEMA_VERSION = 1;

export interface AttemptPermittedCapabilities {
  hasWorkspace: boolean;
  gitCapable: boolean;
  allowedTools: string[];
  contextPolicy: ContextPolicy;
}

/** Explainable requirements used by M34's deterministic model policy. */
export interface ExecutionCapabilityRequirements {
  readOnlyExplanation: boolean;
  repositoryExploration: boolean;
  toolCalling: boolean;
  fileModification: boolean;
  codingComplexity: 'none' | 'low' | 'medium' | 'high';
  contextRequirement: 'small' | 'medium' | 'large';
  vision: boolean;
  validationAndRepair: boolean;
}

export interface ModelSelectionCandidateEvidence {
  provider: string;
  model: string;
  available: boolean;
  capable: boolean;
  costRank: number;
  rejectionReasons: string[];
}

/** Frozen, bounded diagnostic explaining the selected execution model. */
export interface ModelSelectionEvidence {
  requiredCapabilities: ExecutionCapabilityRequirements;
  selectedProvider: string;
  selectedModel: string;
  selectionReason: string;
  suitabilitySummary: string;
  userOverrode: boolean;
  candidates: ModelSelectionCandidateEvidence[];
  /** Same-provider capable candidates ordered from the selected model upward. */
  escalationCandidates: Array<{ provider: string; model: string; reason: string }>;
  /** Frozen USD cap when this attempt explicitly selected OpenRouter. */
  spendCapUsd?: number;
  /**
   * Frozen cloud spend facts for a cloud-pool attempt: the policy in force and what the host knew about the selected
   * model's price when it chose it. Core refuses a cloud-pool call without this, or one the policy forbids.
   */
  cloudSpend?: {
    mode: 'FREE_ONLY' | 'BUDGETED' | 'UNRESTRICTED';
    allowCredits?: boolean;
    modelFreeness: 'free' | 'paid' | 'trial' | 'promotional' | 'unknown';
  };
  /**
   * The operator approved this exact request text for free cloud inference and the selected model is verified
   * free. Only then may Core send the public text: no tools, history, files, memory or task context.
   */
  cloudPublicTextApproved?: boolean;
  /** Frozen routing label for authorization envelopes. */
  routingPolicy?: 'local-only' | 'local-first-cloud-fallback' | 'explicit-openrouter' | 'explicit-orcarouter' | 'explicit-cloud';
  /**
   * True when the selected model was technically viable (no hard
   * incompatibility) but did not clear the task's preferred reliability
   * threshold — selected as the best available candidate under advisory
   * evidence rather than a proven one. Optional/absent on older frozen
   * records. See `TaskModelSelectionResult.belowPreferredConfidence`.
   */
  belowPreferredConfidence?: boolean;
  /** model:test only: the model was forced by the benchmark runner rather than chosen by KKD selection. */
  benchmarkForcedModel?: boolean;
  /** How normal automatic selection would regard the selected model (see TaskModelSelectionResult.normalEligibility). */
  normalEligibility?: 'eligible' | 'below_preference_floor' | 'unknown' | 'hard_incompatible';
  /** The actual reason behind normalEligibility. */
  eligibilityReason?: string;
  /**
   * M50: the concise explanation of how this model was chosen (mode, why, tool protocol, classification
   * source), frozen with the selection so resume and restart read it back instead of routing again.
   * Optional/absent on older frozen records.
   */
  routing?: RoutingDecisionEvidence;
  /**
   * M45: the selected model's context window, frozen at selection so context
   * budgets rebuild byte-identically on resume. Optional/absent on older
   * frozen records and when nothing could resolve it (Core then assumes a
   * conservative default and records that).
   */
  contextWindowTokens?: number;
  /** Where `contextWindowTokens` came from; always present with it. */
  contextWindowSource?: ContextWindowSource;
  /** Explicitly configured output allowance, when the user set one. */
  maxOutputTokens?: number;
}

/** Bounded, read-only repository material selected by the Extension Host and
 * frozen into the Core-owned attempt. The prompt is supplemental inference
 * context; it is never persisted as the user's conversation message. */
export interface RepositoryContextPackage {
  prompt: string;
  /** `complete`: the prompt carries this file's WHOLE content (M53), so Core need not send the model to read it again. */
  selectedFiles: Array<{ path: string; estimatedTokens: number; complete?: boolean }>;
  estimatedTokens: number;
  packageHash?: string;
}

/** Hard limits Core enforces on a frozen repository context package. The
 * extension-side builder budgets below these so a package it produces always
 * validates; they are shared here so the two sides cannot drift apart. */
export const REPOSITORY_CONTEXT_MAX_PROMPT_CHARS = 100_000;
export const REPOSITORY_CONTEXT_MAX_SELECTED_FILES = 24;
export const REPOSITORY_CONTEXT_MAX_ESTIMATED_TOKENS = 65_536;

/** Immutable execution inputs frozen before an attempt can execute. */
export interface AttemptContextRecord {
  id: string;
  /** Stable across retry attempts while each attempt keeps its own immutable row. */
  contextIdentity: string;
  requestId: string;
  attemptId: string;
  resolvedMode: ResolvedMode;
  workspaceRoot: string | null;
  repositoryId: string | null;
  repositoryLocationId: string | null;
  taskInput: string;
  selectedProvider: string;
  selectedModel: string;
  modelSelection?: ModelSelectionEvidence;
  repositoryContext?: RepositoryContextPackage;
  /** Optional retry-only guidance. The immutable original goal remains taskInput. */
  retryGuidance?: string | null;
  /** Frozen at submission time — the exact attachment ids/hashes this attempt
   * may use. Immutable once the context row is written (M36). */
  attachments?: FrozenAttachmentReference[];
  permittedCapabilities: AttemptPermittedCapabilities;
  approvalPolicy: ToolPermissionPolicy;
  schemaVersion: number;
  createdAt: string;
  contextHash: string;
}

export type RuntimeEventDomain = 'conversation' | 'request' | 'attempt' | 'model_invocation' | 'tool_invocation' | 'approval' | 'execution_quality' | 'research' | 'memory' | 'connector' | 'assistant_routine' | 'scout_routine';

export type ExecutionQualityEventType =
  | 'model_selection_decided'
  | 'repository_path_corrected'
  | 'repository_path_blocked'
  | 'loop_detected'
  | 'redundant_exploration_refused'
  | 'exploration_budget_refused'
  | 'exploration_budget_nudge'
  | 'strategy_changed'
  | 'decision_required'
  | 'model_escalated'
  | 'model_routing_fallback'
  | 'validation_failed'
  | 'validation_repair_started'
  | 'validation_repair_completed'
  | 'validation_repair_unavailable'
  | 'validation_repair_exhausted'
  | 'retry_created'
  | 'final_verification_recorded';

export interface ExecutionQualityEvidenceInput {
  eventType: ExecutionQualityEventType;
  metadata: Record<string, unknown>;
}

export interface RuntimeEventRecord {
  sequence: number;
  id: string;
  domain: RuntimeEventDomain;
  entityId: string;
  eventType: string;
  actor: string;
  clientId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
  resultingRevision: number | null;
}

/**
 * Ephemeral live token delta for an in-flight Core-owned model call (M32
 * Priority 1). Unlike `RuntimeEventRecord`, this is NOT persisted or
 * sequenced — it is best-effort live UX; the durable assistant message and
 * `model_invocations` row are the source of truth. A client that misses
 * frames (e.g. across a reconnect) recovers the full text from the appended
 * conversation message instead of replaying this channel.
 */
export interface RuntimeTokenFrame {
  attemptId: string;
  invocationId: string;
  delta: string;
}

export type ModelInvocationStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface ModelInvocationRecord {
  id: string;
  attemptId: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  policyProvider: string | null;
  policyModel: string | null;
  actualProvider: string | null;
  actualModel: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  status: ModelInvocationStatus;
  startedAt: string;
  endedAt: string | null;
  latencyMs: number | null;
  usageMetadata: Record<string, unknown>;
}

export type ToolInvocationStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

export interface ToolInvocationRecord {
  id: string;
  attemptId: string;
  approvalId: string | null;
  toolName: string;
  argsSummary: Record<string, unknown>;
  status: ToolInvocationStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  evidence: Record<string, unknown>;
}

export type ApprovalKind = 'proposal' | 'mutation' | 'delivery';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'superseded';

export interface ApprovalRecord {
  id: string;
  attemptId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
  resolution: 'approved' | 'rejected' | null;
  summary: Record<string, unknown>;
  /** Immutable, proposal-time rendering of the proposed action (today: the
   * bounded `write_file` unified diff generated before the approval existed).
   * Deliberately outside `summary`/`requestedActionDigest` — presentation,
   * never authority — so a restored card can show exactly what was proposed
   * without recomputing a diff against whatever is on disk later. */
  presentation: Record<string, unknown> | null;
  claimOwner: string | null;
  claimExpiresAt: string | null;
  envelopeVersion: number;
  expectedAttemptRevision: number;
  expectedAttemptStatus: AttemptStatus;
  requestedActionDigest: string;
  frozenContextHash: string;
  revision: number;
}

/** M38: the terminal shape of one `POST /v1/capabilities/dispatch` call — see
 * core/domain/capabilityDispatch.ts. A caller never sees anything besides one
 * of these outcomes; there is no partial/local decision to make on top of it. */
export type CapabilityDispatchResult =
  | { outcome: 'executed'; attemptId: string; toolInvocation: ToolInvocationRecord }
  | { outcome: 'approval_required'; attemptId: string; approval: ApprovalRecord }
  | { outcome: 'denied'; attemptId: string; reason: string }
  | { outcome: 'unavailable'; attemptId: string; reason: string }
  | { outcome: 'unknown_tool'; attemptId: string };

/** M38 restart restoration: one restorable capability action (a 'mutation'
 * approval on the correlationId's anchor attempt, joined with its matching
 * tool-invocation evidence if execution has happened). `actionable` is true
 * only while the approval is still `pending` — everything else (approved,
 * rejected, expired, superseded, or an approval whose invocation has already
 * completed/failed/cancelled) is historical and non-actionable. Exposes only
 * the identifiers/fields already present on `ApprovalRecord`/
 * `ToolInvocationRecord` — nothing new is invented. */
export interface CapabilityActionRestoreEntry {
  approvalId: string;
  attemptId: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  actionable: boolean;
  toolName: string;
  arguments: Record<string, unknown>;
  requestedAt: string;
  resolvedAt: string | null;
  resolution: 'approved' | 'rejected' | null;
  expectedAttemptRevision: number;
  expectedAttemptStatus: AttemptStatus;
  requestedActionDigest: string;
  frozenContextHash: string;
  revision: number;
  /** The approval's frozen proposal-time presentation (see `ApprovalRecord`). */
  presentation: Record<string, unknown> | null;
  outcome: 'pending' | 'approved' | 'rejected' | 'succeeded' | 'failed' | 'cancelled';
  invocation: { id: string; status: ToolInvocationStatus; evidence: Record<string, unknown>; exitCode: number | null } | null;
}

export interface CapabilityActionsSnapshot {
  attemptId: string | null;
  actions: CapabilityActionRestoreEntry[];
}

/** M38: one capability-card display entry re-derived independently of
 * execution rehydration — see `listRecentWorkspaceCapabilityActions`
 * (core/domain/capabilityActionHistory.ts). Identical to
 * `CapabilityActionRestoreEntry` (same sanitized fields, same actionable/
 * outcome semantics) plus the two identifiers needed to place it in the
 * right conversation: `correlationId` (the durable Core conversationId the
 * webview's `postCapabilityApprovalCardsFor` keys cards on) and
 * `realAttemptId` (the actual Saath Kar attempt this conversation's capability
 * action belongs to — distinct from `attemptId` above, which remains the
 * capability-dispatch *anchor* attempt's id, never the real attempt's). */
export interface CapabilityActionDisplayEntry extends CapabilityActionRestoreEntry {
  correlationId: string;
  realAttemptId: string;
}

export interface RecentWorkspaceCapabilityActionsSnapshot {
  actions: CapabilityActionDisplayEntry[];
}

/** Jarvis Connector Foundation (Gmail / Google Calendar / WhatsApp / Printer) —
 * see core/domain/connectors.ts. Kept deliberately separate from
 * `CapabilityHealthState`: a connector's truthful state for the Everyday
 * Tools catalog, not the fabric's generic per-call health. */
export type ConnectorId = 'gmail' | 'google_calendar' | 'whatsapp' | 'printer';
export type ConnectorActionTier = 'read' | 'draft' | 'execute';
export type ConnectorState = 'not_configured' | 'connecting' | 'connected' | 'degraded' | 'unavailable';

export interface ConnectorPermissions {
  read: boolean;
  draft: boolean;
  execute: boolean;
}

export interface ConnectorStatus {
  id: ConnectorId;
  label: string;
  state: ConnectorState;
  reason: string | null;
  checkedAt: string;
  permissions: ConnectorPermissions;
}

export interface KarkeDikhaValidationEvidence {
  commands: Array<{ command: string; exitCode: number | null; timedOut: boolean; durationMs: number }>;
  qualityGateStatus: string;
  diffReviewVerdict: 'pass' | 'reject' | 'skipped';
}

export type KarkeDikhaValidationResult =
  | { outcome: 'waiting_for_delivery_approval'; attempt: AttemptRecord; approval: ApprovalRecord }
  | { outcome: 'failed'; attempt: AttemptRecord };

export interface CheckpointRecord {
  id: string;
  attemptId: string;
  kind: string;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export type AttemptRecoveryClassification =
  | 'safely_resumable'
  | 'safely_retryable_from_scratch'
  | 'awaiting_human_approval'
  | 'requires_reconciliation'
  | 'terminal';

/** One activation-time, read-only snapshot for an attempt owned by Core. */
export interface AttemptRehydrationRecord {
  attempt: AttemptRecord;
  request: RequestEnvelopeRecord;
  context: AttemptContextRecord;
  approvals: ApprovalRecord[];
  /** Bounded durable tail scoped only to this attempt and its child records. */
  events: RuntimeEventRecord[];
  recovery: AttemptRecoveryClassification;
}

export interface WorkspaceAttemptRehydration {
  workspaceRoot: string;
  attempts: AttemptRehydrationRecord[];
}

// --- M33: durable task-history projection (additive, read-only) ---

/** Bounded per-approval summary for a history entry — identity and outcome only. */
export interface TaskHistoryApprovalSummary {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  requestedAt: string;
  resolvedAt: string | null;
}

/**
 * One task in the everyday history list: an attempt joined with its immutable
 * request. A pure read projection over existing Core tables — creating,
 * listing, or opening history never mutates any attempt, request, approval,
 * or event state.
 */
export interface TaskHistoryEntry {
  attemptId: string;
  requestId: string;
  predecessorAttemptId: string | null;
  successorAttemptId: string | null;
  kind: AttemptKind;
  status: AttemptStatus;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  currentMessage: string;
  requestedMode: RequestedMode;
  resolvedMode: ResolvedMode;
  routeReason: string;
  conversationId: string | null;
  workspaceRoot: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  modelSelection: ModelSelectionEvidence | null;
  retryGuidance: string | null;
  approvals: TaskHistoryApprovalSummary[];
}

export type AttemptRetryStrategy = 'same_model' | 'stronger_model' | 'with_guidance';

export interface AttemptRetryEligibility {
  eligible: boolean;
  reason: string;
  strongerModelAvailable: boolean;
  prohibitedBySafety: boolean;
}

/** Full timeline for one history entry: durable approvals, checkpoints, and the attempt-scoped runtime-event tail. */
export interface TaskHistoryDetail {
  entry: TaskHistoryEntry;
  approvals: ApprovalRecord[];
  checkpoints: CheckpointRecord[];
  /** Bounded durable tail scoped to this attempt only. */
  events: RuntimeEventRecord[];
}

// ---------------------------------------------------------------------------
// M36 — durable attachments (first vertical slice: one text file + one image).
// See docs/m36-local-chatgpt-research-workbench.md and docs/m36-gap-map.md.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// M36 pass 2 — document extraction and audio transcription evidence.
// Reuses the pass-1 attachment record/storage/restart-restoration machinery
// unchanged: `extraction`/`transcription` are additive, durable projections
// hung off the same AttachmentRecord, so restart restoration (already
// restart-safe for pass 1) covers them automatically with no new code path.
// ---------------------------------------------------------------------------

export type AttachmentKind = 'text' | 'image' | 'document' | 'audio';
export type AttachmentStatus = 'uploading' | 'ready' | 'failed' | 'deleted';

export type AttachmentErrorCode =
  | 'size_exceeded'
  | 'count_exceeded'
  | 'content_length_required'
  | 'content_length_mismatch'
  | 'byte_size_mismatch'
  | 'mime_mismatch'
  | 'unsupported_kind'
  | 'unsupported_content'
  | 'upload_timeout'
  | 'upload_cancelled'
  | 'upload_stream_error'
  | 'hash_mismatch'
  | 'already_finalized'
  | 'not_uploading';

/** One extracted region of a document, in source order. `page` is populated
 * for paginated formats (PDF); `sectionOrdinal` is a stable 0-based index
 * usable for any format (including paragraph-oriented ones like DOCX, where
 * `page` is not meaningful and stays null). `charStart`/`charEnd` are offsets
 * into the section's own `text`'s concatenation-order position within the
 * full extracted document text, giving exact provenance for any excerpt. */
export interface DocumentExtractionSection {
  sectionOrdinal: number;
  page: number | null;
  text: string;
  charStart: number;
  charEnd: number;
}

/** Durable extraction result for a `document`-kind attachment. `engine`
 * records exactly which local extractor produced this (never silently
 * substituted), for provenance and diagnostics. */
export interface DocumentExtractionResult {
  engine: 'pdfjs-dist' | 'mammoth';
  pageCount: number | null;
  sections: DocumentExtractionSection[];
  extractedAt: string;
}

/** One transcribed segment with a timestamp range, in source order. */
export interface AudioTranscriptionSegment {
  segmentOrdinal: number;
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/** Durable transcription result for an `audio`-kind attachment. */
export interface AudioTranscriptionResult {
  engine: string;
  segments: AudioTranscriptionSegment[];
  transcribedAt: string;
}

/** Why local processing (document extraction or audio transcription) could
 * not run for an attachment that needs it — an honest, typed blocker rather
 * than a silently-skipped or fabricated result. Mirrors the existing
 * `RepositoryLocationCapability` enumerated-capability idiom. */
export type LocalProcessingCapability =
  | 'available'
  | 'not_applicable'
  | 'unavailable_no_local_engine'
  | 'unavailable_unsupported_format'
  | 'failed';

/** Durable, privacy-safe attachment metadata. Bytes live under a private
 * Core-owned directory (`storageRelativePath`, Core-data-dir-relative only —
 * never an absolute client path); this record never carries the bytes. */
export interface AttachmentRecord {
  id: string;
  conversationId: string;
  originalName: string;
  declaredMimeType: string;
  detectedMimeType: string | null;
  kind: AttachmentKind;
  byteSize: number;
  sha256: string | null;
  storageRelativePath: string | null;
  status: AttachmentStatus;
  errorCode: AttachmentErrorCode | null;
  errorMessageRedacted: string | null;
  createdAt: string;
  readyAt: string | null;
  deletedAt: string | null;
  revision: number;
  /** Populated only for `kind: 'document'`; null for every other kind, and
   * null for a document until extraction completes. */
  extraction: DocumentExtractionResult | null;
  /** Populated only for `kind: 'audio'`; null for every other kind, and null
   * for audio until transcription completes (or is confirmed unavailable). */
  transcription: AudioTranscriptionResult | null;
  /** 'not_applicable' for text/image; 'available' once extraction/
   * transcription has actually completed; an honest blocker reason
   * otherwise. Set at finalize time and never silently left ambiguous. */
  localProcessingCapability: LocalProcessingCapability;
}

export interface MessageAttachmentLink {
  messageId: string;
  attachmentId: string;
  ordinal: number;
}

/** Frozen into `AttemptContextRecord.attachments` at submission time so a
 * retry/restart can never silently substitute different bytes for the same id. */
export interface FrozenAttachmentReference {
  attachmentId: string;
  sha256: string;
  kind: AttachmentKind;
  detectedMimeType: string;
  originalName: string;
  byteSize: number;
}

export type ArtifactKind = 'image' | 'video' | 'document' | 'file';
export type ArtifactAvailability = 'ready' | 'missing' | 'changed' | 'unreadable';

/** Durable output provenance. The absolute path is available only through
 * authenticated Core APIs to trusted host clients; Desktop projects a safe
 * basename to its renderer. Bytes never enter SQLite. */
export interface ArtifactRecord {
  id: string;
  conversationId: string | null;
  requestId: string | null;
  attemptId: string | null;
  kind: ArtifactKind;
  title: string;
  mimeType: string;
  absolutePath: string;
  byteSize: number;
  sha256: string;
  source: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  availability: ArtifactAvailability;
}

// M36 pass 3 — bounded, Core-owned governed web-research provenance.
export type ResearchState = 'awaiting_approval' | 'denied' | 'running' | 'completed' | 'insufficient_evidence' | 'failed' | 'unavailable';
export type ResearchSourceStatus = 'fetched' | 'failed' | 'rejected';
export type CitationValidationStatus = 'valid' | 'invalid';
export interface ResearchApprovalRecord { id: string; researchId: string; status: 'pending' | 'approved' | 'rejected'; requestedAt: string; resolvedAt: string | null; requestedActionDigest: string; summary: { provider: string; queryPreview: string; maxSources: number }; revision: number; }
export interface ResearchSessionRecord { id: string; conversationId: string; originatingUserMessageId: string; approvalId: string; normalizedQuery: string; provider: string; state: ResearchState; createdAt: string; startedAt: string | null; completedAt: string | null; failureClassification: string | null; }
export interface ResearchSourceRecord { id: string; researchId: string; resultRank: number; normalizedUrl: string; finalUrl: string | null; title: string | null; provider: string; retrievedAt: string | null; httpStatus: number | null; contentType: string | null; extractedTextHash: string | null; rawResponseHash: string | null; extractedText: string | null; status: ResearchSourceStatus; failure: string | null; provenanceVersion: number; }
export interface CitationRecord { id: string; assistantMessageId: string; sourceId: string; visibleLabel: string; evidenceReference: string | null; validationStatus: CitationValidationStatus; }

// M36 workbench completion — these are Core projections over the durable
// conversation/evidence records.  They intentionally contain no prompts,
// approval envelopes, provider credentials, or attachment bytes.
export interface ConversationBranchRecord {
  conversationId: string;
  parentConversationId: string;
  branchPointMessageId: string;
  createdAt: string;
}

export interface ResponseAlternativeRecord {
  id: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  ordinal: number;
  active: boolean;
  createdAt: string;
}

export interface ConversationSearchResult {
  conversationId: string;
  messageId: string | null;
  title: string | null;
  snippet: string;
  matchedKinds: Array<'title' | 'message' | 'attachment' | 'transcript' | 'source'>;
  updatedAt: string;
  branch: ConversationBranchRecord | null;
}

export interface ConversationExport {
  schemaVersion: 1;
  exportedAt: string;
  conversation: ConversationRecord;
  branch: ConversationBranchRecord | null;
  messages: Array<ConversationMessageRecord & { attachments: AttachmentRecord[]; citations: CitationRecord[]; alternatives: ResponseAlternativeRecord[] }>;
  research: Array<{ session: ResearchSessionRecord; sources: ResearchSourceRecord[] }>;
}

export const MAX_ATTACHMENTS_PER_TURN = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// M37 references the existing Core Story and Attempt identities; it does not
// introduce a second board, queue, worker runtime, approval system, or PR system.
export type EngineeringProductRequestStatus = 'draft' | 'approved' | 'rejected';
export type EngineeringSprintState = 'planned' | 'active' | 'completed';
export type EngineeringSprintItemState = 'planned' | 'active' | 'review' | 'done' | 'blocked';
export type EngineeringAssignmentState = 'active' | 'released' | 'stale';
export type EngineeringCiConclusion = 'failure' | 'success' | 'cancelled' | 'action_required';
export interface EngineeringProductRequestRecord { id: string; projectId: string; repositoryId: string | null; title: string; goal: string; acceptanceCriteria: string[]; definitionOfReady: string[]; definitionOfDone: string[]; dependencies: string[]; estimatedPoints: number; status: EngineeringProductRequestStatus; storyId: string | null; approvedAt: string | null; createdAt: string; updatedAt: string; }
export interface EngineeringSprintRecord { id: string; projectId: string; repositoryId: string | null; name: string; goal: string; state: EngineeringSprintState; capacityPoints: number; wipLimit: number; createdAt: string; startedAt: string | null; completedAt: string | null; review: Record<string, unknown> | null; retrospective: Record<string, unknown> | null; }
export interface EngineeringSprintItemRecord { sprintId: string; storyId: string; ordinal: number; estimatedPoints: number; state: EngineeringSprintItemState; }
export interface EngineeringAssignmentRecord { id: string; sprintId: string; storyId: string; attemptId: string | null; workerId: string; leaseToken: string; leaseExpiresAt: string; state: EngineeringAssignmentState; createdAt: string; updatedAt: string; }
export interface EngineeringCiEvidenceRecord { id: string; storyId: string; sourceAttemptId: string | null; repairStoryId: string | null; repairAttemptId: string | null; pullRequestUrl: string; headSha: string; runId: string; conclusion: EngineeringCiConclusion; failureFingerprint: string | null; diagnosis: string | null; regressionTests: string[]; replacementRunId: string | null; replacementHeadSha: string | null; reviewedAt: string | null; mergedAt: string | null; mergedBy: string | null; createdAt: string; updatedAt: string; }

// --- M39: Core-owned memory and knowledge intelligence ---
// Core's SQLite store is the sole durable authority for every type below (see
// docs/m39-memory-knowledge-intelligence.md §4). No second store, no
// embeddings, no external graph engine.
export type MemoryType = 'user' | 'project' | 'task' | 'episodic' | 'semantic' | 'procedural';
export type MemoryScopeType = 'user' | 'project' | 'task' | 'repository' | 'global';
export type MemorySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';
export type MemoryState = 'active' | 'historical' | 'expired' | 'forgotten';
export type MemoryEvidenceSourceType = 'conversation_message' | 'tool_invocation' | 'capability_approval';
export type KnowledgeEntityType =
  | 'user' | 'project' | 'task' | 'decision' | 'repository_file' | 'github_issue' | 'product_record';
export type KnowledgeRelationshipType =
  | 'affects' | 'depends_on' | 'supersedes' | 'implemented_by' | 'contradicts' | 'scoped_to';
export type MemoryContradictionState = 'unresolved' | 'resolved';
export type MemoryResolutionPolicy = 'prefer_earlier' | 'prefer_later' | 'keep_both' | 'scope_split';
/** How a recalled item must be presented. `durable_fact` is the only value
 * that may be shown as evidenced truth. */
export type MemoryRecallKind = 'durable_fact' | 'historical_fact' | 'expired_fact' | 'unresolved_contradiction' | 'inference';

export interface MemoryFactRecord {
  id: string;
  memoryType: MemoryType;
  scopeType: MemoryScopeType;
  scopeId: string;
  subject: string;
  predicate: string;
  normalizedValue: string;
  displayValue: string;
  structuredValue: Record<string, unknown> | null;
  sensitivity: MemorySensitivity;
  state: MemoryState;
  validFrom: string;
  validTo: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  forgottenAt: string | null;
  consentApprovalId: string | null;
  toolInvocationId: string | null;
  revision: number;
  writeIdentity: string;
}

export interface MemoryEvidenceRecord {
  id: string;
  memoryId: string;
  sourceType: MemoryEvidenceSourceType;
  sourceConversationId: string | null;
  sourceMessageId: string | null;
  sourceAttemptId: string | null;
  sourceInvocationId: string | null;
  sourceContentSha256: string;
  provenanceVersion: number;
  createdAt: string;
}

export interface KnowledgeEntityRecord {
  id: string;
  entityType: KnowledgeEntityType;
  canonicalKey: string;
  label: string;
  scopeType: string | null;
  scopeId: string | null;
  state: 'active' | 'retired';
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRelationshipRecord {
  id: string;
  fromEntityId: string;
  relationshipType: KnowledgeRelationshipType;
  toEntityId: string;
  validFrom: string;
  validTo: string | null;
  state: 'active' | 'historical';
  memoryId: string | null;
  evidenceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryContradictionRecord {
  id: string;
  earlierMemoryId: string;
  laterMemoryId: string;
  state: MemoryContradictionState;
  resolutionPolicy: MemoryResolutionPolicy | null;
  authoritativeMemoryId: string | null;
  resolutionApprovalId: string | null;
  resolutionInvocationId: string | null;
  detectedAt: string;
  resolvedAt: string | null;
}

/** One recalled item, always carrying its evidence. A fact whose evidence
 * cannot be resolved from Core is never returned as `durable_fact`. */
export interface MemoryRecallEntry {
  kind: MemoryRecallKind;
  memory: MemoryFactRecord;
  evidence: MemoryEvidenceRecord[];
  contradictions: MemoryContradictionRecord[];
}

export interface MemoryImpactEntry {
  entity: KnowledgeEntityRecord;
  depth: number;
  /** Ordered relationship path from the origin entity to this entity. */
  path: Array<{ fromEntityId: string; relationshipType: KnowledgeRelationshipType; toEntityId: string; relationshipId: string }>;
  /** Evidence ids supporting every relationship on the path. Never empty. */
  evidenceIds: string[];
}

export const MEMORY_PROVENANCE_VERSION = 1;
export const MEMORY_EXPORT_SCHEMA_VERSION = 1;

/* ══════════════════════════════════════════════════════════════════════
 * The Personal Assistant brief (Pandesh).
 *
 * Everything here is a projection of durable Core state or of a live,
 * permission-gated connector read. Each item names the source it came from,
 * the state that source recorded, the timestamp that source wrote, and the
 * actions the operator can actually take. Nothing is invented, and a service
 * that is not connected is reported as not connected — never as empty.
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * How a line in the brief must be read.
 *
 * - `fact` — observed directly from a source (a task, an approval, an event).
 * - `suggestion` — Pandesh's own proposal, clearly marked as advice.
 * - `action_performed` — something that already happened, stated as history.
 */
export type AssistantBriefStance = 'fact' | 'suggestion' | 'action_performed';

export type AssistantBriefItemKind =
  | 'approval'
  | 'task_failed'
  | 'task_interrupted'
  | 'task_running'
  | 'task_completed'
  | 'reminder'
  | 'commitment'
  | 'calendar_event'
  | 'email'
  | 'routine';

export type AssistantBriefSourceKind =
  | 'core_attempt'
  | 'core_approval'
  | 'core_artifact'
  | 'core_reminder'
  | 'core_commitment'
  | 'core_schedule'
  | 'core_conversation'
  | 'connector';

/** Where one line of the brief came from. Never a decoration. */
export interface AssistantBriefSource {
  kind: AssistantBriefSourceKind;
  /** Human label of the source, e.g. "KarkeDikha task" or "Google Calendar". */
  label: string;
  /** The source's own identifier, when it has one. */
  reference: string | null;
  /** When this source was read, ISO-8601. */
  checkedAt: string;
}

export type AssistantBriefActionKind =
  | 'resolve_approval'
  | 'open_conversation'
  | 'stop_task'
  | 'resume_task'
  | 'open_artifact'
  | 'refresh_brief';

/** One thing the operator can actually do about a brief item. */
export interface AssistantBriefAction {
  kind: AssistantBriefActionKind;
  label: string;
  approvalId?: string;
  attemptId?: string;
  conversationId?: string;
  artifactId?: string;
}

export interface AssistantBriefItem {
  id: string;
  kind: AssistantBriefItemKind;
  stance: AssistantBriefStance;
  title: string;
  detail: string;
  /** The state the source recorded, in the source's own words. */
  state: string;
  /** The timestamp the source wrote, ISO-8601. */
  at: string;
  source: AssistantBriefSource;
  actions: AssistantBriefAction[];
}

/** One themed part of the Today briefing. */
export interface AssistantBriefSection {
  id: string;
  label: string;
  /**
   * False when the section's source is genuinely unavailable. The section then
   * says why — it never pretends the source was read and found empty.
   */
  available: boolean;
  unavailableReason: string | null;
  items: AssistantBriefItem[];
}

/** Live truth about one integration, straight from the connector registry. */
export interface AssistantBriefService {
  id: ConnectorId;
  label: string;
  state: ConnectorState;
  reason: string | null;
  checkedAt: string;
}

export interface AssistantBrief {
  /** When this brief was assembled, ISO-8601. */
  generatedAt: string;
  timezone: string;
  /** At most three items that need attention or show meaningful progress. */
  home: AssistantBriefItem[];
  /** The Today briefing, in reading order. */
  today: AssistantBriefSection[];
  /** Every integration's real state — connected or not. */
  services: AssistantBriefService[];
}

/** The user-configured daily routine, stored in Core's durable schedule. */
export interface DailyBriefRoutine {
  id: string;
  enabled: boolean;
  /** Wall-clock time of day the brief runs, "HH:MM". */
  dailyTime: string;
  timezone: string;
  /** The next occurrence, ISO-8601. Null when the routine is disabled. */
  nextRunAt: string | null;
  /** The last occurrence that was actually delivered, ISO-8601. */
  lastRunAt: string | null;
  /** The conversation the delivered briefs live in, so they stay discoverable. */
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}
