import * as path from 'path';
import * as fs from 'fs/promises';
import { ToolResult, ToolContext } from './ToolTypes';
import { Config } from '../config/Config';
import { OutputLimiter } from '../services/OutputLimiter';

interface GrepMatch {
  file: string;
  line: number;
  preview: string;
}

async function walkDir(
  dir: string,
  ignoredDirs: string[],
  includeGlob: RegExp | null,
  excludeGlob: RegExp | null,
  results: string[],
): Promise<void> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignoredDirs.includes(entry.name)) { continue; }
      await walkDir(fullPath, ignoredDirs, includeGlob, excludeGlob, results);
    } else {
      if (includeGlob && !includeGlob.test(fullPath)) { continue; }
      if (excludeGlob && excludeGlob.test(fullPath)) { continue; }
      results.push(fullPath);
    }
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '__DSTAR__')
    .replace(/\*/g, '[^/\\\\]*')
    .replace(/__DSTAR__/g, '.*')
    .replace(/\?/g, '[^/\\\\]');
  return new RegExp(escaped, 'i');
}

function hasGlobChars(s: string): boolean {
  return /[*?[\]{}]/.test(s);
}

function queryToFilenameRegex(query: string): RegExp {
  // Convert a glob pattern like "*.py" or "src/**/*.ts" into a regex
  // applied against the full relative path (forward-slash normalised).
  const escaped = query
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metacharacters first
    .replace(/\\\*/g, '*')                  // undo star escaping so we can handle ** vs *
    .replace(/\*\*/g, '\x00DSTAR\x00')      // placeholder for **
    .replace(/\*/g, '[^/]*')               // * → no separator
    .replace(/\x00DSTAR\x00/g, '.*')        // ** → anything including separator
    .replace(/\?/g, '[^/]');               // ? → one non-separator char
  return new RegExp(escaped + '$', 'i');
}

export async function searchFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const query = String(args['query'] ?? '');
  const includeGlob = args['includeGlob'] ? globToRegex(String(args['includeGlob'])) : null;
  const excludeGlob = args['excludeGlob'] ? globToRegex(String(args['excludeGlob'])) : null;

  const allFiles: string[] = [];
  await walkDir(ctx.workspaceRoot, Config.getIgnoredDirs(), includeGlob, excludeGlob, allFiles);

  const relativeFiles = allFiles.map((f) => ({
    abs: f,
    rel: path.relative(ctx.workspaceRoot, f).replace(/\\/g, '/'),
  }));

  let matches: string[];
  if (hasGlobChars(query)) {
    const re = queryToFilenameRegex(query);
    matches = relativeFiles.filter(({ rel }) => re.test(rel)).map(({ rel }) => rel);
  } else {
    const queryLower = query.toLowerCase();
    matches = relativeFiles
      .filter(({ rel }) => rel.toLowerCase().includes(queryLower))
      .map(({ rel }) => rel);
  }

  const { lines, truncated } = OutputLimiter.truncateLines(matches, 200);
  return { ok: true, data: { matches: lines, truncated, total: matches.length } };
}

export async function grep(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const pattern = String(args['pattern'] ?? '');
  if (!pattern) { return { ok: false, error: 'pattern is required' }; }

  const includeGlob = args['includeGlob'] ? globToRegex(String(args['includeGlob'])) : null;
  const excludeGlob = args['excludeGlob'] ? globToRegex(String(args['excludeGlob'])) : null;

  let regex: RegExp;
  try { regex = new RegExp(pattern, 'gm'); } catch (e) { return { ok: false, error: `Invalid regex: ${e}` }; }

  const allFiles: string[] = [];
  await walkDir(ctx.workspaceRoot, Config.getIgnoredDirs(), includeGlob, excludeGlob, allFiles);

  const matches: GrepMatch[] = [];
  const MAX_MATCHES = 500;

  for (const filePath of allFiles) {
    if (matches.length >= MAX_MATCHES) { break; }
    let content: string;
    try { content = await fs.readFile(filePath, 'utf8'); } catch { continue; }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
      regex.lastIndex = 0;
      if (regex.test(lines[i])) {
        matches.push({
          file: path.relative(ctx.workspaceRoot, filePath),
          line: i + 1,
          preview: lines[i].slice(0, 200),
        });
      }
    }
  }

  return { ok: true, data: { matches, truncated: matches.length >= MAX_MATCHES, total: matches.length } };
}
