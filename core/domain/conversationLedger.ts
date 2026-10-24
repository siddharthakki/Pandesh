import type { CoreDatabase } from '../db/connection';
import type {
  AttemptStatus,
  ConversationLedgerTurn,
  WorkspaceConversationIndexEntry,
  WorkspaceConversationLedgerSnapshot,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { archiveConversation } from './conversations';

export const CONVERSATION_LEDGER_SCHEMA_VERSION = 1;

const TERMINAL = new Set<AttemptStatus>(['completed', 'failed', 'cancelled']);

function requireIdentity(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new CoreError('invalid_request', `${field} must be a non-empty bounded string`);
  }
  return normalized;
}

function json(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseMetadata(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function rowToIndex(row: Record<string, unknown>): WorkspaceConversationIndexEntry {
  return {
    workspaceIdentity: String(row.workspaceIdentity),
    localConversationId: String(row.localConversationId),
    conversationId: String(row.conversationId),
    title: (row.title as string) ?? null,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    archivedAt: (row.archivedAt as string) ?? null,
    schemaVersion: Number(row.schemaVersion),
    migrationMetadata: parseMetadata(row.migrationMetadata),
  };
}

function statusToOutcome(status: AttemptStatus, rejected: boolean): ConversationLedgerTurn['outcome'] {
  if (rejected) return 'rejected';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'blocked' || status === 'recovery_required') return 'blocked';
  return 'active';
}

/**
 * Records the stable turn identity created by the atomic submit transaction.
 * Repeated calls are idempotent by requestId and never allocate a second
 * projection identity.
 */
export function recordConversationTurn(
  db: CoreDatabase,
  input: {
    conversationId: string;
    requestId: string;
    attemptId: string;
    userMessageId: string | null;
    mode: 'baat_kar' | 'saath_kar' | 'karke_dikha';
    createdAt: string;
    titleCandidate?: string;
    migrationMetadata?: Record<string, unknown>;
  },
): void {
  const id = `turn_${input.requestId}`;
  db.run(
    `INSERT OR IGNORE INTO conversation_turns
      (id, conversationId, requestId, attemptId, userMessageId, mode, taskId,
       outcome, projectionId, createdAt, updatedAt, terminalAt, schemaVersion, migrationMetadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL, ?, ?)`,
    [
      id,
      input.conversationId,
      input.requestId,
      input.attemptId,
      input.userMessageId,
      input.mode,
      input.mode === 'karke_dikha' ? input.attemptId : null,
      `projection_${input.requestId}`,
      input.createdAt,
      input.createdAt,
      CONVERSATION_LEDGER_SCHEMA_VERSION,
      json(input.migrationMetadata),
    ],
  );
  const title = input.titleCandidate?.trim();
  db.run(
    `UPDATE workspace_conversations
        SET title = COALESCE(title, ?), updatedAt = ?
      WHERE conversationId = ?`,
    [title ? (title.length > 60 ? `${title.slice(0, 60)}…` : title) : null, input.createdAt, input.conversationId],
  );
}

/**
 * Keeps terminal state in the ledger synchronized inside the same transaction
 * as the authoritative attempt transition. A rejected consequential approval
 * is distinct from a generic cancellation and therefore survives restart.
 */
export function synchronizeConversationTurnAttempt(
  db: CoreDatabase,
  attemptId: string,
  status: AttemptStatus,
  updatedAt: string,
): void {
  const rejected = Boolean(db.get(
    `SELECT 1
       FROM approvals a
      WHERE a.status = 'rejected'
        AND (
          a.attemptId = ?
          OR json_extract(a.summary, '$.scopeIdentity') = ?
        )
      LIMIT 1`,
    [attemptId, attemptId],
  ));
  const outcome = statusToOutcome(status, rejected);
  db.run(
    `UPDATE conversation_turns
        SET outcome = ?, updatedAt = ?, terminalAt = ?
      WHERE attemptId = ?`,
    [outcome, updatedAt, TERMINAL.has(status) ? updatedAt : null, attemptId],
  );
  db.run(
    `UPDATE workspace_conversations
        SET updatedAt = ?
      WHERE conversationId = (
        SELECT conversationId FROM conversation_turns WHERE attemptId = ?
      )`,
    [updatedAt, attemptId],
  );
}

/** Backfills pre-ledger requests without copying or rewriting their evidence. */
export function migrateConversationTurns(db: CoreDatabase, conversationId: string): number {
  const rows = db.all<{
    requestId: string;
    attemptId: string;
    kind: 'baat_kar' | 'saath_kar' | 'karke_dikha';
    status: AttemptStatus;
    createdAt: string;
    updatedAt: string;
  }>(
    `SELECT r.id AS requestId, a.id AS attemptId, a.kind, a.status,
            r.createdAt, a.updatedAt
       FROM requests r
       JOIN attempts a ON a.requestId = r.id
      WHERE r.conversationId = ?
        AND a.predecessorAttemptId IS NULL
      ORDER BY r.createdAt ASC, a.createdAt ASC`,
    [conversationId],
  );
  let migrated = 0;
  for (const row of rows) {
    const before = db.get('SELECT 1 FROM conversation_turns WHERE requestId = ?', [row.requestId]);
    if (before) continue;
    const userMessage = db.get<{ id: string }>(
      `SELECT id FROM conversation_messages
        WHERE conversationId = ? AND role = 'user' AND createdAt <= ?
        ORDER BY createdAt DESC, seq DESC LIMIT 1`,
      [conversationId, row.createdAt],
    );
    recordConversationTurn(db, {
      conversationId,
      requestId: row.requestId,
      attemptId: row.attemptId,
      userMessageId: userMessage?.id ?? null,
      mode: row.kind,
      createdAt: row.createdAt,
      migrationMetadata: { migratedFrom: 'pre-v14-request-attempt' },
    });
    synchronizeConversationTurnAttempt(db, row.attemptId, row.status, row.updatedAt);
    migrated += 1;
  }
  return migrated;
}

export function bindWorkspaceConversation(
  db: CoreDatabase,
  input: {
    workspaceIdentity: string;
    localConversationId: string;
    conversationId: string;
    title?: string | null;
    makeCurrent?: boolean;
    migrationMetadata?: Record<string, unknown>;
  },
): WorkspaceConversationLedgerSnapshot {
  return db.transaction(() => {
    const workspaceIdentity = requireIdentity(input.workspaceIdentity, 'workspaceIdentity');
    const localConversationId = requireIdentity(input.localConversationId, 'localConversationId');
    const conversation = db.get<{ id: string; title: string | null; createdAt: string; updatedAt: string }>(
      'SELECT id, title, createdAt, updatedAt FROM conversations WHERE id = ? AND archivedAt IS NULL',
      [input.conversationId],
    );
    if (!conversation) throw new CoreError('not_found', `conversation '${input.conversationId}' not found`);
    const existing = db.get<{ conversationId: string }>(
      `SELECT conversationId FROM workspace_conversations
        WHERE workspaceIdentity = ? AND localConversationId = ?`,
      [workspaceIdentity, localConversationId],
    );
    if (existing && existing.conversationId !== input.conversationId) {
      throw new CoreError('conflict', 'local conversation identity is already bound to another durable conversation');
    }
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace_conversations
        (workspaceIdentity, localConversationId, conversationId, title, createdAt,
         updatedAt, archivedAt, schemaVersion, migrationMetadata)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)
       ON CONFLICT(workspaceIdentity, localConversationId) DO UPDATE SET
         title = COALESCE(excluded.title, workspace_conversations.title),
         updatedAt = excluded.updatedAt,
         migrationMetadata = excluded.migrationMetadata`,
      [
        workspaceIdentity,
        localConversationId,
        input.conversationId,
        input.title ?? conversation.title,
        conversation.createdAt,
        now,
        CONVERSATION_LEDGER_SCHEMA_VERSION,
        json(input.migrationMetadata),
      ],
    );
    migrateConversationTurns(db, input.conversationId);
    if (input.makeCurrent !== false) {
      db.run(
        `INSERT INTO workspace_conversation_pointers
          (workspaceIdentity, localConversationId, schemaVersion, migrationMetadata, updatedAt)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspaceIdentity) DO UPDATE SET
           localConversationId = excluded.localConversationId,
           schemaVersion = excluded.schemaVersion,
           migrationMetadata = excluded.migrationMetadata,
           updatedAt = excluded.updatedAt`,
        [workspaceIdentity, localConversationId, CONVERSATION_LEDGER_SCHEMA_VERSION, json(input.migrationMetadata), now],
      );
    }
    return getWorkspaceConversationLedger(db, workspaceIdentity);
  });
}

export function selectWorkspaceConversation(
  db: CoreDatabase,
  workspaceIdentityInput: string,
  localConversationIdInput: string,
): WorkspaceConversationLedgerSnapshot {
  return db.transaction(() => {
    const workspaceIdentity = requireIdentity(workspaceIdentityInput, 'workspaceIdentity');
    const localConversationId = requireIdentity(localConversationIdInput, 'localConversationId');
    const owned = db.get(
      `SELECT 1 FROM workspace_conversations
        WHERE workspaceIdentity = ? AND localConversationId = ? AND archivedAt IS NULL`,
      [workspaceIdentity, localConversationId],
    );
    if (!owned) throw new CoreError('not_found', 'conversation is not owned by this workspace');
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workspace_conversation_pointers
        (workspaceIdentity, localConversationId, schemaVersion, migrationMetadata, updatedAt)
       VALUES (?, ?, ?, '{}', ?)
       ON CONFLICT(workspaceIdentity) DO UPDATE SET
         localConversationId = excluded.localConversationId,
         schemaVersion = excluded.schemaVersion,
         updatedAt = excluded.updatedAt`,
      [workspaceIdentity, localConversationId, CONVERSATION_LEDGER_SCHEMA_VERSION, now],
    );
    return getWorkspaceConversationLedger(db, workspaceIdentity);
  });
}

export function archiveWorkspaceConversation(
  db: CoreDatabase,
  input: {
    workspaceIdentity: string;
    localConversationId: string;
    actor: string;
    clientId?: string | null;
  },
): WorkspaceConversationLedgerSnapshot {
  return db.transaction(() => {
    const workspaceIdentity = requireIdentity(input.workspaceIdentity, 'workspaceIdentity');
    const localConversationId = requireIdentity(input.localConversationId, 'localConversationId');
    const binding = db.get<{ conversationId: string }>(
      `SELECT conversationId FROM workspace_conversations
        WHERE workspaceIdentity = ? AND localConversationId = ? AND archivedAt IS NULL`,
      [workspaceIdentity, localConversationId],
    );
    if (!binding) throw new CoreError('not_found', 'conversation is not owned by this workspace');
    const now = new Date().toISOString();
    archiveConversation(db, binding.conversationId, {
      actor: input.actor,
      clientId: input.clientId,
    });
    db.run(
      `UPDATE workspace_conversations SET archivedAt = ?, updatedAt = ?
        WHERE workspaceIdentity = ? AND localConversationId = ?`,
      [now, now, workspaceIdentity, localConversationId],
    );
    const pointer = db.get<{ localConversationId: string }>(
      'SELECT localConversationId FROM workspace_conversation_pointers WHERE workspaceIdentity = ?',
      [workspaceIdentity],
    );
    if (pointer?.localConversationId === localConversationId) {
      const next = db.get<{ localConversationId: string }>(
        `SELECT localConversationId FROM workspace_conversations
          WHERE workspaceIdentity = ? AND archivedAt IS NULL
          ORDER BY updatedAt DESC LIMIT 1`,
        [workspaceIdentity],
      );
      if (next) {
        db.run(
          `UPDATE workspace_conversation_pointers
              SET localConversationId = ?, updatedAt = ?
            WHERE workspaceIdentity = ?`,
          [next.localConversationId, now, workspaceIdentity],
        );
      } else {
        db.run('DELETE FROM workspace_conversation_pointers WHERE workspaceIdentity = ?', [workspaceIdentity]);
      }
    }
    return getWorkspaceConversationLedger(db, workspaceIdentity);
  });
}

function turnRows(db: CoreDatabase, conversationId: string): ConversationLedgerTurn[] {
  migrateConversationTurns(db, conversationId);
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM conversation_turns WHERE conversationId = ? ORDER BY seq ASC`,
    [conversationId],
  );
  return rows.map((row) => {
    const approvalIds = db.all<{ id: string }>(
      `SELECT a.id
         FROM approvals a
        WHERE a.attemptId = ?
           OR json_extract(a.summary, '$.scopeIdentity') = ?
        ORDER BY a.requestedAt ASC`,
      [row.attemptId, row.attemptId],
    ).map(item => item.id);
    const assistantMessageIds = row.userMessageId
      ? db.all<{ id: string }>(
        `SELECT m.id
           FROM conversation_messages m
          WHERE m.conversationId = ?
            AND m.role = 'assistant'
            AND m.seq > (SELECT seq FROM conversation_messages WHERE id = ?)
            AND m.seq < COALESCE(
              (SELECT MIN(seq) FROM conversation_messages
                WHERE conversationId = ? AND role = 'user'
                  AND seq > (SELECT seq FROM conversation_messages WHERE id = ?)),
              9223372036854775807
            )
          ORDER BY m.seq ASC`,
        [conversationId, row.userMessageId, conversationId, row.userMessageId],
      ).map(item => item.id)
      : [];
    return {
      seq: Number(row.seq),
      id: String(row.id),
      conversationId: String(row.conversationId),
      requestId: String(row.requestId),
      attemptId: String(row.attemptId),
      userMessageId: (row.userMessageId as string) ?? null,
      assistantMessageIds,
      mode: row.mode as ConversationLedgerTurn['mode'],
      taskId: (row.taskId as string) ?? null,
      approvalIds,
      outcome: row.outcome as ConversationLedgerTurn['outcome'],
      projectionId: String(row.projectionId),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      terminalAt: (row.terminalAt as string) ?? null,
      schemaVersion: Number(row.schemaVersion),
      migrationMetadata: parseMetadata(row.migrationMetadata),
    };
  });
}

export function getWorkspaceConversationLedger(
  db: CoreDatabase,
  workspaceIdentityInput: string,
): WorkspaceConversationLedgerSnapshot {
  const workspaceIdentity = requireIdentity(workspaceIdentityInput, 'workspaceIdentity');
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM workspace_conversations
      WHERE workspaceIdentity = ? AND archivedAt IS NULL
      ORDER BY updatedAt DESC, localConversationId ASC`,
    [workspaceIdentity],
  );
  const conversations = rows.map(rowToIndex);
  const pointer = db.get<{ localConversationId: string; schemaVersion: number; migrationMetadata: string }>(
    'SELECT localConversationId, schemaVersion, migrationMetadata FROM workspace_conversation_pointers WHERE workspaceIdentity = ?',
    [workspaceIdentity],
  );
  if (pointer && !conversations.some(item => item.localConversationId === pointer.localConversationId)) {
    throw new CoreError('conflict', 'workspace current-conversation pointer is corrupt or mismatched');
  }
  const current = pointer
    ? conversations.find(item => item.localConversationId === pointer.localConversationId) ?? null
    : null;
  return {
    schemaVersion: CONVERSATION_LEDGER_SCHEMA_VERSION,
    workspaceIdentity,
    currentConversationId: current?.localConversationId ?? null,
    currentCoreConversationId: current?.conversationId ?? null,
    conversations,
    turns: current ? turnRows(db, current.conversationId) : [],
    migrationMetadata: pointer ? parseMetadata(pointer.migrationMetadata) : {},
  };
}
