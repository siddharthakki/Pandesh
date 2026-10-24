/**
 * Language-aware structure extraction for the repository graph (portable, dependency-free).
 *
 * These are *lexical* extractors: fast, forgiving, and honest about it — every record carries `provenance: 'lexical'`
 * and a confidence below 1. A host with real compiler/LSP knowledge supplies stronger records through the `extractors`
 * option (the VS Code adapter passes the TypeScript-AST extractor); the graph merges by provenance.
 */
export type SymbolKind = 'class' | 'interface' | 'function' | 'type' | 'enum' | 'variable' | 'method' | 'module' | 'struct' | 'trait';
export type FileRole = 'source' | 'test' | 'config' | 'manifest' | 'doc' | 'generated' | 'other';
export type Provenance = 'ast' | 'lexical' | 'lsp' | 'manifest' | 'convention' | 'git';

export interface SymbolRec {
  name: string;
  kind: SymbolKind;
  line: number;
  exported: boolean;
  container?: string;
  extends?: string[];
  implements?: string[];
}

export interface ImportRec {
  /** The import specifier exactly as written (`./x`, `os.path`, `java.util.List`, `crate::a::b`). */
  spec: string;
  line: number;
  kind: 'static' | 'dynamic' | 'require' | 'include' | 'use' | 'from';
  names?: string[];
  /** Workspace-relative path once resolved. */
  resolved?: string;
  provenance: Provenance;
  confidence: number;
}

export interface Extraction {
  language: string;
  symbols: SymbolRec[];
  imports: ImportRec[];
  exports: string[];
  provenance: Provenance;
}

/** Host-supplied extractor (for example a TypeScript-AST one). Returning undefined falls back to the lexical extractor. */
export type ExtractorFn = (relPath: string, text: string) => Partial<Extraction> | undefined;

const LANGUAGE_BY_EXT: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.go': 'go', '.rs': 'rust',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php',
  '.swift': 'swift', '.scala': 'scala', '.dart': 'dart',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.md': 'markdown', '.html': 'html', '.css': 'css',
};

export function languageOf(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  return dot < 0 ? 'other' : (LANGUAGE_BY_EXT[relPath.slice(dot).toLowerCase()] ?? 'other');
}

const MANIFESTS = /(^|\/)(package\.json|pyproject\.toml|setup\.py|go\.mod|cargo\.toml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|composer\.json|gemfile|[^/]+\.csproj|[^/]+\.sln|cmakelists\.txt|makefile)$/i;
const CONFIG = /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|vite\.config\.[a-z]+|vitest\.config\.[a-z]+|jest\.config\.[a-z]+|webpack\.config\.[a-z]+|dockerfile|docker-compose\.ya?ml|\.gitignore|\.editorconfig)$/i;
const TEST_PATH = /(^|\/)(__tests__|tests?|spec|specs|e2e)\/|(\.|_)(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|[^/]+Test\.(java|kt|cs)$|[^/]+_test\.(go|py|rs|cpp|cc)$/i;
const GENERATED = /(^|\/)(dist|build|out|generated|gen|\.next|coverage|vendor|node_modules)\/|\.min\.[a-z]+$|\.generated\.|\.pb\.go$|\.g\.dart$|\.d\.ts$/i;
const DOC = /\.(md|markdown|rst|txt|adoc)$/i;

export function roleOf(relPath: string, language = languageOf(relPath)): FileRole {
  const p = relPath.replace(/\\/g, '/');
  if (MANIFESTS.test(p)) return 'manifest';
  if (CONFIG.test(p)) return 'config';
  if (GENERATED.test(p)) return 'generated';
  if (TEST_PATH.test(p)) return 'test';
  if (DOC.test(p)) return 'doc';
  if (['json', 'yaml', 'toml', 'css', 'markdown', 'other'].includes(language)) return language === 'other' ? 'other' : 'config';
  return 'source';
}

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
};

/** Cheap incremental line lookup for many matches in one text. */
function lineIndex(text: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (index: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

const splitNames = (raw: string | undefined): string[] =>
  (raw ?? '').split(',').map(part => part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim()).filter(Boolean);

function extractTsJs(text: string): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const at = lineIndex(text);

  for (const m of text.matchAll(/(^|\n)\s*import\s+(?:type\s+)?(?:([\w$]+)\s*,?\s*)?(?:\*\s+as\s+([\w$]+)|\{([^}]*)\})?\s*from\s*['"]([^'"\n]+)['"]/g)) {
    imports.push({ spec: m[5], line: at(m.index), kind: 'static', names: [...(m[2] ? ['default'] : []), ...splitNames(m[4])], provenance: 'lexical', confidence: 0.85 });
  }
  for (const m of text.matchAll(/(^|\n)\s*import\s*['"]([^'"\n]+)['"]/g)) imports.push({ spec: m[2], line: at(m.index), kind: 'static', provenance: 'lexical', confidence: 0.85 });
  for (const m of text.matchAll(/(^|\n)\s*export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+[\w$]+\s*)?from\s*['"]([^'"\n]+)['"]/g)) {
    imports.push({ spec: m[2], line: at(m.index), kind: 'static', provenance: 'lexical', confidence: 0.85 });
  }
  for (const m of text.matchAll(/\brequire\(\s*['"]([^'"\n]+)['"]\s*\)/g)) imports.push({ spec: m[1], line: at(m.index), kind: 'require', provenance: 'lexical', confidence: 0.8 });
  for (const m of text.matchAll(/\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g)) imports.push({ spec: m[1], line: at(m.index), kind: 'dynamic', provenance: 'lexical', confidence: 0.7 });

  const declaration = /(^|\n)(export\s+(?:default\s+)?)?(?:declare\s+)?(?:abstract\s+)?(async\s+)?(?:(function\*?)\s+([\w$]+)|(class)\s+([\w$]+)(?:\s*<[^>{]*>)?(?:\s+extends\s+([\w$.]+))?(?:\s+implements\s+([\w$.,\s<>]+?))?\s*\{|(interface)\s+([\w$]+)(?:\s*<[^>{]*>)?(?:\s+extends\s+([\w$.,\s<>]+?))?\s*\{|(type)\s+([\w$]+)\s*(?:<[^=]*>)?\s*=|(enum)\s+([\w$]+)|(const|let|var)\s+([\w$]+)\s*(?::[^=\n]+)?=)/g;
  for (const m of text.matchAll(declaration)) {
    const exported = Boolean(m[2]);
    const line = at(m.index + (m[1] ? m[1].length : 0));
    let rec: SymbolRec | undefined;
    if (m[4]) rec = { name: m[5], kind: 'function', line, exported };
    else if (m[6]) rec = { name: m[7], kind: 'class', line, exported, ...(m[8] ? { extends: [m[8]] } : {}), ...(m[9] ? { implements: splitNames(m[9]) } : {}) };
    else if (m[10]) rec = { name: m[11], kind: 'interface', line, exported, ...(m[12] ? { extends: splitNames(m[12]) } : {}) };
    else if (m[13]) rec = { name: m[14], kind: 'type', line, exported };
    else if (m[15]) rec = { name: m[16], kind: 'enum', line, exported };
    else if (m[17] && exported) rec = { name: m[18], kind: 'variable', line, exported };
    else if (m[17] && /^[A-Z][A-Z0-9_]+$/.test(m[18])) rec = { name: m[18], kind: 'variable', line, exported: false };
    if (!rec) continue;
    symbols.push(rec);
    if (exported) exports.add(rec.name);
  }
  for (const m of text.matchAll(/(^|\n)\s*export\s*\{([^}]*)\}(?!\s*from)/g)) splitNames(m[2]).forEach(n => exports.add(n));
  if (/(^|\n)\s*export\s+default\b/.test(text)) exports.add('default');
  for (const m of text.matchAll(/\bmodule\.exports\s*=\s*\{([^}]*)\}/g)) splitNames(m[1].replace(/:[^,]+/g, '')).forEach(n => exports.add(n));
  for (const m of text.matchAll(/\bexports\.([\w$]+)\s*=/g)) exports.add(m[1]);
  return { symbols, imports, exports: [...exports] };
}

function extractPython(text: string): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const at = lineIndex(text);
  for (const m of text.matchAll(/^from\s+(\.*)([\w.]*)\s+import\s+(\([^)]*\)|[^\n#]+)/gm)) {
    imports.push({ spec: `${m[1]}${m[2]}`, line: at(m.index), kind: 'from', names: splitNames(m[3].replace(/[()\n]/g, ' ')), provenance: 'lexical', confidence: 0.85 });
  }
  for (const m of text.matchAll(/^import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
    for (const spec of splitNames(m[1])) imports.push({ spec, line: at(m.index), kind: 'static', provenance: 'lexical', confidence: 0.85 });
  }
  for (const m of text.matchAll(/^(async\s+)?def\s+([\w]+)\s*\(/gm)) {
    symbols.push({ name: m[2], kind: 'function', line: at(m.index), exported: !m[2].startsWith('_') });
    if (!m[2].startsWith('_')) exports.add(m[2]);
  }
  for (const m of text.matchAll(/^class\s+([\w]+)\s*(?:\(([^)]*)\))?\s*:/gm)) {
    symbols.push({ name: m[1], kind: 'class', line: at(m.index), exported: !m[1].startsWith('_'), ...(m[2] ? { extends: splitNames(m[2]).filter(b => !/^(object|metaclass=.*)$/.test(b)) } : {}) });
    if (!m[1].startsWith('_')) exports.add(m[1]);
  }
  for (const m of text.matchAll(/^([A-Z][A-Z0-9_]+)\s*(?::[^=\n]+)?=/gm)) symbols.push({ name: m[1], kind: 'variable', line: at(m.index), exported: true });
  return { symbols, imports, exports: [...exports] };
}

function extractJvm(text: string, language: 'java' | 'kotlin' | 'csharp' | 'scala'): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const at = lineIndex(text);
  const importRe = language === 'csharp' ? /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/gm : /^\s*import\s+(?:static\s+)?([\w.*]+)/gm;
  for (const m of text.matchAll(importRe)) imports.push({ spec: m[1], line: at(m.index), kind: 'static', provenance: 'lexical', confidence: 0.8 });
  const decl = language === 'kotlin'
    ? /^\s*(?:(?:public|internal|private|protected|open|abstract|sealed|data|enum|annotation|inner)\s+)*(class|interface|object)\s+([\w]+)(?:\s*<[^>]*>)?(?:\([^)]*\))?\s*(?::\s*([^\{\n]+))?/gm
    : /^\s*(?:(?:public|private|protected|internal|abstract|final|static|sealed|partial)\s+)*(class|interface|enum|record|struct)\s+([\w]+)(?:\s*<[^>{]*>)?(?:\s+extends\s+([\w.<>]+))?(?:\s+implements\s+([\w.,<>\s]+?))?(?:\s*:\s*([\w.,<>\s]+?))?\s*(?:\{|$)/gm;
  for (const m of text.matchAll(decl)) {
    const kind: SymbolKind = m[1] === 'interface' ? 'interface' : m[1] === 'enum' ? 'enum' : m[1] === 'struct' ? 'struct' : 'class';
    const bases = splitNames(language === 'kotlin' ? (m[3] ?? '').replace(/\([^)]*\)/g, '') : (m[5] ?? ''));
    symbols.push({ name: m[2], kind, line: at(m.index), exported: true, ...(m[3] && language !== 'kotlin' ? { extends: [m[3]] } : {}), ...(m[4] ? { implements: splitNames(m[4]) } : {}), ...(bases.length ? { extends: bases } : {}) });
    exports.add(m[2]);
  }
  if (language === 'kotlin') for (const m of text.matchAll(/^\s*(?:(?:public|internal|private)\s+)?fun\s+(?:<[^>]*>\s*)?(?:[\w.]+\.)?([\w]+)\s*\(/gm)) symbols.push({ name: m[1], kind: 'function', line: at(m.index), exported: true });
  return { symbols, imports, exports: [...exports] };
}

function extractGo(text: string): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const at = lineIndex(text);
  for (const m of text.matchAll(/^import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) imports.push({ spec: m[1], line: at(m.index), kind: 'static', provenance: 'lexical', confidence: 0.7 });
  for (const block of text.matchAll(/^import\s*\(([\s\S]*?)\)/gm)) {
    for (const m of block[1].matchAll(/(?:[\w.]+\s+)?"([^"]+)"/g)) imports.push({ spec: m[1], line: at(block.index), kind: 'static', provenance: 'lexical', confidence: 0.7 });
  }
  for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([\w]+)\s*\(/gm)) { symbols.push({ name: m[1], kind: 'function', line: at(m.index), exported: /^[A-Z]/.test(m[1]) }); if (/^[A-Z]/.test(m[1])) exports.add(m[1]); }
  for (const m of text.matchAll(/^type\s+([\w]+)\s+(struct|interface)/gm)) { symbols.push({ name: m[1], kind: m[2] === 'struct' ? 'struct' : 'interface', line: at(m.index), exported: /^[A-Z]/.test(m[1]) }); if (/^[A-Z]/.test(m[1])) exports.add(m[1]); }
  return { symbols, imports, exports: [...exports] };
}

function extractRust(text: string): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const exports = new Set<string>();
  const at = lineIndex(text);
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([\w:]+)/gm)) imports.push({ spec: m[1], line: at(m.index), kind: 'use', provenance: 'lexical', confidence: 0.75 });
  for (const m of text.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([\w]+)\s*;/gm)) imports.push({ spec: `self::${m[1]}`, line: at(m.index), kind: 'use', provenance: 'lexical', confidence: 0.9 });
  for (const m of text.matchAll(/^\s*(pub(?:\([^)]*\))?\s+)?(fn|struct|enum|trait)\s+([\w]+)/gm)) {
    const kind: SymbolKind = m[2] === 'fn' ? 'function' : m[2] === 'struct' ? 'struct' : m[2] === 'enum' ? 'enum' : 'trait';
    symbols.push({ name: m[3], kind, line: at(m.index), exported: Boolean(m[1]) });
    if (m[1]) exports.add(m[3]);
  }
  for (const m of text.matchAll(/^\s*impl(?:<[^>]*>)?\s+([\w:]+)\s+for\s+([\w:]+)/gm)) {
    const target = symbols.find(s => s.name === m[2]);
    if (target) target.implements = [...(target.implements ?? []), m[1]];
  }
  return { symbols, imports, exports: [...exports] };
}

function extractC(text: string, cpp: boolean): Omit<Extraction, 'language' | 'provenance'> {
  const symbols: SymbolRec[] = [];
  const imports: ImportRec[] = [];
  const at = lineIndex(text);
  for (const m of text.matchAll(/^\s*#\s*include\s*["<]([^">]+)[">]/gm)) imports.push({ spec: m[1], line: at(m.index), kind: 'include', provenance: 'lexical', confidence: 0.8 });
  if (cpp) for (const m of text.matchAll(/^\s*(class|struct)\s+([\w]+)(?:\s*:\s*(?:public|private|protected)\s+([\w:]+))?\s*\{/gm)) symbols.push({ name: m[2], kind: m[1] === 'class' ? 'class' : 'struct', line: at(m.index), exported: true, ...(m[3] ? { extends: [m[3]] } : {}) });
  else for (const m of text.matchAll(/^\s*(?:typedef\s+)?struct\s+([\w]+)\s*\{/gm)) symbols.push({ name: m[1], kind: 'struct', line: at(m.index), exported: true });
  return { symbols, imports, exports: symbols.map(s => s.name) };
}

/** Lexical extraction for one file. Unknown languages yield an empty (but valid) extraction. */
export function extractLexical(relPath: string, text: string): Extraction {
  const language = languageOf(relPath);
  let body: Omit<Extraction, 'language' | 'provenance'>;
  switch (language) {
    case 'typescript': case 'javascript': body = extractTsJs(text); break;
    case 'python': body = extractPython(text); break;
    case 'java': case 'kotlin': case 'csharp': case 'scala': body = extractJvm(text, language); break;
    case 'go': body = extractGo(text); break;
    case 'rust': body = extractRust(text); break;
    case 'c': body = extractC(text, false); break;
    case 'cpp': body = extractC(text, true); break;
    default: body = { symbols: [], imports: [], exports: [] };
  }
  return { language, provenance: 'lexical', ...body };
}

/**
 * V8 represents a regex substring as a slice that keeps its whole parent string alive: a 300 KB source file would stay
 * in memory because one 8-character identifier was extracted from it. Every string stored in the graph is therefore
 * copied into its own flat string and interned, which also collapses the many repeats (module specifiers, class names).
 */
const INTERN_LIMIT = 400_000;
const internPool = new Map<string, string>();
export function intern(value: string): string {
  const hit = internPool.get(value);
  if (hit !== undefined) return hit;
  const flat = (`${value} `).slice(0, -1);
  if (internPool.size < INTERN_LIMIT) internPool.set(flat, flat);
  return flat;
}
const internAll = (list: readonly string[] | undefined): string[] | undefined => list?.map(intern);

function detach(extraction: Extraction): Extraction {
  return {
    ...extraction,
    symbols: extraction.symbols.map(s => ({
      ...s, name: intern(s.name),
      ...(s.container ? { container: intern(s.container) } : {}),
      ...(s.extends ? { extends: internAll(s.extends) } : {}),
      ...(s.implements ? { implements: internAll(s.implements) } : {}),
    })),
    imports: extraction.imports.map(i => ({ ...i, spec: intern(i.spec), ...(i.names ? { names: internAll(i.names) } : {}) })),
    exports: extraction.exports.map(intern),
  };
}

export const MAX_SYMBOLS_PER_FILE = 300;
export const MAX_IMPORTS_PER_FILE = 300;

/** Runs the host extractor first (stronger provenance), then fills gaps lexically. Always bounded. */
/**
 * A single-file web app keeps its logic in inline <script> blocks. This returns the text with everything outside those
 * blocks blanked (newlines kept), so extractors see only JavaScript and every symbol keeps its true line in the HTML file.
 * Scripts with a `src`, and non-JS types (json, templates), contribute nothing.
 */
export function htmlScriptView(html: string): string {
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const blank = (chunk: string): string => chunk.replace(/[^\n]/g, ' ');
  let out = '';
  let cursor = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1] ?? '';
    const bodyStart = m.index + m[0].indexOf('>') + 1;
    const bodyEnd = bodyStart + (m[2] ?? '').length;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1];
    const isJs = !type || /^(module|(text|application)\/(x-)?(java|ecma)script)$/i.test(type);
    out += blank(html.slice(cursor, bodyStart));
    out += isJs && !/\bsrc\s*=/i.test(attrs) ? html.slice(bodyStart, bodyEnd) : blank(html.slice(bodyStart, bodyEnd));
    cursor = bodyEnd;
  }
  return out + blank(html.slice(cursor));
}

export function extractFile(relPath: string, text: string, custom?: ExtractorFn): Extraction {
  if (/\.html?$/i.test(relPath)) {
    const view = htmlScriptView(text);
    if (!view.trim()) return extractLexical(relPath, '');
    const parsed = extractFile(`${relPath}.js`, view, custom);
    return { ...parsed, language: 'html' };
  }
  const lexical = extractLexical(relPath, text);
  // A host extractor is an accelerator, never a dependency: if it throws, this file falls back to the lexical result.
  let supplied: Partial<Extraction> | undefined;
  try { supplied = custom?.(relPath, text); } catch { supplied = undefined; }
  const merged: Extraction = supplied
    ? {
        language: supplied.language ?? lexical.language,
        symbols: supplied.symbols ?? lexical.symbols,
        imports: supplied.imports ?? lexical.imports,
        exports: supplied.exports ?? lexical.exports,
        provenance: supplied.provenance ?? 'ast',
      }
    : lexical;
  return detach({ ...merged, symbols: merged.symbols.slice(0, MAX_SYMBOLS_PER_FILE), imports: merged.imports.slice(0, MAX_IMPORTS_PER_FILE) });
}

export { lineOf };
