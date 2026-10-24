import * as crypto from 'crypto';
import * as vscode from 'vscode';
import { OnboardingService } from './OnboardingService';
import { OnboardingReadiness, ONBOARDING_MODES, OnboardingModeId } from './OnboardingReadiness';
import { renderSetupHtml, SetupNotice, SetupConnectState, formatContext } from './OnboardingView';
import { buildDiagnosticsText } from './OnboardingDiagnostics';
import { Logger } from '../services/Logger';
import { Config } from '../config/Config';
import {
  cloudProviderServiceFor,
  refreshProviderCatalogFromRemote,
  sharedProviderCatalog,
  type CloudCoreSink,
} from '../providers/CloudProviders';
import { openProviderKeysPage, readKeyFromClipboardOnClick } from '../providers/ProviderConnection';

export const SHOW_SETUP_READINESS_COMMAND = 'ollama-agent.showSetupReadiness';

export interface OnboardingPanelDeps {
  /** The live Core client sink, when connected. Credentials are delivered to Core in memory through it. */
  getCore?: () => CloudCoreSink | undefined;
}

const OLLAMA_DOWNLOAD_URL = 'https://ollama.com/download';
/** Above this an explicit context budget is confirmed first: it costs memory and slows every request. */
const LARGE_CONTEXT_CONFIRM_TOKENS = 32_768;

/**
 * The single onboarding/readiness/configuration surface: "Is KarkeDikha ready? What's missing? Which model does
 * each mode use, and can I change it? Is anything allowed to go to the cloud? Which build is this?" One compact
 * webview panel, not a multi-screen wizard — re-checking re-runs the same real production discovery/selection path
 * (`OnboardingService.assess`), never a cached or hardcoded snapshot.
 *
 * Opening or refreshing this panel contacts only the configured local provider. Nothing here ever contacts a cloud
 * endpoint; the only cloud-touching action is the explicit "Configure cloud fallback" flow the user starts.
 */
export class OnboardingPanel implements vscode.Disposable {
  private static current?: OnboardingPanel;
  private readonly panel: vscode.WebviewPanel;
  private disposed = false;
  private loading = true;
  private lastReadiness?: OnboardingReadiness;
  private notice?: SetupNotice;
  private readonly openSections = new Set<string>();
  /**
   * Monotonic assessment generation. `assess()` is async, so a refresh
   * triggered by an early Core status (`starting`) can still be in flight
   * when a later one (`connected`) triggers its own refresh. Without this
   * guard the slower, older assessment would resolve last and overwrite the
   * newer READY state with a stale STARTING one. Only the newest generation
   * is ever allowed to publish.
   */
  private assessmentGeneration = 0;
  private coreStatusSubscription?: vscode.Disposable;
  /** The open Connect panel, if any. Holds no secret. */
  private connect?: SetupConnectState;
  /** A key pasted from the clipboard. Lives only in this host process until Save & test or Cancel; never rendered. */
  private stagedKey?: string;

  static async show(
    context: vscode.ExtensionContext,
    service: OnboardingService,
    onSetUpCloudFallback: () => Promise<void>,
    onCoreStatusChange?: vscode.Event<unknown>,
    deps: OnboardingPanelDeps = {},
  ): Promise<OnboardingPanel> {
    Logger.info('[Onboarding] OnboardingPanel.show() called');
    if (this.current) {
      Logger.info('[Onboarding] reusing existing panel instance');
      this.current.panel.reveal(vscode.ViewColumn.One);
      await this.current.refresh();
      return this.current;
    }
    const panel = vscode.window.createWebviewPanel(
      'ollama-agent.setupReadiness',
      'KarkeDikha Setup',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    Logger.info('[Onboarding] createWebviewPanel returned');
    const instance = new OnboardingPanel(panel, context, service, onSetUpCloudFallback, onCoreStatusChange, deps);
    this.current = instance;
    context.subscriptions.push(instance);
    await instance.refresh();
    Logger.info('[Onboarding] initial refresh() completed');
    return instance;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly service: OnboardingService,
    private readonly onSetUpCloudFallback: () => Promise<void>,
    onCoreStatusChange?: vscode.Event<unknown>,
    private readonly deps: OnboardingPanelDeps = {},
  ) {
    this.panel = panel;
    panel.onDidDispose(() => this.dispose(), undefined, context.subscriptions);
    panel.webview.onDidReceiveMessage(message => void this.handleMessage(message), undefined, context.subscriptions);
    // Core is started in the background and is still `starting` when this
    // panel first renders on activation, so the one-shot assessment taken at
    // show() time always reports "Core runtime starting". Without this
    // subscription nothing ever re-assesses and the panel stays pinned to
    // that state indefinitely even though Core connects seconds later —
    // `coreRuntime.connected` gates every mode and the overall verdict, so
    // the whole surface stays stuck. Re-assess whenever Core's status moves.
    if (onCoreStatusChange) {
      this.coreStatusSubscription = onCoreStatusChange(() => {
        Logger.info('[Onboarding] Core status changed; re-assessing readiness');
        void this.refresh();
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.coreStatusSubscription?.dispose();
    this.coreStatusSubscription = undefined;
    if (OnboardingPanel.current === this) OnboardingPanel.current = undefined;
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    const generation = ++this.assessmentGeneration;
    this.loading = true;
    this.render();
    try {
      const readiness = await this.service.assess();
      if (generation !== this.assessmentGeneration) return;
      this.lastReadiness = readiness;
    } catch (error) {
      if (generation !== this.assessmentGeneration) return;
      this.lastReadiness = undefined;
      void vscode.window.showErrorMessage(
        `KarkeDikha setup check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (generation === this.assessmentGeneration && !this.disposed) {
        this.loading = false;
        this.render();
      }
    }
  }

  private setNotice(kind: SetupNotice['kind'], text: string): void {
    this.notice = { kind, text };
    this.render();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const record = message as Record<string, unknown>;
    const type = String(record.type ?? '');
    if (type === 'toggleSection') {
      // Remember which <details> the user opened so a re-render (every refresh replaces the document) keeps them.
      const id = String(record.id ?? '');
      if (record.open === true) this.openSections.add(id); else this.openSections.delete(id);
      return;
    }
    this.notice = undefined;
    try {
      switch (type) {
        case 'recheck':
          await this.refresh();
          break;
        case 'setUpCloudFallback':
          await this.onSetUpCloudFallback();
          await this.refresh();
          break;
        case 'setUpOrcaRouter':
          await vscode.commands.executeCommand('ollama-agent.setUpOrcaRouter');
          await this.refresh();
          break;
        case 'clearOrcaRouter':
          await vscode.commands.executeCommand('ollama-agent.clearOrcaRouter');
          await this.refresh();
          break;
        case 'disableCloudFallback':
          await Config.setModelRoutingPolicy('local-only');
          await this.refresh();
          this.setNotice('ok', 'Cloud fallback is off. Repository and task content stays on this machine.');
          break;
        case 'copyPullCommand':
          if (this.lastReadiness?.pullCommandSuggestion) {
            await vscode.env.clipboard.writeText(this.lastReadiness.pullCommandSuggestion);
            void vscode.window.showInformationMessage('Copied. Run it in a terminal, then select "Re-check setup".');
          }
          break;
        case 'editEndpoint':
          await this.editEndpoint();
          break;
        case 'testConnection': {
          this.setNotice('info', 'Testing connection…');
          const result = await this.service.testConnection();
          this.setNotice(result.ok ? 'ok' : 'bad', result.message);
          break;
        }
        case 'setupHelp':
          await this.showSetupHelp();
          break;
        case 'reprobe':
          await this.reprobe(String(record.model ?? ''));
          break;
        case 'setContext':
          await this.setContext();
          break;
        case 'autoContext':
          await Config.setContextWindow(undefined);
          await this.refresh();
          this.setNotice('ok', 'Context is back on Auto.');
          break;
        case 'copyDiagnostics':
          await this.copyDiagnostics();
          break;
        case 'connectProvider':
          this.beginConnect(String(record.id ?? ''));
          break;
        case 'closeConnect':
          this.endConnect();
          this.render();
          break;
        case 'openKeysPage':
          await this.openKeysPage(String(record.id ?? ''), record.mode === 'external' ? 'external' : 'vscode');
          break;
        case 'pasteClipboard':
          await this.pasteFromClipboard();
          break;
        case 'saveProvider':
          await this.saveProvider(String(record.id ?? ''), String(record.apiKey ?? ''), String(record.accountId ?? ''));
          break;
        case 'toggleProvider':
          await this.toggleProvider(String(record.id ?? ''), record.enabled === 'true');
          break;
        case 'removeCredentials':
        case 'removeProvider':
          await this.removeProvider(String(record.id ?? ''), type === 'removeProvider');
          break;
        case 'removeAllCloud':
          await this.removeAllCloud();
          break;
        case 'refreshModels':
          await this.refreshModels(String(record.id ?? '*'));
          break;
        case 'refreshCatalog':
          await this.refreshCatalog();
          break;
        case 'toggleUseFreeCloud':
          await this.setUseFreeCloud(record.on === true);
          break;
        case 'toggleNeverPaid':
          await this.setNeverPaid(record.on === true);
          break;
        case 'toggleLocalFirst':
          // Local-first is always on in this build; the control is displayed locked.
          break;
        case 'configureRouting':
          await vscode.commands.executeCommand('workbench.action.openSettings', 'ollama-agent.modelRoutingPolicy');
          break;
      }
    } catch (error) {
      this.setNotice('bad', error instanceof Error ? error.message : String(error));
    }
  }

  // ---- Cloud pool: connect / remove / policy -------------------------------------------------------------------

  private cloud() { return cloudProviderServiceFor(this.context.secrets); }

  private beginConnect(id: string): void {
    if (!sharedProviderCatalog().has(id)) { this.setNotice('bad', 'Unknown provider.'); return; }
    this.stagedKey = undefined;
    this.connect = { providerId: id };
    this.render();
  }

  private endConnect(): void {
    this.connect = undefined;
    this.stagedKey = undefined;
  }

  private async openKeysPage(id: string, mode: 'vscode' | 'external'): Promise<void> {
    const descriptor = sharedProviderCatalog().get(id);
    if (!descriptor) return;
    const result = await openProviderKeysPage(descriptor, mode);
    if (result.opened === 'failed') {
      this.setConnectMessage('bad', `Could not open the page (${result.reason}). Open ${result.url || descriptor.apiKeysUrl} in your browser.`);
    } else if (result.opened === 'vscode-simple-browser') {
      this.setConnectMessage('info', 'Opened in VS Code. If the site will not display here, use "Open externally".');
    } else {
      this.setConnectMessage('info', 'Opened in your browser. Sign in, create a key and copy it, then come back.');
    }
  }

  /** The only clipboard read in the product: one explicit click, one value, staged in memory and never echoed. */
  private async pasteFromClipboard(): Promise<void> {
    const result = await readKeyFromClipboardOnClick();
    if (!result.ok) {
      this.setConnectMessage('bad', result.reason);
      return;
    }
    this.stagedKey = result.key;
    if (this.connect) this.connect = { ...this.connect, keyStaged: true, message: { kind: 'ok', text: 'Key pasted from the clipboard. Select "Save & test".' } };
    this.render();
  }

  private setConnectMessage(kind: 'ok' | 'bad' | 'info', text: string): void {
    if (this.connect) this.connect = { ...this.connect, message: { kind, text } };
    this.render();
  }

  private async saveProvider(id: string, typedKey: string, accountId: string): Promise<void> {
    if (!this.connect || this.connect.providerId !== id) return;
    const apiKey = (typedKey.trim() || this.stagedKey || '').trim();
    if (!apiKey) {
      this.setConnectMessage('bad', 'Paste or type your API key first.');
      return;
    }
    this.connect = { ...this.connect, busy: true, message: { kind: 'info', text: 'Testing the key and discovering models…' } };
    this.render();
    const result = await this.cloud().connect(id, { apiKey, accountId: accountId.trim() || undefined }, this.deps.getCore?.());
    this.stagedKey = undefined;
    if (!result.ok) {
      this.connect = { providerId: id, message: { kind: 'bad', text: result.reason } };
      this.render();
      return;
    }
    this.connect = { providerId: id, connected: { modelCount: result.models.length, freeCount: result.freeCount } };
    await this.refresh();
  }

  private async confirmModal(message: string, action: string): Promise<boolean> {
    return (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action;
  }

  private async toggleProvider(id: string, enabled: boolean): Promise<void> {
    await this.cloud().setEnabled(id, enabled, this.deps.getCore?.());
    await this.refresh();
    this.setNotice('ok', `${sharedProviderCatalog().get(id)?.displayName ?? id} is ${enabled ? 'back in' : 'out of'} the cloud pool.`);
  }

  private async removeProvider(id: string, wholeProvider: boolean): Promise<void> {
    const name = sharedProviderCatalog().get(id)?.displayName ?? id;
    const ok = await this.confirmModal(
      wholeProvider
        ? `Remove ${name}? Its saved settings and API key are deleted from this machine.`
        : `Remove the saved API key for ${name}? Your other ${name} settings stay.`,
      'Remove',
    );
    if (!ok) return;
    if (wholeProvider) await this.cloud().removeProvider(id, this.deps.getCore?.());
    else await this.cloud().removeCredentials(id, this.deps.getCore?.());
    this.endConnect();
    await this.refresh();
    this.setNotice('ok', wholeProvider ? `${name} removed.` : `${name} credentials removed.`);
  }

  private async removeAllCloud(): Promise<void> {
    if (!(await this.confirmModal('Remove ALL cloud provider credentials? Every saved cloud API key is deleted from this machine and from the running Core.', 'Remove all'))) return;
    await this.cloud().removeAllCredentials(this.deps.getCore?.());
    this.endConnect();
    await this.refresh();
    this.setNotice('ok', 'All cloud credentials were removed.');
  }

  private async refreshModels(id: string): Promise<void> {
    this.setNotice('info', 'Refreshing models…');
    if (id === '*') {
      const { models, failures } = await this.cloud().poolModels({ force: true });
      await this.refresh();
      this.setNotice(failures.length ? 'bad' : 'ok', failures.length
        ? `Listed ${models.length} model(s). ${failures.map(f => f.reason).join(' ')}`
        : `Refreshed: ${models.length} cloud model(s) across ${new Set(models.map(m => m.provider)).size} provider(s).`);
      return;
    }
    const inventory = await this.cloud().listModels(id, { force: true });
    await this.refresh();
    this.setNotice(inventory.ok ? 'ok' : 'bad', inventory.ok ? `${inventory.models.length} models listed.` : inventory.reason);
  }

  private async refreshCatalog(): Promise<void> {
    this.setNotice('info', 'Refreshing the free provider catalog…');
    const summary = await refreshProviderCatalogFromRemote(this.context.globalState);
    await this.refresh();
    this.setNotice(summary.ok ? 'ok' : 'info', summary.message);
  }

  private async setUseFreeCloud(on: boolean): Promise<void> {
    await Config.setModelRoutingPolicy(on ? 'local-first-cloud-fallback' : 'local-only');
    await this.refresh();
    const applied = (Config.getModelRoutingPolicy() === 'local-first-cloud-fallback') === on;
    if (!applied) {
      this.setNotice('bad', 'The setting did not take: another settings source (an environment pin or a folder setting) overrides ollama-agent.modelRoutingPolicy.');
      return;
    }
    const connected = this.lastReadiness?.cloudPool?.connectedCount ?? 0;
    this.setNotice('ok', on
      ? (connected > 0 ? 'Free cloud is on: Auto will use connected free providers when local cannot serve.' : 'Free cloud is on, but no provider is connected yet. Connect one below.')
      : 'Free cloud is off. Repository and task content stays on this machine unless you pick a cloud model yourself.');
  }

  private async setNeverPaid(on: boolean): Promise<void> {
    if (!on) {
      const ok = await this.confirmModal('Allow paid cloud usage? Models that are not known to be free may be used and may incur charges. This applies to every connected provider.', 'Allow paid cloud');
      if (!ok) { await this.refresh(); return; }
    }
    await Config.setCloudSpendMode(on ? 'FREE_ONLY' : 'UNRESTRICTED');
    await this.refresh();
    this.setNotice(on ? 'ok' : 'info', on ? 'Never incur paid usage is ON. Only models known to be free can be used.' : 'Paid cloud is now allowed.');
  }

  private async editEndpoint(): Promise<void> {
    const current = this.lastReadiness?.provider.apiBase ?? '';
    const entered = await vscode.window.showInputBox({
      title: 'Local model provider endpoint',
      prompt: 'Base URL of the local provider, e.g. http://127.0.0.1:11434 for Ollama.',
      value: current,
      ignoreFocusOut: true,
      validateInput: value => (value.trim() ? undefined : 'An endpoint is required.'),
    });
    if (!entered?.trim()) return;
    const result = await this.service.setEndpoint(entered);
    if (!result.ok) {
      this.setNotice('bad', result.reason);
      return;
    }
    await this.refresh();
    this.setNotice(this.lastReadiness?.provider.reachable ? 'ok' : 'bad',
      this.lastReadiness?.provider.reachable ? `Endpoint saved and reachable: ${result.endpoint}` : `Endpoint saved, but it could not be reached: ${result.endpoint}`);
  }

  private async showSetupHelp(): Promise<void> {
    const provider = this.lastReadiness?.provider;
    if (provider?.providerType === 'ollama') {
      const choice = await vscode.window.showInformationMessage(
        'Start Ollama (run "ollama serve" or open the Ollama app), check the endpoint above, then select Retry.',
        'Open Ollama download page',
      );
      if (choice) await vscode.env.openExternal(vscode.Uri.parse(OLLAMA_DOWNLOAD_URL));
      return;
    }
    void vscode.window.showInformationMessage(
      'Start your OpenAI-compatible server (llama.cpp, LM Studio, vLLM), load a model, check the endpoint above, then select Retry.',
    );
  }

  private async reprobe(model: string): Promise<void> {
    if (!model) return;
    this.setNotice('info', `Re-probing ${model}… this runs a few short bounded requests and may load the model.`);
    const result = await this.service.reprobe(model);
    switch (result.status) {
      case 'probed':
        await this.refresh();
        this.setNotice('ok', `Re-probed ${model}.`);
        break;
      case 'joined':
        await this.refresh();
        this.setNotice('info', `A probe for ${model} was already running; showing its result.`);
        break;
      case 'cooldown':
        this.setNotice('info', `${model} was probed moments ago. Try again in ${Math.ceil((result.retryAfterMs ?? 0) / 1000)} s.`);
        break;
      case 'disabled':
        this.setNotice('info', 'Runtime probing is turned off (OLLAMA_AGENT_RUNTIME_PROBE=0). Profiles are not collected.');
        break;
    }
  }

  private async setContext(): Promise<void> {
    const entered = await vscode.window.showInputBox({
      title: 'Context window (tokens)',
      prompt: 'The context budget KarkeDikha plans against. Leave on Auto unless a model needs more; large values use a lot of memory.',
      value: String(this.lastReadiness?.advanced?.context.tokens ?? ''),
      ignoreFocusOut: true,
      validateInput: value => {
        const parsed = Number(value);
        return Number.isInteger(parsed) && parsed >= 2048 && parsed <= 262_144
          ? undefined
          : 'Enter a whole number between 2048 and 262144.';
      },
    });
    if (!entered) return;
    const tokens = Number(entered);
    if (tokens > LARGE_CONTEXT_CONFIRM_TOKENS) {
      const confirm = await vscode.window.showWarningMessage(
        `A ${formatContext(tokens)} context uses significantly more memory and slows every request. Use it anyway?`,
        { modal: true },
        'Use this context',
      );
      if (confirm !== 'Use this context') return;
    }
    await Config.setContextWindow(tokens);
    await this.refresh();
    this.setNotice('ok', `Context set to ${formatContext(tokens)}.`);
  }

  private async copyDiagnostics(): Promise<void> {
    if (!this.lastReadiness) {
      this.setNotice('bad', 'Run a setup check first.');
      return;
    }
    await vscode.env.clipboard.writeText(buildDiagnosticsText(this.lastReadiness));
    this.setNotice('ok', 'Diagnostics copied. They contain no keys, tokens or file contents.');
  }

  /** Webview URI of a shared media file, or undefined when this host cannot serve it (the browse button is then hidden). */
  private mediaUri(file: string): string | undefined {
    try {
      const base = this.context.extensionUri;
      if (!base) return undefined;
      return this.panel.webview.asWebviewUri(vscode.Uri.joinPath(base, 'media', file)).toString();
    } catch {
      return undefined;
    }
  }

  private render(): void {
    const nonce = crypto.randomBytes(16).toString('hex');
    this.panel.webview.html = renderSetupHtml(
      {
        loading: this.loading,
        readiness: this.lastReadiness,
        openSections: this.openSections,
        notice: this.notice,
        connect: this.connect,
        paletteScriptUri: this.mediaUri('model-palette.js'),
        paletteCssUri: this.mediaUri('chat-palette.css'),
      },
      this.panel.webview.cspSource,
      nonce,
    );
  }
}
