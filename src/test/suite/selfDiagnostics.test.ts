import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { createWorkspaceDiagnostics } from '../../diagnostics/SelfDiagnostics';
import { ProviderReadinessProbe } from '../../diagnostics/ProviderReadiness';

describe('Phase 24 self diagnostics', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-diagnostics-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('reports missing runtime state and requires approval before repair', async () => {
    const diagnostics = createWorkspaceDiagnostics(root);
    const report = await diagnostics.run();
    expect(report.findings.find(finding => finding.id === 'state-root')?.status).toBe('degraded');

    const denied = await diagnostics.repair('create-state-directories', false);
    expect(denied.status).toBe('denied');
    await expect(fs.stat(path.join(root, '.ollama-agent'))).rejects.toThrow();

    const repaired = await diagnostics.repair('create-state-directories', true);
    expect(repaired.status).toBe('completed');
    await expect(fs.stat(path.join(root, '.ollama-agent', 'tasks'))).resolves.toBeDefined();
    expect(repaired.changedPaths.every(filename => path.resolve(filename).startsWith(path.resolve(root, '.ollama-agent')))).toBe(true);
  });

  it('detects stale temporary files and malformed task JSON without rewriting it', async () => {
    const taskDir = path.join(root, '.ollama-agent', 'tasks', 'task-one');
    await fs.mkdir(taskDir, { recursive: true });
    const malformed = path.join(taskDir, 'task.json');
    const stale = path.join(taskDir, 'state.json.tmp');
    await fs.writeFile(malformed, '{broken', 'utf8');
    await fs.writeFile(stale, 'temporary', 'utf8');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);

    const diagnostics = createWorkspaceDiagnostics(root);
    const report = await diagnostics.run();
    expect(report.healthy).toBe(false);
    expect(report.findings.find(finding => finding.id === 'task-json-integrity')?.status).toBe('unhealthy');
    expect(report.findings.find(finding => finding.id === 'stale-temporary-files')?.repairId).toBe('remove-stale-temporary-files');

    const repaired = await diagnostics.repair('remove-stale-temporary-files', true);
    expect(repaired.status).toBe('completed');
    await expect(fs.stat(stale)).rejects.toThrow();
    expect(await fs.readFile(malformed, 'utf8')).toBe('{broken');
  });

  it('preserves existing checks while adding provider readiness when configured', async () => {
    const probe = new ProviderReadinessProbe(async () => {
      throw new Error('not used');
    });
    vi.spyOn(probe, 'run').mockResolvedValue({
      providerType: 'ollama',
      apiBase: 'http://localhost:11434',
      chatModel: 'ready-model:latest',
      reachability: 'ready',
      modelAvailability: 'available',
      discoveredModelCount: 1,
    });

    const diagnostics = createWorkspaceDiagnostics(root, { providerReadinessProbe: probe });
    const report = await diagnostics.run();

    expect(report.findings.map(finding => finding.id)).toContain('tracked-runtime-state');
    const readiness = report.findings.find(finding => finding.id === 'provider-readiness');
    expect(readiness?.status).toBe('healthy');
    expect(readiness?.detail).toContain('Provider: ollama');
    expect(readiness?.detail).toContain('Status: passed');
  });

  it('detects tracked runtime state files and provides approved repair', async () => {
    const trackedFiles = [
      '.ollama-agent/autonomous-tasks/task-1/events.jsonl',
      '.ollama-agent/index/repository-intelligence.sqlite',
    ];
    let untrackCalled = false;
    const diagnostics = createWorkspaceDiagnostics(root, {
      findTrackedRuntimeFiles: async () => trackedFiles,
      untrackRuntimeFiles: async () => {
        untrackCalled = true;
        return ['.ollama-agent'];
      },
    });

    const report = await diagnostics.run();
    const finding = report.findings.find(f => f.id === 'tracked-runtime-state');
    expect(finding?.status).toBe('unhealthy');
    expect(finding?.severity).toBe('warning');
    expect(finding?.summary).toContain('2 KarkeDikha runtime state file(s) are tracked by Git');
    expect(finding?.detail).toContain('events.jsonl');
    expect(finding?.repairId).toBe('untrack-runtime-state');
    expect(finding?.repairRequiresApproval).toBe(true);

    const denied = await diagnostics.repair('untrack-runtime-state', false);
    expect(denied.status).toBe('denied');
    expect(untrackCalled).toBe(false);

    const repaired = await diagnostics.repair('untrack-runtime-state', true);
    expect(repaired.status).toBe('completed');
    expect(untrackCalled).toBe(true);
    expect(repaired.summary).toContain('untracked from Git index');
  });
});
