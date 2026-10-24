// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExecutionProjection } from '../../ui/executionProjection';

/**
 * Webview half of the atomic New Chat contract: one click is enough because (a) hydration that was already in flight
 * is held back from the moment of the click, (b) the host's confirmed reset leaves a genuinely blank conversation, and
 * (c) anything stamped with an older conversation epoch (or belonging to a replaced run) is ignored afterwards.
 */

interface Posted { type: string; [key: string]: unknown }

const SCRIPTS = [
  'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
];

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

function mount() {
  const raw = readFileSync(resolve(process.cwd(), 'media/chat.html'), 'utf8')
    .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
  const start = raw.indexOf('<script nonce="n">');
  const head = raw.slice(0, start);
  const inline = SCRIPTS.map(file => `<script nonce="n">${readFileSync(resolve(process.cwd(), 'media', file), 'utf8')}</script>`).join('\n');
  const html = `${head}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;
  const posted: Posted[] = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: Posted) => { posted.push(m); }, getState: () => ({}), setState: () => undefined });
      (window as unknown as { alert: () => void }).alert = () => undefined;
    },
  });
  open.push(dom);
  const w = dom.window as unknown as Window & { __kdWorkspaceRestored?: boolean };
  w.__kdWorkspaceRestored = true;
  const dispatch = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
  return { dom, document: dom.window.document, posted, dispatch };
}

const TRANSCRIPT = [
  { id: 'u1', role: 'user', content: 'OLD PROMPT FROM THE PREVIOUS CONVERSATION' },
  { id: 'a1', role: 'assistant', content: 'old answer' },
];
const bubbleTexts = (document: Document) => [...document.querySelectorAll('#messages .bubble')].map(n => n.textContent ?? '').join('|');

describe('New Chat in the webview', () => {
  it('shows a restored conversation, and one confirmed New Chat leaves it genuinely blank', () => {
    const { document, dispatch } = mount();
    dispatch({ type: 'restoreTranscript', conversationId: 'default', epoch: 0, messages: TRANSCRIPT });
    expect(bubbleTexts(document)).toContain('OLD PROMPT');
    const input = document.getElementById('user-input') as HTMLTextAreaElement;
    input.value = 'half typed draft';

    (document.getElementById('new-conversation-toolbar-btn') as HTMLButtonElement).click();
    dispatch({ type: 'newConversation', id: 'fresh-1', reset: true, epoch: 1 });

    expect(bubbleTexts(document)).toBe('');
    expect(input.value).toBe('');
    expect(document.querySelectorAll('#messages .kd-dhaaga')).toHaveLength(0);
  });

  it('holds back hydration that was already in flight when the user clicked New Chat', () => {
    const { document, dispatch } = mount();
    (document.getElementById('new-conversation-toolbar-btn') as HTMLButtonElement).click();
    // Late hydration from the previous conversation arrives BEFORE the host confirms the reset ...
    dispatch({ type: 'restoreTranscript', conversationId: 'default', epoch: 0, messages: TRANSCRIPT });
    expect(bubbleTexts(document)).toBe('');
    // ... then the reset is confirmed, and a further late replay AFTER it is ignored too.
    dispatch({ type: 'newConversation', id: 'fresh-1', reset: true, epoch: 1 });
    dispatch({ type: 'restoreTranscript', conversationId: 'default', epoch: 0, messages: TRANSCRIPT });
    dispatch({ type: 'restoreTranscript', conversationId: 'default', messages: TRANSCRIPT, replaceExisting: false });
    expect(bubbleTexts(document)).toBe('');
  });

  it('ignores a stale Dhaaga snapshot / patch for a run of the replaced conversation', () => {
    const { document, dispatch } = mount();
    const p = new ExecutionProjection({ runId: 'run-old', mode: 'saath_kar', request: 'OLD REQUEST' });
    p.repositoryEvidence(['README.md']);
    dispatch({ type: 'dhaaga', op: 'snapshot', state: p.snapshot() });
    expect(document.querySelectorAll('#messages .kd-dhaaga')).toHaveLength(1);

    dispatch({ type: 'newConversation', id: 'fresh-1', reset: true, epoch: 1 });
    expect(document.querySelectorAll('#messages .kd-dhaaga')).toHaveLength(0);

    dispatch({ type: 'dhaaga', op: 'snapshot', state: p.snapshot() }); // late event of the old run
    expect(document.querySelectorAll('#messages .kd-dhaaga')).toHaveLength(0);
    expect((window as unknown as { __kdExecutionState?: unknown }).__kdExecutionState ?? null).toBeNull();
  });

  it('never lets an event stamped with an older epoch repaint the new conversation', () => {
    const { document, dispatch } = mount();
    dispatch({ type: 'newConversation', id: 'fresh-2', reset: true, epoch: 2 });
    dispatch({ type: 'restoreTranscript', epoch: 1, replaceExisting: true, messages: TRANSCRIPT });
    expect(bubbleTexts(document)).toBe('');
  });
});

describe('Dhaaga polish: no empty detail rows', () => {
  const planning = () => {
    const p = new ExecutionProjection({ runId: 'r1', mode: 'saath_kar', request: 'Tell me about governance' });
    p.modelActivity();
    return p.snapshot();
  };

  it('"Soch raha hoon..." stands alone: no redundant "Planning" row and no dash placeholders', () => {
    const { document, dispatch } = mount();
    const state = planning();
    for (const node of state.nodes) node.facts = ['-', '', '—'];
    dispatch({ type: 'dhaaga', op: 'snapshot', state });
    const node = document.querySelector('.kd-dhaaga-item[data-stage="planning"]')!;
    expect(node.querySelector('.kd-dhaaga-title')!.textContent).toBe('Soch raha hoon...');
    const sub = node.querySelector('.kd-dhaaga-sub') as HTMLElement;
    expect(sub.hidden || sub.textContent === '').toBe(true);
    expect(node.querySelectorAll('.kd-dhaaga-facts li')).toHaveLength(0);
    expect((node.querySelector('.kd-dhaaga-facts') as HTMLElement).hidden).toBe(true);
    expect(node.textContent).not.toMatch(/(^|\s)-(\s|$)/);
  });

  it('still renders a meaningful detail', () => {
    const { document, dispatch } = mount();
    const state = planning();
    for (const node of state.nodes) node.facts = ['-', 'Five-stage repository workflow'];
    dispatch({ type: 'dhaaga', op: 'snapshot', state });
    const facts = [...document.querySelectorAll('.kd-dhaaga-item[data-stage="planning"] .kd-dhaaga-facts li')].map(n => n.textContent);
    expect(facts).toEqual(['Five-stage repository workflow']);
  });
});
