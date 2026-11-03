import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage, listMessages } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { updateTaskOutcome } from '../domain/taskOutcomes';
import type { PowerShellRunner } from '../runtime/windowsPrinting';

/**
 * Isolated reproduction of the P0 sequence: Gmail contract extraction -> weather -> device discovery -> print a test
 * page on the Brother printer -> an unrelated question. A scripted local server speaking Ollama's native /api/chat stands in for Ollama
 * and records the context the engine assembles for every model call; a fake PowerShell runner stands in for the Windows
 * spooler. Nothing here touches a real printer, the owner's profile or the network.
 */

interface ModelCall { system: string; messages: Array<{ role: string; content: unknown }>; tools: string[] }

const CONTRACT_TABLE = '| Contract Type | Company / Counterparty | Date | Email / Thread Reference | Attachment | Extraction Status |\n| NDA | Acme Corp | 2026-01-02 | thread-aaa | nda.pdf | confirmed |';

let server: http.Server;
let modelCalls: ModelCall[] = [];
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;

/** One frame of Ollama's native /api/chat NDJSON stream (Pi's transport, see piOllamaNativeFetch). */
function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

function scriptedReply(call: ModelCall): { text?: string; tool?: { name: string; args: string } } {
  const last = call.messages[call.messages.length - 1];
  if (last.role === 'tool') {
    const prior = [...call.messages].reverse().find((m) => m.role === 'assistant' && Array.isArray((m as any).tool_calls)) as any;
    const name = prior?.tool_calls?.[prior.tool_calls.length - 1]?.function?.name;
    if (name === 'list_printers') return { tool: { name: 'print_test_page', args: '{}' } };
    return { text: `Result: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` };
  }
  const text = JSON.stringify(last.content).toLowerCase();
  if (text.includes('test page') && call.tools.includes('list_printers')) return { tool: { name: 'list_printers', args: '{}' } };
  if (text.includes('weather')) return { text: 'It is 18C and cloudy in Paris.' };
  if (text.includes('devices')) return { text: 'I can list the installed printers.' };
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
        const messages = payload.messages as ModelCall['messages'];
        const call: ModelCall = {
          system: String(messages.find((m) => m.role === 'system' || m.role === 'developer')?.content ?? ''),
          messages: messages.filter((m) => m.role !== 'system' && m.role !== 'developer'),
          tools: (payload.tools ?? []).map((t: any) => t.function.name),
        };
        modelCalls.push(call);
        const reply = scriptedReply(call);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (reply.tool) frame(res, { tool_calls: [{ function: { name: reply.tool.name, arguments: JSON.parse(reply.tool.args) } }] }, false);
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

describe('P0 conversation relevance and real-action reliability (isolated sequence)', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let broadcaster: EventBroadcaster;
  let submits: number;
  let approver: NodeJS.Timeout;
  let autoApprove: boolean;

  /** Fake Windows spooler: one Brother printer; a submitted test page appears as job 7 once, then clears. */
  const runner: PowerShellRunner = async (script) => {
    if (script.includes('Win32_Printer | Where-Object')) {
      return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify([{ Name: 'Brother HL-L2350DW series', Driver: 'Brother HL-L2350DW', Port: 'WSD-1', Status: 3, WorkOffline: false, Default: true }, { Name: 'Microsoft Print to PDF', Driver: 'PDF', Port: 'PORTPROMPT:', Status: 3, WorkOffline: false, Default: false }]) };
    }
    if (script.includes('PrintTestPage')) { submits += 1; return { code: 0, timedOut: false, stderr: '', stdout: 'RETURN=0' }; }
    if (script.includes('Get-PrintJob')) {
      const jobs = submits > 0 && jobsPolled++ === 0 ? [{ Id: 7, Status: 'Printing' }] : [];
      return { code: 0, timedOut: false, stderr: '', stdout: JSON.stringify({ Jobs: jobs, PrinterStatus: 3, Offline: false }) };
    }
    return { code: 1, timedOut: false, stderr: 'unexpected script', stdout: '' };
  };
  let jobsPolled: number;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-relevance-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    broadcaster = new EventBroadcaster();
    modelCalls = [];
    submits = 0;
    jobsPolled = 0;
    autoApprove = true;
    approver = setInterval(() => {
      if (!autoApprove) return;
      for (const a of listPendingApprovals(db)) {
        try {
          resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
        } catch {}
      }
    }, 100);
  });

  afterEach(() => {
    clearInterval(approver);
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function seedGmailConversation() {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'Sequence' });
    const earlier = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'Extract the contracts from my Gmail', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `seed_${Math.random()}` });
    const earlierAttempt = createAttempt(db, { requestId: earlier.id, kind: 'baat_kar', actor: 'client:desktop' });
    appendMessage(db, conv.id, { role: 'user', content: 'Find the contracts in my Gmail and tabulate them', actor: 'user' });
    appendMessage(db, conv.id, { role: 'assistant', content: `Here is the Contract Inventory:\n${CONTRACT_TABLE}`, actor: 'karkedikha:pi' });
    // The Gmail workflow was left open (partial): exactly the state that used to leak into every later turn.
    updateTaskOutcome(db, { attemptId: earlierAttempt.id, conversationId: conv.id, requestId: earlier.id, objective: 'Extract the contracts from my Gmail', status: 'partial', nextAction: 'inspect remaining Gmail threads', summary: 'Found 1 NDA so far' });
    return conv;
  }

  async function turn(conversationId: string, text: string, signal?: AbortSignal) {
    appendMessage(db, conversationId, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const before = modelCalls.length;
    const engine = new PiAgentEngineCtor();
    const result = await engine.executeAssistantTurn({ db, broadcaster, attemptId: att.id, requestId: req.id, conversationId, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', signal, powerShellRunner: runner });
    return { result, calls: modelCalls.slice(before), req, att };
  }

  it('does not replay the Gmail conversation into unrelated turns, and prints once with truthful status', async () => {
    const conv = seedGmailConversation();

    const weather = await turn(conv.id, 'What is the weather in Paris?');
    const devices = await turn(conv.id, 'Discover the connected PC devices');
    const printer = await turn(conv.id, 'Print a test page on the Brother printer');
    const unrelated = await turn(conv.id, 'What is the capital of France?');

    // 1. No stale workflow is offered to any of the unrelated turns.
    for (const t of [weather, devices, printer, unrelated]) {
      for (const call of t.calls) expect(call.system).not.toContain('ACTIVE WORKFLOW IN THIS CONVERSATION');
    }

    // 2. The latest request is authoritative and the old contract table is not in the unrelated turn's context.
    expect(unrelated.calls[0].system).toMatch(/most recent message|LATEST REQUEST IS AUTHORITATIVE/);
    expect(printer.calls[0].system).toContain('LATEST REQUEST IS AUTHORITATIVE');
    expect(JSON.stringify(unrelated.calls[0].messages)).not.toContain('Contract Inventory');
    expect(unrelated.result.reply).not.toContain('Contract Type');
    expect(unrelated.result.reply).toContain('Paris');

    // 3. Correct tool selection: inventory via the printer tool, not run_checks.
    const toolNames = printer.calls.slice(-1).flatMap((c) => c.messages.flatMap((m: any) => (m.tool_calls ?? []).map((tc: any) => tc.function.name)));
    expect(toolNames).toEqual(['list_printers', 'print_test_page']);
    expect(toolNames).not.toContain('run_checks');

    // 4. Exactly one physical submission, bounded, with the spooler outcome reported truthfully.
    expect(submits).toBe(1);
    expect(printer.result.reply).toContain('COMPLETED');
    expect(printer.result.reply).toContain('Brother HL-L2350DW series');
    expect(printer.result.reply).toMatch(/cannot confirm paper/i);

    // 5. Evidence is recorded: device inventory and print submission.
    const events = db.all<{ eventType: string; metadata: string }>(`SELECT eventType, metadata FROM runtime_events WHERE eventType IN ('printer_inventory','print_test_page_submitting','print_test_page_result')`);
    expect(events.map((e) => e.eventType)).toEqual(['printer_inventory', 'print_test_page_submitting', 'print_test_page_result']);
    expect(db.all(`SELECT id FROM approvals WHERE summary LIKE '%print_test_page%'`).length).toBe(1);
  }, 60_000);

  it('does not print a second page when the same request is retried or recovered', async () => {
    const conv = seedGmailConversation();
    const first = await turn(conv.id, 'Print a test page on the Brother printer');
    expect(submits).toBe(1);

    // Recovery / retry: a new attempt for the SAME request id runs the tool again.
    appendMessage(db, conv.id, { role: 'user', content: 'Print a test page on the Brother printer', actor: 'user' });
    // A recovered attempt is a NEW attempt row for the same request (the original attempt id is already terminal).
    const att2 = { id: 'att_recovered_1' };
    const now = new Date().toISOString();
    db.run(`INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, revision) VALUES (?, ?, 'baat_kar', 'created', ?, ?, 1)`, [att2.id, first.req.id, now, now]);
    const fence2 = acquireFence(db, att2.id, { owner: 'test', actor: 'test' });
    const retry = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster, attemptId: att2.id, requestId: first.req.id, conversationId: conv.id, prompt: 'Print a test page on the Brother printer', currentMessage: 'Print a test page on the Brother printer', fenceToken: fence2.token, model: 'fake-model', powerShellRunner: runner });

    expect(submits).toBe(1);
    expect(retry.reply).toMatch(/already submitted/i);
    expect(db.all(`SELECT id FROM runtime_events WHERE eventType = 'print_test_page_duplicate_blocked'`).length).toBe(1);
  }, 60_000);

  it('prints nothing when the operator declines', async () => {
    autoApprove = false;
    const conv = seedGmailConversation();
    const rejecter = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: 'rejected', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch {}
      }
    }, 100);
    try {
      const t = await turn(conv.id, 'Print a test page on the Brother printer');
      expect(submits).toBe(0);
      expect(t.result.reply).toMatch(/declined|NOT DONE/i);
    } finally { clearInterval(rejecter); }
  }, 60_000);

  it('still resumes the Gmail workflow when the user explicitly asks to continue it', async () => {
    const conv = seedGmailConversation();
    const t = await turn(conv.id, 'Continue where you left off');
    expect(t.calls[0].system).toContain('ACTIVE WORKFLOW IN THIS CONVERSATION');
    expect(t.calls[0].system).toContain('Extract the contracts from my Gmail');
    expect(listMessages(db, conv.id).length).toBeGreaterThan(2);
  }, 60_000);
});
