/**
 * Filesystem side of the M36 attachment slice. Bytes never live in SQLite —
 * only a Core-data-dir-relative path (`AttachmentRecord.storageRelativePath`)
 * is persisted. Every path here is derived solely from the Core-generated
 * attachment id, never from client-supplied input, and is verified to resolve
 * inside the attachments root before use (path/symlink containment).
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const ATTACHMENTS_DIR_NAME = 'attachments';

function attachmentsRoot(dataDir: string): string {
  return path.join(dataDir, ATTACHMENTS_DIR_NAME);
}

/** Throws if `candidate` would resolve outside `root` — defends against any
 * future caller accidentally threading a client-controlled segment in. */
function assertContained(root: string, candidate: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(`attachment path '${resolved}' escapes storage root '${resolvedRoot}'`);
  }
  return resolved;
}

function conversationDir(dataDir: string, conversationId: string): string {
  // conversationId is always a Core-generated id (newId('conv')) — never raw
  // client input — but containment is still asserted defensively below.
  return assertContained(attachmentsRoot(dataDir), path.join(attachmentsRoot(dataDir), conversationId));
}

export function finalPath(dataDir: string, conversationId: string, attachmentId: string): string {
  return assertContained(conversationDir(dataDir, conversationId), path.join(conversationDir(dataDir, conversationId), `${attachmentId}.bin`));
}

export function uploadingPath(dataDir: string, conversationId: string, attachmentId: string): string {
  return assertContained(conversationDir(dataDir, conversationId), path.join(conversationDir(dataDir, conversationId), `${attachmentId}.uploading`));
}

export function relativePath(dataDir: string, absolutePath: string): string {
  return path.relative(dataDir, absolutePath).split(path.sep).join('/');
}

export function ensureConversationDir(dataDir: string, conversationId: string): void {
  fs.mkdirSync(conversationDir(dataDir, conversationId), { recursive: true });
}

/** Best-effort delete — cleanup after a failed/cancelled/interrupted upload
 * must never itself throw and mask the real failure. */
export function removeQuietly(absolutePath: string): void {
  try {
    fs.unlinkSync(absolutePath);
  } catch {
    /* already gone, or never existed — both are fine for cleanup */
  }
}

export interface StreamToFileResult {
  byteSize: number;
  sha256: string;
  sniffPrefix: Buffer;
}

/**
 * Streams a readable request body to `destPath` (an `.uploading` temp path),
 * enforcing `maxBytes` as a hard streaming limit (not just a post-hoc check —
 * the stream is destroyed the instant the bound is crossed) and computing the
 * SHA-256 and a bounded sniff prefix incrementally so the whole file is never
 * held in memory at once.
 */
export function streamToFile(
  source: NodeJS.ReadableStream,
  destPath: string,
  options: { maxBytes: number; sniffBytes: number; inactivityTimeoutMs: number },
): Promise<StreamToFileResult> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const sniffChunks: Buffer[] = [];
    let sniffLength = 0;
    let byteSize = 0;
    let settled = false;
    const out = fs.createWriteStream(destPath, { flags: 'wx' });

    let inactivityTimer: NodeJS.Timeout | undefined;
    const resetInactivityTimer = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      inactivityTimer = setTimeout(() => {
        fail(Object.assign(new Error('upload stalled (inactivity timeout)'), { code: 'upload_timeout' }));
      }, options.inactivityTimeoutMs);
    };

    const cleanup = () => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      source.removeListener('data', onData);
      source.removeListener('end', onEnd);
      source.removeListener('error', onSourceError);
      source.removeListener('aborted', onAborted);
      out.removeListener('error', onWriteError);
    };

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      // `out`'s underlying fs.open() may still be in flight when we destroy
      // it — if that deferred open later rejects, Node emits a second
      // 'error' event on `out` with no listener attached (we just removed
      // ours in cleanup()), which would crash the process as an unhandled
      // error. Swallow it: we've already rejected this promise with the
      // real failure reason above.
      out.on('error', () => {});
      out.destroy();
      reject(err);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      out.end(() => resolve({ byteSize, sha256: hash.digest('hex'), sniffPrefix: Buffer.concat(sniffChunks, sniffLength) }));
    };

    function onData(chunk: Buffer) {
      byteSize += chunk.length;
      if (byteSize > options.maxBytes) {
        fail(Object.assign(new Error(`attachment exceeds ${options.maxBytes} bytes`), { code: 'size_exceeded' }));
        return;
      }
      hash.update(chunk);
      if (sniffLength < options.sniffBytes) {
        const take = chunk.subarray(0, options.sniffBytes - sniffLength);
        sniffChunks.push(take);
        sniffLength += take.length;
      }
      resetInactivityTimer();
      if (!out.write(chunk)) {
        (source as unknown as { pause?: () => void }).pause?.();
        out.once('drain', () => (source as unknown as { resume?: () => void }).resume?.());
      }
    }
    function onEnd() {
      finish();
    }
    function onSourceError(err: Error) {
      fail(Object.assign(err, { code: (err as { code?: string }).code ?? 'upload_stream_error' }));
    }
    function onAborted() {
      fail(Object.assign(new Error('upload cancelled by client'), { code: 'upload_cancelled' }));
    }
    function onWriteError(err: Error) {
      fail(Object.assign(err, { code: 'upload_stream_error' }));
    }

    out.on('error', onWriteError);
    source.on('data', onData);
    source.on('end', onEnd);
    source.on('error', onSourceError);
    source.on('aborted', onAborted);
    resetInactivityTimer();
  });
}

/** Atomic rename from the verified `.uploading` temp file to its final
 * immutable path. Only ever called after size/hash/MIME verification. */
export function commitUpload(uploadingAbsPath: string, finalAbsPath: string): void {
  fs.renameSync(uploadingAbsPath, finalAbsPath);
}

export function readBoundedFile(absPath: string, maxBytes: number): Buffer {
  const fd = fs.openSync(absPath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, 0);
    return buffer;
  } finally {
    fs.closeSync(fd);
  }
}

export function sha256OfFile(absPath: string): string {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(absPath);
  hash.update(data);
  return hash.digest('hex');
}
