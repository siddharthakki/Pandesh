/**
 * Regression: a tool's raw receipt must never become the user-visible reply.
 *
 * CI flake (personalContinuity "I. phone → desktop", PR #75 / #76 first runs, 2026-11-12): after add_task succeeded,
 * the model call that should have written "Done." failed at the transport (status=error, 1 ms). The empty-reply retry
 * skips turns with completed tools, the tool-free synthesis answer was too short to count, and the last fallback pasted
 * the raw add_task receipt — internal proj_…/ptask_… ids included — into the chat.
 *
 * The fake model server here drops the connection on the call after the tool result, which reproduces that path every
 * time instead of once in a few CI runs.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';

type Msg = { role: string; content: unknown };

let server: http.Server;
let previousUrl: string | undefined;
let PiAgentEngineCtor: any;
/** How many model calls made after the tool result should fail at the transport before one answers. */
let failuresAfterTool = 0;
let callsAfterTool = 0;

function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (!req.url?.startsWith('/api/chat')) { res.writeHead(404); res.end(); return; }
      const payload = JSON.parse(body);
      const messages = (payload.messages as Msg[]).filter((m) => m.role !== 'system' && m.role !== 'developer');
      const tools = (payload.tools ?? []) as unknown[];
      const last = messages[messages.length - 1];
      if (last?.role === 'tool') {
        callsAfterTool += 1;
        // The CI failure: the connection drops before any response header (fetch failed, status=error, ~1 ms).
        if (callsAfterTool <= failuresAfterTool) { req.socket.destroy(); return; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        frame(res, { content: 'Done.' }, false); frame(res, {}, true); res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      // The tool-free evidence synthesis gets a short, useless answer — as the scripted model in CI gave ("OK.").
      if (tools.length === 0) frame(res, { content: 'OK.' }, false);
      else frame(res, { tool_calls: [{ function: { name: 'add_task', arguments: { title: 'Book the tasting kitchen for Mueller', project: 'Catering', createProject: true } } }] }, false);
      frame(res, {}, true);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  previousUrl = process.env.KARKEDIKHA_OLLAMA_URL;
  process.env.KARKEDIKHA_OLLAMA_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('a tool receipt never becomes the reply', () => {
  let tempDir: string;
  let db: CoreDatabase;
  let decider: NodeJS.Timeout | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-receipt-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    callsAfterTool = 0;
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch { /* decided */ }
      }
    }, 50);
  });

  afterEach(() => {
    if (decider) clearInterval(decider);
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  async function addTaskTurn() {
    const text = 'Add a task: book the tasting kitchen for Mueller';
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Catering' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'mobile', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:mobile' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' } as any);
    const tools = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [att.id]);
    return { reply: String(result?.reply ?? ''), tools };
  }

  it('a model call that fails once after the tool result is retried, and the model\'s own answer is the reply', async () => {
    failuresAfterTool = 1;
    const { reply, tools } = await addTaskTurn();
    expect(tools.filter((t) => t.toolName === 'add_task').map((t) => t.status)).toEqual(['succeeded']);
    expect(reply).toBe('Done.');
    expect(callsAfterTool).toBe(2);
  }, 60_000);

  it('when the model never answers after the tool, the reply says what was done without internal ids', async () => {
    failuresAfterTool = 99;
    const { reply, tools } = await addTaskTurn();
    expect(tools.filter((t) => t.toolName === 'add_task').map((t) => t.status)).toEqual(['succeeded']);
    expect(reply).not.toMatch(/ptask_|proj_[0-9a-f]/);
    expect(reply).toMatch(/Added task "Book the tasting kitchen for Mueller" \[pending, no due date\] in Catering\./);
  }, 60_000);
});

describe('withoutInternalRecordIds', () => {
  it('drops ref parentheticals and bare record ids, keeps the rest of the receipt', async () => {
    const { withoutInternalRecordIds } = await import('../runtime/piAgentEngine');
    const ref = 'proj_15ba7d3d-3568-496d-a030-08f5ea7b87aa/ptask_63de0672-e049-4f02-9424-5f404c6a11f5';
    expect(withoutInternalRecordIds(`Added task "Book it" [pending, no due date] in Catering (ref ${ref}). It is shown under Spaces → Projects.`))
      .toBe('Added task "Book it" [pending, no due date] in Catering. It is shown under Spaces → Projects.');
    expect(withoutInternalRecordIds('Saved as artifact_0f8d2c1e-1111-4222-8333-444455556666.')).toBe('Saved as.');
    expect(withoutInternalRecordIds('Order (ref 4471) is open; see (id: none).')).toBe('Order (ref 4471) is open; see (id: none).');
    expect(withoutInternalRecordIds('Moved to ptask_interview.')).toBe('Moved to ptask_interview.');
  });
});
