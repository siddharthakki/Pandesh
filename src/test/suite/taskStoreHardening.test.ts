import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskRecovery } from '../../agent/TaskRecovery';
import { TaskStore, parseJsonlSafe } from '../../agent/TaskStore';
import {
  EVENT_SCHEMA_VERSION,
  PersistedEvent,
  TaskLock,
} from '../../agent/TaskTypes';

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Harden durable persistence',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

function eventsPath(root: string, taskId: string): string {
  return path.join(root, '.ollama-agent', 'tasks', taskId, 'events.jsonl');
}

function taskDirectory(root: string, taskId: string): string {
  return path.join(root, '.ollama-agent', 'tasks', taskId);
}

function event(
  taskId: string,
  eventId: string,
  seq: number,
  type: PersistedEvent['type'] = 'task_started',
): PersistedEvent {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    eventId,
    taskId,
    seq,
    timestamp: new Date().toISOString(),
    type,
    payload: {},
  };
}

describe('Phase 5 hardening — JSONL integrity', () => {
  it('treats only the malformed final record as crash-truncated', () => {
    const parsed = parseJsonlSafe(
      '{"value":1}\n{"value":2}\n{"value":',
      'events',
    );

    expect(parsed.records).toHaveLength(2);
    expect(parsed.truncatedFinalLine).toBe(true);
    expect(parsed.hasMalformedMiddle).toBe(false);
    expect(parsed.hasIntegrityIssue).toBe(false);
  });

  it('marks a malformed historical line as an integrity failure', () => {
    const parsed = parseJsonlSafe(
      '{"value":1}\n{broken}\n{"value":3}\n',
      'events',
    );

    expect(parsed.records).toHaveLength(2);
    expect(parsed.truncatedFinalLine).toBe(false);
    expect(parsed.hasMalformedMiddle).toBe(true);
    expect(parsed.hasIntegrityIssue).toBe(true);
  });

  describe('event-log validation', () => {
    let root: string;
    let store: TaskStore;
    const taskId = 'task_integrity_hardening';

    beforeEach(async () => {
      root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-integrity-'));
      store = new TaskStore(root);
      await store.createTask({ taskId, ...BASE_TASK });
    });

    afterEach(async () => {
      await fs.rm(root, { recursive: true, force: true });
    });

    it('flags duplicate sequence numbers', async () => {
      await fs.writeFile(
        eventsPath(root, taskId),
        `${JSON.stringify(event(taskId, 'evt-1', 1))}\n` +
          `${JSON.stringify(event(taskId, 'evt-2', 1))}\n`,
        'utf8',
      );

      const result = await new TaskStore(root).getEvents(taskId);
      expect(result.integrityFailed).toBe(true);
      expect(result.warnings.some(warning => /duplicate sequence/i.test(warning))).toBe(true);
    });

    it('flags sequence gaps and refuses reconstruction', async () => {
      await fs.writeFile(
        eventsPath(root, taskId),
        `${JSON.stringify(event(taskId, 'evt-1', 1))}\n` +
          `${JSON.stringify(event(taskId, 'evt-3', 3, 'task_completed'))}\n`,
        'utf8',
      );

      const restartedStore = new TaskStore(root);
      const result = await restartedStore.getEvents(taskId);
      expect(result.integrityFailed).toBe(true);
      await expect(restartedStore.reconstructFromEvents(taskId)).rejects.toThrow(/integrity/i);
    });

    it('treats future event schemas as incompatible', async () => {
      const future = {
        ...event(taskId, 'evt-future', 1),
        schemaVersion: EVENT_SCHEMA_VERSION + 1,
      };
      await fs.writeFile(eventsPath(root, taskId), `${JSON.stringify(future)}\n`, 'utf8');

      const restartedStore = new TaskStore(root);
      const result = await restartedStore.getEvents(taskId);
      expect(result.events).toHaveLength(0);
      expect(result.integrityFailed).toBe(true);
      await expect(
        restartedStore.appendEvent(taskId, 'user_message', { content: 'unsafe append' }),
      ).rejects.toThrow(/corrupt|incompatible|repair/i);
    });

    it('refuses appends after malformed historical data', async () => {
      await fs.writeFile(
        eventsPath(root, taskId),
        `${JSON.stringify(event(taskId, 'evt-1', 1))}\n{broken}\n` +
          `${JSON.stringify(event(taskId, 'evt-3', 3))}\n`,
        'utf8',
      );

      const restartedStore = new TaskStore(root);
      await expect(
        restartedStore.appendEvent(taskId, 'user_message', { content: 'must not append' }),
      ).rejects.toThrow(/corrupt|repair/i);
    });

    it('repairs a truncated final record before appending a new event', async () => {
      await fs.writeFile(
        eventsPath(root, taskId),
        `${JSON.stringify(event(taskId, 'evt-1', 1))}\n{"partial":`,
        'utf8',
      );

      const restartedStore = new TaskStore(root);
      const appended = await restartedStore.appendEvent(
        taskId,
        'user_message',
        { content: 'safe append' },
      );

      expect(appended.seq).toBe(2);
      const raw = await fs.readFile(eventsPath(root, taskId), 'utf8');
      const lines = raw.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(() => lines.forEach(line => JSON.parse(line))).not.toThrow();
    });
  });
});

describe('Phase 5 hardening — locks', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_lock_hardening';
  const sessionA = 'extension-session-a';
  const sessionB = 'extension-session-b';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-lock-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a second live session with a fresh heartbeat', async () => {
    expect(await store.acquireLock(taskId, sessionA)).toBe(true);
    expect(await store.acquireLock(taskId, sessionB)).toBe(false);
  });

  it('allows the owning session to refresh its heartbeat', async () => {
    await store.acquireLock(taskId, sessionA);
    const before = await store.readLock(taskId);
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.updateLockHeartbeat(taskId, sessionA);
    const after = await store.readLock(taskId);

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.heartbeatAt > before!.heartbeatAt).toBe(true);
  });

  it('does not allow another session to update the heartbeat', async () => {
    await store.acquireLock(taskId, sessionA);
    const before = await store.readLock(taskId);
    await store.updateLockHeartbeat(taskId, sessionB);
    const after = await store.readLock(taskId);

    expect(after!.heartbeatAt).toBe(before!.heartbeatAt);
  });

  it('recovers an invalid PID lock', async () => {
    const lockPath = path.join(taskDirectory(root, taskId), 'lock.json');
    const now = new Date().toISOString();
    const lock: TaskLock = {
      taskId,
      pid: 0,
      hostname: 'test',
      lockedAt: now,
      heartbeatAt: now,
      extensionSessionId: sessionA,
    };
    await fs.writeFile(lockPath, JSON.stringify(lock), 'utf8');

    expect(await store.acquireLock(taskId, sessionB)).toBe(true);
  });

  it('recovers a stale heartbeat even when the PID has been reused', async () => {
    const lockPath = path.join(taskDirectory(root, taskId), 'lock.json');
    const stale = new Date(Date.now() - 120_000).toISOString();
    const lock: TaskLock = {
      taskId,
      pid: process.pid,
      hostname: 'test',
      lockedAt: stale,
      heartbeatAt: stale,
      extensionSessionId: sessionA,
    };
    await fs.writeFile(lockPath, JSON.stringify(lock), 'utf8');

    expect(await store.acquireLock(taskId, sessionB)).toBe(true);
  });
});

describe('Phase 5 hardening — secret redaction', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_redaction_hardening';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-redaction-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('redacts nested structured secrets from event payloads', async () => {
    const persisted = await store.appendEvent(taskId, 'tool_started', {
      arguments: {
        settings: {
          apiKey: 'secret-api-key',
          retries: 3,
        },
      },
    });

    const argumentsValue = persisted.payload['arguments'] as Record<string, unknown>;
    const settings = argumentsValue['settings'] as Record<string, unknown>;
    expect(settings['apiKey']).toBe('[REDACTED]');
    expect(settings['retries']).toBe(3);
  });

  it('redacts authorization headers in persisted messages', async () => {
    await store.appendMessage(taskId, {
      role: 'tool',
      content: 'Authorization: Bearer secret-provider-token\nstatus=200',
      timestamp: new Date().toISOString(),
    });

    const messages = await store.getMessages(taskId);
    expect(messages[0].content).not.toContain('secret-provider-token');
    expect(messages[0].content).toContain('[REDACTED]');
  });

  it('redacts secrets in persisted failure messages', async () => {
    await store.updateTaskStatus(taskId, 'failed', {
      failure: {
        message: 'api_key=super-secret-value',
        timestamp: new Date().toISOString(),
      },
    });

    const task = await store.getTask(taskId);
    expect(task!.failure!.message).not.toContain('super-secret-value');
    expect(task!.failure!.message).toContain('[REDACTED]');
  });

  it('does not alter ordinary output', async () => {
    const content = 'Compiled 42 files successfully';
    await store.appendMessage(taskId, {
      role: 'tool',
      content,
      timestamp: new Date().toISOString(),
    });

    const messages = await store.getMessages(taskId);
    expect(messages[0].content).toBe(content);
  });
});

describe('Phase 5 hardening — interrupted mutation recovery', () => {
  let root: string;
  let store: TaskStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-recovery-'));
    store = new TaskStore(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks a task whose last tool lifecycle event is tool_started', async () => {
    const taskId = 'task_unknown_mutation';
    await store.createTask({ taskId, ...BASE_TASK });
    await store.updateTaskStatus(taskId, 'running');
    await store.appendEvent(taskId, 'task_started', {});
    await store.appendEvent(taskId, 'tool_started', {
      toolName: 'write_file',
      toolCallId: 'call-1',
    });

    const candidates = await new TaskRecovery(store).scan();
    const candidate = candidates.find(item => item.taskId === taskId);

    expect(candidate).toBeDefined();
    expect(candidate!.mutationOutcomeUncertain).toBe(true);
    expect(candidate!.issues[0]).toMatch(/DANGER|uncertain/i);

    const persisted = await store.getTask(taskId);
    expect(persisted!.status).toBe('blocked');

    const events = await store.getEvents(taskId);
    const blocked = events.events.find(item => item.type === 'task_blocked');
    expect(blocked?.payload['reason']).toBe('mutation_outcome_uncertain');
  });

  it('marks a checkpoint without a matching result as uncertain', async () => {
    const taskId = 'task_unknown_checkpoint';
    await store.createTask({ taskId, ...BASE_TASK });
    await store.updateTaskStatus(taskId, 'running');
    await store.appendEvent(taskId, 'task_started', {});
    await store.addCheckpointRef(taskId, {
      checkpointId: 'checkpoint-1',
      toolCallId: 'call-1',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
      affectedPaths: ['/workspace/file.ts'],
      restorationStatus: 'none',
      retained: true,
    });

    const candidates = await new TaskRecovery(store).scan();
    const candidate = candidates.find(item => item.taskId === taskId);

    expect(candidate?.interruptionKind).toBe('checkpoint_exists_result_missing');
    expect(candidate?.mutationOutcomeUncertain).toBe(true);
    expect(candidate?.lastCheckpointRef?.checkpointId).toBe('checkpoint-1');
  });

  it('does not classify a plain inference interruption as a mutation uncertainty', async () => {
    const taskId = 'task_inference_interruption';
    await store.createTask({ taskId, ...BASE_TASK });
    await store.updateTaskStatus(taskId, 'running');
    await store.appendEvent(taskId, 'task_started', {});
    await store.appendEvent(taskId, 'iteration_started', { iteration: 1 });

    const candidates = await new TaskRecovery(store).scan();
    const candidate = candidates.find(item => item.taskId === taskId);

    expect(candidate?.interruptionKind).toBe('inference_interrupted');
    expect(candidate?.mutationOutcomeUncertain).toBe(false);
  });
});

describe('Phase 5 hardening — storage limit', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_storage_hardening';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-storage-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
    await store.updateTaskStatus(taskId, 'running');
    await store.addCheckpointRef(taskId, {
      checkpointId: 'checkpoint-retained',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
      affectedPaths: ['/workspace/file.ts'],
      restorationStatus: 'none',
      retained: true,
    });

    const oversized = path.join(taskDirectory(root, taskId), 'oversized.bin');
    await fs.writeFile(oversized, '');
    await fs.truncate(oversized, 51 * 1024 * 1024);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects a new event, blocks the active task, and preserves checkpoint metadata', async () => {
    await expect(
      store.appendEvent(taskId, 'user_message', { content: 'cannot persist' }),
    ).rejects.toThrow(/storage limit/i);

    const task = await store.getTask(taskId);
    expect(task!.status).toBe('blocked');
    expect(task!.failure?.code).toBe('TASK_STORAGE_LIMIT');
    expect(task!.failure?.message).toMatch(/archive|delete/i);

    const references = await store.getCheckpointRefs(taskId);
    expect(references.some(reference => reference.checkpointId === 'checkpoint-retained')).toBe(true);
  });

  it('does not prune the blocked task', async () => {
    await store.appendEvent(taskId, 'user_message', {}).catch(() => undefined);
    await store.pruneCompletedTasks(0);
    expect(await store.getTask(taskId)).not.toBeNull();
  });
});
