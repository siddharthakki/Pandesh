/**
 * The single place a Core attempt becomes a Board column (pure, unit-tested in
 * apps/desktop/test/uiV2BoardModel.test.ts). Status comes from Core; "running"
 * additionally requires Core's lease-backed `live` proof, so the attempt of a
 * worker that died is never shown as running, and nothing is ever shown as
 * completed before Core records it.
 */
export type Column = 'needs' | 'running' | 'queued' | 'blocked' | 'completed' | 'failed';

export interface BoardTask { status: string; live: boolean; interrupted: boolean }

export function columnOf(t: BoardTask): Column {
  switch (t.status) {
    case 'waiting_for_approval': return 'needs';
    case 'running': case 'validating': case 'cancelling':
      return t.live && !t.interrupted ? 'running' : 'blocked';
    case 'created': case 'queued': return t.interrupted ? 'blocked' : 'queued';
    case 'blocked': case 'paused': case 'recovery_required': return 'blocked';
    case 'completed': return 'completed';
    case 'failed': case 'cancelled': return 'failed';
    default: return 'blocked';
  }
}

export function needsYouCount(tasks: BoardTask[], pendingInSnapshot: boolean): number {
  const n = tasks.filter((t) => columnOf(t) === 'needs').length;
  return n || (pendingInSnapshot ? 1 : 0);
}

// ---- Activity grouping (Activity aside) ----
interface GroupableStep { capability?: string; kind?: string; [k: string]: unknown }
/** Consecutive steps of the same kind (e.g. eight file reads) fold into one row; a failure is never hidden. */
export interface ActivityGroup<T> { key: string; items: T[] }
export function groupActivities<T extends GroupableStep>(list: T[]): Array<ActivityGroup<T>> {
  const out: Array<ActivityGroup<T>> = [];
  for (const a of list) {
    const k = String(a.capability ?? a.kind ?? 'step');
    const last = out[out.length - 1];
    if (last && last.key === k) last.items.push(a); else out.push({ key: k, items: [a] });
  }
  // Only runs of 3+ are folded; shorter runs stay as single rows.
  return out.flatMap((g) => (g.items.length >= 3 ? [g] : g.items.map((a) => ({ key: g.key, items: [a] }))));
}

