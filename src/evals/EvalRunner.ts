import {
  EvalAdapter,
  EvalAggregateMetrics,
  EvalComparison,
  EvalObservation,
  EvalRegression,
  EvalRunOptions,
  EvalRunResult,
  EvalScenario,
  EvalScenarioResult,
} from './EvalTypes';
import {
  EVAL_SUITE_ID,
  EVAL_SUITE_VERSION,
  getStableEvalScenarios,
} from './EvalCatalog';
import { EvalStore } from './EvalStore';

function rate(values: boolean[]): number {
  return values.length === 0 ? 0 : values.filter(Boolean).length / values.length;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalize(value: number): number {
  return Number(value.toFixed(6));
}

function defaultObservation(scenarioId: string, elapsedMs: number, error: string): EvalObservation {
  return {
    scenarioId,
    success: false,
    invalidToolCalls: 0,
    totalToolCalls: 0,
    loopDetected: false,
    repairAttempts: 0,
    approvalsRequested: 0,
    elapsedMs,
    modelCalls: 0,
    changedFiles: [],
    incorrectFilesChanged: [],
    rollbackAttempted: false,
    error,
    evidence: {},
  };
}

export function aggregateEvalMetrics(results: EvalScenarioResult[]): EvalAggregateMetrics {
  const observations = results.map(result => result.observation);
  const toolCalls = observations.reduce((sum, observation) => sum + observation.totalToolCalls, 0);
  const invalidCalls = observations.reduce((sum, observation) => sum + observation.invalidToolCalls, 0);
  const rollback = observations.filter(observation => observation.rollbackAttempted);
  const parity = observations.filter(observation => observation.providerResponseEquivalent !== undefined);
  const contextObservations = observations.filter(observation => observation.contextRelevantFiles?.length);
  const contextRelevantSelected = contextObservations.reduce((sum, observation) => {
    const selected = new Set(observation.contextFiles ?? []);
    return sum + (observation.contextRelevantFiles ?? []).filter(file => selected.has(file)).length;
  }, 0);
  const contextSelected = contextObservations.reduce(
    (sum, observation) => sum + Math.max(1, observation.contextFiles?.length ?? 0),
    0,
  );

  return {
    scenarios: observations.length,
    taskSuccessRate: normalize(rate(observations.map(observation => observation.success))),
    buildSuccessRate: normalize(rate(observations
      .filter(observation => observation.buildPassed !== undefined)
      .map(observation => Boolean(observation.buildPassed)))),
    testSuccessRate: normalize(rate(observations
      .filter(observation => observation.testsPassed !== undefined)
      .map(observation => Boolean(observation.testsPassed)))),
    invalidToolRate: normalize(toolCalls === 0 ? 0 : invalidCalls / toolCalls),
    loopRate: normalize(rate(observations.map(observation => observation.loopDetected))),
    meanRepairAttempts: normalize(mean(observations.map(observation => observation.repairAttempts))),
    meanApprovals: normalize(mean(observations.map(observation => observation.approvalsRequested))),
    meanElapsedMs: normalize(mean(observations.map(observation => observation.elapsedMs))),
    meanModelCalls: normalize(mean(observations.map(observation => observation.modelCalls))),
    totalInputTokens: observations.reduce((sum, observation) => sum + (observation.inputTokens ?? 0), 0),
    totalOutputTokens: observations.reduce((sum, observation) => sum + (observation.outputTokens ?? 0), 0),
    incorrectFilesChanged: observations.reduce(
      (sum, observation) => sum + observation.incorrectFilesChanged.length,
      0,
    ),
    rollbackSuccessRate: normalize(rate(rollback.map(observation => Boolean(observation.rollbackSucceeded)))),
    providerParityRate: normalize(rate(parity.map(observation => Boolean(observation.providerResponseEquivalent)))),
    contextPrecision: normalize(contextSelected === 0 ? 0 : contextRelevantSelected / contextSelected),
  };
}

export class EvalRunner {
  constructor(
    private readonly adapter: EvalAdapter,
    private readonly store?: EvalStore,
    private readonly scenarios: readonly EvalScenario[] = getStableEvalScenarios(),
  ) {}

  async run(options: EvalRunOptions): Promise<EvalRunResult> {
    const runId = `eval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const startedAt = new Date().toISOString();
    const selected = this.scenarios.filter(scenario => {
      if (options.categories && !options.categories.includes(scenario.category)) { return false; }
      if (options.scenarioIds && !options.scenarioIds.includes(scenario.id)) { return false; }
      return true;
    });
    const results: EvalScenarioResult[] = [];

    for (const scenario of selected) {
      if (options.signal?.aborted) { break; }
      const started = Date.now();
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), scenario.timeoutMs);
      let observation: EvalObservation;
      try {
        observation = await this.adapter.execute({
          runId,
          model: options.model,
          providerType: options.providerType,
          scenario,
        }, controller.signal);
        observation = {
          ...observation,
          scenarioId: scenario.id,
          elapsedMs: observation.elapsedMs || Math.max(0, Date.now() - started),
        };
      } catch (error) {
        const timedOut = controller.signal.aborted && !options.signal?.aborted;
        observation = defaultObservation(
          scenario.id,
          Math.max(0, Date.now() - started),
          timedOut
            ? `Scenario timed out after ${scenario.timeoutMs} ms`
            : error instanceof Error ? error.message : String(error),
        );
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      }
      results.push({ scenario, observation });
      if (options.failFast && !observation.success) { break; }
    }

    const result: EvalRunResult = {
      schemaVersion: 1,
      suiteId: EVAL_SUITE_ID,
      suiteVersion: EVAL_SUITE_VERSION,
      runId,
      model: options.model,
      providerType: options.providerType,
      extensionVersion: options.extensionVersion,
      commit: options.commit,
      startedAt,
      completedAt: new Date().toISOString(),
      metrics: aggregateEvalMetrics(results),
      results,
    };
    await this.store?.write(result);
    return result;
  }
}

const HIGHER_IS_BETTER: Array<keyof EvalAggregateMetrics> = [
  'taskSuccessRate',
  'buildSuccessRate',
  'testSuccessRate',
  'rollbackSuccessRate',
  'providerParityRate',
  'contextPrecision',
];

const LOWER_IS_BETTER: Array<keyof EvalAggregateMetrics> = [
  'invalidToolRate',
  'loopRate',
  'meanRepairAttempts',
  'meanApprovals',
  'meanElapsedMs',
  'meanModelCalls',
  'incorrectFilesChanged',
];

export function compareEvalRuns(
  baseline: EvalRunResult,
  current: EvalRunResult,
  threshold = 0.05,
): EvalComparison {
  if (baseline.suiteId !== current.suiteId || baseline.suiteVersion !== current.suiteVersion) {
    return {
      baselineRunId: baseline.runId,
      currentRunId: current.runId,
      regressions: [],
      improvements: [],
      compatible: false,
    };
  }

  const regressions: EvalRegression[] = [];
  const improvements: EvalRegression[] = [];
  const inspect = (
    metric: keyof EvalAggregateMetrics,
    direction: EvalRegression['direction'],
  ) => {
    const baselineValue = baseline.metrics[metric];
    const currentValue = current.metrics[metric];
    if (typeof baselineValue !== 'number' || typeof currentValue !== 'number') { return; }
    const delta = currentValue - baselineValue;
    const scale = Math.max(Math.abs(baselineValue), 1);
    const relative = Math.abs(delta) / scale;
    if (relative < threshold && Math.abs(delta) < threshold) { return; }
    const improved = direction === 'higher_is_better' ? delta > 0 : delta < 0;
    const item: EvalRegression = {
      metric,
      baseline: baselineValue,
      current: currentValue,
      delta: normalize(delta),
      severity: relative >= threshold * 2 ? 'failure' : 'warning',
      direction,
    };
    (improved ? improvements : regressions).push(item);
  };

  HIGHER_IS_BETTER.forEach(metric => inspect(metric, 'higher_is_better'));
  LOWER_IS_BETTER.forEach(metric => inspect(metric, 'lower_is_better'));
  return {
    baselineRunId: baseline.runId,
    currentRunId: current.runId,
    regressions,
    improvements,
    compatible: true,
  };
}
