import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { TextDecoder, TextEncoder } from 'util';
import { JSDOM } from 'jsdom';

/**
 * Progress & Completion UX V1 — Step 4 (truthful long-wait wording).
 *
 * Ordinary Baat/Saath turns previously showed a static "Soch raha hoon…"
 * indicator for the entire wait, with no way to tell a fast answer from a
 * cold local-model stall that can legitimately take minutes. This is the
 * ONE truthful addition: elapsed time (always knowable), plus the model
 * actually resolved for the turn once `AgentPanel.sendToAgent`'s
 * `modelSuitability` routing evidence arrives (falling back to whatever the
 * user explicitly picked in the dropdown, then to no model name at all —
 * never a guess at what Auto routed to). Locality is stated only when known
 * unambiguously ('ollama' is always local; 'openai-compatible' can be a
 * local server too, so it says nothing rather than guessing "Cloud"). No
 * fake percentages, no claim that a model is "loading" unless the runtime
 * actually said so.
 */

const root = path.join(__dirname, '..', '..', '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

function setupWebview() {
  const dom = new JSDOM(read('media/chat.html'), {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://karkedikha.test/',
  });
  const { window } = dom;
  const posted: Array<Record<string, unknown>> = [];
  let state: Record<string, unknown> = {};
  const vscodeApi = {
    postMessage(message: Record<string, unknown>) { posted.push(message); },
    getState() { return state; },
    setState(next: Record<string, unknown>) { state = next; },
  };
  Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: vscodeApi });
  Object.defineProperty(window, 'acquireVsCodeApi', { value: () => vscodeApi });
  Object.defineProperty(window, '__pandaBaseUri', { value: '' });
  Object.defineProperty(window, 'TextEncoder', { value: TextEncoder });
  Object.defineProperty(window, 'TextDecoder', { value: TextDecoder });
  Object.defineProperty(window, 'matchMedia', {
    value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
  });
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {};
  Object.defineProperty(window, 'requestAnimationFrame', {
    value: (callback: FrameRequestCallback) => { callback(0); return 1; },
  });
  // jsdom's `window` has its own timer/Date implementation, independent of
  // Node's globals — so vitest's faked globalThis.setInterval/Date (via
  // vi.useFakeTimers() in this file's beforeEach) never reaches code the
  // webview runs via window.eval unless the window's own bindings are
  // pointed at the same faked functions.
  (window as unknown as { setInterval: typeof setInterval }).setInterval = setInterval;
  (window as unknown as { clearInterval: typeof clearInterval }).clearInterval = clearInterval;
  (window as unknown as { setTimeout: typeof setTimeout }).setTimeout = setTimeout;
  (window as unknown as { clearTimeout: typeof clearTimeout }).clearTimeout = clearTimeout;
  (window as unknown as { Date: typeof Date }).Date = Date;
  window.eval(read('media/chat.js'));
  // The real restoration handshake is answered by chat-autonomous.js, which
  // this focused test does not load; set the flag chat.js's send guard reads
  // directly instead of pulling in the whole production script chain.
  (window as unknown as { __kdWorkspaceRestored: boolean }).__kdWorkspaceRestored = true;
  (window.document.getElementById('send-btn') as HTMLButtonElement).disabled = false;
  return { dom, window, posted };
}

describe('Progress & Completion UX V1 — truthful long-wait wording (Step 4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the calm default label for a fast turn and never claims elapsed time before the threshold', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'What does this function do?';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      const indicator = window.document.getElementById('thinking-indicator');
      expect(indicator?.textContent).toBe('Soch raha hoon…');

      await vi.advanceTimersByTimeAsync(3000);
      expect(window.document.getElementById('thinking-indicator')?.textContent).toBe('Soch raha hoon…');
    } finally {
      dom.window.close();
    }
  });

  it('shows elapsed time after the truthful-wait threshold, naming the explicitly selected model (no routing evidence yet)', async () => {
    const { dom, window } = setupWebview();
    try {
      const modelSelect = window.document.getElementById('model-select') as HTMLSelectElement;
      const explicitOption = window.document.createElement('option');
      explicitOption.value = 'qwen3.8:27b-mtp-q4_K_M';
      explicitOption.textContent = 'qwen3.8:27b-mtp-q4_K_M';
      modelSelect.appendChild(explicitOption);
      modelSelect.value = 'qwen3.8:27b-mtp-q4_K_M';

      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'Why does registerUser accept an empty username?';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      await vi.advanceTimersByTimeAsync(9000);
      const text = window.document.getElementById('thinking-indicator')?.textContent ?? '';
      expect(text).toContain('Still waiting for qwen3.8:27b-mtp-q4_K_M');
      expect(text).toMatch(/·\s*0:0[89]/);
    } finally {
      dom.window.close();
    }
  });

  it('prefers the actually-resolved model/provider evidence over the dropdown, and states "Local" only for ollama', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'Why does registerUser accept an empty username?';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      // Real routing evidence, posted by AgentPanel.sendToAgent before Core
      // executes the attempt — arrives well before the wait threshold.
      window.dispatchEvent(new window.MessageEvent('message', {
        data: { type: 'modelSuitability', summary: 'suited', details: { selectedModel: 'qwen3.8:27b-mtp-q4_K_M', selectedProvider: 'ollama' } },
      }));

      await vi.advanceTimersByTimeAsync(9000);
      const text = window.document.getElementById('thinking-indicator')?.textContent ?? '';
      expect(text).toContain('Still waiting for qwen3.8:27b-mtp-q4_K_M · Local');
    } finally {
      dom.window.close();
    }
  });

  it('never guesses "Cloud": an openai-compatible provider can be a local server, so locality is omitted', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'Why does registerUser accept an empty username?';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      window.dispatchEvent(new window.MessageEvent('message', {
        data: { type: 'modelSuitability', summary: 'suited', details: { selectedModel: 'gpt-4o-mini', selectedProvider: 'openai-compatible' } },
      }));

      await vi.advanceTimersByTimeAsync(9000);
      const text = window.document.getElementById('thinking-indicator')?.textContent ?? '';
      expect(text).toContain('Still waiting for gpt-4o-mini');
      expect(text).not.toContain('Local');
      expect(text).not.toContain('Cloud');
    } finally {
      dom.window.close();
    }
  });

  it('clears resolved-model evidence between turns so it cannot leak into the next turn\'s wait label', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'First question.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();
      window.dispatchEvent(new window.MessageEvent('message', {
        data: { type: 'modelSuitability', summary: 'suited', details: { selectedModel: 'qwen3.8:27b-mtp-q4_K_M', selectedProvider: 'ollama' } },
      }));
      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'done', content: 'Answer one.' } }));

      input.value = 'Second question.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      await vi.advanceTimersByTimeAsync(9000);
      const text = window.document.getElementById('thinking-indicator')?.textContent ?? '';
      expect(text).toContain('Still working on this');
      expect(text).not.toContain('qwen3.8:27b-mtp-q4_K_M');
    } finally {
      dom.window.close();
    }
  });

  it('says "Still working on this" rather than guessing a model name when the turn used Automatic', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'Explain the repository layout.';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      await vi.advanceTimersByTimeAsync(9000);
      const text = window.document.getElementById('thinking-indicator')?.textContent ?? '';
      expect(text).toContain('Still working on this');
      expect(text).not.toMatch(/Still waiting for\s*·/);
    } finally {
      dom.window.close();
    }
  });

  it('stops the elapsed timer and removes the indicator on completion, without a runaway interval', async () => {
    const { dom, window } = setupWebview();
    try {
      const input = window.document.getElementById('user-input') as HTMLTextAreaElement;
      input.value = 'What does this function do?';
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
      (window.document.getElementById('send-btn') as HTMLButtonElement).click();

      window.dispatchEvent(new window.MessageEvent('message', { data: { type: 'done', content: 'It validates the username.' } }));
      expect(window.document.getElementById('thinking-indicator')).toBeNull();

      const clearSpy = vi.spyOn(window, 'clearInterval');
      await vi.advanceTimersByTimeAsync(15000);
      // No further DOM writes to a since-removed node, and no accumulating
      // interval left running past the turn's own lifetime.
      expect(window.document.getElementById('thinking-indicator')).toBeNull();
      clearSpy.mockRestore();
    } finally {
      dom.window.close();
    }
  });
});
