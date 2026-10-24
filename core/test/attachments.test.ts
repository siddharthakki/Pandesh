import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createConversation, appendMessage } from '../domain/conversations';
import {
  createPendingAttachment,
  finalizeAttachment,
  failAttachment,
  getAttachment,
  listAttachmentsForConversation,
  linkAttachmentsToMessage,
  listAttachmentsForMessage,
  listAttachmentsByMessageForConversation,
  softDeleteAttachment,
} from '../domain/attachments';
import { CoreError } from '../domain/errors';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-attachments-test-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function makeConversation() {
  return createConversation(db, { mode: 'baat_kar', actor: 'test' });
}

describe('createPendingAttachment', () => {
  it('creates an uploading record for an existing conversation', () => {
    const conv = makeConversation();
    const attachment = createPendingAttachment(db, {
      conversationId: conv.id,
      originalName: 'notes.txt',
      declaredMimeType: 'text/plain',
      kind: 'text',
      byteSize: 100,
      actor: 'test',
    });
    expect(attachment.status).toBe('uploading');
    expect(attachment.sha256).toBeNull();
    expect(attachment.storageRelativePath).toBeNull();
  });

  it('rejects a nonexistent conversation', () => {
    expect(() =>
      createPendingAttachment(db, {
        conversationId: 'conv-missing',
        originalName: 'a.txt',
        declaredMimeType: 'text/plain',
        kind: 'text',
        byteSize: 10,
        actor: 'test',
      }),
    ).toThrow(CoreError);
  });

  it('rejects a byteSize over the 10 MiB slice limit', () => {
    const conv = makeConversation();
    expect(() =>
      createPendingAttachment(db, {
        conversationId: conv.id,
        originalName: 'huge.png',
        declaredMimeType: 'image/png',
        kind: 'image',
        byteSize: 11 * 1024 * 1024,
        actor: 'test',
      }),
    ).toThrow(CoreError);
  });

  it('rejects an unsupported kind', () => {
    const conv = makeConversation();
    expect(() =>
      createPendingAttachment(db, {
        conversationId: conv.id,
        originalName: 'clip.mp4',
        declaredMimeType: 'video/mp4',
        kind: 'video' as never,
        byteSize: 10,
        actor: 'test',
      }),
    ).toThrow(CoreError);
  });
});

describe('finalizeAttachment', () => {
  it('transitions uploading -> ready and is idempotent on a second call', () => {
    const conv = makeConversation();
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.png', declaredMimeType: 'image/png', kind: 'image', byteSize: 4, actor: 'test',
    });
    const ready = finalizeAttachment(db, created.id, {
      detectedMimeType: 'image/png', sha256: 'abc123', byteSize: 4, storageRelativePath: 'attachments/x/y.bin', actor: 'test',
    });
    expect(ready.status).toBe('ready');
    expect(ready.readyAt).not.toBeNull();

    // Idempotent retry: a duplicate finalize call must not error or mutate.
    const again = finalizeAttachment(db, created.id, {
      detectedMimeType: 'image/gif', sha256: 'different-hash', byteSize: 999, storageRelativePath: 'attachments/other', actor: 'test',
    });
    expect(again).toEqual(getAttachment(db, created.id));
    expect(again.sha256).toBe('abc123'); // unchanged — the second call's (bogus) values never applied
  });

  it('rejects finalizing an attachment that is not in the uploading state', () => {
    const conv = makeConversation();
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    failAttachment(db, created.id, { errorCode: 'upload_stream_error', errorMessageRedacted: 'boom', actor: 'test' });
    expect(() =>
      finalizeAttachment(db, created.id, { detectedMimeType: 'text/plain', sha256: 'x', byteSize: 4, storageRelativePath: 'p', actor: 'test' }),
    ).toThrow(CoreError);
  });
});

describe('linkAttachmentsToMessage', () => {
  it('links ready attachments to a message and freezes hash/kind evidence', () => {
    const conv = makeConversation();
    const message = appendMessage(db, conv.id, { role: 'user', content: 'hi', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    finalizeAttachment(db, created.id, { detectedMimeType: 'text/plain', sha256: 'hash1', byteSize: 4, storageRelativePath: 'p', actor: 'test' });

    const frozen = linkAttachmentsToMessage(db, message.id, conv.id, [created.id]);
    expect(frozen).toEqual([{ attachmentId: created.id, sha256: 'hash1', kind: 'text', detectedMimeType: 'text/plain', originalName: 'a.txt', byteSize: 4 }]);

    const links = listAttachmentsForMessage(db, message.id);
    expect(links).toEqual([{ messageId: message.id, attachmentId: created.id, ordinal: 0 }]);
  });

  it('rejects more than 5 attachments in one call', () => {
    const conv = makeConversation();
    const message = appendMessage(db, conv.id, { role: 'user', content: 'hi', actor: 'test' });
    const ids = Array.from({ length: 6 }, () => 'nonexistent');
    expect(() => linkAttachmentsToMessage(db, message.id, conv.id, ids)).toThrow(CoreError);
  });

  it('rejects an attachment belonging to a different conversation', () => {
    const convA = makeConversation();
    const convB = makeConversation();
    const messageA = appendMessage(db, convA.id, { role: 'user', content: 'hi', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: convB.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    finalizeAttachment(db, created.id, { detectedMimeType: 'text/plain', sha256: 'h', byteSize: 4, storageRelativePath: 'p', actor: 'test' });
    expect(() => linkAttachmentsToMessage(db, messageA.id, convA.id, [created.id])).toThrow(CoreError);
  });

  it('rejects an attachment that is not ready', () => {
    const conv = makeConversation();
    const message = appendMessage(db, conv.id, { role: 'user', content: 'hi', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    expect(() => linkAttachmentsToMessage(db, message.id, conv.id, [created.id])).toThrow(CoreError);
  });

  it('rejects linking the same attachment to a second message', () => {
    const conv = makeConversation();
    const messageA = appendMessage(db, conv.id, { role: 'user', content: 'one', actor: 'test' });
    const messageB = appendMessage(db, conv.id, { role: 'user', content: 'two', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    finalizeAttachment(db, created.id, { detectedMimeType: 'text/plain', sha256: 'h', byteSize: 4, storageRelativePath: 'p', actor: 'test' });
    linkAttachmentsToMessage(db, messageA.id, conv.id, [created.id]);
    expect(() => linkAttachmentsToMessage(db, messageB.id, conv.id, [created.id])).toThrow(CoreError);
  });
});

describe('listAttachmentsByMessageForConversation (restart restoration read path)', () => {
  it('groups attachments by messageId for exactly this conversation', () => {
    const conv = makeConversation();
    const message = appendMessage(db, conv.id, { role: 'user', content: 'hi', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.png', declaredMimeType: 'image/png', kind: 'image', byteSize: 4, actor: 'test',
    });
    finalizeAttachment(db, created.id, { detectedMimeType: 'image/png', sha256: 'h', byteSize: 4, storageRelativePath: 'p', actor: 'test' });
    linkAttachmentsToMessage(db, message.id, conv.id, [created.id]);

    const byMessage = listAttachmentsByMessageForConversation(db, conv.id);
    expect(byMessage[message.id]).toHaveLength(1);
    expect(byMessage[message.id][0].id).toBe(created.id);
  });
});

describe('softDeleteAttachment', () => {
  it('soft-deletes an unlinked attachment and excludes it from the default listing', () => {
    const conv = makeConversation();
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    const deleted = softDeleteAttachment(db, created.id, { actor: 'test' });
    expect(deleted.status).toBe('deleted');
    expect(listAttachmentsForConversation(db, conv.id)).toEqual([]);
    expect(listAttachmentsForConversation(db, conv.id, true)).toHaveLength(1);
  });

  it('refuses to delete an attachment already linked to a message', () => {
    const conv = makeConversation();
    const message = appendMessage(db, conv.id, { role: 'user', content: 'hi', actor: 'test' });
    const created = createPendingAttachment(db, {
      conversationId: conv.id, originalName: 'a.txt', declaredMimeType: 'text/plain', kind: 'text', byteSize: 4, actor: 'test',
    });
    finalizeAttachment(db, created.id, { detectedMimeType: 'text/plain', sha256: 'h', byteSize: 4, storageRelativePath: 'p', actor: 'test' });
    linkAttachmentsToMessage(db, message.id, conv.id, [created.id]);
    expect(() => softDeleteAttachment(db, created.id, { actor: 'test' })).toThrow(CoreError);
  });
});
