// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import {
  buildOperatorContextMessage,
  describeProvider,
  describeThinking,
  describeWorkspace,
} from '../../ui/operatorContext';

const media = path.join(__dirname, '../../../media');
const read = (name: string) => fs.readFile(path.join(media, name), 'utf8');

/**
 * The live main-agent view is the legacy webview (media/chat.html + chat*.js; `ollama-agent.uiV2Enabled`
 * defaults to false). These tests run the real markup with the real sidebar and operator-context scripts.
 */
async function mount(): Promise<void> {
  const html = await read('chat.html');
  const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)![1].replace(/<script[\s\S]*?<\/script>/g, '');
  document.body.innerHTML = body;
  (window as unknown as { __ollamaAgentVsCodeApi: unknown }).__ollamaAgentVsCodeApi = {
    postMessage: () => undefined,
    getState: () => ({}),
    setState: () => undefined,
  };
  // Production load order (chat.html): operator context first, then the sidebar that feeds it status events.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(await read('chat-operator-context.js'))();
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function(await read('chat-sidebar-ui.js'))();
}

const post = (data: unknown) => window.dispatchEvent(new MessageEvent('message', { data }));
const text = (id: string) => document.getElementById(id)!.textContent;

const hostFacts = {
  type: 'operatorContext',
  workspace: { name: 'ollama-agent', path: 'C:\\Projects\\ollama-agent' },
  provider: 'Local • Ollama',
  thinking: 'Default',
  governance: 'Governed',
};

const routing = {
  policyVersion: 'm50-v1',
  selectionMode: 'auto',
  classificationSource: 'structured',
  toolProtocol: 'native',
  why: ['Compatible with the current task', 'Native tool calling', 'Available locally', 'Relevant qualification evidence (benchmark 9/10 across 3 scenarios)'],
  compatibleCandidateCount: 2,
  empiricalEvidenceUsed: true,
  alternatives: [
    { provider: 'ollama', model: 'routed:27b', rank: 1, behindBecauseOf: null, qualification: 'benchmark 9/10 across 3 scenarios' },
    { provider: 'ollama', model: 'other:14b', rank: 2, behindBecauseOf: 'qualification', qualification: 'no benchmark evidence' },
  ],
};

beforeEach(async () => {
  await mount();
});

describe('M50 operator context strip (legacy webview)', () => {
  it('is persistent markup directly under the header, before the status row', async () => {
    const html = await read('chat.html');
    expect(html.indexOf('id="operator-context"')).toBeGreaterThan(html.indexOf('</header>'));
    expect(html.indexOf('id="operator-context"')).toBeLessThan(html.indexOf('class="status-row"'));
    for (const id of ['oc-workspace', 'oc-mode', 'oc-model', 'oc-thinking', 'oc-provider', 'oc-config-btn', 'oc-status']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The permanent Governance field is gone from the primary header (enforcement is unchanged, it just has no chrome here).
    expect(html).not.toContain('id="permission-status-chip"');
    expect(html).not.toMatch(/oc-label">Governance</);
    // Loaded before the sidebar script so it also receives the sidebar's first status event.
    expect(html).toContain("'chat-operator-context.js', 'chat-sidebar-ui.js'");
  });

  it('shows the workspace name with the full path available immediately', () => {
    post(hostFacts);
    expect(text('oc-workspace')).toBe('ollama-agent');
    const workspace = document.getElementById('oc-workspace')!;
    expect(workspace.title).toBe('C:\\Projects\\ollama-agent');
    expect(workspace.getAttribute('aria-label')).toContain('C:\\Projects\\ollama-agent');
    expect(workspace.tabIndex).toBe(0);
  });

  it('says so, and does not invent a path, when no workspace is open', () => {
    post({ ...hostFacts, workspace: null });
    expect(text('oc-workspace')).toBe('No workspace');
    expect(document.getElementById('oc-workspace')!.title).toBe('No workspace folder is open');
  });

  it('shows the explicit mode and follows mode switching from the mode buttons', () => {
    const click = (mode: string) => (document.querySelector(`.mode-button[data-mode="${mode}"]`) as HTMLButtonElement).click();
    click('chat');
    expect(text('oc-mode')).toBe('Baat Kar');
    click('agent');
    expect(text('oc-mode')).toBe('Saath Kar');
    click('autonomous');
    expect(text('oc-mode')).toBe('Karke Dikha');
  });

  it('Auto shows the EFFECTIVE mode once resolved, never a bare "Auto", and never mixes in governance', () => {
    expect(text('oc-mode')).toBe('Auto → chosen per message');
    post({ type: 'modeExecutionStarted', mode: 'chat', modeLabel: 'Baat Kar' });
    expect(text('oc-mode')).toBe('Auto → Baat Kar');
    post({ type: 'modeExecutionStarted', mode: 'agent', modeLabel: 'Saath Kar' });
    expect(text('oc-mode')).toBe('Auto → Saath Kar');
    // Read/plan sub-modes are only classifier guesses (the host may run them as Baat Kar): not shown as a mode.
    post({ type: 'modeExecutionStarted', mode: 'ask', modeLabel: 'Auto - Read' });
    expect(text('oc-mode')).toBe('Auto → chosen per message');
    // The host's execution projection is the one authority for the current turn's effective mode.
    document.dispatchEvent(new CustomEvent('kd:execution-state', { detail: { runId: 'r1', active: true, mode: 'baat_kar', modeSelector: 'chat', modeLabel: 'Baat Kar', phase: 'running', statusText: 'x' } }));
    expect(text('oc-mode')).toBe('Auto → Baat Kar');
    document.dispatchEvent(new CustomEvent('kd:execution-state', { detail: { runId: 'r1', active: false, mode: 'baat_kar', modeSelector: 'chat', modeLabel: 'Baat Kar', phase: 'completed', statusText: 'x' } }));
    expect(text('oc-mode')).toBe('Auto → Baat Kar');
    // The next turn does not inherit the previous turn's mode before its own projection exists.
    post({ type: 'modeExecutionStarted', mode: 'ask', modeLabel: 'Auto - Read' });
    expect(text('oc-mode')).toBe('Auto → chosen per message');
    post({ type: 'autonomousTaskStarted', taskId: 't1' });
    expect(text('oc-mode')).toBe('Auto → Karke Dikha');
    expect(text('oc-mode')).not.toMatch(/Governed/);
    expect(document.getElementById('permission-status-label')).toBeNull();
  });

  it('an explicit mode is shown as itself and ignores classifier announcements; a new conversation re-opens Auto', () => {
    const click = (mode: string) => (document.querySelector(`.mode-button[data-mode="${mode}"]`) as HTMLButtonElement).click();
    click('agent');
    post({ type: 'modeExecutionStarted', mode: 'chat', modeLabel: 'Baat Kar' });
    expect(text('oc-mode')).toBe('Saath Kar');
    click('auto');
    post({ type: 'modeExecutionStarted', mode: 'chat', modeLabel: 'Baat Kar' });
    expect(text('oc-mode')).toBe('Auto → Baat Kar');
    post({ type: 'newConversation', id: 'c3' });
    expect(text('oc-mode')).toBe('Auto → chosen per message');
    click('chat');
    expect(text('oc-mode')).toBe('Baat Kar');
  });

  it('is the single primary source: the status row no longer restates mode, model or governance', () => {
    const click = (mode: string) => (document.querySelector(`.mode-button[data-mode="${mode}"]`) as HTMLButtonElement).click();
    click('agent');
    post({ type: 'modeExecutionStarted', mode: 'agent', modeLabel: 'Saath Kar' });
    post({ type: 'modelSelected', model: 'routed:27b' });
    const row = text('status-row-text')!;
    expect(row).not.toMatch(/Saath Kar|routed:27b|Governed|Ask before changes/);
    expect(text('oc-mode')).toBe('Saath Kar');
  });

  it('demotes the legacy model badge out of the status row', async () => {
    const css = await read('chat-layout-fixes.css');
    expect(css).toMatch(/\.status-row \.model-badge\s*\{\s*display:\s*none\s*!important/);
  });

  it('the header has no Governance field; one compact Config button opens the existing setup/readiness page', () => {
    expect(document.getElementById('permission-status-chip')).toBeNull();
    const config = document.getElementById('oc-config-btn') as HTMLButtonElement;
    expect(config.title).toBe('Configure KarkeDikha');
    expect(config.getAttribute('aria-label')).toBe('Configure KarkeDikha');
    expect(config.closest('#mode-buttons')).toBeNull();
  });

  it('mode switching never depended on a governance control and still does not', () => {
    (document.querySelector('.mode-button[data-mode="agent"]') as HTMLButtonElement).click();
    expect(text('oc-mode')).toBe('Saath Kar');
    (document.querySelector('.mode-button[data-mode="chat"]') as HTMLButtonElement).click();
    expect(text('oc-mode')).toBe('Baat Kar');
  });

  it('shows the provider and the thinking value the host reports, with no invented levels', () => {
    post(hostFacts);
    expect(text('oc-provider')).toBe('Local • Ollama');
    expect(text('oc-thinking')).toBe('Default');
    post({ ...hostFacts, thinking: 'Not supported' });
    expect(text('oc-thinking')).toBe('Not supported');
    expect(document.getElementById('oc-thinking')!.textContent).not.toMatch(/low|medium|high/i);
  });

  it('AUTO before any task is just Auto; after routing it shows the routed model', () => {
    expect(text('oc-model')).toBe('Auto');
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'routed:27b', selectedProvider: 'ollama', userOverrode: false, routing } });
    expect(text('oc-model')).toBe('Auto → routed:27b');
    expect(document.getElementById('oc-why-btn')!.hidden).toBe(false);
  });

  it('a manual choice shows the chosen model and is not presented as Auto', () => {
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'mine:7b', selectedProvider: 'ollama', userOverrode: true, routing: { ...routing, selectionMode: 'manual', why: ['Your selected model', 'Compatible with the current task'] } } });
    expect(text('oc-model')).toBe('mine:7b');
    expect(text('oc-model')).not.toMatch(/Auto/);
  });

  it('the model dropdown is the manual choice for the next turn; Automatic hands it back to the router', () => {
    const select = document.getElementById('model-select') as HTMLSelectElement;
    select.innerHTML = '<option value="">Automatic</option><option value="picked:8b">picked:8b</option>';
    select.value = 'picked:8b';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('oc-model')).toBe('picked:8b');
    select.value = '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(text('oc-model')).toBe('Auto');
  });

  it('explains AUTO concisely, with detail behind a popover rather than in the strip', () => {
    post(hostFacts);
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'routed:27b', selectedProvider: 'ollama', userOverrode: false, routing } });
    const popover = document.getElementById('oc-why-popover')!;
    expect(popover.hidden).toBe(true);
    expect(document.getElementById('operator-context')!.textContent).not.toContain('Native tool calling');
    (document.getElementById('oc-why-btn') as HTMLButtonElement).click();
    expect(popover.hidden).toBe(false);
    const shown = document.getElementById('oc-why-body')!.textContent!;
    expect(shown).toContain('Auto → routed:27b');
    expect(shown).toContain('• Compatible with the current task');
    expect(shown).toContain('• Relevant qualification evidence (benchmark 9/10 across 3 scenarios)');
    expect(shown).toContain('• other:14b — stronger benchmark evidence ranked higher');
    expect(shown).toContain('C:\\Projects\\ollama-agent');
    expect(shown).toContain('Routing policy m50-v1');
    // never a score table
    expect(shown).not.toMatch(/\b0\.\d{2}\b/);
  });

  it('a new conversation clears the routed model but not a manual choice', () => {
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'routed:27b', selectedProvider: 'ollama', userOverrode: false, routing } });
    post({ type: 'newConversation', id: 'c2' });
    expect(text('oc-model')).toBe('Auto');
    expect(document.getElementById('oc-why-btn')!.hidden).toBe(true);
  });

  it('shows a truthful status that follows real runtime messages', () => {
    expect(text('oc-status')).toBe('Ready');
    (document.querySelector('.mode-button[data-mode="agent"]') as HTMLButtonElement).click();
    post({ type: 'modeExecutionStarted', mode: 'agent', modeLabel: 'Saath Kar' });
    expect(text('oc-status')).toBe('Working with tools');
    expect(document.getElementById('oc-status')!.dataset.state).toBe('working');
    post({ type: 'done' });
    expect(text('oc-status')).toBe('Completed');
    expect(document.getElementById('oc-status')!.dataset.state).toBe('ready');
    post({ type: 'error', message: 'x' });
    expect(document.getElementById('oc-status')!.dataset.state).toBe('blocked');
  });

  it('presents a deterministic host route honestly instead of naming a model that will not run', () => {
    post({ type: 'modelSuitability', summary: 's', details: { selectedModel: 'deterministic', selectedProvider: 'host', userOverrode: false, routing } });
    expect(text('oc-model')).toBe('Auto → no model needed');
  });
});

describe('M50 legacy chip: governance wording is constant', () => {
  it('chat.js no longer writes the mode-specific permission wording into the governance badge', async () => {
    const source = await read('chat.js');
    expect(source).toContain("permissionStatusLabel.textContent = 'Governed'");
    expect(source).not.toContain('permissionStatusLabel.textContent = copy[0]');
  });
});

describe('M50 host-side operator facts', () => {
  it('describes the workspace from its real root', () => {
    expect(describeWorkspace('C:\\Projects\\ollama-agent')).toEqual({ name: 'ollama-agent', path: 'C:\\Projects\\ollama-agent' });
    expect(describeWorkspace('/home/me/proj/')).toEqual({ name: 'proj', path: '/home/me/proj/' });
    expect(describeWorkspace(undefined)).toBeNull();
    expect(describeWorkspace('')).toBeNull();
  });

  it('describes the real provider and whether it is local', () => {
    expect(describeProvider('ollama', 'http://127.0.0.1:11434')).toBe('Local • Ollama');
    expect(describeProvider('ollama', 'http://localhost:11434')).toBe('Local • Ollama');
    expect(describeProvider('ollama')).toBe('Local • Ollama');
    expect(describeProvider('openai', 'https://api.example.com/v1')).toBe('Remote • OpenAI-compatible');
    expect(describeProvider('openai', 'http://localhost:8080/v1')).toBe('Local • OpenAI-compatible');
    expect(describeProvider('other', 'not a url')).toBe('other');
  });

  it('reports only what thinking support is actually known', () => {
    expect(describeThinking({})).toBe('Default');
    expect(describeThinking({ providerCapabilities: ['completion', 'thinking'] })).toBe('Model default');
    expect(describeThinking({ providerCapabilities: ['completion', 'tools'] })).toBe('Not supported');
    expect(describeThinking({ profileDisablesNativeThinking: true, providerCapabilities: ['thinking'] })).toBe('Off');
  });

  it('builds one governed message with governance fixed and mode left to the webview', () => {
    const message = buildOperatorContextMessage({ workspaceRoot: 'C:\\Projects\\ollama-agent', providerType: 'ollama', baseUrl: 'http://127.0.0.1:11434' });
    expect(message).toEqual({
      type: 'operatorContext',
      workspace: { name: 'ollama-agent', path: 'C:\\Projects\\ollama-agent' },
      provider: 'Local • Ollama',
      thinking: 'Default',
      governance: 'Governed',
    });
    expect(Object.keys(message)).not.toContain('mode');
  });
});
