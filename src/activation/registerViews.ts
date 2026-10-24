import * as vscode from 'vscode';
import { AgentPanel } from '../ui/AgentPanel';
import { DiffReviewProvider } from '../ui/DiffReviewProvider';
import { SessionTreeProvider } from '../ui/SessionTreeProvider';
import { ResilientWebviewViewProvider } from '../ui/ResilientWebviewViewProvider';
import { registerProposedContentProvider } from '../tools/fileTools';
import { RepositoryGraphService } from '../repository/RepositoryGraphService';

export function registerViews(context: vscode.ExtensionContext, workspaceRoot: string, workspaceAvailable = true): AgentPanel {
  DiffReviewProvider.register(context);
  registerProposedContentProvider(context);

  const agentPanel = new AgentPanel(context, workspaceRoot, workspaceAvailable);
  if (workspaceAvailable && workspaceRoot) {
    // Background, incremental, optional. Repository questions work without it; once usable it adds a ranked source.
    const graph = RepositoryGraphService.forWorkspace(context, workspaceRoot);
    agentPanel.attachRepositoryGraph(graph);
    graph.start();
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AgentPanel.viewType,
      new ResilientWebviewViewProvider(agentPanel, 'KarkeDikha'),
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
  );

  return agentPanel;
}
