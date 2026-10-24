/**
 * Setup flow for OrcaRouter as a manually selectable cloud provider: base URL, API key, live
 * validation, then activation. Nothing is stored until the credentials have listed real models,
 * so a wrong key or URL never leaves OrcaRouter looking ready. On success the credential is
 * delivered to Core and pickers refresh immediately — no VS Code restart.
 */
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { orcaRouterServiceFor, type OrcaRouterCoreSink } from '../providers/OrcaRouter';

export interface OrcaRouterSetupDeps {
  /** Current Core client, when connected. Absent means the credential is delivered on the next connect. */
  getCore?: () => OrcaRouterCoreSink | undefined;
}

export async function runOrcaRouterSetup(context: vscode.ExtensionContext, deps: OrcaRouterSetupDeps = {}): Promise<boolean> {
  const apiBase = await vscode.window.showInputBox({
    title: 'OrcaRouter (1 of 2): endpoint',
    prompt: 'OpenAI-compatible base URL. Requests are sent here only when you manually pick an OrcaRouter model.',
    value: Config.getOrcaRouterApiBase(),
    ignoreFocusOut: true,
    validateInput: value => /^https?:\/\//i.test(value.trim()) ? undefined : 'Enter a full URL such as https://api.orcarouter.ai/v1.',
  });
  if (!apiBase?.trim()) return false;

  const apiKey = await vscode.window.showInputBox({
    title: 'OrcaRouter (2 of 2): API key',
    prompt: 'Stored in VS Code SecretStorage, never in settings.',
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'An API key is required.',
  });
  if (!apiKey?.trim()) return false;

  const service = orcaRouterServiceFor(context.secrets);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Verifying OrcaRouter and loading models…' },
    () => service.connect({ apiBase, apiKey }, deps.getCore?.()),
  );
  if (!result.ok) {
    void vscode.window.showErrorMessage(`${result.reason} Nothing was saved.`);
    return false;
  }
  void vscode.window.showInformationMessage(
    `OrcaRouter is ready: ${result.models.length} cloud model${result.models.length === 1 ? '' : 's'} are now in the model picker. Pick one to use it.`,
  );
  return true;
}

export async function runOrcaRouterRemoval(context: vscode.ExtensionContext, deps: OrcaRouterSetupDeps = {}): Promise<void> {
  await orcaRouterServiceFor(context.secrets).disconnect(deps.getCore?.());
  void vscode.window.showInformationMessage('OrcaRouter credentials removed. Cloud models are no longer selectable.');
}
