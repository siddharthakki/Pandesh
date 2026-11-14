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
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import { createComputerUseCapabilityAdapter } from '../runtime/computerUseCapability';
import { buildPiCapabilityBridge } from '../runtime/piCapabilityBridge';
import { createLocalVisionInspector, isLoopbackUrl } from '../runtime/localVisionInspector';
import { unbackedScreenClaims } from '../runtime/screenClaims';
import { clearModelAwarenessCache } from '../runtime/modelAwareness';
import { TURN_STATE_CLOSE } from '../runtime/turnState';

/**
 * Installed Build 170: "What's on my WhatsApp?" was refused and "Take screenshot of WhatsApp screen and analyze what's
 * there" captured a PNG and then said it could not look at it. The cause was not a messaging-app block: the capture tool
 * had no image reader at all ("no model reads the image in this build"), and told the model so.
 *
 * These tests drive the real PiAgentEngine turn with a scripted Ollama server and a SYNTHETIC messaging screenshot (a
 * PNG whose bytes carry a marker only a reader of the bytes can report). The "vision model" is a stand-in that decodes
 * the image it was sent, so a description proves the bytes reached it; nothing here touches the real screen, a real
 * WhatsApp, the owner's profile or the network.
 */

const MARKER = 'WA-CHAT:Alice says "Lunch at 1?"';
interface Seen { visionRequests: Array<{ model: string; question: string; imageBytes: number }>; mainTools: string[][] }
let server: http.Server;
let previousUrl: string | undefined;
let PiAgentEngineCtor: typeof import('../runtime/piAgentEngine').PiAgentEngine;
let seen: Seen;
let visionModels: string[] = ['fake-vision'];
let mainMode: 'honest' | 'claims-without-question' | 'claims-after-failed-capture' = 'honest';

function syntheticPng(): Buffer {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(MARKER, 'utf8'), Buffer.from([0x00, 0x00])]);
}

function frame(res: http.ServerResponse, message: Record<string, unknown>, done: boolean) {
  res.write(`${JSON.stringify({ model: 'fake', message: { role: 'assistant', content: '', ...message }, done, ...(done ? { done_reason: 'stop', prompt_eval_count: 1, eval_count: 1 } : {}) })}\n`);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = body ? JSON.parse(body) : {};
      if (req.url?.startsWith('/api/generate')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (req.url?.startsWith('/api/tags')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ models: [{ name: 'fake-model' }, ...visionModels.map((name) => ({ name }))] })); return; }
      if (req.url?.startsWith('/api/show')) {
        const caps = visionModels.includes(json.model) ? ['completion', 'vision'] : ['completion', 'tools'];
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ capabilities: caps })); return;
      }
      if (req.url?.startsWith('/api/chat')) {
        const messages = json.messages as Array<{ role: string; content: unknown; images?: string[] }>;
        const withImage = messages.find((m) => Array.isArray(m.images) && m.images.length > 0);
        if (withImage) {
          // The vision stand-in: it can only report what is in the bytes it was sent.
          const bytes = Buffer.from(withImage.images![0], 'base64');
          seen.visionRequests.push({ model: json.model, question: String(withImage.content), imageBytes: bytes.length });
          const found = /WA-CHAT:([^\u0000]*)/.exec(bytes.toString('utf8'))?.[1];
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ model: json.model, message: { role: 'assistant', content: found ? `A WhatsApp window is open. ${found}` : 'The image is unreadable.' }, done: true }));
          return;
        }
        const tools: string[] = (json.tools ?? []).map((t: any) => t.function.name);
        seen.mainTools.push(tools);
        const rest = messages.filter((m) => m.role !== 'system' && m.role !== 'developer');
        const last = rest[rest.length - 1];
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (last.role === 'tool') {
          const out = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
          const text = mainMode === 'claims-without-question' || mainMode === 'claims-after-failed-capture' ? 'I took a screenshot and the screenshot shows a WhatsApp chat with Alice.' : `Result: ${out}`;
          frame(res, { content: text }, false);
        } else if (tools.includes('desktop_screenshot')) {
          const args = mainMode === 'honest' ? { question: "What's on the WhatsApp screen?" } : {};
          frame(res, { tool_calls: [{ function: { name: 'desktop_screenshot', arguments: args } }] }, false);
        } else frame(res, { content: 'I cannot capture the screen here.' }, false);
        frame(res, {}, true); res.end();
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

describe('screenshot capture and analysis through the real turn', () => {
  let db: CoreDatabase;
  let tempDir: string;
  let approver: NodeJS.Timeout;
  let captureFails = false;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-screenshot-'));
    db = openDatabase(path.join(tempDir, 'core.db'));
    runMigrations(db);
    clearModelAwarenessCache();
    seen = { visionRequests: [], mainTools: [] };
    visionModels = ['fake-vision'];
    mainMode = 'honest';
    captureFails = false;
    approver = setInterval(() => {
      for (const a of listPendingApprovals(db)) {
        try { resolveApproval(db, a.id, { resolution: 'approved', attemptId: a.attemptId, gate: a.kind, expectedAttemptRevision: a.expectedAttemptRevision, expectedAttemptStatus: a.expectedAttemptStatus, requestedActionDigest: a.requestedActionDigest, frozenContextHash: a.frozenContextHash, expectedRevision: a.revision, actor: 'test-operator' }); } catch {}
      }
    }, 100);
  });
  afterEach(() => {
    clearInterval(approver);
    try { db.close(); } catch {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  });

  function registry() {
    return new GovernedCapabilityRegistry().register(createComputerUseCapabilityAdapter({
      dataDir: tempDir,
      inspectImage: createLocalVisionInspector(),
      runScript: async (script: string) => {
        if (captureFails) return { succeeded: false, exitCode: 1, output: 'CopyFromScreen failed: the screen is locked' };
        const target = /Save\('((?:[^']|'')+)'/.exec(script)?.[1]?.replace(/''/g, "'");
        if (!target) return { succeeded: false, exitCode: 1, output: 'no target' };
        fs.writeFileSync(target, syntheticPng());
        return { succeeded: true, exitCode: 0, output: '1920x1080' };
      },
    }));
  }

  async function turn(text: string) {
    const conv = createConversation(db, { mode: 'baat_kar', actor: 'user', title: 'shot' });
    appendMessage(db, conv.id, { role: 'user', content: text, actor: 'user' });
    const req = createRequest(db, { clientId: 'desktop', conversationId: conv.id, currentMessage: text, requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'user_prompt', contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false }, correlationId: conv.id });
    const att = createAttempt(db, { requestId: req.id, kind: 'baat_kar', actor: 'client:desktop' });
    const fence = acquireFence(db, att.id, { owner: 'test', actor: 'test' });
    const bridge = buildPiCapabilityBridge({ db, registry: registry(), correlationId: conv.id, clientId: 'desktop', cwd: tempDir, actor: 'test', capabilityIds: ['computer-use'], ownerAttemptId: att.id });
    const result = await new PiAgentEngineCtor().executeAssistantTurn({ db, broadcaster: new EventBroadcaster(), attemptId: att.id, requestId: req.id, conversationId: conv.id, prompt: text, currentMessage: text, fenceToken: fence.token, model: 'fake-model', workspaceRoot: tempDir, dataDir: tempDir, capabilities: bridge } as any);
    const events = db.all<{ eventType: string }>('SELECT eventType FROM runtime_events WHERE entityId = ?', [att.id]).map((e) => e.eventType);
    const invocations = db.all<{ toolName: string; status: string; evidence?: string }>('SELECT toolName, status FROM tool_invocations WHERE attemptId = ?', [att.id]);
    return { result, events, invocations };
  }

  it('captures a synthetic WhatsApp screenshot and has a local vision model read it, with receipts', async () => {
    const t = await turn("Take screenshot of WhatsApp screen and analyze what's there.");
    expect(t.invocations.some((i) => i.toolName === 'desktop_screenshot' && /succe|complet/i.test(i.status))).toBe(true);
    // the image bytes really reached a local vision model, once, with the user's question
    expect(seen.visionRequests).toHaveLength(1);
    expect(seen.visionRequests[0].model).toBe('fake-vision');
    expect(seen.visionRequests[0].imageBytes).toBe(syntheticPng().length);
    expect(seen.visionRequests[0].question).toMatch(/WhatsApp/);
    // the reply carries what that model read, names it, and says nothing left the PC
    expect(t.result.reply).toMatch(/Lunch at 1\?/);
    expect(t.result.reply).toMatch(/local vision model fake-vision/);
    expect(t.result.reply).toMatch(/nothing was sent off this PC/);
    expect(t.events).not.toContain('screenshot_claim_unbacked');
  });

  it('with no local vision model installed it says exactly that and never describes the screen', async () => {
    visionModels = [];
    const t = await turn("Take screenshot of WhatsApp screen and analyze what's there.");
    expect(seen.visionRequests).toHaveLength(0);
    expect(t.result.reply).toMatch(/Not inspected/);
    expect(t.result.reply).toMatch(/no installed local model can read images/);
    expect(t.result.reply).not.toMatch(/Lunch at 1/);
  });

  it('a failed capture is reported as a failure, and a reply claiming a screenshot anyway is corrected', async () => {
    captureFails = true;
    mainMode = 'claims-after-failed-capture';
    const t = await turn("Take screenshot of WhatsApp screen and analyze what's there.");
    expect(t.invocations.some((i) => i.toolName === 'desktop_screenshot' && /succe|complet/i.test(i.status))).toBe(false);
    expect(seen.visionRequests).toHaveLength(0);
    expect(t.events).toContain('screenshot_claim_unbacked');
    expect(t.result.reply).toMatch(/Correction: no screenshot was captured in this turn/);
    expect(t.result.reply).toMatch(/no vision model read a screenshot in this turn/);
  });

  it('a capture that was never read cannot be described: the claim is corrected', async () => {
    mainMode = 'claims-without-question';
    const t = await turn('Take a screenshot of my screen.');
    expect(seen.visionRequests).toHaveLength(0);
    expect(t.events).toContain('screenshot_claim_unbacked');
    expect(t.result.reply).toMatch(/no vision model read a screenshot in this turn/);
    expect(t.result.reply).not.toMatch(/Correction: no screenshot was captured/); // the capture itself did succeed
  });

  it('the image is never sent off this PC: a non-loopback endpoint is refused before any request', async () => {
    expect(isLoopbackUrl('http://127.0.0.1:11434')).toBe(true);
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLoopbackUrl('https://ollama.example.com')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.20:11434')).toBe(false);
    let calls = 0;
    const png = path.join(tempDir, 'x.png'); fs.writeFileSync(png, syntheticPng());
    const inspect = createLocalVisionInspector({ baseUrl: 'https://ollama.example.com', fetchFn: (async () => { calls += 1; return new Response('{}'); }) as typeof fetch });
    const out = await inspect({ path: png, question: 'what is on screen' });
    expect(out.ok).toBe(false);
    expect(calls).toBe(0);
    if (!out.ok) expect(out.reason).toMatch(/never sent off this PC without separate consent/);
  });

  it('unbackedScreenClaims leaves honest replies alone', () => {
    expect(unbackedScreenClaims('I could not analyze the screenshot because no vision model is installed.', [{ tool: 'desktop_screenshot', status: 'completed', isError: false, text: 'Captured' }])).toBeNull();
    expect(unbackedScreenClaims('I saved a screenshot at D:\\x.png.', [{ tool: 'desktop_screenshot', status: 'completed', isError: false, text: 'Captured' }])).toBeNull();
    expect(unbackedScreenClaims('What is the capital of France? Paris.', [])).toBeNull();
  });
});
