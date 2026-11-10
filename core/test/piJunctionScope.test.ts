/**
 * Build 161 audit, section 5: a junction inside the workspace that points elsewhere does not widen what Pandesh may
 * read. Pi's file tools authorized a path by its spelling, so ws\link\private.txt (link -> a folder outside) was read
 * without asking. Now the real location decides: reading through such a junction asks the user, naming the real
 * folder, and a declined card reads nothing. An ordinary file — or another spelling of the workspace — reads unasked.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as cp from 'node:child_process';
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

const CANARY = 'PRIVATE_OUTSIDE_CANARY_7731';
let firstCall: { name: string; arguments: Record<string, unknown> } = { name: 'read_file', arguments: {} };
const toolResults: string[] = [];
let server: http.Server;
let previousUrl: string | undefined;
let Engine: typeof import('../runtime/piAgentEngine').PiAgentEngine;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url?.startsWith('/api/chat')) { res.writeHead(req.url?.startsWith('/api/generate') ? 200 : 404); res.end('{}'); return; }
      const messages = (JSON.parse(body).messages ?? []) as Array<{ role: string; content: unknown }>;
      const results = messages.filter((m) => m.role === 'tool').map((m) => JSON.stringify(m.content));
      if (results.length) toolResults.push(...results);
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      const frame = (message: Record<string, unknown>, done: boolean) => res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', eval_count: 1 } : {}) })}\n`);
      frame(results.length ? { content: 'Done.' } : { tool_calls: [{ function: firstCall }] }, false);
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
let outside: string;
let db: CoreDatabase;
let decider: NodeJS.Timeout | null = null;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-junction-'));
  ws = path.join(dir, 'project');
  outside = path.join(dir, 'outside');
  fs.mkdirSync(ws);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, 'inside.txt'), 'INSIDE_CONTENT_42');
  fs.writeFileSync(path.join(outside, 'private.txt'), CANARY);
  fs.symlinkSync(outside, path.join(ws, 'link'), 'junction');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  toolResults.length = 0;
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

async function turn(call: { name: string; arguments: Record<string, unknown> }) {
  firstCall = call;
  const text = 'Show me what is in that file.';
  const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Junction scope' });
  appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
  const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
  const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
  const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
  await new Engine().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, workspaceRoot: ws, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
  return db.all<{ status: string; summary: string }>('SELECT status, summary FROM approvals WHERE attemptId = ?', [att.id]);
}

describe.runIf(process.platform === 'win32')('a junction inside the workspace does not widen what is read', () => {
  it('reading through a junction that points outside asks first, names the real folder, and reads nothing when declined', async () => {
    const cards = await turn({ name: 'read_file', arguments: { filePath: path.join(ws, 'link', 'private.txt') } });
    expect(cards.map((c) => c.status)).toEqual(['rejected']);
    expect(cards[0].summary).toContain(path.basename(outside));
    expect(cards[0].summary).not.toContain(path.join(ws, 'link').replace(/\\/g, '\\\\'));
    expect(toolResults.join('\n')).not.toContain(CANARY);
  }, 60_000);

  it('listing through that junction asks too', async () => {
    const cards = await turn({ name: 'list_directory', arguments: { dirPath: path.join(ws, 'link') } });
    expect(cards.map((c) => c.status)).toEqual(['rejected']);
    expect(toolResults.join('\n')).not.toContain('private.txt');
  }, 60_000);

  it('an ordinary file in the workspace is read without a card', async () => {
    const cards = await turn({ name: 'read_file', arguments: { filePath: path.join(ws, 'inside.txt') } });
    expect(cards).toEqual([]);
    expect(toolResults.join('\n')).toContain('INSIDE_CONTENT_42');
  }, 60_000);

  it('the same file under another spelling of the workspace (8.3 name) is read without a card', async () => {
    let short = ws;
    try {
      short = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${ws.replace(/'/g, "''")}').ShortPath`], { encoding: 'utf8', windowsHide: true }).trim();
    } catch { /* keep the long name */ }
    if (short.toLowerCase() === ws.toLowerCase()) return; // 8.3 names disabled on this volume
    const cards = await turn({ name: 'read_file', arguments: { filePath: path.join(short, 'inside.txt') } });
    expect(cards).toEqual([]);
    expect(toolResults.join('\n')).toContain('INSIDE_CONTENT_42');
  }, 60_000);
});
