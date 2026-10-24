/**
 * M45 Tier 1 — deterministic prune of the in-flight Saath loop delta.
 *
 * Ported by algorithm (not code) from OpenCode's tool-output prune: a protected
 * recent window, a stub that keeps call identity, and hysteresis so the prompt
 * prefix (and Ollama's KV cache) is not invalidated on every turn. It only ever
 * rewrites the *in-memory / continuation* delta; the durable transcript and
 * evidence rows are never touched (invariant I1).
 *
 * Pure: no I/O, no clock, no model. Message count and order never change, so
 * delta-relative indices stay valid across a compaction.
 */
import type { ModelChatMessage } from './modelBackend';

/** The newest messages up to this share of the budget are never compacted. */
export const LOOP_DELTA_PROTECT_RATIO = 0.4;
/** A prune clears oldest-first until the delta is at most this share of the budget. */
export const LOOP_DELTA_TARGET_RATIO = 0.75;
/** A prune that would gain less than this share of the budget is not worth a cache invalidation. */
export const LOOP_DELTA_MIN_GAIN_RATIO = 0.2;
export const ASSISTANT_CONTENT_KEEP_CHARS = 600;
export const CLEARED_BODY_MARKER = '(result body cleared from active context';
export const ASSISTANT_TRUNCATION_MARKER = '…[earlier assistant text truncated]';

/** Invariant I4: these tool messages are never compacted. */
const PROTECTED_PREFIXES = ['[validation]', 'STRATEGY_CHANGE', 'DECISION_REQUIRED'] as const;
const DENIED_NOTE = /^\[[^\]]+\] DENIED/;

export interface LoopDeltaCompaction {
  delta: ModelChatMessage[];
  /** Operation keys whose result body was cleared by this pass. */
  clearedKeys: string[];
  clearedBodies: number;
  truncatedAssistant: number;
  beforeChars: number;
  afterChars: number;
  /** The delta is within budget after compaction. When false the caller must fail closed. */
  fits: boolean;
}

export function deltaChars(delta: readonly ModelChatMessage[]): number {
  let chars = 0;
  for (const message of delta) chars += message.content.length;
  return chars;
}

export function isProtectedNote(message: ModelChatMessage): boolean {
  if (message.role !== 'tool') return false;
  return PROTECTED_PREFIXES.some((prefix) => message.content.startsWith(prefix)) || DENIED_NOTE.test(message.content);
}

function isCleared(message: ModelChatMessage): boolean {
  return message.content.includes(CLEARED_BODY_MARKER);
}

/** `[read_file] exit=0\n…` → `read_file`; anything else → `tool`. */
function toolNameOf(content: string): string {
  const match = /^\[([^\]]+)\]/.exec(content);
  return match ? match[1] : 'tool';
}

export function clearedBodyStub(content: string): string {
  return `[${toolNameOf(content)}] ${CLEARED_BODY_MARKER} — ${content.length} chars; evidence retained by Core. Repeat the identical call if you need it again; that is not counted as repetition.)`;
}

/**
 * Whether a prune is worth doing. Over budget or forced always is (skipping a
 * needed prune would fail an attempt that can be saved); otherwise the gain must
 * clear the minimum, so a marginal saving never costs a cache invalidation.
 */
export function worthPruning(input: { gainChars: number; budgetChars: number; overBudget: boolean; force: boolean }): boolean {
  return input.overBudget || input.force || input.gainChars >= input.budgetChars * LOOP_DELTA_MIN_GAIN_RATIO;
}

export function compactLoopDelta(input: {
  delta: readonly ModelChatMessage[];
  budgetChars: number;
  /** Delta-relative index → the operation key of a clearable (read-only) tool result. */
  toolMessageKeys: ReadonlyMap<number, string>;
  /** Prune even within budget (the prompt calibration just rose). */
  force?: boolean;
  /** M53: results whose bodies hold high-value evidence (pack files, explicit targets); they are cleared only after every other body. */
  pinnedKeys?: ReadonlySet<string>;
  /** M53: last resort only — also clear the newest results, which are otherwise always kept. */
  clearNewest?: boolean;
}): LoopDeltaCompaction {
  const budget = Math.max(0, Math.floor(input.budgetChars));
  const messages = input.delta.map((message) => ({ ...message }));
  const beforeChars = deltaChars(messages);
  const unchanged = (): LoopDeltaCompaction => ({
    delta: messages, clearedKeys: [], clearedBodies: 0, truncatedAssistant: 0,
    beforeChars, afterChars: beforeChars, fits: beforeChars <= budget,
  });
  const overBudget = beforeChars > budget;
  if (!overBudget && !input.force) return unchanged();

  // Protected: the newest messages up to 40% of the budget, and always
  // everything after the last assistant message (the latest turn's results).
  const protectedIndexes = new Set<number>();
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'assistant') { lastAssistant = i; break; }
  }
  if (input.clearNewest !== true) {
    for (let i = lastAssistant + 1; i < messages.length; i += 1) protectedIndexes.add(i);
    const protectLimit = budget * LOOP_DELTA_PROTECT_RATIO;
    let recent = 0;
    for (let i = messages.length - 1; i >= 0 && recent < protectLimit; i -= 1) {
      protectedIndexes.add(i);
      recent += messages[i].content.length;
    }
  }

  const clearable: Array<{ index: number; gain: number }> = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (protectedIndexes.has(i) || !input.toolMessageKeys.has(i)) continue;
    if (message.role !== 'tool' || isProtectedNote(message) || isCleared(message)) continue;
    const gain = message.content.length - clearedBodyStub(message.content).length;
    if (gain > 0) clearable.push({ index: i, gain });
  }
  // Pinned evidence goes last: oldest-first within each group, so other bodies are cleared before a pinned one.
  if (input.pinnedKeys && input.pinnedKeys.size > 0) {
    const pinned = (index: number) => input.pinnedKeys!.has(input.toolMessageKeys.get(index) ?? '');
    clearable.sort((a, b) => Number(pinned(a.index)) - Number(pinned(b.index)) || a.index - b.index);
  }
  const gainChars = clearable.reduce((sum, item) => sum + item.gain, 0);

  const clearedKeys: string[] = [];
  let clearedBodies = 0;
  let truncatedAssistant = 0;
  let chars = beforeChars;
  if (worthPruning({ gainChars, budgetChars: budget, overBudget, force: input.force === true })) {
    const target = budget * LOOP_DELTA_TARGET_RATIO;
    for (const item of clearable) {
      if (chars <= target) break;
      const message = messages[item.index];
      const key = input.toolMessageKeys.get(item.index)!;
      const stub = clearedBodyStub(message.content);
      chars -= message.content.length - stub.length;
      messages[item.index] = { ...message, content: stub };
      clearedBodies += 1;
      if (!clearedKeys.includes(key)) clearedKeys.push(key);
    }
  }

  // Still over budget: shorten older, unprotected assistant text.
  if (chars > budget) {
    for (let i = 0; i < messages.length && chars > budget; i += 1) {
      const message = messages[i];
      if (message.role !== 'assistant' || protectedIndexes.has(i)) continue;
      if (message.content.length <= ASSISTANT_CONTENT_KEEP_CHARS + ASSISTANT_TRUNCATION_MARKER.length) continue;
      if (message.content.endsWith(ASSISTANT_TRUNCATION_MARKER)) continue;
      const shortened = `${message.content.slice(0, ASSISTANT_CONTENT_KEEP_CHARS)}${ASSISTANT_TRUNCATION_MARKER}`;
      chars -= message.content.length - shortened.length;
      messages[i] = { ...message, content: shortened };
      truncatedAssistant += 1;
    }
  }

  const afterChars = deltaChars(messages);
  return { delta: messages, clearedKeys, clearedBodies, truncatedAssistant, beforeChars, afterChars, fits: afterChars <= budget };
}

/** In-flight compaction cursor for one attempt, persisted with each continuation. */
export interface LoopCompactionState {
  /** Measured prompt tokens ÷ estimate, only ever raised, capped at 2. */
  promptCalibration: number;
  /** Delta-relative message index → operation key, for clearable (read-only) results. */
  toolMessageKeys: Map<number, string>;
  /** The calibration just rose: prune once even within budget. */
  forcePrune: boolean;
}

/** The compaction fields of a continuation payload. */
export function compactionPayload(state: LoopCompactionState): {
  toolMessageKeys: Array<[number, string]>;
  promptCalibration: number;
} {
  return { toolMessageKeys: [...state.toolMessageKeys], promptCalibration: state.promptCalibration };
}
