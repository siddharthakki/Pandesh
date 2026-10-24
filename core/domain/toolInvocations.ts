import type { CoreDatabase } from '../db/connection';
import type { ToolInvocationRecord, ToolInvocationStatus } from '../shared/wireTypes';
import { CoreError } from './errors';
import { projectEventArguments } from './eventArguments';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';

/**
 * Durable evidence bound. Raised for M39: a governed memory recall/export
 * result is legitimately larger than 8 KiB, and replacing it with a
 * `{truncated:true}` marker would destroy the auditable evidence chain this
 * column exists to hold. Still bounded — this is a tool-evidence column, not
 * a blob store.
 */
const MAX_BOUNDED_JSON_BYTES = 65_536;
/**
 * Runtime-event metadata is a notification, not the authority, and
 * `recordRuntimeEvent` hard-fails above 8 KiB. Bound the evidence copied into
 * it well below that so a large-but-legitimate tool result can never fail the
 * whole attempt (M39 correction — a governed memory export previously threw
 * `runtime_events.metadata exceeds 8192 bytes` and failed the attempt).
 */
const MAX_EVENT_EVIDENCE_BYTES = 4096;

function bounded(value: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(value ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_BOUNDED_JSON_BYTES) {
    return JSON.stringify({ truncated: true, originalBytes: Buffer.byteLength(json, 'utf8') });
  }
  return json;
}

/** The notification-sized projection of evidence. The complete record is
 * always available from `tool_invocations.evidence` / the API. */
function eventEvidence(value: Record<string, unknown> | undefined): Record<string, unknown> {
  const evidence = value ?? {};
  const json = JSON.stringify(evidence);
  if (Buffer.byteLength(json, 'utf8') <= MAX_EVENT_EVIDENCE_BYTES) return evidence;
  return {
    truncated: true,
    originalBytes: Buffer.byteLength(json, 'utf8'),
    resultCategory: (evidence as { resultCategory?: unknown }).resultCategory ?? null,
    // Structured check identity is small and is what consumers use to tell
    // a diff review from a commit; dropping it would force them back onto
    // parsing the truncated output.
    check: (evidence as { check?: unknown }).check ?? null,
  };
}

function rowToInvocation(row: Record<string, unknown>): ToolInvocationRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    approvalId: (row.approvalId as string) ?? null,
    toolName: String(row.toolName),
    argsSummary: JSON.parse(String(row.argsSummary ?? '{}')),
    status: row.status as ToolInvocationStatus,
    startedAt: String(row.startedAt),
    endedAt: (row.endedAt as string) ?? null,
    exitCode: row.exitCode === null || row.exitCode === undefined ? null : Number(row.exitCode),
    evidence: JSON.parse(String(row.evidence ?? '{}')),
  };
}

export function getToolInvocation(db: CoreDatabase, id: string): ToolInvocationRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM tool_invocations WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `tool invocation '${id}' not found`);
  return rowToInvocation(row);
}

export interface StartToolInvocationInput {
  attemptId: string;
  approvalId?: string | null;
  toolName: string;
  argsSummary?: Record<string, unknown>;
  actor: string;
  clientId?: string | null;
}

export function startToolInvocation(db: CoreDatabase, input: StartToolInvocationInput): ToolInvocationRecord {
  return db.transaction(() => {
    const attempt = db.get('SELECT id FROM attempts WHERE id = ?', [input.attemptId]);
    if (!attempt) throw new CoreError('invalid_request', `attempt '${input.attemptId}' does not exist`);
    const id = newId('tinv');
    const now = nowIso();
    db.run(
      `INSERT INTO tool_invocations (id, attemptId, approvalId, toolName, argsSummary, status, startedAt)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
      [id, input.attemptId, input.approvalId ?? null, input.toolName, bounded(input.argsSummary), now],
    );
    recordRuntimeEvent(db, {
      domain: 'tool_invocation',
      entityId: id,
      eventType: 'tool_invocation_started',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { attemptId: input.attemptId, toolName: input.toolName, argsSummary: projectEventArguments(input.argsSummary) },
    });
    return getToolInvocation(db, id);
  });
}

export interface CompleteToolInvocationInput {
  status: 'succeeded' | 'failed' | 'cancelled';
  exitCode?: number | null;
  evidence?: Record<string, unknown>;
  actor: string;
  clientId?: string | null;
}

/** Records truthful evidence (command, cwd, exit code, bounded stdout/stderr) for a
 * completed tool call — never claim success without this being called with real data. */
export function completeToolInvocation(db: CoreDatabase, id: string, input: CompleteToolInvocationInput): ToolInvocationRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM tool_invocations WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `tool invocation '${id}' not found`);
    if (existing.status !== 'pending') {
      throw new CoreError('invalid_transition', `tool invocation '${id}' is already resolved (${existing.status})`);
    }
    const now = nowIso();
    db.run('UPDATE tool_invocations SET status = ?, exitCode = ?, evidence = ?, endedAt = ? WHERE id = ?', [
      input.status,
      input.exitCode ?? null,
      bounded(input.evidence),
      now,
      id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'tool_invocation',
      entityId: id,
      eventType: 'tool_invocation_completed',
      actor: input.actor,
      clientId: input.clientId,
      metadata: {
        attemptId: String(existing.attemptId),
        status: input.status,
        exitCode: input.exitCode ?? null,
        evidence: eventEvidence(input.evidence),
      },
    });
    return getToolInvocation(db, id);
  });
}

export function listToolInvocationsForAttempt(db: CoreDatabase, attemptId: string): ToolInvocationRecord[] {
  const rows = db.all<Record<string, unknown>>('SELECT * FROM tool_invocations WHERE attemptId = ? ORDER BY startedAt ASC, rowid ASC', [attemptId]);
  return rows.map(rowToInvocation);
}
