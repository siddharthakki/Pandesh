// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { hasAffirmativeMutationIntent } from '../../../core/domain/actionIntent';
import { withholdUnexecutedChangeClaims } from '../../../core/runtime/executionClaims';
import { findWorkspaceFiles, planWorkspaceFileOp } from '../../repository/WorkspaceFileOps';
import { summarizeModels } from '../../onboarding/OnboardingReadiness';
import {
  fakeContext,
  fakeCoreClient,
  fakeCoreManager,
  withFakeConversationWorkingState,
  waitForPosted,
  flush,
  type PostedMessage,
} from '../golden/goldenJourneyHarness';

const dependencyMocks = vi.hoisted(() => ({ getCoreManager: vi.fn(), createProvider: vi.fn() }));
vi.mock('../../extension', () => ({ getCoreManager: dependencyMocks.getCoreManager }));
vi.mock('../../providers/ProviderGateway', () => ({ ProviderGateway: { create: dependencyMocks.createProvider } }));

const REAL_BAAT_REPLY = [
  'Done — `ai_news.html` now has an "India · Sensex" panel in the sidebar. Four edits applied:',
  '',
  '**Changed**',
  '- Sidebar panel between Trending Topics and Sources',
  '',
  'Structural validation passed: all tags balance.',
].join('\n');

describe('M53 UAT: Baat mutation intent and false completion', () => {
  it('a target-first imperative ("ai_news.html edit this html and ...") is mutation intent', () => {
    expect(hasAffirmativeMutationIntent('ai_news.html edit this html and show wahts the sensex in india too')).toBe(true);
    expect(hasAffirmativeMutationIntent('in ai_news.html, add a footer')).toBe(true);
    expect(hasAffirmativeMutationIntent('styles.css update the colours')).toBe(true);
  });

  it('does not turn file mentions or questions into mutation intent', () => {
    expect(hasAffirmativeMutationIntent('ai_news.html explains the layout')).toBe(false);
    expect(hasAffirmativeMutationIntent('what does ai_news.html do?')).toBe(false);
    expect(hasAffirmativeMutationIntent('how many html files are there in this workspace?')).toBe(false);
    expect(hasAffirmativeMutationIntent('open all html files in browser for view')).toBe(false);
  });

  it('the media mirrors agree with the host rule', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const presentation = require('../../../media/everyday-presentation.js') as { recommendMode: (text: string) => { mode: string } };
    expect(presentation.recommendMode('ai_news.html edit this html and show wahts the sensex in india too').mode).not.toBe('chat');
  });

  it('Baat Kar prose claiming an edit or validation is withheld: no tool ran, so none happened', () => {
    const guarded = withholdUnexecutedChangeClaims(REAL_BAAT_REPLY);
    expect(guarded.withheld.length).toBeGreaterThanOrEqual(2);
    expect(guarded.text).not.toMatch(/now has an "India/);
    expect(guarded.text).not.toMatch(/Structural validation passed/);
    expect(guarded.text).toContain('No file was changed and nothing was validated in this turn.');
  });

  it('ordinary Baat answers and code samples are untouched', () => {
    const answer = 'Here is how you could add a panel:\n\n```html\n<div>The file now has this</div>\n```\n\nSave it as `ai_news.html` yourself if you want it.';
    expect(withholdUnexecutedChangeClaims(answer)).toEqual({ text: answer, withheld: [] });
  });
});

describe('M53 UAT: Setup readiness reports provider-declared vision', () => {
  const candidate = (model: string, providerCapabilities: string[] | undefined, staticVision: boolean) => ({
    provider: 'ollama', model, available: true, configuredRoles: [], providerCapabilities,
    capabilities: { chat: true, tools: true, vision: staticVision, structuredOutput: false, embeddings: false, embeddingOnly: false, contextWindow: 32768 },
  }) as never;

  it('provider declaration decides; silence is unknown, never a claimed no', () => {
    const rows = summarizeModels([
      candidate('gemma4:12b', ['completion', 'vision', 'tools'], false),
      candidate('text-only', ['completion', 'tools'], true),
      candidate('never-probed', undefined, false),
    ]);
    const vision = Object.fromEntries(rows.map(row => [row.name, row.vision]));
    expect(vision).toEqual({ 'gemma4:12b': 'yes', 'text-only': 'no', 'never-probed': 'unknown' });
  });
});

describe('M53 UAT: deterministic workspace file operations', () => {
  it('plans count / list / open for any extension, and leaves project-scoped questions alone', () => {
    expect(planWorkspaceFileOp('how many html files are there in this workspace?')).toMatchObject({ kind: 'count', extensions: ['html', 'htm'] });
    expect(planWorkspaceFileOp('list all css files')).toMatchObject({ kind: 'list', extensions: ['css'] });
    expect(planWorkspaceFileOp('find all json files')).toMatchObject({ kind: 'list', extensions: ['json'] });
    expect(planWorkspaceFileOp('open all html files in browser for view')).toMatchObject({ kind: 'open_in_browser', extensions: ['html', 'htm'] });
    expect(planWorkspaceFileOp('count the python files in each project')).toBeUndefined();
    expect(planWorkspaceFileOp('which project has the most html files')).toBeUndefined();
    expect(planWorkspaceFileOp('explain this file')).toBeUndefined();
  });

  it('enumerates every match from the filesystem, skipping hidden and generated trees', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-walk-'));
    try {
      await fs.mkdir(path.join(root, 'sub'), { recursive: true });
      await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
      await fs.mkdir(path.join(root, '.tmp'), { recursive: true });
      for (const file of ['a.html', 'sub/b.HTML', 'c.htm', 'node_modules/x/n.html', '.tmp/h.html', 'readme.md']) await fs.writeFile(path.join(root, file), 'x', 'utf8');
      const found = await findWorkspaceFiles(root, ['html', 'htm']);
      expect(found.files).toEqual(['a.html', 'c.htm', 'sub/b.HTML']);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});

describe('M53 UAT: host-native workspace actions (real AgentPanel, zero model turns)', () => {
  let root: string;

  function attach(): { posted: PostedMessage[]; receive: (msg: unknown) => void; client: ReturnType<typeof fakeCoreClient> } {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    dependencyMocks.getCoreManager.mockReturnValue(fakeCoreManager(client));
    const posted: PostedMessage[] = [];
    const panel = new AgentPanel(fakeContext(), root, true);
    let receive: (msg: unknown) => void = () => undefined;
    const webview = {
      options: {}, html: '', cspSource: 'vscode-webview://test', asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: (msg: PostedMessage) => { posted.push(msg); return Promise.resolve(true); },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => { receive = cb; return { dispose: () => undefined }; },
    };
    panel.resolveWebviewView(
      { webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true } as unknown as vscode.WebviewView,
      {} as vscode.WebviewViewResolveContext, {} as vscode.CancellationToken,
    );
    receive({ type: 'webviewReady', mode: 'chat' });
    return { posted, receive: msg => receive(msg), client };
  }
  const modelTurns = (client: ReturnType<typeof fakeCoreClient>) => client.calls.filter(c => ['submit', 'executeAttempt', 'retryAttempt'].includes(c.method)).length;
  const lastDone = (posted: PostedMessage[]) => String([...posted].reverse().find(m => m.type === 'done')?.content ?? '');

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-hostops-'));
    for (const name of ['ai_news.html', 'stock_market.html', 'pong.html']) await fs.writeFile(path.join(root, name), '<html></html>\n', 'utf8');
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

  it('"open all html files in browser for view": three host opens, zero model submissions, all paths accounted for', async () => {
    const { receive, posted, client } = attach();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    receive({ type: 'sendMessage', mode: 'chat', text: 'open all html files in browser for view', conversationId: 'c1' });
    await waitForPosted(posted, m => m.type === 'done' && /Opened 3 HTML files in your default browser\./.test(String(m.content)));
    expect(openExternal).toHaveBeenCalledTimes(3);
    const opened = openExternal.mock.calls.map(call => path.basename((call[0] as vscode.Uri).fsPath)).sort();
    expect(opened).toEqual(['ai_news.html', 'pong.html', 'stock_market.html']);
    for (const name of opened) expect(lastDone(posted)).toContain(name);
    expect(modelTurns(client)).toBe(0);
    expect(lastDone(posted)).not.toMatch(/powershell|Start-Process|Get-ChildItem/i);
  });

  it('a failed open names exactly which path failed', async () => {
    const { receive, posted, client } = attach();
    vi.spyOn(vscode.env, 'openExternal').mockImplementation(async uri => !/pong\.html$/.test(uri.fsPath));
    receive({ type: 'sendMessage', mode: 'chat', text: 'open all html files in browser for view', conversationId: 'c1' });
    await waitForPosted(posted, m => m.type === 'done' && /could not be opened/.test(String(m.content)));
    const text = lastDone(posted);
    expect(text).toContain('Opened 2 HTML files');
    expect(text).toMatch(/`pong\.html`: .*did not launch/);
    expect(modelTurns(client)).toBe(0);
  });

  it('"how many html files are there in this workspace?" counts the filesystem, with no model turn', async () => {
    const { receive, posted, client } = attach();
    receive({ type: 'sendMessage', mode: 'chat', text: 'how many html files are there in this workspace?', conversationId: 'c2' });
    await waitForPosted(posted, m => m.type === 'done' && /There are 3 HTML files in this workspace/.test(String(m.content)));
    expect(modelTurns(client)).toBe(0);
  });

  it('"open that in browser now" opens the one HTML file the person named, host-side, no model turn', async () => {
    const { receive, posted, client } = attach();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    receive({ type: 'sendMessage', mode: 'chat', text: 'tell me what ai_news.html is for', conversationId: 'c3' });
    await flush(40);
    const before = modelTurns(client);
    receive({ type: 'sendMessage', mode: 'chat', text: 'open that in browser now', conversationId: 'c3' });
    await waitForPosted(posted, m => m.type === 'done' && /Opened ai_news\.html in your browser\./.test(String(m.content)));
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(path.basename((openExternal.mock.calls[0][0] as vscode.Uri).fsPath)).toBe('ai_news.html');
    expect(modelTurns(client)).toBe(before);
  });

  it('"open that in browser" with nothing to bind says so instead of calling a model that has no browser tool', async () => {
    const { receive, posted, client } = attach();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    receive({ type: 'sendMessage', mode: 'chat', text: 'open that in browser', conversationId: 'c4' });
    await waitForPosted(posted, m => m.type === 'done' && /do not have a recent HTML file/.test(String(m.content)));
    expect(openExternal).not.toHaveBeenCalled();
    expect(modelTurns(client)).toBe(0);
  });

  it('Baat + "ai_news.html edit this html ..." requires the Saath transition and runs nothing', async () => {
    const { receive, posted, client } = attach();
    receive({ type: 'sendMessage', mode: 'chat', text: 'ai_news.html edit this html and show wahts the sensex in india too', conversationId: 'c5' });
    await waitForPosted(posted, m => m.type === 'modeChangeRequired');
    expect(modelTurns(client)).toBe(0);
    expect(await fs.readFile(path.join(root, 'ai_news.html'), 'utf8')).toBe('<html></html>\n');
  });
});
