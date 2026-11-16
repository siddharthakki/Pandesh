import { describe, expect, it } from 'vitest';
import { buildLedger, cannotVerifyReply, citedTools, evidenceRetryPrompt, ledgerForLead, ledgerNeedsStatement, ledgerStatement, taskNeedsEvidence, userWordsOf } from '../runtime/delegationEvidence';

const KNOWN = ['find_skill', 'read_skill', 'read_file', 'calculate', 'update_task_outcome'];

describe('delegation evidence ledger', () => {
  it('asks for evidence when the user asks to check or evaluate, not for a plain lookup', () => {
    expect(taskNeedsEvidence('Ask your Reviewer specialist to evaluate your current skill-discovery approach. Report what it checked and what evidence it used.')).toBe(true);
    expect(taskNeedsEvidence('Verify the supplier prices in this folder')).toBe(true);
    expect(taskNeedsEvidence('Write a friendly birthday message')).toBe(false);
  });

  it('takes the user words out of a Core hand-off brief (the template itself says "evidence")', () => {
    const brief = 'The user asked Pandesh (their words): "Draft a poem"\nYou are the Reviewer agent: do this work yourself ... with its evidence (files)';
    expect(userWordsOf(brief)).toBe('Draft a poem');
    expect(taskNeedsEvidence(userWordsOf(brief))).toBe(false);
  });

  it('names only real tools, in any wording the model used', () => {
    expect(citedTools('Checked the interaction between `find_skill` and read_skill.', KNOWN).sort()).toEqual(['find_skill', 'read_skill']);
    expect(citedTools('Please calculate the total.', KNOWN)).toEqual([]);
    expect(citedTools('Used `calculate` on the totals', KNOWN)).toEqual(['calculate']);
  });

  it('separates what ran from what the report only names', () => {
    const ledger = buildLedger(
      [{ toolName: 'find_skill', status: 'succeeded' }, { toolName: 'read_file', status: 'failed' }, { toolName: 'update_task_outcome', status: 'succeeded' }],
      'I ran find_skill, then read_skill and read_file.', KNOWN);
    expect(ledger.verified).toEqual([{ tool: 'find_skill', count: 1 }]);
    expect(ledger.failed).toEqual(['read_file']);
    expect(ledger.unbacked.sort()).toEqual(['read_file', 'read_skill']);
    expect(ledgerNeedsStatement(ledger, true)).toBe(true);
    expect(ledgerStatement('Reviewer', ledger)).toMatch(/Verified by Pandesh Core.*find_skill/);
    expect(ledgerStatement('Reviewer', ledger)).toMatch(/Unverified: the report names read_file, read_skill/);
  });

  it('says Cannot verify when nothing ran, whatever the wording of the report', () => {
    const ledger = buildLedger([], 'The approach is sound; everything was verified.', KNOWN);
    expect(ledger.totalCalls).toBe(0);
    expect(ledgerNeedsStatement(ledger, true)).toBe(true);
    expect(ledgerStatement('Reviewer', ledger)).toMatch(/^Cannot verify/);
    expect(ledgerForLead('Reviewer', ledger)).toMatch(/nothing in its report was checked/);
  });

  it('stays silent when the work is backed and no evidence is demanded', () => {
    const ledger = buildLedger([{ toolName: 'read_file', status: 'succeeded' }], 'Summary of the file.', KNOWN);
    expect(ledgerNeedsStatement(ledger, true)).toBe(false);
    expect(ledgerNeedsStatement(buildLedger([], 'A poem.', KNOWN), false)).toBe(false);
  });

  it('writes the retry and the Cannot verify answer', () => {
    expect(evidenceRetryPrompt(['find_skill', 'update_task_outcome', 'read_file'])).toMatch(/find_skill, read_file/);
    expect(cannotVerifyReply('Reviewer', 'It looks fine.')).toMatch(/^Cannot verify: the Reviewer agent made no tool calls[\s\S]*Unverified opinion[\s\S]*It looks fine\./);
  });
});
