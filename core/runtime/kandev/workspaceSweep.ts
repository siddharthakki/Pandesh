/**
 * Bounded retention for the bridge's private task copies (`<dataDir>/panda-workspaces/<task>[-inspect|-code]`).
 *
 * Before this, a copy lived forever: after success, failure, cancellation and expiry alike. Rules:
 *  - a copy of a task that is finished (completed, cancelled, failed), expired (not finished for 7 days) or unknown (no task
 *    row, older than 24 h) is removed once it is at least `graceMs` old;
 *  - any change in it that is not in the original checkout (uncommitted, untracked or committed since the copy was made) is first
 *    written as ONE patch to `_retained/`, and only then is the copy removed. If that patch cannot be written, nothing is removed;
 *  - retained patches expire after 7 days, and a patch is capped in size;
 *  - copies of running or waiting tasks are never touched. A node_modules junction into the owner's checkout is unlinked, never followed.
 * The sweep is idempotent and cheap: it runs at Core start and at most once an hour when a new copy is prepared.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { runHardenedGit } from '../../security/hardenedGit';

const DAY = 24 * 3600 * 1000;
export const RETAINED_DIR = '_retained';
export const MAX_PATCH_BYTES = 20 * 1024 * 1024;
const FINISHED = new Set(['completed', 'cancelled', 'failed']);

export interface SweepDb { all<T>(sql: string, params?: unknown[]): T[]; }
export interface SweepOptions { now?: number; graceMs?: number; expireActiveMs?: number; retainPatchMs?: number; }
export interface SweepResult { removed: string[]; retainedPatches: string[]; kept: { dir: string; reason: string }[]; expiredPatches: string[]; bytesFreed: number; }

const taskDirName = (id: string) => id.replace(/[^\w-]/g, '_');

function dirBytes(dir: string): number {
  let sum = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) continue; // junctions are not this copy's bytes
      if (e.isDirectory()) stack.push(p);
      else { try { sum += fs.statSync(p).size; } catch { /* gone */ } }
    }
  }
  return sum;
}

/** Unlink junctions/symlinks (e.g. node_modules into the owner's checkout) so removal can never reach their target. */
function unlinkLinks(dir: string): void {
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop() as string;
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) { try { fs.unlinkSync(p); } catch { try { fs.rmdirSync(p); } catch { /* leave it */ } } }
      else if (e.isDirectory()) stack.push(p);
    }
  }
}

const git = (cwd: string, args: string[]) => runHardenedGit(args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: MAX_PATCH_BYTES + 1024 * 1024 });

/** Writes the copy's own changes as a patch. Returns 'none' (nothing to keep), 'written' or 'failed'. */
function retainChanges(dir: string, patchFile: string): 'none' | 'written' | 'failed' {
  if (!fs.existsSync(path.join(dir, '.git'))) return 'none';
  const root = String(git(dir, ['reflog', 'show', '--format=%H', 'HEAD']).stdout ?? '').trim().split(/\r?\n/).filter(Boolean).pop();
  if (!root) return 'failed';
  if (git(dir, ['add', '-A']).status !== 0) return 'failed';
  const diff = git(dir, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', root]);
  if (diff.status !== 0) return 'failed';
  const text = String(diff.stdout ?? '');
  if (!text.trim()) return 'none';
  if (Buffer.byteLength(text) > MAX_PATCH_BYTES) return 'failed';
  try { fs.mkdirSync(path.dirname(patchFile), { recursive: true }); fs.writeFileSync(patchFile, text); } catch { return 'failed'; }
  return 'written';
}

export function sweepTaskWorkspaces(db: SweepDb, dataDir: string, options: SweepOptions = {}): SweepResult {
  const now = options.now ?? Date.now();
  const grace = options.graceMs ?? DAY;
  const expireActive = options.expireActiveMs ?? 7 * DAY;
  const retainPatch = options.retainPatchMs ?? 7 * DAY;
  const root = path.join(dataDir, 'panda-workspaces');
  const out: SweepResult = { removed: [], retainedPatches: [], kept: [], expiredPatches: [], bytesFreed: 0 };
  if (!fs.existsSync(root)) return out;

  const tasks = new Map<string, { status: string; updatedAt: number }>();
  for (const r of db.all<{ id: string; status: string; updatedAt: string }>('SELECT id, status, updatedAt FROM bridge_tasks')) {
    tasks.set(taskDirName(r.id), { status: r.status, updatedAt: Date.parse(r.updatedAt) || 0 });
  }

  const retained = path.join(root, RETAINED_DIR);
  if (fs.existsSync(retained)) {
    for (const f of fs.readdirSync(retained)) {
      const p = path.join(retained, f);
      try { if (now - fs.statSync(p).mtimeMs > retainPatch) { fs.rmSync(p, { force: true }); out.expiredPatches.push(f); } } catch { /* leave it */ }
    }
  }

  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === RETAINED_DIR) continue;
    const dir = path.join(root, e.name);
    const age = now - fs.statSync(dir).mtimeMs;
    const t = tasks.get(e.name.replace(/-(inspect|code)$/, ''));
    let removable = false;
    if (!t) removable = age > grace; // no task row: an orphan
    else if (FINISHED.has(t.status)) removable = now - t.updatedAt > grace && age > grace;
    else removable = now - t.updatedAt > expireActive && age > expireActive; // never finished: expired
    if (!removable) { out.kept.push({ dir: e.name, reason: t ? `task ${t.status}, within retention` : 'orphan within grace' }); continue; }

    const patch = path.join(retained, `${e.name}-${new Date(now).toISOString().replace(/[:.]/g, '-')}.patch`);
    const kept = retainChanges(dir, patch);
    if (kept === 'failed') { out.kept.push({ dir: e.name, reason: 'its changes could not be saved as a patch; nothing removed' }); continue; }
    if (kept === 'written') out.retainedPatches.push(path.basename(patch));
    const bytes = dirBytes(dir);
    unlinkLinks(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); out.removed.push(e.name); out.bytesFreed += bytes; } catch { out.kept.push({ dir: e.name, reason: 'could not be removed (in use?)' }); }
  }
  return out;
}

let lastSweep = 0;
/** At most once an hour; never throws. Returns null when it was skipped. */
export function sweepTaskWorkspacesThrottled(db: SweepDb, dataDir: string, now = Date.now()): SweepResult | null {
  if (now - lastSweep < 3600_000) return null;
  lastSweep = now;
  try { return sweepTaskWorkspaces(db, dataDir, { now }); } catch { return null; }
}
