import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { TaskStore } from '../../agent/TaskStore';
import { ShellValidationExecutor, ValidationRunner } from '../../validation/ValidationRunner';
import {
  CommandExecutionResult,
  ValidationCommandExecutor,
} from '../../validation/ValidationTypes';

class FakeExecutor implements ValidationCommandExecutor {
  readonly calls: string[] = [];
  constructor(private readonly results: Record<string, Partial<CommandExecutionResult>>) {}

  async execute(command: string): Promise<CommandExecutionResult> {
    this.calls.push(command);
    const result = this.results[command] ?? {};
    return {
      exitCode: result.exitCode ?? 0,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
      durationMs: result.durationMs ?? 5,
      timedOut: result.timedOut ?? false,
    };
  }
}

const BASE_TASK = {
  workspaceId: '/workspace',
  workspaceRoot: '/workspace',
  userGoal: 'Validate the project',
  mode: 'agent',
  model: 'test-model',
  providerType: 'ollama',
};

describe('ValidationRunner', () => {
  let root: string;
  let store: TaskStore;
  const taskId = 'task_validation_runner';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-'));
    store = new TaskStore(root);
    await store.createTask({ taskId, ...BASE_TASK });
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers required compile and test scripts from package.json', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { compile: 'tsc -p ./', test: 'vitest run', lint: 'eslint .' } }),
      'utf8',
    );
    const runner = new ValidationRunner(root, store, new FakeExecutor({}));
    const gates = await runner.discoverGates();

    expect(gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'npm run compile', category: 'compile', required: true }),
      expect.objectContaining({ command: 'npm run test', category: 'unit_test', required: true }),
      expect.objectContaining({ command: 'npm run lint', category: 'lint', required: false }),
    ]));
  });

  it('executes node process.exit validation commands instead of synthesizing success', async () => {
    const executor = new ShellValidationExecutor(root);
    await expect(executor.execute('node -e "process.exit(0)"', 10_000)).resolves.toEqual(expect.objectContaining({
      exitCode: 0,
      timedOut: false,
    }));
    await expect(executor.execute('node -e "process.exit(7)"', 10_000)).resolves.toEqual(expect.objectContaining({
      exitCode: 7,
      timedOut: false,
    }));
  });

  it('discovers recognized VS Code validation tasks', async () => {
    await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.vscode', 'tasks.json'),
      `{
        // JSONC comments and trailing commas are supported
        "tasks": [
          { "label": "Build", "type": "shell", "command": "npm run compile", "group": { "kind": "build", "isDefault": true }, },
          { "label": "Deploy", "type": "shell", "command": "publish-production" }
        ],
      }`,
      'utf8',
    );

    const gates = await new ValidationRunner(root, store, new FakeExecutor({})).discoverGates();
    expect(gates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        command: 'npm run compile',
        category: 'compile',
        source: 'vscode_task',
        required: true,
      }),
    ]));
    expect(gates.some(gate => gate.command === 'publish-production')).toBe(false);
  });

  it('discovers only recognized validation commands from CI', async () => {
    await fs.mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
    await fs.writeFile(
      path.join(root, '.github', 'workflows', 'ci.yml'),
      `steps:
        - run: npm run compile
        - run: npm run test
        - run: npm run deploy
      `,
      'utf8',
    );

    const gates = await new ValidationRunner(root, store, new FakeExecutor({})).discoverGates();
    expect(gates).toEqual(expect.arrayContaining([
      expect.objectContaining({ command: 'npm run compile', source: 'ci' }),
      expect.objectContaining({ command: 'npm run test', source: 'ci' }),
    ]));
    expect(gates.some(gate => gate.command === 'npm run deploy')).toBe(false);
  });

  it('marks validation failed when a required gate fails', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { compile: 'tsc', test: 'vitest' } }),
      'utf8',
    );
    const executor = new FakeExecutor({
      'npm run compile': { exitCode: 0, stdout: 'compiled' },
      'npm run test': { exitCode: 1, stderr: '1 test failed' },
      'git diff --name-only': { exitCode: 0, stdout: 'src/a.ts\n' },
    });
    const runner = new ValidationRunner(root, store, executor);
    const summary = await runner.run({ taskId, attempt: 1 });

    expect(summary.passed).toBe(false);
    expect(summary.requiredPassed).toBe(false);
    expect(summary.failureFingerprint).toBeDefined();
    expect(summary.results.find(result => result.gate.command === 'npm run test')?.status).toBe('failed');

    const persisted = await runner.readLatest(taskId);
    expect(persisted?.failureFingerprint).toBe(summary.failureFingerprint);
    const events = await store.getEvents(taskId);
    expect(events.events.some(event => event.type === 'validation_started')).toBe(true);
    expect(events.events.some(event => event.type === 'validation_result')).toBe(true);
  });

  it('allows optional failures while required gates pass', async () => {
    await fs.writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { compile: 'tsc', test: 'vitest', lint: 'eslint .' } }),
      'utf8',
    );
    const runner = new ValidationRunner(root, store, new FakeExecutor({
      'npm run compile': { exitCode: 0 },
      'npm run test': { exitCode: 0 },
      'npm run lint': { exitCode: 1, stderr: 'lint warning' },
      'git diff --name-only': { exitCode: 0 },
    }));

    const summary = await runner.run({ taskId, attempt: 1 });
    expect(summary.requiredPassed).toBe(true);
    expect(summary.passed).toBe(true);
    expect(summary.results.find(result => result.gate.command === 'npm run lint')?.status).toBe('failed');
  });

  it('fails the built-in scope gate for tracked and untracked out-of-scope files', async () => {
    const runner = new ValidationRunner(root, store, new FakeExecutor({
      'scope-check': { exitCode: 0, stdout: 'mechanical gate passed' },
      'git status --porcelain=v1 --untracked-files=all': {
        exitCode: 0,
        stdout: ' M src/allowed.ts\n?? docs/new-untracked.md\n',
      },
    }));
    const summary = await runner.run({
      taskId,
      attempt: 1,
      explicitGates: [
        { category: 'acceptance', command: 'scope-check', required: true },
      ],
      allowedPaths: ['src'],
    });

    const scope = summary.results.find(result => result.gate.category === 'git_diff_scope');
    expect(scope?.status).toBe('failed');
    expect(scope?.stderr).toContain('docs/new-untracked.md');
    expect(summary.filesChanged).toEqual(['docs/new-untracked.md', 'src/allowed.ts']);
    expect(summary.passed).toBe(false);
  });

  it('uses explicit validation gates and preserves command evidence', async () => {
    const executor = new FakeExecutor({
      'node verify.js': { exitCode: 0, stdout: 'acceptance passed' },
      'git diff --name-only': { exitCode: 0, stdout: 'src/a.ts' },
    });
    const runner = new ValidationRunner(root, store, executor);
    const summary = await runner.run({
      taskId,
      attempt: 2,
      explicitGates: [
        { category: 'acceptance', command: 'node verify.js', required: true },
      ],
    });

    expect(summary.passed).toBe(true);
    expect(summary.attempt).toBe(2);
    expect(summary.commandsRun).toContain('node verify.js');
    expect(summary.filesChanged).toEqual(['src/a.ts']);
  });

  it('reports timeouts as failed required validation', async () => {
    const runner = new ValidationRunner(root, store, new FakeExecutor({
      'slow-check': { exitCode: 124, timedOut: true, stderr: 'timed out' },
      'git diff --name-only': { exitCode: 0 },
    }));
    const summary = await runner.run({
      taskId,
      attempt: 1,
      explicitGates: [
        { category: 'integration_test', command: 'slow-check', required: true },
      ],
    });

    expect(summary.passed).toBe(false);
    expect(summary.results[0].status).toBe('timed_out');
  });
});
