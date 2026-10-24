import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createPortProcessManager } from '../runtime/portManager';
import type { ProcessIdentitySnapshot } from '../runtime/processOwnership';

describe('Port process manager', () => {
  function tmpDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')); }

  /** A live process identity that matches the recorded provenance below. */
  function liveIdentity(pid: number, overrides: Partial<ProcessIdentitySnapshot> = {}): ProcessIdentitySnapshot {
    return {
      pid,
      alive: true,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      creationTimeMs: 1_700_000_000_000,
      commandLine: 'node.exe core.js',
      ...overrides,
    };
  }

  it('allocates an OS-assigned port via listen(0)', async () => {
    const dir = tmpDir();
    const mgr = createPortProcessManager({ dataDir: dir });
    const port = await mgr.allocatePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('registers and lists a service with ownership', () => {
    const dir = tmpDir();
    const mgr = createPortProcessManager({ dataDir: dir });
    const rec = mgr.register({ name: 'core', port: 9500, pid: 1234, ownedByPandesh: true });
    expect(rec.name).toBe('core');
    expect(rec.ownedByPandesh).toBe(true);
    expect(mgr.list()).toHaveLength(1);
    expect(mgr.get('core')?.port).toBe(9500);
  });

  it('sees a service another holder registered after this manager was built', () => {
    const dir = tmpDir();
    // The capability the model reaches is built BEFORE the Core registers
    // itself. Without a refresh the model is told "no managed services" while
    // the Core is plainly running one.
    const reader = createPortProcessManager({ dataDir: dir });
    expect(reader.list()).toHaveLength(0);
    const writer = createPortProcessManager({ dataDir: dir });
    writer.register({ name: 'karkeDikha-core', port: 51234, pid: 4242, ownedByPandesh: true });
    expect(reader.list().map((r) => r.name)).toContain('karkeDikha-core');
    expect(reader.get('karkeDikha-core')?.port).toBe(51234);
  });

  it('reconciles stale records on construction', () => {
    const dir = tmpDir();
    const isAliveFn = vi.fn(() => false);
    const mgr1 = createPortProcessManager({ dataDir: dir, isAliveFn: () => true });
    mgr1.register({ name: 'svc', port: 9000, pid: 555, ownedByPandesh: true, processStartMs: 1000 });
    // New manager with dead process -> stale removed.
    const mgr2 = createPortProcessManager({ dataDir: dir, isAliveFn: () => false });
    expect(mgr2.list()).toHaveLength(0);
  });

  it('refuses to stop a service not owned by Pandesh', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({ dataDir: dir, killFn });
    mgr.register({ name: 'ollama', port: 11434, pid: 999, ownedByPandesh: false });
    const r = await mgr.stopOwned('ollama');
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain('not owned');
    expect(killFn).not.toHaveBeenCalled();
  });

  it('refuses to kill a process whose ownership provenance was never recorded', async () => {
    // A stored `ownedByPandesh` flag is a CLAIM, not evidence. Without a
    // provenance record the target may be an unrelated application whose PID
    // was recycled, so it is never terminated.
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({
      dataDir: dir,
      killFn,
      identityProvider: async (pid) => liveIdentity(pid),
    });
    mgr.register({ name: 'svc', port: 9000, pid: 1234, ownedByPandesh: true, processStartMs: 1_700_000_000_000, executable: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' });
    const r = await mgr.stopOwned('svc');
    expect(r.stopped).toBe(false);
    expect(r.reason).toContain('provenance');
    expect(killFn).not.toHaveBeenCalled();
  });

  it('detects PID reuse and refuses to kill', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({
      dataDir: dir,
      killFn,
      identityProvider: async (pid) => liveIdentity(pid, { creationTimeMs: 1_700_000_999_999 }),
    });
    mgr.register({ name: 'svc', port: 9000, pid: 1234, ownedByPandesh: true, processStartMs: 1_700_000_000_000, executable: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' });
    mgr.recordOwnership({
      pid: 1234,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const r = await mgr.stopOwned('svc');
    expect(r.stopped).toBe(false);
    expect(r.reason).toMatch(/different process|creation time/i);
    expect(killFn).not.toHaveBeenCalled();
  });

  it('stops a process whose ownership is proven', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({
      dataDir: dir,
      killFn,
      identityProvider: async (pid) => liveIdentity(pid),
    });
    mgr.register({ name: 'svc', port: 9000, pid: 1234, ownedByPandesh: true, processStartMs: 1_700_000_000_000, executable: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' });
    mgr.recordOwnership({
      pid: 1234,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const r = await mgr.stopOwned('svc');
    expect(r.stopped).toBe(true);
    expect(killFn).toHaveBeenCalledWith(1234);
    expect(mgr.get('svc')).toBeUndefined();
  });

  it('cleanupOrphans removes stale records without killing live owned ones by default', async () => {
    const dir = tmpDir();
    let alive = false;
    const mgr = createPortProcessManager({
      dataDir: dir,
      isAliveFn: () => alive,
      getProcessInfoFn: (pid) => ({ pid, alive, startMs: 1000, commandLine: null }),
    });
    mgr.register({ name: 'dead', port: 9001, pid: 1, ownedByPandesh: true, processStartMs: 1000 });
    alive = false;
    const r = await mgr.cleanupOrphans();
    expect(r.removed).toContain('dead');
    expect(r.killed).toHaveLength(0);
  });

  it('cleanupOrphans kills verified owned orphans when requested', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({
      dataDir: dir,
      isAliveFn: () => true,
      getProcessInfoFn: (pid) => ({ pid, alive: true, startMs: 1_700_000_000_000, commandLine: null }),
      killFn,
      identityProvider: async (pid) => liveIdentity(pid),
    });
    mgr.register({ name: 'orphan', port: 9002, pid: 2, ownedByPandesh: true, processStartMs: 1_700_000_000_000, executable: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' });
    mgr.recordOwnership({
      pid: 2,
      creationTimeMs: 1_700_000_000_000,
      executablePath: 'C:\\Program Files\\Pandesh\\runtime\\node.exe',
      source: 'test',
    });
    const r = await mgr.cleanupOrphans({ killOrphans: true });
    expect(r.killed).toContain('orphan');
    expect(killFn).toHaveBeenCalled();
  });

  it('cleanupOrphans refuses to kill a live process whose ownership is not proven', async () => {
    const dir = tmpDir();
    const killFn = vi.fn(() => true);
    const mgr = createPortProcessManager({
      dataDir: dir,
      isAliveFn: () => true,
      getProcessInfoFn: (pid) => ({ pid, alive: true, startMs: 1_700_000_000_000, commandLine: null }),
      killFn,
      identityProvider: async (pid) => liveIdentity(pid),
    });
    // No provenance: this PID may belong to an unrelated application.
    mgr.register({ name: 'foreign', port: 9005, pid: 7, ownedByPandesh: true, processStartMs: 1_700_000_000_000, executable: 'C:\\Program Files\\Pandesh\\runtime\\node.exe' });
    const r = await mgr.cleanupOrphans({ killOrphans: true });
    expect(r.killed).toHaveLength(0);
    expect(r.refused).toContain('foreign');
    expect(killFn).not.toHaveBeenCalled();
  });

  it('healthCheck reports unhealthy when process is dead', async () => {
    const dir = tmpDir();
    const mgr = createPortProcessManager({
      dataDir: dir,
      isAliveFn: () => false,
      getProcessInfoFn: (pid) => ({ pid, alive: false, startMs: null, commandLine: null }),
    });
    mgr.register({ name: 'svc', port: 9003, pid: 3, ownedByPandesh: true, processStartMs: 1000 });
    const h = await mgr.healthCheck('svc');
    expect(h.healthy).toBe(false);
  });

  it('healthCheck uses HTTP probe when healthUrl provided', async () => {
    const dir = tmpDir();
    const mgr = createPortProcessManager({
      dataDir: dir,
      fetchFn: async () => ({ ok: true, status: 200 }),
    });
    mgr.register({ name: 'svc', port: 9004, pid: null, ownedByPandesh: false, healthUrl: 'http://127.0.0.1:9004/health' });
    const h = await mgr.healthCheck('svc');
    expect(h.healthy).toBe(true);
  });

  it('isPortAvailable returns false when bind fails', async () => {
    const dir = tmpDir();
    const mgr = createPortProcessManager({
      dataDir: dir,
      // allocate a port then check same port unavailable
    });
    const port = await mgr.allocatePort();
    // bind it
    const net = await import('node:net');
    const srv = net.createServer();
    await new Promise<void>((resolve) => { srv.listen(port, '127.0.0.1', () => resolve()); });
    const available = await mgr.isPortAvailable(port);
    expect(available).toBe(false);
    srv.close();
  });
});
