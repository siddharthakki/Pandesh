import { describe, expect, it } from 'vitest';
import { isTransientIndexLockFailure } from '../../activation/M15AutonomousRuntime';

describe('delivery git index.lock contention', () => {
  it('recognizes the transient lock failure seen in the release UAT', () => {
    expect(isTransientIndexLockFailure("fatal: Unable to create 'C:/repo/.git/worktrees/att_1/index.lock': File exists.\n\nAnother git process seems to be running in this repository")).toBe(true);
  });

  it('does not treat other git failures as transient', () => {
    expect(isTransientIndexLockFailure('fatal: pathspec did not match any files')).toBe(false);
    expect(isTransientIndexLockFailure('nothing to commit, working tree clean')).toBe(false);
  });
});
