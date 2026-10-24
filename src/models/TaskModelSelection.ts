import type { ModelCapability } from './ModelCapabilityRegistry';
import type { ModelRole } from '../providers/InferenceTypes';
import { deriveMutationPolicy } from '../../core/domain/mutationPolicy';
import { conditionalMutationDirective, mentionsMutationOnlyAsSubjectMatter } from '../../core/domain/actionIntent';
import {
  ROUTING_POLICY_VERSION,
  assessQualification,
  deriveToolProtocol,
  describeAutoWhy,
  providerDeclaresNoChat,
  rankCandidates,
  taskFitBucket,
  toAlternatives,
  toolProtocolSupportsTools,
  type LadderCandidate,
  type RankedCandidate,
  type QualificationAssessment,
  type QualificationEvidence,
  type TaskFit,
  type RoutingDecisionEvidence,
  type RoutingSelectionMode,
  type TaskClassificationSource,
  type ToolProtocol,
} from '../../core/domain/empiricalRouting';

export type CodingComplexity = 'none' | 'low' | 'medium' | 'high';

export type TaskRequiredCapability =
  | 'chat'
  | 'repository-exploration'
  | 'tool-calling'
  | 'file-mutation'
  | 'coding-low'
  | 'coding-medium'
  | 'coding-high'
  | 'vision'
  | 'validation-repair'
  | `context-${number}`;

export interface TaskRequirementHints {
  repositoryExploration?: boolean;
  toolCalling?: boolean;
  fileMutation?: boolean;
  codingComplexity?: CodingComplexity;
  minimumContextWindow?: number;
  vision?: boolean;
  validationRepair?: boolean;
}

export interface TaskRequirements {
  readOnlyExplanation: boolean;
  repositoryExploration: boolean;
  toolCalling: boolean;
  fileMutation: boolean;
  codingComplexity: CodingComplexity;
  minimumContextWindow: number;
  vision: boolean;
  validationRepair: boolean;
  requiredCapabilities: readonly TaskRequiredCapability[];
  /** Where these requirements came from; see `classifyTaskRequirements`. Absent on hand-built requirements. */
  classification?: TaskClassification;
}

export interface TaskClassification {
  source: TaskClassificationSource;
  confidence: 'high' | 'medium' | 'low';
}

/** A configured model on the provider selected by the user or local-only policy. */
export interface TaskModelCandidate {
  provider: string;
  model: string;
  available: boolean;
  capabilities: ModelCapability;
  configuredRoles: readonly ModelRole[];
  /** Relative per-call cost. Lower is cheaper. Inferred from parameter count when omitted. */
  cost?: number;
  /** Observed/configured success score from 0 to 1. A conservative static score is used when omitted. */
  reliability?: number;
  /**
   * Total parameters in billions as reported by the provider's own model
   * metadata. When present it is the size the static reliability and cost
   * heuristics use, instead of a `...27b...`-style size read from the name.
   */
  parameterBillions?: number;
  /**
   * True when this model must never be chosen by AUTOMATIC selection (see
   * ModelCapabilityRegistry.isAutomaticSelectionExcluded — a deliberate,
   * reviewable, per-machine policy decision, not a capability fact). Treated
   * as an advisory reason: an explicit userOverride naming this exact model
   * still works, exactly like a reliability-below-floor advisory today.
   */
  automaticSelectionExcluded?: boolean;
  /**
   * True when a `ollama-agent.*Model` setting names this model for some role
   * (any role) — as opposed to only being eligible for a role because it was
   * auto-opened (see `unconfiguredAutoEligibleRoles`/`AUTO_ELIGIBLE_ROLES` in
   * ProductionModelCandidates.ts) while no setting names anything for that
   * role. In AUTOMATIC selection this is only a LATE tie-break (after task fit, benchmark evidence, tool
   * protocol, residency and latency; see the ladder in empiricalRouting.ts): a configured default never
   * outranks capability or evidence. MANUAL selection is how an operator pins a model.
   */
  explicitlyConfigured?: boolean;
  /** Capabilities the provider itself declares for this model (e.g. Ollama `tools`). Evidence only; consulted by benchmark-forced selection. */
  providerCapabilities?: readonly string[];
  /**
   * How this model carries tool calls. Derived from `capabilities.tools` and `providerCapabilities` when omitted
   * (see `deriveToolProtocol`). `native` and `prompted` both satisfy a tool-calling task (M49.2); only `none` does not.
   */
  toolProtocol?: ToolProtocol;
  /** Real benchmark outcomes for this exact model. Absent means "no evidence", which is neutral, never incompatibility. */
  qualification?: QualificationEvidence;
  /** Loaded in memory right now (provider evidence); undefined when the provider could not say. */
  resident?: boolean;
}

export interface TaskModelOverride {
  provider: string;
  model: string;
}

export interface SelectTaskModelInput {
  /** Provider already selected by configuration/policy. Selection never crosses this boundary. */
  provider: string;
  candidates: readonly TaskModelCandidate[];
  requirements: TaskRequirements;
  userOverride?: TaskModelOverride;
  /**
   * model:test only. The userOverride was forced by the benchmark runner, so registry POLICY records (a
   * role allow-list, a static `tools:false` note the provider does not corroborate) are recorded as
   * advisory instead of refusing the model. Provider-evidenced and structural incompatibilities (unavailable,
   * no chat, embedding-only, context, vision, provider-declared missing tools) stay hard. Absent in production.
   */
  benchmarkForced?: boolean;
}

export interface RankedTaskModelCandidate {
  provider: string;
  model: string;
  cost: number;
  reliability: number;
  reason: string;
}

/**
 * A candidate that was not selected. `hardReasons` are technical
 * incompatibilities that block selection unconditionally — automatic
 * selection AND an explicit per-task override. `advisoryReasons` (reliability
 * below the task's *preferred* floor, unmeasured evidence, a per-machine
 * automatic-selection exclusion) mean the model is technically viable but
 * unproven or policy-restricted: an explicit override always retains it, and
 * AUTOMATIC selection now retains it too as a fallback when no candidate
 * clears the preferred reliability threshold (see `selectTaskModel`) — except
 * a per-machine `automaticSelectionExcluded` policy, which still blocks the
 * AUTOMATIC path specifically (a deliberate, reviewable restriction, not a
 * confidence signal). `reasons` is both, hard first. A model that ends up
 * SELECTED never appears here, even if its `advisoryReasons` is non-empty.
 */
export interface RejectedTaskModelCandidate {
  provider: string;
  model: string;
  reasons: readonly string[];
  hardReasons: readonly string[];
  advisoryReasons: readonly string[];
}

export type NormalEligibility = 'eligible' | 'below_preference_floor' | 'unknown' | 'hard_incompatible';

export interface TaskModelSelectionResult {
  selectedProvider: string;
  selectedModel: string;
  reason: string;
  suitabilitySummary: string;
  overridden: boolean;
  /**
   * True when the selected model did not clear the task's preferred
   * reliability threshold (or, for an override, has some other advisory
   * concern) — it is technically viable (no hard incompatibility) but chosen
   * as the best available candidate below preferred confidence rather than a
   * proven one. UNKNOWN != INCOMPATIBLE: this never means the model is
   * unsupported, only that it should be watched/observed. Callers (UI,
   * telemetry, recovery) use this to surface reduced confidence without
   * treating the run as degraded governance.
   */
  belowPreferredConfidence: boolean;
  /**
   * How NORMAL (non-benchmark) automatic selection would regard the selected
   * model for this task: 'eligible' (no advisory concern), 'below_preference_floor'
   * (technically viable but under the reliability floor, or automatic selection is
   * disabled for it), or 'unknown' (below the floor with no reliability/size
   * evidence at all). Observability only; never gates selection.
   */
  normalEligibility: NormalEligibility;
  /** The actual reason behind `normalEligibility` ('no advisory concern' when eligible). */
  eligibilityReason: string;
  requiredCapabilities: readonly TaskRequiredCapability[];
  escalationCandidates: readonly RankedTaskModelCandidate[];
  rejectedCandidates: readonly RejectedTaskModelCandidate[];
  diagnostics: readonly string[];
  /** M50: the concise, frozen explanation of this decision. */
  routing: RoutingDecisionEvidence;
  /**
   * Activity/debug only (never primary chat UI, never frozen): one line per candidate plus a summary, so repeated
   * selection of one model can be told apart as legitimate or accidental. Present for AUTOMATIC selection only.
   */
  decisionTrace?: readonly string[];
}

export type TaskModelSelectionErrorCode =
  | 'override_provider_mismatch'
  | 'override_not_configured'
  | 'override_incompatible'
  | 'no_capable_model';

export class TaskModelSelectionError extends Error {
  constructor(
    public readonly code: TaskModelSelectionErrorCode,
    message: string,
    public readonly rejectedCandidates: readonly RejectedTaskModelCandidate[] = [],
    /** Set when an explicit override was refused for a genuine hard requirement. */
    public readonly normalEligibility?: NormalEligibility,
    /** Hard reasons behind the refusal (override path only). */
    public readonly hardReasons: readonly string[] = [],
  ) {
    super(message);
    this.name = 'TaskModelSelectionError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Context an image request needs. Must equal ModelDispatchPlanner's OLLAMA_VISION_MINIMUM_CONTEXT (asserted in tests). */
export const VISION_MINIMUM_CONTEXT = 16_384;

/** Shown when no installed model's provider declares vision; image tasks are never silently sent to a text-only model. */
export const NO_VISION_MODEL_MESSAGE = 'No configured vision-capable model is available';

const MUTATION = /\b(add|build|change|create|delete|edit|fix|implement|migrate|modify|patch|refactor|remove|rename|replace|update|write)\b/i;
const REPOSITORY = /\b(codebase|file|folder|function|git|module|package|project|repo(?:sitory)?|source|test|workspace)\b/i;
const EXPLANATION = /\b(analy[sz]e|describe|explain|how|investigate|read|review|summari[sz]e|understand|what|why)\b/i;
const VALIDATION = /\b(broken|bug|debug|fail(?:ed|ing|ure)?|fix|lint|repair|test|typecheck|validat(?:e|ion)|verify)\b/i;
const HIGH_COMPLEXITY = /\b(architecture|cross[- ]cutting|database migration|end[- ]to[- ]end|large[- ]scale|multi[- ]file|race condition|redesign|security|system[- ]wide)\b/i;
const LOW_COMPLEXITY = /\b(comment|documentation|readme|small|simple|single[- ]file|spelling|typo)\b/i;
const VISION_INPUT = /\b(analy[sz]e|inspect|read|review|use)\b.{0,32}\b(attached )?(diagram|image|photo|screenshot)\b/i;

/** "Fix only if tests fail": the change is authorized, not mandated (a conflicting objective keeps its unconditional part). */
function isPurelyConditionalMutation(text: string): boolean {
  const conditional = conditionalMutationDirective(text);
  return conditional !== null && !conditional.unconditionalChange;
}

export function classifyTaskRequirements(
  task: string,
  hints: TaskRequirementHints = {},
): TaskRequirements {
  const text = task.trim();
  // An explicit read-only objective ("Do not modify any files") mentions a
  // mutation verb but forbids it: the bare MUTATION keyword test is
  // negation-blind and must never classify such a task as file-mutating.
  // Nor is a mutation word used only as subject matter ("Describe how to write
  // a file", "Explain how the update function works") or inside a conditional:
  // this flag reaches Core as fileModification and would demand a change.
  const fileMutation = hints.fileMutation ?? (deriveMutationPolicy(text) === 'denied'
    ? false
    : MUTATION.test(text) && !mentionsMutationOnlyAsSubjectMatter(text, MUTATION) && !isPurelyConditionalMutation(text));
  const repositoryExploration = hints.repositoryExploration ?? (fileMutation || REPOSITORY.test(text));
  const toolCalling = hints.toolCalling ?? repositoryExploration;
  const vision = hints.vision ?? VISION_INPUT.test(text);

  // Precedence (M50): structured hints from the mode / execution profile, then the explicit read-only
  // objective above, then prompt keywords for whatever no hint decided. The result records which of those
  // sources decided (`classification`), so a prompt-only guess is never reported as structured knowledge.
  const structuredCore = hints.fileMutation !== undefined && hints.repositoryExploration !== undefined && hints.toolCalling !== undefined;
  const anyHint = Object.values(hints).some(value => value !== undefined);
  const promptSignal = [MUTATION, REPOSITORY, VALIDATION, HIGH_COMPLEXITY, LOW_COMPLEXITY, VISION_INPUT].some(pattern => pattern.test(text));
  const classification: TaskClassification = structuredCore
    ? { source: 'structured', confidence: 'high' }
    : anyHint
      ? { source: 'mixed', confidence: 'medium' }
      : promptSignal
        ? { source: 'prompt_hint', confidence: 'low' }
        : { source: 'general', confidence: 'low' };

  let codingComplexity = hints.codingComplexity;
  if (!codingComplexity) {
    codingComplexity = !fileMutation
      ? 'none'
      : HIGH_COMPLEXITY.test(text)
        ? 'high'
        : LOW_COMPLEXITY.test(text)
          ? 'low'
          : 'medium';
  }

  // validationRepair means actual validate/debug/test/repair work, not any file
  // mutation. Ordinary creation/editing tasks (e.g. "create foo.txt") must not
  // be forced through the stricter validation-repair reliability bar just
  // because they touch a file.
  const validationRepair = hints.validationRepair ?? VALIDATION.test(text);
  // An image turn needs the dispatch vision floor (see OLLAMA_VISION_MINIMUM_CONTEXT), not the high-complexity
  // coding bar: demanding 32K here refused every model whose measured window was the conservative 8K fallback.
  const derivedContext = codingComplexity === 'high'
    ? 32_768
    : vision || codingComplexity === 'medium'
      ? VISION_MINIMUM_CONTEXT
      : repositoryExploration
        ? 8_192
        : 4_096;
  const minimumContextWindow = Math.max(1, Math.floor(hints.minimumContextWindow ?? derivedContext));
  const readOnlyExplanation = !fileMutation && !validationRepair && (EXPLANATION.test(text) || !repositoryExploration);

  const requiredCapabilities: TaskRequiredCapability[] = ['chat'];
  if (repositoryExploration) requiredCapabilities.push('repository-exploration');
  if (toolCalling) requiredCapabilities.push('tool-calling');
  if (fileMutation) requiredCapabilities.push('file-mutation');
  if (codingComplexity !== 'none') requiredCapabilities.push(`coding-${codingComplexity}`);
  if (vision) requiredCapabilities.push('vision');
  if (validationRepair) requiredCapabilities.push('validation-repair');
  requiredCapabilities.push(`context-${minimumContextWindow}`);

  return {
    readOnlyExplanation,
    repositoryExploration,
    toolCalling,
    fileMutation,
    codingComplexity,
    minimumContextWindow,
    vision,
    validationRepair,
    requiredCapabilities,
    classification,
  };
}

interface EvaluatedCandidate {
  candidate: TaskModelCandidate;
  cost: number;
  reliability: number;
  toolProtocol: ToolProtocol;
  qualification: QualificationAssessment;
  /** Coarse fit bucket from the suitability prior against the task's preferred bar (see `taskFitBucket`). */
  taskFit: TaskFit;
  hardReasons: string[];
  advisoryReasons: string[];
  reasons: string[];
  /** True when the vision requirement itself (provider declaration / static record) rules this model out. */
  visionIncompatible: boolean;
  /** Reasons that would be hard in normal selection but were relaxed for a benchmark-forced model. */
  relaxedHardReasons: string[];
}

export function selectTaskModel(input: SelectTaskModelInput): TaskModelSelectionResult {
  const provider = input.provider.trim();
  const sorted = [...input.candidates].sort(compareCandidateIdentity);
  const overrideKey = input.userOverride ? `${normalize(input.userOverride.provider)}/${normalize(input.userOverride.model)}` : undefined;
  const evaluated = sorted.map(candidate => evaluateCandidate(
    candidate, provider, input.requirements, input.benchmarkForced === true,
    overrideKey !== undefined && `${normalize(candidate.provider)}/${normalize(candidate.model)}` === overrideKey,
  ));
  const allRejected = () => evaluated.filter(item => item.reasons.length > 0).map(toRejectedCandidate);

  if (input.userOverride) {
    if (normalize(input.userOverride.provider) !== normalize(provider)) {
      throw new TaskModelSelectionError(
        'override_provider_mismatch',
        `The explicit override uses provider "${input.userOverride.provider}", but policy is restricted to "${provider}".`,
        allRejected(),
      );
    }
    const override = evaluated.find(item =>
      normalize(item.candidate.provider) === normalize(provider)
      && normalize(item.candidate.model) === normalize(input.userOverride?.model ?? ''),
    );
    if (!override) {
      throw new TaskModelSelectionError(
        'override_not_configured',
        `The explicit override model "${input.userOverride.model}" is not configured for provider "${provider}".`,
        allRejected(),
      );
    }

    if (override.hardReasons.length > 0) {
      throw new TaskModelSelectionError(
        'override_incompatible',
        `The explicit override model "${input.userOverride.model}" is incompatible with the task requirements: ${override.hardReasons.join(' ')}`,
        allRejected(),
        'hard_incompatible',
        override.hardReasons,
      );
    }

    // Advisory evidence (unproven reliability, a per-machine automatic-selection
    // exclusion, ...) never blocks an explicit override — UNKNOWN != INCOMPATIBLE,
    // and the user's own choice is authoritative once hard compatibility is
    // confirmed. It is retained purely for observability.
    const belowPreferredConfidence = override.advisoryReasons.length > 0;
    const diagnostics = belowPreferredConfidence
      ? [`Explicit override retained despite advisory assessment: ${override.advisoryReasons.join(' ')}`]
      : ['Explicit user override retained.'];
    const capableAlternatives = evaluated.filter(item => item !== override && item.reasons.length === 0);
    const rejectedCandidates = evaluated.filter(item => item !== override && item.reasons.length > 0).map(toRejectedCandidate);
    const routing = routingEvidence(input.requirements, input.benchmarkForced === true ? 'forced' : 'manual', override, capableAlternatives.length + 1, [
      input.benchmarkForced === true ? 'Model forced by the benchmark runner' : 'Your selected model',
      'Compatible with the current task',
      ...(belowPreferredConfidence ? ['Advisory only: below the preferred reliability bar, kept because you chose it'] : []),
    ], []);
    return buildResult(override, input.requirements, true, capableAlternatives, rejectedCandidates, diagnostics, belowPreferredConfidence, routing);
  }

  // AUTOMATIC SELECTION
  //
  // `viable` excludes only genuine HARD incompatibilities plus the deliberate,
  // reviewable per-machine AUTOMATIC_SELECTION_EXCLUDED policy (see
  // ModelCapabilityRegistry) — that policy is a known-bad-interaction
  // restriction on the AUTOMATIC path specifically, not a confidence signal.
  // Everything else technically viable stays eligible and is ranked, never refused:
  // an advisory (below the reliability floor, unmeasured) lowers a model's suitability
  // rung, so the best compatible model is always available as the fallback.
  const viable = evaluated.filter(item => item.hardReasons.length === 0 && !item.candidate.automaticSelectionExcluded);
  const ranked = rankCandidates(viable.map(item => toLadderCandidate(item, input.requirements.toolCalling)));
  const selected = ranked[0]?.candidate.evaluated;

  if (!selected) {
    throw new TaskModelSelectionError('no_capable_model', noCapableModelMessage(provider, input.requirements, evaluated), allRejected());
  }

  const belowPreferredConfidence = selected.advisoryReasons.length > 0;
  // Escalation candidates are documented as "ordered from the selected model
  // upward" (see ModelSelectionEvidence.escalationCandidates) — i.e. genuine
  // retry-with-something-stronger options, not every technically viable
  // model. A fallback-tier candidate weaker than the one actually selected
  // (lower reliability) is a worse choice, not an escalation, so it stays out
  // of this list even though it remains technically viable and visible via
  // `rejectedCandidates` for observability.
  const alternatives = viable.filter(item => item !== selected && item.reliability >= selected.reliability);
  const rejectedCandidates = evaluated.filter(item => item !== selected && item.reasons.length > 0).map(toRejectedCandidate);
  const diagnostics = belowPreferredConfidence
    ? [
        'Automatic selection stayed on the configured provider.',
        `No candidate met the preferred reliability threshold; automatic selection used the best technically viable candidate instead: ${selected.advisoryReasons.join(' ')}`,
      ]
    : ['Automatic selection stayed on the configured provider.'];

  const toolsRequired = input.requirements.toolCalling;
  const routing = routingEvidence(
    input.requirements,
    'auto',
    selected,
    viable.length,
    describeAutoWhy({
      selected: ranked[0].candidate,
      selectedQualification: selected.qualification,
      ranked,
      belowPreferredConfidence,
      toolProtocol: selected.toolProtocol,
      toolsRequired,
      resident: selected.candidate.resident === true,
    }),
    toAlternatives(ranked),
    selected.qualification.meaningful && selected.qualification.tier !== 'neutral',
  );
  const result = buildResult(selected, input.requirements, false, alternatives, rejectedCandidates, diagnostics, belowPreferredConfidence, routing);
  return { ...result, decisionTrace: buildAutoDecisionTrace(input.requirements, evaluated, ranked) };
}

/**
 * The truthful reason Auto found nothing. For an image task the first question is whether ANY chat-capable candidate
 * has vision at all: if none does, say exactly that; if some does but was refused for another reason (context, role),
 * name that reason instead of the generic refusal.
 */
function noCapableModelMessage(provider: string, requirements: TaskRequirements, evaluated: readonly EvaluatedCandidate[]): string {
  if (requirements.vision) {
    const visionCapable = evaluated.filter(item => !item.visionIncompatible && item.candidate.capabilities.chat && !item.candidate.capabilities.embeddingOnly);
    if (visionCapable.length === 0) return `${NO_VISION_MODEL_MESSAGE} on provider "${provider}".`;
    const why = visionCapable.map(item => `${item.candidate.model}: ${item.hardReasons.join(' ')}`).join(' ');
    return `A vision-capable model is installed on provider "${provider}" but none can run this image task. ${why}`;
  }
  return `No available configured model on provider "${provider}" satisfies the task requirements.`;
}

function taskClassLabel(requirements: TaskRequirements): string {
  const kind = requirements.vision
    ? 'vision'
    : requirements.fileMutation
      ? `mutation/${requirements.codingComplexity}`
      : requirements.validationRepair
        ? 'validation'
        : requirements.repositoryExploration
          ? 'repo-read'
          : 'chat';
  const source = requirements.classification?.source ?? 'general';
  return `${kind} (source=${source}, tools=${requirements.toolCalling}, minCtx=${requirements.minimumContextWindow})`;
}

/** One concise record per candidate considered by AUTOMATIC selection, then the exact rung that separated #1 from #2. */
function buildAutoDecisionTrace(
  requirements: TaskRequirements,
  evaluated: readonly EvaluatedCandidate[],
  ranked: readonly RankedCandidate<RankedEvaluated>[],
): string[] {
  const rankOf = new Map(ranked.map(item => [item.candidate.evaluated, item]));
  const lines: string[] = [`task=${taskClassLabel(requirements)}`];
  for (const item of evaluated) {
    const entry = rankOf.get(item);
    const caps = item.candidate.capabilities;
    const structural = item.hardReasons.length > 0
      ? item.hardReasons.join(' ')
      : item.candidate.automaticSelectionExcluded
        ? 'excluded from automatic selection on this machine'
        : '';
    const latency = item.candidate.qualification?.medianDurationMs;
    lines.push([
      `candidate=${item.candidate.model}`,
      structural ? `INELIGIBLE (${structural})` : 'eligible',
      `roles=${item.candidate.configuredRoles.join('+') || 'none'}`,
      `fit=${item.taskFit}`,
      `evidence=${item.qualification.meaningful ? item.qualification.tier : 'neutral'} [${item.qualification.summary}]`,
      `ctx=${caps.contextWindow}${caps.contextWindow >= requirements.minimumContextWindow ? '>=' : '<'}${requirements.minimumContextWindow}`,
      `tools=${item.toolProtocol}`,
      `resident=${item.candidate.resident ?? 'unknown'}`,
      `latencyMs=${latency ?? 'unknown'}`,
      `configuredDefault=${item.candidate.explicitlyConfigured === true}`,
      `sizeB=${modelSizeBillions(item.candidate) || 'unknown'}`,
      `priorReliability=${item.reliability.toFixed(2)}`,
      entry ? `rank=${entry.rank}${entry.behindBecauseOf ? ` (behind #${entry.rank - 1} on ${entry.behindBecauseOf})` : ''}` : 'rank=-',
    ].join(' | '));
  }
  const first = ranked[0];
  const second = ranked[1];
  if (first && second) {
    lines.push(`winner=${first.candidate.model} beat #2 ${second.candidate.model} on rung=${second.behindBecauseOf ?? 'none'}`);
  } else if (first) {
    lines.push(`winner=${first.candidate.model} (only eligible candidate; ${evaluated.length - 1} rejected)`);
  }
  return lines;
}

function routingEvidence(
  requirements: TaskRequirements,
  selectionMode: RoutingSelectionMode,
  selected: EvaluatedCandidate,
  compatibleCandidateCount: number,
  why: string[],
  alternatives: RoutingDecisionEvidence['alternatives'],
  empiricalEvidenceUsed = false,
): RoutingDecisionEvidence {
  return {
    policyVersion: ROUTING_POLICY_VERSION,
    selectionMode,
    classificationSource: requirements.classification?.source ?? 'general',
    toolProtocol: selected.toolProtocol,
    why,
    compatibleCandidateCount,
    empiricalEvidenceUsed,
    alternatives,
  };
}

type RankedEvaluated = LadderCandidate & { evaluated: EvaluatedCandidate; qualificationSummary: string };

function toLadderCandidate(item: EvaluatedCandidate, toolsRequired: boolean): RankedEvaluated {
  const parameters = modelSizeBillions(item.candidate);
  return {
    provider: item.candidate.provider,
    model: item.candidate.model,
    // Coarse buckets only. The legacy continuous reliability estimate already produced the `taskFit` bucket
    // against the task's floor; it is never compared as a number here.
    taskFit: item.taskFit,
    qualificationTier: item.qualification.meaningful ? item.qualification.tier : 'neutral',
    ...(toolsRequired ? { toolProtocol: item.toolProtocol } : {}),
    configuredDefault: item.candidate.explicitlyConfigured === true,
    ...(item.candidate.resident !== undefined ? { resident: item.candidate.resident } : {}),
    ...(item.candidate.qualification?.medianDurationMs ? { latencyMs: item.candidate.qualification.medianDurationMs } : {}),
    ...(parameters > 0 ? { parameterBillions: parameters } : {}),
    evaluated: item,
    qualificationSummary: item.qualification.summary,
  };
}

function buildResult(
  selected: EvaluatedCandidate,
  requirements: TaskRequirements,
  overridden: boolean,
  alternatives: readonly EvaluatedCandidate[],
  rejectedCandidates: readonly RejectedTaskModelCandidate[],
  diagnostics: readonly string[],
  belowPreferredConfidence: boolean,
  routing: RoutingDecisionEvidence,
): TaskModelSelectionResult {
  const normalEligibility = normalEligibilityOf(selected);
  const eligibilityReason = selected.advisoryReasons.length > 0 ? selected.advisoryReasons.join(' ') : 'No advisory concern.';
  return {
    selectedProvider: selected.candidate.provider,
    selectedModel: selected.candidate.model,
    reason: overridden
      ? `Kept the user's explicit model override on ${selected.candidate.provider}.`
      : selectionReason(selected, requirements, belowPreferredConfidence),
    suitabilitySummary: suitabilitySummary(requirements, selected, overridden, belowPreferredConfidence),
    overridden,
    belowPreferredConfidence,
    normalEligibility,
    eligibilityReason,
    requiredCapabilities: [...requirements.requiredCapabilities],
    escalationCandidates: [...alternatives]
      .sort(compareEscalationPreference)
      .map(item => ({
        provider: item.candidate.provider,
        model: item.candidate.model,
        cost: item.cost,
        reliability: item.reliability,
        reason: `Stronger alternative with reliability ${item.reliability.toFixed(2)} and context ${item.candidate.capabilities.contextWindow}.`,
      })),
    rejectedCandidates,
    diagnostics,
    routing,
  };
}

function evaluateCandidate(
  candidate: TaskModelCandidate,
  selectedProvider: string,
  requirements: TaskRequirements,
  benchmarkForced = false,
  exactManualPick = false,
): EvaluatedCandidate {
  const hardReasons: string[] = [];
  const advisoryReasons: string[] = [];
  const relaxedHardReasons: string[] = [];
  let visionIncompatible = false;
  // Benchmark-forced only: registry policy is not a provider-evidenced fact, so it is demoted to advisory.
  const policyRefusal = (reason: string) => (benchmarkForced ? relaxedHardReasons : hardReasons).push(reason);
  const caps = candidate.capabilities;
  const allowedRoles = new Set(caps.allowedRoles);
  const generative = isGenerativeModel(caps);
  let usableConfiguredRoles = candidate.configuredRoles.filter(role => role !== 'autocomplete' && role !== 'embedding') as ModelRole[];
  // An exact manual pick is a capability question, not a settings question: a generative model the user named is
  // usable for whatever roles its capability record permits even if no `*Model` setting assigned it (Auto still
  // only draws on role-assigned models). Non-generative models (embedding/reranker/autocomplete-only) never are.
  if (exactManualPick && generative && candidate.configuredRoles.length === 0) {
    usableConfiguredRoles = capabilityRolesOf(caps);
  }
  const configuredRoles = new Set<ModelRole>(usableConfiguredRoles);

  if (normalize(candidate.provider) !== normalize(selectedProvider)) hardReasons.push('Different provider; provider switching is not permitted.');
  if (!candidate.available) hardReasons.push('Model is not available.');
  if (!caps.chat) hardReasons.push('Chat capability is required.');
  // Provider evidence outranks the static registry/name heuristic: a provider that declares capabilities without
  // `completion` refuses chat outright, so such a model is never eligible (Auto) nor silently accepted (Manual).
  else if (providerDeclaresNoChat(candidate.providerCapabilities)) {
    hardReasons.push(`Provider declares no chat capability for this model (declared: ${candidate.providerCapabilities!.join(', ')}).`);
  }
  if (caps.embeddingOnly) hardReasons.push('Embedding-only models cannot run tasks.');
  else if (!generative && usableConfiguredRoles.length > 0) policyRefusal('Model is autocomplete-only and is not a generative chat/coding model.');
  else if (usableConfiguredRoles.length === 0) {
    hardReasons.push(candidate.configuredRoles.length > 0
      ? 'Model is configured only for autocomplete or embedding.'
      : 'Model is not assigned to any task role in settings; Auto selects only role-assigned models (selecting it manually is still allowed).');
  }
  if (allowedRoles.size > 0 && !usableConfiguredRoles.some(role => allowedRoles.has(role))) {
    policyRefusal('Configured roles are not permitted by the model capability record.');
  }
  // M49.2: native function calling is not the only compatible tool protocol. A model whose provider accepts the
  // tool payload but which answers in-content (`prompted`) is parsed and gated by the same inline-call path.
  const toolProtocol = candidate.toolProtocol
    ?? deriveToolProtocol({ nativeToolCalling: caps.tools, providerCapabilities: candidate.providerCapabilities });
  if (requirements.toolCalling && !toolProtocolSupportsTools(toolProtocol)) {
    // A provider that itself declares capabilities without `tools` is genuine evidence; the static registry alone is not.
    const providerDeniesTools = candidate.providerCapabilities !== undefined && !candidate.providerCapabilities.includes('tools');
    if (providerDeniesTools || !benchmarkForced) hardReasons.push('Tool calling is required.');
    else relaxedHardReasons.push('Tool calling is required; the static registry lists none but the provider declares tool support.');
  }
  if (requirements.vision) {
    // Provider-declared capability is the authority when it exists (Ollama /api/show `capabilities`): it can both grant
    // vision to a model the static table does not know and deny it to one a name pattern would have guessed. Without any
    // provider declaration the static record decides (never invented support).
    const declared = candidate.providerCapabilities;
    const visionOk = declared ? declared.includes('vision') : caps.vision;
    if (!visionOk) {
      visionIncompatible = true;
      hardReasons.push(declared ? `Provider does not declare vision support for this model (declared: ${declared.join(', ')}).` : 'Vision input is required.');
    }
  }
  if (requirements.minimumContextWindow > 0 && caps.contextWindow < requirements.minimumContextWindow) {
    hardReasons.push(`Context window ${caps.contextWindow} is below required ${requirements.minimumContextWindow}.`);
  }
  if (requirements.repositoryExploration && !hasAnyRole(configuredRoles, ['agent', 'reviewer'])) {
    hardReasons.push('Repository exploration requires an agent or reviewer role.');
  }
  if (requirements.fileMutation && !hasAnyRole(configuredRoles, ['agent', 'edit'])) {
    hardReasons.push('File mutation requires an agent or edit role.');
  }
  if (requirements.validationRepair && !hasAnyRole(configuredRoles, ['agent', 'edit', 'reviewer'])) {
    hardReasons.push('Validation repair requires an agent, edit, or reviewer role.');
  }

  const reliability = reliabilityScore(candidate);
  const minimumReliability = requiredReliability(requirements);
  // Meaningful benchmark evidence supersedes the heuristic reliability estimate: a model that has repeatedly
  // passed real scenarios is not "unproven" because a name/size heuristic scored it under the floor. Thin
  // evidence never counts (see assessQualification), and absence of evidence changes nothing.
  const qualification = assessQualification(candidate.qualification);
  const empiricallyProven = qualification.meaningful && qualification.tier === 'strong';
  const taskFit = taskFitBucket({ prior: reliability, floor: minimumReliability, empiricallyProven });
  if (taskFit === 'below') {
    // With no observed score and no known size, the heuristic can only credit
    // capability flags; say so, so an unmeasured model is not read as a
    // technically incapable one.
    const unmeasured = candidate.reliability === undefined && modelSizeBillions(candidate) === 0
      ? ' No observed reliability or parameter-size evidence exists for this model.'
      : '';
    advisoryReasons.push(`Reliability ${reliability.toFixed(2)} is below required ${minimumReliability.toFixed(2)}.${unmeasured}`);
  }
  if (qualification.meaningful && qualification.tier === 'poor') {
    advisoryReasons.push(`Benchmark record is poor (${qualification.summary}).`);
  }
  if (candidate.automaticSelectionExcluded) {
    advisoryReasons.push('Automatic selection is disabled for this model on this machine; an explicit override is still allowed.');
  }

  advisoryReasons.unshift(...relaxedHardReasons);
  return { candidate, cost: costScore(candidate), reliability, toolProtocol, qualification, taskFit, hardReasons, advisoryReasons, reasons: [...hardReasons, ...advisoryReasons], visionIncompatible, relaxedHardReasons };
}

const DEFAULT_GENERATIVE_ROLES: readonly ModelRole[] = ['chat', 'agent', 'edit', 'reviewer'];

/** Hard capability distinction: only a chat-capable, non-embedding/reranker, non-autocomplete-only model is generative. */
export function isGenerativeModel(caps: Pick<ModelCapability, 'chat' | 'embeddingOnly' | 'allowedRoles'>): boolean {
  if (!caps.chat || caps.embeddingOnly) return false;
  return !(caps.allowedRoles.length > 0 && caps.allowedRoles.every(role => role === 'autocomplete' || role === 'embedding'));
}

function capabilityRolesOf(caps: ModelCapability): ModelRole[] {
  const usable = caps.allowedRoles.filter(role => role !== 'autocomplete' && role !== 'embedding');
  return usable.length > 0 ? usable : [...DEFAULT_GENERATIVE_ROLES];
}

function normalEligibilityOf(item: EvaluatedCandidate): NormalEligibility {
  if (item.relaxedHardReasons.length > 0) return 'hard_incompatible';
  if (item.advisoryReasons.length === 0) return 'eligible';
  const unmeasured = item.candidate.reliability === undefined && modelSizeBillions(item.candidate) === 0;
  return unmeasured ? 'unknown' : 'below_preference_floor';
}

function selectionReason(candidate: EvaluatedCandidate, requirements: TaskRequirements, belowPreferredConfidence: boolean): string {
  const taskKind = requirements.vision
    ? 'vision task'
    : requirements.fileMutation
      ? `${requirements.codingComplexity} complexity coding task`
      : requirements.repositoryExploration
        ? 'repository exploration'
        : 'read-only task';
  if (belowPreferredConfidence) {
    return `${candidate.candidate.model} is the best technically viable model on ${candidate.candidate.provider} for this ${taskKind}; `
      + 'no candidate met the preferred reliability threshold.';
  }
  return `${candidate.candidate.model} is the best-fitting available model on ${candidate.candidate.provider} for this ${taskKind}, chosen by task fit, benchmark evidence, tool protocol, residency and cost rather than a single score.`;
}

function suitabilitySummary(requirements: TaskRequirements, selected: EvaluatedCandidate, overridden: boolean, belowPreferredConfidence: boolean): string {
  // "Suited to this task" is a claim; it needs routing evidence (the model met the task's preferred fit with nothing
  // advisory against it). An exact manual pick or a best-available fallback is reported as exactly that, never as suited.
  if (overridden) return `Using ${selected.candidate.model} as selected`;
  if (belowPreferredConfidence || selected.taskFit === 'below' || selected.advisoryReasons.length > 0) {
    return `Using ${selected.candidate.model}, the best available option; fit for this task is not established`;
  }
  if (requirements.vision) return 'Using a vision-capable model suited to this task';
  if (requirements.fileMutation && requirements.codingComplexity === 'high') return 'Using a stronger coding model suited to this task';
  if (requirements.fileMutation) return 'Using a coding model suited to this task';
  if (requirements.repositoryExploration) return 'Using a tool-capable model suited to this task';
  return 'Using an efficient model suited to this task';
}

function requiredReliability(requirements: TaskRequirements): number {
  const complexityFloor: Record<CodingComplexity, number> = {
    none: 0.45,
    low: 0.58,
    medium: 0.76,
    high: 0.88,
  };
  return Math.max(complexityFloor[requirements.codingComplexity], requirements.validationRepair ? 0.82 : 0);
}

function reliabilityScore(candidate: TaskModelCandidate): number {
  if (candidate.reliability !== undefined) return clamp(candidate.reliability, 0, 1);
  const caps = candidate.capabilities;
  const lower = candidate.model.toLowerCase();
  const parameters = modelSizeBillions(candidate);
  let score = caps.chat ? 0.45 : 0;
  if (caps.tools) score += 0.08;
  if (caps.structuredOutput) score += 0.06;
  if (caps.streaming) score += 0.04;
  if (/\b(coder|code|codestral)\b/.test(lower)) score += 0.08;
  if (candidate.configuredRoles.some(role => role === 'agent' || role === 'edit')) score += 0.03;
  if (parameters >= 70) score += 0.22;
  else if (parameters >= 30) score += 0.18;
  else if (parameters >= 14) score += 0.13;
  else if (parameters >= 7) score += 0.08;
  else if (parameters >= 3) score += 0.03;
  return clamp(score, 0, 1);
}

function costScore(candidate: TaskModelCandidate): number {
  if (candidate.cost !== undefined && Number.isFinite(candidate.cost)) return Math.max(0, candidate.cost);
  const parameters = modelSizeBillions(candidate);
  return parameters > 0 ? parameters : 100;
}

/** Provider-reported size when known, else the size encoded in the model name, else 0 (unknown). */
function modelSizeBillions(candidate: TaskModelCandidate): number {
  const reported = candidate.parameterBillions;
  if (reported !== undefined && Number.isFinite(reported) && reported > 0) return reported;
  return modelParameterBillions(candidate.model);
}

function modelParameterBillions(model: string): number {
  const lower = model.toLowerCase();
  const billions = [...lower.matchAll(/(?:^|[:_-])(\d+(?:\.\d+)?)b(?:$|[_-])/g)];
  const billionValue = billions.at(-1)?.[1];
  if (billionValue) return Number(billionValue);
  // Sub-billion models are commonly tagged in millions (e.g. "270m"), not a
  // "0b" suffix. Without this, such a name parses to 0 — "unknown size" —
  // which costScore() then treats as free (cost 0), letting a genuinely tiny
  // model outrank every real candidate on cost regardless of suitability.
  const millions = [...lower.matchAll(/(?:^|[:_-])(\d+(?:\.\d+)?)m(?:$|[_-])/g)];
  const millionValue = millions.at(-1)?.[1];
  return millionValue ? Number(millionValue) / 1000 : 0;
}

function compareCandidateIdentity(left: TaskModelCandidate, right: TaskModelCandidate): number {
  return normalize(left.provider).localeCompare(normalize(right.provider))
    || normalize(left.model).localeCompare(normalize(right.model));
}

function compareEscalationPreference(left: EvaluatedCandidate, right: EvaluatedCandidate): number {
  return right.reliability - left.reliability
    || right.candidate.capabilities.contextWindow - left.candidate.capabilities.contextWindow
    || left.cost - right.cost
    || compareCandidateIdentity(left.candidate, right.candidate);
}

function toRejectedCandidate(item: EvaluatedCandidate): RejectedTaskModelCandidate {
  return {
    provider: item.candidate.provider,
    model: item.candidate.model,
    reasons: [...item.reasons],
    hardReasons: [...item.hardReasons],
    advisoryReasons: [...item.advisoryReasons],
  };
}

function hasAnyRole(roles: ReadonlySet<ModelRole>, expected: readonly ModelRole[]): boolean {
  return expected.some(role => roles.has(role));
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));
}

export type FrozenModelCheck =
  | { runnable: true; verified: boolean }
  | { runnable: false; code: 'frozen_provider_changed' | 'frozen_model_not_installed'; diagnostic: string };

/**
 * Resume/restart of an attempt whose routing decision was frozen: re-check STRUCTURAL availability only
 * (same provider, model still listed by the provider). It never ranks, scores or chooses; a model that is no
 * longer runnable stops the attempt with a precise diagnostic. Changing model requires a new attempt.
 * `installedModels` undefined or empty means the provider could not say what is installed: the model is not
 * declared missing on no evidence (`verified: false`), and the dispatch itself will report any real failure for
 * the SAME model. Either way nothing is substituted.
 */
export function checkFrozenModelRunnable(input: {
  frozenProvider: string;
  frozenModel: string;
  activeProvider: string;
  installedModels: readonly { name: string; aliases?: readonly string[] }[] | undefined;
}): FrozenModelCheck {
  const { frozenProvider, frozenModel } = input;
  if (normalize(frozenProvider) !== normalize(input.activeProvider)) {
    return {
      runnable: false,
      code: 'frozen_provider_changed',
      diagnostic: `frozen_model_unavailable: this attempt was routed to ${frozenProvider}:${frozenModel}, but the active provider is now "${input.activeProvider}". `
        + 'No replacement was selected. Start a new attempt to use a different model.',
    };
  }
  if (!input.installedModels || input.installedModels.length === 0) return { runnable: true, verified: false };
  const present = input.installedModels.some(item =>
    normalize(item.name) === normalize(frozenModel) || (item.aliases ?? []).some(alias => normalize(alias) === normalize(frozenModel)));
  if (present) return { runnable: true, verified: true };
  return {
    runnable: false,
    code: 'frozen_model_not_installed',
    diagnostic: `frozen_model_unavailable: this attempt was routed to ${frozenProvider}:${frozenModel}, which the provider no longer lists as installed. `
      + 'No replacement was selected. Restore that model to resume, or start a new attempt to use a different one.',
  };
}
