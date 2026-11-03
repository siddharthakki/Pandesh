/**
 * An Auto grant chosen before its conversation exists is bound to the workspace selected when the user chose it. A
 * different folder by the time the conversation is created, starting another new conversation, opening another one,
 * or a conversation created outside the chat composer never inherits it: the new conversation stays in Ask.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSession } from '../src/host/desktopSession';

type Internals = {
  client: unknown;
  coreState: string;
  folder: string | null;
  selectedConversationId: string | null;
  pendingPermission: unknown;
  applyPendingPermission(conversationId: string): Promise<void>;
  ensureCapabilityConversation(title: string): Promise<string>;
};

let dataDir: string;
let host: DesktopSession;
let internal: Internals;
let calls: Array<{ op: string; conversationId: string; [k: string]: unknown }>;
const grant = { categories: ['workspace_validation'], expiresInMinutes: 60 };

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-pending-permission-'));
  host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  internal = host as unknown as Internals;
  calls = [];
  internal.client = {
    setConversationPermissionMode: async (conversationId: string, mode: string) => { calls.push({ op: 'mode', conversationId, mode }); return {}; },
    grantStandingAuthorization: async (conversationId: string, input: Record<string, unknown>) => { calls.push({ op: 'grant', conversationId, ...input }); return {}; },
    getConversationPermission: async () => ({ mode: 'ask', authorizations: [], categories: {} }),
    createConversation: async () => ({ id: 'conv-capability' }),
  };
  internal.coreState = 'connected';
  internal.folder = path.join(dataDir, 'repo-a');
  internal.selectedConversationId = null;
});
afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

describe('an Auto grant chosen before its conversation exists', () => {
  it('is granted for the folder selected when it was chosen', async () => {
    await host.setPermissionMode('auto', grant);
    expect(calls).toEqual([]);
    await internal.applyPendingPermission('conv-1');
    expect(calls).toEqual([
      { op: 'mode', conversationId: 'conv-1', mode: 'auto' },
      { op: 'grant', conversationId: 'conv-1', categories: grant.categories, workspaceRoot: path.join(dataDir, 'repo-a'), expiresInMinutes: 60 },
    ]);
  });

  it('is not applied when the workspace changed before the conversation was created', async () => {
    await host.setPermissionMode('auto', grant);
    internal.folder = path.join(dataDir, 'repo-b');
    await internal.applyPendingPermission('conv-1');
    expect(calls).toEqual([]);
    expect(internal.pendingPermission).toBeNull();
  });

  it('is discarded by starting another new conversation', async () => {
    await host.setPermissionMode('auto', grant);
    await host.newConversation();
    await internal.applyPendingPermission('conv-2');
    expect(calls).toEqual([]);
  });

  it('is discarded when a conversation is created outside the chat composer', async () => {
    await host.setPermissionMode('auto', grant);
    expect(await internal.ensureCapabilityConversation('weather')).toBe('conv-capability');
    expect(internal.pendingPermission).toBeNull();
    await internal.applyPendingPermission('conv-later');
    expect(calls).toEqual([]);
  });

  it('shows which folder it is bound to while pending', async () => {
    const snapshot = await host.setPermissionMode('auto', grant);
    expect(snapshot.permission).toMatchObject({ mode: 'auto', pending: true, pendingWorkspaceRoot: path.join(dataDir, 'repo-a') });
  });

  it('an existing conversation is granted for the folder selected at the moment of the grant', async () => {
    internal.selectedConversationId = 'conv-existing';
    await host.setPermissionMode('auto', grant);
    expect(calls.find((c) => c.op === 'grant')).toMatchObject({ conversationId: 'conv-existing', workspaceRoot: path.join(dataDir, 'repo-a') });
  });
});
