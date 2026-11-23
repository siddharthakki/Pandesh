import { useEffect, useRef, useState } from 'react';
import { api, errorText, onDesktopEvent } from './bridge';
import type { MissionView } from './missionModel';
import type { BridgeActivityItem, BridgeApproval } from './Missions';

export interface OperatorData {
  missions: MissionView[]; bridge: BridgeActivityItem[]; approvals: BridgeApproval[];
  /** Null until the first read; an error keeps the last good read but marks it stale. */
  loadedAt: number | null; error: string | null; refresh: () => void;
}

const DONE = new Set(['completed', 'failed', 'cancelled']);
const normalize = (b: BridgeActivityItem): BridgeActivityItem => ({ ...b, latest: b.latest ?? null, lastEventAt: b.lastEventAt ?? null, eventCount: b.eventCount ?? 0, branch: b.branch ?? null, pendingWorkerActions: b.pendingWorkerActions ?? [] });

/**
 * Core's own mission, Kandev worker and approval records, read through the existing household actions (no new store). Polls
 * every 3 s while anything is live and every 20 s when idle, and re-reads on Core events (coalesced), so an idle Pandesh
 * costs almost nothing while the local model runs.
 */
export function useOperatorData(): OperatorData {
  const [missions, setMissions] = useState<MissionView[]>([]);
  const [bridge, setBridge] = useState<BridgeActivityItem[]>([]);
  const [approvals, setApprovals] = useState<BridgeApproval[]>([]);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  const load = async () => {
    const errs: string[] = [];
    try { const r = await api.household('missions', {}) as { missions?: MissionView[] }; setMissions(r.missions ?? []); } catch (err) { errs.push(errorText(err)); }
    try { const r = await api.household('bridgeActivity') as { items?: BridgeActivityItem[] }; setBridge((r.items ?? []).map(normalize)); } catch { /* an older Core has no activity feed */ }
    try { const r = await api.household('bridgeApprovals') as { approvals?: BridgeApproval[] }; setApprovals(r.approvals ?? []); } catch { /* an older Core has no bridge approvals */ }
    setError(errs.length ? errs[0] : null);
    setLoadedAt(Date.now());
  };
  const refresh = () => {
    if (pending.current) return;
    pending.current = true;
    setTimeout(() => { pending.current = false; void load(); }, 150);
  };

  const live = missions.some((m) => m.status === 'running') || bridge.some((b) => !DONE.has(b.state));
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    const t = setInterval(() => void load(), live ? 3000 : 20000);
    return () => clearInterval(t);
  }, [live]);
  useEffect(() => onDesktopEvent((e) => { if (e.kind === 'result' || e.kind === 'activity' || e.kind === 'conversation_message') refresh(); }), []);
  return { missions, bridge, approvals, loadedAt, error, refresh };
}

/** A clock that only ticks while something is live (event ages need it); an idle screen does not re-render. */
export function useTicker(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) { setNow(Date.now()); return; }
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
