export const LOCAL_RPC_SCHEMA_VERSION = 1 as const;

export interface LocalRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface LocalRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
  };
}

export interface LocalRpcContext {
  signal: AbortSignal;
  clientId?: string;
}

export type LocalRpcMethod = (params: unknown, context: LocalRpcContext) => Promise<unknown>;

export interface LocalRpcDispatcherOptions {
  accessKey: string;
  requestTimeoutMs?: number;
  maxRequestBytes?: number;
}

function failure(id: string | number | null, code: number, message: string): LocalRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function parseRequest(value: unknown): LocalRpcRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record['jsonrpc'] !== '2.0' || typeof record['method'] !== 'string') {
    return null;
  }
  const id = record['id'];
  if (id !== undefined && id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return null;
  }
  return {
    jsonrpc: '2.0',
    id: id as string | number | null | undefined,
    method: record['method'],
    params: record['params'],
  };
}

export class LocalRpcDispatcher {
  private readonly methods = new Map<string, LocalRpcMethod>();
  private readonly active = new Set<AbortController>();
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly accessKey: string, options: Omit<LocalRpcDispatcherOptions, 'accessKey'> = {}) {
    this.timeoutMs = options.requestTimeoutMs ?? 300_000;
    this.maxBytes = options.maxRequestBytes ?? 1_048_576;
    if (accessKey.length < 24) {
      throw new Error('Local RPC access key must contain at least 24 characters.');
    }
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000) {
      throw new Error('Local RPC timeout is invalid.');
    }
    if (!Number.isInteger(this.maxBytes) || this.maxBytes < 1024) {
      throw new Error('Local RPC request limit is invalid.');
    }
  }

  register(name: string, method: LocalRpcMethod): void {
    if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,99}$/.test(name)) {
      throw new Error(`Invalid local RPC method name: ${name}`);
    }
    if (this.methods.has(name)) {
      throw new Error(`Local RPC method already exists: ${name}`);
    }
    this.methods.set(name, method);
  }

  listMethods(): string[] {
    return [...this.methods.keys()].sort();
  }

  async dispatch(raw: string, accessKey: string, clientId?: string): Promise<LocalRpcResponse | null> {
    if (accessKey !== this.accessKey) {
      return failure(null, -32001, 'Access denied.');
    }
    if (Buffer.byteLength(raw, 'utf8') > this.maxBytes) {
      return failure(null, -32002, 'Request is too large.');
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return failure(null, -32700, 'Parse error.');
    }
    const request = parseRequest(value);
    if (!request) {
      return failure(null, -32600, 'Invalid request.');
    }
    const method = this.methods.get(request.method);
    if (!method) {
      return failure(request.id ?? null, -32601, 'Method not found.');
    }

    const controller = new AbortController();
    this.active.add(controller);
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const result = await method(request.params, { signal: controller.signal, clientId });
      if (request.id === undefined) {
        return null;
      }
      return { jsonrpc: '2.0', id: request.id ?? null, result };
    } catch (error) {
      const message = controller.signal.aborted
        ? 'Request cancelled or timed out.'
        : error instanceof Error ? error.message : String(error);
      return failure(request.id ?? null, -32000, message);
    } finally {
      clearTimeout(timeout);
      this.active.delete(controller);
    }
  }

  cancelAll(): void {
    for (const controller of this.active) {
      controller.abort();
    }
    this.active.clear();
  }
}
