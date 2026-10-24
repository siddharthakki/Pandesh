import { describe, it, expect, vi } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { GovernedCapabilityRegistry, createWorkspaceCapabilityAdapter, type GovernedCapabilityAdapter, type CapabilityHealth } from '../runtime/governedCapability';
import { createGithubCapabilityAdapter, type GithubCommandExecutor } from '../runtime/githubCapability';
import type { ModelToolCall, ModelToolDefinition } from '../runtime/modelBackend';
import type { ToolExecutionContext, ToolExecutionResult } from '../runtime/toolRunner';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'm38-fabric-'));
}

function fakeAdapter(overrides: Partial<GovernedCapabilityAdapter> & { id: string; toolName: string }): GovernedCapabilityAdapter {
  const def: ModelToolDefinition = { name: overrides.toolName, description: 'x', parameters: { type: 'object', properties: {} } };
  return {
    id: overrides.id,
    definitions: () => [def],
    classify: () => 'read_only',
    health: () => ({ state: 'available', checkedAt: new Date().toISOString() }),
    run: async () => ({ status: 'succeeded', exitCode: 0, output: 'ok' }),
    ...overrides,
  };
}

describe('M38 GovernedCapabilityRegistry normalization and dispatch', () => {
  it('aggregates definitions across adapters and dispatches by tool ownership', async () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({ id: 'alpha', toolName: 'alpha_tool' }));
    registry.register(fakeAdapter({ id: 'beta', toolName: 'beta_tool' }));
    const defs = registry.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(['alpha_tool', 'beta_tool']);

    const result = await registry.run({ name: 'beta_tool', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
  });

  it('rejects registering two adapters that claim the same tool name', () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({ id: 'alpha', toolName: 'shared' }));
    expect(() => registry.register(fakeAdapter({ id: 'beta', toolName: 'shared' }))).toThrow(/already owned/);
  });

  it('fails closed on an unknown tool name without dispatching to any adapter', async () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({ id: 'alpha', toolName: 'alpha_tool' }));
    const result = await registry.run({ name: 'nonexistent_tool', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('capability_unknown_tool');
  });

  it('exposes risk classification per tool via classify()', () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(createWorkspaceCapabilityAdapter());
    expect(registry.classify('read_file')).toEqual({ capabilityId: 'workspace', risk: 'read_only' });
    expect(registry.classify('run_command')).toEqual({ capabilityId: 'workspace', risk: 'consequential' });
    expect(registry.classify('missing_tool')).toBeUndefined();
  });

  it('reports capability health snapshot across all registered adapters', () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({ id: 'alpha', toolName: 'alpha_tool', health: () => ({ state: 'degraded', reason: 'slow', checkedAt: '2026-01-01T00:00:00Z' }) }));
    registry.register(fakeAdapter({ id: 'beta', toolName: 'beta_tool' }));
    const snapshot = registry.healthSnapshot();
    expect(snapshot.alpha.state).toBe('degraded');
    expect(snapshot.beta.state).toBe('available');
  });

  it.each(['unavailable', 'rate_limited', 'cancelling', 'authorization_required'] as const)(
    'never dispatches to a capability already known to be %s',
    async (state) => {
      const registry = new GovernedCapabilityRegistry();
      const run = vi.fn(async () => ({ status: 'succeeded' as const, exitCode: 0, output: 'should not run' }));
      registry.register(fakeAdapter({
        id: 'alpha',
        toolName: 'alpha_tool',
        health: (): CapabilityHealth => ({ state, reason: 'test', checkedAt: new Date().toISOString() }),
        run,
      }));
      const result = await registry.run({ name: 'alpha_tool', arguments: {} }, { cwd: process.cwd() });
      expect(run).not.toHaveBeenCalled();
      expect(result.status).toBe('failed');
      expect(result.resultCategory).toBe('capability_unavailable');
      expect(result.output).toContain(state);
    },
  );

  it('degraded health does not block dispatch (fallback must not silently increase authority, but degraded still executes with existing bounds)', async () => {
    const registry = new GovernedCapabilityRegistry();
    const run = vi.fn(async () => ({ status: 'succeeded' as const, exitCode: 0, output: 'ran' }));
    registry.register(fakeAdapter({
      id: 'alpha',
      toolName: 'alpha_tool',
      health: () => ({ state: 'degraded', checkedAt: new Date().toISOString() }),
      run,
    }));
    const result = await registry.run({ name: 'alpha_tool', arguments: {} }, { cwd: process.cwd() });
    expect(run).toHaveBeenCalledOnce();
    expect(result.status).toBe('succeeded');
  });

  it('catches an adapter that throws instead of returning a result, so one misbehaving capability cannot take down the attempt loop', async () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({
      id: 'alpha',
      toolName: 'alpha_tool',
      run: async () => { throw new Error('unexpected null pointer'); },
    }));
    const result = await registry.run({ name: 'alpha_tool', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('capability_threw');
    expect(result.output).toContain('alpha');
    expect(result.output).toContain('unexpected null pointer');
  });

  it('bounds an adapter-thrown message so a raw stack trace cannot flood evidence', async () => {
    const registry = new GovernedCapabilityRegistry();
    registry.register(fakeAdapter({
      id: 'alpha',
      toolName: 'alpha_tool',
      run: async () => { throw new Error(`frame ${'x'.repeat(1000)}`); },
    }));
    const result = await registry.run({ name: 'alpha_tool', arguments: {} }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.output.length).toBeLessThanOrEqual(600);
    expect(result.output.endsWith('…')).toBe(true);
  });
});

describe('M38 workspace capability adapter (wraps existing CoreToolRunner unchanged)', () => {
  it('classifies read_file as read-only and run_command as consequential', () => {
    const adapter = createWorkspaceCapabilityAdapter();
    expect(adapter.classify('read_file')).toBe('read_only');
    expect(adapter.classify('run_command')).toBe('consequential');
  });

  it('actually reads a file from the scoped cwd through the registry', async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'note.txt'), 'hello from m38');
    const registry = new GovernedCapabilityRegistry().register(createWorkspaceCapabilityAdapter());
    const result = await registry.run({ name: 'read_file', arguments: { path: 'note.txt' } }, { cwd: dir });
    expect(result.status).toBe('succeeded');
    expect(result.output).toContain('hello from m38');
  });
});

function scriptedGithubExecutor(script: Record<string, { stdout?: string; stderr?: string; code?: number }>): GithubCommandExecutor {
  const calls: string[][] = [];
  const executor: GithubCommandExecutor = async (args) => {
    calls.push(args);
    const key = args.join(' ');
    const match = Object.keys(script).find((prefix) => key.startsWith(prefix));
    const scripted = match ? script[match] : undefined;
    return { stdout: scripted?.stdout ?? '', stderr: scripted?.stderr ?? '', code: scripted?.code ?? 0 };
  };
  (executor as GithubCommandExecutor & { calls: string[][] }).calls = calls;
  return executor as GithubCommandExecutor & { calls: string[][] };
}

describe('M38 governed GitHub capability adapter', () => {
  it('classifies github_read_issue as read-only and github_comment_on_issue as consequential', () => {
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor: scriptedGithubExecutor({}) });
    expect(adapter.classify('github_read_issue')).toBe('read_only');
    expect(adapter.classify('github_comment_on_issue')).toBe('consequential');
  });

  it('reads an issue and redacts anything that looks like a token from evidence', async () => {
    const executor = scriptedGithubExecutor({
      'issue view 42': { stdout: JSON.stringify({ number: 42, title: 'Bug', body: 'auth token ghp_abcdefghijklmnopqrstuvwxyz123456 leaked', state: 'open', url: 'https://github.com/acme/widgets/issues/42', comments: [] }), code: 0 },
    });
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    const result = await adapter.run({ name: 'github_read_issue', arguments: { number: 42 } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz123456');
    expect(result.output).toContain('[redacted-token]');
  });

  it('posts a comment exactly once and never mutates a repository other than the configured one', async () => {
    const executor = scriptedGithubExecutor({
      'issue view 7 --repo acme/widgets --json comments': { stdout: JSON.stringify({ comments: [] }), code: 0 },
      'issue comment 7': { stdout: 'https://github.com/acme/widgets/issues/7#comment', code: 0 },
    });
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    const result = await adapter.run({ name: 'github_comment_on_issue', arguments: { number: 7, body: 'Proposed fix attached.' } }, { cwd: process.cwd() });
    expect(result.status).toBe('succeeded');
    expect(result.resultCategory).toBe('github_write_succeeded');
    const calls = (executor as GithubCommandExecutor & { calls: string[][] }).calls;
    expect(calls.every((call) => call.includes('--repo') ? call[call.indexOf('--repo') + 1] === 'acme/widgets' : true)).toBe(true);
  });

  it('does not duplicate the external mutation on retry with the same issue and body (idempotent write)', async () => {
    let postedBody: string | null = null;
    const executor: GithubCommandExecutor = async (args) => {
      if (args[0] === 'issue' && args[1] === 'view') {
        return { stdout: JSON.stringify({ comments: postedBody ? [{ body: postedBody }] : [] }), stderr: '', code: 0 };
      }
      if (args[0] === 'issue' && args[1] === 'comment') {
        expect(postedBody).toBeNull(); // a second real write would be the bug this test guards against
        postedBody = args[args.indexOf('--body') + 1];
        return { stdout: 'posted', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    const first = await adapter.run({ name: 'github_comment_on_issue', arguments: { number: 9, body: 'Proposed fix attached.' } }, { cwd: process.cwd() });
    expect(first.status).toBe('succeeded');
    expect(first.resultCategory).toBe('github_write_succeeded');

    const second = await adapter.run({ name: 'github_comment_on_issue', arguments: { number: 9, body: 'Proposed fix attached.' } }, { cwd: process.cwd() });
    expect(second.status).toBe('succeeded');
    expect(second.resultCategory).toBe('github_write_deduplicated');
  });

  it('rejects invalid arguments without shelling out', async () => {
    const executor = scriptedGithubExecutor({});
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    const result = await adapter.run({ name: 'github_comment_on_issue', arguments: { number: -1, body: '' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('github_invalid_arguments');
    expect((executor as GithubCommandExecutor & { calls: string[][] }).calls.length).toBe(0);
  });
});

describe('M38 no-bypass: a capability marked unavailable through the registry cannot execute even though the underlying adapter still could', () => {
  it('blocks the github capability at the registry boundary once health degrades to authorization_required', async () => {
    const executor = scriptedGithubExecutor({ 'issue comment': { code: 0 } });
    const adapter = createGithubCapabilityAdapter({ repository: 'acme/widgets', cwd: process.cwd(), executor });
    // Simulate a prior failed auth probe by wrapping health() — the registry
    // must consult health() before ever calling adapter.run().
    const runSpy = vi.fn(adapter.run.bind(adapter));
    const gated: GovernedCapabilityAdapter = { ...adapter, run: runSpy, health: () => ({ state: 'authorization_required', reason: 'gh auth expired', checkedAt: new Date().toISOString() }) };
    const registry = new GovernedCapabilityRegistry().register(gated);
    const result = await registry.run({ name: 'github_comment_on_issue', arguments: { number: 1, body: 'x' } }, { cwd: process.cwd() });
    expect(result.status).toBe('failed');
    expect(result.resultCategory).toBe('capability_unavailable');
    expect(runSpy).not.toHaveBeenCalled();
  });
});
