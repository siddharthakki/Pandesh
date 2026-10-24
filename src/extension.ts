import * as path from 'path';
import { RuntimeIntelligence } from './runtimeProfile/RuntimeIntelligence';
import * as vscode from 'vscode';
import { registerViews } from './activation/registerViews';
import { registerCommands } from './activation/registerCommands';
import { StatusBarController } from './ui/StatusBarController';
import { TaskStore } from './agent/TaskStore';
import { TaskRecovery } from './agent/TaskRecovery';
import { Logger } from './services/Logger';
import { AutonomousTaskRuntime } from './activation/M15AutonomousRuntime';
import {
  M22_DAILY_COMMAND,
  M22EngineeringOrganizationController,
  M22_PROVISION_COMMAND,
  M22_RUN_SPRINT_COMMAND,
  M22_STATUS_COMMAND,
  M22_SYNC_COMMAND,
} from './activation/M22EngineeringOrganizationController';
import { LocalBoardPanel, SHOW_LOCAL_BOARD_COMMAND } from './ui/LocalBoardPanel';
import { CoreManager } from './core-client/CoreManager';
import { migrateLegacyBoardIfPresent } from './core-client/legacyMigration';
import { ensureGitExclude } from './util/ensureGitExclude';
import { OnboardingPanel, SHOW_SETUP_READINESS_COMMAND } from './onboarding/OnboardingPanel';
import { OnboardingService } from './onboarding/OnboardingService';
import { PreviewService, isPreviewablePath } from './preview/PreviewService';
import { OPEN_PREVIEW_COMMAND, OPEN_PREVIEW_EXTERNAL_COMMAND } from './preview/PreviewOffer';
import { runCloudFallbackSetup } from './onboarding/OnboardingCloudFallbackSetup';
import { runOrcaRouterRemoval, runOrcaRouterSetup } from './onboarding/OnboardingOrcaRouterSetup';
import { orcaRouterServiceFor, type OrcaRouterCoreSink } from './providers/OrcaRouter';
import { registerCapability } from './onboarding/CapabilityRegistry';
import { cloudProviderServiceFor, hydrateProviderCatalog, refreshProviderCatalogFromRemote, type CloudCoreSink } from './providers/CloudProviders';

import { startupTelemetry } from './services/StartupTelemetry';
import { discoverWorkspaceDescriptor } from './workspace/WorkspaceDiscovery';
import { ensureGitOnboardingDecision } from './workspace/GitOnboarding';
import { WorkspaceRegistry } from './workspace/WorkspaceRegistry';

export const RESTART_CORE_COMMAND = 'ollama-agent.restartKarkeDikhaCore';

/**
 * Persisted-once flag: onboarding auto-opens on the first meaningful
 * activation of a given extension install, then only via the manual command
 * below. Global (not workspace) scoped, since it's an install-level
 * "have you seen this" marker, not per-project state.
 */
const ONBOARDING_SHOWN_KEY = 'ollama-agent.onboarding.shownV1';

let coreManager: CoreManager | undefined;
let workspaceRegistry: WorkspaceRegistry | undefined;

/**
 * All classified workspace roots and their discovered capabilities
 * (languages, package managers, Docker, nested repos, ...), populated in the
 * background shortly after activation. Undefined until that background pass
 * completes or if no workspace is open; callers that need a root right away
 * should keep using their existing single-root parameter and treat this as
 * an additive, root-aware lookup for callers that want it.
 */
export function getWorkspaceRegistry(): WorkspaceRegistry | undefined {
  return workspaceRegistry;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  startupTelemetry.mark('activate_start');
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspaceAvailable = Boolean(workspaceFolder);
  const storageRoot = workspaceFolder?.uri.fsPath
    ?? context.globalStorageUri?.fsPath
    ?? context.storageUri?.fsPath
    ?? process.cwd();

  // M47: learn what each model actually does on its runtime (bounded probe, cached across restarts). Kill switch:
  // OLLAMA_AGENT_RUNTIME_PROBE=0. A model with no entry is accepted and probed, never rejected for being unknown.
  RuntimeIntelligence.configureShared({
    enabled: process.env.OLLAMA_AGENT_RUNTIME_PROBE !== '0',
    storePath: path.join(context.globalStorageUri?.fsPath ?? storageRoot, 'runtime-profiles.json'),
  });

  const statusBar = new StatusBarController();
  context.subscriptions.push({ dispose: () => statusBar.dispose() });

  // M40: exclude `.ollama-agent/` (extension-local state) from `git status`
  // in the user's workspace via `.git/info/exclude`, without touching their
  // committed `.gitignore`. Runs once per activation; guarded so a failure
  // (e.g. read-only filesystem) never blocks activation.
  if (workspaceFolder?.uri.fsPath) {
    void ensureGitExclude(workspaceFolder.uri.fsPath, (msg, ...args) => Logger.warn(msg, ...args));
  }

  // M44.1: classify every workspace root (not just workspaceFolders[0]) so a
  // plain (non-Git), empty, or nested-repo root is recognized rather than
  // silently dropped or forced to fail as "not a git repository." The one-shot
  // Git onboarding offer runs in the background — it never blocks activation
  // or command execution, and it never auto-initializes Git without the user
  // picking that option.
  void (async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return;
    try {
      const descriptor = await discoverWorkspaceDescriptor(folders.map(folder => ({ path: folder.uri.fsPath })));
      if (!descriptor) return;
      if (descriptor.roots.length > 1) {
        Logger.info(`[Workspace] ${descriptor.roots.length} workspace roots detected; using "${descriptor.primaryRoot.path}" as primary for single-root flows.`);
      }
      workspaceRegistry = await WorkspaceRegistry.build(descriptor);
      if (descriptor.primaryRoot.kind !== 'git') {
        await ensureGitOnboardingDecision(context, descriptor.primaryRoot);
      }
    } catch (error) {
      Logger.warn('[Workspace] root discovery failed; continuing with default single-root behavior.', error);
    }
  })();

  // Shell-first activation: Register AgentPanel and webview views immediately.
  // The composer shell is visible right away without blocking on Core bootstrap.
  const agentPanel = registerViews(context, storageRoot, workspaceAvailable);
  startupTelemetry.mark('views_registered');

  // Single window-scoped CoreManager instance
  coreManager = new CoreManager(context);
  context.subscriptions.push(coreManager);

  // Wire CoreManager to AgentPanel so AgentPanel can rehydrate idempotently
  // whenever Core connects, without race conditions or lost state.
  agentPanel.bindCoreManager(coreManager);

  // Start Core asynchronously in the background
  startupTelemetry.mark('core_start_begin');
  const coreStartPromise = (async () => {
    try {
      await coreManager!.start();
    } catch (error) {
      Logger.error('[Core] background startup failed:', error);
    }
  })();

  let engineeringController: M22EngineeringOrganizationController | undefined;

  // OrcaRouter (manual cloud models). The credential lives in SecretStorage; Core holds a memory-only copy that
  // is re-delivered whenever Core connects, so setup takes effect immediately and survives a Core restart.
  const orcaRouter = orcaRouterServiceFor(context.secrets);
  const orcaRouterCoreSink = (): OrcaRouterCoreSink | undefined => coreManager?.getClient();
  // The cloud pool generalises this: every connected provider's credential is rehydrated from SecretStorage into
  // Core's memory whenever Core connects, so a reload needs no re-entry.
  const cloudProviders = cloudProviderServiceFor(context.secrets);
  hydrateProviderCatalog(context.globalState);
  const cloudCoreSink = (): CloudCoreSink | undefined => coreManager?.getClient();
  context.subscriptions.push(registerCapability('attachments', () => coreManager?.getStatus().state === 'connected'
    ? { name: 'Attachments', status: 'ok', detail: 'Code & text · Images · PDF/DOCX · Audio — no workspace needed' }
    : { name: 'Attachments', status: 'warn', detail: 'Available once the Core runtime is connected' }));
  context.subscriptions.push(
    coreManager.onStatusChange(status => {
      const sink = status.state === 'connected' ? orcaRouterCoreSink() : undefined;
      if (sink) void orcaRouter.pushToCore(sink);
      const poolSink = status.state === 'connected' ? cloudCoreSink() : undefined;
      if (poolSink) void cloudProviders.pushAllToCore(poolSink);
    }),
    vscode.commands.registerCommand('ollama-agent.setUpOrcaRouter', () => runOrcaRouterSetup(context, { getCore: orcaRouterCoreSink })),
    vscode.commands.registerCommand('ollama-agent.clearOrcaRouter', () => runOrcaRouterRemoval(context, { getCore: orcaRouterCoreSink })),
    vscode.commands.registerCommand('ollama-agent.removeAllCloudCredentials', async () => {
      const choice = await vscode.window.showWarningMessage(
        'Remove ALL cloud provider credentials? Every saved cloud API key is deleted from this machine and from the running Core.',
        { modal: true },
        'Remove all',
      );
      if (choice !== 'Remove all') return;
      await cloudProviders.removeAllCredentials(cloudCoreSink());
      void vscode.window.showInformationMessage('All cloud provider credentials were removed.');
    }),
    vscode.commands.registerCommand('ollama-agent.refreshFreeProviders', async () => {
      const summary = await refreshProviderCatalogFromRemote(context.globalState);
      void vscode.window.showInformationMessage(summary.message);
    }),
  );
  // Core may already be connected by the time the subscription above exists.
  if (coreManager.getStatus().state === 'connected') {
    const sink = orcaRouterCoreSink();
    if (sink) void orcaRouter.pushToCore(sink);
    const poolSink = cloudCoreSink();
    if (poolSink) void cloudProviders.pushAllToCore(poolSink);
  }

  // Setup/Readiness: available immediately, regardless of workspace state —
  // Ollama/model discovery and cloud fallback configuration need no
  // workspace. Registered once here rather than duplicated between
  // registerCommands (workspace) and registerEverydayCommands (no workspace).
  context.subscriptions.push(
    vscode.commands.registerCommand(SHOW_SETUP_READINESS_COMMAND, () =>
      OnboardingPanel.show(
        context,
        new OnboardingService(context.secrets, () => coreManager?.getStatus(), String(context.extension?.packageJSON?.version ?? '0.0.0')),
        () => runCloudFallbackSetup(context),
        // Core starts in the background, so this panel is virtually always
        // opened while Core is still `starting`. Hand it Core's status event
        // so it re-assesses when Core connects instead of staying pinned to
        // the one-shot assessment taken at open time.
        coreManager?.onStatusChange,
        { getCore: cloudCoreSink },
      )),
  );

  // Preview: open a browser-viewable artifact (an index.html the agent just made) in VS Code's own browser, beside the
  // source. Preview is NOT validation: nothing here records or implies a result. See src/preview/PreviewService.ts.
  const previewService = new PreviewService({
    placement: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    executeCommand: (command, ...args) => vscode.commands.executeCommand(command, ...args),
    openExternal: url => vscode.env.openExternal(vscode.Uri.parse(url)),
  });
  context.subscriptions.push({ dispose: () => previewService.dispose() });
  const openPreview = async (target: vscode.Uri | undefined, external: boolean): Promise<void> => {
    const uri = target ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== 'file' || !isPreviewablePath(uri.fsPath)) {
      void vscode.window.showInformationMessage('Open an HTML file in the workspace to preview it.');
      return;
    }
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      void vscode.window.showInformationMessage('Preview needs the file to be inside an open workspace folder.');
      return;
    }
    const result = await previewService.open(folder.uri.fsPath, uri.fsPath, { external });
    if (result.outcome === 'refused') {
      void vscode.window.showInformationMessage(`Cannot preview this file (${result.reason.replace(/_/g, ' ')}).`);
    } else if (result.where === 'external-browser' && result.reason === 'editor_browser_unavailable') {
      void vscode.window.showInformationMessage('The in-editor browser is not available, so the preview opened in your external browser.');
    }
  };
  context.subscriptions.push(
    vscode.commands.registerCommand(OPEN_PREVIEW_COMMAND, (target?: vscode.Uri) => openPreview(target, false)),
    vscode.commands.registerCommand(OPEN_PREVIEW_EXTERNAL_COMMAND, (target?: vscode.Uri) => openPreview(target, true)),
  );

  if (workspaceAvailable) {
    registerCommands(context, agentPanel, statusBar, storageRoot);
    engineeringController = registerEngineeringOrganization(context, storageRoot, agentPanel);
    void runRecoveryScan(storageRoot);
  } else {
    registerEverydayCommands(context, agentPanel);
  }

  context.subscriptions.push(vscode.commands.registerCommand(
    SHOW_LOCAL_BOARD_COMMAND,
    () => LocalBoardPanel.show(context, storageRoot, engineeringController, coreManager),
  ));
  context.subscriptions.push(
    vscode.commands.registerCommand(RESTART_CORE_COMMAND, async () => {
      await coreManager!.restart();
      const status = coreManager!.getStatus();
      if (status.state === 'connected') {
        vscode.window.showInformationMessage('KarkeDikha Core restarted successfully.');
      } else {
        vscode.window.showErrorMessage(`KarkeDikha Core restart did not complete: ${status.detail ?? status.state}`);
      }
    }),
  );

  // Background migration & rehydration: runs when Core connects, never blocking UI
  void coreStartPromise.then(async () => {
    const client = coreManager?.getClient();
    if (client && workspaceAvailable) {
      startupTelemetry.mark('attempt_rehydrate_begin');
      await agentPanel.rehydrateCoreAttempts();
      startupTelemetry.mark('attempt_rehydrate_end');
      await migrateLegacyBoardIfPresent(storageRoot, client, (msg) => Logger.info(`[M31] ${msg}`)).catch((err) =>
        Logger.error('[M31] legacy Board migration failed:', err),
      );
    }
  });

  const message = workspaceAvailable
    ? 'KarkeDikha ready. Open the sidebar to start.'
    : 'KarkeDikha Baat Kar is ready. Open or create a folder when Saath Kar needs a workspace.';
  vscode.window.showInformationMessage(message);

  startupTelemetry.mark('activate_complete');

  await maybeShowOnboardingOnce(context);
}

/**
 * First-run trigger: shows the Setup/Readiness panel once per install, then
 * never again automatically — the command stays available manually. Split
 * out from `activate` so the "shown once" gate itself is directly unit
 * testable against a minimal fake `globalState`, without needing the whole
 * activation sequence (Core startup, view/command registration, etc.).
 */
export async function maybeShowOnboardingOnce(context: vscode.ExtensionContext): Promise<void> {
  const alreadyShown = context.globalState.get<boolean>(ONBOARDING_SHOWN_KEY, false);
  if (alreadyShown) {
    return;
  }
  await context.globalState.update(ONBOARDING_SHOWN_KEY, true);
  void vscode.commands.executeCommand(SHOW_SETUP_READINESS_COMMAND).then(undefined, (err) =>
    Logger.error('[Onboarding] failed to auto-open Setup/Readiness on first run:', err),
  );
}

function registerEverydayCommands(context: vscode.ExtensionContext, agentPanel: ReturnType<typeof registerViews>): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('ollama-agent.openChat', () =>
      vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar')),
    vscode.commands.registerCommand('ollama-agent.focus', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
      await vscode.commands.executeCommand('ollama-agent.chatView.focus');
    }),
    vscode.commands.registerCommand('ollama-agent.showActivity', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
      await vscode.commands.executeCommand('ollama-agent.chatView.focus');
      agentPanel.showActivity();
    }),
    vscode.commands.registerCommand('ollama-agent.stop', () => agentPanel.stop()),
    vscode.commands.registerCommand('ollama-agent.clearSession', () => agentPanel.clearSession()),
  );
}

function registerEngineeringOrganization(
  context: vscode.ExtensionContext,
  workspaceRoot: string,
  agentPanel: ReturnType<typeof registerViews>,
): M22EngineeringOrganizationController | undefined {
  const runtime = context.subscriptions.find(isAutonomousTaskRuntime);
  if (!runtime) {
    Logger.error('[M22] Live autonomous runtime was not registered; engineering organization disabled.');
    return undefined;
  }
  const controller = new M22EngineeringOrganizationController(workspaceRoot, runtime, coreManager!);
  const reconnectAgentPanel = () => agentPanel.attachAutonomous(runtime.getQueue(), runtime);
  controller.start();
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand(M22_PROVISION_COMMAND, () => controller.provision()),
    vscode.commands.registerCommand(M22_RUN_SPRINT_COMMAND, async () => {
      const result = await controller.runSprint();
      reconnectAgentPanel();
      return result;
    }),
    vscode.commands.registerCommand(M22_SYNC_COMMAND, async () => {
      const result = await controller.sync();
      reconnectAgentPanel();
      return result;
    }),
    vscode.commands.registerCommand(M22_STATUS_COMMAND, () => controller.status()),
    vscode.commands.registerCommand(M22_DAILY_COMMAND, () => controller.dailyScrum()),
  );
  return controller;
}

function isAutonomousTaskRuntime(value: vscode.Disposable): value is AutonomousTaskRuntime {
  const candidate = value as Partial<AutonomousTaskRuntime>;
  return typeof candidate.getQueue === 'function'
    && typeof candidate.wake === 'function'
    && typeof candidate.waitForIdle === 'function';
}

async function runRecoveryScan(workspaceRoot: string): Promise<void> {
  try {
    const store = new TaskStore(workspaceRoot);
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();

    if (candidates.length === 0) { return; }

    const count = candidates.length;
    const interrupted = candidates.filter(c => c.interruptionKind).length;

    Logger.info(`[Recovery] Found ${count} incomplete task(s), ${interrupted} interrupted.`);

    if (interrupted > 0) {
      const action = await vscode.window.showWarningMessage(
        `KarkeDikha: ${interrupted} task(s) were interrupted unexpectedly. Check the sidebar to resume, rollback, or cancel.`,
        'Show Tasks',
        'Dismiss',
      );
      if (action === 'Show Tasks') {
        vscode.commands.executeCommand('workbench.view.extension.ollama-agent-sidebar');
      }
    }
  } catch (e) {
    Logger.error('[Recovery] Activation scan failed:', e);
  }
}

export function getCoreManager(): CoreManager | undefined {
  return coreManager;
}

export function deactivate(): void {
  // Cleanup handled by context.subscriptions. CoreManager.dispose() (registered above) only
  // disconnects this window's CoreClient — the KarkeDikha Core process itself is a standalone
  // process (M31) and must keep running for any other open VS Code window.
  coreManager = undefined;
}
