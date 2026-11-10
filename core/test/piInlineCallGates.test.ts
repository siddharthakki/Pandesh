/**
 * Build 161 audit, section 4: a tool call recovered from a small model's JSON text meets exactly the gates a native
 * call meets. Through the real engine: a missing argument gets the agent loop's validation feedback and runs nothing;
 * a complete write still needs the user's approval, and a declined card writes nothing — the same as the same call
 * sent natively.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';

/** What the fake model answers first: a call written as text, or the same call sent natively. Afterwards it says "Done." */
let first: { inline: string } | { native: { name: string; arguments: Record<string, unknown> } } = { inline: '' };
const requests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: string[] }> = [];
let server: http.Server;
let previousUrl: string | undefined;
let Engine: typeof import('../runtime/piAgentEngine').PiAgentEngine;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url?.startsWith('/api/chat')) { res.writeHead(req.url?.startsWith('/api/generate') ? 200 : 404); res.end('{}'); return; }
      const payload = JSON.parse(body);
      const messages = (payload.messages ?? []).filter((m: { role: string }) => m.role !== 'system');
      requests.push({ messages, tools: (payload.tools ?? []).map((t: { function: { name: string } }) => t.function.name) });
      const answered = messages.some((m: { role: string }) => m.role === 'tool');
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const frame = (message: Record<string, unknown>, done: boolean) => res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', eval_count: 1 } : {}) })}\n`);
      if (answered) frame({ content: 'Done.' }, false);
      else if ('inline' in first) frame({ content: first.inline }, false);
      else frame({ tool_calls: [{ function: first.native }] }, false);
      frame({}, true);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Engine = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise((r) => server.close(() => r(undefined)));
});

let dir: string;
let ws: string;
let db: CoreDatabase;
let decider: NodeJS.Timeout | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inline-gates-'));
  ws = path.join(dir, 'project');
  fs.mkdirSync(ws);
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  requests.length = 0;
  // The user declines every card.
  decider = setInterval(() => {
    for (const a of listPendingApprovals(db)) {
      try {
        resolveApproval(db, a.id, { resolution: 'rejected', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
      } catch { /* resolved meanwhile */ }
    }
  }, 50);
});

afterEach(() => {
  if (decider) clearInterval(decider);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function turn(text: string) {
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Inline gates' });
  appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
  const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
  const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
  await new Engine().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, workspaceRoot: ws, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
  return att.id;
}

const toolResults = () => requests.flatMap((r) => r.messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content)));
const cards = (attemptId: string) => db.all<{ status: string }>('SELECT status FROM approvals WHERE attemptId = ?', [attemptId]);

describe('a recovered inline call meets the same gates as a native call', () => {
  it('a missing argument gets validation feedback the model can act on; nothing is written and no card is raised', async () => {
    first = { inline: '{"name": "write_file", "arguments": {"content": "hello"}}' };
    const attemptId = await turn(`Write a file notes.md saying hello in ${ws}`);
    expect(requests[0].tools).toContain('write_file');
    expect(toolResults().join('\n')).toMatch(/Validation failed for tool \\?"write_file\\?"/);
    expect(toolResults().join('\n')).toMatch(/filePath/);
    expect(cards(attemptId)).toEqual([]);
    expect(fs.readdirSync(ws)).toEqual([]);
  }, 60_000);

  for (const form of ['inline', 'native'] as const) {
    it(`a complete write (${form}) asks the user, and a declined card writes nothing`, async () => {
      const call = { name: 'write_file', arguments: { filePath: path.join(ws, 'notes.md'), content: 'hello' } };
      first = form === 'inline' ? { inline: JSON.stringify(call) } : { native: call };
      const attemptId = await turn(`Write a file notes.md saying hello in ${ws}`);
      expect(cards(attemptId).map((c) => c.status)).toEqual(['rejected']);
      expect(fs.existsSync(path.join(ws, 'notes.md'))).toBe(false);
    }, 60_000);
  }
});
