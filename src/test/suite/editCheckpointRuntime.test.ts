import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { CheckpointManager } from '../../agent/CheckpointManager';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ResolvedModelDefaults } from '../../config/ResolvedModelDefaults';
import { MockProvider } from '../mocks/MockProvider';
import { _resetConfig, _setConfig } from '../mocks/vscode';

function secretStorage(): vscode.SecretStorage {
  return {
    get: async () => undefined,
    store: async () => undefined,
    delete: async () => undefined,
    onDidChange: (_listener, _thisArgs, disposables) => {
      const disposable: vscode.Disposable = { dispose: () => undefined };
      disposables?.push(disposable);
      return disposable;
    },
  };
}

describe('existing-file edit checkpoint workflow', () => {
  let root: string;
  let provider: MockProvider;
  let target: string;
  let unrelated: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-edit-checkpoint-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    target = path.join(root, 'src', 'feature.ts');
    unrelated = path.join(root, 'src', 'unrelated.ts');
    await fs.writeFile(target, 'export const enabled = false;\n', 'utf8');
    await fs.writeFile(unrelated, 'export const userWork = true;\n', 'utf8');
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'edit-checkpoint-fixture',
      scripts: { compile: 'node -e "process.exit(0)"' },
    }, null, 2));

    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    _setConfig('ollama-agent.trustedAutonomyEnabled', false);
    _setConfig('ollama-agent.sequentialRolesEnabled', false);
    _setConfig('ollama-agent.requireApprovalForWrites', true);
    _setConfig('ollama-agent.requireApprovalForCommands', true);
    _setConfig('ollama-agent.enableCheckpoints', true);
    // agentModel/chatModel default to '' ("Auto" — see Defaults.ts); simulated
    // here as AgentPanel.loadModels() would populate it in real usage (see
    // Config.ts / ResolvedModelDefaults).
    ResolvedModelDefaults.set('agent', 'qwen3-coder:30b');
    ResolvedModelDefaults.set('chat', 'qwen2.5-coder:14b');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    _resetConfig();
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('edits, validates, checkpoints, and rewinds without touching unrelated work', async () => {
    provider.enqueueToolCall('read_file', { path: 'src/feature.ts' });
    provider.enqueueToolCall('edit_file', {
      path: 'src/feature.ts',
      strategy: 'search_replace',
      search: 'export const enabled = false;',
      replace: 'export const enabled = true;',
      allowUnverifiedOverwrite: true,
    });
    provider.enqueueToolCall('run_command', { command: 'npm run compile' });
    provider.enqueueText('Updated src/feature.ts and compilation passed.');

    const runtime = new AgentRuntime(root, secretStorage());
    const approvals: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const errors: string[] = [];
    runtime.setApprovalRequestCallback(request => {
      approvals.push({ toolName: request.toolName, args: request.args });
      void runtime.respondToApproval(request.id, 'approved');
    });

    await runtime.run(
      'Change the enabled flag in src/feature.ts to true, run npm run compile, and report the result.',
      'agent',
      { onError: message => errors.push(message) },
      undefined,
      undefined,
      'edit-checkpoint-task',
    );

    expect(errors).toEqual([]);
    expect(approvals.map(item => item.toolName)).toEqual(['edit_file', 'run_command']);
    expect(await fs.readFile(target, 'utf8')).toBe('export const enabled = true;\n');
    expect(await fs.readFile(unrelated, 'utf8')).toBe('export const userWork = true;\n');
    expect((await runtime.getTask('edit-checkpoint-task')).phase).toBe('completed');

    const checkpoints = new CheckpointManager(root);
    const beforeRewind = await checkpoints.listCheckpoints();
    expect(beforeRewind).toHaveLength(1);
    expect(beforeRewind[0].files).toHaveLength(1);
    expect(beforeRewind[0].files[0].operation).toBe('modify');
    expect(path.normalize(beforeRewind[0].files[0].path)).toBe(path.normalize(target));

    const rewind = await checkpoints.rewindLastCheckpoint();
    expect(rewind?.restored).toContain(`restored: ${target}`);
    expect(await fs.readFile(target, 'utf8')).toBe('export const enabled = false;\n');
    expect(await fs.readFile(unrelated, 'utf8')).toBe('export const userWork = true;\n');
    expect(await checkpoints.listCheckpoints()).toHaveLength(0);
  }, 20_000);
});
