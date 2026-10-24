/**
 * Durable commitments — the record of a promise the user actually made.
 *
 * A reminder says "do this at 5". A commitment says "I said I would do this,
 * and it still stands until <condition> says otherwise". The two are
 * different, and only the second survives the conversation it was made in.
 *
 * What this module owns:
 *   - the durable truth of a promise (open / satisfied / cancelled / expired),
 *   - the condition that decides whether it still stands,
 *   - the provenance of who said it and where it was said.
 *
 * What it deliberately does not own:
 *   - how a condition is evaluated. Only `no_reply` has a built-in checker
 *     (the follow-up routine); every other condition is reported to the user
 *     but never auto-resolved, because guessing that a promise was kept is
 *     exactly the kind of fabrication this product must not do.
 *   - any external action. Nothing here sends mail, creates an event, or
 *     touches a third party.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export const COMMITMENT_MAX_TITLE = 200;
export const COMMITMENT_MAX_DETAIL = 2_000;

/** The only condition the built-in checker understands today. */
export const COMMITMENT_CONDITION_NO_REPLY = 'no_reply';
/** A condition only the user (or the assistant asking them) can decide. */
export const COMMITMENT_CONDITION_NONE = 'none';

export const COMMITMENT_CONDITIONS = [COMMITMENT_CONDITION_NO_REPLY, COMMITMENT_CONDITION_NONE] as const;
export type CommitmentCondition = (typeof COMMITMENT_CONDITIONS)[number];

export const COMMITMENT_CHANNELS = ['gmail', 'calendar', 'none'] as const;
export type CommitmentChannel = (typeof COMMITMENT_CHANNELS)[number];

export const COMMITMENT_STATUSES = ['open', 'satisfied', 'cancelled', 'expired'] as const;
export type CommitmentStatus = (typeof COMMITMENT_STATUSES)[number];

export interface CommitmentRecord {
  id: string;
  /** What was promised, in the user's own words where possible. */
  title: string;
  detail: string | null;
  /** Where the promise lives — 'gmail' when it is about an email thread. */
  channel: CommitmentChannel;
  /** Who the promise is about: a person's name, a company, a thread subject. */
  subject: string | null;
  /** The identifier the promise is about (a Gmail thread id, an event id). */
  relatedId: string | null;
  condition: CommitmentCondition;
  /** When the promise was meant to be acted on by (ISO-8601 UTC), if it has a date. */
  dueAt: string | null;
  status: CommitmentStatus;
  conversationId: string | null;
  attemptId: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

/** A commitment plus the truth about it right now. */
export interface CommitmentView extends CommitmentRecord {
  /** True when the promise is still open and its due moment has passed. */
  overdue: boolean;
  /** True when the built-in checker can decide this condition on its own. */
  checkable: boolean;
}

export interface CreateCommitmentInput {
  title: string;
  detail?: string | null;
  channel?: string | null;
  subject?: string | null;
  relatedId?: string | null;
  condition?: string | null;
  dueAt?: string | null;
  conversationId?: string | null;
  attemptId?: string | null;
}

function requireText(value: string, field: string, max: number): string {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new CoreError('invalid_request', `${field} is required`);
  if (trimmed.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return trimmed;
}

function optionalText(value: string | null | undefined, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (trimmed.length > max) throw new CoreError('invalid_request', `${field} exceeds ${max} characters`);
  return trimmed;
}

function optionalInstant(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const ms = Date.parse(String(value).trim());
  if (!Number.isFinite(ms)) throw new CoreError('invalid_request', `${field} must be an ISO-8601 instant`);
  return new Date(ms).toISOString();
}

function mapCommitment(row: Record<string, unknown>): CommitmentRecord {
  return {
    id: String(row.id),
    title: String(row.title),
    detail: row.detail == null ? null : String(row.detail),
    channel: String(row.channel ?? 'none') as CommitmentChannel,
    subject: row.subject == null ? null : String(row.subject),
    relatedId: row.relatedId == null ? null : String(row.relatedId),
    condition: String(row.condition ?? 'none') as CommitmentCondition,
    dueAt: row.dueAt == null ? null : String(row.dueAt),
    status: String(row.status ?? 'open') as CommitmentStatus,
    conversationId: row.conversationId == null ? null : String(row.conversationId),
    attemptId: row.attemptId == null ? null : String(row.attemptId),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    resolvedAt: row.resolvedAt == null ? null : String(row.resolvedAt),
    resolutionNote: row.resolutionNote == null ? null : String(row.resolutionNote),
  };
}

export function createCommitment(db: CoreDatabase, input: CreateCommitmentInput): CommitmentRecord {
  const title = requireText(input.title, 'title', COMMITMENT_MAX_TITLE);
  const detail = optionalText(input.detail, COMMITMENT_MAX_DETAIL, 'detail');
  const channelRaw = String(input.channel ?? 'none').trim().toLowerCase();
  if (channelRaw && !(COMMITMENT_CHANNELS as readonly string[]).includes(channelRaw)) {
    throw new CoreError('invalid_request', `channel must be one of ${COMMITMENT_CHANNELS.join(', ')}`);
  }
  const conditionRaw = String(input.condition ?? COMMITMENT_CONDITION_NONE).trim().toLowerCase();
  if (conditionRaw && !(COMMITMENT_CONDITIONS as readonly string[]).includes(conditionRaw)) {
    throw new CoreError('invalid_request', `condition must be one of ${COMMITMENT_CONDITIONS.join(', ')}`);
  }
  const id = newId('commitment');
  const at = nowIso();
  db.run(
    `INSERT INTO commitments (id, title, detail, channel, subject, relatedId, condition, dueAt, status, conversationId, attemptId, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
    [
      id,
      title,
      detail,
      channelRaw || 'none',
      optionalText(input.subject, 200, 'subject'),
      optionalText(input.relatedId, 200, 'relatedId'),
      conditionRaw || COMMITMENT_CONDITION_NONE,
      optionalInstant(input.dueAt, 'dueAt'),
      input.conversationId ?? null,
      input.attemptId ?? null,
      at,
      at,
    ],
  );
  const created = getCommitment(db, id);
  if (!created) throw new CoreError('not_found', 'the commitment was not stored');
  return created;
}

export function getCommitment(db: CoreDatabase, id: string): CommitmentRecord | undefined {
  const row = db.get<Record<string, unknown>>('SELECT * FROM commitments WHERE id = ?', [id]);
  return row ? mapCommitment(row) : undefined;
}

/** Every commitment matching a filter, newest first. */
export function listCommitments(
  db: CoreDatabase,
  filter: { status?: string | null; conversationId?: string | null; limit?: number } = {},
): CommitmentRecord[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.conversationId) {
    clauses.push('conversationId = ?');
    params.push(filter.conversationId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(200, Number(filter.limit ?? 50)));
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM commitments ${where} ORDER BY CASE WHEN dueAt IS NULL THEN 1 ELSE 0 END, dueAt ASC, createdAt DESC LIMIT ?`,
    [...params, limit],
  );
  return rows.map(mapCommitment);
}

/** Open commitments whose due moment has arrived (or that have no due date). */
export function listDueCommitments(db: CoreDatabase, nowMs: number = Date.now(), limit = 50): CommitmentRecord[] {
  const now = new Date(nowMs).toISOString();
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM commitments
      WHERE status = 'open' AND (dueAt IS NULL OR dueAt <= ?)
      ORDER BY CASE WHEN dueAt IS NULL THEN 1 ELSE 0 END, dueAt ASC, createdAt ASC
      LIMIT ?`,
    [now, Math.max(1, Math.min(200, limit))],
  );
  return rows.map(mapCommitment);
}

export function updateCommitmentStatus(
  db: CoreDatabase,
  id: string,
  status: CommitmentStatus,
  note?: string | null,
): CommitmentRecord {
  const existing = getCommitment(db, id);
  if (!existing) throw new CoreError('not_found', `commitment '${id}' does not exist`);
  if (existing.status !== 'open' && existing.status !== status) {
    // A settled promise is not silently re-opened: the truth of a resolution
    // is kept, and a change of mind is an explicit new commitment.
    throw new CoreError('conflict', `commitment '${id}' is already ${existing.status}`);
  }
  const at = nowIso();
  db.run(
    `UPDATE commitments SET status = ?, updatedAt = ?, resolvedAt = ?, resolutionNote = ? WHERE id = ?`,
    [status, at, status === 'open' ? null : at, optionalText(note, COMMITMENT_MAX_DETAIL, 'note'), id],
  );
  const updated = getCommitment(db, id);
  if (!updated) throw new CoreError('not_found', 'the commitment was not stored');
  return updated;
}

/** The truth about a promise right now: is it overdue, and can we check it? */
export function toCommitmentView(commitment: CommitmentRecord, nowMs: number = Date.now()): CommitmentView {
  const dueMs = commitment.dueAt ? Date.parse(commitment.dueAt) : Number.NaN;
  const overdue = commitment.status === 'open' && Number.isFinite(dueMs) && dueMs <= nowMs;
  return {
    ...commitment,
    overdue,
    checkable: commitment.condition === COMMITMENT_CONDITION_NO_REPLY && Boolean(commitment.relatedId),
  };
}

/** One plain sentence describing a promise, for the brief and the UI. */
export function describeCommitment(commitment: CommitmentRecord): string {
  const parts: string[] = [];
  if (commitment.subject) parts.push(commitment.subject);
  parts.push(commitment.title);
  return parts.join(' — ');
}
