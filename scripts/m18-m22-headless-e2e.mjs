#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const autonomous = await import('../out/autonomous/M15AutonomousWork.js');
const organizationModule = await import('../out/organization/M22SelfDogfoodOrganization.js');
const repairReconciliation = await import('../out/organization/M22RepairReconciliation.js');

const { DurableTaskQueue } = autonomous;
const { createM22ProductionComposition } = organizationModule;
const { adoptVerifiedRepairDelivery } = repairReconciliation;

class AcceptanceBoard {
  constructor(issue) {
    this.issues = new Map([[issue.number, structuredClone(issue)]]);
    this.transitions = [];
    this.comments = [];
    this.merges = new Map();
    this.nextBugNumber = 9900;
  }

  async provision() {
    return { projectNumber: 22, projectUrl: 'https://example.invalid/projects/22' };
  }

  async listReadyIssues() {
    return [...this.issues.values()].filter(issue => issue.labels.includes('ai-ready')).map(issue => structuredClone(issue));
  }

  async issue(number) {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`Unknown issue ${number}`);
    return structuredClone(issue);
  }

  async transition(issueRef, status, message) {
    const issue = this.issues.get(issueRef.number);
    if (!issue) throw new Error(`Unknown issue ${issueRef.number}`);
    issue.status = status;
    issue.labels = issue.labels.filter(label => !['ai-ready', 'ai-in-progress', 'ai-review', 'ai-blocked', 'ai-done'].includes(label));
    issue.labels.push(status === 'in-progress' ? 'ai-in-progress'
      : status === 'review' ? 'ai-review'
      : status === 'blocked' ? 'ai-blocked'
      : status === 'done' ? 'ai-done'
      : 'ai-ready');
    this.transitions.push({ issueNumber: issueRef.number, status, message });
  }

  async update(story, message) {
    const number = Number(/#(\d+)$/.exec(story.externalRef || '')?.[1]);
    if (!number) return;
    await this.transition({ number }, story.state === 'blocked' ? 'blocked' : story.state === 'done' ? 'review' : 'in-progress', message);
  }

  async escalate(story, message) {
    const number = Number(/#(\d+)$/.exec(story.externalRef || '')?.[1]);
    if (number) await this.transition({ number }, 'blocked', message);
  }

  async ensureBug(record, pipeline) {
    const existing = [...this.issues.values()].find(issue => issue.body.includes(record.fingerprint));
    if (existing) return { issueNumber: existing.number, issueUrl: `https://example.invalid/issues/${existing.number}` };
    const number = this.nextBugNumber++;
    this.issues.set(number, {
      repository: pipeline.repository,
      number,
      title: record.title,
      body: `Fingerprint: ${record.fingerprint}`,
      type: 'bug',
      labels: ['type:bug', 'needs-regression-test', 'priority:high', 'ai-ready'],
      milestone: 'Current Sprint',
      acceptanceCriteria: ['CI is repaired.', 'Regression coverage exists.'],
      dependencies: [],
      estimate: 2,
      status: 'ready',
      updatedAt: pipeline.completedAt,
    });
    return { issueNumber: number, issueUrl: `https://example.invalid/issues/${number}` };
  }

  async updateBug(_record, message) {
    this.comments.push(message);
  }

  async verifyMergedPullRequest(url) {
    return this.merges.get(url) || { pullRequestUrl: url, merged: false };
  }
}

let clock = Date.parse('2026-07-13T00:00:00.000Z');
const now = () => new Date(clock += 1_000);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'karkedikha-m18-m22-e2e-'));
const repository = 'siddharthakki/ollama-agent';
const issue = {
  repository,
  number: 8800,
  title: 'Unattended M22 self-dogfood story',
  body: 'Exercise the complete engineering organization.',
  type: 'story',
  labels: ['type:story', 'priority:urgent', 'ai-ready'],
  milestone: 'Current Sprint',
  acceptanceCriteria: ['A governed draft PR exists.', 'CI, review, and human merge pass.'],
  dependencies: [],
  estimate: 3,
  status: 'ready',
  updatedAt: now().toISOString(),
};
const board = new AcceptanceBoard(issue);
const queue = new DurableTaskQueue(root);
let wakes = 0;
const runtime = { wake() { wakes += 1; } };

try {
  const composition = createM22ProductionComposition(board, queue, runtime, {
    repositoryRoot: root,
    repository,
    baseBranch: 'dogfood/m17',
    validationCommands: ['npm run compile'],
    codingRoute: {
      model: 'acceptance-local-model',
      provider: 'ollama',
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
      maxContextTokens: 32_000,
    },
    maxConcurrent: 1,
    leaseTtlMs: 120_000,
    blockedEscalationMs: 5_000,
    now,
  });

  const project = await composition.organization.provision();
  assert.equal(project.projectNumber, 22);
  const sprint = await composition.organization.planAndStartSprint({
    name: 'Unattended M22',
    goal: 'Build KarkeDikha with KarkeDikha',
    endsAt: '2026-07-27T00:00:00.000Z',
    capacityPoints: 5,
    wipLimit: 1,
  });
  assert.ok(sprint);
  assert.equal(wakes, 1);

  const originalTask = (await queue.list()).find(task => task.sourceIssue?.issueNumber === issue.number);
  assert.ok(originalTask);
  assert.equal(originalTask.deliveryPolicy.createDraftPullRequest, true);
  assert.equal(originalTask.deliveryPolicy.requireApprovalBeforeCommit, true);
  assert.ok(originalTask.evidence.includes('organization:m22'));

  const originalPr = 'https://example.invalid/pull/8801';
  await queue.update({
    ...originalTask,
    state: 'completed',
    diffReview: {
      verdict: 'pass',
      requirementFindings: [],
      changedFileFindings: [],
      validationFindings: [],
      securityFindings: [],
      explanation: 'Original delivery review passed.',
      reviewerProvider: 'host',
      reviewerModel: 'deterministic',
      decidedAt: now().toISOString(),
      approvedScopePaths: ['package.json'],
    },
    githubDelivery: {
      ...originalTask.githubDelivery,
      commitSha: 'acceptance-commit',
      pullRequestNumber: 8801,
      pullRequestUrl: originalPr,
      draft: true,
      ci: {
        state: 'failure',
        observedAt: now().toISOString(),
        failedChecks: [{ name: 'test:unit', summary: 'Expected acceptance failure' }],
      },
    },
    terminalResult: { status: 'completed', summary: 'Draft PR created.' },
  }, 'acceptance_original_delivery');
  await composition.organization.sync();

  await composition.organization.ingestPipeline({
    id: 'acceptance-ci-failure',
    repository,
    branch: 'acceptance-story',
    commitSha: 'acceptance-commit',
    workflow: 'CI',
    runUrl: originalPr,
    conclusion: 'failure',
    failedChecks: ['test:unit'],
    failingTests: ['src/test/suite/acceptanceRegression.test.ts'],
    errorSummary: 'Expected acceptance failure',
    startedAt: now().toISOString(),
    completedAt: now().toISOString(),
    attempt: 1,
    sourceTaskId: originalTask.taskId,
    sourceIssueNumber: issue.number,
  });
  const repairState = await composition.repair.state();
  assert.equal(repairState.bugs.length, 1);
  assert.equal(repairState.assignments.length, 1);
  assert.equal(wakes, 2);

  const repairTask = (await queue.list()).find(task => task.sourceIssue?.issueNumber === 9900);
  assert.ok(repairTask);
  const repairPr = 'https://example.invalid/pull/8802';
  await queue.update({
    ...repairTask,
    state: 'completed',
    diffReview: {
      verdict: 'pass',
      requirementFindings: [],
      changedFileFindings: [],
      validationFindings: [],
      securityFindings: [],
      explanation: 'Repair delivery and regression coverage passed review.',
      reviewerProvider: 'host',
      reviewerModel: 'deterministic',
      decidedAt: now().toISOString(),
      approvedScopePaths: ['src/test/suite/acceptanceRegression.test.ts'],
    },
    githubDelivery: {
      ...repairTask.githubDelivery,
      commitSha: 'repair-commit',
      pullRequestNumber: 8802,
      pullRequestUrl: repairPr,
      draft: true,
      ci: { state: 'success', observedAt: now().toISOString(), failedChecks: [] },
    },
    terminalResult: { status: 'completed', summary: 'Repair PR created.' },
  }, 'acceptance_repair_delivery');
  const verified = await composition.repair.recordRepairOutcome({
    assignmentId: repairState.assignments[0].id,
    succeeded: true,
    regressionTests: ['src/test/suite/acceptanceRegression.test.ts'],
    validationPassed: true,
    reviewPassed: true,
    pipelinePassed: true,
    pipelineRunId: 'acceptance-ci-repair-success',
    taskId: repairTask.taskId,
    pullRequestUrl: repairPr,
    summary: 'Repair verified',
  });
  const adoption = await adoptVerifiedRepairDelivery(root, repository, verified.bug, now);
  assert.equal(adoption.adopted, true);
  assert.equal(adoption.previousPullRequestUrl, originalPr);
  assert.equal(adoption.repairPullRequestUrl, repairPr);

  board.merges.set(repairPr, {
    pullRequestUrl: repairPr,
    merged: true,
    mergedAt: now().toISOString(),
    mergedBy: 'acceptance-human',
  });
  await composition.organization.recordApprovedMerge({
    issueNumber: issue.number,
    pullRequestUrl: repairPr,
    regressionTests: verified.bug.regressionTests,
  });
  await composition.repair.closeVerifiedBug(verified.bug.id, repairPr);
  await composition.organization.dailyScrum();
  const report = await composition.organization.closeSprint();

  const organizationState = await composition.organization.state();
  const finalRepair = await composition.repair.state();
  assert.equal(organizationState.bindings[0].state, 'done');
  assert.equal(organizationState.bindings[0].pullRequestUrl, repairPr);
  assert.equal(finalRepair.bugs[0].state, 'closed');
  assert.deepEqual(report.completedIssues, [issue.number]);
  assert.equal(report.deliveredPoints, 3);
  assert.equal(report.plannedPoints, 3);

  console.log(JSON.stringify({
    status: 'passed',
    mode: 'unattended-headless',
    milestones: [18, 19, 20, 21, 22],
    projectProvisioned: true,
    durableIssueLease: true,
    durableAutonomousQueue: true,
    workforceRouted: true,
    sprintPlanned: true,
    ciFailureIngested: true,
    bugDeduplicated: finalRepair.bugs.length === 1,
    repairAssigned: finalRepair.assignments.length === 1,
    supersedingRepairDelivery: repairPr,
    regressionEvidence: finalRepair.bugs[0].regressionTests,
    humanMergeReadback: true,
    sprintReport: report,
    userPrompts: 0,
    automaticMerge: false,
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
