import type { RepositoryFileRecord, RepositoryIndexSnapshot } from '../context/RepositoryTypes';
import {
  isArchitecturePath,
  isEntrypointPath,
  isManifestPath,
  noiseReason,
} from '../context/ContextSelector';
import { namedPaths } from '../autonomous/recovery/FailureClassifier';
import type { PackTaskType, RepoCandidate } from './ContextCompiler';
import { scanWorkspaceLite } from './workspaceScan';

/**
 * Structural queries over repository file records, for the Context Compiler.
 *
 * It adds no parser and no store: it reads the records `RepositoryIndex` already
 * produces (symbols, imports, dependencies, linked tests, generated/test/config
 * flags) or, when there is no index, the same records from `scanWorkspaceLite`.
 * Noise, manifest and entrypoint rules are the ones `ContextSelector` uses.
 * Nothing here needs Git; `modifiedAt` stands in for "recently changed".
 */

export interface CandidateRequest {
  /** The objective / subgoal text: names files and symbols the task is about. */
  objective: string;
  /** Failure or validation output; paths and symbols in it implicate files. */
  errorText?: string;
  taskType: PackTaskType;
  explicitFiles?: readonly string[];
  changedFiles?: readonly string[];
  /** Paths the runtime has already shown the model; they are demoted, not hidden. */
  alreadySeen?: readonly string[];
  limit?: number;
}

export type IntelSource = 'index' | 'filesystem' | 'empty';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'fix', 'make', 'fails', 'failing', 'failed',
  'test', 'tests', 'file', 'files', 'code', 'why', 'does', 'not', 'edit', 'yet', 'read', 'please', 'should',
  'when', 'then', 'them', 'they', 'are', 'was', 'have', 'has', 'use', 'using', 'add', 'update', 'change',
  'error', 'errors', 'function', 'method', 'class', 'repository', 'project', 'explain', 'inspect', 'diagnose',
  'expected', 'received', 'assert', 'assertion', 'assertionerror', 'equal', 'undefined', 'null', 'true', 'false',
  'object', 'string', 'number', 'value', 'return', 'const', 'stack', 'trace', 'passed', 'failed', 'expect',
]);

function norm(name: string): string {
  return name.toLowerCase().replace(/[_\-\s]/g, '');
}

function terms(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []) {
    const n = norm(raw);
    if (n.length < 3 || STOPWORDS.has(n)) continue;
    out.add(n);
    // camelCase and PascalCase also match by their words joined ("calculateTotal" ~ "calculate_total")
  }
  return [...out].sort();
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

export class RepositoryIntel {
  private readonly live: RepositoryFileRecord[];
  private readonly index: Map<string, RepositoryFileRecord>;
  private readonly importers = new Map<string, string[]>();
  private readonly symbolIndex = new Map<string, Array<{ path: string; name: string; kind: string; line: number }>>();

  constructor(
    files: readonly RepositoryFileRecord[],
    private readonly options: { pins?: readonly string[]; exclusions?: readonly string[]; truncated?: boolean; source?: IntelSource } = {},
  ) {
    const exclusions = options.exclusions ?? [];
    this.live = files
      .filter(file => !file.deleted && !file.stale)
      .filter(file => !exclusions.some(excluded => file.path === excluded || file.path.startsWith(`${excluded.replace(/\/$/, '')}/`)))
      .filter(file => noiseReason(file) === undefined)
      .sort(byPath);
    this.index = new Map(this.live.map(file => [file.path, file]));
    for (const file of this.live) {
      for (const dependency of file.dependencies) {
        const list = this.importers.get(dependency) ?? [];
        list.push(file.path);
        this.importers.set(dependency, list);
      }
      for (const symbol of file.symbols) {
        const key = norm(symbol.name);
        const list = this.symbolIndex.get(key) ?? [];
        list.push({ path: file.path, name: symbol.name, kind: symbol.kind, line: symbol.line });
        this.symbolIndex.set(key, list);
      }
    }
    for (const list of this.importers.values()) list.sort();
  }

  static fromSnapshot(snapshot: Pick<RepositoryIndexSnapshot, 'files' | 'pins' | 'exclusions' | 'truncated'>): RepositoryIntel {
    return new RepositoryIntel(snapshot.files, { pins: snapshot.pins, exclusions: snapshot.exclusions, truncated: snapshot.truncated, source: 'index' });
  }

  get source(): IntelSource {
    return this.live.length === 0 ? 'empty' : (this.options.source ?? 'index');
  }

  get fileCount(): number {
    return this.live.length;
  }

  has(path: string): boolean {
    return this.index.has(path);
  }

  get(path: string): RepositoryFileRecord | undefined {
    return this.index.get(path);
  }

  // ── structural queries ────────────────────────────────────────────────────

  entrypoints(): string[] {
    return this.live.filter(file => !file.isTest && isEntrypointPath(file.path)).map(file => file.path);
  }

  manifests(): string[] {
    return this.live.filter(file => isManifestPath(file.path)).map(file => file.path);
  }

  configs(): string[] {
    return this.live.filter(file => file.isConfig && !isManifestPath(file.path)).map(file => file.path);
  }

  /** Definitions of a symbol name (case/underscore-insensitive): where it is declared. */
  definitionsOf(name: string): Array<{ path: string; name: string; kind: string; line: number }> {
    return [...(this.symbolIndex.get(norm(name)) ?? [])];
  }

  dependenciesOf(path: string): string[] {
    return [...(this.index.get(path)?.dependencies ?? [])].sort();
  }

  /** Files that import `path`: its callers/consumers. */
  referencesTo(path: string): string[] {
    return [...(this.importers.get(path) ?? [])];
  }

  /** Tests linked by naming plus tests that import the file. */
  testsFor(path: string): string[] {
    const linked = this.index.get(path)?.linkedTests ?? [];
    const importing = this.referencesTo(path).filter(candidate => this.index.get(candidate)?.isTest);
    return [...new Set([...linked, ...importing])].filter(test => this.index.has(test)).sort();
  }

  /** Every indexed test file. */
  testPaths(): string[] {
    return this.live.filter(file => file.isTest).map(file => file.path);
  }

  recentlyChanged(limit = 5): string[] {
    return [...this.live]
      .filter(file => !file.isGenerated)
      .sort((a, b) => b.modifiedAt - a.modifiedAt || byPath(a, b))
      .slice(0, limit)
      .map(file => file.path);
  }

  /** Resolves a path an error message printed (maybe absolute or relative to somewhere else) to a known file. */
  resolvePath(printed: string): string | undefined {
    const candidate = printed.replace(/\\/g, '/').replace(/^\.\//, '');
    if (this.index.has(candidate)) return candidate;
    const suffixMatches = this.live.filter(file => candidate.endsWith(`/${file.path}`) || file.path.endsWith(`/${candidate}`));
    if (suffixMatches.length === 1) return suffixMatches[0].path;
    if (suffixMatches.length > 1) {
      // Prefer the longest overlap, then the shortest path: deterministic.
      return [...suffixMatches].sort((a, b) => b.path.length - a.path.length || byPath(a, b))[0].path;
    }
    return undefined;
  }

  /** Files an error output implicates: printed paths (with line numbers) and symbols it names. */
  implicatedBy(errorText: string): Array<{ path: string; lines: Array<[number, number]>; symbols: string[]; via: 'path' | 'symbol' }> {
    const found = new Map<string, { path: string; lines: Array<[number, number]>; symbols: string[]; via: 'path' | 'symbol' }>();
    const note = (path: string, via: 'path' | 'symbol', line?: number, symbol?: string): void => {
      const entry = found.get(path) ?? { path, lines: [], symbols: [], via };
      if (line !== undefined) entry.lines.push([line, line]);
      if (symbol && !entry.symbols.includes(symbol)) entry.symbols.push(symbol);
      if (via === 'path') entry.via = 'path';
      found.set(path, entry);
    };
    const withLines = /((?:[A-Za-z]:)?[\w@.\\/-]+\.[A-Za-z0-9]{1,8}):(\d+)(?::\d+)?/g;
    for (const match of errorText.matchAll(withLines)) {
      const resolved = this.resolvePath(match[1]);
      if (resolved) note(resolved, 'path', Number(match[2]));
    }
    for (const printed of namedPaths(errorText)) {
      const resolved = this.resolvePath(printed);
      if (resolved) note(resolved, 'path');
    }
    for (const term of terms(errorText)) {
      const definitions = this.symbolIndex.get(term);
      if (!definitions || definitions.length > 3) continue; // ambiguous names implicate nothing
      for (const definition of definitions) note(definition.path, 'symbol', undefined, definition.name);
    }
    return [...found.values()].sort((a, b) => (a.via === b.via ? byPath(a, b) : a.via === 'path' ? -1 : 1));
  }

  /** A few plain lines describing the workspace, for the pack's repository section. */
  architectureSummary(): string[] {
    if (this.live.length === 0) return ['The workspace has no indexable files (empty or not a project folder).'];
    const languages = new Map<string, number>();
    const topLevel = new Map<string, number>();
    let tests = 0;
    for (const file of this.live) {
      if (file.language && file.language !== 'text') languages.set(file.language, (languages.get(file.language) ?? 0) + 1);
      const first = file.path.includes('/') ? file.path.split('/')[0] : '.';
      topLevel.set(first, (topLevel.get(first) ?? 0) + 1);
      if (file.isTest) tests += 1;
    }
    const top = (map: Map<string, number>, n: number): string => [...map.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, n)
      .map(([name, count]) => `${name} (${count})`)
      .join(', ');
    const lines = [
      `${this.live.length} files${this.options.truncated ? ' (inventory truncated)' : ''}; languages: ${top(languages, 5) || 'none detected'}`,
      `top-level: ${top(topLevel, 8)}`,
    ];
    const entrypoints = this.entrypoints().slice(0, 6);
    if (entrypoints.length) lines.push(`entrypoints: ${entrypoints.join(', ')}`);
    const manifests = this.manifests().slice(0, 6);
    if (manifests.length) lines.push(`manifests: ${manifests.join(', ')}`);
    if (tests > 0) lines.push(`${tests} test file(s)`);
    return lines;
  }

  // ── ranking for the compiler ──────────────────────────────────────────────

  candidates(request: CandidateRequest): RepoCandidate[] {
    const scores = new Map<string, { score: number; reasons: string[]; lines: Array<[number, number]>; symbols: string[] }>();
    const add = (path: string, score: number, reason: string, extra?: { lines?: Array<[number, number]>; symbols?: string[] }): void => {
      if (!this.index.has(path)) return;
      const entry = scores.get(path) ?? { score: 0, reasons: [], lines: [], symbols: [] };
      entry.score += score;
      if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
      for (const line of extra?.lines ?? []) entry.lines.push(line);
      for (const symbol of extra?.symbols ?? []) if (!entry.symbols.includes(symbol)) entry.symbols.push(symbol);
      scores.set(path, entry);
    };
    const seen = new Set(request.alreadySeen ?? []);

    for (const file of request.explicitFiles ?? []) {
      const resolved = this.resolvePath(file);
      if (resolved) add(resolved, 100, 'named explicitly');
    }
    for (const pinned of this.options.pins ?? []) add(pinned, 40, 'pinned');
    for (const printed of namedPaths(request.objective)) {
      const resolved = this.resolvePath(printed);
      if (resolved) add(resolved, 95, 'named in the objective');
    }
    for (const file of request.changedFiles ?? []) {
      const resolved = this.resolvePath(file);
      if (resolved) add(resolved, 45, 'changed in this task');
    }

    const implicated = request.errorText ? this.implicatedBy(request.errorText) : [];
    for (const item of implicated) {
      add(item.path, item.via === 'path' ? 90 : 70, item.via === 'path' ? 'named by the failure output' : 'defines a symbol the failure names', {
        lines: item.lines,
        symbols: item.symbols,
      });
    }

    // Objective terms: a symbol match is much stronger than a path-word match.
    for (const term of terms(request.objective)) {
      const definitions = this.symbolIndex.get(term) ?? [];
      if (definitions.length > 0 && definitions.length <= 4) {
        for (const definition of definitions) add(definition.path, 60, `defines ${definition.name}`, { symbols: [definition.name] });
      }
      for (const file of this.live) {
        const base = norm(file.path.split('/').pop() ?? '').replace(/\.[a-z0-9]+$/, '');
        if (base.length >= 3 && (base === term || (term.length >= 5 && base.includes(term)))) add(file.path, base === term ? 35 : 20, `path matches "${term}"`);
      }
    }

    // Graph neighbours of the strongest direct hits.
    const seeds = [...scores.entries()].filter(([, entry]) => entry.score >= 60).sort((a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1)).slice(0, 4);
    const wantsTests = request.taskType === 'repair' || request.taskType === 'diagnose' || request.taskType === 'implement';
    for (const [path] of seeds) {
      if (wantsTests) for (const test of this.testsFor(path)) add(test, 50, `test for ${path}`);
      for (const dependency of this.dependenciesOf(path)) add(dependency, 25, `imported by ${path}`);
      for (const caller of this.referencesTo(path).slice(0, 6)) add(caller, 30, `imports ${path}`);
    }

    if (request.taskType === 'inspect') {
      for (const path of this.manifests().slice(0, 4)) add(path, 45, 'project manifest');
      for (const path of this.entrypoints().slice(0, 4)) add(path, 55, 'entrypoint');
      for (const file of this.live) if (isArchitecturePath(file.path) && !file.isTest) add(file.path, 22, 'architecture-bearing module');
      for (const file of this.live) if (/^(readme|architecture|overview|design)(\.[a-z]+)?$/i.test(file.path.split('/').pop() ?? '')) add(file.path, 50, 'project documentation');
    }

    // With nothing else to go on, the most recently changed files are the best guess.
    if (scores.size < 3) for (const path of this.recentlyChanged(3)) add(path, 12, 'recently modified');

    const ranked = [...scores.entries()].map(([path, entry]) => {
      const file = this.index.get(path)!;
      const demoted = seen.has(path);
      return {
        path,
        score: entry.score - (demoted ? 25 : 0),
        reasons: demoted ? [...entry.reasons, 'already shown to the model'] : entry.reasons,
        size: file.size,
        summary: file.summary,
        symbols: file.symbols.slice(0, 24).map(symbol => `${symbol.kind} ${symbol.name}:${symbol.line}`),
        focus: entry.lines.length > 0 || entry.symbols.length > 0
          ? { ...(entry.lines.length ? { lines: entry.lines.slice(0, 6) } : {}), ...(entry.symbols.length ? { symbols: entry.symbols.slice(0, 4) } : {}) }
          : undefined,
      } satisfies RepoCandidate;
    });
    ranked.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
    return ranked.slice(0, request.limit ?? 24);
  }
}

/**
 * Best available intelligence, degrading gracefully:
 * rich index → filesystem scan → empty (a plain or empty folder is a valid workspace).
 */
export async function loadRepositoryIntel(input: {
  workspaceRoot: string;
  /** Returns the index snapshot, or throws/returns undefined when the index is unavailable. */
  snapshotProvider?: () => Promise<RepositoryIndexSnapshot | undefined>;
  signal?: AbortSignal;
}): Promise<RepositoryIntel> {
  if (input.snapshotProvider) {
    try {
      const snapshot = await input.snapshotProvider();
      if (snapshot && snapshot.files.some(file => !file.deleted)) return RepositoryIntel.fromSnapshot(snapshot);
    } catch { /* fall through to the filesystem scan */ }
  }
  try {
    const scan = await scanWorkspaceLite(input.workspaceRoot, { signal: input.signal });
    return new RepositoryIntel(scan.files, { truncated: scan.truncated, source: 'filesystem' });
  } catch {
    return new RepositoryIntel([], { source: 'empty' });
  }
}
