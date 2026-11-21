/**
 * Cross-process locks for shared machine resources (the RTX 3090, the scratch ports 3991/3992/9481, the 27B model), so scheduled
 * jobs, local pipelines and test runs do not contend. A lock is a file created exclusively (`wx`) under the locks directory,
 * holding the owner's pid, purpose and start time. A lock whose pid is gone is stale and may be taken over; a live one is never
 * broken. Nothing here kills processes.
 *
 *   import { acquire, withLock } from './resource-lock.mjs';
 *   await withLock('gpu', 'nightly model check', async () => { ... }, { waitMs: 30 * 60_000 });
 *
 * CLI: node scripts/lib/resource-lock.mjs status        (lists held locks)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KNOWN_RESOURCES = ['gpu', 'scratch-ports', 'ollama-27b'];

export function locksDir(env = process.env) {
  return env.PANDESH_LOCKS_DIR || path.join(env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Pandesh', 'locks');
}

const lockFile = (name, dir) => {
  if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) throw new Error(`invalid lock name '${name}'`);
  return path.join(dir, `${name}.lock`);
};

/** True when a process with this pid exists (signal 0 checks without touching it). */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === 'EPERM'; }
}

export function readLock(name, dir = locksDir()) {
  try { return JSON.parse(fs.readFileSync(lockFile(name, dir), 'utf8')); } catch { return null; }
}

/**
 * Tries once. Returns { ok: true, release } or { ok: false, holder }. A stale lock (its pid is gone, or unreadable for longer than
 * a minute) is removed and taken over.
 */
export function tryAcquire(name, purpose, { dir = locksDir(), pid = process.pid, alive = pidAlive } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(name, dir);
  const body = JSON.stringify({ name, pid, purpose: String(purpose).slice(0, 200), host: os.hostname(), since: new Date().toISOString() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      let released = false;
      return { ok: true, release: () => { if (released) return; released = true; const cur = readLock(name, dir); if (cur && cur.pid === pid) fs.rmSync(file, { force: true }); } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const holder = readLock(name, dir);
      const unreadableTooLong = !holder && Date.now() - fs.statSync(file).mtimeMs > 60_000;
      if ((holder && !alive(holder.pid)) || unreadableTooLong) { fs.rmSync(file, { force: true }); continue; }
      return { ok: false, holder };
    }
  }
  return { ok: false, holder: readLock(name, dir) };
}

/** Waits up to waitMs (polling) for the lock. Throws with the holder's details on timeout. */
export async function acquire(name, purpose, { waitMs = 0, pollMs = 2000, ...opts } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const r = tryAcquire(name, purpose, opts);
    if (r.ok) return r.release;
    if (Date.now() >= deadline) throw new Error(`resource '${name}' is held by pid ${r.holder?.pid} (${r.holder?.purpose ?? 'unknown'}) since ${r.holder?.since ?? '?'}`);
    await new Promise((res) => setTimeout(res, Math.min(pollMs, Math.max(1, deadline - Date.now()))));
  }
}

export async function withLock(name, purpose, fn, opts = {}) {
  const release = await acquire(name, purpose, opts);
  try { return await fn(); } finally { release(); }
}

if (process.argv[1]?.endsWith('resource-lock.mjs') && process.argv[2] === 'status') {
  const dir = locksDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.lock')) : [];
  if (!files.length) console.log('no locks held');
  for (const f of files) { const l = readLock(f.replace(/\.lock$/, ''), dir); console.log(`${f}: pid ${l?.pid} ${pidAlive(l?.pid) ? 'alive' : 'STALE'} — ${l?.purpose} since ${l?.since}`); }
}
