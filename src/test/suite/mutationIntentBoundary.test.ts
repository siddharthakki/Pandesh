import { describe, expect, it } from 'vitest';
import { decideExecutionPolicy } from '../../orchestration/ExecutionPolicyRouter';
import { classifyRequest } from '../../../core/domain/routing';
import { deriveMutationPolicy, isMutatingToolName } from '../../../core/domain/mutationPolicy';
import { announcesUnperformedAction, hasAffirmativeMutationIntent, isInspectionOrAdvisoryOnly } from '../../../core/domain/actionIntent';
import { classifyTaskRequirements } from '../../models/TaskModelSelection';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const presentation = require('../../../media/everyday-presentation.js') as { recommendMode: (text: string, previousMode?: string) => { mode: 'chat' | 'agent' | 'autonomous' } };

// Invariant: discussion about a possible change != authorization to propose a mutation.
const ADVISORY = [
  'What would you change here?',
  'Which file would need changing?',
  'How would you implement retries?',
  'What should we modify if this needs caching?',
  'Would you change this function?',
  'Which part would you change if I wanted retries?',
  'Would changing this helper solve it?',
  'Could this be fixed without touching the API?',
  'Where would you add logging?',
];
const ACTION = [
  // politeness / interrogative grammar != hypothetical intent: a request addressed to KKD to act
  'Can you fix the total?',
  'Could you add dark mode?',
  'Would you remove this button for me?',
  'Please update this.',
  'Can you implement that?',
  'Change it.',
  'Implement that.',
  'Add retries.',
  'Fix this.',
  'Go ahead and modify the code.',
  'Please update the README.',
  'Good. Now let me delete an expense.',
  'I want to add a category to each expense.',
  'Explain the flow, then add retries to the HTTP helper.',
];

describe('mutation-capable routing requires affirmative action intent', () => {
  for (const text of ADVISORY) {
    it(`advisory stays read-only everywhere: ${text}`, () => {
      expect(decideExecutionPolicy(text).policy, 'ExecutionPolicyRouter').toBe('READ_ONLY');
      expect(classifyRequest(text).resolvedMode, 'core classifyRequest').not.toBe('karke_dikha');
      expect(presentation.recommendMode(text).mode, 'webview mirror').not.toBe('autonomous');
      expect(presentation.recommendMode(text).mode, 'webview mirror').not.toBe('agent');
    });
  }
  for (const text of ACTION) {
    it(`action intent may enter proposal mode: ${text}`, () => {
      expect(decideExecutionPolicy(text).policy, 'ExecutionPolicyRouter').not.toBe('READ_ONLY');
      expect(classifyRequest(text).resolvedMode, 'core classifyRequest').toBe('karke_dikha');
      expect(presentation.recommendMode(text).mode, 'webview mirror').not.toBe('chat');
    });
  }
});

// A request to inspect or diagnose is its own class: investigation with tools, never a mutation, and it needs
// no repository noun ("what does this do" style situational awareness applies to inspection requests too).
describe('explicit inspection/diagnosis requests reach read-only investigation', () => {
  const DIAGNOSTIC = [
    "A 10% coupon on a $200 cart gives $190 instead of $180. Can you inspect why this is happening and tell me what you think is wrong? Don't change anything yet.",
    'Please investigate why the build fails on CI.',
    'Debug the crash on startup.',
  ];
  for (const text of DIAGNOSTIC) {
    it(`inspection, not mutation: ${text.slice(0, 60)}`, () => {
      expect(decideExecutionPolicy(text).policy).toBe('READ_ONLY');
      expect(decideExecutionPolicy(text).reason).toMatch(/inspection/);
      expect(classifyRequest(text).resolvedMode).toBe('saath_kar');
      expect(presentation.recommendMode(text).mode).toBe('agent');
    });
  }
  it('general knowledge questions with no diagnostic request stay ordinary chat', () => {
    for (const text of ['How does a mutex work?', 'What is the capital of France?']) {
      expect(presentation.recommendMode(text).mode, text).toBe('chat');
    }
  });
});

// The layer that decides whether a proposal card can exist at all: no affirmative action intent -> mutating tools
// are not exposed and no mutation is expected of the model (Golden B: "...tell me what you think is wrong. Do not change anything yet.").
describe('mutation policy follows the action-intent boundary', () => {
  for (const text of [...ADVISORY, ...DIAGNOSTIC_TEXTS()]) {
    it(`denied: ${text.slice(0, 70)}`, () => {
      expect(deriveMutationPolicy(text)).toBe('denied');
      expect(classifyTaskRequirements(text).fileMutation).toBe(false);
    });
  }
  for (const text of ACTION) {
    it(`allowed: ${text.slice(0, 70)}`, () => {
      expect(deriveMutationPolicy(text)).toBe('allowed');
    });
  }
  it('a narrow constraint inside a real request does not make the request read-only', () => {
    expect(deriveMutationPolicy('Fix the total calculation. Do not modify the tests.')).toBe('allowed');
  });
  it('propose tools are classed as mutating', () => {
    expect(isMutatingToolName('propose_file_change')).toBe(true);
  });
});

function DIAGNOSTIC_TEXTS(): string[] {
  return [
    "A 10% coupon on a $200 cart gives $190 instead of $180. Can you inspect why this is happening and tell me what you think is wrong? Don't change anything yet.",
    'Please investigate why the build fails on CI.',
  ];
}

describe('announcesUnperformedAction', () => {
  it('flags a final answer that promises a next action, not offers or finished summaries', () => {
    expect(announcesUnperformedAction("The edit didn't land. I'll submit the complete changed file as one self-contained proposal instead.")).toBe(true);
    expect(announcesUnperformedAction("Let me add the summary card now.")).toBe(true);
    for (const text of ['Done. Want me to add a filter too?', "I've added the summary card.", "Let me know if you'd like changes.", 'The title is now Momentum.', 'Should I add a summary card?']) {
      expect(announcesUnperformedAction(text), text).toBe(false);
    }
  });
});

// Real-user regression (2026-10-06): "verify"/"correct" wording must never imply workspace mutation or autonomy.
const VERIFY_STARTUP_PROMPT = 'Verify your previous run instructions. Read the actual launcher/entrypoint files needed to prove the exact startup command, including start.bat if it exists. Correct anything you previously inferred. Cite the exact files/functions that establish the startup path.';
const CONVERSATIONAL_EDITS = [
  'correct your previous answer',
  'fix your explanation',
  'verify and correct your inference',
  'improve your recommendation',
  VERIFY_STARTUP_PROMPT,
];

describe('semantic read-only invariant: correcting the conversation is not mutating the workspace', () => {
  for (const text of CONVERSATIONAL_EDITS) {
    it(`stays read-only everywhere: ${text.slice(0, 60)}`, () => {
      expect(decideExecutionPolicy(text).policy, 'ExecutionPolicyRouter').toBe('READ_ONLY');
      expect(classifyRequest(text).resolvedMode, 'core classifyRequest').not.toBe('karke_dikha');
      expect(hasAffirmativeMutationIntent(text), 'actionIntent').toBe(false);
      expect(presentation.recommendMode(text).mode, 'webview mirror').not.toBe('autonomous');
      expect(presentation.recommendMode(text, 'chat').mode, 'Baat continuation inertia').toBe('chat');
      expect(isInspectionOrAdvisoryOnly(text) || !hasAffirmativeMutationIntent(text)).toBe(true);
    });
  }
  it('verification verbs still delegate when the same turn changes the workspace', () => {
    expect(decideExecutionPolicy('Fix the login bug and verify it end to end').policy).toBe('AUTONOMOUS_EXECUTION');
    expect(presentation.recommendMode('Update the README and verify it').mode).toBe('autonomous');
  });
  it('a conversational object does not shield a real file edit', () => {
    expect(hasAffirmativeMutationIntent('Fix the explanation in README.md')).toBe(true);
    expect(hasAffirmativeMutationIntent('Update the instructions file')).toBe(true);
  });
});
