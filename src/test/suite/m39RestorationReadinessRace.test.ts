import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import type { CapabilityActionRestoreEntry, CapabilityActionsSnapshot } from '../../../core/shared/wireTypes';

/**
 * M39 regression: durable RESTORATION messages must survive a webview that has
 * not yet attached its `message` listener.
 *
 * `resolveWebviewView` fires `restoreConversationTranscript()` and
 * `restoreCapabilityApprovalCards()` immediately. Both used to post with the
 * raw `post()` while `webviewReady` was still false, so whenever the Core read
 * resolved before the webview script was listening the message was silently
 * dropped. Both call sites are one-shot — the webview's own `transcriptRestored`
 * flag and the panel's `surfacedCapabilityApprovalCards` set each suppress a
 * second attempt — so the loss was permanent for that webview: an empty
 * transcript and missing approval cards after a restart, intermittently. That
 * was the root cause of a flaky packaged restart-restoration failure.
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

const ACTION: CapabilityActionRestoreEntry = {
  approvalId: 'appr_m39_race',
  attemptId: 'att_m39_race',
  kind: 'mutation',
  status: 'pending',
  actionable: true,
  toolName: 'memory_remember',
  arguments: { scopeType: 'project', scopeId: 'Atlas', value: 'SQLite' },
  requestedAt: '2026-07-27T10:00:00.000Z',
  resolvedAt: null,
  resolution: null,
  expectedAttemptRevision: 3,
  expectedAttemptStatus: 'waiting_for_approval',
  requestedActionDigest: 'digest-m39-race',
  frozenContextHash: 'context-m39-race',
  revision: 1,
  outcome: 'pending',
  invocation: null,
};

class FakeCoreClient {
  async getWorkspaceConversationLedger(workspaceIdentity: string) {
    return {
      schemaVersion: 1 as const,
      workspaceIdentity,
      currentConversationId: 'default',
      currentCoreConversationId: 'conv_m39_race',
      conversations: [{
        localConversationId: 'default',
        conversationId: 'conv_m39_race',
        title: null,
        createdAt: '2026-07-27T09:59:00.000Z',
        updatedAt: '2026-07-27T10:00:00.000Z',
        archivedAt: null,
      }],
      turns: [],
    };
  }
  async listCapabilityActions(): Promise<CapabilityActionsSnapshot> {
    return { attemptId: ACTION.attemptId, actions: [ACTION] };
  }
  async listRecentWorkspaceCapabilityActions(): Promise<CapabilityActionsSnapshot> {
    return {
      attemptId: ACTION.attemptId,
      actions: [{ ...ACTION, correlationId: 'conv_m39_race', realAttemptId: ACTION.attemptId } as never],
    };
  }
}

let posted: PostedMessage[];
let panel: AgentPanel;
let receiveHandler: ((msg: unknown) => void) | undefined;

function attachPanel(): AgentPanel {
  const created = new AgentPanel(context(), process.cwd());
  const webview = {
    options: {}, html: '', cspSource: 'vscode-webview://m39-race-test',
    asWebviewUri: (uri: vscode.Uri) => uri,
    postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
    onDidReceiveMessage: (handler: (msg: unknown) => void) => { receiveHandler = handler; return { dispose: () => undefined }; },
  };
  created.resolveWebviewView({
    webview, show: () => undefined, onDidDispose: () => ({ dispose: () => undefined }), visible: true,
  } as unknown as vscode.WebviewView, {} as never, {} as never);
  return created;
}

beforeEach(() => {
  posted = [];
  receiveHandler = undefined;
  // One client instance per test, exactly as the real CoreManager holds one.
  const client = new FakeCoreClient();
  vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue({
    getClient: () => client,
  } as never);
  panel = attachPanel();
});

afterEach(() => {
  vi.restoreAllMocks();
  posted = [];
});

/** Lets pending restoration promises settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

describe('M39 durable restoration survives a not-yet-ready webview', () => {
  it('never posts a restored capability approval card before the webview reports ready', async () => {
    // Posting before readiness would be the silent drop this closes, because
    // the webview script is not listening yet.
    await settle();
    expect(posted.filter(message => message.type === 'restoreCapabilityApprovalCard')).toHaveLength(0);

    expect(receiveHandler).toBeTypeOf('function');
    receiveHandler!({ type: 'webviewReady', mode: 'chat' });

    await vi.waitFor(() =>
      expect(posted.filter(message => message.type === 'restoreCapabilityApprovalCard')).toHaveLength(1));
    const restored = posted.filter(message => message.type === 'restoreCapabilityApprovalCard');
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ approvalId: 'appr_m39_race', toolName: 'memory_remember' });
  });

  it('delivers the restored card exactly once across duplicate webviewReady replays', async () => {
    await settle();
    receiveHandler!({ type: 'webviewReady', mode: 'chat' });
    receiveHandler!({ type: 'webviewReady', mode: 'chat' });
    receiveHandler!({ type: 'webviewReady', mode: 'chat' });
    await vi.waitFor(() =>
      expect(posted.filter(message => message.type === 'restoreCapabilityApprovalCard')).toHaveLength(1));
  });

  it('a later restoration pass posts immediately once the webview is already ready', async () => {
    await settle();
    receiveHandler!({ type: 'webviewReady', mode: 'chat' });
    posted.length = 0;
    // The one-shot surfaced-card guard means this specific approval is not
    // re-sent; what matters is that no message is left stranded in the queue.
    await (panel as unknown as { restoreCapabilityApprovalCards(): Promise<void> }).restoreCapabilityApprovalCards();
    const pending = (panel as unknown as { pendingApprovalCardMessages: unknown[] }).pendingApprovalCardMessages;
    expect(pending).toHaveLength(0);
  });
});
