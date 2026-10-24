import { createHash, randomUUID } from 'crypto';

export type FrontierCapability =
  | 'long-horizon-coding'
  | 'debugging'
  | 'review-repair'
  | 'ui-verification'
  | 'automation'
  | 'recovery'
  | 'safety'
  | 'context-isolation'
  | 'multi-agent'
  | 'performance';

export interface FrontierScenario {
  id: string;
  capability: FrontierCapability;
  title: string;
  fixtureFingerprint: string;
  required: boolean;
  timeoutMs: number;
  acceptance: string[];
}

export interface FrontierScenarioEvidence {
  scenarioId: string;
  passed: boolean;
  durationMs: number;
  deterministicReplayPassed: boolean;
  changedFiles?: string[];
  validation?: Record<string, boolean>;
  metrics?: Record<string, number>;
  artifacts?: string[];
  error?: string;
}

export interface FrontierThresholds {
  minimumOverallPassRate: number;
  minimumCapabilityPassRate: number;
  requireDeterministicReplay: boolean;
  maximumSafetyFailures: number;
  maximumContextIsolationFailures: number;
}

export interface FrontierCapabilityScore {
  capability: FrontierCapability;
  scenarios: number;
  passed: number;
  passRate: number;
  deterministicReplayRate: number;
  meanDurationMs: number;
}

export interface FrontierAcceptanceReport {
  schemaVersion: 1;
  runId: string;
  suiteFingerprint: string;
  candidate: {
    version: string;
    commit: string;
    environmentFingerprint: string;
  };
  startedAt: string;
  completedAt: string;
  passed: boolean;
  parityClaimAllowed: boolean;
  overallPassRate: number;
  scores: FrontierCapabilityScore[];
  evidence: FrontierScenarioEvidence[];
  failures: string[];
}

export type FrontierScenarioExecutor = (
  scenario: FrontierScenario,
  signal: AbortSignal,
) => Promise<FrontierScenarioEvidence>;

export class FrontierAcceptanceBenchmark {
  private readonly scenarios = new Map<string, FrontierScenario>();
  private controller?: AbortController;

  constructor(
    scenarios: readonly FrontierScenario[],
    private readonly thresholds: FrontierThresholds,
  ) {
    validateThresholds(thresholds);
    for (const scenario of scenarios) {
      validateScenario(scenario);
      if (this.scenarios.has(scenario.id)) throw new Error(`Duplicate frontier scenario: ${scenario.id}`);
      this.scenarios.set(scenario.id, clone(scenario));
    }
    const capabilities = new Set(scenarios.map(scenario => scenario.capability));
    for (const required of REQUIRED_CAPABILITIES) {
      if (!capabilities.has(required)) throw new Error(`Frontier suite is missing capability ${required}.`);
    }
  }

  async run(
    candidate: FrontierAcceptanceReport['candidate'],
    executor: FrontierScenarioExecutor,
  ): Promise<FrontierAcceptanceReport> {
    if (this.controller) throw new Error('Frontier acceptance run is already active.');
    validateCandidate(candidate);
    this.controller = new AbortController();
    const parentSignal = this.controller.signal;
    const startedAt = new Date().toISOString();
    const evidence: FrontierScenarioEvidence[] = [];
    try {
      for (const scenario of [...this.scenarios.values()].sort((left, right) => left.id.localeCompare(right.id))) {
        if (parentSignal.aborted) throw cancellationError();
        const started = Date.now();
        const scenarioController = new AbortController();
        const onParentAbort = () => scenarioController.abort();
        parentSignal.addEventListener('abort', onParentAbort, { once: true });
        let timer: NodeJS.Timeout | undefined;
        try {
          const execution = executor(clone(scenario), scenarioController.signal);
          const timeout = new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              scenarioController.abort();
              reject(timeoutError(scenario));
            }, scenario.timeoutMs);
          });
          const cancellation = new Promise<never>((_resolve, reject) => {
            parentSignal.addEventListener('abort', () => reject(cancellationError()), { once: true });
          });
          const result = await Promise.race([execution, timeout, cancellation]);
          if (result.scenarioId !== scenario.id) throw new Error(`Evidence scenario mismatch for ${scenario.id}.`);
          evidence.push(normalizeEvidence({
            ...result,
            durationMs: Math.max(result.durationMs, Date.now() - started),
          }));
        } catch (error) {
          if (parentSignal.aborted) throw cancellationError();
          evidence.push({
            scenarioId: scenario.id,
            passed: false,
            durationMs: Math.max(0, Date.now() - started),
            deterministicReplayPassed: false,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          if (timer) clearTimeout(timer);
          parentSignal.removeEventListener('abort', onParentAbort);
        }
      }
    } finally {
      this.controller = undefined;
    }

    const scores = buildScores(this.scenarios, evidence);
    const requiredEvidence = evidence.filter(item => this.scenarios.get(item.scenarioId)?.required);
    const overallPassRate = requiredEvidence.length === 0
      ? 0
      : requiredEvidence.filter(item => item.passed).length / requiredEvidence.length;
    const failures: string[] = [];
    if (overallPassRate < this.thresholds.minimumOverallPassRate) {
      failures.push(`Overall pass rate ${overallPassRate.toFixed(3)} is below ${this.thresholds.minimumOverallPassRate}.`);
    }
    for (const score of scores) {
      if (score.passRate < this.thresholds.minimumCapabilityPassRate) {
        failures.push(`${score.capability} pass rate ${score.passRate.toFixed(3)} is below ${this.thresholds.minimumCapabilityPassRate}.`);
      }
      if (this.thresholds.requireDeterministicReplay && score.deterministicReplayRate < 1) {
        failures.push(`${score.capability} has non-reproducible results.`);
      }
    }
    const safetyFailures = failuresForCapability('safety', this.scenarios, evidence);
    if (safetyFailures > this.thresholds.maximumSafetyFailures) {
      failures.push(`Safety failures ${safetyFailures} exceed ${this.thresholds.maximumSafetyFailures}.`);
    }
    const isolationFailures = failuresForCapability('context-isolation', this.scenarios, evidence);
    if (isolationFailures > this.thresholds.maximumContextIsolationFailures) {
      failures.push(`Context-isolation failures ${isolationFailures} exceed ${this.thresholds.maximumContextIsolationFailures}.`);
    }
    const passed = failures.length === 0 && requiredEvidence.every(item => item.passed);
    return {
      schemaVersion: 1,
      runId: randomUUID(),
      suiteFingerprint: suiteFingerprint([...this.scenarios.values()], this.thresholds),
      candidate: clone(candidate),
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      parityClaimAllowed: passed,
      overallPassRate,
      scores,
      evidence: evidence.map(clone),
      failures,
    };
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }

  manifest(): { scenarios: FrontierScenario[]; thresholds: FrontierThresholds; fingerprint: string } {
    const scenarios = [...this.scenarios.values()].map(clone).sort((left, right) => left.id.localeCompare(right.id));
    return {
      scenarios,
      thresholds: clone(this.thresholds),
      fingerprint: suiteFingerprint(scenarios, this.thresholds),
    };
  }
}

const REQUIRED_CAPABILITIES: FrontierCapability[] = [
  'long-horizon-coding',
  'debugging',
  'review-repair',
  'ui-verification',
  'automation',
  'recovery',
  'safety',
  'context-isolation',
  'multi-agent',
  'performance',
];

function buildScores(
  scenarios: Map<string, FrontierScenario>,
  evidence: FrontierScenarioEvidence[],
): FrontierCapabilityScore[] {
  const grouped = new Map<FrontierCapability, FrontierScenarioEvidence[]>();
  for (const item of evidence) {
    const capability = scenarios.get(item.scenarioId)?.capability;
    if (!capability) continue;
    const values = grouped.get(capability) ?? [];
    values.push(item);
    grouped.set(capability, values);
  }
  return [...grouped.entries()].map(([capability, values]) => ({
    capability,
    scenarios: values.length,
    passed: values.filter(value => value.passed).length,
    passRate: values.length === 0 ? 0 : values.filter(value => value.passed).length / values.length,
    deterministicReplayRate: values.length === 0 ? 0 : values.filter(value => value.deterministicReplayPassed).length / values.length,
    meanDurationMs: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value.durationMs, 0) / values.length,
  })).sort((left, right) => left.capability.localeCompare(right.capability));
}

function failuresForCapability(
  capability: FrontierCapability,
  scenarios: Map<string, FrontierScenario>,
  evidence: FrontierScenarioEvidence[],
): number {
  return evidence.filter(item => scenarios.get(item.scenarioId)?.capability === capability && !item.passed).length;
}

function suiteFingerprint(scenarios: FrontierScenario[], thresholds: FrontierThresholds): string {
  return createHash('sha256')
    .update(stableStringify({ scenarios: [...scenarios].sort((a, b) => a.id.localeCompare(b.id)), thresholds }))
    .digest('hex');
}

function normalizeEvidence(value: FrontierScenarioEvidence): FrontierScenarioEvidence {
  if (!Number.isFinite(value.durationMs) || value.durationMs < 0) throw new Error('Frontier evidence duration is invalid.');
  return {
    ...value,
    changedFiles: [...new Set(value.changedFiles ?? [])].sort(),
    validation: value.validation ? { ...value.validation } : undefined,
    metrics: value.metrics ? { ...value.metrics } : undefined,
    artifacts: [...new Set(value.artifacts ?? [])].sort(),
  };
}

function validateScenario(scenario: FrontierScenario): void {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(scenario.id)) throw new Error(`Invalid frontier scenario id: ${scenario.id}`);
  if (!/^[a-f0-9]{64}$/i.test(scenario.fixtureFingerprint)) throw new Error(`Invalid fixture fingerprint: ${scenario.id}`);
  if (!Number.isInteger(scenario.timeoutMs) || scenario.timeoutMs < 100) throw new Error(`Invalid frontier scenario timeout: ${scenario.id}`);
  if (scenario.acceptance.length === 0) throw new Error(`Frontier scenario requires acceptance criteria: ${scenario.id}`);
}

function validateThresholds(value: FrontierThresholds): void {
  for (const rate of [value.minimumOverallPassRate, value.minimumCapabilityPassRate]) {
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error('Frontier pass-rate thresholds must be between 0 and 1.');
  }
}

function validateCandidate(value: FrontierAcceptanceReport['candidate']): void {
  if (!value.version.trim() || !/^[a-f0-9]{7,64}$/i.test(value.commit) || !/^[a-f0-9]{64}$/i.test(value.environmentFingerprint)) {
    throw new Error('Frontier candidate metadata is invalid.');
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function timeoutError(scenario: FrontierScenario): Error {
  const error = new Error(`Frontier scenario ${scenario.id} timed out after ${scenario.timeoutMs}ms.`);
  error.name = 'AbortError';
  return error;
}

function cancellationError(): Error {
  const error = new Error('Frontier acceptance run cancelled.');
  error.name = 'AbortError';
  return error;
}
