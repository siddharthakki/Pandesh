// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface MountedWebview {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
  getState: () => Record<string, unknown>;
  setState: (state: Record<string, unknown>) => void;
  dispatch: (message: Record<string, unknown>) => void;
}

const CHAT_HTML_PATH = resolve(process.cwd(), 'media/chat.html');
const PRODUCTION_SCRIPT_FILES = [
  'chat.js',
  'chat-fixes.js',
  'chat-dashboard.js',
  'chat-operations.js',
  'chat-runtime-fixes.js',
  'chat-autonomous.js',
  'chat-sidebar-ui.js',
  'everyday-presentation.js',
  'chat-everyday.js',
];

const mounted: MountedWebview[] = [];

afterEach(() => {
  for (const webview of mounted.splice(0)) webview.window.close();
});

function mountWebview(initialState: Record<string, unknown> = {}): MountedWebview {
  const rawHtml = readFileSync(CHAT_HTML_PATH, 'utf8');
  const scripts = PRODUCTION_SCRIPT_FILES.map(file => readFileSync(resolve(process.cwd(), 'media', file), 'utf8'));
  const templated = rawHtml
    .replace(/{{cspSource}}/g, "'self'")
    .replace(/{{nonce}}/g, 'test-nonce')
    .replace(/{{cssUri}}/g, 'chat.css')
    .replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '')
    .replace(/{{modelName}}/g, 'test-model');

  const scriptsStart = templated.indexOf('<script nonce="test-nonce">');
  if (scriptsStart === -1) throw new Error('Could not locate chat.html bootstrap script block.');
  const head = templated.slice(0, scriptsStart);
  const inlineScripts = scripts.map(js => `<script nonce="test-nonce">${js}</script>`).join('\n    ');

  const html = `${head}
    <script nonce="test-nonce">
      (() => {
        const api = window.acquireVsCodeApi();
        Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api, configurable: false, enumerable: false, writable: false });
        Object.defineProperty(window, '__pandaBaseUri', { value: '', configurable: false, enumerable: false, writable: false });
      })();
    </script>
    ${inlineScripts}
  </body>
  </html>`;

  const posted: PostedMessage[] = [];
  const state: { value: Record<string, unknown> } = { value: { ...initialState } };
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (msg: PostedMessage) => { posted.push(msg); },
        getState: () => state.value,
        setState: (next: Record<string, unknown>) => { state.value = next; },
      });
      (window as unknown as { alert: () => void }).alert = () => undefined;
      (window as unknown as { confirm: () => boolean }).confirm = () => true;
    },
  });

  const webview: MountedWebview = {
    window: dom.window,
    document: dom.window.document,
    posted,
    getState: () => state.value,
    setState: next => { state.value = next; },
    dispatch: message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })),
  };
  mounted.push(webview);
  return webview;
}

describe('KarkeDikha autonomy mode persistence regression tests', () => {
  it('defaults newly created autonomous task to supervised mode', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('supervised');

    const textarea = webview.document.getElementById('autonomous-input') as HTMLTextAreaElement;
    const startBtn = webview.document.getElementById('autonomous-start-btn') as HTMLButtonElement;
    textarea.value = 'Fix the bug';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const startMsg = webview.posted.find(msg => msg.type === 'startAutonomousTask');
    expect(startMsg).toBeTruthy();
    expect(startMsg?.autonomyMode).toBe('supervised');
  });

  it('allows explicit hands_off for that specific task only, then resets to supervised for the next task', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    const textarea = webview.document.getElementById('autonomous-input') as HTMLTextAreaElement;
    const startBtn = webview.document.getElementById('autonomous-start-btn') as HTMLButtonElement;

    // Explicitly select hands_off for this task
    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    // Task 1 submission
    textarea.value = 'First task: hands off requested';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const firstMsg = webview.posted.filter(msg => msg.type === 'startAutonomousTask')[0];
    expect(firstMsg).toBeTruthy();
    expect(firstMsg.autonomyMode).toBe('hands_off');

    // Selector must immediately reset to supervised in DOM and state
    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');

    // Simulate task 1 acknowledged by backend and completed
    webview.dispatch({ type: 'autonomousTaskStarted', taskId: 'task-1', state: 'running' });
    webview.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed' });

    // Task 2 submission without touching selector
    textarea.value = 'Second task: must default to supervised';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const secondMsg = webview.posted.filter(msg => msg.type === 'startAutonomousTask')[1];
    expect(secondMsg).toBeTruthy();
    expect(secondMsg.autonomyMode).toBe('supervised');
  });

  it('auto-routing into Karke Dikha (confirmAutoMutation) never implies hands-off, even if selector was set to hands_off', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    // Simulate selector having hands_off set previously or in hidden state
    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    // Auto mode triggers confirmAutoMutation (e.g. from user confirming mutation in chat)
    webview.window.__ollamaAgentVsCodeApi?.postMessage({
      type: 'confirmAutoMutation',
      text: 'Apply this diff to index.js',
      model: 'test-model',
    });

    const startMsg = webview.posted.find(msg => msg.type === 'startAutonomousTask');
    expect(startMsg).toBeTruthy();
    expect(startMsg?.autonomyMode).toBe('supervised');

    // Selector must be reset to supervised
    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('forwards the active conversation id when the packaged Auto bridge starts Karke Dikha', () => {
    const webview = mountWebview();
    webview.dispatch({ type: 'newConversation', id: 'conv-continuity-live-path' });
    webview.posted.length = 0;

    webview.window.__ollamaAgentVsCodeApi?.postMessage({
      type: 'confirmAutoMutation',
      text: 'Add regression coverage for those two cases.',
      model: 'test-model',
    });

    expect(webview.posted.find(msg => msg.type === 'startAutonomousTask')).toEqual(expect.objectContaining({
      conversationId: 'conv-continuity-live-path',
      text: 'Add regression coverage for those two cases.',
    }));
  });

  it('does not restore hands-off from persisted webview state on reload/restart', () => {
    // Mount webview with persisted lastAutonomyMode: 'hands_off'
    const webview = mountWebview({ lastAutonomyMode: 'hands_off' });
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    // Must default to supervised, ignoring persisted hands_off
    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');

    const textarea = webview.document.getElementById('autonomous-input') as HTMLTextAreaElement;
    const startBtn = webview.document.getElementById('autonomous-start-btn') as HTMLButtonElement;
    textarea.value = 'Task after restart';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const startMsg = webview.posted.find(msg => msg.type === 'startAutonomousTask');
    expect(startMsg).toBeTruthy();
    expect(startMsg?.autonomyMode).toBe('supervised');
  });

  it('resets autonomy mode to supervised when starting a new conversation', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    // Click new conversation button
    const newChatBtn = webview.document.getElementById('new-conversation-toolbar-btn') as HTMLButtonElement;
    expect(newChatBtn).toBeTruthy();
    newChatBtn.click();

    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('resets autonomy mode to supervised when newConversation message is received', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    webview.dispatch({ type: 'newConversation', id: 'conv-new-123' });

    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('resets autonomy mode to supervised when switching conversations', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    webview.dispatch({ type: 'conversationSelected', id: 'conv-other-456' });

    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('resets autonomy mode to supervised when clear button is clicked', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    const clearBtn = webview.document.getElementById('autonomous-clear-btn') as HTMLButtonElement;

    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    clearBtn.click();

    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('resets autonomy mode to supervised when switching mode away from autonomous', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    const modeSelect = webview.document.getElementById('mode-select') as HTMLSelectElement;

    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    modeSelect.value = 'chat';
    modeSelect.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    expect(select.value).toBe('supervised');
    expect(webview.getState().lastAutonomyMode).toBe('supervised');
  });

  it('resets autonomy selector on task completion, failure, block, cancellation, and retry start', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;

    // When autonomousTaskStarted arrives
    select.value = 'hands_off';
    webview.dispatch({ type: 'autonomousTaskStarted', taskId: 'task-1', state: 'running' });
    expect(select.value).toBe('supervised');

    // When autonomousRetryStarted arrives
    select.value = 'hands_off';
    webview.dispatch({ type: 'autonomousRetryStarted', taskId: 'task-1', attemptId: 'att-2' });
    expect(select.value).toBe('supervised');

    // When autonomousTaskStatus terminal arrives
    select.value = 'hands_off';
    webview.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed' });
    expect(select.value).toBe('supervised');

    // When taskCancelled arrives
    select.value = 'hands_off';
    webview.dispatch({ type: 'taskCancelled', taskId: 'task-1' });
    expect(select.value).toBe('supervised');
  });

  it('preserves hands-off on retry/continuation of the same task, while later new task defaults to supervised', () => {
    const webview = mountWebview();
    const select = webview.document.getElementById('autonomy-mode-select') as HTMLSelectElement;
    const textarea = webview.document.getElementById('autonomous-input') as HTMLTextAreaElement;
    const startBtn = webview.document.getElementById('autonomous-start-btn') as HTMLButtonElement;

    // 1. User explicitly sets hands_off for task 1
    select.value = 'hands_off';
    select.dispatchEvent(new webview.window.Event('change', { bubbles: true }));

    textarea.value = 'Task 1: original hands-off task';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const firstMsg = webview.posted.filter(msg => msg.type === 'startAutonomousTask')[0];
    expect(firstMsg).toBeTruthy();
    expect(firstMsg.autonomyMode).toBe('hands_off');

    // Selector immediately reset to supervised
    expect(select.value).toBe('supervised');

    // 2. Task 1 becomes active and blocks
    webview.dispatch({ type: 'autonomousTaskStarted', taskId: 'task-1', state: 'running', autonomyMode: 'hands_off' });
    webview.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'blocked', autonomyMode: 'hands_off' });

    // 3. User retries the blocked task (AgentPanel preserves hands_off on backend)
    webview.dispatch({ type: 'autonomousRetryStarted', taskId: 'task-1', attemptId: 'att-retry-1' });

    // Selector must remain supervised for whatever new task comes next
    expect(select.value).toBe('supervised');

    // Retry completes
    webview.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed', autonomyMode: 'hands_off' });

    // 4. User starts a later new task without touching selector
    textarea.value = 'Task 2: later new task';
    textarea.dispatchEvent(new webview.window.Event('input', { bubbles: true }));
    startBtn.click();

    const laterTaskMsg = webview.posted.filter(msg => msg.type === 'startAutonomousTask')[1];
    expect(laterTaskMsg).toBeTruthy();
    expect(laterTaskMsg.autonomyMode).toBe('supervised');
  });
});
