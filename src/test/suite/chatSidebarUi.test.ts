// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');

/**
 * Loads the real chat-sidebar-ui.js IIFE against a minimal jsdom document
 * carrying just the elements it queries by id, plus a stubbed VS Code
 * webview API. The script is executed directly (not string-matched) so the
 * regression below exercises the actual status-line update logic.
 */
async function mountSidebarUi(): Promise<{ statusText: HTMLElement; postedMessages: unknown[] }> {
  document.body.innerHTML = `
    <select id="mode-select">
      <option value="chat">Baat Kar</option>
      <option value="agent">Saath Kar</option>
      <option value="autonomous">Karke Dikha</option>
    </select>
    <button class="mode-button mode-chat" data-mode="chat" role="radio" aria-checked="false"></button>
    <button class="mode-button mode-agent" data-mode="agent" role="radio" aria-checked="false"></button>
    <button class="mode-button mode-autonomous" data-mode="autonomous" role="radio" aria-checked="false"></button>
    <div id="status-row-text"></div>
    <input id="user-input" />
  `;
  const postedMessages: unknown[] = [];
  (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = {
    postMessage: (msg: unknown) => postedMessages.push(msg),
    getState: () => ({}),
    setState: () => undefined,
  };
  const js = await read('chat-sidebar-ui.js');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(js)();
  return {
    statusText: document.getElementById('status-row-text') as HTMLElement,
    postedMessages,
  };
}

describe('KarkeDikha compact contributed view', () => {
  it('offers all three internal modes as a top-bar segmented control', async () => {
    const html = await read('chat.html');
    for (const [mode, label] of [['chat', 'Baat Kar'], ['agent', 'Saath Kar'], ['autonomous', 'Karke Dikha']]) {
      expect(html).toContain(`data-mode="${mode}"`);
      expect(html).toContain(`title="${label}`);
      expect(html).toContain(`<option value="${mode}">${label}</option>`);
    }
    expect(html).toContain('role="radiogroup"');
    expect(html).not.toContain('id="mode-rail"');
    expect(html).not.toContain('id="modes-collapse-btn"');
  });

  it('keeps the active mode visible and supports arrow-key switching', async () => {
    const js = await read('chat-sidebar-ui.js');
    expect(js).toContain("button.classList.toggle('active', active)");
    expect(js).toContain("['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']");
    expect(js).toContain("button.setAttribute('aria-checked', String(active))");
  });

  it('starts History and Activity drawers closed and opens Activity from UI or command', async () => {
    const [html, js] = await Promise.all([read('chat.html'), read('chat-sidebar-ui.js')]);
    expect(html).toMatch(/id="activity-panel"[^>]*hidden/);
    expect(html).toMatch(/id="history-drawer"[^>]*hidden/);
    expect(html).toContain('aria-controls="activity-panel" aria-expanded="false"');
    expect(js).toContain("message?.type === 'showActivity'");
    expect(js).toContain('openDrawer(activityPanel, activityToggle)');
  });

  it('keeps pinned mode-specific composers and separate chat and agent drafts', async () => {
    const [html, css, js, autonomous] = await Promise.all([
      read('chat.html'), read('chat-layout-fixes.css'), read('chat-sidebar-ui.js'), read('chat-autonomous.js'),
    ]);
    expect(html).toContain('id="input-area"');
    expect(html).toContain('id="autonomous-composer"');
    expect(css).toMatch(/\.input-area[^}]*position:\s*sticky/s);
    expect(js).toContain('`${previous}Draft`');
    expect(js).toContain('`${mode}Draft`');
    expect(autonomous).toContain("mode === 'autonomous'");
    expect(autonomous).toContain("event.key === 'Enter' && (event.ctrlKey || event.metaKey)");
  });

  it('avoids permanent sidebar, telemetry dashboard, and runtime-log surfaces', async () => {
    const [html, css, pkg] = await Promise.all([read('chat.html'), read('chat-layout-fixes.css'), fs.readFile(path.join(__dirname, '../../../package.json'), 'utf8')]);
    expect(css).toContain('overflow-x: hidden');
    expect(css).toContain('@media (max-width: 520px)');
    expect(html).not.toContain('class="bottom-log-stream"');
    expect(html).toMatch(/<details class="runtime-log-details">[\s\S]*id="runtime-log-list"/);
    expect(html.match(/aria-label="System operations"/g) ?? []).toHaveLength(0);
    expect(JSON.parse(pkg).contributes.views['ollama-agent-sidebar']).toHaveLength(1);
  });

  it('renders a delivery-specific approval card without changing proposal or execution approvals', async () => {
    const [html, autonomous, chat] = await Promise.all([read('chat.html'), read('chat-autonomous.js'), read('chat.js')]);
    expect(html).toContain('Delivery approval required');
    expect(html).toContain('Review Changes');
    expect(html).toContain('Approve Delivery');
    expect(html).toContain('Reject Delivery');
    expect(autonomous).toContain("case 'deliveryApprovalRequest'");
    expect(chat).toContain("case 'approvalRequest'");
    expect(chat).toContain('addApprovalCard(msg.id, msg.toolName');
  });

  it('uses one ready handshake and guards missing repository identity', async () => {
    const [sidebar, chat] = await Promise.all([read('chat-sidebar-ui.js'), read('chat.js')]);
    expect(sidebar).toContain("type: 'webviewReady'");
    expect(chat).toContain('const identity = status.identity || {}');
    expect(chat).toContain("identity.branch || 'unknown'");
    expect(chat).toContain("identity.headCommit");
  });

  it('shows plain-language mode permissions and keeps raw profile ids out of the primary status UI', async () => {
    const [html, chat, sidebar] = await Promise.all([read('chat.html'), read('chat.js'), read('chat-sidebar-ui.js')]);
    expect(html).not.toContain('id="permission-status-chip"');
    expect(html).not.toMatch(/oc-label">Governance</);
    expect(html).toContain('id="oc-config-btn"');
    expect(html).toContain('title="Configure KarkeDikha"');
    expect(sidebar).toContain("type: 'openSetupReadiness'");
    expect(html).toMatch(/id="permission-toolbar"[^>]*advanced-permissions/);
    expect(chat).toContain("chat: ['Read only', 'Can inspect this workspace but cannot modify files.']");
    expect(chat).toContain("agent: ['Ask before changes', 'Requests approval before editing files or running mutating commands.']");
    expect(chat).toContain("autonomous: ['Governed', 'Uses isolated worktrees and requires proposal, mutation, and delivery approvals.']");
    expect(chat).toContain('opt.textContent = profile.description');
    expect(sidebar).toContain("statusState.permission = ''");
  });

  it('offers compact Core-backed workbench search, export, branch, and response-alternative controls', async () => {
    const [html, chat] = await Promise.all([read('chat.html'), read('chat.js')]);
    expect(html).toContain('id="workbench-search-input"');
    expect(html).toContain('id="export-markdown-btn"');
    expect(html).toContain('id="export-json-btn"');
    expect(chat).toContain("type: 'searchWorkbench'");
    expect(chat).toContain("type: 'branchFromMessage'");
    expect(chat).toContain("type: 'regenerateMessage'");
    expect(chat).toContain("type: 'selectResponseAlternative'");
    expect(chat).toContain('addAssistantBubble(msg.content, false, msg.messageId, msg.alternatives || [])');
    expect(chat).toContain('transcriptRestored && !msg.replaceExisting');
    expect(chat).toContain('select.disabled = Boolean(alternative.active)');
  });

  it('never relabels the status line with a stale execution mode after the user selects a different one', async () => {
    const { statusText } = await mountSidebarUi();
    const select = document.getElementById('mode-select') as HTMLSelectElement;

    // User is in Saath Kar and submits — its execution announces itself
    // (mirrors chat-runtime-fixes.js's announceExecution on sendMessage).
    (document.querySelector('.mode-agent') as HTMLElement).click();
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'modeExecutionStarted', mode: 'agent', modeLabel: 'Saath Kar' },
    }));
    // The mode is owned by the operator context strip (m50OperatorContextUi.test.ts); this row never restates it.
    expect(statusText.textContent).not.toMatch(/Saath Kar|Karke Dikha|Baat Kar/);

    // User switches to Karke Dikha before that submission resolves.
    (document.querySelector('.mode-autonomous') as HTMLElement).click();
    expect(select.value).toBe('autonomous');

    // The stale Saath Kar submission's failure now arrives (Core was slow to
    // connect, or the request itself failed) — this must not relabel the
    // status line back to Saath Kar, and the selected mode must stay put.
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'modeExecutionStarted', mode: 'agent', modeLabel: 'Saath Kar' },
    }));
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Ollama responded 500' } }));

    expect(select.value).toBe('autonomous');
    expect(statusText.textContent).not.toMatch(/Saath Kar|Karke Dikha|Baat Kar/);

    // And switching back to Saath Kar afterward still works normally.
    (document.querySelector('.mode-agent') as HTMLElement).click();
    expect(select.value).toBe('agent');
  });

  it('preserves advanced profile selection, restores the mode default, and identifies overrides', async () => {
    const [html, chat] = await Promise.all([read('chat.html'), read('chat.js')]);
    expect(html).toContain('for="permission-profile-select">Permission profile</label>');
    expect(chat).toContain("type: 'selectPermissionProfile', profileId: permissionSelect.value");
    expect(chat.match(/type: 'selectPermissionProfile', profileId: 'workspace-read'/g) ?? []).toHaveLength(2);
    expect(chat).toContain("'Custom permissions'");
    expect(html).toContain('id="permission-use-default"');
    expect(html).toContain('Use mode default');
  });
});
