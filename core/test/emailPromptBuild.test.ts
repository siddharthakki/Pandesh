/**
 * Regression for Build 195 (found on the installed app, not by unit tests): a request that offers the Gmail tools builds
 * the Gmail prompt section, and an const used there before its declaration crashed every email turn
 * ("Cannot access 'needsContractRules' before initialization") while the attempt stayed "running" for ever.
 *
 * Runs a real engine turn with a stub Gmail bridge against a fake Ollama and checks what the model was sent: the Gmail
 * reading tools and the general search guidance, without the coding/workspace rules, the contract rules or the drafting tools.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';

let server: http.Server;
let previousUrl: string | undefined;
let Engine: any;
const sent: Array<{ system: string; tools: string[] }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (!req.url?.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
      const payload = JSON.parse(body);
      const system = (payload.messages as Array<{ role: string; content: unknown }>).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => String(m.content)).join('\n');
      sent.push({ system, tools: ((payload.tools ?? []) as Array<{ function?: { name?: string } }>).map((t) => String(t.function?.name)) });
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: 'I searched your mail for Acme and found nothing about damage.' }, done: false })}\n`);
      res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 14 })}\n`);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Engine = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise<void>((r) => server.close(() => r()));
});

const def = (name: string, tier: 'read' | 'draft') => ({ name, description: `${name} stub`, parameters: { type: 'object', properties: {} }, tier });

describe('an email request builds its prompt and offers only the reading tools', () => {
  it('completes, and the model is sent search guidance without coding, contract or drafting overhead', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-emailprompt-'));
    const db = openDatabase(path.join(dir, 'core.db'));
    runMigrations(db);
    try {
      const text = 'Is there any email from Acme about damage or charges?';
      const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Mail' });
      appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
      const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` });
      const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
      const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
      const connectors = {
        definitions: [def('gmail_search', 'read'), def('gmail_read_thread', 'read'), def('gmail_read_attachment', 'read'), def('gmail_create_draft', 'draft')],
        dispatch: async () => ({ status: 'succeeded', output: '{}' }),
        describeServices: () => ['- Gmail: connected'],
      };
      const result = await new Engine().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', connectors } as any);
      expect(String(result?.reply)).toMatch(/found nothing about damage/);
      const first = sent[0];
      expect(first.tools).toEqual(expect.arrayContaining(['gmail_search', 'gmail_read_thread']));
      expect(first.tools).not.toContain('gmail_create_draft');
      expect(first.system).toMatch(/Finding mail: search for the thing the user named/);
      expect(first.system).not.toMatch(/Gmail contract extraction/);
      expect(first.system).not.toMatch(/WORKSPACE AWARENESS/);
    } finally {
      try { db.close(); } catch { /* closed */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }, 60_000);
});
