/**
 * P0 (Build 161 audit, execution invariants): stopping a task stops the work it delegated.
 *
 * Real API server, executor and engine, a scripted local model, and a real child process. The user stops the parent
 * while its delegated Coding agent is running a command: the command's process tree must be killed, both attempts must
 * end in a terminal state, no tool call may stay open, and nothing may continue afterwards (no further model call for
 * the child, no late write by the killed program).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import type { RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import { appendMessage, createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { getAttempt } from '../domain/attempts';
import { isTerminalAttemptStatus } from '../domain/attemptTransitions';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import type { RuntimeExecutor } from '../runtime/executor';
import { afterToolResult, startScriptedOllama, type ScriptedModelCall, type ScriptedOllama } from './support/scriptedOllama';

const TOKEN = generateToken();
const isChild = (call: ScriptedModelCall) => /handled by the Coding agent/.test(call.system);
const isAlive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } };
async function waitFor(check: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

let model: ScriptedOllama;
let previousUrl: string | undefined;
let dir: string;
let ws: string;
let db: CoreDatabase;
let api: RunningApiServer;
let executor: RuntimeExecutor;
let Executor: typeof import('../runtime/executor').RuntimeExecutor;
let startApiServer: typeof import('../api/server').startApiServer;
let decider: NodeJS.Timeout | null = null;
/** Whether the user answers command cards in this test. */
let userAnswers = true;

beforeAll(async () => {
  model = await startScriptedOllama((call) => {
    const result = afterToolResult(call);
    if (isChild(call)) return result === null ? { tool: { name: 'run_checks', args: { command: 'node slow.js', workspacePath: ws } } } : { text: 'Ran it.' };
    return result === null ? { tool: { name: 'delegate_to_agent', args: { agent: 'coding', brief: 'Run node slow.js in the project folder and report its output.' } } } : { text: 'Done.' };
  });
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  // Imported only now: the engine reads the model server's address when its module loads (the API server loads it too).
  Executor = (await import('../runtime/executor')).RuntimeExecutor;
  startApiServer = (await import('../api/server')).startApiServer;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await model.close();
});

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-cancel-'));
  ws = path.join(dir, 'project');
  fs.mkdirSync(ws);
  // Records its PID, then would write late.txt after 4 s and otherwise run for ever.
  fs.writeFileSync(path.join(ws, 'slow.js'), "const fs = require('fs'); fs.writeFileSync('pid.txt', String(process.pid)); setTimeout(() => fs.writeFileSync('late.txt', 'continued after the stop'), 4000); setInterval(() => {}, 1000);\n");
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  executor = new Executor(db, broadcaster, { defaultModel: 'fake-model', dataDir: dir, defaultWorkingDirectory: ws });
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir, executor, onShutdown: () => {},
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'delegation-cancel', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
  });
  // The user approves the command card (running code needs approval), so the child's command really starts.
  userAnswers = true;
  decider = setInterval(() => {
    if (!userAnswers) return;
    for (const a of listPendingApprovals(db)) {
      try {
        resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
      } catch { /* resolved meanwhile */ }
    }
  }, 50);
});

afterEach(async () => {
  if (decider) clearInterval(decider);
  await api.close();
  db.close();
  for (let i = 0; i < 20; i += 1) {
    try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
});

function startTurn() {
  const text = 'Have a specialist run node slow.js in the project folder.';
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
  appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
  const { attempt } = submitRequest(db, {
    clientId: 'desktop', currentMessage: text, requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: ws,
    requestedProvider: 'ollama', selectedProvider: 'ollama', selectedModel: 'fake-model', toolPermissionPolicy: { profile: 'confirm-mutations' },
    capability: { hasWorkspace: true, gitCapable: false }, correlationId: `c-${Math.random()}`,
  } as Parameters<typeof submitRequest>[1]);
  return { attempt, running: executor.execute(attempt.id) };
}

function stop(attemptId: string) {
  return fetch(`http://127.0.0.1:${api.port}/v1/attempts/${attemptId}/cancel`, {
    method: 'POST', body: '{}',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'desktop', 'Idempotency-Key': `stop-${attemptId}` },
  });
}

describe('stopping a task stops what it delegated', () => {
  it.runIf(process.platform === 'win32')('kills the child\'s running command, settles both attempts, leaves nothing open, and nothing continues', async () => {
    const text = 'Have a specialist run node slow.js in the project folder.';
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const { attempt } = submitRequest(db, {
      clientId: 'desktop', currentMessage: text, requestedMode: 'baat_kar', conversationId: conv.id, workspaceRoot: ws,
      requestedProvider: 'ollama', selectedProvider: 'ollama', selectedModel: 'fake-model', toolPermissionPolicy: { profile: 'confirm-mutations' },
      capability: { hasWorkspace: true, gitCapable: false }, correlationId: `c-${Math.random()}`,
    } as Parameters<typeof submitRequest>[1]);
    const running = executor.execute(attempt.id);

    const pidFile = path.join(ws, 'pid.txt');
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').length > 0, 45_000, "the child's command to start");
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    expect(isAlive(pid)).toBe(true);
    const child = db.get<{ id: string }>('SELECT a.id AS id FROM agent_handoffs h JOIN attempts a ON a.requestId = h.childRequestId WHERE h.parentAttemptId = ?', [attempt.id]);
    expect(child).toBeTruthy();
    const callsAtStop = model.calls.length;

    const stop = await fetch(`http://127.0.0.1:${api.port}/v1/attempts/${attempt.id}/cancel`, {
      method: 'POST', body: '{}',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'desktop', 'Idempotency-Key': `stop-${attempt.id}` },
    });
    expect(stop.status).toBe(200);
    await running;

    await waitFor(() => !isAlive(pid), 10_000, 'the killed command to exit');
    expect(getAttempt(db, attempt.id).status).toBe('cancelled');
    const childStatus = getAttempt(db, child!.id).status;
    expect(isTerminalAttemptStatus(childStatus), childStatus).toBe(true);
    expect(childStatus).toBe('cancelled');
    expect(db.all('SELECT toolName, status FROM tool_invocations WHERE attemptId IN (?, ?) AND status IN (\'pending\', \'running\')', [attempt.id, child!.id])).toEqual([]);

    await new Promise((r) => setTimeout(r, 4_500));
    expect(fs.existsSync(path.join(ws, 'late.txt'))).toBe(false);
    expect(model.calls.slice(callsAtStop).filter(isChild)).toEqual([]);
  }, 120_000);
});

describe('an unanswered card does not outlive the task', () => {
  it.runIf(process.platform === 'win32')('stopped while the child waits on the user, the card is retired as expired with its reason, and the command never runs', async () => {
    userAnswers = false;
    const { attempt, running } = startTurn();
    let card: { id: string; attemptId: string } | undefined;
    await waitFor(() => { card = listPendingApprovals(db)[0] as typeof card; return Boolean(card); }, 45_000, "the child's command card");
    const child = db.get<{ id: string }>('SELECT a.id AS id FROM agent_handoffs h JOIN attempts a ON a.requestId = h.childRequestId WHERE h.parentAttemptId = ?', [attempt.id]);
    expect(card!.attemptId).toBe(child!.id);
    expect(getAttempt(db, child!.id).status).toBe('waiting_for_approval');

    expect((await stop(attempt.id)).status).toBe(200);
    await running;

    expect(getAttempt(db, attempt.id).status).toBe('cancelled');
    expect(getAttempt(db, child!.id).status).toBe('cancelled');
    expect(db.get<{ status: string }>('SELECT status FROM approvals WHERE id = ?', [card!.id])?.status).toBe('expired');
    // Audit evidence: the expiry is a runtime event with its reason — never recorded as a refusal by the user.
    const expired = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE domain = 'approval' AND entityId = ? AND eventType = 'approval_expired'", [card!.id]);
    expect(JSON.parse(expired?.metadata ?? '{}').reason).toMatch(/no answer was recorded|ended as/);
    expect(listPendingApprovals(db)).toEqual([]);
    expect(fs.existsSync(path.join(ws, 'pid.txt'))).toBe(false);
  }, 120_000);
});
