import { describe, expect, it } from 'vitest';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';

const call = { name: 'github_comment_on_issue', arguments: { number: 17, body: 'Exactly once.' } };
const context = { cwd: process.cwd() };

describe('M38 GitHub mutation idempotency precondition', () => {
  it('performs zero mutation when the comment-history dedupe read fails', async () => {
    const calls: string[][] = [];
    const executor: GithubCommandExecutor = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: '', stderr: 'temporary GitHub read failure', code: 1 };
      }
      return { stdout: 'unexpected write', stderr: '', code: 0 };
    };
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });

    const result = await adapter.run(call, context);

    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('github_idempotency_check_failed');
    expect(calls.filter((args) => args[0] === 'issue' && args[1] === 'comment')).toHaveLength(0);
  });

  it('performs zero mutation when the comment-history dedupe response is malformed', async () => {
    const calls: string[][] = [];
    const executor: GithubCommandExecutor = async (args) => {
      calls.push(args);
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: '{not-json', stderr: '', code: 0 };
      }
      return { stdout: 'unexpected write', stderr: '', code: 0 };
    };
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });

    const result = await adapter.run(call, context);

    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('github_idempotency_check_failed');
    expect(calls.filter((args) => args[0] === 'issue' && args[1] === 'comment')).toHaveLength(0);
  });
});
