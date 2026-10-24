import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from '../domain/errors';
import {
  appendMessage,
  archiveConversation,
  createConversation,
  pinConversation,
  renameConversation,
  unarchiveConversation,
  unpinConversation,
} from '../domain/conversations';
import { listConversationRail } from '../domain/workbench';
import { submitRequest } from '../domain/submission';
import { transitionAttempt } from '../domain/attempts';
import { createProject } from '../domain/projects';
import { createRepository } from '../domain/repositories';

let dir: string;
let databasePath: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kd-conversation-rail-'));
  databasePath = path.join(dir, 'core.db');
  db = openCoreDatabase(databasePath).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function reopen(): void {
  db.close();
  db = openCoreDatabase(databasePath).db;
}

function submit(conversationId: string, currentMessage: string) {
  return submitRequest(db, {
    clientId: 'client-1',
    currentMessage,
    requestedMode: 'baat_kar',
    conversationId,
    workspaceRoot: 'C:\\workspace\\one',
    requestedProvider: 'ollama',
    requestedModel: 'test-model',
    capability: { hasWorkspace: true, gitCapable: true },
    correlationId: `correlation-${currentMessage}`,
  });
}

describe('Jarvis Conversations rail Checkpoint 1 — state derivation', () => {
  it('a brand-new conversation with no turns reads as active', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const [entry] = listConversationRail(db);
    expect(entry.id).toBe(conversation.id);
    expect(entry.state).toBe('active');
    expect(entry.preview).toBeNull();
  });

  it('a waiting_for_approval attempt reads as needs_approval — NOT active (conversation_turns.outcome silently folds this into active, which the rail must not reuse)', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const { attempt } = submit(conversation.id, 'do something risky');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, attempt.id, { toStatus: 'waiting_for_approval', actor: 'test' });
    const [entry] = listConversationRail(db);
    expect(entry.state).toBe('needs_approval');
  });

  it('a completed attempt reads as completed', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const { attempt } = submit(conversation.id, 'do the thing');
    transitionAttempt(db, attempt.id, { toStatus: 'running', actor: 'test' });
    appendMessage(db, conversation.id, { role: 'assistant', content: 'Done.', actor: 'test' });
    transitionAttempt(db, attempt.id, { toStatus: 'completed', actor: 'test' });
    const [entry] = listConversationRail(db);
    expect(entry.state).toBe('completed');
    expect(entry.preview).toBe('Done.');
  });

  it('a failed attempt reads as failed and a stopped one reads as stopped', () => {
    const failedConversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const failedAttempt = submit(failedConversation.id, 'try this').attempt;
    transitionAttempt(db, failedAttempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, failedAttempt.id, { toStatus: 'failed', actor: 'test' });

    const cancelledConversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    const cancelledAttempt = submit(cancelledConversation.id, 'try that').attempt;
    transitionAttempt(db, cancelledAttempt.id, { toStatus: 'running', actor: 'test' });
    transitionAttempt(db, cancelledAttempt.id, { toStatus: 'cancelling', actor: 'test' });
    transitionAttempt(db, cancelledAttempt.id, { toStatus: 'cancelled', actor: 'test' });

    const rail = listConversationRail(db);
    expect(rail.find((entry) => entry.id === failedConversation.id)?.state).toBe('failed');
    // A conversation the person stopped did not fail: the rail says so.
    expect(rail.find((entry) => entry.id === cancelledConversation.id)?.state).toBe('stopped');
  });

  it('a repository-bound conversation resolves a repository name; a repository-less conversation reads null — both reopen after a restart', () => {
    const project = createProject(db, { name: 'Reading List' });
    const repository = createRepository(db, { projectId: project.id, name: 'reading-list', kind: 'git' });
    const withRepo = createConversation(db, { mode: 'baat_kar', repositoryId: repository.id, actor: 'test' });
    const withoutRepo = createConversation(db, { mode: 'baat_kar', actor: 'test' });

    reopen();

    const rail = listConversationRail(db);
    expect(rail.find((entry) => entry.id === withRepo.id)?.repositoryName).toBe('reading-list');
    expect(rail.find((entry) => entry.id === withoutRepo.id)?.repositoryName).toBeNull();
  });

  it('the preview reflects only the latest user/assistant message, never a role that is never persisted (tool/system)', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    appendMessage(db, conversation.id, { role: 'user', content: 'first question', actor: 'test' });
    appendMessage(db, conversation.id, { role: 'assistant', content: 'first answer', actor: 'test' });
    const [entry] = listConversationRail(db);
    expect(entry.preview).toBe('first answer');
  });
});

describe('Jarvis Conversations rail Checkpoint 1 — pin/rename/archive mutations', () => {
  it('pin persists across a database reopen (restart) and unpin clears it', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    pinConversation(db, conversation.id, { actor: 'test' });
    reopen();
    expect(listConversationRail(db)[0].pinnedAt).not.toBeNull();

    unpinConversation(db, conversation.id, { actor: 'test' });
    reopen();
    expect(listConversationRail(db)[0].pinnedAt).toBeNull();
  });

  it('pinning twice is a harmless idempotent refresh, not an error', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    pinConversation(db, conversation.id, { actor: 'test' });
    expect(() => pinConversation(db, conversation.id, { actor: 'test' })).not.toThrow();
  });

  it('rename updates the title and rejects empty/over-length titles', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', title: 'Old title', actor: 'test' });
    const renamed = renameConversation(db, conversation.id, { title: 'New title', actor: 'test' });
    expect(renamed.title).toBe('New title');
    expect(() => renameConversation(db, conversation.id, { title: '   ', actor: 'test' })).toThrow(CoreError);
    expect(() => renameConversation(db, conversation.id, { title: 'x'.repeat(201), actor: 'test' })).toThrow(CoreError);
  });

  it('archive is reversible: unarchive restores the conversation to the default list, and restores across a restart', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    archiveConversation(db, conversation.id, { actor: 'test' });
    expect(listConversationRail(db).map((entry) => entry.id)).not.toContain(conversation.id);

    unarchiveConversation(db, conversation.id, { actor: 'test' });
    reopen();
    const rail = listConversationRail(db);
    expect(rail.map((entry) => entry.id)).toContain(conversation.id);
    expect(rail.find((entry) => entry.id === conversation.id)?.archivedAt).toBeNull();
  });

  it('unarchiving a conversation that is not archived throws invalid_transition', () => {
    const conversation = createConversation(db, { mode: 'baat_kar', actor: 'test' });
    expect(() => unarchiveConversation(db, conversation.id, { actor: 'test' })).toThrow(CoreError);
  });
});
