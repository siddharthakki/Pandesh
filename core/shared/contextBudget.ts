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
  raw?: { contextTokens?: unknown; source?: unknown; maxOutputTokens?: unknown },
): ContextWindow {
  const contextTokens = positiveInt(raw?.contextTokens);
  if (contextTokens === undefined || !isContextWindowSource(raw?.source)) return { ...ASSUMED_WINDOW };
  const maxOutputTokens = positiveInt(raw?.maxOutputTokens);
  return {
    contextTokens: Math.min(MAX_CONTEXT_TOKENS, Math.max(MIN_CONTEXT_TOKENS, contextTokens)),
    source: raw.source as ContextWindowSource,
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
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
  return normalizeContextWindow({ ...picked, maxOutputTokens: input.maxOutputTokens });
}

/** Output the model still has to write: an explicit allowance capped at half
 * the window, else 20% of the window bounded to [1024, 8192]. */
export function outputReserveTokens(window: ContextWindow): number {
  const ctx = window.contextTokens;
  if (window.maxOutputTokens !== undefined) return Math.min(window.maxOutputTokens, Math.floor(ctx * 0.5));
  return Math.min(8_192, Math.max(1_024, Math.floor(ctx * 0.2)));
}

/** chars/4 under-counts code and chat-template overhead. */
export function safetyMarginTokens(window: ContextWindow): number {
  return Math.floor(window.contextTokens * 0.1);
}

export function usableInputTokens(window: ContextWindow): number {
  return Math.max(0, window.contextTokens - outputReserveTokens(window) - safetyMarginTokens(window));
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
    usableInputTokens: usable,
    fixedChars,
    remainingChars,
    conversationReplayChars,
    loopDeltaChars,
    missionLedgerChars,
    fixedOverflow: fixedTokens > usable,
  };
}
