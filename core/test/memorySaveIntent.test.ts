import { describe, expect, it } from 'vitest';
import { extractMemoryFact, isMemorySaveIntent } from '../runtime/piAgentEngine';

// Verbatim from the Build 159 audit, M4 retry: Pandesh stored the durable memory
// "it in the same workspace and show me where I can open it." for this prompt.
const M4_RETRY = 'Now turn that catering estimate into a professional one-page PDF report with the revenue, costs and profit. Save it in the same workspace and show me where I can open it.';

describe('memory save intent (audit D3)', () => {
  it('a file instruction containing "Save it" is not a memory request', () => {
    expect(isMemorySaveIntent(M4_RETRY)).toBe(false);
  });

  it('other ordinary uses of save/remember are not memory requests', () => {
    for (const text of [
      'Save the report as a PDF.',
      'Save this file to my desktop.',
      'I remember the old office was in Ulm.',
      'Remember to call mum at 6.',
      'Do you remember what I said about tea?',
      'What do you remember about my project?',
      "Don't forget to water the plants tomorrow.",
      'Please save it.',
    ]) expect(isMemorySaveIntent(text), text).toBe(false);
  });

  it('explicit memory requests still work and extract the fact', () => {
    const cases: Array<[string, string]> = [
      ['Remember that my favourite tea is Darjeeling.', 'my favourite tea is Darjeeling.'],
      ['Please remember I work from home on Fridays', 'I work from home on Fridays'],
      ["Keep in mind that I'm vegetarian", "I'm vegetarian"],
      ['Save to memory that I prefer metric units', 'I prefer metric units'],
      ['My accountant is Frau Weber. Save that to your memory.', 'My accountant is Frau Weber'],
      ['Pandesh, remember that the car insurance renews in March', 'the car insurance renews in March'],
    ];
    for (const [text, fact] of cases) {
      expect(isMemorySaveIntent(text), text).toBe(true);
      expect(extractMemoryFact(text), text).toBe(fact);
    }
  });
});
