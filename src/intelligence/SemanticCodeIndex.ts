import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

export type SymbolKind = 'class' | 'interface' | 'function' | 'method' | 'property' | 'variable' | 'type' | 'module' | 'unknown';

export interface CodeLocation {
  file: string;
  line: number;
  column: number;
}

export interface CodeSymbol {
  id: string;
  name: string;
  kind: SymbolKind;
  location: CodeLocation;
  container?: string;
  signature?: string;
  exported?: boolean;
}

export interface CodeReference {
  symbolName: string;
  location: CodeLocation;
  context?: string;
}

export interface CodeDiagnostic {
  severity: 'error' | 'warning' | 'info';
  message: string;
  location: CodeLocation;
  code?: string;
}

export interface LanguageDocumentAnalysis {
  symbols: CodeSymbol[];
  references: CodeReference[];
  diagnostics: CodeDiagnostic[];
  imports: string[];
}

export interface LanguageIntelligenceAdapter {
  id: string;
  supports(filename: string): boolean;
  analyze(filename: string, content: string, signal: AbortSignal): Promise<LanguageDocumentAnalysis>;
  findDefinitions?(symbol: string, signal: AbortSignal): Promise<CodeLocation[]>;
  findReferences?(symbol: string, signal: AbortSignal): Promise<CodeLocation[]>;
  workspaceDiagnostics?(signal: AbortSignal): Promise<CodeDiagnostic[]>;
}

export interface IndexedDocument {
  file: string;
  hash: string;
  languageAdapter: string;
  symbols: CodeSymbol[];
  references: CodeReference[];
  diagnostics: CodeDiagnostic[];
  imports: string[];
  indexedAt: string;
}

export interface SemanticSearchResult {
  score: number;
  symbol: CodeSymbol;
  references: CodeReference[];
  likelyTests: string[];
}

export interface SemanticCodeIndexOptions {
  includeExtensions?: string[];
  excludedDirectories?: string[];
  maxFiles?: number;
  maxFileBytes?: number;
  concurrency?: number;
}

export class SemanticCodeIndex {
  private readonly root: string;
  private readonly adapters: LanguageIntelligenceAdapter[] = [];
  private readonly documents = new Map<string, IndexedDocument>();
  private readonly includeExtensions: Set<string>;
  private readonly excludedDirectories: Set<string>;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly concurrency: number;

  constructor(workspaceRoot: string, options: SemanticCodeIndexOptions = {}) {
    this.root = path.resolve(workspaceRoot);
    this.includeExtensions = new Set(options.includeExtensions ?? ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.kt', '.kts', '.cs', '.go', '.rs']);
    this.excludedDirectories = new Set(options.excludedDirectories ?? ['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.ollama-agent']);
    this.maxFiles = options.maxFiles ?? 20_000;
    this.maxFileBytes = options.maxFileBytes ?? 1_000_000;
    this.concurrency = Math.max(1, Math.min(options.concurrency ?? 4, 32));
    this.registerAdapter(new StructuralLanguageAdapter());
  }

  registerAdapter(adapter: LanguageIntelligenceAdapter, beforeFallback = true): void {
    if (!/^[a-zA-Z0-9._:-]{1,120}$/.test(adapter.id)) throw new Error(`Invalid language adapter id: ${adapter.id}`);
    if (this.adapters.some(existing => existing.id === adapter.id)) throw new Error(`Language adapter already registered: ${adapter.id}`);
    if (beforeFallback && this.adapters.length > 0) this.adapters.splice(this.adapters.length - 1, 0, adapter);
    else this.adapters.push(adapter);
  }

  async refresh(signal: AbortSignal = new AbortController().signal): Promise<{ indexed: number; unchanged: number; removed: number }> {
    const files = await this.collectFiles();
    const current = new Set(files);
    let removed = 0;
    for (const filename of [...this.documents.keys()]) {
      if (!current.has(filename)) {
        this.documents.delete(filename);
        removed += 1;
      }
    }

    let cursor = 0;
    let indexed = 0;
    let unchanged = 0;
    const workers = Array.from({ length: this.concurrency }, async () => {
      while (true) {
        if (signal.aborted) throw abortError();
        const index = cursor++;
        if (index >= files.length) return;
        const filename = files[index];
        const stat = await fs.stat(filename);
        if (stat.size > this.maxFileBytes) continue;
        const content = await fs.readFile(filename, 'utf8');
        const hash = createHash('sha256').update(content).digest('hex');
        const relative = this.relative(filename);
        const existing = this.documents.get(filename);
        if (existing?.hash === hash) {
          unchanged += 1;
          continue;
        }
        const adapter = this.adapters.find(candidate => candidate.supports(filename));
        if (!adapter) continue;
        const analysis = await adapter.analyze(filename, content, signal);
        this.documents.set(filename, {
          file: relative,
          hash,
          languageAdapter: adapter.id,
          symbols: analysis.symbols.map(symbol => normalizeSymbol(symbol, relative)),
          references: analysis.references.map(reference => normalizeReference(reference, relative)),
          diagnostics: analysis.diagnostics.map(diagnostic => normalizeDiagnostic(diagnostic, relative)),
          imports: [...new Set(analysis.imports)].sort(),
          indexedAt: new Date().toISOString(),
        });
        indexed += 1;
      }
    });
    await Promise.all(workers);
    return { indexed, unchanged, removed };
  }

  listDocuments(): IndexedDocument[] {
    return [...this.documents.values()].map(cloneDocument).sort((left, right) => left.file.localeCompare(right.file));
  }

  search(query: string, limit = 20): SemanticSearchResult[] {
    const terms = tokenize(query);
    const results: SemanticSearchResult[] = [];
    const testFiles = this.listDocuments().map(document => document.file).filter(isTestFile);
    for (const document of this.documents.values()) {
      for (const symbol of document.symbols) {
        const haystack = `${symbol.name} ${symbol.kind} ${symbol.container ?? ''} ${symbol.signature ?? ''} ${document.file}`.toLowerCase();
        const matches = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
        if (matches === 0 && terms.length > 0) continue;
        const references = this.referencesFor(symbol.name);
        const likelyTests = rankLikelyTests(document.file, symbol.name, testFiles).slice(0, 5);
        results.push({
          score: matches * 10 + (symbol.exported ? 2 : 0) + Math.min(references.length, 5),
          symbol: { ...symbol, location: { ...symbol.location } },
          references,
          likelyTests,
        });
      }
    }
    return results.sort((left, right) => right.score - left.score || left.symbol.name.localeCompare(right.symbol.name) || left.symbol.location.file.localeCompare(right.symbol.location.file)).slice(0, Math.max(1, Math.min(limit, 200)));
  }

  definitions(symbolName: string): CodeLocation[] {
    return [...this.documents.values()]
      .flatMap(document => document.symbols)
      .filter(symbol => symbol.name === symbolName)
      .map(symbol => ({ ...symbol.location }))
      .sort(compareLocation);
  }

  referencesFor(symbolName: string): CodeReference[] {
    return [...this.documents.values()]
      .flatMap(document => document.references)
      .filter(reference => reference.symbolName === symbolName)
      .map(reference => ({ ...reference, location: { ...reference.location } }))
      .sort((left, right) => compareLocation(left.location, right.location));
  }

  diagnostics(): CodeDiagnostic[] {
    return [...this.documents.values()].flatMap(document => document.diagnostics.map(diagnostic => ({ ...diagnostic, location: { ...diagnostic.location } }))).sort((left, right) => compareLocation(left.location, right.location));
  }

  impactedFiles(changedFiles: readonly string[]): string[] {
    const changed = new Set(changedFiles.map(file => file.replace(/\\/g, '/')));
    const impacted = new Set(changed);
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const document of this.documents.values()) {
        if (impacted.has(document.file)) continue;
        const importsChanged = document.imports.some(importValue => [...impacted].some(file => importMayTarget(importValue, file)));
        if (importsChanged) {
          impacted.add(document.file);
          expanded = true;
        }
      }
    }
    return [...impacted].sort();
  }

  private async collectFiles(): Promise<string[]> {
    const files: string[] = [];
    const pending = [this.root];
    while (pending.length > 0 && files.length < this.maxFiles) {
      const current = pending.pop()!;
      let entries: Array<import('fs').Dirent>;
      try { entries = await fs.readdir(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (files.length >= this.maxFiles) break;
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (!this.excludedDirectories.has(entry.name)) pending.push(full);
        } else if (entry.isFile() && this.includeExtensions.has(path.extname(entry.name).toLowerCase())) {
          files.push(full);
        }
      }
    }
    return files.sort();
  }

  private relative(filename: string): string {
    const relative = path.relative(this.root, filename);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Indexed file escaped workspace: ${filename}`);
    return relative.replace(/\\/g, '/');
  }
}

export class StructuralLanguageAdapter implements LanguageIntelligenceAdapter {
  readonly id = 'structural-fallback';

  supports(): boolean { return true; }

  async analyze(filename: string, content: string, signal: AbortSignal): Promise<LanguageDocumentAnalysis> {
    if (signal.aborted) throw abortError();
    const lines = content.split(/\r?\n/);
    const symbols: CodeSymbol[] = [];
    const references: CodeReference[] = [];
    const imports: string[] = [];
    const definitions = new Set<string>();

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const parsed of parseDefinitions(line)) {
        definitions.add(parsed.name);
        symbols.push({
          id: `${filename}:${index + 1}:${parsed.name}`,
          name: parsed.name,
          kind: parsed.kind,
          location: { file: filename, line: index + 1, column: Math.max(1, line.indexOf(parsed.name) + 1) },
          signature: line.trim().slice(0, 500),
          exported: /\bexport\b|\bpublic\b/.test(line),
        });
      }
      for (const imported of parseImports(line)) imports.push(imported);
    }

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const name of definitions) {
        let cursor = 0;
        while (true) {
          const found = line.indexOf(name, cursor);
          if (found < 0) break;
          const isDefinition = symbols.some(symbol => symbol.name === name && symbol.location.line === index + 1 && symbol.location.column === found + 1);
          if (!isDefinition && isWordBoundary(line, found, name.length)) {
            references.push({ symbolName: name, location: { file: filename, line: index + 1, column: found + 1 }, context: line.trim().slice(0, 300) });
          }
          cursor = found + name.length;
        }
      }
    }

    return { symbols, references, diagnostics: [], imports };
  }
}

function parseDefinitions(line: string): Array<{ name: string; kind: SymbolKind }> {
  const patterns: Array<{ regex: RegExp; kind: SymbolKind }> = [
    { regex: /\bclass\s+([A-Za-z_$][\w$]*)/, kind: 'class' },
    { regex: /\binterface\s+([A-Za-z_$][\w$]*)/, kind: 'interface' },
    { regex: /\btype\s+([A-Za-z_$][\w$]*)\s*=/, kind: 'type' },
    { regex: /\b(?:function|def|fun|fn)\s+([A-Za-z_$][\w$]*)\s*\(/, kind: 'function' },
    { regex: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/, kind: 'function' },
    { regex: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b/, kind: 'variable' },
    { regex: /^\s*(?:public|private|protected|static|async|override|suspend|internal|final|open|abstract|virtual|sealed|readonly|\s)*\s*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^={]+)?\s*[{=]/, kind: 'method' },
  ];
  const output: Array<{ name: string; kind: SymbolKind }> = [];
  for (const pattern of patterns) {
    const match = pattern.regex.exec(line);
    if (match?.[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) output.push({ name: match[1], kind: pattern.kind });
  }
  return deduplicate(output, item => `${item.kind}:${item.name}`);
}

function parseImports(line: string): string[] {
  const values: string[] = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/,
    /^\s*import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/, /^\s*from\s+([\w.]+)\s+import\s+/,
    /^\s*using\s+([\w.]+)\s*;/, /^\s*import\s+([\w.]+)\s*;/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

function rankLikelyTests(sourceFile: string, symbolName: string, tests: string[]): string[] {
  const sourceBase = path.basename(sourceFile).replace(/\.[^.]+$/, '').toLowerCase();
  const symbol = symbolName.toLowerCase();
  return tests.map(file => {
    const lower = file.toLowerCase();
    return { file, score: (lower.includes(sourceBase) ? 5 : 0) + (lower.includes(symbol) ? 3 : 0) + commonPathPrefix(sourceFile, file) };
  }).filter(entry => entry.score > 0).sort((left, right) => right.score - left.score || left.file.localeCompare(right.file)).map(entry => entry.file);
}

function commonPathPrefix(left: string, right: string): number {
  const a = left.split('/');
  const b = right.split('/');
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

function isTestFile(filename: string): boolean {
  return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i.test(filename);
}

function importMayTarget(importValue: string, file: string): boolean {
  const normalized = importValue.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\.[^.\/]+$/, '');
  const target = file.replace(/\.[^.\/]+$/, '');
  return target.endsWith(normalized) || path.basename(target) === path.basename(normalized);
}

function tokenize(value: string): string[] {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_$.-]+/).filter(term => term.length > 1))];
}

function normalizeSymbol(symbol: CodeSymbol, file: string): CodeSymbol {
  return { ...symbol, location: { ...symbol.location, file }, id: symbol.id || `${file}:${symbol.location.line}:${symbol.name}` };
}

function normalizeReference(reference: CodeReference, file: string): CodeReference {
  return { ...reference, location: { ...reference.location, file } };
}

function normalizeDiagnostic(diagnostic: CodeDiagnostic, file: string): CodeDiagnostic {
  return { ...diagnostic, location: { ...diagnostic.location, file } };
}

function cloneDocument(document: IndexedDocument): IndexedDocument {
  return {
    ...document,
    symbols: document.symbols.map(symbol => ({ ...symbol, location: { ...symbol.location } })),
    references: document.references.map(reference => ({ ...reference, location: { ...reference.location } })),
    diagnostics: document.diagnostics.map(diagnostic => ({ ...diagnostic, location: { ...diagnostic.location } })),
    imports: [...document.imports],
  };
}

function compareLocation(left: CodeLocation, right: CodeLocation): number {
  return left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column;
}

function isWordBoundary(line: string, start: number, length: number): boolean {
  const before = start === 0 ? '' : line[start - 1];
  const after = start + length >= line.length ? '' : line[start + length];
  return !/[A-Za-z0-9_$]/.test(before) && !/[A-Za-z0-9_$]/.test(after);
}

function deduplicate<T>(items: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function abortError(): Error {
  const error = new Error('Semantic indexing cancelled.');
  error.name = 'AbortError';
  return error;
}
