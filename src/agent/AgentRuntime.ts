import * as path from 'path';
import * as vscode from 'vscode';
import { AgentMode } from '../config/ConfigSchema';
import { SerializablePermissionContext } from '../tools/PermissionContext';
import { AgentLoopEvents } from '../tools/ToolTypes';
import { TaskBudgets, ValidationCommandRequest } from './AgentEngineTypes';
import { MeasuredAgentRuntime } from '../roles/MeasuredAgentRuntime';
import {
  FileTaskGraphStorage,
  TaskGraph,
  TaskGraphCoordinator,
  TaskGraphExecutor,
  TaskGraphRunOptions,
  TaskNode,
} from '../orchestration/TaskGraph';
import {
  ReadOnlySubAgentPoolOptions,
  ReadOnlySubAgentBatchResult,
  ReadOnlySubAgentExecutor,
  ReadOnlySubAgentPool,
  ReadOnlySubAgentTask,
} from '../orchestration/ReadOnlySubAgentPool';
import {
  ParallelWriteBatchResult,
  ParallelWriteCoordinator,
  ParallelWriteCoordinatorOptions,
  ParallelWriteExecutor,
  ParallelWriteTask,
  ParallelWriteValidator,
} from '../orchestration/ParallelWriteCoordinator';
import { WorktreeLease, WorktreeManager } from '../orchestration/WorktreeManager';
import {
  CloudApproval,
  FileProviderRouteStorage,
  ProviderEndpoint,
  ProviderExecutionContext,
  ProviderRouteRequest,
  ProviderScheduler,
} from '../orchestration/ProviderScheduler';
import {
  FileIntegrationResultStorage,
  IntegrationBackend,
  IntegrationCoordinator,
  IntegrationCoordinatorOptions,
  IntegrationRequest,
  IntegrationResult,
  IntegrationValidator,
} from '../orchestration/IntegrationCoordinator';
import { LocalRpcDispatcher } from '../runtime/LocalRpcServer';
import { RpcServiceLifecycle, RpcTransportHost } from '../runtime/RpcServiceLifecycle';
import {
  FileSandboxResultStorage,
  SandboxBackend,
  SandboxExecutionResult,
  SandboxRequest,
  SandboxRunner,
  SandboxRunnerOptions,
} from '../sandbox/SandboxRunner';
import { PolicyEngine } from '../policy/PolicyEngine';
import {
  FileMcpAuditStorage,
  McpRegistry,
  McpRegistryOptions,
  McpServerDefinition,
  McpTransport,
} from '../mcp/McpRegistry';
import { JsonlObservationStorage, ObservabilityHub } from '../observability/ObservabilityHub';
import { OperationsService, OperationsSnapshot } from '../observability/OperationsService';
import {
  createWorkspaceDiagnostics,
  DiagnosticRepairResult,
  DiagnosticReport,
  SelfDiagnostics,
} from '../diagnostics/SelfDiagnostics';
import {
  JarvisControlAdapter,
  JarvisControlPlane,
  registerJarvisControlRpc,
} from '../control/JarvisControlPlane';
import { ForgeInvocationReference } from './ForgeInvocationAdapter';
import {
  composeGovernedForgeExecution,
  GovernedForgeExecutionComposition,
} from './ForgeGovernedExecutionComposition';
import { registerForgeCallableRpc } from './ForgeRpcRegistration';

/**
 * Backward-compatible runtime used by the existing VS Code webview.
 * Advanced orchestration remains explicit and approval-gated.
 */
export class AgentRuntime extends MeasuredAgentRuntime {
  private readonly taskGraphs: TaskGraphCoordinator;
  private readonly worktrees: WorktreeManager;
  private readonly observability: ObservabilityHub;
  private readonly operations: OperationsService;
  private readonly diagnostics: SelfDiagnostics;
  private activeReadOnlyPool?: ReadOnlySubAgentPool;
  private activeWriteCoordinator?: ParallelWriteCoordinator;
  private readonly activeIntegrations = new Set<IntegrationCoordinator>();
  private readonly activeSandboxes = new Set<SandboxRunner>();
  private readonly rpcServices = new Set<RpcServiceLifecycle>();
  private readonly mcpRegistries = new Set<McpRegistry>();

  constructor(
    private readonly orchestrationWorkspaceRoot: string,
    private readonly governedExecutionSecrets: vscode.SecretStorage,
  ) {
    super(orchestrationWorkspaceRoot, governedExecutionSecrets);
    this.taskGraphs = new TaskGraphCoordinator(
      new FileTaskGraphStorage(taskId => this.taskStore.getTaskDir(taskId)),
    );
    this.worktrees = new WorktreeManager(orchestrationWorkspaceRoot);
    this.observability = new ObservabilityHub({
      capacity: 500,
      storage: new JsonlObservationStorage(
        path.join(this.orchestrationStateRoot(), 'observations.jsonl'),
      ),
    });
    this.operations = new OperationsService({
      listTasks: () => this.listTasks(),
      listWorktreeLeases: () => this.listWorktreeLeases(),
      activity: () => this.operationsActivity(),
    }, this.observability);
    this.diagnostics = createWorkspaceDiagnostics(orchestrationWorkspaceRoot, {
      secrets: governedExecutionSecrets,
    });
    void this.observability.record({ category: 'system', name: 'runtime.created' });
  }

  async run(
    text: string,
    mode: AgentMode,
    events: AgentLoopEvents,
    images?: string[],
    modelOverride?: string,
    taskId?: string,
    settings: { validationCommands?: ValidationCommandRequest[]; allowedPaths?: string[]; permissionContext?: SerializablePermissionContext } = {},
    budgetOverrides?: Partial<TaskBudgets>,
  ): Promise<void> {
    const started = Date.now();
    await this.observability.record({
      category: 'task',
      name: 'run.started',
      taskId,
      data: { mode, hasImages: Boolean(images?.length), modelOverride: modelOverride ?? 'auto' },
    });
    try {
      await super.run(text, mode, events, images, modelOverride, taskId, settings, budgetOverrides);
      await this.observability.record({
        category: 'task',
        name: 'run.completed',
        taskId: this.getTaskId() ?? taskId,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      await this.observability.record({
        category: 'task',
        name: 'run.failed',
        level: 'error',
        taskId: this.getTaskId() ?? taskId,
        durationMs: Date.now() - started,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
      throw error;
    }
  }

  stop(): void {
    this.activeReadOnlyPool?.cancel();
    this.activeWriteCoordinator?.cancel();
    for (const coordinator of this.activeIntegrations) coordinator.cancel();
    for (const runner of this.activeSandboxes) runner.cancel();
    for (const registry of this.mcpRegistries) registry.cancelAll();
    for (const service of this.rpcServices) void service.stop();
    this.diagnostics.cancel();
    void this.observability.record({ category: 'system', name: 'runtime.stopped', level: 'warning' });
    super.stop();
  }

  proposeTaskGraph(graph: TaskGraph): Promise<TaskGraph> {
    void this.observability.record({ category: 'task', name: 'graph.proposed', taskId: graph.taskId });
    return this.taskGraphs.propose(graph);
  }

  approveTaskGraph(taskId: string): Promise<TaskGraph> {
    void this.observability.record({ category: 'task', name: 'graph.approved', taskId });
    return this.taskGraphs.approve(taskId);
  }

  replaceProposedTaskGraph(taskId: string, nodes: TaskNode[]): Promise<TaskGraph> {
    return this.taskGraphs.replaceProposed(taskId, nodes);
  }

  runTaskGraph(taskId: string, executor: TaskGraphExecutor, options?: TaskGraphRunOptions): Promise<TaskGraph> {
    return this.taskGraphs.run(taskId, executor, options);
  }

  cancelTaskGraph(taskId: string): Promise<TaskGraph> {
    return this.taskGraphs.cancel(taskId);
  }

  async runReadOnlySubAgents(
    tasks: readonly ReadOnlySubAgentTask[],
    executor: ReadOnlySubAgentExecutor,
    options: ReadOnlySubAgentPoolOptions = {},
  ): Promise<ReadOnlySubAgentBatchResult> {
    if (this.activeReadOnlyPool) throw new Error('A read-only sub-agent batch is already active.');
    const pool = new ReadOnlySubAgentPool(options);
    this.activeReadOnlyPool = pool;
    const started = Date.now();
    await this.observability.record({ category: 'task', name: 'readonly-batch.started', data: { tasks: tasks.length } });
    try {
      const result = await pool.run(tasks, executor);
      await this.observability.record({ category: 'task', name: 'readonly-batch.completed', durationMs: Date.now() - started });
      return result;
    } finally {
      if (this.activeReadOnlyPool === pool) this.activeReadOnlyPool = undefined;
    }
  }

  async runParallelWriteAgents(
    tasks: readonly ParallelWriteTask[],
    executor: ParallelWriteExecutor,
    validator: ParallelWriteValidator,
    options: ParallelWriteCoordinatorOptions = {},
  ): Promise<ParallelWriteBatchResult> {
    if (this.activeWriteCoordinator) throw new Error('A parallel write-agent batch is already active.');
    const coordinator = new ParallelWriteCoordinator(this.orchestrationWorkspaceRoot, this.worktrees, options);
    this.activeWriteCoordinator = coordinator;
    const started = Date.now();
    await this.observability.record({ category: 'worktree', name: 'write-batch.started', data: { tasks: tasks.length } });
    try {
      const result = await coordinator.run(tasks, executor, validator);
      await this.observability.record({ category: 'worktree', name: 'write-batch.completed', durationMs: Date.now() - started, data: { cancelled: result.cancelled } });
      return result;
    } finally {
      if (this.activeWriteCoordinator === coordinator) this.activeWriteCoordinator = undefined;
    }
  }

  listWorktreeLeases(): Promise<WorktreeLease[]> { return this.worktrees.listLeases(); }

  async discardWorktreeTask(taskId: string): Promise<void> {
    await this.worktrees.cleanup(taskId);
    await this.observability.record({ category: 'worktree', name: 'lease.discarded', taskId });
  }

  createProviderScheduler(cloudApproval?: CloudApproval): ProviderScheduler {
    return new ProviderScheduler({
      cloudApproval,
      auditStorage: new FileProviderRouteStorage(path.join(this.orchestrationStateRoot(), 'provider-routes.jsonl')),
    });
  }

  registerProviderEndpoint(scheduler: ProviderScheduler, endpoint: ProviderEndpoint): void {
    scheduler.register(endpoint);
    void this.observability.record({ category: 'provider', name: 'endpoint.registered', data: { endpointId: endpoint.id, kind: endpoint.kind, privacy: endpoint.privacy } });
  }

  runScheduledProvider<T>(
    scheduler: ProviderScheduler,
    request: ProviderRouteRequest,
    operation: (context: ProviderExecutionContext) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return scheduler.execute(request, operation, signal);
  }

  async integrateCandidates(
    backend: IntegrationBackend,
    request: IntegrationRequest,
    validator: IntegrationValidator,
    options: Omit<IntegrationCoordinatorOptions, 'storage'> = {},
  ): Promise<IntegrationResult> {
    const coordinator = new IntegrationCoordinator(backend, {
      ...options,
      storage: new FileIntegrationResultStorage(path.join(this.orchestrationStateRoot(), 'integrations')),
    });
    this.activeIntegrations.add(coordinator);
    const started = Date.now();
    await this.observability.record({ category: 'integration', name: 'integration.started', data: { integrationId: request.integrationId, candidates: request.candidates.length } });
    try {
      const result = await coordinator.integrate(request, validator);
      await this.observability.record({ category: 'integration', name: 'integration.completed', durationMs: Date.now() - started, data: { integrationId: request.integrationId, status: result.status } });
      return result;
    } finally {
      this.activeIntegrations.delete(coordinator);
    }
  }

  createRpcService(accessKey: string, requestTimeoutMs?: number): RpcServiceLifecycle {
    const dispatcher = new LocalRpcDispatcher(accessKey, { requestTimeoutMs });
    dispatcher.register('runtime.ping', async () => ({ ok: true }));
    dispatcher.register('runtime.worktrees.list', async () => this.listWorktreeLeases());
    registerJarvisControlRpc(dispatcher, this.createJarvisControlPlane());
    // M5.2: exactly one governed Forge composition per RPC service, composed
    // here at construction and retained by the registered handlers for the
    // service's lifetime - never re-composed inside a request handler, so
    // every request reaches the same registry, transport, adapter,
    // dispatcher and reservation state.
    registerForgeCallableRpc(dispatcher, this.composeGovernedForgeExecution().transport);
    const service = new RpcServiceLifecycle(dispatcher);
    this.rpcServices.add(service);
    void this.observability.record({ category: 'rpc', name: 'service.created' });
    return service;
  }

  async startRpcService(service: RpcServiceLifecycle, host: RpcTransportHost): Promise<string> {
    const address = await service.start(host);
    await this.observability.record({ category: 'rpc', name: 'service.started', data: { address } });
    return address;
  }

  async stopRpcService(service: RpcServiceLifecycle): Promise<void> {
    await service.stop();
    this.rpcServices.delete(service);
    await this.observability.record({ category: 'rpc', name: 'service.stopped' });
  }

  async runSandbox(
    backend: SandboxBackend,
    request: SandboxRequest,
    options: Omit<SandboxRunnerOptions, 'storage'> = {},
  ): Promise<SandboxExecutionResult> {
    const runner = new SandboxRunner(this.orchestrationWorkspaceRoot, backend, {
      ...options,
      storage: new FileSandboxResultStorage(path.join(this.orchestrationStateRoot(), 'sandbox')),
    });
    this.activeSandboxes.add(runner);
    const started = Date.now();
    await this.observability.record({ category: 'sandbox', name: 'execution.started', data: { executionId: request.executionId, mode: request.mode } });
    try {
      const result = await runner.run(request);
      await this.observability.record({ category: 'sandbox', name: 'execution.completed', durationMs: Date.now() - started, data: { executionId: request.executionId, status: result.status } });
      return result;
    } finally {
      this.activeSandboxes.delete(runner);
    }
  }

  createMcpRegistry(options: Omit<McpRegistryOptions, 'auditStorage'> = {}): McpRegistry {
    const registry = new McpRegistry(new PolicyEngine(), {
      ...options,
      auditStorage: new FileMcpAuditStorage(path.join(this.orchestrationStateRoot(), 'mcp-invocations.jsonl')),
    });
    this.mcpRegistries.add(registry);
    void this.observability.record({ category: 'mcp', name: 'registry.created' });
    return registry;
  }

  registerMcpServer(registry: McpRegistry, server: McpServerDefinition, transport: McpTransport): void {
    registry.register(server, transport);
    void this.observability.record({ category: 'mcp', name: 'server.registered', data: { serverId: server.id, location: server.location } });
  }

  disposeMcpRegistry(registry: McpRegistry): void {
    registry.cancelAll();
    this.mcpRegistries.delete(registry);
    void this.observability.record({ category: 'mcp', name: 'registry.disposed' });
  }

  getOperationsSnapshot(): Promise<OperationsSnapshot> {
    return this.operations.snapshot();
  }

  async runSelfDiagnostics(): Promise<DiagnosticReport> {
    await this.observability.record({ category: 'diagnostic', name: 'run.started' });
    const report = await this.diagnostics.run();
    await this.observability.record({ category: 'diagnostic', name: 'run.completed', level: report.healthy ? 'info' : 'warning', data: { healthy: report.healthy, findings: report.findings.length } });
    return report;
  }

  async repairDiagnostic(repairId: string, approved: boolean): Promise<DiagnosticRepairResult> {
    const result = await this.diagnostics.repair(repairId, approved);
    await this.observability.record({ category: 'diagnostic', name: 'repair.completed', level: result.status === 'failed' ? 'error' : result.status === 'denied' ? 'warning' : 'info', data: { repairId, status: result.status, changedPaths: result.changedPaths } });
    return result;
  }

  /**
   * M5.1 - Production entry point for the governed Forge execution graph:
   * `this` is the production `LocalAgentEngine` the invocation adapter reads
   * and executes through, and the runtime's own `SecretStorage` backs
   * provider resolution via
   * `ProviderGatewayGovernedModelExecutionDependency.forSecrets`. Purely
   * constructs and connects existing objects; see
   * `composeGovernedForgeExecution` for the construction-time inertness
   * guarantee. Deliberately not observability-recorded so composition
   * persists nothing. Each call composes a fresh independent graph;
   * `createRpcService` calls this exactly once per RPC service (M5.2) and
   * retains that one composition for the service's lifetime. No listener is
   * started by composing or by RPC registration.
   */
  composeGovernedForgeExecution(
    invocations: readonly ForgeInvocationReference[] = [],
  ): GovernedForgeExecutionComposition {
    return composeGovernedForgeExecution({
      engine: this,
      secrets: this.governedExecutionSecrets,
      invocations,
    });
  }

  createJarvisControlPlane(): JarvisControlPlane {
    const adapter: JarvisControlAdapter = {
      health: async () => ({
        ok: true,
        running: this.isRunning(),
        workspace: path.basename(this.orchestrationWorkspaceRoot),
        activity: this.operationsActivity(),
      }),
      operationsSnapshot: () => this.getOperationsSnapshot(),
      listTasks: async () => (await this.listTasks()).map(snapshot => ({
        taskId: snapshot.task.taskId,
        title: snapshot.task.title,
        status: snapshot.task.status,
        phase: snapshot.phase,
        updatedAt: snapshot.task.updatedAt,
      })),
      pauseTask: taskId => this.pauseTask(taskId),
      resumeTask: taskId => this.resumeTask(taskId),
      cancelTask: taskId => this.cancelTask(taskId),
      listWorktrees: () => this.listWorktreeLeases(),
      discardWorktree: taskId => this.discardWorktreeTask(taskId),
      runDiagnostics: () => this.runSelfDiagnostics(),
      repairDiagnostic: (repairId, approved) => this.repairDiagnostic(repairId, approved),
    };
    return new JarvisControlPlane(adapter);
  }

  private operationsActivity() {
    return {
      readOnlyBatchActive: Boolean(this.activeReadOnlyPool),
      writeBatchActive: Boolean(this.activeWriteCoordinator),
      integrationsActive: this.activeIntegrations.size,
      sandboxesActive: this.activeSandboxes.size,
      rpcServicesActive: this.rpcServices.size,
      mcpRegistriesActive: this.mcpRegistries.size,
    };
  }

  private orchestrationStateRoot(): string {
    return path.join(this.orchestrationWorkspaceRoot, '.ollama-agent', 'tasks', '_orchestration');
  }
}
