/**
 * End to end through a real Core HTTP server and executor: a free cloud provider answers 429 and Core switches to
 * the next approved, verified, qualified free model frozen into the approval; with nothing eligible left, it stops
 * with a clear reason. Never a local or paid fallback, never a different privacy class.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { activeFreeModelRegistry } from '../runtime/freeModelRegistryService';
import { fixtureFetch, primaryFixture, secondaryFixture } from './fixtures/freeModelRegistryFixtures';

const TOKEN = generateToken();
const KEY_A = 'gsk_PANDESHDUMMYfallbackA000000000000001';
const KEY_B = 'sk-or-v1-PANDESHDUMMYfallbackB0000000000002';
const GROQ = { provider: 'groq', model: 'openai/gpt-oss-20b' };
const OR = { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' };

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let baseUrl: string;
let localCalls = 0;
let broadcaster: EventBroadcaster;
let published: string[] = [];
let cloudCalls: string[] = [];
let rateLimited = new Set<string>();

class LocalSpy implements ModelBackend {
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    localCalls += 1;
    return { content: 'LOCAL', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

function sse(text: string, model: string): Response {
  const lines = [`data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}`, `data: ${JSON.stringify({ model, choices: [{ finish_reason: 'stop' }] })}`, 'data: [DONE]'];
  return new Response(new ReadableStream({ start(c) { for (const l of lines) c.enqueue(new TextEncoder().encode(`${l}\n`)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const cloudFetch = (async (input: unknown, init?: RequestInit) => {
  const url = String(input);
  const body = JSON.parse(String(init?.body ?? '{}'));
  const provider = url.includes('groq') ? 'groq' : 'openrouter';
  cloudCalls.push(`${provider}::${body.model}`);
  if (rateLimited.has(provider)) return new Response('{"error":"rate limited"}', { status: 429, headers: { 'retry-after': '30' } });
  return sse(`Paris (answered by ${provider})`, body.model);
}) as unknown as typeof fetch;

const qualificationFetch = (async (_u: unknown, init?: RequestInit) => {
  const body = JSON.parse(String(init?.body ?? '{}'));
  const reply = (message: Record<string, unknown>) => new Response(JSON.stringify({ model: body.model, choices: [{ message }] }), { status: 200 });
  if (body.model === 'pandesh-qualification-nonexistent-model') return new Response('{}', { status: 404 });
  if (body.tools) return reply({ tool_calls: [{ function: { name: 'get_city_time', arguments: '{"city":"Paris"}' } }] });
  if (body.response_format) return reply({ content: '{"name":"Pandesh","count":3}' });
  const prompt = String(body.messages[0].content);
  if (prompt.includes('code word')) return reply({ content: 'BLUE-HERON-4721' });
  if (prompt.includes('function named add')) return reply({ content: 'const add = (a, b) => a + b;' });
  return reply({ content: 'OK' });
}) as unknown as typeof fetch;

const authed = (p: string, init: RequestInit & { idem?: boolean } = {}) => fetch(`${baseUrl}${p}`, {
  ...init,
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.method && init.method !== 'GET' ? { 'Idempotency-Key': `fm-${Math.random()}` } : {}) },
});
async function json(res: Response) { if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`); return res.json(); }

async function submit(fallback: Array<{ provider: string; model: string }>) {
  const conversation = await json(await authed('/v1/conversations', { method: 'POST', body: JSON.stringify({ mode: 'baat_kar' }) }));
  const submission = await json(await authed('/v1/submit', {
    method: 'POST',
    body: JSON.stringify({
      currentMessage: 'What is the capital of France?', requestedMode: 'baat_kar', conversationId: conversation.id,
      requestedProvider: GROQ.provider, requestedModel: GROQ.model,
      modelSelection: {
        requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
        selectedProvider: GROQ.provider, selectedModel: GROQ.model, selectionReason: 'Auto', suitabilitySummary: 'auto', userOverrode: true,
        candidates: [{ provider: GROQ.provider, model: GROQ.model, available: true, capable: true, costRank: 1, rejectionReasons: [] }],
        escalationCandidates: [], routingPolicy: 'explicit-cloud', cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' },
        cloudPublicTextApproved: true, cloudFallback: fallback,
      },
    }),
  }));
  await authed(`/v1/attempts/${submission.attempt.id}/execute`, { method: 'POST' });
  const deadline = Date.now() + 8000;
  for (;;) {
    const attempt = await (await authed(`/v1/attempts/${submission.attempt.id}`)).json();
    if (attempt.status === 'completed' || attempt.status === 'failed') return attempt;
    if (Date.now() > deadline) throw new Error(`attempt never settled (${attempt.status})`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-fallback-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  localCalls = 0; cloudCalls = []; rateLimited = new Set(); published = [];
  broadcaster = new EventBroadcaster();
  const original = broadcaster.publishRuntime.bind(broadcaster);
  broadcaster.publishRuntime = ((event: { eventType: string }) => { published.push(event.eventType); return original(event as never); }) as typeof broadcaster.publishRuntime;
  api = await startApiServer({
    db, token: TOKEN, hostToken: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend: new LocalSpy(), cloudFetch, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
  });
  baseUrl = `http://127.0.0.1:${api.port}`;
  await json(await authed('/v1/providers/groq/credential', { method: 'POST', body: JSON.stringify({ baseUrl: 'https://api.groq.com/openai/v1', apiKey: KEY_A }) }));
  await json(await authed('/v1/providers/openrouter/credential', { method: 'POST', body: JSON.stringify({ baseUrl: 'https://openrouter.ai/api/v1', apiKey: KEY_B }) }));
  const registry = activeFreeModelRegistry()!;
  await registry.refresh({ fetchFn: fixtureFetch({ primary: primaryFixture(), secondary: secondaryFixture() }) });
  for (const m of [GROQ, OR]) {
    registry.recordListing(m.provider, { ok: true, checkedAt: new Date().toISOString(), latencyMs: 50, httpStatus: 200, pool: [{ id: m.model, displayName: m.model, vision: 'unknown', tools: true }], excluded: { paid: 0, unknown: 0, promotional: 0, trial: 0, nonGenerative: 0 } });
    await registry.qualify(m.provider, m.model, { fetchFn: qualificationFetch, pauseMs: 0 });
  }
  registry.setPreferences({ autoProviders: ['groq', 'openrouter'], fallbackOnRateLimit: true });
});

afterEach(async () => {
  sharedCloudCredentials.clear('groq');
  sharedCloudCredentials.clear('openrouter');
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('A8: rate-limit fallback inside the approved free set', () => {
  it('switches to the approved alternative, records the switch for the activity view, never uses local', async () => {
    rateLimited.add('groq');
    const attempt = await submit([OR]);
    expect(attempt.status).toBe('completed');
    expect(cloudCalls).toEqual([`groq::${GROQ.model}`, `openrouter::${OR.model}`]);
    expect(localCalls).toBe(0);
    const events = db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'cloud_provider_switched'");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].metadata)).toMatchObject({ from: `groq::${GROQ.model}`, to: `openrouter::${OR.model}` });
    expect(published).toContain('cloud_provider_switched'); // pushed live to the app, not only stored
    const messages = JSON.stringify(db.all('SELECT content FROM conversation_messages'));
    expect(messages).toContain('answered by openrouter');
    expect(JSON.stringify(db.all('SELECT * FROM runtime_events'))).not.toContain(KEY_A);
  });

  it('stops with a clear blocker when every approved alternative is rate-limited too', async () => {
    rateLimited.add('groq'); rateLimited.add('openrouter');
    const attempt = await submit([OR]);
    expect(attempt.status).toBe('failed');
    expect(String(attempt.failureReason)).toMatch(/quota or rate limit/);
    expect(cloudCalls).toHaveLength(2);
    expect(localCalls).toBe(0);
  });

  it('does not switch to a provider the user did not approve for automatic routing', async () => {
    activeFreeModelRegistry()!.setPreferences({ autoProviders: ['groq'] });
    rateLimited.add('groq');
    const attempt = await submit([OR]);
    expect(attempt.status).toBe('failed');
    expect(cloudCalls).toEqual([`groq::${GROQ.model}`]);
  });

  it('without a frozen fallback list nothing switches (the approval named only one model)', async () => {
    rateLimited.add('groq');
    const attempt = await submit([]);
    expect(attempt.status).toBe('failed');
    expect(cloudCalls).toHaveLength(1);
  });
});

describe('router endpoint', () => {
  it('A6/A7 over HTTP: private is blocked (local only); public gets an approved free model', async () => {
    const priv = await json(await authed('/v1/cloud/route', { method: 'POST', body: JSON.stringify({ task: 'chat', privacy: 'private' }) }));
    expect(priv.decision.kind).toBe('blocked');
    const unspecified = await json(await authed('/v1/cloud/route', { method: 'POST', body: JSON.stringify({ task: 'chat' }) }));
    expect(unspecified.privacy).toBe('private');
    const pub = await json(await authed('/v1/cloud/route', { method: 'POST', body: JSON.stringify({ task: 'research', privacy: 'public' }) }));
    expect(pub.decision.kind).toBe('selected');
    const state = await json(await authed('/v1/cloud/registry'));
    expect(JSON.stringify(state)).not.toContain(KEY_A);
    expect(JSON.stringify(state)).not.toContain(KEY_B);
  });
});
