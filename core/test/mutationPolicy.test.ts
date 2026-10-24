/**
 * Explicit read-only objectives establish a runtime-level mutationPolicy=denied.
 *
 * Root cause this guards (proven from a real run's Core DB): the objective
 * "Inspect this workspace ... Do not modify any files." was recorded with
 * requiredCapabilities.fileModification=true because a negation-blind keyword
 * test matched the word "modify". The executor then treated the task as
 * mutation-expecting, and when the model answered without a proposal it
 * injected "The requested task requires a file modification..." — after which
 * the model proposed a (no-op) propose_file_change for a read-only task.
 *
 * The integration tests below deliberately feed Core that SAME stale
 * fileModification=true metadata, so they prove enforcement is independent of
 * upstream classification.
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
import {
  checkToolCallAgainstMutationPolicy, deriveMutationPolicy, isNonMutatingShellCommand, isToolExposedUnderMutationPolicy, objectiveHash,
} from '../domain/mutationPolicy';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { classifyTaskRequirements } from '../../src/models/TaskModelSelection';
import { createSystemManagementCapabilityAdapter } from '../runtime/systemManagementCapability';

const TOKEN = generateToken();
const READ_ONLY_OBJECTIVE = 'Inspect this workspace and explain what this project does, its main components, and how it is run. Do not modify any files.';
const CODING_OBJECTIVE_A = 'lets build an html with login page';
const STALE_A_MARKER = '<!-- STALE_OBJECTIVE_A_LOGIN_PAGE -->';

describe('deriveMutationPolicy', () => {
  it.each([
    READ_ONLY_OBJECTIVE,
    'Read package.json and explain the scripts. Do not modify files.',
    'This is a read-only task: list the source files.',
    'Summarize the repo, inspection only.',
    'Explain the architecture without modifying anything.',
    "Look around but don't change any files.",
  ])('denies an explicit read-only objective: %s', (text) => {
    expect(deriveMutationPolicy(text)).toBe('denied');
  });

  it.each([
    'lets build an html with login page',
    'Update note.txt so it says hello',
    'Fix the failing test. Do not modify the tests to make them pass.',
    'Add a login page. Do not modify unrelated files.',
    'Refactor the parser. Do not modify tests.',
    'Create login.html. Do not modify any files.', // contradictory: a positive directive keeps it allowed
    'Explain how the cache works.',
  ])('leaves policy allowed when the objective is not explicitly read-only: %s', (text) => {
    expect(deriveMutationPolicy(text)).toBe('allowed');
  });

  it('does not let a read-only objective be classified as file-mutating for model selection', () => {
    const requirements = classifyTaskRequirements(READ_ONLY_OBJECTIVE);
    expect(requirements.fileMutation).toBe(false);
    expect(requirements.requiredCapabilities).not.toContain('file-mutation');
    // Ordinary mutation wording is unaffected.
    expect(classifyTaskRequirements('Update note.txt so it says hello').fileMutation).toBe(true);
    expect(classifyTaskRequirements('Fix the bug. Do not modify unrelated files.').fileMutation).toBe(true);
  });

  it('gates tool calls: mutating tools and mutating shell commands are denied, reads are allowed', () => {
    const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args });
    for (const name of ['propose_file_change', 'propose_text_edit', 'write_file', 'delete_file', 'rename_file', 'apply_patch', 'git_commit']) {
      expect(checkToolCallAgainstMutationPolicy('denied', call(name)).allowed).toBe(false);
      expect(checkToolCallAgainstMutationPolicy('allowed', call(name)).allowed).toBe(true);
    }
    expect(checkToolCallAgainstMutationPolicy('denied', call('read_file', { path: 'a.txt' })).allowed).toBe(true);
    for (const command of ['dir /s /b', 'ls -la', 'cat README.md', 'grep -rn foo src', 'git status', 'git log --oneline', 'git diff', 'node --version', 'type package.json | findstr name']) {
      expect(isNonMutatingShellCommand(command), command).toBe(true);
    }
    for (const command of ['del note.txt', 'rm -rf src', 'echo hi > out.txt', 'git commit -am x', 'git checkout .', 'git branch -D x', 'npm install', 'find . -delete', 'ls && rm a', 'cat a | tee b', 'Set-Content a.txt hi', 'sort -o a a']) {
      expect(isNonMutatingShellCommand(command), command).toBe(false);
    }
  });

  it('hashes objectives so two objectives are provably distinct', () => {
    expect(objectiveHash(CODING_OBJECTIVE_A)).not.toBe(objectiveHash(READ_ONLY_OBJECTIVE));
    expect(objectiveHash(READ_ONLY_OBJECTIVE)).toBe(objectiveHash(READ_ONLY_OBJECTIVE));
  });
});

/** Scripted model. `script(objective, turn, request)` decides each turn. */
type Script = (objective: string, turn: number, request: ModelChatRequest) => Omit<ModelChatResult, 'provider' | 'model' | 'usage'>;
class ScriptedBackend implements ModelBackend {
  requests: ModelChatRequest[] = [];
  constructor(public script: Script) {}
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    const snapshot = { ...request, messages: request.messages.map((m) => ({ ...m })) };
    this.requests.push(snapshot);
    const objective = [...request.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
    const turn = request.messages.filter((m) => m.role === 'tool').length;
    return { ...this.script(objective, turn, request), provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let baseUrl: string;
let backend: ScriptedBackend;
let n = 0;
let systemScripts: string[] = [];
const SYSTEM_TOOLS = ['system_list_processes', 'system_kill_process', 'system_list_services', 'system_start_service', 'system_stop_service', 'system_list_startup_items', 'system_set_scheduled_task_enabled'];
const idemp = () => `idemp-mutation-policy-${++n}`;

function authedFetch(p: string, init: RequestInit & { idempotencyKey?: string } = {}) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', 'X-Client-Id': 'test-client',
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.idempotencyKey) headers['Idempotency-Key'] = init.idempotencyKey;
  return fetch(`${baseUrl}${p}`, { ...init, headers });
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const attempt = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(attempt)) return attempt;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${attempt.status} reason=${attempt.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Submits with the STALE metadata from the real defect: fileModification=true. */
async function submitObjective(conversationId: string, objective: string) {
  const result = submitRequest(db, {
    clientId: 'test-client', currentMessage: objective, requestedMode: 'saath_kar',
    conversationId, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(),
    effectiveAllowedTools: ['run_command', 'read_file', 'propose_file_change', 'propose_text_edit', ...SYSTEM_TOOLS],
    modelSelection: {
      selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: true, codingComplexity: 'medium', contextRequirement: 'medium', vision: false, validationAndRepair: false },
    },
  });
  await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
  return result.attempt.id;
}

const events = (attemptId: string, eventType: string) =>
  db.all<{ metadata: string }>('SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = ?', [attemptId, eventType]);
const proposalApprovals = (attemptId: string) =>
  db.all("SELECT id FROM approvals WHERE json_extract(summary, '$.scopeIdentity') = ? AND json_extract(summary, '$.toolName') IN ('propose_file_change', 'propose_text_edit')", [attemptId]);
const statuses = (attemptId: string) =>
  db.all<{ metadata: string }>("SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'attempt_transitioned' ORDER BY sequence", [attemptId]).map((row) => JSON.parse(row.metadata).to as string);

beforeEach(async () => {
  systemScripts = [];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-mutation-policy-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), 'line one\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'README.md'), '# Fixture\n', 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  const broadcaster = new EventBroadcaster();
  backend = new ScriptedBackend(() => ({ content: 'ok', toolCalls: [] }));
  const workspaceRunner = new CoreToolRunner();
  const governedWorkspace: GovernedCapabilityAdapter = {
    id: 'workspace',
    definitions: () => workspaceRunner.definitions(),
    classify: (toolName): CapabilityRisk => (toolName === 'read_file' ? 'read_only' : 'consequential'),
    health: (): CapabilityHealth => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: (call, context) => workspaceRunner.run(call, context),
  };
  api = await startApiServer({
    db, token: TOKEN, broadcaster, dataDir: dir,
    coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
    onShutdown: () => {},
    executorOptions: {
      get backend() { return backend; }, toolRunner: workspaceRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace).register(createSystemManagementCapabilityAdapter({
        runScript: async (script) => { systemScripts.push(script); return { succeeded: true, output: '[]' } as any; },
        // The termination tool binds the target's identity into the approval,
        // so the test reads the identity of a fixed target instead of querying
        // the real machine.
        identityProvider: async (pid: number) => ({
          pid,
          alive: true,
          executablePath: 'C:\\Users\\test\\runaway.exe',
          creationTimeMs: 1_700_000_000_000,
          commandLine: 'runaway.exe',
        }),
      })),
    },
  });
  ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'test', latestSequence: () => latestSequence(db) });
  baseUrl = `http://127.0.0.1:${api.port}`;
});

afterEach(async () => {
  ws?.close();
  await api?.close();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('read-only objective under Core (stale fileModification=true metadata)', () => {
  it('1+5. explicit read-only inspection → zero proposals, no nudge, completes without ever waiting for approval', async () => {
    backend.script = (_o, turn) => turn === 0
      ? { content: 'Reading.', toolCalls: [{ name: 'read_file', arguments: { path: 'README.md' } }] }
      : { content: 'This project is a fixture.', toolCalls: [] };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    const attempt = await pollAttempt(id, (a) => ['completed', 'failed', 'waiting_for_approval'].includes(a.status));
    expect(attempt.status).toBe('completed');
    expect(statuses(id)).not.toContain('waiting_for_approval');
    expect(proposalApprovals(id)).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
    // No system message anywhere in any model request claims a modification is required.
    for (const request of backend.requests) {
      expect(request.messages.some((m) => m.role === 'system' && /requires a file modification/i.test(m.content))).toBe(false);
    }
    expect(backend.requests.some((r) => r.messages.some((m) => m.role === 'system' && m.content.includes('Mutation policy for this objective: DENIED')))).toBe(true);
    // Mutating tools were never even exposed to the model.
    for (const request of backend.requests) {
      const names = (request.tools ?? []).map((t) => t.name);
      expect(names).toContain('read_file');
      expect(names).not.toContain('propose_file_change');
      expect(names).not.toContain('propose_text_edit');
    }
    const decided = JSON.parse(events(id, 'mutation_policy_decided')[0].metadata);
    expect(decided).toMatchObject({ mutationPolicy: 'denied', objectiveHash: objectiveHash(READ_ONLY_OBJECTIVE), fileModificationRequired: false });
  });

  it('1b. a model that answers directly without any tool is not nudged or forced into a proposal', async () => {
    backend.script = () => ({ content: 'Answer without reading.', toolCalls: [] });
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    await pollAttempt(id, (a) => a.status === 'completed');
    expect(backend.requests).toHaveLength(1);
    expect(events(id, 'mutation_proposal_correction_started')).toHaveLength(0);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
  });

  it('2. a model that attempts propose_file_change / a mutating shell command is deterministically rejected', async () => {
    backend.script = (_o, turn) => {
      if (turn === 0) return { content: 'Proposing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: 'hacked\n' } }] };
      if (turn === 1) return { content: 'Deleting.', toolCalls: [{ name: 'run_command', arguments: { command: 'del note.txt' } }] };
      return { content: 'Understood; here is the explanation.', toolCalls: [] };
    };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    const attempt = await pollAttempt(id, (a) => ['completed', 'failed', 'waiting_for_approval'].includes(a.status));
    expect(attempt.status).toBe('completed');
    expect(events(id, 'mutation_denied_by_policy')).toHaveLength(2);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(db.all("SELECT id FROM tool_invocations WHERE toolName IN ('propose_file_change', 'run_command')")).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\n');
    const toolMessages = backend.requests.at(-1)!.messages.filter((m) => m.role === 'tool').map((m) => m.content);
    expect(toolMessages.some((c) => c.includes('DENIED by the read-only mutation policy'))).toBe(true);
  });

  it('3. previous coding task A then read-only task B → nothing from A is reused for B', async () => {
    backend.script = (objective, turn) => {
      if (objective === CODING_OBJECTIVE_A) {
        return turn === 0
          ? { content: 'Proposing login.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'login.html', content: `<html>${STALE_A_MARKER}</html>\n` } }] }
          : { content: 'Done.', toolCalls: [] };
      }
      return { content: 'It is a fixture project.', toolCalls: [] };
    };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const attemptA = await submitObjective(conv.id, CODING_OBJECTIVE_A);
    await pollAttempt(attemptA, (a) => a.status === 'waiting_for_approval');
    expect(proposalApprovals(attemptA)).toHaveLength(1);

    const requestsBeforeB = backend.requests.length;
    const attemptB = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    await pollAttempt(attemptB, (a) => ['completed', 'failed'].includes(a.status));

    expect(proposalApprovals(attemptB)).toHaveLength(0);
    expect(events(attemptB, 'mutation_proposal_correction_started')).toHaveLength(0);
    const bRequests = backend.requests.slice(requestsBeforeB);
    expect(bRequests.length).toBeGreaterThan(0);
    for (const request of bRequests) {
      expect(JSON.stringify(request.messages)).not.toContain(STALE_A_MARKER);
    }
    const hashA = JSON.parse(events(attemptA, 'mutation_policy_decided')[0].metadata).objectiveHash;
    const hashB = JSON.parse(events(attemptB, 'mutation_policy_decided')[0].metadata).objectiveHash;
    expect(hashA).toBe(objectiveHash(CODING_OBJECTIVE_A));
    expect(hashB).toBe(objectiveHash(READ_ONLY_OBJECTIVE));
    expect(hashA).not.toBe(hashB);
  });

  it('4. an ordinary coding task still gets the normal governed proposal + approval (also with a narrow "do not modify unrelated files" constraint)', async () => {
    backend.script = (_o, turn) => turn === 0
      ? { content: 'Proposing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: 'line one\nline two\n' } }] }
      : { content: 'Done.', toolCalls: [] };
    for (const objective of [CODING_OBJECTIVE_A, 'Add a second line to note.txt. Do not modify unrelated files.']) {
      const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
      const id = await submitObjective(conv.id, objective);
      await pollAttempt(id, (a) => a.status === 'waiting_for_approval');
      expect(proposalApprovals(id)).toHaveLength(1);
      expect(events(id, 'mutation_denied_by_policy')).toHaveLength(0);
      expect(JSON.parse(events(id, 'mutation_policy_decided')[0].metadata).mutationPolicy).toBe('allowed');
      const names = (backend.requests.at(-1)!.tools ?? []).map((t) => t.name);
      expect(names).toContain('propose_file_change');
    }
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\n');
  });
});

describe('read-only means no state-changing capability, not merely no file writes', () => {
  const call = (name: string, args: Record<string, unknown> = {}) => ({ name, arguments: args });
  const READ_ONLY_TOOLS = ['read_file', 'system_list_processes', 'system_list_services', 'system_list_startup_items'];
  const risk = (name: string) => (READ_ONLY_TOOLS.includes(name) ? 'read_only' as const : 'consequential' as const);

  it('unit: state-changing system tools are denied, informational ones allowed, unknown tools fail closed', () => {
    for (const name of ['system_kill_process', 'system_start_service', 'system_stop_service', 'system_set_scheduled_task_enabled', 'connect_network_drive', 'github_comment_on_issue', 'memory_forget', 'some_future_tool']) {
      expect(checkToolCallAgainstMutationPolicy('denied', call(name), risk).allowed, name).toBe(false);
      expect(checkToolCallAgainstMutationPolicy('allowed', call(name), risk).allowed, name).toBe(true);
      expect(isToolExposedUnderMutationPolicy('denied', name, risk), name).toBe(false);
    }
    // An adapter that misclassifies a known state-changing tool as read_only is still denied.
    expect(checkToolCallAgainstMutationPolicy('denied', call('system_kill_process'), () => 'read_only').allowed).toBe(false);
    for (const name of ['read_file', 'system_list_processes', 'system_list_services', 'system_list_startup_items', 'list_directory_outside_workspace']) {
      expect(checkToolCallAgainstMutationPolicy('denied', call(name), risk).allowed, name).toBe(true);
      expect(isToolExposedUnderMutationPolicy('denied', name, risk), name).toBe(true);
    }
    expect(checkToolCallAgainstMutationPolicy('denied', call('run_command', { command: 'git status' }), risk).allowed).toBe(true);
    expect(isToolExposedUnderMutationPolicy('denied', 'run_command', risk)).toBe(true);
    for (const command of ['Stop-Process -Id 4', 'Disable-ScheduledTask -TaskName x', 'Start-Service foo', 'pip install x', 'git push', 'git config user.name x', 'winget install x']) {
      expect(isNonMutatingShellCommand(command), command).toBe(false);
    }
  });

  it('read-only objective: process kill, scheduled-task enable/disable and file mutation are rejected by runtime governance even when the model requests them', async () => {
    backend.script = (_o, turn) => {
      if (turn === 0) return { content: 'Killing.', toolCalls: [{ name: 'system_kill_process', arguments: { pid: 4242 } }] };
      if (turn === 1) return { content: 'Disabling.', toolCalls: [{ name: 'system_set_scheduled_task_enabled', arguments: { taskName: 'Backup', taskPath: '\\', enabled: false } }] };
      if (turn === 2) return { content: 'Enabling.', toolCalls: [{ name: 'system_set_scheduled_task_enabled', arguments: { taskName: 'Backup', taskPath: '\\', enabled: true } }] };
      if (turn === 3) return { content: 'Writing.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: 'x\n' } }] };
      return { content: 'Understood; explanation only.', toolCalls: [] };
    };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    const attempt = await pollAttempt(id, (a) => ['completed', 'failed', 'waiting_for_approval'].includes(a.status));
    expect(attempt.status).toBe('completed');
    const denied = events(id, 'mutation_denied_by_policy').map((row) => JSON.parse(row.metadata).toolName);
    expect(denied).toEqual(['system_kill_process', 'system_set_scheduled_task_enabled', 'system_set_scheduled_task_enabled', 'propose_file_change']);
    expect(db.all('SELECT id FROM approvals')).toHaveLength(0);
    expect(db.all("SELECT id FROM tool_invocations WHERE toolName LIKE 'system_%' OR toolName = 'propose_file_change'")).toHaveLength(0);
    expect(systemScripts).toHaveLength(0);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('line one\n');
    for (const request of backend.requests) {
      const names = (request.tools ?? []).map((t) => t.name);
      for (const blocked of ['system_kill_process', 'system_start_service', 'system_stop_service', 'system_set_scheduled_task_enabled', 'propose_file_change']) expect(names).not.toContain(blocked);
      expect(names).toEqual(expect.arrayContaining(['read_file', 'system_list_processes']));
    }
  });

  it('read-only objective: process/status inspection is allowed and executes', async () => {
    backend.script = (_o, turn) => turn === 0
      ? { content: 'Inspecting.', toolCalls: [{ name: 'system_list_processes', arguments: {} }] }
      : { content: 'Processes listed.', toolCalls: [] };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, READ_ONLY_OBJECTIVE);
    const attempt = await pollAttempt(id, (a) => ['completed', 'failed', 'waiting_for_approval'].includes(a.status));
    expect(attempt.status).toBe('completed');
    expect(events(id, 'mutation_denied_by_policy')).toHaveLength(0);
    expect(systemScripts.some((script) => script.includes('Get-Process'))).toBe(true);
    expect(systemScripts.some((script) => /Stop-Process/.test(script))).toBe(false);
  });

  it('normal coding objective still receives the governed system capabilities and gates them behind approval', async () => {
    backend.script = (_o, turn) => turn === 0
      ? { content: 'Stopping.', toolCalls: [{ name: 'system_kill_process', arguments: { pid: 4242 } }] }
      : { content: 'Done.', toolCalls: [] };
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const id = await submitObjective(conv.id, 'Find the runaway process 4242 and stop it.');
    await pollAttempt(id, (a) => a.status === 'waiting_for_approval');
    const names = (backend.requests.at(-1)!.tools ?? []).map((t) => t.name);
    for (const exposed of [...SYSTEM_TOOLS, 'propose_file_change', 'propose_text_edit', 'read_file', 'run_command']) expect(names).toContain(exposed);
    expect(events(id, 'mutation_denied_by_policy')).toHaveLength(0);
    expect(systemScripts.some((script) => /Stop-Process/.test(script))).toBe(false); // not executed before approval
    expect(db.all('SELECT id FROM approvals')).toHaveLength(1);
  });
});
