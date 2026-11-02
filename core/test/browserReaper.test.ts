import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reapOrphanedBrowsers, type BrowserProcessRecord } from '../runtime/browserSession';
import { browserProfileRoot } from '../runtime/browserInspection';

const dirs: string[] = [];
function setup(records: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reaper-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'browser-launched-processes.json'), typeof records === 'string' ? records : JSON.stringify(records));
  return dir;
}
function left(dir: string): BrowserProcessRecord[] {
  return JSON.parse(fs.readFileSync(path.join(dir, 'browser-launched-processes.json'), 'utf8'));
}
const SPAWN = 1_700_000_000_000;
const rec = (over: Partial<BrowserProcessRecord> = {}): BrowserProcessRecord => ({ pid: 4242, corePid: 999_991, sessionId: '', startedAt: '', spawnedAtMs: SPAWN, ...over });
const snap = (creationTimeMs: number | null, alive = true) => () => ({ pid: 4242, alive, executablePath: null, creationTimeMs, commandLine: null });

afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('reapOrphanedBrowsers', () => {
  it('kills a browser whose launcher is dead and whose creation time matches', () => {
    const dir = setup([rec()]);
    const killed: number[] = [];
    const out = reapOrphanedBrowsers(dir, { identity: snap(SPAWN + 500), isAlive: () => false, kill: (p) => killed.push(p) });
    expect(out.reaped).toBe(1);
    expect(killed).toEqual([4242]);
    expect(left(dir)).toEqual([]);
  });

  it('keeps records whose launcher Core is still alive', () => {
    const dir = setup([rec()]);
    const killed: number[] = [];
    const out = reapOrphanedBrowsers(dir, { identity: snap(SPAWN), isAlive: () => true, kill: (p) => killed.push(p) });
    expect(out.reaped).toBe(0);
    expect(killed).toEqual([]);
    expect(left(dir)).toHaveLength(1);
  });

  it('never kills a reused PID: creation time far from the recorded spawn', () => {
    const dir = setup([rec()]);
    const killed: number[] = [];
    const out = reapOrphanedBrowsers(dir, { identity: snap(SPAWN + 3_600_000), isAlive: () => false, kill: (p) => killed.push(p) });
    expect(out.reaped).toBe(0);
    expect(killed).toEqual([]);
    expect(left(dir)).toEqual([]);
  });

  it('does not kill when identity is unverifiable, and drops dead processes', () => {
    const dir = setup([rec(), rec({ pid: 7 }), rec({ pid: 8, spawnedAtMs: undefined })]);
    const killed: number[] = [];
    const identity = (pid: number) => ({ pid, alive: pid !== 7, executablePath: null, creationTimeMs: null, commandLine: null });
    const out = reapOrphanedBrowsers(dir, { identity, isAlive: () => false, kill: (p) => killed.push(p) });
    expect(killed).toEqual([]);
    expect(out.errors).toHaveLength(2);
  });

  describe('by managed profile (launcher PID handed off)', () => {
    const profile = path.join(browserProfileRoot(), 'profile-Abc123');
    const cmd = (dir: string) => `"msedge.exe" --headless=new --user-data-dir="${dir}" --remote-debugging-port=1 about:blank`;
    const ident = (commandLine: string) => (pid: number) => ({ pid, alive: true, executablePath: null, creationTimeMs: null, commandLine });

    it('kills the recorded real browser PID while it still owns the profile', () => {
      const dir = setup([rec({ browserPid: 5151, profileDir: profile })]);
      const killed: number[] = [];
      const removed: string[] = [];
      const out = reapOrphanedBrowsers(dir, {
        identity: ident(cmd(profile)), isAlive: () => false, kill: (p) => killed.push(p),
        findByProfile: () => [9999], removeProfile: (p) => removed.push(p),
      });
      expect(out.reaped).toBe(1);
      expect(killed).toEqual([5151]);
      expect(removed).toEqual([profile]);
      expect(left(dir)).toEqual([]);
    });

    it('never kills a reused browser PID; finds the profile owner by command line instead', () => {
      const dir = setup([rec({ browserPid: 5151, profileDir: profile })]);
      const killed: number[] = [];
      const out = reapOrphanedBrowsers(dir, {
        identity: ident(cmd(path.join(os.tmpdir(), 'someone-else'))), isAlive: () => false, kill: (p) => killed.push(p),
        findByProfile: (p) => (p === profile ? [6161] : []), removeProfile: () => undefined,
      });
      expect(killed).toEqual([6161]);
      expect(out.reaped).toBe(1);
    });

    it('ignores a profile outside the managed root, and keeps a live Core\'s records', () => {
      const dir = setup([
        rec({ browserPid: 5151, profileDir: path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data') }),
        rec({ corePid: 1, browserPid: 7171, profileDir: profile }),
      ]);
      const killed: number[] = [];
      reapOrphanedBrowsers(dir, {
        identity: ident(cmd(profile)), isAlive: (pid) => pid === 1, kill: (p) => killed.push(p),
        findByProfile: () => [8181], removeProfile: () => undefined,
      });
      expect(killed).toEqual([]);
      expect(left(dir)).toHaveLength(1);
    });
  });

  it('survives a corrupt record file', () => {
    const dir = setup('{not json');
    expect(reapOrphanedBrowsers(dir, { isAlive: () => false })).toEqual({ reaped: 0, errors: [] });
  });
});
