/**
 * Saath Kar: repository-aware, inspectable, baseline-bound proposals.
 *
 * Covers the four properties this milestone had to make true, at the level
 * each one is actually enforced:
 *
 *  A. Repository-aware Saath — supplemental repository context is accepted for
 *     an explicit allowlist of conversation modes (Baat Kar and Saath Kar) and
 *     nothing else.
 *  B. Inspectable, deterministic proposal — the approval card's diff is frozen
 *     at proposal time and never recomputed against later bytes.
 *  C. Baseline-bound stale-proposal protection — for an existing file AND for
 *     a file that did not exist when the proposal was made, checked
 *     immediately before the mutation, surviving a restart because the
 *     baseline lives in the frozen approved action.
 *  D. Validation evidence — the workspace's own declared gate runs inside the
 *     already-approved operation, with no second approval.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { startApiServer, type RunningApiServer } from '../api/server';
import { attachWsServer } from '../ws/server';
import { EventBroadcaster } from '../ws/broadcaster';
import { latestSequence } from '../domain/events';
import { generateToken } from '../auth/token';
import { submitRequest } from '../domain/submission';
import { createConversation, listMessages } from '../domain/conversations';
import { getAttemptContext } from '../domain/attemptContext';
import { CoreError } from '../domain/errors';
import type { ModelBackend, ModelChatRequest, ModelChatResult, ModelChatMessage } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { LocalAutonomySecurityKernel } from '../security/kernel';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';
import { buildWriteFileProposal } from '../runtime/writeProposal';
import { discoverValidationGates, runWorkspaceValidation } from '../runtime/workspaceValidation';

const TOKEN = generateToken();

const ORIGINAL_CONTENT = 'line one\nline two\nline three\n';
const PROPOSED_CONTENT = 'line one\nline two changed\nline three\n';

/** Proposes one propose_file_change, then answers once the tool results come back. */
class WriteProposalBackend implements ModelBackend {
  targetPath = 'note.txt';
  content = PROPOSED_CONTENT;
  finalAnswer = 'Changed: note.txt. Validation: see the reported gate result.';
  lastMessages: ModelChatMessage[] = [];
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.lastMessages = request.messages.map((message) => ({ ...message }));
    const hasToolResult = request.messages.some((m) => m.role === 'tool');
    if (!hasToolResult) {
      return {
        content: 'Proposing the edit.',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: this.targetPath, content: this.content } }],
        provider: 'ollama', model: request.model, usage: { durationMs: 1 },
      };
    }
    return { content: this.finalAnswer, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: WriteProposalBackend;
let validationCommands: string[];
/** When set, the injected validation runner really executes the command instead of reporting success. */
let runValidationForReal = false;

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
const idemp = () => `idemp-saath-proposal-${++n}`;

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
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

async function seedSaathKarTurn(message: string) {
  const conv = await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id,
      contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false },
    }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  return { conversationId: conv.id as string, attemptId: attempt.id as string };
}

async function pendingWriteAction(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const own = snapshot.actions.filter((a: any) => a.actionable);
  expect(own).toHaveLength(1);
  return own[0];
}

async function actionById(conversationId: string, approvalId: string) {
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  return snapshot.actions.find((a: any) => a.approvalId === approvalId);
}

async function resolveApproval(action: any, resolution: 'approved' | 'rejected') {
  return jsonOf(await authedFetch(`/v1/capabilities/approvals/${action.approvalId}/resolve`, {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({
      resolution,
      attemptId: action.attemptId,
      expectedAttemptRevision: action.expectedAttemptRevision,
      expectedAttemptStatus: action.expectedAttemptStatus,
      requestedActionDigest: action.requestedActionDigest,
      frozenContextHash: action.frozenContextHash,
    }),
  }));
}


function grantFor(call: { name: string; arguments: Record<string, any> }) {
  const kernel = LocalAutonomySecurityKernel.getInstance(db);
  const attemptId = `att_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const approvalId = `appr_${attemptId}`;
  const now = new Date().toISOString();
  db.run('PRAGMA foreign_keys = OFF');
  db.run(
    `INSERT INTO approvals (id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary)
     VALUES (?, ?, 'mutation', 'resolved', ?, ?, 'approved', ?)`,
    [approvalId, attemptId, now, now, JSON.stringify({ toolName: call.name })],
  );
  db.run('PRAGMA foreign_keys = ON');

  const req = kernel.normalizeRequest({
    attemptId,
    executor: 'core:tool_runner',
    capability: 'filesystem',
    workspaceRoot: dir,
    targetResource: path.resolve(dir, String(call.arguments.path ?? '')),
    arguments: call.arguments,
    riskLevel: 'consequential',
  });
  const decision = kernel.authorize(req, { approvalId });
  if (decision.decision !== 'ALLOW' || !decision.grant) {
    throw new Error(`Failed to authorize grant: ${decision.reason}`);
  }
  return { grant: decision.grant, attemptId };
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-saath-proposal-test-'));
  fs.writeFileSync(path.join(dir, 'note.txt'), ORIGINAL_CONTENT, 'utf8');
  // The workspace declares exactly one mechanical gate; the constrained
  // post-mutation validation must discover and run that, and nothing else.
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { compile: 'tsc -p ./' } }), 'utf8');
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new WriteProposalBackend();
  validationCommands = [];
  runValidationForReal = false;
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
      backend, toolRunner: workspaceRunner, defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir,
      governedCapabilities: new GovernedCapabilityRegistry().register(governedWorkspace),
      validationCommandRunner: async (command, cwd) => {
        validationCommands.push(command);
        if (runValidationForReal) {
          const run = spawnSync(command, { cwd, shell: true, encoding: 'utf8', timeout: 30_000 });
          return { status: run.status === 0 ? 'succeeded' : 'failed', exitCode: run.status, output: `${run.stdout ?? ''}${run.stderr ?? ''}` };
        }
        return { status: 'succeeded', exitCode: 0, output: 'ok' };
      },
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

describe('bounded mutation proposal correction', () => {
  async function submitIntent(mutation: boolean, mode: 'saath_kar' | 'baat_kar' = 'saath_kar') {
    const conv = createConversation(db, { mode, actor: 'test' });
    const result = submitRequest(db, {
      clientId: 'test-client', currentMessage: mutation ? 'Update note.txt' : 'Explain note.txt', requestedMode: mode,
      conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(), effectiveAllowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'],
      modelSelection: {
        selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
        requiredCapabilities: { readOnlyExplanation: !mutation, repositoryExploration: true, toolCalling: mode === 'saath_kar', fileModification: mutation, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
      },
    });
    await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
    return result.attempt.id;
  }

  async function submitIntentWithConversation(mutation: boolean) {
    const conv = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const result = submitRequest(db, {
      clientId: 'test-client', currentMessage: 'Update note.txt', requestedMode: 'saath_kar',
      conversationId: conv.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true }, correlationId: idemp(), effectiveAllowedTools: ['read_file', 'run_command', 'propose_file_change', 'propose_text_edit'],
      modelSelection: {
        selectedProvider: 'ollama', selectedModel: 'fixture', selectionReason: 'test', suitabilitySummary: 'test', userOverrode: true, candidates: [], escalationCandidates: [],
        requiredCapabilities: { readOnlyExplanation: false, repositoryExploration: true, toolCalling: true, fileModification: mutation, codingComplexity: 'low', contextRequirement: 'small', vision: false, validationAndRepair: false },
      },
    });
    await authedFetch(`/v1/attempts/${result.attempt.id}/execute`, { method: 'POST', idempotencyKey: idemp() });
    return { conversationId: conv.id, attemptId: result.attempt.id };
  }

  it.each([true, false])('uses one correction and recovers=%s', async (recover) => {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async request => {
      requests.push({ ...request, messages: request.messages.map(m => ({ ...m })) });
      return {
        content: 'Here is a prose diff; please approve.', provider: 'ollama', model: request.model,
        toolCalls: recover && requests.length === 2 ? [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } }] : [],
        usage: { durationMs: 1 },
      };
    });
    const id = await submitIntent(true);
    const attempt = await pollAttempt(id, a => ['waiting_for_approval', 'failed'].includes(a.status));
    expect(requests).toHaveLength(2);
    expect(requests[1].messages.some(m => m.role === 'system' && m.content.includes('single corrective turn'))).toBe(true);
    expect(requests[1].messages.some(m => m.role === 'system' && m.content.includes('propose_file_change'))).toBe(true);
    expect(requests[1].messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_proposal_correction_started'", [id])).toHaveLength(1);
    if (recover) {
      expect(attempt.status).toBe('waiting_for_approval');
      expect(db.all("SELECT * FROM approvals WHERE json_extract(summary, '$.scopeIdentity') = ?", [id])).toHaveLength(1);
    } else {
      expect(attempt.failureReason).toContain('could not produce an actionable mutation proposal');
      expect(db.all('SELECT * FROM approvals')).toHaveLength(0);
    }
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(ORIGINAL_CONTENT);
  });

  // Golden G5: the title edit landed, then the model ended its turn with "I'll submit the complete file instead" and the
  // attempt completed with half the request undone.
  async function runAnnouncedButNotDone(secondReply: string, thirdReply: string) {
    const requests: ModelChatRequest[] = [];
    vi.spyOn(backend, 'streamChat').mockImplementation(async request => {
      requests.push({ ...request, messages: request.messages.map(m => ({ ...m })) });
      const tools = request.messages.filter(m => m.role === 'tool').length;
      if (requests.length === 1) return { content: 'Proposing the edit.', toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } }], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
      return { content: tools > 0 && requests.length === 2 ? secondReply : thirdReply, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    });
    const { conversationId, attemptId } = await submitIntentWithConversation(true);
    const action = await pendingWriteAction(conversationId, attemptId);
    await resolveApproval(action, 'approved');
    const attempt = await pollAttempt(attemptId, a => ['completed', 'failed'].includes(a.status));
    return { requests, attempt, attemptId };
  }

  it('grants one corrective turn when the final answer announces an action that was never performed, and does not fail the attempt', async () => {
    const { requests, attempt, attemptId } = await runAnnouncedButNotDone(
      "The edit didn't land. I'll submit the complete changed file as one self-contained proposal instead.",
      'The change is in place; nothing else was requested.',
    );
    expect(attempt.status).toBe('completed');
    expect(requests).toHaveLength(3);
    expect(requests[2].messages.some(m => m.role === 'system' && m.content.includes('ended your turn without doing it'))).toBe(true);
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_proposal_correction_started'", [attemptId])).toHaveLength(1);
  });

  it('a corrective turn that still does not act completes (a valid proposal exists) instead of failing', async () => {
    const { requests, attempt } = await runAnnouncedButNotDone("I'll now apply the rest of the change.", "I'll now apply the rest of the change.");
    expect(requests).toHaveLength(3);
    expect(attempt.status).toBe('completed');
  });

  // Golden I/G5: a proposal landed, then the model ended the turn with a blank message. Asking the model to narrate made a
  // weak model claim a summary card it never built, so the closing note is generated from recorded actions and the model is not asked.
  it('an empty final message after tool work completes with a note generated from the recorded actions, and no model narration is requested', async () => {
    const { requests, attempt, attemptId } = await runAnnouncedButNotDone('', '');
    expect(attempt.status).toBe('completed');
    // first empty completion -> the IDENTICAL request is retried once (no added prompt); a second empty one -> generated note
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[2].messages)).toBe(JSON.stringify(requests[1].messages));
    expect(requests.some(r => r.messages.some(m => m.role === 'system' && /tell the user what you did/i.test(m.content)))).toBe(false);
    const message = db.all("SELECT content FROM conversation_messages WHERE role = 'assistant' ORDER BY seq DESC LIMIT 1") as Array<{ content: string }>;
    expect(message[0].content).toContain('generated from the recorded actions');
    expect(message[0].content).toContain('propose_file_change (succeeded)');
    expect(message[0].content).toContain('Anything not listed here was not done');
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'empty_final_response_note_generated'", [attemptId])).toHaveLength(1);
  });

  it('offers, questions and finished-work summaries are not announced-but-not-done', async () => {
    for (const reply of ['Done. Want me to add a filter too?', "I've added the change. Let me know if you'd like anything else.", 'The change is applied.']) {
      vi.restoreAllMocks();
      const { requests, attempt } = await runAnnouncedButNotDone(reply, reply);
      expect(requests, reply).toHaveLength(2);
      expect(attempt.status, reply).toBe('completed');
    }
  });

  it.each(['saath_kar', 'baat_kar'] as const)('leaves ordinary %s final responses alone', async mode => {
    const spy = vi.spyOn(backend, 'streamChat').mockImplementation(async request => ({ content: 'Explanation.', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } }));
    const id = await submitIntent(false, mode);
    await pollAttempt(id, a => a.status === 'completed');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_proposal_correction_started'", [id])).toHaveLength(0);
  });

  it('uses the existing approval path for a direct mutation proposal', async () => {
    const spy = vi.spyOn(backend, 'streamChat');
    const id = await submitIntent(true);
    await pollAttempt(id, a => a.status === 'waiting_for_approval');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(db.all("SELECT * FROM runtime_events WHERE entityId = ? AND eventType = 'mutation_proposal_correction_started'", [id])).toHaveLength(0);
  });

  it('M45: a 40 KB propose_file_change gets a bounded approval summary and approving writes the exact bytes', async () => {
    const bigContent = `${'export const value = 1; // padding line\n'.repeat(1100)}`;
    expect(Buffer.byteLength(bigContent, 'utf8')).toBeGreaterThan(40_000);
    vi.spyOn(backend, 'streamChat').mockImplementation(async request => ({
      content: 'Proposing the edit.',
      toolCalls: request.messages.some(m => m.role === 'tool') ? [] : [{ name: 'propose_file_change', arguments: { path: 'big.ts', content: bigContent } }],
      provider: 'ollama', model: request.model, usage: { durationMs: 1 },
    }));
    const { conversationId, attemptId } = await submitIntentWithConversation(true);
    const action = await pendingWriteAction(conversationId, attemptId);
    expect(action.toolName).toBe('propose_file_change');
    const row = db.get<{ summary: string }>('SELECT summary FROM approvals WHERE id = ?', [action.approvalId])!;
    expect(Buffer.byteLength(row.summary, 'utf8')).toBeLessThanOrEqual(8192);
    // The restore listing shows the projected value, never the 40 KB body.
    expect(action.arguments.content).toMatchObject({ $bytes: Buffer.byteLength(bigContent, 'utf8') });
    expect(typeof action.arguments.content).toBe('object');

    await resolveApproval(action, 'approved');
    await pollAttempt(attemptId, a => a.status === 'completed' || a.status === 'failed');
    expect(fs.readFileSync(path.join(dir, 'big.ts'), 'utf8')).toBe(bigContent);
  });

  it('rejecting a direct propose_file_change proposal performs zero mutation', async () => {
    vi.spyOn(backend, 'streamChat').mockImplementation(async request => ({
      content: 'Proposing the edit.',
      toolCalls: request.messages.some(m => m.role === 'tool') ? [] : [{ name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } }],
      provider: 'ollama', model: request.model, usage: { durationMs: 1 },
    }));
    const { conversationId, attemptId } = await submitIntentWithConversation(true);
    const action = await pendingWriteAction(conversationId, attemptId);
    expect(action.toolName).toBe('propose_file_change');
    await resolveApproval(action, 'rejected');
    await pollAttempt(attemptId, a => a.status === 'cancelled' || a.status === 'failed');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(ORIGINAL_CONTENT);
    await expect(resolveApproval(action, 'approved')).rejects.toThrow();
  });
});

describe('Saath Kar model-visible tool exposure', () => {
  it('exposes propose_file_change and does not expose model-visible write_file', () => {
    const names = new CoreToolRunner().definitions().map(def => def.name);
    expect(names).toContain('propose_file_change');
    expect(names).not.toContain('write_file');
  });

  it('routes a propose_file_change call through the same write execution as before, gated on the frozen baseline', async () => {
    const runner = new CoreToolRunner();
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;
    const call = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    const { grant, attemptId } = grantFor(call);
    const result = await runner.run(
      call,
      { cwd: dir, expectedBaseline: proposal.expectedBaseline, securityGrant: grant, attemptId },
    );
    expect(result.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(PROPOSED_CONTENT);

    // An unknown/legacy tool name is not dispatched to the write path.
    const unknown = await runner.run({ name: 'write_file', arguments: { path: 'note.txt', content: 'x' } }, { cwd: dir });
    expect(unknown.status).toBe('failed');
    expect(unknown.output).toContain("unknown tool 'write_file'");
  });
});

describe('A. repository context is accepted for an explicit set of modes', () => {
  it('freezes supplemental repository context for Saath Kar', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    const result = submitRequest(db, {
      clientId: 'client-1', currentMessage: 'Rename the helper in note.txt', requestedMode: 'saath_kar',
      conversationId: conversation.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true },
      correlationId: 'saath-repo-context',
      repositoryContext: {
        prompt: '## Automatically selected repository context\n### note.txt\nline one',
        selectedFiles: [{ path: 'note.txt', estimatedTokens: 12 }],
        estimatedTokens: 20,
      },
    });
    const context = getAttemptContext(db, result.attempt.id);
    expect(context.repositoryContext?.prompt).toContain('note.txt');
    expect(context.permittedCapabilities.contextPolicy.includeRepositoryContext).toBe(true);
  });

  it('still refuses supplemental repository context for a mode outside the allowlist', () => {
    const conversation = createConversation(db, { mode: 'saath_kar', actor: 'test' });
    expect(() => submitRequest(db, {
      clientId: 'client-1', currentMessage: 'Ship the story', requestedMode: 'karke_dikha',
      conversationId: conversation.id, workspaceRoot: dir, capability: { hasWorkspace: true, gitCapable: true },
      correlationId: 'karke-repo-context',
      repositoryContext: { prompt: 'x', selectedFiles: [], estimatedTokens: 1 },
    })).toThrow(CoreError);
  });
});

describe('B/C. proposal-time diff and baseline identity', () => {
  it('captures an existing file as a hashed baseline and a new file as absent — never as an empty file', () => {
    const existing = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT });
    expect(existing?.expectedBaseline.kind).toBe('file');
    expect(existing?.presentation.diff).toContain('-line two');
    expect(existing?.presentation.diff).toContain('+line two changed');
    // Unchanged context lines are not re-listed as edits.
    expect(existing?.presentation.diff).not.toContain('-line one');

    const created = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'brand-new.txt', content: 'hello\n' });
    expect(created?.expectedBaseline).toEqual({ kind: 'absent' });
    expect(created?.presentation.baseline).toBe('absent');
    expect(created?.presentation.diff).toContain('+hello');
  });

  it('is deterministic for the same inputs', () => {
    const first = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT });
    const second = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT });
    expect(second?.presentation).toEqual(first?.presentation);
    expect(second?.expectedBaseline).toEqual(first?.expectedBaseline);
  });

  it('refuses a write whose file moved on since the proposal, and one whose new-file path now exists', async () => {
    const runner = new CoreToolRunner();
    const proposal = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;

    fs.writeFileSync(path.join(dir, 'note.txt'), 'someone else edited this\n', 'utf8');
    const staleCall = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    const { grant: staleGrant, attemptId: staleAttemptId } = grantFor(staleCall);
    const stale = await runner.run(
      staleCall,
      { cwd: dir, expectedBaseline: proposal.expectedBaseline, securityGrant: staleGrant, attemptId: staleAttemptId },
    );
    expect(stale.status).toBe('failed');
    expect(stale.resultCategory).toBe('write_stale_baseline');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('someone else edited this\n');

    // A "create this file" proposal must not overwrite a file that appeared
    // in the meantime.
    fs.writeFileSync(path.join(dir, 'appeared.txt'), 'not mine\n', 'utf8');
    const collidedCall = { name: 'propose_file_change', arguments: { path: 'appeared.txt', content: 'mine\n' } };
    const { grant: collidedGrant, attemptId: collidedAttemptId } = grantFor(collidedCall);
    const collided = await runner.run(
      collidedCall,
      { cwd: dir, expectedBaseline: { kind: 'absent' }, securityGrant: collidedGrant, attemptId: collidedAttemptId },
    );
    expect(collided.status).toBe('failed');
    expect(collided.resultCategory).toBe('write_stale_baseline');
    expect(fs.readFileSync(path.join(dir, 'appeared.txt'), 'utf8')).toBe('not mine\n');

    // An untouched baseline still writes.
    const fresh = buildWriteFileProposal({ workspaceRoot: dir, requestedPath: 'note.txt', content: PROPOSED_CONTENT })!;
    const okCall = { name: 'propose_file_change', arguments: { path: 'note.txt', content: PROPOSED_CONTENT } };
    const { grant: okGrant, attemptId: okAttemptId } = grantFor(okCall);
    const ok = await runner.run(
      okCall,
      { cwd: dir, expectedBaseline: fresh.expectedBaseline, securityGrant: okGrant, attemptId: okAttemptId },
    );
    expect(ok.status).toBe('succeeded');
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(PROPOSED_CONTENT);
  });
});

describe('D. the constrained validation plan', () => {
  it('discovers the workspace gate and reports it honestly when there is none', async () => {
    const gates = discoverValidationGates(dir);
    expect(gates.map((gate) => gate.command)).toEqual(['npm run compile']);

    const ran: string[] = [];
    const outcome = await runWorkspaceValidation({
      cwd: dir,
      runner: async (command) => { ran.push(command); return { status: 'failed', exitCode: 2, output: 'boom' }; },
    });
    expect(ran).toEqual(['npm run compile']);
    expect(outcome.ran).toBe(true);
    expect(outcome.passed).toBe(false);
    expect(outcome.summary).toContain('npm run compile');

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-no-gates-'));
    try {
      const none = await runWorkspaceValidation({ cwd: bare, runner: async () => { throw new Error('must not run'); } });
      expect(none.ran).toBe(false);
      expect(none.summary).toContain('no mechanical validation gate');
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('the Saath Kar journey end to end', () => {
  it('restores one identical pending proposal after a real Core restart without mutation or duplication', async () => {
    const turn = await seedSaathKarTurn('Change the second line of note.txt');
    await authedFetch(`/v1/attempts/${turn.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const before = await pendingWriteAction(turn.conversationId, turn.attemptId);
    const originalBytes = fs.readFileSync(path.join(dir, 'note.txt'), 'utf8');

    ws.close();
    await api.close();
    db.close();
    db = openCoreDatabase(path.join(dir, 'core.db')).db;
    broadcaster = new EventBroadcaster();
    backend = new WriteProposalBackend();
    api = await startApiServer({
      db, token: TOKEN, broadcaster, dataDir: dir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'restarted-test', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir: dir }),
      onShutdown: () => {},
      executorOptions: { backend, toolRunner: new CoreToolRunner(), defaultModel: 'qwen2.5-coder:1.5b', defaultWorkingDirectory: dir, dataDir: dir },
    });
    ws = attachWsServer({ httpServer: api.server, token: TOKEN, broadcaster, instanceId: 'restarted-test', latestSequence: () => latestSequence(db) });
    baseUrl = `http://127.0.0.1:${api.port}`;

    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(turn.conversationId)}`)).json();
    const pending = snapshot.actions.filter((action: any) => action.actionable);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ approvalId: before.approvalId, requestedActionDigest: before.requestedActionDigest });
    expect(pending[0].presentation.diff).toBe(before.presentation.diff);
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(originalBytes);
    expect(db.all('SELECT id FROM approvals WHERE id = ?', [before.approvalId])).toHaveLength(1);
  });

  it('shows the proposal-time diff, keeps showing that same diff after the workspace changes, and refuses the stale write', async () => {
    const turn = await seedSaathKarTurn('Change the second line of note.txt');
    await authedFetch(`/v1/attempts/${turn.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWriteAction(turn.conversationId, turn.attemptId);

    expect(action.toolName).toBe('propose_file_change');
    expect(action.presentation.kind).toBe('write_file_diff');
    expect(action.presentation.baseline).toBe('file');
    expect(action.presentation.diff).toContain('-line two');
    expect(action.presentation.diff).toContain('+line two changed');
    const proposedDiff = action.presentation.diff;

    // Someone edits the file after the proposal was made and before the
    // human approves it.
    fs.writeFileSync(path.join(dir, 'note.txt'), 'a completely different file\n', 'utf8');

    // The card re-derived from Core's durable state (what a restart renders)
    // still shows the SAME proposal — not a diff against the new bytes.
    const restored = await actionById(turn.conversationId, action.approvalId);
    expect(restored.presentation.diff).toBe(proposedDiff);

    await resolveApproval(action, 'approved');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');

    // The approved write was refused against the moved baseline, and the file
    // on disk is exactly what the other writer left.
    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe('a completely different file\n');
    const invocations = (await (await authedFetch(`/v1/attempts/${action.attemptId}/tool-invocations`)).json()).toolInvocations;
    const write = invocations.find((invocation: any) => invocation.toolName === 'propose_file_change');
    expect(write.status).toBe('failed');
    expect(String(write.evidence.output)).toContain('Stale proposal');
    // A refused mutation must not be followed by a validation claim.
    expect(validationCommands).toEqual([]);
  }, 20000);

  it('runs the workspace validation gate inside the approved operation, with no second approval', async () => {
    const turn = await seedSaathKarTurn('Change the second line of note.txt');
    await authedFetch(`/v1/attempts/${turn.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWriteAction(turn.conversationId, turn.attemptId);
    await resolveApproval(action, 'approved');
    await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'completed');

    expect(fs.readFileSync(path.join(dir, 'note.txt'), 'utf8')).toBe(PROPOSED_CONTENT);
    expect(validationCommands).toEqual(['npm run compile']);

    // Exactly one approval was ever requested for this journey.
    const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(turn.conversationId)}`)).json();
    expect(snapshot.actions).toHaveLength(1);
    expect(snapshot.actions.every((entry: any) => !entry.actionable)).toBe(true);

    // The model was told the real validation result before writing its answer.
    const validationMessages = backend.lastMessages.filter((message) => message.role === 'tool' && message.content.startsWith('[validation]'));
    expect(validationMessages).toHaveLength(1);
    expect(validationMessages[0].content).toContain('npm run compile');

    // …and it is durable evidence, not just prompt text: the approved write
    // on the capability anchor attempt, the validation on the Saath attempt
    // that owns the turn.
    const anchorInvocations = (await (await authedFetch(`/v1/attempts/${action.attemptId}/tool-invocations`)).json()).toolInvocations;
    expect(anchorInvocations.some((invocation: any) => invocation.toolName === 'propose_file_change' && invocation.status === 'succeeded')).toBe(true);
    const turnInvocations = (await (await authedFetch(`/v1/attempts/${turn.attemptId}/tool-invocations`)).json()).toolInvocations;
    const validation = turnInvocations.find((invocation: any) => invocation.toolName === 'workspace_validation');
    expect(validation.status).toBe('succeeded');
    expect(String(validation.evidence.output)).toContain('Validation: passed');
  }, 20000);
  it('g1: a syntactically broken changed cli.js fails the recorded validation, the task cannot complete, and the model prose cannot claim otherwise', async () => {
    runValidationForReal = true;
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node --version' } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'cli.js'), "'use strict';\n", 'utf8');
    backend.targetPath = 'cli.js';
    backend.content = "'use strict';\nconst x = 1;\n  }\n} catch (error) {\n  console.log(error.message);\n}\n";
    backend.finalAnswer = 'Done — delete now asks first.\n\nValidation: npm run test passed (4/4).\n\n> delete 1\nDelete #1: lunch - 12.00? (y/n)\nn\nCancelled.';

    const turn = await seedSaathKarTurn('Ask before an expense is deleted');
    await authedFetch(`/v1/attempts/${turn.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const action = await pendingWriteAction(turn.conversationId, turn.attemptId);
    await resolveApproval(action, 'approved');
    // The model keeps claiming success while the recorded validation is failing: never completed (M49 completion invariant).
    const settled = await pollAttempt(turn.attemptId, (attempt) => attempt.status === 'completed' || attempt.status === 'failed');
    expect(settled.status).toBe('failed');
    expect(settled.failureReason).toBe('bounded validation repair was exhausted');

    // The syntax floor ran first, through the same validation path, and its real failure is the recorded evidence.
    expect(validationCommands[0]).toBe('node --check "cli.js"');
    const turnInvocations = (await (await authedFetch(`/v1/attempts/${turn.attemptId}/tool-invocations`)).json()).toolInvocations;
    const validation = turnInvocations.find((invocation: any) => invocation.toolName === 'workspace_validation');
    expect(validation.status).toBe('failed');
    expect(String(validation.evidence.output)).toContain('Validation: failed');
    expect(String(validation.evidence.output)).toContain('SyntaxError');

    // The model was told it failed (normal repair feedback), not that it passed.
    const validationMessage = backend.lastMessages.find((message) => message.role === 'tool' && message.content.startsWith('[validation]'));
    expect(validationMessage?.content).toContain('Validation: failed');

    // The model's success claim and fabricated test output are never presented; the user sees the real, failed state.
    const finalMessage = [...listMessages(db, turn.conversationId)].reverse().find((message) => message.role === 'assistant');
    expect(finalMessage?.content).toContain('NOT complete');
    expect(finalMessage?.content).toContain('Validation: failed');
    expect(finalMessage?.content).not.toContain('Done');
    expect(finalMessage?.content).not.toContain('4/4');
    expect(finalMessage?.content).not.toContain('Cancelled.');
  }, 30000);
});
