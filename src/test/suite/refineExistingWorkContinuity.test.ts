import { describe, expect, it } from 'vitest';
import { detectObjectiveBoundary } from '../../orchestration/ConversationContinuity';
import type { ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';

function state(over: Partial<ConversationWorkingStateRecord> = {}): ConversationWorkingStateRecord {
  return {
    conversationId: 'c', workspaceIdentity: 'w', objectiveId: 'o',
    currentObjective: 'Can you make me a little expense tracker web app.', latestUserIntent: '',
    latestExecutionPolicy: 'COLLABORATIVE_EDIT', relevantFiles: [], relevantSymbols: [], userConstraints: [],
    latestFindingsSummary: "I've proposed index.html, a complete single-file expense tracker.", pendingAction: null,
    latestTaskId: null, latestProposalId: null, latestValidationSummary: null, pendingNewObjective: false,
    awaitingObjectiveClarification: false, createdAt: '', updatedAt: '', version: 1, ...over,
  } as ConversationWorkingStateRecord;
}

describe('refining work the conversation already produced', () => {
  it('a modification request continues the built app instead of asking "new task?"', () => {
    for (const text of ['Looks good. Add dark mode.', 'Make it remember the selected mode when I reopen the app.',
      'The mobile view feels cramped. Improve it without changing the desktop layout too much.', 'Rename it to Momentum and add a small summary card.',
      "I don't like the summary card. Remove only that. Keep the dark mode and everything else."]) {
      expect(detectObjectiveBoundary(text, state()), text).toBe('same_objective');
    }
  });

  it('a fresh self-contained build request still asks', () => {
    expect(detectObjectiveBoundary('Build me a chess engine.', state())).not.toBe('same_objective');
    expect(detectObjectiveBoundary('Looks good. Now build me a chess engine.', state())).not.toBe('same_objective');
    // a request aimed at a specific target the conversation never mentioned is a change of subject
    expect(detectObjectiveBoundary('Please add a caching layer to the reporting dashboard exporter.', state())).toBe('ambiguous');
  });

  it('with no prior work in the conversation, nothing is inferred', () => {
    const empty = state({ latestFindingsSummary: null, relevantFiles: [], latestTaskId: null });
    expect(detectObjectiveBoundary('Looks good. Add dark mode.', empty)).not.toBe('same_objective');
  });
});
