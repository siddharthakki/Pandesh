import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createDefaultAutonomousTask,
  resolveLocalTaskGitHubDelivery,
} from '../../autonomous/M15AutonomousWork';

const run = promisify(execFile);

describe('composer local-request GitHub delivery', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-local-delivery-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('keeps createDefaultAutonomousTask on fake transport', () => {
    expect(createDefaultAutonomousTask(root, 'goal').githubDelivery.transport).toBe('fake');
  });

  it('stays fake when origin is not configured', async () => {
    await run('git', ['init'], { cwd: root, windowsHide: true });
    expect(await resolveLocalTaskGitHubDelivery(root)).toEqual({ transport: 'fake' });
  });

  it('uses the existing gh-cli task-branch route when origin exists', async () => {
    await run('git', ['init', '-b', 'dev/current'], { cwd: root, windowsHide: true });
    await fs.writeFile(path.join(root, 'README.md'), 'seed\n');
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'add', 'README.md'], { cwd: root, windowsHide: true });
    await run('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '-m', 'seed'], { cwd: root, windowsHide: true });
    await run('git', ['remote', 'add', 'origin', 'https://example.invalid/repo.git'], { cwd: root, windowsHide: true });
    expect(await resolveLocalTaskGitHubDelivery(root)).toEqual({
      transport: 'gh-cli',
      remote: 'origin',
      baseBranch: 'dev/current',
    });
  });
});
