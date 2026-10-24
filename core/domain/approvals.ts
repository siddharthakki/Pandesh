import type { CoreDatabase } from '../db/connection';
import * as crypto from 'node:crypto';
import type { ApprovalRecord, ApprovalKind, ApprovalStatus, AttemptStatus } from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { recordRuntimeEvent } from './runtimeEvents';
import { getAttemptContext } from './attemptContext';
import { isTerminalAttemptStatus } from './attemptTransitions';
import { canonicalArgumentsDigest, canonicalJson, MAX_APPROVAL_ACTION_ARGUMENTS_BYTES } from './approvalArguments';

const MAX_SUMMARY_BYTES = 8192;
/** The proposal-time presentation (a bounded diff) is rendering, not
 * authority, so it is bounded separately from — and never merged into — the
 * digest-bearing summary. */
const MAX_PRESENTATION_BYTES = 32768;
const APPROVAL_ENVELOPE_VERSION = 1;

function requestedActionDigest(action: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(action), 'utf8').digest('hex');
}

function boundedSummary(summary: Record<string, unknown> | undefined): string {
  const json = JSON.stringify(summary ?? {});
  if (Buffer.byteLength(json, 'utf8') > MAX_SUMMARY_BYTES) {
    throw new CoreError('invalid_request', `approval summary exceeds ${MAX_SUMMARY_BYTES} bytes`);
  }
  return json;
}

function boundedPresentation(presentation: Record<string, unknown> | undefined): string | null {
  if (!presentation) return null;
  const json = JSON.stringify(presentation);
  if (Buffer.byteLength(json, 'utf8') > MAX_PRESENTATION_BYTES) {
    throw new CoreError('invalid_request', `approval presentation exceeds ${MAX_PRESENTATION_BYTES} bytes`);
  }
  return json;
}

function eventArguments(summary: Record<string, unknown>): Record<string, unknown> | null {
  const args = summary.arguments;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const record = { ...(args as Record<string, unknown>) };
  if (typeof record.content === 'string') {
    record.content = `<${Buffer.byteLength(record.content, 'utf8')} bytes>`;
  }
  return record;
}

function approvalAuditMetadata(
  summary: Record<string, unknown>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    attemptId: extra.attemptId ?? null,
    kind: extra.kind ?? null,
    toolName: summary.toolName ?? null,
    normalizedArguments: eventArguments(summary) ?? summary.arguments ?? null,
    requestedCommand: summary.requestedCommand ?? null,
    requestedPath: summary.requestedPath ?? null,
    policyDecision: extra.policyDecision ?? summary.policyDecision ?? null,
    policyReason: extra.policyReason ?? summary.policyReason ?? null,
    actor: extra.actor ?? null,
    requestedActor: extra.requestedActor ?? null,
    resolution: extra.resolution ?? null,
  };
}

function rowToApproval(row: Record<string, unknown>): ApprovalRecord {
  return {
    id: String(row.id),
    attemptId: String(row.attemptId),
    kind: row.kind as ApprovalKind,
    status: row.status as ApprovalStatus,
    requestedAt: String(row.requestedAt),
    resolvedAt: (row.resolvedAt as string) ?? null,
    resolution: (row.resolution as 'approved' | 'rejected') ?? null,
    summary: JSON.parse(String(row.summary ?? '{}')),
    presentation: row.presentation === null || row.presentation === undefined
      ? null
      : JSON.parse(String(row.presentation)) as Record<string, unknown>,
    claimOwner: (row.claimOwner as string) ?? null,
    claimExpiresAt: (row.claimExpiresAt as string) ?? null,
    envelopeVersion: Number(row.envelopeVersion),
    expectedAttemptRevision: Number(row.expectedAttemptRevision),
    expectedAttemptStatus: row.expectedAttemptStatus as AttemptStatus,
    requestedActionDigest: String(row.requestedActionDigest),
    frozenContextHash: String(row.frozenContextHash),
    revision: Number(row.revision),
  };
}

export function getApproval(db: CoreDatabase, id: string): ApprovalRecord {
  const row = db.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `approval '${id}' not found`);
  return rowToApproval(row);
}

/**
 * Retires a pending approval that nobody answered.
 *
 * This is deliberately NOT a rejection: nobody decided anything. The row stays
 * auditable as `expired` with its reason, so no client (and no assistant) can
 * later read a "the user refused" story that never happened, and the card stops
 * being actionable. Idempotent: an approval that is already resolved is
 * returned unchanged.
 */
export function expireApproval(
  db: CoreDatabase,
  id: string,
  input: { actor: string; clientId?: string | null; reason?: string },
): ApprovalRecord {
  return db.transaction(() => {
    const existing = db.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `approval '${id}' not found`);
    if (existing.status !== 'pending') return getApproval(db, id);
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run(`UPDATE approvals SET status = 'expired', resolvedAt = ?, revision = ? WHERE id = ?`, [now, newRevision, id]);
    recordRuntimeEvent(db, {
      domain: 'approval',
      entityId: id,
      eventType: 'approval_expired',
      actor: input.actor,
      clientId: input.clientId,
      metadata: { reason: input.reason ?? 'no answer was recorded for this approval request' },
      resultingRevision: newRevision,
    });
    return getApproval(db, id);
  });
}

/**
 * The canonical full action arguments an approval authorizes. Verified against
 * the summary's immutable `argumentsDigest`; a legacy row (no stored payload)
 * carries its full arguments inline in the summary.
 */
export function getApprovalActionArguments(db: CoreDatabase, approvalId: string): Record<string, unknown> {
  const row = db.get<{ summary: string | null; actionArgumentsJson: string | null }>(
    'SELECT summary, actionArgumentsJson FROM approvals WHERE id = ?',
    [approvalId],
  );
  if (!row) throw new CoreError('not_found', `approval '${approvalId}' not found`);
  const summary = JSON.parse(String(row.summary ?? '{}')) as Record<string, unknown>;
  if (row.actionArgumentsJson === null || row.actionArgumentsJson === undefined) {
    if (typeof summary.argumentsDigest === 'string') {
      throw new CoreError('context_mismatch', `approval '${approvalId}' is missing its digest-bound action arguments`);
    }
    return ((summary.arguments ?? {}) as Record<string, unknown>);
  }
  const args = JSON.parse(row.actionArgumentsJson) as Record<string, unknown>;
  if (canonicalArgumentsDigest(args) !== summary.argumentsDigest) {
    throw new CoreError('context_mismatch', `approval '${approvalId}' action arguments no longer match their digest`);
  }
  return args;
}

export interface CreateApprovalInput {
  attemptId: string;
  kind: ApprovalKind;
  summary?: Record<string, unknown>;
  /** Immutable, proposal-time rendering of this action (e.g. the bounded
   * `write_file` unified diff). Never part of `requestedActionDigest`: it is
   * what the human was shown, not what authorizes the mutation. */
  presentation?: Record<string, unknown>;
  /** The canonical full arguments behind a summary whose bulk fields were
   * projected. Required to match `summary.argumentsDigest`; policy, mission
   * authorization and execution read these, never the projected summary. */
  actionArguments?: Record<string, unknown>;
  actor: string;
  clientId?: string | null;
  /** Core policy denials are recorded as already-rejected so a client cannot approve them.
   * Hands-off Mission V1 records in-scope mutations as already-approved by `core:policy`. */
  initialResolution?: 'rejected' | 'approved';
  /** Actor recorded on the terminal resolve event when `initialResolution` is set. */
  resolvedBy?: string;
}

/**
 * Creates a pending approval. Superseding any prior pending approval of the same
 * kind for this attempt keeps the "exactly one actionable approval per attempt"
 * guarantee (docs/m32-architecture.md RECOVERY section) — a re-proposal after
 * revision replaces the stale card rather than leaving two live ones.
 */
export function createApproval(db: CoreDatabase, input: CreateApprovalInput): ApprovalRecord {
  return db.transaction(() => {
    if (input.kind !== 'proposal' && input.kind !== 'mutation' && input.kind !== 'delivery') {
      throw new CoreError('invalid_request', `approval gate '${String(input.kind)}' is invalid`);
    }
    const attempt = db.get<{ id: string; revision: number; status: AttemptStatus }>(
      'SELECT id, revision, status FROM attempts WHERE id = ?',
      [input.attemptId],
    );
    if (!attempt) throw new CoreError('invalid_request', `attempt '${input.attemptId}' does not exist`);
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new CoreError('invalid_transition', `attempt '${input.attemptId}' is terminal; approval cannot be requested`);
    }
    const context = getAttemptContext(db, input.attemptId);
    const summary = input.summary ?? {};
    let actionArgumentsJson: string | null = null;
    if (input.actionArguments) {
      if (summary.argumentsDigest !== canonicalArgumentsDigest(input.actionArguments)) {
        throw new CoreError('invalid_request', 'approval action arguments do not match the summary digest');
      }
      actionArgumentsJson = JSON.stringify(input.actionArguments);
      if (Buffer.byteLength(actionArgumentsJson, 'utf8') > MAX_APPROVAL_ACTION_ARGUMENTS_BYTES) {
        throw new CoreError('invalid_request', `approval action arguments exceed ${MAX_APPROVAL_ACTION_ARGUMENTS_BYTES} bytes`);
      }
    }

    const stalePending = db.all<{ id: string; revision: number }>(
      `SELECT id, revision FROM approvals WHERE attemptId = ? AND kind = ? AND status = 'pending'`,
      [input.attemptId, input.kind],
    );
    const now = nowIso();
    for (const stale of stalePending) {
      const newRev = stale.revision + 1;
      db.run(`UPDATE approvals SET status = 'superseded', resolvedAt = ?, revision = ? WHERE id = ?`, [now, newRev, stale.id]);
      recordRuntimeEvent(db, {
        domain: 'approval',
        entityId: stale.id,
        eventType: 'approval_superseded',
        actor: input.actor,
        clientId: input.clientId,
        resultingRevision: newRev,
      });
    }

    const id = newId('appr');
    const denied = input.initialResolution === 'rejected';
    const preApproved = input.initialResolution === 'approved';
    db.run(
      `INSERT INTO approvals (
         id, attemptId, kind, status, requestedAt, resolvedAt, resolution, summary, envelopeVersion,
         expectedAttemptRevision, expectedAttemptStatus, requestedActionDigest,
         frozenContextHash, revision, presentation, actionArgumentsJson
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      [
        id,
        input.attemptId,
        input.kind,
        denied ? 'rejected' : preApproved ? 'approved' : 'pending',
        now,
        denied || preApproved ? now : null,
        denied ? 'rejected' : preApproved ? 'approved' : null,
        boundedSummary(summary),
        APPROVAL_ENVELOPE_VERSION,
        attempt.revision,
        attempt.status,
        requestedActionDigest(summary),
        context.contextHash,
        boundedPresentation(input.presentation),
        actionArgumentsJson,
      ],
    );
    recordRuntimeEvent(db, {
      domain: 'approval',
      entityId: id,
      eventType: 'approval_requested',
      actor: input.actor,
      clientId: input.clientId,
      metadata: approvalAuditMetadata(summary, {
        attemptId: input.attemptId,
        kind: input.kind,
        actor: input.actor,
        policyDecision: denied ? 'denied' : preApproved ? 'auto_authorize' : (summary.policyDecision ?? 'review_required'),
        policyReason: summary.policyReason ?? null,
      }),
      resultingRevision: 1,
    });
    if (denied || preApproved) {
      recordRuntimeEvent(db, {
        domain: 'approval',
        entityId: id,
        eventType: 'approval_resolved',
        actor: input.resolvedBy ?? input.actor,
        clientId: input.clientId,
        metadata: approvalAuditMetadata(summary, {
          attemptId: input.attemptId,
          kind: input.kind,
          actor: input.resolvedBy ?? input.actor,
          requestedActor: input.actor,
          policyDecision: denied ? 'denied' : 'auto_authorize',
          policyReason: summary.policyReason ?? null,
          resolution: denied ? 'rejected' : 'approved',
        }),
        resultingRevision: 1,
      });
    }
    return getApproval(db, id);
  });
}

export interface ResolveApprovalInput {
  resolution: 'approved' | 'rejected';
  attemptId: string;
  gate: ApprovalKind;
  expectedAttemptRevision: number;
  expectedAttemptStatus: AttemptStatus;
  requestedActionDigest: string;
  frozenContextHash: string;
  expectedRevision?: number;
  actor: string;
  clientId?: string | null;
  idempotencyKey?: string | null;
  policyDecision?: string;
  policyReason?: string;
  requestedActor?: string;
}

/** Resolves a decision only while its complete durable envelope still matches. */
export function resolveApproval(db: CoreDatabase, id: string, input: ResolveApprovalInput): ApprovalRecord {
  return db.transaction(() => {
    if (input.resolution !== 'approved' && input.resolution !== 'rejected') {
      throw new CoreError('invalid_request', `approval resolution '${String(input.resolution)}' is invalid`);
    }
    const existing = db.get<Record<string, unknown>>('SELECT * FROM approvals WHERE id = ?', [id]);
    if (!existing) throw new CoreError('not_found', `approval '${id}' not found`);
    if (existing.status !== 'pending') {
      throw new CoreError('conflict', `approval '${id}' is already resolved or no longer actionable`);
    }
    if (String(existing.attemptId) !== input.attemptId) throw new CoreError('invalid_request', `approval '${id}' attempt mismatch`);
    if (String(existing.kind) !== input.gate) throw new CoreError('invalid_request', `approval '${id}' gate mismatch`);
    if (input.expectedRevision !== undefined && Number(existing.revision) !== input.expectedRevision) {
      throw new CoreError('revision_mismatch', `approval '${id}' revision mismatch`);
    }
    if (
      Number(existing.expectedAttemptRevision) !== input.expectedAttemptRevision ||
      String(existing.expectedAttemptStatus) !== input.expectedAttemptStatus
    ) {
      throw new CoreError('revision_mismatch', `approval '${id}' lifecycle envelope mismatch`);
    }
    if (String(existing.requestedActionDigest) !== input.requestedActionDigest) {
      throw new CoreError('invalid_request', `approval '${id}' requested-action digest mismatch`);
    }
    if (String(existing.frozenContextHash) !== input.frozenContextHash) {
      throw new CoreError('context_mismatch', `approval '${id}' frozen-context hash mismatch`);
    }
    const attempt = db.get<{ revision: number; status: AttemptStatus }>('SELECT revision, status FROM attempts WHERE id = ?', [input.attemptId]);
    if (!attempt) throw new CoreError('invalid_request', `attempt '${input.attemptId}' does not exist`);
    if (isTerminalAttemptStatus(attempt.status)) {
      throw new CoreError('invalid_transition', `attempt '${input.attemptId}' is terminal; approval cannot be resolved`);
    }
    if (attempt.revision !== input.expectedAttemptRevision || attempt.status !== input.expectedAttemptStatus) {
      throw new CoreError('revision_mismatch', `approval '${id}' is stale for attempt '${input.attemptId}'`);
    }
    if (getAttemptContext(db, input.attemptId).contextHash !== input.frozenContextHash) {
      throw new CoreError('context_mismatch', `approval '${id}' no longer matches the attempt context`);
    }
    const now = nowIso();
    const newRevision = Number(existing.revision) + 1;
    db.run(`UPDATE approvals SET status = ?, resolution = ?, resolvedAt = ?, revision = ? WHERE id = ?`, [
      input.resolution === 'approved' ? 'approved' : 'rejected',
      input.resolution,
      now,
      newRevision,
      id,
    ]);
    recordRuntimeEvent(db, {
      domain: 'approval',
      entityId: id,
      eventType: 'approval_resolved',
      actor: input.actor,
      clientId: input.clientId,
      idempotencyKey: input.idempotencyKey,
      metadata: approvalAuditMetadata(JSON.parse(String(existing.summary ?? '{}')) as Record<string, unknown>, {
        attemptId: input.attemptId,
        kind: existing.kind,
        actor: input.actor,
        requestedActor: input.requestedActor ?? input.actor,
        policyDecision: input.policyDecision ?? (input.resolution === 'approved' ? 'approved' : 'denied'),
        policyReason: input.policyReason ?? null,
        resolution: input.resolution,
      }),
      resultingRevision: newRevision,
    });
    return getApproval(db, id);
  });
}

export function listApprovalsForAttempt(db: CoreDatabase, attemptId: string): ApprovalRecord[] {
  const rows = db.all<Record<string, unknown>>('SELECT * FROM approvals WHERE attemptId = ? ORDER BY requestedAt ASC, rowid ASC', [attemptId]);
  return rows.map(rowToApproval);
}

export function listPendingApprovals(db: CoreDatabase): ApprovalRecord[] {
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM approvals WHERE status = 'pending' ORDER BY requestedAt ASC`);
  return rows.map(rowToApproval);
}

/**
 * Reconciles and expires any pending approvals belonging to an attempt that has
 * reached a terminal state (completed, failed, cancelled). Terminal attempts can
 * never have approvals resolved, so pending approvals are retired as 'expired'
 * with an audit event, ensuring they never present active buttons or deadlock.
 */
export function expirePendingApprovalsForAttempt(
  db: CoreDatabase,
  attemptId: string,
  input: { actor: string; clientId?: string | null; reason?: string },
): ApprovalRecord[] {
  return db.transaction(() => {
    const pendingRows = db.all<{ id: string; revision: number; summary: string; kind: ApprovalKind }>(
      `SELECT id, revision, summary, kind FROM approvals WHERE attemptId = ? AND status = 'pending'`,
      [attemptId],
    );
    if (pendingRows.length === 0) return [];
    const now = nowIso();
    const updated: ApprovalRecord[] = [];
    for (const row of pendingRows) {
      const newRevision = Number(row.revision) + 1;
      db.run(
        `UPDATE approvals SET status = 'expired', resolvedAt = ?, revision = ? WHERE id = ?`,
        [now, newRevision, row.id],
      );
      recordRuntimeEvent(db, {
        domain: 'approval',
        entityId: row.id,
        eventType: 'approval_expired',
        actor: input.actor,
        clientId: input.clientId,
        metadata: approvalAuditMetadata(JSON.parse(row.summary || '{}'), {
          attemptId,
          kind: row.kind,
          actor: input.actor,
          policyDecision: 'expired',
          policyReason: input.reason ?? 'attempt reached terminal state',
          status: 'expired',
        }),
        resultingRevision: newRevision,
      });
      updated.push(getApproval(db, row.id));
    }
    return updated;
  });
}

