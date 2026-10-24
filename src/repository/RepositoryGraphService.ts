/**
 * Per-workspace owner of the repository graph in the extension host.
 *
 * - Never blocks first use: indexing starts after a short delay, in time-sliced background batches. Repository questions
 *   work from the first second through RepoFastPath's own host retrieval; the graph only *adds* a ranked source once it
 *   has parsed enough (`graphUsable`).
 * - Restart-safe: a bounded on-disk snapshot lets the next window start incrementally.
 * - Incremental: file-system changes and saves re-read only the files that changed.
 * - Optional: disabled with `ollama-agent.repositoryGraph.enabled = false`.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { Config } from '../config/Config';
import { Logger } from '../services/Logger';
import { JsonlGraphStore } from '../../core/platform/repo/graphStore';
import { RepositoryGraphIndexer, type IndexCoverage } from '../../core/platform/repo/graphIndexer';
import { RepositoryContextEngine } from '../../core/platform/repo/evidence';
import { DEFAULT_IGNORED_DIRS, toPosix } from '../../core/platform/repo/workspaceHost';
import { RecentFilesTracker, VSCodeWorkspaceHost } from './VSCodeWorkspaceHost';
import { tsAstExtractor } from './TsAstExtractor';
import { registerCapability } from '../onboarding/CapabilityRegistry';

export interface GraphServiceStats {
  enabled: boolean;
  phase: IndexCoverage['phase'] | 'disabled';
  files: number;
  indexedFiles: number;
  symbols: number;
  coverage: number;
  truncated: boolean;
}

export interface RankPlan { identifiers: readonly string[]; keywords: readonly string[] }

const changeEmitter = new vscode.EventEmitter<GraphServiceStats>();
/** Fires on indexing progress and completion, for Setup's capability row. */
export const onDidChangeRepositoryGraph = changeEmitter.event;

export class RepositoryGraphService implements vscode.Disposable {
  private static readonly instances = new Map<string, RepositoryGraphService>();
  private static latest?: RepositoryGraphService;

  static forWorkspace(context: vscode.ExtensionContext, root: string): RepositoryGraphService {
    const key = path.resolve(root).toLowerCase();
    let service = this.instances.get(key);
    if (!service) {
      service = new RepositoryGraphService(context, root);
      this.instances.set(key, service);
      context.subscriptions?.push(service);
    }
    this.latest = service;
    return service;
  }

  /** The most recently created service (the active workspace), if any. */
  static current(): RepositoryGraphService | undefined { return this.latest; }

  get workspaceRoot(): string { return this.root; }
  readonly host: VSCodeWorkspaceHost;
  readonly indexer: RepositoryGraphIndexer;
  readonly engine: RepositoryContextEngine;
  private readonly recent: RecentFilesTracker;
  private readonly changed = new Set<string>();
  private flushTimer?: ReturnType<typeof setTimeout>;
  private startTimer?: ReturnType<typeof setTimeout>;
  private watcher?: vscode.FileSystemWatcher;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(context: vscode.ExtensionContext, private readonly root: string) {
    this.recent = new RecentFilesTracker(root);
    this.host = new VSCodeWorkspaceHost(root, this.recent);
    const storage = context.globalStorageUri?.fsPath;
    this.indexer = new RepositoryGraphIndexer(this.host, {
      maxFiles: Config.getRepositoryGraphMaxFiles(),
      extractor: tsAstExtractor,
      ...(storage ? { store: new JsonlGraphStore(path.join(storage, 'repo-graph')) } : {}),
      onProgress: () => changeEmitter.fire(this.stats()),
    });
    this.engine = new RepositoryContextEngine(this.host, this.indexer);
    this.disposables.push(registerCapability('repository-graph', () => this.capabilityRow()));
  }

  /** Setup's "Repository Intelligence" row: only what the index actually knows right now. */
  capabilityRow(): { name: string; status: 'ok' | 'off' | 'warn'; detail: string } {
    const stats = this.stats();
    const compact = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}K` : String(n));
    if (!stats.enabled) return { name: 'Repository Intelligence', status: 'off', detail: 'Graph indexing is turned off' };
    if (stats.phase === 'ready') return { name: 'Repository Intelligence', status: 'ok', detail: `Graph ready · ${compact(stats.symbols)} symbols indexed${stats.truncated ? ' (partial: file limit reached)' : ''}` };
    if (stats.phase === 'idle') return { name: 'Repository Intelligence', status: 'warn', detail: 'Graph will index in the background' };
    if (stats.phase === 'error' || stats.phase === 'cancelled') return { name: 'Repository Intelligence', status: 'warn', detail: 'Graph unavailable; repository questions use direct search' };
    return { name: 'Repository Intelligence', status: 'warn', detail: `Indexing in the background · ${Math.round(stats.coverage * 100)}% (questions already work)` };
  }

  /** Schedules background indexing; returns immediately. Idempotent. */
  start(delayMs = 2_500): void {
    if (this.disposed || this.startTimer || !Config.getRepositoryGraphEnabled()) return;
    this.startTimer = setTimeout(() => {
      void this.indexer.start().then(() => {
        const stats = this.stats();
        Logger.info(`[RepoGraph] ready: ${stats.files} files, ${stats.symbols} symbols (${Math.round(stats.coverage * 100)}% parsed)`);
        changeEmitter.fire(stats);
      });
      this.watch();
    }, delayMs);
  }

  private watch(): void {
    try {
      const pattern = new vscode.RelativePattern(this.root, '**/*');
      this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
      for (const event of [this.watcher.onDidChange, this.watcher.onDidCreate, this.watcher.onDidDelete]) {
        this.disposables.push(event(uri => this.notifyChanged([uri.fsPath])));
      }
      this.disposables.push(this.watcher);
    } catch {
      // No watcher support (or a host without it): saves below still keep the graph fresh.
    }
    const saves = vscode.workspace.onDidSaveTextDocument?.(doc => this.notifyChanged([doc.uri.fsPath]));
    if (saves) this.disposables.push(saves);
  }

  /** Queues changed absolute paths; a burst (git checkout, formatter) becomes one incremental update. */
  notifyChanged(absolutePaths: readonly string[], debounceMs = 600): void {
    if (this.disposed) return;
    for (const abs of absolutePaths) {
      const rel = toPosix(path.relative(this.root, abs));
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (rel.split('/').some(segment => DEFAULT_IGNORED_DIRS.has(segment))) continue;
      this.changed.add(rel);
    }
    if (this.changed.size === 0) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flush(), debounceMs);
  }

  /**
   * Applies queued file changes now instead of waiting out the debounce. Navigation tools call this first, so a query
   * issued right after an edit, rename or branch switch never sees the pre-change graph.
   */
  async refresh(): Promise<void> {
    clearTimeout(this.flushTimer);
    await this.flush();
  }

  private async flush(): Promise<void> {
    if (this.disposed || this.changed.size === 0) return;
    const batch = [...this.changed];
    this.changed.clear();
    // Wait for the first full pass: updating a half-built graph would race the indexer and gain nothing.
    await this.indexer.ready();
    try { await this.indexer.updatePaths(batch); } catch (error) { Logger.warn(`[RepoGraph] incremental update failed: ${error instanceof Error ? error.message : String(error)}`); }
    changeEmitter.fire(this.stats());
  }

  stats(): GraphServiceStats {
    if (!Config.getRepositoryGraphEnabled()) return { enabled: false, phase: 'disabled', files: 0, indexedFiles: 0, symbols: 0, coverage: 0, truncated: false };
    const coverage = this.indexer.coverage();
    const graph = this.indexer.graph.stats();
    return { enabled: true, phase: coverage.phase, files: graph.files, indexedFiles: graph.indexedFiles, symbols: graph.symbols, coverage: coverage.fraction, truncated: coverage.truncated };
  }

  /**
   * One more ranked list for RepoFastPath's reciprocal-rank fusion: definers of the named identifiers first, then files the
   * keywords select by path/symbol/centrality, then importers of the definers. Empty while the graph is not usable yet.
   * Ranking only: RepoFastPath still reads exact source lines before anything reaches the model.
   */
  rankForPlan(plan: RankPlan): string[] {
    if (!Config.getRepositoryGraphEnabled()) return [];
    return this.engine.rankPaths(plan);
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.startTimer);
    clearTimeout(this.flushTimer);
    this.indexer.cancel();
    for (const d of this.disposables) { try { d.dispose(); } catch { /* ignore */ } }
    this.recent.dispose();
    for (const [key, value] of RepositoryGraphService.instances) if (value === this) RepositoryGraphService.instances.delete(key);
    if (RepositoryGraphService.latest === this) RepositoryGraphService.latest = undefined;
  }
}
