/**
 * Build 180 in production: "While that runs: what is the capital of Japan?" was read as a request for background work,
 * the turn was offered only the mission tools, and the model started a duplicate mission instead of answering.
 * Words that point at work in progress ask for a mission only when nothing is running yet.
 */
import { describe, it, expect } from 'vitest';
import { wantsBackgroundWork } from '../runtime/missionTools';

describe('a question asked while a mission runs', () => {
  const question = 'While that runs: what is the capital of Japan?';

  it('is not a request for background work when a mission is running', () => {
    expect(wantsBackgroundWork(question, { missionRunning: true })).toBe(false);
    expect(wantsBackgroundWork('While it is running, tell me how many days there are until Christmas.', { missionRunning: true })).toBe(false);
    expect(wantsBackgroundWork('And while you work on that, what does the word "idempotent" mean?', { missionRunning: true })).toBe(false);
  });

  it('with nothing running, the same words describe how this message\'s work should be done', () => {
    expect(wantsBackgroundWork('Check how full the disks are, and while that runs I will ask you other things.', { missionRunning: false })).toBe(true);
    expect(wantsBackgroundWork('Check how full the disks are, and while that runs I will ask you other things.')).toBe(true);
  });

  it('an explicit request for more background work still counts while a mission runs', () => {
    expect(wantsBackgroundWork('While that runs, also check the listening ports in the background.', { missionRunning: true })).toBe(true);
    expect(wantsBackgroundWork('In the background while I keep talking to you: check how full the disks are.', { missionRunning: true })).toBe(true);
    expect(wantsBackgroundWork('Start another one as a mission: list the services that are listening on ports.', { missionRunning: true })).toBe(true);
  });

  it('the earlier rules are unchanged', () => {
    expect(wantsBackgroundWork('What is the capital of Japan?', { missionRunning: true })).toBe(false);
    expect(wantsBackgroundWork('Do not run this in the background, just check how full the disks are right now.')).toBe(false);
    expect(wantsBackgroundWork('in the background')).toBe(false);
  });
});
