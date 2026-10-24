import { JournalState } from '../autonomous/recovery/AttemptJournal';
import { MissionModelRoutingEntry } from './MissionCheckpoint';

/**
 * Reads `modelRoutingHistory` straight out of `AttemptJournal`'s already-
 * folded `JournalState` — every `CHANGE_MODEL` decision already carries the
 * chosen model and the reason (`RecoveryDecision.directives.model`,
 * `.reason`). No new tracking is introduced; this only reshapes what the
 * journal already recorded into the mission checkpoint's aggregate shape.
 */
export function deriveModelRoutingHistory(state: Pick<JournalState, 'decisions'>): MissionModelRoutingEntry[] {
  return state.decisions
    .filter(decision => decision.action === 'CHANGE_MODEL' && decision.directives.model)
    .map(decision => ({
      at: decision.decidedAt,
      model: decision.directives.model!,
      reason: decision.reason,
    }));
}

/**
 * Reads `failedApproaches` out of the journal's terminal-stop decisions
 * (every stop that is not a clean `COMPLETE`) — the same decisions the M42
 * recovery loop already persists, just summarized for mission-level memory.
 */
export function deriveFailedApproaches(state: Pick<JournalState, 'decisions'>): string[] {
  return state.decisions
    .filter(decision => decision.terminalState && decision.terminalState !== 'COMPLETE')
    .map(decision => `${decision.cause ?? 'unknown'}: ${decision.reason}`);
}
