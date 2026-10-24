const api = window.karkedikhaDesktop;
const activity = document.getElementById('activity');
const result = document.getElementById('result');
const resultOutcome = document.getElementById('result-outcome');
const resultBlocked = document.getElementById('result-blocked');
const resultBlockedReason = document.getElementById('result-blocked-reason');
const resultSelectFolder = document.getElementById('result-select-folder');
const folderPath = document.getElementById('folder-path');
const modelLabel = document.getElementById('model-label');
const coreState = document.getElementById('core-state');
const ids = document.getElementById('ids');
const taskInput = document.getElementById('task-input');
const submit = document.getElementById('submit');
const cancel = document.getElementById('cancel');
const pickFolder = document.getElementById('pick-folder');
const approvalPanel = document.getElementById('approval-panel');
const approvalGate = document.getElementById('approval-gate');
const approvalTool = document.getElementById('approval-tool');
const approvalScope = document.getElementById('approval-scope');
const approvalPaths = document.getElementById('approval-paths');
const approvalDetail = document.getElementById('approval-detail');
const currentTask = document.getElementById('current-task');
const scopeRepo = document.getElementById('scope-repo');
const scopeActions = document.getElementById('scope-actions');
const scopeDelivery = document.getElementById('scope-delivery');
const scopeState = document.getElementById('scope-state');
const approve = document.getElementById('approve');
const reject = document.getElementById('reject');
const approvedAuth = document.getElementById('approved-auth');
const approvedAuthDetail = document.getElementById('approved-auth-detail');
const checkpointPane = document.getElementById('checkpoint-pane');
const jumpLatest = document.getElementById('jump-latest');
const diagnosticsList = document.getElementById('diagnostics-list');
const workerSelect = document.getElementById('worker-select');
const workerDetail = document.getElementById('worker-detail');
const openrouterStatus = document.getElementById('openrouter-status');
const openrouterKey = document.getElementById('openrouter-key');
const openrouterSetKey = document.getElementById('openrouter-set-key');
const openrouterClearKey = document.getElementById('openrouter-clear-key');
const inferenceProvider = document.getElementById('inference-provider');
const providerLabel = document.getElementById('provider-label');
const routingLabel = document.getElementById('routing-label');
const modelSelect = document.getElementById('model-select');
const cloudStateBadge = document.getElementById('cloud-state-badge');
const cloudRefresh = document.getElementById('cloud-refresh');
const cloudProviderList = document.getElementById('cloud-provider-list');
const cloudLocalFallback = document.getElementById('cloud-local-fallback');
const cloudActionNote = document.getElementById('cloud-action-note');
const micButton = document.getElementById('mic-button');
const micLabel = document.getElementById('mic-label');
const micHint = document.getElementById('mic-hint');
const voiceTranscript = document.getElementById('voice-transcript');
const activitySummary = document.getElementById('activity-summary');
const activityDetails = document.getElementById('activity-details');
const jarvisStateLabel = document.getElementById('jarvis-state-label');
const resultState = document.getElementById('result-state');
const todaySummary = document.getElementById('today-summary');
const todayTasks = document.getElementById('today-tasks');
const todayDueEmpty = document.getElementById('today-due-empty');
const todayDueList = document.getElementById('today-due-list');
const toolsTimezone = document.getElementById('tools-timezone');
const toolsAlertsPolicy = document.getElementById('tools-alerts-policy');
const toolsCatalog = document.getElementById('tools-catalog');
const toolsRefresh = document.getElementById('tools-refresh');
const toolsOpenWorkspace = document.getElementById('tools-open-workspace');
// index.html carries two PC-health blocks (drawer + Tools card) with the same ids;
// getElementById would only ever reach the first, so address every copy.
const healthTargets = (id) => {
  const nodes = [...document.querySelectorAll(`[id="${id}"]`)];
  return nodes.length ? { set textContent(v) { for (const n of nodes) n.textContent = v; } } : null;
};
const toolsHealthCpu = healthTargets('tools-health-cpu');
const toolsHealthMemory = healthTargets('tools-health-memory');
const toolsHealthGpu = healthTargets('tools-health-gpu');
const toolsHealthDisk = healthTargets('tools-health-disk');
const researchQuery = document.getElementById('research-query');
const researchStart = document.getElementById('research-start');
const researchApproval = document.getElementById('research-approval');
const researchApprovalQuery = document.getElementById('research-approval-query');
const researchApprovalDetail = document.getElementById('research-approval-detail');
const researchApprove = document.getElementById('research-approve');
const researchReject = document.getElementById('research-reject');
const researchStatus = document.getElementById('research-status');
const researchResult = document.getElementById('research-result');
const researchSources = document.getElementById('research-sources');
const notesList = document.getElementById('notes-list');
const notesEmpty = document.getElementById('notes-empty');
const noteTitle = document.getElementById('note-title');
const noteBody = document.getElementById('note-body');
const noteSave = document.getElementById('note-save');
const remindersList = document.getElementById('reminders-list');
const remindersEmpty = document.getElementById('reminders-empty');
const reminderTitle = document.getElementById('reminder-title');
const reminderDueMinutes = document.getElementById('reminder-due-minutes');
const reminderSave = document.getElementById('reminder-save');
const queueInstruction = document.getElementById('queue-instruction');
const queueAdd = document.getElementById('queue-add');
const queueConfirm = document.getElementById('queue-confirm');
const queueConfirmTitle = document.getElementById('queue-confirm-title');
const queueConfirmDetail = document.getElementById('queue-confirm-detail');
const queueRun = document.getElementById('queue-run');
const queueEdit = document.getElementById('queue-edit');
const queueSkip = document.getElementById('queue-skip');
const queuePostpone = document.getElementById('queue-postpone');
const queueActive = document.getElementById('queue-active');
const queueWaiting = document.getElementById('queue-waiting');
const queueWaitingEmpty = document.getElementById('queue-waiting-empty');
const queueRecent = document.getElementById('queue-recent');
const recentActivity = document.getElementById('recent-activity');
const recentEmpty = document.getElementById('recent-empty');
const scopeDeliveryResult = document.getElementById('scope-delivery-result');
const appRoot = document.querySelector('.app');
const conversationsNew = document.getElementById('conversations-new');
const conversationsSearch = document.getElementById('conversations-search');
const conversationsShowArchived = document.getElementById('conversations-show-archived');
const conversationsSearchResults = document.getElementById('conversations-search-results');
const conversationsRailGroups = document.getElementById('conversations-rail-groups');
const conversationsRailEmpty = document.getElementById('conversations-rail-empty');
const conversationContextEmpty = document.getElementById('conversation-context-empty');
const conversationContextBody = document.getElementById('conversation-context-body');
const conversationExport = document.getElementById('conversation-export');
const conversationExportStatus = document.getElementById('conversation-export-status');
const artifactsList = document.getElementById('artifacts-list');
const artifactsEmpty = document.getElementById('artifacts-empty');
const artifactPreviewImage = document.getElementById('artifact-preview-image');
const artifactPreviewTitle = document.getElementById('artifact-preview-title');
const artifactPreviewMeta = document.getElementById('artifact-preview-meta');
const artifactActions = document.getElementById('artifact-actions');
const artifactSaveCopy = document.getElementById('artifact-save-copy');
const artifactOpenFolder = document.getElementById('artifact-open-folder');
const imageStudioHealth = document.getElementById('image-studio-health');
const imagePrompt = document.getElementById('image-prompt');
const imageSize = document.getElementById('image-size');
const imageCheckpoint = document.getElementById('image-checkpoint');
const imageSteps = document.getElementById('image-steps');
const imageGenerate = document.getElementById('image-generate');
const imageCancel = document.getElementById('image-cancel');
const imageStatus = document.getElementById('image-status');
const imageApproval = document.getElementById('image-approval');
const imageApprovalDetail = document.getElementById('image-approval-detail');
const imageApprove = document.getElementById('image-approve');
const imageReject = document.getElementById('image-reject');
const weatherApproval = document.getElementById('weather-approval');
const weatherApprovalDetail = document.getElementById('weather-approval-detail');
const weatherApprove = document.getElementById('weather-approve');
const weatherReject = document.getElementById('weather-reject');

/* ── Panda Workspace: presence, inline task card, contextual panel ──── */
const pandaPresence = document.getElementById('panda-presence');
const pandaPresenceLabel = document.getElementById('panda-presence-label');
const pandaActionBadge = document.getElementById('panda-action-badge');
const brandStatusText = document.getElementById('brand-status-text');
const coreRetryButton = document.getElementById('core-retry');
const composerProviderName = document.getElementById('composer-provider-name');
const workspaceTaskCard = document.getElementById('workspace-task-card');
const taskCardTitle = document.getElementById('task-card-title');
const taskCardElapsed = document.getElementById('task-card-elapsed');
const taskCardMeta = document.getElementById('task-card-meta');
const taskCardSteps = document.getElementById('task-card-steps');
const taskCardStop = document.getElementById('task-card-stop');
const workspaceContext = document.getElementById('workspace-context');
const workspaceContextClose = document.getElementById('workspace-context-close');
const contextDelivered = document.getElementById('context-delivered');
const contextDeliveredEmpty = document.getElementById('context-delivered-empty');
const contextPreview = document.getElementById('context-preview');
const contextPreviewSection = document.getElementById('context-preview-section');
const conversationResultsTitle = document.getElementById('conversation-results-title');
const conversationResultsFiles = document.getElementById('conversation-results-files');
const conversationResultsPreview = document.getElementById('conversation-results-preview');
const conversationResultsOpen = document.getElementById('conversation-results-open');
const conversationResultsList = document.getElementById('conversation-results-list');

/** Explicit push-to-talk / wake capture — microphone active only while capturing. */
let listening = false;
/** @type {{ stop: () => Promise<Uint8Array|null>, cancel: () => void }|null} */
let voiceSession = null;
/** @type {'manual'|'auto'|null} */
let voiceCaptureMode = null;
/** @type {{ stop: () => void }|null} */
let wakeMonitor = null;
/** Serialized wake PCM queue (module-level so stop can clear it). */
let wakePushBusy = false;
/** @type {Int16Array[]} */
let wakePendingFrames = [];
/** Last real Whisper transcript shown near the composer (never fabricated).
 * Only ever set from the user's own dictated input — never from Jarvis's
 * own reply text, even while that reply is being spoken (see
 * lastSpokenReplyText below for that). */
let lastVoiceTranscript = '';
/** The assistant's reply text currently being read aloud via TTS, shown as a
 * caption-style status while `speaking` — kept separate from
 * `lastVoiceTranscript` so the transcript label never gets mislabeled with
 * Jarvis's own words once speech finishes. */
let lastSpokenReplyText = '';
/** @type {HTMLAudioElement|null} */
let activeSpeechAudio = null;
/** Monotonic id so stale playback cannot overwrite a newer reply. */
let speechGeneration = 0;
/**
 * Monotonic id for the whole voice turn (mic press, VAD trigger, or
 * wake-word trigger through mic re-arm). Every async continuation in the
 * voice pipeline (ASR result, Core result/error for a voice-originated
 * submission, TTS ready, playback completion) captures this value at the
 * start of its turn and must re-check it before mutating shared voice state
 * — a stale turn's callback arriving after a newer turn has started logs
 * and drops instead of touching state. This generalizes the same guard
 * `speechGeneration` already applies to TTS playback (see 4f40be6) to the
 * capture/ASR/submit portion of the turn, which previously had no such
 * guard. Kept as a separate counter from `speechGeneration` rather than
 * folding the two together: `speakAnswerText`/`playSpeechWavBase64` already
 * depend on a delicate speechGeneration handshake (predict-then-claim) for
 * TTS-vs-TTS races, and widening what bumps that counter would change that
 * handshake's meaning without a corresponding behavior change being in
 * scope here.
 */
let voiceTurnGeneration = 0;
/** Short id correlating one voice turn's log lines across renderer and host
 * (see hostLog / console.info('[voice] ...') lines). Not a durable identity
 * — once the turn reaches Core, the resulting requestId/attemptId are
 * logged alongside this id rather than replacing it. */
let voiceTurnId = null;

function newVoiceTurnId() {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().slice(0, 8);
    }
  } catch { /* fall through to timestamp-based id */ }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** Starts a new voice turn: mints a fresh id + generation and logs the
 * mic_started stage. Call this once per turn, at the earliest point the
 * turn is committed to (push-to-talk press, VAD capture start, or
 * wake-word trigger), before any state mutation or async call. */
function beginVoiceTurn(stage, extra = '') {
  voiceTurnId = newVoiceTurnId();
  voiceTurnGeneration += 1;
  const t0 = performance.now();
  console.info(`[voice] turn=${voiceTurnId} stage=${stage} tSinceStartMs=0${extra ? ` ${extra}` : ''}`);
  return { turnId: voiceTurnId, generation: voiceTurnGeneration, t0 };
}

function logVoiceStage(turn, stage, extra = '') {
  if (!turn) return;
  const tSinceStartMs = Math.round(performance.now() - turn.t0);
  console.info(`[voice] turn=${turn.turnId} stage=${stage} tSinceStartMs=${tSinceStartMs}${extra ? ` ${extra}` : ''}`);
}

function isVoiceTurnStale(turn) {
  return !turn || turn.generation !== voiceTurnGeneration;
}

/** The turn object most recently started by mic press / VAD trigger, so the
 * "stop while still capturing" early-exit path in onMicPress (which does
 * not itself start a new turn) can still log against the right turn. */
let activeVoiceTurn = null;
/** Turn id for which a first_model_token log line has already been emitted,
 * so a chatty token stream doesn't spam one log line per token. Purely
 * diagnostic — does not affect which events get spoken (voice still only
 * reacts to the terminal 'result'/'error' event, unchanged). */
let firstTokenLoggedForTurnId = null;
/** Latest measured audio level 0..1 from mic capture or playback analyser. */
let liveAudioLevel = 0;
/** Distinct synthetic level for inference animation (not measured audio). */
let inferencePulse = 0;
let pendingApprovalId = null;
let pendingInlineImageApprovalId = null;
let lastPresenceTurnKey = null;
let presenceFlashUntil = 0;
let presenceFlashState = "idle";
let resolvingApproval = false;
let followLatest = true;
let lastSnapshot = null;
let snapshotReceivedAt = Date.now();
let refreshSequence = 0;
/** @type {'idle'|'wake_monitoring'|'muted'|'capturing'|'listening'|'processing'|'speaking'|'working'|'completed'|'cancelled'|'failed'|'unavailable'} */
let jarvisUiState = 'idle';
let pendingResearchApproval = null;
let activeResearchId = null;
let researchPollTimer = null;
let selectedArtifactId = null;
let pendingImageApprovalId = null;
let pendingWeatherApprovalId = null;
let imageGenerationBusy = false;

function formatArtifactBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'Unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function selectArtifact(artifact) {
  selectedArtifactId = artifact.id;
  artifactPreviewImage.hidden = true;
  artifactPreviewImage.removeAttribute('src');
  artifactPreviewTitle.hidden = false;
  artifactPreviewTitle.textContent = artifact.title;
  artifactPreviewMeta.hidden = false;
  artifactPreviewMeta.textContent = `${artifact.fileName} · ${formatArtifactBytes(artifact.byteSize)} · ${artifact.availability}`;
  artifactActions.hidden = artifact.availability !== 'ready';
  if (artifact.availability !== 'ready' || artifact.kind !== 'image') return;
  try {
    const preview = await api.loadArtifactPreview(artifact.id);
    if (selectedArtifactId !== artifact.id) return;
    artifactPreviewImage.src = preview.dataUrl;
    artifactPreviewImage.alt = artifact.title;
    artifactPreviewImage.hidden = false;
  } catch (err) {
    artifactPreviewMeta.textContent = `Preview unavailable: ${err instanceof Error ? err.message : String(err)}`;
    artifactActions.hidden = true;
  }
}

async function refreshArtifacts() {
  if (!artifactsList || typeof api.listArtifacts !== 'function') return [];
  artifactsList.replaceChildren();
  const artifacts = await api.listArtifacts();
  artifactsEmpty.hidden = artifacts.length !== 0;
  for (const artifact of artifacts) {
    const row = document.createElement('li');
    row.className = 'artifact-item';
    row.dataset.availability = artifact.availability;
    const title = document.createElement('strong');
    title.textContent = artifact.title;
    const meta = document.createElement('span');
    meta.textContent = `${artifact.kind} · ${formatArtifactBytes(artifact.byteSize)} · ${artifact.availability}`;
    row.append(title, meta);
    row.addEventListener('click', () => { void selectArtifact(artifact); });
    artifactsList.appendChild(row);
  }
  if (selectedArtifactId && !artifacts.some((item) => item.id === selectedArtifactId)) selectedArtifactId = null;
  return artifacts;
}

async function probeImageStudio() {
  if (!imageStudioHealth || typeof api.probeImageStudio !== 'function') return;
  const status = await api.probeImageStudio();
  imageStudioHealth.textContent = status.detail;
  imageStudioHealth.dataset.ready = status.studio && status.comfyui ? 'true' : 'false';
  if (imageCheckpoint) {
    const selected = imageCheckpoint.value;
    imageCheckpoint.replaceChildren();
    for (const checkpoint of status.checkpoints ?? []) {
      const option = document.createElement('option');
      option.value = checkpoint.name;
      option.textContent = `${checkpoint.name} · ${checkpoint.category}`;
      imageCheckpoint.appendChild(option);
    }
    if (selected && (status.checkpoints ?? []).some((item) => item.name === selected)) imageCheckpoint.value = selected;
    imageCheckpoint.disabled = (status.checkpoints ?? []).length === 0;
  }
}

function setImageBusy(busy, status = '') {
  imageGenerationBusy = busy;
  if (imageGenerate) imageGenerate.disabled = busy;
  if (imageCancel) imageCancel.hidden = !busy;
  if (imageStatus && status) imageStatus.textContent = status;
}

async function handleImageResult(response) {
  if (response.outcome === 'approval_required') {
    pendingImageApprovalId = response.approvalId;
    if (imageApproval) imageApproval.hidden = false;
    if (imageApprovalDetail) imageApprovalDetail.textContent = JSON.stringify(response.presentation ?? {
      prompt: imagePrompt?.value.trim() ?? '', size: imageSize?.value ?? '1024x1024',
      checkpoint: imageCheckpoint?.value.trim() || 'Studio default', steps: Number(imageSteps?.value ?? 20), outputCount: 1,
    }, null, 2);
    setImageBusy(false, 'Review the exact request before generation starts.');
    return;
  }
  if (imageApproval) imageApproval.hidden = true;
  pendingImageApprovalId = null;
  setImageBusy(false, response.outcome === 'executed' ? response.message : response.reason);
  if (response.outcome === 'executed') {
    const artifacts = await refreshArtifacts();
    const created = artifacts.find((item) => response.artifactIds.includes(item.id));
    if (created) await selectArtifact(created);
  }
}

function handleWeatherResult(response) {
  if (response.outcome === 'approval_required') {
    pendingWeatherApprovalId = response.approvalId;
    if (weatherApproval) weatherApproval.hidden = false;
    if (weatherApprovalDetail) weatherApprovalDetail.textContent = JSON.stringify(response.presentation ?? {}, null, 2);
    return;
  }
  if (weatherApproval) weatherApproval.hidden = true;
  pendingWeatherApprovalId = null;
}

async function requestImageGeneration() {
  const prompt = imagePrompt?.value.trim() ?? '';
  if (!prompt) throw new Error('Describe the image you want first');
  if (!imageCheckpoint?.value) throw new Error('No live image model is available');
  const [width, height] = String(imageSize?.value ?? '1024x1024').split('x').map(Number);
  if (imageApproval) imageApproval.hidden = true;
  setImageBusy(true, 'Preparing approval…');
  try {
    await handleImageResult(await api.generateImage({
      prompt, width, height, steps: Number(imageSteps?.value ?? 20),
      checkpoint: imageCheckpoint?.value.trim() ?? '', outputCount: 1,
    }));
  } catch (error) {
    setImageBusy(false, error instanceof Error ? error.message : String(error));
    throw error;
  }
}

// --- Jarvis Conversations rail (Checkpoint 1) --------------------------
/** The conversation currently painted in #result's transcript view. Null
 * means the default/live view (unchanged single-latest-turn behavior). */
let viewingConversationId = null;
let userNavigatedAway = false;
/** Last fetched rail entries, cached so search-toggle/archived-toggle can
 * re-render without an extra round trip to Core. */
let conversationsRailCache = [];
let conversationsRailSearchQuery = '';
/** Dedupe guard so a terminal turn's full-transcript refetch runs once. */
let lastTranscriptRefetchKey = null;
/** Detects a newly-created/changed selected conversation (e.g. the first
 * submit of a session lazily creating one) so the rail picks it up. */
let lastKnownSelectedConversationId = null;
/** Detects a newly-appeared chat-triggered image approval (see
 * detectImageGenerationIntent) so its exact card is shown exactly once. */
let lastKnownPendingImageApprovalId = null;
/** Same dedup purpose as lastKnownPendingImageApprovalId, for weather. */
let lastKnownPendingWeatherApprovalId = null;
const wakeEnable = document.getElementById('wake-enable');
const wakeMute = document.getElementById('wake-mute');
const wakeIndicator = document.getElementById('wake-indicator');
const wakeDiagnosticsEl = document.getElementById('wake-diagnostics');
const voiceModeToggle = document.getElementById('voice-mode');
const stopSpeakingBtn = document.getElementById('stop-speaking');
const interruptHint = document.getElementById('interrupt-hint');

// A Stop that was requested but not confirmed by the host. The button then says
// so plainly instead of sitting on "Stopping…" forever.
let stopRequestedNotConfirmed = false;
let stopRequestedAttemptId = null;

function syncCancelButton() {
  if (!cancel) return;
  const attemptId = lastSnapshot?.attemptId ?? null;
  if (attemptId !== stopRequestedAttemptId) {
    // A different turn is running now: the earlier stop request does not apply to it.
    stopRequestedAttemptId = attemptId;
    stopRequestedNotConfirmed = false;
  }
  cancel.disabled = !lastSnapshot?.running && !voiceSession;
  // Stop is only offered while there is something to stop.
  cancel.hidden = cancel.disabled;
  const stopLabel = cancel.querySelector('.composer-cancel-label');
  syncTaskCardStop();
  if (!stopLabel) return;
  if (cancel.hidden) {
    stopRequestedNotConfirmed = false;
    stopLabel.textContent = 'Stop';
  } else if (stopRequestedNotConfirmed) {
    stopLabel.textContent = 'Stop again';
  } else if (stopLabel.textContent !== 'Stopping…') {
    stopLabel.textContent = 'Stop';
  }
}

function showOperationError(error) {
  const node = document.getElementById('operation-error');
  if (node) {
    // Electron prefixes IPC failures with "Error invoking remote method '…': Error:" — show only the real sentence.
    const raw = error ? (error instanceof Error ? error.message : String(error)) : '';
    node.textContent = raw.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
    node.hidden = !error;
  }
}

function collapsePath(fullPath) {
  const normalized = String(fullPath ?? '').replace(/\\/g, '/');
  if (!normalized) return '';
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0) return String(fullPath);
  return parts[parts.length - 1];
}

function shortenEmbeddedPaths(text) {
  return String(text ?? '').replace(/(?:[A-Za-z]:\\|\/)[^\s)]+/g, (match) => collapsePath(match));
}

function repoDisplayName(snapshot) {
  if (snapshot.taskScope?.repository) return collapsePath(snapshot.taskScope.repository);
  if (snapshot.folder) return collapsePath(snapshot.folder);
  return 'No folder selected';
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function setText(id, value) {
  const node = document.getElementById(id);
  if (node) node.textContent = value;
}

function setVoiceTranscript(text, { status = '' } = {}) {
  if (!voiceTranscript) return;
  const trimmed = String(text ?? '').trim();
  if (!trimmed && !status) {
    voiceTranscript.hidden = true;
    voiceTranscript.textContent = '';
    return;
  }
  voiceTranscript.hidden = false;
  if (status && trimmed) {
    voiceTranscript.textContent = `${status}: ${trimmed}`;
  } else if (status) {
    voiceTranscript.textContent = status;
  } else {
    voiceTranscript.textContent = trimmed;
  }
}

/** A transcript that asks for a change, or was corrected, is never sent by voice alone:
 *  it is placed in the composer, with the reason, and sent only when the person presses Send. */
function holdVoiceTranscriptForReview(transcript, review, turn) {
  taskInput.value = transcript;
  taskInput.focus();
  showOperationError(null);
  setVoiceTranscript(transcript, { status: `Check before sending (${review.reasons.join(', ')})` });
  logVoiceStage(turn, 'transcript_held_for_review', `reasons=${review.reasons.join('; ')}`);
}

function updateMicChrome(next) {
  if (!micButton || !micLabel) return;
  const pressed = next === 'listening';
  const toggle = document.getElementById('mic-toggle-btn');
  const toggleLabel = document.getElementById('mic-toggle-label');
  const toggleStatus = document.getElementById('mic-toggle-status');

  let label = 'Mic';
  let aria = 'Talk to Jarvis. Microphone stays off until pressed.';
  let title = 'Talk to Jarvis';
  let status = '';

  if (next === 'listening') {
    status = 'Listening';
    label = 'Stop';
    aria = voiceCaptureMode === 'auto'
      ? 'Listening. Jarvis will stop after you finish speaking; click again to stop now.'
      : 'Listening. Press again to finish this utterance.';
    title = voiceCaptureMode === 'auto'
      ? 'Listening — finish speaking or click to stop now'
      : 'Listening — click to stop';
  } else if (next === 'processing') {
    status = 'Listening';
    label = 'Mic';
    aria = 'Capture finished. Transcribing locally.';
    title = 'Transcribing locally';
  }

  micLabel.textContent = label;
  micButton.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  micButton.setAttribute('aria-label', aria);
  micButton.title = title;
  if (toggle) {
    toggle.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    toggle.setAttribute('aria-label', aria);
    toggle.title = title;
    toggle.classList.toggle('is-listening', next === 'listening');
  }
  if (toggleLabel) toggleLabel.textContent = label;
  if (toggleStatus) {
    toggleStatus.textContent = status || 'Listening';
    toggleStatus.hidden = !status;
  }
}

// Guarded voice/UI state machine. `jarvisUiState` keeps its existing string
// values (idle/wake_monitoring/muted/capturing/listening/processing/
// speaking/working/completed/cancelled/failed/unavailable) — nothing that
// reads jarvisUiState elsewhere needs to change — but every write now goes
// through transitionJarvisState() so an illegal transition gets logged and
// recovered to 'idle' instead of silently corrupting the UI. Conceptually
// these states map onto READY (idle/wake_monitoring/muted/completed/
// cancelled/unavailable) / LISTENING (listening/capturing) / TRANSCRIBING
// (processing) / PROCESSING (working) / SPEAKING (speaking) / ERROR
// (failed); there is no separate stable "stopping" state today so none was
// added purely to satisfy the label.
const JARVIS_STATES = new Set([
  'idle', 'wake_monitoring', 'muted', 'capturing', 'listening', 'processing',
  'speaking', 'working', 'completed', 'cancelled', 'failed', 'unavailable',
]);
// These states are projections of host/server snapshot data (running,
// terminal, outcome) or explicit mode toggles rather than steps in a strict
// capture -> transcribe -> submit -> speak sequence, so any state may
// transition into them.
const JARVIS_ALWAYS_ALLOWED_TARGETS = new Set([
  'idle', 'wake_monitoring', 'muted', 'completed', 'cancelled', 'failed', 'unavailable', 'working',
]);
// idle/wake_monitoring/muted/completed/cancelled/failed/unavailable are all
// "ready-ish" states a fresh turn can legitimately start from — a prior
// turn's outcome, a mode toggle, or a transient capability error, none of
// which should block a new voice turn from beginning. Only 'idle' was
// listed here originally, which meant a real turn starting right after the
// previous one's `completed` snapshot landed (or after the wake-mic-missing
// watchdog set `unavailable`) got its legitimate transition rejected and
// force-reset to idle mid-turn. See JARVIS_ALWAYS_ALLOWED_TARGETS above for
// the same grouping applied to transition targets.
const JARVIS_READY_LIKE = ['idle', 'wake_monitoring', 'muted', 'completed', 'cancelled', 'failed', 'unavailable'];
// The states most associated with the mic-stuck class of bugs (starting to
// listen/capture while still speaking, requesting a transcription before
// capture is underway) get an explicit allow-list of legal predecessors.
// listening/capturing are the same "mic actively capturing audio" cluster
// (push-to-talk vs. VAD-driven capture respectively) — the snapshot-driven
// state re-derivation on every refresh() re-asserts 'listening' whenever the
// plain `listening` boolean is true regardless of which specific capture
// mode set jarvisUiState, so each must accept the other as a legal source
// or that periodic re-assertion trips the guard on every refresh tick.
const JARVIS_GUARDED_TRANSITIONS = {
  listening: ['capturing', ...JARVIS_READY_LIKE],
  capturing: ['listening', ...JARVIS_READY_LIKE],
  processing: ['listening', 'capturing', ...JARVIS_READY_LIKE],
  speaking: ['processing', 'working', ...JARVIS_READY_LIKE],
};

function canTransitionJarvisState(from, to) {
  if (from === to) return true;
  if (JARVIS_ALWAYS_ALLOWED_TARGETS.has(to)) return true;
  const allowedFrom = JARVIS_GUARDED_TRANSITIONS[to];
  return Array.isArray(allowedFrom) && allowedFrom.includes(from);
}

/** The only function allowed to mutate jarvisUiState. Returns the state
 * that actually applies after the guard (next on success, 'idle' on a
 * rejected/illegal transition). */
function transitionJarvisState(next, reason = '') {
  if (!JARVIS_STATES.has(next)) {
    console.warn(`[voiceState] ignoring unknown state "${next}"${reason ? ` (${reason})` : ''}`);
    return jarvisUiState;
  }
  if (!canTransitionJarvisState(jarvisUiState, next)) {
    console.warn(`[voiceState] illegal transition ${jarvisUiState} -> ${next}${reason ? ` (${reason})` : ''}; recovering to idle`);
    jarvisUiState = 'idle';
    return jarvisUiState;
  }
  jarvisUiState = next;
  return jarvisUiState;
}

function setJarvisState(rawNext, reason = '') {
  const next = transitionJarvisState(rawNext, reason);
  if (appRoot) appRoot.dataset.jarvisState = next;
  if (jarvisStateLabel) {
    jarvisStateLabel.dataset.state = next;
    const pretty = ({
      wake_monitoring: 'Wake monitoring',
      listening: 'Listening',
      capturing: 'Capturing',
      processing: 'Processing',
      speaking: 'Speaking',
      working: 'Working',
      completed: 'Completed',
      failed: 'Failed',
      cancelled: 'Cancelled',
      muted: 'Muted',
      unavailable: 'Unavailable',
      idle: 'Idle',
    })[next] || (next.charAt(0).toUpperCase() + next.slice(1));
    jarvisStateLabel.textContent = pretty;
  }
  if (resultState) {
    if (next === 'failed') resultState.textContent = 'Failed';
    else if (next === 'completed') resultState.textContent = 'Completed';
    else if (next === 'cancelled') resultState.textContent = 'Cancelled';
    else if (next === 'speaking') resultState.textContent = 'Speaking';
    else resultState.textContent = next.charAt(0).toUpperCase() + next.slice(1);
  }
  const neural = document.getElementById('neural-ready');
  if (neural) {
    if (next === 'speaking') neural.textContent = 'Speaking';
    else if (next === 'listening' || next === 'capturing') neural.textContent = 'Listening';
    else if (next === 'wake_monitoring') neural.textContent = 'Wake monitoring';
    else if (next === 'muted') neural.textContent = 'Wake muted';
    else if (next === 'processing') neural.textContent = 'Transcribing';
    else if (next === 'working') neural.textContent = isChatInteraction(lastSnapshot) ? 'Chatting' : 'Mission active';
    else if (next === 'completed') neural.textContent = 'Completed';
    else if (next === 'failed') neural.textContent = 'Failed';
    else if (next === 'cancelled') neural.textContent = 'Stopped';
    else if (next === 'unavailable') neural.textContent = 'Capture unavailable';
    else neural.textContent = 'Idle';
  }
  updateMicChrome(next);
  updateComposerStatus();
  const derivedCore = deriveJarvisCoreState(lastSnapshot || {});
  updateCoreReactor(derivedCore, lastSnapshot || {});
  try { updateApexTelemetry(next, lastSnapshot); } catch {}

  // Do not overwrite the spoken answer text while speaking — status only.
  if (next === 'listening' || next === 'capturing') setVoiceTranscript('', { status: 'Listening' });
  else if (next === 'processing') setVoiceTranscript(lastVoiceTranscript || '', { status: 'Processing local Whisper transcription…' });
  else if (next === 'speaking') setVoiceTranscript(lastSpokenReplyText || '', { status: 'Speaking' });
  else if (next === 'wake_monitoring') {
    // Keep prior transcript visible; wake label lives in neural/wake indicator.
    if (!lastVoiceTranscript) setVoiceTranscript('', { status: 'Say Hey Jarvis' });
    else setVoiceTranscript(lastVoiceTranscript, { status: 'Transcript' });
  }
  else if (next === 'muted') setVoiceTranscript(lastVoiceTranscript || '', { status: 'Wake muted' });
  else if (next === 'idle' && !lastVoiceTranscript) setVoiceTranscript('');
  else if (next === 'idle' && lastVoiceTranscript) setVoiceTranscript(lastVoiceTranscript, { status: 'Transcript' });
  else if (next === 'working' && lastVoiceTranscript) setVoiceTranscript(lastVoiceTranscript, { status: 'Submitted' });
  else if ((next === 'completed' || next === 'failed') && lastVoiceTranscript) {
    setVoiceTranscript(lastVoiceTranscript, { status: 'Transcript' });
  }
}

function renderLocalSpeechHint(snapshot) {
  if (!micHint || !micButton) return;
  if (jarvisUiState === 'speaking') {
    micHint.textContent = 'Speaking.';
    micButton.disabled = true;
    return;
  }
  if (jarvisUiState === 'listening' || jarvisUiState === 'capturing') {
    micHint.textContent = voiceCaptureMode === 'auto'
      ? 'Listening.'
      : 'Listening.';
    return;
  }
  if (jarvisUiState === 'processing') {
    micHint.textContent = 'Transcribing.';
    return;
  }
  if (jarvisUiState === 'wake_monitoring') {
    micHint.textContent = 'Tap the mic and speak.';
    micButton.disabled = Boolean(snapshot?.running);
    return;
  }
  const speech = snapshot?.localSpeech;
  if (!speech) {
    micHint.textContent = 'Type your request or try the mic.';
    micButton.disabled = Boolean(snapshot?.running);
    return;
  }
  if (speech.capability === 'available') {
    micHint.textContent = 'Tap the mic and speak.';
    micButton.disabled = Boolean(snapshot?.running);
    return;
  }
  micHint.textContent = speech.blocker || 'Local speech recognition unavailable on this host.';
  micButton.disabled = true;
}

function deriveJarvisState(snapshot) {
  if (jarvisUiState === 'processing') return 'processing';
  if (jarvisUiState === 'speaking') return 'speaking';
  if (snapshot.running) return 'working';
  if (snapshot.cockpit?.terminal || snapshot.lastTurnOutcome) {
    // Prefer explicit host outcome; never treat “terminal + text” as success.
    const fromOutcome = snapshot.lastTurnOutcome;
    if (fromOutcome === 'completed') return 'completed';
    if (fromOutcome === 'failed') return 'failed';
    if (fromOutcome === 'cancelled') return 'cancelled';
    const diags = snapshot.cockpit?.diagnostics || [];
    if (diags.some((e) => e.kind === 'cancelled' || e.eventType === 'attempt_cancelled')) return 'cancelled';
    if (diags.some((e) => e.kind === 'error' || e.eventType === 'attempt_failed')) return 'failed';
    if (diags.some((e) => e.kind === 'result')) return 'completed';
    if (snapshot.cockpit?.terminal) return 'failed';
  }
  if (listening) return 'listening';
  return 'idle';
}

function isChatInteraction(snapshot) {
  return snapshot?.interactionMode === 'chat' || (!snapshot?.folder && snapshot?.interactionMode !== 'mission');
}

function renderChatChrome(snapshot) {
  const chat = isChatInteraction(snapshot);
  const timeline = document.getElementById('mission-timeline');
  if (timeline) timeline.hidden = chat;
  const missionPhaseRow = document.getElementById('mission-phase-brief')?.closest('div');
  if (missionPhaseRow) missionPhaseRow.hidden = chat;
  const delivery = document.getElementById('scope-delivery-result')?.closest('div');
  if (delivery) delivery.hidden = chat;
  const cockpitPhase = document.getElementById('cockpit-phase')?.closest('div');
  if (cockpitPhase) cockpitPhase.hidden = chat;
  const validation = document.getElementById('cockpit-validation')?.closest('div');
  if (validation) validation.hidden = chat;
  const verification = document.getElementById('cockpit-verification')?.closest('div');
  if (verification) verification.hidden = chat;
  const filesRead = document.getElementById('cockpit-read')?.closest('div');
  if (filesRead) filesRead.hidden = chat;
  const filesChanged = document.getElementById('cockpit-changed')?.closest('div');
  if (filesChanged) filesChanged.hidden = chat;
  const repair = document.getElementById('cockpit-repair')?.closest('div');
  if (repair) repair.hidden = chat;
  const allowance = document.getElementById('cockpit-allowance')?.closest('div');
  if (allowance) allowance.hidden = chat;
  const productive = document.getElementById('cockpit-productive')?.closest('div');
  if (productive) productive.hidden = chat;
}

// Element ids kept for compatibility; what they now represent:
//   thinking  -> Think:   model generation (an "AI response" checkpoint)
//   checking  -> Inspect: search and read_file
//   verified  -> Execute: proposal approval and a successful mutation
//   delivered -> Verify:  validation, behavioral verification, diff review, commit
const MISSION_STAGE_ORDER = ['thinking', 'checking', 'verified', 'delivered'];

/** Classifies one cockpit checkpoint (or the live `currentAction`) by its
 * title into the stage it belongs to, or `null` for a checkpoint that is not
 * stage-bearing (e.g. "Mission submitted", "Waiting for authorization"). */
function classifyMissionStage(title) {
  const t = title || '';
  if (t === 'AI response') return 'thinking';
  if (t === 'Search' || t.startsWith('Search ') || t === 'Read' || t.startsWith('Read ')) return 'checking';
  if (t === 'Edit' || t.startsWith('Edit ') || t === 'Anchored edit' || t.startsWith('Anchored edit ')
    || t === 'Waiting for authorization' || t === 'Authorization approved') return 'verified';
  if (t === 'Validate' || t === 'Verify page' || t.startsWith('Verify page ') || t === 'Review'
    || t === 'Mission completed') return 'delivered';
  return null;
}


function deriveJarvisCoreState(snapshot) {
  if (jarvisUiState === 'listening' || jarvisUiState === 'capturing') return 'listening';
  if (snapshot?.awaitingApproval || snapshot?.pendingApproval || snapshot?.cockpit?.pendingApproval || snapshot?.pendingImageApproval || snapshot?.pendingWeatherApproval) {
    return 'waiting_for_approval';
  }
  if (snapshot?.running) {
    const cockpit = snapshot.cockpit;
    if (cockpit?.repairCycle > 0 || cockpit?.phase === 'repair') {
      return 'recovering';
    }
    const actionTitle = (cockpit?.currentAction?.title || '').toLowerCase();
    const valStatus = (cockpit?.validationStatus || '').toLowerCase();
    if (valStatus === 'running' || actionTitle.includes('validat') || actionTitle.includes('check') || actionTitle.includes('verify') || actionTitle.includes('test')) {
      return 'validating';
    }
    if (cockpit?.currentAction && !actionTitle.includes('ai response') && !actionTitle.includes('think') && !actionTitle.includes('chatting')) {
      return 'executing';
    }
    return 'thinking';
  }
  if (snapshot?.cockpit?.terminal || snapshot?.lastTurnOutcome) {
    const outcome = snapshot.lastTurnOutcome;
    if (outcome === 'completed') return 'completed';
    if (outcome === 'failed' || outcome === 'cancelled') return 'failed';
    const diags = snapshot.cockpit?.diagnostics || [];
    if (diags.some((e) => e.kind === 'error' || e.kind === 'cancelled' || e.eventType === 'attempt_failed' || e.eventType === 'attempt_cancelled')) return 'failed';
    if (diags.some((e) => e.kind === 'result')) return 'completed';
  }
  if (jarvisUiState === 'completed') return 'completed';
  if (jarvisUiState === 'failed' || jarvisUiState === 'cancelled') return 'failed';
  return 'idle';
}

function updatePandaRoute(snapshot) {
  const routeEl = document.getElementById('wow-route');
  if (!routeEl) return;
  const isChat = isChatInteraction(snapshot);
  const isAutonomous = !isChat && (snapshot?.interactionMode === 'execute' || snapshot?.interactionMode === 'mission' || Boolean(snapshot?.taskScope?.authorized));
  const isAssist = !isChat && !isAutonomous;
  const targetRoute = isChat ? 'chat' : (isAssist ? 'assist' : 'execute');

  const segs = routeEl.querySelectorAll('.wow-route-seg');
  segs.forEach((seg) => {
    if (seg.dataset.route === targetRoute) {
      seg.setAttribute('data-lit', targetRoute === 'execute' ? 'amber' : '');
    } else {
      seg.removeAttribute('data-lit');
    }
  });
}

function updatePandaAvatar(coreState, snapshot) {
  const pandaAvatar = document.getElementById('panda-avatar-img');
  const heroReactor = document.getElementById('jarvis-core-reactor');
  if (!pandaAvatar) return;

  let state = coreState || 'idle';
  if (snapshot?.awaitingApproval || snapshot?.pendingApproval || snapshot?.cockpit?.pendingApproval || snapshot?.pendingImageApproval || snapshot?.pendingWeatherApproval) {
    state = 'waiting_for_approval';
  } else if (state === 'executing' || state === 'working' || state === 'processing') {
    const activeTool = (snapshot?.activeTool || snapshot?.cockpit?.currentAction?.title || '').toLowerCase();
    if (activeTool.includes('code') || activeTool.includes('write') || activeTool.includes('edit') || activeTool.includes('patch')) {
      state = 'coding';
    } else if (activeTool.includes('check') || activeTool.includes('test') || activeTool.includes('validat') || activeTool.includes('verify')) {
      state = 'testing';
    } else if (activeTool.includes('read') || activeTool.includes('search') || activeTool.includes('repo') || activeTool.includes('file') || activeTool.includes('inspect')) {
      state = 'reading';
    } else {
      state = 'thinking';
    }
  }

  // Media generation (image/video turns) gets its own "creating" look.
  if (snapshot?.running && String(snapshot?.attemptId || '').startsWith('image_att_') && state !== 'waiting_for_approval') {
    state = 'creating';
  }
  // Brief acknowledgement after a turn ends, then back to idle.
  const terminalOutcome = !snapshot?.running ? snapshot?.lastTurnOutcome : null;
  const turnKey = `${snapshot?.attemptId || ''}:${terminalOutcome || ''}`;
  if (terminalOutcome && turnKey !== lastPresenceTurnKey && (state === 'idle' || state === 'completed' || state === 'failed')) {
    lastPresenceTurnKey = turnKey;
    presenceFlashUntil = Date.now() + 2500;
    presenceFlashState = terminalOutcome === 'completed' ? 'success' : terminalOutcome === 'failed' ? 'failed' : 'idle';
  }
  if ((state === 'idle' || state === 'completed') && Date.now() < presenceFlashUntil) state = presenceFlashState;
  if (snapshot?.speaking) state = 'speaking';

  if (heroReactor) {
    heroReactor.dataset.presence = state;
  }

  // The approved PAN-DA artwork is the only mascot image; states are CSS
  // light/motion over it, driven by real runtime state.
  if (pandaAvatar.getAttribute('src') !== 'assets/pan-da-hero.png') {
    pandaAvatar.src = 'assets/pan-da-hero.png';
  }
}

function updateCoreReactor(coreState, snapshot) {
  const reactor = document.getElementById('jarvis-core-reactor');
  // The connection to the Core is the first truth: when the Core is not
  // there, the panda may not claim to be ready and the reactor may not say
  // "Kernel ready". A missing brain is an error state, not an idle one.
  const connection = snapshot?.coreState;
  const connectionLost = connection === 'disconnected' || connection === 'unavailable'
    || connection === 'authentication_failed' || connection === 'incompatible'
    || connection === 'database_failed';
  const reconnecting = connection === 'reconnecting' || connection === 'starting';
  const effective = connectionLost ? 'failed' : reconnecting ? 'recovering' : coreState;
  if (reactor) {
    reactor.dataset.coreState = effective;
    reactor.dataset.presence = effective;
  }
  if (appRoot) appRoot.dataset.coreState = effective;

  const greeting = document.getElementById('wow-greeting');
  if (greeting) {
    if (connectionLost) greeting.textContent = 'The local Core is not answering';
    else if (reconnecting) greeting.textContent = 'Reconnecting to the local Core…';
    else if (coreState === 'thinking') greeting.textContent = 'Panda is thinking…';
    else if (coreState === 'executing') greeting.textContent = 'Executing tool action…';
    else if (coreState === 'validating') greeting.textContent = 'Validating changes…';
    else if (coreState === 'waiting_for_approval') greeting.textContent = 'Approval needed to proceed';
    else if (coreState === 'recovering') greeting.textContent = 'Repairing issue…';
    else if (coreState === 'completed') greeting.textContent = 'Done!';
    else if (coreState === 'failed') greeting.textContent = 'Mission needs attention';
    else if (coreState === 'listening') greeting.textContent = 'Listening…';
    else greeting.textContent = 'How can I help you today?';
  }

  updatePandaAvatar(effective, snapshot);
  updatePandaRoute(snapshot);

  const badge = document.getElementById('core-reactor-badge');
  const desc = document.getElementById('core-reactor-desc');
  if (!badge || !desc) return;

  const labels = {
    idle: { badge: 'IDLE', desc: 'Kernel ready · Standing by' },
    listening: { badge: 'LISTENING', desc: 'Acoustic matrix active · Capture in progress' },
    thinking: { badge: 'THINKING', desc: `${snapshot?.model || 'Local Model'} · Generating reasoning` },
    executing: { badge: 'EXECUTING', desc: `${snapshot?.cockpit?.currentAction?.title || 'Tool capability executing'}` },
    waiting_for_approval: { badge: 'APPROVAL REQUIRED', desc: `${snapshot?.pendingApproval?.gate || 'Governance gate active · Authorization needed'}` },
    validating: { badge: 'VALIDATING', desc: 'Workspace contract & acceptance checks running' },
    recovering: { badge: 'RECOVERING', desc: `Adaptive repair cycle #${snapshot?.cockpit?.repairCycle || 1} active` },
    completed: { badge: 'COMPLETED', desc: 'Mission verified · Deliverable ready' },
    failed: { badge: 'FAILED', desc: 'Attempt halted · Diagnostics logged' },
  };

  if (connectionLost) {
    // A plain sentence, never an internal counter or a backoff figure.
    badge.textContent = 'CORE OFFLINE';
    desc.textContent = snapshot?.coreDetail
      || 'The local Core is not answering. Use Retry to try again.';
  } else if (reconnecting) {
    badge.textContent = 'RECONNECTING';
    desc.textContent = snapshot?.coreDetail || 'Reconnecting to the local Core…';
  } else {
    const info = labels[coreState] || { badge: coreState.toUpperCase(), desc: 'Operational state' };
    badge.textContent = info.badge;
    desc.textContent = info.desc;
  }
}

function renderMissionTopology(snapshot) {
  const container = document.getElementById('mission-focus-topology');
  if (!container) return;
  if (isChatInteraction(snapshot)) {
    container.hidden = true;
    return;
  }
  container.hidden = false;

  const cockpit = snapshot?.cockpit;
  const coreState = deriveJarvisCoreState(snapshot);
  const isCloud = snapshot?.provider === 'openrouter' || snapshot?.selectedInferenceProvider === 'openrouter';
  // isLocal hoisted before first use in runtimeBadge block
  const isLocal = snapshot?.provider === 'ollama' || snapshot?.selectedInferenceProvider === 'ollama';

  // Header badges
  const runtimeBadge = document.getElementById('topology-runtime-badge');
  if (runtimeBadge) {
    runtimeBadge.textContent = isCloud ? 'CLOUD GATEWAY' : (isLocal ? 'LOCAL RUNTIME' : 'RUNTIME');
    runtimeBadge.className = `topology-badge ${isCloud ? 'badge-cloud' : (isLocal ? 'badge-local' : 'badge-unknown')}`;
  }
  const modelBadge = document.getElementById('topology-model-badge');
  if (modelBadge) {
    modelBadge.textContent = snapshot?.model || 'Ollama (auto)';
  }

  // Node 1: Objective
  const nodeObj = document.getElementById('node-objective');
  const textObj = document.getElementById('topo-objective-text');
  if (textObj) {
    const rawGoal = snapshot?.task || (snapshot?.folder ? snapshot.folder.split(/[\\/]/).pop() : 'Standing by');
    textObj.textContent = rawGoal && rawGoal.length > 36 ? rawGoal.slice(0, 34) + '…' : (rawGoal || 'Standing by');
    textObj.title = rawGoal || '';
  }
  if (nodeObj) {
    nodeObj.classList.toggle('is-active', Boolean(snapshot?.running || snapshot?.task));
    nodeObj.classList.toggle('is-done', Boolean(cockpit?.terminal && cockpit?.finalOutcome));
  }

  // Edge 1
  const edge1 = document.getElementById('edge-obj-model');
  if (edge1) {
    edge1.classList.toggle('is-flowing', Boolean(snapshot?.running));
    edge1.classList.toggle('is-done', Boolean(cockpit?.checkpoints?.length));
  }

  // Node 2: Model & Boundary
  const nodeModel = document.getElementById('node-model');
  const textModel = document.getElementById('topo-model-text');
  const boundaryPill = document.getElementById('topo-boundary-badge');
  if (textModel) {
    textModel.textContent = snapshot?.model || '--';
  }
  if (boundaryPill) {
    boundaryPill.textContent = isCloud ? 'CLOUD' : (isLocal ? 'LOCAL' : 'UNKNOWN');
    boundaryPill.className = `boundary-pill ${isCloud ? 'cloud-pill' : (isLocal ? 'local-pill' : 'unknown-pill')}`;
  }
  if (nodeModel) {
    nodeModel.classList.toggle('is-active', coreState === 'thinking');
    nodeModel.classList.toggle('is-done', Boolean(cockpit?.checkpoints?.some(c => c.id?.startsWith('term:'))));
  }

  // Edge 2
  const edge2 = document.getElementById('edge-model-tool');
  if (edge2) {
    edge2.classList.toggle('is-flowing', coreState === 'executing' || coreState === 'waiting_for_approval');
    edge2.classList.toggle('is-done', Boolean(cockpit?.checkpoints && cockpit.checkpoints.length > 1));
  }

  // Node 3: Capability / Tool
  const nodeTool = document.getElementById('node-tool');
  const textTool = document.getElementById('topo-tool-text');
  if (textTool) {
    const act = cockpit?.currentAction?.title || (snapshot?.pendingApproval ? snapshot.pendingApproval.toolName : (snapshot?.running ? 'Working' : 'Idle'));
    textTool.textContent = act && act.length > 28 ? act.slice(0, 26) + '…' : (act || 'Idle');
    textTool.title = act || '';
  }
  if (nodeTool) {
    nodeTool.classList.toggle('is-active', coreState === 'executing' || coreState === 'waiting_for_approval');
    nodeTool.classList.toggle('is-alert', coreState === 'waiting_for_approval');
    nodeTool.classList.toggle('is-done', Boolean(cockpit?.filesRead?.length || cockpit?.filesChanged?.length));
  }

  // Edge 3
  const edge3 = document.getElementById('edge-tool-val');
  if (edge3) {
    edge3.classList.toggle('is-flowing', coreState === 'validating' || coreState === 'recovering');
    edge3.classList.toggle('is-done', cockpit?.validationStatus === 'passed');
  }

  // Node 4: Validation
  const nodeVal = document.getElementById('node-validation');
  const textVal = document.getElementById('topo-val-text');
  if (textVal) {
    const rep = cockpit?.repairCycle ?? 0;
    const vStat = cockpit?.validationStatus || 'Not run';
    if (rep > 0) {
      textVal.textContent = `Repair #${rep} (${vStat})`;
    } else {
      textVal.textContent = vStat;
    }
  }
  if (nodeVal) {
    nodeVal.classList.toggle('is-active', coreState === 'validating');
    nodeVal.classList.toggle('is-recovering', coreState === 'recovering');
    nodeVal.classList.toggle('is-done', cockpit?.validationStatus === 'passed');
    nodeVal.classList.toggle('is-failed', cockpit?.validationStatus === 'failed');
  }

  // Edge 4
  const edge4 = document.getElementById('edge-val-art');
  if (edge4) {
    edge4.classList.toggle('is-flowing', coreState === 'completed');
    edge4.classList.toggle('is-done', Boolean(cockpit?.finalOutcome));
  }

  // Node 5: Artifact / Delivery
  const nodeArt = document.getElementById('node-artifact');
  const textArt = document.getElementById('topo-art-text');
  const hasDeliverable = Boolean(cockpit?.filesChanged?.length);
  if (textArt) {
    if (cockpit?.terminal && cockpit?.finalOutcome) {
      textArt.textContent = cockpit.finalOutcome.slice(0, 28);
    } else if (hasDeliverable) {
      textArt.textContent = `${cockpit.filesChanged.length} file(s) modified`;
    } else {
      textArt.textContent = snapshot?.running ? 'In progress' : 'Pending';
    }
  }
  if (nodeArt) {
    nodeArt.classList.toggle('is-active', coreState === 'completed');
    nodeArt.classList.toggle('is-done', Boolean(cockpit?.finalOutcome && coreState === 'completed'));
    nodeArt.classList.toggle('is-failed', coreState === 'failed');
    nodeArt.classList.toggle('is-clickable', hasDeliverable);
    nodeArt.title = hasDeliverable ? `Open deliverable: ${cockpit.filesChanged[0]}` : '';
    nodeArt.onclick = hasDeliverable ? () => {
      if (typeof api.openWorkspaceFile === 'function') {
        void api.openWorkspaceFile(cockpit.filesChanged[0]).catch(showOperationError);
      } else if (typeof api.openWorkspaceFolder === 'function') {
        void api.openWorkspaceFolder().catch(showOperationError);
      }
    } : null;
  }

  // KKD Intelligence Strip
  const contextVal = document.getElementById('intel-context-val');
  if (contextVal) {
    const promptTokens = cockpit?.metrics?.promptTokens;
    const hasCompacted = cockpit?.diagnostics?.some((e) => e.eventType === 'context_compacted' || (e.summary && e.summary.includes('context_compacted')));
    const envelope = snapshot?.contextEnvelope ?? null;

    if (hasCompacted) {
      contextVal.textContent = promptTokens ? `${promptTokens} tok · Context compacted` : 'Context compacted';
      contextVal.style.color = '#38bdf8';
      contextVal.title = 'Authoritative context compaction event recorded by KKD';
    } else if (typeof promptTokens === 'number' && promptTokens > 0) {
      if (typeof envelope === 'number' && envelope > 0) {
        const pct = Math.round((promptTokens / envelope) * 100);
        contextVal.textContent = `${promptTokens} / ${envelope} tok (${pct}% envelope)`;
        contextVal.style.color = pct > 80 ? '#f59e0b' : '#38bdf8';
        contextVal.title = `Prompt tokens: ${promptTokens}, Effective envelope: ${envelope}`;
      } else {
        // Envelope unknown — surface pressure when tokens are absolutely high (>12k)
        const isHighAbs = promptTokens > 12000;
        contextVal.textContent = isHighAbs
          ? `${promptTokens} tok · High Pressure (envelope unreported)`
          : `${promptTokens} tok (envelope unreported)`;
        contextVal.style.color = isHighAbs ? '#f59e0b' : '#94a3b8';
        contextVal.title = 'Prompt tokens measured; effective context envelope denominator is not reported';
      }
    } else {
      contextVal.textContent = 'UNKNOWN / PROFILE INCOMPLETE';
      contextVal.style.color = '#94a3b8';
      contextVal.title = 'Context envelope denominator or prompt metrics incomplete';
    }
  }

  const govVal = document.getElementById('intel-governance-val');
  if (govVal) {
    if (isCloud) {
      govVal.textContent = 'Cloud Gateway (audit signed)';
      govVal.style.color = '#a855f7';
    } else {
      const isFenced = Boolean(snapshot?.taskScope?.authorized);
      govVal.textContent = isFenced ? 'Local Sandbox (fenced lease)' : 'Local Sandbox';
      govVal.style.color = '#10b981';
    }
  }

  const recVal = document.getElementById('intel-recovery-val');
  if (recVal) {
    const reps = cockpit?.repairCycle ?? 0;
    if (reps > 0) {
      recVal.textContent = `${reps} adaptive repair cycle(s)`;
      recVal.style.color = '#fb923c';
    } else {
      recVal.textContent = '0 faults (nominal)';
      recVal.style.color = '#10b981';
    }
  }
}

function renderMissionTimeline(snapshot) {
  const steps = {
    thinking: document.getElementById('timeline-thinking'),
    checking: document.getElementById('timeline-checking'),
    verified: document.getElementById('timeline-verified'),
    delivered: document.getElementById('timeline-delivered'),
  };
  for (const node of Object.values(steps)) {
    if (!node) continue;
    node.classList.remove('is-active', 'is-done', 'is-failed');
    node.dataset.active = 'false';
    node.dataset.done = 'false';
    node.dataset.failed = 'false';
  }
  if (isChatInteraction(snapshot)) return;
  const cockpit = snapshot.cockpit;
  if (!cockpit) return;
  const state = deriveJarvisState(snapshot);
  const failed = state === 'failed' || state === 'cancelled';

  // A stage is "done" the moment any of its checkpoints completed
  // (successfully or not — a failed checkpoint still means the stage was
  // reached, and `failed` below marks it as the failure point instead of
  // silently leaving it blank). `highestReachedIndex` tracks how far the
  // mission has progressed so the active stage can fall back to it when
  // there is no live `currentAction` (e.g. between turns).
  let highestReachedIndex = -1;
  let failedStage = null;
  for (const checkpoint of cockpit.checkpoints || []) {
    const classifiedStage = classifyMissionStage(checkpoint.title);
    if (!classifiedStage) continue;
    // Model generation happens between every mission action. Once the
    // mission has reached Inspect, Execute, or Verify, a later AI response
    // is work inside that phase; it must not send the linear stepper back to
    // Think.
    const classifiedIndex = MISSION_STAGE_ORDER.indexOf(classifiedStage);
    const index = classifiedStage === 'thinking'
      ? Math.max(0, highestReachedIndex)
      : classifiedIndex;
    const stage = MISSION_STAGE_ORDER[index];
    if (checkpoint.outcome === 'failed') {
      failedStage = stage;
    } else if (checkpoint.outcome !== 'running' && index > highestReachedIndex) {
      highestReachedIndex = index;
    }
    if (steps[stage]) steps[stage].dataset.done = 'true';
  }

  const classifiedCurrentStage = classifyMissionStage(cockpit.currentAction?.title);
  const currentStage = classifiedCurrentStage === 'thinking' && highestReachedIndex > 0
    ? MISSION_STAGE_ORDER[highestReachedIndex]
    : classifiedCurrentStage;
  if (snapshot.running) {
    const activeStage = currentStage
      || MISSION_STAGE_ORDER[Math.max(0, highestReachedIndex)]
      || 'thinking';
    if (steps[activeStage]) {
      steps[activeStage].dataset.active = 'true';
      steps[activeStage].dataset.done = 'false';
    }
  }

  const delivered = Boolean(cockpit.terminal && cockpit.finalOutcome && state === 'completed');
  if (delivered && steps.delivered) steps.delivered.dataset.done = 'true';

  if (failed) {
    const stage = failedStage
      || currentStage
      || MISSION_STAGE_ORDER[Math.max(0, highestReachedIndex)]
      || 'thinking';
    if (steps[stage]) {
      steps[stage].dataset.failed = 'true';
      steps[stage].dataset.active = 'true';
      steps[stage].dataset.done = 'false';
    }
  }

  for (const node of Object.values(steps)) {
    if (!node) continue;
    if (node.dataset.done === 'true') node.classList.add('is-done');
    if (node.dataset.active === 'true') node.classList.add('is-active');
    if (node.dataset.failed === 'true') node.classList.add('is-failed');
  }
}

function humanProgressSentence(snapshot) {
  const cockpit = snapshot.cockpit;
  if (snapshot?.awaitingApproval || snapshot?.pendingApproval || snapshot?.cockpit?.pendingApproval || snapshot?.pendingImageApproval || snapshot?.pendingWeatherApproval) {
    return 'Waiting for your approval…';
  }
  if (jarvisUiState === 'listening') return 'Listening for your question…';
  if (jarvisUiState === 'processing') return 'Turning speech into text locally…';
  if (isChatInteraction(snapshot)) {
    if (snapshot.running) return 'Thinking…';
    if (snapshot.lastTurnOutcome === 'cancelled') return 'Cancelled.';
    if (snapshot.lastTurnOutcome === 'failed') {
      const reason = cockpit?.finalOutcome ? String(cockpit.finalOutcome).split('\n')[0].slice(0, 160) : '';
      return reason ? `Failed: ${reason}` : 'Failed.';
    }
    if (snapshot.lastTurnOutcome === 'completed') return 'Reply ready.';
    return snapshot.task ? 'Ready for the next message.' : 'Ready when you are.';
  }
  if (snapshot.running) {
    if (cockpit?.currentAction?.title) return cockpit.currentAction.title;
    if (cockpit?.phase === 'implementation') return 'Working through the mission…';
    if (cockpit?.phase === 'repair') return 'Repairing after a check…';
    return 'Thinking about your request…';
  }
  if (cockpit?.terminal && cockpit.finalOutcome) {
    const outcome = cockpit.finalOutcome;
    if (snapshot.lastTurnOutcome === 'cancelled' || /cancel/i.test(outcome)) return 'Mission cancelled.';
    if (snapshot.lastTurnOutcome === 'failed'
      || /fail|exceeded|error|refused|rejected|requires a selected repository/i.test(outcome)) {
      return 'Mission ended without a verified delivery.';
    }
    if (snapshot.lastTurnOutcome === 'completed') return 'Mission completed.';
    return 'Mission finished.';
  }
  if (lastVoiceTranscript) return 'Transcript ready — send or edit before submitting.';
  return 'Ready when you are.';
}

function renderToday(snapshot) {
  if (!todaySummary || !todayTasks) return;
  todayTasks.replaceChildren();
  const items = [];
  if (snapshot.task) {
    items.push(snapshot.running ? `In progress: ${snapshot.task}` : `Latest: ${snapshot.task}`);
  }
  if (snapshot.folder) {
    const name = snapshot.folder.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
    items.push(`Workspace: ${name}`);
  }
  if (snapshot.modelIsAuto && !snapshot.running) items.push('Model: Auto');
  else if (snapshot.model) items.push(`Model: ${snapshot.model}`);
  if (items.length === 0) {
    todaySummary.textContent = 'No local mission yet today.';
  } else {
    todaySummary.textContent = snapshot.running
      ? 'A local mission is active.'
      : 'Local workspace status.';
    for (const text of items) {
      const li = document.createElement('li');
      li.textContent = text;
      todayTasks.appendChild(li);
    }
  }
  renderTodayDue(snapshot);
}

function availabilityLabel(value) {
  if (value === 'available') return 'Available';
  if (value === 'not_connected') return 'Not connected';
  if (value === 'not_implemented') return 'Not implemented';
  return String(value || '—');
}

function formatDueLocal(iso, timezone) {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: timezone || undefined,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function renderTodayDue(snapshot) {
  if (!todayDueList || !todayDueEmpty) return;
  todayDueList.replaceChildren();
  const due = snapshot.everydayTools?.dueReminders ?? [];
  todayDueEmpty.hidden = due.length > 0;
  todayDueEmpty.textContent = due.length === 0 ? 'No due reminders.' : '';
  for (const item of due) {
    const li = document.createElement('li');
    const when = formatDueLocal(item.dueAt, item.timezone);
    li.textContent = item.overdue
      ? `Overdue: ${item.title} (was due ${when})`
      : `Due: ${item.title} (${when})`;
    if (item.overdueExplanation) li.title = item.overdueExplanation;
    todayDueList.appendChild(li);
  }
}

function renderEverydayTools(snapshot) {
  const tools = snapshot.everydayTools;
  if (!tools) return;
  if (toolsTimezone) toolsTimezone.textContent = `Timezone: ${tools.timezone || '—'}`;
  if (toolsAlertsPolicy) {
    toolsAlertsPolicy.textContent = tools.alertsWhileClosed
      ? 'Alerts while closed: available'
      : (tools.alertsWhileClosedDetail || 'Desktop alerts fire only while Jarvis is open.');
  }
  if (toolsCatalog) {
    toolsCatalog.replaceChildren();
    for (const entry of tools.catalog || []) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="conn-label"></span><span class="conn-state"></span>`;
      li.querySelector('.conn-label').textContent = entry.label;
      const state = li.querySelector('.conn-state');
      state.textContent = availabilityLabel(entry.availability);
      state.title = entry.detail || '';
      toolsCatalog.appendChild(li);
    }
  }
  const researchCapability = (tools.catalog || []).find((entry) => entry.id === 'web-research');
  if (researchStart && !activeResearchId && !pendingResearchApproval) {
    researchStart.disabled = researchCapability?.availability !== 'available';
    if (researchStatus && researchCapability?.availability !== 'available') {
      researchStatus.textContent = researchCapability?.detail || 'Governed web research is not configured.';
    }
  }
  const telemetry = snapshot.hostTelemetry;
  if (toolsHealthCpu) {
    toolsHealthCpu.textContent = telemetry?.cpu?.available && Number.isFinite(telemetry.cpu.value)
      ? `${Math.round(telemetry.cpu.value)}%`
      : 'Unavailable';
  }
  if (toolsHealthMemory) {
    toolsHealthMemory.textContent = telemetry?.memory?.available
      ? `${Math.round(telemetry.memory.usedPercent)}% · ${formatBytesUi(telemetry.memory.usedBytes)} used`
      : 'Unavailable';
  }
  if (toolsHealthGpu) {
    const gpu = telemetry?.gpu;
    toolsHealthGpu.textContent = gpu?.available && Number.isFinite(gpu.usagePercent)
      ? [
        `${Math.round(gpu.usagePercent)}%`,
        Number.isFinite(gpu.temperatureC) ? `${Math.round(gpu.temperatureC)}°C` : null,
        Number.isFinite(gpu.vramUsedBytes) && Number.isFinite(gpu.vramTotalBytes)
          ? `${formatBytesUi(gpu.vramUsedBytes)} / ${formatBytesUi(gpu.vramTotalBytes)} VRAM` : null,
        gpu.name || 'GPU',
      ].filter(Boolean).join(' · ')
      : (telemetry ? (gpu?.blocker || 'Unavailable') : 'Sampling…');
  }
  if (toolsHealthDisk) {
    toolsHealthDisk.textContent = telemetry?.disk?.available
      ? `${Math.round(telemetry.disk.usedPercent)}% used · ${formatBytesUi(telemetry.disk.freeBytes)} free`
      : 'Unavailable';
  }
  if (toolsOpenWorkspace) toolsOpenWorkspace.disabled = !snapshot.folder;
  if (notesList && notesEmpty) {
    notesList.replaceChildren();
    const notes = tools.notes || [];
    notesEmpty.hidden = notes.length > 0;
    for (const note of notes) {
      const li = document.createElement('li');
      li.className = 'tools-item';
      const body = document.createElement('div');
      body.className = 'tools-item-body selectable-text';
      body.textContent = note.body;
      const meta = document.createElement('div');
      meta.className = 'muted';
      meta.textContent = note.title;
      const actions = document.createElement('div');
      actions.className = 'row tools-item-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', async () => {
        const next = window.prompt('Edit note', note.body);
        if (next == null || !next.trim()) return;
        await api.updateNote(note.id, { body: next.trim(), title: note.title });
        await refresh();
      });
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        await api.deleteNote(note.id);
        await refresh();
      });
      actions.append(editBtn, delBtn);
      li.append(body, meta, actions);
      notesList.appendChild(li);
    }
  }
  if (remindersList && remindersEmpty) {
    remindersList.replaceChildren();
    const reminders = tools.reminders || [];
    remindersEmpty.hidden = reminders.length > 0;
    for (const rem of reminders) {
      const li = document.createElement('li');
      li.className = 'tools-item';
      li.setAttribute('data-reminder-id', rem.id);
      const body = document.createElement('div');
      body.className = 'tools-item-body selectable-text';
      const when = formatDueLocal(rem.dueAt, rem.timezone);
      body.textContent = `${rem.title} — ${when}${rem.overdue ? ' (overdue)' : ''}`;
      if (rem.overdueExplanation) body.title = rem.overdueExplanation;
      const actions = document.createElement('div');
      actions.className = 'row tools-item-actions';
      const doneBtn = document.createElement('button');
      doneBtn.type = 'button';
      doneBtn.textContent = 'Complete';
      doneBtn.addEventListener('click', async () => {
        await api.completeReminder(rem.id);
        await refresh();
      });
      const cancelBtn = document.createElement('button');
      cancelBtn.type = 'button';
      cancelBtn.textContent = 'Cancel';
      cancelBtn.addEventListener('click', async () => {
        await api.cancelReminder(rem.id);
        await refresh();
      });
      actions.append(doneBtn, cancelBtn);
      li.append(body, actions);
      remindersList.appendChild(li);
    }
  }
}

function renderCommandQueue(snapshot) {
  const queue = snapshot.commandQueue;
  if (!queue) return;
  const confirming = queue.confirming;
  if (queueConfirm) {
    queueConfirm.hidden = !confirming;
    if (confirming) {
      if (queueConfirmTitle) queueConfirmTitle.textContent = confirming.title || confirming.instruction;
      if (queueConfirmDetail) {
        queueConfirmDetail.textContent = confirming.instruction
          + (confirming.confirmationExpiresAt
            ? ` — confirm before ${new Date(confirming.confirmationExpiresAt).toLocaleTimeString()}`
            : '');
      }
      queueConfirm.setAttribute('data-command-id', confirming.id);
      queueConfirm.setAttribute('data-token', confirming.confirmationToken || '');
      queueConfirm.setAttribute('data-revision', String(confirming.revision || 1));
    } else {
      queueConfirm.removeAttribute('data-command-id');
      queueConfirm.removeAttribute('data-token');
      queueConfirm.removeAttribute('data-revision');
    }
  }
  if (queueActive) {
    if (queue.active) {
      queueActive.hidden = false;
      queueActive.textContent = `Active: ${queue.active.title}`;
    } else {
      queueActive.hidden = true;
      queueActive.textContent = '';
    }
  }
  if (queueWaiting && queueWaitingEmpty) {
    queueWaiting.replaceChildren();
    const waiting = queue.waiting || [];
    queueWaitingEmpty.hidden = waiting.length > 0;
    for (const item of waiting) {
      const li = document.createElement('li');
      li.className = 'tools-item';
      li.setAttribute('data-command-id', item.id);
      const body = document.createElement('div');
      body.className = 'tools-item-body selectable-text';
      body.textContent = `${item.ordinal}. ${item.title}${item.status === 'postponed' ? ' (postponed)' : ''}`;
      const actions = document.createElement('div');
      actions.className = 'row tools-item-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', async () => {
        const next = window.prompt('Edit queued instruction', item.instruction);
        if (next == null || !next.trim()) return;
        await api.editQueuedCommand(item.id, next.trim());
        await refresh();
      });
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.textContent = 'Up';
      upBtn.addEventListener('click', async () => {
        await api.reorderQueuedCommand(item.id, Math.max(1, Number(item.ordinal) - 1));
        await refresh();
      });
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.textContent = 'Down';
      downBtn.addEventListener('click', async () => {
        await api.reorderQueuedCommand(item.id, Number(item.ordinal) + 1);
        await refresh();
      });
      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.textContent = 'Skip';
      skipBtn.addEventListener('click', async () => {
        await api.skipCommand(item.id);
        await refresh();
      });
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.textContent = 'Remove';
      removeBtn.addEventListener('click', async () => {
        await api.removeQueuedCommand(item.id);
        await refresh();
      });
      actions.append(editBtn, upBtn, downBtn, skipBtn, removeBtn);
      li.append(body, actions);
      queueWaiting.appendChild(li);
    }
  }
  if (queueRecent) {
    queueRecent.replaceChildren();
    for (const item of (queue.recentTerminal || []).slice().reverse()) {
      const li = document.createElement('li');
      li.className = 'tools-item';
      li.textContent = `${item.status}: ${item.title}${item.outcome ? ` (${item.outcome})` : ''}`;
      queueRecent.appendChild(li);
    }
  }
}

function renderRecent(snapshot) {
  if (!recentActivity || !recentEmpty) return;
  recentActivity.replaceChildren();
  const checkpoints = snapshot.cockpit?.checkpoints ?? [];
  const recent = checkpoints.slice(-6).reverse();
  recentEmpty.hidden = recent.length > 0;
  for (const item of recent) {
    const li = document.createElement('li');
    const count = item.count && item.count > 1 ? ` ×${item.count}` : '';
    li.textContent = `${item.title}${count}`;
    recentActivity.appendChild(li);
  }
}

/**
 * The scope line of an approval card, in plain words.
 *
 * Core reports a scope such as `mutation:web_research`. The person deciding
 * needs to know what kind of action this is, not an internal identifier — but
 * nothing is invented: an unrecognised scope is shown exactly as reported.
 */
const APPROVAL_KIND_LABEL = {
  mutation: 'a mutating action',
  read: 'a read-only action',
  write: 'a write action',
  execute: 'running a command',
  network: 'a network action',
};

const APPROVAL_TOOL_LABEL = {
  web_research: 'Web search',
  request_search_permission: 'File and folder search',
  authorize_mission: 'Autonomous mission',
  propose_file_change: 'File change',
  run_command: 'Command',
  run_checks: 'Run a command',
  write_file: 'File write',
  propose_text_edit: 'File edit',
  calendar_create_event: 'Calendar event',
  calendar_update_event: 'Calendar change',
  calendar_delete_event: 'Calendar delete',
  gmail_send_draft: 'Send email',
  gmail_apply_plan: 'Organize Gmail',
  gmail_undo_plan: 'Undo Gmail change',
  inspect_page: 'Page inspection',
  image_generate: 'Image generation',
  video_generate: 'Video generation',
};

function approvalScopeLabel(scope) {
  const raw = String(scope ?? '').trim();
  if (!raw) return '';
  const match = /^([a-z_]+):([a-z_]+)$/i.exec(raw);
  if (!match) return raw;
  const kind = APPROVAL_KIND_LABEL[match[1].toLowerCase()] ?? match[1];
  const tool = APPROVAL_TOOL_LABEL[match[2].toLowerCase()] ?? match[2];
  return `${tool} · ${kind}`;
}

function renderApproval(snapshot) {
  try {
    const errorEl = document.getElementById('approval-render-error');
    if (errorEl) errorEl.hidden = true;
    const banner = document.getElementById('cross-conversation-approval-banner');
    if (banner) banner.hidden = true;

    const cockpit = snapshot.cockpit;
    const card = snapshot.pendingApproval;
    pendingApprovalId = card?.approvalId ?? null;
    // Image requests from chat use the same inline approval card, so the
    // approval is always where the conversation is (not in a hidden panel).
    const image = !card ? snapshot.pendingImageApproval : null;
    pendingInlineImageApprovalId = image?.approvalId ?? null;

    const activeConvId = snapshot.activeConversationId;
    const isElsewhere = Boolean(
      (card || image) &&
      activeConvId &&
      viewingConversationId !== activeConvId
    );

    if (isElsewhere && banner) {
      banner.hidden = false;
      const summaryEl = document.getElementById('cross-approval-summary');
      if (summaryEl) {
        summaryEl.textContent = `A task in another conversation is waiting for your approval${card?.scope ? `: ${card.scope}` : ''}.`;
      }
      const navBtn = document.getElementById('cross-approval-nav-btn');
      if (navBtn) {
        navBtn.onclick = () => {
          if (activeConvId) {
            void openConversationFromRail(activeConvId);
          }
        };
      }
      approvalPanel.hidden = true;
      approvalPanel.classList.add('hidden');
      return;
    }

    if (image) {
      const req = image.request || {};
      approvalPanel.hidden = false;
      approvalPanel.classList.remove('hidden');
      const heading = document.getElementById('approval-heading');
      const isVideo = req.toolName === 'video_generate';
      if (heading) heading.textContent = 'Your approval is needed';
      approvalGate.textContent = 'image';
      approvalTool.textContent = req.toolName || 'image_generate';
      approvalScope.textContent = isVideo
        ? (req.fromReference ? 'Animate image on this PC · Local GPU (ComfyUI)' : 'Generate video on this PC · Local GPU (ComfyUI)')
        : (req.fromReference ? 'Edit image on this PC · Local GPU (ComfyUI)' : 'Generate image on this PC · Local GPU (ComfyUI)');
      const riskEl = document.getElementById('approval-risk');
      if (riskEl) riskEl.textContent = 'Local GPU Execution';
      if (approvalPaths) approvalPaths.textContent = 'None';
      approvalDetail.textContent = [
        req.prompt ? `Prompt: ${req.prompt}` : '',
        req.width && req.height ? `Size: ${req.width}×${req.height}` : '',
        req.outputCount > 1 ? `Images: ${req.outputCount}` : '',
        isVideo && req.seconds ? `Length: about ${req.seconds} s (takes a few minutes)` : '',
        'Runs locally; the result is saved to your gallery.',
      ].filter(Boolean).join('\n');
      approve.disabled = resolvingApproval;
      reject.disabled = resolvingApproval;
      return;
    }
    if (card) {
      approvalPanel.hidden = false;
      approvalPanel.classList.remove('hidden');
      const heading = document.getElementById('approval-heading');
      if (heading) heading.textContent = 'Your approval is needed';
      approvalGate.textContent = card.gate;
      approvalTool.textContent = APPROVAL_TOOL_LABEL[String(card.toolName ?? '').toLowerCase()] ?? card.toolName;
      approvalTool.title = String(card.toolName ?? '');
      approvalScope.textContent = approvalScopeLabel(card.scope);
      approvalScope.title = String(card.scope ?? '');
      const riskEl = document.getElementById('approval-risk');
      if (riskEl) {
        riskEl.textContent = card.gate === 'mutation' ? 'Consequential (State Mutation)' : 'Governed Proposal';
      }
      if (approvalPaths) {
        approvalPaths.textContent = Array.isArray(card.paths) && card.paths.length
          ? `Paths: ${card.paths.join(', ')}`
          : 'None';
      }
      approvalDetail.textContent = card.detail || '';
      approve.disabled = resolvingApproval;
      reject.disabled = resolvingApproval;
    } else {
      approvalPanel.hidden = true;
      approvalPanel.classList.add('hidden');
      approve.disabled = true;
      reject.disabled = true;
    }
    // Home must re-read what it shows beside this card: the same approval is not listed twice.
    if (assistantBrief) renderAssistantHome(assistantBrief);
    if (cockpit?.authState === 'collapsed' && cockpit.approvedApproval) {
      approvedAuth.hidden = false;
      approvedAuthDetail.textContent = [
        cockpit.approvedApproval.toolName,
        cockpit.approvedApproval.scope,
        cockpit.approvedApproval.detail,
      ].filter(Boolean).join('\n');
    } else {
      approvedAuth.hidden = true;
      approvedAuthDetail.textContent = '';
    }
  } catch (err) {
    const errorEl = document.getElementById('approval-render-error');
    if (errorEl) {
      errorEl.hidden = false;
      const textEl = document.getElementById('approval-render-error-text');
      if (textEl) textEl.textContent = `Error rendering approval card: ${(err && err.message) || String(err)}`;
      const retryBtn = document.getElementById('approval-retry-btn');
      if (retryBtn) retryBtn.onclick = () => { void refresh(); };
    }
  }
}

function renderClocks(snapshot) {
  const cockpit = snapshot.cockpit;
  if (!cockpit) return;
  const drift = (cockpit.running || snapshot.running) && snapshotReceivedAt
    ? Date.now() - snapshotReceivedAt
    : 0;
  const elapsed = cockpit.elapsedMs + Math.max(0, drift);
  const remaining = Math.max(0, cockpit.remainingAbsoluteMs - Math.max(0, drift));
  const actionElapsed = cockpit.currentAction
    ? Math.max(0, Date.now() - Date.parse(cockpit.currentAction.startedAt))
    : 0;
  setText('cockpit-action-timer', cockpit.currentAction ? formatClock(actionElapsed) : '');
  setText('cockpit-elapsed', formatClock(elapsed));
  setText('cockpit-remaining', formatClock(remaining));
}

function renderMetrics(metrics) {
  if (!metrics) return;
  setText('cockpit-responses', String(metrics.aiResponses));
  setText('cockpit-prompt-tokens', metrics.promptTokens === null ? 'unavailable' : metrics.promptTokens.toLocaleString());
  setText('cockpit-generated-tokens', metrics.generatedTokens === null ? 'unavailable' : metrics.generatedTokens.toLocaleString());
  setText('cockpit-token-rate', metrics.generationRate === null
    ? 'unavailable'
    : `${metrics.generationRate.tokensPerSecond.toFixed(1)} tokens/sec (${metrics.generationRate.basis === 'generation'
      ? 'generation time'
      : 'end-to-end, includes prompt evaluation'})`);
  setText('cockpit-cost', metrics.cloudCostAvoidedUsd === null
    ? 'unavailable'
    : `$${metrics.cloudCostAvoidedUsd.toFixed(4)}`);
  setText('cockpit-actual-spend', metrics.actualSpendUsd === null
    ? 'unavailable'
    : `$${metrics.actualSpendUsd.toFixed(6)}`);
  setText('cockpit-spend-cap', metrics.spendCapUsd === null
    ? 'unavailable'
    : `$${metrics.spendCapUsd.toFixed(4)}`);
  const comparison = metrics.comparison;
  setText('cockpit-cost-basis', comparison
    ? `Versus ${comparison.model} list price $${comparison.inputUsdPerMTok}/MTok input and `
      + `$${comparison.outputUsdPerMTok}/MTok output, verified ${comparison.verifiedOn}. ${comparison.exclusions}`
    : '');
}

function formatBytesUi(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function setMeter(id, percent) {
  const node = document.getElementById(id);
  const value = percent == null || !Number.isFinite(percent) ? 0 : Math.max(0, Math.min(100, percent));
  if (node) node.style.width = `${value}%`;
  const gaugeMap = {
    'cpu-bar': 'cpu-gauge-arc',
    'gpu-bar': 'gpu-gauge-arc',
    'ram-bar': 'ram-gauge-arc',
    'disk-bar': 'disk-gauge-arc',
    'vram-bar': null,
  };
  const arcId = gaugeMap[id];
  const arc = arcId ? document.getElementById(arcId) : null;
  if (arc) arc.style.strokeDasharray = `${value} ${100 - value}`;
  if (id === 'disk-bar') {
    const visible = document.getElementById('disk-bar-visible');
    if (visible) visible.style.width = `${value}%`;
  }
  if (id === 'vram-bar') {
    const visible = document.getElementById('vram-bar-visible');
    if (visible) visible.style.width = `${value}%`;
  }
}

function renderHostTelemetry(snapshot) {
  const telem = snapshot.hostTelemetry;
  const clock = document.getElementById('host-clock');
  const dateEl = document.getElementById('host-date');
  const tz = document.getElementById('host-timezone');
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  if (dateEl) {
    dateEl.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', timeZone,
    }).format(now).toUpperCase();
  }

  if (telem?.clock) {
    if (clock) clock.textContent = telem.clock.localTime;
    if (tz) tz.textContent = telem.clock.timeZone;
  } else {
    if (clock) {
      clock.textContent = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone,
      }).format(now);
    }
    if (tz) tz.textContent = timeZone;
  }

  if (!telem) {
    setText('telem-cpu', 'Unavailable');
    setText('telem-memory', 'Unavailable');
    setText('telem-disk', 'Unavailable');
    setText('telem-gpu', 'Unavailable');
    setText('telem-cpu-detail', '—');
    setText('telem-gpu-detail', 'Unavailable');
    setText('telem-disk-detail', '—');
    setMeter('cpu-bar', 0);
    setMeter('gpu-bar', 0);
    setMeter('ram-bar', 0);
    setMeter('disk-bar', 0);
    setMeter('vram-bar', 0);
    setText('telem-vram', 'Unavailable');
    setText('telem-vram-detail', 'Separate from GPU utilization.');
    setText('telem-ollama-status', '—');
    setText('telem-ollama-model', snapshot.modelIsAuto && !snapshot.running ? 'Auto' : snapshot.model || '—');
    setText('telem-ollama-endpoint', snapshot.apiBase || '—');
    setText('telem-hardware-detail', 'Host telemetry not sampled yet.');
  } else {
    const cpuReady = telem.cpu?.available && telem.cpu.value != null;
    setText('telem-cpu', cpuReady ? `${telem.cpu.value}%` : 'Unavailable');
    setText('telem-cpu-detail', telem.cpu?.detail || (telem.cpu?.model ? telem.cpu.model : '—'));
    setMeter('cpu-bar', cpuReady ? telem.cpu.value : 0);

    if (telem.memory?.available) {
      setText(
        'telem-memory',
        `${Math.round(telem.memory.usedPercent)}%`,
      );
      setMeter('ram-bar', telem.memory.usedPercent);
    } else {
      setText('telem-memory', 'Unavailable');
      setMeter('ram-bar', 0);
    }

    if (telem.disk?.available && telem.disk.usedPercent != null) {
      const mount = telem.disk.mount ? String(telem.disk.mount).replace(/\\$/, '') : 'disk';
      setText('telem-disk-label', `Workspace storage (${mount})`);
      setText('telem-disk', `${formatBytesUi(telem.disk.freeBytes)} free`);
      setText(
        'telem-disk-detail',
        `Capacity: ${formatBytesUi(telem.disk.totalBytes - telem.disk.freeBytes)} / ${formatBytesUi(telem.disk.totalBytes)} (${telem.disk.usedPercent}%)`,
      );
      setMeter('disk-bar', telem.disk.usedPercent);
    } else {
      setText('telem-disk', 'Unavailable');
      setText('telem-disk-detail', telem.disk?.blocker || 'Unavailable');
      setMeter('disk-bar', 0);
    }

    const gpu = telem.gpu;
    setText('telem-gpu-label', gpu?.name ? gpu.name : 'GPU util');
    if (gpu && gpu.usagePercent != null) {
      setText('telem-gpu', `${gpu.usagePercent}%`);
      setMeter('gpu-bar', gpu.usagePercent);
      setText(
        'telem-gpu-detail',
        gpu.temperatureC != null ? `GPU temp: ${gpu.temperatureC}°C` : 'Temperature: Unavailable',
      );
    } else {
      setText('telem-gpu', 'Unavailable');
      setMeter('gpu-bar', 0);
      setText('telem-gpu-detail', gpu?.blocker || 'Unavailable');
    }

    if (gpu && gpu.vramUsedBytes != null && gpu.vramTotalBytes != null && gpu.vramTotalBytes > 0) {
      setText('telem-vram', `${formatBytesUi(gpu.vramUsedBytes)} / ${formatBytesUi(gpu.vramTotalBytes)}`);
      setText('telem-vram-detail', 'VRAM allocation (not GPU utilization).');
      setMeter('vram-bar', Math.round((gpu.vramUsedBytes / gpu.vramTotalBytes) * 100));
    } else {
      setText('telem-vram', 'Unavailable');
      setText('telem-vram-detail', 'Separate from GPU utilization.');
      setMeter('vram-bar', 0);
    }

    setText('telem-ollama-status', telem.ollama?.reachable ? 'Connected' : 'Disconnected');
    setText('telem-ollama-model', snapshot.modelIsAuto && !snapshot.running ? 'Auto' : snapshot.model || '—');
    setText(
      'telem-ollama-endpoint',
      telem.ollama?.reachable
        ? (telem.ollama.apiBase || snapshot.apiBase || '—')
        : `Unavailable · ${telem.ollama?.apiBase || snapshot.apiBase || '—'}`,
    );
    const detailLines = [
      `Collected: ${telem.collectedAt}`,
      `CPU model: ${telem.cpu?.model || 'Unavailable'}`,
      `CPU cores: ${telem.cpu?.cores ?? '—'}`,
      `Disk: ${telem.disk?.available ? 'ok' : (telem.disk?.blocker || 'Unavailable')}`,
      `GPU util: ${telem.gpu?.available ? (telem.gpu.name || 'ok') : (telem.gpu?.blocker || 'Unavailable')}`,
      `VRAM: ${
        telem.gpu?.vramUsedBytes != null && telem.gpu?.vramTotalBytes != null
          ? `${formatBytesUi(telem.gpu.vramUsedBytes)} / ${formatBytesUi(telem.gpu.vramTotalBytes)}`
          : 'Unavailable'
      }`,
      `Ollama: ${telem.ollama?.detail || '—'}`,
      `Git: ${telem.repository?.available ? 'ok' : (telem.repository?.blocker || 'Unavailable')}`,
    ];
    setText('telem-hardware-detail', detailLines.join('\n'));
  }

  const repo = telem?.repository;
  setText('repo-name', repoDisplayName(snapshot));
  setText('repo-branch', repo?.available && repo.branch ? repo.branch : 'Unavailable');
  setText(
    'repo-dirty',
    repo?.available && repo.dirty != null ? (repo.dirty ? 'Dirty' : 'Clean') : 'Unavailable',
  );
  setText(
    'repo-changed',
    repo?.available && repo.changedFileCount != null ? String(repo.changedFileCount) : 'Unavailable',
  );
  setText('repo-full-path', snapshot.folder || 'No repository selected');

  const connectors = telem?.connectors;
  const list = document.getElementById('connector-list');
  if (list) {
    for (const item of list.querySelectorAll('[data-connector]')) {
      const id = item.getAttribute('data-connector');
      const match = Array.isArray(connectors) ? connectors.find((entry) => entry.id === id) : null;
      const stateNode = item.querySelector('.conn-state');
      if (stateNode) stateNode.textContent = 'Not connected';
      void match;
    }
  }
}

function renderFilesTab(snapshot) {
  const list = document.getElementById('files-list');
  const empty = document.getElementById('files-empty');
  if (!list) return;
  list.replaceChildren();
  const changed = snapshot.cockpit?.filesChanged?.filter(Boolean) ?? [];
  if (changed.length === 0) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  for (const file of changed) {
    const row = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = collapsePath(file) || file;
    name.title = file;
    const badge = document.createElement('span');
    badge.className = 'file-badge';
    badge.textContent = 'Changed';
    row.append(name, badge);
    list.appendChild(row);
  }
}

// --- Conversation pane: minimal, safe Markdown-ish rendering ------------
// No HTML parsing, no innerHTML, ever — only DOM construction from parsed
// text, exactly like the Gmail thread renderer's textContent-only rule.
// Supports fenced code blocks (```lang ... ```, copyable, scrollable),
// inline code spans, and paragraphs. Everything else stays literal text.

function renderInlineText(container, text) {
  // A Windows path (C:\dir\my_file.js) is kept verbatim: its underscores and backslashes are not markup. Underscore
  // emphasis needs word boundaries on both sides, like CommonMark, so snake_case_names are not italicised either.
  // Markdown links are recognised only in their `[text](https://…)` form and only for http/https, so no other
  // scheme (file:, javascript:, data:) can ever reach the browser.
  const tokenRegex = /([A-Za-z]:\\[^\s`]+|`[^`]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\)|\*\*[^*]+\*\*|__[^_]+__|(?<!\*)\*[^*]+\*(?!\*)|(?<![\w\\])_[^_]+_(?!\w))/g;
  const parts = String(text ?? '').split(tokenRegex);
  for (const part of parts) {
    if (!part) continue;
    const link = /^\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(part);
    if (link) {
      container.appendChild(buildConversationLink(link[1], link[2]));
      continue;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      const code = document.createElement('code');
      code.className = 'inline-code';
      code.textContent = part.slice(1, -1);
      container.appendChild(code);
    } else if ((part.startsWith('**') && part.endsWith('**') && part.length > 3) ||
               (part.startsWith('__') && part.endsWith('__') && part.length > 3)) {
      const strong = document.createElement('strong');
      strong.textContent = part.slice(2, -2);
      container.appendChild(strong);
    } else if ((part.startsWith('*') && part.endsWith('*') && part.length > 2) ||
               (part.startsWith('_') && part.endsWith('_') && part.length > 2)) {
      const em = document.createElement('em');
      em.textContent = part.slice(1, -1);
      container.appendChild(em);
    } else {
      container.appendChild(document.createTextNode(part));
    }
  }
}

/**
 * A real link the user can follow. The URL is opened through the host's
 * validated `openExternalUrl` channel, so only credential-free http/https
 * targets ever reach the system browser.
 */
function buildConversationLink(label, url) {
  const anchor = document.createElement('a');
  anchor.className = 'conversation-link';
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer nofollow';
  anchor.textContent = label;
  anchor.title = url;
  anchor.addEventListener('click', (event) => {
    event.preventDefault();
    if (typeof api?.openExternalUrl !== 'function') return;
    void api.openExternalUrl(url).catch(() => { /* the browser simply stays put */ });
  });
  return anchor;
}

function renderCodeBlock(container, code, lang) {
  const wrap = document.createElement('div');
  wrap.className = 'code-block';
  const header = document.createElement('div');
  header.className = 'code-block-header';
  const langLabel = document.createElement('span');
  langLabel.className = 'code-block-lang';
  langLabel.textContent = lang || 'code';
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'code-block-copy';
  copyBtn.textContent = 'Copy code';
  copyBtn.addEventListener('click', async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(code);
      copyBtn.textContent = 'Copied';
    } catch {
      copyBtn.textContent = 'Copy failed';
    } finally {
      setTimeout(() => { copyBtn.textContent = 'Copy code'; }, 1500);
    }
  });
  header.append(langLabel, copyBtn);
  const pre = document.createElement('pre');
  pre.className = 'code-block-pre';
  const codeEl = document.createElement('code');
  codeEl.textContent = code;
  pre.appendChild(codeEl);
  wrap.append(header, pre);
  container.appendChild(wrap);
}

/** Inline preview of a Core image artifact (bytes verified by the host),
 * with real Open / Show-in-folder actions. */
function renderArtifactFigure(artifactId, alt) {
  const figure = document.createElement('figure');
  figure.className = 'conversation-artifact';
  const img = document.createElement('img');
  img.alt = alt || 'Generated image';
  img.loading = 'lazy';
  const caption = document.createElement('figcaption');
  caption.textContent = 'Loading preview…';
  const actions = document.createElement('div');
  actions.className = 'conversation-artifact-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'apex-chip';
  open.textContent = 'Open';
  open.addEventListener('click', () => { void api.openArtifactFile?.(artifactId).catch(showOperationError); });
  const folder = document.createElement('button');
  folder.type = 'button';
  folder.className = 'apex-chip';
  folder.textContent = 'Show in folder';
  folder.addEventListener('click', () => { void api.openArtifactFolder?.(artifactId).catch(showOperationError); });
  actions.append(open, folder);
  figure.append(img, caption, actions);
  if (typeof api.loadArtifactPreview === 'function') {
    api.loadArtifactPreview(artifactId).then((preview) => {
      if (preview.fileUrl) {
        const video = document.createElement('video');
        video.controls = true;
        video.loop = true;
        video.preload = 'metadata';
        video.src = preview.fileUrl;
        img.replaceWith(video);
      } else {
        img.src = preview.dataUrl;
      }
      caption.textContent = preview.artifact?.title || alt || '';
    }).catch((err) => {
      img.remove();
      caption.textContent = `Preview unavailable: ${err?.message ?? err}`;
    });
  }
  return figure;
}

/** Renders `text` into `container` as headings, bullet lists, blockquotes,
 * paragraphs + fenced code blocks using safe DOM construction (no innerHTML).
 * Returns true if anything was rendered. */
function renderMarkdownLite(container, text) {
  container.replaceChildren();
  const raw = String(text ?? '');
  let hadContent = false;

  const renderProse = (segment) => {
    const lines = segment.replace(/^\n+|\n+$/g, '').split('\n');
    const kindOf = (l) => {
      if (!l.trim()) return 'blank';
      if (/^!\[[^\]]*\]\(artifact:[\w-]+\)\s*$/.test(l)) return 'artifact';
      if (/^#{1,4}\s+/.test(l)) return 'heading';
      if (/^\s*[\*\-•]\s+/.test(l)) return 'ul';
      if (/^\s*\d+[.)]\s+/.test(l)) return 'ol';
      if (/^>\s*/.test(l)) return 'quote';
      if (/^\s*\|.*\|\s*$/.test(l)) return 'table';
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) return 'rule';
      return 'p';
    };
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    let i = 0;
    while (i < lines.length) {
      const kind = kindOf(lines[i]);
      if (kind === 'blank') { i += 1; continue; }
      const group = [];
      if (kind === 'heading' || kind === 'rule') {
        group.push(lines[i++]);
      } else {
        while (i < lines.length && kindOf(lines[i]) === kind) group.push(lines[i++]);
      }
      hadContent = true;
      if (kind === 'heading') {
        const [, hashes, body] = group[0].match(/^(#{1,4})\s+(.*)$/);
        const level = hashes.length;
        const h = document.createElement(level === 1 ? 'h3' : level === 2 ? 'h4' : 'h5');
        h.className = `conversation-h${level}`;
        renderInlineText(h, body);
        container.appendChild(h);
      } else if (kind === 'rule') {
        container.appendChild(document.createElement('hr'));
      } else if (kind === 'artifact') {
        // Several results (e.g. variations) show as a grid to compare.
        const target = group.length > 1 ? document.createElement('div') : container;
        if (group.length > 1) target.className = 'conversation-artifact-grid';
        for (const line of group) {
          const [, alt, artifactId] = line.match(/^!\[([^\]]*)\]\(artifact:([\w-]+)\)/);
          target.appendChild(renderArtifactFigure(artifactId, alt));
        }
        if (group.length > 1) container.appendChild(target);
      } else if (kind === 'ul' || kind === 'ol') {
        const list = document.createElement(kind);
        list.className = kind === 'ul' ? 'conversation-list' : 'conversation-numbered-list';
        for (const line of group) {
          const li = document.createElement('li');
          renderInlineText(li, line.replace(kind === 'ul' ? /^\s*[\*\-•]\s+/ : /^\s*\d+[.)]\s+/, ''));
          list.appendChild(li);
        }
        container.appendChild(list);
      } else if (kind === 'quote') {
        const bq = document.createElement('blockquote');
        bq.className = 'conversation-blockquote';
        for (const line of group) {
          const p = document.createElement('p');
          renderInlineText(p, line.replace(/^>\s*/, ''));
          bq.appendChild(p);
        }
        container.appendChild(bq);
      } else if (kind === 'table') {
        const rows = group.filter((l) => !/^\s*\|?[\s:\-|]+\|?\s*$/.test(l)).map(cells);
        const hasHeader = group.length > 1 && /^\s*\|?[\s:\-|]+\|?\s*$/.test(group[1]);
        const table = document.createElement('table');
        table.className = 'conversation-table';
        rows.forEach((row, index) => {
          const tr = document.createElement('tr');
          for (const cell of row) {
            const td = document.createElement(hasHeader && index === 0 ? 'th' : 'td');
            renderInlineText(td, cell);
            tr.appendChild(td);
          }
          table.appendChild(tr);
        });
        const wrap = document.createElement('div');
        wrap.className = 'conversation-table-wrap';
        wrap.appendChild(table);
        container.appendChild(wrap);
      } else {
        // Normal paragraphs (preserve internal soft breaks)
        const p = document.createElement('p');
        p.className = 'conversation-paragraph';
        group.forEach((line, index) => {
          if (index > 0) p.appendChild(document.createElement('br'));
          renderInlineText(p, line);
        });
        container.appendChild(p);
      }
    }
  };

  const fence = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;
  while ((match = fence.exec(raw)) !== null) {
    renderProse(raw.slice(lastIndex, match.index));
    renderCodeBlock(container, match[2].replace(/\n$/, ''), match[1]);
    hadContent = true;
    lastIndex = fence.lastIndex;
  }
  renderProse(raw.slice(lastIndex));
  return hadContent;
}

const RESULT_OUTCOME_LABELS = {
  answered: 'Answered',
  artifact_created: 'Artifact created',
  workspace_changed: 'Repository updated',
  blocked_needs_workspace: 'Needs a workspace',
  failed: 'Failed',
};

/**
 * Point the conversation view at one conversation.
 *
 * Everything the pane shows belongs to a single conversation: the transcript,
 * the task card and the results. Changing the view therefore refreshes the
 * results too, so an earlier conversation's deliverables are never projected
 * onto the one being read.
 */
function setViewingConversation(conversationId) {
  if (viewingConversationId === conversationId) return;
  viewingConversationId = conversationId;
  void refreshConversationResults();
}

/**
 * Empty the conversation pane.
 *
 * A new conversation carries no transcript, no task card and no results. The
 * earlier work stays in its own conversation and in the task history; it is
 * never projected onto the new one.
 */
let conversationEpoch = 0;
let activeConversationEpoch = 0;

function clearConversationPane() {
  viewingConversationId = null;
  lastTranscriptRefetchKey = null;
  lastTranscriptAssistantTail = '';
  liveReply = { attemptId: null, text: '', finished: true };
  if (liveReplyFrame) {
    cancelAnimationFrame(liveReplyFrame);
    liveReplyFrame = 0;
  }
  conversationResultCount = 0;
  conversationResultsSignature = '';
  const resultNode = document.getElementById('result');
  if (resultNode) {
    resultNode.hidden = true;
    resultNode.replaceChildren();
    delete resultNode.dataset.outcome;
  }
  if (workspaceTaskCard) {
    workspaceTaskCard.hidden = true;
    workspaceTaskCard.removeAttribute('data-state');
  }
  if (taskCardSteps) {
    taskCardSteps.replaceChildren();
    taskCardSteps.dataset.signature = '';
  }
  const results = document.getElementById('conversation-results');
  if (results) results.hidden = true;
  const resultList = document.getElementById('conversation-results-list');
  if (resultList) resultList.replaceChildren();
  if (workspaceContext) workspaceContext.hidden = true;
  renderConversationContext(null);
  syncAssistantMode();
  void refreshConversationResults();
}

function renderConversationResult(snapshot) {
  if (resultOutcome) {
    const kind = snapshot.turnOutcomeKind;
    const label = kind ? RESULT_OUTCOME_LABELS[kind] : '';
    resultOutcome.textContent = label;
    resultOutcome.hidden = !label;
    if (kind) resultOutcome.dataset.kind = kind;
    else delete resultOutcome.dataset.kind;
  }
  if (resultBlocked) {
    const blocked = snapshot.turnOutcomeKind === 'blocked_needs_workspace' && snapshot.blockedReason;
    resultBlocked.hidden = !blocked;
    if (resultBlockedReason) resultBlockedReason.textContent = blocked ? snapshot.blockedReason : '';
  }
}

resultSelectFolder?.addEventListener('click', async () => {
  renderSnapshot(await api.pickFolder());
});

function renderWorkstreamHeadline(snapshot) {
  const headline = document.getElementById('workstream-headline');
  const resultNode = document.getElementById('result');
  if (!headline) return;
  const cockpit = snapshot.cockpit;
  const blockedNeedsWorkspace = snapshot.turnOutcomeKind === 'blocked_needs_workspace';
  renderConversationResult(snapshot);
  // Jarvis Conversations rail (Checkpoint 1): while the operator is viewing
  // an opened conversation other than the one actually running/just run,
  // #result already holds that conversation's durable transcript — leave it
  // alone rather than overwriting it with the live turn's single-outcome
  // text. This is the only place live rendering and the rail's transcript
  // view can conflict.
  // If active execution is happening on a conversation, keep viewingConversationId aligned with it
  // unless the operator specifically clicked to read another conversation while it's running
  if (snapshot.running && snapshot.activeConversationId && (!viewingConversationId || viewingConversationId !== snapshot.activeConversationId) && !userNavigatedAway) {
    setViewingConversation(snapshot.activeConversationId);
  }
  // Once the operator has deliberately navigated away (New Conversation or a
  // different rail entry) while work continues, the pane must stay where they
  // put it. The cross-conversation approval banner is the only pointer back.
  const keepViewingWhereUserLeftIt = userNavigatedAway;
  const viewingOtherConversation = Boolean(viewingConversationId) && viewingConversationId !== snapshot.activeConversationId;
  // If no conversation is active / selected, this is a clean new conversation.
  // Never project old workstream outcomes, previous mission terminal states,
  // or earlier tasks into the empty pane.
  const isNewConversation = (!snapshot.selectedConversationId && !viewingConversationId && userNavigatedAway)
    || (!snapshot.selectedConversationId && !viewingConversationId && !snapshot.running && !snapshot.task && !cockpit?.terminal);
  if (isNewConversation) {
    headline.textContent = 'No active workstream';
    headline.classList.add('is-empty');
    if (resultNode && resultNode.childElementCount === 0) {
      resultNode.hidden = true;
    }
    return;
  }

  const hasMission = Boolean(snapshot.running || snapshot.task || cockpit?.terminal
    || (cockpit?.checkpoints?.length ?? 0) > 0 || blockedNeedsWorkspace);
  if (!hasMission) {
    headline.textContent = 'No active workstream';
    headline.classList.add('is-empty');
    // An idle workstream is not a reason to erase the conversation: a turn the
    // user just sent may still be on its way into the Core.
    if (resultNode && !viewingOtherConversation && resultNode.childElementCount === 0) {
      resultNode.hidden = true;
    }
    return;
  }
  headline.classList.remove('is-empty');
  const concise = humanProgressSentence(snapshot);
  const phase = cockpit?.phase ? ` · ${cockpit.phase}` : '';
  const action = cockpit?.currentAction?.title ? ` — ${cockpit.currentAction.title}` : '';
  if (blockedNeedsWorkspace) {
    headline.textContent = snapshot.blockedReason || 'Select a repository to continue';
  } else if (snapshot.running) {
    headline.textContent = `${concise}${phase}${action}`.replace(/\s+·\s+$/, '');
  } else if (cockpit?.terminal && cockpit.finalOutcome) {
    const shortOutcome = String(cockpit.finalOutcome).split('\n')[0].slice(0, 160);
    headline.textContent = shortOutcome || concise;
  } else {
    headline.textContent = concise || (snapshot.task ? `Latest: ${snapshot.task}` : 'No active workstream');
  }
  if (resultNode && viewingOtherConversation) return;
  // While a turn runs, keep the conversation (history + the user's message)
  // on screen and stream the reply into a live row; never blank the thread.
  if (resultNode && snapshot.running && snapshot.activeConversationId && !cockpit?.terminal && !keepViewingWhereUserLeftIt) {
    setViewingConversation(snapshot.activeConversationId);
    const key = `running:${snapshot.activeConversationId}:${snapshot.attemptId || ''}`;
    if (lastTranscriptRefetchKey !== key) {
      lastTranscriptRefetchKey = key;
      void refreshOpenedTranscript(snapshot.activeConversationId).then(renderLiveReply);
    }
    return;
  }
  // "+ New" cleared the selection: refetching the last active conversation
  // here would re-select it on the host (openConversation selects) and the
  // next message would silently land in the old thread. The same applies when
  // the user explicitly opened a different conversation while work finished.
  if (resultNode && cockpit?.terminal && snapshot.activeConversationId && snapshot.selectedConversationId && !keepViewingWhereUserLeftIt) {
    setViewingConversation(snapshot.activeConversationId);
    const key = `${snapshot.activeConversationId}:${snapshot.attemptId || 'terminal'}`;
    finishLiveReply(snapshot.attemptId);
    if (lastTranscriptRefetchKey !== key) {
      lastTranscriptRefetchKey = key;
      void refreshOpenedTranscript(snapshot.activeConversationId);
    }
    return;
  }
  if (resultNode && !userNavigatedAway) {
    lastTranscriptRefetchKey = null;
    const outcome = cockpit?.terminal && cockpit.finalOutcome ? String(cockpit.finalOutcome) : '';
    // Nothing to show yet: keep whatever the thread already holds (e.g. the
    // optimistic user turn) instead of blanking it.
    if (!outcome) return;
    // Conversation pane: the complete response, rendered as safe Markdown
    // (fenced code gets a scrollable, copyable block) — this is the ONLY
    // place the full text appears; #activity never carries it.
    const rendered = renderMarkdownLite(resultNode, outcome);
    resultNode.hidden = !rendered;
    resultNode.dataset.outcome = snapshot.lastTurnOutcome
      || (outcome && deriveJarvisState(snapshot))
      || '';
    if (rendered) {
      resultNode.scrollTop = resultNode.scrollHeight;
    }
  }
}

// --- Jarvis Conversations rail (Checkpoint 1) ---------------------------
// Reuses Core's existing conversation ledger end to end via the desktop
// host IPC surface (listConversations/openConversation/newConversation/
// renameConversation/pinConversation/unpinConversation/archiveConversation/
// unarchiveConversation/searchConversations) — no renderer-owned database,
// no separate transcript store. Every render below is built fresh from
// data Core returned; nothing here is treated as authoritative on its own.

/** Renders a durable transcript (user/assistant messages and model switch events) into
 * `container`, reusing the exact safe-Markdown renderer used for the live
 * turn (`renderMarkdownLite`) — never a second implementation. */
/** Streaming reply for the running attempt, shown until the durable
 * transcript (refetched at terminal) replaces it. */
let liveReply = { attemptId: null, text: '', finished: false };
let liveReplyFrame = 0;
/** Last assistant text the durable transcript rendered; the live row must never sit beside its own persisted copy. */
let lastTranscriptAssistantTail = '';

/** The turn is over: freeze the live row (it stays until the durable transcript replaces it, so nothing blinks) and ignore late tokens/refetch callbacks. */
function finishLiveReply(attemptId) {
  if (liveReply.attemptId && (!attemptId || liveReply.attemptId === attemptId)) liveReply.finished = true;
  if (liveReplyFrame) { cancelAnimationFrame(liveReplyFrame); liveReplyFrame = 0; }
}

function renderLiveReply() {
  liveReplyFrame = 0;
  if (!result || !liveReply.attemptId || !liveReply.text) return;
  if (lastSnapshot?.attemptId && lastSnapshot.attemptId !== liveReply.attemptId) return;
  let row = result.querySelector('[data-live-reply="1"]');
  const live = liveReply.text.trim();
  // Already persisted (transcript fetched after Core stored it): drop the live copy instead of showing the answer twice.
  if (live && lastTranscriptAssistantTail && lastTranscriptAssistantTail.trim().startsWith(live)) {
    row?.remove();
    liveReply.finished = true;
    return;
  }
  if (liveReply.finished) return;
  if (!row) {
    row = document.createElement('div');
    row.className = 'conversation-paragraph-row transcript-row-assistant';
    row.dataset.liveReply = '1';
    const header = document.createElement('div');
    header.className = 'transcript-header';
    header.appendChild(pandaGlyphSvg('panda-glyph panda-glyph-inline'));
    const speaker = document.createElement('div');
    speaker.className = 'transcript-speaker speaker-assistant sr-only';
    speaker.textContent = 'Pandesh';
    header.appendChild(speaker);
    const body = document.createElement('div');
    body.className = 'transcript-body transcript-body-assistant';
    row.append(header, body);
    result.appendChild(row);
  }
  const atBottom = result.scrollHeight - result.scrollTop - result.clientHeight < 80;
  renderMarkdownLite(row.lastElementChild, liveReply.text);
  result.hidden = false;
  if (atBottom) {
    result.scrollTop = result.scrollHeight;
    scrollConversationToEnd();
  }
}

function appendLiveReplyToken(attemptId, delta) {
  if (!attemptId || !delta) return;
  if (liveReply.attemptId !== attemptId) liveReply = { attemptId, text: '', finished: false };
  if (liveReply.finished) return;
  liveReply.text += delta;
  if (!liveReplyFrame) liveReplyFrame = requestAnimationFrame(renderLiveReply);
}

/** Whitespace-insensitive identity of a turn: markdown rendering changes blank lines, never the words. */
function normalizeTurnText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function renderConversationTranscript(container, messages) {
  // The Core persists messages asynchronously, so a transcript refresh can come
  // back without the turn the user just sent. Keep that live user turn instead
  // of silently dropping it from the conversation.
  // Only the optimistic echo of a just-sent turn is a live row; rows rendered from a durable transcript are not.
  const liveUserRows = [...container.querySelectorAll(':scope > .transcript-row-user[data-live-echo="1"]')];
  container.replaceChildren();
  for (const message of messages) {
    if (message.role === 'system') {
      let switchData = null;
      try {
        const parsed = JSON.parse(message.content);
        if (parsed && (parsed.type === 'model_switch' || parsed.kind === 'model_switch')) {
          switchData = parsed;
        }
      } catch {}
      if (switchData) {
        const eventRow = document.createElement('div');
        eventRow.className = 'conversation-event-row model-switch-event';

        const icon = document.createElement('span');
        icon.className = 'event-icon';
        icon.textContent = '⚡';
        eventRow.appendChild(icon);

        const text = document.createElement('span');
        text.className = 'event-text';
        text.textContent = `Model switched: ${switchData.fromModel} → ${switchData.toModel}`;
        eventRow.appendChild(text);

        const time = document.createElement('span');
        time.className = 'event-time';
        const timestamp = switchData.timestamp || message.createdAt;
        time.textContent = timestamp ? new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
        eventRow.appendChild(time);

        container.appendChild(eventRow);
      }
      continue;
    }
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const row = document.createElement('div');
    row.className = `conversation-paragraph-row transcript-row-${message.role}`;
    
    if (message.role === 'assistant') {
      const header = document.createElement('div');
      header.className = 'transcript-header';

      header.appendChild(pandaGlyphSvg('panda-glyph panda-glyph-inline'));

      const speaker = document.createElement('div');
      speaker.className = 'transcript-speaker speaker-assistant sr-only';
      speaker.textContent = 'Pandesh';
      header.appendChild(speaker);

      if (message.model) {
        const badge = document.createElement('span');
        badge.className = 'transcript-model-badge';
        badge.textContent = message.model;
        badge.title = `Generated by ${message.model}${message.provider ? ` (${message.provider})` : ''}`;
        header.appendChild(badge);
      }

      if (message.diagnostics) {
        // Diagnostics are technical detail: they open beside the message from
        // a small contextual control, never as permanent furniture in the
        // conversation.
        const diagBtn = document.createElement('button');
        diagBtn.className = 'transcript-diag-btn';
        diagBtn.type = 'button';
        diagBtn.setAttribute('aria-label', 'Diagnostics for this reply');
        diagBtn.title = 'Diagnostics — request context for this reply';
        const diagIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        diagIcon.setAttribute('viewBox', '0 0 24 24');
        diagIcon.setAttribute('width', '13');
        diagIcon.setAttribute('height', '13');
        diagIcon.setAttribute('aria-hidden', 'true');
        const diagPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        diagPath.setAttribute('fill', 'none');
        diagPath.setAttribute('stroke', 'currentColor');
        diagPath.setAttribute('stroke-width', '2');
        diagPath.setAttribute('stroke-linecap', 'round');
        diagPath.setAttribute('d', 'M12 11v5M12 8h.01M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z');
        diagIcon.appendChild(diagPath);
        diagBtn.appendChild(diagIcon);

        const diagCard = document.createElement('div');
        diagCard.className = 'transcript-diag-card hidden';
        diagCard.hidden = true;

        const d = message.diagnostics;
        const truncationText = d.contextTruncation?.truncated
          ? `Truncated (${d.contextTruncation.omittedCount} prior message(s) omitted)`
          : 'None (full context)';
        const toolsText = (d.toolInvocationIds && d.toolInvocationIds.length > 0)
          ? d.toolInvocationIds.join(', ')
          : 'None';

        const fields = [
          ['Model / Provider', `${d.model || 'Unknown'} (${d.provider || 'ollama'})`],
          ['Request ID', d.requestId || 'None'],
          ['Attempt ID', d.attemptId || 'None'],
          ['Conversation ID', d.conversationId || 'None'],
          ['Selected Workspace', d.selectedWorkspace || 'None (no workspace)'],
          ['History Messages Count', String(d.messageHistoryCount ?? 0)],
          ['Context Truncation', truncationText],
          ['Tool Invocations', toolsText],
          ['Output Message ID', d.outputAssociation?.assistantMessageId || message.id || 'None'],
        ];

        for (const [lbl, val] of fields) {
          const item = document.createElement('div');
          item.className = 'diag-item';
          const labelSpan = document.createElement('span');
          labelSpan.className = 'diag-label';
          labelSpan.textContent = lbl + ':';
          const valSpan = document.createElement('span');
          valSpan.className = 'diag-value';
          valSpan.textContent = val;
          item.appendChild(labelSpan);
          item.appendChild(valSpan);
          diagCard.appendChild(item);
        }

        diagBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          diagCard.hidden = !diagCard.hidden;
          diagCard.classList.toggle('hidden', diagCard.hidden);
        });

        header.appendChild(diagBtn);
        row.appendChild(header);
        row.appendChild(diagCard);
      } else {
        row.appendChild(header);
      }
    } else {
      const speaker = document.createElement('div');
      speaker.className = 'transcript-speaker speaker-user';
      speaker.textContent = 'You';
      row.appendChild(speaker);
    }

    const body = document.createElement('div');
    body.className = `transcript-body transcript-body-${message.role}`;
    renderMarkdownLite(body, message.content);
    row.appendChild(body);
    if (message.role === 'user' && Array.isArray(message.attachments) && message.attachments.length > 0) {
      row.appendChild(buildAttachmentChips(message.attachments));
    }

    container.appendChild(row);
  }
  // Restore any live user turn the durable transcript does not carry yet.
  const durableUserTurns = new Set(
    messages.filter((message) => message.role === 'user').map((message) => normalizeTurnText(message.content)),
  );
  for (const row of liveUserRows) {
    const text = normalizeTurnText(row.querySelector('.transcript-body')?.textContent);
    if (text && !durableUserTurns.has(text)) container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
  scrollConversationToEnd();
  requestAnimationFrame(() => {
    container.scrollTop = container.scrollHeight;
    scrollConversationToEnd();
  });
  if (container === result) {
    const lastMsg = messages.length ? messages[messages.length - 1] : null;
    lastTranscriptAssistantTail = lastMsg && lastMsg.role === 'assistant' ? String(lastMsg.content || '') : '';
    syncAssistantMode();
    renderModelAttribution();
    void refreshConversationResults();
  }
}

function renderConversationContext(context) {
  if (conversationContextEmpty) conversationContextEmpty.hidden = Boolean(context);
  if (conversationContextBody) conversationContextBody.hidden = !context;
  if (!context) return;
  const status = context.state === 'available'
    ? `Stored working context · updated ${new Date(context.updatedAt).toLocaleString()}`
    : context.state === 'no_workspace'
      ? 'General conversation: no repository-scoped working context.'
      : 'No stored working-context summary exists for this conversation and selected repository.';
  setText('context-objective', context.objective || 'No stored objective');
  setText('context-intent', context.latestUserIntent || 'Not recorded');
  setText('context-repository', context.repositoryName || 'General / no repository');
  setText('context-pending', context.pendingAction || 'None');
  setText('context-policy', context.executionPolicy || 'Not recorded');
  setText('context-files', context.relevantFiles.length ? context.relevantFiles.join('\n') : 'None recorded');
  setText('context-symbols', context.relevantSymbols.length ? context.relevantSymbols.join('\n') : 'None recorded');
  setText('context-attachments', context.attachmentNames.length ? context.attachmentNames.join('\n') : 'None');
  setText('context-constraints', context.constraints.length ? context.constraints.join('\n') : 'None recorded');
  setText('context-findings', context.findings || 'None recorded');
  setText('context-validation', context.validation || 'None recorded');
  const extras = [];
  if (context.attachmentNames.length) extras.push(`${context.attachmentNames.length} attachment(s)`);
  if (context.citationCount) extras.push(`${context.citationCount} citation(s)`);
  if (context.researchSourceCount) extras.push(`${context.researchSourceCount} research source(s)`);
  setText('context-counts', `${context.messageCount} message(s)${extras.length ? ` · ${extras.join(' · ')}` : ''}`);
  setText('conversation-context-status', status);
  if (conversationExportStatus) conversationExportStatus.textContent = '';
}

async function refreshOpenedTranscript(conversationId) {
  const fetchEpoch = activeConversationEpoch;
  try {
    const opened = await withCoreConnectRetry(() => api.openConversation(conversationId, false));
    if (fetchEpoch !== activeConversationEpoch || viewingConversationId !== conversationId) return;
    const resultNode = document.getElementById('result');
    if (resultNode && viewingConversationId === conversationId) {
      if (opened.messages.length > 0) {
        renderConversationTranscript(resultNode, opened.messages);
        resultNode.hidden = false;
      } else if (resultNode.childElementCount === 0) {
        // Nothing durable and nothing live: there is no conversation to show.
        resultNode.hidden = true;
      }
      resultNode.scrollTop = resultNode.scrollHeight;
      scrollConversationToEnd();
      requestAnimationFrame(() => {
        resultNode.scrollTop = resultNode.scrollHeight;
        scrollConversationToEnd();
      });
    }
    updateQuickAnswerFromMessages(opened.messages);
    if (viewingConversationId === conversationId && fetchEpoch === activeConversationEpoch) renderConversationContext(opened.context);
    void refreshConversationsRail();
  } catch (err) {
    showOperationError?.(err);
  }
}

function dayBucket(updatedAt, now) {
  const then = new Date(updatedAt);
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(then)) / 86_400_000);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return 'previous7';
  return 'older';
}

/** Pure grouping: pinned entries in their own group first, then
 * Today/Yesterday/Previous 7 Days/Older by `updatedAt`, each sorted newest
 * first. Exported implicitly via closure for the renderer test to import. */
function groupConversationsForRail(entries, now = new Date()) {
  const groups = { pinned: [], today: [], yesterday: [], previous7: [], older: [] };
  for (const entry of entries) {
    if (entry.pinnedAt) {
      groups.pinned.push(entry);
    } else {
      groups[dayBucket(entry.updatedAt, now)].push(entry);
    }
  }
  const byRecency = (a, b) => b.updatedAt.localeCompare(a.updatedAt);
  for (const key of Object.keys(groups)) groups[key].sort(byRecency);
  return groups;
}

const CONVERSATION_STATE_LABELS = {
  active: 'Active',
  needs_approval: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
};

function buildConversationEntryNode(entry, { showRestore } = {}) {
  const node = document.createElement('div');
  node.className = 'conversation-entry';
  node.dataset.conversationId = entry.id;
  if (entry.id === viewingConversationId) node.classList.add('is-selected');

  const titleRow = document.createElement('div');
  titleRow.className = 'conversation-entry-title-row';
  const title = document.createElement('span');
  title.className = 'conversation-entry-title';
  title.textContent = entry.title?.trim() || 'Untitled conversation';
  titleRow.appendChild(title);
  if (entry.pinnedAt) {
    const pin = document.createElement('span');
    pin.title = 'Pinned';
    pin.textContent = '📌';
    titleRow.appendChild(pin);
  }
  node.appendChild(titleRow);

  if (entry.preview) {
    const preview = document.createElement('div');
    preview.className = 'conversation-entry-preview';
    preview.textContent = entry.preview;
    node.appendChild(preview);
  }

  const meta = document.createElement('div');
  meta.className = 'conversation-entry-meta';
  const stateBadge = document.createElement('span');
  stateBadge.className = 'conversation-state-badge';
  stateBadge.dataset.state = entry.state;
  stateBadge.textContent = CONVERSATION_STATE_LABELS[entry.state] || entry.state;
  meta.appendChild(stateBadge);
  if (entry.repositoryName) {
    const repo = document.createElement('span');
    repo.textContent = entry.repositoryName;
    meta.appendChild(repo);
  }
  const time = document.createElement('span');
  time.textContent = new Date(entry.updatedAt).toLocaleString();
  meta.appendChild(time);
  node.appendChild(meta);

  const actions = document.createElement('div');
  actions.className = 'conversation-entry-actions';

  if (showRestore) {
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restore';
    restore.addEventListener('click', async (event) => {
      event.stopPropagation();
      conversationsRailCache = await api.unarchiveConversation(entry.id);
      renderConversationsRail();
    });
    actions.appendChild(restore);
  } else {
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.textContent = 'Rename';
    rename.addEventListener('click', (event) => {
      event.stopPropagation();
      // Electron has no window.prompt(); rename in place instead.
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'conversation-rename-input';
      input.value = entry.title || '';
      input.maxLength = 200;
      title.replaceWith(input);
      input.focus();
      input.select();
      let settled = false;
      const finish = async (commit) => {
        if (settled) return;
        settled = true;
        const trimmed = input.value.trim();
        try {
          if (commit && trimmed && trimmed !== (entry.title || '')) {
            conversationsRailCache = await api.renameConversation(entry.id, trimmed);
          }
        } catch (err) {
          showOperationError?.(err);
        }
        renderConversationsRail();
        syncAssistantMode();
      };
      input.addEventListener('click', (e) => e.stopPropagation());
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') void finish(true);
        else if (e.key === 'Escape') void finish(false);
      });
      input.addEventListener('blur', () => { void finish(true); });
    });
    actions.appendChild(rename);

    const pinToggle = document.createElement('button');
    pinToggle.type = 'button';
    pinToggle.textContent = entry.pinnedAt ? 'Unpin' : 'Pin';
    pinToggle.addEventListener('click', async (event) => {
      event.stopPropagation();
      conversationsRailCache = entry.pinnedAt
        ? await api.unpinConversation(entry.id)
        : await api.pinConversation(entry.id);
      renderConversationsRail();
    });
    actions.appendChild(pinToggle);

    const archive = document.createElement('button');
    archive.type = 'button';
    archive.textContent = 'Archive';
    archive.addEventListener('click', async (event) => {
      event.stopPropagation();
      conversationsRailCache = await api.archiveConversation(entry.id);
      renderConversationsRail();
    });
    actions.appendChild(archive);
  }
  node.appendChild(actions);

  node.addEventListener('click', () => { void openConversationFromRail(entry.id); });
  return node;
}

function appendConversationGroup(container, label, entries, options) {
  if (!entries.length) return;
  const heading = document.createElement('div');
  heading.className = 'conversations-rail-group-title';
  heading.textContent = label;
  container.appendChild(heading);
  for (const entry of entries) container.appendChild(buildConversationEntryNode(entry, options));
}

function renderConversationsRail() {
  if (!conversationsRailGroups) return;
  const showingArchived = Boolean(conversationsShowArchived?.checked);
  conversationsRailGroups.replaceChildren();
  if (conversationsRailEmpty) conversationsRailEmpty.hidden = conversationsRailCache.length > 0;
  const groups = groupConversationsForRail(conversationsRailCache);
  appendConversationGroup(conversationsRailGroups, 'Pinned', groups.pinned, { showRestore: showingArchived });
  appendConversationGroup(conversationsRailGroups, 'Today', groups.today, { showRestore: showingArchived });
  appendConversationGroup(conversationsRailGroups, 'Yesterday', groups.yesterday, { showRestore: showingArchived });
  appendConversationGroup(conversationsRailGroups, 'Previous 7 Days', groups.previous7, { showRestore: showingArchived });
  appendConversationGroup(conversationsRailGroups, 'Older', groups.older, { showRestore: showingArchived });
}

/**
 * Cold start can call any Core-backed IPC before session.start() finishes
 * connecting (e.g. a stale discovery record forces a fresh Core spawn) —
 * that is transient, not a real failure, so retry briefly before surfacing
 * it as an error. Shared so every call site racing this window (the eager
 * initial conversations-rail load, and the auto-restore of a persisted
 * selected conversation) gets the same protection instead of each
 * reimplementing it — a second, unprotected call site is exactly how this
 * same race resurfaced as "Core is not connected" on desktop:openConversation.
 */
async function withCoreConnectRetry(fn, attempt = 0) {
  try {
    return await fn();
  } catch (err) {
    const stillConnecting = attempt < 5 && /Core is not connected/i.test(err?.message ?? '');
    if (!stillConnecting) throw err;
    await new Promise((resolve) => setTimeout(resolve, 400));
    return withCoreConnectRetry(fn, attempt + 1);
  }
}

async function refreshConversationsRail() {
  if (typeof api.listConversations !== 'function') return;
  try {
    conversationsRailCache = await withCoreConnectRetry(() => api.listConversations(Boolean(conversationsShowArchived?.checked)));
    renderConversationsRail();
  } catch (err) {
    showOperationError?.(err);
  }
}

async function openConversationFromRail(conversationId) {
  const fetchEpoch = ++conversationEpoch;
  activeConversationEpoch = fetchEpoch;
  try {
    const opened = await withCoreConnectRetry(() => api.openConversation(conversationId));
    if (fetchEpoch !== activeConversationEpoch) return;
    viewingConversationId = conversationId;
    userNavigatedAway = Boolean(lastSnapshot?.running && lastSnapshot?.activeConversationId && conversationId !== lastSnapshot.activeConversationId);
    lastTranscriptRefetchKey = null;
    const resultNode = document.getElementById('result');
    if (resultNode) {
      renderConversationTranscript(resultNode, opened.messages);
      resultNode.hidden = opened.messages.length === 0;
    }
    renderConversationContext(opened.context);
    syncAssistantMode();
    void refreshConversationResults();
    conversationsRailCache = await api.listConversations(Boolean(conversationsShowArchived?.checked));
    renderConversationsRail();
    await refresh().catch(() => undefined);
  } catch (err) {
    showOperationError?.(err);
  }
}

async function startNewConversation() {
  activeConversationEpoch = ++conversationEpoch;
  viewingConversationId = null;
  lastTranscriptRefetchKey = null;
  lastTranscriptAssistantTail = '';
  liveReply = { attemptId: null, text: '', finished: true };
  if (liveReplyFrame) {
    cancelAnimationFrame(liveReplyFrame);
    liveReplyFrame = 0;
  }
  userNavigatedAway = true;

  // A brand-new conversation is empty: no transcript, no task card and no
  // results from an earlier task. The earlier work stays in its own
  // conversation and in the task history.
  clearConversationPane();
  if (taskInput) {
    taskInput.value = '';
    taskInput.focus();
  }

  try {
    if (typeof api.newConversation === 'function') {
      await api.newConversation();
    }
  } catch (err) {
    showOperationError?.(err);
  }

  await refreshConversationsRail().catch(() => undefined);
  await refresh().catch(() => undefined);

  // Guarantee the conversation pane remains clean even if an immediate snapshot update fired
  if (!viewingConversationId) {
    clearConversationPane();
  }
  syncAssistantMode();
}

conversationsNew?.addEventListener('click', () => { void startNewConversation(); });
document.getElementById('btn-new-chat-header')?.addEventListener('click', () => { void startNewConversation(); });
document.getElementById('drawer-conversations-new')?.addEventListener('click', () => { void startNewConversation(); });
document.getElementById('legacy-conversations-new')?.addEventListener('click', () => { void startNewConversation(); });

conversationsShowArchived?.addEventListener('change', () => { void refreshConversationsRail(); });

conversationExport?.addEventListener('click', async () => {
  if (!viewingConversationId || typeof api.exportConversation !== 'function') return;
  conversationExport.disabled = true;
  try {
    const saved = await api.exportConversation(viewingConversationId);
    if (conversationExportStatus) conversationExportStatus.textContent = saved.saved ? `Saved to ${saved.path}` : 'Export cancelled.';
  } catch (err) {
    if (conversationExportStatus) conversationExportStatus.textContent = err instanceof Error ? err.message : String(err);
  } finally {
    conversationExport.disabled = false;
  }
});

let conversationsSearchDebounce = 0;
conversationsSearch?.addEventListener('input', () => {
  const query = conversationsSearch.value.trim();
  conversationsRailSearchQuery = query;
  window.clearTimeout(conversationsSearchDebounce);
  conversationsSearchDebounce = window.setTimeout(() => { void runConversationSearch(query); }, 200);
});

async function runConversationSearch(query) {
  if (query !== conversationsRailSearchQuery) return; // superseded by a newer keystroke
  if (!conversationsSearchResults) return;
  if (!query) {
    conversationsSearchResults.hidden = true;
    conversationsSearchResults.replaceChildren();
    if (conversationsRailGroups) conversationsRailGroups.hidden = false;
    return;
  }
  try {
    const results = await api.searchConversations(query);
    if (query !== conversationsRailSearchQuery) return;
    conversationsSearchResults.replaceChildren();
    conversationsSearchResults.hidden = false;
    if (conversationsRailGroups) conversationsRailGroups.hidden = true;
    if (!results.length) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = 'No matching conversations.';
      conversationsSearchResults.appendChild(empty);
      return;
    }
    for (const result of results) {
      const node = document.createElement('div');
      node.className = 'conversation-entry';
      const title = document.createElement('div');
      title.className = 'conversation-entry-title';
      title.textContent = result.title?.trim() || 'Untitled conversation';
      const snippet = document.createElement('div');
      snippet.className = 'conversation-entry-preview';
      snippet.textContent = result.snippet;
      node.append(title, snippet);
      node.addEventListener('click', () => { void openConversationFromRail(result.conversationId); });
      conversationsSearchResults.appendChild(node);
    }
  } catch (err) {
    showOperationError?.(err);
  }
}

function renderCockpit(snapshot) {
  const cockpit = snapshot.cockpit;
  if (!cockpit) return;
  renderChatChrome(snapshot);
  renderClocks(snapshot);
  setText('cockpit-phase', isChatInteraction(snapshot) ? 'conversation' : cockpit.phase);
  setText('mission-phase-brief', isChatInteraction(snapshot) ? '—' : (cockpit.phase || '—'));
  setText('cockpit-action', cockpit.currentAction?.title ?? (snapshot.running ? (isChatInteraction(snapshot) ? 'Chatting' : 'Working') : 'Idle'));
  setText('cockpit-productive', String(cockpit.productiveUsed));
  setText('cockpit-allowance', String(cockpit.phaseAllowance));
  setText('cockpit-repair', String(cockpit.repairCycle));
  setText('cockpit-read', cockpit.filesRead.join(', ') || 'none');
  setText('cockpit-changed', cockpit.filesChanged.join(', ') || 'none');
  setText('cockpit-validation', cockpit.validationStatus);
  setText('cockpit-verification', cockpit.verificationStatus);
  renderMetrics(cockpit.metrics);
  renderFilesTab(snapshot);
  renderWorkstreamHeadline(snapshot);

  activity.replaceChildren();
  for (const item of cockpit.checkpoints) {
    const row = document.createElement('li');
    const count = item.count && item.count > 1 ? ` ×${item.count}` : '';
    const duration = typeof item.durationMs === 'number' ? ` (${formatClock(item.durationMs)})` : '';
    // item.detail is always a bounded operational summary here (see
    // missionCockpit.ts coalesceCheckpoints) — never the full model/tool
    // response text, which lives only in the conversation pane above.
    row.appendChild(document.createTextNode(
      `${item.title}${count}${duration}${item.detail ? ` — ${item.detail}` : ''}`,
    ));
    if (item.outcome) row.dataset.outcome = item.outcome;
    if (item.id && item.id.startsWith('term:') && item.outcome === 'ok') {
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'view-response-link';
      viewBtn.textContent = 'View response';
      viewBtn.addEventListener('click', () => {
        document.getElementById('result')?.scrollIntoView({ block: 'nearest' });
      });
      row.appendChild(viewBtn);
    }
    activity.appendChild(row);
  }
  if (activitySummary) {
    activitySummary.textContent = humanProgressSentence(snapshot);
  }
  if (activityDetails) {
    activityDetails.hidden = false;
    const hasEvents = (cockpit.checkpoints?.length ?? 0) > 0 || (cockpit.diagnostics?.length ?? 0) > 0;
    if (!hasEvents && !snapshot.running && !cockpit.terminal) {
      activityDetails.open = false;
    }
  }
  renderMissionTimeline(snapshot);
  renderMissionTopology(snapshot);
  updateCoreReactor(deriveJarvisCoreState(snapshot), snapshot);
  diagnosticsList.replaceChildren();
  for (const event of cockpit.diagnostics) {
    const row = document.createElement('li');
    row.textContent = `${event.at} ${event.summary}`;
    diagnosticsList.appendChild(row);
  }
  if (followLatest) {
    activity.lastElementChild?.scrollIntoView({ block: 'end' });
  }
  jumpLatest.hidden = followLatest;
}

function renderOpenRouter(snapshot) {
  if (!openrouterStatus) return;
  const or = snapshot.openRouter ?? {};
  const ready = Boolean(or.submissionReady);
  const keyLabel = or.keyConfigured ? 'configured' : 'not configured';
  const modelName = or.model || 'unset';
  const capLabel = typeof or.maxUsd === 'number' ? `$${or.maxUsd}` : 'unset';
  const status = ready ? 'ready' : 'not ready';
  openrouterStatus.textContent = `Status: ${status} · Key: ${keyLabel} · Model: ${modelName} · Cap: ${capLabel}`
    + (or.statusDetail ? ` — ${or.statusDetail}` : '');
  if (openrouterClearKey) openrouterClearKey.disabled = !ready || !or.keyConfigured;
  if (openrouterSetKey) openrouterSetKey.disabled = !ready;
  if (openrouterKey) openrouterKey.disabled = !ready;
  if (inferenceProvider && inferenceProvider.options) {
    const cloudOption = [...inferenceProvider.options].find((option) => option.value === 'openrouter');
    if (cloudOption) {
      cloudOption.disabled = !ready;
      cloudOption.textContent = ready ? 'OpenRouter (explicit cloud)' : 'OpenRouter — not ready';
    }
  }
}

function renderModels(snapshot) {
  if (!modelSelect) return;
  const models = snapshot.installedModels ?? [];
  const cloud = snapshot.cloud ?? null;
  const cloudProviders = (cloud?.providers ?? []).filter((provider) => provider.enabled && provider.configured);
  const cloudModels = [];
  for (const provider of cloudProviders) {
    for (const model of cloud?.listings?.[provider.id]?.pool ?? []) {
      cloudModels.push({ value: `${provider.id}::${model.id}`, label: `${provider.displayName} — ${model.displayName || model.id}` });
    }
  }
  // A selection survives a restart even though the discovered pool does not; keep it visible
  // rather than silently snapping the dropdown back to a local model.
  const selectedCloud = cloud?.selectedModel ?? null;
  if (selectedCloud && !cloudModels.some((entry) => entry.value === selectedCloud)) {
    const index = selectedCloud.indexOf('::');
    const providerId = index > 0 ? selectedCloud.slice(0, index) : 'cloud';
    const provider = (cloud?.providers ?? []).find((entry) => entry.id === providerId);
    cloudModels.unshift({
      value: selectedCloud,
      label: `${provider?.displayName ?? providerId} — ${selectedCloud.slice(index + 2)} (rerun discovery to verify)`,
    });
  }
  const selected = selectedCloud
    ? selectedCloud
    : snapshot.modelIsAuto
      ? '__auto__'
      : snapshot.model ?? '';
  const signature = `auto|${models.join('|')}|${cloudModels.map((entry) => entry.value).join('|')}`;
  if (modelSelect.dataset.signature !== signature) {
    modelSelect.dataset.signature = signature;
    modelSelect.replaceChildren();
    const auto = document.createElement('option');
    auto.value = '__auto__';
    auto.textContent = 'Auto (recommended)';
    modelSelect.appendChild(auto);
    if (models.length === 0 && cloudModels.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No models found';
      modelSelect.appendChild(option);
    } else if (models.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No local Ollama models found';
      modelSelect.appendChild(option);
    } else {
      for (const name of models) {
        const option = document.createElement('option');
        option.value = name;
        option.textContent = name;
        modelSelect.appendChild(option);
      }
    }
    if (cloudModels.length > 0) {
      const group = document.createElement('optgroup');
      group.label = 'Free cloud — approved public text only';
      for (const entry of cloudModels) {
        const option = document.createElement('option');
        option.value = entry.value;
        option.textContent = entry.label;
        group.appendChild(option);
      }
      modelSelect.appendChild(group);
    }
  }
  if (selected && [...modelSelect.options].some((option) => option.value === selected)) {
    modelSelect.value = selected;
  }
  modelSelect.disabled = snapshot.running;
}

/**
 * The approval of one cloud send. It shows exactly what leaves this PC: the fixed neutral instruction and the
 * person's own text, the provider and the model. Nothing else is sent, and the person can cancel.
 */
function confirmCloudPublicText(preview) {
  return new Promise((resolve) => {
    const dialog = document.createElement('dialog');
    dialog.className = 'cloud-approval-dialog';
    dialog.setAttribute('aria-labelledby', 'cloud-approval-title');
    const title = document.createElement('h3');
    title.id = 'cloud-approval-title';
    title.textContent = `Send this to ${preview.providerName} (${preview.model})?`;
    const lead = document.createElement('p');
    lead.className = 'cloud-approval-lead';
    lead.textContent = 'These are the only two messages that leave this PC. No files, history, memory, Gmail, Calendar or tools are included, and a failure never falls back to a paid service.';
    const block = (label, text) => {
      const wrap = document.createElement('div');
      const caption = document.createElement('div');
      caption.className = 'cloud-approval-caption';
      caption.textContent = label;
      const body = document.createElement('pre');
      body.className = 'cloud-approval-text';
      body.textContent = text;
      wrap.append(caption, body);
      return wrap;
    };
    const actions = document.createElement('div');
    actions.className = 'cloud-approval-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'apex-chip';
    cancel.textContent = 'Cancel';
    const send = document.createElement('button');
    send.type = 'button';
    send.className = 'dispatch';
    send.textContent = 'Send to the cloud';
    actions.append(cancel, send);
    dialog.append(title, lead, block('Fixed instruction', preview.systemPrompt), block('Your text', preview.text), actions);
    const finish = (approved) => { dialog.close(); dialog.remove(); resolve(approved); };
    cancel.addEventListener('click', () => finish(false));
    send.addEventListener('click', () => finish(true));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    document.body.appendChild(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** The `<provider>::<model>` the composer would send to, or null for local. */
function selectedCloudModel() {
  const fromSelect = modelSelect?.value?.includes('::') ? modelSelect.value : null;
  return fromSelect || lastSnapshot?.cloud?.selectedModel || null;
}

function cloudProviderLabel(cloud, providerId) {
  return (cloud?.providers ?? []).find((provider) => provider.id === providerId)?.displayName || providerId;
}

/**
 * Settings → AI Models & Providers. Cards are built once per provider and updated in place so a
 * half-typed API key is never wiped by an unrelated snapshot refresh.
 */
function renderCloudSettings(snapshot) {
  const cloud = snapshot?.cloud ?? null;
  if (cloudStateBadge) {
    const on = Boolean(cloud && !cloud.off && cloud.enabledProviders.length > 0);
    cloudStateBadge.textContent = !cloud ? 'Catalog unavailable' : on ? 'Free cloud on' : 'Cloud off';
    cloudStateBadge.classList.toggle('online', on);
    cloudStateBadge.classList.toggle('offline', !on);
  }
  if (cloudLocalFallback && cloud) cloudLocalFallback.checked = cloud.localFallback !== false;
  if (!cloudProviderList) return;
  if (!cloud) {
    if (cloudProviderList.dataset.signature !== 'unavailable') {
      cloudProviderList.dataset.signature = 'unavailable';
      const note = document.createElement('p');
      note.className = 'muted cloud-empty';
      note.textContent = 'The Core catalog is not loaded yet. Press “Refresh catalog”.';
      cloudProviderList.replaceChildren(note);
      cloudCards.clear();
    }
    return;
  }
  const ids = cloud.providers.map((provider) => provider.id);
  for (const id of [...cloudCards.keys()]) {
    if (!ids.includes(id)) {
      cloudCards.get(id).root.remove();
      cloudCards.delete(id);
    }
  }
  if (ids.length === 0) {
    if (cloudProviderList.dataset.signature !== 'empty') {
      cloudProviderList.dataset.signature = 'empty';
      const note = document.createElement('p');
      note.className = 'muted cloud-empty';
      note.textContent = 'No providers in the catalog. Press “Refresh catalog”.';
      cloudProviderList.replaceChildren(note);
      cloudCards.clear();
    }
    return;
  }
  cloudProviderList.dataset.signature = ids.join('|');
  const ordered = ids.map((id) => cloudCards.get(id)?.root ?? buildCloudProviderCard(id)).filter(Boolean);
  if (cloudProviderList.children.length !== ordered.length || ordered.some((node, index) => cloudProviderList.children[index] !== node)) {
    cloudProviderList.replaceChildren(...ordered);
  }
  for (const provider of cloud.providers) updateCloudProviderCard(provider, cloud);
}

const cloudCards = new Map();

function buildCloudProviderCard(providerId) {
  if (!cloudProviderList) return null;
  const root = document.createElement('article');
  root.className = 'cloud-provider';
  root.dataset.provider = providerId;

  const head = document.createElement('div');
  head.className = 'cloud-provider-head';
  const title = document.createElement('h4');
  title.className = 'cloud-provider-name';
  const badge = document.createElement('span');
  badge.className = 'int-badge';
  head.append(title, badge);

  const meta = document.createElement('p');
  meta.className = 'cloud-provider-meta';

  const warning = document.createElement('p');
  warning.className = 'cloud-provider-warning';
  warning.hidden = true;

  const keyRow = document.createElement('div');
  keyRow.className = 'cloud-key-row';
  const keyInput = document.createElement('input');
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyInput.placeholder = 'Paste API key (stored encrypted on this PC)';
  keyInput.setAttribute('aria-label', 'API key');
  const saveKey = document.createElement('button');
  saveKey.type = 'button';
  saveKey.className = 'apex-chip';
  saveKey.textContent = 'Save key';
  const clearKey = document.createElement('button');
  clearKey.type = 'button';
  clearKey.className = 'apex-chip';
  clearKey.textContent = 'Clear';
  keyRow.append(keyInput, saveKey, clearKey);

  const baseRow = document.createElement('label');
  baseRow.className = 'cloud-base-row';
  baseRow.hidden = true;
  const baseLabel = document.createElement('span');
  baseLabel.textContent = 'Endpoint (include your account id)';
  const baseInput = document.createElement('input');
  baseInput.type = 'url';
  baseInput.placeholder = 'https://api.cloudflare.com/client/v4/accounts/<account-id>/ai/v1';
  baseInput.spellcheck = false;
  baseRow.append(baseLabel, baseInput);

  const actions = document.createElement('div');
  actions.className = 'cloud-provider-actions';
  const enabledLabel = document.createElement('label');
  enabledLabel.className = 'cloud-enabled';
  const enabled = document.createElement('input');
  enabled.type = 'checkbox';
  const enabledText = document.createElement('span');
  enabledText.textContent = 'Enabled';
  enabledLabel.append(enabled, enabledText);
  const discover = document.createElement('button');
  discover.type = 'button';
  discover.className = 'apex-chip';
  discover.textContent = 'Discover free models';
  const keyLink = document.createElement('a');
  keyLink.className = 'cloud-key-link';
  keyLink.target = '_blank';
  keyLink.rel = 'noreferrer noopener';
  keyLink.textContent = 'Get a free key';
  actions.append(enabledLabel, discover, keyLink);

  const listing = document.createElement('div');
  listing.className = 'cloud-listing';

  const testResult = document.createElement('p');
  testResult.className = 'cloud-test-result';
  testResult.setAttribute('role', 'status');

  root.append(head, meta, warning, keyRow, baseRow, actions, listing, testResult);
  cloudProviderList.appendChild(root);

  const entry = { root, title, badge, meta, warning, keyInput, saveKey, clearKey, baseRow, baseInput, enabled, discover, keyLink, listing, testResult };
  cloudCards.set(providerId, entry);

  saveKey.addEventListener('click', async () => {
    showOperationError(null);
    saveKey.disabled = true;
    try {
      const state = await api.setCloudProviderKey(providerId, keyInput.value, baseInput.value.trim() || undefined);
      keyInput.value = '';
      if (cloudActionNote) cloudActionNote.textContent = `Saved and enabled ${cloudProviderLabel(state, providerId)}. Discover its free models next.`;
      renderSnapshot(await api.getSnapshot());
    } catch (error) {
      showOperationError(error);
    } finally {
      saveKey.disabled = false;
    }
  });

  clearKey.addEventListener('click', async () => {
    showOperationError(null);
    if (!window.confirm('Remove this provider key and turn the provider off? Cloud models from it will no longer be selectable.')) return;
    try {
      const state = await api.clearCloudProviderKey(providerId);
      if (cloudActionNote) cloudActionNote.textContent = `${cloudProviderLabel(state, providerId)} key removed.`;
      renderSnapshot(await api.getSnapshot());
    } catch (error) {
      showOperationError(error);
    }
  });

  enabled.addEventListener('change', async () => {
    showOperationError(null);
    try {
      const state = await api.setCloudProviderEnabled(providerId, enabled.checked);
      if (cloudActionNote) cloudActionNote.textContent = enabled.checked
        ? `${cloudProviderLabel(state, providerId)} enabled for approved public text.`
        : `${cloudProviderLabel(state, providerId)} disabled.`;
      renderSnapshot(await api.getSnapshot());
    } catch (error) {
      showOperationError(error);
      enabled.checked = !enabled.checked;
    }
  });

  discover.addEventListener('click', async () => {
    showOperationError(null);
    discover.disabled = true;
    const original = discover.textContent;
    discover.textContent = 'Discovering…';
    try {
      const state = await api.discoverCloudModels(providerId);
      const listingState = state.listings?.[providerId];
      if (cloudActionNote) {
        cloudActionNote.textContent = listingState?.ok
          ? `${cloudProviderLabel(state, providerId)}: ${listingState.pool.length} free model${listingState.pool.length === 1 ? '' : 's'} in ${listingState.latencyMs} ms.`
          : `${cloudProviderLabel(state, providerId)}: discovery failed — ${cloudListingError(listingState)}`;
      }
      renderSnapshot(await api.getSnapshot());
    } catch (error) {
      showOperationError(error);
    } finally {
      discover.disabled = false;
      discover.textContent = original;
    }
  });

  return root;
}

/** Plain words for the catalog's payment-method fact; an unverified answer is said to be unverified. */
function cloudPaymentLabel(value) {
  const raw = String(value ?? '').toLowerCase();
  if (raw === 'doesnotrequirepaymentmethod' || raw === 'no') return 'No payment method needed';
  if (raw === 'requirespaymentmethod' || raw === 'yes') return 'Payment method required';
  return 'Payment method: not verified';
}

function cloudListingError(listing) {
  if (!listing) return 'no result';
  const message = listing.error || listing.errorClass || 'unknown error';
  return String(message);
}

function updateCloudProviderCard(provider, cloud) {
  const entry = cloudCards.get(provider.id);
  if (!entry) return;
  entry.title.textContent = provider.displayName;
  const on = provider.enabled && provider.configured;
  entry.badge.textContent = !provider.configured ? 'No key' : on ? 'Enabled' : 'Off';
  entry.badge.className = `int-badge ${on ? 'online' : provider.configured ? 'busy' : 'offline'}`;
  entry.meta.textContent = `Free tier: ${provider.freeTier?.kind ?? 'unknown'}`
    + ` · ${cloudPaymentLabel(provider.paymentMethodRequired)}`
    + ` · Catalog verified ${provider.lastVerifiedAt || 'unknown'}`
    + (provider.keyHint ? ` · Key ${provider.keyHint}` : '');
  if (provider.freeTier?.note) entry.meta.textContent += ` — ${provider.freeTier.note}`;
  entry.warning.hidden = !provider.privacyWarning;
  entry.warning.textContent = provider.privacyWarning ?? '';
  entry.baseRow.hidden = !provider.requiresBaseUrlInput;
  const ownServer = provider.id === 'custom-openai';
  // A placeholder in the catalog (https://localhost/v1, {accountId}) is a hint, not a value worth pre-filling.
  if (provider.requiresBaseUrlInput && !ownServer && !entry.baseInput.value && provider.baseUrl) entry.baseInput.value = provider.baseUrl;
  entry.baseInput.placeholder = ownServer
    ? 'http://192.168.1.20:8080/v1'
    : provider.baseUrl && !provider.requiresBaseUrlInput
      ? provider.baseUrl
      : 'https://…';
  if (entry.baseRow.firstElementChild) {
    entry.baseRow.firstElementChild.textContent = ownServer
      ? 'Server address (on this PC or your own network; any key text works if your server has none)'
      : 'Endpoint (include your account id)';
  }
  entry.enabled.checked = provider.enabled;
  entry.enabled.disabled = !provider.configured;
  entry.discover.disabled = !provider.configured;
  entry.keyLink.href = provider.apiKeysUrl || provider.signupUrl || provider.docsUrl || '#';
  entry.keyLink.textContent = provider.freeTier?.kind === 'free-forever' ? 'Get a free key' : 'Free-tier details';

  const listing = cloud?.listings?.[provider.id] ?? null;
  const test = cloud?.tests?.[provider.id] ?? null;
  const selected = cloud?.selectedModel ?? null;
  const signature = JSON.stringify({
    models: (listing?.pool ?? []).map((model) => [model.id, model.displayName, model.contextWindow ?? null, model.vision, model.tools]),
    ok: listing?.ok ?? null,
    error: listing?.error ?? null,
    latency: listing?.latencyMs ?? null,
    test,
    selected,
  });
  if (entry.listing.dataset.signature === signature) return;
  entry.listing.dataset.signature = signature;

  const children = [];
  if (!listing) {
    const hint = document.createElement('p');
    hint.className = 'muted cloud-listing-hint';
    hint.textContent = provider.configured
      ? 'Press “Discover free models” to read this provider’s live model list and keep only verified free ones.'
      : 'Add a key to discover this provider’s free models.';
    children.push(hint);
  } else if (!listing.ok) {
    const error = document.createElement('p');
    error.className = 'cloud-listing-error';
    error.textContent = `${listing.errorClass ?? 'error'}: ${cloudListingError(listing)}`;
    children.push(error);
  } else if (listing.pool.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'cloud-listing-error';
    empty.textContent = 'No verified free generative models were returned. Nothing from this provider can be selected.';
    children.push(empty);
  } else {
    const summary = document.createElement('p');
    summary.className = 'cloud-listing-summary';
    const excluded = listing.excluded ?? {};
    summary.textContent = `${listing.pool.length} free model${listing.pool.length === 1 ? '' : 's'} · ${listing.latencyMs} ms`
      + ` · excluded ${excluded.paid ?? 0} paid, ${excluded.trial ?? 0} trial, ${excluded.promotional ?? 0} promotional, ${excluded.unknown ?? 0} unknown`;
    children.push(summary);
    const list = document.createElement('ul');
    list.className = 'cloud-model-list';
    for (const model of listing.pool) {
      const item = document.createElement('li');
      item.className = 'cloud-model-row';
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = `cloud-model-${provider.id}`;
      const encoded = `${provider.id}::${model.id}`;
      radio.checked = selected === encoded;
      radio.setAttribute('aria-label', `Use ${model.displayName || model.id} from ${provider.displayName}`);
      radio.addEventListener('change', async () => {
        showOperationError(null);
        try {
          renderSnapshot(await api.selectCloudModel(encoded));
          if (cloudActionNote) cloudActionNote.textContent = `${provider.displayName} ${model.displayName || model.id} selected. Each send asks you to approve its exact text.`;
        } catch (error) {
          showOperationError(error);
        }
      });
      const label = document.createElement('div');
      label.className = 'cloud-model-label';
      const name = document.createElement('span');
      name.className = 'cloud-model-name';
      name.textContent = model.displayName || model.id;
      const detail = document.createElement('span');
      detail.className = 'cloud-model-detail';
      const caps = [];
      if (model.contextWindow) caps.push(`${Math.round(model.contextWindow / 1000)}k context`);
      caps.push(model.vision === true ? 'vision' : model.vision === 'unknown' ? 'vision unknown' : 'text');
      caps.push(model.tools === true ? 'tools' : 'no tools');
      detail.textContent = caps.join(' · ');
      label.append(name, detail);
      const testButton = document.createElement('button');
      testButton.type = 'button';
      testButton.className = 'apex-chip cloud-test-button';
      testButton.textContent = 'Test';
      testButton.addEventListener('click', async () => {
        showOperationError(null);
        testButton.disabled = true;
        testButton.textContent = 'Testing…';
        try {
          const state = await api.testCloudProvider(provider.id, model.id);
          const result = state.tests?.[provider.id];
          if (result?.ok) {
            if (cloudActionNote) cloudActionNote.textContent = `${provider.displayName} ${model.id}: replied in ${result.latencyMs} ms${result.replyPreview ? ` (“${result.replyPreview}”)` : ''}.`;
          } else if (result) {
            if (cloudActionNote) cloudActionNote.textContent = `${provider.displayName} ${model.id}: ${result.errorClass ?? 'error'} — ${result.error ?? 'no reply'}`;
          }
        } catch (error) {
          showOperationError(error);
        } finally {
          testButton.disabled = false;
          testButton.textContent = 'Test';
          renderSnapshot(await api.getSnapshot());
        }
      });
      item.append(radio, label, testButton);
      list.appendChild(item);
    }
    children.push(list);
  }
  entry.listing.replaceChildren(...children);

  if (test) {
    const rate = test.rateLimit ?? {};
    const rateBits = [
      rate.limitRequests ? `limit ${rate.limitRequests}` : '',
      rate.remainingRequests ? `remaining ${rate.remainingRequests}` : '',
      rate.resetRequests ? `resets ${rate.resetRequests}` : '',
      rate.retryAfter ? `retry after ${rate.retryAfter}s` : '',
    ].filter(Boolean);
    entry.testResult.className = `cloud-test-result ${test.ok ? 'ok' : 'failed'}`;
    entry.testResult.textContent = test.ok
      ? `Test passed · ${test.model} · ${test.latencyMs} ms${rateBits.length ? ` · ${rateBits.join(' · ')}` : ''}${test.replyPreview ? ` · reply “${test.replyPreview}”` : ''}`
      : `Test failed · ${test.model} · ${test.errorClass ?? 'error'}${test.error ? `: ${test.error}` : ''}${rateBits.length ? ` · ${rateBits.join(' · ')}` : ''}`;
  } else {
    entry.testResult.className = 'cloud-test-result';
    entry.testResult.textContent = '';
  }
}

/**
 * Shows the exact two messages Core will send and resolves true only if the operator approves
 * this exact text. Cancel and Escape both refuse.
 */
function askCloudApproval(preview) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('cloud-approval');
    if (!overlay) { resolve(false); return; }
    const provider = document.getElementById('cloud-approval-provider');
    const system = document.getElementById('cloud-approval-system');
    const text = document.getElementById('cloud-approval-text');
    const reason = document.getElementById('cloud-approval-reason');
    const send = document.getElementById('cloud-approval-send');
    const cancel = document.getElementById('cloud-approval-cancel');
    if (!send || !cancel) { resolve(false); return; }
    if (provider) provider.textContent = `${preview.providerName} · ${preview.model}`;
    if (system) system.textContent = preview.systemPrompt;
    if (text) text.textContent = preview.text;
    if (reason) {
      reason.hidden = preview.eligible !== false;
      reason.textContent = preview.reason ?? '';
    }
    send.disabled = preview.eligible === false;

    const previousFocus = document.activeElement;
    const finish = (approved) => {
      overlay.hidden = true;
      document.removeEventListener('keydown', onKey);
      cancel.removeEventListener('click', onCancel);
      send.removeEventListener('click', onSend);
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
      resolve(approved);
    };
    const onKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); finish(false); }
      if (event.key === 'Tab') {
        // Keep focus inside the approval card while it is open.
        const focusables = [send, cancel].filter((node) => !node.disabled);
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    const onCancel = () => finish(false);
    const onSend = () => finish(true);
    document.addEventListener('keydown', onKey);
    cancel.addEventListener('click', onCancel);
    send.addEventListener('click', onSend);
    overlay.hidden = false;
    send.focus();
  });
}

function renderWorkers(snapshot) {
  if (!workerSelect) return;
  const workers = snapshot.workers ?? [];
  const selected = snapshot.selectedWorker ?? workers.find((worker) => worker.selectable)?.id ?? '';
  const signature = workers.map((worker) => `${worker.id}:${worker.selectable}`).join('|');
  if (workerSelect.dataset.signature !== signature) {
    workerSelect.dataset.signature = signature;
    workerSelect.replaceChildren(...workers.map((worker) => {
      const option = document.createElement('option');
      option.value = worker.id;
      option.textContent = worker.selectable ? worker.label : `${worker.label} — unavailable`;
      option.disabled = !worker.selectable;
      return option;
    }));
  }
  workerSelect.value = selected;
  workerSelect.disabled = snapshot.running;
  const active = workers.find((worker) => worker.id === selected);
  if (workerDetail) workerDetail.textContent = active ? active.detail : '';
}

function updateContextualWorkbenchTabs(snapshot) {
  if (!snapshot) return;
  const cockpit = snapshot.cockpit;
  const hasResearch = Boolean(
    cockpit?.checkpoints?.some((c) => c.title?.toLowerCase().includes('research') || c.title?.toLowerCase().includes('search'))
    || snapshot.researchFindings?.length > 0
  );
  const hasCode = Boolean(
    (cockpit?.filesChanged?.length ?? 0) > 0
    || cockpit?.phase === 'coding'
    || cockpit?.phase === 'repair'
    || (cockpit?.validationStatus && !cockpit.validationStatus.toLowerCase().includes('not run'))
  );
  const hasFileOps = Boolean(
    cockpit?.pendingApproval
    || (cockpit?.filesRead?.length ?? 0) > 0
    || snapshot.pendingImageApproval
    || snapshot.pendingWeatherApproval
  );

  const tabResearch = document.getElementById('wb-tab-research');
  const tabCode = document.getElementById('wb-tab-code');
  const tabFileOps = document.getElementById('wb-tab-fileops');

  if (tabResearch) tabResearch.hidden = !hasResearch;
  if (tabCode) tabCode.hidden = !hasCode;
  if (tabFileOps) tabFileOps.hidden = !hasFileOps;

  const currentMode = floatingWorkbenchController?.getActiveMode?.();
  if (hasCode && currentMode !== 'code' && cockpit?.phase === 'coding') {
    floatingWorkbenchController?.switchMode('code');
  } else if (hasFileOps && cockpit?.pendingApproval && currentMode !== 'fileops') {
    floatingWorkbenchController?.switchMode('fileops');
  }
}

function renderSnapshot(snapshot) {
  if (!snapshot) return;
  const previousOutcome = lastSnapshot?.lastTurnOutcome ?? null;
  const previousRunning = Boolean(lastSnapshot?.running);
  const previousCoreState = lastSnapshot?.coreState ?? null;
  if (snapshot.attemptId !== lastSnapshot?.attemptId) {
    followLatest = true;
    const diagnostics = document.getElementById('diagnostics');
    if (diagnostics) diagnostics.open = false;
    if (approvedAuth?.querySelector('details')) approvedAuth.querySelector('details').open = false;
  }
  lastSnapshot = snapshot;
  window.lastSnapshot = snapshot;
  snapshotReceivedAt = Date.now();
  // A turn that started or ended changes what Home must show.
  if (previousRunning !== Boolean(snapshot.running) || previousOutcome !== (snapshot.lastTurnOutcome ?? null)) {
    scheduleAssistantBriefRefresh(false);
  }
  // The Core coming up is the moment the Home can finally know something.
  if (previousCoreState !== snapshot.coreState && snapshot.coreState === 'connected') {
    scheduleAssistantBriefRefresh(true);
    // Anything that failed while the Core was still starting is no longer
    // true; a stale error banner must not greet the operator.
    showOperationError(null);
  }
  if (snapshot.running) {
    listening = false;
    voiceSession?.cancel();
    voiceSession = null;
    voiceCaptureMode = null;
  } else if (snapshot.selectedConversationId) {
    userNavigatedAway = false;
  }
  setJarvisState(deriveJarvisState(snapshot));
  coreState.textContent = snapshot.coreState;
  const folder = snapshot.folder ?? '';
  if (folderPath) {
    folderPath.textContent = folder ? repoDisplayName(snapshot) : 'No folder selected';
  }
  if (pickFolder) {
    pickFolder.title = folder || 'Select repository';
  }
  const availability = snapshot.modelAvailable === true ? 'installed' : snapshot.modelAvailable === false ? 'missing' : 'unknown';
  if (modelLabel) {
    modelLabel.hidden = true;
    modelLabel.textContent = snapshot.modelIsAuto && !snapshot.running
      ? 'Auto (Core routed)'
      : snapshot.model
      ? (snapshot.provider === 'openrouter' ? snapshot.model : `${snapshot.model} (${availability})`)
      : 'unresolved';
  }
  if (providerLabel) providerLabel.textContent = snapshot.provider ?? 'ollama';
  if (routingLabel) routingLabel.textContent = snapshot.routingPolicy ?? 'local-only';
  if (inferenceProvider && !snapshot.running) {
    const next = snapshot.selectedInferenceProvider ?? 'ollama';
    // The free-cloud choice lives in the model dropdown; this local/OpenRouter select has no
    // cloud entry, so leave it alone rather than blanking it.
    if (next !== 'cloud' && inferenceProvider.value !== next) inferenceProvider.value = next;
    inferenceProvider.disabled = snapshot.selectedWorker === 'local-core' || next === 'cloud';
  } else if (inferenceProvider) {
    inferenceProvider.disabled = true;
  }
  ids.textContent = snapshot.attemptId ? `${snapshot.requestId} / ${snapshot.attemptId}` : '';
  const inspectIds = document.getElementById('mission-inspect-ids');
  if (inspectIds) {
    inspectIds.textContent = snapshot.attemptId
      ? `${snapshot.requestId} / ${snapshot.attemptId}`
      : '—';
  }
  currentTask.textContent = snapshot.task ? `Task: ${snapshot.task}` : 'No task running';
  if (scopeRepo) {
    const scope = snapshot.taskScope;
    const repoLabel = scope?.repository
      ?? (snapshot.folder ? collapsePath(snapshot.folder) : 'No repository selected');
    scopeRepo.textContent = repoLabel;
    scopeRepo.title = scope?.repository || snapshot.folder || '';
    scopeActions.textContent = scope?.permittedActions?.length
      ? `Permitted: ${scope.permittedActions.join('; ')}`
      : 'Select a repository to see permitted actions.';
    scopeDelivery.textContent = scope
      ? `Delivery: ${shortenEmbeddedPaths(scope.deliveryDestination)}${scope.pushAuthorized ? '' : ' (push not authorized)'}`
      : '';
    if (scopeState) {
      scopeState.textContent = scope?.authorized ? 'Mission authorized' : 'Not authorized';
    }
    if (scopeDeliveryResult) {
      const delivery = scope?.deliveryDestination || '';
      scopeDeliveryResult.textContent = scope
        ? `${shortenEmbeddedPaths(delivery)}${scope.pushAuthorized ? '' : ' (push not authorized)'}`
        : '—';
      scopeDeliveryResult.title = delivery || '';
    }
  }
  renderHostTelemetry(snapshot);
  renderToday(snapshot);
  renderEverydayTools(snapshot);
  renderCommandQueue(snapshot);
  renderRecent(snapshot);
  renderWorkers(snapshot);
  renderModels(snapshot);
  renderCloudSettings(snapshot);
  renderOpenRouter(snapshot);
  renderGmailStatus(snapshot);
  if (googleCardReady) renderGoogleCard(snapshot);
  syncCancelButton();
  // Everyday Tools intents work without a model; ordinary chat still needs one.
  // The composer stays usable while work runs: Stop wording acts now, other sends are queued by the host.
  submit.disabled = snapshot.coreState !== 'connected';
  renderLocalSpeechHint(snapshot);
  renderWakeChrome(snapshot);
  renderApproval(snapshot);
  renderCockpit(snapshot);
  updateContextualWorkbenchTabs(snapshot);
  syncAssistantMode();
  renderModelAttribution(snapshot);
  updateComposerStatus();
  renderStagedAttachments(snapshot);
  renderMailAccess(snapshot);
  // Keep mic capture aligned with host wake state (API enable must start frames).
  syncWakeMonitorFromSnapshot(snapshot);
  if (snapshot.selectedConversationId !== lastKnownSelectedConversationId) {
    const previousSelected = lastKnownSelectedConversationId;
    lastKnownSelectedConversationId = snapshot.selectedConversationId;
    void refreshConversationsRail();
    if (snapshot.selectedConversationId) {
      // After a restart the host restores the selected conversation; show its
      // history in the thread instead of an empty pane.
      const restoredOnStartup = previousSelected === null && !viewingConversationId;
      if (restoredOnStartup) {
        setViewingConversation(snapshot.selectedConversationId);
        void refreshOpenedTranscript(snapshot.selectedConversationId);
      }
    } else {
      // The host cleared the selection: a new conversation was started (from
      // this window, from the phone, or by anything else). The pane must be
      // empty — never the previous conversation's turns.
      clearConversationPane();
    }
  }
  const chatImageApproval = snapshot.pendingImageApproval;
  if (chatImageApproval && chatImageApproval.approvalId !== lastKnownPendingImageApprovalId) {
    lastKnownPendingImageApprovalId = chatImageApproval.approvalId;
    showImageStudioTab();
    // The approval card is inline in the conversation; a restored (post-restart)
    // or newly raised approval must be where the user is looking.
    if (snapshot.selectedConversationId && !viewingConversationId) {
      setViewingConversation(snapshot.selectedConversationId);
      void refreshOpenedTranscript(snapshot.selectedConversationId);
    }
    switchSurface('conversations');
    void handleImageResult({
      outcome: 'approval_required',
      approvalId: chatImageApproval.approvalId,
      attemptId: chatImageApproval.attemptId,
      presentation: chatImageApproval.presentation,
    });
  } else if (!chatImageApproval) {
    lastKnownPendingImageApprovalId = null;
  }
  const chatWeatherApproval = snapshot.pendingWeatherApproval;
  if (chatWeatherApproval && chatWeatherApproval.approvalId !== lastKnownPendingWeatherApprovalId) {
    lastKnownPendingWeatherApprovalId = chatWeatherApproval.approvalId;
    handleWeatherResult({
      outcome: 'approval_required',
      approvalId: chatWeatherApproval.approvalId,
      attemptId: chatWeatherApproval.attemptId,
      presentation: chatWeatherApproval.presentation,
    });
  } else if (!chatWeatherApproval) {
    lastKnownPendingWeatherApprovalId = null;
  }
  const currentSurface = document.querySelector('.app')?.dataset.activeSurface;
  if (currentSurface === 'tasks' || Boolean(snapshot.pendingApproval) || Boolean(snapshot.pendingImageApproval)) {
    void refreshTasksMissionsView();
  }
  renderWorkspace(snapshot);
}

async function refresh() {
  const sequence = ++refreshSequence;
  const snapshot = await api.getSnapshot();
  if (sequence === refreshSequence) renderSnapshot(snapshot);
}

async function resolve(resolution) {
  showOperationError(null);
  if (!pendingApprovalId && pendingInlineImageApprovalId && !resolvingApproval) {
    const approvalId = pendingInlineImageApprovalId;
    resolvingApproval = true;
    approve.disabled = true;
    reject.disabled = true;
    approvalPanel.hidden = true;
    approvalPanel.classList.add('hidden');
    try {
      await handleImageResult(await api.resolveImageApproval(approvalId, resolution));
    } catch (err) {
      showOperationError(err);
    } finally {
      resolvingApproval = false;
      await refresh();
    }
    return;
  }
  if (!pendingApprovalId || resolvingApproval) return;
  resolvingApproval = true;
  approve.disabled = true;
  reject.disabled = true;
  try {
    await api.resolveApproval(pendingApprovalId, resolution);
    await refresh();
  } catch (err) {
    await refresh();
    showOperationError(err);
  } finally {
    resolvingApproval = false;
    await refresh();
  }
}

pickFolder.addEventListener('click', async () => {
  renderSnapshot(await api.pickFolder());
});

coreRetryButton?.addEventListener('click', async () => {
  // One deliberate action: reconnect to the local Core. It creates no task,
  // calls no model, and touches nothing the operator owns.
  if (coreRetryButton.dataset.busy === '1') return;
  coreRetryButton.dataset.busy = '1';
  coreRetryButton.textContent = 'Retrying…';
  try {
    renderSnapshot(await api.retryCoreConnection());
  } catch (err) {
    showOperationError(err);
  } finally {
    coreRetryButton.dataset.busy = '';
    coreRetryButton.textContent = 'Retry';
  }
});

workerSelect?.addEventListener('change', async () => {
  showOperationError(null);
  try {
    renderSnapshot(await api.selectWorker(workerSelect.value));
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

inferenceProvider?.addEventListener('change', async () => {
  showOperationError(null);
  try {
    renderSnapshot(await api.selectProvider(inferenceProvider.value));
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

modelSelect?.addEventListener('change', async () => {
  showOperationError(null);
  try {
    if (!modelSelect.value) return;
    const snap = await api.selectModel(modelSelect.value);
    renderSnapshot(snap);
    const convId = snap.activeConversationId || viewingConversationId || snap.selectedConversationId;
    if (convId) {
      void refreshOpenedTranscript(convId);
    }
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

openrouterSetKey?.addEventListener('click', async () => {
  showOperationError(null);
  try {
    const value = openrouterKey?.value ?? '';
    await api.setOpenRouterApiKey(value);
    if (openrouterKey) openrouterKey.value = '';
    await refresh();
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

openrouterClearKey?.addEventListener('click', async () => {
  showOperationError(null);
  try {
    await api.clearOpenRouterApiKey();
    if (openrouterKey) openrouterKey.value = '';
    await refresh();
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

async function onMicPress(mode = 'manual') {
  if (lastSnapshot?.running) return;
  const speech = lastSnapshot?.localSpeech;
  if (!speech || speech.capability !== 'available') {
    showOperationError(speech?.blocker || 'Local speech recognition unavailable on this host.');
    return;
  }
  const capture = window.jarvisVoiceCapture;
  if (!capture?.startPushToTalkCapture) {
    showOperationError('Voice capture module failed to load in the renderer.');
    return;
  }
  if (!listening) {
    if (mode === 'auto' && capture.startVadUtteranceCapture) {
      void beginVadUtterance('click');
      return;
    }
    showOperationError(null);
    listening = true;
    voiceCaptureMode = 'manual';
    const turn = beginVoiceTurn('mic_started', 'mode=manual');
    voiceSession = capture.startPushToTalkCapture();
    setJarvisState('listening');
    renderLocalSpeechHint(lastSnapshot);
    syncCancelButton();
    activeVoiceTurn = turn;
    return;
  }
  const turn = activeVoiceTurn;
  if (voiceCaptureMode === 'auto') {
    setJarvisState('processing');
    await voiceSession?.stop?.();
    return;
  }
  listening = false;
  const session = voiceSession;
  voiceSession = null;
  voiceCaptureMode = null;
  syncCancelButton();
  logVoiceStage(turn, 'capture_stopped');
  setJarvisState('processing');
  renderLocalSpeechHint(lastSnapshot);
  try {
    const wav = await session.stop();
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_capture_stop');
      return;
    }
    if (!wav || wav.length < 44) {
      setJarvisState('idle');
      renderLocalSpeechHint(lastSnapshot);
      showOperationError('No speech captured. Press Mic to try again or type your request.');
      return;
    }
    logVoiceStage(turn, 'asr_started');
    const { transcript, review } = await api.transcribeUtterance(capture.bytesToBase64(wav));
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_asr');
      return;
    }
    logVoiceStage(turn, 'asr_completed', `chars=${transcript?.length ?? 0}`);
    lastVoiceTranscript = transcript;
    setJarvisState('idle');
    setVoiceTranscript(transcript, { status: 'Transcript' });
    if (!transcript?.trim()) {
      // Whisper hallucinated a non-speech caption (e.g. "[MUSIC]") on
      // silence/ambient noise; the host already stripped it to empty —
      // treat exactly like no speech captured rather than dispatching it.
      setJarvisState('idle');
      renderLocalSpeechHint(lastSnapshot);
      showOperationError('No speech captured. Press Mic to try again or type your request.');
      return;
    }
    if (review?.required) {
      setJarvisState('idle');
      renderLocalSpeechHint(lastSnapshot);
      holdVoiceTranscriptForReview(transcript, review, turn);
      return;
    }
    taskInput.value = transcript;
    result.textContent = '';
    followLatest = true;
    logVoiceStage(turn, 'transcript_submitted');
    await api.submitTask(transcript, workerSelect?.value, turn?.turnId);
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_submit');
      return;
    }
    await refresh();
  } catch (err) {
    lastVoiceTranscript = lastVoiceTranscript || '';
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_error');
      return;
    }
    setJarvisState('idle');
    renderLocalSpeechHint(lastSnapshot);
    showOperationError(err);
  }
}

micButton?.addEventListener('click', () => {
  void onMicPress('auto');
});
document.getElementById('mic-toggle-btn')?.addEventListener('click', () => {
  void onMicPress('auto');
});
document.getElementById('composer-mic-btn')?.addEventListener('click', () => {
  void onMicPress('auto');
});

function showImageStudioTab() {
  const btn = document.querySelector('.tab-btn[data-tab="tab-assets"]');
  if (btn) switchWorkstreamTab('tab-assets', btn);
}

function switchWorkstreamTab(tabId, activeBtn) {
  const surface = tabId.replace(/^tab-/, '');
  const workstream = document.querySelector('.workstream');
  const page = document.getElementById('page-scroll');
  if (workstream) workstream.dataset.surface = surface;
  if (page) page.dataset.activeSurface = surface;
  for (const pane of document.querySelectorAll('.tab-pane')) {
    const on = pane.id === tabId;
    pane.classList.toggle('hidden', !on);
    pane.hidden = !on;
  }
  for (const btn of document.querySelectorAll('.tab-btn')) {
    const on = btn === activeBtn;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  }
}

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    const tabId = btn.getAttribute('data-tab');
    if (tabId) {
      switchWorkstreamTab(tabId, btn);
      if (tabId === 'tab-assets') {
        void Promise.all([refreshArtifacts(), probeImageStudio()]).catch(showOperationError);
      }
    }
  });
}

document.getElementById('artifacts-refresh')?.addEventListener('click', () => { void refreshArtifacts().catch(showOperationError); });
artifactOpenFolder?.addEventListener('click', () => {
  if (selectedArtifactId) void api.openArtifactFolder(selectedArtifactId).catch(showOperationError);
});
artifactSaveCopy?.addEventListener('click', () => {
  if (selectedArtifactId) void api.saveArtifactCopy(selectedArtifactId).catch(showOperationError);
});
document.getElementById('artifact-open-in-studio')?.addEventListener('click', () => {
  if (selectedArtifactId && typeof api.openArtifactInStudio === 'function') {
    void api.openArtifactInStudio(selectedArtifactId).catch(showOperationError);
  }
});
document.getElementById('artifact-use-as-reference')?.addEventListener('click', () => {
  if (selectedArtifactId && typeof api.useArtifactAsReference === 'function') {
    void api.useArtifactAsReference(selectedArtifactId).catch(showOperationError);
  }
});
imageGenerate?.addEventListener('click', () => { void requestImageGeneration().catch(showOperationError); });
imageApprove?.addEventListener('click', () => {
  if (!pendingImageApprovalId || imageGenerationBusy) return;
  const approvalId = pendingImageApprovalId;
  setImageBusy(true, 'Generating locally…');
  void api.resolveImageApproval(approvalId, 'approved').then(handleImageResult).catch((error) => {
    setImageBusy(false, error instanceof Error ? error.message : String(error));
    showOperationError(error);
  });
});
imageReject?.addEventListener('click', () => {
  if (!pendingImageApprovalId) return;
  const approvalId = pendingImageApprovalId;
  void api.resolveImageApproval(approvalId, 'rejected').then(handleImageResult).catch(showOperationError);
});
imageCancel?.addEventListener('click', () => {
  void api.cancelImageGeneration().then(() => {
    setImageBusy(false, 'Generation cancelled.');
    imageApproval.hidden = true;
    pendingImageApprovalId = null;
  }).catch(showOperationError);
});
weatherApprove?.addEventListener('click', () => {
  if (!pendingWeatherApprovalId || typeof api.resolveWeatherApproval !== 'function') return;
  const approvalId = pendingWeatherApprovalId;
  void api.resolveWeatherApproval(approvalId, 'approved').then(handleWeatherResult).catch(showOperationError);
});
weatherReject?.addEventListener('click', () => {
  if (!pendingWeatherApprovalId || typeof api.resolveWeatherApproval !== 'function') return;
  const approvalId = pendingWeatherApprovalId;
  void api.resolveWeatherApproval(approvalId, 'rejected').then(handleWeatherResult).catch(showOperationError);
});

window.refreshArtifacts = refreshArtifacts;

// --- Gmail tool surface -----------------------------------------------
// Search results, the open thread, and the local summary are transient UI
// state (never part of DesktopSnapshot) — Core does not track "what the
// user is currently looking at". Only connection status (snapshot.gmail)
// is server-tracked. Everything rendered here from email content uses
// textContent, never innerHTML — Gmail bodies are untrusted third-party
// text and must never be interpreted as markup.
const gmailStatusEl = document.getElementById('gmail-status');
const gmailBlockerEl = document.getElementById('gmail-blocker');
const gmailCapabilityBlockerEl = document.getElementById('gmail-capability-blocker');
const gmailErrorEl = document.getElementById('gmail-error');
const gmailConnectBtn = document.getElementById('gmail-connect');
const gmailDisconnectBtn = document.getElementById('gmail-disconnect');
const gmailRetryProbeBtn = document.getElementById('gmail-retry-probe');
const gmailSearchQuery = document.getElementById('gmail-search-query');
const gmailSearchBtn = document.getElementById('gmail-search-btn');
const gmailResultsList = document.getElementById('gmail-results');
const gmailResultsEmpty = document.getElementById('gmail-results-empty');
const gmailThreadEl = document.getElementById('gmail-thread');
const gmailSummarizeBtn = document.getElementById('gmail-summarize');
const gmailSummaryEl = document.getElementById('gmail-summary');
const gmailDraftTo = document.getElementById('gmail-draft-to');
const gmailDraftSubject = document.getElementById('gmail-draft-subject');
const gmailDraftBody = document.getElementById('gmail-draft-body');
const gmailDraftCreateBtn = document.getElementById('gmail-draft-create');
const gmailDraftResultEl = document.getElementById('gmail-draft-result');
const gmailDraftSendBtn = document.getElementById('gmail-draft-send');
const gmailApprovalPanel = document.getElementById('gmail-approval');
const gmailApprovalTo = document.getElementById('gmail-approval-to');
const gmailApprovalSubject = document.getElementById('gmail-approval-subject');
const gmailApprovalBody = document.getElementById('gmail-approval-body');
const gmailApprovalApprove = document.getElementById('gmail-approval-approve');
const gmailApprovalReject = document.getElementById('gmail-approval-reject');
const gmailSentResultEl = document.getElementById('gmail-sent-result');

const gmailUi = {
  currentThreadId: null,
  currentDraftId: null,
  pendingApprovalId: null,
};

function gmailSetError(message) {
  if (!gmailErrorEl) return;
  gmailErrorEl.textContent = message || '';
  gmailErrorEl.hidden = !message;
}

function renderGmailStatus(snapshot) {
  if (!gmailStatusEl) return;
  const gmail = snapshot.gmail ?? { connected: false, accountEmail: null, lastError: null, configBlocker: null, capabilityBlocker: null };
  gmailStatusEl.textContent = gmail.connected
    ? `Gmail: connected (${gmail.accountEmail ?? 'unknown account'})`
    : 'Gmail: not connected';
  if (gmailConnectBtn) gmailConnectBtn.hidden = gmail.connected;
  if (gmailDisconnectBtn) gmailDisconnectBtn.hidden = !gmail.connected;
  if (gmailBlockerEl) {
    gmailBlockerEl.textContent = gmail.configBlocker || '';
    gmailBlockerEl.hidden = !gmail.configBlocker;
  }
  // Kept separate from configBlocker/lastError: this is Core's live
  // capability health, which can still block dispatch even while OAuth is
  // validly connected (e.g. a probe failure right after a fresh Core start).
  if (gmailCapabilityBlockerEl) {
    const showCapabilityBlocker = gmail.connected && Boolean(gmail.capabilityBlocker);
    gmailCapabilityBlockerEl.textContent = showCapabilityBlocker ? `Gmail actions unavailable: ${gmail.capabilityBlocker}` : '';
    gmailCapabilityBlockerEl.hidden = !showCapabilityBlocker;
  }
  if (gmailRetryProbeBtn) gmailRetryProbeBtn.hidden = !(gmail.connected && gmail.capabilityBlocker);
  if (gmail.lastError && !gmail.connected) gmailSetError(gmail.lastError);
  const enabled = gmail.connected;
  for (const el of [gmailSearchQuery, gmailSearchBtn, gmailDraftTo, gmailDraftSubject, gmailDraftBody, gmailDraftCreateBtn]) {
    if (el) el.disabled = !enabled;
  }
}

gmailRetryProbeBtn?.addEventListener('click', async () => {
  gmailSetError('');
  try {
    await api.retryGmailProbe();
    await refresh();
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

gmailConnectBtn?.addEventListener('click', async () => {
  gmailSetError('');
  try {
    await api.connectGmail();
    await refresh();
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

gmailDisconnectBtn?.addEventListener('click', async () => {
  try {
    await api.disconnectGmail();
    gmailUi.currentThreadId = null;
    gmailUi.currentDraftId = null;
    gmailUi.pendingApprovalId = null;
    if (gmailResultsList) gmailResultsList.replaceChildren();
    if (gmailThreadEl) gmailThreadEl.replaceChildren();
    if (gmailSummaryEl) gmailSummaryEl.hidden = true;
    if (gmailApprovalPanel) gmailApprovalPanel.hidden = true;
    await refresh();
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

function renderGmailSearchResults(results) {
  if (!gmailResultsList) return;
  gmailResultsList.replaceChildren();
  if (gmailResultsEmpty) gmailResultsEmpty.hidden = results.length > 0;
  for (const item of results) {
    const li = document.createElement('li');
    li.className = 'gmail-result-item';
    const subject = document.createElement('div');
    subject.textContent = item.subject || '(no subject)';
    const meta = document.createElement('div');
    meta.className = 'gmail-message-meta';
    meta.textContent = `${item.from || 'unknown sender'} — ${item.date || ''}`;
    const snippet = document.createElement('div');
    snippet.className = 'gmail-result-snippet';
    snippet.textContent = item.snippet || '';
    li.tabIndex = 0;
    li.setAttribute('role', 'button');
    li.setAttribute('aria-label', `Open ${item.subject || 'message'} from ${item.from || 'unknown sender'}`);
    li.append(subject, meta, snippet);
    const open = () => {
      for (const row of gmailResultsList.querySelectorAll('.gmail-result-item')) row.classList.remove('is-active');
      li.classList.add('is-active');
      void openGmailThread(item.threadId);
    };
    li.addEventListener('click', open);
    li.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      open();
    });
    gmailResultsList.appendChild(li);
  }
}

gmailSearchBtn?.addEventListener('click', async () => {
  gmailSetError('');
  try {
    const query = String(gmailSearchQuery?.value ?? '').trim();
    const outcome = await api.dispatchGmailAction('gmail_search', query ? { query } : {});
    if (outcome.outcome === 'executed') {
      const parsed = JSON.parse(outcome.output || '{}');
      renderGmailSearchResults(Array.isArray(parsed.results) ? parsed.results : []);
    } else if (outcome.outcome === 'denied' || outcome.outcome === 'unavailable') {
      gmailSetError(outcome.reason || 'Gmail search was refused.');
    } else if (outcome.outcome === 'approval_required') {
      // Read actions are never consequential in this connector's tier design;
      // an approval here would indicate a misconfiguration upstream.
      gmailSetError('Search unexpectedly requires approval.');
    }
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

function renderGmailThread(messages) {
  if (!gmailThreadEl) return;
  gmailThreadEl.replaceChildren();
  for (const message of messages) {
    const item = document.createElement('div');
    item.className = 'gmail-message';
    const meta = document.createElement('div');
    meta.className = 'gmail-message-meta';
    meta.textContent = `From: ${message.from || 'unknown'} · ${message.date || ''}`;
    const subject = document.createElement('div');
    subject.textContent = message.subject || '(no subject)';
    const body = document.createElement('div');
    body.className = 'gmail-message-body';
    body.textContent = message.bodyText || message.snippet || '';
    item.append(meta, subject, body);
    gmailThreadEl.appendChild(item);
  }
  if (gmailSummarizeBtn) gmailSummarizeBtn.hidden = messages.length === 0;
  if (gmailSummaryEl) gmailSummaryEl.hidden = true;
}

async function openGmailThread(threadId) {
  if (!threadId) return;
  gmailSetError('');
  try {
    const outcome = await api.dispatchGmailAction('gmail_read_thread', { threadId });
    if (outcome.outcome !== 'executed') {
      gmailSetError(outcome.reason || 'Could not open this thread.');
      return;
    }
    const parsed = JSON.parse(outcome.output || '{}');
    gmailUi.currentThreadId = threadId;
    gmailUi.lastThreadMessages = Array.isArray(parsed.messages) ? parsed.messages : [];
    renderGmailThread(gmailUi.lastThreadMessages);
    // Prefill the reply draft from the most recent message in the thread.
    const last = gmailUi.lastThreadMessages[gmailUi.lastThreadMessages.length - 1];
    if (last && gmailDraftTo && !gmailDraftTo.value) gmailDraftTo.value = last.from || '';
    if (last && gmailDraftSubject && !gmailDraftSubject.value) {
      gmailDraftSubject.value = last.subject && !/^re:/i.test(last.subject) ? `Re: ${last.subject}` : (last.subject || '');
    }
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
}

gmailSummarizeBtn?.addEventListener('click', async () => {
  if (!gmailUi.lastThreadMessages?.length) return;
  gmailSetError('');
  if (gmailSummaryEl) {
    gmailSummaryEl.hidden = false;
    gmailSummaryEl.textContent = 'Generating local summary…';
  }
  try {
    const { summary } = await api.summarizeGmailThread(gmailUi.lastThreadMessages.map((m) => ({
      from: m.from || '', subject: m.subject || '', date: m.date || '', bodyText: m.bodyText || m.snippet || '',
    })));
    if (gmailSummaryEl) gmailSummaryEl.textContent = `Local summary (auto-generated, linked to thread ${gmailUi.currentThreadId}): ${summary}`;
  } catch (err) {
    if (gmailSummaryEl) gmailSummaryEl.hidden = true;
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

function showGmailApproval(approvalId, presentation) {
  gmailUi.pendingApprovalId = approvalId;
  if (!gmailApprovalPanel) return;
  gmailApprovalPanel.hidden = false;
  const to = Array.isArray(presentation?.to) ? presentation.to.join(', ') : '';
  const cc = Array.isArray(presentation?.cc) && presentation.cc.length ? ` · Cc: ${presentation.cc.join(', ')}` : '';
  if (gmailApprovalTo) gmailApprovalTo.textContent = `To: ${to}${cc}`;
  if (gmailApprovalSubject) gmailApprovalSubject.textContent = `Subject: ${presentation?.subject || ''}`;
  if (gmailApprovalBody) gmailApprovalBody.textContent = presentation?.bodyText || '';
}

function hideGmailApproval() {
  gmailUi.pendingApprovalId = null;
  if (gmailApprovalPanel) gmailApprovalPanel.hidden = true;
}

gmailDraftCreateBtn?.addEventListener('click', async () => {
  gmailSetError('');
  const to = String(gmailDraftTo?.value ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const subject = String(gmailDraftSubject?.value ?? '');
  const bodyText = String(gmailDraftBody?.value ?? '');
  if (!to.length || !bodyText.trim()) {
    gmailSetError('A recipient and a body are required to create a draft.');
    return;
  }
  try {
    const args = { to, subject, bodyText };
    if (gmailUi.currentThreadId) args.threadId = gmailUi.currentThreadId;
    const outcome = await api.dispatchGmailAction('gmail_create_draft', args);
    if (outcome.outcome === 'approval_required') {
      showGmailApproval(outcome.approvalId, outcome.presentation);
      gmailUi.pendingApprovalKind = 'create';
    } else if (outcome.outcome === 'executed') {
      const parsed = JSON.parse(outcome.output || '{}');
      gmailUi.currentDraftId = parsed.draftId || null;
      if (gmailDraftResultEl) {
        gmailDraftResultEl.hidden = false;
        gmailDraftResultEl.textContent = 'Draft saved in Gmail. Review it before sending.';
      }
      if (gmailDraftSendBtn) gmailDraftSendBtn.hidden = !gmailUi.currentDraftId;
    } else {
      gmailSetError(outcome.reason || 'Could not create the draft.');
    }
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

gmailDraftSendBtn?.addEventListener('click', async () => {
  if (!gmailUi.currentDraftId) return;
  gmailSetError('');
  try {
    const outcome = await api.dispatchGmailAction('gmail_send_draft', { draftId: gmailUi.currentDraftId });
    if (outcome.outcome === 'approval_required') {
      showGmailApproval(outcome.approvalId, outcome.presentation);
      gmailUi.pendingApprovalKind = 'send';
    } else {
      gmailSetError(outcome.reason || 'Could not start sending this draft.');
    }
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
});

async function resolveGmailApproval(resolution) {
  if (!gmailUi.pendingApprovalId) return;
  gmailSetError('');
  try {
    const outcome = await api.resolveGmailApproval(gmailUi.pendingApprovalId, resolution);
    const wasSend = gmailUi.pendingApprovalKind === 'send';
    hideGmailApproval();
    if (resolution === 'rejected') return;
    if (outcome.outcome === 'executed') {
      const parsed = JSON.parse(outcome.output || '{}');
      if (wasSend) {
        if (gmailSentResultEl) {
          gmailSentResultEl.hidden = false;
          gmailSentResultEl.textContent = 'Message sent successfully.';
        }
        gmailUi.currentDraftId = null;
        if (gmailDraftSendBtn) gmailDraftSendBtn.hidden = true;
      } else {
        gmailUi.currentDraftId = parsed.draftId || null;
        if (gmailDraftResultEl) {
          gmailDraftResultEl.hidden = false;
          gmailDraftResultEl.textContent = `Draft created (id ${parsed.draftId}). Review, then send.`;
        }
        if (gmailDraftSendBtn) gmailDraftSendBtn.hidden = !gmailUi.currentDraftId;
      }
    } else {
      gmailSetError(outcome.reason || 'The approved action did not complete.');
    }
  } catch (err) {
    gmailSetError(err instanceof Error ? err.message : String(err));
  }
}

gmailApprovalApprove?.addEventListener('click', () => { void resolveGmailApproval('approved'); });
gmailApprovalReject?.addEventListener('click', () => { void resolveGmailApproval('rejected'); });
// --- end Gmail tool surface ---------------------------------------------

function renderResearchOutcome(outcome) {
  if (!outcome) return;
  activeResearchId = outcome.researchId;
  const terminal = !['awaiting_approval', 'running'].includes(outcome.state);
  if (researchStatus) {
    const labels = {
      awaiting_approval: 'Waiting for approval.',
      running: 'Researching with bounded web access…',
      completed: 'Research complete.',
      denied: 'Research was not approved.',
      unavailable: 'Research provider is not configured.',
      insufficient_evidence: 'Jarvis could not retrieve enough reliable evidence.',
      failed: 'Research failed safely.',
    };
    researchStatus.textContent = labels[outcome.state] || outcome.state;
  }
  if (researchResult) {
    researchResult.hidden = !outcome.answer;
    if (outcome.answer) renderMarkdownLite(researchResult, outcome.answer);
    else researchResult.replaceChildren();
  }
  if (researchSources) {
    researchSources.replaceChildren();
    for (const source of outcome.sources || []) {
      const li = document.createElement('li');
      li.className = 'research-source';
      const copy = document.createElement('div');
      copy.className = 'research-source-copy';
      const title = document.createElement('strong');
      title.textContent = `[S${source.rank}] ${source.title}`;
      const url = document.createElement('span');
      url.className = 'muted selectable-text';
      url.textContent = source.url || source.status;
      copy.append(title, url);
      li.appendChild(copy);
      if (source.url) {
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = 'Open source';
        open.addEventListener('click', async () => {
          try { await api.openExternalUrl(source.url); }
          catch (err) { showOperationError(err); }
        });
        li.appendChild(open);
      }
      researchSources.appendChild(li);
    }
  }
  if (terminal && researchPollTimer) {
    clearTimeout(researchPollTimer);
    researchPollTimer = null;
  }
}

async function pollResearch() {
  if (!activeResearchId) return;
  try {
    const outcome = await api.getWebResearch(activeResearchId);
    renderResearchOutcome(outcome);
    if (outcome.state === 'running') researchPollTimer = setTimeout(() => { void pollResearch(); }, 750);
  } catch (err) {
    if (researchStatus) researchStatus.textContent = err instanceof Error ? err.message : String(err);
  }
}

researchStart?.addEventListener('click', async () => {
  const query = String(researchQuery?.value ?? '').trim();
  if (!query) return;
  try {
    pendingResearchApproval = await api.startWebResearch(query);
    activeResearchId = pendingResearchApproval.researchId;
    researchApproval.hidden = false;
    researchApprovalQuery.textContent = pendingResearchApproval.queryPreview;
    researchApprovalDetail.textContent = `${pendingResearchApproval.provider} · up to ${pendingResearchApproval.maxSources} cited sources`;
    researchStatus.textContent = 'Review the network request before Jarvis starts.';
  } catch (err) {
    showOperationError(err);
  }
});

async function resolveResearch(resolution) {
  if (!pendingResearchApproval) return;
  try {
    const outcome = await api.resolveWebResearch(pendingResearchApproval, resolution);
    pendingResearchApproval = null;
    researchApproval.hidden = true;
    renderResearchOutcome(outcome);
    if (outcome.state === 'running') await pollResearch();
  } catch (err) {
    showOperationError(err);
  }
}

researchApprove?.addEventListener('click', () => { void resolveResearch('approved'); });
researchReject?.addEventListener('click', () => { void resolveResearch('rejected'); });
toolsRefresh?.addEventListener('click', async () => {
  try { await api.refreshEverydayTools(); await refresh(); }
  catch (err) { showOperationError(err); }
});
toolsOpenWorkspace?.addEventListener('click', async () => {
  try { await api.openWorkspaceFolder(); }
  catch (err) { showOperationError(err); }
});

noteSave?.addEventListener('click', async () => {
  const body = String(noteBody?.value ?? '').trim();
  if (!body) return;
  try {
    await api.createNote({ title: String(noteTitle?.value ?? '').trim() || undefined, body });
    if (noteBody) noteBody.value = '';
    if (noteTitle) noteTitle.value = '';
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

reminderSave?.addEventListener('click', async () => {
  const title = String(reminderTitle?.value ?? '').trim();
  const minutes = Number(reminderDueMinutes?.value ?? 2);
  if (!title || !Number.isFinite(minutes) || minutes < 1) return;
  try {
    const dueAt = new Date(Date.now() + minutes * 60_000).toISOString();
    await api.createReminder({ title, dueAt });
    if (reminderTitle) reminderTitle.value = '';
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

queueAdd?.addEventListener('click', async () => {
  const instruction = String(queueInstruction?.value ?? '').trim();
  if (!instruction) return;
  try {
    await api.enqueueCommand(instruction);
    if (queueInstruction) queueInstruction.value = '';
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

queueRun?.addEventListener('click', async () => {
  const id = queueConfirm?.getAttribute('data-command-id');
  const token = queueConfirm?.getAttribute('data-token');
  const revision = Number(queueConfirm?.getAttribute('data-revision') ?? 0);
  if (!id || !token) return;
  try {
    await api.confirmCommandRun(id, token, revision);
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

queueEdit?.addEventListener('click', async () => {
  const id = queueConfirm?.getAttribute('data-command-id');
  if (!id) return;
  const current = queueConfirmDetail?.textContent?.split(' — confirm')[0]
    || queueConfirmTitle?.textContent
    || '';
  const next = window.prompt('Edit queued instruction', current);
  if (next == null || !next.trim()) return;
  try {
    await api.editQueuedCommand(id, next.trim());
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

queueSkip?.addEventListener('click', async () => {
  const id = queueConfirm?.getAttribute('data-command-id');
  if (!id) return;
  try {
    await api.skipCommand(id);
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

queuePostpone?.addEventListener('click', async () => {
  const id = queueConfirm?.getAttribute('data-command-id');
  if (!id) return;
  try {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    await api.postponeCommand(id, until);
    await refresh();
  } catch (err) {
    showOperationError(err);
  }
});

const waveformCanvas = document.getElementById('waveform-canvas');
const waveformCtx = waveformCanvas?.getContext?.('2d') ?? null;
const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
let waveformRaf = 0;

function paintWaveform(timestamp) {
  if (!waveformCanvas || !waveformCtx) return;
  if (document.hidden) {
    if (appRoot) appRoot.dataset.animations = 'paused';
    waveformRaf = 0;
    return;
  }
  if (appRoot) appRoot.dataset.animations = 'running';
  const { width, height } = waveformCanvas;
  waveformCtx.clearRect(0, 0, width, height);
  const bars = 48;
  const gap = 3;
  const barWidth = width / bars - gap;
  const measured = jarvisUiState === 'listening'
    || jarvisUiState === 'capturing'
    || jarvisUiState === 'wake_monitoring'
    || jarvisUiState === 'speaking';
  const inferring = jarvisUiState === 'processing' || jarvisUiState === 'working';
  if (inferring && !reduceMotion) {
    inferencePulse = 0.35 + 0.25 * Math.abs(Math.sin((timestamp || 0) / 220));
  } else {
    inferencePulse = 0;
  }
  for (let i = 0; i < bars; i += 1) {
    const dist = Math.abs(i - bars / 2) / (bars / 2);
    let amp = 3;
    if (measured && !reduceMotion) {
      const wobble = 0.55 + 0.45 * Math.abs(Math.sin(((timestamp || 0) / 160) + i * 0.35));
      amp = 4 + (1 - dist) * (8 + liveAudioLevel * 28 * wobble);
    } else if (measured) {
      amp = 4 + (1 - dist) * (6 + liveAudioLevel * 20);
    } else if (inferring) {
      // Distinct inference motion — not presented as measured audio.
      const phase = ((timestamp || 0) / 280) + i * 0.18;
      amp = 3 + (1 - dist) * (6 + inferencePulse * 14 * Math.abs(Math.sin(phase)));
    }
    const x = i * (barWidth + gap);
    const y = (height - amp) / 2;
    const grad = waveformCtx.createLinearGradient(0, y, 0, y + amp);
    if (inferring) {
      grad.addColorStop(0, '#fbbf24');
      grad.addColorStop(1, '#d6c28a');
    } else {
      grad.addColorStop(0, '#38bdf8');
      grad.addColorStop(1, '#06b6d4');
    }
    waveformCtx.fillStyle = grad;
    waveformCtx.fillRect(x, y, barWidth, amp);
  }
  if (!reduceMotion) waveformRaf = requestAnimationFrame(paintWaveform);
}
if (waveformCtx) {
  if (reduceMotion) paintWaveform(0);
  else waveformRaf = requestAnimationFrame(paintWaveform);
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !reduceMotion && !waveformRaf && waveformCtx) {
    waveformRaf = requestAnimationFrame(paintWaveform);
  }
});

let spacePttHeld = false;

function isSpacePttBlockedTarget(target) {
  if (!target || !(target instanceof Element)) return false;
  const el = target;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A') return true;
  if (el.isContentEditable) return true;
  if (el.closest('textarea, input, select, button, a, [contenteditable="true"], [role="textbox"]')) return true;
  return false;
}

document.addEventListener('keydown', (event) => {
  if (event.code !== 'Space' && event.key !== ' ') return;
  if (event.repeat) return;
  if (isSpacePttBlockedTarget(event.target)) return;
  event.preventDefault();
  if (!listening && !spacePttHeld) {
    spacePttHeld = true;
    void onMicPress();
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code !== 'Space' && event.key !== ' ') return;
  if (!spacePttHeld) return;
  spacePttHeld = false;
  if (isSpacePttBlockedTarget(event.target)) return;
  event.preventDefault();
  if (listening) void onMicPress();
});

taskInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!submit.disabled) submit.click();
  }
});

let unsentDraftText = '';
taskInput?.addEventListener('input', () => {
  unsentDraftText = taskInput.value;
});

submit.addEventListener('click', async () => {
  showOperationError(null);
  followLatest = true;
  listening = false;
  voiceSession?.cancel();
  voiceSession = null;
  voiceCaptureMode = null;
  const stagedNow = lastSnapshot?.stagedAttachments ?? [];
  const typedInput = (taskInput?.value || '').trim();
  if (!typedInput && stagedNow.length === 0) return;
  const rawInput = typedInput || (stagedNow.length > 1 ? 'Please look at the attached files.' : 'Please look at the attached file.');
  // A free cloud model receives exactly one public text, and only after the person has seen and approved it here.
  let cloudApproved = false;
  if (selectedCloudModel() && typeof api.previewCloudPublicText === 'function') {
    try {
      const preview = await api.previewCloudPublicText(rawInput);
      if (!preview?.eligible) {
        showOperationError(preview?.reason || 'This text cannot be sent to a cloud model. Choose a local model to send it.');
        return;
      }
      if (!(await confirmCloudPublicText(preview))) return;
      cloudApproved = true;
    } catch (err) {
      showOperationError(err);
      return;
    }
  }
  unsentDraftText = '';
  if (taskInput) taskInput.value = ''; // Cleanly clears composer immediately on submit

  // Immediately append user's turn to active conversation stream
  if (result) {
    const userRow = document.createElement('div');
    userRow.className = 'conversation-paragraph-row transcript-row-user';
    userRow.dataset.liveEcho = '1';
    const speaker = document.createElement('div');
    speaker.className = 'transcript-speaker speaker-user';
    speaker.textContent = 'You';
    userRow.appendChild(speaker);
    const body = document.createElement('div');
    body.className = 'transcript-body transcript-body-user';
    body.textContent = rawInput;
    userRow.appendChild(body);
    if (stagedNow.length > 0) userRow.appendChild(buildAttachmentChips(stagedNow));
    result.appendChild(userRow);
    result.hidden = false;

    result.scrollTop = result.scrollHeight;
    scrollConversationToEnd();
  }

  // Switch to Conversations surface so user immediately sees their request and streaming reply
  if (typeof switchSurface === 'function') {
    switchSurface('conversations');
  }

  userNavigatedAway = false;
  try {
    const routed = cloudApproved
      ? await api.submitTask(rawInput, workerSelect?.value, undefined, true)
      : await api.submitTask(rawInput, workerSelect?.value);
    if (routed?.routed && result) {
      // The host said what really happened to this send while work was running.
      const note = document.createElement('div');
      note.className = 'turn-queued-pill';
      note.id = 'active-turn-queued-pill';
      note.innerHTML = '<span class="event-icon">⏳</span><span class="event-text"></span>';
      note.querySelector('.event-text').textContent = routed.routed === 'stopped'
        ? 'Stop requested · waiting for the worker to confirm it has stopped'
        : routed.routed === 'duplicate'
        ? 'Already running or queued · not started a second time'
        : routed.routed === 'corrected_queued'
        ? 'Corrected · your queued request now says what you just asked for'
        : routed.routed === 'corrected_restarted'
        ? 'Corrected · it had not answered yet, so the same task restarted on your correction'
        : routed.routed === 'corrected_steered'
        ? 'Corrected · the running task has your correction and will not repeat what it already did'
        : routed.routed === 'steered'
        ? 'Added to the running task · it keeps going with your new instruction'
        : routed.routed === 'side_question'
        ? 'Answering alongside the running task · it is not stopped'
        : 'Saved and queued · it starts after the current task. Say "stop" or press Stop to cancel the current task.';
      result.appendChild(note);
      result.scrollTop = result.scrollHeight;
    }
    await refresh();
  } catch (err) {
    await refresh();
    showOperationError(err);
  }
});

/**
 * Stop, from wherever it was pressed (the composer button or the inline task
 * card). One path, so both say the same true thing about what happened.
 */
async function requestStop() {
  showOperationError(null);
  if (voiceSession) {
    voiceSession.cancel();
    voiceSession = null;
    voiceCaptureMode = null;
    listening = false;
    lastVoiceTranscript = '';
    setVoiceTranscript('');
    setJarvisState('idle');
    renderLocalSpeechHint(lastSnapshot);
    syncCancelButton();
    return;
  }
  try {
    const stopLabel = cancel.querySelector('.composer-cancel-label');
    if (stopLabel) stopLabel.textContent = 'Stopping…';
    await api.cancel();
    await refresh();
    // The stop is only real once the task actually stopped. The host waits for
    // that confirmation and says plainly when it could not get it, so the UI
    // never claims a task stopped while it is still running.
    if (lastSnapshot?.running) {
      stopRequestedNotConfirmed = true;
      stopRequestedAttemptId = lastSnapshot?.attemptId ?? stopRequestedAttemptId;
      syncCancelButton();
      syncTaskCardStop();
      showOperationError(
        'Stop was requested, but the task has not confirmed it stopped yet. '
        + 'It may still be finishing — press Stop again if it keeps going.',
      );
    } else {
      stopRequestedNotConfirmed = false;
      syncCancelButton();
      syncTaskCardStop();
    }
  } catch (err) {
    stopRequestedNotConfirmed = false;
    syncCancelButton();
    syncTaskCardStop();
    showOperationError(err);
  }
}

cancel.addEventListener('click', () => { void requestStop(); });
taskCardStop?.addEventListener('click', () => { void requestStop(); });

approve.addEventListener('click', () => resolve('approved'));
reject.addEventListener('click', () => resolve('rejected'));

checkpointPane.addEventListener('scroll', () => {
  const slack = 48;
  followLatest = checkpointPane.scrollHeight - checkpointPane.scrollTop - checkpointPane.clientHeight < slack;
  jumpLatest.hidden = followLatest;
});

jumpLatest.addEventListener('click', () => {
  followLatest = true;
  jumpLatest.hidden = true;
  activity.lastElementChild?.scrollIntoView({ block: 'end' });
});

api.onEvent((event) => {
  if (event?.kind === 'conversation_message') {
    // A reply stored while a task works (a side answer) refreshes the open chat at once; other messages wait for the turn.
    if (event.conversationId && event.conversationId === viewingConversationId && (!lastSnapshot?.running || event.messageRole === 'assistant')) void refreshOpenedTranscript(event.conversationId);
    void refreshConversationsRail?.();
    // A message Core posted on its own (the daily brief) changes what Home
    // must show, so the brief is read again.
    scheduleAssistantBriefRefresh(false);
    return;
  }
  if (event?.kind === 'assistant_approval_changed') {
    // A pending approval was created, resolved or retired. Home must re-read
    // Core so the card appears and disappears truthfully, without a manual
    // refresh.
    scheduleAssistantBriefRefresh(false);
    return;
  }
  if (event?.kind === 'token') {
    if (!viewingConversationId && !lastSnapshot?.selectedConversationId) return;
    appendLiveReplyToken(event.attemptId, event.text);
    // Diagnostic-only: timestamp the first token of the active voice turn's
    // response so we can tell "model slow to start" from "model slow to
    // finish" apart in desktop-host.log. Does not feed tokens into TTS.
    const turn = activeVoiceTurn;
    if (turn && !isVoiceTurnStale(turn) && firstTokenLoggedForTurnId !== turn.turnId) {
      firstTokenLoggedForTurnId = turn.turnId;
      logVoiceStage(turn, 'first_model_token');
    }
    return;
  }
  void (async () => {
    if (event?.eventType === 'everyday_reminder_open' && event.text) {
      const toolsBtn = document.getElementById('btn-tools');
      if (toolsBtn) switchWorkstreamTab('tab-tools', toolsBtn);
      await refresh().catch(showOperationError);
      const target = Array.from(document.querySelectorAll('#reminders-list .tools-item')).find((el) => {
        return el.getAttribute('data-reminder-id') === String(event.text);
      });
      if (target) {
        target.classList.add('tools-item-focus');
        target.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event?.eventType === 'command_queue_open' || event?.eventType === 'command_queue_confirm') {
      const toolsBtn = document.getElementById('btn-tools');
      if (toolsBtn) switchWorkstreamTab('tab-tools', toolsBtn);
      await refresh().catch(showOperationError);
      if (queueConfirm && !queueConfirm.hidden) {
        queueConfirm.classList.add('tools-item-focus');
        queueConfirm.scrollIntoView({ block: 'nearest' });
      }
      return;
    }
    if (event?.summary?.startsWith('mobile_clients:')) {
      void refreshIntegrationsView();
    }
    await refresh().catch(showOperationError);

    // Clean up queued turn indicator on completion
    const queuedPill = document.getElementById('active-turn-queued-pill');
    if (queuedPill && (event?.kind === 'result' || event?.kind === 'error')) {
      queuedPill.remove();
    }

    // Ensure assistant response is displayed in Active Conversation transcript
    if (event?.kind === 'result' && event.text && result) {
      const existing = event.attemptId ? result.querySelector(`[data-attempt-id="${event.attemptId}"]`) : null;
      // The streamed reply row IS this answer: finish it in place with the authoritative final text
      // instead of appending a second copy beside it (the durable transcript replaces it at terminal).
      const liveRow = !existing ? result.querySelector('[data-live-reply="1"]') : null;
      if (liveRow && (!event.attemptId || !liveReply.attemptId || liveReply.attemptId === event.attemptId)) {
        finishLiveReply(event.attemptId);
        if (event.attemptId) liveRow.dataset.attemptId = event.attemptId;
        renderMarkdownLite(liveRow.lastElementChild, event.text);
        result.scrollTop = result.scrollHeight;
      } else if (!existing) {
        const row = document.createElement('div');
        row.className = 'conversation-paragraph-row transcript-row-assistant';
        if (event.attemptId) row.dataset.attemptId = event.attemptId;
        const header = document.createElement('div');
        header.className = 'transcript-header';
        header.appendChild(pandaGlyphSvg('panda-glyph panda-glyph-inline'));
        const speaker = document.createElement('div');
        speaker.className = 'transcript-speaker speaker-assistant sr-only';
        speaker.textContent = 'Pandesh';
        header.appendChild(speaker);

        const badge = document.createElement('span');
        badge.className = 'transcript-model-badge';
        badge.textContent = lastSnapshot?.model || 'qwen3.8:27b-mtp-q4_K_M';
        header.appendChild(badge);
        row.appendChild(header);

        const body = document.createElement('div');
        body.className = 'transcript-body transcript-body-assistant';
        renderMarkdownLite(body, event.text);
        row.appendChild(body);
        result.appendChild(row);
        result.hidden = false;
        result.scrollTop = result.scrollHeight;
        scrollConversationToEnd();
      }
      // The turn may have delivered files: refresh the result card so the
      // delivered outputs are visible without waiting for a transcript reload.
      void refreshConversationResults();
    }

    if (lastSnapshot?.voiceMode === false) return;
    // Requests submitted from mobile companion should not speak on Windows speakers
    if (event?.clientOrigin === 'mobile') return;
    // Guard against stale attempts from previous requests updating TTS or UI
    if (event?.attemptId && lastSnapshot?.attemptId && event.attemptId !== lastSnapshot.attemptId) return;
    if (event?.kind === 'result' && event.text) {
      const turn = activeVoiceTurn;
      if (turn && !isVoiceTurnStale(turn)) logVoiceStage(turn, 'model_completed');
      await speakAnswerText(event.text);
      return;
    }
    // Failures were silent in voice mode (Dispatch looked dead). Speak the reason.
    if (event?.kind === 'error' && event.summary) {
      const turn = activeVoiceTurn;
      if (turn && !isVoiceTurnStale(turn)) logVoiceStage(turn, 'model_completed', 'outcome=error');
      await speakAnswerText(event.summary);
    }
  })();
});

function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  return window.jarvisVoiceCapture.bytesToBase64(bytes);
}

function renderWakeChrome(snapshot) {
  const wake = snapshot?.wakeWord;
  const diag = snapshot?.wakeDiagnostics;
  if (wakeEnable) {
    wakeEnable.disabled = !wake || wake.capability !== 'available' || Boolean(snapshot?.speaking);
    wakeEnable.checked = Boolean(wake?.enabled);
  }
  if (wakeMute) {
    wakeMute.disabled = !wake?.enabled;
    wakeMute.textContent = wake?.muted ? 'Unmute wake' : 'Mute wake';
  }
  if (voiceModeToggle) voiceModeToggle.checked = snapshot?.voiceMode !== false;
  if (stopSpeakingBtn) stopSpeakingBtn.hidden = !snapshot?.speaking;
  if (interruptHint) {
    if (snapshot?.speaking) {
      interruptHint.hidden = false;
      interruptHint.textContent = snapshot.speechInterrupt?.spokenBargeInBlocker
        || 'Use Stop speaking. Spoken interruption is unavailable while the mic is suppressed during playback.';
    } else {
      interruptHint.hidden = true;
      interruptHint.textContent = '';
    }
  }
  if (wakeIndicator) {
    let state = 'off';
    let label = 'Wake off';
    if (wake?.capability !== 'available') {
      state = 'unavailable';
      label = 'Wake unavailable';
    } else if (snapshot?.speaking) {
      state = 'speaking';
      label = 'Speaking — Stop available';
    } else if (wake.enabled && wake.muted) {
      state = 'muted';
      label = 'Wake muted';
    } else if (wake.enabled && diag?.captureError) {
      state = 'unavailable';
      label = 'Wake capture failed';
    } else if (wake.enabled && !diag?.engineReady) {
      state = 'unavailable';
      label = 'Wake detector not ready';
    } else if (wake.enabled && !diag?.captureActive && (diag?.framesReceived || 0) === 0) {
      state = 'unavailable';
      label = 'Wake starting…';
    } else if (wake.enabled && (diag?.framesReceived || 0) === 0) {
      // Never claim monitoring/listening without frames reaching the detector.
      state = 'unavailable';
      label = 'No mic frames yet';
    } else if (wake.enabled && !diag?.readyForDetect) {
      state = 'monitoring';
      label = 'Wake warming…';
    } else if (wake.enabled) {
      state = jarvisUiState === 'capturing' ? 'capturing' : 'monitoring';
      label = jarvisUiState === 'capturing' ? 'Capturing speech' : 'Wake monitoring';
    }
    wakeIndicator.dataset.state = state;
    wakeIndicator.textContent = label;
  }
  if (wakeDiagnosticsEl) {
    if (!wake?.enabled) {
      wakeDiagnosticsEl.textContent = 'Wake diagnostics idle.';
    } else {
      const rate = diag?.contextSampleRate != null ? `${diag.contextSampleRate} Hz` : 'rate?';
      const mic = typeof diag?.micRms === 'number' ? diag.micRms.toFixed(3) : '0.000';
      const score = typeof diag?.lastScore === 'number' ? diag.lastScore.toFixed(3) : '0.000';
      const peak = typeof diag?.peakScore === 'number' ? diag.peakScore.toFixed(3) : '0.000';
      const frames = diag?.framesReceived ?? 0;
      const thr = typeof diag?.threshold === 'number' ? diag.threshold.toFixed(2) : '0.45';
      const crosses = diag?.thresholdCrossings ?? 0;
      const approaches = diag?.approachCount ?? 0;
      const sinceReset = diag?.framesSinceReset ?? 0;
      const warm = diag?.readyForDetect ? 'ready' : `warming ${sinceReset}/16`;
      const wakeMs = diag?.wakeDetectMs == null ? 'wakeDetectMs=null' : `wakeDetectMs=${diag.wakeDetectMs}`;
      const infer = diag?.lastInferenceMs == null ? 'infer=null' : `infer=${diag.lastInferenceMs}ms`;
      const ready = diag?.engineReady ? 'detector ready' : 'detector not ready';
      const capture = diag?.captureError
        ? `capture error: ${diag.captureError}`
        : (diag?.captureActive ? 'capture on' : 'capture off');
      const lastHit = diag?.lastDetectedAt
        ? ` lastDetect=${Number(diag.lastDetectedScore || 0).toFixed(3)}`
        : '';
      const device = diag?.trackLabel ? ` · ${diag.trackLabel}` : '';
      wakeDiagnosticsEl.textContent =
        `${ready} · ${capture} · ${warm} · mic=${mic} · score=${score}/${thr} (peak ${peak}) · crosses=${crosses} approach=${approaches} · frames=${frames} · ${wakeMs} · ${infer} · ${rate}${device}${lastHit}`;
    }
  }
}

function stopWakeMonitor() {
  wakeMonitor?.stop();
  wakeMonitor = null;
  wakePendingFrames = [];
  wakePushBusy = false;
  void api.reportWakeCapture?.({ captureActive: false }).catch(() => undefined);
}

/** Start/stop wake mic from snapshot — covers IPC enable without checkbox change. */
function syncWakeMonitorFromSnapshot(snapshot) {
  const wake = snapshot?.wakeWord;
  if (!wake?.enabled || wake.muted || snapshot?.speaking || snapshot?.running || listening || voiceSession) {
    if (wakeMonitor && (snapshot?.speaking || !wake?.enabled || wake?.muted || snapshot?.running)) {
      stopWakeMonitor();
    }
    return;
  }
  void ensureWakeMonitor(snapshot);
}

function acknowledgeWakeDetection(event) {
  const score = typeof event?.score === 'number' ? event.score.toFixed(3) : '?';
  const wakeMs = event?.wakeDetectMs;
  const wakeMsLabel = typeof wakeMs === 'number' ? `${wakeMs} ms` : 'unavailable';
  if (wakeIndicator) {
    wakeIndicator.dataset.state = 'detected';
    wakeIndicator.textContent = `Hey Jarvis heard · score ${score}`;
  }
  const neural = document.getElementById('neural-ready');
  if (neural) neural.textContent = 'Wake acknowledged';
  if (micHint) {
    micHint.textContent = `Wake detected (latency ${wakeMsLabel}). Listening for your question…`;
  }
  if (appRoot) appRoot.dataset.wakeAck = '1';
  setTimeout(() => {
    if (appRoot) delete appRoot.dataset.wakeAck;
  }, 2500);
}

async function ensureWakeMonitor(snapshot) {
  const wake = snapshot?.wakeWord;
  if (!wake?.enabled || wake.muted || snapshot?.speaking || snapshot?.running) {
    stopWakeMonitor();
    return;
  }
  if (wakeMonitor || listening || voiceSession) return;
  const capture = window.jarvisVoiceCapture;
  if (!capture?.startWakeMonitor) {
    showOperationError('Wake capture module failed to load in the renderer.');
    setJarvisState('unavailable');
    return;
  }
  let sawFrame = false;

  const flushWakePush = async (meta) => {
    if (wakePushBusy) return;
    wakePushBusy = true;
    try {
      while (wakePendingFrames.length > 0 && wakeMonitor) {
        const batch = wakePendingFrames.splice(0, wakePendingFrames.length);
        let total = 0;
        for (const part of batch) total += part.length;
        const merged = new Int16Array(total);
        let offset = 0;
        for (const part of batch) {
          merged.set(part, offset);
          offset += part.length;
        }
        const result = await api.pushWakeAudio(int16ToBase64(merged), {
          rms: meta?.rms,
          sampleRate: meta?.sampleRate,
          contextSampleRate: meta?.contextSampleRate,
          framesEmitted: meta?.framesEmitted,
          captureActive: true,
        });
        if (result?.diagnostics && lastSnapshot) {
          lastSnapshot.wakeDiagnostics = result.diagnostics;
          renderWakeChrome(lastSnapshot);
        }
      }
    } catch (err) {
      showOperationError(err);
      stopWakeMonitor();
      setJarvisState('unavailable');
    } finally {
      wakePushBusy = false;
      if (wakePendingFrames.length > 0 && wakeMonitor) void flushWakePush(meta);
    }
  };

  wakeMonitor = capture.startWakeMonitor({
    onReady: (info) => {
      void api.reportWakeCapture({
        captureActive: true,
        sampleRate: info.sampleRate,
        contextSampleRate: info.sampleRate,
        trackLabel: info.trackLabel || '',
      }).then((snap) => {
        if (snap) renderSnapshot(snap);
      }).catch(() => undefined);
    },
    onLevel: (info) => {
      if (typeof info.rms === 'number') liveAudioLevel = Math.min(1, info.rms * 8);
      // Throttle host updates — every ~250ms via frames is enough via onFrame meta.
      if (typeof info.rms === 'number' && info.framesEmitted % 8 === 0) {
        void api.reportWakeCapture({
          captureActive: true,
          rms: info.rms,
          sampleRate: info.sampleRate,
          framesEmitted: info.framesEmitted,
        }).catch(() => undefined);
      }
    },
    onFrame: (int16, meta) => {
      sawFrame = true;
      wakePendingFrames.push(int16);
      void flushWakePush(meta);
    },
    onError: (err) => {
      stopWakeMonitor();
      void api.reportWakeCapture({
        captureActive: false,
        captureError: String(err?.message || err),
      }).then((snap) => {
        if (snap) renderSnapshot(snap);
      }).catch(() => undefined);
      showOperationError(err);
      setJarvisState('unavailable');
    },
  });
  // Do not claim monitoring until frames arrive; temporary "starting" only.
  if (jarvisUiState === 'idle' || jarvisUiState === 'completed' || jarvisUiState === 'failed') {
    setJarvisState('wake_monitoring');
  }
  setTimeout(() => {
    if (!sawFrame && wakeMonitor && lastSnapshot?.wakeWord?.enabled && !lastSnapshot?.wakeWord?.muted) {
      setJarvisState('unavailable');
      showOperationError('Wake monitor started but no microphone frames arrived. Check mic permission and input device.');
      void api.reportWakeCapture({
        captureActive: false,
        captureError: 'no microphone frames received',
      }).catch(() => undefined);
    }
  }, 2500);
}

async function beginVadUtterance(source = 'wake') {
  if (listening || voiceSession) return;
  if (lastSnapshot?.speaking) {
    // Mic taps land here silently while Jarvis is still speaking (barge-in
    // is intentionally unsupported), which reads as "the mic is broken"
    // when it is really just still playing the previous reply.
    showOperationError('Jarvis is still speaking — wait a moment, or tap Stop to interrupt.');
    return;
  }
  stopWakeMonitor();
  const capture = window.jarvisVoiceCapture;
  if (!capture?.startVadUtteranceCapture) {
    showOperationError('VAD capture unavailable; use Mic push-to-talk.');
    return;
  }
  showOperationError(null);
  listening = true;
  voiceCaptureMode = 'auto';
  const turn = beginVoiceTurn('mic_started', `mode=vad source=${source}`);
  activeVoiceTurn = turn;
  setJarvisState('capturing');
  voiceSession = capture.startVadUtteranceCapture({
    onState: (state) => {
      if (isVoiceTurnStale(turn)) {
        logVoiceStage(turn, 'dropped_stale_turn', `stage=vad_${state}`);
        return;
      }
      if (state === 'speech_started') logVoiceStage(turn, 'vad_speech_started');
      if (state === 'end_of_speech') {
        logVoiceStage(turn, 'vad_speech_ended');
        setJarvisState('processing');
      }
    },
  });
  syncCancelButton();
  try {
    const wav = await voiceSession.done;
    listening = false;
    voiceSession = null;
    voiceCaptureMode = null;
    syncCancelButton();
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_capture_stop');
      return;
    }
    logVoiceStage(turn, 'capture_stopped');
    if (!wav || wav.length < 44) {
      setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
      if (source === 'wake') await ensureWakeMonitor(lastSnapshot);
      showOperationError(source === 'wake'
        ? 'No speech captured after wake word. Try again or use Mic.'
        : 'No speech captured. Click once and speak, hold Space, or type your request.');
      return;
    }
    setJarvisState('processing');
    logVoiceStage(turn, 'asr_started');
    const started = performance.now();
    const { transcript, review } = await api.transcribeUtterance(capture.bytesToBase64(wav), turn.turnId);
    const eosToTranscriptMs = Math.round(performance.now() - started);
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_asr');
      return;
    }
    logVoiceStage(turn, 'asr_completed', `chars=${transcript?.length ?? 0} eosToTranscriptMs=${eosToTranscriptMs}`);
    lastVoiceTranscript = transcript;
    setVoiceTranscript(transcript, { status: `Transcript (${eosToTranscriptMs} ms)` });
    if (!transcript?.trim()) {
      // Whisper hallucinated a non-speech caption (e.g. "[MUSIC]") on
      // silence/ambient noise; the host already stripped it to empty —
      // treat exactly like no speech captured rather than dispatching it.
      listening = false;
      voiceSession = null;
      voiceCaptureMode = null;
      syncCancelButton();
      setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
      if (source === 'wake') await ensureWakeMonitor(lastSnapshot);
      showOperationError(source === 'wake'
        ? 'No speech captured after wake word. Try again or use Mic.'
        : 'No speech captured. Click once and speak, hold Space, or type your request.');
      return;
    }
    if (review?.required) {
      setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
      holdVoiceTranscriptForReview(transcript, review, turn);
      if (source === 'wake') await ensureWakeMonitor(lastSnapshot);
      return;
    }
    // Transcription is finished: "Transcribing" must not outlive it while the task runs.
    setJarvisState('idle');
    taskInput.value = transcript;
    result.textContent = '';
    followLatest = true;
    logVoiceStage(turn, 'transcript_submitted');
    await api.submitTask(transcript, workerSelect?.value, turn.turnId);
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_submit');
      return;
    }
    await refresh();
  } catch (err) {
    listening = false;
    voiceSession = null;
    voiceCaptureMode = null;
    if (isVoiceTurnStale(turn)) {
      logVoiceStage(turn, 'dropped_stale_turn', 'stage=after_error');
      syncCancelButton();
      return;
    }
    setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
    syncCancelButton();
    showOperationError(err);
    if (source === 'wake') await ensureWakeMonitor(lastSnapshot);
  }
}

async function playSpeechWavBase64(wavBase64, synthesizeMs, expectedText = '') {
  stopWakeMonitor();
  const generation = ++speechGeneration;
  if (activeSpeechAudio) {
    try { activeSpeechAudio.pause(); } catch { /* ignore */ }
    activeSpeechAudio = null;
  }
  if (expectedText) lastSpokenReplyText = expectedText;
  const bytes = Uint8Array.from(atob(wavBase64), (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  activeSpeechAudio = audio;
  setJarvisState('speaking');
  if (lastSnapshot) {
    renderWakeChrome({ ...lastSnapshot, speaking: true });
    renderLocalSpeechHint({ ...lastSnapshot, speaking: true });
  }
  let analyserCleanup = () => undefined;
  try {
    const ctx = new AudioContext();
    const source = ctx.createMediaElementSource(audio);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    analyser.connect(ctx.destination);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      if (generation !== speechGeneration || activeSpeechAudio !== audio) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      liveAudioLevel = Math.min(1, Math.sqrt(sum / data.length) * 3);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    analyserCleanup = () => {
      try { source.disconnect(); } catch { /* ignore */ }
      try { analyser.disconnect(); } catch { /* ignore */ }
      void ctx.close().catch(() => undefined);
    };
  } catch {
    // Playback level optional — still play via element.
  }
  const playbackTurnId = voiceTurnId;
  console.info(`[voice] turn=${playbackTurnId ?? 'n/a'} stage=playback_started tSinceStartMs=0`);
  const playbackStartedAt = performance.now();
  try {
    await new Promise((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error('Speech playback failed'));
      void audio.play().catch(reject);
    });
  } finally {
    analyserCleanup();
    URL.revokeObjectURL(url);
    liveAudioLevel = 0;
  }
  if (generation !== speechGeneration) return; // superseded by a newer reply
  const playbackCompletedMs = Math.round(performance.now() - playbackStartedAt);
  console.info(`[voice] turn=${playbackTurnId ?? 'n/a'} stage=playback_completed tSinceStartMs=${playbackCompletedMs} synthesizeMs=${synthesizeMs} durationMs=${playbackCompletedMs}`);
  activeSpeechAudio = null;
  await api.markPlaybackFinished();
  // jarvisUiState is a sticky local state machine, not derived from the
  // snapshot — renderLocalSpeechHint treats 'speaking' as an unconditional
  // mic-disable override, so leaving it at 'speaking' here permanently
  // disables the mic after every spoken reply even though the host's
  // `speaking` flag has already cleared.
  setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
  const micRearmedAt = performance.now();
  await refresh();
  await ensureWakeMonitor(lastSnapshot);
  console.info(`[voice] turn=${playbackTurnId ?? 'n/a'} stage=mic_rearmed tSinceStartMs=${Math.round(micRearmedAt - playbackStartedAt)} sincePlaybackCompletedMs=${Math.round(performance.now() - micRearmedAt)}`);
}

/** Strip Markdown formatting Piper would otherwise read aloud literally
 * (e.g. "**Berlin**" -> "asterisk asterisk Berlin..."). Text-only cleanup;
 * does not touch punctuation/abbreviations the TTS engine already handles. */
function stripMarkdownForSpeech(text) {
  return text
    // fenced code blocks -> drop the fence markers, keep the content
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    // images: drop entirely (alt text rarely reads sensibly aloud)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    // links: keep the label, drop the URL
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // bold/italic/strikethrough markers
    .replace(/(\*\*\*|___)(.*?)\1/g, '$2')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    // inline code
    .replace(/`([^`]*)`/g, '$1')
    // heading markers at line start
    .replace(/^#{1,6}\s+/gm, '')
    // blockquote markers
    .replace(/^>\s?/gm, '')
    // bullet/numbered list markers
    .replace(/^[ \t]*[-*+]\s+/gm, '')
    .replace(/^[ \t]*\d+\.\s+/gm, '')
    // collapse leftover blank-line runs from removed fences
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Prepares text for TTS so speech remains concise and relevant,
 * never droning on through massive multi-page file or directory lists. */
function prepareTextForSpeech(text) {
  let cleaned = stripMarkdownForSpeech(text);
  if (!cleaned) return '';
  if (cleaned.length > 350) {
    const paragraphs = cleaned.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
    if (paragraphs.length > 0) {
      cleaned = paragraphs[0];
    }
    if (cleaned.length > 350) {
      const match = cleaned.slice(0, 350).match(/(.*[.!?])\s/);
      if (match && match[1].length > 60) {
        cleaned = match[1];
      } else {
        cleaned = cleaned.slice(0, 320).trim() + '...';
      }
    }
  }
  return cleaned;
}

async function speakAnswerText(text) {
  if (!text?.trim()) return;
  if (lastSnapshot?.voiceMode === false) return;
  if (lastSnapshot?.localSpeechResponse?.capability !== 'available') return;
  const generation = speechGeneration + 1;
  const spokenText = prepareTextForSpeech(text);
  if (!spokenText) return;
  lastSpokenReplyText = spokenText;
  const ttsTurnId = voiceTurnId;
  console.info(`[voice] turn=${ttsTurnId ?? 'n/a'} stage=tts_started tSinceStartMs=0 chars=${spokenText.length}`);
  const ttsStartedAt = performance.now();
  try {
    const spoken = await api.speakText(spokenText);
    console.info(`[voice] turn=${ttsTurnId ?? 'n/a'} stage=tts_audio_ready tSinceStartMs=${Math.round(performance.now() - ttsStartedAt)} synthesizeMs=${spoken.synthesizeMs}`);
    if (generation <= speechGeneration && activeSpeechAudio) {
      // A newer speak started while synthesizing — abandon this WAV. The
      // newer generation owns clearing `speaking` once its own playback
      // ends; do not clear it here or the mic could reopen mid-playback.
      return;
    }
    await playSpeechWavBase64(spoken.wavBase64, spoken.synthesizeMs, spokenText);
  } catch (err) {
    if (generation === speechGeneration + 1 || !activeSpeechAudio) {
      showOperationError(err);
      await api.markPlaybackFinished().catch(() => undefined);
      setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
      await refresh().catch(() => undefined);
    }
  }
}

async function handleStopSpeaking() {
  speechGeneration += 1;
  liveAudioLevel = 0;
  if (activeSpeechAudio) {
    try { activeSpeechAudio.pause(); } catch { /* ignore */ }
    activeSpeechAudio = null;
  }
  await api.stopSpeaking();
  setJarvisState(lastSnapshot?.wakeWord?.enabled ? 'wake_monitoring' : 'idle');
  await refresh();
  await ensureWakeMonitor(lastSnapshot);
}

wakeEnable?.addEventListener('change', async () => {
  showOperationError(null);
  try {
    await api.setWakeWordEnabled(Boolean(wakeEnable.checked));
    await refresh();
    if (wakeEnable.checked) await ensureWakeMonitor(lastSnapshot);
    else stopWakeMonitor();
  } catch (err) {
    wakeEnable.checked = false;
    showOperationError(err);
  }
});

wakeMute?.addEventListener('click', async () => {
  const muted = !lastSnapshot?.wakeWord?.muted;
  await api.setWakeWordMuted(muted);
  await refresh();
  if (muted) stopWakeMonitor();
  else await ensureWakeMonitor(lastSnapshot);
});

voiceModeToggle?.addEventListener('change', async () => {
  await api.setVoiceMode(Boolean(voiceModeToggle.checked));
  await refresh();
});

stopSpeakingBtn?.addEventListener('click', () => {
  void handleStopSpeaking();
});

api.onVoiceEvent?.((event) => {
  if (event?.kind === 'wake_state') {
    void refresh().then(() => {
      if (event.enabled && !event.muted) void ensureWakeMonitor(lastSnapshot);
      else stopWakeMonitor();
    });
  }
  if (event?.kind === 'wake_detected') {
    console.info(
      `[voice] wake_detected score=${event.score} wakeDetectMs=${event.wakeDetectMs ?? 'null'} inferenceMs=${event.inferenceMs ?? 'null'} frames=${event.framesReceived ?? '?'}`,
    );
    acknowledgeWakeDetection(event);
    void beginVadUtterance('wake');
  }
  if (event?.kind === 'speak_stopped' || event?.kind === 'speak_finished') {
    void refresh().then(() => ensureWakeMonitor(lastSnapshot));
  }
});

setInterval(() => {
  if (lastSnapshot?.running) renderClocks(lastSnapshot);
}, 1000);

async function refreshHostTelemetry() {
  if (typeof api.getHostTelemetry !== 'function') return;
  try {
    const telemetry = await api.getHostTelemetry();
    if (lastSnapshot) {
      lastSnapshot = { ...lastSnapshot, hostTelemetry: telemetry };
      renderHostTelemetry(lastSnapshot);
    }
  } catch {
    /* keep last known sample; never fabricate */
  }
}

setInterval(() => {
  void refreshHostTelemetry();
}, 5000);

function initContextualDrawers() {
  const drawerButtons = document.querySelectorAll('.hud-nav-tab[data-drawer], .sidebar-rail-btn[data-drawer]');
  const closeButtons = document.querySelectorAll('.drawer-close-btn, .btn-drawer-close');

  function toggleDrawer(drawerId) {
    const targetDrawer = document.getElementById(drawerId);
    if (!targetDrawer) return;

    const isCurrentlyActive = targetDrawer.classList.contains('is-active');

    // Close all drawers
    document.querySelectorAll('.hud-drawer').forEach((d) => {
      d.classList.remove('is-active');
      d.hidden = true;
    });
    document.querySelectorAll('.hud-nav-tab, .sidebar-rail-btn').forEach((b) => {
      b.classList.remove('is-active');
    });

    // If it wasn't active, open it
    if (!isCurrentlyActive) {
      targetDrawer.hidden = false;
      targetDrawer.classList.add('is-active');
      const matchingBtns = document.querySelectorAll(`[data-drawer="${drawerId}"]`);
      matchingBtns.forEach((btn) => btn.classList.add('is-active'));
    }
  }

  drawerButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const drawerId = btn.dataset.drawer;
      if (drawerId) toggleDrawer(drawerId);
    });
  });

  closeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const drawerId = btn.dataset.close;
      const targetDrawer = drawerId ? document.getElementById(drawerId) : btn.closest('.hud-drawer');
      if (targetDrawer) {
        targetDrawer.classList.remove('is-active');
        targetDrawer.hidden = true;
        const matchingBtns = document.querySelectorAll(`[data-drawer="${targetDrawer.id}"]`);
        matchingBtns.forEach((b) => b.classList.remove('is-active'));
      }
    });
  });

  // Sidebar controls
  const sidebarToggle = document.getElementById('sidebar-toggle-btn');
  const sidebar = document.getElementById('panda-sidebar');
  sidebarToggle?.addEventListener('click', () => {
    if (sidebar) {
      const isCollapsed = sidebar.classList.toggle('is-collapsed');
      sidebar.classList.toggle('is-expanded', !isCollapsed);
    }
  });

  const sidebarNewBtn = document.getElementById('sidebar-new-btn');
  sidebarNewBtn?.addEventListener('click', () => {
    document.getElementById('conversations-new')?.click();
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.hud-drawer.is-active').forEach((d) => {
        d.classList.remove('is-active');
        d.hidden = true;
      });
      document.querySelectorAll('.hud-nav-tab.is-active, .sidebar-rail-btn.is-active').forEach((b) => {
        b.classList.remove('is-active');
      });
      hideQuickAnswer();
      hideCapabilityCard();
    }
  });
}

/** ── EXPERIENCE C: QUICK ANSWER / CENTER IRIS CONTROLLER ── */
function isShortConversationalQuery(query) {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  const wb = document.getElementById('floating-workbench');
  if (wb && !wb.hidden) return false;
  const taskKeywords = [
    'create', 'edit', 'modify', 'write', 'delete', 'fix', 'refactor', 'diff',
    'patch', 'run test', 'npm test', 'git', 'terminal', 'compile', 'build',
    'search files', 'search workspace', 'examine repo', 'inspect code',
  ];
  if (taskKeywords.some((kw) => q.includes(kw))) return false;
  if (q.length < 100) return true;
  const convStarters = ['what', 'which', 'who', 'why', 'how', 'when', 'tell me', 'explain', 'hello', 'hi', 'help', 'summarize'];
  return convStarters.some((s) => q.startsWith(s));
}

function showQuickAnswer(modelName = '') {
  const irisCard = document.getElementById('center-iris-card');
  const badge = document.getElementById('iris-model-badge');
  const content = document.getElementById('iris-content');
  if (irisCard) {
    irisCard.hidden = false;
    irisCard.classList.add('is-open');
  }
  if (badge) {
    badge.textContent = modelName || modelSelect?.value || 'qwen3.8:27b-mtp-q4_K_M';
  }
  if (content && (!content.textContent || content.textContent.trim() === '')) {
    content.innerHTML = '<span class="iris-thinking font-mono">Thinking…</span>';
  }
}

function hideQuickAnswer() {
  const irisCard = document.getElementById('center-iris-card');
  if (irisCard) {
    irisCard.hidden = true;
    irisCard.classList.remove('is-open');
  }
}

function updateQuickAnswerFromMessages(messages) {
  const irisCard = document.getElementById('center-iris-card');
  if (!irisCard || irisCard.hidden) return;
  if (!Array.isArray(messages) || messages.length === 0) return;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === 'assistant') {
      const badge = document.getElementById('iris-model-badge');
      const content = document.getElementById('iris-content');
      if (badge && msg.model) badge.textContent = msg.model;
      if (content) {
        content.replaceChildren();
        renderMarkdownLite(content, msg.content);
      }
      break;
    }
  }
}

/** ── EXPERIENCE E: CONTEXTUAL CAPABILITY CARDS CONTROLLER ── */
const CAPABILITY_CARD_DATA = {
  planning: {
    title: 'PLANNING & STRATEGY',
    role: 'Decomposition · Objectives · Phases',
    wbMode: 'conv',
    caps: ['Multi-step task decomposition', 'Active task phase tracking', 'Verification checkpointing'],
    asks: ['"Plan refactor of auth module"', '"Deconstruct mission requirements"'],
    getLiveState: (s) => `Active phase: ${s?.cockpit?.phase || 'idle'} · Task: ${s?.cockpit?.taskSummary || 'Standing by'}`,
  },
  research: {
    title: 'RESEARCH & SYNTHESIS',
    role: 'Search · Symbol Discovery · Synthesis',
    wbMode: 'research',
    caps: ['Workspace symbol search', 'Grounded document retrieval', 'Source citation tracking'],
    asks: ['"Find where conversations are persisted"', '"Analyze electron preload bridge"'],
    getLiveState: (s) => `Files inspected: ${s?.cockpit?.filesRead?.length || 0} · Workspace: ${folderPath?.textContent || 'None'}`,
  },
  files: {
    title: 'FILES & WORKSPACE',
    role: 'Discovery · Scoped Paths · Tree',
    wbMode: 'fileops',
    caps: ['Workspace directory tree discovery', 'Scoped path boundary enforcement', 'File inspection and read-only audits'],
    asks: ['"List files in active workspace"', '"Inspect package.json dependencies"'],
    getLiveState: (s) => `Selected root: ${folderPath?.textContent || 'No folder chosen'} · Boundary: Strict fail-closed`,
  },
  operations: {
    title: 'OPERATIONS & TOOLS',
    role: 'Execution · Gatekeeper · Observed Logs',
    wbMode: 'fileops',
    caps: ['Scoped CLI command execution', 'Approval gate enforcement', 'Real-time telemetry event streams'],
    asks: ['"Run npm test on desktop suite"', '"Verify node documentation rules"'],
    getLiveState: (s) => `Tool executions: ${s?.cockpit?.toolExecutions?.length || 0} observed · Gate: Safe execution only`,
  },
  voice: {
    title: 'VOICE INTELLIGENCE',
    role: 'Speech · Push-to-Talk · Audio Cues',
    wbMode: 'conv',
    caps: ['Push-to-talk speech input', 'Local Whisper transcription', 'Low-latency conversational cues'],
    asks: ['Hold Space or tap mic to dictate', '"What model is currently active?"'],
    getLiveState: () => `Microphone: ${listening ? 'Active / Capturing' : 'Standby'} · Push-to-Talk ready`,
  },
  design: {
    title: 'DESIGN & UI SYSTEM',
    role: 'Cinematic HUD · Constellation · Themes',
    wbMode: 'conv',
    caps: ['Neural constellation graph', 'APEX shader background', 'Glassmorphic split workbenches'],
    asks: ['"Toggle presentation layout"', '"Inspect visual tokens"'],
    getLiveState: () => `Visual core: True circular reactor · Pure SVG & WebGL · 60fps`,
  },
  engineering: {
    title: 'ENGINEERING & RUNTIME',
    role: 'Ollama Inference · IPC Bridge · Memory',
    wbMode: 'code',
    caps: ['Local Ollama model switching', 'Diagnostics attempt logging', 'Electron secure IPC channel'],
    asks: ['"Switch to tev-27b model"', '"Inspect request attempt latency"'],
    getLiveState: (s) => `Model: ${modelSelect?.value || 'qwen3.8:27b-mtp-q4_K_M'} · Platform: ${window.process?.platform || 'win32'}`,
  },
  coding: {
    title: 'CODING & OPENCODE',
    role: 'Edits · Syntactic Diffs · Verification',
    wbMode: 'code',
    caps: ['OpenCode delegation engine', 'Diff inspection and patch application', 'Task-specific validation checks'],
    asks: ['"Fix circular mascot frame bug"', '"Implement quick answer iris card"'],
    getLiveState: (s) => `Modified files: ${s?.cockpit?.filesChanged?.length || 0} · Runtime: Pi Agent Core / OpenCode`,
  },
  memory: {
    title: 'MEMORY & PROVENANCE',
    role: 'SQLite Durability · Cross-Model Context',
    wbMode: 'conv',
    caps: ['SQLite durable storage', 'Cross-model history retention', 'Per-turn attribution badges'],
    asks: ['"What was my previous question?"', '"Show conversation history"'],
    getLiveState: () => `Conversation: ${viewingConversationId || 'Active'} · Model transitions preserved`,
  },
  calendar: {
    title: 'CALENDAR & SCHEDULE',
    role: 'Schedule · Timers (Local only)',
    wbMode: 'conv',
    caps: ['Local host time synchronization', 'Timeline event notifications'],
    asks: ['"What is the current time?"'],
    getLiveState: () => `Status: Local host time sync only · External calendar not connected`,
  },
};

let activeCardTargetMode = 'conv';

function openCapabilityCard(node) {
  const card = document.getElementById('node-overview-card');
  const title = document.getElementById('overview-title');
  const role = document.getElementById('overview-role');
  const liveState = document.getElementById('overview-live-state');
  const capsList = document.getElementById('overview-caps-list');
  const asksList = document.getElementById('overview-asks-list');

  if (!card || !node) return;
  const data = CAPABILITY_CARD_DATA[node.id] || {
    title: (node.label || node.id).toUpperCase(),
    role: node.subtitle || 'System Capability',
    wbMode: 'conv',
    caps: ['Runtime execution integration'],
    asks: ['"Inspect active status"'],
    getLiveState: () => 'Active capability node',
  };

  activeCardTargetMode = data.wbMode || 'conv';

  if (title) title.textContent = data.title;
  if (role) role.textContent = data.role;
  if (liveState) liveState.textContent = data.getLiveState(lastSnapshot);

  if (capsList) {
    capsList.replaceChildren();
    data.caps.forEach((cap) => {
      const li = document.createElement('li');
      li.textContent = cap;
      capsList.appendChild(li);
    });
  }

  if (asksList) {
    asksList.replaceChildren();
    data.asks.forEach((ask) => {
      const chip = document.createElement('span');
      chip.className = 'ask-chip font-mono';
      chip.textContent = ask;
      asksList.appendChild(chip);
    });
  }

  hideQuickAnswer();
  card.hidden = false;
  card.classList.add('is-open');
}

function hideCapabilityCard() {
  const card = document.getElementById('node-overview-card');
  if (card) {
    card.hidden = true;
    card.classList.remove('is-open');
  }
}

/** ── PANDA APEX EXPERIENCE CONTROLLER ── */
let apexShader = null;
let apexReasoningWeb = null;
let apexStatusBar = null;
let floatingWorkbenchController = null;

function initFloatingWorkbench() {
  const wb = document.getElementById('floating-workbench');
  const btnOpenWb = document.getElementById('btn-open-workbench');
  const btnClose = document.getElementById('btn-wb-close');
  const btnMin = document.getElementById('btn-wb-min');
  const btnMax = document.getElementById('btn-wb-max');
  const btnPopout = document.getElementById('btn-wb-popout');
  const minChip = document.getElementById('wb-minimized-chip');
  const dragHandle = document.getElementById('workbench-drag-handle');
  const titleBar = document.getElementById('workbench-title-bar');
  const btnReturnHome = document.getElementById('wb-return-home');
  const btnBackConv = document.getElementById('btn-wb-back-conv');

  const tabs = {
    conv: { btn: document.getElementById('wb-tab-conv'), pane: document.getElementById('wb-pane-conversation'), title: 'Active Conversation' },
    research: { btn: document.getElementById('wb-tab-research'), pane: document.getElementById('wb-pane-research'), title: 'Live Research Synthesis' },
    fileops: { btn: document.getElementById('wb-tab-fileops'), pane: document.getElementById('wb-pane-fileops'), title: 'Workspace File Operations' },
    code: { btn: document.getElementById('wb-tab-code'), pane: document.getElementById('wb-pane-code'), title: 'Code Diffs & Execution' },
  };

  let activeMode = 'conv';

  function switchWbMode(mode) {
    activeMode = mode;
    Object.entries(tabs).forEach(([k, t]) => {
      const isActive = k === mode;
      if (t.btn) {
        t.btn.classList.toggle('is-active', isActive);
        t.btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      }
      if (t.pane) {
        t.pane.classList.toggle('is-active', isActive);
        t.pane.hidden = !isActive;
      }
    });
    if (titleBar && tabs[mode]) {
      titleBar.textContent = tabs[mode].title;
    }
    if (btnBackConv) {
      btnBackConv.hidden = (mode === 'conv');
    }
  }

  Object.entries(tabs).forEach(([k, t]) => {
    t.btn?.addEventListener('click', () => switchWbMode(k));
  });

  btnBackConv?.addEventListener('click', () => switchWbMode('conv'));
  document.querySelectorAll('.btn-return-conv').forEach((btn) => {
    btn.addEventListener('click', () => switchWbMode('conv'));
  });

  function openWorkbench(mode) {
    if (!wb) return;
    wb.hidden = false;
    document.querySelector('.app')?.setAttribute('data-workbench-open', 'true');
    hideQuickAnswer();
    hideCapabilityCard();
    if (minChip) minChip.hidden = true;
    if (mode && tabs[mode]) switchWbMode(mode);
    btnOpenWb?.classList.add('is-active');
  }

  function closeWorkbench() {
    if (!wb) return;
    wb.hidden = true;
    document.querySelector('.app')?.setAttribute('data-workbench-open', 'false');
    if (minChip) minChip.hidden = true;
    btnOpenWb?.classList.remove('is-active');
  }

  function minimizeWorkbench() {
    if (!wb) return;
    wb.hidden = true;
    document.querySelector('.app')?.setAttribute('data-workbench-open', 'false');
    if (minChip) minChip.hidden = false;
    btnOpenWb?.classList.remove('is-active');
  }

  function toggleMaximizeWorkbench() {
    if (!wb) return;
    wb.classList.toggle('is-maximized');
  }

  btnOpenWb?.addEventListener('click', () => {
    if (!wb) return;
    if (wb.hidden) openWorkbench(activeMode);
    else closeWorkbench();
  });

  btnClose?.addEventListener('click', closeWorkbench);
  btnMin?.addEventListener('click', minimizeWorkbench);
  btnMax?.addEventListener('click', toggleMaximizeWorkbench);
  btnReturnHome?.addEventListener('click', closeWorkbench);
  minChip?.addEventListener('click', () => openWorkbench(activeMode));

  btnPopout?.addEventListener('click', () => {
    if (typeof api?.popoutWorkbench === 'function') {
      void api.popoutWorkbench(activeMode).catch(showOperationError);
      closeWorkbench();
    }
  });

  // Topbar window controls
  document.getElementById('btn-win-min')?.addEventListener('click', () => {
    if (typeof api?.minimizeWindow === 'function') void api.minimizeWindow().catch(showOperationError);
  });
  document.getElementById('btn-win-max')?.addEventListener('click', () => {
    if (typeof api?.maximizeWindow === 'function') void api.maximizeWindow().catch(showOperationError);
  });
  document.getElementById('btn-win-close')?.addEventListener('click', () => {
    if (typeof api?.closeWindow === 'function') void api.closeWindow().catch(showOperationError);
  });

  // Dragging logic for the floating workbench (jumping-safe, relative to offsetParent)
  if (dragHandle && wb) {
    let isDragging = false;
    let hasMoved = false;
    let startX = 0, startY = 0, initialLeft = 0, initialTop = 0;

    dragHandle.addEventListener('mousedown', (e) => {
      if (
        e.target.closest('button') ||
        e.target.closest('input') ||
        e.target.closest('.wb-tab-row') ||
        e.target.closest('.wb-mode-tabs') ||
        e.target.closest('#workbench-title-bar')
      ) {
        return;
      }
      isDragging = true;
      hasMoved = false;
      startX = e.clientX;
      startY = e.clientY;
      const rect = wb.getBoundingClientRect();
      const parentRect = wb.offsetParent ? wb.offsetParent.getBoundingClientRect() : { left: 0, top: 0 };
      initialLeft = rect.left - parentRect.left;
      initialTop = rect.top - parentRect.top;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!hasMoved) {
        if (Math.hypot(dx, dy) < 4) return;
        hasMoved = true;
        wb.style.right = 'auto';
        wb.classList.add('is-dragging');
      }
      wb.style.left = `${Math.max(10, initialLeft + dx)}px`;
      wb.style.top = `${Math.max(10, initialTop + dy)}px`;
    });

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        wb.classList.remove('is-dragging');
      }
    });
  }

  return {
    open: openWorkbench,
    close: closeWorkbench,
    minimize: minimizeWorkbench,
    switchMode: switchWbMode,
    getActiveMode: () => activeMode,
  };
}

function initApexExperience() {
  // The WebGL shader background and the reasoning-web constellation are not
  // started: both ran continuous animation loops (software-rendered, ~60% of
  // a core while idle) and the constellation showed invented step labels.
  // Idle Panda is the mascot, the composer and real status only.

  if (typeof initApexStatusBar === 'function') {
    try {
      apexStatusBar = initApexStatusBar('apex-status-container');
    } catch (e) {
      console.warn('[apex] status bar skipped:', e?.message || e);
    }
  }

  try {
    floatingWorkbenchController = initFloatingWorkbench();
  } catch (e) {
    console.warn('[apex] floating workbench init error:', e);
  }

  // Experience C (Iris) action buttons
  document.getElementById('btn-iris-expand')?.addEventListener('click', () => {
    hideQuickAnswer();
    floatingWorkbenchController?.open('conv');
  });
  document.getElementById('btn-iris-close')?.addEventListener('click', () => {
    hideQuickAnswer();
  });

  // Experience E (Capability Card) action buttons
  document.getElementById('btn-card-expand')?.addEventListener('click', () => {
    hideCapabilityCard();
    floatingWorkbenchController?.open(activeCardTargetMode || 'conv');
  });
  document.getElementById('overview-close-btn')?.addEventListener('click', () => {
    hideCapabilityCard();
  });
}

function updateApexTelemetry(state, snapshot = lastSnapshot) {
  if (apexStatusBar) {
    if (state === 'listening' || state === 'capturing') {
      apexStatusBar.setStatus('LISTENING', { active: true, color: '#00e5ff' });
    } else if (state === 'speaking') {
      apexStatusBar.setStatus('SPEAKING', { active: true, color: '#f5a623' });
    } else if (state === 'working' || state === 'processing') {
      apexStatusBar.setStatus('PROCESSING MISSION', { active: true, color: '#00e5ff' });
    } else if (state === 'completed') {
      apexStatusBar.setStatus('COMPLETED', { active: false, color: '#34d399' });
    } else if (state === 'failed') {
      apexStatusBar.setStatus('FAILED', { active: false, color: '#f87171' });
    } else {
      apexStatusBar.setStatus('STANDBY', { active: false, color: '#f5a623' });
    }
  }

  if (apexShader) {
    const isVoice = state === 'listening' || state === 'capturing' || state === 'speaking';
    apexShader.setVoiceActive(isVoice);
    apexShader.setGold(state === 'working' || state === 'speaking');
  }

  if (apexReasoningWeb) {
    if (state === 'idle') {
      apexReasoningWeb.deactivateAll();
    } else if (state === 'waiting_for_approval' || snapshot?.needsApproval) {
      apexReasoningWeb.setNodeState('operations', 'waiting_approval', 'Authorization required');
    } else if (state === 'working') {
      const phase = snapshot?.cockpit?.phase;
      if (phase === 'planning') {
        apexReasoningWeb.setNodeState('planning', 'active', 'Decomposing task');
      } else if (snapshot?.cockpit?.filesRead?.length > 0) {
        apexReasoningWeb.setNodeState('research', 'active', 'Searching workspace');
        apexReasoningWeb.setNodeState('files', 'active', 'Reading sources');
      }
      if (snapshot?.cockpit?.filesChanged?.length > 0) {
        apexReasoningWeb.setNodeState('coding', 'active', `${snapshot.cockpit.filesChanged.length} files modified`);
        apexReasoningWeb.setNodeState('engineering', 'active', 'Validating syntax');
      }
    } else if (state === 'completed') {
      apexReasoningWeb.setNodeState('planning', 'completed', 'Execution finished');
    } else if (state === 'failed') {
      apexReasoningWeb.setNodeState('operations', 'failed', 'Execution error');
    }
  }
}

initApexExperience();
initContextualDrawers();
setJarvisState('idle');

async function applyAppMetadata() {
  const badge = document.getElementById('app-version-badge');
  if (!badge || typeof api.getAppMetadata !== 'function') return;
  try {
    const meta = await api.getAppMetadata();
    const version = String(meta?.version || '').trim();
    if (!version) {
      badge.hidden = true;
      badge.textContent = '';
      return;
    }
    // One label, one source: `v0.1.1 · b142` for an official build,
    // `v0.1.1 · dev` for a local one. A local build never borrows an
    // official build number.
    const buildKind = meta?.buildKind === 'release' ? 'release' : 'development';
    const buildNumber = Number(meta?.buildNumber);
    const label = buildKind === 'release' && Number.isInteger(buildNumber) && buildNumber > 0
      ? `v${version.replace(/^v/i, '')} · b${buildNumber}`
      : `v${version.replace(/^v/i, '')} · dev`;
    badge.textContent = label;
    badge.dataset.channel = String(meta?.releaseChannel || 'dev');
    badge.hidden = false;
    renderAboutPanel(meta);
  } catch {
    badge.hidden = true;
    badge.textContent = '';
  }
}

/**
 * The About panel shows what this build actually is. Every value comes from
 * the host's embedded build identity — nothing here is invented in the UI.
 */
function renderAboutPanel(meta) {
  const set = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  };
  const version = String(meta?.version || '').trim();
  const buildKind = meta?.buildKind === 'release' ? 'release' : 'development';
  const buildNumber = Number(meta?.buildNumber);
  set('about-version', version ? `v${version.replace(/^v/i, '')}` : 'unknown');
  set('about-build', buildKind === 'release' && Number.isInteger(buildNumber) && buildNumber > 0
    ? `b${buildNumber}`
    : 'development build (no official build number)');
  set('about-commit', meta?.commit ? String(meta.commit) : 'unknown');
  set('about-built', meta?.builtAt ? new Date(meta.builtAt).toLocaleString() : 'unknown');
  set('about-channel', String(meta?.releaseChannel || 'dev'));
  set('about-core', meta?.coreVersion ? String(meta.coreVersion) : 'not running');
  set('about-installer', meta?.installerVersion ? String(meta.installerVersion) : 'unknown');
  const channelBadge = document.getElementById('about-channel-badge');
  if (channelBadge) channelBadge.textContent = String(meta?.releaseChannel || 'dev');
  const mismatch = document.getElementById('about-core-mismatch');
  if (mismatch) mismatch.hidden = meta?.coreVersionMismatch !== true;
}

/** Copies the diagnostics block: build, platform and runtime state. No credentials. */
async function copyDiagnostics() {
  const status = document.getElementById('about-copy-status');
  const say = (text) => { if (status) status.textContent = text; };
  if (typeof api.getDiagnosticsReport !== 'function') { say('Diagnostics are unavailable in this build.'); return; }
  try {
    const report = await api.getDiagnosticsReport();
    await navigator.clipboard.writeText(String(report || ''));
    say('Copied.');
  } catch {
    say('Could not copy. Open Settings → About Pandesh and copy the details manually.');
  }
}

function wireAboutPanel() {
  const badge = document.getElementById('app-version-badge');
  if (badge && !badge.dataset.aboutBound) {
    badge.dataset.aboutBound = '1';
    badge.addEventListener('click', () => {
      // The About panel shows live facts (including the running Core's
      // version), so it re-reads them when it is opened.
      void applyAppMetadata();
      const integrations = document.querySelector('[data-surface="integrations"]');
      if (integrations) integrations.click();
      const about = document.getElementById('about-card');
      if (about) about.scrollIntoView({ block: 'center' });
    });
  }
  const copy = document.getElementById('about-copy-diagnostics');
  if (copy && !copy.dataset.aboutBound) {
    copy.dataset.aboutBound = '1';
    copy.addEventListener('click', () => { void copyDiagnostics(); });
  }
}

void applyAppMetadata();
wireAboutPanel();
void refreshConversationsRail();
void refreshIntegrationsView();
void refreshTasksMissionsView();

void refresh()
  .then(() => {
    void refreshHostTelemetry();
    return ensureWakeMonitor(lastSnapshot);
  })
  .catch(showOperationError);

/** ══════════════════════════════════════════════════════════════════
 *  KARKEDIKHA APPROVED 4-SURFACE NAVIGATION & INTEGRATIONS CONTROLLER
 *  ══════════════════════════════════════════════════════════════════ */

function switchSurface(rawSurfaceName) {
  // Home and Conversations are one place now: the assistant workspace.
  const surfaceName = rawSurfaceName === 'home' || rawSurfaceName === 'conversations' ? 'assistant' : rawSurfaceName;
  const app = document.querySelector('.app');
  if (app) app.dataset.activeSurface = surfaceName;

  document.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
    btn.classList.toggle('is-active', btn.getAttribute('data-surface') === surfaceName);
  });

  const stage = document.getElementById('constellation-stage');
  const conv = document.getElementById('surface-conversations');
  const tasks = document.getElementById('surface-tasks');
  const integ = document.getElementById('surface-integrations');
  const wb = document.getElementById('floating-workbench');
  if (wb) wb.hidden = true;

  // The legacy constellation stage only hosts hidden compatibility hooks.
  if (stage) stage.hidden = true;
  if (conv) conv.hidden = surfaceName !== 'assistant';
  if (tasks) tasks.hidden = surfaceName !== 'tasks';
  if (integ) integ.hidden = surfaceName !== 'integrations';

  // Restore unsent composer draft if needed
  if (taskInput && unsentDraftText && !taskInput.value) {
    taskInput.value = unsentDraftText;
  }

  if (surfaceName === 'assistant') {
    syncAssistantMode();
    void refreshConversationsRail();
    // Home opens knowing what matters: the brief comes straight from Core.
    void refreshAssistantBrief({ external: false });
    const resultNode = document.getElementById('result');
    if (resultNode) {
      resultNode.scrollTop = resultNode.scrollHeight;
    }
  } else if (surfaceName === 'tasks') {
    void refreshTasksMissionsView();
  } else if (surfaceName === 'integrations') {
    void refreshIntegrationsView();
  }
}

const ARTIFACT_KIND_LABELS = { image: 'Image', video: 'Video', document: 'Document', file: 'File' };

/** Friendly, ID-free title for a result card. Raw artifact ids stay in Details. */
function artifactDisplayTitle(art) {
  const raw = String(art.title || art.fileName || '').trim();
  if (raw && !/^artifact_[0-9a-f-]{8,}/i.test(raw)) return raw;
  const kind = ARTIFACT_KIND_LABELS[art.kind] || 'Result';
  const when = art.createdAt ? new Date(art.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  return when ? `${kind} · ${when}` : kind;
}

/** One result card, used by both Tasks and the in-conversation Results strip. */
function buildResultCard(art, { compact = false } = {}) {
  const card = document.createElement('article');
  card.className = `result-card${compact ? ' is-compact' : ''}`;
  card.dataset.kind = art.kind || 'file';
  card.dataset.artifactId = art.id;

  const thumb = document.createElement('div');
  thumb.className = 'result-thumb';
  const glyph = document.createElement('span');
  glyph.className = 'result-thumb-glyph';
  glyph.textContent = art.kind === 'video' ? '▶' : art.kind === 'image' ? '🖼' : '📄';
  thumb.appendChild(glyph);
  card.appendChild(thumb);

  const body = document.createElement('div');
  body.className = 'result-body';
  const title = document.createElement('div');
  title.className = 'result-title';
  title.textContent = artifactDisplayTitle(art);
  title.title = title.textContent;
  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const when = art.createdAt ? new Date(art.createdAt).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  meta.textContent = [ARTIFACT_KIND_LABELS[art.kind] || 'File', when, art.availability && art.availability !== 'ready' ? `(${art.availability})` : ''].filter(Boolean).join(' · ');
  const actions = document.createElement('div');
  actions.className = 'result-actions';
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'apex-chip';
  open.textContent = 'Open';
  open.disabled = art.availability !== 'ready';
  open.addEventListener('click', () => { void api.openArtifactFile?.(art.id); });
  const folder = document.createElement('button');
  folder.type = 'button';
  folder.className = 'apex-chip';
  folder.textContent = 'Show in folder';
  folder.addEventListener('click', () => { void api.openArtifactFolder?.(art.id); });
  actions.append(open, folder);
  // Technical identifiers are only in the DOM, and only visible in Details mode.
  const tech = document.createElement('div');
  tech.className = 'result-tech font-mono';
  tech.textContent = `${art.id}${art.conversationId ? ` · conversation ${art.conversationId}` : ''}`;
  body.append(title, meta, actions, tech);
  card.appendChild(body);

  if (art.kind === 'image' && art.availability === 'ready' && typeof api?.loadArtifactPreview === 'function') {
    void api.loadArtifactPreview(art.id).then((preview) => {
      if (!preview?.dataUrl || !card.isConnected) return;
      const img = document.createElement('img');
      img.src = preview.dataUrl;
      img.alt = title.textContent;
      img.className = 'result-thumb-img';
      thumb.replaceChildren(img);
    }).catch(() => { /* keep the glyph */ });
  }
  return card;
}

/** Compact Kandev-backed development story view: counts, then one row per story with its real state. */
async function refreshDevStoriesPanel() {
  const panel = document.getElementById('dev-stories-panel');
  if (!panel || typeof api?.getDevStories !== 'function') return;
  let data;
  try { data = await api.getDevStories(); } catch { panel.hidden = true; return; }
  const stories = data?.stories || [];
  panel.hidden = stories.length === 0;
  if (!stories.length) return;
  const c = data.counts || {};
  const stopAll = document.getElementById('dev-stories-stop-all');
  if (stopAll && typeof api.stopAllDevStories === 'function') {
    const live = stories.some((s) => !['done', 'ready', 'blocked'].includes(s.status));
    stopAll.hidden = !live;
    stopAll.onclick = async () => {
      stopAll.disabled = true;
      stopAll.textContent = 'Stopping…';
      try {
        const r = await api.stopAllDevStories();
        document.getElementById('dev-stories-counts').textContent = `Stopped ${r.stopped.length} stories${r.stillRunning.length ? ` · ${r.stillRunning.length} worker(s) still running` : ' · no worker running'}`;
      } finally {
        stopAll.disabled = false;
        stopAll.textContent = 'Stop all';
        void refreshDevStoriesPanel();
      }
    };
  }
  document.getElementById('dev-stories-title').textContent = `KKD development — ${stories.length} stories`;
  const parts = [[c.running, 'running'], [c.completed, 'completed'], [c.ready, 'ready'], [c.waiting, 'waiting'], [c.verifying, 'verifying'], [c.blocked, 'blocked'], [c.review, 'awaiting your review'], [c.approval, 'waiting for approval']]
    .filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
  document.getElementById('dev-stories-counts').textContent = (data.available ? '' : 'Kandev is not running · ') + parts.join(' · ');
  const when = (iso) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const rows = stories.map((s) => {
    const li = document.createElement('li');
    li.className = 'dev-story';
    li.dataset.phase = s.status === 'done' ? 'done' : s.phase.replace(/\s.*$/, '');
    const head = document.createElement('div');
    head.className = 'dev-story-head';
    const title = document.createElement('strong');
    title.textContent = s.title;
    const meta = document.createElement('span');
    meta.className = 'muted';
    const proof = { independent: 'independently verified', 'human-reviewed': 'reviewed by you', 'worker-only': 'worker tests only' }[s.verification] || '';
    meta.textContent = ` · ${s.agent} · ${s.status === 'done' ? 'completed' : s.phase}${proof ? ` · ${proof}` : ''} · updated ${when(s.updatedAt)}`;
    head.append(title, meta);
    li.append(head);
    const detail = [];
    if (s.waitingReason) detail.push(s.waitingReason);
    if (s.dependsOn?.length) detail.push(`depends on ${s.dependsOn.join(', ')}`);
    if (s.commit) detail.push(`commit ${s.commit}`);
    else if (s.branch) detail.push(`branch ${s.branch}`);
    if (detail.length) {
      const d = document.createElement('div');
      d.className = 'muted dev-story-detail';
      d.textContent = detail.join(' · ');
      li.append(d);
    }
    if (Array.isArray(s.activity) && s.activity.length) {
      // What the worker is doing right now (from Kandev), newest last.
      const feed = document.createElement('div');
      feed.className = 'muted dev-story-activity';
      for (const a of s.activity) {
        const line = document.createElement('div');
        line.textContent = `${new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${a.kind === 'message' ? 'says' : a.kind} · ${a.text}`;
        feed.append(line);
      }
      li.append(feed);
    }
    if (s.evidence && document.querySelector('.app')?.dataset?.details === 'on') {
      const ev = document.createElement('pre');
      ev.className = 'dev-story-evidence';
      ev.textContent = s.evidence;
      li.append(ev);
    }
    if (s.status === 'delivery_approval' && typeof api.approveDevStoryReview === 'function') {
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.className = 'apex-chip';
      approve.textContent = 'Approve after review';
      approve.addEventListener('click', async () => {
        approve.disabled = true;
        try { await api.approveDevStoryReview(s.id); } finally { void refreshDevStoriesPanel(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(approve);
      li.append(row);
    }
    if ((s.status === 'blocked' || s.status === 'implementing') && s.branch && typeof api.verifyExistingDevStory === 'function') {
      // The worker is gone (or about to be stopped) but its output is in the worktree: verify and integrate it as it stands.
      const verify = document.createElement('button');
      verify.type = 'button';
      verify.className = 'apex-chip';
      verify.textContent = 'Verify existing work';
      verify.title = 'Stops the worker for good, then runs the normal checks on the work already in its worktree and integrates it only if every check passes. No worker is started.';
      verify.addEventListener('click', async () => {
        if (!window.confirm(`Verify the existing work for "${s.title}"? The worker is stopped (it will not be restarted) and its worktree is checked and, if everything passes, integrated.`)) return;
        verify.disabled = true;
        try { await api.verifyExistingDevStory(s.id); } finally { void refreshDevStoriesPanel(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(verify);
      li.append(row);
    }
    if ((s.status === 'blocked' || s.status === 'delivery_approval') && typeof api.retryDevStory === 'function') {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'apex-chip';
      retry.textContent = s.phase === 'stopped' ? 'Resume' : 'Retry';
      retry.addEventListener('click', async () => {
        retry.disabled = true;
        try { await api.retryDevStory(s.id); } finally { void refreshDevStoriesPanel(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(retry);
      li.append(row);
    }
    for (const p of s.pendingApprovals || []) {
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      const what = document.createElement('code');
      what.textContent = p.what;
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.className = 'apex-chip';
      allow.textContent = 'Allow once';
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.className = 'apex-chip';
      deny.textContent = 'Deny';
      const decide = async (ok) => {
        allow.disabled = deny.disabled = true;
        try { await api.decideDevStoryPermission(s.id, p.pendingId, ok); } finally { void refreshDevStoriesPanel(); }
      };
      allow.addEventListener('click', () => void decide(true));
      deny.addEventListener('click', () => void decide(false));
      row.append(what, allow, deny);
      li.append(row);
    }
    return li;
  });
  document.getElementById('dev-stories-list').replaceChildren(...rows);
}

// Live telemetry under the composer while work runs: phase, elapsed, last event — on every screen, not only Tasks.
let liveTelemetryBusy = false;
async function refreshLiveTelemetry() {
  const line = document.getElementById('live-telemetry');
  if (!line || typeof api?.getTaskOverview !== 'function') return;
  if (!lastSnapshot?.running) { line.hidden = true; return; }
  if (liveTelemetryBusy) return;
  liveTelemetryBusy = true;
  try {
    const { tasks } = await api.getTaskOverview();
    const t = (tasks || []).find((x) => !['completed', 'failed', 'cancelled'].includes(x.status));
    if (!t) { line.hidden = true; return; }
    const elapsed = formatElapsed(Date.now() - Date.parse(t.startedAt || t.createdAt));
    line.textContent = `${t.worker}${t.model ? ` · ${t.model}` : ''} · ${elapsed} · ${describeModelPhase(t)}`;
    line.hidden = false;
  } catch { line.hidden = true; } finally { liveTelemetryBusy = false; }
}
setInterval(() => { if (!document.hidden) void refreshLiveTelemetry(); }, 1500);

// Live story status while Tasks is open: real execution changes every few seconds.
setInterval(() => {
  if (document.querySelector('.app')?.dataset?.activeSurface === 'tasks' && !document.hidden) {
    void refreshDevStoriesPanel();
  }
}, 4000);

// Pandesh keeps the Home honest: the brief is re-read from Core on a slow
// cadence, so it never shows stale activity and never needs a manual refresh.
setInterval(() => {
  if (document.hidden) return;
  if (lastSnapshot?.coreState !== 'connected') return;
  void refreshAssistantBrief({ external: false });
}, 45000);
setInterval(() => {
  if (document.querySelector('.app')?.dataset?.activeSurface === 'tasks' && !document.hidden) void refreshActiveTasksPanel();
}, 2000);

function formatElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

const TASK_STATUS_LABEL = {
  created: 'Queued', pending: 'Queued', running: 'Running', validating: 'Checking',
  cancelling: 'Stopping…', cancelled: 'Stopped', completed: 'Completed', failed: 'Failed',
  waiting_for_approval: 'Waiting for your approval',
};

const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');

/**
 * Is a worker holding this task right now?
 *
 * A persisted `running` status is not proof of anything: an attempt whose
 * worker died stays `running` in the database forever. Core proves liveness
 * with the owning executor's lease (renewed by its heartbeat), so an unexpired
 * lease is the only evidence that work is actually happening.
 */
function taskIsLive(t) {
  if (typeof t.live === 'boolean') return t.live;
  const expires = t.leaseExpiresAt ? Date.parse(t.leaseExpiresAt) : NaN;
  return Number.isFinite(expires) && expires > Date.now();
}

/** The label the user reads: what is true about this task right now. */
function taskStatusLabel(t) {
  if (t.interrupted) return 'Interrupted';
  if (taskIsLive(t)) return TASK_STATUS_LABEL[t.status] || t.status;
  if (['completed', 'failed', 'cancelled'].includes(t.status)) return TASK_STATUS_LABEL[t.status] || t.status;
  if (t.status === 'waiting_for_approval') return 'Waiting for your approval';
  if (['created', 'pending', 'queued'].includes(t.status)) return 'Queued';
  return 'Not running';
}

/** One honest line about what the model is doing right now, from Core events + Ollama residency + the live token stream. */
function describeModelPhase(t) {
  const tel = t.telemetry;
  if (t.status === 'cancelling') return 'Stop requested — waiting for the worker to exit';
  // A task that is waiting for a decision is not thinking or generating: it is paused until the person answers.
  if (t.status === 'waiting_for_approval' || (lastSnapshot?.cockpit?.authState === 'pending' && lastSnapshot?.attemptId === t.attemptId)) {
    return 'Paused, waiting for your approval. Nothing runs until you decide.';
  }
  if (['created', 'pending'].includes(t.status)) return 'Queued — not started';
  // A persisted status is not proof of work. Without a live worker the only
  // honest thing to report is the last thing that actually happened.
  if (!taskIsLive(t)) {
    if (t.interrupted) return t.activity || 'Interrupted — this task is not running';
    return `Not running — last step: ${t.activity || 'none recorded'}`;
  }
  const now = Date.now();
  const since = (iso) => formatElapsed(now - Date.parse(iso));
  if (tel && tel.streamedChunks > 0) {
    const lastAgo = now - Date.parse(tel.lastTokenAt);
    const rate = tel.chunksPerSecond ? ` · ${tel.chunksPerSecond}/s` : '';
    return `Generating — ${tel.streamedChunks} chunks${rate} · first at ${clock(tel.firstTokenAt)} · last ${formatElapsed(lastAgo)} ago${lastAgo > 20000 ? ' (stalled or running a tool)' : ''}`;
  }
  const waited = since(t.lastEventAt || t.startedAt || t.createdAt);
  if (t.lastEventType && /^Running /.test(t.lastEventType)) return `${t.lastEventType} for ${waited}`;
  if (tel?.modelResident === false) return `Waiting ${waited} — model is not loaded in Ollama, so this request is loading it first (a 27B model can take 40 s+)`;
  if (tel?.modelResident === true) return `Waiting ${waited} for the first token — model is loaded${tel.gpuPercent != null ? ` (${tel.gpuPercent}% on GPU)` : ''}; reading the prompt / thinking`;
  return `Waiting ${waited} — no model output yet`;
}

/** Tasks screen: durable attempts straight from Core (model, worker, activity, elapsed, last event) plus waiting instructions. */
async function refreshActiveTasksPanel() {
  const panel = document.getElementById('active-tasks-panel');
  if (!panel || typeof api?.getTaskOverview !== 'function') return;
  let data;
  try { data = await api.getTaskOverview(); } catch { panel.hidden = true; return; }
  const tasks = data?.tasks || [];
  const queued = data?.queued || [];
  panel.hidden = tasks.length === 0 && queued.length === 0;
  if (panel.hidden) return;
  const live = tasks.filter((t) => taskIsLive(t));
  const stopped = tasks.filter((t) => !['completed', 'failed', 'cancelled'].includes(t.status) && !taskIsLive(t));
  const titleEl = document.getElementById('active-tasks-title');
  if (titleEl) {
    titleEl.textContent = live.length
      ? `Work in progress — ${live.length} running`
      : stopped.length
        ? `Not running — ${stopped.length} task${stopped.length === 1 ? '' : 's'} stopped`
        : 'Recent work';
  }
  const noteEl = document.getElementById('active-tasks-note');
  const noteParts = [];
  if (stopped.length) {
    noteParts.push(`${stopped.length} task${stopped.length === 1 ? ' was' : 's were'} interrupted and ${stopped.length === 1 ? 'is' : 'are'} not running.`);
  }
  if (queued.length) {
    noteParts.push(`${queued.length} instruction${queued.length > 1 ? 's' : ''} saved and waiting behind running work.`);
  }
  if (noteEl) noteEl.textContent = noteParts.join(' ');
  const ago = (iso) => { if (!iso) return 'no events yet'; const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000)); return s < 5 ? 'just now' : `${formatElapsed(s * 1000)} ago`; };
  const rows = tasks.map((t) => {
    const done = ['completed', 'failed', 'cancelled'].includes(t.status);
    const isLive = taskIsLive(t);
    const li = document.createElement('li');
    li.className = 'dev-story';
    li.dataset.phase = t.status === 'completed' ? 'done' : (done ? 'blocked' : isLive ? 'running' : 'interrupted');
    li.dataset.attemptId = t.attemptId;
    li.dataset.status = t.status;
    li.dataset.live = isLive ? 'true' : 'false';
    const head = document.createElement('div');
    head.className = 'dev-story-head';
    const title = document.createElement('strong');
    title.textContent = t.title || '(untitled request)';
    const meta = document.createElement('span');
    meta.className = 'muted';
    // Elapsed time only moves while the task actually moves: a stopped task
    // keeps the runtime it really had, not hours of imaginary runtime.
    const elapsed = done || !isLive
      ? Number(t.elapsedMs ?? 0)
      : Date.now() - Date.parse(t.startedAt || t.createdAt);
    meta.textContent = ` · ${taskStatusLabel(t)} · ${formatElapsed(elapsed)}`;
    head.append(title, meta);
    const detail = document.createElement('div');
    detail.className = 'muted dev-story-detail';
    detail.textContent = `${t.worker}${t.model ? ` · ${t.model}` : ''}`;
    const last = document.createElement('div');
    last.className = 'muted dev-story-detail';
    last.textContent = `Started ${clock(t.startedAt || t.createdAt)} · last event ${clock(t.lastEventAt)}: ${t.lastEventType || 'none'} (${ago(t.lastEventAt)})`;
    // The attempt id is technical detail: it is in the DOM, and it is only
    // shown while Details is open.
    const tech = document.createElement('div');
    tech.className = 'task-tech font-mono';
    tech.textContent = `Task ${t.attemptId}`;
    li.append(head, detail);
    if (!done) {
      const phase = document.createElement('div');
      phase.className = 'muted dev-story-detail task-phase';
      phase.textContent = describeModelPhase(t);
      li.append(phase);
    }
    li.append(last, tech);
    if (t.cancellable) {
      const stop = document.createElement('button');
      stop.type = 'button';
      stop.className = 'apex-chip task-stop-btn';
      stop.textContent = 'Stop';
      stop.setAttribute('aria-label', `Stop task ${t.title || t.attemptId}`);
      stop.addEventListener('click', async () => {
        stop.disabled = true;
        stop.textContent = 'Stopping…';
        try { await api.cancelTask(t.attemptId); } catch (err) { showOperationError(err); }
        finally { void refreshActiveTasksPanel(); void refresh(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(stop);
      li.append(row);
    }
    return li;
  });
  for (const q of queued) {
    const li = document.createElement('li');
    li.className = 'dev-story';
    li.dataset.phase = 'waiting';
    li.dataset.queuedId = q.id;
    const head = document.createElement('div');
    head.className = 'dev-story-head';
    const title = document.createElement('strong');
    title.textContent = q.title || q.instruction;
    const meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = q.status === 'confirming' ? ' · Queued instruction · waiting for your OK to start' : ' · Queued instruction · saved, not started';
    head.append(title, meta);
    li.append(head);
    if (q.status === 'confirming' && q.confirmationToken && typeof api.confirmCommandRun === 'function') {
      // Offered for a fresh confirmation (nothing starts by itself after a Stop): the person decides here.
      const run = document.createElement('button');
      run.type = 'button';
      run.className = 'apex-chip';
      run.textContent = 'Run now';
      run.addEventListener('click', async () => {
        run.disabled = true;
        try { await api.confirmCommandRun(q.id, q.confirmationToken, q.revision || 1); } catch (err) { showOperationError(err); }
        finally { void refreshActiveTasksPanel(); void refresh(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(run);
      li.append(row);
    }
    if (typeof api.skipCommand === 'function') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'apex-chip';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        remove.disabled = true;
        try { await api.skipCommand(q.id); } catch (err) { showOperationError(err); }
        finally { void refreshActiveTasksPanel(); }
      });
      const row = document.createElement('div');
      row.className = 'dev-story-approval';
      row.append(remove);
      li.append(row);
    }
    rows.push(li);
  }
  document.getElementById('active-tasks-list').replaceChildren(...rows);
}

async function refreshTasksMissionsView() {
  void refreshActiveTasksPanel();
  void refreshDevStoriesPanel();
  try {
    const artifacts = typeof api?.listArtifacts === 'function' ? await api.listArtifacts() : [];

    const dynamicList = document.getElementById('dynamic-missions-list');
    const empty = document.getElementById('tasks-empty');
    if (dynamicList) {
      dynamicList.replaceChildren(...artifacts.map((art) => buildResultCard(art)));
    }
    if (empty) empty.hidden = artifacts.length > 0;


    // 3. Pending approvals in Tasks & Missions
    const approvalsContainer = document.getElementById('tasks-approvals-container');
    const approvalsList = document.getElementById('tasks-approvals-list');
    const pendingAppr = lastSnapshot?.pendingApproval || lastSnapshot?.pendingImageApproval;
    if (approvalsContainer && approvalsList) {
      if (pendingAppr) {
        approvalsContainer.hidden = false;
        approvalsList.replaceChildren();
        const apprCard = document.createElement('article');
        apprCard.className = 'mission-card';
        apprCard.style.borderColor = '#f59e0b';
        apprCard.innerHTML = `
          <div class="mission-card-header">
            <div class="mission-badge-group">
              <span class="mission-status-badge status-waiting">Approval Required</span>
              <span class="mission-kind-badge">${pendingAppr.gate || 'MUTATION'}</span>
            </div>
          </div>
          <h4 class="mission-card-title">${pendingAppr.toolName || pendingAppr.presentation?.summary || 'Pending Action'}</h4>
          <p class="mission-card-desc">${pendingAppr.detail || 'Authorization required before proceeding.'}</p>
          <div class="mission-card-actions">
            <button type="button" class="apex-chip btn-task-approve" style="background:rgba(0,230,118,0.2); border-color:#00e676; color:#00e676;">Approve & Execute</button>
            <button type="button" class="apex-chip btn-task-reject" style="background:rgba(255,82,82,0.2); border-color:#ff5252; color:#ff5252;">Deny</button>
          </div>
        `;
        apprCard.querySelector('.btn-task-approve')?.addEventListener('click', () => {
          if (pendingAppr.approvalId) {
            if (lastSnapshot?.pendingImageApproval) {
              void api.resolveImageApproval(pendingAppr.approvalId, 'approved').then(() => refresh());
            } else {
              void api.resolveApproval(pendingAppr.approvalId, 'approved').then(() => refresh());
            }
          }
        });
        apprCard.querySelector('.btn-task-reject')?.addEventListener('click', () => {
          if (pendingAppr.approvalId) {
            if (lastSnapshot?.pendingImageApproval) {
              void api.resolveImageApproval(pendingAppr.approvalId, 'rejected').then(() => refresh());
            } else {
              void api.resolveApproval(pendingAppr.approvalId, 'rejected').then(() => refresh());
            }
          }
        });
        approvalsList.appendChild(apprCard);
      } else {
        approvalsContainer.hidden = true;
      }
    }
  } catch (err) {
    console.warn('Tasks & Missions probe failed', err);
  }
}

async function refreshIntegrationsView() {
  // 1. Mobile pairing
  try {
    if (typeof api?.getMobilePairing === 'function') {
      const pairInfo = await api.getMobilePairing();
      const pinEl = document.getElementById('integ-mobile-pin');
      const urlEl = document.getElementById('integ-mobile-url');
      const statusEl = document.getElementById('integ-mobile-status');
      if (pinEl) pinEl.textContent = pairInfo.code || '----';
      if (urlEl) urlEl.textContent = pairInfo.url || `http://${pairInfo.ip}:3030/?pair=${pairInfo.code}`;
      if (statusEl) {
        const liveCount = Number(pairInfo.connectedClients ?? pairInfo.pairedCount ?? 0);
        statusEl.textContent = liveCount > 0
          ? `${liveCount} device(s) connected`
          : 'Ready for pairing (Local Wi-Fi)';
      }
    }
  } catch (err) {
    console.warn('Mobile pairing probe failed', err);
  }

  // 2. Image Studio
  try {
    if (typeof api?.probeImageStudio === 'function') {
      const studioStatus = await api.probeImageStudio();
      const badgeEl = document.getElementById('integ-studio-badge');
      const checkpointsEl = document.getElementById('integ-studio-checkpoints');
      if (badgeEl) {
        if (studioStatus.studio && studioStatus.comfyui) {
          badgeEl.textContent = 'Ready (8989 + 8188)';
          badgeEl.className = 'int-badge online';
        } else if (studioStatus.comfyui) {
          badgeEl.textContent = 'ComfyUI Only (8188)';
          badgeEl.className = 'int-badge';
        } else {
          badgeEl.textContent = 'Offline (Auto-starts on job)';
          badgeEl.className = 'int-badge';
        }
      }
      if (checkpointsEl) {
        if (studioStatus.checkpoints && studioStatus.checkpoints.length > 0) {
          checkpointsEl.textContent = `${studioStatus.checkpoints.length} model(s) available (${studioStatus.checkpoints[0].name})`;
        } else {
          checkpointsEl.textContent = studioStatus.detail || 'Ready for generation requests';
        }
      }
    }
  } catch (err) {
    console.warn('Studio probe failed', err);
  }

  // 3. Hardware Telemetry
  try {
    if (typeof api?.getHostTelemetry === 'function') {
      const telem = await api.getHostTelemetry();
      const cpuEl = document.getElementById('integ-hw-cpu');
      const ramEl = document.getElementById('integ-hw-ram');
      const gpuEl = document.getElementById('integ-hw-gpu');
      if (cpuEl && telem.cpu) {
        cpuEl.textContent = `${telem.cpu.model || 'AMD Ryzen 9'} · ${telem.cpu.percent != null ? telem.cpu.percent + '%' : 'Idle'}`;
      }
      if (ramEl && telem.ram) {
        ramEl.textContent = `${telem.ram.usedGb || 0} GB used / ${telem.ram.totalGb || 64} GB total`;
      }
      if (gpuEl && telem.gpu) {
        const vramUsed = telem.gpu.vramUsedMb ? (telem.gpu.vramUsedMb / 1024).toFixed(1) : '0';
        const vramTotal = telem.gpu.vramTotalMb ? (telem.gpu.vramTotalMb / 1024).toFixed(0) : '24';
        gpuEl.textContent = `${telem.gpu.model || 'NVIDIA RTX 3090'} · ${vramUsed}/${vramTotal} GB VRAM`;
      }
    }
  } catch (err) {
    console.warn('Telemetry probe failed', err);
  }
}

// Wire sidebar navigation items
document.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    const target = btn.getAttribute('data-surface');
    if (target) switchSurface(target);
  });
});

// Panda Workspace: the rail brand returns to the assistant, the context panel
// can be dismissed, and a delivered result can be previewed in place.
document.getElementById('rail-brand')?.addEventListener('click', () => switchSurface('assistant'));
workspaceContextClose?.addEventListener('click', () => {
  if (workspaceContext) workspaceContext.hidden = true;
});
conversationResultsList?.addEventListener('click', (event) => {
  const target = event.target;
  if (!target || typeof target.closest !== 'function') return;
  const card = target.closest('.result-card');
  const artifactId = card?.dataset?.artifactId;
  if (!artifactId) return;
  // The action buttons inside a result card do their own thing.
  if (target.closest('button')) return;
  void showContextPreview(artifactId);
});

// The suggested activities on Home fill the composer with a real request.
document.querySelectorAll('.ws-suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-prompt');
    if (!prompt || !taskInput) return;
    taskInput.value = prompt;
    taskInput.focus();
    taskInput.setSelectionRange(prompt.length, prompt.length);
  });
});

// The "+" in the composer opens the same real attachment picker.
document.getElementById('composer-attach-plus-btn')?.addEventListener('click', () => {
  document.getElementById('composer-attach-btn')?.click();
});

// Search in the header focuses the real conversation search field.
document.getElementById('btn-workspace-search')?.addEventListener('click', () => {
  const layout = document.getElementById('assistant-layout');
  if (layout?.dataset.history === 'closed') document.getElementById('btn-toggle-history')?.click();
  switchSurface('assistant');
  void refreshConversationsRail();
  conversationsSearch?.focus();
});

// The result card's actions are real: open the folder, or see every task.
conversationResultsOpen?.addEventListener('click', () => switchSurface('tasks'));
document.getElementById('conversation-results-all')?.addEventListener('click', () => {
  void api.openWorkspaceFolder?.().catch(showOperationError);
});

// The elapsed time on the inline task card ticks from the real start time.
setInterval(() => {
  if (!workspaceTaskCard || workspaceTaskCard.hidden) return;
  updateTaskCardElapsed(lastSnapshot);
}, 1000);

// Wire Home Prompt Suggestions
document.querySelectorAll('.home-suggestion-chip').forEach((chip) => {
  chip.addEventListener('click', () => {
    const prompt = chip.getAttribute('data-prompt');
    if (prompt && taskInput) {
      taskInput.value = prompt;
      submit.click();
    }
  });
});

// Wire Integration Card Action Buttons
document.getElementById('btn-copy-mobile-link')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-copy-mobile-link');
  const urlEl = document.getElementById('integ-mobile-url');
  const textToCopy = urlEl?.textContent?.trim() || '';
  if (!textToCopy) return;

  let copied = false;
  if (typeof api?.copyToClipboard === 'function') {
    try {
      const res = await api.copyToClipboard(textToCopy);
      copied = Boolean(res?.copied);
    } catch (e) {
      console.warn('IPC copy failed', e);
    }
  }
  if (!copied && navigator?.clipboard) {
    try {
      await navigator.clipboard.writeText(textToCopy);
      copied = true;
    } catch (e) {
      console.warn('navigator.clipboard failed', e);
    }
  }

  if (copied && btn) {
    const orig = btn.textContent;
    btn.textContent = 'Copied! ✓';
    setTimeout(() => {
      btn.textContent = orig;
    }, 2000);
  }
});

document.getElementById('btn-open-mobile-browser')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-open-mobile-browser');
  const urlEl = document.getElementById('integ-mobile-url');
  const url = urlEl?.textContent?.trim();
  if (url && typeof api?.openExternalUrl === 'function') {
    const orig = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Opening…';
    try {
      await api.openExternalUrl(url);
    } catch (err) {
      console.error('Failed to open mobile companion in browser:', err);
    } finally {
      if (btn) setTimeout(() => { btn.textContent = orig; }, 1000);
    }
  }
});

document.getElementById('btn-launch-image-studio')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-launch-image-studio');
  if (typeof api?.openExternalUrl === 'function') {
    const orig = btn ? btn.textContent : '';
    if (btn) btn.textContent = 'Opening Studio…';
    try {
      await api.openExternalUrl('http://127.0.0.1:8989/');
    } catch (err) {
      console.error('Failed to open Image Studio in browser:', err);
    } finally {
      if (btn) setTimeout(() => { btn.textContent = orig; }, 1000);
    }
  }
});

document.getElementById('btn-refresh-integrations')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-integrations');
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = 'Refreshing…';
    btn.disabled = true;
  }
  try {
    await refreshIntegrationsView();
    if (btn) btn.textContent = 'Refreshed ✓';
  } catch (err) {
    console.error('Failed to refresh integrations:', err);
    if (btn) btn.textContent = 'Error refreshing';
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    }
  }
});

let currentTasksSubtab = 'tasks';

function switchTasksSubtab(tab) {
  currentTasksSubtab = tab;
  const btnTasks = document.getElementById('btn-tasks-tab-tasks');
  const btnResults = document.getElementById('btn-tasks-tab-results');
  const paneTasks = document.getElementById('tasks-pane-tasks');
  const paneResults = document.getElementById('tasks-pane-results');
  if (btnTasks) {
    btnTasks.classList.toggle('is-active', tab === 'tasks');
    btnTasks.setAttribute('aria-selected', tab === 'tasks' ? 'true' : 'false');
  }
  if (btnResults) {
    btnResults.classList.toggle('is-active', tab === 'results');
    btnResults.setAttribute('aria-selected', tab === 'results' ? 'true' : 'false');
  }
  if (paneTasks) paneTasks.hidden = tab !== 'tasks';
  if (paneResults) paneResults.hidden = tab !== 'results';
}

document.getElementById('btn-tasks-tab-tasks')?.addEventListener('click', () => switchTasksSubtab('tasks'));
document.getElementById('btn-tasks-tab-results')?.addEventListener('click', () => switchTasksSubtab('results'));

document.getElementById('btn-refresh-tasks')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-tasks');
  const orig = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = 'Refreshing…';
    btn.disabled = true;
  }
  try {
    await refreshTasksMissionsView();
    if (btn) btn.textContent = 'Refreshed ✓';
  } catch (err) {
    console.error('Failed to refresh tasks:', err);
    if (btn) btn.textContent = 'Error refreshing';
  } finally {
    if (btn) {
      setTimeout(() => {
        btn.textContent = orig;
        btn.disabled = false;
      }, 1500);
    }
  }
});

document.getElementById('btn-export-conv')?.addEventListener('click', () => {
  conversationExport?.click();
});


/** ══════════════════════════════════════════════════════════════════
 *  ONE ASSISTANT WORKSPACE
 *  Home and Conversations are a single surface: a large mascot while idle,
 *  a compact one in the header once a conversation is under way. Results,
 *  approvals and progress live in the same conversation; technical details
 *  stay behind the optional Details view.
 *  ══════════════════════════════════════════════════════════════════ */

function assistantConversationActive() {
  const isExplicitlyNew = !viewingConversationId && !lastSnapshot?.selectedConversationId;
  const hasTurns = Boolean(result && !result.hidden && result.childElementCount > 0);
  const s = lastSnapshot;
  if (isExplicitlyNew && !s?.running) {
    // Only consider active if the user has already sent an optimistic turn
    return Boolean(hasTurns && result?.querySelector('[data-live-echo="1"]'));
  }
  return hasTurns || Boolean(s?.running || s?.pendingApproval || s?.pendingImageApproval);
}

function syncAssistantMode() {
  const main = document.getElementById('assistant-main');
  if (!main) return;
  const active = assistantConversationActive();
  const mode = active ? 'active' : 'idle';
  const changed = main.dataset.mode !== mode;
  if (changed) main.dataset.mode = mode;
  if (appRoot && appRoot.dataset.assistantMode !== mode) appRoot.dataset.assistantMode = mode;

  // The Home opens at its top: the panda welcome first, then what needs
  // attention. A conversation opens at its newest line instead.
  if (changed && !active) main.scrollTop = 0;

  // One mascot element (ids and bindings preserved): large when idle, compact in the header when active.
  const anchor = document.getElementById('panda-hero-anchor');
  const slot = document.getElementById(active ? 'assistant-mascot-slot' : 'assistant-hero-slot');
  if (anchor && slot && anchor.parentElement !== slot) slot.appendChild(anchor);

  const titleEl = document.getElementById('conv-active-title');
  if (titleEl) {
    const id = viewingConversationId || lastSnapshot?.selectedConversationId || null;
    const entry = id ? conversationsRailCache.find((c) => c.id === id) : null;
    const title = active ? (entry?.title?.trim() || (lastSnapshot?.task ? String(lastSnapshot.task).slice(0, 80) : 'Conversation')) : 'New conversation';
    if (titleEl.textContent !== title) titleEl.textContent = title;
  }
}

/** Selected model vs. the model that is actually executing, never conflated. */
function renderModelAttribution(snapshot = lastSnapshot) {
  const pill = document.getElementById('conv-model-badge');
  if (!pill || !snapshot) return;
  const lastBadge = result ? [...result.querySelectorAll('.transcript-model-badge')].pop() : null;
  const lastUsed = lastBadge?.textContent?.trim() || '';
  const selectedLabel = snapshot.provider === 'openrouter' && !snapshot.running
    ? (snapshot.model || 'OpenRouter')
    : snapshot.modelIsAuto ? 'Auto' : (snapshot.model || modelSelect?.value || 'unresolved');
  let text;
  let tip;
  if (snapshot.running && snapshot.model && snapshot.modelNote) {
    text = `Running on ${snapshot.model} · chosen for your image`;
    tip = snapshot.modelNote;
  } else if (snapshot.running && snapshot.model) {
    text = snapshot.modelIsAuto ? `Running on ${snapshot.model} · picked by Auto` : `Running on ${snapshot.model}`;
    tip = snapshot.modelIsAuto
      ? `You selected Auto. Panda chose ${snapshot.model} for this request.`
      : `You selected ${snapshot.model}, and it is the model answering now.`;
  } else if (snapshot.modelIsAuto) {
    text = lastUsed ? `Auto · last reply by ${lastUsed}` : 'Auto · picks per request';
    tip = lastUsed
      ? `Model choice is set to Auto. The last reply in this conversation was written by ${lastUsed}.`
      : 'Model choice is set to Auto. Panda will pick a model for each request.';
  } else {
    text = lastUsed && lastUsed !== selectedLabel ? `${selectedLabel} · last reply by ${lastUsed}` : selectedLabel;
    tip = lastUsed && lastUsed !== selectedLabel
      ? `Selected for the next message: ${selectedLabel}. The last reply was written by ${lastUsed}.`
      : `Selected model: ${selectedLabel}.`;
  }
  if (pill.textContent !== text) pill.textContent = text;
  pill.title = tip;
  pill.dataset.running = snapshot.running ? 'true' : 'false';
  const modelsBadge = document.getElementById('integ-models-badge');
  if (modelsBadge) {
    const count = snapshot.installedModels?.length ?? 0;
    const ready = snapshot.coreState === 'connected' && count > 0 && snapshot.modelAvailable !== false;
    modelsBadge.textContent = snapshot.coreState !== 'connected' ? 'Core offline' : count === 0 ? 'No models found' : snapshot.modelAvailable === false ? 'Selected model missing' : `Ollama · ${count} model${count === 1 ? '' : 's'}`;
    modelsBadge.className = `int-badge${ready ? ' online' : ' warn'}`;
  }
  const integ = document.getElementById('integ-model-active');
  if (integ) integ.textContent = snapshot.modelIsAuto ? 'Auto (per request)' : (snapshot.model || 'unresolved');
  if (modelSelect) modelSelect.title = 'Model for your next message. Auto lets Panda pick for each request. The header shows which model is actually answering.';
}

function updateComposerStatus() {
  const el = document.getElementById('composer-status');
  if (!el) return;
  const s = lastSnapshot;
  let text = 'Ready';
  let state = 'idle';
  if (s?.awaitingApproval || s?.pendingApproval || s?.pendingImageApproval || s?.pendingWeatherApproval) {
    text = 'Waiting for your approval'; state = 'approval';
  } else if (jarvisUiState === 'listening' || jarvisUiState === 'capturing') {
    text = 'Listening…'; state = 'listening';
  } else if (jarvisUiState === 'processing') {
    text = 'Transcribing…'; state = 'working';
  } else if (jarvisUiState === 'speaking') {
    text = 'Speaking…'; state = 'speaking';
  } else if (s?.running) {
    let line = '';
    try { line = humanProgressSentence(s) || ''; } catch { line = ''; }
    text = line ? line.replace(/\s+/g, ' ').slice(0, 110) : 'Working…'; state = 'working';
  } else if (jarvisUiState === 'failed') {
    text = 'That did not finish — details are in the conversation'; state = 'failed';
  }
  if (el.textContent !== text) el.textContent = text;
  el.dataset.state = state;
}

/* ══════════════════════════════════════════════════════════════════════
 * PANDA WORKSPACE
 *
 * The approved Panda Workspace direction: a small panda presence with real
 * activity indicators, an inline task card that shows the true state of the
 * running work (status, elapsed time, Stop), and a contextual panel for the
 * delivered files, previews and results of the conversation.
 *
 * Everything here is a projection of state the host already reported — the
 * mission cockpit, the snapshot, the activity events. Nothing is invented and
 * nothing is faked: when there is no task, the task card is hidden.
 * ══════════════════════════════════════════════════════════════════════ */

/** Which panda picture and label match each real runtime state. */
const PANDA_PRESENCE = {
  idle: { src: 'assets/panda/mascot-idle.webp', label: 'Ready' },
  listening: { src: 'assets/panda/mascot-idle.webp', label: 'Listening…' },
  thinking: { src: 'assets/panda/mascot-thinking.webp', label: 'Thinking…' },
  executing: { src: 'assets/panda/mascot-working.webp', label: 'Working…' },
  validating: { src: 'assets/panda/mascot-working.webp', label: 'Validating…' },
  recovering: { src: 'assets/panda/mascot-working.webp', label: 'Recovering…' },
  creating: { src: 'assets/panda/mascot-working.webp', label: 'Creating…' },
  waiting_for_approval: { src: 'assets/panda/action-approval.webp', label: 'Needs your approval' },
  completed: { src: 'assets/panda/mascot-done.webp', label: 'Done' },
  failed: { src: 'assets/panda/action-failed.webp', label: 'Needs attention' },
  speaking: { src: 'assets/panda/mascot-excited.webp', label: 'Speaking…' },
};

/** The badge on the header panda: what Panda is doing right now. */
const PANDA_ACTIVITY_BADGE = [
  { match: /code|write|edit|patch|implement|refactor/, src: 'assets/panda/action-coding.webp' },
  { match: /read|search|repo|file|inspect|list|find/, src: 'assets/panda/action-reading.webp' },
  { match: /check|test|validat|verify|build/, src: 'assets/panda/action-testing.webp' },
  { match: /review|audit/, src: 'assets/panda/action-reviewing.webp' },
  { match: /delegat|spawn|handoff/, src: 'assets/panda/action-delegating.webp' },
  { match: /think|plan|reason/, src: 'assets/panda/action-thinking.webp' },
];

/** Fine-grained presence states collapse into the presence the user reads. */
function normalizePresence(rawState) {
  switch (rawState) {
    case 'thinking': return 'thinking';
    case 'executing':
    case 'coding':
    case 'testing':
    case 'reading':
    case 'searching':
    case 'building':
    case 'delegating':
    case 'reviewing':
      return 'executing';
    case 'validating': return 'validating';
    case 'recovering': return 'recovering';
    case 'creating': return 'creating';
    case 'waiting_for_approval': return 'waiting_for_approval';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'listening': return 'listening';
    case 'speaking': return 'speaking';
    default: return 'idle';
  }
}

/** The presence the runtime actually reports (the header mascot's own state). */
function currentPresenceState() {
  const reactor = document.getElementById('jarvis-core-reactor');
  return normalizePresence(reactor?.dataset?.presence || 'idle');
}

/** How many results the current conversation has delivered (for the context panel). */
let conversationResultCount = 0;
/** The artifact whose preview is open in the context panel. */
let contextPreviewArtifactId = null;

function renderWorkspace(snapshot) {
  const presence = currentPresenceState();
  const info = PANDA_PRESENCE[presence] ?? PANDA_PRESENCE.idle;

  if (pandaPresence && pandaPresence.dataset.state !== presence) {
    pandaPresence.dataset.state = presence;
  }
  if (pandaPresenceLabel && pandaPresenceLabel.textContent !== info.label) {
    pandaPresenceLabel.textContent = info.label;
  }

  // Pandesh's five simple presence states: ready, working, awaiting approval,
  // completed and error. They are derived from the real Core state — never set
  // by a timer or a decoration.
  const simple = simplePandaPresence(presence);
  if (appRoot && appRoot.dataset.pandaPresence !== simple) {
    appRoot.dataset.pandaPresence = simple;
  }
  if (pandaPresence && pandaPresence.dataset.simple !== simple) {
    pandaPresence.dataset.simple = simple;
  }

  // The header panda carries a badge for the activity it is doing right now.
  const actionTitle = String(snapshot?.cockpit?.currentAction?.title || '').toLowerCase();
  const badge = PANDA_ACTIVITY_BADGE.find((entry) => entry.match.test(actionTitle));
  if (pandaActionBadge) {
    if (badge && snapshot?.running) {
      if (pandaActionBadge.getAttribute('src') !== badge.src) pandaActionBadge.src = badge.src;
      pandaActionBadge.hidden = false;
    } else if (!pandaActionBadge.hidden) {
      pandaActionBadge.hidden = true;
    }
  }

  // The identity line in the header: what is running, and where. When the
  // Core is not answering the line says so in plain words and offers the one
  // action that can fix it — no internal counters, no backoff figures.
  if (brandStatusText) {
    const connection = snapshot?.coreState;
    const connected = connection === 'connected';
    const local = snapshot?.provider !== 'openrouter';
    const text = connected
      ? (local ? 'Local AI · Connected' : 'Cloud AI · Connected')
      : connection === 'reconnecting' || connection === 'starting'
        ? 'Local AI · Reconnecting…'
        : 'Local AI · Not connected';
    if (brandStatusText.textContent !== text) brandStatusText.textContent = text;
  }
  if (coreRetryButton) {
    // The button is offered while the Core is being chased and whenever it is
    // gone. Pressing it is always safe: it re-launches the Core if it is
    // gone, or reopens the stream if it is there.
    const show = snapshot?.coreState === 'disconnected' || snapshot?.coreState === 'unavailable'
      || snapshot?.coreState === 'reconnecting'
      || snapshot?.coreState === 'authentication_failed' || snapshot?.coreState === 'incompatible'
      || snapshot?.coreState === 'database_failed';
    if (coreRetryButton.hidden === show) coreRetryButton.hidden = !show;
  }
  if (composerProviderName) {
    const provider = snapshot?.provider ?? 'ollama';
    const text = provider === 'openrouter' ? 'Cloud' : provider === 'cloud' ? 'Free cloud' : 'Local';
    if (composerProviderName.textContent !== text) composerProviderName.textContent = text;
  }

  renderWorkspaceTaskCard(snapshot, presence);
  renderWorkspaceContext(snapshot);
  // A task card or an approval card may have just appeared: keep the newest
  // thing in view.
  scrollConversationToEnd();
}

/** The inline task card: the true state of the running work, with Stop. */
function renderWorkspaceTaskCard(snapshot, presence) {
  if (!workspaceTaskCard) return;
  const cockpit = snapshot?.cockpit;
  const running = Boolean(snapshot?.running);
  const outcome = snapshot?.lastTurnOutcome ?? null;
  const hasTask = Boolean(snapshot?.attemptId) && (running || outcome || cockpit?.terminal);
  // A finished task that delivered results is represented by the result card;
  // the task card would only repeat it. A failed task keeps its card.
  const finishedWithResults = !running && outcome === 'completed' && conversationResultCount > 0;
  // The task card belongs to exactly one conversation. It is shown in that
  // conversation, and while a turn is in flight — never in a fresh, empty
  // conversation, where an earlier task's card would be projected as if it
  // were the current work.
  const taskConversationId = snapshot?.activeConversationId ?? null;
  const viewedConversationId = viewingConversationId;
  const inViewedConversation = viewedConversationId
    ? taskConversationId === viewedConversationId
    : Boolean(running);
  workspaceTaskCard.hidden = !hasTask || finishedWithResults || !inViewedConversation;
  if (workspaceTaskCard.hidden) return;

  const awaitingApproval = Boolean(snapshot?.awaitingApproval || snapshot?.pendingApproval || snapshot?.cockpit?.pendingApproval);
  workspaceTaskCard.dataset.state = awaitingApproval ? 'waiting_for_approval' : presence;

  // The card is titled with the real request, not a decoration.
  const goal = String(snapshot?.task || '').trim();
  const titleText = goal ? goal.slice(0, 90) : (awaitingApproval ? 'Waiting for approval' : (presence === 'completed' ? 'Task complete' : 'Working'));
  if (taskCardTitle && taskCardTitle.textContent !== titleText) taskCardTitle.textContent = titleText;

  const worker = snapshot?.selectedWorker || snapshot?.activeWorker || 'local';
  const workerLabel = String(worker).replace(/[-_]/g, ' ');
  const changed = cockpit?.filesChanged?.length ?? 0;
  const scope = snapshot?.taskScope?.repository
    ? collapsePath(snapshot.taskScope.repository)
    : (snapshot?.folder ? collapsePath(snapshot.folder) : 'Local workspace');
  const metaText = `${workerLabel} · ${scope}`;
  if (taskCardMeta && taskCardMeta.textContent !== metaText) taskCardMeta.textContent = metaText;

  renderTaskCardSteps(cockpit, running, awaitingApproval);
  updateTaskCardElapsed(snapshot);
  syncTaskCardStop();
}

/** The real activity events, newest last, exactly as the runtime reported them. */
function renderTaskCardSteps(cockpit, running, awaitingApproval = false) {
  if (!taskCardSteps) return;
  let checkpoints = (cockpit?.checkpoints ?? []).slice(-5);
  if (awaitingApproval) {
    checkpoints = checkpoints.filter((item) => item.title !== 'Mission completed');
  }
  const signature = `${running}|${awaitingApproval}|${checkpoints.map((item) => `${item.title}|${item.outcome ?? ''}`).join('~')}`;
  if (taskCardSteps.dataset.signature === signature) return;
  taskCardSteps.dataset.signature = signature;
  taskCardSteps.replaceChildren(...checkpoints.map((item, index) => {
    const row = document.createElement('li');
    const isLast = index === checkpoints.length - 1;
    if (item.outcome) row.dataset.outcome = item.outcome;
    else if (isLast && running) row.dataset.outcome = 'active';
    const label = document.createElement('span');
    // The title is the human step ("Read notes.txt", "AI response"). The raw
    // detail can carry internal attempt ids, so it stays out of the card.
    label.textContent = item.title;
    row.appendChild(label);
    return row;
  }));
}

/** Elapsed time, ticked from the attempt's real start time. */
function updateTaskCardElapsed(snapshot) {
  if (!taskCardElapsed) return;
  const cockpit = snapshot?.cockpit;
  const startedAt = cockpit?.startedAt ? Date.parse(cockpit.startedAt) : NaN;
  const elapsed = Number.isFinite(startedAt)
    ? Math.max(0, Date.now() - startedAt)
    : Number(cockpit?.elapsedMs ?? 0);
  const text = formatClock(elapsed);
  if (taskCardElapsed.textContent !== text) taskCardElapsed.textContent = text;
}

/** The card's Stop mirrors the composer's Stop, truthfully. */
function syncTaskCardStop() {
  if (!taskCardStop) return;
  const running = Boolean(lastSnapshot?.running);
  taskCardStop.hidden = !running;
  taskCardStop.disabled = !running;
  const label = taskCardStop.querySelector('span');
  const text = stopRequestedNotConfirmed ? 'Stop again' : 'Stop';
  if (label && label.textContent !== text) label.textContent = text;
}

/** The contextual panel: delivered files and previews beside the conversation. */
function renderWorkspaceContext(snapshot) {
  if (!workspaceContext) return;
  const changed = snapshot?.cockpit?.filesChanged ?? [];
  if (contextDelivered) {
    const signature = changed.join('|');
    if (contextDelivered.dataset.signature !== signature) {
      contextDelivered.dataset.signature = signature;
      contextDelivered.replaceChildren(...changed.map((path) => {
        const row = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'context-file-name';
        name.textContent = collapsePath(path);
        name.title = path;
        const open = document.createElement('button');
        open.type = 'button';
        open.className = 'context-file-open';
        open.textContent = 'Open';
        open.addEventListener('click', () => { void api.openWorkspaceFile?.(path).catch(showOperationError); });
        row.append(name, open);
        return row;
      }));
    }
  }
  if (contextDeliveredEmpty) contextDeliveredEmpty.hidden = changed.length > 0;
  updateContextPanelVisibility();
}

/** The panel is only there when it has something real to show. */
function updateContextPanelVisibility() {
  if (!workspaceContext) return;
  const changed = lastSnapshot?.cockpit?.filesChanged?.length ?? 0;
  const hasPreview = Boolean(contextPreviewArtifactId);
  workspaceContext.hidden = !(changed > 0 || hasPreview);
}

/** Preview a delivered result inside the context panel. */
async function showContextPreview(artifactId) {
  if (!contextPreview || typeof api?.loadArtifactPreview !== 'function') return;
  contextPreviewArtifactId = artifactId;
  contextPreviewSection.hidden = false;
  contextPreview.replaceChildren();
  const loading = document.createElement('div');
  loading.className = 'context-preview-title';
  loading.textContent = 'Loading preview…';
  contextPreview.appendChild(loading);
  try {
    const preview = await api.loadArtifactPreview(artifactId);
    if (contextPreviewArtifactId !== artifactId) return;
    contextPreview.replaceChildren();
    if (preview?.fileUrl) {
      const video = document.createElement('video');
      video.controls = true;
      video.loop = true;
      video.preload = 'metadata';
      video.src = preview.fileUrl;
      contextPreview.appendChild(video);
    } else if (preview?.dataUrl) {
      const img = document.createElement('img');
      img.src = preview.dataUrl;
      img.alt = preview?.artifact?.title || 'Result preview';
      contextPreview.appendChild(img);
    }
    const title = document.createElement('div');
    title.className = 'context-preview-title';
    title.textContent = preview?.artifact?.title || 'Preview';
    contextPreview.appendChild(title);
    const actions = document.createElement('div');
    actions.className = 'context-preview-actions';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'apex-chip';
    open.textContent = 'Open';
    open.addEventListener('click', () => { void api.openArtifactFile?.(artifactId).catch(showOperationError); });
    const folder = document.createElement('button');
    folder.type = 'button';
    folder.className = 'apex-chip';
    folder.textContent = 'Show in folder';
    folder.addEventListener('click', () => { void api.openArtifactFolder?.(artifactId).catch(showOperationError); });
    actions.append(open, folder);
    contextPreview.appendChild(actions);
  } catch (err) {
    if (contextPreviewArtifactId !== artifactId) return;
    contextPreview.replaceChildren();
    const note = document.createElement('div');
    note.className = 'context-preview-title';
    note.textContent = `Preview unavailable: ${err?.message ?? err}`;
    contextPreview.appendChild(note);
  }
  updateContextPanelVisibility();
}

/** The conversation column scrolls on its own, so follow the newest line —
 *  unless the user has deliberately scrolled up to read something. */
let lastConversationScrollHeight = 0;
function scrollConversationToEnd(force = false) {
  const main = document.getElementById('result');
  if (!main) return;
  const grew = main.scrollHeight - lastConversationScrollHeight > 2;
  lastConversationScrollHeight = main.scrollHeight;
  if (!force) {
    const distance = main.scrollHeight - main.scrollTop - main.clientHeight;
    // Follow what just arrived, or stay with the user when they scrolled up.
    if (!grew && distance > 120) return;
  }
  main.scrollTop = main.scrollHeight;
}

/** The small panda mark that sits beside Pandesh's own lines. */
function pandaGlyphSvg(className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('viewBox', '0 0 220 220');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#panda-head');
  svg.appendChild(use);
  return svg;
}

/** Results (images, video, documents) made in the conversation being viewed. */
let conversationResultsSignature = '';
async function refreshConversationResults() {
  const box = document.getElementById('conversation-results');
  const list = document.getElementById('conversation-results-list');
  if (!box || !list || typeof api?.listArtifacts !== 'function') return;
  // Only the conversation being viewed contributes results. A new, empty
  // conversation has none — an earlier conversation's deliverables must not be
  // projected onto it (they stay in their own conversation and in Tasks).
  const convId = viewingConversationId;
  let items = [];
  try {
    if (convId) items = (await api.listArtifacts()).filter((a) => a.conversationId === convId);
  } catch { items = []; }
  const signature = `${convId}|${items.map((a) => `${a.id}:${a.availability}`).join(',')}`;
  if (signature === conversationResultsSignature) return;
  conversationResultsSignature = signature;
  conversationResultCount = items.length;
  box.hidden = items.length === 0;
  list.replaceChildren(...items.slice(0, 12).map((art) => buildResultCard(art, { compact: true })));
  renderResultCardMeta(items, convId);
  updateContextPanelVisibility();
  scrollConversationToEnd();
  // The task card yields to the result card once the turn delivered something.
  if (lastSnapshot) renderWorkspace(lastSnapshot);
}

/** The result card's headline: what was delivered, and what it touched. */
function renderResultCardMeta(items, convId) {
  const entry = convId ? conversationsRailCache.find((c) => c.id === convId) : null;
  const title = String(lastSnapshot?.task || entry?.title || 'Results').trim().slice(0, 90);
  if (conversationResultsTitle && conversationResultsTitle.textContent !== title) {
    conversationResultsTitle.textContent = title;
  }
  const changed = lastSnapshot?.cockpit?.filesChanged?.length ?? 0;
  const filesText = changed > 0
    ? `Project files · ${changed}`
    : items.length > 0 ? `Generated files · ${items.length}` : 'No files';
  if (conversationResultsFiles && conversationResultsFiles.textContent !== filesText) {
    conversationResultsFiles.textContent = filesText;
  }
  // The preview is the first image the conversation actually produced.
  const image = items.find((art) => art.kind === 'image' && art.availability === 'ready');
  if (!conversationResultsPreview) return;
  const current = conversationResultsPreview.dataset.artifactId ?? '';
  const wanted = image?.id ?? '';
  if (current === wanted) return;
  conversationResultsPreview.dataset.artifactId = wanted;
  conversationResultsPreview.replaceChildren();
  if (!image) return;
  const label = document.createElement('span');
  label.className = 'result-preview-label';
  label.textContent = 'Preview';
  conversationResultsPreview.appendChild(label);
  if (typeof api?.loadArtifactPreview !== 'function') return;
  void api.loadArtifactPreview(image.id).then((preview) => {
    if (conversationResultsPreview?.dataset.artifactId !== image.id) return;
    if (!preview?.dataUrl) return;
    const img = document.createElement('img');
    img.src = preview.dataUrl;
    img.alt = image.title || 'Generated preview';
    conversationResultsPreview.appendChild(img);
  }).catch(() => { /* the card stays without a preview */ });
}

/* ══════════════════════════════════════════════════════════════════════
 * PANDESH — THE PERSONAL ASSISTANT
 *
 * Home shows at most three things that genuinely need the operator, and only
 * when there is something real to say. Every card names the source it came
 * from, carries the state that source recorded, and offers only the actions
 * the runtime actually supports. When there is nothing to show, the calm
 * panda welcome stays exactly as it is — no invented cards, no stale
 * activity, no separate dashboard.
 * ══════════════════════════════════════════════════════════════════════ */

let assistantBrief = null;
let assistantBriefBusy = false;
let assistantBriefExternal = false;
let assistantBriefTimer = 0;
let assistantRoutine = null;

/** The five simple presence states Pandesh actually shows. */
const PANDA_SIMPLE_PRESENCE = {
  ready: { label: 'Ready', tone: 'ready' },
  working: { label: 'Working…', tone: 'working' },
  awaiting_approval: { label: 'Needs your approval', tone: 'approval' },
  completed: { label: 'Done', tone: 'done' },
  error: { label: 'Needs attention', tone: 'error' },
};

/** Collapses the runtime's fine-grained states into the five the panda shows. */
function simplePandaPresence(rawState) {
  switch (rawState) {
    case 'waiting_for_approval': return 'awaiting_approval';
    case 'completed': return 'completed';
    case 'failed': return 'error';
    case 'idle':
    case 'listening':
    case 'speaking': return 'ready';
    default: return 'working';
  }
}

/** Reads Core's brief. `external` also reads the live calendar and mailbox. */
async function refreshAssistantBrief(options = {}) {
  if (typeof api?.getAssistantBrief !== 'function') return null;
  const external = options.external === true;
  if (assistantBriefBusy && !external) return assistantBrief;
  assistantBriefBusy = true;
  try {
    const brief = await api.getAssistantBrief({ external });
    assistantBrief = brief;
    assistantBriefExternal = external;
    renderAssistantHome(brief);
    return brief;
  } catch (err) {
    // The Core may simply not be connected yet. That is not a fact about the
    // operator's day, so the Home stays calm and asks again once the Core is
    // there.
    if (/not connected/i.test(err?.message ?? '')) {
      renderAssistantHomeUnavailable(null);
      return null;
    }
    renderAssistantHomeUnavailable(err);
    return null;
  } finally {
    assistantBriefBusy = false;
  }
}

/** Debounced refresh, so a burst of events does not hammer Core. */
function scheduleAssistantBriefRefresh(external = false) {
  window.clearTimeout(assistantBriefTimer);
  assistantBriefTimer = window.setTimeout(() => {
    void refreshAssistantBrief({ external });
  }, external ? 900 : 400);
}

/** What genuinely needs the operator. Everything else on the Home is quiet history. */
const ACTIONABLE_BRIEF_KINDS = new Set(['approval', 'task_failed', 'task_interrupted']);

/** Recent: one compact line per running or finished task, with its real Open action. Hidden inside a conversation. */
function renderAssistantRecent(items) {
  const section = document.getElementById('home-recent');
  const list = document.getElementById('home-recent-list');
  if (!section || !list) return;
  section.hidden = items.length === 0;
  list.replaceChildren(...items.map((item) => {
    const row = document.createElement('div');
    row.className = 'ws-recent-row';
    row.dataset.state = item.state;
    const text = document.createElement('span');
    text.className = 'ws-recent-text';
    text.textContent = `${item.title} · ${item.detail}`;
    text.title = item.detail;
    row.appendChild(text);
    for (const action of (item.actions || []).filter((a) => a && (a.kind === 'open_conversation' || a.kind === 'open_artifact')).slice(0, 1)) {
      row.appendChild(buildBriefActionButton(action));
    }
    return row;
  }));
}

/** The Home: Pandesh's attention, then today's brief. */
function renderAssistantHome(brief) {
  const attention = document.getElementById('home-attention');
  const attentionList = document.getElementById('home-attention-list');
  const attentionTitle = document.getElementById('home-attention-title');
  const today = document.getElementById('home-today');
  const todayList = document.getElementById('home-today-list');
  const todayStamp = document.getElementById('home-today-stamp');
  const services = document.getElementById('home-services');
  const subline = document.getElementById('assistant-subline');
  if (!attention || !attentionList || !today || !todayList) return;

  // Only what the operator can act on is "Needs you": a pending approval, a failure or an interruption.
  // A running task and a finished result are progress and history; they sit in a quiet Recent row.
  const allItems = Array.isArray(brief?.home) ? brief.home : [];
  // The conversation being read already shows its own pending approval with working controls; repeating it above the
  // thread only squeezes the thread. Approvals of any other conversation stay here.
  const inlineApprovalShown = Boolean(approvalPanel && !approvalPanel.hidden && viewingConversationId);
  const sameConversationApproval = (item) => item?.kind === 'approval'
    && (item.actions || []).some((action) => action?.conversationId && action.conversationId === viewingConversationId);
  const items = allItems.filter((item) => ACTIONABLE_BRIEF_KINDS.has(item?.kind) && !(inlineApprovalShown && sameConversationApproval(item)));
  const recentItems = allItems.filter((item) => !ACTIONABLE_BRIEF_KINDS.has(item?.kind));
  attention.hidden = items.length === 0;
  if (attentionTitle) {
    attentionTitle.textContent = items.length === 1 ? 'Needs you' : `Needs you — ${items.length} items`;
  }
  attentionList.replaceChildren(...items.map(buildBriefCard));
  renderAssistantRecent(recentItems);

  const sections = Array.isArray(brief?.today) ? brief.today : [];
  const visible = sections.filter((section) => section && (section.available ? (section.items || []).length > 0 : true));
  today.hidden = visible.length === 0;
  todayList.replaceChildren(...visible.map(buildBriefSection));
  if (todayStamp) {
    const stamp = brief?.generatedAt ? new Date(brief.generatedAt) : null;
    todayStamp.textContent = stamp && !Number.isNaN(stamp.getTime())
      ? `as of ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
      : '';
  }
  renderAssistantServices(brief?.services, services);
  if (subline) {
    subline.textContent = items.length === 0
      ? 'Nothing needs you right now — your assistant is ready when you are.'
      : 'Here is what needs you, taken from KarkeDikha itself.';
  }
}

/**
 * The integrations behind the briefing, exactly as Core reports them.
 *
 * A service that is not connected is named as not connected. It is never
 * quietly omitted, and it is never presented as an empty but working source.
 */
function renderAssistantServices(list, node) {
  if (!node) return;
  const services = Array.isArray(list) ? list : [];
  if (!services.length) {
    node.hidden = true;
    node.textContent = '';
    return;
  }
  const parts = services.map((service) => {
    const connected = service?.state === 'available' || service?.state === 'degraded' || service?.state === 'connected';
    const state = connected ? 'connected' : String(service?.state ?? 'unknown').replace(/_/g, ' ');
    const reason = service?.reason ? ` — ${service.reason}` : '';
    return `${service?.label ?? service?.id}: ${state}${reason}`;
  });
  node.textContent = `Sources — ${parts.join(' · ')}`;
  node.hidden = false;
}

/* ── The one proactive routine ───────────────────────────────────────── */

/**
 * The daily brief routine.
 *
 * It is a row in Core's durable schedule, not something the app owns: it
 * survives a restart, it fires once per occurrence, and the operator can
 * switch it off. This panel only reads and sets that one row — it never
 * schedules anything itself.
 */
async function refreshAssistantRoutine() {
  const section = document.getElementById('home-routine');
  if (!section) return null;
  if (typeof api?.getDailyBriefRoutine !== 'function') {
    section.hidden = true;
    return null;
  }
  try {
    const routine = await api.getDailyBriefRoutine();
    assistantRoutine = routine ?? null;
    renderAssistantRoutine(assistantRoutine);
    return assistantRoutine;
  } catch {
    // The Core is not there yet. The control stays hidden rather than
    // pretending a routine exists.
    assistantRoutine = null;
    section.hidden = true;
    return null;
  }
}

function renderAssistantRoutine(routine) {
  const section = document.getElementById('home-routine');
  const state = document.getElementById('home-routine-state');
  const input = document.getElementById('home-routine-input');
  const save = document.getElementById('home-routine-save');
  const disable = document.getElementById('home-routine-disable');
  const note = document.getElementById('home-routine-note');
  if (!section) return;
  section.hidden = false;

  const enabled = Boolean(routine?.enabled);
  if (input && routine?.dailyTime && document.activeElement !== input) {
    input.value = routine.dailyTime;
  }
  if (save) {
    save.textContent = enabled ? 'Change time' : 'Turn on';
    save.disabled = false;
  }
  if (disable) disable.hidden = !enabled;
  if (state) {
    if (!routine) state.textContent = 'not set up';
    else if (enabled) state.textContent = `every day at ${routine.dailyTime} (${routine.timezone})`;
    else state.textContent = `off — was set for ${routine.dailyTime} (${routine.timezone})`;
  }
  if (note) {
    if (!routine) {
      note.textContent = 'Pandesh can brief you once a day. It only reads — it never sends mail or acts on its own.';
    } else if (enabled) {
      const next = routine.nextRunAt ? formatBriefMoment(routine.nextRunAt).replace(' ago', ' from now') : null;
      const last = routine.lastRunAt ? ` · last delivered ${formatBriefMoment(routine.lastRunAt)}` : '';
      note.textContent = next ? `Next brief ${next}${last}` : 'Next brief is scheduled';
    } else {
      note.textContent = 'Turn it on whenever you want it back.';
    }
  }
}

/** Turns the routine on, or moves it to a new time. */
async function saveAssistantRoutine() {
  const input = document.getElementById('home-routine-input');
  const note = document.getElementById('home-routine-note');
  const dailyTime = String(input?.value ?? '').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(dailyTime)) {
    if (note) note.textContent = 'Pick a time of day, like 08:00.';
    return;
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    assistantRoutine = await api.configureDailyBriefRoutine({ dailyTime, timezone, enabled: true });
    renderAssistantRoutine(assistantRoutine);
  } catch (err) {
    if (note) note.textContent = `Could not set the routine: ${err?.message ?? err}`;
  }
}

/** Switches the routine off. The schedule row is kept, so it can be turned
 * back on without being set up again. */
async function disableAssistantRoutine() {
  const note = document.getElementById('home-routine-note');
  const timezone = assistantRoutine?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const dailyTime = assistantRoutine?.dailyTime || String(document.getElementById('home-routine-input')?.value ?? '08:00');
  try {
    assistantRoutine = await api.configureDailyBriefRoutine({ dailyTime, timezone, enabled: false });
    renderAssistantRoutine(assistantRoutine);
  } catch (err) {
    if (note) note.textContent = `Could not turn the routine off: ${err?.message ?? err}`;
  }
}

/** Core is unreachable: say so rather than showing an empty Home. */
function renderAssistantHomeUnavailable(err) {
  const attention = document.getElementById('home-attention');
  const attentionList = document.getElementById('home-attention-list');
  const subline = document.getElementById('assistant-subline');
  if (!attention || !attentionList) return;
  if (!err) {
    // The Core is still starting. Nothing is known yet, so nothing is shown.
    attention.hidden = true;
    attentionList.replaceChildren();
    if (subline) subline.textContent = 'Your assistant is ready when you are.';
    return;
  }
  attention.hidden = false;
  attentionList.replaceChildren();
  const note = document.createElement('p');
  note.className = 'ws-attention-detail';
  note.textContent = `KarkeDikha is not reachable right now: ${err?.message ?? err}`;
  attentionList.appendChild(note);
  if (subline) subline.textContent = 'Your assistant is ready when you are.';
}

/** One attention card: what it is, where it came from, and what to do. */
function buildBriefCard(item) {
  const card = document.createElement('article');
  card.className = 'ws-attention-card';
  card.dataset.kind = item.kind;
  card.dataset.stance = item.stance;
  card.dataset.state = item.state;

  const head = document.createElement('div');
  head.className = 'ws-attention-head';
  const title = document.createElement('strong');
  title.className = 'ws-attention-title';
  title.textContent = item.title;
  const state = document.createElement('span');
  state.className = 'ws-attention-state';
  state.textContent = item.state;
  head.append(title, state);

  const detail = document.createElement('p');
  detail.className = 'ws-attention-detail';
  detail.textContent = item.detail;

  const source = document.createElement('div');
  source.className = 'ws-attention-source';
  source.textContent = `${item.source?.label ?? 'KarkeDikha'} · ${formatBriefMoment(item.at)}`;

  card.append(head, detail, source);

  const actions = (item.actions || []).filter((action) => action && action.kind);
  if (actions.length) {
    const row = document.createElement('div');
    row.className = 'ws-attention-actions';
    for (const action of actions) row.appendChild(buildBriefActionButton(action));
    card.appendChild(row);
  }
  return card;
}

/** The timestamp a source recorded, in the reader's own words. */
function formatBriefMoment(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'at an unknown time';
  const diff = Math.max(0, Date.now() - ms);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} d ago`;
}

/** One action on a card. Every one of them does the real thing. */
function buildBriefActionButton(action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ws-chip';
  button.dataset.action = action.kind;
  button.textContent = action.label;
  if (action.kind === 'resolve_approval') {
    const rejecting = /reject|deny/i.test(action.label || '');
    button.dataset.resolution = rejecting ? 'rejected' : 'approved';
    button.classList.add(rejecting ? 'is-reject' : 'is-approve');
  }
  button.addEventListener('click', async () => {
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Working…';
    try {
      await runBriefAction(action);
    } catch (err) {
      showOperationError(err);
      button.disabled = false;
      button.textContent = label;
      return;
    }
    await refreshAssistantBrief({ external: assistantBriefExternal });
  });
  return button;
}

/** What each action actually does. Nothing here is decorative. */
async function runBriefAction(action) {
  switch (action.kind) {
    case 'resolve_approval': {
      const resolution = /reject|deny/i.test(action.label || '') ? 'rejected' : 'approved';
      if (typeof api?.resolveAssistantApproval !== 'function') {
        if (typeof api?.resolveApproval === 'function') {
          await api.resolveApproval(action.approvalId, resolution);
          return;
        }
        throw new Error('Approving is not available in this build');
      }
      await api.resolveAssistantApproval(action.approvalId, resolution);
      return;
    }
    case 'stop_task': {
      if (typeof api?.cancelTask !== 'function') throw new Error('Stopping a task is not available in this build');
      await api.cancelTask(action.attemptId);
      return;
    }
    case 'resume_task': {
      if (typeof api?.resumeTask !== 'function') throw new Error('Resuming a task is not available in this build');
      await api.resumeTask(action.attemptId);
      return;
    }
    case 'open_conversation': {
      if (!action.conversationId) return;
      await openConversationFromRail(action.conversationId);
      return;
    }
    case 'open_artifact': {
      if (typeof api?.openArtifactFile !== 'function') throw new Error('Opening a result is not available in this build');
      await api.openArtifactFile(action.artifactId);
      return;
    }
    case 'refresh_brief': {
      await refreshAssistantBrief({ external: true });
      return;
    }
    default:
      return;
  }
}

/** One themed part of Today. */
function buildBriefSection(section) {
  const block = document.createElement('section');
  block.className = 'ws-today-section';
  block.dataset.section = section.id;

  const head = document.createElement('h3');
  head.className = 'ws-today-section-title';
  head.textContent = section.label;
  block.appendChild(head);

  if (!section.available) {
    const note = document.createElement('p');
    note.className = 'ws-today-unavailable';
    note.textContent = section.unavailableReason || 'This source could not be read.';
    block.appendChild(note);
    return block;
  }

  const list = document.createElement('ul');
  list.className = 'ws-today-items';
  // A brief is a summary, not a log: three lines per section, and the rest
  // stays in Core where it can be asked for.
  const items = (section.items || []).slice(0, 3);
  for (const item of items) {
    const li = document.createElement('li');
    li.className = 'ws-today-item';
    li.dataset.stance = item.stance;
    const title = document.createElement('span');
    title.className = 'ws-today-item-title';
    title.textContent = item.title;
    const detail = document.createElement('span');
    detail.className = 'ws-today-item-detail';
    detail.textContent = item.detail;
    li.append(title, detail);
    list.appendChild(li);
  }
  if ((section.items || []).length > items.length) {
    const more = document.createElement('li');
    more.className = 'ws-today-item ws-today-more';
    more.textContent = `+${(section.items || []).length - items.length} more`;
    list.appendChild(more);
  }
  block.appendChild(list);
  return block;
}

(function initAssistantWorkspace() {
  const layout = document.getElementById('assistant-layout');
  const toggle = document.getElementById('btn-toggle-history');
  // The Panda Workspace keeps the conversation full width; the history lives in
  // the rail drawer and comes back on request.
  let historyOpen = false;
  try {
    const saved = window.localStorage.getItem('panda.historyOpen');
    if (saved === 'true' || saved === 'false') historyOpen = saved === 'true';
  } catch { /* storage unavailable */ }
  const applyHistory = () => {
    if (layout) layout.dataset.history = historyOpen ? 'open' : 'closed';
    toggle?.setAttribute('aria-pressed', historyOpen ? 'true' : 'false');
  };
  applyHistory();
  toggle?.addEventListener('click', () => {
    historyOpen = !historyOpen;
    try { window.localStorage.setItem('panda.historyOpen', String(historyOpen)); } catch { /* ignore */ }
    applyHistory();
  });

  // The Home refresh button asks Core again — the same read the app uses on
  // launch, so what it shows is always what Core actually holds.
  document.getElementById('home-attention-refresh')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await refreshAssistantBrief({ external: true });
    } finally {
      button.disabled = false;
    }
  });

  // Continuity: every task — running, stopped and finished — stays one click
  // away from Home. It opens the existing Tasks screen; nothing new is built.
  document.getElementById('home-attention-tasks')?.addEventListener('click', () => {
    switchSurface('tasks');
  });

  // The one proactive routine: a daily brief the operator sets up themselves.
  document.getElementById('home-routine-save')?.addEventListener('click', () => {
    void saveAssistantRoutine();
  });
  document.getElementById('home-routine-disable')?.addEventListener('click', () => {
    void disableAssistantRoutine();
  });

  // Keep the idle/active layout honest whenever the thread is filled or cleared.
  if (result) {
    new MutationObserver(() => syncAssistantMode()).observe(result, { childList: true, attributes: true, attributeFilter: ['hidden'] });
  }

  // Details view: raw IDs, diagnostics and developer controls only appear while the Details drawer is open.
  const detailsDrawer = document.getElementById('drawer-activity');
  if (detailsDrawer && appRoot) {
    const syncDetails = () => {
      appRoot.dataset.details = detailsDrawer.classList.contains('is-active') && !detailsDrawer.hidden ? 'on' : 'off';
    };
    syncDetails();
    new MutationObserver(syncDetails).observe(detailsDrawer, { attributes: true, attributeFilter: ['class', 'hidden'] });
  }

  switchSurface('assistant');
  // Home opens knowing what matters. The fast brief (Core's own state) comes
  // first; the live one — calendar and email — follows in the background.
  void refreshAssistantBrief({ external: true });
  // The routine is one durable Core row: read it once and show its real state.
  void refreshAssistantRoutine();
})();

/** ══════════════════════════════════════════════════════════════════
 *  GOOGLE SERVICES (Connections): honest status + onboarding
 *  "Connected" is shown only when the host reports `verified` — OAuth
 *  succeeded AND Core's live Gmail probe passed. A saved credential alone
 *  (for example right after a restart) is shown as "Checking…".
 *  ══════════════════════════════════════════════════════════════════ */
const googleEls = {
  card: document.getElementById('integ-card-google'),
  badge: document.getElementById('integ-google-badge'),
  summary: document.getElementById('google-summary'),
  gmailChip: document.getElementById('google-gmail-chip'),
  gmailDetail: document.getElementById('google-gmail-detail'),
  calChip: document.getElementById('google-calendar-chip'),
  calDetail: document.getElementById('google-calendar-detail'),
  orgChip: document.getElementById('google-organize-chip'),
  orgDetail: document.getElementById('google-organize-detail'),
  orgAllow: document.getElementById('google-organize-allow'),
  recovery: document.getElementById('google-recovery'),
  recoveryTitle: document.getElementById('google-recovery-title'),
  recoverySteps: document.getElementById('google-recovery-steps'),
  recoveryLink: document.getElementById('google-recovery-link'),
  connect: document.getElementById('google-connect'),
  check: document.getElementById('google-check'),
  cancel: document.getElementById('google-cancel'),
  disconnect: document.getElementById('google-disconnect'),
  note: document.getElementById('google-action-note'),
  setup: document.getElementById('google-setup'),
  form: document.getElementById('google-client-form'),
  clientId: document.getElementById('google-client-id'),
  clientSecret: document.getElementById('google-client-secret'),
  save: document.getElementById('google-client-save'),
  clear: document.getElementById('google-client-clear'),
  importFile: document.getElementById('google-client-import'),
  clientStatus: document.getElementById('google-client-status'),
};
let googleLastState = null;
let googleLocalBusy = null; // 'connecting' | 'checking' | 'saving' | null
let googleRecoveryUrl = null;

function googleSetChip(chip, tone, text) {
  if (!chip) return;
  chip.dataset.tone = tone;
  chip.textContent = text;
}

function googleDeriveState(g) {
  if (googleLocalBusy === 'connecting' || g.connecting) return 'connecting';
  if (g.verified) return 'connected';
  if (g.connected && (g.capabilityBlocker || g.lastError)) return 'problem';
  if (g.connected) return 'checking';
  if (!g.clientSource) return 'setup';
  if (g.recovery && g.recovery.code !== 'cancelled') return 'problem-disconnected';
  return 'ready';
}

function renderGoogleCard(snapshot) {
  if (!googleEls.card || !snapshot) return;
  const g = snapshot.gmail ?? { connected: false, accountEmail: null, lastError: null, configBlocker: null, capabilityBlocker: null };
  const state = googleDeriveState(g);
  googleEls.card.dataset.state = state;

  const verifiedAt = g.lastRefreshedAt ? new Date(g.lastRefreshedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  const badge = {
    connecting: ['Waiting for sign-in…', 'busy'],
    connected: ['Gmail connected', 'online'],
    problem: ['Needs attention', 'warn'],
    'problem-disconnected': ['Not connected', 'warn'],
    checking: ['Checking…', 'busy'],
    setup: ['Setup needed', ''],
    ready: ['Not connected', ''],
  }[state];
  if (googleEls.badge) {
    googleEls.badge.textContent = badge[0];
    googleEls.badge.className = `int-badge${badge[1] ? ` ${badge[1]}` : ''}`;
  }

  // Gmail row
  if (state === 'connected') {
    googleSetChip(googleEls.gmailChip, 'ok', 'Connected');
    googleEls.gmailDetail.textContent = `${g.accountEmail} · verified${verifiedAt ? ` at ${verifiedAt}` : ''} with a live check`;
  } else if (state === 'connecting') {
    googleSetChip(googleEls.gmailChip, 'busy', 'Signing in…');
    googleEls.gmailDetail.textContent = 'Finish signing in with Google in your browser, then come back here.';
  } else if (state === 'problem') {
    googleSetChip(googleEls.gmailChip, 'warn', 'Not verified');
    googleEls.gmailDetail.textContent = `${g.accountEmail ? `Signed in as ${g.accountEmail}, but ` : ''}Panda could not confirm Gmail access. See the fix below.`;
  } else if (state === 'checking') {
    googleSetChip(googleEls.gmailChip, 'busy', 'Checking…');
    googleEls.gmailDetail.textContent = 'A saved Google sign-in exists. Verifying it with Google now.';
  } else if (state === 'setup') {
    googleSetChip(googleEls.gmailChip, 'neutral', 'Not connected');
    googleEls.gmailDetail.textContent = 'Add your Google OAuth client below (one-time), then press Connect Google.';
  } else {
    googleSetChip(googleEls.gmailChip, 'neutral', 'Not connected');
    googleEls.gmailDetail.textContent = g.clientHint ? `OAuth client ${g.clientHint} is ready. Press Connect Google.` : 'Press Connect Google to sign in.';
  }

  // Calendar row: only "Connected" if Core's Calendar connector passed a real read against Google.
  const catalog = snapshot.everydayTools?.catalog ?? [];
  const cal = catalog.find((entry) => entry.id === 'calendar');
  if (cal && cal.connectorState === 'connected' && cal.availability === 'available') {
    googleSetChip(googleEls.calChip, 'ok', 'Connected');
    googleEls.calDetail.textContent = 'Verified with a live read of your calendar.';
  } else if (state === 'connecting') {
    googleSetChip(googleEls.calChip, 'busy', 'Signing in…');
    googleEls.calDetail.textContent = 'Calendar access is part of the same Google sign-in.';
  } else if (g.connected && g.calendarAccess === 'not_granted') {
    googleSetChip(googleEls.calChip, 'warn', 'Not granted');
    googleEls.calDetail.textContent = 'This sign-in did not include Calendar. Disconnect, then connect again and keep the Calendar permission ticked.';
  } else if (g.connected && g.calendarBlocker) {
    googleSetChip(googleEls.calChip, 'warn', 'Not verified');
    googleEls.calDetail.textContent = `Panda could not confirm Calendar access: ${g.calendarBlocker}`;
  } else if (g.connected && googleLocalBusy === 'checking') {
    googleSetChip(googleEls.calChip, 'busy', 'Checking…');
    googleEls.calDetail.textContent = 'Verifying Calendar access with Google now.';
  } else if (g.connected) {
    googleSetChip(googleEls.calChip, 'warn', 'Not verified');
    googleEls.calDetail.textContent = g.lastError
      ? `Calendar could not be verified: ${g.lastError}`
      : 'Calendar has not been verified yet. Press Check to verify it with Google.';
  } else {
    googleSetChip(googleEls.calChip, 'neutral', 'Not connected');
    googleEls.calDetail.textContent = 'Connect Google to let Panda read and manage your calendar events.';
  }

  // Inbox organization: an optional, separately granted permission. Never implied by the sign-in.
  if (googleEls.orgChip) {
    if (g.connected && g.inboxOrganization === 'granted') {
      googleSetChip(googleEls.orgChip, 'ok', 'Allowed');
      googleEls.orgDetail.textContent = 'Pandesh can move mail to Promotions, label and archive it after you approve each change, and undo it. It never deletes mail.';
    } else if (g.connected) {
      googleSetChip(googleEls.orgChip, 'neutral', 'Not allowed');
      googleEls.orgDetail.textContent = 'Optional. Reading and drafting work without it. Allow it to let Pandesh organize mail after you approve each change; it never deletes mail.';
    } else {
      googleSetChip(googleEls.orgChip, 'neutral', 'Not allowed');
      googleEls.orgDetail.textContent = 'Connect Google first. Inbox organization is a separate, optional permission.';
    }
  }

  // Recovery guidance for the last failure
  const rec = g.recovery;
  if (googleEls.recovery) {
    googleEls.recovery.hidden = !rec || state === 'connecting' || state === 'connected';
    if (rec && !googleEls.recovery.hidden) {
      googleEls.recoveryTitle.textContent = rec.title;
      googleEls.recoverySteps.replaceChildren(...rec.steps.map((step) => {
        const li = document.createElement('li');
        li.textContent = step;
        return li;
      }));
      googleRecoveryUrl = rec.link?.url ?? null;
      googleEls.recoveryLink.hidden = !rec.link;
      googleEls.recoveryLink.textContent = rec.link?.label ?? '';
    }
  }

  // Buttons
  const busy = Boolean(googleLocalBusy) || state === 'connecting';
  if (googleEls.connect) {
    googleEls.connect.hidden = state === 'connected' || state === 'checking' || state === 'problem';
    googleEls.connect.disabled = busy;
    googleEls.connect.textContent = state === 'connecting' ? 'Opening Google…' : (state === 'problem-disconnected' ? 'Try again' : 'Connect Google');
  }
  if (googleEls.cancel) googleEls.cancel.hidden = state !== 'connecting';
  if (googleEls.orgAllow) {
    googleEls.orgAllow.hidden = !(g.connected && state === 'connected' && g.inboxOrganization !== 'granted');
    googleEls.orgAllow.disabled = busy;
  }
  if (googleEls.check) {
    googleEls.check.hidden = !(g.connected);
    googleEls.check.disabled = busy;
  }
  if (googleEls.disconnect) {
    googleEls.disconnect.hidden = !(g.connected);
    googleEls.disconnect.disabled = busy;
    googleEls.disconnect.textContent = state === 'problem' ? 'Disconnect and start over' : 'Disconnect';
  }
  if (googleEls.note && !googleLocalBusy) {
    googleEls.note.textContent = state === 'setup' ? 'Add your OAuth Client ID first.' : (g.helperStaged === false && state !== 'connected' ? "Google helper (gws) not found — Gmail checks will fail until it's installed." : '');
  }

  // Client form
  if (googleEls.clear) googleEls.clear.hidden = g.clientSource !== 'saved';
  if (googleEls.clientId) {
    googleEls.clientId.disabled = g.connected;
    googleEls.clientSecret.disabled = g.connected;
    googleEls.save.disabled = g.connected || googleLocalBusy === 'saving';
    if (googleEls.importFile) googleEls.importFile.disabled = g.connected || googleLocalBusy === 'saving';
    if (g.clientSource === 'environment') {
      googleEls.clientId.placeholder = `Using the client from your environment (${g.clientHint ?? 'set'})`;
    } else if (g.clientSource === 'saved') {
      googleEls.clientId.placeholder = `Saved: ${g.clientHint ?? 'client'} — paste a new Client ID to replace it`;
    }
  }
  // An app-owned client means ordinary users never see developer setup: just Connect Google.
  if (googleEls.setup) googleEls.setup.hidden = g.clientSource === 'bundled';
  // Setup steps open on first sight when needed; closed once everything works. Never fight the user's own toggling.
  if (googleEls.setup && googleLastState !== state) {
    if (state === 'setup' || (state === 'problem-disconnected' && g.recovery?.code === 'invalid_client')) googleEls.setup.open = true;
    else if (state === 'connected') googleEls.setup.open = false;
  }
  googleLastState = state;
}

function googleNote(text) { if (googleEls.note) googleEls.note.textContent = text; }

async function googleRun(kind, work) {
  googleLocalBusy = kind;
  if (lastSnapshot) renderGoogleCard(lastSnapshot);
  try {
    await work();
  } catch (err) {
    googleNote(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));
  } finally {
    googleLocalBusy = null;
    try { await refresh(); } catch { /* renderSnapshot surfaces its own errors */ }
    if (lastSnapshot) renderGoogleCard(lastSnapshot);
  }
}

googleEls.connect?.addEventListener('click', () => {
  const g = lastSnapshot?.gmail;
  if (!g?.clientSource) {
    if (googleEls.setup) googleEls.setup.open = true;
    googleNote('Add your OAuth Client ID first — steps are just below.');
    googleEls.clientId?.focus();
    return;
  }
  googleNote('');
  void googleRun('connecting', async () => {
    await api.connectGmail();
  });
});
googleEls.orgAllow?.addEventListener('click', () => {
  googleNote('Approve the inbox organization permission in your browser.');
  void googleRun('connecting', async () => {
    const status = await api.allowInboxOrganization();
    googleNote(status?.inboxOrganization === 'granted' ? 'Inbox organization is allowed.' : (status?.recovery?.title ?? ''));
  });
});
googleEls.cancel?.addEventListener('click', () => {
  void api.cancelGoogleConnect?.().catch(showOperationError);
});
googleEls.check?.addEventListener('click', () => {
  googleNote('');
  void googleRun('checking', async () => { await api.retryGmailProbe(); });
});
googleEls.disconnect?.addEventListener('click', () => {
  googleNote('');
  void googleRun('checking', async () => { await api.disconnectGmail(); });
});
googleEls.form?.addEventListener('submit', (event) => {
  event.preventDefault();
  if (googleEls.clientStatus) { googleEls.clientStatus.textContent = ''; googleEls.clientStatus.dataset.tone = ''; }
  const id = googleEls.clientId?.value ?? '';
  const secret = googleEls.clientSecret?.value ?? '';
  void googleRun('saving', async () => {
    try {
      await api.saveGoogleOAuthClient(id, secret);
      if (googleEls.clientId) googleEls.clientId.value = '';
      if (googleEls.clientSecret) googleEls.clientSecret.value = '';
      if (googleEls.clientStatus) { googleEls.clientStatus.dataset.tone = 'ok'; googleEls.clientStatus.textContent = 'Saved (encrypted). Now press Connect Google.'; }
    } catch (err) {
      if (googleEls.clientStatus) {
        googleEls.clientStatus.dataset.tone = 'error';
        googleEls.clientStatus.textContent = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
      }
    }
  });
});
googleEls.importFile?.addEventListener('click', () => {
  if (googleEls.clientStatus) { googleEls.clientStatus.textContent = ''; googleEls.clientStatus.dataset.tone = ''; }
  void googleRun('saving', async () => {
    try {
      const result = await api.importGoogleOAuthClientFile();
      if (!result?.cancelled && googleEls.clientStatus) { googleEls.clientStatus.dataset.tone = 'ok'; googleEls.clientStatus.textContent = 'Imported (encrypted). Now press Connect Google.'; }
    } catch (err) {
      if (googleEls.clientStatus) {
        googleEls.clientStatus.dataset.tone = 'error';
        googleEls.clientStatus.textContent = (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (w*Error: )?/, '');
      }
    }
  });
});
googleEls.clear?.addEventListener('click', () => {
  void googleRun('saving', async () => {
    await api.clearGoogleOAuthClient();
    if (googleEls.clientStatus) { googleEls.clientStatus.dataset.tone = 'ok'; googleEls.clientStatus.textContent = 'Saved client removed.'; }
  });
});
googleEls.recoveryLink?.addEventListener('click', () => {
  if (googleRecoveryUrl && typeof api?.openExternalUrl === 'function') void api.openExternalUrl(googleRecoveryUrl).catch(showOperationError);
});
document.querySelectorAll('#integ-card-google [data-open-url]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const url = btn.getAttribute('data-open-url');
    if (url && typeof api?.openExternalUrl === 'function') void api.openExternalUrl(url).catch(showOperationError);
  });
});

// eslint-disable-next-line no-var
var googleCardReady = true;
if (lastSnapshot) renderGoogleCard(lastSnapshot);

/** ══════════════════════════════════════════════════════════════════
 *  COMPOSER ATTACHMENTS
 *  Files are staged by the host (never a path in the renderer) and sent to
 *  Core with the next message. Pick with the paperclip, drop onto the window,
 *  or paste an image. Everything shown here comes from the host snapshot.
 *  ══════════════════════════════════════════════════════════════════ */
const ATTACHMENT_ICONS = { image: '🖼', document: '📄', audio: '🎧', text: '📝' };

function buildAttachmentChips(list, { removable = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = removable ? 'composer-attachment-list' : 'transcript-attachments';
  for (const item of list) {
    const chip = document.createElement('span');
    chip.className = 'attach-chip';
    chip.dataset.kind = item.kind;
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = ATTACHMENT_ICONS[item.kind] || '📎';
    const name = document.createElement('span');
    name.className = 'attach-chip-name';
    name.textContent = item.name;
    name.title = item.name;
    const size = document.createElement('span');
    size.className = 'attach-chip-size';
    size.textContent = formatArtifactBytes(item.byteSize);
    chip.append(icon, name, size);
    if (removable) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${item.name}`);
      remove.title = 'Remove';
      remove.textContent = '×';
      remove.addEventListener('click', () => {
        void api.removeAttachment?.(item.id).then(() => refresh()).catch(showOperationError);
      });
      chip.appendChild(remove);
    }
    wrap.appendChild(chip);
  }
  return wrap;
}

let stagedAttachmentsSignature = '';
function renderStagedAttachments(snapshot) {
  const strip = document.getElementById('composer-attachments');
  if (!strip) return;
  const list = snapshot?.stagedAttachments ?? [];
  const signature = list.map((item) => item.id).join(',');
  if (signature === stagedAttachmentsSignature) return;
  stagedAttachmentsSignature = signature;
  strip.hidden = list.length === 0;
  strip.replaceChildren(...(list.length ? [buildAttachmentChips(list, { removable: true })] : []));
  const input = document.getElementById('task-input');
  if (input) input.placeholder = list.length ? 'Add a message about your file (optional)…' : 'Ask Pandesh anything…';
}

async function stageFilesFromBrowser(files) {
  const errors = [];
  for (const file of files) {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const result = await api.stageAttachmentBytes(file.name || 'pasted-image.png', bytes);
      if (!result?.ok) errors.push(result?.error || `"${file.name}" could not be attached.`);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (errors.length) showOperationError(new Error(errors.join('\n')));
  await refresh();
}

(function initComposerAttachments() {
  const attachBtn = document.getElementById('composer-attach-btn');
  const overlay = document.getElementById('drop-overlay');
  const errorBanner = document.getElementById('operation-error');
  errorBanner?.addEventListener('click', () => showOperationError(null));

  attachBtn?.addEventListener('click', async () => {
    showOperationError(null);
    try {
      const result = await api.pickAttachments();
      if (result?.errors?.length) showOperationError(new Error(result.errors.join('\n')));
      await refresh();
    } catch (err) {
      showOperationError(err);
    }
    taskInput?.focus();
  });

  const hasFiles = (event) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (overlay) overlay.hidden = false;
  });
  window.addEventListener('dragover', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0 && overlay) overlay.hidden = true;
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
    showOperationError(null);
    switchSurface('assistant');
    void stageFilesFromBrowser(Array.from(event.dataTransfer?.files ?? []));
  });
  taskInput?.addEventListener('paste', (event) => {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return; // plain text paste stays untouched
    event.preventDefault();
    showOperationError(null);
    void stageFilesFromBrowser(files);
  });
})();

/** ══════════════════════════════════════════════════════════════════
 *  CONTEXTUAL MAIL WORKSPACE
 *  Gmail is used through chat first. When Google is connected AND verified a
 *  "Mail" button appears; it opens the existing search / thread / draft / send
 *  panel (moved here, same ids and approval flow) beside the conversation.
 *  ══════════════════════════════════════════════════════════════════ */
function renderMailAccess(snapshot) {
  const btn = document.getElementById('btn-open-mail');
  const panel = document.getElementById('mail-workspace');
  if (!btn || !panel) return;
  const verified = Boolean(snapshot?.gmail?.verified);
  btn.hidden = !verified;
  if (!verified && !panel.hidden) {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  }
}

(function initMailWorkspace() {
  const btn = document.getElementById('btn-open-mail');
  const panel = document.getElementById('mail-workspace');
  const body = document.getElementById('mail-workspace-body');
  const close = document.getElementById('mail-workspace-close');
  if (!btn || !panel || !body) return;
  let moved = false;
  const setOpen = (open) => {
    if (open && !moved) {
      const gmailPanel = document.querySelector('#tab-gmail .gmail-panel');
      if (gmailPanel) {
        body.appendChild(gmailPanel); // same element, so every Gmail binding keeps working
        moved = true;
      }
    }
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.classList.toggle('is-active', open);
    if (open) document.getElementById('gmail-search-query')?.focus();
  };
  btn.addEventListener('click', () => setOpen(panel.hidden));
  close?.addEventListener('click', () => setOpen(false));
})();

/**
 * Worker approvals on every surface: a held action needs a person, and the person is usually in the main window, not in
 * Tasks. The banner lists each pending request with Allow once / Deny and disappears when nothing is pending.
 */
async function refreshDevApprovalBanner() {
  const banner = document.getElementById('dev-approvals-banner');
  if (!banner || typeof api?.getDevStories !== 'function' || typeof api?.decideDevStoryPermission !== 'function') return;
  let data;
  try { data = await api.getDevStories(); } catch { banner.hidden = true; return; }
  const pending = [];
  for (const s of data?.stories || []) for (const p of s.pendingApprovals || []) pending.push({ story: s, p });
  const key = pending.map((x) => x.p.pendingId).join('|');
  if (banner.dataset.key === key) return; // unchanged: keep the user's focus and any button they are about to press
  banner.dataset.key = key;
  banner.hidden = pending.length === 0;
  const rows = pending.map(({ story, p }) => {
    const row = document.createElement('div');
    row.className = 'dev-approval-item';
    const title = document.createElement('div');
    title.className = 'dev-approval-title';
    title.textContent = `${String(story.title || '').split(' · ')[0]} worker wants to run:`;
    const what = document.createElement('code');
    what.textContent = p.what;
    const actions = document.createElement('div');
    actions.className = 'dev-approval-actions';
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.className = 'apex-chip';
    allow.textContent = 'Allow once';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.className = 'apex-chip';
    deny.textContent = 'Deny';
    const decide = async (ok) => {
      allow.disabled = deny.disabled = true;
      try { await api.decideDevStoryPermission(story.id, p.pendingId, ok); } finally { banner.dataset.key = ''; void refreshDevApprovalBanner(); void refreshDevStoriesPanel(); }
    };
    allow.addEventListener('click', () => void decide(true));
    deny.addEventListener('click', () => void decide(false));
    actions.append(allow, deny);
    row.append(title, what, actions);
    return row;
  });
  banner.replaceChildren(...rows);
}
setInterval(() => { if (!document.hidden) void refreshDevApprovalBanner(); }, 4000);
void refreshDevApprovalBanner();
