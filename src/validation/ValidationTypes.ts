export type ValidationCategory =
  | 'compile'
  | 'typecheck'
  | 'unit_test'
  | 'integration_test'
  | 'lint'
  | 'format'
  | 'diagnostics'
  | 'security'
  | 'acceptance'
  | 'git_diff_scope';

export type ValidationGateStatus = 'passed' | 'failed' | 'skipped' | 'timed_out';

export interface ValidationGate {
  id: string;
  category: ValidationCategory;
  command: string;
  required: boolean;
  source: 'explicit' | 'package_json' | 'vscode_task' | 'ci' | 'convention' | 'builtin';
  timeoutMs: number;
}

export interface ValidationGateResult {
  gate: ValidationGate;
  status: ValidationGateStatus;
  exitCode?: number;
  durationMs: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  fingerprint: string;
}

export interface ValidationSummary {
  schemaVersion: 1;
  taskId: string;
  attempt: number;
  startedAt: string;
  completedAt: string;
  passed: boolean;
  requiredPassed: boolean;
  results: ValidationGateResult[];
  failureFingerprint?: string;
  filesChanged: string[];
  commandsRun: string[];
}

export interface TaskResultEvidence {
  schemaVersion: 1;
  taskId: string;
  completedAt: string;
  success: boolean;
  filesChanged: string[];
  commandsRun: string[];
  validation: ValidationSummary;
  acceptanceResults: Array<{ name: string; passed: boolean; detail?: string }>;
  testsAdded: string[];
  limitations: string[];
}

export interface ValidationRunOptions {
  taskId: string;
  attempt: number;
  explicitGates?: Array<{
    id?: string;
    category: ValidationCategory;
    command: string;
    required: boolean;
    timeoutMs?: number;
  }>;
  allowedPaths?: string[];
  maxOutputChars?: number;
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface CommandExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

export interface ValidationCommandExecutor {
  execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandExecutionResult>;
}
