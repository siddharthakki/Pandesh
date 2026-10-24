import * as fs from 'fs/promises';
import * as path from 'path';

export type ObservationLevel = 'debug' | 'info' | 'warning' | 'error';
export type ObservationCategory =
  | 'task'
  | 'provider'
  | 'integration'
  | 'rpc'
  | 'sandbox'
  | 'mcp'
  | 'worktree'
  | 'diagnostic'
  | 'release'
  | 'system';

export interface ObservationEvent {
  schemaVersion: 1;
  sequence: number;
  timestamp: string;
  level: ObservationLevel;
  category: ObservationCategory;
  name: string;
  taskId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface ObservationInput {
  level?: ObservationLevel;
  category: ObservationCategory;
  name: string;
  taskId?: string;
  durationMs?: number;
  data?: Record<string, unknown>;
}

export interface ObservabilitySnapshot {
  schemaVersion: 1;
  generatedAt: string;
  eventCount: number;
  counters: Record<string, number>;
  recentEvents: ObservationEvent[];
}

export interface ObservationStorage {
  append(event: ObservationEvent): Promise<void>;
}

export interface ObservabilityHubOptions {
  capacity?: number;
  storage?: ObservationStorage;
}

export class JsonlObservationStorage implements ObservationStorage {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filename: string) {}

  append(event: ObservationEvent): Promise<void> {
    const next = this.queue.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      await fs.appendFile(this.filename, `${JSON.stringify(event)}\n`, 'utf8');
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}

export class ObservabilityHub {
  private readonly capacity: number;
  private readonly storage?: ObservationStorage;
  private readonly events: ObservationEvent[] = [];
  private readonly counters = new Map<string, number>();
  private readonly listeners = new Set<(event: ObservationEvent) => void>();
  private sequence = 0;

  constructor(options: ObservabilityHubOptions = {}) {
    this.capacity = options.capacity ?? 250;
    this.storage = options.storage;
    if (!Number.isInteger(this.capacity) || this.capacity < 10 || this.capacity > 10_000) {
      throw new Error('Observability capacity must be an integer between 10 and 10000.');
    }
  }

  async record(input: ObservationInput): Promise<ObservationEvent> {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(input.name)) {
      throw new Error(`Invalid observation name: ${input.name}`);
    }
    const event: ObservationEvent = {
      schemaVersion: 1,
      sequence: ++this.sequence,
      timestamp: new Date().toISOString(),
      level: input.level ?? 'info',
      category: input.category,
      name: input.name,
      taskId: input.taskId,
      durationMs: input.durationMs,
      data: input.data ? sanitizeRecord(input.data) : undefined,
    };
    this.events.push(event);
    while (this.events.length > this.capacity) {
      this.events.shift();
    }
    const key = `${event.category}.${event.name}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
    for (const listener of this.listeners) {
      try { listener(cloneEvent(event)); } catch { /* observer failures are isolated */ }
    }
    if (this.storage) {
      try {
        await this.storage.append(event);
      } catch {
        const failureKey = 'system.observation-storage-failed';
        this.counters.set(failureKey, (this.counters.get(failureKey) ?? 0) + 1);
      }
    }
    return cloneEvent(event);
  }

  subscribe(listener: (event: ObservationEvent) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  snapshot(limit = 100): ObservabilitySnapshot {
    const safeLimit = Math.max(0, Math.min(limit, this.capacity));
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      eventCount: this.sequence,
      counters: Object.fromEntries([...this.counters.entries()].sort(([left], [right]) => left.localeCompare(right))),
      recentEvents: this.events.slice(-safeLimit).map(cloneEvent),
    };
  }

  clear(): void {
    this.events.length = 0;
    this.counters.clear();
  }
}

function cloneEvent(event: ObservationEvent): ObservationEvent {
  return {
    ...event,
    data: event.data ? structuredCloneSafe(event.data) as Record<string, unknown> : undefined,
  };
}

const SENSITIVE_KEY = /token|secret|password|authorization|api.?key|credential/i;

function sanitizeRecord(value: Record<string, unknown>, depth = 0): Record<string, unknown> {
  if (depth > 8) return { truncated: '[depth-limit]' };
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 200)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, depth + 1);
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 8) return '[depth-limit]';
  if (typeof value === 'string') {
    return value.length > 2000 ? `${value.slice(0, 2000)}…[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map(item => sanitizeValue(item, depth + 1));
  }
  if (value && typeof value === 'object') {
    return sanitizeRecord(value as Record<string, unknown>, depth + 1);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  return value === undefined ? undefined : String(value);
}

function structuredCloneSafe(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCloneSafe);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, structuredCloneSafe(item)]));
  }
  return value;
}
