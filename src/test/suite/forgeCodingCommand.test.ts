import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { ForgeCodingTaskController } from '../../activation/ForgeCodingTaskController';
import { CodingPlanner } from '../../coding/CodingPlanner';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

class CodingProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  completion: string = JSON.stringify({
    version: 1,
    taskSummary: 'Create generated file',
    operations: [{ type: 'create', path: 'src/generated/m9Acceptance.ts', reason: 'acceptance', content: 'export const m9Acceptance = true;\n' }],
    validationCommands: [],
    warnings: [],
    status: 'proposed',
  });

  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages.map(message => message.content).join('\n');
    this.prompts.push(prompt);
    // The lightweight tier now runs through the bounded pre-proposal
    // investigation loop, which requests an action envelope rather than a
    // bare CodingProposal; the five-stage graph carries no such marker.
    const content = prompt.includes('Investigation turn')
      ? JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.completion) })
      : this.completion;
    return { message: { role: 'assistant', content }, done: true };
  }
}

function context(): vscode.ExtensionContext {
  return { subscriptions: [], secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } } as vscode.ExtensionContext;
}

describe('Forge coding command controller', () => {
  let root: string;
  let provider: CodingProvider;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-coding-command-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node -e "process.exit(0)"' } }));
    await initGit(root);
    provider = new CodingProvider();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetWindowState();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('shows proposal details and applies changes after explicit approval', async () => {
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create generated file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await new ForgeCodingTaskController(context(), root).run('create acceptance file');
    expect(await fs.readFile(path.join(root, 'src/generated/m9Acceptance.ts'), 'utf8')).toContain('m9Acceptance');
    expect(JSON.stringify(vscodeMock._lastQuickPickItems())).toContain('src/generated/m9Acceptance.ts');
    expect(vscodeMock._outputChannels()[0].content()).toContain('Status: completed');
  });

  it('keeps the normal validation task on one CodingPlanner call', async () => {
    // The lightweight tier's entry point is now planWithInvestigation (the
    // bounded pre-proposal investigation loop); plan() itself is unchanged
    // but no longer the method GovernedCodingExecutor calls here.
    const plannerSpy = vi.spyOn(CodingPlanner.prototype, 'planWithInvestigation');
    await new ForgeCodingTaskController(context(), root).run('Add validation so registerUser rejects an empty username and update the relevant tests.');
    expect(plannerSpy).toHaveBeenCalledTimes(1);
    // One provider call: the fake model submits its proposal on the first
    // investigation turn, exactly as CodingPlanner.plan()'s old single-shot
    // dispatch did — no read/search turns were needed or taken.
    expect(provider.prompts).toHaveLength(1);
    expect(provider.prompts[0]).toContain('Selected repository content');
    expect(provider.prompts[0]).not.toContain('Stage: repository-analyst');
  });

  it('uses the fixed graph instead of CodingPlanner.plan and performs exactly five stage calls', async () => {
    const plannerSpy = vi.spyOn(CodingPlanner.prototype, 'plan');
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create generated file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');

    await new ForgeCodingTaskController(context(), root).run('implement a cross-cutting architecture redesign and create acceptance file');

    expect(plannerSpy).not.toHaveBeenCalled();
    expect(provider.prompts).toHaveLength(5);
    expect(provider.prompts.map(prompt => /Stage: ([^\n]+)/.exec(prompt)?.[1])).toEqual([
      'repository-analyst',
      'planner',
      'implementer',
      'reviewer',
      'validator',
    ]);
    expect(vscodeMock._outputChannels()[0].content()).toContain('Graph status: completed');
    expect(vscodeMock._outputChannels()[0].content()).toContain('Proposal consumption: ready');
  });

  it('shows safely normalizable proposals for review but still requires approval', async () => {
    provider.completion = JSON.stringify({
      version: '1',
      task_summary: 'Create alias file',
      file_operations: [{ type: 'add', path: 'src/generated/aliasAcceptance.ts', reason: 'alias', content: 'export const aliasAcceptance = true;\n' }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    });
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create alias file' });
    await new ForgeCodingTaskController(context(), root).run('create alias acceptance file');
    await expect(fs.stat(path.join(root, 'src/generated/aliasAcceptance.ts'))).rejects.toThrow();
    expect(JSON.stringify(vscodeMock._lastQuickPickItems())).toContain('src/generated/aliasAcceptance.ts');

    vscodeMock._resetWindowState();
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create alias file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await new ForgeCodingTaskController(context(), root).run('create alias acceptance file');
    expect(await fs.readFile(path.join(root, 'src/generated/aliasAcceptance.ts'), 'utf8')).toContain('aliasAcceptance');
  });

  it('accepts normalized replace proposals without model fingerprints and binds host snapshots before mutation', async () => {
    await fs.mkdir(path.join(root, 'src/generated'), { recursive: true });
    await fs.writeFile(path.join(root, 'src/generated/bad.ts'), 'old\n');
    provider.completion = JSON.stringify({
      version: '1',
      task_summary: 'Host-bound alias replace',
      file_operations: [{ type: 'modify', path: 'src/generated/bad.ts', reason: 'host snapshot', content: 'new\n' }],
      validationCommands: [],
      warnings: [],
      status: 'proposed',
    });
    vscodeMock._setQuickPickSelection({ label: 'Summary: Host-bound alias replace' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await new ForgeCodingTaskController(context(), root).run('replace alias proposal');
    expect(await fs.readFile(path.join(root, 'src/generated/bad.ts'), 'utf8')).toBe('new\n');
  });

  it('keeps canonical fake-model acceptance healthy', async () => {
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create generated file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await new ForgeCodingTaskController(context(), root).run('create acceptance file');
    expect(await fs.readFile(path.join(root, 'src/generated/m9Acceptance.ts'), 'utf8')).toContain('m9Acceptance');
  });

  it('rejection and cancellation apply no mutation', async () => {
    vscodeMock._setQuickPickSelection(undefined);
    await new ForgeCodingTaskController(context(), root).run('create acceptance file');
    await expect(fs.stat(path.join(root, 'src/generated/m9Acceptance.ts'))).rejects.toThrow();

    vscodeMock._resetWindowState();
    vscodeMock._requestProgressCancellation();
    await new ForgeCodingTaskController(context(), root).run('create acceptance file');
    await expect(fs.stat(path.join(root, 'src/generated/m9Acceptance.ts'))).rejects.toThrow();
  });

  it('rejects concurrent second run while active and releases guard before terminal notification dismissal', async () => {
    provider.chat = async () => new Promise(resolve => setTimeout(() => resolve({ message: { role: 'assistant', content: provider.completion }, done: true }), 25));
    const controller = new ForgeCodingTaskController(context(), root);
    const first = controller.run('first');
    await Promise.resolve();
    await controller.run('second');
    expect(vscodeMock._lastWarningMessage()).toBe('KarkeDikha: Forge coding task is already running.');
    vscodeMock._setQuickPickSelection({ label: 'Summary: Create generated file' });
    vscodeMock._setWarningMessageSelection('Approve Execution');
    await first;
    vscodeMock._resetNotifications();
    await controller.run('third');
    expect(vscodeMock._lastWarningMessage()).not.toBe('KarkeDikha: Forge coding task is already running.');
  });
});

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
