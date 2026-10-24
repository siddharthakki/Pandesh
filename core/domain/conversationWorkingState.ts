import type { CoreDatabase } from '../db/connection';
import type {
  ConversationConstraint,
  ConversationExecutionPolicy,
  ConversationPendingAction,
  ConversationRelevantFile,
  ConversationWorkingStateRecord,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

/**
 * Durable Conversational Continuity V1 — Core-owned storage for ONE bounded
 * derived working state per conversation.
 *
 * What this module is NOT, deliberately (milestone Step 10):
 *  - not a second transcript: `conversation_messages` remains the only
 *    durable record of what was said, and Baat/Saath already replay it;
 *  - not an embedding/vector/knowledge-graph store: every field here is a
 *    short literal string the extension host derived from the turn it just
 *    submitted;
 *  - not evidence about the repository: `relevantFiles[].contentHash` exists
 *    solely so a resumed conversation can DETECT that the repository moved,
 *    never to assert that it did not.
 *
 * Every write is bounded and validated here rather than at the route, so a
 * client cannot grow this table into an unbounded memory sink.
 */

export const CONVERSATION_WORKING_STATE_SCHEMA_VERSION = 1;

const MAX_OBJECTIVE_CHARS = 400;
const MAX_INTENT_CHARS = 600;
const MAX_SUMMARY_CHARS = 2_000;
const MAX_CONSTRAINTS = 12;
const MAX_CONSTRAINT_CHARS = 200;
const MAX_RELEVANT_FILES = 24;
const MAX_PATH_CHARS = 500;
const MAX_SYMBOLS = 24;
const MAX_SYMBOL_CHARS = 120;

const POLICIES = new Set<ConversationExecutionPolicy>(['READ_ONLY', 'COLLABORATIVE_EDIT', 'AUTONOMOUS_EXECUTION']);
const PENDING_KINDS = new Set<ConversationPendingAction['kind']>([
  'awaiting_approval',
  'awaiting_validation',
  'awaiting_user_decision',
  'resume_work',
]);

function boundedText(value: unknown, max: number, field: string): string {
  const text = String(value ?? '').trim();
  if (!text) throw new CoreError('invalid_request', `${field} must be a non-empty string`);
  if (text.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return text;
}

function optionalBoundedText(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return text;
}

function normalizeConstraints(value: unknown, now: string): ConversationConstraint[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CoreError('invalid_request', 'userConstraints must be an array');
  if (value.length > MAX_CONSTRAINTS) {
    throw new CoreError('invalid_request', `userConstraints may hold at most ${MAX_CONSTRAINTS} entries`);
  }
  const seen = new Set<string>();
  const result: ConversationConstraint[] = [];
  for (const entry of value) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const text = boundedText(item.text, MAX_CONSTRAINT_CHARS, 'constraint text');
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: typeof item.id === 'string' && item.id.length > 0 && item.id.length <= 64 ? item.id : newId('cons'),
      text,
      createdAt: typeof item.createdAt === 'string' && item.createdAt.length <= 40 ? item.createdAt : now,
    });
  }
  return result;
}

function normalizeRelevantFiles(value: unknown, now: string): ConversationRelevantFile[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CoreError('invalid_request', 'relevantFiles must be an array');
  if (value.length > MAX_RELEVANT_FILES) {
    throw new CoreError('invalid_request', `relevantFiles may hold at most ${MAX_RELEVANT_FILES} entries`);
  }
  const seen = new Set<string>();
  const result: ConversationRelevantFile[] = [];
  for (const entry of value) {
    const item = (entry ?? {}) as Record<string, unknown>;
    const path = String(item.path ?? '').replace(/\\/g, '/').trim();
    // Repository-relative only: an absolute or escaping path here would let a
    // restored narrative point revalidation outside the workspace.
    if (!path || path.length > MAX_PATH_CHARS || /^([A-Za-z]:|\/)/.test(path) || path.split('/').includes('..')) {
      throw new CoreError('invalid_request', 'relevantFiles entries must use bounded repository-relative paths');
    }
    if (seen.has(path)) continue;
    seen.add(path);
    const contentHash = item.contentHash === null || item.contentHash === undefined ? null : String(item.contentHash);
    if (contentHash !== null && !/^[a-f0-9]{64}$/i.test(contentHash)) {
      throw new CoreError('invalid_request', 'relevantFiles content hashes must be SHA-256');
    }
    result.push({
      path,
      contentHash: contentHash ? contentHash.toLowerCase() : null,
      observedAt: typeof item.observedAt === 'string' && item.observedAt.length <= 40 ? item.observedAt : now,
    });
  }
  return result;
}

function normalizeSymbols(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new CoreError('invalid_request', 'relevantSymbols must be an array');
  if (value.length > MAX_SYMBOLS) {
    throw new CoreError('invalid_request', `relevantSymbols may hold at most ${MAX_SYMBOLS} entries`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    const symbol = String(entry ?? '').trim();
    if (!symbol) continue;
    if (symbol.length > MAX_SYMBOL_CHARS) {
      throw new CoreError('invalid_request', `relevantSymbols entries exceed ${MAX_SYMBOL_CHARS} characters`);
    }
    if (seen.has(symbol)) continue;
    seen.add(symbol);
    result.push(symbol);
  }
  return result;
}

function normalizePendingAction(value: unknown): ConversationPendingAction | null {
  if (value === null || value === undefined) return null;
  const item = value as Record<string, unknown>;
  const kind = String(item.kind ?? '') as ConversationPendingAction['kind'];
  if (!PENDING_KINDS.has(kind)) throw new CoreError('invalid_request', `unknown pendingAction kind '${kind}'`);
  return { kind, description: boundedText(item.description, MAX_CONSTRAINT_CHARS, 'pendingAction description') };
}

function normalizePolicy(value: unknown): ConversationExecutionPolicy | null {
  if (value === null || value === undefined) return null;
  const policy = String(value) as ConversationExecutionPolicy;
  if (!POLICIES.has(policy)) throw new CoreError('invalid_request', `unknown execution policy '${policy}'`);
  return policy;
}

function parseJsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(String(value ?? '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToRecord(row: Record<string, unknown>): ConversationWorkingStateRecord {
  let pendingAction: ConversationPendingAction | null = null;
  try {
    pendingAction = row.pendingAction ? JSON.parse(String(row.pendingAction)) as ConversationPendingAction : null;
  } catch {
    pendingAction = null;
  }
  return {
    conversationId: String(row.conversationId),
    workspaceIdentity: String(row.workspaceIdentity),
    objectiveId: String(row.objectiveId),
    currentObjective: String(row.currentObjective),
    latestUserIntent: String(row.latestUserIntent),
    latestExecutionPolicy: (row.latestExecutionPolicy as ConversationExecutionPolicy) ?? null,
    relevantFiles: parseJsonArray(row.relevantFiles) as ConversationRelevantFile[],
    relevantSymbols: parseJsonArray(row.relevantSymbols) as string[],
    userConstraints: parseJsonArray(row.userConstraints) as ConversationConstraint[],
    latestFindingsSummary: (row.latestFindingsSummary as string) ?? null,
    pendingAction,
    latestTaskId: (row.latestTaskId as string) ?? null,
    latestProposalId: (row.latestProposalId as string) ?? null,
    latestValidationSummary: (row.latestValidationSummary as string) ?? null,
    pendingNewObjective: Number(row.pendingNewObjective ?? 0) === 1,
    awaitingObjectiveClarification: Number(row.awaitingObjectiveClarification ?? 0) === 1,
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    version: Number(row.version),
  };
}

/**
 * Reads the working state for one conversation.
 *
 * `workspaceIdentity` is required and checked: a conversation restored under
 * a DIFFERENT workspace/profile gets `null`, never another project's
 * objective. Failing closed here (rather than at the caller) is what makes
 * workspace isolation a Core guarantee instead of a UI convention.
 */
export function getConversationWorkingState(
  db: CoreDatabase,
  conversationId: string,
  workspaceIdentity: string,
): ConversationWorkingStateRecord | null {
  const identity = String(workspaceIdentity ?? '').trim();
  if (!identity) throw new CoreError('invalid_request', 'workspaceIdentity is required');
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM conversation_working_state WHERE conversationId = ?',
    [conversationId],
  );
  if (!row) return null;
  if (String(row.workspaceIdentity) !== identity) return null;
  return rowToRecord(row);
}

/**
 * Reads the working state without a workspace check, for use INSIDE the
 * execution of an attempt that already belongs to this conversation. The
 * conversation itself is the scope there, so a second identity check would
 * only be able to fail on state the executor is already authorized to see.
 * Every client-facing read must use `getConversationWorkingState` instead.
 */
export function readConversationWorkingState(
  db: CoreDatabase,
  conversationId: string,
): ConversationWorkingStateRecord | null {
  const row = db.get<Record<string, unknown>>(
    'SELECT * FROM conversation_working_state WHERE conversationId = ?',
    [conversationId],
  );
  return row ? rowToRecord(row) : null;
}

export interface SaveConversationWorkingStateInput {
  workspaceIdentity: string;
  /**
   * When true the caller has determined the turn starts a NEW objective
   * (milestone Step 5). A new objectiveId is allocated and every
   * objective-scoped field — constraints, findings, pending action, relevant
   * files/symbols, task/proposal/validation ids — is dropped rather than
   * carried over. Objective boundaries are decided by the caller's
   * deterministic classifier; Core only enforces that "new objective" really
   * does mean "nothing obsolete survives".
   */
  startNewObjective?: boolean;
  currentObjective: string;
  latestUserIntent: string;
  latestExecutionPolicy?: ConversationExecutionPolicy | null;
  relevantFiles?: ConversationRelevantFile[];
  relevantSymbols?: string[];
  userConstraints?: ConversationConstraint[];
  latestFindingsSummary?: string | null;
  pendingAction?: ConversationPendingAction | null;
  latestTaskId?: string | null;
  latestProposalId?: string | null;
  latestValidationSummary?: string | null;
  /**
   * Explicit only — never inferred here. Omitted/undefined defaults to
   * `false`, so any ordinary turn write (which never has a reason to set it)
   * clears a stale flag automatically. A caller that must preserve it across
   * an unrelated write (e.g. recording task pointers while the user still
   * hasn't typed the new objective) passes the existing value through.
   */
  pendingNewObjective?: boolean;
  /**
   * Explicit only — never inferred here, mirroring `pendingNewObjective`.
   * Omitted/undefined defaults to `false`, so any ordinary turn write clears
   * a stale flag automatically once the exchange it was guarding is over.
   */
  awaitingObjectiveClarification?: boolean;
  actor: string;
  clientId?: string | null;
}

export function saveConversationWorkingState(
  db: CoreDatabase,
  conversationId: string,
  input: SaveConversationWorkingStateInput,
): ConversationWorkingStateRecord {
  return db.transaction(() => {
    const conversation = db.get<{ id: string }>('SELECT id FROM conversations WHERE id = ?', [conversationId]);
    if (!conversation) throw new CoreError('not_found', `conversation '${conversationId}' not found`);
    const workspaceIdentity = boundedText(input.workspaceIdentity, 200, 'workspaceIdentity');
    const existingRow = db.get<Record<string, unknown>>(
      'SELECT * FROM conversation_working_state WHERE conversationId = ?',
      [conversationId],
    );
    const existing = existingRow ? rowToRecord(existingRow) : null;
    if (existing && existing.workspaceIdentity !== workspaceIdentity) {
      // Never let a second workspace overwrite (or inherit) another one's
      // objective through a shared conversation id.
      throw new CoreError('conflict', 'conversation working state belongs to another workspace');
    }
    const now = nowIso();
    const startsNew = Boolean(input.startNewObjective) || !existing;
    const objectiveId = startsNew ? newId('obj') : existing!.objectiveId;

    const record: ConversationWorkingStateRecord = {
      conversationId,
      workspaceIdentity,
      objectiveId,
      currentObjective: boundedText(input.currentObjective, MAX_OBJECTIVE_CHARS, 'currentObjective'),
      latestUserIntent: boundedText(input.latestUserIntent, MAX_INTENT_CHARS, 'latestUserIntent'),
      latestExecutionPolicy: normalizePolicy(input.latestExecutionPolicy),
      relevantFiles: normalizeRelevantFiles(input.relevantFiles, now),
      relevantSymbols: normalizeSymbols(input.relevantSymbols),
      userConstraints: normalizeConstraints(input.userConstraints, now),
      latestFindingsSummary: optionalBoundedText(input.latestFindingsSummary, MAX_SUMMARY_CHARS, 'latestFindingsSummary'),
      pendingAction: normalizePendingAction(input.pendingAction),
      latestTaskId: optionalBoundedText(input.latestTaskId, 200, 'latestTaskId'),
      latestProposalId: optionalBoundedText(input.latestProposalId, 200, 'latestProposalId'),
      latestValidationSummary: optionalBoundedText(input.latestValidationSummary, MAX_SUMMARY_CHARS, 'latestValidationSummary'),
      pendingNewObjective: Boolean(input.pendingNewObjective),
      awaitingObjectiveClarification: Boolean(input.awaitingObjectiveClarification),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      version: (existing?.version ?? 0) + 1,
    };

    db.run(
      `INSERT INTO conversation_working_state (
         conversationId, workspaceIdentity, objectiveId, currentObjective, latestUserIntent,
         latestExecutionPolicy, relevantFiles, relevantSymbols, userConstraints,
         latestFindingsSummary, pendingAction, latestTaskId, latestProposalId,
         latestValidationSummary, pendingNewObjective, awaitingObjectiveClarification,
         createdAt, updatedAt, version
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(conversationId) DO UPDATE SET
         objectiveId = excluded.objectiveId,
         currentObjective = excluded.currentObjective,
         latestUserIntent = excluded.latestUserIntent,
         latestExecutionPolicy = excluded.latestExecutionPolicy,
         relevantFiles = excluded.relevantFiles,
         relevantSymbols = excluded.relevantSymbols,
         userConstraints = excluded.userConstraints,
         latestFindingsSummary = excluded.latestFindingsSummary,
         pendingAction = excluded.pendingAction,
         latestTaskId = excluded.latestTaskId,
         latestProposalId = excluded.latestProposalId,
         latestValidationSummary = excluded.latestValidationSummary,
         pendingNewObjective = excluded.pendingNewObjective,
         awaitingObjectiveClarification = excluded.awaitingObjectiveClarification,
         updatedAt = excluded.updatedAt,
         version = excluded.version`,
      [
        record.conversationId,
        record.workspaceIdentity,
        record.objectiveId,
        record.currentObjective,
        record.latestUserIntent,
        record.latestExecutionPolicy,
        JSON.stringify(record.relevantFiles),
        JSON.stringify(record.relevantSymbols),
        JSON.stringify(record.userConstraints),
        record.latestFindingsSummary,
        record.pendingAction ? JSON.stringify(record.pendingAction) : null,
        record.latestTaskId,
        record.latestProposalId,
        record.latestValidationSummary,
        record.pendingNewObjective ? 1 : 0,
        record.awaitingObjectiveClarification ? 1 : 0,
        record.createdAt,
        record.updatedAt,
        record.version,
      ],
    );
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: conversationId,
      eventType: startsNew ? 'conversation_objective_started' : 'conversation_working_state_updated',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { objectiveId, version: record.version, policy: record.latestExecutionPolicy },
      resultingRevision: record.version,
    });
    return record;
  });
}

export function clearConversationWorkingState(db: CoreDatabase, conversationId: string, workspaceIdentity: string): void {
  db.run(
    'DELETE FROM conversation_working_state WHERE conversationId = ? AND workspaceIdentity = ?',
    [conversationId, workspaceIdentity],
  );
}

/**
 * Renders the working state as ONE short system message for Baat Kar / Saath
 * Kar prompts.
 *
 * The framing is deliberate and load-bearing: the model is told this is a
 * remembered summary and that the repository — not this text — is the
 * authority on current file contents. Without that framing a persisted
 * narrative starts behaving like evidence, which is precisely what the
 * milestone's PRINCIPLE forbids.
 */
export function formatContinuityBrief(record: ConversationWorkingStateRecord): string {
  const lines: string[] = [
    'Continuing an earlier conversation in this workspace. The following is a remembered summary of the'
    + ' objective, not evidence about the current code — re-read any file before relying on its contents.',
    `Objective: ${record.currentObjective}`,
  ];
  if (record.userConstraints.length) {
    lines.push(`Constraints the user set for this objective (still in force): ${record.userConstraints.map(item => item.text).join('; ')}`);
  }
  if (record.relevantFiles.length) {
    lines.push(`Files referred to so far: ${record.relevantFiles.map(item => item.path).join(', ')}`);
  }
  if (record.relevantSymbols.length) {
    lines.push(`Symbols referred to so far: ${record.relevantSymbols.join(', ')}`);
  }
  if (record.latestFindingsSummary) {
    lines.push(`What was previously found: ${record.latestFindingsSummary}`);
  }
  if (record.latestValidationSummary) {
    lines.push(`Latest validation result: ${record.latestValidationSummary}`);
  }
  if (record.pendingAction) {
    lines.push(`Unfinished next action: ${record.pendingAction.description}`);
  }
  return lines.join('\n');
}
