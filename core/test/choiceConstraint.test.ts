import { describe, expect, it } from 'vitest';
import { asksForSingleChoice } from '../runtime/choiceConstraint';

describe('asksForSingleChoice', () => {
  it.each([
    'Which one would you prioritize if the project has to be usable in one week?',
    'Pick one of these for me.',
    'If you had to choose just one, which?',
    'Which feature should we start with?',
    'What is the single most important change?',
  ])('detects: %s', (t) => expect(asksForSingleChoice(t)).toBe(true));

  it.each([
    'What three features should we implement first?',
    'Changing the subject: what is the capital of Australia?',
    'Compare the options and tell me the trade-offs.',
    'Start a four-minute tea timer and a nine-minute pasta timer.',
  ])('ignores: %s', (t) => expect(asksForSingleChoice(t)).toBe(false));
});
