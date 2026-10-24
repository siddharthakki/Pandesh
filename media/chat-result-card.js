// Compact TaskResult / artifact card (quiet surface, expandable truth).
// Rendered from the host's evidence-backed TaskResult carried on `autonomousTaskStatus` (Karke Dikha) or `taskResult` (Saath Kar);
// never from model prose.
// Actions carry only (taskId, artifactId); the host resolves the real path itself.
(() => {
  const vscode = window.__ollamaAgentVsCodeApi;
  if (!vscode) return;

  const STATUS = {
    completed: { icon: '✓', label: 'Completed', cls: 'ok' },
    partial: { icon: '!', label: 'Incomplete', cls: 'warn' },
    failed: { icon: '✗', label: 'Failed', cls: 'bad' },
    blocked: { icon: '!', label: 'Blocked', cls: 'warn' },
    cancelled: { icon: '–', label: 'Stopped', cls: 'muted' },
  };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(label, title, onClick) {
    const button = el('button', 'kd-result-btn', label);
    button.type = 'button';
    button.title = title;
    button.addEventListener('click', event => { event.stopPropagation(); onClick(); });
    return button;
  }

  function formatSize(bytes) {
    if (typeof bytes !== 'number') return '';
    return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
  }

  function buildCard(taskId, result) {
    const status = STATUS[result.status] || STATUS.failed;
    const card = el('section', `kd-result-card kd-result-${status.cls}`);
    card.dataset.taskId = taskId;
    card.setAttribute('aria-label', 'Task result');

    const head = el('div', 'kd-result-head');
    head.appendChild(el('span', 'kd-result-status', `${status.icon} ${status.label}`));
    // A structure check (for example the static HTML parse) is shown as exactly that: it is never a test or build pass.
    const structureChecks = (result.evidence || []).filter(e => /^structure check /i.test(e.subject || ''));
    const validation = result.validationStatus === 'passed' ? 'Validation passed'
      : result.validationStatus === 'failed' ? 'Validation failed'
        : structureChecks.length > 0
          ? (structureChecks.every(e => e.ok) ? 'Structure check passed (no test or build run)' : 'Structure check failed')
          : 'No validation recorded';

    head.appendChild(el('span', 'kd-result-validation', validation));
    card.appendChild(head);

    if (result.summary) card.appendChild(el('div', 'kd-result-summary', result.summary));
    for (const warning of result.warnings || []) card.appendChild(el('div', 'kd-result-warning', warning));

    for (const artifact of result.artifacts || []) {
      const row = el('div', 'kd-result-artifact');
      const name = el('span', 'kd-result-name', artifact.title);
      name.title = artifact.path || artifact.title;
      row.appendChild(name);
      if (artifact.path) row.appendChild(el('span', 'kd-result-path', artifact.path + (artifact.sizeBytes !== undefined ? ` · ${formatSize(artifact.sizeBytes)}` : '')));
      if (artifact.path) {
        const send = action => vscode.postMessage({ type: 'taskResultAction', action, taskId, artifactId: artifact.id });
        row.appendChild(actionButton('Open', `Open ${artifact.path}`, () => send('open')));
        if (artifact.type === 'html' || artifact.type === 'svg' || artifact.type === 'markdown') {
          row.appendChild(actionButton('Preview', 'Static preview in a side panel (scripts are not run)', () => send('preview')));
        }
        if (artifact.type === 'html') row.appendChild(actionButton('Open in browser', 'Open this file in your default browser', () => send('openInBrowser')));
        row.appendChild(actionButton('Reveal', 'Reveal in file explorer', () => send('reveal')));
        row.appendChild(actionButton('Copy path', 'Copy the full path', () => send('copyPath')));
      }
      card.appendChild(row);
    }

    const changes = result.changes || { created: [], modified: [], deleted: [] };
    const details = el('details', 'kd-result-details');
    details.appendChild(el('summary', '', 'Details'));
    const lines = [
      `Created: ${changes.created.length}  Modified: ${changes.modified.length}  Deleted: ${changes.deleted.length}`,
      ...(result.commands || []).map(command => `Ran: ${command}`),
      ...(result.validations || []).map(v => `${v.ok ? '✓' : '✗'} ${v.summary}`),
      ...(result.origin && result.origin.model ? [`Model: ${result.origin.model}`] : []),
    ];
    details.appendChild(el('pre', 'kd-result-detail-text', lines.join('\n')));
    card.appendChild(details);
    return card;
  }

  window.addEventListener('message', event => {
    const message = event.data;
    // Karke Dikha carries its result on the task status; Saath Kar posts it once when its turn ends.
    if (!message || (message.type !== 'autonomousTaskStatus' && message.type !== 'taskResult') || !message.taskResult) return;
    const host = document.getElementById('conversational-progress') || document.getElementById('messages');
    if (!host) return;
    const taskId = String(message.taskId || '');
    const next = buildCard(taskId, message.taskResult);
    const previous = Array.from(host.querySelectorAll('.kd-result-card')).find(card => card.dataset.taskId === taskId);
    if (previous) { previous.replaceWith(next); return; }
    // A card re-derived from History sits under the answer it belongs to; a live card goes to the end.
    const anchor = message.afterMessageId
      ? Array.from(host.querySelectorAll('[data-message-id]')).find(node => node.dataset.messageId === String(message.afterMessageId))
      : undefined;
    if (anchor && anchor.parentNode === host) anchor.after(next); else host.appendChild(next);
  });

  window.__kdResultCard = { buildCard };
})();
