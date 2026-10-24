/**
 * Draft-bound send safety: a canonical digest over exactly the fields a human
 * approves when confirming a Gmail send, computed identically at draft-create
 * time and again immediately before send (see AI_OS_ARCHITECTURE.md "Gmail
 * draft-bound send safety"). The two computations must agree bit-for-bit on
 * the same content, or `gmail_send_draft` refuses — this module is the single
 * source of truth for what "the same content" means.
 *
 * Attachments are intentionally out of scope for this milestone (the task
 * omits attachment support), so the digest never covers them.
 */
import * as crypto from 'node:crypto';

export interface GmailDraftContent {
  accountEmail: string;
  draftId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
}

/** Trims and lower-cases nothing (case can be meaningful in a display name)
 * but normalizes whitespace and drops empty entries, then sorts so recipient
 * *order* in the argument list never changes the digest — only the set and
 * exact text of each address does. */
function normalizeAddressList(addresses: string[]): string[] {
  return addresses
    .map((a) => a.trim().replace(/\s+/g, ' '))
    .filter((a) => a.length > 0)
    .sort();
}

function normalizeText(text: string): string {
  // Normalize line endings only — every other byte of the body is significant
  // to what a human reviewed and approved.
  return text.replace(/\r\n/g, '\n');
}

/** Deterministic canonical JSON: object keys in a fixed, explicit order so
 * the same content always serializes identically regardless of how the
 * caller happened to construct the object. */
export function canonicalizeGmailDraft(content: GmailDraftContent): string {
  const canonical = {
    accountEmail: content.accountEmail.trim(),
    draftId: content.draftId,
    threadId: content.threadId ?? null,
    to: normalizeAddressList(content.to),
    cc: normalizeAddressList(content.cc),
    bcc: normalizeAddressList(content.bcc),
    subject: normalizeText(content.subject),
    bodyText: normalizeText(content.bodyText),
    bodyHtml: content.bodyHtml === null || content.bodyHtml === undefined ? null : normalizeText(content.bodyHtml),
  };
  return JSON.stringify(canonical);
}

export function computeGmailDraftDigest(content: GmailDraftContent): string {
  return crypto.createHash('sha256').update(canonicalizeGmailDraft(content)).digest('hex');
}

const MAX_PRESENTATION_BODY_CHARS = 8_000;

export interface GmailSendPresentation {
  kind: 'gmail_send_draft';
  accountEmail: string;
  draftId: string;
  threadId: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  bodyTextTruncated: boolean;
}

/** The immutable, approval-time rendering of exactly what a human is being
 * asked to confirm sending — bounded so a huge body cannot make an approval
 * card unbounded, mirroring `writeProposal.ts`'s diff bounding. */
export function buildGmailSendPresentation(content: GmailDraftContent): GmailSendPresentation {
  const truncated = content.bodyText.length > MAX_PRESENTATION_BODY_CHARS;
  return {
    kind: 'gmail_send_draft',
    accountEmail: content.accountEmail,
    draftId: content.draftId,
    threadId: content.threadId,
    to: normalizeAddressList(content.to),
    cc: normalizeAddressList(content.cc),
    bcc: normalizeAddressList(content.bcc),
    subject: content.subject,
    bodyText: truncated ? `${content.bodyText.slice(0, MAX_PRESENTATION_BODY_CHARS)}\n…[truncated]` : content.bodyText,
    bodyHtml: content.bodyHtml ? '[html body present]' : null,
    bodyTextTruncated: truncated,
  };
}
