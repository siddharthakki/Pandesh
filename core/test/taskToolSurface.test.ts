/**
 * M49.3 — task-scoped tool surface (docs/M49_3_DECISION.md).
 *
 *  1. Pure decision: a workspace code change gets the four workspace tools; anything uncertain keeps
 *     the full surface; generic programming wording is not mistaken for an external capability.
 *  2. Executor: what the model is offered, that a hidden tool is refused without running, that the
 *     decision is recorded, and that a resume after approval offers the identical surface.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation } from '../domain/conversations';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelToolCall } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { applyToolSurface, deriveToolSurface, WORKSPACE_CODE_CHANGE_TOOLS } from '../domain/taskToolSurface';

const codeChange = (objectiveText: string) => deriveToolSurface({ objectiveText, mutationPolicy: 'allowed', fileModificationRequired: true, hasWorkspace: true });

describe('1. deriveToolSurface / applyToolSurface (pure)', () => {
  it.each([
    'Adding an item with a negative quantity is accepted. Please fix it so negative or zero quantities are rejected.',
    'Rename the helper parseDate to parseIsoDate everywhere in src.',
    'Fix the off-by-one in pagination; the last page is missing one row.',
    // Generic programming words that must not look like external capabilities.
    'Process the input lines in order and print the total; the error message should name the bad line.',
    'The in-memory cache never expires entries; add a TTL.',
  ])('workspace code change: %s', (objective) => {
    expect(codeChange(objective)).toEqual({ surface: 'workspace_code_change', reason: 'workspace_code_change_objective' });
  });

  it.each([
    ['Fix the bug and email me the summary', 'objective_mentions_email'],
    ['Fix the date parser and add a meeting to my calendar for review', 'objective_mentions_calendar'],
    ['Update the README and remember that I prefer tabs', 'objective_mentions_memory'],
    ['Fix the scraper so it handles https://example.com/list', 'objective_mentions_web'],
    ['Fix the layout of the landing web page', 'objective_mentions_browser'],
    ['Change the config in C:\\Users\\me\\settings.json', 'objective_mentions_outside_workspace'],
    ['Fix the test and open a pull request', 'objective_mentions_github'],
    ['Restart the service after fixing the port', 'objective_mentions_system'],
    ['Find the runaway process 4242 and stop it.', 'objective_mentions_system'],
    ['Kill the node process that holds port 3000 and fix the server config', 'objective_mentions_system'],
  ])('keeps the full surface when the objective reaches outside the workspace: %s', (objective, reason) => {
    expect(codeChange(objective)).toEqual({ surface: 'full', reason });
  });

  it('keeps the full surface for read-only objectives, non-mutation tasks and missing workspaces', () => {
    expect(deriveToolSurface({ objectiveText: 'Fix it', mutationPolicy: 'denied', fileModificationRequired: true, hasWorkspace: true }).reason).toBe('read_only_objective');
    expect(deriveToolSurface({ objectiveText: 'Fix it', mutationPolicy: 'allowed', fileModificationRequired: false, hasWorkspace: true }).reason).toBe('no_file_modification_required');
    expect(deriveToolSurface({ objectiveText: 'Fix it', mutationPolicy: 'allowed', fileModificationRequired: true, hasWorkspace: false }).reason).toBe('no_workspace');
  });

  it('narrows to exactly the workspace tools, and never to a set missing one of them', () => {
    const all = [...WORKSPACE_CODE_CHANGE_TOOLS, 'gmail_send_draft', 'memory_remember'].map((name) => ({ name }));
    const decision = codeChange('Fix the bug in parser.js');
    expect(applyToolSurface(all, decision).tools.map((tool) => tool.name).sort()).toEqual([...WORKSPACE_CODE_CHANGE_TOOLS].sort());
    const missingEdit = all.filter((tool) => tool.name !== 'propose_text_edit');
    const fallback = applyToolSurface(missingEdit, decision);
    expect(fallback.decision).toEqual({ surface: 'full', reason: 'workspace_tools_unavailable' });
    expect(fallback.tools).toHaveLength(missingEdit.length);
  });
});

// ── executor ────────────────────────────────────────────────────────────────

const TOKEN = generateToken();
type Script = (request: ModelChatRequest, call: number) => { content: string; toolCalls?: ModelToolCall[] };
class ScriptedBackend implements ModelBackend {
  calls = 0;
  requests: ModelChatRequest[] = [];
  constructor(public script: Script) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })), tools: [...(request.tools ?? [])] });
    const out = this.script(request, ++this.calls);
    return { content: out.content, toolCalls: out.toolCalls ?? [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let memoryRuns: number;
let n = 0;
const idemp = () => `idemp-surface-${++n}`;
const ALL_PERMITTED = [...WORKSPACE_CODE_CHANGE_TOOLS, 'memory_remember'];

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client', ...(init.headers as Record<string, string> | undefined) };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}
async function jsonOf(res: Response) { expect(res.ok).toBe(true); return res.json(); }
async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settled = (a: any) => a.status === 'completed' || a.status === 'failed' || a.status === 'waiting_for_approval';
async function runTurn(message: string) {
  const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: message, requestedMode: 'saath_kar',
    conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: false }, correlationId: idemp(),
    effectiveAllowedTools: ALL_PERMITTED,
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
    },
  });
  const attemptId = result.attempt.id as string;
  await authedFetch(`/v1/attempts/${attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return { conversationId: conv.id as string, attemptId, finished: await pollAttempt(attemptId, settled) };
}
const offered = (request: ModelChatRequest) => (request.tools ?? []).map((tool) => tool.name).sort();
const policyDecided = (attemptId: string) => JSON.parse((db.get("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_policy_decided'", [attemptId]) as { metadata: string }).metadata);

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-surface-test-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\nline two\nline three\n', 'utf8');
  memoryRuns = 0;
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  const workspaceRunner = new CoreToolRunner();
  const workspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  const memory: GovernedCapabilityAdapter = {
    id: 'memory',
    definitions: () => [{ name: 'memory_remember', description: 'Remember a fact.', parameters: { type: 'object', properties: { subject: { type: 'string' } }, required: ['subject'] } }],
    classify: (toolName): CapabilityRisk | undefined => (toolName === 'memory_remember' ? 'read_only' : undefined),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async () => { memoryRuns += 1; return { status: 'succeeded', exitCode: 0, output: 'remembered' }; },
  };
  backend = new ScriptedBackend(() => ({ content: 'Done.' }));
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      backend: { streamChat: (request, onToken) => backend.streamChat(request) } as ModelBackend,
      toolRunner: workspaceRunner, defaultModel: 'fixture', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(workspace).register(memory),
      validationCommandRunner: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('2. executor applies the surface from the frozen context', () => {
  it('offers only the workspace tools for a workspace code change, records why, and refuses a hidden tool without running it', async () => {
    backend.script = (request, call) => (call === 1
      ? { content: '', toolCalls: [{ name: 'memory_remember', arguments: { subject: 'negative amounts' } }] }
      : { content: 'Nothing changed.' });
    const turn = await runTurn('Change line two of note.txt to say line 2');

    expect(offered(backend.requests[0])).toEqual([...WORKSPACE_CODE_CHANGE_TOOLS].sort());
    expect(policyDecided(turn.attemptId)).toMatchObject({ toolSurface: 'workspace_code_change', toolSurfaceReason: 'workspace_code_change_objective' });
    expect(memoryRuns).toBe(0);
    expect(backend.requests[1].messages.some((message) => message.role === 'system' && message.content.includes("unknown_tool: 'memory_remember' is not an available tool"))).toBe(true);
  }, 30000);

  it('keeps the full permitted surface when the objective names an outside capability', async () => {
    const turn = await runTurn('Change line two of note.txt and remember that I prefer short lines');
    expect(offered(backend.requests[0])).toEqual([...ALL_PERMITTED].sort());
    expect(policyDecided(turn.attemptId)).toMatchObject({ toolSurface: 'full', toolSurfaceReason: 'objective_mentions_memory' });
  }, 30000);

  it('a resume after approval offers the identical workspace surface', async () => {
    backend.script = (request) => (request.messages.some((message) => message.role === 'tool')
      ? { content: 'Changed note.txt.' }
      : { content: '', toolCalls: [{ name: 'propose_text_edit', arguments: { path: 'note.txt', find: 'line two', replace: 'line 2' } }] });
    const turn = await runTurn('Change line two of note.txt to say line 2');
    expect(turn.finished.status).toBe('waiting_for_approval');
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(turn.conversationId)}`)).json();
    const action = snapshot.actions.find((a: any) => a.actionable);
    await jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
      method: 'POST', idempotencyKey: idemp(),
      body: JSON.stringify({
        resolution: 'approved', attemptId: action.attemptId, expectedAttemptRevision: action.expectedAttemptRevision,
        expectedAttemptStatus: action.expectedAttemptStatus, requestedActionDigest: action.requestedActionDigest, frozenContextHash: action.frozenContextHash,
      }),
    }));
    const done = await pollAttempt(turn.attemptId, (a) => a.status === 'completed' || a.status === 'failed');
    expect(done.status).toBe('completed');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\nline 2\nline three\n');
    expect(backend.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of backend.requests) expect(offered(request)).toEqual([...WORKSPACE_CODE_CHANGE_TOOLS].sort());
  }, 30000);
});
