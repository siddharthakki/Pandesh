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

const WEATHER = '<!doctype html>\n<html>\n<head><title>Weather</title></head>\n<body>\n<h1>Weather</h1>\n<p>Sunny, 24C</p>\n</body>\n</html>\n';
const REL = 'uat-m51-multifile/weather.html';

/** The fake Core boundary, extended with what a finished Saath Kar turn is read back from. */
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

describe('M53 Saath Kar result card and recent-artifact continuation (real AgentPanel)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-journey-'));
    await fs.mkdir(path.join(root, 'uat-m51-multifile'), { recursive: true });
    await fs.writeFile(path.join(root, REL), WEATHER, 'utf8');
    // An unrelated file the old retrieval would have preferred for a "login" request.
    await fs.mkdir(path.join(root, 'src', 'onboarding'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'onboarding', 'OnboardingView.ts'), 'export class OnboardingView { login() { return "login page"; } }\n', 'utf8');
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
    const conversationId = 'saath-weather';
    receive({ type: 'sendMessage', mode: 'agent', text: `create ${REL} with a small weather page`, conversationId });
    await waitForCalls(client, 'executeAttempt', 1);
    const attemptId = 'att_1';
    // What Core relays for the approved write, the structure check and the end of the turn.
    manager.fireRuntimeEvent({ domain: 'tool_invocation', entityId: 'inv_write', eventType: 'capability_tool_invocation_completed', metadata: { attemptId, anchorAttemptId: 'anchor_1', toolName: 'propose_file_change', status: 'succeeded' } });
    manager.fireRuntimeEvent({ domain: 'tool_invocation', entityId: 'inv_check', eventType: 'tool_invocation_started', metadata: { attemptId, toolName: 'static_html_check', argsSummary: { path: REL } } });
    manager.fireRuntimeEvent({ domain: 'tool_invocation', entityId: 'inv_check', eventType: 'tool_invocation_completed', metadata: { attemptId, status: 'succeeded', evidence: { output: 'Static HTML structure check passed (parsed 1 document).', resultCategory: 'static_check_passed' } } });
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: attemptId, eventType: 'attempt_transitioned', metadata: { to: 'completed' } });
    const card = await waitForPosted(posted, m => m.type === 'taskResult');
    return { client, manager, receive, posted, panel, conversationId, card };
  }

  it('1. Saath Kar creating weather.html ends with a TaskResult card: real artifact, validation state, Open/Reveal/Copy/Preview actions are actionable', async () => {
    const { card, posted, receive } = await createWeatherWithSaath();
    const result = card.taskResult as { status: string; validationStatus: string; artifacts: Array<{ id: string; type: string; path: string }>; changes: { created: string[]; modified: string[] }; evidence: Array<{ subject: string; ok?: boolean }> };
    expect(card.taskId).toBe('att_1');
    expect(result.status).toBe('completed');
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]).toMatchObject({ type: 'html', path: REL });
    expect(result.changes.created.concat(result.changes.modified)).toEqual([REL]);
    // The structure check is shown as a structure check, not as a test/build pass.
    expect(result.validationStatus).toBe('none_recorded');
    expect(result.evidence.some(entry => /^structure check /.test(entry.subject) && entry.ok === true)).toBe(true);

    // The card's actions resolve through the host's own result (the webview only names ids).
    const open = vi.spyOn(vscode.commands, 'executeCommand');
    receive({ type: 'taskResultAction', action: 'open', taskId: 'att_1', artifactId: result.artifacts[0].id });
    await flush(30);
    expect(open).toHaveBeenCalledWith('vscode.open', expect.anything());
    // A forged artifact id reaches nothing.
    open.mockClear();
    receive({ type: 'taskResultAction', action: 'open', taskId: 'att_1', artifactId: 'art-forged' });
    await flush(30);
    expect(open).not.toHaveBeenCalled();
    // The card was posted once and nothing opened by itself (no giant popup, no auto browser launch).
    expect(posted.filter(m => m.type === 'taskResult')).toHaveLength(1);
  });

  it('2. regression: Saath creates weather.html -> "add a login page to this html" => weather.html is the primary target and no broad retrieval runs', async () => {
    const { client, receive, conversationId } = await createWeatherWithSaath();
    receive({ type: 'sendMessage', mode: 'agent', text: 'add a login page to this html', conversationId });
    await waitForCalls(client, 'submit', 2);
    const body = client.calls.filter(c => c.method === 'submit').at(-1)!.args[0] as {
      currentMessage: string;
      repositoryContext?: { prompt: string; selectedFiles: Array<{ path: string; complete?: boolean }> };
    };
    expect(body.currentMessage).toBe('add a login page to this html');
    expect(body.repositoryContext?.selectedFiles).toEqual([expect.objectContaining({ path: REL, complete: true })]);
    expect(body.repositoryContext?.prompt).toContain('<p>Sunny, 24C</p>');
    expect(body.repositoryContext?.prompt).not.toContain('OnboardingView');
    // It continued the work: no "is this a new task?" interruption.
    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(2);
  });

  it('3. New Chat clears the binding: the same words no longer resolve to the earlier artifact', async () => {
    const { client, receive, posted } = await createWeatherWithSaath();
    receive({ type: 'newConversation' });
    await waitForPosted(posted, m => m.type === 'newConversation' && m.reset === true);
    const freshConversation = 'fresh-after-new-chat';
    receive({ type: 'sendMessage', mode: 'agent', text: 'add a login page to this html', conversationId: freshConversation });
    await waitForCalls(client, 'submit', 2, 8000);
    const body = client.calls.filter(c => c.method === 'submit').at(-1)!.args[0] as { repositoryContext?: { prompt: string } };
    // Ordinary retrieval may still find files by keyword, but nothing is bound to the earlier turn's artifact any more.
    expect(body.repositoryContext?.prompt ?? '').not.toContain('Referent resolved by the host');
  });

  it('4. "open this new html in browser" is answered by the host as an artifact action, never as "no browser tooling"', async () => {
    const { client, receive, posted, conversationId } = await createWeatherWithSaath();
    const openExternal = vi.spyOn(vscode.env, 'openExternal').mockResolvedValue(true);
    const submitsBefore = client.calls.filter(c => c.method === 'submit').length;
    receive({ type: 'sendMessage', mode: 'agent', text: 'open this new html in browser', conversationId });
    await waitForPosted(posted, m => m.type === 'done' && typeof m.content === 'string' && /Opened .*weather\.html in your browser/.test(m.content as string));
    expect(openExternal).toHaveBeenCalledTimes(1);
    // No model turn was spent on it.
    expect(client.calls.filter(c => c.method === 'submit')).toHaveLength(submitsBefore);
  });
});

describe('M53 durable Saath TaskResult: History reopen is inert (real AgentPanel)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-durable-'));
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

  /** The fake Core with what Core durably holds for the finished turn: its capability action, its structure check, and the ledger turn. */
  function durableClient() {
    const base = saathClient();
    const now = Date.now();
    const turn = {
      seq: 1, id: 'turn_1', conversationId: 'conv_1', requestId: 'req_1', attemptId: 'att_1', userMessageId: 'msg_0', assistantMessageIds: ['msg_1'],
      mode: 'saath_kar', taskId: null, approvalIds: ['appr_1'], outcome: 'completed', projectionId: 'proj_1',
      createdAt: new Date(now - 5000).toISOString(), updatedAt: new Date(now).toISOString(), terminalAt: new Date(now).toISOString(), schemaVersion: 1, migrationMetadata: {},
    };
    const withTurns = <T extends { turns: unknown[] }>(snapshot: T): T => ({ ...snapshot, turns: [turn] });
    const select = base.selectWorkspaceConversation.bind(base);
    const bind = base.bindWorkspaceConversation.bind(base);
    const read = base.getWorkspaceConversationLedger.bind(base);
    const liveInvocations = base.listToolInvocations.bind(base);
    return Object.assign(base, {
      selectWorkspaceConversation: async (...args: Parameters<typeof select>) => withTurns(await select(...args)),
      bindWorkspaceConversation: async (...args: Parameters<typeof bind>) => withTurns(await bind(...args)),
      getWorkspaceConversationLedger: async (...args: Parameters<typeof read>) => withTurns(await read(...args)),
      async listCapabilityActions() {
        return {
          attemptId: 'anchor_1',
          actions: [{
            approvalId: 'appr_1', attemptId: 'anchor_1', kind: 'mutation', status: 'approved', actionable: false, toolName: 'propose_file_change',
            arguments: { path: REL, content: WEATHER }, requestedAt: new Date(now - 3000).toISOString(), resolvedAt: new Date(now - 2000).toISOString(),
            resolution: 'approved', presentation: { kind: 'write_file_diff', path: REL, baseline: 'absent' }, outcome: 'succeeded',
            invocation: { id: 'inv_write', status: 'succeeded', exitCode: 0, evidence: { normalizedArguments: { path: REL, content: WEATHER } } },
          }],
        };
      },
      async listToolInvocations(attemptId: string) {
        if (attemptId !== 'att_1') return liveInvocations(attemptId);
        base.calls.push({ method: 'listToolInvocations', args: [attemptId] });
        return {
          toolInvocations: [{
            id: 'inv_check', attemptId, approvalId: null, toolName: 'static_html_check', argsSummary: { path: REL }, status: 'succeeded',
            startedAt: new Date(now - 1500).toISOString(), endedAt: new Date(now - 1400).toISOString(), exitCode: 0,
            evidence: { output: 'Static HTML structure check passed (parsed 1 document).' },
          }],
        };
      },
    });
  }

  const EXECUTION_CALLS = ['submit', 'executeAttempt', 'cancelAttempt', 'retryAttempt', 'approveCapability', 'resolveApproval'];

  it('Saath creates weather.html -> History reopen: the TaskResult/artifact still renders, nothing is sent to Core, and the old artifact is NOT a recent-artifact referent', async () => {
    const client = durableClient();
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const { receive, posted } = attachPanel(root);
    receive({ type: 'webviewReady', mode: 'chat' });
    const conversationId = 'saath-weather';

    // The turn happens live and is persisted by Core (the durable records above).
    receive({ type: 'sendMessage', mode: 'agent', text: `create ${REL} with a small weather page`, conversationId });
    await waitForCalls(client, 'executeAttempt', 1);
    client.conversationMessages.get('conv_1')!.push({ role: 'user', content: 'create weather' }, { role: 'assistant', content: 'Created weather.html' });
    manager.fireRuntimeEvent({ domain: 'tool_invocation', entityId: 'inv_write', eventType: 'capability_tool_invocation_completed', metadata: { attemptId: 'att_1', anchorAttemptId: 'anchor_1', toolName: 'propose_file_change', status: 'succeeded' } });
    manager.fireRuntimeEvent({ domain: 'attempt', entityId: 'att_1', eventType: 'attempt_transitioned', metadata: { to: 'completed' } });
    await waitForPosted(posted, m => m.type === 'taskResult' && !m.historical);

    // New Chat, then reopen the earlier conversation from History.
    receive({ type: 'newConversation' });
    await waitForPosted(posted, m => m.type === 'newConversation' && m.reset === true);
    const before = client.calls.filter(c => EXECUTION_CALLS.includes(c.method)).length;
    const mark = posted.length;
    const open = vi.spyOn(vscode.commands, 'executeCommand');
    const openExternal = vi.spyOn(vscode.env, 'openExternal');
    receive({ type: 'selectConversation', id: conversationId });
    const card = await (async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        const found = posted.slice(mark).find(m => m.type === 'taskResult' && m.historical === true);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`historical TaskResult never rendered. Posted: ${posted.slice(mark).map(m => m.type).join(', ')}`);
        await flush();
      }
    })();

    // 1. The card is re-derived from durable evidence: real artifact, the structure check as a structure check.
    const result = card.taskResult as { status: string; artifacts: Array<{ id: string; type: string; path: string }>; changes: { created: string[] }; evidence: Array<{ subject: string; ok?: boolean }> };
    expect(card.taskId).toBe('att_1');
    expect(result.status).toBe('completed');
    expect(result.artifacts).toEqual([expect.objectContaining({ type: 'html', path: REL })]);
    expect(result.changes.created).toEqual([REL]);
    expect(result.evidence.some(entry => /^structure check /.test(entry.subject) && entry.ok === true)).toBe(true);

    // 2. Inert: no execution message to Core, no tool/rail messages, nothing opened by itself.
    await flush(50);
    expect(client.calls.filter(c => EXECUTION_CALLS.includes(c.method))).toHaveLength(before);
    expect(posted.slice(mark).filter(m => ['toolStart', 'toolResult', 'autonomousTaskStatus'].includes(String(m.type)))).toEqual([]);
    expect(open).not.toHaveBeenCalledWith('vscode.open', expect.anything());
    expect(openExternal).not.toHaveBeenCalled();
    // The historical card's own Open is still the person's click, resolved by the host.
    receive({ type: 'taskResultAction', action: 'open', taskId: 'att_1', artifactId: result.artifacts[0].id });
    await flush(30);
    expect(open).toHaveBeenCalledWith('vscode.open', expect.anything());

    // 3. The visible historical artifact is not a referent: "modify this html" must not bind to weather.html.
    receive({ type: 'sendMessage', mode: 'agent', text: 'modify this html', conversationId });
    await waitForCalls(client, 'submit', 2, 8000);
    const body = client.calls.filter(c => c.method === 'submit').at(-1)!.args[0] as { repositoryContext?: { prompt: string; selectedFiles?: Array<{ path: string }> } };
    expect(body.repositoryContext?.prompt ?? '').not.toContain('Referent resolved by the host');
    // (Ordinary retrieval may still find the file by keyword; what must not happen is the host binding it as THE referent.)
    expect(body.repositoryContext?.prompt ?? '').not.toMatch(/Referent resolved|this html.*weather\.html/i);
  });
});

describe('M53 attachment persistence through a blocked turn (real AgentPanel)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m53-attach-'));
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

  it('a turn refused before Core committed it keeps its attachment: "resume" re-submits the SAME objective with the SAME attachment, no re-upload; New Chat clears it', async () => {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    let refusals = 1;
    const realSubmit = client.submit.bind(client);
    client.submit = (async (...args: unknown[]) => {
      if (refusals-- > 0) {
        client.calls.push({ method: 'submit', args });
        throw new Error('this turn includes an image attachment and requires a vision-capable model selection');
      }
      return realSubmit(...args);
    }) as typeof client.submit;
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const { receive, posted } = attachPanel(root);
    const conversationId = 'blocked-image';
    const objective = 'What is the red object in this picture?';

    receive({ type: 'sendMessage', mode: 'chat', text: objective, conversationId, attachmentIds: ['att-img-1'] });
    await waitForPosted(posted, m => m.type === 'error');
    expect(client.calls.filter(c => c.method === 'executeAttempt')).toHaveLength(0);

    receive({ type: 'sendMessage', mode: 'chat', text: 'resume', conversationId });
    await waitForCalls(client, 'executeAttempt', 1);
    const submits = client.calls.filter(c => c.method === 'submit');
    const resumed = submits.at(-1)!.args[0] as { currentMessage: string; attachmentIds: string[] };
    expect(resumed.attachmentIds).toEqual(['att-img-1']);
    expect(resumed.currentMessage).toBe(objective);
    expect(posted.some(m => m.type === 'executionQualityProgress' && /same attachment/.test(String(m.message)))).toBe(true);

    // Committed now: a second "resume" must not resurrect the attachment.
    receive({ type: 'sendMessage', mode: 'chat', text: 'resume', conversationId });
    await waitForCalls(client, 'submit', 3);
    expect((client.calls.filter(c => c.method === 'submit').at(-1)!.args[0] as { attachmentIds: string[] }).attachmentIds).toEqual([]);
  });

  it('New Chat drops a retained attachment', async () => {
    const client = withFakeConversationWorkingState(fakeCoreClient());
    let refusals = 1;
    const realSubmit = client.submit.bind(client);
    client.submit = (async (...args: unknown[]) => {
      if (refusals-- > 0) { client.calls.push({ method: 'submit', args }); throw new Error('blocked'); }
      return realSubmit(...args);
    }) as typeof client.submit;
    const manager = fakeCoreManager(client);
    dependencyMocks.getCoreManager.mockReturnValue(manager);
    const { receive, posted } = attachPanel(root);
    receive({ type: 'sendMessage', mode: 'chat', text: 'Describe the attachment', conversationId: 'c1', attachmentIds: ['att-1'] });
    await waitForPosted(posted, m => m.type === 'error');
    receive({ type: 'newConversation' });
    await waitForPosted(posted, m => m.type === 'newConversation' && m.reset === true);
    receive({ type: 'sendMessage', mode: 'chat', text: 'resume', conversationId: 'c2' });
    await waitForCalls(client, 'submit', 2, 8000);
    expect((client.calls.filter(c => c.method === 'submit').at(-1)!.args[0] as { attachmentIds: string[] }).attachmentIds).toEqual([]);
  });
});
