/**
 * The outcome record of a task.
 *
 * A task is not a prompt. While it runs, the assistant keeps one durable
 * record of:
 *
 *   - the user's objective and the conditions that would make it successful,
 *   - the capabilities it chose to use,
 *   - the evidence that the work actually happened,
 *   - the blocker, when something outside its reach stops it,
 *   - the next action, so a restart or a change of surface can pick it up.
 *
 * The record is written by the assistant itself, during the turn, through
 * `update_task_outcome` — not reconstructed afterwards from the transcript.
 * That is what makes it usable for continuity: a task that was interrupted
 * still has its objective, its criteria and its next action.
 *
 * Two rules the module enforces:
 *   1. A task cannot be `satisfied` without evidence. "I did it" is not
 *      evidence; a tool invocation, a created artifact, a completed
 *      commitment or a verified result is.
 *   2. A task that is blocked must say what blocks it, and a task that is
 *      partial must name what is left. Otherwise the status is a mood.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';

export const TASK_OUTCOME_STATUSES = ['in_progress', 'satisfied', 'partial', 'blocked'] as const;
export type TaskOutcomeStatus = (typeof TASK_OUTCOME_STATUSES)[number];

export const TASK_OUTCOME_MAX_OBJECTIVE = 1_000;
export const TASK_OUTCOME_MAX_CRITERIA = 400;
export const TASK_OUTCOME_MAX_ITEMS = 20;
export const TASK_OUTCOME_MAX_BLOCKER = 1_000;
export const TASK_OUTCOME_MAX_NEXT_ACTION = 1_000;
export const TASK_OUTCOME_MAX_SUMMARY = 2_000;

/** One piece of proof. Never prose, never a claim. */
export interface TaskOutcomeEvidence {
  /** What kind of proof this is, e.g. 'tool_invocation', 'artifact', 'approval'. */
  kind: string;
  /** The identifier of the thing that proves it. */
  reference: string;
}

export interface TaskOutcomeRecord {
  attemptId: string;
  conversationId: string | null;
  requestId: string | null;
  objective: string;
  successCriteria: string[];
  capabilities: string[];
  evidence: TaskOutcomeEvidence[];
  status: TaskOutcomeStatus;
  blocker: string | null;
  nextAction: string | null;
  summary: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpdateTaskOutcomeInput {
  attemptId: string;
  conversationId?: string | null;
  requestId?: string | null;
  objective?: string;
  successCriteria?: string[];
  capabilities?: string[];
  evidence?: TaskOutcomeEvidence[];
  status?: TaskOutcomeStatus;
  blocker?: string | null;
  nextAction?: string | null;
  summary?: string | null;
}

function boundedText(value: string | null | undefined, field: string, max: number, required: boolean): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) {
    if (required) throw new CoreError('invalid_request', `${field} is required`);
    return '';
  }
  if (trimmed.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return trimmed;
}

function boundedList(values: readonly string[] | undefined, field: string, max: number): string[] {
  if (!values) return [];
  if (!Array.isArray(values)) throw new CoreError('invalid_request', `${field} must be an array of strings`);
  if (values.length > TASK_OUTCOME_MAX_ITEMS) {
    throw new CoreError('invalid_request', `${field} may contain at most ${TASK_OUTCOME_MAX_ITEMS} entries`);
  }
  return values
    .map((value) => boundedText(String(value ?? ''), field, max, false))
    .filter(Boolean)
    .slice(0, TASK_OUTCOME_MAX_ITEMS);
}

function boundedEvidence(values: TaskOutcomeEvidence[] | undefined): TaskOutcomeEvidence[] {
  if (!values) return [];
  if (!Array.isArray(values)) throw new CoreError('invalid_request', 'evidence must be an array of { kind, reference }');
  if (values.length > TASK_OUTCOME_MAX_ITEMS) {
    throw new CoreError('invalid_request', `evidence may contain at most ${TASK_OUTCOME_MAX_ITEMS} entries`);
  }
  return values
    .map((entry) => ({
      kind: boundedText(String(entry?.kind ?? ''), 'evidence kind', 80, true),
      reference: boundedText(String(entry?.reference ?? ''), 'evidence reference', 200, true),
    }))
    .slice(0, TASK_OUTCOME_MAX_ITEMS);
}

function mapOutcome(row: Record<string, unknown>): TaskOutcomeRecord {
  const parseArray = (value: unknown): string[] => {
    try {
      const parsed = JSON.parse(String(value ?? '[]'));
      return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
    } catch {
      return [];
    }
  };
  const parseEvidence = (value: unknown): TaskOutcomeEvidence[] => {
    try {
      const parsed = JSON.parse(String(value ?? '[]'));
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry): entry is TaskOutcomeEvidence => Boolean(entry) && typeof entry === 'object')
        .map((entry) => ({ kind: String(entry.kind), reference: String(entry.reference) }));
    } catch {
      return [];
    }
  };
  return {
    attemptId: String(row.attemptId),
    conversationId: row.conversationId == null ? null : String(row.conversationId),
    requestId: row.requestId == null ? null : String(row.requestId),
    objective: String(row.objective),
    successCriteria: parseArray(row.successCriteria),
    capabilities: parseArray(row.capabilities),
    evidence: parseEvidence(row.evidence),
    status: String(row.status ?? 'in_progress') as TaskOutcomeStatus,
    blocker: row.blocker == null ? null : String(row.blocker),
    nextAction: row.nextAction == null ? null : String(row.nextAction),
    summary: row.summary == null ? null : String(row.summary),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export function getTaskOutcome(db: CoreDatabase, attemptId: string): TaskOutcomeRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM task_outcomes WHERE attemptId = ?', [attemptId]);
  return row ? mapOutcome(row) : undefined;
}

export function listTaskOutcomes(
  db: CoreDatabase,
  filter: { conversationId?: string | null; status?: string | null; limit?: number } = {},
): TaskOutcomeRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.conversationId) {
    clauses.push('conversationId = ?');
    params.push(filter.conversationId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, Number(filter.limit ?? 50)));
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM task_outcomes ${where} ORDER BY updatedAt DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map(mapOutcome);
}

/**
 * Creates or updates the outcome record of a task.
 *
 * The status is checked against the rest of the record, so a task cannot be
 * marked `satisfied` on a promise, and a blocked task always says what
 * blocks it.
 */
export function updateTaskOutcome(db: CoreDatabase, input: UpdateTaskOutcomeInput): TaskOutcomeRecord {
  const attemptId = String(input.attemptId ?? '').trim();
  if (!attemptId) throw new CoreError('invalid_request', 'attemptId is required');
  const existing = getTaskOutcome(db, attemptId);
  const at = nowIso();

  const objective = input.objective !== undefined
    ? boundedText(input.objective, 'objective', TASK_OUTCOME_MAX_OBJECTIVE, true)
    : existing?.objective ?? '';
  if (!objective) throw new CoreError('invalid_request', 'objective is required');

  const successCriteria = input.successCriteria !== undefined
    ? boundedList(input.successCriteria, 'successCriteria', TASK_OUTCOME_MAX_CRITERIA)
    : existing?.successCriteria ?? [];
  const capabilities = input.capabilities !== undefined
    ? boundedList(input.capabilities, 'capabilities', 120)
    : existing?.capabilities ?? [];
  const evidence = input.evidence !== undefined
    ? boundedEvidence(input.evidence)
    : existing?.evidence ?? [];
  const status = input.status ?? existing?.status ?? 'in_progress';
  if (!(TASK_OUTCOME_STATUSES as readonly string[]).includes(status)) {
    throw new CoreError('invalid_request', `status must be one of ${TASK_OUTCOME_STATUSES.join(', ')}`);
  }
  const blocker = input.blocker !== undefined
    ? (boundedText(input.blocker, 'blocker', TASK_OUTCOME_MAX_BLOCKER, false) || null)
    : existing?.blocker ?? null;
  const nextAction = input.nextAction !== undefined
    ? (boundedText(input.nextAction, 'nextAction', TASK_OUTCOME_MAX_NEXT_ACTION, false) || null)
    : existing?.nextAction ?? null;
  const summary = input.summary !== undefined
    ? (boundedText(input.summary, 'summary', TASK_OUTCOME_MAX_SUMMARY, false) || null)
    : existing?.summary ?? null;

  if (status === 'satisfied' && evidence.length === 0) {
    throw new CoreError('invalid_request', 'a task can only be satisfied with evidence that the work happened');
  }
  if (status === 'blocked' && !blocker) {
    throw new CoreError('invalid_request', 'a blocked task must say what blocks it');
  }
  if (status === 'partial' && !nextAction) {
    throw new CoreError('invalid_request', 'a partial task must name the next action that would finish it');
  }

  if (existing) {
    db.run(
      `UPDATE task_outcomes
          SET objective = ?, successCriteria = ?, capabilities = ?, evidence = ?, status = ?,
              blocker = ?, nextAction = ?, summary = ?, updatedAt = ?
        WHERE attemptId = ?`,
      [
        objective,
        JSON.stringify(successCriteria),
        JSON.stringify(capabilities),
        JSON.stringify(evidence),
        status,
        blocker,
        nextAction,
        summary,
        at,
        attemptId,
      ],
    );
  } else {
    db.run(
      `INSERT INTO task_outcomes
         (attemptId, conversationId, requestId, objective, successCriteria, capabilities, evidence, status, blocker, nextAction, summary, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        attemptId,
        input.conversationId ?? null,
        input.requestId ?? null,
        objective,
        JSON.stringify(successCriteria),
        JSON.stringify(capabilities),
        JSON.stringify(evidence),
        status,
        blocker,
        nextAction,
        summary,
        at,
        at,
      ],
    );
  }
  const stored = getTaskOutcome(db, attemptId);
  if (!stored) throw new CoreError('not_found', 'the task outcome was not stored');
  return stored;
}

/**
 * The objective of a request, bounded to what a person can read back.
 *
 * It is the user's own words, not a summary the assistant invented: the
 * record exists so the work can be resumed, and a rewritten objective would
 * be a second, vaguer truth.
 */
export function objectiveFromRequest(currentMessage: string): string {
  const text = String(currentMessage ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return 'the request as given';
  return text.length > TASK_OUTCOME_MAX_OBJECTIVE
    ? `${text.slice(0, TASK_OUTCOME_MAX_OBJECTIVE - 1)}…`
    : text;
}

/**
 * Creates the task record for a request, if there is not one already.
 *
 * This is the deterministic half of the task record: Core creates the record
 * the moment a substantive request starts, so the objective, the state and
 * the next action exist even if the assistant never gets to the point of
 * describing them. The assistant can then enrich the same row — that is what
 * `update_task_outcome` does — and it can never lose the record, because the
 * record was never the assistant's to create.
 *
 * A record that already exists is left exactly as it is: the assistant's own
 * objective, criteria and evidence are never overwritten by the raw request.
 */
export function ensureTaskOutcome(
  db: CoreDatabase,
  input: { attemptId: string; conversationId?: string | null; requestId?: string | null; objective: string },
): TaskOutcomeRecord {
  const existing = getTaskOutcome(db, input.attemptId);
  if (existing) return existing;
  return updateTaskOutcome(db, {
    attemptId: input.attemptId,
    conversationId: input.conversationId ?? null,
    requestId: input.requestId ?? null,
    objective: input.objective,
    status: 'in_progress',
  });
}

/**
 * Stamps a finished turn's evidence onto the task outcome.
 *
 * This is the one place where Core decides a task's final truth from what
 * actually happened, rather than from what the model said. A turn that
 * performed no consequential action leaves the record alone: an answer is not
 * a task, and forcing a verdict onto it would be noise.
 */
export function finalizeTaskOutcome(
  db: CoreDatabase,
  attemptId: string,
  outcome: { verdict: 'verified' | 'unverified' | 'attempted_failed' | 'conversational'; reason: string; performed: string[]; refused: string[]; failed: string[] },
  context: { answerMessageId?: string | null } = {},
): TaskOutcomeRecord | undefined {
  const existing = getTaskOutcome(db, attemptId);
  if (!existing) return undefined;
  if (outcome.verdict === 'conversational') {
    // The request was answered rather than acted on. The answer itself is the
    // evidence: it is a durable message in the conversation, with an id that
    // points at it.
    const answerEvidence: TaskOutcomeEvidence[] = context.answerMessageId
      ? [{ kind: 'answer', reference: context.answerMessageId }]
      : [];
    const evidence = [...existing.evidence, ...answerEvidence];
    if (existing.status === 'in_progress' && evidence.length === 0) {
      // Nothing to point at: leave the record as it is rather than claiming
      // a satisfaction nobody can check.
      return existing;
    }
    return updateTaskOutcome(db, {
      attemptId,
      status: existing.status === 'in_progress' ? 'satisfied' : existing.status,
      evidence,
      summary: existing.summary ?? outcome.reason,
    });
  }
  if (outcome.verdict === 'verified') {
    const evidence: TaskOutcomeEvidence[] = [
      ...existing.evidence,
      ...outcome.performed.map((tool) => ({ kind: 'tool', reference: tool })),
    ];
    return updateTaskOutcome(db, {
      attemptId,
      status: existing.status === 'blocked' ? 'blocked' : 'satisfied',
      evidence,
      summary: existing.summary ?? outcome.reason,
    });
  }
  // The requested work did not happen, or it happened and failed. Either way
  // the task is not satisfied, and the reason says exactly which step.
  return updateTaskOutcome(db, {
    attemptId,
    status: 'partial',
    evidence: existing.evidence,
    blocker: outcome.reason,
    nextAction: existing.nextAction ?? 'Retry the step that did not run, or tell the user what is needed to unblock it.',
    summary: existing.summary ?? outcome.reason,
  });
}
