import { describe, expect, it, vi } from 'vitest';
import { createNetworkDriveCapabilityAdapter } from '../runtime/networkDriveCapability';

describe('Network drive governed capability', () => {
  it('classifies listing as read-only and connect/disconnect as consequential', () => {
    const adapter = createNetworkDriveCapabilityAdapter();
    expect(adapter.classify('list_network_drives')).toBe('read_only');
    expect(adapter.classify('connect_network_drive')).toBe('consequential');
    expect(adapter.classify('disconnect_network_drive')).toBe('consequential');
  });

  it('lists currently mapped drives from Get-SmbMapping output', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify([{ LocalPath: 'Z:', RemotePath: '\\\\nas\\shared', Status: 'OK' }]),
    }));
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'list_network_drives', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('Z: -> \\\\nas\\shared (OK)');
  });

  it('handles a single mapping (PowerShell 5.1 ConvertTo-Json returns an object, not an array, for one item)', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify({ LocalPath: 'Y:', RemotePath: '\\\\server\\share', Status: 'OK' }),
    }));
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'list_network_drives', arguments: {} }, { cwd: process.cwd() });
    expect(result.output).toContain('Y: -> \\\\server\\share (OK)');
  });

  it('reports no drives cleanly when nothing is mapped', async () => {
    const runScript = vi.fn(async () => ({ succeeded: true, exitCode: 0, output: '' }));
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'list_network_drives', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('No network drives');
  });

  it('connects a drive with a validated letter and UNC path', async () => {
    const runScript = vi.fn(async (script: string) => {
      expect(script).toContain("New-SmbMapping -LocalPath 'Z:' -RemotePath '\\\\nas\\shared' -Persistent $true");
      return { succeeded: true, exitCode: 0, output: '' };
    });
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'connect_network_drive', arguments: { driveLetter: 'Z', uncPath: '\\\\nas\\shared' } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.normalizedArguments).toEqual({ driveLetter: 'Z', uncPath: '\\\\nas\\shared', username: null });
  });

  it('rejects an invalid drive letter or malformed UNC path without running anything', async () => {
    const runScript = vi.fn();
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const badLetter = await adapter.run({ name: 'connect_network_drive', arguments: { driveLetter: 'ZZ', uncPath: '\\\\nas\\shared' } }, { cwd: process.cwd() });
    expect(badLetter.status).toBe('failed');
    expect(badLetter.resultCategory).toBe('invalid_arguments');
    const badPath = await adapter.run({ name: 'connect_network_drive', arguments: { driveLetter: 'Z', uncPath: 'C:\\local\\path' } }, { cwd: process.cwd() });
    expect(badPath.status).toBe('failed');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('never lets a password reach evidence — redactArguments strips it', () => {
    const adapter = createNetworkDriveCapabilityAdapter();
    const redacted = adapter.redactArguments!('connect_network_drive', { driveLetter: 'Z', uncPath: '\\\\nas\\shared', password: 'hunter2' });
    expect(redacted.password).toBe('[redacted]');
  });

  it('escapes a single quote in a UNC path or credential so it cannot break out of the PowerShell script', async () => {
    const runScript = vi.fn(async (script: string) => {
      expect(script).toContain("-UserName 'o''brien'");
      return { succeeded: true, exitCode: 0, output: '' };
    });
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    await adapter.run({ name: 'connect_network_drive', arguments: { driveLetter: 'Z', uncPath: '\\\\nas\\shared', username: "o'brien" } }, { cwd: process.cwd() });
    expect(runScript).toHaveBeenCalled();
  });

  it('disconnects a mapped drive', async () => {
    const runScript = vi.fn(async (script: string) => {
      expect(script).toContain("Remove-SmbMapping -LocalPath 'Z:' -Force");
      return { succeeded: true, exitCode: 0, output: '' };
    });
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'disconnect_network_drive', arguments: { driveLetter: 'Z' } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
  });

  it('surfaces a PowerShell failure without throwing', async () => {
    const runScript = vi.fn(async () => ({ succeeded: false, exitCode: 1, output: 'Access is denied' }));
    const adapter = createNetworkDriveCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'connect_network_drive', arguments: { driveLetter: 'Z', uncPath: '\\\\nas\\shared' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('network_drive_connect_failed');
    expect(result.output).toContain('Access is denied');
  });
});
