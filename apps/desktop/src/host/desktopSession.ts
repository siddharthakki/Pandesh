import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CoreLauncher, defaultCorePath } from '../../../../src/core-client/CoreLauncher';
import { CoreClient } from '../../../../src/core-client/CoreClient';
import type { RuntimeEventRecord, RuntimeTokenFrame, ConnectorId, ApprovalRecord, CapabilityDispatchResult } from '../../../../core/shared/wireTypes';
import {
  assertLocalModelInstalled,
  buildDesktopCoreExtraEnv,
  listInstalledOllamaModels,
  OPENROUTER_NOT_READY_MESSAGE,
  OPENROUTER_OFFICIAL_API_BASE,
  OPENROUTER_SUBMISSION_READY,
  requireOpenRouterSelection,
  resolveDesktopProviderConfig,
  resolveLegacyModelForMigration,
  resolveOpenRouterConfig,
  type DesktopProviderConfig,
} from './desktopConfig';
import {
  clearOpenRouterApiKey,
  loadOpenRouterApiKey,
  openRouterApiKeyPresent,
  storeOpenRouterApiKey,
  tryElectronSecretBox,
} from './openRouterCredential';
import { buildConnectorCredentialEnv, storeConnectorCredential, clearConnectorCredential } from './connectorCredentials';
import { createPortProcessManager } from '../../../../core/runtime/portManager';
import { CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT, decideCloudPublicText } from '../../../../core/runtime/cloudPublicText';
import {
  clearCloudProviderKey,
  cloudProviderKeyHint,
  isCloudOff,
  loadCloudProviderKey,
  loadCloudSettings,
  saveCloudSettings,
  storeCloudProviderKey,
} from './cloudProviderSettings';
import { GmailTokenManager, type GmailConnectionStatus } from './gmailTokenManager';
import {
  clearStoredGoogleOAuthClient,
  maskGoogleClientId,
  parseGoogleClientSecretJson,
  resolveGoogleOAuthClient,
  storeGoogleOAuthClient,
  validateGoogleOAuthClientInput,
  type GoogleOAuthClientSource,
} from './googleOAuthClientStore';
import { classifyGoogleError } from './googleErrorGuide';
import { GOOGLE_CALENDAR_SCOPE, GMAIL_MODIFY_SCOPE } from './gmailOAuth';
import { routeSendWhileRunning } from './composerRouting';
import { AttachmentStaging, type StagedAttachmentView } from './desktopAttachments';
import { chooseVisionModel, fetchOllamaVisionModels, visionSelectionEvidence } from './desktopVision';
import { readSelectedModel, writeSelectedModel } from './desktopModelSelection';
import { readSelectedConversation, writeSelectedConversation, clearSelectedConversation } from './desktopConversationSelection';
import {
  requireMatchingPending,
  selectActionableApproval,
  toApprovalEnvelope,
  toCapabilityResolveInput,
  toDesktopApprovalCard,
  type DesktopApprovalEnvelope,
} from './desktopApproval';
import {
  authorizeDesktopTaskScope,
  classifyDesktopApproval,
  describeDesktopTaskScope,
  type DesktopTaskScope,
} from './desktopTaskScope';
import { resolveHostBrowserBin } from '../../../../core/runtime/hostBrowserBin';
import { AUTO_CHAT_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL } from '../../../../core/domain/modelRouting';
import { getOrCreateDesktopClientId, getOrCreateDesktopToken, getOrCreateHostToken } from './desktopToken';
import { readLastWorkspace, writeLastWorkspace } from './desktopSessionCursor';
import { emptyMissionCockpit, projectMissionCockpit } from './missionCockpit';
import {
  classifyTurnOutcomeKind,
  detectImageGenerationIntent,
  detectWeatherIntent,
  extractBareLocationAnswer,
  extractImageGenerationPrompt,
  selectImageCheckpoint,
  detectImageFollowUp,
  detectVideoGenerationIntent,
  extractVideoPrompt,
  composeEditPrompt,
  extractWeatherLocation,
  planDesktopInteraction,
  isStopIntent,
  type DesktopInteractionMode,
  type DesktopTurnOutcome,
  type DesktopTurnOutcomeKind,
} from './desktopInteractionRouting';
import {
  formatLocalInstant,
  hostTimezone,
  parseEverydayIntent,
} from './everydayToolsIntent';
import { EverydayReminderScheduler } from './everydayReminderScheduler';
import { everydayToolCatalog } from './everydayToolCatalog';
import { listWorkerOptions, findWorkerOption, resolveWorkerProfile } from '../../../../core/runtime/localCoreQuestion';
import { probeDesktopLocalSpeech, transcribeDesktopUtterance } from './desktopLocalSpeech';
import {
  probeDesktopLocalSpeechResponse,
  synthesizeDesktopSpeech,
} from './desktopLocalSpeechResponse';
import type {
  DesktopActivityEvent,
  DesktopApprovalCard,
  DesktopApprovalResolution,
  DesktopLocalSpeechResponseStatus,
  DesktopLocalSpeechStatus,
  DesktopOpenRouterKeyResult,
  DesktopOpenRouterStatus,
  DesktopSnapshot,
  DesktopSpeakResult,
  DesktopTranscribeResult,
  DesktopWakeAudioMeta,
  DesktopWakeDiagnostics,
  DesktopWakeWordStatus,
  EverydayToolsSnapshot,
  CommandQueueSnapshot,
  CommandQueueItemView,
  DesktopGmailActionResult,
  ConversationOpenResult,
  ConversationRailEntryView,
  ConversationSearchResultView,
  DesktopResearchApprovalView,
  DesktopResearchResultView,
  DesktopArtifactView,
  DesktopArtifactPreview,
  DesktopImageGenerationResult,
  DesktopImageStudioStatus,
  DesktopWeatherResult,
  DesktopSubmitResult,
  DesktopAssistantBrief,
  DesktopDailyBriefRoutine,
  DesktopCloudCatalog,
  DesktopCloudConnectionTest,
  DesktopCloudModelListing,
  DesktopCloudProviderView,
  DesktopCloudPublicTextPreview,
  DesktopCloudState,
} from '../ipc';
import {
  OpenWakeWordEngine,
  probeDesktopWakeWord,
} from './desktopWakeWord';
import { WAKE_SCORE_THRESHOLD, WAKE_WARMUP_AUDIO_FRAMES } from './wakeWordConfig';
import { collectDesktopHostTelemetry, type DesktopHostTelemetry } from './desktopHostTelemetry';
import { buildConversationContextView, conversationWorkspaceIdentity } from './desktopConversationContext';
import {
  ensureImageStudioServices,
  probeImageStudioServices,
  IMAGE_STUDIO_APP_URL,
  type ImageStudioServiceStatus,
} from './desktopImageStudio';

export const AUTO_MODEL = '__auto__';

/** How long a Stop waits for Core to confirm the attempt reached a terminal
 * state before the desktop says plainly that the stop was not confirmed. */
export const CANCEL_CONFIRM_TIMEOUT_MS = 8_000;

export interface DesktopSessionOptions {
  productRoot: string;
  dataDir?: string;
  corePath?: string;
  bundledCoreVersion?: string;
  evidenceLogPath?: string;
  log?: (message: string) => void;
  /** Electron (or test) desktop notification sink. */
  notifyReminder?: (input: { id: string; title: string; body: string }) => void | Promise<void>;
  /** Called when a reminder notification should open UI for that reminder. */
  onReminderNotificationClick?: (reminderId: string) => void;
  /** Pending queue confirmation while the window may be hidden. Never auto-runs. */
  notifyQueueConfirm?: (input: {
    id: string;
    title: string;
    instruction: string;
    token: string;
    revision: number;
  }) => void | Promise<void>;
  onQueueConfirmNotificationClick?: (commandId: string) => void;
  ensureImageStudio?: (onStatus?: (text: string) => void) => Promise<ImageStudioServiceStatus>;
  probeImageStudio?: () => Promise<ImageStudioServiceStatus>;
  /** How long a Stop waits for Core to confirm the attempt reached a terminal
   * state before the desktop reports that the stop was not confirmed. */
  cancelConfirmTimeoutMs?: number;
}

interface ActiveTurn {
  attemptId: string;
  requestId: string;
  conversationId: string;
  goal: string;
  tokenBuffer: string;
  terminal: boolean;
  /** Set only when this turn originated from a voice submission, so the
   * first-token log can be correlated with the renderer's per-turn voice
   * telemetry (see stage=transcript_submitted). */
  voiceTurnId?: string;
  clientOrigin?: 'desktop' | 'mobile';
  /** True once the stage=first_token log has fired for this attempt — a
   * turn-scoped flag (not a Set) since ActiveTurn already models "one turn
   * at a time" and resets on every new submission. */
  firstTokenLogged?: boolean;
}

/** A staged attachment handed to one send (host-private path included). */
type StagedForSend = StagedAttachmentView & { filePath: string };

interface MediaPlan {
  toolName: 'image_generate' | 'video_generate';
  label: string;
  prompt: string;
  checkpoint?: string;
  arguments: Record<string, unknown>;
  /** The image attached to this message, to be registered as the edit/animation reference. */
  attachedImage?: StagedForSend;
}

export class DesktopSession {
  readonly dataDir: string;
  readonly token: string;
  readonly clientId: string;
  private client: CoreClient | undefined;
  private folder: string | null = null;
  private provider: DesktopProviderConfig | undefined;
  private modelAvailable: boolean | null = null;
  private installedModels: string[] = [];
  private operatorSelectedModel: string | null = null;
  private coreState: DesktopSnapshot['coreState'] = 'starting';
  private coreDetail: string | undefined;
  /** The Core this session is currently attached to. */
  private coreBaseUrl: string | undefined;
  /** True once a lost Core has been re-launched automatically, so the
   *  recovery is a single attempt and never a loop. */
  private coreRecoveryAttempted = false;
  private active: ActiveTurn | undefined;
  private pending: { card: DesktopApprovalCard; envelope: DesktopApprovalEnvelope } | undefined;
  private taskScope: DesktopTaskScope | null = null;
  private coreBuild: DesktopSnapshot['coreBuild'];
  private approvedApproval: DesktopApprovalCard | null = null;
  private cockpitEvents: DesktopActivityEvent[] = [];
  private missionStartedAt: string | null = null;
  private selectedWorker = 'local-core';
  private selectedInferenceProvider: 'ollama' | 'openrouter' | 'cloud' = 'ollama';
  private cloudCatalogCache: DesktopCloudCatalog | null = null;
  private cloudListings = new Map<string, DesktopCloudModelListing>();
  private cloudTests = new Map<string, DesktopCloudConnectionTest>();
  /** Set when the operator explicitly approved the exact text of the next cloud send. */
  private cloudApprovedText: string | null = null;
  private activeWorker: string | null = null;
  /** Frozen on the active attempt for cockpit spend display. */
  private activeSpendCapUsd: number | null = null;
  private activeProvider: 'ollama' | 'openrouter' | 'cloud' | null = null;
  private activeModel: string | null = null;
  private activeContextEnvelope: number | null = null;
  private readonly listeners = new Set<(event: DesktopActivityEvent) => void>();
  private readonly localSpeech: DesktopLocalSpeechStatus;
  private localSpeechResponse: DesktopLocalSpeechResponseStatus;
  private wakeWord: DesktopWakeWordStatus;
  private wakeEngine: OpenWakeWordEngine | null = null;
  private wakeEnabled = false;
  private wakeMuted = false;
  private wakeDiagnostics: DesktopWakeDiagnostics = emptyWakeDiagnostics();
  private voiceMode = true;
  private speaking = false;
  /** Monotonic id for the current speak attempt. speakText's catch block is
   * an async continuation that can race a newer speakText/stopSpeaking call
   * (e.g. a failed synth for an abandoned reply resolving after a new one
   * has already started speaking) — same bug class as the renderer's
   * speechGeneration guard, mirrored host-side so a stale attempt's failure
   * handler cannot clear `speaking` out from under a newer one. */
  private speakGeneration = 0;
  private voiceConversationId: string | null = null;
  /** Jarvis Conversations rail (Checkpoint 1) — the conversation explicitly
   * opened/selected via the rail, persisted across restart. Distinct from
   * `voiceConversationId` (the per-process lazily-created default), which
   * keeps working unchanged for the two call sites that never touch the
   * rail. `submitTask` prefers this one when set. */
  private selectedConversationId: string | null = null;
  private interactionMode: DesktopInteractionMode = 'chat';
  private lastTurnOutcome: DesktopTurnOutcome | null = null;
  /** Truthful "what actually happened" label, independent of the coarser
   * completed/failed/cancelled state above — see `DesktopTurnOutcomeKind`. */
  private turnOutcomeKind: DesktopTurnOutcomeKind | null = null;
  /** Set only for a `blocked_needs_workspace` outcome — the exact reason,
   * for a Select-folder action in the conversation pane (never a Core call
   * happens for this outcome; nothing to inspect on `this.active`). */
  private blockedReason: string | null = null;
  private hostTelemetry: DesktopHostTelemetry | null = null;
  private readonly voiceListeners = new Set<(event: Record<string, unknown>) => void>();
  private everydayTools: EverydayToolsSnapshot = emptyEverydayToolsSnapshot();
  private commandQueue: CommandQueueSnapshot = emptyCommandQueueSnapshot();
  private reminderScheduler: EverydayReminderScheduler | null = null;
  /** Serialize wake PCM into the worker so frames stay ordered without IPC storms. */
  private wakePushTail: Promise<unknown> = Promise.resolve();
  private queueOfferTimer: NodeJS.Timeout | null = null;
  private executingQueuedCommandId: string | null = null;
  private lastQueueConfirmNotifyKey: string | null = null;
  private readonly gmailTokenManager: GmailTokenManager;
  private gmailStatusCache: GmailConnectionStatus;
  /** Last failed browser sign-in (never a token). Cleared on the next attempt. */
  private googleConnectError: string | null = null;
  private googleConnecting = false;
  /** A single in-flight Gmail UI action approval, entirely independent of
   * the chat/task `this.pending` slot — Gmail's Search/Thread/Draft surface
   * is driven directly by the renderer, never by a Saath Kar attempt. */
  private pendingGmailApproval: { toolName: string; arguments: Record<string, unknown>; approval: ApprovalRecord } | null = null;
  private pendingImageApproval: { arguments: Record<string, unknown>; approval: ApprovalRecord; correlationId: string; toolName?: 'image_generate' | 'video_generate' } | null = null;
  private activeImageAttemptId: string | null = null;
  private pendingWeatherApproval: { arguments: Record<string, unknown>; approval: ApprovalRecord; correlationId: string } | null = null;
  private activeWeatherAttemptId: string | null = null;
  /** Last location a weather question resolved to, so a same-conversation
   * follow-up ("will it rain?" right after "weather in Ulm?") doesn't have
   * to repeat the place name every time. Cleared on a fresh conversation. */
  private lastWeatherLocation: string | null = null;
  /** True right after Jarvis asked "Which location?" — the very next
   * utterance is treated as the answer even though a bare place name
   * ("Ulm", "in Ulm") has no weather noun of its own and would otherwise
   * fall through to ordinary chat instead of resolving the weather lookup. */
  private awaitingWeatherLocation = false;
  private readonly attachmentStaging: AttachmentStaging;
  /** Why the model answering this turn differs from (or was chosen beyond) the user's selection, e.g. it can see images. */
  private modelNote: string | null = null;
  /** Live streaming evidence per attempt (first/last token time, chunk count) for the Tasks telemetry. */
  private readonly tokenStats = new Map<string, { firstAt: number; lastAt: number; chunks: number }>();
  private submissionQueue: Array<{
    goal: string;
    workerId?: string;
    voiceTurnId?: string;
    staged?: StagedForSend[];
    clientOrigin: 'desktop' | 'mobile';
    resolve: (res: { requestId: string; attemptId: string; model: string }) => void;
    reject: (err: any) => void;
  }> = [];

  constructor(private readonly options: DesktopSessionOptions) {
    this.dataDir = options.dataDir ?? defaultDesktopDataDir();
    this.token = getOrCreateDesktopToken(this.dataDir);
    this.clientId = getOrCreateDesktopClientId(this.dataDir);
    this.attachmentStaging = new AttachmentStaging(path.join(this.dataDir, 'attachment-staging'));
    this.operatorSelectedModel = readSelectedModel(this.dataDir);
    this.selectedConversationId = readSelectedConversation(this.dataDir);
    this.localSpeech = probeDesktopLocalSpeech(this.options.productRoot);
    this.localSpeechResponse = probeDesktopLocalSpeechResponse(this.options.productRoot);
    this.wakeWord = probeDesktopWakeWord(this.options.productRoot, { enabled: false, muted: false });
    this.gmailTokenManager = new GmailTokenManager({
      dataDir: this.dataDir,
      getClient: () => this.client ?? null,
      resolveClientConfig: () => resolveGoogleOAuthClient(this.dataDir, tryElectronSecretBox()).config,
      onStatusChange: (status) => {
        this.gmailStatusCache = status;
        this.emit({ kind: 'status', at: nowIso(), summary: status.connected ? `Gmail connected (${status.accountEmail})` : 'Gmail disconnected' });
      },
    });
    this.gmailStatusCache = this.gmailTokenManager.getStatus();
  }

  /** Host-only local ASR probe (Whisper WASM or configured external command). */
  getLocalSpeechStatus(): DesktopLocalSpeechStatus {
    return { ...this.localSpeech };
  }

  /** Piper TTS probe — available when staged via fetch-piper.mjs. */
  getLocalSpeechResponseStatus(): DesktopLocalSpeechResponseStatus {
    this.localSpeechResponse = probeDesktopLocalSpeechResponse(this.options.productRoot);
    return {
      ...this.localSpeechResponse,
      voices: [...this.localSpeechResponse.voices],
    };
  }

  getWakeWordStatus(): DesktopWakeWordStatus {
    this.wakeWord = probeDesktopWakeWord(this.options.productRoot, {
      enabled: this.wakeEnabled,
      muted: this.wakeMuted,
    });
    return { ...this.wakeWord };
  }

  getWakeDiagnostics(): DesktopWakeDiagnostics {
    return {
      ...this.wakeDiagnostics,
      engineReady: Boolean(this.wakeEngine) && this.wakeEnabled,
      recentScores: [...this.wakeDiagnostics.recentScores],
    };
  }

  reportWakeCapture(meta: Record<string, unknown>): DesktopSnapshot {
    const captureError = typeof meta.captureError === 'string' ? meta.captureError : '';
    if (captureError) {
      this.wakeDiagnostics.captureActive = false;
      this.wakeDiagnostics.captureError = captureError;
    } else if (meta.captureActive === true) {
      this.wakeDiagnostics.captureActive = true;
      this.wakeDiagnostics.captureError = '';
    } else if (meta.captureActive === false) {
      this.wakeDiagnostics.captureActive = false;
    }
    if (typeof meta.rms === 'number') this.wakeDiagnostics.micRms = meta.rms;
    if (typeof meta.contextSampleRate === 'number') {
      this.wakeDiagnostics.contextSampleRate = meta.contextSampleRate;
    } else if (typeof meta.sampleRate === 'number') {
      this.wakeDiagnostics.contextSampleRate = meta.sampleRate;
    }
    if (typeof meta.trackLabel === 'string') this.wakeDiagnostics.trackLabel = meta.trackLabel;
    if (typeof meta.framesEmitted === 'number') {
      this.wakeDiagnostics.framesReceived = Math.max(
        this.wakeDiagnostics.framesReceived,
        meta.framesEmitted,
      );
    }
    return this.snapshot();
  }

  onVoiceEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.voiceListeners.add(listener);
    return () => this.voiceListeners.delete(listener);
  }

  private emitVoice(event: Record<string, unknown>): void {
    for (const listener of this.voiceListeners) {
      try { listener(event); } catch { /* ignore */ }
    }
  }

  async setWakeWordEnabled(enabled: boolean): Promise<DesktopSnapshot> {
    const probe = probeDesktopWakeWord(this.options.productRoot, {
      enabled,
      muted: this.wakeMuted,
    });
    if (enabled && probe.capability !== 'available') {
      throw new Error(probe.blocker || 'Wake word unavailable');
    }
    this.wakeEnabled = enabled;
    if (!enabled) {
      this.wakeEngine?.dispose();
      this.wakeEngine = null;
      this.wakeDiagnostics = emptyWakeDiagnostics();
    } else if (!this.wakeEngine) {
      this.wakeEngine = await OpenWakeWordEngine.create(this.options.productRoot);
      this.wakeDiagnostics.engineReady = true;
      this.wakeDiagnostics.captureError = '';
      this.wakeDiagnostics.monitorStartedAt = nowIso();
      this.wakeDiagnostics.wakeDetectMs = null;
      this.wakeDiagnostics.thresholdCrossings = 0;
      this.wakeDiagnostics.approachCount = 0;
      this.wakeDiagnostics.peakScore = 0;
      this.wakeDiagnostics.framesReceived = 0;
      this.wakeDiagnostics.framesSinceReset = 0;
      this.wakeDiagnostics.readyForDetect = false;
      this.wakeDiagnostics.threshold = WAKE_SCORE_THRESHOLD;
      this.wakeDiagnostics.recentScores = [];
    }
    this.wakeWord = probeDesktopWakeWord(this.options.productRoot, {
      enabled: this.wakeEnabled,
      muted: this.wakeMuted,
    });
    this.emitVoice({
      kind: 'wake_state',
      enabled: this.wakeEnabled,
      muted: this.wakeMuted,
      engineReady: Boolean(this.wakeEngine),
      at: nowIso(),
    });
    return this.snapshot();
  }

  setWakeWordMuted(muted: boolean): DesktopSnapshot {
    this.wakeMuted = muted;
    if (muted) this.wakeDiagnostics.captureActive = false;
    this.wakeWord = probeDesktopWakeWord(this.options.productRoot, {
      enabled: this.wakeEnabled,
      muted: this.wakeMuted,
    });
    this.emitVoice({
      kind: 'wake_state',
      enabled: this.wakeEnabled,
      muted: this.wakeMuted,
      at: nowIso(),
    });
    return this.snapshot();
  }

  setVoiceMode(enabled: boolean): DesktopSnapshot {
    this.voiceMode = Boolean(enabled);
    return this.snapshot();
  }

  async pushWakeAudioBase64(
    pcmBase64: string,
    meta?: DesktopWakeAudioMeta | Record<string, unknown>,
  ): Promise<{ score: number; detected: boolean; diagnostics: DesktopWakeDiagnostics }> {
    const run = async () => this.pushWakeAudioBase64Unlocked(pcmBase64, meta);
    const result = this.wakePushTail.then(run, run);
    this.wakePushTail = result.then(() => undefined, () => undefined);
    return result;
  }

  private async pushWakeAudioBase64Unlocked(
    pcmBase64: string,
    meta?: DesktopWakeAudioMeta | Record<string, unknown>,
  ): Promise<{ score: number; detected: boolean; diagnostics: DesktopWakeDiagnostics }> {
    if (meta) this.reportWakeCapture({ ...meta, captureActive: true });
    if (!this.wakeEnabled || this.wakeMuted || this.speaking) {
      return { score: 0, detected: false, diagnostics: this.getWakeDiagnostics() };
    }
    if (!this.wakeEngine) {
      this.wakeEngine = await OpenWakeWordEngine.create(this.options.productRoot);
      this.wakeDiagnostics.engineReady = true;
    }
    const buf = Buffer.from(String(pcmBase64 ?? ''), 'base64');
    if (buf.length < 2) {
      return { score: 0, detected: false, diagnostics: this.getWakeDiagnostics() };
    }
    const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
    this.wakeDiagnostics.framesReceived += 1;
    this.wakeDiagnostics.framesSinceReset += 1;
    this.wakeDiagnostics.readyForDetect = this.wakeDiagnostics.framesSinceReset >= WAKE_WARMUP_AUDIO_FRAMES;
    if (!this.wakeDiagnostics.monitorStartedAt) {
      this.wakeDiagnostics.monitorStartedAt = nowIso();
    }
    const started = Date.now();
    const result = await this.wakeEngine.pushInt16(pcm);
    const inferenceMs = typeof result.detectMs === 'number' ? result.detectMs : (Date.now() - started);
    this.wakeDiagnostics.lastInferenceMs = inferenceMs;
    this.wakeDiagnostics.lastScore = result.score;
    this.wakeDiagnostics.lastScoreAt = nowIso();
    this.wakeDiagnostics.peakScore = Math.max(this.wakeDiagnostics.peakScore, result.score);
    this.wakeDiagnostics.threshold = WAKE_SCORE_THRESHOLD;
    this.wakeDiagnostics.recentScores = [
      ...this.wakeDiagnostics.recentScores,
      Number(result.score.toFixed(4)),
    ].slice(-24);
    this.wakeDiagnostics.engineReady = true;
    this.wakeDiagnostics.captureActive = true;
    this.wakeDiagnostics.captureError = '';
    const approachFloor = this.wakeDiagnostics.threshold * 0.75;
    if (result.score >= approachFloor) {
      this.wakeDiagnostics.approachCount += 1;
    }
    const detected = result.detected;
    if (detected) {
      this.wakeDiagnostics.thresholdCrossings += 1;
      this.wakeDiagnostics.lastDetectedAt = nowIso();
      this.wakeDiagnostics.lastDetectedScore = result.score;
      if (this.wakeDiagnostics.monitorStartedAt) {
        const armed = Date.parse(this.wakeDiagnostics.monitorStartedAt);
        this.wakeDiagnostics.wakeDetectMs = Number.isFinite(armed)
          ? Math.max(0, Date.now() - armed)
          : null;
      } else {
        this.wakeDiagnostics.wakeDetectMs = null;
      }
      this.emitVoice({
        kind: 'wake_detected',
        score: this.wakeDiagnostics.lastDetectedScore,
        threshold: this.wakeDiagnostics.threshold,
        inferenceMs,
        wakeDetectMs: this.wakeDiagnostics.wakeDetectMs,
        detectMs: this.wakeDiagnostics.wakeDetectMs,
        framesReceived: this.wakeDiagnostics.framesReceived,
        peakScore: this.wakeDiagnostics.peakScore,
        at: result.at,
      });
      this.wakeEngine.reset();
      this.wakeDiagnostics.framesSinceReset = 0;
      this.wakeDiagnostics.readyForDetect = false;
      this.wakeDiagnostics.recentScores = [];
    } else if (this.wakeDiagnostics.framesReceived % 12 === 0) {
      this.emitVoice({
        kind: 'wake_score',
        score: result.score,
        peakScore: this.wakeDiagnostics.peakScore,
        threshold: this.wakeDiagnostics.threshold,
        thresholdCrossings: this.wakeDiagnostics.thresholdCrossings,
        approachCount: this.wakeDiagnostics.approachCount,
        framesReceived: this.wakeDiagnostics.framesReceived,
        framesSinceReset: this.wakeDiagnostics.framesSinceReset,
        readyForDetect: this.wakeDiagnostics.readyForDetect,
        micRms: this.wakeDiagnostics.micRms,
        contextSampleRate: this.wakeDiagnostics.contextSampleRate,
        inferenceMs,
        wakeDetectMs: this.wakeDiagnostics.wakeDetectMs,
        at: nowIso(),
      });
    }
    return {
      score: result.score,
      detected,
      diagnostics: this.getWakeDiagnostics(),
    };
  }

  async speakText(text: string): Promise<DesktopSpeakResult> {
    const started = Date.now();
    const generation = ++this.speakGeneration;
    this.speaking = true;
    this.emitVoice({
      kind: 'speaking',
      at: nowIso(),
      buttonStop: true,
      spokenBargeIn: false,
      spokenBargeInBlocker:
        'Spoken interruption is unavailable while microphone capture is suppressed during playback.',
    });
    try {
      const { wavPath, engine } = synthesizeDesktopSpeech(this.options.productRoot, text);
      const wavBase64 = fs.readFileSync(wavPath).toString('base64');
      const synthesizeMs = Date.now() - started;
      this.options.log?.(
        `speakText: ${synthesizeMs}ms synth (engine=${engine}, chars=${text.length}, wavKB=${Math.round(wavBase64.length * 0.75 / 1024)})`,
      );
      return {
        wavBase64,
        engine,
        synthesizeMs,
      };
    } catch (err) {
      if (generation !== this.speakGeneration) {
        // A newer speakText/stopSpeaking already superseded this attempt —
        // do not clear `speaking`, it belongs to the newer generation now.
        this.options.log?.(`speakText: dropped stale failure (generation=${generation}, current=${this.speakGeneration})`);
        throw err;
      }
      this.speaking = false;
      this.emitVoice({ kind: 'speak_failed', at: nowIso(), summary: String(err) });
      throw err;
    }
  }

  stopSpeaking(reason: 'button' | 'host' = 'button'): DesktopSnapshot {
    this.speakGeneration += 1;
    this.speaking = false;
    this.emitVoice({
      kind: 'speak_stopped',
      reason,
      at: nowIso(),
      interruption: reason === 'button' ? 'button_stop' : 'host_stop',
    });
    return this.snapshot();
  }

  markPlaybackFinished(): DesktopSnapshot {
    this.speaking = false;
    this.options.log?.('markPlaybackFinished: speaking=false');
    this.emitVoice({ kind: 'speak_finished', at: nowIso() });
    return this.snapshot();
  }

  async transcribeUtteranceWavBase64(wavBase64: string, voiceTurnId?: string): Promise<DesktopTranscribeResult> {
    const trimmed = String(wavBase64 ?? '').trim();
    if (!trimmed) throw new Error('no audio was captured');
    const wavBytes = Buffer.from(trimmed, 'base64');
    if (wavBytes.length < 44) throw new Error('captured audio is too short to transcribe');
    const turnTag = voiceTurnId ? ` turn=${voiceTurnId}` : '';
    const startedNs = process.hrtime.bigint();
    this.options.log?.(`[voice]${turnTag} stage=asr_started`);
    const { transcript, engine, review } = await transcribeDesktopUtterance(this.options.productRoot, wavBytes);
    const asrMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    this.options.log?.(
      `[voice]${turnTag} stage=asr_completed asrMs=${Math.round(asrMs)} engine=${engine} chars=${transcript?.length ?? 0} review=${review.required}`,
    );
    // An empty transcript here is routine, not exceptional: Whisper can
    // hallucinate a non-speech caption ("[MUSIC]") on silence/ambient noise,
    // which is already stripped to '' upstream. Throwing would surface a
    // raw IPC error instead of the renderer's normal "no speech captured"
    // message, so return it and let the caller decide.
    return { transcript, engine, review: { required: review.required, reasons: review.reasons, corrections: review.corrections } };
  }

  async refreshHostTelemetry(): Promise<DesktopHostTelemetry> {
    const apiBase = this.selectedInferenceProvider === 'openrouter'
      ? OPENROUTER_OFFICIAL_API_BASE
      : (this.provider?.apiBase ?? 'http://127.0.0.1:11434');
    this.hostTelemetry = await collectDesktopHostTelemetry({
      folder: this.folder,
      apiBase,
    });
    return this.hostTelemetry;
  }

  getHostTelemetry(): DesktopHostTelemetry | null {
    return this.hostTelemetry ? { ...this.hostTelemetry } : null;
  }

  onEvent(listener: (event: DesktopActivityEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): DesktopSnapshot {
    const running = Boolean(this.active && !this.active.terminal);
    const terminal = Boolean(this.active?.terminal);
    const openRouter = this.openRouterStatus();
    const inference = this.selectedInferenceProvider;
    const displayProvider = running && this.active
      ? (this.activeProvider ?? inference)
      : inference;
    const displayRouting = displayProvider === 'openrouter'
      ? 'explicit-openrouter'
      : displayProvider === 'cloud'
        ? 'explicit-cloud'
        : 'local-only';
    const modelIsAuto = inference === 'ollama' && this.operatorSelectedModel === AUTO_MODEL;
    const cloudSelection = this.selectedCloudSelection();
    const displayModel = running && this.activeModel
      ? this.activeModel
      : displayProvider === 'openrouter'
        ? (openRouter.model ?? null)
        : displayProvider === 'cloud' && cloudSelection
          ? cloudSelection.modelId
          : (this.provider?.model ?? null);
    const displayApiBase = displayProvider === 'openrouter'
      ? OPENROUTER_OFFICIAL_API_BASE
      : (this.provider?.apiBase ?? 'http://127.0.0.1:11434');
    return {
      coreState: this.coreState,
      coreDetail: this.coreDetail,
      folder: this.folder,
      model: displayModel,
      modelIsAuto,
      modelAvailable: displayProvider === 'openrouter' ? null : this.modelAvailable,
      installedModels: [...this.installedModels],
      cloud: this.getCloudState(),
      selectedInferenceProvider: inference,
      provider: displayProvider,
      routingPolicy: displayRouting,
      apiBase: displayApiBase,
      attemptId: this.active?.attemptId ?? null,
      requestId: this.active?.requestId ?? null,
      task: this.active?.goal ?? null,
      running,
      awaitingApproval: Boolean(this.pending),
      pendingApproval: this.pending?.card ?? null,
      pendingImageApproval: this.pendingImageApproval
        ? {
          approvalId: this.pendingImageApproval.approval.id,
          attemptId: this.activeImageAttemptId,
          presentation: this.pendingImageApproval.approval.presentation ?? null,
          request: {
            prompt: String(this.pendingImageApproval.arguments.prompt ?? ''),
            checkpoint: String(this.pendingImageApproval.arguments.checkpoint ?? ''),
            width: Number(this.pendingImageApproval.arguments.width ?? 0) || null,
            height: Number(this.pendingImageApproval.arguments.height ?? 0) || null,
            outputCount: Number(this.pendingImageApproval.arguments.outputCount ?? 1) || 1,
            toolName: this.pendingImageApproval.toolName ?? 'image_generate',
            seconds: Number(this.pendingImageApproval.arguments.seconds ?? 0) || null,
            fromReference: Boolean(this.pendingImageApproval.arguments.referenceArtifactId || this.pendingImageApproval.arguments.startArtifactId),
          },
        }
        : null,
      pendingWeatherApproval: this.pendingWeatherApproval
        ? { approvalId: this.pendingWeatherApproval.approval.id, attemptId: this.activeWeatherAttemptId, presentation: this.pendingWeatherApproval.approval.presentation ?? null }
        : null,
      taskScope: this.taskScope,
      coreBuild: this.coreBuild,
      workers: listWorkerOptions().map((option) => ({ ...option })),
      selectedWorker: this.selectedWorker,
      activeWorker: this.activeWorker,
      openRouter: this.openRouterStatus(),
      localSpeech: this.getLocalSpeechStatus(),
      localSpeechResponse: this.getLocalSpeechResponseStatus(),
      wakeWord: this.getWakeWordStatus(),
      wakeDiagnostics: this.getWakeDiagnostics(),
      voiceMode: this.voiceMode,
      speaking: this.speaking,
      interactionMode: this.interactionMode,
      lastTurnOutcome: this.lastTurnOutcome,
      turnOutcomeKind: this.turnOutcomeKind,
      blockedReason: this.blockedReason,
      speechInterrupt: {
        buttonStop: this.speaking,
        spokenBargeIn: false,
        spokenBargeInBlocker: this.speaking
          ? 'Spoken interruption is unavailable while microphone capture is suppressed during playback. Use Stop.'
          : '',
      },
      hostTelemetry: this.hostTelemetry,
      everydayTools: this.everydayTools,
      commandQueue: this.commandQueue,
      gmail: this.gmailStatus(),
      stagedAttachments: this.attachmentStaging.list(),
      modelNote: this.modelNote,
      selectedConversationId: this.selectedConversationId,
      activeConversationId: this.active?.conversationId ?? null,
      cockpit: this.active
        ? projectMissionCockpit(this.cockpitEvents, {
          requestId: this.active.requestId,
          attemptId: this.active.attemptId,
          running,
          terminal,
          pendingApproval: this.pending?.card ?? null,
          approvedApproval: this.approvedApproval,
          startedAt: this.missionStartedAt,
          nowMs: Date.now(),
          spendCapUsd: this.activeSpendCapUsd,
        })
        : emptyMissionCockpit(),
    };
  }

  /** Non-secret OpenRouter readiness for the snapshot. Never loads the key. */
  openRouterStatus(): DesktopOpenRouterStatus {
    const config = resolveOpenRouterConfig({
      selectedWorkspaceRoot: this.folder,
      productRoot: this.options.productRoot,
    });
    return {
      keyConfigured: openRouterApiKeyPresent(this.dataDir),
      apiBase: OPENROUTER_OFFICIAL_API_BASE,
      model: config.model,
      maxUsd: config.maxUsd,
      submissionReady: OPENROUTER_SUBMISSION_READY,
      statusDetail: OPENROUTER_SUBMISSION_READY
        ? 'OpenRouter may be selected when key, model, and USD cap are configured'
        : OPENROUTER_NOT_READY_MESSAGE,
    };
  }

  /**
   * Host-only set/replace. Key is accepted only on this path, encrypted with
   * OS-backed safeStorage, and never returned, logged, or put on the snapshot.
   */
  setOpenRouterApiKey(apiKey: string): DesktopOpenRouterKeyResult {
    const box = tryElectronSecretBox();
    if (!box) {
      throw new Error('host encrypted storage is not available; refusing to persist OpenRouter API key');
    }
    storeOpenRouterApiKey(this.dataDir, apiKey, box);
    this.emit({ kind: 'status', at: nowIso(), summary: 'OpenRouter API key stored (encrypted)' });
    return { keyConfigured: true };
  }

  clearOpenRouterApiKey(): DesktopOpenRouterKeyResult {
    clearOpenRouterApiKey(this.dataDir);
    this.emit({ kind: 'status', at: nowIso(), summary: 'OpenRouter API key cleared' });
    return { keyConfigured: false };
  }

  /** Non-secret Gmail connection status for the snapshot. Never loads a token. */
  gmailStatus(): DesktopSnapshot['gmail'] {
    const cache = this.gmailStatusCache;
    let clientSource: GoogleOAuthClientSource = null;
    let clientHint: string | null = null;
    let configBlocker: string | null = null;
    try {
      const resolved = resolveGoogleOAuthClient(this.dataDir, tryElectronSecretBox());
      clientSource = resolved.source;
      clientHint = maskGoogleClientId(resolved.config.clientId);
    } catch (err) {
      configBlocker = err instanceof Error ? err.message : String(err);
    }
    // "Connected" is only ever claimed after OAuth succeeded AND Core's live
    // Gmail probe passed against the real API for this very session — a
    // stored credential alone (e.g. right after a restart) is not verified.
    const verified = Boolean(cache.connected && cache.accountEmail && !cache.capabilityBlocker && cache.lastRefreshedAt);
    const failure = this.googleConnectError ?? cache.lastError ?? (cache.connected ? cache.capabilityBlocker : null);
    return {
      ...cache,
      configBlocker,
      connecting: this.googleConnecting,
      clientSource,
      clientHint,
      verified,
      calendarAccess: cache.scopes.includes(GOOGLE_CALENDAR_SCOPE) ? 'granted' : 'not_granted',
      inboxOrganization: cache.scopes.includes(GMAIL_MODIFY_SCOPE) ? 'granted' : 'not_granted',
      calendarBlocker: cache.calendarBlocker,
      helperStaged: this.googleHelperPath() !== null,
      recovery: classifyGoogleError(failure),
    };
  }

  /** The pinned `gws` helper Core needs for live Gmail calls: an explicit
   * `KARKEDIKHA_GWS_BIN`, else the build-time staged `runtime/gws/gws.exe`
   * next to the product. Presence only — Core verifies the pinned digest. */
  private googleHelperPath(): string | null {
    const explicit = process.env.KARKEDIKHA_GWS_BIN?.trim();
    if (explicit) return fs.existsSync(explicit) ? explicit : null;
    const staged = path.join(this.options.productRoot, 'runtime', 'gws', 'gws.exe');
    return fs.existsSync(staged) ? staged : null;
  }

  /** Stores the operator's own OAuth Desktop client (encrypted). Validation
   * errors are plain, actionable sentences shown verbatim in the UI. */
  saveGoogleOAuthClient(clientId: string, clientSecret: string): DesktopSnapshot['gmail'] {
    if (this.gmailStatusCache.connected) {
      throw new Error('Disconnect Google before changing the OAuth client — the existing sign-in belongs to the old one.');
    }
    const validated = validateGoogleOAuthClientInput(clientId, clientSecret);
    storeGoogleOAuthClient(this.dataDir, validated, tryElectronSecretBox());
    this.googleConnectError = null;
    this.emit({ kind: 'status', at: nowIso(), summary: 'Google OAuth client saved' });
    return this.gmailStatus();
  }

  /** Cancels a sign-in that is waiting on the browser (recovery for a closed tab). */
  cancelGoogleConnect(): DesktopSnapshot['gmail'] {
    this.gmailTokenManager.cancelConnect();
    return this.gmailStatus();
  }

  /** Imports the OAuth client from Google's "Download JSON" file (picked by the user in a native dialog). */
  importGoogleOAuthClientJson(text: string): DesktopSnapshot['gmail'] {
    const parsed = parseGoogleClientSecretJson(text);
    return this.saveGoogleOAuthClient(parsed.clientId, parsed.clientSecret ?? '');
  }

  async clearGoogleOAuthClient(): Promise<DesktopSnapshot['gmail']> {
    await this.disconnectGmail();
    clearStoredGoogleOAuthClient(this.dataDir);
    this.googleConnectError = null;
    this.emit({ kind: 'status', at: nowIso(), summary: 'Google OAuth client removed' });
    return this.gmailStatus();
  }

  /** Opens the system browser for Google sign-in and waits for the loopback
   * callback — see `gmailOAuth.ts`/`gmailTokenManager.ts`. Failures (missing
   * client, user cancelled, timeout, Google rejecting the client, …) are
   * recorded and returned in the status with a recovery guide rather than
   * thrown, so the UI can show exactly what to do next. */
  async connectGmail(): Promise<DesktopSnapshot['gmail']> {
    this.googleConnectError = null;
    this.googleConnecting = true;
    this.emit({ kind: 'status', at: nowIso(), summary: 'Waiting for Google sign-in in your browser…' });
    try {
      await this.gmailTokenManager.connect();
      await this.grantGmailPermissions();
    } catch (err) {
      this.googleConnectError = err instanceof Error ? err.message : String(err);
    } finally {
      this.googleConnecting = false;
    }
    return this.gmailStatus();
  }

  async disconnectGmail(): Promise<DesktopSnapshot['gmail']> {
    this.googleConnectError = null;
    await this.gmailTokenManager.disconnect();
    await this.revokeGmailPermissions();
    this.pendingGmailApproval = null;
    return this.gmailStatus();
  }

  /** Opt-in, incremental: asks Google for ONLY the gmail.modify permission so Pandesh can organize mail. Failures are
   * recorded in the status like a connect failure; the existing sign-in is never touched by a refusal. */
  async allowInboxOrganization(): Promise<DesktopSnapshot['gmail']> {
    this.googleConnectError = null;
    this.googleConnecting = true;
    this.emit({ kind: 'status', at: nowIso(), summary: 'Waiting for Google to confirm the inbox organization permission…' });
    try {
      await this.gmailTokenManager.grantInboxOrganization();
    } catch (err) {
      this.googleConnectError = err instanceof Error ? err.message : String(err);
    } finally {
      this.googleConnecting = false;
    }
    return this.gmailStatus();
  }

  /** Gmail diagnostics "Retry" — re-checks Core's live capability health
   * without touching OAuth connection state at all. */
  async retryGmailProbe(): Promise<DesktopSnapshot['gmail']> {
    await this.gmailTokenManager.retryProbe();
    return this.gmailStatus();
  }

  /** Single-user desktop app: once the operator has connected their own
   * Google account through the OAuth consent screen, all three tiers are
   * granted immediately — the human-in-the-loop control that actually
   * matters is the per-action approval card (and, for sending, the
   * draft-bound digest re-verification), not withholding this coarser gate
   * from the account's own owner. */
  private async grantGmailPermissions(): Promise<void> {
    const client = this.requireClient();
    for (const tier of ['read', 'draft', 'execute'] as const) {
      await client.setConnectorPermission('gmail', { tier, granted: true });
    }
    // Calendar rides the same sign-in; its tiers are only opened when Google
    // actually granted the Calendar scope. Each write still needs its own approval card.
    if (this.gmailStatusCache.scopes.includes(GOOGLE_CALENDAR_SCOPE)) {
      for (const tier of ['read', 'draft', 'execute'] as const) {
        await client.setConnectorPermission('google_calendar', { tier, granted: true });
      }
    }
  }

  private async revokeGmailPermissions(): Promise<void> {
    try {
      const client = this.requireClient();
      for (const tier of ['read', 'draft', 'execute'] as const) {
        await client.setConnectorPermission('gmail', { tier, granted: false });
        await client.setConnectorPermission('google_calendar', { tier, granted: false });
      }
    } catch {
      /* Core may not be reachable; local disconnect already happened */
    }
  }

  private static readonly GMAIL_UI_TOOLS = new Set(['gmail_search', 'gmail_read_thread', 'gmail_create_draft', 'gmail_send_draft']);

  /** The one entry point the Gmail UI surface uses to run any of its four
   * typed actions — bounded to exactly those tool names (defense in depth on
   * top of Core's own allowlist), always through the same governed
   * dispatch/approval path every other consequential Core action uses. */
  async dispatchGmailAction(toolName: string, args: Record<string, unknown>): Promise<DesktopGmailActionResult> {
    if (!DesktopSession.GMAIL_UI_TOOLS.has(toolName)) {
      throw new Error(`'${toolName}' is not a Gmail action this surface may call`);
    }
    const client = this.requireClient();
    const result = await client.dispatchCapability({
      correlationId: 'gmail-ui',
      toolName,
      arguments: args,
      cwd: this.folder ?? this.dataDir,
    });
    if (result.outcome === 'approval_required') {
      this.pendingGmailApproval = { toolName, arguments: args, approval: result.approval };
    }
    return toGmailActionResultView(result);
  }

  /** Resolves the one pending Gmail approval (e.g. the send-confirmation
   * card) and, on approval, re-dispatches the identical {toolName,arguments}
   * so the caller gets the executed outcome in one round trip — mirrors the
   * existing restored-approval pattern in `resolvePending` above. */
  async resolveGmailApproval(approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopGmailActionResult> {
    const held = this.pendingGmailApproval;
    if (!held || held.approval.id !== approvalId) {
      throw new Error('no matching pending Gmail approval');
    }
    this.pendingGmailApproval = null;
    const client = this.requireClient();
    await client.resolveCapabilityApproval(approvalId, {
      resolution,
      attemptId: held.approval.attemptId,
      expectedAttemptRevision: held.approval.expectedAttemptRevision,
      expectedAttemptStatus: held.approval.expectedAttemptStatus,
      requestedActionDigest: held.approval.requestedActionDigest,
      frozenContextHash: held.approval.frozenContextHash,
    });
    if (resolution === 'rejected') {
      return { outcome: 'denied', reason: 'rejected by operator' };
    }
    const result = await client.dispatchCapability({
      correlationId: 'gmail-ui',
      toolName: held.toolName,
      arguments: held.arguments,
      cwd: this.folder ?? this.dataDir,
    });
    return toGmailActionResultView(result);
  }

  /** Local-only summary of an already-fetched thread's messages, using the
   * currently selected local Ollama model. Never reaches OpenRouter — see
   * `core/runtime/gmailSummary.ts`. */
  async summarizeGmailThread(messages: Array<{ from: string; subject: string; date: string; bodyText: string }>): Promise<{ summary: string }> {
    const client = this.requireClient();
    const model = await this.resolveSummarizationModel();
    return client.summarizeGmailThread({ model, messages });
  }

  /**
   * Resolves the concrete, currently-installed local model Gmail
   * summarization should use — always against the live Ollama catalog, never
   * `resolveDesktopProviderConfig`'s synchronous best-effort label and never
   * a stale legacy editor setting. An explicit operator selection that is no
   * longer installed fails closed rather than silently substituting; Auto
   * uses Core's own chat preference chain (`core/domain/modelRouting.ts`)
   * filtered to what is actually installed.
   */
  private async resolveSummarizationModel(): Promise<string> {
    const installed = await this.refreshInstalledModels();
    const isInstalled = (name: string) => installed.includes(name) || installed.some((m) => m === name || m.startsWith(`${name}:`));
    if (this.operatorSelectedModel && this.operatorSelectedModel !== AUTO_MODEL) {
      if (!isInstalled(this.operatorSelectedModel)) {
        throw new Error(`Selected model '${this.operatorSelectedModel}' is not installed. Select an installed model.`);
      }
      return this.operatorSelectedModel;
    }
    const candidate = [AUTO_CHAT_MODEL, AUTO_RECOVERY_MODEL, AUTO_FALLBACK_MODEL].find(isInstalled);
    if (!candidate) {
      throw new Error('no installed local model is available for summarization; install an Ollama model or select one in Jarvis');
    }
    return candidate;
  }

  /**
   * Jarvis Connector Foundation host-only set/replace. Mirrors
   * `setOpenRouterApiKey`: the credential is accepted only on this path,
   * encrypted with OS-backed safeStorage, and never returned, logged, or put
   * on the renderer snapshot. Core sees only the decrypted value injected
   * into its own process env on next start (`coreExtraEnv`).
   */
  setConnectorCredential(connectorId: ConnectorId, credential: string): { configured: boolean } {
    const box = tryElectronSecretBox();
    if (!box) {
      throw new Error('host encrypted storage is not available; refusing to persist connector credential');
    }
    storeConnectorCredential(this.dataDir, connectorId, credential, box);
    this.emit({ kind: 'status', at: nowIso(), summary: `${connectorId} credential stored (encrypted)` });
    return { configured: true };
  }

  clearConnectorCredential(connectorId: ConnectorId): { configured: boolean } {
    clearConnectorCredential(this.dataDir, connectorId);
    this.emit({ kind: 'status', at: nowIso(), summary: `${connectorId} credential cleared` });
    return { configured: false };
  }

  private coreExtraEnv(): Record<string, string> {
    this.refreshProviderSoft();
    const openRouter = resolveOpenRouterConfig({
      selectedWorkspaceRoot: this.folder,
      productRoot: this.options.productRoot,
    });
    const box = tryElectronSecretBox();
    const env = buildDesktopCoreExtraEnv({
      ollamaModel: this.provider?.model || 'unset',
      ollamaApiBase: this.provider?.apiBase ?? 'http://127.0.0.1:11434',
      hostBrowserBin: resolveHostBrowserBin() ?? undefined,
      openRouterModel: openRouter.model,
      openRouterMaxUsd: openRouter.maxUsd,
      openRouterApiKey: loadOpenRouterApiKey(this.dataDir, box),
    });
    // Jarvis Connector Foundation: any stored Gmail/Google Calendar/WhatsApp/
    // Printer credential is decrypted host-side and injected into Core's
    // spawn env only — never returned, logged, or put on the renderer
    // snapshot (see apps/desktop/src/host/connectorCredentials.ts).
    Object.assign(env, buildConnectorCredentialEnv(this.dataDir, box));
    // Live Gmail calls need the pinned gws helper; use the staged copy when the
    // operator has not pointed KARKEDIKHA_GWS_BIN somewhere else.
    if (!process.env.KARKEDIKHA_GWS_BIN?.trim()) {
      const helper = this.googleHelperPath();
      if (helper) env.KARKEDIKHA_GWS_BIN = helper;
    }
    if (process.env.KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH) {
      env.KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH = process.env.KARKEDIKHA_TEST_GMAIL_FIXTURE_PATH;
    }
    env.KARKEDIKHA_HOST_TOKEN = getOrCreateHostToken(this.dataDir);
    const confirmMs = process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS?.trim();
    if (confirmMs) env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS = confirmMs;
    return env;
  }

  /**
   * Runs at most once per Desktop profile (`selected-model.json` presence is
   * the marker — see `desktopModelSelection.ts`): a fresh profile defaults to
   * Auto and persists that choice immediately, adopting a legacy
   * `.vscode`/Cursor/VS Code `ollama-agent.*` chat-model setting only when it
   * is currently installed. After this runs once, `resolveDesktopProviderConfig`
   * never reads those editor settings again — Jarvis's own persisted
   * selection is authoritative from here on, per AI_OS_STATE.md's model
   * ownership fix.
   */
  private async runLegacyModelMigrationIfNeeded(): Promise<void> {
    if (this.operatorSelectedModel !== null) return;
    const legacy = resolveLegacyModelForMigration({
      selectedWorkspaceRoot: this.folder,
      productRoot: this.options.productRoot,
    });
    let migrated: string | null = null;
    if (legacy) {
      try {
        const installed = await listInstalledOllamaModels('http://127.0.0.1:11434');
        const isInstalled = installed.includes(legacy.model)
          || installed.some((name) => name === legacy.model || name.startsWith(`${legacy.model}:`));
        if (isInstalled) migrated = legacy.model;
      } catch {
        // Ollama unreachable at startup — never guess; fall through to Auto.
      }
    }
    this.operatorSelectedModel = migrated ?? AUTO_MODEL;
    writeSelectedModel(this.dataDir, this.operatorSelectedModel);
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: migrated
        ? `Migrated legacy editor model setting '${migrated}' (from ${legacy!.source}) to Jarvis's own model selection, one time only`
        : 'No persisted model selection found; defaulting to automatic local model routing',
    });
  }

  async start(): Promise<void> {
    await this.runLegacyModelMigrationIfNeeded();
    this.refreshProviderSoft();

    const launcher = new CoreLauncher({
      corePath: this.options.corePath ?? defaultCorePath(this.options.productRoot),
      token: this.token,
      bundledCoreVersion: this.options.bundledCoreVersion ?? resolveBundledCoreVersion(this.options.productRoot),
      dataDir: this.dataDir,
      nodeExecutable: process.env.KARKEDIKHA_DESKTOP_NODE,
      extraEnv: this.coreExtraEnv(),
      log: this.options.log,
    });
    const outcome = await launcher.ensureCoreRunning();
    this.options.log?.(`Core launcher outcome: ${outcome.state}${'detail' in outcome && outcome.detail ? ` ${outcome.detail}` : ''}`);
    if (outcome.state !== 'connected') {
      this.coreState = outcome.state;
      this.coreDetail = 'detail' in outcome ? outcome.detail : undefined;
      this.emit({ kind: 'error', at: nowIso(), summary: `Core ${outcome.state}${this.coreDetail ? `: ${this.coreDetail}` : ''}` });
      return;
    }
    await this.attachCoreClient(outcome.baseUrl);
    this.coreState = 'connected';
    this.coreDetail = undefined;
    this.coreBuild = {
      instanceId: outcome.info.instanceId,
      bundleHash: outcome.info.bundleHash,
      busy: outcome.info.busy,
    };
    this.options.log?.(
      `Core connected instance=${outcome.info.instanceId} bundleHash=${outcome.info.bundleHash ?? 'unknown'} busy=${String(outcome.info.busy ?? false)}`,
    );
    // Gmail's access token lives only in this Core process's memory
    // (gmailAccessTokenStore.ts) — a fresh/restarted Core has none until
    // pushed, regardless of whether Gmail was already connected.
    void this.gmailTokenManager.onCoreReady();
    this.reminderScheduler = new EverydayReminderScheduler({
      notify: async (input) => {
        // Mark notified first so sleep/resume cannot double-deliver the same due item.
        try {
          await this.requireClient().markEverydayReminderNotified(input.id);
        } catch (err) {
          this.options.log?.(`mark notified before alert failed: ${(err as Error).message}`);
        }
        if (this.options.notifyReminder) await this.options.notifyReminder(input);
        else this.options.log?.(`reminder due (no desktop notifier): ${input.body}`);
        this.emit({
          kind: 'status',
          at: nowIso(),
          summary: `Desktop alert: ${input.body}`,
          eventType: 'everyday_reminder_alert',
          text: input.id,
        });
        await this.refreshEverydayTools();
      },
      markNotified: async () => {
        // Already marked in notify for at-most-once delivery across resume.
      },
      log: this.options.log,
    });
    await this.refreshEverydayTools();
    await this.reconcileRemindersAfterResume('startup');
    await this.refreshCommandQueue();
    await this.requireClient().reconcileCommandQueue();
    await this.refreshCommandQueue();
    this.scheduleQueueOffer();
    await this.refreshModelAvailability();
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: this.operatorSelectedModel === AUTO_MODEL
        ? 'Core connected. Automatic local model routing is selected.'
        : `Core connected. Local model ${this.provider?.model ?? 'unset'} (${this.modelAvailable ? 'installed' : 'missing'}).`,
    });
    await this.refreshInstalledModels();
    await this.refreshCloudCatalog();
    await this.restorePendingApproval(this.selectedConversationId);
    await this.restorePendingMediaApproval(this.selectedConversationId);
  }

  /**
   * Creates the Core client for a reachable Core and opens its event stream.
   *
   * Kept separate from `start()` so that "Retry" can attach to a Core that
   * was re-launched after the previous one went away, with exactly the same
   * wiring as the first connection.
   */
  private async attachCoreClient(baseUrl: string): Promise<void> {
    const client = new CoreClient({
      baseUrl,
      token: this.token,
      clientId: this.clientId,
      clientVersion: this.options.bundledCoreVersion ?? '0.1.0',
      clientType: 'desktop',
      hostToken: getOrCreateHostToken(this.dataDir),
      onStatusChange: (status) => {
        this.coreState = mapCoreState(status.state);
        this.coreDetail = status.detail;
        if (status.state === 'connected') {
          this.coreRecoveryAttempted = false;
        } else if (status.state === 'disconnected' && !this.coreRecoveryAttempted) {
          // The Core is gone and the client stopped trying on its own. Bring
          // it back once — a single, bounded attempt, never a loop. If that
          // does not work the operator gets a "Retry" button instead.
          this.coreRecoveryAttempted = true;
          this.options.log?.('core connection lost — re-launching the Core once');
          void this.retryCoreConnection();
        }
        this.emit({ kind: 'status', at: nowIso(), summary: `Core ${status.state}` });
      },
      onRuntimeEvent: (event) => void this.handleRuntimeEvent(event),
      onRuntimeToken: (frame) => this.handleToken(frame),
    });
    this.client = client;
    this.coreBaseUrl = baseUrl;
    await client.start();
  }

  /**
   * Reconnects to the local Core, on the operator's request.
   *
   * The client stops retrying on its own after a bounded number of attempts,
   * so this is the deliberate recovery action behind the "Retry" button. It
   * creates no task, calls no model and touches nothing the operator owns:
   * it re-launches a Core that is gone, or reopens the stream to one that is
   * there.
   */
  async retryCoreConnection(): Promise<DesktopSnapshot> {
    const launcher = new CoreLauncher({
      corePath: this.options.corePath ?? defaultCorePath(this.options.productRoot),
      token: this.token,
      bundledCoreVersion: this.options.bundledCoreVersion ?? resolveBundledCoreVersion(this.options.productRoot),
      dataDir: this.dataDir,
      nodeExecutable: process.env.KARKEDIKHA_DESKTOP_NODE,
      extraEnv: this.coreExtraEnv(),
      log: this.options.log,
    });
    const outcome = await launcher.ensureCoreRunning();
    this.options.log?.(`Core launcher outcome on retry: ${outcome.state}${'detail' in outcome && outcome.detail ? ` ${outcome.detail}` : ''}`);
    if (outcome.state !== 'connected') {
      this.coreState = outcome.state;
      this.coreDetail = 'detail' in outcome ? outcome.detail : undefined;
      this.emit({ kind: 'error', at: nowIso(), summary: `Core ${outcome.state}` });
      return this.snapshot();
    }
    if (this.client && this.coreBaseUrl === outcome.baseUrl) {
      // The same Core is still there: reopen the stream.
      this.client.retryConnection();
      return this.snapshot();
    }
    // A different Core: attach to it. The old client is disposed first, so
    // it cannot keep reconnecting to a port that no longer answers.
    this.client?.dispose();
    await this.attachCoreClient(outcome.baseUrl);
    this.coreState = 'connected';
    this.coreDetail = undefined;
    this.coreBuild = {
      instanceId: outcome.info.instanceId,
      bundleHash: outcome.info.bundleHash,
      busy: outcome.info.busy,
    };
    // A fresh Core has an empty in-memory access-token slot, so the stored
    // Google token has to be pushed again — otherwise mail and calendar would
    // silently stop working after a Core restart.
    void this.gmailTokenManager.onCoreReady();
    this.emit({ kind: 'status', at: nowIso(), summary: 'Core reconnected.' });
    return this.snapshot();
  }

  clearFolder(): DesktopSnapshot {
    this.folder = null;
    this.taskScope = null;
    const file = path.join(this.dataDir, 'last-workspace.txt');
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch {}
    this.refreshProviderSoft();
    void this.refreshModelAvailability();
    void this.refreshInstalledModels();
    this.emit({ kind: 'status', at: nowIso(), summary: 'No workspace selected.' });
    return this.snapshot();
  }

  setFolder(folder: string): DesktopSnapshot {
    if (!folder || !folder.trim()) {
      return this.clearFolder();
    }
    const resolved = path.resolve(folder.trim());
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new Error(`folder does not exist: ${resolved}`);
    }
    this.folder = resolved;
    this.taskScope = describeDesktopTaskScope(resolved);
    writeLastWorkspace(this.dataDir, resolved);
    this.refreshProviderSoft();
    void this.refreshModelAvailability();
    void this.refreshInstalledModels();
    this.emit({ kind: 'status', at: nowIso(), summary: `Repository ${resolved}` });
    return this.snapshot();
  }

  restoreLastFolder(): DesktopSnapshot | null {
    if (this.folder) return this.snapshot();
    const previous = readLastWorkspace(this.dataDir);
    if (!previous) return null;
    try {
      return this.setFolder(previous);
    } catch (err) {
      this.options.log?.(`last workspace unavailable: ${(err as Error).message}`);
      return null;
    }
  }

  async restoreActiveTask(): Promise<DesktopSnapshot> {
    if (!this.folder) this.restoreLastFolder();
    if (!this.folder || (this.active && !this.active.terminal)) return this.snapshot();
    const client = this.requireClient();
    const rehydration = await client.getWorkspaceAttemptRehydration(this.folder);
    const record = rehydration.attempts[0];
    if (!record || record.recovery === 'terminal' || record.recovery === 'requires_reconciliation') {
      return this.snapshot();
    }
    const conversationId = record.request.conversationId;
    if (!conversationId) return this.snapshot();
    this.taskScope = authorizeDesktopTaskScope(describeDesktopTaskScope(this.folder)!);
    this.active = {
      attemptId: record.attempt.id,
      requestId: record.request.id,
      conversationId,
      goal: record.context.taskInput || record.request.currentMessage,
      tokenBuffer: '',
      terminal: false,
    };
    this.cockpitEvents = [];
    this.approvedApproval = null;
    this.missionStartedAt = record.attempt.startedAt ?? record.attempt.createdAt;
    this.recordEvidence({
      type: 'restored',
      requestId: record.request.id,
      attemptId: record.attempt.id,
      status: record.attempt.status,
      recovery: record.recovery,
      folder: this.folder,
    });
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: record.attempt.id,
      requestId: record.request.id,
      summary: `Restored ${record.attempt.id} (${record.attempt.status})`,
    });
    if (record.attempt.status === 'waiting_for_approval' || record.recovery === 'awaiting_human_approval') {
      await this.loadPendingApproval();
    }
    return this.snapshot();
  }

  /** Selects the worker for the next submission. Fails closed on a gated one. */
  selectWorker(workerId: string): DesktopSnapshot {
    const resolved = resolveWorkerProfile(workerId);
    if (!resolved.ok) throw new Error(resolved.reason);
    this.selectedWorker = workerId;
    return this.snapshot();
  }

  selectProvider(provider: 'ollama' | 'openrouter'): DesktopSnapshot {
    if (provider !== 'ollama' && provider !== 'openrouter') {
      throw new Error(`unsupported inference provider '${provider}'`);
    }
    if (provider === 'openrouter') {
      if (!OPENROUTER_SUBMISSION_READY) {
        throw new Error(OPENROUTER_NOT_READY_MESSAGE);
      }
      if (isLocalCoreWorker(this.selectedWorker)) {
        throw new Error('OpenRouter is not available for local read-only Core questions');
      }
    }
    if (this.selectedInferenceProvider === 'cloud') saveCloudSettings(this.dataDir, { selectedModel: null });
    this.selectedInferenceProvider = provider;
    return this.snapshot();
  }

  async refreshInstalledModels(): Promise<string[]> {
    this.refreshProviderSoft();
    const apiBase = this.provider?.apiBase ?? 'http://127.0.0.1:11434';
    try {
      this.installedModels = await listInstalledOllamaModels(apiBase);
      if (!this.operatorSelectedModel && this.installedModels.length === 1) {
        this.operatorSelectedModel = this.installedModels[0];
        writeSelectedModel(this.dataDir, this.operatorSelectedModel);
      }
    } catch (err) {
      this.installedModels = [];
      this.coreDetail = (err as Error).message;
      this.emit({ kind: 'error', at: nowIso(), summary: (err as Error).message });
    }
    return [...this.installedModels];
  }

  async selectModel(model: string): Promise<DesktopSnapshot> {
    const name = model.trim();
    if (!name) throw new Error('model name is required');
    // The one conversation dropdown carries local, Auto and free cloud models.
    if (name.includes('::')) return this.selectCloudModel(name);
    if (this.selectedInferenceProvider === 'cloud') {
      saveCloudSettings(this.dataDir, { selectedModel: null });
      this.selectedInferenceProvider = 'ollama';
    }
    if (name !== AUTO_MODEL) await this.refreshInstalledModels();
    if (name !== AUTO_MODEL && this.installedModels.length > 0 && !this.installedModels.includes(name)
      && !this.installedModels.some((installed) => installed === name || installed.startsWith(`${name}:`))) {
      throw new Error(`model '${name}' is not installed in Ollama`);
    }
    const previousModel = this.operatorSelectedModel;
    this.operatorSelectedModel = name;
    writeSelectedModel(this.dataDir, name);
    if (name === AUTO_MODEL) {
      this.refreshProviderSoft();
      this.modelAvailable = null;
    } else {
      this.refreshProvider();
      await this.refreshModelAvailability();
    }
    this.emit({ kind: 'status', at: nowIso(), summary: name === AUTO_MODEL ? 'Selected automatic local model routing' : `Selected local model ${name}` });

    // Persist model switch event into active conversation history if switched
    if (previousModel && previousModel !== name) {
      const convId = this.selectedConversationId ?? this.voiceConversationId;
      if (convId) {
        try {
          const client = this.client;
          if (client) {
            await client.appendMessage(convId, {
              role: 'system',
              content: JSON.stringify({
                type: 'model_switch',
                fromModel: previousModel,
                toModel: name,
                timestamp: nowIso(),
              }),
            });
          }
        } catch (err: any) {
          this.options.log?.(`[desktopSession] Failed to persist model switch event: ${err?.message}`);
        }
      }
    }

    return this.snapshot();
  }

  // ── Free cloud providers ────────────────────────────────────────────────────────────────
  // Cloud is off by default. Keys are encrypted with safeStorage and handed to Core once per
  // launch; nothing is sent until the operator selects a verified-free model and approves the
  // exact public text of a message.

  private cloudBox() {
    return tryElectronSecretBox();
  }

  private selectedCloudSelection(): { providerId: string; modelId: string } | null {
    const selected = loadCloudSettings(this.dataDir).selectedModel;
    if (!selected) return null;
    const index = selected.indexOf('::');
    if (index <= 0) return null;
    return { providerId: selected.slice(0, index), modelId: selected.slice(index + 2) };
  }

  /** Best-effort: Core holds credentials in memory only, so a restarted Core needs them again. */
  private async pushCloudCredentials(): Promise<void> {
    const client = this.client;
    if (!client) return;
    const settings = loadCloudSettings(this.dataDir);
    const catalog = this.cloudCatalogCache;
    for (const providerId of settings.enabledProviders) {
      const apiKey = loadCloudProviderKey(this.dataDir, providerId, this.cloudBox());
      if (!apiKey) continue;
      const baseUrl = settings.baseUrls[providerId] ?? catalog?.providers.find((p) => p.id === providerId)?.baseUrl;
      if (!baseUrl) continue;
      try {
        await client.setProviderCredential(providerId, baseUrl, apiKey);
      } catch (error) {
        this.options.log?.(`cloud key push failed for ${providerId}: ${(error as Error).message}`);
      }
    }
  }

  /** Reads the catalog Core ships. Cached for the session; a failure leaves the last good copy. */
  async refreshCloudCatalog(): Promise<DesktopCloudState> {
    try {
      const catalog = await this.requireClient().request<DesktopCloudCatalog>('/v1/cloud/catalog');
      this.cloudCatalogCache = catalog;
      await this.pushCloudCredentials();
    } catch (error) {
      this.options.log?.(`cloud catalog unavailable: ${(error as Error).message}`);
    }
    return this.getCloudState();
  }

  getCloudState(): DesktopCloudState {
    const settings = loadCloudSettings(this.dataDir);
    const box = this.cloudBox();
    const catalog = this.cloudCatalogCache;
    const providers: DesktopCloudProviderView[] = (catalog?.providers ?? []).map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
      configured: Boolean(cloudProviderKeyHint(this.dataDir, provider.id, box)),
      keyHint: cloudProviderKeyHint(this.dataDir, provider.id, box),
      enabled: settings.enabledProviders.includes(provider.id),
      requiresBaseUrlInput: provider.requiresBaseUrlInput,
      baseUrl: settings.baseUrls[provider.id] ?? null,
      freeTier: provider.freeTier,
      paymentMethodRequired: provider.paymentMethodRequired,
      signupUrl: provider.signupUrl,
      apiKeysUrl: provider.apiKeysUrl,
      docsUrl: provider.docsUrl,
      lastVerifiedAt: provider.lastVerifiedAt,
      privacyWarning: provider.privacyWarning,
    }));
    return {
      off: isCloudOff(settings),
      catalogVersion: catalog?.catalogVersion ?? '',
      enabledProviders: settings.enabledProviders,
      selectedModel: settings.selectedModel,
      localFallback: settings.localFallback,
      providers,
      listings: Object.fromEntries(this.cloudListings),
      tests: Object.fromEntries(this.cloudTests),
    };
  }

  /** Stores a key encrypted, enables the provider and pushes it to Core. Returns the new state. */
  async saveCloudProviderKey(providerId: string, apiKey: string, baseUrl?: string): Promise<DesktopCloudState> {
    if (!this.cloudCatalogCache) await this.refreshCloudCatalog();
    const provider = this.cloudCatalogCache?.providers.find((entry) => entry.id === providerId);
    if (!provider) throw new Error(`${providerId} is not a known provider in the catalog`);
    const trimmedUrl = (baseUrl ?? '').trim().replace(/\/$/, '');
    if (provider.requiresBaseUrlInput && !trimmedUrl) throw new Error(`${provider.displayName} needs its endpoint with your account id filled in`);
    storeCloudProviderKey(this.dataDir, providerId, apiKey, this.cloudBox() ?? (() => { throw new Error('host encrypted storage is not available'); })());
    const settings = loadCloudSettings(this.dataDir);
    saveCloudSettings(this.dataDir, {
      enabledProviders: [...new Set([...settings.enabledProviders, providerId])],
      ...(trimmedUrl ? { baseUrls: { ...settings.baseUrls, [providerId]: trimmedUrl } } : {}),
    });
    await this.pushCloudCredentials();
    // A new key invalidates what was discovered with the old one.
    this.cloudListings.delete(providerId);
    this.cloudTests.delete(providerId);
    this.emit({ kind: 'status', at: nowIso(), summary: `Saved ${provider.displayName} key; cloud models are now discoverable` });
    return this.getCloudState();
  }

  async clearCloudProviderKey(providerId: string): Promise<DesktopCloudState> {
    clearCloudProviderKey(this.dataDir, providerId);
    const settings = loadCloudSettings(this.dataDir);
    const selected = settings.selectedModel?.startsWith(`${providerId}::`) ? null : settings.selectedModel;
    if (selected === null && this.selectedInferenceProvider === 'cloud') this.selectedInferenceProvider = 'ollama';
    saveCloudSettings(this.dataDir, {
      enabledProviders: settings.enabledProviders.filter((id) => id !== providerId),
      selectedModel: selected,
    });
    this.cloudListings.delete(providerId);
    this.cloudTests.delete(providerId);
    try { await this.requireClient().clearProviderCredential(providerId); } catch { /* Core may be down; the key is gone from disk either way. */ }
    return this.getCloudState();
  }

  async setCloudProviderEnabled(providerId: string, enabled: boolean): Promise<DesktopCloudState> {
    const settings = loadCloudSettings(this.dataDir);
    saveCloudSettings(this.dataDir, {
      enabledProviders: enabled
        ? [...new Set([...settings.enabledProviders, providerId])]
        : settings.enabledProviders.filter((id) => id !== providerId),
    });
    if (enabled) await this.pushCloudCredentials();
    return this.getCloudState();
  }

  /** Real model discovery. Only free, generative models are returned by Core. */
  async discoverCloudModels(providerId: string): Promise<DesktopCloudState> {
    const client = this.requireClient();
    const key = loadCloudProviderKey(this.dataDir, providerId, this.cloudBox());
    if (!key) throw new Error('Add an API key for this provider first.');
    const settings = loadCloudSettings(this.dataDir);
    const baseUrl = settings.baseUrls[providerId] ?? this.cloudCatalogCache?.providers.find((p) => p.id === providerId)?.baseUrl;
    if (!baseUrl) throw new Error('No endpoint is known for this provider.');
    await client.setProviderCredential(providerId, baseUrl, key);
    const listing = await client.request<DesktopCloudModelListing>(`/v1/cloud/providers/${encodeURIComponent(providerId)}/models`, { method: 'POST', body: {} });
    this.cloudListings.set(providerId, listing);
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: listing.ok
        ? `${providerId}: ${listing.pool.length} free model${listing.pool.length === 1 ? '' : 's'} found in ${listing.latencyMs} ms`
        : `${providerId} model discovery failed: ${listing.error ?? listing.errorClass ?? 'unknown error'}`,
    });
    return this.getCloudState();
  }

  /** Sends one fixed public test prompt to a model already verified free. */
  async testCloudProvider(providerId: string, model: string): Promise<DesktopCloudState> {
    const client = this.requireClient();
    const body = await client.request<{ ok: boolean; listing: DesktopCloudModelListing; test: DesktopCloudConnectionTest | null }>(
      `/v1/cloud/providers/${encodeURIComponent(providerId)}/test`,
      { method: 'POST', body: { model } },
    );
    this.cloudListings.set(providerId, body.listing);
    if (body.test) this.cloudTests.set(providerId, body.test);
    return this.getCloudState();
  }

  /**
   * Selects the free cloud model the conversation dropdown will offer, or null to go back to
   * local. Selecting does not turn cloud on for private content: every send still needs the
   * operator's approval of its exact public text.
   */
  selectCloudModel(encoded: string | null): DesktopSnapshot {
    if (encoded === null) {
      saveCloudSettings(this.dataDir, { selectedModel: null });
      if (this.selectedInferenceProvider === 'cloud') this.selectedInferenceProvider = 'ollama';
      return this.snapshot();
    }
    const index = encoded.indexOf('::');
    if (index <= 0) throw new Error('cloud model selection must be <provider>::<model>');
    const providerId = encoded.slice(0, index);
    const modelId = encoded.slice(index + 2);
    if (!modelId.trim()) throw new Error('model name is required');
    const settings = loadCloudSettings(this.dataDir);
    if (!settings.enabledProviders.includes(providerId)) throw new Error('enable that provider first');
    // After a restart the discovered pool is gone; Core re-checks freeness on the real call.
    if (!this.cloudListings.get(providerId) && this.cloudBox()) {
      void this.discoverCloudModels(providerId).catch(() => undefined);
    }
    saveCloudSettings(this.dataDir, { selectedModel: encoded });
    this.selectedInferenceProvider = 'cloud';
    this.emit({ kind: 'status', at: nowIso(), summary: `Cloud model selected: ${providerId} ${modelId} (public text only)` });
    return this.snapshot();
  }

  setCloudLocalFallback(enabled: boolean): DesktopSnapshot {
    saveCloudSettings(this.dataDir, { localFallback: Boolean(enabled) });
    return this.snapshot();
  }

  /** The exact two messages a cloud send would carry, for the approval card. */
  previewCloudPublicText(text: string): DesktopCloudPublicTextPreview {
    const selection = this.selectedCloudSelection();
    if (!selection) throw new Error('no cloud model is selected');
    const provider = this.cloudCatalogCache?.providers.find((entry) => entry.id === selection.providerId);
    const trimmed = text.trim();
    const pool = this.cloudListings.get(selection.providerId)?.pool ?? [];
    const eligibleModel = pool.some((entry) => entry.id === selection.modelId);
    // The same fail-closed gate Core applies, so a refusal is shown before anything is approved or sent.
    const gate = decideCloudPublicText({
      approved: true,
      freeness: eligibleModel ? 'free' : 'unknown',
      toolCount: 0,
      attachmentCount: this.attachmentStaging.list().length,
      workspaceContext: false,
      memoryContext: false,
      autonomousContext: false,
      historyTurns: 0,
      text: trimmed,
    });
    const reason = gate.allowed
      ? undefined
      : gate.code === 'not_verified_free'
        ? 'This model is not in the verified free pool.'
        : gate.reason.replace(/\s*Nothing was sent to the cloud\.$/, '');
    return {
      providerId: selection.providerId,
      model: selection.modelId,
      providerName: provider?.displayName ?? selection.providerId,
      systemPrompt: CLOUD_PUBLIC_TEXT_SYSTEM_PROMPT,
      text: trimmed,
      eligible: !reason,
      reason,
    };
  }

  /** Records the operator's approval of this exact text. The next cloud send must match it. */
  approveCloudPublicText(text: string): void {
    this.cloudApprovedText = text.trim();
  }

  /**
   * One approved public text to a verified-free cloud model. It carries no workspace, no
   * attachments, no tools and no history; the renderer showed the exact two messages first.
   */
  private async submitCloudPublicText(text: string, clientOrigin: 'desktop' | 'mobile'): Promise<{ requestId: string; attemptId: string; model: string }> {
    const selection = this.selectedCloudSelection();
    if (!selection) throw new Error('Choose a verified free cloud model first.');
    const preview = this.previewCloudPublicText(text);
    if (!preview.eligible) throw new Error(preview.reason ?? 'This text cannot be sent to a cloud model.');
    if (this.cloudApprovedText !== text.trim()) throw new Error('Cloud inference needs your explicit approval of this exact text.');
    // Approval is single-use: it covers this send and nothing later in the conversation.
    this.cloudApprovedText = null;
    if (this.attachmentStaging.list().length > 0) {
      throw new Error('Files cannot be sent to a cloud model. Remove the attachments or switch to a local model.');
    }
    await this.pushCloudCredentials();
    const client = this.requireClient();
    let conversationId = this.selectedConversationId ?? this.voiceConversationId;
    if (!conversationId) {
      const conversation = await client.createConversation({ mode: 'baat_kar', title: text.slice(0, 80) });
      conversationId = conversation.id;
    }
    this.voiceConversationId = conversationId;
    this.selectedConversationId = conversationId;
    writeSelectedConversation(this.dataDir, conversationId);
    const submission = await client.submit({
      currentMessage: text,
      requestedMode: 'baat_kar',
      conversationId,
      requestedProvider: selection.providerId,
      requestedModel: selection.modelId,
      workspaceRoot: null,
      hasWorkspace: false,
      gitCapable: false,
      modelSelection: {
        requiredCapabilities: {
          readOnlyExplanation: true,
          repositoryExploration: false,
          toolCalling: false,
          fileModification: false,
          codingComplexity: 'low',
          contextRequirement: 'small',
          vision: false,
          validationAndRepair: false,
        },
        selectedProvider: selection.providerId,
        selectedModel: selection.modelId,
        routingPolicy: 'explicit-cloud',
        selectionReason: 'Operator selected a verified free cloud model for one approved public text',
        suitabilitySummary: `Using ${preview.providerName} ${selection.modelId}; free only, public text only, no tools, no history, no fallback.`,
        userOverrode: true,
        candidates: [{ provider: selection.providerId, model: selection.modelId, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
        escalationCandidates: [],
        cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' },
        cloudPublicTextApproved: true,
      },
    });
    this.active = {
      attemptId: submission.attempt.id,
      requestId: submission.request.id,
      conversationId,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      voiceTurnId: undefined,
      firstTokenLogged: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.approvedApproval = null;
    this.activeWorker = 'cloud';
    this.activeProvider = 'cloud';
    this.activeModel = selection.modelId;
    this.activeContextEnvelope = null;
    this.activeSpendCapUsd = null;
    this.missionStartedAt = nowIso();
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: submission.attempt.id,
      requestId: submission.request.id,
      summary: `Sending approved public text to ${preview.providerName} ${selection.modelId} (no tools, no history)`,
    });
    // Without this the attempt stays "created" forever and nothing is ever sent.
    await client.executeAttempt(submission.attempt.id, {});
    return { requestId: submission.request.id, attemptId: submission.attempt.id, model: selection.modelId };
  }

  // ── Composer attachments (staged here, uploaded to Core only when a message is sent) ──
  listStagedAttachments(): StagedAttachmentView[] {
    return this.attachmentStaging.list();
  }

  stageAttachmentFile(sourcePath: string): StagedAttachmentView {
    return this.attachmentStaging.stageFile(sourcePath);
  }

  stageAttachmentBytes(name: string, bytes: Uint8Array): StagedAttachmentView {
    return this.attachmentStaging.stageBytes(name, bytes);
  }

  removeStagedAttachment(id: string): void {
    this.attachmentStaging.remove(id);
  }

  async submitTask(
    goal: string,
    workerId?: string,
    voiceTurnId?: string,
    clientOrigin: 'desktop' | 'mobile' = 'desktop',
    preStaged?: StagedForSend[],
  ): Promise<{ requestId: string; attemptId: string; model: string }> {
    const text = goal.trim();
    if (!text) throw new Error('task text is required');
    const staged = preStaged ?? this.attachmentStaging.take();

    if (this.active && !this.active.terminal) {
      return new Promise((resolve, reject) => {
        this.submissionQueue.push({
          goal: text,
          workerId,
          voiceTurnId,
          staged,
          clientOrigin,
          resolve,
          reject,
        });
        this.emit({
          kind: 'status',
          at: nowIso(),
          summary: `Request queued: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`,
          clientOrigin,
        });
      });
    }

    try {
      return await this.submitTaskCore(text, workerId, voiceTurnId, clientOrigin, staged);
    } catch (err) {
      // Nothing was sent: the person's files go back to the composer instead of being lost.
      this.attachmentStaging.restore(staged);
      throw err;
    }
  }

  private async submitTaskCore(
    text: string,
    workerId: string | undefined,
    voiceTurnId: string | undefined,
    clientOrigin: 'desktop' | 'mobile',
    staged: StagedForSend[],
  ): Promise<{ requestId: string; attemptId: string; model: string }> {
    this.modelNote = null;
    // Attachments change what the message means: skip the keyword shortcuts (reminders, weather) that would drop them.
    const everyday = staged.length === 0 ? parseEverydayIntent(text) : null;
    if (everyday) {
      if (everyday.kind === 'daily_brief') {
        return this.handleAssistantBriefIntent(text, clientOrigin);
      }
      return this.handleEverydayIntent(text, everyday, clientOrigin);
    }
    const media = await this.planMediaRequest(text, staged);
    if (media) {
      const result = await this.handleImageGenerationIntent(text, clientOrigin, media);
      if (media.attachedImage) this.attachmentStaging.release(staged);
      return result;
    }
    if (staged.length === 0 && detectWeatherIntent(text)) {
      return this.handleWeatherIntent(text, clientOrigin);
    }
    if (this.awaitingWeatherLocation) {
      const bareLocation = extractBareLocationAnswer(text);
      if (bareLocation) {
        return this.handleWeatherIntent(`weather in ${bareLocation}`, clientOrigin);
      }
      // Not a plausible location answer — a real new request instead;
      // let it fall through normally rather than misrouting it.
      this.awaitingWeatherLocation = false;
    }
    const worker = (workerId ?? this.selectedWorker).trim();
    // Fail closed here, not in the renderer: a gated external worker cannot
    // be submitted even if the picker is bypassed.
    const resolvedWorker = resolveWorkerProfile(worker);
    if (!resolvedWorker.ok) throw new Error(resolvedWorker.reason);
    this.selectedWorker = worker;
    // A cloud model never runs a worker, opens a workspace or reads history: one approved public text.
    if (this.selectedInferenceProvider === 'cloud') {
      return this.submitCloudPublicText(text, clientOrigin);
    }
    const hasFolder = Boolean(this.folder);
    const client = this.requireClient();
    const useOpenRouter = this.selectedInferenceProvider === 'openrouter';
    const isAutoModel = !useOpenRouter && this.operatorSelectedModel === AUTO_MODEL;
    if (isAutoModel) this.refreshProviderSoft();
    else this.refreshProvider();
    if (useOpenRouter) {
      if (!OPENROUTER_SUBMISSION_READY) {
        throw new Error(OPENROUTER_NOT_READY_MESSAGE);
      }
      if (isLocalCoreWorker(worker)) {
        throw new Error('OpenRouter is not available for local read-only Core questions');
      }
    }
    let openRouterSelection: ReturnType<typeof requireOpenRouterSelection> | undefined;
    if (useOpenRouter) {
      if (!this.folder) throw new Error('select a repository before using OpenRouter');
      const config = resolveOpenRouterConfig({
        selectedWorkspaceRoot: this.folder,
        productRoot: this.options.productRoot,
      });
      openRouterSelection = requireOpenRouterSelection(config, openRouterApiKeyPresent(this.dataDir));
    } else if (isAutoModel) {
      await this.refreshInstalledModels();
      if (this.installedModels.length === 0) {
        throw new Error('No models found in Ollama. Install a model (e.g. ollama pull gemma4:12b) before submitting.');
      }
    } else {
      await this.refreshModelAvailability();
      if (this.modelAvailable !== true) {
        throw new Error(`configured local model '${this.provider!.model}' is not installed in Ollama`);
      }
    }

    if (hasFolder) {
      const scope = describeDesktopTaskScope(this.folder!);
      if (!scope) throw new Error('select a repository before submitting');
      this.taskScope = authorizeDesktopTaskScope(scope);
    } else {
      this.taskScope = null;
    }

    const workerOption = findWorkerOption(worker)!;
    const plan = planDesktopInteraction({ hasFolder, workerId: worker, goalText: text });
    if (plan.blockReason) {
      if (plan.needsWorkspace) {
        // Truthful, non-throwing outcome the conversation pane can render
        // with a Select-folder action — never a silent downgrade to chat.
        this.turnOutcomeKind = 'blocked_needs_workspace';
        this.blockedReason = plan.blockReason;
        this.emit({ kind: 'status', at: nowIso(), summary: plan.blockReason });
      }
      throw new Error(plan.blockReason);
    }
    this.interactionMode = plan.mode;
    this.lastTurnOutcome = null;
    this.turnOutcomeKind = null;
    this.blockedReason = null;
    const chatWithoutRepo = plan.mode === 'chat';
    const requestedMode = plan.requestedMode;
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: chatWithoutRepo
        ? 'Conversation without repository (chat)'
        : workerOption.mode === 'read_only'
          ? `Selected ${workerOption.label}`
          : `Authorized task scope for ${this.taskScope!.repository}; delivery ${this.taskScope!.deliveryDestination}`,
    });

    let conversationId = this.selectedConversationId ?? this.voiceConversationId;
    if (!conversationId) {
      const conversation = await client.createConversation({
        mode: requestedMode,
        title: text.slice(0, 80),
      });
      conversationId = conversation.id;
    }
    // Continuing an opened conversation must keep using the same Core
    // conversation ID; submitting from the default (never-opened) state
    // keeps that ID as both the active and selected conversation going forward.
    this.voiceConversationId = conversationId;
    this.selectedConversationId = conversationId;
    writeSelectedConversation(this.dataDir, conversationId);
    let model = useOpenRouter ? openRouterSelection!.model : isAutoModel ? AUTO_MODEL : this.provider!.model;
    const selectedProvider = useOpenRouter ? 'openrouter' : 'ollama';

    // Attachments: pick a model that can see images when needed, then hand every file to Core's
    // upload pipeline (bounded streaming, byte-sniffed kind, frozen hash, local document extraction).
    let visionChoice: ReturnType<typeof chooseVisionModel> = null;
    if (staged.some((item) => item.kind === 'image')) {
      if (useOpenRouter) throw new Error('Images are only read by local models. Switch off OpenRouter to send this image.');
      const visionModels = await fetchOllamaVisionModels(this.provider?.apiBase ?? 'http://127.0.0.1:11434', [...this.installedModels]);
      visionChoice = chooseVisionModel({ selectedModel: isAutoModel ? '' : model, isAuto: isAutoModel, visionModels });
      if (!visionChoice) {
        throw new Error('None of your installed models can see images. Install a vision model (for example: ollama pull gemma4:12b) and try again.');
      }
      model = visionChoice.model;
      // Only explain a choice the person did not make themselves.
      this.modelNote = visionChoice.differsFromSelection || isAutoModel ? visionChoice.reason : null;
    }
    const attachmentIds: string[] = [];
    for (const item of staged) {
      let stream: fs.ReadStream | null = null;
      try {
        const record = await client.createAttachment(conversationId, { originalName: item.name, declaredMimeType: item.mimeType, kind: item.kind, byteSize: item.byteSize });
        stream = fs.createReadStream(item.filePath);
        // The upload attaches its own listener; this one only keeps a late error from a destroyed stream from crashing the host.
        stream.on('error', () => undefined);
        const uploaded = await client.uploadAttachmentBytes(record.id, stream, item.byteSize);
        if (uploaded.status !== 'ready') throw new Error(uploaded.errorMessageRedacted ?? 'Core did not accept the file');
        attachmentIds.push(uploaded.id);
      } catch (err) {
        throw new Error(`Could not attach "${item.name}": ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        // An early failure must not leave a half-open handle that errors later when the staged file is removed.
        stream?.destroy();
      }
    }
    const visionEvidence = visionChoice
      ? visionSelectionEvidence({ mode: requestedMode, model, reason: visionChoice.reason, userOverrode: visionChoice.differsFromSelection || !isAutoModel })
      : null;
    const submission = await client.submit({
      currentMessage: text,
      requestedMode,
      conversationId,
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(isAutoModel && !visionChoice
        ? { autoSelectModel: true }
        : { requestedProvider: selectedProvider, requestedModel: model }),
      workspaceRoot: this.folder ?? undefined,
      hasWorkspace: hasFolder,
      gitCapable: hasFolder ? fs.existsSync(path.join(this.folder!, '.git')) : false,
      ...(chatWithoutRepo && worker !== 'hermes'
        ? {}
        : {
            toolPermissionPolicy: {
              profile: resolvedWorker.profile,
              worker,
            },
          }),
      ...(visionEvidence ? { modelSelection: visionEvidence } : {}),
      ...(!isAutoModel && !visionEvidence ? { modelSelection: {
        requiredCapabilities: {
          readOnlyExplanation: true,
          repositoryExploration: hasFolder,
          toolCalling: hasFolder,
          fileModification: hasFolder && workerOption.mode === 'mutation',
          codingComplexity: 'low',
          contextRequirement: hasFolder ? 'medium' : 'small',
          vision: false,
          validationAndRepair: true,
          ...(worker === 'hermes' ? { engine: 'hermes', specialist: true } : {}),
        },
        selectedProvider,
        selectedModel: model,
        routingPolicy: useOpenRouter ? 'explicit-openrouter' : 'local-only',
        ...(useOpenRouter ? { spendCapUsd: openRouterSelection!.maxUsd } : {}),
        selectionReason: useOpenRouter
          ? 'Operator explicitly selected OpenRouter for this submit'
          : `Configured local Ollama chat model from ${this.provider!.source}`,
        suitabilitySummary: useOpenRouter
          ? `Using OpenRouter ${model} with a $${openRouterSelection!.maxUsd} cap. No fallback.`
          : `Using local ${model}. Cloud fallback is disabled.`,
        userOverrode: Boolean(useOpenRouter),
        candidates: [{
          provider: selectedProvider,
          model,
          available: true,
          capable: true,
          costRank: 1,
          rejectionReasons: [],
        }],
        escalationCandidates: [],
      }} : {}),
    });

    this.active = {
      attemptId: submission.attempt.id,
      requestId: submission.request.id,
      conversationId,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      voiceTurnId,
      firstTokenLogged: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.approvedApproval = null;
    this.activeWorker = worker;
    this.activeProvider = selectedProvider;
    // The `model_selection_decided` runtime event is broadcast by Core before
    // the /v1/submit HTTP response is sent, so it can reach this session's
    // WebSocket listener before `this.active` above is assigned and be
    // dropped by the attempt-scoping guard in handleRuntimeEvent. Read the
    // actually-routed model directly off the submit response instead of
    // depending on that event to arrive after the fact.
    // Core accepted the message together with its files: the staged copies are no longer needed.
    this.attachmentStaging.release(staged);
    this.activeModel = isAutoModel && !visionChoice ? (submission.modelSelection?.selectedModel ?? null) : model;
    this.activeContextEnvelope = typeof submission.modelSelection?.contextWindowTokens === 'number' ? submission.modelSelection.contextWindowTokens : null;
    this.activeSpendCapUsd = useOpenRouter ? openRouterSelection!.maxUsd : null;
    this.missionStartedAt = nowIso();
    if (voiceTurnId) {
      // Correlates the renderer's per-turn voice telemetry with Core's own
      // requestId/attemptId (which already show up on the event stream) —
      // log them together here rather than inventing a second durable id.
      this.options.log?.(
        `[voice] turn=${voiceTurnId} stage=transcript_submitted requestId=${submission.request.id} attemptId=${submission.attempt.id}`,
      );
    }
    this.recordEvidence({
      type: 'submit',
      worker,
      profile: resolvedWorker.profile,
      requestId: submission.request.id,
      attemptId: submission.attempt.id,
      model,
      folder: this.folder,
      goal: text,
    });
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: submission.attempt.id,
      requestId: submission.request.id,
      summary: `Submitted ${submission.attempt.id} on ${model}`,
    });
    if (voiceTurnId) {
      this.options.log?.(
        `[voice] turn=${voiceTurnId} stage=execute_dispatched requestId=${submission.request.id} attemptId=${submission.attempt.id}`,
      );
    }
    await client.executeAttempt(submission.attempt.id, {
      workingDirectory: this.folder ?? undefined,
    });
    if (voiceTurnId) {
      this.options.log?.(
        `[voice] turn=${voiceTurnId} stage=execute_acked requestId=${submission.request.id} attemptId=${submission.attempt.id}`,
      );
    }
    return { requestId: submission.request.id, attemptId: submission.attempt.id, model };
  }

  async continueFailedTask(
    predecessorAttemptId: string,
    guidance: string,
  ): Promise<{ requestId: string; attemptId: string; model: string }> {
    const predecessorId = predecessorAttemptId.trim();
    const retryGuidance = guidance.trim();
    if (!predecessorId) throw new Error('predecessor attempt id is required');
    if (!retryGuidance) throw new Error('retry guidance is required');
    if (!this.folder) throw new Error('select a repository before continuing');
    if (this.active && !this.active.terminal) throw new Error('a task is already running');
    const client = this.requireClient();
    this.refreshProvider();
    await this.refreshModelAvailability();
    if (this.modelAvailable !== true) {
      throw new Error(`configured local model '${this.provider!.model}' is not installed in Ollama`);
    }
    const scope = describeDesktopTaskScope(this.folder);
    if (!scope) throw new Error('select a repository before continuing');
    this.taskScope = authorizeDesktopTaskScope(scope);
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Authorized task scope for ${this.taskScope.repository}; delivery ${this.taskScope.deliveryDestination}`,
    });
    const predecessor = await client.getAttempt(predecessorId);
    const request = await client.getRequest(predecessor.requestId);
    if (!request.conversationId) throw new Error('predecessor request has no conversation');
    const successor = await client.retryAttempt(predecessorId, {
      strategy: 'with_guidance',
      guidance: retryGuidance,
    });
    const context = await client.getAttemptContext(successor.id);
    const model = this.provider!.model;
    this.active = {
      attemptId: successor.id,
      requestId: successor.requestId,
      conversationId: request.conversationId,
      goal: context.taskInput,
      tokenBuffer: '',
      terminal: false,
    };
    this.cockpitEvents = [];
    this.approvedApproval = null;
    this.missionStartedAt = nowIso();
    this.recordEvidence({
      type: 'continue',
      predecessorAttemptId: predecessorId,
      requestId: successor.requestId,
      attemptId: successor.id,
      model,
      folder: this.folder,
    });
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: successor.id,
      requestId: successor.requestId,
      summary: `Continued ${predecessorId} as ${successor.id}`,
    });
    await client.executeAttempt(successor.id, { workingDirectory: this.folder });
    return { requestId: successor.requestId, attemptId: successor.id, model };
  }

  /**
   * Requests a stop, then waits (bounded) for Core to confirm it.
   *
   * The Stop button used to show "Stopping…" forever when the Core accepted the
   * cancel request but never settled the attempt. The request is only intent —
   * the authoritative state is the attempt's persisted terminal state, and this
   * reports the difference honestly instead of pretending the task stopped.
   */
  async cancel(): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) throw new Error('no running task to cancel');
    this.pending = undefined;
    await this.requireClient().cancelAttempt(active.attemptId);
    this.recordEvidence({ type: 'cancel-requested', attemptId: active.attemptId, requestId: active.requestId });
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: active.attemptId,
      requestId: active.requestId,
      summary: `Cancel requested for ${active.attemptId}`,
    });

    const deadline = Date.now() + (this.options.cancelConfirmTimeoutMs ?? CANCEL_CONFIRM_TIMEOUT_MS);
    while (Date.now() < deadline && this.active === active && !active.terminal) {
      await sleep(100);
    }
    if (active.terminal) return; // Core confirmed the real terminal state (cancelled or completed).
    this.emit({
      kind: 'error',
      at: nowIso(),
      attemptId: active.attemptId,
      requestId: active.requestId,
      summary:
        'Stop was requested, but the running task has not confirmed it stopped yet. '
        + 'It may still be finishing; press Stop again if it keeps going.',
      clientOrigin: active.clientOrigin,
    });
  }

  /** True while a task this session started has not reached a terminal outcome. */
  isBusy(): boolean {
    return Boolean(this.active && !this.active.terminal);
  }

  /**
   * Composer send while work is running. Stop wording acts immediately (never behind queued work);
   * anything else is persisted in Core's command queue — it survives a restart and never replays
   * after a Stop without a fresh confirmation.
   */
  async sendWhileRunning(goal: string): Promise<DesktopSubmitResult> {
    let text = goal.trim();
    if (!text) throw new Error('task text is required');
    const active = this.active;
    if (!active || active.terminal) throw new Error('no running task');
    if (isStopIntent(text)) {
      await this.cancel();
      return { requestId: active.requestId, attemptId: active.attemptId, model: this.activeModel ?? '', routed: 'stopped' };
    }
    if (this.attachmentStaging.list().length > 0) {
      throw new Error('Files cannot be queued behind running work. Stop the task or wait for it to finish, then send them.');
    }
    // An identical resend (double-click, repeated Enter) must not start or queue a second expensive job.
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
    const waiting = [...(this.commandQueue.confirming ? [this.commandQueue.confirming] : []), ...this.commandQueue.waiting];
    const duplicate = norm(active.goal) === norm(text) || waiting.some((q) => norm(q.instruction) === norm(text));
    if (duplicate) {
      this.emit({ kind: 'status', at: nowIso(), summary: 'Ignored a duplicate of a request that is already running or queued', eventType: 'composer_duplicate_ignored' });
      return { requestId: active.requestId, attemptId: active.attemptId, model: this.activeModel ?? '', routed: 'duplicate' };
    }
    // What the person typed decides: adjust the running task, ask something alongside it, or start something after it.
    const route = routeSendWhileRunning(text);
    if (route === 'correct') {
      const corrected = await this.applyCorrection(text, active);
      if (corrected) return corrected;
      // The run cannot take the correction (not on the live agent, or it just finished): it is queued with the
      // original wording attached, never dropped, and the person is told it was queued.
      text = `${active.goal}
[Correction from the user — replaces the earlier wording: ${text}]`;
    } else if (route === 'steer') {
      const steered = await this.requireClient().steerAttempt(active.attemptId, text);
      if (steered.accepted) {
        this.emit({ kind: 'status', at: nowIso(), summary: `Added to the running task: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`, eventType: 'composer_instruction_steered' });
        return { requestId: active.requestId, attemptId: active.attemptId, model: this.activeModel ?? '', routed: 'steered' };
      }
      // The run cannot take it (not on the live agent, or it just finished): fall through to the queue, never drop it.
    } else if (route === 'side_question' && this.canAnswerAlongside()) {
      return this.submitSideQuestion(text, active);
    }
    const item = await this.requireClient().enqueueCommand({ instruction: text, source: 'text' });
    await this.refreshCommandQueue();
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Queued behind the running task: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`,
      eventType: 'composer_instruction_queued',
    });
    return { requestId: '', attemptId: '', model: this.activeModel ?? '', routed: 'queued', commandId: String(item.id) };
  }

  /**
   * An explicit correction of the latest request ("No wait, make it for RTX 5090").
   *
   * The latest request is the one being corrected: if one is still waiting in the queue it is edited in place (same
   * durable queue item, new revision, any pending confirmation invalidated); otherwise the running task gets the
   * correction through Core, which restarts a run that has not acted yet and steers one that has, so no tool action
   * is ever repeated. Returns null when the run cannot take it, so the caller queues it rather than losing it.
   */
  private async applyCorrection(text: string, active: ActiveTurn): Promise<DesktopSubmitResult | null> {
    const client = this.requireClient();
    const pending = this.commandQueue.waiting[this.commandQueue.waiting.length - 1] ?? this.commandQueue.confirming;
    if (pending) {
      const instruction = `${pending.instruction}
[Correction from the user — replaces the earlier wording: ${text}]`;
      await client.editCommandQueueItem(String(pending.id), { instruction });
      await this.refreshCommandQueue();
      this.emit({ kind: 'status', at: nowIso(), summary: `Corrected the queued request: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`, eventType: 'composer_queued_corrected' });
      return { requestId: '', attemptId: '', model: this.activeModel ?? '', routed: 'corrected_queued', commandId: String(pending.id) };
    }
    const steered = await client.steerAttempt(active.attemptId, text, { correction: true });
    if (!steered.accepted) return null;
    const restarted = steered.mode === 'superseded';
    if (restarted) active.tokenBuffer = ''; // the draft answered the old wording
    active.goal = `${active.goal} — corrected: ${text}`;
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: active.attemptId,
      requestId: active.requestId,
      summary: restarted
        ? `Corrected before it answered: the task restarts on "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`
        : `Corrected while working: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`,
      eventType: restarted ? 'composer_request_restarted' : 'composer_request_corrected',
    });
    return { requestId: active.requestId, attemptId: active.attemptId, model: this.activeModel ?? '', routed: restarted ? 'corrected_restarted' : 'corrected_steered' };
  }

  /** A side question is answered by the same local model, in the same conversation. Cloud and OpenRouter stay single-lane. */
  private canAnswerAlongside(): boolean {
    return (this.activeProvider === 'ollama' || this.activeProvider === null) && Boolean(this.activeModel) && this.activeModel !== AUTO_MODEL;
  }

  /**
   * An unrelated quick question asked while a task works. It becomes its own plain-chat attempt in the SAME
   * conversation, so the answer lands in the thread; Core's interactive lane makes the background task yield to it
   * at its next model/tool boundary. The running task is not touched: not stopped, not restarted, not re-queued.
   * The host's single "active" slot stays with the long task, so Stop and the task card keep meaning that task.
   */
  private async submitSideQuestion(text: string, active: ActiveTurn): Promise<DesktopSubmitResult> {
    const client = this.requireClient();
    const model = this.activeModel as string;
    const submission = await client.submit({
      currentMessage: text,
      requestedMode: 'baat_kar',
      conversationId: active.conversationId,
      requestedProvider: 'ollama',
      requestedModel: model,
      workspaceRoot: undefined,
      hasWorkspace: false,
      gitCapable: false,
      modelSelection: {
        requiredCapabilities: {
          readOnlyExplanation: true,
          repositoryExploration: false,
          toolCalling: true,
          fileModification: false,
          codingComplexity: 'low',
          contextRequirement: 'small',
          vision: false,
          validationAndRepair: false,
        },
        selectedProvider: 'ollama',
        selectedModel: model,
        routingPolicy: 'local-only',
        selectionReason: 'Quick question asked while a task is working: same local model, answered alongside it',
        suitabilitySummary: `Using local ${model}. Cloud fallback is disabled.`,
        userOverrode: false,
        candidates: [{ provider: 'ollama', model, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
        escalationCandidates: [],
      },
    });
    await client.executeAttempt(submission.attempt.id, {});
    this.emit({
      kind: 'status',
      at: nowIso(),
      attemptId: submission.attempt.id,
      requestId: submission.request.id,
      summary: `Answering alongside the running task: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`,
      eventType: 'composer_side_question',
    });
    return { requestId: submission.request.id, attemptId: submission.attempt.id, model, routed: 'side_question' };
  }

  /** Stop one task by attempt id: the running one through the normal path, any other straight through Core. */
  async cancelTask(attemptId: string): Promise<{ requested: boolean }> {
    if (!attemptId) throw new Error('attempt id is required');
    if (this.active && !this.active.terminal && this.active.attemptId === attemptId) {
      await this.cancel();
      return { requested: true };
    }
    await this.requireClient().cancelAttempt(attemptId);
    this.recordEvidence({ type: 'cancel-requested', attemptId, requestId: '' });
    return { requested: true };
  }

  /** Tasks screen rows from Core's durable records (identical after a reconnect or restart) plus waiting instructions. */
  async getTaskOverview(): Promise<{ tasks: unknown[]; queued: CommandQueueItemView[] }> {
    const client = this.requireClient();
    const [{ tasks }, queue] = await Promise.all([client.getTaskOverview(30), this.refreshCommandQueue()]);
    const queued = [...(queue.confirming ? [queue.confirming] : []), ...queue.waiting];
    // Only an attempt a worker still holds is live. A persisted `running` status
    // on its own is a leftover from a worker that is gone — probing Ollama for
    // it would describe a model that is not actually serving this task.
    const live = tasks.filter((t) => t.live === true);
    // What the model is physically doing: is it resident in Ollama (or will this call reload it), is it streaming.
    const resident = live.length ? await this.probeOllamaResidency() : null;
    const withTelemetry = tasks.map((t) => {
      if (!live.includes(t)) return t;
      const stat = this.tokenStats.get(t.attemptId);
      const loaded = t.provider === 'ollama' && t.model && resident ? resident.find((m) => m.name === t.model) : undefined;
      const windowMs = stat && stat.lastAt > stat.firstAt ? stat.lastAt - stat.firstAt : 0;
      return {
        ...t,
        telemetry: {
          modelResident: t.provider === 'ollama' && resident ? Boolean(loaded) : null,
          gpuPercent: loaded && loaded.size > 0 ? Math.round((loaded.sizeVram / loaded.size) * 100) : null,
          contextLength: loaded?.contextLength ?? null,
          unloadsAt: loaded?.expiresAt ?? null,
          streamedChunks: stat?.chunks ?? 0,
          firstTokenAt: stat ? new Date(stat.firstAt).toISOString() : null,
          lastTokenAt: stat ? new Date(stat.lastAt).toISOString() : null,
          chunksPerSecond: stat && windowMs > 500 ? Math.round((stat.chunks / (windowMs / 1000)) * 10) / 10 : null,
        },
      };
    });
    return { tasks: withTelemetry, queued };
  }

  /**
   * Pandesh's brief — the context-aware Home items and the Today briefing.
   *
   * `external` additionally reads the live calendar and mailbox through Core's
   * connector adapters (behind the same read-permission gate the agent loop
   * uses). A service that is not connected is reported as not connected.
   */
  async getAssistantBrief(options: { external?: boolean } = {}): Promise<DesktopAssistantBrief> {
    const client = this.requireClient();
    const { brief, markdown } = await client.getAssistantBrief(options.external === true);
    return {
      generatedAt: brief.generatedAt,
      timezone: brief.timezone,
      home: brief.home,
      today: brief.today,
      services: brief.services,
      markdown,
    };
  }

  /** The configured daily brief routine, or null when it was never set up. */
  async getDailyBriefRoutine(): Promise<DesktopDailyBriefRoutine | null> {
    const client = this.requireClient();
    const { routine } = await client.getDailyBriefRoutine();
    return routine ? mapDailyBriefRoutine(routine) : null;
  }

  /** Creates, reschedules, enables or disables the daily brief routine. */
  async configureDailyBriefRoutine(input: {
    dailyTime: string;
    timezone?: string;
    enabled?: boolean;
  }): Promise<DesktopDailyBriefRoutine | null> {
    const client = this.requireClient();
    const { routine } = await client.configureDailyBriefRoutine(input);
    return routine ? mapDailyBriefRoutine(routine) : null;
  }

  /**
   * Answers a pending approval from a visible card — including a Home card
   * for a turn that is not the active one.
   *
   * When the approval belongs to the turn that is running here, the normal
   * pending path is used so the attempt loop resumes exactly as it would from
   * the inline approval card. Otherwise Core resolves it against the stored
   * approval envelope, which can never be widened.
   */
  async resolveAssistantApproval(
    approvalId: string,
    resolution: DesktopApprovalResolution,
  ): Promise<{ status: string }> {
    const active = this.pending?.envelope.approvalId === approvalId;
    if (active) {
      await this.resolvePending(approvalId, resolution);
      return { status: resolution };
    }
    const client = this.requireClient();
    const resolved = await client.resolveAssistantApproval(approvalId, resolution);
    if (resolved.resumedAttemptId && this.active) {
      this.active.attemptId = resolved.resumedAttemptId;
      this.active.terminal = false;
    }
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Core approval ${resolution} (${approvalId})`,
    });
    return { status: resolved.status };
  }

  /**
   * Resumes a task the Core itself says can be retried safely.
   *
   * The retry is Core's own `retryAttempt` — the same linked attempt the
   * Tasks screen offers — so nothing is invented here. If Core refuses, the
   * refusal is shown verbatim.
   */
  async resumeTask(attemptId: string): Promise<{ attemptId: string; requestId: string }> {
    const result = await this.continueFailedTask(
      attemptId,
      'Continue from where this task stopped and finish the work it was asked for.',
    );
    return { attemptId: result.attemptId, requestId: result.requestId };
  }

  private async probeOllamaResidency(): Promise<Array<{ name: string; size: number; sizeVram: number; contextLength: number | null; expiresAt: string | null }> | null> {
    try {
      const base = this.provider?.apiBase ?? 'http://127.0.0.1:11434';
      const res = await fetch(new URL('/api/ps', base), { signal: AbortSignal.timeout(1500) });
      const body = await res.json() as { models?: Array<Record<string, unknown>> };
      return (body.models ?? []).map((m) => ({
        name: String(m.name ?? m.model ?? ''),
        size: Number(m.size ?? 0),
        sizeVram: Number(m.size_vram ?? 0),
        contextLength: typeof m.context_length === 'number' ? m.context_length : null,
        expiresAt: typeof m.expires_at === 'string' ? m.expires_at : null,
      }));
    } catch {
      return null; // unknown, not "not loaded"
    }
  }

  async resolvePending(approvalId: string, resolution: DesktopApprovalResolution): Promise<void> {
    if (!this.pending || this.pending.envelope.approvalId !== approvalId) {
      const convId = this.selectedConversationId ?? this.active?.conversationId;
      if (convId) {
        const snap = await this.requireClient().listCapabilityActions(convId);
        const match = snap.actions.find((a) => a.approvalId === approvalId && a.actionable);
        if (match) {
          this.pending = {
            card: toDesktopApprovalCard(match),
            envelope: toApprovalEnvelope(match),
          };
        }
      }
    }
    const pending = requireMatchingPending(this.pending?.envelope ?? null, approvalId);
    const payload = toCapabilityResolveInput(pending, resolution);
    const held = this.pending;
    this.pending = undefined;
    try {
      const resolved = await this.requireClient().resolveCapabilityApproval(payload.approvalId, {
        resolution: payload.resolution,
        attemptId: payload.attemptId,
        expectedAttemptRevision: payload.expectedAttemptRevision,
        expectedAttemptStatus: payload.expectedAttemptStatus,
        requestedActionDigest: payload.requestedActionDigest,
        frozenContextHash: payload.frozenContextHash,
      });
      this.recordEvidence({
        type: 'approval-resolved',
        approvalId: payload.approvalId,
        resolution: payload.resolution,
        resumedAttemptId: resolved.resumedAttemptId,
      });
      if (payload.resolution === 'approved' && held
        && (!this.approvedApproval || held.card.toolName === 'authorize_mission')) this.approvedApproval = held.card;
      if (payload.resolution === 'approved' && resolved.resumedAttemptId && this.active) {
        this.active.attemptId = resolved.resumedAttemptId;
        this.active.terminal = false;
      }
      this.emit({
        kind: 'status',
        at: nowIso(),
        attemptId: this.active?.attemptId,
        requestId: this.active?.requestId,
        summary: `Core approval ${payload.resolution}${resolved.resumedAttemptId ? `; resumed ${resolved.resumedAttemptId}` : ''}`,
      });
      if (payload.resolution === 'rejected') {
        if (this.active && !this.active.terminal) {
          await this.finishTurn('cancelled', 'Action rejected by user');
        }
      }
    } catch (err) {
      this.pending = held;
      throw err;
    }
  }

  /**
   * Gracefully shuts down active turns, disconnects clients, and sends an
   * authenticated shutdown request to the child Core process, waiting for it
   * to terminate cleanly so installed binaries and file handles are released.
   */
  async shutdown(options?: { timeoutMs?: number }): Promise<void> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    // 1. Drain or safely interrupt active in-flight attempt if running
    if (this.active?.attemptId) {
      try {
        this.options.log?.(`Interrupting active attempt ${this.active.attemptId} before shutdown`);
        await this.client?.cancelAttempt(this.active.attemptId);
      } catch (err) {
        this.options.log?.(`Failed to cancel active attempt: ${(err as Error).message}`);
      }
    }

    // 2. Authenticated shutdown of child Core process
    const discoveryPath = path.join(this.dataDir, 'core.json');
    let coreRecord: { pid?: number; port?: number; instanceId?: string } | undefined;
    try {
      if (fs.existsSync(discoveryPath)) {
        coreRecord = JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      }
    } catch {}

    if (coreRecord?.port) {
      try {
        this.options.log?.(
          `Requesting authenticated Core shutdown at port ${coreRecord.port} (instance=${coreRecord.instanceId ?? 'unknown'})`,
        );
        await fetch(`http://127.0.0.1:${coreRecord.port}/v1/core/shutdown`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': `shutdown-desktop-${Date.now()}`,
            'X-Client-Id': this.clientId,
          },
          body: '{}',
        });
      } catch (err) {
        this.options.log?.(`Core shutdown request error: ${(err as Error).message}`);
      }

      // Wait for Core process to exit
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const stillExists = fs.existsSync(discoveryPath);
        let pidAlive = false;
        if (coreRecord.pid && Number.isInteger(coreRecord.pid) && coreRecord.pid > 0) {
          try {
            process.kill(coreRecord.pid, 0);
            pidAlive = true;
          } catch {
            pidAlive = false;
          }
        }
        if (!stillExists && !pidAlive) {
          this.options.log?.(`Verified Core process ${coreRecord.pid ?? ''} has exited`);
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }

      // If still alive after timeout, check PortProcessManager for verified owned cleanup.
      // The port manager verifies ownership (provenance + creation time +
      // executable path) before terminating anything; an unproven target is
      // refused, so this can never close an unrelated application.
      if (coreRecord.pid) {
        try {
          process.kill(coreRecord.pid, 0);
          this.options.log?.(`Core process ${coreRecord.pid} did not exit within ${timeoutMs}ms; checking owned service cleanup`);
          const portManager = createPortProcessManager({ dataDir: this.dataDir });
          const stopped = await portManager.stopOwned('karkeDikha-core');
          if (!stopped.stopped) {
            this.options.log?.(`Owned Core cleanup refused or failed: ${stopped.reason ?? 'unknown reason'}`);
          }
        } catch (err) {
          this.options.log?.(`Owned Core cleanup error: ${(err as Error).message}`);
        }
      }
    }

    // 3. Regular cleanup of session timers and client
    this.dispose();
  }

  dispose(): void {
    if (this.queueOfferTimer) {
      clearInterval(this.queueOfferTimer);
      this.queueOfferTimer = null;
    }
    this.reminderScheduler?.dispose();
    this.reminderScheduler = null;
    this.client?.dispose();
    this.client = undefined;
  }

  async refreshEverydayTools(): Promise<EverydayToolsSnapshot> {
    const client = this.requireClient();
    const timezone = hostTimezone();
    const [{ notes }, { reminders, due }, connectorsResult] = await Promise.all([
      client.listEverydayNotes(),
      client.listEverydayReminders('open'),
      // Jarvis Connector Foundation: live Core state for the catalog
      // (requirement #7). A failed fetch falls back to the honest static
      // defaults rather than blocking the whole Everyday Tools refresh.
      client.listConnectors().catch(() => ({ connectors: [] })),
    ]);
    this.everydayTools = {
      timezone,
      alertsWhileClosed: true,
      alertsWhileClosedDetail:
        'Desktop alerts fire while Jarvis is running (window visible or hidden in the tray). Alerts do not fire after Quit, while the computer is asleep, or while the computer is off.',
      catalog: everydayToolCatalog(connectorsResult.connectors),
      notes: notes.map((n) => ({
        id: n.id,
        title: n.title,
        body: n.body,
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
      })),
      reminders: reminders.map(mapReminderView),
      dueReminders: due.map(mapReminderView),
    };
    this.reminderScheduler?.sync(
      this.everydayTools.reminders
        .filter((r) => r.status === 'scheduled')
        .map((r) => ({
          id: r.id,
          title: r.title,
          body: r.body,
          dueAt: r.dueAt,
          status: r.status,
          notifiedAt: r.notifiedAt,
        })),
    );
    return this.everydayTools;
  }

  /**
   * After sleep/resume or host restart: refresh Core state, surface overdue
   * items in Today, and fire at-most-once alerts only for still-scheduled dues.
   */
  async reconcileRemindersAfterResume(reason: 'startup' | 'resume' = 'resume'): Promise<EverydayToolsSnapshot> {
    const tools = await this.refreshEverydayTools();
    const dueScheduled = tools.reminders.filter((r) => r.status === 'scheduled' && r.overdue);
    for (const reminder of dueScheduled) {
      // Scheduler sync already arms delay=0 timers; force an immediate pass by
      // re-syncing. Duplicate delivery is prevented by mark-before-notify.
      this.options.log?.(`reconcile overdue reminder (${reason}): ${reminder.id}`);
    }
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Reminders reconciled after ${reason}: ${tools.dueReminders.length} due`,
      eventType: 'everyday_reminders_reconciled',
    });
    return tools;
  }

  openReminderFromNotification(reminderId: string): void {
    this.options.onReminderNotificationClick?.(reminderId);
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Open reminder ${reminderId}`,
      eventType: 'everyday_reminder_open',
      text: reminderId,
    });
  }

  async refreshCommandQueue(): Promise<CommandQueueSnapshot> {
    const client = this.requireClient();
    const snap = await client.getCommandQueue();
    this.commandQueue = {
      active: snap.active ? mapCommandView(snap.active) : null,
      confirming: snap.confirming ? mapCommandView(snap.confirming) : null,
      waiting: (snap.waiting ?? []).map(mapCommandView),
      recentTerminal: (snap.recentTerminal ?? []).map(mapCommandView),
    };
    const confirming = this.commandQueue.confirming;
    if (confirming?.confirmationToken) {
      const key = `${confirming.id}:${confirming.revision}:${confirming.confirmationToken}`;
      if (key !== this.lastQueueConfirmNotifyKey) {
        this.lastQueueConfirmNotifyKey = key;
        this.emit({
          kind: 'status',
          at: nowIso(),
          summary: `Command awaiting confirmation: ${confirming.title}`,
          eventType: 'command_queue_confirm',
          text: confirming.id,
        });
        if (this.options.notifyQueueConfirm) {
          await this.options.notifyQueueConfirm({
            id: confirming.id,
            title: confirming.title,
            instruction: confirming.instruction,
            token: confirming.confirmationToken,
            revision: confirming.revision,
          });
        }
      }
    } else {
      this.lastQueueConfirmNotifyKey = null;
    }
    return this.commandQueue;
  }

  openQueueConfirmFromNotification(commandId: string): void {
    this.options.onQueueConfirmNotificationClick?.(commandId);
    this.emit({
      kind: 'status',
      at: nowIso(),
      summary: `Open queue confirmation ${commandId}`,
      eventType: 'command_queue_open',
      text: commandId,
    });
  }

  private scheduleQueueOffer(): void {
    if (this.queueOfferTimer) return;
    this.queueOfferTimer = setInterval(() => {
      void this.offerNextQueuedCommand().catch((err) => {
        this.options.log?.(`queue offer failed: ${(err as Error).message}`);
      });
    }, 2_500);
    this.queueOfferTimer.unref?.();
  }

  async offerNextQueuedCommand(): Promise<DesktopSnapshot> {
    if (this.executingQueuedCommandId || (this.active && !this.active.terminal)) {
      return this.snapshot();
    }
    await this.requireClient().offerNextCommandConfirmation();
    await this.refreshCommandQueue();
    return this.snapshot();
  }

  async enqueueUserCommand(instruction: string, source: 'text' | 'voice' | 'ui' = 'text'): Promise<DesktopSnapshot> {
    await this.requireClient().enqueueCommand({ instruction, source });
    await this.refreshCommandQueue();
    await this.offerNextQueuedCommand();
    return this.snapshot();
  }

  async confirmQueuedCommandRun(id: string, token: string, revision: number): Promise<DesktopSnapshot> {
    const client = this.requireClient();
    const item = await client.confirmCommandRun(id, token, revision);
    this.executingQueuedCommandId = String(item.id);
    await this.refreshCommandQueue();
    try {
      const instruction = String(item.instruction ?? '');
      const result = await this.submitTask(instruction);
      // Long coding jobs legitimately run for hours; the wait ends when the turn reaches a real terminal outcome.
      const deadline = Date.now() + 6 * 60 * 60_000;
      while (this.active && !this.active.terminal && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (this.active && !this.active.terminal) {
        throw new Error('queued command timed out before terminal outcome');
      }
      if (this.lastTurnOutcome === 'failed' || this.lastTurnOutcome === 'cancelled') {
        throw new Error(`queued command ended as ${this.lastTurnOutcome}`);
      }
      await client.completeCommandQueueItem(String(item.id), {
        outcome: 'executed',
        attemptId: result.attemptId,
        requestId: result.requestId,
      });
    } catch (err) {
      await client.failCommandQueueItem(String(item.id), (err as Error).message).catch(() => undefined);
      throw err;
    } finally {
      this.executingQueuedCommandId = null;
      await this.refreshCommandQueue();
      void this.advanceComposerQueue().catch((err) => this.options.log?.(`queue advance failed: ${(err as Error).message}`));
    }
    return this.snapshot();
  }

  /**
   * After a turn ends: instructions the person typed into the composer while work was running continue in order,
   * but only after a completed or failed turn. After a Stop nothing starts by itself — the next item is only
   * offered for confirmation, like every other queued command.
   */
  async advanceComposerQueue(): Promise<void> {
    if (this.executingQueuedCommandId || (this.active && !this.active.terminal)) return;
    const client = this.requireClient();
    const { item } = await client.offerNextCommandConfirmation();
    await this.refreshCommandQueue();
    if (!item || item.status !== 'confirming' || item.source !== 'text' || this.lastTurnOutcome === 'cancelled') return;
    void this.confirmQueuedCommandRun(String(item.id), String(item.confirmationToken), Number(item.revision))
      .catch((err) => this.options.log?.(`queued instruction failed: ${(err as Error).message}`));
  }

  async skipQueuedCommand(id: string): Promise<DesktopSnapshot> {
    await this.requireClient().skipCommandQueueItem(id);
    await this.refreshCommandQueue();
    await this.offerNextQueuedCommand();
    return this.snapshot();
  }

  async postponeQueuedCommand(id: string, untilIso: string): Promise<DesktopSnapshot> {
    await this.requireClient().postponeCommandQueueItem(id, untilIso);
    await this.refreshCommandQueue();
    await this.offerNextQueuedCommand();
    return this.snapshot();
  }

  async editQueuedCommand(id: string, instruction: string): Promise<DesktopSnapshot> {
    await this.requireClient().editCommandQueueItem(id, { instruction });
    await this.refreshCommandQueue();
    await this.offerNextQueuedCommand();
    return this.snapshot();
  }

  async removeQueuedCommand(id: string): Promise<DesktopSnapshot> {
    await this.requireClient().removeCommandQueueItem(id);
    await this.refreshCommandQueue();
    await this.offerNextQueuedCommand();
    return this.snapshot();
  }

  async reorderQueuedCommand(id: string, ordinal: number): Promise<DesktopSnapshot> {
    await this.requireClient().reorderCommandQueueItem(id, ordinal);
    await this.refreshCommandQueue();
    return this.snapshot();
  }

  async createNote(input: { title?: string; body: string }): Promise<DesktopSnapshot> {
    await this.requireClient().createEverydayNote(input);
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  async updateNote(id: string, input: { title?: string; body?: string }): Promise<DesktopSnapshot> {
    await this.requireClient().updateEverydayNote(id, input);
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  async deleteNote(id: string): Promise<DesktopSnapshot> {
    await this.requireClient().deleteEverydayNote(id);
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  async createReminder(input: { title: string; body?: string; dueAt: string; timezone?: string }): Promise<DesktopSnapshot> {
    await this.requireClient().createEverydayReminder({
      ...input,
      timezone: input.timezone ?? hostTimezone(),
    });
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  async completeReminder(id: string): Promise<DesktopSnapshot> {
    await this.requireClient().completeEverydayReminder(id);
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  async cancelReminder(id: string): Promise<DesktopSnapshot> {
    await this.requireClient().cancelEverydayReminder(id);
    await this.refreshEverydayTools();
    return this.snapshot();
  }

  // --- Jarvis Conversations rail (Checkpoint 1) ---
  // Reuses Core's existing conversation ledger end to end: no second
  // Desktop database, no renderer-owned transcript. `selectedConversationId`
  // is the only Desktop-side state, and it is just a pointer persisted to
  // `selected-conversation.json` (see desktopConversationSelection.ts).

  async listConversations(includeArchived = false): Promise<ConversationRailEntryView[]> {
    const { conversations } = await this.requireClient().listConversations({ includeArchived });
    return conversations.map((entry) => ({
      id: entry.id,
      title: entry.title,
      preview: entry.preview,
      state: entry.state,
      repositoryName: entry.repositoryName,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      archivedAt: entry.archivedAt,
      pinnedAt: entry.pinnedAt,
    }));
  }

  async openConversation(conversationId: string, select = true): Promise<ConversationOpenResult> {
    const client = this.requireClient();
    const [conversation, messagesResult, exportedResult] = await Promise.all([
      client.getConversation(conversationId),
      client.listMessages(conversationId, { limit: 2000 }),
      client.exportConversation(conversationId, 'json'),
    ]);
    // A passive transcript refresh (select=false) only reads: it must never
    // re-select a conversation the person has already navigated away from.
    if (select) {
      this.selectedConversationId = conversationId;
      writeSelectedConversation(this.dataDir, conversationId);
      // A different conversation's restored (never-resolved) media approval
      // must not follow the user into this one.
      if (this.pendingImageApproval && this.pendingImageApproval.correlationId !== conversationId) {
        this.pendingImageApproval = null;
        this.activeImageAttemptId = null;
      }
      if (this.pending && this.active?.conversationId && this.active.conversationId !== conversationId) {
        this.pending = undefined;
      }
      await this.restorePendingApproval(conversationId);
      await this.restorePendingMediaApproval(conversationId);
    }
    const rail = (await this.listConversations(true)).find((entry) => entry.id === conversationId) ?? {
      id: conversation.id,
      title: conversation.title,
      preview: null,
      state: 'active' as const,
      repositoryName: null,
      createdAt: conversation.createdAt,
      updatedAt: conversation.updatedAt,
      archivedAt: conversation.archivedAt,
      pinnedAt: conversation.pinnedAt,
    };
    const exported = exportedResult.format === 'json' ? exportedResult.content : null;
    if (!exported) throw new Error('Core returned an invalid conversation export');
    // Attachment chips are a nicety: an older Core (or a hiccup) must never stop a conversation from opening.
    const attachmentsByMessage = await Promise.resolve()
      .then(() => client.listConversationMessageAttachments(conversationId))
      .then((r) => r.byMessage)
      .catch(() => ({} as Record<string, never[]>));
    const workingState = this.folder
      ? await client.getConversationWorkingState(conversationId, conversationWorkspaceIdentity(this.folder))
      : null;
    return {
      conversation: rail,
      // Defense-in-depth only: production code never persists 'system'/'tool'
      // roles into conversation_messages (see core/domain/submission.ts,
      // core/runtime/executor.ts) — model/tool events live in the separate
      // event stream, never in this durable transcript.
      messages: messagesResult.messages
        .filter((message) => message.role === 'user' || message.role === 'assistant' || message.role === 'system')
        .map((message) => ({
          id: message.id,
          role: message.role as 'user' | 'assistant' | 'system',
          content: message.content,
          createdAt: message.createdAt,
          model: message.model ?? null,
          provider: message.provider ?? null,
          diagnostics: (message.diagnostics as any) ?? null,
          attachments: ((attachmentsByMessage as Record<string, Array<{ id: string; originalName: string; kind: string; byteSize: number; deletedAt: string | null }>>)[message.id] ?? [])
            .filter((a) => !a.deletedAt)
            .map((a) => ({ id: a.id, name: a.originalName, kind: a.kind as 'text' | 'image' | 'document' | 'audio', byteSize: a.byteSize })),
        })),
      context: buildConversationContextView({
        exported,
        workingState,
        repositoryName: rail.repositoryName,
        workspaceSelected: Boolean(this.folder),
      }),
    };
  }

  async exportConversationMarkdown(conversationId: string): Promise<{ title: string; content: string }> {
    const client = this.requireClient();
    const [conversation, exported] = await Promise.all([
      client.getConversation(conversationId),
      client.exportConversation(conversationId, 'markdown'),
    ]);
    if (exported.format !== 'markdown') throw new Error('Core returned an invalid conversation export');
    return { title: conversation.title?.trim() || 'Jarvis conversation', content: exported.content };
  }

  /** Clears the selection so the next submit lazily creates a brand-new Core
   * conversation — never inherits the previous objective or context. */
  async newConversation(): Promise<void> {
    this.voiceConversationId = null;
    this.selectedConversationId = null;
    this.lastWeatherLocation = null;
    this.awaitingWeatherLocation = false;
    clearSelectedConversation(this.dataDir);
  }

  async renameConversation(conversationId: string, title: string): Promise<ConversationRailEntryView[]> {
    await this.requireClient().renameConversation(conversationId, title);
    return this.listConversations();
  }

  async pinConversation(conversationId: string): Promise<ConversationRailEntryView[]> {
    await this.requireClient().pinConversation(conversationId);
    return this.listConversations();
  }

  async unpinConversation(conversationId: string): Promise<ConversationRailEntryView[]> {
    await this.requireClient().unpinConversation(conversationId);
    return this.listConversations();
  }

  async archiveConversation(conversationId: string): Promise<ConversationRailEntryView[]> {
    await this.requireClient().archiveConversation(conversationId);
    return this.listConversations(true);
  }

  async unarchiveConversation(conversationId: string): Promise<ConversationRailEntryView[]> {
    await this.requireClient().unarchiveConversation(conversationId);
    return this.listConversations(true);
  }

  async searchConversations(query: string): Promise<ConversationSearchResultView[]> {
    const { results } = await this.requireClient().searchConversations(query);
    return results.map(({ branch: _branch, ...rest }) => rest);
  }

  private projectArtifact(record: import('../../../../core/shared/wireTypes').ArtifactRecord): DesktopArtifactView {
    return {
      id: record.id, conversationId: record.conversationId, kind: record.kind,
      title: record.title, mimeType: record.mimeType, fileName: path.basename(record.absolutePath),
      byteSize: record.byteSize, source: record.source, createdAt: record.createdAt,
      availability: record.availability,
    };
  }

  async getDevStories(): Promise<Awaited<ReturnType<CoreClient['getDevStories']>>> {
    return this.requireClient().getDevStories();
  }

  async decideDevStoryPermission(storyId: string, pendingId: string, allow: boolean, via: 'window' | 'phone' = 'window'): Promise<{ ok: boolean }> {
    return this.requireClient().decideDevStoryPermission(storyId, pendingId, allow, via);
  }

  async stopAllDevStories(): Promise<Awaited<ReturnType<CoreClient['stopAllDevStories']>>> {
    return this.requireClient().stopAllDevStories();
  }

  async approveDevStoryReview(storyId: string): Promise<{ ok: boolean }> {
    return this.requireClient().approveDevStoryReview(storyId);
  }

  async verifyExistingDevStory(storyId: string): Promise<{ outcome: string; status: string; commit: string | null; reason: string | null }> {
    return this.requireClient().verifyExistingDevStory(storyId);
  }

  async retryDevStory(storyId: string): Promise<{ ok: boolean }> {
    return this.requireClient().retryDevStory(storyId);
  }

  async getDevStory(storyId: string): Promise<Awaited<ReturnType<CoreClient['getDevStory']>>> {
    return this.requireClient().getDevStory(storyId);
  }

  async confirmDeviceVerification(storyId: string, ok: boolean, note?: string): Promise<{ ok: boolean }> {
    return this.requireClient().confirmDeviceVerification(storyId, ok, note);
  }

  async listArtifacts(conversationId?: string): Promise<DesktopArtifactView[]> {
    const result = await this.requireClient().listArtifacts(conversationId);
    return result.artifacts.map((record) => this.projectArtifact(record));
  }

  private async verifiedArtifact(id: string): Promise<{ record: import('../../../../core/shared/wireTypes').ArtifactRecord; bytes: Buffer }> {
    const record = await this.requireClient().getArtifact(id);
    if (record.availability !== 'ready') throw new Error(`Artifact is ${record.availability}`);
    const bytes = fs.readFileSync(record.absolutePath);
    if (bytes.length !== record.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== record.sha256) {
      throw new Error('Artifact changed after Core recorded it');
    }
    return { record, bytes };
  }

  async loadArtifactPreview(id: string): Promise<DesktopArtifactPreview> {
    const { record, bytes } = await this.verifiedArtifact(id);
    if (record.kind === 'video' && record.mimeType.startsWith('video/')) {
      return { artifact: this.projectArtifact(record), dataUrl: '', fileUrl: pathToFileURL(record.absolutePath).toString() };
    }
    if (record.kind !== 'image' || !record.mimeType.startsWith('image/')) throw new Error('Preview is available for images and videos only');
    if (record.byteSize > 12 * 1024 * 1024) throw new Error('Image is too large for an in-app preview');
    return { artifact: this.projectArtifact(record), dataUrl: `data:${record.mimeType};base64,${bytes.toString('base64')}` };
  }

  async artifactPath(id: string): Promise<string> {
    return (await this.verifiedArtifact(id)).record.absolutePath;
  }

  async getArtifactContent(id: string): Promise<{ kind: string; mimeType: string; bytes: Buffer; title: string }> {
    const { record, bytes } = await this.verifiedArtifact(id);
    return { kind: record.kind, mimeType: record.mimeType, bytes, title: record.title };
  }

  async saveArtifactCopy(id: string, destinationPath: string): Promise<void> {
    const { bytes } = await this.verifiedArtifact(id);
    fs.writeFileSync(destinationPath, bytes);
  }

  /** Deep-link into the standalone Studio app with this artifact's prompt
   * prefilled. Reuses Studio's own generation UI/gallery rather than
   * duplicating it in Jarvis. */
  async imageStudioAppUrlForPrompt(id: string): Promise<string> {
    const { record } = await this.verifiedArtifact(id);
    const url = new URL(IMAGE_STUDIO_APP_URL);
    const prompt = typeof record.metadata.prompt === 'string' ? record.metadata.prompt : record.title;
    if (prompt) url.searchParams.set('prompt', prompt);
    return url.toString();
  }

  /** Deep-link into Studio with this artifact preselected as its image-to-image
   * reference. The file already lives in Studio's own output/gallery folder
   * (Core reads generated images from there), so no upload is needed. */
  async imageStudioAppUrlForReference(id: string): Promise<string> {
    const { record } = await this.verifiedArtifact(id);
    const url = new URL(IMAGE_STUDIO_APP_URL);
    url.searchParams.set('ref', path.basename(record.absolutePath));
    return url.toString();
  }

  async probeImageStudio(): Promise<DesktopImageStudioStatus> {
    return { ...(await (this.options.probeImageStudio?.() ?? probeImageStudioServices())) };
  }

  /** Reuses the currently-selected/voice conversation, or lazily creates one
   * titled for this capability call — shared by any directly-dispatched
   * (non-attempt-loop) capability that needs a conversation to attach its
   * approval/result to, not just images. */
  private async ensureCapabilityConversation(title: string): Promise<string> {
    let conversationId = this.selectedConversationId ?? this.voiceConversationId;
    if (!conversationId) {
      const conversation = await this.requireClient().createConversation({
        mode: 'baat_kar',
        title: title.slice(0, 70),
      });
      conversationId = conversation.id;
      this.voiceConversationId = conversationId;
      this.selectedConversationId = conversationId;
      writeSelectedConversation(this.dataDir, conversationId);
    }
    return conversationId;
  }

  /** True when the current active turn is the chat image request that is
   * waiting on this image approval (its id is a host-side image_att_* id,
   * not the Core attempt id), so finishing the approval finishes the turn. */
  private isImageTurnFor(coreAttemptId: string): boolean {
    if (!this.active || this.active.terminal) return false;
    return this.active.attemptId === coreAttemptId || this.active.attemptId.startsWith('image_att_');
  }

  /** Records a capability turn in the Core conversation so it survives
   * restarts and shows on every client; never fails the capability itself. */
  private async recordConversationMessage(conversationId: string, role: 'user' | 'assistant', content: string): Promise<void> {
    try {
      await this.requireClient().appendMessage(conversationId, { role, content });
    } catch (err) {
      this.options.log?.(`conversation record failed: ${(err as Error).message}`);
    }
  }

  async generateImage(input: Record<string, unknown>, toolName: 'image_generate' | 'video_generate' = 'image_generate'): Promise<DesktopImageGenerationResult> {
    const prompt = typeof input.prompt === 'string' ? input.prompt.replace(/\s+/g, ' ').trim() : '';
    if (!prompt) return { outcome: 'failed', reason: 'Enter an image prompt first' };
    const correlationId = await this.ensureCapabilityConversation(`Image: ${prompt}`);
    const arguments_ = { ...input, prompt };
    const result = await this.requireClient().dispatchCapability({
      correlationId,
      toolName,
      arguments: arguments_,
      cwd: this.folder ?? this.dataDir,
    });
    this.activeImageAttemptId = result.attemptId;
    if (result.outcome === 'approval_required') {
      this.pendingImageApproval = { arguments: arguments_, approval: result.approval, correlationId, toolName };
      this.emit({ kind: 'status', at: nowIso(), summary: 'Image ready for your approval', eventType: 'image_generation_needs_input' });
    }
    return toImageGenerationResult(result);
  }

  async resolveImageApproval(approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopImageGenerationResult> {
    const held = this.pendingImageApproval;
    if (!held || held.approval.id !== approvalId) throw new Error('no matching pending image approval');
    this.pendingImageApproval = null;
    const client = this.requireClient();
    await client.resolveCapabilityApproval(approvalId, {
      resolution,
      attemptId: held.approval.attemptId,
      expectedAttemptRevision: held.approval.expectedAttemptRevision,
      expectedAttemptStatus: held.approval.expectedAttemptStatus,
      requestedActionDigest: held.approval.requestedActionDigest,
      frozenContextHash: held.approval.frozenContextHash,
    });
    if (resolution === 'rejected') {
      this.activeImageAttemptId = null;
      await this.recordConversationMessage(held.correlationId, 'assistant', 'Image request cancelled — nothing was generated.');
      if (this.isImageTurnFor(held.approval.attemptId)) {
        this.active!.terminal = true;
        this.lastTurnOutcome = 'cancelled';
        this.turnOutcomeKind = null;
        this.emit({ kind: 'result', at: nowIso(), attemptId: this.active!.attemptId, summary: 'Image Generation Studio', text: 'Image request cancelled — nothing was generated.' });
        this.drainSubmissionQueue();
      }
      return { outcome: 'denied', attemptId: held.approval.attemptId, reason: 'rejected by operator' };
    }
    const ensure = this.options.ensureImageStudio
      ?? ((onStatus?: (text: string) => void) => ensureImageStudioServices({}, onStatus));
    try {
      await ensure((summary) => this.emit({ kind: 'status', at: nowIso(), summary, eventType: 'image_generation_startup' }));
      this.emit({ kind: 'status', at: nowIso(), summary: held.toolName === 'video_generate' ? 'Generating video locally (a few minutes)…' : 'Generating image locally…', eventType: 'image_generation_running' });
      const result = await client.dispatchCapability({
        correlationId: held.correlationId,
        toolName: held.toolName ?? 'image_generate',
        arguments: held.arguments,
        cwd: this.folder ?? this.dataDir,
      });
      const view = toImageGenerationResult(result);
      const promptText = String(held.arguments.prompt ?? 'image');
      await this.recordConversationMessage(held.correlationId, 'assistant', view.outcome === 'executed'
        ? [held.toolName === 'video_generate' ? 'Here is your video (LTX-Video, generated locally):' : `Here ${view.artifactIds.length > 1 ? `are your ${view.artifactIds.length} images` : 'is your image'} (${String(held.arguments.checkpoint ?? 'local model')}):`, '', ...view.artifactIds.map((id) => `![${promptText.replace(/[[\]]/g, '')}](artifact:${id})`), '', view.message].join('\n')
        : `Image generation did not complete: ${'reason' in view ? view.reason : view.outcome}`);
      if (this.isImageTurnFor(held.approval.attemptId)) {
        this.active!.terminal = true;
        this.lastTurnOutcome = view.outcome === 'executed' ? 'completed' : 'failed';
        this.turnOutcomeKind = view.outcome === 'executed' ? 'answered' : 'failed';
        this.drainSubmissionQueue();
      }
      this.emit({
        kind: 'status', at: nowIso(),
        summary: view.outcome === 'executed' ? 'Image generated · shown in the conversation' : `Image generation ${view.outcome}`,
        eventType: view.outcome === 'executed' ? 'image_generation_completed' : 'image_generation_failed',
      });
      return view;
    } catch (error) {
      const reason = compactCapabilityFailure(error);
      if (this.isImageTurnFor(held.approval.attemptId)) {
        this.active!.terminal = true;
        this.lastTurnOutcome = 'failed';
        this.turnOutcomeKind = 'failed';
        this.drainSubmissionQueue();
      }
      this.emit({ kind: 'status', at: nowIso(), summary: reason, eventType: 'image_generation_failed' });
      return { outcome: 'failed', attemptId: held.approval.attemptId, reason };
    } finally {
      this.activeImageAttemptId = null;
    }
  }

  /**
   * Rehydrates an actionable capability approval across app reloads, Core
   * restarts, and desktop reconnections. Read-only: never creates an attempt or
   * approval. Reconstructs this.pending so inline and host approval resolution
   * match the durable Core gate without needing a resubmission.
   */
  private async restorePendingApproval(conversationId: string | null): Promise<void> {
    if (!conversationId) return;
    try {
      const client = this.requireClient();
      const snapshot = await client.listCapabilityActions(conversationId);
      const selected = selectActionableApproval(snapshot.actions);
      if (selected) {
        this.pending = {
          card: toDesktopApprovalCard(selected),
          envelope: toApprovalEnvelope(selected),
        };
        if (!this.active || this.active.terminal) {
          this.active = {
            attemptId: selected.attemptId,
            requestId: `restored_${selected.approvalId}`,
            conversationId,
            goal: selected.toolName,
            tokenBuffer: '',
            terminal: false,
          };
        }
        this.emit({
          kind: 'approval',
          at: nowIso(),
          attemptId: selected.attemptId,
          requestId: this.active.requestId,
          summary: `Waiting for ${this.pending.card.gate} approval: ${this.pending.card.scope}`,
        });
      } else if (this.active?.terminal && this.pending) {
        this.pending = undefined;
      }
    } catch (err) {
      this.options.log?.(`pending approval restore failed: ${(err as Error).message}`);
    }
  }

  /**
   * Rehydrates an image/video approval that survived a restart from Core's
   * durable state. Read-only: never creates an attempt/approval and never
   * approves anything. Only approvals that are still pending, have no tool
   * invocation yet, and whose anchor attempt is still waiting_for_approval are
   * restored; legacy orphans on terminal attempts stay hidden because Core
   * would reject their resolution. Keeps the original approval identity.
   */
  private async restorePendingMediaApproval(conversationId: string | null): Promise<void> {
    if (!conversationId || this.pendingImageApproval) return;
    if (this.active && !this.active.terminal) return;
    try {
      const snapshot = await this.requireClient().listCapabilityActions(conversationId);
      const entry = snapshot.actions
        .filter((a) => a.actionable && a.status === 'pending'
          && a.expectedAttemptStatus === 'waiting_for_approval'
          && (a.toolName === 'image_generate' || a.toolName === 'video_generate'))
        .sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
        .pop();
      if (!entry) return;
      this.pendingImageApproval = {
        arguments: entry.arguments,
        correlationId: conversationId,
        toolName: entry.toolName as 'image_generate' | 'video_generate',
        approval: {
          id: entry.approvalId,
          attemptId: entry.attemptId,
          kind: entry.kind,
          status: entry.status,
          requestedAt: entry.requestedAt,
          resolvedAt: entry.resolvedAt,
          resolution: entry.resolution,
          summary: { toolName: entry.toolName, arguments: entry.arguments },
          presentation: entry.presentation,
          claimOwner: null,
          claimExpiresAt: null,
          envelopeVersion: 1,
          expectedAttemptRevision: entry.expectedAttemptRevision,
          expectedAttemptStatus: entry.expectedAttemptStatus,
          requestedActionDigest: entry.requestedActionDigest,
          frozenContextHash: entry.frozenContextHash,
          revision: entry.revision,
        },
      };
      this.activeImageAttemptId = entry.attemptId;
      this.emit({ kind: 'status', at: nowIso(), summary: 'Restored a pending media approval from before the restart', eventType: 'image_generation_needs_input' });
    } catch (err) {
      this.options.log?.(`pending media approval restore failed: ${(err as Error).message}`);
    }
  }

  async cancelImageGeneration(): Promise<void> {
    if (!this.activeImageAttemptId) return;
    await this.requireClient().cancelCapabilityAction(this.activeImageAttemptId);
    this.activeImageAttemptId = null;
    this.pendingImageApproval = null;
  }

  /** Mirrors generateImage()/resolveImageApproval() for the get_weather
   * capability: weather is an external network call, so — like web
   * research — it is always approval-gated, never auto-run, regardless of
   * how harmless the data itself is. */
  async getWeather(location: string): Promise<DesktopWeatherResult> {
    const trimmed = location.replace(/\s+/g, ' ').trim();
    if (!trimmed) return { outcome: 'failed', reason: 'A location is required' };
    const correlationId = await this.ensureCapabilityConversation(`Weather: ${trimmed}`);
    const arguments_ = { location: trimmed };
    const result = await this.requireClient().dispatchCapability({
      correlationId,
      toolName: 'get_weather',
      arguments: arguments_,
      cwd: this.folder ?? this.dataDir,
    });
    this.activeWeatherAttemptId = result.attemptId;
    if (result.outcome === 'approval_required') {
      this.pendingWeatherApproval = { arguments: arguments_, approval: result.approval, correlationId };
      this.emit({ kind: 'status', at: nowIso(), summary: 'Weather lookup ready for your approval', eventType: 'weather_needs_input' });
    }
    return toWeatherResult(result);
  }

  async resolveWeatherApproval(approvalId: string, resolution: DesktopApprovalResolution): Promise<DesktopWeatherResult> {
    const held = this.pendingWeatherApproval;
    if (!held || held.approval.id !== approvalId) throw new Error('no matching pending weather approval');
    this.pendingWeatherApproval = null;
    const client = this.requireClient();
    await client.resolveCapabilityApproval(approvalId, {
      resolution,
      attemptId: held.approval.attemptId,
      expectedAttemptRevision: held.approval.expectedAttemptRevision,
      expectedAttemptStatus: held.approval.expectedAttemptStatus,
      requestedActionDigest: held.approval.requestedActionDigest,
      frozenContextHash: held.approval.frozenContextHash,
    });
    if (resolution === 'rejected') {
      this.activeWeatherAttemptId = null;
      return { outcome: 'denied', attemptId: held.approval.attemptId, reason: 'rejected by operator' };
    }
    try {
      const result = await client.dispatchCapability({
        correlationId: held.correlationId,
        toolName: 'get_weather',
        arguments: held.arguments,
        cwd: this.folder ?? this.dataDir,
      });
      const view = toWeatherResult(result);
      if (view.outcome === 'executed') {
        // Surfaced as a normal answer in the conversation, the same way
        // Everyday Tools intents report their result — weather has no
        // separate gallery/tab of its own to redirect to.
        this.emit({
          kind: 'result', at: nowIso(),
          attemptId: this.active?.attemptId, requestId: this.active?.requestId,
          summary: 'Weather', text: view.message,
        });
      } else {
        this.emit({ kind: 'status', at: nowIso(), summary: `Weather lookup ${view.outcome}`, eventType: 'weather_failed' });
      }
      return view;
    } catch (error) {
      const reason = compactCapabilityFailure(error);
      this.emit({ kind: 'status', at: nowIso(), summary: reason, eventType: 'weather_failed' });
      return { outcome: 'failed', attemptId: held.approval.attemptId, reason };
    } finally {
      this.activeWeatherAttemptId = null;
    }
  }

  async cancelWeatherLookup(): Promise<void> {
    if (!this.activeWeatherAttemptId) return;
    await this.requireClient().cancelCapabilityAction(this.activeWeatherAttemptId);
    this.activeWeatherAttemptId = null;
    this.pendingWeatherApproval = null;
  }

  /** Start Core-governed research. This only creates the pending network
   * approval; no provider request occurs until the exact digest is approved. */
  async startWebResearch(query: string): Promise<DesktopResearchApprovalView> {
    const normalized = query.replace(/\s+/g, ' ').trim();
    if (!normalized) throw new Error('Enter a research question first');
    const client = this.requireClient();
    let conversationId = this.selectedConversationId ?? this.voiceConversationId;
    if (!conversationId) {
      const conversation = await client.createConversation({
        mode: 'baat_kar',
        title: normalized.slice(0, 80),
      });
      conversationId = conversation.id;
      this.voiceConversationId = conversationId;
      this.selectedConversationId = conversationId;
      writeSelectedConversation(this.dataDir, conversationId);
    }
    const { session, approval } = await client.createResearch(conversationId, normalized);
    return {
      researchId: session.id,
      conversationId,
      approvalId: approval.id,
      requestedActionDigest: approval.requestedActionDigest,
      provider: approval.summary.provider,
      queryPreview: approval.summary.queryPreview,
      maxSources: approval.summary.maxSources,
    };
  }

  async resolveWebResearch(input: DesktopResearchApprovalView, resolution: 'approved' | 'rejected'): Promise<DesktopResearchResultView> {
    await this.requireClient().resolveResearch(input.researchId, {
      approvalId: input.approvalId,
      requestedActionDigest: input.requestedActionDigest,
      resolution,
    });
    return this.getWebResearch(input.researchId);
  }

  async getWebResearch(researchId: string): Promise<DesktopResearchResultView> {
    const client = this.requireClient();
    const { session, sources } = await client.getResearch(researchId);
    const { messages } = await client.listMessages(session.conversationId, { limit: 2000 });
    const origin = messages.find((message) => message.id === session.originatingUserMessageId);
    const answer = origin
      ? messages.filter((message) => message.seq > origin.seq && message.role === 'assistant').at(-1)?.content ?? null
      : null;
    return {
      researchId: session.id,
      conversationId: session.conversationId,
      query: session.normalizedQuery,
      state: session.state,
      answer,
      failureClassification: session.failureClassification,
      sources: sources.map((source) => ({
        rank: source.resultRank,
        title: source.title?.trim() || 'Untitled source',
        url: source.finalUrl ?? (source.status === 'fetched' ? source.normalizedUrl : null),
        status: source.status,
      })),
    };
  }

  /**
   * "What's on my plate today?" — answered from real sources, without a model
   * call.
   *
   * The brief comes straight from Core: pending approvals, running and
   * interrupted work, completed results, and — when they are connected —
   * today's calendar and the unread inbox. A service that is not connected is
   * reported as not connected. The answer is written into the Core
   * conversation, so it survives a restart and stays discoverable from the
   * rail.
   */
  private async handleAssistantBriefIntent(
    text: string,
    clientOrigin: 'desktop' | 'mobile' = 'desktop',
  ): Promise<{ requestId: string; attemptId: string; model: string }> {
    if (this.active && !this.active.terminal) throw new Error('a task is already running');
    const client = this.requireClient();
    this.interactionMode = 'chat';
    this.lastTurnOutcome = null;
    this.turnOutcomeKind = null;
    this.blockedReason = null;
    this.taskScope = null;
    const requestId = `brief_req_${Date.now()}`;
    const attemptId = `brief_att_${Date.now()}`;
    const conversationId = await this.ensureCapabilityConversation('Today');
    this.active = {
      attemptId,
      requestId,
      conversationId,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.emit({
      kind: 'status',
      at: nowIso(),
      requestId,
      attemptId,
      summary: 'Reading your brief from Core',
      clientOrigin,
    });
    try {
      const brief = await this.getAssistantBrief({ external: true });
      await this.recordConversationMessage(conversationId, 'user', text);
      await this.recordConversationMessage(conversationId, 'assistant', brief.markdown);
      this.active.terminal = true;
      this.lastTurnOutcome = 'completed';
      this.turnOutcomeKind = 'answered';
      this.emit({
        kind: 'result',
        at: nowIso(),
        requestId,
        attemptId,
        summary: 'Your brief',
        text: brief.markdown,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      return { requestId, attemptId, model: 'assistant-brief' };
    } catch (err) {
      this.active.terminal = true;
      this.lastTurnOutcome = 'failed';
      this.turnOutcomeKind = 'failed';
      this.emit({
        kind: 'error',
        at: nowIso(),
        requestId,
        attemptId,
        summary: (err as Error).message,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      throw err;
    }
  }

  private async handleEverydayIntent(
    text: string,
    intent: NonNullable<ReturnType<typeof parseEverydayIntent>>,
    clientOrigin: 'desktop' | 'mobile' = 'desktop',
  ): Promise<{ requestId: string; attemptId: string; model: string }> {
    if (this.active && !this.active.terminal) throw new Error('a task is already running');
    const client = this.requireClient();
    this.interactionMode = 'chat';
    this.lastTurnOutcome = null;
    this.turnOutcomeKind = null;
    this.blockedReason = null;
    this.taskScope = null;
    const requestId = `everyday_req_${Date.now()}`;
    const attemptId = `everyday_att_${Date.now()}`;
    this.active = {
      attemptId,
      requestId,
      conversationId: this.voiceConversationId ?? `everyday_${Date.now()}`,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.emit({ kind: 'status', at: nowIso(), requestId, attemptId, summary: 'Everyday Tools (no repository required)', clientOrigin });

    let reply = '';
    try {
      if (intent.kind === 'remember_note') {
        const note = await client.createEverydayNote({ body: intent.body });
        reply = `Saved note: ${note.body}`;
      } else if (intent.kind === 'find_notes') {
        const { notes } = await client.listEverydayNotes(intent.query);
        reply = notes.length === 0
          ? `I could not find notes matching “${intent.query}”.`
          : `Found ${notes.length} note${notes.length === 1 ? '' : 's'}:\n${notes.map((n) => `• ${n.body}`).join('\n')}`;
      } else if (intent.kind === 'create_reminder') {
        const timezone = hostTimezone();
        const reminder = await client.createEverydayReminder({
          title: intent.title,
          dueAt: intent.dueAt,
          timezone,
        }) as { dueAt: string; title: string };
        const local = formatLocalInstant(reminder.dueAt, timezone);
        reply = `Reminder set for ${intent.relativeLabel} (${local}, ${timezone}): ${reminder.title}. Desktop alert will fire if Jarvis is still running.`;
      } else if (intent.kind === 'queue_add') {
        await client.enqueueCommand({ instruction: intent.instruction, source: 'text' });
        await this.refreshCommandQueue();
        await this.offerNextQueuedCommand();
        reply = `Added to queue: ${intent.instruction}. I will ask for fresh confirmation before it runs.`;
      } else if (intent.kind === 'list_reminders') {
        const { reminders } = await client.listEverydayReminders('open');
        reply = reminders.length === 0
          ? 'You have no open reminders.'
          : `Open reminders:\n${reminders.map((r) => {
            const title = String(r.title ?? '');
            const dueAt = String(r.dueAt ?? '');
            const tz = String(r.timezone ?? hostTimezone());
            const overdue = r.overdue ? ' (overdue)' : '';
            return `• ${title} — ${formatLocalInstant(dueAt, tz)}${overdue}`;
          }).join('\n')}`;
      } else if (intent.kind === 'complete_reminder' || intent.kind === 'cancel_reminder') {
        const { reminders } = await client.listEverydayReminders('open');
        const q = intent.query.toLowerCase();
        const match = reminders.find((r) => String(r.title ?? '').toLowerCase().includes(q)
          || String(r.id ?? '').toLowerCase() === q);
        if (!match) {
          reply = `No open reminder matched “${intent.query}”.`;
        } else if (intent.kind === 'complete_reminder') {
          await client.completeEverydayReminder(String(match.id));
          reply = `Completed reminder: ${String(match.title)}`;
        } else {
          await client.cancelEverydayReminder(String(match.id));
          reply = `Cancelled reminder: ${String(match.title)}`;
        }
      }
      await this.refreshEverydayTools();
      this.active.terminal = true;
      this.lastTurnOutcome = 'completed';
      this.turnOutcomeKind = 'answered';
      this.emit({
        kind: 'result',
        at: nowIso(),
        requestId,
        attemptId,
        summary: 'Everyday Tools result',
        text: reply,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      return { requestId, attemptId, model: 'everyday-tools' };
    } catch (err) {
      this.active.terminal = true;
      this.lastTurnOutcome = 'failed';
      this.turnOutcomeKind = 'failed';
      this.emit({
        kind: 'error',
        at: nowIso(),
        requestId,
        attemptId,
        summary: (err as Error).message,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      throw err;
    }
  }

  /** A chat message phrased as an image request ("generate an image of…")
   * is routed to the same governed image_generate capability the Image
   * Studio panel uses — same exact-approval card, same Core artifact, same
   * gallery — rather than the general model tool-calling loop, which cannot
   * offer that per-request precision. See `detectImageGenerationIntent`. */
  /** Decides whether a chat message is a media request: a new image, an edit
   * or variations of the conversation's latest image, a text-to-video clip,
   * or animating the latest image. */
  private async planMediaRequest(text: string, staged: StagedForSend[] = []): Promise<MediaPlan | null> {
    const followUp = detectImageFollowUp(text);
    const videoAsk = detectVideoGenerationIntent(text);
    const attachedImage = staged.find((item) => item.kind === 'image');
    if (attachedImage && followUp) {
      // "Make the sky purple" with a picture attached: that picture is the one to edit.
      const original = attachedImage.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      if (followUp.kind === 'animate') {
        return { toolName: 'video_generate', label: 'an animation of your image', prompt: `${original}, gentle cinematic camera movement`, arguments: { seconds: 4 }, attachedImage };
      }
      if (followUp.kind === 'variations') {
        return { toolName: 'image_generate', label: `${followUp.count} variations of your image`, prompt: original, arguments: { denoise: 0.5, outputCount: followUp.count }, attachedImage };
      }
      const sceneChange = /\b(background|scene|season|weather|sky)\b/i.test(text);
      return { toolName: 'image_generate', label: 'an edited version of your image', prompt: composeEditPrompt(original, text), arguments: { denoise: sceneChange ? 0.78 : 0.6, outputCount: 1 }, attachedImage };
    }
    let lastImage: import('../../../../core/shared/wireTypes').ArtifactRecord | null = null;
    if (followUp && this.selectedConversationId && this.client && this.coreState === 'connected') {
      try {
        const { artifacts } = await this.client.listArtifacts(this.selectedConversationId);
        lastImage = artifacts.filter((a) => a.kind === 'image' && a.availability === 'ready')
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
      } catch { /* no reference: treat as a fresh request */ }
    }
    if (lastImage && followUp) {
      const original = String(lastImage.metadata?.prompt ?? lastImage.title);
      const checkpoint = typeof lastImage.metadata?.checkpoint === 'string' ? lastImage.metadata.checkpoint : '';
      if (followUp.kind === 'animate') {
        return { toolName: 'video_generate', label: 'an animation of your image', prompt: `${original}, gentle cinematic camera movement`, arguments: { startArtifactId: lastImage.id, seconds: 4 } };
      }
      if (followUp.kind === 'variations') {
        return { toolName: 'image_generate', label: `${followUp.count} variations of your image`, prompt: original, checkpoint, arguments: { referenceArtifactId: lastImage.id, denoise: 0.5, outputCount: followUp.count } };
      }
      // Background/scene swaps need more freedom than small touch-ups.
      const sceneChange = /\b(background|scene|season|weather|sky)\b/i.test(text);
      return { toolName: 'image_generate', label: 'an edited version of your image', prompt: composeEditPrompt(original, text), checkpoint, arguments: { referenceArtifactId: lastImage.id, denoise: sceneChange ? 0.78 : 0.6, outputCount: 1 } };
    }
    if (videoAsk) return { toolName: 'video_generate', label: 'a short video', prompt: extractVideoPrompt(text), arguments: { seconds: 4 } };
    if (detectImageGenerationIntent(text)) return { toolName: 'image_generate', label: 'an image', prompt: extractImageGenerationPrompt(text), arguments: { outputCount: 1 } };
    return null;
  }

  private async handleImageGenerationIntent(text: string, clientOrigin: 'desktop' | 'mobile' = 'desktop', plan?: MediaPlan): Promise<{ requestId: string; attemptId: string; model: string }> {
    const media: MediaPlan = plan ?? { toolName: 'image_generate', label: 'an image', prompt: extractImageGenerationPrompt(text), arguments: { outputCount: 1 } };
    if (this.active && !this.active.terminal) throw new Error('a task is already running');
    this.interactionMode = 'chat';
    this.lastTurnOutcome = null;
    this.turnOutcomeKind = null;
    this.blockedReason = null;
    this.taskScope = null;
    const requestId = `image_req_${Date.now()}`;
    const attemptId = `image_att_${Date.now()}`;
    this.active = {
      attemptId,
      requestId,
      conversationId: this.voiceConversationId ?? `image_${Date.now()}`,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.emit({ kind: 'status', at: nowIso(), requestId, attemptId, summary: 'Routing to Image Generation Studio (no repository required)', clientOrigin });

    let reply = '';
    try {
      const prompt = media.prompt;
      const isVideo = media.toolName === 'video_generate';
      const conversationId = await this.ensureCapabilityConversation(`${isVideo ? 'Video' : 'Image'}: ${prompt}`);
      this.active.conversationId = conversationId;
      await this.recordConversationMessage(conversationId, 'user', text);
      if (media.attachedImage) {
        // Register the attached picture as a durable artifact so Image Studio can use it as the reference.
        const keepDir = path.join(this.dataDir, 'attachment-references');
        fs.mkdirSync(keepDir, { recursive: true });
        const keepPath = path.join(keepDir, `${Date.now()}-${media.attachedImage.name}`);
        fs.copyFileSync(media.attachedImage.filePath, keepPath);
        const reference = await this.requireClient().registerArtifact({
          conversationId, kind: 'image', title: media.attachedImage.name, mimeType: media.attachedImage.mimeType, absolutePath: keepPath, source: 'user_attachment',
        });
        media.arguments = { ...media.arguments, ...(media.toolName === 'video_generate' ? { startArtifactId: reference.id } : { referenceArtifactId: reference.id }) };
      }
      let status = await this.probeImageStudio();
      if (!status.studio || !status.comfyui) {
        // Start the local studio on demand instead of asking the user to.
        const ensure = this.options.ensureImageStudio
          ?? ((onStatus?: (text: string) => void) => ensureImageStudioServices({}, onStatus));
        this.emit({ kind: 'status', at: nowIso(), requestId, attemptId, summary: 'Starting the local Image Studio (first image after startup takes a minute)…', eventType: 'image_generation_startup', clientOrigin });
        await ensure((summary) => this.emit({ kind: 'status', at: nowIso(), requestId, attemptId, summary, eventType: 'image_generation_startup', clientOrigin }));
        status = await this.probeImageStudio();
      }
      const checkpoint = isVideo ? 'ltx-video' : (media.checkpoint || selectImageCheckpoint(prompt, status.checkpoints));
      if (!checkpoint) {
        throw new Error(status.studio && status.comfyui
          ? 'Image Studio is running but reports no image model (checkpoint). Add a checkpoint in ComfyUI\'s models/checkpoints folder, then ask again.'
          : `Image Studio could not be started: ${status.detail}.`);
      }
      const result = await this.generateImage(isVideo
        ? { prompt, ...media.arguments }
        : { prompt, checkpoint, width: 1024, height: 1024, steps: 20, ...media.arguments }, media.toolName);
      if (result.outcome === 'approval_required') {
        reply = isVideo
          ? `I've prepared ${media.label} — prompt: "${prompt}" (about ${Number(media.arguments.seconds ?? 4)} s, LTX-Video). Approve it in the card below; it runs on this PC's GPU and takes a few minutes.`
          : `I've prepared ${media.label} — prompt: "${prompt}", checkpoint: ${checkpoint}. Approve it in the card below to start; it runs on this PC's GPU.`;
        await this.recordConversationMessage(conversationId, 'assistant', reply);
        // Keep active.terminal = false while awaiting approval so the task is truthfully represented
        this.emit({ kind: 'approval', at: nowIso(), requestId, attemptId, summary: reply, text: reply, clientOrigin });
        return { requestId, attemptId: result.attemptId ?? attemptId, model: 'image-studio' };
      } else if (result.outcome === 'executed') {
        reply = result.message;
      } else {
        reply = result.reason;
      }
      this.active.terminal = true;
      const failed = result.outcome === 'failed' || result.outcome === 'unavailable' || result.outcome === 'denied';
      this.lastTurnOutcome = failed ? 'failed' : 'completed';
      this.turnOutcomeKind = failed ? 'failed' : 'answered';
      this.emit({ kind: 'result', at: nowIso(), requestId, attemptId, summary: 'Image Generation Studio', text: reply, clientOrigin });
      this.drainSubmissionQueue();
      return { requestId, attemptId: result.attemptId ?? attemptId, model: 'image-studio' };
    } catch (err) {
      this.active.terminal = true;
      this.lastTurnOutcome = 'failed';
      this.turnOutcomeKind = 'failed';
      // Show the actual reason in the conversation, not just a "Failed" label.
      const failureText = `I couldn't generate the image: ${(err as Error).message}`;
      if (!this.active.conversationId.startsWith('image_')) await this.recordConversationMessage(this.active.conversationId, 'assistant', failureText);
      this.emit({ kind: 'result', at: nowIso(), requestId, attemptId, summary: 'Image Generation Studio', text: failureText, clientOrigin });
      this.emit({
        kind: 'error',
        at: nowIso(),
        requestId,
        attemptId,
        summary: (err as Error).message,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      throw err;
    }
  }

  /** Mirrors handleImageGenerationIntent for a weather question, since plain
   * chat has no tool access at all — see detectWeatherIntent. Approval shows
   * inline in the main chat/approval panel (get_weather has no gallery/tab
   * of its own to redirect to the way images do). */
  private async handleWeatherIntent(text: string, clientOrigin: 'desktop' | 'mobile' = 'desktop'): Promise<{ requestId: string; attemptId: string; model: string }> {
    if (this.active && !this.active.terminal) throw new Error('a task is already running');
    this.interactionMode = 'chat';
    this.lastTurnOutcome = null;
    this.turnOutcomeKind = null;
    this.blockedReason = null;
    this.taskScope = null;
    const requestId = `weather_req_${Date.now()}`;
    const attemptId = `weather_att_${Date.now()}`;
    this.active = {
      attemptId,
      requestId,
      conversationId: this.voiceConversationId ?? `weather_${Date.now()}`,
      goal: text,
      tokenBuffer: '',
      terminal: false,
      clientOrigin,
    };
    this.cockpitEvents = [];
    this.emit({ kind: 'status', at: nowIso(), requestId, attemptId, summary: 'Looking up weather (no repository required)', clientOrigin });

    let reply = '';
    try {
      // A bare follow-up ("will it rain?" right after "weather in Ulm?")
      // has no place name of its own — reuse the last location resolved
      // in this conversation rather than making the user repeat it, the
      // same way a human would infer it from context.
      const explicitLocation = extractWeatherLocation(text);
      const location = explicitLocation ?? this.lastWeatherLocation;
      if (!location) {
        // Missing a place name is an ordinary conversational turn, not a
        // failure — asking the user to clarify must not throw. A thrown
        // error here previously surfaced as a raw
        // "Error invoking remote method 'desktop:submitTask'" IPC failure
        // instead of a normal spoken/answered reply.
        reply = 'Which location? Ask again with a place name, e.g. "what is the weather in Ulm".';
        this.active.terminal = true;
        this.lastTurnOutcome = 'completed';
        this.turnOutcomeKind = 'answered';
        this.awaitingWeatherLocation = true;
        this.emit({ kind: 'result', at: nowIso(), requestId, attemptId, summary: 'Weather', text: reply, clientOrigin });
        this.drainSubmissionQueue();
        return { requestId, attemptId, model: 'weather' };
      }
      this.awaitingWeatherLocation = false;
      this.lastWeatherLocation = location;
      const result = await this.getWeather(location);
      if (result.outcome === 'approval_required') {
        reply = `I've prepared a weather lookup for "${location}". Approve it below to get the answer.`;
        await this.recordConversationMessage(this.active.conversationId, 'assistant', reply);
        this.emit({ kind: 'approval', at: nowIso(), requestId, attemptId, summary: reply, text: reply, clientOrigin });
        return { requestId, attemptId: result.attemptId ?? attemptId, model: 'weather' };
      } else if (result.outcome === 'executed') {
        reply = result.message;
      } else {
        reply = result.reason;
      }
      this.active.terminal = true;
      const failed = result.outcome === 'failed' || result.outcome === 'unavailable' || result.outcome === 'denied';
      this.lastTurnOutcome = failed ? 'failed' : 'completed';
      this.turnOutcomeKind = failed ? 'failed' : 'answered';
      this.emit({ kind: 'result', at: nowIso(), requestId, attemptId, summary: 'Weather', text: reply, clientOrigin });
      this.drainSubmissionQueue();
      return { requestId, attemptId: result.attemptId ?? attemptId, model: 'weather' };
    } catch (err) {
      this.active.terminal = true;
      this.lastTurnOutcome = 'failed';
      this.turnOutcomeKind = 'failed';
      this.emit({
        kind: 'error',
        at: nowIso(),
        requestId,
        attemptId,
        summary: (err as Error).message,
        clientOrigin,
      });
      this.drainSubmissionQueue();
      throw err;
    }
  }

  private requireClient(): CoreClient {
    if (!this.client || this.coreState !== 'connected') {
      throw new Error(this.coreDetail ?? 'Core is not connected');
    }
    return this.client;
  }

  private refreshProvider(): void {
    this.provider = resolveDesktopProviderConfig({
      selectedWorkspaceRoot: this.folder,
      productRoot: this.options.productRoot,
      selectedModelOverride: this.operatorSelectedModel === AUTO_MODEL ? null : this.operatorSelectedModel,
    });
  }

  /** Soft refresh used when listing models before a selection exists. */
  private refreshProviderSoft(): void {
    try {
      this.refreshProvider();
    } catch {
      this.provider = {
        providerType: 'ollama',
        apiBase: 'http://127.0.0.1:11434',
        model: this.operatorSelectedModel === AUTO_MODEL ? '' : this.operatorSelectedModel ?? '',
        routingPolicy: 'local-only',
        source: 'unset',
      };
    }
  }

  private async refreshModelAvailability(): Promise<void> {
    if (this.operatorSelectedModel === AUTO_MODEL) {
      this.refreshProviderSoft();
      this.modelAvailable = null;
      return;
    }
    try {
      this.refreshProvider();
    } catch (err) {
      this.modelAvailable = false;
      this.provider = undefined;
      this.coreDetail = (err as Error).message;
      return;
    }
    if (!this.provider?.model) {
      this.modelAvailable = false;
      return;
    }
    try {
      await assertLocalModelInstalled(this.provider.apiBase, this.provider.model);
      this.modelAvailable = true;
    } catch (err) {
      this.modelAvailable = false;
      // Fail closed, never silently substitute another model — the operator's
      // explicit selection was removed from Ollama since it was chosen.
      const detail = `Selected model '${this.provider.model}' is not installed. Select an installed model.`;
      this.coreDetail = detail;
      this.emit({ kind: 'error', at: nowIso(), summary: detail });
    }
  }

  private handleToken(frame: RuntimeTokenFrame): void {
    if (!this.active || this.active.terminal || this.active.attemptId !== frame.attemptId) return;
    if (!this.active.firstTokenLogged) {
      this.active.firstTokenLogged = true;
      const turnTag = this.active.voiceTurnId ? ` turn=${this.active.voiceTurnId}` : '';
      this.options.log?.(
        `[voice]${turnTag} stage=first_token requestId=${this.active.requestId} attemptId=${frame.attemptId}`,
      );
    }
    this.active.tokenBuffer += frame.delta;
    const now = Date.now();
    const stat = this.tokenStats.get(frame.attemptId);
    if (stat) { stat.lastAt = now; stat.chunks += 1; } else {
      if (this.tokenStats.size > 40) this.tokenStats.delete(this.tokenStats.keys().next().value as string);
      this.tokenStats.set(frame.attemptId, { firstAt: now, lastAt: now, chunks: 1 });
    }
    this.emit({
      kind: 'token',
      at: nowIso(),
      attemptId: frame.attemptId,
      summary: 'token',
      text: frame.delta,
    });
  }

  private async handleRuntimeEvent(event: RuntimeEventRecord): Promise<void> {
    if (event.domain === 'approval' && (event.eventType === 'approval_requested' || event.eventType === 'approval_resolved' || event.eventType === 'approval_superseded' || event.eventType === 'approval_expired')) {
      // A pending approval changed somewhere (this turn or another surface).
      // Home must re-read Core so the card appears and disappears truthfully.
      this.emit({
        kind: 'assistant_approval_changed',
        at: event.createdAt,
        summary: event.eventType,
      });
      // The turn that is running here still has to update its own card below:
      // an expired request must stop being actionable on screen too, and the
      // operator must be told that nothing was approved. Only when there is no
      // live turn is there nothing else to do.
      if (!this.active || this.active.terminal) return;
    }
    // The worker that was waiting for this turn's answer is gone (Core restarted). The turn is interrupted, not
    // running: it must stop holding the active slot, or every later message would queue behind a ghost.
    if (event.domain === 'attempt' && event.eventType === 'attempt_approval_orphaned'
      && this.active && !this.active.terminal && this.active.attemptId === event.entityId) {
      this.active.terminal = true;
      this.lastTurnOutcome = 'failed';
      this.turnOutcomeKind = 'failed';
      this.pending = undefined;
      this.emit({
        kind: 'status',
        at: event.createdAt,
        attemptId: event.entityId,
        summary: 'This task was interrupted when Core restarted. It is not running. Resume it from Tasks to be asked again.',
      });
      this.drainSubmissionQueue();
      return;
    }
    if (event.domain === 'assistant_routine' && event.eventType === 'daily_brief_delivered') {
      // Pandesh's daily routine fired. The brief itself is a durable Core
      // message in its own conversation; the host only announces it so the
      // renderer refetches and the operator gets one notification.
      this.emit({
        kind: 'conversation_message',
        at: event.createdAt,
        conversationId: String(event.metadata?.['conversationId'] ?? ''),
        domain: event.domain,
        eventType: event.eventType,
        summary: String(event.metadata?.['title'] ?? 'Your daily brief is ready'),
        text: String(event.metadata?.['body'] ?? ''),
      });
      return;
    }
    // An answer Core stored for a side question (or any reply) while a task is working must reach the open chat now,
    // not only after the task ends. The running task keeps its own card and live reply.
    if (event.domain === 'conversation' && event.eventType === 'message_appended' && this.active && !this.active.terminal
      && event.entityId === this.active.conversationId && event.metadata?.['role'] === 'assistant') {
      this.emit({ kind: 'conversation_message', at: event.createdAt, conversationId: event.entityId, domain: event.domain, eventType: event.eventType, messageRole: 'assistant', summary: 'message appended' });
    }
    if (event.domain === 'conversation' && event.eventType === 'message_appended' && !(this.active && !this.active.terminal)) {
      // A message Core posted on its own (development-story progress/final report): let the open chat refetch.
      this.emit({ kind: 'conversation_message', at: event.createdAt, conversationId: event.entityId, domain: event.domain, eventType: event.eventType, summary: 'message appended' });
      return;
    }
    if (event.domain === 'background_task' && event.eventType === 'background_task_completed') {
      this.emit({
        kind: 'activity',
        at: event.createdAt,
        eventType: event.eventType,
        domain: event.domain,
        summary: String(event.metadata?.['summary'] ?? 'Background task completed'),
        title: String(event.metadata?.['title'] ?? 'Task Completed'),
        text: String(event.metadata?.['text'] ?? ''),
        metadata: event.metadata,
      } as any);
      return;
    }
    const attemptId = event.domain === 'attempt' || event.domain === 'execution_quality'
      ? event.entityId
      : String(event.metadata?.['attemptId'] ?? '');
    if (!this.active || this.active.terminal) return;
    if (attemptId && attemptId !== this.active.attemptId) return;
    if (!attemptId && (event.domain === 'model_invocation' || event.domain === 'tool_invocation')) return;

    if (event.eventType === 'model_selection_decided') {
      if (typeof event.metadata?.['selectedModel'] === 'string') this.activeModel = String(event.metadata['selectedModel']);
      if (typeof event.metadata?.['contextWindowTokens'] === 'number') this.activeContextEnvelope = Number(event.metadata['contextWindowTokens']);
    }

    if (event.domain === 'tool_invocation') {
      const toolName = String(event.metadata?.['toolName'] ?? 'unknown_tool');
      const status = String(event.metadata?.['status'] ?? 'completed');
      const output = toolOutput(event.metadata);
      const summary = event.eventType === 'tool_invocation_started'
        ? `tool start: ${toolName} ${summarizeArgs(event.metadata?.['argsSummary'])}`
        : `tool ${status}: ${toolName}${output ? ` ${output}` : ''}`;
      this.emit({
        kind: 'activity',
        at: event.createdAt,
        attemptId: this.active.attemptId,
        requestId: this.active.requestId,
        eventType: event.eventType,
        domain: event.domain,
        toolName,
        invocationId: event.entityId,
        invocationStatus: status,
        toolArgs: event.metadata?.['argsSummary'] as Record<string, unknown> | undefined,
        check: toolCheck(event.metadata),
        summary,
      });
      this.recordEvidence({ type: 'runtime-event', event });
      return;
    }

    if (event.domain === 'model_invocation') {
      this.emit({
        kind: 'activity',
        at: event.createdAt,
        attemptId: this.active.attemptId,
        requestId: this.active.requestId,
        eventType: event.eventType,
        domain: event.domain,
        summary: `${event.domain}:${event.eventType}`,
        invocationId: event.entityId,
        invocationStatus: String(event.metadata?.['status'] ?? ''),
        promptTokens: asFiniteNumber(event.metadata?.['promptTokens']),
        completionTokens: asFiniteNumber(event.metadata?.['completionTokens']),
        generationMs: asFiniteNumber(event.metadata?.['generationMs']),
        durationMs: asFiniteNumber(event.metadata?.['durationMs']),
        costUsd: asFiniteNumber(event.metadata?.['costUsd']),
      });
      this.recordEvidence({ type: 'runtime-event', event });
      return;
    }

    if (event.eventType === 'approval_expired' && this.pending?.envelope.approvalId === event.entityId) {
      // Nobody answered the approval request, so Core retired it. The card must
      // not stay on screen as if it were still actionable, and the truth is
      // that nothing was approved — not that the user refused.
      this.pending = undefined;
      this.emit({
        kind: 'status',
        at: nowIso(),
        attemptId: this.active.attemptId,
        requestId: this.active.requestId,
        summary: 'The approval request expired without an answer. Nothing was approved.',
      });
      return;
    }

    if (event.domain !== 'attempt') {
      this.emit({
        kind: 'activity',
        at: event.createdAt,
        attemptId: this.active.attemptId,
        requestId: this.active.requestId,
        eventType: event.eventType,
        domain: event.domain,
        summary: `${event.domain}:${event.eventType}`,
      });
      this.recordEvidence({ type: 'runtime-event', event });
      return;
    }

    this.emit({
      kind: 'activity',
      at: event.createdAt,
      attemptId: this.active.attemptId,
      requestId: this.active.requestId,
      eventType: event.eventType,
      domain: event.domain,
      summary: `attempt ${event.eventType}${event.metadata?.['to'] ? ` → ${String(event.metadata['to'])}` : ''}`,
    });
    this.recordEvidence({ type: 'runtime-event', event });

    if (event.eventType === 'attempt_transitioned' && event.metadata?.['to'] === 'waiting_for_approval') {
      await this.loadPendingApproval();
      return;
    }
    if (event.eventType === 'attempt_transitioned' && event.metadata?.['to'] === 'completed') {
      await this.finishTurn('completed');
    } else if (event.eventType === 'attempt_failed') {
      await this.finishTurn('failed', String(event.metadata?.['failureReason'] ?? 'execution failed'));
    } else if (event.eventType === 'attempt_cancelled') {
      await this.finishTurn('cancelled');
    }
  }

  private async loadPendingApproval(): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    const client = this.requireClient();
    let selected = null as ReturnType<typeof selectActionableApproval>;
    for (let attempt = 0; attempt < 15; attempt++) {
      const snapshot = await client.listCapabilityActions(active.conversationId);
      selected = snapshot.actions.find((action) => action.actionable && action.status === 'pending' && action.attemptId === active.attemptId)
        ?? selectActionableApproval(snapshot.actions);
      if (selected) break;
      await sleep(60);
    }
    if (!selected) {
      this.emit({
        kind: 'error',
        at: nowIso(),
        attemptId: active.attemptId,
        requestId: active.requestId,
        summary: 'waiting for approval but Core has no actionable gate',
      });
      return;
    }
    this.pending = {
      card: toDesktopApprovalCard(selected),
      envelope: toApprovalEnvelope(selected),
    };
    this.recordEvidence({
      type: 'pending-approval',
      approvalId: this.pending.card.approvalId,
      gate: this.pending.card.gate,
      toolName: this.pending.card.toolName,
      scope: this.pending.card.scope,
      requestedActionDigest: this.pending.envelope.requestedActionDigest,
      frozenContextHash: this.pending.envelope.frozenContextHash,
    });
    if (classifyDesktopApproval(this.taskScope, this.pending.card) === 'auto_approve') {
      this.emit({
        kind: 'status',
        at: nowIso(),
        attemptId: active.attemptId,
        requestId: active.requestId,
        summary: `In-scope Core gate auto-authorized: ${this.pending.card.scope}`,
      });
      await this.resolvePending(this.pending.card.approvalId, 'approved');
      return;
    }
    this.emit({
      kind: 'approval',
      at: nowIso(),
      attemptId: active.attemptId,
      requestId: active.requestId,
      summary: `Waiting for ${this.pending.card.gate} approval: ${this.pending.card.scope}`,
    });
  }

  private async attemptChangedFiles(active: { attemptId: string; requestId: string; conversationId: string }): Promise<boolean> {
    const cockpit = projectMissionCockpit(this.cockpitEvents, {
      requestId: active.requestId, attemptId: active.attemptId, running: false, terminal: true,
      pendingApproval: null, approvedApproval: this.approvedApproval, startedAt: this.missionStartedAt, nowMs: Date.now(),
    } as Parameters<typeof projectMissionCockpit>[1]);
    if ((cockpit.filesChanged?.length ?? 0) > 0) return true;
    try {
      const { artifacts } = await this.requireClient().listArtifacts(active.conversationId);
      return artifacts.some((artifact) => artifact.attemptId === active.attemptId && artifact.kind === 'file');
    } catch {
      return true; // cannot verify: keep the engine's own classification
    }
  }

  private async finishTurn(outcome: 'completed' | 'failed' | 'cancelled', detail?: string): Promise<void> {
    const active = this.active;
    if (!active || active.terminal) return;
    active.terminal = true;
    this.lastTurnOutcome = outcome;
    this.turnOutcomeKind = classifyTurnOutcomeKind({ outcome, mode: this.interactionMode });
    // "Repository updated" only with evidence that files changed in this
    // attempt (cockpit-observed paths or file artifacts) — a Q&A answered by
    // a mutation-capable engine is still just an answer.
    if (this.turnOutcomeKind === 'workspace_changed' && !(await this.attemptChangedFiles(active))) {
      this.turnOutcomeKind = 'answered';
    }
    this.pending = undefined;
    if (outcome === 'completed') {
      const content = await this.fetchAssistant(active.conversationId, active.tokenBuffer);
      this.recordEvidence({ type: 'completed', attemptId: active.attemptId, requestId: active.requestId, content });
      this.emit({
        kind: 'result',
        at: nowIso(),
        attemptId: active.attemptId,
        requestId: active.requestId,
        summary: this.interactionMode === 'chat' ? 'Reply from Core conversation' : 'Final answer from Core conversation',
        text: content,
        clientOrigin: active.clientOrigin,
      });
      this.drainSubmissionQueue();
      this.afterTurnAdvance();
      return;
    }
    if (outcome === 'cancelled') {
      this.recordEvidence({ type: 'cancelled', attemptId: active.attemptId, requestId: active.requestId });
      this.emit({
        kind: 'cancelled',
        at: nowIso(),
        attemptId: active.attemptId,
        requestId: active.requestId,
        summary: 'Attempt cancelled by Core',
        clientOrigin: active.clientOrigin,
      });
      this.drainSubmissionQueue();
      this.afterTurnAdvance();
      return;
    }
    this.recordEvidence({ type: 'failed', attemptId: active.attemptId, requestId: active.requestId, detail });
    this.emit({
      kind: 'error',
      at: nowIso(),
      attemptId: active.attemptId,
      requestId: active.requestId,
      summary: detail ?? 'execution failed',
      clientOrigin: active.clientOrigin,
    });
    this.drainSubmissionQueue();
    this.afterTurnAdvance();
  }

  private afterTurnAdvance(): void {
    if (this.executingQueuedCommandId) return; // the queued run's own completion advances the queue
    setImmediate(() => {
      void this.advanceComposerQueue().catch((err) => this.options.log?.(`queue advance failed: ${(err as Error).message}`));
    });
  }

  private drainSubmissionQueue(): void {
    if (this.submissionQueue.length === 0) return;
    const next = this.submissionQueue.shift()!;
    setImmediate(async () => {
      try {
        const res = await this.submitTask(next.goal, next.workerId, next.voiceTurnId, next.clientOrigin, next.staged);
        next.resolve(res);
      } catch (err) {
        next.reject(err);
      }
    });
  }

  async getActiveConversationMessages(): Promise<Array<{ id: string; role: string; content: string; createdAt: string; model?: string }>> {
    const convId = this.selectedConversationId ?? this.voiceConversationId;
    if (!convId) return [];
    try {
      const client = this.requireClient();
      const res = await client.listMessages(convId, { limit: 200 });
      return (res.messages || []).map((m: any) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        model: m.model,
      }));
    } catch {
      return [];
    }
  }

  private async fetchAssistant(conversationId: string, fallback: string): Promise<string> {
    try {
      const { messages } = await this.requireClient().listMessages(conversationId);
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'assistant' && messages[i].content.trim()) return messages[i].content;
      }
    } catch (err) {
      this.options.log?.(`failed to fetch durable assistant message: ${(err as Error).message}`);
    }
    return fallback;
  }

  private emit(event: DesktopActivityEvent): void {
    if (this.active && event.kind !== 'token' && event.summary !== 'token') {
      if (event.attemptId === this.active.attemptId) {
        this.cockpitEvents.push(event);
      }
    }
    for (const listener of this.listeners) listener(event);
  }

  private recordEvidence(entry: Record<string, unknown>): void {
    const file = this.options.evidenceLogPath;
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ at: nowIso(), ...entry })}\n`, 'utf8');
  }
}

function emptyCommandQueueSnapshot(): CommandQueueSnapshot {
  return { active: null, confirming: null, waiting: [], recentTerminal: [] };
}

function mapCommandView(raw: Record<string, unknown>): CommandQueueItemView {
  return {
    id: String(raw.id ?? ''),
    ordinal: Number(raw.ordinal ?? 0),
    status: String(raw.status ?? 'waiting'),
    title: String(raw.title ?? ''),
    instruction: String(raw.instruction ?? ''),
    revision: Number(raw.revision ?? 1),
    confirmationToken: raw.confirmationToken == null ? null : String(raw.confirmationToken),
    confirmationExpiresAt: raw.confirmationExpiresAt == null ? null : String(raw.confirmationExpiresAt),
    dependsOnId: raw.dependsOnId == null ? null : String(raw.dependsOnId),
    outcome: raw.outcome == null ? null : String(raw.outcome),
    lastError: raw.lastError == null ? null : String(raw.lastError),
    postponedUntil: raw.postponedUntil == null ? null : String(raw.postponedUntil),
  };
}

function emptyWakeDiagnostics(): DesktopWakeDiagnostics {
  return {
    engineReady: false,
    captureActive: false,
    captureError: '',
    contextSampleRate: null,
    trackLabel: '',
    micRms: 0,
    framesReceived: 0,
    lastScore: 0,
    peakScore: 0,
    lastScoreAt: null,
    lastDetectedAt: null,
    lastDetectedScore: null,
    threshold: WAKE_SCORE_THRESHOLD,
    thresholdCrossings: 0,
    approachCount: 0,
    framesSinceReset: 0,
    readyForDetect: false,
    wakeDetectMs: null,
    lastInferenceMs: null,
    monitorStartedAt: null,
    recentScores: [],
  };
}

/** Narrows Core's full `CapabilityDispatchResult` (which carries whole
 * `ApprovalRecord`/`ToolInvocationRecord` objects — attempt ids, revisions,
 * digests) down to exactly what the Gmail renderer surface needs, so nothing
 * beyond a bounded, already-safe `output`/`presentation` string ever crosses
 * the IPC boundary. */
function toGmailActionResultView(result: CapabilityDispatchResult): DesktopGmailActionResult {
  switch (result.outcome) {
    case 'executed': {
      const output = result.toolInvocation.evidence?.output;
      return { outcome: 'executed', output: typeof output === 'string' ? output : JSON.stringify(output ?? '') };
    }
    case 'approval_required':
      return { outcome: 'approval_required', approvalId: result.approval.id, presentation: result.approval.presentation };
    case 'denied':
      return { outcome: 'denied', reason: result.reason };
    case 'unavailable':
      return { outcome: 'unavailable', reason: result.reason };
    case 'unknown_tool':
      return { outcome: 'unknown_tool' };
  }
}

function toImageGenerationResult(result: CapabilityDispatchResult): DesktopImageGenerationResult {
  switch (result.outcome) {
    case 'approval_required':
      return {
        outcome: 'approval_required', attemptId: result.attemptId,
        approvalId: result.approval.id, presentation: result.approval.presentation,
      };
    case 'executed': {
      const output = result.toolInvocation.evidence?.output;
      if (result.toolInvocation.status !== 'succeeded') {
        return { outcome: 'failed', attemptId: result.attemptId, reason: typeof output === 'string' ? output : 'Image generation failed' };
      }
      try {
        const parsed = JSON.parse(String(output ?? '{}')) as { artifactIds?: unknown; message?: unknown };
        const artifactIds = Array.isArray(parsed.artifactIds) ? parsed.artifactIds.filter((id): id is string => typeof id === 'string') : [];
        if (artifactIds.length === 0) return { outcome: 'failed', attemptId: result.attemptId, reason: 'Image generation returned no verified artifact' };
        return { outcome: 'executed', attemptId: result.attemptId, artifactIds, message: String(parsed.message ?? 'Image ready') };
      } catch {
        return { outcome: 'failed', attemptId: result.attemptId, reason: 'Image generation returned invalid evidence' };
      }
    }
    case 'denied': return { outcome: 'denied', attemptId: result.attemptId, reason: result.reason };
    case 'unavailable': return { outcome: 'unavailable', attemptId: result.attemptId, reason: result.reason };
    case 'unknown_tool': return { outcome: 'unavailable', attemptId: result.attemptId, reason: 'Image generation is unavailable in the running Core' };
  }
}

function toWeatherResult(result: CapabilityDispatchResult): DesktopWeatherResult {
  switch (result.outcome) {
    case 'approval_required':
      return {
        outcome: 'approval_required', attemptId: result.attemptId,
        approvalId: result.approval.id, presentation: result.approval.presentation,
      };
    case 'executed': {
      const output = result.toolInvocation.evidence?.output;
      if (result.toolInvocation.status !== 'succeeded') {
        return { outcome: 'failed', attemptId: result.attemptId, reason: typeof output === 'string' ? output : 'Weather lookup failed' };
      }
      return { outcome: 'executed', attemptId: result.attemptId, message: typeof output === 'string' ? output : 'Weather retrieved' };
    }
    case 'denied': return { outcome: 'denied', attemptId: result.attemptId, reason: result.reason };
    case 'unavailable': return { outcome: 'unavailable', attemptId: result.attemptId, reason: result.reason };
    case 'unknown_tool': return { outcome: 'unavailable', attemptId: result.attemptId, reason: 'Weather is unavailable in the running Core' };
  }
}

function compactCapabilityFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const compact = raw.replace(/\s+/g, ' ').trim() || 'Image generation failed';
  return compact.length > 500 ? `${compact.slice(0, 500)}…` : compact;
}

function emptyEverydayToolsSnapshot(): EverydayToolsSnapshot {
  return {
    timezone: hostTimezone(),
    alertsWhileClosed: true,
    alertsWhileClosedDetail:
      'Desktop alerts fire while Jarvis is running (window visible or hidden in the tray). Alerts do not fire after Quit, while the computer is asleep, or while the computer is off.',
    catalog: everydayToolCatalog(),
    notes: [],
    reminders: [],
    dueReminders: [],
  };
}

function mapReminderView(raw: Record<string, unknown>): EverydayToolsSnapshot['reminders'][number] {  return {
    id: String(raw.id ?? ''),
    title: String(raw.title ?? ''),
    body: String(raw.body ?? ''),
    dueAt: String(raw.dueAt ?? ''),
    timezone: String(raw.timezone ?? 'UTC'),
    status: String(raw.status ?? 'scheduled') as EverydayToolsSnapshot['reminders'][number]['status'],
    notifiedAt: raw.notifiedAt == null ? null : String(raw.notifiedAt),
    overdue: Boolean(raw.overdue),
    overdueExplanation: raw.overdueExplanation == null ? null : String(raw.overdueExplanation),
  };
}

/** Core's daily-brief routine, narrowed to what the renderer needs. */
function mapDailyBriefRoutine(routine: {
  id: string;
  enabled: boolean;
  dailyTime: string;
  timezone: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  conversationId: string | null;
}): DesktopDailyBriefRoutine {
  return {
    id: routine.id,
    enabled: routine.enabled,
    dailyTime: routine.dailyTime,
    timezone: routine.timezone,
    nextRunAt: routine.nextRunAt,
    lastRunAt: routine.lastRunAt,
    conversationId: routine.conversationId,
  };
}

function defaultDesktopDataDir(): string {  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'KarkeDikha', 'desktop');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.trim()) return path.join(xdg, 'karkedikha', 'desktop');
  return path.join(os.homedir(), '.local', 'share', 'karkedikha', 'desktop');
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The version of the Core bundle this build ships, read from the packaged
 * app's own manifest. It is what the launcher compares against the running
 * Core to decide whether it must be replaced.
 */
function resolveBundledCoreVersion(productRoot: string): string {
  try {
    const pkgPath = path.join(productRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof parsed.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {
    // ignore
  }
  return '0.1.1';
}

function mapCoreState(state: string): DesktopSnapshot['coreState'] {  if (
    state === 'starting' ||
    state === 'connected' ||
    state === 'reconnecting' ||
    state === 'disconnected' ||
    state === 'unavailable' ||
    state === 'authentication_failed' ||
    state === 'incompatible' ||
    state === 'database_failed'
  ) {
    return state;
  }
  return 'unavailable';
}

function summarizeArgs(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function toolOutput(metadata: Record<string, unknown> | undefined): string {
  if (!metadata) return '';
  const evidence = metadata['evidence'];
  const raw = typeof evidence === 'object' && evidence
    ? (evidence as Record<string, unknown>)['output']
    : metadata['output'];
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const compact = raw.replace(/\s+/g, ' ').trim();
  return compact.length > 240 ? `${compact.slice(0, 240)}…` : compact;
}

/** Core's structured check evidence, when this event carries it. Records
 * written before Core persisted it simply have none. */
function toolCheck(metadata: Record<string, unknown> | undefined): DesktopActivityEvent['check'] {
  const evidence = metadata?.['evidence'];
  const check = typeof evidence === 'object' && evidence
    ? (evidence as Record<string, unknown>)['check']
    : undefined;
  if (!check || typeof check !== 'object') return undefined;
  const kind = (check as Record<string, unknown>)['kind'];
  const status = (check as Record<string, unknown>)['status'];
  if (typeof kind !== 'string' || typeof status !== 'string') return undefined;
  return check as DesktopActivityEvent['check'];
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isLocalCoreWorker(workerId: string): boolean {
  return workerId === 'local-core';
}
