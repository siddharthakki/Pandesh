/**
 * Micro-tests FIN-021 and EDU-018 (Build 163, D-MEM-1): "Remember my synthetic test stock watchlist: NVDA and SAP" and
 * "Remember my new vocabulary only in this study session" were caught by the note shortcut ("Saved note: …"); the
 * watchlist was never found again and the session scope was ignored. Both now go to Core memory; plain jottings stay
 * quick notes.
 */
import { describe, expect, it } from 'vitest';
import { parseEverydayIntent } from '../src/host/everydayToolsIntent';

describe('"Remember …" routing (micro-tests)', () => {
  it.each([
    'Remember my synthetic test stock watchlist: NVDA and SAP.',
    'Remember my new vocabulary only in this study session.',
    'Remember that I live in Ulm, Germany.',
  ])('goes to Core memory: %s', (text) => {
    expect(parseEverydayIntent(text)).toBeNull();
  });

  it.each([
    'Remember to buy oat milk',
    'remember the gate code 4711',
    'Remember the parcel is at the neighbour',
  ])('stays a quick note: %s', (text) => {
    expect(parseEverydayIntent(text)).toMatchObject({ kind: 'remember_note' });
  });
});
