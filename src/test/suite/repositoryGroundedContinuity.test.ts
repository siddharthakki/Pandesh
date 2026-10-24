/**
 * Fixes exposed by the installed Durable Continuity acceptance run.
 *
 * B — `relevantFiles` must record the files the SYSTEM authoritatively used
 *     (the repository context actually selected for the turn, or a governed
 *     proposal's paths), never a path the user happened to type.
 * C — a natural question that names only an identifier ("Why does registerUser
 *     accept an empty username?") must be recognised as a repository question,
 *     by looking the identifier up in the repository index rather than by
 *     matching another keyword list.
 *
 * Both are driven through the real production seams: a real
 * `RepositoryContextService` over a real temporary repository, and the real
 * `AgentPanel` composer funnel against a real Core database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import { RepositoryContextService } from '../../context/RepositoryContextService';
import { openCoreDatabase } from '../../../core/db/openCore';
import type { CoreDatabase } from '../../../core/db/connection';
import { createConversation } from '../../../core/domain/conversations';
import {
  getConversationWorkingState,
  saveConversationWorkingState,
} from '../../../core/domain/conversationWorkingState';

interface PostedMessage { type: string; [key: string]: unknown }

const LOCAL_CONVERSATION_ID = 'default';
const USERS_JS = 'src/users.js';

function context(): vscode.ExtensionContext {
  const workspaceState = new Map<string, unknown>();
  const globalState = new Map<string, unknown>();
  return {
    subscriptions: [],
    extensionUri: vscode.Uri.file(process.cwd()),
    workspaceState: {
      get: (key: string) => workspaceState.get(key),
      update: async (key: string, value: unknown) => { workspaceState.set(key, value); },
    },
    globalState: {
      get: (key: string) => globalState.get(key),
      update: async (key: string, value: unknown) => { globalState.set(key, value); },
    },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } },
  } as unknown as vscode.ExtensionContext;
}

function coreBackedClient(getDb: () => CoreDatabase, coreConversationId: string) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let workspaceIdentity = '';
  return {
    calls,
    async getWorkspaceConversationLedger(identity: string) {
      workspaceIdentity = identity;
      return {
        schemaVersion: 1,
        workspaceIdentity,
        currentConversationId: LOCAL_CONVERSATION_ID,
        currentCoreConversationId: coreConversationId,
        conversations: [{
          workspaceIdentity,
          localConversationId: LOCAL_CONVERSATION_ID,
          conversationId: coreConversationId,
          title: 'Grounded conversation',
          createdAt: '2026-09-08T10:00:00.000Z',
          updatedAt: '2026-09-08T10:01:00.000Z',
          archivedAt: null,
          schemaVersion: 1,
          migrationMetadata: {},
        }],
        turns: [],
        migrationMetadata: {},
      };
    },
    async getConversationWorkingState(conversationId: string, identity: string) {
      calls.push({ method: 'getConversationWorkingState', args: [conversationId, identity] });
      return getConversationWorkingState(getDb(), conversationId, identity);
    },
    async saveConversationWorkingState(conversationId: string, input: Record<string, unknown>) {
      calls.push({ method: 'saveConversationWorkingState', args: [conversationId, input] });
      return saveConversationWorkingState(getDb(), conversationId, { ...input, actor: 'test:panel' } as never);
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) { return { workspaceRoot: args[0], attempts: [] }; },
    async listMessages() { return { messages: [] }; },
    async listConversationMessageAttachments() { return { byMessage: {} }; },
    async listConversationResearch() { return { research: [] }; },
    async listResponseAlternatives() { return { alternatives: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
  };
}

function manager(client: unknown) {
  return {
    getClient: () => client,
    onRuntimeEvent: () => ({ dispose: () => undefined }),
    onRuntimeToken: () => ({ dispose: () => undefined }),
    getStatus: () => ({ state: 'connected' }),
  };
}

let root: string;
let coreDirectory: string;
let databasePath: string;
let db: CoreDatabase;
let coreConversationId: string;
let indexRoot: string;

async function writeFixture(): Promise<void> {
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(path.join(root, USERS_JS), [
    'function registerUser(username) {',
    '  return { username, registeredAt: new Date().toISOString() };',
    '}',
    '',
    'function getDisplayName(user) {',
    '  return user.username;',
    '}',
    '',
    'module.exports = { registerUser, getDisplayName };',
    '',
  ].join('\n'), 'utf8');
  await fsp.writeFile(path.join(root, 'README.md'), '# Continuity grounding fixture\n', 'utf8');
}

async function sha256(relativePath: string): Promise<string> {
  return crypto.createHash('sha256').update(await fsp.readFile(path.join(root, relativePath))).digest('hex');
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-grounded-workspace-'));
  coreDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-grounded-core-'));
  indexRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-grounded-index-'));
  // Isolate the repository index so concurrent runs cannot contend on one
  // workspace index (the known SQLITE_BUSY degradation).
  process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT = indexRoot;
  databasePath = path.join(coreDirectory, 'core.db');
  db = openCoreDatabase(databasePath).db;
  coreConversationId = createConversation(db, { mode: 'baat_kar', actor: 'test:actor' }).id;
  await writeFixture();
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT;
  db.close();
  for (const dir of [root, coreDirectory, indexRoot]) {
    await fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('C — a natural identifier-only question is recognised as a repository question', () => {
  it('confirms an identifier against the real repository index instead of a keyword list', async () => {
    const service = new RepositoryContextService(root);

    // The exact acceptance question names no file, folder or repository noun.
    expect(await service.findKnownSymbols(['registerUser'])).toEqual(['registerUser']);
    expect(await service.findKnownSymbols(['getDisplayName'])).toEqual(['getDisplayName']);

    // A camelCase-looking token that is not a symbol here is NOT confirmed —
    // the index, not the shape of the word, is what decides.
    expect(await service.findKnownSymbols(['paymentValidator'])).toEqual([]);
    expect(await service.findKnownSymbols(['JavaScript', 'TCP', 'UDP'])).toEqual([]);
  });

  it('routes the exact acceptance question to repository context, and ordinary chat away from it', async () => {
    const panel = new AgentPanel(context(), root);
    const gate = (text: string) => (panel as never as {
      isRepositoryContextQuestion: (t: string) => Promise<boolean>;
    }).isRepositoryContextQuestion(text);

    // Must ground — these are the milestone's listed examples.
    expect(await gate('Why does registerUser accept an empty username?')).toBe(true);
    expect(await gate('What calls registerUser?')).toBe(true);
    expect(await gate('What tests cover getDisplayName?')).toBe(true);

    // Must stay ordinary conversation.
    expect(await gate('Explain the difference between TCP and UDP.')).toBe(false);
    expect(await gate('Write me a haiku about the sea.')).toBe(false);
    expect(await gate('What is your favourite colour?')).toBe(false);

    // An identifier this repository does not contain is not enough on its own.
    expect(await gate('Where is paymentValidator used?')).toBe(false);
    // …but naming a repository noun still grounds it, as it always did.
    expect(await gate('Where is paymentValidator used in this repository?')).toBe(true);
  });

  it('selects the file that defines the identifier into the bounded context package', async () => {
    const service = new RepositoryContextService(root);
    const selected = await service.build({
      query: 'Why does registerUser accept an empty username?',
      mode: 'chat',
      model: 'test-model',
      tokenBudget: 4096,
    });
    expect(selected.files.map(file => file.path)).toContain(USERS_JS);
    expect(selected.prompt).toContain('registerUser');
  });
});

describe('B — relevantFiles come from authoritative repository use', () => {
  async function launch(client: unknown) {
    const posted: PostedMessage[] = [];
    vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
    const panel = new AgentPanel(context(), root);
    panel.resolveWebviewView({
      webview: {
        options: {}, html: '', cspSource: 'vscode-webview://grounded-test',
        asWebviewUri: (uri: vscode.Uri) => uri,
        postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
      },
      show: () => undefined,
      onDidDispose: () => ({ dispose: () => undefined }),
      visible: true,
    } as unknown as vscode.WebviewView, {} as never, {} as never);
    (panel as never as { webviewReady: boolean }).webviewReady = true;
    await (panel as never as { completeWorkspaceRestoration: () => Promise<void> }).completeWorkspaceRestoration();
    return { panel, posted };
  }

  /** Drives the real composer funnel, standing in for the model call with the
   * real repository-context selection the production path would have run. */
  async function turn(panel: AgentPanel, text: string, mode: 'chat' | 'agent' = 'chat'): Promise<void> {
    const route = (panel as never as {
      routeComposerSubmission: (t: string, submit: (e: string) => Promise<void>, m: string) => Promise<void>;
    }).routeComposerSubmission.bind(panel);
    await route(text, async () => {
      await (panel as never as {
        buildSupplementalRepositoryContext: (
          text: string, kind: string, mode: string, selection: unknown,
        ) => Promise<unknown>;
      }).buildSupplementalRepositoryContext(
        text,
        mode === 'chat' ? 'baat_kar' : 'saath_kar',
        mode,
        { selectedModel: 'test-model', selectedProvider: 'ollama' },
      );
    }, mode);
  }

  it('records the file the repository context actually used, though the user typed no path', async () => {
    const client = coreBackedClient(() => db, coreConversationId);
    const { panel, posted } = await launch(client);
    const identity = posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

    await turn(panel, 'Why does registerUser accept an empty username?');

    const state = getConversationWorkingState(db, coreConversationId, identity)!;
    expect(state.relevantFiles.map(file => file.path)).toContain(USERS_JS);
    const stored = state.relevantFiles.find(file => file.path === USERS_JS)!;
    expect(stored.contentHash).toBe(await sha256(USERS_JS));
    expect(state.relevantSymbols).toContain('registerUser');
  });

  it('does not persist a filename merely because the user typed it', async () => {
    const client = coreBackedClient(() => db, coreConversationId);
    const { panel, posted } = await launch(client);
    const identity = posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

    await turn(panel, 'Why does registerUser fail? I think the bug is in src/totally/imaginary.ts.');

    const state = getConversationWorkingState(db, coreConversationId, identity)!;
    const paths = state.relevantFiles.map(file => file.path);
    expect(paths).not.toContain('src/totally/imaginary.ts');
    // Every stored entry is a real file with a real hash of its real bytes.
    for (const file of state.relevantFiles) {
      expect(file.contentHash).toBe(await sha256(file.path));
    }
  });

  it('detects a hash mismatch after the repository changes while closed, and asks instead of acting', async () => {
    const first = await launch(coreBackedClient(() => db, coreConversationId));
    const identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first.panel, 'Why does registerUser accept an empty username?');
    const before = getConversationWorkingState(db, coreConversationId, identity)!;
    expect(before.relevantFiles.map(file => file.path)).toContain(USERS_JS);

    // Someone edits the very file the objective was grounded in.
    await fsp.writeFile(path.join(root, USERS_JS), [
      'function registerUser(username) {',
      '  if (!username) throw new Error("username is required");',
      '  return { username, registeredAt: new Date().toISOString() };',
      '}',
      'module.exports = { registerUser };',
      '',
    ].join('\n'), 'utf8');

    // Core restart + fresh panel.
    db.close();
    db = openCoreDatabase(databasePath).db;
    const second = await launch(coreBackedClient(() => db, coreConversationId));

    const cue = second.posted.find(m => m.type === 'conversationContinuity')!;
    expect(cue.repositoryChanged).toBe(true);

    const submissions: string[] = [];
    const route = (second.panel as never as {
      routeComposerSubmission: (t: string, submit: (e: string) => Promise<void>, m: string) => Promise<void>;
    }).routeComposerSubmission.bind(second.panel);
    await route('Continue.', async (effective: string) => { submissions.push(effective); }, 'agent');

    expect(submissions).toEqual([]);
    const asked = second.posted.filter(m => m.type === 'done').at(-1)!;
    expect(asked.content).toMatch(/repository has changed/i);
    expect(asked.content).toContain(USERS_JS);
  });
});
