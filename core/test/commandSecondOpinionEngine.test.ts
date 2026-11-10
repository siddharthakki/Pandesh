import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { EventBroadcaster } from '../ws/broadcaster';
import { createConversation } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { acquireFence } from '../domain/fence';
import { listPendingApprovals, resolveApproval } from '../domain/approvals';
import { createStandingAuthorization, setConversationPermissionMode } from '../domain/permissionModes';
import { resetCommandReviewWarmth, updateCommandReviewSettings } from '../runtime/commandSecondOpinion';
import { startScriptedOllama, afterToolResult, type ScriptedOllama } from './support/scriptedOllama';

/**
 * The Ollaya second opinion on the real chat path (run_checks through requestToolApproval). It may add a warning to a
 * card and send an Auto approval back to the person; when it is off, slow or down, everything happens as before.
 */

interface Verdict { step: number; destructive: number; delayMs?: number }
let verdict: Verdict;
let reviews: Array<Record<string, unknown>>;
let ollayaRequests = 0;
let ollaya: http.Server;
let ollayaUrl: string;
let closedUrl: string;
let model: ScriptedOllama;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
const saved = { model: process.env.KARKEDIKHA_OLLAMA_URL, ollaya: process.env.KARKEDIKHA_OLLAYA_URL, flag: process.env.KARKEDIKHA_OLLAYA };

beforeAll(async () => {
  ollaya = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      ollayaRequests += 1;
      if (req.url === '/api/version') { res.end(JSON.stringify({ version: 'test' })); return; }
      const parsed = JSON.parse(body || '{}');
      const warmup = parsed?.state?.command === 'dir' && parsed?.state?.request === 'List the files in the project folder';
      if (!warmup) reviews.push(parsed.state);
      const reply = () => {
        try {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ model: 'decision:latest', answers: { step: { type: 'noul', noul: verdict.step }, destructive: { type: 'noul', noul: verdict.destructive } } }));
        } catch { /* the client gave up */ }
      };
      if (!warmup && verdict.delayMs) setTimeout(reply, verdict.delayMs); else reply();
    });
  });
  await new Promise<void>((r) => ollaya.listen(0, '127.0.0.1', () => r()));
  ollayaUrl = `http://127.0.0.1:${(ollaya.address() as AddressInfo).port}`;
  // A port that was just free: nothing answers there.
  const probe = http.createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  closedUrl = `http://127.0.0.1:${(probe.address() as AddressInfo).port}`;
  await new Promise<void>((r) => probe.close(() => r()));

  model = await startScriptedOllama((call) => {
    const toolOutput = afterToolResult(call);
    if (toolOutput !== null) return { text: `Tool said: ${toolOutput.slice(0, 300)}` };
    return { tool: { name: 'run_checks', args: { command: 'npm test' } } };
  });
  process.env.KARKEDIKHA_OLLAMA_URL = model.url;
  PiAgentEngineCtor = (await import('../runtime/piAgentEngine')).PiAgentEngine;
});

afterAll(async () => {
  for (const [key, value] of [['KARKEDIKHA_OLLAMA_URL', saved.model], ['KARKEDIKHA_OLLAYA_URL', saved.ollaya], ['KARKEDIKHA_OLLAYA', saved.flag]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await model.close();
  await new Promise<void>((r) => ollaya.close(() => r()));
});

describe.runIf(process.platform === 'win32')('second opinion on run_checks', () => {
  let dir: string;
  let ws: string;
  let ran: string;
  let db: CoreDatabase;
  let conversationId: string;
  let decider: NodeJS.Timeout | undefined;
  let cards: Array<{ cardText: string; secondOpinion?: unknown }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-second-opinion-engine-'));
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    ws = path.join(dir, 'repo');
    fs.mkdirSync(ws);
    cp.execFileSync('git', ['init', '-q', ws], { stdio: 'ignore' });
    ran = path.join(ws, 'ran.txt');
    // The pinned test script leaves a mark, so each test can tell whether the command really ran.
    fs.writeFileSync(path.join(ws, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\', \'yes\')"' } }));
    conversationId = createConversation(db, { mode: 'baat_kar', actor: 'test' }).id;
    verdict = { step: 0.95, destructive: 0.02 };
    reviews = [];
    ollayaRequests = 0;
    cards = [];
    resetCommandReviewWarmth();
    delete process.env.KARKEDIKHA_OLLAYA;
    process.env.KARKEDIKHA_OLLAYA_URL = ollayaUrl;
  });

  afterEach(() => {
    if (decider) clearInterval(decider);
    decider = undefined;
    try { db.close(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  function answerCards(resolution: 'approved' | 'rejected') {
    decider = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        cards.push({ cardText: String(a.summary.cardText ?? ''), secondOpinion: a.summary.secondOpinion });
        try {
          resolveApproval(db, a.id, { resolution, attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' });
        } catch {}
      }
    }, 50);
  }

  async function turn(text: string, mode: 'ask' | 'auto') {
    if (mode === 'auto') {
      setConversationPermissionMode(db, conversationId, 'auto', 'desktop');
      createStandingAuthorization(db, { conversationId, categories: ['workspace_validation'], workspaceRoot: ws, expiresInMinutes: 60, actor: 'desktop' });
    }
    const { request, attempt } = submitRequest(db, {
      clientId: 'desktop', currentMessage: text, requestedMode: 'baat_kar', conversationId, workspaceRoot: ws,
      requestedProvider: 'ollama', selectedModel: 'fake-model', toolPermissionPolicy: { profile: 'confirm-mutations' },
      capability: { hasWorkspace: true, gitCapable: true }, correlationId: `c-${Math.random()}`,
    });
    const fence = acquireFence(db, attempt.id, { owner: 'test', actor: 'test' });
    return new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: attempt.id, requestId: request.id, conversationId, workspaceRoot: ws, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model' });
  }

  const reviewEvents = () => db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE eventType = 'command_second_opinion' ORDER BY sequence").map((r) => ({ raw: r.metadata, ...JSON.parse(r.metadata) }));
  const autoApprovals = () => db.all<{ status: string; summary: string }>('SELECT status, summary FROM approvals').filter((a) => JSON.parse(a.summary).policyDecision === 'auto_authorize');

  it('Auto: a command flagged as not matching the request goes back to the person instead of running', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    verdict = { step: 0.05, destructive: 0.03 };
    answerCards('rejected');
    const text = `Show me what changed in ${ws}`;
    await turn(text, 'auto');
    expect(fs.existsSync(ran)).toBe(false);
    expect(autoApprovals()).toHaveLength(0);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).toContain('⚠ Command may not match your request: a second opinion on this PC (decision:latest) does not see it as a step of what you asked for.');
    expect(cards[0].cardText).not.toContain('Potentially destructive');
    expect(cards[0].cardText).toContain('Auto would have run this, but a second opinion flagged it, so it waits for you.');
    expect(reviews).toEqual([{ request: text, command: 'npm test' }]);
    const [event] = reviewEvents();
    expect(event).toMatchObject({ outcome: 'escalated', mode: 'auto', offTaskFlag: true, destructiveFlag: false, model: 'decision:latest' });
    expect(event.raw).not.toContain('npm test');
    expect(event.raw).not.toContain('Show me what changed');
  }, 60_000);

  it('Auto: a command the second opinion finds fine runs exactly as before', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    answerCards('rejected');
    await turn(`Run the tests in ${ws}`, 'auto');
    expect(fs.existsSync(ran)).toBe(true);
    expect(cards).toHaveLength(0);
    expect(autoApprovals().map((a) => a.status)).toEqual(['approved']);
    expect(reviewEvents()).toMatchObject([{ outcome: 'clear' }]);
  }, 60_000);

  it('Auto: when Ollaya is not running nothing changes', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    process.env.KARKEDIKHA_OLLAYA_URL = closedUrl;
    answerCards('rejected');
    await turn(`Run the tests in ${ws}`, 'auto');
    expect(fs.existsSync(ran)).toBe(true);
    expect(cards).toHaveLength(0);
    expect(reviewEvents()).toMatchObject([{ outcome: 'unavailable', unavailable: 'unreachable' }]);
  }, 60_000);

  it('Auto: when Ollaya is too slow nothing changes, and the command waited at most the review timeout', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    verdict = { step: 0.05, destructive: 0.9, delayMs: 6_000 };
    answerCards('rejected');
    await turn(`Run the tests in ${ws}`, 'auto');
    expect(fs.existsSync(ran)).toBe(true);
    expect(cards).toHaveLength(0);
    const [event] = reviewEvents();
    expect(event).toMatchObject({ outcome: 'unavailable', unavailable: 'timeout' });
    expect(event.latencyMs).toBeLessThan(4_000);
  }, 60_000);

  it('off by default: Ollaya is never contacted and Auto runs the command as before', async () => {
    verdict = { step: 0.01, destructive: 0.99 };
    answerCards('rejected');
    await turn(`Run the tests in ${ws}`, 'auto');
    expect(fs.existsSync(ran)).toBe(true);
    expect(ollayaRequests).toBe(0);
    expect(reviewEvents()).toHaveLength(0);
  }, 60_000);

  it('Ask: a flagged command\'s card carries the warning, and the person still decides', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    verdict = { step: 0.08, destructive: 0.85 };
    answerCards('approved');
    await turn(`Run the tests in ${ws}`, 'ask');
    expect(fs.existsSync(ran)).toBe(true);
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).toMatch(/⚠ Command may not match your request/);
    expect(cards[0].cardText).toMatch(/⚠ Potentially destructive: .* may delete or overwrite data/);
    expect(cards[0].cardText).not.toContain('Auto would have run');
    expect(cards[0].secondOpinion).toMatchObject({ model: 'decision:latest', step: 0.08, destructive: 0.85, offTaskThreshold: 0.4, destructiveThreshold: 0.2, offTaskFlag: true, destructiveFlag: true });
    expect(reviewEvents()).toMatchObject([{ outcome: 'hint', mode: 'ask' }]);
  }, 60_000);

  it('Ask: a card the second opinion finds fine looks exactly as before', async () => {
    updateCommandReviewSettings(db, { enabled: true });
    answerCards('approved');
    await turn(`Run the tests in ${ws}`, 'ask');
    expect(cards).toHaveLength(1);
    expect(cards[0].cardText).not.toContain('⚠');
    expect(cards[0].secondOpinion).toBeUndefined();
    expect(reviewEvents()).toMatchObject([{ outcome: 'clear', mode: 'ask' }]);
  }, 60_000);
});
