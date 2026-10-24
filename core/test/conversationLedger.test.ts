import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { openCoreDatabase } from '../db/openCore';
import { appendMessage, createConversation } from '../domain/conversations';
import {
  bindWorkspaceConversation,
  getWorkspaceConversationLedger,
  selectWorkspaceConversation,
} from '../domain/conversationLedger';
import { submitRequest } from '../domain/submission';
import {
  confirmAttemptCancelled,
  requestCancelAttempt,
  transitionAttempt,
} from '../domain/attempts';
import {
  dispatchCapability,
  listCapabilityActions,
  resolveCapabilityApproval,
} from '../domain/capabilityDispatch';
import { GovernedCapabilityRegistry, type GovernedCapabilityAdapter } from '../runtime/governedCapability';
import type { ApprovalRecord } from '../shared/wireTypes';

let directory: string;
let databasePath: string;
let db: CoreDatabase;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-conversation-ledger-'));
  databasePath = path.join(directory, 'core.db');
  db = openCoreDatabase(databasePath).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

function reopen(): void {
  db.close();
  db = openCoreDatabase(databasePath).db;
}

function submit(
  conversationId: string,
  currentMessage: string,
  requestedMode: 'baat_kar' | 'saath_kar' | 'karke_dikha',
) {
  return submitRequest(db, {
    clientId: 'client-1',
    currentMessage,
    requestedMode,
    conversationId,
    workspaceRoot: 'C:\\workspace\\one',
    requestedProvider: 'ollama',
    requestedModel: 'test-model',
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `correlation-${currentMessage}`,
  });
}

function complete(conversationId: string, attemptId: string, content: string): void {
  transitionAttempt(db, attemptId, { toStatus: 'running', actor: 'test' });
  appendMessage(db, conversationId, { role: 'assistant', content, actor: 'test' });
  transitionAttempt(db, attemptId, { toStatus: 'completed', actor: 'test' });
}

function decision(approval: ApprovalRecord, resolution: 'approved' | 'rejected') {
  return {
    approvalId: approval.id,
    resolution,
    attemptId: approval.attemptId,
    expectedAttemptRevision: approval.expectedAttemptRevision,
    expectedAttemptStatus: approval.expectedAttemptStatus,
    requestedActionDigest: approval.requestedActionDigest,
    frozenContextHash: approval.frozenContextHash,
    actor: 'client-1',
    clientId: 'client-1',
    idempotencyKey: `resolve-${approval.id}`,
  };
}

const writeAdapter: GovernedCapabilityAdapter = {
  id: 'write-test',
  definitions: () => [{
    name: 'write_file',
    description: 'write',
    parameters: { type: 'object', properties: {} },
  }],
  classify: () => 'consequential',
  health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
  run: async () => ({ status: 'succeeded', exitCode: 0, output: 'written' }),
};

describe('workspace conversation ledger', () => {
  it('restores one mixed-mode conversation, pointer, index, ordered turns, and stable identities in a fresh host', async () => {
    const conversation = createConversation(db, {
      mode: 'baat_kar',
      title: 'Mixed conversation',
      actor: 'test',
    });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-one',
      localConversationId: 'default',
      conversationId: conversation.id,
      title: 'Mixed conversation',
    });
    reopen();

    const baat = submit(conversation.id, 'Baat request', 'baat_kar');
    complete(conversation.id, baat.attempt.id, 'Baat answer');
    reopen();

    const rejected = submit(conversation.id, 'Rejected Saath request', 'saath_kar');
    transitionAttempt(db, rejected.attempt.id, { toStatus: 'running', actor: 'test' });
    const registry = new GovernedCapabilityRegistry().register(writeAdapter);
    const rejectionResult = await dispatchCapability(db, registry, {
      correlationId: conversation.id,
      scopeIdentity: rejected.attempt.id,
      toolName: 'write_file',
      arguments: { path: 'same.txt', content: 'Hello' },
      cwd: process.cwd(),
      actor: 'test',
      clientId: 'client-1',
    });
    if (rejectionResult.outcome !== 'approval_required') throw new Error('expected rejection approval');
    const rejectionGate = rejectionResult.approval;
    resolveCapabilityApproval(db, decision(rejectionGate, 'rejected'));
    requestCancelAttempt(db, rejected.attempt.id, { actor: 'test' });
    confirmAttemptCancelled(db, rejected.attempt.id, { actor: 'test' });
    reopen();

    const approved = submit(conversation.id, 'Approved Saath request', 'saath_kar');
    complete(conversation.id, approved.attempt.id, 'Approved Saath answer');
    const autonomous = submit(conversation.id, 'Karke request', 'karke_dikha');
    complete(conversation.id, autonomous.attempt.id, 'Karke terminal projection');
    reopen();

    const restored = getWorkspaceConversationLedger(db, 'workspace-one');
    expect(restored.currentConversationId).toBe('default');
    expect(restored.currentCoreConversationId).toBe(conversation.id);
    expect(restored.conversations).toHaveLength(1);
    expect(restored.turns.map(turn => turn.mode)).toEqual([
      'baat_kar',
      'saath_kar',
      'saath_kar',
      'karke_dikha',
    ]);
    expect(restored.turns.map(turn => turn.outcome)).toEqual([
      'completed',
      'rejected',
      'completed',
      'completed',
    ]);
    expect(new Set(restored.turns.map(turn => turn.projectionId)).size).toBe(4);
    expect(restored.turns[1].approvalIds).toEqual([rejectionGate.id]);
    expect(restored.turns[3].taskId).toBe(autonomous.attempt.id);
    expect(restored.turns.every(turn => turn.userMessageId)).toBe(true);
    expect(restored.turns.map(turn => turn.assistantMessageIds.length)).toEqual([1, 0, 1, 1]);
  });

  it('keeps the durable index and pointer isolated by workspace and selection survives reconstruction', () => {
    const first = createConversation(db, { mode: 'baat_kar', title: 'First', actor: 'test' });
    const second = createConversation(db, { mode: 'baat_kar', title: 'Second', actor: 'test' });
    const other = createConversation(db, { mode: 'baat_kar', title: 'Other', actor: 'test' });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-one',
      localConversationId: 'first',
      conversationId: first.id,
    });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-one',
      localConversationId: 'second',
      conversationId: second.id,
    });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-two',
      localConversationId: 'other',
      conversationId: other.id,
    });
    selectWorkspaceConversation(db, 'workspace-one', 'first');
    reopen();

    const one = getWorkspaceConversationLedger(db, 'workspace-one');
    const two = getWorkspaceConversationLedger(db, 'workspace-two');
    expect(one.currentConversationId).toBe('first');
    expect(one.conversations.map(item => item.localConversationId).sort()).toEqual(['first', 'second']);
    expect(two.currentConversationId).toBe('other');
    expect(two.conversations.map(item => item.localConversationId)).toEqual(['other']);
    expect(() => selectWorkspaceConversation(db, 'workspace-two', 'first')).toThrow(/not owned/i);
  });

  it('backfills a missing pre-ledger turn once and never duplicates its projection identity', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-one',
      localConversationId: 'default',
      conversationId: conversation.id,
    });
    const result = submit(conversation.id, 'Crash boundary', 'baat_kar');
    complete(conversation.id, result.attempt.id, 'Recovered answer');
    db.run('DELETE FROM conversation_turns WHERE requestId = ?', [result.request.id]);

    const first = getWorkspaceConversationLedger(db, 'workspace-one');
    reopen();
    const second = getWorkspaceConversationLedger(db, 'workspace-one');
    expect(first.turns).toHaveLength(1);
    expect(second.turns).toHaveLength(1);
    expect(second.turns[0].projectionId).toBe(first.turns[0].projectionId);
    expect(second.turns[0].migrationMetadata).toEqual({
      migratedFrom: 'pre-v14-request-attempt',
    });
  });

  it('fails closed for a corrupt current pointer instead of combining conversations', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    bindWorkspaceConversation(db, {
      workspaceIdentity: 'workspace-one',
      localConversationId: 'default',
      conversationId: conversation.id,
    });
    db.exec('PRAGMA foreign_keys = OFF');
    db.run(
      `UPDATE workspace_conversation_pointers
          SET localConversationId = 'copied-from-another-workspace'
        WHERE workspaceIdentity = 'workspace-one'`,
    );
    db.exec('PRAGMA foreign_keys = ON');
    expect(() => getWorkspaceConversationLedger(db, 'workspace-one')).toThrow(/corrupt or mismatched/i);
  });

  it('binds identical capability evidence to the exact approval across repeated Saath attempts', async () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const registry = new GovernedCapabilityRegistry().register(writeAdapter);
    const action = { path: 'same.txt', content: 'Hello' };

    const rejectedGate = await dispatchCapability(db, registry, {
      correlationId: conversation.id,
      scopeIdentity: 'turn-rejected',
      toolName: 'write_file',
      arguments: action,
      cwd: process.cwd(),
      actor: 'test',
      clientId: 'client-1',
    });
    if (rejectedGate.outcome !== 'approval_required') throw new Error('expected rejection approval');
    resolveCapabilityApproval(db, decision(rejectedGate.approval, 'rejected'));

    const approvedGate = await dispatchCapability(db, registry, {
      correlationId: conversation.id,
      scopeIdentity: 'turn-approved',
      toolName: 'write_file',
      arguments: action,
      cwd: process.cwd(),
      actor: 'test',
      clientId: 'client-1',
    });
    if (approvedGate.outcome !== 'approval_required') throw new Error('expected approval');
    resolveCapabilityApproval(db, decision(approvedGate.approval, 'approved'));
    await dispatchCapability(db, registry, {
      correlationId: conversation.id,
      scopeIdentity: 'turn-approved',
      toolName: 'write_file',
      arguments: action,
      cwd: process.cwd(),
      actor: 'test',
      clientId: 'client-1',
    });
    reopen();

    const actions = listCapabilityActions(db, {
      correlationId: conversation.id,
      clientId: 'client-1',
    }).actions;
    expect(actions.find(item => item.approvalId === rejectedGate.approval.id)?.outcome).toBe('rejected');
    expect(actions.find(item => item.approvalId === approvedGate.approval.id)?.outcome).toBe('succeeded');
    expect(actions.filter(item => item.invocation)).toHaveLength(1);
  });
});
