import * as vscode from 'vscode';

// Virtual document provider for proposed file content in diff views
export class DiffReviewProvider implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'ollama-agent-proposed';
  private _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    const params = new URLSearchParams(uri.query);
    return decodeURIComponent(params.get('content') ?? '');
  }

  static register(context: vscode.ExtensionContext): void {
    const provider = new DiffReviewProvider();
    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(DiffReviewProvider.scheme, provider),
    );
  }
}
