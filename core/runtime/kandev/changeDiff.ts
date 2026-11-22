/**
 * Read-only Git diff of one change, for the owner's review (A5 "View diff").
 *
 * It only runs read commands (`diff`, `ls-files`, `rev-parse`, `merge-base`) through the hardened Git wrapper, in a folder the
 * caller has already proven is the authorized worktree or private copy. It writes nothing: no index, no objects, no refs.
 * Untracked files are read directly, and only after a path check: relative, no `..`, no symbolic link, and resolving inside the
 * worktree. Large, binary and unreadable files are reported as such instead of being shown.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHardenedGit } from '../../security/hardenedGit';

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type-changed' | 'untracked';

export interface FileDiff {
  path: string;
  oldPath: string | null;
  status: FileChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
  /** Unified diff text, or null when it is not shown (binary, too large, over the total budget, unreadable). */
  patch: string | null;
  truncated: boolean;
  /** Why the patch is missing or cut, in plain words. */
  note: string | null;
}

export interface ChangeDiff {
  available: boolean;
  reason: string | null;
  source: 'worker worktree' | 'private copy' | null;
  base: string | null;
  head: string | null;
  files: FileDiff[];
  summary: { files: number; additions: number; deletions: number; binary: number; large: number; unavailable: number };
}

export const DIFF_LIMITS = { fileBytes: 200_000, fileLines: 2_000, totalBytes: 1_500_000, maxFiles: 200 } as const;

export function unavailableDiff(reason: string, source: ChangeDiff['source'] = null): ChangeDiff {
  return { available: false, reason, source, base: null, head: null, files: [], summary: { files: 0, additions: 0, deletions: 0, binary: 0, large: 0, unavailable: 0 } };
}

const STATUS: Record<string, FileChangeStatus> = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type-changed' };
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'];

function run(cwd: string, args: string[]): { ok: boolean; out: string } {
  const r = runHardenedGit(args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
  return { ok: r.status === 0, out: String(r.stdout ?? '') };
}

/** A path from Git that is safe to name and to read below `root`: relative, no `..`, no drive or NUL, inside after resolving links. */
export function safeChangePath(root: string, rel: string): boolean {
  if (!rel || rel.includes('\0') || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) return false;
  if (rel.split(/[\\/]/).some(seg => seg === '..')) return false;
  const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
  let realRoot: string;
  try { realRoot = norm(fs.realpathSync.native(root)); } catch { return false; }
  const full = path.resolve(root, rel);
  if (!norm(full).startsWith(`${norm(path.resolve(root))}/`)) return false;
  // The nearest existing ancestor (the file itself may be deleted) must resolve inside the real root.
  let probe = full;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  try { return norm(fs.realpathSync.native(probe)) === realRoot || norm(fs.realpathSync.native(probe)).startsWith(`${realRoot}/`); } catch { return false; }
}

function splitZ(out: string): string[] { return out.split('\0'); }

/**
 * The change from `base` to `to` (a commit), or to the working tree including untracked files when `to` is null.
 * `ignore` hides files that are not part of the change (the agent's own settings), and lists them in `ignored`.
 */
export function readChangeDiff(cwd: string, base: string, to: string | null, opts: { source: ChangeDiff['source']; ignore?: RegExp }): ChangeDiff & { ignored: string[] } {
  const range = to ? [base, to] : [base];
  const head = to ? run(cwd, ['rev-parse', '--short', to]).out.trim() : `${run(cwd, ['rev-parse', '--short', 'HEAD']).out.trim()} + uncommitted`;
  const ns = run(cwd, ['diff', ...DIFF_FLAGS, '-z', '--name-status', ...range]);
  const num = run(cwd, ['diff', ...DIFF_FLAGS, '-z', '--numstat', ...range]);
  if (!ns.ok || !num.ok) return { ...unavailableDiff('Git could not compare the change with its base.', opts.source), ignored: [] };

  const entries: Array<{ status: FileChangeStatus; path: string; oldPath: string | null }> = [];
  const parts = splitZ(ns.out);
  for (let i = 0; i < parts.length;) {
    const code = parts[i++];
    if (!code) continue;
    const kind = STATUS[code[0]] ?? 'modified';
    if (kind === 'renamed' || kind === 'copied') { const oldPath = parts[i++]; entries.push({ status: kind, oldPath, path: parts[i++] }); }
    else entries.push({ status: kind, oldPath: null, path: parts[i++] });
  }
  const stats = new Map<string, { a: number | null; d: number | null; binary: boolean }>();
  const np = splitZ(num.out);
  for (let i = 0; i < np.length;) {
    const rec = np[i++];
    if (!rec) continue;
    const [a, d, p] = rec.split('\t');
    const file = p ? p : (i++, np[i++]); // a rename: "a\td\t" then old\0new\0
    stats.set(file, { a: a === '-' ? null : Number(a), d: d === '-' ? null : Number(d), binary: a === '-' && d === '-' });
  }
  if (!to) {
    for (const p of splitZ(run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']).out)) if (p) entries.push({ status: 'untracked', oldPath: null, path: p });
  }

  const ignored: string[] = [];
  const files: FileDiff[] = [];
  let budget: number = DIFF_LIMITS.totalBytes;
  for (const e of entries) {
    if (opts.ignore?.test(e.path.replace(/\\/g, '/'))) { ignored.push(e.path); continue; }
    if (files.length >= DIFF_LIMITS.maxFiles) { files.push({ ...e, additions: null, deletions: null, binary: false, patch: null, truncated: false, note: 'Not shown: too many changed files.' }); continue; }
    if (!safeChangePath(cwd, e.path) || (e.oldPath && !safeChangePath(cwd, e.oldPath))) {
      files.push({ ...e, path: e.path.replace(/[^\x20-\x7e]/g, '?'), additions: null, deletions: null, binary: false, patch: null, truncated: false, note: 'Not shown: the path points outside the worktree.' });
      continue;
    }
    const f = e.status === 'untracked' ? untrackedDiff(cwd, e.path) : trackedDiff(cwd, range, e, stats.get(e.path));
    if (f.patch !== null) {
      if (f.patch.length > budget) { f.patch = null; f.truncated = false; f.note = 'Not shown: the diff is larger than the review can display at once.'; }
      else budget -= f.patch.length;
    }
    files.push(f);
  }
  const summary = {
    files: files.length,
    additions: files.reduce((s, f) => s + (f.additions ?? 0), 0),
    deletions: files.reduce((s, f) => s + (f.deletions ?? 0), 0),
    binary: files.filter(f => f.binary).length,
    large: files.filter(f => f.truncated || /larger|too large/.test(f.note ?? '')).length,
    unavailable: files.filter(f => f.patch === null && !f.binary).length,
  };
  return { available: true, reason: null, source: opts.source, base: run(cwd, ['rev-parse', '--short', base]).out.trim() || base, head, files, summary, ignored };
}

function trackedDiff(cwd: string, range: string[], e: { status: FileChangeStatus; path: string; oldPath: string | null }, st: { a: number | null; d: number | null; binary: boolean } | undefined): FileDiff {
  const out: FileDiff = { ...e, additions: st?.a ?? null, deletions: st?.d ?? null, binary: st?.binary ?? false, patch: null, truncated: false, note: null };
  if (out.binary) { out.note = 'Binary file: no text diff.'; return out; }
  if ((st?.a ?? 0) + (st?.d ?? 0) > DIFF_LIMITS.fileLines * 4) { out.note = `Not shown: ${(st?.a ?? 0) + (st?.d ?? 0)} changed lines is too large to display.`; return out; }
  const specs = [e.oldPath, e.path].filter((p): p is string => !!p).map(p => `:(literal)${p}`);
  const r = run(cwd, ['diff', ...DIFF_FLAGS, ...range, '--', ...specs]);
  if (!r.ok) { out.note = 'Not shown: Git could not produce this file\'s diff.'; return out; }
  return capPatch(out, r.out);
}

function untrackedDiff(cwd: string, rel: string): FileDiff {
  const out: FileDiff = { path: rel, oldPath: null, status: 'untracked', additions: null, deletions: 0, binary: false, patch: null, truncated: false, note: null };
  const full = path.join(cwd, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(full); } catch { out.note = 'Not shown: the file could not be read.'; return out; }
  if (st.isSymbolicLink() || !st.isFile()) { out.note = 'Not shown: a link or special file, not followed.'; return out; }
  if (st.size > DIFF_LIMITS.fileBytes) { out.note = `Not shown: the new file is too large (${st.size} bytes).`; return out; }
  const buf = fs.readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) { out.binary = true; out.note = 'Binary file: no text diff.'; return out; }
  const lines = buf.toString('utf8').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  out.additions = lines.length;
  const patch = [`diff --git a/${rel} b/${rel}`, 'new file (not yet committed by the worker)', '--- /dev/null', `+++ b/${rel}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l.replace(/\r$/, '')}`)].join('\n');
  return capPatch(out, patch);
}

function capPatch(out: FileDiff, patch: string): FileDiff {
  const lines = patch.split('\n');
  if (patch.length > DIFF_LIMITS.fileBytes || lines.length > DIFF_LIMITS.fileLines) {
    let cut = lines.slice(0, DIFF_LIMITS.fileLines).join('\n');
    if (cut.length > DIFF_LIMITS.fileBytes) cut = cut.slice(0, DIFF_LIMITS.fileBytes);
    out.patch = cut; out.truncated = true; out.note = `Large diff: showing the first ${cut.split('\n').length} of ${lines.length} lines.`;
  } else out.patch = patch.replace(/\n$/, '');
  return out;
}
