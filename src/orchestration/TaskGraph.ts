import * as fs from 'fs/promises';
import * as path from 'path';

export const TASK_GRAPH_SCHEMA_VERSION = 1 as const;

export type TaskNodeStatus =
  | 'proposed'
  | 'ready'
  | 'running'
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'cancelled'
  | 'skipped';

export type TaskGraphStatus =
  | 'proposed'
  | 'approved'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskExecutionMode = 'single' | 'sequential' | 'parallel-read' | 'parallel-write';
export type TaskMutationPolicy = 'none' | 'workspace' | 'worktree';

export interface TaskNodeResult {
  summary: string;
  evidence?: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export interface TaskNode {
  id: string;
  role: string;
  objective: string;
  dependencies: string[];
  allowedPaths: string[];
  capabilities: string[];
  executionMode: TaskExecutionMode;
  mutationPolicy: TaskMutationPolicy;
  validation: string[];
  status: TaskNodeStatus;
  provider?: string;
  model?: string;
  result?: TaskNodeResult;
  error?: string;
}

export interface TaskGraph {
  schemaVersion: typeof TASK_GRAPH_SCHEMA_VERSION;
  taskId: string;
  status: TaskGraphStatus;
  createdAt: string;
  updatedAt: string;
  nodes: TaskNode[];
}

export interface TaskGraphValidation {
  valid: boolean;
  errors: string[];
  order: string[];
}

export interface TaskGraphExecutor {
  execute(node: Readonly<TaskNode>, context: TaskGraphExecutionContext): Promise<Omit<TaskNodeResult, 'startedAt' | 'completedAt'>>;
}

export interface TaskGraphExecutionContext {
  taskId: string;
  signal: AbortSignal;
  dependencyResults: ReadonlyMap<string, TaskNodeResult>;
}

export interface TaskGraphRunOptions {
  signal?: AbortSignal;
  stopOnFailure?: boolean;
}

export interface TaskGraphStorage {
  load(taskId: string): Promise<TaskGraph | null>;
  save(graph: TaskGraph): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeScope(scope: string): string {
  const normalized = scope.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '.') {
    return '**/*';
  }
  if (path.posix.isAbsolute(normalized) || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error(`Task path scope must be workspace-relative: ${scope}`);
  }
  return normalized;
}

function validateNode(node: TaskNode, errors: string[]): void {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(node.id)) {
    errors.push(`Invalid node id: ${node.id}`);
  }
  if (!node.role.trim()) {
    errors.push(`Node ${node.id} has no role.`);
  }
  if (!node.objective.trim()) {
    errors.push(`Node ${node.id} has no objective.`);
  }
  if (node.dependencies.includes(node.id)) {
    errors.push(`Node ${node.id} depends on itself.`);
  }
  if (node.mutationPolicy === 'none' && node.executionMode === 'parallel-write') {
    errors.push(`Node ${node.id} cannot use parallel-write with a read-only mutation policy.`);
  }
  for (const scope of node.allowedPaths) {
    try {
      normalizeScope(scope);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
}

export function topologicalOrder(nodes: readonly TaskNode[]): string[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const indegree = new Map<string, number>();
  const dependants = new Map<string, string[]>();

  for (const node of nodes) {
    indegree.set(node.id, node.dependencies.length);
    for (const dependency of node.dependencies) {
      const children = dependants.get(dependency) ?? [];
      children.push(node.id);
      dependants.set(dependency, children);
    }
  }

  const ready = [...nodes]
    .filter(node => (indegree.get(node.id) ?? 0) === 0)
    .map(node => node.id)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift()!;
    order.push(current);
    const children = [...(dependants.get(current) ?? [])].sort();
    for (const child of children) {
      if (!byId.has(child)) {
        continue;
      }
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (order.length !== nodes.length) {
    throw new Error('Task graph contains a dependency cycle.');
  }
  return order;
}

export function validateTaskGraph(graph: TaskGraph): TaskGraphValidation {
  const errors: string[] = [];
  if (graph.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) {
    errors.push(`Unsupported task graph schema version: ${graph.schemaVersion}`);
  }
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(graph.taskId)) {
    errors.push(`Invalid task id: ${graph.taskId}`);
  }
  if (graph.nodes.length === 0) {
    errors.push('Task graph must contain at least one node.');
  }

  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) {
      errors.push(`Duplicate node id: ${node.id}`);
    }
    ids.add(node.id);
    validateNode(node, errors);
  }

  for (const node of graph.nodes) {
    for (const dependency of node.dependencies) {
      if (!ids.has(dependency)) {
        errors.push(`Node ${node.id} depends on missing node ${dependency}.`);
      }
    }
  }

  let order: string[] = [];
  if (errors.length === 0) {
    try {
      order = topologicalOrder(graph.nodes);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { valid: errors.length === 0, errors, order };
}

export function createSingleNodeGraph(taskId: string, objective: string, role = 'implementer'): TaskGraph {
  const timestamp = nowIso();
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    taskId,
    status: 'proposed',
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [{
      id: 'main',
      role,
      objective,
      dependencies: [],
      allowedPaths: ['**/*'],
      capabilities: [],
      executionMode: 'single',
      mutationPolicy: 'workspace',
      validation: [],
      status: 'proposed',
    }],
  };
}

export class FileTaskGraphStorage implements TaskGraphStorage {
  constructor(private readonly taskDirectory: (taskId: string) => string) {}

  async load(taskId: string): Promise<TaskGraph | null> {
    const filename = this.filename(taskId);
    try {
      const parsed = JSON.parse(await fs.readFile(filename, 'utf8')) as TaskGraph;
      const validation = validateTaskGraph(parsed);
      if (!validation.valid) {
        throw new Error(`Invalid persisted task graph: ${validation.errors.join(' ')}`);
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async save(graph: TaskGraph): Promise<void> {
    const validation = validateTaskGraph(graph);
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join(' ')}`);
    }
    graph.updatedAt = nowIso();
    const filename = this.filename(graph.taskId);
    await fs.mkdir(path.dirname(filename), { recursive: true });
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filename);
  }

  private filename(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
      throw new Error(`Invalid task id: ${taskId}`);
    }
    return path.join(this.taskDirectory(taskId), 'task-graph.json');
  }
}

export class TaskGraphCoordinator {
  constructor(private readonly storage: TaskGraphStorage) {}

  async propose(graph: TaskGraph): Promise<TaskGraph> {
    const normalized: TaskGraph = {
      ...graph,
      status: 'proposed',
      updatedAt: nowIso(),
      nodes: graph.nodes.map(node => ({
        ...node,
        dependencies: [...new Set(node.dependencies)],
        allowedPaths: [...new Set(node.allowedPaths.map(normalizeScope))],
        capabilities: [...new Set(node.capabilities)],
        validation: [...new Set(node.validation)],
        status: 'proposed',
        result: undefined,
        error: undefined,
      })),
    };
    const validation = validateTaskGraph(normalized);
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join(' ')}`);
    }
    await this.storage.save(normalized);
    return normalized;
  }

  async approve(taskId: string): Promise<TaskGraph> {
    const graph = await this.requireGraph(taskId);
    if (graph.status !== 'proposed') {
      throw new Error(`Only proposed task graphs can be approved; current status is ${graph.status}.`);
    }
    graph.status = 'approved';
    graph.nodes = graph.nodes.map(node => ({ ...node, status: node.dependencies.length === 0 ? 'ready' : 'proposed' }));
    await this.storage.save(graph);
    return graph;
  }

  async replaceProposed(taskId: string, nodes: TaskNode[]): Promise<TaskGraph> {
    const current = await this.requireGraph(taskId);
    if (current.status !== 'proposed') {
      throw new Error('An approved or running task graph cannot be edited in place.');
    }
    return this.propose({ ...current, nodes });
  }

  async run(taskId: string, executor: TaskGraphExecutor, options: TaskGraphRunOptions = {}): Promise<TaskGraph> {
    const graph = await this.requireGraph(taskId);
    if (graph.status !== 'approved' && graph.status !== 'running') {
      throw new Error(`Task graph ${taskId} must be approved before execution.`);
    }

    const validation = validateTaskGraph(graph);
    if (!validation.valid) {
      throw new Error(`Invalid task graph: ${validation.errors.join(' ')}`);
    }

    graph.status = 'running';
    await this.storage.save(graph);
    const results = new Map<string, TaskNodeResult>();
    for (const node of graph.nodes) {
      if (node.result) {
        results.set(node.id, node.result);
      }
    }

    for (const nodeId of validation.order) {
      const node = graph.nodes.find(candidate => candidate.id === nodeId)!;
      if (node.status === 'completed') {
        continue;
      }
      if (options.signal?.aborted) {
        await this.cancelRemaining(graph);
        return graph;
      }

      const failedDependency = node.dependencies.find(dependency => {
        const dependencyNode = graph.nodes.find(candidate => candidate.id === dependency);
        return dependencyNode?.status !== 'completed';
      });
      if (failedDependency) {
        node.status = 'blocked';
        node.error = `Dependency ${failedDependency} did not complete.`;
        await this.storage.save(graph);
        if (options.stopOnFailure !== false) {
          graph.status = 'failed';
          await this.storage.save(graph);
          return graph;
        }
        continue;
      }

      node.status = 'running';
      node.error = undefined;
      await this.storage.save(graph);
      const startedAt = nowIso();
      try {
        const result = await executor.execute(node, {
          taskId,
          signal: options.signal ?? new AbortController().signal,
          dependencyResults: new Map(node.dependencies.map(dependency => [dependency, results.get(dependency)!])),
        });
        node.result = { ...result, startedAt, completedAt: nowIso() };
        node.status = 'completed';
        results.set(node.id, node.result);
        for (const candidate of graph.nodes) {
          if (candidate.status === 'proposed' && candidate.dependencies.every(dependency => results.has(dependency))) {
            candidate.status = 'ready';
          }
        }
        await this.storage.save(graph);
      } catch (error) {
        node.status = options.signal?.aborted ? 'cancelled' : 'failed';
        node.error = error instanceof Error ? error.message : String(error);
        graph.status = options.signal?.aborted ? 'cancelled' : 'failed';
        await this.storage.save(graph);
        if (options.stopOnFailure !== false || options.signal?.aborted) {
          return graph;
        }
      }
    }

    graph.status = graph.nodes.every(node => node.status === 'completed') ? 'completed' : 'failed';
    await this.storage.save(graph);
    return graph;
  }

  async cancel(taskId: string): Promise<TaskGraph> {
    const graph = await this.requireGraph(taskId);
    await this.cancelRemaining(graph);
    return graph;
  }

  private async cancelRemaining(graph: TaskGraph): Promise<void> {
    graph.status = 'cancelled';
    for (const node of graph.nodes) {
      if (!['completed', 'failed', 'skipped'].includes(node.status)) {
        node.status = 'cancelled';
      }
    }
    await this.storage.save(graph);
  }

  private async requireGraph(taskId: string): Promise<TaskGraph> {
    const graph = await this.storage.load(taskId);
    if (!graph) {
      throw new Error(`Task graph ${taskId} does not exist.`);
    }
    return graph;
  }
}
