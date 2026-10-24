/**
 * Bounded authenticated binary upload for the M36 attachment slice. The
 * Core's normal JSON body cap is 1 MiB (`server.ts`'s `MAX_BODY_BYTES`), so
 * attachment bytes never go through the generic JSON route — this handler is
 * special-cased in `server.ts` (matched by method+path) before the generic
 * JSON body reader ever runs, and streams the raw request body directly to a
 * temporary `.uploading` file under the Core-owned attachments directory.
 */
import * as http from 'node:http';
import * as path from 'node:path';
import { getAttachment, finalizeAttachment, failAttachment, recordLocalProcessingResult } from '../domain/attachments';
import { detectContent, contentMatchesDeclaredKind, SNIFF_BUFFER_BYTES } from '../attachments/mime';
import {
  ensureConversationDir,
  uploadingPath,
  finalPath,
  relativePath,
  removeQuietly,
  streamToFile,
  commitUpload,
} from '../attachments/storage';
import { extractDocument } from '../attachments/documentExtraction';
import { probeLocalAudioTranscriptionCapability, runLocalTranscription } from '../attachments/audioProcessing';
import { MAX_ATTACHMENT_BYTES, type AttachmentErrorCode } from '../shared/wireTypes';
import type { CoreDatabase } from '../db/connection';
import { toHttpError } from './errors';
import { CoreError } from '../domain/errors';

/** Runs local processing (document extraction / audio transcription
 * capability probe) for a just-finalized attachment and persists whatever
 * honest outcome results. Never throws — a processing failure is itself
 * recorded as `localProcessingCapability: 'failed'` evidence, never allowed
 * to fail the upload response (the bytes are already safely stored by this
 * point). Returns the possibly-updated attachment record. */
async function runLocalProcessingAndRecord(
  db: CoreDatabase,
  attachmentId: string,
  kind: string,
  mimeType: string,
  storedFilePath: string,
  actor: string,
  clientId: string,
  localProcessingEnv?: NodeJS.ProcessEnv,
) {
  if (kind === 'document') {
    try {
      const extraction = await extractDocument(storedFilePath, mimeType);
      return recordLocalProcessingResult(db, attachmentId, {
        capability: extraction ? 'available' : 'unavailable_unsupported_format',
        extraction: extraction ?? undefined,
        actor,
        clientId,
      });
    } catch {
      return recordLocalProcessingResult(db, attachmentId, { capability: 'failed', actor, clientId });
    }
  }
  if (kind === 'audio') {
    const probe = probeLocalAudioTranscriptionCapability(localProcessingEnv);
    if (probe.capability !== 'available' || !probe.engine) {
      return recordLocalProcessingResult(db, attachmentId, { capability: probe.capability, actor, clientId });
    }
    try {
      // The same Core-owned configuration that established availability also
      // owns pipeline initialisation. Never fall back to process.env here:
      // tests and concurrent Core instances may legitimately use different
      // local model directories.
      const transcription = await runLocalTranscription(probe.engine, storedFilePath, localProcessingEnv);
      return recordLocalProcessingResult(db, attachmentId, { capability: 'available', transcription, actor, clientId });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[karkedikha-core ${new Date().toISOString()}] audio local transcription failed:`, err && (err as Error).stack || err);
      return recordLocalProcessingResult(db, attachmentId, { capability: 'failed', actor, clientId });
    }
  }
  return getAttachment(db, attachmentId);
}

const UPLOAD_INACTIVITY_TIMEOUT_MS = 30_000;

export interface AttachmentUploadContext {
  db: CoreDatabase;
  dataDir: string;
  clientId: string;
  actor: string;
  correlationId: string;
  /** Optional Core configuration environment for local attachment processing.
   * Production uses `process.env`; tests inject a private copy so an
   * unavailable-engine fixture cannot mutate the process-wide environment. */
  localProcessingEnv?: NodeJS.ProcessEnv;
}

const UPLOAD_ROUTE_PATTERN = /^\/v1\/attachments\/([^/]+)\/bytes$/;

export function matchAttachmentUploadRoute(method: string, pathname: string): { attachmentId: string } | null {
  if (method !== 'POST') return null;
  const match = UPLOAD_ROUTE_PATTERN.exec(pathname);
  return match ? { attachmentId: match[1] } : null;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export async function handleAttachmentUpload(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  attachmentId: string,
  ctx: AttachmentUploadContext,
): Promise<void> {
  let attachment;
  try {
    attachment = getAttachment(ctx.db, attachmentId);
  } catch (err) {
    const { status, body } = toHttpError(err, ctx.correlationId);
    writeJson(res, status, body);
    return;
  }

  if (attachment.status === 'ready') {
    // Idempotent retry: the client resent bytes for an attachment that was
    // already finalized (e.g. it never saw our success response). Return the
    // existing ready record rather than creating a second ready record.
    writeJson(res, 200, attachment);
    return;
  }
  if (attachment.status !== 'uploading') {
    const { status, body } = toHttpError(new CoreError('invalid_transition', `attachment '${attachmentId}' is not awaiting upload (status '${attachment.status}')`), ctx.correlationId);
    writeJson(res, status, body);
    return;
  }

  const contentLengthHeader = req.headers['content-length'];
  const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
  const fail = (errorCode: AttachmentErrorCode, message: string, httpStatus = 400) => {
    failAttachment(ctx.db, attachmentId, { errorCode, errorMessageRedacted: message, actor: ctx.actor, clientId: ctx.clientId });
    writeJson(res, httpStatus, { error: { code: errorCode, message, correlationId: ctx.correlationId } });
  };

  if (!Number.isFinite(contentLength) || contentLength <= 0) {
    fail('content_length_required', 'Content-Length header is required and must be a positive integer');
    req.resume();
    return;
  }
  if (contentLength > MAX_ATTACHMENT_BYTES) {
    fail('size_exceeded', `attachment exceeds the ${MAX_ATTACHMENT_BYTES}-byte limit for this slice`, 413);
    req.resume();
    return;
  }
  if (contentLength !== attachment.byteSize) {
    fail('content_length_mismatch', 'Content-Length does not match the byte size declared when the attachment was created');
    req.resume();
    return;
  }

  ensureConversationDir(ctx.dataDir, attachment.conversationId);
  const tempPath = uploadingPath(ctx.dataDir, attachment.conversationId, attachmentId);
  removeQuietly(tempPath); // defend against a leftover temp file from a prior interrupted attempt

  let result;
  try {
    result = await streamToFile(req, tempPath, {
      maxBytes: MAX_ATTACHMENT_BYTES,
      sniffBytes: SNIFF_BUFFER_BYTES,
      inactivityTimeoutMs: UPLOAD_INACTIVITY_TIMEOUT_MS,
    });
  } catch (err) {
    removeQuietly(tempPath);
    const code = ((err as { code?: string }).code ?? 'upload_stream_error') as AttachmentErrorCode;
    const httpStatus = code === 'size_exceeded' ? 413 : code === 'upload_timeout' ? 408 : 400;
    fail(code, err instanceof Error ? err.message : 'upload failed', httpStatus);
    return;
  }

  if (result.byteSize !== attachment.byteSize) {
    removeQuietly(tempPath);
    fail('byte_size_mismatch', `received ${result.byteSize} bytes but declared byteSize was ${attachment.byteSize}`);
    return;
  }

  const detected = detectContent(result.sniffPrefix, path.extname(attachment.originalName));
  if (!detected || !contentMatchesDeclaredKind(detected, attachment.kind)) {
    removeQuietly(tempPath);
    fail(
      detected ? 'mime_mismatch' : 'unsupported_content',
      detected
        ? `content sniffed as '${detected.kind}' but attachment was declared as '${attachment.kind}'`
        : 'content does not match any supported format for this slice (text, PDF, DOCX, PNG, JPEG, GIF, WebP, WAV, MP3, OGG, FLAC)',
      415,
    );
    return;
  }

  const dest = finalPath(ctx.dataDir, attachment.conversationId, attachmentId);
  try {
    commitUpload(tempPath, dest);
  } catch (err) {
    removeQuietly(tempPath);
    fail('upload_stream_error', err instanceof Error ? err.message : 'failed to finalize attachment storage');
    return;
  }

  try {
    const finalized = finalizeAttachment(ctx.db, attachmentId, {
      detectedMimeType: detected.mimeType,
      sha256: result.sha256,
      byteSize: result.byteSize,
      storageRelativePath: relativePath(ctx.dataDir, dest),
      actor: ctx.actor,
      clientId: ctx.clientId,
    });
    const withLocalProcessing = await runLocalProcessingAndRecord(
      ctx.db,
      attachmentId,
      finalized.kind,
      detected.mimeType,
      dest,
      ctx.actor,
      ctx.clientId,
      ctx.localProcessingEnv,
    );
    writeJson(res, 200, withLocalProcessing);
  } catch (err) {
    removeQuietly(dest);
    const { status, body } = toHttpError(err, ctx.correlationId);
    writeJson(res, status, body);
  }
}
