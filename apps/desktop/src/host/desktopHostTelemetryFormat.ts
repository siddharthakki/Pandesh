/**
 * Pure display mappers for host telemetry — no fabricated values.
 */
import type {
  DesktopConnectorStatus,
  DesktopGpuTelemetry,
  DesktopHostTelemetry,
  DesktopOllamaEndpointStatus,
  DesktopRepoGitStatus,
} from './desktopHostTelemetry';

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return 'Unavailable';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

export function formatCpuLine(cpu: DesktopHostTelemetry['cpu']): string {
  if (!cpu.available || cpu.value == null) return 'Unavailable';
  return `${cpu.value}%`;
}

export function formatMemoryLine(memory: DesktopHostTelemetry['memory']): string {
  if (!memory.available) return 'Unavailable';
  return `${memory.usedPercent}% · ${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}`;
}

export function formatDiskLine(disk: DesktopHostTelemetry['disk']): string {
  if (!disk.available || disk.usedPercent == null) return 'Unavailable';
  const mount = disk.mount ? ` (${disk.mount.replace(/\\$/, '')})` : '';
  return `${disk.usedPercent}% used · ${formatBytes(disk.freeBytes)} free${mount}`;
}

export function formatGpuLine(gpu: DesktopGpuTelemetry): string {
  if (!gpu.available && gpu.usagePercent == null && gpu.temperatureC == null) {
    return 'Unavailable';
  }
  const parts: string[] = [];
  if (gpu.usagePercent != null) parts.push(`util ${gpu.usagePercent}%`);
  if (gpu.temperatureC != null) parts.push(`${gpu.temperatureC}°C`);
  if (parts.length === 0) return 'Unavailable';
  const name = gpu.name ? ` · ${gpu.name}` : '';
  return `${parts.join(' · ')}${name}`;
}

export function formatVramLine(gpu: DesktopGpuTelemetry): string {
  if (gpu.vramUsedBytes == null || gpu.vramTotalBytes == null) return 'Unavailable';
  return `${formatBytes(gpu.vramUsedBytes)} / ${formatBytes(gpu.vramTotalBytes)}`;
}

export function formatOllamaStatus(ollama: DesktopOllamaEndpointStatus): string {
  return ollama.reachable ? 'Connected' : 'Disconnected';
}

export function formatOllamaEndpoint(ollama: DesktopOllamaEndpointStatus): string {
  return ollama.reachable ? ollama.apiBase : `Unavailable · ${ollama.apiBase}`;
}

export function formatRepoDirty(repo: DesktopRepoGitStatus): string {
  if (!repo.available || repo.dirty == null) return 'Unavailable';
  return repo.dirty ? 'Dirty' : 'Clean';
}

export function formatRepoChanged(repo: DesktopRepoGitStatus): string {
  if (!repo.available || repo.changedFileCount == null) return 'Unavailable';
  return String(repo.changedFileCount);
}

export function formatRepoBranch(repo: DesktopRepoGitStatus): string {
  if (!repo.available || !repo.branch) return 'Unavailable';
  return repo.branch;
}

export function connectorUiLabel(status: DesktopConnectorStatus['status']): string {
  return status === 'not_connected' ? 'Not connected' : 'Not connected';
}

export function hardwareDetailText(telemetry: DesktopHostTelemetry): string {
  const lines = [
    `Collected: ${telemetry.collectedAt}`,
    `CPU model: ${telemetry.cpu.model ?? 'Unavailable'}`,
    `CPU cores: ${telemetry.cpu.cores}`,
    `CPU detail: ${telemetry.cpu.detail || '—'}`,
    `Disk: ${telemetry.disk.available ? 'ok' : telemetry.disk.blocker || 'Unavailable'}`,
    `GPU: ${telemetry.gpu.available ? (telemetry.gpu.name ?? 'ok') : telemetry.gpu.blocker || 'Unavailable'}`,
    `Ollama: ${telemetry.ollama.detail}`,
    `Git: ${telemetry.repository.available ? 'ok' : telemetry.repository.blocker || 'Unavailable'}`,
  ];
  return lines.join('\n');
}
