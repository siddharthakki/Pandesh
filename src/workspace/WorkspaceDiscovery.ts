import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorkspaceDescriptor, WorkspaceRootDescriptor } from './WorkspaceTypes';

const execFileAsync = promisify(execFile);

function pathsEqual(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function gitToplevel(rootPath: string, gitBinary: string): Promise<string | undefined> {
  try {
    const trustedCwd = path.resolve(rootPath).replace(/\\/g, '/');
    const result = await execFileAsync(gitBinary, ['-c', `safe.directory=${trustedCwd}`, 'rev-parse', '--show-toplevel'], {
      cwd: rootPath,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const toplevel = result.stdout.trim();
    if (!toplevel) return undefined;
    return await fs.realpath(toplevel);
  } catch {
    return undefined;
  }
}

async function isEmptyDirectory(rootPath: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(rootPath);
    return entries.length === 0;
  } catch {
    return false;
  }
}

/**
 * Classifies a single workspace root. Never runs `git init` or any mutating Git
 * command — this is read-only classification. `git` failures (not a repo, git
 * binary missing) are treated as "no Git here," never as an error.
 */
export async function discoverWorkspaceRoot(rootPath: string, gitBinary = 'git'): Promise<WorkspaceRootDescriptor> {
  const resolved = await fs.realpath(rootPath).catch(() => path.resolve(rootPath));
  const toplevel = await gitToplevel(resolved, gitBinary);
  if (toplevel && pathsEqual(toplevel, resolved)) {
    return { path: resolved, kind: 'git', gitRoot: toplevel };
  }
  if (toplevel) {
    return { path: resolved, kind: 'nested-git', parentRepoRoot: toplevel };
  }
  const empty = await isEmptyDirectory(resolved);
  return { path: resolved, kind: empty ? 'empty' : 'plain' };
}

export async function discoverWorkspaceDescriptor(
  folders: readonly { readonly path: string }[],
  gitBinary = 'git',
): Promise<WorkspaceDescriptor | undefined> {
  if (folders.length === 0) return undefined;
  const roots = await Promise.all(folders.map(folder => discoverWorkspaceRoot(folder.path, gitBinary)));
  return { roots, primaryRoot: roots[0] };
}
