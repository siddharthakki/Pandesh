(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  const select = document.getElementById('mode-select');
  const buttons = Array.from(document.querySelectorAll('.mode-button'));
  const activityToggle = document.getElementById('activity-toggle');
  const activityPanel = document.getElementById('activity-panel');
  const activityClose = document.getElementById('activity-close-btn');
  const activitySummary = document.getElementById('activity-summary');
  const historyToggle = document.getElementById('history-toggle');
  const historyDrawer = document.getElementById('history-drawer');
  const historyClose = document.getElementById('history-close-btn');
  const scrim = document.getElementById('drawer-scrim');
  const input = document.getElementById('user-input');
  const stopBtn = document.getElementById('stop-btn');
  const autonomousBanner = document.getElementById('autonomous-banner');
  const autonomousStatus = document.getElementById('autonomous-status');
  const phaseSentence = document.getElementById('everyday-phase-sentence');
  if (!vscode || !select) return;

  const labels = { chat: 'Baat Kar', agent: 'Saath Kar', autonomous: 'Karke Dikha', auto: 'Auto' };
  const readState = () => (typeof vscode.getState === 'function' && vscode.getState()) || {};
  const writeState = patch => vscode.setState?.(Object.assign({}, readState(), patch));

  function setMode(mode, focus) {
    if (!labels[mode]) return;
    const previous = select.value;
    if (input && previous !== mode && previous !== 'autonomous') writeState({ [`${previous}Draft`]: input.value });
    select.value = mode;
    if (previous !== mode) select.dispatchEvent(new Event('change', { bubbles: true }));
    if (input && previous !== mode && mode !== 'autonomous') input.value = String(readState()[`${mode}Draft`] || '');
    buttons.forEach(button => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('active', active);
      button.setAttribute('aria-checked', String(active));
      button.tabIndex = active ? 0 : -1;
    });
    writeState({ activeMode: mode });
    statusState.mode = labels[mode];
    vscode.postMessage({ type: 'webviewModeChanged', mode });
    if (focus) buttons.find(button => button.dataset.mode === mode)?.focus();
    updateAutonomousBanner();
    refreshReady();
    if (previous !== mode) closeAllOverlays();
  }

  buttons.forEach(button => {
    button.addEventListener('click', () => setMode(button.dataset.mode, false));
    button.addEventListener('keydown', event => {
      if (!['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const current = buttons.indexOf(button);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
        : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + buttons.length) % buttons.length;
      setMode(buttons[next].dataset.mode, true);
    });
  });
  select.addEventListener('change', () => setMode(select.value, false));
  input?.addEventListener('input', () => {
    if (select.value !== 'autonomous') writeState({ [`${select.value}Draft`]: input.value });
  });

  function closeDrawers() {
    if (activityPanel && !activityPanel.hidden) {
      activityPanel.hidden = true;
      activityToggle?.setAttribute('aria-expanded', 'false');
    }
    if (historyDrawer && !historyDrawer.hidden) {
      historyDrawer.hidden = true;
      historyToggle?.setAttribute('aria-expanded', 'false');
    }
    if (scrim) scrim.hidden = true;
  }

  function openDrawer(panel, toggleBtn) {
    closeAllOverlays();
    if (!panel) return;
    panel.hidden = false;
    toggleBtn?.setAttribute('aria-expanded', 'true');
    if (scrim) scrim.hidden = false;
  }

  function closeAllOverlays() {
    closeDrawers();
    closeAllMenus();
    setStatusPopover(false);
  }

  activityToggle?.addEventListener('click', () => {
    if (activityPanel?.hidden === false) closeDrawers();
    else openDrawer(activityPanel, activityToggle);
  });
  activityClose?.addEventListener('click', closeDrawers);
  historyToggle?.addEventListener('click', () => {
    if (historyDrawer?.hidden === false) closeDrawers();
    else openDrawer(historyDrawer, historyToggle);
  });
  historyClose?.addEventListener('click', closeDrawers);
  // Opening a conversation from History must reveal it: the drawer is an overlay, so leaving it open hides the restored transcript.
  historyDrawer?.addEventListener('click', event => {
    if (event.target?.closest?.('.conversation-item, .workbench-search-result')) closeDrawers();
  });
  scrim?.addEventListener('click', closeAllOverlays);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeAllOverlays();
  });

  function wireMenu(buttonId, menuId) {
    const button = document.getElementById(buttonId);
    const menu = document.getElementById(menuId);
    if (!button || !menu) return;
    button.addEventListener('click', event => {
      event.stopPropagation();
      const opening = menu.hidden;
      closeAllOverlays();
      if (opening) {
        menu.hidden = false;
        button.setAttribute('aria-expanded', 'true');
      }
    });
    menu.addEventListener('click', event => {
      if (event.target.closest?.('.menu-item')) menu.hidden = true;
    });
  }

  const allMenus = [
    ['overflow-menu-btn', 'overflow-menu'],
    ['autonomous-tools-btn', 'autonomous-tools-menu'],
  ];
  function closeAllMenus() {
    for (const [buttonId, menuId] of allMenus) {
      document.getElementById(menuId)?.setAttribute('hidden', '');
      document.getElementById(buttonId)?.setAttribute('aria-expanded', 'false');
    }
  }
  allMenus.forEach(([buttonId, menuId]) => wireMenu(buttonId, menuId));
  document.addEventListener('click', closeAllMenus);

  document.getElementById('oc-config-btn')?.addEventListener('click', event => {
    event.stopPropagation();
    vscode.postMessage({ type: 'openSetupReadiness' });
  });

  const statusToggle = document.getElementById('status-row-toggle');
  const statusPopover = document.getElementById('status-details-popover');
  const permissionChip = document.getElementById('permission-status-chip');
  function setStatusPopover(open) {
    if (statusPopover) statusPopover.hidden = !open;
    statusToggle?.setAttribute('aria-expanded', String(open));
    permissionChip?.setAttribute('aria-expanded', String(open));
  }
  statusToggle?.addEventListener('click', event => {
    event.stopPropagation();
    const opening = statusPopover.hidden;
    closeAllOverlays();
    if (opening) setStatusPopover(true);
  });
  permissionChip?.addEventListener('click', event => {
    event.stopPropagation();
    const opening = Boolean(statusPopover?.hidden);
    closeAllOverlays();
    if (opening) setStatusPopover(true);
  });
  document.addEventListener('click', event => {
    if (statusPopover && !statusPopover.hidden && !statusPopover.contains(event.target) && event.target !== statusToggle) {
      setStatusPopover(false);
    }
  });

  const statusText = document.getElementById('status-row-text');
  const statusState = { repo: '', mode: '', model: '', permission: '', ready: 'Ready' };
  const statusFlags = { blocked: false, pendingApproval: false, running: false, runningLabel: '', completed: false };
  function computeReadyLabel() {
    // The execution projection is the single authority for the current run's state (chat-dhaaga.js).
    // Once a run exists its phase decides, active or not: the legacy flags below must never contradict it
    // (a stale `running` flag used to keep "Working" on screen after the run completed).
    const run = window.__kdExecutionState;
    if (run && run.runId) {
      if (run.active) return run.statusText || 'Working';
      if (run.phase === 'completed') return 'Completed';
      if (run.phase === 'cancelled') return 'Stopped';
      if (run.phase === 'failed' || run.phase === 'blocked') return 'Needs attention';
      if (run.phase === 'needs_input') return 'Needs your input';
    }
    if (statusFlags.blocked) return 'Needs attention';
    if (statusFlags.pendingApproval) return 'Waiting for your approval below';
    if (statusFlags.running) return statusFlags.runningLabel || 'Running';
    if (statusFlags.completed) return 'Completed';
    return 'Ready';
  }
  document.addEventListener('kd:execution-state', () => refreshReady());
  function updateActivityBadge() {
    if (!activitySummary) return;
    const needsAttention = statusFlags.blocked;
    activitySummary.hidden = !needsAttention;
    activitySummary.textContent = needsAttention ? '!' : '';
  }
  function refreshReady() {
    statusState.ready = computeReadyLabel();
    renderStatusLine();
    updateActivityBadge();
  }
  function renderStatusLine() {
    // The operator context strip shows the same readiness label; it listens here instead of re-deriving it.
    document.dispatchEvent(new CustomEvent('kd:status-changed', { detail: { ready: statusState.ready, blocked: statusFlags.blocked, pendingApproval: statusFlags.pendingApproval, running: statusFlags.running } }));
    if (!statusText) return;
    // Workspace, mode, model, provider and governance are owned by the operator context strip. This row is only
    // the readiness label plus the disclosure for runtime details, so it never restates them.
    statusText.textContent = statusState.ready || 'Ready';
  }
  renderStatusLine();

  let autonomousApprovalPending = false;
  function updateAutonomousBanner() {
    if (!autonomousBanner) return;
    autonomousBanner.hidden = !(autonomousApprovalPending && select.value !== 'autonomous');
  }
  autonomousBanner?.addEventListener('click', () => setMode('autonomous', true));

  // Pending approvals are priority interactions. The autonomous renderer owns
  // the card and its controls; this coordinator only removes the nested-scroll
  // trap while a card is pending, brings it to the end of the visible viewport,
  // and focuses the primary action once for each task/attempt/gate.
  const chatMessages = document.getElementById('messages');
  const scheduleFrame = typeof window.requestAnimationFrame === 'function'
    ? callback => window.requestAnimationFrame(callback)
    : callback => window.setTimeout(callback, 0);
  let pendingApprovalContainer = null;
  let pendingApprovalActions = null;
  let focusedApprovalKey = '';
  let approvalFocusScheduled = false;

  function clearPendingApprovalPresentation() {
    if (pendingApprovalContainer) {
      pendingApprovalContainer.style.maxHeight = '';
      pendingApprovalContainer.style.overflowY = '';
      pendingApprovalContainer.style.overscrollBehavior = '';
      delete pendingApprovalContainer.dataset.pendingActionVisible;
    }
    if (pendingApprovalActions) {
      pendingApprovalActions.style.position = '';
      pendingApprovalActions.style.bottom = '';
      pendingApprovalActions.style.zIndex = '';
      pendingApprovalActions.style.paddingTop = '';
      pendingApprovalActions.style.borderTop = '';
      pendingApprovalActions.style.background = '';
    }
    pendingApprovalContainer = null;
    pendingApprovalActions = null;
  }

  function focusPrimaryApprovalAction(card) {
    const primary = card.querySelector('.btn-primary:not(:disabled)')
      || card.querySelector('button:not(:disabled), textarea:not(:disabled), input:not(:disabled), select:not(:disabled)');
    if (!primary) return;
    const key = [card.dataset.taskId || '', card.dataset.attemptId || '', card.id || 'approval'].join(':');
    if (key === focusedApprovalKey) return;
    focusedApprovalKey = key;
    try {
      primary.focus({ preventScroll: true });
    } catch {
      primary.focus();
    }
  }

  function prioritizePendingApproval() {
    approvalFocusScheduled = false;
    const card = document.querySelector('[data-inline-approval-state="pending"]:not([hidden])');
    if (!card || !card.parentElement) {
      clearPendingApprovalPresentation();
      return;
    }

    if (pendingApprovalContainer && pendingApprovalContainer !== card.parentElement) {
      clearPendingApprovalPresentation();
    }
    pendingApprovalContainer = card.parentElement;
    pendingApprovalContainer.dataset.pendingActionVisible = 'true';
    pendingApprovalContainer.style.maxHeight = 'none';
    pendingApprovalContainer.style.overflowY = 'visible';
    pendingApprovalContainer.style.overscrollBehavior = 'auto';

    pendingApprovalActions = card.querySelector('.autonomous-actions');
    if (pendingApprovalActions) {
      pendingApprovalActions.style.position = 'sticky';
      pendingApprovalActions.style.bottom = '0';
      pendingApprovalActions.style.zIndex = '2';
      pendingApprovalActions.style.paddingTop = '8px';
      pendingApprovalActions.style.borderTop = '1px solid var(--kd-border)';
      pendingApprovalActions.style.background = 'var(--vscode-editorWidget-background, var(--vscode-editor-background))';
    }

    const following = window.__kdLiveScroll?.isFollowing?.() !== false;
    if (following) {
      card.scrollIntoView({
        behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'end',
        inline: 'nearest',
      });
      window.__kdLiveScroll?.pinToLatest?.();
      if (chatMessages) chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    focusPrimaryApprovalAction(card);
  }

  function schedulePendingApprovalPriority() {
    if (approvalFocusScheduled) return;
    approvalFocusScheduled = true;
    scheduleFrame(prioritizePendingApproval);
  }

  // A lifecycle word such as "running" is not useful progress. Preserve the
  // latest real autonomous checkpoint, keep a compact recent trail, and update
  // a visible heartbeat on every host poll so the user can distinguish a long
  // model stage from a frozen extension.
  const TERMINAL_AUTONOMOUS_STATES = new Set(['completed', 'failed', 'blocked', 'cancelled']);
  const STATE_PROGRESS = {
    queued: 'Task queued — waiting for the governed worker',
    scheduled: 'Task scheduled — waiting for the governed worker',
    waiting_for_resources: 'Waiting for the resources needed to start safely',
    preparing: 'Preparing an isolated Git worktree',
    running: 'Running the governed repository workflow',
    waiting_for_proposal_approval: 'Waiting for coding-proposal approval',
    waiting_for_mutation_approval: 'Waiting for permission to write the approved files',
    validating: 'Running the approved validation checks',
    waiting_for_delivery_approval: 'Waiting for delivery approval',
    committing: 'Recording the approved result as a task-branch commit',
    creating_pull_request: 'Creating the draft pull request',
    updating_pull_request: 'Updating the draft pull request',
    monitoring_ci: 'Checking CI for the delivered change',
    waiting_for_review: 'Waiting for review of the delivered change',
    paused: 'Task paused',
  };
  let liveProgressTaskId = '';
  let liveProgressHeadline = '';
  let liveProgressDetail = '';
  let liveProgressCheckpoints = [];
  let liveProgressEventKeys = new Set();
  let pendingLiveProgressMessage = null;
  let liveProgressScheduled = false;
  let liveProgressTerminal = false;
  let terminalAutonomousTaskId = '';

  function progressFirstLine(value) {
    return String(value || '').split(/\r?\n/, 1)[0].trim().replace(/^\d{2}:\d{2}:\d{2}\s+/, '');
  }

  function progressDetail(value) {
    return String(value || '').split(/\r?\n/).slice(1, 4).map(line => line.trim()).filter(Boolean).join(' · ');
  }

  function resetLiveProgress(taskId) {
    liveProgressTaskId = String(taskId || '');
    liveProgressHeadline = '';
    liveProgressDetail = '';
    liveProgressCheckpoints = [];
    liveProgressEventKeys = new Set();
    liveProgressTerminal = false;
  }

  // M40 — this coordinator no longer builds its own top-of-status card
  // (`#kd-live-progress-card`), which used to fight chat-everyday.js's
  // outcome card for the same `insertBefore(..., firstChild)` slot. It now
  // writes the SAME `.kd-task-line` element inside the single
  // `.kd-task-message` wrapper (`#autonomous-status`) that chat-autonomous.js
  // owns, via the shared `window.__kdTaskLine.setTaskLine` writer — updating
  // one line's textContent in place rather than stacking cards.
  function writeTaskLine(text) {
    if (window.__kdTaskLine?.setTaskLine) {
      window.__kdTaskLine.setTaskLine(text);
      return;
    }
    // Fallback if chat-autonomous.js hasn't loaded yet (should not happen
    // given script load order, but never throw over a missing writer).
    const fallback = document.getElementById('kd-task-line');
    if (fallback) fallback.textContent = text;
  }

  function renderLiveProgress(message) {
    const incomingTaskId = message.taskId != null ? String(message.taskId) : '';
    if (liveProgressTaskId && incomingTaskId && incomingTaskId !== liveProgressTaskId) {
      return;
    }
    const taskId = incomingTaskId || liveProgressTaskId || '';
    if (taskId && taskId !== liveProgressTaskId) resetLiveProgress(taskId);
    const state = String(message.state || '');
    if (TERMINAL_AUTONOMOUS_STATES.has(state)) {
      liveProgressTerminal = true;
      if (heartbeatTimer) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      const terminalLabels = {
        completed: 'Completed',
        failed: 'Failed',
        blocked: 'Blocked',
        cancelled: 'Stopped',
      };
      writeTaskLine(terminalLabels[state] || 'Completed');
      return;
    }
    liveProgressTerminal = false;
    armHeartbeat();

    if (autonomousStatus) autonomousStatus.hidden = false;
    const events = Array.isArray(message.events) ? message.events : [];
    for (const item of events) {
      const rendered = String(item?.renderedProgress || '').trim();
      if (!rendered) continue;
      const key = String(item?.eventId ?? item?.seq ?? rendered);
      if (liveProgressEventKeys.has(key)) continue;
      liveProgressEventKeys.add(key);
      const headline = progressFirstLine(rendered);
      if (!headline) continue;
      liveProgressHeadline = headline;
      liveProgressDetail = progressDetail(rendered);
      liveProgressCheckpoints.push(headline);
      if (liveProgressCheckpoints.length > 6) liveProgressCheckpoints = liveProgressCheckpoints.slice(-6);
    }

    // While an internal graph stage is active, show its product-owned activity rather than stage/model prose.
    const graphStage = window.__kdGraphStage?.current?.();
    if (graphStage) {
      liveProgressHeadline = graphStage.activity;
      liveProgressDetail = graphStage.detail;
    }

    if (!liveProgressHeadline) {
      liveProgressHeadline = STATE_PROGRESS[state] || 'KarkeDikha is working on the governed task';
      liveProgressDetail = 'The extension is connected and checking durable task state every two seconds.';
    }

    const checkpointSuffix = liveProgressCheckpoints.length
      ? ` · ${liveProgressCheckpoints.length} checkpoint${liveProgressCheckpoints.length === 1 ? '' : 's'} received`
      : '';
    const lineText = liveProgressDetail
      ? `${liveProgressHeadline} — ${liveProgressDetail} · checked ${new Date().toLocaleTimeString()}${checkpointSuffix}`
      : `${liveProgressHeadline} · checked ${new Date().toLocaleTimeString()}${checkpointSuffix}`;
    writeTaskLine(lineText);
    if (phaseSentence) phaseSentence.textContent = `${liveProgressHeadline} · status checked ${new Date().toLocaleTimeString()}`;
  }

  // Heartbeat: when no new checkpoint has arrived for 5+ seconds, update the
  // SAME task-line text in place to "Still working · checked HH:MM:SS"
  // rather than appending a new row.
  let heartbeatTimer = null;
  let lastCheckpointAt = 0;
  function armHeartbeat() {
    lastCheckpointAt = Date.now();
    if (heartbeatTimer) return;
    heartbeatTimer = window.setInterval(() => {
      if (liveProgressTerminal) return;
      if (Date.now() - lastCheckpointAt < 5000) return;
      if (!liveProgressTaskId) return;
      writeTaskLine(`Still working · checked ${new Date().toLocaleTimeString()}`);
    }, 2000);
  }

  function scheduleLiveProgress(message) {
    pendingLiveProgressMessage = message;
    if (liveProgressScheduled) return;
    liveProgressScheduled = true;
    scheduleFrame(() => {
      liveProgressScheduled = false;
      const current = pendingLiveProgressMessage;
      pendingLiveProgressMessage = null;
      if (current) renderLiveProgress(current);
    });
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (message?.type === 'showActivity') openDrawer(activityPanel, activityToggle);
    if (!message) return;
    // A `modeExecutionStarted` announcement belongs to whichever mode was
    // selected at the moment its `sendMessage`/`classifyAndSend` was posted
    // (see chat-runtime-fixes.js's `announceExecution`). If it is still in
    // flight — or was queued behind a slow Core connect — when the user has
    // since picked a different mode in the ModeBar, it must not relabel the
    // status line out from under that fresh selection. Same currency check
    // already used below for `autonomousTaskActive`/approval-request events.
    if (message.type === 'modeExecutionStarted' && select.value === message.mode) {
      statusFlags.running = true;
      statusFlags.completed = false;
      statusFlags.blocked = false;
      statusFlags.runningLabel = message.mode === 'chat' ? 'Waiting for response'
        : message.mode === 'ask' ? 'Inspecting repository'
        : message.mode === 'plan' ? 'Preparing plan'
        : 'Working with tools';
      if (message.modeLabel) statusState.mode = String(message.modeLabel);
      if (stopBtn) stopBtn.hidden = false;
    }
    // A restored or switched conversation starts from the authoritative execution projection, never from legacy
    // flags left by whatever ran before (a stale `running` flag is what kept "Working" on screen after a restore).
    if (message.type === 'restoreTranscript' || message.type === 'conversationSelected' || message.type === 'newConversation') {
      statusFlags.running = false;
      statusFlags.runningLabel = '';
      statusFlags.completed = false;
      refreshReady();
    }
    if (message.type === 'toolStart') {
      statusFlags.running = true;
      statusFlags.runningLabel = `Running ${String(message.toolName || 'tool')}`;
      if (stopBtn) stopBtn.hidden = false;
    }
    if (message.type === 'modelSelected') {
      statusState.model = message.model ? String(message.model) : '';
      statusFlags.running = true;
      if (!statusFlags.runningLabel) statusFlags.runningLabel = 'Waiting for response';
    }
    if (message.type === 'modelsLoaded') {
      const availableModels = new Set(
        (Array.isArray(message.models) ? message.models : [])
          .map(model => String(model?.name || ''))
          .filter(Boolean),
      );
      const persisted = String(readState().selectedModel || '');
      const configured = String(message.selectedModel || '');
      const noUsableModels = Boolean(message.noUsableModels);
      const persistedAvailable = Boolean(persisted) && availableModels.has(persisted);
      const configuredModelAvailable = Boolean(configured) && availableModels.has(configured);

      statusState.model = persistedAvailable
        ? persisted
        : configuredModelAvailable
          ? configured
          : configured
            ? `${configured} unavailable`
            : noUsableModels
              ? 'No usable model installed'
              : '';

      if (configured && !configuredModelAvailable && !persistedAvailable) {
        statusFlags.blocked = true;
        statusFlags.completed = false;
      } else if (noUsableModels) {
        statusFlags.blocked = true;
        statusFlags.completed = false;
      }
    }
    if (message.type === 'done') {
      statusFlags.running = false;
      statusFlags.blocked = false;
      statusFlags.completed = true;
      if (stopBtn) stopBtn.hidden = true;
    }
    if (message.type === 'stopped') {
      statusFlags.running = false;
      if (stopBtn) stopBtn.hidden = true;
    }
    if (message.type === 'error') {
      statusFlags.blocked = true;
      statusFlags.running = false;
      if (stopBtn) stopBtn.hidden = true;
    }
    if (message.type === 'autonomousTaskStatus') {
      const latestProgress = Array.isArray(message.events)
        ? [...message.events].reverse().find(item => item?.renderedProgress)?.renderedProgress
        : message.renderedProgress;
      if (latestProgress) {
        statusFlags.running = true;
        statusFlags.runningLabel = progressFirstLine(latestProgress).slice(0, 80);
      }
      if (message.state === 'blocked' || message.state === 'failed') {
        statusFlags.running = false;
        statusFlags.blocked = true;
      }
      if (message.state === 'cancelled') statusFlags.running = false;
      if (message.state === 'completed') {
        statusFlags.running = false;
        statusFlags.pendingApproval = false;
        statusFlags.completed = true;
      }
      if (TERMINAL_AUTONOMOUS_STATES.has(message.state)) {
        terminalAutonomousTaskId = String(message.taskId || '');
      }
      if (TERMINAL_AUTONOMOUS_STATES.has(message.state) && stopBtn) stopBtn.hidden = true;
      schedulePendingApprovalPriority();
      scheduleLiveProgress(message);
    }
    if (message.type === 'autonomousComposerContext') {
      statusState.repo = message.repositoryName ? String(message.repositoryName) : statusState.repo;
      if (select.value === 'autonomous') statusState.model = message.model ? String(message.model) : statusState.model;
      statusState.permission = '';
    }
    if (message.type === 'autonomousTaskActive') {
      if (!TERMINAL_AUTONOMOUS_STATES.has(String(message.state || ''))) {
        terminalAutonomousTaskId = '';
      }
      if (select.value !== 'autonomous') setMode('autonomous', false);
      scheduleLiveProgress(message);
    }
    if (['proposalApprovalRequest', 'mutationApprovalRequest', 'deliveryApprovalRequest'].includes(message.type)) {
      if (terminalAutonomousTaskId && terminalAutonomousTaskId === String(message.taskId || '')) {
        refreshReady();
        return;
      }
      autonomousApprovalPending = true;
      statusFlags.pendingApproval = true;
      if (select.value !== 'autonomous') setMode('autonomous', false);
      updateAutonomousBanner();
      schedulePendingApprovalPriority();
      const state = message.type === 'proposalApprovalRequest'
        ? 'waiting_for_proposal_approval'
        : message.type === 'mutationApprovalRequest'
          ? 'waiting_for_mutation_approval'
          : 'waiting_for_delivery_approval';
      scheduleLiveProgress({ ...message, state });
    }
    if (['proposalApprovalResolved', 'mutationApprovalResolved', 'deliveryApprovalResolved'].includes(message.type)) {
      if (terminalAutonomousTaskId && terminalAutonomousTaskId === String(message.taskId || '')) {
        refreshReady();
        return;
      }
      autonomousApprovalPending = false;
      statusFlags.pendingApproval = false;
      updateAutonomousBanner();
      schedulePendingApprovalPriority();
    }
    if (message.type === 'autonomousTaskStarted' || message.type === 'autonomousRetryStarted') {
      terminalAutonomousTaskId = '';
      statusFlags.running = true;
      statusFlags.completed = false;
      statusFlags.blocked = false;
      statusFlags.runningLabel = message.type === 'autonomousRetryStarted' ? 'Starting safe retry' : 'Starting governed task';
      if (stopBtn) stopBtn.hidden = false;
      resetLiveProgress(message.taskId);
      scheduleLiveProgress({ ...message, state: 'queued' });
    }
    refreshReady();
  });

  // Approval-card DOM lifecycle, visibility, placement, ordering, button state,
  // and status text are owned exclusively by chat-autonomous.js. This file
  // coordinates viewport priority, one-time keyboard focus, and the read-only
  // live progress projection shown to the user.

  const state = readState();
  setMode(labels[state.activeMode] ? state.activeMode : select.value, false);
  vscode.postMessage({ type: 'webviewReady', mode: select.value });
})();
