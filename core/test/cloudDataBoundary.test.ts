/**
 * Private-data boundary for cloud chat turns (audit 2026-11-12, SEC-2): a private document read during a cloud
 * conversation must never become an unexamined external disclosure. A scripted OpenAI-compatible provider stands in
 * for the cloud and records every byte it receives; markers planted in local-only places must never reach it.
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
import { appendMessage, createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { startModelInvocation, completeModelInvocation } from '../domain/modelInvocations';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import { CLOUD_SAFE_TOOLS, cloudVisibleHistory, isCloudProvider, partitionCloudTools } from '../runtime/cloudDataBoundary';

describe('cloud data boundary rules', () => {
  it('withholds every tool that is not known to be safe, including tools nobody classified', () => {
    const { allowed, withheld } = partitionCloudTools([{ name: 'calculate' }, { name: 'read_file' }, { name: 'gmail_search' }, { name: 'memory_recall' }, { name: 'brand_new_tool' }, { name: 'web_research' }]);
    expect(allowed.map((t) => t.name)).toEqual(['calculate', 'web_research']);
    expect(withheld).toEqual(['read_file', 'gmail_search', 'memory_recall', 'brand_new_tool']);
    for (const name of ['read_file', 'list_directory', 'search_files', 'write_file', 'run_checks', 'memory_recall', 'personal_overview', 'list_tasks', 'gmail_read_thread', 'calendar_list_events', 'search_second_brain', 'desktop_screenshot', 'get_system_info', 'recall_execution']) {
      expect(CLOUD_SAFE_TOOLS.has(name)).toBe(false);
    }
  });

  it('shows a cloud model only the exchanges that already ran on a cloud model', () => {
    const msgs = [
      { role: 'user', provider: null, content: 'local q' },
      { role: 'assistant', provider: 'ollama', content: 'local a' },
      { role: 'user', provider: null, content: 'cloud q' },
      { role: 'assistant', provider: 'orcarouter', content: 'cloud a' },
    ];
    expect(cloudVisibleHistory(msgs)).toEqual({ kept: msgs.slice(2), withheld: 2 });
    // An answer of unknown origin (Core's own notice, an old record) counts as local: fail closed.
    expect(cloudVisibleHistory([{ role: 'user', provider: null }, { role: 'assistant', provider: null }]).withheld).toBe(2);
    expect(cloudVisibleHistory([{ role: 'user', provider: 'orcarouter' }]).withheld).toBe(0);
    expect(isCloudProvider('hermes')).toBe(false);
    expect(isCloudProvider('ollama')).toBe(false);
    expect(isCloudProvider('orcarouter')).toBe(true);
  });
});

interface CloudCall { body: string; tools: string[] }
let cloud: http.Server;
let ollama: http.Server;
let cloudCalls: CloudCall[] = [];
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
      cloudCalls.push({ body, tools: (payload.tools ?? []).map((t: any) => t.function.name) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sse(res, { role: 'assistant', content: 'That needs a local model; I cannot see your files here.' }, null);
      sse(res, {}, 'stop');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  ollama = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
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

const selection = {
  requiredCapabilities: {}, candidates: [], escalationCandidates: [], selectedProvider: 'orcarouter', selectedModel: 'z-ai/glm-5.3-flash-free',
  selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, routingPolicy: 'explicit-cloud',
  cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' }, cloudChatApproved: true, cloudChatSource: 'approved_offer',
};
const cloudContext = { selectedProvider: 'orcarouter', selectedModel: 'z-ai/glm-5.3-flash-free', modelSelection: selection } as any;

describe('a cloud turn in a chat that holds private data', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let workspace: string;
  const credentials = new CloudCredentialStore();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-cloud-boundary-'));
    workspace = path.join(tempDir, 'ws');
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(workspace, 'private.txt'), 'SECRET-FILE-CONTENT bank 12345');
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Notes\nSECRET-PROJECT-NOTES deploy key lives in vault');
    fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'demo', scripts: { start: 'node SECRET-START-SCRIPT.js' } }));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    cloudCalls = [];
    credentials.clearAll();
    credentials.set('orcarouter', { baseUrl: cloudBase, apiKey: 'sk-cloud-test' });
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function newAttempt(conversationId: string, text: string) {
    appendMessage(db, conversationId, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
    return { req, att };
  }

  /** An earlier LOCAL turn whose reply quotes a private file, recorded the way a local Pi turn records it. */
  function localTurn(conversationId: string) {
    const { att } = newAttempt(conversationId, 'What is in private.txt?');
    const mi = startModelInvocation(db, { attemptId: att.id, requestedProvider: 'ollama', requestedModel: 'gemma4:12b', policyModel: 'gemma4:12b', actor: 'test' });
    completeModelInvocation(db, mi.id, { status: 'succeeded', actualProvider: 'ollama', actualModel: 'gemma4:12b', actor: 'test' });
    appendMessage(db, conversationId, { role: 'assistant', content: 'It says SECRET-LOCAL-REPLY bank 12345.', actor: 'core', modelInvocationId: mi.id } as any);
  }

  async function cloudTurn(conversationId: string, text: string) {
    const { req, att } = newAttempt(conversationId, text);
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    await new PiAgentEngineCtor().executeAssistantTurn({
      db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId, prompt: text, currentMessage: text,
      workspaceRoot: workspace, fenceToken: fence.token, model: 'z-ai/glm-5.3-flash-free', provider: 'orcarouter', cloud: { context: cloudContext, credentials },
    } as any).catch(() => undefined);
    return att.id;
  }

  it('sends no private tool, no earlier local turn and no project notes to the cloud model', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'Private chat' });
    localTurn(conv.id);
    const attemptId = await cloudTurn(conv.id, 'Read private.txt again and tell me the account number.');

    expect(cloudCalls.length).toBeGreaterThan(0);
    const sent = cloudCalls.map((c) => c.body).join('\n');
    expect(sent).not.toContain('SECRET-LOCAL-REPLY');
    expect(sent).not.toContain('SECRET-FILE-CONTENT');
    expect(sent).not.toContain('SECRET-PROJECT-NOTES');
    expect(sent).toContain('PRIVATE DATA BOUNDARY');
    for (const call of cloudCalls) for (const tool of call.tools) expect(CLOUD_SAFE_TOOLS.has(tool)).toBe(true);

    const withheld = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'cloud_history_withheld'", [attemptId]);
    expect(JSON.parse(withheld!.metadata)).toMatchObject({ provider: 'orcarouter', withheldMessages: 2 });
    // The audit trail names the provider the turn really went to.
    const mi = db.get<{ requestedProvider: string; actualProvider: string }>('SELECT requestedProvider, actualProvider FROM model_invocations WHERE attemptId = ?', [attemptId]);
    expect(mi).toMatchObject({ requestedProvider: 'orcarouter', actualProvider: 'orcarouter' });
  }, 60_000);

  it('answers a project question locally instead of sending the project files to the cloud model', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'Project' });
    await cloudTurn(conv.id, 'How do I run this project?');
    const sent = cloudCalls.map((c) => c.body).join('\n');
    expect(sent).not.toContain('SECRET-START-SCRIPT');
    expect(sent).not.toContain('SECRET-PROJECT-NOTES');
  }, 60_000);
});
