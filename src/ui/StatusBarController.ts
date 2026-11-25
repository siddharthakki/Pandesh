import * as vscode from 'vscode';
import type { CoreConnectionStatus } from '../core-client/ConnectionState';

const OPEN_CHAT_COMMAND = 'ollama-agent.openChat';
const RESTART_CORE_COMMAND = 'ollama-agent.restartKarkeDikhaCore';

export class StatusBarController {
  private item: vscode.StatusBarItem;
  private coreUnavailable = false;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = OPEN_CHAT_COMMAND;
    this.setIdle();
    this.item.show();
  }

  /**
   * Shows Core's state when chat and tasks cannot run. Editor-native features (diagnostics, diff review, previews,
   * workspace context) do not depend on Core and keep working. Clicking the item starts or retries Core.
   */
  setCoreStatus(status: CoreConnectionStatus): void {
    this.coreUnavailable = status.state !== 'connected';
    if (!this.coreUnavailable) {
      this.item.command = OPEN_CHAT_COMMAND;
      this.setIdle();
      return;
    }
    const starting = status.state === 'starting';
    this.item.text = starting ? '$(sync~spin) KarkeDikha: Core starting' : '$(debug-disconnect) KarkeDikha: Core offline';
    this.item.tooltip = starting
      ? 'Pandesh Core is starting. Chat and tasks are available once it connects.'
      : 'Pandesh Core is not connected, so chat and tasks are unavailable. Diagnostics, diffs and previews still work. Click to start or retry Core.';
    this.item.command = RESTART_CORE_COMMAND;
    this.item.backgroundColor = starting ? undefined : new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  setIdle(): void {
    if (this.coreUnavailable) { return; }
    this.item.text = '$(robot) KarkeDikha';
    this.item.tooltip = 'Click to open KarkeDikha chat';
    this.item.backgroundColor = undefined;
  }

  setRunning(model: string): void {
    if (this.coreUnavailable) { return; }
    this.item.text = `$(sync~spin) KarkeDikha: ${model}`;
    this.item.tooltip = 'Agent is running…';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  setError(): void {
    if (this.coreUnavailable) { return; }
    this.item.text = '$(error) KarkeDikha: Error';
    this.item.tooltip = 'Last run encountered an error';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
