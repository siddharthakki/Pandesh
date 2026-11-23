/**
 * Wish to Reality, general form: "what can Pandesh accomplish for me?". Every wish is followed through the same seven
 * stages, each read from a real Core record and never advanced by the window:
 *
 *   Wish → Understand → Plan → Permissions → Execute → Verify → Deliver
 *
 * - A wish typed on the Wish screen is a real chat message in its own conversation (tracked by conversation id).
 *   Until Pandesh starts a mission or a worker task for it, its stage comes from that conversation's task record.
 * - A mission (core/domain/missions.ts) supplies Plan (its steps), Permissions (cards its steps raise), Execute (work
 *   steps), Verify (review steps) and Deliver (the outcome receipt).
 * - A coding task run by a Kandev engine (bridge activity) supplies the same stages from its worker state, the owner's
 *   dispatch approval, the change review and the delivered branch.
 * Pure, so tested without a window.
 */
import type { MissionView } from './missionModel';
import type { BridgeActivityItem, BridgeApproval } from './Missions';
import type { TaskRow } from './bridge';

export const JOURNEY = [
  ['wish', 'Wish'], ['understand', 'Understand'], ['plan', 'Plan'], ['permissions', 'Permissions'], ['execute', 'Execute'], ['verify', 'Verify'], ['deliver', 'Deliver'],
] as const;
export type StageKey = (typeof JOURNEY)[number][0];
/** done · now (happening, or waiting for you) · todo · skip (not part of this wish) · fail · warn (done with a caveat) */
export type StageState = 'done' | 'now' | 'todo' | 'skip' | 'fail' | 'warn';
export interface Stage { key: StageKey; label: string; state: StageState; detail: string }

export type JourneyAction =
  | { kind: 'allow'; approvalId: string; text: string }
  | { kind: 'review_chat'; conversationId: string; text: string }
  | { kind: 'review_task'; taskId: string; text: string }
  | { kind: 'deliver'; taskId: string; text: string }
  | { kind: 'open_chat'; conversationId: string }
  | { kind: 'open_mission'; missionId: string }
  | { kind: 'open_task'; taskId: string };

export interface Journey {
  id: string; kind: 'chat' | 'mission' | 'code'; title: string; source: string;
  conversationId: string | null; stages: Stage[]; now: StageKey | null;
  /** One sentence: where it stands, from the records. */
  headline: string; needsYou: boolean; live: boolean; finished: boolean; failed: boolean;
  actions: JourneyAction[]; at: string;
}

export interface TrackedWish { conversationId: string; text: string; at: string }
export interface ReceiptLite { headline: string; verifiedOutputs: Array<{ label?: string; text?: string; path?: string } | string>; artifacts: Array<{ path: string; exists: boolean }>; nextAction: string | null; independentlyReviewed: boolean; partialOrFailed: Array<unknown> }

const LABEL = Object.fromEntries(JOURNEY) as Record<StageKey, string>;
const make = (states: Partial<Record<StageKey, [StageState, string]>>): Stage[] =>
  JOURNEY.map(([key]) => ({ key, label: LABEL[key], state: states[key]?.[0] ?? 'todo', detail: states[key]?.[1] ?? '' }));
const current = (stages: Stage[]): StageKey | null => (stages.find((s) => s.state === 'now' || s.state === 'fail') ?? null)?.key ?? null;
const DONE_STEP = new Set(['succeeded', 'unverified']);
const BRIDGE_DONE = new Set(['completed', 'failed', 'cancelled']);

export function missionJourney(m: MissionView, receipt: ReceiptLite | null, title?: string): Journey {
  const names = (ids: string[]) => [...new Set(ids.map((id) => m.agentNames[id] ?? id))].join(', ');
  const work = m.steps.filter((s) => s.kind === 'work');
  const review = m.steps.filter((s) => s.kind === 'review');
  const terminal = ['completed', 'completed_with_issues', 'failed', 'cancelled'].includes(m.status);
  const waiting = m.pendingApprovals.length > 0;
  const running = work.find((s) => s.status === 'running');
  const workFailed = work.find((s) => s.status === 'failed');
  const workDone = work.length > 0 && work.every((s) => DONE_STEP.has(s.status) || s.status === 'skipped');
  const unverified = work.some((s) => s.status === 'unverified');

  const exec: [StageState, string] = workFailed ? ['fail', `${workFailed.title}: ${workFailed.error ?? 'failed'}`]
    : workDone ? [unverified ? 'warn' : 'done', `${work.length} step${work.length === 1 ? '' : 's'} done${unverified ? '; some results could not be checked against the tools that ran' : ''}`]
    : running ? ['now', `${m.agentNames[running.agentId] ?? running.agentId}: ${running.title}${m.liveActivity ? ` · last ${m.liveActivity.tool.replace(/_/g, ' ')}` : ''}`]
    : m.status === 'cancelled' || m.status === 'interrupted' ? ['fail', m.status === 'cancelled' ? 'Stopped before the work finished' : 'Interrupted; it can be continued']
    : ['todo', `${work.length} step${work.length === 1 ? '' : 's'} planned`];
  const rv = review[0];
  const verify: [StageState, string] = !review.length
    ? (terminal ? ['skip', 'No independent review was planned; the receipt shows what the tools themselves confirmed'] : ['skip', 'No independent review planned'])
    : rv.status === 'running' ? ['now', `${m.agentNames[rv.agentId] ?? 'Reviewer'} is checking the work`]
    : DONE_STEP.has(rv.status) ? ['done', `${m.agentNames[rv.agentId] ?? 'Reviewer'} checked it${rv.resultText ? `: ${rv.resultText.slice(0, 160)}` : ''}`]
    : rv.status === 'failed' ? ['fail', rv.error ?? 'The review did not finish'] : ['todo', `${m.agentNames[rv.agentId] ?? 'Reviewer'} will check the work`];
  const deliver: [StageState, string] = !terminal ? ['todo', 'A receipt is written when the mission ends']
    : m.status === 'completed' ? ['done', receipt ? `${receipt.headline}${receipt.artifacts.length ? ` · ${receipt.artifacts.length} file${receipt.artifacts.length === 1 ? '' : 's'}` : ''}${m.resultSummary ? ` · ${m.resultSummary.slice(0, 200)}` : ''}` : (m.resultSummary ?? 'Completed')]
    : m.status === 'completed_with_issues' ? ['warn', receipt?.nextAction ?? m.resultSummary ?? 'Completed with issues']
    : ['fail', m.resultSummary ?? (m.status === 'cancelled' ? 'Cancelled' : 'Not finished')];

  const stages = make({
    wish: ['done', title ?? m.objective],
    understand: ['done', `Pandesh made it a mission: ${m.objective}`],
    plan: ['done', `${m.steps.length} step${m.steps.length === 1 ? '' : 's'} by ${names(m.steps.map((s) => s.agentId))}`],
    permissions: waiting ? ['now', m.pendingApprovals[0].text] : ['done', 'You approved the plan; each step runs within its specialist\'s limits and asks before anything that changes things'],
    execute: exec, verify, deliver,
  });
  const actions: JourneyAction[] = m.pendingApprovals.map((a) => ({ kind: 'allow' as const, approvalId: a.approvalId, text: a.text }));
  actions.push({ kind: 'open_mission', missionId: m.id });
  if (m.conversationId) actions.push({ kind: 'open_chat', conversationId: m.conversationId });
  const now = current(stages);
  const headline = waiting ? 'Waiting for your OK to continue.'
    : m.status === 'running' ? (running ? `Working: ${running.title}` : 'Between steps.')
    : m.status === 'completed' ? `Delivered${receipt?.independentlyReviewed ? ' and independently reviewed' : ''}.`
    : m.status === 'completed_with_issues' ? 'Delivered with issues: see what was not verified.'
    : m.status === 'interrupted' ? 'Interrupted: it can be continued from Missions.' : m.status === 'cancelled' ? 'Cancelled.' : 'Not finished.';
  return { id: `m:${m.id}`, kind: 'mission', title: title ?? m.objective, source: 'Mission', conversationId: m.conversationId, stages, now, headline, needsYou: waiting, live: m.status === 'running' && Boolean(running), finished: terminal, failed: ['failed', 'cancelled', 'interrupted'].includes(m.status), actions, at: m.updatedAt };
}

export function codeJourney(b: BridgeActivityItem, approval: BridgeApproval | null): Journey {
  const engine = b.executor ? ({ claude: 'Claude Code', opencode: 'OpenCode', hermes: 'Hermes', antigravity: 'Antigravity', native: 'Pandesh' } as Record<string, string>)[b.executor] ?? b.executor : null;
  const done = BRIDGE_DONE.has(b.state);
  const cc = b.codeChange ?? null;
  const unclaimed = ['waiting_for_executor', 'queued'].includes(b.state) && !approval;
  const permWaiting = Boolean(approval) || b.pendingWorkerActions.length > 0;
  const reviewing = Boolean(cc?.awaitingReview);
  const stages = make({
    wish: ['done', b.instruction],
    understand: ['done', `Received from ${b.origin.client}${b.origin.title ? ` (${b.origin.title})` : ''}`],
    plan: unclaimed ? ['now', 'No engine has been chosen for it yet'] : ['done', engine ? `${engine}${cc ? ` on ${cc.project}, in an isolated copy` : ''}` : 'Engine chosen'],
    permissions: approval ? ['now', `${approval.agentLabel} (${approval.provider}) asks to run: ${approval.exposure.join(', ') || approval.accessLevel}`]
      : b.pendingWorkerActions.length ? ['now', b.pendingWorkerActions[0].what]
      : unclaimed ? ['todo', ''] : ['done', 'You allowed this engine to run it'],
    execute: b.state === 'running' ? ['now', b.latest?.text?.slice(0, 160) ?? 'Working'] : done || reviewing || cc ? (b.state === 'failed' ? ['fail', b.reason || 'Failed'] : b.state === 'cancelled' ? ['fail', 'Cancelled'] : ['done', `${b.eventCount} events`]) : ['todo', ''],
    verify: reviewing ? ['now', `Your review: ${cc!.changedFiles.length} file${cc!.changedFiles.length === 1 ? '' : 's'} changed${b.outcome?.summary ? ` · ${b.outcome.summary.slice(0, 160)}` : ''}`]
      : b.verification === 'independent' ? ['done', 'Checked independently (tests before and after)']
      : b.verification === 'human-reviewed' ? ['done', 'Reviewed and approved by you']
      : b.verification === 'worker-only' ? ['warn', 'Only the worker\'s own report; not independently checked']
      : done ? ['skip', 'No check recorded'] : ['todo', ''],
    deliver: cc?.delivered ? ['done', `In your checkout as branch ${cc.delivered.branch} (not merged, not pushed)`]
      : b.state === 'completed' ? [cc?.deliverable ? 'now' : 'done', b.outcome?.summary ?? 'Completed']
      : done ? ['fail', b.outcome?.summary ?? b.reason ?? b.stateLabel] : ['todo', ''],
  });
  const actions: JourneyAction[] = [];
  if (approval) actions.push({ kind: 'review_task', taskId: b.id, text: 'Review the request in full' });
  if (reviewing) actions.push({ kind: 'review_task', taskId: b.id, text: 'Review the change' });
  if (b.state === 'completed' && cc?.deliverable && !cc.delivered) actions.push({ kind: 'deliver', taskId: b.id, text: 'Bring into my checkout as a new branch' });
  actions.push({ kind: 'open_task', taskId: b.id });
  return {
    id: `b:${b.id}`, kind: 'code', title: b.instruction, source: engine ? `${engine} via Kandev` : 'Kandev', conversationId: b.conversationId, stages, now: current(stages),
    headline: permWaiting ? 'Waiting for your OK.' : reviewing ? 'Done in a private copy; waiting for your review.' : unclaimed ? 'Not started: no engine has picked it up.' : b.state === 'running' ? 'Working.'
      : b.state === 'completed' && cc?.deliverable && !cc.delivered ? 'Delivered to Pandesh\'s private copy. You can bring it into your checkout as a new branch.' : b.stateLabel,
    // Bringing a finished change into the checkout is optional, so it is offered but never counted as "needs you".
    needsYou: permWaiting || reviewing, live: b.state === 'running', finished: done, failed: ['failed', 'cancelled'].includes(b.state),
    actions, at: b.lastEventAt ?? b.createdAt,
  };
}

/** A wish sent from the Wish screen that has no mission or worker task (yet): its stage comes from its chat turn. */
export function chatJourney(w: TrackedWish, tasks: TaskRow[], pending: { conversationId: string | null; approvalId: string; detail: string } | null): Journey {
  const mine = tasks.filter((t) => t.conversationId === w.conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const t = mine[0] ?? null;
  const asking = pending && pending.conversationId === w.conversationId ? pending : null;
  const working = t && ['created', 'queued', 'running', 'validating'].includes(t.status);
  const answered = t?.status === 'completed';
  const failed = t && ['failed', 'cancelled'].includes(t.status);
  const stages = make({
    wish: ['done', w.text],
    understand: !t ? ['now', 'Sent; waiting for Pandesh to pick it up'] : working && !asking ? ['now', t.activity || 'Pandesh is working out what you need'] : ['done', 'Pandesh read it'],
    plan: answered ? ['skip', 'Answered directly; no mission was needed'] : asking ? ['done', 'Proposed in the chat'] : ['todo', ''],
    permissions: asking || t?.status === 'waiting_for_approval' ? ['now', asking?.detail || 'A card in the chat waits for your decision'] : answered ? ['skip', 'Nothing needed your approval'] : ['todo', ''],
    execute: answered ? ['done', 'Answered in the chat'] : failed ? ['fail', t?.failureReason ?? 'Stopped'] : ['todo', ''],
    verify: answered ? ['skip', 'A chat answer is not independently checked; ask for a mission with a review if it matters'] : ['todo', ''],
    deliver: answered ? ['done', 'The answer is in the chat'] : ['todo', ''],
  });
  const actions: JourneyAction[] = [];
  if (asking) actions.push({ kind: 'review_chat', conversationId: w.conversationId, text: 'Review the card in its chat' });
  actions.push({ kind: 'open_chat', conversationId: w.conversationId });
  return {
    id: `c:${w.conversationId}`, kind: 'chat', title: w.text, source: 'Chat', conversationId: w.conversationId, stages, now: current(stages),
    headline: asking ? 'Pandesh proposed a plan; it waits for your decision in the chat.' : answered ? 'Answered in the chat.' : failed ? 'Stopped before an answer.' : 'Pandesh is on it.',
    needsYou: Boolean(asking) || t?.status === 'waiting_for_approval', live: Boolean(working), finished: Boolean(answered || failed), failed: Boolean(failed), actions, at: t?.lastEventAt ?? t?.createdAt ?? w.at,
  };
}

/**
 * All journeys, newest first. A tracked wish shows as its mission or worker task once one exists for its conversation
 * (keeping the owner's words as the title); otherwise as its chat turn. Service tasks are not wishes.
 */
export function buildJourneys(i: { tracked: TrackedWish[]; missions: MissionView[]; bridge: BridgeActivityItem[]; approvals: BridgeApproval[]; tasks: TaskRow[]; pending: { conversationId: string | null; approvalId: string; detail: string } | null; receipts: Record<string, ReceiptLite> }): Journey[] {
  const wordsFor = new Map(i.tracked.map((w) => [w.conversationId, w.text]));
  const covered = new Set<string>();
  const out: Journey[] = [];
  for (const m of i.missions) { out.push(missionJourney(m, i.receipts[m.id] ?? null, wordsFor.get(m.conversationId))); covered.add(m.conversationId); }
  for (const b of i.bridge.filter((x) => !(x.executor ?? '').startsWith('service:'))) {
    const j = codeJourney(b, i.approvals.find((a) => a.taskId === b.id) ?? null);
    if (b.conversationId && wordsFor.has(b.conversationId)) j.title = wordsFor.get(b.conversationId)!;
    out.push(j); if (b.conversationId) covered.add(b.conversationId);
  }
  for (const w of i.tracked) if (!covered.has(w.conversationId)) out.push(chatJourney(w, i.tasks, i.pending));
  return out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || Number(b.live) - Number(a.live) || b.at.localeCompare(a.at));
}
