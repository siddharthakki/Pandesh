(function () {
  'use strict';

  // Drag-and-drop and paste for the composer. Presentation + transport only: classification, limits, rejection messages
  // and upload all live on the host (ArtifactInput + the Core attachment pipeline), so a dropped file is judged exactly like
  // one chosen with the attach button.
  //
  //   - URIs dropped from the VS Code explorer / OS      -> { type: 'attachUris', uris }
  //   - file bytes (small) dropped or pasted (screenshots) -> { type: 'attachDropped', files: [{ name, base64 | size }] }
  const MAX_DROPPED_BYTES = 5 * 1024 * 1024;
  const MAX_FILES = 8;
  const api = window.__ollamaAgentVsCodeApi;
  const area = document.querySelector('.input-area') || document.getElementById('input-row');
  const input = document.getElementById('user-input');
  if (!api || !area) return;

  const hasPayload = types => types && (Array.prototype.indexOf.call(types, 'Files') >= 0 || Array.prototype.indexOf.call(types, 'text/uri-list') >= 0);
  const setActive = on => area.classList.toggle('kd-drop-active', on);

  function readAsBase64(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        resolve(result.slice(result.indexOf(',') + 1));
      };
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    });
  }

  async function sendFiles(fileList, fallbackName) {
    const files = Array.prototype.slice.call(fileList || [], 0, MAX_FILES);
    if (files.length === 0) return;
    const payload = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const name = file.name || (fallbackName ? fallbackName + (i ? '-' + (i + 1) : '') + '.png' : 'file');
      // Oversized files are reported by the host with the real size; their bytes never cross the webview boundary.
      if (file.size > MAX_DROPPED_BYTES) payload.push({ name: name, size: file.size });
      else payload.push({ name: name, size: file.size, base64: await readAsBase64(file) });
    }
    api.postMessage({ type: 'attachDropped', files: payload });
  }

  area.addEventListener('dragenter', event => { if (hasPayload(event.dataTransfer && event.dataTransfer.types)) { event.preventDefault(); setActive(true); } });
  area.addEventListener('dragover', event => {
    if (!hasPayload(event.dataTransfer && event.dataTransfer.types)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setActive(true);
  });
  area.addEventListener('dragleave', event => { if (!area.contains(event.relatedTarget)) setActive(false); });
  area.addEventListener('drop', event => {
    const dt = event.dataTransfer;
    if (!dt || !hasPayload(dt.types)) return;
    event.preventDefault();
    setActive(false);
    const uriList = (dt.getData && dt.getData('text/uri-list')) || '';
    const uris = uriList.split(/\r?\n/).map(line => line.trim()).filter(line => line && line.charAt(0) !== '#' && line.indexOf('file:') === 0);
    if (uris.length > 0) { api.postMessage({ type: 'attachUris', uris: uris.slice(0, MAX_FILES) }); return; }
    void sendFiles(dt.files);
  });

  // Pasted screenshots / images.
  if (input) {
    input.addEventListener('paste', event => {
      const items = (event.clipboardData && event.clipboardData.items) || [];
      const files = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && /^image\//.test(items[i].type)) { const file = items[i].getAsFile(); if (file) files.push(file); }
      }
      if (files.length === 0) return;
      event.preventDefault();
      void sendFiles(files, 'pasted-image');
    });
  }

  window.addEventListener('blur', () => setActive(false));
  window.addEventListener('dragend', () => setActive(false));
})();
