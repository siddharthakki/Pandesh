/**
 * Pandesh's own run of a project's tests, for an A5 code change: once on the base the worker started from, once on the worker's result.
 * The comparison is what Pandesh knows independently of the worker: which tests regressed, which new tests pass or fail, and which tests
 * were already failing before the change (reported, never hidden behind "verified").
 *
 * Only the project's own declared test command runs (package.json `scripts.test`), in a clean environment, without a shell except for
 * `npm` on Windows. `node --test` projects are run with the TAP reporter so results are per test; any other command is judged by its exit
 * code only, and the report says so.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ProjectTestRun {
  /** The command as the owner would read it. */
  command: string;
  /** False when the project declares no test command or it could not start. */
  ran: boolean;
  ok: boolean;
  /** Per-test results ('node --test' projects); null when only the exit code is known. */
  tests: Record<string, 'pass' | 'fail'> | null;
  passed: number;
  failed: number;
  /** Last lines of output, for the evidence. */
  output: string;
  note: string | null;
}

export interface TestComparison {
  command: string;
  perTest: boolean;
  base: { ran: boolean; ok: boolean; passed: number; failed: number };
  after: { ran: boolean; ok: boolean; passed: number; failed: number };
  /** Passed before the change; fail (or are gone) after it. */
  regressions: string[];
  /** New tests that pass / fail. */
  newPassing: string[];
  newFailing: string[];
  /** Failed before the change and still fail: not the worker's doing, and never hidden. */
  preExistingFailing: string[];
  /** Failed before, pass after. */
  fixed: string[];
  note: string | null;
}

function cleanEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA'];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test', CI: '1' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** The project's declared test command, or null. */
export function projectTestCommand(dir: string): { script: string; nodeTestArgs: string[] | null } | null {
  let pkg: { scripts?: Record<string, unknown> } | null = null;
  try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
  const script = typeof pkg?.scripts?.test === 'string' ? pkg.scripts.test.trim() : '';
  if (!script || /no test specified/i.test(script)) return null;
  // `node --test [files…]` with nothing else (no shell operators): run it directly, per test.
  const m = /^node\s+--test((?:\s+[\w./*-]+)*)\s*$/.exec(script);
  const args = m ? (m[1] ?? '').trim().split(/\s+/).filter(Boolean) : null;
  return { script, nodeTestArgs: args && args.every(a => !a.startsWith('--') || a === '--test') ? args : null };
}

/** Parses node's TAP output into per-test results. Suites are kept as entries too (a suite fails when a test in it fails). */
export function parseTap(out: string): Record<string, 'pass' | 'fail'> {
  const results: Record<string, 'pass' | 'fail'> = {};
  const stack: string[] = [];
  for (const line of out.split(/\r?\n/)) {
    const sub = /^(\s*)# Subtest: (.+)$/.exec(line);
    if (sub) { const d = Math.floor(sub[1]!.length / 4); stack.length = d; stack[d] = sub[2]!.trim(); continue; }
    const r = /^(\s*)(not )?ok \d+ - (.+?)(?:\s+#\s*(SKIP|TODO)\b.*)?$/.exec(line);
    if (!r || r[4]) continue;
    const d = Math.floor(r[1]!.length / 4);
    const base = [...stack.slice(0, d), r[3]!.trim()].join(' > ');
    let key = base;
    // Every result line is one test: a name already seen is a second test with the same name (in another file).
    for (let n = 2; results[key] !== undefined; n++) key = `${base} #${n}`;
    results[key] = r[2] ? 'fail' : 'pass';
  }
  return results;
}

/** Runs the project's tests in `dir`. Never throws. */
export function runProjectTests(dir: string, timeoutMs = 5 * 60_000): ProjectTestRun {
  const cmd = projectTestCommand(dir);
  if (!cmd) return { command: 'none', ran: false, ok: false, tests: null, passed: 0, failed: 0, output: '', note: 'the project declares no test command (package.json scripts.test)' };
  if (cmd.nodeTestArgs) {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...cmd.nodeTestArgs], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: cleanEnv() });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.error) return { command: cmd.script, ran: false, ok: false, tests: null, passed: 0, failed: 0, output: out.slice(-1_500), note: `the tests could not run: ${String(r.error.message).slice(0, 200)}` };
    const tests = parseTap(String(r.stdout ?? ''));
    // Count leaf tests only for the summary: a name that is a prefix of another entry is a suite.
    const keys = Object.keys(tests);
    const leaves = keys.filter(k => !keys.some(o => o !== k && o.startsWith(`${k} > `)));
    const failed = leaves.filter(k => tests[k] === 'fail').length;
    return { command: cmd.script, ran: true, ok: r.status === 0, tests, passed: leaves.length - failed, failed, output: out.slice(-1_500), note: r.status === null ? 'the test run timed out' : null };
  }
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'npm.cmd' : 'npm', ['test'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: cleanEnv(), shell: win });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.error) return { command: 'npm test', ran: false, ok: false, tests: null, passed: 0, failed: 0, output: out.slice(-1_500), note: `the tests could not run: ${String(r.error.message).slice(0, 200)}` };
  return { command: 'npm test', ran: true, ok: r.status === 0, tests: null, passed: 0, failed: 0, output: out.slice(-1_500), note: `only the exit code of \`${cmd.script}\` is known (not a plain node --test command)` };
}

/** What changed between the base run and the run on the change. */
export function compareTestRuns(base: ProjectTestRun, after: ProjectTestRun): TestComparison {
  const summary = (r: ProjectTestRun) => ({ ran: r.ran, ok: r.ok, passed: r.passed, failed: r.failed });
  const c: TestComparison = { command: after.command, perTest: Boolean(base.tests && after.tests), base: summary(base), after: summary(after), regressions: [], newPassing: [], newFailing: [], preExistingFailing: [], fixed: [], note: after.note ?? base.note };
  if (base.tests && after.tests) {
    const leaf = (t: Record<string, string>, k: string) => !Object.keys(t).some(o => o !== k && o.startsWith(`${k} > `));
    for (const [k, v] of Object.entries(base.tests)) {
      if (!leaf(base.tests, k)) continue;
      const now = after.tests[k];
      if (v === 'pass' && now !== 'pass') c.regressions.push(now ? k : `${k} (removed)`);
      else if (v === 'fail' && now === 'fail') c.preExistingFailing.push(k);
      else if (v === 'fail' && now === 'pass') c.fixed.push(k);
    }
    for (const [k, v] of Object.entries(after.tests)) {
      if (base.tests[k] !== undefined || !leaf(after.tests, k)) continue;
      (v === 'pass' ? c.newPassing : c.newFailing).push(k);
    }
  }
  return c;
}

/**
 * The verdict on a code change's tests. `fail` goes back to the worker with the reason; `ok` is a pass with what to report (pre-existing
 * failures included). `testsRequested`: the task asked for tests, so at least one new (or newly passing) test is required.
 */
export function judgeTests(c: TestComparison, testsRequested: boolean): { ok: boolean; what: string; report: string } {
  const list = (xs: string[]) => xs.slice(0, 8).join('; ') + (xs.length > 8 ? `; and ${xs.length - 8} more` : '');
  const pre = c.preExistingFailing.length ? ` ${c.preExistingFailing.length} test(s) were already failing before the change and still fail (not caused by it): ${list(c.preExistingFailing)}.` : '';
  if (!c.after.ran) return { ok: !testsRequested, what: `the tests could not be run: ${c.note ?? 'unknown reason'}`, report: `Pandesh could not run the project's tests (${c.note ?? 'unknown reason'}).` };
  if (c.perTest) {
    if (c.regressions.length) return { ok: false, what: `${c.regressions.length} test(s) that passed before the change now fail: ${list(c.regressions)}`, report: '' };
    if (c.newFailing.length) return { ok: false, what: `${c.newFailing.length} new test(s) fail: ${list(c.newFailing)}`, report: '' };
    if (testsRequested && !c.newPassing.length && !c.fixed.length) return { ok: false, what: 'the task asked for tests, but no new test was added (or made to pass)', report: '' };
    return {
      ok: true, what: '',
      report: `Pandesh ran \`${c.command}\` before and after the change: ${c.after.passed} pass, ${c.after.failed} fail after (before: ${c.base.passed} pass, ${c.base.failed} fail). New tests passing: ${c.newPassing.length ? list(c.newPassing) : 'none'}. No regressions.${c.fixed.length ? ` Now passing: ${list(c.fixed)}.` : ''}${pre}`,
    };
  }
  // Exit code only.
  if (c.after.ok) return { ok: true, what: '', report: `Pandesh ran \`${c.command}\` on the change: it passes (exit code only; ${c.note ?? 'no per-test results'}).` };
  if (c.base.ran && c.base.ok) return { ok: false, what: `\`${c.command}\` passed before the change and fails after it`, report: '' };
  return { ok: true, what: '', report: `Pandesh ran \`${c.command}\`: it fails both before and after the change, so Pandesh cannot tell from the exit code whether the change broke anything (${c.note ?? 'no per-test results'}). Check the test output in the review.` };
}
