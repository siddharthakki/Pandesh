import * as crypto from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Config } from '../config/Config';
import { Logger } from '../services/Logger';
import { AutonomousTaskRuntime, type KarkeDikhaLifecycleAuthority } from './M15AutonomousRuntime';
import { createDefaultAutonomousTask } from '../autonomous/M15AutonomousWork';
import { CoreManager } from '../core-client/CoreManager';
import { CoreClient, type CoreKarkeDikhaWorkerCredentials } from '../core-client/CoreClient';
import type {
  ApprovalRecord,
  AttemptContextRecord,
  EngineeringAssignmentRecord,
  EngineeringCiEvidenceRecord,
  EngineeringSprintRecord,
  ExecutionQualityEvidenceInput,
  KarkeDikhaValidationEvidence,
} from '../../core/shared/wireTypes';
import { GhM22EngineeringBoard, type PullRequestObservation } from '../organization/GhM22EngineeringBoard';
import { loadM19WorkforceConfig } from '../workforce/M19WorkforceConfig';

export const M22_PROVISION_COMMAND = 'ollama-agent.provisionEngineeringOrganization';
export const M22_RUN_SPRINT_COMMAND = 'ollama-agent.runEngineeringSprint';
export const M22_SYNC_COMMAND = 'ollama-agent.syncEngineeringOrganization';
export const M22_STATUS_COMMAND = 'ollama-agent.showEngineeringOrganizationStatus';
export const M22_DAILY_COMMAND = 'ollama-agent.showDailyScrum';

type OrganizationSnapshot = {
  requests: Array<{ id: string; storyId: string | null }>;
  sprints: EngineeringSprintRecord[];
  assignments: EngineeringAssignmentRecord[];
  ci: EngineeringCiEvidenceRecord[];
};

/**
 * M37 live-route composition. Core owns every durable lifecycle fact. M19
 * supplies only configured worker identities, M15 is a fenced worktree
 * executor projection, and M22 observes GitHub only when the user explicitly
 * synchronizes. No M22 JSON organization state is read or written here.
 */
export class M22EngineeringOrganizationController implements vscode.Disposable {
  private projectId: string | undefined;
  private board: GhM22EngineeringBoard | undefined;

  constructor(
    private readonly workspaceRoot: string,
    private readonly runtime: AutonomousTaskRuntime,
    private readonly coreManager: CoreManager,
  ) {}

  start(): void {
    // AgentPanel owns activation-time attempt rehydration through Core's
    // existing fenced recovery path. This controller remains a read/dispatch
    // adapter and never races it by claiming a second worker after restart.
  }

  dispose(): void {}

  async provision(showMessage = true): Promise<{ projectId: string }> {
    const projectId = await this.ensureProject();
    if (showMessage) vscode.window.showInformationMessage('KarkeDikha Core engineering lifecycle is ready.');
    return { projectId };
  }

  async runSprint(): Promise<unknown> {
    const { projectId } = await this.provision(false);
    const title = await vscode.window.showInputBox({ title: 'Approved product request', prompt: 'What should this sprint deliver?' });
    if (!title?.trim()) return { status: 'cancelled' };
    const goal = await vscode.window.showInputBox({ title: 'Product request goal', prompt: 'State the bounded outcome and acceptance evidence.', value: title.trim() });
    if (!goal?.trim()) return { status: 'cancelled' };
    const client = this.requireClient();
    const request = await client.createEngineeringProductRequest({
      projectId,
      title: title.trim(),
      goal: goal.trim(),
      acceptanceCriteria: ['A governed draft pull request exists.', 'Validation and review evidence are recorded.', 'Human merge remains external.'],
      definitionOfReady: ['Scope is explicit.', 'Validation is named.'],
      definitionOfDone: ['Replacement CI succeeds when repair is required.', 'A human merge is observed.'],
      estimatedPoints: 3,
    });
    const approved = await client.approveEngineeringProductRequest(request.id);
    const planned = await client.planEngineeringSprint({
      projectId,
      name: `Autonomous Sprint ${new Date().toISOString().slice(0, 10)}`,
      goal: goal.trim(),
      capacityPoints: 3,
      wipLimit: 1,
      storyIds: [approved.storyId],
    });
    await client.startEngineeringSprint(planned.sprint.id);
    const assignment = await this.dispatch(planned.sprint.id);
    vscode.window.showInformationMessage(assignment
      ? 'Core sprint started and its governed worker projection is running.'
      : 'Core sprint started with no currently dispatchable story.');
    return { requestId: request.id, sprint: planned.sprint, assignment };
  }

  /** Explicit sync only: M22 observes GitHub, then submits typed facts to Core.
   * There is intentionally no background GitHub polling loop. */
  async sync(showMessage = true): Promise<unknown> {
    const snapshot = await this.coreSnapshot();
    const observed = await this.observeCiFailures(snapshot.assignments);
    const refreshed = await this.coreSnapshot();
    if (showMessage) vscode.window.showInformationMessage(`Core engineering lifecycle synchronized: ${observed} CI incident(s) ingested.`);
    return { organization: refreshed, observed };
  }

  async boardSnapshot(): Promise<unknown> {
    return this.coreSnapshot();
  }

  async status(): Promise<unknown> {
    const summary = await this.coreSnapshot();
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(summary, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
    return summary;
  }

  async dailyScrum(): Promise<unknown> {
    const snapshot = await this.coreSnapshot();
    const active = snapshot.assignments.filter(item => item.state === 'active');
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: ['# Daily Scrum', '', `Generated: ${new Date().toISOString()}`, '', '## Active assignments', ...(active.length ? active.map(item => `- ${item.storyId}: ${item.workerId} (lease ends ${item.leaseExpiresAt})`) : ['- None']), '', '## CI incidents', ...(snapshot.ci.length ? snapshot.ci.map(item => `- ${item.runId}: ${item.conclusion}`) : ['- None'])].join('\n'),
    });
    await vscode.window.showTextDocument(document, { preview: true });
    return snapshot;
  }

  private requireClient(): CoreClient {
    const client = this.coreManager.getClient();
    if (!client) throw new Error('KarkeDikha Core is not connected.');
    return client;
  }

  private projectName(): string {
    return `Engineering: ${path.basename(this.workspaceRoot) || 'workspace'}`;
  }

  private async ensureProject(): Promise<string> {
    if (this.projectId) return this.projectId;
    const client = this.requireClient();
    const board = await client.fetchBoardSnapshot();
    const existing = board.projects.find(project => project.name === this.projectName());
    if (existing) return this.projectId = existing.id;
    const created = await client.request<{ id: string }>('/v1/projects', { method: 'POST', body: { name: this.projectName() } });
    return this.projectId = created.id;
  }

  private async existingProjectId(): Promise<string | undefined> {
    if (this.projectId) return this.projectId;
    const board = await this.requireClient().fetchBoardSnapshot();
    const existing = board.projects.find(project => project.name === this.projectName());
    return existing ? (this.projectId = existing.id) : undefined;
  }

  private async coreSnapshot(): Promise<OrganizationSnapshot> {
    const projectId = await this.existingProjectId();
    if (!projectId) return { requests: [], sprints: [], assignments: [], ci: [] };
    return this.requireClient().engineeringSnapshot(projectId);
  }

  private async dispatch(sprintId: string): Promise<EngineeringAssignmentRecord | undefined> {
    const workforce = await loadM19WorkforceConfig(this.workspaceRoot);
    // The governed KarkeDikha executor is the built-in worker; configured M19
    // workers add deterministic identities but never become a second runtime.
    const workerIds = workforce.workers.filter(worker => worker.enabled).map(worker => worker.id);
    if (!workerIds.length) workerIds.push('karkedikha-core');
    const assignment = await this.requireClient().dispatchEngineeringSprint(sprintId, {
      workerIds,
      leaseMs: 120_000,
      workspaceRoot: this.workspaceRoot,
      selectedProvider: Config.getProviderType(),
      selectedModel: Config.getCodingModel(),
    });
    if (assignment) await this.restoreAssignmentProjection(assignment);
    return assignment;
  }

  /** Creates the initial M15 execution projection after Core has atomically
   * created the assignment. Restart recovery is deliberately handled by the
   * existing AgentPanel Core rehydrator, not by a second controller path. */
  private async restoreAssignmentProjection(assignment: EngineeringAssignmentRecord): Promise<boolean> {
    if (!assignment.attemptId || this.runtime.hasCoreAuthority(assignment.attemptId)) return false;
    const client = this.requireClient();
    const attempt = await client.getAttempt(assignment.attemptId);
    const context = await client.getAttemptContext(assignment.attemptId);
    const queue = this.runtime.getQueue();
    const local = await queue.get(assignment.attemptId);
    if (!local) {
      if (attempt.status !== 'created' && attempt.status !== 'queued' && attempt.status !== 'recovery_required') {
        throw new Error(`Core attempt '${attempt.id}' has no recoverable execution projection.`);
      }
      const projected = createDefaultAutonomousTask(this.workspaceRoot, context.taskInput);
      await queue.enqueue({
        ...projected,
        taskId: attempt.id,
        attemptId: attempt.id,
        providerModelRoutingSnapshot: { ...projected.providerModelRoutingSnapshot, provider: context.selectedProvider, model: context.selectedModel },
      });
    }
    const owner = `m37-worker-${assignment.workerId}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    const claim = await client.claimKarkeDikhaAttempt(attempt.id, { owner, leaseMs: 120_000 });
    const credentials = { fenceToken: claim.fence.token, owner, frozenContextHash: claim.context.contextHash };
    this.runtime.bindCoreAuthority(attempt.id, this.authority(client, attempt.id, claim.context, credentials));
    this.runtime.wake();
    return true;
  }

  private authority(client: CoreClient, attemptId: string, context: AttemptContextRecord, credentials: CoreKarkeDikhaWorkerCredentials): KarkeDikhaLifecycleAuthority {
    return {
      context,
      heartbeat: () => client.heartbeatKarkeDikhaAttempt(attemptId, credentials).then(() => undefined),
      requestApproval: async (kind, summary) => (await client.requestKarkeDikhaApproval(attemptId, credentials, { kind, summary })).approval,
      resolveApproval: async (approval, resolution, disposition) => { await client.resolveKarkeDikhaApproval(approval, credentials, { resolution, disposition }); },
      beginValidation: () => client.beginKarkeDikhaValidation(attemptId, credentials).then(() => undefined),
      reportValidation: (evidence: KarkeDikhaValidationEvidence) => client.reportKarkeDikhaValidation(attemptId, credentials, evidence),
      recordExecutionQuality: (evidence: ExecutionQualityEvidenceInput) => client.recordKarkeDikhaExecutionQuality(attemptId, credentials, evidence).then(() => undefined),
      complete: summary => client.completeKarkeDikhaAttempt(attemptId, credentials, summary).then(() => undefined),
      fail: reason => client.failKarkeDikhaAttempt(attemptId, credentials, reason).then(() => undefined),
      cancel: () => client.cancelKarkeDikhaAttempt(attemptId, credentials).then(() => undefined),
    };
  }

  private async observeCiFailures(assignments: EngineeringAssignmentRecord[]): Promise<number> {
    let observed = 0;
    const board = await this.githubBoard();
    if (!board) return observed;
    for (const assignment of assignments.filter(item => item.attemptId)) {
      const task = await this.runtime.getQueue().get(assignment.attemptId!);
      const url = task?.githubDelivery.pullRequestUrl;
      if (!url) continue;
      let observation: PullRequestObservation;
      try {
        observation = await board.observePullRequest(url);
      } catch (error) {
        Logger.warn(`[M37] GitHub observation deferred for ${url}:`, error);
        continue;
      }
      if (!isFailure(observation.ci.state)) continue;
      await this.requireClient().ingestEngineeringCiFailure({
          storyId: assignment.storyId,
          sourceAttemptId: assignment.attemptId,
          pullRequestUrl: observation.pullRequestUrl,
          headSha: observation.headCommit,
          runId: observation.pipelineId,
          failedChecks: observation.ci.failedChecks.map(check => check.name),
          errorSummary: observation.ci.failedChecks.map(check => `${check.name}: ${check.summary}`).join('; ') || 'CI failed without a reported check summary.',
      });
      observed += 1;
    }
    return observed;
  }

  private async githubBoard(): Promise<GhM22EngineeringBoard | undefined> {
    if (this.board) return this.board;
    const remote = await new Promise<string>((resolve, reject) => {
      const child = require('node:child_process').execFile('git', ['remote', 'get-url', 'origin'], { cwd: this.workspaceRoot, windowsHide: true }, (error: Error | null, stdout: string) => error ? reject(error) : resolve(stdout));
      child.unref?.();
    }).catch(() => undefined);
    const match = remote?.trim().replace(/\.git$/i, '').match(/github\.com[/:]([^/]+)\/([^/]+)$/);
    if (!match) return undefined;
    return this.board = new GhM22EngineeringBoard(this.workspaceRoot, `${match[1]}/${match[2]}`);
  }
}

function isFailure(state: string): boolean {
  return state === 'failure' || state === 'cancelled' || state === 'action-required';
}
