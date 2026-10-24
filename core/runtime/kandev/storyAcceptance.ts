/**
 * Independent acceptance for development stories.
 *
 * A worker can pass its own tests and still deliver the wrong behaviour (a `split(/\s/)` word count passed its own
 * weak test). So KKD owns two things the worker never sees or edits:
 *  - the story's acceptance checks, stored on the story in KKD's database (not in any worktree), and
 *  - the runner that executes them, written under KKD's own data directory and pointed at the worker's tree.
 * Checks are either declarative `examples` (call an exported function with arguments, compare with the expected value)
 * or a trusted `script` (exit code 0 = accepted). The worker's prompt carries the natural-language criteria only,
 * never the example values.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runHardenedGit } from '../../security/hardenedGit';
import { CoreError } from '../../domain/errors';

export interface AcceptanceExample { name?: string; args: unknown[]; expected: unknown }
export type AcceptanceCheck =
  | { kind: 'examples'; name: string; module: string; export?: string; cases: AcceptanceExample[] }
  | { kind: 'script'; name: string; source: string }
  /** Cannot be automated (a physical phone, a human judgement). Never run and never counted as passed: the story is labelled "awaiting device verification". */
  | { kind: 'device'; name: string; instructions: string };

export interface AcceptanceResult { ok: boolean; total: number; passed: number; evidence: string; names: string[] }

/** Trusted check scripts a person (or the operator) prepared; outside every worktree, so a worker can neither see nor edit them. */
export function trustedChecksDir(): string {
  const home = process.env.KARKEDIKHA_KANDEV_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kkd-kandev');
  return path.join(home, 'trusted-checks');
}

/** The automated checks (everything but `device`). */
export const automatedChecks = (checks: AcceptanceCheck[]) => checks.filter(c => c.kind !== 'device');
export const deviceChecks = (checks: AcceptanceCheck[]) => checks.filter((c): c is Extract<AcceptanceCheck, { kind: 'device' }> => c.kind === 'device');

const MAX_CASES = 200;
const MAX_SCRIPT = 60_000;

/** Rejects malformed checks at planning time, so a typo cannot turn into a silently skipped check. */
export function validateAcceptanceChecks(storyKey: string, checks: unknown): AcceptanceCheck[] {
  if (checks === undefined || checks === null) return [];
  if (!Array.isArray(checks)) throw new CoreError('invalid_request', `story '${storyKey}': acceptanceChecks must be a list`);
  return checks.map((raw, i) => {
    const c = raw as Partial<AcceptanceCheck> & Record<string, unknown>;
    const where = `story '${storyKey}' acceptance check #${i + 1}`;
    const name = typeof c.name === 'string' && c.name.trim() ? c.name.trim().slice(0, 80) : `check ${i + 1}`;
    if (c.kind === 'device') {
      if (typeof c.instructions !== 'string' || !c.instructions.trim()) throw new CoreError('invalid_request', `${where}: device checks need instructions for the person who verifies on the device`);
      return { kind: 'device', name, instructions: c.instructions.trim().slice(0, 2_000) };
    }
    if (c.kind === 'script' && typeof c.sourceFile === 'string') {
      // Loaded now and stored on the story: the file must live in KKD's trusted-checks directory, nowhere else.
      const root = path.resolve(trustedChecksDir()).toLowerCase() + path.sep;
      const file = path.resolve(c.sourceFile);
      if (!file.toLowerCase().startsWith(root) || !fs.existsSync(file)) throw new CoreError('invalid_request', `${where}: sourceFile must be an existing file under ${trustedChecksDir()}`);
      const source = fs.readFileSync(file, 'utf8');
      if (!source.trim() || source.length > MAX_SCRIPT) throw new CoreError('invalid_request', `${where}: script file is empty or over ${MAX_SCRIPT} chars`);
      return { kind: 'script', name, source };
    }
    if (c.kind === 'script') {
      if (typeof c.source !== 'string' || !c.source.trim() || c.source.length > MAX_SCRIPT) throw new CoreError('invalid_request', `${where}: script source is required (max ${MAX_SCRIPT} chars)`);
      return { kind: 'script', name, source: c.source };
    }
    if (c.kind !== 'examples') throw new CoreError('invalid_request', `${where}: kind must be 'examples' or 'script'`);
    const mod = typeof c.module === 'string' ? c.module.replace(/\\/g, '/') : '';
    if (!mod || path.isAbsolute(mod) || path.win32.isAbsolute(mod) || path.posix.isAbsolute(mod) || mod.split('/').includes('..')) throw new CoreError('invalid_request', `${where}: module must be a path relative to the repository`);
    const cases = (c.cases ?? []) as AcceptanceExample[];
    if (!Array.isArray(cases) || !cases.length || cases.length > MAX_CASES) throw new CoreError('invalid_request', `${where}: 1-${MAX_CASES} cases are required`);
    for (const k of cases) {
      if (!k || !Array.isArray(k.args) || !('expected' in k)) throw new CoreError('invalid_request', `${where}: every case needs args (a list) and expected`);
      try { JSON.stringify(k); } catch { throw new CoreError('invalid_request', `${where}: cases must be JSON-serializable`); }
    }
    const exp = typeof c.export === 'string' && /^[\w$]+$/.test(c.export) ? c.export : undefined;
    return { kind: 'examples', name, module: mod, ...(exp ? { export: exp } : {}), cases: cases.map(k => ({ ...(k.name ? { name: String(k.name).slice(0, 80) } : {}), args: k.args, expected: k.expected })) };
  });
}

/** Where KKD keeps runner + spec files: beside Kandev's data, never inside a worktree or the user's checkout. */
function acceptanceDir(storyId: string): string {
  const home = process.env.KARKEDIKHA_KANDEV_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.kkd-kandev');
  const dir = path.join(home, 'kkd-acceptance', storyId.replace(/[^\w-]/g, '_'));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// The runner is plain ESM so it loads CommonJS and ES-module implementations alike. It prints one result line.
const RUNNER = [
  "import { pathToFileURL } from 'node:url';",
  "import path from 'node:path';",
  "import fs from 'node:fs';",
  "import assert from 'node:assert';",
  "const [specFile, root] = process.argv.slice(2);",
  "const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));",
  "const failed = []; let passed = 0;",
  "const show = (v) => { try { return JSON.stringify(v); } catch { return String(v); } };",
  "let mod;",
  "try { mod = await import(pathToFileURL(path.resolve(root, spec.module)).href); }",
  "catch (e) { failed.push({ name: 'load ' + spec.module, detail: 'the module cannot be loaded: ' + String(e && e.message || e).split('\\n')[0] }); }",
  "let fn;",
  "if (mod) {",
  "  fn = spec.export ? (mod[spec.export] ?? (mod.default && mod.default[spec.export])) : (typeof mod.default === 'function' ? mod.default : undefined);",
  "  if (typeof fn !== 'function') { failed.push({ name: 'export', detail: (spec.export ? 'no function named ' + spec.export : 'no default function') + ' is exported by ' + spec.module }); fn = undefined; }",
  "}",
  "if (fn) for (const [i, c] of spec.cases.entries()) {",
  "  const label = (c.name ? c.name + ': ' : '') + (spec.export || 'fn') + '(' + c.args.map(show).join(', ') + ')';",
  "  try { const got = await fn(...c.args); assert.deepStrictEqual(got, c.expected); passed++; }",
  "  catch (e) { failed.push({ name: label, detail: e && e.name === 'AssertionError' ? 'expected ' + show(c.expected) + ' but got ' + show(e.actual) : 'threw ' + String(e && e.message || e).split('\\n')[0] }); }",
  "}",
  "console.log('KKD_ACCEPT ' + JSON.stringify({ passed, total: spec.cases.length, failed }));",
  "process.exit(failed.length ? 1 : 0);",
].join('\n');

/** A minimal environment: acceptance code gets no credentials from KKD's process. */
function cleanEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'TEMP', 'TMP', 'PATHEXT', 'HOME', 'USERPROFILE'];
  const env: NodeJS.ProcessEnv = { NODE_ENV: 'test' };
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** Runs the story's trusted checks against `root` (a worktree or the integration checkout). */
export function runAcceptance(storyId: string, checks: AcceptanceCheck[], root: string): AcceptanceResult {
  const dir = acceptanceDir(storyId);
  const runner = path.join(dir, 'run-examples.mjs');
  fs.writeFileSync(runner, RUNNER);
  let total = 0, passed = 0;
  const lines: string[] = [];
  checks.forEach((check, i) => {
    if (check.kind === 'device') return; // reported separately; a person verifies it on the device
    if (check.kind === 'examples') {
      const specFile = path.join(dir, `spec-${i}.json`);
      fs.writeFileSync(specFile, JSON.stringify(check));
      const r = spawnSync(process.execPath, [runner, specFile, root], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: cleanEnv() });
      const line = String(r.stdout ?? '').split('\n').find(l => l.startsWith('KKD_ACCEPT '));
      let res: { passed: number; total: number; failed: Array<{ name: string; detail: string }> } | null = null;
      try { res = line ? JSON.parse(line.slice('KKD_ACCEPT '.length)) : null; } catch { /* reported below */ }
      if (!res) {
        total += check.cases.length;
        lines.push(`✗ ${check.name}: the check could not run — ${(String(r.stderr ?? '') || String(r.error ?? '') || 'no result').split('\n')[0].slice(0, 200)}`);
        return;
      }
      total += res.total; passed += res.passed;
      for (const f of res.failed) lines.push(`✗ ${check.name}: ${f.name} — ${f.detail}`);
      if (!res.failed.length) lines.push(`✓ ${check.name}: ${res.passed}/${res.total} cases`);
    } else {
      total += 1;
      const file = path.join(dir, `script-${i}.mjs`);
      fs.writeFileSync(file, check.source);
      const r = spawnSync(process.execPath, [file], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...cleanEnv(), KKD_ACCEPT_ROOT: root } });
      if (r.status === 0) { passed += 1; lines.push(`✓ ${check.name}`); }
      else lines.push(`✗ ${check.name}: ${(`${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`.trim().split('\n').slice(-16).join(' | ') || 'exited non-zero').slice(0, 2_000)}`);
    }
  });
  return { ok: total > 0 && passed === total, total, passed, evidence: lines.join('\n').slice(-3_000), names: automatedChecks(checks).map(c => c.name) };
}

// ---------------------------------------------------------------- diff examination

export interface DiffFinding { violations: string[]; reviewReasons: string[] }

const TEST_FILE = /(^|[\\/])(tests?|__tests__|spec)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$|(^|[\\/])test_?[^\\/]*\.(py|js)$/i;
const DISABLES_TESTS = /\b(?:test|it|describe)\.(?:skip|only|todo)\b|\bx(?:it|describe|test)\s*\(|\.skip\s*\(/;
const ASSERTION = /\b(?:assert(?:\.\w+)?|expect|t\.(?:is|true|deepEqual|equal))\s*\(/;

/**
 * Looks at what the worker actually changed (not at what it says it changed). Hard violations: deleting an existing
 * test file, or adding skipped/focused tests. A softer signal (fewer assertions in a test file that already existed)
 * does not fail the story but makes human review mandatory.
 */
export function examineDiff(worktree: string, integrationBranch: string): DiffFinding {
  const run = (args: string[]) => {
    const r = runHardenedGit(args, { cwd: worktree, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return r.status === 0 ? String(r.stdout ?? '') : '';
  };
  const base = run(['merge-base', integrationBranch, 'HEAD']).trim();
  const violations: string[] = [], reviewReasons: string[] = [];
  if (!base) return { violations, reviewReasons: ['the diff could not be compared with the integration branch'] };
  const status = run(['diff', '--name-status', base]).split('\n').filter(Boolean);
  for (const l of status) {
    const [code, ...rest] = l.split('\t');
    if (code.startsWith('D') && TEST_FILE.test(rest[0] ?? '')) violations.push(`deleted test file ${rest[0]}`);
  }
  const patch = run(['diff', '--no-ext-diff', '-U0', base]);
  let file = '';
  let removed = 0, added = 0;
  const flush = () => {
    if (file && TEST_FILE.test(file) && removed > added) reviewReasons.push(`${file} lost ${removed - added} assertion(s)`);
    removed = 0; added = 0;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git')) { flush(); file = /b\/(.+)$/.exec(line)?.[1] ?? ''; continue; }
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) {
      if (TEST_FILE.test(file) && DISABLES_TESTS.test(line)) violations.push(`${file}: skips or focuses tests (${line.slice(1).trim().slice(0, 80)})`);
      if (ASSERTION.test(line)) added++;
    } else if (line.startsWith('-') && ASSERTION.test(line)) removed++;
  }
  flush();
  return { violations: [...new Set(violations)], reviewReasons: [...new Set(reviewReasons)] };
}

/** `independent` = KKD's own checks passed; `worker-only` = only the worker's tests ran. */
export type VerificationLevel = 'independent' | 'worker-only';
