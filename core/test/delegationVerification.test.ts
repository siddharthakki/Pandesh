import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { detectTestCommand, renderDelegationReport, untrackedPaths, verifyDelegation, type CommandRunner } from '../runtime/delegationVerification';

const roots: string[] = [];
afterAll(() => { for (const r of roots) fs.rmSync(r, { recursive: true, force: true }); });

const run: CommandRunner = async (command, cwd) => {
  const r = cp.spawnSync(command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, timeout: 120_000 });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', timedOut: false };
};

/** The M8 fixture shape: a small Node project with an off-by-one bug and one failing `node --test` test. */
function m8Fixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-d12-'));
  roots.push(dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.mkdirSync(path.join(dir, 'test'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cart', private: true, scripts: { test: 'node --test' } }));
  fs.writeFileSync(path.join(dir, 'src', 'cart.js'), 'function cartTotal(items) {\n  let sum = 0;\n  for (let i = 1; i < items.length; i++) sum += items[i].price * items[i].qty;\n  return sum;\n}\nmodule.exports = { cartTotal };\n');
  fs.writeFileSync(path.join(dir, 'test', 'cart.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { cartTotal } = require('../src/cart');\ntest('sums every item', () => assert.strictEqual(cartTotal([{ price: 2, qty: 1 }, { price: 3, qty: 2 }]), 8));\n");
  const g = (...args: string[]) => cp.execFileSync('git', args, { cwd: dir, windowsHide: true });
  g('init', '-q'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.'); g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'fixture');
  return dir;
}

describe('verifyDelegation (audit D12)', () => {
  it('after a real fix: shows the git diff, removes the .opencode/ it created, re-runs the tests and reports PASSED', async () => {
    const dir = m8Fixture();
    const before = untrackedPaths(dir);
    // What OpenCode did in M8: the one-line fix, plus its own working folder.
    fs.writeFileSync(path.join(dir, 'src', 'cart.js'), fs.readFileSync(path.join(dir, 'src', 'cart.js'), 'utf8').replace('let i = 1', 'let i = 0'));
    fs.mkdirSync(path.join(dir, '.opencode'));
    fs.writeFileSync(path.join(dir, '.opencode', 'session.json'), '{}');

    const v = await verifyDelegation(dir, before, run);
    expect(v.changedFiles).toEqual(['src/cart.js']);
    expect(v.removed).toEqual(['.opencode/']);
    expect(fs.existsSync(path.join(dir, '.opencode'))).toBe(false);
    expect(v.newUntracked).toEqual([]);
    expect(v.testFilesChanged).toEqual([]);
    expect(v.test).toMatchObject({ command: 'npm test', code: 0 });
    expect(v.diff).toContain('-  for (let i = 1;');
    expect(v.diff).toContain('+  for (let i = 0;');
    const report = renderDelegationReport(v);
    expect(report).toContain('**PASSED**');
    expect(report).toContain('```diff');
  }, 180_000);

  it('a fix that only edits the test is flagged, and a still-failing run is reported as FAILED', async () => {
    const dir = m8Fixture();
    const before = untrackedPaths(dir);
    fs.writeFileSync(path.join(dir, 'test', 'cart.test.js'), fs.readFileSync(path.join(dir, 'test', 'cart.test.js'), 'utf8').replace('), 8)', '), 999)'));
    const v = await verifyDelegation(dir, before, run);
    expect(v.testFilesChanged).toEqual(['test/cart.test.js']);
    const report = renderDelegationReport(v);
    expect(report).toMatch(/Warning:\*\* test files were changed/);
    expect(report).toMatch(/FAILED \(exit [1-9]/);
  }, 180_000);

  it('never deletes a .opencode/ that existed before the delegation', async () => {
    const dir = m8Fixture();
    fs.mkdirSync(path.join(dir, '.opencode'));
    fs.writeFileSync(path.join(dir, '.opencode', 'mine.json'), '{}');
    const before = untrackedPaths(dir);
    const v = await verifyDelegation(dir, before, run);
    expect(v.removed).toEqual([]);
    expect(fs.existsSync(path.join(dir, '.opencode', 'mine.json'))).toBe(true);
  }, 180_000);

  it('detects the project test command', () => {
    const dir = m8Fixture();
    expect(detectTestCommand(dir)).toBe('npm test');
    expect(detectTestCommand(os.tmpdir())).toBeNull();
  });
});
