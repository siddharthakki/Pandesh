import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { DEFAULT_TASK_BUDGETS } from '../../agent/AgentEngineTypes';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { TaskStore } from '../../agent/TaskStore';
import { TaskContractStore } from '../../autonomy/TaskContractStore';
import { Config } from '../../config/Config';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { AuditService } from '../../services/AuditService';
import { ToolExecutor } from '../../tools/ToolExecutor';

const taskId = 'restart-contract-task';

describe('task contract restart enforcement', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-contract-restart-'));
    vi.spyOn(Config, 'getRequireApprovalForWrites').mockReturnValue(true);
    vi.spyOn(Config, 'getEnableCheckpoints').mockReturnValue(true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('uses the approved on-disk contract after all in-memory objects are recreated', async () => {
    const initialStore = new TaskStore(root);
    await initialStore.createTask({
      taskId,
      workspaceId: root,
      workspaceRoot: root,
      userGoal: 'Write only under src',
      mode: 'agent',
      model: 'qwen3-coder:30b',
      providerType: 'ollama',
    });
    await initialStore.updateTask(taskId, {
      phase: 'ready',
      status: 'running',
      engineBudgets: DEFAULT_TASK_BUDGETS,
      allowedPaths: ['src/**'],
    });
    const contracts = new TaskContractStore(initialStore);
    const proposed = await contracts.propose(taskId, {
      goal: 'Write only under src',
      allowedPaths: ['src/**'],
      allowedCommands: [],
      allowSafeCommands: true,
      budgets: DEFAULT_TASK_BUDGETS,
      approvalPolicy: 'in-contract-autonomous',
      checkpointPolicy: 'required',
    });
    await contracts.approve(taskId, proposed.contractId, 'user');

    const restartedStore = new TaskStore(root);
    const approval = new ApprovalFlow();
    approval.setOnRequest(() => {
      throw new Error('Restarted executor ignored the approved task contract.');
    });
    const executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: approval,
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      taskStore: restartedStore,
      taskId,
    });

    const result = await executor.execute({
      id: 'restart-write',
      function: {
        name: 'write_file',
        arguments: {
          path: 'src/restarted.ts',
          content: 'export const restarted = true;\n',
        },
      },
    }, {
      workspaceRoot: root,
      sessionId: taskId,
      taskId,
      turnId: 'restart-turn',
      iterationId: 'restart-iteration',
      model: 'qwen3-coder:30b',
      mode: 'agent',
    });

    expect(result.ok).toBe(true);
    expect(await fs.readFile(path.join(root, 'src/restarted.ts'), 'utf8'))
      .toBe('export const restarted = true;\n');
    expect((await restartedStore.getCheckpointRefs(taskId))).toHaveLength(1);
  });
});
