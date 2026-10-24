import { describe, expect, it } from 'vitest';
import { isPersonalFact, parseEverydayIntent } from '../src/host/everydayToolsIntent';

describe('"remember ..." goes to durable memory when it is a fact about the person', () => {
  it.each([
    'Please remember this about me: my home location is Ulm, Germany, not Karlsruhe.',
    'Remember that my home is Ulm, not Karlsruhe',
    'remember I live in Ulm',
    "Remember that I'm vegetarian",
    'Remember my timezone is Europe/Berlin',
    'Remember that I prefer short answers',
  ])('is left for the assistant memory, not saved as a note: %s', (text) => {
    expect(parseEverydayIntent(text)).toBeNull();
    expect(isPersonalFact(text.replace(/^(?:please\s+)?remember(?:\s+(?:that|this))?\s+/i, ''))).toBe(true);
  });

  it.each([
    'Remember to call Anna tomorrow',
    'Remember that the invoice is due on Friday',
    'remember the wifi password is on the fridge',
  ])('stays a quick note: %s', (text) => {
    expect(parseEverydayIntent(text)).toMatchObject({ kind: 'remember_note' });
  });
});
