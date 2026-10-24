/**
 * Durable Command Queue — Core-owned waiting/active commands for Jarvis.
 * Desktop presents fresh confirmation before each start; silence never executes.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';

export type CommandQueueStatus =
  | 'waiting'
  | 'confirming'
  | 'active'
  | 'completed'
  | 'skipped'
  | 'postponed'
  | 'cancelled'
  | 'failed';

export interface CommandQueueItem {
  id: string;
  ordinal: number;
  status: CommandQueueStatus;
  source: 'text' | 'voice' | 'ui';
  title: string;
  instruction: string;
  revision: number;
  confirmationToken: string | null;
  confirmationExpiresAt: string | null;
  dependsOnId: string | null;
  attemptId: string | null;
  requestId: string | null;
  outcome: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  postponedUntil: string | null;
  lastError: string | null;
}

export const COMMAND_QUEUE_CONFIRMATION_MS = 60_000;
export const COMMAND_QUEUE_MAX_INSTRUCTION = 4_000;

/** Allow packaged/proof runs to shorten confirmation without changing production default. */
export function resolveConfirmationMs(
  fallbackMs: number = COMMAND_QUEUE_CONFIRMATION_MS,
): number {
  const raw = process.env.KARKEDIKHA_COMMAND_QUEUE_CONFIRM_MS?.trim();
  if (!raw) return fallbackMs;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 200 || parsed > fallbackMs) return fallbackMs;
  return Math.floor(parsed);
}

function mapRow(row: Record<string, unknown>): CommandQueueItem {
  return {
    id: String(row.id),
    ordinal: Number(row.ordinal),
    status: String(row.status) as CommandQueueStatus,
    source: String(row.source) as CommandQueueItem['source'],
    title: String(row.title),
    instruction: String(row.instruction),
    revision: Number(row.revision),
    confirmationToken: row.confirmationToken == null ? null : String(row.confirmationToken),
    confirmationExpiresAt: row.confirmationExpiresAt == null ? null : String(row.confirmationExpiresAt),
    dependsOnId: row.dependsOnId == null ? null : String(row.dependsOnId),
    attemptId: row.attemptId == null ? null : String(row.attemptId),
    requestId: row.requestId == null ? null : String(row.requestId),
    outcome: row.outcome == null ? null : String(row.outcome),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
    startedAt: row.startedAt == null ? null : String(row.startedAt),
    finishedAt: row.finishedAt == null ? null : String(row.finishedAt),
    postponedUntil: row.postponedUntil == null ? null : String(row.postponedUntil),
    lastError: row.lastError == null ? null : String(row.lastError),
  };
}

function requireInstruction(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new CoreError('invalid_request', 'instruction is required');
  if (trimmed.length > COMMAND_QUEUE_MAX_INSTRUCTION) {
    throw new CoreError('invalid_request', `instruction exceeds ${COMMAND_QUEUE_MAX_INSTRUCTION} characters`);
  }
  return trimmed;
}

function nextOrdinal(db: CoreDatabase): number {
  const row = db.get<{ m: number | null }>('SELECT MAX(ordinal) AS m FROM command_queue_items');
  return (row?.m ?? 0) + 1;
}

export function getCommand(db: CoreDatabase, id: string): CommandQueueItem {
  const row = db.get<Record<string, unknown>>('SELECT * FROM command_queue_items WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `command ${id} not found`);
  return mapRow(row);
}

export function listCommands(
  db: CoreDatabase,
  options: { includeTerminal?: boolean } = {},
): CommandQueueItem[] {
  const rows = options.includeTerminal
    ? db.all<Record<string, unknown>>('SELECT * FROM command_queue_items ORDER BY ordinal ASC, id ASC')
    : db.all<Record<string, unknown>>(
      `SELECT * FROM command_queue_items
       WHERE status IN ('waiting', 'confirming', 'active', 'postponed')
       ORDER BY ordinal ASC, id ASC`,
    );
  return rows.map(mapRow);
}

export function enqueueCommand(
  db: CoreDatabase,
  input: {
    instruction: string;
    title?: string;
    source?: CommandQueueItem['source'];
    dependsOnId?: string | null;
  },
): CommandQueueItem {
  const instruction = requireInstruction(input.instruction);
  const title = String(input.title ?? instruction).trim().slice(0, 120) || instruction.slice(0, 80);
  if (input.dependsOnId) getCommand(db, input.dependsOnId);
  const id = newId('cmdq');
  const at = nowIso();
  const ordinal = nextOrdinal(db);
  db.run(
    `INSERT INTO command_queue_items (
      id, ordinal, status, source, title, instruction, revision,
      confirmationToken, confirmationExpiresAt, dependsOnId,
      attemptId, requestId, outcome, createdAt, updatedAt,
      startedAt, finishedAt, postponedUntil, lastError
    ) VALUES (?, ?, 'waiting', ?, ?, ?, 1, NULL, NULL, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, NULL)`,
    [id, ordinal, input.source ?? 'text', title, instruction, input.dependsOnId ?? null, at, at],
  );
  return getCommand(db, id);
}

export function editCommand(
  db: CoreDatabase,
  id: string,
  input: { instruction?: string; title?: string },
): CommandQueueItem {
  const existing = getCommand(db, id);
  if (existing.status === 'active' || existing.status === 'completed') {
    throw new CoreError('invalid_transition', `cannot edit command in status ${existing.status}`);
  }
  const instruction = input.instruction !== undefined
    ? requireInstruction(input.instruction)
    : existing.instruction;
  const title = input.title !== undefined
    ? String(input.title).trim().slice(0, 120) || existing.title
    : existing.title;
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items
     SET instruction = ?, title = ?, revision = revision + 1,
         confirmationToken = NULL, confirmationExpiresAt = NULL,
         status = CASE WHEN status = 'confirming' THEN 'waiting' ELSE status END,
         updatedAt = ?
     WHERE id = ?`,
    [instruction, title, at, id],
  );
  return getCommand(db, id);
}

export function reorderCommand(db: CoreDatabase, id: string, newOrdinal: number): CommandQueueItem {
  const existing = getCommand(db, id);
  if (!['waiting', 'postponed', 'confirming'].includes(existing.status)) {
    throw new CoreError('invalid_transition', `cannot reorder command in status ${existing.status}`);
  }
  const ordinal = Math.max(1, Math.floor(newOrdinal));
  const at = nowIso();
  db.run('UPDATE command_queue_items SET ordinal = ?, updatedAt = ? WHERE id = ?', [ordinal, at, id]);
  return getCommand(db, id);
}

export function removeCommand(db: CoreDatabase, id: string): CommandQueueItem {
  const existing = getCommand(db, id);
  if (existing.status === 'active') {
    throw new CoreError('invalid_transition', 'cannot remove an active command; cancel it first');
  }
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items SET status = 'cancelled', finishedAt = ?, updatedAt = ?, outcome = 'removed' WHERE id = ?`,
    [at, at, id],
  );
  return getCommand(db, id);
}

export function skipCommand(db: CoreDatabase, id: string): CommandQueueItem {
  const existing = getCommand(db, id);
  if (!['waiting', 'confirming', 'postponed'].includes(existing.status)) {
    throw new CoreError('invalid_transition', `cannot skip command in status ${existing.status}`);
  }
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items SET status = 'skipped', finishedAt = ?, updatedAt = ?,
     confirmationToken = NULL, confirmationExpiresAt = NULL, outcome = 'skipped' WHERE id = ?`,
    [at, at, id],
  );
  return getCommand(db, id);
}

export function postponeCommand(db: CoreDatabase, id: string, untilIso: string): CommandQueueItem {
  const existing = getCommand(db, id);
  if (!['waiting', 'confirming'].includes(existing.status)) {
    throw new CoreError('invalid_transition', `cannot postpone command in status ${existing.status}`);
  }
  const until = new Date(untilIso);
  if (!Number.isFinite(until.getTime())) throw new CoreError('invalid_request', 'postponedUntil must be ISO-8601');
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items SET status = 'postponed', postponedUntil = ?, updatedAt = ?,
     confirmationToken = NULL, confirmationExpiresAt = NULL WHERE id = ?`,
    [until.toISOString(), at, id],
  );
  return getCommand(db, id);
}

/** Expire stale confirmations back to waiting (silence = no execute). */
export function expireStaleConfirmations(db: CoreDatabase, now: string = nowIso()): number {
  const result = db.run(
    `UPDATE command_queue_items
     SET status = 'waiting', confirmationToken = NULL, confirmationExpiresAt = NULL, updatedAt = ?
     WHERE status = 'confirming' AND confirmationExpiresAt IS NOT NULL AND confirmationExpiresAt < ?`,
    [now, now],
  );
  return Number(result.changes ?? 0);
}

function dependencyBlocks(db: CoreDatabase, item: CommandQueueItem): string | null {
  if (!item.dependsOnId) return null;
  const dep = getCommand(db, item.dependsOnId);
  if (dep.status === 'failed' || dep.status === 'cancelled' || dep.status === 'skipped') {
    return `blocked by prerequisite ${dep.id} (${dep.status})`;
  }
  if (dep.status !== 'completed') {
    return `waiting for prerequisite ${dep.id} (${dep.status})`;
  }
  return null;
}

/**
 * Offer the next runnable waiting/postponed-due command for confirmation.
 * Exactly one confirming/active item at a time.
 */
export function offerNextConfirmation(
  db: CoreDatabase,
  nowMs: number = Date.now(),
  confirmMs: number = resolveConfirmationMs(),
): CommandQueueItem | null {
  expireStaleConfirmations(db, new Date(nowMs).toISOString());
  const busy = db.get<Record<string, unknown>>(
    `SELECT id FROM command_queue_items WHERE status IN ('confirming', 'active') LIMIT 1`,
  );
  if (busy) return getCommand(db, String(busy.id));

  const candidates = db.all<Record<string, unknown>>(
    `SELECT * FROM command_queue_items
     WHERE status IN ('waiting', 'postponed')
     ORDER BY ordinal ASC, id ASC`,
  ).map(mapRow);

  const nowIsoStr = new Date(nowMs).toISOString();
  for (const item of candidates) {
    if (item.status === 'postponed' && item.postponedUntil && item.postponedUntil > nowIsoStr) continue;
    const block = dependencyBlocks(db, item);
    if (block) continue;
    const token = newId('cmdconf');
    const expires = new Date(nowMs + confirmMs).toISOString();
    db.run(
      `UPDATE command_queue_items
       SET status = 'confirming', confirmationToken = ?, confirmationExpiresAt = ?,
           postponedUntil = NULL, updatedAt = ?
       WHERE id = ?`,
      [token, expires, nowIsoStr, item.id],
    );
    return getCommand(db, item.id);
  }
  return null;
}

export function confirmRun(
  db: CoreDatabase,
  id: string,
  token: string,
  expectedRevision: number,
): CommandQueueItem {
  expireStaleConfirmations(db);
  const item = getCommand(db, id);
  if (item.status !== 'confirming') {
    throw new CoreError('invalid_transition', `command ${id} is not awaiting confirmation`);
  }
  if (item.revision !== expectedRevision) {
    throw new CoreError('revision_mismatch', 'command changed since confirmation was issued; confirm again');
  }
  if (!item.confirmationToken || item.confirmationToken !== token) {
    throw new CoreError('invalid_request', 'confirmation token does not match');
  }
  if (item.confirmationExpiresAt && item.confirmationExpiresAt < nowIso()) {
    expireStaleConfirmations(db);
    throw new CoreError('invalid_transition', 'confirmation expired; command returned to waiting');
  }
  const block = dependencyBlocks(db, item);
  if (block) throw new CoreError('dependency_violation', block);
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items
     SET status = 'active', startedAt = ?, updatedAt = ?, confirmationToken = NULL, confirmationExpiresAt = NULL
     WHERE id = ?`,
    [at, at, id],
  );
  return getCommand(db, id);
}

export function completeCommand(
  db: CoreDatabase,
  id: string,
  input: { outcome?: string; attemptId?: string; requestId?: string } = {},
): CommandQueueItem {
  const item = getCommand(db, id);
  if (item.status !== 'active') {
    throw new CoreError('invalid_transition', `command ${id} is not active`);
  }
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items
     SET status = 'completed', finishedAt = ?, updatedAt = ?, outcome = ?,
         attemptId = COALESCE(?, attemptId), requestId = COALESCE(?, requestId)
     WHERE id = ?`,
    [at, at, input.outcome ?? 'completed', input.attemptId ?? null, input.requestId ?? null, id],
  );
  return getCommand(db, id);
}

export function failCommand(
  db: CoreDatabase,
  id: string,
  error: string,
  input: { attemptId?: string; requestId?: string } = {},
): CommandQueueItem {
  const item = getCommand(db, id);
  if (item.status !== 'active') {
    throw new CoreError('invalid_transition', `command ${id} is not active`);
  }
  const at = nowIso();
  db.run(
    `UPDATE command_queue_items
     SET status = 'failed', finishedAt = ?, updatedAt = ?, lastError = ?, outcome = 'failed',
         attemptId = COALESCE(?, attemptId), requestId = COALESCE(?, requestId)
     WHERE id = ?`,
    [at, at, error.slice(0, 2_000), input.attemptId ?? null, input.requestId ?? null, id],
  );
  return getCommand(db, id);
}

/** After restart: active items need human reconcile — demote to waiting with note. */
export function reconcileInterruptedActive(db: CoreDatabase): CommandQueueItem[] {
  const rows = db.all<Record<string, unknown>>(
    `SELECT * FROM command_queue_items WHERE status = 'active'`,
  ).map(mapRow);
  const at = nowIso();
  const out: CommandQueueItem[] = [];
  for (const item of rows) {
    db.run(
      `UPDATE command_queue_items
       SET status = 'waiting', updatedAt = ?, lastError = ?,
           confirmationToken = NULL, confirmationExpiresAt = NULL
       WHERE id = ?`,
      [at, 'Interrupted — reconcile against Core evidence before re-running; not auto-replayed.', item.id],
    );
    out.push(getCommand(db, item.id));
  }
  expireStaleConfirmations(db, at);
  return out;
}

export function queueSnapshot(db: CoreDatabase): {
  active: CommandQueueItem | null;
  confirming: CommandQueueItem | null;
  waiting: CommandQueueItem[];
  recentTerminal: CommandQueueItem[];
} {
  expireStaleConfirmations(db);
  const all = listCommands(db, { includeTerminal: true });
  return {
    active: all.find((c) => c.status === 'active') ?? null,
    confirming: all.find((c) => c.status === 'confirming') ?? null,
    waiting: all.filter((c) => c.status === 'waiting' || c.status === 'postponed'),
    recentTerminal: all.filter((c) => ['completed', 'skipped', 'cancelled', 'failed'].includes(c.status)).slice(-10),
  };
}
