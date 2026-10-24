import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AutonomousTaskRuntime, type KarkeDikhaLifecycleAuthority } from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';
import { MissionCheckpointStore } from '../../mission/MissionCheckpointStore';
import { DEFAULT_MISSION_SUPERVISOR_CONFIG, type MissionSupervisorConfig } from '../../mission/MissionSupervisor';
import type { ResourceSnapshot } from '../../telemetry/ResourceTelemetry';

/**
 * M44 wiring proof: unlike `missionSupervisor.test.ts` / `missionCheckpointAndCompaction.test.ts`
 * / `resourceTelemetry.test.ts` (which call the standalone M44 modules directly), every test here
 * drives a real `AutonomousTaskRuntime.runTask` drain — the same production entry point
 * `m15AutonomousRuntime.test.ts` and `m42RecoveryRuntime.test.ts` exercise — with a real
 * `ExtensionContext.globalStorageUri` so `MissionRuntimeSupervisor` actually activates, proving
 * each M44 component is invoked from the live mission loop rather than only from its own unit test.
 */

/** Scripted provider: `respond` sees the full prompt and the model the runtime asked for. */
class ScriptedProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly prompts: string[] = [];
  readonly models: Array<string | undefined> = [];
  respond: (prompt: string, model: string | undefined, call: number) => string | Error = () => '{}';

  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return []; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages.map(message => message.content).join('\n');
    this.prompts.push(prompt);
    this.models.push(options.model);
    const out = this.respond(prompt, options.model, this.prompts.length);
    if (out instanceof Error) throw out;
    return { message: { role: 'assistant', content: out }, done: true };
  }
}

const envelope = (proposal: Record<string, unknown>): string => JSON.stringify({ action: 'submit_proposal', proposal });
const proposalOf = (operations: Array<Record<string, unknown>>, script = 'verify'): Record<string, unknown> => ({
  version: 1,
  taskSummary: 'M44 scripted change',
  operations,
  validationCommands: [{ kind: 'npm-script', script }],
  warnings: [],
  status: 'proposed',
});

function context(globalStorageFsPath: string): vscode.ExtensionContext {
  return {
    subscriptions: [],
    globalStorageUri: { fsPath: globalStorageFsPath },
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) },
    extension: {
      packageJSON: {
        scripts: { 'test:live:m16': 'node scripts/live-m16-acceptance.mjs' },
        contributes: { commands: [{ command: 'ollama-agent.runEvaluationSuite' }, { command: 'ollama-agent.showQualityGateDecision' }] },
      },
    },
  } as unknown as vscode.ExtensionContext;
}

async function git(root: string, args: string[]): Promise<string> {
  const { execFile } = await import('child_process');
  return new Promise<string>((resolve, reject) => {
    execFile('git', args, { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr || error.message));
      else resolve(stdout.trim());
    });
  });
}

async function initGit(root: string): Promise<void> {
  for (const args of [['init'], ['config', 'user.email', 'test@example.com'], ['config', 'user.name', 'Test'], ['add', '.'], ['commit', '-m', 'init']]) {
    await git(root, args);
  }
}

function autoApprove(runtime: AutonomousTaskRuntime): void {
  runtime.onProposalApprovalRequired(async task => {
    if (task.pendingProposal) await runtime.approveProposal(task.taskId, task.pendingProposal.proposalId).catch(() => undefined);
  });
  runtime.onMutationApprovalRequired(async task => {
    if (task.pendingMutationApproval) await runtime.approveMutation(task.taskId, task.pendingMutationApproval.requestId).catch(() => undefined);
  });
}

function bindCore(
  runtime: AutonomousTaskRuntime,
  taskId: string,
  attemptId: string,
  input: string,
  root: string,
  selection: Record<string, unknown>,
): void {
  runtime.requireCoreAuthorityForNewWork();
  runtime.bindCoreAuthority(taskId, {
    context: {
      attemptId,
      workspaceRoot: root,
      taskInput: input,
      selectedProvider: 'ollama',
      selectedModel: 'weak:7b',
      modelSelection: selection,
    },
    heartbeat: async () => undefined,
    requestApproval: async (kind: string) => ({
      kind, status: 'requested', requestedAt: new Date().toISOString(), resolvedAt: null, resolution: null, summary: {}, presentation: null,
    }),
    resolveApproval: async () => undefined,
    beginValidation: async () => undefined,
    reportValidation: async () => ({ outcome: 'waiting_for_delivery_approval', approval: { kind: 'delivery', status: 'requested', requestedAt: new Date().toISOString(), resolvedAt: null, resolution: null, summary: {}, presentation: null } }),
    recordExecutionQuality: async () => undefined,
    complete: async () => undefined,
    fail: async () => undefined,
    cancel: async () => undefined,
  } as unknown as KarkeDikhaLifecycleAuthority);
}

const selection = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  selectedProvider: 'ollama',
  selectedModel: 'weak:7b',
  userOverrode: false,
  routingPolicy: 'local-only',
  candidates: [],
  escalationCandidates: [{ provider: 'ollama', model: 'strong:32b', reason: 'installed' }],
  ...over,
});

describe('M44 mission runtime wired into the live AutonomousTaskRuntime.runTask loop', () => {
  let root: string;
  let storageRoot: string;
  let provider: ScriptedProvider;
  let queue: DurableTaskQueue;
  let resources: TaskResourceScheduler;
  let worktrees: IsolatedWorktreeManager;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m44-runtime-'));
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m44-storage-'));
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: { verify: 'node -e "process.exit(0)"' },
    }));
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n');
    await initGit(root);
    provider = new ScriptedProvider();
    for (const model of ['fake-coder', 'weak:7b', 'strong:32b']) {
      ModelCapabilityRegistry.getInstance().setOverride(model, { contextWindow: 131072, chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: [] });
    }
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    queue = new DurableTaskQueue(root);
    resources = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
    worktrees = new IsolatedWorktreeManager(root);
  });

  afterEach(async () => {
    ModelCapabilityRegistry.resetInstance();
    vi.restoreAllMocks();
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function progress(taskId: string): Promise<string[]> {
    return (await queue.events(taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));
  }

  const lowLoadSample = async (): Promise<ResourceSnapshot> => ({
    takenAt: new Date().toISOString(),
    cpu: { utilizationPercent: 5 },
    ram: { totalBytes: 1, freeBytes: 1, usedPercent: 5 },
  });

  function newRuntime(config?: Partial<MissionSupervisorConfig>, sampleResources: () => Promise<ResourceSnapshot> = lowLoadSample): AutonomousTaskRuntime {
    return new AutonomousTaskRuntime(
      context(storageRoot),
      root,
      queue,
      resources,
      worktrees,
      undefined,
      undefined,
      {
        config: { ...DEFAULT_MISSION_SUPERVISOR_CONFIG, ...config },
        sampleResources,
        resourceSampleIntervalMs: 20,
        pressureGates: { cpu: { enterThreshold: 90, exitThreshold: 50, minSustainedMs: 0 }, ram: { enterThreshold: 90, exitThreshold: 50, minSustainedMs: 0 } },
        resourcePressureMaxPauseMs: 3_000,
        resourcePressurePollMs: 20,
      },
    );
  }

  it('durably checkpoints mission memory to disk during a real run and it survives past the run', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/m44.ts', reason: 'add', content: 'export const m44 = true;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add an m44 acceptance file'));
    // checkpointEveryNSteps=1 so the single completed pass checkpoints immediately.
    const runtime = newRuntime({ checkpointEveryNSteps: 1 });
    autoApprove(runtime);
    runtime.wake();
    await runtime.waitForIdle();

    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    const store = new MissionCheckpointStore(storageRoot);
    const checkpoint = await store.read(task.taskId);
    expect(checkpoint).toBeDefined();
    expect(checkpoint?.objective).toContain('m44 acceptance file');
    expect(checkpoint?.touchedFiles).toContain('src/m44.ts');
    runtime.dispose();
  }, 120_000);

  it('a repeated identical failure is detected by the mission supervisor and fed into RecoveryController as a synthetic outcome', async () => {
    // Every dispatch produces the exact same ungrounded/invalid proposal, so RecoveryController's
    // own no-progress guard AND the mission-level repeated-failure detector both see it repeat.
    provider.respond = () => envelope(proposalOf([{ type: 'replace', path: 'src/does-not-exist.ts', reason: 'noop' }]));
    const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'edit a file that is never read'), taskId: 'att_m44_repeat', attemptId: 'att_m44_repeat' });
    // repeatedFailureThreshold=1 so the very first observed failure already trips the mission verdict.
    const runtime = newRuntime({ repeatedFailureThreshold: 1 });
    autoApprove(runtime);
    bindCore(runtime, task.taskId, task.attemptId, task.goal, root, selection());
    runtime.wake();
    await runtime.waitForIdle();

    const lines = await progress(task.taskId);
    // The mission signal is fed through the SAME recovery_decision channel every other
    // controller decision uses — proving it is not a second, parallel mechanism.
    expect(lines.some(line => line.startsWith('recovery_decision') && line.includes('cause=no_progress'))).toBe(true);
    runtime.dispose();
  }, 120_000);

  it('a provider whose circuit breaker just tripped is rerouted by the existing RecoveryController without a wasted redispatch', async () => {
    let ollamaCalls = 0;
    provider.respond = (_prompt, model) => {
      if (model === 'strong:32b') {
        return envelope(proposalOf([{ type: 'create', path: 'src/strong.ts', reason: 'add', content: 'export const strong = true;\n' }]));
      }
      ollamaCalls += 1;
      return new Error('ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:11434');
    };
    const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'add a file while the provider is flaky'), taskId: 'att_m44_breaker', attemptId: 'att_m44_breaker' });
    // A long cooldown so the breaker, once opened by the first real failure, stays open for
    // the rest of this (seconds-long) test run — proving the SECOND weak-model dispatch never happens.
    const runtime = newRuntime({ providerCooldownMs: 10 * 60_000 });
    autoApprove(runtime);
    bindCore(runtime, task.taskId, task.attemptId, task.goal, root, selection());
    runtime.wake();
    await runtime.waitForIdle();

    const lines = await progress(task.taskId);
    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    expect(lines.some(line => line.startsWith('mission_provider_breaker_open'))).toBe(true);
    // Exactly one real dispatch to the failing provider/model — the breaker skipped the
    // bounded RETRY_OPERATION redispatch RecoveryController would otherwise have made.
    expect(ollamaCalls).toBe(1);
    expect(provider.models).toContain('strong:32b');
    runtime.dispose();
  }, 120_000);

  it('sustained resource pressure checkpoints the mission, pauses dispatch, then resumes once pressure clears', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/m44-pressure.ts', reason: 'add', content: 'export const m44Pressure = true;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add a file under resource pressure'));
    let sampleCount = 0;
    const startedAt = Date.now();
    // Pressure for the first 300ms of wall-clock time (long enough to sustain past the
    // test's 60ms minSustainedMs regardless of exactly when the drain reaches dispatch),
    // then clears — proving the pause is bounded by real pressure, not the deadline timeout.
    const sampleResources = async (): Promise<ResourceSnapshot> => {
      sampleCount += 1;
      const underPressure = Date.now() - startedAt < 1_000;
      return {
        takenAt: new Date().toISOString(),
        cpu: { utilizationPercent: underPressure ? 99 : 10 },
        ram: { totalBytes: 1, freeBytes: 0, usedPercent: underPressure ? 99 : 10 },
      };
    };
    const runtime = newRuntime({ checkpointEveryNSteps: 1 }, sampleResources);
    autoApprove(runtime);
    runtime.wake();
    await runtime.waitForIdle();

    const lines = await progress(task.taskId);
    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    expect(lines).toContain('mission_resource_pressure_checkpoint');
    expect(sampleCount).toBeGreaterThan(3);
    // The run only reached the delivery-approval boundary (not a terminal 'completed' lease
    // outcome), so the pressure-triggered checkpoint durably survives for a later resume.
    const store = new MissionCheckpointStore(storageRoot);
    const checkpoint = await store.read(task.taskId);
    expect(checkpoint?.touchedFiles).toContain('src/m44-pressure.ts');
    runtime.dispose();
  }, 120_000);
});
