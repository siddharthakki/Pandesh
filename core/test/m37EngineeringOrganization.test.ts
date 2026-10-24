import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openCoreDatabase } from '../db/openCore';
import type { CoreDatabase } from '../db/connection';
import { createProject } from '../domain/projects';
import { getStory } from '../domain/stories';
import { submitRequest } from '../domain/submission';
import {
  approveProductRequest,
  closeSprint,
  createProductRequest,
  dispatchNext,
  getCiByRun,
  ingestCiFailure,
  observeReplacementCi,
  organizationSnapshot,
  planSprint,
  recordHumanMerge,
  recordRepairEvidence,
  renewAssignmentLease,
  startSprint,
} from '../domain/engineeringOrganization';

let root: string;
let databasePath: string;
let db: CoreDatabase;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'karkedikha-m37-'));
  databasePath = path.join(root, 'core.db');
  db = openCoreDatabase(databasePath).db;
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('M37 Core-owned engineering organization', () => {
  it('keeps request, sprint, lease, repair, replacement CI, human merge, review, and retrospective durable', () => {
    const project = createProject(db, { name: 'M37 test project' });
    const request = createProductRequest(db, {
      projectId: project.id,
      title: 'Deliver one governed repair',
      goal: 'Implement only the requested repair with durable evidence.',
      acceptanceCriteria: ['A draft PR exists.', 'The repaired CI run succeeds.'],
      definitionOfReady: ['Scope is explicit.', 'Validation is named.'],
      definitionOfDone: ['CI succeeds.', 'A human merge is observed.'],
      estimatedPoints: 3,
      actor: 'human-product-owner',
    });
    const approved = approveProductRequest(db, request.id, 'human-product-owner');
    expect(approved.status).toBe('approved');
    expect(approved.storyId).toBeTruthy();

    const planned = planSprint(db, {
      projectId: project.id,
      name: 'M37 lifecycle',
      goal: 'Prove one governed lifecycle.',
      capacityPoints: 3,
      wipLimit: 1,
      storyIds: [approved.storyId!],
    });
    startSprint(db, planned.sprint.id);
    const dispatched = dispatchNext(db, {
      sprintId: planned.sprint.id,
      workerIds: ['worker-b', 'worker-a'],
      leaseMs: 60_000,
      workspaceRoot: root,
      selectedProvider: 'ollama',
      selectedModel: 'm37-test-model',
      actor: 'm37-dispatcher',
      clientId: 'm37-test-client',
    })!;
    expect(dispatched.workerId).toBe('worker-a');
    expect(dispatched.attemptId).toBeTruthy();
    expect(dispatchNext(db, {
      sprintId: planned.sprint.id, workerIds: ['worker-a'], leaseMs: 60_000, workspaceRoot: root,
      selectedProvider: 'ollama', selectedModel: 'm37-test-model', actor: 'm37-dispatcher', clientId: 'm37-test-client',
    })).toBeUndefined();
    expect(() => renewAssignmentLease(db, dispatched.id, 'stale-token', 60_000)).toThrow(/stale/);

    // A Core restart must preserve the same assignment and lease token rather
    // than creating a second queue item or accepting a stale action.
    db.close();
    db = openCoreDatabase(databasePath).db;
    const renewed = renewAssignmentLease(db, dispatched.id, dispatched.leaseToken, 60_000);
    expect(renewed.attemptId).toBe(dispatched.attemptId);

    const failure = ingestCiFailure(db, {
      storyId: approved.storyId!, sourceAttemptId: dispatched.attemptId!,
      pullRequestUrl: 'https://github.com/example/repo/pull/7', headSha: 'aaaaaaaaaaaaaaaa', runId: 'run-failed-7',
      failedChecks: ['vitest: M37 regression'], errorSummary: 'Expected 1 but received 0 at C:\\runner\\src\\m37.test.ts:42',
      actor: 'github-ci-observer',
    });
    expect(ingestCiFailure(db, {
      storyId: approved.storyId!, sourceAttemptId: dispatched.attemptId!,
      pullRequestUrl: 'https://github.com/example/repo/pull/7', headSha: 'aaaaaaaaaaaaaaaa', runId: 'run-failed-7',
      failedChecks: ['vitest: M37 regression'], errorSummary: 'duplicate event must be idempotent', actor: 'github-ci-observer',
    }).id).toBe(failure.id);
    expect(() => ingestCiFailure(db, {
      storyId: approved.storyId!, sourceAttemptId: dispatched.attemptId!,
      pullRequestUrl: 'https://github.com/example/repo/pull/8', headSha: 'aaaaaaaaaaaaaaaa', runId: 'run-failed-7',
      failedChecks: ['vitest: M37 regression'], errorSummary: 'mismatched duplicate', actor: 'github-ci-observer',
    })).toThrow(/lineage/);
    expect(failure.failureFingerprint).toHaveLength(64);
    expect(failure.repairStoryId).toBeTruthy();
    const repairAttempt = submitRequest(db, {
      clientId: 'm37-test-client', currentMessage: 'Repair the observed CI failure and add regression evidence.', requestedMode: 'karke_dikha',
      storyId: failure.repairStoryId!, projectId: project.id, workspaceRoot: root, selectedProvider: 'ollama', selectedModel: 'm37-test-model',
      capability: { hasWorkspace: true, gitCapable: true }, correlationId: 'm37-repair-attempt',
    }).attempt;
    recordRepairEvidence(db, {
      failureRunId: 'run-failed-7', repairAttemptId: repairAttempt.id, replacementRunId: 'run-fixed-8', replacementHeadSha: 'bbbbbbbbbbbbbbbb',
      regressionTests: ['core/test/m37EngineeringOrganization.test.ts'], reviewed: true,
    });
    expect(recordRepairEvidence(db, {
      failureRunId: 'run-failed-7', repairAttemptId: repairAttempt.id, replacementRunId: 'run-fixed-8', replacementHeadSha: 'bbbbbbbbbbbbbbbb',
      regressionTests: ['core/test/m37EngineeringOrganization.test.ts'], reviewed: true,
    }).repairAttemptId).toBe(repairAttempt.id);
    expect(() => recordRepairEvidence(db, {
      failureRunId: 'run-failed-7', repairAttemptId: dispatched.attemptId!, replacementRunId: 'run-fixed-9', replacementHeadSha: 'cccccccccccccccc',
      regressionTests: ['core/test/m37EngineeringOrganization.test.ts'], reviewed: true,
    })).toThrow(/repair evidence|repair attempt/);
    observeReplacementCi(db, 'run-failed-7', 'run-fixed-8', 'bbbbbbbbbbbbbbbb', 'success');
    const merged = recordHumanMerge(db, { failureRunId: 'run-failed-7', mergedBy: 'human-reviewer', mergedAt: '2026-07-23T12:00:00.000Z' });
    expect(recordHumanMerge(db, { failureRunId: 'run-failed-7', mergedBy: 'human-reviewer', mergedAt: '2026-07-23T12:00:00.000Z' }).id).toBe(merged.id);
    expect(() => recordHumanMerge(db, { failureRunId: 'run-failed-7', mergedBy: 'another-human', mergedAt: '2026-07-23T12:00:00.000Z' })).toThrow(/merge/);
    expect(merged.mergedBy).toBe('human-reviewer');
    expect(getStory(db, approved.storyId!).status).toBe('done');
    expect(closeSprint(db, planned.sprint.id).state).toBe('completed');

    const snapshot = organizationSnapshot(db, project.id);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.assignments).toHaveLength(1);
    expect(getCiByRun(db, 'run-failed-7').replacementRunId).toBe('run-fixed-8');
    expect(snapshot.sprints[0].review?.deliveredPoints).toBe(3);
    expect(snapshot.sprints[0].retrospective?.improve).toBeDefined();
  });
});
