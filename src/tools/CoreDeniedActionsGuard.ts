/**
 * M38 no-bypass projection (local, in-memory, per task/session).
 *
 * Core is the sole *source* of a denial (core/domain/capabilityDispatch.ts —
 * a rejected approval stays rejected on retry through the same Core-backed
 * tool). This guard is only a narrow local *enforcement projection* of that
 * fact: once Core denies a specific github_comment_on_issue action, this
 * blocks an equivalent `run_command` invocation of `gh issue comment` for the
 * same repository/issue within the same task, so denial cannot be replayed
 * through a different tool. It never originates a denial on its own and
 * never grants authority — it only ever narrows what a task may still do.
 */

interface DeniedGithubComment {
  repository: string;
  issueNumber: number;
}

const GH_COMMENT_COMMAND = /\bgh\s+issue\s+comment\s+(\d+)\b/i;
const GH_REPO_FLAG = /--repo(?:=|\s+)([^\s]+)/i;

export class CoreDeniedActionsGuard {
  private readonly deniedGithubComments: DeniedGithubComment[] = [];

  recordGithubCommentDenied(repository: string, issueNumber: number): void {
    this.deniedGithubComments.push({ repository, issueNumber });
  }

  /** Returns a reason string if `command` looks like a run_command replay of
   * a previously Core-denied `gh issue comment` action, else undefined. */
  blockedRunCommandReason(command: string): string | undefined {
    const commentMatch = command.match(GH_COMMENT_COMMAND);
    if (!commentMatch) return undefined;
    const issueNumber = Number(commentMatch[1]);
    const repoMatch = command.match(GH_REPO_FLAG);
    const repository = repoMatch ? repoMatch[1].replace(/^["']|["']$/g, '') : undefined;
    const matches = this.deniedGithubComments.some((denied) =>
      denied.issueNumber === issueNumber &&
      (denied.repository === '*' || repository === undefined || denied.repository === repository),
    );
    if (!matches) return undefined;
    return `A comment on issue #${issueNumber} was already denied through the governed GitHub capability and may not be replayed via run_command.`;
  }
}
