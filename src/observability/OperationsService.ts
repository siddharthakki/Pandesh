import { ObservabilityHub, ObservabilitySnapshot } from './ObservabilityHub';

export interface OperationsTaskSource {
  listTasks(): Promise<Array<{
    task: {
      taskId: string;
      title?: string;
      userGoal: string;
      status: string;
      model: string;
      createdAt: string;
      updatedAt: string;
      pendingApprovalId?: string;
      failure?: { message: string; code?: string; timestamp: string };
    };
    phase: string;
    usage: {
      modelCalls: number;
      toolCalls: number;
      repairAttempts: number;
      outputBytes: number;
    };
    budgets: {
      maxModelCalls: number;
      maxToolCalls: number;
      maxRepairAttempts: number;
      maxOutputBytes: number;
      maxWallClockMs: number;
      maxNoProgressSteps: number;
    };
    validationPassed?: boolean;
    blockedReason?: string;
  }>>;
  listWorktreeLeases(): Promise<Array<{
    taskId: string;
    branch: string;
    status: string;
    allowedPaths: string[];
    createdAt: string;
  }>>;
  activity(): OperationsActivity;
}

export interface OperationsActivity {
  readOnlyBatchActive: boolean;
  writeBatchActive: boolean;
  integrationsActive: number;
  sandboxesActive: number;
  rpcServicesActive: number;
  mcpRegistriesActive: number;
}

export interface OperationsTaskSummary {
  taskId: string;
  title: string;
  /** Full, untruncated user objective. The UI may visually clamp previews, but
   * inspection/copy/history surfaces must never reconstruct the task contract
   * from the shortened title. */
  objective: string;
  status: string;
  phase: string;
  model: string;
  updatedAt: string;
  validationPassed?: boolean;
  blockedReason?: string;
  pendingApprovalId?: string;
  failure?: { message: string; code?: string; timestamp: string };
  usage: {
    modelCalls: number;
    toolCalls: number;
    repairAttempts: number;
    outputBytes: number;
  };
  utilization: {
    modelCalls: number;
    toolCalls: number;
    repairAttempts: number;
    outputBytes: number;
  };
}

export interface OperationsSnapshot {
  schemaVersion: 1;
  generatedAt: string;
  totals: {
    tasks: number;
    running: number;
    blocked: number;
    completed: number;
    retainedWorktrees: number;
  };
  activity: OperationsActivity;
  tasks: OperationsTaskSummary[];
  worktrees: Array<{
    taskId: string;
    branch: string;
    status: string;
    allowedPaths: string[];
    createdAt: string;
  }>;
  observations: ObservabilitySnapshot;
}

export class OperationsService {
  constructor(
    private readonly source: OperationsTaskSource,
    private readonly observability: ObservabilityHub,
  ) {}

  async snapshot(taskLimit = 50): Promise<OperationsSnapshot> {
    const [taskResult, worktreeResult] = await Promise.allSettled([
      this.source.listTasks(),
      this.source.listWorktreeLeases(),
    ]);
    const tasks = taskResult.status === 'fulfilled' ? taskResult.value : [];
    const worktrees = worktreeResult.status === 'fulfilled' ? worktreeResult.value : [];

    const summaries = tasks
      .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))
      .slice(0, Math.max(1, Math.min(taskLimit, 200)))
      .map(snapshot => ({
        taskId: snapshot.task.taskId,
        title: snapshot.task.title ?? snapshot.task.userGoal.slice(0, 80),
        objective: snapshot.task.userGoal,
        status: snapshot.task.status,
        phase: snapshot.phase,
        model: snapshot.task.model,
        updatedAt: snapshot.task.updatedAt,
        validationPassed: snapshot.validationPassed,
        blockedReason: snapshot.blockedReason,
        pendingApprovalId: snapshot.task.pendingApprovalId,
        failure: snapshot.task.failure,
        usage: { ...snapshot.usage },
        utilization: {
          modelCalls: ratio(snapshot.usage.modelCalls, snapshot.budgets.maxModelCalls),
          toolCalls: ratio(snapshot.usage.toolCalls, snapshot.budgets.maxToolCalls),
          repairAttempts: ratio(snapshot.usage.repairAttempts, snapshot.budgets.maxRepairAttempts),
          outputBytes: ratio(snapshot.usage.outputBytes, snapshot.budgets.maxOutputBytes),
        },
      }));

    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      totals: {
        tasks: tasks.length,
        running: tasks.filter(value => value.task.status === 'running').length,
        blocked: tasks.filter(value => value.task.status === 'blocked' || value.phase === 'blocked').length,
        completed: tasks.filter(value => value.task.status === 'completed' || value.phase === 'completed').length,
        retainedWorktrees: worktrees.length,
      },
      activity: this.source.activity(),
      tasks: summaries,
      worktrees: worktrees.map(lease => ({
        ...lease,
        allowedPaths: [...lease.allowedPaths],
      })),
      observations: this.observability.snapshot(100),
    };
  }
}

function ratio(used: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) { return 0; }
  return Math.max(0, Math.min(1, used / limit));
}
