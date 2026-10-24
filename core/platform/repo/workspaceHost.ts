/**
 * WorkspaceHost: the portable seam between a context engine and "the place the code lives".
 *
 * A host answers identity / list / read / search / symbols / definitions / references / diagnostics / open files /
 * git state / hashes. The VS Code extension provides one adapter (LSP-backed), `LocalFilesystemWorkspaceHost` works
 * anywhere Node runs (CLI, tests, a future JARVIS), and any other environment can supply its own.
 *
 * Only `identity`, `listPaths`, `readFile` and `stat` are required: everything else is an optional accelerator, so a
 * minimal host is still fully usable (the context engine falls back to `search`/lexical work).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface WorkspaceIdentity {
  /** Stable id for persistence (hash of the real root path). */
  id: string;
  root: string;
  name: string;
  vcs: 'git' | 'none';
  head?: string;
}

export interface FileStat { size: number; mtimeMs: number }
export interface SearchHit { path: string; line: number; text: string }
export interface SymbolHit { name: string; kind: string; path: string; line: number; container?: string }
export interface HostLocation { path: string; line: number; column?: number }
export interface HostDiagnostic { path: string; line: number; severity: 'error' | 'warning' | 'info'; message: string }
export interface GitState { head?: string; branch?: string; changed: string[]; untracked: string[] }
export interface ReadResult { text: string; totalLines: number; truncated: boolean }

export interface SearchOptions {
  /** Treat `query` as a regular expression (default: fixed string). */
  regex?: boolean;
  wholeWord?: boolean;
  caseSensitive?: boolean;
  maxResults?: number;
  /** Restrict to these workspace-relative paths. */
  paths?: readonly string[];
  signal?: AbortSignal;
}

export interface WorkspaceHost {
  readonly kind: string;
  identity(): Promise<WorkspaceIdentity>;
  /** Every non-ignored file, workspace-relative POSIX paths. Fast: no per-file I/O. */
  listPaths(signal?: AbortSignal): Promise<string[]>;
  stat(relPath: string): Promise<FileStat | undefined>;
  readFile(relPath: string, range?: { startLine: number; endLine: number }, maxBytes?: number): Promise<ReadResult | undefined>;
  fileHash?(relPath: string): Promise<string | undefined>;
  search?(query: string, options?: SearchOptions): Promise<SearchHit[]>;
  symbols?(query: string, max?: number): Promise<SymbolHit[]>;
  definitions?(relPath: string, line: number, column: number): Promise<HostLocation[]>;
  references?(relPath: string, line: number, column: number): Promise<HostLocation[]>;
  diagnostics?(relPaths?: readonly string[]): Promise<HostDiagnostic[]>;
  openFiles?(): Promise<string[]>;
  recentFiles?(): Promise<string[]>;
  gitState?(): Promise<GitState>;
}

export const DEFAULT_IGNORED_DIRS: ReadonlySet<string> = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.next', '.gradle', '.idea', '__pycache__', '.pytest_cache',
  'target', 'bin', 'obj', 'vendor', '.venv', 'venv', '.tox', 'site-packages', 'bower_components', '.mypy_cache', '.cache',
  '.turbo', '.nuxt', '.svelte-kit', '.angular', '.dart_tool', '.terraform', '.ollama-agent',
]);

const MAX_BUFFER = 512 * 1024 * 1024;

function run(cwd: string, file: string, args: string[], timeoutMs: number, signal?: AbortSignal): Promise<{ ok: boolean; stdout: string }> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { cwd, maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true, signal, encoding: 'utf8' }, (error, stdout) => {
        resolve({ ok: !error, stdout: typeof stdout === 'string' ? stdout : '' });
      });
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

export class LocalFilesystemWorkspaceHost implements WorkspaceHost {
  readonly kind: string = 'local-filesystem';
  private identityPromise?: Promise<WorkspaceIdentity>;
  private gitAvailable?: Promise<boolean>;

  constructor(
    protected readonly root: string,
    private readonly options: { ignoredDirs?: ReadonlySet<string>; gitTimeoutMs?: number; maxWalkFiles?: number } = {},
  ) {}

  protected git(args: string[], timeoutMs = this.options.gitTimeoutMs ?? 120_000, signal?: AbortSignal): Promise<{ ok: boolean; stdout: string }> {
    return run(this.root, 'git', args, timeoutMs, signal);
  }

  protected isGit(): Promise<boolean> {
    this.gitAvailable ??= this.git(['rev-parse', '--is-inside-work-tree'], 5_000).then(r => r.ok && r.stdout.trim() === 'true');
    return this.gitAvailable;
  }

  identity(): Promise<WorkspaceIdentity> {
    this.identityPromise ??= (async () => {
      let real = this.root;
      try { real = await fs.realpath(this.root); } catch { /* keep the given path */ }
      const git = await this.isGit();
      const head = git ? (await this.git(['rev-parse', 'HEAD'], 5_000)).stdout.trim() || undefined : undefined;
      return {
        id: createHash('sha1').update(real.toLowerCase()).digest('hex').slice(0, 16),
        root: real,
        name: path.basename(real),
        vcs: git ? 'git' as const : 'none' as const,
        ...(head ? { head } : {}),
      };
    })();
    return this.identityPromise;
  }

  async listPaths(signal?: AbortSignal): Promise<string[]> {
    if (await this.isGit()) {
      const result = await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], this.options.gitTimeoutMs ?? 300_000, signal);
      if (result.ok) {
        const ignored = this.options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
        const seen = new Set<string>();
        for (const entry of result.stdout.split('\0')) {
          if (!entry) continue;
          const rel = toPosix(entry);
          if (rel.split('/').some(segment => ignored.has(segment))) continue;
          seen.add(rel);
        }
        return [...seen];
      }
    }
    return this.walk(signal);
  }

  /** Non-git fallback: bounded directory walk honouring the ignore list. */
  private async walk(signal?: AbortSignal): Promise<string[]> {
    const ignored = this.options.ignoredDirs ?? DEFAULT_IGNORED_DIRS;
    const max = this.options.maxWalkFiles ?? 500_000;
    const out: string[] = [];
    const stack: string[] = [''];
    while (stack.length > 0 && out.length < max) {
      if (signal?.aborted) break;
      const dir = stack.pop()!;
      let entries: import('node:fs').Dirent[];
      try { entries = await fs.readdir(path.join(this.root, dir), { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!ignored.has(entry.name)) stack.push(dir ? `${dir}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          out.push(dir ? `${dir}/${entry.name}` : entry.name);
          if (out.length >= max) break;
        }
      }
    }
    return out;
  }

  /** Resolves a workspace-relative path and refuses anything that escapes the root. */
  protected resolve(relPath: string): string | undefined {
    const full = path.resolve(this.root, relPath);
    const rel = path.relative(this.root, full);
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : full;
  }

  async stat(relPath: string): Promise<FileStat | undefined> {
    const full = this.resolve(relPath);
    if (!full) return undefined;
    try {
      const s = await fs.stat(full);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
    } catch { return undefined; }
  }

  async readFile(relPath: string, range?: { startLine: number; endLine: number }, maxBytes = 1_000_000): Promise<ReadResult | undefined> {
    const full = this.resolve(relPath);
    if (!full) return undefined;
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(full, 'r');
      const size = (await handle.stat()).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      if (buffer.subarray(0, Math.min(length, 4096)).includes(0)) return undefined; // binary
      const text = buffer.toString('utf8');
      const truncated = size > maxBytes;
      const lines = text.split(/\r?\n/);
      if (!range) return { text, totalLines: lines.length, truncated };
      const start = Math.max(1, Math.floor(range.startLine));
      const end = Math.max(start, Math.floor(range.endLine));
      return { text: lines.slice(start - 1, end).join('\n'), totalLines: lines.length, truncated };
    } catch { return undefined; } finally { await handle?.close().catch(() => undefined); }
  }

  async fileHash(relPath: string): Promise<string | undefined> {
    const read = await this.readFile(relPath, undefined, 8_000_000);
    return read ? createHash('sha1').update(read.text).digest('hex') : undefined;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const max = Math.max(1, Math.min(options.maxResults ?? 200, 2000));
    if (!query.trim()) return [];
    if (await this.isGit()) {
      // A file created a moment ago (not yet `git add`ed) must be as searchable as a committed one. `--untracked` makes git
      // walk the whole tree serially (~+100 ms on a big repo), so without a path scope we grep tracked files and, in
      // parallel, grep only the (usually few) untracked ones.
      const flags = ['-n', '-I', '--no-color', `--max-count=${Math.min(max, 50)}`, options.regex ? '-E' : '-F'];
      if (!options.caseSensitive) flags.push('-i');
      if (options.wholeWord) flags.push('-w');
      const scoped = Boolean(options.paths?.length);
      const tail = ['-e', query, '--', ...(scoped ? options.paths!.slice(0, 500) : [])];
      const parse = (stdout: string, into: SearchHit[]): void => {
        for (const line of stdout.split(/\r?\n/)) { // CRLF checkouts: a trailing \r would defeat `.` and drop every hit
          const match = /^(.*?):(\d+):(.*)$/.exec(line);
          if (match) into.push({ path: toPosix(match[1]), line: Number(match[2]), text: match[3].slice(0, 300) });
        }
      };
      const tracked = this.git(['grep', ...(scoped ? ['--untracked'] : []), ...flags, ...tail], 30_000, options.signal);
      const untracked = scoped ? Promise.resolve([] as SearchHit[]) : (async () => {
        const listed = await this.git(['ls-files', '--others', '--exclude-standard', '-z'], 15_000, options.signal);
        const files = listed.stdout.split('\0').filter(Boolean).filter(f => !f.split('/').some(seg => (this.options.ignoredDirs ?? DEFAULT_IGNORED_DIRS).has(seg))).slice(0, 300);
        if (files.length === 0) return [];
        const found: SearchHit[] = [];
        parse((await this.git(['grep', '--no-index', ...flags, '-e', query, '--', ...files], 15_000, options.signal)).stdout, found);
        return found;
      })();
      const [trackedResult, extra] = await Promise.all([tracked, untracked]);
      const hits: SearchHit[] = [];
      parse(trackedResult.stdout, hits); // git grep exits 1 when nothing matched; stdout is still valid.
      hits.push(...extra);
      return hits.slice(0, max);
    }
    // Non-git: bounded scan.
    const files = options.paths?.length ? [...options.paths] : (await this.walk(options.signal)).slice(0, 4000);
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const pattern = options.regex ? new RegExp(query, options.caseSensitive ? '' : 'i') : undefined;
    const hits: SearchHit[] = [];
    for (const rel of files) {
      if (hits.length >= max || options.signal?.aborted) break;
      const read = await this.readFile(rel, undefined, 400_000);
      if (!read) continue;
      read.text.split(/\r?\n/).forEach((text, index) => {
        if (hits.length >= max) return;
        const matched = pattern ? pattern.test(text) : (options.caseSensitive ? text : text.toLowerCase()).includes(needle);
        if (matched) hits.push({ path: rel, line: index + 1, text: text.slice(0, 300) });
      });
    }
    return hits;
  }

  async gitState(): Promise<GitState> {
    if (!(await this.isGit())) return { changed: [], untracked: [] };
    const [status, head, branch] = await Promise.all([
      this.git(['status', '--porcelain=v1', '-z'], 30_000),
      this.git(['rev-parse', 'HEAD'], 5_000),
      this.git(['rev-parse', '--abbrev-ref', 'HEAD'], 5_000),
    ]);
    const changed: string[] = [];
    const untracked: string[] = [];
    const parts = status.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2);
      const file = toPosix(entry.slice(3));
      if (code === '??') untracked.push(file); else changed.push(file);
      if (code[0] === 'R' || code[0] === 'C') i++; // rename: skip the original path entry
    }
    return { head: head.stdout.trim() || undefined, branch: branch.stdout.trim() || undefined, changed, untracked };
  }
}
