/**
 * Unified activity view of Panda bridge tasks. No new store: every field is read from the bridge's own task record, its
 * checkpoints, the attempt (native executor) or the work mirrored from Kandev (ACP executors), and the model-call tracker.
 *
 * State is derived from backend facts, never from "it has been a while":
 *  - queued / waiting for executor: the task has no running work yet (its recorded status says so);
 *  - waiting for model/GPU: a model call for this attempt is in flight and has produced no token yet (loading the model or
 *    queued behind other calls), or the ACP coordinator reports it is waiting for a free worker slot;
 *  - waiting for approval: the attempt/worker is blocked on an approval;
 *  - stalled: work is recorded as running but the worker's ownership lease has expired (native) or the executor reported no
 *    activity at all for STALL_MS while no model call is legitimately in flight. The heartbeat age is always shown with it.
 */
import type { CoreDatabase } from '../../db/connection';
import { getAttempt } from '../../domain/attempts';
import { listCheckpoints, type BridgeTaskRecord } from '../../domain/pandaBridge';
import { pendingApproval } from '../../domain/bridgeApprovals';
import { modelCallTracker, type ModelWait } from '../modelCallTracker';

export type ExecutionState =
  | 'queued' | 'waiting_for_executor' | 'waiting_for_model' | 'running' | 'waiting_for_approval' | 'stalled'
  | 'completed' | 'failed' | 'cancelled' | 'paused' | 'needs_attention';

export const STATE_LABEL: Record<ExecutionState, string> = {
  queued: 'Queued', waiting_for_executor: 'Waiting for executor', waiting_for_model: 'Waiting for model/GPU', running: 'Running',
  waiting_for_approval: 'Waiting for approval', stalled: 'Stalled', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled',
  paused: 'Paused', needs_attention: 'Needs attention',
};

/** Executor activity silent for this long, with no legitimate wait in progress, is reported as stalled (with the heartbeat age). */
export const STALL_MS = 5 * 60_000;
/** A model call with no first token for this long is no longer a normal wait (cold load, queue): it is reported as stalled. */
export const MODEL_WAIT_STALL_MS = 20 * 60_000;

export interface ActivitySignals {
  now: number;
  task: Pick<BridgeTaskRecord, 'status' | 'executor' | 'control' | 'updatedAt' | 'statusDetail' | 'result'>;
  /** Native executor only. */
  attempt?: { status: string; updatedAt: string; claimExpiresAt: string | null } | null;
  model?: ModelWait | null;
  /** The ACP coordinator's own phase for the story behind the task, when it reported one. */
  storyWaitingForSlot?: boolean;
  /** Latest time anything was observed from the executor (ms epoch). */
  lastActivityAt?: number | null;
  /** A cloud agent was requested and the owner has not decided yet: its name. */
  approvalFor?: string | null;
}

export interface DerivedState { state: ExecutionState; reason: string; heartbeatAt: number | null; heartbeatAgeMs: number | null }

const ms = (iso: string | null | undefined) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const secs = (n: number) => (n >= 120_000 ? `${Math.round(n / 60_000)} min` : `${Math.round(n / 1000)} s`);

export function deriveExecutionState(sig: ActivitySignals): DerivedState {
  const { task, now } = sig;
  const beats = [ms(task.updatedAt), sig.lastActivityAt ?? null, sig.model?.lastActivityAt ?? null, ms(sig.attempt?.updatedAt)].filter((x): x is number => x !== null);
  const heartbeatAt = beats.length ? Math.max(...beats) : null;
  const age = heartbeatAt === null ? null : Math.max(0, now - heartbeatAt);
  const done = (state: ExecutionState, reason: string): DerivedState => ({ state, reason, heartbeatAt, heartbeatAgeMs: age });

  switch (task.status) {
    case 'completed': return done('completed', task.statusDetail ?? 'Finished.');
    case 'failed': return done('failed', task.statusDetail ?? 'Failed.');
    case 'cancelled': return done('cancelled', task.statusDetail ?? 'Cancelled.');
    case 'paused': return done('paused', task.statusDetail ?? 'Paused.');
    case 'needs_attention': return done('needs_attention', task.statusDetail ?? 'Needs attention in Pandesh.');
    case 'awaiting_approval': return done('waiting_for_approval', task.statusDetail ?? 'Waiting for your approval in Pandesh.');
    case 'received': return done('queued', 'Received; not yet routed.');
    case 'awaiting_executor':
      if (sig.approvalFor) return done('waiting_for_approval', `Waiting for your approval in Pandesh to send this task to ${sig.approvalFor}. Nothing has been sent.`);
      return done('waiting_for_executor', 'Received. Choose an executor to start the work.');
    case 'dispatching': return done('queued', task.statusDetail ?? `Starting ${task.executor ?? 'the executor'}.`);
    default: break; // running / verifying
  }

  // Running (or verifying): find out what it is really doing.
  if (sig.attempt) {
    const a = sig.attempt;
    if (a.status === 'created' || a.status === 'queued') return done('queued', 'The attempt is queued in Core.');
    if (a.status === 'waiting_for_approval') return done('waiting_for_approval', 'Waiting for your approval in Pandesh.');
    if (a.status === 'running') {
      const lease = ms(a.claimExpiresAt);
      if (lease !== null && lease < now) return done('stalled', `No worker holds this attempt: its ownership lease expired ${secs(now - lease)} ago.`);
    }
  }
  const m = sig.model;
  if (m?.awaitingFirstToken) {
    const others = m.othersInFlight ? ` ${m.othersInFlight} other model call${m.othersInFlight === 1 ? '' : 's'} in flight.` : '';
    if (m.inFlightMs > MODEL_WAIT_STALL_MS) return done('stalled', `The model call has produced no token for ${secs(m.inFlightMs)}.${others}`);
    return done('waiting_for_model', `Waiting for the model: call in flight for ${secs(m.inFlightMs)} with no output yet (loading the model or queued behind other work).${others}`);
  }
  if (sig.storyWaitingForSlot) return done('waiting_for_model', /local GPU lane/i.test(task.statusDetail ?? '') ? 'Queued for the local GPU: one GPU job runs at a time.' : 'Waiting for a free worker slot (local model capacity).');
  if (age !== null && age > STALL_MS && !m?.inFlight) return done('stalled', `No activity from the executor for ${secs(age)}.`);
  return done('running', task.statusDetail ?? 'Working.');
}

export interface ActivityItem {
  id: string;
  origin: { kind: 'chatgpt' | 'workflow' | 'jugaad'; client: string; title: string | null; url: string | null; via: string | null };
  instruction: string;
  executor: string | null;
  model: string | null;
  routing: 'explicit' | 'auto' | null;
  state: ExecutionState;
  stateLabel: string;
  reason: string;
  progress: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  /** Active time: from the start of the work to now (or to its end). Not time since the request was queued. */
  elapsedMs: number | null;
  lastHeartbeatAt: string | null;
  heartbeatAgeMs: number | null;
  verification: string | null;
  conversationId: string | null;
  openTarget: { conversationId: string } | null;
  /** The worker's newest observed event (Kandev message), not Core's own bookkeeping. */
  latest: { at: string; kind: string; text: string } | null;
  /** Time of that event: what "last event N s ago" is measured from. Core's own writes never move it. */
  lastEventAt: string | null;
  /** How many worker events are recorded for this task (the full log is on GET /v1/bridge/tasks/:id). */
  eventCount: number;
  branch: string | null;
  /** Actions the worker is waiting on (answered from the Pandesh window only). */
  pendingWorkerActions: Array<{ pendingId: string; what: string }>;
  storyId: string | null;
  /**
   * A5 code change: waiting for the owner's review (with the files it changed), or done and ready to be brought into the owner's
   * checkout as a new branch (or already delivered). Null for every other task.
   */
  codeChange: { project: string; baseRef: string; awaitingReview: boolean; changedFiles: string[]; deliverable: boolean; delivered: { branch: string; commit: string } | null } | null;
  /** What happened to the requested outcome, as Core recorded it (never the worker's claim). Null before the work is mirrored. */
  outcome: { intent: string; state: string; summary: string } | null;
}

export function activityItem(db: CoreDatabase, task: BridgeTaskRecord, clientLabel: string, now = Date.now()): ActivityItem {
  const running = ['dispatching', 'running', 'verifying', 'awaiting_approval', 'needs_attention', 'paused'].includes(task.status);
  let attempt: ActivitySignals['attempt'] = null;
  let model: ModelWait | null = null;
  if (running && task.attemptId) {
    try { const a = getAttempt(db, task.attemptId); attempt = { status: a.status, updatedAt: a.updatedAt, claimExpiresAt: a.claimExpiresAt }; model = modelCallTracker.snapshot(task.attemptId, now); }
    catch { attempt = null; }
  }
  const result = task.result;
  const lastActivityAt = Math.max(0, ...(result?.activity ?? []).map(a => ms(a.at) ?? 0), ...(result?.timeline ?? []).map(t => ms(t.at) ?? 0)) || null;
  // Queued for a worker slot or for the local GPU lane is a legitimate wait, never "stalled" (live 2026-11-21: a task queued
  // behind another OpenCode run on the one GPU lane was labelled Stalled after five minutes).
  const storyWaitingForSlot = running && Boolean(task.storyId) && /free worker slot|local GPU lane/i.test(task.statusDetail ?? '');
  const approvalFor = task.status === 'awaiting_executor' ? pendingApproval(db, task.id, now)?.agentLabel ?? null : null;
  const d = deriveExecutionState({ now, task, attempt, model, storyWaitingForSlot, lastActivityAt, approvalFor });

  const workflowStep = /^(wf-|wfrun)/.test(task.clientRequestId);
  // A phone's document upload is not a ChatGPT message: say what it is and keep the household id and file name out of the line.
  const jugaadIntake = /^(intake|reprocess):hh_/.test(task.clientRequestId);
  const cps = listCheckpoints(db, task.id);
  const start = cps.find(c => c.status === 'dispatching') ?? null;
  const startedMs = ms(start?.createdAt);
  const endMs = ms(task.completedAt);
  const latest = result?.activity?.length ? result.activity[result.activity.length - 1] : null;
  return {
    id: task.id,
    // Steps a workflow created for itself are shown as steps, with the service that ran them, not as the raw JSON arguments they carry.
    origin: { kind: jugaadIntake ? 'jugaad' : workflowStep ? 'workflow' : 'chatgpt', client: jugaadIntake ? 'JUGAAD phone' : clientLabel, title: task.sourceRef.title ?? null, url: task.sourceRef.url ?? null, via: jugaadIntake ? null : task.sourceRef.via ?? null },
    instruction: jugaadIntake ? (task.clientRequestId.startsWith('reprocess:') ? 'JUGAAD document reprocess' : 'JUGAAD document intake') : workflowStep ? `Workflow step · ${task.executor ?? 'not started'}` : task.instruction.slice(0, 500),
    executor: task.executor, model: task.model, routing: task.routing,
    state: d.state, stateLabel: STATE_LABEL[d.state], reason: d.reason,
    progress: latest ? latest.text.slice(0, 200) : null,
    createdAt: task.createdAt, startedAt: start?.createdAt ?? null, completedAt: task.completedAt,
    elapsedMs: startedMs === null ? null : Math.max(0, (endMs ?? now) - startedMs),
    lastHeartbeatAt: d.heartbeatAt === null ? null : new Date(d.heartbeatAt).toISOString(), heartbeatAgeMs: d.heartbeatAgeMs,
    verification: result?.verification ?? null,
    conversationId: task.conversationId,
    openTarget: task.conversationId ? { conversationId: task.conversationId } : null,
    latest: latest ? { at: latest.at, kind: latest.kind, text: latest.text.slice(0, 300) } : null,
    lastEventAt: latest?.at ?? null,
    eventCount: result?.activity?.length ?? 0,
    branch: result?.branch ?? null,
    pendingWorkerActions: running && task.status === 'awaiting_approval' ? (result?.pendingApprovals ?? []) : [],
    storyId: task.storyId,
    codeChange: result?.codeChange ? {
      project: result.codeChange.project, baseRef: result.codeChange.baseRef,
      // "The work is ready; review and approve it" (no worker action pending) is the review gate; a held worker action is not.
      awaitingReview: task.status === 'awaiting_approval' && !(result.pendingApprovals ?? []).length,
      changedFiles: result.changedFiles ?? [],
      deliverable: task.status === 'completed' && !result.codeChange.delivered,
      delivered: result.codeChange.delivered ? { branch: result.codeChange.delivered.branch, commit: result.codeChange.delivered.commit } : null,
    } : null,
    outcome: result?.outcome ? { intent: result.outcome.intent, state: result.outcome.state, summary: result.outcome.summary } : null,
  };
}
