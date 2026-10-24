import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreClient } from '../../core-client/CoreClient';

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const bundlePath = path.join(repoRoot, 'out-core', 'core.js');
const TOKEN = 'coreclient-exec-token';

beforeAll(() => {
  execFileSync(process.execPath, [path.join(repoRoot, 'esbuild.core.js')], { cwd: repoRoot, stdio: 'inherit' });
}, 60_000);

let dataDir: string;
let child: ChildProcess;
let baseUrl: string;
let fakeOllama: http.Server;
let fakeOllamaUrl: string;
let client: CoreClient;

function startFakeOllama(): Promise<void> {
  fakeOllama = http.createServer((req, res) => {
    if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    res.write(JSON.stringify({ model: 'fake-model', message: { content: 'Core' }, done: false }) + '\n');
    res.write(JSON.stringify({ model: 'fake-model', message: { content: ' ran it.' }, done: false }) + '\n');
    res.write(JSON.stringify({ model: 'fake-model', message: { content: '' }, done: true, prompt_eval_count: 2, eval_count: 3 }) + '\n');
    res.end();
  });
  return new Promise((resolve) => fakeOllama.listen(0, '127.0.0.1', () => {
    const addr = fakeOllama.address();
    fakeOllamaUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    resolve();
  }));
}

async function waitForDiscovery(dir: string, timeoutMs = 8000): Promise<{ port: number }> {
  const p = path.join(dir, 'core.json');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(p)) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* partial */ } }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('discovery record did not appear');
}

beforeEach(async () => {
  await startFakeOllama();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-coreclient-exec-'));
  child = spawn(process.execPath, [bundlePath], {
    env: { ...process.env, KARKEDIKHA_CORE_TOKEN: TOKEN, KARKEDIKHA_DATA_DIR: dataDir, KARKEDIKHA_OLLAMA_URL: fakeOllamaUrl, KARKEDIKHA_DEFAULT_MODEL: 'fake-model' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const record = await waitForDiscovery(dataDir);
  baseUrl = `http://127.0.0.1:${record.port}`;
  client = new CoreClient({ baseUrl, token: TOKEN, clientId: 'exec-test', clientVersion: '0.0.0' });
});

afterEach(async () => {
  client?.dispose();
  try {
    await fetch(`${baseUrl}/v1/core/shutdown`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'cleanup', 'X-Client-Id': 'test' }, body: '{}' });
  } catch { /* best effort */ }
  if (child && !child.killed) child.kill();
  await new Promise((r) => setTimeout(r, 200));
  if (fakeOllama) await new Promise<void>((r) => fakeOllama.close(() => r()));
  for (let i = 0; i < 10; i++) { try { fs.rmSync(dataDir, { recursive: true, force: true }); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
});

describe('CoreClient.submit drives the atomic request+attempt submission path end-to-end', () => {
  it('POST /v1/submit via CoreClient.submit returns one committed request and one committed attempt', async () => {
    const result = await client.submit({ currentMessage: 'Add a feature', requestedMode: 'karke_dikha' });
    expect(result.request.resolvedMode).toBe('karke_dikha');
    expect(result.attempt.requestId).toBe(result.request.id);
    expect(result.attempt.kind).toBe('karke_dikha');

    // Independent GETs confirm both rows were actually committed by Core, not
    // just echoed back in the response.
    const fetchedRequest = await client.request<{ id: string }>(`/v1/requests/${result.request.id}`);
    expect(fetchedRequest.id).toBe(result.request.id);
    const fetchedAttempt = await client.getAttempt(result.attempt.id);
    expect(fetchedAttempt.id).toBe(result.attempt.id);
    expect(fetchedAttempt.requestId).toBe(result.request.id);
  });

  it('propagates a structured Core rejection instead of throwing an opaque error', async () => {
    await expect(client.submit({ currentMessage: '', requestedMode: 'karke_dikha' })).rejects.toMatchObject({
      name: 'CoreApiError',
    });
  });
});

describe('CoreClient.executeAttempt drives Core-owned execution end-to-end', () => {
  it('creates conversation/request/attempt and has the Core run the model call', async () => {
    const conv = await client.createConversation({ mode: 'baat_kar' });
    await client.appendMessage(conv.id, { role: 'user', content: 'Did the Core run this?' });
    const req = await client.createRequestEnvelope({
      currentMessage: 'Did the Core run this?', requestedMode: 'baat_kar', resolvedMode: 'baat_kar', routeReason: 'test',
      conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
    });
    const attempt = await client.createAttempt({ requestId: req.id, kind: 'baat_kar' });

    const ack = await client.executeAttempt(attempt.id);
    expect(ack.status).toBe('accepted');

    // Poll via the client until the Core-owned attempt is terminal.
    let final = attempt;
    const deadline = Date.now() + 5000;
    for (;;) {
      final = await client.getAttempt(attempt.id);
      if (['completed', 'failed', 'cancelled'].includes(final.status)) break;
      if (Date.now() > deadline) throw new Error(`attempt stuck at ${final.status}`);
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(final.status).toBe('completed');

    const messages = await client.listMessages(conv.id);
    const assistant = messages.messages.find((m) => m.role === 'assistant');
    expect(assistant?.content).toBe('Core ran it.');
  }, 20_000);
});
