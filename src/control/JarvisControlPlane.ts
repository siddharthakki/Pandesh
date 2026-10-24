import { LocalRpcDispatcher } from '../runtime/LocalRpcServer';
import { DiagnosticReport, DiagnosticRepairResult } from '../diagnostics/SelfDiagnostics';
import { OperationsSnapshot } from '../observability/OperationsService';

export type JarvisAction =
  | 'capabilities'
  | 'health'
  | 'operations.snapshot'
  | 'tasks.list'
  | 'tasks.pause'
  | 'tasks.resume'
  | 'tasks.cancel'
  | 'worktrees.list'
  | 'worktrees.discard'
  | 'diagnostics.run'
  | 'diagnostics.repair';

export interface JarvisControlRequest {
  requestId: string;
  action: JarvisAction;
  params?: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface JarvisControlResponse {
  schemaVersion: 1;
  requestId: string;
  action: JarvisAction;
  status: 'completed' | 'denied' | 'failed';
  result?: unknown;
  error?: string;
  replayed?: boolean;
}

export interface JarvisTaskSummary {
  taskId: string;
  title?: string;
  status: string;
  phase: string;
  updatedAt: string;
}

export interface JarvisControlAdapter {
  health(): Promise<Record<string, unknown>>;
  operationsSnapshot(): Promise<OperationsSnapshot>;
  listTasks(): Promise<JarvisTaskSummary[]>;
  pauseTask(taskId: string): Promise<unknown>;
  resumeTask(taskId: string): Promise<unknown>;
  cancelTask(taskId: string): Promise<unknown>;
  listWorktrees(): Promise<unknown[]>;
  discardWorktree(taskId: string): Promise<void>;
  runDiagnostics(): Promise<DiagnosticReport>;
  repairDiagnostic(repairId: string, approved: boolean): Promise<DiagnosticRepairResult>;
}

export interface JarvisCapabilityManifest {
  schemaVersion: 1;
  service: 'ollama-agent';
  protocol: 'jarvis-control-v1';
  readActions: JarvisAction[];
  mutationActions: JarvisAction[];
  arbitraryCommands: false;
  arbitraryTools: false;
  mutationApprovalRequired: true;
  idempotencyRequiredForMutations: true;
}

export type JarvisMutationApproval = (request: Readonly<JarvisControlRequest>) => Promise<boolean>;

export interface JarvisControlOptions {
  maxReplayEntries?: number;
  approveMutation?: JarvisMutationApproval;
}

interface ReplayEntry {
  fingerprint: string;
  response: JarvisControlResponse;
}

const READ_ACTIONS = new Set<JarvisAction>([
  'capabilities',
  'health',
  'operations.snapshot',
  'tasks.list',
  'worktrees.list',
  'diagnostics.run',
]);

const MUTATION_ACTIONS = new Set<JarvisAction>([
  'tasks.pause',
  'tasks.resume',
  'tasks.cancel',
  'worktrees.discard',
  'diagnostics.repair',
]);

export class JarvisControlPlane {
  private readonly completed = new Map<string, ReplayEntry>();
  private readonly maxReplayEntries: number;
  private readonly approveMutation?: JarvisMutationApproval;

  constructor(
    private readonly adapter: JarvisControlAdapter,
    options: JarvisControlOptions = {},
  ) {
    this.maxReplayEntries = options.maxReplayEntries ?? 500;
    this.approveMutation = options.approveMutation;
    if (!Number.isInteger(this.maxReplayEntries) || this.maxReplayEntries < 10 || this.maxReplayEntries > 10_000) {
      throw new Error('Jarvis replay capacity must be between 10 and 10000.');
    }
  }

  capabilities(): JarvisCapabilityManifest {
    return {
      schemaVersion: 1,
      service: 'ollama-agent',
      protocol: 'jarvis-control-v1',
      readActions: [...READ_ACTIONS].sort(),
      mutationActions: [...MUTATION_ACTIONS].sort(),
      arbitraryCommands: false,
      arbitraryTools: false,
      mutationApprovalRequired: true,
      idempotencyRequiredForMutations: true,
    };
  }

  async execute(request: JarvisControlRequest): Promise<JarvisControlResponse> {
    validateRequest(request);
    const mutation = MUTATION_ACTIONS.has(request.action);
    if (!READ_ACTIONS.has(request.action) && !mutation) {
      return this.failure(request, 'Unknown or unsupported Jarvis action.');
    }

    let mutationFingerprint: string | undefined;
    if (mutation) {
      if (!request.idempotencyKey) {
        return this.denied(request, 'Mutation requires an idempotency key.');
      }
      mutationFingerprint = fingerprint(request.action, request.params);
      const replay = this.completed.get(request.idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== mutationFingerprint) {
          return this.denied(request, 'Idempotency key is already bound to a different mutation.');
        }
        return { ...replay.response, requestId: request.requestId, replayed: true };
      }
      const approved = await this.approveMutation?.(cloneRequest(request));
      if (!approved) {
        return this.denied(request, 'Mutation was not approved by the host.');
      }
    }

    try {
      const result = await this.dispatch(request);
      const response: JarvisControlResponse = {
        schemaVersion: 1,
        requestId: request.requestId,
        action: request.action,
        status: 'completed',
        result,
      };
      if (mutation && request.idempotencyKey && mutationFingerprint) {
        this.remember(request.idempotencyKey, mutationFingerprint, response);
      }
      return response;
    } catch (error) {
      return this.failure(request, error instanceof Error ? error.message : String(error));
    }
  }

  private async dispatch(request: JarvisControlRequest): Promise<unknown> {
    switch (request.action) {
      case 'capabilities': return this.capabilities();
      case 'health': return this.adapter.health();
      case 'operations.snapshot': return this.adapter.operationsSnapshot();
      case 'tasks.list': return this.adapter.listTasks();
      case 'tasks.pause': return this.adapter.pauseTask(requiredString(request.params, 'taskId'));
      case 'tasks.resume': return this.adapter.resumeTask(requiredString(request.params, 'taskId'));
      case 'tasks.cancel': return this.adapter.cancelTask(requiredString(request.params, 'taskId'));
      case 'worktrees.list': return this.adapter.listWorktrees();
      case 'worktrees.discard': return this.adapter.discardWorktree(requiredString(request.params, 'taskId'));
      case 'diagnostics.run': return this.adapter.runDiagnostics();
      case 'diagnostics.repair': return this.adapter.repairDiagnostic(requiredString(request.params, 'repairId'), true);
    }
  }

  private remember(key: string, mutationFingerprint: string, response: JarvisControlResponse): void {
    this.completed.set(key, { fingerprint: mutationFingerprint, response: { ...response } });
    while (this.completed.size > this.maxReplayEntries) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (!oldest) break;
      this.completed.delete(oldest);
    }
  }

  private denied(request: JarvisControlRequest, error: string): JarvisControlResponse {
    return { schemaVersion: 1, requestId: request.requestId, action: request.action, status: 'denied', error };
  }

  private failure(request: JarvisControlRequest, error: string): JarvisControlResponse {
    return { schemaVersion: 1, requestId: request.requestId, action: request.action, status: 'failed', error };
  }
}

export function registerJarvisControlRpc(dispatcher: LocalRpcDispatcher, control: JarvisControlPlane): void {
  dispatcher.register('jarvis.capabilities', async () => control.capabilities());
  dispatcher.register('jarvis.execute', async params => control.execute(parseControlRequest(params)));
}

function parseControlRequest(value: unknown): JarvisControlRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Jarvis request must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    requestId: String(record['requestId'] ?? ''),
    action: String(record['action'] ?? '') as JarvisAction,
    params: record['params'] && typeof record['params'] === 'object' && !Array.isArray(record['params'])
      ? record['params'] as Record<string, unknown>
      : undefined,
    idempotencyKey: typeof record['idempotencyKey'] === 'string' ? record['idempotencyKey'] : undefined,
  };
}

function validateRequest(request: JarvisControlRequest): void {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(request.requestId)) {
    throw new Error('Jarvis request id is invalid.');
  }
  if (request.idempotencyKey && !/^[a-zA-Z0-9._:-]{1,200}$/.test(request.idempotencyKey)) {
    throw new Error('Jarvis idempotency key is invalid.');
  }
}

function requiredString(params: Record<string, unknown> | undefined, key: string): string {
  const value = params?.[key];
  if (typeof value !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(value)) {
    throw new Error(`Jarvis parameter ${key} is missing or invalid.`);
  }
  return value;
}

function fingerprint(action: JarvisAction, params: Record<string, unknown> | undefined): string {
  return `${action}:${stableStringify(params ?? {})}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function cloneRequest(request: JarvisControlRequest): JarvisControlRequest {
  return {
    requestId: request.requestId,
    action: request.action,
    params: request.params
      ? JSON.parse(JSON.stringify(request.params)) as Record<string, unknown>
      : undefined,
    idempotencyKey: request.idempotencyKey,
  };
}
