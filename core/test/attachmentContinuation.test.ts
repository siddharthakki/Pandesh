import { describe, expect, it } from 'vitest';
import { continuationApplies, selectContinuationAttachments } from '../attachments/continuation';
import type { AttachmentRecord } from '../shared/wireTypes';

const att = (id: string, over: Partial<AttachmentRecord> = {}): AttachmentRecord => ({
  id, conversationId: 'c1', originalName: `${id}.txt`, declaredMimeType: 'text/plain', detectedMimeType: 'text/plain', kind: 'text', byteSize: 5,
  sha256: 'x', storageRelativePath: null, status: 'ready', errorCode: null, errorMessageRedacted: null, createdAt: '', readyAt: '', deletedAt: null,
  revision: 1, extraction: null, transcription: null, localProcessingCapability: 'not_applicable', ...over,
});

const turns = (n: number) => Array.from({ length: n }, (_, i) => [{ id: `u${i}`, role: 'user' }, { id: `a${i}`, role: 'assistant' }]).flat();

describe('selectContinuationAttachments', () => {
  it('never uses the current (last) user turn and honours the recent-turn window', () => {
    const messages = turns(7);
    const byMessage = { u0: [att('old')], u5: [att('recent')], u6: [att('current')] };
    expect(selectContinuationAttachments({ messages, byMessage }).map(a => a.id)).toEqual(['recent']);
  });

  it('is bounded to the newest few and skips deleted, not-ready and already-sent attachments', () => {
    const messages = turns(4);
    const byMessage = {
      u0: [att('a1'), att('a2', { status: 'deleted' }), att('a3', { deletedAt: 'x' })],
      u1: [att('a4'), att('a5', { status: 'uploading' })],
      u2: [att('a6'), att('a7')],
    };
    expect(selectContinuationAttachments({ messages, byMessage, excludeAttachmentIds: new Set(['a7']) }).map(a => a.id)).toEqual(['a1', 'a4', 'a6']);
  });

  it('before the current turn is appended every user turn is an earlier turn', () => {
    const messages = turns(2);
    expect(selectContinuationAttachments({ messages, byMessage: { u1: [att('img', { kind: 'image' })] }, currentTurnNotYetAppended: true }).map(a => a.id)).toEqual(['img']);
    expect(selectContinuationAttachments({ messages, byMessage: { u1: [att('img', { kind: 'image' })] } })).toEqual([]);
  });

  it('a New Chat has no messages and therefore no continuation', () => {
    expect(selectContinuationAttachments({ messages: [], byMessage: {} })).toEqual([]);
  });
});

describe('continuationApplies (the latest message decides)', () => {
  const recent = new Date().toISOString();
  const old = new Date(Date.now() - 26 * 3600_000).toISOString();
  it('keeps an earlier attachment for a genuine follow-up', () => {
    expect(continuationApplies({ message: 'What is the red object?', hasFreshAttachment: false, newestEarlierCreatedAt: recent })).toBe(true);
    expect(continuationApplies({ message: 'what about that document?', hasFreshAttachment: false, newestEarlierCreatedAt: old })).toBe(true);
  });
  it('does not drag an old invoice into a greeting or an unrelated request', () => {
    expect(continuationApplies({ message: 'Hi', hasFreshAttachment: false, newestEarlierCreatedAt: recent })).toBe(false);
    expect(continuationApplies({ message: 'Whats on my. Calendar tomorrow', hasFreshAttachment: false, newestEarlierCreatedAt: recent })).toBe(false);
    expect(continuationApplies({ message: 'and then?', hasFreshAttachment: false, newestEarlierCreatedAt: old })).toBe(false);
  });
  it('a newly attached file is what "this document" means', () => {
    expect(continuationApplies({ message: 'what is this document', hasFreshAttachment: true, newestEarlierCreatedAt: recent })).toBe(false);
    expect(continuationApplies({ message: 'compare it with the earlier invoice', hasFreshAttachment: true, newestEarlierCreatedAt: recent })).toBe(true);
  });
});
