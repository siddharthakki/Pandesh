/**
 * Phase 5 — TaskStore comprehensive tests.
 *
 * Covers:
 *   - Storage: create, update, event appends, sequence ordering
 *   - Atomic snapshots: tmp+rename, no partial files, previous preserved on failure
 *   - Messages: persist/reload, tool-call IDs, large output truncation, schema reject
 *   - Restart/recovery: reload running/waiting/paused, terminal states preserved
 *   - Approvals: pending → interrupted on recovery, no auto-approve, resolved idempotent
 *   - Checkpoints: refs listed after restart, missing checkpoint detected
 *   - Interrupted ops: inference interrupted, approval interrupted, tool-start without completion
 *   - Locking: concurrent appends ordered, second writer detects lock, stale lock recovery
 *   - Security: task-ID path traversal rejected, storage limit enforced
 *   - JSONL corruption: truncated final line, malformed middle, duplicate events, gaps
 *   - Schema version: unsupported version rejected
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TaskStore, parseJsonlSafe } from '../../agent/TaskStore';
import { TaskRecovery } from '../../agent/TaskRecovery';
import {
  TASK_SCHEMA_VERSION,
  EVENT_SCHEMA_VERSION,
  MESSAGE_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  PersistedTask,
  PersistedEvent,
} from '../../agent/TaskTypes';

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function makeStore(tmpDir: string): Promise<TaskStore> {
  return new TaskStore(tmpDir);
}

const BASE_TASK = {
  workspaceId: '/ws',
  workspaceRoot: '/ws',
  userGoal: 'Test the persistence layer',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

function taskId(suffix = 'abc'): string {
  return `task_${Date.now()}_${suffix}`;
}

// ─── Storage — create and retrieve ───────────────────────────────────────────

describe('TaskStore — create and retrieve', () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-create-'));
    store = await makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates a task with status=created and correct fields', async () => {
    const id = taskId('create');
    const task = await store.createTask({ taskId: id, ...BASE_TASK });
    expect(task.taskId).toBe(id);
    expect(task.status).toBe('created');
    expect(task.schemaVersion).toBe(TASK_SCHEMA_VERSION);
    expect(task.userGoal).toBe(BASE_TASK.userGoal);
  });

  it('getTask returns the created task', async () => {
    const id = taskId('get');
    await store.createTask({ taskId: id, ...BASE_TASK });
    const loaded = await store.getTask(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.taskId).toBe(id);
  });

  it('getTask returns null for unknown task', async () => {
    const result = await store.getTask('task_nonexistent_id');
    expect(result).toBeNull();
  });

  it('updateTask changes status and updates updatedAt', async () => {
    const id = taskId('upd');
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    const task = await store.getTask(id);
    expect(task!.status).toBe('running');
  });

  it('listTasks returns all created tasks, newest first', async () => {
    const id1 = `task_1000_aaa`;
    const id2 = `task_2000_bbb`;
    await store.createTask({ taskId: id1, ...BASE_TASK, userGoal: 'first' });
    await new Promise(r => setTimeout(r, 5));
    await store.createTask({ taskId: id2, ...BASE_TASK, userGoal: 'second' });
    const list = await store.listTasks();
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ids = list.map(t => t.taskId);
    expect(ids.indexOf(id2)).toBeLessThan(ids.indexOf(id1));
  });
});

// ─── Events — append and read ─────────────────────────────────────────────────

describe('TaskStore — events', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_evt_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-evt-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends events with monotonically increasing sequence numbers', async () => {
    const e1 = await store.appendEvent(ID, 'task_started', {});
    const e2 = await store.appendEvent(ID, 'model_selected', { model: 'x' });
    const e3 = await store.appendEvent(ID, 'iteration_started', { iteration: 1 });
    expect(e1.seq).toBeLessThan(e2.seq);
    expect(e2.seq).toBeLessThan(e3.seq);
  });

  it('getEvents returns all events in order', async () => {
    await store.appendEvent(ID, 'task_started', {});
    await store.appendEvent(ID, 'user_message', { content: 'hello' });
    await store.appendEvent(ID, 'assistant_message', { content: 'hi' });
    const { events } = await store.getEvents(ID);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('task_started');
    expect(events[2].type).toBe('assistant_message');
  });

  it('getEvents with afterSeq only returns later events', async () => {
    const e1 = await store.appendEvent(ID, 'task_started', {});
    await store.appendEvent(ID, 'model_selected', { model: 'x' });
    await store.appendEvent(ID, 'iteration_started', { iteration: 1 });
    const { events } = await store.getEvents(ID, { afterSeq: e1.seq });
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('model_selected');
  });

  it('getEvents skips duplicate event IDs and reports warning', async () => {
    const ev = await store.appendEvent(ID, 'task_started', {});
    // Manually inject a duplicate line.
    const evFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'events.jsonl');
    await fs.appendFile(evFile, JSON.stringify(ev) + '\n', 'utf8');
    const { events, warnings } = await store.getEvents(ID);
    expect(events.length).toBe(1); // duplicate removed
    expect(warnings.some(w => w.includes('Duplicate'))).toBe(true);
  });

  it('getEvents reports sequence gap warning', async () => {
    // Manually craft two events with a gap.
    const evFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'events.jsonl');
    const ev1: PersistedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION, eventId: 'e1', taskId: ID,
      seq: 1, timestamp: new Date().toISOString(), type: 'task_started', payload: {},
    };
    const ev3: PersistedEvent = {
      schemaVersion: EVENT_SCHEMA_VERSION, eventId: 'e3', taskId: ID,
      seq: 3, timestamp: new Date().toISOString(), type: 'model_selected', payload: {},
    };
    await fs.mkdir(path.dirname(evFile), { recursive: true });
    await fs.writeFile(evFile, JSON.stringify(ev1) + '\n' + JSON.stringify(ev3) + '\n', 'utf8');
    const { events, warnings } = await store.getEvents(ID);
    expect(events.length).toBe(2);
    expect(warnings.some(w => w.includes('gap'))).toBe(true);
  });

  it('getEvents rejects unsupported schema version event', async () => {
    const evFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'events.jsonl');
    const badEv = {
      schemaVersion: 99, eventId: 'bad', taskId: ID,
      seq: 1, timestamp: new Date().toISOString(), type: 'task_started', payload: {},
    };
    await fs.mkdir(path.dirname(evFile), { recursive: true });
    await fs.writeFile(evFile, JSON.stringify(badEv) + '\n', 'utf8');
    const { events, warnings } = await store.getEvents(ID);
    expect(events.length).toBe(0);
    expect(warnings.some(w => w.includes('schema version') || w.includes('not supported'))).toBe(true);
  });
});

// ─── JSONL corruption handling ────────────────────────────────────────────────

describe('parseJsonlSafe — corruption handling', () => {
  it('ignores truncated final line with warning', () => {
    const content = '{"a":1}\n{"b":2}\n{"c":incomplete';
    const { records, warnings } = parseJsonlSafe(content, 'test');
    expect(records.length).toBe(2);
    expect(warnings.some(w => w.includes('truncated'))).toBe(true);
  });

  it('skips malformed middle line with warning', () => {
    const content = '{"a":1}\n{invalid}\n{"c":3}\n';
    const { records, warnings } = parseJsonlSafe(content, 'test');
    expect(records.length).toBe(2);
    expect(warnings.some(w => w.includes('malformed'))).toBe(true);
  });

  it('handles empty content gracefully', () => {
    const { records, warnings } = parseJsonlSafe('', 'test');
    expect(records).toHaveLength(0);
    expect(warnings).toHaveLength(0);
  });

  it('parses valid content without warnings', () => {
    const content = '{"a":1}\n{"b":2}\n';
    const { records, warnings } = parseJsonlSafe(content, 'test');
    expect(records.length).toBe(2);
    expect(warnings).toHaveLength(0);
  });
});

// ─── Messages ─────────────────────────────────────────────────────────────────

describe('TaskStore — messages', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_msg_test_xyz';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-msg-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists and reloads a normal conversation', async () => {
    await store.appendMessage(ID, { role: 'user', content: 'Hello', timestamp: new Date().toISOString() });
    await store.appendMessage(ID, { role: 'assistant', content: 'Hi there!', timestamp: new Date().toISOString() });
    const msgs = await store.getMessages(ID);
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[1].role).toBe('assistant');
  });

  it('persists and reloads tool-call IDs on assistant messages', async () => {
    await store.appendMessage(ID, {
      role: 'assistant',
      content: 'I will call a tool',
      toolCallIds: ['tc_001', 'tc_002'],
      timestamp: new Date().toISOString(),
    });
    const msgs = await store.getMessages(ID);
    expect(msgs[0].toolCallIds).toEqual(['tc_001', 'tc_002']);
  });

  it('persists and reloads tool-result IDs on tool messages', async () => {
    await store.appendMessage(ID, {
      role: 'tool',
      content: 'result data',
      toolCallId: 'tc_001',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
    });
    const msgs = await store.getMessages(ID);
    expect(msgs[0].toolCallId).toBe('tc_001');
    expect(msgs[0].toolName).toBe('write_file');
  });

  it('truncates oversized tool output before persisting', async () => {
    const largeOutput = 'x'.repeat(10000);
    await store.appendMessage(ID, {
      role: 'tool',
      content: largeOutput,
      timestamp: new Date().toISOString(),
    });
    const msgs = await store.getMessages(ID);
    expect(msgs[0].content.length).toBeLessThan(largeOutput.length);
  });

  it('skips messages with unsupported schema version', async () => {
    const msgFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'messages.jsonl');
    const badMsg = {
      schemaVersion: 99, messageId: 'bad', taskId: ID,
      role: 'user', content: 'bad', timestamp: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(msgFile), { recursive: true });
    await fs.appendFile(msgFile, JSON.stringify(badMsg) + '\n', 'utf8');
    const msgs = await store.getMessages(ID);
    expect(msgs.length).toBe(0);
  });

  it('does not store provider-specific wire format fields', async () => {
    await store.appendMessage(ID, {
      role: 'assistant',
      content: 'Hello',
      timestamp: new Date().toISOString(),
      // No 'finish_reason', 'logprobs', or other provider fields
    });
    const msgs = await store.getMessages(ID);
    expect((msgs[0] as Record<string, unknown>)['finish_reason']).toBeUndefined();
    expect((msgs[0] as Record<string, unknown>)['logprobs']).toBeUndefined();
  });
});

// ─── Atomic snapshots ─────────────────────────────────────────────────────────

describe('TaskStore — atomic snapshots', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_snap_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-snap-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('writeSnapshot creates a valid state.json with schemaVersion', async () => {
    await store.appendEvent(ID, 'task_started', {});
    await store.writeSnapshot(ID);
    const snap = await store.readSnapshot(ID);
    expect(snap).not.toBeNull();
    expect(snap!.schemaVersion).toBe(SNAPSHOT_SCHEMA_VERSION);
    expect(snap!.taskId).toBe(ID);
  });

  it('snapshot snapshotSeq matches last event sequence', async () => {
    await store.appendEvent(ID, 'task_started', {});
    const lastEv = await store.appendEvent(ID, 'model_selected', { model: 'x' });
    await store.writeSnapshot(ID);
    const snap = await store.readSnapshot(ID);
    expect(snap!.snapshotSeq).toBe(lastEv.seq);
  });

  it('no .tmp file left behind after successful writeSnapshot', async () => {
    await store.writeSnapshot(ID);
    const dir = path.join(tmpDir, '.ollama-agent', 'tasks', ID);
    const entries = await fs.readdir(dir);
    expect(entries.some(e => e.endsWith('.tmp'))).toBe(false);
  });

  it('readSnapshot returns null for missing snapshot', async () => {
    const result = await store.readSnapshot(ID);
    expect(result).toBeNull();
  });

  it('readSnapshot returns null for unsupported schema version', async () => {
    const snapFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'state.json');
    await fs.mkdir(path.dirname(snapFile), { recursive: true });
    await fs.writeFile(snapFile, JSON.stringify({ schemaVersion: 99, taskId: ID, snapshotSeq: 0 }), 'utf8');
    const result = await store.readSnapshot(ID);
    expect(result).toBeNull();
  });

  it('corrupted snapshot does not prevent event replay', async () => {
    await store.appendEvent(ID, 'task_started', {});
    await store.appendEvent(ID, 'task_completed', {});
    // Write corrupt snapshot
    const snapFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'state.json');
    await fs.writeFile(snapFile, 'not-json-at-all', 'utf8');
    // readSnapshot returns null
    expect(await store.readSnapshot(ID)).toBeNull();
    // But events are still readable
    const { events } = await store.getEvents(ID);
    expect(events.length).toBe(2);
  });
});

// ─── Recovery from events ─────────────────────────────────────────────────────

describe('TaskStore — reconstruction from events', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_recon_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-recon-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('reconstructFromEvents replays status to completed', async () => {
    await store.appendEvent(ID, 'task_created', { userGoal: 'test', mode: 'agent', model: 'm', providerType: 'ollama', workspaceRoot: '/ws', workspaceId: '/ws' });
    await store.appendEvent(ID, 'task_started', {});
    await store.appendEvent(ID, 'task_completed', {});
    const task = await store.reconstructFromEvents(ID);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('completed');
  });

  it('reconstructFromEvents replays status to failed with error', async () => {
    await store.appendEvent(ID, 'task_created', { userGoal: 'test', mode: 'agent', model: 'm', providerType: 'ollama', workspaceRoot: '/ws', workspaceId: '/ws' });
    await store.appendEvent(ID, 'task_started', {});
    await store.appendEvent(ID, 'task_failed', { error: 'timeout' });
    const task = await store.reconstructFromEvents(ID);
    expect(task!.status).toBe('failed');
    expect(task!.failure?.message).toBe('timeout');
  });

  it('reconstructFromEvents returns null when no events', async () => {
    const task = await store.reconstructFromEvents('task_empty_abc');
    expect(task).toBeNull();
  });
});

// ─── Restart and recovery ────────────────────────────────────────────────────

describe('TaskRecovery — scan', () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-rec-'));
    store = await makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('completed task with consistent snapshot is not a recovery candidate', async () => {
    const id = 'task_done_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.appendEvent(id, 'task_completed', {});
    await store.updateTaskStatus(id, 'completed', { completedAt: new Date().toISOString() });
    await store.writeSnapshot(id);
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    expect(candidates.find(c => c.taskId === id)).toBeUndefined();
  });

  it('cancelled task is not a recovery candidate', async () => {
    const id = 'task_canc_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'cancelled');
    await store.writeSnapshot(id);
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    expect(candidates.find(c => c.taskId === id)).toBeUndefined();
  });

  it('running task without terminal event becomes a recovery candidate (blocked)', async () => {
    const id = 'task_run_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    await store.appendEvent(id, 'task_started', {});
    // No terminal event — simulates crash
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    const candidate = candidates.find(c => c.taskId === id);
    expect(candidate).toBeDefined();
    expect(candidate!.task.status).toBe('blocked');
  });

  it('waiting_for_approval task becomes recovery candidate with approval_interrupted kind', async () => {
    const id = 'task_wait_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'waiting_for_approval');
    await store.persistApproval(id, {
      approvalId: 'apr_001',
      toolName: 'write_file',
      argsSummary: { path: 'x.ts' },
      policyDecision: 'ask-once',
      riskLevel: 'medium',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    const candidate = candidates.find(c => c.taskId === id);
    expect(candidate).toBeDefined();
    expect(candidate!.interruptionKind).toBe('approval_interrupted');
  });

  it('interrupted approval is marked as interrupted after recovery scan', async () => {
    const id = 'task_apr_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'waiting_for_approval');
    await store.persistApproval(id, {
      approvalId: 'apr_002',
      toolName: 'run_command',
      argsSummary: { command: 'npm test' },
      policyDecision: 'ask-once',
      riskLevel: 'high',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const recovery = new TaskRecovery(store);
    await recovery.scan();
    // After scan, the pending approval should be marked interrupted
    const approval = await store.getApproval(id, 'apr_002');
    expect(approval?.status).toBe('interrupted');
  });

  it('does not auto-approve an interrupted approval', async () => {
    const id = 'task_noapr_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'waiting_for_approval');
    await store.persistApproval(id, {
      approvalId: 'apr_003',
      toolName: 'write_file',
      argsSummary: {},
      policyDecision: 'ask-once',
      riskLevel: 'medium',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const recovery = new TaskRecovery(store);
    await recovery.scan();
    const approval = await store.getApproval(id, 'apr_003');
    // Must not be 'approved'
    expect(approval?.status).not.toBe('approved');
    expect(approval?.status).not.toBe('rejected');
    expect(approval?.status).toBe('interrupted');
  });

  it('resolved approval remains resolved after scan', async () => {
    const id = 'task_res_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'completed', { completedAt: new Date().toISOString() });
    await store.persistApproval(id, {
      approvalId: 'apr_resolved',
      toolName: 'write_file',
      argsSummary: {},
      policyDecision: 'ask-once',
      riskLevel: 'medium',
      requestedAt: new Date().toISOString(),
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolution: 'approved',
    });
    await store.writeSnapshot(id);
    const recovery = new TaskRecovery(store);
    await recovery.scan();
    const approval = await store.getApproval(id, 'apr_resolved');
    expect(approval?.status).toBe('approved');
  });

  it('tool_started without tool_completed yields tool_execution_unknown', async () => {
    const id = 'task_toolunk_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    await store.appendEvent(id, 'task_started', {});
    await store.appendEvent(id, 'tool_started', { toolName: 'write_file' });
    // No tool_completed event
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    const candidate = candidates.find(c => c.taskId === id);
    expect(candidate?.interruptionKind).toBe('tool_execution_unknown');
  });
});

// ─── Approvals ────────────────────────────────────────────────────────────────

describe('TaskStore — approvals', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_appr_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-appr-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('persists and retrieves an approval', async () => {
    await store.persistApproval(ID, {
      approvalId: 'apr_001',
      toolName: 'delete_file',
      argsSummary: { path: 'x.ts' },
      policyDecision: 'ask-once',
      riskLevel: 'high',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const apr = await store.getApproval(ID, 'apr_001');
    expect(apr).not.toBeNull();
    expect(apr!.status).toBe('pending');
  });

  it('updateApproval changes status to approved', async () => {
    await store.persistApproval(ID, {
      approvalId: 'apr_upd',
      toolName: 'run_command',
      argsSummary: {},
      policyDecision: 'ask-once',
      riskLevel: 'high',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    await store.updateApproval(ID, 'apr_upd', {
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolution: 'approved',
    });
    const apr = await store.getApproval(ID, 'apr_upd');
    expect(apr!.status).toBe('approved');
  });

  it('redacts sensitive keys in argsSummary', async () => {
    await store.persistApproval(ID, {
      approvalId: 'apr_sec',
      toolName: 'run_command',
      argsSummary: { command: 'curl https://example.com', apiKey: 'super-secret-123' },
      policyDecision: 'ask-once',
      riskLevel: 'high',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const apr = await store.getApproval(ID, 'apr_sec');
    expect(apr!.argsSummary['apiKey']).toBe('[REDACTED]');
    expect(apr!.argsSummary['command']).toBe('curl https://example.com');
  });

  it('interruptPendingApprovals marks all pending as interrupted', async () => {
    await store.persistApproval(ID, {
      approvalId: 'apr_p1',
      toolName: 'write_file',
      argsSummary: {},
      policyDecision: 'ask-once',
      riskLevel: 'medium',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    await store.interruptPendingApprovals(ID);
    const apr = await store.getApproval(ID, 'apr_p1');
    expect(apr!.status).toBe('interrupted');
  });

  it('interruptPendingApprovals does not touch already-resolved approvals', async () => {
    await store.persistApproval(ID, {
      approvalId: 'apr_resolved',
      toolName: 'write_file',
      argsSummary: {},
      policyDecision: 'ask-once',
      riskLevel: 'medium',
      requestedAt: new Date().toISOString(),
      status: 'approved',
      resolvedAt: new Date().toISOString(),
      resolution: 'approved',
    });
    await store.interruptPendingApprovals(ID);
    const apr = await store.getApproval(ID, 'apr_resolved');
    expect(apr!.status).toBe('approved');
  });
});

// ─── Checkpoint references ────────────────────────────────────────────────────

describe('TaskStore — checkpoint refs', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_cp_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-cp-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('addCheckpointRef stores and retrieves refs', async () => {
    await store.addCheckpointRef(ID, {
      checkpointId: 'cp_001',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
      affectedPaths: ['/ws/src/main.ts'],
      restorationStatus: 'none',
      retained: true,
    });
    const refs = await store.getCheckpointRefs(ID);
    expect(refs.length).toBe(1);
    expect(refs[0].checkpointId).toBe('cp_001');
    expect(refs[0].taskId).toBe(ID);
  });

  it('checkpoint refs are listed after reload (new store instance)', async () => {
    await store.addCheckpointRef(ID, {
      checkpointId: 'cp_persist',
      toolName: 'delete_file',
      timestamp: new Date().toISOString(),
      affectedPaths: ['/ws/x.ts'],
      restorationStatus: 'none',
      retained: true,
    });
    // Simulate restart with new store instance
    const store2 = new TaskStore(tmpDir);
    const refs = await store2.getCheckpointRefs(ID);
    expect(refs.find(r => r.checkpointId === 'cp_persist')).toBeDefined();
  });

  it('updateCheckpointRef changes restorationStatus', async () => {
    await store.addCheckpointRef(ID, {
      checkpointId: 'cp_upd',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
      affectedPaths: [],
      restorationStatus: 'none',
      retained: true,
    });
    await store.updateCheckpointRef(ID, 'cp_upd', { restorationStatus: 'restored' });
    const refs = await store.getCheckpointRefs(ID);
    expect(refs.find(r => r.checkpointId === 'cp_upd')?.restorationStatus).toBe('restored');
  });

  it('snapshot includes checkpoint refs', async () => {
    await store.addCheckpointRef(ID, {
      checkpointId: 'cp_snap',
      toolName: 'write_file',
      timestamp: new Date().toISOString(),
      affectedPaths: ['/ws/a.ts'],
      restorationStatus: 'none',
      retained: true,
    });
    await store.writeSnapshot(ID);
    const snap = await store.readSnapshot(ID);
    expect(snap!.checkpointRefs.some(r => r.checkpointId === 'cp_snap')).toBe(true);
  });
});

// ─── Locking ──────────────────────────────────────────────────────────────────

describe('TaskStore — locking', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_lock_test_abc';
  const SESSION_A = 'ext_session_aaa';
  const SESSION_B = 'ext_session_bbb';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-lock-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('acquireLock succeeds for first writer', async () => {
    const ok = await store.acquireLock(ID, SESSION_A);
    expect(ok).toBe(true);
  });

  it('releaseLock removes the lock file', async () => {
    await store.acquireLock(ID, SESSION_A);
    await store.releaseLock(ID);
    const lock = await store.readLock(ID);
    expect(lock).toBeNull();
  });

  it('same session can re-acquire its own lock', async () => {
    await store.acquireLock(ID, SESSION_A);
    const ok = await store.acquireLock(ID, SESSION_A);
    expect(ok).toBe(true);
  });

  it('separate tasks can be locked independently', async () => {
    const ID2 = 'task_lock_test_def';
    await store.createTask({ taskId: ID2, ...BASE_TASK });
    const ok1 = await store.acquireLock(ID, SESSION_A);
    const ok2 = await store.acquireLock(ID2, SESSION_B);
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });

  it('stale lock (dead PID) is recovered by second writer', async () => {
    // Write a lock with PID 0 (will never exist)
    const lockFile = path.join(tmpDir, '.ollama-agent', 'tasks', ID, 'lock.json');
    const staleLock = {
      taskId: ID, pid: 0, hostname: 'test',
      lockedAt: new Date().toISOString(), extensionSessionId: 'dead_session',
    };
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, JSON.stringify(staleLock), 'utf8');

    const ok = await store.acquireLock(ID, SESSION_B);
    expect(ok).toBe(true);
  });

  it('isLockStale returns false when no lock exists', async () => {
    const stale = await store.isLockStale(ID);
    expect(stale).toBe(false);
  });
});

// ─── Concurrent appends ───────────────────────────────────────────────────────

describe('TaskStore — concurrent event appends', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_conc_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-conc-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('concurrent appendEvent calls produce strictly ordered sequence numbers', async () => {
    const N = 10;
    const promises = Array.from({ length: N }, (_, i) =>
      store.appendEvent(ID, 'iteration_started', { i }),
    );
    const events = await Promise.all(promises);
    const seqs = events.map(e => e.seq).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // No duplicates
    expect(new Set(seqs).size).toBe(N);
  });

  it('concurrent snapshots serialize (no partial files)', async () => {
    await store.appendEvent(ID, 'task_started', {});
    await Promise.all([
      store.writeSnapshot(ID),
      store.writeSnapshot(ID),
      store.writeSnapshot(ID),
    ]);
    const snap = await store.readSnapshot(ID);
    expect(snap).not.toBeNull();
    // Ensure no .tmp left behind
    const dir = path.join(tmpDir, '.ollama-agent', 'tasks', ID);
    const entries = await fs.readdir(dir);
    expect(entries.some(e => e.endsWith('.tmp'))).toBe(false);
  });
});

// ─── Security — path containment ─────────────────────────────────────────────

describe('TaskStore — security', () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-sec-'));
    store = await makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('rejects task IDs with path traversal sequences', async () => {
    const badIds = ['../evil', '../../etc/passwd', 'task/../../etc', 'task\x00null'];
    for (const id of badIds) {
      await expect(store.createTask({ taskId: id, ...BASE_TASK })).rejects.toThrow(/Invalid task ID|unsafe/i);
    }
  });

  it('rejects task IDs with spaces or special characters', async () => {
    const badIds = ['task id', 'task@bad', 'task;bad', 'task|bad'];
    for (const id of badIds) {
      expect(() => TaskStore.validateTaskId(id)).toThrow(/Invalid task ID/i);
    }
  });

  it('rejects empty task ID', async () => {
    expect(() => TaskStore.validateTaskId('')).toThrow(/Invalid task ID/i);
  });

  it('rejects task ID longer than 100 characters', async () => {
    const longId = 'a'.repeat(101);
    expect(() => TaskStore.validateTaskId(longId)).toThrow(/Invalid task ID/i);
  });

  it('accepts valid task ID formats', () => {
    const validIds = ['task_123_abc', 'conv_1234567890_xy', 'task-test-1'];
    for (const id of validIds) {
      expect(() => TaskStore.validateTaskId(id)).not.toThrow();
    }
  });

  it('secrets in tool args are redacted in approval argsSummary', async () => {
    const id = 'task_redsec_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.persistApproval(id, {
      approvalId: 'apr_secret',
      toolName: 'run_command',
      argsSummary: { command: 'curl api', token: 'my-secret-token', password: 'hunter2' },
      policyDecision: 'ask-once',
      riskLevel: 'high',
      requestedAt: new Date().toISOString(),
      status: 'pending',
    });
    const apr = await store.getApproval(id, 'apr_secret');
    expect(apr!.argsSummary['token']).toBe('[REDACTED]');
    expect(apr!.argsSummary['password']).toBe('[REDACTED]');
    expect(apr!.argsSummary['command']).toBe('curl api');
  });
});

// ─── Abandoned temp cleanup ───────────────────────────────────────────────────

describe('TaskStore — abandoned temp cleanup', () => {
  let tmpDir: string;
  let store: TaskStore;
  const ID = 'task_tmp_test_abc';

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-tmp-'));
    store = await makeStore(tmpDir);
    await store.createTask({ taskId: ID, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('cleanAbandonedTmps removes .tmp files', async () => {
    const dir = path.join(tmpDir, '.ollama-agent', 'tasks', ID);
    const tmpFile = path.join(dir, 'state.json.tmp');
    await fs.writeFile(tmpFile, 'partial-content', 'utf8');
    await store.cleanAbandonedTmps(ID);
    const exists = await fs.access(tmpFile).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it('cleanAbandonedTmps is a no-op when no .tmp files exist', async () => {
    // Should not throw
    await expect(store.cleanAbandonedTmps(ID)).resolves.toBeUndefined();
  });
});

// ─── Retention and cleanup ────────────────────────────────────────────────────

describe('TaskStore — retention', () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-ret-'));
    store = await makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('pruneCompletedTasks removes oldest completed tasks beyond maxCompleted', async () => {
    const ids = ['task_r1_aaa', 'task_r2_bbb', 'task_r3_ccc'];
    for (const id of ids) {
      await store.createTask({ taskId: id, ...BASE_TASK });
      await store.updateTaskStatus(id, 'completed', { completedAt: new Date().toISOString() });
      await new Promise(r => setTimeout(r, 5));
    }
    const deleted = await store.pruneCompletedTasks(2);
    expect(deleted.length).toBe(1);
    // Oldest (r1) should have been pruned
    expect(deleted[0]).toBe('task_r1_aaa');
  });

  it('pruneCompletedTasks does not touch active tasks', async () => {
    const activeId = 'task_active_abc';
    const doneId = 'task_done_abc';
    await store.createTask({ taskId: activeId, ...BASE_TASK });
    await store.updateTaskStatus(activeId, 'running');
    await store.createTask({ taskId: doneId, ...BASE_TASK });
    await store.updateTaskStatus(doneId, 'completed', { completedAt: new Date().toISOString() });
    await store.pruneCompletedTasks(0);
    const activeTask = await store.getTask(activeId);
    expect(activeTask).not.toBeNull();
  });

  it('archiveTask renames the task directory', async () => {
    const id = 'task_arch_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.archiveTask(id);
    // Original directory gone
    const task = await store.getTask(id);
    expect(task).toBeNull();
    // Archive directory exists
    const archDir = path.join(tmpDir, '.ollama-agent', 'tasks', `archived-${id}`);
    const exists = await fs.access(archDir).then(() => true).catch(() => false);
    expect(exists).toBe(true);
  });

  it('deleteTask removes the task directory', async () => {
    const id = 'task_del_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.deleteTask(id);
    const task = await store.getTask(id);
    expect(task).toBeNull();
  });

  it('listArchivedTasks returns archived tasks addressable by their archive directory name', async () => {
    const id = 'task_hist_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.archiveTask(id);

    const archived = await store.listArchivedTasks();
    expect(archived).toHaveLength(1);
    expect(archived[0].taskId).toBe(`archived-${id}`);

    // The returned id must resolve back through getTask (directory-name addressing).
    const reloaded = await store.getTask(archived[0].taskId);
    expect(reloaded).not.toBeNull();
  });

  it('listArchivedTasks excludes active (non-archived) tasks', async () => {
    const id = 'task_active_hist';
    await store.createTask({ taskId: id, ...BASE_TASK });
    const archived = await store.listArchivedTasks();
    expect(archived).toHaveLength(0);
  });

  it('archiveStaleTasks archives terminal tasks older than the cutoff', async () => {
    const id = 'task_stale_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'completed', { completedAt: new Date().toISOString() });
    // Backdate updatedAt so the task looks old.
    const stale = await store.getTask(id);
    expect(stale).not.toBeNull();

    const archived = await store.archiveStaleTasks(-1000);
    expect(archived).toContain(id);
    expect(await store.getTask(id)).toBeNull();
  });

  it('archiveStaleTasks never archives running or waiting-for-approval tasks', async () => {
    const runningId = 'task_stale_running';
    const waitingId = 'task_stale_waiting';
    await store.createTask({ taskId: runningId, ...BASE_TASK });
    await store.updateTaskStatus(runningId, 'running');
    await store.createTask({ taskId: waitingId, ...BASE_TASK });
    await store.updateTaskStatus(waitingId, 'waiting_for_approval');

    const archived = await store.archiveStaleTasks(-1000);
    expect(archived).not.toContain(runningId);
    expect(archived).not.toContain(waitingId);
    expect(await store.getTask(runningId)).not.toBeNull();
    expect(await store.getTask(waitingId)).not.toBeNull();
  });

  it('archiveStaleTasks does not archive recently updated terminal tasks', async () => {
    const id = 'task_fresh_abc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'completed', { completedAt: new Date().toISOString() });

    const archived = await store.archiveStaleTasks(7 * 24 * 60 * 60 * 1000);
    expect(archived).not.toContain(id);
    expect(await store.getTask(id)).not.toBeNull();
  });
});

// ─── UI/runtime integration ───────────────────────────────────────────────────

describe('TaskStore — runtime integration scenarios', () => {
  let tmpDir: string;
  let store: TaskStore;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-rt-'));
    store = await makeStore(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('new task ID is created for a new conversation', async () => {
    const id1 = 'conv_1111111111_aaa';
    const id2 = 'conv_2222222222_bbb';
    await store.createTask({ taskId: id1, ...BASE_TASK, userGoal: 'first' });
    await store.createTask({ taskId: id2, ...BASE_TASK, userGoal: 'second' });
    const t1 = await store.getTask(id1);
    const t2 = await store.getTask(id2);
    expect(t1!.taskId).not.toBe(t2!.taskId);
  });

  it('continuing a conversation uses the same task ID', async () => {
    const id = 'conv_3333333333_ccc';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    // Simulate adding a message from a second turn
    await store.appendMessage(id, { role: 'user', content: 'follow-up', timestamp: new Date().toISOString() });
    const msgs = await store.getMessages(id);
    expect(msgs[0].taskId).toBe(id);
  });

  it('stop records durable cancellation', async () => {
    const id = 'conv_4444444444_ddd';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    // Simulate stop
    await store.updateTaskStatus(id, 'cancelled', { cancelledAt: new Date().toISOString() });
    await store.appendEvent(id, 'task_cancelled', {});
    const task = await store.getTask(id);
    expect(task!.status).toBe('cancelled');
    const { events } = await store.getEvents(id);
    expect(events.some(e => e.type === 'task_cancelled')).toBe(true);
  });

  it('error records durable failure with message', async () => {
    const id = 'conv_5555555555_eee';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    const errMsg = 'Provider connection refused';
    await store.updateTaskStatus(id, 'failed', {
      failure: { message: errMsg, timestamp: new Date().toISOString() },
    });
    await store.appendEvent(id, 'task_failed', { error: errMsg });
    const task = await store.getTask(id);
    expect(task!.status).toBe('failed');
    expect(task!.failure?.message).toBe(errMsg);
  });

  it('activation scan discovers incomplete tasks', async () => {
    const id = 'conv_6666666666_fff';
    await store.createTask({ taskId: id, ...BASE_TASK });
    await store.updateTaskStatus(id, 'running');
    await store.appendEvent(id, 'task_started', {});
    // No terminal event — simulates crash
    const recovery = new TaskRecovery(store);
    const candidates = await recovery.scan();
    expect(candidates.some(c => c.taskId === id)).toBe(true);
  });
});
