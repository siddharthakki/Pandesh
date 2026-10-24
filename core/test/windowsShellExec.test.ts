import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runPowerShellScript } from '../runtime/windowsShellExec';

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  return child;
}

describe('runPowerShellScript', () => {
  it('resolves succeeded with stdout output on a clean exit', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const promise = runPowerShellScript('Get-Process', { spawnImpl });
    child.stdout.emit('data', Buffer.from('process list here'));
    child.emit('close', 0);
    const result = await promise;
    expect(result).toEqual({ succeeded: true, exitCode: 0, output: 'process list here' });
    expect(spawnImpl).toHaveBeenCalledWith('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process'], expect.objectContaining({ windowsHide: true }));
  });

  it('resolves failed with a nonzero exit code', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const promise = runPowerShellScript('Stop-Service missing', { spawnImpl });
    child.stderr.emit('data', Buffer.from('service not found'));
    child.emit('close', 1);
    const result = await promise;
    expect(result.succeeded).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('service not found');
  });

  it('resolves failed when the child process itself errors (e.g. powershell.exe missing)', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const promise = runPowerShellScript('Get-Process', { spawnImpl });
    child.emit('error', new Error('spawn powershell.exe ENOENT'));
    const result = await promise;
    expect(result.succeeded).toBe(false);
    expect(result.output).toContain('ENOENT');
  });

  it('times out and reports it rather than hanging forever', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    // A fabricated pid must never reach the real OS taskkill in a test.
    const spawnSyncImpl = vi.fn(() => ({}) as never);
    const result = await runPowerShellScript('Start-Sleep -Seconds 999', { spawnImpl, spawnSyncImpl, timeoutMs: 20 });
    expect(result.succeeded).toBe(false);
    expect(result.output).toContain('timed out');
    expect(spawnSyncImpl).toHaveBeenCalledWith('taskkill', ['/pid', '4242', '/t', '/f'], { windowsHide: true });
  });

  it('honors a raised maxOutputChars so structured JSON output is never truncated mid-document', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const longJson = JSON.stringify(Array.from({ length: 50 }, (_, i) => ({ Name: `svc${i}`, Status: 'Running' })));
    const promise = runPowerShellScript('Get-Service', { spawnImpl, maxOutputChars: 20_000 });
    child.stdout.emit('data', Buffer.from(longJson));
    child.emit('close', 0);
    const result = await promise;
    expect(result.output).toBe(longJson);
    expect(() => JSON.parse(result.output)).not.toThrow();
  });

  it('marks the result aborted when the signal fires before completion', async () => {
    const child = fakeChild();
    const spawnImpl = vi.fn(() => child as never);
    const spawnSyncImpl = vi.fn(() => ({}) as never);
    const controller = new AbortController();
    const promise = runPowerShellScript('Get-Process', { spawnImpl, spawnSyncImpl, signal: controller.signal });
    controller.abort();
    child.emit('close', 1);
    const result = await promise;
    expect(result.succeeded).toBe(false);
    expect(result.output).toContain('aborted');
    expect(spawnSyncImpl).toHaveBeenCalled();
  });
});
