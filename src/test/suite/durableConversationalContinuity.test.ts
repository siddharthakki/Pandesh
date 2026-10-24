/**
 * Durable Conversational Continuity V1 — standing product tests (milestone
 * Step 8, scenarios A–I).
 *
 * These drive the REAL `AgentPanel` composer funnel (`routeComposerSubmission`
 * and the `sendMessage`/`startAutonomousTask` webview messages) against a REAL
 * Core SQLite database, so "survives a restart" means the row genuinely came
 * back from disk through a reopened database and a freshly constructed panel —
 * not from a mock that happened to remember it.
 *
 * Only the model-facing submission itself is stubbed (`handleUserMessage` /
 * `startAutonomousTask`), because these tests are about which turn is
 * submitted, with what text, under which policy — not about inference.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import * as extensionModule from '../../extension';
import { openCoreDatabase } from '../../../core/db/openCore';
import type { CoreDatabase } from '../../../core/db/connection';
import { createConversation } from '../../../core/domain/conversations';
import {
  getConversationWorkingState,
  saveConversationWorkingState,
} from '../../../core/domain/conversationWorkingState';
import { decideExecutionPolicy } from '../../orchestration/ExecutionPolicyRouter';
import {
  detectObjectiveBoundary,
  extractConstraints,
  reconcileConstraints,
  resolveFollowUp,
  continuityCue,
} from '../../orchestration/ConversationContinuity';
import type { ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';

interface PostedMessage { type: string; [key: string]: unknown }

const LOCAL_CONVERSATION_ID = 'default';

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

/**
 * A Core client whose conversation ledger and working-state routes are backed
 * by the real Core domain functions on a real database file. Everything else
 * is the minimum the restoration path reads.
 */
function coreBackedClient(getDb: () => CoreDatabase, coreConversationId: string) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  let workspaceIdentity = '';
  const ledger = () => ({
    schemaVersion: 1,
    workspaceIdentity,
    currentConversationId: LOCAL_CONVERSATION_ID,
    currentCoreConversationId: coreConversationId,
    conversations: [{
      workspaceIdentity,
      localConversationId: LOCAL_CONVERSATION_ID,
      conversationId: coreConversationId,
      title: 'Restored conversation',
      createdAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:01:00.000Z',
      archivedAt: null,
      schemaVersion: 1,
      migrationMetadata: {},
    }],
    turns: [],
    migrationMetadata: {},
  });
  return {
    calls,
    async getWorkspaceConversationLedger(identity: string) {
      calls.push({ method: 'getWorkspaceConversationLedger', args: [identity] });
      workspaceIdentity = identity;
      return ledger();
    },
    async getConversationWorkingState(conversationId: string, identity: string) {
      calls.push({ method: 'getConversationWorkingState', args: [conversationId, identity] });
      return getConversationWorkingState(getDb(), conversationId, identity);
    },
    async saveConversationWorkingState(conversationId: string, input: Record<string, unknown>) {
      calls.push({ method: 'saveConversationWorkingState', args: [conversationId, input] });
      return saveConversationWorkingState(getDb(), conversationId, { ...input, actor: 'test:panel' } as never);
    },
    async getWorkspaceAttemptRehydration(...args: unknown[]) {
      calls.push({ method: 'getWorkspaceAttemptRehydration', args });
      return { workspaceRoot: args[0], attempts: [] };
    },
    async listMessages() { return { messages: [] }; },
    async listConversationMessageAttachments() { return { byMessage: {} }; },
    async listConversationResearch() { return { research: [] }; },
    async listResponseAlternatives() { return { alternatives: [] }; },
    async getConversationBranch() { return { branch: null }; },
    async listCapabilityActions() { return { attemptId: null, actions: [] }; },
    async listRecentWorkspaceCapabilityActions() { return { actions: [] }; },
    async submit(...args: unknown[]) { calls.push({ method: 'submit', args }); throw new Error('submission is stubbed in these tests'); },
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

interface Session {
  panel: AgentPanel;
  posted: PostedMessage[];
  send: (message: unknown) => void;
  /** The (text, mode) pairs that reached a real production submission path. */
  submissions: Array<{ text: string; mode: string }>;
}

/**
 * Simulates one "VS Code launch": a brand-new panel instance, a brand-new
 * webview, and a brand-new Core client. Nothing is carried over in memory —
 * whatever the panel knows afterwards came back from Core's database.
 */
async function launch(root: string, client: unknown): Promise<Session> {
  const posted: PostedMessage[] = [];
  const submissions: Array<{ text: string; mode: string }> = [];
  vi.spyOn(extensionModule, 'getCoreManager').mockReturnValue(manager(client) as never);
  const panel = new AgentPanel(context(), root);
  vi.spyOn(panel as never as { handleUserMessage: unknown }, 'handleUserMessage' as never)
    .mockImplementation((async (text: string, mode: string) => { submissions.push({ text, mode }); }) as never);
  vi.spyOn(panel as never as { startAutonomousTask: unknown }, 'startAutonomousTask' as never)
    .mockImplementation((async (text: string) => { submissions.push({ text, mode: 'autonomous' }); }) as never);

  let messageHandler: ((msg: unknown) => void) | undefined;
  panel.resolveWebviewView({
    webview: {
      options: {}, html: '', cspSource: 'vscode-webview://continuity-test',
      asWebviewUri: (uri: vscode.Uri) => uri,
      postMessage: (message: PostedMessage) => { posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: (handler: (msg: unknown) => void) => { messageHandler = handler; return { dispose: () => undefined }; },
    },
    show: () => undefined,
    onDidDispose: () => ({ dispose: () => undefined }),
    visible: true,
  } as unknown as vscode.WebviewView, {} as never, {} as never);

  messageHandler?.({ type: 'webviewReady', mode: 'agent' });
  await (panel as never as { workspaceRestorationPromise: Promise<void> }).workspaceRestorationPromise;
  return { panel, posted, submissions, send: (message: unknown) => messageHandler?.(message) };
}

/**
 * Submits one composer turn through the real funnel and settles it.
 *
 * `usedFiles` stands in for the repository files the turn's context selection
 * authoritatively pulled in — the production path notes exactly these through
 * `noteAuthoritativeTurnFiles` from `buildSupplementalRepositoryContext`.
 * Passing them here keeps these tests honest about the ONLY source
 * `relevantFiles` is allowed to have: files the system used, never text the
 * user typed. (`repositoryGroundedContinuity.test.ts` covers the real
 * selection end of that seam.)
 */
async function turn(
  session: Session,
  text: string,
  mode: 'chat' | 'agent' | 'autonomous' = 'agent',
  usedFiles: readonly string[] = [],
): Promise<void> {
  const route = (session.panel as never as {
    routeComposerSubmission: (text: string, submit: (effective: string) => void | Promise<void>, mode: string) => Promise<void>;
  }).routeComposerSubmission.bind(session.panel);
  await route(text, async (effectiveText: string) => {
    if (usedFiles.length) {
      (session.panel as never as { noteAuthoritativeTurnFiles: (paths: readonly string[]) => void })
        .noteAuthoritativeTurnFiles(usedFiles);
    }
    session.submissions.push({ text: effectiveText, mode });
  }, mode);
}

function workingState(db: CoreDatabase, conversationId: string, identity: string): ConversationWorkingStateRecord | null {
  return getConversationWorkingState(db, conversationId, identity);
}

let root: string;
let coreDirectory: string;
let databasePath: string;
let db: CoreDatabase;
let coreConversationId: string;
let identity: string;

/** Restarts Core itself: the process is gone and the database is reopened. */
function restartCore(): void {
  db.close();
  db = openCoreDatabase(databasePath).db;
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-continuity-workspace-'));
  coreDirectory = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-continuity-core-'));
  databasePath = path.join(coreDirectory, 'core.db');
  db = openCoreDatabase(databasePath).db;
  coreConversationId = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' }).id;
  await fsp.mkdir(path.join(root, 'src', 'auth'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'src', 'auth', 'registerUser.ts'),
    'export function registerUser(username: string) { return { username }; }\n',
    'utf8',
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  db.close();
  await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  await fsp.rm(coreDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe('A — basic restart continuity', () => {
  it('recovers the same objective and resolves "Fix it." to it after an extension, Core and panel restart', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

    await turn(first, 'Why does registerUser accept an empty username?', 'chat', ['src/auth/registerUser.ts']);
    const afterTurnOne = workingState(db, coreConversationId, identity)!;
    expect(afterTurnOne.currentObjective).toContain('registerUser');
    expect(afterTurnOne.latestExecutionPolicy).toBe('READ_ONLY');
    expect(afterTurnOne.relevantFiles.map(file => file.path)).toContain('src/auth/registerUser.ts');
    // The file was read to record its hash — that hash is the ONLY thing that
    // lets a later resume notice the repository moved.
    expect(afterTurnOne.relevantFiles[0].contentHash).toMatch(/^[a-f0-9]{64}$/);

    // Extension host, Core process and webview panel all restart.
    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));

    const cue = second.posted.find(m => m.type === 'conversationContinuity');
    expect(cue).toBeDefined();
    expect(cue!.cue).toBe(`Continuing: ${afterTurnOne.currentObjective}`);
    expect(cue!.repositoryChanged).toBe(false);
    // The restored policy is handed to the webview so Auto keeps its bearings,
    // and the repository was re-read as part of restoring it.
    expect(cue!.previousMode).toBe('chat');

    await turn(second, 'Fix it.');
    const afterFollowUp = workingState(db, coreConversationId, identity)!;
    // Same objective identity: the follow-up continued, it did not restart.
    expect(afterFollowUp.objectiveId).toBe(afterTurnOne.objectiveId);
    // A bare follow-up must not overwrite the objective with its own words.
    expect(afterFollowUp.currentObjective).toBe(afterTurnOne.currentObjective);
    expect(second.submissions).toEqual([{ text: 'Fix it.', mode: 'agent' }]);
  });

  it('keeps a restored follow-up conservative: continuity never re-grants autonomy across a restart', () => {
    // In-session continuation of a live autonomous turn stays autonomous…
    expect(decideExecutionPolicy('Continue.', { previousPolicy: 'AUTONOMOUS_EXECUTION' }).policy)
      .toBe('AUTONOMOUS_EXECUTION');
    // …but a policy merely REMEMBERED from a previous session does not.
    expect(decideExecutionPolicy('Continue.', { previousPolicy: 'AUTONOMOUS_EXECUTION', previousPolicyIsRestored: true }).policy)
      .toBe('COLLABORATIVE_EDIT');
    // Autonomy is still available — from the new wording itself.
    expect(decideExecutionPolicy('Continue and run the relevant validation.', { previousPolicy: 'READ_ONLY', previousPolicyIsRestored: true }).policy)
      .toBe('AUTONOMOUS_EXECUTION');
  });

  it('asks instead of guessing when there is no persisted objective to continue', () => {
    const resolution = resolveFollowUp({ text: 'Continue.', state: null, revalidation: { status: 'unknown' } });
    expect(resolution.status).toBe('needs_clarification');
    expect(resolution).toMatchObject({ message: expect.stringContaining('What would you like me to work on?') });
  });
});

describe('B — restart after an approved Saath Kar edit', () => {
  it('restores the conversation read-only: it never re-submits work or writes a second proposal', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Change registerUser in src/auth/registerUser.ts so it rejects an empty username.');
    const before = workingState(db, coreConversationId, identity)!;

    restartCore();
    const client = coreBackedClient(() => db, coreConversationId);
    const second = await launch(root, client);

    // Approval and proposal state live in their existing durable systems
    // (`approvals`, `conversation_turns`, the M15 queue). Continuity restore
    // must be a pure read: no submission, no new attempt, no state write.
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
    expect(client.calls.some(call => call.method === 'saveConversationWorkingState')).toBe(false);
    expect(client.calls.filter(call => call.method === 'getConversationWorkingState')).toHaveLength(1);
    expect(second.submissions).toEqual([]);
    expect(workingState(db, coreConversationId, identity)!.version).toBe(before.version);
  });
});

describe('C — restart during a Karke Dikha task', () => {
  it('restores exactly one continuity projection and never a second execution', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Fix registerUser end to end and run the relevant validation.', 'autonomous');
    expect(workingState(db, coreConversationId, identity)!.latestExecutionPolicy).toBe('AUTONOMOUS_EXECUTION');

    restartCore();
    const client = coreBackedClient(() => db, coreConversationId);
    const second = await launch(root, client);

    // Task/approval restoration remains the existing durable machinery's job
    // (`getWorkspaceAttemptRehydration` + the M15 DurableTaskQueue); this layer
    // adds exactly one cue and starts nothing.
    expect(second.posted.filter(m => m.type === 'conversationContinuity')).toHaveLength(1);
    expect(second.submissions).toEqual([]);
    expect(client.calls.some(call => call.method === 'submit')).toBe(false);
  });
});

describe('D — a user constraint survives a restart', () => {
  it('persists "don\'t change the tests" and carries it into the resumed turn', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username in src/auth/registerUser.ts?', 'chat');
    await turn(first, "Fix it, but don't change the tests.");

    const stored = workingState(db, coreConversationId, identity)!;
    expect(stored.userConstraints.map(item => item.text)).toEqual(["don't change the tests"]);
    // Found live in installed acceptance run 3: this turn is a follow-up that
    // carries a constraint, so it is NOT a bare referential follow-up — and the
    // objective label was being overwritten with "Fix it, but don't change the
    // tests.", losing the actual subject and degrading the resumed cue.
    expect(stored.currentObjective).toContain('registerUser');
    expect(stored.currentObjective).not.toContain("don't change the tests");

    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));
    const restored = workingState(db, coreConversationId, identity)!;
    expect(restored.userConstraints.map(item => item.text)).toEqual(["don't change the tests"]);

    // Saath Kar receives the constraint through Core's continuity brief, which
    // is prepended to the conversation history it already replays. Karke Dikha
    // excludes history by charter, so an autonomous turn carries the constraint
    // in the goal the user actually submits — visibly, not silently.
    await turn(second, 'Continue and run the relevant validation.', 'autonomous');
    expect(second.submissions.at(-1)!.text)
      .toBe("Continue and run the relevant validation.\n\nConstraints carried forward from this conversation: don't change the tests.");
  });

  it('extracts only explicit constraint forms, never casual prose', () => {
    expect(extractConstraints("Fix it, but don't change the tests.")).toEqual(["don't change the tests"]);
    expect(extractConstraints("Keep the change minimal and don't touch auth.ts."))
      .toEqual(expect.arrayContaining(["don't touch auth.ts", 'Keep the change minimal']));
    expect(extractConstraints('I think the tests are a bit slow these days.')).toEqual([]);
    expect(extractConstraints('The tests were nice to read.')).toEqual([]);
  });
});

describe('E — an explicit later instruction overrides an earlier constraint', () => {
  it('lifts the constraint only when the new turn names its subject and asks for the forbidden action', async () => {
    const now = '2026-09-07T00:00:00.000Z';
    const first = reconcileConstraints("Fix it, but don't change the tests.", [], now);
    expect(first.constraints).toHaveLength(1);

    // Unrelated turns leave it standing.
    expect(reconcileConstraints('Continue.', first.constraints, now).constraints).toHaveLength(1);
    // "run the tests" is not the forbidden action, so the constraint holds.
    expect(reconcileConstraints('Now run the tests.', first.constraints, now).constraints).toHaveLength(1);
    // An explicit instruction to do the forbidden thing overrides it.
    const overridden = reconcileConstraints('Actually, update the tests too.', first.constraints, now);
    expect(overridden.constraints).toEqual([]);
    expect(overridden.overriddenIds).toEqual([first.constraints[0].id]);
  });

  it('persists the override so the lifted constraint does not come back after a restart', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username in src/auth/registerUser.ts?', 'chat');
    await turn(first, "Fix it, but don't change the tests.");
    await turn(first, 'Actually, update the tests too.');

    restartCore();
    await launch(root, coreBackedClient(() => db, coreConversationId));
    expect(workingState(db, coreConversationId, identity)!.userConstraints).toEqual([]);
  });
});

describe('F — the repository changed while VS Code was closed', () => {
  it('re-inspects rather than treating the remembered narrative as current truth', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username?', 'chat', ['src/auth/registerUser.ts']);

    // Someone else edits the file while we are closed.
    await fsp.writeFile(
      path.join(root, 'src', 'auth', 'registerUser.ts'),
      'export function registerUser(username: string) { if (!username) throw new Error("empty"); return { username }; }\n',
      'utf8',
    );

    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));
    const cue = second.posted.find(m => m.type === 'conversationContinuity')!;
    expect(cue.repositoryChanged).toBe(true);
    expect(cue.cue).toMatch(/repository changed since we last worked on/i);

    // "Continue." must NOT silently act on the stale narrative.
    await turn(second, 'Continue.');
    expect(second.submissions).toEqual([]);
    const asked = second.posted.filter(m => m.type === 'done').at(-1)!;
    expect(asked.content).toMatch(/repository has changed/i);
    expect(asked.content).toMatch(/Should I re-inspect it before continuing\?/);
    expect(asked.content).toContain('src/auth/registerUser.ts');
  });

  it('treats a deleted relevant file the same way as a modified one', () => {
    const state = {
      currentObjective: 'Fix empty-username validation in registerUser',
      objectiveId: 'obj_1',
    } as ConversationWorkingStateRecord;
    const resolution = resolveFollowUp({
      text: 'Continue.',
      state,
      revalidation: { status: 'changed', changedPaths: [], missingPaths: ['src/auth/registerUser.ts'] },
    });
    expect(resolution.status).toBe('needs_clarification');
    expect(continuityCue(state, { status: 'changed', changedPaths: [], missingPaths: ['x'] }))
      .toMatch(/^Resumed previous conversation/);
  });
});

describe('G — a different workspace', () => {
  it('does not leak the previous project\'s working state into another workspace or profile', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username in src/auth/registerUser.ts?', 'chat');
    expect(workingState(db, coreConversationId, identity)).not.toBeNull();

    // Same Core, same conversation row — a DIFFERENT workspace root.
    const otherRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'kd-continuity-other-'));
    try {
      const client = coreBackedClient(() => db, coreConversationId);
      const second = await launch(otherRoot, client);
      const otherIdentity = second.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
      expect(otherIdentity).not.toBe(identity);
      // Core itself refuses to hand the record over — this is not a UI filter.
      expect(workingState(db, coreConversationId, otherIdentity)).toBeNull();
      expect(second.posted.some(m => m.type === 'conversationContinuity')).toBe(false);
    } finally {
      try {
        await fsp.rm(otherRoot, { recursive: true, force: true, maxRetries: 25, retryDelay: 100 });
      } catch {
        // Best-effort cleanup on Windows transient filesystem lock
      }
    }
  });
});

describe('H — a new objective', () => {
  it('does not drag the old objective\'s constraints, findings or files into unrelated work', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username in src/auth/registerUser.ts?', 'chat');
    await turn(first, "Fix it, but don't change the tests.");
    const before = workingState(db, coreConversationId, identity)!;
    expect(before.userConstraints).toHaveLength(1);

    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));
    await turn(second, 'Different issue: inspect payment validation.', 'chat');

    const after = workingState(db, coreConversationId, identity)!;
    expect(after.objectiveId).not.toBe(before.objectiveId);
    expect(after.currentObjective).toContain('payment validation');
    expect(after.userConstraints).toEqual([]);
    expect(after.relevantFiles).toEqual([]);
    expect(after.relevantSymbols).toEqual([]);
    expect(after.latestFindingsSummary).toBeNull();
  });

  it('classifies boundaries deterministically and asks when a request is genuinely unrelated but unannounced', () => {
    const state = {
      currentObjective: 'Why does registerUser accept an empty username?',
      relevantSymbols: ['registerUser'],
      relevantFiles: [{ path: 'src/auth/registerUser.ts', contentHash: null, observedAt: 'x' }],
    } as ConversationWorkingStateRecord;
    for (const text of ['Fix it.', 'Continue.', 'Add the tests too.', 'Now update the tests.', "Fix it, but don't change the tests."]) {
      expect(detectObjectiveBoundary(text, state)).toBe('same_objective');
    }
    for (const text of [
      "Now let's work on the payment module.",
      'Different issue: why is CI slow?',
      'Forget that task; inspect authentication instead.',
    ]) {
      expect(detectObjectiveBoundary(text, state)).toBe('new_objective');
    }
    // Unannounced and unrelated: conservative, so the panel asks.
    expect(detectObjectiveBoundary('Please add a caching layer to the reporting dashboard exporter.', state))
      .toBe('ambiguous');
  });

  it('asks rather than guessing when the boundary is ambiguous, and submits nothing', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Why does registerUser accept an empty username in src/auth/registerUser.ts?', 'chat');

    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));
    await turn(second, 'Please add a caching layer to the reporting dashboard exporter.');

    expect(second.submissions).toEqual([]);
    expect(second.posted.filter(m => m.type === 'done').at(-1)!.content)
      .toMatch(/Should I treat it as a new task\?/);
    // Nothing was written, so the old objective is still intact for the answer.
    expect(workingState(db, coreConversationId, identity)!.currentObjective).toContain('registerUser');
  });
});

describe('I — an explicit manual mode override', () => {
  it('still wins for that turn regardless of the restored policy', async () => {
    const first = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
    await turn(first, 'Fix registerUser end to end and run the relevant validation.', 'autonomous');
    expect(workingState(db, coreConversationId, identity)!.latestExecutionPolicy).toBe('AUTONOMOUS_EXECUTION');

    restartCore();
    const second = await launch(root, coreBackedClient(() => db, coreConversationId));
    // The user explicitly picks Baat Kar for the next turn. Restored context
    // informs the answer; it never re-selects the mode.
    await turn(second, 'Continue.', 'chat');
    expect(second.submissions).toEqual([{ text: 'Continue.', mode: 'chat' }]);
    expect(workingState(db, coreConversationId, identity)!.latestExecutionPolicy).toBe('READ_ONLY');
  });
});

describe('the sendMessage/startAutonomousTask webview wiring', () => {
  it('routes a real composer submission through the continuity funnel', async () => {
    const session = await launch(root, coreBackedClient(() => db, coreConversationId));
    identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

    session.send({ type: 'sendMessage', text: 'Why does registerUser accept an empty username?', mode: 'chat', conversationId: LOCAL_CONVERSATION_ID });
    await vi.waitFor(() => expect(workingState(db, coreConversationId, identity)).not.toBeNull());
    expect(session.submissions).toEqual([
      { text: 'Why does registerUser accept an empty username?', mode: 'chat' },
    ]);
    expect(workingState(db, coreConversationId, identity)!.latestExecutionPolicy).toBe('READ_ONLY');
  });
});
