import {
  REPOSITORY_CONTEXT_MAX_PROMPT_CHARS,
} from '../../core/shared/wireTypes';
import {
  CONTEXT_CHARS_PER_TOKEN,
  SYSTEM_PROMPT_RESERVE_TOKENS,
  conversationReplayCapTokens,
  outputReserveTokens,
  safetyMarginTokens,
  type ContextWindow,
} from '../../core/shared/contextBudget';
import type { ProviderType } from '../providers/ProviderTypes';
import { explicitContextWindowOverride, resolveModelContextLimit } from '../reliability/ModelDispatchPlanner';

/**
 * Plans how much of the selected model's context window the automatically
 * selected repository context may occupy.
 *
 * The repository package is one of several things that share the window: the
 * system prompt, the user's objective, the conversation Core replays, tool
 * definitions (Saath Kar), and the output the model still has to write. Each
 * is reserved first; the repository builder only gets what remains, and never
 * more than a hard ceiling kept below Core's validator limit. The budget is
 * derived from the resolved model window, never from a model or vendor name.
 */

/** Same 4 chars/token heuristic as TokenBudget and Core's estimatePromptTokens. */
export const REPOSITORY_CONTEXT_CHARS_PER_TOKEN = CONTEXT_CHARS_PER_TOKEN;
/** Conservative density used only to convert the repository token budget into characters. */
export const REPOSITORY_CONTEXT_BUDGET_CHARS_PER_TOKEN = 3;

/**
 * Builder-side ceiling. Held under Core's validator limit so a package this
 * side produces always validates, whatever small framing is added later.
 */
export const REPOSITORY_CONTEXT_HARD_MAX_CHARS = Math.floor(REPOSITORY_CONTEXT_MAX_PROMPT_CHARS * 0.96);

/**
 * Floor for a very small window: enough for a repository overview and one
 * short excerpt, so a small model still gets bounded evidence rather than none.
 */
export const REPOSITORY_CONTEXT_MIN_CHARS = 1_200;

/** Window assumed when neither the capability registry nor the user knows one. */
const FALLBACK_CONTEXT_TOKENS = 8_192;

export interface RepositoryContextReservations {
  systemPrompt: number;
  objective: number;
  conversation: number;
  toolDefinitions: number;
  output: number;
  safetyMargin: number;
}

export interface RepositoryContextBudget {
  /** Effective model context window in tokens. */
  modelContext: number;
  /** Sum of every reservation below. */
  reservedTokens: number;
  reservations: RepositoryContextReservations;
  /** Tokens left for repository context after reservations. */
  budgetTokens: number;
  /** Characters the repository builder may emit (the binding limit). */
  budgetChars: number;
  hardMaxChars: number;
  /** Which constraint set budgetChars. */
  limitedBy: 'model_context' | 'hard_max' | 'minimum_floor';
}

export interface RepositoryContextBudgetInput {
  modelContextTokens: number;
  objective: string;
  /** True when the turn sends tool definitions (Saath Kar). */
  toolsEnabled?: boolean;
  /** Which surface's conversation replay to reserve; Core replays a larger share for Baat Kar. */
  surface?: 'baat_kar' | 'saath_kar';
  /** Explicit output allowance; defaults to a share of the window. */
  outputTokens?: number;
  systemPromptTokens?: number;
  conversationTokens?: number;
  toolDefinitionTokens?: number;
  hardMaxChars?: number;
}

function positiveInt(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

export function planRepositoryContextBudget(input: RepositoryContextBudgetInput): RepositoryContextBudget {
  const modelContext = positiveInt(input.modelContextTokens) ?? FALLBACK_CONTEXT_TOKENS;
  const explicitOutput = positiveInt(input.outputTokens);
  const window: ContextWindow = {
    contextTokens: modelContext,
    source: 'router_metadata',
    ...(explicitOutput !== undefined ? { maxOutputTokens: explicitOutput } : {}),
  };
  const hardMaxChars = Math.min(
    REPOSITORY_CONTEXT_HARD_MAX_CHARS,
    positiveInt(input.hardMaxChars) ?? REPOSITORY_CONTEXT_HARD_MAX_CHARS,
  );
  const reservations: RepositoryContextReservations = {
    systemPrompt: positiveInt(input.systemPromptTokens) ?? SYSTEM_PROMPT_RESERVE_TOKENS,
    objective: Math.ceil(input.objective.length / REPOSITORY_CONTEXT_CHARS_PER_TOKEN) + 64,
    conversation: input.conversationTokens !== undefined
      ? Math.max(0, Math.floor(input.conversationTokens))
      : conversationReplayCapTokens(input.surface ?? 'saath_kar', window),
    toolDefinitions: input.toolDefinitionTokens !== undefined
      ? Math.max(0, Math.floor(input.toolDefinitionTokens))
      // Real tool-definition JSON is several thousand tokens; never reserve less than that on a small window.
      : input.toolsEnabled ? Math.min(Math.floor(modelContext * 0.25), Math.min(6_000, Math.max(3_000, Math.floor(modelContext * 0.1)))) : 0,
    output: outputReserveTokens(window),
    safetyMargin: safetyMarginTokens(window),
  };
  const reservedTokens = Object.values(reservations).reduce((sum, value) => sum + value, 0);
  const budgetTokens = Math.max(0, modelContext - reservedTokens);
  // Code and chat-template overhead tokenize denser than 4 chars/token, so the repository package is sized in
  // tokens at a conservative 3 chars/token; the character count is never compared to a token count directly.
  const fromModel = budgetTokens * REPOSITORY_CONTEXT_BUDGET_CHARS_PER_TOKEN;

  let budgetChars: number;
  let limitedBy: RepositoryContextBudget['limitedBy'];
  if (fromModel > hardMaxChars) {
    budgetChars = hardMaxChars;
    limitedBy = 'hard_max';
  } else if (fromModel < REPOSITORY_CONTEXT_MIN_CHARS) {
    budgetChars = Math.min(REPOSITORY_CONTEXT_MIN_CHARS, hardMaxChars);
    limitedBy = 'minimum_floor';
  } else {
    budgetChars = fromModel;
    limitedBy = 'model_context';
  }
  return { modelContext, reservedTokens, reservations, budgetTokens, budgetChars, hardMaxChars, limitedBy };
}

/**
 * Plans the repository budget against the window the selected model will
 * actually be dispatched with (`resolveModelContextLimit`, the same
 * resolution the model-selection gate and dispatch use).
 */
export function planRepositoryContextBudgetForModel(input: {
  model: string;
  providerType?: string;
  objective: string;
  toolsEnabled?: boolean;
  surface?: 'baat_kar' | 'saath_kar';
  /** Explicit output allowance, when the user configured one. */
  maxOutputTokens?: number;
}): RepositoryContextBudget {
  const providerType: ProviderType = input.providerType === 'openai-compatible' ? 'openai-compatible' : 'ollama';
  const limit = resolveModelContextLimit({
    model: input.model,
    providerType,
    userOverride: explicitContextWindowOverride(),
  });
  return planRepositoryContextBudget({
    modelContextTokens: limit.effectiveLimit,
    objective: input.objective,
    toolsEnabled: input.toolsEnabled,
    surface: input.surface,
    outputTokens: input.maxOutputTokens,
  });
}
