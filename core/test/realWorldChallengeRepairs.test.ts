/**
 * Real-world challenge (2026-11-09): regressions for defects seen live in the baseline, with paraphrases so the
 * repair is general rather than tied to one prompt.
 */
import { describe, expect, it } from 'vitest';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';

const kinds = (text: string, tools: string[]) => withholdUnsupportedActionClaims(text, tools).withheld.map((w) => w.kind);

describe('claim guard: a nearby word is not the object of the claim', () => {
  it.each([
    // Baseline T3 (memory write mentioning a project).
    ['I have recorded the review meeting for **Project Cedar** on Friday, November 13, 2026, at 10:00 AM in the Blue Room.', ['memory_remember']],
    ['I have saved the details of the Project Cedar review meeting.', ['memory_remember']],
    // Baseline T12 (a report built from meeting notes).
    ['I have created the HTML summary report based on the meeting notes and invoices.', ['read_file', 'write_file']],
    ['I have generated a summary of the meeting decisions and saved it as report.html.', ['write_file']],
    ['I created a dashboard listing your project tasks.', ['write_file']],
  ])('no false withhold: %s', (text, tools) => {
    expect(kinds(text.replace(/\*\*/g, ''), tools as string[])).toEqual([]);
  });

  it.each([
    ['I have scheduled the review meeting for Friday at 10 AM.', 'calendar'],
    ['I have added a new event to your calendar for tomorrow.', 'calendar'],
    ['The meeting has been moved to Monday.', 'calendar'],
    ['I have initiated the creation of the Pandesh Alpha Playground project.', 'project'],
    ['I have created the Home Office project with four tasks.', 'project'],
    ['Your new project has been created.', 'project'],
  ])('still withheld without a tool: %s', (text, kind) => {
    expect(kinds(text, ['read_file'])).toContain(kind);
  });
});

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderDelegationReport, snapshotFiles, testsCoverChanges, verifyDelegation } from '../runtime/delegationVerification';

describe('delegation verification: tests about other work do not verify this change (baseline T14)', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-cover-'));
  const passRun = async () => ({ code: 0, stdout: 'Ran 2 tests\nOK', stderr: '', timedOut: false });

  it('a new task board next to the expense tracker tests is untested', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'expense_tracker.py'), 'def add(): pass\n');
    fs.writeFileSync(path.join(dir, 'test_expense_tracker.py'), 'from expense_tracker import add\n');
    const before = snapshotFiles(dir);
    fs.writeFileSync(path.join(dir, 'app.py'), 'tasks = []\n');
    const v = await verifyDelegation(dir, new Set(), passRun, undefined, before);
    expect(v.test?.coversChanges).toBe(false);
    expect(renderDelegationReport(v)).toContain('do not cover the new or changed files');
  });

  it('a fix to a module its tests import is covered; new test files cover themselves', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'temperature.py'), 'x = 1\n');
    fs.writeFileSync(path.join(dir, 'test_temperature.py'), 'from temperature import x\n');
    expect(testsCoverChanges(dir, ['temperature.py'])).toBe(true);
    expect(testsCoverChanges(dir, ['board.py', 'test_board.py'])).toBe(true);
    expect(testsCoverChanges(dir, ['templates/index.html'])).toBe(false);
  });
});

import { undoOverEscapedQuotes } from '../runtime/piAgentEngine';

describe('write_file: quotes escaped twice by the tool call (baseline T11)', () => {
  it('restores a Python file whose every quote arrived escaped', () => {
    const sent = 'def f(c):\n    \\"\\"\\"Convert.\\"\\"\\"\n    return c * 9 / 5 + 32\n';
    expect(undoOverEscapedQuotes('temperature.py', sent)).toBe('def f(c):\n    """Convert."""\n    return c * 9 / 5 + 32\n');
  });
  it('leaves content with any bare quote, and non-code files, untouched', () => {
    const legit = 'print("say \\"hi\\"")\n';
    expect(undoOverEscapedQuotes('a.py', legit)).toBe(legit);
    expect(undoOverEscapedQuotes('photo.bin', 'x \\" y')).toBe('x \\" y');
    expect(undoOverEscapedQuotes('a.py', 'x = 1\n')).toBe('x = 1\n');
  });
});

import { enforceDeclineWording } from '../runtime/declineWording';
import { evaluateTurnOutcome } from '../runtime/turnOutcome';

describe('a declined extra step does not erase work that was done (Garden Shed Plan run)', () => {
  it('names only the declined step when other actions happened', () => {
    const declined = ['Not run: the user declined web access for this task. Nothing was changed.'];
    expect(enforceDeclineWording('The project is saved. It is protected by policy.', declined, { otherActionsDone: true }).text).toMatch(/^You declined that step, so it was not done\./);
    expect(enforceDeclineWording('It is protected by policy.', declined).text).toMatch(/^You declined this, so nothing was changed\./);
  });
  it('create_project and delegate_to_agent count as real actions in the turn verdict', () => {
    expect(evaluateTurnOutcome([{ tool: 'create_project', status: 'completed', result: { content: [{ type: 'text', text: 'Created project "X"' }] } }]).verdict).toBe('verified');
    expect(evaluateTurnOutcome([{ tool: 'delegate_to_agent', status: 'completed', result: { content: [{ type: 'text', text: 'RESULT FROM THE CODING AGENT' }] } }]).verdict).toBe('verified');
  });
});
