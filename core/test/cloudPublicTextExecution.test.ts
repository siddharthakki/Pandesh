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
import { CloudCredentialStore, sharedCloudCredentials } from '../runtime/cloudCredentials';

const TOKEN = generateToken();
const API_KEY = 'gsk_FREECLOUD_test_1234567890';
const GROQ_BASE = 'https://groq.test/v1';

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
  return sse('Hello from a free cloud model', body.model);
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
const idem = () => `fc-${++counter}`;

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

function selection(approved: boolean) {
  return {
    requiredCapabilities: {
      readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false,
      codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false,
    },
    selectedProvider: 'groq',
    selectedModel: 'openai/gpt-oss-20b',
    selectionReason: 'Your selected model',
    suitabilitySummary: 'manual',
    userOverrode: true,
    candidates: [{ provider: 'groq', model: 'openai/gpt-oss-20b', available: true, capable: true, costRank: 1, rejectionReasons: [] }],
    escalationCandidates: [],
    routingPolicy: 'explicit-cloud',
    cloudSpend: { mode: 'FREE_ONLY' as const, modelFreeness: 'free' as const },
    ...(approved ? { cloudPublicTextApproved: true } : {}),
  };
}

async function submit(approved: boolean, text = 'What is the capital of France?') {
  const conversation = await json(await authed('/v1/conversations', { method: 'POST', idempotencyKey: idem(), body: JSON.stringify({ mode: 'baat_kar' }) }));
  const submission = await json(await authed('/v1/submit', {
    method: 'POST', idempotencyKey: idem(),
    body: JSON.stringify({
      currentMessage: text, requestedMode: 'baat_kar', conversationId: conversation.id,
      requestedProvider: 'groq', requestedModel: 'openai/gpt-oss-20b', modelSelection: selection(approved),
    }),
  }));
  await authed(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST', idempotencyKey: idem() });
  return submission.attempt.id as string;
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-freecloud-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  localBackend = new LocalSpy();
  cloudCalls = [];
  sharedCloudCredentials.clear('groq');
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
  await json(await authed('/v1/providers/groq/credential', { method: 'POST', body: JSON.stringify({ baseUrl: GROQ_BASE, apiKey: API_KEY }) }));
});

afterEach(async () => {
  sharedCloudCredentials.clear('groq');
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Core enforces the free-cloud public-text boundary', () => {
  it('refuses an unapproved cloud request in Core before any network call and never falls back to local', async () => {
    const attempt = await pollAttempt(await submit(false), a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('failed');
    expect(JSON.stringify(attempt)).toMatch(/Cloud inference refused/);
    expect(cloudCalls).toHaveLength(0);
    expect(localBackend.calls).toBe(0);
  });

  it('refuses text that looks like a secret even when approved', async () => {
    const attempt = await pollAttempt(await submit(true, 'my key is sk-abcdefghijklmnopqrstuvwxyz0123456789'), a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('failed');
    expect(cloudCalls).toHaveLength(0);
    expect(localBackend.calls).toBe(0);
  });

  it('sends exactly two messages and no tools for an approved public text', async () => {
    const attempt = await pollAttempt(await submit(true), a => a.status === 'completed' || a.status === 'failed');
    expect(attempt.status).toBe('completed');
    expect(localBackend.calls).toBe(0);
    expect(cloudCalls).toHaveLength(1);
    expect(cloudCalls[0].url).toBe(`${GROQ_BASE}/chat/completions`);
    expect(cloudCalls[0].body.messages).toHaveLength(2);
    expect(cloudCalls[0].body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(cloudCalls[0].body.messages[1].content).toBe('What is the capital of France?');
    expect(cloudCalls[0].body.tools ?? []).toHaveLength(0);
  });
});
