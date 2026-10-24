import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  DurableTaskQueue,
  defaultDeliveryPolicy,
} from '../autonomous/M15AutonomousWork';
import type { AutonomousLifecycleState, AutonomousTask } from '../autonomous/M15AutonomousWork';
import {
  checkDefinitionOfDone,
  checkDefinitionOfReady,
  JsonBoardEventStore,
  JsonIssueLeaseStore,
  defaultM18ControlPlanePaths,
} from '../scrum/M18ScrumControlPlane';
import type { ScrumBoardStatus, ScrumIssueRecord } from '../scrum/M18ScrumControlPlane';
import {
  AgentRegistry,
  defaultCommandAdapters,
  HermesWorkforceCoordinator,
  KarkeDikhaAgentAdapter,
} from '../workforce/M19AgentWorkforceRuntime';
import type {
  AgentExecutionState,
  AgentModelRoute,
  AgentTaskRequest,
  AgentWorkerDefinition,
} from '../workforce/M19AgentWorkforceRuntime';
import {
  AutonomousSprintEngine,
  JsonSprintStore,
  defaultM20SprintStatePath,
} from '../sprint/M20AutonomousSprint';
import type {
  DailyScrumSummary,
  SprintBoardReporter,
  SprintDefinition,
  SprintStory,
} from '../sprint/M20AutonomousSprint';
import {
  CIBugRepairLoop,
  JsonRepairLoopStore,
  defaultM21RepairLoopPath,
} from '../repair/M21CIBugRepairLoop';
import type {
  BugPublisher,
  PipelineResult,
  RepairAgentAssigner,
  RepairOutcome,
} from '../repair/M21CIBugRepairLoop';

export interface VerifiedMerge {
  pullRequestUrl: string;
  merged: boolean;
  mergedAt?: string;
  mergedBy?: string;
}

export interface M22BoardGateway extends SprintBoardReporter, BugPublisher {
  provision(): Promise<{ projectNumber: number; projectUrl?: string }>;
  listReadyIssues(): Promise<ScrumIssueRecord[]>;
  issue(number: number): Promise<ScrumIssueRecord>;
  transition(issue: Pick<ScrumIssueRecord, 'number'>, status: ScrumBoardStatus, message: string): Promise<void>;
  verifyMergedPullRequest(pullRequestUrl: string): Promise<VerifiedMerge>;
}

export interface M22RuntimeWake {
  wake(): void;
}

export interface M22OrganizationOptions {
  repositoryRoot: string;
  repository: string;
  baseBranch: string;
  validationCommands: string[];
  codingRoute: AgentModelRoute;
  maxConcurrent: number;
  leaseTtlMs: number;
  blockedEscalationMs: number;
  additionalWorkers?: AgentWorkerDefinition[];
  now?: () => Date;
}

export interface M22IssueBinding {
  issueKey: string;
  issueNumber: number;
  storyId: string;
  sprintId?: string;
  leaseToken: string;
  taskId?: string;
  pullRequestUrl?: string;
  state: 'leased' | 'active' | 'review' | 'blocked' | 'done';
  updatedAt: string;
}

export interface M22SprintReport {
  sprintId: string;
  generatedAt: string;
  dailySummaryCount: number;
  completedIssues: number[];
  reviewIssues: number[];
  blockedIssues: number[];
  deliveredPoints: number;
  plannedPoints: number;
  retrospectiveActions: string[];
}

export interface M22OrganizationState {
  schemaVersion: 1;
  repository: string;
  activeSprintId?: string;
  bindings: M22IssueBinding[];
  reports: M22SprintReport[];
  updatedAt: string;
}

export class JsonM22OrganizationStore {
  constructor(private readonly filePath: string) {}

  async load(repository: string): Promise<M22OrganizationState> {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as M22OrganizationState;
      if (parsed.schemaVersion !== 1 || parsed.repository !== repository || !Array.isArray(parsed.bindings)) {
        throw new Error('Invalid M22 organization state.');
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return {
        schemaVersion: 1,
        repository,
        bindings: [],
        reports: [],
        updatedAt: new Date(0).toISOString(),
      };
    }
  }

  async save(state: M22OrganizationState): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.filePath);
  }
}

export interface M22ProductionComposition {
  organization: M22SelfDogfoodOrganization;
  workforce: HermesWorkforceCoordinator;
  registry: AgentRegistry;
  sprint: AutonomousSprintEngine;
  repair: CIBugRepairLoop;
}

export function createM22ProductionComposition(
  board: M22BoardGateway,
  queue: DurableTaskQueue,
  runtime: M22RuntimeWake,
  options: M22OrganizationOptions,
): M22ProductionComposition {
  const now = options.now ?? (() => new Date());
  const registry = new AgentRegistry(now);
  for (const adapter of defaultCommandAdapters()) registry.registerAdapter(adapter);

  const requestTaskIds = new Map<string, string>();
  const karkedikhaAdapter = new KarkeDikhaAgentAdapter({
    queue: async (request, route, worker) => {
      const issue = parseIssueReference(request.payloadReference, options.repository);
      const task = await queue.enqueue({
        origin: 'github-issue',
        taskKind: 'mutating',
        repositoryRoot: options.repositoryRoot,
        repositoryId: options.repository,
        sourceIssue: issue ? {
          owner: issue.owner,
          repo: issue.repo,
          issueNumber: issue.number,
          url: `https://github.com/${issue.owner}/${issue.repo}/issues/${issue.number}`,
        } : undefined,
        goal: request.goal,
        instructions: buildKarkeDikhaInstructions(request, worker),
        priority: request.role === 'repairer' ? 'high' : 'normal',
        maxRetries: 2,
        providerModelRoutingSnapshot: {
          provider: route.provider,
          model: route.model,
          worker: worker.id,
          role: request.role,
          adapter: 'karkedikha',
        },
        permissionProfile: 'normal',
        validationRequirements: options.validationCommands.map(command => ({ command, required: true })),
        deliveryPolicy: defaultDeliveryPolicy(),
        notificationPolicy: { enabled: true, persisted: true },
        githubDelivery: {
          transport: 'gh-cli',
          remote: 'origin',
          baseBranch: options.baseBranch,
        },
      });
      const managed = await queue.update({
        ...task,
        evidence: [...task.evidence, 'organization:m22', `m19-request:${request.requestId}`],
      }, 'm22_workforce_task_queued', {
        requestId: request.requestId,
        workerId: worker.id,
        role: request.role,
      });
      requestTaskIds.set(request.requestId, managed.taskId);
      runtime.wake();
      return { taskId: managed.taskId };
    },
    status: async taskId => {
      const task = await queue.get(taskId);
      if (!task) return undefined;
      return {
        state: mapAutonomousState(task.state),
        outputSummary: task.terminalResult?.summary,
        errorSummary: task.failure?.message,
      };
    },
    cancel: async (taskId, reason) => {
      const task = await queue.get(taskId);
      if (!task || isAutonomousTerminal(task.state)) return false;
      await queue.requestCancellation(taskId);
      await queue.recordProgress(taskId, `M22 cancellation requested: ${reason}`);
      runtime.wake();
      return true;
    },
  });
  registry.registerAdapter(karkedikhaAdapter);

  const primaryWorker: AgentWorkerDefinition = {
    id: 'karkedikha.engineering-worker',
    name: 'KarkeDikha Governed Engineering Worker',
    adapter: 'karkedikha',
    roles: ['analyst', 'planner', 'implementer', 'reviewer', 'validator', 'repairer'],
    capabilities: ['coding', 'ci-repair', 'review', 'validation', 'repository-analysis'],
    permissions: [
      'repository:read',
      'worktree:write',
      'validation:run',
      'github:read',
      'github:comment',
      'github:draft-pr',
      'network:model',
    ],
    models: [{ ...options.codingRoute }],
    maxConcurrent: Math.max(1, options.maxConcurrent),
    heartbeatTimeoutMs: 60_000,
    enabled: true,
  };
  registry.registerWorker(primaryWorker);
  for (const worker of options.additionalWorkers ?? []) registry.registerWorker(worker);

  const pulseWorkers = (): void => {
    for (const entry of registry.listWorkers()) {
      if (!entry.definition.enabled) continue;
      registry.heartbeat({
        workerId: entry.definition.id,
        at: now().toISOString(),
        availableSlots: Math.max(0, entry.definition.maxConcurrent - entry.active),
        metadata: {
          adapter: entry.definition.adapter,
          governed: entry.definition.adapter === 'karkedikha',
        },
      });
    }
  };
  pulseWorkers();

  const workforce = new HermesWorkforceCoordinator(registry, {
    maxGlobalConcurrent: Math.max(1, options.maxConcurrent),
    now,
  });
  const sprint = new AutonomousSprintEngine(
    new JsonSprintStore(defaultM20SprintStatePath(options.repositoryRoot)),
    workforce,
    board,
    undefined,
    {
      repositoryRoot: options.repositoryRoot,
      blockedEscalationMs: options.blockedEscalationMs,
      now,
    },
  );

  const repairAssigner: RepairAgentAssigner = {
    assign: async (bug, pipeline, attempt) => {
      pulseWorkers();
      const request: AgentTaskRequest = {
        requestId: `m21:${bug.id}:attempt-${attempt}`,
        role: 'repairer',
        goal: [
          `Repair CI bug ${bug.issueUrl ?? bug.id}.`,
          `Failure fingerprint: ${bug.fingerprint}`,
          `Workflow: ${pipeline.workflow}`,
          `Failed checks: ${pipeline.failedChecks.join(', ') || 'unknown'}`,
          `Failing tests: ${pipeline.failingTests.join(', ') || 'unknown'}`,
          'Identify the root cause, add or identify an automated regression test, run focused validation, and create a draft PR. Do not merge.',
        ].join('\n'),
        repositoryRoot: options.repositoryRoot,
        requiredCapabilities: ['coding', 'ci-repair'],
        requiredPermissions: ['repository:read', 'worktree:write', 'validation:run', 'github:draft-pr'],
        preferredModel: options.codingRoute.model,
        timeoutMs: 45 * 60_000,
        payloadReference: bug.issueNumber ? `${options.repository}#${bug.issueNumber}` : undefined,
      };
      const handle = await workforce.dispatch(request);
      const taskId = requestTaskIds.get(request.requestId)
        ?? (await queue.list()).find(task => task.evidence.includes(`m19-request:${request.requestId}`))?.taskId;
      if (!taskId) throw new Error(`KarkeDikha did not persist repair task for ${request.requestId}.`);
      return { workerId: handle.workerId, taskId };
    },
    cancel: async (taskId, reason) => {
      const task = await queue.get(taskId);
      if (!task || isAutonomousTerminal(task.state)) return false;
      await queue.requestCancellation(taskId);
      await queue.recordProgress(taskId, `M21 repair cancellation requested: ${reason}`);
      runtime.wake();
      return true;
    },
  };
  const repair = new CIBugRepairLoop(
    new JsonRepairLoopStore(defaultM21RepairLoopPath(options.repositoryRoot)),
    board,
    repairAssigner,
    {
      maxRepairAttempts: 2,
      flakyLookback: 5,
      incidentSeverityAfterAttempts: 2,
      now,
    },
  );

  const paths = defaultM18ControlPlanePaths(options.repositoryRoot);
  const organization = new M22SelfDogfoodOrganization(
    board,
    queue,
    sprint,
    repair,
    new JsonBoardEventStore(paths.events),
    new JsonIssueLeaseStore(paths.leases, now),
    new JsonM22OrganizationStore(defaultM22OrganizationStatePath(options.repositoryRoot)),
    pulseWorkers,
    options,
  );
  return { organization, workforce, registry, sprint, repair };
}

export class M22SelfDogfoodOrganization {
  private readonly now: () => Date;

  constructor(
    private readonly board: M22BoardGateway,
    private readonly queue: DurableTaskQueue,
    private readonly sprint: AutonomousSprintEngine,
    private readonly repair: CIBugRepairLoop,
    private readonly events: JsonBoardEventStore,
    private readonly leases: JsonIssueLeaseStore,
    private readonly store: JsonM22OrganizationStore,
    private readonly pulseWorkers: () => void,
    private readonly options: M22OrganizationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async provision(): Promise<{ projectNumber: number; projectUrl?: string }> {
    return this.board.provision();
  }

  async intakeReadyIssues(): Promise<{
    accepted: SprintStory[];
    rejected: Array<{ issueNumber: number; errors: string[] }>;
  }> {
    const state = await this.store.load(this.options.repository);
    const accepted: SprintStory[] = [];
    const rejected: Array<{ issueNumber: number; errors: string[] }> = [];
    for (const issue of await this.board.listReadyIssues()) {
      const ingested = await this.events.ingest({
        id: boardEventId(issue),
        repository: issue.repository,
        issueNumber: issue.number,
        action: 'moved',
        occurredAt: issue.updatedAt ?? this.now().toISOString(),
      }, issue);
      const existing = state.bindings.find(binding => binding.issueNumber === issue.number && binding.state !== 'done');
      if (!ingested.accepted && existing) continue;

      const ready = checkDefinitionOfReady(issue);
      if (!ready.passed) {
        rejected.push({ issueNumber: issue.number, errors: ready.errors });
        await this.board.transition(issue, 'blocked', `Definition of Ready failed: ${ready.errors.join(', ')}.`);
        continue;
      }
      if (existing) continue;
      const issueKey = `${issue.repository.toLowerCase()}#${issue.number}`;
      const lease = await this.leases.claim(issueKey, 'm22-autonomous-team', this.options.leaseTtlMs);
      if (!lease) continue;
      const story = issueToSprintStory(issue);
      state.bindings.push({
        issueKey,
        issueNumber: issue.number,
        storyId: story.id,
        leaseToken: lease.token,
        state: 'leased',
        updatedAt: this.now().toISOString(),
      });
      accepted.push(story);
      await this.board.transition(
        issue,
        'in-progress',
        `M22 accepted this Ready item and acquired durable issue lease ${lease.token.slice(0, 8)}.`,
      );
    }
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
    return { accepted, rejected };
  }

  async planAndStartSprint(input: {
    name: string;
    goal: string;
    endsAt: string;
    capacityPoints: number;
    wipLimit: number;
  }): Promise<SprintDefinition | undefined> {
    this.pulseWorkers();
    const intake = await this.intakeReadyIssues();
    if (intake.accepted.length === 0) return undefined;
    const sprint = await this.sprint.planSprint({ ...input, backlog: intake.accepted });
    await this.sprint.startSprint(sprint.id);
    const state = await this.store.load(this.options.repository);
    state.activeSprintId = sprint.id;
    const storyIds = new Set(sprint.storyIds);
    for (const binding of state.bindings) {
      if (storyIds.has(binding.storyId) && !binding.sprintId) binding.sprintId = sprint.id;
    }
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
    return sprint;
  }

  async sync(): Promise<{ sprintChanges: number; repairBugs: number; activeSprintId?: string }> {
    const state = await this.store.load(this.options.repository);
    if (!state.activeSprintId) {
      return { sprintChanges: 0, repairBugs: (await this.repair.state()).bugs.length };
    }
    this.pulseWorkers();
    const result = await this.sprint.tick(state.activeSprintId);
    const tasks = await this.queue.list();
    for (const binding of state.bindings.filter(value => value.sprintId === state.activeSprintId && value.state !== 'done')) {
      const requestId = `m20:${state.activeSprintId}:${binding.storyId}`;
      const task = tasks.find(candidate => candidate.evidence.includes(`m19-request:${requestId}`))
        ?? tasks.find(candidate => candidate.sourceIssue?.issueNumber === binding.issueNumber && candidate.repositoryId === this.options.repository);
      if (task) {
        binding.taskId = task.taskId;
        binding.pullRequestUrl = task.githubDelivery.pullRequestUrl;
        binding.state = bindingStateFromTask(task);
        binding.updatedAt = this.now().toISOString();
      }
      if (binding.state === 'active' || binding.state === 'review' || binding.state === 'leased') {
        await this.leases.heartbeat(binding.issueKey, binding.leaseToken, this.options.leaseTtlMs);
      }
      if (binding.state === 'blocked') {
        await this.leases.release(binding.issueKey, binding.leaseToken);
      }
    }
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
    return {
      sprintChanges: result.changed.length + result.escalated.length,
      repairBugs: (await this.repair.state()).bugs.length,
      activeSprintId: state.activeSprintId,
    };
  }

  async ingestPipeline(result: PipelineResult): Promise<void> {
    this.pulseWorkers();
    await this.repair.ingest(result);
  }

  async recordRepairOutcome(outcome: RepairOutcome): Promise<void> {
    this.pulseWorkers();
    await this.repair.recordRepairOutcome(outcome);
  }

  async recordApprovedMerge(input: {
    issueNumber: number;
    pullRequestUrl: string;
    regressionTests?: string[];
  }): Promise<void> {
    const state = await this.store.load(this.options.repository);
    const binding = state.bindings.find(value => value.issueNumber === input.issueNumber && value.state !== 'done');
    if (!binding) throw new Error(`No active M22 binding for issue #${input.issueNumber}.`);
    const issue = await this.board.issue(input.issueNumber);
    const task = binding.taskId ? await this.queue.get(binding.taskId) : undefined;
    if (!task) throw new Error(`No autonomous task is bound to issue #${input.issueNumber}.`);
    if (task.githubDelivery.pullRequestUrl !== input.pullRequestUrl) {
      throw new Error(`Merged PR does not match task delivery PR for issue #${input.issueNumber}.`);
    }
    const merge = await this.board.verifyMergedPullRequest(input.pullRequestUrl);
    if (!merge.merged || !merge.mergedAt || !merge.mergedBy) {
      throw new Error(`Pull request has not been merged with attributable human approval: ${input.pullRequestUrl}`);
    }
    const repairState = await this.repair.state();
    const repairBug = repairState.bugs.find(bug => bug.issueNumber === input.issueNumber);
    const done = checkDefinitionOfDone(issue, {
      pullRequestUrl: input.pullRequestUrl,
      validationPassed: task.state === 'completed' && !task.validationFailure,
      ciPassed: task.githubDelivery.ci?.state === 'success',
      reviewPassed: task.diffReview?.verdict === 'pass',
      regressionTests: unique([...(input.regressionTests ?? []), ...(repairBug?.regressionTests ?? [])]),
      humanMergeApproved: true,
    });
    if (!done.passed) throw new Error(`Definition of Done failed: ${done.errors.join(', ')}.`);
    binding.state = 'done';
    binding.pullRequestUrl = input.pullRequestUrl;
    binding.updatedAt = this.now().toISOString();
    await this.leases.release(binding.issueKey, binding.leaseToken);
    await this.board.transition(
      issue,
      'done',
      `Definition of Done passed. ${merge.mergedBy} merged ${input.pullRequestUrl} at ${merge.mergedAt}.`,
    );
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
  }

  async dailyScrum(): Promise<DailyScrumSummary> {
    const state = await this.store.load(this.options.repository);
    if (!state.activeSprintId) throw new Error('No active M22 sprint.');
    return this.sprint.dailyScrum(state.activeSprintId);
  }

  async closeSprint(): Promise<M22SprintReport> {
    const state = await this.store.load(this.options.repository);
    if (!state.activeSprintId) throw new Error('No active M22 sprint.');
    const sprintId = state.activeSprintId;
    const closed = await this.sprint.closeSprint(sprintId);
    const bindings = state.bindings.filter(binding => binding.sprintId === sprintId);
    const sprintState = await this.sprint.state();
    const report: M22SprintReport = {
      sprintId,
      generatedAt: this.now().toISOString(),
      dailySummaryCount: sprintState.dailySummaries.filter(summary => summary.sprintId === sprintId).length,
      completedIssues: bindings.filter(binding => binding.state === 'done').map(binding => binding.issueNumber),
      reviewIssues: bindings.filter(binding => binding.state === 'review').map(binding => binding.issueNumber),
      blockedIssues: bindings.filter(binding => binding.state === 'blocked').map(binding => binding.issueNumber),
      deliveredPoints: closed.review.deliveredPoints,
      plannedPoints: closed.review.plannedPoints,
      retrospectiveActions: closed.retrospective.actions,
    };
    state.reports.push(report);
    state.activeSprintId = undefined;
    state.updatedAt = this.now().toISOString();
    await this.store.save(state);
    return report;
  }

  async state(): Promise<M22OrganizationState> {
    return this.store.load(this.options.repository);
  }
}

export function defaultM22OrganizationStatePath(repositoryRoot: string): string {
  return path.join(repositoryRoot, '.ollama-agent', 'engineering-organization', 'state.json');
}

function issueToSprintStory(issue: ScrumIssueRecord): SprintStory {
  return {
    id: storyIdForIssue(issue.repository, issue.number),
    externalRef: `${issue.repository}#${issue.number}`,
    title: issue.title,
    goal: issue.body,
    kind: issue.type,
    acceptanceCriteria: [...issue.acceptanceCriteria],
    dependencies: issue.dependencies.map(reference => dependencyStoryId(reference, issue.repository)),
    estimate: issue.estimate,
    priority: priorityFromLabels(issue.labels),
    requiredCapabilities: issue.type === 'bug' ? ['coding', 'ci-repair'] : ['coding'],
    role: issue.type === 'bug' ? 'repairer' : 'implementer',
    state: issue.dependencies.length === 0 ? 'ready' : 'backlog',
    progress: 0,
  };
}

function buildKarkeDikhaInstructions(request: AgentTaskRequest, worker: AgentWorkerDefinition): string {
  return [
    `M22 workforce request: ${request.requestId}`,
    `Assigned worker: ${worker.id}`,
    `Role: ${request.role}`,
    request.payloadReference ? `Source: ${request.payloadReference}` : undefined,
    request.goal,
    'Use the existing governed autonomous workflow: isolated worktree, proposal approval, mutation approval, validation, independent diff review, delivery approval, commit/push, and draft PR. Never merge automatically.',
  ].filter((value): value is string => Boolean(value)).join('\n\n');
}

function parseIssueReference(
  reference: string | undefined,
  fallbackRepository: string,
): { owner: string; repo: string; number: number } | undefined {
  const match = /^(?:([^/]+)\/([^#]+))?#(\d+)$/.exec(reference ?? '');
  const repository = match?.[1] && match[2] ? `${match[1]}/${match[2]}` : fallbackRepository;
  const number = match ? Number(match[3]) : undefined;
  const [owner, repo] = repository.split('/');
  return number && owner && repo ? { owner, repo, number } : undefined;
}

function mapAutonomousState(state: AutonomousLifecycleState): AgentExecutionState {
  if (state === 'completed') return 'completed';
  if (state === 'failed' || state === 'blocked') return 'failed';
  if (state === 'cancelled') return 'cancelled';
  if (state === 'queued' || state === 'scheduled' || state === 'waiting_for_resources') return 'queued';
  return 'running';
}

function isAutonomousTerminal(state: AutonomousLifecycleState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function bindingStateFromTask(task: AutonomousTask): M22IssueBinding['state'] {
  if (task.state === 'blocked' || task.state === 'failed' || task.state === 'cancelled') return 'blocked';
  if (task.githubDelivery.pullRequestUrl || task.state === 'waiting_for_review' || task.state === 'completed') return 'review';
  return 'active';
}

function storyIdForIssue(repository: string, number: number): string {
  return `issue-${repository.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${number}`;
}

function dependencyStoryId(reference: string, defaultRepository: string): string {
  const match = /^(?:([^/]+)\/([^#]+))?#(\d+)$/.exec(reference);
  if (!match) throw new Error(`Invalid dependency reference: ${reference}`);
  const repository = match[1] && match[2] ? `${match[1]}/${match[2]}` : defaultRepository;
  return storyIdForIssue(repository, Number(match[3]));
}

function boardEventId(issue: ScrumIssueRecord): string {
  const material = [issue.repository, issue.number, issue.updatedAt ?? '', [...issue.labels].sort().join(',')].join(':');
  return `board-${Buffer.from(material, 'utf8').toString('base64url').slice(0, 80)}`;
}

function priorityFromLabels(labels: string[]): SprintStory['priority'] {
  if (labels.includes('priority:urgent')) return 'urgent';
  if (labels.includes('priority:high')) return 'high';
  if (labels.includes('priority:low')) return 'low';
  return 'normal';
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))];
}
