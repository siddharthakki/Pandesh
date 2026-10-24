import * as vscode from 'vscode';
import {
  M16EvaluationStore,
  M16EvaluationRunner,
  M16QualityGateService,
  defaultM16AutonomousDeliveryGate,
  compareM16Baseline,
  M16Baseline,
} from '../evals/M16QualityEvaluation';
import { DurableTaskQueue, MergeReadinessService } from '../autonomous/M15AutonomousWork';

export const M16_COMMANDS = [
  'ollama-agent.runEvaluationSuite',
  'ollama-agent.evaluateCurrentAutonomousTask',
  'ollama-agent.showLatestEvaluationReport',
  'ollama-agent.compareEvaluationBaseline',
  'ollama-agent.showQualityGateDecision',
  'ollama-agent.exportPrivacySafeEvaluationReport',
] as const;

export function registerM16EvaluationCommands(context: vscode.ExtensionContext, workspaceRoot: string): void {
  let services: {
    store: M16EvaluationStore;
    runner: M16EvaluationRunner;
    gate: M16QualityGateService;
    queue: DurableTaskQueue;
  } | undefined;
  const getServices = () => {
    if (!services) {
      const store = new M16EvaluationStore(workspaceRoot);
      const runner = new M16EvaluationRunner(store);
      services = {
        store,
        runner,
        gate: new M16QualityGateService(runner),
        queue: new DurableTaskQueue(workspaceRoot),
      };
    }
    return services;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('ollama-agent.runEvaluationSuite', async () => {
      const { runner } = getServices();
      const run = await runner.run({ evidenceRecords: [{ id: 'manual-run', kind: 'diagnostic', content: 'Manual deterministic M16 evaluation.' }] }, {
        kind: 'evaluation-suite',
        id: 'manual',
        trusted: false,
      });
      vscode.window.showInformationMessage(`M16 evaluation ${run.status}: ${run.runId}`);
    }),
    vscode.commands.registerCommand('ollama-agent.evaluateCurrentAutonomousTask', async (taskId?: string) => {
      const { queue, gate } = getServices();
      const selected = await resolveTaskId(queue, taskId);
      if (!selected) return;
      const task = await queue.get(selected);
      if (!task) return;
      const report = await new MergeReadinessService().report(task);
      const decision = await gate.evaluate(defaultM16AutonomousDeliveryGate(), {
        kind: 'autonomous-task',
        id: task.taskId,
        repositoryId: task.repositoryId,
        trusted: false,
      }, {
        task,
        mergeReadiness: report,
        evidenceRecords: [
          { id: 'task-evidence', kind: 'validation', content: task.evidence.join('\n') },
          { id: 'policy-decision', kind: 'policy', content: 'blocked until M16 quality gate passes' },
        ],
      });
      vscode.window.showInformationMessage(`M16 gate ${decision.status}: ${decision.runId}`);
    }),
    vscode.commands.registerCommand('ollama-agent.showLatestEvaluationReport', async () => {
      const { store } = getServices();
      const latest = await store.latest();
      if (!latest) {
        vscode.window.showInformationMessage('No M16 evaluation reports found.');
        return;
      }
      await vscode.window.showQuickPick([
        `Run: ${latest.runId}`,
        `Status: ${latest.status}`,
        `Subject: ${latest.subject.kind}/${latest.subject.id}`,
        `Findings: ${latest.results.reduce((sum, result) => sum + result.findings.length, 0)}`,
      ].map(label => ({ label })), { title: 'Latest M16 Evaluation Report' });
    }),
    vscode.commands.registerCommand('ollama-agent.compareEvaluationBaseline', async () => {
      const { store } = getServices();
      const latest = await store.latest();
      if (!latest) {
        vscode.window.showInformationMessage('No M16 evaluation report to compare.');
        return;
      }
      const baseline: M16Baseline = {
        suiteId: latest.suite.id,
        suiteVersion: latest.suite.version,
        evaluatorVersions: Object.fromEntries(latest.suite.cases.map(item => [item.evaluator.id, item.evaluator.version])),
        metrics: Object.fromEntries(latest.results.flatMap(result => result.metrics.map(item => [item.id, item]))),
      };
      const comparison = compareM16Baseline(baseline, latest);
      vscode.window.showInformationMessage(`M16 baseline comparison compatible=${comparison.compatible}, regressions=${comparison.regressions.length}`);
    }),
    vscode.commands.registerCommand('ollama-agent.showQualityGateDecision', async () => {
      const { store } = getServices();
      const latest = await store.latest();
      if (!latest) {
        vscode.window.showInformationMessage('No M16 quality gate decision available.');
        return;
      }
      const failed = latest.results.filter(result => result.status !== 'passed');
      await vscode.window.showQuickPick((failed.length ? failed : latest.results).map(result => ({
        label: result.caseId,
        description: result.status,
        detail: result.findings.map(item => item.title).join('; ') || 'no findings',
      })), { title: 'M16 Quality Gate Decision' });
    }),
    vscode.commands.registerCommand('ollama-agent.exportPrivacySafeEvaluationReport', async () => {
      const { store } = getServices();
      const latest = await store.latest();
      if (!latest) {
        vscode.window.showInformationMessage('No M16 evaluation report to export.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(latest, null, 2),
      });
      await vscode.window.showTextDocument(doc);
    }),
  );
}

async function resolveTaskId(queue: DurableTaskQueue, taskId?: string): Promise<string | undefined> {
  if (typeof taskId === 'string' && taskId) return taskId;
  const tasks = await queue.list();
  const selected = await vscode.window.showQuickPick(tasks.map(task => ({
    label: task.goal,
    description: task.state,
    detail: task.taskId,
    taskId: task.taskId,
  })), { title: 'Select Task for M16 Evaluation' });
  return selected?.taskId;
}
