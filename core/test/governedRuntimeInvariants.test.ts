/**
 * Post-M49.2 governed-runtime invariants, each reproducing a defect observed in the M49.2 cohort
 * (docs/M49_2_COHORT_FORENSICS.md). Deterministic: scripted backend, injected validation runner.
 *
 *  D1. Native tool_calls get the declared required-argument gate: a propose_text_edit with no `replace`
 *      never runs (cohort run 12 wiped a file this way).
 *  D2. An anchored edit Core already knows cannot apply is refused before any approval, and a turn that
 *      then ends without a real proposal is not completed (runs 1, 7, 11).
 *  D3. A policy-denied proposal is not a mutation proposal: the corrective turn is not "recovered" by it
 *      (run 16).
 *  D4. An anchored edit that would delete almost the whole file hits the same guard as a truncating
 *      whole-file write (run 12).
 *  D5. A native call naming a tool outside the exposed set runs nothing.
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
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';

const TOKEN = generateToken();

type Script = (request: ModelChatRequest, call: number) => { content: string; toolCalls?: ModelToolCall[] };

class ScriptedBackend implements ModelBackend {
  calls = 0;
  requests: ModelChatRequest[] = [];
  constructor(public script: Script) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
    const out = this.script(request, ++this.calls);
    return { content: out.content, toolCalls: out.toolCalls ?? [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

const native = (name: string, args: Record<string, unknown>, say = '') => ({ content: say, toolCalls: [{ name, arguments: args }] });
const hasToolResult = (request: ModelChatRequest) => request.messages.some((message) => message.role === 'tool');
const toolTexts = (request: ModelChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
const systemTexts = (request: ModelChatRequest) => request.messages.filter((message) => message.role === 'system').map((message) => message.content);

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;
const idemp = () => `idemp-inv-${++n}`;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.headers as Record<string, string> | undefined) };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
async function jsonOf(res: Response) { expect(res.ok).toBe(true); return res.json(); }
async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (a: any) => a.status === 'completed' || a.status === 'failed' || a.status === 'waiting_for_approval';
/** Submits a Saath Kar turn with frozen model-selection evidence; `fileModification` marks a mutation-intent task. */
async function runTurn(message: string, fileModification = true) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const correlationId = idemp();
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar',
    conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId,
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'] },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: !fileModification, repositoryExploration: true, toolCalling: true, fileModification, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  const attemptId = result.attempt.id as string;
  await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
  const finished = await pollAttempt(attemptId, settled);
  return { conversationId: conv.id as string, correlationId, attemptId, finished };
}
const eventTypes = (attemptId: string) => (db.all('SELECT eventType FROM runtime_events WHERE entityId = ?', [attemptId]) as Array<{ eventType: string }>).map((row) => row.eventType);
const eventMeta = (attemptId: string, type: string) => (db.all('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ?', [attemptId, type]) as Array<{ metadata: string }>).map((row) => JSON.parse(row.metadata));

async function startCore() {
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend, toolRunner: workspaceRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
      validationCommandRunner: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
}

const BIG_FILE = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}: some reasonably long original content`).join('\n')}\n`;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-invariants-test-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\nline two\nline three\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'big.txt'), BIG_FILE, 'utf8');
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db?.close();
  ws = undefined as unknown as typeof ws;
  api = undefined as unknown as typeof api;
  db = undefined as unknown as typeof db;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('D1/D5. native tool_calls pass the exposed-name and required-argument gate', () => {
  it('a native propose_text_edit without `replace` runs nothing and gets the one precise correction', async () => {
    backend = new ScriptedBackend((request, call) => (call === 1
      ? native('propose_text_edit', { path: 'big.txt', find: BIG_FILE })
      : { content: 'I could not make the change.' }));
    await startCore();
    const turn = await runTurn('Change line 2 of big.txt');

    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(toolTexts(backend.requests[1])).toHaveLength(0);
    expect(systemTexts(backend.requests[1]).join('\n')).toContain('invalid_arguments: propose_text_edit: missing required argument "replace"');
    const types = eventTypes(turn.attemptId);
    expect(types.filter((t) => t === 'inline_tool_call_correction_started')).toHaveLength(1);
    expect(eventMeta(turn.attemptId, 'native_tool_calls_rejected')[0]).toMatchObject({ code: 'invalid_arguments', toolNames: ['propose_text_edit'] });
    expect(turn.finished.status).not.toBe('completed');
  }, 30000);

  it('a native call to a tool outside the exposed set is refused, and nothing in that reply runs', async () => {
    backend = new ScriptedBackend((request, call) => (call === 1
      ? { content: '', toolCalls: [{ name: 'read_file', arguments: { path: 'note.txt' } }, { name: 'memory_remember', arguments: { subject: 'x' } }] }
      : { content: 'Done.' }));
    await startCore();
    const turn = await runTurn('Explain note.txt', false);

    expect(toolTexts(backend.requests[1])).toHaveLength(0);
    expect(systemTexts(backend.requests[1]).join('\n')).toContain("unknown_tool: 'memory_remember' is not an available tool (tool call 2 of 2)");
    expect(db.all('SELECT id FROM tool_invocations')).toHaveLength(0);
    expect(eventMeta(turn.attemptId, 'native_tool_calls_rejected')[0]).toMatchObject({ code: 'unknown_tool' });
  }, 30000);

  it('keeps the documented lenient native coercions: a numeric-string line range still reads', async () => {
    backend = new ScriptedBackend((request) => (hasToolResult(request)
      ? { content: 'Line 2 is "line two".' }
      : native('read_file', { path: 'note.txt', startLine: '2', endLine: '2' })));
    await startCore();
    const turn = await runTurn('Explain note.txt', false);
    expect(toolTexts(backend.requests[1])[0]).toContain('LINES 2-2 of 3');
    expect(eventTypes(turn.attemptId)).not.toContain('native_tool_calls_rejected');
    expect(turn.finished.status).toBe('completed');
  }, 30000);
});

describe('D2. an unresolvable anchored edit never reaches approval', () => {
  it('is refused pre-approval with the reason, and a turn that then stops is corrected, not completed', async () => {
    backend = new ScriptedBackend((request, call) => {
      if (call === 1) return native('propose_text_edit', { path: 'note.txt', find: 'line 2', replace: 'line 2 changed' });
      return { content: 'The change is done.' };
    });
    await startCore();
    const turn = await runTurn('Change line two of note.txt');

    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\nline two\nline three\n');
    const refusal = toolTexts(backend.requests[1]).join('\n');
    expect(refusal).toContain('NOT SUBMITTED');
    expect(refusal).toContain('find text was not found in the file');
    expect(eventMeta(turn.attemptId, 'text_edit_anchor_refused')[0]).toMatchObject({ path: 'note.txt', reason: 'find text was not found in the file' });
    // Previously the approved-then-failed row satisfied "a proposal exists" and the attempt completed with no change.
    const types = eventTypes(turn.attemptId);
    expect(types).toContain('mutation_proposal_correction_started');
    expect(turn.finished.status).toBe('failed');
    expect(turn.finished.failureReason).toContain('could not produce an actionable mutation proposal');
  }, 30000);

  it('a resolvable anchor still reaches approval with its diff', async () => {
    backend = new ScriptedBackend(() => native('propose_text_edit', { path: 'note.txt', find: 'line two', replace: 'line 2' }));
    await startCore();
    const turn = await runTurn('Change line two of note.txt');
    expect(turn.finished.status).toBe('waiting_for_approval');
    expect(eventTypes(turn.attemptId)).not.toContain('text_edit_anchor_refused');
    expect(db.all('SELECT id FROM approvals')).toHaveLength(1);
  }, 30000);
});

describe('D3. a policy-denied proposal is not a mutation proposal', () => {
  it('a corrective turn that only produces a denied empty-path proposal fails instead of being recorded as recovered', async () => {
    backend = new ScriptedBackend((request, call) => {
      if (call === 1) return { content: 'I cannot create a file for the user.' };
      if (call === 2) return native('propose_file_change', { path: '', content: 'line one\nline 2\nline three\n' });
      return { content: 'I cannot create a file for the user.' };
    });
    await startCore();
    const turn = await runTurn('Change line two of note.txt');

    const types = eventTypes(turn.attemptId);
    expect(types).toContain('mutation_proposal_correction_invoked');
    expect(types).not.toContain('mutation_proposal_correction_recovered');
    expect(types).toContain('mutation_proposal_correction_exhausted');
    expect(turn.finished.status).toBe('failed');
    const denied = db.all("SELECT id FROM approvals WHERE json_extract(summary, '$.policyDecision') = 'denied'");
    expect(denied).toHaveLength(1);
  }, 30000);
});

describe('D4. anchored edits share the destructive-replacement guard', () => {
  it('a find spanning the whole file with an empty replace is refused before approval', async () => {
    backend = new ScriptedBackend((request, call) => (call === 1
      ? native('propose_text_edit', { path: 'big.txt', find: BIG_FILE.trimEnd(), replace: '' })
      : { content: 'Stopping.' }));
    await startCore();
    const turn = await runTurn('Change line 2 of big.txt');

    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(toolTexts(backend.requests[1]).join('\n')).toContain('almost the whole file would be deleted');
    expect(eventMeta(turn.attemptId, 'suspicious_whole_file_replacement_blocked')[0]).toMatchObject({ toolName: 'propose_text_edit', path: 'big.txt', baselineLines: 30 });
  }, 30000);

  it('a bounded anchored edit on the same file is untouched by the guard', async () => {
    backend = new ScriptedBackend(() => native('propose_text_edit', { path: 'big.txt', find: 'line 2:', replace: 'line 2 (changed):' }));
    await startCore();
    const turn = await runTurn('Change line 2 of big.txt');
    expect(turn.finished.status).toBe('waiting_for_approval');
    expect(eventTypes(turn.attemptId)).not.toContain('suspicious_whole_file_replacement_blocked');
  }, 30000);
});

describe('D6. a partial multi-file mutation is never a semantic completion', () => {
  async function approveNext(correlationId: string, attemptId: string) {
    await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(correlationId)}`)).json();
    const action = snapshot.actions.find((x: any) => x.actionable);
    expect(action).toBeTruthy();
    await jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
      }),
    }));
  }
  const create = (name: string) => native('propose_file_change', { path: name, content: `${name}\n` });
  const OBJECTIVE = 'Create one.txt, two.txt and three.txt, each containing its own file name.';

  it('1 of 3 explicit files mutated, then "Done." -> corrected, and never Completed when the model keeps claiming done', async () => {
    backend = new ScriptedBackend((request, call) => (call === 1 ? create('one.txt') : { content: 'Done. Everything is complete.' }));
    await startCore();
    const first = await runTurn(OBJECTIVE);
    expect(first.finished.status).toBe('waiting_for_approval');
    await approveNext(first.conversationId, first.attemptId);
    const finished = await pollAttempt(first.attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(fs.existsSync(path.join(dir, 'one.txt'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'two.txt'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'three.txt'))).toBe(false);
    expect(finished.status).toBe('failed');
    expect(finished.failureReason).toContain('objective incomplete');
    expect(finished.failureReason).toContain('two.txt');
    expect(finished.failureReason).toContain('three.txt');
    expect(finished.failureReason).not.toContain('one.txt');
    expect(eventTypes(first.attemptId)).toContain('completion_guard_correction_started');
  }, 30000);

  it('the correction is acted on: all three files mutated -> normal completion is still allowed', async () => {
    backend = new ScriptedBackend((request, call) => (call <= 3 ? create(['one.txt', 'two.txt', 'three.txt'][call - 1]) : { content: 'All three files were created.' }));
    await startCore();
    const turn = await runTurn(OBJECTIVE);
    for (let i = 0; i < 3; i += 1) {
      await approveNext(turn.conversationId, turn.attemptId);
      if (i < 2) await pollAttempt(turn.attemptId, (a) => a.status === 'waiting_for_approval' && fs.existsSync(path.join(dir, `${['one', 'two'][i]}.txt`)));
    }
    const finished = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(finished.status).toBe('completed');
    for (const name of ['one.txt', 'two.txt', 'three.txt']) expect(fs.existsSync(path.join(dir, name))).toBe(true);
    expect(eventTypes(turn.attemptId)).not.toContain('completion_guard_correction_started');
  }, 30000);

  it('a Saath Kar refusal / unfinished admission after a change is not recorded as Completed', async () => {
    backend = new ScriptedBackend((request, call) => (call === 1
      ? native('propose_text_edit', { path: 'note.txt', find: 'line two', replace: 'line 2' })
      : { content: "I'm unable to finish the remaining changes." }));
    await startCore();
    const turn = await runTurn('Change line two of note.txt');
    await approveNext(turn.conversationId, turn.attemptId);
    const finished = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(finished.status).toBe('failed');
    expect(finished.failureReason).toContain('objective incomplete');
  }, 30000);
});
