import { describe, expect, it } from 'vitest';
import { COCKPIT_VISIBLE_LIMIT, projectMetrics, projectMissionCockpit } from '../src/host/missionCockpit';
import {
  LONG_PYTHON_TODO_RESPONSE,
  RECORDED_ATTEMPT,
  RECORDED_REQUEST,
  RECORDED_RESULT,
  RECORDED_START,
  cockpitInput,
  eventFromSummary,
  recorded120,
} from './recordedMissionStream';

describe('mission cockpit projection', () => {
  it('sums provider-reported cloud spend separately from estimated cost avoided', () => {
    const at = RECORDED_START;
    const events = [
      eventFromSummary('model_invocation:model_invocation_completed', at, {
        eventType: 'model_invocation_completed',
        promptTokens: 100,
        completionTokens: 50,
        costUsd: 0.0012,
      }),
      eventFromSummary('model_invocation:model_invocation_completed', at, {
        eventType: 'model_invocation_completed',
        promptTokens: 80,
        completionTokens: 20,
      }),
    ];
    const metrics = projectMetrics(events);
    expect(metrics.actualSpendUsd).toBeCloseTo(0.0012, 6);
    expect(metrics.cloudCostAvoidedUsd).not.toBeNull();
    const view = projectMissionCockpit(events, cockpitInput({ spendCapUsd: 0.5 }));
    expect(view.metrics.spendCapUsd).toBe(0.5);
    expect(view.metrics.actualSpendUsd).toBeCloseTo(0.0012, 6);
  });

  it('pairs Core completions by identity and counts only observed non-cached actions', () => {
    const at = RECORDED_START;
    const events = [
      eventFromSummary('tool start: read_file {"path":"kept.txt","cached":true}', at, { invocationId: 'read' }),
      eventFromSummary('tool start: propose_file_change {"path":"rejected.txt"}', at, { invocationId: 'edit' }),
      eventFromSummary('tool failed: unknown_tool permission denied', at, { invocationId: 'edit' }),
      eventFromSummary('tool succeeded: unknown_tool contents', at, { invocationId: 'read' }),
      eventFromSummary('tool start: protocol_correction {}', at, { invocationId: 'protocol' }),
      eventFromSummary('tool failed: unknown_tool resend one action', at, { invocationId: 'protocol' }),
      eventFromSummary('tool start: workspace_validation {}', at, { invocationId: 'validation' }),
      eventFromSummary('tool cancelled: unknown_tool', at, { invocationId: 'validation' }),
    ];
    const view = projectMissionCockpit(events, cockpitInput());
    expect(view.filesRead).toEqual(['kept.txt']);
    expect(view.filesChanged).toEqual([]);
    expect(view.phase).toBe('investigation');
    expect(view.productiveUsed).toBe(1);
    expect(view.validationStatus).toBe('Cancelled');
    expect(view.currentAction).toBeNull();
  });

  it('proves edit, failed validation, repair, revalidation, verification and final result', () => {
    const events = [] as ReturnType<typeof eventFromSummary>[];
    const add = (summary: string, extra = {}) => events.push(eventFromSummary(summary,
      new Date(Date.parse(RECORDED_START) + events.length * 1_000).toISOString(), extra));
    add('tool start: propose_file_change {"path":"tip.js"}');
    add('tool succeeded: unknown_tool written');
    add('tool start: workspace_validation {}');
    expect(projectMissionCockpit(events, cockpitInput()).validationStatus).toBe('Running');
    add('tool failed: unknown_tool assertion failed');
    add('tool start: propose_file_change {"path":"tip.js"}');
    add('tool succeeded: unknown_tool written');
    add('tool start: workspace_validation {}');
    add('tool succeeded: unknown_tool passed');
    add('tool start: verify_acceptance {}');
    add('tool succeeded: unknown_tool passed');
    add('Final answer from Core conversation', { kind: 'result', text: 'Tip calculation fixed and committed.' });
    const input = cockpitInput({ running: false, terminal: true });
    const view = projectMissionCockpit(events, input);
    expect(view.filesChanged).toEqual(['tip.js']);
    expect(view.phase).toBe('repair');
    expect(view.repairCycle).toBe(1);
    expect(view.productiveUsed).toBe(2);
    expect(view.validationStatus).toBe('Passed');
    expect(view.verificationStatus).toBe('Passed');
    expect(view.finalOutcome).toBe('Tip calculation fixed and committed.');
    expect(view.elapsedMs).toBe(10_000);
    expect(projectMissionCockpit(events, { ...input, nowMs: input.nowMs + 60_000 }).elapsedMs).toBe(10_000);
  });

  it('names the changed file when Core auto-authorized the mutation under its own attempt', () => {
    // Core runs an auto-authorized in-scope mutation as a separate attempt, so
    // the mission stream carries no propose_file_change completion. Validation
    // and the passing diff review still name the mutated path.
    const events = [] as ReturnType<typeof eventFromSummary>[];
    const add = (summary: string, extra = {}) => events.push(eventFromSummary(summary,
      new Date(Date.parse(RECORDED_START) + events.length * 1_000).toISOString(), extra));
    add('tool start: workspace_validation {"path":"src/wordCount.js","gates":["npm run test"]}');
    add('tool succeeded: unknown_tool Validation: passed');
    add('tool start: run_check {}');
    add('tool succeeded: run_check diff review passed for src/wordCount.js');
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    expect(view.filesChanged).toEqual(['src/wordCount.js']);
    expect(view.phase).toBe('implementation');
  });

  it('takes changed files from Core structured check evidence rather than its output', () => {
    const events = [
      eventFromSummary('tool start: run_check {"check":"diff"}', RECORDED_START, { invocationId: 'review' }),
      eventFromSummary('tool succeeded: run_check review done', RECORDED_START, {
        invocationId: 'review',
        check: { kind: 'diff_review', status: 'passed', reviewedPaths: ['src/a.js', 'src/b.js'] },
      }),
    ];
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    expect(view.filesChanged).toEqual(['src/a.js', 'src/b.js']);
    expect(view.phase).toBe('implementation');
  });

  it('ignores structured evidence from a check that did not pass', () => {
    const events = [
      eventFromSummary('tool start: run_check {"check":"commit"}', RECORDED_START, { invocationId: 'deliver' }),
      eventFromSummary('tool succeeded: run_check diff review passed for src/spoof.js', RECORDED_START, {
        invocationId: 'deliver',
        check: { kind: 'commit', status: 'blocked', reviewedPaths: ['src/spoof.js'] },
      }),
    ];
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    expect(view.filesChanged).toEqual([]);
  });

  it('reports no changed file when a diff review rejected the manifest', () => {
    const events = [
      eventFromSummary('tool start: run_check {}', RECORDED_START, { invocationId: 'review' }),
      eventFromSummary(
        'tool succeeded: run_check diff review rejected: unsafe artifact in delivery: .tmp/profile/Cookies (browser profile)',
        RECORDED_START,
        { invocationId: 'review' },
      ),
    ];
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    expect(view.filesChanged).toEqual([]);
  });

  it('closes running checkpoints at cancellation and rejects another request', () => {
    const events = [
      eventFromSummary('model_invocation:model_invocation_started', RECORDED_START),
      eventFromSummary('tool start: read_file {"path":"other.txt"}', RECORDED_START, { requestId: 'req_other' }),
      eventFromSummary('Attempt cancelled by Core', RECORDED_START, { kind: 'cancelled' }),
    ];
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    expect(view.diagnostics).toHaveLength(2);
    expect(view.checkpoints.some((item) => item.outcome === 'running')).toBe(false);
    expect(view.finalOutcome).toBe('Attempt cancelled by Core');
  });
  it('keeps one attempt, coalesces a 120-event stream, and does not stale-wait after resume', () => {
    const stream = recorded120();
    expect(stream).toHaveLength(120);
    const runningStream = stream.filter((event) => event.kind !== 'error' && event.eventType !== 'attempt_failed');
    const view = projectMissionCockpit(runningStream, cockpitInput());
    expect(view.attemptId).toBe(RECORDED_ATTEMPT);
    expect(view.requestId).toBe(RECORDED_REQUEST);
    expect(view.checkpoints.length).toBeGreaterThanOrEqual(8);
    expect(view.checkpoints.length).toBeLessThanOrEqual(COCKPIT_VISIBLE_LIMIT);
    expect(view.diagnostics.length).toBeGreaterThan(view.checkpoints.length);
    expect(view.finalOutcome).toBeNull();
    expect(view.authState).toBe('collapsed');
    expect(view.checkpoints.some((item) => /Waiting for mutation approval/.test(`${item.title} ${item.detail ?? ''}`))).toBe(false);
    expect(view.filesRead).toContain('src/app.js');
    expect(view.elapsedMs).toBe(10 * 60_000);
    expect(view.remainingAbsoluteMs).toBe(10 * 60_000);
    const model = view.checkpoints.find((item) => item.title === 'AI response');
    expect(model?.durationMs).toBeGreaterThan(0);
    expect(view.checkpoints.every((item) => Date.parse(item.at) >= Date.parse(RECORDED_START))).toBe(true);
  });

  it('drops other attempts and shows the terminal outcome only when failed', () => {
    const mixed = [
      eventFromSummary('Submitted other on qwen', RECORDED_START, { attemptId: 'att_other', requestId: 'req_other' }),
      ...recorded120(),
    ];
    const runningEvents = [
      ...mixed.filter((event) => event.kind !== 'error' && event.eventType !== 'attempt_failed'),
      eventFromSummary('model_invocation:model_invocation_started', RECORDED_START, { eventType: 'model_invocation_started' }),
    ];
    const running = projectMissionCockpit(runningEvents, cockpitInput());
    expect(running.diagnostics.every((item) => item.attemptId !== 'att_other')).toBe(true);
    expect(running.finalOutcome).toBeNull();
    expect(running.currentAction).not.toBeNull();

    const terminal = projectMissionCockpit(mixed, cockpitInput({
      running: false,
      terminal: true,
      nowMs: Date.parse(RECORDED_START) + 20 * 60_000 + 1,
    }));
    expect(terminal.finalOutcome).toBe(RECORDED_RESULT);
    expect(terminal.currentAction).toBeNull();
    expect(terminal.remainingAbsoluteMs).toBe(0);
    expect(terminal.verificationStatus).toMatch(/Failed/);
    expect(terminal.validationStatus).toBe('Passed');
    expect(terminal.checkpoints.some((item) => item.title.includes('Verify'))).toBe(true);
  });

  it('shows token counts on a model checkpoint when Core reports them', () => {
    const at = RECORDED_START;
    const view = projectMissionCockpit([
      eventFromSummary('model_invocation:model_invocation_started', at, { eventType: 'model_invocation_started' }),
      eventFromSummary('model_invocation:model_invocation_completed', new Date(Date.parse(at) + 2_000).toISOString(), {
        eventType: 'model_invocation_completed',
        promptTokens: 1024,
        completionTokens: 88,
      }),
    ], cockpitInput({ approvedApproval: null }));
    expect(view.checkpoints[0]?.title).toBe('AI response');
    expect(view.checkpoints[0]?.detail).toBe('1024 prompt tokens / 88 generated');
    expect(view.checkpoints[0]?.durationMs).toBe(2_000);
  });
});

describe('run metrics', () => {
  const completion = (extra: Record<string, unknown>) => eventFromSummary(
    'model_invocation:model_invocation_completed',
    RECORDED_START,
    { eventType: 'model_invocation_completed', ...extra },
  );

  it('reports generation speed from generation time when the backend provides it', () => {
    const metrics = projectMetrics([
      completion({ promptTokens: 1000, completionTokens: 200, generationMs: 10_000, durationMs: 25_000 }),
    ]);
    expect(metrics.generationRate).toEqual({ tokensPerSecond: 20, basis: 'generation' });
  });

  it('labels the rate end-to-end when only total call time is available', () => {
    const metrics = projectMetrics([
      completion({ promptTokens: 1000, completionTokens: 200, durationMs: 25_000 }),
    ]);
    expect(metrics.generationRate?.basis).toBe('end-to-end');
    expect(metrics.generationRate?.tokensPerSecond).toBeCloseTo(8, 5);
  });

  it('reports unavailable rather than zero when nothing was measured', () => {
    const metrics = projectMetrics([completion({})]);
    expect(metrics.aiResponses).toBe(1);
    expect(metrics.promptTokens).toBeNull();
    expect(metrics.generatedTokens).toBeNull();
    expect(metrics.generationRate).toBeNull();
    expect(metrics.cloudCostAvoidedUsd).toBeNull();
  });

  it('charges every call its full prompt, including context resent each turn', () => {
    const metrics = projectMetrics([
      completion({ promptTokens: 1_000_000, completionTokens: 0 }),
      completion({ promptTokens: 1_000_000, completionTokens: 1_000_000 }),
    ]);
    expect(metrics.promptTokens).toBe(2_000_000);
    // 2 MTok input at $2 plus 1 MTok output at $10.
    expect(metrics.cloudCostAvoidedUsd).toBeCloseTo(14, 6);
    expect(metrics.comparison.model).toBe('Claude Sonnet 5');
    expect(metrics.comparison.verifiedOn).toBe('2026-09-14');
    expect(metrics.comparison.exclusions).toContain('electricity');
  });
});

describe('event stream stays a bounded operational summary (regression: full response dumped as "Mission completed")', () => {
  it('a long code-plus-prose reply never lands in the terminal checkpoint\'s detail — only in finalOutcome', () => {
    const events = [
      eventFromSummary('Reply from Core conversation', RECORDED_START, { kind: 'result', text: LONG_PYTHON_TODO_RESPONSE }),
    ];
    const view = projectMissionCockpit(events, cockpitInput({ running: false, terminal: true }));
    const terminalCheckpoint = view.checkpoints.find((c) => c.id.startsWith('term:'));
    expect(terminalCheckpoint).toBeDefined();
    expect(terminalCheckpoint!.detail).toBeUndefined();
    expect(terminalCheckpoint!.title).toBe('Mission completed');
    // The full text is still available, but only via finalOutcome — the
    // conversation pane's source, not the event stream's.
    expect(view.finalOutcome).toBe(LONG_PYTHON_TODO_RESPONSE);
    for (const checkpoint of view.checkpoints) {
      expect(checkpoint.detail ?? '').not.toContain('import json');
      expect(checkpoint.detail ?? '').not.toContain('def main():');
    }
  });
});
