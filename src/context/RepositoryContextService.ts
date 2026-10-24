import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AgentMode } from '../config/ConfigSchema';
import { extractReferencedSymbols } from '../orchestration/ConversationContinuity';
import { RepositoryIndex } from './RepositoryIndex';
import { ContextSelector } from './ContextSelector';
import {
  ContextHint,
  ContextRole,
  ContextSelectionRequest,
  RepositoryIntelligenceStatus,
  RepositoryContextResult,
} from './RepositoryTypes';

const execFileAsync = promisify(execFile);

// Bounds for the grounding stage in `build()` below: a strong identifier
// candidate may resolve to at most this many files, and the whole stage may
// contribute at most this many files overall, so one common token can never
// flood the candidate list or crowd out generic ranking's own budget.
const MAX_FILES_PER_GROUNDING_CANDIDATE = 2;
const MAX_GROUNDED_FILES = 6;

export interface RepositoryContextBuildRequest {
  query: string;
  mode: AgentMode;
  role?: ContextRole;
  model: string;
  providerType?: string;
  hints?: ContextHint;
  tokenBudget?: number;
  /** Model-aware plan (see RepositoryContextBudget); bounds the package in characters. */
  budget?: ContextSelectionRequest['budget'];
  forceIndexRefresh?: boolean;
  overviewIntent?: ContextSelectionRequest['overviewIntent'];
}

function normalize(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isolatedStoragePath(workspaceRoot: string): string | undefined {
  const overrideRoot = process.env.OLLAMA_AGENT_REPOSITORY_INDEX_ROOT?.trim();
  if (!overrideRoot) return undefined;
  const workspaceIdentity = crypto
    .createHash('sha256')
    .update(path.resolve(workspaceRoot))
    .digest('hex')
    .slice(0, 16);
  return path.join(path.resolve(overrideRoot), workspaceIdentity, 'repository-intelligence.sqlite');
}

export class RepositoryContextService {
  private readonly index: RepositoryIndex;
  private readonly selector: ContextSelector;
  private cachedIndex?: { force: boolean; snapshot: Promise<RepositoryContextResult['index']> };
  private cachedChangedFiles?: Promise<string[]>;

  constructor(private readonly workspaceRoot: string) {
    const storagePath = isolatedStoragePath(workspaceRoot);
    this.index = new RepositoryIndex(workspaceRoot, storagePath ? { storagePath } : {});
    this.selector = new ContextSelector(workspaceRoot);
  }

  async build(request: RepositoryContextBuildRequest): Promise<RepositoryContextResult> {
    const force = Boolean(request.forceIndexRefresh);
    const index = await this.buildIndex(force);
    const recentFiles = index.files
      .filter(file => !file.isGenerated)
      .sort((left, right) => right.modifiedAt - left.modifiedAt)
      .slice(0, 20)
      .map(file => file.path);
    const changedFiles = request.hints?.changedFiles ?? await this.changedFiles();
    const groundedFiles = await this.groundStrongIdentifiers(request.query, index);
    // A grounded file must survive the selector's own token-budget-driven
    // inclusion even when several distinct grounded files are large (e.g. an
    // identifier and an unrelated error classification defined in different
    // files). Widening this intermediate token budget never enlarges the
    // emitted package past `request.budget`'s character bound (or the hard
    // ceiling), which the selector enforces independently of it.
    const tokenBudget = groundedFiles.length > 0 && request.tokenBudget !== undefined
      ? Math.max(request.tokenBudget, Math.min(12000, groundedFiles.length * 3000))
      : request.tokenBudget;

    return this.selector.select(index, {
      query: request.query,
      role: request.role ?? this.roleForMode(request.mode),
      model: request.model,
      providerType: request.providerType,
      tokenBudget,
      budget: request.budget,
      overviewIntent: request.overviewIntent,
      hints: {
        ...request.hints,
        explicitFiles: [...new Set([
          ...(request.hints?.explicitFiles ?? []).map(normalize),
          ...groundedFiles,
        ])],
        recentFiles: [...new Set([
          ...(request.hints?.recentFiles ?? []),
          ...recentFiles,
        ].map(normalize))],
        changedFiles: [...new Set(changedFiles.map(normalize))],
      },
    });
  }

  /**
   * Finds files defining or literally containing the high-confidence
   * identifier/error-code candidates named in `query` (e.g. `approveDelivery`,
   * `workspace_delivery_conflict`), so a coding/investigation request that
   * names a real repository symbol always has that symbol's authoritative
   * file available before generic relevance ranking fills the remaining
   * context budget — otherwise a hub file with only incidental word overlap
   * can win purely on volume and starve the file the request actually named.
   *
   * Deliberately narrow, same spirit as `findKnownSymbols`:
   * `extractReferencedSymbols` only yields camelCase/PascalCase/snake_case-
   * shaped tokens, so an ordinary request ("fix the login bug") contributes
   * nothing here and generic ranking is left exactly as it was. A candidate
   * that matches nothing real — including a hallucinated identifier —
   * likewise contributes nothing; this stage only ever narrows toward files
   * that truly contain the named token, never invents one.
   *
   * Two passes, both over real repository bytes, never a new index:
   *  1. exact match against already-indexed declared symbols (in-memory, no
   *     extra I/O) — the authoritative defining file for a real identifier.
   *  2. for candidates with no declared-symbol match — a string-literal error
   *     classification is never a declared symbol — a literal `git grep` over
   *     tracked files, anywhere in the repository (not just `src/**`).
   * A non-git workspace or a git failure degrades that second pass to no
   * grounding for the affected candidate, the same way `gitChangedFiles()`
   * degrades to `[]` above.
   */
  private async groundStrongIdentifiers(
    query: string,
    index: RepositoryContextResult['index'],
  ): Promise<string[]> {
    const candidates = extractReferencedSymbols(query);
    if (candidates.length === 0) return [];

    const grounded: string[] = [];
    const unresolved: string[] = [];
    for (const candidate of candidates) {
      const defining = this.filesDefiningSymbol(candidate, index);
      if (defining.length > 0) {
        grounded.push(...defining);
      } else {
        unresolved.push(candidate);
      }
    }
    if (unresolved.length > 0) {
      grounded.push(...await this.grepExactOccurrences(unresolved));
    }
    return [...new Set(grounded)].slice(0, MAX_GROUNDED_FILES);
  }

  private filesDefiningSymbol(candidate: string, index: RepositoryContextResult['index']): string[] {
    const wanted = candidate.toLowerCase();
    const matches: string[] = [];
    for (const file of index.files) {
      if (file.deleted || file.stale) continue;
      if (file.symbols.some(symbol => symbol.name.toLowerCase() === wanted)) {
        matches.push(file.path);
        if (matches.length >= MAX_FILES_PER_GROUNDING_CANDIDATE) break;
      }
    }
    return matches;
  }

  private async grepExactOccurrences(candidates: readonly string[]): Promise<string[]> {
    const found: string[] = [];
    for (const term of candidates) {
      try {
        const { stdout } = await execFileAsync(
          'git',
          ['grep', '--fixed-strings', '--ignore-case', '--name-only', '-e', term, '--', '.'],
          { cwd: this.workspaceRoot, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
        );
        const files = stdout
          .split(/\r?\n/)
          .map(line => normalize(line.trim()))
          .filter(Boolean);
        // Authoritative source ahead of test-shaped files; CodingPlanner (and
        // the selector's own graph expansion) already pull in a relevant
        // file's linked tests separately, so this pass need not duplicate it.
        files.sort((left, right) => Number(/\.(test|spec)\./.test(left)) - Number(/\.(test|spec)\./.test(right)));
        found.push(...files.slice(0, MAX_FILES_PER_GROUNDING_CANDIDATE));
      } catch {
        // Not a git repository, git unavailable, or no literal match for this
        // term in the tracked tree — degrade to no grounding for it.
      }
    }
    return found;
  }

  private buildIndex(force: boolean): Promise<RepositoryContextResult['index']> {
    if (!force && this.cachedIndex && !this.cachedIndex.force) {
      return this.cachedIndex.snapshot;
    }
    const snapshot = this.index.build(force);
    const entry = { force, snapshot };
    this.cachedIndex = entry;
    // A failed build must not be remembered: a single transient failure (a busy index store, a cancelled walk) would
    // otherwise be replayed to every later caller for the life of this service and wedge repository intelligence.
    snapshot.catch(() => { if (this.cachedIndex === entry) this.cachedIndex = undefined; });
    return snapshot;
  }

  private changedFiles(): Promise<string[]> {
    this.cachedChangedFiles ??= this.gitChangedFiles();
    return this.cachedChangedFiles;
  }

  async status(): Promise<RepositoryIntelligenceStatus> {
    const index = await this.index.status();
    return {
      state: index.state,
      identity: index.identity,
      updatedAt: index.updatedAt,
      staleReason: index.staleReason,
      failureCode: index.failureCode,
      statistics: index.statistics,
      selectedFiles: [],
      estimatedTokens: 0,
      omittedCount: 0,
      pins: index.pins,
      exclusions: index.exclusions,
      storage: {
        kind: 'sqlite',
        path: this.index.getStoragePath(),
        sqliteAvailable: this.index.isSqliteAvailable(),
        fts5Available: this.index.isFts5Available(),
      },
    };
  }

  storagePath(): string {
    return this.index.getStoragePath();
  }

  /**
   * Returns which of `candidates` name a symbol that actually exists in this
   * repository's index (exact, case-insensitive match on the symbol name).
   *
   * Deliberately narrow: it answers "is this token a real thing in this
   * repository?" and nothing else. It exists so a natural question like
   * "Why does registerUser accept an empty username?" can be recognised as a
   * repository question by LOOKING THE IDENTIFIER UP rather than by matching
   * yet another hand-maintained keyword list. Reuses the already-built,
   * already-cached index snapshot, so it costs one in-memory scan.
   */
  async findKnownSymbols(candidates: readonly string[]): Promise<string[]> {
    const wanted = new Map<string, string>();
    for (const candidate of candidates.slice(0, 12)) {
      const normalized = String(candidate ?? '').trim();
      if (normalized.length >= 3) wanted.set(normalized.toLowerCase(), normalized);
    }
    if (wanted.size === 0) return [];
    const index = await this.buildIndex(false);
    const found = new Set<string>();
    for (const file of index.files) {
      if (file.deleted) continue;
      for (const symbol of file.symbols) {
        const match = wanted.get(symbol.name.toLowerCase());
        if (match) found.add(match);
      }
      if (found.size === wanted.size) break;
    }
    return [...found];
  }

  async rebuild(): Promise<RepositoryIntelligenceStatus> {
    await this.index.build(true);
    return this.status();
  }

  async reconcileStartup(): Promise<RepositoryIntelligenceStatus> {
    await this.index.reconcileStartup();
    return this.status();
  }

  async updateChangedFiles(paths: string[], signal?: AbortSignal): Promise<RepositoryIntelligenceStatus> {
    await this.index.updateChangedFiles(paths.map(normalize), signal);
    return this.status();
  }

  pause(): void {
    this.index.pause();
  }

  resume(): void {
    this.index.resume();
  }

  async pin(relativePath: string): Promise<RepositoryIntelligenceStatus> {
    await this.index.pin(relativePath);
    return this.status();
  }

  async exclude(relativePath: string): Promise<RepositoryIntelligenceStatus> {
    await this.index.exclude(relativePath);
    return this.status();
  }

  async persist(taskDir: string, result: RepositoryContextResult): Promise<void> {
    await fs.mkdir(taskDir, { recursive: true });
    const destination = path.join(taskDir, 'context-selection.json');
    const temporary = `${destination}.${process.pid}.tmp`;
    const payload = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      selectedFiles: result.files.map(file => ({
        path: file.path,
        score: file.score,
        estimatedTokens: file.estimatedTokens,
        reasons: file.reasons,
        truncated: file.truncated,
      })),
      diagnostics: result.diagnostics,
      repositoryIdentity: result.index.identity,
      indexState: result.index.state,
    };
    try {
      await fs.writeFile(temporary, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(temporary, destination);
    } catch (error) {
      try { await fs.unlink(temporary); } catch { /* best effort */ }
      throw error;
    }
  }

  roleForMode(mode: AgentMode): ContextRole {
    switch (mode) {
      case 'plan': return 'planner';
      case 'agent': return 'implementer';
      case 'ask': return 'reviewer';
      default: return 'general';
    }
  }

  private async gitChangedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync(
        'git',
        ['status', '--porcelain=v1', '--untracked-files=all'],
        { cwd: this.workspaceRoot, timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      return stdout
        .split(/\r?\n/)
        .map(line => line.trimEnd())
        .filter(Boolean)
        .map(line => {
          let candidate = line.slice(3).trim();
          if (candidate.includes(' -> ')) { candidate = candidate.split(' -> ').pop() ?? candidate; }
          if (candidate.startsWith('"') && candidate.endsWith('"')) {
            try { candidate = JSON.parse(candidate) as string; } catch { candidate = candidate.slice(1, -1); }
          }
          return normalize(candidate);
        });
    } catch {
      return [];
    }
  }
}
