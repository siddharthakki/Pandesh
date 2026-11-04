/**
 * The PC organization journal: plans, their moves and the rules a person approved.
 *
 * A plan is proposed read-only. Its moves are rows, each settled through a fixed lifecycle:
 *
 *   planned → moving (written BEFORE the rename, with the exact destination) → moved → verified
 *                                                                           ↘ failed / skipped
 *   verified → undone (by undo)
 *
 * Because `moving` is written first, a crash between the write and the rename is recoverable: the next apply looks at
 * the disk and settles the row (already at the destination → moved; still at the source → retried). Completed moves
 * are never repeated, and undo reverses exactly the rows that reached the disk.
 */
import * as crypto from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import type { FileCategory } from './fileClassification';

export type PlanStatus = 'proposed' | 'applying' | 'applied' | 'partially_applied' | 'declined' | 'undone' | 'partially_undone';
export type MoveStatus = 'planned' | 'moving' | 'moved' | 'verified' | 'skipped' | 'failed' | 'undone';

export interface OrganizationPlan {
  id: string;
  origin: 'chat' | 'routine' | 'host';
  roots: string[];
  targetBase: string;
  status: PlanStatus;
  summary: Record<string, unknown>;
  digest: string;
  routineId: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  appliedAt: string | null;
  undoneAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrganizationMove {
  planId: string;
  idx: number;
  fromPath: string;
  toPath: string;
  finalPath: string | null;
  size: number;
  mtimeMs: number;
  sha256: string | null;
  category: FileCategory | 'unit' | 'duplicate';
  reason: string;
  ruleId: string | null;
  status: MoveStatus;
  error: string | null;
  batch: number | null;
  movedAt: string | null;
  undoneAt: string | null;
}

export interface OrganizationRule {
  id: string;
  sourceRoot: string;
  category: FileCategory;
  /** Relative to the source root; `{year}` is filled per file. */
  destination: string;
  createdFromPlan: string | null;
  approvedBy: string;
  enabled: boolean;
  createdAt: string;
}

function mapPlan(r: Record<string, unknown>): OrganizationPlan {
  return {
    id: String(r.id), origin: r.origin as OrganizationPlan['origin'], roots: JSON.parse(String(r.rootsJson)), targetBase: String(r.targetBase),
    status: r.status as PlanStatus, summary: JSON.parse(String(r.summaryJson)), digest: String(r.digest), routineId: (r.routineId as string) ?? null,
    approvedBy: (r.approvedBy as string) ?? null, approvedAt: (r.approvedAt as string) ?? null, appliedAt: (r.appliedAt as string) ?? null,
    undoneAt: (r.undoneAt as string) ?? null, createdAt: String(r.createdAt), updatedAt: String(r.updatedAt),
  };
}

function mapMove(r: Record<string, unknown>): OrganizationMove {
  return {
    planId: String(r.planId), idx: Number(r.idx), fromPath: String(r.fromPath), toPath: String(r.toPath), finalPath: (r.finalPath as string) ?? null,
    size: Number(r.size), mtimeMs: Number(r.mtimeMs), sha256: (r.sha256 as string) ?? null, category: r.category as OrganizationMove['category'],
    reason: String(r.reason), ruleId: (r.ruleId as string) ?? null, status: r.status as MoveStatus, error: (r.error as string) ?? null,
    batch: r.batch === null || r.batch === undefined ? null : Number(r.batch), movedAt: (r.movedAt as string) ?? null, undoneAt: (r.undoneAt as string) ?? null,
  };
}

/** The approval binds this: the exact list of moves and where they land. Any change to the plan changes it. */
export function planDigest(targetBase: string, moves: ReadonlyArray<Pick<OrganizationMove, 'fromPath' | 'toPath' | 'size' | 'mtimeMs'>>): string {
  const h = crypto.createHash('sha256').update(targetBase.toLowerCase()).update('\n');
  for (const m of moves) h.update(`${m.fromPath.toLowerCase()}\t${m.toPath.toLowerCase()}\t${m.size}\t${m.mtimeMs}\n`);
  return h.digest('hex');
}

export function createOrganizationPlan(db: CoreDatabase, input: {
  origin: OrganizationPlan['origin'];
  roots: string[];
  targetBase: string;
  summary: Record<string, unknown>;
  moves: Array<Omit<OrganizationMove, 'planId' | 'idx' | 'finalPath' | 'status' | 'error' | 'batch' | 'movedAt' | 'undoneAt'>>;
  routineId?: string | null;
}): OrganizationPlan {
  const id = newId('orgplan');
  const at = nowIso();
  const digest = planDigest(input.targetBase, input.moves);
  db.transaction(() => {
    db.run(
      `INSERT INTO organization_plans (id, origin, rootsJson, targetBase, status, summaryJson, digest, routineId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, 'proposed', ?, ?, ?, ?, ?)`,
      [id, input.origin, JSON.stringify(input.roots), input.targetBase, JSON.stringify(input.summary), digest, input.routineId ?? null, at, at],
    );
    input.moves.forEach((m, idx) => {
      db.run(
        `INSERT INTO organization_moves (planId, idx, fromPath, toPath, size, mtimeMs, sha256, category, reason, ruleId, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned')`,
        [id, idx, m.fromPath, m.toPath, m.size, m.mtimeMs, m.sha256, m.category, m.reason.slice(0, 300), m.ruleId],
      );
    });
  });
  return getOrganizationPlan(db, id);
}

export function getOrganizationPlan(db: CoreDatabase, id: string): OrganizationPlan {
  const row = db.get<Record<string, unknown>>('SELECT * FROM organization_plans WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `organization plan ${id} not found`);
  return mapPlan(row);
}

export function listOrganizationPlans(db: CoreDatabase, limit = 20): OrganizationPlan[] {
  return db.all<Record<string, unknown>>('SELECT * FROM organization_plans ORDER BY createdAt DESC LIMIT ?', [limit]).map(mapPlan);
}

export function listPlanMoves(db: CoreDatabase, planId: string, filter: { status?: MoveStatus[] } = {}): OrganizationMove[] {
  const statuses = filter.status ?? [];
  const where = statuses.length ? ` AND status IN (${statuses.map(() => '?').join(',')})` : '';
  return db.all<Record<string, unknown>>(`SELECT * FROM organization_moves WHERE planId = ?${where} ORDER BY idx ASC`, [planId, ...statuses]).map(mapMove);
}

export function moveCounts(db: CoreDatabase, planId: string): Record<MoveStatus, number> {
  const counts: Record<MoveStatus, number> = { planned: 0, moving: 0, moved: 0, verified: 0, skipped: 0, failed: 0, undone: 0 };
  for (const r of db.all<{ status: MoveStatus; n: number }>('SELECT status, COUNT(*) AS n FROM organization_moves WHERE planId = ? GROUP BY status', [planId])) {
    counts[r.status] = Number(r.n);
  }
  return counts;
}

export function updatePlan(db: CoreDatabase, id: string, patch: Partial<Pick<OrganizationPlan, 'status' | 'approvedBy' | 'approvedAt' | 'appliedAt' | 'undoneAt' | 'summary'>>): OrganizationPlan {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key === 'summary' ? 'summaryJson' : key} = ?`);
    values.push(key === 'summary' ? JSON.stringify(value) : value);
  }
  sets.push('updatedAt = ?');
  values.push(nowIso(), id);
  db.run(`UPDATE organization_plans SET ${sets.join(', ')} WHERE id = ?`, values);
  return getOrganizationPlan(db, id);
}

/** Settles one move row. `moving` must carry the destination it is about to be renamed to. */
export function updateMove(db: CoreDatabase, planId: string, idx: number, patch: Partial<Pick<OrganizationMove, 'status' | 'finalPath' | 'sha256' | 'error' | 'batch' | 'movedAt' | 'undoneAt'>>): void {
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, value] of Object.entries(patch)) { sets.push(`${key} = ?`); values.push(value ?? null); }
  values.push(planId, idx);
  db.run(`UPDATE organization_moves SET ${sets.join(', ')} WHERE planId = ? AND idx = ?`, values);
}

function mapRule(r: Record<string, unknown>): OrganizationRule {
  return {
    id: String(r.id), sourceRoot: String(r.sourceRoot), category: r.category as FileCategory, destination: String(r.destination),
    createdFromPlan: (r.createdFromPlan as string) ?? null, approvedBy: String(r.approvedBy), enabled: Number(r.enabled) === 1, createdAt: String(r.createdAt),
  };
}

/** Records (or refreshes) "files of this category in this folder go there", as approved by a person on a plan. */
export function upsertOrganizationRule(db: CoreDatabase, input: { sourceRoot: string; category: FileCategory; destination: string; createdFromPlan: string | null; approvedBy: string }): OrganizationRule {
  const existing = db.get<Record<string, unknown>>('SELECT * FROM organization_rules WHERE sourceRoot = ? AND category = ?', [input.sourceRoot.toLowerCase(), input.category]);
  if (existing) {
    db.run('UPDATE organization_rules SET destination = ?, createdFromPlan = ?, approvedBy = ?, enabled = 1 WHERE id = ?', [input.destination, input.createdFromPlan, input.approvedBy, existing.id]);
    return mapRule(db.get<Record<string, unknown>>('SELECT * FROM organization_rules WHERE id = ?', [existing.id])!);
  }
  const id = newId('orgrule');
  db.run(
    'INSERT INTO organization_rules (id, sourceRoot, category, destination, createdFromPlan, approvedBy, enabled, createdAt) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
    [id, input.sourceRoot.toLowerCase(), input.category, input.destination, input.createdFromPlan, input.approvedBy, nowIso()],
  );
  return mapRule(db.get<Record<string, unknown>>('SELECT * FROM organization_rules WHERE id = ?', [id])!);
}

export function listOrganizationRules(db: CoreDatabase, sourceRoot?: string): OrganizationRule[] {
  const rows = sourceRoot
    ? db.all<Record<string, unknown>>('SELECT * FROM organization_rules WHERE sourceRoot = ? AND enabled = 1 ORDER BY category', [sourceRoot.toLowerCase()])
    : db.all<Record<string, unknown>>('SELECT * FROM organization_rules ORDER BY sourceRoot, category');
  return rows.map(mapRule);
}
