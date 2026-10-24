import { describe, expect, it } from 'vitest';
import {
  DeliveryCommandRunner,
  GhCliGitHubDeliveryTransport,
  parseGitHubPullRequestMetadata,
} from '../../autonomous/M15AutonomousWork';

class FakeRunner implements DeliveryCommandRunner {
  readonly calls: Array<{ command: string; cwd: string; args: readonly string[] }> = [];

  constructor(private readonly outputs: string[]) {}

  async run(command: string, cwd: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    this.calls.push({ command, cwd, args: [...args] });
    const stdout = this.outputs.shift();
    if (stdout === undefined) throw new Error('Unexpected command');
    return { stdout, stderr: '' };
  }
}

describe('GhCliGitHubDeliveryTransport', () => {
  it('parses authoritative gh pr view JSON', () => {
    expect(parseGitHubPullRequestMetadata(JSON.stringify({
      number: 42,
      url: 'https://github.com/siddharthakki/ollama-agent/pull/42',
      isDraft: true,
      headRefName: 'dogfood/m17-delivery-e2e-run',
      baseRefName: 'dogfood/m17',
      state: 'OPEN',
    }))).toEqual({
      number: 42,
      url: 'https://github.com/siddharthakki/ollama-agent/pull/42',
      draft: true,
      headRefName: 'dogfood/m17-delivery-e2e-run',
      baseRefName: 'dogfood/m17',
      state: 'OPEN',
    });
  });

  it('returns the persisted PR number and URL from structured view output', async () => {
    const runner = new FakeRunner([
      'https://github.com/siddharthakki/ollama-agent/pull/57\n',
      JSON.stringify({ number: 57, url: 'https://github.com/siddharthakki/ollama-agent/pull/57', isDraft: true, headRefName: 'head', baseRefName: 'dogfood/m17', state: 'OPEN' }),
    ]);
    const transport = new GhCliGitHubDeliveryTransport('C:\\repo', runner);

    const result = await transport.createDraftPullRequest({
      owner: 'siddharthakki', repo: 'ollama-agent', title: 'Disposable', body: 'Dogfood', head: 'head', base: 'dogfood/m17',
    });

    expect(result.number).toBe(57);
    expect(result.url).toBe('https://github.com/siddharthakki/ollama-agent/pull/57');
    expect(runner.calls[1].args).toEqual([
      'pr', 'view', 'https://github.com/siddharthakki/ollama-agent/pull/57', '--repo', 'siddharthakki/ollama-agent', '--json', 'number,url,isDraft,headRefName,baseRefName,state',
    ]);
  });
});
