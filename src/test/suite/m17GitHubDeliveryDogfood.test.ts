import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DeliveryCommandRunner } from '../../autonomous/M15AutonomousWork';
import { M17DogfoodFailure, runM17GitHubDeliveryDogfood } from '../../acceptance/M17GitHubDeliveryDogfood';

const execFileAsync = promisify(execFile);

class FakeNetworkRunner implements DeliveryCommandRunner {
  readonly calls: string[][] = [];
  remoteSha = '';
  prCreated = false;
  prClosed = false;

  async run(command: string, cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    const a = [...args];
    this.calls.push([command, ...a]);
    if (command === 'gh') {
      if (a[0] === 'auth') return { stdout: 'authenticated', stderr: '' };
      if (a[0] === 'pr' && a[1] === 'create') {
        this.prCreated = true;
        return { stdout: 'https://github.com/siddharthakki/ollama-agent/pull/123\n', stderr: '' };
      }
      if (a[0] === 'pr' && a[1] === 'close') {
        this.prClosed = true;
        return { stdout: '', stderr: '' };
      }
      if (a.includes('state,mergedAt')) return { stdout: JSON.stringify({ state: 'CLOSED', mergedAt: null }), stderr: '' };
      const head = a.includes('--head') ? a[a.indexOf('--head') + 1] : this.branchFromCalls();
      return { stdout: JSON.stringify({ number: 123, url: 'https://github.com/siddharthakki/ollama-agent/pull/123', isDraft: true, headRefName: head, baseRefName: 'dogfood/m17', state: 'OPEN' }), stderr: '' };
    }
    if (a.join(' ') === 'remote get-url origin') return { stdout: 'git@github.com:siddharthakki/ollama-agent.git\n', stderr: '' };
    if (a[0] === 'push' && a.includes('--set-upstream')) {
      this.remoteSha = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
      return { stdout: '', stderr: '' };
    }
    if (a[0] === 'push' && a.includes('--delete')) {
      this.remoteSha = '';
      return { stdout: '', stderr: '' };
    }
    if (a[0] === 'ls-remote') return { stdout: this.remoteSha ? `${this.remoteSha}\t${a.at(-1)}\n` : '', stderr: '' };
    const result = await execFileAsync('git', a, { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { stdout: result.stdout, stderr: result.stderr };
  }

  private branchFromCalls(): string {
    const push = this.calls.find(call => call[0] === 'git' && call.includes('--set-upstream'));
    return push?.at(-1)?.split(':')[0] ?? '';
  }
}

describe('M17 real GitHub delivery dogfood guardrails and cleanup', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m17-github-dogfood-'));
    await fs.writeFile(path.join(root, 'README.md'), 'fixture\n');
    for (const args of [['init'], ['config', 'user.name', 'Dogfood Test'], ['config', 'user.email', 'dogfood@example.invalid'], ['add', '.'], ['commit', '-m', 'base']]) {
      await execFileAsync('git', args, { cwd: root });
    }
    const head = (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
    await execFileAsync('git', ['update-ref', 'refs/remotes/origin/dogfood/m17', head], { cwd: root });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('refuses when the explicit opt-in is missing', async () => {
    await expect(runM17GitHubDeliveryDogfood({ repositoryRoot: root, env: {} })).rejects.toThrow('OA_GITHUB_DELIVERY_DOGFOOD');
  });

  it('refuses a repository outside the exact allowlist', async () => {
    await expect(runM17GitHubDeliveryDogfood({ repositoryRoot: root, repository: 'someone/else', env: { OA_GITHUB_DELIVERY_DOGFOOD: '1' } })).rejects.toThrow('outside allowlist');
  });

  it('cleans the remote branch, local branch, and worktree after failure between push and PR creation', async () => {
    const runner = new FakeNetworkRunner();
    const error = await runM17GitHubDeliveryDogfood({ repositoryRoot: root, env: { OA_GITHUB_DELIVERY_DOGFOOD: '1' }, commandRunner: runner, ghRunner: runner, failurePoint: 'after-push', randomId: () => 'pushfail', now: () => new Date('2026-07-12T12:00:00Z') }).catch(value => value);
    expect(error).toBeInstanceOf(M17DogfoodFailure);
    expect(error.evidence).toMatchObject({ remoteBranchRemoved: true, localWorktreeRemoved: true, localBranchRemoved: true });
    expect(runner.prCreated).toBe(false);
  });

  it('closes without merging and cleans all branch/worktree resources after failure following PR creation', async () => {
    const runner = new FakeNetworkRunner();
    const error = await runM17GitHubDeliveryDogfood({ repositoryRoot: root, env: { OA_GITHUB_DELIVERY_DOGFOOD: '1' }, commandRunner: runner, ghRunner: runner, failurePoint: 'after-pr', randomId: () => 'prfail', now: () => new Date('2026-07-12T12:00:00Z') }).catch(value => value);
    expect(error).toBeInstanceOf(M17DogfoodFailure);
    expect(error.evidence).toMatchObject({ prClosedWithoutMerge: true, remoteBranchRemoved: true, localWorktreeRemoved: true, localBranchRemoved: true });
    expect(runner.prClosed).toBe(true);
  });
});
