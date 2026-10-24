import type { CoreDatabase } from '../db/connection';
import { recordRuntimeEvent } from '../domain/runtimeEvents';
import { normalizeContextWindow, type ContextSurface, type ContextWindow } from '../shared/contextBudget';
import type { AttemptContextRecord, RuntimeEventRecord } from '../shared/wireTypes';

export const CONTEXT_COMPACTED_EVENT = 'context_compacted';

export type ContextCompactionTier = 'replay' | 'loop_delta' | 'fresh_result' | 'mission_ledger';

/**
 * The window frozen into this attempt's model selection, with its recorded
 * source. Absent or invalid evidence yields the conservative assumed default,
 * and is labelled as such rather than guessed: the window is frozen, never
 * re-resolved at execution, so a resume rebuilds a byte-identical base.
 */
export function contextWindowForAttempt(context: AttemptContextRecord): ContextWindow {
  const selection = context.modelSelection;
  return normalizeContextWindow({
    contextTokens: selection?.contextWindowTokens,
    source: selection?.contextWindowSource,
    maxOutputTokens: selection?.maxOutputTokens,
  });
}

export interface ContextCompactedInput {
  attemptId: string;
  surface: ContextSurface;
  tier: ContextCompactionTier;
  window: ContextWindow;
  beforeChars: number;
  afterChars: number;
  budgetChars: number;
  clearedBodies?: number;
  truncatedAssistant?: number;
  replayOmitted?: number;
  promptCalibration?: number;
  /** Tier-specific, already-bounded evidence (e.g. which fresh results were compacted). */
  detail?: Record<string, unknown>;
}

/** One bounded `context_compacted` event, recorded only when something was omitted or cleared. */
export function emitContextCompacted(
  db: CoreDatabase,
  actor: string,
  input: ContextCompactedInput,
): RuntimeEventRecord {
  return recordRuntimeEvent(db, {
    domain: 'attempt',
    entityId: input.attemptId,
    eventType: CONTEXT_COMPACTED_EVENT,
    actor,
    metadata: {
      attemptId: input.attemptId,
      surface: input.surface,
      tier: input.tier,
      windowTokens: input.window.contextTokens,
      windowSource: input.window.source,
      beforeChars: input.beforeChars,
      afterChars: input.afterChars,
      budgetChars: input.budgetChars,
      clearedBodies: input.clearedBodies ?? 0,
      truncatedAssistant: input.truncatedAssistant ?? 0,
      replayOmitted: input.replayOmitted ?? 0,
      promptCalibration: input.promptCalibration ?? 1,
      ...(input.detail ? { detail: input.detail } : {}),
    },
    resultingRevision: null,
  });
}
