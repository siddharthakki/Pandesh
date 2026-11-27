import { AgentStateMachine, statusToDefaultPhase } from './AgentStateMachine';
import {
  AgentPhase,
  AgentTaskSnapshot,
  DEFAULT_TASK_BUDGETS,
  TaskBudgets,
  TaskUsage,
  createInitialUsage,
} from './AgentEngineTypes';
import { TaskStore } from './TaskStore';
import { ObservabilityHub } from '../observability/ObservabilityHub';
import { OperationsService, OperationsSnapshot } from '../observability/OperationsService';

const RETIRED =
  'This task ran in the retired in-extension agent and cannot be continued. Use Retry to start a new Core attempt with the same goal.';

function isTerminal(phase: AgentPhase): boolean {
  return phase === 'completed' || phase === 'failed' || phase === 'cancelled';
}

/**
 * Read and state-only controls over the tasks the retired in-extension agent persisted under `.ollama-agent/tasks`.
 * Nothing here executes work: chat and tasks run in Pandesh Core, and Karke Dikha runs through the M15 runtime. This only
 * lets the panel list, inspect, pause, cancel and archive those older records; continuing one is refused with a clear message.
 */
export class LegacyTaskControls {
  readonly taskStore: TaskStore;
  private readonly machine: AgentStateMachine;
  private readonly operations: OperationsService;

  constructor(workspaceRoot: string) {
    this.taskStore = new TaskStore(workspaceRoot);
    this.machine = new AgentStateMachine(this.taskStore);
    this.operations = new OperationsService({
      listTasks: () => this.listTasks(),
      listWorktreeLeases: async () => [],
      activity: () => ({
        readOnlyBatchActive: false,
        writeBatchActive: false,
        integrationsActive: 0,
        sandboxesActive: 0,
        rpcServicesActive: 0,
        mcpRegistriesActive: 0,
      }),
    }, new ObservabilityHub({ capacity: 50 }));
  }

  isRunning(): boolean { return false; }
  getTaskId(): string | null { return null; }
  clearSession(): void { /* no live local session exists */ }
  stop(): void { /* no live local run exists */ }

  async getTask(taskId: string): Promise<AgentTaskSnapshot> {
    const task = await this.taskStore.getTask(taskId);
    if (!task) { throw new Error(`Task not found: ${taskId}`); }
    const approvals = await this.taskStore.getCurrentApprovals(taskId);
    const checkpoints = await this.taskStore.getCheckpointRefs(taskId);
    return {
      task,
      phase: task.phase ?? statusToDefaultPhase(task.status),
      budgets: { ...DEFAULT_TASK_BUDGETS, ...(task.engineBudgets ?? {}) } as TaskBudgets,
      usage: { ...createInitialUsage(task.startedAt ?? task.createdAt), ...(task.engineUsage ?? {}) } as TaskUsage,
      pendingApproval: approvals.find(approval => approval.status === 'pending'),
      checkpoints,
      blockedReason: task.blockedReason,
      validationPassed: task.validationPassed,
    };
  }

  async listTasks(): Promise<AgentTaskSnapshot[]> {
    const tasks = await this.taskStore.listTasks();
    return Promise.all(tasks.map(task => this.getTask(task.taskId)));
  }

  getOperationsSnapshot(): Promise<OperationsSnapshot> {
    return this.operations.snapshot();
  }

  async pauseTask(taskId: string): Promise<AgentTaskSnapshot> {
    const snapshot = await this.getTask(taskId);
    if (isTerminal(snapshot.phase) || snapshot.phase === 'paused') { return snapshot; }
    await this.machine.transition(taskId, 'paused', { reason: 'user_pause', resumePhase: snapshot.phase });
    await this.taskStore.appendEvent(taskId, 'task_paused', { previousPhase: snapshot.phase });
    return this.getTask(taskId);
  }

  async cancelTask(taskId: string): Promise<AgentTaskSnapshot> {
    const snapshot = await this.getTask(taskId);
    if (isTerminal(snapshot.phase)) { return snapshot; }
    await this.machine.transition(taskId, 'cancelled', { reason: 'user_cancel' });
    await this.taskStore.appendEvent(taskId, 'task_cancelled', { reason: 'user_cancel' });
    return this.getTask(taskId);
  }

  async resumeTask(taskId: string): Promise<AgentTaskSnapshot> {
    await this.getTask(taskId);
    throw new Error(RETIRED);
  }

  async sendSteering(taskId: string, _message: string): Promise<AgentTaskSnapshot> {
    await this.getTask(taskId);
    throw new Error(RETIRED);
  }

  async respondToApproval(_approvalId: string, _decision: 'approved' | 'rejected'): Promise<void> {
    throw new Error('No local approval is pending. Approvals now come from Core.');
  }
}
