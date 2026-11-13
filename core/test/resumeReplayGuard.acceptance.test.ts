/**
 * M2 acceptance through the real Pi engine: a task interrupted by a restart is resumed as a successor attempt, told what the
 * journal says was already done, and can never repeat a consequential call that attempt already made.
 *
 *   1. attempt 1 writes a.txt (journalled), then "dies": it is failed `Interrupted:` and a started-but-unfinished write of
 *      b.txt is left pending (the process died mid-call)
 *   2. resume -> successor of the same request; its prompt carries ALREADY DONE (a.txt) and STARTED BUT OUTCOME UNKNOWN (b.txt)
 *   3. the resumed model re-emits write a.txt (identical)  -> blocked: replay_prevented kind=done, the file is not rewritten
 *      and re-emits write b.txt (identical)               -> blocked: kind=unknown, told to check the real state first
 *      writes c.txt                                       -> runs normally
 *   4. a cancelled task and a completed task are not resumable
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
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt, getAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { getAttemptContext } from '../domain/attemptContext';
import { startToolInvocation } from '../domain/toolInvocations';
import { deriveResultStatus } from '../domain/resultStatus';
import { listTaskOverview } from '../domain/taskOverview';
import { resumeInterruptedAttempt, resumeGuidance, summarizeForResume } from '../runtime/resumeAttempt';

interface ModelCall { messages: Array<{ role: string; content: unknown }>; system: string }
type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };
let server: http.Server; let previousUrl: string | undefined; let PiAgentEngineCtor: any;
let script: (call: ModelCall, toolResults: number) => Reply; let calls: ModelCall[] = [];
const textOf = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
const frame = (res: http.ServerResponse, message: Record<string, unknown>, done: boolean) => res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body); const messages = payload.messages as ModelCall['messages'];
        const call: ModelCall = { system: textOf(messages.find((m) => m.role === 'system')?.content), messages: messages.filter((m) => m.role !== 'system' && m.role !== 'developer') };
        calls.push(call);
        let reply: Reply; try { reply = script(call, call.messages.filter((m) => m.role === 'tool').length); } catch (err) { reply = { text: `script error ${String(err)}` }; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (reply.tool) frame(res, { tool_calls: [{ function: { name: reply.tool.name, arguments: reply.tool.args } }] }, false); else frame(res, { content: reply.text ?? '' }, false);
        frame(res, {}, true); res.end(); return;
      }
      res.writeHead(404); res.end();
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

describe('resume after an interruption, with a replay guard', () => {
  let tempDir: string; let ws: string; let db: CoreDatabase; let decider: NodeJS.Timeout;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-resume-')); ws = path.join(tempDir, 'ws'); fs.mkdirSync(ws, { recursive: true });
    db = openDatabase(path.join(tempDir, 'core.db')); runMigrations(db); calls = [];
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch { /* decided */ }
      }
    }, 50);
  });
  afterEach(() => { clearInterval(decider); try { db.close(); } catch { /* closed */ } try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  const PROMPT = 'Create a.txt, b.txt and c.txt in this folder, each containing its own letter.';
  async function runAttempt(attemptId: string, requestId: string, conversationId: string, prompt = PROMPT) {
    const fence = acquireFence(db, attemptId, { owner: 'test', actor: 'test' });
    return new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId, requestId, conversationId, prompt, currentMessage: PROMPT, fenceToken: fence.token, model: 'fake-model', workspaceRoot: ws } as any);
  }
  function startTask() {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'resume' });
    appendMessage(db, conv.id, { role: 'user', content: PROMPT, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: PROMPT, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt',
      toolPermissionPolicy: { profile: 'local-core-question', worker: 'local-core', workspaceAccess: 'read_write' },
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` } as any);
    const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
    return { conv, req, att };
  }
  const events = (attemptId: string, type: string) => db.all<{ metadata: string }>('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ?', [attemptId, type]).map((e) => JSON.parse(e.metadata));

  it('resumes, tells the model what is done, and refuses identical repeats', async () => {
    const { conv, req, att } = startTask();
    // attempt 1: writes a.txt, then the process "dies" with a started-but-unfinished write of b.txt
    script = (_c, n) => (n === 0 ? { tool: { name: 'write_file', args: { filePath: 'a.txt', content: 'a' } } } : { text: 'Wrote a.txt.' });
    await runAttempt(att.id, req.id, conv.id);
    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('a');
    startToolInvocation(db, { attemptId: att.id, toolName: 'write_file', argsSummary: { content: 'b', filePath: 'b.txt' }, actor: 'test' }); // never completed
    db.run("UPDATE attempts SET status = 'failed', failureReason = 'Interrupted: KarkeDikha restarted while this task was running. It was not replayed automatically.' WHERE id = ?", [att.id]);
    expect(deriveResultStatus(db, att.id).status).toBe('interrupted');

    // Nothing resumes by itself: the task is listed as resumable (the Resume button), and stays untouched until the owner presses it.
    const listed = () => listTaskOverview(db, 50).find((r) => r.attemptId === att.id);
    expect(listed()?.resultStatus).toBe('interrupted');
    expect(listed()?.resumable).toBe(true);
    expect(db.get('SELECT 1 FROM attempts WHERE predecessorAttemptId = ?', [att.id])).toBeFalsy();

    const summary = summarizeForResume(db, att.id);
    expect(summary.done.join('\n')).toMatch(/write_file/);
    expect(summary.unknown.join('\n')).toMatch(/b\.txt/);
    expect(resumeGuidance(summary)).toMatch(/ALREADY DONE[\s\S]*STARTED BUT OUTCOME UNKNOWN/);

    const successor = resumeInterruptedAttempt(db, att.id, 'test');
    expect(successor.predecessorAttemptId).toBe(att.id);
    expect(resumeInterruptedAttempt(db, att.id, 'test').id).toBe(successor.id); // idempotent
    expect(listed()?.resumable).toBe(false); // already continued

    // the resumed model re-emits a.txt and b.txt (same args, other key order), then writes c.txt
    fs.writeFileSync(path.join(ws, 'a.txt'), 'a-before-resume-marker');
    // crash between the side effect and the journal commit: b.txt IS on disk although its invocation never completed
    fs.writeFileSync(path.join(ws, 'b.txt'), 'b');
    calls = [];
    script = (_c, n) => n === 0 ? { tool: { name: 'write_file', args: { content: 'a', filePath: 'a.txt' } } }
      : n === 1 ? { tool: { name: 'write_file', args: { content: 'b', filePath: 'b.txt' } } }
      : n === 2 ? { tool: { name: 'write_file', args: { filePath: 'c.txt', content: 'c' } } } : { text: 'a.txt existed already; I did not rewrite it. c.txt is created. b.txt needs a check.' };
    // The executor prefixes the request with the successor's stored guidance (executor.ts: retryGuidance + attempt_escalated).
    const guidance = getAttemptContext(db, successor.id).retryGuidance;
    expect(guidance).toMatch(/INTERRUPTED[\s\S]*ALREADY DONE/);
    const { reply } = await runAttempt(successor.id, req.id, conv.id, `${guidance}

The request:
${PROMPT}`) as { reply: string };

    expect(calls[0].messages.map((m) => textOf(m.content)).join('\n')).toMatch(/INTERRUPTED[\s\S]*ALREADY DONE[\s\S]*write_file/);
    const prevented = events(successor.id, 'replay_prevented');
    expect(prevented.map((p) => p.kind).sort()).toEqual(['done', 'unknown']);
    expect(prevented.find((p) => p.kind === 'unknown')?.inPlace).toBe(true); // reconciled against the real file   // a.txt: journal says done (and the file was edited since: never clobbered)
    expect(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8')).toBe('a-before-resume-marker'); // not rewritten
    expect(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8')).toBe('b');                        // already in place: not written again
    expect(db.all("SELECT 1 FROM tool_invocations WHERE attemptId = ? AND toolName = 'write_file' AND argsSummary LIKE '%b.txt%'", [successor.id])).toHaveLength(0);
    expect(fs.readFileSync(path.join(ws, 'c.txt'), 'utf8')).toBe('c');                        // new work ran
    expect(typeof reply).toBe('string');
    expect(getAttempt(db, successor.id).status).not.toBe('running');
  }, 90_000);

  it("a reworded repeat of a consequential action is caught by meaning; an unknown outcome is settled by Core's own records", async () => {
    const { conv, req, att } = startTask();
    script = (_c, n) => (n === 0 ? { tool: { name: 'create_reminder', args: { title: 'Call Dr. Keller about the invoice', date: '2026-11-20', time: '09:00' } } } : { text: 'Reminder created.' });
    await runAttempt(att.id, req.id, conv.id);
    expect(db.all('SELECT 1 FROM everyday_reminders')).toHaveLength(1);
    // two calls were started and never finished: a note that DID land in Core's store, and a promise that did not
    startToolInvocation(db, { attemptId: att.id, toolName: 'create_note', argsSummary: { title: 'Parking', body: 'Ask the city office about parking permits before Friday' }, actor: 'test' });
    db.run("INSERT INTO everyday_notes (id, title, body, createdAt, updatedAt) VALUES ('n1', 'Parking', 'Ask the city office about parking permits before Friday', ?, ?)", [new Date().toISOString(), new Date().toISOString()]);
    startToolInvocation(db, { attemptId: att.id, toolName: 'create_commitment', argsSummary: { title: 'Send the signed contract to Priya' }, actor: 'test' });
    db.run("UPDATE attempts SET status = 'failed', failureReason = 'Interrupted: KarkeDikha restarted while this task was running. It was not replayed automatically.' WHERE id = ?", [att.id]);
    const successor = resumeInterruptedAttempt(db, att.id, 'test');
    script = (_c, n) => n === 0 ? { tool: { name: 'create_reminder', args: { title: 'call dr keller about invoice', dueAt: new Date('2026-11-20T09:01').toISOString() } } }
      : n === 1 ? { tool: { name: 'create_note', args: { title: 'parking', body: 'Ask the city office about the parking permits before Friday.' } } }
      : n === 2 ? { tool: { name: 'create_commitment', args: { title: 'Send signed contract to Priya' } } } : { text: 'Done as far as possible.' };
    await runAttempt(successor.id, req.id, conv.id);
    const prevented = events(successor.id, 'replay_prevented');
    expect(prevented.map((p) => `${p.toolName}:${p.kind}`).sort()).toEqual(['create_note:done', 'create_reminder:done']);
    expect(db.all('SELECT 1 FROM everyday_reminders')).toHaveLength(1); // not created twice
    expect(db.all('SELECT 1 FROM everyday_notes')).toHaveLength(1);     // the note that landed was recognised, not duplicated
    expect(db.all('SELECT 1 FROM commitments')).toHaveLength(1);        // the promise that never landed ran once
  }, 90_000);

  it('does not resume a cancelled or a completed task', () => {
    const a = startTask().att; db.run("UPDATE attempts SET status = 'cancelled' WHERE id = ?", [a.id]);
    expect(() => resumeInterruptedAttempt(db, a.id, 'test')).toThrow(/stopped/);
    const b = startTask().att; db.run("UPDATE attempts SET status = 'completed' WHERE id = ?", [b.id]);
    expect(() => resumeInterruptedAttempt(db, b.id, 'test')).toThrow(/cannot be resumed/);
  });
});
