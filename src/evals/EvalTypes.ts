export type EvalCategory =
  | 'tool_selection'
  | 'invalid_tool_handling'
  | 'one_file_edit'
  | 'multi_file_edit'
  | 'refactoring'
  | 'test_creation'
  | 'safety'
  | 'approval_rejection'
  | 'recovery'
  | 'validation_repair'
  | 'context_selection'
  | 'provider_parity';

export interface EvalScenario {
  id: string;
  version: number;
  category: EvalCategory;
  title: string;
  prompt: string;
  fixture: string;
  acceptance: string[];
  expectedFiles?: string[];
  forbiddenFiles?: string[];
  tags: string[];
  timeoutMs: number;
}

export interface EvalExecutionContext {
  runId: string;
  model: string;
  providerType: string;
  scenario: EvalScenario;
}

export interface EvalObservation {
  scenarioId: string;
  success: boolean;
  buildPassed?: boolean;
  testsPassed?: boolean;
  invalidToolCalls: number;
  totalToolCalls: number;
  loopDetected: boolean;
  repairAttempts: number;
  approvalsRequested: number;
  elapsedMs: number;
  modelCalls: number;
  inputTokens?: number;
  outputTokens?: number;
  changedFiles: string[];
  incorrectFilesChanged: string[];
  rollbackAttempted: boolean;
  rollbackSucceeded?: boolean;
  providerResponseEquivalent?: boolean;
  contextFiles?: string[];
  contextRelevantFiles?: string[];
  error?: string;
  evidence: Record<string, unknown>;
}

export interface EvalAggregateMetrics {
  scenarios: number;
  taskSuccessRate: number;
  buildSuccessRate: number;
  testSuccessRate: number;
  invalidToolRate: number;
  loopRate: number;
  meanRepairAttempts: number;
  meanApprovals: number;
  meanElapsedMs: number;
  meanModelCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  incorrectFilesChanged: number;
  rollbackSuccessRate: number;
  providerParityRate: number;
  contextPrecision: number;
}

export interface EvalScenarioResult {
  scenario: EvalScenario;
  observation: EvalObservation;
}

export interface EvalRunResult {
  schemaVersion: 1;
  suiteId: string;
  suiteVersion: number;
  runId: string;
  model: string;
  providerType: string;
  extensionVersion: string;
  commit?: string;
  startedAt: string;
  completedAt: string;
  metrics: EvalAggregateMetrics;
  results: EvalScenarioResult[];
}

export interface EvalAdapter {
  execute(context: EvalExecutionContext, signal?: AbortSignal): Promise<EvalObservation>;
}

export interface EvalRunOptions {
  model: string;
  providerType: string;
  extensionVersion: string;
  commit?: string;
  categories?: EvalCategory[];
  scenarioIds?: string[];
  failFast?: boolean;
  signal?: AbortSignal;
}

export interface EvalRegression {
  metric: keyof EvalAggregateMetrics;
  baseline: number;
  current: number;
  delta: number;
  severity: 'warning' | 'failure';
  direction: 'higher_is_better' | 'lower_is_better';
}

export interface EvalComparison {
  baselineRunId: string;
  currentRunId: string;
  regressions: EvalRegression[];
  improvements: EvalRegression[];
  compatible: boolean;
}
