import { createHash } from 'crypto';

export type PlanStatus = 'proposed' | 'approved' | 'running' | 'completed' | 'blocked' | 'cancelled';
export type PlanStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface PlanAssumption {
  id: string;
  statement: string;
  confidence: number;
  status: 'unverified' | 'supported' | 'invalidated';
  evidenceIds: string[];
}

export interface PlanHypothesis {
  id: string;
  statement: string;
  confidence: number;
  status: 'active' | 'supported' | 'rejected';
  evidenceIds: string[];
}

export interface PlanEvidence {
  id: string;
  kind: 'observation' | 'test' | 'diagnostic' | 'user' | 'tool' | 'review';
  summary: string;
  supports?: string[];
  invalidates?: string[];
  timestamp: string;
  data?: Record<string, unknown>;
}

export interface AdaptivePlanStep {
  id: string;
  goal: string;
  dependencies: string[];
  status: PlanStepStatus;
  confidence: number;
  evidenceRequired: string[];
  stopConditions: string[];
  allowedPaths: string[];
  scope: 'investigation' | 'implementation' | 'validation' | 'review';
}

export interface AdaptivePlan {
  schemaVersion: 1;
  planId: string;
  taskId: string;
  goal: string;
  status: PlanStatus;
  revision: number;
  createdAt: string;
  updatedAt: string;
  approvedRevision?: number;
  assumptions: PlanAssumption[];
  hypotheses: PlanHypothesis[];
  evidence: PlanEvidence[];
  steps: AdaptivePlanStep[];
  scopeFingerprint: string;
  history: PlanRevisionRecord[];
}

export interface PlanRevisionRecord {
  revision: number;
  timestamp: string;
  reason: string;
  addedSteps: string[];
  removedSteps: string[];
  changedSteps: string[];
  materialScopeExpansion: boolean;
  approved: boolean;
}

export interface PlanRevisionProposal {
  reason: string;
  assumptions?: PlanAssumption[];
  hypotheses?: PlanHypothesis[];
  steps: AdaptivePlanStep[];
}

export interface PlanRevisionResult {
  plan: AdaptivePlan;
  approvalRequired: boolean;
  materialScopeExpansion: boolean;
  diff: Omit<PlanRevisionRecord, 'revision' | 'timestamp' | 'approved'>;
}

export class AdaptivePlanner {
  private plan?: AdaptivePlan;

  create(input: {
    planId: string;
    taskId: string;
    goal: string;
    assumptions?: PlanAssumption[];
    hypotheses?: PlanHypothesis[];
    steps: AdaptivePlanStep[];
  }): AdaptivePlan {
    if (this.plan) throw new Error('Adaptive planner already has a plan.');
    validateId(input.planId, 'plan');
    validateId(input.taskId, 'task');
    validateSteps(input.steps);
    const now = new Date().toISOString();
    this.plan = {
      schemaVersion: 1,
      planId: input.planId,
      taskId: input.taskId,
      goal: input.goal.trim(),
      status: 'proposed',
      revision: 1,
      createdAt: now,
      updatedAt: now,
      assumptions: (input.assumptions ?? []).map(normalizeAssumption),
      hypotheses: (input.hypotheses ?? []).map(normalizeHypothesis),
      evidence: [],
      steps: input.steps.map(normalizeStep),
      scopeFingerprint: scopeFingerprint(input.steps),
      history: [{
        revision: 1,
        timestamp: now,
        reason: 'Initial plan proposed.',
        addedSteps: input.steps.map(step => step.id).sort(),
        removedSteps: [],
        changedSteps: [],
        materialScopeExpansion: false,
        approved: false,
      }],
    };
    return this.snapshot();
  }

  approve(revision?: number): AdaptivePlan {
    const plan = this.requirePlan();
    const target = revision ?? plan.revision;
    if (target !== plan.revision) throw new Error(`Cannot approve stale plan revision ${target}.`);
    plan.status = 'approved';
    plan.approvedRevision = plan.revision;
    plan.updatedAt = new Date().toISOString();
    const history = plan.history.find(record => record.revision === plan.revision);
    if (history) history.approved = true;
    return this.snapshot();
  }

  start(): AdaptivePlan {
    const plan = this.requirePlan();
    if (plan.status !== 'approved') throw new Error('Plan must be approved before execution.');
    plan.status = 'running';
    plan.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  recordEvidence(evidence: Omit<PlanEvidence, 'timestamp'> & { timestamp?: string }): AdaptivePlan {
    const plan = this.requirePlan();
    validateId(evidence.id, 'evidence');
    if (plan.evidence.some(item => item.id === evidence.id)) throw new Error(`Duplicate evidence: ${evidence.id}`);
    const normalized: PlanEvidence = {
      ...evidence,
      timestamp: evidence.timestamp ?? new Date().toISOString(),
      supports: [...new Set(evidence.supports ?? [])],
      invalidates: [...new Set(evidence.invalidates ?? [])],
      data: evidence.data ? clone(evidence.data) : undefined,
    };
    plan.evidence.push(normalized);
    for (const id of normalized.supports ?? []) {
      const assumption = plan.assumptions.find(item => item.id === id);
      if (assumption) {
        assumption.status = 'supported';
        assumption.evidenceIds.push(normalized.id);
        assumption.confidence = Math.min(1, assumption.confidence + 0.2);
      }
      const hypothesis = plan.hypotheses.find(item => item.id === id);
      if (hypothesis) {
        hypothesis.status = 'supported';
        hypothesis.evidenceIds.push(normalized.id);
        hypothesis.confidence = Math.min(1, hypothesis.confidence + 0.2);
      }
    }
    for (const id of normalized.invalidates ?? []) {
      const assumption = plan.assumptions.find(item => item.id === id);
      if (assumption) {
        assumption.status = 'invalidated';
        assumption.evidenceIds.push(normalized.id);
        assumption.confidence = 0;
      }
      const hypothesis = plan.hypotheses.find(item => item.id === id);
      if (hypothesis) {
        hypothesis.status = 'rejected';
        hypothesis.evidenceIds.push(normalized.id);
        hypothesis.confidence = 0;
      }
    }
    if (plan.assumptions.some(item => item.status === 'invalidated') || plan.hypotheses.some(item => item.status === 'rejected')) {
      plan.status = 'blocked';
    }
    plan.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  proposeRevision(proposal: PlanRevisionProposal): PlanRevisionResult {
    const plan = this.requirePlan();
    validateSteps(proposal.steps);
    const diff = diffSteps(plan.steps, proposal.steps);
    const materialScopeExpansion = detectMaterialScopeExpansion(plan.steps, proposal.steps);
    const nextRevision = plan.revision + 1;
    const now = new Date().toISOString();
    plan.revision = nextRevision;
    plan.updatedAt = now;
    plan.status = 'proposed';
    plan.assumptions = (proposal.assumptions ?? plan.assumptions).map(normalizeAssumption);
    plan.hypotheses = (proposal.hypotheses ?? plan.hypotheses).map(normalizeHypothesis);
    plan.steps = proposal.steps.map(normalizeStep);
    plan.scopeFingerprint = scopeFingerprint(plan.steps);
    plan.history.push({
      revision: nextRevision,
      timestamp: now,
      reason: proposal.reason,
      ...diff,
      materialScopeExpansion,
      approved: false,
    });
    return {
      plan: this.snapshot(),
      approvalRequired: true,
      materialScopeExpansion,
      diff: { ...diff, reason: proposal.reason, materialScopeExpansion },
    };
  }

  nextReadySteps(limit = 1): AdaptivePlanStep[] {
    const plan = this.requirePlan();
    if (plan.status !== 'running') return [];
    return plan.steps
      .filter(step => step.status === 'pending')
      .filter(step => step.dependencies.every(id => plan.steps.find(candidate => candidate.id === id)?.status === 'completed'))
      .sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Math.min(limit, 50)))
      .map(cloneStep);
  }

  updateStep(stepId: string, status: PlanStepStatus, evidenceIds: string[] = []): AdaptivePlan {
    const plan = this.requirePlan();
    const step = plan.steps.find(item => item.id === stepId);
    if (!step) throw new Error(`Unknown plan step: ${stepId}`);
    for (const evidenceId of evidenceIds) {
      if (!plan.evidence.some(item => item.id === evidenceId)) throw new Error(`Unknown evidence: ${evidenceId}`);
    }
    step.status = status;
    if (status === 'failed') plan.status = 'blocked';
    if (plan.steps.every(item => item.status === 'completed' || item.status === 'skipped')) plan.status = 'completed';
    plan.updatedAt = new Date().toISOString();
    return this.snapshot();
  }

  needsReplan(): boolean {
    const plan = this.requirePlan();
    return plan.status === 'blocked' || plan.assumptions.some(item => item.status === 'invalidated') || plan.hypotheses.some(item => item.status === 'rejected');
  }

  snapshot(): AdaptivePlan {
    return clone(this.requirePlan());
  }

  private requirePlan(): AdaptivePlan {
    if (!this.plan) throw new Error('No adaptive plan exists.');
    return this.plan;
  }
}

function normalizeAssumption(value: PlanAssumption): PlanAssumption {
  validateId(value.id, 'assumption');
  validateConfidence(value.confidence, value.id);
  return { ...value, evidenceIds: [...new Set(value.evidenceIds ?? [])] };
}

function normalizeHypothesis(value: PlanHypothesis): PlanHypothesis {
  validateId(value.id, 'hypothesis');
  validateConfidence(value.confidence, value.id);
  return { ...value, evidenceIds: [...new Set(value.evidenceIds ?? [])] };
}

function normalizeStep(value: AdaptivePlanStep): AdaptivePlanStep {
  validateId(value.id, 'step');
  validateConfidence(value.confidence, value.id);
  return {
    ...value,
    dependencies: [...new Set(value.dependencies ?? [])].sort(),
    evidenceRequired: [...new Set(value.evidenceRequired ?? [])].sort(),
    stopConditions: [...new Set(value.stopConditions ?? [])],
    allowedPaths: [...new Set((value.allowedPaths ?? []).map(normalizePath))].sort(),
    status: value.status ?? 'pending',
  };
}

function validateSteps(steps: AdaptivePlanStep[]): void {
  if (steps.length === 0) throw new Error('Adaptive plan requires at least one step.');
  const ids = new Set<string>();
  for (const step of steps) {
    const normalized = normalizeStep(step);
    if (ids.has(normalized.id)) throw new Error(`Duplicate plan step: ${normalized.id}`);
    ids.add(normalized.id);
  }
  for (const step of steps) {
    for (const dependency of step.dependencies ?? []) {
      if (!ids.has(dependency)) throw new Error(`Step ${step.id} depends on missing step ${dependency}.`);
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map(step => [step.id, step]));
  const visit = (id: string) => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Plan dependency cycle at ${id}.`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  steps.forEach(step => visit(step.id));
}

function diffSteps(previous: AdaptivePlanStep[], next: AdaptivePlanStep[]) {
  const before = new Map(previous.map(step => [step.id, step]));
  const after = new Map(next.map(step => [step.id, step]));
  const addedSteps = [...after.keys()].filter(id => !before.has(id)).sort();
  const removedSteps = [...before.keys()].filter(id => !after.has(id)).sort();
  const changedSteps = [...after.keys()].filter(id => before.has(id) && stableStep(before.get(id)!) !== stableStep(after.get(id)!)).sort();
  return { addedSteps, removedSteps, changedSteps };
}

function detectMaterialScopeExpansion(previous: AdaptivePlanStep[], next: AdaptivePlanStep[]): boolean {
  const before = new Set(previous.flatMap(step => step.allowedPaths));
  const after = new Set(next.flatMap(step => step.allowedPaths));
  if ([...after].some(path => ![...before].some(existing => path === existing || path.startsWith(`${existing}/`)))) return true;
  const priorScopes = new Set(previous.map(step => step.scope));
  return next.some(step => !priorScopes.has(step.scope) && step.scope === 'implementation');
}

function scopeFingerprint(steps: AdaptivePlanStep[]): string {
  const material = steps
    .map(step => ({ id: step.id, scope: step.scope, paths: [...step.allowedPaths].sort() }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}

function stableStep(step: AdaptivePlanStep): string {
  const cloneValue = { ...step, status: undefined };
  return JSON.stringify(cloneValue, Object.keys(cloneValue).sort());
}

function validateConfidence(value: number, id: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Confidence for ${id} must be between 0 and 1.`);
}

function validateId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) throw new Error(`Invalid ${label} id: ${value}`);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized.startsWith('/') || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Invalid plan path: ${value}`);
  }
  return normalized;
}

function cloneStep(step: AdaptivePlanStep): AdaptivePlanStep {
  return clone(step);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
