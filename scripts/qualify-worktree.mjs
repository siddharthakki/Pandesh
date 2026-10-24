// Deterministic qualification flow in a CLEAN, ISOLATED worktree:
//
//   clean worktree -> npm ci -> typecheck -> tests -> package -> inspect package
//
// PERMANENT RULE: a qualification worktree owns its node_modules. Never junction, symlink or otherwise share the
// development checkout's node_modules into it. `npm`/`vsce` package inspection resolves dependencies through the
// real path, so a junction makes the package contents (and its hashes) depend on whatever the development tree
// happens to contain. This script creates the worktree itself, runs `npm ci` inside it, and REFUSES to continue if
// node_modules there is a link. It never writes to the main development checkout.
//
// Usage:
//   node scripts/qualify-worktree.mjs [--ref <git-ref>] [--dir <path>] [--skip-tests] [--no-package] [--cleanup] [--dry-run]
//
// Exit code 0 only when every stage passed. Evidence is written to <dir>/.qualification/report.json.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** The ordered stages. Pure so the flow itself is testable without running anything. */
export function planQualification(options = {}) {
  const stages = [
    { id: 'install', label: 'npm ci', command: [npm, 'ci'] },
    { id: 'typecheck-extension', label: 'typecheck (extension)', command: [npx(), 'tsc', '-p', '.', '--noEmit'] },
    { id: 'typecheck-core', label: 'typecheck (core)', command: [npx(), 'tsc', '-p', 'tsconfig.core.json', '--noEmit'] },
    { id: 'typecheck-webview', label: 'typecheck (webview-v2)', command: [npm, 'run', 'typecheck:webview-v2'] },
  ];
  if (!options.skipTests) stages.push({ id: 'tests', label: 'test suite', command: [npm, 'test'] });
  if (!options.noPackage) {
    stages.push({ id: 'package', label: 'package win32-x64 VSIX', command: [npm, 'run', 'package:win32-x64'] });
    stages.push({ id: 'inspect', label: 'inspect package', inspect: true });
  }
  return stages;
}

function npx() {
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

/**
 * True when `directory` is a link (symlink, or a Windows junction, which Node reports as a symlink) or resolves to a
 * real path outside `worktreeRoot`. Either means the worktree does not own its dependencies.
 */
export function nodeModulesIsShared(worktreeRoot, fsImpl = fs) {
  const target = path.join(worktreeRoot, 'node_modules');
  let stat;
  try {
    stat = fsImpl.lstatSync(target);
  } catch {
    return false; // absent: nothing shared (the install stage creates it)
  }
  if (stat.isSymbolicLink()) return true;
  const real = fsImpl.realpathSync(target);
  const rootReal = fsImpl.realpathSync(worktreeRoot);
  return path.relative(rootReal, real).startsWith('..');
}

export function parseArgs(argv) {
  const options = { ref: 'HEAD', skipTests: false, noPackage: false, cleanup: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--ref') options.ref = argv[++index];
    else if (arg === '--dir') options.dir = argv[++index];
    else if (arg === '--skip-tests') options.skipTests = true;
    else if (arg === '--no-package') options.noPackage = true;
    else if (arg === '--cleanup') options.cleanup = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function run(stage, cwd) {
  const [command, ...args] = stage.command;
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  return { id: stage.id, label: stage.label, exitCode: result.status ?? 1, ms: Date.now() - started };
}

function inspectPackage(worktree) {
  const vsix = fs.readdirSync(worktree).filter(name => name.endsWith('.vsix')).map(name => path.join(worktree, name));
  if (vsix.length !== 1) return { ok: false, reason: `expected exactly one .vsix in the worktree, found ${vsix.length}` };
  const file = vsix[0];
  const verify = path.join(worktree, 'scripts', 'verify-win32-vsix.mjs');
  const verified = fs.existsSync(verify)
    ? spawnSync(process.execPath, [verify, file], { cwd: worktree, stdio: 'inherit' })
    : { status: 0 };
  const bytes = fs.readFileSync(file);
  return {
    ok: verified.status === 0,
    reason: verified.status === 0 ? undefined : 'package structural verification failed',
    file: path.basename(file),
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const mainCheckout = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sha = git(['rev-parse', '--short', options.ref], mainCheckout);
  const full = git(['rev-parse', options.ref], mainCheckout);
  const dir = path.resolve(options.dir ?? path.join(mainCheckout, '..', `kkd-qual-${sha}`));
  const stages = planQualification(options);

  if (options.dryRun) {
    console.log(JSON.stringify({ ref: options.ref, sha: full, worktree: dir, stages: stages.map(stage => stage.label) }, null, 2));
    return 0;
  }
  if (fs.existsSync(dir)) throw new Error(`Refusing to reuse existing directory ${dir}; qualification always starts from a fresh worktree.`);
  if (path.relative(mainCheckout, dir) === '' || !path.relative(mainCheckout, dir).startsWith('..')) {
    throw new Error('The qualification worktree must live outside the development checkout.');
  }

  git(['worktree', 'add', '--detach', dir, full], mainCheckout);
  const report = { ref: options.ref, sha: full, worktree: dir, startedAt: new Date().toISOString(), stages: [], result: 'FAIL' };
  let failed = false;
  try {
    if (git(['status', '--porcelain', '--untracked-files=no'], dir)) throw new Error('worktree is not clean after checkout');
    for (const stage of stages) {
      if (nodeModulesIsShared(dir)) throw new Error('node_modules in the qualification worktree is a link or lives outside it; refusing to continue');
      if (stage.inspect) {
        const inspection = inspectPackage(dir);
        report.stages.push({ id: stage.id, label: stage.label, exitCode: inspection.ok ? 0 : 1, ...inspection });
        failed = !inspection.ok;
      } else {
        const outcome = run(stage, dir);
        report.stages.push(outcome);
        failed = outcome.exitCode !== 0;
      }
      if (failed) break;
    }
    if (!failed && nodeModulesIsShared(dir)) throw new Error('node_modules became a link during qualification');
    report.result = failed ? 'FAIL' : 'PASS';
  } finally {
    report.finishedAt = new Date().toISOString();
    const evidence = path.join(dir, '.qualification');
    fs.mkdirSync(evidence, { recursive: true });
    fs.writeFileSync(path.join(evidence, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ result: report.result, sha: full, worktree: dir }, null, 2));
    // The worktree holds the evidence and the .vsix, so it is kept unless asked to clean up after a pass.
    if (options.cleanup && report.result === 'PASS') {
      git(['worktree', 'remove', '--force', dir], mainCheckout);
    }
  }
  return report.result === 'PASS' ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => process.exit(code), error => { console.error(error.message); process.exit(2); });
}
