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
