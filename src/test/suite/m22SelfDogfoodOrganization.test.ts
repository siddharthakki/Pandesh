import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { DurableTaskQueue } from '../../autonomous/M15AutonomousWork';
import { createM22ProductionComposition } from '../../organization/M22SelfDogfoodOrganization';
import type { M22BoardGateway, VerifiedMerge } from '../../organization/M22SelfDogfoodOrganization';
import { adoptVerifiedRepairDelivery } from '../../organization/M22RepairReconciliation';
import type { ScrumBoardStatus, ScrumIssueRecord } from '../../scrum/M18ScrumControlPlane';
import type { SprintStory } from '../../sprint/M20AutonomousSprint';
import type { PipelineResult, RepairBugRecord } from '../../repair/M21CIBugRepairLoop';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

class FakeBoard implements M22BoardGateway {
  readonly transitions: Array<{ issueNumber: number; status: ScrumBoardStatus; message: string }> = [];
  readonly comments: string[] = [];
  readonly issues = new Map<number, ScrumIssueRecord>();
  merged = new Map<string, VerifiedMerge>();
  nextBugNumber = 900;

  constructor(issue: ScrumIssueRecord) {
    this.issues.set(issue.number, structuredClone(issue));
  }

  async provision(): Promise<{ projectNumber: number; projectUrl?: string }> {
    return { projectNumber: 1, projectUrl: 'https://github.com/users/siddharthakki/projects/1' };
  }

  async listReadyIssues(): Promise<ScrumIssueRecord[]> {
    return [...this.issues.values()].filter(issue => issue.labels.includes('ai-ready')).map(issue => structuredClone(issue));
  }

  async issue(number: number): Promise<ScrumIssueRecord> {
    const issue = this.issues.get(number);
    if (!issue) throw new Error(`Unknown issue ${number}`);
    return structuredClone(issue);
  }

  async transition(issue: Pick<ScrumIssueRecord, 'number'>, status: ScrumBoardStatus, message: string): Promise<void> {
    const current = this.issues.get(issue.number);
    if (!current) throw new Error(`Unknown issue ${issue.number}`);
    current.status = status;
    current.labels = current.labels.filter(label => !['ai-ready', 'ai-in-progress', 'ai-review', 'ai-blocked', 'ai-done'].includes(label));
    current.labels.push(status === 'in-progress' ? 'ai-in-progress'
      : status === 'review' ? 'ai-review'
      : status === 'blocked' ? 'ai-blocked'
      : status === 'done' ? 'ai-done'
      : 'ai-ready');
    this.transitions.push({ issueNumber: issue.number, status, message });
  }

  async update(story: SprintStory, message: string): Promise<void> {
    const number = Number(/#(\d+)$/.exec(story.externalRef ?? '')?.[1]);
    if (!number) return;
    await this.transition({ number }, story.state === 'blocked' ? 'blocked' : story.state === 'done' ? 'review' : 'in-progress', message);
  }

  async escalate(story: SprintStory, message: string): Promise<void> {
    const number = Number(/#(\d+)$/.exec(story.externalRef ?? '')?.[1]);
    if (number) await this.transition({ number }, 'blocked', message);
  }

  async ensureBug(record: RepairBugRecord, pipeline: PipelineResult): Promise<{ issueNumber: number; issueUrl: string }> {
    const existing = [...this.issues.values()].find(issue => issue.body.includes(record.fingerprint));
    if (existing) return { issueNumber: existing.number, issueUrl: `https://github.com/${existing.repository}/issues/${existing.number}` };
    const number = this.nextBugNumber++;
    this.issues.set(number, {
      repository: pipeline.repository,
      number,
      title: record.title,
      body: `Fingerprint: ${record.fingerprint}`,
      type: 'bug',
      labels: ['type:bug', 'needs-regression-test', 'priority:high', 'ai-ready'],
      milestone: 'Current Sprint',
      acceptanceCriteria: ['CI failure is repaired.', 'Regression coverage exists.'],
      dependencies: [],
      estimate: 2,
      status: 'ready',
      updatedAt: pipeline.completedAt,
    });
    return { issueNumber: number, issueUrl: `https://github.com/${pipeline.repository}/issues/${number}` };
  }

  async updateBug(_record: RepairBugRecord, message: string): Promise<void> {
    this.comments.push(message);
  }

  async verifyMergedPullRequest(pullRequestUrl: string): Promise<VerifiedMerge> {
    return this.merged.get(pullRequestUrl) ?? { pullRequestUrl, merged: false };
  }
}

function readyStory(): ScrumIssueRecord {
  return {
    repository: 'siddharthakki/ollama-agent',
    number: 700,
    title: 'M22 dogfood story',
    body: 'Implement one bounded self-dogfood change.',
    type: 'story',
    labels: ['type:story', 'priority:high', 'ai-ready'],
    milestone: 'Current Sprint',
    acceptanceCriteria: ['A governed draft PR is created.', 'CI and review pass.'],
    dependencies: [],
    estimate: 3,
    status: 'ready',
    updatedAt: '2026-07-13T00:00:00.000Z',
  };
}

describe('M22 self-dogfooding engineering organization', () => {
  it('runs board → task → CI bug → superseding repair PR → human merge → sprint report', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'm22-org-'));
    roots.push(root);
    let clock = Date.parse('2026-07-13T00:00:00.000Z');
    const now = () => new Date(clock += 1_000);
    const repository = 'siddharthakki/ollama-agent';
    const board = new FakeBoard(readyStory());
    const queue = new DurableTaskQueue(root);
    const runtime = { wake: vi.fn() };
    const composition = createM22ProductionComposition(board, queue, runtime, {
      repositoryRoot: root,
      repository,
      baseBranch: 'dogfood/m17',
      validationCommands: ['npm run compile'],
      codingRoute: {
        model: 'qwen-local', provider: 'ollama', inputCostPerMillion: 0, outputCostPerMillion: 0, maxContextTokens: 32_000,
      },
      maxConcurrent: 1,
      leaseTtlMs: 60_000,
      blockedEscalationMs: 1_000,
      now,
    });

    expect(await composition.organization.provision()).toMatchObject({ projectNumber: 1 });
    const sprint = await composition.organization.planAndStartSprint({
      name: 'M22 Dogfood',
      goal: 'Build KarkeDikha with KarkeDikha',
      endsAt: '2026-07-27T00:00:00.000Z',
      capacityPoints: 5,
      wipLimit: 1,
    });
    expect(sprint?.storyIds).toHaveLength(1);
    expect(runtime.wake).toHaveBeenCalledTimes(1);
    const originalTask = (await queue.list()).find(task => task.sourceIssue?.issueNumber === 700)!;
    expect(originalTask).toMatchObject({
      origin: 'github-issue',
      repositoryId: repository,
      githubDelivery: { transport: 'gh-cli', baseBranch: 'dogfood/m17' },
      deliveryPolicy: { createDraftPullRequest: true, requireApprovalBeforeCommit: true },
    });
    expect(originalTask.evidence).toContain('organization:m22');

    const originalPr = 'https://github.com/siddharthakki/ollama-agent/pull/701';
    await queue.update({
      ...originalTask,
      state: 'completed',
      diffReview: {
        reviewId: 'review-original', verdict: 'pass', reviewedAt: now().toISOString(),
        reviewerProvider: 'host', reviewerModel: 'deterministic',
        approvedScopePaths: ['package.json'], changedFileFindings: [], validationFindings: [], securityFindings: [],
      },
      githubDelivery: {
        ...originalTask.githubDelivery,
        commitSha: 'abc123', pullRequestNumber: 701, pullRequestUrl: originalPr, draft: true,
        ci: {
          state: 'failure', observedAt: now().toISOString(), checks: [],
          failedChecks: [{ name: 'test:unit', conclusion: 'failure', summary: 'Regression failed' }],
        },
      },
      terminalResult: { status: 'completed', summary: 'Draft PR created.' },
    }, 'test_original_pr_ci_failed');
    await composition.organization.sync();
    expect((await composition.organization.state()).bindings[0]).toMatchObject({ state: 'review', pullRequestUrl: originalPr });

    const failedPipeline: PipelineResult = {
      id: 'ci-original-failure', repository, branch: 'm22-story', commitSha: 'abc123', workflow: 'CI',
      runUrl: originalPr, conclusion: 'failure', failedChecks: ['test:unit'],
      failingTests: ['src/test/suite/m22Regression.test.ts'], errorSummary: 'Regression failed',
      startedAt: now().toISOString(), completedAt: now().toISOString(), attempt: 1,
      sourceTaskId: originalTask.taskId, sourceIssueNumber: 700,
    };
    await composition.organization.ingestPipeline(failedPipeline);
    const repairState = await composition.repair.state();
    expect(repairState.bugs).toHaveLength(1);
    expect(repairState.assignments).toHaveLength(1);
    expect(board.issues.has(900)).toBe(true);
    const repairTask = (await queue.list()).find(task => task.sourceIssue?.issueNumber === 900)!;
    expect(repairTask).toBeDefined();
    expect(repairTask.goal).toContain('Repair CI bug');

    const repairPr = 'https://github.com/siddharthakki/ollama-agent/pull/702';
    await queue.update({
      ...repairTask,
      state: 'completed',
      diffReview: {
        reviewId: 'review-repair', verdict: 'pass', reviewedAt: now().toISOString(),
        reviewerProvider: 'host', reviewerModel: 'deterministic',
        approvedScopePaths: ['src/test/suite/m22Regression.test.ts'],
        changedFileFindings: [], validationFindings: [], securityFindings: [],
      },
      githubDelivery: {
        ...repairTask.githubDelivery,
        commitSha: 'def456', pullRequestNumber: 702, pullRequestUrl: repairPr, draft: true,
        ci: { state: 'success', observedAt: now().toISOString(), checks: [], failedChecks: [] },
      },
      terminalResult: { status: 'completed', summary: 'Repair PR created.' },
    }, 'test_repair_completed');
    const verified = await composition.repair.recordRepairOutcome({
      assignmentId: repairState.assignments[0].id,
      succeeded: true,
      regressionTests: ['src/test/suite/m22Regression.test.ts'],
      validationPassed: true,
      reviewPassed: true,
      pipelinePassed: true,
      pipelineRunId: 'ci-repair-success',
      taskId: repairTask.taskId,
      pullRequestUrl: repairPr,
      summary: 'Repair verified',
    });
    expect(verified.bug).toMatchObject({
      state: 'verified', sourceIssueNumber: 700, sourcePullRequestUrl: originalPr,
      repairTaskId: repairTask.taskId, repairPullRequestUrl: repairPr,
    });
    expect(await adoptVerifiedRepairDelivery(root, repository, verified.bug, now)).toMatchObject({
      adopted: true, issueNumber: 700, previousPullRequestUrl: originalPr, repairPullRequestUrl: repairPr,
    });
    expect((await composition.organization.state()).bindings[0]).toMatchObject({
      state: 'review', taskId: repairTask.taskId, pullRequestUrl: repairPr,
    });

    board.merged.set(repairPr, {
      pullRequestUrl: repairPr,
      merged: true,
      mergedAt: now().toISOString(),
      mergedBy: 'human-reviewer',
    });
    await composition.organization.recordApprovedMerge({
      issueNumber: 700,
      pullRequestUrl: repairPr,
      regressionTests: verified.bug.regressionTests,
    });
    await composition.repair.closeVerifiedBug(verified.bug.id, repairPr);
    expect((await composition.repair.state()).bugs[0].state).toBe('closed');
    expect((await composition.organization.state()).bindings[0].state).toBe('done');
    expect(board.issues.get(700)?.status).toBe('done');

    const daily = await composition.organization.dailyScrum();
    expect(daily.done).toContain('M22 dogfood story');
    const report = await composition.organization.closeSprint();
    expect(report).toMatchObject({ completedIssues: [700], deliveredPoints: 3, plannedPoints: 3 });
    expect((await composition.organization.state()).activeSprintId).toBeUndefined();
  });
});
