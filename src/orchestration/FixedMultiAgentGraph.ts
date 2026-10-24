import { AgentMode } from '../config/ConfigSchema';
import { RepositoryContextService } from '../context/RepositoryContextService';
import { ContextRole, RepositoryContextResult } from '../context/RepositoryTypes';
import { ProviderType } from '../providers/ProviderTypes';
import { GovernedModelDispatchSeam } from '../agent/LocalFirstModelDispatchRouter';
import {
  GOVERNED_MODEL_CONTRACT_VERSION,
  GovernedModelFailureCode,
  GovernedModelInvalidResponseReason,
  GovernedModelRequest,
  ModelExecutionEvidence,
} from '../agent/GovernedModelExecutionTypes';
import { ForgeInvocationAuditMetadata } from '../agent/AgentEngineTypes';
import {
  CODING_PROPOSAL_MAX_RESPONSE_BYTES,
  CodingProposal,
  CodingProposalConformanceMetadata,
  buildCodingProposalResponseFormat,
  taskMentionsRemoval,
} from '../coding/CodingProposal';
import { parseValidateAndExpandCodingProposal, describeProposalShape } from '../coding/AnchoredEdit';
import { buildTargetedSourceContext } from '../coding/TargetedSourceExcerpts';
import { findValidationPlanCoverageErrors, readWorkspacePackageScripts, readWorkspaceTestRunner } from '../coding/CodingPlanner';

export const FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION = 1 as const;

export const FIXED_MULTI_AGENT_STAGES = [
  'repository-analyst',
  'planner',
  'implementer',
  'reviewer',
  'validator',
] as const;

export type FixedMultiAgentStage = typeof FIXED_MULTI_AGENT_STAGES[number];
export type FixedMultiAgentStageStatus = 'completed' | 'failed' | 'cancelled';
export type FixedMultiAgentGraphStatus = 'completed' | 'failed' | 'cancelled';

/** Bounded, content-free per-stage progress notification: never carries prompt
 * text, model output, or repository content — only stage identity, position,
 * routing, and timing. */
export interface FixedMultiAgentStageProgressEvent {
  type: 'stage_started' | 'stage_completed' | 'stage_failed' | 'stage_cancelled' | 'stage_timed_out';
  stage: FixedMultiAgentStage;
  index: number;
  total: number;
  model?: string;
  providerType?: ProviderType;
  durationMs?: number;
}

export interface FixedMultiAgentGraphRequest {
  contractVersion: typeof FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION;
  invocationId: string;
  taskId: string;
  goal: string;
  model: string;
  providerType?: ProviderType;
  workspaceRoot?: string;
  signal?: AbortSignal;
  audit?: ForgeInvocationAuditMetadata;
  configWorkspaceRoot?: string;
  /** Optional bounded per-stage progress hook; never receives prompt/response text. */
  onStageEvent?: (event: FixedMultiAgentStageProgressEvent) => void;
  /**
   * Drains any user steering messages queued since the previous stage
   * boundary. Called once per stage, immediately before that stage's prompt
   * is built, so guidance sent mid-run reaches the next stage that has not
   * yet started — never the stage already in flight. Returns an empty array
   * (or is omitted) when nothing is pending.
   */
  pendingSteering?: () => string[] | Promise<string[]>;
}

export interface FixedMultiAgentStageEvidence {
  stage: FixedMultiAgentStage;
  model: string;
  providerType?: ProviderType;
  durationMs?: number;
  selectedContextFiles: string[];
  contextEstimatedTokens: number;
  omittedContextCount: number;
  modelEvidence: ModelExecutionEvidence;
}

export interface FixedMultiAgentStageResult {
  stage: FixedMultiAgentStage;
  status: FixedMultiAgentStageStatus;
  content?: string;
  model: string;
  providerType?: ProviderType;
  durationMs?: number;
  evidence: FixedMultiAgentStageEvidence;
  failureCode?: GovernedModelFailureCode;
  failureReason?: string;
}

export interface FixedMultiAgentGraphResult {
  contractVersion: typeof FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION;
  invocationId: string;
  taskId: string;
  status: FixedMultiAgentGraphStatus;
  completedStages: FixedMultiAgentStage[];
  activeStage?: FixedMultiAgentStage;
  failedStage?: FixedMultiAgentStage;
  finalValidatorOutput?: string;
  proposalConsumption?: FixedMultiAgentProposalConsumptionResult;
  stages: FixedMultiAgentStageResult[];
  evidence: FixedMultiAgentStageEvidence[];
  failureCode?: GovernedModelFailureCode;
  failureReason?: string;
}

export type FixedMultiAgentProposalConsumptionStatus = 'ready' | 'invalid' | 'unavailable';

export interface FixedMultiAgentProposalConsumptionResult {
  status: FixedMultiAgentProposalConsumptionStatus;
  proposal?: CodingProposal;
  errors: string[];
  /** Sanitized sub-reason, set only when `status` is 'unavailable' because the
   * governed model dispatch itself failed with 'invalid_model_response' —
   * never raw response/prompt/completion text. See GovernedModelExecutionTypes. */
  invalidResponseReason?: GovernedModelInvalidResponseReason;
  conformance?: CodingProposalConformanceMetadata;
  /** Bounded model feedback for the single contract repair (e.g. current text near a missed edit anchor). Never applied. */
  repairHints?: string[];
  /** Content-free summary of the operation shape the validator stage actually produced, set when it was rejected. */
  shape?: string;
  sourceStage: 'validator';
  invocationId: string;
  taskId: string;
  model: string;
  providerType?: ProviderType;
  evidence: {
    stage: 'validator';
    requestId: string;
    model: string;
    providerType?: ProviderType;
    structuredOutput?: {
      requested: boolean;
      supported: boolean;
      active: boolean;
      deferredReason?: string;
    };
    selectedContextFiles: string[];
    contextEstimatedTokens: number;
    omittedContextCount: number;
  };
}

export interface FixedMultiAgentRepositoryContextProvider {
  build(request: {
    query: string;
    mode: AgentMode;
    role?: ContextRole;
    model: string;
    providerType?: string;
    tokenBudget?: number;
  }): Promise<RepositoryContextResult>;
}

const STAGE_ROLES: Record<FixedMultiAgentStage, ContextRole> = {
  'repository-analyst': 'general',
  planner: 'planner',
  implementer: 'implementer',
  reviewer: 'reviewer',
  validator: 'validator',
};

const PREVIOUS_OUTPUT_LIMIT = 6000;
const CONTEXT_TOKEN_BUDGET = 2200;
// Proposal-producing stages must be able to see the complete content of the
// files they are asked to modify — a truncated view forces the model to
// invent the remainder, which then fails real validation. Sized to fit
// comfortably inside the 32k operational window of the local coding models
// alongside the goal, handoff proposal, and contract block.
const PROPOSAL_CONTEXT_TOKEN_BUDGET = 9000;

export class FixedMultiAgentGraph {
  constructor(
    private readonly dispatcher: GovernedModelDispatchSeam,
    private readonly contextProvider?: FixedMultiAgentRepositoryContextProvider,
  ) {}

  static forWorkspace(
    dispatcher: GovernedModelDispatchSeam,
    workspaceRoot?: string,
  ): FixedMultiAgentGraph {
    return new FixedMultiAgentGraph(
      dispatcher,
      workspaceRoot ? new RepositoryContextService(workspaceRoot) : undefined,
    );
  }

  async execute(request: FixedMultiAgentGraphRequest): Promise<FixedMultiAgentGraphResult> {
    const validation = validateFixedMultiAgentGraphRequest(request);
    if (!validation.accepted) {
      return {
        contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
        invocationId: request.invocationId,
        taskId: request.taskId,
        status: 'failed',
        completedStages: [],
        stages: [],
        evidence: [],
        failureCode: 'execution_rejected',
        failureReason: `Request rejected before graph execution: ${validation.errors.join('; ')}`,
      };
    }

    const stages: FixedMultiAgentStageResult[] = [];
    let previousOutput = '';
    let effectiveGoal = request.goal;
    const stageTotal = FIXED_MULTI_AGENT_STAGES.length;
    // Ground proposal stages in the parts of the host contract the JSON schema
    // cannot express (real npm script names, path rules) so a schema-valid
    // proposal is not rejected later for inventing e.g. a nonexistent script.
    const packageScripts = request.workspaceRoot
      ? await readWorkspacePackageScripts(request.workspaceRoot)
      : [];
    const testRunner = request.workspaceRoot
      ? await readWorkspaceTestRunner(request.workspaceRoot)
      : undefined;
    // The repository context service shows a large file only as an outline. Planner and proposal stages also get
    // bounded verbatim excerpts of the regions the goal points at, so an edit anchor can be copied, not guessed.
    const targetedExcerpts = await this.targetedExcerpts(request);

    for (const [stageOffset, stage] of FIXED_MULTI_AGENT_STAGES.entries()) {
      const stageIndex = stageOffset + 1;
      if (request.signal?.aborted) {
        return this.stopResult(request, 'cancelled', stages, stage, 'cancelled', 'Graph was cancelled before the next stage started.');
      }

      const steeringMessages = await request.pendingSteering?.() ?? [];
      if (steeringMessages.length > 0) {
        effectiveGoal = `${effectiveGoal}\n\nSteering guidance from the user (received while this task was running):\n${steeringMessages.join('\n')}`;
      }

      const handoff = preparePreviousOutputForStage(stage, previousOutput);
      if (!handoff.ok) {
        return this.stopResult(request, 'failed', stages, stage, 'execution_rejected', handoff.failureReason);
      }

      const context = await this.buildContext(request, stage, previousOutput);
      const prompt = buildStagePrompt(
        effectiveGoal,
        stage,
        handoff.value,
        withTargetedExcerpts(context.prompt, stage === 'planner' || shouldRequestCodingProposal(stage) ? targetedExcerpts : ''),
        shouldRequestCodingProposal(stage) ? hostContractPromptBlock(packageScripts, testRunner) : undefined,
      );
      const governedRequest: GovernedModelRequest = {
        contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
        requestId: `fixed-multi-agent:${request.invocationId}:${stage}`,
        invocationId: request.invocationId,
        taskId: request.taskId,
        model: request.model,
        providerType: request.providerType,
        prompt,
        responseFormat: shouldRequestCodingProposal(stage) ? buildCodingProposalResponseFormat({ allowDelete: taskMentionsRemoval(request.goal) }) : undefined,
        signal: request.signal,
        audit: request.audit,
        configWorkspaceRoot: request.configWorkspaceRoot,
      };

      request.onStageEvent?.({
        type: 'stage_started',
        stage,
        index: stageIndex,
        total: stageTotal,
        model: request.model,
        providerType: request.providerType,
      });
      let result;
      try {
        result = await this.dispatcher.dispatch(governedRequest);
      } catch (error) {
        request.onStageEvent?.({ type: 'stage_failed', stage, index: stageIndex, total: stageTotal, durationMs: 0 });
        throw error;
      }
      request.onStageEvent?.({
        type: stageTerminalEventType(result.status, result.failureCode),
        stage,
        index: stageIndex,
        total: stageTotal,
        model: result.model,
        providerType: result.providerType,
        durationMs: result.evidence.durationMs,
      });
      const stageResult: FixedMultiAgentStageResult = {
        stage,
        status: result.status,
        content: result.completion,
        model: result.model,
        providerType: result.providerType,
        durationMs: result.evidence.durationMs,
        evidence: {
          stage,
          model: result.model,
          providerType: result.providerType,
          durationMs: result.evidence.durationMs,
          selectedContextFiles: context.files.map(file => file.path),
          contextEstimatedTokens: context.diagnostics.estimatedTokens,
          omittedContextCount: context.diagnostics.omittedCount ?? 0,
          modelEvidence: result.evidence,
        },
        failureCode: result.failureCode,
        failureReason: result.failureReason,
      };
      stages.push(stageResult);

      if (request.signal?.aborted && result.status === 'completed') {
        return this.stopResult(request, 'cancelled', stages.slice(0, -1), stage, 'cancelled', 'Graph was cancelled before the stage result could advance.');
      }

      if (result.status !== 'completed') {
        return this.stopResult(
          request,
          result.status,
          stages,
          stage,
          result.failureCode,
          result.failureReason ?? 'Stage did not complete successfully.',
        );
      }

      previousOutput = result.completion ?? '';
    }

    const finalStage = stages[stages.length - 1];
    return {
      contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
      invocationId: request.invocationId,
      taskId: request.taskId,
      status: 'completed',
      completedStages: [...FIXED_MULTI_AGENT_STAGES],
      finalValidatorOutput: finalStage?.content,
      proposalConsumption: await consumeValidatorProposal(request, finalStage),
      stages,
      evidence: stages.map(stage => stage.evidence),
    };
  }

  /**
   * Bounded, single-shot repair path: re-dispatches only the validator stage with a
   * short correction appended, reusing the prior CodingProposal candidate as handoff
   * content exactly as the normal validator stage would receive it. Callers are
   * responsible for enforcing a single-attempt bound; this method does not retry.
   */
  async regenerateValidatorProposal(
    request: FixedMultiAgentGraphRequest,
    priorProposalContent: string,
    correction: string,
  ): Promise<FixedMultiAgentProposalConsumptionResult> {
    const stage: FixedMultiAgentStage = 'validator';
    const context = await this.buildContext(request, stage, priorProposalContent);
    const packageScripts = request.workspaceRoot
      ? await readWorkspacePackageScripts(request.workspaceRoot)
      : [];
    const testRunner = request.workspaceRoot
      ? await readWorkspaceTestRunner(request.workspaceRoot)
      : undefined;
    const prompt = buildRegenerationPrompt(
      request.goal,
      priorProposalContent,
      correction,
      withTargetedExcerpts(context.prompt, await this.targetedExcerpts(request)),
      hostContractPromptBlock(packageScripts, testRunner),
    );
    const governedRequest: GovernedModelRequest = {
      contractVersion: GOVERNED_MODEL_CONTRACT_VERSION,
      requestId: `fixed-multi-agent:${request.invocationId}:validator-repair`,
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      providerType: request.providerType,
      prompt,
      responseFormat: buildCodingProposalResponseFormat({ allowDelete: taskMentionsRemoval(request.goal) }),
      signal: request.signal,
      audit: request.audit,
      configWorkspaceRoot: request.configWorkspaceRoot,
    };
    const result = await this.dispatcher.dispatch(governedRequest);
    const stageResult: FixedMultiAgentStageResult = {
      stage,
      status: result.status,
      content: result.completion,
      model: result.model,
      providerType: result.providerType,
      durationMs: result.evidence.durationMs,
      evidence: {
        stage,
        model: result.model,
        providerType: result.providerType,
        durationMs: result.evidence.durationMs,
        selectedContextFiles: context.files.map(file => file.path),
        contextEstimatedTokens: context.diagnostics.estimatedTokens,
        omittedContextCount: context.diagnostics.omittedCount ?? 0,
        modelEvidence: result.evidence,
      },
      failureCode: result.failureCode,
      failureReason: result.failureReason,
    };
    if (result.status !== 'completed') {
      return {
        status: 'unavailable',
        errors: [result.failureReason ?? 'Proposal regeneration stage did not complete.'],
        invalidResponseReason: result.failureCode === 'invalid_model_response' ? result.invalidResponseReason : undefined,
        sourceStage: 'validator',
        invocationId: request.invocationId,
        taskId: request.taskId,
        model: result.model,
        providerType: result.providerType,
        evidence: proposalEvidence(request, stageResult),
      };
    }
    return consumeValidatorProposal(request, stageResult);
  }

  private async targetedExcerpts(request: FixedMultiAgentGraphRequest): Promise<string> {
    if (!request.workspaceRoot) return '';
    try {
      return (await buildTargetedSourceContext(request.workspaceRoot, request.goal, { signal: request.signal })).text;
    } catch {
      return '';
    }
  }

  private async buildContext(
    request: FixedMultiAgentGraphRequest,
    stage: FixedMultiAgentStage,
    previousOutput: string,
  ): Promise<RepositoryContextResult> {
    if (!this.contextProvider) {
      return emptyContext();
    }
    return this.contextProvider.build({
      query: `${request.goal}\n\nStage: ${stage}\n\nPrevious output summary:\n${boundPreviousOutput(previousOutput)}`,
      mode: stage === 'planner' ? 'plan' : stage === 'implementer' ? 'agent' : 'ask',
      role: STAGE_ROLES[stage],
      model: request.model,
      providerType: request.providerType,
      tokenBudget: shouldRequestCodingProposal(stage) ? PROPOSAL_CONTEXT_TOKEN_BUDGET : CONTEXT_TOKEN_BUDGET,
    });
  }

  private stopResult(
    request: FixedMultiAgentGraphRequest,
    status: FixedMultiAgentGraphStatus,
    stages: FixedMultiAgentStageResult[],
    failedStage: FixedMultiAgentStage,
    failureCode?: GovernedModelFailureCode,
    failureReason?: string,
  ): FixedMultiAgentGraphResult {
    return {
      contractVersion: FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION,
      invocationId: request.invocationId,
      taskId: request.taskId,
      status,
      completedStages: stages.filter(stage => stage.status === 'completed').map(stage => stage.stage),
      activeStage: failedStage,
      failedStage,
      stages,
      evidence: stages.map(stage => stage.evidence),
      failureCode,
      failureReason,
    };
  }
}

function stageTerminalEventType(status: FixedMultiAgentStageStatus, failureCode?: GovernedModelFailureCode): FixedMultiAgentStageProgressEvent['type'] {
  if (status === 'completed') return 'stage_completed';
  if (status === 'cancelled') return 'stage_cancelled';
  if (failureCode && /timeout/i.test(failureCode)) return 'stage_timed_out';
  return 'stage_failed';
}

export function validateFixedMultiAgentGraphRequest(
  request: FixedMultiAgentGraphRequest,
): { accepted: boolean; errors: string[] } {
  const errors: string[] = [];
  if (request.contractVersion !== FIXED_MULTI_AGENT_GRAPH_CONTRACT_VERSION) {
    errors.push('contractVersion must be 1');
  }
  if (!isNonEmptyString(request.invocationId)) {
    errors.push('invocationId must be a non-empty string');
  }
  if (!isNonEmptyString(request.taskId)) {
    errors.push('taskId must be a non-empty string');
  }
  if (!isNonEmptyString(request.goal)) {
    errors.push('goal must be a non-empty string');
  }
  if (!isNonEmptyString(request.model)) {
    errors.push('model must be a non-empty string');
  }
  return { accepted: errors.length === 0, errors };
}

function withTargetedExcerpts(repositoryContext: string, excerpts: string): string {
  if (!excerpts) return repositoryContext;
  return repositoryContext ? `${repositoryContext}

${excerpts}` : excerpts;
}

function buildStagePrompt(goal: string, stage: FixedMultiAgentStage, previousOutput: string, repositoryContext: string, hostContract?: string): string {
  const proposalStageInstruction = proposalStageInstructions(stage);
  return [
    `Stage: ${stage}`,
    'You are one stage in a fixed deterministic production pipeline.',
    'Do not run tools. Do not mutate repository files. Do not ask for later-stage work.',
    proposalStageInstruction,
    ...(hostContract ? ['', hostContract] : []),
    '',
    'Original user goal:',
    goal,
    '',
    'Immediately preceding stage output:',
    previousOutput || '(none)',
    '',
    'Bounded repository context selected for this stage:',
    repositoryContext || '(none)',
  ].join('\n');
}

function buildRegenerationPrompt(goal: string, priorProposalContent: string, correction: string, repositoryContext: string, hostContract?: string): string {
  return [
    'Stage: validator (bounded proposal repair)',
    'You are one stage in a fixed deterministic production pipeline.',
    'Do not run tools. Do not mutate repository files. Do not ask for later-stage work.',
    'Return one complete replacement CodingProposal JSON candidate only. Do not wrap it in prose or Markdown.',
    ...(hostContract ? ['', hostContract] : []),
    '',
    correction,
    '',
    'Original user goal:',
    goal,
    '',
    'Immediately preceding CodingProposal candidate:',
    priorProposalContent || '(none)',
    '',
    'Bounded repository context selected for this stage:',
    repositoryContext || '(none)',
  ].join('\n');
}

/**
 * The semantic half of the coding-proposal host contract — everything
 * parseAndValidateCodingProposal enforces that a response-format JSON schema
 * cannot express. Shown to every proposal-producing stage so schema-valid
 * output is not later rejected for e.g. an invented npm script name.
 * Purely informative: host validation itself is unchanged and still authoritative.
 */
export function hostContractPromptBlock(
  packageScripts: readonly string[],
  testRunner?: 'vitest' | 'jest' | 'mocha',
): string {
  const scripts = packageScripts.filter(script => script !== 'package' && !script.startsWith('test:live'));
  return [
    'Host contract for the CodingProposal (the host rejects any violation):',
    '- Every operations[].path is relative to the repository root and uses forward slashes only — no absolute paths, no "..", nothing under .git, node_modules, out, dist, build, coverage, tmp, temp, .cache or cache.',
    '- Operation types are create, replace, edit or delete; create and replace carry the complete file content; every operation targets a distinct path and states a reason.',
    '- To change an EXISTING file, prefer {"type":"edit","path":"...","reason":"...","edits":[{"oldText":"<exact existing snippet>","newText":"<replacement>"}]} (1-20 edits). The host applies the edits to the real file: each oldText must be non-empty, copied exactly from the file, occur exactly once in it, and must not overlap another edit. Never emit a whole large file just to change part of it.',
    `- validationCommands entries may only be {"kind":"git-diff-check"}, {"kind":"git-status-short"}, {"kind":"tsc-no-emit"}, {"kind":"npm-test"}, {"kind":"vitest","args":["--run","<path>.test.ts"]}, or {"kind":"npm-script","script":"<name>"} where <name> is exactly one of: ${scripts.length > 0 ? scripts.join(', ') : '(no npm scripts are available — do not use npm-script)'}.`,
    '- Never invent npm script names or command kinds.',
    '- Never import a module or file that does not already exist in the repository unless this same proposal creates it. When replacing an existing file, keep its existing behavior and assertions except where the goal explicitly requires a change.',
    ...(testRunner
      ? [`- Tests in this repository run under ${testRunner} (from package.json). Test files must import their APIs (describe, it, expect, hooks) from '${testRunner}' and must not import any other test framework.`]
      : ['- This repository\'s package.json names no recognized test framework dependency. Do not assume any test framework\'s globals (e.g. describe, it, expect) are available. Match the existing test file\'s own imports/API exactly — when replacing a test file, keep its existing assertion style.']),
  ].join('\n');
}

function preparePreviousOutputForStage(
  stage: FixedMultiAgentStage,
  previousOutput: string,
): { ok: true; value: string } | { ok: false; failureReason: string } {
  if (stage !== 'reviewer' && stage !== 'validator') {
    return { ok: true, value: boundPreviousOutput(previousOutput) };
  }
  if (Buffer.byteLength(previousOutput, 'utf8') > CODING_PROPOSAL_MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      failureReason: 'Previous CodingProposal candidate exceeded the maximum permitted response size.',
    };
  }
  return { ok: true, value: previousOutput };
}

function proposalStageInstructions(stage: FixedMultiAgentStage): string {
  switch (stage) {
    case 'repository-analyst':
      return 'Return bounded repository analysis text only.';
    case 'planner':
      return 'Return bounded implementation planning text only.';
    case 'implementer':
      return 'Return one complete canonical CodingProposal JSON candidate only. Do not wrap it in prose or Markdown.';
    case 'reviewer':
      return 'Review the immediately preceding CodingProposal candidate and return one complete corrected CodingProposal JSON candidate only. Do not wrap it in prose or Markdown.';
    case 'validator':
      return 'Validate the immediately preceding CodingProposal candidate and return the final complete CodingProposal JSON candidate only. Do not merely say that it is valid.';
  }
}

function shouldRequestCodingProposal(stage: FixedMultiAgentStage): boolean {
  return stage === 'implementer' || stage === 'reviewer' || stage === 'validator';
}

async function consumeValidatorProposal(
  request: FixedMultiAgentGraphRequest,
  finalStage: FixedMultiAgentStageResult | undefined,
): Promise<FixedMultiAgentProposalConsumptionResult> {
  if (!finalStage?.content) {
    return {
      status: 'unavailable',
      errors: [],
      sourceStage: 'validator',
      invocationId: request.invocationId,
      taskId: request.taskId,
      model: request.model,
      providerType: request.providerType,
      evidence: proposalEvidence(request, finalStage),
    };
  }

  const scripts = request.workspaceRoot
    ? await readWorkspacePackageScripts(request.workspaceRoot)
    : [];
  const validation = await parseValidateAndExpandCodingProposal(finalStage.content, scripts, request.workspaceRoot);
  let errors = validation.ok ? [] : validation.errors;
  let proposal = validation.proposal;
  if (validation.ok && validation.proposal && request.workspaceRoot) {
    // Same repository-grounded coverage check the lightweight CodingPlanner
    // path applies (see findValidationPlanCoverageErrors) — a nonexistent
    // vitest test path, or a changed file with no real validation coverage,
    // must not pass structural validation just because it is schema-valid.
    const coverageErrors = await findValidationPlanCoverageErrors(request.workspaceRoot, validation.proposal);
    if (coverageErrors.length > 0) {
      errors = coverageErrors;
      proposal = undefined;
    }
  }
  return {
    status: proposal ? 'ready' : 'invalid',
    proposal,
    errors,
    conformance: validation.conformance,
    ...(proposal ? {} : { shape: describeProposalShape(finalStage.content), repairHints: validation.repairHints }),
    sourceStage: 'validator',
    invocationId: request.invocationId,
    taskId: request.taskId,
    model: finalStage.model,
    providerType: finalStage.providerType,
    evidence: proposalEvidence(request, finalStage),
  };
}

function proposalEvidence(
  request: FixedMultiAgentGraphRequest,
  finalStage: FixedMultiAgentStageResult | undefined,
): FixedMultiAgentProposalConsumptionResult['evidence'] {
  return {
    stage: 'validator',
    requestId: finalStage?.evidence.modelEvidence.requestId ?? `fixed-multi-agent:${request.invocationId}:validator`,
    model: finalStage?.model ?? request.model,
    providerType: finalStage?.providerType ?? request.providerType,
    structuredOutput: finalStage?.evidence.modelEvidence.context?.structuredOutput,
    selectedContextFiles: finalStage?.evidence.selectedContextFiles ?? [],
    contextEstimatedTokens: finalStage?.evidence.contextEstimatedTokens ?? 0,
    omittedContextCount: finalStage?.evidence.omittedContextCount ?? 0,
  };
}

function boundPreviousOutput(output: string): string {
  if (output.length <= PREVIOUS_OUTPUT_LIMIT) {
    return output;
  }
  return `${output.slice(0, PREVIOUS_OUTPUT_LIMIT)}\n[previous stage output truncated]`;
}

function emptyContext(): RepositoryContextResult {
  return {
    prompt: '',
    files: [],
    diagnostics: {
      queryTerms: [],
      providerContextWindow: 0,
      inputBudget: 0,
      estimatedTokens: 0,
      omittedCount: 0,
      selectedFiles: [],
      rejectedFiles: [],
      inventorySize: 0,
      inventoryTruncated: false,
    },
    index: {
      schemaVersion: 2,
      workspaceRoot: '',
      identity: {
        repositoryRoot: '',
        branch: '',
        headCommit: '',
        worktree: '',
        detached: false,
        schemaVersion: 1,
      },
      createdAt: '',
      updatedAt: '',
      state: 'unavailable',
      files: [],
      ignoredPatterns: [],
      truncated: false,
      statistics: {
        files: 0,
        symbols: 0,
        imports: 0,
        tests: 0,
        configs: 0,
        buildFiles: 0,
        markdown: 0,
        changedFiles: 0,
        deletedFiles: 0,
      },
      pins: [],
      exclusions: [],
    },
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
