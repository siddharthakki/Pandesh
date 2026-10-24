/**
 * The Personal Assistant brief — what needs the operator right now, and what
 * today actually contains.
 *
 * Every line here is a projection of durable Core state: a task, an approval,
 * an artifact, a reminder, a schedule, or a live permission-gated connector
 * read. Nothing is invented and nothing is stale:
 *
 * - each item names the source it came from,
 * - the state and the timestamp are the ones that source wrote,
 * - the actions are the ones the runtime really supports.
 *
 * Liveness follows the same rule the Tasks screen uses: a worker holds a task
 * only while its ownership lease is unexpired. A persisted `running` status is
 * a leftover, not proof of work.
 */
import type { CoreDatabase } from '../db/connection';
import type {
  AssistantBriefAction,
  AssistantBriefItem,
  AssistantBriefSection,
  AssistantBriefSource,
  AssistantBriefStance,
  ApprovalRecord,
} from '../shared/wireTypes';
import { listTaskOverview, type TaskOverviewRow } from './taskOverview';
import { listPendingApprovals } from './approvals';
import { attemptRetryEligibility } from './retryPolicy';
import { listArtifacts } from './artifacts';
import { listReminders, type EverydayReminderView } from './everydayTools';
import { describeCommitment, listCommitments, toCommitmentView } from './commitments';
import { listScheduledTasks } from './scheduledTasks';
import { listCommands } from './commandQueue';
import { nowIso } from './ids';
import { STALE_AFTER_MS, compactAge, describeCompletionDay } from './briefingTriage';

export interface AssistantBriefOptions {
  nowMs?: number;
  /** The operator's zone, used for "how long ago" wording. */
  timezone?: string;
  /** How recent a completion must be to count as a "recently completed result". */
  recentWindowMs?: number;
  /** How many items Home may show. The product cap is three. */
  homeLimit?: number;
}

const DEFAULT_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;
const HOME_ITEM_CAP = 3;
/** A failure or interruption stays "needs you" for a day; after that it is history, reachable from the Tasks screen. */
const DEFAULT_BROKEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** A request title for a card: whitespace collapsed and cut at a word boundary, never mid-word. */
export function briefTitle(title: string | null | undefined, max = 90): string {
  const text = String(title ?? '').replace(/\s+/g, ' ').trim();
  if (!text) return '(untitled request)';
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-]+$/, '')}…`;
}

function resolveTimezone(input?: string): string {
  const zone = String(input ?? '').trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

/** "3 minutes ago" / "2 days ago" — from the source's own timestamp. */
export function describeAge(fromIso: string, nowMs: number): string {
  const then = Date.parse(fromIso);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const diff = Math.max(0, nowMs - then);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/** "in 3 minutes" — for something that has not happened yet. */
export function describeTimeUntil(untilIso: string, nowMs: number): string {
  const then = Date.parse(untilIso);
  if (!Number.isFinite(then)) return 'at an unknown time';
  const diff = Math.max(0, then - nowMs);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 1) return 'due now';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

function source(
  kind: AssistantBriefSource['kind'],
  label: string,
  reference: string | null,
  checkedAt: string,
): AssistantBriefSource {
  return { kind, label, reference, checkedAt };
}

/** The conversation an approval belongs to, plus the request's own words. */
interface ApprovalContext {
  conversationId: string | null;
  conversationTitle: string | null;
  requestMessage: string | null;
  attemptStatus: string | null;
}

export function approvalContext(db: CoreDatabase, approval: ApprovalRecord): ApprovalContext {
  const row = db.get<{ conversationId: string | null; currentMessage: string | null; status: string | null; title: string | null }>(
    `SELECT r.conversationId AS conversationId, r.currentMessage AS currentMessage, a.status AS status, c.title AS title
       FROM attempts a
       JOIN requests r ON r.id = a.requestId
       LEFT JOIN conversations c ON c.id = r.conversationId
      WHERE a.id = ?`,
    [approval.attemptId],
  );
  return {
    conversationId: row?.conversationId ?? null,
    conversationTitle: row?.title ?? null,
    requestMessage: row?.currentMessage ?? null,
    attemptStatus: row?.status ?? null,
  };
}

/** What the approval is asking for, in a few plain words. */
/** What an approval's tool does, in the words a person uses. Unknown tools fall back to their own name, never an invention. */
const APPROVAL_TOOL_PHRASE: Record<string, string> = {
  run_checks: 'run a command',
  run_command: 'run a command',
  write_file: 'write a file',
  propose_file_change: 'change a file',
  propose_text_edit: 'edit a file',
  web_research: 'search the web',
  calendar_create_event: 'add a calendar event',
  calendar_update_event: 'change a calendar event',
  calendar_delete_event: 'delete a calendar event',
  gmail_send_draft: 'send an email',
  gmail_apply_plan: 'organize your Gmail',
  gmail_undo_plan: 'undo a Gmail change',
  memory_remember: 'remember something',
  memory_forget: 'forget something',
  image_generate: 'generate an image',
  video_generate: 'generate a video',
};

export function describeApprovalIntent(approval: ApprovalRecord): string {
  const presentation = (approval.presentation ?? {}) as Record<string, unknown>;
  const summary = (approval.summary ?? {}) as Record<string, unknown>;
  const toolName = typeof summary.toolName === 'string'
    ? summary.toolName
    : typeof presentation.toolName === 'string' ? presentation.toolName : '';
  if (toolName) {
    const phrase = APPROVAL_TOOL_PHRASE[toolName];
    if (phrase) return phrase;
    const kind = approval.kind === 'delivery' ? 'delivery' : approval.kind === 'proposal' ? 'proposal' : 'change';
    return `${kind}: ${toolName.replace(/_/g, ' ')}`;
  }
  return `${approval.kind} approval`;
}

/**
 * The plain-language explanation the agent wrote for this approval.
 *
 * This is the long form, so it belongs in the detail line under a short
 * title — never the other way round.
 */
export function describeApprovalCardText(approval: ApprovalRecord): string {
  const presentation = (approval.presentation ?? {}) as Record<string, unknown>;
  const cardText = typeof presentation.cardText === 'string' ? presentation.cardText.trim() : '';
  if (!cardText) return '';
  return cardText.length > 220 ? `${cardText.slice(0, 220)}…` : cardText;
}

/** The scope the operator is being asked to authorize. */
function describeApprovalScope(approval: ApprovalRecord): string {
  const presentation = (approval.presentation ?? {}) as Record<string, unknown>;
  const summary = (approval.summary ?? {}) as Record<string, unknown>;
  const scope = typeof presentation.scope === 'string' ? presentation.scope : '';
  if (scope.trim()) return scope.trim().slice(0, 200);
  const paths = Array.isArray(presentation.paths)
    ? presentation.paths.filter((p): p is string => typeof p === 'string')
    : [];
  if (paths.length) return `${paths.length} file${paths.length === 1 ? '' : 's'}: ${paths.slice(0, 3).join(', ')}`;
  const args = summary.arguments as Record<string, unknown> | undefined;
  const path = args && typeof args.path === 'string' ? args.path : null;
  if (path) return path.slice(0, 200);
  return 'Scope is shown on the approval card';
}

function conversationActions(conversationId: string | null): AssistantBriefAction[] {
  if (!conversationId) return [];
  return [{ kind: 'open_conversation', label: 'Open conversation', conversationId }];
}

/**
 * The three (at most) things Pandesh puts in front of the operator on launch.
 *
 * Priority is fixed and observable: a pending approval first, then an
 * actionable failure or interruption, then a recently completed result. A
 * running task fills a free slot because it shows real progress. Each category
 * contributes at most one item, so the list never becomes a wall of cards.
 */
export function buildAssistantHomeItems(db: CoreDatabase, options: AssistantBriefOptions = {}): AssistantBriefItem[] {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const limit = Math.min(Math.max(options.homeLimit ?? HOME_ITEM_CAP, 1), HOME_ITEM_CAP);
  const recentWindowMs = options.recentWindowMs ?? DEFAULT_RECENT_WINDOW_MS;
  const tasks = listTaskOverview(db, 50, nowMs);
  const approvals = listPendingApprovals(db);
  const items: AssistantBriefItem[] = [];

  // 1 — a pending approval: the one that has been waiting longest. One that has sat for
  // more than a day is housekeeping (see Today), not what the operator is here for now.
  const approval = approvals.filter((a) => nowMs - Date.parse(a.requestedAt) < STALE_AFTER_MS).sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))[0];
  if (approval) {
    const ctx = approvalContext(db, approval);
    const cardText = describeApprovalCardText(approval);
    const scope = describeApprovalScope(approval);
    items.push({
      id: `approval:${approval.id}`,
      kind: 'approval',
      stance: 'fact',
      title: `Approval needed — ${describeApprovalIntent(approval)}`,
      detail: [cardText, scope, `asked ${describeAge(approval.requestedAt, nowMs)}`]
        .filter(Boolean)
        .join(' · '),
      state: 'pending',
      at: approval.requestedAt,
      source: source('core_approval', 'KarkeDikha approval', approval.id, checkedAt),
      actions: [
        { kind: 'resolve_approval', label: 'Approve', approvalId: approval.id, attemptId: approval.attemptId, conversationId: ctx.conversationId ?? undefined },
        { kind: 'resolve_approval', label: 'Reject', approvalId: approval.id, attemptId: approval.attemptId, conversationId: ctx.conversationId ?? undefined },
        ...conversationActions(ctx.conversationId),
      ],
    });
  }

  // 2 — an actionable failure or an interruption: the most recent one.
  const broken = tasks
    .filter((task) => (task.status === 'failed' || task.interrupted)
      && nowMs - Date.parse(task.lastEventAt ?? task.completedAt ?? task.createdAt) <= DEFAULT_BROKEN_WINDOW_MS
      // Asking again and finishing settles it: a failure the person has since redone is history, not "needs you".
      && !tasks.some((other) => other.conversationId && other.conversationId === task.conversationId
        && other.status === 'completed' && Date.parse(other.createdAt) > Date.parse(task.createdAt)))
    .sort((a, b) => Date.parse(b.lastEventAt ?? b.completedAt ?? b.createdAt) - Date.parse(a.lastEventAt ?? a.completedAt ?? a.createdAt))[0];
  if (broken) {
    const at = broken.completedAt ?? broken.lastEventAt ?? broken.createdAt;
    items.push(brokenTaskItem(db, broken, at, checkedAt, nowMs));
  }

  // 3 — a recently completed result: something the operator can reopen.
  const completed = tasks
    .filter((task) => task.status === 'completed' && nowMs - Date.parse(task.completedAt ?? task.createdAt) <= recentWindowMs)
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))[0];
  if (completed) {
    items.push(completedTaskItem(db, completed, checkedAt, nowMs));
  }

  // A running task shows real progress, so it fills a free slot.
  if (items.length < limit) {
    const running = tasks
      .filter((task) => task.live)
      .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt) - Date.parse(a.startedAt ?? a.createdAt))[0];
    if (running) {
      items.push(runningTaskItem(running, checkedAt, nowMs));
    }
  }

  return items.slice(0, limit);
}

function brokenTaskItem(
  db: CoreDatabase,
  task: TaskOverviewRow,
  at: string,
  checkedAt: string,
  nowMs: number,
): AssistantBriefItem {
  const interrupted = task.status !== 'failed';
  const reason = task.failureReason ? task.failureReason.slice(0, 160) : task.activity;
  const actions: AssistantBriefAction[] = [];
  // Resume is offered only when the Core itself says this attempt can be
  // retried safely. An interrupted attempt is never quietly resumed.
  if (!interrupted) {
    try {
      if (attemptRetryEligibility(db, task.attemptId).eligible) {
        actions.push({ kind: 'resume_task', label: 'Resume', attemptId: task.attemptId });
      }
    } catch { /* the attempt is gone; the card stays informative */ }
  }
  if (task.cancellable) actions.push({ kind: 'stop_task', label: 'Stop', attemptId: task.attemptId });
  actions.push(...conversationActions(task.conversationId));
  return {
    id: `task:${task.attemptId}`,
    kind: interrupted ? 'task_interrupted' : 'task_failed',
    stance: 'fact',
    title: interrupted ? 'Interrupted — a task stopped' : 'Failed — a task did not finish',
    detail: `${briefTitle(task.title)} — ${reason} (${describeAge(at, nowMs)})`,
    state: interrupted ? 'interrupted' : 'failed',
    at,
    source: source('core_attempt', 'KarkeDikha task', task.attemptId, checkedAt),
    actions,
  };
}

function runningTaskItem(task: TaskOverviewRow, checkedAt: string, nowMs: number): AssistantBriefItem {
  const at = task.startedAt ?? task.createdAt;
  return {
    id: `task:${task.attemptId}`,
    kind: 'task_running',
    stance: 'fact',
    title: 'Working on it now',
    detail: `${briefTitle(task.title)} — ${task.activity} (${describeAge(at, nowMs)})`,
    state: 'running',
    at,
    source: source('core_attempt', 'KarkeDikha task', task.attemptId, checkedAt),
    actions: [
      ...conversationActions(task.conversationId),
      ...(task.cancellable ? [{ kind: 'stop_task' as const, label: 'Stop', attemptId: task.attemptId }] : []),
    ],
  };
}

function completedTaskItem(db: CoreDatabase, task: TaskOverviewRow, checkedAt: string, nowMs: number): AssistantBriefItem {
  const at = task.completedAt ?? task.createdAt;
  // Only this conversation's own results. A task with no conversation has no
  // results of its own — never the whole gallery.
  const artifacts = task.conversationId ? listArtifacts(db, task.conversationId).slice(0, 3) : [];
  const resultText = artifacts.length
    ? `${artifacts.length} result${artifacts.length === 1 ? '' : 's'} ready`
    : 'Finished';
  const actions: AssistantBriefAction[] = [...conversationActions(task.conversationId)];
  const artifact = artifacts.find((a) => a.availability === 'ready');
  if (artifact) {
    actions.unshift({ kind: 'open_artifact', label: 'Open result', artifactId: artifact.id, conversationId: task.conversationId ?? undefined });
  }
  return {
    id: `task:${task.attemptId}`,
    kind: 'task_completed',
    stance: 'action_performed',
    title: 'Finished',
    detail: `${briefTitle(task.title)} — ${resultText} (${describeAge(at, nowMs)})`,
    state: 'completed',
    at,
    source: source('core_attempt', 'KarkeDikha task', task.attemptId, checkedAt),
    actions,
  };
}

/* ── Today ───────────────────────────────────────────────────────────── */

function section(
  id: string,
  label: string,
  items: AssistantBriefItem[],
  available = true,
  unavailableReason: string | null = null,
): AssistantBriefSection {
  return { id, label, available, unavailableReason, items };
}

/**
 * The Today briefing, from Core's own durable state.
 *
 * Calendar and email are added by the runtime layer, which is the only layer
 * that can read a live connector. They are appended after these sections so
 * the reading order stays: calendar, email, work, approvals, follow-ups.
 */
export function buildAssistantTodaySections(db: CoreDatabase, options: AssistantBriefOptions = {}): AssistantBriefSection[] {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  const timezone = resolveTimezone(options.timezone);
  const tasks = listTaskOverview(db, 50, nowMs);

  /* Pending work — what is running, and what is queued behind it. */
  const workItems: AssistantBriefItem[] = [];
  const live = tasks.filter((task) => task.live).slice(0, 3);
  for (const task of live) workItems.push(runningTaskItem(task, checkedAt, nowMs));
  const notRunning = tasks.filter((task) => !task.live && !['completed', 'failed', 'cancelled'].includes(task.status));
  const isFresh = (task: TaskOverviewRow) => nowMs - Date.parse(task.lastEventAt ?? task.createdAt) < STALE_AFTER_MS;
  // An unfinished task from days ago is history: it is grouped under Housekeeping, not listed as pending work.
  const stopped = notRunning.filter(isFresh).slice(0, 2);
  const staleStopped = notRunning.filter((task) => !isFresh(task));
  for (const task of stopped) {
    const at = task.lastEventAt ?? task.createdAt;
    workItems.push(brokenTaskItem(db, task, at, checkedAt, nowMs));
  }
  const queued = listCommands(db).filter((item) => item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled').slice(0, 3);
  for (const item of queued) {
    workItems.push({
      id: `queue:${item.id}`,
      kind: 'task_running',
      stance: 'fact',
      title: 'Waiting in the queue',
      detail: `${item.title || item.instruction}`,
      state: item.status === 'confirming' ? 'awaiting confirmation' : 'queued',
      at: item.createdAt,
      source: source('core_attempt', 'KarkeDikha queue', item.id, checkedAt),
      actions: [],
    });
  }

  /* Approvals — everything still waiting on the operator, oldest first. */
  const allApprovals = listPendingApprovals(db).sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt));
  const staleApprovals = allApprovals.filter((a) => nowMs - Date.parse(a.requestedAt) >= STALE_AFTER_MS);
  const approvalItems: AssistantBriefItem[] = allApprovals
    .filter((a) => nowMs - Date.parse(a.requestedAt) < STALE_AFTER_MS)
    .map((approval) => {
      const ctx = approvalContext(db, approval);
      const cardText = describeApprovalCardText(approval);
      return {
        id: `approval:${approval.id}`,
        kind: 'approval' as const,
        stance: 'fact' as const,
        title: describeApprovalIntent(approval),
        detail: [cardText, describeApprovalScope(approval), `asked ${describeAge(approval.requestedAt, nowMs)}`, ctx.conversationTitle ? `in “${ctx.conversationTitle}”` : '']
          .filter(Boolean)
          .join(' · '),
        state: 'pending',
        at: approval.requestedAt,
        source: source('core_approval', 'KarkeDikha approval', approval.id, checkedAt),
        actions: [
          { kind: 'resolve_approval', label: 'Approve', approvalId: approval.id, attemptId: approval.attemptId, conversationId: ctx.conversationId ?? undefined },
          { kind: 'resolve_approval', label: 'Reject', approvalId: approval.id, attemptId: approval.attemptId, conversationId: ctx.conversationId ?? undefined },
        ],
      };
    });

  /* Follow-ups — reminders that are due, promises still standing, and routines
     that will run. */
  const followUpItems: AssistantBriefItem[] = [];
  const firedReminders: EverydayReminderView[] = [];
  for (const reminder of listReminders(db, { status: 'open', limit: 20 })) {
    if (!reminder.overdue) continue;
    // A reminder whose alert already fired is not news; it needs a Dismiss or a new time.
    if (reminder.notifiedAt) { firedReminders.push(reminder); continue; }
    followUpItems.push(reminderItem(reminder, checkedAt, nowMs));
  }
  for (const commitment of listCommitments(db, { status: 'open', limit: 20 })) {
    const view = toCommitmentView(commitment, nowMs);
    followUpItems.push({
      id: `commitment:${commitment.id}`,
      kind: 'commitment',
      stance: 'fact',
      title: `Promise still open: ${describeCommitment(commitment)}`,
      detail: [
        commitment.dueAt ? `due ${describeTimeUntil(commitment.dueAt, nowMs)}` : null,
        view.overdue ? 'overdue' : null,
        commitment.condition === 'no_reply'
          ? 'waiting for a reply'
          : 'only you can close this',
      ].filter(Boolean).join(' · '),
      state: view.overdue ? 'overdue' : 'open',
      at: commitment.dueAt ?? commitment.createdAt,
      source: source('core_commitment', 'Pandesh commitment', commitment.id, checkedAt),
      actions: [],
    });
  }
  for (const schedule of listScheduledTasks(db).slice(0, 3)) {
    followUpItems.push({
      id: `schedule:${schedule.id}`,
      kind: 'routine',
      stance: 'fact',
      title: `Scheduled: ${schedule.title}`,
      detail: `Runs ${schedule.dailyTime} (${schedule.timezone}) · next ${describeTimeUntil(schedule.nextRunAt, nowMs)}`,
      state: schedule.enabled ? 'scheduled' : 'disabled',
      at: schedule.nextRunAt,
      source: source('core_schedule', 'KarkeDikha schedule', schedule.id, checkedAt),
      actions: [],
    });
  }

  const recentCompleted = tasks
    .filter((task) => task.status === 'completed' && nowMs - Date.parse(task.completedAt ?? task.createdAt) <= DEFAULT_RECENT_WINDOW_MS)
    .sort((a, b) => Date.parse(b.completedAt ?? b.createdAt) - Date.parse(a.completedAt ?? a.createdAt))
    .slice(0, 2);
  for (const task of recentCompleted) {
    const at = task.completedAt ?? task.createdAt;
    followUpItems.push({
      id: `task:${task.attemptId}`,
      kind: 'task_completed',
      stance: 'action_performed',
      title: describeCompletionDay(at, nowMs, timezone),
      detail: `${briefTitle(task.title)} (${describeAge(at, nowMs)})`,
      state: 'completed',
      at,
      source: source('core_attempt', 'KarkeDikha task', task.attemptId, checkedAt),
      actions: conversationActions(task.conversationId),
    });
  }

  /* Suggestions — Pandesh's own advice, never presented as a fact. */
  const suggestions: AssistantBriefItem[] = [];
  if (approvalItems.length > 0) {
    suggestions.push({
      id: 'suggestion:approvals',
      kind: 'approval',
      stance: 'suggestion',
      title: `${approvalItems.length} approval${approvalItems.length === 1 ? '' : 's'} ${approvalItems.length === 1 ? 'is' : 'are'} waiting on you`,
      detail: 'Approve or reject them from Home — nothing proceeds until you decide.',
      state: 'suggested',
      at: checkedAt,
      source: source('core_approval', 'KarkeDikha approvals', null, checkedAt),
      actions: [{ kind: 'refresh_brief', label: 'Refresh' }],
    });
  }
  if (stopped.length > 0) {
    suggestions.push({
      id: 'suggestion:stopped',
      kind: 'task_interrupted',
      stance: 'suggestion',
      title: `${stopped.length} task${stopped.length === 1 ? ' is' : 's are'} not running`,
      detail: 'Their worker stopped. Stop them to settle them, or open the task to see what it reached.',
      state: 'suggested',
      at: checkedAt,
      source: source('core_attempt', 'KarkeDikha tasks', null, checkedAt),
      actions: [{ kind: 'refresh_brief', label: 'Refresh' }],
    });
  }

  /* Housekeeping — old items, grouped so they cannot crowd out today. Nothing here is changed by the brief. */
  const housekeepingItems: AssistantBriefItem[] = [];
  if (staleApprovals.length) {
    const searches = staleApprovals.filter((a) => (a.summary as Record<string, unknown> | null)?.toolName === 'request_search_permission').length;
    const oldest = Date.parse(staleApprovals[0].requestedAt);
    housekeepingItems.push({
      id: 'housekeeping:approvals',
      kind: 'approval',
      stance: 'fact',
      title: `${staleApprovals.length} older approval${staleApprovals.length === 1 ? '' : 's'} still pending`,
      detail: `Oldest ${compactAge(oldest, nowMs)}${searches ? `; ${searches} read-only folder search permission${searches === 1 ? '' : 's'}` : ''}. None was approved, rejected or expired — Review them when convenient.`,
      state: 'stale',
      at: staleApprovals[0].requestedAt,
      source: source('core_approval', 'KarkeDikha approvals', staleApprovals[0].id, checkedAt),
      actions: [
        ...conversationActions(approvalContext(db, staleApprovals[0]).conversationId).map((a) => ({ ...a, label: 'Review oldest' })),
        { kind: 'refresh_brief', label: 'Refresh' },
      ],
    });
  }
  for (const task of staleStopped.slice(0, 2)) {
    const item = brokenTaskItem(db, task, task.lastEventAt ?? task.createdAt, checkedAt, nowMs);
    housekeepingItems.push({ ...item, title: `Older interrupted task — ${briefTitle(task.title, 60)}`, state: 'stale' });
  }
  for (const reminder of firedReminders.slice(0, 3)) {
    housekeepingItems.push({
      ...reminderItem(reminder, checkedAt, nowMs),
      title: `Reminder already fired — ${reminder.title}`,
      detail: `Alerted ${describeAge(reminder.notifiedAt ?? reminder.dueAt, nowMs)} and still open. Say "dismiss" or "reschedule to <time>" to Pandesh.`,
      state: 'fired',
    });
  }

  return [
    section('work', 'Pending work', workItems.slice(0, 5)),
    section('approvals', 'Waiting for your approval', approvalItems.slice(0, 5)),
    section('follow_ups', 'Follow-ups', followUpItems.slice(0, 5)),
    section('housekeeping', 'Housekeeping — older items', housekeepingItems.slice(0, 4)),
    section('suggestions', 'What Pandesh suggests', suggestions),
  ];
}

function reminderItem(reminder: EverydayReminderView, checkedAt: string, nowMs: number): AssistantBriefItem {
  return {
    id: `reminder:${reminder.id}`,
    kind: 'reminder',
    stance: 'fact',
    title: `Reminder due — ${reminder.title}`,
    detail: reminder.overdueExplanation ?? `Due ${describeAge(reminder.dueAt, nowMs)}`,
    state: reminder.overdue ? 'overdue' : 'scheduled',
    at: reminder.dueAt,
    source: source('core_reminder', 'KarkeDikha reminder', reminder.id, checkedAt),
    actions: [],
  };
}

/** Every reminder that is due right now — used by the daily routine. */
export function listDueReminderItems(db: CoreDatabase, options: AssistantBriefOptions = {}): AssistantBriefItem[] {
  const nowMs = options.nowMs ?? Date.now();
  const checkedAt = new Date(nowMs).toISOString();
  return listReminders(db, { status: 'open', limit: 20 })
    .filter((reminder) => reminder.overdue)
    .map((reminder) => reminderItem(reminder, checkedAt, nowMs));
}

export { nowIso };
