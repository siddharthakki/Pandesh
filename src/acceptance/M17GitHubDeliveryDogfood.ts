import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  AutonomousTask,
  DeliveryCommandRunner,
  DurableTaskQueue,
  GhCliGitHubDeliveryTransport,
  GitDeliveryService,
  IsolatedWorktreeManager,
  createDefaultAutonomousTask,
} from '../autonomous/M15AutonomousWork';

const execFileAsync = promisify(execFile);
export const M17_DOGFOOD_REPOSITORY = 'siddharthakki/ollama-agent';
export const M17_DOGFOOD_BASE_BRANCH = 'dogfood/m17';
export const M17_PACKAGED_DOGFOOD_OPT_IN = 'OA_M17_PACKAGED_GITHUB_DELIVERY_DOGFOOD';

export interface AuthoritativePullRequestMetadata {
  number: number; url: string; state: string; isDraft: boolean;
  baseRefName: string; headRefName: string; headRefOid: string; mergedAt: string | null;
}

export function createPackagedDogfoodIdentity(now = new Date(), random = Math.random().toString(36).slice(2, 10)): { runId: string; branch: string; taskId: string } {
  const suffix = random.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12);
  if (!suffix) throw new Error('Packaged dogfood identity requires a random suffix.');
  const runId = `${now.getTime()}-${suffix}`;
  return { runId, branch: `dogfood/m17-packaged-${runId}`.slice(0, 100), taskId: `m17_packaged_${runId}`.slice(0, 120) };
}

export function validatePackagedDogfoodInputs(repository: string, baseBranch: string, env: NodeJS.ProcessEnv): void {
  if (env[M17_PACKAGED_DOGFOOD_OPT_IN] !== '1') throw new Error(`Refusing packaged GitHub delivery: ${M17_PACKAGED_DOGFOOD_OPT_IN} must equal 1.`);
  if (repository !== M17_DOGFOOD_REPOSITORY) throw new Error(`Refusing repository outside allowlist: ${repository}`);
  if (baseBranch !== M17_DOGFOOD_BASE_BRANCH) throw new Error(`Refusing unexpected base branch: ${baseBranch}`);
}

export function assertAuthoritativePullRequest(
  metadata: AuthoritativePullRequestMetadata,
  expected: { number: number; url: string; baseBranch: string; headBranch: string; commitSha: string; closed?: boolean },
): void {
  if (metadata.number !== expected.number || metadata.url !== expected.url) throw new Error('Authoritative pull request identity mismatch.');
  if (metadata.baseRefName !== expected.baseBranch || metadata.headRefName !== expected.headBranch) throw new Error('Authoritative pull request base/head mismatch.');
  if (metadata.headRefOid !== expected.commitSha) throw new Error('Authoritative pull request head SHA mismatch.');
  if (metadata.isDraft !== true) throw new Error('Authoritative pull request is not draft.');
  if (expected.closed) {
    if (metadata.state !== 'CLOSED' || metadata.mergedAt !== null) throw new Error('Pull request was not closed without merge.');
  } else if (metadata.state !== 'OPEN' || metadata.mergedAt !== null) {
    throw new Error('Pull request is not open and unmerged.');
  }
}

export interface PackagedDogfoodCleanupTargets {
  runId: string;
  branch: string;
  worktree?: string;
}

export function assertRunOwnedCleanupTargets(
  actual: PackagedDogfoodCleanupTargets,
  expected: PackagedDogfoodCleanupTargets,
): void {
  if (actual.runId !== expected.runId || actual.branch !== expected.branch || actual.worktree !== expected.worktree) {
    throw new Error('Refusing cleanup outside the exact run-owned resources.');
  }
  if (!actual.branch.startsWith(`dogfood/m17-packaged-${actual.runId}`)) {
    throw new Error('Refusing cleanup of a branch not owned by this packaged dogfood run.');
  }
}

export async function runPackagedDogfoodCleanup(
  actions: ReadonlyArray<{ label: string; run: () => Promise<void> }>,
): Promise<string[]> {
  const errors: string[] = [];
  for (const action of actions) {
    try {
      await action.run();
    } catch (error) {
      errors.push(`${action.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return errors;
}

export interface M17DogfoodEvidence {
  runId: string;
  branch: string;
  commitSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  pullRequestWasDraft?: boolean;
  persistedStateVerified: boolean;
  prClosedWithoutMerge: boolean;
  remoteBranchRemoved: boolean;
  localWorktreeRemoved: boolean;
  localBranchRemoved: boolean;
}

export class M17DogfoodFailure extends Error {
  constructor(message: string, readonly evidence: M17DogfoodEvidence, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface M17DogfoodOptions {
  repositoryRoot: string;
  repository?: string;
  baseBranch?: string;
  env?: NodeJS.ProcessEnv;
  commandRunner?: DeliveryCommandRunner;
  ghRunner?: DeliveryCommandRunner;
  now?: () => Date;
  randomId?: () => string;
  failurePoint?: 'after-push' | 'after-pr';
}

class ExecRunner implements DeliveryCommandRunner {
  async run(command: string, cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    return execFileAsync(command, [...args], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 });
  }
}

async function git(runner: DeliveryCommandRunner, cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await runner.run('git', cwd, args);
  return stdout.trim();
}

function remoteMatchesAllowlist(url: string): boolean {
  const normalized = url.trim().replace(/\.git$/, '').replace(/^git@github\.com:/, 'https://github.com/');
  return normalized === `https://github.com/${M17_DOGFOOD_REPOSITORY}`;
}

export async function runM17GitHubDeliveryDogfood(options: M17DogfoodOptions): Promise<M17DogfoodEvidence> {
  const env = options.env ?? process.env;
  const repository = options.repository ?? M17_DOGFOOD_REPOSITORY;
  const baseBranch = options.baseBranch ?? M17_DOGFOOD_BASE_BRANCH;
  const commands = options.commandRunner ?? new ExecRunner();
  const gh = options.ghRunner ?? commands;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? (() => Math.random().toString(36).slice(2, 10));

  if (env.OA_GITHUB_DELIVERY_DOGFOOD !== '1') throw new Error('Refusing real GitHub delivery: OA_GITHUB_DELIVERY_DOGFOOD must equal 1.');
  if (repository !== M17_DOGFOOD_REPOSITORY) throw new Error(`Refusing repository outside allowlist: ${repository}`);
  if (baseBranch !== M17_DOGFOOD_BASE_BRANCH) throw new Error(`Refusing unexpected base branch: ${baseBranch}`);
  await gh.run('gh', options.repositoryRoot, ['auth', 'status']);
  if ((await git(commands, options.repositoryRoot, ['status', '--porcelain=v1'])).length > 0) throw new Error('Refusing real GitHub delivery from a dirty source worktree.');
  if (!remoteMatchesAllowlist(await git(commands, options.repositoryRoot, ['remote', 'get-url', 'origin']))) {
    throw new Error('Refusing real GitHub delivery: origin does not match the repository allowlist.');
  }
  await git(commands, options.repositoryRoot, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${baseBranch}`]);
  if (await git(commands, options.repositoryRoot, ['rev-parse', 'HEAD']) !== await git(commands, options.repositoryRoot, ['rev-parse', `origin/${baseBranch}`])) {
    throw new Error(`Refusing real GitHub delivery: source HEAD must equal origin/${baseBranch}.`);
  }

  const started = now();
  const runId = `${started.getTime()}-${randomId().replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  const branch = `dogfood/m17-delivery-e2e-${runId}`;
  const fixtureName = `m17-github-delivery-dogfood-${runId}.txt`;
  const evidence: M17DogfoodEvidence = {
    runId, branch, persistedStateVerified: false, prClosedWithoutMerge: false,
    remoteBranchRemoved: false, localWorktreeRemoved: false, localBranchRemoved: false,
  };
  const queue = new DurableTaskQueue(options.repositoryRoot);
  const worktrees = new IsolatedWorktreeManager(options.repositoryRoot);
  let task: AutonomousTask | undefined;
  let prCreated = false;
  let createdPrUrl: string | undefined;
  let thrown: unknown;
  const trackingGh: DeliveryCommandRunner = {
    run: async (command, cwd, args) => {
      const result = await gh.run(command, cwd, args);
      if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        const candidate = result.stdout.trim();
        if (new RegExp(`^https://github\\.com/${M17_DOGFOOD_REPOSITORY.replace('/', '\\/')}/pull/\\d+$`).test(candidate)) createdPrUrl = candidate;
      }
      return result;
    },
  };

  try {
    task = await queue.enqueue({
      ...createDefaultAutonomousTask(options.repositoryRoot, `Disposable M17 GitHub delivery dogfood ${runId}`),
      origin: 'github-issue',
      repositoryId: repository,
      sourceIssue: { owner: 'siddharthakki', repo: 'ollama-agent', issueNumber: 0 },
      githubDelivery: { transport: 'gh-cli', remote: 'origin', baseBranch },
    });
    const bound = await worktrees.bind(task, branch);
    task = await queue.update(bound.task, 'm17_github_dogfood_worktree_bound', { runId, branch });
    await worktrees.assertBinding(task);
    await fs.writeFile(path.join(task.worktreeLocation!, fixtureName), `runId=${runId}\ntimestamp=${started.toISOString()}\n`, 'utf8');
    await git(commands, task.worktreeLocation!, ['add', '--', fixtureName]);
    await git(commands, task.worktreeLocation!, ['commit', '-m', `test: disposable M17 GitHub delivery dogfood ${runId}`]);
    evidence.commitSha = await git(commands, task.worktreeLocation!, ['rev-parse', 'HEAD']);
    await git(commands, task.worktreeLocation!, ['push', '--set-upstream', 'origin', `${branch}:${branch}`]);
    task = await queue.update({ ...task, githubDelivery: { ...task.githubDelivery, branchPushed: true, commitSha: evidence.commitSha } }, 'm17_github_dogfood_branch_pushed', { runId, branch, commitSha: evidence.commitSha });
    if (options.failurePoint === 'after-push') throw new Error('Injected failure after push.');

    const delivery = new GitDeliveryService(new GhCliGitHubDeliveryTransport(task.worktreeLocation!, trackingGh));
    task = await delivery.createDraftPullRequest(task, baseBranch);
    evidence.pullRequestNumber = task.githubDelivery.pullRequestNumber;
    evidence.pullRequestUrl = task.githubDelivery.pullRequestUrl;
    evidence.pullRequestWasDraft = task.githubDelivery.draft;
    prCreated = true;
    task = await queue.update(task, 'm17_github_dogfood_pr_created', { runId, branch, pullRequestNumber: evidence.pullRequestNumber, pullRequestUrl: evidence.pullRequestUrl });

    const view = JSON.parse((await gh.run('gh', task.worktreeLocation!, ['pr', 'view', evidence.pullRequestUrl!, '--repo', repository, '--json', 'number,url,isDraft,headRefName,baseRefName,state'])).stdout) as Record<string, unknown>;
    if (view.number !== evidence.pullRequestNumber || view.url !== evidence.pullRequestUrl || view.isDraft !== true || view.state !== 'OPEN' || view.baseRefName !== baseBranch || view.headRefName !== branch) {
      throw new Error('Authoritative pull request metadata did not match the disposable delivery.');
    }
    const remoteSha = await git(commands, options.repositoryRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
    if (!remoteSha.startsWith(`${evidence.commitSha}\t`)) throw new Error('Remote branch SHA did not match the committed worktree SHA.');
    const persisted = await queue.get(task.taskId);
    evidence.persistedStateVerified = persisted?.branchName === branch
      && persisted.githubDelivery.commitSha === evidence.commitSha
      && persisted.githubDelivery.pullRequestNumber === evidence.pullRequestNumber
      && persisted.githubDelivery.pullRequestUrl === evidence.pullRequestUrl;
    if (!evidence.persistedStateVerified) throw new Error('Persisted task delivery state did not match the real delivery.');
    if (options.failurePoint === 'after-pr') throw new Error('Injected failure after PR creation.');
  } catch (error) {
    thrown = error;
  } finally {
    if (!prCreated && createdPrUrl) {
      const recovered = await gh.run('gh', options.repositoryRoot, ['pr', 'view', createdPrUrl, '--repo', repository, '--json', 'number,url,isDraft,headRefName,baseRefName,state']).catch(error => { thrown ??= error; return undefined; });
      if (recovered) {
        const parsed = JSON.parse(recovered.stdout) as { number?: number; url?: string; isDraft?: boolean; headRefName?: string; baseRefName?: string; state?: string };
        if (parsed.url === createdPrUrl && parsed.headRefName === branch && parsed.baseRefName === baseBranch && parsed.number && parsed.number > 0) {
          evidence.pullRequestNumber = parsed.number;
          evidence.pullRequestUrl = parsed.url;
          evidence.pullRequestWasDraft = parsed.isDraft;
          prCreated = true;
        }
      }
    }
    if (prCreated && evidence.pullRequestNumber && evidence.pullRequestUrl) {
      await gh.run('gh', options.repositoryRoot, ['pr', 'close', String(evidence.pullRequestNumber), '--repo', repository]).catch(error => { thrown ??= error; });
      const closed = await gh.run('gh', options.repositoryRoot, ['pr', 'view', evidence.pullRequestUrl, '--repo', repository, '--json', 'state,mergedAt']).catch(error => { thrown ??= error; return undefined; });
      if (closed) {
        const parsed = JSON.parse(closed.stdout) as { state?: string; mergedAt?: string | null };
        evidence.prClosedWithoutMerge = parsed.state === 'CLOSED' && parsed.mergedAt == null;
      }
    }
    if (task?.githubDelivery.branchPushed && task.branchName === branch) {
      await git(commands, options.repositoryRoot, ['push', 'origin', '--delete', branch]).catch(error => { thrown ??= error; });
    }
    if (task?.worktreeLocation && task.branchName === branch) {
      await worktrees.finalize(task, 'failed', { dispose: true }).catch(error => { thrown ??= error; });
    }
    await git(commands, options.repositoryRoot, ['worktree', 'prune']).catch(error => { thrown ??= error; });
    await git(commands, options.repositoryRoot, ['branch', '-D', branch]).catch(() => undefined);
    evidence.localWorktreeRemoved = !task?.worktreeLocation || await fs.stat(task.worktreeLocation).then(() => false, () => true);
    evidence.localBranchRemoved = (await git(commands, options.repositoryRoot, ['branch', '--list', branch])).length === 0;
    evidence.remoteBranchRemoved = (await git(commands, options.repositoryRoot, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`])).length === 0;
  }

  if (thrown) throw new M17DogfoodFailure(thrown instanceof Error ? thrown.message : String(thrown), evidence, { cause: thrown });
  if (!evidence.prClosedWithoutMerge || !evidence.remoteBranchRemoved || !evidence.localWorktreeRemoved || !evidence.localBranchRemoved) {
    throw new M17DogfoodFailure('M17 GitHub delivery cleanup verification failed.', evidence);
  }
  return evidence;
}
