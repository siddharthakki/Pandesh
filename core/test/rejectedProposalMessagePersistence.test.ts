/**
 * Regression test for a Guardian P0 restart-restore failure: a Saath Kar
 * attempt's assistant text that PROPOSES a governed write (and includes a
 * literal, unparsed `<function=propose_file_change>...` block because the model used
 * the textual/inline tool-call fallback — see `parseInlineToolCall` in
 * `core/runtime/modelBackend.ts`) rendered live but silently vanished from
 * the durable, restorable conversation history after the attempt was
 * REJECTED and a second attempt on the same conversation was later approved.
 *
 * Root cause (`core/runtime/executor.ts`'s `runLoopTurns`): the only call to
 * `appendMessage`/`appendAssistant` for an assistant turn happened when the
 * model's turn produced NO further tool calls (the "final answer" branch).
 * A turn that DOES propose a tool call only pushed its text into the
 * in-process `messages` array (context for the next model call) and into the
 * `attempt_loop_continuations` checkpoint payload — neither of which
 * `restoreConversationTranscript` (`src/ui/AgentPanel.ts`) or its Core
 * equivalent, `listMessages` (`core/domain/conversations.ts`), ever reads.
 * So a proposal turn that gets rejected (and therefore never reaches a
 * "final answer" turn) is never durably recorded at all — reproduced here
 * end-to-end against the real packaged HTTP surface, mirroring
 * `m38SaathKarCapabilityLoop.test.ts`'s harness.
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
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import { CoreToolRunner } from '../runtime/toolRunner';
import { GovernedCapabilityRegistry } from '../runtime/governedCapability';
import type { GovernedCapabilityAdapter, CapabilityHealth, CapabilityRisk } from '../runtime/governedCapability';

const TOKEN = generateToken();

const RAW_PROPOSAL_TEXT = 'I\'ll create the file note-saath.txt with the content "Hello from Saath Kar" as requested.'
  + '\n\n<function=propose_file_change>\n<parameter=path>\nnote-saath.txt\n</parameter>\n<parameter=content>\nHello from Saath Kar\n</parameter>\n</function>';
const FINAL_CONFIRMATION_TEXT = "I've successfully created the file note-saath.txt with the content \"Hello from Saath Kar\".";

/**
 * Mirrors the two real generation shapes seen in production for the same
 * governed write across two attempts on one conversation: the first (later
 * rejected) attempt's model used the textual/inline fallback, so its
 * proposal text is visible, non-empty chat content with an embedded
 * `<function=...>` block; the second (later approved) attempt's model used
 * the native `tool_calls` channel, so its proposal turn has empty visible
 * content (nothing for a human to read) and only its post-execution final
 * answer has real text.
 */
class SwitchableProposalBackend implements ModelBackend {
  mode: 'xml_proposal' | 'native_proposal' | 'xml_proposal_then_final' = 'xml_proposal';
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    const hasToolResult = request.messages.some((m) => m.role === 'tool');
    if (this.mode === 'xml_proposal') {
      if (hasToolResult) throw new Error('the rejected attempt must never reach a tool result');
      return { content: RAW_PROPOSAL_TEXT, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    }
    if (this.mode === 'xml_proposal_then_final') {
      // Same textual/inline proposal shape as 'xml_proposal', but this
      // attempt goes on to be APPROVED, dispatches, and reaches a real final
      // turn — the exact shape that visually overwrites its own proposal
      // bubble in place in the live webview (`addAssistantBubble` reuses the
      // same DOM element for consecutive same-attempt assistant events).
      if (!hasToolResult) {
        return { content: RAW_PROPOSAL_TEXT, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
      }
      return { content: FINAL_CONFIRMATION_TEXT, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
    }
    if (!hasToolResult) {
      return {
        content: '',
        toolCalls: [{ name: 'propose_file_change', arguments: { path: 'note-saath.txt', content: 'Hello from Saath Kar' } }],
        provider: 'ollama', model: request.model, usage: { durationMs: 1 },
      };
    }
    return { content: FINAL_CONFIRMATION_TEXT, toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

let dir: string;
let db: CoreDatabase;
let api: RunningApiServer;
let ws: { close(): void };
let broadcaster: EventBroadcaster;
let baseUrl: string;
let backend: SwitchableProposalBackend;

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
const idemp = () => `idemp-rejected-proposal-${++n}`;

async function jsonOf(res: Response) {
  expect(res.ok).toBe(true);
  return res.json();
}

async function pollAttempt(id: string, pred: (a: any) => boolean, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await (await authedFetch(`/v1/attempts/${id}`)).json();
    if (pred(a)) return a;
    if (Date.now() > deadline) throw new Error(`attempt ${id} never satisfied; last=${a.status} reason=${a.failureReason}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seedSaathKarTurn(conversationId: string | null, message: string) {
  const conv = conversationId
    ? { id: conversationId }
    : await jsonOf(await authedFetch('/v1/conversations', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ mode: 'saath_kar' }) }));
  await jsonOf(await authedFetch(`/v1/conversations/${conv.id}/messages`, { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ role: 'user', content: message }) }));
  const req = await jsonOf(await authedFetch('/v1/requests', {
    method: 'POST', idempotencyKey: idemp(),
    body: JSON.stringify({ currentMessage: message, requestedMode: 'saath_kar', resolvedMode: 'saath_kar', routeReason: 'test', conversationId: conv.id, contextPolicy: { includeConversationHistory: true, includeProjectContext: false, includeRepositoryContext: true, includeGlobalStoryContext: false } }),
  }));
  const attempt = await jsonOf(await authedFetch('/v1/attempts', { method: 'POST', idempotencyKey: idemp(), body: JSON.stringify({ requestId: req.id, kind: 'saath_kar' }) }));
  return { conversationId: conv.id as string, attemptId: attempt.id as string };
}

/** Waits for `attemptId` to suspend on approval, then returns its own
 * pending governed action from the correlation's action list (the most
 * recently requested one — the correlation can carry a prior, already
 * resolved action from an earlier attempt on the same conversation). */
async function pendingWriteAction(conversationId: string, attemptId: string) {
  await pollAttempt(attemptId, (attempt) => attempt.status === 'waiting_for_approval');
  const snapshot = await (await authedFetch(`/v1/capabilities/actions?correlationId=${encodeURIComponent(conversationId)}`)).json();
  const own = snapshot.actions.filter((a: any) => a.actionable);
  expect(own).toHaveLength(1);
  return own[0];
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

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-rejected-proposal-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
  broadcaster = new EventBroadcaster();
  backend = new SwitchableProposalBackend();
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

describe('Saath Kar: a rejected proposal turn is not lost from durable/restorable history', () => {
  it('keeps the rejected attempt\'s raw proposal text AND the later approved attempt\'s confirmation, both durable and in order', async () => {
    // First attempt: the model's proposal turn is textual/inline (visible,
    // non-empty content with an embedded <function=propose_file_change> block) — the
    // exact shape reported live in the Guardian evidence. The user rejects it.
    backend.mode = 'xml_proposal';
    const first = await seedSaathKarTurn(null, 'Create note-saath.txt containing Hello from Saath Kar');
    await authedFetch(`/v1/attempts/${first.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const rejectAction = await pendingWriteAction(first.conversationId, first.attemptId);
    expect(rejectAction.toolName).toBe('propose_file_change');
    await resolveApproval(rejectAction, 'rejected');
    await pollAttempt(first.attemptId, (a) => a.status === 'cancelled');

    // Second attempt on the SAME conversation: the model uses the native
    // tool_calls channel this time (empty visible content for the proposal
    // turn — nothing to persist there), and the user approves it.
    backend.mode = 'native_proposal';
    const second = await seedSaathKarTurn(first.conversationId, 'Please try again and create the file');
    await authedFetch(`/v1/attempts/${second.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const approveAction = await pendingWriteAction(first.conversationId, second.attemptId);
    expect(approveAction.toolName).toBe('propose_file_change');
    expect(approveAction.approvalId).not.toBe(rejectAction.approvalId);
    await resolveApproval(approveAction, 'approved');
    await pollAttempt(second.attemptId, (a) => a.status === 'completed');
    expect(fs.readFileSync(path.join(dir, 'note-saath.txt'), 'utf8')).toBe('Hello from Saath Kar');

    // The restorable message list — exactly what `listMessages`
    // (core/domain/conversations.ts) returns and what AgentPanel's
    // `restoreConversationTranscript` reads verbatim after a restart — must
    // contain BOTH assistant messages, in original chronological order.
    const messages = (await (await authedFetch(`/v1/conversations/${first.conversationId}/messages`)).json()).messages;
    const assistantTexts: string[] = messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content as string);

    const rejectedProposalIndex = assistantTexts.findIndex((text) => text.includes('<function=propose_file_change>'));
    const approvedConfirmationIndex = assistantTexts.findIndex((text) => text === FINAL_CONFIRMATION_TEXT);

    expect(rejectedProposalIndex).toBeGreaterThanOrEqual(0);
    expect(approvedConfirmationIndex).toBeGreaterThan(rejectedProposalIndex);
    expect(assistantTexts[rejectedProposalIndex]).toBe(RAW_PROPOSAL_TEXT);

    // The native tool_calls proposal turn had empty visible content and must
    // never produce a spurious empty assistant bubble.
    expect(assistantTexts.some((text) => text.trim().length === 0)).toBe(false);
  }, 20000);

  it('does not durably duplicate an approved proposal turn that a later turn in the SAME attempt supersedes', async () => {
    // Guardian P0 regression: a single attempt whose textual/inline proposal
    // turn suspends for approval, gets APPROVED (not rejected), dispatches,
    // and then produces a further final-answer turn. Live, the webview never
    // shows the proposal text as its own bubble — the final turn overwrites
    // it in place. An earlier version of the fix for the sibling "rejected"
    // case above persisted EVERY suspending proposal turn unconditionally,
    // which durably kept this superseded proposal text too, producing an
    // extra bubble on restart that live rendering never showed.
    backend.mode = 'xml_proposal_then_final';
    const attempt = await seedSaathKarTurn(null, 'Create note-saath.txt containing Hello from Saath Kar');
    await authedFetch(`/v1/attempts/${attempt.attemptId}/execute`, { method: 'POST', idempotencyKey: idemp() });
    const approveAction = await pendingWriteAction(attempt.conversationId, attempt.attemptId);
    expect(approveAction.toolName).toBe('propose_file_change');
    await resolveApproval(approveAction, 'approved');
    await pollAttempt(attempt.attemptId, (a) => a.status === 'completed');
    expect(fs.readFileSync(path.join(dir, 'note-saath.txt'), 'utf8')).toBe('Hello from Saath Kar');

    const messages = (await (await authedFetch(`/v1/conversations/${attempt.conversationId}/messages`)).json()).messages;
    const assistantTexts: string[] = messages.filter((m: any) => m.role === 'assistant').map((m: any) => m.content as string);

    // Exactly the final confirmation text — never the superseded proposal.
    expect(assistantTexts).toEqual([FINAL_CONFIRMATION_TEXT]);
    expect(assistantTexts.some((text) => text.includes('<function=propose_file_change>'))).toBe(false);
  }, 20000);
});
