// Pandesh Panda Bridge — ChatGPT content script.
//
// What it reads: the text of the ChatGPT composer (or the part of it you selected) at the moment you click Send to Panda or,
// in Panda Mode, press Enter. Nothing else on the page is read unless you tick "Include chat context" and confirm the preview.
// What it never does: read other conversations, attachments, cookies, or credentials; send anything without a click/Enter from
// you; or intercept a submission while Panda Mode is off (no listener is even registered then).
(() => {
  if (window.__pandaBridgeLoaded) return;
  window.__pandaBridgeLoaded = true;

  const COMPOSER = ['#prompt-textarea', 'div.ProseMirror[contenteditable="true"]', 'textarea[name="prompt-textarea"]', 'form textarea'];
  const SEND_BUTTON = 'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label^="Send"]';
  const TERMINAL = new Set(['completed', 'cancelled']);
  const POLL_MS = 3000;

  const state = { paired: false, label: null, pandaMode: false, busy: false, tasks: new Map(), mine: new Set(), executors: [], pending: null };

  const send = (message) => new Promise((resolve) => {
    try { chrome.runtime.sendMessage(message, (r) => resolve(chrome.runtime.lastError ? { ok: false, message: chrome.runtime.lastError.message } : (r || { ok: false, message: 'no answer' }))); }
    catch (e) { resolve({ ok: false, message: String(e.message || e) }); }
  });

  // ---------------------------------------------------------------- page helpers
  const findComposer = () => { for (const s of COMPOSER) { const el = document.querySelector(s); if (el) return el; } return null; };
  const isComposerTarget = (t) => { const c = findComposer(); return Boolean(c && t instanceof Node && (c === t || c.contains(t))); };

  function readDraft() {
    const c = findComposer();
    if (!c) return '';
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && c.contains(sel.anchorNode) && c.contains(sel.focusNode)) return sel.toString();
    const raw = 'value' in c && typeof c.value === 'string' ? c.value : (c.innerText || '');
    return raw.replace(/\n$/, '');
  }

  function clearComposer(expected) {
    const c = findComposer();
    if (!c || readDraft() !== expected) return;
    c.focus();
    if ('value' in c && typeof c.value === 'string') { c.value = ''; c.dispatchEvent(new Event('input', { bubbles: true })); return; }
    document.execCommand('selectAll', false);
    document.execCommand('delete', false);
  }

  function gatherContext() {
    const nodes = [...document.querySelectorAll('[data-message-author-role]')];
    const lines = nodes.map((n) => `${n.getAttribute('data-message-author-role')}: ${(n.innerText || '').trim()}`).filter((l) => l.length > 6);
    let text = lines.join('\n\n');
    if (text.length > 60000) text = text.slice(text.length - 60000);
    return { text, messages: lines.length };
  }

  async function sha(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
  }

  // ---------------------------------------------------------------- UI (shadow DOM keeps page CSS out)
  const host = document.createElement('div');
  host.id = 'panda-bridge-root';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .bar { display:flex; flex-wrap:wrap; align-items:center; gap:10px; font:13px/1.3 system-ui,sans-serif; color:#1f2937; padding:6px 10px; margin:0 auto 6px; max-width:48rem;
             border:1px solid #d1d5db; border-radius:12px; background:#f9fafb; }
      @media (prefers-color-scheme: dark) { .bar { background:#1f2937; color:#e5e7eb; border-color:#374151; } .card { background:#111827; color:#e5e7eb; border-color:#374151; } }
      .bar.on { border-color:#d97706; background:#fffbeb; color:#78350f; }
      @media (prefers-color-scheme: dark) { .bar.on { background:#451a03; color:#fde68a; } }
      button { font:inherit; cursor:pointer; border:1px solid #9ca3af; background:transparent; color:inherit; border-radius:8px; padding:4px 10px; }
      button.primary { background:#2563eb; border-color:#2563eb; color:#fff; }
      button:disabled { opacity:.5; cursor:not-allowed; }
      .switch { display:inline-flex; align-items:center; gap:6px; }
      .pill { font-weight:600; padding:1px 8px; border-radius:999px; background:#e5e7eb; color:#374151; }
      .on .pill { background:#d97706; color:#fff; }
      .note { opacity:.8; }
      .cards { max-width:48rem; margin:0 auto 6px; display:flex; flex-direction:column; gap:6px; font:13px/1.35 system-ui,sans-serif; }
      .card { border:1px solid #d1d5db; border-radius:12px; padding:8px 10px; background:#fff; color:#1f2937; }
      .row { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
      .grow { flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .chip { font-size:12px; padding:1px 8px; border-radius:999px; background:#e5e7eb; color:#374151; }
      .chip.completed { background:#16a34a; color:#fff; } .chip.running,.chip.verifying,.chip.dispatching { background:#2563eb; color:#fff; }
      .chip.awaiting_approval,.chip.needs_attention,.chip.paused { background:#d97706; color:#fff; } .chip.failed,.chip.cancelled { background:#b91c1c; color:#fff; }
      .detail { margin-top:4px; opacity:.85; white-space:pre-wrap; word-break:break-word; }
      select { font:inherit; padding:3px 6px; border-radius:8px; }
      .modal { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:2147483647; }
      .dialog { background:#fff; color:#111827; border-radius:14px; padding:16px; width:min(560px,92vw); font:14px/1.4 system-ui,sans-serif; }
      .preview { max-height:200px; overflow:auto; background:#f3f4f6; border-radius:8px; padding:8px; font:12px/1.4 ui-monospace,monospace; white-space:pre-wrap; margin:8px 0; }
    </style>
    <div class="bar" id="bar">
      <button class="primary" id="send" title="Send the text in the box below to Pandesh instead of ChatGPT">🐼 Send to Panda</button>
      <label class="switch" title="When on, pressing Enter or the send arrow sends your prompt to Pandesh, not to ChatGPT"><input type="checkbox" id="mode"> Panda Mode <span class="pill" id="pill">OFF</span></label>
      <label class="switch" title="Off by default. You will see exactly what is shared before it is sent."><input type="checkbox" id="ctx"> Include chat context</label>
      <span class="note" id="note"></span>
    </div>
    <div class="cards" id="cards"></div>
    <div id="modal"></div>`;
  const $ = (id) => shadow.getElementById(id);

  function attach() {
    if (host.isConnected) return;
    const composer = findComposer();
    const form = composer && (composer.closest('form') || composer.parentElement);
    if (form && form.parentElement) form.parentElement.insertBefore(host, form);
  }

  function note(text, isError) { const n = $('note'); n.textContent = text || ''; n.style.color = isError ? '#b91c1c' : ''; }

  function render() {
    const on = state.paired && state.pandaMode;
    $('bar').classList.toggle('on', on);
    $('mode').checked = on;
    $('mode').disabled = !state.paired;
    $('pill').textContent = on ? 'ON' : 'OFF';
    $('send').disabled = state.busy || !state.paired;
    if (!state.paired) note('Not paired with Pandesh — open the extension popup to pair.', false);
    else if (on) note('Enter sends to Pandesh, not ChatGPT.', false);
    else if (!state.busy) note('', false);
    const c = findComposer();
    if (c) c.style.outline = on ? '2px solid #d97706' : '';
    syncInterceptors();
    renderCards();
  }

  function renderCards() {
    const cards = $('cards');
    cards.replaceChildren();
    // Work in progress always comes first; finished work follows. A burst of newer, cancelled tasks never hides a running one.
    const newestFirst = (a, b) => b.createdAt.localeCompare(a.createdAt);
    // Only this conversation's work, so a result never appears in a different ChatGPT conversation. A task sent from this
    // page stays visible even after ChatGPT moves a new chat from / to /c/<id>.
    const here = (location.pathname.match(/\/c\/([\w-]+)/) || [])[1] || null;
    const all = [...state.tasks.values()].filter((t) => state.mine.has(t.id) || ((t.sourceRef && t.sourceRef.conversationId) || null) === here);
    const live = all.filter((t) => !TERMINAL.has(t.status)).sort(newestFirst);
    const finished = all.filter((t) => TERMINAL.has(t.status)).sort(newestFirst);
    for (const t of [...live.slice(0, 5), ...finished.slice(0, 2)]) cards.append(card(t));
  }

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    for (const k of kids) if (k) e.append(k);
    return e;
  }

  function card(t) {
    const row = el('div', { className: 'row' },
      el('span', { className: 'chip ' + t.status, textContent: t.status.replace(/_/g, ' ') }),
      el('span', { className: 'grow', textContent: t.instruction.replace(/\s+/g, ' ').slice(0, 90), title: t.instruction.slice(0, 400) }));
    const box = el('div', { className: 'card' }, row);
    if (t.statusDetail) box.append(el('div', { className: 'detail', textContent: t.statusDetail }));
    const actions = el('div', { className: 'row' });
    actions.style.marginTop = '6px';

    if (t.status === 'awaiting_executor') {
      const sel = el('select');
      for (const e of state.executors) {
        const o = el('option', { value: e.id, textContent: e.label + (e.external ? ' — cloud (approve in Pandesh)' : ''), disabled: !e.available || !e.dispatchable || e.external });
        sel.append(o);
      }
      if (![...sel.options].some((o) => !o.disabled)) sel.append(el('option', { textContent: 'No local executor available', disabled: true }));
      const first = [...sel.options].find((o) => !o.disabled);
      if (first) sel.value = first.value;
      const start = el('button', { className: 'primary', textContent: 'Start', onclick: async () => {
        start.disabled = true;
        const r = await send({ op: 'dispatch', taskId: t.id, executor: sel.value });
        if (!r.ok) note(r.message || 'Could not start the task.', true); else upsert(r.data.task);
        start.disabled = false;
        renderCards();
      } });
      actions.append(sel, start);
    }
    if (['running', 'awaiting_approval', 'verifying', 'needs_attention'].includes(t.status) && t.executor && t.executor !== 'native') {
      actions.append(el('button', { textContent: 'Pause', onclick: () => control('pause', t.id) }));
    }
    if (t.status === 'paused') actions.append(el('button', { textContent: 'Resume', onclick: () => control('resume', t.id) }));
    if (!TERMINAL.has(t.status)) actions.append(el('button', { textContent: 'Cancel', onclick: () => control('cancel', t.id) }));
    if (t.status === 'completed' && t.result) {
      const v = t.result.verification ? `Verified (${t.result.verification}).` : 'Finished.';
      const files = t.result.changedFiles && t.result.changedFiles.length ? ` Files: ${t.result.changedFiles.slice(0, 6).join(', ')}.` : '';
      box.append(el('div', { className: 'detail', textContent: v + files }));
    }
    if (t.conversationId) actions.append(el('button', { textContent: 'Open in Pandesh', onclick: async () => {
      const r = await send({ op: 'open', conversationId: t.conversationId });
      if (!r.ok) note(r.message || 'Could not open Pandesh.', true);
    } }));
    if (actions.childElementCount) box.append(actions);
    return box;
  }

  async function control(op, taskId) {
    const r = await send({ op, taskId });
    if (!r.ok) note(r.message || `Could not ${op} the task.`, true); else upsert(r.data);
    renderCards();
  }

  function upsert(task) { if (task && task.id) state.tasks.set(task.id, task); }

  // ---------------------------------------------------------------- interception: registered only while Panda Mode is on
  function onKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !isComposerTarget(e.target)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    void sendDraft('panda_mode');
  }
  function onClick(e) {
    const btn = e.target && e.target.closest && e.target.closest(SEND_BUTTON);
    if (!btn || host.contains(btn)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    void sendDraft('panda_mode');
  }
  function onSubmit(e) {
    const c = findComposer();
    if (!c || !(e.target instanceof Node) || !e.target.contains(c)) return; // only the prompt form, never another form on the page
    e.preventDefault(); e.stopImmediatePropagation();
  }
  let intercepting = false;
  function syncInterceptors() {
    const want = state.paired && state.pandaMode;
    if (want === intercepting) return;
    intercepting = want;
    const op = want ? 'addEventListener' : 'removeEventListener';
    window[op]('keydown', onKeydown, true);
    window[op]('click', onClick, true);
    window[op]('submit', onSubmit, true);
  }

  // ---------------------------------------------------------------- sending
  function confirmContext(ctx) {
    return new Promise((resolve) => {
      const modal = $('modal');
      const done = (v) => { modal.replaceChildren(); resolve(v); };
      const dialog = el('div', { className: 'dialog' },
        el('strong', { textContent: 'Share this conversation with Pandesh?' }),
        el('div', { textContent: `${ctx.messages} message(s), ${ctx.text.length.toLocaleString()} characters. It stays on this PC; Pandesh only passes it to a cloud executor if you approve that in Pandesh.` }),
        el('div', { className: 'preview', textContent: ctx.text.slice(0, 1500) + (ctx.text.length > 1500 ? '\n…' : '') }));
      const row = el('div', { className: 'row' },
        el('button', { className: 'primary', textContent: 'Share it', onclick: () => done('share') }),
        el('button', { textContent: 'Send without context', onclick: () => done('without') }),
        el('button', { textContent: 'Cancel', onclick: () => done('cancel') }));
      dialog.append(row);
      modal.append(el('div', { className: 'modal' }, dialog));
    });
  }

  async function sendDraft(via) {
    // The prompt stays in the box; say so rather than dropping the keypress silently.
    if (state.busy) { note('Still sending the previous prompt — press Enter again in a moment.', true); return; }
    if (!state.paired) { note('Not paired with Pandesh — open the extension popup to pair.', true); return; }
    const text = readDraft();
    if (!text.trim()) { note('Nothing to send: type or select a prompt first.', true); return; }
    state.busy = true; render(); note('Sending to Pandesh…');
    try {
      let context;
      if ($('ctx').checked) {
        const ctx = gatherContext();
        if (ctx.messages === 0) note('No chat messages found to share; sending the prompt only.');
        else {
          const choice = await confirmContext(ctx);
          if (choice === 'cancel') { note('Cancelled. Nothing was sent.'); return; }
          if (choice === 'share') context = { text: ctx.text, userConfirmed: true };
        }
      }
      // A retry of the same text reuses its request id, so Pandesh receives it exactly once even if a reply was lost.
      const digest = await sha(text + (context ? '\u0000ctx' : ''));
      if (!state.pending || state.pending.digest !== digest || Date.now() - state.pending.at > 120000) state.pending = { digest, id: 'click-' + crypto.randomUUID(), at: Date.now() };
      const r = await send({
        op: 'submit', clientRequestId: state.pending.id, instruction: text, context,
        sourceRef: { url: location.href, conversationId: (location.pathname.match(/\/c\/([\w-]+)/) || [])[1], title: document.title, capturedAt: new Date().toISOString(), via },
      });
      if (!r.ok) { note(r.message || 'Pandesh did not accept the task. Your prompt is still in the box.', true); return; }
      state.pending = null;
      upsert(r.data.task);
      state.mine.add(r.data.task.id);
      clearComposer(text);
      note(r.data.duplicate ? 'Pandesh already had this request.' : 'Sent to Pandesh.');
      void refreshExecutors();
      schedulePoll();
    } finally {
      state.busy = false; render();
    }
  }

  // ---------------------------------------------------------------- polling: the same tasks Pandesh shows
  let timer = null;
  function schedulePoll() { if (timer) return; timer = setInterval(poll, POLL_MS); }
  async function poll() {
    if (document.hidden) return;
    const live = [...state.tasks.values()].filter((t) => !TERMINAL.has(t.status));
    if (!live.length) { clearInterval(timer); timer = null; return; }
    for (const t of live) {
      const r = await send({ op: 'task', taskId: t.id });
      if (r.ok) upsert(r.data);
      else if (r.code === 'pairing_revoked') { await loadState(); return; }
    }
    renderCards();
  }

  async function refreshExecutors() {
    const r = await send({ op: 'executors' });
    if (r.ok) state.executors = r.data.executors;
    renderCards();
  }

  async function loadTasks() {
    const r = await send({ op: 'tasks' });
    if (!r.ok) return;
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const t of r.data.tasks) if (!TERMINAL.has(t.status) || (t.status === 'completed' && Date.parse(t.updatedAt) > dayAgo)) upsert(t);
    if ([...state.tasks.values()].some((t) => !TERMINAL.has(t.status))) schedulePoll();
    void refreshExecutors();
  }

  async function loadState() {
    const r = await send({ op: 'state' });
    if (r.ok) { state.paired = r.data.paired; state.label = r.data.label; state.pandaMode = r.data.pandaMode; }
    if (!state.paired) state.tasks.clear();
    render();
  }

  $('send').addEventListener('click', (e) => { e.stopPropagation(); void sendDraft('send_button'); });
  $('mode').addEventListener('change', async (e) => {
    const r = await send({ op: 'setPandaMode', enabled: e.target.checked });
    state.pandaMode = r.ok ? r.data.pandaMode : false;
    render();
  });

  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.pandaBridge) { void loadState().then(() => { if (state.paired) void loadTasks(); }); } });
  new MutationObserver(() => { if (!host.isConnected) attach(); }).observe(document.documentElement, { childList: true, subtree: true });

  attach();
  void loadState().then(() => { if (state.paired) void loadTasks(); });
})();
