/**
 * Context engine over a WorkspaceHost: graph finds targets, exact source is read, a bounded EvidencePacket goes to the model.
 *
 * GRAPH EDGE != PROOF OF SOURCE BEHAVIOUR. The graph only decides *which* files and ranges to read. Everything the model
 * is shown as evidence is source text read through the host at request time, with its path and line range. When the
 * graph is cold or partial the engine degrades to host search + path matching; it never refuses to answer because indexing
 * has not finished.
 */
import { RepositoryGraph, type RankedFile } from './repositoryGraph';
import type { RepositoryGraphIndexer } from './graphIndexer';
import type { SearchHit, WorkspaceHost } from './workspaceHost';

export interface EvidenceTarget {
  path: string;
  startLine?: number;
  endLine?: number;
  reason: string;
  source: 'graph' | 'search' | 'explicit' | 'host';
}

export interface EvidenceItem {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  reason: string;
  source: EvidenceTarget['source'];
}

export interface EvidencePacket {
  items: EvidenceItem[];
  /** Graph-derived navigation notes. Not evidence: they say why files were chosen. */
  notes: string[];
  tokenEstimate: number;
  truncated: boolean;
  /** Where the targets came from. `cold` = no usable graph yet. */
  mode: 'graph' | 'cold' | 'explicit';
  timingsMs: Record<string, number>;
}

export interface ReferenceResult {
  definitions: Array<{ path: string; line: number; kind: string }>;
  references: Array<{ path: string; line: number; text: string }>;
  /** Which authority answered: the editor's language service, the import-scoped text search, or a plain workspace search. */
  source: 'lsp' | 'graph-search' | 'search';
  timingsMs: number;
}

export interface ImpactResult {
  target: string;
  kind: 'file' | 'symbol';
  direct: string[];
  indirect: string[];
  tests: string[];
  references: Array<{ path: string; line: number; text: string }>;
  source: string;
}

export interface BuildOptions {
  budgetTokens?: number;
  maxFiles?: number;
  maxLinesPerItem?: number;
}

const CHARS_PER_TOKEN = 3.5;
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

export class EvidencePacketBuilder {
  constructor(private readonly host: WorkspaceHost) {}

  async build(targets: readonly EvidenceTarget[], options: BuildOptions = {}): Promise<Omit<EvidencePacket, 'mode' | 'notes' | 'timingsMs'>> {
    const budgetChars = Math.floor((options.budgetTokens ?? 6000) * CHARS_PER_TOKEN);
    const maxFiles = options.maxFiles ?? 8;
    const maxLines = options.maxLinesPerItem ?? 160;
    const items: EvidenceItem[] = [];
    const seen = new Set<string>();
    let used = 0;
    let truncated = false;
    for (const target of targets) {
      if (items.length >= maxFiles) { truncated = true; break; }
      const key = `${target.path}:${target.startLine ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const start = Math.max(1, target.startLine ?? 1);
      const end = target.endLine ?? (start + maxLines - 1);
      const read = await this.host.readFile(target.path, { startLine: start, endLine: Math.min(end, start + maxLines - 1) });
      if (!read || !read.text.trim()) continue;
      let text = read.text;
      if (used + text.length > budgetChars) {
        const room = budgetChars - used;
        if (room < 400) { truncated = true; break; }
        text = text.slice(0, room);
        truncated = true;
      }
      used += text.length;
      items.push({ path: target.path, startLine: start, endLine: start + text.split('\n').length - 1, text, reason: target.reason, source: target.source });
      if (used >= budgetChars) { truncated = true; break; }
    }
    return { items, tokenEstimate: Math.ceil(used / CHARS_PER_TOKEN), truncated };
  }
}

export interface ContextEngineOptions {
  /** Below this fraction of eligible files indexed the graph is treated as partial and host search supplements it. */
  usableCoverage?: number;
}

/** The portable context engine. One per workspace; the indexer is optional (a host with no graph still works). */
export class RepositoryContextEngine {
  private readonly builder: EvidencePacketBuilder;
  private readonly usable: number;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly indexer?: RepositoryGraphIndexer,
    options: ContextEngineOptions = {},
  ) {
    this.builder = new EvidencePacketBuilder(host);
    this.usable = options.usableCoverage ?? 0.05;
  }

  get graph(): RepositoryGraph | undefined { return this.indexer?.graph; }

  /** True when the graph has parsed enough to answer symbol questions. */
  graphUsable(): boolean {
    const coverage = this.indexer?.coverage();
    return Boolean(coverage && coverage.totalFiles > 0 && (coverage.fraction >= this.usable || coverage.phase === 'ready'));
  }

  /** Files the user named explicitly: read exactly those, no retrieval. */
  async explicitFiles(paths: readonly string[], options: BuildOptions = {}): Promise<EvidencePacket> {
    const started = performance.now();
    const targets: EvidenceTarget[] = paths.map(path => ({ path, reason: 'named explicitly', source: 'explicit' }));
    const built = await this.builder.build(targets, { maxFiles: paths.length, ...options });
    return { ...built, notes: [], mode: 'explicit', timingsMs: { total: performance.now() - started } };
  }

  /** Symbol trace: definitions, then the files that import the definer and mention the name, then tests. */
  async traceSymbol(name: string, options: BuildOptions = {}): Promise<EvidencePacket> {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const notes: string[] = [];
    const targets: EvidenceTarget[] = [];
    const graph = this.graph;
    let mode: EvidencePacket['mode'] = 'cold';

    const t0 = performance.now();
    const defs = graph && this.graphUsable() ? graph.definitions(name, 6) : [];
    timings.definitions = performance.now() - t0;
    if (defs.length > 0) {
      mode = 'graph';
      for (const def of defs.slice(0, 3)) {
        targets.push({ path: def.path, startLine: Math.max(1, def.symbol.line - 2), endLine: def.symbol.line + 60, reason: `defines ${def.symbol.kind} ${name}`, source: 'graph' });
        notes.push(`${def.path}:${def.symbol.line} defines ${def.symbol.kind} ${name}${def.symbol.exported ? ' (exported)' : ''}`);
      }
      const definers = new Set(defs.map(d => d.path));
      const candidatePaths = new Set<string>();
      for (const definer of definers) for (const edge of graph!.importersOf(definer)) candidatePaths.add(edge.from);
      const t1 = performance.now();
      const hits = candidatePaths.size > 0
        ? await (this.host.search?.(name, { wholeWord: true, caseSensitive: true, paths: [...candidatePaths].slice(0, 300), maxResults: 60 }) ?? Promise.resolve([] as SearchHit[]))
        : [];
      timings.references = performance.now() - t1;
      const perFile = new Map<string, SearchHit>();
      for (const hit of hits) if (!definers.has(hit.path) && !perFile.has(hit.path)) perFile.set(hit.path, hit);
      for (const hit of [...perFile.values()].slice(0, 4)) {
        targets.push({ path: hit.path, startLine: Math.max(1, hit.line - 6), endLine: hit.line + 24, reason: `uses ${name} (line ${hit.line})`, source: 'search' });
      }
      notes.push(`${candidatePaths.size} file(s) import the defining module(s); ${perFile.size} of them mention ${name}`);
      for (const definer of [...definers].slice(0, 2)) {
        for (const test of graph!.testsFor(definer).slice(0, 1)) targets.push({ path: test.from, reason: `test for ${definer} (${test.provenance})`, source: 'graph' });
      }
    } else {
      // Cold or unknown to the graph: host search, then host symbols.
      const t1 = performance.now();
      const hits = await (this.host.search?.(name, { wholeWord: true, caseSensitive: true, maxResults: 40 }) ?? Promise.resolve([] as SearchHit[]));
      timings.search = performance.now() - t1;
      const defLike = hits.filter(h => new RegExp(`\\b(function|class|interface|type|enum|def|fn|struct|const|let|var)\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(h.text));
      const ordered = [...defLike, ...hits.filter(h => !defLike.includes(h))];
      const files = new Set<string>();
      for (const hit of ordered) {
        if (files.has(hit.path)) continue;
        files.add(hit.path);
        targets.push({ path: hit.path, startLine: Math.max(1, hit.line - 4), endLine: hit.line + 40, reason: defLike.includes(hit) ? `definition-like match for ${name}` : `mentions ${name}`, source: 'search' });
        if (files.size >= 6) break;
      }
      notes.push('Repository graph not ready: used text search.');
    }
    const t2 = performance.now();
    const built = await this.builder.build(targets, { maxFiles: 8, ...options });
    timings.read = performance.now() - t2;
    timings.total = performance.now() - started;
    return { ...built, notes, mode, timingsMs: timings };
  }

  /** Architecture / subsystem question: structure first (entry points + centrality), then what the terms select. */
  async architectureEvidence(terms: readonly string[], options: BuildOptions = {}): Promise<EvidencePacket> {
    const started = performance.now();
    const timings: Record<string, number> = {};
    const notes: string[] = [];
    const targets: EvidenceTarget[] = [];
    const graph = this.graph;
    let mode: EvidencePacket['mode'] = 'cold';
    const lowered = terms.map(t => t.toLowerCase());

    if (graph && graph.fileCount() > 0) {
      const t0 = performance.now();
      const ranked: RankedFile[] = graph.rankFiles(lowered, { max: 10, deadlineMs: 300 });
      timings.rank = performance.now() - t0;
      const usable = this.graphUsable();
      mode = usable ? 'graph' : 'cold';
      // Package-aware: a question about "the auth package" starts from that package's manifest, entry and internal hubs.
      const matched = graph.packagesMatching(lowered, 2);
      for (const pkg of matched) {
        targets.push({ path: pkg.manifest, endLine: 60, reason: `manifest of ${pkg.name ?? pkg.dir}`, source: 'graph' });
        const main = pkg.main ? (pkg.dir ? `${pkg.dir}/${pkg.main.replace(/^\.\//, '')}` : pkg.main.replace(/^\.\//, '')) : undefined;
        if (main && graph.has(main)) targets.push({ path: main, endLine: 80, reason: `entry of ${pkg.name ?? pkg.dir}`, source: 'graph' });
        for (const hub of graph.topByFanIn(pkg.dir, 2)) targets.push({ path: hub.path, endLine: 80, reason: hub.reasons.join('; '), source: 'graph' });
      }
      if (matched.length === 0) {
        for (const manifest of graph.rootManifests(2)) targets.push({ path: manifest, endLine: 60, reason: 'project manifest', source: 'graph' });
        if (usable) for (const entry of graph.entryPoints(3)) targets.push({ path: entry.path, endLine: 80, reason: `entry point (${entry.reasons.join(', ')})`, source: 'graph' });
      }
      for (const file of ranked.slice(0, 6)) {
        const symbol = graph.symbolsIn(file.path).find(s => s.exported && lowered.some(t => s.name.toLowerCase().includes(t)));
        targets.push({
          path: file.path,
          ...(symbol ? { startLine: Math.max(1, symbol.line - 2), endLine: symbol.line + 70 } : { endLine: 90 }),
          reason: file.reasons.join('; ') || 'matches the question',
          source: 'graph',
        });
      }
      notes.push(`graph: ${graph.stats().files} files, ${graph.stats().symbols} symbols, coverage ${(100 * (this.indexer?.coverage().fraction ?? 0)).toFixed(0)}%`);
    }
    if (targets.filter(t => t.source === 'graph').length < 3 || mode === 'cold') {
      // Cold-start path: host search on the terms.
      const t1 = performance.now();
      for (const term of lowered.slice(0, 3)) {
        const hits = await (this.host.search?.(term, { maxResults: 20 }) ?? Promise.resolve([] as SearchHit[]));
        const seen = new Set<string>();
        for (const hit of hits) {
          if (seen.has(hit.path) || targets.some(t => t.path === hit.path)) continue;
          seen.add(hit.path);
          targets.push({ path: hit.path, startLine: Math.max(1, hit.line - 3), endLine: hit.line + 40, reason: `text match "${term}"`, source: 'search' });
          if (seen.size >= 3) break;
        }
      }
      timings.search = performance.now() - t1;
      if (mode === 'cold') notes.push('Repository graph not ready: supplemented with text search.');
    }
    const t2 = performance.now();
    const built = await this.builder.build(targets, { maxFiles: 10, ...options });
    timings.read = performance.now() - t2;
    timings.total = performance.now() - started;
    return { ...built, notes, mode, timingsMs: timings };
  }

  /**
   * One ranked path list for a retrieval fusion: definers of the named identifiers first, then files the keywords select by
   * path/symbol/centrality, then importers of the definers. Empty while the graph is not usable. Ranking only: callers
   * still read the exact source before anything reaches a model.
   */
  rankPaths(plan: { identifiers: readonly string[]; keywords: readonly string[] }): string[] {
    const graph = this.graph;
    if (!graph || !this.graphUsable()) return [];
    const ordered: string[] = [];
    const add = (p: string): void => { if (!ordered.includes(p)) ordered.push(p); };
    const definers: string[] = [];
    for (const identifier of plan.identifiers.slice(0, 4)) for (const def of graph.definitions(identifier, 3)) { add(def.path); definers.push(def.path); }
    for (const ranked of graph.rankFiles(plan.keywords.slice(0, 6), { max: 8, deadlineMs: 80 })) add(ranked.path);
    for (const definer of definers.slice(0, 4)) for (const edge of graph.importersOf(definer).slice(0, 4)) add(edge.from);
    return ordered.slice(0, 24);
  }

  /**
   * Who uses this symbol? Exact call/reference sites as `path:line  text`, never a packet of file bodies.
   * Order of authority: the editor's language service at the definition (precise, semantic), else the files that import the
   * definer searched for the whole word, else a workspace-wide whole-word search. `source` says which one answered.
   */
  async findReferences(name: string, options: { path?: string; max?: number } = {}): Promise<ReferenceResult> {
    const started = performance.now();
    const max = options.max ?? 40;
    const graph = this.graph;
    let defs: ReferenceResult['definitions'] = graph && this.graphUsable()
      ? graph.definitions(name, 6).map(d => ({ path: d.path, line: d.symbol.line, kind: d.symbol.kind }))
      : [];
    if (options.path) defs = [...defs.filter(d => d.path === options.path), ...defs.filter(d => d.path !== options.path)];
    if (defs.length === 0 && this.host.symbols) {
      const hits = await this.host.symbols(name, 8);
      defs = hits.filter(h => h.name === name).map(h => ({ path: h.path, line: h.line, kind: h.kind }));
    }
    const refs: ReferenceResult['references'] = [];
    let source: ReferenceResult['source'] = 'search';
    const def = defs[0];
    if (def && this.host.references) {
      const defLine = (await this.host.readFile(def.path, { startLine: def.line, endLine: def.line }))?.text ?? '';
      const column = defLine.indexOf(name);
      if (column >= 0) {
        const locations = await this.host.references(def.path, def.line, column);
        if (locations.length > 0) {
          source = 'lsp';
          for (const loc of locations.slice(0, max + 5)) {
            if (loc.path === def.path && loc.line === def.line) continue;
            const text = (await this.host.readFile(loc.path, { startLine: loc.line, endLine: loc.line }))?.text.trim().slice(0, 200) ?? '';
            refs.push({ path: loc.path, line: loc.line, text });
            if (refs.length >= max) break;
          }
        }
      }
    }
    if (refs.length === 0 && this.host.search) {
      // Whole-word search over the whole workspace: import resolution is incomplete for some languages (Python packages,
      // path aliases), and scoping the search to resolved importers silently loses callers. The graph only ORDERS hits:
      // files that import the definer come first, tests last.
      const hits = await this.host.search(name, { wholeWord: true, caseSensitive: true, maxResults: 400 });
      const importers = new Set<string>();
      if (graph) for (const d of defs) for (const edge of graph.importersOf(d.path)) importers.add(edge.from);
      if (importers.size > 0) source = 'graph-search';
      const isTest = (p: string): boolean => /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+$/i.test(p);
      const rank = (p: string): number => (importers.has(p) ? 0 : isTest(p) ? 2 : 1);
      const ordered = hits.map((hit, index) => ({ hit, index })).sort((x, y) => rank(x.hit.path) - rank(y.hit.path) || x.index - y.index);
      for (const { hit } of ordered) {
        if (defs.some(d => d.path === hit.path && d.line === hit.line)) continue;
        refs.push({ path: hit.path, line: hit.line, text: hit.text.trim() });
        if (refs.length >= max) break;
      }
    }
    return { definitions: defs, references: refs, source, timingsMs: performance.now() - started };
  }

  /**
   * "What might break if I change this?" For a file: direct importers, importers-of-importers (depth 2) and tests. For a
   * symbol: the files that reference it, plus the tests of the defining file and of those referencing files.
   */
  async impact(target: string, options: { max?: number } = {}): Promise<ImpactResult> {
    const graph = this.graph;
    const max = options.max ?? 30;
    const isPath = Boolean(graph?.has(target)) || /[\\/]/.test(target) || /\.[a-z0-9]{1,5}$/i.test(target);
    if (!graph) return { target, kind: isPath ? 'file' : 'symbol', direct: [], indirect: [], tests: [], references: [], source: 'no-graph' };
    const tests = new Set<string>();
    const addTests = (file: string): void => { for (const t of graph.testsFor(file)) tests.add(t.from); };
    if (isPath) {
      addTests(target);
      const direct = [...new Set(graph.importersOf(target).map(e => e.from))].filter(p => !tests.has(p));
      const indirect = new Set<string>();
      for (const d of direct) for (const e of graph.importersOf(d)) if (e.from !== target && !direct.includes(e.from) && !tests.has(e.from)) indirect.add(e.from);
      return { target, kind: 'file', direct: direct.slice(0, max), indirect: [...indirect].slice(0, max), tests: [...tests].slice(0, 10), references: [], source: 'graph' };
    }
    const found = await this.findReferences(target, { max });
    const files = [...new Set(found.references.map(r => r.path))];
    for (const d of found.definitions) addTests(d.path);
    for (const f of files.slice(0, 20)) addTests(f);
    for (const d of found.definitions) tests.delete(d.path);
    return { target, kind: 'symbol', direct: files.filter(f => !tests.has(f)).slice(0, max), indirect: [], tests: [...tests].slice(0, 10), references: found.references, source: found.source };
  }

  /** Neighbourhood of one file: what it imports, who imports it, its tests. Navigation only. */
  neighborhood(path: string): Array<{ path: string; relation: string; confidence: number; provenance: string }> {
    const graph = this.graph;
    if (!graph) return [];
    return graph.neighbors(path).map(edge => ({
      path: edge.from === path ? edge.to : edge.from,
      relation: edge.kind,
      confidence: edge.confidence,
      provenance: edge.provenance,
    }));
  }
}
