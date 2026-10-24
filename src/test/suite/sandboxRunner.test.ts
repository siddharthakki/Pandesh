import { describe, expect, it } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { SandboxBackend, SandboxRunner } from '../../sandbox/SandboxRunner';

const backend: SandboxBackend = {
  execute: async () => ({ exitCode: 0, stdout: 'ok', stderr: '' }),
};

describe('Phase 19 sandbox runner', () => {
  it('creates an approved bounded host plan', () => {
    const root = path.join(os.tmpdir(), 'sandbox-workspace');
    const runner = new SandboxRunner(root, backend);
    const plan = runner.createPlan({
      executionId: 'host-read',
      mode: 'restricted-host',
      executable: 'npm',
      args: ['run', 'compile'],
      filesystem: 'read-only',
      network: false,
      approved: true,
      limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    });

    expect(plan.executable).toBe('npm');
    expect(plan.network).toBe(false);
    expect(plan.filesystem).toBe('read-only');
  });

  it('requires approval for restricted-host execution', () => {
    const runner = new SandboxRunner('/workspace', backend);
    expect(() => runner.createPlan({
      executionId: 'write',
      mode: 'restricted-host',
      executable: 'node',
      args: ['script.js'],
      filesystem: 'read-only',
      network: false,
      approved: false,
      limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    })).toThrow(/approval/i);
  });

  it('rejects workspace escapes and unapproved executables', () => {
    const runner = new SandboxRunner('/workspace', backend);
    expect(() => runner.createPlan({
      executionId: 'escape',
      mode: 'restricted-host',
      executable: 'node',
      args: [],
      cwd: '../outside',
      filesystem: 'read-only',
      network: false,
      approved: true,
      limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    })).toThrow(/escapes/i);

    expect(() => runner.createPlan({
      executionId: 'unknown',
      mode: 'restricted-host',
      executable: 'unknown-program',
      args: [],
      filesystem: 'read-only',
      network: false,
      approved: true,
      limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    })).toThrow(/allowlisted/i);
  });

  it('builds an unattended hardened container plan', () => {
    const runner = new SandboxRunner('/workspace', backend);
    const plan = runner.createPlan({
      executionId: 'container-read',
      mode: 'docker',
      executable: 'node',
      args: ['test.js'],
      dockerImage: 'node:lts',
      filesystem: 'read-only',
      network: false,
      approved: false,
      limits: {
        timeoutMs: 10_000,
        maxOutputBytes: 4096,
        memoryMb: 512,
        cpuCount: 1,
        processLimit: 32,
      },
    });

    expect(plan.executable).toBe('docker');
    expect(plan.args).toContain('none');
    expect(plan.args).toContain('ALL');
    expect(plan.args).toContain('--read-only');
    expect(plan.args).toContain('node:lts');
  });

  it('runs through an injected backend and records exit status', async () => {
    const runner = new SandboxRunner('/workspace', backend);
    const result = await runner.run({
      executionId: 'run',
      mode: 'restricted-host',
      executable: 'node',
      args: ['test.js'],
      filesystem: 'read-only',
      network: false,
      approved: true,
      limits: { timeoutMs: 10_000, maxOutputBytes: 4096 },
    });
    expect(result.status).toBe('completed');
    expect(result.stdout).toBe('ok');
  });
});
