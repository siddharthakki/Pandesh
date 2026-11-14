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
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CoreDatabase } from '../db/connection';
import { REFUSED_PATTERN } from './turnOutcome';

export interface PriorTwin {
  kind: 'done' | 'unknown';
  /** True when the earlier call differed in wording and was matched by meaning (same reminder time, event, recipients). */
  semantic?: boolean;
  invocationId: string;
  attemptId: string;
  at: string;
  /** The recorded result text of the earlier call (done only), shortened. */
  resultExcerpt: string;
}

/** Argument names that name a file or folder: the same place spelled differently must compare equal. */
const PATH_KEYS = new Set(['filepath', 'path', 'dirpath', 'workspacepath', 'source', 'output', 'destination', 'target', 'targetpath', 'folder', 'cwd', 'file']);

/** One spelling per place: resolved against the workspace, normalised separators, no `..`, case-folded on Windows. */
export function canonicalPath(value: string, workspaceRoot: string | null): string {
  const raw = value.trim();
  if (!raw || /^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  let full = path.isAbsolute(raw) ? path.resolve(raw) : (workspaceRoot ? path.resolve(workspaceRoot, raw) : path.normalize(raw));
  while (full.length > 1 && (full.endsWith('/') || full.endsWith('\\')) && !/^[a-zA-Z]:[\\/]$/.test(full)) full = full.slice(0, -1);
  return process.platform === 'win32' ? full.toLowerCase() : full;
}

export function normalizeArgs(value: unknown, workspaceRoot: string | null, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => normalizeArgs(v, workspaceRoot, key));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeArgs(v, workspaceRoot, k);
    return out;
  }
  if (typeof value === 'string') return PATH_KEYS.has(key.toLowerCase()) ? canonicalPath(value, workspaceRoot) : value;
  return value;
}

export function argsHash(args: unknown): string {
  return crypto.createHash('sha256').update(canonical(args)).digest('hex');
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

// ---------------------------------------------------------------- semantic twins (M2: reworded repeats)

const tokens = (s: unknown): string[] => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
/** Word overlap of two texts (Jaccard over distinct words); two empty texts are the same. */
function similarity(a: unknown, b: unknown): number {
  const x = new Set(tokens(a)); const y = new Set(tokens(b));
  if (!x.size && !y.size) return 1;
  let both = 0; for (const t of x) if (y.has(t)) both += 1;
  return both / (x.size + y.size - both);
}
const stripReplyPrefix = (s: unknown): string => String(s ?? '').replace(/^(\s*(re|aw|fwd?|wg)\s*:\s*)+/i, '');
const emails = (a: unknown): string[] => (Array.isArray(a) ? a : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean).sort();
const REMINDER_TOLERANCE_MS = 5 * 60_000;

/** The instant a reminder call means, from its own arguments and when it was made (inMinutes is relative to that moment). */
function reminderDueMs(args: Record<string, unknown>, at: string): number | null {
  try {
    if (args.date && args.time) { const t = new Date(`${String(args.date)}T${String(args.time)}`).getTime(); return Number.isNaN(t) ? null : t; }
    if (args.inMinutes !== undefined) { const base = new Date(at).getTime(); return Number.isNaN(base) ? null : base + Number(args.inMinutes) * 60_000; }
    if (args.dueAt) { const t = new Date(String(args.dueAt)).getTime(); return Number.isNaN(t) ? null : t; }
  } catch { /* unparseable: not comparable */ }
  return null;
}
function eventStartMs(v: unknown): number | null { const t = new Date(String(v ?? '')).getTime(); return Number.isNaN(t) ? null : t; }

/**
 * Whether two calls of the same consequential tool ask for the same real-world thing in different words: a reminder
 * with the same subject at the same time, an event with the same title and start, a draft to the same people with the same
 * subject, a note, promise or routine with the same wording. Conservative on purpose (a clear overlap, not a hunch), because
 * a false match only asks the person once, while a false miss repeats an email or event.
 */
export function semanticallySame(tool: string, a: Record<string, unknown>, aAt: string, b: Record<string, unknown>, bAt: string): boolean {
  switch (tool) {
    case 'create_reminder': {
      const x = reminderDueMs(a, aAt); const y = reminderDueMs(b, bAt);
      return x !== null && y !== null && Math.abs(x - y) <= REMINDER_TOLERANCE_MS && similarity(a.title, b.title) >= 0.75;
    }
    case 'calendar_create_event': case 'calendar_update_event': case 'calendar_delete_event': {
      if (tool !== 'calendar_create_event') return String(a.eventId ?? '') !== '' && a.eventId === b.eventId && JSON.stringify(a) === JSON.stringify(b);
      const x = eventStartMs(a.start); const y = eventStartMs(b.start);
      const sameStart = x !== null && y !== null ? Math.abs(x - y) <= 60_000 : String(a.start ?? '').trim() === String(b.start ?? '').trim();
      return sameStart && similarity(a.title, b.title) >= 0.75;
    }
    case 'gmail_create_draft': {
      const ra = [...emails(a.to), ...emails(a.cc)].join(','); const rb = [...emails(b.to), ...emails(b.cc)].join(',');
      return ra !== '' && ra === rb && similarity(stripReplyPrefix(a.subject), stripReplyPrefix(b.subject)) >= 0.8 && String(a.threadId ?? '') === String(b.threadId ?? '');
    }
    case 'create_note': return similarity(a.title, b.title) >= 0.75 && similarity(a.body, b.body) >= 0.85;
    case 'create_commitment': return similarity(a.title, b.title) >= 0.75 && String(a.relatedId ?? '') === String(b.relatedId ?? '');
    case 'schedule_task': return similarity(a.title, b.title) >= 0.75 && String(a.dailyTime ?? '') === String(b.dailyTime ?? '') && String(a.date ?? '') === String(b.date ?? '') && String(a.time ?? '') === String(b.time ?? '');
    default: return false;
  }
}

/**
 * What Core's own records say about an action whose outcome the journal could not settle (it started, the process died).
 *   'happened'      a matching record exists, created at or after the earlier call began
 *   'not_happened'  Core owns this store and holds no such record
 *   'unverifiable'  the effect lives outside Core (email, calendar): fail closed, the person decides
 */
export function reconcileOwnAction(db: CoreDatabase, tool: string, args: Record<string, unknown>, since: string): { state: 'happened' | 'not_happened' | 'unverifiable'; id?: string } {
  const from = new Date(new Date(since).getTime() - 60_000).toISOString();
  try {
    if (tool === 'create_reminder') {
      const due = reminderDueMs(args, new Date().toISOString());
      const rows = db.all<{ id: string; title: string; dueAt: string }>("SELECT id, title, dueAt FROM everyday_reminders WHERE status != 'cancelled' AND createdAt >= ?", [from]);
      const hit = rows.find((r) => similarity(r.title, args.title) >= 0.75 && (due === null || Math.abs(new Date(r.dueAt).getTime() - due) <= REMINDER_TOLERANCE_MS + 60_000 * 60));
      return hit ? { state: 'happened', id: hit.id } : { state: 'not_happened' };
    }
    if (tool === 'create_note') {
      const rows = db.all<{ id: string; title: string; body: string }>('SELECT id, title, body FROM everyday_notes WHERE deletedAt IS NULL AND createdAt >= ?', [from]);
      const hit = rows.find((r) => similarity(r.body, args.body) >= 0.85);
      return hit ? { state: 'happened', id: hit.id } : { state: 'not_happened' };
    }
    if (tool === 'create_commitment') {
      const rows = db.all<{ id: string; title: string }>('SELECT id, title FROM commitments WHERE createdAt >= ?', [from]);
      const hit = rows.find((r) => similarity(r.title, args.title) >= 0.75);
      return hit ? { state: 'happened', id: hit.id } : { state: 'not_happened' };
    }
    if (tool === 'schedule_task') {
      const rows = db.all<{ id: string; title: string }>('SELECT id, title FROM scheduled_tasks WHERE enabled = 1 AND createdAt >= ?', [from]);
      const hit = rows.find((r) => similarity(r.title, args.title) >= 0.75);
      return hit ? { state: 'happened', id: hit.id } : { state: 'not_happened' };
    }
  } catch { return { state: 'unverifiable' }; }
  return { state: 'unverifiable' };
}

export function findPriorTwin(db: CoreDatabase, attemptId: string, toolName: string, args: Record<string, unknown>, workspaceRoot: string | null = null): PriorTwin | null {
  const chain = predecessorChain(db, attemptId);
  if (!chain.length) return null;
  const rows = db.all<{ id: string; attemptId: string; argsSummary: string; status: string; startedAt: string; endedAt: string | null; result: string | null }>(
    `SELECT ti.id, ti.attemptId, ti.argsSummary, ti.status, ti.startedAt, ti.endedAt, tj.resultText AS result
       FROM tool_invocations ti LEFT JOIN tool_execution_journal tj ON tj.invocationId = ti.id
      WHERE ti.attemptId IN (${chain.map(() => '?').join(',')}) AND ti.toolName = ? AND ti.status IN ('succeeded','pending')
      ORDER BY ti.startedAt DESC`,
    [...chain, toolName],
  );
  const wanted = canonical(normalizeArgs(args, workspaceRoot));
  const wantedRaw = argsHash(args);
  let unknown: PriorTwin | null = null;
  for (const r of rows) {
    let theirs: unknown; try { theirs = JSON.parse(r.argsSummary); } catch { continue; }
    // Arguments over the storage bound were stored as {truncated, argsHash}: compare by hash, never skip them (audit: a large
    // write could be repeated because its twin could not be read).
    const t = theirs as { truncated?: boolean; argsHash?: string };
    if (t && t.truncated) { if (!t.argsHash || t.argsHash !== wantedRaw) continue; }
    else if (canonical(normalizeArgs(theirs, workspaceRoot)) !== wanted) continue;
    // A call Core or the owner REFUSED is stored 'succeeded' (no error result) but nothing happened: it is not 'done' (review finding).
    if (r.status === 'succeeded' && REFUSED_PATTERN.test(String(r.result ?? '').split('\n')[0])) continue;
    if (r.status === 'succeeded') return { kind: 'done', invocationId: r.id, attemptId: r.attemptId, at: r.endedAt ?? r.startedAt, resultExcerpt: String(r.result ?? '').slice(0, 300) };
    unknown ??= { kind: 'unknown', invocationId: r.id, attemptId: r.attemptId, at: r.startedAt, resultExcerpt: '' };
  }
  if (unknown) return unknown;
  // No identical call. The same request reworded (another title wording, another time spelling, reordered recipients) is
  // still the same action: match it by meaning for the tools where that is well defined.
  for (const r of rows) {
    let theirs: Record<string, unknown>; try { theirs = JSON.parse(r.argsSummary); } catch { continue; }
    if (!theirs || (theirs as { truncated?: boolean }).truncated) continue;
    if (!semanticallySame(toolName, args, new Date().toISOString(), theirs, r.startedAt)) continue;
    if (r.status === 'succeeded' && REFUSED_PATTERN.test(String(r.result ?? '').split('\n')[0])) continue;
    if (r.status === 'succeeded') return { kind: 'done', semantic: true, invocationId: r.id, attemptId: r.attemptId, at: r.endedAt ?? r.startedAt, resultExcerpt: String(r.result ?? '').slice(0, 300) };
    return { kind: 'unknown', semantic: true, invocationId: r.id, attemptId: r.attemptId, at: r.startedAt, resultExcerpt: '' };
  }
  return null;
}

export function replayRefusal(twin: PriorTwin, toolName: string): string {
  return twin.kind === 'done'
    ? `Already done: this ${twin.semantic ? 'same ' + toolName + ' request (in other words)' : 'exact ' + toolName + ' call'} succeeded in the interrupted attempt ${twin.attemptId} at ${twin.at}${twin.resultExcerpt ? ` (it returned: ${twin.resultExcerpt.replace(/\s+/g, ' ')})` : ''}. It was NOT repeated. Continue with what is still missing, and do not report it as done again by doing it twice.`
    : `Not repeated: this ${twin.semantic ? 'same ' + toolName + ' request (in other words)' : 'exact ' + toolName + ' call'} was STARTED in the interrupted attempt ${twin.attemptId} at ${twin.at} but its outcome was never recorded, so Pandesh cannot tell whether it happened and will not repeat it on its own. Do NOT call it again. If a read tool can show the real state, check it and report what you find; otherwise tell the user plainly that this step may or may not have been done and ask them whether to repeat it.`
}

/**
 * Operation-level reconciliation for a file write: the real file decides, not the journal. A crash can fall between the side
 * effect and the journal commit, so "the journal has no outcome" says nothing about the disk.
 *   'in_place'  the file already holds exactly this content: writing again changes nothing (treated as done)
 *   'differs'   the file is missing or holds other content: the earlier write did not (fully) happen or was changed since
 */
export function reconcileFileWrite(args: Record<string, unknown>, workspaceRoot: string | null): 'in_place' | 'differs' | 'unverifiable' {
  const raw = typeof args.filePath === 'string' ? args.filePath : typeof args.path === 'string' ? args.path : '';
  if (!raw || typeof args.content !== 'string') return 'unverifiable';
  try {
    const full = path.isAbsolute(raw) ? path.resolve(raw) : (workspaceRoot ? path.resolve(workspaceRoot, raw) : null);
    if (!full) return 'unverifiable';
    if (!fs.existsSync(full)) return 'differs';
    const have = fs.readFileSync(full, 'utf8');
    const norm = (t: string) => t.replace(/\r\n/g, '\n');
    return have === args.content || norm(have) === norm(args.content) ? 'in_place' : 'differs';
  } catch { return 'unverifiable'; }
}

/** Tools whose outcome can be checked against real state by Core itself. Everything else that is consequential fails closed. */
export const RECONCILABLE_TOOLS: ReadonlySet<string> = new Set(['write_file']);
