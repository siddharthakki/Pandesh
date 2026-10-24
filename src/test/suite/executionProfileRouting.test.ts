import { describe, expect, it } from 'vitest';
import {
  analyzeDeterministicFileWrite,
  classifyExecutionProfile,
  escalateExecutionProfile,
  parseDeterministicFileWrite,
} from '../../orchestration/ExecutionProfile';

describe('ExecutionProfile routing', () => {
  it('classifies the exact acceptance-scenario request as trivial with the multi-agent graph skipped', () => {
    const profile = classifyExecutionProfile('add a new file test.txt and write only Hello in it');
    expect(profile.tier).toBe('trivial');
    expect(profile.maxStages).toBe(0);
    expect(profile.useDeterministicProposal).toBe(true);
  });

  it('deterministically extracts the exact path and content for the acceptance scenario', () => {
    const write = parseDeterministicFileWrite('add a new file test.txt and write only Hello in it');
    expect(write).toEqual({ path: 'test.txt', content: 'Hello' });
  });

  it('extracts content for "write exactly" phrasing too', () => {
    const write = parseDeterministicFileWrite('create notes.md and write exactly Done into it');
    expect(write).toEqual({ path: 'notes.md', content: 'Done' });
  });

  it('extracts the packaged containing phrasing and applies the latest filename steering', () => {
    expect(parseDeterministicFileWrite('create note.txt containing Hello')).toEqual({
      path: 'note.txt',
      content: 'Hello',
    });
    expect(parseDeterministicFileWrite(
      'create note.txt containing Hello\n\nSteering guidance from the user:\n[1] Use greeting.txt instead',
    )).toEqual({
      path: 'greeting.txt',
      content: 'Hello',
    });
  });

  it.each([
    ['create note.txt containing Hello', { path: 'note.txt', content: 'Hello' }],
    ['create note.txt with Hello', { path: 'note.txt', content: 'Hello' }],
    ['create a file note.txt containing Hello', { path: 'note.txt', content: 'Hello' }],
    ['add note.txt containing Hello', { path: 'note.txt', content: 'Hello' }],
    ['add a new file note.txt and write only Hello in it', { path: 'note.txt', content: 'Hello' }],
    ['make note.txt with the exact content Hello', { path: 'note.txt', content: 'Hello' }],
    ['create docs/greeting.txt containing "Hello world"', { path: 'docs/greeting.txt', content: 'Hello world' }],
    ['create empty.txt containing ""', { path: 'empty.txt', content: '' }],
  ])('accepts bounded deterministic wording: %s', (goal, expected) => {
    expect(parseDeterministicFileWrite(goal)).toEqual(expected);
    expect(classifyExecutionProfile(goal)).toMatchObject({ tier: 'trivial', maxStages: 0 });
  });

  it('rejects traversal, ambiguous extra work, and multiple-file requests deterministically', () => {
    expect(analyzeDeterministicFileWrite('create ../secret.txt containing nope').reason).toBe('unsafe_path');
    expect(analyzeDeterministicFileWrite('create a.txt containing Hello and also update README.md').reason).toBe('ambiguous_content');
    expect(analyzeDeterministicFileWrite('create a.txt and b.txt containing Hello').write).toBeUndefined();
  });

  it('classifies a small bounded coding task (low complexity, not exact-content) as small, not trivial', () => {
    const profile = classifyExecutionProfile('fix a simple typo in the README file');
    expect(profile.tier).toBe('small');
    expect(profile.maxStages).toBe(1);
    expect(profile.useDeterministicProposal).toBe(false);
  });

  it('classifies a normal coding task (medium complexity) as normal', () => {
    const profile = classifyExecutionProfile('fix the pagination bug in the search results component');
    expect(profile.tier).toBe('normal');
    expect(profile.maxStages).toBe(1);
  });

  it('classifies a complex architectural task as complex even if it looks like an exact file write', () => {
    const profile = classifyExecutionProfile('redesign the cross-cutting authentication architecture and write only the new module in it');
    expect(profile.tier).toBe('complex');
    expect(profile.useDeterministicProposal).toBe(false);
  });

  it('never treats a read-only explanation request as a mutation tier', () => {
    const profile = classifyExecutionProfile('explain how the retry queue works');
    expect(profile.requirements.fileMutation).toBe(false);
    expect(profile.useDeterministicProposal).toBe(false);
  });

  it('escalates exactly one tier and records the reason and prior tier, never regressing', () => {
    const trivial = classifyExecutionProfile('add a new file test.txt and write only Hello in it');
    const escalated = escalateExecutionProfile(trivial, 'create_target_exists');
    expect(escalated.tier).toBe('small');
    expect(escalated.maxStages).toBe(1);
    expect(escalated.useDeterministicProposal).toBe(false);
    expect(escalated.escalation).toEqual({ fromTier: 'trivial', reason: 'create_target_exists' });

    const escalatedAgain = escalateExecutionProfile(escalated, 'validation_failed');
    expect(escalatedAgain.tier).toBe('normal');

    const complex = escalateExecutionProfile(escalateExecutionProfile(escalatedAgain, 'x'), 'y');
    expect(complex.tier).toBe('complex');
    // Escalating past 'complex' stays bounded at 'complex'.
    expect(escalateExecutionProfile(complex, 'z').tier).toBe('complex');
  });

  it('does not classify a plain rename/value/append instruction as trivial when it also implies repo-wide scope', () => {
    const profile = classifyExecutionProfile('rename one file as part of the system-wide migration');
    expect(profile.tier).not.toBe('trivial');
  });
});
