/**
 * P1 (Build 161 audit): a tool that succeeded must not be reported as refused because of words in its output.
 *
 * The turn verdict tested the refusal wording against a tool's WHOLE result text before its error flag. A passing test
 * run prints whatever the tests print, and "connection refused", "permission denied" or "request rejected" are ordinary
 * lines in a green suite that exercises error handling: the turn was then reported as refused although the command ran
 * and passed. A refusal is what a tool says about itself — at the start of its result — or a result marked as an error.
 */
import { describe, expect, it } from 'vitest';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';

const call = (tool: string, text: string, isError = false, success?: boolean) => ({
  tool, status: 'completed',
  result: { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}), ...(success !== undefined ? { details: { success } } : {}) },
});

describe('the turn verdict reads what a tool says about itself, not words in its output', () => {
  it('a passing check whose output mentions refusals or denials counts as performed', () => {
    const output = 'Check passed with output:\n✓ retries when the connection is refused\n✓ reports permission denied for a locked file\n✓ a rejected token is not stored\n\n 3 passed';
    const outcome = evaluateTurnOutcome([call('run_checks', output, false, true)] as never);
    expect(outcome.refused).toEqual([]);
    expect(outcome.performed).toEqual(['run_checks']);
  });

  it('a written file whose name or note mentions a refusal counts as written', () => {
    const outcome = evaluateTurnOutcome([call('write_file', 'Successfully wrote file: D:\\work\\declined-repairs.md', false, true)] as never);
    expect(outcome.refused).toEqual([]);
    expect(outcome.performed).toEqual(['write_file']);
  });

  it('without a declared success, only the tool\'s own first line is read: output below it is not a refusal', () => {
    const outcome = evaluateTurnOutcome([call('print_test_page', 'Sent the test page to HP-OfficeJet.\nPrinter log: earlier job was rejected (paper out).')] as never);
    expect(outcome.performed).toEqual(['print_test_page']);
  });

  it('a tool that says it was refused, or an error result that says so, still counts as refused', () => {
    expect(evaluateTurnOutcome([call('run_checks', 'Not run: the user did not approve this command (runs code in this workspace). Nothing was changed.', true)] as never).refused).toEqual(['run_checks']);
    expect(evaluateTurnOutcome([call('write_file', 'NOT DONE: the user declined writing notes.md.')] as never).refused).toEqual(['write_file']);
    expect(evaluateTurnOutcome([call('gmail_create_draft', 'Gmail is not connected, so no draft was created.')] as never).refused).toEqual(['gmail_create_draft']);
  });
});
