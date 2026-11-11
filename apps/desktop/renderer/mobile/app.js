/*
 * Pandesh Mobile: the phone app. Plain JavaScript, no build step, no third-party code, served by the Pandesh desktop
 * host. Talks only to the server it came from. Nothing about the conversation is stored on the phone: the service
 * worker caches the app's own files, and localStorage keeps one preference (read replies aloud).
 */
(function () {
  'use strict';

  var L = window.PandeshMobileLib;
  var $ = function (id) { return document.getElementById(id); };

  /** Element builder: text always goes in as text nodes, never as HTML. */
  function h(tag, props) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v == null || v === false) return;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : String(v));
      });
    }
    for (var i = 2; i < arguments.length; i += 1) {
      var kid = arguments[i];
      if (kid == null || kid === false) continue;
      if (Array.isArray(kid)) kid.forEach(function (k) { if (k != null && k !== false) e.append(k); });
      else e.append(kid);
    }
    return e;
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var ICONS = {
    speaker: ['M11 5L6 9H3v6h3l5 4V5z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'],
    stop: ['M7 7h10v10H7z'],
  };
  function icon(name) {
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    (ICONS[name] || []).forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  // ------------------------------------------------------------------------------------------------------------
  // State

  var STALE_MS = 45000; // the PC sends a ping every 15 s; silence this long means the connection is gone
  var BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
  var ROUTED = {
    stopped: 'Stop requested.',
    queued: 'Queued behind the running task. It starts when that one finishes.',
    duplicate: 'Already running or queued, so it was not started twice.',
    steered: 'Added to the running task.',
    side_question: 'Answering alongside the running task.',
    corrected_queued: 'Corrected: your queued request now says this.',
    corrected_restarted: 'Corrected: it restarted with your correction.',
    corrected_steered: 'Corrected: the running task has your correction.',
  };

  var S = {
    phase: 'boot', // boot | pairing | connecting | live | reconnecting | offline
    everLive: false,
    device: null,
    secure: location.protocol === 'https:',
    st: null,
    conversationId: null,
    messages: [],
    outbox: [],
    streams: new Map(),
    lateAttempts: new Set(),
    voiceAttempts: new Set(),
    tab: 'chat',
    lastEventAt: 0,
    retry: 0,
    nextRetryAt: 0,
    justConnected: false,
    runningSince: 0,
    deciding: false,
    speaking: false,
    reviewTurn: null,
    readAloud: prefGet('readAloud', 'voice'),
    tasksNeedYou: 0,
  };

  function prefGet(key, fallback) {
    try { var v = localStorage.getItem('pandesh.' + key); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function prefSet(key, value) {
    try { localStorage.setItem('pandesh.' + key, value); } catch (e) { /* private mode */ }
  }
  try { localStorage.removeItem('kkd_mobile_token'); localStorage.removeItem('kkd_mobile_pin'); } catch (e) { /* ignore */ }

  // ------------------------------------------------------------------------------------------------------------
  // Network

  function api(path, opts) {
    opts = opts || {};
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, opts.timeout || 15000);
    var init = { method: opts.method || 'GET', headers: Object.assign({}, opts.headers || {}), credentials: 'same-origin', cache: 'no-store' };
    if (ctl) init.signal = ctl.signal;
    if (opts.json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    else if (opts.body !== undefined) { init.headers['Content-Type'] = opts.type; init.body = opts.body; }
    return fetch(path, init).then(function (res) {
      var ct = res.headers.get('content-type') || '';
      var parse = ct.indexOf('application/json') >= 0 ? res.json().catch(function () { return null; }) : Promise.resolve(null);
      return parse.then(function (data) { return { ok: res.ok, status: res.status, data: data }; });
    }).finally(function () { clearTimeout(timer); });
  }

  function newId() {
    var bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  // ------------------------------------------------------------------------------------------------------------
  // Connection: pairing check, live stream, reconnect with backoff, resync after every reconnect.

  var es = null;
  var staleTimer = 0;
  var retryTimer = 0;
  var countdownTimer = 0;

  function setPhase(phase) {
    S.phase = phase;
    if (phase === 'live') S.everLive = true;
    $('app').setAttribute('data-phase', phase);
    renderChrome();
  }

  function takeCodeFromUrl() {
    var params = new URLSearchParams(location.search);
    if (!params.has('pair')) return '';
    var code = (params.get('pair') || '').trim();
    // The code is not kept in history, bookmarks or an installed app's start address.
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
    return code;
  }

  function boot() {
    var code = takeCodeFromUrl();
    if (code) {
      $('pair-code').value = L.formatCodeInput(code);
      S.pendingCode = code;
    }
    api('/api/session', { timeout: 8000 }).then(function (r) {
      if (r.status === 401) {
        showPair();
        return;
      }
      S.pendingCode = '';
      if (!r.ok) { goOffline(); return; }
      S.device = (r.data && r.data.device) || null;
      S.secure = Boolean(r.data && r.data.secure) || S.secure;
      setPhase('connecting');
      connect();
    }).catch(function () { goOffline(); });
  }

  function connect() {
    closeStream();
    clearTimeout(retryTimer);
    if (S.phase !== 'live' && S.phase !== 'offline') setPhase(S.retry > 0 ? 'reconnecting' : 'connecting');
    try {
      es = new EventSource('/api/events');
    } catch (e) {
      scheduleRetry();
      return;
    }
    es.addEventListener('hello', function (e) {
      touch();
      S.retry = 0;
      var d = parse(e.data);
      if (d) {
        if (d.device) S.device = d.device;
        if (d.secure) S.secure = true;
      }
      S.justConnected = true;
      // Words streamed while the phone was away are missing from any reply in progress: drop it and let the
      // conversation (reloaded now) and the next tokens tell the story.
      S.streams.clear();
      setPhase('live');
      resync();
    });
    es.addEventListener('state', function (e) { touch(); var d = parse(e.data); if (d) applyState(d); });
    es.addEventListener('ping', touch);
    es.addEventListener('token', function (e) { touch(); var d = parse(e.data); if (d) onToken(d); });
    es.addEventListener('activity', function (e) { touch(); var d = parse(e.data); if (d) onActivity(d); });
    es.onerror = function () {
      if (!es) return;
      closeStream();
      scheduleRetry();
    };
    armStale();
  }

  function closeStream() {
    if (es) {
      es.onerror = null;
      try { es.close(); } catch (e) { /* ignore */ }
      es = null;
    }
    clearTimeout(staleTimer);
  }

  function parse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  function touch() {
    S.lastEventAt = Date.now();
    armStale();
    renderSheetConnection();
  }

  function armStale() {
    clearTimeout(staleTimer);
    staleTimer = setTimeout(function () {
      if (S.phase === 'pairing') return;
      closeStream();
      scheduleRetry(true);
    }, STALE_MS);
  }

  function scheduleRetry(now) {
    clearTimeout(retryTimer);
    if (S.phase === 'pairing') return;
    if (S.phase === 'live' || S.phase === 'connecting' || S.phase === 'boot') setPhase('reconnecting');
    var delay = now ? 0 : BACKOFF_MS[Math.min(S.retry, BACKOFF_MS.length - 1)];
    S.retry += 1;
    S.nextRetryAt = Date.now() + delay;
    retryTimer = setTimeout(checkAndReconnect, delay);
    renderChrome();
  }

  function checkAndReconnect() {
    api('/api/session', { timeout: 8000 }).then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (r.ok) {
        if (r.data && r.data.device) S.device = r.data.device;
        if (r.data && r.data.secure) S.secure = true;
        connect();
        return;
      }
      afterFailedCheck();
    }).catch(afterFailedCheck);
  }

  function afterFailedCheck() {
    if (S.retry >= 3 && S.phase !== 'offline') setPhase('offline');
    scheduleRetry();
  }

  function goOffline() {
    setPhase('offline');
    scheduleRetry();
  }

  function retryNow() {
    S.retry = 0;
    closeStream();
    scheduleRetry(true);
  }

  /** The phone woke up, came back online or showed the page again: the old connection may be silently dead. */
  function wake() {
    if (S.phase === 'pairing' || S.phase === 'boot') return;
    var stale = Date.now() - S.lastEventAt > 20000;
    if (!es || es.readyState !== 1 || stale) {
      closeStream();
      S.retry = 0;
      scheduleRetry(true);
    } else {
      resync();
    }
  }

  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') wake(); });
  window.addEventListener('online', wake);
  window.addEventListener('pageshow', function (e) { if (e.persisted) wake(); });
  document.addEventListener('resume', wake);
  window.addEventListener('offline', function () {
    if (S.phase === 'pairing') return;
    closeStream();
    setPhase(S.everLive ? 'reconnecting' : 'offline');
    scheduleRetry();
  });

  var resyncing = null;
  function resync() {
    if (!resyncing) {
      resyncing = Promise.all([loadMessages(), loadState()]).finally(function () { resyncing = null; });
    }
    return resyncing;
  }

  function loadState() {
    return api('/api/state').then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (r.ok && r.data) applyState(r.data);
    }).catch(function () { /* the stream reconnect handles it */ });
  }

  var messagesTimer = 0;
  function refreshMessagesSoon(ms) {
    clearTimeout(messagesTimer);
    messagesTimer = setTimeout(loadMessages, ms == null ? 250 : ms);
  }

  function loadMessages() {
    return api('/api/messages').then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (!r.ok || !r.data) return;
      var conversationChanged = (r.data.conversationId || null) !== S.conversationId;
      S.conversationId = r.data.conversationId || null;
      S.messages = Array.isArray(r.data.messages) ? r.data.messages : [];
      reconcileOutbox();
      pruneStreams();
      renderMessages(conversationChanged);
    }).catch(function () { /* retried on the next event or reconnect */ });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Live updates

  function applyState(st) {
    var prev = S.st;
    S.st = st;
    if (st.running) {
      if (S.justConnected && st.attemptId) S.lateAttempts.add(st.attemptId);
      if (!prev || !prev.running || prev.attemptId !== st.attemptId) S.runningSince = S.justConnected ? 0 : Date.now();
      // An approval resumes work under a new attempt id: a voice turn stays a voice turn.
      if (prev && prev.attemptId && st.attemptId && prev.attemptId !== st.attemptId && S.voiceAttempts.has(prev.attemptId)) S.voiceAttempts.add(st.attemptId);
    } else {
      S.runningSince = 0;
      // Nothing runs on the PC: no reply is still being written, even if its end was missed.
      S.streams.forEach(function (s) { if (!s.done) { s.done = true; s.doneAt = Date.now(); } });
      scheduleLive();
    }
    S.justConnected = false;
    if ((st.conversationId || null) !== S.conversationId) refreshMessagesSoon(60);
    else if (prev && prev.running && !st.running) refreshMessagesSoon(200);
    renderDecision();
    renderStatus();
    renderChrome();
    renderPcAssistant();
  }

  function onToken(d) {
    if (!d.attemptId || typeof d.text !== 'string' || !d.text) return;
    var s = S.streams.get(d.attemptId);
    if (!s) {
      s = { text: '', done: false, doneAt: 0, late: S.lateAttempts.has(d.attemptId), knownIds: knownAssistantIds() };
      S.streams.set(d.attemptId, s);
    }
    s.text += d.text;
    // A token means the reply is still being written, whatever an earlier (stale) state said.
    s.done = false;
    scheduleLive();
  }

  function onActivity(e) {
    if (e.kind === 'result' || e.kind === 'cancelled' || e.kind === 'error') {
      var s = e.attemptId ? S.streams.get(e.attemptId) : null;
      if (s) { s.done = true; s.doneAt = Date.now(); }
      if (e.kind === 'result' && typeof e.text === 'string' && e.text.trim()) maybeSpeak(e.attemptId, e.text);
      refreshMessagesSoon(150);
      scheduleLive();
    } else if (e.kind === 'conversation_message') {
      refreshMessagesSoon(150);
    }
  }

  function knownAssistantIds() {
    var ids = new Set();
    S.messages.forEach(function (m) { if (m && m.role === 'assistant') ids.add(m.id); });
    return ids;
  }

  /** A finished stream gives way once its reply is in the conversation (or after a while, whatever happened). */
  function pruneStreams() {
    S.streams.forEach(function (s, id) {
      if (!s.done) return;
      var arrived = S.messages.some(function (m) { return m && m.role === 'assistant' && !s.knownIds.has(m.id); });
      if (arrived || Date.now() - s.doneAt > 15000) S.streams.delete(id);
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Conversation rendering

  var msgEls = new Map();
  var transcript = $('transcript');
  var pinned = true;

  transcript.addEventListener('scroll', function () {
    pinned = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 120;
    if (pinned) $('jump').hidden = true;
  }, { passive: true });

  function stickToBottom(force) {
    if (force || pinned) {
      $('jump').hidden = true;
      requestAnimationFrame(function () { transcript.scrollTop = transcript.scrollHeight; });
    } else if (S.tab === 'chat') {
      $('jump').hidden = false;
    }
  }

  $('jump').addEventListener('click', function () { pinned = true; stickToBottom(true); });

  function isMarker(text) {
    return /^\s*\[(?:earlier message )?truncated\]\s*$/i.test(String(text || ''));
  }

  function renderMessages(reset) {
    var list = $('messages');
    if (reset) { list.replaceChildren(); msgEls.clear(); }
    var seen = new Set();
    var prev = null;
    S.messages.forEach(function (m) {
      if (!m || !m.id || (m.role !== 'user' && m.role !== 'assistant') || isMarker(m.content)) return;
      seen.add(m.id);
      var rec = msgEls.get(m.id);
      if (!rec || rec.content !== m.content) {
        var fresh = messageEl(m);
        if (rec) rec.el.replaceWith(fresh);
        rec = { el: fresh, content: m.content };
        msgEls.set(m.id, rec);
      }
      var expected = prev ? prev.nextSibling : list.firstChild;
      if (rec.el !== expected) list.insertBefore(rec.el, expected);
      prev = rec.el;
    });
    msgEls.forEach(function (rec, id) { if (!seen.has(id)) { rec.el.remove(); msgEls.delete(id); } });
    renderOutbox();
    renderLive();
    updateHero();
    stickToBottom(reset);
  }

  function timeLabel(iso) {
    var t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    var d = new Date(t);
    var today = new Date();
    var sameDay = d.toDateString() === today.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function messageEl(m) {
    if (m.role === 'user') {
      return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble', text: m.content }));
    }
    var body = h('div', { class: 'md' });
    body.append(markdown(m.content));
    var speakBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Read this reply aloud', onclick: function () { speak(m.content, true); } }, icon('speaker'));
    var meta = h('div', { class: 'meta' }, h('span', { text: 'Pandesh' }), h('span', { text: timeLabel(m.createdAt) }), speakBtn);
    return h('div', { class: 'msg msg-assistant' }, body, meta);
  }

  function inline(nodes, parent) {
    nodes.forEach(function (n) {
      if (n.t === 'text') parent.append(n.v);
      else if (n.t === 'br') parent.append(h('br'));
      else if (n.t === 'code') parent.append(h('code', { text: n.v }));
      else if (n.t === 'b') parent.append(inline(n.c, h('strong')));
      else if (n.t === 'i') parent.append(inline(n.c, h('em')));
      else if (n.t === 'a') parent.append(inline(n.c, h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' })));
    });
    return parent;
  }

  function markdown(source) {
    var frag = document.createDocumentFragment();
    L.parseMarkdown(source).forEach(function (b) {
      if (b.t === 'p') frag.append(inline(b.inl, h('p')));
      else if (b.t === 'h') frag.append(inline(b.inl, h(b.level <= 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5', { class: 'md-h' })));
      else if (b.t === 'ul' || b.t === 'ol') {
        var list = h(b.t, b.t === 'ol' && b.start !== 1 ? { start: b.start } : null);
        b.items.forEach(function (item) { list.append(inline(item, h('li'))); });
        frag.append(list);
      } else if (b.t === 'code') frag.append(h('pre', null, h('code', { text: b.text })));
      else if (b.t === 'quote') frag.append(inline(b.inl, h('blockquote')));
      else if (b.t === 'hr') frag.append(h('hr'));
      else if (b.t === 'img') frag.append(h('img', { class: 'md-img', src: '/api/artifacts/' + encodeURIComponent(b.id) + '/content', alt: b.alt || 'Image from Pandesh', loading: 'lazy' }));
      else if (b.t === 'doc') {
        var href = '/api/artifacts/' + encodeURIComponent(b.id) + '/content';
        frag.append(h('div', { class: 'doc-card' },
          h('span', { class: 'doc-name', text: b.name || 'Document' }),
          h('a', { href: href, target: '_blank', rel: 'noopener', text: 'Open' }),
          h('a', { href: href + '?download=1', download: b.name || 'document', text: 'Download' })));
      } else if (b.t === 'table') {
        var table = h('table');
        b.rows.forEach(function (row, i) {
          var tr = h('tr');
          row.forEach(function (cell) { tr.append(inline(L.parseInline(cell), h(i === 0 ? 'th' : 'td'))); });
          table.append(tr);
        });
        frag.append(h('div', { class: 'table-wrap' }, table));
      }
    });
    return frag;
  }

  function renderOutbox() {
    var box = $('outbox');
    box.replaceChildren();
    S.outbox.forEach(function (item) {
      var failed = item.status === 'failed';
      var note = item.status === 'sending' ? 'Sending…'
        : item.status === 'retrying' ? 'Waiting for your PC…'
          : failed ? item.error || 'Not sent.'
            : item.note || '';
      var el = h('div', { class: 'msg msg-user' + (failed ? ' failed' : '') }, h('div', { class: 'bubble', text: item.text }));
      if (note) el.append(h('div', { class: 'msg-note' + (failed ? ' error' : ''), text: note }));
      if (failed) {
        el.append(h('div', { class: 'msg-actions' },
          h('button', { type: 'button', class: 'btn small', text: 'Try again', onclick: function () { deliver(item, 0); } }),
          h('button', { type: 'button', class: 'btn small ghost', text: 'Remove', onclick: function () { S.outbox = S.outbox.filter(function (x) { return x !== item; }); renderOutbox(); updateHero(); } })));
      }
      box.append(el);
    });
  }

  function reconcileOutbox() {
    var norm = function (s) { return String(s || '').replace(/\s+/g, ' ').trim(); };
    S.outbox = S.outbox.filter(function (item) {
      if (item.status !== 'sent') return true;
      var listed = S.messages.some(function (m) { return m && m.role === 'user' && !item.knownIds.has(m.id) && norm(m.content) === norm(item.text); });
      if (listed) return false;
      var age = Date.now() - item.at;
      if (item.routed === 'queued' || item.routed === 'corrected_queued') return age < 30 * 60000;
      return age < 3 * 60000;
    });
  }

  var liveFrame = 0;
  function scheduleLive() {
    if (liveFrame) return;
    liveFrame = requestAnimationFrame(function () { liveFrame = 0; renderLive(); stickToBottom(); });
  }

  function renderLive() {
    var box = $('live');
    box.replaceChildren();
    S.streams.forEach(function (s) {
      if (!s.text) return;
      var body = h('div', { class: 'md' });
      body.append(markdown((s.late ? '… ' : '') + s.text));
      if (!s.done) {
        // The caret follows the last words, inside the paragraph or list item they are in.
        var caret = h('span', { class: 'caret', 'aria-hidden': 'true' });
        var target = body.lastElementChild;
        if (target && (target.tagName === 'UL' || target.tagName === 'OL')) target = target.lastElementChild;
        if (target && /^(?:P|LI|H3|H4|H5|BLOCKQUOTE)$/.test(target.tagName)) target.append(caret);
        else body.append(caret);
      }
      box.append(h('div', { class: 'msg msg-assistant', 'aria-busy': s.done ? 'false' : 'true' }, body));
    });
    updateHero();
  }

  function updateHero() {
    var empty = !S.messages.length && !S.outbox.length && !S.streams.size && !(S.st && S.st.decision);
    $('hero').hidden = !empty;
    if (empty) {
      var now = new Date();
      var hour = now.getHours();
      $('hero-title').textContent = hour < 5 ? 'Good night.' : hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
      $('hero-date').textContent = now.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' });
    }
  }

  // ------------------------------------------------------------------------------------------------------------
  // The decision waiting for the owner (same wording as on the PC)

  function renderDecision() {
    var d = S.st && S.st.decision;
    var box = $('decision');
    if (!d) {
      box.hidden = true;
      box.replaceChildren();
      box.removeAttribute('data-id');
      updateBadges();
      updateHero();
      return;
    }
    if (box.getAttribute('data-id') === d.approvalId && !box.hidden) return;
    box.setAttribute('data-id', d.approvalId);
    var rows = h('dl', { class: 'kv' });
    (d.rows || []).forEach(function (r) { rows.append(h('dt', { text: r[0] }), h('dd', { text: r[1] })); });
    box.replaceChildren(
      h('div', { class: 'decision-tag', text: 'Needs your OK' }),
      h('h3', { class: 'decision-title', text: d.title }),
      rows,
      d.detail ? h('pre', { class: 'decision-detail', text: d.detail }) : null,
      h('div', { class: 'decision-actions' },
        h('button', { type: 'button', class: 'btn primary block', 'data-resolution': 'approved', text: d.allowLabel || 'Allow', onclick: function () { decide(d, 'approved'); } }),
        h('button', { type: 'button', class: 'btn block', 'data-resolution': 'rejected', text: 'Decline', onclick: function () { decide(d, 'rejected'); } })),
      h('p', { class: 'decision-msg', role: 'status' }));
    box.hidden = false;
    updateBadges();
    updateHero();
    stickToBottom(true);
    if (document.visibilityState === 'visible' && navigator.vibrate) { try { navigator.vibrate(20); } catch (e) { /* ignore */ } }
  }

  function decide(d, resolution) {
    if (S.deciding) return;
    S.deciding = true;
    var box = $('decision');
    var msg = box.querySelector('.decision-msg');
    box.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    if (msg) msg.textContent = 'Sending your answer…';
    api('/api/approval', { method: 'POST', json: { approvalId: d.approvalId, kind: d.kind, resolution: resolution } }).then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (r.ok) {
        toast(resolution === 'approved' ? 'Allowed: ' + d.title : 'Declined: ' + d.title);
        if (r.data && r.data.state) applyState(r.data.state);
      } else {
        if (msg) msg.textContent = (r.data && r.data.error) || 'Your answer was not accepted.';
        box.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
        loadState();
      }
    }).catch(function () {
      if (msg) msg.textContent = 'Could not reach your PC. Your answer was not sent.';
      box.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
    }).finally(function () { S.deciding = false; });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Working line and Stop

  var statusTick = 0;
  function renderStatus() {
    var st = S.st;
    var line = $('status-line');
    var show = Boolean(st && st.running);
    line.hidden = !show;
    if (!show) {
      clearInterval(statusTick);
      statusTick = 0;
      return;
    }
    var waiting = Boolean(st.decision);
    // Step titles come from the PC's workspace activity (written for people); raw event names never show.
    var text = waiting ? 'Waiting for your OK' : (st.activity && st.activity.title) || 'Working…';
    $('status-text').textContent = text;
    line.setAttribute('data-tone', waiting ? 'attention' : 'pulse');
    if (!statusTick) statusTick = setInterval(updateElapsed, 1000);
    updateElapsed();
  }

  function updateElapsed() {
    var el = $('status-time');
    if (!S.runningSince) { el.textContent = ''; return; }
    var s = Math.max(0, Math.floor((Date.now() - S.runningSince) / 1000));
    el.textContent = Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2);
  }

  $('stop-btn').addEventListener('click', function () {
    var btn = $('stop-btn');
    btn.disabled = true;
    api('/api/cancel', { method: 'POST', json: {} }).then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      toast(r.ok ? 'Stopping…' : (r.data && r.data.error) || 'Nothing to stop.');
      loadState();
    }).catch(function () { toast('Could not reach your PC.'); }).finally(function () { btn.disabled = false; });
  });

  // ------------------------------------------------------------------------------------------------------------
  // Sending (each message has an id; a retry with the same id is never run twice by the PC)

  var input = $('input');
  var coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  function autoGrow() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 168) + 'px';
  }

  function updateSend() {
    $('send-btn').disabled = !input.value.trim();
  }

  function setComposerNote(text, isError) {
    var note = $('composer-note');
    note.textContent = text || '';
    note.className = 'composer-note' + (isError ? ' error' : '');
    note.hidden = !text;
  }

  input.addEventListener('input', function () {
    autoGrow();
    updateSend();
    if (S.reviewTurn && input.value.trim() !== S.reviewTurn.text) { S.reviewTurn = null; setComposerNote(''); }
  });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !coarse && !e.isComposing) { e.preventDefault(); submitComposer(); }
  });
  input.addEventListener('focus', function () { $('app').classList.add('typing'); stickToBottom(); });
  input.addEventListener('blur', function () { setTimeout(function () { $('app').classList.remove('typing'); }, 150); });
  $('composer').addEventListener('submit', function (e) { e.preventDefault(); submitComposer(); });

  function submitComposer() {
    var text = input.value.trim();
    if (!text) return;
    var voiceTurnId = S.reviewTurn && S.reviewTurn.text === text ? S.reviewTurn.id : null;
    S.reviewTurn = null;
    setComposerNote('');
    input.value = '';
    autoGrow();
    updateSend();
    sendText(text, voiceTurnId);
  }

  function sendText(text, voiceTurnId) {
    var known = new Set();
    S.messages.forEach(function (m) { if (m && m.role === 'user') known.add(m.id); });
    var item = { id: newId(), text: text, at: Date.now(), status: 'sending', voiceTurnId: voiceTurnId || null, knownIds: known, note: '', error: '' };
    S.outbox.push(item);
    pinned = true;
    renderOutbox();
    updateHero();
    stickToBottom(true);
    deliver(item, 0);
  }

  function deliver(item, attempt) {
    item.status = attempt ? 'retrying' : 'sending';
    renderOutbox();
    api('/api/submit', { method: 'POST', json: { message: item.text, clientMessageId: item.id, voiceTurnId: item.voiceTurnId || undefined }, timeout: 45000 }).then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (r.ok && r.data && r.data.ok !== false) {
        item.status = 'sent';
        item.routed = r.data.routed || null;
        item.note = ROUTED[item.routed] || '';
        if (item.voiceTurnId && r.data.attemptId) S.voiceAttempts.add(r.data.attemptId);
        refreshMessagesSoon(400);
        loadState();
      } else {
        item.status = 'failed';
        item.error = (r.data && r.data.error) || 'Pandesh could not take this message (' + r.status + ').';
      }
      renderOutbox();
    }).catch(function () {
      if (attempt < 5 && document.visibilityState === 'visible') {
        item.status = 'retrying';
        renderOutbox();
        setTimeout(function () { deliver(item, attempt + 1); }, BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]);
        return;
      }
      item.status = 'failed';
      item.error = 'Not sent: your PC could not be reached.';
      renderOutbox();
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Voice: the phone records 16 kHz WAV, the PC's local Whisper transcribes it, and it is sent as a spoken turn.

  var Rec = { state: 'idle', ctx: null, stream: null, src: null, proc: null, sink: null, chunks: [], frames: 0, rate: 48000, speechMs: 0, silenceMs: 0, floor: 1, heard: false, turnId: '' };

  function micErrorText(err) {
    var name = err && err.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'The microphone is not allowed for this page. Allow it in the browser’s site settings, then try again.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found on this phone.';
    if (name === 'NotReadableError' || name === 'AbortError') return 'The microphone is busy in another app.';
    return 'The microphone could not be opened.';
  }

  function unlockSpeech() {
    // A first utterance inside a tap lets later replies speak without one (mobile browsers require it).
    try {
      if ('speechSynthesis' in window && !S.speechUnlocked) {
        var u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        window.speechSynthesis.speak(u);
        S.speechUnlocked = true;
      }
    } catch (e) { /* ignore */ }
  }

  function startListening() {
    if (Rec.state !== 'idle') return;
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setComposerNote('Voice needs the secure link. Phones block the microphone on a plain http:// address. On your PC, open Connections → Phone and set up Tailscale, then use the https:// link.', true);
      return;
    }
    stopSpeaking();
    unlockSpeech();
    Rec.state = 'starting';
    renderVoice();
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then(function (stream) {
      if (Rec.state !== 'starting') { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
      var AC = window.AudioContext || window.webkitAudioContext;
      Rec.stream = stream;
      Rec.ctx = new AC();
      var ready = Rec.ctx.state === 'suspended' ? Rec.ctx.resume() : Promise.resolve();
      return ready.then(function () {
        Rec.rate = Rec.ctx.sampleRate;
        Rec.chunks = []; Rec.frames = 0; Rec.speechMs = 0; Rec.silenceMs = 0; Rec.floor = 1; Rec.heard = false;
        Rec.turnId = newId().slice(0, 12);
        Rec.src = Rec.ctx.createMediaStreamSource(stream);
        Rec.proc = Rec.ctx.createScriptProcessor(4096, 1, 1);
        Rec.sink = Rec.ctx.createGain();
        Rec.sink.gain.value = 0;
        Rec.proc.onaudioprocess = onAudio;
        Rec.src.connect(Rec.proc);
        Rec.proc.connect(Rec.sink);
        Rec.sink.connect(Rec.ctx.destination);
        Rec.state = 'listening';
        setComposerNote('');
        renderVoice();
        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (e) { /* ignore */ } }
      });
    }).catch(function (err) {
      teardownMic();
      Rec.state = 'idle';
      renderVoice();
      setComposerNote(micErrorText(err), true);
    });
  }

  function onAudio(e) {
    if (Rec.state !== 'listening') return;
    var data = e.inputBuffer.getChannelData(0);
    Rec.chunks.push(new Float32Array(data));
    Rec.frames += data.length;
    var level = L.rms(data);
    var ms = (data.length / Rec.rate) * 1000;
    var elapsed = (Rec.frames / Rec.rate) * 1000;
    Rec.floor = Math.min(Rec.floor, Math.max(level, 0.0005));
    var threshold = Math.max(0.02, Rec.floor * 4);
    if (level >= threshold) {
      Rec.speechMs += ms;
      Rec.silenceMs = 0;
      if (Rec.speechMs >= 250) Rec.heard = true;
    } else if (Rec.heard && level < threshold * 0.7) {
      Rec.silenceMs += ms;
    }
    $('meter-fill').style.width = Math.min(100, Math.round((level / Math.max(threshold * 2.5, 0.05)) * 100)) + '%';
    if (Rec.heard && Rec.silenceMs >= 1400) finishListening();
    else if (elapsed >= 45000) finishListening();
    else if (!Rec.heard && elapsed >= 10000) cancelListening('No speech was heard. Tap the microphone and speak.');
  }

  function teardownMic() {
    try { if (Rec.proc) { Rec.proc.onaudioprocess = null; Rec.proc.disconnect(); } } catch (e) { /* ignore */ }
    try { if (Rec.src) Rec.src.disconnect(); } catch (e) { /* ignore */ }
    try { if (Rec.sink) Rec.sink.disconnect(); } catch (e) { /* ignore */ }
    try { if (Rec.stream) Rec.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
    try { if (Rec.ctx) Rec.ctx.close(); } catch (e) { /* ignore */ }
    Rec.proc = Rec.src = Rec.sink = Rec.stream = Rec.ctx = null;
  }

  function cancelListening(reason) {
    if (Rec.state === 'idle' || Rec.state === 'transcribing') return;
    Rec.state = 'idle';
    teardownMic();
    Rec.chunks = [];
    renderVoice();
    if (reason) setComposerNote(reason);
  }

  function finishListening() {
    if (Rec.state !== 'listening') return;
    var chunks = Rec.chunks;
    var rate = Rec.rate;
    var seconds = Rec.frames / rate;
    var turnId = Rec.turnId;
    var heard = Rec.heard;
    Rec.chunks = [];
    teardownMic();
    if (!heard && seconds < 0.8) {
      Rec.state = 'idle';
      renderVoice();
      setComposerNote('Nothing was recorded. Tap the microphone and speak.');
      return;
    }
    Rec.state = 'transcribing';
    renderVoice();
    var wav = L.encodeWav(chunks, rate, 16000);
    api('/api/voice/transcribe', { method: 'POST', body: new Blob([wav], { type: 'audio/wav' }), type: 'audio/wav', headers: { 'X-Voice-Turn-Id': turnId }, timeout: 90000 }).then(function (r) {
      Rec.state = 'idle';
      renderVoice();
      if (r.status === 401) { lostPairing(); return; }
      if (!r.ok) { setComposerNote((r.data && r.data.error) || 'Pandesh could not understand the recording.', true); return; }
      var text = String((r.data && (r.data.transcript || r.data.text)) || '').trim();
      if (!text) { setComposerNote('Nothing was recognised. Try again, or type.'); return; }
      if (r.data.review && r.data.review.required) {
        input.value = text;
        autoGrow();
        updateSend();
        S.reviewTurn = { id: turnId, text: text };
        setComposerNote('Check what Pandesh heard, then send.');
        return;
      }
      sendText(text, turnId);
    }).catch(function () {
      Rec.state = 'idle';
      renderVoice();
      setComposerNote('Could not reach your PC to understand the recording.', true);
    });
  }

  function renderVoice() {
    var mic = $('mic-btn');
    var line = $('voice-line');
    var listening = Rec.state === 'listening';
    mic.setAttribute('data-state', listening ? 'listening' : Rec.state === 'idle' ? 'idle' : 'busy');
    mic.setAttribute('aria-label', listening ? 'Stop and send what you said' : 'Speak to Pandesh');
    mic.disabled = Rec.state === 'starting' || Rec.state === 'transcribing';
    line.hidden = Rec.state === 'idle';
    $('voice-text').textContent = Rec.state === 'starting' ? 'Opening the microphone…'
      : listening ? 'Listening… tap the microphone when you are done'
        : Rec.state === 'transcribing' ? 'Understanding what you said…' : '';
    $('voice-cancel').hidden = Rec.state === 'transcribing';
    if (!listening) $('meter-fill').style.width = '0%';
  }

  $('mic-btn').addEventListener('click', function () {
    if (Rec.state === 'listening') finishListening();
    else if (Rec.state === 'idle') startListening();
  });
  $('voice-cancel').addEventListener('click', function () { cancelListening('Stopped listening. Nothing was sent.'); });

  // Spoken replies: the phone's own voice, so the PC is not tied up playing audio.
  function maybeSpeak(attemptId, text) {
    if (S.readAloud === 'off') return;
    if (S.readAloud === 'voice' && !(attemptId && S.voiceAttempts.has(attemptId))) return;
    speak(text, false);
  }

  function speak(text, manual) {
    if (!('speechSynthesis' in window)) { if (manual) toast('This browser cannot read aloud.'); return; }
    var plain = L.plainForSpeech(text);
    if (!plain) return;
    try {
      window.speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(plain);
      u.onend = u.onerror = function () { S.speaking = false; };
      S.speaking = true;
      window.speechSynthesis.speak(u);
    } catch (e) { S.speaking = false; }
  }

  function stopSpeaking() {
    try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
    S.speaking = false;
  }

  // ------------------------------------------------------------------------------------------------------------
  // Pairing

  var pairInput = $('pair-code');
  pairInput.addEventListener('input', function () {
    var formatted = L.formatCodeInput(pairInput.value);
    if (formatted !== pairInput.value) pairInput.value = formatted;
    setPairMsg('');
  });
  $('pair-form').addEventListener('submit', function (e) { e.preventDefault(); pair(pairInput.value); });

  function setPairMsg(text, isError) {
    var el = $('pair-msg');
    el.textContent = text || '';
    el.className = 'form-msg' + (isError ? ' error' : '');
  }

  function showPair(message) {
    closeStream();
    clearTimeout(retryTimer);
    setPhase('pairing');
    if (message) setPairMsg(message, false);
    // A code that came in the link (QR code) is used once, as soon as the PC is reachable.
    if (S.pendingCode) {
      var code = S.pendingCode;
      S.pendingCode = '';
      pair(code);
    }
  }

  function lostPairing() {
    var wasPaired = S.everLive || Boolean(S.device);
    S.device = null;
    S.st = null;
    S.messages = [];
    S.outbox = [];
    S.streams.clear();
    msgEls.clear();
    $('messages').replaceChildren();
    $('outbox').replaceChildren();
    $('live').replaceChildren();
    renderDecision();
    renderStatus();
    S.everLive = false;
    showPair(wasPaired ? 'This phone is not paired any more. Pair it again with a new code from your PC.' : '');
  }

  function pair(raw) {
    var code = L.normalizeCode(raw);
    if (!code) { setPairMsg('A code has 8 letters and digits, like ABCD-EFGH. Check it on your PC.', true); return; }
    var btn = $('pair-submit');
    btn.disabled = true;
    btn.textContent = 'Pairing…';
    setPairMsg('');
    api('/api/pair', { method: 'POST', json: { code: code }, timeout: 15000 }).then(function (r) {
      if (r.ok && r.data && r.data.ok) {
        S.device = r.data.device || null;
        pairInput.value = '';
        S.retry = 0;
        setPhase('connecting');
        connect();
        toast('Paired. This phone can now use Pandesh.');
        return;
      }
      setPairMsg((r.data && (r.data.message || r.data.error)) || 'Pairing did not work (' + r.status + ').', true);
    }).catch(function () {
      setPairMsg('This phone cannot reach your PC. Open “Can’t connect?” below.', true);
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = 'Pair';
    });
  }

  // ------------------------------------------------------------------------------------------------------------
  // Tasks (Kandev development stories: their status and the decisions only a person can make)

  var tasksTimer = 0;
  var openTaskId = null;

  function startTasks() {
    loadTasks();
    clearInterval(tasksTimer);
    tasksTimer = setInterval(function () { if (document.visibilityState === 'visible') loadTasks(); }, 5000);
  }
  function stopTasks() {
    clearInterval(tasksTimer);
    // Off the tab, a slow check keeps the badge honest.
    tasksTimer = setInterval(function () { if (document.visibilityState === 'visible' && S.phase === 'live') loadTasks(); }, 30000);
  }

  function postTask(url, body) {
    return api(url, { method: 'POST', json: body || {} }).then(function (r) {
      if (r.status === 401) lostPairing();
      else if (!r.ok) toast((r.data && r.data.error) || 'That did not work.');
      return r;
    }).catch(function () { toast('Could not reach your PC.'); });
  }

  function loadTasks() {
    return api('/api/dev-stories').then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (r.ok) renderTasks(r.data || {});
    }).catch(function () { /* next poll */ });
  }

  function needsYou(s) {
    return Boolean((s.pendingApprovals && s.pendingApprovals.length) || s.status === 'delivery_approval' || (s.deviceVerification && s.deviceVerification.state === 'awaiting'));
  }

  function renderTasks(data) {
    var stories = Array.isArray(data.stories) ? data.stories : [];
    var counts = data.counts || {};
    var parts = [];
    ['running', 'waiting', 'review', 'approval', 'verifying', 'blocked', 'ready', 'completed'].forEach(function (k) { if (counts[k]) parts.push(counts[k] + ' ' + k); });
    $('tasks-counts').textContent = data.available === false
      ? 'Kandev, which runs development tasks, is not running on your PC.'
      : parts.join(' · ') || (stories.length ? '' : 'Nothing running.');
    $('tasks-empty').hidden = stories.length > 0;
    $('tasks-stop-all').hidden = !stories.some(function (s) { return s.status !== 'done'; });
    S.tasksNeedYou = stories.filter(needsYou).length;
    updateBadges();
    var list = $('tasks-list');
    list.replaceChildren.apply(list, stories.map(taskEl));
  }

  function taskEl(s) {
    var proof = { independent: 'independently verified', 'human-reviewed': 'reviewed by you', 'worker-only': 'worker tests only' }[s.verification] || '';
    var meta = [s.agent, s.status === 'done' ? 'completed' : s.phase, proof, s.commit].filter(Boolean).join(' · ');
    var li = h('li', { class: 'task' + (needsYou(s) ? ' needs-you' : '') },
      h('h3', { class: 'task-title', text: s.title }),
      h('p', { class: 'task-meta', text: meta }),
      s.waitingReason ? h('p', { class: 'task-note', text: s.waitingReason }) : null);
    var id = encodeURIComponent(s.id);
    (s.pendingApprovals || []).forEach(function (p) {
      li.append(h('div', { class: 'task-row' },
        h('span', { class: 'task-pending', text: p.what }),
        h('button', { type: 'button', class: 'btn small primary', text: 'Allow once', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/permissions/' + encodeURIComponent(p.pendingId), { allow: true }).then(loadTasks); } }),
        h('button', { type: 'button', class: 'btn small', text: 'Deny', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/permissions/' + encodeURIComponent(p.pendingId), { allow: false }).then(loadTasks); } })));
    });
    if (s.status === 'delivery_approval') {
      li.append(h('div', { class: 'task-row' }, h('button', { type: 'button', class: 'btn small primary', text: 'Approve after review', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/approve-review').then(loadTasks); } })));
    }
    if (s.status === 'blocked' || s.status === 'delivery_approval') {
      li.append(h('div', { class: 'task-row' }, h('button', { type: 'button', class: 'btn small', text: s.phase === 'stopped' ? 'Resume' : 'Retry', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/retry').then(loadTasks); } })));
    }
    if (s.deviceVerification && s.deviceVerification.state === 'awaiting') {
      li.append(h('p', { class: 'task-note', text: 'Check this on this phone: ' + (s.deviceVerification.instructions || []).join('; ') }));
      li.append(h('div', { class: 'task-row' },
        h('button', { type: 'button', class: 'btn small primary', text: 'Works on this phone', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/device-verified', { ok: true }).then(loadTasks); } }),
        h('button', { type: 'button', class: 'btn small danger', text: 'Fails on this phone', onclick: function (e) { e.currentTarget.disabled = true; postTask('/api/dev-stories/' + id + '/device-verified', { ok: false }).then(loadTasks); } })));
    }
    li.append(h('div', { class: 'task-row' }, h('button', { type: 'button', class: 'btn small ghost', text: 'Details', onclick: function () { openTask(s.id); } })));
    return li;
  }

  function openTask(id) {
    openTaskId = id;
    api('/api/dev-stories/' + encodeURIComponent(id)).then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (!r.ok || !r.data || !r.data.story || openTaskId !== id) return;
      var d = r.data;
      var panel = $('task-detail');
      var timeline = h('ul');
      (d.timeline || []).forEach(function (t) { timeline.append(h('li', { text: t.event + ' · ' + new Date(t.at).toLocaleString() + (t.text ? ' · ' + t.text : '') })); });
      panel.replaceChildren(
        h('div', { class: 'page-head' }, h('h3', { class: 'task-title', text: d.story.title }), h('button', { type: 'button', class: 'btn small', text: 'Close', onclick: function () { openTaskId = null; panel.hidden = true; } })),
        h('p', { class: 'task-meta', text: [d.story.agent, d.story.status === 'done' ? 'completed' : d.story.phase, d.story.commit ? 'commit ' + d.story.commit : ''].filter(Boolean).join(' · ') }),
        d.changedFiles && d.changedFiles.length ? h('h4', { text: 'Changed files' }) : null,
        d.changedFiles && d.changedFiles.length ? h('p', { class: 'task-note', text: d.changedFiles.join(', ') }) : null,
        h('h4', { text: 'Timeline' }),
        timeline);
      panel.hidden = false;
      panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }).catch(function () { toast('Could not reach your PC.'); });
  }

  $('tasks-stop-all').addEventListener('click', function () {
    if (!window.confirm('Stop all development tasks? Nothing restarts until you resume it.')) return;
    postTask('/api/dev-stories/stop-all').then(loadTasks);
  });

  // ------------------------------------------------------------------------------------------------------------
  // PC tab

  var healthTimer = 0;
  function startHealth() {
    loadHealth();
    clearInterval(healthTimer);
    healthTimer = setInterval(function () { if (document.visibilityState === 'visible') loadHealth(); }, 5000);
  }
  function stopHealth() { clearInterval(healthTimer); healthTimer = 0; }

  function gb(bytes) {
    if (bytes == null || !isFinite(bytes)) return null;
    return (bytes / 1073741824).toFixed(bytes >= 10737418240 ? 0 : 1) + ' GB';
  }

  function setText(id, text) { $(id).textContent = text; }

  function loadHealth() {
    api('/api/telemetry').then(function (r) {
      if (r.status === 401) { lostPairing(); return; }
      if (!r.ok || !r.data) { setText('h-status', 'Health readings are not available right now.'); return; }
      var t = r.data;
      var cpu = t.cpu || {};
      setText('h-cpu', cpu.available && cpu.value != null ? cpu.value + '%' : (cpu.detail || 'Unavailable'));
      var mem = t.memory || {};
      setText('h-ram', mem.available ? mem.usedPercent + '% · ' + gb(mem.usedBytes) + ' of ' + gb(mem.totalBytes) : 'Unavailable');
      var gpu = t.gpu || {};
      setText('h-gpu', gpu.available ? (gpu.name || 'GPU') : 'Unavailable');
      var load = [];
      if (gpu.usagePercent != null) load.push(gpu.usagePercent + '%');
      if (gpu.temperatureC != null) load.push(gpu.temperatureC + ' °C');
      setText('h-gpu-load', load.length ? load.join(' · ') : 'Unavailable');
      setText('h-vram', gpu.vramUsedBytes != null && gpu.vramTotalBytes != null ? gb(gpu.vramUsedBytes) + ' of ' + gb(gpu.vramTotalBytes) : 'Unavailable');
      var disk = t.disk || {};
      setText('h-disk', disk.available ? disk.usedPercent + '% used · ' + gb(disk.freeBytes) + ' free' : (disk.blocker || 'Unavailable'));
      setText('h-ollama', t.ollama && t.ollama.reachable ? 'Running' : 'Not reachable');
      setText('h-status', 'Live · updated ' + new Date(t.collectedAt || Date.now()).toLocaleTimeString());
    }).catch(function () { setText('h-status', 'Could not reach your PC. Retrying…'); });
  }

  function renderPcAssistant() {
    var st = S.st;
    setText('pc-core', !st ? '—' : st.coreState === 'connected' ? 'Ready' : st.coreState === 'connecting' ? 'Starting…' : 'Not running');
    setText('pc-model', st ? st.model || 'Auto' : '—');
    setText('pc-workspace', st && st.workspace ? st.workspace : 'None selected');
    setText('pc-link', linkLabel());
  }

  /** How this page reached the PC: the secure Tailscale link, the PC itself, or the home network. */
  function linkKind() {
    if (S.secure) return 'secure';
    return /^(?:127\.\d+\.\d+\.\d+|localhost|\[::1\])$/.test(location.hostname) ? 'local' : 'wifi';
  }

  function linkLabel() {
    var kind = linkKind();
    return kind === 'secure' ? 'Secure (https, Tailscale)' : kind === 'local' ? 'This PC (local address)' : 'Home Wi-Fi (http): no voice, no install';
  }

  // ------------------------------------------------------------------------------------------------------------
  // Chrome: connection pill, banner, which view shows, badges

  function show(id, visible) { $(id).hidden = !visible; }

  function renderChrome() {
    var p = S.phase;
    var st = S.st;
    var pill = $('conn-pill');
    var label;
    var tone;
    if (p === 'live') {
      if (st && st.coreState === 'offline') { label = 'PC engine off'; tone = 'bad'; }
      else if (st && st.coreState === 'connecting') { label = 'PC starting'; tone = 'busy'; }
      else { label = 'Live'; tone = 'ok'; }
    } else if (p === 'boot' || p === 'connecting') { label = 'Connecting…'; tone = 'busy'; }
    else if (p === 'reconnecting') { label = 'Reconnecting…'; tone = 'busy'; }
    else if (p === 'offline') { label = 'Offline'; tone = 'bad'; }
    else { label = 'Not paired'; tone = 'muted'; }
    pill.textContent = label;
    pill.setAttribute('data-tone', tone);

    var kind = linkKind();
    $('brand-sub').textContent = st && p === 'live'
      ? (st.model || 'Auto') + ' · ' + (kind === 'secure' ? 'secure link' : kind === 'local' ? 'this PC' : 'home Wi-Fi')
      : 'Your assistant on your PC';

    var bootVisible = p === 'boot' || (p === 'connecting' && !S.everLive && !st);
    var appVisible = p === 'live' || p === 'connecting' || p === 'reconnecting' || (p === 'offline' && S.everLive);
    var mainVisible = appVisible && !bootVisible;
    show('view-boot', bootVisible);
    show('view-pair', p === 'pairing');
    show('view-offline', p === 'offline' && !S.everLive);
    show('tabbar', mainVisible);
    ['chat', 'tasks', 'pc'].forEach(function (t) { show('view-' + t, mainVisible && S.tab === t); });
    $('menu-btn').hidden = p === 'pairing' || p === 'boot';

    renderBanner();
    renderSheetConnection();
    if (p === 'offline' && !S.everLive) renderOfflineCountdown();
  }

  function renderBanner() {
    var banner = $('banner');
    var text = $('banner-text');
    var action = $('banner-action');
    var p = S.phase;
    var st = S.st;
    var msg = '';
    var tone = 'warn';
    var act = null;
    if (S.everLive && p === 'reconnecting') msg = 'Reconnecting to your PC…';
    else if (S.everLive && p === 'offline') { msg = 'Can’t reach your PC. ' + countdownText(); tone = 'bad'; act = 'Retry'; }
    else if (p === 'live' && st && st.coreState === 'connecting') msg = 'Pandesh is starting on your PC…';
    else if (p === 'live' && st && st.coreState === 'offline') { msg = 'Pandesh’s engine on your PC is not running. Open Pandesh on the PC.'; tone = 'bad'; }
    banner.hidden = !msg;
    banner.setAttribute('data-tone', tone);
    text.textContent = msg;
    action.hidden = !act;
    if (act) action.textContent = act;
    clearInterval(countdownTimer);
    if (p === 'offline') countdownTimer = setInterval(function () { if (S.everLive) text.textContent = 'Can’t reach your PC. ' + countdownText(); else renderOfflineCountdown(); }, 1000);
  }

  function countdownText() {
    var s = Math.max(0, Math.ceil((S.nextRetryAt - Date.now()) / 1000));
    return s > 0 ? 'Trying again in ' + s + ' s.' : 'Trying again…';
  }

  function renderOfflineCountdown() {
    $('offline-next').textContent = countdownText();
  }

  $('banner-action').addEventListener('click', retryNow);
  $('offline-retry').addEventListener('click', retryNow);

  function updateBadges() {
    var decision = Boolean(S.st && S.st.decision);
    var chatBadge = $('badge-chat');
    chatBadge.hidden = !(decision && S.tab !== 'chat');
    chatBadge.textContent = '1';
    var tasksBadge = $('badge-tasks');
    tasksBadge.hidden = !(S.tasksNeedYou > 0 && S.tab !== 'tasks');
    tasksBadge.textContent = String(S.tasksNeedYou);
    document.title = decision ? '(1) Pandesh' : 'Pandesh';
  }

  // Tabs
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (btn) {
    btn.addEventListener('click', function () { setTab(btn.getAttribute('data-tab')); });
  });

  function setTab(tab) {
    S.tab = tab;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (b) {
      b.setAttribute('aria-current', b.getAttribute('data-tab') === tab ? 'page' : 'false');
    });
    renderChrome();
    if (tab === 'tasks') startTasks(); else stopTasks();
    if (tab === 'pc') { startHealth(); renderPcAssistant(); } else stopHealth();
    if (tab === 'chat') stickToBottom(true);
    updateBadges();
  }

  // ------------------------------------------------------------------------------------------------------------
  // Settings sheet

  var lastFocus = null;
  function openSheet() {
    lastFocus = document.activeElement;
    $('sheet-backdrop').hidden = false;
    $('sheet').hidden = false;
    renderSheetConnection();
    renderReadAloud();
    renderInstall();
    $('sheet-close').focus();
  }
  function closeSheet() {
    $('sheet-backdrop').hidden = true;
    $('sheet').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('menu-btn').addEventListener('click', openSheet);
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('sheet').hidden) closeSheet(); });

  function renderSheetConnection() {
    if ($('sheet').hidden) return;
    setText('c-status', $('conn-pill').textContent);
    setText('c-link', linkLabel());
    setText('c-device', S.device ? S.device.name : '—');
    setText('c-last', S.lastEventAt ? new Date(S.lastEventAt).toLocaleTimeString() : '—');
  }

  $('reconnect-btn').addEventListener('click', function () { closeSheet(); retryNow(); });

  function renderReadAloud() {
    Array.prototype.forEach.call(document.querySelectorAll('#read-aloud button'), function (b) {
      b.setAttribute('aria-checked', b.getAttribute('data-value') === S.readAloud ? 'true' : 'false');
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('#read-aloud button'), function (b) {
    b.addEventListener('click', function () {
      S.readAloud = b.getAttribute('data-value');
      prefSet('readAloud', S.readAloud);
      if (S.readAloud === 'off') stopSpeaking();
      renderReadAloud();
    });
  });

  var installEvent = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvent = e; renderInstall(); });
  window.addEventListener('appinstalled', function () { installEvent = null; renderInstall(); toast('Pandesh is installed.'); });

  function isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function renderInstall() {
    var section = $('install-section');
    var text = $('install-text');
    var btn = $('install-btn');
    if (isStandalone()) { section.hidden = true; return; }
    section.hidden = false;
    btn.hidden = true;
    if (!window.isSecureContext) {
      text.textContent = 'Installing needs the secure link (https, through Tailscale). On this Wi-Fi link you can still add a shortcut from the browser menu.';
    } else if (installEvent) {
      text.textContent = 'Put Pandesh on your home screen. It opens on its own, like an app.';
      btn.hidden = false;
    } else if (/iPhone|iPad/.test(navigator.userAgent)) {
      text.textContent = 'In Safari, tap Share, then Add to Home Screen.';
    } else {
      text.textContent = 'Open the browser menu (⋮), then Install app or Add to Home screen.';
    }
  }
  $('install-btn').addEventListener('click', function () {
    if (!installEvent) return;
    var prompt = installEvent;
    installEvent = null;
    prompt.prompt();
    prompt.userChoice.finally(renderInstall);
  });

  $('unpair-btn').addEventListener('click', function () {
    if (!window.confirm('Unpair this phone? You will need a new code from your PC to use Pandesh here again.')) return;
    api('/api/logout', { method: 'POST', json: {} }).finally(function () { closeSheet(); lostPairing(); setPairMsg('This phone is unpaired.'); });
  });

  // ------------------------------------------------------------------------------------------------------------
  // Toast

  var toastTimer = 0;
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  // ------------------------------------------------------------------------------------------------------------
  // Start

  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* the app works without it */ });
  }
  renderVoice();
  updateHero();
  stopTasks();
  boot();
})();
