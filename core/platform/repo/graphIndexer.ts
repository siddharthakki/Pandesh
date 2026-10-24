/**
 * Progressive, incremental, bounded repository indexer.
 *
 * Indexing never blocks first use: `start()` registers paths immediately (cold discovery), then reads file contents in
 * time-sliced batches, most relevant files first (open / recent / git-changed, manifests, then source by depth).
 * Queries are valid at every moment with whatever is indexed so far, and `coverage()` says how much that is.
 *
 * Incremental: a persisted snapshot is restored first, and a file is only re-read when its size or mtime changed.
 */
import { createHash } from 'node:crypto';
import { RepositoryGraph, type PackageInfo, type PathMapping } from './repositoryGraph';
import { roleOf, type ExtractorFn, type FileRole } from './extractors';
import type { GraphStore } from './graphStore';
import type { WorkspaceHost, WorkspaceIdentity } from './workspaceHost';

export type IndexPhase = 'idle' | 'discovering' | 'indexing' | 'ready' | 'cancelled' | 'error';

export interface IndexCoverage {
  phase: IndexPhase;
  /** Files the graph knows by path. */
  totalFiles: number;
  /** Code files (source + test) that are worth parsing. */
  eligible: number;
  /** Eligible files already parsed (or restored from the snapshot). */
  indexed: number;
  fraction: number;
  truncated: boolean;
}

export interface IndexerOptions {
  /** Upper bound on files tracked (memory bound). Excess low-priority files are not tracked and `truncated` is reported. */
  maxFiles?: number;
  maxFileBytes?: number;
  concurrency?: number;
  /** Wall-clock slice before yielding to the event loop. */
  sliceMs?: number;
  extractor?: ExtractorFn;
  store?: GraphStore;
  persistEveryMs?: number;
  onProgress?: (coverage: IndexCoverage) => void;
  /** Time source, injectable for tests. */
  now?: () => number;
}

export interface IndexTimings {
  discoveryMs?: number;
  restoreMs?: number;
  firstUsableMs?: number;
  indexMs?: number;
  persistMs?: number;
  restored: number;
  parsed: number;
  skippedUnchanged: number;
}

const SKIP_CONTENT_ROLES: ReadonlySet<FileRole> = new Set(['doc', 'config', 'generated', 'other']);

const yieldNow = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

function priorityOf(path: string, role: FileRole): number {
  const depth = path.split('/').length;
  return (role === 'manifest' ? 0 : role === 'source' ? 100 : 400) + depth * 3 + (/(^|\/)(src|lib|app|core|packages)\//.test(path) ? -20 : 0);
}

export class RepositoryGraphIndexer {
  readonly graph = new RepositoryGraph();
  readonly timings: IndexTimings = { restored: 0, parsed: 0, skippedUnchanged: 0 };
  private phase: IndexPhase = 'idle';
  private truncated = false;
  private eligible = 0;
  private indexed = 0;
  private identity?: WorkspaceIdentity;
  private abort = new AbortController();
  private runPromise?: Promise<void>;
  private lastPersist = 0;
  private startedAt = 0;
  private readonly now: () => number;

  constructor(private readonly host: WorkspaceHost, private readonly options: IndexerOptions = {}) {
    this.now = options.now ?? (() => performance.now());
  }

  coverage(): IndexCoverage {
    return {
      phase: this.phase,
      totalFiles: this.graph.fileCount(),
      eligible: this.eligible,
      indexed: this.indexed,
      fraction: this.eligible === 0 ? (this.phase === 'ready' ? 1 : 0) : Math.min(1, this.indexed / this.eligible),
      truncated: this.truncated,
    };
  }

  isReady(): boolean { return this.phase === 'ready'; }
  ready(): Promise<void> { return this.runPromise ?? Promise.resolve(); }
  cancel(): void { this.abort.abort(); }

  /** Starts (or returns the in-flight) index run. Never rejects: failures set `phase = 'error'`. */
  start(): Promise<void> {
    this.runPromise ??= this.run().catch(() => { this.phase = 'error'; });
    return this.runPromise;
  }

  private progress(): void { this.options.onProgress?.(this.coverage()); }

  private async run(): Promise<void> {
    const signal = this.abort.signal;
    this.startedAt = this.now();
    this.phase = 'discovering';
    this.identity = await this.host.identity();
    const store = this.options.store;

    // 1. Restore the persisted snapshot (incremental start).
    const restoreStart = this.now();
    const restoredPaths = new Set<string>();
    if (store) {
      const meta = await store.load(this.identity.id, node => { this.graph.restore(node, false); restoredPaths.add(node.path); this.timings.restored++; });
      void meta;
    }
    this.timings.restoreMs = this.now() - restoreStart;

    // 2. Cold discovery: paths only, no file I/O. Usable immediately.
    const discoveryStart = this.now();
    let paths = await this.host.listPaths(signal);
    this.timings.discoveryMs = this.now() - discoveryStart;
    const maxFiles = this.options.maxFiles ?? 200_000;
    if (paths.length > maxFiles) {
      this.truncated = true;
      paths = paths
        .map(path => ({ path, p: priorityOf(path, roleOf(path)) }))
        .sort((a, b) => a.p - b.p)
        .slice(0, maxFiles)
        .map(entry => entry.path);
    }
    const present = new Set(paths);
    for (const known of [...this.graph.files.keys()]) if (!present.has(known)) this.graph.remove(known);
    for (const path of paths) this.graph.addPath(path);
    this.timings.firstUsableMs = this.now() - this.startedAt;
    this.recount();
    this.progress();
    if (signal.aborted) { this.phase = 'cancelled'; return; }

    // 3. Packages from manifests (small reads), before content indexing so every file gets its package.
    this.phase = 'indexing';
    await this.loadPackages(paths, signal);
    await this.loadPathMappings(paths, signal);
    // Restored files were attached without resolving imports (the file set was incomplete); resolve once, now.
    if (this.timings.restored > 0) this.graph.resolveAllImports();

    // 4. Content indexing in priority order, time-sliced.
    const queue = await this.buildQueue(paths);
    const indexStart = this.now();
    await this.drain(queue, signal);
    this.timings.indexMs = this.now() - indexStart;
    if (signal.aborted) { this.phase = 'cancelled'; return; }
    this.recount();
    this.phase = 'ready';
    this.progress();
    await this.persist(true);
  }

  private recount(): void {
    let eligible = 0;
    let indexed = 0;
    for (const node of this.graph.files.values()) {
      if (node.role === 'source' || node.role === 'test') {
        if (node.language === 'other' || node.language === 'markdown') continue;
        eligible++;
        if (node.indexed) indexed++;
      }
    }
    this.eligible = eligible;
    this.indexed = indexed;
  }

  private async buildQueue(paths: string[]): Promise<string[]> {
    const priority = new Map<string, number>();
    const boost = (list: readonly string[] | undefined, amount: number): void => { for (const p of list ?? []) priority.set(p, (priority.get(p) ?? 0) - amount); };
    try { boost(await this.host.openFiles?.(), 1000); } catch { /* optional */ }
    try { boost(await this.host.recentFiles?.(), 800); } catch { /* optional */ }
    try {
      const git = await this.host.gitState?.();
      boost(git?.changed, 600);
      boost(git?.untracked, 500);
    } catch { /* optional */ }
    const candidates: Array<{ path: string; p: number }> = [];
    for (const path of paths) {
      const node = this.graph.get(path);
      if (!node) continue;
      if (node.role === 'doc' || node.role === 'generated' || node.role === 'other') continue;
      if (node.role === 'config') continue;
      if (node.role !== 'manifest' && (node.language === 'other' || node.language === 'markdown' || node.language === 'json')) continue;
      candidates.push({ path, p: priorityOf(path, node.role) + (priority.get(path) ?? 0) });
    }
    return candidates.sort((a, b) => a.p - b.p || a.path.localeCompare(b.path)).map(entry => entry.path);
  }

  private async loadPackages(paths: string[], signal: AbortSignal): Promise<void> {
    const packages: PackageInfo[] = [];
    for (const path of paths) {
      if (signal.aborted) return;
      const node = this.graph.get(path);
      if (node?.role !== 'manifest') continue;
      const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      const kind: PackageInfo['kind'] = name === 'package.json' ? 'npm' : name === 'pyproject.toml' || name === 'setup.py' ? 'python' : name === 'go.mod' ? 'go'
        : name === 'cargo.toml' ? 'rust' : name === 'pom.xml' ? 'maven' : name.startsWith('build.gradle') ? 'gradle' : name.endsWith('.csproj') ? 'dotnet' : name === 'cmakelists.txt' ? 'cmake' : 'other';
      if (kind === 'other') continue;
      const info: PackageInfo = { dir, manifest: path, kind };
      if (kind === 'npm') {
        const read = await this.host.readFile(path, undefined, 200_000);
        if (read) {
          try {
            const json = JSON.parse(read.text) as { name?: string; main?: string; module?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
            if (typeof json.name === 'string') info.name = json.name;
            if (typeof (json.main ?? json.module) === 'string') info.main = String(json.main ?? json.module);
            info.deps = Object.keys({ ...json.dependencies, ...json.devDependencies }).slice(0, 200);
          } catch { /* manifest stays nameless */ }
        }
      }
      packages.push(info);
    }
    this.graph.setPackages(packages);
  }

  /** tsconfig/jsconfig `baseUrl` and `paths` (following `extends`), so bare imports like "@app/x" or "vs/base/y" resolve. */
  private async loadPathMappings(paths: string[], signal: AbortSignal): Promise<void> {
    const configs = paths.filter(p => /(^|\/)(ts|js)config(\.[\w-]+)?\.json$/i.test(p)).slice(0, 400);
    const cache = new Map<string, { baseUrl?: string; baseDir?: string; paths?: Record<string, string[]> } | undefined>();
    const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
    const load = async (rel: string, depth: number): Promise<{ baseUrl?: string; baseDir?: string; paths?: Record<string, string[]> } | undefined> => {
      if (cache.has(rel)) return cache.get(rel);
      cache.set(rel, undefined);
      const read = await this.host.readFile(rel, undefined, 200_000);
      if (!read) return undefined;
      let json: { extends?: string | string[]; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      try { json = JSON.parse(strip(read.text)); } catch { return undefined; }
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      let result: { baseUrl?: string; baseDir?: string; paths?: Record<string, string[]> } = {};
      const parent = Array.isArray(json.extends) ? json.extends[0] : json.extends;
      if (parent && parent.startsWith('.') && depth < 4) {
        const joined = [...dir.split('/').filter(Boolean)];
        for (const seg of parent.split('/')) { if (seg === '..') joined.pop(); else if (seg !== '.' && seg) joined.push(seg); }
        const parentPath = joined.join('/').endsWith('.json') ? joined.join('/') : `${joined.join('/')}.json`;
        result = { ...(await load(parentPath, depth + 1)) };
      }
      const opts = json.compilerOptions;
      if (opts?.baseUrl !== undefined) { result.baseUrl = opts.baseUrl; result.baseDir = dir; }
      if (opts?.paths) { result.paths = opts.paths; result.baseDir = result.baseDir ?? dir; if (opts.baseUrl === undefined && result.baseUrl === undefined) result.baseUrl = '.'; }
      cache.set(rel, result);
      return result;
    };
    const mappings: PathMapping[] = [];
    for (const rel of configs) {
      if (signal.aborted) return;
      const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      const resolved = await load(rel, 0);
      if (!resolved || (resolved.baseUrl === undefined && !resolved.paths)) continue;
      // baseUrl is relative to the config that declared it; express it relative to this config's directory.
      let baseUrl = resolved.baseUrl ?? '.';
      if (resolved.baseDir !== undefined && resolved.baseDir !== dir) {
        const from = dir.split('/').filter(Boolean);
        const to = [...resolved.baseDir.split('/').filter(Boolean)];
        for (const seg of baseUrl.split('/')) { if (seg === '..') to.pop(); else if (seg !== '.' && seg) to.push(seg); }
        let common = 0;
        while (common < from.length && common < to.length && from[common] === to[common]) common++;
        baseUrl = [...from.slice(common).map(() => '..'), ...to.slice(common)].join('/') || '.';
      }
      mappings.push({ dir, baseUrl, ...(resolved.paths ? { paths: resolved.paths } : {}) });
    }
    this.graph.setPathMappings(mappings);
  }

  private async drain(queue: string[], signal: AbortSignal): Promise<void> {
    const concurrency = Math.max(1, this.options.concurrency ?? 8);
    const sliceMs = this.options.sliceMs ?? 25;
    const maxBytes = this.options.maxFileBytes ?? 300_000;
    let cursor = 0;
    let sliceStart = this.now();
    let sinceProgress = 0;
    const worker = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor++;
        if (index >= queue.length) return;
        await this.indexOne(queue[index], maxBytes);
        if (++sinceProgress >= 500) { sinceProgress = 0; this.recount(); this.progress(); void this.persist(false); }
        if (this.now() - sliceStart >= sliceMs) { await yieldNow(); sliceStart = this.now(); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, worker));
  }

  /** Reads one file if it changed since the snapshot; returns true when it was (re)parsed. */
  private async indexOne(path: string, maxBytes: number): Promise<boolean> {
    const stat = await this.host.stat(path);
    if (!stat) { this.graph.remove(path); return false; }
    const known = this.graph.get(path);
    if (known?.indexed && known.size === stat.size && known.mtimeMs === stat.mtimeMs) { this.timings.skippedUnchanged++; return false; }
    if (stat.size > maxBytes * 4) {
      // Too large to parse usefully: tracked by path only, never silently dropped.
      if (known) { known.size = stat.size; known.mtimeMs = stat.mtimeMs; }
      return false;
    }
    const read = await this.host.readFile(path, undefined, maxBytes);
    if (!read) return false;
    this.graph.upsert(path, { size: stat.size, mtimeMs: stat.mtimeMs, hash: createHash('sha1').update(read.text).digest('hex'), text: read.text }, this.options.extractor);
    this.timings.parsed++;
    return true;
  }

  /** Incremental update after files changed on disk (or a save): re-reads only what actually changed. */
  async updatePaths(paths: readonly string[]): Promise<{ updated: number; removed: number }> {
    let updated = 0;
    let removed = 0;
    const maxBytes = this.options.maxFileBytes ?? 300_000;
    for (const raw of paths) {
      const path = raw.replace(/\\/g, '/');
      const stat = await this.host.stat(path);
      if (!stat) { if (this.graph.has(path)) { this.graph.remove(path); removed++; } continue; }
      if (!this.graph.has(path)) this.graph.addPath(path, stat.size, stat.mtimeMs);
      const node = this.graph.get(path)!;
      if (node.role === 'doc' || node.role === 'config' || node.role === 'generated' || node.role === 'other') continue;
      if (await this.indexOne(path, maxBytes)) updated++;
    }
    this.recount();
    if (updated + removed > 0) void this.persist(false);
    return { updated, removed };
  }

  private async persist(force: boolean): Promise<void> {
    const store = this.options.store;
    if (!store || !this.identity) return;
    const interval = this.options.persistEveryMs ?? 30_000;
    const nowMs = Date.now();
    if (!force && nowMs - this.lastPersist < interval) return;
    this.lastPersist = nowMs;
    const start = this.now();
    try {
      await store.save({ id: this.identity.id, head: this.identity.head }, this.graph);
      this.timings.persistMs = this.now() - start;
    } catch { /* persistence is an optimisation; the in-memory graph is still valid */ }
  }
}
