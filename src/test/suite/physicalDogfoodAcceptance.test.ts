import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as vscodeMock from '../mocks/vscode';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { AutonomousTaskRuntime, type KarkeDikhaLifecycleAuthority } from '../../activation/M15AutonomousRuntime';
import { CommandService } from '../../services/CommandService';

const AGENT_BENCH_ROOT = 'C:\\Projects\\agent-bench';
const AGENT_BENCH_BASELINE_SHA = 'f7c8f0d7edb03fb293637bd837cd8a7ed0af9cb3';

function createTestAuthority(taskId: string, root: string, goal: string): KarkeDikhaLifecycleAuthority {
  let approvalCount = 0;
  return {
    context: {
      attemptId: taskId,
      workspaceRoot: root,
      taskInput: goal,
      selectedProvider: 'ollama',
      selectedModel: 'qwen3.8:27b-mtp-q4_K_M',
    } as never,
    heartbeat: async () => undefined,
    requestApproval: async (kind: 'proposal' | 'mutation') => {
      approvalCount++;
      return {
        id: `appr_${approvalCount}`,
        attemptId: taskId,
        kind,
        status: 'pending',
        revision: 1,
      } as never;
    },
    resolveApproval: async () => undefined,
    beginValidation: async () => undefined,
    reportValidation: async (evidence) => {
      approvalCount++;
      if (evidence.commands.every(c => c.exitCode === 0 && !c.timedOut)) {
        return {
          outcome: 'waiting_for_delivery_approval',
          attempt: { id: taskId, status: 'waiting_for_approval' } as never,
          approval: {
            id: `appr_${approvalCount}`,
            attemptId: taskId,
            kind: 'delivery',
            status: 'pending',
            revision: 1,
          } as never,
        };
      } else {
        return {
          outcome: 'failed',
          attempt: { id: taskId, status: 'failed' } as never,
        };
      }
    },
    recordExecutionQuality: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
  };
}

function createTestContext(): any {
  return {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: {
      packageJSON: {
        scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
        contributes: {
          commands: [
            { command: 'ollama-agent.runEvaluationSuite' },
            { command: 'ollama-agent.showQualityGateDecision' },
          ],
        },
      },
    },
  };
}

async function git(args: string[], cwd = AGENT_BENCH_ROOT): Promise<string> {
  const result = await CommandService.runGit(args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForState(
  queue: DurableTaskQueue,
  taskId: string,
  targetStates: string[],
  timeoutMs = 180_000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const task = await queue.get(taskId);
    if (task && targetStates.includes(task.state)) {
      return task;
    }
    await sleep(500);
  }
  const lastTask = await queue.get(taskId);
  throw new Error(`Timed out waiting for task ${taskId} to reach [${targetStates.join(', ')}]. Current state: ${lastTask?.state}, latestProgress: ${lastTask?.latestProgress}`);
}

/**
 * This suite drives a real, external checkout (`C:\Projects\agent-bench`, pinned to a baseline SHA) plus a live local
 * model. The checkout is not part of this repository and is never fabricated. When it is absent the suite is skipped
 * with an explicit MISSING_EXTERNAL_FIXTURE notice instead of failing three tests with an opaque `spawn git ENOENT`.
 * Set KARKEDIKHA_REQUIRE_AGENT_BENCH=1 where the fixture is expected to exist and its absence must fail the run.
 */
const AGENT_BENCH_PRESENT = fs.existsSync(path.join(AGENT_BENCH_ROOT, '.git'));
const REQUIRE_AGENT_BENCH = process.env.KARKEDIKHA_REQUIRE_AGENT_BENCH === '1';
if (!AGENT_BENCH_PRESENT) {
  console.warn(`[physicalDogfoodAcceptance] MISSING_EXTERNAL_FIXTURE: ${AGENT_BENCH_ROOT} is not a git checkout; suite ${REQUIRE_AGENT_BENCH ? 'REQUIRED and failing' : 'skipped'}. Not a product failure.`);
}

describe('agent-bench fixture availability', () => {
  it('is present when KARKEDIKHA_REQUIRE_AGENT_BENCH=1', () => {
    if (!REQUIRE_AGENT_BENCH) return;
    expect(AGENT_BENCH_PRESENT, `${AGENT_BENCH_ROOT} must be a git checkout`).toBe(true);
  });
});

(AGENT_BENCH_PRESENT ? describe.sequential : describe.skip)('Physical Dogfood Acceptance on C:\\Projects\\agent-bench', () => {
  const queue = new DurableTaskQueue(AGENT_BENCH_ROOT);
  const worktrees = new IsolatedWorktreeManager(AGENT_BENCH_ROOT);

  // Configure real local Ollama provider and available model
  vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
  vscodeMock._setConfig('ollama-agent.codingModel', 'qwen3.8:27b-mtp-q4_K_M');
  vscodeMock._setConfig('ollama-agent.model', 'qwen3.8:27b-mtp-q4_K_M');
  vscodeMock._setConfig('ollama-agent.endpoint', 'http://127.0.0.1:11434');

  beforeEach(async () => {
    try {
      await git(['checkout', 'main']);
      await git(['reset', '--hard', AGENT_BENCH_BASELINE_SHA]);
    } catch {
      // ignore
    }
    try {
      const manifestFile = path.join(AGENT_BENCH_ROOT, '.ollama-agent', 'tasks', '_worktrees', 'manifest.json');
      const fs = await import('fs/promises');
      const content = await fs.readFile(manifestFile, 'utf8');
      const manifest = JSON.parse(content);
      let changed = false;
      for (const lease of manifest.leases ?? []) {
        if (lease.status === 'active') {
          lease.status = 'failed';
          changed = true;
        }
      }
      if (changed) {
        await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
      }
    } catch {
      // manifest might not exist yet
    }
  });

  afterAll(async () => {
    try {
      await git(['checkout', 'main']);
      await git(['reset', '--hard', AGENT_BENCH_BASELINE_SHA]);
    } catch {
      // ignore
    }
  });

  it('Test A — Supervised success flow', async () => {
    // 0. Verify initial workspace state is clean
    const statusBefore = await git(['status', '--short']);
    expect(statusBefore).toBe('');
    const headBefore = await git(['rev-parse', 'HEAD']);
    const branchBefore = await git(['branch', '--show-current']);
    expect(branchBefore).toBe('main');

    const resources = new TaskResourceScheduler({
      maxActiveTasks: 2,
      maxActiveMutatingTasks: 1,
      modelConcurrency: { '*': 1 },
    });
    const runtime = new AutonomousTaskRuntime(
      createTestContext(),
      AGENT_BENCH_ROOT,
      queue,
      resources,
      worktrees,
    );

    const goal = 'Add a regression test in tests/test_pricing.py that verifies percentage_discount(200, 10) returns 20.00.\n\nDo not change production code unless the test proves it is necessary.\n\nRun tests/test_pricing.py and the full pytest suite.';
    const taskId = 'm15_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 10);
    const defaultTask = createDefaultAutonomousTask(AGENT_BENCH_ROOT, goal);
    const task = await queue.enqueue({
      ...defaultTask,
      taskId,
      attemptId: taskId,
      autonomyMode: 'supervised',
      providerModelRoutingSnapshot: {
        provider: 'ollama',
        model: 'qwen3.8:27b-mtp-q4_K_M',
      },
    });
    const authority = createTestAuthority(task.taskId, AGENT_BENCH_ROOT, task.goal);
    runtime.bindCoreAuthority(task.taskId, authority);

    try {
      runtime.wake();

      // 1. Must stop for manual proposal approval
      const proposalWaiting = await waitForState(queue, task.taskId, ['waiting_for_proposal_approval', 'blocked', 'failed'], 180_000);
      expect(proposalWaiting.state).toBe('waiting_for_proposal_approval');
      expect(proposalWaiting.pendingProposal).toBeDefined();

      const eventsAfterProposal = await queue.eventsAfter(task.taskId, 0);
      const proposalWaitingEvents = eventsAfterProposal.filter(e => e.type === 'progress' && (String(e.payload.progress).includes('approval_requested gate=proposal') || String(e.payload.progress).includes('approval_waiting gate=proposal')));
      expect(proposalWaitingEvents.length).toBeGreaterThanOrEqual(1);

      // 2. Approve proposal manually
      const proposalId = proposalWaiting.pendingProposal!.proposalId;
      await runtime.approveProposal(task.taskId, proposalId);

      // 3. Must stop for manual mutation approval
      const mutationWaiting = await waitForState(queue, task.taskId, ['waiting_for_mutation_approval', 'blocked', 'failed'], 180_000);
      expect(mutationWaiting.state).toBe('waiting_for_mutation_approval');
      expect(mutationWaiting.pendingMutationApproval).toBeDefined();

      // 4. Approve mutation manually
      const requestId = mutationWaiting.pendingMutationApproval!.requestId;
      await runtime.approveMutation(task.taskId, requestId);

      // 5. Must execute mutation in isolated worktree, run validation, and reach waiting_for_delivery_approval
      const deliveryWaiting = await waitForState(queue, task.taskId, ['waiting_for_delivery_approval', 'blocked', 'failed'], 180_000);
      expect(deliveryWaiting.state).toBe('waiting_for_delivery_approval');

      // 6. Verify state BEFORE Apply:
      // Must be "waiting_for_delivery_approval" (Ready to apply), NOT "completed"
      expect(deliveryWaiting.state).toBe('waiting_for_delivery_approval');
      const headMid = await git(['rev-parse', 'HEAD']);
      expect(headMid).toBe(headBefore); // workspace not yet modified

      const eventsBeforeApply = await queue.eventsAfter(task.taskId, 0);
      // No duplicate proposal approval events with actor=user
      const proposalApprovedEvents = eventsBeforeApply.filter(e => e.type === 'progress' && String(e.payload.progress).startsWith('approval_approved gate=proposal actor=user'));
      expect(proposalApprovedEvents.length).toBe(1);

      // Validation and diff review passed
      const validationCompleted = eventsBeforeApply.find(e => e.type === 'progress' && /^validation_completed commands=\d+ failed=0$/.test(String(e.payload.progress)));
      expect(validationCompleted).toBeDefined();
      expect(deliveryWaiting.diffReview?.verdict).toBe('pass');

      // 7. Click Apply (approve delivery)
      await runtime.approveDelivery(task.taskId);

      // 8. AFTER Apply: task is completed, committed, and landed on main
      const completedTask = await waitForState(queue, task.taskId, ['completed', 'blocked', 'failed'], 30_000);
      expect(completedTask.state).toBe('completed');
      expect(completedTask.githubDelivery?.commitSha).toBeDefined();

      const headAfter = await git(['rev-parse', 'HEAD']);
      expect(headAfter).not.toBe(headBefore);
      expect(headAfter).toBe(completedTask.githubDelivery.commitSha);

      const statusAfter = await git(['status', '--short']);
      expect(statusAfter).toBe('');

      const logAfter = await git(['log', '-1', '--oneline']);
      expect(logAfter).toContain(`M15 delivery ${task.taskId}`);
    } finally {
      runtime.dispose();
    }
  }, 300_000);

  it('Test B — Hands-off success flow', async () => {
    const statusBefore = await git(['status', '--short']);
    expect(statusBefore).toBe('');
    const headBefore = await git(['rev-parse', 'HEAD']);

    const resources = new TaskResourceScheduler({
      maxActiveTasks: 2,
      maxActiveMutatingTasks: 1,
      modelConcurrency: { '*': 1 },
    });
    const runtime = new AutonomousTaskRuntime(
      createTestContext(),
      AGENT_BENCH_ROOT,
      queue,
      resources,
      worktrees,
    );

    const goal = 'Add a regression test in tests/test_pricing.py that verifies percentage_discount(300, 5) returns 15.00.\n\nDo not change production code unless necessary.\n\nRun tests/test_pricing.py and the full pytest suite.';
    const taskId = 'm15_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 10);
    const defaultTask = createDefaultAutonomousTask(AGENT_BENCH_ROOT, goal);
    const task = await queue.enqueue({
      ...defaultTask,
      taskId,
      attemptId: taskId,
      autonomyMode: 'hands_off',
      providerModelRoutingSnapshot: {
        provider: 'ollama',
        model: 'qwen3.8:27b-mtp-q4_K_M',
      },
    });
    const authority = createTestAuthority(task.taskId, AGENT_BENCH_ROOT, task.goal);
    runtime.bindCoreAuthority(task.taskId, authority);

    try {
      runtime.wake();

      // In hands-off mode, proposal, mutation, and delivery gates are automatically authorized.
      // Runtime directly reaches completed without manual clicks!
      const completedTask = await waitForState(queue, task.taskId, ['completed', 'blocked', 'failed'], 180_000);
      expect(completedTask.state).toBe('completed');
      expect(completedTask.githubDelivery?.commitSha).toBeDefined();

      const allEvents = await queue.eventsAfter(task.taskId, 0);

      // Verify Actor attribution is hands_off_policy, NEVER user!
      const userProposalEvents = allEvents.filter(e => e.type === 'progress' && String(e.payload.progress).includes('gate=proposal actor=user'));
      expect(userProposalEvents.length).toBe(0);

      const userMutationEvents = allEvents.filter(e => e.type === 'progress' && String(e.payload.progress).includes('gate=mutation actor=user'));
      expect(userMutationEvents.length).toBe(0);

      const userDeliveryEvents = allEvents.filter(e => e.type === 'progress' && String(e.payload.progress).includes('gate=delivery actor=user'));
      expect(userDeliveryEvents.length).toBe(0);

      const handsOffProposal = allEvents.find(e => e.type === 'progress' && (String(e.payload.progress).includes('policy=hands_off') || String(e.payload.progress).includes('actor=hands_off_policy')));
      expect(handsOffProposal).toBeDefined();

      // State AFTER hands-off completion: committed and landed on main
      const headAfter = await git(['rev-parse', 'HEAD']);
      expect(headAfter).not.toBe(headBefore);
      expect(headAfter).toBe(completedTask.githubDelivery.commitSha);

      const statusAfter = await git(['status', '--short']);
      expect(statusAfter).toBe('');
    } finally {
      runtime.dispose();
    }
  }, 300_000);

  it('Test C — validation failure truthfulness', async () => {
    const statusBefore = await git(['status', '--short']);
    expect(statusBefore).toBe('');

    const resources = new TaskResourceScheduler({
      maxActiveTasks: 2,
      maxActiveMutatingTasks: 1,
      modelConcurrency: { '*': 1 },
    });
    const runtime = new AutonomousTaskRuntime(
      createTestContext(),
      AGENT_BENCH_ROOT,
      queue,
      resources,
      worktrees,
    );

    // Deterministic forced validation failure. The previous fixture asked the
    // model to write an assertion that contradicts production code, but the
    // bounded validation-repair loop may edit the target test file, so the
    // live model could legitimately "repair" it (it added @pytest.mark.xfail)
    // and validation then genuinely passed. Instead, plant a permanently
    // failing test in a file OUTSIDE the mutation's repair allowedPaths, so the
    // full-suite validation command fails after any mutation and no repair
    // can fix it. The fixture commit precedes headBefore and is discarded by
    // the beforeEach/afterAll reset to the baseline SHA.
    const fs = await import('fs/promises');
    await fs.writeFile(
      path.join(AGENT_BENCH_ROOT, 'tests', 'test_forced_validation_failure.py'),
      'def test_forced_validation_failure():\n    assert False, "deterministic fixture failure"\n',
      'utf8',
    );
    await git(['add', 'tests/test_forced_validation_failure.py']);
    await git(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Test C fixture: forced validation failure']);
    const headBefore = await git(['rev-parse', 'HEAD']);

    const goal = 'In tests/test_pricing.py, add a test function named test_percentage_discount_fixture_check that asserts percentage_discount(100, 15) == Decimal("15.00").\n\nDo not modify production code.\n\nRun pytest tests/test_pricing.py and the full pytest suite.';
    const taskId = 'm15_' + Date.now().toString(36) + '_' + Math.random().toString(16).slice(2, 10);
    const defaultTask = createDefaultAutonomousTask(AGENT_BENCH_ROOT, goal);
    const task = await queue.enqueue({
      ...defaultTask,
      taskId,
      attemptId: taskId,
      autonomyMode: 'hands_off',
      providerModelRoutingSnapshot: {
        provider: 'ollama',
        model: 'qwen3.8:27b-mtp-q4_K_M',
      },
    });
    const authority = createTestAuthority(task.taskId, AGENT_BENCH_ROOT, task.goal);
    runtime.bindCoreAuthority(task.taskId, authority);

    try {
      runtime.wake();

      // Task must fail validation and end up BLOCKED
      const terminalTask = await waitForState(queue, task.taskId, ['blocked', 'failed'], 240_000);
      expect(terminalTask.state).toBe('blocked');
      expect(['validation_failed', 'mutation_failed']).toContain(terminalTask.failure?.classification);

      // Working repository is untouched!
      const headAfter = await git(['rev-parse', 'HEAD']);
      expect(headAfter).toBe(headBefore);
      const statusAfter = await git(['status', '--short']);
      expect(statusAfter).toBe('');

      // Validation passed was NEVER emitted as the final outcome
      const allEvents = await queue.eventsAfter(task.taskId, 0);
      expect(allEvents.some(e => e.type === 'delivery_committed')).toBe(false);
      expect(allEvents.some(e => e.type === 'state_transition' && (e.payload as { to?: string }).to === 'waiting_for_delivery_approval')).toBe(false);
      const progress = allEvents.filter(e => e.type === 'progress').map(e => String(e.payload.progress));
      // Real validation ran after the mutation, and no success outcome was ever reported.
      expect(progress.some(p => p.startsWith('mutation_completed'))).toBe(true);
      expect(progress.some(p => p.startsWith('validation_command_started'))).toBe(true);
      expect(progress.some(p => p.startsWith('validation_completed') && p.includes('failed=0'))).toBe(false);
    } finally {
      runtime.dispose();
    }
  }, 300_000);
});
