/* KarkeDikha model palette.
 *
 * One component for the chat composer chip and the Setup "browse models" view. Plain JS with no dependencies so it loads
 * unchanged in both webviews and in Node tests. The list is virtualised (only visible rows exist in the DOM), so a
 * provider returning thousands of models stays responsive.
 *
 * Search and badge rules mirror core/platform/modelCatalog.ts (searchModels / modelBadges); a parity test keeps them aligned.
 * Presentation only: free/vision/tools labels come from the fields the host sent, UNKNOWN is never shown as FREE, and the
 * value returned to the caller is the exact picker value (`<provider>::<model id>` for cloud, the exact tag for local).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KDModelPalette = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ITEM_HEIGHT = 64;
  var HEADER_HEIGHT = 28;
  var OVERSCAN = 6;
  var FILTERS = ['all', 'local', 'cloud', 'free', 'vision', 'coding', 'tools'];
  var FILTER_LABELS = { all: 'All', local: 'Local', cloud: 'Cloud', free: 'Free', vision: 'Vision', coding: 'Coding', tools: 'Tools' };
  // Mirror of core/platform/modelCatalog.ts modelKindOf: embedding/reranker models are never chat or coding models.
  function kindOf(modelId) {
    var id = String(modelId || '');
    if (/rerank/i.test(id)) return 'reranker';
    if (/(embed|^bge-|[-/]bge-|\be5-|\bgte-|minilm|text-embedding)/i.test(id)) return 'embedding';
    return 'generative';
  }
  var CODING_HINT = /(coder|code|codestral|devstral|deepseek|qwen|gpt-oss|gpt-5|claude|gemini|llama-?3|kimi|glm|minimax|sonnet|opus)/i;

  function humanize(modelId) {
    var base = String(modelId).split('/').pop() || String(modelId);
    return base
      .replace(/[:\-_](free|latest|instruct|cloud)$/i, '')
      .replace(/[-_]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/\b([a-z])/g, function (c) { return c.toUpperCase(); })
      .replace(/\bGpt\b/g, 'GPT')
      .replace(/\bOss\b/g, 'OSS')
      .replace(/(\d)b\b/gi, '$1B');
  }

  /** Accepts a `modelsLoaded` entry ({name,label?,provider?,cloud?,...}) and returns a uniform record. */
  function normalize(entry) {
    var cloud = entry.cloud === true;
    var key = String(entry.name == null ? '' : entry.name);
    var modelId = entry.modelId || key.replace(/^[a-z0-9-]+::/, '');
    var tri = function (v) { return v === true ? true : v === false ? false : 'unknown'; };
    var rec = {
      key: key,
      provider: cloud ? String(entry.provider || 'cloud') : 'local',
      providerName: entry.providerName || (cloud ? String(entry.provider || 'Cloud') : 'Ollama'),
      modelId: modelId,
      displayName: entry.displayName || humanize(modelId),
      locality: cloud ? 'cloud' : 'local',
      freeness: cloud ? (entry.freeness || 'unknown') : 'free',
      vision: tri(entry.vision),
      tools: tri(entry.tools),
      kind: kindOf(modelId),
      coding: kindOf(modelId) !== 'generative' ? false : (entry.coding === true || entry.coding === false ? entry.coding : (CODING_HINT.test(modelId) ? true : 'unknown')),
      contextWindow: typeof entry.contextWindow === 'number' ? entry.contextWindow : undefined,
      aliases: Array.isArray(entry.aliases) ? entry.aliases : []
    };
    rec.badges = badgesFor(rec);
    return rec;
  }

  function badgesFor(m) {
    var b = [m.locality === 'local' ? 'LOCAL' : 'CLOUD'];
    if (m.freeness === 'free') b.push('FREE');
    else if (m.freeness === 'paid') b.push('PAID');
    else if (m.freeness === 'trial') b.push('TRIAL');
    else if (m.freeness === 'promotional') b.push('PROMO');
    if (m.kind === 'embedding') b.push('EMBEDDING');
    else if (m.kind === 'reranker') b.push('RERANKER');
    else {
      if (m.vision === true) b.push('VISION');
      if (m.tools === true) b.push('TOOLS');
      if (m.coding === true) b.push('CODING');
    }
    return b;
  }

  function matchesFilter(m, f) {
    switch (f) {
      case 'local': return m.locality === 'local';
      case 'cloud': return m.locality === 'cloud';
      case 'free': return m.freeness === 'free';
      case 'vision': return m.kind === 'generative' && m.vision === true;
      case 'coding': return m.kind === 'generative' && m.coding === true;
      case 'tools': return m.kind === 'generative' && m.tools === true;
      default: return true;
    }
  }

  function haystack(m) {
    return [m.modelId, m.displayName, m.provider, m.providerName].concat(m.aliases, m.badges, [m.freeness === 'free' ? 'free' : '', m.locality]).join(' ').toLowerCase();
  }

  /** Every query token must match (AND). Same ranking as core/platform/modelCatalog.ts searchModels. */
  function search(models, query) {
    query = query || {};
    var tokens = String(query.text || '').toLowerCase().split(/\s+/).filter(Boolean);
    var filters = (query.filters || []).filter(function (f) { return f !== 'all'; });
    var recent = {};
    (query.recent || []).forEach(function (key, i) { recent[key] = i; });
    var scored = [];
    for (var i = 0; i < models.length; i++) {
      var m = models[i];
      var pass = true;
      for (var f = 0; f < filters.length; f++) if (!matchesFilter(m, filters[f])) { pass = false; break; }
      if (!pass) continue;
      var score = 0;
      if (tokens.length) {
        var hay = haystack(m);
        var all = true;
        for (var t = 0; t < tokens.length; t++) if (hay.indexOf(tokens[t]) < 0) { all = false; break; }
        if (!all) continue;
        var id = m.modelId.toLowerCase();
        var name = m.displayName.toLowerCase();
        for (var k = 0; k < tokens.length; k++) {
          var tok = tokens[k];
          if (id === tok || name === tok) score += 50;
          else if (id.indexOf(tok) === 0 || name.indexOf(tok) === 0) score += 20;
          else if (id.indexOf(tok) >= 0 || name.indexOf(tok) >= 0) score += 8;
        }
      }
      if (Object.prototype.hasOwnProperty.call(recent, m.key)) score += 30 - Math.min(recent[m.key], 25);
      scored.push({ m: m, s: score });
    }
    scored.sort(function (a, b) {
      return (b.s - a.s)
        || (a.m.locality === b.m.locality ? 0 : a.m.locality === 'local' ? -1 : 1)
        || a.m.providerName.localeCompare(b.m.providerName)
        || a.m.displayName.localeCompare(b.m.displayName);
    });
    var out = scored.map(function (e) { return e.m; });
    return query.limit ? out.slice(0, query.limit) : out;
  }

  function recommended(models, count) {
    var rank = function (m) { return (m.freeness === 'free' ? 4 : 0) + (m.tools === true ? 3 : 0) + (m.coding === true ? 2 : 0) + (m.vision === true ? 1 : 0) + Math.min(2, (m.contextWindow || 0) / 100000); };
    return models.filter(function (m) { return m.kind === 'generative' && m.freeness === 'free' && m.locality === 'cloud'; })
      .sort(function (a, b) { return (rank(b) - rank(a)) || a.displayName.localeCompare(b.displayName); })
      .slice(0, count || 4);
  }

  function formatContext(tokens) {
    if (!tokens) return '';
    return tokens >= 1024 && tokens % 1024 === 0 ? (tokens / 1024) + 'K' : String(tokens);
  }

  /** Plain-text description for tooltips / aria: exact id, provider, locality, price class, known capabilities. */
  function describe(m) {
    var parts = [m.modelId, m.providerName + (m.locality === 'cloud' ? ' (cloud)' : ' (local)')];
    parts.push(m.freeness === 'free' ? 'free' : m.freeness === 'unknown' ? 'price unknown' : m.freeness);
    if (m.contextWindow) parts.push('context ' + formatContext(m.contextWindow));
    if (m.tools === true) parts.push('tools');
    if (m.vision === true) parts.push('vision');
    return parts.join(' · ');
  }

  /** Builds the flat row list (headers + items) the virtual scroller renders. */
  function buildRows(models, state) {
    var rows = [];
    var searching = state.text.trim().length > 0 || state.filters.some(function (f) { return f !== 'all'; });
    if (!searching) {
      rows.push({ type: 'item', auto: true, key: '' });
      var recentModels = state.recent.map(function (key) { return models.filter(function (m) { return m.key === key; })[0]; }).filter(Boolean).slice(0, 4);
      if (recentModels.length) {
        rows.push({ type: 'header', label: 'Recent' });
        recentModels.forEach(function (m) { rows.push({ type: 'item', m: m, key: m.key, section: 'recent' }); });
      }
      var rec = recommended(models, 4);
      if (rec.length) {
        rows.push({ type: 'header', label: 'Recommended — free' });
        rec.forEach(function (m) { rows.push({ type: 'item', m: m, key: m.key, section: 'recommended' }); });
      }
    }
    var results = search(models, { text: state.text, filters: state.filters, recent: searching ? state.recent : [] });
    if (searching) {
      rows.push({ type: 'header', label: results.length + (results.length === 1 ? ' match' : ' matches') });
    }
    var groups = {};
    var order = [];
    results.forEach(function (m) {
      var g = m.locality === 'local' ? 'Ollama — local' : m.providerName + ' — cloud';
      if (!groups[g]) { groups[g] = []; order.push(g); }
      groups[g].push(m);
    });
    order.sort(function (a, b) {
      var al = /— local$/.test(a), bl = /— local$/.test(b);
      return al === bl ? a.localeCompare(b) : al ? -1 : 1;
    });
    order.forEach(function (g) {
      rows.push({ type: 'header', label: g + ' (' + groups[g].length + ')' });
      groups[g].forEach(function (m) { rows.push({ type: 'item', m: m, key: m.key, section: 'group' }); });
    });
    if (results.length === 0) rows.push({ type: 'empty', label: 'No models match.' });
    return { rows: rows, resultCount: results.length };
  }

  function layout(rows) {
    var offsets = new Array(rows.length);
    var y = 0;
    for (var i = 0; i < rows.length; i++) {
      offsets[i] = y;
      y += rows[i].type === 'item' ? ITEM_HEIGHT : HEADER_HEIGHT;
    }
    return { offsets: offsets, total: y };
  }

  function firstVisible(offsets, scrollTop) {
    var lo = 0, hi = offsets.length - 1, ans = 0;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (offsets[mid] <= scrollTop) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  /**
   * options: {
   *   document, getModels(): normalized records, getSelected(): picker value ('' = Auto), onSelect(key),
   *   getRecent(): keys, onRecent(keys), onClose(), title?, autoLabel?, readOnly?
   * }
   */
  function createPalette(options) {
    var doc = options.document || document;
    var state = { text: '', filters: ['all'], active: 0, open: false, recent: [] };
    var dom = {};
    var data = { models: [], rows: [], lay: { offsets: [], total: 0 }, resultCount: 0 };
    var lastFocus = null;

    function el(tag, className, text) {
      var node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function itemIndexes() {
      var idx = [];
      data.rows.forEach(function (r, i) { if (r.type === 'item') idx.push(i); });
      return idx;
    }

    function recompute(keepActive) {
      var previousKey = keepActive && data.rows[state.active] ? data.rows[state.active].key : undefined;
      var built = buildRows(data.models, state);
      data.rows = built.rows;
      data.resultCount = built.resultCount;
      data.lay = layout(built.rows);
      var items = itemIndexes();
      var selected = options.getSelected ? options.getSelected() : '';
      var target = -1;
      if (previousKey !== undefined) target = items.filter(function (i) { return data.rows[i].key === previousKey; })[0];
      if (target === undefined || target < 0) {
        target = items.filter(function (i) { return data.rows[i].key === selected; })[0];
      }
      state.active = target !== undefined && target >= 0 ? target : (items[0] != null ? items[0] : 0);
      dom.spacer.style.height = data.lay.total + 'px';
      dom.count.textContent = data.resultCount + ' of ' + data.models.length + ' models';
      renderWindow();
    }

    function renderRow(r, i) {
      var top = data.lay.offsets[i];
      if (r.type === 'header') {
        var h = el('div', 'kd-pal-header', r.label);
        h.setAttribute('role', 'presentation');
        h.style.cssText = 'position:absolute;left:0;right:0;top:' + top + 'px;height:' + HEADER_HEIGHT + 'px';
        return h;
      }
      if (r.type === 'empty') {
        var e = el('div', 'kd-pal-empty', r.label);
        e.style.cssText = 'position:absolute;left:0;right:0;top:' + top + 'px;height:' + HEADER_HEIGHT + 'px';
        return e;
      }
      var selected = options.getSelected ? options.getSelected() : '';
      var row = el('div', 'kd-pal-row' + (i === state.active ? ' active' : '') + (r.key === selected ? ' selected' : ''));
      row.setAttribute('role', 'option');
      row.setAttribute('id', 'kd-pal-opt-' + i);
      row.setAttribute('aria-selected', r.key === selected ? 'true' : 'false');
      if (r.m && r.m.kind && r.m.kind !== 'generative') {
        row.setAttribute('aria-disabled', 'true');
        row.title = (r.m.kind === 'embedding' ? 'Embedding model' : 'Reranker model') + ' — not a chat or coding model, so it cannot be selected for tasks';
      }
      row.setAttribute('data-key', r.key);
      row.setAttribute('data-index', String(i));
      row.style.cssText = 'position:absolute;left:0;right:0;top:' + top + 'px;height:' + ITEM_HEIGHT + 'px';
      if (r.auto) {
        row.title = 'KarkeDikha chooses the model for each task';
        row.appendChild(el('div', 'kd-pal-primary', options.autoLabel || 'Auto'));
        row.appendChild(el('div', 'kd-pal-secondary', 'KarkeDikha chooses the model for each task'));
        var autoBadges = el('div', 'kd-pal-meta');
        autoBadges.appendChild(el('span', 'kd-badge b-auto', 'AUTO'));
        row.appendChild(autoBadges);
      } else {
        var m = r.m;
        row.title = describe(m);
        row.appendChild(el('div', 'kd-pal-primary', m.displayName));
        row.appendChild(el('div', 'kd-pal-secondary', m.modelId));
        var meta = el('div', 'kd-pal-meta');
        meta.appendChild(el('span', 'kd-pal-provider', m.providerName));
        m.badges.forEach(function (b) { meta.appendChild(el('span', 'kd-badge b-' + b.toLowerCase(), b)); });
        if (m.contextWindow) meta.appendChild(el('span', 'kd-pal-ctx', formatContext(m.contextWindow)));
        row.appendChild(meta);
      }
      if (r.key === selected) row.appendChild(el('span', 'kd-pal-check', '✓'));
      return row;
    }

    function renderWindow() {
      if (!dom.list) return;
      var top = dom.list.scrollTop;
      var height = dom.list.clientHeight || 420;
      var start = Math.max(0, firstVisible(data.lay.offsets, top) - OVERSCAN);
      var end = start;
      while (end < data.rows.length && data.lay.offsets[end] < top + height + OVERSCAN * ITEM_HEIGHT) end++;
      end = Math.min(data.rows.length, end + 1);
      dom.rows.textContent = '';
      for (var i = start; i < end; i++) dom.rows.appendChild(renderRow(data.rows[i], i));
      dom.list.setAttribute('aria-activedescendant', data.rows[state.active] && data.rows[state.active].type === 'item' ? 'kd-pal-opt-' + state.active : '');
      dom.rendered = end - start;
    }

    function ensureVisible(index) {
      var top = data.lay.offsets[index];
      var bottom = top + ITEM_HEIGHT;
      var height = dom.list.clientHeight || 420;
      if (top < dom.list.scrollTop) dom.list.scrollTop = top - HEADER_HEIGHT;
      else if (bottom > dom.list.scrollTop + height) dom.list.scrollTop = bottom - height;
    }

    function move(delta, absolute) {
      var items = itemIndexes();
      if (!items.length) return;
      var pos = Math.max(0, items.indexOf(state.active));
      var next = absolute === 'start' ? 0 : absolute === 'end' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, pos + delta));
      state.active = items[next];
      ensureVisible(state.active);
      renderWindow();
    }

    function choose(index) {
      var r = data.rows[index];
      if (!r || r.type !== 'item') return;
      if (options.readOnly) return;
      if (r.m && r.m.kind && r.m.kind !== 'generative') return;
      if (r.key) {
        var recent = [r.key].concat((options.getRecent ? options.getRecent() : state.recent).filter(function (k) { return k !== r.key; })).slice(0, 12);
        state.recent = recent;
        if (options.onRecent) options.onRecent(recent);
      }
      options.onSelect(r.key);
      close();
    }

    function onKeydown(ev) {
      switch (ev.key) {
        case 'ArrowDown': ev.preventDefault(); move(1); break;
        case 'ArrowUp': ev.preventDefault(); move(-1); break;
        case 'PageDown': ev.preventDefault(); move(8); break;
        case 'PageUp': ev.preventDefault(); move(-8); break;
        case 'Home': if (ev.target === dom.input && dom.input.value) return; ev.preventDefault(); move(0, 'start'); break;
        case 'End': if (ev.target === dom.input && dom.input.value) return; ev.preventDefault(); move(0, 'end'); break;
        case 'Enter': ev.preventDefault(); choose(state.active); break;
        case 'Escape': ev.preventDefault(); ev.stopPropagation(); close(); break;
        case 'Tab': {
          var focusables = [dom.input].concat(dom.chips);
          var idx = focusables.indexOf(doc.activeElement);
          ev.preventDefault();
          var nxt = ev.shiftKey ? (idx <= 0 ? focusables.length - 1 : idx - 1) : (idx + 1) % focusables.length;
          focusables[nxt].focus();
          break;
        }
        default: break;
      }
    }

    function syncChips() {
      dom.chips.forEach(function (chip) {
        var f = chip.getAttribute('data-filter');
        chip.setAttribute('aria-pressed', state.filters.indexOf(f) >= 0 ? 'true' : 'false');
        chip.className = 'kd-chip' + (state.filters.indexOf(f) >= 0 ? ' on' : '');
      });
    }

    function build() {
      dom.overlay = el('div', 'kd-pal-overlay');
      dom.overlay.addEventListener('mousedown', function (ev) { if (ev.target === dom.overlay) close(); });
      dom.dialog = el('div', 'kd-palette');
      dom.dialog.setAttribute('role', 'dialog');
      dom.dialog.setAttribute('aria-modal', 'true');
      dom.dialog.setAttribute('aria-label', options.title || 'Select model');
      dom.dialog.addEventListener('keydown', onKeydown);
      var head = el('div', 'kd-pal-head');
      head.appendChild(el('div', 'kd-pal-title', options.title || 'Select model'));
      var closeBtn = el('button', 'kd-pal-close', '✕');
      closeBtn.type = 'button';
      closeBtn.setAttribute('aria-label', 'Close model picker');
      closeBtn.addEventListener('click', close);
      head.appendChild(closeBtn);
      dom.dialog.appendChild(head);
      dom.input = el('input', 'kd-pal-search');
      dom.input.type = 'search';
      dom.input.placeholder = 'Search models, providers, capabilities…';
      dom.input.setAttribute('aria-label', 'Search models');
      dom.input.setAttribute('role', 'combobox');
      dom.input.setAttribute('aria-controls', 'kd-pal-list');
      dom.input.setAttribute('autocomplete', 'off');
      dom.input.addEventListener('input', function () { state.text = dom.input.value; dom.list.scrollTop = 0; recompute(false); });
      dom.dialog.appendChild(dom.input);
      var chipRow = el('div', 'kd-pal-filters');
      chipRow.setAttribute('role', 'group');
      chipRow.setAttribute('aria-label', 'Filter models');
      dom.chips = FILTERS.map(function (f) {
        var chip = el('button', 'kd-chip', FILTER_LABELS[f]);
        chip.type = 'button';
        chip.setAttribute('data-filter', f);
        chip.addEventListener('click', function () {
          if (f === 'all') state.filters = ['all'];
          else {
            var set = state.filters.filter(function (x) { return x !== 'all' && x !== f; });
            if (state.filters.indexOf(f) < 0) set.push(f);
            state.filters = set.length ? set : ['all'];
          }
          syncChips();
          dom.list.scrollTop = 0;
          recompute(false);
        });
        chipRow.appendChild(chip);
        return chip;
      });
      dom.dialog.appendChild(chipRow);
      dom.list = el('div', 'kd-pal-list');
      dom.list.id = 'kd-pal-list';
      dom.list.setAttribute('role', 'listbox');
      dom.list.setAttribute('aria-label', 'Models');
      dom.list.tabIndex = -1;
      dom.spacer = el('div', 'kd-pal-spacer');
      dom.spacer.style.position = 'relative';
      dom.rows = el('div', 'kd-pal-rows');
      dom.spacer.appendChild(dom.rows);
      dom.list.appendChild(dom.spacer);
      dom.list.addEventListener('scroll', renderWindow);
      dom.list.addEventListener('click', function (ev) {
        var node = ev.target && ev.target.closest ? ev.target.closest('.kd-pal-row') : null;
        if (node) choose(Number(node.getAttribute('data-index')));
      });
      dom.list.addEventListener('mousemove', function (ev) {
        var node = ev.target && ev.target.closest ? ev.target.closest('.kd-pal-row') : null;
        if (node && Number(node.getAttribute('data-index')) !== state.active) { state.active = Number(node.getAttribute('data-index')); renderWindow(); }
      });
      dom.dialog.appendChild(dom.list);
      var foot = el('div', 'kd-pal-foot');
      dom.count = el('span', 'kd-pal-count', '');
      foot.appendChild(dom.count);
      foot.appendChild(el('span', 'kd-pal-hint', options.readOnly ? 'Esc to close' : '↑↓ navigate · Enter select · Esc close'));
      dom.dialog.appendChild(foot);
      dom.overlay.appendChild(dom.dialog);
      syncChips();
    }

    function open(init) {
      if (state.open) return;
      if (!dom.overlay) build();
      data.models = options.getModels();
      state.recent = options.getRecent ? options.getRecent().slice() : [];
      // Optional starting query (Setup's search box and filter chips open the palette already narrowed).
      state.text = init && typeof init.text === 'string' ? init.text : '';
      state.filters = init && typeof init.filter === 'string' && FILTERS.indexOf(init.filter) > 0 ? [init.filter] : ['all'];
      dom.input.value = state.text;
      syncChips();
      lastFocus = doc.activeElement;
      (options.mount || doc.body).appendChild(dom.overlay);
      state.open = true;
      dom.list.scrollTop = 0;
      recompute(false);
      ensureVisible(state.active);
      renderWindow();
      dom.input.focus();
    }

    function close() {
      if (!state.open) return;
      state.open = false;
      if (dom.overlay && dom.overlay.parentNode) dom.overlay.parentNode.removeChild(dom.overlay);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (e) { /* ignore */ } }
      if (options.onClose) options.onClose();
    }

    return {
      open: open,
      close: close,
      isOpen: function () { return state.open; },
      /** Test/debug access. */
      _state: state,
      _dom: dom,
      _data: data,
      refresh: function () { if (state.open) { data.models = options.getModels(); recompute(true); } }
    };
  }

  return {
    ITEM_HEIGHT: ITEM_HEIGHT,
    HEADER_HEIGHT: HEADER_HEIGHT,
    FILTERS: FILTERS,
    humanize: humanize,
    normalize: normalize,
    badgesFor: badgesFor,
    search: search,
    recommended: recommended,
    describe: describe,
    buildRows: buildRows,
    createPalette: createPalette
  };
});
