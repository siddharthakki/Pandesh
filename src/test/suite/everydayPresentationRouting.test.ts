import { describe, expect, it } from 'vitest';

// The webview uses this CommonJS-compatible mirror directly at runtime.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const presentation = require('../../../media/everyday-presentation.js') as {
  recommendMode: (text: string, previousMode?: string, previousModeIsRestored?: boolean) => {
    mode: 'chat' | 'agent' | 'autonomous';
    reason: string;
  };
};

describe('everyday-presentation Auto routing mirror', () => {
  it('keeps a conversational bounded-edit follow-up in governed Saath Kar work', () => {
    const decision = presentation.recommendMode(
      'Good. Now add a validation for password. Should be 12 characters, should have a number, capital alphabet and a special character.',
      'agent',
    );

    expect(decision.mode).toBe('agent');
  });

  it('recognizes repeated acknowledgment/filler before a mutation verb', () => {
    expect(presentation.recommendMode('Great, now change the button label.').mode).toBe('agent');
    expect(presentation.recommendMode('Okay. Good. Now add an aria-label.').mode).toBe('agent');
  });

  it('routes natural build phrasing and behaviour-change instructions to governed Saath Kar (golden workflow 1)', () => {
    for (const text of [
      'Good. Now let me delete an expense.',
      'I want to add a category to each expense.',
      'Okay. Ask me before an expense is deleted.',
      'Also keep this dependency-free.',
    ]) {
      expect(presentation.recommendMode(text).mode).toBe('agent');
    }
    // Questions about the previous change stay conversational.
    expect(presentation.recommendMode('Why did you implement it that way?').mode).toBe('chat');
    expect(presentation.recommendMode('How does the total spending work right now?').mode).toBe('chat');
  });

  it('does not escalate acknowledgment-only or explanatory follow-ups', () => {
    expect(presentation.recommendMode('Good.').mode).toBe('chat');
    expect(presentation.recommendMode('Thanks. Explain why password validation matters.').mode).toBe('chat');
  });
});
