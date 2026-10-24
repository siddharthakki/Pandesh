/**
 * RepositoryGraph: navigation/index data for a codebase (portable, in-memory, incrementally maintained).
 *
 * The graph answers "where should I look?" — files, symbols, imports, importers, tests, packages — and every derived
 * edge carries provenance and confidence. It is NOT proof of behaviour: a graph edge points at source; the source
 * text, read exactly, is the evidence. `EvidencePacketBuilder` (evidence.ts) enforces that split.
 */
import { extractFile, languageOf, roleOf, type ExtractorFn, type FileRole, type ImportRec, type Provenance, type SymbolRec } from './extractors';

export interface FileNode {
  path: string;
  size: number;
  mtimeMs: number;
  hash?: string;
  language: string;
  role: FileRole;
  /** Directory of the nearest enclosing package/project manifest ('' = repository root). */
  pkg?: string;
  symbols: SymbolRec[];
  imports: ImportRec[];
  exports: string[];
  /** False until the contents were read; such a node is still discoverable by path. */
  indexed: boolean;
  provenance: Provenance;
}

/** A tsconfig/jsconfig `baseUrl` / `paths` block, anchored at the directory of the config that defines it. */
export interface PathMapping {
  dir: string;
  baseUrl?: string;
  paths?: Record<string, string[]>;
}

export interface PackageInfo {
  dir: string;
  manifest: string;
  kind: 'npm' | 'python' | 'go' | 'rust' | 'maven' | 'gradle' | 'dotnet' | 'cmake' | 'other';
  name?: string;
  main?: string;
  deps?: string[];
}

export type EdgeKind = 'imports' | 'imported_by' | 'tests' | 'tested_by' | 'in_package' | 'declares_dep' | 'extends' | 'implements';
export interface GraphEdge { from: string; to: string; kind: EdgeKind; provenance: Provenance; confidence: number; line?: number; via?: string }

export interface DefinitionHit { path: string; symbol: SymbolRec; role: FileRole; score: number }
export interface RankedFile { path: string; score: number; reasons: string[] }

export interface GraphStats {
  files: number;
  indexedFiles: number;
  symbols: number;
  imports: number;
  resolvedImports: number;
  packages: number;
  maxFanIn: number;
}

const TS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts'];
const posixDir = (p: string): string => { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const stripExt = (name: string): string => { const i = name.lastIndexOf('.'); return i <= 0 ? name : name.slice(0, i); };

function joinNormalize(dir: string, rel: string): string {
  const parts = (dir ? dir.split('/') : []);
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length === 0) return ''; parts.pop(); } else parts.push(seg);
  }
  return parts.join('/');
}

/** Test-marker-free stem used to pair a test with its subject: foo.test.ts, test_foo.py, FooTest.java, foo_test.go → foo. */
export function testStem(path: string): string {
  return stripExt(baseName(path))
    .replace(/[._-]?(tests?|spec|specs)$/i, '')
    .replace(/^test[_-]/i, '')
    .replace(/Test$/, '')
    .toLowerCase();
}

/** Lowercase alphanumeric tokens of a path or identifier, splitting camelCase: "authService.ts" → auth, service, ts. */
export function tokenize(text: string): string[] {
  const out = new Set<string>();
  for (const part of text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/)) if (part.length >= 2) out.add(part);
  return [...out];
}

/** A token shared by more files than this carries no ranking signal ("src", "index", "ts"); it is not indexed. */
const TOKEN_STOP_AT = 4000;
type TokenSet = Set<string> | 'stop';

function addToken(map: Map<string, TokenSet>, token: string, value: string): void {
  const entry = map.get(token);
  if (entry === 'stop') return;
  if (!entry) { map.set(token, new Set([value])); return; }
  entry.add(value);
  if (entry.size > TOKEN_STOP_AT) map.set(token, 'stop');
}

function removeToken(map: Map<string, TokenSet>, token: string, value: string): void {
  const entry = map.get(token);
  if (!entry || entry === 'stop') return;
  entry.delete(value);
  if (entry.size === 0) map.delete(token);
}

/**
 * "validate" / "validation" / "validator" should all find `ToolArgumentValidator`; "persisted" should find `persist*`.
 * A light suffix strip (never below 4 characters) turns a question word into a stem the path/symbol index can match.
 */
export function stemNeedle(term: string): string {
  if (!/^[a-z]+$/.test(term)) return term;
  for (const suffix of ['ations', 'ation', 'ators', 'ator', 'ions', 'ion', 'ing', 'ers', 'er', 'ed', 'es', 'e', 's']) {
    if (term.endsWith(suffix) && term.length - suffix.length >= 4) return term.slice(0, -suffix.length);
  }
  return term;
}

export class RepositoryGraph {
  readonly files = new Map<string, FileNode>();
  private readonly symbolIndex = new Map<string, Array<{ path: string; index: number }>>();
  private readonly importers = new Map<string, Set<string>>();
  private readonly baseNames = new Map<string, string[]>();
  private readonly testStems = new Map<string, Set<string>>();
  /**
   * stem → importers holding an unresolved import whose last segment is that stem. A file that appears later (or returns
   * after removal) re-resolves exactly those importers, instead of every import registering every path it might become.
   */
  private readonly unresolvedByStem = new Map<string, Set<string>>();
  private pathMappings: PathMapping[] = [];
  private packages: PackageInfo[] = [];
  private packageByName = new Map<string, PackageInfo>();
  private readonly dirPkgCache = new Map<string, string | undefined>();
  private symbolCount = 0;
  private version = 0;
  private readonly pathTokens = new Map<string, TokenSet>();
  private readonly symbolTokens = new Map<string, TokenSet>();
  private memo = new Map<string, { version: number; value: unknown }>();
  private pkgFilesCache?: { version: number; byDir: Map<string, string[]> };

  // ------------------------------------------------------------------ mutation

  /** Registers a path without reading it (cold discovery). */
  addPath(path: string, size = 0, mtimeMs = 0): FileNode {
    const existing = this.files.get(path);
    if (existing) return existing;
    this.version++;
    const language = languageOf(path);
    const node: FileNode = { path, size, mtimeMs, language, role: roleOf(path, language), symbols: [], imports: [], exports: [], indexed: false, provenance: 'lexical' };
    this.files.set(path, node);
    this.trackName(node);
    for (const token of tokenize(path)) addToken(this.pathTokens, token, path);
    this.resolveWaitingFor(path);
    return node;
  }

  private trackName(node: FileNode): void {
    const key = baseName(node.path).toLowerCase();
    const list = this.baseNames.get(key);
    if (list) list.push(node.path); else this.baseNames.set(key, [node.path]);
    if (node.role === 'test') {
      const stem = testStem(node.path);
      const set = this.testStems.get(stem);
      if (set) set.add(node.path); else this.testStems.set(stem, new Set([node.path]));
    }
  }

  private untrackName(node: FileNode): void {
    const key = baseName(node.path).toLowerCase();
    const list = this.baseNames.get(key);
    if (list) { const i = list.indexOf(node.path); if (i >= 0) list.splice(i, 1); if (list.length === 0) this.baseNames.delete(key); }
    if (node.role === 'test') this.testStems.get(testStem(node.path))?.delete(node.path);
  }

  private dropIndexed(node: FileNode): void {
    node.symbols.forEach((symbol, index) => {
      const key = symbol.name.toLowerCase();
      const list = this.symbolIndex.get(key);
      if (!list) return;
      const filtered = list.filter(entry => !(entry.path === node.path && entry.index === index));
      if (filtered.length === 0) {
        this.symbolIndex.delete(key);
        for (const token of tokenize(symbol.name)) removeToken(this.symbolTokens, token, key);
      } else this.symbolIndex.set(key, filtered);
    });
    this.symbolCount -= node.symbols.length;
    for (const rec of node.imports) {
      if (rec.resolved) this.importers.get(rec.resolved)?.delete(node.path);
    }
    for (const rec of node.imports) if (!rec.resolved) this.unregisterUnresolved(node.path, rec);
  }

  /** Replaces a file's indexed contents. Safe to call repeatedly (incremental). */
  upsert(path: string, input: { size: number; mtimeMs: number; hash?: string; text: string }, custom?: ExtractorFn): FileNode {
    this.version++;
    const node = this.files.get(path) ?? this.addPath(path, input.size, input.mtimeMs);
    if (node.indexed) this.dropIndexed(node);
    const extraction = extractFile(path, input.text, custom);
    node.size = input.size;
    node.mtimeMs = input.mtimeMs;
    node.hash = input.hash;
    node.language = extraction.language;
    node.symbols = extraction.symbols;
    node.imports = extraction.imports.map(rec => ({ ...rec, resolved: undefined }));
    node.exports = extraction.exports;
    node.provenance = extraction.provenance;
    node.indexed = true;
    node.pkg = this.packageDirOf(path);
    node.symbols.forEach((symbol, index) => this.indexSymbol(path, symbol, index));
    this.symbolCount += node.symbols.length;
    this.resolveImportsOf(node);
    return node;
  }

  /** Files of one package directory (cached per graph version): the basis of package-aware architecture queries. */
  packageFiles(dir: string): string[] {
    if (!this.pkgFilesCache || this.pkgFilesCache.version !== this.version) {
      const byDir = new Map<string, string[]>();
      for (const node of this.files.values()) {
        if (node.pkg === undefined) continue;
        const list = byDir.get(node.pkg);
        if (list) list.push(node.path); else byDir.set(node.pkg, [node.path]);
      }
      this.pkgFilesCache = { version: this.version, byDir };
    }
    return this.pkgFilesCache.byDir.get(dir) ?? [];
  }

  /** The most-imported source files inside a package (its internal hubs). */
  topByFanIn(dir: string, count = 3): RankedFile[] {
    return this.packageFiles(dir)
      .filter(path => this.files.get(path)?.role === 'source')
      .map(path => ({ path, score: this.fanIn(path), reasons: [`imported by ${this.fanIn(path)} files in this package`] }))
      .filter(entry => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, count);
  }

  /** Packages whose name or directory contains one of the (lowercase) terms, best match first. */
  packagesMatching(terms: readonly string[], max = 2): PackageInfo[] {
    const needles = terms.map(t => stemNeedle(t.toLowerCase())).filter(t => t.length >= 2);
    const scored = this.packages
      .map(pkg => {
        const name = (pkg.name ?? '').toLowerCase();
        const dir = pkg.dir.toLowerCase();
        const leaf = dir.slice(dir.lastIndexOf('/') + 1);
        let score = 0;
        for (const needle of needles) {
          if (name === needle || leaf === needle || name.endsWith(`/${needle}`)) score += 6;
          else if (name.includes(needle)) score += 3;
          else if (leaf.includes(needle)) score += 3;
          else if (dir.includes(needle)) score += 1;
        }
        return { pkg, score };
      })
      .filter(entry => entry.score > 0);
    return scored.sort((a, b) => b.score - a.score || a.pkg.dir.localeCompare(b.pkg.dir)).slice(0, max).map(entry => entry.pkg);
  }

  /** Re-attaches a persisted record without re-reading the file. */
  restore(record: FileNode, resolve = true): void {
    this.version++;
    const node = this.files.get(record.path) ?? this.addPath(record.path, record.size, record.mtimeMs);
    if (node.indexed) this.dropIndexed(node);
    Object.assign(node, record, { indexed: record.indexed });
    node.imports = record.imports.map(rec => ({ ...rec, resolved: undefined }));
    if (!node.indexed) return;
    node.symbols.forEach((symbol, index) => this.indexSymbol(node.path, symbol, index));
    this.symbolCount += node.symbols.length;
    if (resolve) this.resolveImportsOf(node);
  }

  /** Resolves every import of every indexed file. Used once after a bulk restore, when the full file set is known. */
  resolveAllImports(): void {
    for (const node of this.files.values()) {
      if (!node.indexed) continue;
      for (const rec of node.imports) if (!rec.resolved) this.resolveOne(node, rec);
    }
  }

  setPathMappings(mappings: PathMapping[]): void {
    this.version++;
    this.pathMappings = [...mappings].sort((a, b) => b.dir.length - a.dir.length);
  }

  private indexSymbol(path: string, symbol: SymbolRec, index: number): void {
    const key = symbol.name.toLowerCase();
    const list = this.symbolIndex.get(key);
    if (list) list.push({ path, index });
    else {
      this.symbolIndex.set(key, [{ path, index }]);
      for (const token of tokenize(symbol.name)) addToken(this.symbolTokens, token, key);
    }
  }

  remove(path: string): void {
    const node = this.files.get(path);
    if (!node) return;
    this.version++;
    if (node.indexed) this.dropIndexed(node);
    this.untrackName(node);
    for (const token of tokenize(path)) removeToken(this.pathTokens, token, path);
    const importerPaths = [...(this.importers.get(path) ?? [])];
    this.importers.delete(path);
    this.files.delete(path);
    // Importers of the removed file become unresolved again and wait for it (or a replacement) to reappear.
    for (const importer of importerPaths) {
      const importerNode = this.files.get(importer);
      if (!importerNode) continue;
      for (const rec of importerNode.imports) {
        if (rec.resolved !== path) continue;
        rec.resolved = undefined;
        this.resolveOne(importerNode, rec);
      }
    }
  }

  setPackages(packages: PackageInfo[]): void {
    this.version++;
    this.packages = [...packages].sort((a, b) => b.dir.length - a.dir.length);
    this.packageByName = new Map(packages.filter(p => p.name).map(p => [p.name!, p]));
    this.dirPkgCache.clear();
    for (const node of this.files.values()) node.pkg = this.packageDirOf(node.path);
  }

  packageList(): readonly PackageInfo[] { return this.packages; }

  private packageDirOf(path: string): string | undefined {
    const dir = posixDir(path);
    if (this.dirPkgCache.has(dir)) return this.dirPkgCache.get(dir);
    let found: string | undefined;
    for (const pkg of this.packages) {
      if (pkg.dir === '' || dir === pkg.dir || dir.startsWith(`${pkg.dir}/`)) { found = pkg.dir; break; }
    }
    this.dirPkgCache.set(dir, found);
    return found;
  }

  // ------------------------------------------------------------------ import resolution

  private resolveImportsOf(node: FileNode): void {
    for (const rec of node.imports) this.resolveOne(node, rec);
  }

  private link(importer: FileNode, rec: ImportRec, target: string, confidence: number): void {
    if (target === importer.path) return;
    rec.resolved = target;
    rec.confidence = Math.min(rec.confidence, confidence);
    const set = this.importers.get(target);
    if (set) set.add(importer.path); else this.importers.set(target, new Set([importer.path]));
  }

  /** Last meaningful segment of an import specifier, lowercase and extension-free: './a/b.js' → b, 'x.y.Z' → z, 'a::b' → b. */
  private stemOf(spec: string): string {
    const last = spec.split(/[\/.:\\]+/).filter(Boolean).pop() ?? spec;
    return last.toLowerCase();
  }

  private registerUnresolved(importer: string, rec: ImportRec): void {
    const stems = [this.stemOf(rec.spec), ...(rec.names ?? []).map(n => n.toLowerCase())];
    for (const stem of stems) {
      const set = this.unresolvedByStem.get(stem);
      if (set) set.add(importer); else this.unresolvedByStem.set(stem, new Set([importer]));
    }
  }

  private unregisterUnresolved(importer: string, rec: ImportRec): void {
    for (const stem of [this.stemOf(rec.spec), ...(rec.names ?? []).map(n => n.toLowerCase())]) {
      const set = this.unresolvedByStem.get(stem);
      if (set) { set.delete(importer); if (set.size === 0) this.unresolvedByStem.delete(stem); }
    }
  }

  /** Candidate target paths for an import, lazily and most-likely first. Never materialises the full list. */
  private *candidatePaths(node: FileNode, rec: ImportRec): Generator<string> {
    const language = node.language;
    const spec = rec.spec;
    if (language === 'typescript' || language === 'javascript') {
      if (spec.startsWith('.')) {
        const base = joinNormalize(posixDir(node.path), spec);
        yield* this.tsVariants(base);
        return;
      }
      // Bare specifier: tsconfig baseUrl/paths first, then workspace packages. Anything else is external.
      const mapping = this.pathMappings.find(m => m.dir === '' || node.path === m.dir || node.path.startsWith(`${m.dir}/`));
      if (mapping) {
        const anchor = (rel: string): string => joinNormalize(mapping.dir, rel);
        for (const [pattern, targets] of Object.entries(mapping.paths ?? {})) {
          const star = pattern.indexOf('*');
          const matches = star < 0 ? spec === pattern : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1;
          if (!matches) continue;
          const captured = star < 0 ? '' : spec.slice(star, spec.length - (pattern.length - star - 1));
          for (const target of targets) yield* this.tsVariants(anchor(`${mapping.baseUrl ?? '.'}/${target.replace('*', captured)}`));
        }
        if (mapping.baseUrl !== undefined) yield* this.tsVariants(anchor(`${mapping.baseUrl}/${spec}`));
      }
      const parts = spec.split('/');
      const name = spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      const rest = spec.startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');
      const pkg = this.packageByName.get(name);
      if (pkg) {
        const at = (p: string): string => (pkg.dir ? `${pkg.dir}/${p}` : p);
        if (rest) { yield* this.tsVariants(at(rest)); yield* this.tsVariants(at(`src/${rest}`)); }
        else {
          if (pkg.main) yield at(pkg.main.replace(/^\.\//, ''));
          for (const ext of TS_EXTS) yield at(`src/index${ext}`);
          for (const ext of TS_EXTS) yield at(`index${ext}`);
        }
      }
    } else if (language === 'python') {
      const dots = /^\.*/.exec(spec)![0].length;
      const dotted = spec.slice(dots).replace(/\./g, '/');
      const bases: string[] = [];
      if (dots > 0) {
        let dir = posixDir(node.path);
        for (let i = 1; i < dots; i++) dir = posixDir(dir);
        bases.push(dir);
      } else {
        bases.push('', posixDir(node.path));
        let dir = posixDir(node.path);
        while (dir) { dir = posixDir(dir); bases.push(dir); }
        if (node.pkg !== undefined) bases.push(node.pkg, node.pkg ? `${node.pkg}/src` : 'src');
      }
      for (const b of bases) {
        const join = (p: string): string => (b ? `${b}/${p}` : p);
        if (dotted) { yield join(`${dotted}.py`); yield join(`${dotted}/__init__.py`); } else yield join('__init__.py');
        for (const name of rec.names ?? []) if (/^[A-Za-z_]\w*$/.test(name)) yield join(dotted ? `${dotted}/${name}.py` : `${name}.py`);
      }
    } else if (language === 'rust') {
      const clean = spec.replace(/^(crate|self|super)::/, '').split('::');
      const dir = posixDir(node.path);
      for (const t of [clean.join('/'), clean.slice(0, -1).join('/')].filter(Boolean)) {
        yield joinNormalize(dir, `${t}.rs`); yield joinNormalize(dir, `${t}/mod.rs`); yield `src/${t}.rs`; yield `src/${t}/mod.rs`;
      }
    } else if (language === 'c' || language === 'cpp') {
      yield joinNormalize(posixDir(node.path), spec); yield spec; yield `include/${spec}`; yield `src/${spec}`;
    }
  }

  /** `base`, `base.ts`, … then `base/index.ts`: the usual TS/JS module resolution order, lazily. */
  private *tsVariants(base: string): Generator<string> {
    const stripped = base.replace(/\.(m|c)?jsx?$/, '');
    if (stripped !== base) { yield `${stripped}.ts`; yield `${stripped}.tsx`; yield `${stripped}.mts`; yield `${stripped}.cts`; yield base; }
    else { yield `${base}.ts`; yield `${base}.tsx`; yield base; }
    for (const ext of TS_EXTS) yield `${stripped}${ext}`;
    for (const ext of TS_EXTS) yield `${base}/index${ext}`;
  }

  private resolveOne(node: FileNode, rec: ImportRec): void {
    if (rec.resolved) return;
    const language = node.language;
    if (language === 'csharp') return; // namespaces do not map to paths
    for (const candidate of this.candidatePaths(node, rec)) {
      if (this.files.has(candidate)) { this.link(node, rec, candidate, rec.provenance === 'ast' ? 0.95 : 0.85); return; }
    }
    // Suffix-resolved languages: the import names a path *suffix*.
    let suffixKey: string | undefined;
    if (language === 'go') suffixKey = `dir:${rec.spec}`;
    else if ((language === 'java' || language === 'kotlin' || language === 'scala') && !rec.spec.endsWith('*')) suffixKey = `file:${rec.spec.replace(/\./g, '/')}.${language === 'java' ? 'java' : language === 'kotlin' ? 'kt' : 'scala'}`;
    else if (language === 'c' || language === 'cpp') suffixKey = `base:${baseName(rec.spec).toLowerCase()}`;
    if (suffixKey) {
      const target = this.resolveBySuffix(suffixKey, node.path);
      if (target) { this.link(node, rec, target, 0.6); return; }
    }
    // Bare specifiers that no mapping or workspace package claims are external libraries: nothing to wait for.
    if ((language === 'typescript' || language === 'javascript') && !rec.spec.startsWith('.') && !this.couldBeInternal(node, rec.spec)) return;
    this.registerUnresolved(node.path, rec);
  }

  private couldBeInternal(node: FileNode, spec: string): boolean {
    if (this.pathMappings.length > 0) return true;
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    return this.packageByName.has(name);
  }

  private resolveBySuffix(key: string, from: string): string | undefined {
    if (key.startsWith('file:')) {
      const want = key.slice(5);
      const matches = (this.baseNames.get(baseName(want).toLowerCase()) ?? []).filter(p => p.endsWith(want));
      return matches.sort((a, b) => a.length - b.length)[0];
    }
    if (key.startsWith('base:')) {
      const matches = (this.baseNames.get(key.slice(5)) ?? []).filter(p => p !== from);
      const dir = posixDir(from);
      return matches.sort((a, b) => Number(posixDir(b) === dir) - Number(posixDir(a) === dir) || a.length - b.length)[0];
    }
    // Go: an import path ends with the package directory.
    const want = key.slice(4);
    let best: string | undefined;
    let bestLen = 0;
    const dirName = baseName(want).toLowerCase();
    for (const candidate of this.baseNames.get(`${dirName}.go`) ?? []) {
      const dir = posixDir(candidate);
      if (want.endsWith(dir) && dir.length > bestLen) { best = candidate; bestLen = dir.length; }
    }
    return best;
  }

  /** A path appeared: re-resolve the importers that were waiting on a file with this stem. */
  private resolveWaitingFor(path: string): void {
    if (this.unresolvedByStem.size === 0) return;
    const name = baseName(path);
    const stems = new Set<string>([stripExt(name).toLowerCase()]);
    if (/^(index|__init__|mod)\./i.test(name)) stems.add(baseName(posixDir(path)).toLowerCase());
    for (const stem of stems) {
      const waiting = this.unresolvedByStem.get(stem);
      if (!waiting) continue;
      for (const importerPath of [...waiting]) {
        const importer = this.files.get(importerPath);
        if (!importer) { waiting.delete(importerPath); continue; }
        for (const rec of importer.imports) {
          if (rec.resolved) continue;
          this.unregisterUnresolved(importerPath, rec);
          this.resolveOne(importer, rec);
        }
      }
    }
  }

  // ------------------------------------------------------------------ queries

  fileCount(): number { return this.files.size; }
  has(path: string): boolean { return this.files.has(path); }
  get(path: string): FileNode | undefined { return this.files.get(path); }

  importsOf(path: string): GraphEdge[] {
    const node = this.files.get(path);
    if (!node) return [];
    const edges: GraphEdge[] = [];
    for (const rec of node.imports) {
      if (rec.resolved) edges.push({ from: path, to: rec.resolved, kind: 'imports', provenance: rec.provenance, confidence: rec.confidence, line: rec.line, via: rec.spec });
    }
    return edges;
  }

  importersOf(path: string): GraphEdge[] {
    const edges: GraphEdge[] = [];
    for (const importer of this.importers.get(path) ?? []) {
      const node = this.files.get(importer);
      const rec = node?.imports.find(r => r.resolved === path);
      edges.push({ from: importer, to: path, kind: 'imported_by', provenance: rec?.provenance ?? 'lexical', confidence: rec?.confidence ?? 0.6, line: rec?.line, via: rec?.spec });
    }
    return edges;
  }

  fanIn(path: string): number { return this.importers.get(path)?.size ?? 0; }

  /** Tests for a source file: importers that are tests (0.9) plus naming-convention pairs (0.7). */
  testsFor(path: string): GraphEdge[] {
    const edges = new Map<string, GraphEdge>();
    for (const edge of this.importersOf(path)) {
      if (this.files.get(edge.from)?.role === 'test') edges.set(edge.from, { from: edge.from, to: path, kind: 'tests', provenance: edge.provenance, confidence: 0.9, line: edge.line });
    }
    for (const candidate of this.testStems.get(testStem(path)) ?? []) {
      if (candidate !== path && !edges.has(candidate)) edges.set(candidate, { from: candidate, to: path, kind: 'tests', provenance: 'convention', confidence: 0.7 });
    }
    return [...edges.values()].sort((a, b) => b.confidence - a.confidence || a.from.localeCompare(b.from));
  }

  /** Subjects a test file exercises: what it imports (0.9) plus its convention pair (0.7). */
  subjectsOf(testPath: string): GraphEdge[] {
    const edges = new Map<string, GraphEdge>();
    for (const edge of this.importsOf(testPath)) {
      if (this.files.get(edge.to)?.role === 'source') edges.set(edge.to, { from: testPath, to: edge.to, kind: 'tested_by', provenance: edge.provenance, confidence: 0.9, line: edge.line });
    }
    const stem = testStem(testPath);
    for (const candidate of this.baseNames.get(`${stem}${testPath.slice(testPath.lastIndexOf('.'))}`.toLowerCase()) ?? []) {
      if (!edges.has(candidate) && candidate !== testPath) edges.set(candidate, { from: testPath, to: candidate, kind: 'tested_by', provenance: 'convention', confidence: 0.7 });
    }
    return [...edges.values()];
  }

  definitions(name: string, max = 20): DefinitionHit[] {
    const list = this.symbolIndex.get(name.toLowerCase()) ?? [];
    const hits: DefinitionHit[] = [];
    for (const entry of list) {
      const node = this.files.get(entry.path);
      const symbol = node?.symbols[entry.index];
      if (!node || !symbol) continue;
      const exact = symbol.name === name ? 4 : 0;
      const score = exact + (symbol.exported ? 3 : 0) + (node.role === 'source' ? 2 : node.role === 'test' ? -2 : 0) + (symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'function' ? 1 : 0) - entry.path.split('/').length * 0.05;
      hits.push({ path: entry.path, symbol, role: node.role, score });
    }
    return hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, max);
  }

  symbolsIn(path: string): SymbolRec[] { return this.files.get(path)?.symbols ?? []; }

  /** Files that `symbol` participates in via inheritance: classes extending/implementing the named type. */
  subtypesOf(name: string, max = 50): Array<{ path: string; symbol: SymbolRec; relation: 'extends' | 'implements' }> {
    const out: Array<{ path: string; symbol: SymbolRec; relation: 'extends' | 'implements' }> = [];
    for (const node of this.files.values()) {
      if (!node.indexed) continue;
      for (const symbol of node.symbols) {
        if (symbol.extends?.some(base => base === name || base.endsWith(`.${name}`))) out.push({ path: node.path, symbol, relation: 'extends' });
        else if (symbol.implements?.some(base => base === name || base.endsWith(`.${name}`))) out.push({ path: node.path, symbol, relation: 'implements' });
        if (out.length >= max) return out;
      }
    }
    return out;
  }

  neighbors(path: string, limit = 24): GraphEdge[] {
    const edges = [...this.importsOf(path), ...this.importersOf(path).slice(0, limit), ...this.testsFor(path)];
    return edges.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
  }

  private memoized<T>(key: string, compute: () => T): T {
    const hit = this.memo.get(key);
    if (hit && hit.version === this.version) return hit.value as T;
    const value = compute();
    this.memo.set(key, { version: this.version, value });
    return value;
  }

  /** Top-of-tree manifests (depth ≤ 2), cached per graph version. */
  rootManifests(max = 2): string[] {
    return this.memoized('rootManifests', () => [...this.files.values()].filter(f => f.role === 'manifest' && f.path.split('/').length <= 2).map(f => f.path).sort()).slice(0, max);
  }

  /**
   * Aider-style compact repository map: the files other files depend on most, each with its main exported symbols, packed
   * into a token budget. One screenful that orients a model before it opens anything. `focus` terms (from the task) lift
   * matching files so the map is task-shaped, not just global.
   */
  repoMap(options: { budgetTokens?: number; focus?: readonly string[]; maxSymbolsPerFile?: number } = {}): { text: string; files: number; tokenEstimate: number } {
    const budgetChars = Math.floor((options.budgetTokens ?? 1200) * 3.5);
    const sourceFiles = [...this.files.values()].filter(n => n.indexed && n.role === 'source').length;
    // A handful of files (a single-file app) can afford its whole outline; a large repo gets a one-line gist per file.
    const perFile = options.maxSymbolsPerFile ?? (sourceFiles <= 12 ? 60 : 6);
    const entries = new Set(this.entryPoints(8).map(e => e.path));
    const focus = (options.focus ?? []).map(t => stemNeedle(t.toLowerCase())).filter(t => t.length >= 3);
    const scored: Array<{ path: string; score: number }> = [];
    for (const node of this.files.values()) {
      if (!node.indexed || (node.role !== 'source' && node.role !== 'manifest')) continue;
      let score = Math.log2(1 + this.fanIn(node.path)) * 2 + Math.min(node.symbols.filter(s => s.exported).length, 8) * 0.15;
      if (node.role === 'manifest') score += node.path.split('/').length <= 2 ? 3 : 0.5;
      if (entries.has(node.path)) score += 4;
      const lower = node.path.toLowerCase();
      for (const term of focus) {
        if (lower.includes(term)) score += 4;
        else if (node.symbols.some(s => s.name.toLowerCase().includes(term))) score += 2;
      }
      scored.push({ path: node.path, score: score - node.path.split('/').length * 0.02 });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    const lines: string[] = [];
    let used = 0;
    for (const { path } of scored) {
      const node = this.files.get(path)!;
      const topLevel = node.symbols.filter(s => !s.container);
      const shown = (topLevel.some(s => s.exported) ? topLevel.filter(s => s.exported) : topLevel).slice(0, perFile)
        .map(s => `${['class', 'interface', 'type', 'enum'].includes(s.kind) ? `${s.kind[0]}:` : ''}${s.name}`);
      const line = shown.length ? `${path}: ${shown.join(', ')}` : path;
      if (used + line.length + 1 > budgetChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    return { text: lines.join('\n'), files: lines.length, tokenEstimate: Math.ceil(used / 3.5) };
  }

  /** Entry-like files: high fan-out and little fan-in, manifests' `main`, and conventional entry names. Cached per graph version. */
  entryPoints(max = 12): RankedFile[] {
    return this.memoized('entryPoints', () => this.computeEntryPoints()).slice(0, max);
  }

  private computeEntryPoints(): RankedFile[] {
    const ranked: RankedFile[] = [];
    for (const node of this.files.values()) {
      if (node.role !== 'source') continue;
      const reasons: string[] = [];
      let score = 0;
      if (/(^|\/)(main|index|app|server|cli|extension|__main__|program)\.[a-z]+$/i.test(node.path)) { score += 3; reasons.push('conventional entry name'); }
      const pkg = this.packages.find(p => p.dir === node.pkg);
      if (pkg?.main && node.path === (pkg.dir ? `${pkg.dir}/${pkg.main.replace(/^\.\//, '')}` : pkg.main.replace(/^\.\//, ''))) { score += 4; reasons.push('package main'); }
      const fanOut = node.imports.filter(i => i.resolved).length;
      const fanIn = this.fanIn(node.path);
      if (fanOut >= 5 && fanIn <= 1) { score += 2; reasons.push(`imports ${fanOut} files, imported by ${fanIn}`); }
      if (score > 0) ranked.push({ path: node.path, score: score - node.path.split('/').length * 0.05, reasons });
    }
    return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 64);
  }

  /**
   * Ranks files for a set of lowercase terms by path / symbol / export matches, boosted by centrality (fan-in).
   * Candidates come from an incrementally maintained token index, so the cost follows the number of *matching* tokens, not
   * the size of the repository. Very common tokens ("src", "index") are not indexed; a term made only of those falls back
   * to a bounded linear scan (`deadlineMs`) and returns what it found.
   */
  rankFiles(terms: readonly string[], options: { max?: number; deadlineMs?: number; includeTests?: boolean } = {}): RankedFile[] {
    const needles = terms.map(t => stemNeedle(t.toLowerCase())).filter(t => t.length >= 2);
    if (needles.length === 0) return [];
    const deadline = Date.now() + (options.deadlineMs ?? 250);
    const scores = new Map<string, { score: number; reasons: Set<string>; needles: Set<string> }>();
    let currentNeedle = '';
    const bump = (path: string, amount: number, reason: string): void => {
      const entry = scores.get(path) ?? { score: 0, reasons: new Set<string>(), needles: new Set<string>() };
      entry.score += amount;
      entry.needles.add(currentNeedle);
      if (entry.reasons.size < 4) entry.reasons.add(reason);
      scores.set(path, entry);
    };
    const keysContaining = (map: Map<string, TokenSet>, sub: string): { sets: Array<Set<string>>; stopped: boolean } => {
      const sets: Array<Set<string>> = [];
      let stopped = false;
      for (const [token, entry] of map) {
        if (!token.includes(sub)) continue;
        if (entry === 'stop') stopped = true; else sets.push(entry);
      }
      return { sets, stopped };
    };
    for (const needle of needles) {
      currentNeedle = needle;
      const sub = needle.split(/[^a-z0-9]+/).filter(part => part.length >= 2).sort((a, b) => b.length - a.length)[0] ?? needle;
      // Paths
      const pathHits = keysContaining(this.pathTokens, sub);
      const candidates = new Set<string>();
      for (const set of pathHits.sets) for (const path of set) candidates.add(path);
      if (pathHits.stopped && candidates.size === 0) {
        let counter = 0;
        for (const path of this.files.keys()) {
          if ((++counter & 1023) === 0 && Date.now() > deadline) break;
          if (path.toLowerCase().includes(needle)) candidates.add(path);
        }
      }
      // Rarity weight: a word in a third of all paths ("agent" in an agent framework) says little; a rare one says a lot.
      // Only on repositories big enough for document frequency to mean something.
      const weight = this.files.size >= 50 ? Math.max(0.3, Math.min(1.5, Math.log2((this.files.size + 1) / (candidates.size + 1)) / 5)) : 1;
      for (const path of candidates) {
        const node = this.files.get(path);
        if (!node || node.role === 'generated' || node.role === 'other') continue;
        const lower = path.toLowerCase();
        const at = lower.indexOf(needle);
        if (at >= 0) bump(path, (at >= lower.lastIndexOf('/') ? 3 : 1.5) * weight, `path matches "${needle}"`);
      }
      // Symbols
      const symbolHits = keysContaining(this.symbolTokens, sub);
      const names = new Set<string>();
      for (const set of symbolHits.sets) for (const name of set) names.add(name);
      if (symbolHits.stopped && names.size === 0) {
        let counter = 0;
        for (const name of this.symbolIndex.keys()) {
          if ((++counter & 1023) === 0 && Date.now() > deadline) break;
          if (name.includes(needle)) names.add(name);
        }
      }
      // A file with thirty `task*` symbols is not thirty times more relevant than one with a single `TaskStore`: the best
      // symbol counts in full, further matches add a small, capped amount.
      const bySymbol = new Map<string, { best: number; extra: number; reason: string }>();
      for (const name of names) {
        if (!name.includes(needle)) continue;
        const exact = name === needle;
        for (const entry of (this.symbolIndex.get(name) ?? []).slice(0, 40)) {
          const symbol = this.files.get(entry.path)?.symbols[entry.index];
          if (!symbol) continue;
          const amount = (exact ? 4 : 1.5) + (symbol.exported ? 1 : 0);
          const seen = bySymbol.get(entry.path);
          if (!seen) bySymbol.set(entry.path, { best: amount, extra: 0, reason: `${symbol.kind} ${symbol.name}` });
          else if (amount > seen.best) { seen.extra += seen.best * 0.15; seen.best = amount; seen.reason = `${symbol.kind} ${symbol.name}`; }
          else seen.extra += amount * 0.15;
        }
      }
      for (const [path, hit] of bySymbol) bump(path, (hit.best + Math.min(hit.extra, 2)) * weight, hit.reason);
    }
    const out: RankedFile[] = [];
    for (const [path, entry] of scores) {
      const node = this.files.get(path)!;
      if (node.role === 'test' && !options.includeTests) entry.score -= 2;
      if (node.role === 'doc') entry.score -= 1;
      // Matching several different question words (TaskStore.ts for "task" + "store") is the strongest signal there is.
      if (entry.needles.size > 1) entry.score += (entry.needles.size - 1) * 3;
      const fanIn = this.fanIn(path);
      entry.score += Math.log2(1 + fanIn) * 0.6;
      if (fanIn >= 3) entry.reasons.add(`imported by ${fanIn} files`);
      out.push({ path, score: entry.score, reasons: [...entry.reasons] });
    }
    return out.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, options.max ?? 20);
  }

  stats(): GraphStats {
    let indexed = 0;
    let imports = 0;
    let resolved = 0;
    for (const node of this.files.values()) {
      if (node.indexed) indexed++;
      imports += node.imports.length;
      for (const rec of node.imports) if (rec.resolved) resolved++;
    }
    let maxFanIn = 0;
    for (const set of this.importers.values()) if (set.size > maxFanIn) maxFanIn = set.size;
    return { files: this.files.size, indexedFiles: indexed, symbols: this.symbolCount, imports, resolvedImports: resolved, packages: this.packages.length, maxFanIn };
  }
}
