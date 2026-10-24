import { REPOSITORY_CONTEXT_MAX_PROMPT_CHARS } from '../../core/shared/wireTypes';
import {
  CONTEXT_CHARS_PER_TOKEN,
  SYSTEM_PROMPT_RESERVE_TOKENS,
  normalizeContextWindow,
  usableInputTokens,
  type ContextWindow,
} from '../../core/shared/contextBudget';

/**
 * M46 execution economy: how much work, context and parallelism a model can be
 * trusted with. It is a policy seam, not a scheduler: a pure function from
 * evidence about the model and the machine to a small set of limits that the
 * Context Compiler and the subgoal planner read.
 *
 * The codebase already has `ExecutionProfile` (`classifyExecutionProfile`), which
 * classifies the *task*. This one describes the *model + machine*, so it has a
 * different name and takes the task profile only as an input.
 *
 * Rules:
 *  - No model or vendor names. Size is accepted only as numeric evidence.
 *  - Evidence can lower the tier, never raise it past what the window supports.
 *  - Governance, approvals and recovery are never a function of the tier.
 */

export type EconomyTier = 'constrained' | 'standard' | 'capable';
export type EconomyReliability = 'low' | 'normal' | 'high';
export type EconomyComplexity = 'trivial' | 'standard' | 'complex';

export interface EconomyInputs {
  /** The M45 frozen window. Absent or unlabelled means unresolved. */
  contextWindow?: { contextTokens?: number; source?: string; maxOutputTokens?: number };
  /** Parameter count in billions when a caller has it as evidence (never derived from a family name here). */
  parameterBillions?: number;
  /** Observed structured-output/tool reliability of this model on this task (for example repeated format failures). */
  reliability?: EconomyReliability;
  /** Sustained resource pressure reported by machine telemetry. */
  resourcePressure?: boolean;
  /** Task complexity from `classifyExecutionProfile`, when known. */
  taskComplexity?: EconomyComplexity;
}

export interface PackPolicy {
  /** Hard character ceiling for one Context Pack. */
  maxChars: number;
  maxFiles: number;
  /** Largest excerpt of a single file. */
  maxSnippetChars: number;
  maxObservations: number;
  maxFailures: number;
  /** Recent raw interaction is included only when there is room, capped here. */
  recentInteractionChars: number;
}

export interface SubgoalPolicy {
  /** Files one subgoal may ask the model to read/change. */
  maxFiles: number;
  /** Fragment a non-trivial objective into bounded subgoals. */
  fragment: boolean;
}

export interface ExecutionEconomyProfile {
  tier: EconomyTier;
  /** Why the tier is what it is, in evidence order. Observable, never used for control flow. */
  reasons: string[];
  window: ContextWindow;
  pack: PackPolicy;
  subgoal: SubgoalPolicy;
  execution: {
    serializeTools: boolean;
    aggressivePruning: boolean;
    /** Prefer deterministic verification (run the check) over asking the model whether it worked. */
    deterministicVerificationFirst: boolean;
  };
  /** Constant by construction: a strong model does not switch these off. */
  governance: { approvals: true; recovery: true };
}

const TIERS: readonly EconomyTier[] = ['constrained', 'standard', 'capable'];
const CONSTRAINED_BELOW_TOKENS = 16_384;
const CAPABLE_AT_TOKENS = 98_304;
/** A model at or below this size is treated as laptop class regardless of its window. */
const SMALL_MODEL_BILLIONS = 8;
export const PACK_MIN_CHARS = 1_200;
/** Kept under Core's shared prompt validator, the same ceiling `RepositoryContextBudget` uses. */
export const PACK_HARD_MAX_CHARS = Math.floor(REPOSITORY_CONTEXT_MAX_PROMPT_CHARS * 0.96);

interface TierShape {
  share: number;
  maxChars: number;
  pack: Omit<PackPolicy, 'maxChars'>;
  subgoal: SubgoalPolicy;
  execution: ExecutionEconomyProfile['execution'];
}

const SHAPES: Record<EconomyTier, TierShape> = {
  constrained: {
    share: 0.4,
    maxChars: 16_000,
    pack: { maxFiles: 4, maxSnippetChars: 2_400, maxObservations: 4, maxFailures: 2, recentInteractionChars: 1_200 },
    subgoal: { maxFiles: 3, fragment: true },
    execution: { serializeTools: true, aggressivePruning: true, deterministicVerificationFirst: true },
  },
  standard: {
    share: 0.5,
    maxChars: 48_000,
    pack: { maxFiles: 8, maxSnippetChars: 6_000, maxObservations: 8, maxFailures: 4, recentInteractionChars: 4_000 },
    subgoal: { maxFiles: 6, fragment: false },
    execution: { serializeTools: false, aggressivePruning: false, deterministicVerificationFirst: true },
  },
  capable: {
    share: 0.5,
    maxChars: PACK_HARD_MAX_CHARS,
    pack: { maxFiles: 16, maxSnippetChars: 16_000, maxObservations: 16, maxFailures: 6, recentInteractionChars: 12_000 },
    subgoal: { maxFiles: 12, fragment: false },
    execution: { serializeTools: false, aggressivePruning: false, deterministicVerificationFirst: false },
  },
};

function baseTier(window: ContextWindow): { tier: EconomyTier; reason: string } {
  if (window.source === 'assumed_default') {
    return { tier: 'constrained', reason: 'context window unresolved; assuming a constrained model' };
  }
  if (window.contextTokens < CONSTRAINED_BELOW_TOKENS) {
    return { tier: 'constrained', reason: `context window ${window.contextTokens} tokens is small` };
  }
  if (window.contextTokens >= CAPABLE_AT_TOKENS) {
    return { tier: 'capable', reason: `context window ${window.contextTokens} tokens is large` };
  }
  return { tier: 'standard', reason: `context window ${window.contextTokens} tokens is moderate` };
}

function lowered(tier: EconomyTier): EconomyTier {
  return TIERS[Math.max(0, TIERS.indexOf(tier) - 1)];
}

/**
 * Characters one Context Pack may occupy: a tier share of what the M45
 * allocator leaves for input, less the fixed system-prompt reserve, clamped to
 * the tier ceiling and the Core-safe hard maximum.
 */
export function packBudgetChars(window: ContextWindow, tier: EconomyTier, complexity?: EconomyComplexity): number {
  const shape = SHAPES[tier];
  const usable = Math.max(0, usableInputTokens(window) - SYSTEM_PROMPT_RESERVE_TOKENS);
  let chars = Math.floor(usable * shape.share * CONTEXT_CHARS_PER_TOKEN);
  if (complexity === 'trivial') chars = Math.floor(chars / 2);
  return Math.max(PACK_MIN_CHARS, Math.min(chars, shape.maxChars, PACK_HARD_MAX_CHARS));
}

export function deriveExecutionEconomy(inputs: EconomyInputs = {}): ExecutionEconomyProfile {
  const window = normalizeContextWindow(inputs.contextWindow);
  const reasons: string[] = [];
  const base = baseTier(window);
  let tier = base.tier;
  reasons.push(base.reason);

  const size = inputs.parameterBillions;
  if (typeof size === 'number' && Number.isFinite(size) && size > 0 && size <= SMALL_MODEL_BILLIONS) {
    const next = lowered(tier);
    if (next !== tier) reasons.push(`model size ${size}B is laptop class; lowered to ${next}`);
    tier = next;
  }
  if (inputs.reliability === 'low') {
    const next = lowered(tier);
    if (next !== tier) reasons.push(`observed reliability is low; lowered to ${next}`);
    tier = next;
  }
  if (inputs.resourcePressure) {
    const next = lowered(tier);
    if (next !== tier) reasons.push(`sustained resource pressure; lowered to ${next}`);
    tier = next;
  }

  const shape = SHAPES[tier];
  const maxChars = packBudgetChars(window, tier, inputs.taskComplexity);
  // The ceiling shrinks the pack only; a small window can also shrink counts below the tier default.
  const scale = Math.min(1, maxChars / shape.maxChars);
  const pack: PackPolicy = {
    maxChars,
    maxFiles: Math.max(1, Math.min(shape.pack.maxFiles, Math.ceil(shape.pack.maxFiles * Math.max(scale, 0.5)))),
    maxSnippetChars: Math.max(600, Math.min(shape.pack.maxSnippetChars, Math.floor(maxChars / 3))),
    maxObservations: shape.pack.maxObservations,
    maxFailures: shape.pack.maxFailures,
    recentInteractionChars: Math.min(shape.pack.recentInteractionChars, Math.floor(maxChars / 8)),
  };
  return {
    tier,
    reasons,
    window,
    pack,
    subgoal: {
      maxFiles: shape.subgoal.maxFiles,
      // A complex task on a standard model is fragmented too; a strong model is not, unless it keeps failing.
      fragment: shape.subgoal.fragment || (tier === 'standard' && inputs.taskComplexity === 'complex'),
    },
    execution: { ...shape.execution, aggressivePruning: shape.execution.aggressivePruning || inputs.resourcePressure === true },
    governance: { approvals: true, recovery: true },
  };
}
