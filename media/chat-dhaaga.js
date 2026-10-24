(function () {
  'use strict';

  // Kaam ka Dhaaga renderer. Presentation only.
  //
  // The host owns the one authoritative projection (src/ui/executionProjection.ts) of real runtime events into
  // `UIExecutionState`. This script renders it and republishes the CURRENT state to every other primary surface
  // (Operator Context, status line) through `window.__kdExecutionState` and the `kd:execution-state` event, so none of
  // them derives its own competing idea of what is happening. Nodes are updated in place by stable id; streamed
  // tokens never reach this script, so nothing here re-renders per token.
  const messages = document.getElementById('messages');
  if (!messages) return;

  const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  const pandaBase = typeof window.__pandaBaseUri === 'string' ? window.__pandaBaseUri.replace(/\/+$/, '') : '';
  const reducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const MODE_TO_SELECTOR = { baat_kar: 'chat', saath_kar: 'agent', karke_dikha: 'autonomous' };
  const runs = new Map();
  let latestRunId = '';
  let liveTimer = null;

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function post(message) {
    if (vscodeApi) vscodeApi.postMessage(message);
  }

  function nearBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 96;
  }

  function followIfPinned(wasPinned) {
    if (wasPinned) messages.scrollTop = messages.scrollHeight;
  }

  function pendingTarget() {
    return messages.querySelector('.mode-change-card:not(.resolved)')
      || messages.querySelector('.approval-card:has(button[data-approval-response]:not(:disabled))')
      || messages.querySelector('.capability-approval-card:not(.resolved)')
      || document.querySelector('#proposal-approval-card:not([hidden]), #mutation-approval-card:not([hidden]), #delivery-approval-card:not([hidden])');
  }

  // The thread shows WHERE execution stopped; the pinned card provides the ACTION. This only points at that same
  // card — it holds no approval state of its own.
  function focusPending() {
    const target = pendingTarget();
    if (!target) return;
    target.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
    target.classList.add('kd-pending-focus');
    window.setTimeout(() => target.classList.remove('kd-pending-focus'), 1600);
    const button = target.querySelector('button:not(:disabled)');
    if (button) button.focus({ preventScroll: true });
  }

  function createRun(state) {
    const section = el('section', 'kd-dhaaga');
    section.dataset.runId = state.runId;
    section.setAttribute('aria-label', 'Kaam ka Dhaaga');

    const head = el('header', 'kd-dhaaga-head');
    const panda = el('img', 'kd-dhaaga-panda');
    panda.alt = '';
    panda.setAttribute('aria-hidden', 'true');
    const eyebrow = el('span', 'kd-dhaaga-eyebrow', 'KAAM KA DHAAGA');
    const mode = el('span', 'kd-dhaaga-mode');
    head.append(panda, eyebrow, mode);

    const list = el('ol', 'kd-dhaaga-thread');
    const root = el('li', 'kd-dhaaga-item kd-dhaaga-root');
    root.dataset.status = 'done';
    root.append(el('span', 'kd-dhaaga-dot'));
    const rootBody = el('div', 'kd-dhaaga-body');
    rootBody.append(el('div', 'kd-dhaaga-root-label', 'You asked'), el('div', 'kd-dhaaga-root-text'));
    root.appendChild(rootBody);
    list.appendChild(root);

    const live = el('div', 'kd-dhaaga-live');
    live.hidden = true;
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');

    section.append(head, list, live);
    messages.appendChild(section);
    const run = { section, panda, mode, list, root, live, nodes: new Map(), revision: -1, state: null };
    runs.set(state.runId, run);
    return run;
  }

  // A detail is rendered only when it says something: empty strings and bare dash / dot placeholders never become rows.
  function isMeaningful(text) {
    return typeof text === 'string' && /[\p{L}\p{N}]/u.test(text);
  }

  function setFacts(ul, facts) {
    ul.textContent = '';
    for (const fact of facts) if (isMeaningful(fact)) ul.appendChild(el('li', '', fact));
    ul.hidden = ul.children.length === 0;
  }

  function buildNode() {
    const li = el('li', 'kd-dhaaga-item');
    li.append(el('span', 'kd-dhaaga-dot'));
    const body = el('div', 'kd-dhaaga-body');
    body.append(
      el('div', 'kd-dhaaga-title'),
      el('div', 'kd-dhaaga-sub'),
      el('ul', 'kd-dhaaga-facts'),
      el('ul', 'kd-dhaaga-branches'),
    );
    li.appendChild(body);
    return li;
  }

  function applyNode(run, node) {
    let li = run.nodes.get(node.id);
    if (!li) {
      li = buildNode();
      li.dataset.nodeId = node.id;
      run.nodes.set(node.id, li);
      run.list.appendChild(li);
    }
    const signature = JSON.stringify([node.status, node.title, node.subtitle, node.facts, node.branches, node.details.length, node.stage]);
    if (li._signature === signature) return;
    li._signature = signature;
    li.dataset.status = node.status;
    li.dataset.stage = node.stage;
    const body = li.querySelector('.kd-dhaaga-body');
    body.querySelector('.kd-dhaaga-title').textContent = node.title;
    // "Soch raha hoon..." already says it; a redundant "Planning" or a placeholder subtitle is not shown.
    const sub = body.querySelector('.kd-dhaaga-sub');
    const showSub = isMeaningful(node.subtitle) && node.stage !== 'planning';
    sub.textContent = showSub ? node.subtitle : '';
    sub.hidden = !showSub;
    setFacts(body.querySelector('.kd-dhaaga-facts'), node.facts);

    const branches = body.querySelector('.kd-dhaaga-branches');
    branches.hidden = node.branches.length === 0;
    branches.textContent = '';
    for (const branch of node.branches) {
      const item = el('li', 'kd-dhaaga-branch');
      item.dataset.status = branch.status;
      item.append(el('span', 'kd-dhaaga-branch-label', branch.label), el('span', 'kd-dhaaga-branch-state'));
      branches.appendChild(item);
    }

    // The action reference lives in the thread (where execution stopped); the actionable card is pinned above the composer.
    let action = body.querySelector('.kd-dhaaga-action');
    const needsAction = node.status === 'waiting' && (node.stage === 'waiting_approval' || node.stage === 'change_required');
    if (needsAction && !action) {
      action = el('div', 'kd-dhaaga-action');
      action.append(el('span', 'kd-dhaaga-action-text'), el('button', '', ''));
      action.querySelector('button').type = 'button';
      action.querySelector('button').addEventListener('click', focusPending);
      body.insertBefore(action, body.querySelector('.kd-dhaaga-facts').nextSibling);
    }
    if (action) {
      action.hidden = !needsAction;
      action.querySelector('.kd-dhaaga-action-text').textContent = node.stage === 'change_required' ? 'Your decision needed' : 'Review required';
      action.querySelector('button').textContent = node.stage === 'change_required' ? 'Decide' : 'Review';
    }

    // Raw commands and payloads belong behind a disclosure, never in the primary line.
    let details = body.querySelector('.kd-dhaaga-details');
    if (node.details.length > 0) {
      if (!details) {
        details = el('details', 'kd-dhaaga-details');
        details.append(el('summary', '', 'Show details'), el('pre'));
        body.appendChild(details);
      }
      details.querySelector('pre').textContent = node.details.join('\n');
    } else if (details) {
      details.remove();
    }
  }

  // Plain Baat Kar (no repository retrieval, no tools, no approval, no steps) has nothing to explain: it gets the small
  // "Soch raha hoon…" indicator, not a card. The card appears the moment real execution shows up, and always in Saath/Karke.
  const TRIVIAL_STAGES = new Set(['planning', 'completed', 'cancelled']);
  function hasMeaningfulExecution(run) {
    if (!run.state || run.state.mode !== 'baat_kar') return true;
    for (const li of run.nodes.values()) if (!TRIVIAL_STAGES.has(li.dataset.stage)) return true;
    return false;
  }

  function applyHeader(run, state) {
    run.state = state;
    run.visible = hasMeaningfulExecution(run);
    run.section.hidden = !run.visible;
    run.section.dataset.mode = state.mode;
    run.section.dataset.phase = state.phase;
    run.section.dataset.active = String(Boolean(state.active));
    run.mode.textContent = state.modeLabel;
    const rootText = run.root.querySelector('.kd-dhaaga-root-text');
    if (rootText.textContent !== state.request) rootText.textContent = state.request;
    if (pandaBase && state.pandaAsset) {
      const src = pandaBase + '/' + state.pandaAsset;
      if (run.panda.getAttribute('src') !== src) run.panda.src = src;
    }
    run.liveText = state.live || '';
    run.liveSince = state.liveSince || null;
    renderLive(run);
    for (const [id, li] of run.nodes) li.classList.toggle('is-current', id === state.currentNodeId);
    run.revision = state.revision;
  }

  function renderLive(run) {
    if (!run.visible || !isMeaningful(run.liveText) || !run.state || !run.state.active) {
      run.live.hidden = true;
      return;
    }
    const seconds = run.liveSince ? Math.max(0, Math.round((Date.now() - run.liveSince) / 1000)) : 0;
    run.live.hidden = false;
    run.live.textContent = '🐼 ' + run.liveText + (seconds >= 5 ? ' · ' + seconds + 's' : '');
  }

  // A single 1s tick updates only the live row's text. It never touches nodes and never posts anything.
  function ensureLiveTimer() {
    const anyLive = [...runs.values()].some(run => run.visible && run.state && run.state.active && run.liveText);
    if (anyLive && !liveTimer) {
      liveTimer = window.setInterval(() => {
        for (const run of runs.values()) renderLive(run);
      }, 1000);
    } else if (!anyLive && liveTimer) {
      window.clearInterval(liveTimer);
      liveTimer = null;
    }
  }

  // The one place current state is published. Operator Context, the status line and the composer cue read this.
  function publish(state, visible) {
    latestRunId = state.runId;
    window.__kdExecutionState = Object.freeze({
      runId: state.runId,
      active: Boolean(state.active),
      mode: state.mode,
      modeSelector: MODE_TO_SELECTOR[state.mode] || '',
      modeLabel: state.modeLabel,
      phase: state.phase,
      statusText: state.statusText,
      currentNodeId: state.currentNodeId,
    });
    // The legacy thinking indicator stays visible until a card is actually shown for this run.
    document.body.classList.toggle('kd-dhaaga-active', Boolean(state.active) && visible !== false);
    document.dispatchEvent(new CustomEvent('kd:execution-state', { detail: window.__kdExecutionState }));
  }

  // Runs that belonged to a conversation New Chat has replaced; late snapshots/patches for them are ignored.
  const detachedRuns = new Set();

  function applySnapshot(state) {
    if (detachedRuns.has(state.runId)) return;
    const pinned = nearBottom();
    let run = runs.get(state.runId);
    if (run && state.revision < run.revision) return;
    if (run && !run.section.isConnected) {
      runs.delete(state.runId);
      run = null;
    }
    if (!run) run = createRun(state);
    const seen = new Set();
    for (const node of state.nodes) {
      applyNode(run, node);
      seen.add(node.id);
    }
    for (const [id, li] of run.nodes) {
      if (!seen.has(id)) {
        li.remove();
        run.nodes.delete(id);
      }
    }
    applyHeader(run, state);
    ensureLiveTimer();
    publish(state, run.visible);
    followIfPinned(pinned);
  }

  function applyPatch(message) {
    if (detachedRuns.has(message.runId)) return;
    const run = runs.get(message.runId);
    if (!run || !run.section.isConnected) {
      post({ type: 'dhaagaResync', runId: message.runId });
      return;
    }
    const patch = message.patch;
    if (patch.state.revision > run.revision + 1) {
      post({ type: 'dhaagaResync', runId: message.runId });
      return;
    }
    if (patch.state.revision <= run.revision) return;
    const pinned = nearBottom();
    for (const node of patch.upserts) applyNode(run, node);
    applyHeader(run, patch.state);
    ensureLiveTimer();
    publish(patch.state, run.visible);
    followIfPinned(pinned);
  }

  // The host posts a terminal patch before the turn's final `done` / `error` / `stopped` message. If a webview missed
  // that patch (it was recreated mid-run, or a resync is still in flight), the header must still never keep saying
  // "Working" once the turn has ended: settle the still-active run locally; the next authoritative snapshot replaces it.
  const SETTLED = {
    error: { phase: 'failed', statusText: 'Stopped before finishing' },
    stopped: { phase: 'cancelled', statusText: 'Cancelled' },
  };

  function settleActiveRun(kind) {
    const run = runs.get(latestRunId);
    if (!run || !run.state || !run.state.active) return;
    if (kind === 'done') {
      // Transport completion cannot settle the objective. Recover the host's terminal projection.
      post({ type: 'dhaagaResync', runId: latestRunId });
      return;
    }
    const settled = SETTLED[kind];
    const state = Object.assign({}, run.state, { phase: settled.phase, statusText: settled.statusText, active: false, live: '', liveSince: null });
    applyHeader(run, state);
    ensureLiveTimer();
    publish(state, run.visible);
  }

  function reset() {
    // Another script turns New Chat into a local 'clear' before this listener sees the reset, so detaching happens here.
    for (const [id, run] of runs) { detachedRuns.add(id); run.section.remove(); }
    runs.clear();
    latestRunId = '';
    window.__kdExecutionState = Object.freeze({ runId: '', active: false, mode: '', modeSelector: '', modeLabel: '', phase: 'idle', statusText: '', currentNodeId: null });
    document.body.classList.remove('kd-dhaaga-active');
    document.dispatchEvent(new CustomEvent('kd:execution-state', { detail: window.__kdExecutionState }));
    ensureLiveTimer();
  }

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || typeof message !== 'object') return;
    if (message.type === 'dhaaga') {
      if (message.op === 'snapshot' && message.state) applySnapshot(message.state);
      else if (message.op === 'patch' && message.patch) applyPatch(message);
    } else if (message.type === 'done' || message.type === 'error' || message.type === 'stopped') {
      settleActiveRun(message.type);
    } else if (message.type === 'clear') {
      reset();
    } else if (message.type === 'newConversation' && message.reset === true) {
      reset();
    } else if (message.type === 'modeChangeRequired') {
      // The pinned card (chat.js) is the action; nothing to render here.
    }
  });

  window.__kdDhaaga = Object.freeze({ focusPending, latestRunId: () => latestRunId });
  reset();
})();
