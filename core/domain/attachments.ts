import type { CoreDatabase } from '../db/connection';
import type {
  AttachmentErrorCode,
  AttachmentKind,
  AttachmentRecord,
  AttachmentStatus,
  AudioTranscriptionResult,
  DocumentExtractionResult,
  FrozenAttachmentReference,
  LocalProcessingCapability,
  MessageAttachmentLink,
} from '../shared/wireTypes';
import { MAX_ATTACHMENTS_PER_TURN, MAX_ATTACHMENT_BYTES } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { listMessages } from './conversations';

const SUPPORTED_ATTACHMENT_KINDS: readonly AttachmentKind[] = ['text', 'image', 'document', 'audio'];

/** `document`/`audio` are the only kinds that ever need local processing;
 * `text`/`image` are usable as-is the moment bytes are stored. */
function defaultLocalProcessingCapability(kind: AttachmentKind): LocalProcessingCapability {
  return kind === 'document' || kind === 'audio' ? 'unavailable_no_local_engine' : 'not_applicable';
}

function rowToAttachment(row: Record<string, unknown>): AttachmentRecord {
  return {
    id: String(row.id),
    conversationId: String(row.conversationId),
    originalName: String(row.originalName),
    declaredMimeType: String(row.declaredMimeType),
    detectedMimeType: (row.detectedMimeType as string) ?? null,
    kind: row.kind as AttachmentKind,
    byteSize: Number(row.byteSize),
    sha256: (row.sha256 as string) ?? null,
    storageRelativePath: (row.storageRelativePath as string) ?? null,
    status: row.status as AttachmentStatus,
    errorCode: (row.errorCode as AttachmentErrorCode) ?? null,
    errorMessageRedacted: (row.errorMessageRedacted as string) ?? null,
    createdAt: String(row.createdAt),
    readyAt: (row.readyAt as string) ?? null,
    deletedAt: (row.deletedAt as string) ?? null,
    revision: Number(row.revision),
    extraction: row.extraction ? (JSON.parse(String(row.extraction)) as DocumentExtractionResult) : null,
    transcription: row.transcription ? (JSON.parse(String(row.transcription)) as AudioTranscriptionResult) : null,
    localProcessingCapability: (row.localProcessingCapability as LocalProcessingCapability) ?? 'not_applicable',
  };
}

export function getAttachment(db: CoreDatabase, id: string): AttachmentRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM attachments WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `attachment '${id}' not found`);
  return rowToAttachment(row);
}

export interface CreateAttachmentInput {
  conversationId: string;
  originalName: string;
  declaredMimeType: string;
  kind: AttachmentKind;
  byteSize: number;
  actor: string;
  clientId?: string | null;
}

const MAX_ORIGINAL_NAME_CHARS = 255;

/** Creates a pending (`uploading`) attachment row. Bytes are not written yet —
 * the caller uploads them separately (bounded, streamed) and then calls
 * `finalizeAttachment` or `failAttachment`. */
export function createPendingAttachment(db: CoreDatabase, input: CreateAttachmentInput): AttachmentRecord {
  return db.transaction(() => {
    const conversation = db.get('SELECT id FROM conversations WHERE id = ?', [input.conversationId]);
    if (!conversation) throw new CoreError('not_found', `conversation '${input.conversationId}' not found`);
    if (!SUPPORTED_ATTACHMENT_KINDS.includes(input.kind)) {
      throw new CoreError('invalid_request', `unsupported attachment kind '${input.kind}'`);
    }
    if (!Number.isFinite(input.byteSize) || input.byteSize <= 0) {
      throw new CoreError('invalid_request', 'byteSize must be a positive number');
    }
    if (input.byteSize > MAX_ATTACHMENT_BYTES) {
      throw new CoreError('invalid_request', `attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit for this slice`);
    }
    const originalName = input.originalName.trim();
    if (!originalName || originalName.length > MAX_ORIGINAL_NAME_CHARS) {
      throw new CoreError('invalid_request', 'originalName must be non-empty and at most 255 characters');
    }
    const activeCount = db.get<{ n: number }>(
      `SELECT COUNT(*) as n FROM attachments WHERE conversationId = ? AND status IN ('uploading','ready')`,
      [input.conversationId],
    );
    if ((activeCount?.n ?? 0) >= MAX_ATTACHMENTS_PER_TURN * 20) {
      // Generous conversation-lifetime ceiling — the hard per-turn bound of 5
      // is enforced where attachments are linked to a message (submission.ts).
      throw new CoreError('invalid_request', 'too many attachments recorded for this conversation');
    }
    const id = newId('att');
    const now = nowIso();
    db.run(
      `INSERT INTO attachments (
         id, conversationId, originalName, declaredMimeType, detectedMimeType, kind,
         byteSize, sha256, storageRelativePath, status, errorCode, errorMessageRedacted,
         createdAt, readyAt, deletedAt, revision, extraction, transcription, localProcessingCapability
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, NULL, 'uploading', NULL, NULL, ?, NULL, NULL, 1, NULL, NULL, ?)`,
      [id, input.conversationId, originalName, input.declaredMimeType, input.kind, input.byteSize, now, defaultLocalProcessingCapability(input.kind)],
    );
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: input.conversationId,
      eventType: 'attachment_upload_started',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attachmentId: id, kind: input.kind, byteSize: input.byteSize },
      resultingRevision: null,
    });
    return getAttachment(db, id);
  });
}

export interface FinalizeAttachmentInput {
  detectedMimeType: string;
  sha256: string;
  byteSize: number;
  storageRelativePath: string;
  actor: string;
  clientId?: string | null;
}

/** Idempotent: if the attachment is already `ready`, returns the existing
 * record unchanged instead of erroring — a client retry after a dropped
 * response must never be able to create a second ready record. */
export function finalizeAttachment(db: CoreDatabase, id: string, input: FinalizeAttachmentInput): AttachmentRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attachments WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attachment '${id}' not found`);
    if (existing.status === 'ready') return getAttachment(db, id);
    if (existing.status !== 'uploading') {
      throw new CoreError('invalid_transition', `attachment '${id}' is not awaiting upload (status '${existing.status}')`);
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run(
      `UPDATE attachments SET detectedMimeType = ?, sha256 = ?, byteSize = ?, storageRelativePath = ?, status = 'ready', readyAt = ?, revision = ? WHERE id = ?`,
      [input.detectedMimeType, input.sha256, input.byteSize, input.storageRelativePath, now, newRevision, id],
    );
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: String(existing.conversationId),
      eventType: 'attachment_ready',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attachmentId: id, detectedMimeType: input.detectedMimeType, byteSize: input.byteSize },
      resultingRevision: null,
    });
    return getAttachment(db, id);
  });
}

/** Persists a completed (or honestly-blocked) local-processing outcome for a
 * `document`/`audio` attachment that is already `ready`. Idempotent: once a
 * result (or a terminal blocker other than the initial default) has been
 * recorded, a later call is a silent no-op rather than overwriting evidence —
 * local processing runs at most once per attachment, immediately after
 * finalize, never re-triggered by a later read. */
export interface RecordLocalProcessingInput {
  capability: LocalProcessingCapability;
  extraction?: DocumentExtractionResult;
  transcription?: AudioTranscriptionResult;
  actor: string;
  clientId?: string | null;
}

export function recordLocalProcessingResult(db: CoreDatabase, id: string, input: RecordLocalProcessingInput): AttachmentRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attachments WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attachment '${id}' not found`);
    if (existing.status !== 'ready') {
      throw new CoreError('invalid_transition', `attachment '${id}' is not ready (status '${existing.status}')`);
    }
    // Already resolved (something other than the initial unavailable default,
    // or already 'available') — never overwrite recorded evidence.
    const currentCapability = existing.localProcessingCapability as LocalProcessingCapability;
    if (currentCapability !== 'unavailable_no_local_engine') {
      return getAttachment(db, id);
    }
    const newRevision = Number(existing.revision) + 1;
    db.run(
      `UPDATE attachments SET localProcessingCapability = ?, extraction = ?, transcription = ?, revision = ? WHERE id = ?`,
      [
        input.capability,
        input.extraction ? JSON.stringify(input.extraction) : null,
        input.transcription ? JSON.stringify(input.transcription) : null,
        newRevision,
        id,
      ],
    );
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: String(existing.conversationId),
      eventType: 'attachment_local_processing_recorded',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attachmentId: id, capability: input.capability },
      resultingRevision: null,
    });
    return getAttachment(db, id);
  });
}

export interface FailAttachmentInput {
  errorCode: AttachmentErrorCode;
  errorMessageRedacted: string;
  actor: string;
  clientId?: string | null;
}

export function failAttachment(db: CoreDatabase, id: string, input: FailAttachmentInput): AttachmentRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attachments WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attachment '${id}' not found`);
    if (existing.status === 'ready') {
      // Never overwrite a successfully finalized attachment as failed.
      return getAttachment(db, id);
    }
    const newRevision = Number(existing.revision) + 1;
    db.run(`UPDATE attachments SET status = 'failed', errorCode = ?, errorMessageRedacted = ?, revision = ? WHERE id = ?`, [
      input.errorCode,
      input.errorMessageRedacted,
      newRevision,
      id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: String(existing.conversationId),
      eventType: 'attachment_failed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attachmentId: id, errorCode: input.errorCode },
      resultingRevision: null,
    });
    return getAttachment(db, id);
  });
}

export function listAttachmentsForConversation(db: CoreDatabase, conversationId: string, includeDeleted = false): AttachmentRecord[] {
  const rows = includeDeleted
    ? db.all<Record<string, unknown>>('SELECT * FROM attachments WHERE conversationId = ? ORDER BY createdAt ASC', [conversationId])
    : db.all<Record<string, unknown>>(`SELECT * FROM attachments WHERE conversationId = ? AND status != 'deleted' ORDER BY createdAt ASC`, [conversationId]);
  return rows.map(rowToAttachment);
}

/** Every attachment id in `attachmentIds` for one message, in composer order.
 * Called only from inside `submitRequest`'s transaction (submission.ts) —
 * this function itself does not create the message or the request/attempt. */
export function linkAttachmentsToMessage(
  db: CoreDatabase,
  messageId: string,
  conversationId: string,
  attachmentIds: string[],
): FrozenAttachmentReference[] {
  if (attachmentIds.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new CoreError('invalid_request', `a turn may include at most ${MAX_ATTACHMENTS_PER_TURN} attachments`);
  }
  const seen = new Set<string>();
  const frozen: FrozenAttachmentReference[] = [];
  attachmentIds.forEach((attachmentId, index) => {
    if (seen.has(attachmentId)) throw new CoreError('invalid_request', `attachment '${attachmentId}' referenced more than once in the same turn`);
    seen.add(attachmentId);
    const attachment = getAttachment(db, attachmentId);
    if (attachment.conversationId !== conversationId) {
      throw new CoreError('invalid_request', `attachment '${attachmentId}' does not belong to conversation '${conversationId}'`);
    }
    if (attachment.status === 'deleted') {
      throw new CoreError('invalid_request', `attachment '${attachmentId}' has been deleted`);
    }
    if (attachment.status !== 'ready') {
      throw new CoreError('invalid_request', `attachment '${attachmentId}' is not ready (status '${attachment.status}')`);
    }
    const existingLink = db.get('SELECT attachmentId FROM message_attachments WHERE attachmentId = ?', [attachmentId]);
    if (existingLink) {
      throw new CoreError('conflict', `attachment '${attachmentId}' is already linked to a message`);
    }
    db.run('INSERT INTO message_attachments (messageId, attachmentId, ordinal) VALUES (?, ?, ?)', [messageId, attachmentId, index]);
    frozen.push({
      attachmentId: attachment.id,
      sha256: attachment.sha256 ?? '',
      kind: attachment.kind,
      detectedMimeType: attachment.detectedMimeType ?? attachment.declaredMimeType,
      originalName: attachment.originalName,
      byteSize: attachment.byteSize,
    });
  });
  return frozen;
}

export function listAttachmentsForMessage(db: CoreDatabase, messageId: string): MessageAttachmentLink[] {
  return db.all<Record<string, unknown>>('SELECT messageId, attachmentId, ordinal FROM message_attachments WHERE messageId = ? ORDER BY ordinal ASC', [messageId])
    .map((row) => ({ messageId: String(row.messageId), attachmentId: String(row.attachmentId), ordinal: Number(row.ordinal) }));
}

/** Returns every attachment linked to any message in `conversationId`, keyed
 * by messageId — used to restore attachment chips/provenance after restart
 * without depending on retained webview state. */
export function listAttachmentsByMessageForConversation(db: CoreDatabase, conversationId: string): Record<string, AttachmentRecord[]> {
  const messageIds = listMessages(db, conversationId, { limit: 2000 }).map((message) => message.id);
  if (messageIds.length === 0) return {};
  const rows = db.all<Record<string, unknown>>(
    `SELECT ma.messageId as messageId, a.* FROM message_attachments ma
     JOIN attachments a ON a.id = ma.attachmentId
     WHERE ma.messageId IN (${messageIds.map(() => '?').join(',')})
     ORDER BY ma.messageId ASC, ma.ordinal ASC`,
    messageIds,
  );
  const byMessage: Record<string, AttachmentRecord[]> = {};
  for (const row of rows) {
    const messageId = String(row.messageId);
    (byMessage[messageId] ??= []).push(rowToAttachment(row));
  }
  return byMessage;
}

/** Soft-deletes the metadata row; the caller (the upload route / a future
 * delete route) is responsible for the best-effort filesystem cleanup since
 * this module is intentionally filesystem-free. */
export function softDeleteAttachment(db: CoreDatabase, id: string, input: { actor: string; clientId?: string | null }): AttachmentRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM attachments WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `attachment '${id}' not found`);
    if (existing.status === 'deleted') return getAttachment(db, id);
    const linked = db.get('SELECT attachmentId FROM message_attachments WHERE attachmentId = ?', [id]);
    if (linked) throw new CoreError('invalid_transition', `attachment '${id}' is linked to a message and cannot be deleted`);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run(`UPDATE attachments SET status = 'deleted', deletedAt = ?, revision = ? WHERE id = ?`, [now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'conversation',
      entityId: String(existing.conversationId),
      eventType: 'attachment_deleted',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attachmentId: id },
      resultingRevision: null,
    });
    return getAttachment(db, id);
  });
}
