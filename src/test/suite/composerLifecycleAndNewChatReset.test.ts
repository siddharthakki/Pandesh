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
      // Count MutationObserver deliveries and cut a runaway loop off at 500 so a
      // regression fails an assertion instead of freezing the test process.
      const RealObserver = window.MutationObserver;
      (window as unknown as { __moCalls: number }).__moCalls = 0;
      (window as unknown as { MutationObserver: unknown }).MutationObserver = class extends RealObserver {
        constructor(callback: MutationCallback) {
          super((records, observer) => {
            const w = window as unknown as { __moCalls: number };
            w.__moCalls += 1;
            if (w.__moCalls <= 500) callback(records, observer);
          });
        }
      };
      (window as unknown as { alert: () => void }).alert = () => undefined;
      (window as unknown as { confirm: () => boolean }).confirm = () => true;
    },
  });

  const webview: MountedWebview = {
    window: dom.window,
    document: dom.window.document,
    posted,
    getState: () => state.value,
    dispatch: message => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })),
  };
  mounted.push(webview);
  return webview;
}

const el = <T extends HTMLElement = HTMLElement>(w: MountedWebview, id: string): T => w.document.getElementById(id) as T;
const sent = (w: MountedWebview, type: string) => w.posted.filter(m => m.type === type);

function ready(): MountedWebview {
  const w = mountWebview();
  (w.window as unknown as { __kdWorkspaceRestored: boolean }).__kdWorkspaceRestored = true;
  el<HTMLSelectElement>(w, 'mode-select').value = 'agent';
  return w;
}

function type(w: MountedWebview, text: string): void {
  const input = el<HTMLTextAreaElement>(w, 'user-input');
  input.value = text;
  input.dispatchEvent(new w.window.Event('input', { bubbles: true }));
}

function pressEnter(w: MountedWebview): void {
  el(w, 'user-input').dispatchEvent(new w.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
}

function startTask(w: MountedWebview, taskId = 'task-1'): void {
  w.dispatch({ type: 'autonomousTaskStarted', taskId, attemptId: 'attempt-1', state: 'running' });
}

describe('composer lifecycle while work is running', () => {
  it('keeps the composer editable and never sends a second request while a plain turn runs', () => {
    const w = ready();
    type(w, 'Now add a length limit');
    pressEnter(w);
    expect(sent(w, 'sendMessage')).toHaveLength(1);
    w.dispatch({ type: 'toolStart', toolName: 'write_file', args: {} });

    const input = el<HTMLTextAreaElement>(w, 'user-input');
    expect(input.disabled).toBe(false);
    expect(el<HTMLButtonElement>(w, 'attach-btn').disabled).toBe(true);

    type(w, 'and also update the tests');
    const send = el<HTMLButtonElement>(w, 'send-btn');
    expect(send.disabled).toBe(false);
    expect(send.textContent).toBe('Queue next');
    pressEnter(w);
    // Queued, not sent: no second request, no work-panel repaint, not "Steer".
    expect(sent(w, 'sendMessage')).toHaveLength(1);
    expect(sent(w, 'steerTask')).toHaveLength(0);
    expect(input.value).toBe('');
  });

  it('Stop is independent: it never submits or clears the pending draft', () => {
    const w = ready();
    type(w, 'first');
    pressEnter(w);
    type(w, 'draft follow-up');
    el<HTMLButtonElement>(w, 'stop-btn').click();
    expect(sent(w, 'stopGeneration')).toHaveLength(1);
    expect(sent(w, 'sendMessage')).toHaveLength(1);
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('draft follow-up');

    w.dispatch({ type: 'stopped' });
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('draft follow-up');
    expect(el<HTMLButtonElement>(w, 'send-btn').disabled).toBe(false);
  });

  it('routes a send during a live governed task to steering once, and acknowledges truthfully', () => {
    const w = ready();
    startTask(w);
    type(w, 'also handle empty input');
    el<HTMLButtonElement>(w, 'send-btn').click();
    el<HTMLButtonElement>(w, 'send-btn').click();
    pressEnter(w);

    const steers = sent(w, 'steerTask');
    expect(steers).toHaveLength(1);
    expect(steers[0].taskId).toBe('task-1');
    expect(sent(w, 'sendMessage')).toHaveLength(0);
    // Not acknowledged yet: the text must still be there.
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('also handle empty input');

    w.dispatch({ type: 'taskSteered', taskId: 'task-1', messageId: steers[0].messageId });
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('');
    expect(el(w, 'autonomous-timeline').textContent).toContain('queued');
  });

  it('keeps rejected steering text as a draft and frees the slot', () => {
    const w = ready();
    startTask(w);
    type(w, 'update one');
    el<HTMLButtonElement>(w, 'send-btn').click();
    const first = sent(w, 'steerTask')[0];

    w.dispatch({ type: 'taskSteerRejected', taskId: 'task-1', messageId: first.messageId, reason: 'Cannot steer terminal task' });
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('update one');
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(sent(w, 'steerTask')).toHaveLength(2);
  });

  it('terminal race: a steer pending when the task ends stays as an unsent draft', () => {
    const w = ready();
    startTask(w);
    type(w, 'last minute change');
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(sent(w, 'steerTask')).toHaveLength(1);

    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed' });
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('last minute change');
    expect(w.getState().pendingAutonomousSteer ?? null).toBeNull();
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(sent(w, 'steerTask')).toHaveLength(1);
  });
});

describe('bounded next-turn queue (Baat/Saath)', () => {
  const strip = (w: MountedWebview) => el(w, 'next-turn-queue');
  const running = (text = 'first request') => {
    const w = ready();
    type(w, text);
    pressEnter(w);
    return w;
  };

  it('holds at most one queued message and shows it as queued (not steering)', () => {
    const w = running();
    type(w, 'Also make the error clearer.');
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(strip(w).hidden).toBe(false);
    expect(strip(w).textContent).toContain('Queued for next turn');
    expect(strip(w).textContent).toContain('Also make the error clearer.');

    type(w, 'second while queued');
    expect(el<HTMLButtonElement>(w, 'send-btn').disabled).toBe(true);
    el<HTMLButtonElement>(w, 'send-btn').click();
    pressEnter(w);
    expect(strip(w).textContent).toContain('Also make the error clearer.');
    expect(strip(w).textContent).not.toContain('second while queued');
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('second while queued');
    expect(sent(w, 'sendMessage')).toHaveLength(1);
  });

  it('on normal completion the queued text becomes a fresh normal turn, draft preserved', () => {
    const w = running();
    type(w, 'And explain why.');
    el<HTMLButtonElement>(w, 'send-btn').click();
    type(w, 'half typed draft');
    w.dispatch({ type: 'done' });

    const sends = sent(w, 'sendMessage');
    expect(sends).toHaveLength(2);
    expect(sends[1].text).toBe('And explain why.');
    expect(sends[1].conversationId).toBe(sends[0].conversationId);
    expect(strip(w).hidden).toBe(true);
    expect(el<HTMLTextAreaElement>(w, 'user-input').value).toBe('half typed draft');
    // The second turn is itself running, so a further message can queue again.
    expect(el<HTMLButtonElement>(w, 'send-btn').textContent).toBe('Queue next');
  });

  it('on Stop or failure the queued text is kept visible and not auto-sent', () => {
    for (const ending of [{ type: 'stopped' }, { type: 'error', message: 'model failed' }]) {
      const w = running();
      type(w, 'keep me');
      el<HTMLButtonElement>(w, 'send-btn').click();
      w.dispatch(ending);
      expect(sent(w, 'sendMessage')).toHaveLength(1);
      expect(strip(w).hidden).toBe(false);
      expect(strip(w).textContent).toContain('keep me');
      const sendNow = strip(w).querySelector<HTMLButtonElement>('[data-action="send-queued"]');
      expect(sendNow).not.toBeNull();
      sendNow!.click();
      expect(sent(w, 'sendMessage')).toHaveLength(2);
      expect(sent(w, 'sendMessage')[1].text).toBe('keep me');
    }
  });

  it('can be discarded, and New Chat / conversation switch never carry it into another conversation', () => {
    const w = running();
    type(w, 'for conversation A');
    el<HTMLButtonElement>(w, 'send-btn').click();
    strip(w).querySelector<HTMLButtonElement>('[data-action="discard-queued"]')!.click();
    expect(strip(w).hidden).toBe(true);

    for (const boundary of [
      { type: 'newConversation', id: 'conv-B', reset: true },
      { type: 'conversationSelected', id: 'conv-C' },
    ]) {
      const v = running();
      type(v, 'for conversation A');
      el<HTMLButtonElement>(v, 'send-btn').click();
      v.dispatch(boundary);
      v.dispatch({ type: 'done' });
      expect(strip(v).hidden).toBe(true);
      expect(sent(v, 'sendMessage')).toHaveLength(1);
    }
  });
});

describe('a forced mode switch must never swallow the message being sent', () => {
  it('sends a natural bug report that trips the build-intent heuristic (regression: golden workflow 2)', () => {
    const w = mountWebview();
    (w.window as unknown as { __kdWorkspaceRestored: boolean }).__kdWorkspaceRestored = true;
    const prompt = "I added a couple of expenses, but when I reopen the app they're gone. Make them stay.";
    type(w, prompt);
    el<HTMLButtonElement>(w, 'send-btn').click();
    const sends = sent(w, 'sendMessage');
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toBe(prompt);
    expect(w.document.querySelectorAll('#messages .bubble.user')).toHaveLength(1);
  });
});

describe('History/Activity decoration must terminate', () => {
  it('does not re-trigger its own MutationObserver (regression: infinite loop froze the webview once a task had an objective)', async () => {
    const w = ready();
    const list = el(w, 'everyday-history-list');
    list.innerHTML = '<div class="everyday-history-item" data-attempt-id="a1"><div class="everyday-history-request">old</div><div class="everyday-history-body"></div></div>';
    w.dispatch({ type: 'everydayHistory', tasks: [{ attemptId: 'a1', taskId: 'a1', goal: 'Add a way to export my expenses' }] });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(list.querySelector('.everyday-history-request')?.textContent).toBe('Add a way to export my expenses');
    expect((w.window as unknown as { __moCalls: number }).__moCalls).toBeLessThan(20);
  });
});

describe('New Chat is a hard presentation reset', () => {
  it('leaves no task, stage, header, work panel or steering target behind', () => {
    const w = ready();
    startTask(w);
    w.dispatch({ type: 'toolStart', toolName: 'read_file', args: {} });
    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed' });
    w.dispatch({ type: 'toolResult', toolName: 'run_tests', ok: true, result: 'ok' });
    w.dispatch({ type: 'done' });
    const status = el(w, 'autonomous-status');
    const tracker = el(w, 'autonomous-stage-tracker');

    w.dispatch({ type: 'newConversation', id: 'conv-2', reset: true });

    expect(el(w, 'messages').dataset.kdWorkState).toBeUndefined();
    expect(w.document.getElementById('kd-work-state-panel')?.hidden ?? true).toBe(true);
    expect(status.hidden).toBe(true);
    expect(w.document.getElementById('autonomous-current-activity')?.hidden ?? true).toBe(true);
    expect(tracker.querySelectorAll('.is-current, .is-complete')).toHaveLength(0);
    expect(w.getState().pendingAutonomousSteer ?? null).toBeNull();

    // No stale steering target: a send is an ordinary turn, never a steer.
    type(w, 'hello again');
    pressEnter(w);
    expect(sent(w, 'steerTask')).toHaveLength(0);
    expect(sent(w, 'sendMessage')).toHaveLength(1);
  });

  it('drops late events from the previous task/run until the user submits again', () => {
    const w = ready();
    startTask(w);
    const status = el(w, 'autonomous-status');
    w.dispatch({ type: 'newConversation', id: 'conv-2', reset: true });

    w.dispatch({ type: 'toolStart', toolName: 'read_file', args: {} });
    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'running' });
    w.dispatch({ type: 'done' });

    expect(el(w, 'messages').dataset.kdWorkState).toBeUndefined();
    expect(status.hidden).toBe(true);

    type(w, 'fresh question');
    pressEnter(w);
    w.dispatch({ type: 'toolStart', toolName: 'read_file', args: {} });
  });

  it('C/D: a late Completed or stage event from the previous conversation leaves the new chat idle and unchanged', () => {
    const w = ready();
    startTask(w);
    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'investigating' });
    w.dispatch({ type: 'newConversation', id: 'conv-2', reset: true });
    const status = el(w, 'autonomous-status');
    const tracker = el(w, 'autonomous-stage-tracker');
    const snapshot = () => JSON.stringify([
      el(w, 'messages').dataset.kdWorkState ?? null, status?.hidden, tracker?.innerHTML,
      w.document.getElementById('autonomous-current-activity')?.hidden ?? true,
    ]);
    const before = snapshot();

    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'validating' });
    w.dispatch({ type: 'autonomousTaskStatus', taskId: 'task-1', state: 'completed' });
    w.dispatch({ type: 'taskSteered', taskId: 'task-1', messageId: 'steer-A' });
    expect(snapshot()).toBe(before);
    expect(sent(w, 'steerTask')).toHaveLength(0);
  });

  it('A: a steer pending for the old task cannot execute in the new conversation', () => {
    const w = ready();
    startTask(w);
    type(w, 'update for A');
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(sent(w, 'steerTask')).toHaveLength(1);
    w.dispatch({ type: 'newConversation', id: 'conv-2', reset: true });
    w.dispatch({ type: 'taskSteered', taskId: 'task-1', messageId: sent(w, 'steerTask')[0].messageId });
    expect(w.getState().pendingAutonomousSteer ?? null).toBeNull();
    type(w, 'hello in B');
    pressEnter(w);
    expect(sent(w, 'steerTask')).toHaveLength(1); // no second steer
    expect(sent(w, 'sendMessage')).toHaveLength(1);
    expect(sent(w, 'sendMessage')[0].text).toBe('hello in B');
  });

  it('does not treat the startup newConversation echo as a reset', () => {
    const w = ready();
    startTask(w);
    w.dispatch({ type: 'newConversation', id: 'conv-1' });
    type(w, 'still the same live task');
    el<HTMLButtonElement>(w, 'send-btn').click();
    expect(sent(w, 'steerTask')).toHaveLength(1);
  });
});
