/**
 * Private-data boundary for cloud chat turns (audit 2026-11-12, SEC-2): a private document read during a cloud
 * conversation must never become an unexamined external disclosure. A scripted OpenAI-compatible provider stands in
 * for the cloud and records every byte it receives; markers planted in local-only places must never reach it.
 *
 * The second round covers the routes the independent verification of #78 found (L2-L6): earlier local tool results
 * through the journal and `recall_execution`, an unanswered local turn, earlier requests in the task sections, Core's
 * local fallbacks, and local paths in the prompt. Attachments (L1) are covered in attachmentExecution.test.ts.
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
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { CloudCredentialStore } from '../runtime/cloudCredentials';
import { CLOUD_SAFE_TOOLS, cloudVisibleHistory, isCloudProvider, partitionCloudTools, scrubLocalPaths } from '../runtime/cloudDataBoundary';

describe('cloud data boundary rules', () => {
  it('withholds every tool that is not known to be safe, including tools nobody classified', () => {
    const { allowed, withheld } = partitionCloudTools([{ name: 'calculate' }, { name: 'read_file' }, { name: 'gmail_search' }, { name: 'memory_recall' }, { name: 'brand_new_tool' }, { name: 'web_research' }]);
    expect(allowed.map((t) => t.name)).toEqual(['calculate', 'web_research']);
    expect(withheld).toEqual(['read_file', 'gmail_search', 'memory_recall', 'brand_new_tool']);
    for (const name of ['read_file', 'list_directory', 'search_files', 'write_file', 'run_checks', 'memory_recall', 'personal_overview', 'list_tasks', 'gmail_read_thread', 'calendar_list_events', 'search_second_brain', 'desktop_screenshot', 'get_system_info', 'recall_execution', 'delegate_to_agent']) {
      expect(CLOUD_SAFE_TOOLS.has(name)).toBe(false);
    }
  });

  it('shows a cloud model only messages that came from cloud model calls, and the user messages they answered', () => {
    const cloudIds = new Set(['mi_cloud1', 'mi_cloud2']);
    const isCloud = (id: string) => cloudIds.has(id);
    const msgs = [
      { role: 'user' }, { role: 'assistant', modelInvocationId: 'mi_local' }, // a local exchange
      { role: 'user' }, // a local turn that never got a reply
      { role: 'user' }, { role: 'assistant', modelInvocationId: 'mi_cloud1' }, // a cloud exchange
      { role: 'assistant', modelInvocationId: null }, // a routine / background / Core-composed post
      { role: 'user' }, { role: 'assistant' }, // a Core-composed answer during a cloud attempt
      { role: 'user' }, { role: 'assistant', modelInvocationId: 'mi_cloud2' },
    ];
    expect(cloudVisibleHistory(msgs, isCloud)).toEqual({ kept: [msgs[3], msgs[4], msgs[8], msgs[9]], withheld: 6 });
    expect(cloudVisibleHistory(msgs, () => false).withheld).toBe(10); // no cloud origin known: nothing goes
    expect(isCloudProvider('hermes')).toBe(false);
    expect(isCloudProvider('orcarouter')).toBe(true);
  });

  it('scrubs the selected folder and the home folder from text bound for a cloud model', () => {
    const text = 'Folder C:\\Users\\alice\\Projects\\shop, notes at c:/users/alice/projects/shop/a.md, home C:\\Users\\alice\\Desktop';
    const out = scrubLocalPaths(text, { workspace: 'C:\\Users\\alice\\Projects\\shop', home: 'C:\\Users\\alice' });
    expect(out).not.toMatch(/alice/i);
    expect(out).toContain('the selected folder');
    expect(out).toContain('~\\Desktop');
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
      const sawTool = (payload.messages ?? []).some((m: any) => m.role === 'tool');
      if (!sawTool && body.includes('TRY-PRIVATE-TOOLS')) {
        // A cloud model that tries to reach local data anyway, with tools it was not offered.
        sse(res, { role: 'assistant', tool_calls: [
          { index: 0, id: 'call_1', type: 'function', function: { name: 'recall_execution', arguments: '{"ref":"listing"}' } },
          { index: 1, id: 'call_2', type: 'function', function: { name: 'list_directory', arguments: '{"dirPath":"."}' } },
        ] }, null);
        sse(res, {}, 'tool_calls');
      } else {
        sse(res, { role: 'assistant', content: 'That needs a local model; I cannot see your files here.' }, null);
        sse(res, {}, 'stop');
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  ollama = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"models":[{"name":"inventory-marker-n8:latest"}]}'); });
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
  cloudSpend: { mode: 'FREE_ONLY', modelFreeness: 'free' }, cloudChatApproved: true, cloudChatSource: 'picked_before_chat',
};
const cloudContext = { selectedProvider: 'orcarouter', selectedModel: 'z-ai/glm-5.3-flash-free', modelSelection: selection } as any;

describe('a cloud turn in a chat that holds private data', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let workspace: string;
  const credentials = new CloudCredentialStore();

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-cloud-boundary-'));
    workspace = path.join(tempDir, 'ws-PATH-MARKER-X1');
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

  /** An earlier LOCAL turn: it listed the folder (a "normal" journal tool) and its reply quotes a private file. */
  function localTurn(conversationId: string) {
    const { att } = newAttempt(conversationId, 'LOCALQ-MARKER-U6: what is in private.txt and in this folder?');
    const ti = startToolInvocation(db, { attemptId: att.id, toolName: 'list_directory', argsSummary: { dirPath: workspace }, actor: 'test' });
    completeToolInvocation(db, ti.id, { status: 'succeeded', evidence: { output: JSON.stringify({ directory: workspace, items: [{ name: 'MARKER-FILENAME-Z9.txt' }, { name: 'private.txt' }] }) }, actor: 'test' } as any);
    const mi = startModelInvocation(db, { attemptId: att.id, requestedProvider: 'ollama', requestedModel: 'gemma4:12b', policyModel: 'gemma4:12b', actor: 'test' });
    completeModelInvocation(db, mi.id, { status: 'succeeded', actualProvider: 'ollama', actualModel: 'gemma4:12b', actor: 'test' });
    appendMessage(db, conversationId, { role: 'assistant', content: 'It says SECRET-LOCAL-REPLY bank 12345.', actor: 'core', modelInvocationId: mi.id } as any);
    // A local turn that never got a reply (it waited for an approval).
    newAttempt(conversationId, 'Remember that my locker code is MEMORY-MARKER-M3.');
    // A background job / routine posting into the chat after the local turns (no model call behind it).
    appendMessage(db, conversationId, { role: 'assistant', content: 'Gmail contract inventory: BG-MARKER-G1 Acme lease 1,200 EUR', actor: 'kkd:background' });
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

  const MARKERS = ['SECRET-LOCAL-REPLY', 'SECRET-FILE-CONTENT', 'SECRET-PROJECT-NOTES', 'SECRET-START-SCRIPT', 'MARKER-FILENAME-Z9', 'LOCALQ-MARKER-U6', 'MEMORY-MARKER-M3', 'PATH-MARKER-X1', 'inventory-marker-n8', 'BG-MARKER-G1'];

  it('sends no earlier local result, request, path or notes, and runs no private tool even when the cloud model asks', async () => {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'Private chat' });
    localTurn(conv.id);
    const first = await cloudTurn(conv.id, 'TRY-PRIVATE-TOOLS Read private.txt again and tell me the account number.');
    // Core answers this one itself from package.json during a cloud attempt (verification round 2, L7) ...
    await cloudTurn(conv.id, 'How do I run this project?');
    // ... and that locally composed answer must not travel with the next cloud turn.
    const second = await cloudTurn(conv.id, 'Which models are installed on this PC?');

    expect(cloudCalls.length).toBeGreaterThan(1);
    const sent = cloudCalls.map((c) => c.body).join('\n');
    for (const marker of MARKERS) expect(sent, marker).not.toContain(marker);
    expect(sent).toContain('PRIVATE DATA BOUNDARY');
    for (const call of cloudCalls) for (const tool of call.tools) expect(CLOUD_SAFE_TOOLS.has(tool), tool).toBe(true);

    // What actually RAN on the cloud turns: nothing outside the safe set succeeded.
    const ran = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId IN (?, ?)', [first, second]);
    for (const r of ran) if (r.status === 'succeeded') expect(CLOUD_SAFE_TOOLS.has(r.toolName), r.toolName).toBe(true);
    // Core's local fallbacks stayed off on the cloud turn.
    expect(db.get("SELECT 1 FROM runtime_events WHERE entityId = ? AND eventType LIKE '%fallback_invoked'", [second])).toBeUndefined();
    const withheld = db.get<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'cloud_history_withheld'", [first]);
    expect(JSON.parse(withheld!.metadata).withheldMessages).toBeGreaterThanOrEqual(3);
    const mi = db.get<{ requestedProvider: string; actualProvider: string }>('SELECT requestedProvider, actualProvider FROM model_invocations WHERE attemptId = ?', [first]);
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
