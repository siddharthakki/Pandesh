/**
 * Capability registry and workflow router on top of the Panda bridge.
 *
 * Not a second scheduler: it only decides WHICH bridge executor runs a task of a given class, and in what order a
 * multi-step workflow's tasks are submitted. Every step is an ordinary bridge task (task id, status, cancel, deadline,
 * receipt), so Pandesh, JUGAAD and the phone all see the same lifecycle.
 *
 * Selection is by declared fit, DEMONSTRATED reliability (the bridge's own completed/failed history for that executor and
 * task class), permissions and resources - never by "is it installed". Discovery is not authorization: external executors
 * are never chosen unless the caller allows them, and nothing falls back to the cloud silently.
 */
import type { CoreDatabase } from '../../db/connection';
import type { BridgeExecutor, ExecutorListing } from './pandaBridge';
import type { BridgeService, ServiceRegistry } from './bridgeServices';

/** A kind of work, e.g. `code.edit`, `filesystem.inspect`, `integrity.verify`, `general.reasoning`. */
export type TaskClass = string;

export interface ExecutorDeclaration {
  /** Bridge executor id (`opencode`, `hermes`, `native`, `service:<id>`). */
  executor: string;
  /** Task class -> how well this executor is meant to handle it (0-100). Static; evidence then adjusts it. */
  classes: Record<TaskClass, number>;
  /** Plain code, no model: the result is reproducible, so no track record is needed. */
  deterministic: boolean;
  /** Never writes outside its own scratch space. */
  readOnly: boolean;
}

/** Declared strengths of the executors Pandesh knows. A new service declares its own classes (BridgeService.taskClasses). */
export const BUILTIN_DECLARATIONS: ExecutorDeclaration[] = [
  { executor: 'opencode', classes: { 'code.edit': 90, 'code.review': 70, 'general.reasoning': 40 }, deterministic: false, readOnly: false },
  { executor: 'hermes', classes: { 'general.reasoning': 80, research: 70, 'code.edit': 40 }, deterministic: false, readOnly: false },
  { executor: 'claude', classes: { 'code.edit': 95, 'code.review': 90, 'general.reasoning': 95, research: 85 }, deterministic: false, readOnly: false },
  { executor: 'native', classes: { 'windows.operate': 70, 'filesystem.inspect': 40, 'text.summarize': 70 }, deterministic: false, readOnly: false },
];

export function declarationForService(s: BridgeService): ExecutorDeclaration {
  const classes: Record<TaskClass, number> = {};
  for (const c of s.taskClasses ?? []) classes[c] = 100;
  return { executor: `service:${s.id}`, classes, deterministic: true, readOnly: s.readOnly };
}

export function allDeclarations(services?: ServiceRegistry, extra: ExecutorDeclaration[] = []): ExecutorDeclaration[] {
  return [...BUILTIN_DECLARATIONS, ...(services?.list().map(declarationForService) ?? []), ...extra];
}

export interface TrackRecord { completed: number; failed: number; independent: number }

/** Outcomes per `executor|taskClass`, read from the bridge's own task history (dispatch checkpoints carry the class). */
export function trackRecords(db: CoreDatabase): Map<string, TrackRecord> {
  const rows = db.all<{ executor: string | null; status: string; verification: string | null; snapshot: string }>(
    `SELECT t.executor AS executor, t.status AS status, json_extract(t.result, '$.verification') AS verification, c.snapshot AS snapshot
       FROM bridge_task_checkpoints c JOIN bridge_tasks t ON t.id = c.taskId
      WHERE c.status = 'dispatching' AND c.snapshot IS NOT NULL AND t.status IN ('completed','failed')`,
  );
  const out = new Map<string, TrackRecord>();
  for (const r of rows) {
    let cls: unknown;
    try { cls = (JSON.parse(r.snapshot) as { taskClass?: unknown }).taskClass; } catch { continue; }
    if (typeof cls !== 'string' || !r.executor) continue;
    const key = `${r.executor}|${cls}`;
    const rec = out.get(key) ?? { completed: 0, failed: 0, independent: 0 };
    if (r.status === 'completed') { rec.completed++; if (r.verification === 'independent') rec.independent++; } else rec.failed++;
    out.set(key, rec);
  }
  return out;
}

export interface RouteRequest {
  taskClass: TaskClass;
  /** Only executors that cannot modify files. */
  readOnly?: boolean;
  /** Only plain-code executors (no model involved). */
  deterministicOnly?: boolean;
  /** External (cloud) executors are excluded unless this is true; the transfer-consent gate still applies at dispatch. */
  allowExternal?: boolean;
}

export interface RouteCandidate {
  executor: string;
  label: string;
  /** Final score; null when excluded. */
  score: number | null;
  excluded: string | null;
  reasons: string[];
  demonstrated: TrackRecord | null;
}

export interface RouteDecision {
  taskClass: TaskClass;
  selected: string | null;
  candidates: RouteCandidate[];
  /** Why nothing was selected; the caller must choose explicitly instead of getting a silent fallback. */
  refusal: string | null;
}

/** Shrunk success rate: 0.5 with no history, approaching the observed rate as evidence accumulates. */
function reliability(r: TrackRecord | undefined): number {
  const done = (r?.completed ?? 0), bad = (r?.failed ?? 0);
  return (done + 1) / (done + bad + 2);
}

export function routeTask(
  req: RouteRequest, listing: ExecutorListing, declarations: ExecutorDeclaration[], records: Map<string, TrackRecord>,
): RouteDecision {
  const candidates: RouteCandidate[] = [];
  for (const d of declarations) {
    const fit = d.classes[req.taskClass];
    if (fit === undefined) continue;
    const e: BridgeExecutor | undefined = listing.executors.find(x => x.id === d.executor);
    const rec = records.get(`${d.executor}|${req.taskClass}`);
    const c: RouteCandidate = { executor: d.executor, label: e?.label ?? d.executor, score: null, excluded: null, reasons: [`declared fit ${fit}`], demonstrated: rec ?? null };
    if (!e) c.excluded = 'not registered with the bridge';
    else if (!e.dispatchable) c.excluded = e.reason ?? 'the coordinator cannot drive it yet';
    else if (!e.available) c.excluded = e.reason ?? 'not available';
    else if (e.external && !req.allowExternal) c.excluded = 'external executor and the caller did not allow external transfer';
    else if (req.readOnly && !d.readOnly) c.excluded = 'can modify files; a read-only task was requested';
    else if (req.deterministicOnly && !d.deterministic) c.excluded = 'uses a model; a deterministic executor was requested';
    if (c.excluded) { candidates.push(c); continue; }

    let score = fit;
    if (d.deterministic) c.reasons.push('deterministic: reproducible result, no track record needed');
    else {
      const rel = reliability(rec);
      score = fit * (0.5 + rel * 0.5);
      c.reasons.push(rec ? `demonstrated ${rec.completed} completed / ${rec.failed} failed (${rec.independent} independently verified)` : 'no demonstrated runs for this class yet');
      if (rec && rec.completed + rec.failed >= 3 && rel < 0.4) { score *= 0.5; c.reasons.push('unreliable so far: score halved'); }
    }
    if (e!.usesLocalGpu && listing.hardware.gpuLanes < 1) { score *= 0.6; c.reasons.push('needs the local GPU but no GPU lane is free'); }
    c.score = Math.round(score * 10) / 10;
    candidates.push(c);
  }
  const ranked = candidates.filter(c => c.score !== null).sort((a, b) => (b.score! - a.score!) || a.executor.localeCompare(b.executor));
  const selected = ranked[0]?.executor ?? null;
  return {
    taskClass: req.taskClass, selected,
    candidates: [...ranked, ...candidates.filter(c => c.score === null)],
    refusal: selected ? null : candidates.length === 0 ? `no executor declares task class '${req.taskClass}'` : 'every executor that declares this class is unavailable or excluded by the request; choose one explicitly',
  };
}

// ------------------------------------------------------------------ workflows

export interface WorkflowStep {
  name: string;
  taskClass: TaskClass;
  readOnly?: boolean;
  deterministicOnly?: boolean;
  /** The instruction for this step, built from the workflow input and the evidence of earlier steps. */
  instruction(input: Record<string, unknown>, previous: Array<{ name: string; evidence: Record<string, unknown> | null }>): string;
  /** A refused or failed optional step does not fail the run: its result is simply absent (e.g. an AI summary on top of collected data). */
  optional?: boolean;
  /** Runs instead of this step, as its own bridge task, only when this step failed and its failure detail matches `when`. */
  fallback?: { when: RegExp; step: Omit<WorkflowStep, 'fallback'> };
}

export interface WorkflowDefinition { id: string; label: string; steps: WorkflowStep[] }

function lastJson(evidence: string | null): Record<string, unknown> | null {
  if (!evidence) return null;
  const m = /\{[\s\S]*\}/.exec(evidence);
  if (!m) return null;
  try { const v = JSON.parse(m[0]); return v && typeof v === 'object' ? v as Record<string, unknown> : null; } catch { return null; }
}
export { lastJson as parseEvidenceJson };

/** Built-in deterministic workflow: inspect a file, then verify its hash against the one just measured or a supplied one. */
export const VERIFY_FILE_WORKFLOW: WorkflowDefinition = {
  id: 'verify-file', label: 'Inspect a file and verify its SHA-256',
  steps: [
    { name: 'inspect', taskClass: 'filesystem.inspect', readOnly: true, deterministicOnly: true, instruction: (i) => JSON.stringify({ path: i.path }) },
    {
      name: 'verify', taskClass: 'integrity.verify', readOnly: true, deterministicOnly: true,
      instruction: (i, prev) => JSON.stringify({ path: i.path, sha256: i.sha256 ?? prev.find(p => p.name === 'inspect')?.evidence?.sha256 }),
    },
  ],
};

/** Extract the text of a PDF: the text layer first, OCR of the page images only when the PDF has no text layer. */
export const EXTRACT_DOCUMENT_WORKFLOW: WorkflowDefinition = {
  id: 'extract-document', label: 'Extract text from a PDF (text layer, else OCR)',
  steps: [{
    name: 'extract', taskClass: 'document.extract', readOnly: true, deterministicOnly: true,
    instruction: (i) => JSON.stringify({ path: i.path }),
    fallback: {
      when: /no text layer/i,
      step: { name: 'ocr', taskClass: 'ocr.pdf', readOnly: true, deterministicOnly: true, instruction: (i) => JSON.stringify({ path: i.path, pages: i.pages, lang: i.lang }) },
    },
  }],
};

/**
 * Daily brief: deterministic collection from what Pandesh already recorded, then (optionally) a model summary of exactly that
 * data. It never starts a research mission; with no model available the collected data is still the result.
 */
export const DAILY_BRIEF_WORKFLOW: WorkflowDefinition = {
  id: 'daily-brief', label: 'Daily brief (collect from Pandesh records, then summarise)',
  steps: [
    { name: 'collect', taskClass: 'brief.daily', readOnly: true, deterministicOnly: true, instruction: () => '{}' },
    {
      name: 'summarize', taskClass: 'text.summarize', optional: true,
      instruction: (_i, prev) => 'Summarise this daily brief for the owner in at most 8 short bullet points. Use only the data below; do not browse, search, run tools or invent anything. If a section is unavailable, say so.\n\n'
        + JSON.stringify(prev.find(p => p.name === 'collect')?.evidence ?? {}).slice(0, 6000),
    },
  ],
};

export const BUILTIN_WORKFLOWS: WorkflowDefinition[] = [VERIFY_FILE_WORKFLOW, EXTRACT_DOCUMENT_WORKFLOW, DAILY_BRIEF_WORKFLOW];
