import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { ToolExecutor } from '../../tools/ToolExecutor';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { CheckpointManager, CheckpointCreateMeta } from '../../agent/CheckpointManager';
import { AuditService } from '../../services/AuditService';
import { _setConfig, _resetConfig } from '../mocks/vscode';

// Capture audit events without hitting the filesystem
class CapturingAuditService extends AuditService {
  readonly events: Array<Record<string, unknown>> = [];

  constructor() { super('/dev/null'); }

  override async log(event: Record<string, unknown>): Promise<void> {
    this.events.push(event);
  }
}

// CheckpointManager variant that throws on createCheckpoint
class FailingCheckpointManager extends CheckpointManager {
  constructor() { super('/nonexistent'); }

  override async createCheckpoint(_files: string[], _meta: CheckpointCreateMeta): Promise<string | null> {
    throw new Error('disk full — simulated checkpoint failure');
  }
}

// ApprovalFlow variant that auto-approves all requests
class AutoApproveFlow extends ApprovalFlow {
  override async requestApproval(): Promise<'approved'> {
    return 'approved';
  }
}

const BASE_CONTEXT = {
  workspaceRoot: '',
  sessionId: 'sess_executor_test',
  turnId: 'turn_1',
  model: 'test-model',
  mode: 'agent' as const,
};

describe('ToolExecutor — checkpoint failure gate', () => {
  let tmpDir: string;
  let executor: ToolExecutor;
  let audit: CapturingAuditService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'te-fail-'));
    audit = new CapturingAuditService();
    _setConfig('ollama-agent.requireApprovalForWrites', false);
    _setConfig('ollama-agent.enableCheckpoints', true);

    executor = new ToolExecutor({
      workspaceRoot: tmpDir,
      approvalFlow: new AutoApproveFlow(),
      checkpointManager: new FailingCheckpointManager() as unknown as CheckpointManager,
      auditService: audit as unknown as AuditService,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetConfig();
  });

  it('returns a typed failure without running the tool when checkpoint creation throws', async () => {
    const targetFile = path.join(tmpDir, 'should-not-exist.ts');

    const result = await executor.execute(
      { id: 'call_001', function: { name: 'write_file', arguments: { path: targetFile, content: 'forbidden' } } },
      { ...BASE_CONTEXT, workspaceRoot: tmpDir },
    );

    // Mutation must not have occurred
    expect(await fileExists(targetFile)).toBe(false);
    // Result is a typed failure
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.blocked).toBe(true);
      expect(result.error).toMatch(/checkpoint creation failed/i);
    }
  });

  it('records the checkpoint failure in the audit log', async () => {
    const targetFile = path.join(tmpDir, 'blocked.ts');

    await executor.execute(
      { id: 'call_002', function: { name: 'write_file', arguments: { path: targetFile, content: 'blocked' } } },
      { ...BASE_CONTEXT, workspaceRoot: tmpDir },
    );

    const errorEvent = audit.events.find((e) => e['type'] === 'error');
    expect(errorEvent).toBeDefined();
    expect(String(errorEvent!['error'])).toMatch(/checkpoint creation failed/i);
  });
});

describe('ToolExecutor — cancellation before execute', () => {
  let tmpDir: string;
  let executor: ToolExecutor;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'te-cancel-'));
    _setConfig('ollama-agent.requireApprovalForWrites', false);
    _setConfig('ollama-agent.enableCheckpoints', false);

    executor = new ToolExecutor({
      workspaceRoot: tmpDir,
      approvalFlow: new AutoApproveFlow(),
      checkpointManager: new CheckpointManager(tmpDir),
      auditService: new AuditService(tmpDir),
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetConfig();
  });

  it('returns ok:false without executing the tool when signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const targetFile = path.join(tmpDir, 'should-not-exist.ts');

    const result = await executor.execute(
      { function: { name: 'write_file', arguments: { path: targetFile, content: 'cancelled' } } },
      { ...BASE_CONTEXT, workspaceRoot: tmpDir },
      undefined,
      controller.signal,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Tool execution cancelled');
    }
    expect(await fileExists(targetFile)).toBe(false);
  });
});

describe('ToolExecutor — audit-to-checkpoint linkage', () => {
  let tmpDir: string;
  let executor: ToolExecutor;
  let audit: CapturingAuditService;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'te-audit-'));
    audit = new CapturingAuditService();
    _setConfig('ollama-agent.requireApprovalForWrites', false);
    _setConfig('ollama-agent.enableCheckpoints', true);

    executor = new ToolExecutor({
      workspaceRoot: tmpDir,
      approvalFlow: new AutoApproveFlow(),
      checkpointManager: new CheckpointManager(tmpDir),
      auditService: audit as unknown as AuditService,
    });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    _resetConfig();
  });

  it('audit event for a mutating tool includes a non-null checkpointId', async () => {
    const targetFile = path.join(tmpDir, 'audit-link.ts');

    const result = await executor.execute(
      { id: 'call_003', function: { name: 'write_file', arguments: { path: targetFile, content: 'hello' } } },
      { ...BASE_CONTEXT, workspaceRoot: tmpDir },
    );

    expect(result.ok).toBe(true);

    const toolResultEvent = audit.events.find((e) => e['type'] === 'tool_result');
    expect(toolResultEvent).toBeDefined();
    expect(toolResultEvent!['checkpointId']).toBeTruthy();
  });

  it('passes toolCallId and args into the checkpoint metadata', async () => {
    const targetFile = path.join(tmpDir, 'meta-check.ts');
    const writeArgs = { path: targetFile, content: 'meta test' };

    await executor.execute(
      { id: 'call_004', function: { name: 'write_file', arguments: writeArgs } },
      { ...BASE_CONTEXT, workspaceRoot: tmpDir },
    );

    const manager = new CheckpointManager(tmpDir);
    const checkpoints = await manager.listCheckpoints();
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].toolCallId).toBe('call_004');
    expect(checkpoints[0].args).toMatchObject(writeArgs);
  });
});

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}
