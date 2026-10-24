import * as vscode from 'vscode';

// Placeholder tree provider — can be wired to SessionStore in a future iteration
export class SessionTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(): vscode.TreeItem[] {
    return [];
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }
}
