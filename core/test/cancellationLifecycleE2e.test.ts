/**
 * Isolated end-to-end proof of the cancellation lifecycle on the real Pi path.
 *
 * A real Core is spawned as its own process against a disposable data directory
 * and a controllable fake Ollama, so the exact code path that stranded the live
 * attempt is exercised: a Baat Kar turn through the Pi agent, stopped while the
 * model call is still in flight.
 *
 * On the code that produced the defect, the attempt stayed `cancelling` for
 * ever (the turn tried to report `completed`, the transition was refused, the
 * refusal was swallowed) and the client waited on a "Working" state that never
 * ended. The assertions below fail on that code and pass on the fixed code.
 *
 * Nothing here touches the user's live Core: separate process, separate data
 * directory, separate fake model.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const TOKEN = 'cancellation-e2e-token';

beforeAll(() => {
  // The Core under test is the real bundle, built from the current sources.
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
}, 120_000);

const children: ChildProcess[] = [];
const tempDirs: string[] = [];
let fakeOllama: http.Server;
let fakeOllamaUrl: string;
/** When set, the fake keeps the reply open after the first tokens, so the test
 * can cancel while the model call is still in flight. */
let releaseLateReply: (() => void) | null = null;
let chatRequests = 0;

function startFakeOllama(): Promise<void> {
  chatRequests = 0;
  releaseLateReply = null;
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
    if (req.url?.startsWith('/api/generate')) {
      // The residency preload warms the model through the native endpoint.
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'fake-model', response: '', done: true }));
      return;
    }
    if (!req.url?.startsWith('/v1/chat/completions')) {
      res.writeHead(404);
      res.end();
      return;
    }
    chatRequests += 1;
    // The Pi agent talks to Ollama's OpenAI-compatible endpoint and streams.
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta: Record<string, unknown>, finish: string | null = null) => `data: ${JSON.stringify({
      id: 'chatcmpl-cancel-e2e',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'fake-model',
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
    res.write(chunk({ role: 'assistant', content: 'Working' }));
    // The reply is held open: the turn stays in flight until the test cancels
    // it and releases the tail — the transport that completes late.
    const timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        clearInterval(timer);
        return;
      }
      res.write(chunk({ content: ' on it' }));
    }, 80);
    releaseLateReply = () => {
      clearInterval(timer);
      if (res.writableEnded || res.destroyed) return;
      res.write(chunk({ content: ' — finished.' }));
      res.write(chunk({}, 'stop'));
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-cancel-e2e', object: 'chat.completion.chunk', created: 0, model: 'fake-model', choices: [],
        usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    };
    req.on('close', () => clearInterval(timer));
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
      KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  return child;
}

async function waitForDiscovery(dataDir: string, timeoutMs = 15_000): Promise<{ port: number }> {
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
  await new Promise((r) => setTimeout(r, 200));
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  if (fakeOllama) await new Promise<void>((r) => fakeOllama.close(() => r()));
});

describe('cancellation lifecycle, end to end on the real Pi path', () => {
  it('a stop during an active inference ends the attempt as cancelled, never as a permanent cancelling', async () => {
    await startFakeOllama();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-cancel-e2e-'));
    tempDirs.push(dataDir);
    spawnCore(dataDir);
    const { port } = await waitForDiscovery(dataDir);
    const base = `http://127.0.0.1:${port}`;

    const H = (extra: Record<string, string> = {}) => ({
      Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'cancel-e2e', ...extra,
    });
    const post = (p: string, body: unknown, key: string) => fetch(`${base}${p}`, {
      method: 'POST', headers: H({ 'Idempotency-Key': key }), body: JSON.stringify(body),
    }).then((r) => r.json());

    const conv = await post('/v1/conversations', { mode: 'baat_kar' }, 'k-conv');
    await post(`/v1/conversations/${conv.id}/messages`, { role: 'user', content: 'Take your time.' }, 'k-msg');
    const req = await post('/v1/requests', {
      currentMessage: 'Take your time.', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test',
      conversationId: conv.id,
      contextPolicy: {
        includeConversationHistory: true, includeProjectContext: false,
        includeRepositoryContext: false, includeGlobalStoryContext: false,
      },
    }, 'k-req');
    const attempt = await post('/v1/attempts', { requestId: req.id, kind: 'baat_kar' }, 'k-att');
    await fetch(`${base}/v1/attempts/${attempt.id}/execute`, {
      method: 'POST', headers: H({ 'Idempotency-Key': 'k-exec' }), body: '{}',
    });

    // Wait until the model call is really in flight: the attempt is running AND
    // the fake Ollama has received the request.
    const runningDeadline = Date.now() + 20_000;
    for (;;) {
      const a = await fetch(`${base}/v1/attempts/${attempt.id}`, { headers: H() }).then((r) => r.json());
      if (a.status === 'running' && chatRequests > 0) break;
      if (Date.now() > runningDeadline) {
        throw new Error(`the model call never started; status=${a.status} chatRequests=${chatRequests}`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(chatRequests).toBeGreaterThan(0);

    // The user presses Stop while the model is still answering.
    const cancelResponse = await fetch(`${base}/v1/attempts/${attempt.id}/cancel`, {
      method: 'POST', headers: H({ 'Idempotency-Key': 'k-cancel' }), body: '{}',
    });
    expect(cancelResponse.status).toBe(200);

    // The model answers anyway (the transport that completes late).
    releaseLateReply?.();

    // The attempt must reach an authoritative terminal state.
    const terminalDeadline = Date.now() + 20_000;
    let final: any;
    for (;;) {
      final = await fetch(`${base}/v1/attempts/${attempt.id}`, { headers: H() }).then((r) => r.json());
      if (['completed', 'cancelled', 'failed'].includes(final.status)) break;
      if (Date.now() > terminalDeadline) {
        throw new Error(`attempt never reached a terminal state; status=${final.status} (cancelRequestedAt=${final.cancelRequestedAt})`);
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // A stopped turn is cancelled — it is never reported as finished work.
    expect(final.status).toBe('cancelled');
    expect(final.cancelledAt).toBeTruthy();
    expect(final.cancelRequestedAt).toBeTruthy();

    // No fabricated assistant reply for a turn the user stopped.
    const messages = await fetch(`${base}/v1/conversations/${conv.id}/messages`, { headers: H() }).then((r) => r.json());
    const assistant = messages.messages.find((m: any) => m.role === 'assistant');
    expect(assistant, 'a stopped turn must not persist an assistant reply').toBeUndefined();

    // The model invocation is closed as cancelled, not left pending.
    const invocations = await fetch(`${base}/v1/attempts/${attempt.id}/model-invocations`, { headers: H() }).then((r) => r.json());
    for (const invocation of invocations.modelInvocations) {
      expect(['cancelled', 'failed']).toContain(invocation.status);
    }
  }, 60_000);
});
