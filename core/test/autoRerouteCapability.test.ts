/**
 * Auto reroute for a provider-refused model (`400 "<model>" does not support chat`), driven through the exact
 * production path that produced it: real OllamaModelBackend -> real Core executor -> recordChatFailure ->
 * maybeAutoReroute -> successor attempt. Only the Ollama HTTP server is faked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
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
import { OllamaModelBackend } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { parseLocalOllamaModels, modelKey } from '../platform/modelCatalog';
import { ProviderCatalog } from '../platform/providerCatalog';
import { classifyFailureFingerprint } from '../platform/autoReroute';
import type { RerouteEnvironment } from '../runtime/autoRerouteRuntime';
import { providerDeclaresNoChat } from '../domain/empiricalRouting';

const TOKEN = generateToken();
const NO_CHAT = '"clef-flash:latest" does not support chat';

const models = parseLocalOllamaModels([{ name: 'clef-flash:latest' }, { name: 'alpha:1b' }, { name: 'beta:1b' }]);
const environment: RerouteEnvironment = {
  models, reachableLocalKeys: new Set(models.map(modelKey)), connectedProviders: new Set(), catalog: new ProviderCatalog(),
};

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let ollama: http.Server;
let baseUrl: string;
let chatModels: string[];
let refuse: Set<string>;

const authedFetch = (p: string, init: RequestInit & { idempotencyKey?: string } = {}) => fetch(`${baseUrl}${p}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client',
    ...(init.idempotencyKey ? { 'Idempotency-Key': init.idempotencyKey } : {}),
  },
});
let n = 0;
const idemp = () => `idemp-capability-${++n}`;

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function runBaat(userOverrode: boolean, model = 'clef-flash:latest') {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: 'Explain what a mutex is.', requestedMode: 'baat_kar',
    conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: false, gitCapable: false }, correlationId: idemp(),
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: model, selectionReason: 'test', suitabilitySummary: 'test', userOverrode, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return result.attempt.id as string;
}

const rerouteEvents = () => db.all("SELECT entityId, metadata FROM runtime_events WHERE eventType = 'attempt_rerouted' ORDER BY id") as Array<{ entityId: string; metadata: string }>;
const attemptCount = () => (db.get('SELECT COUNT(*) AS n FROM attempts') as { n: number }).n;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-capability-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  chatModels = [];
  refuse = new Set(['clef-flash:latest']);
  ollama = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (req.url === '/api/ps') { res.end('{"models":[]}'); return; }
      const model = (JSON.parse(raw || '{}') as { model?: string }).model ?? '';
      chatModels.push(model);
      if (refuse.has(model)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: `"${model}" does not support chat` }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ model, message: { content: 'A mutex is a lock.' }, done: true, prompt_eval_count: 1, eval_count: 1 })}\n`);
    });
  });
  await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const ollamaUrl = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;

  const broadcaster = new EventBroadcaster();
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend: new OllamaModelBackend(ollamaUrl), toolRunner: new CoreToolRunner(), defaultModel: 'clef-flash:latest',
      defaultWorkingDirectory: dir, dataDir: dir, rerouteEnvironment: async () => environment,
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  await new Promise<void>((resolve) => ollama.close(() => resolve()));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('provider capability refusal is a reroutable, pre-mutation model failure', () => {
  it('classifies provider wording generically (no model names)', () => {
    expect(classifyFailureFingerprint(`Ollama responded 400: {"error":"\\"any-model:1b\\" does not support chat"}`)).toBe('model_capability_unsupported');
    expect(classifyFailureFingerprint('unsupported endpoint for this model')).toBe('model_capability_unsupported');
    expect(classifyFailureFingerprint('incompatible generation protocol')).toBe('model_capability_unsupported');
    expect(classifyFailureFingerprint('validation failed: tests red')).toBeUndefined();
  });

  it('provider-declared capabilities without `completion` mean no chat; unknown never refuses', () => {
    expect(providerDeclaresNoChat(['embedding'])).toBe(true);
    expect(providerDeclaresNoChat(['insert'])).toBe(true);
    expect(providerDeclaresNoChat(['completion', 'tools'])).toBe(false);
    expect(providerDeclaresNoChat([])).toBe(false);
    expect(providerDeclaresNoChat(undefined)).toBe(false);
  });

  it('Auto: the real backend 400 fails the attempt, then a successor on the next unused model completes the same objective', async () => {
    const id = await runBaat(false);
    const failed = await pollAttempt(id, (a) => a.status === 'failed');
    expect(failed.failureReason).toContain('model_capability_unsupported');
    expect(failed.failureReason).toContain(NO_CHAT.replace(/"/g, '\\"'));
    await vi_waitFor(() => rerouteEvents().length === 1);
    const [event] = rerouteEvents();
    expect(JSON.parse(event.metadata)).toMatchObject({
      predecessorAttemptId: id, failedModel: 'clef-flash:latest', selectedModel: 'alpha:1b', fingerprint: 'model_capability_unsupported', rerouteIndex: 1,
    });
    const successor = await pollAttempt(event.entityId, (a) => a.status === 'completed');
    expect(successor.predecessorAttemptId).toBe(id);
    expect(successor.requestId).toBe(failed.requestId);
    expect(getAttempt(db, id).status).toBe('failed'); // provenance: the failed attempt is never rewritten
    expect(chatModels).toEqual(['clef-flash:latest', 'alpha:1b']); // refused once, never retried, never revisited
  });

  it('Auto is bounded: at most 2 reroutes, never back to a used model', async () => {
    refuse = new Set(['clef-flash:latest', 'alpha:1b', 'beta:1b']);
    const id = await runBaat(false);
    await pollAttempt(id, (a) => a.status === 'failed');
    await vi_waitFor(() => rerouteEvents().length === 2);
    await vi_waitFor(() => (db.all("SELECT 1 FROM attempts WHERE status = 'failed'") as unknown[]).length === 3);
    await new Promise((r) => setTimeout(r, 150));
    expect(attemptCount()).toBe(3);
    expect(new Set(chatModels).size).toBe(3);
    expect(chatModels).toHaveLength(3);
  });

  it('Manual: no reroute; the failure states the incompatibility explicitly', async () => {
    const id = await runBaat(true);
    const failed = await pollAttempt(id, (a) => a.status === 'failed');
    await new Promise((r) => setTimeout(r, 150));
    expect(attemptCount()).toBe(1);
    expect(rerouteEvents()).toHaveLength(0);
    expect(failed.failureReason).toMatch(/model_capability_unsupported: 'clef-flash:latest' cannot serve this request/);
    expect(chatModels).toEqual(['clef-flash:latest']);
  });

  it('no reroute after a mutation (mutating tool invocation on the failed attempt)', async () => {
    const { maybeAutoReroute } = await import('../runtime/autoRerouteRuntime');
    const { FailureCooldowns } = await import('../platform/autoReroute');
    const id = await runBaat(false);
    await pollAttempt(id, (a) => a.status === 'failed');
    await vi_waitFor(() => attemptCount() >= 2);
    const target = (db.all("SELECT id FROM attempts WHERE status = 'failed' ORDER BY createdAt DESC") as Array<{ id: string }>)[0].id;
    const before = attemptCount();
    db.run("INSERT INTO tool_invocations (id, attemptId, toolName, argsSummary, status, startedAt) VALUES ('tool-mut-cap', ?, 'propose_file_change', '{}', 'succeeded', ?)", [target, new Date().toISOString()]);
    const out = await maybeAutoReroute({ db, actor: 'test', environment: async () => environment, cooldowns: new FailureCooldowns(), isMutatingTool: (name) => name === 'propose_file_change' }, target);
    expect(out).toBeUndefined();
    expect(attemptCount()).toBe(before);
  });
});

async function vi_waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 20));
  }
}
