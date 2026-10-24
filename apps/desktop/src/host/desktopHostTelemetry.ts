/**
 * Real host telemetry for Jarvis Desktop control center.
 * Never fabricates values — unavailable hardware returns typed nulls / blockers.
 * Child probes are async so Electron's main thread stays responsive.
 */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DesktopMetricValue {
  /** Null when not measured on this host. */
  value: number | null;
  unit: string;
  detail: string;
  available: boolean;
}

export interface DesktopGpuTelemetry {
  available: boolean;
  name: string | null;
  /** GPU compute utilization percent — not VRAM. */
  usagePercent: number | null;
  temperatureC: number | null;
  /** Dedicated GPU memory used (bytes). Null when not measured. */
  vramUsedBytes: number | null;
  /** Dedicated GPU memory total (bytes). Null when not measured. */
  vramTotalBytes: number | null;
  blocker: string;
}

export interface DesktopDiskTelemetry {
  available: boolean;
  mount: string | null;
  freeBytes: number | null;
  totalBytes: number | null;
  usedPercent: number | null;
  blocker: string;
}

export interface DesktopRepoGitStatus {
  available: boolean;
  branch: string | null;
  dirty: boolean | null;
  changedFileCount: number | null;
  blocker: string;
}

export interface DesktopOllamaEndpointStatus {
  reachable: boolean;
  apiBase: string;
  detail: string;
}

export interface DesktopConnectorStatus {
  id: 'weather' | 'news' | 'email' | 'calendar';
  label: string;
  status: 'not_connected';
  detail: string;
}

export interface DesktopHostTelemetry {
  collectedAt: string;
  clock: {
    iso: string;
    localTime: string;
    timeZone: string;
  };
  cpu: DesktopMetricValue & { model: string | null; cores: number };
  memory: {
    available: boolean;
    usedBytes: number;
    totalBytes: number;
    usedPercent: number;
  };
  disk: DesktopDiskTelemetry;
  gpu: DesktopGpuTelemetry;
  ollama: DesktopOllamaEndpointStatus;
  repository: DesktopRepoGitStatus;
  connectors: DesktopConnectorStatus[];
}

let lastCpuSample: { idle: number; total: number } | null = null;

function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout, stderr });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      finish(null);
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code);
    });
  });
}

function sampleCpuPercent(): number | null {
  const cpus = os.cpus();
  if (cpus.length === 0) return null;
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  if (!lastCpuSample) {
    lastCpuSample = { idle, total };
    return null;
  }
  const idleDelta = idle - lastCpuSample.idle;
  const totalDelta = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  if (totalDelta <= 0) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - idleDelta / totalDelta))));
}

function readDiskForPath(targetPath: string | null): DesktopDiskTelemetry {
  if (!targetPath) {
    return {
      available: false,
      mount: null,
      freeBytes: null,
      totalBytes: null,
      usedPercent: null,
      blocker: 'No workspace selected; disk telemetry waits for a repository folder.',
    };
  }
  try {
    const mount = path.parse(path.resolve(targetPath)).root || targetPath;
    if (typeof fs.statfsSync !== 'function') {
      return {
        available: false,
        mount,
        freeBytes: null,
        totalBytes: null,
        usedPercent: null,
        blocker: 'fs.statfsSync is unavailable in this Node runtime.',
      };
    }
    const stats = fs.statfsSync(mount);
    const totalBytes = Number(stats.blocks) * Number(stats.bsize);
    const freeBytes = Number(stats.bavail) * Number(stats.bsize);
    if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
      return {
        available: false,
        mount,
        freeBytes: null,
        totalBytes: null,
        usedPercent: null,
        blocker: `Disk stats for ${mount} were non-finite.`,
      };
    }
    const usedPercent = Math.round(100 * (1 - freeBytes / totalBytes));
    return {
      available: true,
      mount,
      freeBytes,
      totalBytes,
      usedPercent,
      blocker: '',
    };
  } catch (err) {
    return {
      available: false,
      mount: null,
      freeBytes: null,
      totalBytes: null,
      usedPercent: null,
      blocker: `Disk probe failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function readGpuTelemetry(): Promise<DesktopGpuTelemetry> {
  if (process.platform !== 'win32') {
    return {
      available: false,
      name: null,
      usagePercent: null,
      temperatureC: null,
      vramUsedBytes: null,
      vramTotalBytes: null,
      blocker: 'GPU telemetry is only probed on Windows for this Desktop host.',
    };
  }

  const nvidia = await runCommand(
    'nvidia-smi',
    [
      '--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ],
    2_000,
  );
  if (nvidia.status === 0 && nvidia.stdout.trim()) {
    const [name, usage, temp, memUsed, memTotal] = nvidia.stdout.trim().split(/\s*,\s*/);
    const usagePercent = Number(usage);
    const temperatureC = Number(temp);
    const usedMiB = Number(memUsed);
    const totalMiB = Number(memTotal);
    return {
      available: true,
      name: name || 'NVIDIA GPU',
      usagePercent: Number.isFinite(usagePercent) ? usagePercent : null,
      temperatureC: Number.isFinite(temperatureC) ? temperatureC : null,
      vramUsedBytes: Number.isFinite(usedMiB) ? Math.round(usedMiB * 1024 * 1024) : null,
      vramTotalBytes: Number.isFinite(totalMiB) ? Math.round(totalMiB * 1024 * 1024) : null,
      blocker: '',
    };
  }

  // Do not fall back to WMI/PowerShell — it can hang the Desktop host on some Windows installs.
  return {
    available: false,
    name: null,
    usagePercent: null,
    temperatureC: null,
    vramUsedBytes: null,
    vramTotalBytes: null,
    blocker: 'Windows did not expose GPU utilization or temperature (nvidia-smi unavailable).',
  };
}

export async function readRepositoryGitStatus(folder: string | null): Promise<DesktopRepoGitStatus> {
  if (!folder) {
    return {
      available: false,
      branch: null,
      dirty: null,
      changedFileCount: null,
      blocker: 'No repository selected.',
    };
  }
  // Portable/installed Jarvis can run under a different Windows token than
  // the operator-owned checkout. Scope Git's ownership exception to this
  // exact selected folder; never mutate global Git configuration.
  const safeDirectory = path.resolve(folder).replace(/\\/g, '/');
  const gitArgs = ['-c', `safe.directory=${safeDirectory}`, '-C', folder];
  const branch = await runCommand('git', [...gitArgs, 'rev-parse', '--abbrev-ref', 'HEAD'], 5_000);
  if (branch.status !== 0) {
    return {
      available: false,
      branch: null,
      dirty: null,
      changedFileCount: null,
      blocker: `git rev-parse failed: ${String(branch.stderr || branch.stdout || '').trim() || `exit ${branch.status}`}`,
    };
  }
  const porcelain = await runCommand('git', [...gitArgs, 'status', '--porcelain'], 8_000);
  if (porcelain.status !== 0) {
    return {
      available: false,
      branch: branch.stdout.trim(),
      dirty: null,
      changedFileCount: null,
      blocker: `git status failed: ${String(porcelain.stderr || porcelain.stdout || '').trim() || `exit ${porcelain.status}`}`,
    };
  }
  const lines = porcelain.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    available: true,
    branch: branch.stdout.trim() || null,
    dirty: lines.length > 0,
    changedFileCount: lines.length,
    blocker: '',
  };
}

export async function probeOllamaEndpoint(apiBase: string): Promise<DesktopOllamaEndpointStatus> {
  const base = (apiBase || 'http://127.0.0.1:11434').replace(/\/$/, '');
  try {
    const res = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) {
      return {
        reachable: false,
        apiBase: base,
        detail: `Ollama endpoint returned HTTP ${res.status}.`,
      };
    }
    return {
      reachable: true,
      apiBase: base,
      detail: 'Ollama /api/tags reachable.',
    };
  } catch (err) {
    return {
      reachable: false,
      apiBase: base,
      detail: `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function connectorPlaceholders(): DesktopConnectorStatus[] {
  return [
    { id: 'weather', label: 'Weather', status: 'not_connected', detail: 'No weather connector configured.' },
    { id: 'news', label: 'News', status: 'not_connected', detail: 'No news connector configured.' },
    { id: 'email', label: 'Email', status: 'not_connected', detail: 'No email connector configured.' },
    { id: 'calendar', label: 'Calendar', status: 'not_connected', detail: 'No calendar connector configured.' },
  ];
}

export async function collectDesktopHostTelemetry(input: {
  folder: string | null;
  apiBase: string;
}): Promise<DesktopHostTelemetry> {
  const now = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const localTime = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone,
  }).format(now);
  const cpuPercent = sampleCpuPercent();
  const cpus = os.cpus();
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const [ollama, gpu, repository] = await Promise.all([
    probeOllamaEndpoint(input.apiBase),
    readGpuTelemetry(),
    readRepositoryGitStatus(input.folder),
  ]);

  return {
    collectedAt: now.toISOString(),
    clock: {
      iso: now.toISOString(),
      localTime,
      timeZone,
    },
    cpu: {
      value: cpuPercent,
      unit: '%',
      detail: cpuPercent === null ? 'Warming CPU sample…' : `${cpus.length} logical processors`,
      available: cpuPercent !== null,
      model: cpus[0]?.model?.trim() || null,
      cores: cpus.length,
    },
    memory: {
      available: true,
      usedBytes,
      totalBytes,
      usedPercent: totalBytes > 0 ? Math.round(100 * usedBytes / totalBytes) : 0,
    },
    disk: readDiskForPath(input.folder),
    gpu,
    ollama,
    repository,
    connectors: connectorPlaceholders(),
  };
}

/** Test helper: reset CPU sampler between cases. */
export function resetCpuSamplerForTests(): void {
  lastCpuSample = null;
}
