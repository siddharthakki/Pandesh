import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { discoverSyntaxGates, discoverValidationGates, runWorkspaceValidation } from '../runtime/workspaceValidation';
import { applyValidationSummary, type MissionEvidence } from '../runtime/missionObservations';
import { reconcileExecutionClaims } from '../runtime/executionClaims';
import { deriveValidationEnvelope } from '../../src/coding/ValidationFloor';
import { CodingValidationRunner } from '../../src/coding/ValidationRunner';

/**
 * g1: the delete-confirmation edit left cli.js syntactically invalid while `npm test` (which only imports expenses.js)
 * passed, and the model's closing message claimed "4/4" tests over a 2-test suite plus a command session nothing ran.
 */

const EXPENSES = "'use strict';\nfunction createStore() { const items = []; return { add(d, a) { items.push({ d, a }); }, list() { return items.slice(); } }; }\nmodule.exports = { createStore };\n";
const EXPENSES_TEST = "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { createStore } = require('../expenses');\ntest('adds', () => { const s = createStore(); s.add('a', 1); assert.equal(s.list().length, 1); });\ntest('lists', () => { assert.equal(createStore().list().length, 0); });\n";
const CLI_VALID = "'use strict';\nconst { createStore } = require('./expenses');\nconst store = createStore();\ntry {\n  store.add('x', 1);\n} catch (error) {\n  console.log(error.message);\n}\n";
// The shape that crashed g1 attempt 2: a stray closing brace leaves `catch` without its `try`.
const CLI_BROKEN = "'use strict';\nconst { createStore } = require('./expenses');\nconst store = createStore();\n  }\n} catch (error) {\n  console.log(error.message);\n}\n";

let dir: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkd-syntax-floor-'));
  write('package.json', JSON.stringify({ name: 'expense-tracker', version: '1.0.0', private: true, scripts: { test: 'node --test' } }));
  write('expenses.js', EXPENSES);
  write('test/expenses.test.js', EXPENSES_TEST);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function validate(changedPath: string) {
  return runWorkspaceValidation({
    cwd: dir,
    gates: discoverValidationGates(dir),
    syntaxGates: discoverSyntaxGates(dir, [changedPath]),
  });
}

const EMPTY_EVIDENCE: MissionEvidence = { approvedMutation: true, validationPassed: false, diffReview: 'pending' };

describe('JavaScript syntax floor (Core validation)', () => {
  it('fails validation when a changed cli.js is syntactically invalid, even though npm test passes', async () => {
    write('cli.js', CLI_BROKEN);
    const outcome = await validate('cli.js');
    expect(outcome.passed).toBe(false);
    expect(outcome.results[0].gate.command).toBe('node --check "cli.js"');
    expect(outcome.results[0].status).toBe('failed');
    expect(outcome.results[0].output).toMatch(/SyntaxError/);
    // The unit-test gate genuinely passes: only the syntax floor catches this.
    expect(outcome.results[1].status).toBe('passed');
    expect(outcome.summary.startsWith('Validation: failed')).toBe(true);
    // ...and the mission evidence takes the normal failed-validation / repair path.
    const evidence = applyValidationSummary(EMPTY_EVIDENCE, outcome.summary);
    expect(evidence.validationPassed).toBe(false);
    expect(evidence.validationExitCode).not.toBe(0);
  });

  it('lets a repair correct the file and revalidates to a pass', async () => {
    write('cli.js', CLI_BROKEN);
    expect((await validate('cli.js')).passed).toBe(false);
    write('cli.js', CLI_VALID);
    const repaired = await validate('cli.js');
    expect(repaired.passed).toBe(true);
    expect(repaired.results.map(result => result.status)).toEqual(['passed', 'passed']);
    expect(applyValidationSummary(EMPTY_EVIDENCE, repaired.summary).validationPassed).toBe(true);
  });

  it('still passes valid JavaScript, including ESM syntax in a .mjs file', async () => {
    write('cli.js', CLI_VALID);
    expect((await validate('cli.js')).passed).toBe(true);
    write('tool.mjs', "import { readFileSync } from 'node:fs';\nexport const size = (file) => readFileSync(file).length;\n");
    const outcome = await validate('tool.mjs');
    expect(outcome.passed).toBe(true);
    expect(outcome.results[0].gate.command).toBe('node --check "tool.mjs"');
  });

  it('only builds syntax gates for existing, in-workspace .js/.cjs/.mjs files', () => {
    write('notes.md', '# hi');
    write('ok.cjs', 'module.exports = 1;\n');
    const gates = discoverSyntaxGates(dir, ['notes.md', 'missing.js', '../escape.js', 'bad";name.js', 'ok.cjs', 'ok.cjs']);
    expect(gates.map(gate => gate.command)).toEqual(['node --check "ok.cjs"']);
  });
});

describe('model execution claims are not evidence', () => {
  const RECORDED_NODE_TEST = '\nValidation: passed\n- npm run test (unit_test) — passed, exit 0\n> expense-tracker@1.0.0 test\n> node --test\n\n✔ adds (0.7ms)\n✔ lists (0.4ms)\nℹ tests 2\nℹ suites 0\nℹ pass 2\nℹ fail 0\n';

  it('cannot override recorded test evidence with an unsupported "4/4 tests passed"', () => {
    const message = 'Done — delete now asks first.\n\nValidation: npm run test passed (4/4).\n\nReady to review.';
    const result = reconcileExecutionClaims(message, [RECORDED_NODE_TEST]);
    expect(result.text).not.toContain('4/4');
    expect(result.text).toContain('[Unverified');
    expect(result.text).toContain('Done — delete now asks first.');
    expect(result.withheld).toEqual([expect.objectContaining({ kind: 'test_counts' })]);
  });

  it('keeps a test count that a recorded run actually reports', () => {
    const result = reconcileExecutionClaims('Validation: npm run test passed (2/2).', [RECORDED_NODE_TEST]);
    expect(result.text).toBe('Validation: npm run test passed (2/2).');
    expect(result.withheld).toEqual([]);
  });

  it('does not promote a fabricated command transcript to evidence', () => {
    const message = 'Changed cli.js.\n\n> delete 1\nDelete #1: lunch - 12.00? (y/n)\nn\nCancelled.\n\nNothing else changed.';
    const result = reconcileExecutionClaims(message, [RECORDED_NODE_TEST]);
    expect(result.text).not.toContain('Delete #1: lunch');
    expect(result.text).not.toContain('Cancelled.');
    expect(result.text).toContain('[Unverified');
    expect(result.text).toContain('Changed cli.js.');
    expect(result.text).toContain('Nothing else changed.');
    expect(result.withheld).toEqual([expect.objectContaining({ kind: 'command_transcript' })]);
  });

  it('keeps a transcript whose output a recorded command really produced', () => {
    const recorded = 'Added #1: lunch - 12.00\nDeletion cancelled\n';
    const message = '$ node cli.js\nAdded #1: lunch - 12.00\nDeletion cancelled';
    const result = reconcileExecutionClaims(message, [recorded]);
    expect(result.text).toBe(message);
    expect(result.withheld).toEqual([]);
  });

  it('leaves ordinary descriptions of the change untouched', () => {
    const message = 'I added a delete command in cli.js that asks y/n before removing an expense (see lines 14/20 of the diff).';
    expect(reconcileExecutionClaims(message, []).text).toBe(message);
  });
});

describe('JavaScript syntax floor (extension ValidationFloor / CodingValidationRunner)', () => {
  it('adds a node-check for each changed JS production file, and runs it through the existing runner', async () => {
    write('cli.js', CLI_BROKEN);
    const envelope = await deriveValidationEnvelope({ workspaceRoot: dir, changedPaths: ['cli.js'], modelCommands: [{ kind: 'git-diff-check' }] });
    expect(envelope.floorAdded).toContainEqual({ kind: 'node-check', args: ['cli.js'] });
    expect(envelope.commands.map(command => command.kind)).toContain('npm-test');

    const runner = new CodingValidationRunner(dir, 30_000);
    const broken = await runner.runAll([{ kind: 'node-check', args: ['cli.js'] }]);
    expect(broken[0].exitCode).not.toBe(0);
    expect(broken[0].output).toMatch(/SyntaxError/);

    write('cli.js', CLI_VALID);
    const repaired = await runner.runAll([{ kind: 'node-check', args: ['cli.js'] }]);
    expect(repaired[0].exitCode).toBe(0);
  });

  it('refuses a node-check that escapes the workspace or targets a non-JS file', async () => {
    const runner = new CodingValidationRunner(dir, 30_000);
    const results = await runner.runAll([{ kind: 'node-check', args: ['../outside.js'] }, { kind: 'node-check', args: ['package.json'] }]);
    expect(results.map(result => result.exitCode)).toEqual([null, null]);
  });
});
