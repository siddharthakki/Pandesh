/**
 * Pure helpers for the live worker panels (MissionControlPane.tsx WorkerPanels). Kept free of React so they can be tested directly.
 */

/** One recorded worker event, as Core stores it (core/domain/pandaBridge.ts BridgeTaskResult.activity). */
export interface WorkerEvent { id?: string; at: string; kind: string; text: string; status?: string }

/** The fields of a bridge activity item the panels need (Core: core/runtime/kandev/bridgeActivity.ts ActivityItem). */
export interface WorkerItem {
  id: string; executor: string | null; state: string; createdAt: string;
  latest: { at: string; kind: string; text: string } | null; lastEventAt: string | null; heartbeatAgeMs: number | null;
}

/** After this long without a worker event, a live panel says so instead of just "Running". */
export const QUIET_MS = 60_000;

const AGENTS: Record<string, string> = { claude: 'Claude Code', opencode: 'OpenCode', antigravity: 'Antigravity', hermes: 'Hermes' };
const DONE = new Set(['completed', 'failed', 'cancelled']);

/** Tasks run by a Kandev worker, grouped by agent (Claude first), live work before finished work, newest first within each. */
export function groupWorkers<T extends WorkerItem>(items: T[]): Array<{ agent: string; label: string; items: T[] }> {
  const by = new Map<string, T[]>();
  for (const b of items) {
    if (!b.executor || !AGENTS[b.executor]) continue;
    by.set(b.executor, [...(by.get(b.executor) ?? []), b]);
  }
  const order = Object.keys(AGENTS);
  return [...by.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([agent, list]) => ({
      agent, label: AGENTS[agent],
      items: [...list].sort((x, y) => (Number(DONE.has(x.state)) - Number(DONE.has(y.state))) || y.createdAt.localeCompare(x.createdAt)),
    }));
}

/** What decides where a worker task is shown: the chat it belongs to, and whether a person still has to decide something. */
export interface ScopedWorker extends WorkerItem { conversationId: string | null; pendingWorkerActions?: unknown[]; codeChange?: { awaitingReview: boolean } | null }
const needsDecision = (b: ScopedWorker) => (b.pendingWorkerActions?.length ?? 0) > 0 || b.codeChange?.awaitingReview === true;

/**
 * The worker cards a chat shows: this chat's own tasks that are still running or wait for a decision. A finished task, or one
 * that belongs to another chat or to no chat, is not shown here; it lives in Work (workersInWork).
 */
export function workersInChat<T extends ScopedWorker>(items: T[], conversationId: string | null): T[] {
  if (!conversationId) return [];
  return items.filter((b) => b.conversationId === conversationId && (!DONE.has(b.state) || needsDecision(b)));
}

/** Work's view of every worker task: live ones under Running, finished ones under Completed or Failed (execution details stay folded). */
export function workersInWork<T extends ScopedWorker>(items: T[]): { running: T[]; completed: T[]; failed: T[] } {
  return {
    running: items.filter((b) => !DONE.has(b.state)),
    completed: items.filter((b) => b.state === 'completed' && !needsDecision(b)),
    failed: items.filter((b) => b.state === 'failed' || b.state === 'cancelled'),
  };
}

const DOING: Record<string, string> = {
  tool_execute: 'Running a command', tool_read: 'Reading files', tool_edit: 'Editing files', tool_search: 'Searching the project', tool_fetch: 'Looking something up',
  permission_request: 'Waiting for your permission', message: 'Working it out',
};
/** One short human sentence for a card in the chat: what the worker is doing now. The raw event text stays in Work's execution log. */
export function plainProgress(b: Pick<WorkerItem, 'latest' | 'state'>, stateLabel: string): string {
  if (DONE.has(b.state)) return stateLabel;
  return b.latest ? (DOING[b.latest.kind] ?? stateLabel) : stateLabel;
}

const secs = (ms: number) => elapsedText(Math.max(0, ms));
function elapsedText(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * "Last event N s ago", measured from the worker's own newest event (never from Core's bookkeeping). A live worker silent for
 * QUIET_MS or longer reads "No event for N" and is flagged `quiet`. No event at all is said plainly.
 */
export function eventAge(b: WorkerItem, now: number): { text: string; quiet: boolean } {
  const live = !DONE.has(b.state);
  const at = b.lastEventAt ? Date.parse(b.lastEventAt) : NaN;
  if (!Number.isFinite(at)) return { text: live ? 'No worker event yet.' : 'No worker events were recorded.', quiet: live };
  const age = now - at;
  if (!live) return { text: `Last event at ${new Date(at).toLocaleTimeString()}.`, quiet: false };
  if (age >= QUIET_MS) return { text: `No event for ${secs(age)} (last at ${new Date(at).toLocaleTimeString()}).`, quiet: true };
  return { text: `Last event: ${secs(age)} ago`, quiet: false };
}

/**
 * The controls a live worker panel offers, matching what Core supports: Stop for any live task; Pause only while a Kandev worker
 * is at work (Core keeps its worktree for Resume); Resume only for a paused one.
 */
export function workerControls(b: Pick<WorkerItem, 'state'>): Array<{ action: 'bridgeCancel' | 'bridgePause' | 'bridgeResume'; label: string }> {
  if (DONE.has(b.state)) return [];
  if (b.state === 'paused') return [{ action: 'bridgeResume', label: 'Resume' }, { action: 'bridgeCancel', label: 'Stop' }];
  const pausable = ['running', 'waiting_for_approval', 'stalled', 'needs_attention', 'waiting_for_model'].includes(b.state);
  return [...(pausable ? [{ action: 'bridgePause' as const, label: 'Pause' }] : []), { action: 'bridgeCancel', label: 'Stop' }];
}

const LABELS: Record<string, string> = {
  message: 'Said', tool_execute: 'Ran', tool_read: 'Read', tool_edit: 'Edited', tool_search: 'Searched', tool_fetch: 'Fetched',
  permission_request: 'Asked permission', status: 'Status',
};

/** Plain label for a Kandev event kind. */
export function eventLabel(kind: string): string {
  return LABELS[kind] ?? kind.replace(/^tool_/, '').replace(/_/g, ' ');
}

/** One file of an A5 change as Core reports it (core/runtime/kandev/changeDiff.ts FileDiff). */
export interface ChangeFile {
  path: string; oldPath: string | null; status: string; additions: number | null; deletions: number | null;
  binary: boolean; patch: string | null; truncated: boolean; note: string | null;
}
export interface ChangeDiffView {
  available: boolean; reason: string | null; source: string | null; base: string | null; head: string | null;
  files: ChangeFile[]; ignored: string[];
  summary: { files: number; additions: number; deletions: number; binary: number; large: number; unavailable: number };
}

const STATUS_LABEL: Record<string, string> = { added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', 'type-changed': 'Type changed', untracked: 'New (uncommitted)' };
export function changeStatusLabel(status: string): string { return STATUS_LABEL[status] ?? status; }

/** "+3 −1", or what is known when Git could not count (binary or not shown). */
export function changeCounts(f: Pick<ChangeFile, 'additions' | 'deletions' | 'binary'>): string {
  if (f.binary) return 'binary';
  if (f.additions === null && f.deletions === null) return 'not counted';
  return `+${f.additions ?? 0} −${f.deletions ?? 0}`;
}

/** The flag shown beside a file whose diff is not shown in full. Null when the whole diff is shown. */
export function changeFlag(f: Pick<ChangeFile, 'binary' | 'truncated' | 'patch' | 'note'>): { kind: 'binary' | 'large' | 'unavailable'; text: string } | null {
  if (f.binary) return { kind: 'binary', text: 'Binary' };
  if (f.truncated || /too large|larger than/i.test(f.note ?? '')) return { kind: 'large', text: 'Large diff' };
  if (f.patch === null) return { kind: 'unavailable', text: 'Diff unavailable' };
  return null;
}

/** The one-line summary of a change: files, lines, where it was read from, and the flags that need attention. */
export function changeSummary(d: ChangeDiffView): string {
  if (!d.available) return `Diff unavailable: ${d.reason ?? 'unknown reason'}`;
  const s = d.summary;
  const parts = [`${s.files} file${s.files === 1 ? '' : 's'} changed`, `+${s.additions} −${s.deletions}`];
  if (s.binary) parts.push(`${s.binary} binary`);
  if (s.large) parts.push(`${s.large} large`);
  if (s.unavailable) parts.push(`${s.unavailable} not shown`);
  parts.push(`read from the ${d.source ?? 'change'} (${d.base ?? '?'} → ${d.head ?? '?'})`);
  return parts.join(' · ');
}
