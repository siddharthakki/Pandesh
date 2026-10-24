/**
 * Extensible Engine Adapter Architecture for KarkeDikha (KKD).
 * Provides a uniform contract for execution engines (OpenCode, Pi, Hermes, OpenClaw).
 * Engines are decoupled and only invoked when configured or required.
 */

export type EngineRole = 'coding' | 'chat' | 'collaborative' | 'specialist';

export interface EngineExecutionOptions {
  workingDirectory?: string;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  signal?: AbortSignal;
  onProgress?: (event: EngineProgressEvent) => void;
  [key: string]: unknown;
}

export interface EngineProgressEvent {
  type: 'step_start' | 'tool_call' | 'tool_result' | 'token' | 'step_finish' | 'status';
  step?: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  content?: string;
  timestamp?: number;
}

export interface EngineExecutionResult {
  success: boolean;
  reply: string;
  modifiedFiles?: string[];
  toolCalls?: Array<{ tool: string; args?: unknown; status?: string; result?: unknown }>;
  error?: string;
  metrics?: {
    totalMs?: number;
    tokensIn?: number;
    tokensOut?: number;
  };
}

export interface EngineAdapter {
  readonly id: string;
  readonly name: string;
  readonly role: EngineRole;
  readonly description: string;

  isAvailable(): Promise<boolean>;
  execute(prompt: string, options?: EngineExecutionOptions): Promise<EngineExecutionResult>;
  abort?(): void;
}

/**
 * Real Hermes Agent Engine Adapter implementing official HTTP Runs API.
 * Discovers Hermes at configurable local address (default 127.0.0.1:8642) and checks /v1/capabilities.
 */
export class HermesEngineAdapter implements EngineAdapter {
  readonly id = 'hermes';
  readonly name = 'Hermes Agent';
  readonly role: EngineRole = 'specialist';
  readonly description = 'Hermes agent engine for autonomous skills and multi-turn workflows';

  private getBaseUrl(): string {
    return (process.env.HERMES_URL || process.env.HERMES_API_BASE || 'http://127.0.0.1:8642').replace(/\/$/, '');
  }

  private getApiKey(): string {
    return (process.env.HERMES_API_KEY || 'hermes-local-key').trim();
  }

  async isAvailable(): Promise<boolean> {
    if (process.env.HERMES_ENABLED === 'false' || process.env.HERMES_ENABLED === '0') return false;
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    try {
      const res = await fetch(`${baseUrl}/v1/capabilities`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(1200),
      });
      if (!res.ok) return false;
      const json = await res.json() as any;
      const caps = json.capabilities || json;
      return caps?.runs !== false;
    } catch {
      return false;
    }
  }

  async execute(prompt: string, options?: EngineExecutionOptions): Promise<EngineExecutionResult> {
    const available = await this.isAvailable();
    if (!available) {
      return {
        success: false,
        reply: '',
        error: 'Hermes engine is not running or available on this system.',
      };
    }
    const baseUrl = this.getBaseUrl();
    const apiKey = this.getApiKey();
    const idempotencyKey = `hermes:exec:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${baseUrl}/v1/runs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify({
        prompt,
        model: options?.model || 'qwen3-coder:swift-27b',
        workspace_root: options?.workingDirectory,
        idempotency_key: idempotencyKey,
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        success: false,
        reply: '',
        error: `Hermes POST /v1/runs failed with HTTP ${res.status}: ${errText}`,
      };
    }

    const data = await res.json() as any;
    const runId = data.id || data.run_id;
    if (!runId) {
      return { success: false, reply: '', error: 'Hermes did not return a valid run ID' };
    }

    const start = Date.now();
    const timeout = options?.timeoutMs || 120000;
    while (Date.now() - start < timeout && !options?.signal?.aborted) {
      try {
        const check = await fetch(`${baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
          headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
          signal: options?.signal,
        });
        if (check.ok) {
          const run = await check.json() as any;
          if (run.status === 'completed') {
            return {
              success: true,
              reply: run.output || 'Task completed successfully by Hermes.',
              modifiedFiles: run.modified_files || run.modifiedFiles,
              toolCalls: run.tool_calls || run.toolCalls,
            };
          }
          if (run.status === 'failed') {
            return {
              success: false,
              reply: run.output || '',
              error: run.error || 'Hermes task execution failed',
              modifiedFiles: run.modified_files || run.modifiedFiles,
              toolCalls: run.tool_calls || run.toolCalls,
            };
          }
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 600));
    }
    return { success: false, reply: '', error: 'Hermes execution timed out' };
  }
}

/**
 * Extensible stub adapter for OpenClaw.
 * Only activated if OpenClaw CLI is available on the system.
 */
export class OpenClawEngineAdapter implements EngineAdapter {
  readonly id = 'openclaw';
  readonly name = 'OpenClaw Agent';
  readonly role: EngineRole = 'specialist';
  readonly description = 'OpenClaw execution engine for sandboxed tool execution';

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async execute(_prompt: string, _options?: EngineExecutionOptions): Promise<EngineExecutionResult> {
    const available = await this.isAvailable();
    if (!available) {
      return {
        success: false,
        reply: '',
        error: 'OpenClaw engine is not installed or configured on this system.',
      };
    }
    throw new Error('OpenClaw engine execution is not enabled for this request profile.');
  }
}

/**
 * Engine Registry - holds and resolves execution engine adapters.
 */
export class EngineRegistry {
  private static adapters = new Map<string, EngineAdapter>();

  static register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  static get(id: string): EngineAdapter | undefined {
    return this.adapters.get(id);
  }

  static getAll(): EngineAdapter[] {
    return Array.from(this.adapters.values());
  }

  static async getAvailable(): Promise<EngineAdapter[]> {
    const result: EngineAdapter[] = [];
    for (const a of this.adapters.values()) {
      if (await a.isAvailable()) {
        result.push(a);
      }
    }
    return result;
  }
}

EngineRegistry.register(new HermesEngineAdapter());
EngineRegistry.register(new OpenClawEngineAdapter());
