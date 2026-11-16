/**
 * Missions: one objective, ordered specialist steps, run in the background.
 *
 * A delegation (`delegate_to_agent`) makes the lead wait for one specialist. A mission is the same hand-off made
 * durable and asynchronous: the lead writes the plan (which specialist does what, in which order, and whether an
 * independent review follows), Core stores it here and runs each step as an ordinary delegated task
 * (core/domain/delegation.ts: the same scope intersection, limits and approvals), and the lead's turn ends at once so
 * the person can keep talking. Every step keeps what Core recorded about it — the tools that really ran, the files it
 * produced, its report — so the final report separates what was executed and checked from what an agent only said.
 *
 * Nothing here schedules or executes; core/runtime/missionRunner.ts does. This file is the durable record.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import { expireApproval } from './approvals';

export type MissionStatus = 'running' | 'completed' | 'completed_with_issues' | 'failed' | 'cancelled' | 'interrupted';
export type MissionStepStatus = 'pending' | 'running' | 'succeeded' | 'unverified' | 'failed' | 'skipped' | 'cancelled';
export type MissionStepKind = 'work' | 'review';

export const TERMINAL_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set(['completed', 'completed_with_issues', 'failed', 'cancelled']);
/** A mission that stopped before its plan finished and can be continued from the first unfinished step. */
export const RESUMABLE_MISSION_STATUSES: ReadonlySet<MissionStatus> = new Set(['failed', 'cancelled', 'interrupted']);

export interface MissionStepEvidence {
  /** Successful tool calls that bear on the step, by tool (count). */
  verified: Array<{ tool: string; count: number }>;
  unrelated: string[];
  failed: string[];
  /** Tools the report names that never ran successfully. */
  unbacked: string[];
  totalCalls: number;
  modelCalls?: number;
  seconds?: number;
}

export interface MissionArtifact { path: string; bytes: number | null; kind: string; exists: boolean }

export interface MissionStep {
  id: string;
  missionId: string;
  idx: number;
  agentId: string;
  kind: MissionStepKind;
  title: string;
  brief: string;
  /** May run at the same time as the step before it (it does not need that step's result). */
  parallel: boolean;
  status: MissionStepStatus;
  handoffId: string | null;
  childAttemptId: string | null;
  childConversationId: string | null;
  resultText: string | null;
  evidence: MissionStepEvidence | null;
  artifacts: MissionArtifact[];
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Mission {
  id: string;
  conversationId: string;
  parentAttemptId: string;
  clientId: string;
  objective: string;
  status: MissionStatus;
  workspaceRoot: string | null;
  selectedProvider: string | null;
  selectedModel: string | null;
  egressApprovalId: string | null;
  reportMessageId: string | null;
  resultSummary: string | null;
  cancelRequestedAt: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  steps: MissionStep[];
}

export interface MissionStepInput { agentId: string; title: string; brief: string; kind?: MissionStepKind; parallel?: boolean }

export const MAX_MISSION_STEPS = 6;
export const MAX_ACTIVE_MISSIONS = 3;

const parse = <T>(raw: unknown, fallback: T): T => { try { return raw ? JSON.parse(String(raw)) as T : fallback; } catch { return fallback; } };

function rowToStep(r: Record<string, unknown>): MissionStep {
  return {
    id: String(r.id), missionId: String(r.missionId), idx: Number(r.idx), agentId: String(r.agentId), kind: (String(r.kind) === 'review' ? 'review' : 'work'),
    title: String(r.title), brief: String(r.brief), parallel: Number(r.parallel ?? 0) === 1, status: String(r.status) as MissionStepStatus,
    handoffId: (r.handoffId as string) ?? null, childAttemptId: (r.childAttemptId as string) ?? null, childConversationId: (r.childConversationId as string) ?? null,
    resultText: (r.resultText as string) ?? null, evidence: parse<MissionStepEvidence | null>(r.evidenceJson, null), artifacts: parse<MissionArtifact[]>(r.artifactsJson, []),
    error: (r.error as string) ?? null, startedAt: (r.startedAt as string) ?? null, completedAt: (r.completedAt as string) ?? null,
  };
}

function rowToMission(db: CoreDatabase, r: Record<string, unknown>): Mission {
  const steps = db.all<Record<string, unknown>>('SELECT * FROM mission_steps WHERE missionId = ? ORDER BY idx', [String(r.id)]).map(rowToStep);
  return {
    id: String(r.id), conversationId: String(r.conversationId), parentAttemptId: String(r.parentAttemptId), clientId: String(r.clientId), objective: String(r.objective),
    status: String(r.status) as MissionStatus, workspaceRoot: (r.workspaceRoot as string) ?? null, selectedProvider: (r.selectedProvider as string) ?? null,
    selectedModel: (r.selectedModel as string) ?? null, egressApprovalId: (r.egressApprovalId as string) ?? null, reportMessageId: (r.reportMessageId as string) ?? null,
    resultSummary: (r.resultSummary as string) ?? null, cancelRequestedAt: (r.cancelRequestedAt as string) ?? null,
    createdAt: String(r.createdAt), updatedAt: String(r.updatedAt), completedAt: (r.completedAt as string) ?? null, steps,
  };
}

export function createMission(db: CoreDatabase, input: {
  conversationId: string; parentAttemptId: string; clientId: string; objective: string; steps: MissionStepInput[];
  workspaceRoot?: string | null; selectedProvider?: string | null; selectedModel?: string | null; egressApprovalId?: string | null;
}): Mission {
  const objective = input.objective.trim();
  if (objective.length < 8) throw new CoreError('invalid_request', 'a mission needs an objective that says what the result should be');
  if (!input.steps.length) throw new CoreError('invalid_request', 'a mission needs at least one step');
  if (input.steps.length > MAX_MISSION_STEPS) throw new CoreError('invalid_request', `a mission is limited to ${MAX_MISSION_STEPS} steps; merge related work into one step`);
  for (const [i, s] of input.steps.entries()) {
    if (s.brief.trim().length < 8) throw new CoreError('invalid_request', `step ${i + 1} needs a brief that states what to do and what to return`);
    if (s.brief.length > 3000) throw new CoreError('invalid_request', `step ${i + 1}: a brief is limited to 3000 characters`);
  }
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM missions WHERE status = 'running'")?.n ?? 0;
  if (active >= MAX_ACTIVE_MISSIONS) throw new CoreError('invalid_request', `${MAX_ACTIVE_MISSIONS} missions are already running; wait for one to finish or cancel one`);
  const id = newId('msn');
  const now = nowIso();
  return db.transaction(() => {
    db.run(`INSERT INTO missions (id, conversationId, parentAttemptId, clientId, objective, status, workspaceRoot, selectedProvider, selectedModel, egressApprovalId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)`,
    [id, input.conversationId, input.parentAttemptId, input.clientId, objective.slice(0, 2000), input.workspaceRoot ?? null, input.selectedProvider ?? null, input.selectedModel ?? null, input.egressApprovalId ?? null, now, now]);
    input.steps.forEach((s, idx) => {
      // The first step has nothing to run beside, and a review always waits for the work it checks.
      const parallel = idx > 0 && s.parallel === true && s.kind !== 'review' ? 1 : 0;
      db.run(`INSERT INTO mission_steps (id, missionId, idx, agentId, kind, title, brief, parallel, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [newId('mst'), id, idx, s.agentId, s.kind === 'review' ? 'review' : 'work', s.title.trim().slice(0, 120) || `Step ${idx + 1}`, s.brief.trim(), parallel]);
    });
    return getMission(db, id);
  });
}

export function getMission(db: CoreDatabase, id: string): Mission {
  const row = db.get<Record<string, unknown>>('SELECT * FROM missions WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `mission '${id}' does not exist`);
  return rowToMission(db, row);
}

export function findMission(db: CoreDatabase, id: string): Mission | null {
  const row = db.get<Record<string, unknown>>('SELECT * FROM missions WHERE id = ?', [id]);
  return row ? rowToMission(db, row) : null;
}

export function listMissions(db: CoreDatabase, filter: { conversationId?: string; activeOnly?: boolean; limit?: number } = {}): Mission[] {
  const where: string[] = [];
  const args: unknown[] = [];
  if (filter.conversationId) { where.push('conversationId = ?'); args.push(filter.conversationId); }
  if (filter.activeOnly) where.push("status = 'running'");
  const rows = db.all<Record<string, unknown>>(`SELECT * FROM missions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY createdAt DESC LIMIT ?`, [...args, Math.min(100, Math.max(1, filter.limit ?? 20))]);
  return rows.map((r) => rowToMission(db, r));
}

export function updateMission(db: CoreDatabase, id: string, patch: Partial<Pick<Mission, 'status' | 'resultSummary' | 'reportMessageId' | 'cancelRequestedAt' | 'completedAt'>>): Mission {
  const sets: string[] = ['updatedAt = ?'];
  const args: unknown[] = [nowIso()];
  for (const [k, v] of Object.entries(patch)) { sets.push(`${k} = ?`); args.push(v ?? null); }
  db.run(`UPDATE missions SET ${sets.join(', ')} WHERE id = ?`, [...args, id]);
  return getMission(db, id);
}

export function updateMissionStep(db: CoreDatabase, stepId: string, patch: Partial<Pick<MissionStep, 'status' | 'handoffId' | 'childAttemptId' | 'childConversationId' | 'resultText' | 'error' | 'startedAt' | 'completedAt'>> & { evidence?: MissionStepEvidence | null; artifacts?: MissionArtifact[] }): void {
  const sets: string[] = [];
  const args: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === 'evidence') { sets.push('evidenceJson = ?'); args.push(v ? JSON.stringify(v) : null); }
    else if (k === 'artifacts') { sets.push('artifactsJson = ?'); args.push(JSON.stringify(v ?? [])); }
    else { sets.push(`${k} = ?`); args.push(v ?? null); }
  }
  if (!sets.length) return;
  db.run(`UPDATE mission_steps SET ${sets.join(', ')} WHERE id = ?`, [...args, stepId]);
  const missionId = db.get<{ missionId: string }>('SELECT missionId FROM mission_steps WHERE id = ?', [stepId])?.missionId;
  if (missionId) db.run('UPDATE missions SET updatedAt = ? WHERE id = ?', [nowIso(), missionId]);
}

/**
 * Every attempt a step's approval cards can sit on: the step's own task, the anchors that task owns, and the governed
 * anchor of the step's own conversation (core/domain/capabilityDispatch.ts).
 */
export function missionStepAttemptIds(db: CoreDatabase, step: Pick<MissionStep, 'childAttemptId' | 'childConversationId'>): string[] {
  if (!step.childAttemptId) return [];
  return db.all<{ id: string }>(
    `SELECT id FROM attempts WHERE id = ? OR parentAttemptId = ?
     UNION SELECT anchor.id FROM attempts anchor JOIN requests ar ON ar.id = anchor.requestId
      WHERE ar.routeReason = 'm38_capability_dispatch' AND ar.correlationId = ?`,
    [step.childAttemptId, step.childAttemptId, step.childConversationId ?? '']).map((r) => r.id);
}

/**
 * A step that is over (failed, cancelled, interrupted by a restart) can no longer act on an answer. Its unanswered
 * cards are retired as expired, never as a refusal, so they neither linger as something to decide nor block the
 * conversation (found live: a card left by a restart was restored as the chat's active decision).
 */
export function expireStepApprovals(db: CoreDatabase, step: Pick<MissionStep, 'childAttemptId' | 'childConversationId'>, reason: string): number {
  const ids = missionStepAttemptIds(db, step);
  if (!ids.length) return 0;
  const pending = db.all<{ id: string }>(`SELECT id FROM approvals WHERE status = 'pending' AND attemptId IN (${ids.map(() => '?').join(',')})`, ids);
  let n = 0;
  for (const a of pending) { try { expireApproval(db, a.id, { actor: 'core:mission', reason }); n += 1; } catch { /* answered or expired meanwhile */ } }
  return n;
}

/** Marks the mission for cancellation; the runner stops the running step and settles the rest. */
export function requestMissionCancel(db: CoreDatabase, id: string): Mission {
  const m = getMission(db, id);
  if (TERMINAL_MISSION_STATUSES.has(m.status) || m.status === 'interrupted') return m;
  return updateMission(db, id, { cancelRequestedAt: nowIso() });
}

/**
 * Makes a stopped mission runnable again: steps that did not succeed go back to pending, the ones that did are kept
 * (their results still feed the later steps). Finished missions are never reopened.
 */
export function reopenMission(db: CoreDatabase, id: string): Mission {
  const m = getMission(db, id);
  if (!RESUMABLE_MISSION_STATUSES.has(m.status)) throw new CoreError('invalid_request', `mission is ${m.status}; only a failed, cancelled or interrupted mission can be continued`);
  const active = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM missions WHERE status = 'running'")?.n ?? 0;
  if (active >= MAX_ACTIVE_MISSIONS) throw new CoreError('invalid_request', `${MAX_ACTIVE_MISSIONS} missions are already running`);
  return db.transaction(() => {
    db.run("UPDATE mission_steps SET status = 'pending', error = NULL, handoffId = NULL, childAttemptId = NULL, childConversationId = NULL, resultText = NULL, evidenceJson = NULL, artifactsJson = NULL, startedAt = NULL, completedAt = NULL WHERE missionId = ? AND status NOT IN ('succeeded', 'unverified')", [id]);
    return updateMission(db, id, { status: 'running', cancelRequestedAt: null, completedAt: null, resultSummary: null });
  });
}

/**
 * Boot: a mission that was running when Core stopped has no runner any more. It is marked interrupted (never
 * restarted on its own: a step may have been waiting for an approval or holding the GPU) and can be continued.
 */
export function interruptRunningMissionsOnBoot(db: CoreDatabase): string[] {
  const rows = db.all<{ id: string }>("SELECT id FROM missions WHERE status = 'running'");
  const now = nowIso();
  for (const r of rows) {
    for (const step of db.all<{ childAttemptId: string | null; childConversationId: string | null }>("SELECT childAttemptId, childConversationId FROM mission_steps WHERE missionId = ? AND status = 'running'", [r.id])) {
      try { expireStepApprovals(db, step, 'Pandesh restarted while the mission step that asked was running'); } catch { /* the card expires with its attempt */ }
    }
    db.run("UPDATE mission_steps SET status = 'cancelled', error = 'Pandesh restarted while this step was running', completedAt = ? WHERE missionId = ? AND status = 'running'", [now, r.id]);
    db.run("UPDATE missions SET status = 'interrupted', resultSummary = 'Pandesh restarted while this mission was running. Nothing after the interrupted step ran; it can be continued.', updatedAt = ? WHERE id = ?", [now, r.id]);
  }
  return rows.map((r) => r.id);
}

/** The mission a delegated attempt belongs to (a step's child), if any. */
export function missionForAttempt(db: CoreDatabase, attemptId: string): { missionId: string; stepId: string } | null {
  const row = db.get<{ missionId: string; id: string }>('SELECT missionId, id FROM mission_steps WHERE childAttemptId = ?', [attemptId]);
  return row ? { missionId: row.missionId, stepId: row.id } : null;
}

/** Earlier missions whose objective shares enough subject words with this one, newest first: what worked before. */
export function similarFinishedMissions(db: CoreDatabase, objective: string, limit = 2): Mission[] {
  const words = new Set(objective.toLowerCase().replace(/[^a-z0-9À-ɏ\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 5));
  if (words.size < 2) return [];
  const rows = db.all<Record<string, unknown>>("SELECT * FROM missions WHERE status IN ('completed', 'completed_with_issues') ORDER BY createdAt DESC LIMIT 60");
  const scored = rows.map((r) => {
    const other = new Set(String(r.objective).toLowerCase().replace(/[^a-z0-9À-ɏ\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 5));
    let shared = 0;
    for (const w of words) if (other.has(w)) shared += 1;
    return { r, score: shared / Math.max(1, Math.min(words.size, other.size)), shared };
  }).filter((s) => s.shared >= 2 && s.score >= 0.4).sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => rowToMission(db, s.r));
}
