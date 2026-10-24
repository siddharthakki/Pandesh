import * as vscode from 'vscode';
import { Config } from '../config/Config';
import {
  ProviderReadinessFailureCode,
  ProviderReadinessProbe,
  ProviderReadinessResult,
} from '../diagnostics/ProviderReadiness';

export const CONFIGURE_PROVIDER_MODEL_COMMAND = 'ollama-agent.configureProviderModel';

interface ModelQuickPickItem extends vscode.QuickPickItem {
  modelName: string;
}

export class ConfigureProviderModelController implements vscode.Disposable {
  private disposed = false;
  private running = false;

  constructor(private readonly readinessProbe: ProviderReadinessProbe) {}

  async run(): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      void vscode.window.showWarningMessage('KarkeDikha: provider model configuration is already running.');
      return;
    }

    this.running = true;
    try {
      await this.configure();
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
  }

  private async configure(): Promise<void> {
    const controller = new AbortController();
    const readiness = await this.readinessProbe.run(controller.signal);
    if (this.disposed) {
      return;
    }
    if (readiness.failureCode && readiness.failureCode !== 'model_unavailable') {
      this.showReadinessFailure(readiness.failureCode);
      return;
    }

    const modelNames = readiness.availableModelNames ?? [];
    if (modelNames.length === 0) {
      void vscode.window.showWarningMessage('KarkeDikha: the provider returned no selectable models.');
      return;
    }

    const selected = await vscode.window.showQuickPick(
      modelNames.map(modelName => ({
        label: modelName,
        description: modelName === readiness.chatModel ? 'current chat model' : undefined,
        modelName,
        picked: modelName === readiness.chatModel,
      })),
      {
        title: 'KarkeDikha: Configure Provider Model',
        placeHolder: `Provider: ${readiness.providerType} | Endpoint: ${readiness.apiBase} | Current chat model: ${readiness.chatModel}`,
      },
    ) as ModelQuickPickItem | undefined;
    if (this.disposed || !selected) {
      return;
    }

    const currentModel = Config.getChatModel();
    if (selected.modelName === currentModel) {
      void vscode.window.showInformationMessage(`KarkeDikha: chat model is already "${selected.modelName}".`);
      return;
    }

    const confirmation = await vscode.window.showWarningMessage(
      `Change KarkeDikha chat model from "${currentModel}" to "${selected.modelName}"?`,
      { modal: true },
      'Update Model',
    );
    if (this.disposed || confirmation !== 'Update Model') {
      return;
    }

    await Config.updateChatModel(selected.modelName);
    const stored = Config.getChatModel();
    if (this.disposed) {
      return;
    }
    if (stored !== selected.modelName) {
      void vscode.window.showErrorMessage('KarkeDikha: chat model update could not be verified.');
      return;
    }
    void vscode.window.showInformationMessage(`KarkeDikha: chat model updated to "${selected.modelName}".`);
  }

  private showReadinessFailure(code: ProviderReadinessFailureCode): void {
    switch (code) {
      case 'provider_unreachable':
        void vscode.window.showWarningMessage('KarkeDikha: provider is unreachable. Verify ollama-agent.apiBase and provider availability.');
        return;
      case 'authentication_failed':
        void vscode.window.showWarningMessage('KarkeDikha: provider authentication failed. Verify the stored provider API key.');
        return;
      case 'timeout':
        void vscode.window.showWarningMessage('KarkeDikha: provider readiness timed out. Verify provider responsiveness or ollama-agent.requestTimeout.');
        return;
      case 'cancelled':
        return;
      case 'provider_failure':
      case 'model_unavailable':
        void vscode.window.showWarningMessage('KarkeDikha: provider model discovery failed. Verify provider settings and availability.');
        return;
    }
  }
}
