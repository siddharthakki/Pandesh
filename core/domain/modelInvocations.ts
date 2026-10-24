import type { CoreDatabase } from '../db/connection';
import type { AttemptStatus, ModelInvocationRecord, ModelInvocationStatus } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { isTerminalAttemptStatus } from './attemptTransitions';

const MAX_USAGE_METADATA_BYTES = 4096;

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function boundedUsage(metadata: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(metadata ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_USAGE_METADATA_BYTES) {
    // Bound rather than reject — usage metadata is diagnostic, not something a caller
    // should have to retry over. Drop it instead of failing the invocation record.
    return '{}';
  }
  return json;
}

function rowToInvocation(row: Record<string, unknown>): ModelInvocationRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    requestedProvider: (row.requestedProvider as string) ?? null,
    requestedModel: (row.requestedModel as string) ?? null,
    policyProvider: (row.policyProvider as string) ?? null,
    policyModel: (row.policyModel as string) ?? null,
    actualProvider: (row.actualProvider as string) ?? null,
    actualModel: (row.actualModel as string) ?? null,
    fallbackUsed: Boolean(row.fallbackUsed),
    fallbackReason: (row.fallbackReason as string) ?? null,
    status: row.status as ModelInvocationStatus,
    startedAt: String(row.startedAt),
    endedAt: (row.endedAt as string) ?? null,
    latencyMs: row.latencyMs === null || row.latencyMs === undefined ? null : Number(row.latencyMs),
    usageMetadata: JSON.parse(String(row.usageMetadata ?? '{}')),
  };
}

export function getModelInvocation(db: CoreDatabase, id: string): ModelInvocationRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM model_invocations WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `model invocation '${id}' not found`);
  return rowToInvocation(row);
}

export interface StartModelInvocationInput {
  attemptId: string;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  policyProvider?: string | null;
  policyModel?: string | null;
  actor: string;
  clientId?: string | null;
}

/** Records the requested/policy-selected model *before* the call is made — this is
 * how "requested model" stays truthful even if the call never completes. */
export function startModelInvocation(db: CoreDatabase, input: StartModelInvocationInput): ModelInvocationRecord {
  return db.transaction(() => {
    const attempt = db.get<{ id: string; status: string; cancelRequestedAt: string | null }>(
      'SELECT id, status, cancelRequestedAt FROM attempts WHERE id = ?',
      [input.attemptId],
    );
    if (!attempt) throw new CoreError('invalid_request', `attempt '${input.attemptId}' does not exist`);
    if (isTerminalAttemptStatus(attempt.status as AttemptStatus) || attempt.cancelRequestedAt) {
      throw new CoreError('invalid_transition', `attempt '${input.attemptId}' cannot start model work after cancellation or terminal completion`);
    }
    const id = newId('minv');
    const now = nowIso();
    db.run(
      `INSERT INTO model_invocations (id, attemptId, requestedProvider, requestedModel, policyProvider, policyModel, status, startedAt)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [id, input.attemptId, input.requestedProvider ?? null, input.requestedModel ?? null, input.policyProvider ?? null, input.policyModel ?? null, now],
    );
    recordRuntimeEvent(db, {
      domain: 'model_invocation',
      entityId: id,
      eventType: 'model_invocation_started',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attemptId: input.attemptId, requestedProvider: input.requestedProvider ?? null, requestedModel: input.requestedModel ?? null },
    });
    return getModelInvocation(db, id);
  });
}

export interface CompleteModelInvocationInput {
  status: 'succeeded' | 'failed' | 'cancelled';
  actualProvider?: string | null;
  actualModel?: string | null;
  fallbackUsed?: boolean;
  fallbackReason?: string | null;
  usageMetadata?: Record<string, unknown>;
  cancellationReason?: string | null;
  cancelledAt?: string | null;
  actor: string;
  clientId?: string | null;
}

/**
 * Records the truth of what actually happened: actual provider/model invoked,
 * whether fallback occurred and why, latency. No silent fallback — fallbackUsed=true
 * always requires fallbackReason to be set (enforced here, not left to callers).
 */
export function completeModelInvocation(db: CoreDatabase, id: string, input: CompleteModelInvocationInput): ModelInvocationRecord {
  if (input.fallbackUsed && !input.fallbackReason) {
    throw new CoreError('invalid_request', 'fallbackReason is required when fallbackUsed is true');
  }
  if (input.status !== 'cancelled' && (input.cancellationReason || input.cancelledAt)) {
    throw new CoreError('invalid_request', 'cancellation evidence is only valid for a cancelled model invocation');
  }
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM model_invocations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `model invocation '${id}' not found`);
    if (existing.status !== 'pending') {
      throw new CoreError('invalid_transition', `model invocation '${id}' is already resolved (${existing.status})`);
    }
    const now = input.cancelledAt ?? nowIso();
    const latencyMs = new Date(now).getTime() - new Date(existing.startedAt as string).getTime();
    const usageMetadata = input.status === 'cancelled'
      ? {
          ...(input.usageMetadata ?? {}),
          cancellationReason: input.cancellationReason ?? 'attempt_cancelled',
          cancelledAt: now,
        }
      : input.usageMetadata;
    db.run(
      `UPDATE model_invocations SET status = ?, actualProvider = ?, actualModel = ?, fallbackUsed = ?, fallbackReason = ?, endedAt = ?, latencyMs = ?, usageMetadata = ? WHERE id = ?`,
      [
        input.status,
        input.actualProvider ?? null,
        input.actualModel ?? null,
        input.fallbackUsed ? 1 : 0,
        input.fallbackReason ?? null,
        now,
        latencyMs,
        boundedUsage(usageMetadata),
        id,
      ],
    );
    recordRuntimeEvent(db, {
      domain: 'model_invocation',
      entityId: id,
      eventType: 'model_invocation_completed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: {
        status: input.status,
        attemptId: String(existing.attemptId),
        actualProvider: input.actualProvider ?? null,
        actualModel: input.actualModel ?? null,
        fallbackUsed: Boolean(input.fallbackUsed),
        fallbackReason: input.fallbackReason ?? null,
        cancellationReason: input.status === 'cancelled' ? (input.cancellationReason ?? 'attempt_cancelled') : null,
        cancelledAt: input.status === 'cancelled' ? now : null,
        promptTokens: numberOrNull(usageMetadata?.promptTokens),
        completionTokens: numberOrNull(usageMetadata?.completionTokens),
        durationMs: numberOrNull(usageMetadata?.durationMs) ?? latencyMs,
        // Null when the backend did not report it. Never fall back to
        // durationMs: that is end-to-end and would overstate generation speed.
        generationMs: numberOrNull(usageMetadata?.generationMs),
        costUsd: numberOrNull(usageMetadata?.costUsd ?? usageMetadata?.cost),
      },
    });
    return getModelInvocation(db, id);
  });
}

export interface CancelModelInvocationsForAttemptInput {
  actor: string;
  clientId?: string | null;
  reason?: string;
  cancelledAt?: string;
}

/**
 * Resolves every invocation still owned by a cancelling attempt. The query is
 * scoped by attemptId, so cancellation can never spill into another attempt.
 * Repeated calls are idempotent: only nonterminal rows are selected and only
 * the first call records completion events.
 */
export function cancelNonterminalModelInvocationsForAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: CancelModelInvocationsForAttemptInput,
): ModelInvocationRecord[] {
  return db.transaction(() => {
    const cancelledAt = input.cancelledAt ?? nowIso();
    const rows = db.all<{ id: string }>(
      `SELECT id FROM model_invocations
       WHERE attemptId = ? AND status NOT IN ('succeeded', 'failed', 'cancelled')
       ORDER BY startedAt ASC`,
      [attemptId],
    );
    return rows.map(({ id }) => completeModelInvocation(db, id, {
      status: 'cancelled',
      cancellationReason: input.reason ?? 'attempt_cancelled',
      cancelledAt,
      actor: input.actor,
      clientId: input.clientId,
    }));
  });
}

export function listModelInvocationsForAttempt(db: CoreDatabase, attemptId: string): ModelInvocationRecord[] {
  const rows = db.all<Record<string, unknown>>('SELECT * FROM model_invocations WHERE attemptId = ? ORDER BY startedAt ASC', [attemptId]);
  return rows.map(rowToInvocation);
}
