// Pandesh storage discipline check. Plain Git + directory listings; no state, no daemon, never deletes anything.
//   node scripts/storage-check.mjs preflight   run before starting a task
//   node scripts/storage-check.mjs postflight  run before calling a task complete
// Exit 0 = clean, 1 = violations. A violation names what to clean and how.
//
// Policy (CLAUDE.md "Engineering discipline"): one canonical repository, main + one active branch, no extra worktrees or clones,
// one reusable test/acceptance/build environment, current + previous installer only, bounded retention for every kind of output.
// A deliberate exception goes in `.storage-approved` at the repo root (git-excluded), one per line, ALL fields required, exact path, max 90 days:
//   path=<abs path> | owner=<who> | purpose=<why> | evidence=<what proves the dependency> | expires=YYYY-MM-DD | review=<trigger to re-check>
// An invalid, expired, stale, junctioned or sibling-ambiguous exception fails the check. `--verify-hashes` re-hashes manifest-listed evidence.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadExceptions, isApproved, isBranchApproved, checkGoldenEvidence } from './lib/storage-policy.mjs';

const mode = process.argv[2] === 'postflight' ? 'postflight' : 'preflight';
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const DAY = 24 * 3600 * 1000;
const age = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs; } catch { return 0; } };
const dirs = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } };
const files = (p) => { try { return fs.readdirSync(p, { withFileTypes: true }).filter((d) => d.isFile()).map((d) => d.name); } catch { return []; } };
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const mb = (b) => `${(b / 2 ** 20).toFixed(0)} MB`;

const approvedFile = path.join(repo, '.storage-approved');
const { valid: approved, errors: exceptionErrors } = loadExceptions(approvedFile);
const violations = [];
const bad = (rule, what) => violations.push(`${rule}: ${what}`);
// Exact-path match only (see scripts/lib/storage-policy.mjs). An invalid or expired exception is itself a violation.
for (const e of exceptionErrors) bad('invalid or expired exception', e);
const ok = (p) => isApproved(approved, p);

// 1. Worktrees: none besides the canonical checkout.
const wt = git('worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).map((b) => (b.match(/^worktree (.+)$/m) || [])[1]).filter(Boolean);
for (const w of wt.slice(1)) if (!ok(w)) bad('extra worktree', `${w}  ->  git worktree remove "${w}"`);

// 2. Branches: main + one active development branch (the checked-out one).
const current = git('branch', '--show-current');
const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/).filter(Boolean);
for (const b of branches) if (b !== 'main' && b !== current && !isBranchApproved(approved, b)) bad('extra local branch', `${b}  ->  merge or discard, then git branch -d ${b}`);

// 3. Repeated build output: temporary folders > 24 h, and more than the current + previous installer in dist.
const tmp = path.join(repo, '.tmp');
for (const n of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) { const f = path.join(tmp, n); if (age(f) > DAY && !ok(f)) bad('stale temporary artifact (>24h)', f); }
const dist = path.join(repo, 'dist');
const installers = files(dist).filter((f) => /\.(exe|msi|vsix)$/i.test(f)).map((f) => ({ f, t: fs.statSync(path.join(dist, f)).mtimeMs })).sort((a, b) => b.t - a.t);
for (const x of installers.slice(2)) bad('installer beyond current + previous', path.join(dist, x.f));

// 4. Per-task permanent directories at drive roots / next to the repo. Production and protected user data are named, with the reason.
const LEGIT = new Map([
  ['pandeshp0dev', 'the one reusable isolated test/acceptance/build environment'],
  ['pandesh', 'installed production app (E:\\Pandesh)'],
  ['pandeshservices', 'live local services; verify dependencies before touching'],
  ['pandeshassets', 'shared 3D/asset library'],
]);
const PROTECTED = /^pandeshjugaad/i; // user data: never counted as removable, never deleted by policy work
const seen = [];
const protectedSeen = [];
for (const r of ['C:\\', 'D:\\', 'E:\\'].filter((x) => fs.existsSync(x))) {
  for (const n of dirs(r)) {
    if (!/^pandesh/i.test(n) || LEGIT.has(n.toLowerCase()) || ok(path.join(r, n))) continue;
    if (PROTECTED.test(n)) { protectedSeen.push(path.join(r, n)); continue; }
    seen.push(path.join(r, n));
  }
}
if (fs.existsSync('D:\\Projects')) for (const n of dirs('D:\\Projects')) {
  const full = path.join('D:\\Projects', n);
  if (/^pandesh/i.test(n) && norm(full) !== norm(repo) && !ok(full)) seen.push(full);
}
for (const s of seen) bad('extra Pandesh directory', s);

// 5. Rollback copies: the installed app's previous stable build only.
if (fs.existsSync('E:\\')) {
  const copies = dirs('E:\\').filter((n) => /^Pandesh-b\d+/i.test(n) || /^Pandesh-Backups$/i.test(n)).sort();
  const rollback = copies.filter((n) => /^Pandesh-b\d+/i.test(n));
  if (rollback.length > 1) bad('rollback copies (keep only the previous stable one)', rollback.join(', '));
  if (copies.includes('Pandesh-Backups')) bad('old backup folder', 'E:\\Pandesh-Backups');
}

// 6. Duplicate dependency installs: a real (non-junction) node_modules anywhere beyond the canonical repo.
const nm = [];
for (const base of ['D:\\Projects', 'D:\\', 'E:\\']) for (const n of dirs(base)) {
  if (!/pandesh/i.test(n)) continue;
  const root = path.join(base, n);
  if (norm(root) === norm(repo) || norm(root) === norm('D:\\PandeshP0Dev')) continue;
  const m = path.join(root, 'node_modules');
  if (fs.existsSync(m) && !isLink(m)) nm.push(m);
}
for (const m of nm) bad('duplicate node_modules install', m);
for (const j of (fs.existsSync(path.join(repo, 'node_modules')) ? fs.readdirSync(path.join(repo, 'node_modules')) : []).filter((n) => isLink(path.join(repo, 'node_modules', n)))) {
  bad('canonical node_modules entry is a junction (breaks if its target is removed)', path.join(repo, 'node_modules', j));
}

// 7. Runtime data: Kandev copies, golden evidence, logs, test environment entries. (Reads the real profile's folder names only.)
const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
const profile = path.join(local, 'KarkeDikha', 'desktop');
const pw = path.join(profile, 'panda-workspaces');
for (const n of dirs(pw).filter((d) => d !== '_retained')) if (age(path.join(pw, n)) > 2 * DAY) bad('Kandev private task copy older than 2 days (the sweep should have removed it)', path.join(pw, n));
const kh = process.env.KARKEDIKHA_KANDEV_HOME || path.join(os.homedir(), '.kkd-kandev');
for (const n of dirs(path.join(kh, 'tasks'))) if (age(path.join(kh, 'tasks', n)) > 7 * DAY) bad('Kandev task worktree older than 7 days', path.join(kh, 'tasks', n));
const ge = path.join(local, 'KarkeDikha', 'golden-evidence');
const golden = checkGoldenEvidence(ge, { verifyHashes: process.argv.includes('--verify-hashes') });
for (const v of golden.violations) bad('golden-evidence', v);
const goldenInfo = fs.existsSync(ge) ? `golden-evidence: ${golden.runs} runs, ${(golden.bytes / 2 ** 30).toFixed(2)} GB (limit 5 GB)` : '';
for (const b of dirs(path.join(local, 'KarkeDikha')).filter((n) => /^desktop-backup-/.test(n))) bad('profile backup of an old build', path.join(local, 'KarkeDikha', b));
for (const dir of [path.join(profile, 'logs'), profile]) for (const f of files(dir).filter((x) => /\.(log|jsonl)$/i.test(x))) {
  const p = path.join(dir, f); const st = fs.statSync(p);
  if (age(p) > 7 * DAY || st.size > 100 * 2 ** 20) bad('routine log not rotated (>7 days or >100 MB)', `${p} (${mb(st.size)})`);
}
const p0 = 'D:\\PandeshP0Dev';
for (const n of dirs(p0)) if (age(path.join(p0, n)) > 14 * DAY && !ok(path.join(p0, n))) bad('test-environment folder untouched for 14 days', path.join(p0, n));

let free = '';
try { free = ['C:\\', 'D:\\', 'E:\\'].filter((r) => fs.existsSync(r)).map((r) => { const s = fs.statfsSync(r); return `${r[0]}: ${(s.bavail * s.bsize / 2 ** 30).toFixed(0)} GB free`; }).join(', '); } catch { /* optional */ }
console.log(`storage ${mode}: repo ${repo}, branch ${current}, ${wt.length - 1} extra worktrees, ${branches.length} branches; ${free}`);
if (goldenInfo) console.log(goldenInfo);
if (approved.size) console.log(`approved exceptions (exact, temporary): ${[...approved.entries()].map(([k, f]) => `${k.replace(/^branch:/, 'branch ')} until ${f.expires}`).join('; ')}`);
if (protectedSeen.length) console.log(`protected user data (not counted, never removed by policy work): ${protectedSeen.join(', ')}`);
if (violations.length) {
  console.error(`storage ${mode} FAILED (${violations.length}):\n- ${violations.join('\n- ')}`);
  console.error('Clean up, or record a justified exception in .storage-approved. A task is not complete until this passes.');
  process.exit(1);
}
console.log(`storage ${mode} OK`);
