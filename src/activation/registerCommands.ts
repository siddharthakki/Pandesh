import * as vscode from 'vscode';
import * as path from 'path';
import { AgentPanel } from '../ui/AgentPanel';
import { StatusBarController } from '../ui/StatusBarController';
import { CheckpointManager } from '../agent/CheckpointManager';
import { TaskStore } from '../agent/TaskStore';
import { TaskRecovery } from '../agent/TaskRecovery';
import { createWorkspaceDiagnostics } from '../diagnostics/SelfDiagnostics';
import {
  GovernedForgeDemoController,
  RUN_GOVERNED_FORGE_DEMO_COMMAND,
} from './GovernedForgeDemoController';
import {
  CONFIGURE_PROVIDER_MODEL_COMMAND,
  ConfigureProviderModelController,
} from './ConfigureProviderModelController';
import {
  RUN_FORGE_CODING_TASK_COMMAND,
  RUN_FORGE_READINESS_CHECK_COMMAND,
  ForgeCodingTaskController,
} from './ForgeCodingTaskController';
import { ProviderReadinessProbe } from '../diagnostics/ProviderReadiness';
import { M14Platform, TrustState } from '../platform/M14Platform';
import { registerM15AutonomousCommands } from './M15AutonomousCommands';
import { registerM16EvaluationCommands } from './M16EvaluationCommands';
import { GovernedCodingExecutor } from '../coding/GovernedCodingExecutor';
import { ProviderGateway } from '../providers/ProviderGateway';
import { Config } from '../config/Config';

export function registerCommands(
  context: vscode.ExtensionContext,
  agentPanel: AgentPanel,
  statusBar: StatusBarController,
  workspaceRoot: string,
): void {
  const governedForgeDemo = new GovernedForgeDemoController(context, workspaceRoot);
  const configureProviderModel = new ConfigureProviderModelController(
    ProviderReadinessProbe.forSecrets(context.secrets),
  );
  const governedCodingExecutor = new GovernedCodingExecutor();
  const forgeCodingTask = new ForgeCodingTaskController(context, workspaceRoot, governedCodingExecutor);
  const platform = new M14Platform({
    workspaceRoot,
    userRoot: context.globalStorageUri?.fsPath ?? context.storageUri?.fsPath ?? path.join(workspaceRoot, '.ollama-agent', 'user-platform'),
  });
  const autonomousRuntime = registerM15AutonomousCommands(
    context,
    workspaceRoot,
    goal => agentPanel.startAutonomousTask(goal),
    governedCodingExecutor,
  );
  agentPanel.attachAutonomous?.(autonomousRuntime.getQueue(), autonomousRuntime);
  registerM16EvaluationCommands(context, workspaceRoot);
  context.subscriptions.push(
    governedForgeDemo,
    configureProviderModel,
    forgeCodingTask,
    vscode.commands.registerCommand(CONFIGURE_PROVIDER_MODEL_COMMAND, () => configureProviderModel.run()),
    // M42 consent boundary: the cloud fallback credential lives in VS Code
    // SecretStorage under its own key, never in settings, and is entered only
    // through this explicit command. Without it, ProviderGateway reports the
    // cloud route unavailable and routing stays local-only.
    vscode.commands.registerCommand('ollama-agent.setCloudFallbackApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'KarkeDikha cloud fallback API key',
        prompt: `Stored in VS Code SecretStorage. Repository and task context is sent to ${Config.getCloudFallbackApiBase() || '(no endpoint configured)'} only when ollama-agent.modelRoutingPolicy is 'local-first-cloud-fallback'.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (!key.trim()) {
        vscode.window.showWarningMessage('No cloud fallback API key was stored.');
        return;
      }
      await ProviderGateway.storeCloudFallbackApiKey(context.secrets, key.trim());
      vscode.window.showInformationMessage('Cloud fallback API key stored.');
    }),
    vscode.commands.registerCommand('ollama-agent.clearCloudFallbackApiKey', async () => {
      await ProviderGateway.deleteCloudFallbackApiKey(context.secrets);
      vscode.window.showInformationMessage('Cloud fallback API key cleared. Model routing is local-only until a new key is stored.');
    }),
    // Mirrors setCloudFallbackApiKey above, for the PRIMARY provider — the
    // credential ProviderGateway.create() reads for providerType
    // 'openai-compatible' (e.g. a direct cloud endpoint used as the primary
    // provider, not the M42 fallback route). Deliberately a distinct
    // SecretStorage key (see ProviderGateway's SECRET_KEY vs
    // CLOUD_FALLBACK_SECRET_KEY) and a separate command — ProviderGateway.create()
    // and storeApiKey/deleteApiKey already existed; only the interactive entry
    // point was missing.
    vscode.commands.registerCommand('ollama-agent.setApiKey', async () => {
      const key = await vscode.window.showInputBox({
        title: 'KarkeDikha primary provider API key',
        prompt: `Stored in VS Code SecretStorage. Sent to ${Config.getApiBase() || '(no endpoint configured)'} whenever ollama-agent.providerType is 'openai-compatible'.`,
        password: true,
        ignoreFocusOut: true,
      });
      if (key === undefined) return;
      if (!key.trim()) {
        vscode.window.showWarningMessage('No primary provider API key was stored.');
        return;
      }
      await ProviderGateway.storeApiKey(context.secrets, key.trim());
      vscode.window.showInformationMessage('Primary provider API key stored.');
    }),
    vscode.commands.registerCommand('ollama-agent.clearApiKey', async () => {
      await ProviderGateway.deleteApiKey(context.secrets);
      vscode.window.showInformationMessage('Primary provider API key cleared.');
    }),
    vscode.commands.registerCommand(RUN_GOVERNED_FORGE_DEMO_COMMAND, () => governedForgeDemo.run()),
    vscode.commands.registerCommand(RUN_FORGE_CODING_TASK_COMMAND, (task?: string) => forgeCodingTask.run(task)),
    vscode.commands.registerCommand(RUN_FORGE_READINESS_CHECK_COMMAND, () => forgeCodingTask.runReadinessCheck()),
    vscode.commands.registerCommand('ollama-agent.rebuildRepositoryIntelligence', () => agentPanel.rebuildRepositoryIntelligence()),
    vscode.commands.registerCommand('ollama-agent.pauseRepositoryIndexing', () => agentPanel.pauseRepositoryIndexing()),
    vscode.commands.registerCommand('ollama-agent.resumeRepositoryIndexing', () => agentPanel.resumeRepositoryIndexing()),
    vscode.commands.registerCommand('ollama-agent.showRepositoryIntelligenceStatus', () => agentPanel.postRepositoryIntelligenceStatus()),
    vscode.commands.registerCommand('ollama-agent.pinCurrentFileForTask', () => agentPanel.pinCurrentFileForTask()),
    vscode.commands.registerCommand('ollama-agent.excludePathFromRetrieval', () => agentPanel.excludePathFromRetrieval()),
    vscode.commands.registerCommand('ollama-agent.reloadAgentPlatformConfiguration', async () => {
      await platform.reload();
      vscode.window.showInformationMessage('KarkeDikha platform configuration reloaded.');
    }),
    vscode.commands.registerCommand('ollama-agent.showEffectiveInstructions', async () => {
      const effective = await platform.resolveInstructions();
      await vscode.window.showQuickPick(effective.sources.map(source => ({
        label: source.identity,
        description: `${source.sourceScope} precedence ${source.precedence}`,
        detail: `fingerprint=${source.fingerprint} bytes=${source.bytes}`,
      })), { title: 'Effective Instructions (sanitized sources)' });
    }),
    vscode.commands.registerCommand('ollama-agent.listAgentProfiles', async () => {
      const profiles = await platform.listAgentProfiles();
      await vscode.window.showQuickPick(profiles.map(profile => ({
        label: profile.displayName,
        description: profile.id,
        detail: `${profile.sourceScope ?? 'builtin'} | role=${profile.baseRole} | model=${profile.model ?? '(default)'}`,
      })), { title: 'KarkeDikha Profiles' });
    }),
    vscode.commands.registerCommand('ollama-agent.selectAgentProfile', async () => {
      const profiles = await platform.listAgentProfiles();
      const selected = await vscode.window.showQuickPick(profiles.map(profile => ({
        label: profile.displayName,
        description: profile.id,
        profile,
      })), { title: 'Select KarkeDikha Profile' });
      if (selected) vscode.window.showInformationMessage(`Selected profile for this session: ${selected.profile.id}`);
    }),
    vscode.commands.registerCommand('ollama-agent.listSkills', async () => {
      const skills = await platform.listSkills();
      await vscode.window.showQuickPick(skills.map(skill => ({
        label: skill.manifest.displayName,
        description: skill.manifest.id,
        detail: `${skill.sourceScope} | fingerprint=${skill.instructionsFingerprint}`,
      })), { title: 'KarkeDikha Skills' });
    }),
    vscode.commands.registerCommand('ollama-agent.runSkill', async () => {
      const skills = await platform.listSkills();
      const selected = await vscode.window.showQuickPick(skills.map(skill => ({
        label: skill.manifest.displayName,
        description: skill.manifest.id,
        skill,
      })), { title: 'Run KarkeDikha Skill' });
      if (!selected) return;
      const result = await platform.runSkill(selected.skill.manifest.id, {});
      vscode.window.showInformationMessage(result.status === 'ready' ? `Skill ready: ${selected.skill.manifest.id}` : `Skill blocked: ${result.reason}`);
    }),
    vscode.commands.registerCommand('ollama-agent.listSlashCommands', async () => {
      const commands = await platform.listSlashCommands();
      await vscode.window.showQuickPick(commands.map(command => ({
        label: command.id,
        description: command.description,
        detail: `${command.sourceScope} | enabled=${command.enabled}`,
      })), { title: 'KarkeDikha Slash Commands' });
    }),
    vscode.commands.registerCommand('ollama-agent.listMcpServers', async () => {
      const servers = await platform.listMcpServers();
      await vscode.window.showQuickPick(servers.map(server => ({
        label: server.displayName ?? server.id,
        description: `${server.transport} | ${server.trustState}`,
        detail: server.command ?? server.url ?? '(not configured)',
      })), { title: 'KarkeDikha MCP Servers' });
    }),
    vscode.commands.registerCommand('ollama-agent.refreshMcpServers', async () => {
      await platform.reload();
      const servers = await platform.listMcpServers();
      vscode.window.showInformationMessage(`MCP discovery refreshed: ${servers.length} configured server(s).`);
    }),
    vscode.commands.registerCommand('ollama-agent.manageMcpTrust', async () => {
      const servers = await platform.listMcpServers();
      const selected = await vscode.window.showQuickPick(servers.map(server => ({
        label: server.displayName ?? server.id,
        description: server.trustState,
        server,
      })), { title: 'Manage MCP Trust' });
      if (!selected) return;
      const state = await vscode.window.showQuickPick(['trusted-readonly', 'trusted-governed', 'untrusted'] satisfies TrustState[], { title: `Trust ${selected.server.id}` });
      if (!state) return;
      platform.trustMcpServer(selected.server.id, state as TrustState);
      vscode.window.showInformationMessage(`MCP trust updated: ${selected.server.id} -> ${state}`);
    }),
    vscode.commands.registerCommand('ollama-agent.startLocalForgeMcpServer', () => {
      vscode.window.showInformationMessage(`Local Forge MCP server status: ${JSON.stringify(platform.forgeStatus())}`);
    }),
    vscode.commands.registerCommand('ollama-agent.stopLocalForgeMcpServer', () => {
      vscode.window.showInformationMessage('Local Forge MCP server stopped.');
    }),
    vscode.commands.registerCommand('ollama-agent.listLocalExtensions', async () => {
      const extensions = await platform.listLocalExtensions();
      await vscode.window.showQuickPick(extensions.map(extension => ({
        label: extension.displayName ?? extension.id,
        description: `${extension.sourceScope} | enabled=${extension.enabled}`,
        detail: `fingerprint=${extension.manifestFingerprint}`,
      })), { title: 'KarkeDikha Local Extensions' });
    }),
    vscode.commands.registerCommand('ollama-agent.manageLocalExtensions', async () => {
      const extensions = await platform.listLocalExtensions();
      const selected = await vscode.window.showQuickPick(extensions.map(extension => ({
        label: extension.displayName ?? extension.id,
        description: `${extension.sourceScope} | enabled=${extension.enabled}`,
      })), { title: 'Manage Local Extensions' });
      if (selected) vscode.window.showInformationMessage(`Extension selected: ${selected.label}`);
    }),
    vscode.commands.registerCommand('ollama-agent.runM14Diagnostics', async () => {
      await platform.resolveInstructions();
      await platform.listSkills();
      await platform.listSlashCommands();
      await platform.listAgentProfiles();
      await platform.listMcpServers();
      await platform.listLocalExtensions();
      const diagnostics = platform.getDiagnostics();
      await vscode.window.showQuickPick(diagnostics.map(diagnostic => ({
        label: `$(${diagnostic.severity === 'error' ? 'error' : diagnostic.severity === 'warning' ? 'warning' : 'info'}) ${diagnostic.code}`,
        description: diagnostic.source,
        detail: diagnostic.message,
      })), { title: diagnostics.length ? 'M14 Diagnostics' : 'M14 Diagnostics - healthy' });
    }),

    vscode.commands.registerCommand('ollama-agent.openChat', () => {
      vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
    }),

    vscode.commands.registerCommand('ollama-agent.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
      await vscode.commands.executeCommand('ollama-agent.chatView.focus');
    }),

    vscode.commands.registerCommand('ollama-agent.showActivity', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
      await vscode.commands.executeCommand('ollama-agent.chatView.focus');
      agentPanel.showActivity();
    }),

    vscode.commands.registerCommand('ollama-agent.runDiagnostics', async () => {
      const diagnostics = createWorkspaceDiagnostics(workspaceRoot, {
        secrets: context.secrets,
      });
      const report = await diagnostics.run();
      const items = report.findings.map(finding => ({
        label: `$(${finding.status === 'healthy' ? 'pass' : finding.status === 'degraded' ? 'warning' : 'error'}) ${finding.summary}`,
        description: finding.status,
        detail: finding.detail,
        repairId: finding.repairId,
      }));
      const selected = await vscode.window.showQuickPick(items, {
        title: report.healthy ? 'KarkeDikha diagnostics — healthy' : 'KarkeDikha diagnostics — attention required',
        placeHolder: 'Select a finding to inspect or repair',
      });
      if (!selected?.repairId) { return; }
      const approval = await vscode.window.showWarningMessage(
        `Run approved repair "${selected.repairId}"? Repairs are confined to .ollama-agent runtime state.`,
        { modal: true },
        'Repair',
      );
      if (approval !== 'Repair') { return; }
      const result = await diagnostics.repair(selected.repairId, true);
      if (result.status === 'completed') {
        vscode.window.showInformationMessage(result.summary);
      } else {
        vscode.window.showErrorMessage(result.error ?? result.summary);
      }
    }),

    vscode.commands.registerCommand('ollama-agent.stop', () => {
      agentPanel.stop();
    }),

    vscode.commands.registerCommand('ollama-agent.clearSession', () => {
      agentPanel.clearSession();
    }),

    vscode.commands.registerCommand('ollama-agent.showCheckpoints', async () => {
      const cpManager = new CheckpointManager(workspaceRoot);
      const checkpoints = await cpManager.listCheckpoints();

      if (checkpoints.length === 0) {
        vscode.window.showInformationMessage('No checkpoints found.');
        return;
      }

      const items = checkpoints.map((cp) => ({
        label: cp.id,
        description: cp.timestamp,
        detail: `${cp.reason} — ${cp.files.length} file(s) — Model: ${cp.model}`,
      }));

      await vscode.window.showQuickPick(items, { title: 'KarkeDikha Checkpoints' });
    }),

    vscode.commands.registerCommand('ollama-agent.rewindLastCheckpoint', async () => {
      const confirm = await vscode.window.showWarningMessage(
        'Rewind last checkpoint? This will restore files to their state before the last agent mutation.',
        { modal: true },
        'Rewind',
      );

      if (confirm !== 'Rewind') { return; }

      const cpManager = new CheckpointManager(workspaceRoot);
      const result = await cpManager.rewindLastCheckpoint();

      if (!result) {
        vscode.window.showInformationMessage('No checkpoint to rewind.');
        return;
      }

      vscode.window.showInformationMessage(
        `Rewound checkpoint ${result.id}. Restored: ${result.restored.join(', ')}`,
      );
    }),

    vscode.commands.registerCommand('ollama-agent.openWebChat', () => {
      vscode.window.showInformationMessage('Web chat interface is not enabled in this build.');
    }),

    vscode.commands.registerCommand('ollama-agent.showTasks', async () => {
      const store = new TaskStore(workspaceRoot);
      const tasks = await store.listTasks();

      if (tasks.length === 0) {
        vscode.window.showInformationMessage('No persisted tasks found.');
        return;
      }

      const items = tasks.map(t => ({
        label: `$(${statusIcon(t.status)}) ${t.title ?? t.taskId}`,
        description: t.status,
        detail: `Created: ${new Date(t.createdAt).toLocaleString()} | Model: ${t.model}`,
        taskId: t.taskId,
        status: t.status,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'KarkeDikha — Persisted Tasks',
        placeHolder: 'Select a task to manage',
      });

      if (!selected) { return; }
      await manageTask(selected.taskId, selected.status, store);
    }),

    vscode.commands.registerCommand('ollama-agent.showIncompleteTasks', async () => {
      const store = new TaskStore(workspaceRoot);
      const recovery = new TaskRecovery(store);
      const candidates = await recovery.scan();

      if (candidates.length === 0) {
        vscode.window.showInformationMessage('No incomplete tasks found. All tasks are in a terminal state.');
        return;
      }

      const items = candidates.map(c => ({
        label: `$(warning) ${c.task.title ?? c.taskId}`,
        description: `${c.task.status} — ${c.interruptionKind ?? 'incomplete'}`,
        detail: c.issues.length > 0 ? c.issues[0] : `Last event seq: ${c.totalEventSeq}`,
        taskId: c.taskId,
        status: c.task.status,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: 'KarkeDikha — Incomplete Tasks',
        placeHolder: 'Select a task to manage',
      });

      if (!selected) { return; }
      await manageTask(selected.taskId, selected.status, store);
    }),
  );
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': return 'check';
    case 'failed': return 'error';
    case 'cancelled': return 'circle-slash';
    case 'running': return 'sync~spin';
    case 'waiting_for_approval': return 'question';
    case 'blocked': return 'warning';
    case 'recovering': return 'refresh';
    case 'paused': return 'debug-pause';
    default: return 'circle-outline';
  }
}

async function manageTask(taskId: string, status: string, store: TaskStore): Promise<void> {
  const isRecoverable = status === 'blocked' || status === 'recovering' || status === 'paused';
  const options: string[] = [];

  if (isRecoverable) { options.push('Inspect events'); }
  options.push('Show checkpoints');
  if (status !== 'completed' && status !== 'cancelled') {
    options.push('Cancel task');
  }
  options.push('Archive task');
  options.push('Delete task (irreversible)');

  const action = await vscode.window.showQuickPick(options, {
    title: `Task ${taskId} (${status})`,
    placeHolder: 'Choose action',
  });

  if (!action) { return; }

  if (action === 'Cancel task') {
    await store.updateTaskStatus(taskId, 'cancelled', { cancelledAt: new Date().toISOString() });
    await store.appendEvent(taskId, 'task_cancelled', { reason: 'Cancelled by user from task manager' });
    await store.writeSnapshot(taskId);
    vscode.window.showInformationMessage(`Task ${taskId} cancelled.`);
  } else if (action === 'Archive task') {
    await store.archiveTask(taskId);
    vscode.window.showInformationMessage(`Task ${taskId} archived.`);
  } else if (action === 'Delete task (irreversible)') {
    const confirm = await vscode.window.showWarningMessage(
      `Delete task ${taskId} and all its history? This cannot be undone.`,
      { modal: true },
      'Delete',
    );
    if (confirm === 'Delete') {
      await store.deleteTask(taskId);
      vscode.window.showInformationMessage(`Task ${taskId} deleted.`);
    }
  } else if (action === 'Show checkpoints') {
    const refs = await store.getCheckpointRefs(taskId);
    if (refs.length === 0) {
      vscode.window.showInformationMessage('No checkpoints for this task.');
    } else {
      const cpItems = refs.map(r => ({
        label: r.checkpointId,
        description: r.toolName,
        detail: `${r.timestamp} | paths: ${r.affectedPaths.join(', ')}`,
      }));
      await vscode.window.showQuickPick(cpItems, { title: `Checkpoints for ${taskId}` });
    }
  } else if (action === 'Inspect events') {
    const { events } = await store.getEvents(taskId);
    if (events.length === 0) {
      vscode.window.showInformationMessage('No events recorded for this task.');
    } else {
      const evItems = events.map(e => ({
        label: `[${e.seq}] ${e.type}`,
        description: e.timestamp,
        detail: JSON.stringify(e.payload).slice(0, 100),
      }));
      await vscode.window.showQuickPick(evItems, { title: `Events for ${taskId}` });
    }
  }
}
