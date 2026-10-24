/**
 * Tool-budget execution epochs: exhausting one epoch's tool turns on a healthy attempt
 * continues INSIDE the same attempt (same frozen workspace/repository binding) from a
 * compact checkpoint, is bounded by MAX_EXECUTION_EPOCHS, and never outlives a cancel.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { getAttemptContext } from '../domain/attemptContext';
import { classifyAttemptFailure } from '../domain/failureClassification';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { MAX_EXECUTION_EPOCHS } from '../runtime/executionEpoch';
import { LocalAutonomySecurityKernel } from '../security/kernel';

const TOKEN = generateToken();
const REPO_MARKER = 'REPO_PACKAGE_MARKER_seatCount';

/** Every model call before `toolTurns` requests a NEW file read (always progress); the next one answers. */
class EpochBackend implements ModelBackend {
  toolTurns = 0;
  requests: ModelChatRequest[] = [];
  onRequest: ((index: number) => Promise<void> | void) | null = null;
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    const index = this.requests.length;
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    await this.onRequest?.(index);
    const base = { provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    return index < this.toolTurns
      ? { ...base, content: `Working ${index}.`, toolCalls: [{ name: 'read_file', arguments: { path: `f${index}.txt` } }] }
      : { ...base, content: 'All done after continuing.', toolCalls: [] };
  }
}

let dir: string;
let workspace: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: EpochBackend;
let n = 0;
let currentAttemptId = '';

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
const idemp = () => `idemp-epoch-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const isTerminal = (a: any) => ['completed', 'failed', 'cancelled'].includes(a.status);

async function run() {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: 'Investigate how the measurement module works across several phases and report what you found.', requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: workspace, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(),
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'] },
    repositoryContext: { prompt: `### seats.ts\n${REPO_MARKER}\n`, selectedFiles: [{ path: 'seats.ts', estimatedTokens: 10 }], estimatedTokens: 12 },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'base:14b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true,
      candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: true, toolCalling: true, fileModification: false, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  currentAttemptId = result.attempt.id;
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { attemptId: result.attempt.id, requestId: result.request.id, conversationId: conv.id };
}

const epochEvents = (attemptId: string, type: string) => db.all<{ metadata: string }>(
  'SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ? ORDER BY sequence', [attemptId, type],
).map((e) => JSON.parse(e.metadata) as Record<string, any>);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-epoch-'));
  workspace = path.join(dir, 'ws');
  fs.mkdirSync(workspace);
  for (let i = 0; i < 80; i++) fs.writeFileSync(path.join(workspace, `f${i}.txt`), `contents of f${i}\n`, 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  backend = new EpochBackend();
  const runner = new CoreToolRunner();
  const adapter: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => runner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => runner.run(call, context),
  };
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend, toolRunner: runner, defaultModel: 'base:14b', defaultWorkingDirectory: workspace, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(adapter),
      validationCommandRunner: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});
afterEach(async () => {
  ws?.close();
  await api?.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('tool-budget execution epochs', () => {
  it('1: a short execution is unchanged and creates no continuation epoch', async () => {
    backend.toolTurns = 3;
    const { attemptId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal);
    expect(attempt.status).toBe('completed');
    expect(backend.requests).toHaveLength(4);
    expect(epochEvents(attemptId, 'execution_epoch_budget_reached')).toHaveLength(0);
    expect(epochEvents(attemptId, 'execution_epoch_continuing')).toHaveLength(0);
  });

  it('2-4: exhausting the epoch continues in the SAME attempt, keeps workspace/repository binding, and completes normally', async () => {
    backend.toolTurns = 20; // epoch 1 = 16 tool turns, epoch 2 finishes the work
    const { attemptId, requestId, conversationId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal);

    expect(attempt.status).toBe('completed'); // not failed, no user retry
    expect(attempt.failureReason ?? null).toBeNull();
    expect(db.all('SELECT id FROM attempts WHERE requestId = ?', [requestId])).toHaveLength(1);
    expect(backend.requests).toHaveLength(21);

    const reached = epochEvents(attemptId, 'execution_epoch_budget_reached');
    const continuing = epochEvents(attemptId, 'execution_epoch_continuing');
    expect(reached).toHaveLength(1);
    expect(reached[0]).toMatchObject({ executionEpoch: 1, toolTurnsUsed: 16, remainingEpochBudget: MAX_EXECUTION_EPOCHS - 1 });
    expect(continuing).toHaveLength(1);
    expect(continuing[0]).toMatchObject({
      executionEpoch: 2, remainingEpochBudget: MAX_EXECUTION_EPOCHS - 2, continuationKind: 'internal_continuation',
      workspaceRoot: workspace, repositoryBound: true,
    });

    // Binding: same frozen context before/after; the continued model call still carries the repository package and objective.
    const context = getAttemptContext(db, attemptId);
    expect(context.workspaceRoot).toBe(workspace);
    expect(continuing[0].contextHash).toBe(context.contextHash);
    const first = backend.requests[0].messages;
    const continued = backend.requests[16].messages; // first call of epoch 2
    expect(continued.some((m) => m.content.includes(REPO_MARKER))).toBe(true);
    expect(continued.slice(0, first.length).map((m) => m.content)).toEqual(first.map((m) => m.content));
    const checkpoint = continued.find((m) => m.role === 'system' && m.content.startsWith('EXECUTION CONTINUATION'));
    expect(checkpoint?.content).toContain('SAME task, not a new task');
    expect(checkpoint?.content).toContain('Investigate how the measurement module works');
    expect(checkpoint?.content).toContain(workspace);
    // Compact: the epoch-1 raw tool transcript is not replayed (only the final turn is kept verbatim).
    expect(continued.filter((m) => m.role === 'tool').length).toBe(1);

    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    expect(messages.filter((m: any) => m.role === 'assistant').pop().content).toBe('All done after continuing.');
  });

  it('5: total epoch exhaustion is a bounded, truthful stop — not endless continuation, not a provider failure', async () => {
    backend.toolTurns = 1000;
    const { attemptId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal, 40_000);

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toMatch(/^execution_budget_exhausted: exceeded 64 tool turns across 4 execution epochs/);
    expect(classifyAttemptFailure(attempt.failureReason)).toBe('gate_deadlock');
    expect(backend.requests).toHaveLength(MAX_EXECUTION_EPOCHS * 16);
    expect(epochEvents(attemptId, 'execution_epoch_continuing')).toHaveLength(MAX_EXECUTION_EPOCHS - 1);
    expect(epochEvents(attemptId, 'execution_epoch_budget_reached')).toHaveLength(MAX_EXECUTION_EPOCHS);
  }, 60_000);

  it('5b: each continuation journals a strictly increasing progress mark, so a restart restores the no-progress baseline instead of resetting it', async () => {
    backend.toolTurns = 1000;
    const { attemptId } = await run();
    await pollAttempt(attemptId, isTerminal, 40_000);

    const marks = epochEvents(attemptId, 'execution_epoch_continuing').map((e) => e.progressMark);
    expect(marks).toHaveLength(MAX_EXECUTION_EPOCHS - 1);
    for (const m of marks) expect(Number.isFinite(m)).toBe(true);
    for (let i = 1; i < marks.length; i++) expect(marks[i]).toBeGreaterThan(marks[i - 1]);
    // The epoch count the restart path reads is the same journal that bounds the budget: it can only grow.
    const continuing = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runtime_events WHERE entityId = ? AND eventType = 'execution_epoch_continuing'", [attemptId]);
    expect(continuing?.n).toBe(MAX_EXECUTION_EPOCHS - 1);
  }, 60_000);

  it('6: cancellation before the epoch boundary wins — no continuation epoch starts', async () => {
    backend.toolTurns = 1000;
    backend.onRequest = async (index) => {
      if (index === 15) await authedFetch(`/v1/attempts/${currentAttemptId}/cancel`, { method: 'POST', idempotencyKey: idemp() });
    };
    const { attemptId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal);

    expect(attempt.status).toBe('cancelled');
    expect(backend.requests.length).toBeLessThanOrEqual(16);
    expect(epochEvents(attemptId, 'execution_epoch_continuing')).toHaveLength(0);
  });

  it('a lost workspace binding at the boundary safe-stops instead of continuing unbound', async () => {
    backend.toolTurns = 1000;
    backend.onRequest = (index) => { if (index === 15) fs.rmSync(workspace, { recursive: true, force: true }); };
    const { attemptId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal);

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toMatch(/^execution_binding_lost:/);
    expect(classifyAttemptFailure(attempt.failureReason)).toBe('product_failure');
    expect(epochEvents(attemptId, 'execution_epoch_continuing')).toHaveLength(0);
    expect(backend.requests).toHaveLength(16);
  });

  it('M54 authority: safe mode entered during an epoch stops the attempt — a continuation never outlives revoked authority', async () => {
    backend.toolTurns = 1000;
    backend.onRequest = (index) => {
      if (index === 15) LocalAutonomySecurityKernel.getInstance(db).getSafeModeManager().enterSafeMode({ reason: 'epoch-continuation-test', actor: 'operator:test' });
    };
    const { attemptId } = await run();
    const attempt = await pollAttempt(attemptId, isTerminal);

    expect(attempt.status).not.toBe('completed');
    expect(epochEvents(attemptId, 'execution_epoch_continuing')).toHaveLength(0);
    expect(backend.requests.length).toBeLessThanOrEqual(16);
  });

  it('M54 authority: a continuation checkpoint persists no execution grant (every epoch must mint its own single-use grant)', async () => {
    backend.toolTurns = 20;
    const { attemptId } = await run();
    await pollAttempt(attemptId, isTerminal);
    const continuing = epochEvents(attemptId, 'execution_epoch_continuing');
    expect(continuing).toHaveLength(1);
    expect(JSON.stringify(continuing[0]).toLowerCase()).not.toContain('grant');
    for (const request of backend.requests) {
      for (const message of request.messages) expect(message.content).not.toMatch(/grantId|executionGrant|signature":/);
    }
  });
});
