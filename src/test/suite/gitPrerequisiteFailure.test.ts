import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { classifyExecutionResult } from '../../autonomous/recovery/FailureClassifier';
import { RecoveryController, type RecoveryBudgetView } from '../../autonomous/recovery/RecoveryController';
import type { RecoveryCandidate } from '../../autonomous/recovery/RecoveryModelRouter';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { GovernedCodingExecutor, type GovernedCodingExecutionResult } from '../../coding/GovernedCodingExecutor';
import { GIT_AUTHOR_IDENTITY_UNAVAILABLE, GitAuthorIdentityUnavailableError } from '../../coding/GitPrerequisites';
import { ProviderCircuitBreaker, providerReachabilityForCause } from '../../mission/ProviderCircuitBreaker';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { AutonomousTaskRuntime } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { ProviderGateway } from '../../providers/ProviderGateway';
import type { InferenceProvider, ModelInfo } from '../../providers/ProviderTypes';
import type { ChatMessage, ChatResponse } from '../../tools/ToolTypes';

const LIMITS: RecoveryBudgetView['limits'] = {
  wallClockMs: 4 * 60 * 60 * 1000,
  modelCalls: 200,
  toolCalls: 500,
  recoveryAttemptsPerFailureClass: 3,
  validationRepairs: 6,
  modelEscalations: 3,
  noProgress: 4,
};

function candidate(model: string): RecoveryCandidate {
  return {
    provider: 'ollama',
    model,
    local: true,
    available: true,
    capability: { chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: ['agent'], contextWindow: 32768 },
  };
}

function executionResult(over: Partial<GovernedCodingExecutionResult>): GovernedCodingExecutionResult {
  return {
    runId: 'r',
    status: 'mutation_failed',
    validations: [],
    validationHistory: [],
    repairAttempts: 0,
    validationPhase: { status: 'not_started' },
    ...over,
  };
}

async function run(cwd: string, args: string[]): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

/** A repository whose initial commit used a one-off identity, leaving NO identity configured. */
async function initRepositoryWithoutIdentity(root: string): Promise<void> {
  await run(root, ['init', '-q']);
  await run(root, ['config', 'core.autocrlf', 'false']);
  await run(root, ['add', '.']);
  await run(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'init']);
}

/** Hermetic Git config for this process: no global/system identity and no auto-detection. */
async function isolateGitIdentity(dir: string): Promise<() => void> {
  const globalConfig = path.join(dir, 'gitconfig-no-identity');
  await fs.writeFile(globalConfig, '[user]\n\tuseConfigOnly = true\n');
  const keys = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  return () => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  };
}

describe('Git prerequisite failures are environment failures, never provider failures', () => {
  let root: string;
  let journal: AttemptJournal;
  let decisionSeq: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-git-prereq-'));
    journal = await AttemptJournal.open({ repositoryRoot: root, taskId: 'task_git' });
    decisionSeq = 0;
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function controller(): RecoveryController {
    return new RecoveryController({
      journal,
      // Capable alternatives exist: a provider-classified failure WOULD change model here.
      candidates: [candidate('current:27b'), candidate('other:27b'), candidate('third:32b')],
      modelPolicy: { pinned: false, fallbackAllowedWhenPinned: false, cloudAuthorized: false },
      budget: async () => ({ totals: {}, limits: LIMITS }),
      allocateDecisionSequence: async () => (decisionSeq += 1),
    });
  }

  it('a non-Git workspace yields an explicit git_prerequisite_unavailable result with an actionable reason and no model call', async () => {
    const providerSpy = vi.spyOn(ProviderGateway, 'create');
    const result = await new GovernedCodingExecutor().execute({
      runId: 'git-prereq-1',
      goal: 'add a new file test.txt and write only Hello in it',
      workspaceRoot: root,
      signal: new AbortController().signal,
      secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
      auditSource: 'test',
      extensionBuild: 'test-build',
      executionProfile: classifyExecutionProfile('add a new file test.txt and write only Hello in it'),
      deterministicProposal: { path: 'test.txt', content: 'Hello', reason: 'Deterministic exact-content file write.' },
      callbacks: {
        checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
        reviewProposal: async () => true,
        approveExecution: async () => true,
        confirmElevated: async () => true,
      },
    });
    expect(result.status).toBe('git_prerequisite_unavailable');
    expect(result.errorCode).toBe('git_repository_unavailable');
    expect(result.failureReason).toMatch(/not a Git repository/);
    expect(result.failureReason).toMatch(/git init/);
    expect(result.failureReason).not.toMatch(/adjust the request/i);
    expect(providerSpy).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(root, 'test.txt'))).rejects.toThrow();

    const outcome = classifyExecutionResult(result, { attemptId: 'att', pass: 1, model: { provider: 'ollama', model: 'current:27b' } });
    expect(outcome.cause).toBe('environment_failure');
    expect(outcome.subcode).toBe('git_repository_unavailable');
  });

  for (const row of [
    { name: 'explicit status', result: { status: 'git_prerequisite_unavailable' as const, errorCode: 'git_repository_unavailable' } },
    // The exact alpha failure shape: legacy readiness code through the executor's mutation_failed catch-all.
    { name: 'legacy git_identity_unavailable through mutation_failed', result: { status: 'mutation_failed' as const, errorCode: 'git_identity_unavailable' } },
  ]) {
    it(`${row.name}: never CHANGE_MODEL, never a provider failure, never a retry`, async () => {
      const outcome = classifyExecutionResult(executionResult(row.result), { attemptId: 'att', pass: 1, model: { provider: 'ollama', model: 'current:27b' } });
      expect(outcome.cause).toBe('environment_failure');
      expect(outcome.cause).not.toBe('provider_failure');

      const decision = await controller().decide(outcome);
      expect(decision.action).toBe('BLOCK');
      expect(decision.action).not.toBe('CHANGE_MODEL');
      expect(decision.action).not.toBe('RETRY_OPERATION');
      expect(decision.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(decision.terminalState).not.toBe('NO_CAPABLE_MODEL');
      expect(decision.directives.model).toBeUndefined();
      expect(decision.reason).toMatch(/Git prerequisite missing/);
    });
  }

  it('does not count against or open the provider circuit breaker', async () => {
    const outcome = classifyExecutionResult(executionResult({ status: 'mutation_failed', errorCode: 'git_identity_unavailable' }), { attemptId: 'att', pass: 1 });
    const decision = await controller().decide(outcome);
    const breaker = new ProviderCircuitBreaker({ cooldownMs: 60_000 });
    const now = Date.now();
    // Exactly the rule the runtime applies after each recovery decision.
    breaker.recordOutcome(providerReachabilityForCause(decision.cause), now);
    breaker.recordOutcome(providerReachabilityForCause(decision.cause), now + 1);
    expect(breaker.isOpen(now + 2)).toBe(false);
    // Control: a genuine provider failure does open it.
    breaker.recordOutcome(providerReachabilityForCause('provider_failure'), now + 3);
    expect(breaker.isOpen(now + 4)).toBe(true);
  });

  it('readiness does not require Git author identity, only a repository', async () => {
    await fs.writeFile(path.join(root, 'a.txt'), 'a\n');
    await initRepositoryWithoutIdentity(root);
    const restore = await isolateGitIdentity(await fs.mkdtemp(path.join(os.tmpdir(), 'oa-git-noid-')));
    try {
      await expect(run(root, ['var', 'GIT_AUTHOR_IDENT'])).rejects.toThrow(/identity unknown|no email was given/i);
      const readiness = await new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check([]);
      expect(readiness.blockingFailures).toEqual([]);
    } finally {
      restore();
    }
  });
});

class CodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  readonly completion = JSON.stringify({
    version: 1,
    taskSummary: 'Autonomous acceptance change',
    operations: [{ type: 'create', path: 'src/generated/identity.ts', reason: 'acceptance', content: 'export const identity = true;\n' }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });

  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const prompt = messages.map(message => message.content).join('\n');
    this.prompts.push(prompt);
    const content = prompt.includes('Investigation turn')
      ? JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.completion) })
      : this.completion;
    return { message: { role: 'assistant', content }, done: true };
  }
}

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: {
      packageJSON: {
        scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
        contributes: { commands: [{ command: 'ollama-agent.runEvaluationSuite' }, { command: 'ollama-agent.showQualityGateDecision' }] },
      },
    },
  } as unknown as vscode.ExtensionContext;
}

describe('Delivery pauses safely when Git author identity is missing', () => {
  let root: string;
  let restoreIdentity: () => void;
  let provider: CodingProvider;
  let queue: DurableTaskQueue;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-git-identity-delivery-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n');
    await initRepositoryWithoutIdentity(root);
    restoreIdentity = await isolateGitIdentity(await fs.mkdtemp(path.join(os.tmpdir(), 'oa-git-noid-')));
    provider = new CodingProvider();
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    queue = new DurableTaskQueue(root);
  });

  afterEach(async () => {
    restoreIdentity();
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('reaches proposal, mutation and validation without identity, pauses delivery, then resumes delivery without re-running coding', async () => {
    const primaryHead = await run(root, ['rev-parse', 'HEAD']);
    const primaryStatus = await run(root, ['status', '--porcelain']);
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add acceptance file'));
    const runtime = new AutonomousTaskRuntime(
      context(),
      root,
      queue,
      new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } }),
      new IsolatedWorktreeManager(root),
    );
    const gates: string[] = [];
    runtime.onProposalApprovalRequired(async pending => {
      gates.push('proposal');
      // Untouched before the governed approval.
      expect(await run(root, ['rev-parse', 'HEAD'])).toBe(primaryHead);
      expect(await run(root, ['status', '--porcelain'])).toBe(primaryStatus);
      await runtime.approveProposal(pending.taskId, pending.pendingProposal!.proposalId).catch(() => undefined);
    });
    runtime.onMutationApprovalRequired(async pending => {
      gates.push('mutation');
      expect(await run(root, ['status', '--porcelain'])).toBe(primaryStatus);
      await runtime.approveMutation(pending.taskId, pending.pendingMutationApproval!.requestId).catch(() => undefined);
    });
    vscodeMock._setQuickPickSelection({ label: 'Summary: Autonomous acceptance change' });
    vscodeMock._setWarningMessageSelection('Approve Execution');

    runtime.wake();
    await runtime.waitForIdle();

    // Investigation -> proposal -> approval -> mutation -> validation all ran with no Git identity.
    const waiting = await queue.get(task.taskId);
    expect(waiting?.state).toBe('waiting_for_delivery_approval');
    expect(waiting?.qualityGate?.status).toBe('passed');
    expect(gates).toContain('proposal');
    const worktree = waiting!.worktreeLocation!;
    await expect(fs.readFile(path.join(worktree, 'src/generated/identity.ts'), 'utf8')).resolves.toContain('identity = true');
    expect(await run(root, ['rev-parse', 'HEAD'])).toBe(primaryHead);
    expect(await run(root, ['status', '--porcelain'])).toBe(primaryStatus);
    const promptsBeforeDelivery = provider.prompts.length;
    expect(promptsBeforeDelivery).toBeGreaterThan(0);

    // Delivery needs a commit: it pauses with an actionable message instead of failing.
    const paused = runtime.approveDelivery(task.taskId);
    await expect(paused).rejects.toBeInstanceOf(GitAuthorIdentityUnavailableError);
    await expect(paused).rejects.toThrow(/git config --global user\.name/);
    await expect(paused).rejects.toThrow(/user\.email/);
    await expect(paused).rejects.not.toThrow(/adjust the request/i);

    const afterPause = await queue.get(task.taskId);
    expect(afterPause?.state).toBe('waiting_for_delivery_approval');
    expect(afterPause?.failure).toBeUndefined();
    expect(afterPause?.worktreeLocation).toBe(worktree);
    expect((await queue.events(task.taskId)).some(event =>
      event.type === 'progress' && String(event.payload.progress).includes(`delivery_waiting_for_git_identity code=${GIT_AUTHOR_IDENTITY_UNAVAILABLE}`))).toBe(true);
    // Validated worktree preserved, nothing committed, repository untouched, no identity invented.
    await expect(fs.readFile(path.join(worktree, 'src/generated/identity.ts'), 'utf8')).resolves.toContain('identity = true');
    expect(await run(worktree, ['rev-parse', 'HEAD'])).toBe(waiting!.worktreeBaseCommit);
    expect(await run(root, ['rev-parse', 'HEAD'])).toBe(primaryHead);
    expect(await run(root, ['status', '--porcelain'])).toBe(primaryStatus);
    await expect(run(root, ['config', '--get', 'user.email'])).rejects.toThrow();

    // The user configures Git (repository-local) and retries delivery.
    await run(root, ['config', 'user.name', 'Real User']);
    await run(root, ['config', 'user.email', 'real.user@example.invalid']);
    await runtime.approveDelivery(task.taskId);

    const completed = await queue.get(task.taskId);
    expect(completed?.state).toBe('completed');
    expect(completed?.githubDelivery.commitSha).toBeTruthy();
    expect(await run(worktree, ['log', '-1', '--format=%an <%ae>'])).toBe('Real User <real.user@example.invalid>');
    // Delivery resumed from the preserved worktree; coding was not re-run.
    expect(provider.prompts.length).toBe(promptsBeforeDelivery);
    runtime.dispose();
  }, 120_000);
});
