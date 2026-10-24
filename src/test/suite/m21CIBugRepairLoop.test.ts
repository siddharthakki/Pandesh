import { describe, expect, it } from 'vitest';
import {
  CIBugRepairLoop,
  InMemoryRepairLoopStore,
  classifyFlaky,
  fingerprintFailure,
} from '../../repair/M21CIBugRepairLoop';
import type {
  BugPublisher,
  PipelineResult,
  RepairAgentAssigner,
  RepairBugRecord,
} from '../../repair/M21CIBugRepairLoop';

function pipeline(id: string, conclusion: PipelineResult['conclusion'] = 'failure', overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    id,
    repository: 'siddharthakki/ollama-agent',
    branch: 'feature/test',
    commitSha: 'abcdef1234567890',
    workflow: 'CI',
    runUrl: `https://github.com/siddharthakki/ollama-agent/actions/runs/${id}`,
    conclusion,
    failedChecks: conclusion === 'failure' ? ['test:unit'] : [],
    failingTests: conclusion === 'failure' ? ['src/test/example.test.ts > regression'] : [],
    errorSummary: conclusion === 'failure' ? 'Assertion failed at C:\\repo\\src\\example.ts:42' : undefined,
    startedAt: '2026-07-13T00:00:00.000Z',
    completedAt: '2026-07-13T00:01:00.000Z',
    attempt: 1,
    ...overrides,
  };
}

class Publisher implements BugPublisher {
  created = 0;
  comments: string[] = [];

  async ensureBug(record: RepairBugRecord): Promise<{ issueNumber: number; issueUrl: string }> {
    this.created += 1;
    return { issueNumber: 500, issueUrl: `https://github.com/siddharthakki/ollama-agent/issues/500#${record.fingerprint.slice(0, 8)}` };
  }

  async updateBug(_record: RepairBugRecord, message: string): Promise<void> {
    this.comments.push(message);
  }
}

class Assigner implements RepairAgentAssigner {
  sequence = 0;
  cancelled: string[] = [];

  async assign(): Promise<{ workerId: string; taskId: string }> {
    this.sequence += 1;
    return { workerId: 'repair-worker', taskId: `repair-task-${this.sequence}` };
  }

  async cancel(taskId: string): Promise<boolean> {
    this.cancelled.push(taskId);
    return true;
  }
}

describe('M21 CI bug and repair loop', () => {
  it('creates deterministic fingerprints that remove volatile paths, SHAs, and numbers', () => {
    const first = fingerprintFailure(pipeline('1'));
    const second = fingerprintFailure(pipeline('2', 'failure', {
      commitSha: 'ffffffffffffffff',
      errorSummary: 'Assertion failed at /home/runner/work/repo/src/example.ts:99',
    }));
    expect(first.value).toBe(second.value);
    expect(first.normalizedSummary).not.toContain('C:\\repo');
    expect(first.normalizedSummary).not.toContain('42');
  });

  it('creates one bug, deduplicates repeated failures, and assigns one bounded repair at a time', async () => {
    const publisher = new Publisher();
    const assigner = new Assigner();
    const loop = new CIBugRepairLoop(new InMemoryRepairLoopStore(), publisher, assigner, {
      maxRepairAttempts: 2,
      flakyLookback: 5,
      incidentSeverityAfterAttempts: 2,
    });

    const first = await loop.ingest(pipeline('1'));
    expect(first).toMatchObject({
      accepted: true,
      bug: { issueNumber: 500, occurrences: 1, repairAttempts: 1 },
      assignment: { taskId: 'repair-task-1', attempt: 1 },
    });
    const duplicateDelivery = await loop.ingest(pipeline('1'));
    expect(duplicateDelivery).toEqual({ accepted: false });
    const repeated = await loop.ingest(pipeline('2', 'failure', { errorSummary: 'Assertion failed at /repo/src/example.ts:43' }));
    expect(repeated.bug).toMatchObject({ issueNumber: 500, occurrences: 2 });
    expect(publisher.created).toBe(1);
  });

  it('rejects repair without regression evidence, retries once, then verifies a complete repair', async () => {
    const loop = new CIBugRepairLoop(new InMemoryRepairLoopStore(), new Publisher(), new Assigner(), {
      maxRepairAttempts: 2,
      flakyLookback: 5,
      incidentSeverityAfterAttempts: 2,
    });
    const ingested = await loop.ingest(pipeline('1'));
    const missingRegression = await loop.recordRepairOutcome({
      assignmentId: ingested.assignment!.id,
      succeeded: true,
      regressionTests: [],
      validationPassed: true,
      reviewPassed: true,
      pipelinePassed: true,
      summary: 'Forgot regression coverage',
    });
    expect(missingRegression).toMatchObject({
      bug: { state: 'repairing', repairAttempts: 2 },
      nextAssignment: { attempt: 2, taskId: 'repair-task-2' },
    });

    const verified = await loop.recordRepairOutcome({
      assignmentId: missingRegression.nextAssignment!.id,
      succeeded: true,
      regressionTests: ['src/test/example.test.ts'],
      validationPassed: true,
      reviewPassed: true,
      pipelinePassed: true,
      pipelineRunId: 'fixed-run',
      summary: 'Root cause fixed',
    });
    expect(verified.bug).toMatchObject({
      state: 'verified',
      verifiedByRunId: 'fixed-run',
      regressionTests: ['src/test/example.test.ts'],
    });
  });

  it('classifies alternating reruns as flaky and does not dispatch another repair', async () => {
    const publisher = new Publisher();
    const assigner = new Assigner();
    const loop = new CIBugRepairLoop(new InMemoryRepairLoopStore(), publisher, assigner, {
      maxRepairAttempts: 3,
      flakyLookback: 5,
      incidentSeverityAfterAttempts: 2,
    });
    await loop.ingest(pipeline('1'));
    await loop.ingest(pipeline('2', 'success'));
    const flaky = await loop.ingest(pipeline('3', 'failure'));
    expect(flaky.bug?.flaky).toBe('flaky');
    expect(flaky.assignment).toBeUndefined();
    expect(classifyFlaky([pipeline('1'), pipeline('2', 'success')], pipeline('3'), 5)).toBe('flaky');
  });

  it('creates durable incident evidence when the bounded repair budget is exhausted', async () => {
    const loop = new CIBugRepairLoop(new InMemoryRepairLoopStore(), new Publisher(), new Assigner(), {
      maxRepairAttempts: 2,
      flakyLookback: 5,
      incidentSeverityAfterAttempts: 2,
    });
    const ingested = await loop.ingest(pipeline('1'));
    const retry = await loop.recordRepairOutcome({
      assignmentId: ingested.assignment!.id,
      succeeded: false,
      regressionTests: ['src/test/regression.test.ts'],
      validationPassed: false,
      reviewPassed: false,
      pipelinePassed: false,
      summary: 'Attempt one failed',
    });
    const exhausted = await loop.recordRepairOutcome({
      assignmentId: retry.nextAssignment!.id,
      succeeded: false,
      regressionTests: ['src/test/regression.test.ts'],
      validationPassed: false,
      reviewPassed: false,
      pipelinePassed: false,
      summary: 'Attempt two failed',
    });
    expect(exhausted).toMatchObject({
      bug: { state: 'exhausted', repairAttempts: 2 },
      incident: {
        severity: 'sev2',
        sourceRuns: ['1'],
        repairAssignments: expect.arrayContaining([ingested.assignment!.id, retry.nextAssignment!.id]),
      },
    });
  });
});
