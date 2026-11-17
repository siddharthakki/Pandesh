/**
 * Background work was asked for and the model answered in words (Build 179 in production, gemma4:12b under Auto):
 * what Core reads from the turn's tool calls, what it replies when no mission exists, and that a started mission backs
 * the lead's "I assigned Operations" sentence.
 */
import { describe, it, expect } from 'vitest';
import { MISSION_START_REASK, lastMissionRefusal, missionNotStartedReply, missionOutcome, onlyAsksBack } from '../runtime/missionTools';
import { auditPromises } from '../runtime/assistantStatus';
import { unsupportedActionClaim, withholdUnsupportedActionClaims } from '../runtime/actionClaims';

const call = (tool: string, status: string, text = '') => ({ tool, status, result: { content: [{ type: 'text', text }] } });

describe('what the turn did about the background request', () => {
  it('reads it from the recorded calls, never from the reply', () => {
    expect(missionOutcome([])).toBe('none');
    expect(missionOutcome([call('calculate', 'completed')])).toBe('none');
    expect(missionOutcome([call('mission_start', 'completed', 'MISSION STARTED in the background (id msn_1).')])).toBe('started');
    expect(missionOutcome([call('mission_start', 'failed', 'NOT DONE (refused by Pandesh Core before anything started): step 1 …')])).toBe('refused');
    expect(missionOutcome([call('mission_start', 'failed'), call('mission_start', 'completed')])).toBe('started');
    expect(missionOutcome([call('mission_manage', 'completed', 'Mission msn_1 "x": running (0/2 steps done)')])).toBe('managed');
    expect(missionOutcome([call('mission_manage', 'completed', 'MISSION CONTINUED in the background from its first unfinished step.')])).toBe('started');
  });

  it('a reply that only asks something back is left alone; one that claims a start is not', () => {
    expect(onlyAsksBack('Which folder should the specialists look at?')).toBe(true);
    expect(onlyAsksBack("I've started a background mission. Anything else?")).toBe(false);
    expect(onlyAsksBack('The mission is now running. Shall I tell you when it ends?')).toBe(false);
    expect(onlyAsksBack("I've started a background mission to identify what's slowing down your PC.")).toBe(false);
  });

  it('Core asks for the call itself', () => {
    expect(MISSION_START_REASK).toMatch(/Call mission_start now/);
    expect(MISSION_START_REASK).toMatch(/no specialist is working/);
  });
});

describe('Core\'s reply when no mission exists at the end of the turn', () => {
  it('says plainly that nothing was started, names the model, and promises nothing', () => {
    const reply = missionNotStartedReply('gemma4:12b', null);
    expect(reply).toMatch(/^\*\*Nothing was started\.\*\*/);
    expect(reply).toMatch(/gemma4:12b/);
    expect(reply).toMatch(/No specialist is working on it and no report will arrive/);
    // It is already Core's statement: the promise audit must not append a second correction to it.
    expect(auditPromises(reply, { activeWorker: false, canNotify: false, notifyStatement: 'x' })).toBeNull();
  });

  it('when Core refused the plan, gives Core\'s reason instead of blaming the model', () => {
    const calls = [call('mission_start', 'failed', 'NOT DONE (refused by Pandesh Core before anything started): step 1 for the Coding agent: D:\\Other is outside the folders allowed. Nothing was started.')];
    const reply = missionNotStartedReply('gemma4:12b', lastMissionRefusal(calls));
    expect(reply).toMatch(/Pandesh Core refused the plan/);
    expect(reply).toMatch(/outside the folders allowed/);
    expect(reply).not.toMatch(/did not hand the work/);
    expect(lastMissionRefusal([call('mission_start', 'completed')])).toBeNull();
  });
});

describe('a started mission is a specialist hand-off', () => {
  const sentence = "I've assigned the work to the Operations specialist, and the Reviewer will check it.";
  it('backs the lead\'s sentence; without any hand-off the sentence is still withheld', () => {
    expect(unsupportedActionClaim(sentence, ['mission_start'])).toBeNull();
    expect(unsupportedActionClaim(sentence, ['delegate_to_agent'])).toBeNull();
    expect(unsupportedActionClaim(sentence, [])).not.toBeNull();
    expect(withholdUnsupportedActionClaims(`${sentence} You can keep talking to me.`, ['mission_start']).withheld).toEqual([]);
  });
});
