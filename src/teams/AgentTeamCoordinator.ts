import { randomUUID } from 'crypto';

export type TeamTaskStatus = 'pending' | 'claimed' | 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked';
export type TeamAgentStatus = 'idle' | 'working' | 'stopped';
export type TeamMessageType = 'handoff' | 'question' | 'answer' | 'evidence' | 'conflict' | 'status';

export interface AgentBudget {
  maxModelCalls: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxOutputBytes: number;
}

export interface AgentPermissionContract {
  readablePaths: string[];
  writablePaths: string[];
  allowedTools: string[];
  networkAllowed: boolean;
}

export interface TeamAgentDefinition {
  id: string;
  role: string;
  model: string;
  contextId: string;
  capabilities: string[];
  budget: AgentBudget;
  permissions: AgentPermissionContract;
}

export interface TeamTaskDefinition {
  id: string;
  goal: string;
  dependencies?: string[];
  requiredCapabilities?: string[];
  writePaths?: string[];
  preferredAgentId?: string;
  priority?: number;
  contextSeed?: Record<string, unknown>;
}

export interface TeamTaskState extends TeamTaskDefinition {
  status: TeamTaskStatus;
  claimedBy?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: Record<string, unknown>;
}

export interface TeamMessage {
  id: string;
  from: string;
  to: string;
  type: TeamMessageType;
  timestamp: string;
  taskId?: string;
  payload: Record<string, unknown>;
}

export interface AgentExecutionContext {
  agent: TeamAgentDefinition;
  task: TeamTaskState;
  signal: AbortSignal;
  receiveMessages(): TeamMessage[];
  sendMessage(to: string, type: TeamMessageType, payload: Record<string, unknown>): TeamMessage;
  reportEvidence(payload: Record<string, unknown>): TeamMessage;
}

export type TeamAgentExecutor = (context: AgentExecutionContext) => Promise<Record<string, unknown> | void>;

export interface AgentTeamRunResult {
  schemaVersion: 1;
  startedAt: string;
  completedAt: string;
  tasks: TeamTaskState[];
  messages: TeamMessage[];
  deadlockDetected: boolean;
  cancelled: boolean;
}

export interface AgentTeamCoordinatorOptions {
  maxAgents?: number;
  maxTasks?: number;
  maxMessages?: number;
}

export class AgentTeamCoordinator {
  private readonly agents = new Map<string, TeamAgentDefinition>();
  private readonly agentStatus = new Map<string, TeamAgentStatus>();
  private readonly tasks = new Map<string, TeamTaskState>();
  private readonly messages: TeamMessage[] = [];
  private readonly mailboxCursor = new Map<string, number>();
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly maxAgents: number;
  private readonly maxTasks: number;
  private readonly maxMessages: number;
  private cancelled = false;

  constructor(options: AgentTeamCoordinatorOptions = {}) {
    this.maxAgents = options.maxAgents ?? 16;
    this.maxTasks = options.maxTasks ?? 500;
    this.maxMessages = options.maxMessages ?? 10_000;
  }

  registerAgent(agent: TeamAgentDefinition): void {
    validateAgent(agent);
    if (this.agents.has(agent.id)) throw new Error(`Agent already registered: ${agent.id}`);
    if (this.agents.size >= this.maxAgents) throw new Error('Agent team size limit reached.');
    for (const existing of this.agents.values()) {
      if (existing.contextId === agent.contextId) throw new Error(`Agent context must be isolated: ${agent.contextId}`);
    }
    this.agents.set(agent.id, cloneAgent(agent));
    this.agentStatus.set(agent.id, 'idle');
    this.mailboxCursor.set(agent.id, 0);
  }

  proposeTasks(definitions: readonly TeamTaskDefinition[]): TeamTaskState[] {
    if (this.tasks.size + definitions.length > this.maxTasks) throw new Error('Team task limit reached.');
    const proposed = definitions.map(definition => normalizeTask(definition));
    const allIds = new Set([...this.tasks.keys(), ...proposed.map(task => task.id)]);
    for (const task of proposed) {
      if (this.tasks.has(task.id) || proposed.filter(candidate => candidate.id === task.id).length > 1) {
        throw new Error(`Duplicate team task: ${task.id}`);
      }
      for (const dependency of task.dependencies ?? []) {
        if (!allIds.has(dependency)) throw new Error(`Task ${task.id} depends on missing task ${dependency}.`);
      }
      if (task.preferredAgentId && !this.agents.has(task.preferredAgentId)) {
        throw new Error(`Task ${task.id} prefers unknown agent ${task.preferredAgentId}.`);
      }
    }
    assertAcyclic([...this.tasks.values(), ...proposed]);
    assertNoParallelWriteOverlap([...this.tasks.values(), ...proposed]);
    for (const task of proposed) this.tasks.set(task.id, task);
    return proposed.map(cloneTask);
  }

  claimNext(agentId: string): TeamTaskState | undefined {
    const agent = this.requireAgent(agentId);
    if (this.cancelled || this.agentStatus.get(agentId) === 'stopped') return undefined;
    if (this.agentStatus.get(agentId) === 'working') throw new Error(`Agent is already working: ${agentId}`);
    const candidates = [...this.tasks.values()]
      .filter(task => task.status === 'pending')
      .filter(task => (task.dependencies ?? []).every(id => this.tasks.get(id)?.status === 'completed'))
      .filter(task => agentCanClaim(agent, task))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id));
    const task = candidates[0];
    if (!task) return undefined;
    task.status = 'claimed';
    task.claimedBy = agentId;
    this.agentStatus.set(agentId, 'working');
    return cloneTask(task);
  }

  async run(executor: TeamAgentExecutor): Promise<AgentTeamRunResult> {
    const startedAt = new Date().toISOString();
    this.cancelled = false;
    const workers = [...this.agents.keys()].map(agentId => this.runAgent(agentId, executor));
    await Promise.all(workers);
    const deadlockDetected = this.detectDeadlock();
    if (deadlockDetected) {
      for (const task of this.tasks.values()) {
        if (task.status === 'pending') task.status = 'blocked';
      }
    }
    return {
      schemaVersion: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      tasks: this.listTasks(),
      messages: this.listMessages(),
      deadlockDetected,
      cancelled: this.cancelled,
    };
  }

  cancel(): boolean {
    if (this.cancelled) return false;
    this.cancelled = true;
    for (const controller of this.activeControllers.values()) controller.abort();
    for (const task of this.tasks.values()) {
      if (task.status === 'pending' || task.status === 'claimed' || task.status === 'running') task.status = 'cancelled';
    }
    return true;
  }

  sendMessage(from: string, to: string, type: TeamMessageType, payload: Record<string, unknown>, taskId?: string): TeamMessage {
    this.requireAgent(from);
    this.requireAgent(to);
    if (this.messages.length >= this.maxMessages) throw new Error('Agent team message limit reached.');
    const message: TeamMessage = {
      id: randomUUID(),
      from,
      to,
      type,
      timestamp: new Date().toISOString(),
      taskId,
      payload: structuredCloneSafe(payload),
    };
    this.messages.push(message);
    return cloneMessage(message);
  }

  receiveMessages(agentId: string): TeamMessage[] {
    this.requireAgent(agentId);
    const cursor = this.mailboxCursor.get(agentId) ?? 0;
    const received = this.messages.slice(cursor).filter(message => message.to === agentId);
    this.mailboxCursor.set(agentId, this.messages.length);
    return received.map(cloneMessage);
  }

  listTasks(): TeamTaskState[] {
    return [...this.tasks.values()].map(cloneTask).sort((left, right) => left.id.localeCompare(right.id));
  }

  listMessages(): TeamMessage[] {
    return this.messages.map(cloneMessage);
  }

  snapshot(): { agents: Array<TeamAgentDefinition & { status: TeamAgentStatus }>; tasks: TeamTaskState[]; messages: TeamMessage[] } {
    return {
      agents: [...this.agents.values()].map(agent => ({ ...cloneAgent(agent), status: this.agentStatus.get(agent.id) ?? 'stopped' })),
      tasks: this.listTasks(),
      messages: this.listMessages(),
    };
  }

  private async runAgent(agentId: string, executor: TeamAgentExecutor): Promise<void> {
    while (!this.cancelled) {
      const claimed = this.claimNext(agentId);
      if (!claimed) {
        if (this.hasRunnableOrActiveWork()) {
          await delay(5);
          continue;
        }
        return;
      }
      const task = this.tasks.get(claimed.id)!;
      const agent = this.requireAgent(agentId);
      task.status = 'running';
      task.startedAt = new Date().toISOString();
      const controller = new AbortController();
      this.activeControllers.set(agentId, controller);
      let timedOut = false;
      let timer: NodeJS.Timeout | undefined;
      try {
        const execution = executor({
          agent: cloneAgent(agent),
          task: cloneTask(task),
          signal: controller.signal,
          receiveMessages: () => this.receiveMessages(agentId),
          sendMessage: (to, type, payload) => this.sendMessage(agentId, to, type, payload, task.id),
          reportEvidence: payload => this.sendMessage(agentId, agentId, 'evidence', payload, task.id),
        });
        const cancellation = new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(teamAbortError(timedOut ? `Agent ${agentId} exceeded its wall-clock budget.` : 'Agent execution cancelled.'));
          }, { once: true });
        });
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, agent.budget.maxWallClockMs);
        const result = await Promise.race([execution, cancellation]);
        const output = result ? structuredCloneSafe(result) : {};
        const outputBytes = Buffer.byteLength(JSON.stringify(output), 'utf8');
        if (outputBytes > agent.budget.maxOutputBytes) {
          throw new Error(`Agent ${agentId} exceeded its output budget.`);
        }
        task.status = 'completed';
        task.result = output;
        task.completedAt = new Date().toISOString();
      } catch (error) {
        task.status = this.cancelled ? 'cancelled' : 'failed';
        task.error = error instanceof Error ? error.message : String(error);
        task.completedAt = new Date().toISOString();
      } finally {
        if (timer) clearTimeout(timer);
        this.activeControllers.delete(agentId);
        this.agentStatus.set(agentId, this.cancelled ? 'stopped' : 'idle');
      }
    }
  }

  private hasRunnableOrActiveWork(): boolean {
    if ([...this.tasks.values()].some(task => task.status === 'running' || task.status === 'claimed')) return true;
    return [...this.tasks.values()].some(task =>
      task.status === 'pending' &&
      (task.dependencies ?? []).every(id => this.tasks.get(id)?.status === 'completed') &&
      [...this.agents.values()].some(agent =>
        this.agentStatus.get(agent.id) !== 'stopped' && agentCanClaim(agent, task),
      ),
    );
  }

  private detectDeadlock(): boolean {
    const pending = [...this.tasks.values()].filter(task => task.status === 'pending');
    if (pending.length === 0) return false;
    return pending.every(task => {
      const dependencyBlocked = (task.dependencies ?? []).some(id => this.tasks.get(id)?.status !== 'completed');
      const capableAgent = [...this.agents.values()].some(agent => agentCanClaim(agent, task));
      return dependencyBlocked || !capableAgent;
    });
  }

  private requireAgent(id: string): TeamAgentDefinition {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`Unknown team agent: ${id}`);
    return agent;
  }
}

function normalizeTask(task: TeamTaskDefinition): TeamTaskState {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(task.id)) throw new Error(`Invalid team task id: ${task.id}`);
  if (!task.goal.trim()) throw new Error(`Team task goal is required: ${task.id}`);
  return {
    ...task,
    dependencies: [...new Set(task.dependencies ?? [])].sort(),
    requiredCapabilities: [...new Set(task.requiredCapabilities ?? [])].sort(),
    writePaths: [...new Set((task.writePaths ?? []).map(normalizePath))].sort(),
    contextSeed: task.contextSeed ? structuredCloneSafe(task.contextSeed) : undefined,
    status: 'pending',
    priority: task.priority ?? 0,
  };
}

function validateAgent(agent: TeamAgentDefinition): void {
  if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(agent.id)) throw new Error(`Invalid agent id: ${agent.id}`);
  if (!agent.contextId || !agent.model || !agent.role) throw new Error(`Agent identity is incomplete: ${agent.id}`);
  for (const value of Object.values(agent.budget)) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid budget for agent ${agent.id}.`);
  }
  agent.permissions.readablePaths.forEach(normalizePath);
  agent.permissions.writablePaths.forEach(normalizePath);
}

function assertAcyclic(tasks: TeamTaskState[]): void {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (task: TeamTaskState) => {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) throw new Error(`Team task dependency cycle at ${task.id}.`);
    visiting.add(task.id);
    for (const dependency of task.dependencies ?? []) {
      const found = byId.get(dependency);
      if (found) visit(found);
    }
    visiting.delete(task.id);
    visited.add(task.id);
  };
  tasks.forEach(visit);
}

function assertNoParallelWriteOverlap(tasks: TeamTaskState[]): void {
  for (let leftIndex = 0; leftIndex < tasks.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < tasks.length; rightIndex += 1) {
      const left = tasks[leftIndex];
      const right = tasks[rightIndex];
      if (dependsOn(left, right.id) || dependsOn(right, left.id)) continue;
      for (const leftPath of left.writePaths ?? []) {
        for (const rightPath of right.writePaths ?? []) {
          if (pathsOverlap(leftPath, rightPath)) {
            throw new Error(`Parallel team tasks ${left.id} and ${right.id} overlap write path ${leftPath} / ${rightPath}.`);
          }
        }
      }
    }
  }
}

function dependsOn(task: TeamTaskState, candidate: string): boolean {
  return (task.dependencies ?? []).includes(candidate);
}

function agentCanClaim(agent: TeamAgentDefinition, task: TeamTaskState): boolean {
  return (!task.preferredAgentId || task.preferredAgentId === agent.id) &&
    (task.requiredCapabilities ?? []).every(capability => agent.capabilities.includes(capability)) &&
    pathsAllowed(task.writePaths ?? [], agent.permissions.writablePaths);
}

function pathsAllowed(requested: string[], allowed: string[]): boolean {
  if (requested.length === 0) return true;
  return requested.every(request => allowed.some(root => request === root || request.startsWith(`${root}/`)));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function normalizePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized || normalized === '..' || normalized.startsWith('../') || normalized.includes('/../') || normalized.startsWith('/')) {
    throw new Error(`Invalid team path: ${value}`);
  }
  return normalized;
}

function cloneAgent(agent: TeamAgentDefinition): TeamAgentDefinition {
  return {
    ...agent,
    capabilities: [...agent.capabilities],
    budget: { ...agent.budget },
    permissions: {
      ...agent.permissions,
      readablePaths: [...agent.permissions.readablePaths],
      writablePaths: [...agent.permissions.writablePaths],
      allowedTools: [...agent.permissions.allowedTools],
    },
  };
}

function cloneTask(task: TeamTaskState): TeamTaskState {
  return {
    ...task,
    dependencies: [...(task.dependencies ?? [])],
    requiredCapabilities: [...(task.requiredCapabilities ?? [])],
    writePaths: [...(task.writePaths ?? [])],
    contextSeed: task.contextSeed ? structuredCloneSafe(task.contextSeed) : undefined,
    result: task.result ? structuredCloneSafe(task.result) : undefined,
  };
}

function cloneMessage(message: TeamMessage): TeamMessage {
  return { ...message, payload: structuredCloneSafe(message.payload) };
}

function structuredCloneSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function teamAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
