import { describe, it, expect } from 'vitest';
import { wantsBackgroundWork } from '../runtime/missionTools';

describe('the user says how to work: in the background, while they keep talking', () => {
  it.each([
    'Find out what\'s slowing down my computer and what is safe to optimize. Meanwhile, I want to continue talking to you.',
    'Research the three best heat pumps for an old house and do it in the background please.',
    'Clean up the Downloads folder plan, and while that runs I have other questions for you.',
    'Build the report for the quarter; in the meantime I want to ask you other things.',
    'Check all of my projects for outdated dependencies and keep talking to me while you work.',
  ])('yes: %s', (text) => { expect(wantsBackgroundWork(text)).toBe(true); });

  it.each([
    'What is 17 times 23?',
    'Meanwhile, what is the weather like?',
    'Fix the failing tests in this project and tell me what was wrong.',
    'Change the background colour of the landing page to dark blue please, thank you.',
    'Do this now, not in the background: summarise the three files in this folder for me.',
    '',
  ])('no: %s', (text) => { expect(wantsBackgroundWork(text)).toBe(false); });
});
