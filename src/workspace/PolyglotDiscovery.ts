import * as fs from 'fs/promises';
import * as path from 'path';
import { WorkspaceRootDescriptor } from './WorkspaceTypes';

/**
 * Directories never worth descending into for capability discovery. A
 * smaller, local list rather than reusing `RepositoryIndex`'s private
 * `readIgnorePatterns` — this only needs to skip vendor/build noise, not
 * reproduce full `.gitignore` semantics.
 */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'out', 'dist', 'build', 'coverage', '.next',
  '.gradle', '.idea', '.vscode-test', '__pycache__', '.pytest_cache',
  '.ollama-agent', 'target', 'bin', 'obj', 'vendor', 'venv', '.venv',
]);

const MAX_SCAN_DEPTH = 4;
const MAX_ENTRIES_VISITED = 5_000;

export interface WorkspaceCapabilities {
  root: string;
  languages: string[];
  packageManagers: string[];
  hasDocker: boolean;
  databases: string[];
  testDirs: string[];
  configFiles: string[];
  /** Absolute paths of `.git` directories found *within* this root, i.e.
   * repositories nested inside it — distinct from the root's own
   * `WorkspaceRootKind`, which describes the root itself. */
  nestedRepos: string[];
}

interface Signal {
  language?: string;
  packageManager?: string;
  isDocker?: boolean;
  database?: string;
  isTestDir?: boolean;
  isConfig?: boolean;
}

function classifyEntry(name: string, isDirectory: boolean): Signal {
  if (isDirectory) {
    if (/^(tests?|__tests__|spec)$/i.test(name)) return { isTestDir: true };
    return {};
  }
  if (name === 'package.json') return { language: 'node' };
  if (name === 'pnpm-lock.yaml') return { language: 'node', packageManager: 'pnpm' };
  if (name === 'yarn.lock') return { language: 'node', packageManager: 'yarn' };
  if (name === 'package-lock.json') return { language: 'node', packageManager: 'npm' };
  if (name === 'pyproject.toml' || name === 'requirements.txt' || name === 'setup.py' || name === 'Pipfile') {
    return { language: 'python', packageManager: name === 'Pipfile' ? 'pipenv' : 'pip' };
  }
  if (/^Dockerfile(\..*)?$/.test(name) || name === 'docker-compose.yml' || name === 'docker-compose.yaml' || name === 'compose.yml') {
    return { isDocker: true };
  }
  if (name === 'go.mod') return { language: 'go', packageManager: 'go' };
  if (name === 'Cargo.toml') return { language: 'rust', packageManager: 'cargo' };
  if (name.endsWith('.csproj') || name.endsWith('.sln')) return { language: 'dotnet' };
  if (/\.(db|sqlite|sqlite3)$/i.test(name)) return { database: 'sqlite' };
  if (/\.(ya?ml|json|jsonc|toml|ini|env)$/i.test(name) && name !== 'package-lock.json') return { isConfig: true };
  return {};
}

/**
 * Bounded-depth scan of a single workspace root. Never gated on the root
 * having Git (or being a Git repository top-level at all) — repository
 * metadata is not a prerequisite for understanding what a folder contains.
 */
export async function discoverWorkspaceCapabilities(root: WorkspaceRootDescriptor): Promise<WorkspaceCapabilities> {
  const languages = new Set<string>();
  const packageManagers = new Set<string>();
  const databases = new Set<string>();
  const testDirs: string[] = [];
  const configFiles: string[] = [];
  const nestedRepos: string[] = [];
  let hasDocker = false;
  let visited = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || visited >= MAX_ENTRIES_VISITED) return;
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES_VISITED) return;
      visited += 1;
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === '.git') {
          nestedRepos.push(entryPath);
          continue;
        }
        if (SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith('.')) continue;
        const signal = classifyEntry(entry.name, true);
        if (signal.isTestDir) testDirs.push(path.relative(root.path, entryPath).replace(/\\/g, '/'));
        await walk(entryPath, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const signal = classifyEntry(entry.name, false);
      if (signal.language) languages.add(signal.language);
      if (signal.packageManager) packageManagers.add(signal.packageManager);
      if (signal.isDocker) hasDocker = true;
      if (signal.database) databases.add(signal.database);
      if (signal.isConfig) configFiles.push(path.relative(root.path, entryPath).replace(/\\/g, '/'));
    }
  }

  await walk(root.path, 0);
  // The root's own .git (if it is itself a repo) is identity, not a "nested"
  // repo found within it — exclude it from nestedRepos.
  const ownGitDir = path.join(root.path, '.git');
  const filteredNestedRepos = nestedRepos.filter(gitDir => gitDir !== ownGitDir);

  return {
    root: root.path,
    languages: [...languages].sort(),
    packageManagers: [...packageManagers].sort(),
    hasDocker,
    databases: [...databases].sort(),
    testDirs: testDirs.sort(),
    configFiles: configFiles.sort(),
    nestedRepos: filteredNestedRepos.sort(),
  };
}
