import { describe, expect, it } from 'vitest';
import {
  classifyControlAcknowledgement,
  detectObjectiveBoundary,
  followUpAffinity,
  summarizeObjective,
  type ContinuityContext,
} from '../../orchestration/ConversationContinuity';
import type { ConversationWorkingStateRecord } from '../../../core/shared/wireTypes';

/**
 * Visible Golden step-2 regression: "Which file would I open first and why?"
 * after "What does this workspace contain?" asked "new task?" because the
 * follow-up shares no vocabulary with the stored objective string. Continuity
 * must be judged against the exchange that just happened (followUpAffinity),
 * without becoming a blanket "everything continues" and without regressing the
 * control-acknowledgement handling.
 */
function stateFor(objective: string, extra: Partial<ConversationWorkingStateRecord> = {}): ConversationWorkingStateRecord {
  const now = new Date().toISOString();
  return {
    conversationId: 'conv_1',
    workspaceIdentity: 'ws_1',
    objectiveId: 'obj_1',
    currentObjective: summarizeObjective(objective),
    latestUserIntent: objective,
    latestExecutionPolicy: null,
    relevantFiles: [],
    relevantSymbols: [],
    userConstraints: [],
    latestFindingsSummary: null,
    pendingAction: null,
    latestTaskId: null,
    latestProposalId: null,
    latestValidationSummary: null,
    pendingNewObjective: false,
    awaitingObjectiveClarification: false,
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...extra,
  } as ConversationWorkingStateRecord;
}

const WORKSPACE_Q = 'What does this workspace contain?';
const WORKSPACE_A = 'Based on the provided excerpts, the workspace contains:\n- index.html: a minimal HTML page with <h1>Hello</h1>\n- README.md: a single-line title, # golden-visible';
const workspaceCtx: ContinuityContext = { previousAssistantText: WORKSPACE_A, previousUserText: WORKSPACE_Q };

describe('follow-up affinity: continuity is judged against the preceding exchange', () => {
  it('1. "Which file would I open first and why?" continues "What does this workspace contain?"', () => {
    const state = stateFor(WORKSPACE_Q);
    expect(detectObjectiveBoundary('Which file would I open first and why?', state)).toBe('same_objective');
    expect(detectObjectiveBoundary('Which file would I open first and why?', state, workspaceCtx)).toBe('same_objective');
  });

  it('2. a coding objective followed by "Now add a short subtitle below it." is same_objective', () => {
    const state = stateFor('Create a new file about.html containing a single heading that says About KKD.');
    expect(detectObjectiveBoundary('Now add a short subtitle below it.', state)).toBe('same_objective');
    // ... and without the "Now" marker, the referent ("below it") carries it.
    expect(detectObjectiveBoundary('Add a short subtitle below it.', state)).toBe('same_objective');
  });

  it('3. an answer listing several files: "What about the second one?" is same_objective', () => {
    const state = stateFor('Which files handle authentication?');
    const ctx: ContinuityContext = { previousAssistantText: '1. src/auth/login.ts\n2. src/auth/session.ts\n3. src/auth/token.ts' };
    expect(detectObjectiveBoundary('What about the second one?', state, ctx)).toBe('same_objective');
  });

  it('4. "Explain the architecture" then "Why was that design chosen?" is same_objective', () => {
    const state = stateFor('Explain the architecture');
    expect(detectObjectiveBoundary('Why was that design chosen?', state)).toBe('same_objective');
  });

  it('other natural follow-ups resolve without matching any golden string', () => {
    const state = stateFor(WORKSPACE_Q);
    for (const text of [
      'Which one should I start with?',
      'How do I run it?',
      'Can you explain that in more detail?',
      'And why is that the best place to begin?',
      'What about the readme?',
      'Which of those is the most important?',
    ]) {
      expect(detectObjectiveBoundary(text, state, workspaceCtx), text).toBe('same_objective');
    }
  });

  it('wrap-up requests about the work just done continue (visible Golden step 8)', () => {
    const state = stateFor('Create a new file about.html containing a single heading that says About KKD.');
    const ctx: ContinuityContext = { previousAssistantText: 'Added a subtitle below the heading in about.html.' };
    for (const text of [
      'Summarize the final workspace. Do not modify any files.',
      'Recap what we changed so far.',
      'Give me an overview of everything we did.',
      'Wrap it up and list the resulting files.',
    ]) {
      expect(detectObjectiveBoundary(text, state, ctx), text).toBe('same_objective');
    }
  });

  it('an unanchored summary request is still a fresh objective', () => {
    const state = stateFor('Create a new file about.html containing a single heading that says About KKD.');
    const ctx: ContinuityContext = { previousAssistantText: 'Added a subtitle below the heading in about.html.' };
    for (const text of ['Summarize the codebase architecture.', 'Summarize this repository\'s dependency graph.']) {
      expect(detectObjectiveBoundary(text, state, ctx), text).toBe('ambiguous');
    }
  });

  it('answer-term overlap lets a short question about the assistant\'s own answer continue', () => {
    const state = stateFor(WORKSPACE_Q);
    const ctx: ContinuityContext = { previousAssistantText: 'The entry point is server.js; routing lives in router.js.' };
    expect(detectObjectiveBoundary('Does router.js validate input?', state, ctx)).toBe('same_objective');
    expect(followUpAffinity('Does router.js validate input?', state, ctx).signals).toContain('answer-term-overlap');
  });

  it('5. substantive unrelated objectives still ask for new-task clarification', () => {
    const state = stateFor(WORKSPACE_Q);
    for (const text of [
      'Build me a calculator app.',
      'Please add a caching layer to the reporting dashboard exporter.',
    ]) {
      expect(detectObjectiveBoundary(text, state, workspaceCtx), text).not.toBe('same_objective');
    }
    expect(detectObjectiveBoundary('Build me a calculator app.', state, workspaceCtx)).toBe('ambiguous');

    // After an unrelated coding objective the exact Golden inspection prompt is still not a follow-up.
    const coding = stateFor('Change the text in index.html from Hello to Hello KKD.');
    expect(detectObjectiveBoundary(
      'Inspect this workspace and explain what this project does, its main components, and how it is run. Do not modify any files.',
      coding,
      { previousAssistantText: 'Done: index.html now says Hello KKD.', previousUserText: 'Change the text in index.html from Hello to Hello KKD.' },
    )).not.toBe('same_objective');
  });

  it('a self-contained imperative is never made a follow-up by word overlap alone', () => {
    const state = stateFor(WORKSPACE_Q);
    const ctx: ContinuityContext = { previousAssistantText: 'index.html and README.md, a login page.' };
    expect(followUpAffinity('Build a login page in index.html', state, ctx).affinity).toBe('none');
  });

  it('6. bare control acknowledgements keep their closed vocabulary (no regression)', () => {
    expect(classifyControlAcknowledgement('Yes new task')).toBe('confirm_new');
    expect(classifyControlAcknowledgement('continue')).toBe('confirm_continue');
    expect(classifyControlAcknowledgement('retry')).toBe('retry');
    expect(classifyControlAcknowledgement('yes')).toBe('affirmation');
    // Substantive content is never a control acknowledgement, so affinity never sees these as controls.
    expect(classifyControlAcknowledgement('Which file would I open first and why?')).toBeNull();
    expect(classifyControlAcknowledgement('Why was that design chosen?')).toBeNull();
  });

  it('7. a restart preserves the same behaviour: durable state + durable messages give the same decision', () => {
    const state = stateFor(WORKSPACE_Q, { relevantFiles: [{ path: 'index.html', contentHash: 'h', observedAt: 'x' }] as never });
    const restored = JSON.parse(JSON.stringify(state)) as ConversationWorkingStateRecord;
    const persistedMessages = JSON.parse(JSON.stringify([
      { role: 'user', content: WORKSPACE_Q },
      { role: 'assistant', content: WORKSPACE_A },
    ])) as Array<{ role: string; content: string }>;
    const lastAssistant = [...persistedMessages].reverse().find(m => m.role === 'assistant');
    const lastUser = [...persistedMessages].reverse().find(m => m.role === 'user');
    const ctx = { previousAssistantText: lastAssistant?.content ?? null, previousUserText: lastUser?.content ?? null };
    for (const text of ['Which file would I open first and why?', 'What about the readme?']) {
      expect(detectObjectiveBoundary(text, restored, ctx)).toBe(detectObjectiveBoundary(text, state, ctx));
      expect(detectObjectiveBoundary(text, restored, ctx)).toBe('same_objective');
    }
    expect(detectObjectiveBoundary('Build me a calculator app.', restored, ctx)).toBe('ambiguous');
  });
});
