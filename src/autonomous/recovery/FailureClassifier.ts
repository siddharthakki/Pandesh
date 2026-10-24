import type { GovernedCodingExecutionResult } from '../../coding/GovernedCodingExecutor';
import type { ValidationRunResult } from '../../coding/ValidationRunner';
import { sha } from './AttemptJournal';
import { analyzeFailureOutput } from '../../autonomy/FailureFingerprint';
import { GIT_REPOSITORY_UNAVAILABLE, isGitPrerequisiteCode } from '../../coding/GitPrerequisites';
import {
  emptyFacts,
  type FailureCause,
  type ModelIdentity,
  type RecoveryStage,
  type StageFacts,
  type StageOutcome,
  type ValidationFailureFact,
  type ValidationFailureKind,
} from './RecoveryTypes';

/**
 * Turns the executor's raw result into a structured {@link StageOutcome}.
 *
 * Classification is a pure function of the result: it never decides what to
 * do next (that is the RecoveryController's job) and it keeps every detailed
 * legacy code as `subcode` so nothing diagnostic is lost to the compact
 * taxonomy.
 */

const FORMAT_CODES = new Set([
  'version_unsupported',
  'task_summary_required',
  'operations_required',
  'operations_empty',
  'operation_malformed',
  'operation_unsupported',
  'operation_reason_required',
  'path_required',
  'validation_command_malformed',
  'operation_placeholder_content_rejected',
  'delete_intent_mismatch',
  'content_prohibited_for_delete',
  'response_not_json',
  'response_too_large',
  'invalid_action',
  'empty_content',
  'json_parse_failed',
]);

/** Codes meaning "the proposal asserts something about a file it never inspected". */
const UNGROUNDED_CODES = new Set([
  'operation_content_required',
]);

/** The model contradicted the repository or the approved validation plan. */
const SEMANTIC_CODES = new Set([
  'validation_command_test_path_missing',
  'validation_command_scope_uncovered',
  'validation_command_unsupported',
  'duplicate_operation_path',
]);

/** Boundary violations that must fail closed and are never "recovered around". */
const POLICY_CODES = new Set([
  'path_uri_scheme_rejected',
  'absolute_path_rejected',
  'path_traversal_rejected',
  'path_rejected',
  'credential_path_rejected',
  'generated_path_rejected',
  'operation_limit_exceeded',
  'proposal_size_exceeded',
  'validation_side_effect_detected',
  'git_state_changed',
  'approval_replay_rejected',
  'dirty_document_blocked',
  'execution_profile_missing',
  'execution_profile_invalid',
]);

const PROVIDER_PATTERN = /provider|model_unavailable|model_not_found|timeout|timed_out|econn|enotfound|connection|unreachable|rate.?limit|http_?\d{3}|context_(?:length|overflow|window)|dispatch|unavailable|empty_response|no_response|aborted_by_provider|cloud_|execution_rejected|context_budget|preflight/i;

export interface ClassifyContext {
  attemptId: string;
  pass: number;
  model?: ModelIdentity;
  /** Digest of the evidence manifest at observation time. */
  evidenceFingerprint?: string;
  /** Commands that passed in any earlier validation cycle of this task (regression detection). */
  priorPassedCommands?: ReadonlySet<string>;
  /** Fallback proposal paths (e.g. task-named files) when the result carried none. */
  fallbackPaths?: readonly string[];
  now?: () => Date;
}

export function classifyExecutionResult(result: GovernedCodingExecutionResult, ctx: ClassifyContext): StageOutcome {
  const facts: StageFacts = emptyFacts();
  facts.proposalPaths = uniqueStrings([
    ...(result.executableProposal?.operations ?? result.proposal?.operations ?? []).map(operation => operation.path),
    ...(result.attemptedPaths ?? []),
  ]);
  facts.filesRead = [...(result.filesRead ?? [])];
  facts.mutated = Boolean(result.mutation && (result.mutation.filesCreated.length + result.mutation.filesModified.length + result.mutation.filesDeleted.length > 0));
  facts.groundingMissing = [...(result.groundingMissing ?? [])];
  const details: string[] = [];
  const reasonCodes = extractCodes(result.failureReason);
  let stage: RecoveryStage = stageFor(result);
  let cause: FailureCause | undefined;
  let subcode: string | undefined;
  let ok = false;

  switch (result.status) {
    case 'completed':
      ok = true;
      break;
    case 'validation_failed': {
      const failures = validationFailureFacts(result.validations, ctx.priorPassedCommands);
      facts.validationFailures = failures;
      stage = 'validation';
      const kinds = new Set(failures.map(failure => failure.kind));
      if (failures.length > 0 && [...kinds].every(kind => kind === 'environment' || kind === 'tool_failure')) {
        cause = 'environment_failure';
        subcode = kinds.has('environment') ? 'validation_environment' : 'validation_tool_failure';
      } else if (kinds.has('invalid_assumption') && !kinds.has('code_defect') && !kinds.has('regression')) {
        cause = 'validation_failure';
        subcode = 'invalid_assumption';
      } else {
        cause = 'validation_failure';
        subcode = kinds.has('regression') ? 'regression' : 'code_defect';
      }
      if (result.repairStopReason && result.repairStopReason !== 'exhausted') {
        details.push(`repair_stop=${result.repairStopReason}`);
      }
      // The repair TURN itself was unusable (no valid corrective proposal came back). That is a
      // different failure from the code defect it was meant to fix: it is the model/provider failing
      // to answer, so it must be routed as such (format repair, then another model) instead of being
      // mistaken for "nothing changed".
      // A repair-cycle bookkeeping rejection (e.g. Core refusing an out-of-sequence cycle) is a validation-recovery
      // fault. It is neither a format failure nor a failed mutation, and re-dispatching cannot fix it.
      if (cause === 'validation_failure' && result.repairStopReason === 'cycle_rejected') {
        subcode = 'validation_repair_cycle_rejected';
        details.push(...(result.repairStopDetail ?? []).slice(0, 6));
      }
      if (cause === 'validation_failure' && result.repairStopReason === 'unavailable') {
        const repairDetail = (result.repairStopDetail ?? []).join(' ');
        cause = PROVIDER_PATTERN.test(repairDetail) && !/invalid|empty|not_json|format|malformed/i.test(repairDetail) ? 'provider_failure' : 'format_failure';
        subcode = 'validation_repair_unavailable';
        details.push(...(result.repairStopDetail ?? []).slice(0, 6));
      }
      break;
    }
    case 'grounding_failed':
      cause = 'grounding_failure';
      subcode = facts.groundingMissing[0]?.reason ?? 'ungrounded_proposal';
      break;
    case 'insufficient_context_reported':
      cause = 'grounding_failure';
      subcode = 'insufficient_context';
      break;
    case 'no_change_claim_reported':
      cause = 'semantic_failure';
      subcode = 'no_change_claim';
      break;
    case 'invalid_proposal': {
      const codes = reasonCodes;
      if (codes.some(code => POLICY_CODES.has(code))) {
        cause = 'policy_boundary';
        subcode = codes.find(code => POLICY_CODES.has(code));
      } else if (codes.some(code => UNGROUNDED_CODES.has(code))) {
        cause = 'grounding_failure';
        subcode = codes.find(code => UNGROUNDED_CODES.has(code));
        // The proposal wanted to write a file but never carried its content:
        // that file was not read. Name the targets so they can be supplied.
        if (facts.groundingMissing.length === 0) {
          const unread = facts.proposalPaths.length > 0 ? facts.proposalPaths : [...(ctx.fallbackPaths ?? [])];
          facts.groundingMissing = unread
            .filter(filePath => !facts.filesRead.includes(filePath))
            .map(filePath => ({ path: filePath, reason: 'never_read' as const }));
        }
      } else if (codes.some(code => SEMANTIC_CODES.has(code))) {
        cause = 'semantic_failure';
        subcode = codes.find(code => SEMANTIC_CODES.has(code));
      } else if (codes.some(code => PROVIDER_PATTERN.test(code)) && !codes.some(code => FORMAT_CODES.has(code))) {
        cause = 'provider_failure';
        subcode = codes.find(code => PROVIDER_PATTERN.test(code));
      } else {
        cause = 'format_failure';
        subcode = codes.find(code => FORMAT_CODES.has(code)) ?? codes[0] ?? 'invalid_proposal';
      }
      details.push(...codes.slice(0, 6));
      break;
    }
    case 'proposal_unavailable': {
      const codes = reasonCodes;
      const providerish = codes.some(code => PROVIDER_PATTERN.test(code)) || PROVIDER_PATTERN.test(result.failureReason ?? '');
      cause = providerish ? 'provider_failure' : 'format_failure';
      subcode = codes[0] ?? 'proposal_unavailable';
      details.push(...codes.slice(0, 6));
      break;
    }
    case 'graph_incomplete': {
      const providerish = PROVIDER_PATTERN.test(result.failureReason ?? '');
      cause = providerish ? 'provider_failure' : 'format_failure';
      subcode = 'graph_incomplete';
      break;
    }
    case 'file_missing_at_binding':
    case 'create_target_exists':
    case 'duplicate_proposal_target':
      cause = 'semantic_failure';
      subcode = result.status;
      stage = 'proposal';
      break;
    case 'workspace_changed_after_review':
      cause = 'grounding_failure';
      subcode = 'stale_snapshot';
      stage = 'approval';
      break;
    case 'git_prerequisite_unavailable':
      // A missing Git prerequisite is the user's environment, never the model or provider.
      cause = 'environment_failure';
      subcode = isGitPrerequisiteCode(result.errorCode) ? result.errorCode : GIT_REPOSITORY_UNAVAILABLE;
      break;
    case 'snapshot_read_failed':
    case 'readiness_blocked':
    case 'workspace_lease_held':
      cause = 'environment_failure';
      subcode = result.status;
      break;
    case 'mutation_failed':
    case 'mutation_evidence_missing': {
      // `mutation_failed` is the executor's catch-all for any thrown error;
      // the underlying code tells provider trouble apart from a real mutation fault.
      const code = result.errorCode ?? '';
      if (isGitPrerequisiteCode(code)) {
        // Checked before PROVIDER_PATTERN: these codes contain "unavailable" but are Git environment facts.
        cause = 'environment_failure';
        subcode = code;
      } else if (!facts.mutated && PROVIDER_PATTERN.test(code)) {
        cause = 'provider_failure';
        subcode = boundedSubcode(code);
        stage = 'investigation';
      } else if (!facts.mutated && /readiness|not_ready|blocking|dirty|lease|lock/i.test(code)) {
        cause = 'environment_failure';
        subcode = boundedSubcode(code);
      } else {
        cause = 'environment_failure';
        subcode = result.status === 'mutation_evidence_missing' ? 'mutation_evidence_missing' : 'mutation_failed';
        stage = 'mutation';
      }
      break;
    }
    case 'proposal_rejected':
    case 'execution_rejected':
      cause = 'policy_boundary';
      subcode = 'human_rejected';
      stage = 'approval';
      break;
    case 'cancelled':
      cause = 'policy_boundary';
      subcode = 'cancelled';
      break;
    default:
      cause = POLICY_CODES.has(result.status) ? 'policy_boundary' : 'environment_failure';
      subcode = result.status;
      break;
  }

  if (!ok && result.failureReason && details.length === 0) details.push(sanitizeDetail(result.failureReason));

  const fingerprints = {
    proposal: proposalFingerprint(result),
    patch: result.mutationEvidence ? patchFingerprint(result) : undefined,
    failure: ok ? undefined : failureFingerprint(cause, subcode, facts, result),
    evidence: ctx.evidenceFingerprint,
  };
  return {
    attemptId: ctx.attemptId,
    pass: ctx.pass,
    stage,
    ok,
    status: result.status,
    cause,
    subcode,
    details,
    facts,
    fingerprints,
    model: ctx.model,
    observedAt: (ctx.now ?? (() => new Date()))().toISOString(),
  };
}

function stageFor(result: GovernedCodingExecutionResult): RecoveryStage {
  if (result.validationPhase.status === 'completed' || result.status === 'validation_failed') return 'validation';
  if (result.mutation) return 'mutation';
  if (result.executableProposal || result.status === 'grounding_failed') return 'proposal';
  return 'investigation';
}

export function proposalFingerprint(result: Pick<GovernedCodingExecutionResult, 'executableProposal' | 'proposal'>): string | undefined {
  return operationsFingerprint(result.executableProposal?.operations ?? result.proposal?.operations);
}

export function operationsFingerprint(operations: ReadonlyArray<{ type: string; path: string; content?: string }> | undefined): string | undefined {
  if (!operations || operations.length === 0) return undefined;
  return sha(operations
    .map(operation => `${operation.type}:${operation.path.replace(/\\/g, '/')}:${sha(operation.content ?? '')}`)
    .sort()
    .join('\n'));
}

function patchFingerprint(result: GovernedCodingExecutionResult): string | undefined {
  const operations = result.executableProposal?.operations;
  if (!operations) return undefined;
  return sha(operations.map(operation => `${operation.type}:${operation.path}:${sha(operation.content ?? '')}`).sort().join('\n'));
}

function failureFingerprint(
  cause: FailureCause | undefined,
  subcode: string | undefined,
  facts: StageFacts,
  result: GovernedCodingExecutionResult,
): string {
  const validation = facts.validationFailures.map(failure => `${failure.command}#${failure.signature}`).sort().join(',');
  const missing = facts.groundingMissing.map(item => `${item.path}:${item.reason}`).sort().join(',');
  return sha([cause ?? '', subcode ?? '', validation, missing, facts.validationFailures.length === 0 && !missing ? sanitizeDetail(result.failureReason ?? '') : ''].join('|'));
}

// ── Validation output analysis ──────────────────────────────────────────────

const ENV_PATTERNS: RegExp[] = [
  /validation-tool-unavailable/i,
  /No module named '?pytest/i,
  /python(?:3)?(?:\.exe)?: (?:command )?not found/i,
  /command not found/i,
  /is not recognized as an internal or external command/i,
  /\bENOENT\b.*\bspawn\b|\bspawn\b.*\bENOENT\b/i,
  /\bEACCES\b|\bEPERM\b/i,
  /\bENOSPC\b|no space left/i,
  /\bECONNREFUSED\b|\bENOTFOUND\b|\bETIMEDOUT\b|\bEAI_AGAIN\b/i,
  /Cannot find module '(?![./])[^']+'/,
  /npm ERR! (?:code E|network)/i,
  /JavaScript heap out of memory/i,
];
const ASSUMPTION_PATTERNS: RegExp[] = [
  /no tests? found/i,
  /no test files found/i,
  /missing script:?/i,
  /Error: no test specified/i,
  /unknown (?:script|command|option)/i,
  /No inputs were found in config file/i,
  /error TS5\d{3}/,
];

export function validationFailureFacts(
  results: readonly ValidationRunResult[],
  priorPassed?: ReadonlySet<string>,
): ValidationFailureFact[] {
  const facts: ValidationFailureFact[] = [];
  for (const result of results) {
    if (result.exitCode === 0 && !result.timedOut) continue;
    const output = stripAnsi(result.output ?? '');
    const kind = validationKind(result, output, priorPassed);
    facts.push({
      command: boundedCommand(result.command),
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      signature: failureSignature(output),
      namedPaths: namedPaths(output),
      kind,
      semantic: analyzeFailureOutput(output, namedPaths(output)),
    });
  }
  return facts;
}

function validationKind(result: ValidationRunResult, output: string, priorPassed?: ReadonlySet<string>): ValidationFailureKind {
  if (result.timedOut || result.exitCode === null) return 'tool_failure';
  if (ENV_PATTERNS.some(pattern => pattern.test(output))) return 'environment';
  if (ASSUMPTION_PATTERNS.some(pattern => pattern.test(output))) return 'invalid_assumption';
  if (priorPassed?.has(boundedCommand(result.command))) return 'regression';
  return 'code_defect';
}

export function failureSignature(output: string): string {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map(line => normalizeVolatile(line.trim()))
    .filter(line => /error|fail|✗|×|assert|expected|received|TS\d{4}|cannot|undefined|not defined|is not/i.test(line))
    .slice(0, 12);
  return sha(lines.length > 0 ? lines.join('\n') : normalizeVolatile(stripAnsi(output)).slice(-400));
}

function normalizeVolatile(text: string): string {
  return text
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds)\b/gi, '<t>')
    .replace(/\b[0-9a-f]{7,40}\b/gi, '<h>')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/:"']+[\\/])+(?=[^\s\\/:"']+)/g, '<dir>/')
    .replace(/\s+/g, ' ');
}

export function namedPaths(output: string): string[] {
  const found = new Set<string>();
  const pattern = /(?:^|[\s"'(`])((?:[A-Za-z]:)?[\w@.\\/-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|json|md|css|html|yml|yaml))(?::\d+(?::\d+)?)?/g;
  for (const match of stripAnsi(output).matchAll(pattern)) {
    const raw = match[1].replace(/\\/g, '/');
    if (raw.includes('node_modules/')) continue;
    // Strip an absolute worktree prefix down to the repository-relative tail.
    const relative = raw.replace(/^.*?\/(?:\.ollama-agent|worktrees?)\/[^/]+\/(?:[^/]+\/)?/, '').replace(/^(?:[A-Za-z]:)?\/(?:[^/]+\/)*?(src|test|tests|lib|app|packages)\//, '$1/');
    if (relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) continue;
    found.add(relative.replace(/^\.\//, ''));
    if (found.size >= 8) break;
  }
  return [...found];
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function boundedCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function extractCodes(reason: string | undefined): string[] {
  if (!reason) return [];
  return uniqueStrings(reason.split(/[\s,;:()]+/).filter(token => /^[a-z][a-z0-9_]{3,}$/.test(token) && token.includes('_')));
}

function sanitizeDetail(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function boundedSubcode(code: string): string {
  const cleaned = code.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned.slice(0, 60) || 'unknown';
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => value.length > 0))];
}
