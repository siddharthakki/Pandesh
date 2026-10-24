import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TASK_BUDGETS } from '../../agent/AgentEngineTypes';
import { TaskStore } from '../../agent/TaskStore';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { TaskContractStore } from '../../autonomy/TaskContractStore';
import { ContractEnforcer } from '../../autonomy/TaskContract';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { AuditService } from '../../services/AuditService';
import { Config } from '../../config/Config';
import { ToolExecutor } from '../../tools/ToolExecutor';

const toolContext = (root: string, taskId: string) => ({
  workspaceRoot: root,
  sessionId: taskId,
  taskId,
  turnId: 'turn-1',
  iterationId: 'iteration-1',
  model: 'qwen3-coder:30b',
  mode: 'agent' as const,
});

describe('trusted autonomous task contracts', () => {
  let root: string;
  let taskStore: TaskStore;
  let contractStore: TaskContractStore;
  const taskId = 'trusted-contract-task';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-contract-'));
    taskStore = new TaskStore(root);
    contractStore = new TaskContractStore(taskStore);
    await taskStore.createTask({
      taskId,
      workspaceId: root,
      workspaceRoot: root,
      userGoal: 'Update files under src only',
      mode: 'agent',
      model: 'qwen3-coder:30b',
      providerType: 'ollama',
    });
    await taskStore.updateTask(taskId, {
      phase: 'ready',
      status: 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      allowedPaths: ['src/**'],
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function approvedContract() {
    const proposed = await contractStore.propose(taskId, {
      goal: 'Update files under src only',
      acceptanceCriteria: ['Tests pass'],
      allowedPaths: ['src/**'],
      allowedCommands: ['npm test'],
      allowSafeCommands: true,
      budgets: DEFAULT_TASK_BUDGETS,
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    });
    return contractStore.approve(taskId, proposed.contractId, 'user');
  }

  it('persists one approved contract and reloads it after a store restart', async () => {
    const approved = await approvedContract();
    const reloaded = await new TaskContractStore(new TaskStore(root)).get(taskId);

    expect(reloaded?.contractId).toBe(approved.contractId);
    expect(reloaded?.status).toBe('approved');
    expect(reloaded?.approvedBy).toBe('user');
    expect(reloaded?.allowedPaths).toEqual(['src/**']);
    expect(reloaded?.checkpointPolicy).toBe('required');
  });

  it('allows only approved paths and approved or safe validation commands', async () => {
    const contract = await approvedContract();
    const enforcer = new ContractEnforcer();

    expect(enforcer.evaluate(contract, {
      toolName: 'write_file',
      paths: ['src/index.ts'],
      mutatesWorkspace: true,
    }).inContract).toBe(true);

    expect(enforcer.evaluate(contract, {
      toolName: 'write_file',
      paths: ['package.json'],
      mutatesWorkspace: true,
    }).inContract).toBe(false);

    expect(enforcer.evaluate(contract, {
      toolName: 'run_command',
      paths: [],
      command: 'npm test',
      mutatesWorkspace: true,
    }).inContract).toBe(true);

    expect(enforcer.evaluate(contract, {
      toolName: 'run_command',
      paths: [],
      command: 'npm install unknown-package',
      mutatesWorkspace: true,
    }).inContract).toBe(false);
  });

  it('executes an in-contract write without repetitive approval and creates a checkpoint', async () => {
    await approvedContract();
    vi.spyOn(Config, 'getRequireApprovalForWrites').mockReturnValue(true);
    vi.spyOn(Config, 'getEnableCheckpoints').mockReturnValue(true);
    const approval = new ApprovalFlow();
    approval.setOnRequest(() => {
      throw new Error('In-contract write unexpectedly requested approval.');
    });
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: approval,
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      taskStore,
      taskId,
    });

    const result = await executor.execute({
      id: 'call-write',
      function: {
        name: 'write_file',
        arguments: { path: 'src/generated.ts', content: 'export const generated = true;\n' },
      },
    }, toolContext(root, taskId));

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(root, 'src/generated.ts'), 'utf8'))
      .toBe('export const generated = true;\n');
    expect((await taskStore.getCheckpointRefs(taskId)).length).toBe(1);
  });

  it('requests approval and does not mutate for an out-of-contract write that is rejected', async () => {
    await approvedContract();
    const approval = new ApprovalFlow();
    approval.setOnRequest(request => {
      approval.respond(request.id, 'rejected');
    });
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: approval,
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      taskStore,
      taskId,
    });

    const result = await executor.execute({
      id: 'call-outside',
      function: {
        name: 'write_file',
        arguments: { path: 'outside.ts', content: 'unsafe\n' },
      },
    }, toolContext(root, taskId));

    expect(result.ok).toBe(false);
    if (!result.ok) { expect(result.requiresApproval).toBe(true); }
    await expect(fs.stat(path.join(root, 'outside.ts'))).rejects.toThrow();
  });

  it('fails closed when a required checkpoint policy is disabled', async () => {
    await approvedContract();
    vi.spyOn(Config, 'getEnableCheckpoints').mockReturnValue(false);
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: new ApprovalFlow(),
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      taskStore,
      taskId,
    });

    const result = await executor.execute({
      id: 'call-no-checkpoint',
      function: {
        name: 'write_file',
        arguments: { path: 'src/no-checkpoint.ts', content: 'blocked\n' },
      },
    }, toolContext(root, taskId));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.policyViolation).toBe(true);
      expect(result.error).toMatch(/requires checkpoints/i);
    }
  });
});
