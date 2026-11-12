/**
 * A whole Pandesh turn on a free cloud model (owner, 2026-11-12): a cloud model picked before the chat — or approved
 * after every local model failed — runs the full Pi turn there: the chat's messages, the tools, the tool results.
 * Without the user's choice, the key, or a free spend policy, nothing is sent. A scripted OpenAI-compatible provider
 * stands in for the cloud; a scripted Ollama records that the local chat endpoint is never used.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation, listMessages } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import { resolvePiCloudTarget } from '../runtime/piCloudTarget';
import { isFreeCloudPublicTextAttempt } from '../runtime/attemptModelBackend';

interface CloudCall { auth: string; model: string; messages: Array<{ role: string; content: unknown }>; tools: string[] }

let cloud: http.Server;
let ollama: http.Server;
let cloudCalls: CloudCall[] = [];
let ollamaChatCalls = 0;
let cloudBase = '';
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;

function sse(res: http.ServerResponse, delta: Record<string, unknown>, finish: string | null) {
  res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'glm-free', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}

beforeAll(async () => {
  cloud = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url?.endsWith('/chat/completions')) { res.writeHead(404); res.end(); return; }
      const payload = JSON.parse(body);
      const call: CloudCall = { auth: String(req.headers.authorization ?? ''), model: payload.model, messages: payload.messages, tools: (payload.tools ?? []).map((t: any) => t.function.name) };
      cloudCalls.push(call);
      const last = call.messages[call.messages.length - 1];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const asked = JSON.stringify(last.content);
      if (last.role !== 'tool' && asked.includes('What date is tomorrow?') && call.tools.includes('resolve_time')) {
        sse(res, { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'resolve_time', arguments: '{"expression":"tomorrow"}' } }] }, null);
        sse(res, {}, 'tool_calls');
      } else {
        sse(res, { role: 'assistant', content: last.role === 'tool' ? 'Tomorrow is the day after today (checked with the clock tool).' : 'A hash table maps keys to values.' }, null);
        sse(res, {}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  ollama = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/chat')) ollamaChatCalls += 1;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((r) => cloud.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
  cloudBase = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}/v1`;
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise<void>((r) => cloud.close(() => r()));
  await new Promise<void>((r) => ollama.close(() => r()));
});

const approvedSelection = (extra: Record<string, unknown> = {}) => ({
  requiredCapabilities: {}, candidates: [], escalationCandidates: [], selectedProvider: 'orcarouter', selectedModel: 'z-ai/glm-5.3-flash-free',
  selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, routingPolicy: 'explicit-cloud',
  cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' }, cloudChatApproved: true, cloudChatSource: 'picked_before_chat', ...extra,
});
const contextWith = (selection: Record<string, unknown>) => ({ selectedProvider: 'orcarouter', selectedModel: 'z-ai/glm-5.3-flash-free', modelSelection: selection }) as any;

describe('cloud turn gate', () => {
  const credentials = new CloudCredentialStore();
  beforeAll(() => credentials.set('orcarouter', { baseUrl: 'https://api.orcarouter.ai/v1', apiKey: 'sk-test' }));

  it('runs only what the user chose, with the key delivered and a free spend policy', () => {
    expect(resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection()), credentials })).toMatchObject({ provider: 'orcarouter', apiKey: 'sk-test', why: 'picked_before_chat' });
    expect(resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection({ cloudChatSource: 'approved_offer' })), credentials }).why).toBe('approved_offer');
    expect(() => resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection({ cloudChatApproved: undefined })), credentials })).toThrow(/did not choose a cloud model/);
    expect(() => resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection()), credentials: new CloudCredentialStore() })).toThrow(/no API key was delivered/);
    expect(() => resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection({ cloudSpend: undefined })), credentials })).toThrow(/cannot be shown to be free/);
    expect(() => resolvePiCloudTarget({ provider: 'orcarouter', context: contextWith(approvedSelection({ cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'paid' } })), credentials })).toThrow();
    expect(() => resolvePiCloudTarget({ provider: 'groq', context: contextWith(approvedSelection()), credentials })).toThrow(/does not name this provider/);
  });

  it('keeps the one-message path for an approved public text, and leaves it for a chosen cloud chat', () => {
    expect(isFreeCloudPublicTextAttempt(contextWith({ ...approvedSelection(), cloudChatApproved: undefined, cloudPublicTextApproved: true }), new CloudCredentialStore())).toBe(true);
    expect(isFreeCloudPublicTextAttempt(contextWith(approvedSelection()), new CloudCredentialStore())).toBe(false);
  });

  it('offers only a chosen model whose key is delivered and that is verified free', () => {
    const store = new CloudCredentialStore();
    store.setPreferredModel({ provider: 'orcarouter', model: 'z-ai/glm-5.3-flash-free', verifiedFree: true });
    expect(store.offerableModel()).toBeUndefined(); // no key yet
    store.set('orcarouter', { baseUrl: 'https://api.orcarouter.ai/v1', apiKey: 'k' });
    expect(store.offerableModel()).toEqual({ provider: 'orcarouter', model: 'z-ai/glm-5.3-flash-free', verifiedFree: true });
    store.setPreferredModel({ provider: 'orcarouter', model: 'some/paid-model', verifiedFree: false });
    expect(store.offerableModel()).toBeUndefined();
  });
});

describe('a whole chat turn on the cloud model', () => {
  let db: CoreDatabase;
  let tempDir: string;
  const credentials = new CloudCredentialStore();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-cloud-chat-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    cloudCalls = [];
    ollamaChatCalls = 0;
    credentials.clearAll();
    credentials.set('orcarouter', { baseUrl: cloudBase, apiKey: 'sk-cloud-test' });
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  async function turn(conversationId: string, text: string, selection = approvedSelection()) {
    appendMessage(db, conversationId, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const before = cloudCalls.length;
    const result = await new PiAgentEngineCtor().executeAssistantTurn({
      db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId, prompt: text, currentMessage: text,
      fenceToken: fence.token, model: 'z-ai/glm-5.3-flash-free', provider: 'orcarouter', cloud: { context: contextWith(selection), credentials },
    }).catch((error: unknown) => ({ success: false, error }));
    return { result, calls: cloudCalls.slice(before), attemptId: att.id };
  }

  it('sends the chat, the tools and the tool results to the provider with its key — and nothing to the local model', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Cloud chat' });
    const first = await turn(conv.id, 'Explain in one sentence what a hash table is.');
    expect(first.calls.length).toBe(1);
    expect(first.calls[0].auth).toBe('Bearer sk-cloud-test');
    expect(first.calls[0].model).toBe('z-ai/glm-5.3-flash-free');

    const second = await turn(conv.id, 'What date is tomorrow?');
    expect(second.calls.length).toBeGreaterThanOrEqual(2);
    // History: the earlier question and answer travel with the new message.
    expect(JSON.stringify(second.calls[0].messages)).toContain('Explain in one sentence what a hash table is.');
    expect(JSON.stringify(second.calls[0].messages)).toContain('A hash table maps keys to values.');
    // Tools are offered, and the tool's result goes back to the provider.
    expect(second.calls[0].tools).toContain('resolve_time');
    expect(second.calls[1].messages.some((m) => m.role === 'tool')).toBe(true);
    expect(listMessages(db, conv.id).at(-1)?.content).toMatch(/checked with the clock tool/);

    expect(ollamaChatCalls).toBe(0);
    const started = db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'cloud_turn_started'");
    expect(started.length).toBe(2);
    expect(JSON.parse(started[0].metadata)).toMatchObject({ provider: 'orcarouter', why: 'picked_before_chat' });
    // The key never lands in the database.
    expect(JSON.stringify(db.all('SELECT metadata FROM runtime_events'))).not.toContain('sk-cloud-test');
  }, 60_000);

  it('answers "yes" to a pending cloud offer itself, with no model call, and records the approval', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Offer' });
    const offered = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'Go ahead and build it.', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: 'offered' });
    const offeredAttempt = createAttempt(db, { requestId: offered.id, kind: 'baat_kar', actor: 'client:desktop' });
    recordRuntimeEvent(db, { domain: 'attempt', entityId: offeredAttempt.id, eventType: 'cloud_offer', actor: 'test', metadata: { provider: 'orcarouter', model: 'z-ai/glm-5.3-flash-free' } });

    appendMessage(db, conv.id, { role: 'user', content: 'yes', actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'yes', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: 'yes' });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: 'yes', currentMessage: 'yes', fenceToken: fence.token, model: 'fake-model' });

    expect(listMessages(db, conv.id).at(-1)?.content).toMatch(/Handing this to \*\*z-ai\/glm-5\.3-flash-free\*\*/);
    expect(JSON.parse(db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'cloud_offer_accepted'")!.metadata)).toMatchObject({ offerAttemptId: offeredAttempt.id, provider: 'orcarouter' });
    expect(cloudCalls.length).toBe(0);
    expect(ollamaChatCalls).toBe(0);
  }, 60_000);

  it('sends nothing when the user did not choose the cloud for this chat', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Not chosen' });
    const t = await turn(conv.id, 'Explain in one sentence what a hash table is.', approvedSelection({ cloudChatApproved: undefined }) as any);
    expect(t.calls.length).toBe(0);
    expect(ollamaChatCalls).toBe(0);
  }, 60_000);
});
