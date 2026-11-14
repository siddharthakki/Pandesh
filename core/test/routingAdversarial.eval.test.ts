import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { openDatabase, type CoreDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation, appendMessage } from '../domain/conversations';
import { createRequest } from '../domain/requests';
import { createAttempt } from '../domain/attempts';
import { acquireFence } from '../domain/fence';
import { updateTaskOutcome } from '../domain/taskOutcomes';
import { groupsForText } from '../runtime/chatToolSelection';
import { TURN_STATE_CLOSE } from '../runtime/turnState';

/**
 * Adversarial routing evaluation through the COMPLETE request path (PiAgentEngine.executeAssistantTurn): every
 * pre-model shortcut, the tool-group selector, the tool offer, the (scripted) model's tool call, Core's tool execution
 * and the final status. Run only on request:
 *
 *   ROUTING_EVAL=1 ROUTING_EVAL_LABEL=before npx vitest run core/test/routingAdversarial.eval.test.ts
 *
 * The model is a scripted stand-in that behaves like an honest model: it calls the one tool a prompt needs when that
 * tool is offered and reports what the tool returned; otherwise it answers. So the numbers measure ROUTING (which path
 * answered, what was offered, what really ran, whether the result is true), not model quality.
 */

const RUN = process.env.ROUTING_EVAL === '1';
const LABEL = process.env.ROUTING_EVAL_LABEL || 'run';
const ROOT = path.resolve(__dirname, '..', '..', 'acceptance', 'routing-adversarial');

interface Entry { id: string; cat: string; text: string; route?: string; g?: string[]; x?: string[]; tool?: { name: string; args: Record<string, string> }; ok?: RegExp; seed?: string }
interface ModelCall { tools: string[]; messages: Array<{ role: string; content: unknown }> }

let server: http.Server;
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
let modelCalls: ModelCall[] = [];
let byText = new Map<string, Entry>();
let ws = '';

function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

function script(call: ModelCall): { text?: string; tool?: { name: string; args: Record<string, string> } } {
  const last = call.messages[call.messages.length - 1];
  if (last.role === 'tool') return { text: `Result: ${typeof last.content === 'string' ? last.content : JSON.stringify(last.content)}` };
  const raw = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
  const text = (raw.includes(TURN_STATE_CLOSE) ? raw.slice(raw.lastIndexOf(TURN_STATE_CLOSE) + TURN_STATE_CLOSE.length) : raw).trim();
  const entry = byText.get(text);
  if (entry?.tool && call.tools.includes(entry.tool.name)) return { tool: entry.tool };
  return { text: 'ANSWER' };
}

beforeAll(async () => {
  if (!RUN) return;
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/chat')) {
        const payload = JSON.parse(body);
        const call: ModelCall = { messages: (payload.messages as ModelCall['messages']).filter((m) => m.role !== 'system' && m.role !== 'developer'), tools: (payload.tools ?? []).map((t: any) => t.function.name) };
        modelCalls.push(call);
        const reply = script(call);
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
  if (!RUN) return;
  if (previousUrl === undefined) delete process.env.KARKEDIKHA_OLLAMA_URL; else process.env.KARKEDIKHA_OLLAMA_URL = previousUrl;
  await new Promise<void>((r) => server.close(() => r()));
});

function seedWorkspace(root: string) {
  const mk = (dir: string, n: number, prefix: string) => { fs.mkdirSync(path.join(root, dir), { recursive: true }); for (let i = 1; i <= n; i++) fs.writeFileSync(path.join(root, dir, `${prefix}${i}.txt`), `${prefix}${i}`); };
  mk('rw/inbox', 3, 'a'); mk('events', 2, 'e'); mk('calendar', 4, 'c'); mk('models', 5, 'm'); mk('notifications', 1, 'n');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'notes.txt'), 'status: green; room 4417');
}

describe.skipIf(!RUN)('adversarial routing evaluation (complete request path)', () => {
  it('scores DEV and HOLDOUT separately', async () => {
    const mod = await import(/* @vite-ignore */ pathToFileURL(path.join(ROOT, 'prompts.mjs')).href);
    const sets: Record<string, Entry[]> = { dev: mod.DEV, holdout: mod.HOLDOUT };
    fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-routing-eval-'));
    ws = path.join(tempDir, 'ws');
    seedWorkspace(ws);
    const db: CoreDatabase = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    const wsPosix = ws.replace(/\\/g, '/');
    const wsWin = ws.replace(/\//g, '\\');
    const fill = (s: string) => s.replace(/\{wsWin\}/g, wsWin).replace(/\{ws\}/g, wsPosix);

    const out: Record<string, unknown> = { label: LABEL, at: new Date().toISOString(), promptsSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'prompts.mjs'))).digest('hex') };
    for (const [setName, entries] of Object.entries(sets)) {
      const rows: any[] = [];
      for (const raw of entries) {
        const e: Entry = { ...raw, text: fill(raw.text), tool: raw.tool ? { name: raw.tool.name, args: Object.fromEntries(Object.entries(raw.tool.args).map(([k, v]) => [k, fill(v)])) } : undefined };
        byText = new Map([[e.text.trim(), e]]);
        modelCalls = [];
        const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: e.id });
        if (e.seed === 'prev-fs') {
          appendMessage(db, conv.id, { role: 'user', content: 'How many files are in the rw/inbox folder?', actor: 'user' });
          appendMessage(db, conv.id, { role: 'assistant', content: 'There are 3 files in rw/inbox.', actor: 'karkedikha:pi' });
        }
        if (e.seed === 'build-task') {
          const r0 = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: 'Build me a windows widget', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `seed_${e.id}` });
          const a0 = createAttempt(db, { requestId: r0.id, kind: 'baat_kar', actor: 'client:desktop' });
          appendMessage(db, conv.id, { role: 'user', content: 'Build me a windows widget', actor: 'user' });
          updateTaskOutcome(db, { attemptId: a0.id, conversationId: conv.id, requestId: r0.id, objective: 'Build me a windows widget', status: 'partial', nextAction: 'write the widget', summary: 'started' });
        }
        appendMessage(db, conv.id, { role: 'user', content: e.text, actor: 'user' });
        const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: e.text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: `turn_${e.id}` });
        const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
        const fence = acquireFence(db, att.id, { owner: 'eval', actor: 'eval' });
        const t0 = Date.now();
        let reply = ''; let threw = '';
        const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 25_000);
        try {
          const r = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: e.text, currentMessage: e.text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: ws, signal: ac.signal } as any);
          reply = String(r.reply ?? '');
        } catch (err: any) { threw = String(err?.message ?? err); }
        clearTimeout(timer);
        if (ac.signal.aborted && !threw) threw = 'timeout_25s';
        const latencyMs = Date.now() - t0;
        try { fs.appendFileSync(path.join(ROOT, 'results', `${LABEL}.progress.txt`), `${setName} ${e.id} ${latencyMs}ms
`); } catch {}
        const events = db.all<{ eventType: string; metadata: string }>('SELECT eventType, metadata FROM runtime_events WHERE entityId = ? ORDER BY sequence', [att.id]);
        const status = db.get<{ status: string }>('SELECT status FROM attempts WHERE id = ?', [att.id])?.status ?? 'unknown';
        const tools = db.all<{ toolName: string; status: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [att.id]);
        const meta = (type: string) => { const ev = events.find((x) => x.eventType === type); try { return ev ? JSON.parse(ev.metadata) : null; } catch { return null; } };
        const status_ev = meta('assistant_status_answered');
        const route = status_ev ? `shortcut:${(status_ev.topics as string[]).join('+')}` : events.some((x) => x.eventType === 'task_history_answered') ? 'shortcut:task_history' : 'model';
        const sel = meta('tool_selection');
        // Web turns take an earlier research path and record no tool_selection event: fall back to the selector itself.
        const pointed: string[] = sel ? (sel.groups ?? []).map((g: any) => g.group) : route === 'model' ? [...groupsForText(e.text)] : [];
        const wantRoute = e.route ?? 'model';
        const routeOk = wantRoute === route;
        const recall = wantRoute === 'model' && e.g?.length ? e.g.every((g) => pointed.includes(g)) : null;
        const exposed = (e.x ?? []).filter((g) => pointed.includes(g));
        const toolRan = e.tool ? tools.some((t) => t.toolName === e.tool!.name && /succe|complet/i.test(t.status)) : null;
        const verified = e.tool ? Boolean(e.ok && e.ok.test(reply)) : wantRoute.startsWith('shortcut') ? routeOk : null;
        // A false completion: the attempt says completed, a verifiable answer was needed, and the result is not true.
        const falseCompletion = verified === false && status === 'completed';
        rows.push({ id: e.id, cat: e.cat, text: e.text, wantRoute, route, routeOk, pointed, recall, exposed, toolRan, verified, falseCompletion, status, latencyMs, modelCalls: modelCalls.length, tools: tools.map((t) => `${t.toolName}:${t.status}`), correction: /Correction: nothing was read/.test(reply), replyHead: reply.slice(0, 120), threw });
      }
      const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
      const cnt = (f: (r: any) => boolean) => rows.filter(f).length;
      const recallRows = rows.filter((r) => r.recall !== null);
      const toolRows = rows.filter((r) => r.toolRan !== null);
      const verRows = rows.filter((r) => r.verified !== null);
      (out as any)[setName] = {
        n: rows.length,
        routeCorrect: `${cnt((r) => r.routeOk)}/${rows.length}`,
        unintendedShortcut: cnt((r) => r.wantRoute === 'model' && r.route !== 'model'),
        groupRecall: `${recallRows.filter((r) => r.recall).length}/${recallRows.length}`,
        promptsWithForbiddenExposure: cnt((r) => r.exposed.length > 0),
        toolActuallyRan: `${toolRows.filter((r) => r.toolRan).length}/${toolRows.length}`,
        verifiedCompletion: `${verRows.filter((r) => r.verified).length}/${verRows.length}`,
        falseCompletions: cnt((r) => r.falseCompletion),
        medianLatencyMs: [...rows.map((r) => r.latencyMs)].sort((a, b) => a - b)[Math.floor(rows.length / 2)],
        passRate: pct(cnt((r) => r.routeOk && (r.recall ?? true) && r.exposed.length === 0 && (r.toolRan ?? true) && (r.verified ?? true)), rows.length),
        rows,
      };
    }
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    fs.writeFileSync(path.join(ROOT, 'results', `${LABEL}.json`), JSON.stringify(out, null, 2));
    for (const s of ['dev', 'holdout']) { const { rows, ...summary } = (out as any)[s]; console.log(`[${LABEL}] ${s}`, JSON.stringify(summary)); }
    expect(Object.keys(out)).toContain('dev');
  }, 600_000);
});
