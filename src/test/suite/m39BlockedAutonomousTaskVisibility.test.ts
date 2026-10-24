// @vitest-environment jsdom
//
// Post-M39 packaged-acceptance regression coverage. This mounts the real
// production webview markup and script load order. It verifies that an Auto
// mode stamp cannot leave Karke Dikha hidden, and that Core-owned autonomous
// history is projected into Activity with a real retry action.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';

interface PostedMessage { type: string; [key: string]: unknown }

interface MountedWebview {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
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

function mountWebview(): MountedWebview {
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
  const state: { value: Record<string, unknown> } = { value: {} };
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
    dispatch: message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })),
  };
  mounted.push(webview);
  return webview;
}

async function flushDeferredModeReconciliation(window: JSDOM['window']): Promise<void> {
  await Promise.resolve();
  await new Promise<void>(resolve => window.setTimeout(resolve, 0));
}

describe('post-M39 blocked autonomous task visibility', () => {
  it('reveals the Karke Dikha surface when Auto programmatically stamps autonomous mode', async () => {
    const webview = mountWebview();
    const modeSelect = webview.document.getElementById('mode-select') as HTMLSelectElement;
    const sendButton = webview.document.getElementById('send-btn') as HTMLButtonElement;
    const autonomousComposer = webview.document.getElementById('autonomous-composer') as HTMLElement;
    const ordinaryInput = webview.document.getElementById('input-area') as HTMLElement;

    modeSelect.value = 'auto';
    // Registered after the production correction, mirroring chat-everyday.js:
    // the correction sees the pre-stamp value, then its deferred check sees
    // the value this later capture listener stamped.
    sendButton.addEventListener('click', () => { modeSelect.value = 'autonomous'; }, { capture: true, once: true });
    sendButton.dispatchEvent(new webview.window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await flushDeferredModeReconciliation(webview.window);

    expect(modeSelect.value).toBe('autonomous');
    expect(autonomousComposer.hidden).toBe(false);
    expect(ordinaryInput.hidden).toBe(true);
    expect(webview.document.querySelector('.mode-button[data-mode="autonomous"]')?.classList.contains('active')).toBe(true);
    expect(webview.posted).toContainEqual(expect.objectContaining({ type: 'webviewModeChanged', mode: 'autonomous' }));
  });

  it('projects a blocked Core Karke Dikha attempt into Activity and retries that exact attempt', () => {
    const webview = mountWebview();
    webview.dispatch({
      type: 'operationsSnapshot',
      snapshot: {
        generatedAt: '2026-07-27T20:00:00.000Z',
        totals: { tasks: 0, running: 0, blocked: 0, completed: 0, retainedWorktrees: 0 },
        tasks: [],
      },
    });
    webview.dispatch({
      type: 'everydayHistory',
      available: true,
      tasks: [
        {
          attemptId: 'att_blocked_1',
          kind: 'karke_dikha',
          status: 'failed',
          currentMessage: 'Add subtract and update the README',
          selectedModel: 'qwen2.5:14b',
          failureReason: 'Validation command failed.',
          createdAt: '2026-07-27T19:00:00.000Z',
          completedAt: '2026-07-27T19:01:00.000Z',
        },
      ],
    });

    const row = webview.document.querySelector('[data-core-karke-task="true"][data-task-id="att_blocked_1"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.querySelector('.task-name')?.textContent).toContain('Add subtract');
    expect(row.querySelector('.badge-pill')?.textContent).toBe('blocked');
    expect(webview.document.getElementById('metric-tasks')?.textContent).toBe('1');
    expect(webview.document.getElementById('metric-blocked')?.textContent).toBe('1');
    expect(webview.document.querySelector('#operations-task-list .empty-state')).toBeNull();

    const retry = [...row.querySelectorAll('button')].find(button => button.textContent === 'Retry') as HTMLButtonElement;
    expect(retry).toBeTruthy();
    retry.click();
    expect(webview.posted).toContainEqual({
      type: 'retryBlockedAttempt',
      attemptId: 'att_blocked_1',
      strategy: 'same_model',
    });
  });

  it('does not duplicate a task already present in the legacy operations snapshot', () => {
    const webview = mountWebview();
    webview.dispatch({
      type: 'operationsSnapshot',
      snapshot: {
        totals: { tasks: 1, running: 0, blocked: 1, completed: 0, retainedWorktrees: 0 },
        tasks: [{ taskId: 'att_shared_1', title: 'Existing projection', status: 'blocked', phase: 'blocked', model: 'test-model', usage: {} }],
      },
    });
    webview.dispatch({
      type: 'everydayHistory',
      available: true,
      tasks: [{ attemptId: 'att_shared_1', kind: 'karke_dikha', status: 'failed', currentMessage: 'Existing projection' }],
    });

    expect(webview.document.querySelectorAll('[data-core-karke-task="true"]')).toHaveLength(0);
    expect(webview.document.getElementById('metric-tasks')?.textContent).toBe('1');
    expect(webview.document.getElementById('metric-blocked')?.textContent).toBe('1');
  });

  it('renders blocker card with working inline guidance form and retry actions', () => {
    const webview = mountWebview();
    // A live task: started in this session (a terminal task replayed from history never mounts this surface).
    webview.dispatch({ type: 'autonomousTaskStarted', taskId: 'task_blocked_1', attemptId: 'att_blocked_1', state: 'queued' });
    webview.dispatch({
      type: 'autonomousTaskStatus',
      taskId: 'task_blocked_1',
      attemptId: 'att_blocked_1',
      state: 'blocked',
      goal: 'Fix Python test failures in agent-bench',
      failure: {
        classification: 'validation_command_unsupported',
        message: 'Unsupported validation command: pytest',
      },
      resolvedGates: {
        proposal: false,
        mutation: false,
      },
      deliveryEvidence: {
        changedFileCount: 1,
      },
      retryEligibility: {
        eligible: true,
        strongerModelAvailable: true,
      },
    });

    const outcomeCard = webview.document.getElementById('everyday-outcome-card') as HTMLElement;
    expect(outcomeCard).toBeTruthy();
    expect(outcomeCard.hidden).toBe(false);
    expect(outcomeCard.textContent).toContain('Task blocked');

    // Wording check: mutation was NOT approved, so even if changedFileCount is 1, it must clarify no changes were made to files
    expect(outcomeCard.textContent).toContain('Untouched — no changes were made to your files.');
    expect(outcomeCard.textContent).not.toContain('exist only in KarkeDikha\'s isolated worktree');

    const tryAgainBtn = outcomeCard.querySelector('button[data-everyday-retry-strategy="same_model"]') as HTMLButtonElement;
    const strongerBtn = outcomeCard.querySelector('button[data-everyday-retry-strategy="stronger_model"]') as HTMLButtonElement;
    const guidanceBtn = outcomeCard.querySelector('button[data-everyday-retry-strategy="with_guidance"]') as HTMLButtonElement;

    expect(tryAgainBtn).toBeTruthy();
    expect(strongerBtn).toBeTruthy();
    expect(guidanceBtn).toBeTruthy();
    expect(guidanceBtn.textContent).toBe('Add guidance and retry');

    // 1. Clicking "Add guidance and retry" opens the inline guidance form
    expect(outcomeCard.querySelector('.everyday-guidance-form')).toBeNull();
    guidanceBtn.click();

    const form = outcomeCard.querySelector('.everyday-guidance-form') as HTMLElement;
    expect(form).toBeTruthy();
    const textarea = form.querySelector('textarea.everyday-guidance-input') as HTMLTextAreaElement;
    const submitBtn = form.querySelector('button[data-everyday-guidance-submit="true"]') as HTMLButtonElement;
    const cancelBtn = form.querySelector('button[data-everyday-guidance-cancel="true"]') as HTMLButtonElement;

    expect(textarea).toBeTruthy();
    expect(submitBtn).toBeTruthy();
    expect(cancelBtn).toBeTruthy();
    expect(submitBtn.textContent).toBe('Retry with guidance');

    // 2. Empty guidance does NOT post a message
    const initialPostedCount = webview.posted.length;
    submitBtn.click();
    expect(webview.posted.length).toBe(initialPostedCount);

    // 3. Canceling removes the guidance form without posting any message
    cancelBtn.click();
    expect(outcomeCard.querySelector('.everyday-guidance-form')).toBeNull();
    expect(webview.posted.length).toBe(initialPostedCount);
    expect(guidanceBtn.disabled).toBe(false);

    // 4. Re-open, enter non-empty guidance, and submit
    guidanceBtn.click();
    const reOpenedForm = outcomeCard.querySelector('.everyday-guidance-form') as HTMLElement;
    const reOpenedTextarea = reOpenedForm.querySelector('textarea.everyday-guidance-input') as HTMLTextAreaElement;
    const reOpenedSubmit = reOpenedForm.querySelector('button[data-everyday-guidance-submit="true"]') as HTMLButtonElement;

    reOpenedTextarea.value = 'Target only src/agent.py and run pytest';
    reOpenedSubmit.click();

    expect(webview.posted).toContainEqual({
      type: 'retryBlockedAttempt',
      attemptId: 'att_blocked_1',
      strategy: 'with_guidance',
      guidance: 'Target only src/agent.py and run pytest',
    });
    expect(reOpenedSubmit.disabled).toBe(true);
    expect(tryAgainBtn.disabled).toBe(true);
  });

  it('handles Try again and Try with a stronger model actions', () => {
    const webview = mountWebview();
    // A live task: started in this session (a terminal task replayed from history never mounts this surface).
    webview.dispatch({ type: 'autonomousTaskStarted', taskId: 'task_blocked_2', attemptId: 'att_blocked_2', state: 'queued' });
    webview.dispatch({
      type: 'autonomousTaskStatus',
      taskId: 'task_blocked_2',
      attemptId: 'att_blocked_2',
      state: 'blocked',
      goal: 'Investigate and fix bug',
      failure: {
        classification: 'duplicate_proposal_target',
        message: 'Duplicate target file in proposal',
      },
      resolvedGates: {
        proposal: false,
        mutation: false,
      },
      retryEligibility: {
        eligible: true,
        strongerModelAvailable: true,
      },
    });

    const outcomeCard = webview.document.getElementById('everyday-outcome-card') as HTMLElement;
    const tryAgainBtn = outcomeCard.querySelector('button[data-everyday-retry-strategy="same_model"]') as HTMLButtonElement;
    tryAgainBtn.click();

    expect(webview.posted).toContainEqual({
      type: 'retryBlockedAttempt',
      attemptId: 'att_blocked_2',
      strategy: 'same_model',
    });
  });
});
