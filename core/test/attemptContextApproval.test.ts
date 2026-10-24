import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation, appendMessage } from '../domain/conversations';
import { submitRequest } from '../domain/submission';
import { createRequest } from '../domain/requests';
import { createAttempt, failAttempt, retryAttempt, transitionAttempt } from '../domain/attempts';
import { getAttemptContext } from '../domain/attemptContext';
import { createApproval, resolveApproval } from '../domain/approvals';
import { CoreError } from '../domain/errors';
import { EventBroadcaster } from '../ws/broadcaster';
import { RuntimeExecutor } from '../runtime/executor';
import type { ModelBackend, ModelChatRequest, ModelChatResult } from '../runtime/modelBackend';
import type { ApprovalRecord } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-frozen-context-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(kind: 'baat_kar' | 'saath_kar' | 'karke_dikha' = 'karke_dikha') {
  return submitRequest(db, {
    clientId: 'client-1',
    currentMessage: 'Implement the requested change',
    requestedMode: kind,
    workspaceRoot: kind === 'baat_kar' ? null : 'C:\\work\\repo',
    requestedProvider: 'ollama',
    selectedModel: 'frozen-model',
    toolPermissionPolicy: { profile: 'confirm-mutations', allowedTools: ['read_file'] },
    capability: { hasWorkspace: kind !== 'baat_kar', gitCapable: kind === 'karke_dikha' },
    correlationId: `corr-${kind}`,
  });
}

function decision(approval: ApprovalRecord, resolution: 'approved' | 'rejected' = 'approved') {
  return {
    resolution,
    attemptId: approval.attemptId,
    gate: approval.kind,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    expectedRevision: approval.revision,
    actor: 'client-1',
  } as const;
}

class CapturingBackend implements ModelBackend {
  model: string | null = null;
  async streamChat(request: ModelChatRequest): Promise<ModelChatResult> {
    this.model = request.model;
    return { content: 'done', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } };
  }
}

describe('frozen attempt context', () => {
  it('remains immutable and execution uses the frozen model after live defaults change', async () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'client-1' });
    appendMessage(db, conversation.id, { role: 'user', content: 'hello', actor: 'client-1' });
    const result = submitRequest(db, {
      clientId: 'client-1',
      currentMessage: 'hello',
      requestedMode: 'baat_kar',
      conversationId: conversation.id,
      selectedModel: 'frozen-model',
      correlationId: 'corr-frozen',
    });
    const before = getAttemptContext(db, result.attempt.id);

    expect(() => db.run('UPDATE attempt_contexts SET selectedModel = ? WHERE attemptId = ?', ['changed', result.attempt.id])).toThrow();
    const backend = new CapturingBackend();
    const executor = new RuntimeExecutor(db, new EventBroadcaster(), { backend, defaultModel: 'live-config-model' });
    await executor.execute(result.attempt.id);

    expect(backend.model).toBe('frozen-model');
    expect(getAttemptContext(db, result.attempt.id)).toEqual(before);
  });

  it('M45: freezes a valid context window with its source and drops invalid values without rejecting the submission', () => {
    const selection = (extra: Record<string, unknown>) => ({
      selectedProvider: 'ollama', selectedModel: 'frozen-model', selectionReason: 'test', suitabilitySummary: 'test',
      userOverrode: true, candidates: [], escalationCandidates: [],
      requiredCapabilities: { readOnlyExplanation: true, repositoryExploration: false, toolCalling: false, fileModification: false, codingComplexity: 'none', contextRequirement: 'small', vision: false, validationAndRepair: false },
      ...extra,
    }) as never;
    const good = submitRequest(db, {
      clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar', correlationId: 'corr-window-good',
      modelSelection: selection({ contextWindowTokens: 16_384, contextWindowSource: 'router_metadata', maxOutputTokens: 512 }),
    });
    expect(getAttemptContext(db, good.attempt.id).modelSelection).toMatchObject({
      contextWindowTokens: 16_384, contextWindowSource: 'router_metadata', maxOutputTokens: 512,
    });
    const event = db.get<{ metadata: string }>(
      `SELECT metadata FROM runtime_events WHERE entityId = ? AND eventType = 'model_selection_decided'`, [good.attempt.id],
    );
    expect(JSON.parse(String(event?.metadata))).toMatchObject({ contextWindowTokens: 16_384, contextWindowSource: 'router_metadata' });

    const bad = submitRequest(db, {
      clientId: 'client-1', currentMessage: 'hi', requestedMode: 'baat_kar', correlationId: 'corr-window-bad',
      modelSelection: selection({ contextWindowTokens: 12, contextWindowSource: 'router_metadata' }),
    });
    const frozen = getAttemptContext(db, bad.attempt.id).modelSelection!;
    expect(frozen).not.toHaveProperty('contextWindowTokens');
    expect(frozen).not.toHaveProperty('contextWindowSource');
    expect(frozen.selectedModel).toBe('frozen-model');
  });

  it('rejects a context-hash mismatch explicitly', () => {
    const { attempt } = submit();
    const approval = createApproval(db, { attemptId: attempt.id, kind: 'mutation', summary: { path: 'src/a.ts' }, actor: 'core' });
    expect(() => resolveApproval(db, approval.id, { ...decision(approval), frozenContextHash: '0'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'context_mismatch' }),
    );
  });

  it('retry and recovery retain the original stable context identity', () => {
    const { attempt } = submit('baat_kar');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'core' });
    failAttempt(db, attempt.id, { failureReason: 'retry me', actor: 'core' });
    const retry = retryAttempt(db, { predecessorAttemptId: attempt.id, actor: 'core' });

    const originalContext = getAttemptContext(db, attempt.id);
    const retryContext = getAttemptContext(db, retry.id);
    expect(retryContext.contextIdentity).toBe(originalContext.contextIdentity);
    expect(retryContext.attemptId).toBe(retry.id);
    expect(retryContext.taskInput).toBe(originalContext.taskInput);
    expect(retryContext.selectedModel).toBe(originalContext.selectedModel);
  });

  it('fails explicitly when an attempt has no frozen context', () => {
    const request = createRequest(db, {
      clientId: 'client-1',
      currentMessage: 'legacy',
      requestedMode: 'baat_kar',
      resolvedMode: 'baat_kar',
      routeReason: 'test',
      contextPolicy: { includeConversationHistory: false, includeProjectContext: false, includeRepositoryContext: false, includeGlobalStoryContext: false },
      correlationId: 'corr-legacy',
    });
    db.run(
      `INSERT INTO attempts (id, requestId, kind, status, createdAt, updatedAt, revision)
       VALUES ('att_legacy', ?, 'baat_kar', 'created', ?, ?, 1)`,
      [request.id, new Date().toISOString(), new Date().toISOString()],
    );
    expect(() => getAttemptContext(db, 'att_legacy')).toThrowError(expect.objectContaining({ code: 'context_missing' }));
  });
});

describe('Core-validated approval envelope', () => {
  it('accepts one matching approval decision', () => {
    const { attempt } = submit();
    const approval = createApproval(db, { attemptId: attempt.id, kind: 'proposal', summary: { proposal: 'p1' }, actor: 'core' });
    expect(resolveApproval(db, approval.id, decision(approval)).status).toBe('approved');
  });

  it('rejects stale, duplicate, replayed, mismatched, and post-terminal decisions', () => {
    const staleAttempt = submit().attempt;
    const stale = createApproval(db, { attemptId: staleAttempt.id, kind: 'proposal', actor: 'core' });
    transitionAttempt(db, staleAttempt.id, { toStatus: 'running', actor: 'core' });
    expect(() => resolveApproval(db, stale.id, decision(stale))).toThrowError(expect.objectContaining({ code: 'revision_mismatch' }));

    const duplicateAttempt = submit('saath_kar').attempt;
    const duplicate = createApproval(db, { attemptId: duplicateAttempt.id, kind: 'mutation', actor: 'core' });
    resolveApproval(db, duplicate.id, decision(duplicate));
    expect(() => resolveApproval(db, duplicate.id, decision(duplicate, 'rejected'))).toThrowError(expect.objectContaining({ code: 'conflict' }));

    const replayAttempt = submit('baat_kar').attempt;
    const replay = createApproval(db, { attemptId: replayAttempt.id, kind: 'delivery', actor: 'core' });
    const replayDecision = { ...decision(replay), idempotencyKey: 'same-decision' };
    resolveApproval(db, replay.id, replayDecision);
    expect(() => resolveApproval(db, replay.id, replayDecision)).toThrowError(expect.objectContaining({ code: 'conflict' }));

    const wrongAttempt = submit().attempt;
    const otherAttempt = submit('saath_kar').attempt;
    const mismatched = createApproval(db, { attemptId: wrongAttempt.id, kind: 'mutation', summary: { path: 'x' }, actor: 'core' });
    expect(() => resolveApproval(db, mismatched.id, { ...decision(mismatched), attemptId: otherAttempt.id })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => resolveApproval(db, mismatched.id, { ...decision(mismatched), gate: 'proposal' })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => resolveApproval(db, mismatched.id, { ...decision(mismatched), requestedActionDigest: 'f'.repeat(64) })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );

    const terminalAttempt = submit('baat_kar').attempt;
    transitionAttempt(db, terminalAttempt.id, { toStatus: 'running', actor: 'core' });
    const terminalApproval = createApproval(db, { attemptId: terminalAttempt.id, kind: 'proposal', actor: 'core' });
    transitionAttempt(db, terminalAttempt.id, { toStatus: 'completed', actor: 'core' });
    expect(() => resolveApproval(db, terminalApproval.id, decision(terminalApproval))).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/conflict|invalid_transition/) }),
    );
    expect(() => createApproval(db, { attemptId: terminalAttempt.id, kind: 'delivery', actor: 'core' })).toThrowError(
      expect.objectContaining({ code: 'invalid_transition' }),
    );
  });
});
