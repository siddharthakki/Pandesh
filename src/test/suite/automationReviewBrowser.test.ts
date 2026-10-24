import { describe, expect, it } from 'vitest';
import { JobCoordinator } from '../../automation/JobCoordinator';
import { InMemoryAutomationStorage } from '../../automation/AutomationStorage';
import { ReviewWorkflow } from '../../review/ReviewWorkflow';
import {
  AccessibilitySnapshot,
  BrowserAssertion,
  BrowserDriver,
  BrowserLaunchOptions,
  BrowserVerificationRunner,
} from '../../browser/BrowserVerification';

class FakeBrowserDriver implements BrowserDriver {
  closed = false;
  async launch(_options: BrowserLaunchOptions, _signal: AbortSignal): Promise<void> {}
  async navigate(url: string): Promise<{ url: string; status: number; title: string }> {
    return { url, status: 200, title: 'Application' };
  }
  async assert(assertion: BrowserAssertion): Promise<{ passed: boolean; actual?: unknown }> {
    return { passed: true, actual: assertion.expected ?? true };
  }
  async screenshot(): Promise<{ dataHash: string; width: number; height: number }> {
    return { dataHash: 'a'.repeat(64), width: 1440, height: 900 };
  }
  async consoleEntries(): Promise<[]> { return []; }
  async networkEntries(): Promise<Array<{ method: string; url: string; status: number }>> {
    return [{ method: 'GET', url: 'https://example.test/api', status: 200 }];
  }
  async accessibilitySnapshot(): Promise<AccessibilitySnapshot> {
    return { role: 'main', name: 'Application' };
  }
  async close(): Promise<void> { this.closed = true; }
}

describe('Phase 28 automation review and browser verification', () => {
  it('resumes durable jobs without repeating a completed mutation', async () => {
    const storage = new InMemoryAutomationStorage();
    const jobs = new JobCoordinator({ storage });
    await jobs.initialize();
    await jobs.register({
      id: 'job-one',
      title: 'one-time job',
      trigger: { type: 'schedule', runAt: new Date(Date.now() - 1000).toISOString() },
      task: { goal: 'update report' },
      isolatedExecution: 'worktree',
      budget: { maxRuns: 1, maxWallClockMs: 5000, maxMutations: 1 },
      approvalBeforePublish: false,
    });
    const state = await jobs.execute('job-one', async context => {
      const key = context.mutationKey('write', { file: 'report.json' });
      await context.markMutationCompleted(key);
      await context.markMutationCompleted(key);
      return { status: 'completed', mutations: 1 };
    });

    expect(state.status).toBe('completed');
    expect(state.runCount).toBe(1);
    expect(state.completedMutationKeys).toHaveLength(1);
  });

  it('repairs only files attached to accepted review findings', async () => {
    const review = new ReviewWorkflow([
      '--- a/src/value.ts',
      '+++ b/src/value.ts',
      '@@ -1,1 +1,1 @@',
      '-export const value = 1;',
      '+export const value = 2;',
    ].join('\n'), 'review-one');
    const hunkId = review.snapshot().files[0].hunks[0].id;
    review.ingestFindings([{
      id: 'finding-one', source: 'agent', file: 'src/value.ts', hunkId,
      severity: 'error', confidence: 0.9, message: 'Update the assertion.',
    }]);
    review.decideHunk(hunkId, 'accepted');
    review.decideFinding('finding-one', 'accepted');
    await review.repair(async request => ({
      changedFiles: [...request.allowedFiles],
      resolvedFindingIds: ['finding-one'],
      summary: 'repaired',
    }));
    review.addValidation({ id: 'tests', name: 'tests', status: 'passed' });

    expect(review.complete().status).toBe('completed');
  });

  it('collects behavioral browser evidence and always closes the driver', async () => {
    const driver = new FakeBrowserDriver();
    const report = await new BrowserVerificationRunner(driver).verify({
      verificationId: 'ui-one',
      startUrl: 'https://example.test/app',
      allowedHosts: ['example.test'],
      assertions: [{ id: 'main-visible', type: 'visible', selector: 'main', description: 'main is visible', required: true }],
      screenshots: ['final'],
      failOnConsoleError: true,
      failOnNetworkError: true,
    });

    expect(report.passed).toBe(true);
    expect(report.assertions[0].passed).toBe(true);
    expect(report.screenshots).toHaveLength(1);
    expect(report.accessibility?.role).toBe('main');
    expect(driver.closed).toBe(true);
  });
});
