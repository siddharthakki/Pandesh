/**
 * Auto reroute through the LIVE Core executor failure path (not just the pure planner): a real attempt runs on a
 * real executor, the model really truncates, and the durable result is what the UI would see.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import { getAttempt } from '../domain/attempts';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { parseLocalOllamaModels, modelKey } from '../platform/modelCatalog';
import { FailureCooldowns } from '../platform/autoReroute';
import { ProviderCatalog } from '../platform/providerCatalog';
import { maybeAutoReroute, type RerouteEnvironment } from '../runtime/autoRerouteRuntime';

const TOKEN = generateToken();
const SMALL_HTML = '<!doctype html><html><body><h1>ok</h1></body></html>\n';

class ScriptedBackend implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    return { content: '', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

const localModels = parseLocalOllamaModels([{ name: 'zeta:1b' }, { name: 'alpha:1b' }, { name: 'beta:1b' }, { name: 'qwen3-embedding:4b' }]);
const environment: RerouteEnvironment = {
  models: localModels, reachableLocalKeys: new Set(localModels.map(modelKey)), connectedProviders: new Set(), catalog: new ProviderCatalog(),
};

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let backend: ScriptedBackend;
let baseUrl: string;
let envProvider: () => Promise<RerouteEnvironment | undefined>;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

let n = 0;
const idemp = () => `idemp-reroute-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function run(userOverrode: boolean, model = 'zeta:1b') {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: 'Create index.html with a heading.', requestedMode: 'saath_kar',
    conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: idemp(),
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'] },
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: model, selectionReason: 'test', suitabilitySummary: 'test', userOverrode, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return result.attempt.id as string;
}

const truncated = (request: ModelChatRequest): ModelChatResult => ({
  content: '', toolCalls: [], provider: 'ollama', model: request.model, finishReason: 'length',
  usage: { durationMs: 1, promptTokens: 100, completionTokens: 25600, thinkingChars: 90_000 },
});
const proposal = (request: ModelChatRequest): ModelChatResult => ({
  content: '', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'index.html', content: SMALL_HTML } }],
  provider: 'ollama', model: request.model, finishReason: 'stop', usage: { durationMs: 1 },
});
const rerouteEvents = () => db.all("SELECT entityId, metadata FROM runtime_events WHERE eventType = 'attempt_rerouted' ORDER BY id") as Array<{ entityId: string; metadata: string }>;
const attemptCount = () => (db.get('SELECT COUNT(*) AS n FROM attempts') as { n: number }).n;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-reroute-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  backend = new ScriptedBackend();
  envProvider = async () => environment;
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
      backend, toolRunner: runner, defaultModel: 'zeta:1b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governed),
      rerouteEnvironment: () => envProvider(),
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

describe('Auto reroute through the live executor failure path', () => {
  it('Auto + truncation before any mutation: the failed attempt is preserved and a successor on the next eligible model takes over the same objective', async () => {
    const seen: string[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => {
      seen.push(request.model);
      return request.model === 'zeta:1b' ? truncated(request) : proposal(request);
    });
    const id = await run(false);
    const failed = await pollAttempt(id, (a) => a.status === 'failed');
    expect(failed.failureReason).toContain('model_output_truncated');
    await vi.waitFor(() => expect(rerouteEvents()).toHaveLength(1));
    const [event] = rerouteEvents();
    const meta = JSON.parse(event.metadata);
    expect(meta).toMatchObject({ predecessorAttemptId: id, failedModel: 'zeta:1b', selectedModel: 'alpha:1b', fingerprint: 'model_output_truncated', rerouteIndex: 1 });
    expect(seen.at(-1)).toBe('alpha:1b');
    const successor = await pollAttempt(event.entityId, (a) => a.status === 'waiting_for_approval');
    expect(successor.predecessorAttemptId).toBe(id);
    expect(successor.requestId).toBe(failed.requestId); // same objective, same request identity
    const ctx = await (await authedFetch(`/v1/attempts/${successor.id}/context`)).json().catch(() => undefined);
    if (ctx) expect(ctx.selectedModel).toBe('alpha:1b');
    expect(getAttempt(db, id).status).toBe('failed'); // provenance: the failed attempt is never rewritten
    expect(seen).not.toContain('qwen3-embedding:4b');
  });

  it('is bounded: every model truncating yields the original plus at most 2 reroutes, then an honest failure', async () => {
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => truncated(request));
    const id = await run(false);
    await pollAttempt(id, (a) => a.status === 'failed');
    await vi.waitFor(() => expect(rerouteEvents()).toHaveLength(2), { timeout: 8000 });
    await vi.waitFor(() => expect(db.all("SELECT 1 FROM attempts WHERE status = 'failed'")).toHaveLength(3), { timeout: 8000 });
    await new Promise((r) => setTimeout(r, 150));
    expect(attemptCount()).toBe(3);
    const models = rerouteEvents().map((e) => JSON.parse(e.metadata).selectedModel);
    expect(new Set(models).size).toBe(2); // never bounces back to a model this objective already used
    expect(models).not.toContain('zeta:1b');
  });

  it('Manual selection never reroutes silently', async () => {
    const seen: string[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => { seen.push(request.model); return truncated(request); });
    const id = await run(true);
    const failed = await pollAttempt(id, (a) => a.status === 'failed');
    expect(failed.failureReason).toContain('model_output_truncated');
    await new Promise((r) => setTimeout(r, 150));
    expect(attemptCount()).toBe(1);
    expect(rerouteEvents()).toHaveLength(0);
    expect(new Set(seen)).toEqual(new Set(['zeta:1b']));
  });

  it('no host environment (fail closed) means no reroute', async () => {
    envProvider = async () => undefined;
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => truncated(request));
    const id = await run(false);
    await pollAttempt(id, (a) => a.status === 'failed');
    await new Promise((r) => setTimeout(r, 150));
    expect(attemptCount()).toBe(1);
  });

  it('a mutation that was already applied forbids rerouting', async () => {
    vi.spyOn(backend, 'streamChat').mockImplementation(async (request) => truncated(request));
    const id = await run(false);
    await pollAttempt(id, (a) => a.status === 'failed');
    await vi.waitFor(() => expect(attemptCount()).toBeGreaterThan(1), { timeout: 8000 });
    // Take the latest failed attempt in the chain and give it durable mutation evidence, then ask for a reroute directly.
    const rows = db.all("SELECT id FROM attempts WHERE status = 'failed' ORDER BY createdAt DESC") as Array<{ id: string }>;
    const target = rows[0].id;
    const before = attemptCount();
    db.run(
      "INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt) VALUES ('tool-mut-1', ?, 'propose_file_change', '{}', 'succeeded', ?)",
      [target, new Date().toISOString()],
    );
    const decision = await maybeAutoReroute({
      db, actor: 'test', environment: async () => environment, cooldowns: new FailureCooldowns(), isMutatingTool: (name) => name === 'propose_file_change',
    }, target);
    expect(decision).toBeUndefined();
    expect(attemptCount()).toBe(before);
  });
});
