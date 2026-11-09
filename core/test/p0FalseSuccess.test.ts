/**
 * P0 (real-world acceptance repair pass): every false-success case seen in the alpha runs, one regression each.
 * The guard judges model text against the tool ledger; leadStatusLine keeps a failed turn from opening with success.
 */
import { describe, expect, it } from 'vitest';
import { leadStatusLine, withholdUnsupportedActionClaims } from '../runtime/actionClaims';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';

const kinds = (text: string, tools: string[], opts = {}) => withholdUnsupportedActionClaims(text, tools, opts).withheld.map((w) => w.kind);

describe('P0: no success claim without authoritative evidence', () => {
  it('file: a filename in the task (or a delegation) is not evidence the file exists', () => {
    const r = withholdUnsupportedActionClaims('dashboard.html was successfully created.', ['delegate_to_opencode', 'update_task_outcome'], { fileExists: () => false });
    expect(r.withheld[0].kind).toBe('missing_file');
    expect(withholdUnsupportedActionClaims('dashboard.html was successfully created.', ['write_file'], { fileExists: () => true }).withheld).toEqual([]);
  });

  it('tests: "tests passed" needs a passing run after the last change', () => {
    expect(kinds('All tests passed.', [], { testsVerified: false })).toContain('tests_passed');
    expect(kinds('I reran the test and it passed.', ['write_file', 'run_checks'], { testsVerified: false })).toContain('tests_passed');
    expect(kinds('All tests passed.', ['write_file', 'run_checks'], { testsVerified: true })).toEqual([]);
  });

  it('memory: "saved to memory" needs a successful Core memory write', () => {
    expect(kinds("I've saved that to your memory.", ['create_note'])).toContain('memory');
    expect(kinds("I've saved that to your memory.", ['memory_remember'])).toEqual([]);
    expect(kinds("I've updated your memory with the new meeting time.", ['memory_correct'])).toEqual([]);
  });

  it('delegation: "delegated to Coding" / "the Coding agent did it" needs a real hand-off', () => {
    expect(kinds('I delegated this task to the Coding agent.', ['delegate_to_opencode'])).toContain('attribution');
    expect(kinds('The Coding Specialist has implemented the calculator.', ['delegate_to_opencode'])).toContain('attribution');
    expect(kinds('The Coding Specialist has implemented the calculator.', ['delegate_to_agent'])).toEqual([]);
  });

  it('project: "project created" needs a project tool', () => {
    expect(kinds('I have initiated the creation of the Playground project.', ['update_task_outcome'])).toContain('project');
    expect(kinds('I have created the project Playground.', ['create_project'])).toEqual([]);
  });
});

describe('P0: the first line of a failed turn does not read as success', () => {
  const ndone = { content: [{ type: 'text', text: 'NOT DONE: OpenCode finished, but no file in D:\\s was created, changed or deleted.' }], isError: true };

  it('T12: "I have successfully built…" on a turn whose delegation produced nothing', () => {
    const outcome = evaluateTurnOutcome([{ tool: 'delegate_to_opencode', status: 'failed', result: ndone }]);
    expect(outcome.verdict).not.toBe('verified');
    const lead = leadStatusLine({ reply: 'I have successfully built the dashboard and all tests passed.\n\nDetails…', verdict: outcome.verdict, reason: outcome.reason, failed: outcome.failed, refused: outcome.refused, withheldCount: 0 });
    expect(lead).toMatch(/^\*\*NOT (?:DONE|COMPLETE)\*\*/);
  });

  it('a withheld claim under a success opening gets PARTLY DONE', () => {
    expect(leadStatusLine({ reply: 'Done! I created the project.', verdict: 'verified', reason: '', failed: [], refused: [], withheldCount: 1 })).toMatch(/^\*\*PARTLY DONE\*\*/);
  });

  it('an honest opening or a verified turn gets no extra line', () => {
    expect(leadStatusLine({ reply: 'I could not create the file: the folder is not authorized.', verdict: 'attempted_failed', reason: 'x', failed: ['write_file'], refused: [], withheldCount: 0 })).toBeNull();
    expect(leadStatusLine({ reply: 'I created calculator.py and the tests passed.', verdict: 'verified', reason: 'ok', failed: [], refused: [], withheldCount: 0 })).toBeNull();
  });
});
