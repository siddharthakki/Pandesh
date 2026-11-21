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

const LABELS: Record<string, string> = {
  message: 'Said', tool_execute: 'Ran', tool_read: 'Read', tool_edit: 'Edited', tool_search: 'Searched', tool_fetch: 'Fetched',
  permission_request: 'Asked permission', status: 'Status',
};

/** Plain label for a Kandev event kind. */
export function eventLabel(kind: string): string {
  return LABELS[kind] ?? kind.replace(/^tool_/, '').replace(/_/g, ' ');
}
