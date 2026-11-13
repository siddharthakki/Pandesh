/**
 * Replay guard (M2, reliability program): a resumed task must never repeat a consequential action an earlier,
 * interrupted attempt of the same request already performed (an email, a calendar event, a file write, a reminder, a
 * purchase). Before a consequential tool call in a successor attempt, Core looks the same call up in the predecessor
 * chain's tool ledger:
 *
 *   done     the identical call succeeded earlier           -> not executed again; the model is told it is already done
 *   unknown  the identical call started and has no outcome  -> not executed; the model must check the real state
 *            (the process died mid-call: the action may or may not have happened) and only then decide
 *   none     never seen                                      -> runs normally (every approval and fence still applies)
 *
 * Matching is on the tool name and the canonical (key-sorted) arguments, so a model that re-emits the same call with the
 * keys in another order is still caught. Read-only tools are never guarded: repeating a read changes nothing.
 */
import type { CoreDatabase } from '../db/connection';

export interface PriorTwin {
  kind: 'done' | 'unknown';
  invocationId: string;
  attemptId: string;
  at: string;
  /** The recorded result text of the earlier call (done only), shortened. */
  resultExcerpt: string;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

/** The attempts this one continues, nearest first (the chain follows predecessorAttemptId). */
export function predecessorChain(db: CoreDatabase, attemptId: string, max = 16): string[] {
  const chain: string[] = [];
  let cursor = db.get<{ predecessorAttemptId: string | null }>('SELECT predecessorAttemptId FROM attempts WHERE id = ?', [attemptId])?.predecessorAttemptId ?? null;
  while (cursor && chain.length < max && !chain.includes(cursor)) {
    chain.push(cursor);
    cursor = db.get<{ predecessorAttemptId: string | null }>('SELECT predecessorAttemptId FROM attempts WHERE id = ?', [cursor])?.predecessorAttemptId ?? null;
  }
  return chain;
}

export function findPriorTwin(db: CoreDatabase, attemptId: string, toolName: string, args: Record<string, unknown>): PriorTwin | null {
  const chain = predecessorChain(db, attemptId);
  if (!chain.length) return null;
  const rows = db.all<{ id: string; attemptId: string; argsSummary: string; status: string; startedAt: string; endedAt: string | null; result: string | null }>(
    `SELECT ti.id, ti.attemptId, ti.argsSummary, ti.status, ti.startedAt, ti.endedAt, tj.resultText AS result
       FROM tool_invocations ti LEFT JOIN tool_execution_journal tj ON tj.invocationId = ti.id
      WHERE ti.attemptId IN (${chain.map(() => '?').join(',')}) AND ti.toolName = ? AND ti.status IN ('succeeded','pending')
      ORDER BY ti.startedAt DESC`,
    [...chain, toolName],
  );
  const wanted = canonical(args);
  let unknown: PriorTwin | null = null;
  for (const r of rows) {
    let theirs: unknown; try { theirs = JSON.parse(r.argsSummary); } catch { continue; }
    if (canonical(theirs) !== wanted) continue;
    if (r.status === 'succeeded') return { kind: 'done', invocationId: r.id, attemptId: r.attemptId, at: r.endedAt ?? r.startedAt, resultExcerpt: String(r.result ?? '').slice(0, 300) };
    unknown ??= { kind: 'unknown', invocationId: r.id, attemptId: r.attemptId, at: r.startedAt, resultExcerpt: '' };
  }
  return unknown;
}

export function replayRefusal(twin: PriorTwin, toolName: string): string {
  return twin.kind === 'done'
    ? `Already done: this exact ${toolName} call succeeded in the interrupted attempt ${twin.attemptId} at ${twin.at}${twin.resultExcerpt ? ` (it returned: ${twin.resultExcerpt.replace(/\s+/g, ' ')})` : ''}. It was NOT repeated. Continue with what is still missing, and do not report it as done again by doing it twice.`
    : `Not repeated: this exact ${toolName} call was STARTED in the interrupted attempt ${twin.attemptId} at ${twin.at} but its outcome was never recorded, so it may or may not have happened. Check the real state with a read tool first (does the file, event, reminder or draft exist?). Repeat the call only if it does not.`;
}
