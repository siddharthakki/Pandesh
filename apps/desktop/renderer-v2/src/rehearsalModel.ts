// Rehearsal (Preview) view model — task-specific preview before authorization.
// Data comes from pc_organize_plan (read-only) + renderPlanPreview. No mutation.

export interface RehearsalMove { source: string; destination: string; bytes: number; conflict: boolean; }
export interface RehearsalDuplicate { set: number; files: number; bytes: number; }
export interface RehearsalPlan {
  planId: string;
  totalMoves: number;
  moves: RehearsalMove[];
  duplicates: RehearsalDuplicate[];
  conflicts: number;
  spaceFreedBytes: number;
  spaceMovedBytes: number;
  digest: string;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function rehearsalHeadline(p: RehearsalPlan): string {
  return `Preview · ${p.totalMoves} proposed moves · 0 changed yet`;
}

export function hasConflicts(p: RehearsalPlan): boolean {
  return p.conflicts > 0 || p.moves.some((m) => m.conflict);
}

export function conflictCount(p: RehearsalPlan): number {
  return p.moves.filter((m) => m.conflict).length;
}