import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { Config } from '../../config/Config';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { MockProvider } from '../mocks/MockProvider';

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

describe('policy-safe autonomous runtime', () => {
  let root: string;
  let provider: MockProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-policy-safe-'));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    vi.spyOn(Config, 'getTrustedAutonomyEnabled').mockReturnValue(true);
    vi.spyOn(Config, 'getSequentialRolesEnabled').mockReturnValue(false);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('blocks immediately and never validates or repairs after a policy denial', async () => {
    provider.enqueueToolCall('run_command', { command: 'rm -rf /' }, 'destructive-call');
    provider.enqueueText('This response must never be requested.');
    const runtime = new AgentRuntime(root, secretStorage());
    const errors: string[] = [];

    await runtime.run(
      'Delete the root filesystem.',
      'agent',
      { onError: message => errors.push(message) },
      undefined,
      undefined,
      'policy-safe-task',
      {
        validationCommands: [
          { category: 'acceptance', command: 'node -e "process.exit(0)"', required: true },
        ],
      },
    );

    const snapshot = await runtime.getTask('policy-safe-task');
    expect(errors.some(message => message.includes('policy violation'))).toBe(true);
    expect(snapshot.phase).toBe('blocked');
    expect(snapshot.task.status).toBe('blocked');
    expect(snapshot.validationPassed).toBe(false);
    expect(snapshot.blockedReason).toMatch(/root filesystem/i);
    expect(provider.capturedRequests).toHaveLength(1);

    const eventState = await runtime.taskStore.getEvents('policy-safe-task');
    expect(eventState.events.some(event => event.type === 'validation_started')).toBe(false);
    expect(eventState.events.some(event => event.type === 'repair_started')).toBe(false);

    const metrics = JSON.parse(await fs.readFile(
      path.join(runtime.taskStore.getTaskDir('policy-safe-task'), 'role-workflow.json'),
      'utf8',
    ));
    expect(metrics.baselineMode).toBe('single-role');
    expect(metrics.finalStatus).toBe('blocked');
    expect(metrics.engineModelCalls).toBe(1);
  });
});
