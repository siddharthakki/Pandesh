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
import { isPublicUrl, readAgentReachConfig, runAgentReach, validateAgentReachCall } from '../runtime/agentReachTool';

/** A stand-in for the agent-reach program: records how it was started and prints canned JSON. */
const FAKE_CLI = `
const fs = require('fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG || (process.env.HOME + '/calls.jsonl'), JSON.stringify({ argv, home: process.env.HOME, gh: process.env.GH_TOKEN, appdata: process.env.APPDATA }) + '\\n');
const mode = argv.includes('boom') ? 'boom' : argv.includes('bad-json') ? 'bad' : 'ok';
if (mode === 'bad') { console.log('not json'); process.exit(0); }
if (mode === 'boom') { console.log(JSON.stringify({ ok: false, error: { code: 'NEED_LOGIN', message: 'login needed', hint: 'ask the user' } })); process.exit(0); }
console.log(JSON.stringify({ ok: true, backend: 'fake', items: [{ title: 'Result one', url: 'https://example.com/a', author: 'u/x', published_at: '2026-01-01', text: 'x'.repeat(9000), raw: { secret: 'RAW-SHOULD-NOT-APPEAR' } }, { title: 'Two', url: 'https://example.com/b', text: 'second' }] }));
`;

describe('agent_reach: validation', () => {
  it('only public read actions are reachable; everything else is refused before anything runs', () => {
    for (const bad of [
      { channel: 'web', action: 'login', target: 'x' }, { channel: 'github', action: 'update', target: 'x' }, { channel: 'setup', action: 'run', target: 'x' },
      { channel: 'twitter', action: 'search', target: 'rust' }, { channel: 'xiaohongshu', action: 'read', target: 'https://x.com/a' }, { channel: 'web', action: 'configure', target: 'k' },
      { channel: 'youtube', action: 'search', target: '--help' }, { channel: 'web', action: 'read', target: 'file:///C:/secret.txt' }, { channel: 'web', action: 'read', target: 'http://localhost:3030/x' },
      { channel: 'web', action: 'read', target: 'http://192.168.1.5/admin' }, { channel: 'web', action: 'read', target: 'https://user:pw@example.com/' }, { channel: 'web', action: 'read', target: 'https://intranet/page' },
      { channel: 'reddit', action: 'search', target: '' }, { channel: 'web', action: 'read', target: 'https://a.com/x\nsecond' },
    ]) expect(validateAgentReachCall(bad).ok, JSON.stringify(bad)).toBe(false);
    for (const good of [
      { channel: 'web', action: 'read', target: 'https://example.com/page' }, { channel: 'github', action: 'read', target: 'owner/repo' }, { channel: 'github', action: 'search', target: 'ollama' },
      { channel: 'youtube', action: 'subtitle', target: 'https://www.youtube.com/watch?v=abc' }, { channel: 'reddit', action: 'search', target: 'rust async', limit: 3 }, { channel: 'v2ex', action: 'hot', target: '' },
    ]) expect(validateAgentReachCall(good).ok, JSON.stringify(good)).toBe(true);
    expect(isPublicUrl('http://[::1]/x')).toBe(false);
    expect(isPublicUrl('https://172.20.0.4/')).toBe(false);
    expect(isPublicUrl('https://example.org/a?b=1')).toBe(true);
  });
});

describe('agent_reach: running the program', () => {
  let dir: string; let home: string; let cli: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ar-')); home = path.join(dir, 'home'); fs.mkdirSync(home, { recursive: true }); cli = path.join(dir, 'fake-cli.js'); fs.writeFileSync(cli, FAKE_CLI); });
  afterEach(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const config = () => ({ command: [process.execPath, cli], home });

  it('starts the program directly with an isolated home, no GitHub login, capped output and no raw upstream data', async () => {
    const r = await runAgentReach(config(), { channel: 'reddit', action: 'search', target: 'rust', limit: 2 });
    expect(r.ok).toBe(true);
    expect(r.items).toBe(2);
    expect(r.text).not.toContain('RAW-SHOULD-NOT-APPEAR');
    expect(r.text.length).toBeLessThan(17_500);
    const call = JSON.parse(fs.readFileSync(path.join(home, 'calls.jsonl'), 'utf8').trim().split('\n')[0]);
    expect(call.argv).toEqual(['reddit', 'search', 'rust', '--limit', '2']);
    expect(call.home).toBe(home);
    expect(call.gh).toBe('');
    expect(call.appdata.startsWith(home)).toBe(true);
  });

  it('reports the tool\'s own failure and unreadable output honestly', async () => {
    const failed = await runAgentReach(config(), { channel: 'reddit', action: 'search', target: 'boom', limit: 1 });
    expect(failed.ok).toBe(false);
    expect(failed.errorCode).toBe('NEED_LOGIN');
    expect(failed.text).toMatch(/Nothing was read/);
    const bad = await runAgentReach(config(), { channel: 'reddit', action: 'search', target: 'bad-json', limit: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.text).toMatch(/did not return a result/);
  });

  it('is only configured when the program and its home exist', () => {
    const data = path.join(dir, 'data'); fs.mkdirSync(path.join(data, 'tools'), { recursive: true });
    expect(readAgentReachConfig(data)).toBeNull();
    fs.writeFileSync(path.join(data, 'tools', 'agent-reach.json'), JSON.stringify({ command: [process.execPath, cli], home }));
    expect(readAgentReachConfig(data)?.home).toBe(home);
    fs.writeFileSync(path.join(data, 'tools', 'agent-reach.json'), JSON.stringify({ command: [path.join(dir, 'missing.exe')], home }));
    expect(readAgentReachConfig(data)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------- real request path
interface ModelCall { tools: string[]; messages: Array<{ role: string; content: unknown }> }
let server: http.Server;
let modelCalls: ModelCall[] = [];
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
let plan: { name: string; args: Record<string, unknown> } | null = null;

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
        const call: ModelCall = { messages: (payload.messages as ModelCall['messages']).filter((m) => m.role !== 'system' && m.role !== 'developer'), tools: (payload.tools ?? []).map((t: any) => t.function.name) };
        modelCalls.push(call);
        const last = call.messages[call.messages.length - 1];
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (last.role === 'tool') frame(res, { content: `Result: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` }, false);
        else if (plan && call.tools.includes(plan.name)) frame(res, { tool_calls: [{ function: { name: plan.name, arguments: plan.args } }] }, false);
        else frame(res, { content: 'No tool.' }, false);
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

describe('agent_reach through the real request path', () => {
  let db: CoreDatabase; let tempDir: string; let dataDir: string; let home: string; let log: string; let decide: 'approved' | 'rejected'; let approver: NodeJS.Timeout;
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-ar-turn-'));
    dataDir = path.join(tempDir, 'data'); home = path.join(tempDir, 'home'); log = path.join(tempDir, 'cli-calls.jsonl');
    fs.mkdirSync(path.join(dataDir, 'tools'), { recursive: true }); fs.mkdirSync(home, { recursive: true });
    const cli = path.join(tempDir, 'fake-cli.js'); fs.writeFileSync(cli, FAKE_CLI);
    process.env.FAKE_LOG = log;
    fs.writeFileSync(path.join(dataDir, 'tools', 'agent-reach.json'), JSON.stringify({ command: [process.execPath, cli], home }));
    db = openDatabase(path.join(tempDir, 'core.db')); runMigrations(db);
    modelCalls = []; plan = null; decide = 'approved';
    approver = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: decide, attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch {}
      }
    }, 100);
  });
  afterEach(() => { clearInterval(approver); delete process.env.FAKE_LOG; try { db.close(); } catch {} try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {} });

  async function turn(text: string) {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'ar' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `t_${Math.random()}` });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 't', actor: 't' });
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', dataDir } as any);
    const events = db.all<{ eventType: string }>('SELECT eventType FROM runtime_events WHERE entityId = ?', [att.id]).map((e) => e.eventType);
    const tools = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [att.id]);
    return { result, events, tools, calls: modelCalls.slice(), approvals: db.all('SELECT id FROM approvals').length };
  }
  const cliRan = () => { const f = path.join(home, 'calls.jsonl'); return fs.existsSync(f) && fs.readFileSync(f, 'utf8').trim().length > 0; };

  it('a public read is asked for, then runs once, and its result reaches the reply', async () => {
    plan = { name: 'agent_reach', args: { channel: 'reddit', action: 'search', target: 'rust async', limit: 2 } };
    const t = await turn('Search Reddit for rust async posts');
    expect(t.calls[0].tools).toContain('agent_reach');
    expect(t.approvals).toBe(1);
    expect(t.events).toContain('agent_reach_started');
    expect(t.events).toContain('agent_reach_finished');
    expect(cliRan()).toBe(true);
    expect(t.result.reply).toContain('Result one');
    expect(t.result.reply).not.toContain('RAW-SHOULD-NOT-APPEAR');
  });

  it('a rejected approval means the program never ran', async () => {
    decide = 'rejected';
    plan = { name: 'agent_reach', args: { channel: 'reddit', action: 'search', target: 'rust async' } };
    const t = await turn('Search Reddit for rust async posts');
    expect(cliRan()).toBe(false);
    expect(t.events).not.toContain('agent_reach_started');
  });

  it('login, setup and browser channels never reach the program, and no approval is even asked', async () => {
    for (const args of [{ channel: 'twitter', action: 'search', target: 'x' }, { channel: 'web', action: 'login', target: 'x' }, { channel: 'github', action: 'update', target: 'x' }]) {
      plan = { name: 'agent_reach', args };
      const t = await turn('Search Reddit for rust');
      expect(cliRan(), JSON.stringify(args)).toBe(false);
      expect(t.approvals).toBe(0);
    }
  });

  it('a search query that carries private data is refused before approval and before anything leaves', async () => {
    plan = { name: 'agent_reach', args: { channel: 'reddit', action: 'search', target: 'anna.schmidt@example.com salary C:\\Users\\anna\\Documents\\bank.pdf' } };
    const t = await turn('Search Reddit for my bank statement problems');
    expect(cliRan()).toBe(false);
    expect(t.approvals).toBe(0);
    expect(t.events).toContain('agent_reach_query_refused');
  });

  it('without the tool installed nothing is offered', async () => {
    fs.rmSync(path.join(dataDir, 'tools'), { recursive: true, force: true });
    const t = await turn('Search Reddit for rust async posts');
    expect(t.calls[0].tools).not.toContain('agent_reach');
  });
});
