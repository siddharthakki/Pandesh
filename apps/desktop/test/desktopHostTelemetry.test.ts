import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import {
  collectDesktopHostTelemetry,
  connectorPlaceholders,
  probeOllamaEndpoint,
  readRepositoryGitStatus,
  resetCpuSamplerForTests,
} from '../src/host/desktopHostTelemetry';
import {
  formatCpuLine,
  formatDiskLine,
  formatGpuLine,
  formatMemoryLine,
  formatOllamaEndpoint,
  formatOllamaStatus,
  formatRepoBranch,
  formatRepoChanged,
  formatRepoDirty,
  formatVramLine,
} from '../src/host/desktopHostTelemetryFormat';

const repoRoot = path.resolve(__dirname, '../../..');

afterEach(() => {
  resetCpuSamplerForTests();
  vi.unstubAllGlobals();
});

describe('desktopHostTelemetry mapping', () => {
  it('maps CPU/memory/disk samples without fabricating GPU values', async () => {
    resetCpuSamplerForTests();
    await collectDesktopHostTelemetry({ folder: repoRoot, apiBase: 'http://127.0.0.1:9' });
    const sample = await collectDesktopHostTelemetry({ folder: repoRoot, apiBase: 'http://127.0.0.1:9' });
    expect(sample.clock.timeZone.length).toBeGreaterThan(0);
    expect(sample.clock.localTime).toMatch(/\d/);
    expect(sample.memory.available).toBe(true);
    expect(sample.memory.totalBytes).toBeGreaterThan(0);
    expect(sample.memory.usedPercent).toBeGreaterThanOrEqual(0);
    expect(sample.cpu.cores).toBeGreaterThan(0);
    expect(formatCpuLine(sample.cpu) === 'Unavailable' || /\d+%/.test(formatCpuLine(sample.cpu))).toBe(true);
    expect(formatMemoryLine(sample.memory)).toMatch(/%/);
    if (sample.disk.available) {
      expect(formatDiskLine(sample.disk)).toMatch(/used/);
    } else {
      expect(formatDiskLine(sample.disk)).toBe('Unavailable');
    }
    if (!sample.gpu.available && sample.gpu.usagePercent == null) {
      expect(formatGpuLine(sample.gpu)).toBe('Unavailable');
      expect(sample.gpu.blocker.length).toBeGreaterThan(0);
    }
  });

  it('reports Unavailable GPU formatting when Windows exposes neither usage nor temperature', () => {
    expect(formatGpuLine({
      available: false,
      name: 'Some Adapter',
      usagePercent: null,
      temperatureC: null,
      vramUsedBytes: null,
      vramTotalBytes: null,
      blocker: 'counters unavailable',
    })).toBe('Unavailable');
  });

  it('formats VRAM allocation separately from GPU utilization', () => {
    expect(formatVramLine({
      available: true,
      name: 'RTX',
      usagePercent: 40,
      temperatureC: 60,
      vramUsedBytes: 8 * 1024 ** 3,
      vramTotalBytes: 24 * 1024 ** 3,
      blocker: '',
    })).toMatch(/8(\.0)? GB \/ 24(\.0)? GB/);
    expect(formatGpuLine({
      available: true,
      name: 'RTX',
      usagePercent: 40,
      temperatureC: 60,
      vramUsedBytes: 8 * 1024 ** 3,
      vramTotalBytes: 24 * 1024 ** 3,
      blocker: '',
    })).toMatch(/util 40%/);
  });

  it('marks Ollama disconnected when the endpoint is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }));
    const status = await probeOllamaEndpoint('http://127.0.0.1:1');
    expect(status.reachable).toBe(false);
    expect(formatOllamaStatus(status)).toBe('Disconnected');
    expect(formatOllamaEndpoint(status)).toMatch(/^Unavailable · /);
  });

  it('reads real repository branch and dirty/changed counts', async () => {
    const status = await readRepositoryGitStatus(repoRoot);
    expect(status.available).toBe(true);
    expect(status.branch).toBeTruthy();
    expect(typeof status.dirty).toBe('boolean');
    expect(typeof status.changedFileCount).toBe('number');
    expect(formatRepoBranch(status)).toBe(status.branch);
    expect(formatRepoDirty(status)).toMatch(/Clean|Dirty/);
    expect(formatRepoChanged(status)).toMatch(/^\d+$/);
  });

  it('returns Not connected placeholders for weather/news/email/calendar', () => {
    const connectors = connectorPlaceholders();
    expect(connectors.map((item) => item.id)).toEqual(['weather', 'news', 'email', 'calendar']);
    for (const item of connectors) {
      expect(item.status).toBe('not_connected');
    }
  });

  it('reports unavailable repository status when no folder is selected', async () => {
    const status = await readRepositoryGitStatus(null);
    expect(status.available).toBe(false);
    expect(formatRepoBranch(status)).toBe('Unavailable');
    expect(formatRepoDirty(status)).toBe('Unavailable');
    expect(formatRepoChanged(status)).toBe('Unavailable');
  });
});
