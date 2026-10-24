/**
 * Jarvis Conversations rail Checkpoint 1 — proves `selectedConversationId`
 * persistence (`desktopConversationSelection.ts`, mirroring
 * `desktopModelSelection.ts`'s exact shape) and `submitTask`'s conversationId
 * resolution: a follow-up in an opened conversation reuses the same Core
 * conversation ID, a brand-new session lazily creates one, and
 * `newConversation()` starts clean without inheriting the prior objective.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTO_MODEL, DesktopSession } from '../src/host/desktopSession';
import {
  readSelectedConversation,
  writeSelectedConversation,
  clearSelectedConversation,
  selectedConversationFile,
} from '../src/host/desktopConversationSelection';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-conv-selection-'));
  dirs.push(dir);
  return dir;
}

type FakeClient = {
  createConversation(input: unknown): Promise<{ id: string }>;
  submit(input: Record<string, unknown>): Promise<{ request: { id: string }; attempt: { id: string }; modelSelection: { selectedModel: string } }>;
  executeAttempt(id: string, input: unknown): Promise<void>;
  getConversation?(id: string): Promise<Record<string, unknown>>;
  listMessages?(id: string, query?: unknown): Promise<{ messages: unknown[] }>;
  listConversations?(query?: unknown): Promise<{ conversations: unknown[] }>;
  exportConversation?(id: string, format: 'json' | 'markdown'): Promise<unknown>;
  getConversationWorkingState?(id: string, workspaceIdentity: string): Promise<null>;
};

function installFakeClient(host: DesktopSession, overrides: Partial<FakeClient> = {}): { createCalls: number } {
  let createCalls = 0;
  const adapter = host as unknown as { client: FakeClient; coreState: string };
  adapter.coreState = 'connected';
  adapter.client = {
    createConversation: async () => {
      createCalls += 1;
      return { id: `conv_${createCalls}` };
    },
    submit: async () => ({ request: { id: 'req' }, attempt: { id: 'att' }, modelSelection: { selectedModel: 'jarvis-qwen3.8:27b-gsq' } }),
    executeAttempt: async () => undefined,
    ...overrides,
  };
  return { get createCalls() { return createCalls; } };
}

async function readySession(): Promise<{ host: DesktopSession; dataDir: string }> {
  const dataDir = freshDataDir();
  const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  await host.selectModel(AUTO_MODEL);
  return { host, dataDir };
}

/** The fake `executeAttempt` never emits the runtime event that marks a turn
 * terminal, so a test driving two sequential submits must do it itself —
 * mirrors how a real attempt reaches `completed`/`failed`/`cancelled`. */
function markActiveTerminal(host: DesktopSession): void {
  const adapter = host as unknown as { active: { terminal: boolean } | null };
  if (adapter.active) adapter.active.terminal = true;
}

describe('desktopConversationSelection.ts — persistence primitives', () => {
  it('returns null when no selection file exists', () => {
    const dataDir = freshDataDir();
    expect(readSelectedConversation(dataDir)).toBeNull();
  });

  it('round-trips a written selection', () => {
    const dataDir = freshDataDir();
    writeSelectedConversation(dataDir, 'conv_abc');
    expect(readSelectedConversation(dataDir)).toBe('conv_abc');
    expect(fs.existsSync(selectedConversationFile(dataDir))).toBe(true);
  });

  it('clear removes the file and read falls back to null', () => {
    const dataDir = freshDataDir();
    writeSelectedConversation(dataDir, 'conv_abc');
    clearSelectedConversation(dataDir);
    expect(readSelectedConversation(dataDir)).toBeNull();
    expect(fs.existsSync(selectedConversationFile(dataDir))).toBe(false);
  });

  it('clearing when no file exists is a harmless no-op', () => {
    const dataDir = freshDataDir();
    expect(() => clearSelectedConversation(dataDir)).not.toThrow();
  });
});

describe('DesktopSession — conversation selection and submitTask continuity', () => {
  it('a brand-new session lazily creates a conversation on first submit and persists it as selected', async () => {
    const { host, dataDir } = await readySession();
    const fake = installFakeClient(host);
    await host.submitTask('What does this project do?', 'local-core');
    expect(fake.createCalls).toBe(1);
    expect(host.snapshot().selectedConversationId).toBe('conv_1');
    expect(readSelectedConversation(dataDir)).toBe('conv_1');
  });

  it('a follow-up submit in the same session reuses the same conversation ID — no second create call', async () => {
    const { host } = await readySession();
    const fake = installFakeClient(host);
    await host.submitTask('What does this project do?', 'local-core');
    markActiveTerminal(host);
    await host.submitTask('Now explain the tests', 'local-core');
    expect(fake.createCalls).toBe(1);
    expect(host.snapshot().selectedConversationId).toBe('conv_1');
    expect(host.snapshot().activeConversationId).toBe('conv_1');
  });

  it('newConversation clears the selection so the next submit creates a genuinely fresh conversation', async () => {
    const { host, dataDir } = await readySession();
    const fake = installFakeClient(host);
    await host.submitTask('First objective', 'local-core');
    markActiveTerminal(host);
    expect(host.snapshot().selectedConversationId).toBe('conv_1');

    await host.newConversation();
    expect(host.snapshot().selectedConversationId).toBeNull();
    expect(readSelectedConversation(dataDir)).toBeNull();

    await host.submitTask('Unrelated second objective', 'local-core');
    expect(fake.createCalls).toBe(2);
    expect(host.snapshot().selectedConversationId).toBe('conv_2');
  });

  it('openConversation selects and persists an existing conversation, and the next submit continues it (not a new one)', async () => {
    const { host, dataDir } = await readySession();
    const fake = installFakeClient(host, {
      getConversation: async (id: string) => ({
        id, mode: 'baat_kar', projectId: null, repositoryId: null, title: 'Older chat',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1,
      }),
      listMessages: async () => ({ messages: [
        { seq: 1, id: 'm1', conversationId: 'conv_existing', role: 'user', content: 'hi', modelInvocationId: null, createdAt: '2026-09-01T00:00:00.000Z' },
      ] }),
      listConversations: async () => ({ conversations: [
        { id: 'conv_existing', mode: 'baat_kar', title: 'Older chat', preview: 'hi', state: 'active', repositoryName: null,
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1 },
      ] }),
      exportConversation: async () => ({ format: 'json', content: {
        schemaVersion: 1, exportedAt: '2026-09-01T00:00:00.000Z',
        conversation: { id: 'conv_existing', mode: 'baat_kar', projectId: null, repositoryId: null, title: 'Older chat', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1 },
        branch: null, messages: [], research: [],
      } }),
      getConversationWorkingState: async () => null,
    });

    const opened = await host.openConversation('conv_existing');
    expect(opened.conversation.id).toBe('conv_existing');
    expect(opened.messages).toHaveLength(1);
    expect(host.snapshot().selectedConversationId).toBe('conv_existing');
    expect(readSelectedConversation(dataDir)).toBe('conv_existing');

    await host.submitTask('continue this thread', 'local-core');
    expect(fake.createCalls).toBe(0); // never created a new conversation — reused the opened one
    expect(host.snapshot().selectedConversationId).toBe('conv_existing');
  });

  it('an in-flight passive refresh cannot undo New; explicit navigation still selects the task', async () => {
    const { host, dataDir } = await readySession();
    const fake = installFakeClient(host, {
      getConversation: async (id: string) => ({
        id, mode: 'baat_kar', projectId: null, repositoryId: null, title: 'Older chat',
        createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1,
      }),
      listMessages: async () => ({ messages: [
        { seq: 1, id: 'm1', conversationId: 'conv_existing', role: 'user', content: 'hi', modelInvocationId: null, createdAt: '2026-09-01T00:00:00.000Z' },
      ] }),
      listConversations: async () => ({ conversations: [
        { id: 'conv_existing', mode: 'baat_kar', title: 'Older chat', preview: 'hi', state: 'active', repositoryName: null,
          createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1 },
      ] }),
      exportConversation: async () => ({ format: 'json', content: {
        schemaVersion: 1, exportedAt: '2026-09-01T00:00:00.000Z',
        conversation: { id: 'conv_existing', mode: 'baat_kar', projectId: null, repositoryId: null, title: 'Older chat', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', archivedAt: null, pinnedAt: null, revision: 1 },
        branch: null, messages: [], research: [],
      } }),
      getConversationWorkingState: async () => null,
    });

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const adapter = host as unknown as { client: FakeClient };
    const originalRead = adapter.client.getConversation!;
    adapter.client.getConversation = async id => { await gate; return originalRead(id); };
    const refresh = host.openConversation('conv_existing', false);
    await host.newConversation();
    release();
    await refresh;
    expect(host.snapshot().selectedConversationId).toBeNull();
    expect(readSelectedConversation(dataDir)).toBeNull();
    const opened = await host.openConversation('conv_existing');
    expect(opened.conversation.id).toBe('conv_existing');
    expect(opened.messages).toHaveLength(1);
    expect(host.snapshot().selectedConversationId).toBe('conv_existing');
    expect(readSelectedConversation(dataDir)).toBe('conv_existing');

    await host.submitTask('continue this thread', 'local-core');
    expect(fake.createCalls).toBe(0); // never created a new conversation — reused the opened one
    expect(host.snapshot().selectedConversationId).toBe('conv_existing');
  });

  it('the selected conversation restores across a restart (fresh DesktopSession over the same dataDir)', async () => {
    const { host, dataDir } = await readySession();
    installFakeClient(host);
    await host.submitTask('What does this project do?', 'local-core');
    expect(host.snapshot().selectedConversationId).toBe('conv_1');

    const restarted = new DesktopSession({ productRoot: process.cwd(), dataDir });
    expect(restarted.snapshot().selectedConversationId).toBe('conv_1');
  });
});
