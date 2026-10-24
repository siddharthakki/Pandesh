/**
 * M45 — progress-aware duplicate / no-progress policy for one Saath Kar attempt.
 *
 * A duplicate call is not a failure. Progress or its absence is authoritative,
 * with the semantics the mission loop already has (`missionProgress.ts`): a
 * repeat is judged against the workspace revision it was made at, a cached
 * return does not count as a repeat of anything new, and a turn that also made
 * new reads is a progress turn.
 *
 * Pure: no I/O, no clock. The executor owns the `priorOperations` map, the
 * continuation payload and every side effect; this module only decides.
 */

/** One entry of the executor's `priorOperations` map, plus M45's optional fields. */
export interface PriorOperation {
  signature: string;
  resultCategory: string;
  evidenceHash: string;
  repeats: number;
  /** Workspace revision AFTER this call executed. Absent reads as 0. */
  revision?: number;
  /** The result body was cleared from active context (loop-delta compaction). */
  bodyCleared?: boolean;
  /** How many times a cleared body has been re-fetched. */
  rehydrations?: number;
  /** The result was admitted only as a bounded projection (fresh-result compaction); re-running it would return the same body. */
  bodyProjected?: boolean;
  /** The call mutates (or may mutate) state. */
  mutating?: boolean;
}

import type { ReadEvidenceState } from './readEvidence';

export interface LoopProgressState {
  /** Increments when a mutating workspace call executed successfully. */
  revision: number;
  /** Consecutive turns that made no progress. */
  nonProgressTurns: number;
  /** Completion gate (completionGate.ts): approved propose_* mutations that actually landed. Absent reads as 0. */
  appliedMutations?: number;
  /** Completion gate: workspace-relative path -> revision at which a whole-file read succeeded. */
  fullReads?: Record<string, number>;
  /** Completion gate: discovery commands (dir/findstr/grep...) run so far. */
  discoveryCommands?: number;
  /** Completion gate: exploration calls refused as redundant after the objective was satisfied. */
  refusedExploration?: number;
  /** M53: per-file delivered line ranges bound to the file's content fingerprint (readEvidence.ts). */
  readEvidence?: ReadEvidenceState;
  /** M55: read/search calls since the last write-class action (copy, edit, validation). Bounds pre-write exploration. */
  explorationCalls?: number;
  /** M55: how many of those were wide (budgeted) rather than a first look at a file or a bounded/targeted read. */
  explorationSpent?: number;
  /** M55: normalized files already read in this stretch (a first read of a new file is free). */
  explorationPaths?: string[];
  /** M55: the one-time exploration STRATEGY_CHANGE was already sent. */
  explorationNudged?: boolean;
  /** M53: set after a last-resort compaction; reads are then limited to this many lines at a time. */
  narrowReadLines?: number;
  /** M53: normalized paths whose read bodies are cleared last by compaction (pack files, explicit targets). */
  pinnedPaths?: string[];
  /** M53: the seed pass over the host pack already ran for this attempt. */
  packSeeded?: boolean;
}

export const INITIAL_LOOP_PROGRESS: LoopProgressState = Object.freeze({ revision: 0, nonProgressTurns: 0 });

export const NON_PROGRESS_STRATEGY_TURN = 1;
export const NON_PROGRESS_DECISION_TURN = 2;
export const NON_PROGRESS_STOP_TURN = 3;

/** Workspace tools whose successful execution changes the workspace. */
export const REVISION_BUMPING_TOOLS: ReadonlySet<string> = new Set(['propose_file_change', 'propose_text_edit', 'run_command']);

export type CallVerdict = 'execute' | 'rehydrate' | 'cached';
export type CallObservation = 'progress' | 'neutral' | 'non_progress';

export interface CallClassification {
  verdict: CallVerdict;
  observation: CallObservation;
}

/** Judges one call against the operation it repeats, if any, at the current revision. */
export function classifyCall(input: {
  prior: PriorOperation | undefined;
  mutating: boolean;
  revision: number;
}): CallClassification {
  const { prior, mutating, revision } = input;
  if (!prior) return { verdict: 'execute', observation: 'progress' };
  const priorRevision = prior.revision ?? 0;
  if (mutating) {
    return priorRevision === revision
      ? { verdict: 'cached', observation: 'non_progress' }
      : { verdict: 'execute', observation: 'progress' };
  }
  if (priorRevision !== revision) return { verdict: 'execute', observation: 'progress' };
  if (prior.bodyCleared === true && (prior.rehydrations ?? 0) < 1) {
    return { verdict: 'rehydrate', observation: 'neutral' };
  }
  return { verdict: 'cached', observation: 'non_progress' };
}

export function noteRevisionBump(state: LoopProgressState): LoopProgressState {
  return { revision: state.revision + 1, nonProgressTurns: 0 };
}

export interface TurnObservations {
  progress: number;
  neutral: number;
  nonProgress: number;
}

export type TurnAction = 'none' | 'strategy_change' | 'decision_required' | 'stop';

/** Folds one finished turn into the running state and says what the loop must do about it. */
export function closeTurn(
  state: LoopProgressState,
  turn: TurnObservations,
): { state: LoopProgressState; action: TurnAction } {
  if (turn.progress > 0) return { state: { ...state, nonProgressTurns: 0 }, action: 'none' };
  if (turn.nonProgress === 0) return { state, action: 'none' };
  const nonProgressTurns = state.nonProgressTurns + 1;
  const next = { ...state, nonProgressTurns };
  if (nonProgressTurns >= NON_PROGRESS_STOP_TURN) return { state: next, action: 'stop' };
  if (nonProgressTurns === NON_PROGRESS_DECISION_TURN) return { state: next, action: 'decision_required' };
  return { state: next, action: 'strategy_change' };
}

/** The tool message that answers a call that was not run again. */
export function cachedCallMessage(input: { toolName: string; mutating: boolean; resultCategory: string; bodyCleared?: boolean; bodyProjected?: boolean }): string {
  // A compacted result is a partial view: repeating it returns the same view, so redirect to a narrower call.
  if (input.bodyProjected && !input.mutating && !input.bodyCleared) {
    return `[${input.toolName}] UNCHANGED — this identical call already returned its result (${input.resultCategory}), but it was shown only in part (compacted to fit the context window; the full output is retained by Core). Repeating it returns the same partial view. Request the omitted part instead: read_file with startLine/endLine for a specific range, or a narrower call.`;
  }
  // A body that was cleared from context and already re-fetched once is not
  // there to point back to; say so rather than send the model looking for it.
  if (input.bodyCleared && !input.mutating) {
    return `[${input.toolName}] UNCHANGED — this identical call already returned its result (${input.resultCategory}), but that body was cleared from context to save space and was already re-fetched once. Do not repeat it: read a different range or file, or answer with the evidence you have.`;
  }
  return input.mutating
    ? `[${input.toolName}] NOT REPEATED — this identical action was already handled at the current workspace state (${input.resultCategory}). Its earlier outcome above still stands; do not submit it again.`
    : `[${input.toolName}] UNCHANGED — this identical call already returned its result earlier in this attempt and nothing in the workspace has changed since (${input.resultCategory}). The earlier result above is still current; do not repeat it.`;
}

export function strategyChangeMessage(input: {
  failedOperation: string;
  signature: string;
  resultCategory: string;
  modelEscalated: boolean;
}): string {
  return `STRATEGY_CHANGE ${JSON.stringify({
    message: 'The current approach was not making progress. Try a different strategy.',
    failedOperation: input.failedOperation,
    signature: input.signature,
    resultCategory: input.resultCategory,
    modelEscalated: input.modelEscalated,
  })}`;
}

export function decisionRequiredMessage(): string {
  return `DECISION_REQUIRED ${JSON.stringify({
    message: 'Repeated calls returned nothing new. Do not repeat them. Answer with the evidence you have, propose a change, or explain what information is missing.',
  })}`;
}

export function nonProgressStopReason(toolName: string): string {
  return `blocked after repeated non-progress for ${toolName}; choose a different target or add guidance`;
}
