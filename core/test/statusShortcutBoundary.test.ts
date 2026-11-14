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
import { classifyStatusRequest } from '../runtime/assistantStatus';
import { TURN_STATE_CLOSE } from '../runtime/turnState';

/**
 * Build 170 installed-binary finding R02: "How many files are in the rw/inbox folder?" was answered with the canned
 * Gmail organization status — no tool call, status completed — because "inbox" counted as Gmail and "how many" as a
 * progress question. The status shortcut runs before the model, so a wrong classification there is a false completion.
 *
 * These tests drive the real request path (PiAgentEngine.executeAssistantTurn with a scripted Ollama server), not only
 * the classifier.
 */

interface ModelCall { tools: string[]; messages: Array<{ role: string; content: unknown }> }
let server: http.Server;
let modelCalls: ModelCall[] = [];
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
let workspace = '';

function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

/** A model that acts on the user's own words: lists the folder the request names, then reports what the tool returned. */
function scripted(call: ModelCall): { text?: string; tool?: { name: string; args: Record<string, unknown> } } {
  const last = call.messages[call.messages.length - 1];
  const userText = String([...call.messages].reverse().find((m) => m.role === 'user')?.content ?? '');
  if (/decoy/i.test(userText)) return last.role === 'tool' ? { text: 'There are 12 files in rw/inbox.' } : { tool: { name: 'list_directory', args: { dirPath: path.join(workspace, 'notifications') } } };
  if (last.role === 'tool') return { text: `Result: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` };
  const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  const text = raw.includes(TURN_STATE_CLOSE) ? raw.slice(raw.lastIndexOf(TURN_STATE_CLOSE) + TURN_STATE_CLOSE.length) : raw;
  if (/liar/i.test(text)) return { text: 'There are 12 files in that folder.' };
  const named = /\b(?:in|inside|under)\s+(?:the\s+)?([\w./\\-]+)\s+(?:folder|directory)\b/i.exec(text);
  if (named && call.tools.includes('list_directory')) return { tool: { name: 'list_directory', args: { dirPath: path.join(workspace, named[1]) } } };
  return { text: 'Paris.' };
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body);
        const call: ModelCall = {
          messages: (payload.messages as ModelCall['messages']).filter((m) => m.role !== 'system' && m.role !== 'developer'),
          tools: (payload.tools ?? []).map((t: any) => t.function.name),
        };
        modelCalls.push(call);
        const reply = scripted(call);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (reply.tool) frame(res, { tool_calls: [{ function: { name: reply.tool.name, arguments: reply.tool.args } }] }, false);
        else frame(res, { content: reply.text }, false);
        frame(res, {}, true);
        res.end();
        return;
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

describe('status shortcut boundary: filesystem questions are never Pandesh Gmail status (installed Build 170 R02)', () => {
  let db: CoreDatabase;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-status-boundary-'));
    workspace = path.join(tempDir, 'ws');
    fs.mkdirSync(path.join(workspace, 'rw', 'inbox'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'notifications'), { recursive: true }); fs.writeFileSync(path.join(workspace, 'notifications', 'n1.txt'), 'n');
    for (const n of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(workspace, 'rw', 'inbox', n), n);
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    modelCalls = [];
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  async function turn(conversationId: string, text: string) {
    appendMessage(db, conversationId, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const before = modelCalls.length;
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: workspace } as any);
    const events = db.all<{ eventType: string }>('SELECT eventType FROM runtime_events WHERE entityId = ?', [att.id]).map((e) => e.eventType);
    const tools = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [att.id]);
    return { result, calls: modelCalls.slice(before), events, tools };
  }

  it('answers "How many files are in the rw/inbox folder?" by listing the folder, not with the Gmail status', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'R02' });
    const t = await turn(conv.id, 'How many files are in the rw/inbox folder?');
    expect(t.events).not.toContain('assistant_status_answered');
    expect(t.result.reply).not.toMatch(/Gmail organization|recorded state/i);
    expect(t.calls.length).toBeGreaterThan(0);
    expect(t.tools.some((x) => x.toolName === 'list_directory' && /succe|complet/i.test(x.status))).toBe(true);
    expect(t.result.reply).toMatch(/"fileCount":\s*3/);
  });

  it.each([
    'How many files are in the C:\\Users\\me\\Documents\\inbox folder?',
    'how many emails.txt files are left in the inbox directory',
    'Show the update status of the mail-sync repo folder',
    'What is the progress of the files in rw/inbox?',
  ])('does not turn the filesystem question %j into a Gmail status', async (text) => {
    expect(classifyStatusRequest(text, true)).toBeNull();
  });

  it('a folder question the model answers without reading is corrected, not left as a completed answer', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'liar' });
    const t = await turn(conv.id, 'How many files are in the liar folder?');
    expect(t.result.reply).toMatch(/Correction: nothing was read from the disk/);
    expect(t.events).toContain('disk_observation_missing');
  });

  it('listing an unrelated folder does not observe rw/inbox: the invented count is corrected, not completed', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'decoy' });
    const t = await turn(conv.id, 'decoy: how many files are in the rw/inbox folder?');
    expect(t.tools.some((x) => x.toolName === 'list_directory')).toBe(true);
    expect(t.events).toContain('disk_observation_missing');
    expect(t.result.reply).toMatch(/no successful read in this turn covered "rw\/inbox"/);
  });

  it('a read of the named folder (relative or absolute) counts as the observation', async () => {
    const { observationCoversRequest } = await import('../runtime/diskObservation');
    expect(observationCoversRequest('How many files are in the rw/inbox folder?', [{ args: { dirPath: path.join(workspace, 'rw', 'inbox') } }]).covered).toBe(true);
    expect(observationCoversRequest('How many files are in the rw/inbox folder?', [{ args: { dirPath: workspace } }]).covered).toBe(false);
    expect(observationCoversRequest('Count the files in rw\inbox', [{ args: { dirPath: 'rw/inbox' } }]).covered).toBe(true);
    expect(observationCoversRequest('What is in the events folder?', [{ args: { dirPath: path.join(workspace, 'events') } }]).covered).toBe(true);
    expect(observationCoversRequest('What is in the events folder?', [{ args: { dirPath: path.join(workspace, 'calendar') } }]).covered).toBe(false);
    expect(observationCoversRequest('Read docs/notes.txt', [{ args: { filePath: path.join(workspace, 'docs', 'notes.txt') } }]).covered).toBe(true);
    expect(observationCoversRequest('How many files are in my workspace?', [{ args: { dirPath: workspace } }]).covered).toBe(true);
  });

  it('a failed folder read is reported as not observed', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'missing' });
    const t = await turn(conv.id, 'How many files are in the rw/outbox folder?');
    expect(t.events).not.toContain('assistant_status_answered');
    expect(t.events).toContain('disk_observation_missing');
    expect(t.result.reply).toMatch(/Correction: nothing was read/);
  });

  it('keeps genuine Gmail progress questions on the recorded-state shortcut (no model, no tool)', async () => {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'gmail status' });
    const t = await turn(conv.id, 'How far along is the Gmail organization?');
    expect(t.events).toContain('assistant_status_answered');
    expect(t.calls.length).toBe(0);
    expect(t.result.reply).toMatch(/Gmail organization/);
  });
});

describe('review findings: evidence must be OF the named folder, and status questions are not over-declined', () => {
  it('only a read of the named folder or file observes it', async () => {
    const { observationCoversRequest: cov, namedDiskTargets } = await import('../runtime/diskObservation');
    const ask = 'How many files are in the inbox folder?';
    expect(cov(ask, [{ args: { dirPath: 'D:/ws/inbox' } }]).covered).toBe(true);
    expect(cov(ask, [{ args: { dirPath: 'D:/ws/inbox/sub/deep' } }]).covered).toBe(false); // a sub-folder is not the folder
    expect(cov(ask, [{ args: { filePath: 'D:/ws/inbox/mail.txt' } }]).covered).toBe(false); // one file is not a count
    expect(cov(ask, [{ args: { dirPath: 'D:/ws/old-inbox' } }]).covered).toBe(false);
    expect(cov('How many files are in rw/inbox?', [{ args: { dirPath: 'rw/inbox/../outbox' } }]).covered).toBe(false);
    expect(cov(ask, [{ args: { dirPath: 'D:/ws/outbox', content: 'see /inbox/' } }]).covered).toBe(false); // content is not a path
    expect(cov(ask, [{ args: { dirPath: 'D:/ws', pattern: 'inbox' } }]).covered).toBe(false); // a search pattern is not a path
    expect(cov(String.raw`What's in C:\Temp?`, [{ args: { dirPath: 'D:/other' } }]).covered).toBe(false);
    expect(cov(String.raw`What's in C:\Temp?`, [{ args: { dirPath: 'C:/Temp' } }]).covered).toBe(true);
    expect(cov('How many items are in the folder inbox?', [{ args: { dirPath: 'D:/other' } }]).covered).toBe(false);
    // not targets: alternatives, dates, urls, a path's own tail
    expect(namedDiskTargets('How many files and/or folders are in rw/inbox on 11/14?')).toEqual(['rw/inbox']);
    expect(namedDiskTargets('See https://example.com/x and a/b.txt')).toEqual(['a/b.txt']);
  });

  it('conceptual questions are not disk questions; genuine status questions are not declined', async () => {
    const { asksForDiskObservation } = await import('../runtime/assistantStatus');
    for (const q of ['What is a directory?', 'What is the difference between a file and a folder?', 'How do I list files in Python?', 'Which drive is faster, SSD or NVMe?']) expect(asksForDiskObservation(q)).toBe(false);
    expect(asksForDiskObservation('How many files are in rw/inbox?')).toBe(true);
    for (const q of ['Status of the Gmail drive cleanup?', 'Gmail/Calendar status?', 'email/notification status', 'status of the Q3/Q4 email labelling']) expect(classifyStatusRequest(q, true), q).not.toBeNull();
    for (const q of ['how many docs are in my Inbox dir status', 'how many files are in the Inbox directory?']) expect(classifyStatusRequest(q, true), q).toBeNull();
  });
});
