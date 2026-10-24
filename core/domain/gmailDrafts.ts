/**
 * Durable bridge between the two separate approvals a Gmail send goes
 * through: `gmail_create_draft` (draft tier) records the canonical digest and
 * display content a human reviewed when the draft was created; when the model
 * later calls `gmail_send_draft{draftId}` (execute tier, which carries no
 * content of its own), `connectorDispatch.ts` looks up this row to build the
 * send-confirmation approval card and freeze the "approved digest" into that
 * approval. See `core/runtime/connectors/gmailDraftDigest.ts` for what the
 * digest actually covers.
 *
 * One row per live draft, keyed by Gmail's own draft ID (not per-attempt, not
 * per-conversation) — a draft can be reviewed for sending from any later turn
 * that knows its ID.
 */
import type { CoreDatabase } from '../db/connection';
import { nowIso } from './ids';
import type { GmailDraftContent } from '../runtime/connectors/gmailDraftDigest';
import { computeGmailDraftDigest } from '../runtime/connectors/gmailDraftDigest';

export interface GmailDraftBindingInput {
  content: GmailDraftContent;
}

export interface GmailDraftBinding {
  draftId: string;
  accountEmail: string;
  threadId: string | null;
  digest: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

interface GmailDraftBindingRow {
  draftId: string;
  accountEmail: string;
  threadId: string | null;
  digest: string;
  toJson: string;
  ccJson: string;
  bccJson: string;
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToBinding(row: GmailDraftBindingRow): GmailDraftBinding {
  return {
    draftId: row.draftId,
    accountEmail: row.accountEmail,
    threadId: row.threadId,
    digest: row.digest,
    to: JSON.parse(row.toJson) as string[],
    cc: JSON.parse(row.ccJson) as string[],
    bcc: JSON.parse(row.bccJson) as string[],
    subject: row.subject,
    bodyText: row.bodyText,
    bodyHtml: row.bodyHtml,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Records (or replaces, if the same draft ID is recreated) the approved
 * digest and display content for a Gmail draft, computed fresh from exactly
 * what was just written to Gmail — never trusting a caller-supplied digest. */
export function recordGmailDraftBinding(db: CoreDatabase, input: GmailDraftBindingInput): GmailDraftBinding {
  const { content } = input;
  const digest = computeGmailDraftDigest(content);
  const at = nowIso();
  db.run(
    `INSERT INTO gmail_draft_bindings
       (draftId, accountEmail, threadId, digest, toJson, ccJson, bccJson, subject, bodyText, bodyHtml, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(draftId) DO UPDATE SET
       accountEmail = excluded.accountEmail,
       threadId = excluded.threadId,
       digest = excluded.digest,
       toJson = excluded.toJson,
       ccJson = excluded.ccJson,
       bccJson = excluded.bccJson,
       subject = excluded.subject,
       bodyText = excluded.bodyText,
       bodyHtml = excluded.bodyHtml,
       updatedAt = excluded.updatedAt`,
    [
      content.draftId,
      content.accountEmail,
      content.threadId,
      digest,
      JSON.stringify(content.to),
      JSON.stringify(content.cc),
      JSON.stringify(content.bcc),
      content.subject,
      content.bodyText,
      content.bodyHtml,
      at,
      at,
    ],
  );
  return getGmailDraftBinding(db, content.draftId)!;
}

export function getGmailDraftBinding(db: CoreDatabase, draftId: string): GmailDraftBinding | undefined {
  const row = db.get<GmailDraftBindingRow>('SELECT * FROM gmail_draft_bindings WHERE draftId = ?', [draftId]);
  return row ? rowToBinding(row) : undefined;
}

export function clearGmailDraftBinding(db: CoreDatabase, draftId: string): void {
  db.run('DELETE FROM gmail_draft_bindings WHERE draftId = ?', [draftId]);
}
