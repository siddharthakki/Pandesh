(function () {
  'use strict';

  // Operator context strip (M50): the persistent answer to "where am I, in which mode, on which model, under
  // which governance, doing what". Presentation only. Every value is real: workspace/provider/thinking come
  // from the host's `operatorContext` message, the routed model and its reasons from the `modelSuitability`
  // evidence the host already posts, the mode from the mode selector, the status from the sidebar's readiness.
  // Mode and governance are separate concepts: switching mode never touches the governance badge, and the
  // badge is not a mode control.
  const root = document.getElementById('operator-context');
  if (!root) return;

  const byId = id => document.getElementById(id);
  const fields = {
    workspace: byId('oc-workspace'),
    mode: byId('oc-mode'),
    supervision: byId('oc-supervision'),
    model: byId('oc-model'),
    thinking: byId('oc-thinking'),
    provider: byId('oc-provider'),
    status: byId('oc-status'),
  };
  const whyButton = byId('oc-why-btn');
  const whyPopover = byId('oc-why-popover');
  const whyBody = byId('oc-why-body');
  const modeSelect = byId('mode-select');
  const modelSelect = byId('model-select');
  const supervisionSelect = byId('autonomy-mode-select');

  const MODE_LABELS = { chat: 'Baat Kar', agent: 'Saath Kar', autonomous: 'Karke Dikha' };
  // Read-only/plan sub-modes the Auto classifier can announce are still Saath Kar to the operator.
  const EFFECTIVE_MODE = { chat: 'chat', agent: 'agent', ask: 'agent', plan: 'agent', autonomous: 'autonomous' };
  const RULE_PHRASES = {
    task_fit: 'a better fit for the task',
    qualification: 'stronger benchmark evidence',
    tool_protocol: 'a stronger tool protocol',
    residency: 'already loaded in memory',
    latency: 'faster on benchmark runs',
    configured_default: 'your configured default',
    parameter_size: 'lighter to run',
    identity: 'tie, broken by name order',
  };

  const state = {
    workspace: null,
    mode: modeSelect ? modeSelect.value : 'auto',
    // When mode selection is automatic: the Baat/Saath/Karke mode the request actually resolved to ('' = none yet).
    effectiveMode: '',
    // 'manual' = the user named a model; 'auto' = the router chooses per task.
    modelKind: 'auto',
    manualModel: '',
    manualProvider: '',
    routedModel: '',
    routedProvider: '',
    routing: null,
    thinking: 'Default',
    provider: '—',
    status: 'Ready',
    statusState: 'ready',
    // Latest authoritative Kaam ka Dhaaga projection (chat-dhaaga.js), or null.
    run: null,
    // The run id that belonged to the PREVIOUS turn. A new turn has not produced its own projection yet, so the
    // previous turn's effective mode must not be shown as if it were the current one.
    staleRunId: '',
    // The ACTIVE task's own frozen supervision policy ('' = no active task). The composer selector only decides the
    // NEXT task, and it resets to Ask me after every submit, so it must never stand in for the running task's policy.
    taskSupervision: '',
  };
  const TASK_TERMINAL_STATES = new Set(['completed', 'failed', 'cancelled', 'blocked']);
  const supervisionName = mode => (mode === 'hands_off' ? 'Hands-off' : 'Ask me');
  function supervisionLabel() {
    const selected = supervisionName(supervisionSelect && supervisionSelect.value);
    if (!state.taskSupervision) return selected;
    const frozen = supervisionName(state.taskSupervision);
    return frozen === selected ? frozen : frozen + ' (running task) · next task: ' + selected;
  }

  // Cloud picker values look like "<provider>::<exact model id>"; the exact id is what is shown and what is sent.
  const CLOUD_KEY = /^([a-z0-9][a-z0-9-]{1,40})::/;
  const PROVIDER_NAMES = { orcarouter: 'OrcaRouter', openrouter: 'OpenRouter', groq: 'Groq', gemini: 'Gemini', 'ollama-cloud': 'Ollama Cloud' };
  function cloudProviderId(value) {
    const match = CLOUD_KEY.exec(value || '');
    return match ? match[1] : '';
  }
  function cloudProviderLabel() {
    if (state.modelKind !== 'manual') return '';
    const id = cloudProviderId(state.manualModel) || (state.manualProvider !== 'ollama' && state.manualProvider !== 'local' ? state.manualProvider : '');
    if (!id) return '';
    const option = modelSelect && Array.from(modelSelect.options).filter(o => o.value === state.manualModel)[0];
    return ((option && option.dataset && option.dataset.provider) || PROVIDER_NAMES[id] || id) + ' / Cloud';
  }
  function modelLabel() {
    if (state.modelKind === 'manual' && state.manualModel) {
      return cloudProviderId(state.manualModel) ? state.manualModel.replace(CLOUD_KEY, '') : state.manualModel;
    }
    if (state.routedModel) {
      return state.routedProvider === 'host' ? 'Auto → no model needed' : 'Auto → ' + state.routedModel;
    }
    return 'Auto';
  }

  // Mode policy (Auto | Manual) is separate from the effective mode of the current turn (Baat/Saath/Karke).
  // The host's execution projection is the ONLY authority for the effective turn mode; Dhaaga renders the same
  // value. The mode bar and composer chip are policy / next-turn selection and never relabel the current turn.
  function currentRun() {
    return state.run && state.run.runId && state.run.modeSelector && state.run.runId !== state.staleRunId ? state.run : null;
  }
  function modeLabel() {
    const run = currentRun();
    const effective = run ? (MODE_LABELS[run.modeSelector] || run.modeLabel) : '';
    if (state.mode !== 'auto') return effective && effective !== MODE_LABELS[state.mode] ? effective : (MODE_LABELS[state.mode] || state.mode);
    if (effective) return 'Auto → ' + effective;
    return state.effectiveMode ? 'Auto → ' + MODE_LABELS[state.effectiveMode] : 'Auto → chosen per message';
  }
  function beginTurn() {
    state.staleRunId = state.run && state.run.runId ? state.run.runId : state.staleRunId;
  }

  function render() {
    if (fields.workspace) {
      const workspace = state.workspace;
      fields.workspace.textContent = workspace ? workspace.name : 'No workspace';
      const full = workspace ? workspace.path : 'No workspace folder is open';
      fields.workspace.title = full;
      fields.workspace.setAttribute('aria-label', 'Workspace ' + (workspace ? workspace.name + ', ' + workspace.path : 'none open'));
    }
    if (fields.mode) fields.mode.textContent = modeLabel();
    // Supervision is a status here; the composer owns the decision. It is separate from mode and from governance.
    if (fields.supervision) fields.supervision.textContent = supervisionLabel();
    if (fields.model) {
      const label = modelLabel();
      fields.model.textContent = label;
      fields.model.title = state.modelKind === 'manual' ? 'Selected by you' : label;
    }
    if (fields.thinking) fields.thinking.textContent = state.thinking;
    if (fields.provider) fields.provider.textContent = cloudProviderLabel() || state.provider;
    if (fields.status) {
      fields.status.textContent = state.status;
      fields.status.dataset.state = state.statusState;
    }
    if (whyButton) whyButton.hidden = !state.routing;
    if (whyPopover && !whyPopover.hidden) renderWhy();
  }

  function line(parent, text, className) {
    const div = document.createElement('div');
    if (className) div.className = className;
    div.textContent = text;
    parent.appendChild(div);
  }

  // Concise reasons first; per-candidate detail only here, never in the strip itself.
  function renderWhy() {
    if (!whyBody) return;
    whyBody.textContent = '';
    const routing = state.routing;
    line(whyBody, modelLabel(), 'oc-why-title');
    if (routing && Array.isArray(routing.why) && routing.why.length) {
      line(whyBody, routing.selectionMode === 'auto' ? 'Why' : 'Basis', 'oc-why-heading');
      routing.why.forEach(reason => line(whyBody, '• ' + reason));
    }
    const alternatives = routing && Array.isArray(routing.alternatives) ? routing.alternatives.slice(1) : [];
    if (alternatives.length) {
      line(whyBody, 'Other compatible models', 'oc-why-heading');
      alternatives.forEach(item => {
        const phrase = item.behindBecauseOf ? ' — ' + (RULE_PHRASES[item.behindBecauseOf] || item.behindBecauseOf) + ' ranked higher' : '';
        line(whyBody, '• ' + item.model + phrase);
      });
    }
    line(whyBody, 'Workspace', 'oc-why-heading');
    line(whyBody, state.workspace ? state.workspace.path : 'No workspace folder is open', 'oc-why-path');
    if (routing && routing.policyVersion) line(whyBody, 'Routing policy ' + routing.policyVersion, 'oc-why-footnote');
  }

  function setWhy(open) {
    if (!whyPopover || !whyButton) return;
    whyPopover.hidden = !open;
    whyButton.setAttribute('aria-expanded', String(open));
    if (open) renderWhy();
  }

  whyButton?.addEventListener('click', event => {
    event.stopPropagation();
    setWhy(Boolean(whyPopover?.hidden));
  });
  document.addEventListener('click', event => {
    if (whyPopover && !whyPopover.hidden && !whyPopover.contains(event.target) && event.target !== whyButton) setWhy(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setWhy(false);
  });

  modeSelect?.addEventListener('change', () => {
    state.mode = modeSelect.value;
    state.effectiveMode = '';
    beginTurn();
    render();
  });
  modelSelect?.addEventListener('change', () => {
    // The dropdown is the user's explicit choice for the next turn; Automatic hands the choice back to the router.
    state.modelKind = modelSelect.value ? 'manual' : 'auto';
    state.manualModel = modelSelect.value || '';
    state.manualProvider = cloudProviderId(state.manualModel);
    render();
  });
  supervisionSelect?.addEventListener('change', render);
  document.addEventListener('kd:status-changed', event => {
    // A run projection owns status; the legacy flags this event carries must not overwrite it.
    if (state.run && state.run.runId !== state.staleRunId) return;
    const detail = event.detail || {};
    state.status = String(detail.ready || 'Ready');
    state.statusState = detail.blocked ? 'blocked' : detail.pendingApproval ? 'waiting' : detail.running ? 'working' : 'ready';
    render();
  });
  // The projection is authoritative for the current run: mode, status and waiting/working all come from it.
  document.addEventListener('kd:execution-state', event => {
    const run = event.detail || null;
    state.run = run && run.runId ? run : null;
    if (state.run && state.run.active) {
      state.status = state.run.statusText || state.status;
      state.statusState = state.run.phase === 'waiting_approval' || state.run.phase === 'needs_mode_change' ? 'waiting' : 'working';
    } else if (state.run) {
      const phase = state.run.phase;
      state.status = phase === 'completed' ? 'Completed' : phase === 'cancelled' ? 'Stopped' : phase === 'failed' || phase === 'blocked' ? 'Needs attention' : phase === 'needs_input' ? 'Needs your input' : state.status;
      state.statusState = phase === 'failed' || phase === 'blocked' ? 'blocked' : phase === 'needs_input' ? 'waiting' : 'ready';
    }
    render();
  });

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'operatorContext') {
      state.workspace = message.workspace && message.workspace.path ? { name: String(message.workspace.name || message.workspace.path), path: String(message.workspace.path) } : null;
      if (typeof message.provider === 'string' && message.provider) state.provider = message.provider;
      if (typeof message.thinking === 'string' && message.thinking) state.thinking = message.thinking;
      render();
    } else if (message.type === 'modeExecutionStarted') {
      // Announced by the Auto classifier (chat-runtime-fixes.js) for the mode the request resolved to.
      // Provisional only: the classifier's read-only 'ask'/'plan' guesses may run as Baat Kar on the host, so they
      // are not shown; the projection's mode replaces this as soon as the run starts.
      beginTurn();
      state.effectiveMode = state.mode === 'auto' && (message.mode === 'chat' || message.mode === 'agent' || message.mode === 'autonomous') ? message.mode : '';
      render();
    } else if (message.type === 'autonomousTaskStatus' && message.autonomyMode) {
      state.taskSupervision = TASK_TERMINAL_STATES.has(String(message.state || '')) ? '' : String(message.autonomyMode);
      render();
    } else if (message.type === 'autonomousTaskStarted') {
      beginTurn();
      state.taskSupervision = message.autonomyMode ? String(message.autonomyMode) : '';
      render();
      if (state.mode === 'auto') {
        state.effectiveMode = 'autonomous';
        render();
      }
    } else if (message.type === 'modelSuitability' && message.details) {
      const details = message.details;
      state.routing = details.routing || null;
      if (details.userOverrode) {
        state.modelKind = 'manual';
        state.manualModel = String(details.selectedModel || '');
        state.manualProvider = String(details.selectedProvider || '');
      } else {
        state.modelKind = 'auto';
        state.manualModel = '';
        state.manualProvider = '';
        state.routedModel = String(details.selectedModel || '');
        state.routedProvider = String(details.selectedProvider || '');
      }
      render();
    } else if (message.type === 'newConversation' || message.type === 'clear') {
      // A fresh conversation has no routed model yet; a manual choice in the dropdown still stands.
      state.routedModel = '';
      state.routedProvider = '';
      state.routing = null;
      state.effectiveMode = '';
      state.taskSupervision = '';
      beginTurn();
      render();
    }
  });

  render();
})();
