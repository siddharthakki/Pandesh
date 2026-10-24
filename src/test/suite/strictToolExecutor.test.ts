import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ToolExecutor } from '../../tools/ToolExecutor';
import { ApprovalFlow } from '../../policy/ApprovalFlow';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { AuditService } from '../../services/AuditService';
import { TaskStore } from '../../agent/TaskStore';
import { _resetConfig, _setConfig } from '../mocks/vscode';

const goal = `Create exactly one new file:

docs/agent-smoke-test.md

Use exactly this content:

# Ollama Agent Smoke Test

* Workspace grounding: passed
* Model routing: passed
* Tool execution: passed
* Controlled write: passed

Requirements:
1. Do not modify any other file.
2. After creating it, run \`npm run compile\`.
3. Do not run any other command.`;

const expectedContent = `# Ollama Agent Smoke Test

* Workspace grounding: passed
* Model routing: passed
* Tool execution: passed
* Controlled write: passed`;

class CountingApprovalFlow extends ApprovalFlow {
  requests = 0;
  lastArgs?: Record<string, unknown>;

  override async requestApproval(
    _toolName: string,
    args: Record<string, unknown>,
  ): Promise<'approved'> {
    this.requests += 1;
    this.lastArgs = args;
    return 'approved';
  }
}

describe('ToolExecutor strict task scope', () => {
  let root: string;
  let taskStore: TaskStore;
  let approval: CountingApprovalFlow;
  let executor: ToolExecutor;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-strict-executor-'));
    taskStore = new TaskStore(root);
    approval = new CountingApprovalFlow();
    _setConfig('ollama-agent.requireApprovalForWrites', true);
    _setConfig('ollama-agent.requireApprovalForCommands', true);
    _setConfig('ollama-agent.enableCheckpoints', false);

    await taskStore.createTask({
      taskId: 'strict_task',
      workspaceId: root,
      workspaceRoot: root,
      userGoal: goal,
      mode: 'agent',
      model: 'qwen3-coder:30b',
      providerType: 'ollama',
    });

    executor = new ToolExecutor({
      workspaceRoot: root,
      approvalFlow: approval,
      checkpointManager: new CheckpointManager(root),
      auditService: new AuditService(root),
      taskStore,
      taskId: 'strict_task',
    });
  });

  afterEach(async () => {
    _resetConfig();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('rejects an unauthorized command without requesting approval', async () => {
    const result = await executor.execute(
      { function: { name: 'run_command', arguments: { command: 'dir' } } },
      {
        workspaceRoot: root,
        sessionId: 'strict_task',
        taskId: 'strict_task',
        turnId: 'turn_1',
        model: 'qwen3-coder:30b',
        mode: 'agent',
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.policyViolation).toBe(true);
      expect(result.error).toMatch(/outside the exact command scope/i);
    }
    expect(approval.requests).toBe(0);
  });

  it('replaces reconstructed content before approval and writes the literal payload', async () => {
    const result = await executor.execute(
      {
        function: {
          name: 'write_file',
          arguments: {
            path: 'docs/agent-smoke-test.md',
            content: '# Invented content',
          },
        },
      },
      {
        workspaceRoot: root,
        sessionId: 'strict_task',
        taskId: 'strict_task',
        turnId: 'turn_2',
        model: 'qwen3-coder:30b',
        mode: 'agent',
      },
    );

    expect(result.ok).toBe(true);
    expect(approval.requests).toBe(1);
    expect(approval.lastArgs).toEqual({
      path: 'docs/agent-smoke-test.md',
      content: expectedContent,
    });
    expect(await fs.readFile(path.join(root, 'docs', 'agent-smoke-test.md'), 'utf8'))
      .toBe(expectedContent);
  });

  it('still rejects a different file before approval', async () => {
    const result = await executor.execute(
      {
        function: {
          name: 'write_file',
          arguments: {
            path: 'agent-smoke-test.js',
            content: 'console.log("test")',
          },
        },
      },
      {
        workspaceRoot: root,
        sessionId: 'strict_task',
        taskId: 'strict_task',
        turnId: 'turn_3',
        model: 'qwen3-coder:30b',
        mode: 'agent',
      },
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.policyViolation).toBe(true);
      expect(result.error).toMatch(/outside the exact file scope/i);
    }
    expect(approval.requests).toBe(0);
  });
});
