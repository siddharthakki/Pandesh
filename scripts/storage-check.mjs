// Pandesh storage discipline check. Plain Git + directory listings; no state, no daemon.
//   node scripts/storage-check.mjs preflight   run before starting a task
//   node scripts/storage-check.mjs postflight  run before calling a task complete
// Exit 0 = clean, 1 = violations. Nothing is ever deleted by this script; it names what to clean.
//
// Policy (see CLAUDE.md "Engineering discipline"): one canonical repository, main + one active branch,
// no extra worktrees or clones, one reusable test/acceptance env, one reusable build dir, current + previous installer only.
// A deliberate exception is written, with a reason, in `.storage-approved` at the repo root (git-excluded):
//   one line per approved path or branch:  <path-or-branch>  # reason
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const mode = process.argv[2] === 'postflight' ? 'postflight' : 'preflight';
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const git = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' }).trim();
const norm = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const approvedFile = path.join(repo, '.storage-approved');
const approved = new Set(fs.existsSync(approvedFile)
  ? fs.readFileSync(approvedFile, 'utf8').split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => (/[\\/]/.test(l) ? norm(l) : l))
  : []);
const violations = [];
const bad = (rule, what) => violations.push(`${rule}: ${what}`);

// 1. Worktrees: none besides the canonical checkout.
const wt = git('worktree', 'list', '--porcelain').split(/\r?\n\r?\n/).map((b) => (b.match(/^worktree (.+)$/m) || [])[1]).filter(Boolean);
for (const w of wt.slice(1)) if (!approved.has(norm(w))) bad('extra worktree', `${w}  ->  git worktree remove "${w}"`);

// 2. Branches: main + one active development branch (the checked-out one) + approved ones.
const current = git('branch', '--show-current');
const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads').split(/\r?\n/).filter(Boolean);
for (const b of branches) if (b !== 'main' && b !== current && !approved.has(b)) bad('extra local branch', `${b}  ->  merge or discard, then git branch -d ${b}`);

// 3. Temporary directories inside the repo (.tmp) older than 24 hours.
const tmp = path.join(repo, '.tmp');
if (fs.existsSync(tmp)) for (const e of fs.readdirSync(tmp, { withFileTypes: true })) {
  const full = path.join(tmp, e.name);
  if (Date.now() - fs.statSync(full).mtimeMs > 24 * 3600 * 1000 && !approved.has(norm(full))) bad('stale temporary artifact (>24h)', full);
}

// 4. Per-task permanent directories next to the repo or at a drive root.
const REUSABLE = new Set(['pandeshp0dev']); // the one reusable isolated test / acceptance / build environment
const PROD = /^(pandesh|pandeshservices|pandeshassets)$/i; // installed app and its supporting folders (verified by the owner, not by this script)
const roots = [...new Set(['C:\\', 'D:\\', 'E:\\'].filter((r) => fs.existsSync(r)))];
const seen = [];
for (const r of roots) {
  let names = []; try { names = fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* unreadable root */ }
  for (const n of names) if (/^pandesh/i.test(n) && !REUSABLE.has(n.toLowerCase()) && !PROD.test(n) && !approved.has(norm(path.join(r, n)))) seen.push(path.join(r, n));
}
const projects = 'D:\\Projects';
if (fs.existsSync(projects)) for (const d of fs.readdirSync(projects, { withFileTypes: true })) {
  const full = path.join(projects, d.name);
  if (d.isDirectory() && /^pandesh/i.test(d.name) && norm(full) !== norm(repo) && !approved.has(norm(full))) seen.push(full);
}
for (const s of seen) bad('extra Pandesh directory', s);

// 5. Rollback/installer copies: only the previous stable one next to the installed app.
if (fs.existsSync('E:\\')) {
  const copies = fs.readdirSync('E:\\', { withFileTypes: true }).filter((d) => d.isDirectory() && /^Pandesh-b\d+/i.test(d.name)).map((d) => d.name).sort();
  if (copies.length > 1) bad('rollback copies (keep only the previous stable one)', copies.join(', '));
}

// Drive free space, for the record.
let free = '';
try { free = roots.map((r) => { const s = fs.statfsSync(r); return `${r[0]}: ${(s.bavail * s.bsize / 2 ** 30).toFixed(0)} GB free`; }).join(', '); } catch { /* optional */ }

console.log(`storage ${mode}: repo ${repo}, branch ${current}, worktrees ${wt.length - 1} extra, branches ${branches.length}; ${free}`);
if (violations.length) {
  console.error(`storage ${mode} FAILED (${violations.length}):\n- ${violations.join('\n- ')}`);
  console.error('Clean up, or record a justified exception in .storage-approved. A task is not complete until this passes.');
  process.exit(1);
}
console.log(`storage ${mode} OK`);
