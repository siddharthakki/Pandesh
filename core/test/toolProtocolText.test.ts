import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelToolDefinition } from '../runtime/modelBackend';
import { recoverInlineToolCalls } from '../runtime/modelBackend';
import { validateNativeToolCalls } from '../runtime/inlineToolCalls';
import { projectAssistantText } from '../runtime/toolProtocolText';

const tools: ModelToolDefinition[] = [
  { name: 'read_file', description: 'x', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

describe('tool-protocol markup is never presented as the final answer', () => {
  it('A: a valid native tool call passes the unit gate and is not text', () => {
    expect(validateNativeToolCalls([{ name: 'read_file', arguments: { path: 'a.ts' } }], tools)).toBeNull();
  });

  it('B: a valid inline <tool_call>-wrapped call is still recovered for execution (M49.2 unchanged)', () => {
    const reply = '<tool_call>{"name":"read_file","arguments":{"path":"a.ts"}}</tool_call>';
    expect(recoverInlineToolCalls(reply, tools)).toEqual({ kind: 'calls', calls: [{ name: 'read_file', arguments: { path: 'a.ts' } }] });
    const xml = '<tool_call>\n<function=read_file>\n<parameter=path>\na.ts\n</parameter>\n</function>\n</tool_call>';
    expect(recoverInlineToolCalls(xml, tools)).toEqual({ kind: 'calls', calls: [{ name: 'read_file', arguments: { path: 'a.ts' } }] });
  });

  it('C: an unusable <tool_call> block is not executed and is stripped from the answer', () => {
    // Not a recognised tool, and not JSON: nothing may run, and nothing may be shown as the answer.
    const unknown = '<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"}}</tool_call>';
    expect(recoverInlineToolCalls(unknown, tools).kind).toBe('failure');
    expect(projectAssistantText(unknown)).toEqual({ text: '', strippedProtocol: true });

    const freeform = '<tool_call>Read(a.ts)</tool_call>';
    expect(recoverInlineToolCalls(freeform, tools).kind).toBe('none');
    expect(projectAssistantText(freeform)).toEqual({ text: '', strippedProtocol: true });

    const truncated = 'Let me look.\n<tool_call>\n<function=Read>\n<parameter=path>a.ts';
    expect(projectAssistantText(truncated)).toEqual({ text: 'Let me look.', strippedProtocol: true });
  });

  it('D: a tool call followed by valid prose keeps only the prose', () => {
    const reply = '<tool_call>{"name":"Read","arguments":{}}</tool_call>\n\nThe function parses the config and returns it.';
    expect(projectAssistantText(reply)).toEqual({ text: 'The function parses the config and returns it.', strippedProtocol: true });
  });

  it('leaves legitimate prose, other angle brackets and code regions untouched', () => {
    for (const text of [
      'Use Array<string> and a < b > c; <div>hi</div>.',
      'The model wraps calls in `<tool_call>` tags.',
      'Example:\n```xml\n<tool_call>\n<function=read_file></function>\n</tool_call>\n```\nThat is the format.',
    ]) {
      expect(projectAssistantText(text)).toEqual({ text, strippedProtocol: false });
    }
  });
});

describe('Baat Kar final-answer projection (production executor)', () => {
  const TOKEN = generateToken();
  let dir: string;
  let db: CoreDatabase;
  let api: RunningApiServer;
  let ws: { close(): void };
  let baseUrl: string;
  let reply = '';

  const backend: ModelBackend = {
    async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
      return { content: reply, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    },
  };

  let n = 0;
  const authedFetch = (p: string, init: RequestInit & { key?: string } = {}) => fetch(`${baseUrl}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.key ? { 'Idempotency-Key': init.key } : {}) },
  });
  const json = async (res: Response) => { expect(res.ok).toBe(true); return res.json(); };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-toolmarkup-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    const broadcaster = new EventBroadcaster();
    api = await startApiServer({
      db, token: TOKEN, broadcaster, dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: { backend, defaultModel: 'qwen2.5-coder:1.5b', dataDir: dir },
    });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;
  });
  afterEach(async () => { ws.close(); await api.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  async function runTurn(modelReply: string) {
    reply = modelReply;
    const message = 'Explain what that file does.';
    const conv = await json(await authedFetch('/v1/conversations', { method: 'POST', key: `tp-${++n}`, body: JSON.stringify({ mode: 'baat_kar' }) }));
    await json(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', key: `tp-${++n}`, body: JSON.stringify({ role: 'user', content: message }) }));
    const req = await json(await authedFetch('/v1/requests', {
      method: 'POST', key: `tp-${++n}`,
      body: JSON.stringify({ currentMessage: message, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test', conversationId: conv.id, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false } }),
    }));
    const attempt = await json(await authedFetch('/v1/attempts', { method: 'POST', key: `tp-${++n}`, body: JSON.stringify({ requestId: req.id, kind: 'baat_kar' }) }));
    await authedFetch(`/v1/attempts/${attempt.id}/execute`, { method: 'POST', key: `tp-${++n}` });
    const deadline = Date.now() + 5000;
    for (;;) {
      const a = await (await authedFetch(`/v1/attempts/${attempt.id}`)).json();
      if (a.status === 'completed' || a.status === 'failed') {
        const messages = (await (await authedFetch(`/v1/conversations/${conv.id}/messages`)).json()).messages;
        return { attempt: a, assistant: messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content as string) };
      }
      if (Date.now() > deadline) throw new Error(`attempt never finished; last=${a.status}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('a reply that is only <tool_call> markup fails honestly and persists no assistant text', async () => {
    const { attempt, assistant } = await runTurn('<tool_call>\n<function=Read>\n<parameter=file_path>\nsrc/a.ts\n</parameter>\n</function>\n</tool_call>');
    expect(attempt.status).toBe('failed');
    expect(assistant.join('\n')).not.toMatch(/tool_call|<function=/);
  });

  it('markup followed by real prose persists only the prose', async () => {
    const { attempt, assistant } = await runTurn('<tool_call>{"name":"Read","arguments":{"file_path":"a.ts"}}</tool_call>\nIt loads the config.');
    expect(attempt.status).toBe('completed');
    expect(assistant).toEqual(['It loads the config.']);
  });

  it('ordinary prose with angle brackets is persisted unchanged', async () => {
    const { attempt, assistant } = await runTurn('It returns Array<string> when a < b.');
    expect(attempt.status).toBe('completed');
    expect(assistant).toEqual(['It returns Array<string> when a < b.']);
  });
});
