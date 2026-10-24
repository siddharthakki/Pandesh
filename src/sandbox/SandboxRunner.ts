import * as fs from 'fs/promises';
import * as path from 'path';

export type SandboxMode = 'restricted-host' | 'docker';
export type SandboxFilesystem = 'read-only' | 'workspace-write';

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  memoryMb?: number;
  cpuCount?: number;
  processLimit?: number;
}

export interface SandboxRequest {
  executionId: string;
  mode: SandboxMode;
  executable: string;
  args: string[];
  cwd?: string;
  environment?: Record<string, string>;
  filesystem: SandboxFilesystem;
  network: boolean;
  approved: boolean;
  dockerImage?: string;
  limits: SandboxLimits;
}

export interface SandboxPlan {
  schemaVersion: 1;
  executionId: string;
  mode: SandboxMode;
  executable: string;
  args: string[];
  cwd: string;
  environment: Record<string, string>;
  limits: SandboxLimits;
  network: boolean;
  filesystem: SandboxFilesystem;
}

export interface SandboxExecutionResult {
  schemaVersion: 1;
  executionId: string;
  status: 'completed' | 'failed' | 'cancelled' | 'denied';
  exitCode?: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  completedAt: string;
  plan: SandboxPlan;
  error?: string;
}

export interface SandboxBackend {
  execute(plan: Readonly<SandboxPlan>, signal: AbortSignal): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>;
}

export interface SandboxResultStorage {
  save(result: SandboxExecutionResult): Promise<void>;
}

export interface SandboxRunnerOptions {
  allowedExecutables?: string[];
  allowedEnvironmentKeys?: string[];
  storage?: SandboxResultStorage;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validateId(value: string): void {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(value)) {
    throw new Error(`Invalid sandbox execution id: ${value}`);
  }
}

function validateExecutable(executable: string): void {
  const trimmed = executable.trim();
  if (!trimmed || /[\r\n;&|><`]/.test(trimmed) || trimmed.includes('$(')) {
    throw new Error('Sandbox executable must be a direct program name without shell operators.');
  }
}

function validateArgument(argument: string): void {
  if (argument.includes('\0') || /[\r\n]/.test(argument)) {
    throw new Error('Sandbox arguments may not contain null bytes or newlines.');
  }
}

function resolveInside(root: string, requested: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, requested);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Sandbox path escapes the workspace: ${requested}`);
  }
  return resolved;
}

function validateLimits(limits: SandboxLimits): void {
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1000) {
    throw new Error('Sandbox timeout must be at least one second.');
  }
  if (!Number.isInteger(limits.maxOutputBytes) || limits.maxOutputBytes < 1024) {
    throw new Error('Sandbox output limit must be at least 1024 bytes.');
  }
  if (limits.memoryMb !== undefined && (!Number.isInteger(limits.memoryMb) || limits.memoryMb < 32)) {
    throw new Error('Sandbox memory limit is invalid.');
  }
  if (limits.cpuCount !== undefined && (!Number.isFinite(limits.cpuCount) || limits.cpuCount <= 0)) {
    throw new Error('Sandbox CPU limit is invalid.');
  }
  if (limits.processLimit !== undefined && (!Number.isInteger(limits.processLimit) || limits.processLimit < 1)) {
    throw new Error('Sandbox process limit is invalid.');
  }
}

function boundedText(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.length <= maxBytes) {
    return value;
  }
  return `${buffer.subarray(0, maxBytes).toString('utf8')}\n[output truncated]`;
}

export class FileSandboxResultStorage implements SandboxResultStorage {
  constructor(private readonly directory: string) {}

  async save(result: SandboxExecutionResult): Promise<void> {
    validateId(result.executionId);
    await fs.mkdir(this.directory, { recursive: true });
    const filename = path.join(this.directory, `${result.executionId}.json`);
    const temporary = `${filename}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, filename);
  }
}

export class SandboxRunner {
  private readonly allowedExecutables: Set<string>;
  private readonly allowedEnvironmentKeys: Set<string>;
  private readonly storage?: SandboxResultStorage;
  private controller: AbortController | null = null;

  constructor(
    private readonly workspaceRoot: string,
    private readonly backend: SandboxBackend,
    options: SandboxRunnerOptions = {},
  ) {
    this.allowedExecutables = new Set(options.allowedExecutables ?? [
      'node', 'npm', 'npx', 'git', 'tsc', 'python', 'python3', 'pytest', 'dotnet', 'java', 'mvn', 'gradle',
    ]);
    this.allowedEnvironmentKeys = new Set(options.allowedEnvironmentKeys ?? [
      'CI', 'NODE_ENV', 'NO_COLOR', 'TERM', 'PATH', 'Path', 'HOME', 'USERPROFILE', 'TEMP', 'TMP',
    ]);
    this.storage = options.storage;
  }

  createPlan(request: SandboxRequest): SandboxPlan {
    validateId(request.executionId);
    validateExecutable(request.executable);
    request.args.forEach(validateArgument);
    validateLimits(request.limits);
    if (!this.allowedExecutables.has(request.executable)) {
      throw new Error(`Sandbox executable is not allowlisted: ${request.executable}`);
    }
    const requiresApproval = request.mode === 'restricted-host'
      || request.filesystem === 'workspace-write'
      || request.network;
    if (requiresApproval && !request.approved) {
      throw new Error('Restricted-host, writable, or network-enabled execution requires explicit approval.');
    }
    if (request.mode === 'docker' && !request.dockerImage?.trim()) {
      throw new Error('Docker sandbox execution requires an image.');
    }

    const cwd = resolveInside(this.workspaceRoot, request.cwd ?? '.');
    const environment: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.environment ?? {})) {
      if (!this.allowedEnvironmentKeys.has(key)) {
        throw new Error(`Sandbox environment key is not allowlisted: ${key}`);
      }
      if (value.includes('\0')) {
        throw new Error(`Sandbox environment value contains a null byte: ${key}`);
      }
      environment[key] = value;
    }

    if (request.mode === 'restricted-host') {
      return {
        schemaVersion: 1,
        executionId: request.executionId,
        mode: request.mode,
        executable: request.executable,
        args: [...request.args],
        cwd,
        environment,
        limits: { ...request.limits },
        network: request.network,
        filesystem: request.filesystem,
      };
    }

    const workspaceSource = path.resolve(this.workspaceRoot);
    const dockerArgs = [
      'run', '--rm',
      '--workdir', '/workspace',
      '--mount', `type=bind,source=${workspaceSource},target=/workspace${request.filesystem === 'read-only' ? ',readonly' : ''}`,
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--network', request.network ? 'bridge' : 'none',
      '--pids-limit', String(request.limits.processLimit ?? 128),
    ];
    if (request.limits.memoryMb !== undefined) {
      dockerArgs.push('--memory', `${request.limits.memoryMb}m`);
    }
    if (request.limits.cpuCount !== undefined) {
      dockerArgs.push('--cpus', String(request.limits.cpuCount));
    }
    if (request.filesystem === 'read-only') {
      dockerArgs.push('--read-only');
    }
    for (const [key, value] of Object.entries(environment)) {
      dockerArgs.push('--env', `${key}=${value}`);
    }
    dockerArgs.push(request.dockerImage!, request.executable, ...request.args);

    return {
      schemaVersion: 1,
      executionId: request.executionId,
      mode: request.mode,
      executable: 'docker',
      args: dockerArgs,
      cwd: workspaceSource,
      environment: {},
      limits: { ...request.limits },
      network: request.network,
      filesystem: request.filesystem,
    };
  }

  async run(request: SandboxRequest): Promise<SandboxExecutionResult> {
    if (this.controller) {
      throw new Error('A sandbox execution is already active.');
    }
    const plan = this.createPlan(request);
    const startedAt = nowIso();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    try {
      const output = await this.backend.execute(plan, signal);
      const result: SandboxExecutionResult = {
        schemaVersion: 1,
        executionId: request.executionId,
        status: output.exitCode === 0 ? 'completed' : 'failed',
        exitCode: output.exitCode,
        stdout: boundedText(output.stdout, plan.limits.maxOutputBytes),
        stderr: boundedText(output.stderr, plan.limits.maxOutputBytes),
        startedAt,
        completedAt: nowIso(),
        plan,
        error: output.exitCode === 0 ? undefined : `Sandbox process exited with code ${output.exitCode}.`,
      };
      await this.storage?.save(result);
      return result;
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof Error && error.name === 'AbortError');
      const result: SandboxExecutionResult = {
        schemaVersion: 1,
        executionId: request.executionId,
        status: cancelled ? 'cancelled' : 'failed',
        stdout: '',
        stderr: '',
        startedAt,
        completedAt: nowIso(),
        plan,
        error: error instanceof Error ? error.message : String(error),
      };
      await this.storage?.save(result);
      return result;
    } finally {
      this.controller = null;
    }
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) {
      return false;
    }
    this.controller.abort();
    return true;
  }
}
