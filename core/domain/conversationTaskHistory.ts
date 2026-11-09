/**
 * What actually happened to earlier tasks in a conversation, read from Core's attempt records (Build 159 audit D4).
 *
 * A cancelled turn leaves the user's message but no assistant reply, so the model could not tell a cancelled task from a
 * pending one ("you just asked me to analyze documents … I'm ready to do it"). The attempt rows are the ground truth:
 * this module turns them into a short history the model sees, and into a direct answer for "what happened to my task?".
 */
import type { CoreDatabase } from '../db/connection';

export type PriorTurnStatus = 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'running' | 'waiting';

export interface PriorTurn {
  requestId: string;
  message: string;
  status: PriorTurnStatus;
  /** When it reached that state (or was last updated). */
  at: string;
  failureReason: string | null;
}

const MESSAGE_ECHO = 140;

function classify(row: { status: string; claimExpiresAt: string | null }, now: number): PriorTurnStatus {
  switch (row.status) {
    case 'completed': return 'completed';
    case 'cancelled': return 'cancelled';
    case 'cancelling': return 'cancelled';
    case 'failed': return 'failed';
    case 'recovery_required': return 'interrupted';
    case 'waiting_for_approval':
    case 'paused':
    case 'blocked': return 'waiting';
    default: {
      // A running row whose claim lapsed has no live executor: the app stopped or restarted under it.
      const expires = row.claimExpiresAt ? Date.parse(row.claimExpiresAt) : NaN;
      return Number.isFinite(expires) && expires < now ? 'interrupted' : 'running';
    }
  }
}

/** The latest attempt of each earlier request in the conversation, newest first (the current request excluded). */
export function listPriorTurns(db: CoreDatabase, conversationId: string, options: { excludeRequestId?: string; limit?: number; now?: number } = {}): PriorTurn[] {
  const rows = db.all<{ requestId: string; message: string; status: string; at: string; failureReason: string | null; claimExpiresAt: string | null }>(
    `SELECT r.id AS requestId, r.currentMessage AS message, a.status AS status,
            COALESCE(a.cancelledAt, a.completedAt, a.updatedAt) AS at, a.failureReason AS failureReason, a.claimExpiresAt AS claimExpiresAt
       FROM requests r
       JOIN attempts a ON a.requestId = r.id
      WHERE r.conversationId = ? AND r.id != ?
        AND a.rowid = (SELECT a2.rowid FROM attempts a2 WHERE a2.requestId = r.id ORDER BY a2.createdAt DESC, a2.rowid DESC LIMIT 1)
      ORDER BY r.createdAt DESC, r.rowid DESC
      LIMIT ?`,
    [conversationId, options.excludeRequestId ?? '', options.limit ?? 5],
  );
  const now = options.now ?? Date.now();
  return rows.map((row) => ({ requestId: row.requestId, message: row.message, status: classify(row, now), at: row.at, failureReason: row.failureReason }));
}

const STATUS_WORDS: Record<PriorTurnStatus, string> = {
  completed: 'completed',
  cancelled: 'CANCELLED by the user (stopped before it finished; nothing after the stop ran, and it was not resumed)',
  failed: 'FAILED (not completed)',
  interrupted: 'INTERRUPTED (the app stopped while it was running; it was not resumed and is not complete)',
  running: 'still running',
  waiting: 'waiting for the user (approval or input)',
};

function echo(message: string): string {
  const flat = message.replace(/\s+/g, ' ').trim();
  return flat.length > MESSAGE_ECHO ? `${flat.slice(0, MESSAGE_ECHO)}…` : flat;
}

/** A system-prompt section; empty when there is no earlier task. */
export function renderTaskHistorySection(turns: readonly PriorTurn[]): string {
  if (turns.length === 0) return '';
  const lines = turns.map((turn) => `- "${echo(turn.message)}" → ${STATUS_WORDS[turn.status]}${turn.status === 'failed' && turn.failureReason ? `: ${echo(turn.failureReason)}` : ''} (${turn.at})`);
  return `EARLIER TASKS IN THIS CONVERSATION (Core's records, newest first — authoritative; do not contradict them):\n${lines.join('\n')}\nA task marked CANCELLED, FAILED or INTERRUPTED is not done and is not pending: say so plainly if asked, and only redo it if the user asks.`;
}

/** "What happened to my previous task? Was it completed, cancelled or interrupted?" and similar status questions. */
export function isTaskStatusQuestion(text: string): boolean {
  const t = text.trim();
  return /\b(?:what\s+happened\s+(?:to|with)|status\s+of|did\s+(?:you\s+)?(?:finish|complete)|was\s+(?:it|that|my)\b[^?]*\b(?:completed|finished|cancell?ed|interrupted|done))\b[^?]*\b(?:previous|last|earlier|my|that|the)\b[^?]*\b(?:task|request|job|work|analysis|report)\b/i.test(t)
    || /\b(?:previous|last|earlier)\s+(?:task|request|job)\b[^?]*\b(?:completed|cancell?ed|interrupted|finished|done|happen)/i.test(t);
}

/** A direct, record-based answer about the most recent earlier task; null when there is none. */
export function answerTaskStatusQuestion(turns: readonly PriorTurn[]): string | null {
  const last = turns[0];
  if (!last) return null;
  const what = `Your previous task — "${echo(last.message)}" —`;
  switch (last.status) {
    case 'completed': return `${what} completed (${last.at}). Its result is the reply directly after it in this conversation.`;
    case 'cancelled': return `${what} was cancelled: you stopped it at ${last.at} before it finished. Nothing after the stop was run, it was not resumed after the restart, and no result from it was delivered. Say "do it again" if you want me to start it over.`;
    case 'failed': return `${what} failed at ${last.at} and is not complete${last.failureReason ? `: ${echo(last.failureReason)}` : ''}. Say "try again" if you want me to rerun it.`;
    case 'interrupted': return `${what} was interrupted: the app stopped while it was running (last activity ${last.at}). It was not resumed and is not complete. Say "do it again" if you want me to start it over.`;
    case 'running': return `${what} is still running (last activity ${last.at}).`;
    case 'waiting': return `${what} is waiting for you (an approval or an answer) since ${last.at}.`;
  }
}
