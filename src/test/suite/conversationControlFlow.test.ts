/**
 * Conversation Control Flow & Fresh-Chat Semantics Tests
 *
 * Validates deterministic reset intent, greeting interception,
 * repository-understanding classification, precedence order,
 * and clean-session transitions without stale task resurrection.
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
  clearConversationWorkingState,
  getConversationWorkingState,
  saveConversationWorkingState,
} from '../../../core/domain/conversationWorkingState';
import {
  isExplicitResetIntent,
  isGreetingIntent,
  isRepositoryUnderstandingQuery,
  detectObjectiveBoundary,
  classifyControlAcknowledgement,
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
      title: 'Active conversation',
      createdAt: '2026-09-19T10:00:00.000Z',
      updatedAt: '2026-09-19T10:01:00.000Z',
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
    async createConversation(input: { title?: string }) {
      calls.push({ method: 'createConversation', args: [input] });
      return createConversation(getDb(), { mode: 'saath_kar', actor: 'test:panel', title: input?.title });
    },
    async bindWorkspaceConversation(...args: unknown[]) {
      calls.push({ method: 'bindWorkspaceConversation', args });
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
    async clearConversationWorkingState(conversationId: string, identity: string) {
      calls.push({ method: 'clearConversationWorkingState', args: [conversationId, identity] });
      return clearConversationWorkingState(getDb(), conversationId, identity);
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
  submissions: Array<{ text: string; mode: string }>;
}

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

async function turn(
  session: Session,
  text: string,
  mode: 'chat' | 'agent' | 'autonomous' = 'agent',
): Promise<void> {
  const route = (session.panel as never as {
    routeComposerSubmission: (text: string, submit: (effective: string) => void | Promise<void>, mode: string) => Promise<void>;
  }).routeComposerSubmission.bind(session.panel);
  await route(text, async (effectiveText: string) => {
    session.submissions.push({ text: effectiveText, mode });
  }, mode);
}

describe('Conversation Control Flow & Fresh-Chat Semantics', () => {
  let root: string;
  let db: CoreDatabase;
  let coreConversationId: string;
  let identity = '';

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'karkedikha-ctrl-'));
    db = openCoreDatabase(path.join(root, 'core.sqlite3')).db;
    coreConversationId = createConversation(db, { mode: 'saath_kar', actor: 'test:actor' }).id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try { db.close(); } catch { /* ignore */ }
    await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  describe('Intent Normalizer', () => {
    it('recognizes all prompt variations for explicit reset', () => {
      const resetPhrases = [
        "don't resume previous conversation",
        "do not resume previous conversation",
        "Don't resume previous conversation.",
        "start fresh",
        "Start fresh please",
        "new conversation",
        "new topic",
        "ignore the previous task",
        "forget the previous task for this chat",
        "don't continue that task",
        "stop using the previous conversation",
        "clear context",
        "reset conversation",
      ];
      for (const phrase of resetPhrases) {
        expect(isExplicitResetIntent(phrase), `Expected "${phrase}" to be recognized as reset`).toBe(true);
      }
      expect(isExplicitResetIntent('continue with compute_order_total')).toBe(false);
      expect(isExplicitResetIntent('what does this repo do')).toBe(false);
    });

    it('recognizes common greetings', () => {
      const greetings = ['hi', 'hello', 'hey', 'good morning', "what's up", 'Hello!'];
      for (const g of greetings) {
        expect(isGreetingIntent(g), `Expected "${g}" to be greeting`).toBe(true);
      }
      expect(isGreetingIntent('hi, fix the compute_order_total bug')).toBe(false);
      expect(isGreetingIntent('hello can you explain how tests run?')).toBe(false);
    });

    it('recognizes repository-understanding queries', () => {
      const queries = [
        'what does this repo do',
        'explain this project',
        'what are the main components',
        'where should I start',
        'what does this folder contain',
        'what does this repository do?',
      ];
      for (const q of queries) {
        expect(isRepositoryUnderstandingQuery(q), `Expected "${q}" to be repo understanding`).toBe(true);
      }
    });
  });

  describe('detectObjectiveBoundary precedence', () => {
    const state: ConversationWorkingStateRecord = {
      schemaVersion: 1,
      conversationId: 'c1',
      workspaceIdentity: 'w1',
      currentObjective: 'Implement compute_order_total with tax and coupon discounts in src/orders.ts',
      objectiveFingerprint: 'compute order total tax coupon discounts src orders ts',
      relevantFiles: ['src/orders.ts'],
      latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
      carriedConstraints: ['do not modify legacy types'],
      activePlanAttemptId: null,
      activeMutationAttemptId: null,
      updatedAt: '2026-09-19T10:00:00.000Z',
    };

    it('explicit reset intent short-circuits continuation to new_objective', () => {
      expect(detectObjectiveBoundary("Don't resume previous conversation.", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("start fresh", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("ignore the previous task", state)).toBe('new_objective');
    });

    it('greeting intent short-circuits continuation to new_objective', () => {
      expect(detectObjectiveBoundary("hi", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("hello", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("hey", state)).toBe('new_objective');
    });

    it('repository understanding query short-circuits continuation to new_objective', () => {
      expect(detectObjectiveBoundary("what does this repo do", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("explain this project", state)).toBe('new_objective');
      expect(detectObjectiveBoundary("where should I start", state)).toBe('new_objective');
    });

    it('explicit continue intent retains same_objective', () => {
      expect(detectObjectiveBoundary("continue", state)).toBe('same_objective');
      expect(detectObjectiveBoundary("resume that task", state)).toBe('same_objective');
    });

    it('an acknowledgement-led follow-on continues the conversation instead of asking "new task?"', () => {
      for (const text of ['Good. Now let me delete an expense.', 'Okay. Ask me before an expense is deleted.', 'Great, now add a summary command.']) {
        expect(detectObjectiveBoundary(text, state)).toBe('same_objective');
      }
      // A question about what the assistant just did is about this conversation.
      expect(detectObjectiveBoundary('Why did you implement it that way?', state)).toBe('same_objective');
      // Unannounced, unrelated, no acknowledgement: still asks (deliberate contract).
      expect(detectObjectiveBoundary('Goodness, please add a caching layer to the reporting dashboard exporter.', state)).toBe('ambiguous');
    });

    it('ambiguous unrelated task falls back to ambiguous clarification', () => {
      expect(detectObjectiveBoundary("Please add a caching layer to the reporting dashboard exporter.", state))
        .toBe('ambiguous');
    });
  });

  describe('classifyControlAcknowledgement', () => {
    it('recognizes new-task confirmations, including equivalent phrasings, not just the literal "Yes new task"', () => {
      for (const phrase of ['Yes new task', 'new task', 'New Task', 'start new task', 'new chat', 'new conversation', 'ok new task']) {
        expect(classifyControlAcknowledgement(phrase), `Expected "${phrase}" to confirm a new task`).toBe('confirm_new');
      }
    });

    it('recognizes continue confirmations', () => {
      for (const phrase of ['Continue', 'yes continue', 'proceed', 'go ahead', 'keep going']) {
        expect(classifyControlAcknowledgement(phrase), `Expected "${phrase}" to confirm continue`).toBe('confirm_continue');
      }
    });

    it('recognizes bare affirmations and retry', () => {
      expect(classifyControlAcknowledgement('yes')).toBe('affirmation');
      expect(classifyControlAcknowledgement('retry')).toBe('retry');
    });

    it('never classifies substantive text containing the same words as a control acknowledgement', () => {
      // The classifier must compare substantive objectives, not control words —
      // a real objective that happens to contain "new task" or "continue" as
      // part of a longer sentence must not be swallowed as a control reply.
      expect(classifyControlAcknowledgement('Please start a new task queue processor for the billing service.')).toBeNull();
      expect(classifyControlAcknowledgement('Continue reading the config file and log any parse errors.')).toBeNull();
      expect(classifyControlAcknowledgement('Inspect this workspace and explain what this project does, its main components, and how it is run')).toBeNull();
    });
  });

  describe('AgentPanel Composer Funnel End-to-End', () => {
    it('handles explicit reset without asking ambiguous question and clears anchor', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      // Seed working state with compute_order_total task
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: 'Implement compute_order_total with tax and discount calculation',
        currentObjective: 'Implement compute_order_total with tax and discount calculation',
        objectiveFingerprint: 'implement compute order total tax discount calculation',
        relevantFiles: [{ path: 'src/orders.ts' }],
        latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
        carriedConstraints: [],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        actor: 'test',
      });

      // Reload panel so working state is restored
      const reloadedSession = await launch(root, client);

      // User says: Don't resume previous conversation.
      await turn(reloadedSession, "Don't resume previous conversation.");

      // Verify immediate acknowledgement
      const lastDone = reloadedSession.posted.filter(m => m.type === 'done').at(-1);
      expect(lastDone?.content).toBe('Sure — starting fresh.');

      // Verify continuity reset notice was broadcasted
      const continuityMsg = reloadedSession.posted.find(m => m.type === 'conversationContinuity' && m.reset === true);
      expect(continuityMsg).toBeDefined();

      // Verify Core working state was cleared
      const stateAfterReset = getConversationWorkingState(db, coreConversationId, identity);
      expect(stateAfterReset).toBeNull();

      // No model submission occurred for the control command
      expect(reloadedSession.submissions).toEqual([]);

      // Next user turn: what does this repo do
      await turn(reloadedSession, "what does this repo do", 'chat');

      // It must be submitted independently without asking about continuation
      expect(reloadedSession.submissions).toEqual([
        { text: "what does this repo do", mode: "chat" }
      ]);
      const clarifyMsgs = reloadedSession.posted.filter(m => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task'));
      expect(clarifyMsgs.length).toBe(0);
    });

    it('handles greetings without resurrecting stale compute_order_total task', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      // Seed working state with stale task
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: 'Implement compute_order_total in src/orders.ts',
        currentObjective: 'Implement compute_order_total in src/orders.ts',
        objectiveFingerprint: 'implement compute order total src orders ts',
        relevantFiles: [{ path: 'src/orders.ts' }],
        latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
        carriedConstraints: [],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        actor: 'test',
      });

      const reloadedSession = await launch(root, client);

      // User says "hi"
      await turn(reloadedSession, "hi", 'chat');

      // Responds with clean greeting
      const lastDone = reloadedSession.posted.filter(m => m.type === 'done').at(-1);
      expect(lastDone?.content).toBe('Hi! What can I help you with?');

      // Does not submit as task continuation
      expect(reloadedSession.submissions).toEqual([]);
    });

    it('handles new chat button by resetting conversation and clearing anchors', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      // Seed working state
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: 'Compute order total implementation',
        currentObjective: 'Compute order total implementation',
        objectiveFingerprint: 'compute order total implementation',
        relevantFiles: [{ path: 'src/orders.ts' }],
        latestExecutionPolicy: 'AUTONOMOUS_EXECUTION',
        carriedConstraints: [],
        activePlanAttemptId: null,
        activeMutationAttemptId: null,
        actor: 'test',
      });

      // User triggers new chat
      session.send({ type: 'newConversation' });

      await vi.waitFor(() => {
        const newConvMsg = session.posted.find(m => m.type === 'newConversation' && m.id !== 'default');
        expect(newConvMsg).toBeDefined();
        const resetMsg = session.posted.find(m => m.type === 'conversationContinuity' && m.reset === true);
        expect(resetMsg).toBeDefined();
      });

      // Verify continuity reset posted to webview
      const resetMsg = session.posted.find(m => m.type === 'conversationContinuity' && m.reset === true);
      expect(resetMsg).toBeDefined();
    });
  });

  describe('Objective arbitration: New Task / Continue confirmations', () => {
    const OBJECTIVE_A = 'lets build an html with login page';
    const OBJECTIVE_B = 'Inspect this workspace and explain what this project does, its main components, and how it is run';

    it('reproduces and fixes the reported defect: "Yes new task" never becomes the objective, no second ambiguity prompt, objective B starts immediately', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      // Objective A already active in this conversation.
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: OBJECTIVE_A,
        currentObjective: OBJECTIVE_A,
        actor: 'test',
      });

      const reloadedSession = await launch(root, client);

      // 1. User sends unrelated objective B -> KKD correctly asks for clarification.
      await turn(reloadedSession, OBJECTIVE_B, 'chat');
      const firstClarify = reloadedSession.posted.filter(m => m.type === 'done').at(-1);
      expect(firstClarify?.content).toContain('Should I treat it as a new task?');
      expect(reloadedSession.submissions).toEqual([]);
      expect(getConversationWorkingState(db, coreConversationId, identity)?.currentObjective).toBe(OBJECTIVE_A);

      // 2. User answers the clarification: "Yes new task". The confirmation binds to the pending candidate (objective B):
      // no "What's the new task?" question, the candidate is submitted and becomes the objective.
      await turn(reloadedSession, 'Yes new task', 'chat');
      const clarifyMsgs = reloadedSession.posted.filter(
        m => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task'),
      );
      expect(clarifyMsgs.length).toBe(1);
      expect(reloadedSession.posted.some(m => m.content === "Got it! What's the new task?")).toBe(false);
      expect(reloadedSession.submissions).toEqual([{ text: OBJECTIVE_B, mode: 'chat' }]);

      const finalState = getConversationWorkingState(db, coreConversationId, identity);
      expect(finalState?.currentObjective).toBe(OBJECTIVE_B);
      expect(finalState?.currentObjective).not.toContain('new task');
      expect(finalState?.relevantFiles).toEqual([]);
      expect(finalState?.pendingNewObjective).toBe(false);
      expect(finalState?.awaitingObjectiveClarification).toBe(false);
    });

    it('a second control reply while a new-task confirmation is still pending re-asks instead of becoming the objective', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: OBJECTIVE_A,
        currentObjective: OBJECTIVE_A,
        actor: 'test',
      });

      const firstSession = await launch(root, client);
      await turn(firstSession, OBJECTIVE_B, 'chat');
      // A restart loses the in-memory candidate, so the confirmation falls back to asking for the task.
      const reloadedSession = await launch(root, client);
      await turn(reloadedSession, 'Yes new task', 'chat');

      // User says "yes" again instead of the real objective.
      await turn(reloadedSession, 'yes', 'chat');
      const reply = reloadedSession.posted.filter(m => m.type === 'done').at(-1);
      expect(reply?.content).toBe("Got it — what's the new task?");
      expect(getConversationWorkingState(db, coreConversationId, identity)?.currentObjective).toBe(OBJECTIVE_A);
      expect(reloadedSession.submissions).toEqual([]);
    });

    it('Continue confirmation: the reply never becomes the objective, and the next message continues objective A', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;

      const objectiveA = 'Implement compute_order_total with tax and discount calculation in src/orders.ts';
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: objectiveA,
        currentObjective: objectiveA,
        actor: 'test',
      });

      const reloadedSession = await launch(root, client);

      // Ambiguous follow-up.
      const ambiguousFollowUp = 'Please add a caching layer to the reporting dashboard exporter.';
      await turn(reloadedSession, ambiguousFollowUp, 'agent');
      expect(reloadedSession.posted.filter(m => m.type === 'done').at(-1)?.content)
        .toContain('Should I treat it as a new task?');
      expect(reloadedSession.submissions).toEqual([]);

      // User chooses Continue.
      await turn(reloadedSession, 'Continue', 'agent');
      const stateAfterContinue = getConversationWorkingState(db, coreConversationId, identity);
      expect(stateAfterContinue?.currentObjective).toBe(objectiveA);
      expect(stateAfterContinue?.pendingNewObjective).toBe(false);

      // The next message continues objective A rather than starting a new one.
      await turn(reloadedSession, 'Now also add a unit test for compute_order_total.', 'agent');
      const finalState = getConversationWorkingState(db, coreConversationId, identity);
      expect(finalState?.currentObjective).toBe(objectiveA);

      // The ambiguity prompt was never asked a second time.
      const clarifyMsgs = reloadedSession.posted.filter(
        m => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task'),
      );
      expect(clarifyMsgs.length).toBe(1);
    });
  });

  // Regression coverage for the invariant that classifyControlAcknowledgement()
  // may only affect routing while KKD is actually awaiting a continuation /
  // new-objective / control clarification. A bare "yes", "continue", "retry",
  // or "new task" typed during ORDINARY conversation — with no control
  // question pending — must never be read as an answer to a question that was
  // never asked, and must never silently mutate objective state on its own.
  describe('Control acknowledgements only apply when a control response is expected', () => {
    const PRIOR_OBJECTIVE = 'Implement compute_order_total with tax and discount calculation in src/orders.ts';

    async function withPriorObjective(client: unknown): Promise<Session> {
      const session = await launch(root, client);
      identity = session.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: PRIOR_OBJECTIVE,
        currentObjective: PRIOR_OBJECTIVE,
        actor: 'test',
      });
      return launch(root, client);
    }

    it('normal chat: a standalone "yes" with no clarification pending is treated as ordinary content, not a silent control reply', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      // "yes" shares no term with the stored objective, so the ORDINARY
      // classifier (unrelated to control acknowledgements) correctly finds
      // this ambiguous and asks — exactly as it would for any other
      // unrelated word. That is the fix in action: the old bug read "yes" as
      // a control reply purely because SOME objective existed, and forced
      // silent continuation of it WITHOUT ever asking (no clarification
      // posted, message submitted outright). Asking here proves that bypass
      // is gone.
      await turn(session, 'yes', 'agent');

      const doneMsgs = session.posted.filter(m => m.type === 'done');
      // The generic ambiguity question was asked, ...
      expect(doneMsgs.some(m => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task'))).toBe(true);
      // ... never the control-only confirmation reply, which only ever
      // follows a genuine "confirm_new" acknowledgement.
      expect(doneMsgs.some(m => typeof m.content === 'string' && m.content.includes("Got it! What's the new task"))).toBe(false);
      // Nothing was silently submitted on the user's behalf.
      expect(session.submissions).toEqual([]);
      // No control-flow-only flag was set — this is the same durable write
      // any other ambiguous ordinary message would produce.
      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.pendingNewObjective).toBe(false);
      expect(state?.currentObjective).toBe(PRIOR_OBJECTIVE);
    });

    it('normal chat: a standalone "continue" with no clarification pending does not force objective routing through the control path', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      await turn(session, 'continue', 'agent');

      const doneMsgs = session.posted.filter(m => m.type === 'done');
      expect(doneMsgs.some(m => typeof m.content === 'string' && m.content.includes("What's the new task"))).toBe(false);
      expect(session.submissions).toEqual([{ text: 'continue', mode: 'agent' }]);
      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.pendingNewObjective).toBe(false);
      expect(state?.awaitingObjectiveClarification).toBe(false);
    });

    it('normal chat: a standalone "new task" with no clarification pending becomes the objective directly instead of opening a confirmation flow', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      // Unlike the "Yes new task" reply to a pending ambiguity prompt, this is
      // unprompted: no control question was ever asked, so the words must be
      // read as the user's actual message, not as a confirmation.
      await turn(session, 'new task', 'agent');

      const doneMsgs = session.posted.filter(m => m.type === 'done');
      expect(doneMsgs.some(m => typeof m.content === 'string' && m.content.includes("Got it! What's the new task"))).toBe(false);
      // It was submitted immediately — never held back for a confirmation reply.
      expect(session.submissions).toEqual([{ text: 'new task', mode: 'agent' }]);
      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.pendingNewObjective).toBe(false);
      expect(state?.currentObjective).not.toBe(PRIOR_OBJECTIVE);
    });

    it('clarification pending: "Continue" resumes objective A', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      await turn(session, 'Please add a caching layer to the reporting dashboard exporter.', 'agent');
      expect(getConversationWorkingState(db, coreConversationId, identity)?.awaitingObjectiveClarification).toBe(true);

      await turn(session, 'Continue', 'agent');
      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.currentObjective).toBe(PRIOR_OBJECTIVE);
      expect(state?.awaitingObjectiveClarification).toBe(false);
    });

    it('clarification pending: "Yes new task" sets pendingNewObjective', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      await turn(session, 'Please add a caching layer to the reporting dashboard exporter.', 'agent');
      const restartedSession = await launch(root, client);
      await turn(restartedSession, 'Yes new task', 'agent');

      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.pendingNewObjective).toBe(true);
      expect(state?.awaitingObjectiveClarification).toBe(false);
      expect(state?.currentObjective).toBe(PRIOR_OBJECTIVE);
    });

    it('pending new objective survives a restart, and the next substantive message becomes objective B exactly once', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      await turn(session, 'Please add a caching layer to the reporting dashboard exporter.', 'agent');
      await turn(await launch(root, client), 'Yes new task', 'agent');
      expect(getConversationWorkingState(db, coreConversationId, identity)?.pendingNewObjective).toBe(true);

      // Simulate a restart: a fresh AgentPanel/session over the same durable db.
      const restarted = await launch(root, client);
      expect(getConversationWorkingState(db, coreConversationId, identity)?.pendingNewObjective).toBe(true);

      const objectiveB = 'Inspect this workspace and explain what this project does, its main components, and how it is run';
      await turn(restarted, objectiveB, 'agent');

      expect(restarted.submissions).toEqual([{ text: objectiveB, mode: 'agent' }]);
      const finalState = getConversationWorkingState(db, coreConversationId, identity);
      expect(finalState?.currentObjective).toBe(objectiveB);
      expect(finalState?.pendingNewObjective).toBe(false);

      // The ambiguity prompt fired exactly once across the whole exchange.
      const clarifyMsgs = [...session.posted, ...restarted.posted].filter(
        m => typeof m.content === 'string' && m.content.includes('Should I treat it as a new task'),
      );
      expect(clarifyMsgs.length).toBe(1);
    });

    it('New Chat clears stale clarification/pending state', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await withPriorObjective(client);

      // Get an ambiguity prompt pending, then confirm "new task" so both a
      // pending-new-objective flag and prior clarification history exist.
      await turn(session, 'Please add a caching layer to the reporting dashboard exporter.', 'agent');
      const restartedSession = await launch(root, client);
      await turn(restartedSession, 'Yes new task', 'agent');
      expect(getConversationWorkingState(db, coreConversationId, identity)?.pendingNewObjective).toBe(true);

      // Explicit reset intent triggers New Chat's hard reset.
      await turn(restartedSession, 'start fresh', 'agent');

      expect(getConversationWorkingState(db, coreConversationId, identity)).toBeNull();

      // A subsequent bare "yes" or "new task" must not resurrect the old
      // control-flow state — there is nothing pending to answer any more.
      const fresh = await launch(root, client);
      await turn(fresh, 'yes', 'agent');
      expect(fresh.submissions).toEqual([{ text: 'yes', mode: 'agent' }]);
      expect(getConversationWorkingState(db, coreConversationId, identity)?.pendingNewObjective).toBe(false);
    });
  });

  describe('Karke Dikha follow-up after a task on a brand-new conversation', () => {
    it('remembers the task started before the first turn was persisted, so a read-only follow-up stays conversational', async () => {
      const client = coreBackedClient(() => db, coreConversationId);
      const session = await launch(root, client);
      const route = (session.panel as never as {
        routeComposerSubmission: (
          text: string,
          submit: (effective: string) => void | Promise<void>,
          mode: string,
          conversationId?: string,
          submitConversational?: (effective: string) => void | Promise<void>,
        ) => Promise<void>;
      }).routeComposerSubmission.bind(session.panel);
      const recordTask = (session.panel as never as {
        recordTaskContinuity: (update: Record<string, unknown>) => Promise<void>;
      }).recordTaskContinuity.bind(session.panel);
      const conversational: string[] = [];

      // Turn 1: the autonomous task starts (and records its pointer) before this turn's working state exists.
      await route('Add a Duplicate Event feature to this existing Turnout Event Form Studio.', async () => {
        session.submissions.push({ text: 'task-1', mode: 'autonomous' });
        await recordTask({ latestTaskId: 'att_task_1', pendingAction: { kind: 'resume_work', description: 'An autonomous task is running for this objective.' } });
      }, 'autonomous', undefined, text => { conversational.push(text); });
      const workspaceIdentity = (session.panel as never as { workspaceIdentity: string }).workspaceIdentity;
      expect(getConversationWorkingState(db, coreConversationId, workspaceIdentity)?.latestTaskId).toBe('att_task_1');

      // Turn 2: the UAT follow-up must not start another autonomous task.
      const followUp = 'Briefly summarize what you changed and how I can manually test Duplicate Event.';
      await route(followUp, async () => {
        session.submissions.push({ text: followUp, mode: 'autonomous' });
      }, 'autonomous', undefined, text => { conversational.push(text); });
      expect(conversational).toEqual([followUp]);
      expect(session.submissions.filter(item => item.text === followUp)).toEqual([]);

      // A mutating request in the same conversation still goes to the autonomous path.
      await route('Now change the duplicated title format to "Copy of <title>".', async () => {
        session.submissions.push({ text: 'mutation', mode: 'autonomous' });
      }, 'autonomous', undefined, text => { conversational.push(text); });
      expect(session.submissions.map(item => item.text)).toContain('mutation');
      expect(conversational).toEqual([followUp]);
    });
  });

  describe('P0 continuation: pending task candidate and proposal anaphora', () => {
    const PRIOR = 'Suggest improvements.';
    const PROPOSAL = '1. Add input validation to app/main.py so empty payloads are rejected.\n2. Add unit tests for the validation.';
    const CANDIDATE = 'Please add a caching layer to the reporting dashboard exporter.';
    const clarifications = (session: Session) => session.posted.filter(
      m => typeof m.content === 'string' && /new task\?|What's the new task/i.test(m.content),
    );
    const candidateOf = (session: Session) => (session.panel as never as { pendingTaskCandidate: unknown }).pendingTaskCandidate;

    async function sessionWithProposal() {
      const client = coreBackedClient(() => db, coreConversationId);
      const first = await launch(root, client);
      identity = first.posted.find(m => m.type === 'workspaceRestorationResolved')!.workspaceIdentity as string;
      saveConversationWorkingState(db, coreConversationId, {
        workspaceIdentity: identity,
        latestUserIntent: PRIOR,
        currentObjective: PRIOR,
        latestFindingsSummary: PROPOSAL,
        actor: 'test',
      });
      return { client, session: await launch(root, client) };
    }

    it('A. "implement what you proposed" keeps the concrete objective and asks nothing', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, 'Implement what you proposed.', 'agent');
      expect(clarifications(session)).toEqual([]);
      expect(session.submissions).toHaveLength(1);
    });

    it('A2. anaphoric instructions continue instead of asking; a self-contained objective is not an anaphor', () => {
      const state = { currentObjective: PRIOR, latestUserIntent: PRIOR, relevantFiles: [], userConstraints: [] } as unknown as ConversationWorkingStateRecord;
      for (const text of ['build it', 'apply those fixes', 'fix what you found', 'make those changes', 'apply them', 'Please implement these']) {
        expect(detectObjectiveBoundary(text, state), text).toBe('same_objective');
      }
      expect(detectObjectiveBoundary('Build me a calculator app with a history panel', state)).not.toBe('same_objective');
    });

    it('A3. Karke Dikha resolves the referent into the compiled objective', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, 'build it', 'autonomous');
      expect(clarifications(session)).toEqual([]);
      expect(session.submissions[0].text).toContain('Add input validation to app/main.py');
    });

    it('B. "yes" to the new-task question binds to the pending candidate: no "what task?" loop', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, CANDIDATE, 'agent');
      expect(session.submissions).toEqual([]);
      await turn(session, 'yes', 'agent');
      expect(session.posted.some(m => typeof m.content === 'string' && /what'?s the new task/i.test(m.content))).toBe(false);
      expect(session.submissions).toEqual([{ text: CANDIDATE, mode: 'agent' }]);
      const state = getConversationWorkingState(db, coreConversationId, identity);
      expect(state?.currentObjective).toBe(CANDIDATE);
      expect(state?.pendingNewObjective).toBe(false);
      expect(state?.awaitingObjectiveClarification).toBe(false);
    });

    it('C. a genuinely ambiguous turn clarifies exactly once', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, CANDIDATE, 'agent');
      expect(clarifications(session)).toHaveLength(1);
      expect(session.submissions).toEqual([]);
    });

    it('D. New Chat clears the pending candidate; a later "yes" is ordinary content', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, CANDIDATE, 'agent');
      expect(candidateOf(session)).not.toBeNull();
      await turn(session, 'start fresh', 'agent');
      expect(candidateOf(session)).toBeNull();
      await turn(session, 'yes', 'agent');
      expect(session.submissions).toEqual([{ text: 'yes', mode: 'agent' }]);
    });

    it('E. History reopen (restore) leaves the candidate inert', async () => {
      const { session } = await sessionWithProposal();
      await turn(session, CANDIDATE, 'agent');
      await (session.panel as never as { restoreConversationContinuity: () => Promise<void> }).restoreConversationContinuity();
      expect(candidateOf(session)).toBeNull();
      expect(session.submissions).toEqual([]);
    });
  });
});
