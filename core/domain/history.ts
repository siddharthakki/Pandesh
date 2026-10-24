import type { CoreDatabase } from '../db/connection';
import type {
  AttemptKind,
  AttemptStatus,
  RequestedMode,
  ResolvedMode,
  ModelSelectionEvidence,
  TaskHistoryApprovalSummary,
  TaskHistoryDetail,
  TaskHistoryEntry,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { listApprovalsForAttempt } from './approvals';
import { listCheckpointsForAttempt } from './checkpoints';
import { listRuntimeEventsForAttempt } from './runtimeEvents';

/**
 * M33 durable task-history projection. Additive and strictly read-only: a
 * join over the existing `attempts` + `requests` (+ `attempt_contexts`)
 * tables that Core already owns. It introduces no new tables, no writes,
 * and no second history store — Core's durable records remain the single
 * authority; this module only shapes them for the everyday History view.
 */

const MAX_HISTORY_PAGE = 100;
const MAX_DETAIL_EVENTS = 100;

interface HistoryRow extends Record<string, unknown> {
  attemptId: string;
  requestId: string;
}

function parseModelSelection(value: unknown): ModelSelectionEvidence | null {
  if (value === null || value === undefined) return null;
  return JSON.parse(String(value)) as ModelSelectionEvidence;
}

function rowToEntry(db: CoreDatabase, row: HistoryRow): TaskHistoryEntry {
  const approvals = db.all<Record<string, unknown>>(
    'SELECT id, kind, status, requestedAt, resolvedAt FROM approvals WHERE attemptId = ? ORDER BY requestedAt ASC',
    [row.attemptId],
  ).map((approval): TaskHistoryApprovalSummary => ({
    id: String(approval.id),
    kind: approval.kind as TaskHistoryApprovalSummary['kind'],
    status: approval.status as TaskHistoryApprovalSummary['status'],
    requestedAt: String(approval.requestedAt),
    resolvedAt: (approval.resolvedAt as string) ?? null,
  }));
  return {
    attemptId: String(row.attemptId),
    requestId: String(row.requestId),
    predecessorAttemptId: (row.predecessorAttemptId as string) ?? null,
    successorAttemptId: (row.successorAttemptId as string) ?? null,
    kind: row.kind as AttemptKind,
    status: row.status as AttemptStatus,
    failureReason: (row.failureReason as string) ?? null,
    createdAt: String(row.createdAt),
    startedAt: (row.startedAt as string) ?? null,
    completedAt: (row.completedAt as string) ?? null,
    currentMessage: String(row.currentMessage),
    requestedMode: row.requestedMode as RequestedMode,
    resolvedMode: row.resolvedMode as ResolvedMode,
    routeReason: String(row.routeReason),
    conversationId: (row.conversationId as string) ?? null,
    workspaceRoot: (row.workspaceRoot as string) ?? null,
    selectedProvider: (row.selectedProvider as string) ?? null,
    selectedModel: (row.selectedModel as string) ?? null,
    modelSelection: parseModelSelection(row.modelSelection),
    retryGuidance: (row.retryGuidance as string) ?? null,
    approvals,
  };
}

const HISTORY_SELECT = `
  SELECT a.id AS attemptId, a.requestId AS requestId,
         a.predecessorAttemptId,
         (SELECT successor.id FROM attempts successor
          WHERE successor.predecessorAttemptId = a.id
          ORDER BY successor.createdAt ASC, successor.id ASC LIMIT 1) AS successorAttemptId,
         a.kind, a.status,
         a.failureReason, a.createdAt, a.startedAt, a.completedAt,
         r.currentMessage, r.requestedMode, r.resolvedMode, r.routeReason,
         r.conversationId,
         c.workspaceRoot, c.selectedProvider, c.selectedModel,
         c.modelSelection, c.retryGuidance
  FROM attempts a
  JOIN requests r ON r.id = a.requestId
  LEFT JOIN attempt_contexts c ON c.attemptId = a.id`;

export interface ListTaskHistoryFilter {
  limit?: number;
  offset?: number;
  workspaceRoot?: string;
}

export function listTaskHistory(db: CoreDatabase, filter: ListTaskHistoryFilter = {}): TaskHistoryEntry[] {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), MAX_HISTORY_PAGE);
  const offset = Math.max(filter.offset ?? 0, 0);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.workspaceRoot) {
    clauses.push('workspaceRoot = ?');
    params.push(filter.workspaceRoot);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.all<HistoryRow>(
    `SELECT * FROM (${HISTORY_SELECT}) ${where} ORDER BY createdAt DESC, attemptId DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return rows.map((row) => rowToEntry(db, row));
}

export function getTaskHistoryDetail(db: CoreDatabase, attemptId: string): TaskHistoryDetail {
  const row = db.get<HistoryRow>(`${HISTORY_SELECT} WHERE a.id = ?`, [attemptId]);
  if (!row) throw new CoreError('not_found', `attempt '${attemptId}' not found`);
  return {
    entry: rowToEntry(db, row),
    approvals: listApprovalsForAttempt(db, attemptId),
    checkpoints: listCheckpointsForAttempt(db, attemptId),
    events: listRuntimeEventsForAttempt(db, attemptId, MAX_DETAIL_EVENTS),
  };
}
