import type { CoreDatabase } from '../db/connection';
import type { StoryEventRecord, StoryEventType } from '../shared/wireTypes';
import { newId, nowIso } from './ids';

export interface RecordEventInput {
  storyId: string;
  eventType: StoryEventType;
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
    throw new Error(`story_events.metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

/**
 * Inserts an append-only story_event row. Must always be called inside the
 * same db.transaction() as the mutation it documents, per the M31 contract
 * that every successful story mutation produces exactly one event.
 */
export function recordStoryEvent(db: CoreDatabase, input: RecordEventInput): StoryEventRecord {
  const id = newId('evt');
  const createdAt = nowIso();
  const metadataJson = boundedMetadata(input.metadata);
  const result = db.run(
    `INSERT INTO story_events (id, storyId, eventType, actor, clientId, idempotencyKey, createdAt, metadata, resultingRevision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.storyId,
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
    storyId: input.storyId,
    eventType: input.eventType,
    actor: input.actor,
    clientId: input.clientId ?? null,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt,
    metadata: input.metadata ?? {},
    resultingRevision: input.resultingRevision ?? null,
  };
}

export function listEventsAfter(db: CoreDatabase, afterSequence: number, limit: number): StoryEventRecord[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT sequence, id, storyId, eventType, actor, clientId, idempotencyKey, createdAt, metadata, resultingRevision
     FROM story_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`,
    [afterSequence, limit],
  );
  return rows.map(rowToEvent);
}

export function latestSequence(db: CoreDatabase): number {
  const row = db.get<{ maxSeq: number | null }>('SELECT MAX(sequence) as maxSeq FROM story_events');
  return row?.maxSeq ?? 0;
}

function rowToEvent(row: Record<string, unknown>): StoryEventRecord {
  return {
    sequence: Number(row.sequence),
    id: String(row.id),
    storyId: String(row.storyId),
    eventType: row.eventType as StoryEventType,
    actor: String(row.actor),
    clientId: (row.clientId as string) ?? null,
    idempotencyKey: (row.idempotencyKey as string) ?? null,
    createdAt: String(row.createdAt),
    metadata: JSON.parse(String(row.metadata ?? '{}')),
    resultingRevision: row.resultingRevision === null || row.resultingRevision === undefined ? null : Number(row.resultingRevision),
  };
}
