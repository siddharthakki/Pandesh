import * as os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const PROBE_TIMEOUT_MS = 5_000;

export interface GpuSample {
  index: number;
  name: string;
  temperatureC: number;
  utilizationPercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
}

export interface DiskSample {
  mount: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ResourceSnapshot {
  takenAt: string;
  cpu: { utilizationPercent?: number };
  ram: { totalBytes: number; freeBytes: number; usedPercent: number };
  /** `undefined` when no GPU could be probed (no `nvidia-smi`, not an error). */
  gpus?: GpuSample[];
  disks?: DiskSample[];
}

/**
 * CPU utilization needs two tick samples to compute a delta — a single
 * `os.cpus()` read is a cumulative counter, not a percentage. This holds the
 * previous sample between calls (stateful sampler, not a blocking delay), so
 * the first `sample()` after construction returns `undefined` and every call
 * after that returns a real delta-based percentage.
 */
export class CpuUsageSampler {
  private previous?: { idle: number; total: number };

  sample(): number | undefined {
    const cpus = os.cpus();
    if (cpus.length === 0) return undefined;
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    const previous = this.previous;
    this.previous = { idle, total };
    if (!previous) return undefined;
    const idleDelta = idle - previous.idle;
    const totalDelta = total - previous.total;
    if (totalDelta <= 0) return undefined;
    return Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
  }
}

export function sampleRam(): ResourceSnapshot['ram'] {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  return { totalBytes, freeBytes, usedPercent: totalBytes > 0 ? 100 * (1 - freeBytes / totalBytes) : 0 };
}

/**
 * `nvidia-smi` when present; `undefined` (never an error) when it is not —
 * a GPU-less or non-NVIDIA machine is a normal, expected case, not a
 * telemetry failure.
 */
export async function sampleGpus(): Promise<GpuSample[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=index,name,temperature.gpu,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
    );
    const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 0) return undefined;
    return lines.map(line => {
      const [index, name, temperatureC, utilizationPercent, memoryUsedMb, memoryTotalMb] = line.split(',').map(field => field.trim());
      return {
        index: Number(index),
        name,
        temperatureC: Number(temperatureC),
        utilizationPercent: Number(utilizationPercent),
        memoryUsedMb: Number(memoryUsedMb),
        memoryTotalMb: Number(memoryTotalMb),
      };
    });
  } catch {
    return undefined;
  }
}

function parseWindowsDiskCsv(stdout: string): DiskSample[] {
  const lines = stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const samples: DiskSample[] = [];
  for (const line of lines) {
    if (/^Caption/i.test(line)) continue;
    const [caption, freeSpace, size] = line.split(',').map(field => field.trim());
    if (!caption || !freeSpace || !size) continue;
    const freeBytes = Number(freeSpace);
    const totalBytes = Number(size);
    if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) continue;
    samples.push({ mount: caption, totalBytes, freeBytes });
  }
  return samples;
}

async function sampleDisksWindows(): Promise<DiskSample[] | undefined> {
  try {
    const { stdout } = await execFileAsync('wmic', ['logicaldisk', 'get', 'caption,freespace,size', '/format:csv'], {
      windowsHide: true,
      timeout: PROBE_TIMEOUT_MS,
    });
    const samples = parseWindowsDiskCsv(stdout);
    if (samples.length > 0) return samples;
  } catch {
    // wmic is deprecated/absent on some Windows builds; fall through to PowerShell CIM.
  }
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_LogicalDisk | Select-Object Caption,FreeSpace,Size | ConvertTo-Csv -NoTypeInformation'],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
    );
    return parseWindowsDiskCsv(stdout.replace(/"/g, ''));
  } catch {
    return undefined;
  }
}

async function sampleDisksPosix(): Promise<DiskSample[] | undefined> {
  try {
    const { stdout } = await execFileAsync('df', ['-kP'], { windowsHide: true, timeout: PROBE_TIMEOUT_MS });
    const lines = stdout.split(/\r?\n/).slice(1).map(line => line.trim()).filter(Boolean);
    return lines.map(line => {
      const parts = line.split(/\s+/);
      const totalBytes = Number(parts[1]) * 1024;
      const availableBytes = Number(parts[3]) * 1024;
      const mount = parts[5] ?? parts[parts.length - 1];
      return { mount, totalBytes, freeBytes: availableBytes };
    }).filter(sample => Number.isFinite(sample.totalBytes) && Number.isFinite(sample.freeBytes));
  } catch {
    return undefined;
  }
}

/** `undefined` (never an error) when disk headroom cannot be determined on this platform. */
export function sampleDisks(): Promise<DiskSample[] | undefined> {
  return process.platform === 'win32' ? sampleDisksWindows() : sampleDisksPosix();
}

/**
 * One full resource snapshot. `cpu` needs a `CpuUsageSampler` carried across
 * calls by the caller (see its own doc) to produce a real percentage; a
 * fresh sampler's first snapshot always reports `cpu.utilizationPercent`
 * `undefined`, which is honest, not a bug.
 */
export async function takeResourceSnapshot(cpuSampler: CpuUsageSampler): Promise<ResourceSnapshot> {
  const [gpus, disks] = await Promise.all([sampleGpus(), sampleDisks()]);
  return {
    takenAt: new Date().toISOString(),
    cpu: { utilizationPercent: cpuSampler.sample() },
    ram: sampleRam(),
    gpus,
    disks,
  };
}
