/**
 * The only way the v2 renderer reaches Pandesh: the existing preload bridge
 * (`window.desktop`, apps/desktop/src/preload.ts). No network access. Types are
 * the subset of apps/desktop/src/ipc.ts the v2 surfaces read.
 */
import { useEffect, useRef, useState } from 'react';
import type { PermissionMode, PermissionState } from './composerModel';
import type { GmailStatus } from './googleModel';
import type { FolderCheck, FolderMention, RecentWorkspace, WorkspaceAccess, WorkspaceView } from './folderModel';
import type { WorkshopCommand, WorkshopSummary } from '../../../../core/shared/workshop/model';
import type { Scene3D } from '../../../../core/shared/workshop/scene3d';
import type { SimulationSpec } from '../../../../core/shared/workshop/simulation';
import type { VideoRecipe } from '../../../../core/shared/workshop/video';

export type { WorkshopSummary, WorkshopCommand };
/** One workshop version's content, verified and re-validated by the host before the window sees it. */
export type WorkshopContent =
  | { type: '3d'; artifactId: string; scene: Scene3D }
  | { type: 'image'; artifactId: string; dataUrl: string }
  | { type: 'video'; artifactId: string; fileUrl: string; recipe: VideoRecipe | null }
  | { type: 'design'; artifactId: string; html: string }
  | { type: 'simulation'; artifactId: string; spec: SimulationSpec };
export type WorkshopCommandEvent = WorkshopCommand & { conversationId: string | null };

export type ApprovalResolution = 'approved' | 'rejected';

export interface ApprovalCard { approvalId: string; gate: string; toolName: string; scope: string; paths: string[]; detail: string }

export interface ArtifactView { id: string; conversationId: string | null; kind: 'image' | 'video' | 'document' | 'file'; title: string; mimeType: string; fileName: string; byteSize: number; source: string; createdAt: string; availability: 'ready' | 'missing' | 'changed' | 'unreadable' }
export interface ToolPreview { kind: string; title?: string; url?: string; path?: string; artifactIds?: string[]; excerpt?: string; diff?: string; command?: string; exitCode?: number | null; timedOut?: boolean; durationMs?: number; tests?: { passed?: number; failed?: number; skipped?: number; total?: number; line: string } }
export interface WorkspaceActivity { id: string; conversationId: string | null; taskId: string | null; capability?: string; kind?: string; title?: string; state: 'running' | 'completed' | 'failed' | 'cancelled'; startedAt?: string; endedAt?: string | null; detail?: string | null; preview?: ToolPreview | null; [k: string]: unknown }

export interface Snapshot {
  coreState: string;
  coreDetail?: string;
  model: string | null;
  modelIsAuto: boolean;
  modelServerReachable?: boolean | null;
  provider: string;
  selectedInferenceProvider: string;
  attemptId: string | null;
  running: boolean;
  awaitingApproval: boolean;
  pendingApproval: ApprovalCard | null;
  pendingImageApproval?: { approvalId: string; presentation: Record<string, unknown> | null; request?: { prompt: string } } | null;
  pendingWeatherApproval?: { approvalId: string; presentation: Record<string, unknown> | null } | null;
  workspaceActivities: WorkspaceActivity[];
  lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null;
  turnOutcomeKind: string | null;
  blockedReason: string | null;
  selectedConversationId: string | null;
  selectedAgentId?: string | null;
  activeConversationId: string | null;
  contextEnvelope?: number | null;
  speaking: boolean;
  voiceMode: boolean;
  localSpeech?: { state?: string; ready?: boolean; detail?: string; [k: string]: unknown };
  /** Installed Ollama model names for the model menu. */
  installedModels?: string[];
  /** Free cloud providers (off by default); `selectedModel` is `<provider>::<model>`. */
  cloud?: {
    selectedModel?: string | null;
    providers?: Array<{ id: string; displayName?: string; enabled?: boolean; configured?: boolean }>;
    listings?: Record<string, { pool?: Array<{ id: string; displayName?: string }> }>;
    [k: string]: unknown;
  } | null;
  /** The selected workspace folder, if any (Auto's workspace categories are bound to it). */
  folder?: string | null;
  /** The workspace folder with what Pandesh may do there (read only, or read and write). */
  workspace?: WorkspaceView | null;
  /** Folders used before, newest first, with the access last chosen for each. */
  recentWorkspaces?: RecentWorkspace[];
  /** Ask / Auto / Plan only for the selected conversation (or the next new one). Core stores and enforces it. */
  permission?: PermissionState;
  /** Google (Gmail, Calendar) connection status, non-secret. */
  gmail?: GmailStatus;
  /** Everyday Tools catalog: Calendar counts as connected only when Core verified it with a live read. */
  everydayTools?: EverydayTools;
  modelNote?: string | null;
  /** openWakeWord readiness and the enable / mute preference (the host detects; the page feeds it microphone frames). */
  wakeWord?: WakeWordStatus;
  /** What the host's detector has received (frames, warm-up, capture errors). */
  wakeDiagnostics?: WakeDiagnostics;
  speechInterrupt?: { buttonStop?: boolean; spokenBargeIn?: boolean; spokenBargeInBlocker?: string };
  /** Files staged by the host for the next message (never a path). */
  stagedAttachments?: StagedAttachment[];
  /** The command queue: waiting, confirming, active and recently finished queued instructions. */
  commandQueue?: CommandQueue;
  hostTelemetry?: HostTelemetry | null;
  routingPolicy?: string;
}

export interface WakeWordStatus { capability: string; engine?: string | null; blocker?: string; phrase?: string; enabled: boolean; muted: boolean }
export interface WakeDiagnostics { engineReady?: boolean; captureActive?: boolean; captureError?: string; framesReceived?: number; readyForDetect?: boolean; [k: string]: unknown }
export interface WakeCaptureMeta { captureActive?: boolean; captureError?: string; rms?: number; sampleRate?: number; contextSampleRate?: number; framesEmitted?: number; trackLabel?: string }
/** Host voice events: wake_detected, wake_state, wake_score, speaking, speak_stopped, speak_finished, speak_failed. */
export interface VoiceEvent { kind: string; score?: number; wakeDetectMs?: number | null; inferenceMs?: number; framesReceived?: number; enabled?: boolean; muted?: boolean; [k: string]: unknown }

export type AttachmentKind = 'text' | 'image' | 'document' | 'audio';
export interface StagedAttachment { id: string; name: string; byteSize: number; kind: AttachmentKind; mimeType: string }
export interface TranscriptMessage {
  id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; model?: string | null; provider?: string | null;
  /** Files sent with this message. */
  attachments?: Array<{ id: string; name: string; kind: AttachmentKind; byteSize: number }>;
}
export interface ConversationEntry { id: string; title: string | null; preview: string | null; state: string; updatedAt: string; archivedAt: string | null; pinnedAt: string | null; repositoryName?: string | null; createdAt?: string }
export interface ConversationSearchResult { conversationId: string; messageId: string | null; title: string | null; snippet: string; matchedKinds: string[]; updatedAt: string }
/** What Core keeps about a conversation (bounded; no credentials, prompts or raw tool output). */
export interface ConversationContext {
  state: 'available' | 'not_recorded' | 'no_workspace'; repositoryName: string | null; objective: string | null; latestUserIntent: string | null;
  executionPolicy: string | null; pendingAction: string | null; relevantFiles: string[]; relevantSymbols: string[]; constraints: string[];
  findings: string | null; validation: string | null; attachmentNames: string[]; citationCount: number; researchSourceCount: number; messageCount: number; updatedAt: string;
}

/* ── Everyday tools, command queue, telemetry (ipc.ts) ── */
export interface EverydayNote { id: string; title: string; body: string; createdAt: string; updatedAt: string }
export interface EverydayReminder { id: string; title: string; body: string; dueAt: string; timezone: string; status: string; notifiedAt: string | null; overdue: boolean; overdueExplanation: string | null }
export interface ActiveTimer { id: string; label: string; durationMs: number; startedAt: string; deadlineMs: number; remainingMs: number; state: 'running' | 'paused' | 'completed' | 'cancelled' }
export interface EverydayTools {
  timezone?: string; alertsWhileClosed?: boolean; alertsWhileClosedDetail?: string;
  catalog?: Array<{ id: string; label?: string; availability?: string; detail?: string; connectorState?: string }>;
  notes?: EverydayNote[]; reminders?: EverydayReminder[]; dueReminders?: EverydayReminder[]; activeTimers?: ActiveTimer[];
}
export interface QueueItem {
  id: string; ordinal: number; status: string; title: string; instruction: string; revision: number; confirmationToken: string | null;
  confirmationExpiresAt: string | null; dependsOnId: string | null; outcome: string | null; lastError: string | null; postponedUntil: string | null;
}
export interface CommandQueue { active: QueueItem | null; confirming: QueueItem | null; waiting: QueueItem[]; recentTerminal: QueueItem[] }
export interface HostTelemetry {
  collectedAt: string;
  clock?: { localTime: string; timeZone: string };
  cpu: { value: number | null; available: boolean; detail: string; model: string | null; cores: number };
  memory: { available: boolean; usedBytes: number; totalBytes: number; usedPercent: number };
  disk: { available: boolean; mount: string | null; freeBytes: number | null; totalBytes: number | null; usedPercent: number | null; blocker: string };
  gpu: { available: boolean; name: string | null; usagePercent: number | null; temperatureC: number | null; vramUsedBytes: number | null; vramTotalBytes: number | null; blocker: string };
  ollama: { reachable: boolean; apiBase: string; detail: string };
  repository?: { available: boolean; branch: string | null; dirty: boolean | null; changedFileCount: number | null; blocker: string };
}
export type ImageGenerationResult =
  | { outcome: 'approval_required'; approvalId: string; attemptId: string; presentation: Record<string, unknown> | null }
  | { outcome: 'executed'; attemptId: string; artifactIds: string[]; message: string }
  | { outcome: 'denied' | 'unavailable' | 'failed'; attemptId?: string; reason: string };
export interface ImageStudioStatus { studio: boolean; comfyui: boolean; ollama: boolean; ollamaVersion?: string | null; detail: string; checkpoints: Array<{ name: string; category: string }> }
export interface AppMetadata {
  productName: string; version: string; buildNumber: number | null; buildKind: 'release' | 'development'; releaseChannel: string;
  commit: string | null; builtAt: string | null; installerVersion: string | null; coreVersion: string | null; coreVersionMismatch: boolean;
}
export interface UpdateStatus {
  available: boolean; installedRevision: number | null; version: string;
  lastResult: { status: 'success' | 'rolled_back' | 'aborted' | 'rollback_failed'; at: string; acknowledged: boolean; reason?: string; revision?: number; attemptedRevision?: number } | null;
}
export interface DailyBriefRoutine { id: string; enabled: boolean; dailyTime: string; timezone: string; nextRunAt: string | null; lastRunAt: string | null; conversationId: string | null }
export interface DevStoryPending { pendingId: string; what: string }
export interface DevStory {
  id: string; title: string; agent?: string; status: string; phase: string; verification?: string; updatedAt?: string; waitingReason?: string | null;
  dependsOn?: string[]; commit?: string | null; branch?: string | null; activity?: Array<{ at: string; kind: string; text: string }>; evidence?: string | null;
  pendingApprovals?: DevStoryPending[];
}
export interface DevStories { available: boolean; counts: Record<string, number>; stories: DevStory[] }
export interface CloudModel { id: string; displayName: string; contextWindow?: number; vision: boolean | 'unknown'; tools: boolean | 'unknown' }
export interface CloudProvider {
  id: string; displayName: string; configured: boolean; enabled: boolean; requiresBaseUrlInput?: boolean; baseUrl?: string | null;
  freeTier?: { kind: string; note?: string }; privacyWarning?: string | null; keyHint?: string | null; apiKeysUrl?: string; signupUrl?: string;
}
export interface CloudListing { ok: boolean; checkedAt: string; latencyMs: number; errorClass?: string; error?: string; pool: CloudModel[]; excluded?: Record<string, number> }
export interface CloudTest { ok: boolean; model: string; checkedAt: string; latencyMs: number; errorClass?: string; error?: string }
export interface CloudState {
  off?: boolean; enabledProviders?: string[]; selectedModel?: string | null; providers?: CloudProvider[];
  listings?: Record<string, CloudListing>; tests?: Record<string, CloudTest>;
}
export interface ActivityEvent {
  kind: string; at: string; conversationId?: string; messageRole?: string; attemptId?: string; eventType?: string; toolName?: string; summary: string; text?: string;
  /** For `navigate`: the place the assistant asked this window to open (navigate_to). */
  navigation?: { id: string; destination: string; target: string; label: string; surface?: string };
  /** For `workshop_command`: a view command Core asked the Workshop to carry out (confirm with confirmWorkshopCommand). */
  workshopCommand?: WorkshopCommandEvent;
  /** For `workshop_changed` / `workshop_progress`: which workshop, and the real stage reported. */
  workshop?: { workshopId: string | null; artifactId?: string | null; stage?: string; index?: number; total?: number };
}
export interface TaskRow {
  attemptId: string; requestId: string; conversationId: string | null; kind: string; status: string; title: string;
  provider: string | null; model: string | null; worker: string; activity: string; createdAt: string; startedAt: string | null;
  completedAt: string | null; elapsedMs: number; lastEventAt: string | null; lastEventType: string | null; cancelRequestedAt: string | null;
  failureReason: string | null; cancellable: boolean; live: boolean; leaseExpiresAt: string | null; interrupted: boolean;
}
export interface QueuedCommand { id: string; instruction?: string; title?: string; state?: string; [k: string]: unknown }
export interface BriefAction { kind: string; label: string; approvalId?: string; attemptId?: string; conversationId?: string; artifactId?: string }
export interface BriefItem { id: string; kind: string; stance: string; title: string; detail: string; state: string; at: string; source: { kind: string; label: string; checkedAt: string }; actions: BriefAction[] }
export interface Brief { generatedAt: string; home: BriefItem[] }

/** Who can reach Pandesh Mobile (ipc.ts MobileAccessMode). */
export type MobileAccess = 'off' | 'lan' | 'tailscale';
export interface MobileDevice { id: string; name: string; pairedAt: string; lastSeenAt: string | null; connected: boolean }
/** Phone pairing as the host reports it (ipc.ts MobilePairingView). Never a session token. */
export interface MobilePairing {
  code: string;
  codeExpiresAt: string | null;
  port: number;
  ip: string;
  url: string;
  secureUrl: string | null;
  secure: { state: 'ready' | 'not-installed' | 'not-running' | 'not-serving' | 'funnel' | 'error' | 'unchecked'; url: string | null; detail: string };
  localUrl: string;
  access: MobileAccess;
  pairedCount: number;
  connectedClients: number;
  listening: boolean;
  devices: MobileDevice[];
  pairingPausedUntil: string | null;
}


/** Free-model registry as the host returns it (no key values anywhere). */
export interface RegistryModelView { key: string; modelId: string; sources: string[]; status: string; statusReasons: string[]; limits: { contextTokens?: number; outputTokens?: number } }
export interface RegistryProviderView {
  id: string; displayName: string; hasAdapter: boolean; status: string; statusReasons: string[]; conflicts: string[];
  sources: Array<{ source: string; key: string; lastVerified?: string }>; requiresKey: boolean; keyUrl?: string; docsUrl?: string;
  training: string; freeKind: string; models: RegistryModelView[];
  health: { checkedAt: string; ok: boolean; errorClass: string | null; latencyMs: number; freeModels: number } | null;
}
export interface QualificationView {
  providerId: string; modelId: string; modelVersion?: string; suiteVersion: string; ranAt: string;
  capabilities: Record<string, boolean>; results: Array<{ id: string; outcome: string; latencyMs: number; detail: string }>;
}
export interface FreeModelsState {
  registry: {
    generatedAt: string | null;
    counts: { providers: number; models: number; modelsByStatus: Record<string, number> };
    lastReport: { summary: string; errors: string[] } | null;
    preferences: { autoProviders: string[]; disabledProviders: string[]; preferredOrder: string[]; fallbackOnRateLimit: boolean };
    exhaustedProviders: string[];
    providers: RegistryProviderView[];
    qualifications: QualificationView[];
    sources: Array<{ name: string; license: string; repository: string; fetch: { fetchedAt: string; carriedOver: boolean; error?: string } | null }>;
    unimportedSources: Array<{ name: string; license: string; reason: string }>;
    schedule: { enabled: boolean; dailyTime: string } | null;
  };
  credentials: { backend: string; status: Record<string, { configured: boolean; source: string | null; hint: string | null }>; legacyOnly: string[] };
  /** Which providers chats may use, the free models found for them, and the chat's cloud choice. */
  cloud?: CloudState;
}

export interface DesktopApi {
  getSnapshot(): Promise<Snapshot | null>;
  /** Phone pairing: the code and links, a new code, forget a phone, who may connect, resume paused pairing. */
  getMobilePairing(): Promise<MobilePairing>;
  rotateMobilePairingCode(): Promise<MobilePairing>;
  forgetMobileDevice(id: string): Promise<MobilePairing>;
  setMobileAccess(mode: MobileAccess): Promise<MobilePairing>;
  resumeMobilePairing(): Promise<MobilePairing>;
  /** `voiceTurnId` marks a message that was spoken (the transcript of a voice turn). */
  submitTask(goal: string, worker?: string, voiceTurnId?: string): Promise<{ attemptId: string; requestId: string; model: string; routed?: string }>;
  /** A local model name, `__auto__`, or `<provider>::<model>` for a free cloud model. */
  selectModel(model: string): Promise<Snapshot | null>;
  listModels(): Promise<string[]>;
  setPermissionMode(mode: PermissionMode, grant?: { categories: string[]; expiresInMinutes: number }): Promise<Snapshot>;
  revokeAuthorization(id: string): Promise<Snapshot>;
  /** Google (Gmail, Calendar): connect, verify, disconnect and the OAuth client. */
  connectGmail(): Promise<GmailStatus>;
  cancelGoogleConnect(): Promise<GmailStatus>;
  retryGmailProbe(): Promise<GmailStatus>;
  disconnectGmail(): Promise<GmailStatus>;
  allowInboxOrganization(): Promise<GmailStatus>;
  saveGoogleOAuthClient(clientId: string, clientSecret: string): Promise<GmailStatus>;
  clearGoogleOAuthClient(): Promise<GmailStatus>;
  importGoogleOAuthClientFile(): Promise<{ cancelled: boolean; status?: GmailStatus }>;
  /** Tells Core whether this window opened the place the assistant asked for (navigate_to). */
  confirmNavigation(navigationId: string, ok: boolean, detail?: string): Promise<{ recorded: boolean }>;
  cancel(): Promise<void>;
  cancelTask(attemptId: string): Promise<{ requested: boolean }>;
  resumeTask(attemptId: string): Promise<{ attemptId: string }>;
  resolveApproval(approvalId: string, resolution: ApprovalResolution): Promise<void>;
  resolveAssistantApproval(approvalId: string, resolution: ApprovalResolution): Promise<{ status: string }>;
  resolveImageApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
  resolveWeatherApproval(approvalId: string, resolution: ApprovalResolution): Promise<unknown>;
  listConversations(includeArchived?: boolean): Promise<ConversationEntry[]>;
  openConversation(id: string, select?: boolean): Promise<{ conversation: ConversationEntry; messages: TranscriptMessage[]; context?: ConversationContext }>;
  newConversation(): Promise<void>;
  getTaskOverview(): Promise<{ tasks: TaskRow[]; queued: QueuedCommand[] }>;
  getAssistantBrief(options?: { external?: boolean }): Promise<Brief>;
  retryCoreConnection(): Promise<Snapshot | null>;
  /* Conversations: rename, pin, archive, search, export. Each returns the refreshed list. */
  renameConversation(id: string, title: string): Promise<ConversationEntry[]>;
  pinConversation(id: string): Promise<ConversationEntry[]>;
  unpinConversation(id: string): Promise<ConversationEntry[]>;
  archiveConversation(id: string): Promise<ConversationEntry[]>;
  unarchiveConversation(id: string): Promise<ConversationEntry[]>;
  searchConversations(query: string): Promise<ConversationSearchResult[]>;
  exportConversation(id: string): Promise<{ saved: boolean; path: string | null }>;
  /* Attachments: the host stages files for the next message. */
  pickAttachments(): Promise<{ cancelled: boolean; errors: string[] }>;
  stageAttachmentBytes(name: string, bytes: Uint8Array): Promise<{ ok: boolean; error?: string }>;
  removeAttachment(id: string): Promise<void>;
  /* Everyday tools. */
  refreshEverydayTools(): Promise<Snapshot | null>;
  createNote(input: { title?: string; body: string }): Promise<Snapshot | null>;
  updateNote(id: string, input: { title?: string; body?: string }): Promise<Snapshot | null>;
  deleteNote(id: string): Promise<Snapshot | null>;
  createReminder(input: { title: string; body?: string; dueAt: string; timezone?: string }): Promise<Snapshot | null>;
  completeReminder(id: string): Promise<Snapshot | null>;
  cancelReminder(id: string): Promise<Snapshot | null>;
  getHostTelemetry(): Promise<HostTelemetry>;
  /* Command queue. */
  enqueueCommand(instruction: string): Promise<Snapshot | null>;
  confirmCommandRun(id: string, token: string, revision: number): Promise<Snapshot | null>;
  skipCommand(id: string): Promise<Snapshot | null>;
  postponeCommand(id: string, untilIso: string): Promise<Snapshot | null>;
  editQueuedCommand(id: string, instruction: string): Promise<Snapshot | null>;
  removeQueuedCommand(id: string): Promise<Snapshot | null>;
  reorderQueuedCommand(id: string, ordinal: number): Promise<Snapshot | null>;
  getDailyBriefRoutine(): Promise<DailyBriefRoutine | null>;
  configureDailyBriefRoutine(input: { dailyTime: string; timezone?: string; enabled?: boolean }): Promise<DailyBriefRoutine | null>;
  /* Image Studio. */
  probeImageStudio(): Promise<ImageStudioStatus>;
  generateImage(input: Record<string, unknown>): Promise<ImageGenerationResult>;
  cancelImageGeneration(): Promise<void>;
  openArtifactInStudio(artifactId: string): Promise<{ opened: boolean }>;
  useArtifactAsReference(artifactId: string): Promise<{ opened: boolean }>;
  saveArtifactCopy(artifactId: string): Promise<{ saved: boolean; path: string | null }>;
  openWorkspaceFile(relativePath: string): Promise<{ opened: boolean }>;
  openActivityDocument(activityId: string): Promise<{ opened: boolean }>;
  /* Development stories (Kandev workers). */
  getDevStories(): Promise<DevStories>;
  decideDevStoryPermission(storyId: string, pendingId: string, allow: boolean): Promise<{ ok: boolean }>;
  approveDevStoryReview(storyId: string): Promise<{ ok: boolean }>;
  retryDevStory(storyId: string): Promise<{ ok: boolean }>;
  verifyExistingDevStory(storyId: string): Promise<{ outcome: string; status: string; commit: string | null; reason: string | null }>;
  stopAllDevStories(): Promise<{ stopped: string[]; stillRunning: string[]; kandevAvailable: boolean }>;
  /* About, updates, diagnostics, engine. */
  getAppMetadata(): Promise<AppMetadata>;
  getDiagnosticsReport(): Promise<string>;
  getUpdateStatus(): Promise<UpdateStatus>;
  startUpdate(): Promise<{ status: string; message: string }>;
  acknowledgeUpdateResult(): Promise<void>;
  /* Free cloud models for chats. */
  setCloudProviderEnabled(providerId: string, enabled: boolean): Promise<CloudState>;
  discoverCloudModels(providerId: string): Promise<CloudState>;
  testCloudProvider(providerId: string, model: string): Promise<CloudState>;
  household(action: string, args?: Record<string, unknown>): Promise<unknown>;
  openExternalUrl(url: string): Promise<{ opened: boolean }>;
  /** Writes text to the clipboard from the host. The app window grants pages no clipboard permission, so
   *  `navigator.clipboard` is refused there. */
  copyToClipboard?(text: string): Promise<{ copied: boolean }>;
  listArtifacts(conversationId?: string): Promise<ArtifactView[]>;
  loadArtifactPreview(artifactId: string): Promise<{ artifact: ArtifactView; dataUrl: string; fileUrl?: string }>;
  openArtifactFile(artifactId: string): Promise<{ opened: boolean }>;
  openArtifactFolder(artifactId: string): Promise<{ opened: boolean }>;
  openWorkspaceFolder(): Promise<{ opened: boolean }>;
  /** The native folder dialog only: the chosen folder, or null. Changes nothing. */
  chooseFolder(options?: { title?: string; purpose?: 'workspace' | 'second_brain' }): Promise<{ folder: string } | null>;
  /** Whether a folder can be the workspace, and what the person should know first. */
  checkWorkspaceFolder(folder: string): Promise<FolderCheck>;
  /** The person's answer on the folder card: this folder, with Read (required) and Write as ticked. */
  useWorkspace(folder: string, access: { read: boolean; write: boolean }, source: 'picker' | 'chat' | 'recent'): Promise<Snapshot | null>;
  setWorkspaceAccess(access: WorkspaceAccess): Promise<Snapshot | null>;
  clearFolder(): Promise<Snapshot | null>;
  /** A message that names a folder (not the workspace) by its full path, or null. */
  inspectFolderMention(text: string): Promise<FolderMention | null>;
  /** The Workshop (core/shared/workshop): every write goes to Core, which keeps every version. */
  listWorkshops(conversationId?: string | null, scope?: 'recent'): Promise<WorkshopSummary[]>;
  loadWorkshopVersion(artifactId: string): Promise<WorkshopContent>;
  focusWorkshop(conversationId: string, workshopId: string | null, artifactId: string | null, open: boolean): Promise<{ recorded: boolean }>;
  confirmWorkshopCommand(commandId: string, ok: boolean, detail?: string, state?: Record<string, unknown>): Promise<{ recorded: boolean }>;
  saveWorkshopEdit(workshopId: string, parentArtifactId: string, conversationId: string | null, change: unknown[] | { set?: Record<string, unknown>; adjust?: Record<string, unknown> }): Promise<{ artifactId: string }>;
  exportWorkshopGlb(workshopId: string, sourceArtifactId: string, conversationId: string | null, bytes: Uint8Array, expectedNodes: string[]): Promise<{ verified: boolean; artifactId: string | null; checks: string[]; byteSize: number }>;
  saveWorkshopFile(artifactId: string): Promise<{ saved: boolean; path: string | null }>;
  /** A short-lived pandesh-preview: URL for a Design page (served from memory, sandboxed, no network). */
  designPreview(artifactId: string): Promise<{ url: string; nonce: string; expiresAt: string; warnings: string[] }>;
  onEvent(listener: (event: ActivityEvent) => void): () => void;
  /** Free models and provider keys: keys go in, never come back out. */
  getFreeModels(): Promise<FreeModelsState>;
  refreshFreeModels(): Promise<FreeModelsState>;
  setFreeModelPreferences(prefs: { autoProviders?: string[]; disabledProviders?: string[]; preferredOrder?: string[]; fallbackOnRateLimit?: boolean }): Promise<FreeModelsState>;
  setFreeModelSchedule(enabled: boolean): Promise<FreeModelsState>;
  testProviderKey(providerId: string): Promise<FreeModelsState>;
  qualifyFreeModel(providerId: string, model: string): Promise<FreeModelsState>;
  setCloudProviderKey(providerId: string, apiKey: string, baseUrl?: string): Promise<unknown>;
  clearCloudProviderKey(providerId: string): Promise<unknown>;
  migrateLegacyKeys(providerIds: string[]): Promise<{ results: Array<{ provider: string; migrated: boolean; reason?: string }>; state: FreeModelsState }>;
  exportCredentialBackup(passphrase: string, providerIds: string[]): Promise<{ file: string; providers: string[] } | null>;
  inspectCredentialBackup(file: string | null, passphrase: string): Promise<{ file: string; providers: string[] } | null>;
  restoreCredentialBackup(file: string, passphrase: string, providerIds: string[]): Promise<{ restored: string[]; skipped: string[]; state: FreeModelsState }>;
  setWakeWordEnabled(enabled: boolean): Promise<Snapshot | null>;
  setWakeWordMuted(muted: boolean): Promise<Snapshot | null>;
  /** Tells the host whether this page's wake microphone is open (and why not, when it failed). */
  reportWakeCapture(meta: WakeCaptureMeta): Promise<Snapshot | null>;
  /** One or more 16 kHz Int16 frames (base64) for the host's wake detector. */
  pushWakeAudio(pcmBase64: string, meta?: WakeCaptureMeta): Promise<{ score: number; detected: boolean; diagnostics?: WakeDiagnostics }>;
  onVoiceEvent?(listener: (event: VoiceEvent) => void): () => void;
}

export const api: DesktopApi = (window as unknown as { desktop: DesktopApi }).desktop;

type Listener = (e: ActivityEvent) => void;
const listeners = new Set<Listener>();
let subscribed = false;
/** One bridge subscription fanned out to every surface. */
export function onDesktopEvent(fn: Listener): () => void {
  if (!subscribed && api) {
    subscribed = true;
    api.onEvent((e) => { for (const l of [...listeners]) { try { l(e); } catch (err) { console.error(err); } } });
  }
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Snapshot kept fresh by Core events (coalesced) plus a slow safety poll. */
export function useSnapshot(): { snapshot: Snapshot | null; error: string | null; refresh: () => void } {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const refresh = () => {
    if (pending.current) return;
    pending.current = true;
    setTimeout(async () => {
      pending.current = false;
      try { const s = await api.getSnapshot(); setSnapshot(s); setError(null); } catch (err) { setError(String((err as Error)?.message ?? err)); }
    }, 60);
  };
  useEffect(() => {
    refresh();
    const off = onDesktopEvent((e) => { if (e.kind !== 'token') refresh(); });
    const poll = setInterval(refresh, 5000);
    return () => { off(); clearInterval(poll); };
  }, []);
  return { snapshot, error, refresh };
}

export function errorText(err: unknown): string {
  const msg = String((err as Error)?.message ?? err ?? 'Unknown error');
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
