/**
 * Pandesh's follow-up check — the promise keeper.
 *
 * A commitment with the condition `no_reply` says: "unless they answer, I
 * still owe them an answer". This module is the part that actually looks.
 *
 * What it does, on every tick:
 *   1. finds open `no_reply` commitments whose due moment has arrived,
 *   2. reads the Gmail thread the promise is about (read-only, behind the
 *      same permission gate the brief uses),
 *   3. if a reply from the other party arrived after the promise was made,
 *      the promise is *satisfied* — the condition was met, so it is closed,
 *   4. if no reply arrived, the user is told — once per commitment per day —
 *      with the real reason, and nothing else is touched.
 *
 * What it never does:
 *   - send mail, draft mail, or reply on the user's behalf,
 *   - close a promise it could not actually check,
 *   - guess that silence means the user acted,
 *   - interrupt: it only writes into the Core database and a conversation.
 *
 * The delivery is exactly-once per (commitment, local day) through the same
 * `routine_deliveries` ledger the daily brief uses — the primary key is what
 * refuses a second delivery, not a convention.
 */
import type { CoreDatabase } from '../db/connection';
import type { EventBroadcaster } from '../ws/broadcaster';
import { appendMessage, createConversation } from '../domain/conversations';
import { claimRoutineDelivery, completeRoutineDelivery, releaseRoutineDelivery } from '../domain/assistantRoutine';
import { listDueCommitments, updateCommitmentStatus, type CommitmentRecord } from '../domain/commitments';
import { getGmailAccountEmail } from './connectors/gmailAccessTokenStore';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { nowIso } from '../domain/ids';
import type { ConnectorAdapter } from './connectors/connectorCapability';
import type { ConnectorId } from '../shared/wireTypes';
import { SCHEDULER_CLIENT_ID } from '../domain/processTerminationPolicy';
import { readConnector } from './assistantBrief';

const ACTOR = 'kkd:follow_up_check';
const CLIENT_ID = SCHEDULER_CLIENT_ID;
const FOLLOW_UP_ROUTINE_ID = 'follow_up_check';
const EXTERNAL_TIMEOUT_MS = 8_000;

/** A message from the other side, newer than the promise, means the promise is met. */
export interface ReplyCheck {
  /** Whether a reply from the other party arrived after the promise was made. */
  replied: boolean;
  /** When the newest other-party message arrived, when there was one. */
  repliedAt: string | null;
  /** Who replied, for the wording. */
  repliedBy: string | null;
  /** Why the check could not be made, when it could not be made. */
  reason?: string;
}

/**
 * Reads the thread behind a promise and decides whether the other party
 * answered after it was made.
 *
 * The account's own address is the discriminator: a message FROM the user is
 * not a reply to the user's own promise.
 */
export async function checkForReply(
  db: CoreDatabase,
  adapters: Map<ConnectorId, ConnectorAdapter>,
  commitment: CommitmentRecord,
  options: { cwd: string; signal: AbortSignal },
): Promise<ReplyCheck> {
  if (!commitment.relatedId) {
    return { replied: false, repliedAt: null, repliedBy: null, reason: 'the promise is not linked to a thread' };
  }
  const read = await readConnector(
    db,
    adapters,
    'gmail',
    'gmail_read_thread',
    { threadId: commitment.relatedId },
    options.cwd,
    options.signal,
  );
  if (!read.ok) {
    return { replied: false, repliedAt: null, repliedBy: null, reason: read.reason ?? 'Gmail could not be read' };
  }
  const messages = Array.isArray((read.data as { messages?: unknown[] } | undefined)?.messages)
    ? ((read.data as { messages: Array<Record<string, unknown>> }).messages)
    : [];
  const account = (getGmailAccountEmail() ?? '').trim().toLowerCase();
  if (!account) {
    // Without the signed-in address there is no way to tell the other party's
    // reply from the user's own message. Saying "no reply yet" here would be a
    // guess, so the check reports that it could not be made instead.
    return {
      replied: false,
      repliedAt: null,
      repliedBy: null,
      reason: 'the signed-in Google account is unknown, so a reply cannot be told apart from your own message',
    };
  }
  const since = Date.parse(commitment.createdAt);
  let replied = false;
  let repliedAt: string | null = null;
  let repliedBy: string | null = null;
  for (const message of messages) {
    const from = typeof message.from === 'string' ? message.from : '';
    const fromAddress = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
    if (account && fromAddress === account) continue; // the user's own message
    const receivedAt = typeof message.receivedAt === 'string' ? message.receivedAt : null;
    const receivedMs = receivedAt ? Date.parse(receivedAt) : Number.NaN;
    if (Number.isFinite(since) && Number.isFinite(receivedMs) && receivedMs < since) continue; // older than the promise
    replied = true;
    if (!repliedAt || (receivedMs && Date.parse(repliedAt) < receivedMs)) {
      repliedAt = receivedAt;
      repliedBy = from.replace(/\s*<.*>/, '').slice(0, 60) || null;
    }
  }
  return { replied, repliedAt, repliedBy };
}

/** One line the user can act on. */
function followUpLine(commitment: CommitmentRecord, check: ReplyCheck, zone: string): string {
  const subject = commitment.subject ? ` with ${commitment.subject}` : '';
  const due = commitment.dueAt ? ` (due ${formatDay(commitment.dueAt, zone)})` : '';
  if (check.replied) {
    return `- ${commitment.title}${subject} — answered${check.repliedBy ? ` by ${check.repliedBy}` : ''}${check.repliedAt ? ` on ${formatDay(check.repliedAt, zone)}` : ''}. Closed.`;
  }
  const reason = check.reason ? ` (could not check: ${check.reason})` : '';
  return `- ${commitment.title}${subject}${due} — no reply yet${reason}.`;
}

function formatDay(iso: string, zone: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString();
  }
}

export interface FollowUpRunResult {
  /** Commitments whose condition was met (a reply arrived) and were closed. */
  satisfied: string[];
  /** Commitments reported to the user as still standing. */
  outstanding: string[];
  /** True when a message was actually written for this check. */
  delivered: boolean;
  reason: string;
}

/**
 * One pass of the follow-up check.
 *
 * Nothing is written unless there is something true to say: a promise whose
 * condition was met, or a promise that is now standing without an answer.
 */
export async function runFollowUpCheck(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  options: {
    connectorRegistry?: Map<ConnectorId, ConnectorAdapter>;
    cwd?: string;
    nowMs?: number;
    timezone?: string;
  } = {},
): Promise<FollowUpRunResult> {
  const nowMs = options.nowMs ?? Date.now();
  const zone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
  const adapters = options.connectorRegistry ?? new Map<ConnectorId, ConnectorAdapter>();
  const cwd = options.cwd ?? process.cwd();
  const due = listDueCommitments(db, nowMs, 25).filter(
    (commitment) => commitment.condition === 'no_reply' && Boolean(commitment.relatedId) && Boolean(commitment.dueAt),
  );
  if (due.length === 0) {
    return { satisfied: [], outstanding: [], delivered: false, reason: 'no commitment is due' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  const satisfied: string[] = [];
  const outstanding: string[] = [];
  const lines: string[] = [];
  /** Occurrence keys this pass actually claimed, and therefore may complete. */
  const claimed: Array<{ key: string; commitmentId: string }> = [];
  try {
    for (const commitment of due) {
      const check = await checkForReply(db, adapters, commitment, { cwd, signal: controller.signal });
      if (check.replied) {
        // The condition was met, so the promise is closed — truthfully, with the
        // evidence of the reply recorded on it.
        updateCommitmentStatus(db, commitment.id, 'satisfied',
          check.repliedAt ? `a reply arrived on ${check.repliedAt}` : 'a reply arrived');
        satisfied.push(commitment.id);
        lines.push(followUpLine(commitment, check, zone));
        continue;
      }
      outstanding.push(commitment.id);
      if (check.reason) {
        // The promise could not be checked (Gmail not connected, no permission).
        // It is still reported, but it must not claim a delivery slot it did
        // not use, and it must not read as "no reply yet" when the truth is
        // "I could not look".
        lines.push(followUpLine(commitment, check, zone));
        continue;
      }
      const occurrenceKey = `${FOLLOW_UP_ROUTINE_ID}:${commitment.id}:${new Date(nowMs).toISOString().slice(0, 10)}`;
      if (!claimRoutineDelivery(db, FOLLOW_UP_ROUTINE_ID, occurrenceKey)) {
        // Already reported today. Say nothing again — the promise is still
        // standing, but the user has been told.
        continue;
      }
      claimed.push({ key: occurrenceKey, commitmentId: commitment.id });
      lines.push(followUpLine(commitment, check, zone));
    }
  } finally {
    clearTimeout(timer);
  }

  if (lines.length === 0) {
    // Nothing to say: give back the claims this pass took, so the ledger
    // never reserves a delivery that did not happen.
    for (const entry of claimed) releaseRoutineDelivery(db, FOLLOW_UP_ROUTINE_ID, entry.key);
    return { satisfied, outstanding, delivered: false, reason: 'nothing to report' };
  }

  const conversationId = findOrCreateFollowUpConversation(db);
  const markdown = [
    '**Follow-ups**',
    '',
    ...lines,
    '',
    `_Checked ${formatDay(new Date(nowMs).toISOString(), zone)}. Nothing was sent on your behalf._`,
  ].join('\n');
  const message = appendMessage(db, conversationId, {
    role: 'assistant',
    content: markdown,
    actor: ACTOR,
    clientId: CLIENT_ID,
  });
  for (const entry of claimed) {
    completeRoutineDelivery(db, FOLLOW_UP_ROUTINE_ID, entry.key, { conversationId, messageId: message.id });
  }
  const event = recordRuntimeEvent(db, {
    domain: 'assistant_routine',
    entityId: FOLLOW_UP_ROUTINE_ID,
    eventType: 'follow_up_delivered',
    actor: ACTOR,
    clientId: CLIENT_ID,
    metadata: {
      conversationId,
      messageId: message.id,
      satisfied,
      outstanding,
      checkedAt: nowIso(),
      title: 'A promise is still open',
      body: `${outstanding.length} follow-up${outstanding.length === 1 ? '' : 's'} standing.`,
    },
  });
  broadcaster.publishRuntime(event);
  return { satisfied, outstanding, delivered: true, reason: 'delivered' };
}

const FOLLOW_UP_CONVERSATION_TITLE = 'Follow-ups';

function findOrCreateFollowUpConversation(db: CoreDatabase): string {
  const existing = db.get<{ id: string }>(
    "SELECT id FROM conversations WHERE title = ? AND archivedAt IS NULL ORDER BY createdAt DESC LIMIT 1",
    [FOLLOW_UP_CONVERSATION_TITLE],
  );
  if (existing) return existing.id;
  return createConversation(db, { mode: 'saath_kar', title: FOLLOW_UP_CONVERSATION_TITLE, actor: ACTOR }).id;
}

/**
 * The follow-up loop.
 *
 * It runs inside Core, so it keeps working when the desktop window is closed.
 * It is deliberately a separate, quiet loop rather than an extra scheduled
 * task: the trigger is a promise becoming due, not a clock.
 */
export function startFollowUpCheckLoop(
  db: CoreDatabase,
  broadcaster: EventBroadcaster,
  intervalMs = 60_000,
  options: { connectorRegistry?: Map<ConnectorId, ConnectorAdapter>; cwd?: string } = {},
): () => void {
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    void runFollowUpCheck(db, broadcaster, {
      connectorRegistry: options.connectorRegistry,
      cwd: options.cwd,
    })
      .then((result) => {
        if (result.delivered) {
          console.log(`[karkedikha-core ${new Date().toISOString()}] follow-up check delivered (${result.outstanding.length} standing)`);
        }
      })
      .catch((err) => {
        console.error(`[karkedikha-core ${new Date().toISOString()}] follow-up check failed:`, err instanceof Error ? err.message : err);
      })
      .finally(() => { running = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  setTimeout(tick, 8_000).unref?.();
  return () => clearInterval(timer);
}
