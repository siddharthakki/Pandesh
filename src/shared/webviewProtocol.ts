/**
 * Shared webview <-> extension-host protocol.
 *
 * This is the single typed source of truth for the message contract between
 * `src/ui/AgentPanel.ts` (the extension host) and BOTH webview UIs (legacy
 * `media/*.js` and `src/webview-v2/*`). It documents the REAL, currently
 * implemented contract — verified against AgentPanel.ts's `handleWebviewMessage`
 * switch and its `this.post(...)` call sites — not an aspirational one.
 *
 * Scope note: this module is a protocol-boundary hardening layer only. It does
 * not change AgentPanel's business logic, and it does not yet model every
 * field of every message (some payloads carry deep, evolving shapes — e.g.
 * `autonomousTaskStatus` — where only the fields consumers actually rely on
 * are typed and the rest is captured as an open record). Extend a message's
 * shape here as its real fields become load-bearing for a test or a consumer.
 *
 * Reuses `AgentMode` from `src/config/ConfigSchema.ts` (the canonical type the
 * live `sendMessage` -> `coreKindFor` routing path actually consumes) rather
 * than redefining it. Note `AgentMode` has NO `'autonomous'` member — Karke
 * Dikha is not a `sendMessage` mode at all, it is a distinct message type
 * (`startAutonomousTask`) with no `mode` field of its own. `UiMode` below is
 * the superset used only where a UI needs to represent all five buttons.
 */
import type { AgentMode } from '../config/ConfigSchema';

export type { AgentMode };

/** The five UI mode buttons (Baat Kar / Ask / Plan / Saath Kar / Karke Dikha).
 * Only used for UI-side mode selection state; the wire `sendMessage.mode`
 * field is `AgentMode` (no `'autonomous'`) because Karke Dikha submissions use
 * `startAutonomousTask` instead. */
export type UiMode = AgentMode | 'autonomous';

// ---------------------------------------------------------------------------
// Exhaustiveness helper
// ---------------------------------------------------------------------------

/**
 * Use in the `default` branch of a switch over a closed union when an
 * unhandled variant reaching that branch is a genuine invariant violation
 * (the value's static type is provably `never`, so this can only run for
 * pure protocol drift — a real message value never reaches it). Throws.
 *
 * For a runtime message boundary (a raw `postMessage` payload cast to a
 * union type, where the actual runtime value may not match any known
 * variant — malformed data, a stale/newer host build), prefer
 * `checkExhaustive` instead: same compile-time drift protection, but does
 * NOT throw on unrecognized runtime input, because a webview must stay
 * usable in the face of a message it doesn't understand.
 */
export function assertNever(value: never, context?: string): never {
  throw new Error(
    `Unhandled protocol variant${context ? ` in ${context}` : ''}: ${JSON.stringify(value)}`,
  );
}

/**
 * Compile-time-only exhaustiveness check for a runtime message switch: if a
 * new variant is added to the union and a case isn't added for it, `value`
 * is not assignable to `never` here and the build fails. Unlike
 * `assertNever`, this never throws — genuinely unrecognized runtime input
 * (not a value TypeScript can prove is impossible) is silently ignored,
 * which is the correct behavior at a webview's message boundary.
 */
export function checkExhaustive(_value: never): void {
  // no-op by design — see doc comment above.
}

// ---------------------------------------------------------------------------
// WebviewToHost — inbound messages AgentPanel.handleWebviewMessage handles
// ---------------------------------------------------------------------------

export interface WebviewReadyMessage { type: 'webviewReady'; mode: UiMode }
export interface WebviewModeChangedMessage { type: 'webviewModeChanged'; mode: UiMode }
export interface GetModelsMessage { type: 'getModels' }
export interface GetOperationsSnapshotMessage { type: 'getOperationsSnapshot' }
export interface GetRepositoryIntelligenceStatusMessage { type: 'getRepositoryIntelligenceStatus' }
export interface RebuildRepositoryIntelligenceMessage { type: 'rebuildRepositoryIntelligence' }
export interface PauseRepositoryIntelligenceMessage { type: 'pauseRepositoryIntelligence' }
export interface ResumeRepositoryIntelligenceMessage { type: 'resumeRepositoryIntelligence' }
export interface ListLocalModelsMessage { type: 'listLocalModels'; text?: string; conversationId?: string }

/** The Baat Kar / Ask / Plan / Saath Kar submission funnel. `mode` selects the
 * Core kind via `AgentPanel.coreKindFor`: `'chat' -> 'baat_kar'`, everything
 * else (`'ask' | 'plan' | 'agent'`) -> `'saath_kar'`. Ask and Plan are NOT
 * distinct Core routes today — see HANDOFF notes / golden journey report. */
export interface SendMessageMessage {
  type: 'sendMessage';
  text: string;
  mode: AgentMode;
  model?: string;
  attachmentIds?: string[];
  conversationId?: string;
}

export interface ResearchApprovalResponseMessage {
  type: 'researchApprovalResponse';
  researchId: string;
  approvalId: string;
  approved: boolean;
}
export interface SelectPermissionProfileMessage { type: 'selectPermissionProfile'; profileId: string }
export interface StopGenerationMessage { type: 'stopGeneration' }
export interface NewConversationMessage { type: 'newConversation' }
export interface DismissContinuityNoticeMessage { type: 'dismissContinuityNotice' }
export interface SelectConversationMessage { type: 'selectConversation'; id: string }
export interface DeleteConversationMessage { type: 'deleteConversation'; id: string }
export interface SearchWorkbenchMessage { type: 'searchWorkbench'; query: string }
export interface OpenWorkbenchSearchResultMessage { type: 'openWorkbenchSearchResult'; conversationId: string }
export interface BranchFromMessageMessage { type: 'branchFromMessage'; messageId: string }
export interface RegenerateMessageMessage { type: 'regenerateMessage'; messageId: string }
export interface SelectResponseAlternativeMessage { type: 'selectResponseAlternative'; alternativeId: string }
export interface ExportConversationMessage { type: 'exportConversation'; format?: string }
export interface PickAttachmentMessage { type: 'pickAttachment'; conversationId: string }
export interface OpenWorkspaceMessage { type: 'openWorkspace' }
export interface CreateWorkspaceMessage { type: 'createWorkspace' }
export interface CreateLocalStoryMessage { type: 'createLocalStory'; message: string }
export interface OpenLocalBoardMessage { type: 'openLocalBoard' }
export interface OpenExternalSourceMessage { type: 'openExternalSource'; url: string }

/** The generic AgentRuntime-level approval gate (pre-M15, still used for
 * file-mutation approvals outside Karke Dikha). Distinct from the M15
 * proposal/mutation/delivery/capability approval families below. */
export interface ApprovalResponseMessage { type: 'approvalResponse'; id: string; response: 'approved' | 'rejected' }
export interface CapabilityApprovalRestoredResponseMessage {
  type: 'capabilityApprovalRestoredResponse';
  approvalId: string;
  outcome: 'approved' | 'rejected';
}
export interface ResumeTaskMessage { type: 'resumeTask'; taskId: string }
export interface PauseTaskMessage { type: 'pauseTask'; taskId: string }
export interface CancelTaskMessage { type: 'cancelTask'; taskId: string }
export interface SteerTaskMessage { type: 'steerTask'; taskId: string; message: string; messageId?: string }
export interface GetTaskSnapshotMessage { type: 'getTaskSnapshot'; taskId: string }
export interface RetryTaskMessage { type: 'retryTask'; taskId: string }
export interface ArchiveOldTasksMessage { type: 'archiveOldTasks' }
export interface GetArchivedTasksSnapshotMessage { type: 'getArchivedTasksSnapshot' }
export interface GetAutonomousComposerContextMessage { type: 'getAutonomousComposerContext' }

/** The Karke Dikha submission funnel — structurally separate from
 * `sendMessage`: carries no `mode` field at all (mode is implied by message
 * type), and is routed to `AgentPanel.startAutonomousTask` -> the M15
 * `DurableTaskQueue`/`AutonomousTaskRuntime` worker, never `sendToAgent`. */
export interface StartAutonomousTaskMessage {
  type: 'startAutonomousTask';
  text: string;
  model?: string;
  submissionId?: string;
  autonomyMode?: 'hands_off';
}
export interface RetryBlockedAttemptMessage {
  type: 'retryBlockedAttempt';
  attemptId: string;
  strategy?: string;
  guidance?: string;
}
export interface OpenAutonomousWorktreeMessage { type: 'openAutonomousWorktree'; taskId: string }
export interface ReviewAutonomousChangesMessage { type: 'reviewAutonomousChanges'; taskId: string }
export interface ApproveAutonomousDeliveryMessage { type: 'approveAutonomousDelivery'; taskId: string }
export interface RejectAutonomousDeliveryMessage { type: 'rejectAutonomousDelivery'; taskId: string }
export interface CopyAutonomousDiagnosticsMessage { type: 'copyAutonomousDiagnostics'; taskId: string }
export interface ApproveProposalMessage { type: 'approveProposal'; taskId: string; proposalId: string }
export interface RejectProposalMessage { type: 'rejectProposal'; taskId: string; proposalId: string }
export interface RequestProposalRevisionMessage {
  type: 'requestProposalRevision';
  taskId: string;
  proposalId: string;
  instructions: string;
}
export interface ApproveMutationMessage { type: 'approveMutation'; taskId: string; requestId: string }
export interface DenyMutationMessage { type: 'denyMutation'; taskId: string; requestId: string }
export interface GetEverydayHistoryMessage { type: 'getEverydayHistory' }
export interface GetEverydayHistoryDetailMessage { type: 'getEverydayHistoryDetail'; attemptId: string }
export interface EverydayModeDecisionMessage { type: 'everydayModeDecision'; [key: string]: unknown }
export interface CopyAutonomousPromptDraftMessage { type: 'copyAutonomousPromptDraft'; text: string }

export type WebviewToHostMessage =
  | WebviewReadyMessage
  | WebviewModeChangedMessage
  | GetModelsMessage
  | GetOperationsSnapshotMessage
  | GetRepositoryIntelligenceStatusMessage
  | RebuildRepositoryIntelligenceMessage
  | PauseRepositoryIntelligenceMessage
  | ResumeRepositoryIntelligenceMessage
  | ListLocalModelsMessage
  | SendMessageMessage
  | ResearchApprovalResponseMessage
  | SelectPermissionProfileMessage
  | StopGenerationMessage
  | NewConversationMessage
  | DismissContinuityNoticeMessage
  | SelectConversationMessage
  | DeleteConversationMessage
  | SearchWorkbenchMessage
  | OpenWorkbenchSearchResultMessage
  | BranchFromMessageMessage
  | RegenerateMessageMessage
  | SelectResponseAlternativeMessage
  | ExportConversationMessage
  | PickAttachmentMessage
  | OpenWorkspaceMessage
  | CreateWorkspaceMessage
  | CreateLocalStoryMessage
  | OpenLocalBoardMessage
  | OpenExternalSourceMessage
  | ApprovalResponseMessage
  | CapabilityApprovalRestoredResponseMessage
  | ResumeTaskMessage
  | PauseTaskMessage
  | CancelTaskMessage
  | SteerTaskMessage
  | GetTaskSnapshotMessage
  | RetryTaskMessage
  | ArchiveOldTasksMessage
  | GetArchivedTasksSnapshotMessage
  | GetAutonomousComposerContextMessage
  | StartAutonomousTaskMessage
  | RetryBlockedAttemptMessage
  | OpenAutonomousWorktreeMessage
  | ReviewAutonomousChangesMessage
  | ApproveAutonomousDeliveryMessage
  | RejectAutonomousDeliveryMessage
  | CopyAutonomousDiagnosticsMessage
  | ApproveProposalMessage
  | RejectProposalMessage
  | RequestProposalRevisionMessage
  | ApproveMutationMessage
  | DenyMutationMessage
  | GetEverydayHistoryMessage
  | GetEverydayHistoryDetailMessage
  | EverydayModeDecisionMessage
  | CopyAutonomousPromptDraftMessage;

// ---------------------------------------------------------------------------
// HostToWebview — outbound messages via AgentPanel's `post`/`postApprovalCardMessage`
// ---------------------------------------------------------------------------

export interface TokenMessage { type: 'token'; delta: string }
export interface DoneMessage { type: 'done'; content: string; messageId?: string; alternatives?: unknown }
export interface ErrorMessage { type: 'error'; message: string }
export interface StoppedMessage { type: 'stopped' }
/** Legacy narrow event — only the `ollama.listModels` tool path, NOT the
 * general Baat Kar completion contract (that is `done`). */
export interface AssistantContentMessage { type: 'assistantContent'; content: string }

export interface ReadinessStateMessage {
  type: 'readinessState';
  executionRunning: boolean;
  coreReady: boolean;
  coreStatus?: unknown;
  workspaceContextReady: boolean;
  historyReady: boolean;
}
export interface WorkspaceRestorationPendingMessage { type: 'workspaceRestorationPending' }
export interface WorkspaceRestorationResolvedMessage { type: 'workspaceRestorationResolved'; workspaceIdentity: string }
export interface WorkspaceStateMessage { type: 'workspaceState'; available: boolean; name?: string }
export interface WorkspaceRequiredMessage {
  type: 'workspaceRequired';
  text: string;
  mode: AgentMode;
  conversationId?: string;
  message: string;
}

export interface NewConversationOutMessage { type: 'newConversation'; id: string }
export interface ConversationContinuityMessage {
  type: 'conversationContinuity';
  cue: unknown;
  objective?: unknown;
  previousMode?: UiMode;
  repositoryChanged?: boolean;
  resumptionState?: string;
  reset?: boolean;
}
export interface ConversationSelectedMessage { type: 'conversationSelected'; id: string }
export interface ConversationSummary { id: string; title: string | null; model?: string; messages?: unknown[]; createdAt: number | string; updatedAt: number | string }
export interface ConversationCreatedMessage { type: 'conversationCreated'; conversation: ConversationSummary }
export interface ConversationUpdatedMessage { type: 'conversationUpdated'; conversation: ConversationSummary }
export interface ConversationDeletedMessage { type: 'conversationDeleted'; id: string }
export interface ConversationBranchedMessage { type: 'conversationBranched'; id: string; parentConversationId: string }
export interface PersistedConversationsLoadedMessage { type: 'persistedConversationsLoaded'; conversations: ConversationSummary[] }
export interface RestoreTranscriptMessage {
  type: 'restoreTranscript';
  conversationId: string;
  replaceExisting: boolean;
  messages: unknown[];
  branch?: unknown;
}
export interface WorkspaceRequestResumedMessage { type: 'workspaceRequestResumed'; text: string; conversationId?: string; mode?: AgentMode }

export interface ModelSuitabilityMessage {
  type: 'modelSuitability';
  summary: string;
  details: { selectedProvider?: string; selectedModel?: string; suitabilitySummary?: string; [key: string]: unknown };
}
export interface RepositoryContextEvidenceMessage { type: 'repositoryContextEvidence'; available: boolean; message?: string; [key: string]: unknown }
export interface ToolStartMessage { type: 'toolStart'; toolName: string; args?: Record<string, unknown> }
export interface ToolResultMessage { type: 'toolResult'; toolName: string; ok: boolean; result?: unknown; error?: unknown; blocked?: unknown }

export interface ApprovalRequestMessage { type: 'approvalRequest'; id: string; toolName: string; args: unknown; reason?: string; riskLevel?: string }
export interface AuthorizationDeniedMessage { type: 'authorizationDenied'; denial: string; message: string }
export interface ResearchApprovalRequestMessage {
  type: 'researchApprovalRequest';
  researchId: string;
  approvalId: string;
  requestedActionDigest: string;
  provider: string;
  queryPreview: string;
}
export interface ResearchProgressMessage { type: 'researchProgress'; [key: string]: unknown }
export interface ResearchDeniedMessage { type: 'researchDenied'; [key: string]: unknown }
export interface ResearchCompletedMessage { type: 'researchCompleted'; [key: string]: unknown }

export interface RestoreCapabilityApprovalCardMessage {
  type: 'restoreCapabilityApprovalCard';
  approvalId: string;
  attemptId: string;
  toolName: string;
  description?: string;
  expectedAttemptRevision: number;
  expectedAttemptStatus: string;
  requestedActionDigest: string;
  frozenContextHash: string;
  presentation?: unknown;
  resolved: boolean;
  outcome?: 'approved' | 'rejected';
}
export interface CapabilityApprovalRestoredResolvedMessage { type: 'capabilityApprovalRestoredResolved'; approvalId: string; outcome: 'approved' | 'rejected' }

export interface ProposalApprovalRequestMessage {
  type: 'proposalApprovalRequest';
  taskId: string;
  attemptId: string;
  proposalId: string;
  version?: number;
  taskSummary?: string;
  operations: unknown[];
  validationCommands?: unknown[];
  warnings?: unknown[];
}
/** Real field is `decision` (e.g. 'approved' | 'rejected' | 'revision_requested' | 'stale'),
 * not `outcome` — verified against AgentPanel.ts's `approveProposal`/`rejectProposal`/
 * `requestProposalRevision`/`rehydrateResolvedApprovalCards` call sites. */
export interface ProposalApprovalResolvedMessage { type: 'proposalApprovalResolved'; taskId: string; proposalId: string; decision: string; message?: string }
export interface MutationApprovalRequestMessage {
  type: 'mutationApprovalRequest';
  taskId: string;
  attemptId: string;
  requestId: string;
  proposalId?: string;
  operationCount: number;
  targets: string[];
  elevatedConfirmationRequired?: boolean;
  repairPolicy?: unknown;
}
/** Real field is `decision`, not `outcome` — see ProposalApprovalResolvedMessage's doc comment. */
export interface MutationApprovalResolvedMessage { type: 'mutationApprovalResolved'; taskId: string; requestId: string; decision: string; message?: string }
export interface DeliveryApprovalRequestMessage { type: 'deliveryApprovalRequest'; gate: 'delivery'; taskId: string; attemptId: string }
/** Real field is `decision`, not `outcome` — see ProposalApprovalResolvedMessage's doc comment. */
export interface DeliveryApprovalResolvedMessage { type: 'deliveryApprovalResolved'; taskId: string; decision: string; message?: string }

export interface AutonomousTaskActiveMessage { type: 'autonomousTaskActive'; taskId: string; [key: string]: unknown }
export interface AutonomousTaskStartedMessage {
  type: 'autonomousTaskStarted';
  taskId: string;
  attemptId: string;
  submissionId?: string;
  state: string;
  goal: string;
  autonomyMode?: string;
}
export interface AutonomousTaskStatusMessage { type: 'autonomousTaskStatus'; taskId: string; state: string; [key: string]: unknown }
/** Saath Kar's evidence-backed result for a finished turn (the same TaskResult Karke Dikha carries on its status). */
export interface TaskResultMessage { type: 'taskResult'; taskId: string; taskResult: unknown; /** Re-derived on History reopen/restart: render only. */ historical?: boolean; afterMessageId?: string }
export interface AutonomousTaskRepositorySnapshotMessage { type: 'autonomousTaskRepositorySnapshot'; taskId: string; [key: string]: unknown }
export interface AutonomousTaskRejectedMessage { type: 'autonomousTaskRejected'; reason: string; submissionId?: string }
export interface AutonomousRetryStartedMessage { type: 'autonomousRetryStarted'; taskId: string; [key: string]: unknown }
export interface AutonomousDiagnosticsCopiedMessage { type: 'autonomousDiagnosticsCopied'; taskId: string }
export interface CoreAttemptRecoveryRequiredMessage { type: 'coreAttemptRecoveryRequired'; [key: string]: unknown }
export interface CoreExecutionRestoredMessage { type: 'coreExecutionRestored'; [key: string]: unknown }

export interface EverydayHistoryMessage { type: 'everydayHistory'; [key: string]: unknown }
export interface EverydayHistoryDetailMessage { type: 'everydayHistoryDetail'; [key: string]: unknown }
export interface TaskSnapshotMessage { type: 'taskSnapshot'; taskId: string; [key: string]: unknown }
export interface TaskResumedMessage { type: 'taskResumed'; taskId: string }
export interface TaskPausedMessage { type: 'taskPaused'; taskId: string }
export interface TaskCancelledMessage { type: 'taskCancelled'; taskId: string }
export interface TaskSteeredMessage { type: 'taskSteered'; taskId: string; [key: string]: unknown }
export interface TaskSteerRejectedMessage { type: 'taskSteerRejected'; taskId: string; messageId?: string; reason: string }
export interface OperationsSnapshotMessage { type: 'operationsSnapshot'; [key: string]: unknown }
export interface ArchivedTasksSnapshotMessage { type: 'archivedTasksSnapshot'; [key: string]: unknown }
export interface TasksArchivedMessage { type: 'tasksArchived'; [key: string]: unknown }
export interface RepositoryIntelligenceStatusMessage { type: 'repositoryIntelligenceStatus'; status: unknown }
export interface AttachmentStateMessage { type: 'attachmentState'; [key: string]: unknown }
export interface WorkbenchSearchResultsMessage { type: 'workbenchSearchResults'; [key: string]: unknown }
export interface RegenerationStartedMessage { type: 'regenerationStarted'; [key: string]: unknown }
export interface ConversationExportedMessage { type: 'conversationExported'; [key: string]: unknown }
export interface LocalStoryCreatedMessage { type: 'localStoryCreated'; [key: string]: unknown }
export interface ModelsLoadedMessage {
  type: 'modelsLoaded';
  models: unknown[];
  selectedModel?: string;
  selectedModelAvailable?: boolean;
  /** True when `selectedModel` was chosen by Auto discovery (no setting named it), not read from an explicit user setting. */
  autoSelected?: boolean;
  /** True when no installed model could serve any role at all — distinct from a specific configured model being unavailable. */
  noUsableModels?: boolean;
  provider?: string;
}
export interface PermissionContextStateMessage { type: 'permissionContextState'; [key: string]: unknown }
export interface ShowActivityMessage { type: 'showActivity' }
export interface ClearMessage { type: 'clear'; conversationId?: string }
export interface AutonomousComposerContextMessage { type: 'autonomousComposerContext'; [key: string]: unknown }

export type HostToWebviewMessage =
  | TokenMessage
  | DoneMessage
  | ErrorMessage
  | StoppedMessage
  | AssistantContentMessage
  | ReadinessStateMessage
  | WorkspaceRestorationPendingMessage
  | WorkspaceRestorationResolvedMessage
  | WorkspaceStateMessage
  | WorkspaceRequiredMessage
  | NewConversationOutMessage
  | ConversationContinuityMessage
  | ConversationSelectedMessage
  | ConversationCreatedMessage
  | ConversationUpdatedMessage
  | ConversationDeletedMessage
  | ConversationBranchedMessage
  | PersistedConversationsLoadedMessage
  | RestoreTranscriptMessage
  | WorkspaceRequestResumedMessage
  | ModelSuitabilityMessage
  | RepositoryContextEvidenceMessage
  | ToolStartMessage
  | ToolResultMessage
  | ApprovalRequestMessage
  | AuthorizationDeniedMessage
  | ResearchApprovalRequestMessage
  | ResearchProgressMessage
  | ResearchDeniedMessage
  | ResearchCompletedMessage
  | RestoreCapabilityApprovalCardMessage
  | CapabilityApprovalRestoredResolvedMessage
  | ProposalApprovalRequestMessage
  | ProposalApprovalResolvedMessage
  | MutationApprovalRequestMessage
  | MutationApprovalResolvedMessage
  | DeliveryApprovalRequestMessage
  | DeliveryApprovalResolvedMessage
  | AutonomousTaskActiveMessage
  | AutonomousTaskStartedMessage
  | AutonomousTaskStatusMessage
  | TaskResultMessage
  | AutonomousTaskRepositorySnapshotMessage
  | AutonomousTaskRejectedMessage
  | AutonomousRetryStartedMessage
  | AutonomousDiagnosticsCopiedMessage
  | CoreAttemptRecoveryRequiredMessage
  | CoreExecutionRestoredMessage
  | EverydayHistoryMessage
  | EverydayHistoryDetailMessage
  | TaskSnapshotMessage
  | TaskResumedMessage
  | TaskPausedMessage
  | TaskCancelledMessage
  | TaskSteeredMessage
  | TaskSteerRejectedMessage
  | OperationsSnapshotMessage
  | ArchivedTasksSnapshotMessage
  | TasksArchivedMessage
  | RepositoryIntelligenceStatusMessage
  | AttachmentStateMessage
  | WorkbenchSearchResultsMessage
  | RegenerationStartedMessage
  | ConversationExportedMessage
  | LocalStoryCreatedMessage
  | ModelsLoadedMessage
  | PermissionContextStateMessage
  | ShowActivityMessage
  | ClearMessage
  | AutonomousComposerContextMessage;

/** Narrow, structural runtime check that a raw postMessage payload at least
 * has a string `type` — the same bar AgentPanel.handleWebviewMessage itself
 * applies before switching on it. Does not validate the full shape; callers
 * still narrow by `type` via the discriminated unions above. */
export function hasMessageType(value: unknown): value is { type: string } {
  return !!value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string';
}
