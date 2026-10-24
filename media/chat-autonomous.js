(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  if (!vscode) throw new Error('Shared VS Code webview API is unavailable.');

  const modeSelect = document.getElementById('mode-select');
  const inputArea = document.getElementById('input-area');
  const composer = document.getElementById('autonomous-composer');
  const textarea = document.getElementById('autonomous-input');
  const unifiedInput = document.getElementById('user-input');
  const unifiedSendBtn = document.getElementById('send-btn');
  const unifiedTaskStopBtn = document.getElementById('unified-task-stop-btn');
  const counts = document.getElementById('autonomous-counts');
  const errorBox = document.getElementById('autonomous-error');
  const startBtn = document.getElementById('autonomous-start-btn');
  const autonomousStopBtn = document.getElementById('autonomous-stop-btn');
  const clearBtn = document.getElementById('autonomous-clear-btn');
  const copyBtn = document.getElementById('autonomous-copy-btn');
  const loadLastBtn = document.getElementById('autonomous-load-last-btn');
  const statusBox = document.getElementById('autonomous-status');
  const taskIdSpan = document.getElementById('autonomous-task-id');
  const attemptIdSpan = document.getElementById('autonomous-attempt-id');
  const openWorktreeBtn = document.getElementById('autonomous-open-worktree-btn');
  const copyDiagnosticsBtn = document.getElementById('autonomous-copy-diagnostics-btn');
  const timeline = document.getElementById('autonomous-timeline');
  const conversationalProgress = document.getElementById('autonomous-conversational-progress');
  const renderedConversationalKeys = new Set();
  const gateResolutionSeen = { proposal: false, mutation: false, delivery: false };
  const ambientPlaceholder = document.getElementById('ambient-placeholder');
  const stageTracker = document.getElementById('autonomous-stage-tracker');
  const taskLineEl = document.getElementById('kd-task-line');
  const pinnedApprovalSlot = document.getElementById('kd-pinned-approval-slot');
  const taskDetails = document.getElementById('kd-task-details');
  const requestEntry = document.getElementById('task-request-entry');
  const promptSummary = document.getElementById('autonomous-prompt-summary');
  const promptConstraints = document.getElementById('autonomous-prompt-constraints');
  const autonomyModeSelect = document.getElementById('autonomy-mode-select');
  const autonomyBadge = document.getElementById('kd-autonomy-badge');
  const deliveryEvidence = document.getElementById('delivery-evidence');
  const repoSpan = document.getElementById('autonomous-repo');
  const branchSpan = document.getElementById('autonomous-branch');
  const providerModelSpan = document.getElementById('autonomous-provider-model');
  const permissionSpan = document.getElementById('autonomous-permission');
  const deliveryCard = document.getElementById('delivery-approval-card');
  const deliveryReview = document.getElementById('delivery-review-btn');
  const deliveryApprove = document.getElementById('delivery-approve-btn');
  const deliveryReject = document.getElementById('delivery-reject-btn');
  const proposalCard = document.getElementById('proposal-approval-card');
  const proposalTitle = document.getElementById('proposal-card-title');
  const proposalSummary = document.getElementById('proposal-card-summary');
  const proposalOperations = document.getElementById('proposal-card-operations');
  const proposalValidation = document.getElementById('proposal-card-validation');
  const proposalWarnings = document.getElementById('proposal-card-warnings');
  const proposalStatus = document.getElementById('proposal-card-status');
  const proposalApproveBtn = document.getElementById('proposal-approve-btn');
  const proposalReviseBtn = document.getElementById('proposal-revise-btn');
  const proposalRejectBtn = document.getElementById('proposal-reject-btn');
  const proposalRevisionForm = document.getElementById('proposal-revision-form');
  const proposalRevisionText = document.getElementById('proposal-revision-text');
  const proposalRevisionSubmitBtn = document.getElementById('proposal-revision-submit-btn');
  const proposalRevisionCancelBtn = document.getElementById('proposal-revision-cancel-btn');
  const mutationCard = document.getElementById('mutation-approval-card');
  const mutationTitle = document.getElementById('mutation-card-title');
  const mutationSummary = document.getElementById('mutation-card-summary');
  const mutationStatus = document.getElementById('mutation-card-status');
  const mutationApproveBtn = document.getElementById('mutation-approve-btn');
  const mutationDenyBtn = document.getElementById('mutation-deny-btn');
  const pandaIcon = document.getElementById('autonomous-panda');
  const pandaLabel = document.getElementById('autonomous-panda-label');
  const chatMessages = document.getElementById('messages');
  const jumpLatestBtn = document.getElementById('kd-jump-latest');
  const everydayPhase = document.getElementById('everyday-phase');
  const everydayPhaseSentence = document.getElementById('everyday-phase-sentence');
  const scheduleFrame = typeof window.requestAnimationFrame === 'function'
    ? callback => window.requestAnimationFrame(callback)
    : callback => window.setTimeout(callback, 0);

  const pandaBaseUri = typeof window.__pandaBaseUri === 'string' && window.__pandaBaseUri
    ? window.__pandaBaseUri.replace(/\/+$/, '')
    : '';

  // Maps a PandaState (see src/autonomous/PandaStateMapping.ts) to its
  // production WebP filename under media/panda/.
  const PANDA_STATE_TO_FILE = {
    idle: 'mascot-idle.webp',
    thinking: 'action-thinking.webp',
    reading: 'action-repository.webp',
    searching: 'action-searching.webp',
    planning: 'action-thinking.webp',
    delegating: 'action-delegating.webp',
    coding: 'action-coding.webp',
    building: 'action-building.webp',
    testing: 'action-testing.webp',
    reviewing: 'action-reviewing.webp',
    waiting_for_delivery_approval: 'action-approval.webp',
    blocked: 'action-blocked.webp',
    failed: 'action-failed.webp',
    completed: 'mascot-success.webp',
    cancelled: 'mascot-done.webp',
  };

  // M40 — sole owner of `.kd-task-line`, the single compact status line
  // inside the unified `.kd-task-message` wrapper (`#autonomous-status`).
  // Every progress/heartbeat writer (this file's own status handling and
  // chat-sidebar-ui.js's live-progress/heartbeat logic) must funnel through
  // this instead of building a separate top-of-status card, so there is
  // exactly one line that updates in place rather than N stacked cards.
  function setTaskLine(text) {
    if (!taskLineEl) return;
    const value = String(text || '');
    if (taskLineEl.textContent !== value) taskLineEl.textContent = value;
    followLatestIfPinned();
  }
  window.__kdTaskLine = { setTaskLine };

  /**
   * Points a `.kd-panda-icon` surface's `<img>` at the WebP for `state`. If
   * the webview URI wasn't plumbed through or the state has no asset, the
   * surface's inline `.kd-panda-fallback` SVG (already in the DOM) is left
   * showing; a load failure falls back the same way.
   */
  function applyPandaImage(container, state) {
    if (!container) return;
    const img = container.querySelector('.kd-panda-img');
    const filename = PANDA_STATE_TO_FILE[state] || PANDA_STATE_TO_FILE.idle;
    if (!img || !pandaBaseUri) {
      container.classList.remove('kd-img-ready');
      return;
    }

    const requestedSrc = `${pandaBaseUri}/${filename}`;
    // Polling the same authoritative task snapshot must not restart the image
    // load/animation. Only change the asset when the panda state changes.
    if (img.dataset.pandaFile === filename && img.getAttribute('src') === requestedSrc) return;

    img.onload = () => container.classList.add('kd-img-ready');
    img.onerror = () => {
      container.classList.remove('kd-img-ready');
      if (!img.dataset.defaultFallbackApplied && filename !== PANDA_STATE_TO_FILE.idle) {
        img.dataset.defaultFallbackApplied = 'true';
        img.dataset.pandaFile = PANDA_STATE_TO_FILE.idle;
        img.src = `${pandaBaseUri}/${PANDA_STATE_TO_FILE.idle}`;
      }
    };
    delete img.dataset.defaultFallbackApplied;
    img.dataset.pandaFile = filename;
    img.src = requestedSrc;
  }

  // Images retain task-specific detail; visible copy stays intentionally quiet.
  const PANDA_STATE_LABELS = {
    idle: 'ready',
    thinking: 'thinking',
    reading: 'reading',
    searching: 'reading',
    planning: 'thinking',
    delegating: 'working',
    coding: 'working',
    building: 'working',
    testing: 'working',
    reviewing: 'working',
    waiting_for_delivery_approval: 'waiting',
    blocked: 'blocked',
    failed: 'failed',
    completed: 'success',
    cancelled: 'stopped',
  };

  // User Progress Projection: the five internal graph stages are not a second progress bar. Each maps onto the
  // existing lifecycle step (analyst -> "Understanding your request", the rest -> "Preparing the change"), one
  // product-owned activity line and an existing panda state. Copy never comes from model/stage prose. The graph's
  // Validator runs BEFORE proposal approval, so it is still "Preparing the change", never "Checking the result".
  const GRAPH_STAGE_PROGRESS = {
    'repository-analyst': { step: 0, activity: 'Reading the existing implementation…', detail: 'Finding the relevant files and code paths.', panda: 'reading' },
    planner: { step: 1, activity: 'Planning the smallest safe change…', detail: '', panda: 'planning' },
    implementer: { step: 1, activity: 'Preparing the change…', detail: 'Building the proposed repository edits.', panda: 'coding' },
    reviewer: { step: 1, activity: 'Reviewing the proposed change…', detail: 'Checking scope, correctness and risk.', panda: 'thinking' },
    validator: { step: 1, activity: 'Checking the proposed change…', detail: 'Verifying that the proposal is safe to execute.', panda: 'building' },
  };
  // Anything that happens after the graph produced its proposal ends the stage projection; the authoritative
  // lifecycle (approval, mutation, validation, delivery) takes over from there.
  const GRAPH_STAGE_END = /^(?:graph_stage_(?:failed|cancelled|timed_out)|proposal_|approval_|mutating|mutation_|validating|validation_|recovery_decision|investigation_stop|lightweight_proposal_execution)/;
  function nextGraphStage(current, rawProgress) {
    const raw = String(rawProgress || '');
    const started = /^graph_stage_started stage=(\S+)/.exec(raw);
    if (started) return GRAPH_STAGE_PROGRESS[started[1]] ? started[1] : current;
    return GRAPH_STAGE_END.test(raw) ? null : current;
  }
  let activeGraphStage = null;
  function currentGraphStageProgress() {
    if (!activeGraphStage || AUTONOMOUS_TERMINAL_STATES.has(activeTaskState) || GATE_BY_STATE[activeTaskState]) return null;
    return GRAPH_STAGE_PROGRESS[activeGraphStage] || null;
  }
  window.__kdGraphStage = { current: currentGraphStageProgress, next: nextGraphStage, stages: GRAPH_STAGE_PROGRESS };

  const AUTONOMOUS_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
  const PANDA_LIFECYCLE_OVERRIDE_STATES = new Set([
    'waiting_for_approval',
    'waiting_for_proposal_approval',
    'waiting_for_mutation_approval',
    'waiting_for_delivery_approval',
    'cancelling',
    'blocked',
    'failed',
    'completed',
    'cancelled',
  ]);

  function resolveTaskPandaState(message, latestEventPandaState) {
    const lifecycleState = String(message?.state || '');
    const lifecyclePandaState = typeof message?.pandaState === 'string' ? message.pandaState : '';
    if (PANDA_LIFECYCLE_OVERRIDE_STATES.has(lifecycleState)) {
      return lifecyclePandaState || latestEventPandaState || 'thinking';
    }
    // During active work the event is more specific than the lifecycle:
    // running may be reading/searching/testing/reviewing, not just "coding".
    return currentGraphStageProgress()?.panda || latestEventPandaState || lifecyclePandaState || 'thinking';
  }
  const GATE_BY_STATE = {
    waiting_for_proposal_approval: 'proposal',
    waiting_for_mutation_approval: 'mutation',
    waiting_for_delivery_approval: 'delivery',
  };

  // Bounded gate lifecycle: proposal -> mutation -> delivery. Ranks back the
  // monotonic reconciliation below — a status snapshot may only ever move
  // the recorded gate forward (or reset it on a genuinely new task/attempt),
  // never backward, so a stale/earlier snapshot arriving out of order can
  // never disable a currently pending later-stage gate.
  const GATE_RANK = { proposal: 1, mutation: 2, delivery: 3 };
  const approvalCardByKind = { proposal: proposalCard, mutation: mutationCard, delivery: deliveryCard };
  const approvalStatusEl = { proposal: proposalStatus, mutation: mutationStatus, delivery: null };

  // Per task+attempt gate bookkeeping. Reset whenever the active task or
  // attempt changes (resetGateLifecycle). `requested[kind]` becomes true the
  // first time that gate's approval-request message is seen for the current
  // task/attempt and never goes back to false — it is what keeps a resolved
  // card visible as history regardless of what the current `state` string
  // says. `resolvedDecision[kind]` holds the decision text once resolved.
  // `pendingGate` is the single actionable gate, cleared only by a matching
  // resolution or a terminal/reset event — never by a status snapshot alone.
  let gateRequested = { proposal: false, mutation: false, delivery: false };
  let gateResolvedDecision = { proposal: null, mutation: null, delivery: null };
  let pendingGate = null;
  let highestRequestedRank = 0;
  let activeAttemptId = null;
  let activeTaskAutonomyMode = 'supervised';
  const supersededAttemptIds = new Set();

  // The delivery card has no static status paragraph in chat.html markup
  // (unlike proposal/mutation) — created lazily on first resolution, same
  // element/class chat-sidebar-ui.js used to create before ownership moved.
  function ensureDeliveryStatus() {
    if (!deliveryCard) return null;
    let status = deliveryCard.querySelector('.proposal-card-status');
    if (!status) {
      status = document.createElement('p');
      status.className = 'proposal-card-status';
      const actions = deliveryCard.querySelector('.autonomous-actions');
      actions?.parentElement?.insertBefore(status, actions);
    }
    return status;
  }

  function approvalDecisionText(kind, decision) {
    if (decision === 'approved') return 'Approved';
    if (decision === 'rejected') return 'Rejected';
    if (decision === 'denied') return 'Denied';
    if (decision === 'revision_requested') return 'Revision requested — superseded';
    if (decision === 'stale') return 'Stale — no longer actionable';
    return kind === 'delivery' ? 'Resolved' : 'Stale — no longer actionable';
  }

  function disableGateControls(kind) {
    if (kind === 'proposal') {
      setProposalButtonsDisabled(true);
      if (proposalRevisionText) proposalRevisionText.disabled = true;
      if (proposalRevisionSubmitBtn) proposalRevisionSubmitBtn.disabled = true;
      if (proposalRevisionForm) proposalRevisionForm.hidden = true;
      proposalActionInFlight = false;
    } else if (kind === 'mutation') {
      if (mutationApproveBtn) mutationApproveBtn.disabled = true;
      if (mutationDenyBtn) mutationDenyBtn.disabled = true;
      mutationActionInFlight = false;
    } else if (kind === 'delivery') {
      if (deliveryReview) deliveryReview.disabled = true;
      if (deliveryApprove) deliveryApprove.disabled = true;
      if (deliveryReject) deliveryReject.disabled = true;
    }
  }

  function enableGateControls(kind) {
    if (kind === 'proposal') {
      setProposalButtonsDisabled(false);
      if (proposalRevisionText) proposalRevisionText.disabled = false;
    } else if (kind === 'mutation') {
      if (mutationApproveBtn) mutationApproveBtn.disabled = false;
      if (mutationDenyBtn) mutationDenyBtn.disabled = false;
    } else if (kind === 'delivery') {
      if (deliveryReview) deliveryReview.disabled = false;
      if (deliveryApprove) deliveryApprove.disabled = false;
      if (deliveryReject) deliveryReject.disabled = false;
    }
  }

  // Sole owner of inline placement, within the single `.kd-task-message`
  // wrapper (#autonomous-status). A PENDING card mounts into the pinned
  // approval slot — always visible, never inside the collapsed/scrollable
  // `.kd-task-details` region — and gets the "waiting" treatment (scrolled
  // into view once, dhadkan pulse, banner text). A RESOLVED card moves into
  // the timeline (inside `.kd-task-details`) as compact chronological
  // history. Idempotent — safe to call repeatedly for the same card.
  function placeCardInline(kind, pending) {
    const card = approvalCardByKind[kind];
    if (!card) return;
    card.classList.add('kd-inline-approval');
    card.style.order = '0';
    card.setAttribute('role', 'region');
    card.setAttribute('tabindex', '-1');
    card.setAttribute('aria-label', `${kind[0].toUpperCase()}${kind.slice(1)} approval`);
    card.hidden = false;

    if (pending) {
      const wasAlreadyPendingHere = card.dataset.inlineApprovalState === 'pending' && pinnedApprovalSlot?.contains(card);
      if (pinnedApprovalSlot) pinnedApprovalSlot.appendChild(card);
      card.dataset.inlineApprovalState = 'pending';
      card.classList.add('kd-dhadkan');
      card.classList.remove('is-historical');
      if (pandaLabel) pandaLabel.textContent = PANDA_STATE_LABELS.waiting_for_delivery_approval;
      if (everydayPhaseSentence) everydayPhaseSentence.textContent = 'Review the inline approval card below to continue.';
      if (!wasAlreadyPendingHere) revealTaskMessageForNewApproval();
    } else {
      if (timeline) timeline.appendChild(card);
      card.dataset.inlineApprovalState = 'resolved';
      card.classList.remove('kd-dhadkan');
      card.classList.add('is-historical');
    }
  }

  // C — scroll/focus discipline. Ordinary checkpoint/progress updates never
  // rebuild the task panel and never steal scroll. `#messages` is the only
  // live-progress scroller: follow new activity while the user is already at
  // the bottom; if they scroll up, freeze that position and offer Jump to latest.
  const FOLLOW_LATEST_THRESHOLD_PX = 64;
  let followLatest = true;
  let ignoreLiveScrollEvent = false;
  let pinGeneration = 0;
  let pendingUserScrollIntent = false;
  let userReleasedFollow = false;

  function isScrolledNearBottom() {
    if (!chatMessages) return true;
    return chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < FOLLOW_LATEST_THRESHOLD_PX;
  }

  function syncJumpLatestButton() {
    if (!jumpLatestBtn) return;
    const show = Boolean(statusBox && !statusBox.hidden && !followLatest);
    jumpLatestBtn.hidden = !show;
    if (show) jumpLatestBtn.removeAttribute('hidden');
    else jumpLatestBtn.setAttribute('hidden', '');
  }

  function applyPinToLatest() {
    if (!chatMessages || !followLatest || userReleasedFollow) return;
    ignoreLiveScrollEvent = true;
    chatMessages.style.scrollBehavior = 'auto';
    chatMessages.scrollTop = chatMessages.scrollHeight;
    syncJumpLatestButton();
    scheduleFrame(() => {
      if (chatMessages && followLatest && !userReleasedFollow) chatMessages.scrollTop = chatMessages.scrollHeight;
      ignoreLiveScrollEvent = false;
    });
  }

  function pinToLatest() {
    userReleasedFollow = false;
    followLatest = true;
    pendingUserScrollIntent = false;
    syncJumpLatestButton();
    if (!chatMessages) return;
    const generation = ++pinGeneration;
    ignoreLiveScrollEvent = true;
    applyPinToLatest();
    scheduleFrame(() => {
      if (generation !== pinGeneration) return;
      applyPinToLatest();
      scheduleFrame(() => {
        if (generation !== pinGeneration) return;
        applyPinToLatest();
        ignoreLiveScrollEvent = false;
      });
    });
    window.setTimeout(() => {
      if (generation === pinGeneration) ignoreLiveScrollEvent = false;
    }, 120);
  }

  function followLatestIfPinned() {
    if (!followLatest || userReleasedFollow) {
      syncJumpLatestButton();
      return;
    }
    applyPinToLatest();
  }

  function revealTaskMessageInView() {
    if (followLatest || isScrolledNearBottom()) {
      pinToLatest();
      return;
    }
    syncJumpLatestButton();
  }

  function revealTaskMessageForNewApproval() {
    revealTaskMessageInView();
  }

  chatMessages?.addEventListener('wheel', event => {
    pendingUserScrollIntent = true;
    ignoreLiveScrollEvent = false;
    if (event.deltaY < 0) {
      userReleasedFollow = true;
      followLatest = false;
      pinGeneration += 1;
      syncJumpLatestButton();
    }
  }, { passive: true });
  chatMessages?.addEventListener('touchmove', () => { pendingUserScrollIntent = true; }, { passive: true });
  chatMessages?.addEventListener('pointerdown', () => { pendingUserScrollIntent = true; });
  chatMessages?.addEventListener('keydown', event => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
      pendingUserScrollIntent = true;
    }
  });
  chatMessages?.addEventListener('scroll', () => {
    if (ignoreLiveScrollEvent) return;
    if (isScrolledNearBottom()) {
      if (!userReleasedFollow) followLatest = true;
    } else if (pendingUserScrollIntent) {
      userReleasedFollow = true;
      followLatest = false;
      pinGeneration += 1;
    }
    syncJumpLatestButton();
  }, { passive: true });

  jumpLatestBtn?.addEventListener('click', () => {
    pinToLatest();
  });

  taskDetails?.addEventListener('toggle', () => {
    if (followLatest) followLatestIfPinned();
  });

  if (chatMessages && typeof ResizeObserver === 'function') {
    const pinOnLayout = () => {
      if (followLatest && !pendingUserScrollIntent && !userReleasedFollow) applyPinToLatest();
    };
    const resizeObserver = new ResizeObserver(pinOnLayout);
    resizeObserver.observe(chatMessages);
    if (statusBox) resizeObserver.observe(statusBox);
    if (timeline) resizeObserver.observe(timeline);
  }
  if (chatMessages && typeof MutationObserver === 'function') {
    new MutationObserver(() => {
      if (followLatest && !pendingUserScrollIntent && !userReleasedFollow) applyPinToLatest();
    }).observe(chatMessages, { childList: true, subtree: true, characterData: true });
  }

  window.__kdLiveScroll = {
    isFollowing() { return followLatest; },
    followLatestIfPinned,
    pinToLatest,
    notifyUserScroll() {
      ignoreLiveScrollEvent = false;
      pendingUserScrollIntent = true;
      followLatest = isScrolledNearBottom();
      syncJumpLatestButton();
    },
    releaseFollow() {
      userReleasedFollow = true;
      followLatest = false;
      pendingUserScrollIntent = true;
      ignoreLiveScrollEvent = false;
      pinGeneration += 1;
      syncJumpLatestButton();
    },
  };

  // A. `#autonomous-status` IS the single `.kd-task-message` wrapper — this
  // webview shows exactly one active task at a time, so there is never a
  // second sibling wrapper to fight over the same slot. `data-kd-task-message`
  // carries the spec's `kd-task-message-<taskId>` identity for assertions/
  // diagnostics without renaming the stable `#autonomous-status` id that the
  // rest of the webview (chat-sidebar-ui.js, chat-everyday.js) already looks
  // up by id.
  function stampTaskMessage(taskId) {
    if (!statusBox) return;
    statusBox.dataset.kdTaskMessage = `kd-task-message-${taskId}`;
    revealedTerminalKey = null;
    followLatest = true;
    setTaskLine('');
    if (taskDetails) taskDetails.open = false;
    syncJumpLatestButton();
  }

  // Resets all gate bookkeeping and hides every approval card. Called
  // whenever the active task id or attempt id genuinely changes, so a card
  // belonging to a previous task/attempt can never be inherited or
  // reactivated (a different task, or a new attempt of the same task, must
  // start every gate from a clean slate).
  function resetGateLifecycle(taskId, attemptId) {
    gateRequested = { proposal: false, mutation: false, delivery: false };
    gateResolvedDecision = { proposal: null, mutation: null, delivery: null };
    pendingGate = null;
    highestRequestedRank = 0;
    if (activeAttemptId && attemptId != null && String(attemptId) !== activeAttemptId) {
      supersededAttemptIds.add(activeAttemptId);
    }
    activeAttemptId = attemptId != null ? String(attemptId) : null;
    activeTaskAutonomyMode = 'supervised';
    // Task-Scoped Autonomy V1 — hide any stale badge from a previous task
    // until this new task's own real autonomyMode is reported.
    renderAutonomyBadge(undefined);
    for (const kind of Object.keys(approvalCardByKind)) {
      const card = approvalCardByKind[kind];
      if (!card) continue;
      card.hidden = true;
      delete card.dataset.inlineApprovalState;
      delete card.dataset.approvalDecision;
      card.classList.remove('kd-dhadkan', 'is-historical');
      disableGateControls(kind);
      if (kind === 'proposal') {
        if (proposalRevisionForm) proposalRevisionForm.hidden = true;
        if (proposalRevisionText) proposalRevisionText.value = '';
        delete card.dataset.taskId;
        delete card.dataset.attemptId;
      } else {
        delete card.dataset.taskId;
        delete card.dataset.attemptId;
      }
    }
    pendingProposal = null;
    proposalActionInFlight = false;
    pendingMutation = null;
    mutationActionInFlight = false;
    deliveryTaskId = null;
  }

  function resetProjectedTimeline() {
    activeGraphStage = null;
    renderedEventIds.clear();
    renderedConversationalKeys.clear();
    gateResolutionSeen.proposal = false;
    gateResolutionSeen.mutation = false;
    gateResolutionSeen.delivery = false;
    if (conversationalProgress) conversationalProgress.replaceChildren();
    if (!timeline) return;
    timeline.replaceChildren();
  }

  function addConversationalItem(text, status = 'info', key = null) {
    if (!conversationalProgress) return null;
    if (key && renderedConversationalKeys.has(key)) return null;
    if (key) renderedConversationalKeys.add(key);

    const item = document.createElement('div');
    const isSuccess = text.startsWith('✓') || status === 'success';
    const isFailure = text.startsWith('✗') || status === 'failure';
    const isWaiting = status === 'waiting';
    const statusClass = isSuccess ? 'status-success' : isFailure ? 'status-failure' : isWaiting ? 'status-waiting' : 'status-in-progress';
    item.className = `conversational-progress-item ${statusClass}`;
    if (key) item.dataset.progressKey = key;
    item.textContent = text;

    conversationalProgress.appendChild(item);
    followLatestIfPinned();
    return item;
  }

  function projectConversationalEvent(item, state, autonomyMode, branchName) {
    const raw = String(item.rawProgress || item.renderedProgress || '');
    const kind = String(item.kind || '');
    const isHandsOff = autonomyMode === 'hands_off';

    // 1. Investigation / file review
    if (
      kind === 'lightweight_proposal_execution' ||
      kind.startsWith('investigation_') ||
      raw.startsWith('readiness_check') ||
      raw.startsWith('lightweight_proposal_execution') ||
      /^graph_stage_started stage=repository-analyst/.test(raw)
    ) {
      addConversationalItem('Reviewing the relevant files…', 'in-progress', 'conv-reviewing-files');
    }

    // 1b. Found relevant files / implementation
    if (
      /^graph_stage_completed stage=repository-analyst/.test(raw) ||
      /^graph_stage_started stage=planner/.test(raw) ||
      /investigation_transcript_compacted/.test(raw) ||
      /unique_files=\d+/.test(raw)
    ) {
      addConversationalItem('✓ Found the relevant implementation and tests', 'success', 'conv-found-files');
    }

    // 2. Planning / Preparing change
    if (
      /^graph_stage_started stage=planner/.test(raw) ||
      /^graph_stage_started stage=implementer/.test(raw)
    ) {
      addConversationalItem('Preparing the change…', 'in-progress', 'conv-preparing-change');
    }

    // 2b. Reviewing / checking the proposal (still before approval)
    if (/^graph_stage_started stage=reviewer/.test(raw)) {
      addConversationalItem('Reviewing the proposed change…', 'in-progress', 'conv-reviewing-proposal');
    }
    if (/^graph_stage_started stage=validator/.test(raw)) {
      addConversationalItem('Checking the proposed change…', 'in-progress', 'conv-checking-proposal');
    }

    // 3. Proposal ready
    if (raw === 'proposal_ready' || kind === 'proposal_ready') {
      addConversationalItem('✓ Proposal ready', 'success', 'conv-proposal-ready');
    }

    // 4. Proposal approval waiting / resolution
    if (raw.startsWith('approval_waiting gate=proposal') || raw.startsWith('approval_requested gate=proposal')) {
      if (!isHandsOff && !gateResolutionSeen.proposal) {
        addConversationalItem('Waiting for your approval', 'waiting', 'conv-wait-proposal');
      }
    }
    if (
      raw.startsWith('approval_auto_authorized gate=proposal') ||
      (raw.startsWith('approval_approved gate=proposal') && raw.includes('actor=hands_off_policy'))
    ) {
      if (!gateResolutionSeen.proposal) {
        gateResolutionSeen.proposal = true;
        addConversationalItem('✓ Proposal automatically authorized', 'success', 'conv-proposal-approved');
      }
    } else if (raw.startsWith('approval_approved gate=proposal')) {
      if (!gateResolutionSeen.proposal) {
        gateResolutionSeen.proposal = true;
        addConversationalItem(isHandsOff ? '✓ Proposal automatically authorized' : '✓ Proposal approved', 'success', 'conv-proposal-approved');
      }
    }

    // 5. Mutation approval waiting / resolution
    if (raw.startsWith('approval_waiting gate=mutation') || raw.startsWith('approval_waiting gate=execution') ||
        raw.startsWith('approval_requested gate=mutation') || raw.startsWith('approval_requested gate=execution')) {
      if (!isHandsOff && !gateResolutionSeen.mutation) {
        addConversationalItem('Mutation approval required', 'waiting', 'conv-wait-mutation');
      }
    }
    if (
      raw.startsWith('approval_auto_authorized gate=mutation') ||
      (raw.startsWith('approval_approved gate=mutation') && raw.includes('actor=hands_off_policy'))
    ) {
      if (!gateResolutionSeen.mutation) {
        gateResolutionSeen.mutation = true;
        addConversationalItem('✓ Mutation automatically authorized', 'success', 'conv-mutation-approved');
      }
    } else if (raw.startsWith('approval_approved gate=mutation') || raw.startsWith('approval_approved gate=execution')) {
      if (!gateResolutionSeen.mutation) {
        gateResolutionSeen.mutation = true;
        addConversationalItem(isHandsOff ? '✓ Mutation automatically authorized' : '✓ Mutation approved', 'success', 'conv-mutation-approved');
      }
    }

    // 6. Mutating & updating files
    if (raw === 'mutating' || kind === 'mutating') {
      addConversationalItem('Applying changes in isolated worktree…', 'in-progress', 'conv-mutating');
    }
    let m;
    if ((m = /^mutation_evidence_verified(?:\s+revision=(\d+))?(?:\s+changed=(\d+))?/.exec(raw))) {
      const count = m[2] ? Number(m[2]) : 1;
      addConversationalItem(count === 1 ? '✓ Updated 1 file' : `✓ Updated ${count} files`, 'success', 'conv-mutation-updated');
    } else if (raw.startsWith('mutation_completed')) {
      addConversationalItem('✓ Updated files', 'success', 'conv-mutation-updated');
    }

    // 7. Validation commands
    if ((m = /^validation_command_started index=(\d+)\/(\d+) command=(.+)$/.exec(raw))) {
      const cmd = m[3].trim();
      addConversationalItem(`Running ${cmd}…`, 'in-progress', `conv-val-cmd-${m[1]}-${cmd}`);
    }
    if ((m = /^validation_completed commands=(\d+) failed=(\d+)$/.exec(raw))) {
      const failed = Number(m[2]);
      if (failed === 0) {
        addConversationalItem('✓ Passed', 'success', `conv-val-passed-${item.eventId ?? item.seq ?? raw}`);
      } else {
        addConversationalItem('✗ Validation failed', 'failure', `conv-val-failed-${item.eventId ?? item.seq ?? raw}`);
      }
    }

    // 8. Validation repair cycle
    if ((m = /^validation_repair_started cycle=(\d+)\/(\d+)$/.exec(raw))) {
      addConversationalItem(`Repairing the failing validation — attempt ${m[1]} of ${m[2]}…`, 'in-progress', `conv-repair-start-${m[1]}`);
    }
    if ((m = /^proposal_regenerated operations=(\d+)$/.exec(raw)) || raw === 'proposal_validation_passed') {
      addConversationalItem('✓ Repair prepared', 'success', `conv-repair-prepared-${item.eventId ?? item.seq}`);
      addConversationalItem('Running validation again…', 'in-progress', `conv-val-rerun-${item.eventId ?? item.seq}`);
    }
    if ((m = /^validation_repair_completed cycle=(\d+)\/(\d+) failed=(\d+)$/.exec(raw))) {
      const failed = Number(m[3]);
      if (failed === 0) {
        addConversationalItem('✓ Validation passed', 'success', `conv-repair-pass-${m[1]}`);
      } else {
        addConversationalItem('✗ Validation still failing', 'failure', `conv-repair-fail-${m[1]}`);
      }
    }

    // 9. Diff review
    if (raw.startsWith('m16_gate_result') || raw.startsWith('diff_review')) {
      addConversationalItem('Reviewing the final diff…', 'in-progress', 'conv-diff-review-start');
      if (raw.includes('status=passed') || raw.includes('verdict=pass')) {
        addConversationalItem('✓ Diff review passed', 'success', 'conv-diff-review-pass');
      }
    }
  }

  // Ensures gate state reflects the current authoritative task+attempt
  // before processing any message that carries one. A change in either id
  // means a brand-new bounded lifecycle: old cards/state must not leak in.
  function ensureTaskAttempt(taskId, attemptId) {
    const nextTaskId = String(taskId ?? '');
    if (!nextTaskId) return;
    if (attemptId != null && supersededAttemptIds.has(String(attemptId))) return;
    const nextAttemptId = attemptId != null ? String(attemptId) : activeAttemptId;
    const taskChanged = activeTaskId !== nextTaskId;
    const attemptChanged = !taskChanged && attemptId != null && activeAttemptId !== null && activeAttemptId !== nextAttemptId;
    if (taskChanged || attemptChanged) {
      resetGateLifecycle(nextTaskId, attemptId);
      resetProjectedTimeline();
    } else if (activeAttemptId === null && attemptId != null) {
      activeAttemptId = nextAttemptId;
    }
    activeTaskId = nextTaskId;
  }

  // Authoritative entry point for a proposal/mutation/delivery approval
  // request. Idempotent for duplicate requests (re-renders the same
  // content without disturbing an already-pending gate of the same kind).
  // A later-stage request always supersedes an earlier still-pending one.
  function activateGate(kind, message) {
    ensureTaskAttempt(message.taskId, message.attemptId);
    const card = approvalCardByKind[kind];
    if (!card) return;
    const rank = GATE_RANK[kind];

    // Supersede any earlier gate that is still marked pending — a
    // later-stage request always advances the lifecycle. This is a
    // supersede, not a resolution: gateResolvedDecision stays null so a
    // genuine (if delayed) resolution message for that gate can still land
    // and correctly overwrite this placeholder text.
    if (pendingGate && pendingGate !== kind && GATE_RANK[pendingGate] < rank) {
      const staleKind = pendingGate;
      disableGateControls(staleKind);
      const staleStatusEl = approvalStatusEl[staleKind];
      if (staleStatusEl) staleStatusEl.textContent = 'Historical — superseded';
      placeCardInline(staleKind, false);
    }

    gateRequested[kind] = true;
    pendingGate = kind;
    highestRequestedRank = Math.max(highestRequestedRank, rank);
    card.dataset.taskId = String(message.taskId ?? '');
    card.dataset.attemptId = String(message.attemptId ?? '');
    delete card.dataset.approvalDecision;
    enableGateControls(kind);
    placeCardInline(kind, true);
  }

  // Authoritative entry point for a proposal/mutation/delivery resolution.
  // Idempotent for duplicates: a second resolution for an already-resolved
  // gate is a no-op.
  function resolveGate(kind, taskId, decision) {
    if (!gateRequested[kind]) return;
    if (gateResolvedDecision[kind] !== null) return;
    gateResolvedDecision[kind] = decision;
    if (pendingGate === kind) pendingGate = null;
    disableGateControls(kind);
    const statusEl = kind === 'delivery' ? ensureDeliveryStatus() : approvalStatusEl[kind];
    if (statusEl) statusEl.textContent = approvalDecisionText(kind, decision);
    placeCardInline(kind, false);
  }

  // Once a non-terminal autonomous task snapshot has been observed, a later
  // generic/idle status label may never silently replace it — only an
  // explicit terminal task state (or a brand-new task starting) is allowed
  // to clear the lock. This prevents "Ready when you are." (or any other
  // idle-ish label) from overwriting a real "waiting for approval" status
  // after a reconnect/reload race.
  let autonomousStatusLocked = false;

  function setPandaState(state) {
    const known = PANDA_STATE_LABELS[state] ? state : 'idle';
    if (autonomousStatusLocked && known === 'idle') return;
    if (pandaIcon) {
      pandaIcon.dataset.state = known;
      const use = pandaIcon.querySelector('use');
      if (use) use.setAttribute('href', known === 'waiting_for_delivery_approval' ? '#kd-panda-approval' : '#kd-panda-head');
      applyPandaImage(pandaIcon, known);
    }
    if (pandaLabel) pandaLabel.textContent = PANDA_STATE_LABELS[known] || '';
    if (statusBox) {
      statusBox.classList.toggle('kd-dhadkan', known !== 'idle' && known !== 'completed' && known !== 'blocked' && known !== 'failed');
      statusBox.dataset.dhadkanState = known;
    }
  }

  const STAGE_INDEX_BY_STATE = {
    scheduled: 0, queued: 0, waiting_for_resources: 0, preparing: 0, running: 0,
    waiting_for_proposal_approval: 2, waiting_for_mutation_approval: 2,
    validating: 4, waiting_for_delivery_approval: 5, committing: 5,
    creating_pull_request: 5, monitoring_ci: 5, waiting_for_review: 5, completed: 6,
  };

  function renderTaskHeader(state, _goal, resolvedGates) {
    let current = STAGE_INDEX_BY_STATE[state] ?? 0;
    if (state === 'running' && resolvedGates?.mutation) current = 3;
    else if (state === 'running' && resolvedGates?.proposal) current = 2;
    else if ((state === 'running' || state === 'preparing') && currentGraphStageProgress()) current = currentGraphStageProgress().step;
    stageTracker?.querySelectorAll('li').forEach((item, index) => {
      item.classList.toggle('is-complete', index < current);
      item.classList.toggle('is-current', index === current);
      if (index === current) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
  }

  // Progress & Completion UX V1 (Step 10): the frozen M15 goal Core requires
  // (see AgentPanel.startAutonomousTask) is not always exactly what the user
  // typed this turn — on a continued objective it has a deterministic
  // constraints suffix appended (ConversationContinuity.ts
  // #formatCarriedConstraints: "\n\nConstraints carried forward from this
  // conversation: a; b."). Splitting it here is what lets the card show the
  // user's own wording and Karke Dikha's carried-forward constraints as two
  // visually distinct things, instead of quoting the whole frozen string as
  // if the user had said it themselves.
  const CARRIED_CONSTRAINTS_SUFFIX = /\n\nConstraints carried forward from this conversation: (.+)\.$/;
  function splitGoalConstraints(text) {
    const value = String(text || '');
    const match = CARRIED_CONSTRAINTS_SUFFIX.exec(value);
    if (!match) return { objective: value.trim(), constraints: [] };
    return {
      objective: value.slice(0, match.index).trim(),
      constraints: match[1].split(';').map(item => item.trim()).filter(Boolean),
    };
  }

  function showTaskRequest(text) {
    const { objective, constraints } = splitGoalConstraints(text);
    if (!objective) return;
    if (requestEntry) requestEntry.hidden = false;
    if (promptSummary) promptSummary.textContent = objective.length > 360 ? `${objective.slice(0, 357)}…` : objective;
    if (promptConstraints) {
      promptConstraints.innerHTML = '';
      promptConstraints.hidden = constraints.length === 0;
      for (const constraint of constraints) {
        const item = document.createElement('li');
        item.textContent = `Constraint: ${constraint}`;
        promptConstraints.appendChild(item);
      }
    }
  }

  function canonicalizeTaskConversation(text) {
    const value = String(text || '').trim();
    if (value && chatMessages) {
      // #task-request-entry is Karke Dikha's own objective card, never a
      // `.bubble.user` element (Step 10) — so this only ever removes a real
      // literal chat bubble the user sent, and only when it is an exact,
      // redundant duplicate of the FULL frozen goal (no carried constraints
      // were appended). When constraints ARE carried forward, the literal
      // bubble's text no longer matches this comparison and is correctly
      // left in place — the user's own wording must never be deleted just
      // because Karke Dikha's objective card also shows a derived fragment.
      for (const bubble of Array.from(chatMessages.querySelectorAll('.bubble.user'))) {
        if (String(bubble.textContent || '').trim() === value) bubble.remove();
      }
      showTaskRequest(value);
    }
    // Moving these stable nodes is idempotent and repairs the real unified
    // composer path, whose optimistic user bubble was appended after the
    // shell's original static position.
    if (chatMessages && requestEntry && !requestEntry.hidden) chatMessages.appendChild(requestEntry);
    if (chatMessages && statusBox) chatMessages.appendChild(statusBox);
  }

  function addFactOnce(key, text, state) {
    if (!timeline || timeline.querySelector(`[data-fact="${key}"]`)) return;
    const entry = document.createElement('div');
    entry.className = `timeline-fact state-${state || 'completed'}`;
    entry.dataset.fact = key;
    entry.textContent = text;
    timeline.appendChild(entry);
  }

  function renderDeliveryEvidence(evidence, state, branchName, diffReview, destinationBranch, taskBranchName, deliveryCommitSha) {
    if (!deliveryEvidence) return;
    deliveryEvidence.innerHTML = '';
    const facts = [];
    const isCompleted = state === 'completed';
    const changedCount = Number.isInteger(evidence?.changedFileCount) ? evidence.changedFileCount : null;
    const passCount = Number.isInteger(evidence?.validationPassCount) ? evidence.validationPassCount : null;
    const hasDiffReviewPass = evidence?.diffReviewVerdict === 'pass' || diffReview?.verdict === 'pass';
    const target = destinationBranch || evidence?.destinationBranch || (branchName && !branchName.startsWith('forge/') ? branchName : 'working branch');
    const taskBranch = taskBranchName || evidence?.taskBranchName;
    const commitSha = deliveryCommitSha || evidence?.deliveryCommitSha;
    const deliveryReached = evidence?.deliveryReached === true;

    if (isCompleted) {
      if (changedCount !== null) {
        facts.push(`✓ Changed ${changedCount} file${changedCount === 1 ? '' : 's'}`);
      } else {
        facts.push('✓ Changed files');
      }
      if (passCount !== null) {
        facts.push(`✓ ${passCount} check${passCount === 1 ? '' : 's'} passed`);
      }
      if (hasDiffReviewPass) {
        facts.push('✓ Diff review passed');
      }
      facts.push(`✓ Applied to ${target}`);
      if (commitSha) {
        facts.push(`Verified commit: ${commitSha.slice(0, 7)}`);
      }
      if (taskBranch) {
        facts.push(`Task branch: ${taskBranch}`);
      }
    } else if (state === 'waiting_for_delivery_approval') {
      facts.push('✓ Change prepared');
      if (passCount !== null) {
        facts.push(`✓ ${passCount} check${passCount === 1 ? '' : 's'} passed`);
      }
      if (hasDiffReviewPass) {
        facts.push('✓ Diff review passed');
      }
      facts.push('Ready to apply to your working files');
      if (commitSha) {
        facts.push(`Verified commit: ${commitSha.slice(0, 7)}`);
      }
      if (taskBranch) {
        facts.push(`Task branch: ${taskBranch}`);
      }
      if (evidence?.worktreeClean === false) {
        facts.push('Note: workspace has uncommitted changes');
      }
    } else if (deliveryReached) {
      facts.push('Delivery reached, but completion was blocked');
      if (commitSha) {
        facts.push(`Delivered commit: ${commitSha.slice(0, 7)}`);
      }
      if (evidence?.postDeliveryValidationStatus === 'failed') {
        facts.push('Delivered-state validation failed');
      }
      if (taskBranch) {
        facts.push(`Task branch: ${taskBranch}`);
      }
    } else {
      facts.push('Delivery not reached');
    }

    for (const fact of facts) {
      const row = document.createElement('div');
      row.textContent = fact;
      deliveryEvidence.appendChild(row);
    }

    if (deliveryCard) {
      const actions = deliveryCard.querySelector('.autonomous-actions');
      if (actions) actions.hidden = isCompleted;
      if (isCompleted) {
        const statusEl = ensureDeliveryStatus();
        if (statusEl) statusEl.textContent = `Applied to ${target}`;
        placeCardInline('delivery', false);
      }
    }
  }

  // Monotonic status-driven reconciliation. `state` is a snapshot that can
  // arrive out of order relative to the authoritative approval request/
  // resolution messages that drive activateGate/resolveGate above — so this
  // function may only ever *advance* the recorded gate, or reset it on a
  // genuinely new task/attempt/terminal state. It must never regress an
  // already-pending later-stage gate just because a stale or earlier
  // snapshot happened to arrive after it (rule: a stale `running` or
  // earlier status snapshot must not disable a currently pending
  // later-stage gate).
  function reconcileApprovalGates(taskId, state, attemptId) {
    ensureTaskAttempt(taskId, attemptId);

    if (AUTONOMOUS_TERMINAL_STATES.has(state)) {
      // Task is over: nothing can remain actionable, but resolved/pending
      // history for this task/attempt stays visible — only disable.
      if (pendingGate) {
        const endedGate = pendingGate;
        disableGateControls(endedGate);
        pendingGate = null;
      }
      return;
    }

    const derivedGate = GATE_BY_STATE[state] || null;
    if (!derivedGate) {
      // No gate implied by this state (e.g. running/validating/queued).
      // Never touch an already-pending gate on the strength of this alone.
      return;
    }

    if (gateRequested[derivedGate]) {
      // This gate has already been established by an explicit request
      // message — pending or resolved — so a status snapshot carries no
      // new information for it either way. In particular this prevents an
      // equal-or-earlier-rank stale snapshot from reactivating a gate that
      // has already been resolved.
      return;
    }

    const derivedRank = GATE_RANK[derivedGate];
    if (derivedRank < highestRequestedRank) {
      // Stale/earlier snapshot arriving after a later-stage gate has
      // already been requested — ignored for gate-actionability purposes.
      return;
    }

    // Defensive fallback only: a status snapshot claims a gate at or beyond
    // the highest one seen so far, but no explicit request message for it
    // has been processed yet (e.g. genuine race where status wins the
    // network race against the request event). Activate it exactly as the
    // request handler would.
    activateGate(derivedGate, { taskId, attemptId });
  }

  if (!modeSelect || !composer || !textarea) return;

  const INPUT_LIMIT_BYTES = 40000;
  let activeTaskId = null;
  let activeTaskState = 'idle';
  let pendingSubmissionId = null;
  let pendingSubmissionGoal = '';
  let stopPendingSubmission = false;
  let restoredSteerResent = false;
  const APPROVAL_STATES = new Set([
    'waiting_for_proposal_approval',
    'waiting_for_mutation_approval',
    'waiting_for_delivery_approval',
  ]);
  let contextRequested = false;
  const renderedEventIds = new Set();
  let deliveryTaskId = null;
  deliveryReview?.addEventListener('click', () => deliveryTaskId && deliveryTaskId === activeTaskId && vscode.postMessage({ type: 'reviewAutonomousChanges', taskId: deliveryTaskId }));
  deliveryApprove?.addEventListener('click', () => deliveryTaskId && deliveryTaskId === activeTaskId && vscode.postMessage({ type: 'approveAutonomousDelivery', taskId: deliveryTaskId }));
  deliveryReject?.addEventListener('click', () => deliveryTaskId && deliveryTaskId === activeTaskId && vscode.postMessage({ type: 'rejectAutonomousDelivery', taskId: deliveryTaskId }));
  const devToggle = document.getElementById('kd-developer-diagnostics-toggle');
  const devContent = document.getElementById('kd-developer-diagnostics-content');
  devToggle?.addEventListener('click', () => {
    if (!devContent) return;
    devContent.hidden = !devContent.hidden;
    devToggle.textContent = devContent.hidden ? '▸ Developer diagnostics' : '▾ Developer diagnostics';
    devToggle.setAttribute('aria-expanded', devContent.hidden ? 'false' : 'true');
  });
  let renderedBlockedTaskId = null;

  // C — tracks which task+state a terminal reveal has already fired for, so
  // a duplicate/repeat status poll for an already-terminal task never
  // re-scrolls the user.
  let revealedTerminalKey = null;
  function revealTaskMessageOnTerminal(taskId, state) {
    const key = `${taskId}:${state}`;
    if (revealedTerminalKey === key) return;
    revealedTerminalKey = key;
    revealTaskMessageInView();
  }

  // --- Coding proposal approval card ---
  let pendingProposal = null; // { taskId, proposalId, version }
  let proposalActionInFlight = false;

  function setProposalButtonsDisabled(disabled) {
    if (proposalApproveBtn) proposalApproveBtn.disabled = disabled;
    if (proposalReviseBtn) proposalReviseBtn.disabled = disabled;
    if (proposalRejectBtn) proposalRejectBtn.disabled = disabled;
    if (proposalRevisionSubmitBtn) proposalRevisionSubmitBtn.disabled = disabled;
  }

  function renderProposalCard(message) {
    // activateGate may reset gate state (new task/attempt) before stamping
    // pendingProposal, so it must run first.
    activateGate('proposal', message);
    pendingProposal = { taskId: message.taskId, proposalId: message.proposalId, version: message.version };
    proposalActionInFlight = false;
    if (proposalTitle) proposalTitle.textContent = `Coding proposal (v${message.version ?? 1})`;
    if (proposalSummary) proposalSummary.textContent = String(message.taskSummary ?? '');
    if (proposalOperations) {
      proposalOperations.innerHTML = '';
      for (const op of Array.isArray(message.operations) ? message.operations : []) {
        const li = document.createElement('li');
        li.textContent = `${op.type}: ${op.path} — ${op.reason}`;
        proposalOperations.appendChild(li);
      }
    }
    if (proposalValidation) {
      const commands = Array.isArray(message.validationCommands) ? message.validationCommands : [];
      proposalValidation.textContent = commands.length
        ? `Validation: ${commands.map(c => c.script || c.kind).join(', ')}`
        : '';
    }
    if (proposalWarnings) {
      const warnings = Array.isArray(message.warnings) ? message.warnings : [];
      proposalWarnings.textContent = warnings.length ? `Warnings: ${warnings.join('; ')}` : '';
    }
    if (proposalStatus) proposalStatus.textContent = 'Awaiting approval';
    if (proposalRevisionForm) proposalRevisionForm.hidden = true;
    setProposalButtonsDisabled(false);
  }

  proposalApproveBtn?.addEventListener('click', () => {
    if (!pendingProposal || proposalActionInFlight || pendingProposal.taskId !== activeTaskId) return;
    proposalActionInFlight = true;
    setProposalButtonsDisabled(true);
    vscode.postMessage({ type: 'approveProposal', taskId: pendingProposal.taskId, proposalId: pendingProposal.proposalId });
  });
  proposalRejectBtn?.addEventListener('click', () => {
    if (!pendingProposal || proposalActionInFlight || pendingProposal.taskId !== activeTaskId) return;
    proposalActionInFlight = true;
    setProposalButtonsDisabled(true);
    vscode.postMessage({ type: 'rejectProposal', taskId: pendingProposal.taskId, proposalId: pendingProposal.proposalId });
  });
  proposalReviseBtn?.addEventListener('click', () => {
    if (!pendingProposal || proposalActionInFlight || pendingProposal.taskId !== activeTaskId) return;
    if (proposalRevisionForm) proposalRevisionForm.hidden = false;
    if (proposalRevisionText) proposalRevisionText.value = '';
    proposalRevisionText?.focus();
  });
  proposalRevisionCancelBtn?.addEventListener('click', () => {
    if (proposalRevisionForm) proposalRevisionForm.hidden = true;
  });
  proposalRevisionSubmitBtn?.addEventListener('click', () => {
    if (!pendingProposal || proposalActionInFlight || pendingProposal.taskId !== activeTaskId) return;
    const instructions = (proposalRevisionText?.value || '').trim();
    if (!instructions) return;
    proposalActionInFlight = true;
    setProposalButtonsDisabled(true);
    vscode.postMessage({ type: 'requestProposalRevision', taskId: pendingProposal.taskId, proposalId: pendingProposal.proposalId, instructions });
  });

  function resolveProposalCard(message) {
    if (!pendingProposal || pendingProposal.taskId !== message.taskId || pendingProposal.proposalId !== message.proposalId) return;
    resolveGate('proposal', message.taskId, String(message.decision ?? ''));
  }

  // --- Mutation approval card ---
  let pendingMutation = null; // { taskId, requestId }
  let mutationActionInFlight = false;

  function renderMutationCard(message) {
    // activateGate may reset gate state (new task/attempt) before stamping
    // pendingMutation, so it must run first.
    activateGate('mutation', message);
    pendingMutation = { taskId: message.taskId, requestId: message.requestId };
    mutationActionInFlight = false;
    if (mutationTitle) mutationTitle.textContent = message.elevatedConfirmationRequired ? 'Elevated mutation approval required' : 'Mutation approval required';
    if (mutationSummary) {
      const targets = Array.isArray(message.targets) ? message.targets : [];
      const repair = message.repairPolicy?.maxCycles
        ? ` Automatic validation repair: up to ${message.repairPolicy.maxCycles} cycle(s), limited to these files and approved checks.`
        : '';
      mutationSummary.textContent = `${message.operationCount ?? targets.length} file(s): ${targets.join(', ')}.${repair}`;
    }
    if (mutationStatus) mutationStatus.textContent = 'Awaiting approval';
  }

  mutationApproveBtn?.addEventListener('click', () => {
    if (!pendingMutation || mutationActionInFlight || pendingMutation.taskId !== activeTaskId) return;
    mutationActionInFlight = true;
    if (mutationApproveBtn) mutationApproveBtn.disabled = true;
    if (mutationDenyBtn) mutationDenyBtn.disabled = true;
    vscode.postMessage({ type: 'approveMutation', taskId: pendingMutation.taskId, requestId: pendingMutation.requestId });
  });
  mutationDenyBtn?.addEventListener('click', () => {
    if (!pendingMutation || mutationActionInFlight || pendingMutation.taskId !== activeTaskId) return;
    mutationActionInFlight = true;
    if (mutationApproveBtn) mutationApproveBtn.disabled = true;
    if (mutationDenyBtn) mutationDenyBtn.disabled = true;
    vscode.postMessage({ type: 'denyMutation', taskId: pendingMutation.taskId, requestId: pendingMutation.requestId });
  });

  function resolveMutationCard(message) {
    if (!pendingMutation || pendingMutation.taskId !== message.taskId || pendingMutation.requestId !== message.requestId) return;
    resolveGate('mutation', message.taskId, String(message.decision ?? ''));
  }

  function readState() {
    return (typeof vscode.getState === 'function' && vscode.getState()) || {};
  }
  function writeState(patch) {
    if (typeof vscode.setState !== 'function') return;
    vscode.setState(Object.assign({}, readState(), patch));
  }

  function utf8ByteLength(text) {
    return new TextEncoder().encode(text).length;
  }

  function updateCounts() {
    const text = textarea.value;
    const chars = Array.from(text).length;
    const bytes = utf8ByteLength(text);
    counts.textContent = `${chars} characters · ${bytes} UTF-8 bytes · limit ${INPUT_LIMIT_BYTES.toLocaleString()} bytes`;
    const overLimit = bytes > INPUT_LIMIT_BYTES;
    counts.classList.toggle('over-limit', bytes > INPUT_LIMIT_BYTES);
    updateComposerAction(overLimit);
    return { chars, bytes };
  }

  function isActiveTask() {
    return Boolean(activeTaskId) && !AUTONOMOUS_TERMINAL_STATES.has(activeTaskState);
  }

  function updateComposerAction(overLimit = utf8ByteLength(textarea.value) > INPUT_LIMIT_BYTES) {
    const hasText = Boolean(textarea.value.trim());
    const active = isActiveTask() || Boolean(pendingSubmissionId);
    const boundTaskId = activeTaskId || '';
    startBtn.dataset.taskId = boundTaskId;
    if (autonomousStopBtn) autonomousStopBtn.dataset.taskId = boundTaskId;

    if (!active) {
      startBtn.dataset.action = 'send';
      startBtn.textContent = 'Send';
      startBtn.classList.remove('btn-danger');
      startBtn.classList.add('btn-primary');
      startBtn.disabled = overLimit || !hasText;
      if (autonomousStopBtn) autonomousStopBtn.hidden = true;
      return;
    }
    if (!hasText) {
      startBtn.dataset.action = 'stop';
      startBtn.textContent = 'Stop';
      startBtn.classList.remove('btn-primary');
      startBtn.classList.add('btn-danger');
      startBtn.disabled = false;
      if (autonomousStopBtn) autonomousStopBtn.hidden = true;
      return;
    }
    startBtn.dataset.action = APPROVAL_STATES.has(activeTaskState) ? 'update' : 'steer';
    startBtn.textContent = APPROVAL_STATES.has(activeTaskState) ? 'Update task' : 'Steer';
    startBtn.classList.remove('btn-danger');
    startBtn.classList.add('btn-primary');
    startBtn.disabled = overLimit;
    if (autonomousStopBtn) autonomousStopBtn.hidden = false;
  }

  function updateUnifiedComposerAction() {
    if (!unifiedSendBtn || !unifiedInput) return;
    if (!window.__kdWorkspaceRestored) {
      unifiedSendBtn.disabled = true;
      unifiedSendBtn.dataset.action = 'restoring';
      unifiedSendBtn.dataset.taskId = '';
      if (unifiedTaskStopBtn) unifiedTaskStopBtn.hidden = true;
      return;
    }
    const active = isActiveTask();
    const hasText = Boolean(unifiedInput.value.trim());
    if (!active) {
      unifiedSendBtn.dataset.taskId = '';
      if (window.__kdReadiness?.executionRunning) {
        // chat.js owns the running-state label/lock ("Queue next").
        window.__kdUpdateSendButtonState?.();
        if (unifiedTaskStopBtn) unifiedTaskStopBtn.hidden = true;
        return;
      }
      unifiedSendBtn.dataset.action = 'send';
      unifiedSendBtn.textContent = 'Send';
      unifiedSendBtn.setAttribute('aria-label', 'Send message');
      unifiedSendBtn.classList.remove('btn-danger');
      // The composer is editable while a plain Baat/Saath turn runs, so input
      // events reach here mid-run: chat.js (executionRunning) keeps owning the
      // running-state lock instead of this idle path re-enabling Send.
      unifiedSendBtn.disabled = Boolean(window.__kdReadiness?.executionRunning);
      if (unifiedTaskStopBtn) unifiedTaskStopBtn.hidden = true;
      return;
    }
    unifiedSendBtn.dataset.taskId = activeTaskId;
    unifiedSendBtn.disabled = false;
    if (!hasText) {
      unifiedSendBtn.dataset.action = 'stop';
      unifiedSendBtn.textContent = 'Stop';
      unifiedSendBtn.setAttribute('aria-label', 'Stop active task');
      unifiedSendBtn.classList.add('btn-danger');
      if (unifiedTaskStopBtn) unifiedTaskStopBtn.hidden = true;
      return;
    }
    unifiedSendBtn.dataset.action = APPROVAL_STATES.has(activeTaskState) ? 'update' : 'steer';
    unifiedSendBtn.textContent = APPROVAL_STATES.has(activeTaskState) ? 'Update task' : 'Steer';
    unifiedSendBtn.setAttribute('aria-label', unifiedSendBtn.textContent);
    unifiedSendBtn.classList.remove('btn-danger');
    if (unifiedTaskStopBtn) {
      unifiedTaskStopBtn.hidden = false;
      unifiedTaskStopBtn.disabled = false;
      unifiedTaskStopBtn.dataset.taskId = activeTaskId;
    }
  }

  function beginSubmission(text) {
    const goal = String(text || '').trim();
    if (!goal) return undefined;
    pendingSubmissionId = `submission-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    pendingSubmissionGoal = goal;
    window.__ollamaAgentLastAutonomousSubmission = goal;
    return pendingSubmissionId;
  }

  window.__kdAutonomousSubmission = Object.freeze({ begin: beginSubmission });

  function requestBoundStop(button) {
    const taskId = String(button?.dataset?.taskId || '');
    if (taskId) {
      button.disabled = true;
      vscode.postMessage({ type: 'cancelTask', taskId });
      return;
    }
    if (pendingSubmissionId) {
      stopPendingSubmission = true;
      button.disabled = true;
      button.textContent = 'Stopping…';
    }
  }

  function setMode(mode) {
    const isAutonomous = mode === 'autonomous';
    document.body.dataset.mode = mode;
    composer.hidden = !isAutonomous;
    inputArea.hidden = isAutonomous;
    if (isAutonomous && everydayPhase) everydayPhase.hidden = true;
    if (isAutonomous && !contextRequested) {
      contextRequested = true;
      vscode.postMessage({ type: 'getAutonomousComposerContext' });
    }
  }

  modeSelect.addEventListener('change', () => setMode(modeSelect.value));
  setMode(modeSelect.value);
  setPandaState('idle');

  // Static panda surfaces that don't track PandaState: the header brand
  // mark (always idle) and the two approval-attention surfaces.
  applyPandaImage(document.querySelector('.brand-mark.kd-panda-icon'), 'idle');
  applyPandaImage(document.querySelector('.autonomous-banner .kd-panda-icon'), 'waiting_for_delivery_approval');
  applyPandaImage(document.querySelector('#delivery-approval-card .kd-panda-icon'), 'waiting_for_delivery_approval');
  applyPandaImage(document.querySelector('#proposal-approval-card .kd-panda-icon'), 'waiting_for_delivery_approval');
  applyPandaImage(document.querySelector('#mutation-approval-card .kd-panda-icon'), 'waiting_for_delivery_approval');

  // Restore draft on load (survives panel hide/show and, via getState, a webview reload).
  const initialState = readState();
  const restoredPendingSteer = initialState.pendingAutonomousSteer
    && typeof initialState.pendingAutonomousSteer === 'object'
    ? initialState.pendingAutonomousSteer
    : null;
  let pendingSteerInFlight = restoredPendingSteer;
  if (typeof initialState.autonomousDraft === 'string') {
    textarea.value = initialState.autonomousDraft;
  }
  updateCounts();

  function resetAutonomyModeSelect() {
    if (autonomyModeSelect) {
      autonomyModeSelect.value = 'supervised';
    }
    writeState({ lastAutonomyMode: 'supervised' });
  }

  // Task-Scoped Autonomy: Every newly created autonomous task must default to
  // supervised unless the user explicitly selects hands_off for that specific
  // new task. Never restore hands_off from persisted webview state across
  // reloads or restarts.
  if (autonomyModeSelect) {
    autonomyModeSelect.value = 'supervised';
    if (initialState.lastAutonomyMode) {
      writeState({ lastAutonomyMode: 'supervised' });
    }
    autonomyModeSelect.addEventListener('change', () => {
      if (autonomyModeSelect.value !== 'hands_off') {
        writeState({ lastAutonomyMode: 'supervised' });
      }
    });
  }

  function queueTaskSteering(text, source) {
    if (!isActiveTask() || !String(text || '').trim() || pendingSteerInFlight) return false;
    const messageId = `steer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    const pendingSteer = {
      taskId: activeTaskId,
      messageId,
      message: String(text),
      source: source || 'autonomous-composer',
    };
    pendingSteerInFlight = pendingSteer;
    writeState({ pendingAutonomousSteer: pendingSteer });
    vscode.postMessage({
      type: 'steerTask',
      taskId: pendingSteer.taskId,
      message: pendingSteer.message,
      messageId,
    });
    return true;
  }

  // Frees the single pending-steer slot WITHOUT touching the composer text,
  // so an update that could not be applied stays available as a draft.
  function releasePendingSteer() {
    if (!pendingSteerInFlight) return;
    pendingSteerInFlight = null;
    writeState({ pendingAutonomousSteer: null });
    updateComposerAction();
    updateUnifiedComposerAction();
  }

  window.__kdActiveTaskSteering = Object.freeze({
    isActive: () => isActiveTask(),
    taskId: () => isActiveTask() ? activeTaskId : null,
    submit: text => queueTaskSteering(text, 'unified-composer'),
    cancel: () => {
      if (!isActiveTask()) return false;
      vscode.postMessage({ type: 'cancelTask', taskId: activeTaskId });
      return true;
    },
  });

  unifiedInput?.addEventListener('input', updateUnifiedComposerAction);
  unifiedSendBtn?.addEventListener('click', event => {
    if (!isActiveTask()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = unifiedInput.value.trim();
    if (text) {
      if (queueTaskSteering(text, 'unified-composer')) unifiedSendBtn.disabled = true;
    } else {
      unifiedSendBtn.disabled = true;
      vscode.postMessage({ type: 'cancelTask', taskId: activeTaskId });
    }
  }, true);
  unifiedInput?.addEventListener('keydown', event => {
    if (!isActiveTask() || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const text = unifiedInput.value.trim();
    if (text) {
      if (queueTaskSteering(text, 'unified-composer')) unifiedSendBtn.disabled = true;
    } else {
      unifiedSendBtn.disabled = true;
      vscode.postMessage({ type: 'cancelTask', taskId: activeTaskId });
    }
  }, true);
  unifiedTaskStopBtn?.addEventListener('click', () => {
    if (!isActiveTask()) return;
    unifiedTaskStopBtn.disabled = true;
    vscode.postMessage({ type: 'cancelTask', taskId: activeTaskId });
  });

  textarea.addEventListener('input', () => {
    writeState({ autonomousDraft: textarea.value });
    updateCounts();
    if (!errorBox.hidden) errorBox.hidden = true;
  });

  // Enter inserts a newline (default textarea behavior — no interception).
  // Ctrl+Enter is the only keyboard path to start the task.
  textarea.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      startTask();
    }
  });

  // Task-Scoped Autonomy V1 (STEP 8) — shows the ACTIVE task's own frozen
  // mode next to its objective card. Only ever driven by a durable message
  // field the host derived from the task record itself
  // (autonomousTaskStarted.autonomyMode / autonomousTaskStatus.autonomyMode)
  // — never re-read from the live #autonomy-mode-select, which only ever
  // decides the NEXT task's mode.
  function renderAutonomyBadge(mode) {
    if (!autonomyBadge) return;
    if (mode === 'hands_off') {
      autonomyBadge.textContent = 'Hands-off';
      autonomyBadge.hidden = false;
    } else {
      autonomyBadge.hidden = true;
    }
  }

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function startTask() {
    const { bytes } = updateCounts();
    const text = textarea.value;
    const action = String(startBtn.dataset.action || 'send');
    if (action === 'stop') {
      requestBoundStop(startBtn);
      return;
    }
    if (!text.trim()) return;
    if (bytes > INPUT_LIMIT_BYTES) {
      showError(`Task text is ${bytes} UTF-8 bytes; the limit is ${INPUT_LIMIT_BYTES}. Shorten it to continue.`);
      return;
    }
    errorBox.hidden = true;
    startBtn.disabled = true;
    if (action === 'steer' || action === 'update') {
      queueTaskSteering(text, 'autonomous-composer');
      return;
    }
    writeState({ autonomousLastSubmitted: text });
    beginSubmission(text);
    stopPendingSubmission = false;
    const selectedModel = document.getElementById('model-select');
    // Task-Scoped Autonomy V1 — read at the moment of submission only; the
    // task freezes whatever this says right now and never re-reads the
    // selector again for the life of that task (STEP 8's "a running task's
    // mode never changes even if the global selector changes later").
    const autonomyMode = autonomyModeSelect && autonomyModeSelect.value === 'hands_off' ? 'hands_off' : 'supervised';
    resetAutonomyModeSelect();
    vscode.postMessage({
      type: 'startAutonomousTask',
      text,
      model: String(selectedModel?.value || ''),
      submissionId: pendingSubmissionId,
      autonomyMode,
      conversationId: typeof currentConversationId !== 'undefined' ? currentConversationId : (window.__kdActiveConversationId || undefined),
    });
    textarea.value = '';
    writeState({ autonomousDraft: '' });
    updateCounts();
  }

  startBtn.addEventListener('click', startTask);
  autonomousStopBtn?.addEventListener('click', () => requestBoundStop(autonomousStopBtn));

  clearBtn.addEventListener('click', () => {
    textarea.value = '';
    writeState({ autonomousDraft: '' });
    updateCounts();
    errorBox.hidden = true;
    resetAutonomyModeSelect();
  });

  copyBtn.addEventListener('click', () => {
    vscode.postMessage({ type: 'copyAutonomousPromptDraft', text: textarea.value });
  });

  loadLastBtn.addEventListener('click', () => {
    const state = readState();
    if (typeof state.autonomousLastSubmitted === 'string' && state.autonomousLastSubmitted) {
      textarea.value = state.autonomousLastSubmitted;
      writeState({ autonomousDraft: textarea.value });
      updateCounts();
    }
  });

  openWorktreeBtn?.addEventListener('click', () => {
    if (activeTaskId) vscode.postMessage({ type: 'openAutonomousWorktree', taskId: activeTaskId });
  });

  copyDiagnosticsBtn?.addEventListener('click', () => {
    if (activeTaskId) vscode.postMessage({ type: 'copyAutonomousDiagnostics', taskId: activeTaskId });
  });

  function addTimelineEntry(stateLabel, text, options) {
    const opts = options || {};
    const entry = document.createElement('div');
    entry.className = `autonomous-timeline-entry state-${stateLabel}${opts.isSubagent ? ' is-subagent' : ''}`;
    if (activeTaskId) entry.dataset.taskId = activeTaskId;
    if (activeAttemptId) entry.dataset.attemptId = activeAttemptId;
    const dot = document.createElement('span');
    dot.className = 'kd-thread-node';
    dot.setAttribute('aria-hidden', 'true');
    entry.appendChild(dot);
    const body = document.createElement('span');
    body.className = 'kd-thread-body';
    const raw = String(text || '');
    const lines = raw.split(/\n/);
    const isLongDiagnostic = raw.length > 400 || lines.length > 4 || /Output tail:/i.test(raw);
    if (isLongDiagnostic) {
      const preview = lines.slice(0, 2).join('\n');
      body.textContent = preview;
      const diag = document.createElement('details');
      diag.className = 'kd-timeline-diagnostics';
      const summary = document.createElement('summary');
      summary.textContent = 'Technical details';
      const pre = document.createElement('pre');
      pre.textContent = raw;
      diag.append(summary, pre);
      entry.append(body, diag);
    } else {
      body.textContent = raw;
      entry.appendChild(body);
    }
    timeline.appendChild(entry);
    followLatestIfPinned();
    return entry;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'workspaceRestorationPending':
        window.__kdWorkspaceRestored = false;
        updateComposerAction();
        updateUnifiedComposerAction();
        break;
      case 'workspaceRestorationResolved':
        window.__kdWorkspaceRestored = true;
        updateComposerAction();
        updateUnifiedComposerAction();
        break;
      case 'autonomousComposerContext': {
        const setRow = (span, text) => {
          if (!span) return;
          span.textContent = text;
          const row = span.closest('div');
          if (row) row.hidden = !text || text === '—' || /unknown/i.test(text);
        };
        setRow(repoSpan, message.repositoryName ? String(message.repositoryName) : '');
        setRow(branchSpan, message.branch && message.branch !== 'unknown'
          ? `${message.branch}${message.headCommit && message.headCommit !== 'unknown' ? ` @ ${message.headCommit}` : ''}${message.dirty ? ' (dirty)' : ''}`
          : '');
        setRow(providerModelSpan, message.provider && message.model ? `${message.provider} / ${message.model}` : '');
        if (permissionSpan) permissionSpan.textContent = String(message.permissionProfile ?? 'normal');
        const repoHealthWarning = document.getElementById('repo-health-warning');
        const repoHealthFixBtn = document.getElementById('repo-health-fix-btn');
        const repoHealthDetails = document.getElementById('repo-health-details');
        if (repoHealthWarning) {
          repoHealthWarning.hidden = !message.hasTrackedRuntimeState;
          if (repoHealthFixBtn && repoHealthDetails && !repoHealthFixBtn.dataset.bound) {
            repoHealthFixBtn.dataset.bound = 'true';
            repoHealthFixBtn.addEventListener('click', () => {
              repoHealthDetails.hidden = !repoHealthDetails.hidden;
              repoHealthFixBtn.textContent = repoHealthDetails.hidden ? 'Show fix' : 'Hide fix';
            });
          }
        }
        break;
      }
      case 'autonomousTaskRejected': {
        pendingSubmissionId = null;
        pendingSubmissionGoal = '';
        stopPendingSubmission = false;
        startBtn.disabled = false;
        showError(`Task text is ${message.utf8ByteCount} UTF-8 bytes; the limit is ${message.limitBytes}. Shorten it and try again.`);
        updateComposerAction();
        updateUnifiedComposerAction();
        break;
      }
      case 'autonomousRetryStarted': {
        resetAutonomyModeSelect();
        const retryId = String(message.taskId ?? '');
        if (!retryId) break;
        if (message.predecessorAttemptId) {
          supersededAttemptIds.add(String(message.predecessorAttemptId));
        }
        if (activeAttemptId && message.attemptId && activeAttemptId !== String(message.attemptId)) {
          supersededAttemptIds.add(activeAttemptId);
        }
        // A retry is always a new attempt — never inherit approval-card
        // ownership from the previous attempt, even for the same task id.
        resetGateLifecycle(retryId, message.attemptId);
        activeTaskId = retryId;
        stampTaskMessage(retryId);
        resetProjectedTimeline();
        renderedBlockedTaskId = null;
        if (ambientPlaceholder) ambientPlaceholder.hidden = true;
        taskIdSpan.textContent = `Task: ${activeTaskId}`;
        attemptIdSpan.textContent = `Attempt: ${message.attemptId ?? ''}`;
        statusBox.hidden = false;
        autonomousStatusLocked = true;
        setPandaState('thinking');
        if (openWorktreeBtn) openWorktreeBtn.hidden = false;
        if (copyDiagnosticsBtn) copyDiagnosticsBtn.hidden = false;
        addTimelineEntry('queued', String(message.message || 'Retrying the previous blocked task.'));
        break;
      }
      case 'autonomousTaskActive': {
        // A non-terminal autonomous task already exists for this workspace
        // (found on reconnect/reload) — surface it immediately instead of
        // leaving the idle placeholder up during the async gap before the
        // first status poll resolves, and lock out idle/ready labels until
        // the task reaches a terminal state.
        const activeId = String(message.taskId ?? '');
        if (!activeId) break;
        if (isActiveTask() && activeTaskId !== activeId) break;
        const isNewProjection = activeTaskId !== activeId;
        ensureTaskAttempt(activeId, message.attemptId);
        activeTaskId = activeId;
        activeTaskState = String(message.state ?? 'running');
        if (isNewProjection) stampTaskMessage(activeId);
        canonicalizeTaskConversation(message.goal);
        if (ambientPlaceholder) ambientPlaceholder.hidden = true;
        taskIdSpan.textContent = `Task: ${activeTaskId}`;
        if (message.attemptId) attemptIdSpan.textContent = `Attempt: ${message.attemptId}`;
        statusBox.hidden = false;
        if (!AUTONOMOUS_TERMINAL_STATES.has(String(message.state ?? ''))) {
          autonomousStatusLocked = true;
          setPandaState(GATE_BY_STATE[message.state] ? 'waiting_for_delivery_approval' : 'thinking');
          if (!taskLineEl?.textContent) setTaskLine('Starting the task safely…');
        }
        reconcileApprovalGates(activeTaskId, String(message.state ?? ''), message.attemptId);
        updateComposerAction();
        updateUnifiedComposerAction();
        if (openWorktreeBtn) openWorktreeBtn.hidden = false;
        if (copyDiagnosticsBtn) copyDiagnosticsBtn.hidden = false;
        break;
      }
      case 'autonomousTaskStarted': {
        if (
          pendingSubmissionId
          && message.submissionId
          && String(message.submissionId) !== pendingSubmissionId
        ) break;
        const startedId = String(message.taskId ?? '');
        if (!startedId) break;
        const matchesPendingSubmission = Boolean(
          pendingSubmissionId
          && message.submissionId
          && String(message.submissionId) === pendingSubmissionId
        );
        if (activeTaskId && activeTaskId !== startedId && message.submissionId && !matchesPendingSubmission) break;
        const isNewProjection = activeTaskId !== startedId;
        // Acknowledgement is idempotent. If a status snapshot won the race,
        // retain its shell, event set, and lifecycle instead of clearing them.
        ensureTaskAttempt(startedId, message.attemptId);
        activeTaskId = startedId;
        if (isNewProjection || !activeTaskState) activeTaskState = String(message.state ?? 'queued');
        document.body.dataset.autonomousTaskActive = 'true';
        if (isNewProjection) stampTaskMessage(startedId);
        if (ambientPlaceholder) ambientPlaceholder.hidden = true;
        taskIdSpan.textContent = `Task: ${activeTaskId}`;
        attemptIdSpan.textContent = `Attempt: ${message.attemptId ?? ''}`;
        statusBox.hidden = false;
        if (openWorktreeBtn) openWorktreeBtn.hidden = false;
        if (copyDiagnosticsBtn) copyDiagnosticsBtn.hidden = false;
        if (isNewProjection) {
          resetProjectedTimeline();
        }
        renderedBlockedTaskId = null;
        autonomousStatusLocked = true;
        if (message.autonomyMode) activeTaskAutonomyMode = String(message.autonomyMode);
        if (isNewProjection) renderAutonomyBadge(message.autonomyMode);
        setPandaState('thinking');
        const submitted = String(message.goal || pendingSubmissionGoal || window.__ollamaAgentLastAutonomousSubmission || '');
        canonicalizeTaskConversation(submitted);
        setTaskLine(taskLineEl?.textContent || 'Starting the task safely…');
        if (!timeline.querySelector('[data-fact="durable-acknowledgement"]')) {
          const acknowledgement = addTimelineEntry('queued', 'Task accepted safely.');
          acknowledgement?.setAttribute('data-fact', 'durable-acknowledgement');
        }
        const shouldStop = stopPendingSubmission;
        pendingSubmissionId = null;
        pendingSubmissionGoal = '';
        stopPendingSubmission = false;
        updateComposerAction();
        updateUnifiedComposerAction();
        if (shouldStop) requestBoundStop(startBtn);
        resetAutonomyModeSelect();
        break;
      }
      case 'autonomousTaskRepositorySnapshot': {
        // Task-specific start-of-task snapshot; a foreign task never overwrites
        // the row of the task currently on screen.
        const snapshotTaskId = String(message.taskId ?? '');
        if (!snapshotTaskId || (activeTaskId && activeTaskId !== snapshotTaskId)) break;
        const snapshotText = message.branch && message.branch !== 'unknown'
          ? `${message.branch}${message.headCommit && message.headCommit !== 'unknown' ? ` @ ${message.headCommit}` : ''}`
          : '';
        if (repoSpan && message.repositoryName) repoSpan.textContent = String(message.repositoryName);
        if (branchSpan) {
          branchSpan.textContent = snapshotText;
          const row = branchSpan.closest('div');
          if (row) row.hidden = !snapshotText;
        }
        break;
      }
      case 'autonomousTaskStatus': {
        const statusTaskId = String(message.taskId ?? '');
        if (message.attemptId && supersededAttemptIds.has(String(message.attemptId))) break;
        if (isActiveTask() && activeTaskId !== statusTaskId) break;
        // Reveal on "needs projection", not "first projection". Restoring a
        // completed task replays its resolved approval cards, and those go
        // through activateGate/resolveGate -> ensureTaskAttempt, which sets
        // activeTaskId. When that replay wins the race against this status
        // snapshot, an `!activeTaskId` guard here would skip the only branch
        // that reveals and stamps a completed task's message: a terminal task
        // gets no `autonomousTaskActive` (it is filtered out as non-active),
        // statusBox is never re-hidden elsewhere, and every later status
        // message would re-hit the same guard — so the durable task would stay
        // permanently invisible in the reopened transcript.
        //
        // Mirrors the sibling autonomousTaskActive/autonomousTaskStarted
        // handlers: unhide and label unconditionally, stamp only when the
        // projection is genuinely new or has never been stamped.
        // stampTaskMessage also clears the task line and collapses the details
        // disclosure, so it must not re-run on every status poll.
        // The `activeTaskId === statusTaskId` arm is what fixes the race; the
        // `!activeTaskId` arm preserves the original first-projection case. A
        // status for a *different* task is still ignored here exactly as
        // before — the `statusTaskId !== activeTaskId` break below already
        // rejected it, and widening this guard to bare `if (statusTaskId)`
        // would newly let a stale/foreign snapshot re-stamp the wrapper away
        // from the task just projected once that task reached a terminal state.
        if (statusTaskId && (!activeTaskId || activeTaskId === statusTaskId)) {
          const isNewProjection = activeTaskId !== statusTaskId;
          ensureTaskAttempt(statusTaskId, message.attemptId);
          if (isNewProjection || !statusBox.dataset.kdTaskMessage) stampTaskMessage(statusTaskId);
          taskIdSpan.textContent = `Task: ${activeTaskId}`;
          if (message.attemptId) attemptIdSpan.textContent = `Attempt: ${message.attemptId}`;
          statusBox.hidden = false;
        }
        if (statusTaskId !== activeTaskId) break;
        canonicalizeTaskConversation(message.goal || pendingSubmissionGoal);
        if (message.attemptId) attemptIdSpan.textContent = `Attempt: ${message.attemptId}`;
        if (providerModelSpan && message.provider && message.model) {
          providerModelSpan.textContent = `${message.provider} / ${message.model}`;
          const row = providerModelSpan.closest('div');
          if (row) row.hidden = false;
        }
        const statusState = String(message.state ?? '');
        activeTaskState = statusState;
        // Terminal race: a steer still pending when the task ends can no longer
        // be applied. Release the slot; the text stays in the composer as an
        // ordinary unsent draft rather than vanishing or replaying elsewhere.
        if (AUTONOMOUS_TERMINAL_STATES.has(statusState)) releasePendingSteer();
        document.body.dataset.autonomousTaskActive = AUTONOMOUS_TERMINAL_STATES.has(statusState) ? 'false' : 'true';
        if (ambientPlaceholder) ambientPlaceholder.hidden = true;
        if (everydayPhase) everydayPhase.hidden = true;
        updateComposerAction();
        updateUnifiedComposerAction();
        renderTaskHeader(statusState, message.goal, message.resolvedGates);
        showTaskRequest(message.goal);
        // Also covers restart rehydration, where autonomousTaskStarted never
        // fires for an already-running task — this status message is the
        // only place its frozen mode is ever re-learned after a reload.
        if (message.autonomyMode) activeTaskAutonomyMode = String(message.autonomyMode);
        renderAutonomyBadge(message.autonomyMode);
        const isHandsOff = (message.autonomyMode ?? activeTaskAutonomyMode) === 'hands_off';
        if (message.proposalSummary) addFactOnce('proposal-summary', `Proposal: ${String(message.proposalSummary).slice(0, 500)}`, 'proposal');
        if (message.resolvedGates?.proposal) {
          addFactOnce('proposal-approved', isHandsOff ? 'Proposal automatically authorized' : 'Proposal approved', 'completed');
        }
        if (message.resolvedGates?.mutation) {
          addFactOnce('mutation-approved', isHandsOff ? 'Mutation automatically authorized' : 'Mutation approved', 'completed');
        }
        const isValidationFailure = message.failure?.classification === 'validation_failed' || Boolean(message.validationFailure) || (message.validationTotals && message.validationTotals.failed > 0);
        if (!isValidationFailure && (message.deliveryEvidence?.validationPassCount || (message.validationTotals && message.validationTotals.failed === 0))) {
          addFactOnce('validation-passed', 'Validation passed', 'completed');
        }
        if (message.diffReview?.verdict) {
          const isModelReviewed = Boolean(message.diffReview.reviewerModel) && message.diffReview.reviewerModel !== 'deterministic';
          const source = isModelReviewed
            ? `model review: ${message.diffReview.reviewerProvider}/${message.diffReview.reviewerModel}`
            : 'deterministic host checks only';
          const hostFindingCount =
            (message.diffReview.changedFileFindings?.length || 0) +
            (message.diffReview.validationFindings?.length || 0) +
            (message.diffReview.securityFindings?.length || 0);
          const summary = message.diffReview.verdict === 'pass'
            ? `Diff review passed (${source})`
            : `Diff review rejected (${source}${hostFindingCount ? `, ${hostFindingCount} deterministic finding(s)` : ''})`;
          addFactOnce('diff-review-verdict', summary, message.diffReview.verdict === 'pass' ? 'completed' : 'blocked');
        }
        if (message.failure?.classification === 'commit_scope_reconciliation_failed') {
          addFactOnce('commit-scope-blocked', `Delivery blocked: unexpected files detected at commit time (${message.failure.message || 'scope reconciliation failed'})`, 'blocked');
        }
        renderDeliveryEvidence(
          message.deliveryEvidence,
          statusState,
          message.branchName,
          message.diffReview,
          message.destinationBranch,
          message.taskBranchName,
          message.deliveryCommitSha,
        );
        autonomousStatusLocked = !AUTONOMOUS_TERMINAL_STATES.has(statusState);
        const taskEvents = Array.isArray(message.events) ? message.events : [];
        const latestEventPandaState = [...taskEvents]
          .reverse()
          .find(item => item && typeof item.pandaState === 'string')?.pandaState;
        for (const item of taskEvents) {
          const identity = `${activeTaskId}:${item.eventId ?? item.seq}`;
          if (renderedEventIds.has(identity)) continue;
          renderedEventIds.add(identity);
          if (item.renderedProgress) {
            addTimelineEntry(String(message.state ?? 'running'), String(item.renderedProgress), { isSubagent: Boolean(item.isSubagent) });
          }
          if (item.pandaState) setPandaState(String(item.pandaState));
          activeGraphStage = nextGraphStage(activeGraphStage, item.rawProgress);
          projectConversationalEvent(item, statusState, message.autonomyMode, message.branchName);
        }
        renderTaskHeader(statusState, message.goal, message.resolvedGates);
        if (message.resolvedGates?.proposal && !gateResolutionSeen.proposal) {
          gateResolutionSeen.proposal = true;
          addConversationalItem(isHandsOff ? '✓ Proposal automatically authorized' : '✓ Proposal approved', 'success', 'conv-proposal-approved');
        }
        if (message.resolvedGates?.mutation && !gateResolutionSeen.mutation) {
          gateResolutionSeen.mutation = true;
          addConversationalItem(isHandsOff ? '✓ Mutation automatically authorized' : '✓ Mutation approved', 'success', 'conv-mutation-approved');
        }
        if (message.diffReview?.verdict === 'pass') {
          addConversationalItem('✓ Diff review passed', 'success', 'conv-diff-review-pass');
        }
        setPandaState(resolveTaskPandaState(message, latestEventPandaState));
        if (message.state === 'blocked' && message.failure && renderedBlockedTaskId !== activeTaskId) {
          renderedBlockedTaskId = activeTaskId;
          setPandaState('blocked');
          addTimelineEntry('blocked', message.failure.classification ? `Blocked: ${message.failure.classification}` : 'Task blocked');
          if (message.failure.classification === 'validation_failed') {
            addConversationalItem('Blocked', 'failure', 'conv-blocked-state');
          }
          if (message.validationFailure) {
            const v = message.validationFailure;
            const details = [];
            if (v.commandLabel) details.push(`Validation command: ${v.commandLabel}`);
            if (typeof v.exitCode === 'number') details.push(`Exit code: ${v.exitCode}`);
            else if (v.timedOut) details.push('Timed out');
            if (typeof v.durationMs === 'number') details.push(`Duration: ${v.durationMs} ms`);
            if (v.retryAvailable) details.push('Retry available');
            if (v.stdoutStderrTail) details.push(`Output tail:\n${v.stdoutStderrTail}`);
            if (details.length) addTimelineEntry('blocked', details.join('\n'));
            addFactOnce('validation-failure-detail', details.join('\n'), 'blocked');
          }
        }
        if (message.state === 'waiting_for_delivery_approval') {
          deliveryTaskId = activeTaskId;
          setPandaState('waiting_for_delivery_approval');
          addFactOnce('current-delivery-gate', 'Current gate: delivery approval', 'current');
          addConversationalItem('Ready to apply', 'waiting', 'conv-ready-to-apply');
          setTaskLine('Ready to apply');
        }
        if (message.state === 'completed' && message.taskResult && message.taskResult.status !== 'completed') {
          // The runtime said "completed" but the host's evidence disagrees (promised file missing, validation failed):
          // never show the green applied state.
          setPandaState('blocked');
          const why = (message.taskResult.warnings && message.taskResult.warnings[0]) || 'The result did not match what was requested.';
          addConversationalItem(`✗ Incomplete: ${why}`, 'failure', 'conv-result-incomplete');
          setTaskLine('Incomplete');
        } else if (message.state === 'completed') {
          setPandaState('completed');
          const dest = message.destinationBranch || message.deliveryEvidence?.destinationBranch || (message.branchName && !message.branchName.startsWith('forge/') ? message.branchName : 'working branch');
          addConversationalItem(`✓ Applied to ${dest}`, 'success', 'conv-applied-main');
          setTaskLine('Completed');
        }
        // Run last: if this snapshot's derived gate wins the defensive
        // fallback inside reconcileApprovalGates (activateGate), its
        // placeCardInline call sets the more specific "Waiting for your
        // approval below." panda label — it must be the final writer this
        // tick, not overwritten by the generic setPandaState calls above.
        reconcileApprovalGates(activeTaskId, statusState, message.attemptId);
        if (
          restoredPendingSteer
          && !restoredSteerResent
          && restoredPendingSteer.taskId === activeTaskId
          && !AUTONOMOUS_TERMINAL_STATES.has(statusState)
        ) {
          restoredSteerResent = true;
          vscode.postMessage({
            type: 'steerTask',
            taskId: restoredPendingSteer.taskId,
            messageId: restoredPendingSteer.messageId,
            message: restoredPendingSteer.message,
          });
        }
        if (AUTONOMOUS_TERMINAL_STATES.has(statusState)) {
          resetAutonomyModeSelect();
          revealTaskMessageOnTerminal(activeTaskId, statusState);
        }
        break;
      }
      case 'proposalApprovalRequest': {
        const terminalHistory = AUTONOMOUS_TERMINAL_STATES.has(activeTaskState)
          && String(message.taskId ?? '') === activeTaskId;
        if (!terminalHistory) {
          activeTaskState = 'waiting_for_proposal_approval';
          updateComposerAction();
        }
        if (message.taskSummary) addFactOnce('proposal-summary', `Proposal: ${String(message.taskSummary).slice(0, 500)}`, 'proposal');
        // setPandaState must run before renderProposalCard: placeCardInline
        // (called from within activateGate) sets the more specific "Waiting
        // for your approval below." label, and must be the last writer.
        setPandaState('waiting_for_delivery_approval');
        renderProposalCard(message);
        break;
      }
      case 'proposalApprovalResolved': {
        resolveProposalCard(message);
        const isHandsOff = message.actor === 'hands_off_policy' || activeTaskAutonomyMode === 'hands_off';
        if (message.decision === 'approved') {
          addFactOnce('proposal-approved', isHandsOff ? 'Proposal automatically authorized' : 'Proposal approved', 'completed');
          if (!gateResolutionSeen.proposal) {
            gateResolutionSeen.proposal = true;
            addConversationalItem(isHandsOff ? '✓ Proposal automatically authorized' : '✓ Proposal approved', 'success', 'conv-proposal-approved');
          }
        }
        break;
      }
      case 'mutationApprovalRequest': {
        const terminalHistory = AUTONOMOUS_TERMINAL_STATES.has(activeTaskState)
          && String(message.taskId ?? '') === activeTaskId;
        if (!terminalHistory) {
          activeTaskState = 'waiting_for_mutation_approval';
          updateComposerAction();
        }
        setPandaState('waiting_for_delivery_approval');
        renderMutationCard(message);
        break;
      }
      case 'mutationApprovalResolved': {
        resolveMutationCard(message);
        const isHandsOff = message.actor === 'hands_off_policy' || activeTaskAutonomyMode === 'hands_off';
        if (message.decision === 'approved') {
          addFactOnce('mutation-approved', isHandsOff ? 'Mutation automatically authorized' : 'Mutation approved', 'completed');
          if (!gateResolutionSeen.mutation) {
            gateResolutionSeen.mutation = true;
            addConversationalItem(isHandsOff ? '✓ Mutation automatically authorized' : '✓ Mutation approved', 'success', 'conv-mutation-approved');
          }
        }
        break;
      }
      case 'deliveryApprovalRequest': {
        const terminalHistory = AUTONOMOUS_TERMINAL_STATES.has(activeTaskState)
          && String(message.taskId ?? '') === activeTaskId;
        if (!terminalHistory) {
          activeTaskState = 'waiting_for_delivery_approval';
          updateComposerAction();
        }
        setPandaState('waiting_for_delivery_approval');
        activateGate('delivery', message);
        deliveryTaskId = String(message.taskId ?? '');
        break;
      }
      case 'deliveryApprovalResolved': {
        if (String(message.taskId ?? '') !== deliveryTaskId) break;
        resolveGate('delivery', message.taskId, String(message.decision ?? 'approved'));
        break;
      }
      case 'autonomousDiagnosticsCopied': {
        addTimelineEntry('queued', 'Diagnostics summary copied to clipboard.');
        break;
      }
      case 'taskSteered': {
        if (String(message.taskId ?? '') !== activeTaskId) break;
        const state = readState();
        const pending = state.pendingAutonomousSteer;
        if (!message.messageId || pending?.messageId === message.messageId) {
          writeState({ pendingAutonomousSteer: null, autonomousDraft: '' });
          textarea.value = '';
          pendingSteerInFlight = null;
          window.dispatchEvent(new CustomEvent('kdSteeringAcknowledged', {
            detail: { taskId: activeTaskId, messageId: message.messageId },
          }));
        }
        startBtn.disabled = false;
        if (autonomousStopBtn) autonomousStopBtn.disabled = false;
        updateComposerAction();
        addTimelineEntry('running', 'Update queued — it will be applied at the next safe step.');
        break;
      }
      case 'taskSteerRejected': {
        if (String(message.taskId ?? '') !== activeTaskId) break;
        if (!message.messageId || pendingSteerInFlight?.messageId === message.messageId) {
          releasePendingSteer();
          showError(`Update was not applied: ${String(message.reason ?? 'the task could not accept it')}. Your text is still in the box.`);
        }
        break;
      }
      case 'taskCancelled': {
        if (String(message.taskId ?? '') !== activeTaskId) break;
        if (autonomousStopBtn) autonomousStopBtn.disabled = false;
        startBtn.disabled = false;
        resetAutonomyModeSelect();
        break;
      }
      case 'error': {
        // Only surface inline (beside the composer) when a Stop/Steer action
        // is in flight; other error sources already get a global toast
        // elsewhere and must not be silently swallowed here.
        if (startBtn.disabled || autonomousStopBtn?.disabled) {
          startBtn.disabled = false;
          if (autonomousStopBtn) autonomousStopBtn.disabled = false;
          showError(String(message.message ?? 'Action failed.'));
          updateComposerAction();
        }
        if (pendingSubmissionId && !activeTaskId) {
          pendingSubmissionId = null;
          pendingSubmissionGoal = '';
          updateComposerAction();
          updateUnifiedComposerAction();
        }
        break;
      }
      case 'newConversation':
      case 'conversationSelected': {
        resetAutonomyModeSelect();
        // Host-confirmed New Chat: drop every task-scoped owner so the fresh
        // conversation cannot inherit a task id, attempt, approval card,
        // steering target or pending steer from the previous one. (chat.js's
        // boundary filter already stops late events for the old task.)
        if (message.type === 'newConversation' && message.reset === true) {
          activeTaskId = null;
          activeTaskState = 'idle';
          pendingSubmissionId = null;
          pendingSubmissionGoal = '';
          stopPendingSubmission = false;
          pendingSteerInFlight = null;
          restoredSteerResent = true;
          renderedBlockedTaskId = null;
          revealedTerminalKey = null;
          resetGateLifecycle(null, null);
          resetProjectedTimeline();
          writeState({ pendingAutonomousSteer: null, autonomousDraft: '' });
          textarea.value = '';
          if (statusBox) {
            statusBox.hidden = true;
            delete statusBox.dataset.kdTaskMessage;
          }
          updateCounts();
          updateComposerAction();
          updateUnifiedComposerAction();
        }
        break;
      }
      default:
        break;
    }
    syncLiveExecutionSurface();
  });

  // One live execution surface: while a Karke task is mounted live, Kaam ka Dhaaga is the primary surface and the
  // legacy objective card / stage rail / progress list / task line / status header must not render beside it (chat-dhaaga.css
  // keys off this attribute). The approval cards stay: they are the actions the Dhaaga points at. These nodes remain in the
  // DOM only so older persisted-task code paths keep working; they are never a second live view.
  function syncLiveExecutionSurface() {
    if (statusBox && !statusBox.hidden) document.body.dataset.kdExecutionSurface = 'dhaaga';
    else delete document.body.dataset.kdExecutionSurface;
  }
})();
