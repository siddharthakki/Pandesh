import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RUNTIME_INTERNAL_STATE_DIR, isRuntimeInternalPath } from './ChangeScopeReconciliation';

const execFileAsync = promisify(execFile);

/**
 * Cache directory segments that can appear at ANY depth in the tree
 * (e.g. src/ordercalc/__pycache__, tests/__pycache__).
 */
const GENERATED_CACHE_DIR_SEGMENTS = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

/**
 * Top-level build output / runtime directories that are only generated artifacts
 * when they are located at the repository root.
 */
const TOP_LEVEL_GENERATED_DIRS = new Set([
  'coverage',
  'dist',
  'out',
  'out-core',
  'out-core-tsc',
  'build',
  '.cache',
]);

const GENERATED_FILE_EXTENSIONS = new Set([
  '.pyc',
  '.pyo',
  '.pyd',
  '.vsix',
  '.tsbuildinfo',
]);

/**
 * Determines whether a relative workspace path is a recognized generated artifact.
 * Path comparison is normalized to forward slashes.
 */
export function isGeneratedArtifactPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized) return false;

  // Root runtime internal directory (.ollama-agent/...)
  if (isRuntimeInternalPath(normalized)) {
    return true;
  }

  const segments = normalized.split('/');

  // Check top-level generated directories (e.g. dist/..., out/..., coverage/...)
  if (segments.length > 1 && TOP_LEVEL_GENERATED_DIRS.has(segments[0].toLowerCase())) {
    return true;
  }
  if (segments.length === 1 && TOP_LEVEL_GENERATED_DIRS.has(segments[0].toLowerCase())) {
    return true;
  }

  // Check if any segment is a recognized cache directory (e.g. src/ordercalc/__pycache__)
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i].toLowerCase();
    if (GENERATED_CACHE_DIR_SEGMENTS.has(seg)) {
      return true;
    }
  }

  // Check file extensions (e.g. *.pyc, *.vsix)
  const fileName = segments[segments.length - 1].toLowerCase();
  for (const ext of GENERATED_FILE_EXTENSIONS) {
    if (fileName.endsWith(ext)) {
      return true;
    }
  }

  return false;
}

/**
 * Pure filter that removes recognized generated artifact paths from a list of paths.
 */
export function excludeGeneratedArtifactPaths(paths: readonly string[]): string[] {
  return paths.filter(p => !isGeneratedArtifactPath(p));
}

/**
 * Checks whether a relative path was already tracked in Git at the baseline commit (defaulting to HEAD)
 * or in the current git index.
 * If tracked in Git, the file is pre-existing and must not be deleted by cleanup.
 */
export async function isPreExistingBaselinePath(
  workspaceRoot: string,
  relativePath: string,
  baselineCommit = 'HEAD',
): Promise<boolean> {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  try {
    await execFileAsync('git', ['ls-files', '--error-unmatch', '--', normalized], {
      cwd: workspaceRoot,
      windowsHide: true,
    });
    return true;
  } catch {
    try {
      await execFileAsync('git', ['cat-file', '-e', `${baselineCommit}:${normalized}`], {
        cwd: workspaceRoot,
        windowsHide: true,
      });
      return true;
    } catch {
      return false;
    }
  }
}

export interface CleanupGeneratedArtifactsOptions {
  baselineCommit?: string;
  baselineArtifacts?: ReadonlySet<string>;
}

export interface CleanupGeneratedArtifactsResult {
  cleanedFiles: string[];
  preservedBaselineFiles: string[];
}

/**
 * Captures all existing generated artifact paths currently present in the workspace
 * (both tracked and untracked).
 * Must be called before mutation/validation runs so that pre-existing untracked
 * artifacts are proven to have existed prior to the current run and are preserved.
 */
export async function captureGeneratedArtifactBaseline(
  workspaceRoot: string,
): Promise<Set<string>> {
  const baseline = new Set<string>();
  const untracked = await getGitUntrackedPaths(workspaceRoot);
  for (const relPath of untracked) {
    if (isRuntimeInternalPath(relPath)) continue;
    if (isGeneratedArtifactPath(relPath)) {
      baseline.add(relPath);
    }
  }
  await scanGeneratedCacheDirectories(workspaceRoot, baseline);
  return baseline;
}

/**
 * Cleans up recognized generated runtime artifacts (such as __pycache__, *.pyc, .pytest_cache)
 * from an isolated worktree after validation and before diff review or commit staging.
 *
 * CRITICAL SAFETY INVARIANTS:
 * 1. NEVER deletes a file that existed in the repository baseline (tracked at baselineCommit/HEAD).
 * 2. NEVER deletes pre-existing untracked artifacts present before the current run (baselineArtifacts).
 * 3. Only deletes newly introduced untracked generated artifacts created during this run.
 * 4. Never deletes .ollama-agent runtime internal state.
 */
export async function cleanupGeneratedArtifacts(
  workspaceRoot: string,
  options: CleanupGeneratedArtifactsOptions = {},
): Promise<CleanupGeneratedArtifactsResult> {
  const result: CleanupGeneratedArtifactsResult = {
    cleanedFiles: [],
    preservedBaselineFiles: [],
  };

  // Find untracked files via git status
  const untrackedPaths = await getGitUntrackedPaths(workspaceRoot);
  const candidatePaths = new Set<string>();

  for (const relPath of untrackedPaths) {
    // Skip extension's own state directory
    if (isRuntimeInternalPath(relPath)) continue;

    if (isGeneratedArtifactPath(relPath)) {
      candidatePaths.add(relPath);
    }
  }

  // Also scan workspace for generated cache folders (e.g. __pycache__, .pytest_cache)
  await scanGeneratedCacheDirectories(workspaceRoot, candidatePaths);

  for (const relPath of candidatePaths) {
    // Never delete .ollama-agent state
    if (isRuntimeInternalPath(relPath)) continue;

    // Safety Invariant 1: Pre-existing untracked generated artifacts captured before the run must NEVER be deleted.
    if (options.baselineArtifacts?.has(relPath)) {
      result.preservedBaselineFiles.push(relPath);
      continue;
    }

    // Safety Invariant 2: Files tracked in Git at baseline commit must NEVER be deleted.
    const isBaseline = await isPreExistingBaselinePath(workspaceRoot, relPath, options.baselineCommit);
    if (isBaseline) {
      result.preservedBaselineFiles.push(relPath);
      continue;
    }

    const absolute = path.join(workspaceRoot, relPath);
    try {
      const stat = await fsp.lstat(absolute).catch(() => undefined);
      if (!stat) continue;

      if (stat.isDirectory()) {
        // Only remove directory if it does not contain preserved baseline files
        const filesInside = await collectFilesRecursively(absolute);
        const hasPreservedFile = filesInside.some(f => {
          const innerRel = path.relative(workspaceRoot, f).replace(/\\/g, '/');
          return options.baselineArtifacts?.has(innerRel);
        });
        if (!hasPreservedFile) {
          await fsp.rm(absolute, { recursive: true, force: true });
          result.cleanedFiles.push(relPath);
        }
      } else {
        await fsp.rm(absolute, { force: true });
        result.cleanedFiles.push(relPath);
        // Attempt to clean parent directory if empty and is a generated folder
        await cleanEmptyParentIfGenerated(workspaceRoot, path.dirname(relPath), options.baselineArtifacts);
      }
    } catch {
      // Ignore file deletion failures (e.g. locked files on Windows)
    }
  }

  return result;
}

async function getGitUntrackedPaths(workspaceRoot: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: workspaceRoot,
      windowsHide: true,
    });
    return stdout
      .split(/\r?\n/)
      .filter(line => line.startsWith('?? '))
      .map(line => line.slice(3).trim())
      .filter(Boolean)
      .map(p => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  } catch {
    return [];
  }
}

async function scanGeneratedCacheDirectories(workspaceRoot: string, candidates: Set<string>): Promise<void> {
  async function walk(dir: string, depth = 0): Promise<void> {
    if (depth > 10) return;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === RUNTIME_INTERNAL_STATE_DIR) continue;
      const absolute = path.join(dir, entry.name);
      const relPath = path.relative(workspaceRoot, absolute).replace(/\\/g, '/');

      if (entry.isDirectory()) {
        const seg = entry.name.toLowerCase();
        if (GENERATED_CACHE_DIR_SEGMENTS.has(seg)) {
          // Add all files within this cache directory
          await collectAllFiles(workspaceRoot, absolute, candidates);
        } else {
          await walk(absolute, depth + 1);
        }
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (GENERATED_FILE_EXTENSIONS.has(ext)) {
          candidates.add(relPath);
        }
      }
    }
  }

  await walk(workspaceRoot).catch(() => undefined);
}

async function collectAllFiles(workspaceRoot: string, dir: string, candidates: Set<string>): Promise<void> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const relPath = path.relative(workspaceRoot, absolute).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      await collectAllFiles(workspaceRoot, absolute, candidates);
    } else {
      candidates.add(relPath);
    }
  }
}

async function cleanEmptyParentIfGenerated(
  workspaceRoot: string,
  relDir: string,
  baselineArtifacts?: ReadonlySet<string>,
): Promise<void> {
  if (!relDir || relDir === '.' || relDir === '/') return;
  const base = path.basename(relDir).toLowerCase();
  if (GENERATED_CACHE_DIR_SEGMENTS.has(base)) {
    if (baselineArtifacts?.has(relDir)) return;
    const absDir = path.join(workspaceRoot, relDir);
    try {
      const entries = await fsp.readdir(absDir);
      if (entries.length === 0) {
        await fsp.rmdir(absDir);
        await cleanEmptyParentIfGenerated(workspaceRoot, path.dirname(relDir), baselineArtifacts);
      }
    } catch {
      // Ignore
    }
  }
}

async function collectFilesRecursively(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...await collectFilesRecursively(fullPath));
      } else {
        files.push(fullPath);
      }
    }
  } catch {
    // Ignore
  }
  return files;
}
