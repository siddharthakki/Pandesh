/**
 * Workflow router: runs a workflow's steps as ordinary bridge tasks, one after another.
 * Each step is routed by the capability registry, submitted, dispatched (same atomic claim, consent gate, deadline and
 * receipt as any task), observed until it reaches a terminal state, and its evidence feeds the next step.
 * A failed, cancelled or timed-out step stops the run; nothing is retried on another executor behind the caller's back.
 */
import type { BridgePairing, BridgeTaskRecord } from '../../domain/pandaBridge';
import { getBridgeTask, submitBridgeTask } from '../../domain/pandaBridge';
import { CoreError } from '../../domain/errors';
import { discoverExecutors, dispatchBridgeTask, refreshBridgeTask, type BridgeRuntime } from './pandaBridge';
import {
  allDeclarations, parseEvidenceJson, routeTask, trackRecords, type RouteDecision, type WorkflowDefinition, type WorkflowStep,
} from './capabilityRegistry';

export interface WorkflowStepRun {
  name: string;
  taskClass: string;
  route: RouteDecision;
  taskId: string | null;
  executor: string | null;
  status: string;
  detail: string | null;
  verification: string | null;
  evidence: Record<string, unknown> | null;
}

export interface WorkflowRun {
  workflow: string;
  runId: string;
  /** completed | failed | timeout | refused */
  status: 'completed' | 'failed' | 'timeout' | 'refused';
  steps: WorkflowStepRun[];
}

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'needs_attention', 'awaiting_approval']);

/** Dry run: which executor each step would use now, and why. Starts nothing. */
export async function planWorkflow(rt: BridgeRuntime, def: WorkflowDefinition): Promise<Array<{ name: string; taskClass: string; route: RouteDecision }>> {
  const listing = await discoverExecutors(rt.kandev, { nativeAvailable: Boolean(rt.executor), ...(rt.services ? { services: rt.services } : {}) });
  const decls = allDeclarations(rt.services);
  const records = trackRecords(rt.db);
  return def.steps.map(s => ({
    name: s.name, taskClass: s.taskClass,
    route: routeTask({ taskClass: s.taskClass, ...(s.readOnly ? { readOnly: true } : {}), ...(s.deterministicOnly ? { deterministicOnly: true } : {}) }, listing, decls, records),
  }));
}

export async function runWorkflow(
  rt: BridgeRuntime, pairing: BridgePairing, def: WorkflowDefinition, input: Record<string, unknown>,
  opts: { runId: string; decidedBy: string; timeoutMs?: number; pollMs?: number },
): Promise<WorkflowRun> {
  const timeoutMs = opts.timeoutMs ?? 120_000, pollMs = opts.pollMs ?? 100;
  const run: WorkflowRun = { workflow: def.id, runId: opts.runId, status: 'completed', steps: [] };
  const previous: Array<{ name: string; evidence: Record<string, unknown> | null }> = [];

  const execute = async (step: WorkflowStep, name: string, i: number): Promise<WorkflowStepRun> => {
    const listing = await discoverExecutors(rt.kandev, { nativeAvailable: Boolean(rt.executor), ...(rt.services ? { services: rt.services } : {}) });
    const route = routeTask(
      { taskClass: step.taskClass, ...(step.readOnly ? { readOnly: true } : {}), ...(step.deterministicOnly ? { deterministicOnly: true } : {}) },
      listing, allDeclarations(rt.services), trackRecords(rt.db),
    );
    // Each step has its own time limit (a model summary legitimately takes minutes; a hash check takes milliseconds).
    const deadline = Date.now() + (step.timeoutMs ?? timeoutMs);
    const rec: WorkflowStepRun = { name, taskClass: step.taskClass, route, taskId: null, executor: route.selected, status: 'refused', detail: route.refusal, verification: null, evidence: null };
    run.steps.push(rec);
    if (!route.selected) return rec;

    let task: BridgeTaskRecord;
    try {
      ({ task } = submitBridgeTask(rt.db, pairing, { clientRequestId: `${opts.runId}-${i + 1}-${name}`.slice(0, 100), instruction: step.instruction(input, previous) }));
      rec.taskId = task.id;
      await dispatchBridgeTask(rt, task.id, { executor: route.selected, taskClass: step.taskClass, decidedBy: opts.decidedBy, authority: 'extension' });
    } catch (err) {
      rec.status = 'refused'; rec.detail = err instanceof Error ? err.message : String(err);
      return rec;
    }
    for (;;) {
      task = await refreshBridgeTask(rt, task.id);
      if (TERMINAL.has(task.status)) break;
      if (Date.now() > deadline) { rec.status = 'timeout'; rec.detail = 'the workflow timeout passed; the task keeps its own deadline and can still be cancelled'; return rec; }
      await new Promise(r => setTimeout(r, pollMs));
    }
    task = getBridgeTask(rt.db, task.id);
    rec.status = task.status; rec.detail = task.statusDetail; rec.verification = task.result?.verification ?? null;
    rec.evidence = parseEvidenceJson(task.result?.evidence ?? null);
    return rec;
  };

  for (let i = 0; i < def.steps.length; i++) {
    const step = def.steps[i]!;
    let rec = await execute(step, step.name, i);
    // A declared fallback runs only when the step FAILED with a matching reason; it is another ordinary bridge task, never a silent retry.
    if (rec.status === 'failed' && step.fallback && step.fallback.when.test(rec.detail ?? '')) {
      rec = await execute(step.fallback.step, `${step.name}:fallback`, i);
    }
    // An optional step that was refused or failed is simply absent from the result; the run still completes.
    if (step.optional && ['refused', 'failed', 'cancelled'].includes(rec.status)) { rec.detail = `skipped (optional): ${rec.detail ?? rec.status}`; continue; }
    if (rec.status === 'refused') { run.status = 'refused'; return run; }
    if (rec.status === 'timeout') { run.status = 'timeout'; return run; }
    previous.push({ name: step.name, evidence: rec.evidence });
    if (rec.status !== 'completed') { run.status = 'failed'; return run; }
  }
  return run;
}
