/**
 * M47.1: empty-workspace single-file creation vs. the user's output-format wording.
 *
 * Live defect (RC1): Saath Kar, empty workspace, "create index.html ... Return ONLY the complete contents of
 * index.html" failed with "could not produce an actionable mutation proposal". Core's own record showed two
 * ~8-minute model calls whose prompt+completion tokens equalled the whole 32K window: truncation by context
 * exhaustion (almost entirely hidden reasoning), misreported as a protocol failure. These tests pin:
 *  - KKD owns the mutation protocol; "return only the file contents" describes the artifact, not the channel;
 *  - an empty workspace is a valid creation workspace, including for a large single file;
 *  - a malformed first reply is recovered by the one corrective turn;
 *  - genuine truncation is classified distinctly from a protocol failure and does not burn a pointless retry.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
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
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { OllamaModelBackend } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';

const TOKEN = generateToken();

const USER_MESSAGE = 'Create a single file index.html: a complete interactive dashboard.\n\nReturn ONLY the complete contents of index.html.';
const SMALL_HTML = '<!doctype html><html><head><title>NEXUS</title></head><body><h1>NEXUS</h1></body></html>\n';

class ScriptedBackend implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    return { content: '', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let backend: ScriptedBackend;
let baseUrl: string;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

let n = 0;
const idemp = () => `idemp-m471-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function runCreate(message = USER_MESSAGE, window?: { tokens: number; source: 'provider_introspection' | 'explicit_config' }) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar',
    conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: idemp(),
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'] },
    modelSelection: {
      ...(window ? { contextWindowTokens: window.tokens, contextWindowSource: window.source } : {}),
      selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return result.attempt.id as string;
}

const reply = (request: ModelChatRequest, extra: Partial<ModelChatResult>): ModelChatResult =>
  ({ content: '', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 }, ...extra });

const create = (content: string) => [{ name: 'propose_file_change', arguments: { path: 'index.html', content } }];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m471-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  backend = new ScriptedBackend();
  const runner = new CoreToolRunner();
  const governed: GovernedCapabilityAdapter = {
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
      backend, toolRunner: runner, defaultModel: 'fixture', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governed),
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

describe('M47.1 empty-workspace creation', () => {
  it('empty folder + "create index.html": a CREATE proposal is raised, nothing is written before approval', async () => {
    expect(fs.readdirSync(dir).filter((f) => f !== 'core.db' && !f.startsWith('core.db'))).toEqual([]);
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return reply(request, { content: 'Proposing index.html.', toolCalls: create(SMALL_HTML) });
    });
    const id = await runCreate('Create index.html with a heading.');
    const attempt = await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(attempt.status).toBe('waiting_for_approval');
    expect(requests).toHaveLength(1);
    expect(db.all("SELECT * FROM approvals WHERE json_extract(summary, '$.scopeIdentity') = ?", [id])).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
  });

  it('empty folder + large one-file creation: a ~120 KB proposal (several times a polished single-page app) is accepted intact', async () => {
    const large = `<!doctype html><html><body>\n${'<div class="row">0123456789 abcdefghij</div>\n'.repeat(2800)}</body></html>\n`;
    expect(large.length).toBeGreaterThan(100_000);
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => reply(request, { toolCalls: create(large) }));
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(attempt.status).toBe('waiting_for_approval');
    const rows = db.all("SELECT summary FROM approvals WHERE json_extract(summary, '$.scopeIdentity') = ?", [id]) as Array<{ summary: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].summary.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
  });

  it('"return only file contents" does not override the protocol: the compiled request says so and the user text is untouched', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
      return reply(request, { toolCalls: create(SMALL_HTML) });
    });
    const id = await runCreate();
    await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    const first = requests[0];
    const protocol = first.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(protocol).toContain('Mutation protocol');
    expect(protocol).toMatch(/return only the contents/i);
    expect(protocol).toMatch(/Never reply with the file as chat text/);
    expect(protocol).toMatch(/empty workspace \(0 files\) is a normal place to create files/);
    expect(first.messages.find((m) => m.role === 'user')!.content).toBe(USER_MESSAGE);
    expect(first.tools?.map((t) => t.name)).toContain('propose_file_change');
  });

  it('first reply is the raw file as chat text (protocol bypass) -> the corrective turn produces a valid CREATE', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
      return requests.length === 1
        ? reply(request, { content: SMALL_HTML, finishReason: 'stop' })
        : reply(request, { toolCalls: create(SMALL_HTML), finishReason: 'stop' });
    });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(attempt.status).toBe('waiting_for_approval');
    expect(requests).toHaveLength(2);
    const corrective = requests[1].messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    expect(corrective).toContain('single corrective turn');
    expect(corrective).toMatch(/returning only the file contents describes the file, not the reply/i);
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_proposal_correction_recovered'", [id])).toHaveLength(1);
  });

  const truncatedByReasoning = (request: ModelChatRequest) => reply(request, {
    content: '', finishReason: 'length', usage: { durationMs: 1, promptTokens: 7167, completionTokens: 25600, thinkingChars: 90_000 },
  });
  const events = (id: string, type: string) => db.all('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ?', [id, type]) as Array<{ metadata: string }>;

  it('reasoning consumed the envelope -> ONE identical retry with think:false (no corrective turn), then a CREATE proposal', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
      return requests.length === 1 ? truncatedByReasoning(request) : reply(request, { toolCalls: create(SMALL_HTML), finishReason: 'stop' });
    });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(attempt.status).toBe('waiting_for_approval');
    expect(requests).toHaveLength(2);
    expect(requests[0].ollama?.think).toBeUndefined();
    expect(requests[1].ollama?.think).toBe(false);
    // exact task and contract preserved: the retry is the identical message list
    expect(JSON.stringify(requests[1].messages)).toBe(JSON.stringify(requests[0].messages));
    expect(requests[1].tools?.map((t) => t.name)).toEqual(requests[0].tools?.map((t) => t.name));
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
    const started = events(id, 'reasoning_off_recovery_started');
    expect(started).toHaveLength(1);
    const evidence = JSON.parse(started[0].metadata);
    expect(evidence).toMatchObject({ promptTokens: 7167, completionTokens: 25600, thinkingChars: 90_000, visibleChars: 0, finishReason: 'length', provider: 'ollama' });
    expect(events(id, 'model_output_truncated')).toHaveLength(0);
  });

  it('the reasoning-off retry also truncates -> explicit model_output_truncated, exactly two calls, no corrective turn', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => { requests.push(request); return truncatedByReasoning(request); });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    expect(requests).toHaveLength(2);
    expect(attempt.failureReason).toContain('model_output_truncated');
    expect(attempt.failureReason).toContain('reasoning was turned off for one retry and that retry also hit the token/context limit');
    expect(attempt.failureReason).toContain('7167 + completion 25600 = 32767');
    expect(attempt.failureReason).not.toContain('could not produce an actionable mutation proposal');
    expect(events(id, 'reasoning_off_recovery_started')).toHaveLength(1);
    expect(events(id, 'reasoning_off_recovery_resolved')).toHaveLength(1);
    expect(events(id, 'model_output_truncated')).toHaveLength(1);
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
  });

  it('the reasoning-off retry finishes but proposes nothing -> explicit truncation result, no further retry', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return requests.length === 1 ? truncatedByReasoning(request) : reply(request, { content: SMALL_HTML, finishReason: 'stop' });
    });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    expect(requests).toHaveLength(2);
    expect(attempt.failureReason).toContain('still produced no mutation proposal');
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
  });

  it('truncation WITHOUT reasoning evidence is not adapted: it fails at once as model_output_truncated (one call)', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return reply(request, { content: '<!doctype html><html>', finishReason: 'length', usage: { durationMs: 1, promptTokens: 7000, completionTokens: 25700 } });
    });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    expect(requests).toHaveLength(1);
    expect(attempt.failureReason).toContain('model_output_truncated');
    expect(events(id, 'reasoning_off_recovery_started')).toHaveLength(0);
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
  });

  it('a proposal above the 256 KB checkpoint cap fails as MUTATION_PAYLOAD_TOO_LARGE with a product-level message', async () => {
    const huge = `<html>${'x'.repeat(300_000)}</html>`;
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => reply(request, { toolCalls: create(huge) }));
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    expect(attempt.failureReason).toContain('MUTATION_PAYLOAD_TOO_LARGE');
    expect(attempt.failureReason).toContain('Nothing was written');
    expect(attempt.failureReason).not.toContain('loop continuation');
    expect(fs.existsSync(path.join(dir, 'index.html'))).toBe(false);
  });

  it('a non-truncated protocol failure keeps its own classification (finishReason=stop, never acts)', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return reply(request, { content: SMALL_HTML, finishReason: 'stop' });
    });
    const id = await runCreate();
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    expect(requests).toHaveLength(2);
    expect(attempt.failureReason).toContain('could not produce an actionable mutation proposal');
    expect(attempt.failureReason).not.toContain('model_output_truncated');
  });
});

describe('M47.1 reasoning-off retry also widens an implicit context window', () => {
  const KNOWN_32K = { tokens: 32_768, source: 'provider_introspection' } as const;
  const truncated = (request: ModelChatRequest, numCtx: number | null) => reply(request, {
    content: '', finishReason: 'length', usage: { durationMs: 1, promptTokens: 7167, completionTokens: 9000, thinkingChars: 90_000 },
    sent: { numCtx, numPredict: null, think: null },
  });
  const events = (id: string, type: string) => db.all('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ?', [id, type]) as Array<{ metadata: string }>;
  const startedMeta = (id: string) => JSON.parse(events(id, 'reasoning_off_recovery_started')[0].metadata);

  /** First call is truncated at `firstCtx`; the retry (if any) succeeds and reports the num_ctx it was handed. */
  function script(firstCtx: number | null) {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return requests.length === 1
        ? truncated(request, firstCtx)
        : reply(request, { toolCalls: create(SMALL_HTML), finishReason: 'stop', sent: { numCtx: request.ollama?.numCtx ?? firstCtx, numPredict: null, think: request.ollama?.think ?? null } });
    });
    return requests;
  }

  it('1. implicit 16K + truncation -> one retry at the known 32K with think:false, journaled', async () => {
    const requests = script(16_384);
    const id = await runCreate(USER_MESSAGE, KNOWN_32K);
    const attempt = await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(attempt.status).toBe('waiting_for_approval');
    expect(requests).toHaveLength(2);
    expect(requests[0].ollama?.numCtx).toBeUndefined();
    expect(requests[1].ollama).toMatchObject({ think: false, numCtx: 32_768 });
    expect(JSON.stringify(requests[1].messages)).toBe(JSON.stringify(requests[0].messages));
    expect(startedMeta(id)).toMatchObject({
      adaptation: 'reasoning_budget_exhausted_and_context_widened',
      previousNumCtx: 16_384, newNumCtx: 32_768, contextWidened: true,
      reasoning: { wireThinkBefore: null, observedHiddenThinking: true, stateBefore: 'inferred_default_on', wireThinkAfter: false },
      recoveryCeiling: 32_768, recoveryTarget: 32_768, limitingFactor: 'known_context_window',
      promptTokens: 7167, completionTokens: 9000, finishReason: 'length',
      sent: { numCtx: 16_384, numPredict: null, think: null },
    });
    expect(startedMeta(id).contextWidenReason).toMatch(/^widened:.*16384.*32768/);
    // the retry's own wire values are journaled too
    const resolved = events(id, 'reasoning_off_recovery_resolved');
    expect(resolved).toHaveLength(0); // a successful proposal needs no "resolved" row; the retry result is what proves it
  });

  it('2. already at 32K -> reasoning-off retry, no meaningless context change', async () => {
    const requests = script(32_768);
    const id = await runCreate(USER_MESSAGE, KNOWN_32K);
    await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(requests).toHaveLength(2);
    expect(requests[1].ollama?.think).toBe(false);
    expect(requests[1].ollama?.numCtx).toBeUndefined();
    expect(startedMeta(id)).toMatchObject({ adaptation: 'reasoning_budget_exhausted', previousNumCtx: 32_768, newNumCtx: 32_768, contextWidened: false });
    expect(startedMeta(id).contextWidenReason).toMatch(/already at the recovery target/);
  });

  it('3. explicit user 16K -> never silently widened', async () => {
    vi.stubEnv('KARKEDIKHA_OLLAMA_NUM_CTX', '16384');
    try {
      const requests = script(16_384);
      const id = await runCreate(USER_MESSAGE, KNOWN_32K);
      await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
      expect(requests).toHaveLength(2);
      expect(requests[1].ollama).toMatchObject({ think: false, numCtx: 16_384 });
      expect(startedMeta(id)).toMatchObject({ contextWidened: false, explicitNumCtx: true, newNumCtx: 16_384 });
      expect(startedMeta(id).contextWidenReason).toMatch(/set explicitly/);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('4. runtime maximum unknown (assumed default window) -> keep the current context, only disable reasoning', async () => {
    const requests = script(16_384);
    const id = await runCreate();
    await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(requests).toHaveLength(2);
    expect(requests[1].ollama?.think).toBe(false);
    expect(requests[1].ollama?.numCtx).toBeUndefined();
    expect(startedMeta(id)).toMatchObject({ adaptation: 'reasoning_budget_exhausted', contextWidened: false, knownMaxNumCtx: null, previousNumCtx: 16_384, newNumCtx: 16_384 });
    expect(startedMeta(id).contextWidenReason).toMatch(/not known/);
  });

  it('3b. model advertises 131K -> automatic widening is capped at the 32K ceiling and journals why', async () => {
    const requests = script(16_384);
    const id = await runCreate(USER_MESSAGE, { tokens: 131_072, source: 'provider_introspection' });
    await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(requests[1].ollama).toMatchObject({ think: false, numCtx: 32_768 });
    expect(startedMeta(id)).toMatchObject({ newNumCtx: 32_768, knownMaxNumCtx: 131_072, recoveryCeiling: 32_768, recoveryCeilingSource: 'default', recoveryTarget: 32_768, limitingFactor: 'automatic_recovery_ceiling' });
  });

  it('3c. ceiling is configurable via env', async () => {
    vi.stubEnv('KARKEDIKHA_OLLAMA_RECOVERY_MAX_NUM_CTX', '65536');
    try {
      const requests = script(16_384);
      const id = await runCreate(USER_MESSAGE, { tokens: 131_072, source: 'provider_introspection' });
      await pollAttempt(id, (a) => ['waiting_for_approval', 'failed'].includes(a.status));
      expect(requests[1].ollama).toMatchObject({ numCtx: 65_536 });
      expect(startedMeta(id)).toMatchObject({ recoveryCeiling: 65_536, recoveryCeilingSource: 'env' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('5. second truncation after the widened retry -> honest stop, exactly two calls, no third attempt', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      return truncated(request, request.ollama?.numCtx ?? 16_384);
    });
    const id = await runCreate(USER_MESSAGE, KNOWN_32K);
    const attempt = await pollAttempt(id, (a) => a.status === 'failed');
    await new Promise((r) => setTimeout(r, 100));
    expect(requests).toHaveLength(2);
    expect(requests[1].ollama).toMatchObject({ think: false, numCtx: 32_768 });
    expect(attempt.failureReason).toContain('model_output_truncated');
    expect(attempt.failureReason).toContain('that retry also hit the token/context limit');
    expect(events(id, 'reasoning_off_recovery_started')).toHaveLength(1);
    expect(events(id, 'reasoning_off_recovery_resolved')).toHaveLength(1);
    expect(events(id, 'model_output_truncated')).toHaveLength(1);
    expect(JSON.parse(events(id, 'model_output_truncated')[0].metadata).sent.numCtx).toBe(32_768);
  });

  it('6. cancelled before the retry -> no retry and no recovery journaled', async () => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      requests.push(request);
      // the executor starts inside runCreate, before it returns the id: this test db holds exactly one attempt
      const live = (db.get('SELECT id FROM attempts LIMIT 1') as { id: string }).id;
      await authedFetch(`/v1/attempts/${live}/cancel`, { method: 'POST', idempotencyKey: idemp() });
      return truncated(request, 16_384);
    });
    const id = await runCreate(USER_MESSAGE, KNOWN_32K);
    await pollAttempt(id, (a) => /cancel/.test(String(a.status)));
    await new Promise((r) => setTimeout(r, 150));
    expect(requests).toHaveLength(1);
    expect(events(id, 'reasoning_off_recovery_started')).toHaveLength(0);
  });
});

describe('Ollama backend instruments the exact values sent', () => {
  it('reports num_ctx / num_predict / think as they were put on the wire, not as selected', async () => {
    const bodies: any[] = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.url === '/api/ps') { res.end('{"models":[]}'); return; }
        bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.write(`${JSON.stringify({ model: 'qwen', message: { content: 'ok' }, done: true, done_reason: 'stop' })}\n`);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const b = new OllamaModelBackend(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
      const explicit = await b.streamChat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }], ollama: { numCtx: 32_768, think: false } }, () => {});
      expect(explicit.sent).toEqual({ numCtx: 32_768, numPredict: null, think: false });
      expect(bodies[0].options.num_ctx).toBe(32_768);
      expect(bodies[0].think).toBe(false);
      const omitted = await b.streamChat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] }, () => {});
      expect(omitted.sent).toEqual({ numCtx: null, numPredict: null, think: null });
      expect(bodies[1].options).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('Ollama backend reports why generation ended', () => {
  async function withFakeOllama(frames: object[], run: (backend: OllamaModelBackend) => Promise<void>) {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      for (const frame of frames) res.write(`${JSON.stringify(frame)}\n`);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      await run(new OllamaModelBackend(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  it('surfaces done_reason=length and counts hidden reasoning separately from content', async () => {
    await withFakeOllama([
      { model: 'qwen', message: { thinking: 'a'.repeat(1000) }, done: false },
      { model: 'qwen', message: { thinking: 'b'.repeat(500) }, done: false },
      { model: 'qwen', message: { content: '' }, done: true, done_reason: 'length', prompt_eval_count: 7167, eval_count: 25600 },
    ], async (b) => {
      const result = await b.streamChat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] }, () => {});
      expect(result.finishReason).toBe('length');
      expect(result.content).toBe('');
      expect(result.usage.thinkingChars).toBe(1500);
      expect(result.usage.completionTokens).toBe(25600);
    });
  });

  it('surfaces done_reason=stop for a natural end', async () => {
    await withFakeOllama([
      { model: 'qwen', message: { content: 'ok' }, done: false },
      { model: 'qwen', message: { content: '' }, done: true, done_reason: 'stop' },
    ], async (b) => {
      const result = await b.streamChat({ model: 'qwen', messages: [{ role: 'user', content: 'hi' }] }, () => {});
      expect(result.finishReason).toBe('stop');
      expect(result.usage.thinkingChars).toBeUndefined();
    });
  });
});
