import * as vscode from 'vscode';
import {
  AutonomousTaskInputTooLargeError,
  DurableTaskQueue,
  FakeGitHubDeliveryTransport,
  GitDeliveryService,
  IsolatedWorktreeManager,
  MergeReadinessService,
  TaskResourceScheduler,
  TaskRuntimeCoordinator,
  autoWorkspaceHostFactory,
  createDefaultAutonomousTask,
  isValidAutonomousTransition,
  listResumableAutonomousTasks,
} from '../autonomous/M15AutonomousWork';
import { AutonomousTaskRuntime } from './M15AutonomousRuntime';
import { GovernedCodingExecutor } from '../coding/GovernedCodingExecutor';

export const M15_COMMANDS = [
  'ollama-agent.startAutonomousTask',
  'ollama-agent.startTaskFromGitHubIssue',
  'ollama-agent.showBackgroundTasks',
  'ollama-agent.showTaskDetails',
  'ollama-agent.pauseTask',
  'ollama-agent.resumeTask',
  'ollama-agent.cancelTask',
  'ollama-agent.retryTask',
  'ollama-agent.continuePreviousTask',
  'ollama-agent.sendFollowUpInstruction',
  'ollama-agent.scheduleTask',
  'ollama-agent.manageScheduledTasks',
  'ollama-agent.showMergeReadiness',
  'ollama-agent.openDraftPullRequest',
] as const;

export function registerM15AutonomousCommands(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  startCoreOwnedTask: (goal: string) => Promise<void>,
  executor: GovernedCodingExecutor = new GovernedCodingExecutor(),
): AutonomousTaskRuntime {
  const queue = new DurableTaskQueue(workspaceRoot);
  // Git-optional: classifies `workspaceRoot` once and only uses real git
  // worktree isolation when it is itself a Git repository top-level.
  const worktrees = new IsolatedWorktreeManager(workspaceRoot, autoWorkspaceHostFactory(workspaceRoot));
  const resources = new TaskResourceScheduler({
    maxActiveTasks: 2,
    maxActiveMutatingTasks: 1,
    modelConcurrency: { '*': 1 },
  });
  const coordinator = new TaskRuntimeCoordinator(queue, resources, worktrees);
  const runtime = new AutonomousTaskRuntime(context, workspaceRoot, queue, resources, worktrees, executor);
  runtime.requireCoreAuthorityForNewWork();
  context.subscriptions.push(runtime);
  // Owned startup task: registration itself performs no Git work. start() runs
  // repository readiness + recovery and never rejects (expected obstacles become
  // bounded diagnostics); the .catch below is a named defensive backstop only.
  void runtime.start(coordinator).catch(error => runtime.reportUnexpectedStartupFailure(error));

  context.subscriptions.push(
    vscode.commands.registerCommand('ollama-agent.startAutonomousTask', async (goal?: string) => {
      const argumentIsTaskId = typeof goal === 'string' && Boolean(await queue.get(goal).catch(() => undefined));
      let resolvedGoal = typeof goal === 'string' && goal.trim() && !argumentIsTaskId
        ? goal
        : await vscode.window.showInputBox({ title: 'Start Autonomous Task', prompt: 'Bounded task goal' });
      if (!resolvedGoal) return;
      // Bounded, single re-prompt: on an over-limit rejection the user's text is
      // never discarded — it is retained verbatim in a re-opened input so they can
      // shorten it, matching the "never create a partially truncated task" contract.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await startCoreOwnedTask(resolvedGoal);
          return;
        } catch (error) {
          if (!(error instanceof AutonomousTaskInputTooLargeError) || attempt > 0) throw error;
          const retry = await vscode.window.showInputBox({
            title: 'Start Autonomous Task',
            prompt: `Task text is ${error.utf8ByteCount} UTF-8 bytes; the limit is ${error.limitBytes}. Shorten it to continue.`,
            value: resolvedGoal,
            valueSelection: undefined,
          });
          if (!retry) return;
          resolvedGoal = retry;
        }
      }
    }),
    vscode.commands.registerCommand('ollama-agent.startTaskFromGitHubIssue', async () => {
      const spec = await vscode.window.showInputBox({ title: 'Start Task from GitHub Issue', prompt: 'owner/repo#number' });
      if (!spec) return;
      const match = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec(spec.trim());
      if (!match) {
        vscode.window.showErrorMessage('Use owner/repo#number.');
        return;
      }
      const transport = new FakeGitHubDeliveryTransport();
      const delivery = new GitDeliveryService(transport);
      const task = await delivery.ingestIssue(workspaceRoot, {
        owner: match[1],
        repo: match[2],
        issueNumber: Number(match[3]),
      }, queue);
      vscode.window.showInformationMessage(`GitHub issue task queued: ${task.taskId}`);
      runtime.wake();
    }),
    vscode.commands.registerCommand('ollama-agent.showBackgroundTasks', async () => {
      const tasks = await queue.list();
      await showTaskPick(tasks.map(task => ({
        label: task.goal,
        description: `${task.state} | ${task.priority}`,
        detail: task.taskId,
      })), 'M15 Background Tasks');
    }),
    vscode.commands.registerCommand('ollama-agent.showTaskDetails', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task) return;
      const lines = [
        `Task: ${task.taskId}`,
        `State: ${task.state}`,
        `Origin: ${task.origin}`,
        `Worktree: ${task.worktreeLocation ?? '(not bound)'}`,
        `Branch: ${task.branchName ?? '(not created)'}`,
        `M13 run: ${task.m13RunId ?? '(none)'}`,
        `Progress: ${task.latestProgress ?? '(none)'}`,
        `Quality gate: ${task.qualityGate ? `${task.qualityGate.status} (${task.qualityGate.findingsCount} finding(s))` : '(not evaluated)'}`,
        `Failure: ${task.failure ? `${task.failure.classification}: ${task.failure.message}` : '(none)'}`,
        `Delivery: ${task.terminalResult ? task.terminalResult.status : task.state}`,
        `PR: ${task.githubDelivery.pullRequestUrl ?? '(not created)'}`,
      ];
      await vscode.window.showQuickPick(lines.map(label => ({ label })), { title: 'M15 Task Details' });
    }),
    vscode.commands.registerCommand('ollama-agent.pauseTask', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task || task.state === 'paused') return;
      if (!isValidAutonomousTransition(task.state, 'paused')) {
        vscode.window.showWarningMessage(`Task cannot be paused from its current state (${task.state}).`);
        return;
      }
      await queue.transition(selected, 'paused', { requestedBy: 'user' });
      vscode.window.showInformationMessage(`Task paused: ${selected}`);
    }),
    vscode.commands.registerCommand('ollama-agent.resumeTask', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task || task.state !== 'paused') return;
      await queue.transition(selected, 'queued', { requestedBy: 'user' });
      vscode.window.showInformationMessage(`Task resumed: ${selected}`);
      runtime.wake();
    }),
    vscode.commands.registerCommand('ollama-agent.cancelTask', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const confirm = await vscode.window.showWarningMessage(`Cancel task ${selected}?`, { modal: true }, 'Cancel Task');
      if (confirm !== 'Cancel Task') return;
      await runtime.cancelTask(selected);
      vscode.window.showInformationMessage(`Task cancelled: ${selected}`);
    }),
    vscode.commands.registerCommand('ollama-agent.retryTask', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task || task.state === 'cancelled' || task.attempt >= task.maxRetries) {
        vscode.window.showWarningMessage('Task cannot be retried.');
        return;
      }
      const retry = await queue.enqueue({
        origin: 'retry',
        taskKind: task.taskKind,
        repositoryRoot: task.repositoryRoot,
        repositoryId: task.repositoryId,
        sourceIssue: task.sourceIssue,
        goal: task.goal,
        instructions: task.instructions,
        priority: task.priority,
        maxRetries: task.maxRetries,
        providerModelRoutingSnapshot: task.providerModelRoutingSnapshot,
        permissionProfile: task.permissionProfile,
        // Task-Scoped Autonomy V1 — a retry inherits the original task's
        // frozen autonomy mode; see the matching comment in
        // AgentPanel.retryBlockedAttempt.
        autonomyMode: task.autonomyMode,
        validationRequirements: task.validationRequirements,
        deliveryPolicy: task.deliveryPolicy,
        notificationPolicy: task.notificationPolicy,
        githubDelivery: task.githubDelivery,
      });
      vscode.window.showInformationMessage(`Retry queued: ${retry.taskId}`);
      runtime.wake();
    }),
    vscode.commands.registerCommand('ollama-agent.continuePreviousTask', async () => {
      const tasks = await listResumableAutonomousTasks(workspaceRoot);
      const picked = await pickTask(tasks, 'Continue Previous Task');
      if (!picked) return;
      const pickedTask = await queue.get(picked);
      if (!pickedTask || !isValidAutonomousTransition(pickedTask.state, 'queued')) {
        vscode.window.showWarningMessage(`Task cannot be continued from its current state${pickedTask ? ` (${pickedTask.state})` : ''}.`);
        return;
      }
      await queue.transition(picked, 'queued', { requestedBy: 'continue' });
      runtime.wake();
    }),
    vscode.commands.registerCommand('ollama-agent.sendFollowUpInstruction', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const content = await vscode.window.showInputBox({ title: 'Follow-Up Instruction', prompt: 'Bounded follow-up instruction' });
      if (!content) return;
      await queue.addFollowUp(selected, content);
      vscode.window.showInformationMessage(`Follow-up saved for ${selected}.`);
    }),
    vscode.commands.registerCommand('ollama-agent.scheduleTask', async () => {
      const goal = await vscode.window.showInputBox({ title: 'Schedule Task', prompt: 'Bounded task goal' });
      if (!goal) return;
      const minutes = await vscode.window.showInputBox({ title: 'Schedule Task', prompt: 'Run after minutes', value: '15' });
      if (!minutes) return;
      const delay = Number(minutes);
      if (!Number.isFinite(delay) || delay < 0) return;
      try {
        const task = await queue.enqueue({
          ...createDefaultAutonomousTask(workspaceRoot, goal),
          scheduledAt: new Date(Date.now() + delay * 60_000).toISOString(),
          schedule: { enabled: true, timezone: 'UTC', occurrence: 1, overduePolicy: 'enqueue-on-activation' },
        });
        vscode.window.showInformationMessage(`Task scheduled: ${task.taskId}`);
      } catch (error) {
        if (error instanceof AutonomousTaskInputTooLargeError) {
          vscode.window.showErrorMessage(`Task text is ${error.utf8ByteCount} UTF-8 bytes; the limit is ${error.limitBytes}. Shorten it and try again.`);
          return;
        }
        throw error;
      }
    }),
    vscode.commands.registerCommand('ollama-agent.manageScheduledTasks', async () => {
      const tasks = (await queue.list()).filter(task => task.schedule);
      await showTaskPick(tasks.map(task => ({ label: task.goal, description: task.state, detail: task.scheduledAt ?? task.taskId })), 'Scheduled M15 Tasks');
    }),
    vscode.commands.registerCommand('ollama-agent.showMergeReadiness', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task) return;
      const report = await new MergeReadinessService().report(task);
      await vscode.window.showQuickPick([
        `Merge ready: ${report.mergeReady}`,
        `Blocking failures: ${report.blockingFailures.join(', ') || 'none'}`,
        `CI: ${report.ciStatus}`,
        `Review: ${report.reviewStatus}`,
        'Automatic merge: unavailable',
      ].map(label => ({ label })), { title: 'M15 Merge Readiness' });
    }),
    vscode.commands.registerCommand('ollama-agent.openDraftPullRequest', async (taskId?: string) => {
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      const url = task?.githubDelivery.pullRequestUrl;
      if (!url) {
        vscode.window.showInformationMessage('No draft pull request recorded for this task.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
  );
  return runtime;
}

async function resolveTaskId(queue: DurableTaskQueue, taskId?: string): Promise<string | undefined> {
  if (typeof taskId === 'string' && taskId) return taskId;
  return pickTask(await queue.list(), 'Select M15 Task');
}

async function pickTask(tasks: Array<{ taskId: string; goal: string; state: string }>, title: string): Promise<string | undefined> {
  const selected = await vscode.window.showQuickPick(tasks.map(task => ({
    label: task.goal,
    description: task.state,
    detail: task.taskId,
    taskId: task.taskId,
  })), { title });
  return selected?.taskId;
}

async function showTaskPick(items: Array<{ label: string; description?: string; detail?: string }>, title: string): Promise<void> {
  if (items.length === 0) {
    vscode.window.showInformationMessage('No M15 tasks found.');
    return;
  }
  await vscode.window.showQuickPick(items, { title });
}
