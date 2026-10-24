import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { AgentRuntime } from '../../agent/AgentRuntime';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { TaskStoreWriteBarrier } from '../../services/TaskStoreWriteBarrier';
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

const expectedContent = `# Ollama Agent Smoke Test

* Workspace grounding: passed
* Model routing: passed
* Tool execution: passed
* Controlled write: passed`;

const prompt = `Create exactly one new file:

docs/agent-smoke-test.md

Use exactly this content:

${expectedContent}

Requirements:
1. Do not modify any other file.
2. Request approval before creating the file.
3. After creating it, run \`npm run compile\`.
4. Do not run any other command.
5. Report the file created and whether compilation passed.`;

describe('strict runtime smoke task', () => {
  let root: string;
  let provider: MockProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-strict-smoke-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      name: 'strict-smoke-fixture',
      scripts: { compile: 'node -e "process.exit(0)"' },
    }, null, 2));
    provider = new MockProvider();
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    _setConfig('ollama-agent.trustedAutonomyEnabled', false);
    _setConfig('ollama-agent.sequentialRolesEnabled', false);
    _setConfig('ollama-agent.requireApprovalForWrites', true);
    _setConfig('ollama-agent.requireApprovalForCommands', true);
    _setConfig('ollama-agent.enableCheckpoints', true);
    // agentModel/chatModel default to '' ("Auto" — see Defaults.ts). In real
    // usage AgentPanel.loadModels() always runs discovery before a request
    // can be dispatched and populates ResolvedModelDefaults with what Auto
    // actually selected (see Config.ts). Simulated here with a real
    // ModelCapabilityRegistry-known name so context-window/capability logic
    // sees realistic values.
    ResolvedModelDefaults.set('agent', 'qwen3-coder:30b');
    ResolvedModelDefaults.set('chat', 'qwen2.5-coder:14b');
  });

  afterEach(async () => {
    await TaskStoreWriteBarrier.drain();
    vi.restoreAllMocks();
    _resetConfig();
    ResolvedModelDefaults.clear();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('canonicalizes the write, approves only requested actions, and completes', async () => {
    provider.enqueueToolCall('write_file', {
      path: 'docs/agent-smoke-test.md',
      content: '# Model reconstructed the content incorrectly',
    });
    provider.enqueueToolCall('run_command', { command: 'npm run compile' });
    provider.enqueueText('Created docs/agent-smoke-test.md and compilation passed.');

    const runtime = new AgentRuntime(root, secretStorage());
    const approvals: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const errors: string[] = [];
    runtime.setApprovalRequestCallback(request => {
      approvals.push({ toolName: request.toolName, args: request.args });
      void runtime.respondToApproval(request.id, 'approved');
    });

    await runtime.run(
      prompt,
      'agent',
      { onError: message => errors.push(message) },
      undefined,
      undefined,
      'strict-smoke-task',
    );

    expect(errors).toEqual([]);
    expect(approvals).toEqual([
      {
        toolName: 'write_file',
        args: { path: 'docs/agent-smoke-test.md', content: expectedContent },
      },
      {
        toolName: 'run_command',
        args: { command: 'npm run compile' },
      },
    ]);
    expect(await fs.readFile(path.join(root, 'docs', 'agent-smoke-test.md'), 'utf8'))
      .toBe(expectedContent);
    expect((await runtime.getTask('strict-smoke-task')).phase).toBe('completed');
    expect(provider.capturedRequests).toHaveLength(3);
    await TaskStoreWriteBarrier.drain();
    expect(TaskStoreWriteBarrier.pendingCount()).toBe(0);
  }, 20_000);
});
