/**
 * Durable state of a master-operator run: the run, its ordered steps and an event trail.
 *
 * Everything the engine decides is written here before it acts, so a restart resumes from the stored step instead of
 * starting over, and the user can see which tool was chosen for each step, why, and what evidence came back.
 */
import type { CoreDatabase } from '../db/connection';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import type { Considered, PrivacyClass, RunConsent, StepKind, WorkflowKind, WorkflowPlan } from './operatorPlan';

export type OperatorRunStatus = 'running' | 'awaiting_approval' | 'blocked' | 'completed' | 'failed' | 'cancelled';
export type OperatorStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'succeeded' | 'failed' | 'skipped' | 'blocked';
export const TERMINAL_RUN_STATUSES: ReadonlySet<OperatorRunStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface OperatorRun {
  id: string;
  instruction: string;
  workflow: WorkflowKind;
  privacy: PrivacyClass;
  privacyReasons: string[];
  pinnedTool: string | null;
  pinnedModel: string | null;
  consent: RunConsent;
  status: OperatorRunStatus;
  statusDetail: string | null;
  /** Small cross-step state (resolved folder, chosen model, bridge task id). Never document text. */
  context: Record<string, unknown>;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface OperatorStep {
  id: string;
  runId: string;
  idx: number;
  kind: StepKind;
  title: string;
  needs: string | null;
  approval: 'egress' | 'file_move' | null;
  status: OperatorStepStatus;
  attempts: number;
  maxAttempts: number;
  tool: string | null;
  selection: Considered[] | null;
  output: Record<string, unknown> | null;
  evidence: string | null;
  error: string | null;
  decidedBy: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface OperatorEvent { id: number; runId: string; stepIdx: number | null; kind: string; detail: string | null; at: string }

function json<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || !raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

const toRun = (r: Record<string, unknown>): OperatorRun => ({
  id: String(r.id), instruction: String(r.instruction), workflow: r.workflow as WorkflowKind, privacy: r.privacy as PrivacyClass,
  privacyReasons: json<string[]>(r.privacyReasons, []), pinnedTool: (r.pinnedTool as string) ?? null, pinnedModel: (r.pinnedModel as string) ?? null,
  consent: json<RunConsent>(r.consent, {}), status: r.status as OperatorRunStatus, statusDetail: (r.statusDetail as string) ?? null,
  context: json<Record<string, unknown>>(r.context, {}), result: json<Record<string, unknown> | null>(r.result, null),
  createdAt: String(r.createdAt), updatedAt: String(r.updatedAt), completedAt: (r.completedAt as string) ?? null,
});

const toStep = (r: Record<string, unknown>): OperatorStep => ({
  id: String(r.id), runId: String(r.runId), idx: Number(r.idx), kind: r.kind as StepKind, title: String(r.title), needs: (r.needs as string) ?? null,
  approval: (r.approval as OperatorStep['approval']) ?? null, status: r.status as OperatorStepStatus, attempts: Number(r.attempts), maxAttempts: Number(r.maxAttempts),
  tool: (r.tool as string) ?? null, selection: json<Considered[] | null>(r.selection, null), output: json<Record<string, unknown> | null>(r.output, null),
  evidence: (r.evidence as string) ?? null, error: (r.error as string) ?? null, decidedBy: (r.decidedBy as string) ?? null,
  startedAt: (r.startedAt as string) ?? null, completedAt: (r.completedAt as string) ?? null,
});

export function getOperatorRun(db: CoreDatabase, id: string): OperatorRun {
  const row = db.get<Record<string, unknown>>('SELECT * FROM operator_runs WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `operator run '${id}' not found`);
  return toRun(row);
}

export function listOperatorRuns(db: CoreDatabase, limit = 50): OperatorRun[] {
  return db.all<Record<string, unknown>>('SELECT * FROM operator_runs ORDER BY createdAt DESC, id LIMIT ?', [limit]).map(toRun);
}

export function listOperatorSteps(db: CoreDatabase, runId: string): OperatorStep[] {
  return db.all<Record<string, unknown>>('SELECT * FROM operator_steps WHERE runId = ? ORDER BY idx', [runId]).map(toStep);
}

export function listOperatorEvents(db: CoreDatabase, runId: string, limit = 200): OperatorEvent[] {
  return db.all<Record<string, unknown>>('SELECT * FROM operator_events WHERE runId = ? ORDER BY id LIMIT ?', [runId, limit]).map(r => ({
    id: Number(r.id), runId: String(r.runId), stepIdx: r.stepIdx == null ? null : Number(r.stepIdx), kind: String(r.kind), detail: (r.detail as string) ?? null, at: String(r.at),
  }));
}

export function recordOperatorEvent(db: CoreDatabase, runId: string, kind: string, detail: string | null, stepIdx: number | null = null): void {
  db.run('INSERT INTO operator_events (runId, stepIdx, kind, detail, at) VALUES (?, ?, ?, ?, ?)', [runId, stepIdx, kind, detail ? detail.slice(0, 600) : null, nowIso()]);
}

export function createOperatorRun(db: CoreDatabase, input: {
  instruction: string; plan: WorkflowPlan; pinnedTool?: string | null; pinnedModel?: string | null; consent?: RunConsent; context?: Record<string, unknown>;
}): OperatorRun {
  const id = newId('orun');
  const now = nowIso();
  db.transaction(() => {
    db.run(
      `INSERT INTO operator_runs (id, instruction, workflow, privacy, privacyReasons, pinnedTool, pinnedModel, consent, status, statusDetail, context, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', 'Planned.', ?, ?, ?)`,
      [id, input.instruction, input.plan.workflow, input.plan.privacy, JSON.stringify(input.plan.privacyReasons), input.pinnedTool ?? null, input.pinnedModel ?? null,
        JSON.stringify(input.consent ?? {}), JSON.stringify(input.context ?? {}), now, now],
    );
    input.plan.steps.forEach((s, idx) => {
      db.run(
        'INSERT INTO operator_steps (id, runId, idx, kind, title, needs, approval, status, attempts, maxAttempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)',
        [newId('ostep'), id, idx, s.kind, s.title, s.needs, s.approval, 'pending', s.maxAttempts],
      );
    });
    recordOperatorEvent(db, id, 'planned', `${input.plan.workflow} · ${input.plan.privacy} · ${input.plan.steps.length} steps`);
  });
  return getOperatorRun(db, id);
}

export function updateOperatorRun(db: CoreDatabase, id: string, patch: {
  status?: OperatorRunStatus; statusDetail?: string | null; context?: Record<string, unknown>; result?: Record<string, unknown> | null; consent?: RunConsent;
}): OperatorRun {
  const current = getOperatorRun(db, id);
  if (TERMINAL_RUN_STATUSES.has(current.status) && patch.status && patch.status !== current.status) return current;
  const status = patch.status ?? current.status;
  const now = nowIso();
  db.run(
    'UPDATE operator_runs SET status = ?, statusDetail = ?, context = ?, result = ?, consent = ?, updatedAt = ?, completedAt = ? WHERE id = ?',
    [status, patch.statusDetail === undefined ? current.statusDetail : patch.statusDetail, JSON.stringify(patch.context ?? current.context),
      JSON.stringify(patch.result === undefined ? current.result : patch.result), JSON.stringify(patch.consent ?? current.consent), now,
      TERMINAL_RUN_STATUSES.has(status) ? (current.completedAt ?? now) : null, id],
  );
  if (patch.status && patch.status !== current.status) recordOperatorEvent(db, id, `run_${patch.status}`, patch.statusDetail ?? null);
  return getOperatorRun(db, id);
}

export function updateOperatorStep(db: CoreDatabase, runId: string, idx: number, patch: Partial<Pick<OperatorStep, 'status' | 'tool' | 'selection' | 'output' | 'evidence' | 'error' | 'decidedBy'>> & { attemptsDelta?: number; resetAttempts?: boolean }): OperatorStep {
  const row = db.get<Record<string, unknown>>('SELECT * FROM operator_steps WHERE runId = ? AND idx = ?', [runId, idx]);
  if (!row) throw new CoreError('not_found', `step ${idx} of run '${runId}' not found`);
  const cur = toStep(row);
  const status = patch.status ?? cur.status;
  const now = nowIso();
  db.run(
    'UPDATE operator_steps SET status = ?, attempts = ?, tool = ?, selection = ?, output = ?, evidence = ?, error = ?, decidedBy = ?, startedAt = ?, completedAt = ? WHERE runId = ? AND idx = ?',
    [status, patch.resetAttempts ? 0 : cur.attempts + (patch.attemptsDelta ?? 0), patch.tool === undefined ? cur.tool : patch.tool,
      JSON.stringify(patch.selection === undefined ? cur.selection : patch.selection), JSON.stringify(patch.output === undefined ? cur.output : patch.output),
      patch.evidence === undefined ? cur.evidence : patch.evidence, patch.error === undefined ? cur.error : patch.error, patch.decidedBy === undefined ? cur.decidedBy : patch.decidedBy,
      status === 'running' ? (cur.startedAt ?? now) : cur.startedAt, ['succeeded', 'failed', 'skipped', 'blocked'].includes(status) ? now : null, runId, idx],
  );
  if (patch.status && patch.status !== cur.status) recordOperatorEvent(db, runId, `step_${patch.status}`, `${cur.title}${patch.tool ? ` · ${patch.tool}` : ''}${patch.error ? ` · ${patch.error}` : ''}`, idx);
  return toStep(db.get<Record<string, unknown>>('SELECT * FROM operator_steps WHERE runId = ? AND idx = ?', [runId, idx])!);
}
