import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import type * as vscode from 'vscode';
import { ProviderReadinessProbe, providerReadinessDetail } from './ProviderReadiness';

export type DiagnosticSeverity = 'info' | 'warning' | 'error';
export type DiagnosticStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface DiagnosticFinding {
  id: string;
  status: DiagnosticStatus;
  severity: DiagnosticSeverity;
  summary: string;
  detail?: string;
  repairId?: string;
  repairRequiresApproval?: boolean;
}

export interface DiagnosticReport {
  schemaVersion: 1;
  generatedAt: string;
  healthy: boolean;
  findings: DiagnosticFinding[];
}

export interface DiagnosticContext {
  workspaceRoot: string;
  stateRoot: string;
  signal: AbortSignal;
}

export interface DiagnosticCheck {
  id: string;
  run(context: DiagnosticContext): Promise<DiagnosticFinding>;
}

export interface DiagnosticRepair {
  id: string;
  approvalRequired: boolean;
  execute(context: DiagnosticContext): Promise<{ summary: string; changedPaths: string[] }>;
}

export interface DiagnosticRepairResult {
  repairId: string;
  status: 'completed' | 'denied' | 'failed';
  summary: string;
  changedPaths: string[];
  error?: string;
}

export interface WorkspaceDiagnosticsOptions {
  secrets?: vscode.SecretStorage;
  providerReadinessProbe?: ProviderReadinessProbe;
  findTrackedRuntimeFiles?: (workspaceRoot: string) => Promise<string[]>;
  untrackRuntimeFiles?: (workspaceRoot: string) => Promise<string[]>;
}

export class SelfDiagnostics {
  private readonly checks = new Map<string, DiagnosticCheck>();
  private readonly repairs = new Map<string, DiagnosticRepair>();
  private controller: AbortController | null = null;

  constructor(private readonly workspaceRoot: string) {}

  registerCheck(check: DiagnosticCheck): void {
    validateId(check.id, 'diagnostic check');
    if (this.checks.has(check.id)) throw new Error(`Diagnostic check already registered: ${check.id}`);
    this.checks.set(check.id, check);
  }

  registerRepair(repair: DiagnosticRepair): void {
    validateId(repair.id, 'diagnostic repair');
    if (this.repairs.has(repair.id)) throw new Error(`Diagnostic repair already registered: ${repair.id}`);
    this.repairs.set(repair.id, repair);
  }

  async run(): Promise<DiagnosticReport> {
    if (this.controller) throw new Error('Diagnostics are already running.');
    this.controller = new AbortController();
    const context = this.context(this.controller.signal);
    try {
      const findings: DiagnosticFinding[] = [];
      for (const check of [...this.checks.values()].sort((a, b) => a.id.localeCompare(b.id))) {
        if (context.signal.aborted) throw abortError();
        try {
          const finding = await check.run(context);
          findings.push({ ...finding, id: check.id });
        } catch (error) {
          findings.push({
            id: check.id,
            status: 'unhealthy',
            severity: 'error',
            summary: 'Diagnostic check failed unexpectedly.',
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        healthy: findings.every(finding => finding.status !== 'unhealthy'),
        findings,
      };
    } finally {
      this.controller = null;
    }
  }

  async repair(repairId: string, approved: boolean): Promise<DiagnosticRepairResult> {
    const repair = this.repairs.get(repairId);
    if (!repair) throw new Error(`Unknown diagnostic repair: ${repairId}`);
    if (repair.approvalRequired && !approved) {
      return { repairId, status: 'denied', summary: 'Repair requires explicit approval.', changedPaths: [] };
    }
    const controller = new AbortController();
    try {
      const result = await repair.execute(this.context(controller.signal));
      for (const changedPath of result.changedPaths) assertInside(this.stateRoot(), changedPath);
      return { repairId, status: 'completed', summary: result.summary, changedPaths: [...result.changedPaths] };
    } catch (error) {
      return {
        repairId,
        status: 'failed',
        summary: 'Repair failed.',
        changedPaths: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  cancel(): boolean {
    if (!this.controller || this.controller.signal.aborted) return false;
    this.controller.abort();
    return true;
  }

  private context(signal: AbortSignal): DiagnosticContext {
    return { workspaceRoot: path.resolve(this.workspaceRoot), stateRoot: this.stateRoot(), signal };
  }

  private stateRoot(): string {
    return path.join(path.resolve(this.workspaceRoot), '.ollama-agent');
  }
}

export function createWorkspaceDiagnostics(
  workspaceRoot: string,
  options: WorkspaceDiagnosticsOptions = {},
): SelfDiagnostics {
  const diagnostics = new SelfDiagnostics(workspaceRoot);
  diagnostics.registerCheck({
    id: 'state-root',
    run: async context => {
      try {
        const stat = await fs.stat(context.stateRoot);
        return stat.isDirectory()
          ? { id: 'state-root', status: 'healthy', severity: 'info', summary: 'Runtime state directory is accessible.' }
          : { id: 'state-root', status: 'unhealthy', severity: 'error', summary: 'Runtime state path is not a directory.', repairId: 'create-state-directories', repairRequiresApproval: true };
      } catch {
        return { id: 'state-root', status: 'degraded', severity: 'warning', summary: 'Runtime state directory does not exist yet.', repairId: 'create-state-directories', repairRequiresApproval: true };
      }
    },
  });
  diagnostics.registerCheck({
    id: 'stale-temporary-files',
    run: async context => {
      const files = await findStaleTemporaryFiles(context.stateRoot, Date.now() - 60 * 60 * 1000);
      return files.length === 0
        ? { id: 'stale-temporary-files', status: 'healthy', severity: 'info', summary: 'No stale temporary runtime files found.' }
        : {
            id: 'stale-temporary-files',
            status: 'degraded',
            severity: 'warning',
            summary: `${files.length} stale temporary runtime file(s) found.`,
            detail: files.map(file => path.relative(context.workspaceRoot, file)).join(', '),
            repairId: 'remove-stale-temporary-files',
            repairRequiresApproval: true,
          };
    },
  });
  diagnostics.registerCheck({
    id: 'task-json-integrity',
    run: async context => {
      const tasksRoot = path.join(context.stateRoot, 'tasks');
      const failures: string[] = [];
      for (const filename of await findNamedFiles(tasksRoot, new Set(['task.json', 'state.json']))) {
        try { JSON.parse(await fs.readFile(filename, 'utf8')); }
        catch { failures.push(path.relative(context.workspaceRoot, filename)); }
      }
      return failures.length === 0
        ? { id: 'task-json-integrity', status: 'healthy', severity: 'info', summary: 'Persisted task JSON is readable.' }
        : { id: 'task-json-integrity', status: 'unhealthy', severity: 'error', summary: `${failures.length} persisted task file(s) are malformed.`, detail: failures.join(', ') };
    },
  });
  const providerReadinessProbe = options.providerReadinessProbe
    ?? (options.secrets ? ProviderReadinessProbe.forSecrets(options.secrets) : undefined);
  if (providerReadinessProbe) {
    diagnostics.registerCheck({
      id: 'provider-readiness',
      run: async context => {
        const result = await providerReadinessProbe.run(context.signal);
        return {
          id: 'provider-readiness',
          status: result.failureCode ? 'unhealthy' : 'healthy',
          severity: result.failureCode ? 'error' : 'info',
          summary: result.failureCode
            ? `Provider readiness failed: ${result.failureCode}.`
            : 'Configured provider and chat model are ready.',
          detail: providerReadinessDetail(result),
        };
      },
    });
  }
  diagnostics.registerRepair({
    id: 'create-state-directories',
    approvalRequired: true,
    execute: async context => {
      const directories = [context.stateRoot, path.join(context.stateRoot, 'tasks'), path.join(context.stateRoot, 'audit'), path.join(context.stateRoot, 'release')];
      for (const directory of directories) {
        assertInside(context.stateRoot, directory);
        await fs.mkdir(directory, { recursive: true });
      }
      return { summary: 'Runtime state directories created.', changedPaths: directories };
    },
  });
  diagnostics.registerRepair({
    id: 'remove-stale-temporary-files',
    approvalRequired: true,
    execute: async context => {
      const files = await findStaleTemporaryFiles(context.stateRoot, Date.now() - 60 * 60 * 1000);
      for (const filename of files) {
        assertInside(context.stateRoot, filename);
        await fs.rm(filename, { force: true });
      }
      return { summary: `Removed ${files.length} stale temporary runtime file(s).`, changedPaths: files };
    },
  });
  diagnostics.registerCheck({
    id: 'tracked-runtime-state',
    run: async context => {
      const finder = options.findTrackedRuntimeFiles ?? findTrackedRuntimeStateFiles;
      const tracked = await finder(context.workspaceRoot);
      return tracked.length === 0
        ? {
            id: 'tracked-runtime-state',
            status: 'healthy',
            severity: 'info',
            summary: 'No KarkeDikha runtime state files are tracked by Git.',
          }
        : {
            id: 'tracked-runtime-state',
            status: 'unhealthy',
            severity: 'warning',
            summary: `${tracked.length} KarkeDikha runtime state file(s) are tracked by Git. Runtime state should not be version-controlled and can block safe delivery.`,
            detail: tracked.join(', '),
            repairId: 'untrack-runtime-state',
            repairRequiresApproval: true,
          };
    },
  });
  diagnostics.registerRepair({
    id: 'untrack-runtime-state',
    approvalRequired: true,
    execute: async context => {
      const untracker = options.untrackRuntimeFiles ?? untrackRuntimeStateFiles;
      const untracked = await untracker(context.workspaceRoot);
      const changedPaths = untracked.map(p =>
        path.isAbsolute(p) ? p : path.resolve(context.workspaceRoot, p)
      );
      const sanitizedPaths = changedPaths.length > 0 && changedPaths.every(p => {
        try {
          assertInside(context.stateRoot, p);
          return true;
        } catch {
          return false;
        }
      }) ? changedPaths : [context.stateRoot];
      return {
        summary: 'KarkeDikha runtime state untracked from Git index (local files preserved).',
        changedPaths: sanitizedPaths,
      };
    },
  });
  return diagnostics;
}

export async function findTrackedRuntimeStateFiles(workspaceRoot: string): Promise<string[]> {
  return new Promise<string[]>(resolve => {
    try {
      const child = spawn('git', ['ls-files', '--', '.ollama-agent'], { cwd: workspaceRoot, shell: false, windowsHide: true });
      let output = '';
      const timer = setTimeout(() => { child.kill(); resolve([]); }, 5_000);
      child.stdout.on('data', data => { output += String(data); });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return resolve([]);
        resolve(output.split(/\r?\n/).map(l => l.trim()).filter(Boolean));
      });
    } catch {
      resolve([]);
    }
  });
}

export async function untrackRuntimeStateFiles(workspaceRoot: string): Promise<string[]> {
  return new Promise<string[]>(resolve => {
    try {
      const child = spawn('git', ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.ollama-agent'], { cwd: workspaceRoot, shell: false, windowsHide: true });
      const timer = setTimeout(() => { child.kill(); resolve([]); }, 5_000);
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('close', code => {
        clearTimeout(timer);
        resolve(code === 0 ? ['.ollama-agent'] : []);
      });
    } catch {
      resolve([]);
    }
  });
}

async function findStaleTemporaryFiles(root: string, olderThan: number): Promise<string[]> {
  const files = await walk(root);
  const stale: string[] = [];
  for (const filename of files) {
    if (!/\.(?:tmp|temp)$/i.test(filename)) continue;
    const stat = await fs.stat(filename).catch(() => undefined);
    if (stat?.isFile() && stat.mtimeMs < olderThan) stale.push(filename);
  }
  return stale.sort();
}

async function findNamedFiles(root: string, names: Set<string>): Promise<string[]> {
  return (await walk(root)).filter(filename => names.has(path.basename(filename))).sort();
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: Array<import('fs').Dirent>;
    try { entries = await fs.readdir(current, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else if (entry.isFile()) output.push(full);
    }
  }
  return output;
}

function assertInside(root: string, candidate: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Diagnostic repair attempted to escape runtime state: ${candidate}`);
  }
}

function validateId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(value)) throw new Error(`Invalid ${label} id: ${value}`);
}

function abortError(): Error {
  const error = new Error('Diagnostics cancelled.');
  error.name = 'AbortError';
  return error;
}
