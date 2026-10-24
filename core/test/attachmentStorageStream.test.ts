import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { streamToFile, removeQuietly } from '../attachments/storage';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-upload-stream-test-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** A minimal fake `NodeJS.ReadableStream` the test fully controls — real
 * timing (inactivity, mid-stream abort, oversized bodies) is otherwise
 * impractical to exercise deterministically through a live HTTP fetch body. */
class FakeSource extends EventEmitter {
  pause(): void {}
  resume(): void {}
}

describe('streamToFile — timeout, cancellation, and cleanup', () => {
  it('fails with upload_timeout when the source goes inactive, and the caller can clean up the partial temp file', async () => {
    const dest = path.join(dir, 'stalled.uploading');
    const source = new FakeSource();
    const promise = streamToFile(source, dest, { maxBytes: 1024, sniffBytes: 64, inactivityTimeoutMs: 30 });
    source.emit('data', Buffer.from('partial'));
    await expect(promise).rejects.toMatchObject({ code: 'upload_timeout' });
    // The write stream had already flushed a partial file before the timeout fired.
    expect(fs.existsSync(dest)).toBe(true);
    removeQuietly(dest);
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('fails with upload_cancelled when the client aborts mid-upload, and cleanup afterward never throws', async () => {
    const dest = path.join(dir, 'cancelled.uploading');
    const source = new FakeSource();
    const promise = streamToFile(source, dest, { maxBytes: 1024, sniffBytes: 64, inactivityTimeoutMs: 5_000 });
    source.emit('data', Buffer.from('some bytes'));
    source.emit('aborted');
    await expect(promise).rejects.toMatchObject({ code: 'upload_cancelled' });
    // Whether or not the async file open had completed before the abort fired,
    // cleanup must be safe (this is exactly what the upload route calls in its
    // catch block — see attachmentUpload.ts).
    expect(() => removeQuietly(dest)).not.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('fails with size_exceeded the instant the streamed byte count crosses maxBytes, without buffering the whole body', async () => {
    const dest = path.join(dir, 'oversized.uploading');
    const source = new FakeSource();
    const promise = streamToFile(source, dest, { maxBytes: 8, sniffBytes: 64, inactivityTimeoutMs: 5_000 });
    source.emit('data', Buffer.from('this chunk is well over the limit'));
    await expect(promise).rejects.toMatchObject({ code: 'size_exceeded' });
    expect(() => removeQuietly(dest)).not.toThrow();
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('removeQuietly is a safe no-op cleanup call for a path that was never created', () => {
    expect(() => removeQuietly(path.join(dir, 'never-existed.uploading'))).not.toThrow();
  });

  it('resolves with byteSize/sha256/sniffPrefix once the source ends normally', async () => {
    const dest = path.join(dir, 'ok.uploading');
    const source = new FakeSource();
    const promise = streamToFile(source, dest, { maxBytes: 1024, sniffBytes: 64, inactivityTimeoutMs: 5_000 });
    source.emit('data', Buffer.from('hello world'));
    source.emit('end');
    const result = await promise;
    expect(result.byteSize).toBe(Buffer.byteLength('hello world'));
    expect(result.sha256).toHaveLength(64);
    expect(fs.readFileSync(dest).toString('utf8')).toBe('hello world');
  });
});
