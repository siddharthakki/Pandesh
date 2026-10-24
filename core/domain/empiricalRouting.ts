/**
 * M50 — empirical primary-model routing: the pure policy vocabulary.
 *
 * This module is NOT a dispatcher. Candidate evaluation (hard compatibility, explicit overrides,
 * benchmark forcing) stays in `src/models/TaskModelSelection.ts`, the one production selection path.
 * This module owns only the parts that must be explainable and deterministic on their own:
 *
 *   - the tool-protocol vocabulary (native | prompted | none),
 *   - how empirical qualification evidence is reduced to a cautious tier,
 *   - the automatic ranking ladder and the concise "why" it produces,
 *   - the frozen routing-evidence record shape.
 *
 * AUTO ranking ladder (after hard compatibility has already removed incompatible candidates):
 *
 *   1. task/capability fit: a coarse bucket (comfortable | adequate | below) from the selector's suitability prior
 *   2. relevant empirical qualification, only where the evidence is meaningful
 *   3. tool-protocol evidence (native over prompted), only when the task needs tools
 *   4. residency (already loaded)
 *   5. latency / resource cost from benchmark runs
 *   6. configured default preference, a LATE tie-break
 *   7. parameter size (smaller first)
 *   8. provider:modelId identity, so the order is total and reproducible
 *
 * A configured/default model does not outrank task fit or evidence in AUTO. MANUAL is how an operator pins
 * a model. There is deliberately no weighted global score: every rung is a bucket compared lexicographically.
 * The legacy continuous reliability estimate is only an input to rung 1's bucket; it is never compared as a number.
 *
 * Residency, latency, tool protocol and size are used only when EVERY compared candidate has that datum. A
 * comparator that skips missing data per pair is not transitive, so its result would depend on input order.
 *
 * Missing evidence is never incompatibility: no rung here can exclude a candidate.
 */

export const ROUTING_POLICY_VERSION = 'm50-v1' as const;

export type RoutingSelectionMode = 'auto' | 'manual' | 'forced';

// ---------------------------------------------------------------------------
// Tool protocol
// ---------------------------------------------------------------------------

/**
 * How a model carries KKD tool calls.
 *  - native:   structured provider function calling.
 *  - prompted: the provider accepts the tool payload but the model answers in-content; M49.2 parses and
 *              validates those inline calls with the same name/argument gate as native ones.
 *  - none:     no tool path at all.
 * Native is therefore not the only compatible protocol.
 */
export type ToolProtocol = 'native' | 'prompted' | 'none';

export function toolProtocolSupportsTools(protocol: ToolProtocol): boolean {
  return protocol === 'native' || protocol === 'prompted';
}

/**
 * `prompted` requires positive provider evidence (the provider declares `tools`) because KKD always sends
 * its tool payload; a model the provider says cannot take tools would be refused at the transport. The
 * static registry flag alone only ever proves `native`.
 */
export function deriveToolProtocol(input: {
  nativeToolCalling: boolean;
  providerCapabilities?: readonly string[];
}): ToolProtocol {
  if (input.nativeToolCalling) return 'native';
  if (input.providerCapabilities?.includes('tools')) return 'prompted';
  return 'none';
}

/**
 * True only on positive provider evidence that the model cannot serve chat/generation: the provider declared a
 * capability list and it lacks `completion` (Ollama refuses /api/chat with `"<model>" does not support chat` for
 * exactly those models). An absent or empty list is "unknown", never a refusal. Name hints never decide this.
 */
export function providerDeclaresNoChat(providerCapabilities?: readonly string[]): boolean {
  return Array.isArray(providerCapabilities) && providerCapabilities.length > 0 && !providerCapabilities.includes('completion');
}

// ---------------------------------------------------------------------------
// Empirical qualification evidence
// ---------------------------------------------------------------------------

/** Counts of real benchmark outcomes for one exact model. Infrastructure failures are never counted. */
export interface QualificationEvidence {
  passCount: number;
  sampleCount: number;
  /** Distinct scenarios the samples came from; repetitions of one scenario are one scenario. */
  scenarioCount: number;
  medianDurationMs?: number;
}

/**
 * The m50-v1 evidence policy. These are operational heuristics chosen to keep one lucky run from moving the
 * ranking; they are NOT a statistical significance test and must not be described as one. Changing any value
 * requires a new policy version, because frozen routing decisions record the version they were made under.
 * Below either count bound the evidence is an anecdote, not a signal, and cannot move the ranking.
 */
export const M50_V1_EVIDENCE_POLICY = {
  version: ROUTING_POLICY_VERSION,
  minScenarios: 2,
  minSamples: 5,
  strongPassRate: 0.8,
  poorPassRate: 0.5,
} as const;

export const MIN_MEANINGFUL_SCENARIOS = M50_V1_EVIDENCE_POLICY.minScenarios;
export const MIN_MEANINGFUL_SAMPLES = M50_V1_EVIDENCE_POLICY.minSamples;
export const STRONG_PASS_RATE = M50_V1_EVIDENCE_POLICY.strongPassRate;
export const POOR_PASS_RATE = M50_V1_EVIDENCE_POLICY.poorPassRate;

/** strong ranks above unknown; mixed evidence is no better than unknown; a poor record ranks below it. */
export type QualificationTier = 'strong' | 'neutral' | 'poor';

export interface QualificationAssessment {
  meaningful: boolean;
  passRate?: number;
  tier: QualificationTier;
  summary: string;
}

export function assessQualification(evidence: QualificationEvidence | undefined): QualificationAssessment {
  if (!evidence || !(evidence.sampleCount > 0)) {
    return { meaningful: false, tier: 'neutral', summary: 'no benchmark evidence' };
  }
  const passRate = Math.min(1, Math.max(0, evidence.passCount / evidence.sampleCount));
  const detail = `${evidence.passCount}/${evidence.sampleCount} across ${evidence.scenarioCount} scenario${evidence.scenarioCount === 1 ? '' : 's'}`;
  if (evidence.scenarioCount < MIN_MEANINGFUL_SCENARIOS || evidence.sampleCount < MIN_MEANINGFUL_SAMPLES) {
    return { meaningful: false, passRate, tier: 'neutral', summary: `too little benchmark evidence to rank on (${detail})` };
  }
  const tier: QualificationTier = passRate >= STRONG_PASS_RATE ? 'strong' : passRate < POOR_PASS_RATE ? 'poor' : 'neutral';
  return { meaningful: true, passRate, tier, summary: `benchmark ${detail}` };
}

// ---------------------------------------------------------------------------
// Ranking ladder
// ---------------------------------------------------------------------------

export type LadderRung =
  | 'task_fit'
  | 'qualification'
  | 'tool_protocol'
  | 'residency'
  | 'latency'
  | 'configured_default'
  | 'parameter_size'
  | 'identity';

/**
 * Coarse task/capability fit, three buckets relative to the task's own preferred bar:
 *  - `comfortable`: the suitability prior clears the bar and is a strong general fit overall;
 *  - `adequate`: it clears the bar;
 *  - `below`: it does not, and meaningful benchmark evidence did not vouch for it. Still usable, ranked last.
 * Buckets, not a score: two models in the same bucket are never ordered by their estimates, and a bucket is only a
 * rank, never a gate: `below` is still selectable (0.79 < 0.82 never means "cannot execute").
 */
export type TaskFit = 'comfortable' | 'adequate' | 'below';

export const M50_V1_FIT_POLICY = {
  version: ROUTING_POLICY_VERSION,
  /** The prior from which a model counts as a strong general fit (and never below the task's own bar). */
  comfortableFrom: 0.8,
} as const;

export function taskFitBucket(input: { prior: number; floor: number; empiricallyProven: boolean }): TaskFit {
  if (input.prior >= Math.max(input.floor, M50_V1_FIT_POLICY.comfortableFrom)) return 'comfortable';
  return input.prior >= input.floor || input.empiricallyProven ? 'adequate' : 'below';
}

export interface LadderCandidate {
  provider: string;
  model: string;
  taskFit: TaskFit;
  qualificationTier: QualificationTier;
  /** Only supplied when the task needs tools; undefined otherwise so the rung is skipped. */
  toolProtocol?: ToolProtocol;
  /** Warm in memory right now (runtime evidence); undefined when unknown. */
  resident?: boolean;
  /** Typical task duration from benchmarks; undefined when unknown. */
  latencyMs?: number;
  /** A role setting names this model on purpose. A late tie-break in AUTO only. */
  configuredDefault: boolean;
  parameterBillions?: number;
}

export interface LadderContext {
  useToolProtocol: boolean;
  useResidency: boolean;
  useLatency: boolean;
  useParameterSize: boolean;
}

export function ladderContext(candidates: readonly LadderCandidate[]): LadderContext {
  const all = (known: (candidate: LadderCandidate) => boolean) => candidates.length > 0 && candidates.every(known);
  return {
    useToolProtocol: all(c => c.toolProtocol !== undefined),
    useResidency: all(c => c.resident !== undefined),
    useLatency: all(c => c.latencyMs !== undefined && c.latencyMs > 0),
    useParameterSize: all(c => c.parameterBillions !== undefined && c.parameterBillions > 0),
  };
}

const TIER_ORDER: Record<QualificationTier, number> = { strong: 2, neutral: 1, poor: 0 };
const FIT_ORDER: Record<TaskFit, number> = { comfortable: 2, adequate: 1, below: 0 };
const PROTOCOL_ORDER: Record<ToolProtocol, number> = { native: 2, prompted: 1, none: 0 };

/** Latency is compared by octave: a 2x speed difference counts, run-to-run jitter does not. */
const latencyBand = (ms: number) => Math.round(Math.log2(Math.max(1, ms)));

/** Which rung separates `a` from `b`, or null when they are the same candidate. Negative result favours `a`. */
export function compareLadder(a: LadderCandidate, b: LadderCandidate, context: LadderContext): { order: number; rung: LadderRung } | null {
  const step = (order: number, rung: LadderRung) => (order !== 0 ? { order, rung } : null);
  return step(FIT_ORDER[b.taskFit] - FIT_ORDER[a.taskFit], 'task_fit')
    ?? step(TIER_ORDER[b.qualificationTier] - TIER_ORDER[a.qualificationTier], 'qualification')
    ?? (context.useToolProtocol ? step(PROTOCOL_ORDER[b.toolProtocol ?? 'none'] - PROTOCOL_ORDER[a.toolProtocol ?? 'none'], 'tool_protocol') : null)
    ?? (context.useResidency ? step(Number(b.resident) - Number(a.resident), 'residency') : null)
    ?? (context.useLatency ? step(latencyBand(a.latencyMs ?? 0) - latencyBand(b.latencyMs ?? 0), 'latency') : null)
    ?? step(Number(b.configuredDefault) - Number(a.configuredDefault), 'configured_default')
    ?? (context.useParameterSize ? step(Math.round(a.parameterBillions ?? 0) - Math.round(b.parameterBillions ?? 0), 'parameter_size') : null)
    ?? step(
      identity(a).localeCompare(identity(b)),
      'identity',
    );
}

export interface RankedCandidate<T extends LadderCandidate> {
  candidate: T;
  rank: number;
  /** The rung that placed this candidate behind the one ranked directly above it; null for rank 1. */
  behindBecauseOf: LadderRung | null;
}

export function rankCandidates<T extends LadderCandidate>(candidates: readonly T[]): RankedCandidate<T>[] {
  const context = ladderContext(candidates);
  const ordered = [...candidates].sort((a, b) => compareLadder(a, b, context)?.order ?? 0);
  return ordered.map((candidate, index) => ({
    candidate,
    rank: index + 1,
    behindBecauseOf: index === 0 ? null : compareLadder(ordered[index - 1], candidate, context)?.rung ?? null,
  }));
}

function identity(candidate: { provider: string; model: string }): string {
  return `${candidate.provider.trim().toLowerCase()}:${candidate.model.trim().toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// Frozen routing evidence
// ---------------------------------------------------------------------------

export type TaskClassificationSource = 'structured' | 'mixed' | 'prompt_hint' | 'general';

export interface RoutingAlternative {
  provider: string;
  model: string;
  rank: number;
  /** Why it is behind the model above it. */
  behindBecauseOf: LadderRung | null;
  qualification: string;
}

/**
 * The bounded, human-readable record of one routing decision. It is frozen with the attempt's model
 * selection, so resume and restart read it back instead of routing again.
 */
export interface RoutingDecisionEvidence {
  policyVersion: typeof ROUTING_POLICY_VERSION;
  selectionMode: RoutingSelectionMode;
  classificationSource: TaskClassificationSource;
  toolProtocol: ToolProtocol;
  /** Concise lines for the operator UI; never a score table. */
  why: string[];
  compatibleCandidateCount: number;
  /** True only when meaningful benchmark evidence contributed to this choice. */
  empiricalEvidenceUsed: boolean;
  /** Bounded; detail view only. */
  alternatives: RoutingAlternative[];
}

export const MAX_ROUTING_ALTERNATIVES = 5;

const RUNG_PHRASE: Record<LadderRung, string> = {
  task_fit: 'it is a better fit for the task',
  qualification: 'it has stronger benchmark evidence',
  tool_protocol: 'it has a stronger tool protocol',
  residency: 'it is already loaded in memory',
  latency: 'it is faster on benchmark runs',
  configured_default: 'it is your configured default',
  parameter_size: 'it is lighter to run',
  identity: 'it ties on every rung and wins the deterministic name order',
};

export function describeAutoWhy(input: {
  selected: LadderCandidate;
  selectedQualification: QualificationAssessment;
  ranked: readonly RankedCandidate<LadderCandidate>[];
  belowPreferredConfidence: boolean;
  toolProtocol: ToolProtocol;
  toolsRequired: boolean;
  resident: boolean;
}): string[] {
  const why = ['Compatible with the current task'];
  if (input.toolsRequired) why.push(input.toolProtocol === 'prompted' ? 'Tool use through the prompted protocol' : 'Native tool calling');
  if (input.resident) why.push('Available locally and already loaded');
  else why.push('Available locally');
  if (input.selectedQualification.meaningful && input.selectedQualification.tier === 'strong') {
    why.push(`Relevant qualification evidence (${input.selectedQualification.summary})`);
  }
  const runnerUp = input.ranked[1];
  if (runnerUp?.behindBecauseOf) {
    why.push(`Preferred over ${input.ranked.length - 1} compatible alternative${input.ranked.length - 1 === 1 ? '' : 's'}: ${RUNG_PHRASE[runnerUp.behindBecauseOf]}`);
  } else if (input.ranked.length === 1) {
    why.push('Only compatible model installed');
  }
  if (input.belowPreferredConfidence) why.push('Below the preferred reliability bar, but the best compatible model available');
  return why;
}

export function toAlternatives(ranked: readonly RankedCandidate<LadderCandidate & { qualificationSummary?: string }>[]): RoutingAlternative[] {
  return ranked.slice(0, MAX_ROUTING_ALTERNATIVES).map(item => ({
    provider: item.candidate.provider,
    model: item.candidate.model,
    rank: item.rank,
    behindBecauseOf: item.behindBecauseOf,
    qualification: item.candidate.qualificationSummary ?? 'no benchmark evidence',
  }));
}
