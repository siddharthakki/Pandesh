import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import {
  AutonomousTaskRuntime,
  type KarkeDikhaLifecycleAuthority,
} from '../../activation/M15AutonomousRuntime';
import {
  DurableTaskQueue,
  IsolatedWorktreeManager,
  TaskResourceScheduler,
  TaskRuntimeCoordinator,
  createDefaultAutonomousTask,
} from '../../autonomous/M15AutonomousWork';
import { TaskBudgetLedger } from '../../autonomous/TaskControl';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { ModelCapabilityRegistry } from '../../models/ModelCapabilityRegistry';
import { InferenceProvider, ModelInfo, ProviderChatOptions } from '../../providers/ProviderTypes';
import { ChatMessage, ChatResponse, ToolDefinition } from '../../tools/ToolTypes';

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
  taskSummary: 'M42 scripted change',
  operations,
  validationCommands: [{ kind: 'npm-script', script }],
  warnings: [],
  status: 'proposed',
});

function context(): vscode.ExtensionContext {
  return {
    subscriptions: [],
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

/** A file bigger than the planner's 16k-char repository-context budget, so it is NEVER shown whole up front. */
const PRICING_ORIGINAL = `${Array.from({ length: 420 }, (_, i) => `// pricing note ${i}: keep behaviour stable`).join('\n')}\nexport function total(price: number, qty: number): number {\n  return Math.floor(price * qty);\n}\n`;
const PRICING_FIXED = PRICING_ORIGINAL.replace('Math.floor', 'Math.round');

describe('M42 autonomous recovery loop (real runtime, scripted local model)', () => {
  let root: string;
  let provider: ScriptedProvider;
  let queue: DurableTaskQueue;
  let resources: TaskResourceScheduler;
  let worktrees: IsolatedWorktreeManager;
  let cloudSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m42-runtime-'));
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
      scripts: {
        verify: 'node -e "process.exit(0)"',
        check: 'node -e "process.exit(require(\'fs\').readFileSync(\'src/flag.txt\',\'utf8\').trim()===\'ok\'?0:1)"',
      },
    }));
    await fs.writeFile(path.join(root, '.gitignore'), '.ollama-agent/\n');
    await fs.writeFile(path.join(root, 'src', 'pricing.ts'), PRICING_ORIGINAL);
    await fs.writeFile(path.join(root, 'src', 'flag.txt'), 'bad\n');
    await initGit(root);
    provider = new ScriptedProvider();
    // Whole-file replacement of the ~19 KB fixture needs it twice in context (read + rewrite).
    for (const model of ['fake-coder', 'weak:7b', 'strong:32b']) {
      ModelCapabilityRegistry.getInstance().setOverride(model, { contextWindow: 131072, chat: true, structuredOutput: true, embeddingOnly: false, allowedRoles: [] });
    }
    vscodeMock._resetConfig();
    vscodeMock._resetCommands();
    vscodeMock._resetWindowState();
    vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
    vscodeMock._setConfig('ollama-agent.codingModel', 'fake-coder');
    vscodeMock._setConfig('ollama-agent.contextWindow', 131072);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    cloudSpy = vi.spyOn(ProviderGateway, 'resolveCloudFallback');
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
  });

  async function progress(taskId: string): Promise<string[]> {
    return (await queue.events(taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));
  }
  const decisionsOf = (lines: string[]): string[] => lines.filter(line => line.startsWith('recovery_decision'));

  async function runToIdle(runtime: AutonomousTaskRuntime): Promise<void> {
    runtime.wake();
    await runtime.waitForIdle();
  }

  // ── scenario 7 ─────────────────────────────────────────────────────────────
  it('clean task: first-pass success, one model call, no recovery machinery engaged', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/clean.ts', reason: 'add', content: 'export const clean = true;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add a clean file'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    expect(provider.prompts).toHaveLength(1);
    // Nothing needed recovering: no recovery timeline event, one CONTINUE decision in the journal.
    expect(decisionsOf(await progress(task.taskId))).toEqual([]);
    const summary = await TaskBudgetLedger.readSummary(root, task.taskId);
    expect(summary?.totals.recovery_attempt).toBe(0);
    expect(summary?.totals.no_progress).toBe(0);
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    expect(journal.state.passes).toBe(1);
    // Two human gates (proposal, execution) were parked at; the controller only records the wait.
    expect(journal.state.decisions.map(decision => decision.action)).toEqual(['WAIT_APPROVAL', 'WAIT_APPROVAL', 'CONTINUE']);
    expect(journal.state.decisions.filter(decision => decision.action === 'WAIT_APPROVAL').every(decision => decision.terminalState === 'WAITING_FOR_APPROVAL')).toBe(true);
    expect(journal.state.terminal).toBeUndefined();
    expect(cloudSpy).not.toHaveBeenCalled();
    runtime.dispose();
  }, 60_000);

  // ── scenario 1 (+ the real incident class) ─────────────────────────────────
  it('incomplete proposal for an unread file -> grounding_failure -> REINVESTIGATE -> runtime reads it -> valid proposal, SAME task continues to delivery approval', async () => {
    provider.respond = prompt => {
      if (prompt.includes('Runtime recovery notes')) {
        // Only once the RUNTIME has supplied the file does the weak model produce a complete edit.
        expect(prompt).toContain('export function total(price: number, qty: number)');
        return envelope(proposalOf([{ type: 'replace', path: 'src/pricing.ts', reason: 'round instead of floor', content: PRICING_FIXED }]));
      }
      // The failure class that triggered M42: an edit to a file it never read, with no content.
      return envelope(proposalOf([{ type: 'replace', path: 'src/pricing.ts', reason: 'fix pricing rounding' }]));
    };
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'Fix the rounding bug in the pricing module'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('waiting_for_delivery_approval');
    // One durable task throughout: no manual new-task retry.
    expect((await queue.list()).map(item => item.taskId)).toEqual([task.taskId]);

    const lines = await progress(task.taskId);
    const decisions = decisionsOf(lines);
    expect(decisions[0]).toContain('action=REINVESTIGATE');
    expect(decisions[0]).toContain('cause=grounding_failure');
    expect(decisions[0]).toContain('subcode=operation_content_required');
    expect(decisions[0]).toContain('change=new_evidence');
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    expect(journal.state.decisions.map(decision => decision.action).filter(action => action !== 'WAIT_APPROVAL')).toEqual(['REINVESTIGATE', 'CONTINUE']);
    expect(journal.state.passes).toBe(2);
    const evidence = journal.state.evidence.get('src/pricing.ts') ?? [];
    expect(evidence.some(entry => entry.source === 'runtime_seed')).toBe(true);
    expect(journal.state.decisions[0]).toMatchObject({ action: 'REINVESTIGATE', cause: 'grounding_failure' });

    // Real mutation in the isolated worktree; the primary workspace is untouched.
    expect(await fs.readFile(path.join(persisted!.worktreeLocation!, 'src', 'pricing.ts'), 'utf8')).toContain('Math.round');
    expect(await fs.readFile(path.join(root, 'src', 'pricing.ts'), 'utf8')).toContain('Math.floor');

    // Bounded, accounted, and never cloud.
    const summary = await TaskBudgetLedger.readSummary(root, task.taskId);
    expect(summary?.recoveryByFailureClass['grounding_failure']).toBe(1);
    expect(summary?.attempts).toBe(1);
    expect(cloudSpy).not.toHaveBeenCalled();
    runtime.dispose();
  }, 120_000);

  // ── scenario 2 ─────────────────────────────────────────────────────────────
  it('mutation -> failing validation -> targeted recovery -> corrective mutation -> validation passes; the original mutation is applied exactly once', async () => {
    provider.respond = prompt => {
      if (prompt.includes('Investigation turn')) {
        return envelope(proposalOf([{ type: 'replace', path: 'src/flag.txt', reason: 'set flag', content: 'still bad\n' }], 'check'));
      }
      // Validation-repair turn (bare CodingProposal from the validator stage).
      return JSON.stringify(proposalOf([{ type: 'replace', path: 'src/flag.txt', reason: 'repair', content: 'ok\n' }], 'check'));
    };
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'Update src/flag.txt so the check passes'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('waiting_for_delivery_approval');
    const decisions = decisionsOf(await progress(task.taskId));
    expect(decisions[0]).toContain('action=VALIDATION_REPAIR');
    expect(decisions[0]).toContain('cause=validation_failure');
    expect(decisions[0]).toContain('subcode=code_defect');
    expect(await fs.readFile(path.join(persisted!.worktreeLocation!, 'src', 'flag.txt'), 'utf8')).toBe('ok\n');

    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    const records = await journal.readAll();
    const started = records.filter(record => record.t === 'mutation' && record.phase === 'started');
    // The approved proposal once, plus exactly one corrective (repair) mutation.
    expect(started).toHaveLength(2);
    const fingerprints = new Set(started.map(record => (record as { proposalFingerprint: string }).proposalFingerprint));
    expect(fingerprints.size).toBe(2);
    const validations = records.filter(record => record.t === 'validation');
    expect(validations.some(record => (record as { passed: boolean }).passed === false)).toBe(true);
    expect((validations[validations.length - 1] as { passed: boolean }).passed).toBe(true);
    expect(cloudSpy).not.toHaveBeenCalled();
    runtime.dispose();
  }, 120_000);

  // ── scenario 4 ─────────────────────────────────────────────────────────────
  it('restart during validation: the mutation is NOT re-applied, no new model call is made, and validation is reconciled by re-running it', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/once.ts', reason: 'add', content: 'export const once = 1;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add the once file'));
    const first = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(first);
    await runToIdle(first);
    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    first.dispose();
    const promptsBefore = provider.prompts.length;
    expect(promptsBefore).toBe(1);

    // Simulate the process dying in the middle of validation: the journal says the mutation
    // landed and validation had begun but never finished; the task is in an "uncertain" state.
    const crashed = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    await crashed.append({ t: 'validation_phase', phase: 'started', attemptId: task.attemptId });
    const current = (await queue.get(task.taskId))!;
    const worktree = current.worktreeLocation!;
    await queue.update({ ...current, state: 'validating' }, 'test_simulated_crash', {});
    const queue2 = new DurableTaskQueue(root);
    const recovered = await queue2.recoverOnActivation('restarted-host');
    expect(recovered).toEqual([{ taskId: task.taskId, action: 'blocked' }]);
    expect((await queue2.get(task.taskId))?.state).toBe('blocked');
    // Explicit resume of the interrupted task (same task id).
    await queue2.transition(task.taskId, 'queued');

    const second = new AutonomousTaskRuntime(context(), root, queue2, new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } }), new IsolatedWorktreeManager(root));
    autoApprove(second);
    second.wake();
    await second.waitForIdle();

    const finished = await queue2.get(task.taskId);
    expect(finished?.state).toBe('waiting_for_delivery_approval');
    expect(provider.prompts).toHaveLength(promptsBefore); // no model call
    const lines = (await queue2.events(task.taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));
    expect(lines).toContain('recovery_resume_validation mutation_already_applied=true');
    expect(lines).toContain('validation_resumed_without_reapplying_mutation');
    expect(lines.filter(line => line === 'mutating')).toHaveLength(1); // only the original mutation
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    const records = await journal.readAll();
    expect(records.filter(record => record.t === 'mutation' && record.phase === 'started')).toHaveLength(1);
    expect(records.filter(record => record.t === 'validation_phase' && record.phase === 'completed').length).toBeGreaterThanOrEqual(2);
    expect(await fs.readFile(path.join(worktree, 'src', 'once.ts'), 'utf8')).toBe('export const once = 1;\n');
    second.dispose();
  }, 120_000);

  it('restart with an unrecognisable on-disk mutation state fails closed and never re-applies or delivers', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'replace', path: 'src/flag.txt', reason: 'set', content: 'good\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'update src/flag.txt'));
    const first = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(first);
    await runToIdle(first);
    first.dispose();
    const current = (await queue.get(task.taskId))!;
    expect(current.state).toBe('waiting_for_delivery_approval');
    // Something else rewrote the file after the mutation: neither the pre nor the post state.
    await fs.writeFile(path.join(current.worktreeLocation!, 'src', 'flag.txt'), 'edited by somebody else\n');
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    await journal.append({ t: 'validation_phase', phase: 'started', attemptId: task.attemptId });
    await queue.update({ ...current, state: 'validating' }, 'test_simulated_crash', {});
    const queue2 = new DurableTaskQueue(root);
    await queue2.recoverOnActivation('restarted-host');
    await queue2.transition(task.taskId, 'queued');
    const promptsBefore = provider.prompts.length;

    const second = new AutonomousTaskRuntime(context(), root, queue2, new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } }), new IsolatedWorktreeManager(root));
    autoApprove(second);
    second.wake();
    await second.waitForIdle();

    const blocked = await queue2.get(task.taskId);
    expect(blocked?.state).toBe('blocked');
    expect(blocked?.failure?.message).toContain('mutation_state_uncertain');
    expect(blocked?.failure?.recovery?.terminalState).toBe('BLOCKED_RESUMABLE');
    expect(provider.prompts).toHaveLength(promptsBefore);
    expect(await fs.readFile(path.join(current.worktreeLocation!, 'src', 'flag.txt'), 'utf8')).toBe('edited by somebody else\n');
    second.dispose();
  }, 120_000);

  // ── scenario 3 ─────────────────────────────────────────────────────────────
  it('restart while waiting for approval: the identical gate is restored, no second model call, and the recorded contract still authorises it', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/gated.ts', reason: 'add', content: 'export const gated = 1;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add the gated file'));
    const first = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    first.wake();
    await vi.waitFor(async () => expect((await queue.get(task.taskId))?.state).toBe('waiting_for_proposal_approval'), { timeout: 30_000, interval: 100 });
    const gate = (await queue.get(task.taskId))!.pendingProposal!;
    first.dispose();
    expect(provider.prompts).toHaveLength(1);

    const queue2 = new DurableTaskQueue(root);
    const resources2 = new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } });
    const worktrees2 = new IsolatedWorktreeManager(root);
    const second = new AutonomousTaskRuntime(context(), root, queue2, resources2, worktrees2);
    autoApprove(second);
    await second.start(new TaskRuntimeCoordinator(queue2, resources2, worktrees2));
    const restored = (await queue2.get(task.taskId))!;
    expect(restored.state).toBe('waiting_for_proposal_approval');
    expect(restored.pendingProposal).toEqual(gate); // identical gate

    await second.approveProposal(task.taskId, gate.proposalId);
    await second.waitForIdle();
    await vi.waitFor(async () => expect((await queue2.get(task.taskId))?.state).toBe('waiting_for_delivery_approval'), { timeout: 30_000, interval: 200 });
    expect(provider.prompts).toHaveLength(1); // no duplicate model call across the restart
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    expect(journal.state.contracts.some(contract => contract.gate === 'proposal')).toBe(true);
    const lines = (await queue2.events(task.taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));
    expect(lines.filter(line => line === 'mutating')).toHaveLength(1);
    expect(lines.some(line => line.startsWith('recovery_stale_approval_rejected'))).toBe(false);
    second.dispose();
  }, 120_000);

  it('a stale approval cannot authorise a changed contract: a restored checkpoint whose contract moved is refused', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/stale.ts', reason: 'add', content: 'export const stale = 1;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add the stale file'));
    const first = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    first.wake();
    await vi.waitFor(async () => expect((await queue.get(task.taskId))?.state).toBe('waiting_for_proposal_approval'), { timeout: 30_000, interval: 100 });
    first.dispose();
    const promptsBefore = provider.prompts.length;

    // The approval was granted (task requeued with its exact checkpoint) ...
    const parked = (await queue.get(task.taskId))!;
    expect(parked.proposalRestartCheckpoint).toBeTruthy();
    // ... but the contract moved (steering bumped the instruction revision) before a worker resumed it.
    await queue.update({
      ...parked,
      state: 'queued',
      pendingProposal: undefined,
      claim: undefined,
      instructionRevision: (parked.instructionRevision ?? 0) + 1,
    }, 'test_contract_moved_after_approval', {});

    const queue2 = new DurableTaskQueue(root);
    const second = new AutonomousTaskRuntime(context(), root, queue2, new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } }), new IsolatedWorktreeManager(root));
    autoApprove(second);
    second.wake();
    await second.waitForIdle();

    const lines = (await queue2.events(task.taskId)).filter(event => event.type === 'progress').map(event => String(event.payload.progress));
    expect(lines).toContain('recovery_stale_approval_rejected reason=contract_digest_mismatch');
    // The stale approval did NOT resume from the old checkpoint: a fresh governed proposal was generated.
    expect(lines).not.toContain('proposal_restored_after_approval');
    expect(provider.prompts.length).toBeGreaterThan(promptsBefore);
    second.dispose();
  }, 120_000);

  // ── delivery: COMPLETE with evidence, exactly once, accounted ─────────────────────────
  it('delivery is journaled exactly once (COMPLETE with evidence) and its validation is charged to the durable ledger', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/delivered.ts', reason: 'add', content: 'export const delivered = 1;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add the delivered file'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);
    expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
    const before = await TaskBudgetLedger.readSummary(root, task.taskId);

    await runtime.approveDelivery(task.taskId);

    const completed = await queue.get(task.taskId);
    expect(completed?.state).toBe('completed');
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    const records = await journal.readAll();
    const delivery = records.filter(record => record.t === 'delivery').map(record => (record as { phase: string }).phase);
    expect(delivery).toEqual(['started', 'completed']);
    expect(journal.state.terminal).toMatchObject({ terminalState: 'COMPLETE' });
    expect(journal.state.decisions[journal.state.decisions.length - 1]).toMatchObject({ action: 'COMPLETE', terminalState: 'COMPLETE' });
    expect(records.filter(record => record.t === 'patch')).toHaveLength(1);
    expect(journal.state.terminal?.reason).toContain(completed!.githubDelivery.commitSha!.slice(0, 12));

    // Delivery-time validation (outside the governed executor) is now in the same ledger.
    const after = await TaskBudgetLedger.readSummary(root, task.taskId);
    expect(after!.totals.tool_call).toBeGreaterThan(before!.totals.tool_call);
    expect(after!.byStage['delivery_validation']?.tool_call).toBeGreaterThanOrEqual(1);
    // Human approval time is not charged as active execution.
    expect(after!.totals.waiting_for_approval_ms).toBeGreaterThanOrEqual(before!.totals.waiting_for_approval_ms);

    // Exactly once: a second approval cannot deliver again.
    await expect(runtime.approveDelivery(task.taskId)).rejects.toThrow('Task is not waiting for delivery approval.');
    expect((await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId })).state.delivery?.phase).toBe('completed');
    runtime.dispose();
  }, 120_000);

  it('a delivery that started but was never confirmed is never re-delivered automatically after a restart', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/undelivered.ts', reason: 'add', content: 'export const undelivered = 1;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add the undelivered file'));
    const first = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(first);
    await runToIdle(first);
    first.dispose();
    const current = (await queue.get(task.taskId))!;
    expect(current.state).toBe('waiting_for_delivery_approval');
    // The process died between "delivery started" and its confirmation.
    const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
    await journal.append({ t: 'delivery', phase: 'started', attemptId: task.attemptId });
    await queue.update({ ...current, state: 'committing' }, 'test_simulated_crash', {});
    const queue2 = new DurableTaskQueue(root);
    await queue2.recoverOnActivation('restarted-host');
    await queue2.transition(task.taskId, 'queued');
    const promptsBefore = provider.prompts.length;

    const second = new AutonomousTaskRuntime(context(), root, queue2, new TaskResourceScheduler({ maxActiveTasks: 2, maxActiveMutatingTasks: 1, modelConcurrency: { '*': 2 } }), new IsolatedWorktreeManager(root));
    autoApprove(second);
    second.wake();
    await second.waitForIdle();

    const blocked = await queue2.get(task.taskId);
    expect(blocked?.state).toBe('blocked');
    expect(blocked?.failure?.message).toContain('delivery_state_uncertain');
    expect(blocked?.failure?.recovery?.terminalState).toBe('BLOCKED_RESUMABLE');
    expect(provider.prompts).toHaveLength(promptsBefore);
    expect(await git(root, ['log', '--oneline', '--', 'src/undelivered.ts'])).toBe('');
    second.dispose();
  }, 120_000);

  // ── scenario 5 ─────────────────────────────────────────────────────────────
  it('local provider unavailable: bounded retry, then a truthful NO_CAPABLE_MODEL block with zero cloud calls', async () => {
    provider.respond = () => new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add a file while the provider is down'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('blocked');
    expect(persisted?.failure?.recovery?.terminalState).toBe('NO_CAPABLE_MODEL');
    const decisions = decisionsOf(await progress(task.taskId));
    expect(decisions[0]).toContain('action=RETRY_OPERATION');
    expect(decisions[0]).toContain('cause=provider_failure');
    expect(decisions[decisions.length - 1]).toContain('terminal=NO_CAPABLE_MODEL');
    expect(cloudSpy).not.toHaveBeenCalled();
    // Bounded: the unavailable provider was never hammered indefinitely.
    expect(provider.prompts.length).toBeLessThanOrEqual(12);
    runtime.dispose();
  }, 120_000);

  it('cloud is default deny even when a weak local model keeps failing: no cloud route is ever resolved', async () => {
    provider.respond = () => 'this is not json at all';
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add a file with a model that cannot follow the format'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('blocked'); // never fabricated success
    expect(persisted?.terminalResult?.status).not.toBe('completed');
    expect(cloudSpy).not.toHaveBeenCalled();
    const decisions = decisionsOf(await progress(task.taskId));
    expect(decisions.length).toBeGreaterThanOrEqual(1);
    expect(decisions[decisions.length - 1]).toMatch(/terminal=(NO_CAPABLE_MODEL|NO_PROGRESS|BLOCKED_RESUMABLE|BUDGET_EXHAUSTED)/);
    runtime.dispose();
  }, 120_000);

  // ── scenario 6 ─────────────────────────────────────────────────────────────
  it('repeated equivalent proposal and failure is detected as NO_PROGRESS: a bounded, resumable BLOCK (not failed, not completed)', async () => {
    await fs.writeFile(path.join(root, 'src', 'exists.ts'), 'export const exists = true;\n');
    await git(root, ['add', '.']);
    await git(root, ['commit', '-m', 'exists']);
    // The model insists on creating a file that already exists, identically, every time.
    provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/exists.ts', reason: 'again', content: 'export const exists = false;\n' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'add src/exists.ts'));
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('blocked');
    expect(persisted?.state).not.toBe('failed');
    expect(persisted?.failure?.recovery?.terminalState).toBe('NO_PROGRESS');
    const summary = await TaskBudgetLedger.readSummary(root, task.taskId);
    expect(summary?.totals.no_progress).toBeGreaterThanOrEqual(1);
    const promptsAfterFirstRun = provider.prompts.length;
    expect(promptsAfterFirstRun).toBeLessThanOrEqual(24);

    // Resumable: a human resume opens a fresh, still-bounded window on the SAME task.
    await queue.transition(task.taskId, 'queued');
    await runToIdle(runtime);
    const again = await queue.get(task.taskId);
    expect(again?.state).toBe('blocked');
    expect(provider.prompts.length).toBeGreaterThan(promptsAfterFirstRun);
    expect((await queue.list()).map(item => item.taskId)).toEqual([task.taskId]);
    runtime.dispose();
  }, 180_000);

  // ── scenario 8 ─────────────────────────────────────────────────────────────
  it('budget exhaustion: a deterministic BUDGET_EXHAUSTED stop naming the exhausted resource', async () => {
    provider.respond = () => envelope(proposalOf([{ type: 'replace', path: 'src/pricing.ts', reason: 'fix' }]));
    const task = await queue.enqueue(createDefaultAutonomousTask(root, 'Fix the rounding bug in the pricing module'));
    // The durable ledger's limits are frozen at creation; make the model-call budget tiny.
    await TaskBudgetLedger.open({
      repositoryRoot: root,
      taskId: task.taskId,
      contract: { taskSchemaVersion: 1, instructionRevision: 0 },
      limits: { modelCalls: 2 },
    });
    const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
    autoApprove(runtime);
    await runToIdle(runtime);

    const persisted = await queue.get(task.taskId);
    expect(persisted?.state).toBe('blocked');
    expect(persisted?.failure?.recovery?.terminalState).toBe('BUDGET_EXHAUSTED');
    expect(persisted?.failure?.message).toContain('model_call');
    const decisions = decisionsOf(await progress(task.taskId));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toContain('terminal=BUDGET_EXHAUSTED');
    runtime.dispose();
  }, 120_000);

  // ── validation-repair durability (packaged v0.1.1 acceptance incident) ───────
  describe('validation repair survives controller re-entry (Core-bound task)', () => {
    /** Core's real rule (core/domain/executionQuality.ts): repair cycle must be exactly count + 1, never above 2. */
    function coreLikeQuality(cycles: number[]): (evidence: { eventType: string; metadata: Record<string, unknown> }) => Promise<void> {
      return async evidence => {
        if (evidence.eventType !== 'validation_repair_started') return;
        const cycle = Number(evidence.metadata['cycle']);
        if (cycles.length >= 2 || cycle !== cycles.length + 1) {
          throw new Error(`validation repair cycle must be ${cycles.length + 1} and may not exceed 2`);
        }
        cycles.push(cycle);
      };
    }
    function bind(runtime: AutonomousTaskRuntime, taskId: string, attemptId: string, input: string, cycles: number[]): void {
      const approval = (kind: string) => ({
        id: `${kind}-approval`, attemptId, kind, status: 'requested', requestedAt: new Date().toISOString(),
        resolvedAt: null, resolution: null, summary: {}, presentation: null,
      });
      runtime.requireCoreAuthorityForNewWork();
      runtime.bindCoreAuthority(taskId, {
        context: {
          attemptId, workspaceRoot: root, taskInput: input, selectedProvider: 'ollama', selectedModel: 'weak:7b',
          modelSelection: { selectedProvider: 'ollama', selectedModel: 'weak:7b', userOverrode: false, routingPolicy: 'local-only', candidates: [], escalationCandidates: [] },
        },
        heartbeat: async () => undefined,
        requestApproval: async (kind: string) => approval(kind),
        resolveApproval: async () => undefined,
        beginValidation: async () => undefined,
        reportValidation: async () => ({ outcome: 'waiting_for_delivery_approval', approval: approval('delivery') }),
        recordExecutionQuality: coreLikeQuality(cycles),
        complete: async () => undefined,
        fail: async () => undefined,
        cancel: async () => undefined,
      } as unknown as KarkeDikhaLifecycleAuthority);
    }
    const isRepairTurn = (prompt: string): boolean => prompt.includes('Stage: validator (bounded proposal repair)');
    const initialProposal = (): string => envelope(proposalOf([{ type: 'replace', path: 'src/flag.txt', reason: 'set flag', content: 'still bad\n' }], 'check'));

    it('structurally unusable first repair -> FORMAT_REPAIR -> corrected repair is cycle 2 on the SAME task -> corrective mutation -> validation passes; never mutation_failed', async () => {
      const cycles: number[] = [];
      let repairTurns = 0;
      provider.respond = prompt => {
        if (isRepairTurn(prompt)) {
          repairTurns += 1;
          if (repairTurns === 1) return 'I would fix it by rewriting the flag file.'; // no valid CodingProposal envelope
          expect(prompt).toContain('Runtime recovery notes'); // stricter format guidance reached the regenerated repair
          return JSON.stringify(proposalOf([{ type: 'replace', path: 'src/flag.txt', reason: 'repair', content: 'ok\n' }], 'check'));
        }
        return initialProposal();
      };
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'Update src/flag.txt so the check passes'), taskId: 'att_core_fmt', attemptId: 'att_core_fmt' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bind(runtime, task.taskId, task.attemptId, task.goal, cycles);
      await runToIdle(runtime);

      const persisted = await queue.get(task.taskId);
      expect(persisted?.state).toBe('waiting_for_delivery_approval');
      expect(persisted?.failure).toBeUndefined();
      expect((await queue.list()).map(item => item.taskId)).toEqual([task.taskId]);
      expect(await fs.readFile(path.join(persisted!.worktreeLocation!, 'src', 'flag.txt'), 'utf8')).toBe('ok\n');

      const lines = await progress(task.taskId);
      const decisions = decisionsOf(lines);
      expect(decisions[0]).toContain('action=FORMAT_REPAIR');
      expect(decisions[0]).toContain('subcode=validation_repair_unavailable');
      expect(lines.some(line => line.includes('subcode=mutation_failed'))).toBe(false);
      expect(lines).toContain('validation_repair_started cycle=1/2');
      expect(lines).toContain('validation_repair_started cycle=2/2');
      // Core saw an in-sequence count: cycle 1 then cycle 2, never cycle 1 twice.
      expect(cycles).toEqual([1, 2]);
      expect(repairTurns).toBe(2);

      const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
      expect(journal.state.validationRepairCycles).toBe(2);
      const records = await journal.readAll();
      // The approved mutation applied exactly once, plus exactly one corrective mutation.
      expect(records.filter(record => record.t === 'mutation' && record.phase === 'started')).toHaveLength(2);
      runtime.dispose();
    }, 180_000);

    it('repair stays unavailable through allowed recovery -> BLOCKED_RESUMABLE with the validation repair reason; never mutation_failed; no duplicate original mutation; cycle budget never resets', async () => {
      const cycles: number[] = [];
      let repairTurns = 0;
      provider.respond = prompt => {
        if (isRepairTurn(prompt)) {
          repairTurns += 1;
          return 'I would fix it by rewriting the flag file.';
        }
        return initialProposal();
      };
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'Update src/flag.txt so the check passes'), taskId: 'att_core_blocked', attemptId: 'att_core_blocked' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bind(runtime, task.taskId, task.attemptId, task.goal, cycles);
      await runToIdle(runtime);

      const persisted = await queue.get(task.taskId);
      expect(persisted?.state).toBe('blocked');
      expect(persisted?.failure?.classification).toBe('validation_failed');
      expect(persisted?.failure?.recovery?.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(persisted?.failure?.recovery?.subcode).toBe('validation_repair_unavailable');
      expect(persisted?.failure?.message).toContain('Validation repair cycles exhausted (2 of 2)');
      expect(persisted?.failure?.message).toContain('isolated worktree');
      const lines = await progress(task.taskId);
      expect(lines.some(line => line.includes('subcode=mutation_failed') || line.includes('cause=environment_failure'))).toBe(false);
      // The approved change is still only in the isolated worktree; the primary workspace is untouched.
      expect(await fs.readFile(path.join(persisted!.worktreeLocation!, 'src', 'flag.txt'), 'utf8')).toBe('still bad\n');
      expect(await fs.readFile(path.join(root, 'src', 'flag.txt'), 'utf8')).toBe('bad\n');

      // Bounded across controller re-entry: exactly cycles 1 and 2 were ever consumed, and exactly two repair turns ran.
      expect(cycles).toEqual([1, 2]);
      expect(repairTurns).toBe(2);
      const journal = await AttemptJournal.open({ repositoryRoot: root, taskId: task.taskId });
      expect(journal.state.validationRepairCycles).toBe(2);
      const records = await journal.readAll();
      // No duplicate original mutation, no corrective mutation.
      expect(records.filter(record => record.t === 'mutation' && record.phase === 'started')).toHaveLength(1);
      expect(records.filter(record => record.t === 'repair_cycle').map(record => (record as { cycle: number }).cycle)).toEqual([1, 2]);
      expect(journal.state.terminal?.terminalState).toBe('BLOCKED_RESUMABLE');
      runtime.dispose();
    }, 180_000);
  });

  // ── scenario 10 ────────────────────────────────────────────────────────────
  describe('model capability behavior through the controller (Core-frozen selection)', () => {
    function bindCore(runtime: AutonomousTaskRuntime, taskId: string, attemptId: string, input: string, selection: Record<string, unknown>): void {
      const approval = (kind: string) => ({
        id: `${kind}-approval`,
        attemptId,
        kind,
        status: 'requested',
        requestedAt: new Date().toISOString(),
        resolvedAt: null,
        resolution: null,
        summary: {},
        presentation: null,
      });
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
        requestApproval: async (kind: string) => approval(kind),
        resolveApproval: async () => undefined,
        beginValidation: async () => undefined,
        reportValidation: async () => ({ outcome: 'waiting_for_delivery_approval', approval: approval('delivery') }),
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

    it('a weak model that cannot follow the format degrades safely, then a stronger permitted LOCAL model completes the task; cloud is never touched', async () => {
      provider.respond = (_prompt, model) => model === 'strong:32b'
        ? envelope(proposalOf([{ type: 'create', path: 'src/strong.ts', reason: 'add', content: 'export const strong = true;\n' }]))
        : 'sorry, I cannot produce JSON';
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'add a file with a weak model first'), taskId: 'att_core_weak', attemptId: 'att_core_weak' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bindCore(runtime, task.taskId, task.attemptId, task.goal, selection());
      await runToIdle(runtime);

      const persisted = await queue.get(task.taskId);
      expect(persisted?.state).toBe('waiting_for_delivery_approval');
      const decisions = decisionsOf(await progress(task.taskId));
      expect(decisions.some(line => line.includes('action=FORMAT_REPAIR'))).toBe(true);
      const change = decisions.find(line => line.includes('action=CHANGE_MODEL'));
      expect(change).toContain('model=ollama/strong:32b');
      expect(change).toContain('change=changed_model');
      expect(provider.models).toContain('strong:32b');
      expect(provider.models.filter(model => model === 'weak:7b').length).toBeGreaterThan(0);
      expect(cloudSpy).not.toHaveBeenCalled();
      runtime.dispose();
    }, 180_000);

    it('a pinned model with fallback disabled is respected: no model change, truthful resumable block', async () => {
      provider.respond = () => 'sorry, I cannot produce JSON';
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'add a file but the model is pinned'), taskId: 'att_core_pinned', attemptId: 'att_core_pinned' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bindCore(runtime, task.taskId, task.attemptId, task.goal, selection({ userOverrode: true }));
      await runToIdle(runtime);

      const persisted = await queue.get(task.taskId);
      expect(persisted?.state).toBe('blocked');
      expect(persisted?.failure?.recovery?.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(provider.models.every(model => model === 'weak:7b')).toBe(true);
      expect(cloudSpy).not.toHaveBeenCalled();
      runtime.dispose();
    }, 180_000);

    it('missing grounding is never solved by escalating the model even when a stronger local model is installed', async () => {
      provider.respond = (prompt, model) => {
        if (prompt.includes('Runtime recovery notes')) {
          return envelope(proposalOf([{ type: 'replace', path: 'src/pricing.ts', reason: 'fix', content: PRICING_FIXED }]));
        }
        return envelope(proposalOf([{ type: 'replace', path: 'src/pricing.ts', reason: `fix by ${model}` }]));
      };
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'Fix the rounding bug in the pricing module'), taskId: 'att_core_ground', attemptId: 'att_core_ground' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bindCore(runtime, task.taskId, task.attemptId, task.goal, selection());
      await runToIdle(runtime);

      expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
      expect(provider.models.every(model => model === 'weak:7b')).toBe(true);
      const decisions = decisionsOf(await progress(task.taskId));
      expect(decisions[0]).toContain('action=REINVESTIGATE');
      expect(decisions.some(line => line.includes('action=CHANGE_MODEL'))).toBe(false);
      runtime.dispose();
    }, 180_000);

    // M50: a frozen routing decision is reused exactly on resume; only structural availability is re-checked.
    it('a frozen model that is no longer installed stops with a precise diagnostic and is never replaced by a better installed one', async () => {
      provider.listModels = async () => [{ name: 'strong:32b' }, { name: 'fake-coder' }];
      provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/never.ts', reason: 'add', content: 'export const never = true;\n' }]));
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'add a file'), taskId: 'att_core_missing', attemptId: 'att_core_missing' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bindCore(runtime, task.taskId, task.attemptId, task.goal, selection());
      await runToIdle(runtime);

      const persisted = await queue.get(task.taskId);
      expect(persisted?.state).toBe('blocked');
      expect(persisted?.failure?.recovery?.terminalState).toBe('BLOCKED_RESUMABLE');
      expect(provider.prompts).toHaveLength(0);
      expect(provider.models).toEqual([]);
      const failure = JSON.stringify(persisted?.failure ?? {}) + (await progress(task.taskId)).join('\n');
      expect(failure).toContain('frozen_model_unavailable');
      expect(failure).toContain('weak:7b');
      expect(cloudSpy).not.toHaveBeenCalled();
      runtime.dispose();
    }, 180_000);

    it('a frozen model that is still installed is dispatched exactly, even though better models are installed', async () => {
      provider.listModels = async () => [{ name: 'strong:32b' }, { name: 'weak:7b' }];
      provider.respond = () => envelope(proposalOf([{ type: 'create', path: 'src/ok.ts', reason: 'add', content: 'export const ok = true;\n' }]));
      const task = await queue.enqueue({ ...createDefaultAutonomousTask(root, 'add a file'), taskId: 'att_core_present', attemptId: 'att_core_present' });
      const runtime = new AutonomousTaskRuntime(context(), root, queue, resources, worktrees);
      autoApprove(runtime);
      bindCore(runtime, task.taskId, task.attemptId, task.goal, selection());
      await runToIdle(runtime);

      expect((await queue.get(task.taskId))?.state).toBe('waiting_for_delivery_approval');
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.models.every(model => model === 'weak:7b')).toBe(true);
      runtime.dispose();
    }, 180_000);
  });
});
