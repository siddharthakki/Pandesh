import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { explicitSpecialistRequest } from '../runtime/agentRouting';
import { withholdUnsupportedActionClaims } from '../runtime/actionClaims';
import { detectTestCommand, snapshotFiles, verifyDelegation } from '../runtime/delegationVerification';
import { groupsForText } from '../runtime/chatToolSelection';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-e2e-'));
const noRun = async () => ({ code: 0, stdout: '', stderr: '', timedOut: false });

describe('alpha e2e: a request addressed to a specialist is routed by Core', () => {
  it.each([
    ['Ask your Research specialist to investigate the latest stable Node.js release from official sources.', 'research'],
    ['Ask your Coding specialist to create a Python command-line calculator in my scratch workspace.', 'coding'],
    ['Ask Coding to inspect a file in a folder outside its authorized scratch workspace.', 'coding'],
    ['Ask Coding to fetch https://example.com while its internet permission is set to Deny.', 'coding'],
    ['Build a small dashboard. Delegate coding to Coding and verification to an appropriate specialist.', 'coding'],
    ['Have the research agent find three sources on heat pumps.', 'research'],
  ])('%s → %s', (text, agent) => {
    expect(explicitSpecialistRequest(text)).toBe(agent);
  });

  it.each([
    'What can the Coding agent do?',
    "Don't ask the Research specialist, just answer from memory.",
    'Get code to compile on Windows.',
    'Research the latest Node.js release.',
    'Write a Python calculator with tests.',
  ])('is not a hand-off: %s', (text) => {
    expect(explicitSpecialistRequest(text)).toBeNull();
  });
});

describe('alpha e2e: claims the guard now withholds', () => {
  it('T7: "rerun … passed" without a passing check after the last change', () => {
    const r = withholdUnsupportedActionClaims('I fixed the bug. The test was rerun after the fix, and it passed successfully.', ['write_file', 'run_checks'], { testsVerified: false });
    expect(r.withheld.map((w) => w.kind)).toContain('tests_passed');
    expect(r.text).not.toContain('passed successfully');
  });

  it('keeps the claim when a check passed after the last change', () => {
    const r = withholdUnsupportedActionClaims('All tests pass now.', ['write_file', 'run_checks'], { testsVerified: true });
    expect(r.withheld).toEqual([]);
  });

  it('does not treat a reported failure as a pass claim', () => {
    const r = withholdUnsupportedActionClaims('The test did not pass: AssertionError 6 != 5.', ['run_checks'], { testsVerified: false });
    expect(r.withheld).toEqual([]);
  });

  it('T3/T4: an agent credited with work it never received', () => {
    for (const text of ['The research was conducted by the **Research Specialist**.', 'The Coding Specialist has implemented the calculator.']) {
      const r = withholdUnsupportedActionClaims(text.replace(/\*\*/g, ''), ['web_research'], {});
      expect(r.withheld.map((w) => w.kind)).toContain('attribution');
    }
    expect(withholdUnsupportedActionClaims('The Research agent found Node.js 26.13.0.', ['delegate_to_agent']).withheld).toEqual([]);
    expect(withholdUnsupportedActionClaims('I could not reach the Research agent.', []).withheld).toEqual([]);
  });

  it('re-run T6b: a fact "has been removed" after only a recall', () => {
    const r = withholdUnsupportedActionClaims('2. **Removed Color:** The "Project color: orange" fact has been removed.', ['memory_recall']);
    expect(r.withheld.map((w) => w.kind)).toContain('memory');
    expect(withholdUnsupportedActionClaims('The colour fact has been removed.', ['memory_forget']).withheld).toEqual([]);
  });

  it('T10: "I have initiated the creation of the project" with no project tool', () => {
    const r = withholdUnsupportedActionClaims('I have initiated the creation of the Pandesh Alpha Playground project.', ['update_task_outcome']);
    expect(r.withheld.map((w) => w.kind)).toContain('project');
    expect(withholdUnsupportedActionClaims('I have created the project Pandesh Alpha Playground.', ['create_project']).withheld).toEqual([]);
    // Re-run T4: a coding project made of files that write_file really wrote.
    expect(withholdUnsupportedActionClaims('I have created the Python calculator project in your scratch workspace.', ['update_task_outcome', 'write_file', 'write_file', 'run_checks']).withheld).toEqual([]);
  });
});

describe('alpha e2e: verification of a plain Python folder', () => {
  it('T4: finds unittest tests without a manifest', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'calculator.py'), 'def add(a, b): return a + b\n');
    fs.writeFileSync(path.join(dir, 'test_calculator.py'), 'import unittest\n');
    expect(detectTestCommand(dir)).toBe('python -m unittest discover -v -p "*test*.py"');
  });

  it('T4: removes the .opencode/ folder a delegation left in a non-git folder', async () => {
    const dir = tmp();
    const before = snapshotFiles(dir);
    fs.mkdirSync(path.join(dir, '.opencode'));
    fs.writeFileSync(path.join(dir, '.opencode', 'opencode.json'), '{}');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    const v = await verifyDelegation(dir, new Set(), noRun, undefined, before);
    expect(v.removed).toEqual(['.opencode/']);
    expect(fs.existsSync(path.join(dir, '.opencode'))).toBe(false);
  });

  it('keeps a .opencode/ folder that existed before', async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, '.opencode'));
    const v = await verifyDelegation(dir, new Set(['.opencode']), noRun, undefined, snapshotFiles(dir));
    expect(v.removed).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.opencode'))).toBe(true);
  });
});

describe('alpha e2e: tool groups for software updates and projects', () => {
  it('T2 points at the PC group, T10 at projects', () => {
    expect(groupsForText('Scan my installed development and AI tools for available updates.').has('pc')).toBe(true);
    expect(groupsForText('Create a test project named Pandesh Alpha Playground with three tasks').has('projects')).toBe(true);
  });
});
