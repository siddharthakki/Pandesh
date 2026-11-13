/**
 * M1 acceptance through the real Pi engine (audit S21): the scripted "model" writes five of six analyses plus an index that
 * links to all six, then claims everything exists. The verdict must come from the file system, not from that sentence.
 *
 *   A. after Core's single "still missing" nudge the model creates the sixth file  -> completed, result `completed`
 *   B. the model does not                                                           -> partial, attempt failed "Partly done:",
 *      the lead line says PARTLY DONE, the final verification records passed:false, result `partial`
 *   C. a request that names no deliverable and a turn that only talked is untouched (no false partials)
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
import { deriveResultStatus } from '../domain/resultStatus';

interface ModelCall { messages: Array<{ role: string; content: unknown; tool_calls?: any[] }>; tools: string[] }
type Reply = { text?: string; tool?: { name: string; args: Record<string, unknown> } };

let server: http.Server; let previousUrl: string | undefined; let PiAgentEngineCtor: any;
let script: (call: ModelCall, user: string, toolResults: number) => Reply;
const textOf = (c: unknown): string => (typeof c === 'string' ? c : JSON.stringify(c ?? ''));
function lastUser(call: ModelCall): string {
  const u = [...call.messages].reverse().find((m) => m.role === 'user');
  const raw = textOf(u?.content);
  const marker = "[End of Pandesh state. The user's message follows.]";
  return (raw.includes(marker) ? raw.slice(raw.lastIndexOf(marker) + marker.length) : raw).trim();
}
function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''; req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body); const messages = payload.messages as ModelCall['messages'];
        const call: ModelCall = { messages: messages.filter((m) => m.role !== 'system' && m.role !== 'developer'), tools: (payload.tools ?? []).map((t: any) => t.function.name) };
        const lastMessage = call.messages[call.messages.length - 1];
        let reply: Reply; try { reply = script(call, lastUser(call), call.messages.filter((m) => m.role === 'tool').length); } catch (err) { reply = { text: `script error ${String(err)}` }; }
        void lastMessage;
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

const S21 = 'Analyze each of the six files in the inbox folder. For every source file write analysis/<source name>.analysis.md (3 to 5 lines), and also write analysis/index.md that lists and links all six analyses. Tell me when all seven files exist.';
const NAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

describe('deliverable ledger through the real Pi engine', () => {
  let tempDir: string; let ws: string; let db: CoreDatabase; let decider: NodeJS.Timeout;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ledger-pi-')); ws = path.join(tempDir, 'ws'); fs.mkdirSync(path.join(ws, 'inbox'), { recursive: true });
    for (const n of NAMES) fs.writeFileSync(path.join(ws, 'inbox', `${n}.txt`), `source ${n}`);
    db = openDatabase(path.join(tempDir, 'core.db')); runMigrations(db);
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch { /* decided */ }
      }
    }, 50);
  });
  afterEach(() => { clearInterval(decider); try { db.close(); } catch { /* closed */ } try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ } });

  async function turn(text: string) {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'user', title: 'ledger' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'user_prompt',
      toolPermissionPolicy: { profile: 'local-core-question', worker: 'local-core', workspaceAccess: 'read_write' },
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` } as any);
    const att = createAttempt(db, { requestId: req.id, kind: 'saath_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: ws } as any);
    return { att, result, reply: String(result?.reply ?? '') };
  }
  const writes = (n: number): Reply => ({ tool: { name: 'write_file', args: { filePath: n < 5 ? `analysis/${NAMES[n]}.analysis.md` : 'analysis/index.md', content: n < 5 ? `analysis of ${NAMES[n]}` : NAMES.map((x) => `- [${x}](${x}.analysis.md)`).join('\n') } } });

  it('B. the model claims all seven exist but never writes the sixth analysis: PARTIAL, attempt failed, verification not passed', async () => {
    script = (call, user, toolResults) => {
      if (/Deliverable check by Pandesh/.test(textOf(call.messages[call.messages.length - 1]?.content)) || /Deliverable check by Pandesh/.test(user)) return { text: 'I could not create f.analysis.md.' };
      if (toolResults < 6) return writes(toolResults);
      return { text: 'All six analyses and the index were created in the analysis folder.' };
    };
    const { att, reply } = await turn(S21);
    const events = db.all<{ eventType: string; metadata: string }>("SELECT eventType, metadata FROM runtime_events WHERE entityId = ? AND eventType IN ('deliverables_missing','deliverable_ledger','final_verification_recorded')", [att.id]);
    expect(events.some((e) => e.eventType === 'deliverables_missing' && /f\.analysis\.md/.test(e.metadata))).toBe(true);
    const verification = events.filter((e) => e.eventType === 'final_verification_recorded').map((e) => JSON.parse(e.metadata));
    expect(verification.at(-1)).toMatchObject({ passed: false, verdict: 'partial' });
    expect(reply).toMatch(/PARTLY DONE/);
    expect(reply).toMatch(/links to f\.analysis\.md/);
    expect(getAttempt(db, att.id).status).toBe('failed');
    expect(deriveResultStatus(db, att.id)).toMatchObject({ status: 'partial' });
    expect(fs.existsSync(path.join(ws, 'analysis', 'f.analysis.md'))).toBe(false);
  }, 60_000);

  it('A. after the single nudge the model creates the missing file: nothing partial, result completed', async () => {
    let nudged = false;
    script = (call, user, toolResults) => {
      const lastText = textOf(call.messages[call.messages.length - 1]?.content);
      if (/Deliverable check by Pandesh/.test(lastText) || /Deliverable check by Pandesh/.test(user)) { nudged = true; }
      if (nudged && !fs.existsSync(path.join(ws, 'analysis', 'f.analysis.md'))) return { tool: { name: 'write_file', args: { filePath: 'analysis/f.analysis.md', content: 'analysis of f' } } };
      if (nudged) return { text: 'Created f.analysis.md. All seven files now exist.' };
      if (toolResults < 6) return writes(toolResults);
      return { text: 'All six analyses and the index were created in the analysis folder.' };
    };
    const { att, reply } = await turn(S21);
    expect(fs.existsSync(path.join(ws, 'analysis', 'f.analysis.md'))).toBe(true);
    expect(reply).not.toMatch(/PARTLY DONE/);
    expect(getAttempt(db, att.id).status).toBe('completed');
    expect(deriveResultStatus(db, att.id).status).toBe('completed');
  }, 60_000);

  it('C. a turn that only answers a question is never judged partial', async () => {
    script = () => ({ text: 'The inbox holds six source files.' });
    const { att } = await turn('How many files are in the inbox folder?');
    expect(deriveResultStatus(db, att.id).status).toBe('completed');
  }, 60_000);
});
