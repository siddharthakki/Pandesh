// @vitest-environment jsdom
import { JSDOM } from 'jsdom';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { fakeContext, fakeCoreClient, fakeCoreManager, withFakeConversationWorkingState, waitForCalls, type PostedMessage } from '../golden/goldenJourneyHarness';

const dependencyMocks = vi.hoisted(() => ({ getCoreManager: vi.fn(), createProvider: vi.fn() }));
vi.mock('../../extension', () => ({ getCoreManager: dependencyMocks.getCoreManager }));
vi.mock('../../providers/ProviderGateway', () => ({ ProviderGateway: { create: dependencyMocks.createProvider } }));

const SCRIPTS = [
  'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
  'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
];
const REQUEST = 'Create three new files under uat-m51-multifile/: one.txt, two.txt, and three.txt. Put ONE, TWO, and THREE in them respectively. Treat each file as a separate required change. Do not declare the task complete until all three files exist with the exact contents and you have verified them.';

const open: JSDOM[] = [];
afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

/** The real legacy webview (media/*.js, the one the product ships) wired to the real host; only Core is faked. */
function mountProduct(root: string) {
  const raw = readFileSync(resolve(process.cwd(), 'media/chat.html'), 'utf8')
    .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
    .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
  const start = raw.indexOf('<script nonce="n">');
  const inline = SCRIPTS.map(file => `<script nonce="n">${readFileSync(resolve(process.cwd(), 'media', file), 'utf8')}</script>`).join('\n');
  const html = `${raw.slice(0, start)}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;

  const posted: PostedMessage[] = [];
  const fromWebview: Array<{ type: string; [key: string]: unknown }> = [];
  let hostReceive: (msg: unknown) => void = () => undefined;
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://example-webview.invalid/',
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (m: { type: string }) => { fromWebview.push(m); hostReceive(m); },
        getState: () => ({}),
        setState: () => undefined,
      });
      (window as unknown as { alert: () => void }).alert = () => undefined;
    },
  });
  open.push(dom);
  (dom.window as unknown as { __kdWorkspaceRestored?: boolean }).__kdWorkspaceRestored = true;

  const panel = new AgentPanel(fakeContext(), root, true);
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://test', asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (msg: PostedMessage) => { posted.push(msg); dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: msg })); return Promise.resolve(true); },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { hostReceive = cb; return { dispose: () => undefined }; },
  };
  panel.resolveWebviewView(
    { webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true } as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );
  return { dom, document: dom.window.document, posted, fromWebview };
}

describe('legacy webview + real host: Baat Kar -> Saath Kar confirmation', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-mode-legacy-'));
    dependencyMocks.getCoreManager.mockReset();
    dependencyMocks.createProvider.mockReset();
    dependencyMocks.createProvider.mockResolvedValue({ listModels: async () => [{ name: 'qwen3-coder:30b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 }] });
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.model', 'qwen3-coder:30b');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });


  async function sendRequestAndGate(client: ReturnType<typeof withFakeConversationWorkingState>) {
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client as never));
    const product = mountProduct(root);
    const wait = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
    await wait(100);
    const { dom, document, posted } = product;
    (document.querySelector('.mode-button[data-mode="chat"]') as HTMLButtonElement).click();
    const input = document.getElementById('user-input') as HTMLTextAreaElement;
    input.value = REQUEST;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    (document.getElementById('send-btn') as HTMLButtonElement).click();
    const deadline = Date.now() + 5000;
    while (!posted.some(m => m.type === 'modeChangeRequired') && Date.now() < deadline) await wait(20);
    expect(posted.some(m => m.type === 'modeChangeRequired')).toBe(true);
    // Gating alone never reaches Core.
    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(0);
    const button = [...document.querySelectorAll('.mode-change-actions button')].find(b => /Continue in Saath/.test(b.textContent ?? '')) as HTMLButtonElement;
    button.click();
    return { ...product, wait };
  }

  it('confirming resubmits the ORIGINAL request to Core as Saath Kar and consumes the decision card', async () => {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    const { document, fromWebview } = await sendRequestAndGate(client);
    await waitForCalls(client, 'submit', 1);
    await waitForCalls(client, 'executeAttempt', 1);

    expect(fromWebview.filter(m => m.type === 'confirmModeChange')).toHaveLength(1);
    const body = client.calls.find(c => c.method === 'submit')!.args[0] as { requestedMode: string; currentMessage: string };
    expect(body.requestedMode).toBe('saath_kar');
    expect(body.currentMessage).toBe(REQUEST);
    const card = document.querySelector('.mode-change-card') as HTMLElement;
    expect(card.classList.contains('resolved')).toBe(true);
    expect([...card.querySelectorAll('button')].every(b => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('a transition that cannot start the request settles honestly: no Working forever, no Completed', async () => {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    (client as { submit: () => Promise<never> }).submit = async () => { throw new Error('core refused the submission'); };
    const { posted, wait } = await sendRequestAndGate(client);
    const deadline = Date.now() + 5000;
    while (!posted.some(m => m.type === 'error') && Date.now() < deadline) await wait(20);
    expect(posted.some(m => m.type === 'error')).toBe(true);
    await wait(200);
    const dhaaga = posted.filter(m => m.type === 'dhaaga').map(m => JSON.stringify(m));
    expect(dhaaga.at(-1)).not.toMatch(/"phase":"completed"/);
    expect(dhaaga.at(-1)).toMatch(/"active":false/);
  });
});
