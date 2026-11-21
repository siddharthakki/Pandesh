import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// @ts-expect-error plain ESM script without types
import { acquire, readLock, tryAcquire, withLock } from '../../scripts/lib/resource-lock.mjs';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'locks-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('resource locks for the GPU and scratch ports', () => {
  it('one holder at a time; the second learns who holds it', () => {
    const a = tryAcquire('gpu', 'nightly model check', { dir, pid: 111, alive: () => true });
    expect(a.ok).toBe(true);
    const b = tryAcquire('gpu', 'emulator qualification', { dir, pid: 222, alive: () => true });
    expect(b).toMatchObject({ ok: false, holder: { pid: 111, purpose: 'nightly model check' } });
    a.release();
    expect(tryAcquire('gpu', 'emulator qualification', { dir, pid: 222, alive: () => true }).ok).toBe(true);
  });

  it('takes over a lock whose process is gone, but never a live one', () => {
    tryAcquire('scratch-ports', 'old run', { dir, pid: 333, alive: () => true });
    expect(tryAcquire('scratch-ports', 'new run', { dir, pid: 444, alive: () => true }).ok).toBe(false);
    expect(tryAcquire('scratch-ports', 'new run', { dir, pid: 444, alive: (p: number) => p !== 333 }).ok).toBe(true);
    expect(readLock('scratch-ports', dir)).toMatchObject({ pid: 444, purpose: 'new run' });
  });

  it('release only removes its own lock', () => {
    const a = tryAcquire('ollama-27b', 'a', { dir, pid: 1, alive: () => false });
    tryAcquire('ollama-27b', 'b', { dir, pid: 2, alive: () => false }); // pid 1 "gone": b takes over
    a.release();
    expect(readLock('ollama-27b', dir)).toMatchObject({ pid: 2 });
  });

  it('acquire waits, then times out naming the holder; withLock releases on error', async () => {
    tryAcquire('gpu', 'long job', { dir, pid: 555, alive: () => true });
    await expect(acquire('gpu', 'second', { dir, waitMs: 30, pollMs: 10, alive: () => true })).rejects.toThrow(/held by pid 555 \(long job\)/);
    const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'locks2-'));
    await expect(withLock('gpu', 'boom', async () => { throw new Error('job failed'); }, { dir: d2 })).rejects.toThrow('job failed');
    expect(readLock('gpu', d2)).toBeNull();
    fs.rmSync(d2, { recursive: true, force: true });
  });

  it('refuses lock names that could escape the locks directory', () => {
    expect(() => tryAcquire('../etc', 'x', { dir })).toThrow(/invalid lock name/);
  });
});
