/**
 * M45 Phase 4 — progress-aware duplicate semantics in the Saath Kar loop.
 *
 * A duplicate call is not a failure. A turn that repeats one read but also makes
 * new reads is a progress turn; a repeat is judged against the workspace
 * revision it was made at; only turns that make nothing new escalate.
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
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelToolCall } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { getAttemptContext } from '../domain/attemptContext';
import { saveLoopContinuation } from '../domain/attemptLoopContinuation';
import { canonicalArgumentJson } from '../runtime/repositoryPathRecovery';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { estimatePromptTokens } from '../runtime/ollamaChatControls';
import { usableInputTokens } from '../shared/contextBudget';

const TOKEN = generateToken();
const ESCALATION = { provider: 'ollama', model: 'stronger:30b', reason: 'Stronger same-provider model.' };

/** Plays one scripted response per model call and records every request. */
class ScriptedBackend implements ModelBackend {
  script: Array<ModelToolCall[] | string> = [];
  requests: ModelChatRequest[] = [];
  /** When > 0, reports prompt_eval_count as this multiple of Core's own estimate. */
  promptTokenRatio = 0;
  /** What the durable continuation held at the moment of each request. */
  continuationBytes: number[] = [];
  calibrations: Array<number | undefined> = [];
  /** The raw durable continuation at the moment of each request (what a restart would rebuild from). */
  continuationJsons: string[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const row = db.get<{ continuationJson: string }>('SELECT continuationJson FROM attempt_loop_continuations LIMIT 1');
    if (row) {
      this.continuationBytes.push(Buffer.byteLength(row.continuationJson, 'utf8'));
      this.continuationJsons.push(row.continuationJson);
      this.calibrations.push((JSON.parse(row.continuationJson) as { promptCalibration?: number }).promptCalibration);
    }
    const step = this.script[this.requests.length - 1] ?? 'Done.';
    const promptTokens = this.promptTokenRatio > 0
      ? Math.round(estimatePromptTokens({ messages: request.messages, tools: request.tools }) * this.promptTokenRatio)
      : undefined;
    const base = { provider: 'ollama', model: request.model, usage: { durationMs: 1, ...(promptTokens ? { promptTokens } : {}) } };
    return typeof step === 'string'
      ? { ...base, content: step, toolCalls: [] }
      : { ...base, content: 'Working.', toolCalls: step };
  }
}

const read = (file: string): ModelToolCall => ({ name: 'read_file', arguments: { path: file } });
const propose = (file: string, content: string): ModelToolCall => ({ name: 'propose_file_change', arguments: { path: file, content } });

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
const idemp = () => `idemp-m45-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function startAttempt(message: string, mutation: boolean, execute = true, window?: number) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(), effectiveAllowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'],
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'base:14b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true,
      candidates: [], escalationCandidates: [ESCALATION],
      ...(window ? { contextWindowTokens: window, contextWindowSource: 'router_metadata' as const } : {}),
      requiredCapabilities: { readOnlyExplanation: !mutation, repositoryExploration: true, toolCalling: true, fileModification: mutation, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  if (execute) await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id, attemptId: result.attempt.id };
}

async function pendingAction(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const own = snapshot.actions.filter((a: any) => a.actionable);
  expect(own).toHaveLength(1);
  return own[0];
}

async function approve(action: any) {
  const res = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest,
      frozenContextHash: action.frozenContextHash,
    }),
  });
  expect(res.ok).toBe(true);
}

const quality = (attemptId: string) => db.all<{ eventType: string }>(
  "SELECT eventType FROM runtime_events WHERE domain = 'execution_quality' AND entityId = ? ORDER BY sequence", [attemptId],
).map((e) => e.eventType);
const count = (types: string[], type: string) => types.filter((t) => t === type).length;
const allToolText = (request: ModelChatRequest) => request.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n---\n');

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m45-loop-'));
  for (const name of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) fs.writeFileSync(path.join(dir, name), `contents of ${name}\n`, 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  backend = new ScriptedBackend();
  const runner = new CoreToolRunner();
  const workspace: GovernedCapabilityAdapter = {
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
      backend, toolRunner: runner, defaultModel: 'base:14b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(workspace),
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

const readInvocations = () => db.all<{ id: string }>("SELECT id FROM tool_invocations WHERE toolName = 'read_file'").length;

describe('M45 progress-aware loop', () => {
  it('does not declare a multi-file objective satisfied after only the first approved change', async () => {
    backend.script = [[propose('a.txt', 'changed a\n')], [read('b.txt')], [propose('b.txt', 'changed b\n')], 'Updated both files.'];
    const { conversationId, attemptId } = await startAttempt('Update a.txt and b.txt, reading b.txt before changing it.', true);
    await approve(await pendingAction(conversationId, attemptId));
    await pollAttempt(attemptId, a => a.status === 'waiting_for_approval' || a.status === 'completed' || a.status === 'failed');
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readInvocations()).toBe(1);
    expect(backend.requests[2].tools?.length).toBeGreaterThan(0);
    await approve(await pendingAction(conversationId, attemptId));
    expect((await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed')).status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('changed b\n');
  });
  it('keeps a three-file objective open through every approval: tools stay offered and the attempt completes only after the last change', async () => {
    backend.script = [[propose('a.txt', 'changed a\n')], [read('a.txt')], [read('b.txt')], [propose('b.txt', 'changed b\n')], [read('c.txt')], [propose('c.txt', 'changed c\n')], 'Updated a, b and c.'];
    const { conversationId, attemptId } = await startAttempt('Update a.txt, b.txt and c.txt, reading each before changing it.', true);
    for (const file of ['a.txt', 'b.txt', 'c.txt']) {
      await approve(await pendingAction(conversationId, attemptId));
      if (file !== 'c.txt') {
        const attempt = await pollAttempt(attemptId, a => a.status === 'waiting_for_approval' || a.status === 'completed' || a.status === 'failed');
        expect(attempt.status).toBe('waiting_for_approval');
      }
    }
    expect((await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed')).status).toBe('completed');
    for (const [file, text] of [['a.txt', 'changed a\n'], ['b.txt', 'changed b\n'], ['c.txt', 'changed c\n']]) expect(fs.readFileSync(path.join(dir, file), 'utf8')).toBe(text);
    // Every request that followed an applied change still offered tools; no read was refused as redundant.
    for (const request of backend.requests.slice(1)) expect(request.tools?.length).toBeGreaterThan(0);
    expect(quality(attemptId)).not.toContain('redundant_exploration_refused');
    expect(readInvocations()).toBe(3);
  });

  it('a turn that re-reads A beside new reads is a progress turn: A is served cached, nothing escalates, the attempt completes (2026-09-29 regression)', async () => {
    backend.script = [[read('a.txt'), read('b.txt')], [read('a.txt'), read('c.txt')], [read('a.txt'), read('d.txt')], 'Explained from a, b, c and d.'];
    const { attemptId } = await startAttempt('Explain a.txt together with b.txt, c.txt and d.txt.', false);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    expect(backend.requests).toHaveLength(4);
    // A, B, C and D were each really read once; the two repeats of A were not.
    expect(readInvocations()).toBe(4);
    const types = quality(attemptId);
    expect(count(types, 'loop_detected')).toBe(2);
    expect(types).not.toContain('strategy_changed');
    expect(types).not.toContain('model_escalated');
    expect(types).not.toContain('decision_required');
    expect(backend.requests.every((r) => r.model === 'base:14b')).toBe(true);
    expect(allToolText(backend.requests[3])).toContain('UNCHANGED');
  });

  it('allows verification of changed content and a new target after an approved mutation', async () => {
    backend.script = [[read('a.txt')], [propose('a.txt', 'changed a\n')], [read('a.txt')], [read('b.txt')], 'Verified a and inspected b.'];
    const { conversationId, attemptId } = await startAttempt('Update a.txt and inspect b.txt.', true);
    await approve(await pendingAction(conversationId, attemptId));
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');
    expect(readInvocations()).toBe(3);
    expect(backend.requests.at(-1)!.tools!.length).toBeGreaterThan(0);
    expect(db.all("SELECT id FROM runtime_events WHERE eventType = 'final_answer_only_tool_call_refused'")).toHaveLength(0);
  });

  it('three consecutive turns of only a cached read fail with the existing reason: strategy change once, then decision required', async () => {
    backend.script = [[read('a.txt')], [read('a.txt')], [read('a.txt')], [read('a.txt')], 'unreachable'];
    const { attemptId } = await startAttempt('Explain a.txt.', false);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toContain('blocked after repeated non-progress for read_file; choose a different target or add guidance');
    expect(readInvocations()).toBe(1);
    const types = quality(attemptId);
    expect(count(types, 'loop_detected')).toBe(3);
    expect(count(types, 'strategy_changed')).toBe(1);
    expect(count(types, 'model_escalated')).toBe(1);
    expect(count(types, 'decision_required')).toBe(1);
    expect(backend.requests).toHaveLength(4);
    expect(backend.requests.map((r) => r.model)).toEqual(['base:14b', 'base:14b', 'stronger:30b', 'stronger:30b']);
    expect(allToolText(backend.requests[2])).toContain('STRATEGY_CHANGE');
    expect(allToolText(backend.requests[3])).toContain('DECISION_REQUIRED');
  });

  it('progress between repeats resets the count, so an occasional duplicate never accumulates into a failure', async () => {
    backend.script = [[read('a.txt')], [read('a.txt')], [read('b.txt')], [read('a.txt')], [read('c.txt')], 'Done.'];
    const { attemptId } = await startAttempt('Explain a.txt, b.txt and c.txt.', false);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');
    // Each cached turn was followed by a progress turn, so the count never got past 1:
    // two strategy nudges, but never a decision request and never a failure.
    expect(count(quality(attemptId), 'strategy_changed')).toBe(2);
    expect(count(quality(attemptId), 'decision_required')).toBe(0);
  });

  it('an identical mutation re-proposed in the same revision is not dispatched and creates no second approval', async () => {
    const proposal = propose('a.txt', 'changed a\n');
    backend.script = [[proposal], [proposal], 'Updated a.txt once.'];
    const { conversationId, attemptId } = await startAttempt('Update a.txt.', true);
    const action = await pendingAction(conversationId, attemptId);
    await approve(action);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('changed a\n');
    expect(db.all("SELECT id FROM approvals WHERE json_extract(summary, '$.toolName') = 'propose_file_change'")).toHaveLength(1);
    expect(allToolText(backend.requests.at(-1)!)).toContain('NOT REPEATED');
  });

  it('resumes from a checkpoint written before M45 (no revision, no loopProgress) with the initial state', async () => {
    const { conversationId, attemptId } = await startAttempt('Explain a.txt.', false, false);
    const context = getAttemptContext(db, attemptId);
    const seq = db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM conversation_messages WHERE conversationId = ?', [conversationId])!.seq;
    saveLoopContinuation(db, attemptId, {
      state: 'running', provider: 'ollama', model: 'base:14b', turnIndex: 0, baseMessageSeq: Number(seq),
      // Exactly the pre-M45 shape: a prior read with none of the new fields, and no loopProgress.
      payload: {
        deltaMessages: [],
        priorOperations: [[`read_file:${canonicalArgumentJson({ path: 'a.txt' })}`, { signature: 'legacy', resultCategory: 'read_file_succeeded', evidenceHash: 'h', repeats: 0 }]],
        pendingCall: null,
        remainingCalls: [],
      },
      frozenContextHash: context.contextHash,
    });
    backend.script = [[read('a.txt')], 'Done.'];
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    // The legacy entry reads as revision 0, the same revision as the fresh state: the repeat is cached.
    expect(readInvocations()).toBe(0);
    expect(count(quality(attemptId), 'loop_detected')).toBe(1);
    expect(allToolText(backend.requests.at(-1)!)).toContain('UNCHANGED');
  });
});

const BIG = 7_500;
const writeBig = (name: string) => fs.writeFileSync(path.join(dir, `${name}.txt`), `START_${name}\n${'y'.repeat(BIG)}\nEND_${name}\n`, 'utf8');
const compacted = (attemptId: string) => db.all<{ metadata: string }>(
  "SELECT metadata FROM runtime_events WHERE eventType = 'context_compacted' AND entityId = ?", [attemptId],
).map((row) => JSON.parse(row.metadata));
const estimateOf = (request: ModelChatRequest) => estimatePromptTokens({ messages: request.messages, tools: request.tools });

describe('M45 loop-delta compaction (Tier 1)', () => {
  beforeEach(() => { for (const name of ['big1', 'big2', 'big3', 'big4', 'big5', 'big6']) writeBig(name); });

  it('an 8192-token window completes six 8 KB reads: bodies are cleared, the latest stays whole, every prompt fits', async () => {
    const window = 8192;
    backend.script = [
      [read('big1.txt')], [read('big2.txt')], [read('big3.txt')], [read('big4.txt')], [read('big5.txt')], [read('big6.txt')],
      'Summarized all six files.',
    ];
    const { attemptId } = await startAttempt('Explain big1.txt through big6.txt.', false, true, window);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    const events = compacted(attemptId).filter((event) => event.tier === 'loop_delta');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]).toMatchObject({ surface: 'saath_kar', windowTokens: window, windowSource: 'router_metadata' });
    expect(events[0].clearedBodies).toBeGreaterThan(0);
    expect(events[0].afterChars).toBeLessThan(events[0].beforeChars);

    // The latest turn's body is intact; an older one was cleared but kept its call identity.
    const finalRequest = backend.requests.at(-1)!;
    const toolText = allToolText(finalRequest);
    expect(toolText).toContain('START_big6');
    expect(toolText).toContain('END_big6');
    expect(toolText).not.toContain('START_big1');
    expect(toolText).toContain('result body cleared from active context');
    expect(toolText).toContain('[read_file]');

    // Every request fit the window, and no continuation ever approached its byte limit.
    const usable = usableInputTokens({ contextTokens: window, source: 'router_metadata' });
    for (const request of backend.requests) expect(estimateOf(request)).toBeLessThanOrEqual(usable);
    expect(Math.max(...backend.continuationBytes)).toBeLessThan(256 * 1024);
  });

  it('after a body is cleared an identical read re-executes once without counting as a repeat; the second is cached', async () => {
    backend.script = [
      [read('big1.txt')], [read('big2.txt')], [read('big3.txt')], [read('big1.txt')], [read('big4.txt')], [read('big5.txt')], [read('big1.txt')],
      'Done.',
    ];
    const { attemptId } = await startAttempt('Explain big1.txt through big5.txt.', false, true, 8192);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    // big1..big5 once each, plus the one permitted re-fetch of big1; the third big1 read never ran.
    expect(readInvocations()).toBe(6);
    expect(count(quality(attemptId), 'loop_detected')).toBe(1);
    expect(allToolText(backend.requests.at(-1)!)).toContain('already re-fetched once');
  });

  it('a prompt-token report above the estimate raises the calibration, persists it, and shrinks the budget from then on', async () => {
    fs.writeFileSync(path.join(dir, 'small.txt'), 'small file\n', 'utf8');
    backend.promptTokenRatio = 1.5;
    backend.script = [[read('small.txt')], [read('a.txt')], 'Done.'];
    const { attemptId } = await startAttempt('Explain small.txt and a.txt.', false);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    const persisted = backend.calibrations.filter((value): value is number => typeof value === 'number');
    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every((value) => Math.abs(value - 1.5) < 0.02)).toBe(true);
  });

  it('never lowers the calibration: an under-reporting cache hit leaves it alone', async () => {
    fs.writeFileSync(path.join(dir, 'small.txt'), 'small file\n', 'utf8');
    backend.promptTokenRatio = 0.4; // Ollama reports only the uncached suffix
    backend.script = [[read('small.txt')], 'Done.'];
    const { attemptId } = await startAttempt('Explain small.txt.', false);
    await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(backend.calibrations.every((value) => value === undefined || value === 1)).toBe(true);
  });

  it('resumes from a checkpoint with no compaction cursor: nothing is clearable, and the budget is still enforced', async () => {
    const { conversationId, attemptId } = await startAttempt('Explain a.txt.', false, false, 8192);
    const context = getAttemptContext(db, attemptId);
    const seq = db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM conversation_messages WHERE conversationId = ?', [conversationId])!.seq;
    saveLoopContinuation(db, attemptId, {
      state: 'running', provider: 'ollama', model: 'base:14b', turnIndex: 0, baseMessageSeq: Number(seq),
      payload: {
        // The Phase 4 shape: loopProgress present, no toolMessageKeys, no promptCalibration.
        deltaMessages: [
          { role: 'assistant', content: 'a'.repeat(3_000) },
          { role: 'tool', content: `[read_file] exit=0\n${'z'.repeat(30_000)}` },
          { role: 'assistant', content: 'Working.' },
          { role: 'tool', content: '[read_file] exit=0\nsmall' },
        ],
        priorOperations: [],
        loopProgress: { revision: 0, nonProgressTurns: 0 },
        pendingCall: null,
        remainingCalls: [],
      },
      frozenContextHash: context.contextHash,
    });
    backend.script = ['unreachable'];
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toContain('context_budget_exhausted: active Saath context exceeds the model window after compaction');
    expect(backend.requests).toHaveLength(0);
    // Only the older assistant text could be shortened; no tool body was cleared without a recorded key.
    const events = compacted(attemptId);
    expect(events.every((event) => event.clearedBodies === 0)).toBe(true);
  });
});

const LINE_WIDTH = 78;
const writeLined = (name: string, lines: number) => fs.writeFileSync(
  path.join(dir, `${name}.txt`),
  `${Array.from({ length: lines }, (_, i) => `${name} line ${i + 1} ${'x'.repeat(LINE_WIDTH - `${name} line ${i + 1} `.length)}`).join('\n')}\n`,
  'utf8',
);
const toolMessages = (request: ModelChatRequest) => request.messages.filter((m) => m.role === 'tool').map((m) => m.content);
const freshEvents = (attemptId: string) => compacted(attemptId).filter((event) => event.tier === 'fresh_result');

describe('M45 fresh-result admission (corrective)', () => {
  const EIGHT = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8'];
  beforeEach(() => { for (const name of EIGHT) writeLined(name, 60); }); // ~4.7 KB each, ~37 KB together

  const eightReads = () => EIGHT.map((name) => read(`${name}.txt`));
  const usable = (window: number) => usableInputTokens({ contextTokens: window, source: 'router_metadata' });

  it('D3 shape: eight parallel reads (~37 KB) in one turn are admitted as a fair projection, not failed', async () => {
    backend.script = [eightReads(), 'Explained all eight files.'];
    const { attemptId } = await startAttempt('Explain f1.txt through f8.txt.', false, true, 8192);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    expect(backend.requests).toHaveLength(2);
    const events = freshEvents(attemptId);
    expect(events).toHaveLength(1);
    const detail = events[0].detail;
    expect(detail.freshBatchChars).toBeGreaterThan(36_000);
    expect(events[0].afterChars).toBeLessThanOrEqual(events[0].budgetChars);
    expect(events[0].afterChars).toBeLessThan(detail.freshBatchChars);
    expect(detail.estimatedPromptTokensBefore).toBeGreaterThan(detail.inputBudgetTokens);
    expect(detail.estimatedPromptTokensAfter).toBeLessThanOrEqual(detail.inputBudgetTokens);
    expect(detail.inputBudgetTokens).toBe(usable(8192));

    // All eight calls are still represented, each identified; the request fits the window.
    const results = toolMessages(backend.requests[1]).filter((text) => text.startsWith('[read_file]'));
    expect(results).toHaveLength(8);
    for (const name of EIGHT) expect(results.some((text) => text.includes(`${name} line 1 `))).toBe(true);
    expect(results.filter((text) => text.includes('[COMPACTED')).length).toBe(detail.compacted.length);
    for (const request of backend.requests) expect(estimateOf(request)).toBeLessThanOrEqual(usable(8192));
    // Core still holds every full result.
    expect(readInvocations()).toBe(8);
    const evidence = db.all<{ evidence: string }>("SELECT evidence FROM tool_invocations WHERE toolName = 'read_file'");
    expect(evidence.every((row) => row.evidence.includes('line 60'))).toBe(true);
  });

  it('the compacted projection is what a restart would rebuild from', async () => {
    backend.script = [eightReads(), 'Done.'];
    const { attemptId } = await startAttempt('Explain f1.txt through f8.txt.', false, true, 8192);
    await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    const persisted = JSON.parse(backend.continuationJsons.at(-1)!) as { deltaMessages: Array<{ content: string }>; priorOperations: Array<[string, { bodyProjected?: boolean }]> };
    expect(persisted.deltaMessages.filter((m) => m.content.includes('[COMPACTED')).length).toBeGreaterThan(0);
    expect(persisted.priorOperations.some(([, operation]) => operation.bodyProjected === true)).toBe(true);
    // The persisted delta is the projection, byte for byte, that the model was sent.
    const sent = toolMessages(backend.requests[1]);
    for (const message of persisted.deltaMessages.filter((m) => m.content.startsWith('[read_file]'))) expect(sent).toContain(message.content);
  });

  it('resumes from a checkpoint that already holds compacted projections: they are kept, and an identical repeat is redirected to a range', async () => {
    const { conversationId, attemptId } = await startAttempt('Explain f1.txt.', false, false, 8192);
    const context = getAttemptContext(db, attemptId);
    const seq = db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM conversation_messages WHERE conversationId = ?', [conversationId])!.seq;
    const operationKey = `read_file:${canonicalArgumentJson({ path: 'f1.txt' })}`;
    const projection = '[read_file] exit=0\n[COMPACTED read_file path="f1.txt": 4,800 chars, digest abc]\nf1 line 1\n… [lines 2-59 omitted] …\nf1 line 60\n[COMPACTED: shown lines 1 and 60 of 60; 4,000 chars omitted. NOT the complete result — Core retains the full output. Recover: read_file path="f1.txt" startLine=2 endLine=59.]';
    saveLoopContinuation(db, attemptId, {
      state: 'running', provider: 'ollama', model: 'base:14b', turnIndex: 0, baseMessageSeq: Number(seq),
      payload: {
        deltaMessages: [{ role: 'assistant', content: 'Working.' }, { role: 'tool', content: projection }],
        priorOperations: [[operationKey, { signature: 's', resultCategory: 'read_succeeded', evidenceHash: 'abc', repeats: 0, revision: 0, bodyProjected: true }]],
        loopProgress: { revision: 0, nonProgressTurns: 0 },
        toolMessageKeys: [[1, operationKey]],
        promptCalibration: 1,
        pendingCall: null,
        remainingCalls: [],
      },
      frozenContextHash: context.contextHash,
    });
    backend.script = [[read('f1.txt')], 'Done.'];
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    expect(toolMessages(backend.requests[0])).toContain(projection);
    expect(readInvocations()).toBe(0); // the identical repeat was not re-run
    const last = toolMessages(backend.requests.at(-1)!).join('\n');
    expect(last).toContain('shown only in part');
    expect(last).toContain('startLine/endLine');
  });

  it('a targeted re-read of an omitted range executes (it is new progress), returns exactly those lines, and completes', async () => {
    backend.script = [eightReads(), [{ name: 'read_file', arguments: { path: 'f3.txt', startLine: 20, endLine: 24 } }], 'Answered from the range.'];
    const { attemptId } = await startAttempt('Explain f1.txt through f8.txt.', false, true, 8192);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    expect(readInvocations()).toBe(9);
    const range = toolMessages(backend.requests.at(-1)!).find((text) => text.includes('LINES 20-24 of 60'));
    expect(range).toBeDefined();
    expect(range).toContain('f3 line 20 ');
    expect(range).toContain('f3 line 24 ');
    expect(range).not.toContain('f3 line 25 ');
    expect(quality(attemptId)).not.toContain('loop_detected');
    for (const request of backend.requests) expect(estimateOf(request)).toBeLessThanOrEqual(usable(8192));
  });

  it('an error result in the batch is preserved verbatim while the reads around it are compacted', async () => {
    backend.script = [[...eightReads(), read('does-not-exist.txt')], 'Done.'];
    const { attemptId } = await startAttempt('Explain f1.txt through f8.txt.', false, true, 8192);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    const results = toolMessages(backend.requests[1]);
    const failed = results.filter((text) => !text.startsWith('[read_file] exit=0'));
    expect(failed.length).toBeGreaterThan(0);
    // The failed read was neither compacted nor dropped.
    expect(failed.every((text) => !text.includes('[COMPACTED'))).toBe(true);
    expect(failed.join('\n')).toContain('Repository path blocked: not_found');
    expect(results.filter((text) => text.includes('[COMPACTED')).length).toBeGreaterThan(0);
  });

  it('still prunes older results first: they are cleared before any fresh result is compacted', async () => {
    for (const name of ['big1', 'big2']) writeBig(name);
    backend.script = [[read('big1.txt')], [read('big2.txt')], eightReads(), 'Done.'];
    const { attemptId } = await startAttempt('Explain everything.', false, true, 8192);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('completed');
    const events = compacted(attemptId);
    const firstFresh = events.findIndex((event) => event.tier === 'fresh_result');
    expect(firstFresh).toBeGreaterThanOrEqual(0);
    expect(events.slice(0, firstFresh).some((event) => event.tier === 'loop_delta' && event.clearedBodies > 0)).toBe(true);
    const finalText = toolMessages(backend.requests.at(-1)!).join('\n');
    expect(finalText).not.toContain('START_big1');
    expect(finalText).toContain('result body cleared from active context');
    for (const request of backend.requests) expect(estimateOf(request)).toBeLessThanOrEqual(usable(8192));
  });

  it('a 32k window with a batch far past the transport cap is projected rather than rejected', async () => {
    const many = Array.from({ length: 24 }, (_, i) => `w${i}`);
    for (const name of many) writeLined(name, 100); // 24 reads, each bounded at 8,000 chars: ~190 KB
    backend.script = [many.map((name) => read(`${name}.txt`)), 'Done.'];
    const { attemptId } = await startAttempt('Explain all the w files.', false, true, 32_768);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 30_000);

    expect(attempt.status).toBe('completed');
    const events = freshEvents(attemptId);
    expect(events).toHaveLength(1);
    expect(events[0].detail.freshBatchChars).toBeGreaterThan(160_000);
    expect(events[0].afterChars).toBeLessThanOrEqual(160_000);
    expect(events[0].detail.compacted.length).toBeGreaterThan(0);
    expect(estimateOf(backend.requests[1])).toBeLessThanOrEqual(usable(32_768));
    expect(Math.max(...backend.continuationBytes)).toBeLessThan(256 * 1024);
  });

  it('still fails closed with the existing reason when what cannot be compacted alone overflows', async () => {
    const { conversationId, attemptId } = await startAttempt('Explain a.txt.', false, false, 8192);
    const context = getAttemptContext(db, attemptId);
    const seq = db.get<{ seq: number }>('SELECT MAX(seq) AS seq FROM conversation_messages WHERE conversationId = ?', [conversationId])!.seq;
    // A command result has no read-only key, so it is never compacted.
    saveLoopContinuation(db, attemptId, {
      state: 'running', provider: 'ollama', model: 'base:14b', turnIndex: 0, baseMessageSeq: Number(seq),
      payload: {
        deltaMessages: [{ role: 'assistant', content: 'Working.' }, { role: 'tool', content: `[run_command] exit=0\n${'o'.repeat(60_000)}` }],
        priorOperations: [], loopProgress: { revision: 0, nonProgressTurns: 0 }, toolMessageKeys: [], promptCalibration: 1,
        pendingCall: null, remainingCalls: [],
      },
      frozenContextHash: context.contextHash,
    });
    backend.script = ['unreachable'];
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed', 20_000);

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toContain('context_budget_exhausted: active Saath context exceeds the model window after compaction');
    expect(backend.requests).toHaveLength(0);
    expect(freshEvents(attemptId)).toHaveLength(0);
  });
});
