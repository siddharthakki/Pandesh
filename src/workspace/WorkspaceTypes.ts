/**
 * A workspace root's relationship to Git, established once at discovery time.
 * - `git`: the root itself is a Git repository top-level (`git rev-parse --show-toplevel`
 *   resolves back to the root).
 * - `nested-git`: the root is inside a Git repository, but is not that repository's
 *   top-level (e.g. the user opened a subfolder of a larger repo as the workspace root).
 *   Worktree isolation cannot target a subdirectory, so this behaves like `plain`.
 * - `plain`: a non-empty folder with no Git repository reachable from it.
 * - `empty`: a folder with no entries at all.
 */
export type WorkspaceRootKind = 'git' | 'nested-git' | 'plain' | 'empty';

export interface WorkspaceRootDescriptor {
  /** Absolute, resolved (realpath'd where possible) path to this root. */
  path: string;
  kind: WorkspaceRootKind;
  /** Set for `git`: the repository top-level, equal to `path`. */
  gitRoot?: string;
  /** Set for `nested-git`: the ancestor repository's top-level. */
  parentRepoRoot?: string;
}

export interface WorkspaceDescriptor {
  roots: WorkspaceRootDescriptor[];
  /**
   * The root existing single-root call sites should keep using unless they are
   * explicitly root-aware. Preserves today's `workspaceFolders[0]` convention —
   * it does not prefer a Git root over a plain one — so introducing this type
   * changes no existing single-root behavior.
   */
  primaryRoot: WorkspaceRootDescriptor;
}
