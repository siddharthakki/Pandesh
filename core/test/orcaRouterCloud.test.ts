import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { resolveAttemptModelBackend, refuseOrcaRouterBeforeFetch } from '../runtime/attemptModelBackend';
import { CloudCredentialStore, sharedCloudCredentials } from '../runtime/cloudCredentials';
import { buildMissionEnvelope } from '../runtime/missionAuthorization';
import type { AttemptContextRecord } from '../shared/wireTypes';

const TOKEN = generateToken();
const API_KEY = 'sk-orca-test-SECRET-1234'; // gitleaks:allow
const ORCA_BASE = 'https://orca.test/v1';

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let localBackend: LocalSpy;
let cloudCalls: Array<{ url: string; headers: Record<string, string>; body: Record<string, any> }>;

/** The "Ollama" mock: any call to it means a manual cloud selection silently fell back to local. */
class LocalSpy implements ModelBackend {
  calls = 0;
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.calls += 1;
    return { content: 'LOCAL', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

function sse(text: string, model: string): Response {
  const chunks = [
    `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}`,
    `data: ${JSON.stringify({ model, choices: [{ finish_reason: 'stop' }] })}`,
    'data: [DONE]',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`${chunk}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const cloudFetch = (async (input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  cloudCalls.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body });
  return sse('Hello from OrcaRouter', body.model);
}) as unknown as typeof fetch;

function authed(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-client',
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let counter = 0;
const idem = () => `orca-${++counter}`;

async function json(res: Response) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function pollAttempt(id: string, predicate: (a: any) => boolean): Promise<any> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const attempt = await (await authed(`/v1/attempts/${id}`)).json();
    if (predicate(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt never settled; status=${attempt.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function manualSelection(model: string) {
  return {
    requiredCapabilities: {
      readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
      codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false,
    },
    selectedProvider: 'orcarouter',
    selectedModel: model,
    selectionReason: 'Your selected model',
    suitabilitySummary: 'manual',
    userOverrode: true,
    candidates: [{ provider: 'orcarouter', model, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
    escalationCandidates: [],
    routingPolicy: 'explicit-orcarouter',
    // Frozen spend facts the host records at selection time; Core refuses a cloud call without them.
    cloudSpend: { mode: 'UNRESTRICTED' as const, modelFreeness: 'unknown' as const },
  };
}

async function submitManual(model: string) {
  const conversation = await json(await authed('/v1/conversations', { method: 'POST', idempotencyKey: idem(), body: JSON.stringify({ mode: 'baat_kar' }) }));
  const submission = await json(await authed('/v1/submit', {
    method: 'POST', idempotencyKey: idem(),
    body: JSON.stringify({
      currentMessage: 'Say hello.', requestedMode: 'baat_kar', conversationId: conversation.id,
      requestedProvider: 'orcarouter', requestedModel: model, modelSelection: manualSelection(model),
    }),
  }));
  await authed(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: idem() });
  return submission.attempt.id as string;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-orca-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  localBackend = new LocalSpy();
  cloudCalls = [];
  sharedCloudCredentials.clear('orcarouter');
  api = await startApiServer({
    db,
    token: TOKEN,
    broadcaster: new EventBroadcaster(),
    dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend: localBackend, cloudFetch, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  sharedCloudCredentials.clear('orcarouter');
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OrcaRouter credential delivery', () => {
  it('stores the key in memory only and never echoes or persists it', async () => {
    const before = await json(await authed('/v1/providers/orcarouter'));
    expect(before).toEqual({ configured: false });

    const set = await json(await authed('/v1/providers/orcarouter/credential', {
      method: 'POST', body: JSON.stringify({ baseUrl: `${ORCA_BASE}/`, apiKey: API_KEY }),
    }));
    expect(set).toEqual({ configured: true, baseUrl: ORCA_BASE });
    expect(JSON.stringify(set)).not.toContain(API_KEY);
    expect(sharedCloudCredentials.get('orcarouter')).toEqual({ baseUrl: ORCA_BASE, apiKey: API_KEY });

    for (const { name } of db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")) {
      expect(JSON.stringify(db.all(`SELECT * FROM "${name}"`))).not.toContain(API_KEY);
    }

    const cleared = await json(await authed('/v1/providers/orcarouter/credential', { method: 'DELETE' }));
    expect(cleared).toEqual({ configured: false });
    expect(sharedCloudCredentials.get('orcarouter')).toBeUndefined();
  });

  it('rejects an incomplete or malformed credential without storing anything', async () => {
    const missingKey = await authed('/v1/providers/orcarouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: ORCA_BASE }) });
    expect(missingKey.status).toBe(400);
    const badUrl = await authed('/v1/providers/orcarouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: 'ftp://x', apiKey: API_KEY }) });
    expect(badUrl.status).toBe(400);
    expect(JSON.stringify(await badUrl.json())).not.toContain(API_KEY);
    expect(sharedCloudCredentials.get('orcarouter')).toBeUndefined();
  });
});

describe('manual OrcaRouter selection reaches dispatch exactly', () => {
  it('sends the exact provider/model through OrcaRouter and never touches the local backend', async () => {
    await json(await authed('/v1/providers/orcarouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: ORCA_BASE, apiKey: API_KEY }) }));

    const attemptId = await submitManual('acme/model-x');
    const attempt = await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');

    expect(localBackend.calls).toBe(0);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toBe(`${ORCA_BASE}/chat/completions`);
    expect(cloudCalls[0].headers.Authorization).toBe(`Bearer ${API_KEY}`);
    expect(cloudCalls[0].body.model).toBe('acme/model-x');

    const context = await json(await authed(`/v1/attempts/${attemptId}/context`));
    expect(context.selectedProvider).toBe('orcarouter');
    expect(context.selectedModel).toBe('acme/model-x');
    const invocation = db.all<{ policyProvider: string; policyModel: string }>('SELECT * FROM model_invocations')[0];
    expect(invocation).toMatchObject({ policyProvider: 'orcarouter', policyModel: 'acme/model-x' });
  });

  it('fails visibly when OrcaRouter has no credential in Core, without falling back to Ollama', async () => {
    const attemptId = await submitManual('acme/model-x');
    const attempt = await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('failed');
    expect(JSON.stringify(attempt)).toMatch(/OrcaRouter is not configured/);
    expect(localBackend.calls).toBe(0);
    expect(cloudCalls).toHaveLength(0);
  });

  it('a bad key surfaces an authentication failure and does not leak the key or fall back', async () => {
    await json(await authed('/v1/providers/orcarouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: ORCA_BASE, apiKey: API_KEY }) }));
    await api.close();
    api = await startApiServer({
      db, token: TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: {
        backend: localBackend, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir,
        cloudFetch: (async () => new Response('{"error":"bad key"}', { status: 401 })) as unknown as typeof fetch,
      },
    });
    baseUrl = `http://127.0.0.1:${api.port}`;
    const attemptId = await submitManual('acme/model-x');
    const attempt = await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('failed');
    expect(JSON.stringify(attempt)).toMatch(/OrcaRouter authentication failed/);
    expect(JSON.stringify(attempt)).not.toContain(API_KEY);
    expect(localBackend.calls).toBe(0);
  });
});

describe('OrcaRouter backend resolution', () => {
  function context(provider: string, model = 'acme/model-x'): AttemptContextRecord {
    return { selectedProvider: provider, selectedModel: model, modelSelection: { cloudSpend: { mode: 'UNRESTRICTED', modelFreeness: 'unknown' } } } as unknown as AttemptContextRecord;
  }

  it('resolves a distinct OrcaRouter backend from an injected credential store, ignoring the injected local backend', async () => {
    const store = new CloudCredentialStore();
    store.set('orcarouter', { baseUrl: ORCA_BASE, apiKey: API_KEY });
    const backend = resolveAttemptModelBackend({ context: context('orcarouter'), db, injectedBackend: localBackend, cloudCredentials: store, fetchFn: cloudFetch });
    expect(backend).not.toBe(localBackend);
    const result = await backend.streamChat({ model: 'acme/model-x', messages: [{ role: 'user', content: 'hi' }] }, () => undefined);
    expect(result.provider).toBe('orcarouter');
    expect(result.content).toBe('Hello from OrcaRouter');
    expect(localBackend.calls).toBe(0);
  });

  it('refuses before any fetch when the credential or model is missing', () => {
    const empty = new CloudCredentialStore();
    expect(() => refuseOrcaRouterBeforeFetch(context('orcarouter'), empty)).toThrow(/not configured/);
    const store = new CloudCredentialStore();
    store.set('orcarouter', { baseUrl: ORCA_BASE, apiKey: API_KEY });
    expect(() => refuseOrcaRouterBeforeFetch(context('orcarouter', '  '), store)).toThrow(/model is required/);
  });

  it('labels the mission authorization envelope as explicit OrcaRouter routing, not local-only', () => {
    const envelope = buildMissionEnvelope({ workspaceRoot: dir, objective: 'x', model: 'acme/model-x', selectedProvider: 'orcarouter' });
    expect(envelope.routingPolicy).toBe('explicit-orcarouter');
    expect(envelope.selectedProvider).toBe('orcarouter');
  });
});
