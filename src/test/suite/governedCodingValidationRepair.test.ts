import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { GovernedCodingExecutor, GovernedCodingExecutionRequest } from '../../coding/GovernedCodingExecutor';
import { ForgeExecutionReadiness } from '../../coding/ExecutionIntegrity';
import { classifyExecutionProfile } from '../../orchestration/ExecutionProfile';
import { ProviderGateway } from '../../providers/ProviderGateway';
import { AttemptJournal } from '../../autonomous/recovery/AttemptJournal';
import { ExecutionRecoverySession } from '../../autonomous/recovery/ExecutionRecoverySession';
import { InferenceProvider, ModelInfo, ProviderChatOptions, ChatMessage, ChatResponse, ToolDefinition } from '../../providers/ProviderTypes';

/**
 * Exercises the REAL bounded validation-repair loop in GovernedCodingExecutor
 * (src/coding/GovernedCodingExecutor.ts, the exact path Karke Dikha runs
 * through — no second/parallel repair mechanism is introduced by these
 * tests) through a real git workspace and a real `npm run verify` validation
 * command. Only the model layer is a stub (via ProviderGateway.create),
 * matching the existing karkeDikhaCoreDurability.test.ts pattern.
 */

const MODEL = 'qwen3-coder:30b';
const GOAL = 'Fix the marker validation bug so the real npm verify script passes.';

function proposalJson(operationType: 'create' | 'replace', content: string): string {
  return JSON.stringify({
    version: 1,
    taskSummary: 'Repair marker.txt so validation passes',
    operations: [{ type: operationType, path: 'marker.txt', reason: 'validation repair test', content }],
    validationCommands: [{ kind: 'npm-script', script: 'verify' }],
    warnings: [],
    status: 'proposed',
  });
}

const BROKEN_PROPOSAL = proposalJson('create', 'BROKEN\n');
const FIXED_PROPOSAL = proposalJson('replace', 'FIXED\n');
// Used only for the no-progress scenario: 'replace' (not 'create') because by
// the time a repair turn runs, marker.txt already exists from the initial
// mutation — an identical-content 'replace' still leaves validation failing,
// which is exactly what "no progress" means.
const REPEATED_REPAIR_PROPOSAL = proposalJson('replace', 'BROKEN\n');

/** Returns whatever `chat()` should answer for a given prompt, driven purely
 * by whether the prompt is the real bounded repair prompt (identified the
 * same way a human reading the prompt would: the exact marker
 * buildRegenerationPrompt's `Stage: validator (bounded proposal repair)`
 * line — not a fixture-specific string). */
class RepairAwareProvider implements InferenceProvider {
  readonly providerType = 'ollama' as const;
  readonly repairPrompts: string[] = [];
  constructor(
    private readonly repairResponse: 'fix' | 'create-fix' | 'repeat' | 'prose' | 'empty',
    private readonly initialProposal: string = BROKEN_PROPOSAL,
  ) {}
  async healthCheck(): Promise<void> {}
  async listModels(): Promise<ModelInfo[]> { return [{ name: MODEL, contextWindow: 40_960 }]; }
  async chat(messages: ChatMessage[], _tools: ToolDefinition[], _options: ProviderChatOptions): Promise<ChatResponse> {
    const prompt = messages[0]?.content ?? '';
    if (prompt.includes('Stage: validator (bounded proposal repair)')) {
      this.repairPrompts.push(prompt);
      if (this.repairResponse === 'empty') {
        // Exercises the ProviderGatewayGovernedModelExecutionDependency
        // dispatch-level rejection (empty content), distinct from the
        // 'prose' case below (a non-empty response that instead fails
        // proposal-schema parsing further downstream).
        return { message: { role: 'assistant', content: '' }, done: true };
      }
      const content = this.repairResponse === 'fix'
        ? FIXED_PROPOSAL
        : this.repairResponse === 'create-fix'
          ? proposalJson('create', 'FIXED\n')
        : this.repairResponse === 'repeat'
          ? REPEATED_REPAIR_PROPOSAL
          : 'I fixed the validation issue by rewriting the marker file to satisfy the check.';
      return { message: { role: 'assistant', content }, done: true };
    }
    // The INITIAL proposal now goes through the bounded pre-proposal
    // investigation loop (CodingPlanner.planWithInvestigation), which
    // requests an action envelope rather than a bare CodingProposal. The
    // bounded validation-repair cycle this test exercises is a separate,
    // unchanged code path (FixedMultiAgentGraph.regenerateValidatorProposal,
    // matched above by its own prompt marker) that still expects a bare
    // CodingProposal — only this initial-turn branch needs the envelope.
    return { message: { role: 'assistant', content: JSON.stringify({ action: 'submit_proposal', proposal: JSON.parse(this.initialProposal) }) }, done: true };
  }
}

async function initGit(root: string): Promise<void> {
  for (const args of [['init'], ['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['add', '.'], ['commit', '-m', 'init']]) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', args, { cwd: root, shell: false, windowsHide: true });
      child.on('error', reject);
      child.on('close', code => (code === 0 ? resolve() : reject(new Error(`git ${args.join(' ')}`))));
    });
  }
}

async function workspaceWithVerifyScript(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-repair-'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
  await fs.writeFile(
    path.join(root, 'check.js'),
    "const fs=require('fs');const c=fs.readFileSync('marker.txt','utf8');"
    + "if(!c.includes('FIXED')){console.error('marker not fixed: '+c);process.exit(1);}console.log('ok');",
  );
  await initGit(root);
  return root;
}

function baseRequest(root: string, callbacks: Partial<GovernedCodingExecutionRequest['callbacks']> = {}): GovernedCodingExecutionRequest {
  return {
    runId: 'repair-test-1',
    goal: GOAL,
    workspaceRoot: root,
    signal: new AbortController().signal,
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => ({ dispose: () => undefined }) } as never,
    auditSource: 'test',
    extensionBuild: 'test-build',
    model: MODEL,
    executionProfile: classifyExecutionProfile(GOAL),
    maxValidationRepairCycles: 2,
    callbacks: {
      checkReadiness: async targetPaths => new ForgeExecutionReadiness(root, { trusted: true, extensionBuild: 'test-build' }).check(targetPaths ?? []),
      reviewProposal: async () => true,
      approveExecution: async () => true,
      confirmElevated: async () => true,
      ...callbacks,
    },
  };
}

describe('GovernedCodingExecutor validation-repair loop', () => {
  let root: string;

  beforeEach(async () => {
    root = await workspaceWithVerifyScript();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('enters exactly one repair cycle on validation failure, and a successful repair proceeds to completion', async () => {
    const provider = new RepairAwareProvider('fix');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const progressEvents: string[] = [];
    const evidenceEvents: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      onProgress: phase => progressEvents.push(phase),
      onEvidence: async evidence => { evidenceEvents.push(evidence); },
    }));

    expect(result.status).toBe('completed');
    expect(result.repairAttempts).toBe(1);
    expect(progressEvents).toContain('validation_repair_started cycle=1/2');
    expect(progressEvents.some(event => event.startsWith('validation_repair_completed cycle=1/2'))).toBe(true);
    expect(evidenceEvents.some(event => event.eventType === 'validation_repair_started')).toBe(true);
    expect(evidenceEvents.some(event => event.eventType === 'validation_repair_completed' && event.metadata.passed === true)).toBe(true);

    // The repair turn genuinely received the real validation exit code and
    // stderr from the FIRST (failing) run, and the immediately-preceding
    // (changed) proposal — not a fixture-specific hint.
    expect(provider.repairPrompts).toHaveLength(1);
    expect(provider.repairPrompts[0]).toContain('exitCode=1');
    expect(provider.repairPrompts[0]).toContain('marker not fixed: BROKEN');
    expect(provider.repairPrompts[0]).toContain('marker.txt');

    const written = await fs.readFile(path.join(root, 'marker.txt'), 'utf8');
    expect(written).toBe('FIXED\n');
  });

  it('D6: rebinds a repeated create as replace only when this task created the approved path earlier in the same mutation', async () => {
    const provider = new RepairAwareProvider('create-fix');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

    const result = await new GovernedCodingExecutor().execute(baseRequest(root));

    expect(result.status).toBe('completed');
    expect(result.repairAttempts).toBe(1);
    expect(result.executableProposal?.operations).toEqual([
      expect.objectContaining({ type: 'replace', path: 'marker.txt', snapshot: expect.objectContaining({ state: 'exists' }) }),
    ]);
    expect(result.mutation?.filesCreated).toContain('marker.txt');
    expect(result.mutation?.filesModified).toContain('marker.txt');
    expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('FIXED\n');
  });

  it('D6 negative: a repeated create for a path that existed before the task is still rejected as create_target_exists', async () => {
    const preexisting = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-validation-repair-pre-'));
    try {
      await fs.writeFile(path.join(preexisting, 'package.json'), JSON.stringify({ scripts: { verify: 'node check.js' } }, null, 2));
      await fs.writeFile(
        path.join(preexisting, 'check.js'),
        "const fs=require('fs');const c=fs.readFileSync('marker.txt','utf8');"
        + "if(!c.includes('FIXED')){console.error('marker not fixed: '+c);process.exit(1);}console.log('ok');",
      );
      await fs.writeFile(path.join(preexisting, 'marker.txt'), 'ORIGINAL\n');
      await initGit(preexisting);
      const provider = new RepairAwareProvider('create-fix', proposalJson('replace', 'BROKEN\n'));
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);

      const outcome = await new GovernedCodingExecutor().execute(baseRequest(preexisting)).then(
        result => ({ result, error: undefined as unknown }),
        error => ({ result: undefined, error }),
      );

      expect(provider.repairPrompts).toHaveLength(1);
      expect(outcome.result?.status).not.toBe('completed');
      const failure = [
        outcome.result?.failureReason,
        outcome.result?.proposalConflictEvidence && JSON.stringify(outcome.result.proposalConflictEvidence),
        outcome.error instanceof Error ? outcome.error.message : outcome.error,
      ].filter(Boolean).join(' ');
      expect(failure).toContain('create_target_exists');
      expect(await fs.readFile(path.join(preexisting, 'marker.txt'), 'utf8')).toBe('BROKEN\n');
    } finally {
      await fs.rm(preexisting, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  it('a repair that returns only prose (no valid CodingProposal) is never parsed into a mutation, and fails closed with durable evidence', async () => {
    const provider = new RepairAwareProvider('prose');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const progressEvents: string[] = [];
    const evidenceEvents: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      onProgress: phase => progressEvents.push(phase),
      onEvidence: async evidence => { evidenceEvents.push(evidence); },
    }));

    expect(result.status).toBe('validation_failed');
    expect(result.repairAttempts).toBe(1);
    expect(progressEvents).toContain('validation_repair_unavailable cycle=1/2');
    const unavailable = evidenceEvents.find(event => event.eventType === 'validation_repair_unavailable');
    expect(unavailable).toBeDefined();
    expect(unavailable?.metadata.cycle).toBe(1);

    // No mutation beyond the original broken write — prose was never
    // parsed into file operations.
    const written = await fs.readFile(path.join(root, 'marker.txt'), 'utf8');
    expect(written).toBe('BROKEN\n');
  });

  it('a repair-turn dispatch failure (empty content) records the sanitized sub-reason in the durable validation_repair_unavailable evidence', async () => {
    const provider = new RepairAwareProvider('empty');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const evidenceEvents: Array<{ eventType: string; metadata: Record<string, unknown> }> = [];

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      onEvidence: async evidence => { evidenceEvents.push(evidence); },
    }));

    expect(result.status).toBe('validation_failed');
    const unavailable = evidenceEvents.find(event => event.eventType === 'validation_repair_unavailable');
    expect(unavailable).toBeDefined();
    // This is specifically a dispatch-level failure (regenerationStatus
    // 'unavailable', not a schema-parse 'invalid'), and the sanitized
    // sub-reason distinguishes exactly which of the three branches fired.
    expect(unavailable?.metadata.regenerationStatus).toBe('unavailable');
    expect(unavailable?.metadata.invalidResponseReason).toBe('empty_content');
    // Never the raw (empty, in this case) content or prompt — only the enum tag.
    expect(JSON.stringify(unavailable?.metadata)).not.toContain('Stage: validator (bounded proposal repair)');
  });

  it('a repair that makes no progress (identical proposal) stops without looping further, and never fabricates success', async () => {
    const provider = new RepairAwareProvider('repeat');
    vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
    const progressEvents: string[] = [];

    const executor = new GovernedCodingExecutor();
    const result = await executor.execute(baseRequest(root, {
      onProgress: phase => progressEvents.push(phase),
    }));

    expect(result.status).toBe('validation_failed');
    // Cycle 1 genuinely repairs+revalidates (still failing, identical
    // content); cycle 2 detects the repeat and stops — never a third cycle,
    // never an infinite/unbounded loop.
    expect(result.repairAttempts).toBe(2);
    expect(progressEvents).toContain('validation_repair_no_progress cycle=2/2');
    expect(provider.repairPrompts).toHaveLength(2);
  });

  describe('repair-cycle accounting across controller re-entry', () => {
    async function sessionWithConsumedCycles(consumed: number): Promise<{ recovery: ExecutionRecoverySession; journalRoot: string }> {
      const journalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'oa-repair-journal-'));
      const journal = await AttemptJournal.open({ repositoryRoot: journalRoot, taskId: 'task-reentry' });
      for (let cycle = 1; cycle <= consumed; cycle += 1) {
        await journal.append({ t: 'repair_cycle', attemptId: 'att_reentry', pass: cycle, cycle });
      }
      const recovery = new ExecutionRecoverySession({ journal, workspaceRoot: root, attemptId: 'att_reentry', pass: consumed + 1, resolveBaseRevision: async () => undefined });
      return { recovery, journalRoot };
    }

    it('a re-entered pass continues the cycle count (cycle 2, not cycle 1 again) and only the remaining budget is usable', async () => {
      const provider = new RepairAwareProvider('prose');
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
      const { recovery, journalRoot } = await sessionWithConsumedCycles(1);
      try {
        const progressEvents: string[] = [];
        const cycles: number[] = [];
        const result = await new GovernedCodingExecutor().execute({
          ...baseRequest(root, {
            onProgress: phase => progressEvents.push(phase),
            onEvidence: async evidence => { if (evidence.eventType === 'validation_repair_started') cycles.push(Number(evidence.metadata['cycle'])); },
          }),
          recovery,
        });

        expect(result.status).toBe('validation_failed');
        expect(result.repairStopReason).toBe('unavailable');
        expect(cycles).toEqual([2]);
        expect(progressEvents).toContain('validation_repair_started cycle=2/2');
        expect(progressEvents).not.toContain('validation_repair_started cycle=1/2');
        expect(provider.repairPrompts).toHaveLength(1);
        expect(result.repairAttempts).toBe(1);
        expect(recovery.priorRepairCycles).toBe(2);
      } finally {
        await fs.rm(journalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('once the attempt-wide budget is consumed a re-entered pass cannot repair at all: no repair turn, no new cycle, truthful exhausted stop', async () => {
      const provider = new RepairAwareProvider('fix');
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
      const { recovery, journalRoot } = await sessionWithConsumedCycles(2);
      try {
        const progressEvents: string[] = [];
        const cycles: number[] = [];
        const result = await new GovernedCodingExecutor().execute({
          ...baseRequest(root, {
            onProgress: phase => progressEvents.push(phase),
            onEvidence: async evidence => { if (evidence.eventType === 'validation_repair_started') cycles.push(Number(evidence.metadata['cycle'])); },
          }),
          recovery,
        });

        expect(result.status).toBe('validation_failed');
        expect(result.repairStopReason).toBe('exhausted');
        expect(result.repairAttempts).toBe(0);
        expect(cycles).toEqual([]);
        expect(provider.repairPrompts).toHaveLength(0);
        expect(recovery.priorRepairCycles).toBe(2);
      } finally {
        await fs.rm(journalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

    it('a rejected repair-cycle record (e.g. Core refusing an out-of-sequence cycle) is a validation-recovery stop, never a mutation failure', async () => {
      const provider = new RepairAwareProvider('fix');
      vi.spyOn(ProviderGateway, 'create').mockResolvedValue(provider);
      const result = await new GovernedCodingExecutor().execute(baseRequest(root, {
        onEvidence: async evidence => {
          if (evidence.eventType === 'validation_repair_started') throw new Error('validation repair cycle must be 2 and may not exceed 2');
        },
      }));

      expect(result.status).toBe('validation_failed');
      expect(result.status).not.toBe('mutation_failed');
      expect(result.repairStopReason).toBe('cycle_rejected');
      expect(provider.repairPrompts).toHaveLength(0);
      // The successful original mutation is still what is on disk.
      expect(await fs.readFile(path.join(root, 'marker.txt'), 'utf8')).toBe('BROKEN\n');
    });
  });

  it('does not touch Baat Kar / Saath Kar execution at all: Core\'s attempt executor still owns only those two kinds', async () => {
    const source = await fs.readFile(path.resolve(__dirname, '../../../core/runtime/executor.ts'), 'utf8');
    expect(source).toContain("attempt.kind !== 'baat_kar' && attempt.kind !== 'saath_kar'");
    expect(source).not.toContain('GovernedCodingExecutor');
    expect(source).not.toContain('FixedMultiAgentGraph');
  });
});
