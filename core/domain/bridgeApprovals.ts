/**
 * Approval of external-agent execution for a relayed task. A paired browser can ask for a cloud agent (Claude Code, ...) but can never
 * authorise it: the Pandesh app shows the owner exactly what would leave the PC, and only the owner's explicit decision starts it.
 *
 * Stored as events in the task's own checkpoint trail (`bridge_task_checkpoints`, append-only, time-stamped), so there is one audit trail
 * for the task and no new table. An approval is scoped: it names the executor, model, project, branch, access level and the SHA-256 of
 * the instruction it was granted for, and it expires. A refusal ends the task; nothing else is ever started in its place.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { nowIso } from './ids';

export const APPROVAL_TTL_MS = 30 * 60_000;
/** After the owner says yes, the start must follow promptly; an approval not used within this time is void (no stockpiled approvals). */
export const APPROVED_USE_TTL_MS = 5 * 60_000;

export interface ApprovalProject { name: string; branch: string; commit: string; access: 'read' | 'read-write'; uncommittedFiles: number }

export interface ExternalApprovalRequest {
  requestId: string; taskId: string;
  executor: string; agentLabel: string; provider: string; model: string | null;
  project: ApprovalProject | null;
  /** What the agent will be allowed to do, in words. */
  accessLevel: string;
  /** What leaves this PC, in words, one line each. */
  exposure: string[];
  instruction: string; instructionSha256: string;
  sensitivity: 'normal' | 'confidential'; sensitivityReasons: string[];
  includeContext: boolean;
  requestedBy: string; requestedAt: string; expiresAt: string;
}

export type ApprovalEventKind = 'requested' | 'approved' | 'refused' | 'expired' | 'superseded' | 'consumed';
export interface ApprovalEvent {
  event: ApprovalEventKind; requestId: string; at: string; by: string;
  /** Approved: exactly what was authorised. */
  scope?: { executor: string; model: string | null; project: string | null; branch: string | null; commit?: string | null; access: string; instructionSha256: string; confidentialOverride: boolean; includeContext: boolean };
  request?: ExternalApprovalRequest;
}

function write(db: CoreDatabase, taskId: string, status: 'awaiting_approval' | 'awaiting_executor' | 'dispatching', detail: string, ev: ApprovalEvent): void {
  db.run('INSERT INTO bridge_task_checkpoints (taskId, status, detail, snapshot, createdAt) VALUES (?, ?, ?, ?, ?)', [taskId, status, detail.slice(0, 500), JSON.stringify({ approval: ev }), ev.at]);
}

/** Every approval event of a task, oldest first: the audit trail for external execution. */
export function listApprovalEvents(db: CoreDatabase, taskId: string): ApprovalEvent[] {
  const rows = db.all<{ snapshot: string | null }>('SELECT snapshot FROM bridge_task_checkpoints WHERE taskId = ? AND snapshot LIKE \'{"approval":%\' ORDER BY id ASC', [taskId]);
  const out: ApprovalEvent[] = [];
  for (const r of rows) { try { const a = (JSON.parse(String(r.snapshot)) as { approval?: ApprovalEvent }).approval; if (a) out.push(a); } catch { /* not ours */ } }
  return out;
}

/** The request waiting for the owner, if any (not decided, not superseded, not expired). */
export function pendingApproval(db: CoreDatabase, taskId: string, now = Date.now()): ExternalApprovalRequest | null {
  const events = listApprovalEvents(db, taskId);
  const last = events[events.length - 1];
  if (!last || last.event !== 'requested' || !last.request) return null;
  return Date.parse(last.request.expiresAt) > now ? last.request : null;
}

/**
 * Closes a request that expired while nobody answered it (otherwise only a late decision would notice): records `expired` once and returns
 * the request, so the task can say that nothing was sent instead of "waiting for your approval" forever. Null when there is nothing to close.
 */
export function expireStaleApproval(db: CoreDatabase, taskId: string, now = Date.now()): ExternalApprovalRequest | null {
  const events = listApprovalEvents(db, taskId);
  const last = events[events.length - 1];
  if (!last || last.event !== 'requested' || !last.request || Date.parse(last.request.expiresAt) > now) return null;
  write(db, taskId, 'awaiting_executor', 'The approval request expired before it was decided; nothing was sent.', { event: 'expired', requestId: last.request.requestId, at: new Date(now).toISOString(), by: 'pandesh' });
  return last.request;
}

/** Records a new request for the task, superseding an older pending one (the owner only ever sees the latest scope). */
export function requestApproval(db: CoreDatabase, req: Omit<ExternalApprovalRequest, 'requestId' | 'requestedAt' | 'expiresAt'>, now = Date.now()): ExternalApprovalRequest {
  const prior = pendingApproval(db, req.taskId, now);
  const full: ExternalApprovalRequest = { ...req, requestId: `apr_${crypto.randomBytes(8).toString('hex')}`, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + APPROVAL_TTL_MS).toISOString() };
  db.transaction(() => {
    if (prior) write(db, req.taskId, 'awaiting_executor', 'A newer approval request replaced this one.', { event: 'superseded', requestId: prior.requestId, at: full.requestedAt, by: req.requestedBy });
    write(db, req.taskId, 'awaiting_approval', `Waiting for your approval in Pandesh to send this task to ${req.agentLabel}.`, { event: 'requested', requestId: full.requestId, at: full.requestedAt, by: req.requestedBy, request: full });
  });
  return full;
}

/** Withdraws the waiting request because the facts on its card changed; nothing was sent and the owner must ask again. */
export function withdrawApproval(db: CoreDatabase, taskId: string, requestId: string, why: string): void {
  write(db, taskId, 'awaiting_executor', `Approval request withdrawn: ${why}`.slice(0, 400), { event: 'expired', requestId, at: nowIso(), by: 'pandesh' });
}

export interface DecisionInput { taskId: string; requestId: string; decision: 'approve' | 'refuse'; by: string; confidentialOverride?: boolean }

/** Records the owner's decision on the pending request. Throws if there is none, it is not the one named, or it expired. */
export function decideApproval(db: CoreDatabase, input: DecisionInput, now = Date.now()): { request: ExternalApprovalRequest; event: ApprovalEvent } {
  const events = listApprovalEvents(db, input.taskId);
  const last = events[events.length - 1];
  if (!last || last.event !== 'requested' || !last.request) throw new CoreError('conflict', 'there is no approval request waiting for this task');
  const request = last.request;
  if (request.requestId !== input.requestId) throw new CoreError('conflict', 'this is not the approval request that is waiting; reload and look again');
  if (Date.parse(request.expiresAt) <= now) {
    write(db, input.taskId, 'awaiting_executor', 'The approval request expired before it was decided; nothing was sent.', { event: 'expired', requestId: request.requestId, at: new Date(now).toISOString(), by: 'pandesh' });
    throw new CoreError('conflict', 'this approval request expired; ask for it again from the browser');
  }
  const at = new Date(now).toISOString();
  if (input.decision === 'refuse') {
    const event: ApprovalEvent = { event: 'refused', requestId: request.requestId, at, by: input.by };
    write(db, input.taskId, 'awaiting_executor', `Refused by ${input.by}: nothing was sent to ${request.agentLabel}.`, event);
    return { request, event };
  }
  if (request.sensitivity === 'confidential' && input.confidentialOverride !== true) {
    throw new CoreError('forbidden', `This task looks confidential (${request.sensitivityReasons.join(', ')}). Approve it only with the separate confidential override.`, { reason: 'confidential_override_required' });
  }
  const event: ApprovalEvent = {
    event: 'approved', requestId: request.requestId, at, by: input.by,
    scope: { executor: request.executor, model: request.model, project: request.project?.name ?? null, branch: request.project?.branch ?? null, commit: request.project?.commit ?? null, access: request.accessLevel, instructionSha256: request.instructionSha256, confidentialOverride: input.confidentialOverride === true, includeContext: request.includeContext },
  };
  write(db, input.taskId, 'awaiting_executor', `Approved by ${input.by} for ${request.agentLabel} only.`, event);
  return { request, event };
}

/**
 * The approval a dispatch may use: an `approved` decision for exactly this request, recent, and not used before. Single use:
 * [consumeApproval] is recorded when the dispatch is claimed, so a replay (a retry of a failed start, a second dispatch, a copied request id)
 * finds it spent and needs a new approval.
 */
export function usableApproval(db: CoreDatabase, taskId: string, requestId: string, now = Date.now()): ApprovalEvent & { scope: NonNullable<ApprovalEvent['scope']> } {
  const events = listApprovalEvents(db, taskId);
  const ev = events.find(e => e.event === 'approved' && e.requestId === requestId);
  if (!ev?.scope) throw new CoreError('forbidden', 'there is no approval for this request; nothing was started');
  if (events.some(e => e.event === 'consumed' && e.requestId === requestId)) throw new CoreError('forbidden', 'this approval was already used; ask for a new one');
  if (now - Date.parse(ev.at) > APPROVED_USE_TTL_MS) throw new CoreError('forbidden', 'this approval was not used in time and is void; ask for a new one');
  return ev as ApprovalEvent & { scope: NonNullable<ApprovalEvent['scope']> };
}

export function consumeApproval(db: CoreDatabase, taskId: string, requestId: string, by: string): void {
  write(db, taskId, 'dispatching', 'The approval was used to start the task.', { event: 'consumed', requestId, at: nowIso(), by });
}

/** An owner-authorised external start that did not go through an approval card (the Pandesh app's own API): same audit event, same scope fields. */
export function recordDirectApproval(db: CoreDatabase, taskId: string, scope: NonNullable<ApprovalEvent['scope']>, by: string): void {
  write(db, taskId, 'awaiting_executor', `Approved by ${by} (direct authorisation, no approval card) for ${scope.executor} only.`, { event: 'approved', requestId: `direct_${crypto.randomBytes(6).toString('hex')}`, at: nowIso(), by, scope });
}

/** Tasks that have an approval waiting, newest request first. */
export function listPendingApprovals(db: CoreDatabase, now = Date.now()): ExternalApprovalRequest[] {
  const ids = db.all<{ taskId: string }>(`SELECT DISTINCT taskId FROM bridge_task_checkpoints WHERE status = 'awaiting_approval' AND snapshot LIKE '{"approval":%' ORDER BY id DESC LIMIT 100`).map(r => r.taskId);
  const out: ExternalApprovalRequest[] = [];
  for (const id of ids) {
    const task = db.get<{ status: string }>('SELECT status FROM bridge_tasks WHERE id = ?', [id]);
    if (task?.status !== 'awaiting_executor') continue;
    const p = pendingApproval(db, id, now);
    if (p) out.push(p);
  }
  return out.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
}

export function nowForApproval(): string { return nowIso(); }
