/**
 * Outcome Receipt — the verified record of what a mission actually did.
 *
 * Aggregates mission + steps + tool/model invocations + approvals + artifacts
 * into a single structured receipt. Core-written, never model-narrated.
 *
 * Evidence levels (from a9bebb4):
 *   observed  — Core saw the tool output
 *   checked   — Core re-ran or re-statted it
 *   reviewed  — an independent Reviewer judged it
 *
 * A sample is never reported as a verification. A technical check is not a
 * content review. Partial/failed steps are never hidden.
 */
import type { CoreDatabase } from '../db/connection';
import { getMission, type Mission, type MissionStep } from '../domain/missions';

export type EvidenceLevel = 'observed' | 'checked' | 'reviewed';

export interface ReceiptOperation { label: string; count: number }

export interface ReceiptVerifiedOutput { label: string; level: EvidenceLevel }

export interface ReceiptPartial { step: number; status: string; reason: string }

export interface OutcomeReceipt {
  missionId: string;
  objective: string;
  status: Mission['status'];
  headline: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  steps: Array<{
    idx: number;
    agentId: string;
    kind: MissionStep['kind'];
    title: string;
    status: MissionStep['status'];
    evidence: MissionStep['evidence'];
    artifacts: MissionStep['artifacts'];
    error: string | null;
    seconds: number | null;
  }>;
  operations: ReceiptOperation[];
  artifacts: Array<{ path: string; bytes: number | null; kind: string; exists: boolean }>;
  verifiedOutputs: ReceiptVerifiedOutput[];
  partialOrFailed: ReceiptPartial[];
  approvalsUsed: number;
  model: string | null;
  provider: string | null;
  tokens: { prompt: number; completion: number } | null;
  costUsd: number | null;
  nextAction: string | null;
  undoAvailable: boolean;
  undoHint: string | null;
  /** True when an independent Reviewer step ran and produced a verdict. */
  independentlyReviewed: boolean;
}

function headlineFor(status: Mission['status']): string {
  if (status === 'completed') return 'Verified';
  if (status === 'completed_with_issues') return 'Completed with issues';
  if (status === 'failed') return 'Not finished';
  if (status === 'cancelled') return 'Cancelled';
  if (status === 'interrupted') return 'Interrupted';
  return 'In progress';
}

export function buildOutcomeReceipt(db: CoreDatabase, missionId: string): OutcomeReceipt {
  const mission = getMission(db, missionId);

  // Aggregate tool invocations across all step attempts.
  const attemptIds = mission.steps.map((s) => s.childAttemptId).filter(Boolean) as string[];
  const toolRows = attemptIds.length
    ? db.all<{ toolName: string; status: string; exitCode: number | null }>(
        `SELECT toolName, status, exitCode FROM tool_invocations WHERE attemptId IN (${attemptIds.map(() => '?').join(',')})`,
        attemptIds,
      )
    : [];
  const modelRows = attemptIds.length
    ? db.all<{ actualModel: string | null; actualProvider: string | null; usageMetadata: string }>(
        `SELECT actualModel, actualProvider, usageMetadata FROM model_invocations WHERE attemptId IN (${attemptIds.map(() => '?').join(',')})`,
        attemptIds,
      )
    : [];
  const approvalCount = attemptIds.length
    ? (db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM approvals WHERE attemptId IN (${attemptIds.map(() => '?').join(',')}) AND status = 'approved'`, attemptIds)?.n ?? 0)
    : 0;

  // Operations: aggregate by category.
  const counts = new Map<string, number>();
  for (const r of toolRows) {
    if (r.status !== 'succeeded') continue;
    const name = r.toolName;
    if (/^write_file$|^propose_file_change$|^propose_text_edit$/.test(name)) counts.set('files written', (counts.get('files written') ?? 0) + 1);
    else if (/^run_checks$/.test(name)) counts.set('checks run', (counts.get('checks run') ?? 0) + 1);
    else if (/^run_command$/.test(name)) counts.set('commands run', (counts.get('commands run') ?? 0) + 1);
    else if (/^web_research$|^governed_research$/.test(name)) counts.set('research queries', (counts.get('research queries') ?? 0) + 1);
    else if (/^pc_organize_/.test(name)) counts.set('organizer actions', (counts.get('organizer actions') ?? 0) + 1);
    else if (/^memory_remember$/.test(name)) counts.set('facts remembered', (counts.get('facts remembered') ?? 0) + 1);
    else if (/^read_file$/.test(name)) counts.set('files read', (counts.get('files read') ?? 0) + 1);
    else if (/^list_directory$/.test(name)) counts.set('directories scanned', (counts.get('directories scanned') ?? 0) + 1);
  }
  // Tests passed: run_checks with exit code 0.
  const testsPassed = toolRows.filter((r) => r.toolName === 'run_checks' && r.status === 'succeeded' && r.exitCode === 0).length;
  if (testsPassed > 0) counts.set('tests passed', testsPassed);
  // Git commits: run_command containing 'git commit' succeeded.
  const gitCommits = toolRows.filter((r) => r.toolName === 'run_command' && r.status === 'succeeded' && /git\s+commit/.test(JSON.stringify(r))).length;
  if (gitCommits > 0) counts.set('git commits', gitCommits);

  const operations: ReceiptOperation[] = [...counts.entries()].map(([label, count]) => ({ label, count }));

  // Artifacts: union of step artifacts.
  const artifacts: OutcomeReceipt['artifacts'] = [];
  for (const s of mission.steps) for (const a of (s.artifacts ?? [])) artifacts.push({ path: a.path, bytes: a.bytes, kind: a.kind, exists: a.exists });

  // Verified outputs with evidence levels. Never manufacture a verified output from completion alone.
  const verifiedOutputs: ReceiptVerifiedOutput[] = [];
  const hasReviewer = mission.steps.some((s) => s.kind === 'review');
  for (const s of mission.steps) {
    if (s.status === 'succeeded' && s.evidence && s.evidence.verified.length > 0) {
      // Caveats downgrade: a step with caveats is not fully "checked".
      const hasCaveats = (s.evidence.caveats ?? []).length > 0;
      const level: EvidenceLevel = s.kind === 'review' ? 'reviewed' : (hasCaveats ? 'observed' : (s.evidence.totalCalls > 0 ? 'checked' : 'observed'));
      for (const v of s.evidence.verified) verifiedOutputs.push({ label: `${v.tool} (${v.count})`, level });
    }
  }

  // Partial / failed steps.
  const partialOrFailed: ReceiptPartial[] = mission.steps
    .filter((s) => s.status !== 'succeeded' && s.status !== 'pending')
    .map((s) => ({ step: s.idx, status: s.status, reason: s.error ?? (s.status === 'unverified' ? 'no tool call backs its report' : s.status) }));

  // Model/provider/tokens.
  const model = modelRows.length ? (modelRows[modelRows.length - 1].actualModel ?? null) : null;
  const provider = modelRows.length ? (modelRows[modelRows.length - 1].actualProvider ?? null) : null;
  let promptTokens = 0, completionTokens = 0, hasTokens = false;
  for (const m of modelRows) {
    try {
      const u = JSON.parse(m.usageMetadata || '{}');
      if (typeof u.promptTokens === 'number') { promptTokens += u.promptTokens; hasTokens = true; }
      if (typeof u.completionTokens === 'number') { completionTokens += u.completionTokens; hasTokens = true; }
    } catch { /* ignore */ }
  }
  const tokens = hasTokens ? { prompt: promptTokens, completion: completionTokens } : null;

  // Duration.
  const started = mission.createdAt ? Date.parse(mission.createdAt) : NaN;
  const completed = mission.completedAt ? Date.parse(mission.completedAt) : NaN;
  const durationMs = Number.isFinite(started) && Number.isFinite(completed) ? completed - started : null;

  // Next action: from resultSummary or last step.
  const nextAction = mission.resultSummary ? String(mission.resultSummary).slice(0, 200) : null;

  // Undo availability: if any organizer action ran (tool ledger or step evidence), or git commit exists.
  const orgApplied = toolRows.some((r) => r.toolName === 'pc_organize_apply' && r.status === 'succeeded') ||
    mission.steps.some((s) => (s.evidence?.verified ?? []).some((v) => v.tool === 'pc_organize_apply'));
  const undoAvailable = orgApplied || gitCommits > 0;
  const undoHint = undoAvailable
    ? (orgApplied ? 'pc_organize_undo available' : 'git revert available')
    : null;

  const independentlyReviewed = hasReviewer && mission.steps.some((s) => s.kind === 'review' && s.status === 'succeeded');

  return {
    missionId: mission.id,
    objective: mission.objective,
    status: mission.status,
    headline: headlineFor(mission.status),
    startedAt: mission.createdAt,
    completedAt: mission.completedAt,
    durationMs,
    steps: mission.steps.map((s) => ({
      idx: s.idx,
      agentId: s.agentId,
      kind: s.kind,
      title: s.title,
      status: s.status,
      evidence: s.evidence,
      artifacts: s.artifacts ?? [],
      error: s.error,
      seconds: s.evidence?.seconds ?? null,
    })),
    operations,
    artifacts,
    verifiedOutputs,
    partialOrFailed,
    approvalsUsed: approvalCount,
    model,
    provider,
    tokens,
    costUsd: null,
    nextAction,
    undoAvailable,
    undoHint,
    independentlyReviewed,
  };
}
