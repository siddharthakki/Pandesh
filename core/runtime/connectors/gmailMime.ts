/**
 * Parses the Gmail API's already-structured `Thread`/`Message` JSON payload
 * (headers array + a `parts` tree with base64url `body.data` per leaf) into a
 * bounded, display-ready summary per message. This is NOT an RFC 2822/MIME
 * text parser — `gws`'s `gmail.users.threads.get` returns the Gmail API's
 * parsed representation, so "parsing" here means walking a JSON tree, never
 * decoding raw MIME text.
 *
 * Untrusted-content boundary: everything extracted here is email content from
 * a third party. Callers must render it as inert text/HTML for display and
 * summarization, never interpret it as instructions (see AI_OS_ARCHITECTURE.md
 * "Untrusted email boundary").
 */

const MAX_BODY_CHARS = 20_000;
const MAX_PARTS_VISITED = 200;
const MAX_PART_DEPTH = 12;

export interface GmailMessagePart {
  mimeType?: string;
  headers?: Array<{ name?: string; value?: string }>;
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
  filename?: string;
}

export interface GmailMessagePayload extends GmailMessagePart {
  headers?: Array<{ name?: string; value?: string }>;
}

export interface GmailApiMessage {
  id?: string;
  threadId?: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: GmailMessagePayload;
}

export interface GmailApiThread {
  id?: string;
  historyId?: string;
  messages?: GmailApiMessage[];
}

export interface GmailAttachmentSummary {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ThreadMessageSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  cc: string;
  subject: string;
  /** Raw `Date` header: the SENDER's clock and offset. Do not present this as the user's local time. */
  date: string;
  /** When Gmail received it, UTC ISO (from internalDate); null if absent. */
  receivedAt: string | null;
  /** receivedAt rendered in the user's time zone, with the zone named. */
  receivedLocal: string | null;
  snippet: string;
  bodyText: string;
  bodyHtml: string;
  bodyTextTruncated: boolean;
  bodyHtmlTruncated: boolean;
  hasAttachments: boolean;
  attachments: GmailAttachmentSummary[];
}

function headerValue(headers: Array<{ name?: string; value?: string }> | undefined, name: string): string {
  if (!headers) return '';
  const lower = name.toLowerCase();
  const match = headers.find((h) => typeof h.name === 'string' && h.name.toLowerCase() === lower);
  return typeof match?.value === 'string' ? match.value : '';
}

function decodeBase64Url(data: string): string {
  try {
    const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(normalized, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function bound(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

/**
 * Walks a message's `parts` tree (bounded in depth and part count) collecting
 * the first `text/plain` and `text/html` leaf bodies, and attachment summaries.
 */
function collectBodies(payload: GmailMessagePart | undefined): { plain: string; html: string; hasAttachments: boolean; attachments: GmailAttachmentSummary[] } {
  let plain = '';
  let html = '';
  let hasAttachments = false;
  const attachments: GmailAttachmentSummary[] = [];
  let visited = 0;

  function visit(part: GmailMessagePart | undefined, depth: number): void {
    if (!part || visited >= MAX_PARTS_VISITED || depth > MAX_PART_DEPTH) return;
    visited++;
    const mimeType = (part.mimeType ?? '').toLowerCase();
    const filename = part.filename?.trim() || '';
    const attachmentId = part.body?.attachmentId || '';
    const size = typeof part.body?.size === 'number' ? part.body.size : 0;
    if (filename || attachmentId) {
      hasAttachments = true;
      attachments.push({
        id: attachmentId,
        filename: filename || 'attachment',
        mimeType: mimeType || 'application/octet-stream',
        size,
      });
    }

    if (mimeType === 'text/plain' && !plain && part.body?.data) {
      plain = decodeBase64Url(part.body.data);
    } else if (mimeType === 'text/html' && !html && part.body?.data) {
      html = decodeBase64Url(part.body.data);
    } else if (mimeType.startsWith('multipart/') && Array.isArray(part.parts)) {
      for (const child of part.parts) {
        if (visited >= MAX_PARTS_VISITED) break;
        visit(child, depth + 1);
      }
    } else if (!mimeType && part.body?.data && !part.parts) {
      // Single-part message with no explicit mimeType on the leaf: treat as plain text.
      if (!plain) plain = decodeBase64Url(part.body.data);
    }
  }

  visit(payload, 0);
  return { plain, html, hasAttachments, attachments };
}

/** Summarizes one Gmail API message into bounded, display-ready fields. */
export function summarizeGmailMessage(message: GmailApiMessage, timeZone?: string): ThreadMessageSummary {
  const internalMs = Number(message.internalDate);
  const receivedAt = Number.isFinite(internalMs) && internalMs > 0 ? new Date(internalMs).toISOString() : null;
  let receivedLocal: string | null = null;
  if (receivedAt) {
    const zone = timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try { receivedLocal = `${new Date(internalMs).toLocaleString('en-GB', { timeZone: zone, weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} (${zone})`; } catch { receivedLocal = receivedAt; }
  }
  const headers = message.payload?.headers;
  const { plain, html, hasAttachments, attachments } = collectBodies(message.payload);
  const boundedText = bound(plain, MAX_BODY_CHARS);
  const boundedHtml = bound(html, MAX_BODY_CHARS);
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    from: headerValue(headers, 'From'),
    to: headerValue(headers, 'To'),
    cc: headerValue(headers, 'Cc'),
    subject: headerValue(headers, 'Subject'),
    date: headerValue(headers, 'Date'),
    receivedAt,
    receivedLocal,
    snippet: message.snippet ?? '',
    bodyText: boundedText.text,
    bodyHtml: boundedHtml.text,
    bodyTextTruncated: boundedText.truncated,
    bodyHtmlTruncated: boundedHtml.truncated,
    hasAttachments,
    attachments,
  };
}

/** Summarizes every message in a Gmail API thread, oldest first (the order
 * the API already returns them in — never re-sorted, so summaries stay
 * stable relative to what a human would see in Gmail itself). */
export function summarizeGmailThread(thread: GmailApiThread, timeZone?: string): ThreadMessageSummary[] {
  return (thread.messages ?? []).map((m) => summarizeGmailMessage(m, timeZone));
}
