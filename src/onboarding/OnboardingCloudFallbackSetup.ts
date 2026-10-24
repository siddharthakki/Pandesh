/**
 * The smallest coherent cloud fallback setup flow: endpoint, model, API key,
 * test configuration, enable. Fails closed at every step — cancelling any
 * step aborts without touching `ollama-agent.modelRoutingPolicy`, so a
 * partially-entered flow can never silently turn cloud fallback on. The
 * policy is only ever flipped to `local-first-cloud-fallback` as the very
 * last, explicit step, after the endpoint/model/key have all been
 * confirmed present and a live test connection has succeeded (or the user
 * has explicitly chosen to proceed without one).
 */
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { ProviderGateway } from '../providers/ProviderGateway';
import { OpenAICompatibleProvider } from '../providers/OpenAICompatibleProvider';

export async function runCloudFallbackSetup(context: vscode.ExtensionContext): Promise<void> {
  const endpoint = await vscode.window.showInputBox({
    title: 'Cloud fallback (1 of 4): endpoint',
    prompt: 'OpenAI-compatible base URL. Repository/task context is sent here only after a recoverable local failure.',
    value: Config.getCloudFallbackApiBase() || 'https://api.example.com/v1',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'An endpoint is required.',
  });
  if (!endpoint?.trim()) return;

  const model = await vscode.window.showInputBox({
    title: 'Cloud fallback (2 of 4): model',
    prompt: 'Model name to request from that endpoint.',
    value: Config.getCloudFallbackModel(),
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'A model name is required.',
  });
  if (!model?.trim()) return;

  const apiKey = await vscode.window.showInputBox({
    title: 'Cloud fallback (3 of 4): API key',
    prompt: 'Stored in VS Code SecretStorage. This is an API key for the endpoint above — not a ChatGPT or Claude consumer subscription.',
    password: true,
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'An API key is required.',
  });
  if (!apiKey?.trim()) return;

  const testProvider = new OpenAICompatibleProvider(endpoint.trim().replace(/\/$/, ''), apiKey.trim());
  const tested = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Testing cloud fallback connection…' },
    async () => {
      try {
        await testProvider.healthCheck();
        return { ok: true as const };
      } catch (error) {
        return { ok: false as const, message: error instanceof Error ? error.message : String(error) };
      }
    },
  );

  if (!tested.ok) {
    const proceed = await vscode.window.showWarningMessage(
      `Cloud fallback (4 of 4): the test connection failed (${tested.message}). Save this configuration anyway without enabling it?`,
      { modal: true },
      'Save without enabling',
    );
    if (proceed !== 'Save without enabling') return;
    await persistEndpointAndModel(endpoint.trim(), model.trim());
    await ProviderGateway.storeCloudFallbackApiKey(context.secrets, apiKey.trim());
    void vscode.window.showWarningMessage('Cloud fallback saved but not enabled. Model routing stays local-only.');
    return;
  }

  const enable = await vscode.window.showInformationMessage(
    'Cloud fallback (4 of 4): the test connection succeeded. Enable cloud fallback? '
      + 'Repository and task context will be sent to this endpoint after a recoverable local failure.',
    { modal: true },
    'Enable cloud fallback',
  );
  await persistEndpointAndModel(endpoint.trim(), model.trim());
  await ProviderGateway.storeCloudFallbackApiKey(context.secrets, apiKey.trim());
  if (enable !== 'Enable cloud fallback') {
    void vscode.window.showInformationMessage('Cloud fallback saved but not enabled. Model routing stays local-only.');
    return;
  }
  await Config.setModelRoutingPolicy('local-first-cloud-fallback');
  // Read back through the same reader Setup and dispatch use; never report success for a write that did not take.
  if (Config.getModelRoutingPolicy() !== 'local-first-cloud-fallback') {
    void vscode.window.showWarningMessage(
      'Cloud fallback was saved but is still off: another setting source (an environment pin or a folder setting) overrides ollama-agent.modelRoutingPolicy.',
    );
    return;
  }
  void vscode.window.showInformationMessage('Cloud fallback enabled.');
}

async function persistEndpointAndModel(endpoint: string, model: string): Promise<void> {
  await Config.setCloudFallbackEndpointAndModel(endpoint, model);
}
