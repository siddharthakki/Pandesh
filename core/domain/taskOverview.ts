/**
 * Read-only projection of the durable attempt/request/runtime-event records for the Tasks screen.
 * No new state: every field is derived from rows Core already writes, so the view is the same
 * after a reconnect or a restart and never invents activity.
 */
import type { CoreDatabase } from '../db/connection';
import { isTerminalAttemptStatus } from './attemptTransitions';
import type { AttemptStatus } from '../shared/wireTypes';

export interface TaskOverviewRow {
  attemptId: string;
  requestId: string;
  conversationId: string | null;
  kind: string;
  status: AttemptStatus;
  title: string;
  provider: string | null;
  model: string | null;
  /** Which worker is (or was) doing the work, from the actor that wrote its events. */
  worker: string;
  /** What it is doing now (or did last), from its latest tool/step event. */
  activity: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  elapsedMs: number;
  lastEventAt: string | null;
  lastEventType: string | null;
  cancelRequestedAt: string | null;
  failureReason: string | null;
  /** True while a cancel can still be requested. */
  cancellable: boolean;
  /**
   * True only while a worker actually holds this attempt: the owning executor
   * holds an unexpired ownership lease (renewed by its heartbeat). A persisted
   * `running` status alone proves nothing — an attempt whose worker died stays
   * `running` in the database forever. This is the liveness proof the Tasks
   * screen must use before it claims anything is running.
   */
  live: boolean;
  /** The owning worker's lease expiry, when the attempt was ever claimed. */
  leaseExpiresAt: string | null;
  /** True when the attempt had an owner but the lease has expired: the worker
   * is gone and the attempt can no longer make progress. */
  interrupted: boolean;
}

const WORKER_LABELS: Array<[string, string]> = [
  ['karkedikha:opencode', 'OpenCode coding worker'],
  ['karkedikha:hermes', 'Hermes specialist'],
  ['karkedikha:pi', 'Pi assistant'],
  ['core:background_worker', 'Background extraction worker'],
];

const TOP_LEVEL_KINDS = ['baat_kar', 'saath_kar', 'karke_dikha'];

/**
 * Internal bookkeeping, not a user task.
 *
 * A governed capability dispatch parks its approval on a synthetic anchor
 * attempt (`ensureCapabilityAttempt`). That anchor is created with
 * `routeReason = 'm38_capability_dispatch'`, never runs a model, and is settled
 * by its owning attempt. It is not something the user asked for, so it must
 * never appear in the Tasks screen as a running task.
 */
const CAPABILITY_DISPATCH_ROUTE_REASON = 'm38_capability_dispatch';

function describeEvent(eventType: string, metadata: Record<string, unknown>): string {
  const tool = typeof metadata.toolName === 'string' ? metadata.toolName : '';
  switch (eventType) {
    case 'tool_call': return tool ? `Running ${tool}` : 'Running a tool';
    case 'tool_result': return tool ? `Finished ${tool}` : 'Finished a tool';
    case 'step_finish': return `Step ${String(metadata.status ?? 'finished')}`;
    case 'attempt_cancel_requested': return 'Stop requested — waiting for the worker to exit';
    case 'attempt_cancelled': return 'Stopped';
    case 'attempt_completed': return 'Completed';
    case 'attempt_failed': return 'Failed';
    case 'attempt_created': return 'Started';
    case 'attempt_transitioned': return 'State changed';
    default: return eventType.replace(/_/g, ' ');
  }
}

export function listTaskOverview(db: CoreDatabase, limit = 20, nowMs: number = Date.now()): TaskOverviewRow[] {
  const cap = Math.max(1, Math.min(limit, 100));
  const kinds = TOP_LEVEL_KINDS.map(() => '?').join(',');
  const select = `SELECT a.*, r.currentMessage AS currentMessage, r.conversationId AS conversationId,
      r.routeReason AS routeReason,
      c.selectedProvider AS selectedProvider, c.selectedModel AS selectedModel
    FROM attempts a
    JOIN requests r ON r.id = a.requestId
    LEFT JOIN attempt_contexts c ON c.attemptId = a.id
    WHERE a.parentAttemptId IS NULL AND a.kind IN (${kinds})
      AND r.routeReason IS NOT '${CAPABILITY_DISPATCH_ROUTE_REASON}'`;
  const recent = db.all<Record<string, unknown>>(`${select} ORDER BY a.updatedAt DESC LIMIT ?`, [...TOP_LEVEL_KINDS, cap]);
  // A long-running task must stay listed however many newer tasks exist.
  const active = db.all<Record<string, unknown>>(
    `${select} AND a.status NOT IN ('completed','failed','cancelled') ORDER BY a.updatedAt DESC LIMIT 50`,
    [...TOP_LEVEL_KINDS],
  );
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  for (const row of [...active, ...recent]) {
    const id = String(row.id);
    if (seen.has(id)) continue;
    seen.add(id);
    rows.push(row);
  }

  return rows.map((row) => {
    const attemptId = String(row.id);
    const status = String(row.status) as AttemptStatus;
    const terminal = isTerminalAttemptStatus(status);
    const last = db.get<{ eventType: string; createdAt: string; metadata: string }>(
      `SELECT eventType, createdAt, metadata FROM runtime_events
       WHERE domain = 'attempt' AND entityId = ? ORDER BY sequence DESC LIMIT 1`,
      [attemptId],
    );
    const lastWork = db.get<{ eventType: string; metadata: string }>(
      `SELECT eventType, metadata FROM runtime_events
       WHERE domain = 'attempt' AND entityId = ? AND eventType IN ('tool_call','tool_result','step_finish')
       ORDER BY sequence DESC LIMIT 1`,
      [attemptId],
    );
    const actors = db.all<{ actor: string }>(
      `SELECT DISTINCT actor FROM runtime_events WHERE domain = 'attempt' AND entityId = ?`,
      [attemptId],
    ).map((a) => a.actor);
    const worker = WORKER_LABELS.find(([actor]) => actors.includes(actor))?.[1] ?? 'Core assistant';
    // Liveness: the owning executor renews this lease every heartbeat, so an
    // unexpired lease is proof that a worker holds the attempt right now. An
    // expired lease (or a missing one) means nobody is working on it — the
    // persisted `running` status is a leftover, not a live task.
    const leaseExpiresAt = (row.claimExpiresAt as string | null) ?? null;
    const leaseMs = leaseExpiresAt ? Date.parse(leaseExpiresAt) : NaN;
    const leaseLive = Number.isFinite(leaseMs) && leaseMs > nowMs;
    const hadOwner = Boolean((row.claimOwner as string | null) ?? null);
    const live = !terminal && leaseLive;
    const interrupted = !terminal && hadOwner && !leaseLive;
    let activity: string;
    if (row.cancelRequestedAt && !terminal) activity = 'Stop requested — waiting for the worker to exit';
    else if (status === 'cancelled') activity = 'Stopped by you';
    else if (status === 'failed') activity = row.failureReason ? String(row.failureReason).slice(0, 160) : 'Failed';
    else if (status === 'completed') activity = 'Completed';
    else if (interrupted) activity = 'Interrupted — the worker stopped; this task is not running';
    else if (lastWork) {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(lastWork.metadata); } catch { /* keep empty */ }
      activity = describeEvent(lastWork.eventType, meta);
    } else activity = status === 'created' ? 'Queued — not started yet' : 'Working';

    const startedAt = (row.startedAt as string | null) ?? null;
    const endedAt = (row.completedAt as string | null) ?? (row.cancelledAt as string | null) ?? null;
    const startMs = Date.parse(startedAt ?? String(row.createdAt));
    // Elapsed time only moves while the task actually moves. A task whose
    // worker is gone must not keep counting hours of "runtime" it never spent.
    const frozenEndMs = last?.createdAt ? Date.parse(last.createdAt) : Date.parse(String(row.updatedAt));
    const endMs = terminal && endedAt
      ? Date.parse(endedAt)
      : live
        ? nowMs
        : (Number.isFinite(frozenEndMs) ? frozenEndMs : nowMs);
    return {
      attemptId,
      requestId: String(row.requestId),
      conversationId: (row.conversationId as string | null) ?? null,
      kind: String(row.kind),
      status,
      title: String(row.currentMessage ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
      provider: (row.selectedProvider as string | null) ?? null,
      model: (row.selectedModel as string | null) ?? null,
      worker,
      activity,
      createdAt: String(row.createdAt),
      startedAt,
      completedAt: endedAt,
      elapsedMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0,
      lastEventAt: last?.createdAt ?? null,
      lastEventType: last ? describeEvent(last.eventType, (() => { try { return JSON.parse(last.metadata); } catch { return {}; } })()) : null,
      cancelRequestedAt: (row.cancelRequestedAt as string | null) ?? null,
      failureReason: (row.failureReason as string | null) ?? null,
      cancellable: !terminal && !row.cancelRequestedAt,
      live,
      leaseExpiresAt,
      interrupted,
    };
  });
}
