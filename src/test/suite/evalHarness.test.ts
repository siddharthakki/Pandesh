import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { BASELINE_MODEL, getStableEvalScenarios } from '../../evals/EvalCatalog';
import { EvalRunner, aggregateEvalMetrics, compareEvalRuns } from '../../evals/EvalRunner';
import { EvalStore } from '../../evals/EvalStore';
import { ReplayEvalAdapter } from '../../evals/ReplayEvalAdapter';
import { EvalObservation, EvalRunResult } from '../../evals/EvalTypes';

function observation(scenarioId: string, overrides: Partial<EvalObservation> = {}): EvalObservation {
  return {
    scenarioId,
    success: true,
    buildPassed: true,
    testsPassed: true,
    invalidToolCalls: 0,
    totalToolCalls: 4,
    loopDetected: false,
    repairAttempts: 0,
    approvalsRequested: 1,
    elapsedMs: 1000,
    modelCalls: 2,
    inputTokens: 100,
    outputTokens: 50,
    changedFiles: [],
    incorrectFilesChanged: [],
    rollbackAttempted: false,
    providerResponseEquivalent: true,
    contextFiles: ['src/a.ts', 'src/a.test.ts'],
    contextRelevantFiles: ['src/a.ts', 'src/a.test.ts'],
    evidence: {},
    ...overrides,
  };
}

describe('Phase 10 evaluation harness', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-evals-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('provides a stable versioned scenario for every required category', () => {
    const scenarios = getStableEvalScenarios();
    const categories = new Set(scenarios.map(scenario => scenario.category));
    expect(categories).toEqual(new Set([
      'tool_selection',
      'invalid_tool_handling',
      'one_file_edit',
      'multi_file_edit',
      'refactoring',
      'test_creation',
      'safety',
      'approval_rejection',
      'recovery',
      'validation_repair',
      'context_selection',
      'provider_parity',
    ]));
    expect(new Set(scenarios.map(scenario => scenario.id)).size).toBe(scenarios.length);
    expect(scenarios.every(scenario => scenario.version === 1)).toBe(true);
  });

  it('runs, aggregates, and persists comparable baseline results', async () => {
    const scenarios = getStableEvalScenarios().slice(0, 3);
    const observations = Object.fromEntries(
      scenarios.map(scenario => [scenario.id, observation(scenario.id)]),
    );
    const store = new EvalStore(root);
    const runner = new EvalRunner(new ReplayEvalAdapter(observations), store, scenarios);
    const result = await runner.run({
      model: BASELINE_MODEL,
      providerType: 'ollama',
      extensionVersion: '0.1.0',
      commit: 'abc123',
    });

    expect(result.model).toBe('qwen3-coder:30b');
    expect(result.metrics.taskSuccessRate).toBe(1);
    expect(result.metrics.buildSuccessRate).toBe(1);
    expect(result.metrics.invalidToolRate).toBe(0);
    expect(result.metrics.contextPrecision).toBe(1);
    expect((await store.latest())?.runId).toBe(result.runId);
    expect((await store.list())).toHaveLength(1);
  });

  it('calculates required metrics correctly', () => {
    const scenario = getStableEvalScenarios()[0];
    const metrics = aggregateEvalMetrics([
      { scenario, observation: observation(scenario.id) },
      {
        scenario,
        observation: observation(scenario.id, {
          success: false,
          buildPassed: false,
          testsPassed: false,
          invalidToolCalls: 2,
          totalToolCalls: 4,
          loopDetected: true,
          repairAttempts: 2,
          approvalsRequested: 3,
          elapsedMs: 3000,
          modelCalls: 6,
          incorrectFilesChanged: ['wrong.ts'],
          rollbackAttempted: true,
          rollbackSucceeded: false,
          providerResponseEquivalent: false,
          contextFiles: ['src/a.ts', 'src/wrong.ts'],
          contextRelevantFiles: ['src/a.ts'],
        }),
      },
    ]);

    expect(metrics.taskSuccessRate).toBe(0.5);
    expect(metrics.buildSuccessRate).toBe(0.5);
    expect(metrics.testSuccessRate).toBe(0.5);
    expect(metrics.invalidToolRate).toBe(0.25);
    expect(metrics.loopRate).toBe(0.5);
    expect(metrics.meanRepairAttempts).toBe(1);
    expect(metrics.meanApprovals).toBe(2);
    expect(metrics.meanElapsedMs).toBe(2000);
    expect(metrics.meanModelCalls).toBe(4);
    expect(metrics.incorrectFilesChanged).toBe(1);
    expect(metrics.rollbackSuccessRate).toBe(0);
  });

  it('surfaces regressions and improvements across compatible releases', () => {
    const base = runResult('base', {
      taskSuccessRate: 1,
      invalidToolRate: 0.01,
      loopRate: 0.2,
      meanElapsedMs: 1000,
    });
    const current = runResult('current', {
      taskSuccessRate: 0.7,
      invalidToolRate: 0.2,
      loopRate: 0,
      meanElapsedMs: 800,
    });
    const comparison = compareEvalRuns(base, current, 0.05);

    expect(comparison.compatible).toBe(true);
    expect(comparison.regressions.map(item => item.metric)).toEqual(expect.arrayContaining([
      'taskSuccessRate', 'invalidToolRate',
    ]));
    expect(comparison.improvements.map(item => item.metric)).toEqual(expect.arrayContaining([
      'loopRate', 'meanElapsedMs',
    ]));
  });

  it('refuses direct comparison across suite versions', () => {
    const base = runResult('base', {});
    const current = { ...runResult('current', {}), suiteVersion: 2 };
    expect(compareEvalRuns(base, current).compatible).toBe(false);
  });

  it('turns missing replay observations into named failed scenarios', async () => {
    const scenario = getStableEvalScenarios()[0];
    const runner = new EvalRunner(new ReplayEvalAdapter({}), undefined, [scenario]);
    const result = await runner.run({
      model: BASELINE_MODEL,
      providerType: 'ollama',
      extensionVersion: '0.1.0',
    });
    expect(result.results[0].observation.success).toBe(false);
    expect(result.results[0].observation.error).toMatch(/no recorded observation/i);
  });
});

function runResult(
  runId: string,
  metricOverrides: Partial<EvalRunResult['metrics']>,
): EvalRunResult {
  return {
    schemaVersion: 1,
    suiteId: 'ollama-agent-core',
    suiteVersion: 1,
    runId,
    model: BASELINE_MODEL,
    providerType: 'ollama',
    extensionVersion: '0.1.0',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    results: [],
    metrics: {
      scenarios: 12,
      taskSuccessRate: 1,
      buildSuccessRate: 1,
      testSuccessRate: 1,
      invalidToolRate: 0,
      loopRate: 0,
      meanRepairAttempts: 0,
      meanApprovals: 1,
      meanElapsedMs: 1000,
      meanModelCalls: 2,
      totalInputTokens: 1000,
      totalOutputTokens: 500,
      incorrectFilesChanged: 0,
      rollbackSuccessRate: 1,
      providerParityRate: 1,
      contextPrecision: 1,
      ...metricOverrides,
    },
  };
}
