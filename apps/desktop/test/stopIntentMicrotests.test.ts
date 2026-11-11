/**
 * Micro-tests RES-003 and REC-006 (Build 163): "Cancel the active test task now." and "No, cancel that." were not
 * recognised as Stop, so they were queued behind (or handed to) the work they were meant to end, which then ran on.
 */
import { describe, expect, it } from 'vitest';
import { isStopIntent } from '../src/host/desktopInteractionRouting';

describe('stop wording while work runs (micro-tests)', () => {
  it.each([
    'Cancel the active test task now.',
    'No, cancel that.',
    'stop the running task',
    'Please cancel the current job.',
    'Wait, stop!',
    'cancel it right now',
    'abort this request',
  ])('stops: %s', (text) => {
    expect(isStopIntent(text)).toBe(true);
  });

  it.each([
    'stop using tabs and use spaces',
    'Cancel the meeting with Alex on Friday.',
    'cancel my gym membership reminder',
    "don't stop, keep going",
    'Cancel during an approval prompt.',
    'stop the task and write a summary of what you did',
  ])('stays an instruction: %s', (text) => {
    expect(isStopIntent(text)).toBe(false);
  });
});
