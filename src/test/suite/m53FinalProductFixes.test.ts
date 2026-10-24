// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { RepoFastPath } from '../../repository/RepoFastPath';
import { isAnswerIntrospection, planRepositoryFacts } from '../../repository/RepositoryFacts';
import {
  fakeContext,
  fakeCoreClient,
  fakeCoreManager,
  withFakeConversationWorkingState,
  waitForCalls,
  waitForPosted,
  flush,
  type PostedMessage,
} from '../golden/goldenJourneyHarness';

const dependencyMocks = vi.hoisted(() => ({
  getCoreManager: vi.fn(),
  createProvider: vi.fn(),
}));

vi.mock('../../extension', () => ({ getCoreManager: dependencyMocks.getCoreManager }));
vi.mock('../../providers/ProviderGateway', () => ({ ProviderGateway: { create: dependencyMocks.createProvider } }));

const WEATHER = '<!doctype html>\n<html>\n<head><title>Weather</title></head>\n<body>\n<h1>Weather</h1>\n</body>\n</html>\n';
const REL = 'uat-m51-multifile/weather.html';

function attachPanel(root: string): { panel: AgentPanel; posted: PostedMessage[]; receive: (msg: unknown) => void } {
  const posted: PostedMessage[] = [];
  const panel = new AgentPanel(fakeContext(), root, true);
  let receive: (msg: unknown) => void = () => undefined;
  const webview = {
    options: {},
    html: '',
    cspSource: 'vscode-webview://test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (msg: PostedMessage) => { posted.push(msg); return Promise.resolve(true); },
    onDidReceiveMessage: (cb: (msg: unknown) => void) => { receive = cb; return { dispose: () => undefined }; },
  };
  panel.resolveWebviewView(
    { webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true } as unknown as vscode.WebviewView,
    {} as vscode.WebviewViewResolveContext,
    {} as vscode.CancellationToken,
  );
  return { panel, posted, receive: msg => receive(msg) };
}

function saathClient() {
  const base = withFakeConversationWorkingState(fakeCoreClient());
  return Object.assign(base, {
    async listToolInvocations(anchorAttemptId: string) {
      base.calls.push({ method: 'listToolInvocations', args: [anchorAttemptId] });
      return {
        toolInvocations: [{
          id: 'inv_write', attemptId: anchorAttemptId, approvalId: 'appr_1', toolName: 'propose_file_change', argsSummary: { path: REL },
          status: 'succeeded', startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), exitCode: 0,
          evidence: { output: 'Wrote 100 byte(s)', resultCategory: 'write_succeeded', normalizedArguments: { path: REL, content: WEATHER } },
        }],
      };
    },
  });
}

describe('M53 final product fixes: repository facts and no false introspection', () => {
  let root: string;
  beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-facts-')); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

  async function threeLooseHtmlFiles() {
    for (const name of ['stock_market.html', 'weather.html', 'notes.html']) await fs.writeFile(path.join(root, name), '<html></html>\n', 'utf8');
  }

  it('"how many html files are there in this project" is a workspace-level fact even when no recognised project holds a match', async () => {
    await threeLooseHtmlFiles();
    expect(planRepositoryFacts('how many html files are there in this project')).toMatchObject({ kind: 'project_extension_counts', extensions: ['html', 'htm'] });
    const result = await new RepoFastPath(root).repoQuery('how many html files are there in this project', { maxChars: 12_000 });
    expect(result?.type).toBe('facts');
    expect(result!.prompt).toContain('There are 3 HTML files in this workspace.');
    expect(result!.prompt).not.toMatch(/No HTML files were found/i);
    expect(result!.hostFacts?.measured).toBe('3 HTML files counted across the workspace');
    expect(result!.hostFacts).toMatchObject({ workspaceTotal: 3, projectsWithMatches: 0 });
  });

  it('a genuinely empty workspace still says no HTML files, scoped to the workspace', async () => {
    await fs.writeFile(path.join(root, 'readme.txt'), 'x\n', 'utf8');
    const result = await new RepoFastPath(root).repoQuery('how many html files are there in this project', { maxChars: 12_000 });
    expect(result!.prompt).toContain('No HTML files were found in this workspace.');
  });

  it('"why did you say no files before? what was the root cause" is answered from the host record, with no invented introspection', async () => {
    await threeLooseHtmlFiles();
    const fast = new RepoFastPath(root);
    await fast.repoQuery('how many html files are there in this project', { maxChars: 12_000 });
    const why = 'why did you say no files before? what was the root cause';
    expect(planRepositoryFacts(why)).toBeUndefined();
    expect(isAnswerIntrospection(why)).toBe(true);
    const result = await fast.repoQuery(why, { maxChars: 12_000 });
    expect(result?.type).toBe('facts');
    const packet = result!.prompt;
    expect(packet).toContain('There are 3 HTML files in this workspace.');
    expect(packet).toContain('Observable discrepancy');
    expect(packet).toContain('reading that zero project count as zero files');
    // The model is forbidden from the unevidenced claim and told it has no access to its own earlier reasoning.
    expect(packet).toContain('do not claim to know why you said something');
    expect(packet).toMatch(/do not say you "ignored" or "missed" evidence unless this record shows it/);
    // Not a fresh computation, and nothing says the evidence was ignored.
    expect(packet).not.toMatch(/I ignored/i);
  });

  it('an introspective question with no earlier host-computed answer is not hijacked, and New Chat forgets the record', async () => {
    await threeLooseHtmlFiles();
    const fast = new RepoFastPath(root);
    const why = 'why did you say that? what was the root cause';
    expect(await fast.repoQuery(why, { maxChars: 12_000, requireGrounding: true })).toBeUndefined();
    await fast.repoQuery('how many html files are there in this project', { maxChars: 12_000 });
    fast.resetConversationState();
    expect(await fast.repoQuery(why, { maxChars: 12_000, requireGrounding: true })).toBeUndefined();
  });
});

describe('M53 final product fixes: History navigation in the real webview', () => {
  const SCRIPTS = [
    'chat.js', 'chat-fixes.js', 'chat-dashboard.js', 'chat-operations.js', 'chat-runtime-fixes.js', 'chat-autonomous.js',
    'chat-sidebar-ui.js', 'everyday-presentation.js', 'chat-everyday.js', 'chat-dhaaga.js',
  ];
  const open: JSDOM[] = [];
  afterEach(() => { for (const dom of open.splice(0)) dom.window.close(); });

  async function mount() {
    const media = (name: string) => fs.readFile(path.resolve(process.cwd(), 'media', name), 'utf8');
    const raw = (await media('chat.html'))
      .replace(/{{cspSource}}/g, "'self'").replace(/{{nonce}}/g, 'n').replace(/{{cssUri}}/g, 'chat.css').replace(/{{jsUri}}/g, 'chat.js')
      .replace(/{{pandaBaseUri}}/g, '').replace(/{{modelName}}/g, 'm');
    const head = raw.slice(0, raw.indexOf('<script nonce="n">'));
    const inline = (await Promise.all(SCRIPTS.map(async file => `<script nonce="n">${await media(file)}</script>`))).join('\n');
    const html = `${head}<script nonce="n">(() => { const api = window.acquireVsCodeApi(); Object.defineProperty(window, '__ollamaAgentVsCodeApi', { value: api }); Object.defineProperty(window, '__pandaBaseUri', { value: '' }); })();</script>${inline}</body></html>`;
    const posted: Array<{ type: string; [key: string]: unknown }> = [];
    const dom = new JSDOM(html, {
      runScripts: 'dangerously', url: 'https://example-webview.invalid/',
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (m: { type: string }) => { posted.push(m); }, getState: () => ({}), setState: () => undefined });
        (window as unknown as { alert: () => void }).alert = () => undefined;
      },
    });
    open.push(dom);
    (dom.window as unknown as { __kdWorkspaceRestored?: boolean }).__kdWorkspaceRestored = true;
    const dispatch = (data: Record<string, unknown>) => dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data }));
    return { document: dom.window.document, posted, dispatch };
  }

  it('clicking a History conversation asks the host for it, closes the drawer, and the restored transcript replaces the view', async () => {
    const { document, posted, dispatch } = await mount();
    dispatch({ type: 'persistedConversationsLoaded', conversations: [
      { id: 'conv-old', title: 'Add weather page', updatedAt: 2 },
      { id: 'conv-other', title: 'Explain stock_market', updatedAt: 1 },
    ] });
    (document.getElementById('history-toggle') as HTMLElement).click();
    const drawer = document.getElementById('history-drawer') as HTMLElement;
    expect(drawer.hidden).toBe(false);

    (document.querySelector('.conversation-item[data-conv-id="conv-old"]') as HTMLElement).click();
    expect(posted.filter(m => m.type === 'selectConversation')).toEqual([{ type: 'selectConversation', id: 'conv-old' }]);
    expect(drawer.hidden).toBe(true); // the overlay must not keep covering the transcript

    // What the host posts after selectConversation (a conversation that was already rendered in the view is replaced).
    dispatch({ type: 'restoreTranscript', conversationId: 'conv-old', replaceExisting: false, messages: [{ id: 'm0', role: 'user', content: 'a stale earlier view' }] });
    dispatch({ type: 'conversationSelected', id: 'conv-old' });
    dispatch({ type: 'restoreTranscript', conversationId: 'conv-old', replaceExisting: true, messages: [
      { id: 'm1', role: 'user', content: 'create weather.html' },
      { id: 'm2', role: 'assistant', content: 'Created weather.html' },
    ] });
    const text = document.getElementById('messages')!.textContent ?? '';
    expect(text).toContain('create weather.html');
    expect(text).toContain('Created weather.html');
    expect(text).not.toContain('a stale earlier view');

    // Opening History is read-only: nothing executes.
    const DISPATCHING = ['sendMessage', 'retryBlockedAttempt', 'approveProposal', 'approveMutation', 'approveAutonomousDelivery', 'startAutonomousTask', 'resumeTask', 'taskResultAction'];
    expect(posted.filter(m => DISPATCHING.includes(m.type))).toEqual([]);
  });

  it('History drawer is about conversations and the operational drawer is called Runs', async () => {
    const html = await fs.readFile(path.resolve(process.cwd(), 'media/chat.html'), 'utf8');
    expect(html.indexOf('>Recent chats<')).toBeGreaterThan(0);
    expect(html.indexOf('>Recent chats<')).toBeLessThan(html.indexOf('>Run timelines<'));
    expect(html).toContain('<h2>Runs</h2>');
    expect(html).not.toContain('<h2>Activity</h2>');
  });
});

describe('M53 final product fixes: host History selection and Open in browser (real AgentPanel)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-final-'));
    await fs.mkdir(path.join(root, 'uat-m51-multifile'), { recursive: true });
    await fs.writeFile(path.join(root, REL), WEATHER, 'utf8');
    dependencyMocks.getCoreManager.mockReset();
    dependencyMocks.createProvider.mockReset();
    dependencyMocks.createProvider.mockResolvedValue({
      listModels: async () => [{ name: 'qwen3-coder:30b', modifiedAt: '2026-01-01T00:00:00.000Z', contextWindow: 32_768 }],
    });
    vscodeMock._resetConfig();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.model', 'qwen3-coder:30b');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  async function createWeatherWithSaath() {
    const client = saathClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const { receive, posted, panel } = attachPanel(root);
    receive({ type: 'webviewReady', mode: 'chat' });
    const conversationId = 'saath-weather';
    receive({ type: 'sendMessage', mode: 'agent', text: `create ${REL} with a small weather page`, conversationId });
    await waitForCalls(client, 'executeAttempt', 1);
    client.conversationMessages.get('conv_1')?.push({ role: 'user', content: 'create weather' }, { role: 'assistant', content: 'Created weather.html' });
    manager.fireRuntimeEvent({ domain: 'tool_invocation', entityId: 'inv_write', eventType: 'capability_tool_invocation_completed', metadata: { attemptId: 'att_1', anchorAttemptId: 'anchor_1', toolName: 'propose_file_change', status: 'succeeded' } });
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { to: 'completed' } });
    const card = await waitForPosted(posted, m => m.type === 'taskResult' && !m.historical);
    const artifactId = (card.taskResult as { artifacts: Array<{ id: string }> }).artifacts[0].id;
    return { client, manager, receive, posted, panel, conversationId, artifactId };
  }

  it('Open in browser: host-resolved path, OS default handler, no model turn, never automatic', async () => {
    const { client, receive, posted, artifactId } = await createWeatherWithSaath();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const submitsBefore = client.calls.filter(c => c.method === 'submit').length;
    expect(openExternal).not.toHaveBeenCalled(); // completing the task never launched anything

    receive({ type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId });
    await flush(30);
    expect(openExternal).toHaveBeenCalledTimes(1);
    const launched = openExternal.mock.calls[0][0] as vscode.Uri;
    expect(launched.fsPath.replace(/\\/g, '/')).toBe(path.join(root, REL).replace(/\\/g, '/'));
    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(submitsBefore);
    expect(posted.filter(m => m.type === 'error')).toEqual([]);

    // A forged artifact id, or a path the webview tries to supply, reaches nothing.
    openExternal.mockClear();
    receive({ type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId: 'art-forged', path: '/etc/passwd' });
    await flush(30);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('Open in browser reports a truthful error when the OS launch fails, throws, or the file is gone', async () => {
    const { receive, posted, artifactId } = await createWeatherWithSaath();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(false);

    receive({ type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId });
    const refused = await waitForPosted(posted, m => m.type === 'error' && /operating system did not launch/.test(String(m.message)));
    expect(String(refused.message)).toContain('weather.html');

    openExternal.mockRejectedValue(new Error('no handler registered'));
    receive({ type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId });
    await waitForPosted(posted, m => m.type === 'error' && /no handler registered/.test(String(m.message)));

    await fs.rm(path.join(root, REL));
    openExternal.mockClear();
    receive({ type: 'taskResultAction', action: 'openInBrowser', taskId: 'att_1', artifactId });
    await waitForPosted(posted, m => m.type === 'error' && /no longer exists/.test(String(m.message)));
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('selecting a History conversation restores its transcript even when a stale Karke Dikha task id is remembered', async () => {
    const { client, receive, posted, panel, conversationId } = await createWeatherWithSaath();
    receive({ type: 'newConversation' });
    await waitForPosted(posted, m => m.type === 'newConversation' && m.reset === true);
    // The remembered task id belongs to nothing that is running (the old behaviour silently ignored the click).
    (panel as unknown as { autonomousActiveTaskId?: string }).autonomousActiveTaskId = 'task-finished-long-ago';
    const mark = posted.length;
    const executionCalls = () => client.calls.filter(c => ['submit', 'executeAttempt', 'retryAttempt'].includes(c.method)).length;
    const before = executionCalls();
    receive({ type: 'selectConversation', id: conversationId });
    const restored = await (async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = posted.slice(mark).find(m => m.type === 'restoreTranscript');
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`transcript never restored. Posted: ${posted.slice(mark).map(m => m.type).join(', ')}`);
        await flush();
      }
    })();
    expect(restored.replaceExisting).toBe(true);
    expect((restored.messages as Array<{ content: string }>).map(m => m.content)).toEqual(['create weather', 'Created weather.html']);
    expect(posted.slice(mark).some(m => m.type === 'conversationSelected' && m.id === conversationId)).toBe(true);
    expect(posted.slice(mark).filter(m => m.type === 'error')).toEqual([]);
    expect(executionCalls()).toBe(before); // inert: no execution replay
  });
});
