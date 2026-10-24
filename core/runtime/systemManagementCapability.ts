import * as os from 'node:os';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { runPowerShellScript } from './windowsShellExec';
import {
  createWindowsProcessIdentityProvider,
  type ProcessIdentityProvider,
} from './processOwnership';

export interface SystemManagementCapabilityOptions {
  runScript?: typeof runPowerShellScript;
  /** Read-only process identity lookups, used to bind a termination to one process. */
  identityProvider?: ProcessIdentityProvider;
  fetchImpl?: typeof fetch;
  ollamaUrl?: string;
  activeModel?: string | (() => string | undefined);
}

const JSON_OUTPUT_CHARS = 24_000;
const READ_ONLY_TOOLS = new Set(['system_list_processes', 'system_list_services', 'system_list_startup_items', 'system_hardware_telemetry', 'run_system_diagnostics', 'system_list_models']);

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function asRows<T>(parsed: unknown): T[] {
  if (Array.isArray(parsed)) return parsed as T[];
  if (parsed && typeof parsed === 'object') return [parsed as T];
  return [];
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function nonEmptyString(value: unknown, maxChars = 200): string | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed && trimmed.length <= maxChars ? trimmed : null;
}

interface ProcessRow { Id?: number; ProcessName?: string; CPU?: number; WorkingSetMB?: number }
interface ServiceRow { Name?: string; DisplayName?: string; Status?: string }
interface StartupItemRow { Name?: string; Command?: string; Location?: string }
interface ScheduledTaskRow { TaskName?: string; TaskPath?: string; State?: string }

/**
 * System management: process visibility + kill, service visibility +
 * start/stop, and startup/scheduled-task visibility + scheduled-task
 * enable/disable (confirmed scope). Classic registry/Startup-folder items
 * are read-only here on purpose — there is no safe, reversible native
 * toggle for them the way `Enable-ScheduledTask`/`Disable-ScheduledTask`
 * exist for scheduled tasks; editing that registry key directly would be a
 * destructive, hard-to-undo mutation this capability deliberately avoids.
 * Backed by the same bounded PowerShell execution as network drives.
 */
export function createSystemManagementCapabilityAdapter(options: SystemManagementCapabilityOptions = {}): GovernedCapabilityAdapter {
  const run = options.runScript ?? runPowerShellScript;
  const identityProvider = options.identityProvider ?? createWindowsProcessIdentityProvider();

  async function listProcesses(): Promise<ToolExecutionResult> {
    const script = 'Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 Id, ProcessName, CPU, '
      + "@{N='WorkingSetMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json -Compress";
    const result = await run(script, { maxOutputChars: JSON_OUTPUT_CHARS });
    if (!result.succeeded) return failure(result.output || 'Get-Process failed', 'system_process_list_failed');
    let rows: ProcessRow[];
    try {
      rows = asRows<ProcessRow>(JSON.parse(result.output.trim() || '[]'));
    } catch {
      return failure(`Could not parse process list: ${result.output}`, 'system_process_list_unparseable');
    }
    const lines = rows.map((row) => `${row.Id ?? '?'} ${row.ProcessName ?? '?'} (CPU ${row.CPU ?? 0}, ${row.WorkingSetMB ?? 0} MB)`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n') || '(no processes)', resultCategory: 'system_processes_listed' };
  }

  /**
   * Terminates one process, but only the exact process that was inspected.
   *
   * The target's identity (creation time and executable path) is read BEFORE
   * the approval is created and frozen into the approved arguments, so the
   * human approves "kill this exact process". At execution the identity is
   * read again: if the PID now hosts a different process, or the OS will not
   * disclose who it is, the termination is refused. A bare PID is never
   * enough.
   */
  async function killProcess(call: ModelToolCall): Promise<ToolExecutionResult> {
    const pid = positiveInt(call.arguments.pid);
    if (!pid) return failure('pid must be a positive integer', 'invalid_arguments');
    const expectedCreatedAt = typeof call.arguments.targetCreatedAtMs === 'number' ? call.arguments.targetCreatedAtMs : null;
    const expectedExecutable = typeof call.arguments.targetExecutablePath === 'string' ? call.arguments.targetExecutablePath : null;

    const identity = await identityProvider(pid);
    if (!identity.alive) {
      return failure(`process ${pid} is not running; nothing was terminated`, 'system_process_not_running');
    }
    if (identity.creationTimeMs === null || !identity.executablePath) {
      return failure(
        `could not identify the process running as pid ${pid}; a process that cannot be identified is never terminated`,
        'system_process_identity_unavailable',
      );
    }
    if (expectedCreatedAt !== null && identity.creationTimeMs !== expectedCreatedAt) {
      return failure(
        `pid ${pid} is now a different process (${identity.executablePath}); the approved target no longer exists, so nothing was terminated`,
        'system_process_target_changed',
      );
    }
    if (expectedExecutable && identity.executablePath.toLowerCase() !== expectedExecutable.toLowerCase()) {
      return failure(
        `pid ${pid} is now running ${identity.executablePath}, not the approved ${expectedExecutable}; nothing was terminated`,
        'system_process_target_changed',
      );
    }
    const result = await run(`Stop-Process -Id ${pid} -Force`);
    if (!result.succeeded) return failure(result.output || `Could not stop process ${pid}`, 'system_process_kill_failed');
    return {
      status: 'succeeded', exitCode: 0,
      output: `Stopped process ${pid} (${identity.executablePath})`,
      resultCategory: 'system_process_killed',
      normalizedArguments: { pid },
    };
  }

  /**
   * Freezes the target's identity into the approval. Runs BEFORE the approval
   * digest is computed, so the approved action names one exact process.
   */
  async function prepareKillArguments(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (toolName !== 'system_kill_process') return args;
    const pid = positiveInt(args.pid);
    if (!pid) return args;
    const identity = await identityProvider(pid);
    if (!identity.alive || identity.creationTimeMs === null || !identity.executablePath) {
      // The policy layer refuses this before an approval is ever created.
      return { ...args, targetIdentityUnavailable: true };
    }
    return {
      ...args,
      targetCreatedAtMs: identity.creationTimeMs,
      targetExecutablePath: identity.executablePath,
    };
  }

  async function listServices(): Promise<ToolExecutionResult> {
    const result = await run('Get-Service | Select-Object Name, DisplayName, Status | ConvertTo-Json -Compress', { maxOutputChars: JSON_OUTPUT_CHARS });
    if (!result.succeeded) return failure(result.output || 'Get-Service failed', 'system_service_list_failed');
    let rows: ServiceRow[];
    try {
      rows = asRows<ServiceRow>(JSON.parse(result.output.trim() || '[]'));
    } catch {
      return failure(`Could not parse service list: ${result.output}`, 'system_service_list_unparseable');
    }
    const lines = rows.map((row) => `${row.Name ?? '?'} — ${row.DisplayName ?? row.Name ?? '?'} (${row.Status ?? 'unknown'})`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n') || '(no services)', resultCategory: 'system_services_listed' };
  }

  async function setServiceRunning(call: ModelToolCall, running: boolean): Promise<ToolExecutionResult> {
    const name = nonEmptyString(call.arguments.serviceName);
    if (!name) return failure('serviceName is required', 'invalid_arguments');
    const cmdlet = running ? 'Start-Service' : 'Stop-Service';
    const script = running ? `${cmdlet} -Name ${psQuote(name)}` : `${cmdlet} -Name ${psQuote(name)} -Force`;
    const result = await run(script);
    if (!result.succeeded) return failure(result.output || `${cmdlet} failed for ${name}`, running ? 'system_service_start_failed' : 'system_service_stop_failed');
    return {
      status: 'succeeded', exitCode: 0,
      output: `${running ? 'Started' : 'Stopped'} service ${name}`,
      resultCategory: running ? 'system_service_started' : 'system_service_stopped',
      normalizedArguments: { serviceName: name },
    };
  }

  async function listStartupItems(): Promise<ToolExecutionResult> {
    const script = '$startup = Get-CimInstance Win32_StartupCommand | Select-Object Name, Command, Location; '
      + "$tasks = Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\\Microsoft\\*' } | Select-Object TaskName, TaskPath, State; "
      + '@{ startupItems = @($startup); scheduledTasks = @($tasks) } | ConvertTo-Json -Compress -Depth 4';
    const result = await run(script, { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 30_000 });
    if (!result.succeeded) return failure(result.output || 'Startup item lookup failed', 'system_startup_list_failed');
    let parsed: { startupItems?: StartupItemRow[]; scheduledTasks?: ScheduledTaskRow[] };
    try {
      parsed = JSON.parse(result.output.trim() || '{}');
    } catch {
      return failure(`Could not parse startup item list: ${result.output}`, 'system_startup_list_unparseable');
    }
    const startupLines = (parsed.startupItems ?? []).map((row) => `[startup item, read-only] ${row.Name ?? '?'} — ${row.Command ?? '?'} (${row.Location ?? '?'})`);
    const taskLines = (parsed.scheduledTasks ?? []).map((row) => `[scheduled task] ${row.TaskPath ?? ''}${row.TaskName ?? '?'} (${row.State ?? 'unknown'})`);
    const lines = [...startupLines, ...taskLines];
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n') || '(no startup items or non-Microsoft scheduled tasks found)', resultCategory: 'system_startup_items_listed' };
  }

  async function setScheduledTaskEnabled(call: ModelToolCall): Promise<ToolExecutionResult> {
    const taskName = nonEmptyString(call.arguments.taskName);
    const taskPath = nonEmptyString(call.arguments.taskPath) ?? '\\';
    const enabled = call.arguments.enabled === true;
    if (!taskName) return failure('taskName is required', 'invalid_arguments');
    const cmdlet = enabled ? 'Enable-ScheduledTask' : 'Disable-ScheduledTask';
    const result = await run(`${cmdlet} -TaskName ${psQuote(taskName)} -TaskPath ${psQuote(taskPath)}`);
    if (!result.succeeded) return failure(result.output || `${cmdlet} failed for ${taskName}`, 'system_scheduled_task_toggle_failed');
    return {
      status: 'succeeded', exitCode: 0,
      output: `${enabled ? 'Enabled' : 'Disabled'} scheduled task ${taskPath}${taskName}`,
      resultCategory: 'system_scheduled_task_toggled',
      normalizedArguments: { taskName, taskPath, enabled },
    };
  }

  async function getHardwareTelemetry(): Promise<ToolExecutionResult> {
    const script = '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, LoadPercentage; '
      + '$ram = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory; '
      + "$disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ DeviceId = $_.DeviceId; TotalGB = [math]::Round($_.Size/1GB, 1); FreeGB = [math]::Round($_.FreeSpace/1GB, 1) } }; "
      + '$gpu = try { & nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null } catch { $null }; '
      + '@{ '
      + "  CPU = @{ Model = ($cpu.Name -replace '\\s+', ' ').Trim(); Cores = $cpu.NumberOfCores; LoadPercent = $cpu.LoadPercentage }; "
      + '  RAM = @{ TotalGB = [math]::Round($ram.TotalVisibleMemorySize / 1024 / 1024, 1); FreeGB = [math]::Round($ram.FreePhysicalMemory / 1024 / 1024, 1); UsedPercent = [math]::Round((1 - ($ram.FreePhysicalMemory / $ram.TotalVisibleMemorySize)) * 100, 1) }; '
      + '  Disks = @($disks); '
      + '  NvidiaGPU = if ($gpu) { $parts = ($gpu -split \',\').Trim(); @{ Name = $parts[0]; TotalVramMB = [int]$parts[1]; UsedVramMB = [int]$parts[2]; FreeVramMB = [int]$parts[3]; GpuLoadPercent = [int]$parts[4]; TemperatureC = if ($parts.Length -ge 6) { [int]$parts[5] } else { $null } } } else { $null } '
      + '} | ConvertTo-Json -Depth 4';
    const result = await run(script, { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 15_000 });
    if (!result.succeeded) return failure(result.output || 'Hardware telemetry probe failed', 'system_hardware_probe_failed');
    return {
      status: 'succeeded',
      exitCode: 0,
      output: result.output.trim(),
      resultCategory: 'system_hardware_telemetry_probed',
    };
  }

  interface DiagnosticCheck<T> {
    success: boolean;
    data?: T;
    error?: string;
  }

  interface SystemDiagnosticsResult {
    collectedAt: string;
    platform: string;
    checks: {
      os: DiagnosticCheck<{ platform: string; release: string; arch: string; version?: string }>;
      cpu: DiagnosticCheck<{ model: string; cores: number; logicalProcessors: number; loadPercent: number | null }>;
      ram: DiagnosticCheck<{ totalGB: number; freeGB: number; usedPercent: number }>;
      disks: DiagnosticCheck<Array<{ drive: string; totalGB: number; freeGB: number; usedPercent: number }>>;
      gpu: DiagnosticCheck<{ name: string; driverVersion: string | null; totalVramMB: number | null; usedVramMB: number | null; gpuLoadPercent: number | null; temperatureC: number | null }>;
      processes: DiagnosticCheck<Array<{ pid: number; name: string; cpu: number; workingSetMB: number }>>;
      ollama: DiagnosticCheck<{ reachable: boolean; apiBase: string; models: string[]; resident: string[]; detail: string }>;
      core: DiagnosticCheck<{ pid: number; uptimeSeconds: number; nodeVersion: string; cwd: string }>;
    };
  }

  async function runSystemDiagnostics(): Promise<ToolExecutionResult> {
    const checks: SystemDiagnosticsResult['checks'] = {
      os: { success: false },
      cpu: { success: false },
      ram: { success: false },
      disks: { success: false },
      gpu: { success: false },
      processes: { success: false },
      ollama: { success: false },
      core: { success: false },
    };

    try {
      checks.os = {
        success: true,
        data: {
          platform: process.platform,
          release: os.release(),
          arch: os.arch(),
          version: typeof (os as any).version === 'function' ? (os as any).version() : undefined,
        },
      };
    } catch (err) {
      checks.os = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await run(
        '$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name, NumberOfCores, NumberOfLogicalProcessors, LoadPercentage; '
          + "@{ Model = ($cpu.Name -replace '\\s+', ' ').Trim(); Cores = $cpu.NumberOfCores; LogicalProcessors = $cpu.NumberOfLogicalProcessors; LoadPercent = $cpu.LoadPercentage } | ConvertTo-Json -Compress",
        { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 10_000 },
      );
      if (result.succeeded) {
        const parsed = JSON.parse(result.output.trim());
        checks.cpu = {
          success: true,
          data: {
            model: parsed.Model,
            cores: parsed.Cores,
            logicalProcessors: parsed.LogicalProcessors,
            loadPercent: parsed.LoadPercent,
          },
        };
      } else {
        checks.cpu = { success: false, error: result.output };
      }
    } catch (err) {
      checks.cpu = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await run(
        '$ram = Get-CimInstance Win32_OperatingSystem | Select-Object TotalVisibleMemorySize, FreePhysicalMemory; '
          + '@{ TotalGB = [math]::Round($ram.TotalVisibleMemorySize / 1024 / 1024, 1); FreeGB = [math]::Round($ram.FreePhysicalMemory / 1024 / 1024, 1); UsedPercent = [math]::Round((1 - ($ram.FreePhysicalMemory / $ram.TotalVisibleMemorySize)) * 100, 1) } | ConvertTo-Json -Compress',
        { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 10_000 },
      );
      if (result.succeeded) {
        checks.ram = { success: true, data: JSON.parse(result.output.trim()) };
      } else {
        checks.ram = { success: false, error: result.output };
      }
    } catch (err) {
      checks.ram = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await run(
        "$disks = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { @{ Drive = $_.DeviceId; TotalGB = [math]::Round($_.Size/1GB, 1); FreeGB = [math]::Round($_.FreeSpace/1GB, 1); UsedPercent = [math]::Round((1 - ($_.FreeSpace / $_.Size)) * 100, 1) } }; @($disks) | ConvertTo-Json -Compress",
        { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 10_000 },
      );
      if (result.succeeded) {
        const rows = asRows<{ Drive: string; TotalGB: number; FreeGB: number; UsedPercent: number }>(JSON.parse(result.output.trim() || '[]'));
        checks.disks = { success: true, data: rows.map((row) => ({ drive: row.Drive, totalGB: row.TotalGB, freeGB: row.FreeGB, usedPercent: row.UsedPercent })) };
      } else {
        checks.disks = { success: false, error: result.output };
      }
    } catch (err) {
      checks.disks = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await run(
        '& nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu --format=csv,noheader,nounits 2>$null',
        { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 10_000 },
      );
      if (result.succeeded && result.output.trim()) {
        const parts = result.output.trim().split(',').map((s) => s.trim());
        checks.gpu = {
          success: true,
          data: {
            name: parts[0] || 'NVIDIA GPU',
            driverVersion: parts[1] || null,
            totalVramMB: Number(parts[2]) || null,
            usedVramMB: Number(parts[3]) || null,
            gpuLoadPercent: Number(parts[4]) || null,
            temperatureC: parts.length >= 6 ? Number(parts[5]) : null,
          },
        };
      } else {
        checks.gpu = { success: false, error: result.output || 'nvidia-smi returned no data (non-NVIDIA GPU or driver not installed)' };
      }
    } catch (err) {
      checks.gpu = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const result = await run(
        'Get-Process | Sort-Object CPU -Descending | Select-Object -First 30 Id, ProcessName, CPU, '
          + "@{N='WorkingSetMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json -Compress",
        { maxOutputChars: JSON_OUTPUT_CHARS, timeoutMs: 15_000 },
      );
      if (result.succeeded) {
        const rows = asRows<{ Id: number; ProcessName: string; CPU: number; WorkingSetMB: number }>(JSON.parse(result.output.trim() || '[]'));
        checks.processes = {
          success: true,
          data: rows.map((row) => ({ pid: row.Id, name: row.ProcessName, cpu: row.CPU, workingSetMB: row.WorkingSetMB })),
        };
      } else {
        checks.processes = { success: false, error: result.output };
      }
    } catch (err) {
      checks.processes = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    try {
      const apiBase = (options.ollamaUrl || process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
      const fetcher = options.fetchImpl ?? fetch;
      const res = await fetcher(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        const data = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
        const models = (data.models ?? []).map((m) => m.name);
        let resident: string[] = [];
        try {
          const psRes = await fetcher(`${apiBase}/api/ps`, { signal: AbortSignal.timeout(3_000) });
          if (psRes.ok) {
            const psData = (await psRes.json()) as { models?: Array<{ name?: string; model?: string }> };
            resident = (psData.models ?? []).map((m) => m.name || m.model || '').filter(Boolean);
          }
        } catch {}
        checks.ollama = {
          success: true,
          data: {
            reachable: true,
            apiBase,
            models,
            resident,
            detail: `${models.length} model(s) available${resident.length ? `, ${resident.length} running` : ''}`,
          },
        };
      } else {
        checks.ollama = {
          success: false,
          data: { reachable: false, apiBase, models: [], resident: [], detail: `HTTP ${res.status}` },
        };
      }
    } catch (err) {
      const apiBase = (options.ollamaUrl || process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
      checks.ollama = {
        success: false,
        data: { reachable: false, apiBase, models: [], resident: [], detail: err instanceof Error ? err.message : String(err) },
      };
    }

    try {
      checks.core = {
        success: true,
        data: {
          pid: process.pid,
          uptimeSeconds: Math.round(process.uptime()),
          nodeVersion: process.version,
          cwd: process.cwd(),
        },
      };
    } catch (err) {
      checks.core = { success: false, error: err instanceof Error ? err.message : String(err) };
    }

    const result: SystemDiagnosticsResult = {
      collectedAt: new Date().toISOString(),
      platform: process.platform,
      checks,
    };

    return {
      status: 'succeeded',
      exitCode: 0,
      output: JSON.stringify(result, null, 2),
      resultCategory: 'system_diagnostics_run',
    };
  }

  async function listModels(): Promise<ToolExecutionResult> {
    const apiBase = (options.ollamaUrl || process.env.KARKEDIKHA_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
    const activeModelName = typeof options.activeModel === 'function' ? options.activeModel() : options.activeModel;
    const fetcher = options.fetchImpl ?? fetch;

    let availableModels: Array<{ name: string; size?: number; modified_at?: string; details?: { parameter_size?: string; quantization_level?: string } }> = [];
    let residentModels: Array<{ name?: string; model?: string; size?: number; size_vram?: number; expires_at?: string; context_length?: number }> = [];
    let reachable = false;
    let providerError: string | null = null;

    try {
      const res = await fetcher(`${apiBase}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (res.ok) {
        reachable = true;
        const data = (await res.json()) as { models?: Array<any> };
        availableModels = data.models ?? [];
      } else {
        providerError = `HTTP ${res.status}`;
      }
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }

    if (reachable) {
      try {
        const psRes = await fetcher(`${apiBase}/api/ps`, { signal: AbortSignal.timeout(3_000) });
        if (psRes.ok) {
          const psData = (await psRes.json()) as { models?: Array<any> };
          residentModels = psData.models ?? [];
        }
      } catch {
        // /api/ps is best effort
      }
    }

    if (!reachable) {
      const failSummary = `Configured local model provider at ${apiBase} is unreachable (${providerError ?? 'connection failed'}). Ensure Ollama is running locally.`;
      return {
        status: 'failed',
        exitCode: 1,
        output: failSummary,
        resultCategory: 'model_provider_unreachable',
      };
    }

    function formatBytes(bytes?: number): string {
      if (typeof bytes !== 'number' || bytes <= 0) return '';
      const gb = bytes / (1024 * 1024 * 1024);
      if (gb >= 1) return `${gb.toFixed(1)} GB`;
      const mb = bytes / (1024 * 1024);
      return `${mb.toFixed(0)} MB`;
    }

    const lines: string[] = [
      `Local Model Provider: Ollama (${apiBase}) - Connected`,
      activeModelName ? `Active Model in Pandesh: ${activeModelName}` : null,
      '',
      `Currently Loaded / Running in VRAM (${residentModels.length}):`,
    ].filter((line): line is string => line !== null);

    if (residentModels.length === 0) {
      lines.push('  (no model currently resident in VRAM)');
    } else {
      for (const m of residentModels) {
        const name = m.name || m.model || 'unknown';
        const vram = formatBytes(m.size_vram || m.size);
        const expires = m.expires_at ? `expires: ${m.expires_at}` : '';
        const ctx = m.context_length ? `ctx: ${m.context_length}` : '';
        const extra = [vram, ctx, expires].filter(Boolean).join(', ');
        lines.push(`  - ${name}${extra ? ` (${extra})` : ''}`);
      }
    }

    lines.push('');
    lines.push(`Available Installed Models (${availableModels.length}):`);
    if (availableModels.length === 0) {
      lines.push('  (no models found installed in Ollama)');
    } else {
      for (const m of availableModels) {
        const sizeStr = formatBytes(m.size);
        const paramSize = m.details?.parameter_size;
        const quant = m.details?.quantization_level;
        const details = [paramSize, quant, sizeStr].filter(Boolean).join(', ');
        lines.push(`  - ${m.name}${details ? ` (${details})` : ''}`);
      }
    }

    return {
      status: 'succeeded',
      exitCode: 0,
      output: lines.join('\n'),
      resultCategory: 'models_listed',
    };
  }

  return {
    id: 'system-management',
    definitions: () => [
      {
        name: 'system_list_processes',
        description: 'List the top 50 running processes by CPU time (PID, name, CPU, working set MB). Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'system_hardware_telemetry',
        description: 'Read real on-demand Windows hardware telemetry (CPU model/cores/load %, RAM installed/free/used %, GPU model/VRAM total/VRAM used/load %, and disk capacities/free space). Read-only, no approval needed. Call this to inspect GPU memory, CPU load, and disk space.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'run_system_diagnostics',
        description: 'Run a comprehensive, read-only system diagnostics sweep on this PC: OS version, CPU, RAM, disk utilization, GPU/driver, top running processes, Ollama model-server status, and Pandesh Core process status. Returns structured per-check success/failure states. Read-only, no approval needed. Call this when the user asks to "run diagnostics", "diagnose this PC", or "check my setup".',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'system_kill_process',
        description: 'Force-terminate a process by PID. Consequential, destructive, and approval-gated — call system_list_processes first to confirm the exact PID.',
        parameters: { type: 'object', properties: { pid: { type: 'number' } }, required: ['pid'] },
      },
      {
        name: 'system_list_services',
        description: 'List Windows services with their current status (Name, DisplayName, Status). Read-only. Call this before system_start_service/system_stop_service to confirm the exact service name.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'system_start_service',
        description: 'Start a stopped Windows service by exact service name. Consequential and approval-gated.',
        parameters: { type: 'object', properties: { serviceName: { type: 'string' } }, required: ['serviceName'] },
      },
      {
        name: 'system_stop_service',
        description: 'Stop a running Windows service by exact service name. Consequential and approval-gated.',
        parameters: { type: 'object', properties: { serviceName: { type: 'string' } }, required: ['serviceName'] },
      },
      {
        name: 'system_list_startup_items',
        description: 'List classic startup items (registry Run keys / Startup folder — read-only, no toggle exists) and non-Microsoft scheduled tasks with their enabled/disabled state. Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'system_list_models',
        description: 'Query the configured local model provider (Ollama) to inspect active/running models, loaded memory context, and all available/installed models. Read-only, no approval needed. Call this when asked which model is running, what model is active, what models are installed or available, or to query the local model provider.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'system_set_scheduled_task_enabled',
        description: 'Enable or disable a scheduled task by exact name and path (from system_list_startup_items). Consequential and approval-gated. Classic registry/Startup-folder items cannot be toggled this way — only scheduled tasks.',
        parameters: {
          type: 'object',
          properties: { taskName: { type: 'string' }, taskPath: { type: 'string', description: 'e.g. "\\" for the root folder.' }, enabled: { type: 'boolean' } },
          required: ['taskName', 'enabled'],
        },
      },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    prepare: prepareKillArguments,
    health: () => ({ state: process.platform === 'win32' || Boolean(options.runScript) ? 'available' : 'unavailable', reason: (process.platform === 'win32' || Boolean(options.runScript)) ? undefined : 'system management is Windows-only', checkedAt: new Date().toISOString() }),
    run: (call) => {
      switch (call.name) {
        case 'system_list_processes': return listProcesses();
        case 'system_hardware_telemetry': return getHardwareTelemetry();
        case 'run_system_diagnostics': return runSystemDiagnostics();
        case 'system_list_models':
        case 'get_local_models': return listModels();
        case 'system_kill_process': return killProcess(call);
        case 'system_list_services': return listServices();
        case 'system_start_service': return setServiceRunning(call, true);
        case 'system_stop_service': return setServiceRunning(call, false);
        case 'system_list_startup_items': return listStartupItems();
        case 'system_set_scheduled_task_enabled': return setScheduledTaskEnabled(call);
        default: return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
      }
    },
  };
}
