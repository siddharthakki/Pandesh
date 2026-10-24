import { execFileSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { approvedPackageJsonFingerprint, CodingValidationCommand } from './CodingProposal';
import { minimalValidationEnvironment } from './ExecutionIntegrity';

export interface ValidationRunResult {
  command: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  output: string;
}

export class CodingValidationRunner {
  constructor(
    private readonly workspaceRoot: string,
    private readonly timeoutMs: number,
    private readonly runtime: ValidationRuntimeOptions = {},
  ) {}

  async runAll(commands: readonly CodingValidationCommand[], signal?: AbortSignal): Promise<ValidationRunResult[]> {
    const releaseDependencies = await projectWorktreeDependencies(this.workspaceRoot);
    try {
      const results: ValidationRunResult[] = [];
      for (const [index, command] of commands.entries()) {
        if (signal?.aborted) {
          throw new Error('cancelled');
        }
        const display = commandSpec(command, this.workspaceRoot, this.runtime).display;
        this.runtime.onCommandStarted?.(display, index + 1, commands.length);
        results.push(await this.runOne(command, signal));
      }
      return results;
    } finally {
      await releaseDependencies();
    }
  }

  private runOne(command: CodingValidationCommand, signal?: AbortSignal): Promise<ValidationRunResult> {
    const spec = commandSpec(command, this.workspaceRoot, this.runtime);
    const started = Date.now();
    if (!spec.ok) {
      return Promise.resolve({
        command: spec.display,
        exitCode: null,
        durationMs: 0,
        timedOut: false,
        output: spec.reason,
      });
    }
    return new Promise((resolve) => {
      let output = '';
      let settled = false;
      let forcedResult: { exitCode: number | null; timedOut: boolean } | undefined;
      const child = spawn(spec.executable, spec.args, {
        cwd: this.workspaceRoot,
        shell: false,
        windowsHide: true,
        env: minimalValidationEnvironment(),
        detached: process.platform !== 'win32',
      });
      const finish = (exitCode: number | null, timedOut: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        resolve({
          command: spec.display,
          exitCode,
          durationMs: Date.now() - started,
          timedOut,
          output: sanitizeOutput(output),
        });
      };
      const timer = setTimeout(() => {
        forcedResult = { exitCode: null, timedOut: true };
        void terminateProcessTree(child.pid).then(() => finish(null, true));
      }, this.timeoutMs);
      const abort = () => {
        forcedResult = { exitCode: null, timedOut: false };
        void terminateProcessTree(child.pid).then(() => finish(null, false));
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', data => { output = appendBounded(output, String(data)); });
      child.stderr.on('data', data => { output = appendBounded(output, String(data)); });
      child.on('error', error => {
        // Name the exact blocker (e.g. python not on PATH) instead of reporting an empty failure.
        output = appendBounded(output, `validation-tool-unavailable: could not start ${spec.display}: ${error.message}`);
        finish(null, false);
      });
      child.on('close', code => finish(forcedResult?.exitCode ?? code, forcedResult?.timedOut ?? false));
    });
  }
}

export interface ValidationRuntimeOptions {
  envPath?: string;
  onCommandStarted?: (command: string, index: number, total: number) => void;
}

type CommandSpec =
  | { ok: true; executable: string; args: string[]; display: string }
  | { ok: false; display: string; reason: string };

/**
 * `git diff --check` with the repository's own whitespace rules plus `cr-at-eol`. KarkeDikha preserves a file's
 * line endings byte for byte, so in a repository that commits CRLF every changed line ends in `\r`; plain
 * `--check` reports that terminator as "trailing whitespace" on every edited line, a failure no repair can fix
 * (seen live on a CRLF event_forms.html). Real trailing spaces and tabs are still reported.
 */
export function diffCheckWhitespaceRules(workspaceRoot: string): string {
  let configured = '';
  try {
    configured = execFileSync('git', ['config', '--get', 'core.whitespace'], {
      cwd: workspaceRoot, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000,
    }).trim();
  } catch {
    // Unset (exit 1) or unreadable: git's defaults apply.
  }
  const rules = configured.split(',').map(rule => rule.trim()).filter(rule => rule && rule !== '-cr-at-eol' && rule !== 'cr-at-eol');
  return [...rules, 'cr-at-eol'].join(',');
}

export function commandSpec(
  command: CodingValidationCommand,
  workspaceRoot: string,
  runtime: ValidationRuntimeOptions = {},
): CommandSpec {
  switch (command.kind) {
    case 'git-diff-check':
      return { ok: true, executable: 'git', args: ['-c', `core.whitespace=${diffCheckWhitespaceRules(workspaceRoot)}`, 'diff', '--check'], display: 'git diff --check' };
    case 'git-status-short':
      return { ok: true, executable: 'git', args: ['status', '--short'], display: 'git status --short' };
    case 'tsc-no-emit':
      return localNodeToolCommand(
        workspaceRoot,
        runtime,
        path.join('node_modules', 'typescript', 'bin', 'tsc'),
        ['--noEmit', '--pretty', 'false'],
        'npx tsc --noEmit --pretty false',
        'validation-tool-unavailable: workspace-local TypeScript is not installed.',
      );
    case 'vitest': {
      const args = normalizeVitestArgs(command.args ?? []);
      return localNodeToolCommand(
        workspaceRoot,
        runtime,
        path.join('node_modules', 'vitest', 'vitest.mjs'),
        ['run', ...args],
        `npx vitest run ${args.join(' ')}`.trim(),
        'validation-tool-unavailable: workspace-local Vitest is not installed.',
      );
    }
    case 'npm-test':
      return staleProposalAuthorization(command, workspaceRoot, 'npm test')
        ?? npmScriptCommand(workspaceRoot, runtime, 'test', 'npm test');
    case 'npm-script':
      return staleProposalAuthorization(command, workspaceRoot, `npm run ${command.script ?? 'verify'}`)
        ?? npmScriptCommand(workspaceRoot, runtime, command.script ?? 'verify', `npm run ${command.script ?? 'verify'}`);
    case 'node-check': {
      const target = command.args?.[0] ?? '';
      const display = `node --check ${target}`.trim();
      const absolute = path.resolve(workspaceRoot, target);
      const relative = path.relative(workspaceRoot, absolute);
      if (!target || !/\.(c|m)?js$/i.test(target) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return { ok: false, display, reason: 'validation-command-invalid: node-check needs one workspace-relative .js/.cjs/.mjs path.' };
      }
      const node = resolveNodeExe(runtime);
      return node.ok ? { ok: true, executable: node.path, args: ['--check', absolute], display } : { ok: false, display, reason: node.reason };
    }
    case 'pytest': {
      const isWin = process.platform === 'win32';
      const pythonCandidates = [
        path.join(workspaceRoot, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python'),
        path.join(workspaceRoot, 'venv', isWin ? 'Scripts/python.exe' : 'bin/python'),
        path.join(workspaceRoot, 'env', isWin ? 'Scripts/python.exe' : 'bin/python'),
      ];
      let executable = isWin ? 'python' : 'python3';
      for (const candidate of pythonCandidates) {
        if (fs.existsSync(candidate)) {
          executable = candidate;
          break;
        }
      }
      const args = ['-m', 'pytest', ...(command.args ?? [])];
      const display = ['pytest', ...(command.args ?? [])].join(' ').trim();
      return { ok: true, executable, args, display };
    }
  }
}

/**
 * Git worktrees intentionally omit ignored dependency directories such as
 * node_modules. Validation still has to execute against the exact isolated
 * source tree. When the isolated worktree still declares the same dependency
 * identity as its own HEAD and the primary lockfile still matches, copy the
 * main worktree's installed dependency tree into the isolated worktree for
 * the duration of validation. Unrelated dirty primary package.json edits
 * (for example uncommitted VS Code contributes) must not starve TypeScript
 * or Vitest. A task that edits package.json or a lockfile still refuses the
 * host snapshot. There is no network install and no copy of arbitrary host
 * state when dependency identity actually diverged.
 *
 * The dependency root must be a real local directory, not a junction. npm's
 * dependency-tree checks treat packages reached through a linked node_modules
 * root as linked development packages and incorrectly require each package's
 * unpublished devDependencies. A local snapshot also prevents validation from
 * mutating the main checkout's installed dependencies.
 */
export async function projectWorktreeDependencies(workspaceRoot: string): Promise<() => Promise<void>> {
  const target = path.join(workspaceRoot, 'node_modules');
  if (await pathExists(target)) {
    return async () => undefined;
  }

  const mainWorktree = resolveMainWorktreeRoot(workspaceRoot);
  if (!mainWorktree || pathsEqual(mainWorktree, workspaceRoot)) {
    return async () => undefined;
  }
  const source = path.join(mainWorktree, 'node_modules');
  if (!isExistingDirectory(source) || !dependencyManifestsMatch(workspaceRoot, mainWorktree)) {
    return async () => undefined;
  }

  try {
    await fs.promises.cp(source, target, {
      recursive: true,
      dereference: false,
      force: false,
      errorOnExist: true,
      mode: fs.constants.COPYFILE_FICLONE,
    });
  } catch (error) {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
    throw new Error(`validation_dependency_projection_failed:${error instanceof Error ? error.message : String(error)}`);
  }

  return async () => {
    await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }).catch(() => undefined);
  };
}

function resolveMainWorktreeRoot(workspaceRoot: string): string | undefined {
  try {
    const trustedRoot = path.resolve(workspaceRoot).replace(/\\/g, '/');
    const commonRaw = execFileSync('git', ['-c', `safe.directory=${trustedRoot}`, 'rev-parse', '--git-common-dir'], {
      cwd: workspaceRoot,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!commonRaw) {
      return undefined;
    }
    const commonDir = path.isAbsolute(commonRaw)
      ? path.resolve(commonRaw)
      : path.resolve(workspaceRoot, commonRaw);
    if (path.basename(commonDir).toLowerCase() !== '.git') {
      return undefined;
    }
    return path.dirname(commonDir);
  } catch {
    return undefined;
  }
}

// bun.lockb is a binary lockfile; every other manifest here is text and, on
// Windows with core.autocrlf=true, a freshly checked-out worktree legitimately
// renders LF blobs as CRLF even when the main checkout's working copy still
// has LF on disk (e.g. because it was last written directly rather than via
// `git checkout`). Both sides still hash to the identical git blob. Comparing
// raw bytes therefore treats an artifact-identical worktree as a dependency
// mismatch and refuses a projection that is actually safe.
const BINARY_MANIFESTS = new Set(['bun.lockb']);

function manifestContentMatches(manifest: string, workspacePath: string, mainPath: string): boolean {
  const workspaceBytes = fs.readFileSync(workspacePath);
  const mainBytes = fs.readFileSync(mainPath);
  if (BINARY_MANIFESTS.has(manifest)) {
    return workspaceBytes.equals(mainBytes);
  }
  const normalize = (buffer: Buffer): string => buffer.toString('utf8').replace(/\r\n/g, '\n');
  return normalize(workspaceBytes) === normalize(mainBytes);
}

function dependencyManifestsMatch(workspaceRoot: string, mainWorktree: string): boolean {
  const manifests = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  const lockfiles = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb'];
  // Isolated worktree files must still match that worktree's HEAD so a task
  // that edits package.json/lockfile cannot reuse a stale host snapshot.
  // Compare against HEAD, not the primary working copy: a dirty primary
  // package.json is not a dependency-identity change.
  for (const manifest of manifests) {
    if (!workingTreeManifestMatchesHead(workspaceRoot, manifest)) {
      return false;
    }
  }
  // Host node_modules was installed from the primary's on-disk lockfile.
  for (const lockfile of lockfiles) {
    const workspacePath = path.join(workspaceRoot, lockfile);
    const mainPath = path.join(mainWorktree, lockfile);
    const workspaceExists = isExistingFile(workspacePath);
    const mainExists = isExistingFile(mainPath);
    if (workspaceExists !== mainExists) {
      return false;
    }
    if (workspaceExists && !manifestContentMatches(lockfile, workspacePath, mainPath)) {
      return false;
    }
  }
  return true;
}

function workingTreeManifestMatchesHead(workspaceRoot: string, manifest: string): boolean {
  const workspacePath = path.join(workspaceRoot, manifest);
  const workspaceExists = isExistingFile(workspacePath);
  const headBytes = readHeadFile(workspaceRoot, manifest);
  if (!workspaceExists && headBytes === undefined) {
    return true;
  }
  if (!workspaceExists || headBytes === undefined) {
    return false;
  }
  if (BINARY_MANIFESTS.has(manifest)) {
    return fs.readFileSync(workspacePath).equals(headBytes);
  }
  const normalize = (buffer: Buffer): string => buffer.toString('utf8').replace(/\r\n/g, '\n');
  return normalize(fs.readFileSync(workspacePath)) === normalize(headBytes);
}

function readHeadFile(workspaceRoot: string, manifest: string): Buffer | undefined {
  try {
    const trustedRoot = path.resolve(workspaceRoot).replace(/\\/g, '/');
    return execFileSync('git', ['-c', `safe.directory=${trustedRoot}`, 'show', `HEAD:${manifest.replace(/\\/g, '/')}`], {
      cwd: workspaceRoot,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
}

function pathsEqual(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.promises.lstat(filePath).then(() => true, () => false);
}

function isExistingDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function localNodeToolCommand(
  workspaceRoot: string,
  runtime: ValidationRuntimeOptions,
  relativeToolPath: string,
  args: string[],
  display: string,
  missingToolReason: string,
): CommandSpec {
  const node = resolveNodeExe(runtime);
  if (!node.ok) {
    return { ok: false, display, reason: node.reason };
  }
  const toolPath = path.join(workspaceRoot, relativeToolPath);
  if (!isExistingFile(toolPath)) {
    return { ok: false, display, reason: missingToolReason };
  }
  return { ok: true, executable: node.path, args: [toolPath, ...args], display };
}

/**
 * A script authorized only by the approved proposal's own package.json may run
 * only while the on-disk package.json still matches that approved content.
 * Any later change makes the authorization stale; the command fails closed.
 */
function staleProposalAuthorization(
  command: CodingValidationCommand,
  workspaceRoot: string,
  display: string,
): CommandSpec | undefined {
  if (!command.authorization) return undefined;
  let current: string;
  try {
    current = fs.readFileSync(path.join(workspaceRoot, 'package.json'), 'utf8');
  } catch {
    return { ok: false, display, reason: 'validation-authorization-stale: the approved package.json is missing.' };
  }
  return approvedPackageJsonFingerprint(current) === command.authorization.packageJsonSha256
    ? undefined
    : { ok: false, display, reason: 'validation-authorization-stale: package.json no longer matches the approved proposal content.' };
}

function npmScriptCommand(
  workspaceRoot: string,
  runtime: ValidationRuntimeOptions,
  script: string,
  display: string,
): CommandSpec {
  const node = resolveNodeExe(runtime);
  if (!node.ok) {
    return { ok: false, display, reason: node.reason };
  }
  const npmCli = resolveNpmCli(node.path);
  if (!npmCli) {
    return { ok: false, display, reason: 'validation-tool-unavailable: npm-cli.js was not found in the resolved Node.js distribution.' };
  }
  if (!isExistingFile(path.join(workspaceRoot, 'package.json'))) {
    return { ok: false, display, reason: 'validation-tool-unavailable: package.json was not found in the workspace.' };
  }
  return { ok: true, executable: node.path, args: [npmCli, 'run', script], display };
}

function normalizeVitestArgs(args: readonly string[]): string[] {
  return args.filter((arg, index) => !(index === 0 && (arg === 'run' || arg === '--run')));
}

function resolveNodeExe(runtime: ValidationRuntimeOptions): { ok: true; path: string } | { ok: false; reason: string } {
  const envPath = runtime.envPath ?? process.env.PATH ?? '';
  const candidates = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of candidates) {
    const nodePath = path.join(entry, process.platform === 'win32' ? 'node.exe' : 'node');
    if (isExistingFile(nodePath) && isAllowedNodeExecutable(nodePath)) {
      return { ok: true, path: nodePath };
    }
  }
  return { ok: false, reason: 'validation-tool-unavailable: no valid node.exe was found on PATH.' };
}

function isAllowedNodeExecutable(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (base !== 'node.exe' && base !== 'node') {
    return false;
  }
  const normalized = filePath.toLowerCase();
  return !normalized.includes(`${path.sep}vscode${path.sep}`);
}

function resolveNpmCli(nodePath: string): string | undefined {
  const nodeDir = path.dirname(nodePath);
  const candidates = [
    path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(nodeDir), 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  return candidates.find(isExistingFile);
}

function isExistingFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function appendBounded(current: string, next: string): string {
  return (current + next).slice(-12_000);
}

function sanitizeOutput(output: string): string {
  return output
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/authorization:\s*\S+/gi, 'authorization: [redacted]')
    .replace(/(token|secret|password|api[_-]?key)=\S+/gi, '$1=[redacted]');
}

function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) {
    return Promise.resolve();
  }
  return new Promise(resolve => {
    try {
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, shell: false });
        killer.on('error', () => resolve());
        killer.on('close', () => resolve());
      } else {
        process.kill(-pid, 'SIGTERM');
        resolve();
      }
    } catch {
      try {
        process.kill(pid);
      } catch {
        // Process may have already exited.
      }
      resolve();
    }
  });
}
