import { describe, expect, it } from 'vitest';
import { summarizeGmailMessage, summarizeGmailThread, type GmailApiThread } from '../runtime/connectors/gmailMime';

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('gmailMime: parses the Gmail API JSON payload tree, never raw MIME text', () => {
  it('extracts headers and a single-part plain-text body', () => {
    const summary = summarizeGmailMessage({
      id: 'm1',
      threadId: 't1',
      snippet: 'hello there',
      payload: {
        headers: [
          { name: 'From', value: 'alice@example.com' },
          { name: 'To', value: 'bob@example.com' },
          { name: 'Subject', value: 'Hi' },
          { name: 'Date', value: 'Mon, 1 Jan 2026 00:00:00 +0000' },
        ],
        mimeType: 'text/plain',
        body: { data: b64url('Hello Bob!') },
      },
    });
    expect(summary.from).toBe('alice@example.com');
    expect(summary.to).toBe('bob@example.com');
    expect(summary.subject).toBe('Hi');
    expect(summary.bodyText).toBe('Hello Bob!');
    expect(summary.hasAttachments).toBe(false);
  });

  it('picks the first text/plain and text/html leaves out of a multipart/alternative tree', () => {
    const summary = summarizeGmailMessage({
      id: 'm2',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: 'Alt' }],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('plain body') } },
          { mimeType: 'text/html', body: { data: b64url('<p>html body</p>') } },
        ],
      },
    });
    expect(summary.bodyText).toBe('plain body');
    expect(summary.bodyHtml).toBe('<p>html body</p>');
  });

  it('detects an attachment part by filename without treating it as a body', () => {
    const summary = summarizeGmailMessage({
      id: 'm3',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [],
        parts: [
          { mimeType: 'text/plain', body: { data: b64url('see attached') } },
          { mimeType: 'application/pdf', filename: 'report.pdf', body: { attachmentId: 'att-1', size: 1234 } },
        ],
      },
    });
    expect(summary.bodyText).toBe('see attached');
    expect(summary.hasAttachments).toBe(true);
    expect(summary.attachments).toEqual([
      { id: 'att-1', filename: 'report.pdf', mimeType: 'application/pdf', size: 1234 },
    ]);
  });

  it('bounds an oversized body and marks it truncated', () => {
    const huge = 'x'.repeat(30_000);
    const summary = summarizeGmailMessage({
      id: 'm4',
      threadId: 't1',
      payload: { mimeType: 'text/plain', headers: [], body: { data: b64url(huge) } },
    });
    expect(summary.bodyText.length).toBeLessThan(30_000);
    expect(summary.bodyTextTruncated).toBe(true);
  });

  it('does not throw on a malformed/empty payload and returns empty fields', () => {
    const summary = summarizeGmailMessage({ id: 'm5' });
    expect(summary.bodyText).toBe('');
    expect(summary.from).toBe('');
    expect(summary.hasAttachments).toBe(false);
  });

  it('summarizes a whole thread in the API-provided order', () => {
    const thread: GmailApiThread = {
      id: 't1',
      messages: [
        { id: 'm1', payload: { headers: [{ name: 'Subject', value: 'first' }] } },
        { id: 'm2', payload: { headers: [{ name: 'Subject', value: 'second' }] } },
      ],
    };
    const summaries = summarizeGmailThread(thread);
    expect(summaries.map((s) => s.id)).toEqual(['m1', 'm2']);
    expect(summaries.map((s) => s.subject)).toEqual(['first', 'second']);
  });

  it('does not runaway on a deeply nested or wide parts tree (bounded traversal)', () => {
    let node: any = { mimeType: 'text/plain', body: { data: b64url('deep') } };
    for (let i = 0; i < 50; i++) {
      node = { mimeType: 'multipart/mixed', parts: [node] };
    }
    const start = Date.now();
    const summary = summarizeGmailMessage({ id: 'deep', payload: node });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(summary.bodyText === 'deep' || summary.bodyText === '').toBe(true);
  });
});
