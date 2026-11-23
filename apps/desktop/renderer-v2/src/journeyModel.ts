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
  /** What the wish actually produced, as the steps reported it (the result, then the review), for reading in place. */
  outputs?: Array<{ title: string; by: string; kind: 'work' | 'review'; text: string }>;
}

/** A review that reports missing items or gaps, in its own words (the receipt's "Verified" means only that tools backed each step). */
export const reviewFoundGaps = (text: string | null): boolean => Boolean(text && /❌|(?<!(nothing|no|not) )\bmissing\b|(?<!no )\bgaps? (found|identified)\b|\bnot addressed\b|(?<!not )\bincomplete\b/i.test(text));

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
    : DONE_STEP.has(rv.status) ? (reviewFoundGaps(rv.resultText)
      ? ['warn', `${m.agentNames[rv.agentId] ?? 'Reviewer'} checked it and found gaps: read the review below`]
      : ['done', `${m.agentNames[rv.agentId] ?? 'Reviewer'} checked it${rv.resultText ? `: ${rv.resultText.slice(0, 160)}` : ''}`])
    : rv.status === 'failed' ? ['fail', rv.error ?? 'The review did not finish'] : ['todo', `${m.agentNames[rv.agentId] ?? 'Reviewer'} will check the work`];
  const deliver: [StageState, string] = !terminal ? ['todo', 'A receipt is written when the mission ends']
    : m.status === 'completed' ? ['done', receipt ? `Delivered; Core's receipt shows each step backed by tool calls it recorded${receipt.artifacts.length ? ` · ${receipt.artifacts.length} file${receipt.artifacts.length === 1 ? '' : 's'}` : ''}` : (m.resultSummary ?? 'Completed')]
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
    : m.status === 'completed' && rv && reviewFoundGaps(rv.resultText) ? 'Delivered. The Reviewer found gaps: the result and the review are below.'
    : m.status === 'completed' ? `Delivered${receipt?.independentlyReviewed ? ' and independently reviewed' : ''}. The result is below.`
    : m.status === 'completed_with_issues' ? 'Delivered with issues: see what was not verified.'
    : m.status === 'interrupted' ? 'Interrupted: it can be continued from Missions.' : m.status === 'cancelled' ? 'Cancelled.' : 'Not finished.';
  return { id: `m:${m.id}`, kind: 'mission', title: title ?? m.objective, source: 'Mission', conversationId: m.conversationId, stages, now, headline, needsYou: waiting, live: m.status === 'running' && Boolean(running), finished: terminal, failed: ['failed', 'cancelled', 'interrupted'].includes(m.status), actions, at: m.updatedAt,
    outputs: m.steps.filter((s) => s.resultText).map((s) => ({ title: s.title, by: m.agentNames[s.agentId] ?? s.agentId, kind: s.kind, text: s.resultText as string })) };
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

/** A card waiting in Core (GET /v1/approvals/pending), placed in its chat through the attempt that raised it. */
export interface PendingCard { approvalId: string; attemptId: string; conversationId: string | null; toolName: string; text: string; requestedAt: string }

/** Core's pending approvals with their conversation (from the task list) and the card's own text. */
export function cardsFrom(approvals: Array<{ id: string; attemptId: string; status: string; requestedAt: string; presentation?: Record<string, unknown> | null; summary?: Record<string, unknown> | null }>, tasks: TaskRow[]): PendingCard[] {
  const convOf = new Map(tasks.map((t) => [t.attemptId, t.conversationId]));
  return approvals.filter((a) => a.status === 'pending').map((a) => {
    const p = (a.presentation ?? a.summary ?? {}) as Record<string, unknown>;
    const tool = String(p.toolName ?? '');
    return { approvalId: a.id, attemptId: a.attemptId, conversationId: convOf.get(a.attemptId) ?? null, toolName: tool, text: typeof p.cardText === 'string' ? p.cardText : `${tool.replace(/_/g, ' ') || 'An action'} waits for your decision`, requestedAt: a.requestedAt };
  });
}

/**
 * A wish sent from the Wish screen that has no mission or worker task (yet): its stage comes from its chat turn.
 * A card Core holds for that turn is decided right here (Allow once / Don't allow, by approval id, through the same
 * Core approval path the chat uses): the chat only shows the card of the turn the window is running, so a card in
 * another chat could not be reached there and expired unanswered (live run 2026-11-23).
 */
export function chatJourney(w: TrackedWish, tasks: TaskRow[], pending: { conversationId: string | null; approvalId: string; detail: string } | null, cards: PendingCard[] = []): Journey {
  // Newest turn first: a retry on a stronger model (Core's escalation) is a new turn in the same chat and decides the stage.
  const mine = tasks.filter((t) => t.conversationId === w.conversationId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const t = mine[0] ?? null;
  const card = cards.find((c) => c.conversationId === w.conversationId) ?? (pending && pending.conversationId === w.conversationId ? { approvalId: pending.approvalId, attemptId: t?.attemptId ?? '', conversationId: w.conversationId, toolName: '', text: pending.detail, requestedAt: '' } : null);
  const working = t && ['created', 'queued', 'running', 'validating'].includes(t.status);
  // A turn can end (status completed) with Core's verdict that the request was NOT done (resultStatus failed/blocked).
  const notDone = t?.status === 'completed' && ['failed', 'blocked'].includes(t.resultStatus ?? '');
  const answered = t?.status === 'completed' && !notDone;
  const failed = Boolean(t && (['failed', 'cancelled'].includes(t.status) || notDone));
  const waitingCard = Boolean(card) || t?.status === 'waiting_for_approval';
  const isMission = card?.toolName === 'mission_start' || Boolean(t?.activity?.includes('mission_start'));
  const stages = make({
    wish: ['done', w.text],
    understand: !t ? ['now', 'Sent; waiting for Pandesh to pick it up'] : working && !waitingCard ? ['now', t.activity || 'Pandesh is working out what you need'] : ['done', 'Pandesh read it'],
    plan: answered ? ['skip', 'Answered directly; no mission was needed'] : waitingCard ? ['done', isMission ? 'Proposed as a mission' : 'Proposed a step'] : ['todo', ''],
    permissions: waitingCard ? ['now', card?.text || 'A card waits for your decision'] : answered ? ['skip', 'Nothing needed your approval'] : ['todo', ''],
    execute: answered ? ['done', 'Answered in the chat'] : failed ? ['fail', t?.failureReason ?? (notDone ? 'Core\'s verdict: not done. Nothing was built; its chat says why' : 'Stopped')] : ['todo', ''],
    verify: answered ? ['skip', 'A chat answer is not independently checked; ask for a mission with a review if it matters'] : ['todo', ''],
    deliver: answered ? ['done', 'The answer is in the chat'] : ['todo', ''],
  });
  const actions: JourneyAction[] = [];
  if (card) actions.push({ kind: 'allow', approvalId: card.approvalId, text: card.text });
  else if (waitingCard) actions.push({ kind: 'review_chat', conversationId: w.conversationId, text: 'Review the card in its chat' });
  actions.push({ kind: 'open_chat', conversationId: w.conversationId });
  return {
    id: `c:${w.conversationId}`, kind: 'chat', title: w.text, source: 'Chat', conversationId: w.conversationId, stages, now: current(stages),
    headline: waitingCard ? `Pandesh proposes ${isMission ? 'a mission' : 'a step'}. Read it and decide here.` : answered ? 'Answered in the chat.' : notDone ? 'Not done: Core recorded that nothing was built. Its chat says why and what you can do.' : failed ? 'Stopped before an answer.' : 'Pandesh is on it.',
    needsYou: waitingCard, live: Boolean(working), finished: Boolean(answered || failed), failed: Boolean(failed), actions, at: t?.lastEventAt ?? t?.createdAt ?? w.at,
  };
}

/**
 * All journeys, newest first. A tracked wish shows as its mission or worker task once one exists for its conversation
 * (keeping the owner's words as the title); otherwise as its chat turn. Missions and tasks no wish asked for are not
 * listed: Missions shows all work; Wish to Reality shows what the owner asked for and where it got to.
 */
export function buildJourneys(i: { tracked: TrackedWish[]; missions: MissionView[]; bridge: BridgeActivityItem[]; approvals: BridgeApproval[]; tasks: TaskRow[]; pending: { conversationId: string | null; approvalId: string; detail: string } | null; receipts: Record<string, ReceiptLite>; cards?: PendingCard[] }): Journey[] {
  const wordsFor = new Map(i.tracked.map((w) => [w.conversationId, w.text]));
  const covered = new Set<string>();
  const out: Journey[] = [];
  // Only the owner's own wishes: a mission or worker task appears here when it is how one of them is being done.
  // Every other mission and task belongs to Missions (the operational view), not here (owner feedback 2026-11-23).
  for (const m of i.missions) {
    if (!wordsFor.has(m.conversationId) || covered.has(m.conversationId)) continue;
    out.push(missionJourney(m, i.receipts[m.id] ?? null, wordsFor.get(m.conversationId))); covered.add(m.conversationId);
  }
  for (const b of i.bridge.filter((x) => !(x.executor ?? '').startsWith('service:'))) {
    if (!b.conversationId || !wordsFor.has(b.conversationId) || covered.has(b.conversationId)) continue;
    const j = codeJourney(b, i.approvals.find((a) => a.taskId === b.id) ?? null);
    j.title = wordsFor.get(b.conversationId)!;
    out.push(j); covered.add(b.conversationId);
  }
  for (const w of i.tracked) if (!covered.has(w.conversationId)) out.push(chatJourney(w, i.tasks, i.pending, i.cards ?? []));
  return out.sort((a, b) => Number(b.needsYou) - Number(a.needsYou) || Number(b.live) - Number(a.live) || b.at.localeCompare(a.at));
}