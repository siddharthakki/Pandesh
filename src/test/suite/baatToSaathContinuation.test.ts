import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
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

/** Production-path host: the real AgentPanel with only the Core process boundary faked. */
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

const REQUEST = 'Create three new files under uat-m51-multifile/: one.txt, two.txt, and three.txt. Put ONE, TWO, and THREE in them respectively. Treat each file as a separate required change. Do not declare the task complete until all three files exist with the exact contents and you have verified them.';

describe('Baat Kar -> Saath Kar confirmation resumes the original objective', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-mode-continue-'));
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

  async function runGateThenConfirm(priorQuestion?: string) {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const { receive, posted } = attachPanel(root);
    const conversationId = 'baat-to-saath';
    let submits = 0;
    if (priorQuestion) {
      receive({ type: 'sendMessage', mode: 'chat', text: priorQuestion, conversationId });
      await waitForCalls(client, 'submit', 1);
      await waitForCalls(client, 'executeAttempt', 1);
      submits = 1;
    }
    receive({ type: 'sendMessage', mode: 'chat', text: REQUEST, conversationId });
    await waitForPosted(posted, m => m.type === 'modeChangeRequired');
    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(submits);
    receive({ type: 'confirmModeChange', conversationId });
    // Wait for the resumed submit itself rather than a fixed delay; a fixed 200ms was flaky under load.
    await waitForCalls(client, 'submit', submits + 1);
    await flush(50);
    return { client, posted, submits };
  }

  it.each([
    ['a fresh conversation', undefined],
    ['after an unrelated read-only objective', 'Explain the full UI to model to UI flow of this extension.'],
    ['after a standalone code answer', 'Write a Python function that checks whether a string is a palindrome.'],
  ])('submits the original request to Saath Kar after confirmation (%s)', async (_label, prior) => {
    const { client, posted, submits } = await runGateThenConfirm(prior);
    const clarifications = posted.filter(m => typeof m.content === 'string' && /Should I treat it as a new task\?/.test(m.content as string));
    expect(clarifications).toHaveLength(0);
    const submitCalls = client.calls.filter(c => c.method === 'submit');
    expect(submitCalls).toHaveLength(submits + 1);
    const body = submitCalls.at(-1)!.args[0] as { currentMessage: string; requestedMode: string };
    expect(body.requestedMode).toBe('saath_kar');
    expect(body.currentMessage).toBe(REQUEST);
    expect(client.calls.filter(c => c.method === 'executeAttempt')).toHaveLength(submits + 1);
  });
});
