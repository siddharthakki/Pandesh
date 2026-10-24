import type { CoreDatabase } from '../db/connection';
import type { ConversationRecord, ConversationMode, ConversationMessageRecord, MessageRole } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

export interface CreateConversationInput {
  mode: ConversationMode;
  projectId?: string | null;
  repositoryId?: string | null;
  title?: string | null;
  actor: string;
  clientId?: string | null;
}

function rowToConversation(row: Record<string, unknown>): ConversationRecord {
  return {
    id: String(row.id),
    mode: row.mode as ConversationMode,
    projectId: (row.projectId as string) ?? null,
    repositoryId: (row.repositoryId as string) ?? null,
    title: (row.title as string) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string) ?? null,
    pinnedAt: (row.pinnedAt as string) ?? null,
    revision: Number(row.revision),
  };
}

export function getConversation(db: CoreDatabase, id: string): ConversationRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `conversation '${id}' not found`);
  return rowToConversation(row);
}

export function createConversation(db: CoreDatabase, input: CreateConversationInput): ConversationRecord {
  return db.transaction(() => {
    const id = newId('conv');
    const now = nowIso();
    db.run(
      `INSERT INTO conversations (id, mode, projectId, repositoryId, title, createdAt, updatedAt, archivedAt, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 1)`,
      [id, input.mode, input.projectId ?? null, input.repositoryId ?? null, input.title ?? null, now, now],
    );
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_created',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { mode: input.mode },
      resultingRevision: 1,
    });
    return getConversation(db, id);
  });
}

export interface ListConversationsFilter {
  mode?: ConversationMode;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

const MAX_PAGE_SIZE = 200;

export function listConversations(db: CoreDatabase, filter: ListConversationsFilter = {}): ConversationRecord[] {
  const limit = Math.min(filter.limit ?? 50, MAX_PAGE_SIZE);
  const offset = filter.offset ?? 0;
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.mode) {
    clauses.push('mode = ?');
    params.push(filter.mode);
  }
  if (!filter.includeArchived) {
    clauses.push('archivedAt IS NULL');
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM conversations ${where} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map(rowToConversation);
}

export function archiveConversation(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null },
): ConversationRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `conversation '${id}' not found`);
    if (existing.archivedAt) throw new CoreError('invalid_transition', `conversation '${id}' is already archived`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE conversations SET archivedAt = ?, updatedAt = ?, revision = ? WHERE id = ?', [now, now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_archived',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getConversation(db, id);
  });
}

/** Jarvis Conversations rail Checkpoint 1 — reverses `archiveConversation`.
 * Archiving in this checkpoint must be recoverable, never a dead end. */
export function unarchiveConversation(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null },
): ConversationRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `conversation '${id}' not found`);
    if (!existing.archivedAt) throw new CoreError('invalid_transition', `conversation '${id}' is not archived`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE conversations SET archivedAt = NULL, updatedAt = ?, revision = ? WHERE id = ?', [now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_unarchived',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getConversation(db, id);
  });
}

const MAX_TITLE_CHARS = 200;

export function renameConversation(
  db: CoreDatabase,
  id: string,
  input: { title: string; actor: string; clientId?: string | null },
): ConversationRecord {
  const title = input.title.trim();
  if (!title) throw new CoreError('invalid_request', 'title must be a non-empty string');
  if (title.length > MAX_TITLE_CHARS) throw new CoreError('invalid_request', `title exceeds ${MAX_TITLE_CHARS} characters`);
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `conversation '${id}' not found`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE conversations SET title = ?, updatedAt = ?, revision = ? WHERE id = ?', [title, now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_renamed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { title },
      resultingRevision: newRevision,
    });
    return getConversation(db, id);
  });
}

/** Idempotent: pinning an already-pinned conversation just refreshes
 * `pinnedAt`/`updatedAt` rather than throwing — the rail's pin toggle has no
 * meaningful "already in that state" error case worth surfacing. */
export function pinConversation(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null },
): ConversationRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `conversation '${id}' not found`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE conversations SET pinnedAt = ?, updatedAt = ?, revision = ? WHERE id = ?', [now, now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_pinned',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getConversation(db, id);
  });
}

export function unpinConversation(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null },
): ConversationRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM conversations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `conversation '${id}' not found`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run('UPDATE conversations SET pinnedAt = NULL, updatedAt = ?, revision = ? WHERE id = ?', [now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: id,
      eventType: 'conversation_unpinned',
      actor: input.actor,
      clientId: input.clientId,
      resultingRevision: newRevision,
    });
    return getConversation(db, id);
  });
}

const MAX_MESSAGE_CHARS = 100_000;

export interface AppendMessageInput {
  role: MessageRole;
  content: string;
  modelInvocationId?: string | null;
  actor: string;
  clientId?: string | null;
}

/**
 * Appends a message to a conversation. Messages are append-only (no update/delete
 * route) — this is the durable substitute for the old file-based SessionStore
 * transcript, now Core-owned and shared across VS Code windows.
 */
export function appendMessage(db: CoreDatabase, conversationId: string, input: AppendMessageInput): ConversationMessageRecord {
  if (input.content.length > MAX_MESSAGE_CHARS) {
    throw new CoreError('invalid_request', `message content exceeds ${MAX_MESSAGE_CHARS} characters`);
  }
  return db.transaction(() => {
    const conversation = db.get<{ id: string; revision: number }>('SELECT id, revision FROM conversations WHERE id = ?', [conversationId]);
    if (!conversation) throw new CoreError('not_found', `conversation '${conversationId}' not found`);
    const id = newId('msg');
    const now = nowIso();
    const result = db.run(
      `INSERT INTO conversation_messages (id, conversationId, role, content, modelInvocationId, createdAt)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, conversationId, input.role, input.content, input.modelInvocationId ?? null, now],
    );
    db.run('UPDATE conversations SET updatedAt = ? WHERE id = ?', [now, conversationId]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: conversationId,
      eventType: 'message_appended',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { messageId: id, role: input.role },
      resultingRevision: conversation.revision,
    });
    return {
      seq: Number(result.lastInsertRowid),
      id,
      conversationId,
      role: input.role,
      content: input.content,
      modelInvocationId: input.modelInvocationId ?? null,
      createdAt: now,
    };
  });
}

export interface ListMessagesFilter {
  limit?: number;
  afterSeq?: number;
}

/**
 * Returns messages for exactly one conversation, in order. This is the only
 * supported way to read conversation history — callers must never concatenate
 * messages across conversations, which is the M32 "context isolation" guarantee
 * for Baat Kar (see docs/m32-architecture.md).
 */
export function listMessages(db: CoreDatabase, conversationId: string, filter: ListMessagesFilter = {}): ConversationMessageRecord[] {
  const limit = Math.min(filter.limit ?? 500, 2000);
  const afterSeq = filter.afterSeq ?? 0;
  // A branch stores only its later messages.  Its immutable ancestry is
  // projected here, so inherited messages retain their original identities,
  // attachment links, citations, and hashes without copying any evidence.
  // The recursive relation is bounded by the database shape (one parent per
  // conversation) and depth-capped defensively for corrupt legacy data.
  const rows = db.all<Record<string, unknown>>(
    `WITH RECURSIVE lineage(conversationId, branchPointMessageId, depth) AS (
       SELECT ? AS conversationId, NULL AS branchPointMessageId, 0 AS depth
       UNION ALL
       SELECT b.parentConversationId, b.branchPointMessageId, lineage.depth + 1
       FROM conversation_branches b JOIN lineage ON b.conversationId = lineage.conversationId
       WHERE lineage.depth < 32
     )
     SELECT m.*,
            COALESCE(
              mi.actualModel,
              mi.requestedModel,
              (SELECT ac.selectedModel FROM attempts a
               JOIN requests r ON r.id = a.requestId
               JOIN attempt_contexts ac ON ac.attemptId = a.id
               WHERE r.conversationId = m.conversationId AND a.createdAt <= m.createdAt
               ORDER BY a.createdAt DESC LIMIT 1)
            ) AS resolvedModel,
            COALESCE(
              mi.actualProvider,
              mi.requestedProvider,
              (SELECT ac.selectedProvider FROM attempts a
               JOIN requests r ON r.id = a.requestId
               JOIN attempt_contexts ac ON ac.attemptId = a.id
               WHERE r.conversationId = m.conversationId AND a.createdAt <= m.createdAt
               ORDER BY a.createdAt DESC LIMIT 1)
            ) AS resolvedProvider,
            mi.usageMetadata AS modelUsageMetadata,
            (SELECT a.id FROM attempts a
             JOIN requests r ON r.id = a.requestId
             WHERE r.conversationId = m.conversationId AND a.createdAt <= m.createdAt
             ORDER BY a.createdAt DESC LIMIT 1) AS fallbackAttemptId,
            (SELECT r.id FROM attempts a
             JOIN requests r ON r.id = a.requestId
             WHERE r.conversationId = m.conversationId AND a.createdAt <= m.createdAt
             ORDER BY a.createdAt DESC LIMIT 1) AS fallbackRequestId,
            (SELECT ac.workspaceRoot FROM attempts a
             JOIN requests r ON r.id = a.requestId
             JOIN attempt_contexts ac ON ac.attemptId = a.id
             WHERE r.conversationId = m.conversationId AND a.createdAt <= m.createdAt
             ORDER BY a.createdAt DESC LIMIT 1) AS fallbackWorkspace
     FROM conversation_messages m JOIN lineage l ON l.conversationId = m.conversationId
     LEFT JOIN model_invocations mi ON mi.id = m.modelInvocationId
     WHERE m.seq > ?
       AND (l.depth = 0 OR m.seq <= (SELECT seq FROM conversation_messages WHERE id = l.branchPointMessageId))
     ORDER BY m.seq ASC LIMIT ?`,
    [conversationId, afterSeq, limit],
  );
  // Messages Core itself posted (e.g. dev-story reports, actor `kkd:*`) were written by no model: they carry no model
  // badge and no model diagnostics, whatever attempt happened to run before them.
  const coreAuthored = new Set<string>();
  for (const cid of new Set(rows.filter((r) => r.role === 'assistant' && !r.modelInvocationId).map((r) => String(r.conversationId)))) {
    for (const e of db.all<{ messageId: string | null }>(
      "SELECT json_extract(metadata, '$.messageId') AS messageId FROM runtime_events WHERE domain = 'conversation' AND entityId = ? AND eventType = 'message_appended' AND actor LIKE 'kkd:%'",
      [cid],
    )) if (e.messageId) coreAuthored.add(e.messageId);
  }
  return rows.map((row) => {
    let diagnostics: any = null;
    if (row.modelUsageMetadata) {
      try {
        const parsed = JSON.parse(String(row.modelUsageMetadata));
        if (parsed && typeof parsed === 'object' && parsed.requestId) {
          diagnostics = parsed;
        }
      } catch {}
    }
    const byCore = coreAuthored.has(String(row.id));
    const resolvedModel = byCore ? null : ((row.resolvedModel as string) ?? null);
    const resolvedProvider = byCore ? null : ((row.resolvedProvider as string) ?? null);
    if (!diagnostics && !byCore && row.role === 'assistant' && (row.fallbackAttemptId || resolvedModel)) {
      diagnostics = {
        conversationId: String(row.conversationId),
        requestId: (row.fallbackRequestId as string) || 'req_legacy',
        attemptId: (row.fallbackAttemptId as string) || 'att_legacy',
        model: resolvedModel || 'unknown',
        provider: resolvedProvider || 'ollama',
        currentUserMessage: '',
        selectedWorkspace: (row.fallbackWorkspace as string) ?? null,
        messageHistoryCount: 0,
        contextTruncation: {
          truncated: false,
          omittedCount: 0,
        },
        toolInvocationIds: [],
        outputAssociation: {
          assistantMessageId: String(row.id),
          modelInvocationId: (row.modelInvocationId as string) ?? null,
        },
      };
    }
    return {
      seq: Number(row.seq),
      id: String(row.id),
      conversationId: String(row.conversationId),
      role: row.role as MessageRole,
      content: String(row.content),
      modelInvocationId: (row.modelInvocationId as string) ?? null,
      createdAt: String(row.createdAt),
      model: resolvedModel,
      provider: resolvedProvider,
      diagnostics,
    };
  });
}
