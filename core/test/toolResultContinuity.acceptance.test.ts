/**
 * P0 acceptance: Pandesh must know what it actually did — which tools ran, what they returned, which ids and files they
 * produced, whether they succeeded — on the NEXT turn, even when the assistant's reply never repeated the ids.
 *
 * Builds 163 and 164 rebuilt the model's history from user/assistant prose only, so a tool result reached a later turn
 * only if the model happened to quote it. These tests are black-box: they drive the real Pi engine, the real tools
 * (reminders, notes, the governed PC organizer behind its real approval gate, read_file) and a real SQLite database,
 * and they use only behaviour that existed in Build 163/164, so the same file runs unchanged against the baseline.
 *
 * The model is a scripted local server speaking Ollama's /api/chat. It is deliberately FAIR and FORGETFUL:
 *   - its replies after a tool result never contain an id, a path or a figure from that result;
 *   - on a follow-up it may act only on what is in the context Core sends it (system prompt + messages). If Core does
 *     not give it the id, it cannot invent one and says so.
 * So every pass below is Core supplying the right evidence; every failure is Core losing it.
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
import { getReminder } from '../domain/everydayTools';
import { getOrganizationPlan } from '../domain/fileOrganization';
import { startToolInvocation, completeToolInvocation } from '../domain/toolInvocations';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createPcOrganizerAdapter } from '../runtime/pcOrganizer';
import { buildPiCapabilityBridge } from '../runtime/piCapabilityBridge';

interface ModelCall { system: string; messages: Array<{ role: string; content: unknown; tool_calls?: any[] }>; tools: string[] }

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ID_RE = (prefix: string) => new RegExp(`\\b${prefix}_${UUID}\\b`, 'g');

let server: http.Server;
let modelCalls: ModelCall[] = [];
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
/** Per-test scripted behaviour for the user's message. */
let script: (call: ModelCall, user: string, ctxText: string) => { text?: string; tool?: { name: string; args: Record<string, unknown> } };

function textOf(content: unknown): string { return typeof content === 'string' ? content : JSON.stringify(content ?? ''); }
/** Everything Core put in front of the model for this call. */
function contextText(call: ModelCall): string { return [call.system, ...call.messages.map((m) => textOf(m.content))].join('\n'); }
function lastUser(call: ModelCall): string {
  const u = [...call.messages].reverse().find((m) => m.role === 'user');
  const raw = typeof u?.content === 'string' ? u.content : Array.isArray(u?.content) ? (u!.content as any[]).map((c) => c?.text ?? '').join(' ') : textOf(u?.content);
  // Core prefixes the message with its per-turn state block; the user's own words follow it.
  const marker = "[End of Pandesh state. The user's message follows.]";
  return (raw.includes(marker) ? raw.slice(raw.lastIndexOf(marker) + marker.length) : raw).trim();
}
function unique(xs: string[]): string[] { return [...new Set(xs)]; }
/** Core's own resolution of "that X", when it gave one. */
function resolvedId(ctx: string, prefix: string): string | null {
  const m = ctx.match(new RegExp(`RESOLVED REFERENCE:[^\\n]*?\\b(${prefix}_${UUID})`));
  return m ? m[1] : null;
}
/** A fair model's choice of id: Core's resolution, else the only id of that kind it can see, else nothing. */
function pickId(ctx: string, prefix: string): string | null {
  const r = resolvedId(ctx, prefix);
  if (r) return r;
  const ids = unique(ctx.match(ID_RE(prefix)) ?? []);
  return ids.length === 1 ? ids[0] : null;
}
const FORGETFUL_DONE = 'Done — all taken care of.';

function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body);
        const messages = payload.messages as ModelCall['messages'];
        const call: ModelCall = {
          system: String(messages.find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''),
          messages: messages.filter((m) => m.role !== 'system' && m.role !== 'developer'),
          tools: (payload.tools ?? []).map((t: any) => t.function.name),
        };
        modelCalls.push(call);
        let reply: ReturnType<typeof script>;
        try { reply = script(call, lastUser(call), contextText(call)); } catch (err) { reply = { text: `script error ${String(err)}` }; }
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (reply.tool) frame(res, { tool_calls: [{ function: { name: reply.tool.name, arguments: reply.tool.args } }] }, false);
        else frame(res, { content: reply.text ?? '' }, false);
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

describe('P0 tool-result continuity across turns (black-box, runs against Build 163/164 and the corrected build)', () => {
  let tempDir: string;
  let dbFile: string;
  let db: CoreDatabase;
  let broadcaster: EventBroadcaster;
  let decider: NodeJS.Timeout | null;
  let decision: 'approved' | 'rejected';
  const env = () => ({ ...process.env, USERPROFILE: tempDir, TEMP: path.join(tempDir, 'sys-temp'), TMP: path.join(tempDir, 'sys-temp') });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-continuity-'));
    fs.mkdirSync(path.join(tempDir, 'sys-temp'), { recursive: true });
    dbFile = path.join(tempDir, 'core.db');
    db = openDatabase(dbFile);
    runMigrations(db);
    broadcaster = new EventBroadcaster();
    modelCalls = [];
    decision = 'approved';
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try {
          resolveApproval(db, a.id, { resolution: decision, attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
        } catch { /* already decided */ }
      }
    }, 50);
  });

  afterEach(() => {
    if (decider) clearInterval(decider);
    try { db.close(); } catch { /* closed */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  function newConversation(title = 'Continuity') { return createConversation(db, { mode: 'baat_kar', actor: 'user', title }); }

  async function turn(conversationId: string, text: string, opts: { workspaceRoot?: string; organizer?: boolean } = {}) {
    appendMessage(db, conversationId, { role: 'user', content: text, actor: 'user' });
    const correlationId = `turn_${Math.random()}`;
    const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const capabilities = opts.organizer
      ? buildPiCapabilityBridge({ db, registry: new GovernedCapabilityRegistry().register(createPcOrganizerAdapter({ db, env: env() })), capabilityIds: ['pc-organizer'], correlationId: `conv_anchor_${conversationId}`, actor: 'client:desktop', clientId: 'desktop' } as any)
      : undefined;
    const before = modelCalls.length;
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster, attemptId: att.id, requestId: req.id, conversationId, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', ...(opts.workspaceRoot ? { workspaceRoot: opts.workspaceRoot } : {}), ...(capabilities ? { capabilities } : {}) } as any);
    return { result, calls: modelCalls.slice(before), att };
  }

  /** Tool calls the model made in a turn, with their arguments. */
  function callsMade(calls: ModelCall[]): Array<{ name: string; args: any }> {
    const last = calls[calls.length - 1];
    return (last?.messages ?? []).flatMap((m) => (m.tool_calls ?? []).map((tc: any) => ({ name: tc.function.name, args: tc.function.arguments }))).concat(
      // the final call of a turn that ended on a tool call is not echoed back; tool results are.
      [],
    );
  }
  function toolNamesInvoked(attemptId: string): string[] {
    return db.all<{ toolName: string }>('SELECT toolName FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt, rowid', [attemptId]).map((r) => r.toolName);
  }

  function seedFolder(name: string, files: Record<string, string>): string {
    const root = path.join(tempDir, name);
    fs.mkdirSync(root, { recursive: true });
    for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(root, f), body);
    return root;
  }

  /** Shared script pieces. Replies after a tool result are always id-free. */
  const reminderScript = (call: ModelCall, user: string, ctx: string) => {
    const last = call.messages[call.messages.length - 1];
    if (last.role === 'tool') {
      const pending = (call as any).__queue as Array<{ name: string; args: any }> | undefined;
      if (pending?.length) return { tool: pending.shift()! };
      return { text: /could not|not done|error|refused|not accessible/i.test(textOf(last.content)) ? FORGETFUL_DONE : FORGETFUL_DONE };
    }
    if (/^remind me/i.test(user)) return { tool: { name: 'create_reminder', args: { title: user.replace(/^remind me to /i, '').replace(/\.$/, ''), inMinutes: 600 } } };
    if (/dismiss/i.test(user)) {
      const typed = user.match(ID_RE('reminder'));
      const id = typed ? typed[0] : pickId(ctx, 'reminder');
      if (/AMBIGUOUS REFERENCE/.test(ctx)) return { text: 'Which reminder do you mean?' };
      if (!id) return { text: "I don't have that reminder's id, so I can't dismiss it." };
      return { tool: { name: 'dismiss_reminder', args: { id } } };
    }
    return { text: 'OK.' };
  };

  // 1 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('1. creates a plan without quoting its id, then retrieves and applies exactly that plan on the next turn', async () => {
    const inbox = seedFolder('Inbox', { 'invoice_acme.pdf': '%PDF-1.4 invoice', 'holiday.jpg': 'JPEGDATA', 'notes.txt': 'shopping list' });
    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') return { text: 'I made a plan to tidy that folder; nothing has moved yet.' };
      if (/make a plan/i.test(user)) return { tool: { name: 'pc_organize_scan', args: { roots: [inbox] } } };
      if (/apply that plan/i.test(user)) {
        const id = pickId(ctx, 'orgplan');
        return id ? { tool: { name: 'pc_organize_apply', args: { planId: id } } } : { text: "I don't have the plan's id any more." };
      }
      return { text: 'OK.' };
    };
    const conv = newConversation();
    const t1 = await turn(conv.id, `Make a plan to organize ${inbox}`, { organizer: true });
    expect(t1.result.reply).not.toMatch(ID_RE('orgplan'));
    const planId = db.get<{ id: string }>('SELECT id FROM organization_plans ORDER BY createdAt DESC LIMIT 1')!.id;

    const t2 = await turn(conv.id, 'Looks good. Apply that plan.', { organizer: true });
    expect(toolNamesInvoked(t2.att.id)).toContain('pc_organize_apply');
    const applied = db.all<{ argsSummary: string }>(`SELECT argsSummary FROM tool_invocations WHERE attemptId = ? AND toolName = 'pc_organize_apply'`, [t2.att.id]);
    expect(applied.some((r) => r.argsSummary.includes(planId))).toBe(true);
    expect(getOrganizationPlan(db, planId).status).not.toBe('proposed');
  }, 90_000);

  // 2 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('2. reads a document once and answers questions about it on later turns', async () => {
    const ws = seedFolder('docs', { 'contract.txt': 'SERVICE CONTRACT\nInvoice number: INV-58213\nDue date: 14 March 2027\nTotal amount: 4,312.90 EUR\nParties: Pandesh Test GmbH and Acme Ltd.' });
    const file = path.join(ws, 'contract.txt');
    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') {
        const t = textOf(last.content);
        if (/RECORD tinv_|Due date:|Total amount:/.test(t) && /due|total|amount/i.test(user)) {
          const due = t.match(/Due date: ([^\n\\]+)/); const total = t.match(/Total amount: ([^\n\\]+)/);
          return { text: /due/i.test(user) ? `It is due on ${due?.[1] ?? 'unknown'}.` : `The total is ${total?.[1] ?? 'unknown'}.` };
        }
        return { text: 'I read it: it is a service contract with Acme.' };
      }
      if (/^read /i.test(user)) return { tool: { name: 'read_file', args: { filePath: file } } };
      const want = /due/i.test(user) ? /Due date: ([^\n\\"]+)/ : /Total amount: ([^\n\\"]+)/;
      const found = ctx.match(want);
      if (found) return { text: /due/i.test(user) ? `It is due on ${found[1]}.` : `The total is ${found[1]}.` };
      if (call.tools.includes('recall_execution')) {
        const ref = ctx.match(/\[(tinv_[0-9a-f-]{36})\][^\n]*read_file/);
        if (ref) return { tool: { name: 'recall_execution', args: { ref: ref[1] } } };
        return { tool: { name: 'recall_execution', args: { ref: file } } };
      }
      return { text: "I don't have that document's details any more." };
    };
    const conv = newConversation();
    await turn(conv.id, `Read ${file} and tell me what it is.`, { workspaceRoot: ws });
    const t2 = await turn(conv.id, 'When is that document due?', { workspaceRoot: ws });
    expect(t2.result.reply).toContain('14 March 2027');
    const t3 = await turn(conv.id, 'And what is the total amount?', { workspaceRoot: ws });
    expect(t3.result.reply).toContain('4,312.90 EUR');
  }, 90_000);

  // 3 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('3. resumes after context compaction: the reminder made before 40 long turns is still the one acted on', async () => {
    script = reminderScript;
    const conv = newConversation();
    await turn(conv.id, 'Remind me to renew the car insurance.');
    const reminderId = db.get<{ id: string }>('SELECT id FROM everyday_reminders ORDER BY createdAt DESC LIMIT 1')!.id;
    // 40 long exchanges push the creating turn out of the bounded history window.
    for (let i = 0; i < 40; i += 1) {
      appendMessage(db, conv.id, { role: 'user', content: `Tell me more about topic ${i}. ${'context '.repeat(400)}`, actor: 'user' });
      appendMessage(db, conv.id, { role: 'assistant', content: `Here is topic ${i}. ${'detail '.repeat(400)}`, actor: 'karkedikha:pi' });
    }
    const t = await turn(conv.id, 'OK, dismiss that reminder now.');
    const firstCall = t.calls[0];
    // Compaction really dropped the creating turn from the history (the last message is this turn's own).
    expect(JSON.stringify(firstCall.messages.slice(0, -1))).not.toContain('Remind me to renew the car insurance');
    expect(firstCall.messages.length).toBeLessThan(60);
    expect(getReminder(db, reminderId).status).toBe('completed');
  }, 90_000);

  // 4 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('4. resumes after an application restart (database closed and reopened, new engine)', async () => {
    script = reminderScript;
    const conv = newConversation();
    await turn(conv.id, 'Remind me to call the plumber.');
    const reminderId = db.get<{ id: string }>('SELECT id FROM everyday_reminders ORDER BY createdAt DESC LIMIT 1')!.id;
    db.close();
    db = openDatabase(dbFile);
    runMigrations(db);
    await turn(conv.id, 'Please dismiss that reminder.');
    expect(getReminder(db, reminderId).status).toBe('completed');
  }, 90_000);

  // 5 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('5. recovers a delegated specialist\'s result and the record it created on a later turn; the child\'s private reads stay behind', async () => {
    const parent = newConversation('Chief');
    // The delegation turn as Core records it: the child's own conversation, agent run, a private read and a note it
    // created; the parent's delegate_to_agent call with the hand-off identity and the child's answer.
    const child = newConversation('Research · supplier check');
    const childReq = createRequest(db, { clientId: 'desktop', conversationId: child.id, currentMessage: 'Find the cheapest paper supplier', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'delegation', contextPolicy: { includeConversationHistory: false, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const childAtt = createAttempt(db, { requestId: childReq.id, kind: 'baat_kar', actor: 'agent:research' });
    db.run(`INSERT INTO agent_runs (requestId, agentId, agentVersion, scope, handoffId, createdAt) VALUES (?, 'research', 1, '{}', NULL, ?)`, [childReq.id, new Date().toISOString()]);
    const privRead = startToolInvocation(db, { attemptId: childAtt.id, toolName: 'read_file', argsSummary: { filePath: 'C:\\private\\salary.txt' }, actor: 'agent:research' });
    completeToolInvocation(db, privRead.id, { actor: 'agent:research', status: 'succeeded', exitCode: 0, evidence: { output: 'SECRET-SALARY 98765' }, result: { text: 'SECRET-SALARY 98765' } } as any);
    const noteText = 'Note saved (id note_11111111-2222-4333-8444-555555555555): "Paper suppliers".';
    const noteInv = startToolInvocation(db, { attemptId: childAtt.id, toolName: 'create_note', argsSummary: { title: 'Paper suppliers', body: 'Kestrel GmbH cheapest' }, actor: 'agent:research' });
    completeToolInvocation(db, noteInv.id, { actor: 'agent:research', status: 'succeeded', exitCode: 0, evidence: { output: noteText }, result: { text: noteText } } as any);

    appendMessage(db, parent.id, { role: 'user', content: 'Ask the research agent to find the cheapest paper supplier.', actor: 'user' });
    const pReq = createRequest(db, { clientId: 'desktop', conversationId: parent.id, currentMessage: 'Ask the research agent to find the cheapest paper supplier.', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `c_${Math.random()}` });
    const pAtt = createAttempt(db, { requestId: pReq.id, kind: 'baat_kar', actor: 'client:desktop' });
    const answer = `RESULT FROM THE RESEARCH AGENT (completed in 41s; its task runs in its own conversation "Research · supplier check"):\n\nThe cheapest supplier is Kestrel GmbH at 41.20 EUR per box, ahead of Brightline (44.90 EUR). I saved the comparison as a note.\n\nReport this to the user.`;
    const del = startToolInvocation(db, { attemptId: pAtt.id, toolName: 'delegate_to_agent', argsSummary: { agent: 'research', brief: 'Find the cheapest paper supplier' }, actor: 'client:desktop' });
    completeToolInvocation(db, del.id, { actor: 'client:desktop', status: 'succeeded', exitCode: 0, evidence: { output: answer.slice(0, 500) }, result: { text: answer, details: { handoffId: 'hof_99999999-8888-4777-8666-555555555555', childAttemptId: childAtt.id, agentId: 'research' } } } as any);
    appendMessage(db, parent.id, { role: 'assistant', content: 'The research agent has finished and reported back.', actor: 'karkedikha:pi' });

    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') {
        const t = textOf(last.content);
        const m = t.match(/cheapest supplier is (.+? EUR)/);
        return { text: m ? `The research agent found: ${m[1]}.` : 'I could not find it.' };
      }
      const m = ctx.match(/cheapest supplier is (.+? EUR)/);
      const note = pickId(ctx, 'note');
      if (m) return { text: `The research agent found: ${m[1]}.${note ? ` It saved note ${note}.` : ''}` };
      const hof = ctx.match(/\[(tinv_[0-9a-f-]{36})\][^\n]*delegate_to_agent/);
      if (hof && call.tools.includes('recall_execution')) return { tool: { name: 'recall_execution', args: { ref: hof[1] } } };
      return { text: "I don't know what the agent found." };
    };
    const t = await turn(parent.id, 'What did the agent find, and which note did it save?');
    expect(t.result.reply).toContain('Kestrel GmbH at 41.20 EUR');
    expect(t.result.reply).toContain('note_11111111-2222-4333-8444-555555555555');
    for (const c of t.calls) expect(contextText(c)).not.toContain('SECRET-SALARY');
  }, 90_000);

  // 6 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('6. undoes the correct previous action from recorded evidence (the latest of two applied plans, not the first)', async () => {
    const a = seedFolder('FolderA', { 'a1.pdf': '%PDF a1', 'a2.jpg': 'JPEG a2' });
    const b = seedFolder('FolderB', { 'b1.pdf': '%PDF b1', 'b2.jpg': 'JPEG b2' });
    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') return { text: FORGETFUL_DONE };
      if (/^organize (\S+)$/i.test(user)) return { tool: { name: 'pc_organize_scan', args: { roots: [user.replace(/^organize /i, '')] } } };
      if (/apply that plan/i.test(user)) { const id = pickId(ctx, 'orgplan'); return id ? { tool: { name: 'pc_organize_apply', args: { planId: id } } } : { text: 'Which plan?' }; }
      if (/^undo that/i.test(user)) {
        if (/AMBIGUOUS REFERENCE/.test(ctx)) return { text: 'Which one should I undo?' };
        const id = pickId(ctx, 'orgplan');
        return id ? { tool: { name: 'pc_organize_undo', args: { planId: id } } } : { text: "I can't tell what to undo." };
      }
      return { text: 'OK.' };
    };
    const conv = newConversation();
    await turn(conv.id, `organize ${a}`, { organizer: true });
    await turn(conv.id, 'apply that plan', { organizer: true });
    await turn(conv.id, `organize ${b}`, { organizer: true });
    await turn(conv.id, 'apply that plan', { organizer: true });
    const plans = db.all<{ id: string }>('SELECT id FROM organization_plans ORDER BY createdAt ASC');
    expect(plans).toHaveLength(2);
    const [planA, planB] = plans.map((p) => p.id);
    expect(getOrganizationPlan(db, planA).status).not.toBe('proposed');
    expect(getOrganizationPlan(db, planB).status).not.toBe('proposed');
    const undo = await turn(conv.id, 'undo that', { organizer: true });
    const undone = db.all<{ argsSummary: string }>(`SELECT argsSummary FROM tool_invocations WHERE attemptId = ? AND toolName = 'pc_organize_undo'`, [undo.att.id]);
    expect(undone).toHaveLength(1);
    expect(undone[0].argsSummary).toContain(planB); // the most recent change…
    expect(undone[0].argsSummary).not.toContain(planA); // …not the earlier one
    expect(getOrganizationPlan(db, planA).status).not.toBe('undone');
  }, 120_000);

  // 7 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('7. distinguishes similarly named items: names one by its distinguishing word, and asks when the reference fits two', async () => {
    let queued: Array<{ name: string; args: any }> = [];
    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') {
        if (queued.length) return { tool: queued.shift()! };
        return { text: 'Saved both reminders.' };
      }
      if (/two reminders/i.test(user)) {
        queued = [{ name: 'create_reminder', args: { title: 'Pay rent April', inMinutes: 900 } }];
        return { tool: { name: 'create_reminder', args: { title: 'Pay rent March', inMinutes: 600 } } };
      }
      return reminderScript(call, user, ctx);
    };
    const conv = newConversation();
    await turn(conv.id, 'Set two reminders: pay rent March and pay rent April.');
    const rows = db.all<{ id: string; title: string }>('SELECT id, title FROM everyday_reminders ORDER BY createdAt ASC');
    const march = rows.find((r) => r.title.includes('March'))!.id;
    const april = rows.find((r) => r.title.includes('April'))!.id;

    // "that reminder" fits both: nothing may be dismissed, and the user is asked which.
    const ambiguous = await turn(conv.id, 'Dismiss that reminder.');
    expect(getReminder(db, march).status).not.toBe('completed');
    expect(getReminder(db, april).status).not.toBe('completed');
    expect(ambiguous.result.reply).toMatch(/which/i);

    // "the April rent reminder" names exactly one.
    await turn(conv.id, 'Dismiss the April rent reminder you created.');
    expect(getReminder(db, april).status).toBe('completed');
    expect(getReminder(db, march).status).not.toBe('completed');
  }, 90_000);

  // 8 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('8. rejects a reference to a record that belongs to another conversation', async () => {
    script = reminderScript;
    const convA = newConversation('A');
    await turn(convA.id, 'Remind me to pick up the medical results.');
    const foreignId = db.get<{ id: string }>('SELECT id FROM everyday_reminders ORDER BY createdAt DESC LIMIT 1')!.id;

    // The naive model in conversation B acts on the id the user typed.
    const convB = newConversation('B');
    const t = await turn(convB.id, `Dismiss reminder ${foreignId}`);
    expect(getReminder(db, foreignId).status).not.toBe('completed');
    // Conversation A's results never appear in B's context.
    for (const c of t.calls) expect(contextText(c)).not.toContain('pick up the medical results');
  }, 90_000);

  // 9 ──────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('9. keeps the approval requirement on a follow-up action resolved from the journal', async () => {
    const inbox = seedFolder('Scans', { 'scan1.pdf': '%PDF s1', 'scan2.pdf': '%PDF s2' });
    script = (call, user, ctx) => {
      const last = call.messages[call.messages.length - 1];
      if (last.role === 'tool') return { text: FORGETFUL_DONE };
      if (/make a plan/i.test(user)) return { tool: { name: 'pc_organize_scan', args: { roots: [inbox] } } };
      const id = pickId(ctx, 'orgplan');
      return id ? { tool: { name: 'pc_organize_apply', args: { planId: id } } } : { text: "I don't have the plan's id." };
    };
    const conv = newConversation();
    await turn(conv.id, `Make a plan to organize ${inbox}`, { organizer: true });
    const planId = db.get<{ id: string }>('SELECT id FROM organization_plans ORDER BY createdAt DESC LIMIT 1')!.id;
    decision = 'rejected';
    const t = await turn(conv.id, 'Apply that plan.', { organizer: true });
    // The follow-up reached the real apply call with the right plan, and the gate still asked and was obeyed.
    const card = db.all<{ summary: string; status: string }>(`SELECT summary, status FROM approvals WHERE summary LIKE '%pc_organize_apply%'`);
    expect(card.length).toBeGreaterThanOrEqual(1);
    expect(card.some((c) => c.summary.includes(planId) && c.status === 'rejected')).toBe(true);
    expect(getOrganizationPlan(db, planId).status).toBe('proposed');
    expect(fs.existsSync(path.join(inbox, 'scan1.pdf'))).toBe(true);
    expect(t.result.reply).not.toMatch(/^Done/);
  }, 90_000);

  // 10 ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  it('10. a completion claim on a follow-up must match the real tool result', async () => {
    script = reminderScript; // its reply after ANY tool result is "Done — all taken care of."
    const conv = newConversation();
    await turn(conv.id, 'Remind me to send the tax form.');
    const id = db.get<{ id: string }>('SELECT id FROM everyday_reminders ORDER BY createdAt DESC LIMIT 1')!.id;
    db.run('DELETE FROM everyday_reminders WHERE id = ?', [id]); // removed elsewhere meanwhile: dismissing it now fails
    const t = await turn(conv.id, 'Dismiss that reminder.');
    const inv = db.get<{ status: string }>(`SELECT status FROM tool_invocations WHERE attemptId = ? AND toolName = 'dismiss_reminder'`, [t.att.id]);
    expect(inv?.status).toBe('failed');
    // The model said "Done"; Core must not let that stand as the turn's verdict.
    expect(t.result.reply).toMatch(/not|could not|failed|correction/i);
    expect(t.result.reply.split('\n')[0]).not.toMatch(/^Done/);
  }, 90_000);

  void callsMade;
});
