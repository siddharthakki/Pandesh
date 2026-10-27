/**
 * Local GPU capacity, read from the machine rather than assumed. Used to bound how many GPU-heavy model workloads
 * (a local coding agent, an image model) may run at once.
 */
import { spawnSync } from 'node:child_process';

export interface GpuInfo { name: string; totalVramMb: number; freeVramMb: number }

/** A resident chat/coding model plus its KV cache is budgeted at ~20 GB of VRAM: a 24 GB card carries one such workload. */
export const VRAM_PER_GPU_WORKLOAD_MB = 20 * 1024;

let cached: { at: number; gpu: GpuInfo | null } | null = null;

export function parseNvidiaSmi(csv: string): GpuInfo | null {
  const line = csv.split(/\r?\n/).map(l => l.trim()).find(Boolean);
  if (!line) return null;
  const [name, total, free] = line.split(',').map(s => s.trim());
  const totalVramMb = Number(total);
  const freeVramMb = Number(free);
  if (!name || !Number.isFinite(totalVramMb) || totalVramMb <= 0) return null;
  return { name, totalVramMb, freeVramMb: Number.isFinite(freeVramMb) ? freeVramMb : 0 };
}

/** The first NVIDIA GPU, or null when there is none (or `nvidia-smi` is unavailable). Cached for 30 s. */
export function detectGpu(now = Date.now()): GpuInfo | null {
  if (cached && now - cached.at < 30_000) return cached.gpu;
  let gpu: GpuInfo | null = null;
  try {
    const r = spawnSync('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
    if (r.status === 0) gpu = parseNvidiaSmi(String(r.stdout ?? ''));
  } catch { /* no driver */ }
  cached = { at: now, gpu };
  return gpu;
}

/** How many local-GPU workloads may run together. `KARKEDIKHA_GPU_LANES` overrides; otherwise it follows total VRAM, never below one. */
export function gpuLaneLimit(gpu: GpuInfo | null = detectGpu(), env: NodeJS.ProcessEnv = process.env): number {
  const forced = Number(env.KARKEDIKHA_GPU_LANES);
  if (Number.isInteger(forced) && forced >= 1) return forced;
  return gpu ? Math.max(1, Math.floor(gpu.totalVramMb / VRAM_PER_GPU_WORKLOAD_MB)) : 1;
}
