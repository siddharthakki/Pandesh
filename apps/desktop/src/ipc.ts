import type { DesktopHostTelemetry } from './host/desktopHostTelemetry';
import type { ToolActivity, ToolActivityKind } from '../../../core/shared/toolActivity';

export type { DesktopHostTelemetry };

export const DESKTOP_CHANNELS = {
  pickFolder: 'desktop:pickFolder',
  setFolder: 'desktop:setFolder',
  clearFolder: 'desktop:clearFolder',
  /** The native folder dialog only: returns the chosen path and changes nothing. */
  chooseFolder: 'desktop:chooseFolder',
  /** Workspace folder with the person's access choice (v2 folder card): check, use, change access, chat mentions. */
  checkWorkspaceFolder: 'desktop:checkWorkspaceFolder',
  useWorkspace: 'desktop:useWorkspace',
  setWorkspaceAccess: 'desktop:setWorkspaceAccess',
  inspectFolderMention: 'desktop:inspectFolderMention',
  submitTask: 'desktop:submitTask',
  selectWorker: 'desktop:selectWorker',
  selectProvider: 'desktop:selectProvider',
  selectModel: 'desktop:selectModel',
  listModels: 'desktop:listModels',
  continueTask: 'desktop:continueTask',
  cancel: 'desktop:cancel',
  getSnapshot: 'desktop:getSnapshot',
  /** Product name + version + build identity from Electron/app package metadata (never invented). */
  getAppMetadata: 'desktop:getAppMetadata',
  /** The copyable diagnostics block: build, platform and runtime state. No credentials. */
  getDiagnosticsReport: 'desktop:getDiagnosticsReport',
  resolveApproval: 'desktop:resolveApproval',
  /** Narrow set/replace channel: key travels only here; never returned. */
  setOpenRouterApiKey: 'desktop:setOpenRouterApiKey',
  clearOpenRouterApiKey: 'desktop:clearOpenRouterApiKey',
  /** Free cloud providers: settings, discovery, connection test, selection and public-text approval. */
  refreshCloudCatalog: 'desktop:refreshCloudCatalog',
  setCloudProviderKey: 'desktop:setCloudProviderKey',
  clearCloudProviderKey: 'desktop:clearCloudProviderKey',
  setCloudProviderEnabled: 'desktop:setCloudProviderEnabled',
  discoverCloudModels: 'desktop:discoverCloudModels',
  testCloudProvider: 'desktop:testCloudProvider',
  selectCloudModel: 'desktop:selectCloudModel',
  setCloudLocalFallback: 'desktop:setCloudLocalFallback',
  previewCloudPublicText: 'desktop:previewCloudPublicText',
  /** WAV bytes (base64) from explicit push-to-talk capture in the renderer. */
  transcribeUtterance: 'desktop:transcribeUtterance',
  /** Real host telemetry for the control-center HUD (no fabricated values). */
  getHostTelemetry: 'desktop:getHostTelemetry',
  setWakeWordEnabled: 'desktop:setWakeWordEnabled',
  setWakeWordMuted: 'desktop:setWakeWordMuted',
  reportWakeCapture: 'desktop:reportWakeCapture',
  /** Int16 PCM @ 16 kHz as base64 (little-endian). Optional capture meta. */
  pushWakeAudio: 'desktop:pushWakeAudio',
  setVoiceMode: 'desktop:setVoiceMode',
  speakText: 'desktop:speakText',
  stopSpeaking: 'desktop:stopSpeaking',
  markPlaybackFinished: 'desktop:markPlaybackFinished',
  /** Everyday Tools — Notes / Reminders refresh and mutations. */
  refreshEverydayTools: 'desktop:refreshEverydayTools',
  createNote: 'desktop:createNote',
  updateNote: 'desktop:updateNote',
  deleteNote: 'desktop:deleteNote',
  createReminder: 'desktop:createReminder',
  completeReminder: 'desktop:completeReminder',
  cancelReminder: 'desktop:cancelReminder',
  /** Durable Command Queue */
  refreshCommandQueue: 'desktop:refreshCommandQueue',
  enqueueCommand: 'desktop:enqueueCommand',
  offerNextCommand: 'desktop:offerNextCommand',
  confirmCommandRun: 'desktop:confirmCommandRun',
  skipCommand: 'desktop:skipCommand',
  postponeCommand: 'desktop:postponeCommand',
  editQueuedCommand: 'desktop:editQueuedCommand',
  removeQueuedCommand: 'desktop:removeQueuedCommand',
  reorderQueuedCommand: 'desktop:reorderQueuedCommand',
  event: 'desktop:event',
  /** Push wake / speech lifecycle events to the renderer. */
  voiceEvent: 'desktop:voiceEvent',
  /** Gmail: OAuth connect/disconnect and the four typed tool actions. */
  connectGmail: 'desktop:connectGmail',
  disconnectGmail: 'desktop:disconnectGmail',
  dispatchGmailAction: 'desktop:dispatchGmailAction',
  resolveGmailApproval: 'desktop:resolveGmailApproval',
  summarizeGmailThread: 'desktop:summarizeGmailThread',
  retryGmailProbe: 'desktop:retryGmailProbe',
  setPermissionMode: 'desktop:setPermissionMode',
  revokeAuthorization: 'desktop:revokeAuthorization',
  /** The window's answer to a navigate_to request (it opened the place, or why not). */
  confirmNavigation: 'desktop:confirmNavigation',
  /** Incremental consent: the separate gmail.modify permission that lets Pandesh organize mail. */
  allowInboxOrganization: 'desktop:allowInboxOrganization',
  /** Google onboarding: the operator's own OAuth Desktop client, stored encrypted by the host. */
  saveGoogleOAuthClient: 'desktop:saveGoogleOAuthClient',
  clearGoogleOAuthClient: 'desktop:clearGoogleOAuthClient',
  cancelGoogleConnect: 'desktop:cancelGoogleConnect',
  importGoogleOAuthClientFile: 'desktop:importGoogleOAuthClientFile',
  /** Composer attachments: pick (native dialog), stage dropped/pasted bytes, remove. */
  pickAttachments: 'desktop:pickAttachments',
  stageAttachmentBytes: 'desktop:stageAttachmentBytes',
  removeAttachment: 'desktop:removeAttachment',
  getMobilePairing: 'desktop:getMobilePairing',
  /** Phone pairing on the PC: a new code, forget a phone, who may reach the phone server, resume paused pairing. */
  rotateMobilePairingCode: 'desktop:rotateMobilePairingCode',
  forgetMobileDevice: 'desktop:forgetMobileDevice',
  setMobileAccess: 'desktop:setMobileAccess',
  resumeMobilePairing: 'desktop:resumeMobilePairing',
  /** Jarvis Conversations rail (Checkpoint 1) — Core-owned, no Desktop database. */
  listConversations: 'desktop:listConversations',
  openConversation: 'desktop:openConversation',
  newConversation: 'desktop:newConversation',
  renameConversation: 'desktop:renameConversation',
  pinConversation: 'desktop:pinConversation',
  unpinConversation: 'desktop:unpinConversation',
  archiveConversation: 'desktop:archiveConversation',
  unarchiveConversation: 'desktop:unarchiveConversation',
  searchConversations: 'desktop:searchConversations',
  exportConversation: 'desktop:exportConversation',
  /** Core-governed web research. Network access always requires this approval. */
  startWebResearch: 'desktop:startWebResearch',
  resolveWebResearch: 'desktop:resolveWebResearch',
  getWebResearch: 'desktop:getWebResearch',
  /** Narrow host actions: HTTPS links and the already-selected workspace only. */
  openExternalUrl: 'desktop:openExternalUrl',
  openWorkspaceFolder: 'desktop:openWorkspaceFolder',
  openWorkspaceFile: 'desktop:openWorkspaceFile',
  /** Core-owned artifacts: safe gallery projection and verified local actions. */
  listArtifacts: 'desktop:listArtifacts',
  /** Development stories run by Kandev (read-only view + worker-permission decisions). */
  getDevStories: 'desktop:getDevStories',
  /** Tasks screen rows (durable attempts + queued instructions) and per-task Stop. */
  getTaskOverview: 'desktop:getTaskOverview',
  cancelTask: 'desktop:cancelTask',
  /** Pandesh: the context-aware Home brief and the Today briefing. */
  getAssistantBrief: 'desktop:getAssistantBrief',
  /** Pandesh: the one proactive routine — a user-configured daily brief. */
  getDailyBriefRoutine: 'desktop:getDailyBriefRoutine',
  configureDailyBriefRoutine: 'desktop:configureDailyBriefRoutine',
  household: 'desktop:household',
  /** Answers a pending approval from a visible card (Home included). */
  resolveAssistantApproval: 'desktop:resolveAssistantApproval',
  /** Resumes a task Core says can be retried safely. */
  resumeTask: 'desktop:resumeTask',
  /**
   * Reconnects to the local Core on the operator's request.
   *
   * The client stops reconnecting on its own after a bounded number of
   * attempts, so the recovery from "the Core is not answering" is an explicit
   * human action, not a background job.
   */
  retryCoreConnection: 'desktop:retryCoreConnection',
  decideDevStoryPermission: 'desktop:decideDevStoryPermission',
  stopAllDevStories: 'desktop:stopAllDevStories',
  verifyExistingDevStory: 'desktop:verifyExistingDevStory',
  retryDevStory: 'desktop:retryDevStory',
  approveDevStoryReview: 'desktop:approveDevStoryReview',
  confirmDeviceVerification: 'desktop:confirmDeviceVerification',
  loadArtifactPreview: 'desktop:loadArtifactPreview',
  openArtifactFolder: 'desktop:openArtifactFolder',
  openArtifactFile: 'desktop:openArtifactFile',
  openActivityDocument: 'desktop:openActivityDocument',
  saveArtifactCopy: 'desktop:saveArtifactCopy',
  /** Bounded local deep-links into the standalone Image Generation Studio
   * app (:8989) for one already-verified Core artifact — never an
   * arbitrary/user-supplied URL. */
  openArtifactInStudio: 'desktop:openArtifactInStudio',
  useArtifactAsReference: 'desktop:useArtifactAsReference',
  generateImage: 'desktop:generateImage',
  resolveImageApproval: 'desktop:resolveImageApproval',
  cancelImageGeneration: 'desktop:cancelImageGeneration',
  probeImageStudio: 'desktop:probeImageStudio',
  /** Weather is dispatched directly from a chat-detected intent
   * (desktopInteractionRouting's detectWeatherIntent), not a dedicated
   * form — only the approval resolution needs its own channel. */
  resolveWeatherApproval: 'desktop:resolveWeatherApproval',
  cancelWeatherLookup: 'desktop:cancelWeatherLookup',
  minimizeWindow: 'desktop:minimizeWindow',
  maximizeWindow: 'desktop:maximizeWindow',
  closeWindow: 'desktop:closeWindow',
  popoutWorkbench: 'desktop:popoutWorkbench',
  closePopoutWorkbench: 'desktop:closePopoutWorkbench',
  copyToClipboard: 'desktop:copyToClipboard',
  quitApp: 'desktop:quitApp',
  /** Phase 2: which renderer is loaded (`classic` | `v2`) and switching between them. */
  getUiVariant: 'desktop:getUiVariant',
  setUiVariant: 'desktop:setUiVariant',
  /** Update & Restart: verify a user-chosen local package, make Core safe to stop, then hand over to the updater. */
  startUpdate: 'desktop:startUpdate',
  getUpdateStatus: 'desktop:getUpdateStatus',
  acknowledgeUpdateResult: 'desktop:acknowledgeUpdateResult',
} as const;

export interface DesktopUpdateStatus {
  /** False when this install predates the updater (or the updater files are missing): use the installer. */
  available: boolean;
  /** The build actually running now (from the embedded build identity). */
  installedRevision: number | null;
  version: string;
  /** The outcome of the last update attempt, until the user dismisses it. */
  lastResult: {
    status: 'success' | 'rolled_back' | 'aborted' | 'rollback_failed';
    at: string;
    acknowledged: boolean;
    reason?: string;
    revision?: number;
    attemptedRevision?: number;
  } | null;
}

export interface DesktopUpdateStartResult {
  status: 'cancelled' | 'rejected' | 'blocked' | 'unavailable' | 'applying';
  message: string;
}

export type DesktopApprovalResolution = 'approved' | 'rejected';

/** Real product metadata from the Desktop host package / Electron app. */
export interface DesktopAppMetadata {
  productName: string;
  /** SemVer application version (the one authoritative version string). */
  version: string;
  /** Monotonic build number of an official build; null for a local build. */
  buildNumber: number | null;
  /** 'release' for an official build, 'development' for a local build. */
  buildKind: 'release' | 'development';
  /** dev | alpha | beta | stable */
  releaseChannel: 'dev' | 'alpha' | 'beta' | 'stable';
  /** Git commit SHA captured at build time; null when unknown. */
  commit: string | null;
  /** ISO-8601 build timestamp. */
  builtAt: string | null;
  /** Version stamped into the installer that carries this build. */
  installerVersion: string | null;
  /** The version the RUNNING Core reports. */
  coreVersion: string | null;
  /** True when the running Core's version differs from the desktop's. */
  coreVersionMismatch: boolean;
}

export interface DesktopApprovalCard {
  approvalId: string;
  gate: string;
  toolName: string;
  scope: string;
  paths: string[];
  detail: string;
}

/** A worker the operator may pick. Only `selectable` ones may be submitted. */
export interface DesktopWorkerOption {
  id: string;
  label: string;
  mode: 'read_only' | 'mutation';
  selectable: boolean;
  detail: string;
}

export interface DesktopTaskScopeView {
  repository: string;
  permittedActions: string[];
  deliveryDestination: string;
  pushAuthorized: boolean;
  authorized: boolean;
}

export type DesktopCoreState =
  | 'starting'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'unavailable'
  | 'authentication_failed'
  | 'incompatible'
  | 'database_failed';

export type CockpitPhase = 'investigation' | 'implementation' | 'repair';
export type CockpitAuthState = 'none' | 'pending' | 'collapsed';

export interface CockpitCheckpoint {
  id: string;
  at: string;
  endedAt?: string;
  durationMs?: number;
  title: string;
  detail?: string;
  outcome?: 'ok' | 'failed' | 'running' | 'cached';
  count?: number;
  /** The tool behind a step, for the expandable details; the title stays plain words. */
  tool?: string;
}

export interface CockpitCurrentAction {
  title: string;
  startedAt: string;
}

/**
 * Measured run metrics. Every field is null when it was not measured; the
 * renderer shows "unavailable" rather than zero, which would read as a real
 * measurement of nothing.
 */
export interface CockpitMetrics {
  aiResponses: number;
  promptTokens: number | null;
  generatedTokens: number | null;
  /** Tokens per second. `basis` says what the rate is actually over. */
  generationRate: { tokensPerSecond: number; basis: 'generation' | 'end-to-end' } | null;
  cloudCostAvoidedUsd: number | null;
  /** Provider-reported billed USD for this attempt. Null when not reported. */
  actualSpendUsd: number | null;
  /** Frozen OpenRouter USD cap for this attempt. Null when local-only. */
  spendCapUsd: number | null;
  comparison: {
    model: string;
    inputUsdPerMTok: number;
    outputUsdPerMTok: number;
    verifiedOn: string;
    source: string;
    exclusions: string;
  };
}

export interface MissionCockpitView {
  requestId: string | null;
  attemptId: string | null;
  running: boolean;
  terminal: boolean;
  phase: CockpitPhase;
  currentAction: CockpitCurrentAction | null;
  startedAt: string | null;
  elapsedMs: number;
  remainingAbsoluteMs: number;
  productiveUsed: number;
  phaseAllowance: number;
  repairCycle: number;
  filesRead: string[];
  filesChanged: string[];
  validationStatus: string;
  verificationStatus: string;
  checkpoints: CockpitCheckpoint[];
  diagnostics: DesktopActivityEvent[];
  metrics: CockpitMetrics;
  finalOutcome: string | null;
  authState: CockpitAuthState;
  pendingApproval: DesktopApprovalCard | null;
  approvedApproval: DesktopApprovalCard | null;
}

/** Non-secret OpenRouter readiness. Never carries key material. */
export interface DesktopLocalSpeechStatus {
  capability: 'available' | 'unavailable_no_local_engine' | 'failed' | 'not_applicable' | 'unavailable_unsupported_format';
  engine: string | null;
  /** Empty when local ASR is ready on the host; otherwise the exact blocker. */
  blocker: string;
}

/** Local TTS readiness for speaking Jarvis answers (host probe). */
export interface DesktopLocalSpeechResponseStatus {
  capability: 'available' | 'unavailable_no_local_engine' | 'failed' | 'not_applicable' | 'unavailable_unsupported_format';
  engine: string | null;
  /** Empty when local TTS is ready; otherwise the exact blocker. */
  blocker: string;
  voices: string[];
}

/** openWakeWord readiness (host probe + enable/mute). */
export interface DesktopWakeWordStatus {
  capability: 'available' | 'unavailable_no_local_engine' | 'failed' | 'not_applicable' | 'unavailable_unsupported_format';
  engine: string | null;
  blocker: string;
  phrase: string;
  enabled: boolean;
  muted: boolean;
}

/** Live wake capture/detector diagnostics — never imply Listening without capture. */
export interface DesktopWakeDiagnostics {
  engineReady: boolean;
  captureActive: boolean;
  captureError: string;
  contextSampleRate: number | null;
  trackLabel: string;
  micRms: number;
  framesReceived: number;
  lastScore: number;
  peakScore: number;
  lastScoreAt: string | null;
  lastDetectedAt: string | null;
  lastDetectedScore: number | null;
  /** Detector threshold used for the last score (product constant). */
  threshold: number;
  /** Times lastScore crossed threshold (actual detections). */
  thresholdCrossings: number;
  /** Soft approaches (score >= threshold * 0.75) for diagnosis — not detections. */
  approachCount: number;
  /** Audio frames pushed since last detector reset / enable. */
  framesSinceReset: number;
  /** True once enough frames have filled the openWakeWord embedding window. */
  readyForDetect: boolean;
  /** Wall ms from monitor/engine arm to detection; null until a real detection. Never invent 0. */
  wakeDetectMs: number | null;
  /** Last chunk inference duration from the worker; not wakeDetectMs. */
  lastInferenceMs: number | null;
  monitorStartedAt: string | null;
  recentScores: number[];
}

export interface DesktopWakeAudioMeta {
  rms?: number;
  sampleRate?: number;
  contextSampleRate?: number;
  framesEmitted?: number;
  captureActive?: boolean;
  captureError?: string;
  trackLabel?: string;
}

export interface DesktopWakeAudioResult {
  score: number;
  detected: boolean;
  diagnostics: DesktopWakeDiagnostics;
}

export interface DesktopTranscribeResult {
  transcript: string;
  engine: string;
  /** Set when the person must read and confirm the text before it is sent. */
  review?: { required: boolean; reasons: string[]; corrections: string[] };
}

export interface DesktopSpeakResult {
  wavBase64: string;
  engine: string;
  /** Wall ms from synthesize start to WAV ready (not playback). */
  synthesizeMs: number;
  /** True when a newer speak or Stop superseded this request; nothing to play. */
  cancelled?: boolean;
}

export interface DesktopOpenRouterStatus {
  keyConfigured: boolean;
  apiBase: string;
  model: string | null;
  maxUsd: number | null;
  /** False while Gate 1 cloud submission remains paused. */
  submissionReady: boolean;
  statusDetail: string;
}

export type DesktopInferenceProvider = 'ollama' | 'openrouter' | 'cloud';
export type DesktopRoutingPolicy = 'local-only' | 'explicit-openrouter' | 'explicit-cloud';

/** One catalog provider as the settings screen shows it. Never contains a key. */
export interface DesktopCloudProviderView {
  id: string;
  displayName: string;
  configured: boolean;
  enabled: boolean;
  requiresBaseUrlInput: boolean;
  baseUrl: string | null;
  freeTier: { kind: string; note?: string };
  paymentMethodRequired: string;
  signupUrl: string;
  apiKeysUrl: string;
  docsUrl: string;
  lastVerifiedAt: string;
  privacyWarning: string | null;
  /** Masked hint only, e.g. `gsk_…A1b2`. */
  keyHint: string | null;
}

export interface DesktopCloudModel {
  id: string;
  displayName: string;
  contextWindow?: number;
  vision: boolean | 'unknown';
  tools: boolean | 'unknown';
}

export interface DesktopCloudModelListing {
  ok: boolean;
  checkedAt: string;
  latencyMs: number;
  errorClass?: string;
  error?: string;
  pool: DesktopCloudModel[];
  excluded: { paid: number; unknown: number; promotional: number; trial: number; nonGenerative: number };
  /** Listed but not offered (display only; never selectable). */
  others?: Array<{ id: string; displayName: string; reason: 'paid' | 'unknown' | 'promotional' | 'trial' }>;
}

export interface DesktopCloudConnectionTest {
  ok: boolean;
  model: string;
  checkedAt: string;
  latencyMs: number;
  errorClass?: string;
  error?: string;
  rateLimit: { limitRequests?: string; remainingRequests?: string; resetRequests?: string; retryAfter?: string };
  replyPreview?: string;
}

/** The provider catalog Core ships, as returned by `GET /v1/cloud/catalog`. */
export interface DesktopCloudCatalog {
  catalogVersion: string;
  providers: Array<{
    id: string;
    displayName: string;
    freeTier: { kind: string; note?: string };
    paymentMethodRequired: string;
    signupUrl: string;
    apiKeysUrl: string;
    docsUrl: string;
    requiresBaseUrlInput: boolean;
    baseUrl: string;
    privacyWarning: string | null;
    lastVerifiedAt: string;
    configured: boolean;
  }>;
}

export interface DesktopCloudState {
  /** Cloud is off by default: nothing enabled and no model selected. */
  off: boolean;
  catalogVersion: string;
  enabledProviders: string[];
  /** `<provider>::<model>` for the conversation dropdown. */
  selectedModel: string | null;
  localFallback: boolean;
  providers: DesktopCloudProviderView[];
  listings: Record<string, DesktopCloudModelListing>;
  tests: Record<string, DesktopCloudConnectionTest>;
}

/** The exact two messages a cloud request may carry, shown before approval. */
export interface DesktopCloudPublicTextPreview {
  providerId: string;
  model: string;
  providerName: string;
  systemPrompt: string;
  text: string;
  eligible: boolean;
  reason?: string;
}

/** Chat permission mode for a conversation. Core stores and enforces it; the renderer only shows and chooses. */
export type DesktopPermissionMode = 'ask' | 'auto' | 'plan';
export interface DesktopPermissionGrant {
  /** Core category ids (see core/domain/permissionModes.ts AUTHORIZATION_CATEGORIES). */
  categories: string[];
  expiresInMinutes: number;
}
export interface DesktopPermissionState {
  conversationId: string | null;
  mode: DesktopPermissionMode;
  /** Active standing authorizations only. */
  authorizations: Array<{ id: string; categories: string[]; workspaceRoot: string | null; expiresAt: string; pinnedScripts: string[] }>;
  /** Category id -> plain description, from Core. */
  categories: Record<string, string>;
  /** True while the mode waits for the next message to create its conversation. */
  pending: boolean;
  /** The workspace a pending Auto grant is bound to (the folder selected when it was chosen). */
  pendingWorkspaceRoot?: string | null;
  /** The mode the running or resumed turn was frozen with, or null when nothing runs. */
  activeTurnMode?: DesktopPermissionMode | null;
}

/** How far the person let Pandesh into the workspace folder (host/workspaceAccess.ts; Core enforces 'read'). */
export type DesktopWorkspaceAccess = 'read' | 'read_write';

/** The workspace folder and what Pandesh may do there. */
export interface DesktopWorkspaceView {
  folder: string;
  access: DesktopWorkspaceAccess;
  grantedAt: string | null;
  /** How it became the workspace; `earlier_build` = chosen before access levels existed (it kept full access). */
  source: 'picker' | 'chat' | 'recent' | 'earlier_build';
}

export interface DesktopRecentWorkspace {
  folder: string;
  access: DesktopWorkspaceAccess;
  lastUsedAt: string;
}

/** Whether a folder can be the workspace (host/workspaceAccess.ts FolderCheck). */
export interface DesktopFolderCheck {
  folder: string;
  state: 'ok' | 'missing' | 'not_a_folder' | 'refused' | 'unreadable';
  reason?: string;
  warning?: string;
  readable: boolean;
  writable: boolean;
}

/** A message named a folder that is not the workspace: the window asks before making it one. */
export interface DesktopFolderMention {
  folder: string;
  spelled: string;
  check: DesktopFolderCheck;
  /** The access the person last chose for this folder, if it is a recent one. */
  rememberedAccess: DesktopWorkspaceAccess | null;
}

export interface DesktopSnapshot {
  coreState: DesktopCoreState;
  coreDetail?: string;
  folder: string | null;
  /** The workspace folder with its access level (null when none is selected). */
  workspace?: DesktopWorkspaceView | null;
  /** Folders used before, newest first, with the access last chosen for each. */
  recentWorkspaces?: DesktopRecentWorkspace[];
  model: string | null;
  /** True when the next local submit delegates model choice to Core. */
  modelIsAuto: boolean;
  modelAvailable: boolean | null;
  /** D8: false when the local model server (Ollama) did not answer the last probe; null when unknown or cloud. */
  modelServerReachable?: boolean | null;
  /** Installed Ollama model names for the picker. */
  installedModels: string[];
  /** Free cloud providers, verified free model pools and selection. Off by default. */
  cloud?: DesktopCloudState;
  /** Provider for the next submit (default ollama). Active attempt uses frozen context. */
  selectedInferenceProvider: DesktopInferenceProvider;
  provider: DesktopInferenceProvider;
  routingPolicy: DesktopRoutingPolicy;
  apiBase: string;
  attemptId: string | null;
  requestId: string | null;
  task: string | null;
  running: boolean;
  awaitingApproval: boolean;
  pendingApproval: DesktopApprovalCard | null;
  /** Set when a chat-triggered image request (see desktopInteractionRouting's
   * detectImageGenerationIntent) is waiting for the same exact approval the
   * Image Studio panel's own "Generate image" button produces. */
  pendingImageApproval?: { approvalId: string; attemptId: string | null; presentation: Record<string, unknown> | null; request?: { prompt: string; checkpoint: string; width: number | null; height: number | null; outputCount: number; toolName?: string; seconds?: number | null; fromReference?: boolean } } | null;
  /** Set when a chat-detected weather question (detectWeatherIntent) is
   * waiting for the same governed get_weather approval network access
   * always requires here, same as web research. */
  pendingWeatherApproval?: { approvalId: string; attemptId: string | null; presentation: Record<string, unknown> | null } | null;
  taskScope: DesktopTaskScopeView | null;
  coreBuild?: { instanceId?: string; bundleHash?: string; busy?: boolean };
  cockpit: MissionCockpitView;
  /** What the contextual workspace shows for the viewed conversation, oldest first. */
  workspaceActivities: DesktopWorkspaceActivity[];
  workers: DesktopWorkerOption[];
  selectedWorker: string;
  /** Phase 2b: the specialist agent the next turns go to; null = Pandesh. */
  selectedAgentId?: string | null;
  /** Recorded on the request that ran, so the answer is attributable. */
  activeWorker: string | null;
  /** Gate 0: non-secret OpenRouter configuration status only. */
  openRouter: DesktopOpenRouterStatus;
  /** Local Whisper / external ASR readiness for push-to-talk (host probe). */
  localSpeech: DesktopLocalSpeechStatus;
  /** Local TTS readiness for Speak response (host probe). */
  localSpeechResponse: DesktopLocalSpeechResponseStatus;
  /** openWakeWord readiness and enable/mute flags. */
  wakeWord: DesktopWakeWordStatus;
  /** Live mic/detector diagnostics for wake acceptance. */
  wakeDiagnostics: DesktopWakeDiagnostics;
  /** When true, final answers are auto-spoken if TTS is available. */
  voiceMode: boolean;
  /** Host marked speaking; Stop remains available via button. */
  speaking: boolean;
  /** chat | local_core | mission — drives chrome visibility and Core mode. */
  interactionMode: 'chat' | 'local_core' | 'mission';
  /** Explicit terminal outcome; never infer success from terminal alone. */
  lastTurnOutcome: 'completed' | 'failed' | 'cancelled' | null;
  /** Truthful "what actually happened" label — never claims a file was
   * written when the model only returned text/code. `artifact_created` is
   * reserved for the future Core-owned artifact capability and is never
   * produced today. */
  turnOutcomeKind: 'answered' | 'artifact_created' | 'workspace_changed' | 'blocked_needs_workspace' | 'failed' | null;
  /** Set only for a `blocked_needs_workspace` outcome — the exact reason to
   * show, alongside a Select-folder action. */
  blockedReason: string | null;
  /**
   * Interruption policy while speaking.
   * buttonStop stays true during playback. spokenBargeIn is false while mic
   * capture is suppressed to avoid self-hearing — do not claim spoken interrupt.
   */
  speechInterrupt: {
    buttonStop: boolean;
    spokenBargeIn: boolean;
    spokenBargeInBlocker: string;
  };
  /** Latest host telemetry sample; null until first successful collect. */
  hostTelemetry: DesktopHostTelemetry | null;
  /** Everyday Tools catalog, notes, reminders, and due items for Today. */
  everydayTools: EverydayToolsSnapshot;
  /** Durable Command Queue projection. */
  commandQueue: CommandQueueSnapshot;
  gmail: DesktopGmailStatus;
  /** Files waiting in the composer for the next message (host-staged; no paths). */
  stagedAttachments?: Array<{ id: string; name: string; byteSize: number; kind: 'text' | 'image' | 'document' | 'audio'; mimeType: string }>;
  /** Why the answering model differs from, or was chosen beyond, the selection (e.g. it can see images). */
  modelNote?: string | null;
  /** Jarvis Conversations rail (Checkpoint 1). The conversation the operator
   * explicitly opened/selected in the rail — persists across restart. Null
   * until a conversation has ever been opened or submitted. */
  selectedConversationId: string | null;
  /** Permission mode of the selected conversation (or the one chosen for the next new conversation). */
  permission: DesktopPermissionState;
  /** The conversation the currently running/last turn actually used. The
   * renderer feeds live turn updates into the transcript pane only when this
   * equals `selectedConversationId` — otherwise the operator is viewing a
   * different (non-active) conversation's durable transcript. */
  activeConversationId: string | null;
  /** Effective model context envelope/window if known; null when unknown/incomplete. */
  contextEnvelope?: number | null;
}

/** Jarvis Conversations rail (Checkpoint 1) — renderer-facing projection of
 * Core's `ConversationRailEntry`. State is derived by Core from the latest
 * attempt for the conversation, never stored or recomputed here. */
export interface ConversationRailEntryView {
  id: string;
  title: string | null;
  preview: string | null;
  state: 'active' | 'needs_approval' | 'completed' | 'failed' | 'stopped';
  repositoryName: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  pinnedAt: string | null;
}

export interface RequestDiagnosticsView {
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

export interface ConversationTranscriptMessageView {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: string;
  model?: string | null;
  provider?: string | null;
  diagnostics?: RequestDiagnosticsView | null;
  /** Files sent with this message. */
  attachments?: Array<{ id: string; name: string; kind: 'text' | 'image' | 'document' | 'audio'; byteSize: number }>;
}

export interface ConversationOpenResult {
  conversation: ConversationRailEntryView;
  messages: ConversationTranscriptMessageView[];
  context: ConversationContextView;
}

/** Bounded, renderer-safe projection of Core's conversation export and
 * optional durable working state. It deliberately excludes credentials,
 * system prompts, raw tool output, hidden reasoning, and repository bytes. */
export interface ConversationContextView {
  state: 'available' | 'not_recorded' | 'no_workspace';
  repositoryName: string | null;
  objective: string | null;
  latestUserIntent: string | null;
  executionPolicy: 'READ_ONLY' | 'COLLABORATIVE_EDIT' | 'AUTONOMOUS_EXECUTION' | null;
  pendingAction: string | null;
  relevantFiles: string[];
  relevantSymbols: string[];
  constraints: string[];
  findings: string | null;
  validation: string | null;
  attachmentNames: string[];
  citationCount: number;
  researchSourceCount: number;
  messageCount: number;
  updatedAt: string;
}

export interface ConversationExportResult {
  saved: boolean;
  path: string | null;
}

export interface DesktopArtifactView {
  id: string;
  conversationId: string | null;
  kind: 'image' | 'video' | 'document' | 'file';
  title: string;
  mimeType: string;
  fileName: string;
  byteSize: number;
  source: string;
  createdAt: string;
  availability: 'ready' | 'missing' | 'changed' | 'unreadable';
}

export interface DesktopArtifactPreview {
  artifact: DesktopArtifactView;
  dataUrl: string;
  /** Set for video artifacts (played from disk after hash verification). */
  fileUrl?: string;
}

export interface DesktopImageStudioStatus { studio: boolean; comfyui: boolean; ollama: boolean; ollamaVersion?: string | null; detail: string; checkpoints: Array<{ name: string; category: string }> }
export type DesktopImageGenerationResult =
  | { outcome: 'approval_required'; approvalId: string; attemptId: string; presentation: Record<string, unknown> | null }
  | { outcome: 'executed'; attemptId: string; artifactIds: string[]; message: string }
  | { outcome: 'denied' | 'unavailable' | 'failed'; attemptId?: string; reason: string };
export type DesktopWeatherResult =
  | { outcome: 'approval_required'; approvalId: string; attemptId: string; presentation: Record<string, unknown> | null }
  | { outcome: 'executed'; attemptId: string; message: string }
  | { outcome: 'denied' | 'unavailable' | 'failed'; attemptId?: string; reason: string };

export interface ConversationSearchResultView {
  conversationId: string;
  messageId: string | null;
  title: string | null;
  snippet: string;
  matchedKinds: Array<'title' | 'message' | 'attachment' | 'transcript' | 'source'>;
  updatedAt: string;
}

export interface DesktopResearchApprovalView {
  researchId: string;
  conversationId: string;
  approvalId: string;
  requestedActionDigest: string;
  provider: string;
  queryPreview: string;
  maxSources: number;
}

export interface DesktopResearchSourceView {
  rank: number;
  title: string;
  url: string | null;
  status: 'fetched' | 'failed' | 'rejected';
}

export interface DesktopResearchResultView {
  researchId: string;
  conversationId: string;
  query: string;
  state: 'awaiting_approval' | 'denied' | 'running' | 'completed' | 'insufficient_evidence' | 'failed' | 'unavailable';
  answer: string | null;
  failureClassification: string | null;
  sources: DesktopResearchSourceView[];
}

/** Non-secret Gmail connection status. Never carries a token. */
export interface DesktopGmailStatus {
  connected: boolean;
  accountEmail: string | null;
  lastError: string | null;
  lastRefreshedAt: string | null;
  /** The exact OAuth-client setup blocker, or `null` when configured. */
  configBlocker: string | null;
  /** Core's live capability health, kept separate from OAuth `connected` —
   * an account can be validly connected while the capability itself is
   * still unavailable (no token pushed yet, probe failure, …). `null` when
   * Core reports Gmail available. */
  capabilityBlocker: string | null;
  /** A connect attempt (browser sign-in) is in flight right now. */
  connecting?: boolean;
  /** Where the OAuth client comes from; null until one is set up. */
  clientSource?: 'environment' | 'saved' | 'bundled' | null;
  /** Masked, non-secret hint of the configured OAuth client id. */
  clientHint?: string | null;
  /** True ONLY when OAuth is connected AND Core's live Gmail probe succeeded. */
  verified?: boolean;
  /** Whether the pinned Google helper (gws) is staged where Core will find it. */
  helperStaged?: boolean;
  /** Whether Google granted gmail.modify (organizing mail: categories, labels, archive). Requested separately and only on request. */
  inboxOrganization?: 'granted' | 'not_granted';
  /** Whether Google granted Calendar in the last sign-in ('not_granted' also covers sign-ins that predate Calendar). */
  calendarAccess?: 'granted' | 'not_granted';
  /** Core's live Calendar health behind the same grant; `null` when verified. */
  calendarBlocker?: string | null;
  /** The last connect/refresh failure, with what to do about it. */
  recovery?: { code: string; title: string; steps: string[]; link?: { label: string; url: string } } | null;
}

/** The renderer-facing shape of one Gmail tool-action dispatch — a narrowed
 * mirror of Core's `CapabilityDispatchResult`, safe to pass to the renderer
 * as-is (search/thread-read output is already bounded, non-secret content;
 * a send-draft result carries only message/thread IDs, never body text). */
export type DesktopGmailActionResult =
  | { outcome: 'executed'; output: string }
  | { outcome: 'approval_required'; approvalId: string; presentation: Record<string, unknown> | null }
  | { outcome: 'denied'; reason: string }
  | { outcome: 'unavailable'; reason: string }
  | { outcome: 'unknown_tool' };

export interface CommandQueueItemView {
  id: string;
  ordinal: number;
  status: string;
  title: string;
  instruction: string;
  revision: number;
  confirmationToken: string | null;
  confirmationExpiresAt: string | null;
  dependsOnId: string | null;
  outcome: string | null;
  lastError: string | null;
  postponedUntil: string | null;
}

export interface CommandQueueSnapshot {
  active: CommandQueueItemView | null;
  confirming: CommandQueueItemView | null;
  waiting: CommandQueueItemView[];
  recentTerminal: CommandQueueItemView[];
}

export type EverydayToolAvailability = 'available' | 'not_connected' | 'not_implemented';

/* ── Pandesh: the Personal Assistant brief ────────────────────────────── */

/**
 * One line of the brief. Every item carries the source it came from, the
 * state that source recorded, the timestamp that source wrote, and the
 * actions the operator can actually take. Nothing here is invented.
 */
export interface DesktopAssistantBriefAction {
  kind: 'resolve_approval' | 'open_conversation' | 'stop_task' | 'resume_task' | 'open_artifact' | 'refresh_brief';
  label: string;
  approvalId?: string;
  attemptId?: string;
  conversationId?: string;
  artifactId?: string;
}

export interface DesktopAssistantBriefItem {
  id: string;
  kind: string;
  /** 'fact' = observed, 'suggestion' = Pandesh's advice, 'action_performed' = already done. */
  stance: 'fact' | 'suggestion' | 'action_performed';
  title: string;
  detail: string;
  state: string;
  at: string;
  source: { kind: string; label: string; reference: string | null; checkedAt: string };
  actions: DesktopAssistantBriefAction[];
}

export interface DesktopAssistantBriefSection {
  id: string;
  label: string;
  /** False when the source could not be read; the reason says why. */
  available: boolean;
  unavailableReason: string | null;
  items: DesktopAssistantBriefItem[];
}

export interface DesktopAssistantBrief {
  generatedAt: string;
  timezone: string;
  /** At most three items that need attention or show meaningful progress. */
  home: DesktopAssistantBriefItem[];
  today: DesktopAssistantBriefSection[];
  services: Array<{ id: string; label: string; state: string; reason: string | null; checkedAt: string }>;
  /** The same brief as plain text, so the app and the conversation agree. */
  markdown: string;
}

/** The user-configured daily routine. Null when it was never set up. */
export interface DesktopDailyBriefRoutine {
  id: string;
  enabled: boolean;
  dailyTime: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  conversationId: string | null;
}

/** Jarvis Connector Foundation truthful state — mirrors core/shared/wireTypes.ts
 * `ConnectorState`. Present only on the four connector catalog entries
 * (gmail/google_calendar/whatsapp/printer); other entries omit it. */
export type ConnectorState = 'not_configured' | 'connecting' | 'connected' | 'degraded' | 'unavailable';

export interface ConnectorPermissions {
  read: boolean;
  draft: boolean;
  execute: boolean;
}

export interface EverydayToolCatalogEntry {
  id: string;
  label: string;
  availability: EverydayToolAvailability;
  detail: string;
  /** Live connector state from Core (requirement #1), present only for
   * connector-backed entries. Absent means this entry is not a governed
   * connector (Notes, Reminders, etc.). */
  connectorState?: ConnectorState;
  permissions?: ConnectorPermissions;
}

export interface EverydayNoteView {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface EverydayReminderView {
  id: string;
  title: string;
  body: string;
  dueAt: string;
  timezone: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'notified';
  notifiedAt: string | null;
  overdue: boolean;
  overdueExplanation: string | null;
}

export interface ActiveTimerView {
  id: string;
  label: string;
  durationMs: number;
  startedAt: string;
  deadlineMs: number;
  remainingMs: number;
  state: 'running' | 'paused' | 'completed' | 'cancelled';
  conversationId?: string | null;
}

export interface EverydayToolsSnapshot {
  timezone: string;
  /** Always false until a verified closed-app mechanism exists. */
  alertsWhileClosed: boolean;
  alertsWhileClosedDetail: string;
  catalog: EverydayToolCatalogEntry[];
  notes: EverydayNoteView[];
  reminders: EverydayReminderView[];
  dueReminders: EverydayReminderView[];
  activeTimers?: ActiveTimerView[];
}

export type DesktopActivityKind =
  | 'status'
  | 'activity'
  | 'approval'
  | 'token'
  | 'result'
  | 'cancelled'
  | 'error'
  /** Core appended a message outside a live turn (e.g. a development-story report). */
  | 'conversation_message'
  /** A pending approval was requested, resolved, superseded or expired. */
  | 'assistant_approval_changed'
  /** The assistant asked this window to open a place (navigate_to); the window confirms with confirmNavigation. */
  | 'navigate';

export interface DesktopActivityEvent {
  kind: DesktopActivityKind;
  at: string;
  conversationId?: string;
  /** For `conversation_message`: who the appended message is from. */
  messageRole?: string;
  attemptId?: string;
  requestId?: string;
  eventType?: string;
  domain?: string;
  toolName?: string;
  invocationId?: string;
  invocationStatus?: string;
  toolArgs?: Record<string, unknown>;
  /** For `navigate`: which registered place to open and the window's own navigation target for it. */
  navigation?: { id: string; destination: string; target: string; label: string; surface: 'v2' | 'classic' };
  /**
   * Core's structured `run_check` evidence, mirroring
   * `core/runtime/missionObservations.ts`. Absent on a non-check event and on
   * records written before Core persisted it, so a consumer must tolerate its
   * absence rather than require it.
   */
  check?: {
    kind: 'validation' | 'diff_review' | 'status' | 'commit';
    status: 'passed' | 'failed' | 'rejected' | 'refused' | 'blocked';
    reviewedPaths?: string[];
    reviewDigest?: string;
    commitSha?: string;
    command?: string;
    exitCode?: number | null;
  };
  summary: string;
  text?: string;
  promptTokens?: number | null;
  completionTokens?: number | null;
  /** Backend-reported generation time. Absent when the backend omits it. */
  generationMs?: number | null;
  /** End-to-end call time, including prompt evaluation and queueing. */
  durationMs?: number | null;
  costUsd?: number | null;
  clientOrigin?: 'desktop' | 'mobile';
  /** The bounded preview a tool published with its result (core/shared/toolActivity.ts). */
  activity?: ToolActivity;
}

export type WorkspaceActivityState = 'running' | 'completed' | 'failed' | 'cancelled';

/** One real step shown in the contextual workspace (see host/workspaceActivity.ts). */
export interface DesktopWorkspaceActivity {
  /** The Core tool invocation id, or a host id for a host-made capability call. */
  id: string;
  conversationId: string | null;
  /** The Core attempt (task) this step belongs to. */
  taskId: string | null;
  /** The capability tool that produced it, e.g. browser_goto. */
  capability: string;
  kind: ToolActivityKind;
  title: string;
  state: WorkspaceActivityState;
  startedAt: string;
  endedAt: string | null;
  /** The reported failure, or a check's summary. */
  detail: string | null;
  preview: ToolActivity | null;
}

export interface DesktopSubmitResult {
  requestId: string;
  attemptId: string;
  model: string;
  /** Set when the send arrived while work was running: 'stopped' = Stop wording cancelled it, 'queued' = persisted behind it. */
  routed?: 'stopped' | 'queued' | 'duplicate' | 'steered' | 'side_question' | 'corrected_queued' | 'corrected_restarted' | 'corrected_steered';
  commandId?: string;
}

/** Result of set/clear OpenRouter key. Never includes the key. */
export interface DesktopOpenRouterKeyResult {
  keyConfigured: boolean;
}

/** Who can reach the phone server: nobody, the home network (and Tailscale), or only the local Tailscale proxy. */
export type MobileAccessMode = 'off' | 'lan' | 'tailscale';

export interface MobileSecureLinkView {
  state: 'ready' | 'not-installed' | 'not-running' | 'not-serving' | 'funnel' | 'error' | 'unchecked';
  url: string | null;
  detail: string;
}

export interface MobilePairedDeviceView {
  id: string;
  name: string;
  pairedAt: string;
  lastSeenAt: string | null;
  connected: boolean;
}

/** The phone pairing state for the PC (Connections → Phone; Classic Integrations). Never contains a session token. */
export interface MobilePairingView {
  /** The current single-use pairing code, as ABCD-EFGH ('' while phone access is off). */
  code: string;
  codeExpiresAt: string | null;
  port: number;
  /** The address the server is reachable on from the home network, or its bind address. */
  ip: string;
  /** Home-network pairing link (plain HTTP), '' when the server does not listen on the network. */
  url: string;
  /** HTTPS pairing link through `tailscale serve`, when it is set up. */
  secureUrl: string | null;
  secure: MobileSecureLinkView;
  /** This PC's own address for the phone app (no code), for opening it here. */
  localUrl: string;
  access: MobileAccessMode;
  /** Number of paired phones. */
  pairedCount: number;
  /** Phones with a live connection right now. */
  connectedClients: number;
  listening: boolean;
  devices: MobilePairedDeviceView[];
  /** Set while pairing is paused after too many wrong codes. */
  pairingPausedUntil: string | null;
}

/** Renderer-visible contract. Credentials never appear here. */
export const RENDERER_VISIBLE_KEYS: readonly (keyof DesktopSnapshot)[] = [
  'coreState',
  'coreDetail',
  'folder',
  'workspace',
  'recentWorkspaces',
  'model',
  'modelAvailable',
  'installedModels',
  'selectedInferenceProvider',
  'provider',
  'routingPolicy',
  'apiBase',
  'attemptId',
  'requestId',
  'task',
  'running',
  'awaitingApproval',
  'pendingApproval',
  'taskScope',
  'coreBuild',
  'cockpit',
  'workers',
  'selectedWorker',
  'activeWorker',
  'openRouter',
  'localSpeech',
  'localSpeechResponse',
  'wakeWord',
  'wakeDiagnostics',
  'voiceMode',
  'speaking',
  'interactionMode',
  'lastTurnOutcome',
  'speechInterrupt',
  'hostTelemetry',
  'selectedConversationId',
  'permission',
  'activeConversationId',
  'workspaceActivities',
  'contextEnvelope',
];
