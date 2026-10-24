/**
 * Git environment prerequisites. These are facts about the user's machine or
 * folder, never about the model or provider: they must not be retried, must
 * not change models, and must not count against a provider circuit breaker.
 */

/** The workspace is not a Git repository, or its HEAD cannot be read. Required before any governed work starts. */
export const GIT_REPOSITORY_UNAVAILABLE = 'git_repository_unavailable' as const;
/** Git has no author/committer identity. Required only to create the delivery commit. */
export const GIT_AUTHOR_IDENTITY_UNAVAILABLE = 'git_author_identity_unavailable' as const;
/** Pre-M48 readiness code for a missing repository/HEAD (misleadingly named); still recognised in persisted state. */
const LEGACY_GIT_IDENTITY_UNAVAILABLE = 'git_identity_unavailable';

const GIT_PREREQUISITE_CODES: ReadonlySet<string> = new Set([
  GIT_REPOSITORY_UNAVAILABLE,
  GIT_AUTHOR_IDENTITY_UNAVAILABLE,
  LEGACY_GIT_IDENTITY_UNAVAILABLE,
]);

export function isGitPrerequisiteCode(code: string | undefined): boolean {
  return code !== undefined && GIT_PREREQUISITE_CODES.has(code);
}

export function gitPrerequisiteMessage(code: string | undefined): string {
  if (code === GIT_AUTHOR_IDENTITY_UNAVAILABLE) {
    return 'Git does not know who you are, so the delivery commit cannot be created. Set your Git identity with '
      + '`git config --global user.name "Your Name"` and `git config --global user.email "you@example.com"` '
      + '(omit --global to set it for this repository only), then approve delivery again. '
      + 'The validated change is kept in the isolated worktree; nothing was committed and your repository is untouched.';
  }
  return 'This folder is not a Git repository (or its HEAD cannot be read). KarkeDikha needs Git to isolate, review and deliver changes safely. '
    + 'Run `git init` in the folder and commit your current files, then start the task again. Nothing was changed.';
}

/** True when Git output says it could not determine an author/committer identity. */
export function isGitAuthorIdentityFailure(output: string): boolean {
  return /identity unknown|please tell me who you are|unable to auto-detect email|no (?:name|email) was given|empty ident name/i.test(output);
}

/** Delivery cannot commit until the user configures Git identity; the task stays waiting for delivery approval. */
export class GitAuthorIdentityUnavailableError extends Error {
  readonly code = GIT_AUTHOR_IDENTITY_UNAVAILABLE;

  constructor() {
    super(gitPrerequisiteMessage(GIT_AUTHOR_IDENTITY_UNAVAILABLE));
    this.name = 'GitAuthorIdentityUnavailableError';
  }
}

export function isGitAuthorIdentityUnavailableError(error: unknown): error is GitAuthorIdentityUnavailableError {
  return error instanceof GitAuthorIdentityUnavailableError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === GIT_AUTHOR_IDENTITY_UNAVAILABLE);
}
