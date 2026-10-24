/**
 * TaskStore — authoritative durable storage for task and session state.
 *
 * Layout (per task):
 *   .ollama-agent/tasks/<task-id>/
 *     task.json        — PersistedTask metadata (atomic writes)
 *     state.json       — TaskSnapshot (atomic writes)
 *     events.jsonl     — append-only event log
 *     messages.jsonl   — append-only message log
 *     approvals.json   — current approval states (atomic writes)
 *     checkpoints.json — checkpoint references (atomic writes)
 *     lock.json        — write lock (PID + heartbeat + session)
 *
 * Guarantees:
 *   - Per-task write serialization prevents interleaved appends or snapshots.
 *   - Snapshots use same-directory tmp+rename writes.
 *   - Path traversal via task IDs is rejected before I/O.
 *   - Secrets are redacted before persistence.
 *   - Corrupted event history and unsupported schema versions block new events.
 *   - A truncated final JSONL record is repaired before the next append.
 *   - Storage-limit exhaustion preserves the last valid state and blocks active tasks.
 *   - Lock staleness uses both PID liveness and a heartbeat.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';
import { Logger } from '../services/Logger';
import { OutputLimiter } from '../services/OutputLimiter';
import {
  TASK_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  MESSAGE_SCHEMA_VERSION,
  APPROVAL_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  PersistedTask,
  PersistedTaskStatus,
  PersistedEvent,
  PersistedEventType,
  PersistedMessage,
  PersistedApproval,
  PersistedApprovalStatus,
  PersistedCheckpointRef,
  TaskSnapshot,
  TaskLock,
  CreateTaskParams,
} from './TaskTypes';

const MAX_TOOL_OUTPUT_CHARS = 4000;
const MAX_TASK_DIR_BYTES = 50 * 1024 * 1024;
const LOCK_HEARTBEAT_STALE_MS = 60_000;

const ACTIVE_TASK_STATUSES = new Set<PersistedTaskStatus>([
  'created',
  'running',
  'waiting_for_approval',
  'paused',
  'recovering',
  'blocked',
]);

const SENSITIVE_KEY_RE =
  /^(api.?key|apikey|secret|token|access.?token|refresh.?token|password|passwd|auth|authorization|bearer|private.?key|access.?key|credential)s?$/i;

const INLINE_SECRET_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
  {
    pattern: /\b(Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)?\s*[^\s,\r\n]+/gi,
    replace: '$1: [REDACTED]',
  },
  {
    pattern: /\b(X-Api-Key)\s*:\s*[^\s,\r\n]+/gi,
    replace: '$1: [REDACTED]',
  },
  {
    pattern: /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|private[_-]?key|bearer)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
    replace: '$1=[REDACTED]',
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}={0,2}/gi,
    replace: 'Bearer [REDACTED]',
  },
];

function redactStringContent(value: string): string {
  let redacted = value;
  for (const { pattern, replace } of INLINE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replace);
  }
  return redacted;
}

function redactPayload(value: unknown, depth = 0): unknown {
  if (depth > 8) { return '[depth-limit]'; }

  if (typeof value === 'string') {
    const redacted = redactStringContent(value);
    return redacted.length > 2000
      ? `${redacted.slice(0, 200)}…[truncated]`
      : redacted;
  }

  if (Array.isArray(value)) {
    return value.map(item => redactPayload(item, depth + 1));
  }

  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = SENSITIVE_KEY_RE.test(key)
        ? '[REDACTED]'
        : redactPayload(item, depth + 1);
    }
    return sanitized;
  }

  return value;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return redactPayload(args) as Record<string, unknown>;
}

export interface JsonlParseResult {
  records: unknown[];
  warnings: string[];
  hasMalformedMiddle: boolean;
  hasIntegrityIssue: boolean;
  truncatedFinalLine: boolean;
}

export function parseJsonlSafe(content: string, context: string): JsonlParseResult {
  const warnings: string[] = [];
  const records: unknown[] = [];
  let hasMalformedMiddle = false;
  let truncatedFinalLine = false;

  const lines = content.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) { continue; }

    try {
      records.push(JSON.parse(line));
    } catch {
      const laterNonEmptyLineExists = lines
        .slice(index + 1)
        .some(candidate => candidate.trim().length > 0);

      if (!laterNonEmptyLineExists) {
        truncatedFinalLine = true;
        warnings.push(`${context}: truncated final JSONL line ignored (line ${index + 1})`);
      } else {
        hasMalformedMiddle = true;
        warnings.push(
          `${context}: malformed JSONL line ${index + 1} — manual repair is required before modification.`,
        );
      }
    }
  }

  return {
    records,
    warnings,
    hasMalformedMiddle,
    hasIntegrityIssue: hasMalformedMiddle,
    truncatedFinalLine,
  };
}

interface IntegrityFlags {
  integrityFailed: boolean;
  hasFutureSchema: boolean;
  warnings: string[];
}

interface EventValidationResult {
  events: PersistedEvent[];
  warnings: string[];
  integrityFailed: boolean;
  hasFutureSchema: boolean;
}

class TaskStorageLimitError extends Error {
  constructor(
    readonly taskId: string,
    readonly currentBytes: number,
    readonly projectedBytes: number,
  ) {
    super(
      `Task "${taskId}" storage limit exceeded ` +
      `(${projectedBytes} bytes projected > ${MAX_TASK_DIR_BYTES}). ` +
      `Archive or delete completed task history before continuing.`,
    );
    this.name = 'TaskStorageLimitError';
  }
}

export class TaskStore {
  private readonly tasksRoot: string;
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly seqCounters = new Map<string, number>();
  private readonly integrityFlags = new Map<string, IntegrityFlags>();

  constructor(workspaceRoot: string) {
    this.tasksRoot = path.join(workspaceRoot, '.ollama-agent', 'tasks');
  }

  static validateTaskId(taskId: string): void {
    if (!taskId || !/^[a-zA-Z0-9_-]{1,100}$/.test(taskId)) {
      throw new Error(`Invalid task ID (unsafe characters or length): "${taskId}"`);
    }
  }

  getTaskDir(taskId: string): string {
    TaskStore.validateTaskId(taskId);
    const directory = path.join(this.tasksRoot, taskId);
    const relative = path.relative(this.tasksRoot, directory);

    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Task ID path escapes tasks root: "${taskId}"`);
    }

    return directory;
  }

  private taskFile(taskId: string, name: string): string {
    return path.join(this.getTaskDir(taskId), name);
  }

  private async atomicWrite(filePath: string, content: string): Promise<void> {
    const directory = path.dirname(filePath);
    const tempPath = path.join(
      directory,
      `${path.basename(filePath)}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`,
    );

    await fs.mkdir(directory, { recursive: true });

    try {
      await fs.writeFile(tempPath, content, 'utf8');
      await fs.rename(tempPath, filePath);
    } catch (error) {
      try { await fs.unlink(tempPath); } catch { /* best effort */ }
      throw error;
    }
  }

  async serializedWrite<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    TaskStore.validateTaskId(taskId);

    let result!: T;
    const previous = this.writeQueues.get(taskId) ?? Promise.resolve();
    const next = previous.then(async () => {
      result = await operation();
    });

    this.writeQueues.set(taskId, next.catch(() => undefined));
    await next;
    return result;
  }

  private async directorySize(directory: string): Promise<number> {
    let total = 0;
    let entries: Array<import('fs').Dirent>;

    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 0; }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      try {
        if (entry.isSymbolicLink()) {
          continue;
        }
        if (entry.isDirectory()) {
          total += await this.directorySize(entryPath);
        } else if (entry.isFile()) {
          total += (await fs.stat(entryPath)).size;
        }
      } catch {
        // A concurrently removed temp file does not invalidate the size calculation.
      }
    }

    return total;
  }

  private async currentFileSize(filePath: string): Promise<number> {
    try {
      return (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 0; }
      throw error;
    }
  }

  private async ensureStorageCapacity(taskId: string, additionalBytes: number): Promise<void> {
    const currentBytes = await this.directorySize(this.getTaskDir(taskId));
    const projectedBytes = currentBytes + Math.max(0, additionalBytes);

    if (projectedBytes > MAX_TASK_DIR_BYTES) {
      throw new TaskStorageLimitError(taskId, currentBytes, projectedBytes);
    }
  }

  private async markTaskBlockedForStorageLimit(
    taskId: string,
    error: TaskStorageLimitError,
  ): Promise<void> {
    try {
      const task = await this.getTask(taskId);
      if (!task || !ACTIVE_TASK_STATUSES.has(task.status)) { return; }

      const blocked: PersistedTask = {
        ...task,
        status: 'blocked',
        failure: {
          message: redactStringContent(error.message),
          code: 'TASK_STORAGE_LIMIT',
          timestamp: new Date().toISOString(),
        },
        updatedAt: new Date().toISOString(),
      };

      await this.atomicWrite(
        this.taskFile(taskId, 'task.json'),
        JSON.stringify(blocked, null, 2),
      );
    } catch (blockError) {
      Logger.warn(
        `[TaskStore] Failed to mark task ${taskId} blocked after storage exhaustion: ` +
        `${blockError instanceof Error ? blockError.message : String(blockError)}`,
      );
    }
  }

  private async atomicWriteTaskFile(
    taskId: string,
    name: string,
    content: string,
    bypassStorageLimit = false,
  ): Promise<void> {
    const filePath = this.taskFile(taskId, name);

    if (!bypassStorageLimit) {
      const previousBytes = await this.currentFileSize(filePath);
      const newBytes = Buffer.byteLength(content, 'utf8');

      try {
        await this.ensureStorageCapacity(taskId, Math.max(0, newBytes - previousBytes));
      } catch (error) {
        if (error instanceof TaskStorageLimitError) {
          await this.markTaskBlockedForStorageLimit(taskId, error);
        }
        throw error;
      }
    }

    await this.atomicWrite(filePath, content);
  }

  private validateEventRecords(records: unknown[], context: string): EventValidationResult {
    const warnings: string[] = [];
    const events: PersistedEvent[] = [];
    const seenIds = new Set<string>();
    const seenSequences = new Set<number>();
    let integrityFailed = false;
    let hasFutureSchema = false;
    let previousSequence = 0;

    for (const record of records) {
      if (record === null || typeof record !== 'object') {
        warnings.push(`${context}: non-object event record — integrity failure`);
        integrityFailed = true;
        continue;
      }

      const event = record as PersistedEvent;

      if (typeof event.schemaVersion !== 'number') {
        warnings.push(`${context}: event has no numeric schema version — integrity failure`);
        integrityFailed = true;
        continue;
      }

      if (event.schemaVersion !== EVENT_SCHEMA_VERSION) {
        if (event.schemaVersion > EVENT_SCHEMA_VERSION) {
          hasFutureSchema = true;
          warnings.push(
            `${context}: event seq=${String(event.seq)} uses future schema version ${event.schemaVersion} ` +
            `(current ${EVENT_SCHEMA_VERSION})`,
          );
        } else {
          warnings.push(
            `${context}: event seq=${String(event.seq)} uses unsupported schema version ${event.schemaVersion}`,
          );
        }
        integrityFailed = true;
        continue;
      }

      if (
        !event.eventId ||
        !event.taskId ||
        !event.type ||
        !event.timestamp ||
        !Number.isInteger(event.seq) ||
        event.seq <= 0 ||
        event.payload === null ||
        typeof event.payload !== 'object' ||
        Array.isArray(event.payload)
      ) {
        warnings.push(`${context}: event missing or invalid required fields — integrity failure`);
        integrityFailed = true;
        continue;
      }

      if (seenIds.has(event.eventId)) {
        warnings.push(
          `${context}: Duplicate event ID "${event.eventId}" (seq ${event.seq}) — integrity failure`,
        );
        integrityFailed = true;
        continue;
      }

      if (seenSequences.has(event.seq)) {
        warnings.push(`${context}: duplicate sequence ${event.seq} — integrity failure`);
        integrityFailed = true;
        continue;
      }

      if (event.seq !== previousSequence + 1) {
        warnings.push(
          `${context}: sequence gap or out-of-order event; expected ${previousSequence + 1}, ` +
          `found ${event.seq} — integrity failure`,
        );
        integrityFailed = true;
      }

      seenIds.add(event.eventId);
      seenSequences.add(event.seq);
      previousSequence = event.seq;
      events.push(event);
    }

    return { events, warnings, integrityFailed, hasFutureSchema };
  }

  private async repairTruncatedJsonl(
    taskId: string,
    fileName: string,
    records: unknown[],
  ): Promise<void> {
    const repaired = records.length > 0
      ? `${records.map(record => JSON.stringify(record)).join('\n')}\n`
      : '';

    await this.atomicWriteTaskFile(taskId, fileName, repaired);
  }

  private async loadEventState(taskId: string): Promise<{
    events: PersistedEvent[];
    warnings: string[];
    integrityFailed: boolean;
    hasFutureSchema: boolean;
  }> {
    let raw: string;

    try {
      raw = await fs.readFile(this.taskFile(taskId, 'events.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          events: [],
          warnings: [],
          integrityFailed: false,
          hasFutureSchema: false,
        };
      }
      throw error;
    }

    const parsed = parseJsonlSafe(raw, `events.jsonl[${taskId}]`);
    const validated = this.validateEventRecords(parsed.records, `events.jsonl[${taskId}]`);

    return {
      events: validated.events,
      warnings: [...parsed.warnings, ...validated.warnings],
      integrityFailed: parsed.hasMalformedMiddle || validated.integrityFailed,
      hasFutureSchema: validated.hasFutureSchema,
    };
  }

  private async prepareEventLogForAppend(taskId: string): Promise<void> {
    if (this.seqCounters.has(taskId)) {
      const cached = this.integrityFlags.get(taskId);
      if (cached?.integrityFailed || cached?.hasFutureSchema) {
        throw new Error(
          `[TaskStore] Event log for task "${taskId}" is not safe to modify: ` +
          `${cached.warnings.join('; ') || 'integrity failure'}`,
        );
      }
      return;
    }

    let raw: string;
    try {
      raw = await fs.readFile(this.taskFile(taskId, 'events.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.seqCounters.set(taskId, 0);
        this.integrityFlags.set(taskId, {
          integrityFailed: false,
          hasFutureSchema: false,
          warnings: [],
        });
        return;
      }
      throw error;
    }

    const parsed = parseJsonlSafe(raw, `events.jsonl[${taskId}]`);
    const validated = this.validateEventRecords(parsed.records, `events.jsonl[${taskId}]`);
    const warnings = [...parsed.warnings, ...validated.warnings];
    const integrityFailed = parsed.hasMalformedMiddle || validated.integrityFailed;

    this.integrityFlags.set(taskId, {
      integrityFailed,
      hasFutureSchema: validated.hasFutureSchema,
      warnings,
    });

    if (integrityFailed || validated.hasFutureSchema) {
      throw new Error(
        `[TaskStore] Event log for task "${taskId}" is corrupted or incompatible. ` +
        `Manual repair is required before new events can be appended. ${warnings.join('; ')}`,
      );
    }

    if (parsed.truncatedFinalLine) {
      await this.repairTruncatedJsonl(taskId, 'events.jsonl', validated.events);
    }

    const lastSequence = validated.events.length > 0
      ? validated.events[validated.events.length - 1].seq
      : 0;
    this.seqCounters.set(taskId, lastSequence);
  }

  async cleanAbandonedTmps(taskId: string): Promise<void> {
    try {
      const entries = await fs.readdir(this.getTaskDir(taskId));
      for (const entry of entries) {
        if (!entry.endsWith('.tmp')) { continue; }
        try { await fs.unlink(path.join(this.getTaskDir(taskId), entry)); } catch { /* best effort */ }
      }
    } catch {
      // The task directory may not exist yet.
    }
  }

  async createTask(params: CreateTaskParams): Promise<PersistedTask> {
    TaskStore.validateTaskId(params.taskId);

    const now = new Date().toISOString();
    const task: PersistedTask = {
      schemaVersion: TASK_SCHEMA_VERSION,
      taskId: params.taskId,
      workspaceId: params.workspaceId,
      workspaceRoot: params.workspaceRoot,
      title: params.title,
      userGoal: params.userGoal,
      mode: params.mode,
      status: 'created',
      providerType: params.providerType,
      providerEndpoint: params.providerEndpoint,
      model: params.model,
      createdAt: now,
      updatedAt: now,
    };

    await this.serializedWrite(params.taskId, async () => {
      await this.cleanAbandonedTmps(params.taskId);
      await this.atomicWrite(
        this.taskFile(params.taskId, 'task.json'),
        JSON.stringify(task, null, 2),
      );
      this.seqCounters.set(params.taskId, 0);
      this.integrityFlags.set(params.taskId, {
        integrityFailed: false,
        hasFutureSchema: false,
        warnings: [],
      });
    });

    return task;
  }

  async getTask(taskId: string): Promise<PersistedTask | null> {
    try {
      const raw = await fs.readFile(this.taskFile(taskId, 'task.json'), 'utf8');
      const task = JSON.parse(raw) as PersistedTask;

      if (task.schemaVersion !== TASK_SCHEMA_VERSION) {
        Logger.warn(
          `[TaskStore] Unsupported task schema version ${task.schemaVersion} for task ${taskId}`,
        );
        return null;
      }

      return task;
    } catch {
      return null;
    }
  }

  async updateTask(
    taskId: string,
    updates: Partial<Omit<PersistedTask, 'schemaVersion' | 'taskId' | 'createdAt'>>,
  ): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const existing = await this.getTask(taskId);
      if (!existing) { throw new Error(`Task not found: ${taskId}`); }

      const sanitized = { ...updates };
      if (sanitized.failure?.message) {
        sanitized.failure = {
          ...sanitized.failure,
          message: redactStringContent(sanitized.failure.message),
        };
      }

      const updated: PersistedTask = {
        ...existing,
        ...sanitized,
        updatedAt: new Date().toISOString(),
      };

      await this.atomicWriteTaskFile(
        taskId,
        'task.json',
        JSON.stringify(updated, null, 2),
      );
    });
  }

  async updateTaskStatus(
    taskId: string,
    status: PersistedTaskStatus,
    extra?: Partial<Omit<PersistedTask, 'schemaVersion' | 'taskId' | 'status' | 'createdAt'>>,
  ): Promise<void> {
    await this.updateTask(taskId, { status, ...extra });
  }

  async listTasks(): Promise<PersistedTask[]> {
    const tasks: PersistedTask[] = [];

    try {
      const entries = await fs.readdir(this.tasksRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('archived-')) { continue; }
        const task = await this.getTask(entry.name);
        if (task) { tasks.push(task); }
      }
    } catch {
      // No tasks directory yet.
    }

    return tasks.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async appendEvent(
    taskId: string,
    type: PersistedEventType,
    payload: Record<string, unknown>,
    options?: { parentEventId?: string; correlationId?: string },
  ): Promise<PersistedEvent> {
    return this.serializedWrite(taskId, async () => {
      await this.prepareEventLogForAppend(taskId);

      const currentSequence = this.seqCounters.get(taskId) ?? 0;
      const nextSequence = currentSequence + 1;
      const event: PersistedEvent = {
        schemaVersion: EVENT_SCHEMA_VERSION,
        eventId: `evt_${taskId}_${nextSequence}_${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        seq: nextSequence,
        timestamp: new Date().toISOString(),
        type,
        parentEventId: options?.parentEventId,
        correlationId: options?.correlationId,
        payload: redactPayload(payload) as Record<string, unknown>,
      };

      const line = `${JSON.stringify(event)}\n`;

      try {
        await this.ensureStorageCapacity(taskId, Buffer.byteLength(line, 'utf8'));
      } catch (error) {
        if (error instanceof TaskStorageLimitError) {
          await this.markTaskBlockedForStorageLimit(taskId, error);
        }
        throw error;
      }

      await fs.mkdir(this.getTaskDir(taskId), { recursive: true });
      await fs.appendFile(this.taskFile(taskId, 'events.jsonl'), line, 'utf8');
      this.seqCounters.set(taskId, nextSequence);
      return event;
    });
  }

  async getEvents(
    taskId: string,
    options?: { afterSeq?: number },
  ): Promise<{ events: PersistedEvent[]; warnings: string[]; integrityFailed: boolean }> {
    const state = await this.loadEventState(taskId);
    const afterSequence = options?.afterSeq ?? 0;

    return {
      events: state.events.filter(event => event.seq > afterSequence),
      warnings: state.warnings,
      integrityFailed: state.integrityFailed || state.hasFutureSchema,
    };
  }

  private async prepareMessagesForAppend(taskId: string): Promise<void> {
    let raw: string;

    try {
      raw = await fs.readFile(this.taskFile(taskId, 'messages.jsonl'), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; }
      throw error;
    }

    const parsed = parseJsonlSafe(raw, `messages.jsonl[${taskId}]`);
    if (parsed.hasMalformedMiddle) {
      throw new Error(
        `[TaskStore] Message log for task "${taskId}" contains malformed historical data. ` +
        `Manual repair is required before new messages can be appended.`,
      );
    }

    const incompatible = parsed.records.some(record => {
      const message = record as Partial<PersistedMessage>;
      return message.schemaVersion !== MESSAGE_SCHEMA_VERSION;
    });

    if (incompatible) {
      throw new Error(
        `[TaskStore] Message log for task "${taskId}" contains an unsupported schema version.`,
      );
    }

    if (parsed.truncatedFinalLine) {
      await this.repairTruncatedJsonl(taskId, 'messages.jsonl', parsed.records);
    }
  }

  async appendMessage(
    taskId: string,
    message: Omit<PersistedMessage, 'schemaVersion' | 'messageId' | 'taskId'>,
  ): Promise<PersistedMessage> {
    return this.serializedWrite(taskId, async () => {
      await this.prepareMessagesForAppend(taskId);

      let content = redactStringContent(message.content);
      if (message.role === 'tool' && content.length > MAX_TOOL_OUTPUT_CHARS) {
        const limited = OutputLimiter.truncate(content, MAX_TOOL_OUTPUT_CHARS, 'tool result');
        content = limited.text;
      }

      const persisted: PersistedMessage = {
        schemaVersion: MESSAGE_SCHEMA_VERSION,
        messageId: `msg_${taskId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        ...message,
        content,
      };

      const line = `${JSON.stringify(persisted)}\n`;

      try {
        await this.ensureStorageCapacity(taskId, Buffer.byteLength(line, 'utf8'));
      } catch (error) {
        if (error instanceof TaskStorageLimitError) {
          await this.markTaskBlockedForStorageLimit(taskId, error);
        }
        throw error;
      }

      await fs.mkdir(this.getTaskDir(taskId), { recursive: true });
      await fs.appendFile(this.taskFile(taskId, 'messages.jsonl'), line, 'utf8');
      return persisted;
    });
  }

  async getMessages(taskId: string): Promise<PersistedMessage[]> {
    let raw: string;

    try {
      raw = await fs.readFile(this.taskFile(taskId, 'messages.jsonl'), 'utf8');
    } catch {
      return [];
    }

    const parsed = parseJsonlSafe(raw, `messages.jsonl[${taskId}]`);
    if (parsed.warnings.length > 0) {
      Logger.warn(
        `[TaskStore] Message parse warnings for ${taskId}: ${parsed.warnings.join('; ')}`,
      );
    }

    const messages: PersistedMessage[] = [];
    for (const record of parsed.records) {
      const message = record as PersistedMessage;
      if (message.schemaVersion !== MESSAGE_SCHEMA_VERSION) {
        Logger.warn(
          `[TaskStore] Unsupported message schema version ${message.schemaVersion} ` +
          `in task ${taskId} — skipping`,
        );
        continue;
      }
      if (!message.messageId || !message.role || typeof message.content !== 'string') {
        Logger.warn(`[TaskStore] Malformed message record in task ${taskId} — skipping`);
        continue;
      }
      messages.push(message);
    }

    return messages;
  }

  private async readApprovals(taskId: string): Promise<Record<string, PersistedApproval>> {
    try {
      const raw = await fs.readFile(this.taskFile(taskId, 'approvals.json'), 'utf8');
      return JSON.parse(raw) as Record<string, PersistedApproval>;
    } catch {
      return {};
    }
  }

  private async writeApprovals(
    taskId: string,
    approvals: Record<string, PersistedApproval>,
  ): Promise<void> {
    await this.atomicWriteTaskFile(
      taskId,
      'approvals.json',
      JSON.stringify(approvals, null, 2),
    );
  }

  async persistApproval(
    taskId: string,
    approval: Omit<PersistedApproval, 'schemaVersion' | 'taskId'>,
  ): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const approvals = await this.readApprovals(taskId);
      approvals[approval.approvalId] = {
        schemaVersion: APPROVAL_SCHEMA_VERSION,
        taskId,
        ...approval,
        argsSummary: redactArgs(approval.argsSummary),
      };
      await this.writeApprovals(taskId, approvals);
    });
  }

  async updateApproval(
    taskId: string,
    approvalId: string,
    updates: Partial<PersistedApproval>,
  ): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const approvals = await this.readApprovals(taskId);
      const current = approvals[approvalId];

      if (!current) {
        Logger.warn(
          `[TaskStore] updateApproval: approval ${approvalId} not found in task ${taskId}`,
        );
        return;
      }

      const sanitized: Partial<PersistedApproval> = { ...updates };
      if (sanitized.argsSummary) {
        sanitized.argsSummary = redactArgs(sanitized.argsSummary);
      }

      approvals[approvalId] = { ...current, ...sanitized };
      await this.writeApprovals(taskId, approvals);
    });
  }

  async getApproval(taskId: string, approvalId: string): Promise<PersistedApproval | null> {
    const approvals = await this.readApprovals(taskId);
    return approvals[approvalId] ?? null;
  }

  async getCurrentApprovals(taskId: string): Promise<PersistedApproval[]> {
    const approvals = await this.readApprovals(taskId);
    return Object.values(approvals);
  }

  async interruptPendingApprovals(taskId: string): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const approvals = await this.readApprovals(taskId);
      let changed = false;

      for (const approvalId of Object.keys(approvals)) {
        if (approvals[approvalId].status !== 'pending') { continue; }
        approvals[approvalId] = {
          ...approvals[approvalId],
          status: 'interrupted' as PersistedApprovalStatus,
          resolvedAt: new Date().toISOString(),
        };
        changed = true;
      }

      if (changed) {
        await this.writeApprovals(taskId, approvals);
      }
    });
  }

  private async readCheckpointRefs(taskId: string): Promise<PersistedCheckpointRef[]> {
    try {
      const raw = await fs.readFile(this.taskFile(taskId, 'checkpoints.json'), 'utf8');
      return JSON.parse(raw) as PersistedCheckpointRef[];
    } catch {
      return [];
    }
  }

  private async writeCheckpointRefs(
    taskId: string,
    references: PersistedCheckpointRef[],
  ): Promise<void> {
    await this.atomicWriteTaskFile(
      taskId,
      'checkpoints.json',
      JSON.stringify(references, null, 2),
    );
  }

  async addCheckpointRef(
    taskId: string,
    reference: Omit<PersistedCheckpointRef, 'taskId'>,
  ): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const references = await this.readCheckpointRefs(taskId);
      references.push({ ...reference, taskId });
      await this.writeCheckpointRefs(taskId, references);
    });
  }

  async getCheckpointRefs(taskId: string): Promise<PersistedCheckpointRef[]> {
    return this.readCheckpointRefs(taskId);
  }

  async updateCheckpointRef(
    taskId: string,
    checkpointId: string,
    updates: Partial<PersistedCheckpointRef>,
  ): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const references = await this.readCheckpointRefs(taskId);
      const index = references.findIndex(reference => reference.checkpointId === checkpointId);

      if (index === -1) {
        Logger.warn(
          `[TaskStore] updateCheckpointRef: ${checkpointId} not found in task ${taskId}`,
        );
        return;
      }

      references[index] = { ...references[index], ...updates };
      await this.writeCheckpointRefs(taskId, references);
    });
  }

  async writeSnapshot(taskId: string): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const task = await this.getTask(taskId);
      if (!task) { return; }

      const eventState = await this.getEvents(taskId);
      if (eventState.integrityFailed) {
        throw new Error(
          `[TaskStore] Cannot write snapshot for task "${taskId}" because its event log ` +
          `has an integrity failure.`,
        );
      }

      const snapshotSequence = eventState.events.length > 0
        ? eventState.events[eventState.events.length - 1].seq
        : 0;
      const approvals = await this.readApprovals(taskId);
      const pendingApproval = Object.values(approvals).find(
        approval => approval.status === 'pending',
      );
      const checkpointReferences = await this.readCheckpointRefs(taskId);

      const snapshot: TaskSnapshot = {
        schemaVersion: SNAPSHOT_SCHEMA_VERSION,
        taskId,
        snapshotSeq: snapshotSequence,
        timestamp: new Date().toISOString(),
        task,
        pendingApproval,
        checkpointRefs: checkpointReferences,
      };

      await this.atomicWriteTaskFile(
        taskId,
        'state.json',
        JSON.stringify(snapshot, null, 2),
      );
    });
  }

  async readSnapshot(taskId: string): Promise<TaskSnapshot | null> {
    try {
      const raw = await fs.readFile(this.taskFile(taskId, 'state.json'), 'utf8');
      const snapshot = JSON.parse(raw) as TaskSnapshot;

      if (snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
        Logger.warn(
          `[TaskStore] Unsupported snapshot schema version ${snapshot.schemaVersion} ` +
          `for task ${taskId}`,
        );
        return null;
      }

      return snapshot;
    } catch {
      return null;
    }
  }

  async reconstructFromEvents(taskId: string): Promise<PersistedTask | null> {
    const { events, warnings, integrityFailed } = await this.getEvents(taskId);

    if (warnings.length > 0) {
      Logger.warn(
        `[TaskStore] Reconstruction warnings for ${taskId}: ${warnings.join('; ')}`,
      );
    }

    if (integrityFailed) {
      throw new Error(
        `[TaskStore] Cannot reconstruct task "${taskId}" — event-log integrity is compromised.`,
      );
    }

    if (events.length === 0) { return null; }

    let status: PersistedTaskStatus = 'created';
    let model = '';
    let mode = '';
    let providerType = '';
    let userGoal = '';
    let workspaceId = '';
    let workspaceRoot = '';
    let currentIteration = 0;
    let startedAt: string | undefined;
    let completedAt: string | undefined;
    let cancelledAt: string | undefined;
    let failure: { message: string; timestamp: string } | undefined;

    for (const event of events) {
      switch (event.type) {
        case 'task_created':
          userGoal = String(event.payload['userGoal'] ?? '');
          mode = String(event.payload['mode'] ?? '');
          model = String(event.payload['model'] ?? '');
          providerType = String(event.payload['providerType'] ?? '');
          workspaceId = String(event.payload['workspaceId'] ?? '');
          workspaceRoot = String(event.payload['workspaceRoot'] ?? '');
          break;
        case 'task_started':
          status = 'running';
          startedAt = event.timestamp;
          break;
        case 'model_selected':
          model = String(event.payload['model'] ?? model);
          break;
        case 'iteration_started':
          currentIteration = Number(event.payload['iteration'] ?? currentIteration);
          break;
        case 'approval_requested':
          status = 'waiting_for_approval';
          break;
        case 'approval_resolved':
          status = 'running';
          break;
        case 'task_completed':
          status = 'completed';
          completedAt = event.timestamp;
          break;
        case 'task_cancelled':
          status = 'cancelled';
          cancelledAt = event.timestamp;
          break;
        case 'task_failed':
          status = 'failed';
          failure = {
            message: redactStringContent(
              String(event.payload['error'] ?? event.payload['message'] ?? 'Unknown error'),
            ),
            timestamp: event.timestamp,
          };
          break;
        case 'task_paused':
          status = 'paused';
          break;
        case 'task_resumed':
          status = 'running';
          break;
        case 'task_blocked':
          status = 'blocked';
          break;
        case 'recovery_started':
          status = 'recovering';
          break;
        default:
          break;
      }
    }

    const firstEvent = events[0];
    return {
      schemaVersion: TASK_SCHEMA_VERSION,
      taskId,
      workspaceId,
      workspaceRoot,
      userGoal,
      mode,
      status,
      providerType,
      model,
      createdAt: firstEvent.timestamp,
      updatedAt: events[events.length - 1].timestamp,
      startedAt,
      completedAt,
      cancelledAt,
      failure,
      currentIteration: currentIteration > 0 ? currentIteration : undefined,
    };
  }

  private lockFile(taskId: string): string {
    return this.taskFile(taskId, 'lock.json');
  }

  private heartbeatAge(lock: TaskLock): number {
    const timestamp = new Date(lock.heartbeatAt ?? lock.lockedAt).getTime();
    return Number.isFinite(timestamp) ? Date.now() - timestamp : Number.POSITIVE_INFINITY;
  }

  async acquireLock(taskId: string, extensionSessionId: string): Promise<boolean> {
    return this.serializedWrite(taskId, async () => {
      const existing = await this.readLock(taskId);

      if (existing && existing.extensionSessionId !== extensionSessionId) {
        const alive = await this.isPidAlive(existing.pid);
        const heartbeatAge = this.heartbeatAge(existing);
        const stale = !alive || heartbeatAge > LOCK_HEARTBEAT_STALE_MS;

        if (!stale) {
          Logger.warn(
            `[TaskStore] Lock for ${taskId} is held by PID ${existing.pid}, ` +
            `session ${existing.extensionSessionId}; heartbeat age ${heartbeatAge}ms.`,
          );
          return false;
        }

        Logger.info(
          `[TaskStore] Recovering stale lock for ${taskId} ` +
          `(alive=${alive}, heartbeatAge=${heartbeatAge}ms).`,
        );
      }

      const now = new Date().toISOString();
      const lock: TaskLock = {
        taskId,
        pid: process.pid,
        hostname: os.hostname(),
        lockedAt: existing?.extensionSessionId === extensionSessionId
          ? existing.lockedAt
          : now,
        heartbeatAt: now,
        extensionSessionId,
      };

      await this.atomicWriteTaskFile(
        taskId,
        'lock.json',
        JSON.stringify(lock, null, 2),
      );
      return true;
    });
  }

  async releaseLock(taskId: string, extensionSessionId?: string): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      if (extensionSessionId) {
        const lock = await this.readLock(taskId);
        if (!lock || lock.extensionSessionId !== extensionSessionId) { return; }
      }

      try {
        await fs.unlink(this.lockFile(taskId));
      } catch {
        // Already absent.
      }
    });
  }

  async updateLockHeartbeat(taskId: string, extensionSessionId: string): Promise<void> {
    await this.serializedWrite(taskId, async () => {
      const lock = await this.readLock(taskId);
      if (!lock || lock.extensionSessionId !== extensionSessionId) { return; }

      const updated: TaskLock = {
        ...lock,
        heartbeatAt: new Date().toISOString(),
      };

      await this.atomicWriteTaskFile(
        taskId,
        'lock.json',
        JSON.stringify(updated, null, 2),
      );
    });
  }

  async readLock(taskId: string): Promise<TaskLock | null> {
    try {
      const raw = await fs.readFile(this.lockFile(taskId), 'utf8');
      return JSON.parse(raw) as TaskLock;
    } catch {
      return null;
    }
  }

  async isLockStale(taskId: string): Promise<boolean> {
    const lock = await this.readLock(taskId);
    if (!lock) { return false; }

    const alive = await this.isPidAlive(lock.pid);
    return !alive || this.heartbeatAge(lock) > LOCK_HEARTBEAT_STALE_MS;
  }

  private async isPidAlive(pid: number): Promise<boolean> {
    if (pid <= 0) { return false; }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code !== 'ESRCH';
    }
  }

  async archiveTask(taskId: string): Promise<void> {
    const source = this.getTaskDir(taskId);
    const destination = path.join(this.tasksRoot, `archived-${taskId}`);

    await fs.rename(source, destination);
    this.seqCounters.delete(taskId);
    this.integrityFlags.delete(taskId);
    this.writeQueues.delete(taskId);
  }

  /**
   * Lists archived tasks for the History view. The returned `taskId` is the
   * on-disk archive directory name (`archived-<original id>`), not the id
   * stored inside task.json — callers must address these tasks using that
   * value, since `getTaskDir` resolves directories by the id passed in, not
   * by the task's own recorded id.
   */
  async listArchivedTasks(): Promise<PersistedTask[]> {
    const tasks: PersistedTask[] = [];

    try {
      const entries = await fs.readdir(this.tasksRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || !entry.name.startsWith('archived-')) { continue; }
        const task = await this.getTask(entry.name);
        if (task) { tasks.push({ ...task, taskId: entry.name }); }
      }
    } catch {
      // No tasks directory yet.
    }

    return tasks.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  /**
   * Archives terminal tasks (blocked, failed, cancelled, completed) whose
   * last update is older than `maxAgeMs`. Running and waiting-for-approval
   * tasks are never eligible, regardless of age.
   */
  async archiveStaleTasks(maxAgeMs: number): Promise<string[]> {
    const archivableStatuses = new Set<PersistedTaskStatus>(['blocked', 'failed', 'cancelled', 'completed']);
    const cutoff = Date.now() - maxAgeMs;
    const tasks = await this.listTasks();
    const archived: string[] = [];

    for (const task of tasks) {
      if (!archivableStatuses.has(task.status)) { continue; }
      const updatedAt = Date.parse(task.updatedAt);
      if (!Number.isFinite(updatedAt) || updatedAt > cutoff) { continue; }
      try {
        await this.archiveTask(task.taskId);
        archived.push(task.taskId);
      } catch {
        // Best-effort: one failure must not block archiving the rest.
      }
    }

    return archived;
  }

  async deleteTask(taskId: string): Promise<void> {
    await fs.rm(this.getTaskDir(taskId), { recursive: true, force: true });
    this.seqCounters.delete(taskId);
    this.integrityFlags.delete(taskId);
    this.writeQueues.delete(taskId);
  }

  async pruneCompletedTasks(maxCompleted: number): Promise<string[]> {
    const tasks = await this.listTasks();
    const terminalTasks = tasks.filter(task =>
      task.status === 'completed' ||
      task.status === 'cancelled' ||
      task.status === 'failed',
    );

    terminalTasks.sort((left, right) => left.createdAt.localeCompare(right.createdAt));

    const deleteCount = Math.max(0, terminalTasks.length - Math.max(0, maxCompleted));
    const toDelete = terminalTasks.slice(0, deleteCount);
    const deleted: string[] = [];

    for (const task of toDelete) {
      try {
        await this.deleteTask(task.taskId);
        deleted.push(task.taskId);
      } catch {
        // Conservative cleanup: one failure must not affect active tasks.
      }
    }

    return deleted;
  }
}
