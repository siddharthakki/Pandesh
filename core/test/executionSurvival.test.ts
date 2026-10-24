import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const TOKEN = 'survival-test-token';

/**
 * Priority 2 proof: a Core-owned attempt keeps running when the Extension Host
 * (here: the driving HTTP/WS client) goes away. The real esbuild-bundled Core
 * is spawned as a *separate process* and pointed at a controllable fake Ollama
 * that streams slowly, so we can kick off execution, abruptly destroy the
 * client connections mid-stream (simulating a VS Code close), and then observe
 * from a brand-new client that the Core finished the attempt and durably
 * persisted the assistant message. This is execution ownership, not a shadow.
 */
beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
}, 60_000);

const children: ChildProcess[] = [];
const tempDirs: string[] = [];
let fakeOllama: http.Server;
let fakeOllamaUrl: string;

/** Fake Ollama that streams slowly so execution is in-flight long enough for us
 * to destroy the client mid-stream. The Pi agent talks to Ollama's
 * OpenAI-compatible endpoint (`/v1/chat/completions`, SSE) and the residency
 * preload warms the model through the native endpoint (`/api/generate`), so the
 * fake answers both. */
function startFakeOllama(): Promise<void> {
  fakeOllama = http.createServer((req, res) => {
    if (req.url?.startsWith('/api/tags')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'fake-model', model: 'fake-model' }] }));
      return;
    }
    if (req.url?.startsWith('/api/show')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        parameters: 'num_ctx 8192',
        model_info: { 'general.context_length': 8192 },
        details: { family: 'qwen3', parameter_size: '7B' },
      }));
      return;
    }
    if (req.url?.startsWith('/api/ps')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'fake-model', model: 'fake-model', context_length: 8192 }] }));
      return;
    }
    if (req.url?.startsWith('/api/generate')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-model', response: '', done: true }));
      return;
    }
    if (req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const chunk = (content: string | null, finish: string | null = null) => `data: ${JSON.stringify({
        id: 'chatcmpl-survival', object: 'chat.completion.chunk', created: 0, model: 'fake-model',
        choices: [{ index: 0, delta: content === null ? {} : { content }, finish_reason: finish }],
      })}\n\n`;
      const parts = ['Sur', 'vived', ' the', ' close.'];
      let i = 0;
      const timer = setInterval(() => {
        if (res.writableEnded || res.destroyed) {
          clearInterval(timer);
          return;
        }
        if (i < parts.length) {
          res.write(chunk(parts[i]));
          i++;
        } else {
          clearInterval(timer);
          res.write(chunk(null, 'stop'));
          res.write('data: [DONE]\n\n');
          res.end();
        }
      }, 60);
      res.on('close', () => {
        if (!res.writableEnded) clearInterval(timer);
      });
      return;
    }
    if (req.url !== '/api/chat') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const parts = ['Sur', 'vived', ' the', ' close.'];
    let i = 0;
    const timer = setInterval(() => {
      if (i < parts.length) {
        res.write(JSON.stringify({ model: 'fake-model', message: { content: parts[i] }, done: false }) + '\n');
        i++;
      } else {
        clearInterval(timer);
        res.write(JSON.stringify({ model: 'fake-model', message: { content: '' }, done: true, prompt_eval_count: 3, eval_count: 4 }) + '\n');
        res.end();
      }
    }, 60);
  });
  return new Promise((resolve) => {
    fakeOllama.listen(0, '127.0.0.1', () => {
      const addr = fakeOllama.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      fakeOllamaUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

function spawnCore(dataDir: string): ChildProcess {
  const child = spawn(process.execPath, [bundlePath], {
    env: {
      ...process.env,
      KARKEDIKHA_CORE_TOKEN: TOKEN,
      KARKEDIKHA_DATA_DIR: dataDir,
      KARKEDIKHA_OLLAMA_URL: fakeOllamaUrl,
      KARKEDIKHA_DEFAULT_MODEL: 'fake-model',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitForDiscovery(dataDir: string, timeoutMs = 8000): Promise<{ port: number }> {
  const discoveryPath = path.join(dataDir, 'core.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(discoveryPath)) {
      try {
        return JSON.parse(fs.readFileSync(discoveryPath, 'utf8'));
      } catch { /* partial write */ }
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('discovery record did not appear');
}

afterEach(async () => {
  while (children.length) {
    const child = children.pop()!;
    if (!child.killed) child.kill();
  }
  await new Promise((r) => setTimeout(r, 100));
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  if (fakeOllama) await new Promise<void>((r) => fakeOllama.close(() => r()));
});

describe('M32 Priority 2: Core-owned execution survives the Extension Host going away', () => {
  it('finishes an in-flight Baat Kar attempt after the driving client is destroyed mid-stream', async () => {
    await startFakeOllama();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-survival-'));
    tempDirs.push(dataDir);
    spawnCore(dataDir);
    const { port } = await waitForDiscovery(dataDir);
    const base = `http://127.0.0.1:${port}`;

    const H = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'eh', ...extra });
    const post = (p: string, body: unknown, key: string) => fetch(`${base}${p}`, { method: 'POST', headers: H({ 'Idempotency-Key': key }), body: JSON.stringify(body) }).then((r) => r.json());

    const conv = await post('/v1/conversations', { mode: 'baat_kar' }, 'k-conv');
    await post(`/v1/conversations/${conv.id}/messages`, { role: 'user', content: 'Will you survive?' }, 'k-msg');
    const req = await post('/v1/requests', {
      currentMessage: 'Will you survive?', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test',
      conversationId: conv.id, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    }, 'k-req');
    const attempt = await post('/v1/attempts', { requestId: req.id, kind: 'baat_kar' }, 'k-att');

    // The Extension Host opens a WS (as the real one does) and starts execution.
    const ehSocket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    await new Promise((resolve, reject) => { ehSocket.on('open', resolve); ehSocket.on('error', reject); });
    const execRes = await fetch(`${base}/v1/attempts/${attempt.id}/execute`, { method: 'POST', headers: H({ 'Idempotency-Key': 'k-exec' }), body: '{}' });
    expect(execRes.status).toBe(202);

    // Wait until execution is actually in-flight (attempt running), then simulate
    // VS Code closing: hard-destroy the WS. The Core process is separate and keeps going.
    const deadline = Date.now() + 4000;
    for (;;) {
      const a = await fetch(`${base}/v1/attempts/${attempt.id}`, { headers: H() }).then((r) => r.json());
      if (a.status === 'running') break;
      if (Date.now() > deadline) throw new Error(`attempt never reached running; status=${a.status}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    ehSocket.terminate(); // the Extension Host webview is gone

    // A brand-new client (as if VS Code was reopened) observes the completed attempt.
    let final: any;
    const d2 = Date.now() + 5000;
    for (;;) {
      final = await fetch(`${base}/v1/attempts/${attempt.id}`, { headers: H() }).then((r) => r.json());
      if (final.status === 'completed') break;
      if (Date.now() > d2) throw new Error(`attempt did not complete after client close; status=${final.status}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(final.status).toBe('completed');

    const messages = await fetch(`${base}/v1/conversations/${conv.id}/messages`, { headers: H() }).then((r) => r.json());
    const assistant = messages.messages.find((m: any) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    expect(assistant.content).toBe('Survived the close.');

    const invocations = await fetch(`${base}/v1/attempts/${attempt.id}/model-invocations`, { headers: H() }).then((r) => r.json());
    expect(invocations.modelInvocations[0].status).toBe('succeeded');
  }, 30_000);
});
