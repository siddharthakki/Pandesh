import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { HostBoundCodingProposal, MutationResult } from '../coding/WorkspaceMutation';
import { ValidationRunResult } from '../coding/ValidationRunner';
import { CodingProposal } from '../coding/CodingProposal';
import { FixedMultiAgentGraphResult } from '../orchestration/FixedMultiAgentGraph';
import { ForgeExecutionReadiness, ForgeExecutionReadinessResult } from '../coding/ExecutionIntegrity';
import { GovernedCodingExecutor } from '../coding/GovernedCodingExecutor';
import { classifyExecutionProfile, parseDeterministicFileWrite } from '../orchestration/ExecutionProfile';

export const RUN_FORGE_CODING_TASK_COMMAND = 'ollama-agent.runForgeCodingTask' as const;
export const RUN_FORGE_READINESS_CHECK_COMMAND = 'ollama-agent.runForgeReadinessCheck' as const;

const OUTPUT_CHANNEL_NAME = 'KarkeDikha - Forge Coding';

export class ForgeCodingTaskController implements vscode.Disposable {
  private running = false;
  private disposed = false;
  private output?: vscode.OutputChannel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: string,
    private readonly executor: GovernedCodingExecutor = new GovernedCodingExecutor(),
  ) {}

  async run(taskOverride?: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.running) {
      void vscode.window.showWarningMessage('KarkeDikha: Forge coding task is already running.');
      return;
    }
    this.running = true;
    try {
      const task = taskOverride ?? await vscode.window.showInputBox({
        title: 'KarkeDikha: Run Forge Coding Task',
        placeHolder: 'Describe the coding change to propose',
        ignoreFocusOut: true,
      });
      if (!task?.trim()) {
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Running Forge Coding Task', cancellable: true },
        async (_progress, token) => this.runWithProgress(task.trim(), token),
      );
    } finally {
      this.running = false;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.output?.dispose();
  }

  async runReadinessCheck(): Promise<ForgeExecutionReadinessResult> {
    const readiness = await this.readiness().check();
    this.reportReadiness(readiness);
    const message = readiness.blockingFailures.length === 0
      ? `KarkeDikha: Forge readiness passed with ${readiness.warnings.length} warning(s).`
      : `KarkeDikha: Forge readiness blocked by ${readiness.blockingFailures.length} issue(s).`;
    void (readiness.blockingFailures.length === 0
      ? vscode.window.showInformationMessage(message)
      : vscode.window.showWarningMessage(message));
    return readiness;
  }

  private async runWithProgress(task: string, token: vscode.CancellationToken): Promise<void> {
    const abort = new AbortController();
    const listener = token.onCancellationRequested(() => abort.abort());
    const runId = `coding_run_${Date.now()}`;
    // This manual/ad-hoc command has no task-level model-selection UI (unlike
    // the autonomous queue, which resolves and binds a selected model before a
    // task is ever claimed — see M15AutonomousRuntime.runTask). The configured
    // coding model is therefore an explicit, documented default for this path,
    // not an omission — and it is the exact model already shown to the
    // reviewer in the proposal picker below, so displayed and actual models
    // can never diverge.
    const model = Config.getCodingModel();
    const executionProfile = classifyExecutionProfile(task);
    const deterministicWrite = executionProfile.useDeterministicProposal
      ? parseDeterministicFileWrite(task)
      : undefined;
    try {
      const result = await this.executor.execute({
        runId,
        goal: task,
        workspaceRoot: this.workspaceRoot,
        signal: abort.signal,
        secrets: this.context.secrets,
        auditSource: 'command',
        auditMetadata: { command: RUN_FORGE_CODING_TASK_COMMAND },
        extensionBuild: this.extensionBuild(),
        providerType: Config.getProviderType(),
        model,
        executionProfile,
        deterministicProposal: deterministicWrite
          ? { path: deterministicWrite.path, content: deterministicWrite.content, reason: 'Deterministic exact-content file write (trivial execution profile — no model invoked).' }
          : undefined,
        callbacks: {
          checkReadiness: async targetPaths => {
            const readiness = await this.readiness().check(targetPaths ?? []);
            if (readiness.blockingFailures.length > 0) {
              this.reportReadiness(readiness);
            }
            return readiness;
          },
          reviewProposal: async proposal => {
            if (this.disposed || abort.signal.aborted || token.isCancellationRequested) {
              return false;
            }
            const reviewed = await vscode.window.showQuickPick(proposalReviewItems(proposal), {
              title: 'KarkeDikha: Review Forge Coding Proposal',
              placeHolder: `Workspace: ${this.workspaceRoot} | Provider: ${Config.getProviderType()} | Model: ${Config.getCodingModel()}`,
            });
            return Boolean(!this.disposed && reviewed);
          },
          approveExecution: async proposal => {
            if (this.disposed) return false;
            const approval = await vscode.window.showWarningMessage(
              `Apply Forge coding proposal touching ${proposal.operations.length} file(s) and run ${proposal.validationCommands.length} validation command(s)?`,
              { modal: true },
              'Approve Execution',
            );
            return !this.disposed && approval === 'Approve Execution';
          },
          confirmElevated: async envelope => {
            if (this.disposed) return false;
            const elevated = await vscode.window.showWarningMessage(
              `Sensitive Forge proposal requires elevated confirmation: ${envelope.operations.map(operation => `${operation.type}:${operation.path}:${operation.sensitive.category}`).join(', ')}`,
              { modal: true },
              'Confirm Elevated Execution',
            );
            return !this.disposed && elevated === 'Confirm Elevated Execution';
          },
        },
      });
      if (this.disposed) {
        return;
      }
      this.report(runId, task, result.status, result.executableProposal ?? result.proposal, result.mutation, result.validations, result.failureReason, result.graph);
      if (result.status === 'graph_incomplete') {
        void vscode.window.showWarningMessage(`KarkeDikha: Forge coding graph ${result.graph?.status ?? 'incomplete'}.`).then(undefined, () => undefined);
      } else if (result.status === 'proposal_unavailable' || result.status === 'invalid_proposal') {
        void vscode.window.showWarningMessage('KarkeDikha: Forge coding proposal was rejected as invalid.').then(undefined, () => undefined);
      } else if (result.status === 'completed') {
        void vscode.window.showInformationMessage('KarkeDikha: Forge coding task completed.').then(undefined, () => undefined);
      } else if (result.status === 'validation_failed') {
        void vscode.window.showWarningMessage('KarkeDikha: Forge coding task finished with validation failures.').then(undefined, () => undefined);
      } else if (result.status !== 'proposal_rejected' && result.status !== 'execution_rejected') {
        void vscode.window.showWarningMessage(`KarkeDikha: Forge coding task ${result.status}.`).then(undefined, () => undefined);
      }
    } finally {
      listener.dispose();
    }
  }

  private readiness(): ForgeExecutionReadiness {
    const textDocuments = Array.isArray(vscode.workspace.textDocuments) ? vscode.workspace.textDocuments : [];
    return new ForgeExecutionReadiness(this.workspaceRoot, {
      workspaceFolders: vscode.workspace.workspaceFolders,
      trusted: vscode.workspace.isTrusted,
      dirtyDocuments: textDocuments.map(document => ({
        uri: document.uri,
        isDirty: document.isDirty,
        isUntitled: document.isUntitled,
      })),
      extensionBuild: this.extensionBuild(),
    });
  }

  private extensionBuild(): string {
    const maybeContext = this.context as vscode.ExtensionContext & { extension?: { packageJSON?: { version?: string } } };
    return maybeContext.extension?.packageJSON?.version ?? 'dev';
  }

  private reportReadiness(readiness: ForgeExecutionReadinessResult): void {
    const output = this.output ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.output = output;
    output.appendLine('------------------------------------------------------------');
    output.appendLine('Forge Readiness Check');
    output.appendLine(JSON.stringify(readiness, undefined, 2));
    output.appendLine('------------------------------------------------------------');
    output.show(true);
  }

  private report(
    runId: string,
    task: string,
    status: string,
    proposal?: CodingProposal,
    mutation?: MutationResult,
    validations: readonly ValidationRunResult[] = [],
    failureReason?: string,
    graph?: FixedMultiAgentGraphResult,
  ): void {
    const output = this.output ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.output = output;
    output.appendLine('------------------------------------------------------------');
    output.appendLine('Forge Coding Task');
    output.appendLine(`Run: ${runId}`);
    output.appendLine(`Task: ${task.slice(0, 300)}`);
    output.appendLine(`Workspace: ${this.workspaceRoot}`);
    output.appendLine(`Provider: ${Config.getProviderType()}`);
    output.appendLine(`Model: ${Config.getCodingModel()}`);
    output.appendLine(`Status: ${status}`);
    if (graph) {
      output.appendLine(`Graph status: ${graph.status}`);
      output.appendLine(`Completed stages: ${graph.completedStages.join(', ')}`);
      output.appendLine(`Proposal consumption: ${graph.proposalConsumption?.status ?? 'unavailable'}`);
      if (graph.proposalConsumption?.evidence.requestId) {
        output.appendLine(`Governed request: ${graph.proposalConsumption.evidence.requestId}`);
      }
    }
    if (proposal) {
      output.appendLine(`Summary: ${proposal.taskSummary}`);
      output.appendLine(`Files proposed: ${proposal.operations.map(op => `${op.type}:${op.path}`).join(', ')}`);
      output.appendLine(`Validation proposed: ${proposal.validationCommands.map(command => command.kind).join(', ')}`);
    }
    if (mutation) {
      output.appendLine(`Files created: ${mutation.filesCreated.join(', ')}`);
      output.appendLine(`Files modified: ${mutation.filesModified.join(', ')}`);
      output.appendLine(`Files deleted: ${mutation.filesDeleted.join(', ')}`);
      output.appendLine(`Files restored by rollback: ${mutation.filesRestored.join(', ')}`);
      output.appendLine(`Rollback: ${mutation.rollbackAttempted ? (mutation.rollbackSucceeded ? 'succeeded' : 'failed') : 'not needed'}`);
    }
    for (const validation of validations) {
      output.appendLine(`Validation: ${validation.command} | exit=${validation.exitCode} | timeout=${validation.timedOut} | duration=${validation.durationMs}ms`);
      if (validation.output) {
        output.appendLine(validation.output.slice(0, 1000));
      }
    }
    if (failureReason) {
      output.appendLine(`Failure reason: ${failureReason}`);
    }
    output.appendLine('Commit: not created');
    output.appendLine('Push: not performed');
    output.appendLine('------------------------------------------------------------');
    output.show(true);
  }

}

function proposalReviewItems(proposal: HostBoundCodingProposal): vscode.QuickPickItem[] {
  return [
    { label: `Summary: ${proposal.taskSummary}` },
    ...proposal.operations.map(op => ({ label: `${op.type}: ${op.path}`, detail: op.reason })),
    ...proposal.validationCommands.map(command => ({ label: `validate: ${command.kind}`, detail: command.script })),
    ...proposal.warnings.map(warning => ({ label: `warning: ${warning}` })),
  ];
}
