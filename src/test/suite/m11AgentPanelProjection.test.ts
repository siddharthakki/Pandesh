import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ContextPreflightResult } from '../../reliability/ContextBudget';
import { MockProvider } from '../mocks/MockProvider';

interface PostedMessage {
  type: string;
  [key: string]: unknown;
}

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

const CONTENT_CATEGORIES = new Set([
  'system',
  'tool_definitions',
  'task_goal',
  'repository_context',
  'recent_conversation',
  'tool_results',
  'image_payload',
]);

describe('M11 Agent Panel projection', () => {
  let root: string;
  let provider: MockProvider;
  let posted: PostedMessage[];
  let receive: ((msg: unknown) => void) | undefined;
  let panel: AgentPanel;

  beforeEach(async () => {
    vscodeMock._resetConfig();
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m11-panel-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    posted = [];

    const extensionRoot = process.cwd();
    const context = {
      secrets: secretStorage(),
      extensionUri: vscode.Uri.file(extensionRoot),
    } as unknown as vscode.ExtensionContext;
    panel = new AgentPanel(context, root);

    const webview = {
      options: {},
      html: '',
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: (msg: PostedMessage) => {
        posted.push(msg);
        return Promise.resolve(true);
      },
      onDidReceiveMessage: (cb: (msg: unknown) => void) => {
        receive = cb;
        return { dispose: () => undefined };
      },
    };
    const webviewView = {
      webview,
      show: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      visible: true,
    } as unknown as vscode.WebviewView;
    panel.resolveWebviewView(
      webviewView,
      {} as vscode.WebviewViewResolveContext,
      {} as vscode.CancellationToken,
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    // The runtime persists task state asynchronously after the final webview
    // post; retry cleanup so a still-open handle cannot fail the suite.
    try {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch {
      // Best-effort temp cleanup on Windows.
    }
  });

  function send(text: string, mode: string, model?: string): void {
    expect(receive).toBeDefined();
    receive?.({ type: 'sendMessage', text, mode, conversationId: `conv_${mode}_${Date.now()}`, model });
  }

  async function waitForPost(type: string): Promise<PostedMessage> {
    await vi.waitFor(() => {
      if (!posted.some(msg => msg.type === type)) {
        throw new Error(`no ${type} posted yet`);
      }
    }, { timeout: 15000 });
    return posted.find(msg => msg.type === type)!;
  }

  // M32 correction (Baat Kar/Saath Kar execution cutover to Core, see
  // docs/m32-progress.md): these four tests exercise context-window preflight
  // blocking (`ContextBudget`) and reliability-pattern monitoring
  // (`ReliabilityMonitor`), both Extension-Host-side features of the legacy
  // `AgentRuntime.run()` path this suite drives via a mocked `ProviderGateway`.
  // Core's minimal executor (`core/runtime/executor.ts`) has no equivalent —
  // no preflight token-budget check, no reliability-pattern detection — and
  // `AgentRuntime.run()` is no longer called for these two modes at all
  // (that is the point of this correction: no fallback execution path).
  // Skipped rather than deleted or rewritten to fake-pass: this is a real,
  // documented capability gap (docs/m32-progress.md, "Explicitly still open"
  // under the ownership table), not a test-harness mismatch to paper over.
  // Confirmed accurate during the M32 final acceptance pass (verified
  // core/runtime/executor.ts has no ContextBudget/ReliabilityMonitor import
  // or equivalent logic). Backlog owner: M33-B1 "port ContextBudget preflight
  // + ReliabilityMonitor pattern detection into Core's executor for Baat
  // Kar/Saath Kar" (docs/m32-progress.md, M32 acceptance report). Restoring
  // these tests without that port would require reintroducing the removed
  // Extension-Host fallback path this correction closed — out of scope here.
  it.skip('projects the context usage event with structured-output state, category totals and estimated display', async () => {
    provider.enqueueText('Hello from the model.');
    send('Say hello.', 'chat');

    const contextMessage = await waitForPost('contextUsage');
    const usage = contextMessage['usage'] as ContextPreflightResult;
    expect(usage.status).toBe('safe');
    expect(usage.countingMode).toBe('estimated');
    expect(usage.limit.effectiveLimit).toBeGreaterThan(0);
    expect(usage.structuredOutput).toBeDefined();
    expect(usage.structuredOutput?.active).toBe(false);
    const contentSum = usage.categories
      .filter(item => CONTENT_CATEGORIES.has(item.category))
      .reduce((sum, item) => sum + item.tokens, 0);
    expect(contentSum).toBe(usage.contentTokens);
    await waitForPost('done');
  });

  it.skip('projects the blocked state with zero provider dispatches', async () => {
    vscodeMock._setConfig('ollama-agent.contextWindow', 250);
    send('x'.repeat(20_000), 'chat');

    const errorMessage = await waitForPost('error');
    expect(String(errorMessage['message'])).toContain('Request blocked before model dispatch');
    const contextMessage = await waitForPost('contextUsage');
    expect((contextMessage['usage'] as ContextPreflightResult).status).toBe('blocked');
    expect(provider.capturedRequests).toHaveLength(0);
  });

  it.skip('projects unknown-model fallback usage as visibly estimated', async () => {
    provider.enqueueText('ok');
    send('Hello.', 'chat', 'mystery-model:1b');

    const contextMessage = await waitForPost('contextUsage');
    const usage = contextMessage['usage'] as ContextPreflightResult;
    expect(usage.status).toBe('unknown_fallback');
    expect(usage.limit.fallback).toBe(true);
    expect(usage.limit.estimated).toBe(true);
  });

  it.skip('projects reliability events without posting raw prompts or raw tool arguments', async () => {
    const secretArg = 'RAW-SECRET-ARGUMENT-VALUE';
    const secretPrompt = 'SECRET-PROMPT-TEXT do not leak';
    provider.enqueueToolCall('no_such_tool', { secret: secretArg });
    send(secretPrompt, 'agent');

    const reliability = await waitForPost('reliabilityEvent');
    const event = reliability['event'] as { code: string; message: string };
    expect(event.code).toBe('unknown_tool');

    const sensitiveProjections = posted.filter(msg => msg.type === 'contextUsage' || msg.type === 'reliabilityEvent');
    const serialized = JSON.stringify(sensitiveProjections);
    expect(serialized).not.toContain(secretArg);
    expect(serialized).not.toContain(secretPrompt);
  });
});

describe('M11 webview renderer wiring (chat.js)', () => {
  const chatJs = fsSync.readFileSync(path.join(process.cwd(), 'media', 'chat.js'), 'utf8');

  it('routes contextUsage and reliabilityEvent messages', () => {
    expect(chatJs).toContain("case 'contextUsage':");
    expect(chatJs).toContain("case 'reliabilityEvent':");
    expect(chatJs).toContain('renderContextUsage');
  });

  it('renders structured-output and vision-minimum state chips', () => {
    expect(chatJs).toContain('structured output: ');
    expect(chatJs).toContain('visionMinimumApplied');
    expect(chatJs).toContain('exact');
    expect(chatJs).toContain('estimated');
  });
});
