import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';

/**
 * New Chat must be atomic. Live UAT: after opening Karke Dikha on a repository the previous conversation was still
 * on screen and a SECOND click was needed. Cause: startup hydration (transcript restore, ledger read, rehydration)
 * was still in flight when New Chat ran; its late result repainted the old conversation after the reset. Every
 * asynchronous hydration now captures the conversation epoch it started under and discards itself when New Chat
 * has advanced it.
 */

interface PostedMessage { type: string; [key: string]: unknown }

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
    globalState: { get: () => undefined, update: async () => undefined },
  } as unknown as vscode.ExtensionContext;
}

let releaseMessages: () => void;
let messagesGate: Promise<void>;
let ledgerReads = 0;
let transcriptReads = 0;

class FakeCoreClient {
  async getWorkspaceConversationLedger(workspaceIdentity: string) {
    ledgerReads += 1;
    return {
      schemaVersion: 1 as const, workspaceIdentity, currentConversationId: 'default', currentCoreConversationId: 'conv_old',
      conversations: [{ localConversationId: 'default', conversationId: 'conv_old', title: 'Old chat', createdAt: '2026-10-01T09:00:00.000Z', updatedAt: '2026-10-01T10:00:00.000Z', archivedAt: null }],
      turns: [],
    };
  }
  async createConversation(input: { title?: string | null }) { return { id: 'conv_new', title: input.title ?? null }; }
  async bindWorkspaceConversation(input: { workspaceIdentity: string; localConversationId: string; conversationId: string; title: string | null }) {
    return {
      schemaVersion: 1 as const, workspaceIdentity: input.workspaceIdentity, currentConversationId: input.localConversationId, currentCoreConversationId: input.conversationId,
      conversations: [{ localConversationId: input.localConversationId, conversationId: input.conversationId, title: input.title, createdAt: '2026-10-05T09:00:00.000Z', updatedAt: '2026-10-05T09:00:00.000Z', archivedAt: null }],
      turns: [],
    };
  }
  async listMessages() {
    transcriptReads += 1;
    await messagesGate; // the Core read that is still in flight when the user clicks New Chat
    return { messages: [{ id: 'm1', role: 'user', content: 'OLD PROMPT FROM THE PREVIOUS CONVERSATION' }, { id: 'm2', role: 'assistant', content: 'old answer' }] };
  }
  async listConversationMessageAttachments() { return { byMessage: {} }; }
  async listConversationResearch() { return { research: [] }; }
  async listResponseAlternatives() { return { alternatives: [] }; }
  async getConversationBranch() { return { branch: null }; }
  async listMessageCitations() { return { citations: [] }; }
  async listCapabilityActions() { return { attemptId: 'a', actions: [] }; }
  async listRecentWorkspaceCapabilityActions() { return { attemptId: 'a', actions: [] }; }
}

let posted: PostedMessage[];
let panel: AgentPanel;
let receive: (msg: unknown) => void;

function attach(): AgentPanel {
  const created = new AgentPanel(context(), process.cwd());
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://new-chat-epoch',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => { receive = handler; return { dispose: () => undefined }; },
  };
  created.resolveWebviewView({ webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true } as unknown as vscode.WebviewView, {} as never, {} as never);
  return created;
}

beforeEach(() => {
  posted = [];
  ledgerReads = 0;
  transcriptReads = 0;
  messagesGate = new Promise<void>(resolve => { releaseMessages = resolve; });
  const client = new FakeCoreClient();
  vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({ getClient: () => client } as never);
  panel = new AgentPanel(context(), process.cwd());
  (panel as unknown as { startupSelectedConversationId?: string }).startupSelectedConversationId = 'default';
  panel = attach();
  (panel as unknown as { startupSelectedConversationId?: string }).startupSelectedConversationId = 'default';
});

afterEach(() => { vi.restoreAllMocks(); });

const settle = async (turns = 8) => { for (let i = 0; i < turns; i += 1) await Promise.resolve(); };

describe('New Chat is atomic (conversation epoch guard)', () => {
  it('advances the epoch synchronously, before any await', async () => {
    const priv = panel as unknown as { conversationEpoch: number };
    const before = priv.conversationEpoch;
    receive({ type: 'newConversation' });
    expect(priv.conversationEpoch).toBe(before + 1);
  });

  it('one New Chat yields a fresh conversation and a late transcript restore from the old one is discarded', async () => {
    receive({ type: 'webviewReady', mode: 'chat' });
    await settle();
    // Startup hydration is now parked on the Core transcript read of the OLD conversation.
    const priv = panel as unknown as { conversationEpoch: number; conversationId: string };
    await vi.waitFor(() => { if (transcriptReads === 0) throw new Error('transcript read not started'); });
    const restoreEpoch = priv.conversationEpoch;

    receive({ type: 'newConversation' });
    await vi.waitFor(() => { if (!posted.some(m => m.type === 'newConversation' && m.reset === true)) throw new Error('reset not posted yet'); });
    const reset = posted.find(m => m.type === 'newConversation' && m.reset === true)!;
    expect(reset['epoch']).toBe(restoreEpoch + 1);
    expect(priv.conversationId).toBe(reset['id']);
    const marker = posted.length;

    // The old hydration finally completes ...
    releaseMessages();
    await settle(20);
    await new Promise(resolve => setTimeout(resolve, 20));

    // ... and nothing from the previous conversation reaches the webview after the reset.
    const after = posted.slice(marker);
    expect(after.filter(m => m.type === 'restoreTranscript')).toHaveLength(0);
    expect(posted.filter(m => m.type === 'restoreTranscript')).toHaveLength(0);
    expect(priv.conversationId).toBe(reset['id']);
    expect(posted.filter(m => m.type === 'newConversation' && m.reset === true)).toHaveLength(1);
  });

  it('drops queued hydration messages that belong to a replaced conversation', async () => {
    const priv = panel as unknown as {
      conversationEpoch: number;
      postApprovalCardMessage(msg: Record<string, unknown>, epoch?: number): void;
      flushPendingApprovalCardMessages(): void;
      pendingApprovalCardMessages: Array<Record<string, unknown>>;
    };
    // Webview not ready yet: the restore message is queued under the current epoch ...
    priv.postApprovalCardMessage({ type: 'restoreTranscript', messages: [{ id: 'x', role: 'user', content: 'stale' }] });
    expect(priv.pendingApprovalCardMessages).toHaveLength(1);
    receive({ type: 'newConversation' }); // ... New Chat clears the queue and advances the epoch ...
    expect(priv.pendingApprovalCardMessages).toHaveLength(0);
    // ... and a caller that captured the old epoch can no longer enqueue or post at all.
    priv.postApprovalCardMessage({ type: 'restoreTranscript', messages: [] }, priv.conversationEpoch - 1);
    expect(priv.pendingApprovalCardMessages).toHaveLength(0);
  });

  it('resets host-side conversation state: evidence files, referents, projections', async () => {
    const priv = panel as unknown as {
      authoritativeTurnFiles: string[]; dhaagaRuns: Map<string, unknown>; establishedProjects: Map<string, string>;
      repoFastPath: { resetConversationState: () => void };
    };
    const reset = vi.spyOn(priv.repoFastPath, 'resetConversationState');
    priv.authoritativeTurnFiles.push('media/chat.html');
    priv.dhaagaRuns.set('run-old', {});
    priv.establishedProjects.set('default', 'apps/old');
    receive({ type: 'newConversation' });
    await vi.waitFor(() => { if (!posted.some(m => m.type === 'newConversation' && m.reset === true)) throw new Error('reset not posted yet'); });
    expect(priv.authoritativeTurnFiles).toEqual([]);
    expect(priv.dhaagaRuns.size).toBe(0);
    expect(priv.establishedProjects.size).toBe(0);
    expect(reset).toHaveBeenCalled();
  });
});
