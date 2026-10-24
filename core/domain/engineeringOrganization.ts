import { createHash, randomUUID } from 'node:crypto';
import type { CoreDatabase } from '../db/connection';
import type {
  EngineeringAssignmentRecord,
  EngineeringCiConclusion,
  EngineeringCiEvidenceRecord,
  EngineeringProductRequestRecord,
  EngineeringSprintItemRecord,
  EngineeringSprintRecord,
} from '../shared/wireTypes';
import { CoreError } from './errors';
import { newId, nowIso } from './ids';
import * as dependencies from './dependencies';
import * as stories from './stories';
import { submitRequest } from './submission';
import { getAttempt } from './attempts';
import { getRequest } from './requests';

type Row = Record<string, unknown>;

export interface ProductRequestInput {
  projectId: string;
  repositoryId?: string | null;
  title: string;
  goal: string;
  acceptanceCriteria: string[];
  definitionOfReady: string[];
  definitionOfDone: string[];
  dependencies?: string[];
  estimatedPoints: number;
  actor: string;
  clientId?: string | null;
}

export interface DispatchInput {
  sprintId: string;
  workerIds: string[];
  leaseMs: number;
  workspaceRoot: string;
  selectedProvider: string;
  selectedModel: string;
  actor: string;
  clientId: string;
}

function json(value: unknown): string { return JSON.stringify(value); }
function array(value: unknown): string[] { try { return JSON.parse(String(value ?? '[]')) as string[]; } catch { return []; } }
function object(value: unknown): Record<string, unknown> | null { try { return value ? JSON.parse(String(value)) as Record<string, unknown> : null; } catch { return null; } }
function product(row: Row): EngineeringProductRequestRecord {
  return { id: String(row.id), projectId: String(row.projectId), repositoryId: row.repositoryId as string ?? null, title: String(row.title), goal: String(row.goal), acceptanceCriteria: array(row.acceptanceCriteria), definitionOfReady: array(row.definitionOfReady), definitionOfDone: array(row.definitionOfDone), dependencies: array(row.dependencies), estimatedPoints: Number(row.estimatedPoints), status: row.status as EngineeringProductRequestRecord['status'], storyId: row.storyId as string ?? null, approvedAt: row.approvedAt as string ?? null, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) };
}
function sprint(row: Row): EngineeringSprintRecord {
  return { id: String(row.id), projectId: String(row.projectId), repositoryId: row.repositoryId as string ?? null, name: String(row.name), goal: String(row.goal), state: row.state as EngineeringSprintRecord['state'], capacityPoints: Number(row.capacityPoints), wipLimit: Number(row.wipLimit), createdAt: String(row.createdAt), startedAt: row.startedAt as string ?? null, completedAt: row.completedAt as string ?? null, review: object(row.review), retrospective: object(row.retrospective) };
}
function item(row: Row): EngineeringSprintItemRecord { return { sprintId: String(row.sprintId), storyId: String(row.storyId), ordinal: Number(row.ordinal), estimatedPoints: Number(row.estimatedPoints), state: row.state as EngineeringSprintItemRecord['state'] }; }
function assignment(row: Row): EngineeringAssignmentRecord { return { id: String(row.id), sprintId: String(row.sprintId), storyId: String(row.storyId), attemptId: row.attemptId as string ?? null, workerId: String(row.workerId), leaseToken: String(row.leaseToken), leaseExpiresAt: String(row.leaseExpiresAt), state: row.state as EngineeringAssignmentRecord['state'], createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) }; }
function ci(row: Row): EngineeringCiEvidenceRecord { return { id: String(row.id), storyId: String(row.storyId), sourceAttemptId: row.sourceAttemptId as string ?? null, repairStoryId: row.repairStoryId as string ?? null, repairAttemptId: row.repairAttemptId as string ?? null, pullRequestUrl: String(row.pullRequestUrl), headSha: String(row.headSha), runId: String(row.runId), conclusion: row.conclusion as EngineeringCiConclusion, failureFingerprint: row.failureFingerprint as string ?? null, diagnosis: row.diagnosis as string ?? null, regressionTests: array(row.regressionTests), replacementRunId: row.replacementRunId as string ?? null, replacementHeadSha: row.replacementHeadSha as string ?? null, reviewedAt: row.reviewedAt as string ?? null, mergedAt: row.mergedAt as string ?? null, mergedBy: row.mergedBy as string ?? null, createdAt: String(row.createdAt), updatedAt: String(row.updatedAt) }; }
function required(value: string, name: string): string { const result = value.trim(); if (!result) throw new CoreError('invalid_request', `${name} is required`); return result; }
function dor(input: ProductRequestInput): string[] {
  const errors: string[] = [];
  if (!input.goal.trim()) errors.push('goal');
  if (!input.acceptanceCriteria.length) errors.push('acceptanceCriteria');
  if (!input.definitionOfReady.length) errors.push('definitionOfReady');
  if (!input.definitionOfDone.length) errors.push('definitionOfDone');
  if (!Number.isInteger(input.estimatedPoints) || input.estimatedPoints < 1 || input.estimatedPoints > 13) errors.push('estimatedPoints');
  return errors;
}

export function createProductRequest(db: CoreDatabase, input: ProductRequestInput): EngineeringProductRequestRecord {
  const errors = dor(input);
  if (errors.length) throw new CoreError('invalid_request', `Definition of Ready failed: ${errors.join(', ')}`);
  return db.transaction(() => {
    if (!db.get('SELECT id FROM projects WHERE id = ?', [input.projectId])) throw new CoreError('not_found', `project '${input.projectId}' not found`);
    const now = nowIso(); const id = newId('engreq');
    db.run(`INSERT INTO engineering_product_requests (id, projectId, repositoryId, title, goal, acceptanceCriteria, definitionOfReady, definitionOfDone, dependencies, estimatedPoints, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`, [id, input.projectId, input.repositoryId ?? null, required(input.title, 'title'), required(input.goal, 'goal'), json(input.acceptanceCriteria), json(input.definitionOfReady), json(input.definitionOfDone), json(input.dependencies ?? []), input.estimatedPoints, now, now]);
    return getProductRequest(db, id);
  });
}

export function getProductRequest(db: CoreDatabase, id: string): EngineeringProductRequestRecord {
  const row = db.get<Row>('SELECT * FROM engineering_product_requests WHERE id = ?', [id]);
  if (!row) throw new CoreError('not_found', `engineering product request '${id}' not found`);
  return product(row);
}

/** The approval is an explicit product decision. It creates one Core story in
 * the same transaction, so an approved request can never exist without its
 * reviewable board item. */
export function approveProductRequest(db: CoreDatabase, id: string, actor: string, clientId?: string | null): EngineeringProductRequestRecord {
  return db.transaction(() => {
    const request = getProductRequest(db, id);
    if (request.status === 'approved') return request;
    if (request.status !== 'draft') throw new CoreError('invalid_transition', `product request '${id}' is ${request.status}`);
    const story = stories.createStory(db, { projectId: request.projectId, repositoryId: request.repositoryId, title: request.title, description: request.goal, acceptanceCriteria: request.acceptanceCriteria, priority: 'high', status: 'ready', storyType: 'story', source: { kind: 'm37_product_request', requestId: id, definitionOfReady: request.definitionOfReady, definitionOfDone: request.definitionOfDone }, actor, clientId });
    for (const dependencyId of request.dependencies) dependencies.addDependency(db, { storyId: story.id, dependsOnStoryId: dependencyId, dependencyType: 'blocks', actor, clientId });
    const now = nowIso();
    db.run("UPDATE engineering_product_requests SET status = 'approved', storyId = ?, approvedAt = ?, updatedAt = ? WHERE id = ?", [story.id, now, now, id]);
    return getProductRequest(db, id);
  });
}

export function planSprint(db: CoreDatabase, input: { projectId: string; repositoryId?: string | null; name: string; goal: string; capacityPoints: number; wipLimit: number; storyIds: string[] }): { sprint: EngineeringSprintRecord; items: EngineeringSprintItemRecord[] } {
  if (!Number.isInteger(input.capacityPoints) || input.capacityPoints < 1 || !Number.isInteger(input.wipLimit) || input.wipLimit < 1) throw new CoreError('invalid_request', 'capacityPoints and wipLimit must be positive integers');
  return db.transaction(() => {
    const approved = input.storyIds.map(storyId => ({ story: stories.getStory(db, storyId), request: db.get<Row>('SELECT * FROM engineering_product_requests WHERE storyId = ?', [storyId]) })).sort((a, b) => a.story.id.localeCompare(b.story.id));
    let used = 0; const included: Array<{ storyId: string; points: number }> = [];
    for (const value of approved) {
      if (value.story.projectId !== input.projectId || value.story.status !== 'ready' || !value.request) continue;
      const points = Number(value.request.estimatedPoints);
      if (used + points > input.capacityPoints) continue;
      used += points; included.push({ storyId: value.story.id, points });
    }
    if (!included.length) throw new CoreError('invalid_request', 'no Definition-of-Ready stories fit this sprint capacity');
    const now = nowIso(); const id = newId('sprint');
    db.run(`INSERT INTO engineering_sprints (id, projectId, repositoryId, name, goal, state, capacityPoints, wipLimit, createdAt) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?, ?)`, [id, input.projectId, input.repositoryId ?? null, required(input.name, 'name'), required(input.goal, 'goal'), input.capacityPoints, input.wipLimit, now]);
    included.forEach((value, ordinal) => db.run("INSERT INTO engineering_sprint_items (sprintId, storyId, ordinal, estimatedPoints, state) VALUES (?, ?, ?, ?, 'planned')", [id, value.storyId, ordinal, value.points]));
    return { sprint: getSprint(db, id), items: listSprintItems(db, id) };
  });
}

export function startSprint(db: CoreDatabase, id: string): EngineeringSprintRecord {
  return db.transaction(() => { const current = getSprint(db, id); if (current.state === 'active') return current; if (current.state !== 'planned') throw new CoreError('invalid_transition', `sprint '${id}' is ${current.state}`); const now = nowIso(); db.run("UPDATE engineering_sprints SET state = 'active', startedAt = ? WHERE id = ?", [now, id]); return getSprint(db, id); });
}
export function getSprint(db: CoreDatabase, id: string): EngineeringSprintRecord { const row = db.get<Row>('SELECT * FROM engineering_sprints WHERE id = ?', [id]); if (!row) throw new CoreError('not_found', `sprint '${id}' not found`); return sprint(row); }
export function listSprintItems(db: CoreDatabase, sprintId: string): EngineeringSprintItemRecord[] { return db.all<Row>('SELECT * FROM engineering_sprint_items WHERE sprintId = ? ORDER BY ordinal', [sprintId]).map(item); }
function dependenciesDone(db: CoreDatabase, storyId: string): boolean { return !db.get('SELECT 1 FROM story_dependencies d JOIN stories s ON s.id = d.dependsOnStoryId WHERE d.storyId = ? AND d.dependencyType = ? AND s.status != ?', [storyId, 'blocks', 'done']); }

/** Deterministic dispatch: candidates are stored sprint order; workers are
 * sorted by id; capacity and existing non-expired leases are checked in the
 * same transaction that creates the Core attempt and lease. */
export function dispatchNext(db: CoreDatabase, input: DispatchInput): EngineeringAssignmentRecord | undefined {
  if (input.leaseMs < 1_000) throw new CoreError('invalid_request', 'leaseMs must be at least 1000');
  const workers = [...new Set(input.workerIds.map(value => value.trim()).filter(Boolean))].sort();
  if (!workers.length) throw new CoreError('invalid_request', 'at least one worker is required');
  return db.transaction(() => {
    const current = getSprint(db, input.sprintId); if (current.state !== 'active') throw new CoreError('invalid_transition', `sprint '${current.id}' is not active`);
    const active = Number(db.get<{ count: number }>("SELECT count(*) AS count FROM engineering_assignments WHERE sprintId = ? AND state = 'active' AND leaseExpiresAt > ?", [current.id, nowIso()])?.count ?? 0);
    if (active >= current.wipLimit) return undefined;
    const candidate = listSprintItems(db, current.id).find(value => value.state === 'planned' && dependenciesDone(db, value.storyId));
    if (!candidate) return undefined;
    const story = stories.getStory(db, candidate.storyId);
    const request = submitRequest(db, { clientId: input.clientId, currentMessage: `${story.title}\n\n${story.description}\n\nAcceptance criteria:\n${story.acceptanceCriteria.map(value => `- ${value}`).join('\n')}\n\nUse the existing governed worktree, proposal, mutation, validation, review, delivery, and human-merge gates. Create only a draft pull request.`, requestedMode: 'karke_dikha', storyId: story.id, projectId: story.projectId, repositoryId: story.repositoryId, workspaceRoot: input.workspaceRoot, selectedProvider: input.selectedProvider, selectedModel: input.selectedModel, capability: { hasWorkspace: true, gitCapable: true }, correlationId: `m37:${current.id}:${story.id}:${candidate.ordinal}` });
    const now = nowIso(); const expires = new Date(Date.now() + input.leaseMs).toISOString(); const id = newId('engassign'); const leaseToken = randomUUID(); const workerId = workers[candidate.ordinal % workers.length];
    db.run(`INSERT INTO engineering_assignments (id, sprintId, storyId, attemptId, workerId, leaseToken, leaseExpiresAt, state, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`, [id, current.id, story.id, request.attempt.id, workerId, leaseToken, expires, now, now]);
    db.run("UPDATE engineering_sprint_items SET state = 'active' WHERE sprintId = ? AND storyId = ?", [current.id, story.id]);
    stories.transitionStory(db, story.id, { toStatus: 'assigned', actor: input.actor, clientId: input.clientId });
    return getAssignment(db, id);
  });
}

export function getAssignment(db: CoreDatabase, id: string): EngineeringAssignmentRecord { const row = db.get<Row>('SELECT * FROM engineering_assignments WHERE id = ?', [id]); if (!row) throw new CoreError('not_found', `engineering assignment '${id}' not found`); return assignment(row); }
export function renewAssignmentLease(db: CoreDatabase, id: string, leaseToken: string, leaseMs: number): EngineeringAssignmentRecord { return db.transaction(() => { const current = getAssignment(db, id); if (current.state !== 'active' || current.leaseToken !== leaseToken || Date.parse(current.leaseExpiresAt) <= Date.now()) throw new CoreError('fence_stale', `engineering assignment '${id}' lease is stale`); const now = nowIso(); db.run('UPDATE engineering_assignments SET leaseExpiresAt = ?, updatedAt = ? WHERE id = ?', [new Date(Date.now() + leaseMs).toISOString(), now, id]); return getAssignment(db, id); }); }

export function ingestCiFailure(db: CoreDatabase, input: { storyId: string; sourceAttemptId: string; pullRequestUrl: string; headSha: string; runId: string; failedChecks: string[]; errorSummary: string; actor: string; clientId?: string | null }): EngineeringCiEvidenceRecord {
  return db.transaction(() => {
    const existing = db.get('SELECT id FROM engineering_ci_evidence WHERE runId = ?', [input.runId]);
    if (existing) {
      const prior = getCiByRun(db, input.runId);
      if (prior.storyId !== input.storyId || prior.sourceAttemptId !== input.sourceAttemptId || prior.pullRequestUrl !== input.pullRequestUrl || prior.headSha !== input.headSha) {
        throw new CoreError('conflict', `CI run '${input.runId}' does not match its existing lineage`);
      }
      return prior;
    }
    const story = stories.getStory(db, input.storyId);
    const sourceAttempt = getAttempt(db, input.sourceAttemptId);
    const sourceRequest = getRequest(db, sourceAttempt.requestId);
    if (sourceAttempt.kind !== 'karke_dikha' || sourceRequest.storyId !== story.id) {
      throw new CoreError('context_mismatch', 'CI failure source attempt does not belong to this story');
    }
    if (!db.get('SELECT id FROM engineering_assignments WHERE storyId = ? AND attemptId = ?', [story.id, sourceAttempt.id])) {
      throw new CoreError('context_mismatch', 'CI failure source attempt is not the Core assignment for this story');
    }
    const fingerprint = failureFingerprint(input.failedChecks, input.errorSummary);
    const repair = stories.createStory(db, { projectId: story.projectId, repositoryId: story.repositoryId, title: `Repair CI: ${story.title}`, description: `Repair failure ${fingerprint}. Source PR: ${input.pullRequestUrl}.\n${input.errorSummary}`, acceptanceCriteria: ['Add regression coverage.', 'Replacement CI succeeds.', 'Independent review passes.', 'Human merge is observed.'], priority: 'high', status: 'ready', storyType: 'bug', parentId: story.id, source: { kind: 'm37_ci_failure', fingerprint, sourceStoryId: story.id, sourceAttemptId: input.sourceAttemptId }, actor: input.actor, clientId: input.clientId });
    const now = nowIso(); const id = newId('engci');
    db.run(`INSERT INTO engineering_ci_evidence (id, storyId, sourceAttemptId, repairStoryId, pullRequestUrl, headSha, runId, conclusion, failureFingerprint, diagnosis, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, 'failure', ?, ?, ?, ?)`, [id, story.id, input.sourceAttemptId, repair.id, input.pullRequestUrl, input.headSha, input.runId, fingerprint, bounded(input.errorSummary, 2000), now, now]);
    return getCi(db, id);
  });
}

export function recordRepairEvidence(db: CoreDatabase, input: { failureRunId: string; repairAttemptId: string; replacementRunId: string; replacementHeadSha: string; regressionTests: string[]; reviewed: boolean }): EngineeringCiEvidenceRecord {
  return db.transaction(() => {
    const prior = getCiByRun(db, input.failureRunId);
    const regressionTests = [...new Set(input.regressionTests)].sort();
    if (!prior.repairStoryId || !regressionTests.length || !input.reviewed) throw new CoreError('invalid_request', 'repair requires a linked repair story, regression tests, and independent review');
    const repairAttempt = getAttempt(db, input.repairAttemptId);
    const repairRequest = getRequest(db, repairAttempt.requestId);
    if (repairAttempt.kind !== 'karke_dikha' || repairRequest.storyId !== prior.repairStoryId) {
      throw new CoreError('context_mismatch', 'repair attempt does not belong to the CI repair story');
    }
    if (prior.repairAttemptId) {
      if (prior.repairAttemptId === input.repairAttemptId && prior.replacementRunId === input.replacementRunId && prior.replacementHeadSha === input.replacementHeadSha && json(prior.regressionTests) === json(regressionTests)) return prior;
      throw new CoreError('conflict', 'repair evidence has already been recorded for this CI failure');
    }
    const now = nowIso();
    db.run(`UPDATE engineering_ci_evidence SET repairAttemptId = ?, regressionTests = ?, replacementRunId = ?, replacementHeadSha = ?, reviewedAt = ?, updatedAt = ? WHERE id = ?`, [input.repairAttemptId, json(regressionTests), input.replacementRunId, input.replacementHeadSha, now, now, prior.id]);
    return getCi(db, prior.id);
  });
}

export function observeReplacementCi(db: CoreDatabase, failureRunId: string, replacementRunId: string, headSha: string, conclusion: EngineeringCiConclusion): EngineeringCiEvidenceRecord {
  return db.transaction(() => {
    const prior = getCiByRun(db, failureRunId);
    if (prior.replacementRunId !== replacementRunId || prior.replacementHeadSha !== headSha) throw new CoreError('conflict', 'replacement CI does not match the recorded repair head');
    if (conclusion !== 'success') throw new CoreError('invalid_request', 'replacement CI is not successful');
    if (prior.conclusion === 'success') return prior;
    const now = nowIso();
    db.run('UPDATE engineering_ci_evidence SET conclusion = ?, updatedAt = ? WHERE id = ?', [conclusion, now, prior.id]);
    return getCi(db, prior.id);
  });
}

/** Human merge is an observed external fact. This API never merges; it only
 * accepts attributable readback after successful replacement CI and review. */
export function recordHumanMerge(db: CoreDatabase, input: { failureRunId: string; mergedBy: string; mergedAt: string }): EngineeringCiEvidenceRecord {
  return db.transaction(() => {
    const prior = getCiByRun(db, input.failureRunId);
    const mergedBy = required(input.mergedBy, 'mergedBy');
    if (prior.mergedAt) {
      if (prior.mergedAt === input.mergedAt && prior.mergedBy === mergedBy) return prior;
      throw new CoreError('conflict', 'human merge readback does not match the recorded merge');
    }
    if (prior.conclusion !== 'success' || !prior.reviewedAt || !prior.replacementRunId || !prior.regressionTests.length) throw new CoreError('invalid_transition', 'Definition of Done is not satisfied');
    if (Number.isNaN(Date.parse(input.mergedAt))) throw new CoreError('invalid_request', 'mergedAt must be an ISO timestamp');
    const now = nowIso();
    db.run('UPDATE engineering_ci_evidence SET mergedBy = ?, mergedAt = ?, updatedAt = ? WHERE id = ?', [mergedBy, input.mergedAt, now, prior.id]);
    if (prior.repairStoryId) completeStory(db, prior.repairStoryId);
    completeStory(db, prior.storyId);
    db.run("UPDATE engineering_sprint_items SET state = 'done' WHERE storyId = ?", [prior.storyId]);
    db.run("UPDATE engineering_assignments SET state = 'released', updatedAt = ? WHERE storyId = ? AND state = 'active'", [now, prior.storyId]);
    return getCi(db, prior.id);
  });
}

export function closeSprint(db: CoreDatabase, sprintId: string): EngineeringSprintRecord {
  return db.transaction(() => { const current = getSprint(db, sprintId); const items = listSprintItems(db, sprintId); if (current.state !== 'active' || items.some(value => value.state !== 'done')) throw new CoreError('invalid_transition', 'sprint cannot close until every item is Done'); const deliveredPoints = items.reduce((sum, value) => sum + value.estimatedPoints, 0); const review = { deliveredPoints, completedStories: items.map(value => value.storyId), generatedAt: nowIso() }; const retrospective = { kept: ['Core remained the sole durable authority.'], improve: ['Review bounded CI repair evidence before expanding concurrency.'], generatedAt: nowIso() }; const now = nowIso(); db.run("UPDATE engineering_sprints SET state = 'completed', completedAt = ?, review = ?, retrospective = ? WHERE id = ?", [now, json(review), json(retrospective), sprintId]); return getSprint(db, sprintId); });
}

export function getCi(db: CoreDatabase, id: string): EngineeringCiEvidenceRecord { const row = db.get<Row>('SELECT * FROM engineering_ci_evidence WHERE id = ?', [id]); if (!row) throw new CoreError('not_found', `CI evidence '${id}' not found`); return ci(row); }
export function getCiByRun(db: CoreDatabase, runId: string): EngineeringCiEvidenceRecord { const row = db.get<Row>('SELECT * FROM engineering_ci_evidence WHERE runId = ?', [runId]); if (!row) throw new CoreError('not_found', `CI run '${runId}' not found`); return ci(row); }
export function organizationSnapshot(db: CoreDatabase, projectId: string): { requests: EngineeringProductRequestRecord[]; sprints: EngineeringSprintRecord[]; assignments: EngineeringAssignmentRecord[]; ci: EngineeringCiEvidenceRecord[] } { return { requests: db.all<Row>('SELECT * FROM engineering_product_requests WHERE projectId = ? ORDER BY createdAt', [projectId]).map(product), sprints: db.all<Row>('SELECT * FROM engineering_sprints WHERE projectId = ? ORDER BY createdAt', [projectId]).map(sprint), assignments: db.all<Row>('SELECT a.* FROM engineering_assignments a JOIN engineering_sprints s ON s.id = a.sprintId WHERE s.projectId = ? ORDER BY a.createdAt', [projectId]).map(assignment), ci: db.all<Row>('SELECT c.* FROM engineering_ci_evidence c JOIN stories s ON s.id = c.storyId WHERE s.projectId = ? ORDER BY c.createdAt', [projectId]).map(ci) }; }

function completeStory(db: CoreDatabase, storyId: string): void { let current = stories.getStory(db, storyId); const path: Record<string, string[]> = { ready: ['assigned', 'planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'], assigned: ['planning', 'proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'], planning: ['proposal_approval', 'implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'], proposal_approval: ['implementing', 'review', 'validation', 'delivery_approval', 'merge_queue', 'done'], implementing: ['review', 'validation', 'delivery_approval', 'merge_queue', 'done'], review: ['validation', 'delivery_approval', 'merge_queue', 'done'], validation: ['delivery_approval', 'merge_queue', 'done'], delivery_approval: ['merge_queue', 'done'], merge_queue: ['done'] }; for (const next of path[current.status] ?? []) { current = stories.transitionStory(db, storyId, { toStatus: next as typeof current.status, actor: 'm37-human-merge' }); } }
function failureFingerprint(checks: string[], summary: string): string { return createHash('sha256').update(`${checks.map(value => value.replace(/[0-9a-f]{8,}/gi, '<sha>').replace(/\d+/g, '<n>').trim()).sort().join('|')}|${summary.replace(/[0-9a-f]{8,}/gi, '<sha>').replace(/[A-Za-z]:\\[^\s]+|\/[^\s]+/g, '<path>').replace(/\d+/g, '<n>').replace(/\s+/g, ' ').trim()}`).digest('hex'); }
function bounded(value: string, max: number): string { return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
