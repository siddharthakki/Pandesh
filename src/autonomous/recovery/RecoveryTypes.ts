/**
 * M42 recovery control plane — shared vocabulary.
 *
 * The taxonomy is deliberately small and cause-oriented. Detailed existing
 * error codes survive as `subcode`/`details`; they never become new causes.
 */

import type { FailureFingerprint, FailureSemantics, ProgressVerdict } from '../../autonomy/FailureFingerprint';

export const RECOVERY_SCHEMA_VERSION = 1 as const;

/**
 * Hard cap on validation-repair cycles for one task attempt, across EVERY recovery pass. It mirrors
 * Core's `MAX_VALIDATION_REPAIR_CYCLES` (Core numbers `validation_repair_started` events per attempt and
 * rejects a cycle that is not exactly `count + 1`), so a resumed pass continues the count instead of restarting it.
 */
export const MAX_VALIDATION_REPAIR_CYCLES = 2 as const;

export const FAILURE_CAUSES = [
  'format_failure',
  'grounding_failure',
  'semantic_failure',
  'validation_failure',
  'environment_failure',
  'provider_failure',
  'policy_boundary',
  'no_progress',
] as const;
export type FailureCause = typeof FAILURE_CAUSES[number];

/** Closed action vocabulary of the RecoveryController. */
export const RECOVERY_ACTIONS = [
  'CONTINUE',
  'FORMAT_REPAIR',
  'REINVESTIGATE',
  'REPLAN',
  'RETRY_OPERATION',
  'VALIDATION_REPAIR',
  'CHANGE_MODEL',
  'WAIT_APPROVAL',
  'BLOCK',
  'FAIL',
  'COMPLETE',
] as const;
export type RecoveryAction = typeof RECOVERY_ACTIONS[number];

/** Actions that stop the automatic loop. */
export const TERMINAL_ACTIONS: ReadonlySet<RecoveryAction> = new Set(['BLOCK', 'FAIL', 'COMPLETE', 'WAIT_APPROVAL']);

/** Kept distinct on purpose: none of these is a generic "failed". */
export const RECOVERY_TERMINAL_STATES = [
  'COMPLETE',
  'BLOCKED_RESUMABLE',
  'FAILED_TERMINAL',
  'WAITING_FOR_APPROVAL',
  'BUDGET_EXHAUSTED',
  'NO_CAPABLE_MODEL',
  'NO_PROGRESS',
] as const;
export type RecoveryTerminalState = typeof RECOVERY_TERMINAL_STATES[number];

/** What a non-terminal recovery promises will be different on the next dispatch. */
export const EXPECTED_CHANGES = [
  'new_evidence',
  'changed_model',
  'changed_approach',
  'refreshed_snapshot',
  'new_validation_evidence',
  'refreshed_environment',
  'transient_retry',
] as const;
export type ExpectedChange = typeof EXPECTED_CHANGES[number];

export type RecoveryStage =
  | 'investigation'
  | 'proposal'
  | 'approval'
  | 'mutation'
  | 'validation'
  | 'delivery';

export interface ModelIdentity {
  provider?: string;
  model?: string;
}

export function modelKey(model: ModelIdentity | undefined): string {
  return `${model?.provider ?? 'unknown'}/${model?.model ?? 'unknown'}`;
}

/** Facts a stage reports about the run, independent of success or failure. */
export interface StageFacts {
  /** Files (task-relative) named by the proposal that produced this outcome, when any. */
  proposalPaths: string[];
  /** Paths the run read successfully. */
  filesRead: string[];
  /** True when at least one mutating operation ran in this outcome. */
  mutated: boolean;
  /** Validation failure signatures, when validation ran. */
  validationFailures: ValidationFailureFact[];
  /** Missing-evidence paths reported by the grounding gate, when it rejected. */
  groundingMissing: GroundingMissing[];
}

export interface ValidationFailureFact {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  /** Stable, normalized signature of the failure output (no timings, temp paths, hex ids). */
  signature: string;
  /** Repository-relative paths the failure output names. */
  namedPaths: string[];
  kind: ValidationFailureKind;
  /** M46: normalized failing tests, error classes and message identity (absent on records written before M46). */
  semantic?: FailureSemantics;
}

export type ValidationFailureKind =
  | 'code_defect'
  | 'regression'
  | 'environment'
  | 'invalid_assumption'
  | 'tool_failure';

export interface GroundingMissing {
  path: string;
  reason: 'never_read' | 'stale_content' | 'stale_base' | 'partial_read';
}

export interface StageFingerprints {
  /** Proposal operations (type + path + content digest). */
  proposal?: string;
  /** Applied change to the worktree (post-mutation content digests). */
  patch?: string;
  /** cause + subcode + normalized failure signature. */
  failure?: string;
  /** Digest of the fresh evidence available when the outcome was observed. */
  evidence?: string;
}

/**
 * Structured result of one stage-execution pass. It carries success as well as
 * failure. Stages report; only the RecoveryController decides what happens next.
 */
export interface StageOutcome {
  attemptId: string;
  /** 1-based pass number within the task (the journal's dispatch counter). */
  pass: number;
  stage: RecoveryStage;
  ok: boolean;
  /** Raw executor status kept as a diagnostic. */
  status: string;
  cause?: FailureCause;
  /** Detailed diagnostic code that survives the compact taxonomy. */
  subcode?: string;
  details: string[];
  facts: StageFacts;
  fingerprints: StageFingerprints;
  /** M46: semantic failure identity and patch footprint; only on failed outcomes. */
  failureFingerprint?: FailureFingerprint;
  model?: ModelIdentity;
  observedAt: string;
}

/** Directives the runtime applies verbatim on the next dispatch. */
export interface RecoveryDirectives {
  /** Paths the runtime itself reads and supplies to the model as pre-read evidence. */
  seedEvidencePaths: string[];
  /** Bounded, sanitized, runtime-authored guidance lines. Never model output. */
  guidance: string[];
  /** Model to use for the next dispatch (only set by CHANGE_MODEL). */
  model?: { provider: string; model: string; local: boolean };
  /** Whether the next dispatch may use an explicitly authorised cloud route. Default deny. */
  cloudAuthorized: boolean;
  /** When true the next dispatch resumes at validation against the existing worktree. */
  resumeAtValidation: boolean;
  /** M46: set when the controller changed strategy because the same hypothesis kept failing. */
  strategy?: 'widen_evidence' | 'constrained_output' | 'prompt_only_contract';
}

export interface BudgetVerdict {
  exhausted: boolean;
  resource?: string;
  limit?: number;
  observed?: number;
  detail?: string;
}

export interface RecoveryDecision {
  schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  /** Allocated from TaskControlState.decisions before persistence. */
  decisionSeq: number;
  attemptId: string;
  pass: number;
  action: RecoveryAction;
  cause?: FailureCause;
  subcode?: string;
  terminalState?: RecoveryTerminalState;
  /** Human-readable, truthful reason. */
  reason: string;
  /** Non-terminal recoveries must name what changes; terminal ones leave this empty. */
  expectedChange: ExpectedChange[];
  directives: RecoveryDirectives;
  /** M46: how this failure related to the previous one (durable, so a restart sees the same streak). */
  progress?: { verdict: ProgressVerdict; streak: number; sameHypothesisStreak: number };
  /** Digest of (action, failure, evidence, model, guidance): equal digests mean an identical attempt. */
  dispatchFingerprint?: string;
  budget: BudgetVerdict;
  decidedAt: string;
}

export function emptyDirectives(): RecoveryDirectives {
  return { seedEvidencePaths: [], guidance: [], cloudAuthorized: false, resumeAtValidation: false };
}

export function emptyFacts(): StageFacts {
  return { proposalPaths: [], filesRead: [], mutated: false, validationFailures: [], groundingMissing: [] };
}
