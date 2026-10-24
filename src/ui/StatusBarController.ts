import * as vscode from 'vscode';

export class StatusBarController {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'ollama-agent.openChat';
    this.setIdle();
    this.item.show();
  }

  setIdle(): void {
    this.item.text = '$(robot) KarkeDikha';
    this.item.tooltip = 'Click to open KarkeDikha chat';
    this.item.backgroundColor = undefined;
  }

  setRunning(model: string): void {
    this.item.text = `$(sync~spin) KarkeDikha: ${model}`;
    this.item.tooltip = 'Agent is running…';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  }

  setError(): void {
    this.item.text = '$(error) KarkeDikha: Error';
    this.item.tooltip = 'Last run encountered an error';
    this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
  }

  dispose(): void {
    this.item.dispose();
  }
}
