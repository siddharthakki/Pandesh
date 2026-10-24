// @vitest-environment jsdom
//
// Regression test: restoreTranscript must render each persisted assistant
// message as its own bubble, not reuse/overwrite a prior turn's bubble
// (that reuse is only correct for live token streaming within one turn).
// Drives the real production markup/script (media/chat.html + chat.js).
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

interface MountedWebview {
  window: JSDOM['window'];
  document: Document;
  posted: PostedMessage[];
  dispatch: (message: Record<string, unknown>) => void;
}

const CHAT_HTML_PATH = resolve(process.cwd(), 'media/chat.html');

// Only chat.js is needed to reproduce and verify this bug — restoreTranscript
// and addAssistantBubble both live there. The other production scripts add
// unrelated behavior (autonomous task panels, sidebar UI, etc.) that this
// test does not exercise.
const PRODUCTION_SCRIPT_FILES = ['chat.js'];

function mountWebview(): MountedWebview {
  const rawHtml = readFileSync(CHAT_HTML_PATH, 'utf8');
  const scripts = PRODUCTION_SCRIPT_FILES.map(file =>
    readFileSync(resolve(process.cwd(), 'media', file), 'utf8'),
  );

  const templated = rawHtml
    .replace(/{{cspSource}}/g, "'self'")
    .replace(/{{nonce}}/g, 'test-nonce')
    .replace(/{{cssUri}}/g, 'chat.css')
    .replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{modelName}}/g, 'test-model');

  const scriptsStart = templated.indexOf('<script nonce="test-nonce">');
  if (scriptsStart === -1) throw new Error('Could not locate chat.html bootstrap script block.');
  const head = templated.slice(0, scriptsStart);

  const inlineScripts = scripts.map(js => `<script nonce="test-nonce">${js}</script>`).join('\n    ');

  const html = `${head}
    <script nonce="test-nonce">
      (() => {
        const acquire = window.acquireVsCodeApi;
        if (typeof acquire !== 'function') {
          throw new Error('VS Code webview API is unavailable.');
        }
        const api = acquire();
        Object.defineProperty(window, '__ollamaAgentVsCodeApi', {
          value: api,
          configurable: false,
          enumerable: false,
          writable: false,
        });
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
    },
  });

  const { window } = dom;
  const document = window.document;

  return {
    window,
    document,
    posted,
    dispatch: message => {
      window.dispatchEvent(new window.MessageEvent('message', { data: message }));
    },
  };
}

describe('restoreTranscript assistant bubble boundaries (real chat.html + real chat.js)', () => {
  it('renders model-escaped assistant Markdown while keeping tool output literal', () => {
    const w = mountWebview();
    w.dispatch({
      type: 'restoreTranscript',
      conversationId: 'default',
      replaceExisting: false,
      messages: [{
        id: 'msg-markdown',
        role: 'assistant',
        content: String.raw`\### Review

\| File \| Role \|
\|---\|---\|
\| pricing.py \| Core logic \|

\- Handles \*currency\* safely`,
        attachments: [],
        citations: [],
        alternatives: [],
      }],
      branch: null,
    });

    const assistant = w.document.querySelector('#messages .bubble.assistant') as HTMLElement | null;
    expect(assistant?.querySelector('h3')?.textContent).toBe('Review');
    expect(assistant?.querySelector('table th')?.textContent).toBe('File');
    expect(assistant?.querySelector('table td')?.textContent).toBe('pricing.py');
    expect(assistant?.querySelector('li em')?.textContent).toBe('currency');
    expect(assistant?.textContent).not.toContain('\\###');
    expect(assistant?.textContent).not.toContain('\\|');
    expect(assistant?.textContent).not.toContain('\\-');

    w.dispatch({ type: 'toolStart', toolName: 'read_file', args: { path: 'pricing.py' } });
    w.dispatch({ type: 'toolResult', toolName: 'read_file', ok: true, result: String.raw`\### literal diagnostic` });
    const toolCard = w.document.querySelector('#messages .tool-card') as HTMLElement | null;
    expect(toolCard?.querySelector('.result-section pre')?.textContent).toContain(String.raw`\###`);
    expect(toolCard?.querySelector('h3')).toBeNull();
  });

  it('renders compact repository-context evidence with file/token counts and selected paths', () => {
    const w = mountWebview();
    w.dispatch({
      type: 'repositoryContextEvidence',
      available: true,
      fileCount: 2,
      estimatedTokens: 3200,
      paths: ['src/ui/AgentPanel.ts', 'src/models/TaskModelSelection.ts'],
    });

    const evidence = w.document.querySelector('#messages .repository-context-evidence') as HTMLElement | null;
    expect(evidence?.textContent).toBe(`Repository context · 2 files · ~${(3200).toLocaleString()} tokens`);
    expect(evidence?.title).toContain('src/ui/AgentPanel.ts');
    expect(evidence?.title).toContain('src/models/TaskModelSelection.ts');
    expect(w.document.querySelectorAll('#messages .bubble.assistant')).toHaveLength(0);
  });

  it('renders two separate completed assistant turns as two distinct .bubble.assistant elements, not one merged bubble', () => {
    const w = mountWebview();

    // Shaped exactly like the `messages` array AgentPanel.restoreConversationTranscript
    // posts: a flat, chronological list of durable user/assistant rows, each
    // already a complete, independent turn (no streaming semantics).
    w.dispatch({
      type: 'restoreTranscript',
      conversationId: 'default',
      replaceExisting: false,
      messages: [
        { id: 'msg-u1', role: 'user', content: 'Explain what this repository contains.', attachments: [], citations: [], alternatives: [] },
        { id: 'msg-u2', role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar', attachments: [], citations: [], alternatives: [] },
        { id: 'msg-u3', role: 'user', content: 'Create note-saath.txt containing Hello from Saath Kar', attachments: [], citations: [], alternatives: [] },
        {
          id: 'msg-a3', role: 'assistant',
          content: 'I\'ve created the file note-saath.txt with the content "Hello from Saath Kar".',
          attachments: [], citations: [], alternatives: [],
        },
        {
          id: 'msg-a4', role: 'assistant',
          content: 'To answer your question about what this repository contains: there is a single file, note-saath.txt.',
          attachments: [], citations: [], alternatives: [],
        },
      ],
      branch: null,
    });

    const assistantBubbles = Array.from(
      w.document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)'),
    ) as HTMLElement[];

    expect(assistantBubbles).toHaveLength(2);
    expect(assistantBubbles[0].dataset.messageId).toBe('msg-a3');
    expect(assistantBubbles[1].dataset.messageId).toBe('msg-a4');

    // Neither bubble's text may contain the other turn's content — this is
    // the exact failure signature from the Guardian evidence: one bubble's
    // textContent held both messages' text run together.
    expect(assistantBubbles[0].textContent).toContain('I\'ve created the file note-saath.txt');
    expect(assistantBubbles[0].textContent).not.toContain('To answer your question');
    expect(assistantBubbles[1].textContent).toContain('To answer your question');
    expect(assistantBubbles[1].textContent).not.toContain('I\'ve created the file note-saath.txt');

    const userBubbles = w.document.querySelectorAll('#messages .bubble.user');
    expect(userBubbles).toHaveLength(3);
  });

  it('still coalesces true live token-by-token streaming into one bubble per turn (the reuse behavior this fix must not break)', () => {
    const w = mountWebview();

    w.dispatch({ type: 'token', delta: 'Hello' });
    w.dispatch({ type: 'token', delta: ' world' });
    w.dispatch({ type: 'done', content: 'Hello world', messageId: 'msg-live', alternatives: [] });

    const assistantBubbles = Array.from(
      w.document.querySelectorAll('#messages .bubble.assistant:not(.kd-task-message)'),
    ) as HTMLElement[];
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0].textContent).toContain('Hello world');
  });
});
