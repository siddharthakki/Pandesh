(function () {
  'use strict';

  // Composer decision controls: the model chip (opens the searchable palette) and the supervision chip.
  // The hidden <select id="model-select"> and <select id="autonomy-mode-select"> stay the single source of truth that
  // every other script reads, so these controls only ever write to them and dispatch a normal `change` event.
  // Hands-off is a supervision policy, never a mode: choosing it does not touch the mode selector.
  const Palette = window.KDModelPalette;
  const modelSelect = document.getElementById('model-select');
  const modelChip = document.getElementById('model-chip');
  const modelChipLabel = document.getElementById('model-chip-label');
  const modelChipIcon = document.getElementById('model-chip-icon');
  const supervisionSelect = document.getElementById('autonomy-mode-select');
  const supervisionChip = document.getElementById('supervision-chip');
  const supervisionLabel = document.getElementById('supervision-chip-label');
  const supervisionPopover = document.getElementById('supervision-popover');
  const RECENT_KEY = 'recentModels';
  let models = [];
  // The legacy modelsLoaded handler resets the select to Automatic before this script's listener runs, so the last
  // explicit choice is tracked here from `change` events rather than read back from the select.
  let lastChoice = '';

  function api() { return window.__ollamaAgentVsCodeApi; }
  function readRecent() {
    try {
      const state = api() && api().getState ? api().getState() : null;
      return Array.isArray(state && state[RECENT_KEY]) ? state[RECENT_KEY].filter(k => typeof k === 'string') : [];
    } catch (e) { return []; }
  }
  function writeRecent(keys) {
    try {
      const state = (api() && api().getState && api().getState()) || {};
      api().setState(Object.assign({}, state, { [RECENT_KEY]: keys }));
    } catch (e) { /* state is a convenience */ }
  }

  function selectedKey() { return modelSelect ? modelSelect.value : ''; }
  function findModel(key) { return models.filter(m => m.key === key)[0]; }

  function renderChip() {
    if (!modelChip || !modelChipLabel) return;
    const key = selectedKey();
    const m = key ? findModel(key) : undefined;
    if (!key) {
      modelChipLabel.textContent = 'Auto';
      if (modelChipIcon) modelChipIcon.textContent = '✦';
      modelChip.title = 'Model: Auto — KarkeDikha chooses per task. Click to pick a specific model.';
    } else if (m) {
      modelChipLabel.textContent = m.displayName;
      if (modelChipIcon) modelChipIcon.textContent = m.locality === 'cloud' ? '☁' : '◉';
      modelChip.title = Palette.describe(m);
    } else {
      modelChipLabel.textContent = key;
      if (modelChipIcon) modelChipIcon.textContent = '◉';
      modelChip.title = key + ' (not in the current model list)';
    }
    modelChip.dataset.model = key;
    modelChip.setAttribute('aria-label', 'Model: ' + modelChipLabel.textContent + '. Open model picker.');
  }

  function renderSupervision() {
    if (!supervisionChip || !supervisionLabel || !supervisionSelect) return;
    const handsOff = supervisionSelect.value === 'hands_off';
    supervisionLabel.textContent = handsOff ? 'Hands-off' : 'Ask me';
    supervisionChip.dataset.supervision = handsOff ? 'hands_off' : 'ask';
    supervisionChip.title = handsOff
      ? 'Hands-off — continue automatically within the allowed policy. Governance still applies.'
      : 'Ask me — pause when approval or policy requires.';
    if (supervisionPopover) {
      supervisionPopover.querySelectorAll('[data-supervision]').forEach(option => {
        const on = option.getAttribute('data-supervision') === (handsOff ? 'hands_off' : 'ask');
        option.setAttribute('aria-checked', on ? 'true' : 'false');
        option.classList.toggle('active', on);
      });
    }
  }

  function setSelect(select, value) {
    if (!select) return;
    if (!Array.from(select.options).some(o => o.value === value)) {
      // A model that disappeared from the list must not be silently replaced; show it as an explicit, labelled option.
      const o = document.createElement('option');
      o.value = value;
      o.textContent = value;
      select.appendChild(o);
    }
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  const palette = Palette.createPalette({
    getModels: () => models,
    getSelected: selectedKey,
    getRecent: readRecent,
    onRecent: writeRecent,
    onSelect: key => { setSelect(modelSelect, key); renderChip(); },
    onClose: () => { if (modelChip) modelChip.setAttribute('aria-expanded', 'false'); },
    title: 'Select model',
    autoLabel: 'Auto',
  });

  function openPalette() {
    if (!modelChip) return;
    modelChip.setAttribute('aria-expanded', 'true');
    palette.open();
  }
  modelChip?.addEventListener('click', () => (palette.isOpen() ? palette.close() : openPalette()));
  modelSelect?.addEventListener('change', () => { lastChoice = modelSelect.value; renderChip(); });

  function setSupervisionMenu(open) {
    if (!supervisionPopover || !supervisionChip) return;
    supervisionPopover.hidden = !open;
    supervisionChip.setAttribute('aria-expanded', String(open));
  }
  supervisionChip?.addEventListener('click', event => {
    event.stopPropagation();
    setSupervisionMenu(Boolean(supervisionPopover && supervisionPopover.hidden));
  });
  supervisionPopover?.addEventListener('click', event => {
    const option = event.target && event.target.closest ? event.target.closest('[data-supervision]') : null;
    if (!option || !supervisionSelect) return;
    setSelect(supervisionSelect, option.getAttribute('data-supervision') === 'hands_off' ? 'hands_off' : 'supervised');
    renderSupervision();
    setSupervisionMenu(false);
  });
  document.addEventListener('click', event => {
    if (supervisionPopover && !supervisionPopover.hidden && !supervisionPopover.contains(event.target) && event.target !== supervisionChip) setSupervisionMenu(false);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') setSupervisionMenu(false); });
  supervisionSelect?.addEventListener('change', renderSupervision);

  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.type !== 'modelsLoaded') return;
    const previous = lastChoice;
    models = (Array.isArray(message.models) ? message.models : []).map(Palette.normalize);
    // The legacy handler rebuilds the list and resets to Automatic. A manual pick that is still listed stays selected:
    // a provider refresh must never silently change the user's exact choice.
    if (previous && modelSelect && Array.from(modelSelect.options).some(o => o.value === previous)) {
      modelSelect.value = previous;
      modelSelect.dispatchEvent(new Event('change', { bubbles: true }));
    }
    renderChip();
    palette.refresh();
  });

  renderChip();
  renderSupervision();
  // Test/diagnostic hook: the same object the chip uses.
  window.__kdModelPalette = { open: openPalette, close: () => palette.close(), isOpen: () => palette.isOpen(), models: () => models.slice() };
})();
