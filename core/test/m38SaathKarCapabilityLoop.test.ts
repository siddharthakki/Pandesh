/**
 * M38 — Core Saath Kar governed-capability loop, end-to-end against the real
 * packaged HTTP surface (`POST /v1/attempts/:id/execute`,
 * `POST /v1/capabilities/approvals/:id/resolve`), mirroring
 * `saathKarExecutor.test.ts`'s harness. Proves the actual live routing this
 * milestone targets: `RuntimeExecutor.runAgentLoop` dispatching governed
 * capability tools in-process (never the dead `LocalAgentEngine`/`AgentLoop`/
 * `ToolExecutor.ts` path), suspending on `approval_required` via a durable
 * `attempt_loop_continuations` checkpoint, and resuming — including across a
 * real Core process restart (a fresh db connection and a fresh
 * `RuntimeExecutor` instance against the same on-disk database).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { listWorkspaceAttemptRehydration } from '../domain/attemptRehydration';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import type { ToolExecutionContext, ToolExecutionResult } from '../runtime/toolRunner';
import type { ModelToolCall, ModelToolDefinition } from '../runtime/modelBackend';

const TOKEN = generateToken();

/** A deterministic external-service fake: `ext_read` is read-only (executes
 * immediately, no approval), `ext_write` is consequential (must pass the
 * mutation-approval gate). Tracks call counts so tests can assert "exactly
 * once" and "zero mutations on denial". */
class FakeExternalCapability implements GovernedCapabilityAdapter {
  readonly id = 'ext';
  readCalls = 0;
  writeCalls: Array<{ arguments: Record<string, unknown> }> = [];
  definitions(): ModelToolDefinition[] {
    return [
      { name: 'ext_read', description: 'read-only external lookup', parameters: { type: 'object', properties: {} } },
      { name: 'ext_write', description: 'consequential external mutation', parameters: { type: 'object', properties: {} } },
    ];
  }
  classify(toolName: string): CapabilityRisk {
    return toolName === 'ext_read' ? 'read_only' : 'consequential';
  }
  health(): CapabilityHealth {
    return { state: 'available', checkedAt: new Date().toISOString() };
  }
  async run(call: ModelToolCall, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    if (call.name === 'ext_read') {
      this.readCalls += 1;
      return { status: 'succeeded', exitCode: 0, output: 'external evidence', resultCategory: 'ext_read_succeeded' };
    }
    this.writeCalls.push({ arguments: call.arguments });
    return { status: 'succeeded', exitCode: 0, output: 'mutation applied', resultCategory: 'ext_write_succeeded' };
  }
}

/**
 * Decides purely from the message array's content — not internal counter
 * state — exactly like a real stateless model call: request the given tool
 * call until a tool result is present, then give a final answer that
 * references it. This matters for the restart test below, which constructs
 * a brand-new backend instance mid-scenario (simulating a real Core process
 * restart) — an internal turn counter would "forget" progress that the real
 * conversation-message array (rebuilt from the durable continuation) still
 * remembers, which a real Ollama call never would either.
 */
class ScriptedCapabilityBackend implements ModelBackend {
  toolCall: ModelToolCall;
  seenToolMessages: string[] = [];
  constructor(toolCall: ModelToolCall, private readonly textualQwenCall = false) {
    this.toolCall = toolCall;
  }
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    for (const m of request.messages) if (m.role === 'tool') this.seenToolMessages.push(m.content);
    const hasToolResult = request.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      if (this.textualQwenCall) {
        return {
          content: `I will make the requested change.\n<function=${this.toolCall.name}>\n<parameter=command>\n${String(this.toolCall.arguments.command ?? '')}\n</parameter>\n</function>\n</tool_call>`,
          toolCalls: [],
          provider: 'ollama',
          model: request.model,
          usage: { durationMs: 1 },
        };
      }
      return { content: 'calling the tool', toolCalls: [this.toolCall], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    }
    const last = this.seenToolMessages[this.seenToolMessages.length - 1] ?? '';
    return { content: `final: ${last}`, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: ScriptedCapabilityBackend;
let capability: FakeExternalCapability;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

let n = 0;
const idemp = () => `idemp-m38-${++n}`;

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${a.status} reason=${a.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seedSaathKar(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({ currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false } }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  return { conversationId: conv.id, attemptId: attempt.id };
}

function startWith(toolCall: ModelToolCall) {
  backend = new ScriptedCapabilityBackend(toolCall);
  capability = new FakeExternalCapability();
  return startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend, toolRunner: new CoreToolRunner(), defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(capability),
    },
  });
}

function startWithGovernedWorkspace(toolCall: ModelToolCall, textualQwenCall = false) {
  backend = new ScriptedCapabilityBackend(toolCall, textualQwenCall);
  capability = new FakeExternalCapability();
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName) => toolName === 'read_file' ? 'read_only' : 'consequential',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async (call, context) => {
      if (call.name !== 'run_command') return workspaceRunner.run(call, context);
      fs.writeFileSync(path.join(context.cwd, 'note-saath.txt'), 'Hello from Saath Kar');
      return { status: 'succeeded', exitCode: 0, output: 'created note-saath.txt', resultCategory: 'command_succeeded' };
    },
  };
  return startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend, toolRunner: workspaceRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
    },
  });
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m38-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M38 Saath Kar: governed capability tool discovery', () => {
  it('exposes governed capability tool definitions in the real Saath Kar tool set alongside workspace tools', async () => {
    api = await startWith({ name: 'ext_read', arguments: {} });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { attemptId } = await seedSaathKar('inspect');
    const attempt = await (await authedFetch(`/v1/attempts/${attemptId}`)).json();
    expect(attempt.status).toBeDefined();
    const context = await (await authedFetch(`/v1/attempts/${attemptId}/context`)).json();
    expect(context.permittedCapabilities.allowedTools).toEqual(
      expect.arrayContaining(['run_command', 'read_file', 'ext_read', 'ext_write']),
    );
  });
});

describe('M38 Saath Kar: read-only governed capability', () => {
  it('executes a read-only governed call immediately, with no approval and a grounded final answer', async () => {
    api = await startWith({ name: 'ext_read', arguments: {} });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('look something up');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const done = await pollAttempt(attemptId, (a) => a.status === 'completed');
    expect(done.status).toBe('completed');
    expect(capability.readCalls).toBe(1);
    expect(capability.writeCalls).toHaveLength(0);
    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    const assistant = messages.filter((m: any) => m.role === 'assistant');
    expect(assistant[assistant.length - 1].content).toContain('external evidence');
  });
});

describe('Saath Kar workspace mutation approval authority', () => {
  const command = 'create note-saath.txt containing exactly Hello from Saath Kar';

  async function pendingWorkspaceAction(conversationId: string, attemptId: string) {
    await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
    expect(snapshot.actions).toHaveLength(1);
    const action = snapshot.actions[0];
    expect(action).toMatchObject({ actionable: true, toolName: 'run_command' });
    expect(action.arguments).toEqual({ command });
    expect(fs.existsSync(path.join(dir, 'note-saath.txt'))).toBe(false);

    const continuation = db.get<{ pendingApprovalId: string; state: string }>(
      'SELECT pendingApprovalId, state FROM attempt_loop_continuations WHERE attemptId = ?',
      [attemptId],
    );
    expect(continuation).toEqual({
      pendingApprovalId: action.approvalId,
      state: 'awaiting_capability_approval',
    });
    return action;
  }

  it('persists the exact approval before waiting, executes nothing before approval, and terminally rejects with no file', async () => {
    api = await startWithGovernedWorkspace({ name: 'run_command', arguments: { command } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('Create note-saath.txt containing Hello from Saath Kar');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWorkspaceAction(conversationId, attemptId);

    await jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'rejected',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    }));

    const terminal = await pollAttempt(attemptId, (attempt) => attempt.status === 'cancelled');
    expect(terminal.status).toBe('cancelled');
    expect(fs.existsSync(path.join(dir, 'note-saath.txt'))).toBe(false);
    expect(db.get('SELECT attemptId FROM attempt_loop_continuations WHERE attemptId = ?', [attemptId])).toBeUndefined();

    const replay = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    });
    expect(replay.status).toBe(409);
    expect(fs.existsSync(path.join(dir, 'note-saath.txt'))).toBe(false);
  }, 20000);

  it('routes a textual Qwen XML run_command through the same durable approval gate', async () => {
    api = await startWithGovernedWorkspace({ name: 'run_command', arguments: { command } }, true);
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('Create note-saath.txt containing Hello from Saath Kar');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWorkspaceAction(conversationId, attemptId);

    expect(action.arguments).toEqual({ command });
    expect(fs.existsSync(path.join(dir, 'note-saath.txt'))).toBe(false);
  }, 20000);

  it('executes only the exact current approved command once and completes with no pending approval', async () => {
    api = await startWithGovernedWorkspace({ name: 'run_command', arguments: { command } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('Create note-saath.txt containing Hello from Saath Kar');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWorkspaceAction(conversationId, attemptId);

    await jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    }));

    await pollAttempt(attemptId, (attempt) => attempt.status === 'completed');
    expect(fs.readFileSync(path.join(dir, 'note-saath.txt'), 'utf8')).toBe('Hello from Saath Kar');
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
    expect(snapshot.actions[0]).toMatchObject({ actionable: false, outcome: 'succeeded' });

    const replay = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    });
    expect(replay.status).toBe(409);
    expect(fs.readFileSync(path.join(dir, 'note-saath.txt'), 'utf8')).toBe('Hello from Saath Kar');
  }, 20000);
});

describe('M38 Saath Kar: consequential governed capability — suspension and resume', () => {
  it('suspends on approval_required without failing/completing, then resumes and executes exactly once on approval', async () => {
    api = await startWith({ name: 'ext_write', arguments: { note: 'do the thing' } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('mutate something');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });

    const waiting = await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');
    expect(waiting.status).toBe('waiting_for_approval');
    expect(capability.writeCalls).toHaveLength(0); // zero mutations before approval

    const request = await (await authedFetch(`/v1/attempts/${attemptId}`)).json();
    const conv = conversationId; // the request-derived conversationId is the correlationId RuntimeExecutor uses
    const actions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv)}`)).json();
    expect(actions.actions).toHaveLength(1);
    const action = actions.actions[0];
    expect(action.actionable).toBe(true);
    expect(action.toolName).toBe('ext_write');

    // Simulate a real Core process restart between suspension and approval:
    // close this db handle and executor entirely, reopen a fresh connection
    // to the same on-disk database, and start a brand-new RuntimeExecutor.
    ws.close();
    await api.close();
    db.close();
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    api = await startWith({ name: 'ext_write', arguments: { note: 'do the thing' } }); // fresh backend/capability instances, matching a real process restart
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const restoredActions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv)}`)).json();
    expect(restoredActions.actions).toHaveLength(1);
    const restoredAction = restoredActions.actions[0];
    expect(restoredAction.approvalId).toBe(action.approvalId);
    expect(restoredAction.actionable).toBe(true);

    const resolveRes = await authedFetch(`/v1/capabilities/approvals/${restoredAction.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: restoredAction.attemptId,
        expectedAttemptRevision: restoredAction.expectedAttemptRevision,
        expectedAttemptStatus: restoredAction.expectedAttemptStatus,
        requestedActionDigest: restoredAction.requestedActionDigest,
        frozenContextHash: restoredAction.frozenContextHash,
      }),
    });
    const resolved = await jsonOf(resolveRes);
    expect(resolved.resumedAttemptId).toBe(attemptId);

    const done = await pollAttempt(attemptId, (a) => a.status === 'completed', 5000);
    expect(done.status).toBe('completed');
    expect(capability.writeCalls).toHaveLength(1); // executed exactly once
    expect(capability.writeCalls[0].arguments).toEqual({ note: 'do the thing' });

    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    const assistant = messages.filter((m: any) => m.role === 'assistant');
    expect(assistant[assistant.length - 1].content).toContain('mutation applied');

    // No leftover continuation once terminal.
    const finalActions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conv)}`)).json();
    expect(finalActions.actions[0].actionable).toBe(false);
  }, 20000);

  it('denying performs zero mutations and feeds an honest denial back into the same conversation', async () => {
    api = await startWith({ name: 'ext_write', arguments: { note: 'should not happen' } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('mutate something else');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');

    const actions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
    const action = actions.actions[0];

    const resolveRes = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'rejected',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    });
    const resolved = await jsonOf(resolveRes);
    expect(resolved.resumedAttemptId).toBe(attemptId);

    const done = await pollAttempt(attemptId, (a) => a.status === 'completed', 5000);
    expect(done.status).toBe('completed');
    expect(capability.writeCalls).toHaveLength(0); // zero mutations

    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    const assistant = messages.filter((m: any) => m.role === 'assistant');
    expect(assistant[assistant.length - 1].content).toContain('denied');
  }, 20000);

  it('never compares the anchor capability approval\'s frozenContextHash to the real Saath Kar attempt\'s own frozenContextHash', async () => {
    // Regression test for a real cross-owner bug: the capability approval's
    // `frozenContextHash` (core/domain/capabilityDispatch.ts) is frozen from
    // the synthetic capability-dispatch *anchor* attempt's own context, not
    // the real Saath Kar attempt whose model loop is actually suspended
    // (core/domain/attemptLoopContinuation.ts's `frozenContextHash`, checked
    // against `context.contextHash` in executor.ts's resume path). These are
    // two different attempts with two different attempt contexts, so their
    // hashes must never be required to match — only `requestedActionDigest`
    // binds the continuation's pending action to the capability approval
    // (core/runtime/executor.ts ~line 424-430). This test proves the two
    // hashes are genuinely different values in a real run (not coincidentally
    // equal) and that resume still succeeds using the anchor's own hash.
    api = await startWith({ name: 'ext_write', arguments: { note: 'cross-owner-check' } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { conversationId, attemptId } = await seedSaathKar('mutate cross-owner');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');

    const continuationRow = db.get<{ frozenContextHash: string }>(
      'SELECT frozenContextHash FROM attempt_loop_continuations WHERE attemptId = ?', [attemptId],
    );
    expect(continuationRow?.frozenContextHash).toBeTruthy();

    const actions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
    const action = actions.actions[0];
    expect(action.frozenContextHash).toBeTruthy();

    // The anchor attempt's own frozen context and the real Saath Kar
    // attempt's own frozen context are frozen from two different attempts'
    // contexts and are never required to be equal.
    expect(action.attemptId).not.toBe(attemptId);
    expect(action.frozenContextHash).not.toBe(continuationRow!.frozenContextHash);

    const resolveRes = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash, // the anchor's own hash — never the real attempt's
      }),
    });
    const resolved = await jsonOf(resolveRes);
    expect(resolved.resumedAttemptId).toBe(attemptId);

    const done = await pollAttempt(attemptId, (a) => a.status === 'completed', 5000);
    expect(done.status).toBe('completed');
    expect(capability.writeCalls).toHaveLength(1);
  }, 20000);

  it('classifies a Saath Kar attempt suspended on a governed-capability approval as awaiting_human_approval, not requires_reconciliation', async () => {
    // Regression test for a real Core rehydration bug: `listWorkspaceAttemptRehydration`
    // (core/domain/attemptRehydration.ts) fetched only `listApprovalsForAttempt(db,
    // attempt.id)` to decide recovery — but a capability-gated approval's own
    // `attemptId` column is the capability-dispatch *anchor* attempt's id, never
    // this real Saath Kar attempt's (the same anchor/real split the identity
    // regression test above locks in). That lookup always came back empty, so
    // `classifyAttemptRecovery` treated every such attempt as
    // `requires_reconciliation` instead of `awaiting_human_approval` — which
    // made `AgentPanel.rehydrateCoreExecutionAttempt` return before ever
    // restoring it, so a real pending GitHub approval could never rehydrate
    // after a restart. The fix folds the attempt's own loop-continuation
    // `pendingApprovalId` into recovery classification without changing what
    // the wire record's own `approvals` field means.
    api = await startWith({ name: 'ext_write', arguments: { note: 'rehydration-check' } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { attemptId } = await seedSaathKar('mutate for rehydration check');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');

    const snapshot = listWorkspaceAttemptRehydration(db, dir);
    const record = snapshot.attempts.find((item) => item.attempt.id === attemptId);
    expect(record).toBeDefined();
    expect(record?.recovery).toBe('awaiting_human_approval');
  }, 20000);

  it('a tampered continuation checksum fails the attempt closed on resume instead of silently trusting it', async () => {
    api = await startWith({ name: 'ext_write', arguments: { note: 'x' } });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const { attemptId } = await seedSaathKar('mutate');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');

    // Tamper with the persisted row directly (simulating on-disk corruption)
    // without touching its checksum, then resolve the real approval through
    // the public route — this is what actually drives Core's auto-resume,
    // which must load and integrity-check the continuation before trusting it.
    const row = db.get<{ pendingApprovalId: string }>('SELECT pendingApprovalId FROM attempt_loop_continuations WHERE attemptId = ?', [attemptId]);
    expect(row?.pendingApprovalId).toBeTruthy();
    db.run(`UPDATE attempt_loop_continuations SET turnIndex = 99 WHERE attemptId = ?`, [attemptId]);

    const conversationId = (await seedSaathKarConversationOf(attemptId)).conversationId;
    const actions = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
    const action = actions.actions[0];

    await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved',
        attemptId: action.attemptId,
        expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus,
        requestedActionDigest: action.requestedActionDigest,
        frozenContextHash: action.frozenContextHash,
      }),
    });

    const failed = await pollAttempt(attemptId, (a) => a.status === 'failed', 5000);
    expect(failed.status).toBe('failed');
    expect(capability.writeCalls).toHaveLength(0); // never executed against a tampered checkpoint
  }, 20000);
});

/** Reads back the durable conversationId a previously-seeded Saath Kar
 * attempt belongs to, via its request row — used by the tamper test above,
 * which mutates the continuation after seeding and needs the same
 * correlationId RuntimeExecutor used without re-deriving it by hand. */
async function seedSaathKarConversationOf(attemptId: string): Promise<{ conversationId: string }> {
  const attempt = await (await authedFetch(`/v1/attempts/${attemptId}`)).json();
  const request = await (await authedFetch(`/v1/requests/${attempt.requestId}`)).json();
  return { conversationId: request.conversationId };
}
