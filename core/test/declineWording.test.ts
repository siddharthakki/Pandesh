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
