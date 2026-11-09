/**
 * The in-app updater's rollback force-stops "the Core" and "the Pandesh it launched" by PID. Those PIDs come from
 * core.json and from a remembered spawn; by the time a rollback runs, Windows may have recycled either PID, and a
 * copied profile's core.json names another profile's Core. Build 160's rollback ran `taskkill /PID <pid> /T /F` on
 * them with no identity check at all. The rule now: only the expected executable, created after this update started it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
// @ts-expect-error — plain ES module shipped in the install tree (no type declarations)
import { mayForceStop, readProcessIdentity } from '../updater/update-lib.mjs';

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) { try { child.kill(); } catch { /* gone */ } }
});

describe('updater force-stop guard', () => {
  it('refuses when the identity is unknown, the executable differs or the process is older than the update', () => {
    const exe = path.join('E:\\Pandesh', 'runtime', 'node.exe');
    const launchedAt = Date.parse('2026-11-10T08:00:00Z');
    expect(mayForceStop(null, exe, launchedAt)).toBe(false);
    expect(mayForceStop({ executablePath: null, creationTimeMs: launchedAt + 5_000 }, exe, launchedAt)).toBe(false);
    expect(mayForceStop({ executablePath: exe, creationTimeMs: null }, exe, launchedAt)).toBe(false);
    // A recycled PID now running something else.
    expect(mayForceStop({ executablePath: 'C:\\Windows\\System32\\notepad.exe', creationTimeMs: launchedAt + 5_000 }, exe, launchedAt)).toBe(false);
    // The same program, but started long before this update launched anything (e.g. another profile's Core).
    expect(mayForceStop({ executablePath: exe, creationTimeMs: launchedAt - 60_000 }, exe, launchedAt)).toBe(false);
    // Nothing was launched by this update: nothing may be force-stopped.
    expect(mayForceStop({ executablePath: exe, creationTimeMs: launchedAt + 5_000 }, exe, Number.POSITIVE_INFINITY)).toBe(false);
    // The process this update started (path compared case-insensitively).
    expect(mayForceStop({ executablePath: exe.toUpperCase(), creationTimeMs: launchedAt + 5_000 }, exe, launchedAt)).toBe(true);
  });

  it.runIf(process.platform === 'win32')('reads the real identity of a live process and applies the rule to it', async () => {
    const before = Date.now();
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
    children.push(child);
    await new Promise((r) => setTimeout(r, 500));
    const identity = readProcessIdentity(child.pid as number);
    expect(identity).not.toBeNull();
    expect(path.resolve(identity.executablePath).toLowerCase()).toBe(path.resolve(process.execPath).toLowerCase());
    expect(mayForceStop(identity, process.execPath, before)).toBe(true);
    expect(mayForceStop(identity, process.execPath, Date.now() + 60_000)).toBe(false);
    expect(mayForceStop(identity, 'C:\\Program Files\\Other\\other.exe', before)).toBe(false);
    child.kill();
    await new Promise((r) => setTimeout(r, 500));
    expect(readProcessIdentity(child.pid as number)).toBeNull();
  }, 30_000);
});
