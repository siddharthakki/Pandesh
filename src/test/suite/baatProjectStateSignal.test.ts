import { describe, expect, it } from 'vitest';
import { suggestsCurrentProjectBehaviour } from '../../ui/AgentPanel';

describe('suggestsCurrentProjectBehaviour (soft repository-grounding signal for Baat Kar)', () => {
  it('fires for present-tense questions about how something in the project works', () => {
    expect(suggestsCurrentProjectBehaviour('How does the total spending work right now?')).toBe(true);
    expect(suggestsCurrentProjectBehaviour('How does login currently work in this app?')).toBe(true);
  });

  it('does not fire for general knowledge, small talk, or follow-ups about the assistant', () => {
    expect(suggestsCurrentProjectBehaviour('How does a mutex work?')).toBe(false);
    expect(suggestsCurrentProjectBehaviour('What time is it right now?')).toBe(false);
    expect(suggestsCurrentProjectBehaviour('Why did you implement it that way?')).toBe(false);
  });
});
