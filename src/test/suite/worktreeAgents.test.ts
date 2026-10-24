import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorktreeLease, WorktreeManager } from '../../orchestration/WorktreeManager';
import { ParallelWriteCoordinator } from '../../orchestration/ParallelWriteCoordinator';

const execFileAsync = promisify(execFile);

class DelayedSecondLeaseManager extends WorktreeManager {
  createdLeases = 0;

  override async createLease(taskId: string, allowedPaths: readonly string[]): Promise<WorktreeLease> {
    if (taskId === 'barrier_b') {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const lease = await super.createLease(taskId, allowedPaths);
    this.createdLeases += 1;
    return lease;
  }
}

describe('Phase 15 worktree-isolated write agents', () => {
  let root: string;
  let worktreeRoot: string;
  let manager: WorktreeManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-worktree-repo-'));
    worktreeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-worktrees-'));
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'tests@example.com']);
    await git(root, ['config', 'user.name', 'Ollama Agent Tests']);
    await fs.mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await fs.mkdir(path.join(root, 'src', 'b'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a', 'value.txt'), 'A0\n', 'utf8');
    await fs.writeFile(path.join(root, 'src', 'b', 'value.txt'), 'B0\n', 'utf8');
    await fs.writeFile(path.join(root, 'notes.txt'), 'clean\n', 'utf8');
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    await fs.writeFile(path.join(root, 'notes.txt'), 'dirty user work\n', 'utf8');

    manager = new WorktreeManager(root, {
      worktreeRoot,
      maxWorktrees: 4,
      maxDiskBytes: 100 * 1024 * 1024,
    });
  });

  afterEach(async () => {
    for (const lease of await manager.listLeases().catch(() => [])) {
      await manager.cleanup(lease.taskId).catch(() => undefined);
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(worktreeRoot, { recursive: true, force: true });
  });

  it('runs two disjoint write agents without touching dirty main-workspace files', async () => {
    const coordinator = new ParallelWriteCoordinator(root, manager, { concurrency: 2 });
    const batch = await coordinator.run([
      {
        id: 'agent_a',
        role: 'implementer',
        objective: 'Change A',
        allowedPaths: ['src/a'],
        validationCommands: ['verify-a'],
      },
      {
        id: 'agent_b',
        role: 'implementer',
        objective: 'Change B',
        allowedPaths: ['src/b'],
        validationCommands: ['verify-b'],
      },
    ], {
      execute: async (task, context) => {
        const target = task.id === 'agent_a'
          ? path.join(context.lease.worktreePath, 'src', 'a', 'value.txt')
          : path.join(context.lease.worktreePath, 'src', 'b', 'value.txt');
        await fs.writeFile(target, `${task.id}\n`, 'utf8');
        return { summary: `${task.id} changed one file` };
      },
    }, {
      validate: async task => ({ passed: true, commandsRun: task.validationCommands }),
    });

    expect(batch.results.map(result => result.status), JSON.stringify(batch.results, null, 2)).toEqual(['completed', 'completed']);
    expect(batch.results[0].changedFiles).toEqual(['src/a/value.txt']);
    expect(batch.results[1].changedFiles).toEqual(['src/b/value.txt']);
    expect(await fs.readFile(path.join(root, 'src', 'a', 'value.txt'), 'utf8')).toBe('A0\n');
    expect(await fs.readFile(path.join(root, 'src', 'b', 'value.txt'), 'utf8')).toBe('B0\n');
    expect(await fs.readFile(path.join(root, 'notes.txt'), 'utf8')).toBe('dirty user work\n');
    expect(batch.results.every(result => result.lease?.dirtyWorkspacePaths.includes('notes.txt'))).toBe(true);
    for (const result of batch.results) {
      await expect(fs.stat(result.checkpointPath!)).resolves.toBeDefined();
      await coordinator.discard(result.taskId);
    }
    expect(await manager.listLeases()).toEqual([]);
  });

  it('Unified Conversation V1: seeds trusted-dirty files into the freshly created worktree, and leaves the open workspace untouched', async () => {
    const lease = await manager.createLease('trusted_seed_task', ['**/*'], undefined, [
      { path: 'src/a/value.txt', content: 'trusted seeded content\n' },
      { path: 'new/nested/file.txt', content: 'a brand-new nested seeded file\n' },
    ]);
    try {
      const seeded = await fs.readFile(path.join(lease.worktreePath, 'src', 'a', 'value.txt'), 'utf8');
      expect(seeded).toBe('trusted seeded content\n');
      const nested = await fs.readFile(path.join(lease.worktreePath, 'new', 'nested', 'file.txt'), 'utf8');
      expect(nested).toBe('a brand-new nested seeded file\n');
      // Seeding is a plain filesystem write into the isolated worktree only —
      // the open workspace (root) is never touched by createLease.
      expect(await fs.readFile(path.join(root, 'src', 'a', 'value.txt'), 'utf8')).toBe('A0\n');
      expect(await fs.stat(path.join(root, 'new', 'nested', 'file.txt')).then(() => true, () => false)).toBe(false);
    } finally {
      await manager.cleanup(lease.taskId).catch(() => undefined);
    }
  });

  it('provisions every worktree before releasing parallel executors', async () => {
    const delayed = new DelayedSecondLeaseManager(root, {
      worktreeRoot,
      maxWorktrees: 4,
      maxDiskBytes: 100 * 1024 * 1024,
    });
    manager = delayed;
    const coordinator = new ParallelWriteCoordinator(root, delayed, { concurrency: 2 });
    const observations: number[] = [];

    const batch = await coordinator.run([
      { id: 'barrier_a', role: 'implementer', objective: 'A', allowedPaths: ['src/a'], validationCommands: [] },
      { id: 'barrier_b', role: 'implementer', objective: 'B', allowedPaths: ['src/b'], validationCommands: [] },
    ], {
      execute: async task => {
        observations.push(delayed.createdLeases);
        return { summary: `${task.id} observed the provisioning barrier` };
      },
    }, {
      validate: async () => ({ passed: true, commandsRun: [] }),
    });

    expect(batch.results.map(result => result.status), JSON.stringify(batch.results, null, 2)).toEqual(['completed', 'completed']);
    expect(observations).toEqual([2, 2]);
    await coordinator.discard('barrier_a');
    await coordinator.discard('barrier_b');
  });

  it('rejects overlapping scopes before creating worktrees', async () => {
    const coordinator = new ParallelWriteCoordinator(root, manager);
    await expect(coordinator.run([
      { id: 'one', role: 'implementer', objective: 'one', allowedPaths: ['src'], validationCommands: [] },
      { id: 'two', role: 'implementer', objective: 'two', allowedPaths: ['src/a'], validationCommands: [] },
    ], {
      execute: async () => ({ summary: 'unused' }),
    }, {
      validate: async () => ({ passed: true, commandsRun: [] }),
    })).rejects.toThrow(/overlap/i);
    expect(await manager.listLeases()).toEqual([]);
  });

  it('does not count a retained terminal-status lease against the configured limit', async () => {
    const limited = new WorktreeManager(root, {
      worktreeRoot,
      maxWorktrees: 1,
      maxDiskBytes: 100 * 1024 * 1024,
    });
    await limited.createLease('first', ['src/a']);
    await limited.markStatus('first', 'completed');
    // 'first' is retained (not yet disposed) but no longer active, so slot accounting
    // must reflect real reusable capacity rather than blindly counting it forever.
    const second = await limited.createLease('second', ['src/b']);
    expect(second.status).toBe('active');
    await limited.cleanup('first');
    await limited.cleanup('second');
  });

  it('does not treat a retained completed/failed/cancelled lease as an active write-scope lock (IA-002)', async () => {
    const first = await manager.createLease('ia002_first', ['**/*']);
    expect(first.status).toBe('active');
    await manager.markStatus('ia002_first', 'failed');

    const second = await manager.createLease('ia002_second', ['**/*']);
    expect(second.status).toBe('active');

    await manager.markStatus('ia002_second', 'cancelled');
    const third = await manager.createLease('ia002_third', ['**/*']);
    expect(third.status).toBe('active');

    await manager.markStatus('ia002_third', 'completed');
    const fourth = await manager.createLease('ia002_fourth', ['**/*']);
    expect(fourth.status).toBe('active');

    await manager.cleanup('ia002_first');
    await manager.cleanup('ia002_second');
    await manager.cleanup('ia002_third');
    await manager.cleanup('ia002_fourth');
  });

  it('still rejects overlapping scopes against a genuinely active lease', async () => {
    await manager.createLease('ia002_active', ['**/*']);
    await expect(manager.createLease('ia002_blocked', ['src/a'])).rejects.toThrow(/overlap/i);
    await manager.cleanup('ia002_active');
  });

  it('removes a partially created worktree when the disk limit is exceeded', async () => {
    const limited = new WorktreeManager(root, {
      worktreeRoot,
      maxWorktrees: 2,
      maxDiskBytes: 1,
    });
    await expect(limited.createLease('oversized', ['src/a'])).rejects.toThrow(/storage limit/i);
    expect(await limited.listLeases()).toEqual([]);
    expect(await fs.readdir(worktreeRoot)).toEqual([]);
  });

  it('discards failed worktrees and rejects out-of-scope changes', async () => {
    const coordinator = new ParallelWriteCoordinator(root, manager, { cleanupFailed: true });
    const batch = await coordinator.run([
      { id: 'bad_agent', role: 'implementer', objective: 'bad', allowedPaths: ['src/a'], validationCommands: [] },
    ], {
      execute: async (_task, context) => {
        await fs.writeFile(path.join(context.lease.worktreePath, 'src', 'b', 'value.txt'), 'out of scope\n', 'utf8');
        return { summary: 'changed wrong file' };
      },
    }, {
      validate: async () => ({ passed: true, commandsRun: [] }),
    });

    expect(batch.results[0].status).toBe('failed');
    expect(batch.results[0].error).toMatch(/out-of-scope/i);
    expect(await manager.listLeases()).toEqual([]);
    expect(await fs.readFile(path.join(root, 'src', 'b', 'value.txt'), 'utf8')).toBe('B0\n');
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}
