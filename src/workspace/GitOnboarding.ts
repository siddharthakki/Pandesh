import * as vscode from 'vscode';
import * as crypto from 'crypto';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { WorkspaceRootDescriptor } from './WorkspaceTypes';
import { Logger } from '../services/Logger';

const execFileAsync = promisify(execFile);

export type GitOnboardingChoice = 'init' | 'attach' | 'continue-without-git';

function decisionKey(rootPath: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(rootPath)).digest('hex').slice(0, 16);
  return `ollama-agent.workspace.gitOnboarding.${hash}`;
}

/**
 * Offers the Git onboarding choice exactly once per non-Git root, persisted in
 * `workspaceState` (not the workspace itself). Never runs `git init`
 * automatically and never blocks: dismissing the prompt (Escape, click away)
 * is recorded as `continue-without-git`, the same non-destructive outcome as
 * explicitly choosing it, and callers proceed with a `PlainFolderHost`
 * regardless of what the user picks here.
 */
export async function ensureGitOnboardingDecision(
  context: vscode.ExtensionContext,
  root: WorkspaceRootDescriptor,
): Promise<GitOnboardingChoice | undefined> {
  if (root.kind === 'git') return undefined;
  const key = decisionKey(root.path);
  const existing = context.workspaceState.get<GitOnboardingChoice>(key);
  if (existing) return existing;

  const picked = await vscode.window.showQuickPick(
    [
      { label: '$(git-branch) Initialize Git', description: 'Run "git init" in this folder', value: 'init' as const },
      { label: '$(repo) Add to an existing repository', description: 'You will point this folder at a repository yourself', value: 'attach' as const },
      { label: '$(circle-slash) Continue without Git', description: 'Mutations are tracked with content-hash snapshots instead', value: 'continue-without-git' as const },
    ],
    {
      title: 'This folder is not a Git repository',
      placeHolder: 'How should ollama-agent handle version control here? (Esc = continue without Git)',
      ignoreFocusOut: true,
    },
  );
  const choice: GitOnboardingChoice = picked?.value ?? 'continue-without-git';
  await context.workspaceState.update(key, choice);

  if (choice === 'init') {
    try {
      await execFileAsync('git', ['init'], { cwd: root.path, windowsHide: true });
    } catch (error) {
      Logger.warn('[GitOnboarding] "git init" failed; continuing without Git for this session.', error);
    }
  } else if (choice === 'attach') {
    void vscode.window.showInformationMessage(
      'Move or link this folder into your existing repository, then reopen it — ollama-agent will detect Git automatically.',
    );
  }
  return choice;
}
