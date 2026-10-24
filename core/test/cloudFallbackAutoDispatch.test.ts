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
import { sharedCloudCredentials } from '../runtime/cloudCredentials';

/**
 * An enabled cloud fallback chosen by Auto (userOverrode=false, routingPolicy local-first-cloud-fallback) is
 * dispatched through the provider the host named, with the credential the host delivered — never the local backend.
 */
const TOKEN = generateToken();
const API_KEY = 'sk-orca-fallback-SECRET-5555';
const ORCA_BASE = 'https://api.orcarouter.ai/v1';
const FALLBACK_MODEL = 'openai/gpt-5.6-sol';

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let localCalls = 0;
let cloudCalls: Array<{ url: string; auth: string; model: string }>;

class LocalSpy implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    localCalls += 1;
    return { content: 'LOCAL', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

const cloudFetch = (async (input: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  cloudCalls.push({ url: String(input), auth: String((init?.headers as Record<string, string>)?.Authorization), model: body.model });
  const chunks = [
    `data: ${JSON.stringify({ model: body.model, choices: [{ delta: { content: 'Hello from the fallback' } }] })}`,
    `data: ${JSON.stringify({ model: body.model, choices: [{ finish_reason: 'stop' }] })}`,
    'data: [DONE]',
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(`${chunk}\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}) as unknown as typeof fetch;

function authed(pathAndQuery: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client' };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${pathAndQuery}`, { ...init, headers });
}

let counter = 0;
const idem = () => `fallback-${++counter}`;

async function json(res: Response) {
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function settled(id: string): Promise<any> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const attempt = await (await authed(`/v1/attempts/${id}`)).json();
    if (attempt.status === 'completed' || attempt.status === 'failed') return attempt;
    if (Date.now() > deadline) throw new Error(`attempt never settled; status=${attempt.status}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const fallbackSelection = {
  requiredCapabilities: {
    readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
    codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false,
  },
  selectedProvider: 'orcarouter',
  selectedModel: FALLBACK_MODEL,
  selectionReason: 'Local models are unavailable; the enabled cloud fallback was used.',
  suitabilitySummary: 'fallback',
  userOverrode: false,
  candidates: [{ provider: 'orcarouter', model: FALLBACK_MODEL, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
  escalationCandidates: [],
  routingPolicy: 'local-first-cloud-fallback',
  cloudSpend: { mode: 'UNRESTRICTED' as const, modelFreeness: 'unknown' as const },
};

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-fallback-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  localCalls = 0;
  cloudCalls = [];
  sharedCloudCredentials.clear('orcarouter');
  api = await startApiServer({
    db, token: TOKEN, broadcaster: new EventBroadcaster(), dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend: new LocalSpy(), cloudFetch, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  sharedCloudCredentials.clear('orcarouter');
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('automatic cloud fallback selection reaches dispatch', () => {
  it('executes through OrcaRouter with the delivered credential and never calls the local backend', async () => {
    await json(await authed('/v1/providers/orcarouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: ORCA_BASE, apiKey: API_KEY }) }));
    const conversation = await json(await authed('/v1/conversations', { method: 'POST', idempotencyKey: idem(), body: JSON.stringify({ mode: 'baat_kar' }) }));
    const submission = await json(await authed('/v1/submit', {
      method: 'POST', idempotencyKey: idem(),
      body: JSON.stringify({
        currentMessage: 'Say hello.', requestedMode: 'baat_kar', conversationId: conversation.id,
        requestedProvider: 'orcarouter', requestedModel: FALLBACK_MODEL, modelSelection: fallbackSelection,
      }),
    }));
    await authed(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: idem() });

    const attempt = await settled(submission.attempt.id);
    expect(attempt.status).toBe('completed');
    expect(localCalls).toBe(0);
    expect(cloudCalls).toEqual([{ url: `${ORCA_BASE}/chat/completions`, auth: `Bearer ${API_KEY}`, model: FALLBACK_MODEL }]);

    const context = await json(await authed(`/v1/attempts/${submission.attempt.id}/context`));
    expect(context.selectedProvider).toBe('orcarouter');
    expect(context.modelSelection).toMatchObject({ userOverrode: false, routingPolicy: 'local-first-cloud-fallback' });
  });
});
