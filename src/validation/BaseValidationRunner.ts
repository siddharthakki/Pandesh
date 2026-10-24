import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { createSanitizedChildEnvironment } from '../../core/security/childEnvironment';
import { TaskStore } from '../agent/TaskStore';
import {
  CommandExecutionResult,
  ValidationCommandExecutor,
  ValidationGate,
  ValidationGateResult,
  ValidationRunOptions,
  ValidationSummary,
} from './ValidationTypes';

const DEFAULT_OUTPUT_LIMIT = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const RECOGNIZED_VALIDATION_SCRIPT = /^(compile|build|typecheck|test|test:unit|test:integration|lint|format:check|security)$/;

function truncate(value: string, max: number): string {
  if (value.length <= max) { return value; }
  return `${value.slice(0, max)}\n…[truncated ${value.length - max} chars]`;
}

function hash(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function categoryForCommand(command: string): ValidationGate['category'] | undefined {
  const normalized = command.toLowerCase();
  if (/\b(compile|build|tsc)\b/.test(normalized)) { return 'compile'; }
  if (/\b(typecheck|type-check)\b/.test(normalized)) { return 'typecheck'; }
  if (/\b(test:integration|integration test|integration-test)\b/.test(normalized)) { return 'integration_test'; }
  if (/\b(test|vitest|jest|pytest|cargo test|go test)\b/.test(normalized)) { return 'unit_test'; }
  if (/\b(lint|eslint|ruff|clippy)\b/.test(normalized)) { return 'lint'; }
  if (/\b(format:check|prettier --check|fmt --check)\b/.test(normalized)) { return 'format'; }
  if (/\b(security|audit|snyk)\b/.test(normalized)) { return 'security'; }
  return undefined;
}

function isRequiredCategory(category: ValidationGate['category']): boolean {
  return category === 'compile' || category === 'typecheck' || category === 'unit_test';
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

export class ShellValidationExecutor implements ValidationCommandExecutor {
  constructor(private readonly workspaceRoot: string) {}

  execute(command: string, timeoutMs: number, signal?: AbortSignal): Promise<CommandExecutionResult> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const child = spawn(command, {
        cwd: this.workspaceRoot,
        shell: true,
        windowsHide: true,
        env: createSanitizedChildEnvironment(),
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      let timedOut = false;

      const finish = (exitCode: number) => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve({
          exitCode,
          stdout,
          stderr,
          durationMs: Math.max(0, Date.now() - started),
          timedOut,
        });
      };

      const stopChild = () => {
        try { child.kill('SIGTERM'); } catch { /* best effort */ }
      };
      const onAbort = () => {
        stopChild();
        finish(130);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stopChild();
        finish(124);
      }, Math.max(1, timeoutMs));

      child.stdout?.on('data', chunk => { stdout += String(chunk); });
      child.stderr?.on('data', chunk => { stderr += String(chunk); });
      child.on('error', error => {
        if (settled) { return; }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });
      child.on('close', code => finish(code ?? 1));

      if (signal?.aborted) {
        onAbort();
      } else {
        signal?.addEventListener('abort', onAbort, { once: true });
      }
    });
  }
}

export class ValidationRunner {
  private readonly executor: ValidationCommandExecutor;

  constructor(
    private readonly workspaceRoot: string,
    private readonly taskStore?: TaskStore,
    executor?: ValidationCommandExecutor,
  ) {
    this.executor = executor ?? new ShellValidationExecutor(workspaceRoot);
  }

  async discoverGates(options?: {
    explicitGates?: ValidationRunOptions['explicitGates'];
    defaultTimeoutMs?: number;
  }): Promise<ValidationGate[]> {
    const timeoutMs = options?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    const gates: ValidationGate[] = [];
    const seen = new Set<string>();

    const add = (gate: ValidationGate) => {
      const key = `${gate.category}:${gate.command}`;
      if (seen.has(key)) { return; }
      seen.add(key);
      gates.push(gate);
    };

    for (const explicit of options?.explicitGates ?? []) {
      add({
        id: explicit.id ?? `explicit-${gates.length + 1}`,
        category: explicit.category,
        command: explicit.command,
        required: explicit.required,
        source: 'explicit',
        timeoutMs: explicit.timeoutMs ?? timeoutMs,
      });
    }

    const packageJson = await this.readJson(path.join(this.workspaceRoot, 'package.json'));
    const scripts = packageJson && typeof packageJson === 'object'
      ? (packageJson as { scripts?: Record<string, string> }).scripts ?? {}
      : {};

    const scriptGate = (
      script: string,
      category: ValidationGate['category'],
      required: boolean,
    ) => {
      if (!scripts[script]) { return; }
      add({
        id: `package-${script.replace(/[^a-z0-9]+/gi, '-')}`,
        category,
        command: `npm run ${script}`,
        required,
        source: 'package_json',
        timeoutMs,
      });
    };

    scriptGate('compile', 'compile', true);
    scriptGate('build', 'compile', !scripts.compile);
    scriptGate('typecheck', 'typecheck', false);
    scriptGate('test', 'unit_test', true);
    scriptGate('test:unit', 'unit_test', !scripts.test);
    scriptGate('test:integration', 'integration_test', false);
    scriptGate('lint', 'lint', false);
    scriptGate('format:check', 'format', false);
    scriptGate('security', 'security', false);

    await this.discoverWorkspaceTasks(add, timeoutMs);
    await this.discoverCiCommands(add, timeoutMs);

    if (!scripts.compile && !scripts.build && await this.exists('tsconfig.json')) {
      add({
        id: 'convention-typescript',
        category: 'typecheck',
        command: 'npx tsc --noEmit',
        required: true,
        source: 'convention',
        timeoutMs,
      });
    }
    if (Object.keys(scripts).length === 0 && await this.exists('Cargo.toml')) {
      add({
        id: 'convention-cargo-test',
        category: 'unit_test',
        command: 'cargo test',
        required: true,
        source: 'convention',
        timeoutMs,
      });
    }
    if (Object.keys(scripts).length === 0 && await this.exists('go.mod')) {
      add({
        id: 'convention-go-test',
        category: 'unit_test',
        command: 'go test ./...',
        required: true,
        source: 'convention',
        timeoutMs,
      });
    }
    if (
      Object.keys(scripts).length === 0 &&
      (await this.exists('pytest.ini') || await this.exists('pyproject.toml'))
    ) {
      add({
        id: 'convention-pytest',
        category: 'unit_test',
        command: 'python -m pytest',
        required: true,
        source: 'convention',
        timeoutMs,
      });
    }

    return gates;
  }

  async run(options: ValidationRunOptions): Promise<ValidationSummary> {
    const startedAt = new Date().toISOString();
    const outputLimit = options.maxOutputChars ?? DEFAULT_OUTPUT_LIMIT;
    const gates = await this.discoverGates({
      explicitGates: options.explicitGates,
      defaultTimeoutMs: options.defaultTimeoutMs,
    });

    await this.taskStore?.appendEvent(options.taskId, 'validation_started', {
      attempt: options.attempt,
      gates: gates.map(gate => ({
        id: gate.id,
        category: gate.category,
        command: gate.command,
        required: gate.required,
        source: gate.source,
      })),
    });

    const results: ValidationGateResult[] = [];
    for (const gate of gates) {
      if (options.signal?.aborted) { break; }
      const gateStartedAt = new Date().toISOString();
      try {
        const execution = await this.executor.execute(gate.command, gate.timeoutMs, options.signal);
        const completedAt = new Date().toISOString();
        const stdout = truncate(execution.stdout, outputLimit);
        const stderr = truncate(execution.stderr, outputLimit);
        const status = execution.timedOut
          ? 'timed_out' as const
          : execution.exitCode === 0
            ? 'passed' as const
            : 'failed' as const;
        results.push({
          gate,
          status,
          exitCode: execution.exitCode,
          durationMs: execution.durationMs,
          stdout,
          stderr,
          startedAt: gateStartedAt,
          completedAt,
          fingerprint: hash(`${gate.category}\n${gate.command}\n${execution.exitCode}\n${stderr}\n${stdout}`),
        });
      } catch (error) {
        const completedAt = new Date().toISOString();
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          gate,
          status: 'failed',
          exitCode: 1,
          durationMs: Math.max(0, new Date(completedAt).getTime() - new Date(gateStartedAt).getTime()),
          stdout: '',
          stderr: truncate(message, outputLimit),
          startedAt: gateStartedAt,
          completedAt,
          fingerprint: hash(`${gate.category}\n${gate.command}\n${message}`),
        });
      }
    }

    const filesChanged = await this.getChangedFiles();
    if (options.allowedPaths && options.allowedPaths.length > 0) {
      const outside = filesChanged.filter(file => !this.isAllowed(file, options.allowedPaths!));
      const gate: ValidationGate = {
        id: 'builtin-git-diff-scope',
        category: 'git_diff_scope',
        command: 'git status --porcelain=v1 --untracked-files=all',
        required: true,
        source: 'builtin',
        timeoutMs: options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      };
      const now = new Date().toISOString();
      results.push({
        gate,
        status: outside.length === 0 ? 'passed' : 'failed',
        exitCode: outside.length === 0 ? 0 : 1,
        durationMs: 0,
        stdout: filesChanged.join('\n'),
        stderr: outside.length === 0 ? '' : `Out-of-scope files: ${outside.join(', ')}`,
        startedAt: now,
        completedAt: now,
        fingerprint: hash(`scope\n${outside.sort().join('\n')}`),
      });
    }

    const requiredPassed = results
      .filter(result => result.gate.required)
      .every(result => result.status === 'passed');
    const passed = requiredPassed && !options.signal?.aborted;
    const failedFingerprints = results
      .filter(result => result.gate.required && result.status !== 'passed')
      .map(result => result.fingerprint)
      .sort();

    const summary: ValidationSummary = {
      schemaVersion: 1,
      taskId: options.taskId,
      attempt: options.attempt,
      startedAt,
      completedAt: new Date().toISOString(),
      passed,
      requiredPassed,
      results,
      failureFingerprint: failedFingerprints.length > 0
        ? hash(failedFingerprints.join(':'))
        : undefined,
      filesChanged,
      commandsRun: results.map(result => result.gate.command),
    };

    await this.persistSummary(summary);
    await this.taskStore?.appendEvent(options.taskId, 'validation_result', {
      attempt: summary.attempt,
      passed: summary.passed,
      requiredPassed: summary.requiredPassed,
      failureFingerprint: summary.failureFingerprint,
      filesChanged: summary.filesChanged,
      results: summary.results.map(result => ({
        id: result.gate.id,
        category: result.gate.category,
        required: result.gate.required,
        status: result.status,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        fingerprint: result.fingerprint,
      })),
    });

    return summary;
  }

  async readLatest(taskId: string): Promise<ValidationSummary | null> {
    try {
      const taskDir = this.taskStore?.getTaskDir(taskId)
        ?? path.join(this.workspaceRoot, '.ollama-agent', 'tasks', taskId);
      const raw = await fs.readFile(path.join(taskDir, 'validation.json'), 'utf8');
      return JSON.parse(raw) as ValidationSummary;
    } catch {
      return null;
    }
  }

  private async discoverWorkspaceTasks(
    add: (gate: ValidationGate) => void,
    timeoutMs: number,
  ): Promise<void> {
    const tasksPath = path.join(this.workspaceRoot, '.vscode', 'tasks.json');
    let raw: string;
    try {
      raw = await fs.readFile(tasksPath, 'utf8');
    } catch {
      return;
    }

    try {
      const parsed = JSON.parse(stripJsonComments(raw)) as {
        tasks?: Array<{
          label?: string;
          type?: string;
          command?: string;
          args?: string[];
          group?: string | { kind?: string; isDefault?: boolean };
        }>;
      };
      for (const task of parsed.tasks ?? []) {
        if ((task.type && task.type !== 'shell' && task.type !== 'process') || !task.command) { continue; }
        const command = [task.command, ...(task.args ?? [])].join(' ').trim();
        const category = categoryForCommand(`${task.label ?? ''} ${command}`);
        if (!category) { continue; }
        const group = typeof task.group === 'string' ? task.group : task.group?.kind;
        add({
          id: `vscode-${(task.label ?? command).replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
          category,
          command,
          required: Boolean(task.group && (group === 'build' || task.group && typeof task.group === 'object' && task.group.isDefault)) && isRequiredCategory(category),
          source: 'vscode_task',
          timeoutMs,
        });
      }
    } catch {
      // Invalid task JSON is not itself a validation failure. The explicit
      // configuration and other discovery sources remain available.
    }
  }

  private async discoverCiCommands(
    add: (gate: ValidationGate) => void,
    timeoutMs: number,
  ): Promise<void> {
    const workflowDir = path.join(this.workspaceRoot, '.github', 'workflows');
    let entries: string[];
    try {
      entries = await fs.readdir(workflowDir);
    } catch {
      return;
    }

    for (const entry of entries.filter(name => /\.ya?ml$/i.test(name))) {
      let raw: string;
      try {
        raw = await fs.readFile(path.join(workflowDir, entry), 'utf8');
      } catch {
        continue;
      }
      const matches = raw.matchAll(/\brun:\s*[|>-]?\s*(npm\s+run\s+([\w:-]+))/gi);
      for (const match of matches) {
        const script = match[2];
        if (!RECOGNIZED_VALIDATION_SCRIPT.test(script)) { continue; }
        const command = `npm run ${script}`;
        const category = categoryForCommand(command);
        if (!category) { continue; }
        add({
          id: `ci-${entry.replace(/[^a-z0-9]+/gi, '-')}-${script.replace(/[^a-z0-9]+/gi, '-')}`,
          category,
          command,
          required: isRequiredCategory(category),
          source: 'ci',
          timeoutMs,
        });
      }
    }
  }

  private async persistSummary(summary: ValidationSummary): Promise<void> {
    const taskDir = this.taskStore?.getTaskDir(summary.taskId)
      ?? path.join(this.workspaceRoot, '.ollama-agent', 'tasks', summary.taskId);
    await fs.mkdir(taskDir, { recursive: true });
    const destination = path.join(taskDir, 'validation.json');
    const temp = `${destination}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(summary, null, 2), 'utf8');
      await fs.rename(temp, destination);
    } catch (error) {
      try { await fs.unlink(temp); } catch { /* best effort */ }
      throw error;
    }
  }

  private async getChangedFiles(): Promise<string[]> {
    try {
      if (this.executor instanceof ShellValidationExecutor) {
        await fs.access(path.join(this.workspaceRoot, '.git'));
      }
      const status = await this.executor.execute(
        'git status --porcelain=v1 --untracked-files=all',
        DEFAULT_TIMEOUT_MS,
      );
      if (status.exitCode === 0 && status.stdout.trim()) {
        return [...new Set(status.stdout
          .split(/\r?\n/)
          .map(line => line.trimEnd())
          .filter(Boolean)
          .map(line => this.pathFromPorcelain(line))
          .filter((file): file is string => Boolean(file)))]
          .sort();
      }

      const diff = await this.executor.execute('git diff --name-only', DEFAULT_TIMEOUT_MS);
      if (diff.exitCode !== 0) { return []; }
      return [...new Set(diff.stdout
        .split(/\r?\n/)
        .map(file => file.trim().replace(/\\/g, '/'))
        .filter(Boolean))]
        .sort();
    } catch {
      return [];
    }
  }

  private pathFromPorcelain(line: string): string | undefined {
    if (line.length < 4) { return undefined; }
    let file = line.slice(3).trim();
    if (file.includes(' -> ')) {
      file = file.split(' -> ').pop() ?? file;
    }
    if (file.startsWith('"') && file.endsWith('"')) {
      try { file = JSON.parse(file) as string; } catch { file = file.slice(1, -1); }
    }
    return file.replace(/\\/g, '/');
  }

  private isAllowed(file: string, allowedPaths: string[]): boolean {
    const normalized = file.replace(/\\/g, '/');
    return allowedPaths.some(candidate => {
      const allowed = candidate.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
      return normalized === allowed || normalized.startsWith(`${allowed}/`);
    });
  }

  private async readJson(filePath: string): Promise<unknown | null> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  private async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.stat(path.join(this.workspaceRoot, relativePath));
      return true;
    } catch {
      return false;
    }
  }
}
