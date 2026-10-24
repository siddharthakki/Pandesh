// @ts-nocheck
(function () {
  'use strict';

  const LOG = (...a) => console.log('[OllamaAgent]', ...a);

  const vscode = acquireVsCodeApi();

  // ── DOM refs ───────────────────────────────────────────────────────────────
  const messages       = document.getElementById('messages');
  const userInput      = document.getElementById('user-input');
  const sendBtn        = document.getElementById('send-btn');
  const stopBtn        = document.getElementById('stop-btn');
  const clearBtn       = document.getElementById('clear-btn');
  const modeSelect     = document.getElementById('mode-select');   // agent / chat
  const modelSelect    = document.getElementById('model-select');  // model list from Ollama
  const permissionSelect = document.getElementById('permission-profile-select');
  const permissionCapabilities = document.getElementById('permission-capabilities');
  const permissionStatusLabel = document.getElementById('permission-status-label');
  const permissionSummaryLabel = document.getElementById('permission-summary-label');
  const permissionSummaryDescription = document.getElementById('permission-summary-description');
  const permissionUseDefault = document.getElementById('permission-use-default');
  const contextModel = document.getElementById('context-model');
  const contextStatus = document.getElementById('context-status');
  const contextSummary = document.getElementById('context-summary');
  const contextBreakdown = document.getElementById('context-breakdown');
  const contextMeterFill = document.getElementById('context-meter-fill');
  const repoIntelTitle = document.getElementById('repo-intel-title');
  const repoIntelState = document.getElementById('repo-intel-state');
  const repoIntelMeta = document.getElementById('repo-intel-meta');
  const repoIntelStats = document.getElementById('repo-intel-stats');
  const repoIntelSelected = document.getElementById('repo-intel-selected');
  const repoIntelRebuild = document.getElementById('repo-intel-rebuild');
  const repoIntelPause = document.getElementById('repo-intel-pause');
  const repoIntelResume = document.getElementById('repo-intel-resume');
  const attachBtn      = document.getElementById('attach-btn');
  const attachmentsRow = document.getElementById('attachments-row');

  // ── State ──────────────────────────────────────────────────────────────────
  let isRunning              = false;
  let currentAssistantBubble = null;
  let pendingAttachments     = [];
  let currentConversationId  = 'default';
  let transcriptRestored     = false; // guards restoreTranscript to render at most once per webview load
  // Progress & Completion UX V1 (Step 4): truthful long-wait wording for
  // ordinary Baat/Saath turns. No fake progress — only elapsed time (always
  // knowable) and the model actually resolved for this turn (also always
  // knowable: AgentPanel.sendToAgent posts `modelSuitability` with the real
  // routing evidence before Core executes the attempt, well before any
  // long wait begins). Falls back to what the user explicitly picked in the
  // model dropdown, then to a model-free label — never a guess.
  let thinkingStartedAt = 0;
  let thinkingTimer = null;
  let thinkingResolvedModel = '';
  let thinkingResolvedProvider = '';
  let permissionState        = null;
  window.__kdReadiness = {
    executionRunning: false,
    coreReady: false,
    coreStatus: 'unknown',
    workspaceContextReady: false,
    historyReady: false,
    fatalError: false
  };
  window.__kdWorkspaceRestored = false;

  function updateSendButtonState() {
    if (window.__kdActiveTaskSteering?.isActive?.()) {
      return;
    }
    const text = userInput ? userInput.value.trim() : '';
    const hasInput = text.length > 0 || pendingAttachments.length > 0;
    const uploadingCount = pendingAttachments.filter((att) => att.status === 'uploading').length;
    const isFatal = Boolean(window.__kdReadiness && window.__kdReadiness.fatalError);

    // While a plain Baat/Saath turn runs, Send becomes "Queue next": one bounded
    // follow-up may wait for its own fresh turn (never injected into the run).
    if (isRunning) {
      const canQueue = text.length > 0 && !pendingNextTurn && !isFatal;
      sendBtn.disabled = !canQueue;
      sendBtn.textContent = 'Queue next';
      sendBtn.dataset.action = 'queue-next';
      sendBtn.title = pendingNextTurn
        ? 'One message is already queued for the next turn.'
        : 'Queue this as your next message — it runs after the current turn.';
      return;
    }
    delete sendBtn.dataset.action;
    const disabled = !hasInput || uploadingCount > 0 || isRunning || isFatal;
    if (sendBtn) {
      sendBtn.disabled = disabled;
      if (!isRunning) {
        sendBtn.innerHTML = 'Send';
      }
    }
  }

  // ── Bounded next-turn queue (Baat/Saath only) ──────────────────────────────
  // Maximum ONE pending message, scoped to the conversation it was typed in.
  // It is never merged into the running request/tool/approval; it becomes an
  // ordinary new turn (fresh routing) after the current turn ends.
  let pendingNextTurn = null; // { conversationId, text, createdAt }
  let queueStrip = null;

  function ensureQueueStrip() {
    if (queueStrip) return queueStrip;
    const anchor = document.getElementById('action-row');
    if (!anchor || !anchor.parentNode) return null;
    queueStrip = document.createElement('div');
    queueStrip.id = 'next-turn-queue';
    queueStrip.className = 'action-row';
    queueStrip.hidden = true;
    queueStrip.setAttribute('role', 'status');
    anchor.parentNode.insertBefore(queueStrip, anchor);
    return queueStrip;
  }

  function renderQueueStrip() {
    const strip = ensureQueueStrip();
    if (!strip) return;
    strip.textContent = '';
    if (!pendingNextTurn) { strip.hidden = true; return; }
    const label = document.createElement('span');
    label.className = 'queued-label';
    const preview = pendingNextTurn.text.length > 80 ? pendingNextTurn.text.slice(0, 77) + '…' : pendingNextTurn.text;
    label.textContent = (isRunning ? 'Queued for next turn: ' : 'Queued (not sent): ') + preview;
    strip.appendChild(label);
    if (!isRunning) {
      const sendNow = document.createElement('button');
      sendNow.type = 'button'; sendNow.className = 'btn btn-ghost'; sendNow.dataset.action = 'send-queued';
      sendNow.textContent = 'Send now';
      sendNow.addEventListener('click', () => dispatchQueuedNextTurn());
      strip.appendChild(sendNow);
    }
    const discard = document.createElement('button');
    discard.type = 'button'; discard.className = 'btn btn-ghost'; discard.dataset.action = 'discard-queued';
    discard.textContent = 'Discard';
    discard.addEventListener('click', () => clearPendingNextTurn());
    strip.appendChild(discard);
    strip.hidden = false;
  }

  function clearPendingNextTurn() {
    pendingNextTurn = null;
    renderQueueStrip();
    updateSendButtonState();
  }

  function queueNextTurn(text) {
    if (pendingNextTurn || !text) return false;
    pendingNextTurn = { conversationId: currentConversationId, text, createdAt: Date.now() };
    userInput.value = '';
    userInput.style.height = '';
    renderQueueStrip();
    updateSendButtonState();
    return true;
  }

  // Sends the queued text as a normal new turn through the same click path a
  // user takes, so routing is evaluated fresh (no inherited mode). A queued
  // message that belongs to another conversation is discarded, never sent.
  function dispatchQueuedNextTurn() {
    const queued = pendingNextTurn;
    if (!queued || isRunning) return false;
    if (queued.conversationId !== currentConversationId) { clearPendingNextTurn(); return false; }
    const draft = userInput.value;
    pendingNextTurn = null;
    userInput.value = queued.text;
    updateSendButtonState();
    sendBtn.click();
    if (userInput.value === queued.text && !isRunning) {
      // Send was blocked (e.g. still restoring): keep it, never lose it.
      pendingNextTurn = queued;
    }
    userInput.value = draft;
    renderQueueStrip();
    updateSendButtonState();
    return !pendingNextTurn;
  }
  window.__kdNextTurnQueue = Object.freeze({
    pending: () => (pendingNextTurn ? { ...pendingNextTurn } : null),
  });
  window.__kdUpdateSendButtonState = updateSendButtonState;

  // toolName → last running card element
  const runningCards = new Map();
  // approval IDs already resolved — guards against double-click
  const resolvedApprovals = new Set();

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function scrollBottom(target) {
    const previousScrollBehavior = messages.style.scrollBehavior;
    messages.style.scrollBehavior = 'auto';
    const apply = () => {
      messages.scrollTop = messages.scrollHeight;
      if (target && typeof target.scrollIntoView === 'function') {
        target.scrollIntoView({ block: 'end', inline: 'nearest', behavior: 'instant' });
      }
    };
    apply();
    // Approval cards can arrive in the same turn that the phase/recommendation
    // area changes height. Re-apply after layout settles so the newly rendered
    // Approve/Reject controls remain inside the active message viewport rather
    // than being clipped behind the sticky composer.
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        apply();
        requestAnimationFrame(apply);
      });
    }
    setTimeout(apply, 50);
    setTimeout(() => {
      apply();
      messages.style.scrollBehavior = previousScrollBehavior;
    }, 100);
  }

  function attachmentKindIcon(kind) {
    if (kind === 'image') return '🖼';
    if (kind === 'audio') return '🎵';
    if (kind === 'document') return '📄';
    return '📄';
  }

  function setRunning(running) {
    isRunning          = running;
    if (window.__kdReadiness) {
      window.__kdReadiness.executionRunning = running;
    }
    // The composer text stays editable while work runs so a follow-up can be
    // drafted (and is never lost). Only submission is gated: with a steerable
    // Karke Dikha task the unified composer routes Send to steering; a plain
    // Baat/Saath turn has no steering channel, so Send waits for the turn to
    // end (or Stop) and the draft stays in the box. Attachments remain locked
    // because their upload lifecycle is not safe mid-run.
    userInput.disabled = false;
    attachBtn.disabled = running;
    stopBtn.hidden = !running;
    if (running) {
      updateSendButtonState(); // "Queue next" (bounded next-turn queue)
    } else {
      sendBtn.removeAttribute('title');
      updateSendButtonState();
    }
  }

  // ── Conversation boundary (single owner) ───────────────────────────────────
  // A host-confirmed New Chat (`newConversation` with `reset: true`) is a hard
  // presentation reset. This capture-phase filter runs before every other
  // webview script's message listener (chat.js loads first), so a late event
  // from the previous conversation's run or task can never repaint the fresh
  // conversation, and no other script needs its own stale-event guard.
  //   - task-scoped messages for a task seen before the reset are dropped;
  //   - run-scoped messages are dropped until the user submits something new.
  const seenTaskIds = new Set();
  let detachedTaskIds = new Set();
  const liveTaskIds = new Set();
  const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked', 'rejected']);
  let runEventsDetached = false;
  const RUN_SCOPED_TYPES = new Set([
    'token', 'toolStart', 'toolResult', 'approvalRequest', 'done', 'stopped', 'modelSuitability',
  ]);
  // Conversation epoch: the host stamps `epoch` on the reset and on every hydration message. Anything stamped with an
  // older epoch than the last confirmed reset belongs to a replaced conversation and is dropped here, for every script.
  // Between a New Chat click and the host's confirmation, restore-type messages are held back so a hydration that was
  // already in flight cannot repaint the old conversation.
  let hostEpoch = 0;
  let newChatPendingUntil = 0;
  const HYDRATION_TYPES = new Set(['restoreTranscript', 'restoreCapabilityApprovalCard', 'conversationContinuity', 'autonomousTaskActive', 'autonomousTaskStatus']);
  document.addEventListener('click', (event) => {
    const target = event.target && event.target.closest ? event.target.closest('#new-conversation-toolbar-btn, #new-conversation-btn') : null;
    if (target) { newChatPendingUntil = Date.now() + 8000; }
  }, true);
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== 'object') { return; }
    if (msg.type === 'newConversation' && msg.reset === true) {
      if (typeof msg.epoch === 'number') { hostEpoch = Math.max(hostEpoch, msg.epoch); }
      newChatPendingUntil = 0;
      transcriptRestored = true; // a fresh conversation has nothing to restore; selecting History re-arms this
    } else {
      if (typeof msg.epoch === 'number' && msg.epoch < hostEpoch) { event.stopImmediatePropagation(); return; }
      if (newChatPendingUntil > Date.now()) {
        if (msg.type === 'error') { newChatPendingUntil = 0; }
        else if (HYDRATION_TYPES.has(msg.type) && msg.reset !== true) { event.stopImmediatePropagation(); return; }
      }
    }
    if (msg.type === 'newConversation' && msg.reset === true) {
      detachedTaskIds = new Set(seenTaskIds);
      runEventsDetached = true;
      runningCards.clear();
      currentAssistantBubble = null;
      pendingAttachments = [];
      removeThinking();
      pendingNextTurn = null;
      renderQueueStrip();
      setRunning(false);
      if (userInput) { userInput.value = ''; userInput.style.height = ''; }
      renderAttachmentsRow();
      return;
    }
    // History is inert: a terminal task this webview never started or saw running is HISTORY. Hydration/replay of it
    // (reload, history selection, late host projection) must never mount the legacy execution renderer (objective card,
    // stage rail, blocked card, retry actions). Only a task started or observed live in this session may render there;
    // opening a past task is the read-only history surface's job (chat-everyday.js), never this renderer's.
    if (typeof msg.taskId === 'string' && msg.taskId) {
      if (msg.type === 'autonomousTaskStarted' || msg.type === 'autonomousRetryStarted') {
        liveTaskIds.add(msg.taskId);
        detachedTaskIds.delete(msg.taskId);
      } else if (msg.type === 'autonomousTaskStatus' || msg.type === 'autonomousTaskActive') {
        if (!TERMINAL_TASK_STATES.has(String(msg.state ?? ''))) { liveTaskIds.add(msg.taskId); }
        else if (!liveTaskIds.has(msg.taskId)) {
          detachedTaskIds.add(msg.taskId);
          event.stopImmediatePropagation();
          return;
        }
      }
    }
    if (typeof msg.taskId === 'string' && msg.taskId) {
      if (detachedTaskIds.has(msg.taskId)) { event.stopImmediatePropagation(); return; }
      seenTaskIds.add(msg.taskId);
    }
    if (msg.type === 'autonomousTaskStarted') { runEventsDetached = false; }
    if (runEventsDetached && RUN_SCOPED_TYPES.has(msg.type)) { event.stopImmediatePropagation(); }
  }, true);

  // ── Attachment handling ────────────────────────────────────────────────────
  // M36: each entry tracks upload lifecycle — { localId, name, kind, status:
  // 'uploading'|'ready'|'failed', attachmentId, errorMessage }. Only `status
  // === 'ready'` entries (with a stable Core `attachmentId`) are ever included
  // in a send payload; raw bytes never pass through this array.
  function renderAttachmentsRow() {
    attachmentsRow.innerHTML = '';
    if (pendingAttachments.length === 0) {
      attachmentsRow.style.display = 'none';
      return;
    }
    attachmentsRow.style.display = 'flex';
    pendingAttachments.forEach((att) => {
      const chip = document.createElement('div');
      chip.className = 'attachment-chip' + (att.status === 'failed' ? ' failed' : att.status === 'uploading' ? ' uploading' : '');
      chip.dataset.status = att.status;
      if (att.attachmentId) { chip.dataset.attachmentId = att.attachmentId; }
      const icon = att.status === 'uploading' ? '<span class="spinner"></span>' : att.status === 'failed' ? '⚠' : attachmentKindIcon(att.kind);
      const title = att.status === 'failed' && att.errorMessage ? ' title="' + escapeHtml(att.errorMessage) + '"' : '';
      chip.innerHTML =
        '<span class="att-icon"' + title + '>' + icon + '</span>' +
        '<span class="att-name"' + title + '>' + escapeHtml(att.name) + '</span>' +
        '<button class="att-remove" data-local-id="' + escapeHtml(att.localId) + '" title="Remove">×</button>';
      attachmentsRow.appendChild(chip);
    });
    updateSendButtonState();
  }

  attachmentsRow.addEventListener('click', (e) => {
    const btn = e.target.closest('.att-remove');
    if (!btn) { return; }
    pendingAttachments = pendingAttachments.filter((att) => att.localId !== btn.dataset.localId);
    renderAttachmentsRow();
  });

  attachBtn.addEventListener('click', () => vscode.postMessage({ type: 'pickAttachment', conversationId: currentConversationId }));

  if (permissionSelect) {
    permissionSelect.addEventListener('change', () => {
      vscode.postMessage({ type: 'selectPermissionProfile', profileId: permissionSelect.value });
    });
  }
  if (permissionUseDefault) permissionUseDefault.addEventListener('click', () => {
    vscode.postMessage({ type: 'selectPermissionProfile', profileId: 'workspace-read' });
  });
  if (repoIntelRebuild) repoIntelRebuild.addEventListener('click', () => vscode.postMessage({ type: 'rebuildRepositoryIntelligence' }));
  if (repoIntelPause) repoIntelPause.addEventListener('click', () => vscode.postMessage({ type: 'pauseRepositoryIntelligence' }));
  if (repoIntelResume) repoIntelResume.addEventListener('click', () => vscode.postMessage({ type: 'resumeRepositoryIntelligence' }));

  // ── Event delegation: tool-card toggle + approval buttons ─────────────────
  messages.addEventListener('click', (e) => {
    const target = e.target;

    if (target.dataset.approvalId && target.dataset.approvalResponse) {
      const id       = target.dataset.approvalId;
      const response = target.dataset.approvalResponse;
      if (resolvedApprovals.has(id)) { return; }   // guard double-click
      resolvedApprovals.add(id);
      LOG('approval click id=' + id + ' response=' + response);
      const card = document.getElementById('approval-' + id);
      if (card) {
        // Disable buttons first so a second click cannot fire before the DOM updates.
        card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        card.innerHTML =
          '<div style="padding:8px;color:' + (response === 'approved' ? '#66ff66' : '#ff6666') + ';font-weight:600">' +
          (response === 'approved' ? '✓ Approved' : '✗ Rejected') + '</div>';
      }
      vscode.postMessage({ type: 'approvalResponse', id, response });
      return;
    }

    const header = target.closest('.tool-card-header');
    if (header) {
      const body = header.parentElement.querySelector('.tool-card-body');
      if (body) { body.classList.toggle('open'); }
    }
  });

  // ── Message rendering ──────────────────────────────────────────────────────
  function addUserBubble(text, attachments, messageId) {
    const div = document.createElement('div');
    div.className = 'bubble user';
    if (messageId) div.dataset.messageId = messageId;
    div.textContent = text;
    if (attachments && attachments.length > 0) {
      const chipRow = document.createElement('div');
      chipRow.className = 'bubble-attachments';
      attachments.forEach((att) => {
        const chip = document.createElement('span');
        chip.className = 'attachment-chip sent';
        chip.dataset.status = 'ready';
        if (att.attachmentId) { chip.dataset.attachmentId = att.attachmentId; }
        chip.textContent = attachmentKindIcon(att.kind) + ' ' + att.name;
        chipRow.appendChild(chip);
      });
      div.appendChild(chipRow);
    }
    if (messageId) {
      const actions = document.createElement('div'); actions.className = 'message-workbench-actions';
      const branch = document.createElement('button'); branch.className = 'btn btn-ghost compact-btn'; branch.textContent = 'Branch';
      branch.addEventListener('click', () => vscode.postMessage({ type: 'branchFromMessage', messageId })); actions.appendChild(branch); div.appendChild(actions);
    }
    messages.appendChild(div);
    scrollBottom();
  }

  const THINKING_ELAPSED_THRESHOLD_MS = 8000;

  function elapsedClock(startedAt) {
    const totalSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
  }

  // Truthful only: names the model actually resolved for this turn (or, if
  // that evidence has not arrived yet, the model the user explicitly
  // selected), never a guess at what Auto routed to. Local/cloud is stated
  // only when the resolved provider unambiguously is one: 'ollama' is always
  // local; 'openai-compatible' can be a local server too, so it says nothing
  // rather than guessing "Cloud". Elapsed time only appears once the wait has
  // gone on long enough to be worth saying anything more than the calm
  // default label.
  function refreshThinkingLabel() {
    const el = document.getElementById('thinking-indicator');
    if (!el || !thinkingStartedAt) return;
    const elapsedMs = Date.now() - thinkingStartedAt;
    if (elapsedMs < THINKING_ELAPSED_THRESHOLD_MS) return;
    const model = thinkingResolvedModel || (modelSelect && modelSelect.value ? modelSelect.value : '');
    const locality = thinkingResolvedProvider === 'ollama' ? ' · Local' : '';
    const base = model ? `Still waiting for ${model}${locality}` : 'Still working on this';
    el.textContent = `${base} · ${elapsedClock(thinkingStartedAt)}`;
  }

  function addThinking() {
    removeThinking();
    const div = document.createElement('div');
    div.className = 'thinking kd-dhadkan';
    div.dataset.dhadkanState = 'thinking';
    div.id = 'thinking-indicator';
    div.textContent = 'Soch raha hoon…';
    messages.appendChild(div);
    scrollBottom();
    thinkingStartedAt = Date.now();
    thinkingTimer = setInterval(refreshThinkingLabel, 1000);
  }

  function removeThinking() {
    const el = document.getElementById('thinking-indicator');
    if (el) { el.remove(); }
    if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
    thinkingStartedAt = 0;
    // Cleared per-turn so a resolved model from the turn that just ended can
    // never leak into the next turn's brief window before its own
    // `modelSuitability` evidence arrives.
    thinkingResolvedModel = '';
    thinkingResolvedProvider = '';
  }

  function buildMessageActions(messageId, alternatives, text) {
    const actions = document.createElement('div');
    actions.className = 'message-actions-bar message-workbench-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'message-action-btn copy-btn';
    copyBtn.type = 'button';
    copyBtn.title = 'Copy message';
    copyBtn.innerHTML = '📋 <span class="action-label">Copy</span>';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        const label = copyBtn.querySelector('.action-label');
        if (label) label.textContent = 'Copied!';
        setTimeout(() => {
          if (label) label.textContent = 'Copy';
        }, 1500);
      } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        textarea.remove();
        const label = copyBtn.querySelector('.action-label');
        if (label) label.textContent = 'Copied!';
        setTimeout(() => {
          if (label) label.textContent = 'Copy';
        }, 1500);
      }
    });
    actions.appendChild(copyBtn);

    if (messageId || (alternatives && alternatives.length > 0)) {
      const overflowContainer = document.createElement('div');
      overflowContainer.className = 'message-overflow-container';

      const overflowBtn = document.createElement('button');
      overflowBtn.className = 'message-action-btn overflow-btn';
      overflowBtn.type = 'button';
      overflowBtn.title = 'More options';
      overflowBtn.setAttribute('aria-haspopup', 'true');
      overflowBtn.textContent = '⋯';

      const popover = document.createElement('div');
      popover.className = 'message-overflow-popover';
      popover.hidden = true;

      if (messageId) {
        const regen = document.createElement('button');
        regen.className = 'overflow-item';
        regen.type = 'button';
        regen.textContent = 'Regenerate';
        regen.addEventListener('click', () => {
          popover.hidden = true;
          vscode.postMessage({ type: 'regenerateMessage', messageId });
        });
        popover.appendChild(regen);

        const branch = document.createElement('button');
        branch.className = 'overflow-item';
        branch.type = 'button';
        branch.textContent = 'Branch';
        branch.addEventListener('click', () => {
          popover.hidden = true;
          vscode.postMessage({ type: 'branchFromMessage', messageId });
        });
        popover.appendChild(branch);
      }

      if (alternatives && alternatives.length > 1) {
        const divider = document.createElement('div');
        divider.className = 'overflow-divider';
        popover.appendChild(divider);

        alternatives.forEach((alternative, index) => {
          const select = document.createElement('button');
          select.className = 'overflow-item' + (alternative.active ? ' active' : '');
          select.type = 'button';
          select.textContent = alternative.active ? `Answer ${index + 1} ✓` : `Answer ${index + 1}`;
          select.disabled = Boolean(alternative.active);
          select.addEventListener('click', () => {
            popover.hidden = true;
            vscode.postMessage({ type: 'selectResponseAlternative', alternativeId: alternative.id });
          });
          popover.appendChild(select);
        });
      }

      overflowBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willShow = popover.hidden;
        document.querySelectorAll('.message-overflow-popover').forEach(p => { p.hidden = true; });
        popover.hidden = !willShow;
      });

      document.addEventListener('click', (e) => {
        if (!overflowContainer.contains(e.target)) {
          popover.hidden = true;
        }
      });

      overflowContainer.appendChild(overflowBtn);
      overflowContainer.appendChild(popover);
      actions.appendChild(overflowContainer);
    }

    return actions;
  }

  function addAssistantBubble(text, active, messageId, alternatives) {
    removeThinking();
    const isActive = active !== false;
    if (currentAssistantBubble) {
      currentAssistantBubble.innerHTML = renderMarkdown(text);
      currentAssistantBubble.classList.toggle('kd-dhadkan', isActive);
      if (isActive) currentAssistantBubble.dataset.dhadkanState = 'coding';
      else delete currentAssistantBubble.dataset.dhadkanState;
      if (!isActive && !currentAssistantBubble.querySelector('.message-actions-bar')) {
        if (messageId) currentAssistantBubble.dataset.messageId = messageId;
        currentAssistantBubble.appendChild(buildMessageActions(messageId, alternatives, text));
      }
      scrollBottom();
      return;
    }
    const div = document.createElement('div');
    div.className = isActive ? 'bubble assistant kd-dhadkan' : 'bubble assistant';
    if (isActive) div.dataset.dhadkanState = 'coding';
    div.innerHTML = renderMarkdown(text);
    if (!isActive) {
      if (messageId) div.dataset.messageId = messageId;
      div.appendChild(buildMessageActions(messageId, alternatives, text));
    }
    messages.appendChild(div);
    currentAssistantBubble = div;
    scrollBottom();
  }

  function stopDhadkan() {
    if (currentAssistantBubble) {
      currentAssistantBubble.classList.remove('kd-dhadkan');
      delete currentAssistantBubble.dataset.dhadkanState;
    }
    removeThinking();
  }

  function addErrorBubble(text) {
    removeThinking();
    const div = document.createElement('div');
    div.className = 'bubble error';
    div.textContent = '⚠ ' + text;
    messages.appendChild(div);
    scrollBottom();
  }

  function addRepositoryContextEvidence(msg) {
    const div = document.createElement('div');
    div.className = 'repository-context-evidence' + (msg.available ? '' : ' unavailable');
    if (msg.available && msg.factsLabel) {
      // The host computed this answer; no file was read, so it is not described as "N files".
      div.textContent = 'Repository facts · ' + String(msg.factsLabel);
    } else if (msg.available) {
      const files = Number(msg.fileCount || 0);
      const tokens = Number(msg.estimatedTokens || 0);
      div.textContent = 'Repository context · ' + files + ' file' + (files === 1 ? '' : 's') + ' · ~' + tokens.toLocaleString() + ' tokens';
      if (Array.isArray(msg.paths) && msg.paths.length > 0) div.title = msg.paths.join('\n');
    } else {
      div.textContent = msg.message || 'Repository context unavailable · answering as plain chat';
    }
    const thinking = document.getElementById('thinking-indicator');
    messages.insertBefore(div, thinking || null);
    scrollBottom();
  }

  /**
   * Some local models escape Markdown punctuation even when they intend it as
   * presentation (for example `\\### Heading`, `\\| a \\| b \\|`, or
   * `\\*emphasis\\*`). Normalize only those structural forms here. This is
   * deliberately assistant-message-only: tool results and developer
   * diagnostics keep using escaped `<pre>` text below and remain literal.
   */
  function normalizeAssistantMarkdown(text) {
    return String(text ?? '').split(/\r?\n/).map(line => {
      let normalized = line;
      normalized = normalized.replace(/^(\s*)\\(#{1,6})(?=\s)/, '$1$2');
      normalized = normalized.replace(/^(\s*)\\([-+*])(?=\s)/, '$1$2');
      if (/^\s*\\\|/.test(normalized)) normalized = normalized.replace(/\\\|/g, '|');
      normalized = normalized
        .replace(/\\(\*{1,2})(?=\S)/g, '$1')
        .replace(/(\S)\\(\*{1,2})(?=\s|[.,;:!?)]|$)/g, '$1$2');
      return normalized;
    }).join('\n');
  }

  function renderInlineMarkdown(text) {
    const code = [];
    let html = text.replace(/`([^`]+)`/g, (_match, content) => {
      const token = `\u0000CODE${code.length}\u0000`;
      code.push(`<code>${content}</code>`);
      return token;
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    html = html.replace(/\u0000CODE(\d+)\u0000/g, (_match, index) => code[Number(index)] || '');
    return html;
  }

  function tableCells(line) {
    return line.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  }

  function isTableDivider(line) {
    const cells = tableCells(line);
    return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
  }

  function renderMarkdown(text) {
    const lines = escapeHtml(normalizeAssistantMarkdown(text)).split('\n');
    const output = [];
    let inFence = false;
    let fenceLines = [];
    let listType = '';

    const closeList = () => {
      if (!listType) return;
      output.push(`</${listType}>`);
      listType = '';
    };

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (/^```/.test(line.trim())) {
        closeList();
        if (inFence) {
          output.push(`<pre><code>${fenceLines.join('\n')}</code></pre>`);
          fenceLines = [];
          inFence = false;
        } else {
          inFence = true;
        }
        continue;
      }
      if (inFence) {
        fenceLines.push(line);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) {
        closeList();
        const level = heading[1].length;
        output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
        continue;
      }

      if (line.includes('|') && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
        closeList();
        const headers = tableCells(line);
        const rows = [];
        index += 2;
        while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
          rows.push(tableCells(lines[index]));
          index += 1;
        }
        index -= 1;
        output.push('<table><thead><tr>' + headers.map(cell => `<th>${renderInlineMarkdown(cell)}</th>`).join('') + '</tr></thead><tbody>'
          + rows.map(row => '<tr>' + row.map(cell => `<td>${renderInlineMarkdown(cell)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table>');
        continue;
      }

      const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        const nextType = unordered ? 'ul' : 'ol';
        if (listType !== nextType) {
          closeList();
          listType = nextType;
          output.push(`<${listType}>`);
        }
        output.push(`<li>${renderInlineMarkdown((unordered || ordered)[1])}</li>`);
        continue;
      }

      closeList();
      if (!line.trim()) {
        output.push('');
      } else {
        output.push(`<p>${renderInlineMarkdown(line)}</p>`);
      }
    }

    closeList();
    if (inFence) output.push(`<pre><code>${fenceLines.join('\n')}</code></pre>`);
    return output.join('');
  }

  // ── Tool cards ─────────────────────────────────────────────────────────────
  function toolIcon(status) {
    return { running: '⟳', success: '✓', failed: '✗', blocked: '⊘', approval: '?' }[status] || '●';
  }

  function badgeLabel(status) {
    return { running: 'RUNNING', success: 'OK', failed: 'FAILED', blocked: 'BLOCKED', approval: 'APPROVAL' }[status] || status.toUpperCase();
  }

  function addToolCard(toolName, args, status) {
    removeThinking();
    const card   = document.createElement('div');
    card.className = 'tool-card ' + status;
    const argsStr        = JSON.stringify(args, null, 2);
    const displaySummary = argsStr.slice(0, 80).replace(/\n/g, ' ');
    const header = document.createElement('div');
    header.className = 'tool-card-header';
    header.innerHTML =
      '<span class="tool-icon">' + toolIcon(status) + '</span>' +
      '<span class="tool-name">' + escapeHtml(toolName) + '</span>' +
      '<span class="tool-summary">' + escapeHtml(displaySummary) + '</span>' +
      '<span class="tool-badge ' + status + '">' + badgeLabel(status) + '</span>';
    const body = document.createElement('div');
    body.className = 'tool-card-body';
    body.innerHTML = '<div class="label">Arguments</div><pre>' + escapeHtml(argsStr) + '</pre>';
    card.appendChild(header);
    card.appendChild(body);
    messages.appendChild(card);
    runningCards.set(toolName, card);
    scrollBottom();
  }

  function updateToolCard(toolName, status, result) {
    const card = runningCards.get(toolName);
    if (!card) { return; }
    card.className = 'tool-card ' + status;
    const badge = card.querySelector('.tool-badge');
    if (badge) { badge.className = 'tool-badge ' + status; badge.textContent = badgeLabel(status); }
    const icon = card.querySelector('.tool-icon');
    if (icon) { icon.textContent = toolIcon(status); }
    if (result !== undefined) {
      const body = card.querySelector('.tool-card-body');
      if (body) {
        const existing = body.querySelector('.result-section');
        if (existing) { existing.remove(); }
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        const section   = document.createElement('div');
        section.className = 'result-section';
        section.innerHTML =
          '<div class="label" style="margin-top:8px">Result</div>' +
          '<pre>' + escapeHtml(resultStr.slice(0, 2000)) + '</pre>';
        body.appendChild(section);
      }
    }
    if (status !== 'running') { runningCards.delete(toolName); }
  }

  // ── Approval UI ────────────────────────────────────────────────────────────
  // Progress & Completion UX V1 (Step 3 closure pass): plain-language title
  // for the tool names this card actually sees in practice, instead of the
  // bare tool identifier. Truthful only — a tool not listed here keeps the
  // generic '⚡ Approval Required' rather than a guessed description.
  const APPROVAL_ACTION_LABELS = {
    propose_file_change: 'This will change a file.',
    write_file: 'This will write a file.',
    edit_file: 'This will edit a file.',
    replace_in_file: 'This will edit a file.',
    apply_patch: 'This will apply a patch to one or more files.',
    create_directory: 'This will create a folder.',
    run_command: 'This will run a terminal command.',
  };

  function addApprovalCard(id, toolName, args, reason, riskLevel) {
    removeThinking();
    const card = document.createElement('div');
    card.className = 'approval-card';
    card.id = 'approval-' + id;
    const title    = document.createElement('div');
    title.className  = 'approval-title';
    // M39: memory actions keep the same card and the same authority, with a
    // human-readable label instead of the generic one.
    title.textContent = memoryApprovalPrompt(toolName) || '⚡ Approval Required';
    const desc = document.createElement('div');
    desc.className  = 'approval-desc';
    desc.textContent = reason;
    // The plain-language "why" line, matching the wording M33 already uses
    // on Karke Dikha's proposal/mutation/delivery cards.
    const why = APPROVAL_ACTION_LABELS[toolName];
    const whyRow = why ? document.createElement('div') : null;
    if (whyRow) { whyRow.className = 'everyday-approval-why'; whyRow.textContent = why; }
    // The explicit scope line, when the tool names a concrete path — never
    // invented, only ever what the tool call itself already states.
    const scopePath = args && typeof args.path === 'string' ? args.path : null;
    const scopeRow = scopePath ? document.createElement('div') : null;
    if (scopeRow) { scopeRow.className = 'everyday-approval-scope'; scopeRow.textContent = 'Affects: ' + scopePath; }
    // The raw tool name, risk level and full argument JSON (which can hold an
    // entire proposed file's content) is real diagnostic evidence, not
    // something an ordinary approval decision needs to read line by line —
    // kept available, not deleted, behind a details disclosure.
    const details = document.createElement('details');
    details.className = 'everyday-details';
    const summary = document.createElement('summary');
    summary.textContent = 'Details';
    const toolInfo = document.createElement('pre');
    toolInfo.className  = 'approval-tool';
    toolInfo.textContent = toolName + ' — Risk: ' + riskLevel + '\n' + JSON.stringify(args, null, 2);
    details.appendChild(summary);
    details.appendChild(toolInfo);
    const memoryProposal = memoryProposalBlock(toolName, args || {});
    const buttons   = document.createElement('div');
    buttons.className = 'approval-buttons';
    const approveBtn  = document.createElement('button');
    approveBtn.className          = 'btn btn-primary';
    approveBtn.textContent        = 'Approve';
    approveBtn.dataset.approvalId       = id;
    approveBtn.dataset.approvalResponse = 'approved';
    const rejectBtn = document.createElement('button');
    rejectBtn.className          = 'btn btn-danger';
    rejectBtn.textContent        = 'Reject';
    rejectBtn.dataset.approvalId       = id;
    rejectBtn.dataset.approvalResponse = 'rejected';
    buttons.appendChild(approveBtn);
    buttons.appendChild(rejectBtn);
    card.appendChild(title);
    if (whyRow) card.appendChild(whyRow);
    card.appendChild(desc);
    if (scopeRow) card.appendChild(scopeRow);
    if (memoryProposal) card.appendChild(memoryProposal);
    card.appendChild(details);
    card.appendChild(buttons);
    messages.appendChild(card);
    scrollBottom();
  }

  // ── Sidebar: conversation list ─────────────────────────────────────────────
  const conversationsList = document.getElementById('conversations-list');
  const conversationItems = new Map(); // id → element

  function readChatState() {
    return (typeof vscode.getState === 'function' && vscode.getState()) || {};
  }
  function writeChatState(patch) {
    if (typeof vscode.setState !== 'function') return;
    vscode.setState(Object.assign({}, readChatState(), patch));
  }

  function selectConversationItem(id, el) {
    currentConversationId = id;
    document.querySelectorAll('.conversation-item').forEach((e) => e.classList.remove('active'));
    (el || conversationItems.get(id))?.classList.add('active');
    writeChatState({ lastConversationId: id });
    vscode.postMessage({ type: 'selectConversation', id });
  }

  function addConversationItem(id, title) {
    if (conversationItems.has(id)) {
      const existing = conversationItems.get(id);
      if (title && existing) existing.textContent = title;
      return existing;
    }
    const el = document.createElement('div');
    el.className = 'conversation-item';
    el.textContent = title;
    el.dataset.convId = id;
    el.addEventListener('click', () => selectConversationItem(id, el));
    conversationsList.appendChild(el);
    conversationItems.set(id, el);
    return el;
  }

  document.getElementById('new-conversation-btn').addEventListener('click', () => {
    vscode.postMessage({ type: 'newConversation' });
  });

  document.getElementById('export-markdown-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'exportConversation', format: 'markdown' }));
  document.getElementById('export-json-btn')?.addEventListener('click', () => vscode.postMessage({ type: 'exportConversation', format: 'json' }));
  const workbenchSearchInput = document.getElementById('workbench-search-input');
  const workbenchSearchResults = document.getElementById('workbench-search-results');
  let workbenchSearchTimer;
  workbenchSearchInput?.addEventListener('input', () => {
    clearTimeout(workbenchSearchTimer);
    const query = workbenchSearchInput.value.trim();
    if (!query) { if (workbenchSearchResults) workbenchSearchResults.innerHTML = ''; return; }
    workbenchSearchTimer = setTimeout(() => vscode.postMessage({ type: 'searchWorkbench', query }), 180);
  });

  function renderWorkbenchSearchResults(results) {
    if (!workbenchSearchResults) return;
    workbenchSearchResults.innerHTML = '';
    (results || []).forEach((result) => {
      const button = document.createElement('button'); button.className = 'workbench-search-result';
      button.textContent = result.title || 'Untitled conversation';
      const detail = document.createElement('small'); detail.textContent = `${result.snippet || ''} · ${result.updatedAt || ''}`; button.appendChild(detail);
      button.addEventListener('click', () => vscode.postMessage({ type: 'openWorkbenchSearchResult', conversationId: result.conversationId }));
      workbenchSearchResults.appendChild(button);
    });
  }

  // ── Send message ───────────────────────────────────────────────────────────
  function sendMessage() {
    const text = userInput.value.trim();
    const readyAttachments  = pendingAttachments.filter((att) => att.status === 'ready');
    const uploadingCount    = pendingAttachments.filter((att) => att.status === 'uploading').length;
    if (isRunning) {
      if (text && !(window.__kdReadiness && window.__kdReadiness.fatalError)) queueNextTurn(text);
      return;
    }
    if ((!text && pendingAttachments.length === 0) || isRunning || !window.__kdWorkspaceRestored || (window.__kdReadiness && window.__kdReadiness.fatalError)) { return; }
    if (uploadingCount > 0) { return; } // wait for in-flight uploads before sending

    const attachmentIds = readyAttachments.map((att) => att.attachmentId);
    addUserBubble(text, readyAttachments);
    userInput.value        = '';
    userInput.style.height = '';
    pendingAttachments     = [];
    renderAttachmentsRow();
    currentAssistantBubble = null;

    runEventsDetached = false; // a new submission re-attaches run events to this conversation
    addThinking();
    setRunning(true);

    const mode  = modeSelect  ? modeSelect.value  : 'agent';
    const model = modelSelect ? modelSelect.value : '';
    LOG('chat start — mode=' + mode + ' model=' + (model || 'auto') + ' conv=' + currentConversationId);
    if (mode === 'auto') {
      vscode.postMessage({
        type: 'classifyAndSend',
        text,
        model,
        attachmentIds,
        conversationId: currentConversationId,
      });
      return;
    }
    vscode.postMessage({
      type: 'sendMessage',
      text,
      mode,
      model,
      attachmentIds,
      conversationId: currentConversationId,
    });
  }

  function addResearchApprovalCard(msg) {
    removeThinking();
    const card = document.createElement('div');
    card.className = 'bubble assistant approval-card research-approval-card';
    const title = document.createElement('strong');
    title.textContent = 'Allow web research?';
    const detail = document.createElement('p');
    detail.textContent = 'KarkeDikha needs network access to search configured sources for this question. No request is sent until you approve.';
    const actions = document.createElement('div'); actions.className = 'approval-buttons';
    const approve = document.createElement('button'); approve.className = 'btn btn-primary'; approve.textContent = 'Allow research';
    const deny = document.createElement('button'); deny.className = 'btn btn-ghost'; deny.textContent = 'Not now';
    const respond = resolution => { approve.disabled = true; deny.disabled = true; vscode.postMessage({ type: 'researchApprovalResponse', researchId: msg.researchId, approvalId: msg.approvalId, requestedActionDigest: msg.requestedActionDigest, resolution }); };
    approve.addEventListener('click', () => respond('approved')); deny.addEventListener('click', () => respond('rejected'));
    actions.append(approve, deny); card.append(title, detail, actions); messages.appendChild(card); scrollBottom(); setRunning(false);
  }

  // ── M38: restart-restored capability approval cards ────────────────────────
  // Renders a pending or resolved governed-capability approval card re-derived
  // from Core's durable state after a webview recreation or Extension Host
  // restart (see AgentPanel.restoreCapabilityApprovalCards). Keyed by the real
  // Core approvalId so a duplicate restore message for the same approval is a
  // no-op rather than a second card.
  function addRestoredCapabilityApprovalCard(msg) {
    const existing = document.getElementById('capability-approval-' + msg.approvalId);
    if (existing) { updateCapabilityApprovalCardOutcome(existing, msg); return; }
    removeThinking();
    const card = document.createElement('div');
    card.className = 'bubble assistant approval-card capability-approval-card' + (msg.resolved ? ' resolved' : '');
    card.id = 'capability-approval-' + msg.approvalId;
    card.dataset.toolName = String(msg.toolName || '');
    card.dataset.subject = capabilitySubject(msg.toolName, msg.description);
    const title = document.createElement('strong');
    title.textContent = msg.resolved
      ? capabilityHeadline(card, msg.outcome)
      : (memoryApprovalPrompt(msg.toolName) || 'Approval required (restored)');
    // The conversation shows one concise line. The raw tool payload and the full diff are technical history:
    // they stay available behind a disclosure (open only while the exact change still awaits a decision).
    const detail = document.createElement('pre');
    detail.className = 'capability-raw-args';
    detail.textContent = msg.toolName + ': ' + JSON.stringify(msg.description || {});
    const disclosure = document.createElement('details');
    disclosure.className = 'capability-details';
    disclosure.open = !msg.resolved;
    const summary = document.createElement('summary');
    summary.textContent = msg.resolved ? 'Show details' : 'Review change';
    disclosure.append(summary, detail);
    card.append(title, disclosure);
    // The proposal exactly as it was made. Rendered from the approval's own
    // frozen presentation (generated by Core at proposal time, before the
    // approval existed) — never recomputed here against the current working
    // tree, which could show a different change from the one being approved.
    const proposedDiff = proposalDiffBlock(msg.presentation);
    if (proposedDiff) disclosure.appendChild(proposedDiff);
    // M39: the exact proposed scope, sensitivity, fact and affected entities
    // must be visible BEFORE the user approves. Rendered from the approval's
    // own arguments, which Core already redacted.
    const proposal = memoryProposalBlock(msg.toolName, msg.description || {});
    if (proposal) disclosure.appendChild(proposal);
    if (!msg.resolved) {
      const actions = document.createElement('div'); actions.className = 'approval-buttons';
      const approve = document.createElement('button'); approve.className = 'btn btn-primary'; approve.textContent = 'Approve';
      const deny = document.createElement('button'); deny.className = 'btn btn-danger'; deny.textContent = 'Reject';
      approve.dataset.approvalId = msg.approvalId;
      approve.dataset.approvalResponse = 'approved';
      approve.dataset.attemptId = msg.attemptId;
      approve.dataset.toolName = msg.toolName;
      approve.dataset.arguments = JSON.stringify(msg.description || {});
      approve.dataset.expectedAttemptRevision = String(msg.expectedAttemptRevision);
      approve.dataset.expectedAttemptStatus = msg.expectedAttemptStatus;
      approve.dataset.requestedActionDigest = msg.requestedActionDigest;
      approve.dataset.frozenContextHash = msg.frozenContextHash;
      deny.dataset.approvalId = msg.approvalId;
      deny.dataset.approvalResponse = 'rejected';
      deny.dataset.attemptId = msg.attemptId;
      deny.dataset.toolName = msg.toolName;
      deny.dataset.arguments = JSON.stringify(msg.description || {});
      deny.dataset.expectedAttemptRevision = String(msg.expectedAttemptRevision);
      deny.dataset.expectedAttemptStatus = msg.expectedAttemptStatus;
      deny.dataset.requestedActionDigest = msg.requestedActionDigest;
      deny.dataset.frozenContextHash = msg.frozenContextHash;
      const respond = (btn, resolution) => {
        approve.disabled = true; deny.disabled = true;
        vscode.postMessage({
          type: 'capabilityApprovalRestoredResponse',
          approvalId: btn.dataset.approvalId,
          attemptId: btn.dataset.attemptId,
          toolName: btn.dataset.toolName,
          arguments: JSON.parse(btn.dataset.arguments || '{}'),
          expectedAttemptRevision: Number(btn.dataset.expectedAttemptRevision),
          expectedAttemptStatus: btn.dataset.expectedAttemptStatus,
          requestedActionDigest: btn.dataset.requestedActionDigest,
          frozenContextHash: btn.dataset.frozenContextHash,
          resolution,
        });
      };
      approve.addEventListener('click', (event) => {
        event.stopPropagation();
        respond(approve, 'approved');
      });
      deny.addEventListener('click', (event) => {
        event.stopPropagation();
        respond(deny, 'rejected');
      });
      actions.append(approve, deny);
      card.appendChild(actions);
    }
    messages.appendChild(card);
    scrollBottom(card);
  }

  /**
   * The frozen proposal-time diff for a `write_file` approval, if Core stored
   * one. Deliberately dumb: it only renders what it was given, so the card
   * cannot drift from the proposal it represents across a restart.
   */
  function proposalDiffBlock(presentation) {
    if (!presentation || presentation.kind !== 'write_file_diff') return null;
    const block = document.createElement('div');
    block.className = 'proposal-diff';
    block.dataset.path = String(presentation.path || '');
    block.dataset.baseline = String(presentation.baseline || '');
    const heading = document.createElement('div');
    heading.className = 'proposal-diff-heading';
    heading.textContent = (presentation.baseline === 'absent' ? 'New file: ' : 'Changes to ')
      + String(presentation.path || '')
      + (Array.isArray(presentation.createsDirectories) && presentation.createsDirectories.length
        ? ' (creates directory ' + presentation.createsDirectories.join(', ') + ')'
        : '')
      + (presentation.truncated ? ' (preview truncated)' : '');
    const pre = document.createElement('pre');
    pre.className = 'proposal-diff-body';
    pre.textContent = String(presentation.diff || '');
    block.append(heading, pre);
    return block;
  }

  // ── M39: governed memory approval + evidence rendering ─────────────────────
  // Deterministic, DOM-inspectable projection of Core's own memory records.
  // No memory dashboard is introduced — this enriches the existing capability
  // approval card and the existing tool-result card only.
  const MEMORY_APPROVAL_PROMPTS = {
    memory_remember: 'Remember this decision?',
    memory_forget: 'Forget this memory?',
    memory_resolve_contradiction: 'Resolve this contradiction?',
  };

  function memoryApprovalPrompt(toolName) {
    return MEMORY_APPROVAL_PROMPTS[toolName] || '';
  }

  function memoryFieldRow(label, value) {
    const row = document.createElement('div');
    row.className = 'memory-field';
    row.dataset.field = label;
    const key = document.createElement('span');
    key.className = 'memory-field-label';
    key.textContent = label + ': ';
    const val = document.createElement('span');
    val.className = 'memory-field-value';
    val.textContent = String(value === undefined || value === null ? '' : value);
    row.append(key, val);
    return row;
  }

  /** The proposed memory action shown inside the approval card, before any
   * durable write exists. */
  function memoryProposalBlock(toolName, args) {
    if (!toolName || toolName.indexOf('memory_') !== 0) return null;
    const block = document.createElement('div');
    block.className = 'memory-proposal';
    block.dataset.toolName = toolName;
    if (toolName === 'memory_remember') {
      block.appendChild(memoryFieldRow('scope', (args.scopeType || '') + ':' + (args.scopeId || '')));
      block.appendChild(memoryFieldRow('memoryType', args.memoryType || ''));
      block.appendChild(memoryFieldRow('sensitivity', args.sensitivity || ''));
      block.appendChild(memoryFieldRow('fact', [args.subject, args.predicate, args.value].filter(Boolean).join(' — ')));
      const affected = Array.isArray(args.affectedEntities) ? args.affectedEntities : [];
      const list = document.createElement('ul');
      list.className = 'memory-affected-entities';
      affected.forEach(entry => {
        const item = document.createElement('li');
        item.className = 'memory-affected-entity';
        item.dataset.entityType = String((entry && entry.type) || '');
        item.textContent = String((entry && entry.type) || '') + ' ' + String((entry && entry.canonicalKey) || '');
        list.appendChild(item);
      });
      block.appendChild(memoryFieldRow('affectedEntityCount', affected.length));
      block.appendChild(list);
    } else if (toolName === 'memory_forget') {
      block.appendChild(memoryFieldRow('memoryId', args.memoryId || ''));
    } else if (toolName === 'memory_resolve_contradiction') {
      block.appendChild(memoryFieldRow('contradictionId', args.contradictionId || ''));
      block.appendChild(memoryFieldRow('policy', args.policy || ''));
    } else {
      return null;
    }
    return block;
  }

  function parseMemoryPayload(result) {
    if (!result) return null;
    let raw = result;
    if (typeof raw === 'object' && typeof raw.output === 'string') raw = raw.output;
    if (typeof raw !== 'string') return null;
    try { return JSON.parse(raw); } catch (_e) { return null; }
  }

  /** Renders recalled facts with the evidence Core actually stored: source
   * label, timestamp, scope, sensitivity, and the evidence hash. Unresolved
   * contradictions and impact paths are shown explicitly. */
  function memoryEvidenceBlock(toolName, result) {
    const payload = parseMemoryPayload(result);
    if (!payload) return null;
    const block = document.createElement('div');
    block.className = 'memory-evidence';
    block.dataset.toolName = toolName;

    if (toolName === 'memory_recall' && Array.isArray(payload.entries)) {
      block.dataset.entryCount = String(payload.entries.length);
      payload.entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'memory-fact';
        item.dataset.memoryId = String((entry.memory && entry.memory.id) || '');
        item.dataset.kind = String(entry.kind || '');
        item.dataset.state = String((entry.memory && entry.memory.state) || '');
        item.appendChild(memoryFieldRow('kind', entry.kind));
        item.appendChild(memoryFieldRow('fact', [entry.memory && entry.memory.subject, entry.memory && entry.memory.predicate, entry.memory && entry.memory.displayValue].filter(Boolean).join(' — ')));
        item.appendChild(memoryFieldRow('scope', ((entry.memory && entry.memory.scopeType) || '') + ':' + ((entry.memory && entry.memory.scopeId) || '')));
        item.appendChild(memoryFieldRow('sensitivity', (entry.memory && entry.memory.sensitivity) || ''));
        item.appendChild(memoryFieldRow('recordedAt', (entry.memory && entry.memory.createdAt) || ''));
        (entry.evidence || []).forEach(evidence => {
          const row = document.createElement('div');
          row.className = 'memory-evidence-link';
          row.dataset.evidenceId = String(evidence.id || '');
          row.dataset.sourceHash = String(evidence.sourceContentSha256 || '');
          row.textContent = 'evidence ' + String(evidence.sourceType || '') + ' ' + String(evidence.sourceMessageId || '')
            + ' sha256:' + String(evidence.sourceContentSha256 || '').slice(0, 16)
            + ' @ ' + String(evidence.createdAt || '');
          item.appendChild(row);
        });
        (entry.contradictions || []).filter(c => c.state === 'unresolved').forEach(contradiction => {
          const row = document.createElement('div');
          row.className = 'memory-contradiction unresolved';
          row.dataset.contradictionId = String(contradiction.id || '');
          row.textContent = 'Unresolved contradiction ' + String(contradiction.id || '')
            + ' (' + String(contradiction.earlierMemoryId || '') + ' vs ' + String(contradiction.laterMemoryId || '') + ')';
          item.appendChild(row);
        });
        block.appendChild(item);
      });
      return block;
    }

    if (toolName === 'memory_impact' && Array.isArray(payload.entries)) {
      block.dataset.entryCount = String(payload.entries.length);
      payload.entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'memory-impact-entity';
        item.dataset.entityType = String((entry.entity && entry.entity.entityType) || '');
        item.dataset.canonicalKey = String((entry.entity && entry.entity.canonicalKey) || '');
        item.dataset.evidenceCount = String((entry.evidenceIds || []).length);
        const path = (entry.path || []).map(hop => hop.relationshipType).join(' -> ');
        item.textContent = String((entry.entity && entry.entity.entityType) || '') + ' '
          + String((entry.entity && entry.entity.canonicalKey) || '')
          + ' [' + path + '] evidence=' + (entry.evidenceIds || []).length;
        block.appendChild(item);
      });
      return block;
    }

    if (toolName === 'memory_export' && payload.memories) {
      block.dataset.memoryCount = String(payload.memoryCount || 0);
      block.dataset.schemaVersion = String(payload.schemaVersion || '');
      const pre = document.createElement('pre');
      pre.className = 'memory-export-json';
      pre.textContent = JSON.stringify(payload, null, 2).slice(0, 4000);
      block.appendChild(pre);
      return block;
    }

    if (toolName === 'memory_remember' && payload.memory) {
      block.dataset.memoryId = String(payload.memory.id || '');
      block.dataset.deduplicated = String(Boolean(payload.deduplicated));
      block.appendChild(memoryFieldRow('memoryId', payload.memory.id));
      block.appendChild(memoryFieldRow('state', payload.memory.state));
      block.appendChild(memoryFieldRow('evidenceCount', (payload.evidence || []).length));
      block.appendChild(memoryFieldRow('contradictionCount', (payload.contradictions || []).length));
      return block;
    }

    if (toolName === 'memory_forget' && payload.memory) {
      block.dataset.memoryId = String(payload.memory.id || '');
      block.appendChild(memoryFieldRow('state', payload.memory.state));
      block.appendChild(memoryFieldRow('forgottenAt', payload.memory.forgottenAt || ''));
      return block;
    }

    if (toolName === 'memory_resolve_contradiction' && payload.contradiction) {
      block.dataset.contradictionId = String(payload.contradiction.id || '');
      block.appendChild(memoryFieldRow('policy', payload.contradiction.resolutionPolicy || ''));
      block.appendChild(memoryFieldRow('authoritativeMemoryId', payload.authoritativeMemoryId || ''));
      return block;
    }
    return null;
  }

  function renderMemoryToolEvidence(toolName, result) {
    if (!toolName || toolName.indexOf('memory_') !== 0) return;
    const block = memoryEvidenceBlock(toolName, result);
    if (!block) return;
    messages.appendChild(block);
    scrollBottom();
  }

  function capabilitySubject(toolName, description) {
    const args = description && typeof description === 'object' ? description : {};
    const target = typeof args.path === 'string' ? args.path : typeof args.file === 'string' ? args.file : '';
    return target ? target.split(/[\\/]/).filter(Boolean).pop() || '' : '';
  }

  // One concise, human line per governed action. Unknown tools keep the generic governed-action wording.
  function capabilityHeadline(card, outcome) {
    const tool = card.dataset.toolName || '';
    const subject = card.dataset.subject || '';
    const label = capabilityOutcomeLabel(outcome);
    if (tool === 'propose_file_change' || tool === 'propose_text_edit' || tool === 'write_file') {
      const verb = { completed: 'updated', approved: 'change approved', rejected: 'change rejected', failed: 'change failed', cancelled: 'change cancelled' }[label] || label;
      return (subject || 'File') + ' ' + verb;
    }
    if (tool === 'run_command' || tool === 'run_check') return 'Command ' + label;
    return 'Governed action — ' + label;
  }

  function capabilityOutcomeLabel(outcome) {
    switch (outcome) {
      case 'succeeded': return 'completed';
      case 'failed': return 'failed';
      case 'cancelled': return 'cancelled';
      case 'rejected': return 'rejected';
      case 'approved': return 'approved';
      default: return String(outcome || 'resolved');
    }
  }

  function updateCapabilityApprovalCardOutcome(card, msg) {
    if (!msg.resolved) return;
    card.classList.add('resolved');
    const buttons = card.querySelector('.approval-buttons');
    if (buttons) buttons.remove();
    const title = card.querySelector('strong');
    if (title) title.textContent = capabilityHeadline(card, msg.outcome);
    const disclosure = card.querySelector('details.capability-details');
    if (disclosure) {
      disclosure.open = false;
      const summary = disclosure.querySelector('summary');
      if (summary) summary.textContent = 'Show details';
    }
  }

  function addCitationDetails(citations) {
    if (!Array.isArray(citations) || citations.length === 0) return null;
    const wrap = document.createElement('div'); wrap.className = 'citation-details';
    citations.forEach(citation => { const button = document.createElement('button'); button.className = 'citation-marker'; button.textContent = `[${citation.label}]`; button.title = citation.title || citation.url || citation.label; if (citation.url) button.addEventListener('click', () => vscode.postMessage({ type: 'openExternalSource', url: citation.url })); wrap.appendChild(button); });
    return wrap;
  }

  // ── Auto mode: mutation confirmation ────────────────────────────────────
  function addMutationConfirmationCard(msg) {
    const card = document.createElement('div');
    card.className = 'bubble assistant mutation-confirmation-card';
    const text = document.createElement('p');
    text.textContent = msg.prompt || 'This request requires repository changes. Start a governed Karke Dikha task?';
    card.appendChild(text);
    const actions = document.createElement('div');
    actions.className = 'mutation-confirmation-actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Start Karke Dikha task';
    confirmBtn.className = 'mutation-confirm-btn';
    confirmBtn.addEventListener('click', () => {
      card.remove();
      if (modeSelect) {
        modeSelect.value = 'autonomous';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      vscode.postMessage({ type: 'confirmAutoMutation', text: msg.text });
    });
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.className = 'mutation-cancel-btn';
    cancelBtn.addEventListener('click', () => card.remove());
    actions.appendChild(confirmBtn);
    actions.appendChild(cancelBtn);
    card.appendChild(actions);
    messages.appendChild(card);
    scrollBottom();
  }

  function addModeChangeCard(msg) {
    const card = document.createElement('div');
    card.className = 'bubble assistant mode-change-card';
    card.dataset.conversationId = msg.conversationId || '';
    const title = document.createElement('strong');
    title.textContent = 'This request requires editing files.';
    const text = document.createElement('p');
    text.textContent = 'Continue in Saath Kar?';
    const actions = document.createElement('div');
    actions.className = 'mode-change-actions';
    const resolve = (decision, label) => {
      card.classList.add('resolved');
      card.querySelectorAll('button').forEach((button) => { button.disabled = true; });
      text.textContent = label;
      vscode.postMessage({ type: decision === 'continue' ? 'confirmModeChange' : 'declineModeChange', conversationId: msg.conversationId });
    };
    const continueBtn = document.createElement('button');
    continueBtn.type = 'button';
    continueBtn.className = 'primary';
    continueBtn.textContent = 'Continue in Saath Kar';
    continueBtn.addEventListener('click', () => {
      // The composer, Operator Context and the execution request must all say Saath Kar from this moment on.
      const pendingText = userInput ? userInput.value : '';
      const button = document.querySelector('.mode-button[data-mode="agent"]');
      if (button) button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      else if (modeSelect) { modeSelect.value = 'agent'; modeSelect.dispatchEvent(new Event('change', { bubbles: true })); }
      if (userInput && userInput.value !== pendingText) userInput.value = pendingText;
      resolve('continue', 'Continuing in Saath Kar.');
      addThinking();
      setRunning(true);
    });
    const stayBtn = document.createElement('button');
    stayBtn.type = 'button';
    stayBtn.textContent = 'Stay in Baat Kar';
    stayBtn.addEventListener('click', () => {
      resolve('stay', 'Staying in Baat Kar. No files will be changed.');
      addThinking();
      setRunning(true);
    });
    actions.append(continueBtn, stayBtn);
    card.append(title, text, actions);
    messages.appendChild(card);
    scrollBottom();
  }

  function addStoryDraftCard(msg) {
    const draft = msg.draft || {};
    const card = document.createElement('div');
    card.className = 'bubble assistant story-draft-card';

    const heading = document.createElement('strong');
    heading.textContent = 'This looks like a larger task';
    card.appendChild(heading);

    const title = document.createElement('div');
    title.className = 'story-draft-title';
    title.textContent = draft.title || 'Draft story';
    card.appendChild(title);

    const goal = document.createElement('p');
    goal.textContent = draft.goal || msg.text || '';
    card.appendChild(goal);

    const criteria = document.createElement('ul');
    (Array.isArray(draft.acceptanceCriteria) ? draft.acceptanceCriteria : []).slice(0, 6).forEach((value) => {
      const item = document.createElement('li');
      item.textContent = value;
      criteria.appendChild(item);
    });
    card.appendChild(criteria);

    const meta = document.createElement('div');
    meta.className = 'story-draft-meta';
    meta.textContent = 'Estimate: ' + (draft.estimatedPoints || 3) + ' points · Draft only until you approve it';
    card.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'mutation-confirmation-actions story-draft-actions';
    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create story';
    createBtn.className = 'mutation-confirm-btn';
    createBtn.addEventListener('click', () => {
      Array.from(actions.querySelectorAll('button')).forEach(button => { button.disabled = true; });
      vscode.postMessage({
        type: 'createLocalStory',
        draft,
        sourceText: msg.text || '',
        conversationId: msg.conversationId || currentConversationId,
      });
    });

    const handleBtn = document.createElement('button');
    handleBtn.textContent = 'Handle now';
    handleBtn.className = 'mutation-cancel-btn';
    handleBtn.addEventListener('click', () => {
      card.remove();
      if (modeSelect) {
        modeSelect.value = 'autonomous';
        modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      }
      vscode.postMessage({ type: 'confirmAutoMutation', text: msg.text || '' });
    });

    const chatBtn = document.createElement('button');
    chatBtn.textContent = 'Keep as chat';
    chatBtn.className = 'mutation-cancel-btn';
    chatBtn.addEventListener('click', () => {
      card.remove();
      addThinking();
      setRunning(true);
      vscode.postMessage({
        type: 'sendMessage',
        text: msg.text || '',
        mode: 'chat',
        model: modelSelect ? modelSelect.value : '',
        attachments: [],
        conversationId: msg.conversationId || currentConversationId,
      });
    });

    actions.appendChild(createBtn);
    actions.appendChild(handleBtn);
    actions.appendChild(chatBtn);
    card.appendChild(actions);
    messages.appendChild(card);
    scrollBottom();
  }

  function addWorkspaceRequiredCard(msg) {
    const card = document.createElement('div');
    card.className = 'bubble assistant workspace-required-card';
    const heading = document.createElement('strong');
    heading.textContent = 'Saath Kar needs a workspace';
    card.appendChild(heading);
    const body = document.createElement('p');
    body.textContent = msg.message || 'Open or create a folder so I have a safe project location. Your request will continue after the workspace opens.';
    card.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'mutation-confirmation-actions';

    const openBtn = document.createElement('button');
    openBtn.textContent = 'Open Folder';
    openBtn.className = 'mutation-confirm-btn';
    openBtn.addEventListener('click', () => vscode.postMessage({ type: 'openWorkspace' }));

    const createBtn = document.createElement('button');
    createBtn.textContent = 'Create Project Folder';
    createBtn.className = 'mutation-cancel-btn';
    createBtn.addEventListener('click', () => vscode.postMessage({ type: 'createWorkspace' }));

    const chatBtn = document.createElement('button');
    chatBtn.textContent = 'Answer without changes';
    chatBtn.className = 'mutation-cancel-btn';
    chatBtn.addEventListener('click', () => {
      card.remove();
      addThinking();
      setRunning(true);
      vscode.postMessage({
        type: 'sendMessage',
        text: msg.text || '',
        mode: 'chat',
        model: modelSelect ? modelSelect.value : '',
        attachments: [],
        conversationId: msg.conversationId || currentConversationId,
      });
    });

    actions.appendChild(openBtn);
    actions.appendChild(createBtn);
    actions.appendChild(chatBtn);
    card.appendChild(actions);
    messages.appendChild(card);
    scrollBottom();
  }

  function renderPermissionState(state) {
    permissionState = state;
    if (!permissionSelect || !permissionCapabilities || !state || !Array.isArray(state.profiles) || !state.selected) {
      return;
    }
    const current = permissionSelect.value;
    const toolbar = document.getElementById('permission-toolbar');
    const humanize = (id) => String(id || '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
    const profiles = state.profiles.filter((profile) => profile && profile.id);
    // Never render an unexplained blank dropdown: with nothing selectable, hide the control.
    if (toolbar) toolbar.hidden = profiles.length === 0;
    permissionSelect.innerHTML = '';
    profiles.forEach((profile) => {
      const opt = document.createElement('option');
      opt.value = profile.id;
      opt.textContent = profile.description || profile.label || humanize(profile.id);
      permissionSelect.appendChild(opt);
    });
    const wanted = state.selected.profileId || current || 'workspace-read';
    if (profiles.some((profile) => profile.id === wanted)) permissionSelect.value = wanted;
    else if (profiles.length) permissionSelect.selectedIndex = 0;
    permissionSelect.disabled = Boolean(state.activeRunId);
    permissionCapabilities.textContent = (state.selected.capabilities || []).join(', ');
    permissionCapabilities.title = permissionCapabilities.textContent;
    renderPermissionSummary();
  }

  const modePermissionCopy = {
    chat: ['Read only', 'Can inspect this workspace but cannot modify files.'],
    agent: ['Ask before changes', 'Requests approval before editing files or running mutating commands.'],
    autonomous: ['Governed', 'Uses isolated worktrees and requires proposal, mutation, and delivery approvals.'],
  };
  function renderPermissionSummary() {
    if (!permissionState?.selected) return;
    const isDefault = permissionState.selected.profileId === 'workspace-read';
    const copy = isDefault ? (modePermissionCopy[modeSelect?.value] || modePermissionCopy.agent) : [
      'Custom permissions',
      'An advanced permission profile overrides the safe default for this mode.',
    ];
    // Governance is a fact about the product, not about the selected mode: the chip always reads Governed, and the
    // mode-specific permission wording lives in its tooltip and the permission summary.
    if (permissionStatusLabel) permissionStatusLabel.textContent = 'Governed';
    const permissionChipButton = document.getElementById('permission-status-chip');
    if (permissionChipButton) permissionChipButton.title = copy[0] + ' — ' + copy[1];
    if (permissionSummaryLabel) permissionSummaryLabel.textContent = copy[0];
    if (permissionSummaryDescription) permissionSummaryDescription.textContent = copy[1];
    if (permissionUseDefault) permissionUseDefault.hidden = isDefault;
  }
  modeSelect?.addEventListener('change', () => {
    if (permissionState?.selected?.profileId !== 'workspace-read') {
      vscode.postMessage({ type: 'selectPermissionProfile', profileId: 'workspace-read' });
    }
    renderPermissionSummary();
  });

  function renderContextUsage(usage) {
    if (!usage || !usage.limit || !contextModel || !contextStatus || !contextSummary || !contextBreakdown || !contextMeterFill) {
      return;
    }
    contextModel.textContent = usage.limit.model + ' / ' + usage.limit.profileId;
    contextStatus.className = 'context-status ' + String(usage.status || 'unknown_fallback').replace('_', '-');
    contextStatus.textContent = usage.status + (usage.countingMode === 'estimated' ? ' estimated' : ' exact');
    contextMeterFill.style.width = Math.max(0, Math.min(100, Number(usage.percentUsed || 0))) + '%';
    contextSummary.textContent =
      String(usage.projectedTotal).toLocaleString() + ' / ' +
      String(usage.limit.effectiveLimit).toLocaleString() + ' tokens, output reserve ' +
      String(usage.outputReserve).toLocaleString() + ', repair reserve ' +
      String(usage.repairReserve).toLocaleString() + ' (' + usage.limit.provenance + ')';
    contextBreakdown.innerHTML = '';
    (usage.categories || []).slice(0, 12).forEach((item) => {
      const chip = document.createElement('span');
      chip.className = 'context-chip';
      chip.textContent = item.category + ': ' + item.tokens;
      contextBreakdown.appendChild(chip);
    });
    if (usage.structuredOutput) {
      const so = usage.structuredOutput;
      const chip = document.createElement('span');
      chip.className = 'context-chip context-structured-output';
      chip.textContent = 'structured output: ' + (so.active
        ? 'active'
        : 'off (' + (so.deferredReason || 'not requested') + ')');
      contextBreakdown.appendChild(chip);
    }
    if (usage.limit.visionMinimumApplied) {
      const chip = document.createElement('span');
      chip.className = 'context-chip context-vision-minimum';
      chip.textContent = 'vision minimum applied: ' + String(usage.limit.effectiveLimit);
      contextBreakdown.appendChild(chip);
    }
    if (usage.reason) {
      const reason = document.createElement('div');
      reason.className = 'context-reason';
      reason.textContent = usage.reason;
      contextBreakdown.appendChild(reason);
    }
  }

  function renderRepositoryIntelligence(status) {
    if (!status || !repoIntelTitle || !repoIntelState || !repoIntelMeta || !repoIntelStats || !repoIntelSelected) {
      return;
    }
    const identity = status.identity || {};
    const stats = status.statistics || {};
    repoIntelTitle.textContent = (identity.repositoryRoot || 'Repository').split(/[\\/]/).pop() || 'Repository';
    repoIntelState.className = 'repo-intel-state ' + String(status.state || 'unavailable');
    repoIntelState.textContent = status.state || 'unavailable';
    const repoState = String(status.state || 'unavailable');
    if (repoIntelPause) repoIntelPause.hidden = repoState !== 'indexing' && repoState !== 'ready';
    if (repoIntelResume) repoIntelResume.hidden = repoState !== 'paused';
    const commit = identity.headCommit && identity.headCommit !== 'unknown' ? String(identity.headCommit).slice(0, 12) : 'unknown';
    repoIntelMeta.textContent =
      'branch ' + (identity.branch || 'unknown') +
      ' / commit ' + commit +
      ' / updated ' + (status.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : 'unknown');
    const statItems = [
      ['files', stats.files || 0],
      ['symbols', stats.symbols || 0],
      ['imports', stats.imports || 0],
      ['tests', stats.tests || 0],
      ['config', stats.configs || 0],
      ['build', stats.buildFiles || 0],
      ['tokens', status.estimatedTokens || 0],
      ['omitted', status.omittedCount || 0],
    ];
    repoIntelStats.innerHTML = '';
    statItems.forEach(([label, value]) => {
      const chip = document.createElement('span');
      chip.className = 'repo-intel-chip';
      chip.textContent = label + ': ' + value;
      repoIntelStats.appendChild(chip);
    });
    repoIntelSelected.innerHTML = '';
    const selected = Array.isArray(status.selectedFiles) ? status.selectedFiles.slice(0, 6) : [];
    if (selected.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'repo-intel-empty';
      empty.textContent = status.staleReason || 'No repository context selected for the current request.';
      repoIntelSelected.appendChild(empty);
      return;
    }
    selected.forEach((file) => {
      const row = document.createElement('div');
      row.className = 'repo-intel-file';
      const reasons = Array.isArray(file.reasons)
        ? file.reasons.map((reason) => reason.reason || '').filter(Boolean).slice(0, 3).join(', ')
        : '';
      row.innerHTML =
        '<span class="repo-intel-path">' + escapeHtml(file.path || '') + '</span>' +
        '<span class="repo-intel-reason">' + escapeHtml(reasons || 'ranked retrieval match') + '</span>';
      repoIntelSelected.appendChild(row);
    });
  }

  sendBtn.addEventListener('click', sendMessage);

  stopBtn.addEventListener('click', () => {
    LOG('stop requested');
    vscode.postMessage({ type: 'stopGeneration' });
  });

  clearBtn.addEventListener('click', () => {
    messages.innerHTML     = '';
    currentAssistantBubble = null;
    runningCards.clear();
    vscode.postMessage({ type: 'clear' });
  });

  userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  userInput.addEventListener('input', () => {
    userInput.style.height = 'auto';
    userInput.style.height = Math.min(userInput.scrollHeight, 150) + 'px';
    updateSendButtonState();
  });

  // ── Extension → webview message handler ───────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;

    switch (msg.type) {

      // ── Progress & Completion UX V1 (Step 4) ────────────────────────────
      // Real routing evidence for the turn now waiting, posted by
      // AgentPanel.sendToAgent before Core executes the attempt. Presentation
      // only — captured for the thinking-indicator wait label; not otherwise
      // acted on here (chat-runtime-fixes.js still owns the suitability badge).
      case 'modelSuitability':
        thinkingResolvedModel = String(msg.details?.selectedModel || '');
        thinkingResolvedProvider = String(msg.details?.selectedProvider || '');
        break;

      // ── Streaming token ──────────────────────────────────────────────────
      case 'token': {
        if (!currentAssistantBubble) {
          removeThinking();
          const div = document.createElement('div');
          div.className = 'bubble assistant';
          messages.appendChild(div);
          currentAssistantBubble = div;
          LOG('first token received');
        }
        currentAssistantBubble.textContent += msg.delta;
        scrollBottom();
        break;
      }

      // ── Tool events ──────────────────────────────────────────────────────
      case 'toolStart':
        currentAssistantBubble = null; // close streaming bubble before tool cards
        addToolCard(msg.toolName, msg.args || {}, 'running');
        break;

      case 'toolResult': {
        const status = msg.ok ? 'success' : (msg.blocked ? 'blocked' : 'failed');
        updateToolCard(msg.toolName, status, msg.result !== undefined ? msg.result : msg.error);
        // M39: recalled memory facts and impact/export results are shown with
        // the evidence Core stored for them, not as free-form model prose.
        if (msg.ok) renderMemoryToolEvidence(msg.toolName, msg.result);
        break;
      }

      case 'mutationConfirmationRequired':
        removeThinking();
        setRunning(false);
        currentAssistantBubble = null;
        addMutationConfirmationCard(msg);
        break;

      // Baat Kar is read-only. A request that needs edits stops here until the user explicitly chooses a mode.
      case 'modeChangeRequired':
        removeThinking();
        setRunning(false);
        currentAssistantBubble = null;
        addModeChangeCard(msg);
        break;

      case 'storyDraftRequired':
        removeThinking();
        setRunning(false);
        currentAssistantBubble = null;
        addStoryDraftCard(msg);
        break;

      case 'workspaceRequired':
        removeThinking();
        setRunning(false);
        currentAssistantBubble = null;
        addWorkspaceRequiredCard(msg);
        break;

      case 'workspaceRequestResumed':
        addUserBubble(msg.text || '', []);
        addThinking();
        setRunning(true);
        currentConversationId = msg.conversationId || currentConversationId;
        break;

      case 'localStoryCreated':
        removeThinking();
        setRunning(false);
        currentAssistantBubble = null;
        addAssistantBubble((msg.created ? 'Created' : 'Already on the board') + ': ' + (msg.story?.title || 'story') + '. Open Board to track it.');
        break;

      case 'permissionContextState':
        renderPermissionState(msg);
        break;

      case 'contextUsage':
        renderContextUsage(msg.usage);
        break;

      case 'repositoryIntelligenceStatus':
        renderRepositoryIntelligence(msg.status);
        break;

      case 'repositoryContextEvidence':
        addRepositoryContextEvidence(msg);
        break;

      case 'reliabilityEvent':
        if (msg.event && msg.event.message) {
          const suffix = msg.event.pattern ? ' (' + msg.event.pattern + ')' : '';
          addAssistantBubble('[Reliability] ' + msg.event.message + suffix);
        }
        break;

      case 'executionQualityProgress':
        if (msg.message) addAssistantBubble(msg.message);
        break;

      case 'authorizationDenied':
        addErrorBubble(msg.message || 'Authorization denied.');
        setRunning(false);
        currentAssistantBubble = null;
        break;

      // ── Approval ─────────────────────────────────────────────────────────
      case 'approvalRequest':
        LOG('approvalRequest id=' + msg.id + ' tool=' + msg.toolName);
        addApprovalCard(msg.id, msg.toolName, msg.args || {}, msg.reason, msg.riskLevel);
        break;

      case 'researchApprovalRequest':
        currentAssistantBubble = null;
        addResearchApprovalCard(msg);
        break;

      // ── M38: restart-restored governed capability approval cards ─────────
      case 'restoreCapabilityApprovalCard':
        addRestoredCapabilityApprovalCard(msg);
        break;

      case 'capabilityApprovalRestoredResolved': {
        const card = document.getElementById('capability-approval-' + msg.approvalId);
        if (card) updateCapabilityApprovalCardOutcome(card, { resolved: true, outcome: msg.outcome });
        break;
      }

      case 'researchProgress':
        addThinking(); setRunning(true);
        break;

      case 'researchDenied':
        addAssistantBubble('Research was not started because network access was not approved.');
        setRunning(false); currentAssistantBubble = null;
        break;

      case 'researchCompleted':
        removeThinking();
        if (msg.content) addAssistantBubble(msg.content, false);
        {
          const details = addCitationDetails(msg.citations);
          if (details) messages.appendChild(details);
        }
        setRunning(false); currentAssistantBubble = null;
        break;

      // ── Model routing badge ───────────────────────────────────────────────
      case 'modelSelected': {
        const badge = document.getElementById('model-badge');
        if (badge) {
          badge.textContent = msg.model;
          badge.title = 'Routed: ' + msg.reason;
          badge.hidden = !msg.model;
        }
        break;
      }

      // ── Model list ────────────────────────────────────────────────────────
      case 'modelsLoaded': {
        LOG('modelsLoaded count=' + (msg.models ? msg.models.length : 0));
        if (!msg.models || msg.models.length === 0) {
          modelSelect.innerHTML = '<option value="">No models found</option>';
          break;
        }
        modelSelect.innerHTML = '';
        const automatic = document.createElement('option');
        automatic.value = '';
        automatic.textContent = 'Automatic (recommended)';
        modelSelect.appendChild(automatic);
        msg.models.forEach((m) => {
          const opt = document.createElement('option');
          opt.value       = m.name;
          opt.textContent = m.label || m.name;
          if (m.cloud) { opt.dataset.cloud = '1'; if (m.providerName) opt.dataset.provider = m.providerName; }
          modelSelect.appendChild(opt);
        });
        const restoredModel = String(msg.selectedModel || '');
        const restoredModelAvailable = Array.from(modelSelect.options)
          .some(option => option.value === restoredModel);
        modelSelect.value = '';
        if (contextModel) {
          contextModel.textContent = restoredModel && !restoredModelAvailable
            ? `${msg.provider || 'unknown'} / configured model unavailable: ${restoredModel}`
            : restoredModel
              ? `${msg.provider || 'unknown'} / ${restoredModel}`
              : 'No model selected';
        }
        break;
      }

      // ── Attachment ────────────────────────────────────────────────────────
      case 'attachmentState': {
        const existingIndex = pendingAttachments.findIndex((att) => att.localId === msg.localId);
        const entry = {
          localId: msg.localId,
          name: msg.name,
          kind: msg.kind,
          status: msg.status,
          attachmentId: msg.attachmentId,
          errorMessage: msg.errorMessage,
        };
        if (existingIndex === -1) { pendingAttachments.push(entry); }
        else { pendingAttachments[existingIndex] = entry; }
        renderAttachmentsRow();
        break;
      }

      // ── Assistant prose (non-streaming or pre-tool) ───────────────────────
      case 'assistantContent':
        addAssistantBubble(msg.content);
        break;

      // ── Stream / turn complete ────────────────────────────────────────────
      case 'done':
        LOG('stream complete');
        stopDhadkan();
        // Completion enriches the optimistic streamed bubble with Core's
        // durable assistant id and alternative group. This is required for a
        // just-regenerated response to expose Answer 1/Answer 2 immediately,
        // without relying on a later webview restart to rebuild the controls.
        if (msg.content) {
          addAssistantBubble(msg.content, false, msg.messageId, msg.alternatives || []);
        } else if (currentAssistantBubble) {
          currentAssistantBubble.classList.remove('kd-dhadkan');
          delete currentAssistantBubble.dataset.dhadkanState;
          if (!currentAssistantBubble.querySelector('.message-actions-bar')) {
            if (msg.messageId) currentAssistantBubble.dataset.messageId = msg.messageId;
            currentAssistantBubble.appendChild(buildMessageActions(msg.messageId, msg.alternatives || [], currentAssistantBubble.innerText || currentAssistantBubble.textContent || ''));
          }
        }
        setRunning(false);
        currentAssistantBubble = null;
        dispatchQueuedNextTurn(); // completed normally: queued message becomes the next turn
        break;

      // A governed task has crossed the durable acknowledgement boundary.
      // Release only chat.js's optimistic "thinking"/disabled state here.
      // chat-autonomous.js runs later in the same host-message dispatch and
      // projects the exact task ID into the visible unified composer.
      case 'autonomousTaskStarted':
        stopDhadkan();
        setRunning(false);
        currentAssistantBubble = null;
        break;

      // ── Error ─────────────────────────────────────────────────────────────
      case 'error':
        LOG('error: ' + msg.message);
        stopDhadkan();
        addErrorBubble(msg.message);
        setRunning(false);
        currentAssistantBubble = null;
        renderQueueStrip(); // failed turn: keep the queued message visible, user decides
        break;

      // ── Stopped by user ───────────────────────────────────────────────────
      case 'stopped':
        LOG('stopped');
        stopDhadkan();
        {
          const note = document.createElement('div');
          note.className = 'thinking';
          note.textContent = '■ Stopped.';
          messages.appendChild(note);
          scrollBottom();
        }
        setRunning(false);
        currentAssistantBubble = null;
        renderQueueStrip(); // stopped: queued message stays visible; "Send now" or "Discard"
        break;

      // ── Conversation management ───────────────────────────────────────────
      // Reload/restore: renders History from the existing production
      // `persistedConversationsLoaded` snapshot only (no enqueue, no wake,
      // no execution). Restores the last-selected item if it still exists;
      // otherwise leaves selection to the autonomous-task fallback that
      // chat-sidebar-ui.js already applies when a non-terminal task exists.
      case 'readinessState':
        if (msg.state) {
          window.__kdReadiness = Object.assign(window.__kdReadiness || {}, msg.state);
          if (msg.state.historyReady !== undefined) {
            window.__kdWorkspaceRestored = Boolean(msg.state.historyReady);
          }
          updateSendButtonState();
          window.dispatchEvent(new CustomEvent('kdReadinessChanged', { detail: window.__kdReadiness }));
        }
        break;

      case 'workspaceRestorationPending':
        window.__kdWorkspaceRestored = false;
        if (window.__kdReadiness) window.__kdReadiness.historyReady = false;
        updateSendButtonState();
        break;

      case 'workspaceRestorationResolved':
        window.__kdWorkspaceRestored = true;
        if (window.__kdReadiness) window.__kdReadiness.historyReady = true;
        updateSendButtonState();
        break;

      case 'persistedConversationsLoaded': {
        const items = Array.isArray(msg.conversations) ? msg.conversations : [];
        items
          .slice()
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .forEach((item) => {
            if (!conversationItems.has(item.id)) addConversationItem(item.id, item.title || item.id);
          });
        const targetId = msg.selectedConversationId;
        if (targetId && conversationItems.has(targetId)) {
          document.querySelectorAll('.conversation-item').forEach((e) => e.classList.remove('active'));
          conversationItems.get(targetId)?.classList.add('active');
        }
        break;
      }

      case 'newConversation':
        currentConversationId = msg.id;
        {
          const el = addConversationItem(msg.id, 'New chat');
          document.querySelectorAll('.conversation-item').forEach((e) => e.classList.remove('active'));
          el.classList.add('active');
          writeChatState({ lastConversationId: msg.id });
        }
        break;

      case 'conversationCreated':
        if (msg.conversation) {
          const el = addConversationItem(msg.conversation.id, msg.conversation.title);
          document.querySelectorAll('.conversation-item').forEach((e) => e.classList.remove('active'));
          el.classList.add('active');
          writeChatState({ lastConversationId: msg.conversation.id });
        }
        break;

      case 'conversationUpdated':
        if (msg.conversation && conversationItems.has(msg.conversation.id)) {
          conversationItems.get(msg.conversation.id).textContent = msg.conversation.title;
        }
        break;

      case 'conversationDeleted':
        if (msg.id && conversationItems.has(msg.id)) {
          conversationItems.get(msg.id).remove();
          conversationItems.delete(msg.id);
        }
        break;

      case 'workbenchSearchResults':
        renderWorkbenchSearchResults(msg.results);
        break;

      case 'conversationSelected':
        if (msg.id) {
          currentConversationId = msg.id;
          clearPendingNextTurn(); // policy: a queued turn never follows the user into another conversation
          transcriptRestored = false;
          messages.innerHTML = '';
          currentAssistantBubble = null;
        }
        break;

      case 'conversationBranched':
        if (msg.id && !conversationItems.has(msg.id)) addConversationItem(msg.id, 'Conversation branch');
        break;

      case 'regenerationStarted':
        currentAssistantBubble = null;
        addThinking();
        setRunning(true);
        break;

      case 'conversationExported':
        break;

      case 'clear':
        messages.innerHTML = '';
        currentAssistantBubble = null;
        runningCards.clear();
        break;

      // M36 restart restoration: rebuilds prior turns and their attachment
      // chips/provenance from durable Core records rather than retained
      // webview state. Renders at most once per webview load, and only when
      // there is no in-progress turn already occupying the transcript. An
      // explicit Core-driven replacement is allowed after Answer selection so
      // the active durable alternative takes effect without a full restart.
      case 'restoreTranscript':
        if ((transcriptRestored && !msg.replaceExisting) || (isRunning && !msg.replaceExisting) || !Array.isArray(msg.messages) || msg.messages.length === 0) { break; }
        transcriptRestored = true;
        messages.innerHTML = '';
        currentAssistantBubble = null;
        msg.messages.forEach((entry) => {
          if (entry.role === 'user') {
            addUserBubble(entry.content, entry.attachments || [], entry.id);
          } else if (entry.role === 'assistant') {
            // Reset per entry: addAssistantBubble() reuses a non-null
            // currentAssistantBubble in place (needed for live token
            // streaming), which otherwise merges separate restored turns.
            currentAssistantBubble = null;
            addAssistantBubble(entry.content, false, entry.id, entry.alternatives || []);
            const details = addCitationDetails(entry.citations);
            if (details) messages.appendChild(details);
          }
        });
        currentAssistantBubble = null; // next live turn must start a fresh bubble, not append to a restored one
        scrollBottom();
        break;
    }
  });

  // ── Initialise: request model list as soon as the webview is ready ─────────
  LOG('webview ready — requesting models');
  updateSendButtonState();

})();
