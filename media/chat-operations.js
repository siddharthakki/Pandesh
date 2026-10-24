(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  if (!vscode) {
    throw new Error('Shared VS Code webview API is unavailable.');
  }

  const taskCount = document.getElementById('metric-tasks');
  const runningCount = document.getElementById('metric-running');
  const blockedCount = document.getElementById('metric-blocked');
  const worktreeCount = document.getElementById('metric-worktrees');
  const updated = document.getElementById('operations-updated');
  const taskList = document.getElementById('operations-task-list');
  const activityJumpLatestBtn = document.getElementById('kd-activity-jump-latest');
  const archiveOldBtn = document.getElementById('archive-old-tasks-btn');
  const viewActiveBtn = document.getElementById('task-view-active-btn');
  const viewHistoryBtn = document.getElementById('task-view-history-btn');
  let requestTimer;
  let currentView = 'active';
  let lastActiveTasks = [];
  let lastArchivedTasks = [];
  let openMenuTaskId;
  let followLatest = true;
  let ignoreActivityScroll = false;
  const FOLLOW_LATEST_THRESHOLD_PX = 40;

  function isActivityAtLatest() {
    if (!taskList) return true;
    return taskList.scrollTop < FOLLOW_LATEST_THRESHOLD_PX;
  }

  function syncActivityJumpButton() {
    if (!activityJumpLatestBtn) return;
    activityJumpLatestBtn.hidden = followLatest || currentView !== 'active';
  }

  function pinActivityToLatest() {
    followLatest = true;
    ignoreActivityScroll = true;
    if (taskList) taskList.scrollTop = 0;
    syncActivityJumpButton();
    window.setTimeout(() => { ignoreActivityScroll = false; }, 0);
  }

  taskList?.addEventListener('scroll', () => {
    if (ignoreActivityScroll) return;
    followLatest = isActivityAtLatest();
    syncActivityJumpButton();
  }, { passive: true });

  activityJumpLatestBtn?.addEventListener('click', () => {
    pinActivityToLatest();
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'operationsSnapshot' && message.snapshot) {
      render(message.snapshot);
      return;
    }
    if (message.type === 'archivedTasksSnapshot') {
      lastArchivedTasks = Array.isArray(message.tasks) ? message.tasks : [];
      if (currentView === 'history') { renderTasks(lastArchivedTasks, { archived: true }); }
      return;
    }
    if ([
      'persistedConversationsLoaded',
      'taskSnapshot',
      'taskResumed',
      'taskPaused',
      'taskCancelled',
      'taskSteered',
      'done',
      'stopped',
      'error',
      'conversationDeleted',
      'tasksArchived',
    ].includes(message.type)) {
      scheduleRequest();
      if (message.type === 'tasksArchived' && currentView === 'history') {
        vscode.postMessage({ type: 'getArchivedTasksSnapshot' });
      }
    }
  });

  if (viewActiveBtn && viewHistoryBtn) {
    viewActiveBtn.addEventListener('click', () => setView('active'));
    viewHistoryBtn.addEventListener('click', () => setView('history'));
  }

  if (archiveOldBtn) {
    archiveOldBtn.addEventListener('click', () => {
      const confirmed = window.confirm(
        'Archive completed, cancelled, failed, and blocked tasks last updated more than 7 days ago?\n\n' +
        'Running and waiting-for-approval tasks are never archived. Archived tasks move to History; their evidence and audit history are preserved.',
      );
      if (!confirmed) return;
      vscode.postMessage({ type: 'archiveOldTasks' });
    });
  }

  function setView(view) {
    if (currentView === view) return;
    currentView = view;
    closeMenu();
    if (viewActiveBtn && viewHistoryBtn) {
      viewActiveBtn.classList.toggle('active', view === 'active');
      viewActiveBtn.setAttribute('aria-selected', String(view === 'active'));
      viewHistoryBtn.classList.toggle('active', view === 'history');
      viewHistoryBtn.setAttribute('aria-selected', String(view === 'history'));
    }
    if (view === 'active') {
      renderTasks(lastActiveTasks, { archived: false });
    } else {
      vscode.postMessage({ type: 'getArchivedTasksSnapshot' });
      renderTasks(lastArchivedTasks, { archived: true });
    }
  }

  function scheduleRequest() {
    clearTimeout(requestTimer);
    requestTimer = setTimeout(() => {
      vscode.postMessage({ type: 'getOperationsSnapshot' });
    }, 50);
  }

  function render(snapshot) {
    const totals = snapshot.totals || {};
    setText(taskCount, totals.tasks || 0);
    setText(runningCount, totals.running || 0);
    setText(blockedCount, totals.blocked || 0);
    setText(worktreeCount, totals.retainedWorktrees || 0);
    if (updated) {
      const timestamp = Date.parse(String(snapshot.generatedAt || ''));
      updated.textContent = Number.isFinite(timestamp)
        ? `Updated ${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
        : 'Updated now';
    }
    lastActiveTasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
    if (currentView === 'active') { renderTasks(lastActiveTasks, { archived: false }); }
  }

  function renderTasks(tasks, options) {
    if (!taskList) return;
    const archived = Boolean(options && options.archived);
    const pinned = followLatest || isActivityAtLatest();
    const savedTop = taskList.scrollTop;
    closeMenu();
    taskList.textContent = '';
    if (tasks.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = archived ? 'No archived tasks.' : 'No durable tasks yet.';
      taskList.appendChild(empty);
      restoreActivityScroll(pinned, savedTop);
      return;
    }

    for (const task of tasks.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'task-row';
      row.tabIndex = 0;
      row.title = String(task.blockedReason || task.failure?.message || task.title || task.taskId || '');

      const info = document.createElement('div');
      info.className = 'task-info';
      const name = document.createElement('span');
      name.className = 'task-name';
      name.textContent = String(task.title || task.taskId || 'Untitled task');
      const details = document.createElement('span');
      details.className = 'task-details';
      details.textContent = archived
        ? `${shortModel(task.model)} · ${relative(task.updatedAt)}`
        : `${shortModel(task.model)} · tools ${number(task.usage?.toolCalls)} · model ${number(task.usage?.modelCalls)} · ${relative(task.updatedAt)}`;
      info.append(name, details);

      const status = document.createElement('span');
      const statusValue = normalizeStatus(task.phase || task.status);
      status.className = `badge-pill ${statusValue}`;
      status.textContent = statusValue;

      const actions = document.createElement('div');
      actions.className = 'task-row-actions';
      actions.append(status, buildMenuButton(task, archived));

      row.append(info, actions);

      const activate = () => openTask(task);
      row.addEventListener('click', activate);
      row.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
        }
      });
      taskList.appendChild(row);
    }
    restoreActivityScroll(pinned, savedTop);
  }

  function restoreActivityScroll(pinned, savedTop) {
    ignoreActivityScroll = true;
    if (pinned) {
      followLatest = true;
      taskList.scrollTop = 0;
    } else {
      taskList.scrollTop = savedTop;
      followLatest = isActivityAtLatest();
    }
    syncActivityJumpButton();
    window.setTimeout(() => { ignoreActivityScroll = false; }, 0);
  }

  function buildMenuButton(task, archived) {
    const wrap = document.createElement('div');
    wrap.style.position = 'relative';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'task-menu-btn';
    btn.textContent = '⋯';
    btn.setAttribute('aria-label', 'Task actions');
    btn.addEventListener('click', event => {
      event.stopPropagation();
      toggleMenu(wrap, task, archived, btn);
    });

    wrap.appendChild(btn);
    return wrap;
  }

  function toggleMenu(wrap, task, archived, btn) {
    const taskId = String(task.taskId || '');
    if (openMenuTaskId === taskId) {
      closeMenu();
      return;
    }
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'task-menu';
    menu.addEventListener('click', event => event.stopPropagation());

    for (const action of buildActions(task, archived)) {
      const item = document.createElement('button');
      item.type = 'button';
      item.textContent = action.label;
      if (action.danger) item.classList.add('danger');
      item.addEventListener('click', event => {
        event.stopPropagation();
        closeMenu();
        action.run();
      });
      menu.appendChild(item);
    }

    wrap.appendChild(menu);
    btn.classList.add('open');
    openMenuTaskId = taskId;

    setTimeout(() => {
      document.addEventListener('click', closeMenu, { once: true });
    }, 0);
  }

  function closeMenu() {
    if (!openMenuTaskId) return;
    openMenuTaskId = undefined;
    taskList?.querySelectorAll('.task-menu').forEach(node => node.remove());
    taskList?.querySelectorAll('.task-menu-btn.open').forEach(node => node.classList.remove('open'));
  }

  function buildActions(task, archived) {
    const taskId = String(task.taskId || '');
    if (!taskId) return [];

    if (archived) {
      const actions = [{ label: 'Open', run: () => openTask(task) }];
      if (task.blockedReason) actions.push({ label: 'View reason', run: () => viewReason(task) });
      if (task.failure?.message) actions.push({ label: 'View error', run: () => viewError(task) });
      actions.push({ label: 'Retry from scratch', run: () => retryTask(taskId) });
      return actions;
    }

    const state = actionState(task);
    switch (state) {
      case 'running':
        return [
          { label: 'Open', run: () => openTask(task) },
          { label: 'Cancel', run: () => cancelTask(taskId), danger: true },
        ];
      case 'waiting_for_approval':
        return [
          { label: 'Review', run: () => openTask(task) },
          { label: 'Approve', run: () => respondToApproval(task, 'approved') },
          { label: 'Reject', run: () => respondToApproval(task, 'rejected'), danger: true },
        ];
      case 'blocked':
        return [
          { label: 'View reason', run: () => viewReason(task) },
          { label: 'Retry from scratch', run: () => retryTask(taskId) },
          { label: 'Archive', run: () => archiveTask(taskId) },
        ];
      case 'failed':
        return [
          { label: 'View error', run: () => viewError(task) },
          { label: 'Retry from scratch', run: () => retryTask(taskId) },
          { label: 'Archive', run: () => archiveTask(taskId) },
        ];
      case 'cancelled':
        return [
          { label: 'Retry from scratch', run: () => retryTask(taskId) },
          { label: 'Archive', run: () => archiveTask(taskId) },
        ];
      case 'completed':
        return [
          { label: 'Open result', run: () => openTask(task) },
          { label: 'Run again', run: () => retryTask(taskId) },
          { label: 'Archive', run: () => archiveTask(taskId) },
        ];
      default:
        return [{ label: 'Open', run: () => openTask(task) }];
    }
  }

  function actionState(task) {
    const value = String(task.phase || task.status || '').toLowerCase();
    if (['executing', 'validating', 'repairing', 'ready', 'running'].includes(value)) return 'running';
    if (value === 'waiting_for_approval') return 'waiting_for_approval';
    if (value === 'blocked') return 'blocked';
    if (value === 'failed') return 'failed';
    if (value === 'cancelled') return 'cancelled';
    if (value === 'completed') return 'completed';
    return 'other';
  }

  function openTask(task) {
    const taskId = String(task.taskId || '');
    if (!taskId) return;
    vscode.postMessage({ type: 'selectConversation', id: taskId });
    vscode.postMessage({ type: 'getTaskSnapshot', taskId });
  }

  function cancelTask(taskId) {
    vscode.postMessage({ type: 'cancelTask', taskId });
  }

  function respondToApproval(task, response) {
    const approvalId = task.pendingApprovalId;
    if (!approvalId) {
      window.alert('No pending approval was found for this task — it may have already been resolved.');
      return;
    }
    vscode.postMessage({ type: 'approvalResponse', id: approvalId, response });
  }

  function retryTask(taskId) {
    vscode.postMessage({ type: 'retryTask', taskId });
  }

  function archiveTask(taskId) {
    vscode.postMessage({ type: 'deleteConversation', id: taskId });
  }

  function viewReason(task) {
    window.alert(task.blockedReason ? `Blocked: ${task.blockedReason}` : 'No blocked reason was recorded for this task.');
  }

  function viewError(task) {
    window.alert(task.failure?.message ? `Error: ${task.failure.message}` : 'No error details were recorded for this task.');
  }

  function normalizeStatus(value) {
    const status = String(value || 'unknown').toLowerCase();
    if (['executing', 'validating', 'repairing', 'ready', 'running'].includes(status)) return 'running';
    if (['blocked', 'waiting_for_approval'].includes(status)) return 'blocked';
    if (['paused', 'recovering', 'completed', 'failed', 'cancelled'].includes(status)) return status;
    return status.replace(/[^a-z0-9_-]/g, '-') || 'unknown';
  }

  function shortModel(value) {
    const model = String(value || 'unknown');
    return model.length > 24 ? `${model.slice(0, 21)}…` : model;
  }

  function relative(value) {
    const parsed = Date.parse(String(value || ''));
    if (!Number.isFinite(parsed)) return 'now';
    const delta = Math.max(0, Date.now() - parsed);
    if (delta < 60_000) return 'now';
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    return `${Math.floor(delta / 86_400_000)}d ago`;
  }

  function number(value) {
    return Number.isFinite(Number(value)) ? Number(value) : 0;
  }

  function setText(element, value) {
    if (element) element.textContent = String(value);
  }

  scheduleRequest();
})();

// P1/P2/P3 — prompt visibility + Governed Neon presentation augmentation.
// This deliberately lives in the already-loaded operations layer so it can
// observe Core messages without introducing a second task/control authority.
(function () {
  'use strict';

  const vscode = window.__ollamaAgentVsCodeApi;
  if (!vscode) return;

  const objectiveCard = document.getElementById('task-request-entry');
  const objectiveText = document.getElementById('autonomous-prompt-summary');
  const taskDetails = document.getElementById('kd-task-details');
  const historyList = document.getElementById('everyday-history-list');
  const activityList = document.getElementById('operations-task-list');
  const overflowMenu = document.getElementById('overflow-menu');
  const objectivesByTask = new Map();
  const objectivesByAttempt = new Map();
  let activeObjective = '';
  let activeConstraints = [];
  let activeTaskId = '';
  let historyTasks = [];
  let activeActivityTasks = [];
  let archivedActivityTasks = [];
  let lastFocusedElement = null;
  let celebratedTaskId = null;

  const carriedConstraints = /\n\nConstraints carried forward from this conversation: (.+)\.$/;

  function splitObjective(value) {
    const text = String(value || '').trim();
    const match = carriedConstraints.exec(text);
    if (!match) return { objective: text, constraints: [] };
    return {
      objective: text.slice(0, match.index).trim(),
      constraints: match[1].split(';').map(item => item.trim()).filter(Boolean),
    };
  }

  function objectiveFromTask(task) {
    if (!task || typeof task !== 'object') return '';
    return String(task.goal || task.currentMessage || task.prompt || task.objective || task.title || '').trim();
  }

  function copyText(text, button) {
    const value = String(text || '');
    if (!value) return;
    const markCopied = () => {
      if (!button) return;
      const previous = button.textContent;
      button.textContent = 'Copied';
      button.dataset.copied = 'true';
      window.setTimeout(() => {
        button.textContent = previous;
        delete button.dataset.copied;
      }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(value).then(markCopied).catch(() => fallbackCopy(value, markCopied));
    } else {
      fallbackCopy(value, markCopied);
    }
  }

  function fallbackCopy(value, onCopied) {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try { document.execCommand('copy'); onCopied?.(); } catch { /* best effort */ }
    textarea.remove();
  }

  function ensurePromptModal() {
    let modal = document.getElementById('kd-prompt-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'kd-prompt-modal';
    modal.className = 'kd-prompt-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'false');
    modal.setAttribute('aria-labelledby', 'kd-prompt-modal-title');

    const panel = document.createElement('section');
    panel.className = 'kd-prompt-modal-panel';
    const header = document.createElement('div');
    header.className = 'kd-prompt-modal-header';
    const title = document.createElement('h2');
    title.id = 'kd-prompt-modal-title';
    title.textContent = 'Full task objective';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'kd-prompt-icon-button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Close full prompt');
    header.append(title, close);

    const prompt = document.createElement('pre');
    prompt.className = 'kd-prompt-modal-text';
    prompt.id = 'kd-prompt-modal-text';
    const constraints = document.createElement('div');
    constraints.className = 'kd-prompt-modal-constraints';
    constraints.id = 'kd-prompt-modal-constraints';
    const actions = document.createElement('div');
    actions.className = 'kd-prompt-modal-actions';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn-primary compact-btn';
    copy.textContent = 'Copy prompt';
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'btn btn-ghost compact-btn';
    done.textContent = 'Close';
    actions.append(copy, done);
    panel.append(header, prompt, constraints, actions);
    modal.appendChild(panel);
    document.body.appendChild(modal);

    const hide = () => {
      modal.hidden = true;
      document.body.classList.remove('kd-modal-open');
      lastFocusedElement?.focus?.();
    };
    close.addEventListener('click', hide);
    done.addEventListener('click', hide);
    modal.addEventListener('click', event => { if (event.target === modal) hide(); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !modal.hidden) hide();
    });
    copy.addEventListener('click', () => copyText(modal.dataset.copyText || prompt.textContent || '', copy));
    return modal;
  }

  function openPromptViewer(text, constraints, title) {
    const value = String(text || '').trim();
    if (!value) return;
    const modal = ensurePromptModal();
    lastFocusedElement = document.activeElement;
    const heading = modal.querySelector('#kd-prompt-modal-title');
    const prompt = modal.querySelector('#kd-prompt-modal-text');
    const constraintBox = modal.querySelector('#kd-prompt-modal-constraints');
    if (heading) heading.textContent = title || 'Full task objective';
    if (prompt) prompt.textContent = value;
    const list = Array.isArray(constraints) ? constraints.filter(Boolean) : [];
    if (constraintBox) {
      constraintBox.replaceChildren();
      constraintBox.hidden = list.length === 0;
      if (list.length) {
        const label = document.createElement('strong');
        label.textContent = 'Carried constraints';
        const ul = document.createElement('ul');
        for (const constraint of list) {
          const li = document.createElement('li');
          li.textContent = constraint;
          ul.appendChild(li);
        }
        constraintBox.append(label, ul);
      }
    }
    modal.dataset.copyText = value;
    modal.hidden = false;
    document.body.classList.add('kd-modal-open');
    modal.querySelector('.kd-prompt-icon-button')?.focus();
  }

  function makePromptAction(label, className) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `kd-prompt-action ${className || ''}`.trim();
    button.textContent = label;
    return button;
  }

  function ensureObjectiveControls() {
    if (!objectiveCard || !objectiveText) return;
    objectiveText.classList.add('kd-objective-text');
    if (objectiveCard.querySelector('.kd-objective-actions')) return;
    const actions = document.createElement('div');
    actions.className = 'kd-objective-actions';
    const expand = makePromptAction('Expand', 'kd-objective-expand');
    const copy = makePromptAction('Copy', 'kd-objective-copy');
    const view = makePromptAction('View full prompt', 'kd-objective-view');
    expand.addEventListener('click', () => {
      const expanded = objectiveCard.classList.toggle('is-expanded');
      expand.textContent = expanded ? 'Collapse' : 'Expand';
      expand.setAttribute('aria-expanded', String(expanded));
    });
    copy.addEventListener('click', () => copyText(activeObjective || objectiveText.textContent, copy));
    view.addEventListener('click', () => openPromptViewer(activeObjective || objectiveText.textContent, activeConstraints));
    actions.append(expand, copy, view);
    objectiveCard.appendChild(actions);
  }

  function ensureTaskDetailObjective() {
    if (!taskDetails) return;
    const summary = taskDetails.querySelector('.autonomous-summary');
    if (!summary) return;
    let row = document.getElementById('kd-task-objective-detail');
    if (!row) {
      row = document.createElement('div');
      row.id = 'kd-task-objective-detail';
      row.className = 'kd-task-objective-detail';
      const label = document.createElement('span');
      label.className = 'field-label';
      label.textContent = 'Objective';
      const preview = document.createElement('span');
      preview.className = 'kd-task-objective-preview';
      const view = makePromptAction('View full prompt', 'kd-task-objective-view');
      view.addEventListener('click', () => openPromptViewer(activeObjective || preview.textContent, activeConstraints));
      row.append(label, preview, view);
      summary.insertBefore(row, summary.firstChild);
    }
    const preview = row.querySelector('.kd-task-objective-preview');
    if (preview && activeObjective) preview.textContent = activeObjective;
  }

  function syncObjectiveSurface() {
    ensureObjectiveControls();
    ensureTaskDetailObjective();
    if (!objectiveText || !activeObjective) return;
    // chat-autonomous.js intentionally wrote a short summary. Replace it after
    // its synchronous message handler with the full original objective; CSS
    // owns the visual clamp so the data is never destroyed or irretrievable.
    objectiveText.textContent = activeObjective;
    objectiveText.title = activeObjective;
    if (objectiveCard) objectiveCard.dataset.hasFullObjective = 'true';
    const detailPreview = document.querySelector('#kd-task-objective-detail .kd-task-objective-preview');
    if (detailPreview) detailPreview.textContent = activeObjective;
  }

  function rememberGoal(goal, taskId, attemptId) {
    const full = String(goal || '').trim();
    if (!full) return;
    const split = splitObjective(full);
    if (!split.objective) return;
    activeObjective = split.objective;
    activeConstraints = split.constraints;
    if (taskId) {
      activeTaskId = String(taskId);
      objectivesByTask.set(String(taskId), split.objective);
    }
    if (attemptId) objectivesByAttempt.set(String(attemptId), split.objective);
    queueMicrotask(syncObjectiveSurface);
    window.requestAnimationFrame?.(syncObjectiveSurface);
  }

  function captureHistory(message) {
    historyTasks = Array.isArray(message.tasks) ? message.tasks : [];
    for (const task of historyTasks) {
      const objective = objectiveFromTask(task);
      if (objective && task.attemptId) objectivesByAttempt.set(String(task.attemptId), splitObjective(objective).objective);
      if (objective && task.taskId) objectivesByTask.set(String(task.taskId), splitObjective(objective).objective);
    }
    queueMicrotask(decorateHistory);
  }

  function captureActivity(tasks, archived) {
    const list = Array.isArray(tasks) ? tasks : [];
    if (archived) archivedActivityTasks = list;
    else activeActivityTasks = list;
    for (const task of list) {
      const objective = objectiveFromTask(task);
      if (objective && task.taskId) objectivesByTask.set(String(task.taskId), splitObjective(objective).objective);
    }
    queueMicrotask(decorateActivity);
  }

  function historyTaskForItem(item) {
    const attemptId = String(item?.dataset?.attemptId || '');
    return historyTasks.find(task => String(task.attemptId || '') === attemptId) || null;
  }

  function decorateHistory() {
    if (!historyList) return;
    for (const item of historyList.querySelectorAll('.everyday-history-item')) {
      const task = historyTaskForItem(item);
      if (!task) continue;
      const raw = objectiveFromTask(task);
      const objective = splitObjective(raw).objective || objectivesByAttempt.get(String(task.attemptId || '')) || '';
      if (!objective) continue;
      const request = item.querySelector('.everyday-history-request');
      if (request) {
        // Idempotent: this node lives inside the observed subtree, so an
        // unconditional write re-triggers the MutationObserver forever.
        if (request.textContent !== objective) request.textContent = objective;
        request.classList.add('kd-prompt-preview');
        request.title = objective;
      }
      if (!item.querySelector('.kd-history-prompt-actions')) {
        const actions = document.createElement('div');
        actions.className = 'kd-history-prompt-actions';
        const view = makePromptAction('View full prompt', 'kd-history-view-prompt');
        const copy = makePromptAction('Copy', 'kd-history-copy-prompt');
        view.addEventListener('click', event => {
          event.stopPropagation();
          openPromptViewer(objective, [], 'Full history objective');
        });
        copy.addEventListener('click', event => {
          event.stopPropagation();
          copyText(objective, copy);
        });
        actions.append(view, copy);
        const body = item.querySelector('.everyday-history-body');
        item.insertBefore(actions, body || null);
      }
    }
  }

  function activityTasksForCurrentView() {
    const historyButton = document.getElementById('task-view-history-btn');
    return historyButton?.classList.contains('active') ? archivedActivityTasks : activeActivityTasks;
  }

  function decorateActivity() {
    if (!activityList) return;
    const tasks = activityTasksForCurrentView();
    const rows = Array.from(activityList.querySelectorAll('.task-row'));
    rows.forEach((row, index) => {
      const task = tasks[index];
      if (!task) return;
      const raw = objectiveFromTask(task) || objectivesByTask.get(String(task.taskId || '')) || '';
      const objective = splitObjective(raw).objective;
      if (!objective) return;
      const name = row.querySelector('.task-name');
      if (name) {
        if (name.textContent !== objective) name.textContent = objective; // idempotent (observed subtree)
        name.classList.add('kd-prompt-preview');
        name.title = objective;
      }
      if (!row.querySelector('.kd-activity-view-prompt')) {
        const button = makePromptAction('View prompt', 'kd-activity-view-prompt');
        button.addEventListener('click', event => {
          event.preventDefault();
          event.stopPropagation();
          openPromptViewer(objective, [], 'Task objective');
        });
        row.querySelector('.task-info')?.appendChild(button);
      }
      const details = row.querySelector('.task-details');
      const repo = task.repositoryName || task.repository || task.repo || task.workspaceName;
      const provider = task.provider;
      const model = task.model;
      if (details && (repo || provider || model)) {
        const parts = [];
        if (repo) parts.push(String(repo));
        if (provider && model) parts.push(`${provider} / ${model}`);
        else if (model) parts.push(String(model));
        if (parts.length) details.dataset.kdIdentity = parts.join(' · ');
      }
    });
  }

  function setVisualState(state) {
    const value = String(state || '').toLowerCase();
    if (!value) return;
    document.body.dataset.kdTaskState = value;
    objectiveCard?.setAttribute('data-task-state', value);
  }

  function emitConfetti(taskId) {
    const id = String(taskId || activeTaskId || 'completed');
    if (celebratedTaskId === id || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    celebratedTaskId = id;
    const host = document.getElementById('autonomous-status') || document.body;
    const burst = document.createElement('div');
    burst.className = 'kd-success-confetti';
    burst.setAttribute('aria-hidden', 'true');
    for (let index = 0; index < 14; index += 1) {
      const bit = document.createElement('i');
      bit.style.setProperty('--kd-confetti-x', `${8 + ((index * 37) % 84)}%`);
      bit.style.setProperty('--kd-confetti-delay', `${(index % 5) * 55}ms`);
      bit.style.setProperty('--kd-confetti-rotate', `${(index * 47) % 360}deg`);
      burst.appendChild(bit);
    }
    host.appendChild(burst);
    window.setTimeout(() => burst.remove(), 1700);
  }

  function installDemoModeToggle() {
    if (!overflowMenu || document.getElementById('kd-cinematic-toggle')) return;
    const button = document.createElement('button');
    button.id = 'kd-cinematic-toggle';
    button.className = 'menu-item';
    button.type = 'button';
    const state = (() => { try { return Boolean(vscode.getState?.()?.kdCinematicUi); } catch { return false; } })();
    document.body.classList.toggle('kd-cinematic', state);
    const update = () => { button.textContent = `Cinematic UI: ${document.body.classList.contains('kd-cinematic') ? 'On' : 'Off'}`; };
    update();
    button.addEventListener('click', () => {
      const enabled = document.body.classList.toggle('kd-cinematic');
      try {
        const existing = vscode.getState?.() || {};
        vscode.setState?.(Object.assign({}, existing, { kdCinematicUi: enabled }));
      } catch { /* presentation preference only */ }
      update();
    });
    overflowMenu.appendChild(button);
  }

  function installStyles() {
    if (document.getElementById('kd-governed-neon-style')) return;
    const style = document.createElement('style');
    style.id = 'kd-governed-neon-style';
    style.textContent = `
      :root {
        --kd-neon-cyan: #00d9ff;
        --kd-electric-teal: #00f0c8;
        --kd-approval-amber: #ffc247;
        --kd-success-green: #22c55e;
        --kd-safety-red: #ff4d4d;
        --kd-deep-navy: #0b1020;
        --kd-graphite: #05081a;
        --kd-soft-white: #e8f0ff;
      }
      .kd-objective-card {
        position: relative;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, var(--kd-neon-cyan) 48%, var(--vscode-panel-border));
        border-left: 3px solid color-mix(in srgb, #bb7cff 82%, var(--kd-neon-cyan));
        border-radius: 10px;
        background: linear-gradient(135deg, color-mix(in srgb, var(--kd-deep-navy) 70%, transparent), color-mix(in srgb, var(--vscode-editor-background) 94%, transparent));
        box-shadow: 0 0 18px rgba(0, 217, 255, .07), inset 0 1px 0 rgba(255,255,255,.03);
      }
      .kd-objective-card::after {
        content: '';
        position: absolute;
        top: 0;
        left: -24%;
        width: 24%;
        height: 1px;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, rgba(0,217,255,.9), rgba(0,240,200,.65), transparent);
        animation: kd-objective-trace 6.5s linear infinite;
      }
      .kd-objective-text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        word-break: break-word;
        margin-bottom: 6px;
      }
      .kd-objective-card:not(.is-expanded) .kd-objective-text {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        overflow: hidden;
      }
      .kd-objective-actions,
      .kd-history-prompt-actions {
        display: flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
        margin-top: 8px;
      }
      .kd-prompt-action {
        border: 1px solid color-mix(in srgb, var(--kd-neon-cyan) 38%, var(--vscode-button-border, transparent));
        border-radius: 6px;
        padding: 4px 8px;
        background: color-mix(in srgb, var(--vscode-button-secondaryBackground, #13213a) 88%, transparent);
        color: var(--vscode-button-secondaryForeground, var(--kd-soft-white));
        font: inherit;
        font-size: 11px;
        line-height: 1.2;
        cursor: pointer;
      }
      .kd-prompt-action:hover,
      .kd-prompt-action:focus-visible {
        border-color: var(--kd-neon-cyan);
        box-shadow: 0 0 0 1px rgba(0,217,255,.18), 0 0 12px rgba(0,217,255,.10);
        outline: none;
      }
      .kd-task-objective-detail {
        display: grid;
        grid-template-columns: max-content minmax(0, 1fr) max-content;
        gap: 8px;
        align-items: start;
      }
      .kd-task-objective-preview,
      .kd-prompt-preview {
        min-width: 0;
        white-space: normal;
        overflow-wrap: anywhere;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
      }
      .kd-prompt-modal[hidden] { display: none !important; }
      .kd-prompt-modal {
        position: fixed;
        inset: 0;
        z-index: 10000;
        display: grid;
        place-items: center;
        padding: 24px;
        background: rgba(2, 6, 18, .74);
        backdrop-filter: blur(5px);
      }
      .kd-prompt-modal-panel {
        width: min(760px, calc(100vw - 40px));
        max-height: min(720px, calc(100vh - 48px));
        display: flex;
        flex-direction: column;
        border: 1px solid rgba(0,217,255,.48);
        border-radius: 12px;
        background: color-mix(in srgb, var(--kd-deep-navy) 78%, var(--vscode-editor-background));
        box-shadow: 0 24px 70px rgba(0,0,0,.55), 0 0 30px rgba(0,217,255,.10);
        overflow: hidden;
      }
      .kd-prompt-modal-header,
      .kd-prompt-modal-actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 16px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }
      .kd-prompt-modal-header h2 { margin: 0; font-size: 15px; color: var(--kd-soft-white); }
      .kd-prompt-icon-button {
        border: 0;
        background: transparent;
        color: var(--vscode-foreground);
        cursor: pointer;
        font-size: 16px;
      }
      .kd-prompt-modal-text {
        margin: 0;
        padding: 18px 20px;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        font: inherit;
        line-height: 1.55;
        color: var(--vscode-editor-foreground);
      }
      .kd-prompt-modal-constraints {
        margin: 0 20px 16px;
        padding: 12px 14px;
        border-left: 2px solid var(--kd-approval-amber);
        background: rgba(255,194,71,.06);
      }
      .kd-prompt-modal-constraints ul { margin: 6px 0 0; padding-left: 18px; }
      .kd-prompt-modal-actions { justify-content: flex-end; border-top: 1px solid var(--vscode-panel-border); border-bottom: 0; }
      body.kd-modal-open { overflow: hidden; }

      .task-stage-tracker li {
        transition: color .18s ease, border-color .18s ease, background-color .18s ease, box-shadow .18s ease;
      }
      .task-stage-tracker li.is-complete { color: color-mix(in srgb, var(--kd-success-green) 82%, var(--vscode-foreground)); }
      .task-stage-tracker li.is-current {
        color: var(--kd-soft-white);
        background: rgba(0,217,255,.045);
        box-shadow: inset 0 -2px 0 color-mix(in srgb, var(--kd-neon-cyan) 74%, transparent), 0 5px 16px rgba(0,217,255,.06);
        animation: kd-stage-focus 2.8s ease-in-out infinite;
      }
      body[data-kd-task-state*='approval'] .task-stage-tracker li.is-current {
        box-shadow: inset 0 -2px 0 var(--kd-approval-amber), 0 5px 18px rgba(255,194,71,.08);
      }
      .delivery-approval-card,
      .everyday-approval-card {
        border-radius: 10px;
        border-color: color-mix(in srgb, var(--kd-approval-amber) 52%, var(--vscode-panel-border));
        background: linear-gradient(145deg, rgba(255,194,71,.055), rgba(0,0,0,0));
      }
      .kd-inline-approval[data-inline-approval-state='pending'] {
        box-shadow: 0 0 0 1px rgba(255,194,71,.12), 0 12px 32px rgba(0,0,0,.16);
      }
      .everyday-outcome-card.is-success {
        border-color: color-mix(in srgb, var(--kd-success-green) 70%, var(--vscode-panel-border));
        background: linear-gradient(135deg, rgba(34,197,94,.10), rgba(0,240,200,.025));
        box-shadow: 0 0 24px rgba(34,197,94,.07);
      }
      .everyday-outcome-card.is-blocked {
        border-color: color-mix(in srgb, var(--kd-safety-red) 68%, var(--vscode-panel-border));
        background: linear-gradient(135deg, rgba(255,77,77,.09), rgba(255,194,71,.02));
        box-shadow: 0 0 18px rgba(255,77,77,.055);
      }
      body[data-kd-task-state='blocked'] #autonomous-status,
      body[data-kd-task-state='failed'] #autonomous-status {
        box-shadow: inset 0 0 0 1px rgba(255,77,77,.12);
      }
      .kd-panda-icon .kd-panda-img { transform-origin: 50% 78%; }
      .kd-panda-icon[data-state='thinking'] .kd-panda-img,
      .kd-panda-icon[data-state='reading'] .kd-panda-img,
      .kd-panda-icon[data-state='searching'] .kd-panda-img,
      .kd-panda-icon[data-state='planning'] .kd-panda-img,
      .kd-panda-icon[data-state='coding'] .kd-panda-img,
      .kd-panda-icon[data-state='testing'] .kd-panda-img,
      .kd-panda-icon[data-state='reviewing'] .kd-panda-img {
        animation: kd-panda-working 2.8s ease-in-out infinite;
      }
      .kd-panda-icon[data-state='waiting_for_delivery_approval'] .kd-panda-img { animation: kd-panda-wait 2.6s ease-in-out infinite; }
      .kd-panda-icon[data-state='blocked'] .kd-panda-img,
      .kd-panda-icon[data-state='failed'] .kd-panda-img { animation: kd-panda-safe-stop 2.8s ease-in-out infinite; }
      .kd-panda-icon[data-state='completed'] .kd-panda-img { animation: kd-panda-complete .72s cubic-bezier(.2,.9,.25,1.2) 1; }
      .kd-success-confetti {
        position: absolute;
        inset: 0;
        pointer-events: none;
        overflow: hidden;
        z-index: 6;
      }
      .kd-success-confetti i {
        position: absolute;
        top: 8%;
        left: var(--kd-confetti-x);
        width: 5px;
        height: 9px;
        border-radius: 1px;
        background: var(--kd-neon-cyan);
        transform: rotate(var(--kd-confetti-rotate));
        opacity: 0;
        animation: kd-confetti-fall 1.25s ease-out var(--kd-confetti-delay) 1 forwards;
      }
      .kd-success-confetti i:nth-child(3n+1) { background: var(--kd-success-green); }
      .kd-success-confetti i:nth-child(3n+2) { background: var(--kd-approval-amber); }
      .kd-history-prompt-actions { margin: 0 8px 8px; }
      .kd-activity-view-prompt { align-self: flex-start; margin-top: 3px; }
      body.kd-cinematic .kd-objective-card { box-shadow: 0 0 24px rgba(0,217,255,.12), inset 0 1px 0 rgba(255,255,255,.04); }
      body.kd-cinematic .task-stage-tracker li.is-current { box-shadow: inset 0 -2px 0 var(--kd-neon-cyan), 0 0 18px rgba(0,217,255,.10); }
      body.kd-cinematic .kd-panda-icon.kd-img-ready { filter: drop-shadow(0 0 8px rgba(0,217,255,.12)); }

      @keyframes kd-objective-trace { 0% { left: -24%; opacity: 0; } 8% { opacity: .8; } 48% { opacity: .8; } 58%,100% { left: 108%; opacity: 0; } }
      @keyframes kd-stage-focus { 0%,100% { background-color: rgba(0,217,255,.025); } 50% { background-color: rgba(0,217,255,.065); } }
      @keyframes kd-panda-working { 0%,100% { transform: translateY(0) rotate(0); } 50% { transform: translateY(-1px) rotate(.7deg); } }
      @keyframes kd-panda-wait { 0%,100% { transform: scale(1); } 50% { transform: scale(1.018); } }
      @keyframes kd-panda-safe-stop { 0%,100% { opacity: 1; } 50% { opacity: .88; } }
      @keyframes kd-panda-complete { 0% { transform: scale(.94) translateY(2px); } 60% { transform: scale(1.055) translateY(-2px); } 100% { transform: scale(1) translateY(0); } }
      @keyframes kd-confetti-fall { 0% { transform: translateY(-12px) rotate(var(--kd-confetti-rotate)); opacity: 0; } 12% { opacity: .9; } 100% { transform: translateY(170px) rotate(calc(var(--kd-confetti-rotate) + 190deg)); opacity: 0; } }

      @media (prefers-reduced-motion: reduce) {
        .kd-objective-card::after,
        .task-stage-tracker li.is-current,
        .kd-panda-icon .kd-panda-img,
        .kd-success-confetti i { animation: none !important; transition: none !important; }
        .kd-success-confetti { display: none !important; }
      }
    `;
    document.head.appendChild(style);
  }

  const historyObserver = historyList ? new MutationObserver(() => decorateHistory()) : null;
  historyObserver?.observe(historyList, { childList: true, subtree: true });
  const activityObserver = activityList ? new MutationObserver(() => decorateActivity()) : null;
  activityObserver?.observe(activityList, { childList: true, subtree: true });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;

    if (typeof message.goal === 'string' && message.goal.trim()) {
      rememberGoal(message.goal, message.taskId, message.attemptId);
    } else if (message.task && typeof message.task.goal === 'string') {
      rememberGoal(message.task.goal, message.task.taskId || message.taskId, message.task.attemptId || message.attemptId);
    }

    if (message.type === 'everydayHistory') captureHistory(message);
    if (message.type === 'everydayHistoryDetail' && message.detail?.entry) {
      const detailObjective = objectiveFromTask(message.detail.entry);
      if (detailObjective && message.attemptId) objectivesByAttempt.set(String(message.attemptId), splitObjective(detailObjective).objective);
      queueMicrotask(decorateHistory);
    }
    if (message.type === 'operationsSnapshot' && message.snapshot) captureActivity(message.snapshot.tasks, false);
    if (message.type === 'archivedTasksSnapshot') captureActivity(message.tasks, true);

    if (message.state) setVisualState(message.state);
    if (message.type === 'proposalApprovalRequest') setVisualState('waiting_for_proposal_approval');
    if (message.type === 'mutationApprovalRequest') setVisualState('waiting_for_mutation_approval');
    if (message.type === 'deliveryApprovalRequest') setVisualState('waiting_for_delivery_approval');
    if (String(message.state || '').toLowerCase() === 'completed') {
      setVisualState('completed');
      queueMicrotask(() => emitConfetti(message.taskId));
    }
    if (['blocked', 'failed'].includes(String(message.state || '').toLowerCase())) setVisualState(message.state);
  });

  document.addEventListener('kd:execution-state', event => {
    const run = event.detail;
    if (!run?.runId || run.active) return;
    setVisualState(run.phase === 'needs_input' ? 'blocked' : run.phase);
    if (run.phase === 'completed') queueMicrotask(() => emitConfetti(run.runId));
  });

  installStyles();
  ensureObjectiveControls();
  ensureTaskDetailObjective();
  installDemoModeToggle();
})();
