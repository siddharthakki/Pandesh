/**
 * M53 — range-aware read evidence in the Saath Kar / Core loop.
 *
 * Live UAT: after Saath created weather.html, the immediate follow-up edit ended in
 * "context_budget_exhausted: active Saath context exceeds the model window after compaction". The loop recognised only
 * byte-identical read calls, so slices of the same file, reads past EOF and compaction-clear/re-read cycles each spent
 * context again. These tests pin the guarantees that replace that: reuse the known evidence, refuse the rereads, keep the
 * evidence valid only while the file is unchanged, and never fix it by widening the window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
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
import {
  MAX_DELIVERIES_PER_RANGE, NARROW_READ_LINES, decideRead, effectiveReadRange, recordRead, seedFromPack, type ReadEvidenceState,
} from '../runtime/readEvidence';

const TOKEN = generateToken();
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('readEvidence (pure)', () => {
  const text = `${Array.from({ length: 300 }, (_, i) => `line ${i + 1} ${'x'.repeat(60)}`).join('\n')}\n`;
  const fingerprint = sha(text);
  const present = () => true;
  const cleared = () => false;
  const check = (state: ReadEvidenceState | undefined, requested: { startLine?: number; endLine?: number }, bodyPresent = present, extra: { text?: string; fingerprint?: string; narrowReadLines?: number } = {}) =>
    decideRead(state, { path: 'weather.html', fingerprint: extra.fingerprint ?? fingerprint, text: extra.text ?? text, requested, bodyPresent, ...(extra.narrowReadLines ? { narrowReadLines: extra.narrowReadLines } : {}) });

  it('computes what a bounded whole-file read actually delivered (a prefix, not the file)', () => {
    const whole = effectiveReadRange(text, {});
    expect(whole.truncated).toBe(true);
    expect(whole.range![0]).toBe(1);
    expect(whole.range![1]).toBeLessThan(300);
    expect(effectiveReadRange('a\nb\n', {}).range).toEqual([1, 2]);
  });

  it('refuses a sub-range of lines already delivered while their body is still in context', () => {
    const first = check(undefined, { startLine: 1, endLine: 100 });
    expect(first.decision.action).toBe('execute');
    const state = recordRead(undefined, { path: 'weather.html', fingerprint, totalLines: 300, delivered: first.effective.range!, operationKey: 'read:1' });
    const again = check(state, { startLine: 20, endLine: 60 });
    expect(again.decision).toMatchObject({ action: 'refuse', kind: 'covered' });
    expect(check(state, { startLine: 150, endLine: 200 }).decision.action).toBe('execute');
  });

  it('refuses reads past the end of the file (EOF loops)', () => {
    const result = check(undefined, { startLine: 301, endLine: 400 });
    expect(result.decision).toMatchObject({ action: 'refuse', kind: 'eof' });
  });

  it('allows one bounded reread after compaction cleared the body, then stops (no clear -> reread loop)', () => {
    let state = recordRead(undefined, { path: 'weather.html', fingerprint, totalLines: 300, delivered: [1, 100], operationKey: 'read:1' });
    expect(check(state, { startLine: 1, endLine: 100 }, cleared).decision.action).toBe('execute');
    state = recordRead(state, { path: 'weather.html', fingerprint, totalLines: 300, delivered: [1, 100], operationKey: 'read:2' });
    const third = check(state, { startLine: 1, endLine: 100 }, cleared);
    expect(MAX_DELIVERIES_PER_RANGE).toBe(2);
    expect(third.decision).toMatchObject({ action: 'refuse', kind: 'rereads_exhausted' });
  });

  it('drops the evidence when the file changed', () => {
    const state = recordRead(undefined, { path: 'weather.html', fingerprint, totalLines: 300, delivered: [1, 100], operationKey: 'read:1' });
    const changed = `${text}one more\n`;
    expect(check(state, { startLine: 1, endLine: 100 }, present, { text: changed, fingerprint: sha(changed) }).decision.action).toBe('execute');
  });

  it('a pack that delivered the whole file covers every slice and is never cleared', () => {
    const small = 'a\nb\nc\n';
    const state = seedFromPack(undefined, [{ path: 'weather.html', fingerprint: sha(small), totalLines: 3 }]);
    const result = check(state, {}, cleared, { text: small, fingerprint: sha(small) });
    expect(result.decision).toMatchObject({ action: 'refuse', kind: 'covered' });
  });

  it('after a last-resort compaction reads are limited to a few lines', () => {
    const result = check(undefined, { startLine: 1, endLine: 200 }, present, { narrowReadLines: NARROW_READ_LINES });
    expect(result.decision).toMatchObject({ action: 'refuse', kind: 'narrow' });
    expect(check(undefined, { startLine: 1, endLine: 40 }, present, { narrowReadLines: NARROW_READ_LINES }).decision.action).toBe('execute');
  });
});

class ScriptedBackend implements ModelBackend {
  script: Array<ModelToolCall[] | string> = [];
  requests: ModelChatRequest[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    const step = this.script[this.requests.length - 1] ?? 'Done.';
    const base = { provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    return typeof step === 'string' ? { ...base, content: step, toolCalls: [] } : { ...base, content: 'Working.', toolCalls: step };
  }
}

const read = (file: string, range?: { startLine?: number; endLine?: number }): ModelToolCall => ({ name: 'read_file', arguments: { path: file, ...(range ?? {}) } });
const edit = (file: string, find: string, replace: string): ModelToolCall => ({ name: 'propose_text_edit', arguments: { path: file, find, replace } });

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.headers as Record<string, string> | undefined) };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
const idemp = () => `idemp-m53-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

async function startAttempt(message: string, options: { window?: number; readOnly?: boolean; pack?: { path: string; complete: boolean } } = {}) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  let repositoryContext: { prompt: string; selectedFiles: Array<{ path: string; estimatedTokens: number; complete?: boolean }>; estimatedTokens: number } | undefined;
  if (options.pack) {
    const body = fs.readFileSync(path.join(dir, options.pack.path), 'utf8');
    repositoryContext = { prompt: `FILE ${options.pack.path}\n${body}`, selectedFiles: [{ path: options.pack.path, estimatedTokens: Math.ceil(body.length / 4), complete: options.pack.complete }], estimatedTokens: Math.ceil(body.length / 4) };
  }
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar', conversationId: conv.id,
    workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(), effectiveAllowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'],
    ...(repositoryContext ? { repositoryContext } : {}),
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'base:14b', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true,
      candidates: [], escalationCandidates: [],
      ...(options.window ? { contextWindowTokens: options.window, contextWindowSource: 'router_metadata' as const } : {}),
      requiredCapabilities: { readOnlyExplanation: options.readOnly === true, repositoryExploration: true, toolCalling: true, fileModification: options.readOnly !== true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id, attemptId: result.attempt.id };
}

async function approvePending(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (a) => a.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const action = snapshot.actions.filter((a: any) => a.actionable)[0];
  const res = await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({ resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision, expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash }),
  });
  expect(res.ok).toBe(true);
}

const quality = (attemptId: string) => db.all<{ eventType: string }>("SELECT eventType FROM runtime_events WHERE domain = 'execution_quality' AND entityId = ? ORDER BY sequence", [attemptId]).map((e) => e.eventType);
const readInvocations = () => db.all<{ id: string }>("SELECT id FROM tool_invocations WHERE toolName = 'read_file'").length;
const allToolText = (request: ModelChatRequest) => request.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n---\n');

function weatherHtml(lines: number): string {
  const rows = Array.from({ length: lines }, (_, i) => `  <div class="row" id="row-${i + 1}">Forecast row ${i + 1}: partly cloudy ${'.'.repeat(40)}</div>`);
  return `<!DOCTYPE html>\n<html>\n<head><title>Weather</title></head>\n<body>\n${rows.join('\n')}\n</body>\n</html>\n`;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m53-'));
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

describe('M53 Saath result evidence recorded by Core', () => {
  it('creating an HTML file records the governed write (with its resolved path) and a distinct static_html_check, never a fake test/build validation', async () => {
    const html = '<!doctype html><html><head><title>Weather</title></head><body>Sunny</body></html>';
    backend.script = [[{ name: 'propose_file_change', arguments: { path: 'uat/weather.html', content: html } }], 'Created weather.html.'];
    const { conversationId, attemptId } = await startAttempt('create uat/weather.html with a weather page');
    await approvePending(conversationId, attemptId);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'uat', 'weather.html'), 'utf8')).toBe(html);

    const rows = db.all<{ toolName: string; status: string; evidence: string }>('SELECT toolName, status, evidence FROM tool_invocations ORDER BY startedAt');
    const write = rows.find((row) => row.toolName === 'propose_file_change')!;
    expect(write.status).toBe('succeeded');
    expect((JSON.parse(write.evidence) as { normalizedArguments: { path: string } }).normalizedArguments.path).toBe('uat/weather.html');
    const check = rows.find((row) => row.toolName === 'static_html_check')!;
    expect(check.status).toBe('succeeded');
    expect((JSON.parse(check.evidence) as { resultCategory: string }).resultCategory).toBe('static_check_passed');
    expect(rows.some((row) => row.toolName === 'workspace_validation')).toBe(false);
  });
});

describe('M53 follow-up edit of a just-created file (regression)', () => {
  it('a file the host pack delivered in full is not read again, by any slice, and the edit completes with bounded context', async () => {
    fs.writeFileSync(path.join(dir, 'weather.html'), weatherHtml(12), 'utf8');
    backend.script = [
      [read('weather.html'), read('weather.html', { startLine: 1, endLine: 5 }), read('weather.html', { startLine: 30, endLine: 60 })],
      [edit('weather.html', '<title>Weather</title>', '<title>Weather + Login</title>')],
      'Added the login title.',
    ];
    const { conversationId, attemptId } = await startAttempt('add a login page to weather.html', { pack: { path: 'weather.html', complete: true } });
    await approvePending(conversationId, attemptId);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    expect(attempt.status).toBe('completed');
    expect(String(attempt.failureReason ?? '')).not.toContain('context_budget_exhausted');
    expect(readInvocations()).toBe(0);
    expect(quality(attemptId).filter((t) => t === 'redundant_exploration_refused')).toHaveLength(3);
    expect(allToolText(backend.requests[1])).toContain('already in the context supplied for this task');
    expect(allToolText(backend.requests[1])).toContain('nothing exists past line');
    expect(fs.readFileSync(path.join(dir, 'weather.html'), 'utf8')).toContain('<title>Weather + Login</title>');
  });

  it('without a pack, repeated and past-EOF slices of a large file are refused and the loop stays bounded', async () => {
    fs.writeFileSync(path.join(dir, 'weather.html'), weatherHtml(400), 'utf8');
    backend.script = [
      [read('weather.html')],
      [read('weather.html', { startLine: 1, endLine: 40 })],
      [read('weather.html', { startLine: 900, endLine: 950 })],
      [read('weather.html', { startLine: 300, endLine: 330 })],
      'Read what I need.',
    ];
    const { attemptId } = await startAttempt('describe weather.html', { readOnly: true });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');

    // The first read delivered a prefix (and said where to continue); the sub-range of that prefix and the past-EOF read
    // are refused by the range guard; only the genuinely new range is read.
    expect(readInvocations()).toBe(2);
    expect(allToolText(backend.requests[1])).toContain('continue with startLine=');
    expect(allToolText(backend.requests[2])).toContain('were already delivered and are still in context');
    expect(allToolText(backend.requests[3])).toContain('nothing exists past line');
    expect(attempt.status).toBe('completed');
  });

  it('a small window with many large slices of the same file never fails with context_budget_exhausted and never loops', async () => {
    fs.writeFileSync(path.join(dir, 'weather.html'), weatherHtml(400), 'utf8');
    backend.script = [
      [read('weather.html', { startLine: 1, endLine: 70 }), read('weather.html', { startLine: 71, endLine: 140 }), read('weather.html', { startLine: 141, endLine: 210 })],
      [read('weather.html', { startLine: 211, endLine: 280 }), read('weather.html', { startLine: 281, endLine: 350 })],
      [read('weather.html', { startLine: 1, endLine: 70 }), read('weather.html', { startLine: 71, endLine: 140 })],
      'Summarised the page.',
    ];
    const { attemptId } = await startAttempt('describe weather.html', { readOnly: true, window: 6144 });
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(String(attempt.failureReason ?? '')).not.toContain('context_budget_exhausted');
    expect(attempt.status).toBe('completed');
    // The model never gets more than the window allows, and the windowed rereads were bounded by the delivery cap.
    expect(readInvocations()).toBeLessThanOrEqual(7);
  });

  it('a file changed on disk invalidates the evidence: the same slice is read again', async () => {
    fs.writeFileSync(path.join(dir, 'weather.html'), weatherHtml(12), 'utf8');
    backend.script = [
      [read('weather.html', { startLine: 1, endLine: 10 })],
      [edit('weather.html', '<title>Weather</title>', '<title>Weather v2</title>')],
      [read('weather.html', { startLine: 1, endLine: 10 })],
      'Verified.',
    ];
    const { conversationId, attemptId } = await startAttempt('retitle weather.html then verify it');
    await approvePending(conversationId, attemptId);
    const attempt = await pollAttempt(attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');
    expect(readInvocations()).toBe(2);
    expect(allToolText(backend.requests[3])).toContain('Weather v2');
  });
});
