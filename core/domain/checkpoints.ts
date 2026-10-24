import type { CoreDatabase } from '../db/connection';
import type { CheckpointRecord } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

const MAX_METADATA_BYTES = 8192;

function boundedMetadata(metadata: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(metadata ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_METADATA_BYTES) {
    throw new CoreError('invalid_request', `checkpoint metadata exceeds ${MAX_METADATA_BYTES} bytes`);
  }
  return json;
}

function rowToCheckpoint(row: Record<string, unknown>): CheckpointRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    kind: String(row.kind),
    createdAt: String(row.createdAt),
    metadata: JSON.parse(String(row.metadata ?? '{}')),
  };
}

export interface CreateCheckpointInput {
  attemptId: string;
  kind: string;
  metadata?: Record<string, unknown>;
  actor: string;
  clientId?: string | null;
}

export function createCheckpoint(db: CoreDatabase, input: CreateCheckpointInput): CheckpointRecord {
  return db.transaction(() => {
    const attempt = db.get('SELECT id FROM attempts WHERE id = ?', [input.attemptId]);
    if (!attempt) throw new CoreError('invalid_request', `attempt '${input.attemptId}' does not exist`);
    const id = newId('ckpt');
    const now = nowIso();
    db.run(`INSERT INTO checkpoints (id, attemptId, kind, createdAt, metadata) VALUES (?, ?, ?, ?, ?)`, [
      id,
      input.attemptId,
      input.kind,
      now,
      boundedMetadata(input.metadata),
    ]);
    recordRuntimeEvent(db, {
      domain: 'attempt',
      entityId: input.attemptId,
      eventType: 'checkpoint_created',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { checkpointId: id, kind: input.kind },
    });
    return rowToCheckpoint({ id, attemptId: input.attemptId, kind: input.kind, createdAt: now, metadata: boundedMetadata(input.metadata) });
  });
}

export function listCheckpointsForAttempt(db: CoreDatabase, attemptId: string): CheckpointRecord[] {
  const rows = db.all<Record<string, unknown>>('SELECT * FROM checkpoints WHERE attemptId = ? ORDER BY createdAt ASC', [attemptId]);
  return rows.map(rowToCheckpoint);
}
