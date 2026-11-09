import { describe, expect, it } from 'vitest';
import { enforceDeclineWording } from '../runtime/declineWording';

const declined = 'Not written: the user declined file changes in this workspace for this task. Nothing was changed. Ask the user how to proceed.';

describe('D13/F3: a decline is the person\'s choice', () => {
  it('replaces "not authorized / protected area" wording with the fact (re-run F3 reply)', () => {
    const reply = "I've located `protected_config.txt`, but my attempt to update it was not authorized. Since the file is in the protected configuration area, it requires specific permission to modify. Please let me know how you'd like me to proceed or if you'd like me to perform a different action.";
    const out = enforceDeclineWording(reply, [declined]);
    expect(out.corrected).toBe(true);
    expect(out.text).toMatch(/^You declined this, so nothing was changed\./);
    expect(out.text).not.toMatch(/authori|protected configuration|requires specific permission/i);
    expect(out.text).toContain('how you\'d like me to proceed');
  });

  it('leaves a reply alone when nothing was declined or it already says so', () => {
    expect(enforceDeclineWording('This file is protected by a security policy.', ['EBUSY: resource busy']).corrected).toBe(false);
    expect(enforceDeclineWording('You declined the change, so nothing was changed.', [declined]).corrected).toBe(false);
  });
});

describe('D13/F3 retry wording', () => {
  it('drops "marked as protected" and the workaround offer', () => {
    const reply = "You declined this, so nothing was changed. I've located `protected_config.txt` in your workspace. Since this file is marked as protected, I cannot modify it directly. Would you like me to try a different approach or perform another action?";
    const out = enforceDeclineWording(reply, [declined]);
    expect(out.corrected).toBe(true);
    expect(out.text).not.toMatch(/marked as protected|different approach/i);
    expect(out.text).toMatch(/^You declined this, so nothing was changed\./);
  });
});

describe('declined memory write (tool-selection run)', () => {
  it('replaces "I don\'t have the permission" with the decline', () => {
    const memoryDeclined = 'The user declined this memory change. NOTHING was written. Do not claim it was remembered and do not retry it unless they ask again.';
    const reply = "I apologize, but I don't have the permission to store that specific information in my permanent memory right now. I'll be happy to keep it in mind for our current conversation!";
    const out = enforceDeclineWording(reply, [memoryDeclined]);
    expect(out.corrected).toBe(true);
    expect(out.text).toMatch(/^You declined this, so nothing was written\./);
    expect(out.text).not.toMatch(/permission/i);
    expect(out.text).toContain('keep it in mind for our current conversation');
  });
});
