import * as fs from 'fs/promises';
import type { Dirent } from 'fs';
import * as path from 'path';
import type { RepositoryFileRecord } from '../context/RepositoryTypes';
import {
  CONFIG_NAMES,
  DEFAULT_IGNORED,
  TEXT_EXTENSIONS,
  extractLexicalImports,
  extractTsJsStructure,
  isGeneratedPath,
  isTestPath,
  languageFor,
  normalize,
  resolveImportGraph,
  summaryFor,
} from '../context/RepositoryIndex';

/**
 * Filesystem fallback for repository intelligence.
 *
 * When the SQLite index is unavailable (native module missing, corrupt, still
 * building) or was never built, the Context Compiler still needs file records.
 * This walks the workspace once, parses with the same structural/lexical
 * extractors the index uses, and resolves the same import graph, so everything
 * downstream sees one record shape whatever produced it. It needs neither Git
 * nor an index, and an empty or non-project folder yields an empty result.
 */

export interface WorkspaceScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  signal?: AbortSignal;
}

export interface WorkspaceScanResult {
  files: RepositoryFileRecord[];
  truncated: boolean;
  source: 'filesystem';
}

const DEFAULT_MAX_FILES = 2_000;
const DEFAULT_MAX_FILE_BYTES = 200_000;

export async function scanWorkspaceLite(root: string, options: WorkspaceScanOptions = {}): Promise<WorkspaceScanResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const absoluteFiles: string[] = [];
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (options.signal?.aborted || absoluteFiles.length >= maxFiles) { truncated ||= absoluteFiles.length >= maxFiles; return; }
    let entries: Dirent[];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (absoluteFiles.length >= maxFiles) { truncated = true; return; }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (DEFAULT_IGNORED.has(entry.name)) continue;
        await walk(path.join(directory, entry.name));
      } else if (entry.isFile()) {
        absoluteFiles.push(path.join(directory, entry.name));
      }
    }
  };
  await walk(root);

  const files: RepositoryFileRecord[] = [];
  for (const absolutePath of absoluteFiles) {
    if (options.signal?.aborted) break;
    const relativePath = normalize(path.relative(root, absolutePath));
    let stat: Awaited<ReturnType<typeof fs.stat>>;
    try { stat = await fs.stat(absolutePath); } catch { continue; }
    const extension = path.extname(relativePath).toLowerCase();
    const basename = path.basename(relativePath).toLowerCase();
    const textEligible = TEXT_EXTENSIONS.has(extension) || CONFIG_NAMES.has(basename);
    let content = '';
    if (textEligible && stat.size <= maxFileBytes) {
      try { content = await fs.readFile(absolutePath, 'utf8'); } catch { content = ''; }
    }
    const structural = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension);
    const parsed = content && structural ? extractTsJsStructure(content, relativePath) : undefined;
    const symbols = parsed?.symbols ?? [];
    files.push({
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
      parseStatus: structural ? 'structural' : content ? 'lexical' : 'unavailable',
    });
  }
  resolveImportGraph(files);
  return { files, truncated, source: 'filesystem' };
}
