import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { TASK_GRAPH_SCHEMA_VERSION, TaskGraph } from '../../orchestration/TaskGraph';

const execFileAsync = promisify(execFile);

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('AgentRuntime orchestration APIs', () => {
  let root: string;
  let runtime: AgentRuntime;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-runtime-orchestration-'));
    await git(root, ['init']);
    await git(root, ['config', 'user.email', 'tests@example.com']);
    await git(root, ['config', 'user.name', 'Ollama Agent Tests']);
    await fs.mkdir(path.join(root, 'src', 'a'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a', 'value.txt'), 'A0\n', 'utf8');
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n', 'utf8');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'initial']);
    runtime = new AgentRuntime(root, secretStorage());
  });

  afterEach(async () => {
    for (const lease of await runtime.listWorktreeLeases().catch(() => [])) {
      await runtime.discardWorktreeTask(lease.taskId).catch(() => undefined);
    }
    runtime.stop();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('wires task graphs, read-only agents, and isolated write agents into the main runtime', async () => {
    const graph = makeGraph();
    await runtime.proposeTaskGraph(graph);
    await runtime.approveTaskGraph(graph.taskId);
    const completed = await runtime.runTaskGraph(graph.taskId, {
      execute: async node => ({ summary: `${node.id} complete` }),
    });
    expect(completed.status).toBe('completed');

    const readOnly = await runtime.runReadOnlySubAgents([{
      id: 'inspect',
      role: 'reviewer',
      objective: 'Inspect the source tree',
      context: ['src/a/value.txt'],
      maxModelCalls: 1,
      maxOutputBytes: 1000,
    }], {
      execute: async (_task, context) => {
        context.assertToolAllowed('read_file', { path: 'src/a/value.txt' });
        return { summary: 'inspected', findings: [], modelCalls: 0, outputBytes: 20 };
      },
    });
    expect(readOnly.results[0].summary).toBe('inspected');

    const writes = await runtime.runParallelWriteAgents([{
      id: 'write_a',
      role: 'implementer',
      objective: 'Change A in an isolated worktree',
      allowedPaths: ['src/a'],
      validationCommands: ['verify-a'],
    }], {
      execute: async (_task, context) => {
        await fs.writeFile(
          path.join(context.lease.worktreePath, 'src', 'a', 'value.txt'),
          'A1\n',
          'utf8',
        );
        return { summary: 'changed A' };
      },
    }, {
      validate: async task => ({ passed: true, commandsRun: task.validationCommands }),
    });

    expect(writes.results[0].status).toBe('completed');
    expect(writes.results[0].changedFiles).toEqual(['src/a/value.txt']);
    expect(await fs.readFile(path.join(root, 'src', 'a', 'value.txt'), 'utf8')).toBe('A0\n');
    expect(await runtime.listWorktreeLeases()).toHaveLength(1);
    await runtime.discardWorktreeTask('write_a');
    expect(await runtime.listWorktreeLeases()).toEqual([]);
  });
});

function makeGraph(): TaskGraph {
  const timestamp = new Date().toISOString();
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    taskId: 'runtime_graph',
    status: 'proposed',
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [
      {
        id: 'inspect',
        role: 'researcher',
        objective: 'Inspect',
        dependencies: [],
        allowedPaths: ['src/a'],
        capabilities: ['search'],
        executionMode: 'sequential',
        mutationPolicy: 'none',
        validation: [],
        status: 'proposed',
      },
      {
        id: 'implement',
        role: 'implementer',
        objective: 'Implement',
        dependencies: ['inspect'],
        allowedPaths: ['src/a'],
        capabilities: ['edit'],
        executionMode: 'sequential',
        mutationPolicy: 'worktree',
        validation: ['verify-a'],
        status: 'proposed',
      },
    ],
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd, maxBuffer: 10 * 1024 * 1024 });
  return result.stdout.trim();
}
