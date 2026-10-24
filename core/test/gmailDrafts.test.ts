import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { clearGmailDraftBinding, getGmailDraftBinding, recordGmailDraftBinding } from '../domain/gmailDrafts';
import { computeGmailDraftDigest, type GmailDraftContent } from '../runtime/connectors/gmailDraftDigest';

let dir: string;
let db: CoreDatabase;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-drafts-'));
  db = openCoreDatabase(path.join(dir, 'core.db')).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

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

describe('gmailDrafts: durable bridge between create-draft and send-draft approvals', () => {
  it('records a binding and computes the digest server-side from the given content', () => {
    const c = content();
    const binding = recordGmailDraftBinding(db, { content: c });
    expect(binding.digest).toBe(computeGmailDraftDigest(c));
    expect(binding.to).toEqual(['bob@example.com']);
  });

  it('round-trips through getGmailDraftBinding', () => {
    recordGmailDraftBinding(db, { content: content({ cc: ['carol@example.com'] }) });
    const fetched = getGmailDraftBinding(db, 'draft-1');
    expect(fetched?.cc).toEqual(['carol@example.com']);
    expect(fetched?.subject).toBe('Hello');
  });

  it('returns undefined for an unknown draft id', () => {
    expect(getGmailDraftBinding(db, 'nope')).toBeUndefined();
  });

  it('recreating the same draft id (e.g. draft regenerated) replaces the prior binding, not appends', () => {
    recordGmailDraftBinding(db, { content: content({ subject: 'First' }) });
    recordGmailDraftBinding(db, { content: content({ subject: 'Second' }) });
    const fetched = getGmailDraftBinding(db, 'draft-1');
    expect(fetched?.subject).toBe('Second');
    expect(db.all('SELECT * FROM gmail_draft_bindings WHERE draftId = ?', ['draft-1'])).toHaveLength(1);
  });

  it('clearGmailDraftBinding removes the row', () => {
    recordGmailDraftBinding(db, { content: content() });
    clearGmailDraftBinding(db, 'draft-1');
    expect(getGmailDraftBinding(db, 'draft-1')).toBeUndefined();
  });

  it('two different drafts are independent rows', () => {
    recordGmailDraftBinding(db, { content: content({ draftId: 'draft-1', subject: 'A' }) });
    recordGmailDraftBinding(db, { content: content({ draftId: 'draft-2', subject: 'B' }) });
    expect(getGmailDraftBinding(db, 'draft-1')?.subject).toBe('A');
    expect(getGmailDraftBinding(db, 'draft-2')?.subject).toBe('B');
  });
});
