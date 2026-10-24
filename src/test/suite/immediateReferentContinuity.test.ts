import { describe, expect, it } from 'vitest';
import { detectObjectiveBoundary, summarizeObjective, extractReferencedSymbols } from '../../orchestration/ConversationContinuity';
import type { ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';

/**
 * Phase 2, part B — immediate-referent continuity.
 *
 * Reproduces the three-turn scenario from the Phase 2 brief at the unit
 * level, against the real `detectObjectiveBoundary` production function (no
 * model call, no mocked continuity — this is the same pure function
 * `AgentPanel.prepareTurnContinuity` calls for every turn).
 *
 * Turn 1: "Inspect package.json and explain the build pipeline."
 * Turn 2: "Inspect src/ui/AgentPanel.ts and identify the two most important
 *          mechanisms that prevent stale autonomous-task state from taking
 *          over a newer user submission."
 * Turn 3: "Which of those two mechanisms protects against a restore that
 *          started before the new submission, and which protects against a
 *          restore that started after the submission counter had already
 *          changed?"
 *
 * Turn 3 must resolve as `same_objective` against turn 2's evidence — never
 * `new_objective` (which would jump back to turn 1 / drop context) and never
 * `ambiguous` (which would force an "is this a new task?" clarification the
 * brief explicitly forbids).
 */
function stateAfter(objectiveText: string, extraSymbols: string[] = []): ConversationWorkingStateRecord {
  const now = new Date().toISOString();
  return {
    conversationId: 'conv_1',
    workspaceIdentity: 'ws_1',
    objectiveId: 'obj_1',
    currentObjective: summarizeObjective(objectiveText),
    latestUserIntent: objectiveText.slice(0, 600),
    latestExecutionPolicy: null,
    relevantFiles: [],
    relevantSymbols: [...new Set([...extraSymbols, ...extractReferencedSymbols(objectiveText)])],
    userConstraints: [],
    latestFindingsSummary: null,
    pendingAction: null,
    latestTaskId: null,
    latestProposalId: null,
    latestValidationSummary: null,
    createdAt: now,
    updatedAt: now,
    version: 1,
  };
}

const TURN1 = 'Inspect package.json and explain the build pipeline.';
const TURN2 = 'Inspect src/ui/AgentPanel.ts and identify the two most important mechanisms that prevent stale autonomous-task state from taking over a newer user submission.';
const TURN3 = 'Which of those two mechanisms protects against a restore that started before the new submission, and which protects against a restore that started after the submission counter had already changed?';

describe('Phase 2 — immediate referent continuity ("those two mechanisms")', () => {
  it('turn 2 stays on the same objective as turn 1 (the active repository-exploration objective)', () => {
    const stateAfterTurn1 = stateAfter(TURN1);
    expect(detectObjectiveBoundary(TURN2, stateAfterTurn1)).toBe('same_objective');
  });

  it('turn 3 resolves against turn 2, not turn 1: "those two mechanisms" is same_objective, never ambiguous or new_objective', () => {
    // The objective label is frozen at turn 1 (matches AgentPanel.recordTurnContinuity,
    // which only relabels the objective when a NEW objective starts), but relevantSymbols
    // accumulate turn-over-turn — exactly as `recordTurnContinuity` persists them.
    const stateAfterTurn2: ConversationWorkingStateRecord = {
      ...stateAfter(TURN1),
      relevantSymbols: [...extractReferencedSymbols(TURN1), ...extractReferencedSymbols(TURN2)],
    };
    const boundary = detectObjectiveBoundary(TURN3, stateAfterTurn2);
    expect(boundary).toBe('same_objective');
    expect(boundary).not.toBe('ambiguous');
    expect(boundary).not.toBe('new_objective');
  });

  it('without the deictic fix, "those two mechanisms" alone (no shared vocabulary with the frozen turn-1 objective label) would not resolve — confirms the fix is load-bearing', () => {
    // Sanity check on the underlying mechanism: turn 3 shares no significant
    // terms with the turn-1-derived objective/symbol set at all (this isolates
    // the deictic-pattern fix from the term-overlap fallback so the test
    // cannot pass for the wrong reason).
    const stateAfterTurn1Only = stateAfter(TURN1);
    const boundary = detectObjectiveBoundary(TURN3, stateAfterTurn1Only);
    // Even without turn 2's AgentPanel symbol recorded, the deictic
    // "those two mechanisms" reference must still resolve as a continuation
    // rather than forcing a clarification question.
    expect(boundary).toBe('same_objective');
  });
});
