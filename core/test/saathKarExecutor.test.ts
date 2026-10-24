import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import { openDatabase } from '../db/connection';
import { runMigrations } from '../db/migrations';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import type { ExecutionGrant } from '../security/types';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import type { ToolRunner, ToolExecutionContext, ToolExecutionResult } from '../runtime/toolRunner';
import { CoreToolRunner } from '../runtime/toolRunner';
import { parseInlineToolCall, type ModelToolCall, type ModelToolDefinition } from '../runtime/modelBackend';

const TOKEN = generateToken();
let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;

/** Scripted backend: turn 0 requests a tool call, turn 1 gives a final answer. */
class ScriptedToolBackend implements ModelBackend {
  turn = 0;
  toolName = 'read_file';
  seenToolResult = false;
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    // Detect that the tool result was fed back into the conversation.
    if (request.messages.some((m) => m.role === 'tool')) this.seenToolResult = true;
    const t = this.turn++;
    if (t === 0) {
      return { content: 'let me check', toolCalls: [{ name: this.toolName, arguments: this.toolName === 'run_command' ? { command: 'echo hi' } : { path: 'note.txt' } }], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    }
    return { content: 'The command printed hi.', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

class FakeToolRunner implements ToolRunner {
  calls: ModelToolCall[] = [];
  definitions(): ModelToolDefinition[] {
    return [
      { name: 'run_command', description: 'x', parameters: { type: 'object', properties: {} } },
      { name: 'read_file', description: 'x', parameters: { type: 'object', properties: {} } },
    ];
  }
  async run(call: ModelToolCall, _ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
    this.calls.push(call);
    return { status: 'succeeded', exitCode: 0, output: 'hi' };
  }
}

let backend: ScriptedToolBackend;
let toolRunner: FakeToolRunner;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

let n = 0;
const idemp = () => `idemp-saath-${++n}`;

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${a.status}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seedSaathKar(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({ currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false } }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  return { conversationId: conv.id, attemptId: attempt.id };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-saath-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new ScriptedToolBackend();
  toolRunner = new FakeToolRunner();
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: { backend, toolRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});
afterEach(async () => {
  ws.close();
  await api.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('M32 Core-owned execution (Saath Kar tool loop)', () => {
  it('runs a Core-owned tool-calling loop: executes the tool, records evidence, feeds results back, and completes', async () => {
    const { conversationId, attemptId } = await seedSaathKar('Read note.txt and tell me what it says.');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });

    const done = await pollAttempt(attemptId, (a) => a.status === 'completed');
    expect(done.status).toBe('completed');

    // The Core executed the tool, not the Extension Host.
    expect(toolRunner.calls).toHaveLength(1);
    expect(toolRunner.calls[0].name).toBe('read_file');
    expect(backend.seenToolResult).toBe(true);

    // Tool invocation recorded with truthful evidence.
    const toolInvocations = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(toolInvocations).toHaveLength(1);
    expect(toolInvocations[0].status).toBe('succeeded');
    expect(toolInvocations[0].exitCode).toBe(0);
    expect(toolInvocations[0].evidence.output).toBe('hi');

    // Two model invocations (tool-call turn + final answer), both succeeded.
    const modelInvocations = (await (await authedFetch(`/v1/attempts/${attemptId}/model-invocations`)).json()).modelInvocations;
    expect(modelInvocations).toHaveLength(2);
    expect(modelInvocations.every((m: any) => m.status === 'succeeded')).toBe(true);

    // Final assistant answer durably appended.
    const messages = (await (await authedFetch(`/v1/conversations/${conversationId}/messages`)).json()).messages;
    const assistant = messages.filter((m: any) => m.role === 'assistant');
    expect(assistant[assistant.length - 1].content).toBe('The command printed hi.');
  });
});

describe('M54 fail-closed run_command (executor)', () => {
  it('does not run an unapproved model-generated run_command and closes the invocation as failed instead of leaving it pending', async () => {
    backend.toolName = 'run_command';
    const { attemptId } = await seedSaathKar('Run echo and tell me what it printed.');
    await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    await pollAttempt(attemptId, (a) => a.status === 'completed');

    expect(toolRunner.calls).toHaveLength(0);
    const toolInvocations = (await (await authedFetch(`/v1/attempts/${attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(toolInvocations).toHaveLength(1);
    expect(toolInvocations[0].status).toBe('failed');
    expect(toolInvocations[0].evidence.resultCategory).toBe('security_kernel_authorization_denied');

    // A denied invocation is not evidence: the final answer must not be recorded as tool-grounded.
    const kinds = (db.all(
      "SELECT json_extract(metadata, '$.kind') AS kind FROM runtime_events WHERE entityId = ? AND eventType = 'final_verification_recorded'",
      [attemptId],
    ) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).not.toContain('tool_grounded_response');
  });
});

describe('parseInlineToolCall (small-model fallback)', () => {
  const names = ['run_command', 'read_file'];
  it('recovers a fenced JSON tool call a small model printed as content', () => {
    const content = '```json\n{"name":"run_command","arguments":{"command":["echo","KARKEDIKHA_OK"]}}\n```';
    expect(parseInlineToolCall(content, names)).toEqual({ name: 'run_command', arguments: { command: ['echo', 'KARKEDIKHA_OK'] } });
  });
  it('recovers a bare JSON object tool call with parameters alias', () => {
    expect(parseInlineToolCall('{"name":"read_file","parameters":{"path":"a.txt"}}', names)).toEqual({ name: 'read_file', arguments: { path: 'a.txt' } });
  });
  it('recovers the Qwen XML function protocol when Ollama returns it as content', () => {
    const content = [
      'I will create the requested file.',
      '<function=run_command>',
      '<parameter=command>',
      'echo "Hello from Saath Kar" > note-saath.txt',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    expect(parseInlineToolCall(content, names)).toEqual({
      name: 'run_command',
      arguments: { command: 'echo "Hello from Saath Kar" > note-saath.txt' },
    });
  });
  it('rejects ambiguous Qwen XML with more than one function block', () => {
    const content = '<function=read_file><parameter=path>a.txt</parameter></function>'
      + '<function=run_command><parameter=command>echo unsafe</parameter></function>';
    expect(parseInlineToolCall(content, names)).toBeNull();
  });
  it('does not misread a prose answer that merely mentions JSON', () => {
    expect(parseInlineToolCall('The result is stored as JSON with a name field.', names)).toBeNull();
  });
  it('ignores an unknown tool name', () => {
    expect(parseInlineToolCall('{"name":"delete_everything","arguments":{}}', names)).toBeNull();
  });
});

/** M54: consequential tools need an authoritative grant. Mint one the way an approved action does: a resolved approval row, then kernel.authorize. */
function approvedGrant(kernel: LocalAutonomySecurityKernel, kdb: CoreDatabase, cwd: string, call: ModelToolCall): ExecutionGrant {
  const attemptId = `att_fixture_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const approvalId = `appr_${attemptId}`;
  const now = new Date().toISOString();
  kdb.run('PRAGMA foreign_keys = OFF');
  kdb.run(
    `INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary) VALUES (?, ?, 'mutation', 'resolved', ?, ?, 'approved', ?)`,
    [approvalId, attemptId, now, now, JSON.stringify({ toolName: call.name })],
  );
  kdb.run('PRAGMA foreign_keys = ON');
  const isCommand = call.name === 'run_command';
  const req = kernel.normalizeRequest({
    attemptId,
    executor: 'core:tool_runner',
    capability: isCommand ? 'process' : 'filesystem',
    workspaceRoot: cwd,
    targetResource: isCommand ? cwd : path.resolve(cwd, String(call.arguments['path'] ?? '')),
    command: isCommand ? String(call.arguments['command'] ?? '') : null,
    arguments: call.arguments,
    riskLevel: 'consequential',
  });
  const decision = kernel.authorize(req, { approvalId });
  if (decision.decision !== 'ALLOW' || !decision.grant) throw new Error(`fixture grant denied: ${decision.reason}`);
  return decision.grant;
}

/** Runs one tool through a real CoreToolRunner with a real, kernel-minted grant. */
async function runGoverned(call: ModelToolCall, cwd: string): Promise<ToolExecutionResult> {
  const kdb = openDatabase(path.join(cwd, '..', `kernel-${path.basename(cwd)}.db`));
  try {
    runMigrations(kdb);
    const kernel = new LocalAutonomySecurityKernel(kdb, 'test-secret-key-32-bytes-secure!!');
    const grant = approvedGrant(kernel, kdb, cwd, call);
    return await new CoreToolRunner().run(call, { cwd, securityGrant: grant, securityKernel: kernel, attemptId: grant.attemptId });
  } finally {
    const file = path.join(cwd, '..', `kernel-${path.basename(cwd)}.db`);
    kdb.close();
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  }
}

describe('CoreToolRunner (real Core-owned tool process)', () => {
  it('runs a real command in the working directory and captures exit code + output', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-tool-'));
    try {
      const result = await runGoverned({ name: 'run_command', arguments: { command: 'echo karkedikha' } }, tmp);
      expect(result.status).toBe('succeeded');
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('karkedikha');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('writes exact UTF-8 content without shell-added quotes or newlines', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-tool-write-'));
    try {
      const result = await runGoverned({
        name: 'propose_file_change',
        arguments: { path: 'note-saath.txt', content: 'Hello from Saath Kar' },
      }, tmp);
      expect(result.status).toBe('succeeded');
      expect(fs.readFileSync(path.join(tmp, 'note-saath.txt'), 'utf8')).toBe('Hello from Saath Kar');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  (process.platform === 'win32' ? it : it.skip)('passes an approved Windows command string to cmd.exe without injecting literal escape backslashes', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-tool-cmd-quotes-'));
    try {
      const result = await runGoverned({
        name: 'run_command',
        arguments: { command: 'echo "Hello from Saath Kar" > note.txt' },
      }, tmp);
      expect(result.status).toBe('succeeded');
      const content = fs.readFileSync(path.join(tmp, 'note.txt'), 'utf8');
      expect(content).toBe('"Hello from Saath Kar" \r\n');
      expect(content).not.toContain('\\"');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('reads a file relative to the working directory and refuses path escape', async () => {
    const runner = new CoreToolRunner();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-tool-'));
    try {
      fs.writeFileSync(path.join(tmp, 'note.txt'), 'hello-core');
      const ok = await runner.run({ name: 'read_file', arguments: { path: 'note.txt' } }, { cwd: tmp });
      expect(ok.status).toBe('succeeded');
      expect(ok.output).toBe('hello-core');

      const escape = await runner.run({ name: 'read_file', arguments: { path: '../../../etc/passwd' } }, { cwd: tmp });
      expect(escape.status).toBe('failed');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

});
