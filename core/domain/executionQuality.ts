import type { CoreDatabase } from '../db/connection';
import type {
  ExecutionQualityEvidenceInput,
  ExecutionQualityEventType,
  RuntimeEventRecord,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { getAttempt } from './attempts';
import { recordRuntimeEvent } from './runtimeEvents';

const MAX_VALIDATION_REPAIR_CYCLES = 2;
const EVENT_TYPES = new Set<ExecutionQualityEventType>([
  'model_selection_decided',
  'repository_path_corrected',
  'repository_path_blocked',
  'loop_detected',
  'redundant_exploration_refused',
  'exploration_budget_refused',
  'exploration_budget_nudge',
  'strategy_changed',
  'decision_required',
  'model_escalated',
  'model_routing_fallback',
  'validation_failed',
  'validation_repair_started',
  'validation_repair_completed',
  'validation_repair_unavailable',
  'validation_repair_exhausted',
  'retry_created',
  'final_verification_recorded',
]);

export interface RecordExecutionQualityInput extends ExecutionQualityEvidenceInput {
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Appends bounded execution-quality evidence to Core's existing durable event
 * authority. There is deliberately no second M34 store. Repair-cycle bounds
 * are enforced here as well as by the worker so a buggy client cannot record
 * or claim an unbounded repair loop.
 */
export function recordExecutionQuality(
  db: CoreDatabase,
  attemptId: string,
  input: RecordExecutionQualityInput,
): RuntimeEventRecord {
  return db.transaction(() => {
    getAttempt(db, attemptId);
    if (!EVENT_TYPES.has(input.eventType)) {
      throw new CoreError('invalid_request', `unknown execution-quality event '${input.eventType}'`);
    }
    if (!input.metadata || Array.isArray(input.metadata) || typeof input.metadata !== 'object') {
      throw new CoreError('invalid_request', 'execution-quality metadata must be an object');
    }
    if (input.idempotencyKey) {
      const existing = db.get<Record<string, unknown>>(
        `SELECT sequence, id, domain, entityId, eventType, actor, clientId,
                idempotencyKey, createdAt, metadata, resultingRevision
         FROM runtime_events
         WHERE domain = 'execution_quality' AND entityId = ? AND idempotencyKey = ?`,
        [attemptId, input.idempotencyKey],
      );
      if (existing) return rowToEvent(existing);
    }
    if (input.eventType === 'validation_repair_started') {
      const count = db.get<{ count: number }>(
        `SELECT COUNT(*) AS count FROM runtime_events
         WHERE domain = 'execution_quality' AND entityId = ? AND eventType = 'validation_repair_started'`,
        [attemptId],
      )?.count ?? 0;
      const cycle = Number(input.metadata['cycle']);
      if (count >= MAX_VALIDATION_REPAIR_CYCLES || cycle !== count + 1) {
        throw new CoreError('invalid_request', `validation repair cycle must be ${count + 1} and may not exceed ${MAX_VALIDATION_REPAIR_CYCLES}`);
      }
    }
    return recordRuntimeEvent(db, {
      domain: 'execution_quality',
      entityId: attemptId,
      eventType: input.eventType,
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: input.metadata,
    });
  });
}

export function listExecutionQualityEvents(db: CoreDatabase, attemptId: string): RuntimeEventRecord[] {
  return db.all<Record<string, unknown>>(
    `SELECT sequence, id, domain, entityId, eventType, actor, clientId,
            idempotencyKey, createdAt, metadata, resultingRevision
     FROM runtime_events
     WHERE domain = 'execution_quality' AND entityId = ? ORDER BY sequence ASC`,
    [attemptId],
  ).map(rowToEvent);
}

function rowToEvent(row: Record<string, unknown>): RuntimeEventRecord {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    domain: 'execution_quality',
    entityId: String(row.entityId),
    eventType: String(row.eventType),
    actor: String(row.actor),
    clientId: (row.clientId as string) ?? null,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    createdAt: String(row.createdAt),
    metadata: JSON.parse(String(row.metadata ?? '{}')) as Record<string, unknown>,
    resultingRevision: row.resultingRevision === null || row.resultingRevision === undefined ? null : Number(row.resultingRevision),
  };
}

export { MAX_VALIDATION_REPAIR_CYCLES };
