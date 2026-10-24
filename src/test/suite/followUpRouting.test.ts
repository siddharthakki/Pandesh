import { describe, expect, it } from 'vitest';
import type { ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';
import { isReadOnlyFollowUpOnPriorWork } from '../../orchestration/FollowUpRouting';

const state = (overrides: Partial<ConversationWorkingStateRecord> = {}): ConversationWorkingStateRecord => ({
  currentObjective: 'Fix the duplicate event bug in event_forms.html',
  latestTaskId: 'task-1',
  relevantFiles: [],
  ...overrides,
} as ConversationWorkingStateRecord);

describe('read-only follow-up routing contract', () => {
  it('treats a summary question after a completed or blocked task as a conversational follow-up', () => {
    expect(isReadOnlyFollowUpOnPriorWork('Briefly summarize what you changed and which files you touched.', state())).toBe(true);
    expect(isReadOnlyFollowUpOnPriorWork('Why did that fail?', state())).toBe(true);
  });

  it('treats an explicit read-only inspection after a build as a follow-up (g7)', () => {
    expect(isReadOnlyFollowUpOnPriorWork(
      'Inspect this workspace and explain what this project does, its main components, and how it is run. Do not modify any files.',
      state({ currentObjective: 'lets build an html with login page' }),
    )).toBe(true);
  });

  it('never treats a mutation, delegation or bare "fix it" as read-only', () => {
    expect(isReadOnlyFollowUpOnPriorWork('Now add a delete button to the event form.', state())).toBe(false);
    expect(isReadOnlyFollowUpOnPriorWork('Run the tests and fix any failures end to end.', state())).toBe(false);
    expect(isReadOnlyFollowUpOnPriorWork('fix it', state())).toBe(false);
  });

  it('does not read bare control words as a conversational follow-up', () => {
    expect(isReadOnlyFollowUpOnPriorWork('yes', state())).toBe(false);
    expect(isReadOnlyFollowUpOnPriorWork('new task', state())).toBe(false);
  });

  it('requires that work was actually performed or inspected', () => {
    expect(isReadOnlyFollowUpOnPriorWork('Briefly summarize what you changed.', null)).toBe(false);
    expect(isReadOnlyFollowUpOnPriorWork('Briefly summarize what you changed.', state({ latestTaskId: null, relevantFiles: [], latestFindingsSummary: null }))).toBe(false);
  });
});
