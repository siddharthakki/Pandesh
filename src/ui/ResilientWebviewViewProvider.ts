import * as vscode from 'vscode';
import { Logger } from '../services/Logger';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderWebviewStatus(title: string, message: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { color-scheme: dark; }
    body {
      margin: 0;
      padding: 20px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
    }
    .status {
      padding: 16px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      background: var(--vscode-editor-background);
    }
    h2 { margin: 0 0 10px; font-size: 15px; }
    p { margin: 0; line-height: 1.5; white-space: pre-wrap; }
  </style>
</head>
<body>
  <section class="status">
    <h2>${escapeHtml(title)}</h2>
    <p>${escapeHtml(message)}</p>
  </section>
</body>
</html>`;
}

export class ResilientWebviewViewProvider implements vscode.WebviewViewProvider {
  constructor(
    private readonly delegate: vscode.WebviewViewProvider,
    private readonly viewName: string,
  ) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    token: vscode.CancellationToken,
  ): Promise<void> {
    webviewView.webview.html = renderWebviewStatus(
      `Loading ${this.viewName}`,
      'Initializing the local runtime…',
    );

    try {
      await this.delegate.resolveWebviewView(webviewView, context, token);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`[${this.viewName}] Webview initialization failed:`, error);
      webviewView.webview.html = renderWebviewStatus(
        `${this.viewName} failed to initialize`,
        `${message}\n\nOpen View → Output → Log (Extension Host) for the full stack trace.`,
      );
    }
  }
}
