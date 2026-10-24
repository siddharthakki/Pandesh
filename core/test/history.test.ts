import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { submitRequest } from '../domain/submission';
import { failAttempt, retryAttempt, transitionAttempt } from '../domain/attempts';
import { createApproval, resolveApproval } from '../domain/approvals';
import { createCheckpoint } from '../domain/checkpoints';
import { getTaskHistoryDetail, listTaskHistory } from '../domain/history';
import { CoreError } from '../domain/errors';
import type { ApprovalRecord, ModelSelectionEvidence } from '../shared/wireTypes';

let dir: string;
let db: CoreDatabase;

const modelSelection: ModelSelectionEvidence = {
  requiredCapabilities: {
    readOnlyExplanation: false,
    repositoryExploration: true,
    toolCalling: true,
    fileModification: true,
    codingComplexity: 'medium',
    contextRequirement: 'medium',
    vision: false,
    validationAndRepair: true,
  },
  selectedProvider: 'ollama',
  selectedModel: 'history-model',
  selectionReason: 'Selected a configured coding model with repository tools.',
  suitabilitySummary: 'Using a coding model suited to this task',
  userOverrode: false,
  candidates: [{
    provider: 'ollama',
    model: 'history-model',
    available: true,
    capable: true,
    costRank: 1,
    rejectionReasons: [],
  }],
  escalationCandidates: [{
    provider: 'ollama',
    model: 'history-model-stronger',
    reason: 'Configured same-provider escalation model.',
  }],
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-history-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});
afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function submit(message: string, kind: 'baat_kar' | 'saath_kar' | 'karke_dikha' = 'karke_dikha', workspaceRoot = 'C:\\work\\repo') {
  return submitRequest(db, {
    clientId: 'client-1',
    currentMessage: message,
    requestedMode: kind,
    workspaceRoot: kind === 'baat_kar' ? null : workspaceRoot,
    requestedProvider: 'ollama',
    selectedProvider: 'ollama',
    selectedModel: 'history-model',
    modelSelection,
    toolPermissionPolicy: { profile: 'confirm-mutations' },
    capability: { hasWorkspace: kind !== 'baat_kar', gitCapable: kind === 'karke_dikha' },
    correlationId: `corr-${message.length}-${kind}`,
  });
}

function approvalDecision(approval: ApprovalRecord, resolution: 'approved' | 'rejected' = 'approved') {
  return {
    resolution,
    attemptId: approval.attemptId,
    gate: approval.kind,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    expectedRevision: approval.revision,
    actor: 'human',
    clientId: 'client-1',
  };
}

describe('M33 durable task-history projection', () => {
  it('lists attempts joined with their immutable requests, newest first', () => {
    const first = submit('First everyday task', 'baat_kar');
    const second = submit('Second everyday task', 'karke_dikha');

    const tasks = listTaskHistory(db);
    expect(tasks.map((task) => task.attemptId)).toContain(first.attempt.id);
    expect(tasks.map((task) => task.attemptId)).toContain(second.attempt.id);

    const firstEntry = tasks.find((task) => task.attemptId === first.attempt.id)!;
    expect(firstEntry.currentMessage).toBe('First everyday task');
    expect(firstEntry.requestId).toBe(first.request.id);
    expect(firstEntry.kind).toBe('baat_kar');
    expect(firstEntry.status).toBe('created');
    expect(firstEntry.requestedMode).toBe('baat_kar');
    expect(firstEntry.approvals).toEqual([]);

    const secondEntry = tasks.find((task) => task.attemptId === second.attempt.id)!;
    expect(secondEntry.workspaceRoot).toBe('C:\\work\\repo');
    expect(secondEntry.selectedProvider).toBe('ollama');
    expect(secondEntry.selectedModel).toBe('history-model');
    expect(secondEntry.modelSelection).toEqual(modelSelection);
    expect(secondEntry.predecessorAttemptId).toBeNull();
    expect(secondEntry.successorAttemptId).toBeNull();
  });

  it('carries approval summaries, terminal status, and failure reason', () => {
    const { attempt } = submit('Approval-bearing task');
    const approval = createApproval(db, { attemptId: attempt.id, kind: 'proposal', summary: { goal: 'x' }, actor: 'core', clientId: 'client-1' });
    resolveApproval(db, approval.id, approvalDecision(approval, 'approved'));
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'core', clientId: 'client-1' });
    failAttempt(db, attempt.id, { failureReason: 'validation command failed', actor: 'core', clientId: 'client-1' });

    const entry = listTaskHistory(db).find((task) => task.attemptId === attempt.id)!;
    expect(entry.status).toBe('failed');
    expect(entry.failureReason).toBe('validation command failed');
    expect(entry.completedAt).toBeTruthy();
    expect(entry.approvals).toHaveLength(1);
    expect(entry.approvals[0]).toMatchObject({ kind: 'proposal', status: 'approved' });
  });

  it('returns a bounded per-attempt detail timeline without touching any state', () => {
    const { attempt } = submit('Detail task');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'core', clientId: 'client-1' });
    createCheckpoint(db, { attemptId: attempt.id, kind: 'karke_dikha_delivery', metadata: { commitSha: 'abc1234def' }, actor: 'core', clientId: 'client-1' });
    transitionAttempt(db, attempt.id, { toStatus: 'completed', actor: 'core', clientId: 'client-1' });

    const before = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runtime_events')!.n;
    const detail = getTaskHistoryDetail(db, attempt.id);
    const after = db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runtime_events')!.n;

    expect(after).toBe(before); // strictly read-only
    expect(detail.entry.attemptId).toBe(attempt.id);
    expect(detail.entry.status).toBe('completed');
    expect(detail.checkpoints.some((checkpoint) => checkpoint.kind === 'karke_dikha_delivery' && checkpoint.metadata['commitSha'] === 'abc1234def')).toBe(true);
    const transitions = detail.events.filter((event) => event.eventType === 'attempt_transitioned');
    expect(transitions.length).toBeGreaterThanOrEqual(2);
    expect(detail.events).toContainEqual(expect.objectContaining({
      domain: 'execution_quality',
      eventType: 'model_selection_decided',
      entityId: attempt.id,
    }));
  });

  it('projects retry lineage, immutable guidance, and each attempts execution-quality evidence', () => {
    const { attempt } = submit('Repair the failing parser');
    failAttempt(db, attempt.id, {
      failureReason: 'bounded validation repair was exhausted',
      actor: 'core',
      clientId: 'client-1',
    });
    const successor = retryAttempt(db, {
      predecessorAttemptId: attempt.id,
      strategy: 'with_guidance',
      guidance: 'Preserve quoted delimiters.',
      actor: 'human',
      clientId: 'client-1',
      idempotencyKey: `retry:${attempt.id}`,
    });

    const entries = listTaskHistory(db);
    const predecessorEntry = entries.find((entry) => entry.attemptId === attempt.id)!;
    const successorEntry = entries.find((entry) => entry.attemptId === successor.id)!;
    expect(predecessorEntry.successorAttemptId).toBe(successor.id);
    expect(predecessorEntry.predecessorAttemptId).toBeNull();
    expect(successorEntry.predecessorAttemptId).toBe(attempt.id);
    expect(successorEntry.successorAttemptId).toBeNull();
    expect(successorEntry.requestId).toBe(predecessorEntry.requestId);
    expect(successorEntry.retryGuidance).toBe('Preserve quoted delimiters.');
    expect(successorEntry.modelSelection).toEqual(modelSelection);

    const detail = getTaskHistoryDetail(db, successor.id);
    expect(detail.events).toContainEqual(expect.objectContaining({
      domain: 'execution_quality',
      eventType: 'retry_created',
      metadata: expect.objectContaining({ predecessorAttemptId: attempt.id, strategy: 'with_guidance' }),
    }));
  });

  it('filters by workspaceRoot and rejects unknown attempts', () => {
    submit('Workspace A task', 'karke_dikha', 'C:\\work\\alpha');
    submit('Workspace B task', 'karke_dikha', 'C:\\work\\beta');

    const alpha = listTaskHistory(db, { workspaceRoot: 'C:\\work\\alpha' });
    expect(alpha).toHaveLength(1);
    expect(alpha[0].currentMessage).toBe('Workspace A task');

    expect(() => getTaskHistoryDetail(db, 'att_missing')).toThrowError(CoreError);
  });
});
