import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverRepositoryPath } from './repositoryPathRecovery';
import { fingerprintText, MAX_SEARCH_RESULTS, boundText, isInsideWorkspace, type MissionObservation } from './missionObservations';
import { isHostOwnedSearchPath } from './missionHostPaths';

export { isHostOwnedSearchPath };

const SKIP_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.karkedikha']);

function walk(root: string, relative: string, files: string[], remaining: { n: number }): void {
  if (remaining.n <= 0) return;
  const dir = path.join(root, relative);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (remaining.n <= 0) return;
    if (SKIP_DIRS.has(entry.name)) continue;
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, child.replace(/\\/g, '/'), files, remaining);
      continue;
    }
    if (entry.isFile()) {
      files.push(child.replace(/\\/g, '/'));
      remaining.n -= 1;
    }
    void absolute;
  }
}

export function searchWorkspace(input: {
  workspaceRoot: string;
  query: string;
  scopePath?: string;
}): MissionObservation {
  const query = input.query.trim();
  if (!query) {
    return { action: 'search', query, resultCount: 0, truncated: false, ok: false, output: 'empty query' };
  }
  const tokens = query.split(/\s+/).filter((token) => token.length > 0).slice(0, 6);
  let scope = input.workspaceRoot;
  let scopeRel = '';
  if (input.scopePath) {
    const scoped = path.resolve(input.workspaceRoot, input.scopePath);
    if (fs.existsSync(scoped) && isInsideWorkspace(input.workspaceRoot, scoped) && fs.statSync(scoped).isDirectory()) {
      scope = scoped;
      scopeRel = input.scopePath.replace(/\\/g, '/');
    } else {
      const recovery = recoverRepositoryPath({
        workspaceRoot: input.workspaceRoot,
        requestedPath: input.scopePath,
        target: 'read',
      });
      if (!recovery.resolvedPath || (recovery.status !== 'resolved' && recovery.status !== 'corrected' && recovery.status !== 'not_found')) {
        return {
          action: 'search',
          query,
          path: input.scopePath,
          resultCount: 0,
          truncated: false,
          ok: false,
          output: `search scope blocked: ${recovery.reason}`,
        };
      }
      if (recovery.resolvedPath && (recovery.status === 'resolved' || recovery.status === 'corrected')) {
        scope = recovery.resolvedPath;
        scopeRel = recovery.selected ?? input.scopePath;
      }
    }
  }

  const grepArgs = ['grep', '-n', '-I', ...tokens.flatMap((token) => ['-e', token]), '--', scopeRel || '.'];
  const git = spawnSync('git', grepArgs, {
    cwd: input.workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024,
  });
  if ((git.status === 0 || git.status === 1) && !git.error) {
    const lines = (git.stdout || '')
      .split(/\r?\n/)
      .filter(Boolean)
      .filter((line) => !isHostOwnedSearchPath(line.split(/:\d+:/)[0] ?? line))
      .slice(0, MAX_SEARCH_RESULTS);
    const bounded = boundText(lines.join('\n'));
    const output = bounded.text || '(no matches)';
    return {
      action: 'search',
      query,
      path: scopeRel || undefined,
      resultCount: lines.length,
      truncated: bounded.truncated || (git.stdout || '').split(/\r?\n/).filter(Boolean).length > MAX_SEARCH_RESULTS,
      fingerprint: fingerprintText(output),
      ok: true,
      output,
    };
  }

  const files: string[] = [];
  walk(scope, '', files, { n: 400 });
  const matches: string[] = [];
  for (const file of files) {
    if (isHostOwnedSearchPath(file)) continue;
    if (matches.length >= MAX_SEARCH_RESULTS) break;
    const absolute = path.join(scope, file);
    let text = '';
    try {
      text = fs.readFileSync(absolute, 'utf8');
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      if (tokens.some((token) => lines[i].includes(token))) {
        matches.push(`${file}:${i + 1}:${lines[i].trim()}`);
        if (matches.length >= MAX_SEARCH_RESULTS) break;
      }
    }
  }
  const bounded = boundText(matches.join('\n'));
  const output = bounded.text || '(no matches)';
  return {
    action: 'search',
    query,
    path: scopeRel || undefined,
    resultCount: matches.length,
    truncated: bounded.truncated,
    fingerprint: fingerprintText(output),
    ok: true,
    output,
  };
}
