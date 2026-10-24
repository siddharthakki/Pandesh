import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { validateRelativeWorkspacePath, normalizeRelativePath, fingerprintText } from './CodingProposal';

export interface WorkspaceFileEntry {
  path: string;
  bytes: number;
}

export interface WorkspaceTextFile {
  path: string;
  content: string;
  fingerprint: string;
  totalLines?: number;
  characterCount?: number;
}

export interface WorkspaceSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface WorkspaceInspectionLimits {
  maxFiles: number;
  maxReadBytes: number;
  maxSearchResults: number;
  gitTimeoutMs?: number;
}

export const DEFAULT_INSPECTION_LIMITS: WorkspaceInspectionLimits = {
  maxFiles: 200,
  maxReadBytes: 80_000,
  maxSearchResults: 100,
};

export type WorkspaceSearchOutcome =
  | { ok: true; matches: WorkspaceSearchMatch[]; source: 'git' | 'walk' }
  | { ok: false; error: string };

export interface GitCommandResult {
  stdout: string;
  exitCode: number;
  timedOut?: boolean;
  spawnError?: boolean;
}

/** Timeout and spawn failure are not git-grep's "no matches" exit (1). */
export function classifyGitGrepResult(result: GitCommandResult): 'ok' | 'unavailable' | 'timed_out' {
  if (result.timedOut) return 'timed_out';
  if (result.spawnError) return 'unavailable';
  if (result.exitCode === 0 || result.exitCode === 1) return 'ok';
  return 'unavailable';
}

const EXCLUDED = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', 'tmp', 'temp', '.cache', 'cache']);

export class WorkspaceInspectionTools {
  constructor(
    readonly workspaceRoot: string,
    private readonly limits: WorkspaceInspectionLimits = DEFAULT_INSPECTION_LIMITS,
  ) {}

  async listFiles(signal?: AbortSignal): Promise<WorkspaceFileEntry[]> {
    const root = await this.realRoot();
    const entries: WorkspaceFileEntry[] = [];
    await this.walk(root, '', entries, signal);
    return entries.sort((a, b) => a.path.localeCompare(b.path));
  }

  async readTextFile(relativePath: string, signal?: AbortSignal): Promise<WorkspaceTextFile> {
    throwIfAborted(signal);
    const absolute = await this.resolveInsideWorkspace(relativePath);
    const stat = await fs.stat(absolute);
    if (stat.size > this.limits.maxReadBytes) {
      throw new Error('read_limit_exceeded');
    }
    const buffer = await fs.readFile(absolute);
    if (isBinary(buffer)) {
      throw new Error('binary_file_rejected');
    }
    const content = buffer.toString('utf8');
    const lines = content.length === 0 ? [] : content.split(/\r?\n/);
    return {
      path: normalizeRelativePath(relativePath),
      content,
      fingerprint: fingerprintText(content),
      totalLines: lines.length,
      characterCount: content.length,
    };
  }

  async searchText(
    query: string,
    signal?: AbortSignal,
    options?: { scopePath?: string },
  ): Promise<WorkspaceSearchOutcome> {
    if (!query) {
      return { ok: true, matches: [], source: 'git' };
    }
    const scope = options?.scopePath ? normalizeRelativePath(options.scopePath) : '';
    const git = await this.searchGitTracked(query, scope, signal);
    if (git.kind === 'timed_out') {
      return { ok: false, error: 'search_timed_out' };
    }
    if (git.kind === 'ok') {
      return { ok: true, matches: git.matches, source: 'git' };
    }
    try {
      const matches = await this.searchByWalk(query, scope, signal);
      return { ok: true, matches, source: 'walk' };
    } catch (error) {
      if (error instanceof Error && error.message === 'cancelled') {
        throw error;
      }
      return { ok: false, error: 'search_unavailable' };
    }
  }

  async gitStatus(): Promise<string> {
    return this.runGit(['status', '--short']);
  }

  async gitDiff(): Promise<string> {
    return this.runGit(['diff', '--stat']);
  }

  async resolveInsideWorkspace(relativePath: string): Promise<string> {
    const pathError = validateInspectionPath(relativePath);
    if (pathError) {
      throw new Error(pathError);
    }
    const root = await this.realRoot();
    const target = path.resolve(root, normalizeRelativePath(relativePath));
    const parentReal = await nearestExistingRealPath(path.dirname(target), root);
    assertInside(root, parentReal);
    return target;
  }

  /**
   * Literal substring search over git-tracked files. Independent of
   * `listFiles`' display cap (`maxFiles`), which is only a preview of early
   * walk entries — using that list as the search corpus silently misses later
   * paths such as `src/` in a real repository.
   */
  private async searchGitTracked(
    query: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<
    | { kind: 'ok'; matches: WorkspaceSearchMatch[] }
    | { kind: 'timed_out' }
    | { kind: 'unavailable' }
  > {
    throwIfAborted(signal);
    const args = ['grep', '-F', '-n', '-I', '-e', query, '--', scope || '.'];
    const result = await this.runGitResult(args);
    const classification = classifyGitGrepResult(result);
    if (classification === 'timed_out') {
      return { kind: 'timed_out' };
    }
    if (classification === 'unavailable') {
      return { kind: 'unavailable' };
    }
    const output = result.stdout;
    const matches: WorkspaceSearchMatch[] = [];
    for (const line of output.split(/\r?\n/)) {
      if (!line || matches.length >= this.limits.maxSearchResults) {
        break;
      }
      const parsed = parseGitGrepLine(line);
      if (!parsed) {
        continue;
      }
      if (scope && parsed.path !== scope && !parsed.path.startsWith(`${scope}/`)) {
        continue;
      }
      matches.push({ path: parsed.path, line: parsed.line, text: parsed.text.slice(0, 240) });
    }
    return { kind: 'ok', matches };
  }

  private async searchByWalk(
    query: string,
    scope: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceSearchMatch[]> {
    const matches: WorkspaceSearchMatch[] = [];
    const root = await this.realRoot();
    await this.walkSearch(root, '', query, scope, matches, signal);
    return matches;
  }

  private async walkSearch(
    root: string,
    relative: string,
    query: string,
    scope: string,
    matches: WorkspaceSearchMatch[],
    signal?: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal);
    if (matches.length >= this.limits.maxSearchResults) {
      return;
    }
    const absolute = path.join(root, relative);
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    for (const dirent of dirents) {
      throwIfAborted(signal);
      if (matches.length >= this.limits.maxSearchResults) {
        return;
      }
      if (EXCLUDED.has(dirent.name)) {
        continue;
      }
      const childRelative = normalizeRelativePath(path.posix.join(relative.replace(/\\/g, '/'), dirent.name));
      if (validateRelativeWorkspacePath(childRelative)) {
        continue;
      }
      if (scope && childRelative !== scope && !childRelative.startsWith(`${scope}/`) && !scope.startsWith(`${childRelative}/`)) {
        if (dirent.isDirectory()) {
          continue;
        }
        if (childRelative !== scope && !childRelative.startsWith(`${scope}/`)) {
          continue;
        }
      }
      const childAbsolute = path.join(root, childRelative);
      if (dirent.isSymbolicLink()) {
        continue;
      }
      if (dirent.isDirectory()) {
        await this.walkSearch(root, childRelative, query, scope, matches, signal);
      } else if (dirent.isFile()) {
        if (scope && childRelative !== scope && !childRelative.startsWith(`${scope}/`)) {
          continue;
        }
        try {
          const file = await this.readTextFile(childRelative, signal);
          const lines = file.content.split(/\r?\n/);
          for (let index = 0; index < lines.length && matches.length < this.limits.maxSearchResults; index += 1) {
            if (lines[index].includes(query)) {
              matches.push({ path: file.path, line: index + 1, text: lines[index].slice(0, 240) });
            }
          }
        } catch {
          // Listing is best-effort for text context; rejected binary/large files are skipped.
        }
      }
    }
  }

  private async walk(root: string, relative: string, entries: WorkspaceFileEntry[], signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (entries.length >= this.limits.maxFiles) {
      return;
    }
    const absolute = path.join(root, relative);
    const dirents = await fs.readdir(absolute, { withFileTypes: true });
    for (const dirent of dirents) {
      throwIfAborted(signal);
      if (entries.length >= this.limits.maxFiles) {
        return;
      }
      if (EXCLUDED.has(dirent.name)) {
        continue;
      }
      const childRelative = normalizeRelativePath(path.posix.join(relative.replace(/\\/g, '/'), dirent.name));
      if (validateRelativeWorkspacePath(childRelative)) {
        continue;
      }
      const childAbsolute = path.join(root, childRelative);
      if (dirent.isSymbolicLink()) {
        const real = await fs.realpath(childAbsolute);
        assertInside(root, real);
        const stat = await fs.stat(real);
        if (stat.isDirectory()) {
          continue;
        }
        entries.push({ path: childRelative, bytes: stat.size });
      } else if (dirent.isDirectory()) {
        await this.walk(root, childRelative, entries, signal);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(childAbsolute);
        entries.push({ path: childRelative, bytes: stat.size });
      }
    }
  }

  private async realRoot(): Promise<string> {
    return fs.realpath(this.workspaceRoot);
  }

  private async runGit(args: string[]): Promise<string> {
    const result = await this.runGitResult(args);
    return result.stdout;
  }

  private async runGitResult(args: string[]): Promise<GitCommandResult> {
    const timeoutMs = this.limits.gitTimeoutMs ?? 10_000;
    return new Promise((resolve) => {
      let stdout = '';
      let settled = false;
      const finish = (result: GitCommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn('git', args, { cwd: this.workspaceRoot, shell: false, windowsHide: true });
      const timer = setTimeout(() => {
        child.kill();
        finish({ stdout: stdout.slice(0, 50_000), exitCode: -1, timedOut: true });
      }, timeoutMs);
      child.stdout.on('data', data => {
        stdout = (stdout + String(data)).slice(0, 50_000);
      });
      child.stderr.on('data', () => { /* status only; never treat diagnostics as matches */ });
      child.on('error', () => {
        clearTimeout(timer);
        finish({ stdout: '', exitCode: 128, spawnError: true });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        finish({ stdout: stdout.slice(0, 50_000), exitCode: code ?? 1 });
      });
    });
  }
}

function parseGitGrepLine(line: string): WorkspaceSearchMatch | undefined {
  const match = /^([^:]+):(\d+):(.*)$/.exec(line);
  if (!match) {
    return undefined;
  }
  const lineNumber = Number(match[2]);
  if (!Number.isInteger(lineNumber) || lineNumber < 1) {
    return undefined;
  }
  return { path: normalizeRelativePath(match[1]), line: lineNumber, text: match[3] };
}

function validateInspectionPath(relativePath: string): string | undefined {
  const base = validateRelativeWorkspacePath(relativePath);
  if (base) {
    return base;
  }
  if (/^(\\\\|\/\/)/.test(relativePath) || relativePath.startsWith('\\\\?\\') || relativePath.startsWith('\\\\.\\')) {
    return 'device_or_unc_path_rejected';
  }
  if (relativePath.includes(':')) {
    return 'alternate_data_stream_rejected';
  }
  for (const segment of normalizeRelativePath(relativePath).split('/')) {
    if (!segment || segment.endsWith(' ') || segment.endsWith('.')) {
      return 'ambiguous_windows_path_rejected';
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(segment)) {
      return 'reserved_windows_name_rejected';
    }
  }
  return undefined;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('cancelled');
  }
}

function isBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 8000)).includes(0);
}

async function nearestExistingRealPath(candidate: string, root: string): Promise<string> {
  let current = candidate;
  while (current.length >= root.length) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return fs.realpath(root);
}

function assertInside(root: string, target: string): void {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('path_outside_workspace');
  }
}
