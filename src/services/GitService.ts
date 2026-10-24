import { CommandService } from './CommandService';

export class GitService {
  constructor(private workspaceRoot: string) {}

  async status(): Promise<string> {
    const r = await CommandService.runGit(['status'], this.workspaceRoot);
    return r.stdout || r.stderr;
  }

  async diff(filePath?: string): Promise<string> {
    const args = ['diff'];
    if (filePath) { args.push('--', filePath); }
    const r = await CommandService.runGit(args, this.workspaceRoot);
    return r.stdout || r.stderr;
  }

  async branch(): Promise<string> {
    const r = await CommandService.runGit(['branch', '-v'], this.workspaceRoot);
    return r.stdout || r.stderr;
  }

  async log(limit = 10): Promise<string> {
    const r = await CommandService.runGit(
      ['log', `--max-count=${limit}`, '--oneline', '--decorate'],
      this.workspaceRoot,
    );
    return r.stdout || r.stderr;
  }
}
