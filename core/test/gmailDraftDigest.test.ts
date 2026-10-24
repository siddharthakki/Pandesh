import { describe, expect, it } from 'vitest';
import {
  buildGmailSendPresentation,
  canonicalizeGmailDraft,
  computeGmailDraftDigest,
  type GmailDraftContent,
} from '../runtime/connectors/gmailDraftDigest';

function content(overrides: Partial<GmailDraftContent> = {}): GmailDraftContent {
  return {
    accountEmail: 'me@example.com',
    draftId: 'draft-1',
    threadId: null,
    to: ['bob@example.com'],
    cc: [],
    bcc: [],
    subject: 'Hello',
    bodyText: 'Hi Bob',
    bodyHtml: null,
    ...overrides,
  };
}

describe('gmailDraftDigest: draft-bound send safety canonicalization', () => {
  it('is deterministic for identical content', () => {
    expect(computeGmailDraftDigest(content())).toBe(computeGmailDraftDigest(content()));
  });

  it('is insensitive to recipient list order but sensitive to the recipient set', () => {
    const a = computeGmailDraftDigest(content({ to: ['bob@example.com', 'alice@example.com'] }));
    const b = computeGmailDraftDigest(content({ to: ['alice@example.com', 'bob@example.com'] }));
    expect(a).toBe(b);
    const c = computeGmailDraftDigest(content({ to: ['carol@example.com', 'alice@example.com'] }));
    expect(a).not.toBe(c);
  });

  it('changes when the body text changes even by one character', () => {
    const a = computeGmailDraftDigest(content({ bodyText: 'Hi Bob' }));
    const b = computeGmailDraftDigest(content({ bodyText: 'Hi Bob!' }));
    expect(a).not.toBe(b);
  });

  it('changes when the subject changes', () => {
    const a = computeGmailDraftDigest(content({ subject: 'Hello' }));
    const b = computeGmailDraftDigest(content({ subject: 'Hello!' }));
    expect(a).not.toBe(b);
  });

  it('changes when cc or bcc changes even if to/subject/body are identical', () => {
    const a = computeGmailDraftDigest(content({ cc: [] }));
    const b = computeGmailDraftDigest(content({ cc: ['carol@example.com'] }));
    expect(a).not.toBe(b);
  });

  it('changes when the account identity changes, even with identical message content', () => {
    const a = computeGmailDraftDigest(content({ accountEmail: 'me@example.com' }));
    const b = computeGmailDraftDigest(content({ accountEmail: 'someone-else@example.com' }));
    expect(a).not.toBe(b);
  });

  it('changes when threadId changes (reply target)', () => {
    const a = computeGmailDraftDigest(content({ threadId: null }));
    const b = computeGmailDraftDigest(content({ threadId: 'thread-99' }));
    expect(a).not.toBe(b);
  });

  it('normalizes CRLF vs LF in the body to the same digest', () => {
    const a = computeGmailDraftDigest(content({ bodyText: 'line1\nline2' }));
    const b = computeGmailDraftDigest(content({ bodyText: 'line1\r\nline2' }));
    expect(a).toBe(b);
  });

  it('canonicalization is valid, parseable JSON with a stable key order', () => {
    const canonical = canonicalizeGmailDraft(content());
    const parsed = JSON.parse(canonical);
    expect(Object.keys(parsed)).toEqual(['accountEmail', 'draftId', 'threadId', 'to', 'cc', 'bcc', 'subject', 'bodyText', 'bodyHtml']);
  });

  it('presentation bounds an oversized body and marks it truncated, never silently drops it', () => {
    const huge = 'x'.repeat(20_000);
    const presentation = buildGmailSendPresentation(content({ bodyText: huge }));
    expect(presentation.bodyTextTruncated).toBe(true);
    expect(presentation.bodyText.length).toBeLessThan(huge.length);
  });

  it('presentation shows exact recipients and subject, and marks html presence without embedding raw html', () => {
    const presentation = buildGmailSendPresentation(content({ cc: ['carol@example.com'], bodyHtml: '<p>hi</p>' }));
    expect(presentation.to).toEqual(['bob@example.com']);
    expect(presentation.cc).toEqual(['carol@example.com']);
    expect(presentation.subject).toBe('Hello');
    expect(presentation.bodyHtml).toBe('[html body present]');
  });
});
