import type { CoreDatabase } from '../db/connection';
import type { RuntimeEventRecord, RuntimeEventDomain } from '../shared/wireTypes';
import { newId, nowIso } from './ids';

export interface RecordRuntimeEventInput {
  domain: RuntimeEventDomain;
  entityId: string;
  eventType: string;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
  resultingRevision?: number | null;
}

const MAX_METADATA_BYTES = 8192;

function boundedMetadata(metadata: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(metadata ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_METADATA_BYTES) {
    throw new Error(`runtime_events.metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

/**
 * Append-only runtime_events row, parallel to (never merged with) story_events —
 * see docs/m32-decisions.md D3. Must always be called inside the same
 * db.transaction() as the mutation it documents.
 */
export function recordRuntimeEvent(db: CoreDatabase, input: RecordRuntimeEventInput): RuntimeEventRecord {
  const id = newId('revt');
  const createdAt = nowIso();
  const metadataJson = boundedMetadata(input.metadata);
  const result = db.run(
    `INSERT INTO runtime_events (id, domain, entityId, eventType, actor, clientId, idempotencyKey, createdAt, metadata, resultingRevision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.domain,
      input.entityId,
      input.eventType,
      input.actor,
      input.clientId ?? null,
      input.idempotencyKey ?? null,
      createdAt,
      metadataJson,
      input.resultingRevision ?? null,
    ],
  );
  return {
    sequence: Number(result.lastInsertRowid),
    id,
    domain: input.domain,
    entityId: input.entityId,
    eventType: input.eventType,
    actor: input.actor,
    clientId: input.clientId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt,
    metadata: input.metadata ?? {},
    resultingRevision: input.resultingRevision ?? null,
  };
}

export function listRuntimeEventsAfter(db: CoreDatabase, afterSequence: number, limit: number): RuntimeEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT sequence, id, domain, entityId, eventType, actor, clientId, idempotencyKey, createdAt, metadata, resultingRevision
     FROM runtime_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
    [afterSequence, limit],
  );
  return rows.map(rowToEvent);
}

/** Returns a bounded event tail for exactly one attempt and records directly
 * owned by it. This deliberately excludes conversation-wide history so an
 * activation cannot replay an older turn into the current projection. */
export function listRuntimeEventsForAttempt(db: CoreDatabase, attemptId: string, limit = 20): RuntimeEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT sequence, id, domain, entityId, eventType, actor, clientId, idempotencyKey, createdAt, metadata, resultingRevision
     FROM runtime_events
     WHERE (domain = 'attempt' AND entityId = ?)
        OR (domain = 'execution_quality' AND entityId = ?)
        OR (domain = 'approval' AND entityId IN (SELECT id FROM approvals WHERE attemptId = ?))
        OR (domain = 'model_invocation' AND entityId IN (SELECT id FROM model_invocations WHERE attemptId = ?))
        OR (domain = 'tool_invocation' AND entityId IN (SELECT id FROM tool_invocations WHERE attemptId = ?))
     ORDER BY sequence DESC LIMIT ?`,
    [attemptId, attemptId, attemptId, attemptId, attemptId, Math.max(1, Math.min(limit, 100))],
  );
  return rows.reverse().map(rowToEvent);
}

export function latestRuntimeSequence(db: CoreDatabase): number {
  const row = db.get<{ maxSeq: number | null }>('SELECT MAX(sequence) as maxSeq FROM runtime_events');
  return row?.maxSeq ?? 0;
}

function rowToEvent(row: Record<string, unknown>): RuntimeEventRecord {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    domain: row.domain as RuntimeEventDomain,
    entityId: String(row.entityId),
    eventType: String(row.eventType),
    actor: String(row.actor),
    clientId: (row.clientId as string) ?? null,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    createdAt: String(row.createdAt),
    metadata: JSON.parse(String(row.metadata ?? '{}')),
    resultingRevision: row.resultingRevision === null || row.resultingRevision === undefined ? null : Number(row.resultingRevision),
  };
}
