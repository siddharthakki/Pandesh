/**
 * M49 correctness/safety changes, deterministic (scripted backend, injected validation runner):
 *
 *  A. Completion invariant — a task whose authoritative post-mutation validation failed never
 *     transitions to completed and never records a success/delivery event; it goes through the
 *     existing bounded repair accounting and fails the existing way when that is exhausted.
 *  B. Suspicious whole-file replacement guard — a propose_file_change that would discard nearly
 *     all of an existing non-trivial file is refused with a normal tool result before any approval
 *     exists, the firing is recorded as evidence, and an intentional rewrite stays possible.
 *  C. Golden-only raw model evidence — raw reply, parsed tool-call arguments, parser failure.
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
import { listMessages } from '../domain/conversations';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelToolCall } from '../runtime/modelBackend';
import { describeInlineToolCallFailure } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { buildWriteFileProposal, isSuspiciousWholeFileReplacement } from '../runtime/writeProposal';

const TOKEN = generateToken();
const REPAIR_MARKER = 'validation that ran after your change FAILED';

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

const propose = (file: string, content: string, say = 'Proposing the edit.') => ({
  content: say, toolCalls: [{ name: 'propose_file_change', arguments: { path: file, content } }],
});
const hasToolResult = (request: ModelChatRequest) => request.messages.some((message) => message.role === 'tool');
const sawMarker = (request: ModelChatRequest, marker: string) => request.messages.some((message) => message.content.includes(marker));

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let validationRuns: string[];
/** Decides each validation run from the workspace as it is at that moment. */
let validate: (cwd: string) => { status: 'succeeded' | 'failed'; exitCode: number; output: string };
let n = 0;
const idemp = () => `idemp-m49-${++n}`;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.headers as Record<string, string> | undefined) };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
async function jsonOf(res: Response) { expect(res.ok).toBe(true); return res.json(); }
async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
async function seedTurn(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false },
    }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  await authedFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id as string, attemptId: attempt.id as string };
}
async function nextPendingAction(turn: { conversationId: string; attemptId: string }) {
  await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(turn.conversationId)}`)).json();
  const pending = snapshot.actions.filter((a: any) => a.actionable);
  expect(pending).toHaveLength(1);
  return pending[0];
}
async function approve(action: any) {
  return jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
    }),
  }));
}
const eventTypes = (attemptId: string) => (db.all("SELECT eventType FROM runtime_events WHERE entityId = ?", [attemptId]) as Array<{ eventType: string }>).map((row) => row.eventType);
const countOf = (types: string[], type: string) => types.filter((value) => value === type).length;

async function startCore(options: { rawModelEvidence?: boolean } = {}) {
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
      rawModelEvidence: options.rawModelEvidence ?? false,
      validationCommandRunner: async (command, cwd) => { validationRuns.push(command); return validate(cwd); },
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
}

const BIG_FILE = `${Array.from({ length: 30 }, (_, i) => `line ${i + 1}: some reasonably long original content`).join('\n')}\n`;
const BIG_FILE_COMPLETE_EDIT = BIG_FILE.replace('line 2:', 'line 2 (changed):');

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m49-test-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\nline two\nline three\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'big.txt'), BIG_FILE, 'utf8');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { compile: 'tsc -p ./' } }), 'utf8');
  validationRuns = [];
  validate = () => ({ status: 'succeeded', exitCode: 0, output: 'ok' });
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

describe('A. validation completion invariant', () => {
  it('validation PASS may complete, with the success record', async () => {
    backend = new ScriptedBackend((request) => (hasToolResult(request) ? { content: 'Changed note.txt.' } : propose('note.txt', 'line one\nline two changed\nline three\n')));
    await startCore();
    const turn = await seedTurn('Change the second line of note.txt');
    await approve(await nextPendingAction(turn));
    const attempt = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    expect(validationRuns).toEqual(['npm run compile']);
    const types = eventTypes(turn.attemptId);
    expect(types).toContain('final_verification_recorded');
    expect(types).not.toContain('validation_repair_started');
  }, 30000);

  it('validation FAIL cannot complete: bounded repair, then the existing exhausted failure, and no success event', async () => {
    validate = () => ({ status: 'failed', exitCode: 1, output: 'error TS2322: compile broke' });
    backend = new ScriptedBackend((request) => (hasToolResult(request) ? { content: 'All done, everything passes and is delivered.' } : propose('note.txt', 'line one\nline two changed\nline three\n')));
    await startCore();
    const turn = await seedTurn('Change the second line of note.txt');
    await approve(await nextPendingAction(turn));
    const attempt = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('failed');
    expect(attempt.failureReason).toBe('bounded validation repair was exhausted');
    const types = eventTypes(turn.attemptId);
    // Entered the existing repair path (same event types the mission loop uses), bounded at the existing cap.
    expect(countOf(types, 'validation_failed')).toBeGreaterThanOrEqual(1);
    expect(countOf(types, 'validation_repair_started')).toBe(2);
    expect(countOf(types, 'validation_repair_exhausted')).toBe(1);
    // No fabricated success/delivery: no verification record, no completion, and the model's success claim is not presented.
    expect(types).not.toContain('final_verification_recorded');
    const assistant = listMessages(db, turn.conversationId).filter((message) => message.role === 'assistant').map((message) => message.content).join('\n');
    expect(assistant).not.toContain('All done');
    expect(assistant).toContain('NOT complete');
    // The model was told to repair, with the failure still in front of it.
    expect(backend.requests.some((request) => sawMarker(request, REPAIR_MARKER))).toBe(true);
  }, 30000);

  it('failed validation enters repair, and a repair that passes validation then completes', async () => {
    validate = (cwd) => (fs.readFileSync(path.join(cwd, 'note.txt'), 'utf8').includes('BROKEN')
      ? { status: 'failed', exitCode: 1, output: 'error: BROKEN marker present' }
      : { status: 'succeeded', exitCode: 0, output: 'ok' });
    let fixed = false;
    backend = new ScriptedBackend((request) => {
      if (!hasToolResult(request)) return propose('note.txt', 'line one\nBROKEN\nline three\n');
      if (sawMarker(request, REPAIR_MARKER) && !fixed) { fixed = true; return propose('note.txt', 'line one\nline two fixed\nline three\n', 'Repairing.'); }
      return { content: 'Changed note.txt and validation passes.' };
    });
    await startCore();
    const turn = await seedTurn('Change the second line of note.txt');
    await approve(await nextPendingAction(turn));
    await approve(await nextPendingAction(turn));
    const attempt = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toContain('line two fixed');
    const types = eventTypes(turn.attemptId);
    expect(countOf(types, 'validation_repair_started')).toBe(1);
    expect(types).not.toContain('validation_repair_exhausted');
    expect(types).toContain('final_verification_recorded');
  }, 30000);
});

describe('B. suspicious whole-file replacement guard', () => {
  const stats = (existing: string | null, proposed: string) => {
    if (existing !== null) fs.writeFileSync(path.join(dir, 'probe.txt'), existing, 'utf8');
    return buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'probe.txt', content: proposed })?.replacement;
  };

  it('flags truncation of a non-trivial file, and nothing else', () => {
    expect(isSuspiciousWholeFileReplacement(stats(BIG_FILE, 'line 2: changed\n'))).toBe(true);
    // Complete file with one edit, and an intentional same-size rewrite: both fine.
    expect(isSuspiciousWholeFileReplacement(stats(BIG_FILE, BIG_FILE_COMPLETE_EDIT))).toBe(false);
    expect(isSuspiciousWholeFileReplacement(stats(BIG_FILE, BIG_FILE.replace(/line/g, 'row')))).toBe(false);
    // A trivial existing file may be replaced by anything.
    expect(isSuspiciousWholeFileReplacement(stats('a\nb\nc\n', 'x\n'))).toBe(false);
    // A new file has no baseline to truncate.
    fs.rmSync(path.join(dir, 'probe.txt'), { force: true });
    expect(isSuspiciousWholeFileReplacement(stats(null, 'x\n'))).toBe(false);
  });

  it('returns a corrective tool result before any approval exists, records the evidence, and accepts the complete file', async () => {
    let resent = false;
    backend = new ScriptedBackend((request) => {
      if (!hasToolResult(request)) return propose('big.txt', 'line 2: changed\n');
      if (sawMarker(request, 'NOT SUBMITTED') && !resent) { resent = true; return propose('big.txt', BIG_FILE_COMPLETE_EDIT, 'Resending the complete file.'); }
      return { content: 'Changed big.txt.' };
    });
    await startCore();
    const turn = await seedTurn('Change line 2 of big.txt');
    const action = await nextPendingAction(turn);

    // The first, truncating proposal never became an approval: the pending card is the complete-file one.
    expect(action.presentation.diff).toContain('+line 2 (changed):');
    expect(action.presentation.diff).not.toContain('-line 30:');
    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE);

    const refusal = backend.requests.find((request) => sawMarker(request, 'NOT SUBMITTED'))!;
    const toolText = refusal.messages.find((message) => message.role === 'tool' && message.content.includes('NOT SUBMITTED'))!.content;
    expect(toolText).toContain('replaces the WHOLE file');
    expect(toolText).toContain('propose_text_edit');
    expect(toolText).toContain('COMPLETE updated file');

    const fired = db.all("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'suspicious_whole_file_replacement_blocked'", [turn.attemptId]) as Array<{ metadata: string }>;
    expect(fired).toHaveLength(1);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(1);
    expect(JSON.parse(fired[0].metadata)).toMatchObject({ path: 'big.txt', baselineLines: 30, proposedLines: 1 });

    await approve(action);
    expect((await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed')).status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE_COMPLETE_EDIT);
  }, 30000);

  it('blocks an identical resubmission too: repetition is not intent, no approval ever exists, and the loop stays bounded', async () => {
    const shortRewrite = 'condensed\n';
    backend = new ScriptedBackend(() => propose('big.txt', shortRewrite, 'I intend this exact replacement.'));
    await startCore();
    const turn = await seedTurn('Condense big.txt to a single line');
    const finished = await pollAttempt(turn.attemptId, (a) => a.status !== 'running' && a.status !== 'queued' && a.status !== 'created', 20000);

    expect(finished.status).not.toBe('waiting_for_approval');
    expect(finished.status).not.toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE);
    expect(countOf(eventTypes(turn.attemptId), 'suspicious_whole_file_replacement_blocked')).toBeGreaterThanOrEqual(2);
    // Both the first and the identical repeat were refused without any approval or mutation.
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(backend.calls).toBeLessThan(25);
  }, 30000);

  it('leaves bounded edits alone: propose_text_edit on a large file passes the guard', async () => {
    backend = new ScriptedBackend((request) => {
      if (!hasToolResult(request)) {
        return { content: 'Editing.', toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'big.txt', find: 'line 2:', replace: 'line 2 (changed):' } }] };
      }
      return { content: 'Changed big.txt.' };
    });
    await startCore();
    const turn = await seedTurn('Change line 2 of big.txt');
    const action = await nextPendingAction(turn);
    expect(action.presentation.diff).toContain('+line 2 (changed):');
    expect(countOf(eventTypes(turn.attemptId), 'suspicious_whole_file_replacement_blocked')).toBe(0);
  }, 30000);

  describe('ordinary 19-line source file', () => {
    const SMALL_SOURCE = `${Array.from({ length: 19 }, (_, i) => `const v${i} = ${i};`).join('\n')}\n`;

    it('blocks destructive whole-file replacement and allows a complete or mostly-preserving one', () => {
      expect(SMALL_SOURCE.length).toBeLessThan(500);
      expect(isSuspiciousWholeFileReplacement(stats(SMALL_SOURCE, 'const v0 = 1;\n'))).toBe(true);
      expect(isSuspiciousWholeFileReplacement(stats(SMALL_SOURCE, SMALL_SOURCE.replace('v3 = 3', 'v3 = 33')))).toBe(false);
      expect(isSuspiciousWholeFileReplacement(stats(SMALL_SOURCE, `${SMALL_SOURCE}const extra = 1;\n`))).toBe(false);
      // Still trivial below both thresholds (7 short lines, <500 chars).
      expect(isSuspiciousWholeFileReplacement(stats('a\nb\nc\nd\ne\nf\ng\n', 'x\n'))).toBe(false);
    });

    it('leaves propose_text_edit unaffected', async () => {
      fs.writeFileSync(path.join(dir, 'small.js'), SMALL_SOURCE, 'utf8');
      backend = new ScriptedBackend((request) => {
        if (!hasToolResult(request)) {
          return { content: 'Editing.', toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'small.js', find: 'v3 = 3', replace: 'v3 = 33' } }] };
        }
        return { content: 'Changed small.js.' };
      });
      await startCore();
      const turn = await seedTurn('Change v3 in small.js');
      const action = await nextPendingAction(turn);
      expect(action.presentation.diff).toContain('+const v3 = 33;');
      expect(countOf(eventTypes(turn.attemptId), 'suspicious_whole_file_replacement_blocked')).toBe(0);
    }, 30000);
  });
});

describe('D. M49.2 tolerant inline tool communication (executor level)', () => {
  const readCall = (file: string) => `{"name":"read_file","arguments":{"path":"${file}"}}`;
  const toolTexts = (request: ModelChatRequest) => request.messages.filter((message) => message.role === 'tool').map((message) => message.content);
  const finishWith = (first: string): Script => (request, call) => (call === 1 ? { content: first } : { content: 'Done.' });
  const runToEnd = async (message: string) => {
    const turn = await seedTurn(message);
    await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed' || a.status === 'waiting_for_approval');
    return turn;
  };

  it('executes two inline calls plus prose in order', async () => {
    backend = new ScriptedBackend(finishWith(`Let me read both.\n${readCall('note.txt')}\nand then\n${readCall('big.txt')}\nThanks.`));
    await startCore();
    await runToEnd('Explain note.txt and big.txt');
    const results = toolTexts(backend.requests[1]);
    expect(results).toHaveLength(2);
    expect(results[0]).toContain('line one');
    expect(results[1]).toContain('line 1: some reasonably long');
  }, 30000);

  it('a malformed second call executes zero calls and feeds back the parser reason only', async () => {
    backend = new ScriptedBackend(finishWith(`${readCall('note.txt')}\n{"name":"read_file","arguments":{"path":"big.txt",}}`));
    await startCore();
    const turn = await runToEnd('Explain note.txt and big.txt');
    expect(backend.requests[1] && toolTexts(backend.requests[1])).toHaveLength(0);
    const correction = backend.requests[1].messages.find((message) => message.role === 'system' && message.content.includes('could not be used'))!;
    expect(correction.content).toContain('invalid_json:');
    expect(correction.content).toContain('tool call 2 of 2');
    expect(correction.content).toContain('only the corrected tool call');
    expect(countOf(eventTypes(turn.attemptId), 'inline_tool_call_correction_started')).toBe(1);
  }, 30000);

  it.each([
    ['unknown tool', '{"name":"delete_everything","arguments":{"path":"x"}}', 'unknown_tool:'],
    ['invalid arguments', '{"name":"read_file","arguments":{}}', 'invalid_arguments:'],
  ])('%s in call 2 executes zero calls', async (_label, second, code) => {
    backend = new ScriptedBackend(finishWith(`${readCall('note.txt')}\n${second}`));
    await startCore();
    await runToEnd('Explain note.txt');
    expect(toolTexts(backend.requests[1])).toHaveLength(0);
    expect(backend.requests[1].messages.some((message) => message.role === 'system' && message.content.includes(code))).toBe(true);
  }, 30000);

  it('a valid read_file followed by a schema-invalid nested mutation argument executes zero calls and creates zero approvals', async () => {
    const invalidEdit = '{"name":"propose_text_edit","arguments":{"path":"note.txt","find":"line one","replace":{"text":"line 1"}}}';
    backend = new ScriptedBackend(finishWith(`${readCall('note.txt')}\n${invalidEdit}`));
    await startCore();
    const turn = await runToEnd('Change line one in note.txt');
    expect(toolTexts(backend.requests[1])).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toContain('line one');
    const correction = backend.requests[1].messages.find((message) => message.role === 'system' && message.content.includes('could not be used'))!;
    expect(correction.content).toContain('invalid_arguments: propose_text_edit: argument "replace" must be a string (tool call 2 of 2)');
    expect(correction.content).toContain('No tool call was executed');
    expect(countOf(eventTypes(turn.attemptId), 'inline_tool_call_correction_started')).toBe(1);
  }, 30000);

  it('refuses five inline calls with too_many_tool_calls and runs none', async () => {
    backend = new ScriptedBackend(finishWith(Array.from({ length: 5 }, () => readCall('note.txt')).join('\n')));
    await startCore();
    await runToEnd('Explain note.txt');
    expect(toolTexts(backend.requests[1])).toHaveLength(0);
    expect(backend.requests[1].messages.some((message) => message.content.includes('too_many_tool_calls: 5 > 4'))).toBe(true);
  }, 30000);

  it('native tool_calls are untouched: a native call runs even when the prose beside it holds broken tool JSON', async () => {
    backend = new ScriptedBackend((request) => (hasToolResult(request)
      ? { content: 'Done.' }
      : { content: '{"name":"read_file","arguments":{"path":"big.txt",}}', toolCalls: [{ name: 'read_file', arguments: { path: 'note.txt' } }] }));
    await startCore();
    const turn = await runToEnd('Explain note.txt');
    expect(toolTexts(backend.requests[1])).toHaveLength(1);
    expect(toolTexts(backend.requests[1])[0]).toContain('line one');
    expect(countOf(eventTypes(turn.attemptId), 'inline_tool_call_correction_started')).toBe(0);
  }, 30000);

  it('a structurally recovered destructive propose_file_change is still caught by the suspicious replacement guard', async () => {
    const truncated = '{"name":"propose_file_change","arguments":{"path":"big.txt","content":"condensed\\n"';
    backend = new ScriptedBackend(finishWith(truncated));
    await startCore({ rawModelEvidence: true });
    const turn = await runToEnd('Condense big.txt to a single line');
    expect(countOf(eventTypes(turn.attemptId), 'suspicious_whole_file_replacement_blocked')).toBe(1);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'big.txt'), 'utf8')).toBe(BIG_FILE);
    // Raw evidence keeps the untouched reply and records the structural normalization.
    const rows = fs.readFileSync(path.join(dir, 'golden-model-evidence.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows[0]).toMatchObject({ rawReply: truncated, structuralNormalization: { step: 'structural_repair_applied', appendedClosers: '}}' } });
    expect(rows[0].toolCalls[0].name).toBe('propose_file_change');
  }, 30000);
});

describe('C. Golden-only raw model evidence', () => {
  const MULTI = '<function=propose_file_change><parameter=path>note.txt</parameter><parameter=content>a</parameter></function><function=propose_file_change><parameter=path>note.txt</parameter><parameter=content>b</parameter></function>';
  const script: Script = (request, call) => {
    if (call === 1) return { content: MULTI };
    if (call === 2) return { content: 'note.txt is an ordinary text file.' };
    if (!hasToolResult(request)) return propose('note.txt', 'line one\nline two changed\nline three\n');
    return { content: 'Changed note.txt.' };
  };
  async function runBothTurns() {
    const first = await seedTurn('Explain note.txt');
    await pollAttempt(first.attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    const second = await seedTurn('Change the second line of note.txt');
    await approve(await nextPendingAction(second));
    await pollAttempt(second.attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    return { first, second };
  }

  it('describes why inline parsing failed, and stays silent for ordinary prose', () => {
    const names = ['propose_file_change'];
    expect(describeInlineToolCallFailure(MULTI, names)).toMatch(/^multiple_tool_calls: 2/);
    expect(describeInlineToolCallFailure('{"name":"nope","arguments":{}}', names)).toBe("unknown_tool: 'nope'");
    expect(describeInlineToolCallFailure('{"name":"propose_file_change", "arguments": {', names)).toMatch(/^not_a_single_json_object|^invalid_json/);
    expect(describeInlineToolCallFailure('Here is my plan in prose.', names)).toBeNull();
    expect(describeInlineToolCallFailure('{"name":"propose_file_change","arguments":{"path":"a","content":"b"}}', names)).toBeNull();
  });

  it('writes raw reply, parsed arguments and parser failure under the Core data dir when enabled', async () => {
    backend = new ScriptedBackend(script);
    await startCore({ rawModelEvidence: true });
    const { first, second } = await runBothTurns();

    const rows = fs.readFileSync(path.join(dir, 'golden-model-evidence.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failed = rows.find((row) => row.parserFailure);
    expect(failed).toMatchObject({ attemptId: first.attemptId, surface: 'saath_kar', rawReply: MULTI, toolCalls: [] });
    expect(failed.parserFailure).toMatch(/^multiple_tool_calls/);
    const parsed = rows.find((row) => row.toolCalls.length > 0);
    expect(parsed.toolCalls[0]).toEqual({ name: 'propose_file_change', arguments: { path: 'note.txt', content: 'line one\nline two changed\nline three\n' } });
    expect(parsed.attemptId).toBe(second.attemptId);
    expect(parsed.parserFailure).toBeNull();
  }, 30000);

  it('writes nothing when not enabled (normal runs)', async () => {
    backend = new ScriptedBackend(script);
    await startCore({ rawModelEvidence: false });
    await runBothTurns();
    expect(fs.existsSync(path.join(dir, 'golden-model-evidence.jsonl'))).toBe(false);
  }, 30000);
});
