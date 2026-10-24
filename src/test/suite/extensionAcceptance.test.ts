import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { registerCommands } from '../../activation/registerCommands';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import { CONFIGURE_PROVIDER_MODEL_COMMAND } from '../../activation/ConfigureProviderModelController';
import { RUN_FORGE_CODING_TASK_COMMAND, RUN_FORGE_READINESS_CHECK_COMMAND } from '../../activation/ForgeCodingTaskController';

class AcceptanceProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  healthCalls = 0;
  listCalls = 0;
  models: ModelInfo[] = [{ name: 'current-model' }, { name: 'accepted-model' }];

  async healthCheck(): Promise<void> {
    this.healthCalls += 1;
  }

  async listModels(): Promise<ModelInfo[]> {
    this.listCalls += 1;
    return this.models;
  }

  async chat(
    messages: ChatMessage[],
    _tools: ToolDefinition[],
    _options: ProviderChatOptions,
  ): Promise<ChatResponse> {
    const taskPrompt = messages.map(message => message.content).join('\n');
    const stage = /Stage: ([^\n]+)/.exec(taskPrompt)?.[1];
    if (stage === 'repository-analyst' || stage === 'planner') {
      return {
        message: {
          role: 'assistant',
          content: `bounded ${stage} acceptance output`,
        },
        done: true,
      };
    }
    // The lightweight tier now runs through the bounded pre-proposal
    // investigation loop, which requests an action envelope rather than a
    // bare CodingProposal; only these two lightweight-tier branches need it —
    // the 'Stage: ...' branch above belongs to the unchanged five-stage graph.
    const envelope = (proposal: Record<string, unknown>) =>
      taskPrompt.includes('Investigation turn') ? { action: 'submit_proposal', proposal } : proposal;
    if (taskPrompt.includes('host-bound replace')) {
      return {
        message: {
          role: 'assistant',
          content: JSON.stringify(envelope({
            version: 1,
            taskSummary: 'Replace host-bound untracked files',
            operations: [
              { type: 'replace', path: 'src/generated/untrackedA.ts', reason: 'acceptance replace A', content: 'export const untrackedA = "after";\n' },
              { type: 'replace', path: 'src/generated/untrackedB.ts', reason: 'acceptance replace B', content: 'export const untrackedB = "after";\n' },
            ],
            validationCommands: [{ kind: 'tsc-no-emit' }],
            warnings: [],
            status: 'proposed',
          })),
        },
        done: true,
      };
    }
    return {
      message: {
        role: 'assistant',
        content: JSON.stringify(envelope({
          version: 1,
          taskSummary: 'Create M9 acceptance file',
          operations: [{
            type: 'create',
            path: 'src/generated/m9Acceptance.ts',
            reason: 'automated acceptance',
            content: 'export const m9Acceptance = true;\n',
          }],
          validationCommands: [{ kind: 'tsc-no-emit' }],
          warnings: [],
          status: 'proposed',
        })),
      },
      done: true,
    };
  }
}

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

function extensionContext(): vscode.ExtensionContext {
  return {
    subscriptions: [],
    secrets: secretStorage(),
  } as vscode.ExtensionContext;
}

describe('M8.6 automated extension acceptance harness', () => {
  let root: string;
  let provider: AcceptanceProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-extension-acceptance-'));
    await provisionLocalTypeScript(root);
    await initGit(root);
    provider = new AcceptanceProvider();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.apiBase', 'http://localhost:11434');
    vscodeMock._setConfig('ollama-agent.chatModel', 'current-model');
    // codingModel defaults to '' ("Auto" — see Defaults.ts); the Forge
    // controllers under test (ForgeCodingTaskController) read
    // Config.getCodingModel() directly with no discovery step of their own,
    // so an explicit value is required here exactly as chatModel is set above.
    vscodeMock._setConfig('ollama-agent.codingModel', 'current-model');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._resetCommands();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('registers discoverable commands and runs self diagnostics', async () => {
    registerCommands(extensionContext(), { stop: () => undefined, clearSession: () => undefined } as never, {} as never, root);

    expect(vscodeMock._registeredCommand(CONFIGURE_PROVIDER_MODEL_COMMAND)).toBeTypeOf('function');
    expect(vscodeMock._registeredCommand(RUN_FORGE_CODING_TASK_COMMAND)).toBeTypeOf('function');
    expect(vscodeMock._registeredCommand(RUN_FORGE_READINESS_CHECK_COMMAND)).toBeTypeOf('function');
    expect(vscodeMock._registeredCommand('ollama-agent.runDiagnostics')).toBeTypeOf('function');
    await vscodeMock._registeredCommand(RUN_FORGE_READINESS_CHECK_COMMAND)?.();
    expect(vscodeMock._outputChannels().some(channel => channel.content().includes('Forge Readiness Check'))).toBe(true);
    await vscodeMock._registeredCommand('ollama-agent.runDiagnostics')?.();

    const items = vscodeMock._lastQuickPickItems() as Array<{ detail?: string }> | undefined;
    expect(items?.some(item => item.detail?.includes('Provider: ollama'))).toBe(true);
  });

  it('writes, rereads, cancels and confirms chat model settings without manual UI', async () => {
    registerCommands(extensionContext(), { stop: () => undefined, clearSession: () => undefined } as never, {} as never, root);
    const command = vscodeMock._registeredCommand(CONFIGURE_PROVIDER_MODEL_COMMAND);

    await vscode.workspace.getConfiguration('ollama-agent').update('chatModel', 'current-model', vscode.ConfigurationTarget.Workspace);
    expect(vscode.workspace.getConfiguration('ollama-agent').get('chatModel')).toBe('current-model');

    await command?.();
    expect(vscode.workspace.getConfiguration('ollama-agent').get('chatModel')).toBe('current-model');

    vscodeMock._setQuickPickSelection({ label: 'accepted-model', modelName: 'accepted-model' });
    vscodeMock._setWarningMessageSelection('Update Model');
    await command?.();
    expect(vscode.workspace.getConfiguration('ollama-agent').get('chatModel')).toBe('accepted-model');
    expect(vscodeMock._configUpdates().filter(update => update.key === 'ollama-agent.chatModel')).toHaveLength(2);

    vscodeMock._resetNotifications();
    await command?.();
    expect(vscodeMock._lastWarningMessage()).not.toBe('Ollama Agent: provider model configuration is already running.');
  });

  it('runs Forge coding task acceptance with approval', async () => {
    registerCommands(extensionContext(), { stop: () => undefined, clearSession: () => undefined } as never, {} as never, root);
    const command = vscodeMock._registeredCommand(RUN_FORGE_CODING_TASK_COMMAND);

    vscodeMock._setQuickPickSelection({ label: 'Summary: Create M9 acceptance file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await command?.('create the M9 acceptance file');
    expect(await fs.readFile(path.join(root, 'src/generated/m9Acceptance.ts'), 'utf8')).toContain('m9Acceptance');
    expect(vscodeMock._outputChannels().some(channel => channel.content().includes('Status: completed'))).toBe(true);
    expect(vscodeMock._outputChannels().some(channel => channel.content().includes('npx tsc --noEmit --pretty false'))).toBe(true);
  });

  it('runs host-bound replace proposals through the command path', async () => {
    registerCommands(extensionContext(), { stop: () => undefined, clearSession: () => undefined } as never, {} as never, root);
    const command = vscodeMock._registeredCommand(RUN_FORGE_CODING_TASK_COMMAND);

    await fs.mkdir(path.join(root, 'src/generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/generated/untrackedA.ts'), 'export const untrackedA = "before";\n');
    await fs.writeFile(path.join(root, 'src/generated/untrackedB.ts'), 'export const untrackedB = "before";\n');
    vscodeMock._resetWindowState();
    vscodeMock._setQuickPickSelection({ label: 'Summary: Replace host-bound untracked files' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await command?.('host-bound replace two existing untracked files');
    expect(await fs.readFile(path.join(root, 'src/generated/untrackedA.ts'), 'utf8')).toContain('"after"');
    expect(await fs.readFile(path.join(root, 'src/generated/untrackedB.ts'), 'utf8')).toContain('"after"');
  });

  it('keeps cancellation and review rejection mutation-free', async () => {
    registerCommands(extensionContext(), { stop: () => undefined, clearSession: () => undefined } as never, {} as never, root);
    const command = vscodeMock._registeredCommand(RUN_FORGE_CODING_TASK_COMMAND);

    await fs.rm(path.join(root, 'src'), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    vscodeMock._resetWindowState();
    vscodeMock._requestProgressCancellation();
    await command?.('create cancelled file');
    await expect(fs.stat(path.join(root, 'src/generated/m9Acceptance.ts'))).rejects.toThrow();

    vscodeMock._resetWindowState();
    vscodeMock._setQuickPickSelection(undefined);
    await command?.('create rejected file');
    await expect(fs.stat(path.join(root, 'src/generated/m9Acceptance.ts'))).rejects.toThrow();

    for (const disposable of extensionContext().subscriptions) {
      disposable.dispose();
    }
  });
});

async function provisionLocalTypeScript(root: string): Promise<void> {
  const tscDir = path.join(root, 'node_modules', 'typescript', 'bin');
  await fs.mkdir(tscDir, { recursive: true });
  const tscPath = path.join(tscDir, 'tsc');
  await fs.writeFile(tscPath, 'process.exit(0);\n');
  if (process.platform !== 'win32') {
    fsSync.chmodSync(tscPath, 0o755);
  }
}

async function initGit(root: string): Promise<void> {
  const { spawn } = await import('child_process');
  for (const args of [
    ['init'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
    ['add', '.'],
    ['commit', '-m', 'init'],
  ]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`)));
    });
  }
}
