(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const tasks = new Map();
  const logs = [];
  const maximumLogs = 250;

  const elements = {
    taskCount: document.getElementById('metric-tasks'),
    runningCount: document.getElementById('metric-running'),
    blockedCount: document.getElementById('metric-blocked'),
    worktreeCount: document.getElementById('metric-worktrees'),
    taskList: document.getElementById('operations-task-list'),
    logList: document.getElementById('runtime-log-list'),
    updated: document.getElementById('operations-updated'),
    clearLog: document.getElementById('clear-log-btn'),
    ambient: document.getElementById('ambient-placeholder'),
  };

  const modeSelect = document.getElementById('mode-select');
  const userInput = document.getElementById('user-input');
  const sendButton = document.getElementById('send-btn');
  const messages = document.getElementById('messages');

  // Kaam ka Dhaaga (chat-dhaaga.js) is the ONE execution visualization. The legacy work-state card and the
  // `data-kd-work-state` banners it drove (chat-layout-fixes.css) are never rendered; this only removes any leftover.
  function setWorkState() {
    if (!messages) return;
    delete messages.dataset.kdWorkState;
    document.getElementById('kd-work-state-panel')?.remove();
  }

  function isValidationTool(name) {
    return /(?:^|[_\-.\s])(?:test|tests|validation|validate|check|review|lint|typecheck|compile|build)(?:$|[_\-.\s])/i.test(String(name || ''));
  }

  function isReadOnlyTool(name) {
    return /(?:^|[_\-.\s])(?:read|search|find|list|inspect|lookup|repository|context)(?:$|[_\-.\s])/i.test(String(name || ''));
  }

  /*
   * Release continuity guard.
   *
   * The deterministic Auto recommender intentionally stays conservative, but
   * a short affirmative after an assistant question is not a new objective.
   * Preserve the mode that produced the question for this ONE submission.
   * Never use a bare affirmative to grant fresh autonomous authority: a
   * terminal/autonomous surface is capped at Saath Kar unless active task
   * steering says the same governed task is still live.
   */
  function isAffirmativeFollowUp(value) {
    const text = String(value || '').trim().toLowerCase().replace(/[.!]+$/g, '').trim();
    return /^(?:yes|yeah|yep|yup|sure|ok|okay|alright|please do|do it|go ahead|sounds good|lets do it|let's do it|continue|proceed)$/.test(text);
  }

  function hasPriorAssistantContext() {
    return Boolean(messages?.querySelector('.bubble.assistant'));
  }

  function editDistance(left, right) {
    const a = String(left || '').toLowerCase();
    const b = String(right || '').toLowerCase();
    const row = Array.from({ length: b.length + 1 }, (_, index) => index);
    for (let i = 1; i <= a.length; i += 1) {
      let previous = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j += 1) {
        const saved = row[j];
        row[j] = Math.min(
          row[j] + 1,
          row[j - 1] + 1,
          previous + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        previous = saved;
      }
    }
    return row[b.length];
  }

  function looksLikeArtifactBuild(value) {
    const text = String(value || '').toLowerCase();
    if (!text.trim()) return false;
    if (/\b(?:how|why|what|explain|show me how|teach me)\b/.test(text)) return false;
    const hasArtifact = /\b(?:html|page|website|webpage|component|screen|form|login|file|app|application|test|tests|config|configuration|script|readme|api|endpoint)\b/.test(text);
    if (!hasArtifact) return false;
    if (/\b(?:build|create|make|write|implement|develop|generate|add)\b/.test(text)) return true;
    return text
      .split(/[^a-z]+/)
      .filter(token => token.length >= 4 && token.length <= 9)
      .some(token => editDistance(token, 'build') <= 2 || editDistance(token, 'create') <= 2);
  }

  function forceModeForOneSubmission(mode) {
    if (!modeSelect || !mode) return;
    // This runs INSIDE the Send click, and switching modes swaps the composer to
    // that mode's stored draft (chat-sidebar-ui.js setMode). Keep the text the
    // user is sending, or the submission is silently lost.
    const pendingText = userInput ? userInput.value : '';
    const button = document.querySelector(`.mode-button[data-mode="${mode}"]`);
    if (button) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    } else {
      modeSelect.value = mode;
      modeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (userInput && userInput.value !== pendingText) userInput.value = pendingText;
    window.setTimeout(() => {
      const auto = document.querySelector('.mode-button[data-mode="auto"]');
      if (auto) auto.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }, 0);
  }

  function preserveConversationalIntent() {
    if (!userInput || !modeSelect) return;
    const text = userInput.value.trim();
    // A blocked send (turn still running, restoring, empty) must not repaint
    // the work panel: the composer stays editable while work runs, so Enter can
    // arrive with the send button disabled.
    // A queued next turn is not a submission either; its real send re-enters here.
    if (!text || sendButton?.disabled || window.__kdReadiness?.executionRunning) return;

    if (isAffirmativeFollowUp(text) && hasPriorAssistantContext()) {
      let desired = modeSelect.value;
      if (!desired || desired === 'auto') desired = 'chat';
      if (desired === 'autonomous' && !window.__kdActiveTaskSteering?.isActive?.()) desired = 'agent';
      if (desired === 'agent') setWorkState('investigating');
      forceModeForOneSubmission(desired);
      return;
    }

    /* Respect both legacy and compact explicit Baat Kar selection. Auto-routed
     * chat may be upgraded to Saath Kar for a create/build request; an explicit
     * Baat Kar choice remains conversational and gets the no-file-created cue. */
    const explicitlyChat = Boolean(
      document.querySelector('.mode-button[data-mode="chat"].active')
      || document.querySelector('.compact-mode-option[data-mode="chat"].active'),
    );
    if (looksLikeArtifactBuild(text) && !explicitlyChat && ['auto', 'chat', ''].includes(String(modeSelect.value || ''))) {
      setWorkState('investigating');
      forceModeForOneSubmission('agent');
      return;
    }

    if (modeSelect.value === 'agent') setWorkState('investigating');
  }

  sendButton?.addEventListener('click', preserveConversationalIntent, true);
  userInput?.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) preserveConversationalIntent();
  }, true);

  /* Approval buttons mutate in place before the next host event arrives. Move
   * the rich state surface out of Waiting immediately on the user's decision
   * so amber never lingers after approval/rejection. */
  messages?.addEventListener('click', event => {
    const button = event.target.closest?.('.approval-card button:not(:disabled), .mutation-confirmation-card button:not(:disabled)');
    if (button) setWorkState('working');
  }, true);

  elements.clearLog?.addEventListener('click', () => {
    logs.length = 0;
    renderLogs();
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    switch (message.type) {
      case 'persistedConversationsLoaded':
        for (const item of Array.isArray(message.conversations) ? message.conversations : []) {
          upsertTask(item);
        }
        log('system', 'task.catalog.loaded', `${tasks.size} durable task(s)`);
        renderOperations();
        break;
      case 'conversationCreated':
      case 'conversationUpdated':
        if (message.conversation) {
          upsertTask({
            id: message.conversation.id,
            title: message.conversation.title,
            model: message.conversation.model,
            status: 'active',
            phase: 'conversation',
            updatedAt: message.conversation.updatedAt,
            usage: {},
          });
          renderOperations();
        }
        break;
      case 'conversationDeleted':
        tasks.delete(String(message.id ?? ''));
        renderOperations();
        break;
      case 'taskSnapshot':
      case 'taskResumed':
      case 'taskPaused':
      case 'taskCancelled':
      case 'taskSteered':
        if (message.snapshot) {
          upsertSnapshot(message.snapshot, message.taskId);
          renderOperations();
        }
        logForTaskMessage(message);
        break;
      case 'engineEvent':
        if (message.event) {
          const engine = message.event;
          log(levelForEvent(engine), `engine.${String(engine.type ?? 'event')}`, summarize(engine));
        }
        break;
      case 'toolStart':
        hideAmbient();
        setWorkState(isValidationTool(message.toolName) ? 'checking' : (isReadOnlyTool(message.toolName) ? 'investigating' : 'working'));
        log('info', `tool.${String(message.toolName ?? 'unknown')}.started`, summarize(message.args));
        markActiveTaskRunning();
        break;
      case 'toolResult':
        if (!message.ok) setWorkState('blocked');
        else setWorkState(isValidationTool(message.toolName) ? 'checking' : (isReadOnlyTool(message.toolName) ? 'investigating' : 'working'));
        log(message.ok ? 'success' : 'error', `tool.${String(message.toolName ?? 'unknown')}.${message.ok ? 'completed' : 'failed'}`, message.ok ? summarize(message.result) : String(message.error ?? ''));
        break;
      case 'modelSelected':
        log('info', 'provider.model.selected', `${String(message.model ?? '')} · ${String(message.reason ?? '')}`);
        break;
      case 'approvalRequest':
        setWorkState('waiting');
        log('warning', 'policy.approval.requested', String(message.toolName ?? 'operation'));
        break;
      case 'done':
        if (messages?.querySelector('.tool-card, .approval-card')) setWorkState('completed');
        log('success', 'task.run.completed', 'Validation completed');
        renderOperations();
        break;
      case 'stopped':
        if (messages?.querySelector('.tool-card, .approval-card')) setWorkState('stopped');
        log('warning', 'task.run.stopped', 'Stopped by user');
        renderOperations();
        break;
      case 'error':
        if (messages?.querySelector('.tool-card, .approval-card')) setWorkState('blocked');
        log('error', 'runtime.error', String(message.message ?? 'Unknown error'));
        renderOperations();
        break;
      case 'newConversation':
        setWorkState('');
        hideAmbient(false);
        log('info', 'session.created', String(message.id ?? 'new session'));
        break;
      case 'conversationSelected':
        setWorkState('');
        log('info', 'session.selected', String(message.id ?? ''));
        break;
      case 'modelsLoaded':
        log('success', 'provider.models.loaded', `${Array.isArray(message.models) ? message.models.length : 0} model(s)`);
        break;
      case 'clear':
        setWorkState('');
        hideAmbient(false);
        break;
    }
  });

  function upsertSnapshot(snapshot, fallbackId) {
    const task = snapshot.task || {};
    upsertTask({
      id: task.taskId || fallbackId,
      title: task.title || task.userGoal || task.taskId || fallbackId,
      model: task.model || 'unknown',
      status: task.status || snapshot.phase || 'unknown',
      phase: snapshot.phase || task.status || 'unknown',
      updatedAt: task.updatedAt ? Date.parse(task.updatedAt) : Date.now(),
      blockedReason: snapshot.blockedReason,
      usage: snapshot.usage || {},
      budgets: snapshot.budgets || {},
      isRecoverable: ['blocked', 'paused', 'recovering'].includes(snapshot.phase),
    });
  }

  function upsertTask(value) {
    const id = String(value?.id || value?.taskId || '');
    if (!id) return;
    const previous = tasks.get(id) || {};
    tasks.set(id, {
      ...previous,
      ...value,
      id,
      title: String(value.title || previous.title || id),
      status: String(value.status || previous.status || 'unknown'),
      phase: String(value.phase || previous.phase || value.status || 'unknown'),
      model: String(value.model || previous.model || 'unknown'),
      updatedAt: normalizeTime(value.updatedAt || previous.updatedAt || Date.now()),
      usage: { ...(previous.usage || {}), ...(value.usage || {}) },
      budgets: { ...(previous.budgets || {}), ...(value.budgets || {}) },
    });
  }

  function renderOperations() {
    const values = [...tasks.values()].sort((left, right) => right.updatedAt - left.updatedAt);
    const running = values.filter(task => ['running', 'executing', 'validating', 'repairing', 'ready'].includes(task.status) || ['executing', 'validating', 'repairing'].includes(task.phase)).length;
    const blocked = values.filter(task => ['blocked', 'paused', 'recovering', 'waiting_for_approval'].includes(task.status) || ['blocked', 'paused', 'recovering', 'waiting_for_approval'].includes(task.phase)).length;
    setText(elements.taskCount, values.length);
    setText(elements.runningCount, running);
    setText(elements.blockedCount, blocked);
    setText(elements.worktreeCount, countWorktrees(values));
    if (elements.updated) elements.updated.textContent = `Updated ${formatRelative(Date.now())}`;
    // Task list DOM is owned by chat-operations.js so live updates can
    // preserve scroll position instead of wiping the panel on every event.
  }

  function renderTaskList(values) {
    if (!elements.taskList) return;
    elements.taskList.textContent = '';
    if (values.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'No durable tasks yet.';
      elements.taskList.appendChild(empty);
      return;
    }

    for (const task of values) {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.tabIndex = 0;
      row.title = task.blockedReason || task.title;

      const info = document.createElement('div');
      info.className = 'task-info';
      const name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = task.title;
      const details = document.createElement('span');
      details.className = 'task-details';
      const usage = task.usage || {};
      details.textContent = `${shortModel(task.model)} · tools ${number(usage.toolCalls)} · model ${number(usage.modelCalls)} · ${formatRelative(task.updatedAt)}`;
      info.append(name, details);

      const status = document.createElement('span');
      const statusValue = normalizedStatus(task);
      status.className = `badge-pill ${statusValue}`;
      status.textContent = statusValue;
      row.append(info, status);

      const activate = () => {
        vscode.postMessage({ type: 'selectConversation', id: task.id });
        if (task.isRecoverable) {
          vscode.postMessage({ type: 'getTaskSnapshot', taskId: task.id });
        }
      };
      row.addEventListener('click', activate);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      elements.taskList.appendChild(row);
    }
  }

  function log(level, eventName, detail) {
    logs.push({
      level,
      eventName,
      detail: String(detail || '').slice(0, 500),
      timestamp: new Date().toISOString(),
    });
    while (logs.length > maximumLogs) logs.shift();
    renderLogs();
  }

  function renderLogs() {
    if (!elements.logList) return;
    elements.logList.textContent = '';
    if (logs.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = 'Runtime events will appear here.';
      elements.logList.appendChild(empty);
      return;
    }
    for (const entry of [...logs].reverse()) {
      const row = document.createElement('div');
      row.className = 'log-item';
      const level = document.createElement('span');
      level.className = `log-level ${entry.level}`;
      const eventText = document.createElement('span');
      eventText.className = 'log-event';
      eventText.textContent = `> ${entry.eventName}${entry.detail ? ` · ${entry.detail}` : ''}`;
      const time = document.createElement('span');
      time.className = 'log-time';
      time.textContent = new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      row.append(level, eventText, time);
      elements.logList.appendChild(row);
    }
  }

  function logForTaskMessage(message) {
    const suffix = String(message.type || '').replace(/^task/, '').toLowerCase();
    log(suffix === 'cancelled' ? 'warning' : 'info', `task.${suffix || 'updated'}`, String(message.taskId ?? ''));
  }

  function markActiveTaskRunning() {
    const newest = [...tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (!newest) return;
    newest.status = 'running';
    newest.phase = 'executing';
    newest.updatedAt = Date.now();
    tasks.set(newest.id, newest);
    renderOperations();
  }

  function hideAmbient(hidden = true) {
    if (elements.ambient) elements.ambient.style.display = hidden ? 'none' : '';
  }

  function normalizedStatus(task) {
    const value = String(task.phase || task.status || 'unknown').toLowerCase();
    if (['executing', 'validating', 'repairing', 'ready', 'running'].includes(value)) return 'running';
    if (['blocked', 'waiting_for_approval'].includes(value)) return 'blocked';
    if (['paused', 'recovering', 'completed', 'failed', 'cancelled'].includes(value)) return value;
    return value.replace(/[^a-z0-9_-]/g, '-') || 'unknown';
  }

  function countWorktrees(values) {
    return values.filter(task => task.worktree || task.branch || task.writePaths?.length).length;
  }

  function shortModel(value) {
    const model = String(value || 'unknown');
    return model.length > 24 ? `${model.slice(0, 21)}…` : model;
  }

  function number(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function normalizeTime(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function formatRelative(value) {
    const delta = Math.max(0, Date.now() - normalizeTime(value));
    if (delta < 10_000) return 'now';
    if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
  }

  function levelForEvent(event) {
    const type = String(event.type || '').toLowerCase();
    if (type.includes('fail') || type.includes('error') || type.includes('blocked')) return 'error';
    if (type.includes('approval') || type.includes('pause') || type.includes('cancel')) return 'warning';
    if (type.includes('complete') || type.includes('pass') || type.includes('success')) return 'success';
    return 'info';
  }

  function summarize(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value.slice(0, 240);
    try {
      return JSON.stringify(value).slice(0, 240);
    } catch {
      return String(value).slice(0, 240);
    }
  }

  function setText(element, value) {
    if (element) element.textContent = String(value);
  }

  renderOperations();
  renderLogs();
})();
