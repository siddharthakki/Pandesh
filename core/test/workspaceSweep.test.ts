import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RETAINED_DIR, sweepTaskWorkspaces, type SweepDb } from '../runtime/kandev/workspaceSweep';
import { prepareTaskWorkspace } from '../runtime/kandev/pandaBridge';

// Lifecycle of the bridge's private task copies: finished, cancelled, failed, expired and orphaned copies go; unresolved
// work is kept as one patch; running tasks and fresh copies are never touched; junctions are never followed.

const DAY = 24 * 3600 * 1000;
describe('panda-workspaces retention', () => {
  let dataDir = '';
  let tasks: { id: string; status: string; updatedAt: string }[] = [];
  const db: SweepDb = { all: <T,>() => tasks as unknown as T[] };
  const now = Date.parse('2026-11-24T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  const age = (dir: string, ms: number) => { const t = new Date(now - ms); fs.utimesSync(dir, t, t); };
  const copy = (taskId: string) => path.join(dataDir, 'panda-workspaces', taskId.replace(/[^\w-]/g, '_'));

  beforeEach(() => { dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-sweep-')); tasks = []; });
  afterEach(() => { fs.rmSync(dataDir, { recursive: true, force: true }); });

  it('removes a finished copy with no changes, and keeps no patch', () => {
    const dir = prepareTaskWorkspace(dataDir, 'ptask_done');
    tasks.push({ id: 'ptask_done', status: 'completed', updatedAt: ago(3 * DAY) });
    age(dir, 3 * DAY);
    const r = sweepTaskWorkspaces(db, dataDir, { now });
    expect(r.removed).toEqual(['ptask_done']);
    expect(r.retainedPatches).toEqual([]);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps unresolved changes of a failed task as one patch, then removes the copy', () => {
    const dir = prepareTaskWorkspace(dataDir, 'ptask_failed');
    fs.writeFileSync(path.join(dir, 'half-done.js'), 'export const x = 1;\n');
    fs.appendFileSync(path.join(dir, 'README.md'), 'edited\n');
    tasks.push({ id: 'ptask_failed', status: 'failed', updatedAt: ago(2 * DAY) });
    age(dir, 2 * DAY);
    const r = sweepTaskWorkspaces(db, dataDir, { now });
    expect(r.removed).toEqual(['ptask_failed']);
    expect(r.retainedPatches).toHaveLength(1);
    const patch = fs.readFileSync(path.join(dataDir, 'panda-workspaces', RETAINED_DIR, r.retainedPatches[0]), 'utf8');
    expect(patch).toContain('half-done.js');
    expect(patch).toContain('+edited');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('removes a cancelled copy and an orphan (no task row) after the grace period', () => {
    const a = prepareTaskWorkspace(dataDir, 'ptask_cancelled');
    const b = prepareTaskWorkspace(dataDir, 'ptask_orphan');
    tasks.push({ id: 'ptask_cancelled', status: 'cancelled', updatedAt: ago(2 * DAY) });
    age(a, 2 * DAY); age(b, 2 * DAY);
    expect(sweepTaskWorkspaces(db, dataDir, { now }).removed.sort()).toEqual(['ptask_cancelled', 'ptask_orphan']);
  });

  it('never touches a running task, a fresh copy, or a finished copy inside the grace period', () => {
    const run = prepareTaskWorkspace(dataDir, 'ptask_running');
    const fresh = prepareTaskWorkspace(dataDir, 'ptask_fresh');
    tasks.push({ id: 'ptask_running', status: 'running', updatedAt: ago(2 * DAY) });
    tasks.push({ id: 'ptask_fresh', status: 'completed', updatedAt: ago(1000) });
    age(run, 2 * DAY); age(fresh, 1000);
    const r = sweepTaskWorkspaces(db, dataDir, { now });
    expect(r.removed).toEqual([]);
    expect(fs.existsSync(run) && fs.existsSync(fresh)).toBe(true);
  });

  it('expires a task that never finished after seven days', () => {
    const dir = prepareTaskWorkspace(dataDir, 'ptask_stuck');
    tasks.push({ id: 'ptask_stuck', status: 'awaiting_executor', updatedAt: ago(8 * DAY) });
    age(dir, 8 * DAY);
    expect(sweepTaskWorkspaces(db, dataDir, { now }).removed).toEqual(['ptask_stuck']);
  });

  it('does not follow a node_modules junction into the owner\'s checkout', () => {
    const owner = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-owner-'));
    try {
      fs.mkdirSync(path.join(owner, 'node_modules'));
      fs.writeFileSync(path.join(owner, 'node_modules', 'keep.txt'), 'the owner\'s dependency\n');
      const dir = prepareTaskWorkspace(dataDir, 'ptask_link');
      fs.symlinkSync(path.join(owner, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
      tasks.push({ id: 'ptask_link', status: 'completed', updatedAt: ago(3 * DAY) });
      age(dir, 3 * DAY);
      expect(sweepTaskWorkspaces(db, dataDir, { now }).removed).toEqual(['ptask_link']);
      expect(fs.readFileSync(path.join(owner, 'node_modules', 'keep.txt'), 'utf8')).toContain('dependency');
    } finally { fs.rmSync(owner, { recursive: true, force: true }); }
  });

  it('expires retained patches after seven days and leaves younger ones', () => {
    const retained = path.join(dataDir, 'panda-workspaces', RETAINED_DIR);
    fs.mkdirSync(retained, { recursive: true });
    const old = path.join(retained, 'old.patch'); const young = path.join(retained, 'young.patch');
    fs.writeFileSync(old, 'x'); fs.writeFileSync(young, 'x');
    const t = new Date(now - 9 * DAY); fs.utimesSync(old, t, t);
    const r = sweepTaskWorkspaces(db, dataDir, { now });
    expect(r.expiredPatches).toEqual(['old.patch']);
    expect(fs.existsSync(young)).toBe(true);
  });
});
