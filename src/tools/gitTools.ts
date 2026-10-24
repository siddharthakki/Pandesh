import { ToolResult, ToolContext } from './ToolTypes';
import { GitService } from '../services/GitService';
import { WorkspaceSecurity } from '../services/WorkspaceSecurity';
import { Config } from '../config/Config';

export async function gitStatus(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const git = new GitService(ctx.workspaceRoot);
  try {
    const output = await git.status();
    return { ok: true, data: { output }, summary: 'git status' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function gitDiff(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const git = new GitService(ctx.workspaceRoot);
  let filePath: string | undefined;

  if (args['path']) {
    try {
      filePath = await WorkspaceSecurity.resolveInsideWorkspace(
        String(args['path']),
        ctx.workspaceRoot,
        Config.getAllowOutsideWorkspace(),
      );
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  try {
    const output = await git.diff(filePath);
    return { ok: true, data: { output }, summary: `git diff${filePath ? ` ${filePath}` : ''}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function gitBranch(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const git = new GitService(ctx.workspaceRoot);
  try {
    const output = await git.branch();
    return { ok: true, data: { output }, summary: 'git branch' };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function gitLog(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const git = new GitService(ctx.workspaceRoot);
  const limit = Number(args['limit'] ?? 10);
  try {
    const output = await git.log(limit);
    return { ok: true, data: { output }, summary: `git log --max-count=${limit}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
