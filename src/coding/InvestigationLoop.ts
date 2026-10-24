import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  type GovernedModelRequest,
  type GovernedModelResult,
} from '../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../agent/LocalFirstModelDispatchRouter';
import type { ForgeInvocationAuditMetadata } from '../agent/AgentEngineTypes';
import type { LoopLevelCloudEscalationReason } from '../models/LocalFirstModelRouting';
import type { ProviderType } from '../providers/ProviderTypes';
import * as crypto from 'crypto';
import {
  CODING_PROPOSAL_OPERATION_TYPES,
  CODING_PROPOSAL_REQUIRED_FIELDS,
  CODING_PROPOSAL_VALIDATION_COMMAND_KINDS,
  CODING_PROPOSAL_VERSION,
  CodingProposal,
  buildCodingProposalJsonSchema,
  buildCodingProposalResponseFormat,
  detectWorkspaceValidationPolicy,
  extractCodingProposalJson,
  isRepairableCodingProposalFailure,
  taskMentionsRemoval,
} from './CodingProposal';
import { WorkspaceInspectionTools, type WorkspaceSearchOutcome } from './WorkspaceInspection';
import { parseValidateAndExpandCodingProposal } from './AnchoredEdit';
import {
  compactInvestigationTranscript,
  formatInvestigationTranscriptCompacted,
  isContextBudgetRejection,
  INVESTIGATION_TRANSCRIPT_BUDGET_CHARS,
  INVESTIGATION_TRANSCRIPT_TIGHT_BUDGET_CHARS,
  type InvestigationRecord,
} from './InvestigationTranscript';
import {
  InvestigationEvidenceCarry,
  MAX_DELIVERIES_PER_RANGE,
  addCoveredRange,
  findCoveringRead,
  isCovered,
  readKey,
} from './InvestigationEvidence';

/**
 * A bounded, host-owned investigation turn taken before the existing
 * CodingProposal pipeline. This is the missing connection the controller
 * trace identified: the lightweight autonomous coding path could not request
 * a targeted read/search, and had no way to report insufficient context or a
 * verified no-change outcome — only ever a CodingProposal (>=1 mutating
 * operation) or an undifferentiated failure. This module adds exactly those
 * five turn actions and nothing else: it does not add tools, mutation, a new
 * runtime, or a second review/repair subsystem. `submit_proposal` still goes
 * through the EXACT existing CodingProposal parse/validate pipeline
 * (`parseAndValidateCodingProposal`, `findValidationPlanCoverageErrors`)
 * unchanged, and a resulting proposal is handed back to the caller to enter
 * the existing approval/apply pipeline exactly as it does today — this
 * module never mutates the workspace itself.
 */
export const INVESTIGATION_ACTION_KINDS = [
  'read_file',
  'search',
  'submit_proposal',
  'insufficient_context',
  'no_change_claim',
] as const;
export type InvestigationActionKind = typeof INVESTIGATION_ACTION_KINDS[number];

export type InvestigationAction =
  | { action: 'read_file'; path: string; startLine?: number; endLine?: number }
  | { action: 'search'; query: string; path?: string }
  | { action: 'submit_proposal'; proposal: Record<string, unknown> }
  | { action: 'insufficient_context'; reason: string; missing: string[] }
  | { action: 'no_change_claim'; reason: string; evidence: string };

export type InvestigationTurnPhase = 'investigate' | 'finalize' | 'recovery' | 'cloud_recovery';

/** Non-sensitive per-turn evidence: action kind, targets, counts and recovery
 * identity only — never file content or search result text. Suitable for the
 * existing `onProgress` evidence channel (durably appended as a `progress`
 * event) — no new persistence surface is introduced. */
export interface InvestigationTurnEvidence {
  turn: number;
  action: InvestigationActionKind | 'invalid_action';
  detail?: string;
  ok: boolean;
  phase: InvestigationTurnPhase;
  remainingAllowance: number;
  requestedAction: InvestigationActionKind | 'invalid_action';
  completedAction?: InvestigationActionKind | 'invalid_action';
  path?: string;
  range?: string;
  query?: string;
  scope?: string;
  resultCount?: number;
  error?: string;
  deliveredChars?: number;
  truncated?: boolean;
  totalLines?: number;
  characterCount?: number;
  eof?: boolean;
  noUnreadContent?: boolean;
  /** `sha256:` of the whole file at read time (not of the delivered range). Set for a successful read_file. */
  contentFingerprint?: string;
  completedReads: number;
  uniqueFiles: number;
  recovery?: string;
  stopReason?: string;
  /** Dispatched prompt character count (telemetry). Never prompt text. */
  promptChars?: number;
  promptCharacterCount?: number;
  /** Dispatched model duration in milliseconds (telemetry). */
  durationMs?: number;
  elapsedMs?: number;
  /** True when this turn executed as a format repair call. */
  isRepair?: boolean;
  /** Initial validation error codes when submit_proposal failed validation. */
  initialValidationCodes?: string[];
  /** True when a compact proposal repair request was attempted. */
  repairAttempted?: boolean;
  /** Dispatched proposal repair model duration in milliseconds. */
  repairDurationMs?: number;
  /** Result of validating the repaired proposal: 'valid' | 'invalid' | 'failed'. */
  repairedValidationResult?: 'valid' | 'invalid' | 'failed';
}

export interface FileReadHistoryEntry {
  path: string;
  totalLines: number;
  characterCount: number;
  minLineRead: number;
  maxLineRead: number;
  eofReached: boolean;
  fullyRead: boolean;
  /** Whole-file content fingerprint this history describes; a different one means the file changed since. */
  fingerprint?: string;
  /** Line ranges delivered so far for that fingerprint (coalesced). */
  ranges?: Array<[number, number]>;
}

/**
 * What executeRead needs to avoid re-delivering evidence the model already holds. `bodyStatus` answers from the
 * deterministic compaction of the CURRENT transcript, so "already in the prompt" is a fact, not a guess.
 */
export interface ReadReuseGuard {
  bodyStatus(path: string, range: readonly [number, number], fingerprint: string): 'present' | 'omitted' | 'none';
  deliveries: Map<string, number>;
  pin(key: string): void;
  stats: InvestigationEvidenceCarry['stats'];
  invalidatePath(path: string): void;
}

export function isSpuriousInsufficientContextDueToSize(
  action: Extract<InvestigationAction, { action: 'insufficient_context' }>,
  fileReadHistory: Map<string, FileReadHistoryEntry>,
): { isSpurious: boolean; explanation?: string } {
  if (fileReadHistory.size === 0) {
    return { isSpurious: false };
  }

  const explanations: string[] = [];

  for (const [path, entry] of fileReadHistory.entries()) {
    if (!entry.fullyRead && !entry.eofReached) {
      continue;
    }

    const basename = path.split('/').pop() ?? path;
    const mentionsFile =
      action.reason.includes(path) ||
      action.reason.includes(basename) ||
      action.missing.some(m => m.includes(path) || m.includes(basename));

    if (!mentionsFile) {
      continue;
    }

    const mentionsCharCountAsLines =
      action.reason.includes(`${entry.characterCount}`) ||
      action.missing.some(m => m.includes(`${entry.characterCount}`));

    const claimsLinesBeyondTotal =
      /(\d+)\s*lines/i.test(action.reason) &&
      Array.from(action.reason.matchAll(/(\d+)\s*lines/gi)).some(m => Number(m[1]) > entry.totalLines);

    const allMissingAreFullyRead =
      action.missing.length > 0 &&
      action.missing.every(m => {
        for (const [fPath, fEntry] of fileReadHistory.entries()) {
          const fBase = fPath.split('/').pop() ?? fPath;
          if ((m.includes(fPath) || m.includes(fBase)) && (fEntry.fullyRead || fEntry.eofReached)) {
            return true;
          }
        }
        return false;
      });

    if (mentionsCharCountAsLines || claimsLinesBeyondTotal || allMissingAreFullyRead) {
      explanations.push(
        `File ${path} contains ${entry.totalLines} lines (${entry.characterCount} characters). Lines 1-${entry.totalLines} were already read to EOF; no unread content remains. Do not interpret character count (${entry.characterCount}) as total lines.`
      );
    }
  }

  if (explanations.length > 0) {
    return {
      isSpurious: true,
      explanation: explanations.join('\n'),
    };
  }

  return { isSpurious: false };
}

export type InvestigationOutcome =
  | { kind: 'proposal'; proposal: CodingProposal }
  | { kind: 'insufficient_context'; reason: string; missing: string[] }
  /** The claim alone never completes the task — the caller must always
   * surface this as a distinct, non-completing status for separate (human or
   * governed) review, never as `completed`. */
  | { kind: 'no_change_claim'; reason: string; evidence: string }
  | { kind: 'dispatch_failed'; errors: string[] }
  /** `proposalPaths`: files the rejected proposal tried to write, so a recovery layer can supply their current content. */
  | { kind: 'invalid_proposal'; errors: string[]; proposalPaths?: string[] }
  | { kind: 'turn_limit_exceeded' };

export interface InvestigationLoopResult {
  outcome: InvestigationOutcome;
  governedResult: GovernedModelResult;
  turns: InvestigationTurnEvidence[];
  providerCallCount: number;
}

export interface InvestigationLoopParams {
  task: string;
  files: readonly string[];
  packageScripts: readonly string[];
  initialRepositoryContext: string;
  dispatcher: GovernedModelDispatchSeam;
  inspection: WorkspaceInspectionTools;
  /**
   * Injected rather than imported directly: `CodingPlanner.ts` already
   * defines `findValidationPlanCoverageErrors` and is the sole caller of
   * this loop, so passing it in avoids a two-way import between the two
   * files while still reusing the exact same repository-grounded check
   * `CodingPlanner.plan()` already applies to a submitted proposal.
   */
  validateProposalCoverage: (proposal: CodingProposal) => Promise<string[]>;
  model: string;
  providerType?: ProviderType;
  invocationId: string;
  taskId: string;
  audit?: ForgeInvocationAuditMetadata;
  configWorkspaceRoot?: string;
  signal?: AbortSignal;
  /** Deliberately its own bounded default rather than the interactive
   * `ollama-agent.maxIterations` setting: that setting governs interactive
   * Baat/Saath tool iteration and is user-tunable for a different context
   * (a person watching and steering); this loop is autonomous and unattended,
   * each turn is a full governed model round-trip, and it must stay bounded
   * regardless of the user's chat preference. */
  maxTurns?: number;
  onTurn?: (evidence: InvestigationTurnEvidence) => void;
  /**
   * Every successful read the loop performs (model-requested and runtime
   * hydration alike): file identity, the lines delivered and the whole-file
   * content fingerprint. Feeds the evidence manifest; carries no content.
   */
  onRead?: (read: { path: string; range: string; contentFingerprint: string; totalLines?: number }) => void;
  /** Runtime-authored recovery notes and pre-read evidence appended to the initial context. */
  extraContext?: string;
  /**
   * Evidence store carried across the retry/repair loops of one task. A retry starts from the evidence already
   * gathered (revalidated against the files on disk) instead of rediscovering it. Absent: a private store per loop.
   */
  carry?: InvestigationEvidenceCarry;
  /**
   * Optional host progress sink for recovery/stop events that are not a
   * model-chosen investigation action (empty-response retry, loop-level
   * cloud escalation, stop reason).
   */
  onProgress?: (phase: string) => void;
  /**
   * One authorized loop-level cloud dispatch. The explicit local primary is
   * the starting model; this runs only after exhausted investigation or
   * persistent unusable output, and only when the caller’s routing policy
   * permits it. Never used to bypass permission, safety, or delivery gates.
   */
  escalateToCloud?: (
    request: GovernedModelRequest,
    reason: LoopLevelCloudEscalationReason,
    local?: GovernedModelResult,
  ) => Promise<GovernedModelResult | undefined>;
}

export const DEFAULT_MAX_INVESTIGATION_TURNS = 6;
export const DEFAULT_RESERVED_FINALIZATION_CALLS = 1;
export const DEFAULT_CLOUD_INVESTIGATION_TURNS = 2;
const MAX_TURN_RESULT_CHARS = 6_000;

/** Best-effort list of target paths named by a (possibly invalid) submitted proposal. */
function proposedPaths(proposal: unknown): string[] {
  const operations = (proposal as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(operations)) return [];
  return operations
    .map(operation => (operation as { path?: unknown } | null)?.path)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .slice(0, 16);
}

export async function runInvestigationLoop(params: InvestigationLoopParams): Promise<InvestigationLoopResult> {
  const investigationAllowance = Math.max(0, params.maxTurns ?? DEFAULT_MAX_INVESTIGATION_TURNS);
  const reservedFinalization = DEFAULT_RESERVED_FINALIZATION_CALLS;
  const turns: InvestigationTurnEvidence[] = [];
  let providerCallCount = 0;
  const carry = params.carry ?? new InvestigationEvidenceCarry();
  const investigationRecords: InvestigationRecord[] = carry.records;
  let transcriptBudget = INVESTIGATION_TRANSCRIPT_BUDGET_CHARS;
  let omitBulkyPromptExtras = false;
  let contextCompactionRetryUsed = false;
  let lastGovernedResult: GovernedModelResult | undefined;
  let completedReads = 0;
  const uniqueFileSet = new Set<string>();
  let remainingAllowance = investigationAllowance;
  let cloudEscalationUsed = false;
  let turnIndex = 0;
  const zeroSearchKeys = new Set<string>();
  let consecutiveZeroSearches = 0;
  let consecutiveNoEvidenceReads = 0;
  // Search results are authoritative coordinates. When a model reports
  // insufficient context at finalization, hydrate a small number of those
  // coordinates automatically before giving it one last decision turn. This
  // closes the common gap where the model found the defining call/handler but
  // read a disconnected range and then stopped safely.
  const searchMatchesForHydration: Array<{ path: string; line: number }> = [];
  let contextHydrationRetryUsed = false;
  let cloudRecoveryAnnounced = false;
  const fileReadHistory = carry.history as Map<string, FileReadHistoryEntry>;
  let spuriousClarificationUsed = false;
  let proposalCompactRepairUsed = false;

  const emit = (evidence: InvestigationTurnEvidence): void => {
    turns.push(evidence);
    params.onTurn?.(evidence);
  };

  const compactNow = () => compactInvestigationTranscript(investigationRecords, transcriptBudget, { pinnedReadKeys: carry.pinned });

  const currentTranscript = (): string => compactNow().transcript;

  const readGuard: ReadReuseGuard = {
    bodyStatus: (path, range, fingerprint) => {
      const covering = findCoveringRead(investigationRecords, path, range, fingerprint);
      if (!covering) return 'none';
      return compactNow().includedBodyKeys.has(covering.key) ? 'present' : 'omitted';
    },
    deliveries: carry.deliveries,
    pin: key => { carry.pinned.add(key); },
    stats: carry.stats,
    invalidatePath: path => carry.invalidatePath(path),
  };

  // Evidence carried in from an earlier loop of this task is only reusable while the file is unchanged on disk.
  const revalidateCarriedEvidence = async (): Promise<void> => {
    for (const carriedPath of carry.readPaths()) {
      const known = investigationRecords.find(record => record.kind === 'read' && record.ok && record.path === carriedPath);
      try {
        const current = await params.inspection.readTextFile(carriedPath, params.signal);
        if (!known || known.kind !== 'read' || !known.ok || known.fingerprint !== current.fingerprint) carry.invalidatePath(carriedPath);
      } catch {
        carry.invalidatePath(carriedPath);
      }
    }
  };

  if (carry.records.length > 0) await revalidateCarriedEvidence();

  const announceCompactionIfNeeded = (): void => {
    const compacted = compactNow();
    if (compacted.compacted) {
      params.onProgress?.(formatInvestigationTranscriptCompacted(
        transcriptBudget,
        compacted.keptReads,
        compacted.omittedReadBodies,
      ));
    }
  };

  const buildTurnPrompt = (phase: InvestigationTurnPhase, remaining: number): string => {
    announceCompactionIfNeeded();
    const hasEvidence = investigationRecords.length > 0;
    return buildInvestigationPrompt(
      params,
      currentTranscript(),
      turnIndex,
      phase === 'cloud_recovery' ? DEFAULT_CLOUD_INVESTIGATION_TURNS : investigationAllowance,
      remaining,
      phase === 'cloud_recovery' ? 1 : reservedFinalization,
      phase,
      { omitBulkyPromptExtras: omitBulkyPromptExtras || hasEvidence },
    );
  };

  const dispatchErrors = (result: GovernedModelResult): string[] => [
    result.failureCode ?? 'provider_failure',
    ...(result.invalidResponseReason ? [result.invalidResponseReason] : []),
  ];

  const isUnusableDispatch = (result: GovernedModelResult): boolean =>
    result.status !== 'completed' || !result.completion;

  const isRetryableUnusable = (result: GovernedModelResult): boolean =>
    isUnusableDispatch(result)
    && result.failureCode !== 'cancelled'
    && result.failureCode !== 'execution_rejected'
    && (result.failureCode === 'invalid_model_response' || !result.failureCode || Boolean(result.invalidResponseReason));

  const buildRequest = (prompt: string, requestId: string): GovernedModelRequest => ({
    contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
    requestId,
    invocationId: params.invocationId,
    taskId: params.taskId,
    model: params.model,
    providerType: params.providerType,
    prompt,
    responseFormat: buildInvestigationActionResponseFormat({ allowDelete: taskMentionsRemoval(params.task) }),
    signal: params.signal,
    audit: params.audit,
    configWorkspaceRoot: params.configWorkspaceRoot,
    nativeThinking: false,
  });

  const dispatchWithRecovery = async (
    buildPrompt: () => string,
    requestId: string,
    viaCloud = false,
  ): Promise<
    | GovernedModelResult
    | { failed: InvestigationLoopResult }
    | { cloudUnavailable: true }
    | { unusableContinue: GovernedModelResult }
  > => {
    let prompt = buildPrompt();
    const request = buildRequest(prompt, requestId);
    providerCallCount += 1;
    let governedResult: GovernedModelResult;
    if (viaCloud) {
      if (!params.escalateToCloud) {
        return { cloudUnavailable: true };
      }
      const cloud = await params.escalateToCloud(request, 'investigation_exhausted', lastGovernedResult);
      if (!cloud) {
        return { cloudUnavailable: true };
      }
      cloudEscalationUsed = true;
      governedResult = cloud;
      lastGovernedResult = cloud;
      if (!cloudRecoveryAnnounced) {
        cloudRecoveryAnnounced = true;
        params.onProgress?.(formatInvestigationCloudRecovery('investigation_exhausted', cloud.model, params.model));
      }
    } else {
      governedResult = await params.dispatcher.dispatch(request);
      lastGovernedResult = governedResult;
    }

    if (!viaCloud && isContextBudgetRejection(governedResult) && !contextCompactionRetryUsed) {
      contextCompactionRetryUsed = true;
      transcriptBudget = INVESTIGATION_TRANSCRIPT_TIGHT_BUDGET_CHARS;
      omitBulkyPromptExtras = true;
      params.onProgress?.(formatInvestigationRecovery('context_overflow'));
      emit({
        turn: turnIndex,
        action: 'invalid_action',
        ok: false,
        phase: 'recovery',
        remainingAllowance,
        requestedAction: 'invalid_action',
        completedReads,
        uniqueFiles: uniqueFileSet.size,
        recovery: 'context_overflow',
        detail: 'context_overflow',
      });
      prompt = buildPrompt();
      providerCallCount += 1;
      governedResult = await params.dispatcher.dispatch(buildRequest(prompt, `${requestId}:compact`));
      lastGovernedResult = governedResult;
    }

    if (!isUnusableDispatch(governedResult)) return governedResult;

    if (!isRetryableUnusable(governedResult)) {
      params.onProgress?.(formatInvestigationStop('dispatch_failed', dispatchErrors(governedResult)));
      return {
        failed: {
          outcome: { kind: 'dispatch_failed', errors: dispatchErrors(governedResult) },
          governedResult,
          turns,
          providerCallCount,
        },
      };
    }

    const subreason = governedResult.invalidResponseReason ?? governedResult.failureCode ?? 'empty_content';
    params.onProgress?.(formatInvestigationRecovery(subreason));
    emit({
      turn: turnIndex,
      action: 'invalid_action',
      ok: false,
      phase: 'recovery',
      remainingAllowance,
      requestedAction: 'invalid_action',
      completedReads,
      uniqueFiles: uniqueFileSet.size,
      recovery: subreason,
      detail: subreason,
    });

    // Empty local retries often mean the prompt was too large for the model
    // to emit JSON, not a context-preflight block. Tighten once before retry.
    if (!viaCloud && !contextCompactionRetryUsed) {
      contextCompactionRetryUsed = true;
      transcriptBudget = INVESTIGATION_TRANSCRIPT_TIGHT_BUDGET_CHARS;
      omitBulkyPromptExtras = true;
      prompt = buildPrompt();
    }

    providerCallCount += 1;
    if (viaCloud && params.escalateToCloud) {
      const retry = await params.escalateToCloud(buildRequest(prompt, `${requestId}:retry`), 'investigation_exhausted', governedResult);
      if (!retry) {
        return { cloudUnavailable: true };
      }
      governedResult = retry;
    } else {
      governedResult = await params.dispatcher.dispatch(buildRequest(prompt, `${requestId}:retry`));
    }
    lastGovernedResult = governedResult;
    if (!isUnusableDispatch(governedResult)) return governedResult;

    if (viaCloud) {
      params.onProgress?.(formatInvestigationStop('dispatch_failed', dispatchErrors(governedResult)));
      return {
        failed: {
          outcome: { kind: 'dispatch_failed', errors: dispatchErrors(governedResult) },
          governedResult,
          turns,
          providerCallCount,
        },
      };
    }

    if (params.escalateToCloud && !cloudEscalationUsed) {
      const cloud = await params.escalateToCloud(
        buildRequest(prompt, `${requestId}:cloud`),
        'persistent_unusable_output',
        governedResult,
      );
      if (cloud) {
        cloudEscalationUsed = true;
        providerCallCount += 1;
        lastGovernedResult = cloud;
        params.onProgress?.(formatInvestigationCloudRecovery(
          'persistent_unusable_output',
          cloud.model,
          params.model,
        ));
        if (!isUnusableDispatch(cloud)) return cloud;
        governedResult = cloud;
      }
    }

    // Local-only: one retry already ran. Do not abort remaining investigation
    // budget, and never escalate. Finalization still fails closed below.
    if (!viaCloud && !params.escalateToCloud) {
      investigationRecords.push({ kind: 'note', text: formatUnusableContinueBlock(subreason) });
      return { unusableContinue: governedResult };
    }

    params.onProgress?.(formatInvestigationStop('dispatch_failed', dispatchErrors(governedResult)));
    return {
      failed: {
        outcome: { kind: 'dispatch_failed', errors: dispatchErrors(governedResult) },
        governedResult,
        turns,
        providerCallCount,
      },
    };
  };

  const handleTerminalProposal = async (
    action: Extract<InvestigationAction, { action: 'submit_proposal' }>,
    governedResult: GovernedModelResult,
    turnEvidence: InvestigationTurnEvidence,
    canResumeInvestigation: boolean,
  ): Promise<InvestigationLoopResult | 'continue'> => {
    const raw = JSON.stringify(action.proposal);
    const validation = await parseValidateAndExpandCodingProposal(raw, params.packageScripts, params.inspection.workspaceRoot, undefined, params.signal);
    let errors = validation.ok ? [] : validation.errors;
    let candidate = validation.proposal;
    if (validation.ok && candidate) {
      const coverageErrors = await params.validateProposalCoverage(candidate);
      if (coverageErrors.length > 0) {
        errors = coverageErrors;
        candidate = undefined;
      }
    }
    if (candidate) {
      turnEvidence.repairAttempted = false;
      params.onProgress?.(formatInvestigationStop('proposal'));
      return { outcome: { kind: 'proposal', proposal: candidate }, governedResult, turns, providerCallCount };
    }

    turnEvidence.initialValidationCodes = errors;

    if (!isRepairableCodingProposalFailure(errors)) {
      turnEvidence.repairAttempted = false;
      params.onProgress?.(formatInvestigationStop('invalid_proposal', errors));
      return { outcome: { kind: 'invalid_proposal', errors, proposalPaths: proposedPaths(action.proposal) }, governedResult, turns, providerCallCount };
    }

    // The single compact repair is spent: never run a second one. Return to
    // bounded investigation if allowance remains, otherwise fail closed.
    if (proposalCompactRepairUsed) {
      turnEvidence.repairAttempted = false;
      if (canResumeInvestigation) {
        investigationRecords.push({ kind: 'note', text: formatProposalCorrectionBlock(errors, validation.repairHints) });
        params.onProgress?.(formatInvestigationRecovery('proposal_correction'));
        return 'continue';
      }
      params.onProgress?.(formatInvestigationStop('invalid_proposal', errors));
      return { outcome: { kind: 'invalid_proposal', errors, proposalPaths: proposedPaths(action.proposal) }, governedResult, turns, providerCallCount };
    }

    // Surface proposal repair progression: needed -> code -> attempted -> result
    params.onProgress?.(formatProposalRepairProgress('needed', { code: errors[0] }));
    params.onProgress?.(`investigation_proposal_shape ${describeProposalOperations(action.proposal)}`);

    // Attempt AT MOST ONE compact proposal-repair model request with nativeThinking=false
    proposalCompactRepairUsed = true;
    turnEvidence.repairAttempted = true;
    params.onProgress?.(formatProposalRepairProgress('attempted'));
    const supportedCommands = detectWorkspaceValidationPolicy(
      params.configWorkspaceRoot,
      params.packageScripts,
      params.files,
    );
    const repairPrompt = buildCompactProposalRepairPrompt(action.proposal, errors, supportedCommands, validation.repairHints);
    const repairStarted = Date.now();

    const repairRequest: GovernedModelRequest = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: randomId('proposal_repair_request'),
      invocationId: params.invocationId,
      taskId: params.taskId,
      model: params.model,
      providerType: params.providerType,
      prompt: repairPrompt,
      nativeThinking: false, // Invariant: no native thinking on repair
      responseFormat: buildCodingProposalResponseFormat(),
      signal: params.signal,
      audit: params.audit,
      configWorkspaceRoot: params.configWorkspaceRoot,
    };

    providerCallCount += 1;
    const repairResult = await params.dispatcher.dispatch(repairRequest);
    turnEvidence.repairDurationMs = Date.now() - repairStarted;

    if (repairResult.status !== 'completed' || !repairResult.completion) {
      turnEvidence.repairedValidationResult = 'failed';
      const repairErrors = [
        repairResult.failureCode ?? 'provider_failure',
        ...(repairResult.invalidResponseReason ? [repairResult.invalidResponseReason] : []),
      ];
      params.onProgress?.(formatProposalRepairProgress('invalid', { code: repairErrors[0] }));
      params.onProgress?.(formatInvestigationStop('invalid_proposal', repairErrors));
      return { outcome: { kind: 'invalid_proposal', errors: repairErrors, proposalPaths: proposedPaths(action.proposal) }, governedResult: repairResult, turns, providerCallCount };
    }

    const repairedValidation = await parseValidateAndExpandCodingProposal(repairResult.completion, params.packageScripts, params.inspection.workspaceRoot, undefined, params.signal);
    let repairedErrors = repairedValidation.ok ? [] : repairedValidation.errors;
    let repairedProposal = repairedValidation.proposal;
    if (repairedValidation.ok && repairedProposal) {
      const repairedCoverage = await params.validateProposalCoverage(repairedProposal);
      if (repairedCoverage.length > 0) {
        repairedErrors = repairedCoverage;
        repairedProposal = undefined;
      }
    }

    if (repairedProposal) {
      turnEvidence.repairedValidationResult = 'valid';
      params.onProgress?.(formatProposalRepairProgress('succeeded'));
      params.onProgress?.(formatInvestigationStop('proposal'));
      return { outcome: { kind: 'proposal', proposal: repairedProposal }, governedResult: repairResult, turns, providerCallCount };
    }

    turnEvidence.repairedValidationResult = 'invalid';
    params.onProgress?.(formatProposalRepairProgress('invalid', { code: repairedErrors[0] }));
    if (canResumeInvestigation && isRepairableCodingProposalFailure(repairedErrors)) {
      // The repair result is the latest authoritative governed result/evidence.
      lastGovernedResult = repairResult;
      investigationRecords.push({ kind: 'note', text: formatProposalCorrectionBlock(repairedErrors, repairedValidation.repairHints) });
      params.onProgress?.(formatInvestigationRecovery('proposal_correction'));
      return 'continue';
    }
    params.onProgress?.(formatInvestigationStop('invalid_proposal', repairedErrors));
    return { outcome: { kind: 'invalid_proposal', errors: repairedErrors, proposalPaths: proposedPaths(action.proposal) }, governedResult: repairResult, turns, providerCallCount };
  };

  const observeSearch = (
    query: string,
    outcome: WorkspaceSearchOutcome,
    scopePath?: string,
  ): string => {
    if (!outcome.ok) {
      return formatSearchResultBlock(query, outcome, scopePath);
    }
    const scope = scopePath ? scopePath : 'workspace';
    const key = `${scope}\n${query}`;
    const repeated = outcome.matches.length === 0 && zeroSearchKeys.has(key);
    if (outcome.matches.length === 0) {
      consecutiveZeroSearches += 1;
      zeroSearchKeys.add(key);
    } else {
      consecutiveZeroSearches = 0;
    }
    return formatSearchResultBlock(query, outcome, scopePath, {
      repeatedIdentical: repeated,
      consecutiveZeros: consecutiveZeroSearches,
    });
  };

  const recordRead = (
    _relativePath: string,
    result:
      | {
          ok: true;
          content: string;
          path: string;
          range: string;
          fingerprint: string;
          totalLines?: number;
          characterCount?: number;
          eof?: boolean;
          requestedRange?: string;
          returnedRange?: string;
          noUnreadContent?: boolean;
        }
      | { ok: false; error: string; path: string; range?: string },
  ): void => {
    if (result.ok && 'alreadyProvided' in result && result.alreadyProvided) {
      // Never overwrite the real body record with the refusal: it is the evidence the model is being pointed back to.
      investigationRecords.push({ kind: 'note', text: `\n### read_file: ${result.path}\n${result.content}\n` });
      return;
    }
    if (result.ok) {
      if (!result.noUnreadContent) {
        params.onRead?.({ path: result.path, range: result.range, contentFingerprint: result.fingerprint, totalLines: result.totalLines });
      }
      investigationRecords.push({
        kind: 'read',
        ok: true,
        path: result.path,
        range: result.range,
        fingerprint: result.fingerprint,
        content: result.content.length > MAX_TURN_RESULT_CHARS
          ? result.content.slice(0, MAX_TURN_RESULT_CHARS)
          : result.content,
        totalLines: result.totalLines,
        characterCount: result.characterCount,
        eof: result.eof,
        requestedRange: result.requestedRange,
        returnedRange: result.returnedRange,
        noUnreadContent: result.noUnreadContent,
      });
    } else {
      investigationRecords.push({ kind: 'read', ok: false, path: result.path, error: result.error });
    }
  };

  const recordSearch = (query: string, outcome: WorkspaceSearchOutcome, scopePath?: string): void => {
    investigationRecords.push({
      kind: 'search',
      key: `${scopePath ? scopePath : 'workspace'}\n${query}`,
      query,
      scope: scopePath ? scopePath : 'workspace',
      formatted: observeSearch(query, outcome, scopePath),
    });
  };

  const emitSearch = (
    query: string,
    scopePath: string | undefined,
    outcome: WorkspaceSearchOutcome,
    phase: InvestigationTurnPhase,
    remaining: number,
    telemetry?: { promptChars?: number; durationMs?: number; isRepair?: boolean },
  ): void => {
    emit({
      turn: turnIndex,
      action: 'search',
      detail: query,
      ok: outcome.ok,
      phase,
      remainingAllowance: remaining,
      requestedAction: 'search',
      completedAction: 'search',
      query,
      scope: scopePath ? scopePath : 'workspace',
      resultCount: outcome.ok ? outcome.matches.length : undefined,
      error: outcome.ok ? undefined : outcome.error,
      completedReads,
      uniqueFiles: uniqueFileSet.size,
      promptChars: telemetry?.promptChars,
      promptCharacterCount: telemetry?.promptChars,
      durationMs: telemetry?.durationMs,
      elapsedMs: telemetry?.durationMs,
      isRepair: telemetry?.isRepair,
    });
  };

  const runOneTurn = async (
    phase: InvestigationTurnPhase,
    allowInvestigate: boolean,
    viaCloud = false,
  ): Promise<InvestigationLoopResult | 'continue' | 'cloud_unavailable'> => {
    if (params.signal?.aborted) {
      throw new Error('cancelled');
    }
    turnIndex += 1;
    const remainingAfterThisInvestigate = allowInvestigate ? Math.max(0, remainingAllowance - 1) : 0;
    let promptLength = 0;
    const dispatched = await dispatchWithRecovery(
      () => {
        const p = buildTurnPrompt(phase, remainingAllowance);
        promptLength = p.length;
        return p;
      },
      `investigation:${params.invocationId}:${turnIndex}`,
      viaCloud,
    );
    if ('cloudUnavailable' in dispatched) return 'cloud_unavailable';
    if ('failed' in dispatched) return dispatched.failed;
    if ('unusableContinue' in dispatched) {
      if (allowInvestigate) remainingAllowance = remainingAfterThisInvestigate;
      if (!allowInvestigate) {
        params.onProgress?.(formatInvestigationStop('dispatch_failed', dispatchErrors(dispatched.unusableContinue)));
        return {
          outcome: { kind: 'dispatch_failed', errors: dispatchErrors(dispatched.unusableContinue) },
          governedResult: dispatched.unusableContinue,
          turns,
          providerCallCount,
        };
      }
      return 'continue';
    }
    const governedResult = dispatched;

    let parsed = parseInvestigationAction(governedResult.completion ?? '');
    let isRepair = false;
    let turnPromptChars = governedResult.evidence?.promptCharacterCount ?? promptLength;
    let turnDurationMs = governedResult.evidence?.durationMs;

    if (!parsed.ok && governedResult.status === 'completed') {
      const repairPrompt = buildInvestigationFormatRepairPrompt(governedResult.completion ?? '', parsed.errors);
      const repairRequestId = `investigation:${params.invocationId}:${turnIndex}:repair`;
      const repairRequest = buildRequest(repairPrompt, repairRequestId);
      providerCallCount += 1;
      const repairStart = Date.now();
      let repairGovernedResult: GovernedModelResult;
      if (viaCloud && params.escalateToCloud) {
        const cloudRepair = await params.escalateToCloud(repairRequest, 'investigation_exhausted', governedResult);
        repairGovernedResult = cloudRepair ?? {
          contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
          requestId: repairRequestId,
          invocationId: params.invocationId,
          taskId: params.taskId,
          model: params.model,
          status: 'failed',
          failureCode: 'provider_failure',
          failureReason: 'Cloud repair unavailable',
          evidence: {
            contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
            requestId: repairRequestId,
            invocationId: params.invocationId,
            taskId: params.taskId,
            model: params.model,
            startedAt: new Date(repairStart).toISOString(),
            completedAt: new Date().toISOString(),
            status: 'failed',
            failureCode: 'provider_failure',
            durationMs: Date.now() - repairStart,
            promptCharacterCount: repairPrompt.length,
          },
        };
      } else {
        repairGovernedResult = await params.dispatcher.dispatch(repairRequest);
      }
      lastGovernedResult = repairGovernedResult;
      isRepair = true;
      turnPromptChars = repairGovernedResult.evidence?.promptCharacterCount ?? repairPrompt.length;
      turnDurationMs = repairGovernedResult.evidence?.durationMs ?? (Date.now() - repairStart);

      if (repairGovernedResult.status === 'completed' && repairGovernedResult.completion) {
        parsed = parseInvestigationAction(repairGovernedResult.completion);
      }
    }

    if (!parsed.ok) {
      if (allowInvestigate) remainingAllowance = remainingAfterThisInvestigate;
      emit({
        turn: turnIndex,
        action: 'invalid_action',
        ok: false,
        phase,
        remainingAllowance,
        requestedAction: 'invalid_action',
        completedReads,
        uniqueFiles: uniqueFileSet.size,
        detail: parsed.errors.join(','),
        promptChars: turnPromptChars,
        promptCharacterCount: turnPromptChars,
        durationMs: turnDurationMs,
        elapsedMs: turnDurationMs,
        isRepair,
      });
      investigationRecords.push({ kind: 'note', text: formatActionCorrectionBlock(turnIndex, parsed.errors) });
      if (!allowInvestigate) {
        params.onProgress?.(formatInvestigationStop('dispatch_failed', parsed.errors));
        return {
          outcome: { kind: 'dispatch_failed', errors: parsed.errors },
          governedResult: lastGovernedResult ?? governedResult,
          turns,
          providerCallCount,
        };
      }
      return 'continue';
    }

    const requested = parsed.value.action;
    if (!allowInvestigate && (requested === 'read_file' || requested === 'search')) {
      if (requested === 'read_file') {
        const result = await executeRead(
          params.inspection,
          parsed.value.path,
          params.signal,
          parsed.value.startLine,
          parsed.value.endLine,
          fileReadHistory,
          readGuard,
        );
        if (result.ok) {
          completedReads += 1;
          uniqueFileSet.add(result.path);
        }
        emit({
          turn: turnIndex,
          action: 'read_file',
          ok: result.ok,
          phase,
          remainingAllowance: 0,
          requestedAction: 'read_file',
          completedAction: 'read_file',
          path: result.path,
          range: result.range,
          deliveredChars: result.ok ? Math.min(result.content.length, MAX_TURN_RESULT_CHARS) : undefined,
          truncated: result.ok ? result.content.length > MAX_TURN_RESULT_CHARS : undefined,
          totalLines: result.ok ? result.totalLines : undefined,
          characterCount: result.ok ? result.characterCount : undefined,
          eof: result.ok ? result.eof : undefined,
          noUnreadContent: result.ok ? result.noUnreadContent : undefined,
          contentFingerprint: result.ok ? result.fingerprint : undefined,
          error: result.ok ? undefined : result.error,
          completedReads,
          uniqueFiles: uniqueFileSet.size,
          detail: parsed.value.path,
          promptChars: turnPromptChars,
          promptCharacterCount: turnPromptChars,
          durationMs: turnDurationMs,
          elapsedMs: turnDurationMs,
          isRepair,
        });
        recordRead(parsed.value.path, result);
      } else {
        const result = await executeSearch(params.inspection, parsed.value.query, params.signal, parsed.value.path);
        emitSearch(parsed.value.query, parsed.value.path, result, phase, 0, {
          promptChars: turnPromptChars,
          durationMs: turnDurationMs,
          isRepair,
        });
        recordSearch(parsed.value.query, result, parsed.value.path);
      }
      return 'continue';
    }

    switch (parsed.value.action) {
      case 'read_file': {
        remainingAllowance = remainingAfterThisInvestigate;
        const result = await executeRead(
          params.inspection,
          parsed.value.path,
          params.signal,
          parsed.value.startLine,
          parsed.value.endLine,
          fileReadHistory,
          readGuard,
        );
        if (result.ok) {
          completedReads += 1;
          uniqueFileSet.add(result.path);
        }
        emit({
          turn: turnIndex,
          action: 'read_file',
          detail: parsed.value.path,
          ok: result.ok,
          phase,
          remainingAllowance,
          requestedAction: 'read_file',
          completedAction: 'read_file',
          path: result.path,
          range: result.range,
          deliveredChars: result.ok ? Math.min(result.content.length, MAX_TURN_RESULT_CHARS) : undefined,
          truncated: result.ok ? result.content.length > MAX_TURN_RESULT_CHARS : undefined,
          totalLines: result.ok ? result.totalLines : undefined,
          characterCount: result.ok ? result.characterCount : undefined,
          eof: result.ok ? result.eof : undefined,
          noUnreadContent: result.ok ? result.noUnreadContent : undefined,
          contentFingerprint: result.ok ? result.fingerprint : undefined,
          error: result.ok ? undefined : result.error,
          completedReads,
          uniqueFiles: uniqueFileSet.size,
          promptChars: turnPromptChars,
          promptCharacterCount: turnPromptChars,
          durationMs: turnDurationMs,
          elapsedMs: turnDurationMs,
          isRepair,
        });
        recordRead(parsed.value.path, result);
        // Pathological repeats (an EOF-line range again and again, an already-provided range) add no evidence and spend a
        // turn each. After two in a row, say so plainly once and push the model toward a decision.
        if (result.ok && result.noUnreadContent) {
          consecutiveNoEvidenceReads += 1;
          if (consecutiveNoEvidenceReads === 2) {
            investigationRecords.push({ kind: 'note', text: '\n### stop re-reading\nTwo consecutive reads returned nothing new. Do not request those ranges again. Decide with the evidence above: submit_proposal, no_change_claim, or insufficient_context (or read a DIFFERENT range).\n' });
          }
        } else if (result.ok) {
          consecutiveNoEvidenceReads = 0;
        }
        return 'continue';
      }
      case 'search': {
        remainingAllowance = remainingAfterThisInvestigate;
        const result = await executeSearch(params.inspection, parsed.value.query, params.signal, parsed.value.path);
        emitSearch(parsed.value.query, parsed.value.path, result, phase, remainingAllowance, {
          promptChars: turnPromptChars,
          durationMs: turnDurationMs,
          isRepair,
        });
        if (result.ok) {
          for (const match of result.matches.slice(0, 12)) {
            searchMatchesForHydration.push({ path: match.path, line: match.line });
          }
        }
        recordSearch(parsed.value.query, result, parsed.value.path);
        return 'continue';
      }
      case 'submit_proposal': {
        const turnEvidence: InvestigationTurnEvidence = {
          turn: turnIndex,
          action: 'submit_proposal',
          ok: true,
          phase,
          remainingAllowance: remainingAfterThisInvestigate,
          requestedAction: 'submit_proposal',
          completedAction: 'submit_proposal',
          completedReads,
          uniqueFiles: uniqueFileSet.size,
          promptChars: turnPromptChars,
          promptCharacterCount: turnPromptChars,
          durationMs: turnDurationMs,
          elapsedMs: turnDurationMs,
          isRepair,
        };
        emit(turnEvidence);
        if (allowInvestigate) remainingAllowance = remainingAfterThisInvestigate;
        return await handleTerminalProposal(
          parsed.value,
          governedResult,
          turnEvidence,
          allowInvestigate && remainingAfterThisInvestigate > 0,
        );
      }
      case 'insufficient_context': {
        const spuriousCheck = isSpuriousInsufficientContextDueToSize(parsed.value, fileReadHistory);
        if (spuriousCheck.isSpurious) {
          remainingAllowance = remainingAfterThisInvestigate;
          emit({
            turn: turnIndex,
            action: 'invalid_action',
            ok: false,
            phase,
            remainingAllowance,
            requestedAction: 'insufficient_context',
            completedReads,
            uniqueFiles: uniqueFileSet.size,
            recovery: 'clarify_full_read',
            detail: spuriousCheck.explanation,
            promptChars: turnPromptChars,
            promptCharacterCount: turnPromptChars,
            durationMs: turnDurationMs,
            elapsedMs: turnDurationMs,
            isRepair,
          });
          investigationRecords.push({
            kind: 'note',
            text: `\n### clarification: files already fully read\n${spuriousCheck.explanation}\nYou have already read the complete files. Please continue reasoning and submit_proposal or identify actual unread workspace files.\n`,
          });
          params.onProgress?.(formatInvestigationRecovery('clarify_full_read'));
          return 'continue';
        }

        emit({
          turn: turnIndex,
          action: 'insufficient_context',
          ok: true,
          phase,
          remainingAllowance: remainingAfterThisInvestigate,
          requestedAction: 'insufficient_context',
          completedAction: 'insufficient_context',
          completedReads,
          uniqueFiles: uniqueFileSet.size,
          detail: parsed.value.reason,
          promptChars: turnPromptChars,
          promptCharacterCount: turnPromptChars,
          durationMs: turnDurationMs,
          elapsedMs: turnDurationMs,
          isRepair,
        });
        params.onProgress?.(formatInvestigationStop('insufficient_context'));
        return {
          outcome: { kind: 'insufficient_context', reason: parsed.value.reason, missing: parsed.value.missing },
          governedResult,
          turns,
          providerCallCount,
        };
      }
      case 'no_change_claim': {
        emit({
          turn: turnIndex,
          action: 'no_change_claim',
          ok: true,
          phase,
          remainingAllowance: remainingAfterThisInvestigate,
          requestedAction: 'no_change_claim',
          completedAction: 'no_change_claim',
          completedReads,
          uniqueFiles: uniqueFileSet.size,
          detail: parsed.value.reason,
          promptChars: turnPromptChars,
          promptCharacterCount: turnPromptChars,
          durationMs: turnDurationMs,
          elapsedMs: turnDurationMs,
          isRepair,
        });
        params.onProgress?.(formatInvestigationStop('no_change_claim'));
        return {
          outcome: { kind: 'no_change_claim', reason: parsed.value.reason, evidence: parsed.value.evidence },
          governedResult,
          turns,
          providerCallCount,
        };
      }
    }
  };

  const tryCloudRecovery = async (): Promise<InvestigationLoopResult | undefined> => {
    if (!params.escalateToCloud || cloudEscalationUsed) return undefined;
    if (completedReads < 1) {
      params.onProgress?.(formatInvestigationCloudSkipped('insufficient_evidence', completedReads, uniqueFileSet.size));
      return undefined;
    }
    remainingAllowance = DEFAULT_CLOUD_INVESTIGATION_TURNS;
    while (remainingAllowance > 0) {
      const result = await runOneTurn('cloud_recovery', true, true);
      if (result === 'cloud_unavailable') return undefined;
      if (result !== 'continue') return result;
    }
    const finalize = await runOneTurn('cloud_recovery', false, true);
    if (finalize === 'cloud_unavailable') return undefined;
    if (finalize !== 'continue') return finalize;
    return undefined;
  };

  while (remainingAllowance > 0) {
    const result = await runOneTurn('investigate', true);
    if (result === 'continue' || result === 'cloud_unavailable') continue;
    return result;
  }

  let finalize = await runOneTurn('finalize', false);
  const hadFinalizeRepair = turns.some(t => t.phase === 'finalize' && t.isRepair);
  if (
    !hadFinalizeRepair
    && isInvestigationLoopResult(finalize)
    && finalize.outcome.kind === 'dispatch_failed'
    && !params.escalateToCloud
  ) {
    params.onProgress?.(formatInvestigationRecovery('local_finalize_retry'));
    const extra = await runOneTurn('finalize', false);
    if (isInvestigationLoopResult(extra)) {
      finalize = extra;
    }
  }
  const localInsufficient = isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context';
  if (finalize !== 'continue' && finalize !== 'cloud_unavailable' && !localInsufficient) return finalize;
  if (localInsufficient && isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context') {
    const spuriousCheck = isSpuriousInsufficientContextDueToSize(
      { action: 'insufficient_context', reason: finalize.outcome.reason, missing: finalize.outcome.missing },
      fileReadHistory,
    );
    if (spuriousCheck.isSpurious && !spuriousClarificationUsed) {
      spuriousClarificationUsed = true;
      investigationRecords.push({
        kind: 'note',
        text: `\n### clarification: files already fully read\n${spuriousCheck.explanation}\nYou have already read the complete file(s). You must now submit_proposal or no_change_claim. Do not emit insufficient_context based on character counts.\n`,
      });
      params.onProgress?.(formatInvestigationRecovery('clarify_full_read'));
      finalize = await runOneTurn('finalize', false);
      if (finalize !== 'continue' && finalize !== 'cloud_unavailable'
        && !(isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context')) {
        return finalize;
      }
    }
  }
  const stillInsufficientPreHydration = isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context';
  if (stillInsufficientPreHydration && isInvestigationLoopResult(finalize)) {
    if (!contextHydrationRetryUsed && searchMatchesForHydration.length > 0) {
      contextHydrationRetryUsed = true;
      const alreadyRead = new Set(
        investigationRecords
          .filter((record): record is Extract<InvestigationRecord, { kind: 'read'; ok: true }> => record.kind === 'read' && record.ok)
          .map(record => `${record.path}:${record.range}`),
      );
      const hydrated = new Set<string>();
      for (const match of searchMatchesForHydration) {
        if (hydrated.size >= 3) break;
        const startLine = Math.max(1, match.line - 35);
        const endLine = match.line + 45;
        const key = `${match.path}:${startLine}-${endLine}`;
        if (alreadyRead.has(key) || hydrated.has(key)) continue;
        const result = await executeRead(params.inspection, match.path, params.signal, startLine, endLine, fileReadHistory, readGuard);
        if (!result.ok) continue;
        hydrated.add(key);
        completedReads += 1;
        uniqueFileSet.add(result.path);
        recordRead(match.path, result);
      }
      if (hydrated.size > 0) {
        params.onProgress?.(`investigation_context_hydrated reads=${hydrated.size} unique_files=${uniqueFileSet.size}`);
        finalize = await runOneTurn('finalize', false);
        if (finalize !== 'continue' && finalize !== 'cloud_unavailable'
          && !(isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context')) {
          return finalize;
        }
      }
    }
  }
  const stillInsufficient = isInvestigationLoopResult(finalize) && finalize.outcome.kind === 'insufficient_context';
  if (stillInsufficient && isInvestigationLoopResult(finalize)) {
    const reason = finalize.outcome.kind === 'insufficient_context' ? finalize.outcome.reason : '';
    const missing = finalize.outcome.kind === 'insufficient_context' ? finalize.outcome.missing : [];
    investigationRecords.push({
      kind: 'note',
      text: `\n### local finalization: insufficient_context\n${reason}\nmissing: ${missing.join(', ')}\n`,
    });
  }

  const cloudOutcome = await tryCloudRecovery();
  if (cloudOutcome) return cloudOutcome;
  if (typeof finalize === 'object') return finalize;

  params.onProgress?.(formatInvestigationStop('turn_limit_exceeded'));
  return { outcome: { kind: 'turn_limit_exceeded' }, governedResult: lastGovernedResult!, turns, providerCallCount };
}

function isInvestigationLoopResult(
  value: InvestigationLoopResult | 'continue' | 'cloud_unavailable',
): value is InvestigationLoopResult {
  return typeof value === 'object';
}

export function parseInvestigationAction(
  raw: string,
): { ok: true; value: InvestigationAction } | { ok: false; errors: string[] } {
  const extracted = extractCodingProposalJson(raw);
  if (!extracted.ok) {
    return { ok: false, errors: [extracted.error] };
  }
  const value = extracted.value;
  if (!isRecord(value)) {
    return { ok: false, errors: ['action_envelope_not_object'] };
  }
  const action = value.action;
  if (typeof action !== 'string' || !(INVESTIGATION_ACTION_KINDS as readonly string[]).includes(action)) {
    return { ok: false, errors: ['action_unrecognized'] };
  }
  switch (action as InvestigationActionKind) {
    case 'read_file': {
      if (typeof value.path !== 'string' || !value.path.trim()) {
        return { ok: false, errors: ['read_file_path_required'] };
      }
      const startLine = optionalPositiveInt(value.startLine);
      const endLine = optionalPositiveInt(value.endLine);
      if (value.startLine !== undefined && startLine === undefined) {
        return { ok: false, errors: ['read_file_start_line_invalid'] };
      }
      if (value.endLine !== undefined && endLine === undefined) {
        return { ok: false, errors: ['read_file_end_line_invalid'] };
      }
      return {
        ok: true,
        value: {
          action: 'read_file',
          path: value.path,
          ...(startLine !== undefined ? { startLine } : {}),
          ...(endLine !== undefined ? { endLine } : {}),
        },
      };
    }
    case 'search': {
      if (typeof value.query !== 'string' || !value.query.trim()) {
        return { ok: false, errors: ['search_query_required'] };
      }
      const scopePath = typeof value.path === 'string' && value.path.trim() ? value.path.trim() : undefined;
      return { ok: true, value: { action: 'search', query: value.query, ...(scopePath ? { path: scopePath } : {}) } };
    }
    case 'submit_proposal': {
      if (!isRecord(value.proposal)) {
        return { ok: false, errors: ['submit_proposal_proposal_required'] };
      }
      return { ok: true, value: { action: 'submit_proposal', proposal: value.proposal } };
    }
    case 'insufficient_context': {
      if (typeof value.reason !== 'string' || !value.reason.trim()) {
        return { ok: false, errors: ['insufficient_context_reason_required'] };
      }
      const missing = Array.isArray(value.missing)
        ? value.missing.filter((entry): entry is string => typeof entry === 'string')
        : [];
      return { ok: true, value: { action: 'insufficient_context', reason: value.reason, missing } };
    }
    case 'no_change_claim': {
      if (typeof value.reason !== 'string' || !value.reason.trim()) {
        return { ok: false, errors: ['no_change_claim_reason_required'] };
      }
      if (typeof value.evidence !== 'string' || !value.evidence.trim()) {
        return { ok: false, errors: ['no_change_claim_evidence_required'] };
      }
      return { ok: true, value: { action: 'no_change_claim', reason: value.reason, evidence: value.evidence } };
    }
  }
}

export { taskMentionsRemoval };

export function buildInvestigationActionJsonSchema(options: { allowDelete?: boolean } = {}): Record<string, unknown> {
  const proposalSchema = buildCodingProposalJsonSchema({ allowDelete: options.allowDelete });
  return {
    oneOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'path'],
        properties: {
          action: { const: 'read_file' },
          path: { type: 'string', minLength: 1 },
          startLine: { type: 'integer', minimum: 1 },
          endLine: { type: 'integer', minimum: 1 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'query'],
        properties: {
          action: { const: 'search' },
          query: { type: 'string', minLength: 1 },
          path: { type: 'string', minLength: 1 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'proposal'],
        properties: { action: { const: 'submit_proposal' }, proposal: proposalSchema },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'reason', 'missing'],
        properties: {
          action: { const: 'insufficient_context' },
          reason: { type: 'string', minLength: 1 },
          missing: { type: 'array', items: { type: 'string' } },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'reason', 'evidence'],
        properties: {
          action: { const: 'no_change_claim' },
          reason: { type: 'string', minLength: 1 },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    ],
  };
}

export function buildInvestigationActionResponseFormat(options: { allowDelete?: boolean } = {}): { type: 'json_schema'; name: string; schema: Record<string, unknown> } {
  return { type: 'json_schema', name: 'karkedikha_investigation_action', schema: buildInvestigationActionJsonSchema(options) };
}

async function executeRead(
  inspection: WorkspaceInspectionTools,
  relativePath: string,
  signal?: AbortSignal,
  startLine?: number,
  endLine?: number,
  fileReadHistory?: Map<string, FileReadHistoryEntry>,
  guard?: ReadReuseGuard,
): Promise<
  | {
      ok: true;
      content: string;
      path: string;
      range: string;
      fingerprint: string;
      totalLines: number;
      characterCount: number;
      eof: boolean;
      requestedRange: string;
      returnedRange: string;
      noUnreadContent?: boolean;
      /** The range was withheld because the model already holds identical evidence (see ReadReuseGuard). */
      alreadyProvided?: boolean;
    }
  | { ok: false; error: string; path: string; range?: string }
> {
  try {
    const file = await inspection.readTextFile(relativePath, signal);
    const lines = file.content.split(/\r?\n/);
    const totalLines = lines.length;
    const characterCount = file.content.length;
    const reqStart = Math.max(1, startLine ?? 1);
    const reqEnd = endLine ?? totalLines;
    const requestedRange = `lines ${startLine ?? 1}-${endLine ?? totalLines}`;

    let prev = fileReadHistory?.get(file.path);
    if (prev?.fingerprint && prev.fingerprint !== file.fingerprint) {
      // The file changed since it was read: every earlier range and delivery count describes different bytes.
      guard?.invalidatePath(file.path);
      fileReadHistory?.delete(file.path);
      prev = undefined;
    }

    const isPastEof = reqStart > totalLines;
    const isRepeatAtOrBeyondEof = Boolean(
      prev?.eofReached && reqStart >= prev.maxLineRead && (reqEnd <= totalLines || reqStart >= totalLines),
    );

    if (isPastEof || isRepeatAtOrBeyondEof) {
      return {
        ok: true,
        content: `EOF already reached. File contains ${totalLines} lines; no unread content remains.`,
        path: file.path,
        range: `${Math.min(reqStart, totalLines)}-${Math.min(reqEnd, totalLines)}`,
        fingerprint: file.fingerprint,
        totalLines,
        characterCount,
        eof: true,
        requestedRange,
        returnedRange: 'none',
        noUnreadContent: true,
      };
    }

    const start = reqStart;
    const end = Math.min(totalLines, reqEnd);
    const boundedStart = Math.min(start, Math.max(1, totalLines));
    const boundedEnd = Math.max(boundedStart, end);
    const deliveryKey = readKey(file.path, `${boundedStart}-${boundedEnd}`);

    if (guard && prev?.fingerprint === file.fingerprint && isCovered(prev.ranges, [boundedStart, boundedEnd])) {
      const status = guard.bodyStatus(file.path, [boundedStart, boundedEnd], file.fingerprint);
      const deliveredBefore = guard.deliveries.get(deliveryKey) ?? 0;
      const refuse = (reason: string): ReturnType<typeof executeRead> extends Promise<infer T> ? T : never => ({
        ok: true,
        content: reason,
        path: file.path,
        range: `${boundedStart}-${boundedEnd}`,
        fingerprint: file.fingerprint,
        totalLines,
        characterCount,
        eof: prev!.eofReached,
        requestedRange,
        returnedRange: 'none',
        noUnreadContent: true,
        alreadyProvided: true,
      });
      if (status === 'present') {
        guard.stats.suppressedRepeats += 1;
        return refuse(`ALREADY PROVIDED: lines ${boundedStart}-${boundedEnd} of ${file.path} are in the investigation evidence above and the file has not changed. Use that evidence: submit_proposal, no_change_claim, insufficient_context, or read a DIFFERENT range.`);
      }
      if (status === 'omitted') {
        if (deliveredBefore >= MAX_DELIVERIES_PER_RANGE) {
          guard.stats.refusedRereads += 1;
          return refuse(`NOT RE-READ: lines ${boundedStart}-${boundedEnd} of ${file.path} were already delivered ${deliveredBefore} times and no longer fit the local context budget. Read a NARROWER range (a few dozen lines around what you need), or decide with the evidence you have.`);
        }
        guard.stats.grantedRereads += 1;
        guard.pin(deliveryKey);
      }
    }
    const sliced = lines.slice(boundedStart - 1, boundedEnd).join('\n');
    const eof = reqEnd >= totalLines || boundedEnd >= totalLines;

    if (fileReadHistory) {
      const newMin = prev ? Math.min(prev.minLineRead, boundedStart) : boundedStart;
      const newMax = prev ? Math.max(prev.maxLineRead, boundedEnd) : boundedEnd;
      const eofReached = Boolean(prev?.eofReached || eof);
      const fullyRead = (newMin <= 1 && newMax >= totalLines) || (eofReached && newMin <= 1);
      fileReadHistory.set(file.path, {
        path: file.path,
        totalLines,
        characterCount,
        minLineRead: newMin,
        maxLineRead: newMax,
        eofReached,
        fullyRead,
        fingerprint: file.fingerprint,
        ranges: addCoveredRange(prev?.fingerprint === file.fingerprint ? prev.ranges : undefined, [boundedStart, boundedEnd]),
      });
    }
    if (guard) guard.deliveries.set(deliveryKey, (guard.deliveries.get(deliveryKey) ?? 0) + 1);

    return {
      ok: true,
      content: sliced,
      path: file.path,
      range: `${boundedStart}-${boundedEnd}`,
      fingerprint: file.fingerprint,
      totalLines,
      characterCount,
      eof,
      requestedRange,
      returnedRange: `lines ${boundedStart}-${boundedEnd}`,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), path: relativePath };
  }
}

async function executeSearch(
  inspection: WorkspaceInspectionTools,
  query: string,
  signal?: AbortSignal,
  scopePath?: string,
): Promise<WorkspaceSearchOutcome> {
  try {
    return await inspection.searchText(query, signal, scopePath ? { scopePath } : undefined);
  } catch (error) {
    if (error instanceof Error && error.message === 'cancelled') {
      throw error;
    }
    return { ok: false, error: error instanceof Error ? error.message : 'search_unavailable' };
  }
}

function buildInvestigationPrompt(
  params: InvestigationLoopParams,
  transcriptTail: string,
  turnIndex: number,
  investigationAllowance: number,
  remainingAllowance: number,
  reservedFinalization: number,
  phase: InvestigationTurnPhase,
  extras?: { omitBulkyPromptExtras?: boolean },
): string {
  const budgetLine = phase === 'investigate'
    ? `Investigation turn ${turnIndex}. Remaining investigation allowance (including this turn): ${remainingAllowance} of ${investigationAllowance}. Reserved finalization calls after investigation: ${reservedFinalization}.`
    : phase === 'cloud_recovery' && remainingAllowance > 0
      ? `Cloud recovery investigation. Remaining cloud investigation allowance (including this turn): ${remainingAllowance} of ${investigationAllowance}. Reserved cloud finalization calls after that: ${reservedFinalization}. The investigation evidence below is authoritative. You may read_file or search. Never invent an edit you cannot ground.`
      : phase === 'cloud_recovery'
        ? `Cloud recovery finalization. Remaining cloud investigation allowance: 0. You must now submit_proposal, insufficient_context, or no_change_claim. Do not read or search. Never invent an edit you cannot ground in the investigation so far.`
      : `Reserved finalization turn. Remaining investigation allowance: 0. You must now submit_proposal, insufficient_context, or no_change_claim. Do not read or search. Never invent an edit you cannot ground in the investigation so far. Prefer a small, complete-file replace only when you have read the complete current file; preserve every existing export, import, and unrelated function. A ranged read is not enough to reconstruct a large file. If the complete file is not available, use insufficient_context rather than replacing the file with a fragment.`;
  const investigateHint = phase === 'investigate' || (phase === 'cloud_recovery' && remainingAllowance > 0)
    ? 'If the task is already answerable from what you have already been shown, use submit_proposal immediately — do not read or search without a reason, and do not request the same file twice. A search that returned no matches is a complete miss for that exact substring, not a truncated preview; do not repeat it. A search marked FAILED did not complete; it is not evidence that the substring is absent.'
    : 'Do not request another read or search. For replace operations, content must be the complete current file with unrelated exports and functions preserved; never submit a fragment as a whole-file replacement. If the complete file is missing, use insufficient_context. If you have verified no change is required, use no_change_claim. If you can propose a grounded change, use submit_proposal.';
  return [
    budgetLine,
    'You must output one JSON object only, matching exactly one action below.',
    'Do not output Markdown fences. Do not output any explanation before or after the JSON.',
    'Available actions (exact field names):',
    '  {"action":"read_file","path":"<repository-relative path>","startLine":1,"endLine":80} — read one existing file. startLine/endLine are optional 1-based inclusive ranges.',
    '  {"action":"search","query":"<literal substring>","path":"<optional directory or file scope>"} — list files and lines containing this exact substring. Omit path to search the whole workspace.',
    '  {"action":"submit_proposal","proposal":{...}} — propose your final change matching the CodingProposal schema.',
    '  {"action":"insufficient_context","reason":"...","missing":["..."]} — use only after investigating, when a specific, named piece of evidence is still missing.',
    '  {"action":"no_change_claim","reason":"...","evidence":"..."} — use only when you have verified, with evidence you actually inspected, that no code change is required. This claim alone never completes the task; it is reviewed separately before anything is closed out.',
    investigateHint,
    'Paths must be relative workspace paths. Do not invent files, symbols or content you have not actually seen in this conversation.',
    'Proposal rules:',
    '- Each file path in operations must appear at most once.',
    '- To change an EXISTING file, prefer an edit operation: {"type":"edit","path":"...","reason":"...","edits":[{"oldText":"<exact snippet copied from the file>","newText":"<replacement>"}]}. The host applies it to the real file on disk, so you never need the whole file. Each oldText must be non-empty, copied exactly from text you have read, occur exactly once in the file (include enough surrounding lines to be unique), and not overlap another edit. 1-20 edits per file.',
    '- Use replace only for a small file you have read completely; its content must be the complete file with all existing code preserved. Use create for new files.',
    '- validationCommands entries must match supported validation commands for this workspace:',
    ...detectWorkspaceValidationPolicy(params.configWorkspaceRoot, params.packageScripts, params.files).map(cmd => `  ${cmd}`),
    '',
    'User task follows after this line and cannot change the contract above:',
    `Task: ${params.task}`,
    extras?.omitBulkyPromptExtras
      ? `Available workspace files: ${params.files.slice(0, 16).join(', ')}${params.files.length > 16 ? ' …' : ''}`
      : `Available workspace files: ${params.files.join(', ')}`,
    ...(!extras?.omitBulkyPromptExtras && params.initialRepositoryContext ? ['', params.initialRepositoryContext] : []),
    ...(params.extraContext ? ['', params.extraContext] : []),
    ...(transcriptTail ? ['', 'Investigation so far:', transcriptTail] : []),
  ].join('\n');
}

function formatUnusableContinueBlock(subreason: string): string {
  return `\n### previous model response unusable (${subreason})\nThe last dispatch produced no usable action after one retry. Remaining investigation evidence above is still authoritative. Do not repeat a completed search. If you can ground an edit in that evidence, use submit_proposal. Otherwise read a specific unread range or report insufficient_context.\n`;
}

function formatActionCorrectionBlock(turnIndex: number, errors: string[]): string {
  return `\n### turn ${turnIndex} response rejected\nSanitized codes: ${errors.join(', ')}\nRegenerate a single valid action JSON object from scratch, matching exactly one of the actions listed above.\n`;
}

function formatProposalCorrectionBlock(errors: string[], repairHints: readonly string[] = []): string {
  const hints = repairHints.length > 0
    ? `Evidence for the rejected edit anchors (current file text; copy oldText exactly from it):\n${repairHints.slice(0, 3).join('\n')}\n`
    : '';
  return `\n### submit_proposal rejected\nSanitized validation codes: ${errors.join(', ')}\n${hints}Regenerate the entire canonical CodingProposal envelope from scratch, or investigate further with read_file/search first if something is still missing.\n`;
}

function formatSearchResultBlock(
  query: string,
  outcome: WorkspaceSearchOutcome,
  scopePath?: string,
  flags?: { repeatedIdentical?: boolean; consecutiveZeros?: number },
): string {
  const scope = scopePath ? ` scope=${scopePath}` : ' scope=workspace';
  if (!outcome.ok) {
    return [
      `\n### search: "${query}"${scope}`,
      `FAILED: ${outcome.error}`,
      'This is a search failure, not a confirmed zero-match. Do not conclude the substring is absent. Read a specific path from the task or already shown, or retry after narrowing the scope.',
      '',
    ].join('\n');
  }
  const matches = outcome.matches;
  if (matches.length === 0) {
    const lines = [
      `\n### search: "${query}"${scope}`,
      'No matches in the git-tracked tree for this exact substring. This is a complete miss, not a truncated file-list preview.',
    ];
    if (flags?.repeatedIdentical) {
      lines.push('This exact query and scope already returned no matches. Repeating it will not produce new evidence. Change the literal substring, change the scope, or read_file a path named in the task or already shown.');
    } else if ((flags?.consecutiveZeros ?? 0) >= 2) {
      lines.push('Consecutive searches found nothing. Do not keep searching near-identical names. Read a specific file path from the task or initial context, or search a different literal you have actually seen.');
    } else {
      lines.push('Do not repeat this exact query and scope. Read a path named in the task or already shown, or search a different literal you have actually seen.');
    }
    return `${lines.join('\n')}\n`;
  }
  const shown = matches.slice(0, 40);
  const lines = shown.map(match => `${match.path}:${match.line}: ${match.text}`).join('\n');
  const note = matches.length > shown.length ? `Showing first ${shown.length} of ${matches.length} matches.\n` : '';
  return `\n### search: "${query}"${scope} results=${matches.length}\n${note}${lines}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) {
    const parsed = Number(value);
    if (parsed >= 1) return parsed;
  }
  return undefined;
}

export const parseInvestigationDecision = parseInvestigationAction;

export function buildInvestigationFormatRepairPrompt(invalidRaw: string, errors: readonly string[] = []): string {
  const truncatedRaw = invalidRaw.length > 1500 ? `${invalidRaw.slice(0, 1500)}...` : invalidRaw;
  return [
    'The previous action response was invalid and could not be parsed as a valid investigation action.',
    ...(errors.length > 0 ? [`Validation errors: ${errors.join(', ')}`] : []),
    '',
    'Invalid response:',
    truncatedRaw,
    '',
    'Output exactly one valid JSON object matching one of these actions:',
    '  {"action":"read_file","path":"<repository-relative path>","startLine":1,"endLine":80}',
    '  {"action":"search","query":"<literal substring>","path":"<optional directory or file scope>"}',
    '  {"action":"submit_proposal","proposal":{...}}',
    '  {"action":"insufficient_context","reason":"...","missing":["..."]}',
    '  {"action":"no_change_claim","reason":"...","evidence":"..."}',
    'Do not output Markdown fences or any explanation before or after the JSON.',
  ].join('\n');
}

export function formatInvestigationProgress(evidence: InvestigationTurnEvidence): string {
  const parts = [
    `investigation_turn turn=${evidence.turn} action=${evidence.action}`,
    `phase=${evidence.phase}`,
    `remaining=${evidence.remainingAllowance}`,
    `requested=${evidence.requestedAction}`,
  ];
  if (evidence.completedAction) parts.push(`completed=${evidence.completedAction}`);
  if (evidence.path) parts.push(`path=${evidence.path}`);
  if (evidence.range) parts.push(`range=${evidence.range}`);
  if (evidence.scope) parts.push(`scope=${evidence.scope}`);
  if (evidence.resultCount !== undefined) parts.push(`results=${evidence.resultCount}`);
  if (evidence.error) parts.push(`error=${evidence.error}`);
  if (evidence.deliveredChars !== undefined) parts.push(`delivered_chars=${evidence.deliveredChars}`);
  if (evidence.truncated) parts.push('truncated=true');
  if (evidence.totalLines !== undefined) parts.push(`total_lines=${evidence.totalLines}`);
  if (evidence.eof !== undefined) parts.push(`eof=${evidence.eof}`);
  if (evidence.noUnreadContent) parts.push('no_unread_content=true');
  if (evidence.promptChars !== undefined || evidence.promptCharacterCount !== undefined) {
    parts.push(`prompt_chars=${evidence.promptChars ?? evidence.promptCharacterCount}`);
  }
  if (evidence.durationMs !== undefined || evidence.elapsedMs !== undefined) {
    parts.push(`duration_ms=${evidence.durationMs ?? evidence.elapsedMs}`);
  }
  if (evidence.isRepair) {
    parts.push('is_repair=true');
  }
  if (evidence.repairAttempted) {
    parts.push('repair_attempted=true');
  }
  if (evidence.repairDurationMs !== undefined) {
    parts.push(`repair_duration_ms=${evidence.repairDurationMs}`);
  }
  if (evidence.initialValidationCodes && evidence.initialValidationCodes.length > 0) {
    parts.push(`initial_errors=${evidence.initialValidationCodes.join(',')}`);
  }
  if (evidence.repairedValidationResult) {
    parts.push(`repaired_result=${evidence.repairedValidationResult}`);
  }
  parts.push(`ok=${evidence.ok ? 'true' : 'false'}`);
  parts.push(`reads=${evidence.completedReads}`);
  parts.push(`unique_files=${evidence.uniqueFiles}`);
  if (evidence.recovery) parts.push(`recovery=${evidence.recovery}`);
  if (evidence.stopReason) parts.push(`stop=${evidence.stopReason}`);
  if (evidence.query) parts.push(`query=${evidence.query}`);
  return parts.join(' ');
}

export function formatInvestigationRecovery(subreason: string): string {
  return `investigation_recovery reason=${subreason} attempt=1/1`;
}

export function formatInvestigationCloudRecovery(
  reason: LoopLevelCloudEscalationReason,
  destinationModel: string,
  sourceModel: string,
): string {
  return `investigation_cloud_recovery reason=${reason} from=${sourceModel} to=${destinationModel}`;
}

export function formatInvestigationCloudSkipped(
  reason: string,
  completedReads: number,
  uniqueFiles: number,
): string {
  return `investigation_cloud_skipped reason=${reason} reads=${completedReads} unique_files=${uniqueFiles}`;
}

export function formatInvestigationStop(reason: string, errors: readonly string[] = []): string {
  const suffix = errors.length > 0 ? ` errors=${errors.join(',')}` : '';
  return `investigation_stop reason=${reason}${suffix}`;
}

export function formatProposalRepairProgress(
  stage: 'needed' | 'attempted' | 'invalid' | 'succeeded',
  details?: { code?: string },
): string {
  const codeSuffix = details?.code ? ` code=${details.code}` : '';
  return `investigation_proposal_repair stage=${stage}${codeSuffix}`;
}

/** Compact, content-free summary of a rejected proposal's operations (diagnostic only). */
function describeProposalOperations(proposal: unknown): string {
  const ops = (proposal as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(ops)) return 'operations=none';
  return ops.slice(0, 8).map((op) => {
    const record = (op && typeof op === 'object' ? op : {}) as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content.length : -1;
    return `[keys=${Object.keys(record).join('|')} type=${String(record.type ?? record.action ?? record.operation ?? '')} path=${String(record.path ?? '')} content_chars=${content}]`;
  }).join(' ');
}

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function buildCompactProposalRepairPrompt(
  originalProposal: Record<string, unknown>,
  errors: readonly string[],
  supportedValidationCommands: readonly string[],
  repairHints: readonly string[] = [],
): string {
  return [
    'The proposed CodingProposal failed validation. Correct the JSON structure to satisfy the contract.',
    `Validation errors: ${errors.join(', ')}`,
    ...(repairHints.length > 0
      ? ['', 'Evidence for the rejected edit anchors (current file text; copy each corrected oldText exactly from it, never guess):', ...repairHints.slice(0, 3)]
      : []),
    '',
    'Original proposal:',
    JSON.stringify(originalProposal, null, 2),
    '',
    'Contract constraints required for repair:',
    '- Output exactly one JSON object matching the CodingProposal schema.',
    '- Each file path in operations must appear at most once. Put every anchor for one file in a single "edit" operation\'s edits array.',
    '- Do not submit fragments or placeholders. Replace operations must contain complete file content; "edit" operations keep their {"oldText","newText"} anchors (each oldText exact, non-empty, matching the file exactly once, non-overlapping). If an edit error says an anchor was not found or ambiguous, include more exact surrounding text from what you read; do not guess.',
    '- NEVER convert a file modification, fix, or update into a delete operation. If a file should be modified, use "type": "edit" (preferred) or "type": "replace" with the complete file content.',
    '- Only use "type": "delete" when a file is explicitly being removed from the repository.',
    '- validationCommands must use only supported validation commands for this workspace:',
    ...supportedValidationCommands.map(cmd => `  ${cmd}`),
    'Do not output Markdown fences. Do not output any explanation before or after the JSON.',
  ].join('\n');
}
