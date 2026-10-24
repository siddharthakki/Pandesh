import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as sqlite3 from '@vscode/sqlite3';
import * as ts from 'typescript';
import {
  RepositoryIdentity,
  RepositoryFileRecord,
  RepositoryIndexSnapshot,
  RepositorySymbol,
} from './RepositoryTypes';

const execFileAsync = promisify(execFile);
const SCHEMA_VERSION = 3;
const LEGACY_SCHEMA_VERSION = 2;

export const DEFAULT_IGNORED = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.next',
  '.gradle', '.idea', '.vscode-test', '__pycache__', '.pytest_cache',
  '.ollama-agent', 'target', 'bin', 'obj', 'vendor',
  // Environments, dependency trees and tool caches: large enough to exhaust
  // the inventory cap before the project's own source is reached.
  '.venv', 'venv', '.tox', '.nox', 'site-packages', 'bower_components',
  '.mypy_cache', '.ruff_cache', '.cache', '.parcel-cache', '.turbo',
  '.nuxt', '.svelte-kit', '.angular', '.dart_tool', '.terraform', '.vs',
]);

export const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.jsonc', '.md',
  '.py', '.java', '.kt', '.kts', '.go', '.rs', '.cs', '.cpp', '.cc', '.c',
  '.h', '.hpp', '.html', '.css', '.scss', '.less', '.yaml', '.yml', '.toml',
  '.xml', '.gradle', '.properties', '.sh', '.ps1', '.sql', '.graphql', '.vue',
  '.svelte', '.dart', '.rb', '.php', '.swift', '.txt',
]);

export const CONFIG_NAMES = new Set([
  'package.json', 'tsconfig.json', 'jsconfig.json', 'vite.config.ts',
  'vitest.config.ts', 'jest.config.js', 'pyproject.toml', 'cargo.toml', 'go.mod',
  'build.gradle', 'settings.gradle', 'pom.xml', 'dockerfile', 'docker-compose.yml',
  '.gitignore', '.eslintrc', '.prettierrc', 'readme.md',
]);

const SENSITIVE_PATH = /(^|\/)(\.env|.*\.secret|.*\.pem|.*\.key|id_rsa|id_dsa|credentials|secrets?)(\.|\/|$)/i;
const MAX_FTS_FIELD_CHARS = 12_000;

export interface RepositoryIndexOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  cacheMaxAgeMs?: number;
  ignoredDirs?: string[];
  storagePath?: string;
  /** How long one SQLite statement waits for another connection's lock before failing as busy. Default 5000. */
  busyTimeoutMs?: number;
}

/**
 * The index store was locked by another connection for longer than the busy timeout. Distinct from a corrupt or
 * unreadable store so callers can degrade (repository context unavailable) without treating it as data loss.
 */
export class RepositoryIndexBusyError extends Error {
  readonly code = 'repository_index_busy';
  constructor(detail: string) {
    super(`repository_index_busy: the repository index is locked by another connection, for example another KarkeDikha window (${detail})`);
    this.name = 'RepositoryIndexBusyError';
  }
}

/**
 * SQLite allows one writer per database. Within this process, every write-capable operation on a given store is
 * queued here instead of racing over the file lock, so two RepositoryIndex instances (Baat, Saath and Karke each
 * build their own service) never contend with each other. Cross-process contention (a second VS Code window) is left
 * to SQLite's WAL and busy timeout, which only works if no connection holds a write lock longer than it must.
 */
const storageGates = new Map<string, Promise<void>>();

function serializeStorageWrites<T>(storage: string, operation: () => Promise<T>): Promise<T> {
  const previous = storageGates.get(storage) ?? Promise.resolve();
  const run = previous.then(operation);
  const tail = run.then(() => undefined, () => undefined);
  storageGates.set(storage, tail);
  void tail.then(() => { if (storageGates.get(storage) === tail) storageGates.delete(storage); });
  return run;
}

/** Whether this SQLite build ships FTS5. A compile-time fact: asked once per process, read-only, takes no lock. */
let fts5CompiledIn: boolean | undefined;

type SqlParams = Record<string, unknown> | unknown[];

export function normalize(candidate: string): string {
  return candidate.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function languageFor(extension: string): string {
  const mapping: Record<string, string> = {
    '.ts': 'typescript', '.tsx': 'typescript-react', '.js': 'javascript',
    '.jsx': 'javascript-react', '.mjs': 'javascript', '.cjs': 'javascript',
    '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin',
    '.go': 'go', '.rs': 'rust', '.cs': 'csharp', '.cpp': 'cpp', '.cc': 'cpp',
    '.c': 'c', '.h': 'c', '.hpp': 'cpp', '.json': 'json', '.jsonc': 'jsonc',
    '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown',
    '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql',
  };
  return mapping[extension] ?? (extension.replace(/^\./, '') || 'text');
}

export function isTestPath(relativePath: string): boolean {
  return /(^|\/)(__tests__|tests?|spec)(\/|$)/i.test(relativePath)
    || /(?:\.test|\.spec|_test|test_)\.[^.]+$/i.test(relativePath)
    || /(^|\/)test_[^/]+\.py$/i.test(relativePath);
}

export function isGeneratedPath(relativePath: string): boolean {
  return /(^|\/)(generated|gen|dist|out|build)(\/|$)/i.test(relativePath)
    || /(?:\.g|\.generated|\.designer)\.[^.]+$/i.test(relativePath);
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function tsKindFromName(node: ts.Node): RepositorySymbol['kind'] | undefined {
  if (ts.isClassDeclaration(node)) return 'class';
  if (ts.isInterfaceDeclaration(node)) return 'interface';
  if (ts.isTypeAliasDeclaration(node)) return 'type';
  if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) return 'function';
  if (ts.isVariableDeclaration(node)) return 'constant';
  return undefined;
}

function tsKindForNode(node: ts.Node): RepositorySymbol['kind'] | undefined {
  if (ts.isMethodDeclaration(node)) return 'method';
  return tsKindFromName(node);
}

function sourceKindFor(extension: string): ts.ScriptKind {
  switch (extension) {
    case '.tsx': return ts.ScriptKind.TSX;
    case '.jsx': return ts.ScriptKind.JSX;
    case '.js':
    case '.mjs':
    case '.cjs': return ts.ScriptKind.JS;
    default: return ts.ScriptKind.TS;
  }
}

function hasExportModifier(node: ts.Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(modifier =>
    modifier.kind === ts.SyntaxKind.ExportKeyword || modifier.kind === ts.SyntaxKind.DefaultKeyword));
}

function namedText(name: ts.PropertyName | ts.BindingName | ts.ModuleName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

export function extractTsJsStructure(content: string, relativePath: string): {
  symbols: RepositorySymbol[];
  imports: string[];
  exports: string[];
} {
  const extension = path.extname(relativePath).toLowerCase();
  const sourceFile = ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, sourceKindFor(extension));
  const symbols: RepositorySymbol[] = [];
  const imports = new Set<string>();
  const exports = new Set<string>();

  const addSymbol = (node: ts.Node, name: string | undefined) => {
    const kind = tsKindForNode(node);
    if (!kind || !name || symbols.length >= 100) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    const exported = hasExportModifier(node);
    symbols.push({ name, kind, line: line + 1, exported });
    if (exported) exports.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.add(node.moduleSpecifier.text);
      for (const element of node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : []) {
        exports.add(element.name.text);
      }
    } else if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require'
      && node.arguments.length === 1
      && ts.isStringLiteralLike(node.arguments[0])) {
      imports.add(node.arguments[0].text);
    } else if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isFunctionDeclaration(node)) {
      addSymbol(node, node.name?.text);
    } else if (ts.isMethodDeclaration(node)) {
      addSymbol(node, namedText(node.name));
    } else if (ts.isVariableStatement(node)) {
      const exported = hasExportModifier(node);
      for (const declaration of node.declarationList.declarations) {
        const name = namedText(declaration.name);
        if (!name || symbols.length >= 100) continue;
        const { line } = sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile));
        symbols.push({ name, kind: 'constant', line: line + 1, exported });
        if (exported) exports.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return { symbols, imports: [...imports].slice(0, 100), exports: [...exports].slice(0, 100) };
}

export function extractLexicalImports(content: string): string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /^\s*from\s+([\w.]+)\s+import\s+/gm,
    /^\s*import\s+([\w.]+)\s*;?$/gm,
    /^\s*use\s+([\w:]+)\s*;/gm,
  ];
  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null && imports.size < 100) imports.add(match[1]);
  }
  return [...imports];
}

export function summaryFor(content: string, symbols: RepositorySymbol[], relativePath: string): string {
  const firstMeaningful = content
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('import ') && !line.startsWith('export '));
  const symbolSummary = symbols.slice(0, 8).map(symbol => `${symbol.kind} ${symbol.name}`).join(', ');
  return [relativePath, symbolSummary, firstMeaningful?.slice(0, 160)]
    .filter(Boolean)
    .join(' - ');
}

function stripSensitiveText(content: string): string {
  return content
    .split('\n')
    .filter(line => !/\b(api[_-]?key|token|secret|password|private[_-]?key)\b\s*[:=]/i.test(line))
    .join('\n');
}

function extractComments(content: string): string {
  const comments = [
    ...(content.match(/\/\*[\s\S]*?\*\//g) ?? []),
    ...(content.match(/^\s*\/\/.*$/gm) ?? []),
    ...(content.match(/^\s*#.*$/gm) ?? []),
    ...(content.match(/<!--[\s\S]*?-->/g) ?? []),
  ];
  return comments.join('\n');
}

function extractTestNames(content: string): string[] {
  const names = new Set<string>();
  const regex = /\b(?:it|test|describe)\s*\(\s*['"`]([^'"`]{1,160})['"`]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null && names.size < 100) names.add(match[1]);
  return [...names];
}

function extractJsonKeys(content: string): string[] {
  try {
    const parsed = JSON.parse(stripJsonCommentsForIndex(content)) as unknown;
    const keys: string[] = [];
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object' || keys.length >= 200) return;
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        keys.push(key);
        visit(child);
      }
    };
    visit(parsed);
    return keys;
  } catch {
    return [];
  }
}

function stripJsonCommentsForIndex(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
}

function packageAndCommandText(relativePath: string, content: string): string {
  if (path.basename(relativePath).toLowerCase() !== 'package.json') return '';
  try {
    const parsed = JSON.parse(content) as { name?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    return [
      parsed.name,
      ...Object.keys(parsed.scripts ?? {}),
      ...Object.values(parsed.scripts ?? {}),
      ...Object.keys(parsed.dependencies ?? {}),
      ...Object.keys(parsed.devDependencies ?? {}),
    ].filter(Boolean).join('\n');
  } catch {
    return '';
  }
}

function bounded(value: string): string {
  return value.replace(/\0/g, '').slice(0, MAX_FTS_FIELD_CHARS);
}

function ftsTextFor(file: RepositoryFileRecord, content: string): {
  symbols: string;
  relationships: string;
  searchableText: string;
} {
  const symbolText = file.symbols.map(symbol => `${symbol.kind} ${symbol.name}${symbol.exported ? ' exported' : ''}`).join('\n');
  const relationships = [
    ...file.imports.map(specifier => `import ${specifier}`),
    ...(file.exports ?? []).map(name => `export ${name}`),
    ...file.dependencies.map(dependency => `dependency ${dependency}`),
    ...file.linkedTests.map(test => `test ${test}`),
  ].join('\n');
  const eligibleForText = content && !file.deleted && !file.stale && !file.isGenerated && !SENSITIVE_PATH.test(file.path);
  const safeContent = eligibleForText ? stripSensitiveText(content) : '';
  const searchableText = [
    path.basename(file.path),
    file.path,
    ...extractTestNames(safeContent),
    ...extractJsonKeys(safeContent),
    packageAndCommandText(file.path, safeContent),
    extractComments(safeContent),
    safeContent,
    file.summary,
  ].filter(Boolean).join('\n');
  return {
    symbols: bounded(symbolText),
    relationships: bounded(relationships),
    searchableText: bounded(searchableText),
  };
}

function ignorePatternMatches(relativePath: string, pattern: string): boolean {
  let normalized = normalize(pattern.trim());
  if (!normalized || normalized.startsWith('#')) return false;
  if (normalized.startsWith('!')) normalized = normalized.slice(1);
  normalized = normalized.replace(/^\//, '');
  const directoryPattern = normalized.endsWith('/');
  normalized = normalized.replace(/\/$/, '');
  const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regexBody = escaped
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/::DOUBLE_STAR::/g, '.*');
  const anchored = pattern.trim().startsWith('/');
  const prefix = anchored ? '^' : '(^|/)';
  const suffix = directoryPattern ? '($|/)' : '$';
  return new RegExp(`${prefix}${regexBody}${suffix}`).test(relativePath);
}

function cancelled(signal?: AbortSignal): boolean {
  return Boolean(signal?.aborted);
}

export function resolveImportGraph(records: RepositoryFileRecord[]): void {
  const byPath = new Map(records.map(record => [record.path, record]));
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.java', '.kt', '.go', '.rs', '.cs'];
  for (const record of records) {
    const directory = path.posix.dirname(record.path);
    for (const imported of record.imports) {
      if (!imported.startsWith('.')) continue;
      const base = normalize(path.posix.normalize(path.posix.join(directory, imported)));
      const candidates = extensions.flatMap(extension => [`${base}${extension}`, `${base}/index${extension}`]);
      const resolved = candidates.find(candidate => byPath.has(candidate));
      if (resolved && !record.dependencies.includes(resolved)) record.dependencies.push(resolved);
    }
  }

  const tests = records.filter(record => record.isTest);
  for (const source of records.filter(record => !record.isTest)) {
    const sourceStem = path.posix.basename(source.path, source.extension).toLowerCase();
    source.linkedTests = tests
      .filter(test => {
        const testStem = path.posix.basename(test.path, test.extension)
          .toLowerCase()
          .replace(/(?:\.test|\.spec|_test)$/i, '')
          .replace(/^test_/, '');
        return testStem === sourceStem;
      })
      .map(test => test.path);
  }
}

export class RepositoryIndex {
  private memory?: RepositoryIndexSnapshot;
  private paused = false;
  private readonly searchableContentByPath = new Map<string, string>();
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly cacheMaxAgeMs: number;
  private readonly ignoredDirs: Set<string>;
  private readonly storage: string;
  private fts5Available = false;
  private incrementalRefresh = false;
  private readonly busyTimeoutMs: number;

  constructor(private readonly workspaceRoot: string, options: RepositoryIndexOptions = {}) {
    this.maxFiles = options.maxFiles ?? 5000;
    this.maxFileBytes = options.maxFileBytes ?? 256_000;
    this.cacheMaxAgeMs = options.cacheMaxAgeMs ?? 60_000;
    this.ignoredDirs = new Set([...DEFAULT_IGNORED, ...(options.ignoredDirs ?? [])]);
    this.storage = options.storagePath ?? path.join(workspaceRoot, '.ollama-agent', 'index', 'repository-intelligence.sqlite');
    this.busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  }

  async build(force = false, signal?: AbortSignal): Promise<RepositoryIndexSnapshot> {
    const identity = await this.resolveIdentity();
    if (this.paused && this.memory) {
      this.memory = { ...this.memory, state: 'paused' };
      return this.memory;
    }
    if (!force && this.memory && this.isCurrentForIdentity(this.memory, identity)) return this.memory;

    const stored = await this.readSnapshot(identity);

    if (!force && !this.incrementalRefresh) {
      if (stored && this.isCurrentForIdentity(stored, identity)) {
        this.memory = stored;
        return stored;
      }
    }

    const previous = stored;
    const previousByPath = new Map((previous?.files ?? []).map(file => [file.path, file]));
    this.searchableContentByPath.clear();
    const ignorePatterns = await this.readIgnorePatterns();
    const records: RepositoryFileRecord[] = [];
    const absoluteFiles: string[] = [];
    let truncated = false;

    const walk = async (directory: string): Promise<void> => {
      if (cancelled(signal)) throw new Error('indexing_cancelled');
      if (absoluteFiles.length >= this.maxFiles) { truncated = true; return; }
      let entries: Dirent[];
      try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (cancelled(signal)) throw new Error('indexing_cancelled');
        if (absoluteFiles.length >= this.maxFiles) { truncated = true; return; }
        const absolute = path.join(directory, entry.name);
        const relative = normalize(path.relative(this.workspaceRoot, absolute));
        if (this.shouldIgnore(relative, entry.isDirectory(), ignorePatterns)) continue;
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) absoluteFiles.push(absolute);
      }
    };

    await walk(this.workspaceRoot);

    for (const absolutePath of absoluteFiles) {
      if (cancelled(signal)) throw new Error('indexing_cancelled');
      const relativePath = normalize(path.relative(this.workspaceRoot, absolutePath));
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try { stat = await fs.stat(absolutePath); } catch { continue; }
      const extension = path.extname(relativePath).toLowerCase();
      const basename = path.basename(relativePath).toLowerCase();
      const textEligible = TEXT_EXTENSIONS.has(extension) || CONFIG_NAMES.has(basename) || stat.size === 0;
      let content = '';
      if (textEligible && stat.size <= this.maxFileBytes) {
        try { content = await fs.readFile(absolutePath, 'utf8'); } catch { content = ''; }
      }
      this.searchableContentByPath.set(relativePath, content);
      const contentHash = content ? sha256(content) : undefined;
      const reusable = previousByPath.get(relativePath);
      if ((!force || this.incrementalRefresh) && reusable?.contentHash && reusable.contentHash === contentHash && reusable.size === stat.size) {
        records.push({ ...reusable, absolutePath, modifiedAt: stat.mtimeMs, stale: false, deleted: false });
        continue;
      }
      const structural = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension);
      const parsed = content && structural ? extractTsJsStructure(content, relativePath) : undefined;
      const symbols = parsed?.symbols ?? [];
      records.push({
        path: relativePath,
        absolutePath,
        extension,
        language: languageFor(extension),
        size: stat.size,
        modifiedAt: stat.mtimeMs,
        isTest: isTestPath(relativePath),
        isConfig: CONFIG_NAMES.has(basename) || /(^|\/)(\.github|config)(\/|$)/i.test(relativePath),
        isGenerated: isGeneratedPath(relativePath),
        symbols,
        imports: parsed?.imports ?? (content ? extractLexicalImports(content) : []),
        exports: parsed?.exports ?? [],
        dependencies: [],
        linkedTests: [],
        summary: content ? summaryFor(content, symbols, relativePath) : relativePath,
        contentHash,
        indexedAt: new Date().toISOString(),
        stale: false,
        deleted: false,
        parseStatus: structural ? 'structural' : content ? 'lexical' : 'unavailable',
      });
    }

    this.resolveGraph(records);
    const present = new Set(records.map(record => record.path));
    const deletedRecords = (previous?.files ?? [])
      .filter(record => !present.has(record.path))
      .map(record => ({ ...record, deleted: true, stale: true }));
    const allRecords = [...records, ...deletedRecords];
    const now = new Date().toISOString();
    const snapshot: RepositoryIndexSnapshot = {
      schemaVersion: LEGACY_SCHEMA_VERSION,
      workspaceRoot: this.workspaceRoot,
      identity,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      state: 'ready',
      files: allRecords,
      ignoredPatterns: ignorePatterns,
      truncated,
      statistics: this.statistics(allRecords, previous?.files ?? []),
      pins: previous?.pins ?? [],
      exclusions: previous?.exclusions ?? [],
    };

    await this.writeSnapshot(snapshot, signal);
    this.memory = snapshot;
    return snapshot;
  }

  async status(): Promise<RepositoryIndexSnapshot> {
    return this.build(false);
  }

  pause(): void {
    this.paused = true;
    if (this.memory) this.memory = { ...this.memory, state: 'paused' };
  }

  resume(): void {
    this.paused = false;
    if (this.memory?.state === 'paused') this.memory = { ...this.memory, state: 'stale' };
  }

  async pin(relativePath: string): Promise<RepositoryIndexSnapshot> {
    const snapshot = await this.build(false);
    snapshot.pins = [...new Set([...snapshot.pins, normalize(relativePath)])];
    await this.writeSnapshot(snapshot);
    this.memory = snapshot;
    return snapshot;
  }

  async exclude(relativePath: string): Promise<RepositoryIndexSnapshot> {
    const snapshot = await this.build(false);
    snapshot.exclusions = [...new Set([...snapshot.exclusions, normalize(relativePath)])];
    await this.writeSnapshot(snapshot);
    this.memory = snapshot;
    return snapshot;
  }

  async clearPins(): Promise<RepositoryIndexSnapshot> {
    const snapshot = await this.build(false);
    snapshot.pins = [];
    await this.writeSnapshot(snapshot);
    this.memory = snapshot;
    return snapshot;
  }

  async searchSymbols(query: string): Promise<Array<{ file: string; symbol: RepositorySymbol }>> {
    const normalizedQuery = query.toLowerCase();
    const snapshot = await this.build();
    return snapshot.files
      .flatMap(file => file.symbols
        .filter(symbol => symbol.name.toLowerCase().includes(normalizedQuery))
        .map(symbol => ({ file: file.path, symbol })))
      .slice(0, 100);
  }

  getStoragePath(): string {
    return this.storage;
  }

  isSqliteAvailable(): boolean {
    return true;
  }

  isFts5Available(): boolean {
    return this.fts5Available;
  }

  async reconcileStartup(): Promise<RepositoryIndexSnapshot> {
    this.memory = undefined;
    this.incrementalRefresh = true;
    try {
      return await this.build(false);
    } finally {
      this.incrementalRefresh = false;
    }
  }

  async updateChangedFiles(paths: string[], signal?: AbortSignal): Promise<RepositoryIndexSnapshot> {
    if (cancelled(signal)) throw new Error('indexing_cancelled');
    if (paths.length === 0) return this.build(false);
    this.memory = undefined;
    this.incrementalRefresh = true;
    try {
      return await this.build(false, signal);
    } finally {
      this.incrementalRefresh = false;
    }
  }

  private async openDatabase(): Promise<sqlite3.Database> {
    await fs.mkdir(path.dirname(this.storage), { recursive: true });
    try {
      const handle = await fs.open(this.storage, 'r');
      let corrupt = false;
      try {
        const buffer = Buffer.alloc(16);
        const read = await handle.read(buffer, 0, 16, 0);
        corrupt = read.bytesRead > 0 && buffer.toString('utf8', 0, Math.min(16, read.bytesRead)) !== 'SQLite format 3\0';
      } finally {
        await handle.close();
      }
      if (corrupt) await this.quarantineCorruptDatabase();
    } catch {
      /* database does not exist yet */
    }
    return new Promise((resolve, reject) => {
      const db = new sqlite3.Database(
        this.storage,
        sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE | sqlite3.OPEN_FULLMUTEX,
        error => error ? reject(error) : resolve(db),
      );
    });
  }

  private async withDatabase<T>(callback: (db: sqlite3.Database) => Promise<T>): Promise<T> {
    let db = await this.openDatabase();
    let closed = false;
    try {
      return await callback(db);
    } catch (error) {
      if (this.isCorruptError(error)) {
        await this.close(db);
        closed = true;
        await this.quarantineCorruptDatabase();
        db = await this.openDatabase();
        closed = false;
        return callback(db);
      }
      throw this.isBusyError(error) ? new RepositoryIndexBusyError(error instanceof Error ? error.message : String(error)) : error;
    } finally {
      if (!closed) await this.close(db).catch(() => undefined);
    }
  }

  private isBusyError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(message);
  }

  private isCorruptError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return /SQLITE_(CORRUPT|NOTADB)|file is not a database|database disk image is malformed/i.test(message);
  }

  private async quarantineCorruptDatabase(): Promise<void> {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      const source = `${this.storage}${suffix}`;
      try { await fs.rename(source, `${source}.corrupt-${stamp}`); } catch { /* best effort */ }
    }
    this.memory = undefined;
  }

  private run(db: sqlite3.Database, sql: string, params?: SqlParams): Promise<void> {
    return new Promise((resolve, reject) => {
      const callback = (error: Error | null) => error ? reject(error) : resolve();
      params === undefined ? db.run(sql, callback) : db.run(sql, params, callback);
    });
  }

  private get<T>(db: sqlite3.Database, sql: string, params?: SqlParams): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const callback = (error: Error | null, row: T | undefined) => error ? reject(error) : resolve(row);
      params === undefined ? db.get(sql, callback) : db.get(sql, params, callback);
    });
  }

  private all<T>(db: sqlite3.Database, sql: string, params?: SqlParams): Promise<T[]> {
    return new Promise((resolve, reject) => {
      const callback = (error: Error | null, rows: T[]) => error ? reject(error) : resolve(rows);
      params === undefined ? db.all(sql, callback) : db.all(sql, params, callback);
    });
  }

  private exec(db: sqlite3.Database, sql: string): Promise<void> {
    return new Promise((resolve, reject) => db.exec(sql, error => error ? reject(error) : resolve()));
  }

  private close(db: sqlite3.Database): Promise<void> {
    return new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
  }

  /**
   * Prepares a connection. A store that is already at the current schema is opened WITHOUT taking any write lock:
   * no `BEGIN IMMEDIATE`, no DDL, no probe table. Only a missing or older schema runs the migration, and that runs
   * under the process write gate. Every read used to take the writer lock through this method, which is what let
   * two windows (or two services) starve each other.
   */
  private async initialize(db: sqlite3.Database): Promise<void> {
    db.configure('busyTimeout', this.busyTimeoutMs);
    await this.run(db, 'PRAGMA foreign_keys = ON');
    await this.run(db, `PRAGMA busy_timeout = ${Math.floor(this.busyTimeoutMs)}`);
    this.fts5Available = await this.probeFts5(db);
    if (await this.schemaIsCurrent(db)) {
      await this.assertForeignKeys(db);
      return;
    }
    await serializeStorageWrites(this.storage, async () => {
      // Another caller may have finished the migration while this one waited its turn.
      if (await this.schemaIsCurrent(db)) return;
      const mode = await this.get<{ journal_mode: string }>(db, 'PRAGMA journal_mode');
      if (mode?.journal_mode?.toLowerCase() !== 'wal') {
        const switched = await this.get<{ journal_mode: string }>(db, 'PRAGMA journal_mode = WAL');
        if (!switched?.journal_mode) await this.run(db, 'PRAGMA journal_mode = DELETE');
      }
      await this.migrateSchema(db);
    });
    await this.assertForeignKeys(db);
  }

  private async assertForeignKeys(db: sqlite3.Database): Promise<void> {
    const fk = await this.get<{ foreign_keys: number }>(db, 'PRAGMA foreign_keys');
    if (fk?.foreign_keys !== 1) throw new Error('SQLite foreign keys are not enabled');
  }

  /** Read-only: true when the schema table exists at exactly the supported version (a newer one is an error). */
  private async schemaIsCurrent(db: sqlite3.Database): Promise<boolean> {
    const table = await this.get<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'");
    if (!table) return false;
    const row = await this.get<{ version: number | null }>(db, 'SELECT max(version) AS version FROM schema_migrations');
    const version = row?.version ?? 0;
    if (version > SCHEMA_VERSION) {
      throw new Error(`index_schema_mismatch: database schema ${version} is newer than supported ${SCHEMA_VERSION}`);
    }
    if (version < SCHEMA_VERSION) return false;
    if (this.fts5Available) {
      const fts = await this.get<{ name: string }>(db, "SELECT name FROM sqlite_master WHERE name = 'file_fts'");
      if (!fts) return false;
    }
    return true;
  }

  private async migrateSchema(db: sqlite3.Database): Promise<void> {
    await this.exec(db, 'BEGIN IMMEDIATE');
    try {
      await this.exec(db, `
CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS snapshots(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_root TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_commit TEXT NOT NULL,
  worktree TEXT NOT NULL,
  detached INTEGER NOT NULL,
  git_root TEXT,
  git_common_dir TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  state TEXT NOT NULL,
  stale_reason TEXT,
  failure_code TEXT,
  ignored_patterns TEXT NOT NULL,
  truncated INTEGER NOT NULL,
  pins TEXT NOT NULL,
  exclusions TEXT NOT NULL,
  statistics TEXT NOT NULL,
  UNIQUE(workspace_root, branch, head_commit, worktree)
);
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  absolute_path TEXT NOT NULL,
  extension TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified_at REAL NOT NULL,
  is_test INTEGER NOT NULL,
  is_config INTEGER NOT NULL,
  is_generated INTEGER NOT NULL,
  summary TEXT NOT NULL,
  content_hash TEXT,
  indexed_at TEXT,
  stale INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  parse_status TEXT,
  UNIQUE(snapshot_id, path)
);
CREATE TABLE IF NOT EXISTS symbols(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS imports(file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, specifier TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exports(file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS dependencies(file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, dependency_path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS linked_tests(file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE, test_path TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_snapshots_identity ON snapshots(workspace_root, branch, head_commit, worktree);
CREATE INDEX IF NOT EXISTS idx_files_snapshot_path ON files(snapshot_id, path);
CREATE INDEX IF NOT EXISTS idx_symbols_file_name ON symbols(file_id, name);
CREATE INDEX IF NOT EXISTS idx_imports_file ON imports(file_id);
`);
      if (this.fts5Available) {
        const ftsColumns = await this.all<{ name: string }>(db, 'PRAGMA table_info(file_fts)').catch(() => []);
        if (ftsColumns.length > 0 && !ftsColumns.some(column => column.name === 'searchable_text')) {
          await this.run(db, 'DROP TABLE IF EXISTS file_fts');
        }
        await this.run(db, 'CREATE VIRTUAL TABLE IF NOT EXISTS file_fts USING fts5(path, symbols, relationships, searchable_text, summary, content_hash UNINDEXED)');
      }
      await this.run(db, 'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)', [SCHEMA_VERSION, new Date().toISOString()]);
      await this.exec(db, 'COMMIT');
    } catch (error) {
      await this.exec(db, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async probeFts5(db: sqlite3.Database): Promise<boolean> {
    if (fts5CompiledIn !== undefined) return fts5CompiledIn;
    try {
      // Read-only and lock-free. The previous probe created and dropped a virtual table on every connection, which
      // is two schema writes per open and made even a pure read contend for the writer lock.
      const row = await this.get<{ enabled: number }>(db, "SELECT sqlite_compileoption_used('ENABLE_FTS5') AS enabled");
      fts5CompiledIn = row?.enabled === 1;
    } catch {
      fts5CompiledIn = false;
    }
    return fts5CompiledIn;
  }

  private async migrateLegacyJson(db: sqlite3.Database): Promise<void> {
    const legacy = path.join(this.workspaceRoot, '.ollama-agent', 'index', 'repository-index.json');
    try {
      await fs.access(legacy);
    } catch {
      return;
    }
    const migrated = `${legacy}.migrated`;
    try {
      await fs.access(migrated);
      return;
    } catch { /* continue */ }
    let snapshot: RepositoryIndexSnapshot;
    try {
      snapshot = JSON.parse(await fs.readFile(legacy, 'utf8')) as RepositoryIndexSnapshot;
    } catch {
      await fs.rename(legacy, `${legacy}.malformed-${Date.now()}`);
      return;
    }
    if (snapshot?.workspaceRoot !== this.workspaceRoot || !Array.isArray(snapshot.files) || !snapshot.identity?.branch) return;
    await this.persistSnapshot(db, snapshot);
    await fs.rename(legacy, migrated).catch(() => undefined);
  }

  private async readSnapshot(identity: RepositoryIdentity): Promise<RepositoryIndexSnapshot | null> {
    return this.withDatabase(async db => {
      await this.initialize(db);
      await this.migrateLegacyJson(db);
      const snapshotRow = await this.get<{ id: number; [key: string]: unknown }>(db, `
SELECT * FROM snapshots WHERE workspace_root = ? AND branch = ? AND head_commit = ? AND worktree = ?
`, [this.workspaceRoot, identity.branch, identity.headCommit, identity.worktree]);
      if (!snapshotRow) return null;
      return this.snapshotFromRow(db, snapshotRow);
    });
  }

  private async writeSnapshot(snapshot: RepositoryIndexSnapshot, signal?: AbortSignal): Promise<void> {
    if (cancelled(signal)) throw new Error('indexing_cancelled');
    await this.withDatabase(async db => {
      await this.initialize(db);
      await serializeStorageWrites(this.storage, async () => {
        if (cancelled(signal)) throw new Error('indexing_cancelled');
        await this.exec(db, 'BEGIN IMMEDIATE');
        try {
          if (cancelled(signal)) throw new Error('indexing_cancelled');
          await this.persistSnapshot(db, snapshot);
          await this.exec(db, 'COMMIT');
        } catch (error) {
          await this.exec(db, 'ROLLBACK').catch(() => undefined);
          throw error;
        }
      });
    });
  }

  private async persistSnapshot(db: sqlite3.Database, snapshot: RepositoryIndexSnapshot): Promise<void> {
    await this.run(db, `
INSERT INTO snapshots(workspace_root, branch, head_commit, worktree, detached, git_root, git_common_dir, created_at, updated_at, state, stale_reason, failure_code, ignored_patterns, truncated, pins, exclusions, statistics)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_root, branch, head_commit, worktree) DO UPDATE SET
detached=excluded.detached, git_root=excluded.git_root, git_common_dir=excluded.git_common_dir,
created_at=excluded.created_at, updated_at=excluded.updated_at, state=excluded.state,
stale_reason=excluded.stale_reason, failure_code=excluded.failure_code, ignored_patterns=excluded.ignored_patterns,
truncated=excluded.truncated, pins=excluded.pins, exclusions=excluded.exclusions, statistics=excluded.statistics
`, [
      snapshot.workspaceRoot, snapshot.identity.branch, snapshot.identity.headCommit, snapshot.identity.worktree,
      snapshot.identity.detached ? 1 : 0, snapshot.identity.gitRoot ?? null, snapshot.identity.gitCommonDir ?? null,
      snapshot.createdAt, snapshot.updatedAt, snapshot.state, snapshot.staleReason ?? null, snapshot.failureCode ?? null,
      JSON.stringify(snapshot.ignoredPatterns), snapshot.truncated ? 1 : 0, JSON.stringify(snapshot.pins),
      JSON.stringify(snapshot.exclusions), JSON.stringify(snapshot.statistics),
    ]);
    const row = await this.get<{ id: number }>(db, 'SELECT id FROM snapshots WHERE workspace_root = ? AND branch = ? AND head_commit = ? AND worktree = ?', [
      snapshot.workspaceRoot, snapshot.identity.branch, snapshot.identity.headCommit, snapshot.identity.worktree,
    ]);
    if (!row) throw new Error('snapshot write failed');
    await this.run(db, 'DELETE FROM files WHERE snapshot_id = ?', [row.id]);
    if (this.fts5Available) await this.run(db, 'DELETE FROM file_fts');
    for (const file of snapshot.files) {
      await this.run(db, `
INSERT INTO files(snapshot_id, path, absolute_path, extension, language, size, modified_at, is_test, is_config, is_generated, summary, content_hash, indexed_at, stale, deleted, parse_status)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, [
        row.id, file.path, file.absolutePath, file.extension, file.language, file.size, file.modifiedAt,
        file.isTest ? 1 : 0, file.isConfig ? 1 : 0, file.isGenerated ? 1 : 0, file.summary,
        file.contentHash ?? null, file.indexedAt ?? null, file.stale ? 1 : 0, file.deleted ? 1 : 0, file.parseStatus ?? null,
      ]);
      const fileRow = await this.get<{ id: number }>(db, 'SELECT id FROM files WHERE snapshot_id = ? AND path = ?', [row.id, file.path]);
      if (!fileRow) continue;
      for (const symbol of file.symbols) {
        await this.run(db, 'INSERT INTO symbols(file_id, name, kind, line, exported) VALUES (?, ?, ?, ?, ?)', [
          fileRow.id, symbol.name, symbol.kind, symbol.line, symbol.exported ? 1 : 0,
        ]);
      }
      for (const specifier of file.imports) await this.run(db, 'INSERT INTO imports(file_id, specifier) VALUES (?, ?)', [fileRow.id, specifier]);
      for (const name of file.exports ?? []) await this.run(db, 'INSERT INTO exports(file_id, name) VALUES (?, ?)', [fileRow.id, name]);
      for (const dependency of file.dependencies) await this.run(db, 'INSERT INTO dependencies(file_id, dependency_path) VALUES (?, ?)', [fileRow.id, dependency]);
      for (const test of file.linkedTests) await this.run(db, 'INSERT INTO linked_tests(file_id, test_path) VALUES (?, ?)', [fileRow.id, test]);
      if (this.fts5Available) {
        const fts = ftsTextFor(file, this.searchableContentByPath.get(file.path) ?? '');
        await this.run(db, 'INSERT INTO file_fts(path, symbols, relationships, searchable_text, summary, content_hash) VALUES (?, ?, ?, ?, ?, ?)', [
          file.path, fts.symbols, fts.relationships, fts.searchableText, file.summary, file.contentHash ?? '',
        ]);
      }
    }
  }

  private async snapshotFromRow(db: sqlite3.Database, row: { id: number; [key: string]: unknown }): Promise<RepositoryIndexSnapshot> {
    const fileRows = await this.all<{ id: number; [key: string]: unknown }>(db, 'SELECT * FROM files WHERE snapshot_id = ? ORDER BY path', [row.id]);
    const files: RepositoryFileRecord[] = [];
    for (const fileRow of fileRows) {
      const symbols = await this.all<{ name: string; kind: RepositorySymbol['kind']; line: number; exported: number }>(db, 'SELECT name, kind, line, exported FROM symbols WHERE file_id = ? ORDER BY id', [fileRow.id]);
      const imports = await this.all<{ specifier: string }>(db, 'SELECT specifier FROM imports WHERE file_id = ? ORDER BY rowid', [fileRow.id]);
      const exports = await this.all<{ name: string }>(db, 'SELECT name FROM exports WHERE file_id = ? ORDER BY rowid', [fileRow.id]);
      const dependencies = await this.all<{ dependency_path: string }>(db, 'SELECT dependency_path FROM dependencies WHERE file_id = ? ORDER BY rowid', [fileRow.id]);
      const tests = await this.all<{ test_path: string }>(db, 'SELECT test_path FROM linked_tests WHERE file_id = ? ORDER BY rowid', [fileRow.id]);
      files.push({
        path: String(fileRow.path),
        absolutePath: String(fileRow.absolute_path),
        extension: String(fileRow.extension),
        language: String(fileRow.language),
        size: Number(fileRow.size),
        modifiedAt: Number(fileRow.modified_at),
        isTest: Boolean(fileRow.is_test),
        isConfig: Boolean(fileRow.is_config),
        isGenerated: Boolean(fileRow.is_generated),
        summary: String(fileRow.summary),
        contentHash: fileRow.content_hash ? String(fileRow.content_hash) : undefined,
        indexedAt: fileRow.indexed_at ? String(fileRow.indexed_at) : undefined,
        stale: Boolean(fileRow.stale),
        deleted: Boolean(fileRow.deleted),
        parseStatus: fileRow.parse_status as RepositoryFileRecord['parseStatus'],
        symbols: symbols.map(symbol => ({ ...symbol, exported: Boolean(symbol.exported) })),
        imports: imports.map(item => item.specifier),
        exports: exports.map(item => item.name),
        dependencies: dependencies.map(item => item.dependency_path),
        linkedTests: tests.map(item => item.test_path),
      });
    }
    const identity: RepositoryIdentity = {
      repositoryRoot: this.workspaceRoot,
      gitRoot: row.git_root ? String(row.git_root) : undefined,
      gitCommonDir: row.git_common_dir ? String(row.git_common_dir) : undefined,
      branch: String(row.branch),
      headCommit: String(row.head_commit),
      worktree: String(row.worktree),
      detached: Boolean(row.detached),
      schemaVersion: LEGACY_SCHEMA_VERSION,
    };
    return {
      schemaVersion: LEGACY_SCHEMA_VERSION,
      workspaceRoot: String(row.workspace_root),
      identity,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      state: row.state as RepositoryIndexSnapshot['state'],
      staleReason: row.stale_reason ? String(row.stale_reason) : undefined,
      failureCode: row.failure_code as RepositoryIndexSnapshot['failureCode'],
      files,
      ignoredPatterns: JSON.parse(String(row.ignored_patterns)) as string[],
      truncated: Boolean(row.truncated),
      statistics: JSON.parse(String(row.statistics)),
      pins: JSON.parse(String(row.pins)) as string[],
      exclusions: JSON.parse(String(row.exclusions)) as string[],
    };
  }

  private resolveGraph(records: RepositoryFileRecord[]): void {
    resolveImportGraph(records);
  }

  private shouldIgnore(relativePath: string, directory: boolean, patterns: string[]): boolean {
    if (/(^|\/)(\.env|\.aws|\.ssh|secrets?|private)(\/|$)/i.test(relativePath)) return true;
    if (/(^|\/)[^/]*(?:secret|token|credential|key)[^/]*\.(?:json|ya?ml|env|txt|pem|key)$/i.test(relativePath)) return true;
    if (directory && this.ignoredDirs.has(path.posix.basename(relativePath))) return true;
    let ignored = false;
    for (const rawPattern of patterns) {
      const trimmed = rawPattern.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (ignorePatternMatches(relativePath, trimmed)) ignored = !trimmed.startsWith('!');
    }
    return ignored;
  }

  private async readIgnorePatterns(): Promise<string[]> {
    const patterns: string[] = [];
    for (const filename of ['.gitignore', '.ignore', '.ollama-agentignore']) {
      try {
        const content = await fs.readFile(path.join(this.workspaceRoot, filename), 'utf8');
        patterns.push(...content.split(/\r?\n/));
      } catch { /* optional */ }
    }
    return patterns.filter(pattern => pattern.trim() && !pattern.trim().startsWith('#'));
  }

  private isCurrentForIdentity(snapshot: RepositoryIndexSnapshot, identity: RepositoryIdentity): boolean {
    if (Date.now() - new Date(snapshot.updatedAt ?? snapshot.createdAt).getTime() > this.cacheMaxAgeMs) return false;
    return snapshot.workspaceRoot === this.workspaceRoot
      && snapshot.identity.branch === identity.branch
      && snapshot.identity.headCommit === identity.headCommit
      && snapshot.identity.worktree === identity.worktree;
  }

  private async resolveIdentity(): Promise<RepositoryIdentity> {
    const runGit = async (args: string[], fallback: string): Promise<string> => {
      try {
        const { stdout } = await execFileAsync('git', args, {
          cwd: this.workspaceRoot,
          timeout: 5000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
        });
        return stdout.trim() || fallback;
      } catch {
        return fallback;
      }
    };
    const gitRoot = await runGit(['rev-parse', '--show-toplevel'], this.workspaceRoot);
    const gitCommonDir = await runGit(['rev-parse', '--git-common-dir'], '');
    const branchRaw = await runGit(['branch', '--show-current'], '');
    const headCommit = await runGit(['rev-parse', 'HEAD'], 'unknown');
    const worktree = await runGit(['rev-parse', '--git-dir'], path.join(this.workspaceRoot, '.git'));
    return {
      repositoryRoot: this.workspaceRoot,
      gitRoot,
      gitCommonDir: gitCommonDir ? path.resolve(this.workspaceRoot, gitCommonDir) : undefined,
      branch: branchRaw || `detached:${headCommit.slice(0, 12)}`,
      headCommit,
      worktree: path.resolve(this.workspaceRoot, worktree),
      detached: !branchRaw,
      schemaVersion: LEGACY_SCHEMA_VERSION,
    };
  }

  private statistics(files: RepositoryFileRecord[], previous: RepositoryFileRecord[]) {
    const previousByPath = new Map(previous.map(file => [file.path, file.contentHash]));
    const active = files.filter(file => !file.deleted);
    return {
      files: active.length,
      symbols: active.reduce((sum, file) => sum + file.symbols.length, 0),
      imports: active.reduce((sum, file) => sum + file.imports.length, 0),
      tests: active.filter(file => file.isTest).length,
      configs: active.filter(file => file.isConfig).length,
      buildFiles: active.filter(file => /(^|\/)(package\.json|tsconfig\.json|vitest\.config\.ts|webpack|vite|rollup|docker|compose|makefile)/i.test(file.path)).length,
      markdown: active.filter(file => file.language === 'markdown').length,
      changedFiles: active.filter(file => previousByPath.get(file.path) !== file.contentHash).length,
      deletedFiles: files.filter(file => file.deleted).length,
    };
  }
}
