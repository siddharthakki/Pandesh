/**
 * The Activity timeline (pure; tested in apps/desktop/test/uiV2ActivityTimeline.test.ts).
 *
 * One chronological list of what actually happened in a request: model passes, tool calls, approvals and who decided
 * them, the final check, and how it ended. Every entry comes from an event Core recorded or from the host's saved
 * activity; nothing is added to fill a gap. When the run's live events are gone (after a reload) only the saved tool
 * activity is listed, and the list says so rather than inventing the rest.
 */
import { describePhase, type RunPhase, type RunState } from './runModel';
import type { WorkspaceActivity } from './bridge';

export type EntryState = 'running' | 'ok' | 'failed' | 'blocked' | 'cancelled';
export interface TimelineEntry {
  id: string;
  kind: 'tool' | 'model' | 'approval' | 'verification' | 'note' | 'outcome';
  at: number;
  endedAt?: number;
  label: string;
  state: EntryState;
  /** The saved tool activity behind this row (its input and output previews), when there is one. */
  activity?: WorkspaceActivity;
  /** Why it failed or was blocked, as Core reported it. */
  reason?: string | null;
  facts: string[];
}

const ms = (iso: string | null | undefined): number | undefined => { if (!iso) return undefined; const t = Date.parse(iso); return Number.isFinite(t) ? t : undefined; };
const stateOf = (a: WorkspaceActivity): EntryState => (a.state === 'completed' ? 'ok' : a.state);

export function entryFromActivity(a: WorkspaceActivity): TimelineEntry {
  const at = ms(a.startedAt) ?? 0;
  return { id: `act-${a.id}`, kind: 'tool', at, ...(ms(a.endedAt) !== undefined ? { endedAt: ms(a.endedAt)! } : {}), label: a.title ?? String(a.capability ?? 'step'), state: stateOf(a), activity: a, reason: a.state === 'failed' || a.state === 'cancelled' ? a.detail ?? null : null, facts: [] };
}

export interface TimelineOptions { technical: boolean }

/**
 * `run` is the live run the window followed (null when the window never saw it, e.g. after a reload); `activities` are the
 * saved tool activities of the request being shown.
 */
export function buildTimeline(run: RunState | null, activities: WorkspaceActivity[], opts: TimelineOptions = { technical: false }): { entries: TimelineEntry[]; liveEventsMissing: boolean } {
  const byInv = new Map(activities.map((a) => [a.id, a]));
  const used = new Set<string>();
  const entries: TimelineEntry[] = [];
  if (run) {
    for (const s of run.steps) {
      // Model-call bookkeeping appears only in the technical view; the per-pass rows always show.
      if (s.kind === 'model' && !opts.technical && !s.id.startsWith('pass-')) continue;
      const act = s.invocationId ? byInv.get(s.invocationId) : undefined;
      if (act) used.add(act.id);
      const state: EntryState = act ? stateOf(act) : s.state;
      entries.push({
        id: s.id, kind: s.kind, at: s.startedAt, ...(s.endedAt !== undefined ? { endedAt: s.endedAt } : {}),
        label: act?.title ?? s.label, state, ...(act ? { activity: act } : {}),
        reason: act && (act.state === 'failed' || act.state === 'cancelled') ? act.detail ?? null : null, facts: s.facts,
      });
    }
  }
  // Saved tool activity the live run did not cover (a reload, or an earlier part of the request).
  for (const a of activities) if (!used.has(a.id)) entries.push(entryFromActivity(a));
  if (run?.outcome) {
    const d = describePhase(run, run.lastSignalAt);
    entries.push({
      id: `outcome-${run.outcome}`, kind: 'outcome', at: run.lastSignalAt, label: d.label,
      state: run.outcome === 'completed' ? 'ok' : run.outcome === 'failed' ? 'failed' : 'blocked',
      reason: run.outcome === 'completed' ? null : d.sub, facts: [],
    });
  }
  entries.sort((x, y) => x.at - y.at);
  return { entries, liveEventsMissing: !run && activities.length > 0 };
}

export type Actor = 'tool' | 'model' | 'model_server' | 'you' | 'core' | 'finished' | 'stopped';
const ACTOR: Record<RunPhase, { actor: Actor; text: string }> = {
  starting: { actor: 'core', text: 'Starting' },
  preparing: { actor: 'core', text: 'Pandesh is preparing' },
  loading: { actor: 'model_server', text: 'Model is loading' },
  waiting: { actor: 'model', text: 'Waiting for the model' },
  reasoning: { actor: 'model', text: 'Model is thinking' },
  writing: { actor: 'model', text: 'Model is writing' },
  selecting_tool: { actor: 'model', text: 'Model is choosing a tool' },
  tool: { actor: 'tool', text: 'A tool is running' },
  approval: { actor: 'you', text: 'Waiting for you' },
  verifying: { actor: 'core', text: 'Pandesh is checking the result' },
  completed: { actor: 'finished', text: 'Finished' },
  failed: { actor: 'stopped', text: 'Failed' },
  cancelled: { actor: 'stopped', text: 'Stopped' },
  interrupted: { actor: 'stopped', text: 'Interrupted' },
};
/**
 * Who the request is waiting on right now, from the phase Core's events set. "Working" (a tool, Pandesh itself) and
 * "waiting for the model" are different things: the first moves because something is running, the second only waits.
 */
export function whoIsWorking(run: RunState): { actor: Actor; text: string; working: boolean } {
  const a = ACTOR[run.phase];
  return { ...a, working: a.actor === 'tool' || a.actor === 'core' };
}
