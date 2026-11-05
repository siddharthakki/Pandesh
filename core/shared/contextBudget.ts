/**
 * The one context-budget allocator (M45). Pure and dependency-free so both
 * Core and the extension can import it from `core/shared`.
 *
 * Budgets derive only from the frozen context window and measured sizes, never
 * from a model or vendor name. All quantities are integers; chars = tokens × 4.
 */

export const CONTEXT_CHARS_PER_TOKEN = 4;
/** Conservative window for a model nothing could resolve. Never grown because history grew. */
export const CORE_ASSUMED_CONTEXT_TOKENS = 32_768;
export const MIN_CONTEXT_TOKENS = 2_048;
export const MAX_CONTEXT_TOKENS = 1_048_576;
export const CONVERSATION_REPLAY_MAX_TOKENS = 20_000;
export const SYSTEM_PROMPT_RESERVE_TOKENS = 1_200;
export const LOOP_DELTA_MIN_CHARS = 8_000;
export const LOOP_DELTA_MAX_CHARS = 160_000;
export const MISSION_LEDGER_MIN_CHARS = 6_000;
export const MISSION_LEDGER_MAX_CHARS = 48_000;

export type ContextSurface = 'baat_kar' | 'saath_kar' | 'mission';

/**
 * Where a frozen window came from, in resolution order: explicit user
 * configuration, resolved router metadata, provider introspection, known
 * catalog metadata, then the conservative assumed default.
 */
export type ContextWindowSource =
  | 'explicit_config'
  | 'router_metadata'
  | 'provider_introspection'
  | 'catalog_metadata'
  | 'assumed_default';

export const CONTEXT_WINDOW_SOURCES: readonly ContextWindowSource[] = [
  'explicit_config',
  'router_metadata',
  'provider_introspection',
  'catalog_metadata',
  'assumed_default',
];

export interface ContextWindow {
  contextTokens: number;
  source: ContextWindowSource;
  maxOutputTokens?: number;
  /**
   * Tokens the model spends on REASONING before it emits the visible answer.
   *
   * A reasoning model ("think" mode) charges its thinking against the same
   * window as the answer. Without this reserve the budget hands the model an
   * output allowance it can spend entirely on thinking, and the visible
   * answer — the tool call — never arrives. The benchmark saw exactly that:
   * a reasoning model with a 4096-token output budget produced no tool call
   * at all.
   */
  reasoningTokens?: number;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function isContextWindowSource(value: unknown): value is ContextWindowSource {
  return typeof value === 'string' && (CONTEXT_WINDOW_SOURCES as readonly string[]).includes(value);
}

const ASSUMED_WINDOW: ContextWindow = { contextTokens: CORE_ASSUMED_CONTEXT_TOKENS, source: 'assumed_default' };

/** Clamps a labelled window into range. An absent, unlabelled or invalid one
 * becomes the assumed default rather than a guess. */
export function normalizeContextWindow(
  raw?: { contextTokens?: unknown; source?: unknown; maxOutputTokens?: unknown; reasoningTokens?: unknown },
): ContextWindow {
  const contextTokens = positiveInt(raw?.contextTokens);
  if (contextTokens === undefined || !isContextWindowSource(raw?.source)) return { ...ASSUMED_WINDOW };
  const maxOutputTokens = positiveInt(raw?.maxOutputTokens);
  const reasoningTokens = positiveInt(raw?.reasoningTokens);
  return {
    contextTokens: Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, contextTokens)),
    source: raw.source as ContextWindowSource,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * Resolves a window through the fixed precedence chain and records the source:
 * explicit configuration → resolved router metadata → provider introspection →
 * known catalog metadata → the conservative assumed default.
 *
 * An explicit value is honoured but never raised above a window the provider
 * itself reported, since asking a model for more than it has only overflows.
 */
export function resolveContextWindowChain(input: {
  explicit?: number;
  router?: number;
  provider?: number;
  catalog?: number;
  maxOutputTokens?: number;
  reasoningTokens?: number;
}): ContextWindow {
  const explicit = positiveInt(input.explicit);
  const router = positiveInt(input.router);
  const provider = positiveInt(input.provider);
  const catalog = positiveInt(input.catalog);
  let picked: { contextTokens: number; source: ContextWindowSource } | undefined;
  if (explicit !== undefined) {
    picked = { contextTokens: provider !== undefined ? Math.min(explicit, provider) : explicit, source: 'explicit_config' };
  } else if (router !== undefined) {
    picked = { contextTokens: router, source: 'router_metadata' };
  } else if (provider !== undefined) {
    picked = { contextTokens: provider, source: 'provider_introspection' };
  } else if (catalog !== undefined) {
    picked = { contextTokens: catalog, source: 'catalog_metadata' };
  }
  return normalizeContextWindow({ ...picked, maxOutputTokens: input.maxOutputTokens, reasoningTokens: input.reasoningTokens });
}

/** Output the model still has to write: an explicit allowance capped at half
 * the window, else 20% of the window bounded to [1024, 8192]. */
export function outputReserveTokens(window: ContextWindow): number {
  const ctx = window.contextTokens;
  if (window.maxOutputTokens !== undefined) return Math.min(window.maxOutputTokens, Math.floor(ctx * 0.5));
  return Math.min(8_192, Math.max(1_024, Math.floor(ctx * 0.2)));
}

/**
 * The tokens the model spends on reasoning before the visible answer.
 *
 * This is charged against the SAME window as the visible output, so it is
 * part of the generation reserve, not part of the input budget.
 */
export function reasoningReserveTokens(window: ContextWindow): number {
  const declared = window.reasoningTokens;
  if (declared !== undefined && declared > 0) return declared;
  return 0;
}

/** The whole generation reserve: what the model may spend before it answers. */
export function generationReserveTokens(window: ContextWindow): number {
  return outputReserveTokens(window) + reasoningReserveTokens(window);
}

/**
 * The tokens a reasoning model needs for its thinking phase.
 *
 * Derived from the window, never from a model NAME: a model that declares a
 * reasoning capability is assumed to spend a quarter of its window thinking,
 * bounded to [1024, 8192]. The reserve is deliberately conservative —
 * under-reserving means the model runs out of room before it emits the tool
 * call, which is worse than a slightly smaller input budget.
 */
export function reasoningReserveForReasoningModel(contextTokens: number): number {
  const ctx = positiveInt(contextTokens) ?? CORE_ASSUMED_CONTEXT_TOKENS;
  return Math.min(8_192, Math.max(1_024, Math.floor(ctx * 0.25)));
}

/** chars/4 under-counts code and chat-template overhead. */
export function safetyMarginTokens(window: ContextWindow): number {
  return Math.floor(window.contextTokens * 0.1);
}

export function usableInputTokens(window: ContextWindow): number {
  return Math.max(0, window.contextTokens - generationReserveTokens(window) - safetyMarginTokens(window));
}

export function conversationReplayCapTokens(surface: ContextSurface, window: ContextWindow): number {
  if (surface === 'mission') return 0;
  const share = surface === 'baat_kar' ? 0.3 : 0.15;
  return Math.min(CONVERSATION_REPLAY_MAX_TOKENS, Math.floor(window.contextTokens * share));
}

/** The same arithmetic as `estimatePromptTokens` in core/runtime/ollamaChatControls.ts, in characters. */
export function measurePromptChars(
  messages: ReadonlyArray<{ content: string; images?: readonly unknown[] }>,
  tools?: readonly unknown[],
): number {
  let chars = 0;
  for (const message of messages) {
    chars += message.content.length;
    if (message.images?.length) chars += message.images.length * 4_000;
  }
  if (tools?.length) chars += JSON.stringify(tools).length;
  return chars;
}

export interface AssemblyAllocation {
  surface: ContextSurface;
  window: ContextWindow;
  outputReserveTokens: number;
  /** Tokens reserved for the model's reasoning, when it declares a need. */
  reasoningReserveTokens: number;
  usableInputTokens: number;
  fixedChars: number;
  /** Characters left for replay + loop delta + ledger after the fixed parts. */
  remainingChars: number;
  conversationReplayChars: number;
  loopDeltaChars: number;
  missionLedgerChars: number;
  /** The fixed parts alone do not fit the usable input. */
  fixedOverflow: boolean;
}

/** Splits what the window leaves after the fixed parts among the variable ones. */
export function allocateContextAtAssembly(input: {
  surface: ContextSurface;
  window: ContextWindow;
  fixedChars: number;
}): AssemblyAllocation {
  const { surface, window } = input;
  const fixedChars = Math.max(0, Math.floor(input.fixedChars));
  const usable = usableInputTokens(window);
  const fixedTokens = Math.ceil(fixedChars / CONTEXT_CHARS_PER_TOKEN);
  const remainingChars = Math.max(0, usable - fixedTokens) * CONTEXT_CHARS_PER_TOKEN;
  const replayCapChars = conversationReplayCapTokens(surface, window) * CONTEXT_CHARS_PER_TOKEN;

  let conversationReplayChars = 0;
  let loopDeltaChars = 0;
  let missionLedgerChars = 0;
  if (surface === 'baat_kar') {
    conversationReplayChars = Math.min(replayCapChars, remainingChars);
  } else if (surface === 'saath_kar') {
    conversationReplayChars = Math.min(replayCapChars, Math.max(0, remainingChars - LOOP_DELTA_MIN_CHARS));
    // Capped so a continuation always stays under its 256 KiB byte limit, JSON overhead included.
    loopDeltaChars = Math.max(0, Math.min(LOOP_DELTA_MAX_CHARS, remainingChars - conversationReplayChars));
  } else {
    missionLedgerChars = Math.min(
      MISSION_LEDGER_MAX_CHARS,
      Math.max(MISSION_LEDGER_MIN_CHARS, remainingChars),
    );
  }
  return {
    surface,
    window,
    outputReserveTokens: outputReserveTokens(window),
    reasoningReserveTokens: reasoningReserveTokens(window),
    usableInputTokens: usable,
    fixedChars,
    remainingChars,
    conversationReplayChars,
    loopDeltaChars,
    missionLedgerChars,
    fixedOverflow: fixedTokens > usable,
  };
}

/* ------------------------------------------------------------------ */
/* Fit assessment                                                      */
/* ------------------------------------------------------------------ */

/** What the host may do about a request that does not fit. */
export type ContextFitAction =
  /** It fits. */
  | 'fits'
  /** Something can be compacted or reduced without losing the objective. */
  | 'reduce'
  /** Another authorized model with a bigger window could serve it. */
  | 'select_another_model'
  /** Nothing can make it fit; the host must report the limitation. */
  | 'report_limitation';

export interface ContextFitAssessment {
  action: ContextFitAction;
  /** Why the decision was made, in one line. */
  reason: string;
  /** The characters that must be shed to fit. Zero when it already fits. */
  overflowChars: number;
  /** The window that would be needed, when a bigger one could serve it. */
  requiredContextTokens?: number;
}

/**
 * Decides what to do when a request does not fit the model's window.
 *
 * The order is deliberate and it never involves a cloud model:
 *
 *   1. `reduce` — shed the eligible, compressible context (the conversation
 *      replay, the repository evidence, the loop delta). The objective and
 *      the tool surface are never shed: without them the model cannot act.
 *   2. `select_another_model` — an authorized model with a bigger window
 *      could serve the request. Only a model the host is ALREADY authorized
 *      to use counts; this function never widens authority.
 *   3. `report_limitation` — nothing can make it fit. The host says so
 *      plainly instead of sending a request that will be truncated.
 */
export function assessContextFit(input: {
  allocation: AssemblyAllocation;
  /** Characters of compressible context that may be shed. */
  reducibleChars: number;
  /** Context tokens of other models the host is already authorized to use. */
  authorizedAlternativeWindows?: readonly number[];
}): ContextFitAssessment {
  const { allocation } = input;
  if (!allocation.fixedOverflow) {
    return { action: 'fits', reason: 'the request fits the model context window', overflowChars: 0 };
  }
  const overflowChars = Math.max(0, allocation.fixedChars - allocation.remainingChars);
  if (input.reducibleChars > 0) {
    return {
      action: 'reduce',
      reason: `${overflowChars} character(s) of compressible context can be shed to fit the window`,
      overflowChars,
    };
  }
  const alternatives = (input.authorizedAlternativeWindows ?? []).filter((tokens) => tokens > allocation.window.contextTokens);
  if (alternatives.length > 0) {
    const required = Math.max(...alternatives);
    return {
      action: 'select_another_model',
      reason: `the request needs about ${Math.ceil((allocation.fixedChars / CONTEXT_CHARS_PER_TOKEN) + allocation.outputReserveTokens + allocation.reasoningReserveTokens)} tokens, and another authorized model offers ${required}`,
      overflowChars,
      requiredContextTokens: required,
    };
  }
  return {
    action: 'report_limitation',
    reason: `the request needs about ${Math.ceil((allocation.fixedChars / CONTEXT_CHARS_PER_TOKEN) + allocation.outputReserveTokens + allocation.reasoningReserveTokens)} tokens but the model's window is ${allocation.window.contextTokens} and nothing can be shed`,
    overflowChars,
  };
}
