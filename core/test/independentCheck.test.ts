import { describe, it, expect } from 'vitest';
import { asksForIndependentCheck, independentCheckBrief, reviewerReport, reviewerTookPart } from '../runtime/independentCheck';
import { sameFileId } from '../domain/toolJournal';

describe('an independent check is asked for', () => {
  it.each([
    'Find the cause, fix it properly, and get the fix independently checked before you tell me it\'s done.',
    'Fix it and have another specialist review the changes.',
    'Write the report, then get a second opinion on the numbers.',
    'Have the reviewer check the draft before I see it.',
    'Clean this up and let someone else verify it.',
    'I want an independent review of the result.',
    'Please get it checked by a different agent.',
  ])('yes: %s', (text) => { expect(asksForIndependentCheck(text)).toBe(true); });

  it.each([
    'Fix the failing tests.',
    'Check the disk space and tell me what you find.',
    'Review this contract for me.',
    'Fix it; no need for an independent review.',
    'Do it without a second check, I trust you.',
    '',
  ])('no: %s', (text) => { expect(asksForIndependentCheck(text)).toBe(false); });
});

describe('who took part', () => {
  const call = (tool: string, args: unknown = {}, status = 'completed') => ({ tool, status, args });
  it('a reviewer hand-off or a mission counts; the lead re-running its own check does not', () => {
    expect(reviewerTookPart([call('write_file'), call('run_checks')])).toBe(false);
    expect(reviewerTookPart([call('delegate_to_agent', { agent: 'coding' })])).toBe(false);
    expect(reviewerTookPart([call('delegate_to_agent', { agent: 'reviewer' }, 'failed')])).toBe(false);
    expect(reviewerTookPart([call('delegate_to_agent', { agent: 'reviewer' })])).toBe(true);
    expect(reviewerTookPart([call('mission_start')])).toBe(true);
  });

  it('the brief carries recorded facts only: the request, the files changed, the checks run', () => {
    const brief = independentCheckBrief('Fix the tests and get it independently checked', [
      call('read_file', { filePath: 'src/totals.js' }), call('write_file', { filePath: 'D:\\p\\src\\totals.js' }), call('run_checks', { command: 'npm test' }), call('write_file', { filePath: 'D:\\p\\src\\totals.js' }),
    ]);
    expect(brief).toMatch(/Files it changed: D:\\p\\src\\totals\.js\./);
    expect(brief).toMatch(/Checks it ran itself: npm test\./);
    expect(brief).toMatch(/Do not rely on what the lead says/);
    expect(brief.length).toBeLessThanOrEqual(3_800);
  });

  it('separates the ledger from the reviewer\'s own words', () => {
    const r = reviewerReport('CORE EVIDENCE LEDGER (from the tool calls …):\n- Verified (tool calls that succeeded): read_file x2.\nThe report below is the agent\'s own text. Treat it so.\n\nRESULT FROM THE REVIEWER AGENT (completed in 20s; its task runs in its own conversation "Reviewer · x"):\n\nVerdict: ready.\n\nReport this to the user, saying the Reviewer agent did the work. Do not add facts it does not contain.');
    expect(r.ledger).toBe('- Verified (tool calls that succeeded): read_file x2.');
    expect(r.report).toBe('Verdict: ready.');
  });
});

describe('one file under two spellings', () => {
  it('is one file', () => {
    expect(sameFileId('D:\\proj\\test\\totals.test.js', 'test/totals.test.js')).toBe(true);
    expect(sameFileId('./src/a.ts', 'src\\a.ts')).toBe(true);
    expect(sameFileId('D:\\proj\\a\\notes.md', 'D:\\proj\\b\\notes.md')).toBe(false);
    expect(sameFileId('rem_1', 'rem_2')).toBe(false);
    expect(sameFileId('D:\\proj\\mytotals.test.js', 'totals.test.js')).toBe(false);
  });
});
