/**
 * Jarvis Home: what got done, what is running, what needs the owner, what failed. Pure: derived only from Core's own records
 * (missions, Kandev bridge activity, bridge approvals, the task overview and the snapshot), so it is tested without a window.
 * Nothing here invents activity: an empty record gives an empty card, and "live" needs a real event inside LIVE_MS.
 */
import type { MissionView } from './missionModel';
import type { BridgeActivityItem, BridgeApproval } from './Missions';
import type { Snapshot, TaskRow } from './bridge';

/** A worker counts as visibly active only if its own newest event is this recent. */
export const LIVE_MS = 60_000;
/** Results and exceptions older than this leave Home (they stay in Missions › Board). */
export const RECENT_MS = 24 * 60 * 60_000;
/** A task no executor has picked up for this long is stuck, not "in flight" (seen on the scratch profile: days-old browser tasks). */
export const UNCLAIMED_MS = 30 * 60_000;
const UNCLAIMED_STATES = new Set(['waiting_for_executor', 'queued']);
const WAITING_STATES = new Set(['waiting_for_approval', 'waiting_for_model', 'waiting_for_executor', 'paused', 'queued']);

const BRIDGE_DONE = new Set(['completed', 'failed', 'cancelled']);
const TASK_DONE_OK = new Set(['completed', 'succeeded']);
const TASK_FAILED = new Set(['failed', 'recovery_required']);

export type HomeTarget = { kind: 'missions'; view?: 'flight' | 'board' | 'events'; id?: string } | { kind: 'chat'; conversationId: string | null };

export interface HomeItem {
  id: string; title: string; detail: string; source: string; at: string | null;
  /** Where the owner acts on it. */
  target: HomeTarget;
  /** A live bridge task Core can stop (bridgeCancel); offered for stuck tasks. */
  stopBridgeId?: string;
}
export interface DecisionItem extends HomeItem {
  /** How the decision is taken: some are answered on Home, the rest open where the full context is shown. */
  kind: 'chat_approval' | 'worker_permission' | 'mission_approval' | 'cloud_agent' | 'change_review';
  approvalId?: string; storyId?: string | null; pendingId?: string;
}
export interface InFlightItem extends HomeItem {
  engine: string; stateLabel: string; eventText: string;
  /** True only when the worker's own event is younger than LIVE_MS. */
  live: boolean;
}
export type PresenceState = 'idle' | 'thinking' | 'acting' | 'needs_you';

export interface HomeModel {
  ready: HomeItem[]; inFlight: InFlightItem[]; decisions: DecisionItem[]; exceptions: HomeItem[];
  /** True when nothing finished in the last day and `ready` holds the most recent older results instead. */
  readyIsOlder: boolean;
  presence: PresenceState; line: string; tag: string;
}

const ENGINES: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', hermes: 'Hermes' };
export const engineLabel = (e: string | null | undefined): string => (e ? ENGINES[e] ?? e : 'no executor yet');

function age(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
const recent = (at: string | null | undefined, now: number) => Boolean(at) && now - Date.parse(at as string) < RECENT_MS;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Last event 4 s ago", or plainly that the worker has been silent. Measured from the worker's own event, never Core's bookkeeping. */
export function eventLine(b: Pick<BridgeActivityItem, 'lastEventAt' | 'state' | 'latest'>, now: number): { text: string; live: boolean } {
  const at = b.lastEventAt ? Date.parse(b.lastEventAt) : NaN;
  if (!Number.isFinite(at)) return { text: 'no worker event yet', live: false };
  const ms = now - at;
  const what = b.latest ? ` · ${b.latest.kind.replace(/^tool_/, '').replace(/_/g, ' ')}` : '';
  // Finished work is history, not silence.
  if (BRIDGE_DONE.has(b.state)) return { text: `${b.state} · last event ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, live: false };
  // A worker that finished its turn and waits (for the owner, the GPU, a resume) is not stale telemetry: say what it waits for.
  if (WAITING_STATES.has(b.state)) return { text: `waiting ${age(ms)} · worker's last event ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, live: false };
  if (ms >= LIVE_MS) return { text: `no event for ${age(ms)} (stale)`, live: false };
  return { text: `last event ${age(ms)} ago${what}`, live: !BRIDGE_DONE.has(b.state) };
}

export interface HomeInputs {
  missions: MissionView[]; bridge: BridgeActivityItem[]; approvals: BridgeApproval[]; tasks: TaskRow[]; snapshot: Snapshot | null; now: number;
}

export function buildHome({ missions, bridge, approvals, tasks, snapshot, now }: HomeInputs): HomeModel {
  const ready: HomeItem[] = [];
  const inFlight: InFlightItem[] = [];
  const decisions: DecisionItem[] = [];
  const exceptions: HomeItem[] = [];

  // Decisions: every kind of owner approval Core is holding right now.
  const pa = snapshot?.pendingApproval;
  if (pa) decisions.push({ id: `chat:${pa.approvalId}`, kind: 'chat_approval', approvalId: pa.approvalId, title: `Pandesh asks to use ${pa.toolName}`, detail: [pa.detail, pa.paths.length ? `Paths: ${pa.paths.join(', ')}` : ''].filter(Boolean).join(' · '), source: `Chat · ${pa.scope}`, at: null, target: { kind: 'chat', conversationId: snapshot?.activeConversationId ?? snapshot?.selectedConversationId ?? null } });
  for (const a of approvals) decisions.push({ id: `cloud:${a.requestId}`, kind: 'cloud_agent', title: `Allow ${a.agentLabel} to work on this task?`, detail: a.instruction, source: `Browser · ${a.provider}`, at: a.requestedAt, target: { kind: 'missions', view: 'flight' } });
  for (const b of bridge) {
    for (const p of b.pendingWorkerActions ?? []) decisions.push({ id: `perm:${p.pendingId}`, kind: 'worker_permission', storyId: b.storyId, pendingId: p.pendingId, title: `${engineLabel(b.executor)} asks to: ${p.what}`, detail: b.instruction, source: engineLabel(b.executor), at: b.lastEventAt, target: { kind: 'missions', view: 'flight', id: b.id } });
    // Core's own outcome already holds Pandesh's before/after test run: the owner sees it before opening the diff.
    if (b.codeChange?.awaitingReview) decisions.push({ id: `change:${b.id}`, kind: 'change_review', title: `Review the change to ${b.codeChange.project}`, detail: b.outcome?.summary ?? `${plural(b.codeChange.changedFiles.length, 'file')} changed: ${b.codeChange.changedFiles.slice(0, 3).join(', ')}`, source: engineLabel(b.executor), at: b.lastEventAt, target: { kind: 'missions', view: 'flight', id: b.id } });
  }
  for (const m of missions) for (const a of m.pendingApprovals) decisions.push({ id: `mission:${a.approvalId}`, kind: 'mission_approval', approvalId: a.approvalId, title: a.agentName ? `${a.agentName} asks for your OK` : 'A mission asks for your OK', detail: a.text, source: 'Mission', at: a.requestedAt, target: { kind: 'missions', view: 'flight', id: m.id } });

  // In flight: Kandev workers and missions Core reports as running. Waiting states stay named as waiting.
  for (const b of bridge) {
    if (BRIDGE_DONE.has(b.state)) continue;
    const since = Date.parse(b.lastEventAt ?? b.createdAt);
    if (UNCLAIMED_STATES.has(b.state) && !b.lastEventAt && now - since >= UNCLAIMED_MS) {
      exceptions.push({ id: b.id, title: b.instruction, detail: `${b.stateLabel} since ${new Date(since).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}: no executor has picked it up.`, source: b.origin.kind === 'workflow' ? 'Workflow' : b.origin.client, at: b.createdAt, target: { kind: 'missions', view: 'flight', id: b.id }, stopBridgeId: b.id });
      continue;
    }
    const ev = eventLine(b, now);
    inFlight.push({ id: b.id, title: b.instruction, detail: b.reason, engine: engineLabel(b.executor), stateLabel: b.stateLabel, eventText: ev.text, live: ev.live && b.state === 'running', source: b.origin.kind === 'workflow' ? 'Workflow' : b.origin.client, at: b.lastEventAt, target: { kind: 'missions', view: 'flight', id: b.id } });
  }
  for (const m of missions) {
    if (m.status !== 'running') continue;
    const step = m.steps.find((s) => s.status === 'running');
    const hb = now - Date.parse(m.updatedAt);
    inFlight.push({ id: m.id, title: m.objective, detail: step ? step.title : 'between steps', engine: step ? (m.agentNames[step.agentId] ?? step.agentId) : 'Pandesh', stateLabel: m.pendingApprovals.length ? 'Waiting for your approval' : step ? 'Running' : 'Between steps', eventText: `last activity ${age(hb)} ago`, live: Boolean(step) && hb < LIVE_MS, source: 'Mission', at: m.updatedAt, target: { kind: 'missions', view: 'flight', id: m.id } });
  }

  // Ready: finished results with what was actually checked. Service sub-steps (service:*) are plumbing, not results.
  const finished: HomeItem[] = [];
  for (const m of missions) {
    if (m.status === 'completed' || m.status === 'completed_with_issues') {
      finished.push({ id: m.id, title: m.objective, detail: m.status === 'completed' ? 'Mission complete · checked' : 'Finished · points to check', source: 'Mission', at: m.completedAt ?? m.updatedAt, target: { kind: 'missions', view: 'flight', id: m.id } });
    }
  }
  for (const b of bridge) {
    if (b.state !== 'completed' || (b.executor ?? '').startsWith('service:')) continue;
    const checked = b.verification === 'independent' ? 'verified independently' : b.verification === 'human-reviewed' ? 'reviewed by a person' : 'worker’s own report, not independently verified';
    finished.push({ id: b.id, title: b.instruction, detail: b.outcome?.summary ?? `Finished · ${checked}`, source: engineLabel(b.executor), at: b.lastEventAt ?? b.createdAt, target: { kind: 'missions', view: 'flight', id: b.id } });
  }
  for (const t of tasks) {
    if (TASK_DONE_OK.has(t.status) && t.completedAt) finished.push({ id: t.attemptId, title: t.title, detail: 'Completed', source: t.worker || 'Task', at: t.completedAt, target: t.conversationId ? { kind: 'chat', conversationId: t.conversationId } : { kind: 'missions', view: 'board' } });
  }
  finished.sort((a, b) => (b.at ?? '').localeCompare(a.at ?? ''));
  ready.push(...finished.filter((f) => recent(f.at, now)));
  const readyIsOlder = !ready.length && finished.length > 0;
  if (readyIsOlder) ready.push(...finished.slice(0, 3));

  // Exceptions: what failed, stalled or was interrupted, with where to recover it.
  for (const b of bridge) {
    if ((b.state === 'failed' || b.state === 'stalled' || b.state === 'needs_attention') && recent(b.lastEventAt ?? b.createdAt, now)) exceptions.push({ id: b.id, title: b.instruction, detail: `${b.stateLabel}: ${b.reason}`, source: engineLabel(b.executor), at: b.lastEventAt ?? b.createdAt, target: { kind: 'missions', view: 'flight', id: b.id } });
  }
  for (const m of missions) {
    if ((m.status === 'failed' || m.status === 'interrupted') && recent(m.updatedAt, now)) exceptions.push({ id: m.id, title: m.objective, detail: m.status === 'interrupted' ? 'Interrupted · Continue resumes from the first unfinished step' : (m.resultSummary ?? 'Stopped'), source: 'Mission', at: m.updatedAt, target: { kind: 'missions', view: 'flight', id: m.id } });
  }
  for (const t of tasks) {
    if ((TASK_FAILED.has(t.status) || t.interrupted) && recent(t.completedAt ?? t.lastEventAt ?? t.createdAt, now)) exceptions.push({ id: t.attemptId, title: t.title, detail: t.failureReason ?? (t.interrupted ? 'Interrupted' : 'Failed'), source: t.worker || 'Task', at: t.completedAt ?? t.lastEventAt, target: t.conversationId ? { kind: 'chat', conversationId: t.conversationId } : { kind: 'missions', view: 'board' } });
  }

  const byNewest = (a: HomeItem, b: HomeItem) => (b.at ?? '').localeCompare(a.at ?? '');
  exceptions.sort(byNewest);

  const anyLive = inFlight.some((i) => i.live);
  const presence: PresenceState = decisions.length ? 'needs_you' : anyLive ? 'acting' : snapshot?.running ? 'thinking' : 'idle';
  const parts: string[] = [];
  if (ready.length && !readyIsOlder) parts.push(`${plural(ready.length, 'result')} ready`);
  if (decisions.length) parts.push(`${plural(decisions.length, 'decision')} waiting`);
  if (exceptions.length) parts.push(`${plural(exceptions.length, 'thing')} need${exceptions.length === 1 ? 's' : ''} attention`);
  if (inFlight.length) parts.push(`${inFlight.length} in flight`);
  const line = parts.length ? `${parts.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : 'Nothing is running and nothing needs you.';
  const line2 = line.charAt(0).toUpperCase() + line.slice(1);
  const tag = presence === 'needs_you' ? 'needs you' : presence === 'acting' ? 'workers sending events' : presence === 'thinking' ? 'local model is working' : 'standing by · no live events';
  return { ready, readyIsOlder, inFlight, decisions, exceptions, presence, line: line2, tag };
}
