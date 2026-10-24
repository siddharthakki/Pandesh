import { describe, expect, it, vi } from 'vitest';
import { createSystemManagementCapabilityAdapter } from '../runtime/systemManagementCapability';

describe('System management governed capability', () => {
  it('classifies list tools as read-only and every mutating tool as consequential', () => {
    const adapter = createSystemManagementCapabilityAdapter();
    expect(adapter.classify('system_list_processes')).toBe('read_only');
    expect(adapter.classify('system_hardware_telemetry')).toBe('read_only');
    expect(adapter.classify('system_list_services')).toBe('read_only');
    expect(adapter.classify('system_list_startup_items')).toBe('read_only');
    expect(adapter.classify('system_kill_process')).toBe('consequential');
    expect(adapter.classify('system_start_service')).toBe('consequential');
    expect(adapter.classify('system_stop_service')).toBe('consequential');
    expect(adapter.classify('system_set_scheduled_task_enabled')).toBe('consequential');
  });

  it('lists processes sorted by CPU', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify([{ Id: 1234, ProcessName: 'chrome', CPU: 42.5, WorkingSetMB: 512.3 }]),
    }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_list_processes', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('1234 chrome (CPU 42.5, 512.3 MB)');
  });

  it('kills a process by validated positive-integer pid', async () => {
    const runScript = vi.fn(async (script: string) => {
      expect(script).toBe('Stop-Process -Id 1234 -Force');
      return { succeeded: true, exitCode: 0, output: '' };
    });
    const adapter = createSystemManagementCapabilityAdapter({
      runScript,
      identityProvider: async (pid: number) => ({
        pid,
        alive: true,
        executablePath: 'C:\\Users\\siddh\\dev\\server.exe',
        creationTimeMs: 1_700_000_000_000,
        commandLine: 'server.exe',
      }),
    });
    const result = await adapter.run({ name: 'system_kill_process', arguments: { pid: 1234 } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.normalizedArguments).toEqual({ pid: 1234 });
    expect(result.output).toContain('server.exe');
  });

  it('freezes the target identity into the approved arguments', async () => {
    const adapter = createSystemManagementCapabilityAdapter({
      runScript: vi.fn(async () => ({ succeeded: true, exitCode: 0, output: '' })),
      identityProvider: async (pid: number) => ({
        pid,
        alive: true,
        executablePath: 'C:\\Users\\siddh\\dev\\server.exe',
        creationTimeMs: 1_700_000_000_000,
        commandLine: 'server.exe',
      }),
    });
    const prepared = await adapter.prepare!('system_kill_process', { pid: 1234 });
    expect(prepared.targetCreatedAtMs).toBe(1_700_000_000_000);
    expect(prepared.targetExecutablePath).toBe('C:\\Users\\siddh\\dev\\server.exe');
  });

  it('refuses to kill a process whose identity cannot be read', async () => {
    const runScript = vi.fn();
    const adapter = createSystemManagementCapabilityAdapter({
      runScript,
      identityProvider: async (pid: number) => ({ pid, alive: false, executablePath: null, creationTimeMs: null, commandLine: null }),
    });
    const result = await adapter.run({ name: 'system_kill_process', arguments: { pid: 1234 } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('system_process_not_running');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('refuses to kill a pid that now hosts a different process', async () => {
    const runScript = vi.fn();
    const adapter = createSystemManagementCapabilityAdapter({
      runScript,
      identityProvider: async (pid: number) => ({
        pid,
        alive: true,
        executablePath: 'C:\\Users\\siddh\\dev\\other.exe',
        creationTimeMs: 1_700_000_999_999,
        commandLine: 'other.exe',
      }),
    });
    const result = await adapter.run(
      { name: 'system_kill_process', arguments: { pid: 1234, targetCreatedAtMs: 1_700_000_000_000, targetExecutablePath: 'C:\\Users\\siddh\\dev\\server.exe' } },
      { cwd: process.cwd() },
    );
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('system_process_target_changed');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('rejects a non-positive-integer pid without running anything', async () => {
    const runScript = vi.fn();
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_kill_process', arguments: { pid: -5 } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('invalid_arguments');
    expect(runScript).not.toHaveBeenCalled();
  });

  it('lists services with their status', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify([{ Name: 'Spooler', DisplayName: 'Print Spooler', Status: 'Running' }]),
    }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_list_services', arguments: {} }, { cwd: process.cwd() });
    expect(result.output).toContain('Spooler — Print Spooler (Running)');
  });

  it('starts and stops a service by exact name', async () => {
    const runScript = vi.fn(async (script: string) => ({ succeeded: true, exitCode: 0, output: script }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const started = await adapter.run({ name: 'system_start_service', arguments: { serviceName: 'Spooler' } }, { cwd: process.cwd() });
    expect(started.status).toBe('succeeded');
    expect(runScript).toHaveBeenCalledWith("Start-Service -Name 'Spooler'");
    const stopped = await adapter.run({ name: 'system_stop_service', arguments: { serviceName: 'Spooler' } }, { cwd: process.cwd() });
    expect(stopped.status).toBe('succeeded');
    expect(runScript).toHaveBeenCalledWith("Stop-Service -Name 'Spooler' -Force");
  });

  it('lists startup items and non-Microsoft scheduled tasks together', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify({
        startupItems: [{ Name: 'OneDrive', Command: 'onedrive.exe /background', Location: 'Registry' }],
        scheduledTasks: [{ TaskName: 'MyBackup', TaskPath: '\\', State: 'Ready' }],
      }),
    }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_list_startup_items', arguments: {} }, { cwd: process.cwd() });
    expect(result.output).toContain('[startup item, read-only] OneDrive');
    expect(result.output).toContain('[scheduled task] \\MyBackup (Ready)');
  });

  it('enables and disables a scheduled task, never touching classic startup items', async () => {
    const runScript = vi.fn(async (script: string) => ({ succeeded: true, exitCode: 0, output: script }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const enabled = await adapter.run({ name: 'system_set_scheduled_task_enabled', arguments: { taskName: 'MyBackup', taskPath: '\\', enabled: true } }, { cwd: process.cwd() });
    expect(enabled.status).toBe('succeeded');
    expect(runScript).toHaveBeenCalledWith("Enable-ScheduledTask -TaskName 'MyBackup' -TaskPath '\\'");
    const disabled = await adapter.run({ name: 'system_set_scheduled_task_enabled', arguments: { taskName: 'MyBackup', taskPath: '\\', enabled: false } }, { cwd: process.cwd() });
    expect(disabled.status).toBe('succeeded');
    expect(runScript).toHaveBeenCalledWith("Disable-ScheduledTask -TaskName 'MyBackup' -TaskPath '\\'");
  });

  it('surfaces a PowerShell failure (e.g. access denied) without throwing', async () => {
    const runScript = vi.fn(async () => ({ succeeded: false, exitCode: 1, output: 'Access is denied' }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_stop_service', arguments: { serviceName: 'Spooler' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('system_service_stop_failed');
    expect(result.output).toContain('Access is denied');
  });

  it('fails cleanly on unparseable JSON rather than throwing', async () => {
    const runScript = vi.fn(async () => ({ succeeded: true, exitCode: 0, output: 'not json' }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_list_processes', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('system_process_list_unparseable');
  });

  it('reads hardware telemetry', async () => {
    const runScript = vi.fn(async () => ({
      succeeded: true, exitCode: 0,
      output: JSON.stringify({ CPU: { Model: 'AMD Ryzen 9 5900X' }, RAM: { TotalGB: 64 } }),
    }));
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'system_hardware_telemetry', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('AMD Ryzen 9 5900X');
    expect(result.resultCategory).toBe('system_hardware_telemetry_probed');
  });

  it('classifies run_system_diagnostics as read-only', () => {
    const adapter = createSystemManagementCapabilityAdapter();
    expect(adapter.classify('run_system_diagnostics')).toBe('read_only');
    expect(adapter.classify('system_list_models')).toBe('read_only');
  });

  it('runs comprehensive system diagnostics with per-check success/failure states', async () => {
    const runScript = vi.fn(async (script: string) => {
      if (script.includes('Win32_Processor')) {
        return { succeeded: true, exitCode: 0, output: JSON.stringify({ Model: 'AMD Ryzen 9 5900X', Cores: 12, LogicalProcessors: 24, LoadPercent: 25 }) };
      }
      if (script.includes('Win32_OperatingSystem')) {
        return { succeeded: true, exitCode: 0, output: JSON.stringify({ TotalGB: 64, FreeGB: 32, UsedPercent: 50 }) };
      }
      if (script.includes('Win32_LogicalDisk')) {
        return { succeeded: true, exitCode: 0, output: JSON.stringify([{ Drive: 'C:', TotalGB: 1000, FreeGB: 500, UsedPercent: 50 }]) };
      }
      if (script.includes('nvidia-smi')) {
        return { succeeded: true, exitCode: 0, output: 'NVIDIA GeForce RTX 3090, 560.70, 24576, 4096, 15, 62' };
      }
      if (script.includes('Get-Process')) {
        return { succeeded: true, exitCode: 0, output: JSON.stringify([{ Id: 1, ProcessName: 'chrome', CPU: 42.5, WorkingSetMB: 512.3 }]) };
      }
      return { succeeded: false, exitCode: 1, output: 'unexpected script' };
    });
    const fetchMock = vi.fn(async (url: any) => {
      if (String(url).includes('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ models: [{ name: 'qwen3-coder:swift-27b' }] }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ models: [{ name: 'qwen3-coder:swift-27b' }] }),
      };
    });
    vi.stubGlobal('fetch', fetchMock);
    const adapter = createSystemManagementCapabilityAdapter({ runScript });
    const result = await adapter.run({ name: 'run_system_diagnostics', arguments: {} }, { cwd: process.cwd() });
    vi.unstubAllGlobals();
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('system_diagnostics_run');
    const parsed = JSON.parse(String(result.output));
    expect(parsed.checks.os.success).toBe(true);
    expect(parsed.checks.cpu.success).toBe(true);
    expect(parsed.checks.cpu.data.model).toContain('Ryzen 9 5900X');
    expect(parsed.checks.ram.success).toBe(true);
    expect(parsed.checks.disks.success).toBe(true);
    expect(parsed.checks.gpu.success).toBe(true);
    expect(parsed.checks.gpu.data.name).toContain('RTX 3090');
    expect(parsed.checks.processes.success).toBe(true);
    expect(parsed.checks.ollama.success).toBe(true);
    expect(parsed.checks.ollama.data.models).toContain('qwen3-coder:swift-27b');
    expect(parsed.checks.ollama.data.resident).toContain('qwen3-coder:swift-27b');
    expect(parsed.checks.core.success).toBe(true);
  });

  it('queries configured local model provider via system_list_models', async () => {
    const fetchMock = vi.fn(async (url: any) => {
      const urlStr = String(url);
      if (urlStr.includes('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: 'qwen3-coder:swift-27b', size: 17394614272, details: { parameter_size: '27B', quantization_level: 'Q4_K_M' } },
              { name: 'deepseek-r1:14b', size: 9663676416, details: { parameter_size: '14B', quantization_level: 'Q4_K_M' } },
            ],
          }),
        };
      }
      if (urlStr.includes('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [
              { name: 'qwen3-coder:swift-27b', size_vram: 17394614272, expires_at: '2026-10-24T16:00:00Z', context_length: 32768 },
            ],
          }),
        };
      }
      return { ok: false, status: 404 };
    });

    const adapter = createSystemManagementCapabilityAdapter({
      fetchImpl: fetchMock as any,
      activeModel: 'qwen3-coder:swift-27b',
    });
    const result = await adapter.run({ name: 'system_list_models', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('models_listed');
    expect(result.output).toContain('Ollama');
    expect(result.output).toContain('Active Model in Pandesh: qwen3-coder:swift-27b');
    expect(result.output).toContain('Currently Loaded / Running in VRAM (1)');
    expect(result.output).toContain('qwen3-coder:swift-27b');
    expect(result.output).toContain('Available Installed Models (2)');
    expect(result.output).toContain('deepseek-r1:14b');
  });

  it('reports failure gracefully when local model provider is unreachable', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:11434');
    });

    const adapter = createSystemManagementCapabilityAdapter({
      fetchImpl: fetchMock as any,
    });
    const result = await adapter.run({ name: 'system_list_models', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('model_provider_unreachable');
    expect(result.output).toContain('ECONNREFUSED');
    expect(result.output).toContain('Ensure Ollama is running locally');
  });
});
