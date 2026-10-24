import * as fs from 'fs/promises';
import * as path from 'path';

const EXCLUDE_LINE = '.ollama-agent/';

/**
 * Ensures the workspace's `.git/info/exclude` file excludes `.ollama-agent/`
 * from `git status`/`git add` without ever touching the user's own
 * `.gitignore`. This is a purely local, per-clone exclusion (like a
 * developer's personal ignore rules) — appropriate because `.ollama-agent/`
 * holds extension-local state, not something the project wants to commit to
 * its own ignore policy.
 *
 * No-ops (never throws) when:
 *  - `workspaceRoot` is not inside a Git repository (no `.git/` directory).
 *  - `.git/info/exclude` already contains a `.ollama-agent/` line.
 *
 * Creates `.git/info/exclude` (and its parent `.git/info/` directory) if
 * `.git/` exists but `info/exclude` does not yet.
 */
export async function ensureGitExclude(workspaceRoot: string, log?: (message: string, ...args: unknown[]) => void): Promise<void> {
  try {
    const gitDir = path.join(workspaceRoot, '.git');
    const gitDirStat = await fs.stat(gitDir).catch(() => null);
    if (!gitDirStat) {
      // Not a git repo root (or `.git` is missing for some other reason) —
      // nothing to do.
      return;
    }

    let effectiveGitDir = gitDir;
    if (gitDirStat.isFile()) {
      const content = await fs.readFile(gitDir, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        effectiveGitDir = path.resolve(workspaceRoot, match[1].trim());
      }
    }

    let infoDir = path.join(effectiveGitDir, 'info');
    try {
      const commondirContent = await fs.readFile(path.join(effectiveGitDir, 'commondir'), 'utf8');
      const commondir = path.resolve(effectiveGitDir, commondirContent.trim());
      infoDir = path.join(commondir, 'info');
    } catch {
      // Use effectiveGitDir/info if no commondir file exists
    }

    const excludePath = path.join(infoDir, 'exclude');

    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch {
      existing = '';
    }

    const alreadyExcluded = existing
      .split(/\r?\n/)
      .some((line) => line.trim() === EXCLUDE_LINE || line.trim() === '.ollama-agent');
    if (alreadyExcluded) {
      return;
    }

    await fs.mkdir(infoDir, { recursive: true });
    const needsLeadingNewline = existing.length > 0 && !existing.endsWith('\n');
    const addition = `${needsLeadingNewline ? '\n' : ''}\n${EXCLUDE_LINE}\n`;
    await fs.appendFile(excludePath, existing.length === 0 ? `${EXCLUDE_LINE}\n` : addition, 'utf8');
  } catch (error) {
    try {
      log?.('[ensureGitExclude] Failed to update .git/info/exclude (non-fatal):', error);
    } catch {
      // never let a broken logger turn a non-fatal failure into a thrown error
    }
  }
}
