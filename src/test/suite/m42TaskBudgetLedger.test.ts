import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import {
  TaskAccountingSession,
  TaskBudgetLedger,
  type ReserveRequest,
} from '../../autonomous/TaskControl';
import { taskDir } from '../../autonomous/M15AutonomousWork';
import type { GovernedModelRequest, GovernedModelResult } from '../../agent/GovernedModelExecutionTypes';
import type { GovernedModelDispatchSeam } from '../../agent/LocalFirstModelDispatchRouter';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

const CONTRACT = { taskSchemaVersion: 1, instructionRevision: 0 };

function request(requestId: string, model = 'model-a'): GovernedModelRequest {
  return { requestId, invocationId: 'inv', taskId: 't', model, providerType: 'ollama', prompt: 'p' } as unknown as GovernedModelRequest;
}

function fakeDispatcher(behavior: (req: GovernedModelRequest) => Partial<GovernedModelResult> | Error = () => ({})): GovernedModelDispatchSeam & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    dispatch: async req => {
      calls.push(req.requestId);
      const outcome = behavior(req);
      if (outcome instanceof Error) throw outcome;
      return { requestId: req.requestId, model: req.model, providerType: req.providerType, status: 'completed', completion: 'ok', ...outcome } as unknown as GovernedModelResult;
    },
  };
}

describe('M42 slice 1 — TaskBudgetLedger (observe-only)', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m42-ledger-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const open = (taskId = 'task_a', extra: Partial<Parameters<typeof TaskBudgetLedger.open>[0]> = {}) =>
    TaskBudgetLedger.open({ repositoryRoot: root, taskId, contract: CONTRACT, ...extra });

  it('model calls increment the task ledger, attributed to stage, model and provider that actually ran', async () => {
    const ledger = await open();
    await ledger.beginAttempt('att_1');
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const dispatcher = session.observeDispatcher(fakeDispatcher(req => ({ model: `ran-${req.model}`, providerType: 'openai-compatible' })), 'primary');

    await session.withStage('investigation', async () => {
      await dispatcher.dispatch(request('r1'));
      await dispatcher.dispatch(request('r2'));
    });
    const summary = await session.finish();

    expect(summary.totals.model_call).toBe(2);
    expect(summary.byStage['investigation']?.model_call).toBe(2);
    const lines = (await fs.readFile(path.join(taskDir(root, 'task_a'), 'budget-ledger.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
    const commit = lines.find(l => l.phase === 'commit' && l.resource === 'model_call');
    expect(commit).toMatchObject({ taskId: 'task_a', attemptId: 'att_1', stage: 'investigation', model: 'ran-model-a', provider: 'openai-compatible', amount: 1 });
    expect(typeof commit.timestamp).toBe('string');
  });

  it('counts stage-local retries, including repeated dispatches that reuse the same requestId', async () => {
    const ledger = await open();
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const dispatcher = session.observeDispatcher(fakeDispatcher(), 'primary');
    // The executor's contract-repair and conflict-repair both dispatch `...:validator-repair`.
    await session.withStage('proposal_contract_repair', () => dispatcher.dispatch(request('fixed-multi-agent:inv:validator-repair')));
    await session.withStage('proposal_conflict_repair', () => dispatcher.dispatch(request('fixed-multi-agent:inv:validator-repair')));
    await dispatcher.dispatch(request('investigation:inv:1'));
    await dispatcher.dispatch(request('investigation:inv:1:compact'));
    await dispatcher.dispatch(request('investigation:inv:1:retry'));
    await dispatcher.dispatch(request('investigation:inv:1:repair'));
    const summary = await session.finish();

    expect(summary.totals.model_call).toBe(6);
    expect(summary.byStage['proposal_contract_repair']?.model_call).toBe(1);
    expect(summary.byStage['proposal_conflict_repair']?.model_call).toBe(1);
    expect(summary.byStage['investigation']?.model_call).toBe(3);
    expect(summary.byStage['proposal_repair']?.model_call).toBe(1);
  });

  it('a throwing dispatch is still charged and the error still reaches the caller', async () => {
    const ledger = await open();
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const dispatcher = session.observeDispatcher(fakeDispatcher(() => new Error('provider down')), 'primary');
    await expect(dispatcher.dispatch(request('r1'))).rejects.toThrow('provider down');
    expect((await session.finish()).totals.model_call).toBe(1);
  });

  it('reload preserves committed totals, start, deadline and frozen limits; a restart grants no free budget', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const now = () => new Date(clock);
    const first = await open('task_a', { limits: { modelCalls: 5, wallClockMs: 60_000 }, now });
    await first.beginAttempt('att_1');
    for (let i = 0; i < 3; i++) await first.record({ idempotencyKey: `k${i}`, stage: 's', resource: 'model_call' });
    await first.record({ idempotencyKey: 'rc', stage: 's', resource: 'recovery_attempt', failureClass: 'conflict' });
    // An in-flight reservation the process never settled (crash mid-call).
    await first.reserve({ idempotencyKey: 'orphan', stage: 's', resource: 'model_call' });
    const startedAt = first.state.startedAt;
    const deadlineAt = first.state.deadlineAt;

    clock += 10_000;
    // New instance == process restart. Different requested limits must not take effect.
    const second = await open('task_a', { limits: { modelCalls: 999, wallClockMs: 999_999_999 }, now });
    await second.beginAttempt('att_2');
    const summary = second.summary();

    expect(summary.totals.model_call).toBe(4); // 3 committed + 1 orphan charged, never refunded
    expect(summary.unresolvedCharged).toBe(1);
    expect(summary.recoveryByFailureClass).toEqual({ conflict: 1 });
    expect(second.state.startedAt).toBe(startedAt);
    expect(second.state.deadlineAt).toBe(deadlineAt);
    expect(second.state.limits.modelCalls).toBe(5);
    expect(second.state.attempts).toEqual({ sequence: 2, ids: ['att_1', 'att_2'] });

    // And the projection in control.json matches what the ledger says.
    const persisted = JSON.parse(await fs.readFile(path.join(taskDir(root, 'task_a'), 'control.json'), 'utf8'));
    expect(persisted.consumption.totals.model_call).toBe(4);
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.enforcement).toBe('observe');
  });

  it('tolerates a torn final ledger line without losing earlier consumption', async () => {
    const first = await open();
    await first.record({ idempotencyKey: 'a', stage: 's', resource: 'tool_call' });
    await fs.appendFile(path.join(taskDir(root, 'task_a'), 'budget-ledger.jsonl'), '{"schemaVersion":1,"seq":99,"phase":"com', 'utf8');
    const reloaded = await open();
    expect(reloaded.summary().totals.tool_call).toBe(1);
    expect(reloaded.summary().corruptLedgerLines).toBe(1);
  });

  it('is idempotent: repeated reserve/commit and a double-observed request count once', async () => {
    const ledger = await open();
    const req: ReserveRequest = { idempotencyKey: 'same', stage: 's', resource: 'model_call' };
    const a = await ledger.reserve(req);
    const b = await ledger.reserve(req);
    expect(b.duplicate).toBe(true);
    await ledger.commit(a.reservationId);
    await ledger.commit(a.reservationId, { amount: 50 }); // ignored
    expect(ledger.summary().totals.model_call).toBe(1);
    expect(ledger.summary().ledgerEntries).toBe(2);

    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const inner = fakeDispatcher();
    const doublyWrapped = session.observeDispatcher(session.observeDispatcher(inner, 'primary'), 'primary');
    await doublyWrapped.dispatch(request('r1'));
    expect(inner.calls).toHaveLength(1);
    expect((await session.finish()).totals.model_call).toBe(2);
  });

  it('keeps separate tasks in separate ledgers', async () => {
    const a = await open('task_a');
    const b = await open('task_b');
    await a.record({ idempotencyKey: 'k', stage: 's', resource: 'model_call' });
    await a.record({ idempotencyKey: 'k2', stage: 's', resource: 'model_call' });
    await b.record({ idempotencyKey: 'k', stage: 's', resource: 'model_call' });
    expect(a.summary().totals.model_call).toBe(2);
    expect(b.summary().totals.model_call).toBe(1);
    expect((await TaskBudgetLedger.readSummary(root, 'task_b'))?.totals.model_call).toBe(1);
    expect(await TaskBudgetLedger.readSummary(root, 'task_never')).toBeUndefined();
  });

  it('does not lose counts under concurrent dispatch', async () => {
    const ledger = await open();
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const dispatcher = session.observeDispatcher(fakeDispatcher(), 'primary');
    await Promise.all(Array.from({ length: 25 }, (_, i) => dispatcher.dispatch(request(`r${i}`))));
    expect((await session.finish()).totals.model_call).toBe(25);
  });

  it('observe-only exhaustion reports WOULD_BLOCK but every call still executes', async () => {
    const seen: string[] = [];
    const ledger = await open('task_a', { limits: { modelCalls: 2 }, onWouldBlock: o => seen.push(`${o.resource}:${o.projected}/${o.limitValue}`) });
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const inner = fakeDispatcher();
    const dispatcher = session.observeDispatcher(inner, 'primary');
    for (let i = 0; i < 4; i++) {
      const result = await dispatcher.dispatch(request(`r${i}`));
      expect(result.status).toBe('completed');
    }
    const summary = await session.finish();

    expect(inner.calls).toHaveLength(4); // nothing was blocked
    expect(summary.totals.model_call).toBe(4); // and consumption is still recorded
    expect(summary.wouldBlockCount).toBe(2);
    expect(summary.wouldBlock.map(o => o.projected)).toEqual([3, 4]);
    expect(seen).toEqual(['model_call:3/2']); // listener fires once per limit, not per call
  });

  it('reports would-block for the wall-clock deadline and per-failure-class recovery caps', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const ledger = await open('task_a', { limits: { wallClockMs: 1000, recoveryAttemptsPerFailureClass: 1 }, now: () => new Date(clock) });
    await ledger.beginAttempt('att_1');
    const recovery = (key: string, failureClass: string) => ledger.record({ idempotencyKey: key, stage: 's', resource: 'recovery_attempt', failureClass });
    expect((await recovery('a', 'conflict')).admission).toBe('ADMIT');
    expect((await recovery('b', 'other')).admission).toBe('ADMIT'); // separate class, separate cap
    expect((await recovery('c', 'conflict')).admission).toBe('WOULD_BLOCK');
    // Idle task age (e.g. hours waiting for a human) must NOT consume the time budget.
    clock += 5000;
    const idle = await ledger.record({ idempotencyKey: 'd', stage: 's', resource: 'tool_call' });
    expect(idle.admission).toBe('ADMIT');
    expect(ledger.summary().taskAgeMs).toBe(5000);
    // Committed ACTIVE execution beyond the budget is what would block.
    await ledger.record({ idempotencyKey: 'active', stage: 'attempt', resource: 'active_execution_ms', amount: 1500 });
    const late = await ledger.record({ idempotencyKey: 'e', stage: 's', resource: 'tool_call' });
    expect(late.admission).toBe('WOULD_BLOCK');
    expect(late.wouldBlock?.limit).toBe('active_execution_budget');
    expect(ledger.summary().recoveryByFailureClass).toEqual({ conflict: 2, other: 1 });
  });

  it('separates task age, active execution and human approval wait', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const now = () => new Date(clock);
    const ledger = await open('task_time', { now });
    await ledger.beginAttempt('att_1');
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' }, () => clock);
    clock += 2_000; // active work
    await session.withApprovalWait(async () => {
      clock += 60_000; // human thinking
      await session.withApprovalWait(async () => { clock += 1_000; }); // nested wait is not double counted
    });
    clock += 3_000; // active work
    const summary = await session.finish();
    expect(summary.totals.wall_clock_ms).toBe(66_000);
    expect(summary.totals.waiting_for_approval_ms).toBe(61_000);
    expect(summary.totals.active_execution_ms).toBe(5_000);
    clock += 3_600_000; // an hour idle between attempts
    expect(ledger.summary().taskAgeMs).toBe(66_000 + 3_600_000);
    expect(ledger.summary().totals.active_execution_ms).toBe(5_000);
  });

  it('counts a wait still open at finish (cancelled while awaiting the user) as waiting, not active', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const ledger = await open('task_open_wait', { now: () => new Date(clock) });
    await ledger.beginAttempt('att_1');
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' }, () => clock);
    clock += 1_000;
    void session.withApprovalWait(() => new Promise<void>(() => undefined));
    clock += 9_000;
    const summary = await session.finish();
    expect(summary.totals.active_execution_ms).toBe(1_000);
    expect(summary.totals.waiting_for_approval_ms).toBe(9_000);
  });

  it('a failing ledger can never affect the dispatch path', async () => {
    const broken = {
      reserve: async () => { throw new Error('disk full'); },
      commit: async () => { throw new Error('disk full'); },
      record: async () => { throw new Error('disk full'); },
      summary: () => ({}),
    } as unknown as TaskBudgetLedger;
    const logs: string[] = [];
    const session = new TaskAccountingSession(broken, { attemptId: 'att_1', log: m => logs.push(m) });
    const inner = fakeDispatcher();
    const result = await session.observeDispatcher(inner, 'primary').dispatch(request('r1'));
    session.recordToolCall('read_file', 'k');
    await session.finish();
    expect(result.completion).toBe('ok');
    expect(inner.calls).toEqual(['r1']);
    expect(logs.some(l => l.startsWith('budget_ledger_write_failed'))).toBe(true);
  });

  it('counts a model escalation once per session for cloud-route dispatches', async () => {
    const ledger = await open();
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_1' });
    const cloud = session.observeDispatcher(fakeDispatcher(), 'cloud');
    await cloud.dispatch(request('r1::cloud-fallback'));
    await cloud.dispatch(request('r2::loop-cloud'));
    const summary = await session.finish();
    expect(summary.totals.model_call).toBe(2);
    expect(summary.totals.model_escalation).toBe(1);
  });

  it('a re-run after restart makes new calls and is charged in full (no cross-incarnation dedupe)', async () => {
    const one = await open();
    const s1 = new TaskAccountingSession(one, { attemptId: 'att_1' });
    await s1.observeDispatcher(fakeDispatcher(), 'primary').dispatch(request('same-request-id'));
    await s1.finish();
    const two = await open();
    const s2 = new TaskAccountingSession(two, { attemptId: 'att_1' });
    await s2.observeDispatcher(fakeDispatcher(), 'primary').dispatch(request('same-request-id'));
    expect((await s2.finish()).totals.model_call).toBe(2);
  });
});

// ── Executor-level: the REAL governed path with accounting attached ─────────

const MODEL = 'qwen3-coder:30b';
const GOAL = 'Fix the marker validation bug so the real npm verify script passes.';

function proposalJson(operationType: 'create' | 'replace', content: string): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Repair marker.txt so validation passes',
    operations: [{ type: operationType, path: 'marker.txt', reason: 'budget ledger test', content }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });
}

class RepairAwareProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  chatCalls = 0;
  constructor(private readonly repair: 'fix' | 'repeat') {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    this.chatCalls += 1;
    const prompt = messages[0]?.content ?? '';
    if (prompt.includes('Stage: validator (bounded proposal repair)')) {
      return { message: { role: 'assistant', content: this.repair === 'fix' ? proposalJson('replace', 'FIXED\n') : proposalJson('replace', 'BROKEN\n') }, done: true };
    }
    return { message: { role: 'assistant', content: JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(proposalJson('create', 'BROKEN\n')) }) }, done: true };
  }
}

async function initGit(dir: string): Promise<void> {
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: dir, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
    });
  }
}

async function workspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m42-exec-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
  await fs.writeFile(
    path.join(dir, 'check.js'),
    "const fs=require('fs');const c=fs.readFileSync('marker.txt','utf8');if(!c.includes('FIXED')){console.error('bad '+c);process.exit(1);}",
  );
  await initGit(dir);
  return dir;
}

function baseRequest(dir: string, accounting?: GovernedCodingExecutionRequest['accounting'], progress: string[] = []): GovernedCodingExecutionRequest {
  return {
    runId: 'm42-run-1',
    goal: GOAL,
    workspaceRoot: dir,
    signal: new AbortController().signal,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
    auditSource: 'test',
    extensionBuild: 'test-build',
    model: MODEL,
    executionProfile: classifyExecutionProfile(GOAL),
    maxValidationRepairCycles: 2,
    accounting,
    callbacks: {
      onProgress: phase => { progress.push(phase); },
      checkReadiness: async targetPaths => new ForgeExecutionReadiness(dir, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
      reviewProposal: async () => true,
      approveExecution: async () => true,
      confirmElevated: async () => true,
    },
  };
}

describe('M42 slice 1 — accounting on the real governed executor path', () => {
  let dir: string;
  let storeRoot: string;

  beforeEach(async () => {
    dir = await workspace();
    storeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-m42-store-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    await fs.rm(storeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  async function run(repair: 'fix' | 'repeat', withAccounting: boolean) {
    const provider = new RepairAwareProvider(repair);
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const progress: string[] = [];
    let session: TaskAccountingSession | undefined;
    if (withAccounting) {
      const ledger = await TaskBudgetLedger.open({ repositoryRoot: storeRoot, taskId: 'task_exec', contract: CONTRACT });
      await ledger.beginAttempt('att_exec');
      session = new TaskAccountingSession(ledger, { attemptId: 'att_exec' });
    }
    const result = await new GovernedCodingExecutor().execute(baseRequest(dir, session, progress));
    const summary = session ? await session.finish() : undefined;
    return { result, summary, provider, progress };
  }

  it('accounts investigation, validation commands, validation repair and its model call — each once — by stage', async () => {
    const { result, summary, provider } = await run('fix', true);

    expect(result.status).toBe('completed');
    expect(result.repairAttempts).toBe(1);
    // Every provider chat() is exactly one counted model call.
    expect(summary!.totals.model_call).toBe(provider.chatCalls);
    expect(summary!.byStage['investigation']?.model_call).toBe(1);
    expect(summary!.byStage['validation_repair']?.model_call).toBe(1);
    expect(summary!.totals.validation_repair).toBe(1);
    // Initial validation run + the post-repair re-run.
    expect(summary!.totals.tool_call).toBe(2);
    expect(summary!.totals.no_progress).toBe(0);
    expect(summary!.totals.model_escalation).toBe(0);
    expect(summary!.wouldBlockCount).toBe(0);
  });

  it('records no-progress on a repeated repair', async () => {
    const { result, summary, provider } = await run('repeat', true);
    expect(result.status).toBe('validation_failed');
    expect(result.repairAttempts).toBe(2);
    expect(summary!.totals.validation_repair).toBe(2);
    expect(summary!.totals.no_progress).toBe(1);
    expect(summary!.totals.model_call).toBe(provider.chatCalls);
  });

  it('leaves execution behavior unchanged: identical outcome and provider traffic with and without accounting', async () => {
    const plain = await run('fix', false);
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    dir = await workspace();
    const observed = await run('fix', true);

    expect(observed.result.status).toBe(plain.result.status);
    expect(observed.result.repairAttempts).toBe(plain.result.repairAttempts);
    expect(observed.provider.chatCalls).toBe(plain.provider.chatCalls);
    // Progress strings embed measured wall-clock values (duration_ms=...); everything else must match exactly.
    const stripTiming = (lines: string[]) => lines.map(line => line.replace(/(duration_ms|elapsed_ms)=\d+/g, '$1=N'));
    expect(stripTiming(observed.progress)).toEqual(stripTiming(plain.progress));
  });

  it('observe-only exhaustion does not stop the real run', async () => {
    const provider = new RepairAwareProvider('fix');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const ledger = await TaskBudgetLedger.open({
      repositoryRoot: storeRoot,
      taskId: 'task_tiny',
      contract: CONTRACT,
      limits: { modelCalls: 0, toolCalls: 0, validationRepairs: 0 },
    });
    const session = new TaskAccountingSession(ledger, { attemptId: 'att_exec' });
    const result = await new GovernedCodingExecutor().execute(baseRequest(dir, session));
    const summary = await session.finish();

    expect(result.status).toBe('completed');
    expect(summary.wouldBlockCount).toBeGreaterThan(0);
    expect(summary.wouldBlock.map(o => o.resource)).toEqual(expect.arrayContaining(['model_call', 'tool_call', 'validation_repair']));
  });
});
